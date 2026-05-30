import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const MODULE_NAME = "medical_fee_calculation.api";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function createFeeCalculatorFromEnv(env = process.env) {
  const gzipPath = env.FEE_MASTER_DB_GZIP_PATH || env.MEDICAL_FEE_MASTER_DB_GZIP_PATH || "";
  const masterDbPath = env.FEE_MASTER_DB_PATH
    || env.MEDICAL_FEE_MASTER_DB_PATH
    || (gzipPath ? path.join("/tmp", "halunasu-fee-master", path.basename(gzipPath).replace(/\.gz$/u, "")) : "");

  return new PythonFeeCalculator({
    pythonBin: env.FEE_PYTHON_BIN || env.PYTHON_BIN || "python3",
    pythonPath: env.FEE_PYTHONPATH || env.PYTHONPATH || path.join(ROOT_DIR, "python"),
    masterDbPath,
    masterDbGzipPath: gzipPath,
    timeoutMs: Number(env.FEE_CALCULATOR_TIMEOUT_MS || 30000)
  });
}

export class PythonFeeCalculator {
  constructor(options = {}) {
    this.pythonBin = options.pythonBin || "python3";
    this.pythonPath = options.pythonPath || path.join(ROOT_DIR, "python");
    this.masterDbPath = options.masterDbPath;
    this.masterDbGzipPath = options.masterDbGzipPath || "";
    this.timeoutMs = options.timeoutMs || 30000;
    this.masterDbPreparePromise = null;
  }

  async calculate(session, input = {}) {
    await this.ensureMasterDbReady();

    const output = await runPythonJson({
      pythonBin: this.pythonBin,
      pythonPath: this.pythonPath,
      timeoutMs: this.timeoutMs,
      payload: {
        db_path: this.masterDbPath,
        session,
        input
      }
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
      timeoutMs: this.timeoutMs
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
      const error = new Error("medical fee calculation timed out");
      error.name = "FeeCalculationTimeoutError";
      error.statusCode = 504;
      reject(error);
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
