import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const MODULE_NAME = "medical_fee_calculation.api";
const MASTER_SEARCH_MODULE_NAME = "medical_fee_calculation.master_search";
const MASTER_BROWSER_MODULE_NAME = "medical_fee_calculation.master_browser";
const MASTER_CONTENT_MODULE_NAME = "medical_fee_calculation.master_content";
const WORKER_MODULE_NAME = "medical_fee_calculation.worker";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_MASTER_SEARCH_CACHE_MAX_ENTRIES = 2000;
const DEFAULT_MASTER_SEARCH_CACHE_TTL_MS = 600_000;
const DEFAULT_MASTER_METADATA_CACHE_TTL_MS = 60_000;
// ワーカータイムアウト時、巻き込まれた待機リクエストを新ワーカーへ再送する最大試行回数。
// これを超えたら該当リクエストも失敗させ、無限再送を防ぐ。
const WORKER_MAX_DISPATCH_ATTEMPTS = 2;

export function createFeeCalculatorFromEnv(env = process.env) {
  const gzipPath = env.FEE_MASTER_DB_GZIP_PATH || env.MEDICAL_FEE_MASTER_DB_GZIP_PATH || "";
  const manifestPath = env.FEE_MASTER_DB_MANIFEST_PATH
    || (gzipPath ? path.join(path.dirname(gzipPath), "standard-master.manifest.json") : "");
  const masterDbPath = env.FEE_MASTER_DB_PATH
    || env.MEDICAL_FEE_MASTER_DB_PATH
    || (gzipPath ? path.join("/tmp", "halunasu-fee-master", path.basename(gzipPath).replace(/\.gz$/u, "")) : "");

  const calculator = new PythonFeeCalculator({
    pythonBin: env.FEE_PYTHON_BIN || env.PYTHON_BIN || "python3",
    pythonPath: env.FEE_PYTHONPATH || env.PYTHONPATH || path.join(ROOT_DIR, "python"),
    masterDbPath,
    masterDbGzipPath: gzipPath,
    masterDbManifestPath: manifestPath,
    masterContentCheckMode: env.FEE_MASTER_CONTENT_CHECK || "strict",
    timeoutMs: Number(env.FEE_CALCULATOR_TIMEOUT_MS || 30000),
    workerMode: env.FEE_PYTHON_WORKER_MODE === "spawn" || env.FEE_PYTHON_WORKER === "0" ? false : true,
    masterSearchCacheMaxEntries: positiveInteger(env.FEE_MASTER_SEARCH_CACHE_MAX_ENTRIES, DEFAULT_MASTER_SEARCH_CACHE_MAX_ENTRIES),
    masterSearchCacheTtlMs: positiveInteger(env.FEE_MASTER_SEARCH_CACHE_TTL_MS, DEFAULT_MASTER_SEARCH_CACHE_TTL_MS)
  });
  if (env.FEE_MASTER_DB_PREPARE_ON_START === "true") {
    calculator.ensureMasterDbReady().catch(() => {});
  }
  return calculator;
}

export class PythonFeeCalculator {
  constructor(options = {}) {
    this.pythonBin = options.pythonBin || "python3";
    this.pythonPath = options.pythonPath || path.join(ROOT_DIR, "python");
    this.masterDbPath = options.masterDbPath;
    this.masterDbGzipPath = options.masterDbGzipPath || "";
    this.masterDbManifestPath = options.masterDbManifestPath || "";
    this.masterContentCheckMode = String(options.masterContentCheckMode || "strict").trim().toLowerCase() === "warn"
      ? "warn"
      : "strict";
    this.logger = options.logger || console;
    this.timeoutMs = options.timeoutMs || 30000;
    this.workerMode = options.workerMode !== false;
    this.masterDbPreparePromise = null;
    this.masterContentCheckPromise = null;
    this.masterContentCheck = null;
    this.worker = null;
    this.workerStdoutBuffer = "";
    this.workerStderrBuffer = "";
    this.workerRequestCounter = 0;
    this.workerPending = new Map();
    this.masterSearchCache = new Map();
    this.masterSearchCacheMaxEntries = options.masterSearchCacheMaxEntries ?? DEFAULT_MASTER_SEARCH_CACHE_MAX_ENTRIES;
    this.masterSearchCacheTtlMs = options.masterSearchCacheTtlMs ?? DEFAULT_MASTER_SEARCH_CACHE_TTL_MS;
    this.masterMetadataCache = {
      expiresAt: 0,
      result: null
    };
    this.fileChecksumCache = new Map();
  }

