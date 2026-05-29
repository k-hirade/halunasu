import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_NAME = "medical_fee_calculation.api";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function createFeeCalculatorFromEnv(env = process.env) {
  return new PythonFeeCalculator({
    pythonBin: env.FEE_PYTHON_BIN || env.PYTHON_BIN || "python3",
    pythonPath: env.FEE_PYTHONPATH || env.PYTHONPATH || path.join(ROOT_DIR, "python"),
    masterDbPath: env.FEE_MASTER_DB_PATH || env.MEDICAL_FEE_MASTER_DB_PATH,
    timeoutMs: Number(env.FEE_CALCULATOR_TIMEOUT_MS || 30000)
  });
}

export class PythonFeeCalculator {
  constructor(options = {}) {
    this.pythonBin = options.pythonBin || "python3";
    this.pythonPath = options.pythonPath || path.join(ROOT_DIR, "python");
    this.masterDbPath = options.masterDbPath;
    this.timeoutMs = options.timeoutMs || 30000;
  }

  async calculate(session, input = {}) {
    if (!this.masterDbPath) {
      const error = new Error("FEE_MASTER_DB_PATH is required for medical fee calculation");
      error.name = "ConfigurationError";
      error.statusCode = 503;
      throw error;
    }

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
