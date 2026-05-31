import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const MODULE_NAME = "medical_fee_calculation.api";
const WORKER_MODULE_NAME = "medical_fee_calculation.worker";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function createFeeCalculatorFromEnv(env = process.env) {
  const gzipPath = env.FEE_MASTER_DB_GZIP_PATH || env.MEDICAL_FEE_MASTER_DB_GZIP_PATH || "";
  const masterDbPath = env.FEE_MASTER_DB_PATH
    || env.MEDICAL_FEE_MASTER_DB_PATH
    || (gzipPath ? path.join("/tmp", "halunasu-fee-master", path.basename(gzipPath).replace(/\.gz$/u, "")) : "");

  const calculator = new PythonFeeCalculator({
    pythonBin: env.FEE_PYTHON_BIN || env.PYTHON_BIN || "python3",
    pythonPath: env.FEE_PYTHONPATH || env.PYTHONPATH || path.join(ROOT_DIR, "python"),
    masterDbPath,
    masterDbGzipPath: gzipPath,
    timeoutMs: Number(env.FEE_CALCULATOR_TIMEOUT_MS || 30000),
    workerMode: env.FEE_PYTHON_WORKER_MODE === "spawn" || env.FEE_PYTHON_WORKER === "0" ? false : true
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
    this.timeoutMs = options.timeoutMs || 30000;
    this.workerMode = options.workerMode !== false;
    this.masterDbPreparePromise = null;
    this.worker = null;
    this.workerStdoutBuffer = "";
    this.workerStderrBuffer = "";
    this.workerRequestCounter = 0;
    this.workerPending = new Map();
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
      timeoutMs: this.timeoutMs,
      workerMode: this.workerMode ? "persistent" : "spawn",
      workerRunning: Boolean(this.worker)
    };
  }

  async ensureMasterDbReady() {
    if (this.masterDbPath && existsSync(this.masterDbPath)) {
      return;
    }
    if (!this.masterDbPath) {
      const error = new Error("FEE_MASTER_DB_PATH is required for medical fee calculation");
      error.name = "ConfigurationError";
      error.statusCode = 503;
      throw error;
    }
    if (!this.masterDbGzipPath) {
      const error = new Error(`Fee master DB not found: ${this.masterDbPath}`);
      error.name = "ConfigurationError";
      error.statusCode = 503;
      throw error;
    }
    if (!existsSync(this.masterDbGzipPath)) {
      const error = new Error(`Fee master gzip not found: ${this.masterDbGzipPath}`);
      error.name = "ConfigurationError";
      error.statusCode = 503;
      throw error;
    }

    if (!this.masterDbPreparePromise) {
      this.masterDbPreparePromise = this.expandMasterDbGzip();
    }
    await this.masterDbPreparePromise;
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

  runWorkerJson(payload) {
    const child = this.ensureWorker();
    const requestId = `fee_calc_${++this.workerRequestCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerPending.delete(requestId);
        this.stopWorker();
        reject(feeCalculationTimeoutError());
      }, this.timeoutMs);
      this.workerPending.set(requestId, {
        resolve,
        reject,
        timer
      });
      child.stdin.write(`${JSON.stringify({ id: requestId, payload })}\n`);
    });
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
      this.rejectPendingWorkerRequests(error);
    });
    child.on("close", (code) => {
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

function runPythonJson(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.pythonBin, ["-m", MODULE_NAME], {
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
