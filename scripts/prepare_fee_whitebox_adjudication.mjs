#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareWhiteboxAdjudicationQueue } from "./lib/fee-whitebox-adjudication.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const runManifestPath = resolvePath(args.runManifest);
const runManifest = readJson(runManifestPath);
const datasetPath = resolvePath(args.dataset || runManifest.source?.dataset);
const policyPath = resolvePath(args.policy || runManifest.source?.policy);
const outputPath = resolvePath(args.output);
const datasetSha256 = sha256File(datasetPath);
const policySha256 = sha256File(policyPath);
assertBoundHash("dataset", datasetSha256, runManifest.source?.datasetSha256);
assertBoundHash("policy", policySha256, runManifest.source?.policySha256);

const queue = prepareWhiteboxAdjudicationQueue({
  runManifest,
  dataset: readJson(datasetPath),
  policy: readJson(policyPath),
  bindings: {
    runManifestSha256: sha256File(runManifestPath),
    datasetSha256,
    policySha256
  },
  additionalPerCell: args.additionalPerCell
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(queue, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output: path.relative(repoRoot, outputPath),
  purpose: queue.purpose,
  promotionEligibleSource: queue.promotionEligibleSource,
  selectedItemCount: queue.items.length,
  disagreementItemCount: queue.selection.disagreementItemCount,
  minimumObservedLinesPerCell: queue.coverage.minimumObservedLinesPerCell,
  minimumObservedMachineSpansPerCell: (
    queue.coverage.minimumObservedMachineSpansPerCell
  )
}, null, 2)}\n`);

function parseArgs(argv) {
  const result = {
    runManifest: "",
    dataset: "",
    policy: "",
    output: "",
    additionalPerCell: 1,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-manifest") result.runManifest = next(index++, arg);
    else if (arg === "--dataset") result.dataset = next(index++, arg);
    else if (arg === "--policy") result.policy = next(index++, arg);
    else if (arg === "--output") result.output = next(index++, arg);
    else if (arg === "--additional-per-cell") {
      result.additionalPerCell = nonnegativeInteger(next(index++, arg), arg);
    } else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!result.help && (!result.runManifest || !result.output)) {
    throw new Error("--run-manifest and --output are required");
  }
  return result;
}

function assertBoundHash(label, actual, expected) {
  if (!expected || actual !== expected) {
    throw new Error(
      `${label} sha256 does not match the run manifest: `
      + `expected=${expected || "missing"} actual=${actual}`
    );
  }
}

function resolvePath(value) {
  if (!value) throw new Error("bound input path is missing");
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function nonnegativeInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Prepare an independently reviewable white-box adjudication queue

Usage:
  node scripts/prepare_fee_whitebox_adjudication.mjs \\
    --run-manifest PATH --output PATH [options]

Options:
  --dataset PATH              Override the manifest-bound dataset path
  --policy PATH               Override the manifest-bound policy path
  --additional-per-cell N     Deterministic agreement samples per cell. Default: 1
  --help                      Show this help
`);
}
