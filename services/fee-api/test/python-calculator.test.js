import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createFeeCalculatorFromEnv, PythonFeeCalculator } from "../src/python-calculator.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SILENT_LOGGER = { warn() {}, error() {} };

test("environment wiring infers the sibling master manifest and strict mode", () => {
  const calculator = createFeeCalculatorFromEnv({
    FEE_MASTER_DB_GZIP_PATH: "/app/python/data/master/standard-master.sqlite.gz",
    FEE_MASTER_DB_PATH: "/tmp/master.sqlite"
  });

  assert.equal(calculator.masterDbManifestPath, "/app/python/data/master/standard-master.manifest.json");
  assert.equal(calculator.masterContentCheckMode, "strict");
});

test("expands gzip-compressed fee master DB into runtime tmp path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-"));
  const gzipPath = path.join(root, "standard-master.sqlite.gz");
  const dbPath = path.join(root, "runtime", "standard-master.sqlite");
  writeFileSync(gzipPath, gzipSync(Buffer.from("sqlite fixture", "utf8")));

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    masterDbGzipPath: gzipPath,
    logger: SILENT_LOGGER
  });

  assert.equal(calculator.readiness().masterDbPathExists, false);
  assert.equal(calculator.readiness().masterDbGzipPathExists, true);

  await calculator.ensureMasterDbReady();

  assert.equal(readFileSync(dbPath, "utf8"), "sqlite fixture");
  assert.equal(calculator.readiness().masterDbPathExists, true);
});

test("routes master search through persistent worker and caches identical queries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-search-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    workerMode: true,
    masterSearchCacheTtlMs: 60_000
  });
  let workerCalls = 0;
  calculator.runWorkerJson = async (payload, options) => {
    workerCalls += 1;
    assert.equal(payload.op, "master_search");
    assert.equal(payload.db_path, dbPath);
    assert.equal(payload.type, "procedure");
    assert.equal(payload.query, "再診料");
    assert.equal(payload.limit, 5);
    assert.equal(options.requestIdPrefix, "fee_master_search");
    return {
      query: payload.query,
      type: payload.type,
      items: [{ kind: "procedure", code: "112007410", name: "再診料" }]
    };
  };

  const first = await calculator.searchMaster({ type: "procedure", query: "再診料", limit: 5 });
  const second = await calculator.searchMaster({ type: "procedure", query: "再診料", limit: 5 });

  assert.equal(workerCalls, 1);
  assert.deepEqual(second, first);
  assert.equal(calculator.readiness().masterSearchCacheEntries, 1);
});

test("checkLookup routes through the worker with op check_lookup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-check-lookup-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({ masterDbPath: dbPath, workerMode: true });
  let seen = null;
  calculator.runWorkerJson = async (payload, options) => {
    seen = { payload, options };
    return { drugIndications: { "600": [] }, diseaseNames: {} };
  };

  const result = await calculator.checkLookup({ drug_codes: ["600"], disease_codes: ["A"] });

  assert.equal(seen.payload.op, "check_lookup");
  assert.equal(seen.payload.db_path, dbPath);
  assert.deepEqual(seen.payload.drug_codes, ["600"]);
  assert.equal(seen.options.requestIdPrefix, "fee_check_lookup");
  assert.deepEqual(result.drugIndications["600"], []);
});

test("resolveDiseases routes through the worker with op resolve_diseases", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-resolve-dis-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({ masterDbPath: dbPath, workerMode: true });
  let seen = null;
  calculator.runWorkerJson = async (payload, options) => {
    seen = { payload, options };
    return { resolved: { "高血圧症": { code: "8830592", matchType: "exact", suspected: false } } };
  };

  const result = await calculator.resolveDiseases({ names: ["高血圧症"] });

  assert.equal(seen.payload.op, "resolve_diseases");
  assert.equal(seen.payload.db_path, dbPath);
  assert.deepEqual(seen.payload.names, ["高血圧症"]);
  assert.equal(seen.options.requestIdPrefix, "fee_resolve_diseases");
  assert.equal(result.resolved["高血圧症"].code, "8830592");
});

test("diseaseActCandidates routes through the worker with op disease_act_candidates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-disease-act-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({ masterDbPath: dbPath, workerMode: true });
  let seen = null;
  calculator.runWorkerJson = async (payload, options) => {
    seen = { payload, options };
    return {
      candidates: [{ familyName: "特定疾患療養管理料", codes: [{ code: "113001810", points: 225 }] }],
      unresolvedNames: []
    };
  };

  const result = await calculator.diseaseActCandidates({
    diagnoses: [{ name: "慢性閉塞性肺疾患", suspected: false }],
    setting: "outpatient",
    act_code_prefixes: ["113", "114"]
  });

  assert.equal(seen.payload.op, "disease_act_candidates");
  assert.equal(seen.payload.db_path, dbPath);
  assert.deepEqual(seen.payload.act_code_prefixes, ["113", "114"]);
  assert.equal(seen.options.requestIdPrefix, "fee_disease_act_candidates");
  assert.equal(result.candidates[0].codes[0].code, "113001810");
});

