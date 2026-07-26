#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileWhiteboxAdjudication } from "./lib/fee-whitebox-adjudication.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
const queuePath = resolvePath(args.queue);
const policyPath = resolvePath(args.policy);
const outputPath = resolvePath(args.output);
const queue = readJson(queuePath);
const policy = readJson(policyPath);
assertBoundHash(
  "policy",
  sha256File(policyPath),
  queue.source?.policySha256
);
const compiled = compileWhiteboxAdjudication(
  queue,
  policy
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output: path.relative(repoRoot, outputPath),
  purpose: compiled.purpose,
  promotionEligible: compiled.promotionEligible,
  reviewedCellCount: compiled.cells.filter(
    (cell) => cell.reviewedItemCount > 0
  ).length,
  feedbackEventCount: compiled.feedbackEvents.length
}, null, 2)}\n`);

function parseArgs(argv) {
  const result = {
    queue: "",
    policy: "configs/fee-whitebox-promotion-gate.json",
    output: "",
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--queue") result.queue = next(index++, arg);
    else if (arg === "--policy") result.policy = next(index++, arg);
    else if (arg === "--output") result.output = next(index++, arg);
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!result.help && (!result.queue || !result.output)) {
    throw new Error("--queue and --output are required");
  }
  return result;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertBoundHash(label, actual, expected) {
  if (!expected || actual !== expected) {
    throw new Error(
      `${label} sha256 does not match the adjudication queue: `
      + `expected=${expected || "missing"} actual=${actual}`
    );
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function printHelp() {
  process.stdout.write(`Compile a completed independent white-box review queue

Usage:
  node scripts/compile_fee_whitebox_adjudication.mjs \\
    --queue PATH --output PATH [--policy PATH]
`);
}
