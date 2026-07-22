#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLongitudinalL7Summary } from "./lib/fee-monthly-chart-evaluation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.runDir) {
  throw new Error("--run-dir is required");
}

const runDir = path.resolve(repoRoot, args.runDir);
const resultPaths = args.results.length
  ? args.results.map((value) => path.resolve(repoRoot, value))
  : findMonthlyResults(runDir);
if (!resultPaths.length) {
  throw new Error(`no fee-monthly-chart-e2e result.json files found under ${args.runDir}`);
}

const results = resultPaths.map(readJson);
const pathsByPatient = new Map();
for (let index = 0; index < results.length; index += 1) {
  const patientRef = String(results[index]?.inputAudit?.patientRef || "");
  const paths = pathsByPatient.get(patientRef) || [];
  paths.push(resultPaths[index]);
  pathsByPatient.set(patientRef, paths);
}
const duplicates = [...pathsByPatient.entries()].filter(([patientRef, paths]) => !patientRef || paths.length !== 1);
if (duplicates.length) {
  throw new Error(
    `monthly results must contain one file per patient; specify --result explicitly: ${duplicates
      .map(([patientRef, paths]) => `${patientRef || "(missing)"}=${paths.length}`)
      .join(", ")}`
  );
}

const readinessBefore = readRequiredJson(path.join(runDir, args.readyzBefore));
const readinessAfter = readRequiredJson(path.join(runDir, args.readyzAfter));
const summary = buildLongitudinalL7Summary({
  results,
  readinessBefore,
  readinessAfter,
  runId: args.runId || path.basename(runDir)
});
const outputPath = path.resolve(runDir, args.output);
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary.aggregate, null, 2)}\n`);
process.stdout.write(`summary=${outputPath}\n`);

function parseArgs(argv) {
  const parsed = {
    runDir: "",
    results: [],
    readyzBefore: "readyz-before.json",
    readyzAfter: "readyz-after.json",
    output: "summary.json",
    runId: "",
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-dir") parsed.runDir = next(index++, arg);
    else if (arg === "--result") parsed.results.push(next(index++, arg));
    else if (arg === "--readyz-before") parsed.readyzBefore = next(index++, arg);
    else if (arg === "--readyz-after") parsed.readyzAfter = next(index++, arg);
    else if (arg === "--output") parsed.output = next(index++, arg);
    else if (arg === "--run-id") parsed.runId = next(index++, arg);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

function findMonthlyResults(directory) {
  const paths = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "result.json") {
        const candidate = readJson(target);
        if (String(candidate?.schemaVersion || "").startsWith("fee-monthly-chart-e2e.")) paths.push(target);
      }
    }
  };
  visit(directory);
  return paths.sort();
}

function readRequiredJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`required readiness file not found: ${filePath}`);
  return readJson(filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printHelp() {
  process.stdout.write(`Summarize monthly chart E2E results for longitudinal L7\n\nUsage:\n  npm run eval:fee-longitudinal-l7-summary -- --run-dir PATH [options]\n\nOptions:\n  --run-dir PATH         Run directory containing readyz files and patient results\n  --result PATH          Explicit monthly result.json; repeat for each patient\n  --readyz-before PATH   Relative to run-dir. Default: readyz-before.json\n  --readyz-after PATH    Relative to run-dir. Default: readyz-after.json\n  --output PATH          Relative to run-dir. Default: summary.json\n  --run-id ID            Default: run directory name\n  --help                 Show this help\n`);
}