  async calculate(session, input = {}) {
    await this.ensureMasterDbReady();
    const payload = {
      db_path: this.masterDbPath,
      session,
      input
    };

    if (this.workerMode) {
      const output = await this.runWorkerJson(payload);
      return output.calculationResult || output.calculation_result || output;
    }

    const output = await runPythonJson({
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs: this.timeoutMs,
      payload
    });

    return output.calculationResult || output.calculation_result || output;
  }

  async searchMaster(input = {}) {
    await this.ensureMasterDbReady();
    const payload = {
      db_path: this.masterDbPath,
      type: input.type,
      query: input.query || input.q,
      limit: input.limit
    };
    const cacheKey = this.masterSearchCacheKey(payload);
    const cached = this.getCachedMasterSearch(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.executeMasterSearch(payload)
      .then((result) => {
        this.setCachedMasterSearch(cacheKey, result);
        return result;
      })
      .catch((error) => {
        this.masterSearchCache.delete(cacheKey);
        throw error;
      });
    this.setPendingMasterSearch(cacheKey, promise);
    return promise;
  }

  async searchMasterMany(inputs = []) {
    const entries = Array.isArray(inputs) ? inputs : [];
    return Promise.all(entries.map((input) => this.searchMaster(input).catch((error) => ({ error }))));
  }

  async browseMaster(input = {}) {
    await this.ensureMasterDbReady();
    return runPythonJson({
      moduleName: MASTER_BROWSER_MODULE_NAME,
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs: Math.min(this.timeoutMs, 10000),
      payload: {
        db_path: this.masterDbPath,
        type: input.type,
        query: input.query || input.q,
        page: input.page,
        pageSize: input.pageSize
      }
    });
  }

  // レセ点検(適応/禁忌/併用/病名整備)のためのマスタ参照。コード群→該当行を返す薄いクエリ。
  async checkLookup(payload = {}) {
    await this.ensureMasterDbReady();
    const request = { ...payload, db_path: this.masterDbPath };
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson({ ...request, op: "check_lookup" }, {
        requestIdPrefix: "fee_check_lookup",
        timeoutMs
      });
    }
    return runPythonJson({
      moduleName: "medical_fee_calculation.checks_api",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload: request
    });
  }