test("standingFeeFamilies routes through the worker with the service-date contract", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-standing-families-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({ masterDbPath: dbPath, workerMode: true });
  let seen = null;
  calculator.runWorkerJson = async (payload, options) => {
    seen = { payload, options };
    return {
      families: [{
        familyId: "fee_family_fixture",
        name: "在宅人工呼吸指導管理料",
        variants: [{ code: "114005410", frequencyLimits: [{ windowMonths: 1, maxCount: 1 }] }]
      }]
    };
  };

  const result = await calculator.standingFeeFamilies({ service_date: "2026-06-25" });

  assert.equal(seen.payload.op, "standing_fee_families");
  assert.equal(seen.payload.db_path, dbPath);
  assert.equal(seen.payload.service_date, "2026-06-25");
  assert.equal(seen.options.requestIdPrefix, "fee_standing_fee_families");
  assert.equal(result.families[0].variants[0].code, "114005410");
});

test("worker timeout fails only the timed-out request and re-dispatches survivors", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-worker-timeout-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({ masterDbPath: dbPath, workerMode: true });

  let workerCount = 0;
  const makeFakeWorker = () => ({
    killed: false,
    stdin: { write() {} },
    kill() { this.killed = true; }
  });
  calculator.ensureWorker = function ensureWorker() {
    if (this.worker && !this.worker.killed) {
      return this.worker;
    }
    workerCount += 1;
    this.worker = makeFakeWorker();
    return this.worker;
  };

  // reqA は応答せずタイムアウトさせる。reqB は巻き込まれず新ワーカーで完了させる。
  const slow = calculator.runWorkerJson({ q: "A" }, { timeoutMs: 40 });
  const survivor = calculator.runWorkerJson({ q: "B" }, { timeoutMs: 5000 });

  await assert.rejects(slow, /timed out/u);

  // 再送後、生存リクエスト(同一 requestId)へ新ワーカーが応答する。
  calculator.handleWorkerLine(JSON.stringify({ id: "fee_calc_2", ok: true, result: { q: "B" } }));

  assert.deepEqual(await survivor, { q: "B" });
  assert.equal(workerCount, 2);
});

test("reports detailed master readiness with checksums and source metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-readyz-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  const gzipPath = path.join(root, "standard-master.sqlite.gz");
  writeFileSync(dbPath, "sqlite fixture");
  writeFileSync(gzipPath, gzipSync(Buffer.from("sqlite fixture", "utf8")));

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    masterDbGzipPath: gzipPath,
    logger: SILENT_LOGGER
  });
  calculator.browseMaster = async (input) => {
    assert.equal(input.type, "sources");
    return {
      sources: [{
        sourceType: "medical_procedure_master",
        sourceVersion: "2026-06-15",
        publishedAt: "2026-06-05",
        rowCount: 11746,
        checksumSha256: "procedure-checksum",
        sourceUrl: "https://www.ssk.or.jp/example.zip"
      }],
      medicalElectronicFeeTableVersion: "2026-06-15",
      dpcStatus: { mode: "review_only", counts: { electronicTableRows: 0 } }
    };
  };

  const detailed = await calculator.readinessDetailed();

  assert.equal(detailed.masterDbChecksumSha256.length, 64);
  assert.equal(detailed.masterDbGzipChecksumSha256.length, 64);
  assert.equal(detailed.masterSources[0].sourceVersion, "2026-06-15");
  assert.equal(detailed.medicalElectronicFeeTableVersion, "2026-06-15");
  assert.equal(detailed.dpcStatus.mode, "review_only");
});

test("strict master content check rejects an incomplete expanded DB", async () => {
  const fixture = createMasterContentFixture({ procedureCount: 4, diseaseCount: 0 });
  writeMasterManifest(fixture.manifestPath, {
    medical_procedures: 4,
    diseases: 100
  });
  const calculator = new PythonFeeCalculator({
    masterDbPath: fixture.runtimeDbPath,
    masterDbGzipPath: fixture.gzipPath,
    masterDbManifestPath: fixture.manifestPath,
    masterContentCheckMode: "strict",
    logger: SILENT_LOGGER
  });

  await assert.rejects(
    calculator.ensureMasterDbReady(),
    (error) => error.name === "ConfigurationError"
      && error.statusCode === 503
      && /diseases\(0\/100\)/u.test(error.message)
  );
  assert.equal(calculator.masterContentCheck.ok, false);
  assert.deepEqual(calculator.masterContentCheck.failedTables[0], {
    table: "diseases",
    actual: 0,
    expected: 100,
    minimum: 50
  });
});

test("warn master content check exposes failures without blocking readiness", async () => {
  const fixture = createMasterContentFixture({ procedureCount: 4, diseaseCount: 0 });
  writeMasterManifest(fixture.manifestPath, {
    medical_procedures: 4,
    diseases: 100
  }, "warn-fixture-sha");
  const errors = [];
  const calculator = new PythonFeeCalculator({
    masterDbPath: fixture.runtimeDbPath,
    masterDbGzipPath: fixture.gzipPath,
    masterDbManifestPath: fixture.manifestPath,
    masterContentCheckMode: "warn",
    logger: { warn() {}, error(message) { errors.push(message); } }
  });

  await calculator.ensureMasterDbReady();
  const detailed = await calculator.readinessDetailed();

  assert.equal(detailed.masterContent.ok, false);
  assert.equal(detailed.masterContent.manifestSha, "warn-fixture-sha");
  assert.equal(detailed.masterContent.failedTables[0].table, "diseases");
  assert.equal(errors.length, 1, "content validation is performed and logged once per process");
});

test("missing master manifest remains compatible and is reported once", async () => {
  const fixture = createMasterContentFixture({ procedureCount: 1, diseaseCount: 0 });
  const warnings = [];
  const calculator = new PythonFeeCalculator({
    masterDbPath: fixture.runtimeDbPath,
    masterDbGzipPath: fixture.gzipPath,
    masterDbManifestPath: fixture.manifestPath,
    logger: { warn(message) { warnings.push(message); }, error() {} }
  });

  await calculator.ensureMasterDbReady();
  await calculator.ensureMasterDbReady();

  assert.equal(calculator.masterContentCheck.ok, true);
  assert.equal(calculator.masterContentCheck.manifestMissing, true);
  assert.equal(warnings.length, 1);
});

test("master content check succeeds when every manifest count is fulfilled", async () => {
  const fixture = createMasterContentFixture({ procedureCount: 4, diseaseCount: 2 });
  writeMasterManifest(fixture.manifestPath, {
    medical_procedures: 4,
    diseases: 2
  }, "complete-fixture-sha");
  const calculator = new PythonFeeCalculator({
    masterDbPath: fixture.runtimeDbPath,
    masterDbGzipPath: fixture.gzipPath,
    masterDbManifestPath: fixture.manifestPath,
    logger: SILENT_LOGGER
  });

  await calculator.ensureMasterDbReady();

  assert.deepEqual(calculator.masterContentCheck, {
    ok: true,
    failedTables: [],
    checkedAt: calculator.masterContentCheck.checkedAt,
    manifestSha: "complete-fixture-sha"
  });
});

function createMasterContentFixture({ procedureCount, diseaseCount }) {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-content-"));
  const sourceDbPath = path.join(root, "source.sqlite");
  const gzipPath = path.join(root, "standard-master.sqlite.gz");
  const manifestPath = path.join(root, "standard-master.manifest.json");
  const runtimeDbPath = path.join(root, "runtime", "standard-master.sqlite");
  const script = `
import sys
from medical_fee_calculation.db import connect, initialize_schema

db_path, procedure_count, disease_count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
conn = connect(db_path)
initialize_schema(conn)
conn.execute(
    "INSERT INTO master_sources "
    "(id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
    "VALUES (1, 'fixture', '1', 'fixture', 'fixture', 'utf-8', 0, '2026-07-16T00:00:00Z')"
)
for index in range(procedure_count):
    conn.execute(
        "INSERT INTO medical_procedures (source_id, code, short_name, points, raw_row_json) "
        "VALUES (1, ?, ?, 1, '[]')",
        (f'P{index:08d}', f'procedure-{index}'),
    )
for index in range(disease_count):
    conn.execute(
        "INSERT INTO diseases (source_id, code, name) VALUES (1, ?, ?)",
        (f'D{index:07d}', f'disease-{index}'),
    )
conn.commit()
conn.close()
`;
  const result = spawnSync("python3", ["-c", script, sourceDbPath, String(procedureCount), String(diseaseCount)], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "python") },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(gzipPath, gzipSync(readFileSync(sourceDbPath)));
  return { root, sourceDbPath, gzipPath, manifestPath, runtimeDbPath };
}

function writeMasterManifest(manifestPath, tables, sha256 = "fixture-sha") {
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-16T00:00:00Z",
    sha256,
    sourceVersions: [],
    tables
  }));
}