  // マスタ名称辞書でカルテ本文を決定論スキャンする(抽出漏れのセーフティネット)。
  // 確定算定には使わず、候補提示の材料として否定文脈・既出コードの除外はNode側で行う。
  async scanMasterNames(payload = {}) {
    await this.ensureMasterDbReady();
    const request = { ...payload, db_path: this.masterDbPath };
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson({ ...request, op: "name_scan" }, {
        requestIdPrefix: "fee_name_scan",
        timeoutMs
      });
    }
    return runPythonJson({
      moduleName: "medical_fee_calculation.name_scan",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload: request
    });
  }

  // カルテ由来の病名名称を標準傷病名コードへ寄せる(適応/禁忌点検の実効化)。
  async resolveDiseases(payload = {}) {
    await this.ensureMasterDbReady();
    const request = { ...payload, db_path: this.masterDbPath };
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson({ ...request, op: "resolve_diseases" }, {
        requestIdPrefix: "fee_resolve_diseases",
        timeoutMs
      });
    }
    return runPythonJson({
      moduleName: "medical_fee_calculation.checks_api",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload: { ...request, op: "resolve_diseases" }
    });
  }

  // 病名→適応診療行為を支払基金チェックマスタから逆引きする。
  // 自動算定ではなく、管理・指導の実施確認が必要な候補レーン専用。
  async diseaseActCandidates(payload = {}) {
    await this.ensureMasterDbReady();
    const request = { ...payload, db_path: this.masterDbPath };
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson({ ...request, op: "disease_act_candidates" }, {
        requestIdPrefix: "fee_disease_act_candidates",
        timeoutMs
      });
    }
    return runPythonJson({
      moduleName: "medical_fee_calculation.checks_api",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload: { ...request, op: "disease_act_candidates" }
    });
  }

  // 電子点数表の月次・複数月上限と点数表階層から、恒常算定ファミリを機械生成する。
  // この結果は承認待ち候補専用で、自動確定には使用しない。
  async standingFeeFamilies(payload = {}) {
    await this.ensureMasterDbReady();
    const request = { ...payload, db_path: this.masterDbPath };
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson({ ...request, op: "standing_fee_families" }, {
        requestIdPrefix: "fee_standing_fee_families",
        timeoutMs
      });
    }
    return runPythonJson({
      moduleName: "medical_fee_calculation.checks_api",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload: { ...request, op: "standing_fee_families" }
    });
  }

  // 既存レセ(UKE/レセコンCSV)を baselineClaims に変換する(Python adapter経由)。マスタDB不要。
  async parseBaseline(payload = {}) {
    return runPythonJson({
      moduleName: "medical_fee_calculation.baseline_api",
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs: Math.min(this.timeoutMs, 15000),
      payload
    });
  }

  readiness() {
    const masterDbPathExists = this.masterDbPath ? existsSync(this.masterDbPath) : false;
    const masterDbGzipPathExists = this.masterDbGzipPath ? existsSync(this.masterDbGzipPath) : false;

    return {
      provider: "python.medical_fee_calculation",
      masterDbConfigured: Boolean(this.masterDbPath || this.masterDbGzipPath),
      masterDbPath: this.masterDbPath || null,
      masterDbPathExists,
      masterDbBytes: masterDbPathExists ? statSync(this.masterDbPath).size : null,
      masterDbGzipPath: this.masterDbGzipPath || null,
      masterDbGzipPathExists,
      masterDbGzipBytes: masterDbGzipPathExists ? statSync(this.masterDbGzipPath).size : null,
      masterDbManifestPath: this.masterDbManifestPath || null,
      masterDbManifestPathExists: this.masterDbManifestPath ? existsSync(this.masterDbManifestPath) : false,
      masterContentCheckMode: this.masterContentCheckMode,
      timeoutMs: this.timeoutMs,
      workerMode: this.workerMode ? "persistent" : "spawn",
      workerRunning: Boolean(this.worker),
      masterSearchCacheEntries: this.masterSearchCache.size,
      masterSearchCacheMaxEntries: this.masterSearchCacheMaxEntries,
      masterSearchCacheTtlMs: this.masterSearchCacheTtlMs
    };
  }

  async readinessDetailed() {
    if (this.masterDbPath || this.masterDbGzipPath) {
      await this.ensureMasterDbReady();
    }
    const base = this.readiness();
    const detailed = {
      ...base,
      masterContent: this.masterContentCheck || null
    };
    if (base.masterDbPathExists) {
      detailed.masterDbChecksumSha256 = await this.fileSha256(this.masterDbPath);
    }
    if (base.masterDbGzipPathExists) {
      detailed.masterDbGzipChecksumSha256 = await this.fileSha256(this.masterDbGzipPath);
    }
    if (base.masterDbConfigured) {
      const metadata = await this.masterMetadata().catch((error) => ({
        error: error.name || "MasterMetadataError",
        message: error.message || String(error)
      }));
      if (metadata.error) {
        detailed.masterMetadataError = metadata;
      } else {
        detailed.masterSources = metadata.sources || [];
        detailed.medicalElectronicFeeTableVersion = metadata.medicalElectronicFeeTableVersion || null;
        detailed.dpcStatus = metadata.dpcStatus || null;
      }
    }
    return detailed;
  }

  async masterMetadata() {
    const now = Date.now();
    if (this.masterMetadataCache.result && this.masterMetadataCache.expiresAt > now) {
      return this.masterMetadataCache.result;
    }
    const result = await this.browseMaster({ type: "sources" });
    this.masterMetadataCache = {
      result,
      expiresAt: now + DEFAULT_MASTER_METADATA_CACHE_TTL_MS
    };
    return result;
  }

  async fileSha256(filePath) {
    const stat = statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.fileChecksumCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const digest = await hashFileSha256(filePath);
    this.fileChecksumCache.clear();
    this.fileChecksumCache.set(cacheKey, digest);
    return digest;
  }

  async ensureMasterDbReady() {
    if (!this.masterDbPath) {
      const error = new Error("FEE_MASTER_DB_PATH is required for medical fee calculation");
      error.name = "ConfigurationError";
      error.statusCode = 503;
      throw error;
    }
    if (!existsSync(this.masterDbPath)) {
      if (!this.masterDbGzipPath) {
        throw configurationError(`Fee master DB not found: ${this.masterDbPath}`);
      }
      if (!existsSync(this.masterDbGzipPath)) {
        throw configurationError(`Fee master gzip not found: ${this.masterDbGzipPath}`);
      }

      if (!this.masterDbPreparePromise) {
        this.masterDbPreparePromise = this.expandMasterDbGzip();
      }
      await this.masterDbPreparePromise;
    }
    await this.ensureMasterContentReady();
  }

  async ensureMasterContentReady() {
    if (!this.masterDbManifestPath) {
      return;
    }
    if (!this.masterContentCheckPromise) {
      this.masterContentCheckPromise = this.inspectMasterContent();
    }
    const result = await this.masterContentCheckPromise;
    this.masterContentCheck = result;
    if (!result.ok && this.masterContentCheckMode === "strict") {
      const failures = result.failedTables
        .map((entry) => `${entry.table}(${entry.actual}/${entry.expected})`)
        .join(", ");
      const error = configurationError(`Fee master content validation failed: ${failures}`);
      error.masterContent = result;
      throw error;
    }
  }

  async inspectMasterContent() {
    const checkedAt = new Date().toISOString();
    if (!existsSync(this.masterDbManifestPath)) {
      const result = {
        ok: true,
        failedTables: [],
        checkedAt,
        manifestSha: null,
        manifestMissing: true
      };
      this.logger.warn?.(JSON.stringify({
        event: "fee.master_content_manifest_missing",
        manifestPath: this.masterDbManifestPath
      }));
      return result;
    }

    let manifest;
    try {
      manifest = JSON.parse(await readFile(this.masterDbManifestPath, "utf8"));
    } catch (error) {
      return this.masterContentFailure("__manifest__", 0, 1, checkedAt, null, error.message);
    }
    const expectedTables = manifest?.tables;
    if (!expectedTables || typeof expectedTables !== "object" || Array.isArray(expectedTables)) {
      return this.masterContentFailure("__manifest__", 0, 1, checkedAt, manifest?.sha256 || null, "tables is required");
    }
    const expectedEntries = Object.entries(expectedTables)
      .map(([table, count]) => [String(table || "").trim(), Number(count)])
      .filter(([table, count]) => table && Number.isFinite(count) && count >= 0);
    if (!expectedEntries.length || expectedEntries.length !== Object.keys(expectedTables).length) {
      return this.masterContentFailure("__manifest__", 0, 1, checkedAt, manifest?.sha256 || null, "tables contains invalid counts");
    }

    let actual;
    try {
      actual = await runPythonJson({
        moduleName: MASTER_CONTENT_MODULE_NAME,
        pythonBin: this.pythonBin,
        pythonPath: this.pythonPath,
        timeoutMs: Math.max(this.timeoutMs, 120000),
        payload: {
          db_path: this.masterDbPath,
          tables: expectedEntries.map(([table]) => table)
        }
      });
    } catch (error) {
      return this.masterContentFailure("__database__", 0, 1, checkedAt, manifest?.sha256 || null, error.message);
    }

    const failedTables = expectedEntries.flatMap(([table, expected]) => {
      const actualCount = Number(actual?.tables?.[table] || 0);
      if (actualCount >= expected * 0.5) {
        return [];
      }
      return [{
        table,
        actual: actualCount,
        expected,
        minimum: Math.ceil(expected * 0.5)
      }];
    });
    const result = {
      ok: failedTables.length === 0,
      failedTables,
      checkedAt,
      manifestSha: String(manifest?.sha256 || "").trim() || null
    };
    if (!result.ok) {
      this.logMasterContentFailure(result);
    }
    return result;
  }

  masterContentFailure(table, actual, expected, checkedAt, manifestSha, reason) {
    const result = {
      ok: false,
      failedTables: [{ table, actual, expected, minimum: Math.ceil(expected * 0.5), reason }],
      checkedAt,
      manifestSha: String(manifestSha || "").trim() || null
    };
    this.logMasterContentFailure(result);
    return result;
  }

  logMasterContentFailure(result) {
    this.logger.error?.(JSON.stringify({
      event: "fee.master_content_validation_failed",
      mode: this.masterContentCheckMode,
      failedTables: result.failedTables,
      manifestSha: result.manifestSha
    }));
  }

  async expandMasterDbGzip() {
    mkdirSync(path.dirname(this.masterDbPath), { recursive: true });
    const temporaryPath = `${this.masterDbPath}.tmp`;

    try {
      await pipeline(
        createReadStream(this.masterDbGzipPath),
        createGunzip(),
        createWriteStream(temporaryPath)
      );
      await rename(temporaryPath, this.masterDbPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      this.masterDbPreparePromise = null;
      throw error;
    }
  }

  runWorkerJson(payload, options = {}) {
    const requestId = `${options.requestIdPrefix || "fee_calc"}_${++this.workerRequestCounter}`;
    const timeoutMs = options.timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      this.dispatchWorkerRequest({
        requestId,
        payload,
        timeoutMs,
        resolve,
        reject,
        timer: null,
        attempts: 0
      });
    });
  }

  dispatchWorkerRequest(entry) {
    const child = this.ensureWorker();
    entry.attempts += 1;
    entry.timer = setTimeout(() => this.handleWorkerRequestTimeout(entry.requestId), entry.timeoutMs);
    this.workerPending.set(entry.requestId, entry);
    child.stdin.write(`${JSON.stringify({ id: entry.requestId, payload: entry.payload })}\n`);
  }

  // タイムアウトは「該当リクエストのみ」失敗させ、待機中の他リクエストは新しいワーカーへ再送する。
  // 従来は timeout→worker全kill→close で pending を一括 reject しており、重い1件が全ユーザを巻き込んでいた。
  // 算定は入力に対する純粋関数なので、生存リクエストの再送(冪等)は安全。再送は上限回数で打ち切る。
  handleWorkerRequestTimeout(requestId) {
    const timedOut = this.workerPending.get(requestId);
    if (!timedOut) {
      return;
    }
    const survivors = [];
    for (const [id, entry] of this.workerPending.entries()) {
      clearTimeout(entry.timer);
      if (id === requestId) {
        continue;
      }
      if (entry.attempts >= WORKER_MAX_DISPATCH_ATTEMPTS) {
        entry.reject(feeCalculationTimeoutError());
      } else {
        survivors.push(entry);
      }
    }
    this.workerPending.clear();
    // 詰まった可能性のあるワーカーを停止(pending は空なので close ハンドラの一括 reject は発生しない)。
    this.stopWorker();
    timedOut.reject(feeCalculationTimeoutError());
    for (const entry of survivors) {
      this.dispatchWorkerRequest(entry);
    }
  }

  executeMasterSearch(payload) {
    const timeoutMs = Math.min(this.timeoutMs, 10000);
    if (this.workerMode) {
      return this.runWorkerJson(
        {
          ...payload,
          op: "master_search"
        },
        {
          requestIdPrefix: "fee_master_search",
          timeoutMs
        }
      );
    }
    return runPythonJson({
      moduleName: MASTER_SEARCH_MODULE_NAME,
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs,
      payload
    });
  }

  masterSearchCacheKey(payload) {
    return JSON.stringify({
      dbPath: payload.db_path || "",
      type: String(payload.type || "all").trim().toLowerCase(),
      query: String(payload.query || payload.q || "").trim(),
      limit: payload.limit ?? null
    });
  }

  getCachedMasterSearch(cacheKey) {
    const entry = this.masterSearchCache.get(cacheKey);
    if (!entry) {
      return null;
    }
    if (entry.promise) {
      return entry.promise;
    }
    if (entry.expiresAt <= Date.now()) {
      this.masterSearchCache.delete(cacheKey);
      return null;
    }
    this.masterSearchCache.delete(cacheKey);
    this.masterSearchCache.set(cacheKey, entry);
    return entry.result;
  }

  setPendingMasterSearch(cacheKey, promise) {
    this.masterSearchCache.set(cacheKey, {
      promise,
      expiresAt: Date.now() + this.masterSearchCacheTtlMs
    });
    this.pruneMasterSearchCache();
  }

  setCachedMasterSearch(cacheKey, result) {
    this.masterSearchCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.masterSearchCacheTtlMs
    });
    this.pruneMasterSearchCache();
  }

  pruneMasterSearchCache() {
    const now = Date.now();
    for (const [cacheKey, entry] of this.masterSearchCache.entries()) {
      if (!entry.promise && entry.expiresAt <= now) {
        this.masterSearchCache.delete(cacheKey);
      }
    }
    while (this.masterSearchCache.size > this.masterSearchCacheMaxEntries) {
      const oldestKey = this.masterSearchCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.masterSearchCache.delete(oldestKey);
    }
  }

  ensureWorker() {
    if (this.worker && !this.worker.killed) {
      return this.worker;
    }

    const child = spawn(this.pythonBin, ["-m", WORKER_MODULE_NAME], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PYTHONPATH: this.pythonPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.worker = child;
    this.workerStdoutBuffer = "";
    this.workerStderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.handleWorkerStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.workerStderrBuffer = `${this.workerStderrBuffer}${chunk}`.slice(-8000);
    });
    child.on("error", (error) => {
      // タイムアウト再起動で置き換えられた古いワーカーの遅延イベントは、
      // 新ワーカーの pending を巻き込まないよう無視する。
      if (this.worker !== child) {
        return;
      }
      this.rejectPendingWorkerRequests(error);
    });
    child.on("close", (code) => {
      if (this.worker !== child) {
        return;
      }
      const error = new Error(this.workerStderrBuffer.trim() || `medical fee worker exited with code ${code}`);
      error.name = "FeeCalculationError";
      error.statusCode = 502;
      this.worker = null;
      this.rejectPendingWorkerRequests(error);
    });

    return child;
  }

  handleWorkerStdout(chunk) {
    this.workerStdoutBuffer += chunk;
    let newlineIndex = this.workerStdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.workerStdoutBuffer.slice(0, newlineIndex).trim();
      this.workerStdoutBuffer = this.workerStdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleWorkerLine(line);
      }
      newlineIndex = this.workerStdoutBuffer.indexOf("\n");
    }
  }

  handleWorkerLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      error.message = `medical fee worker returned invalid JSON: ${error.message}`;
      error.statusCode = 502;
      this.rejectPendingWorkerRequests(error);
      return;
    }

    const pending = this.workerPending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.workerPending.delete(response.id);

    if (!response.ok) {
      const error = new Error(response.message || response.error || "medical fee calculation failed");
      error.name = response.error || "FeeCalculationError";
      error.statusCode = 502;
      pending.reject(error);
      return;
    }

    pending.resolve(response.result);
  }

  rejectPendingWorkerRequests(error) {
    for (const [requestId, pending] of this.workerPending.entries()) {
      clearTimeout(pending.timer);
      this.workerPending.delete(requestId);
      pending.reject(error);
    }
  }

  stopWorker() {
    if (this.worker && !this.worker.killed) {
      this.worker.kill("SIGTERM");
    }
    this.worker = null;
  }
}

function feeCalculationTimeoutError() {
  const error = new Error("medical fee calculation timed out");
  error.name = "FeeCalculationTimeoutError";
  error.statusCode = 504;
  return error;
}

function configurationError(message) {
  const error = new Error(message);
  error.name = "ConfigurationError";
  error.statusCode = 503;
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function runPythonJson(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.pythonBin, ["-m", options.moduleName || MODULE_NAME], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PYTHONPATH: options.pythonPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(feeCalculationTimeoutError());
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(stderr.trim() || `medical fee calculation failed with code ${code}`);
        error.name = "FeeCalculationError";
        error.statusCode = 502;
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        error.message = `medical fee calculation returned invalid JSON: ${error.message}`;
        error.statusCode = 502;
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify(options.payload));
  });
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}
