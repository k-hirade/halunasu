#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildNonOutpatientHoldoutBlueprints,
  requiredFeeMasterCodesForHoldoutGeneration
} from "./lib/fee-specialty-holdout-generation.mjs";
import {
  queryFeeMasterCodes,
  writeJsonAtomic
} from "./lib/fee-specialty-promotion.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
const outputPath = path.resolve(repoRoot, args.output);
const masterDbPath = path.resolve(repoRoot, args.masterDb);
const masterRecords = queryFeeMasterCodes({
  codes: requiredFeeMasterCodesForHoldoutGeneration(),
  masterDbPath,
  repoRoot,
  pythonBinary: args.python
});
const document = buildNonOutpatientHoldoutBlueprints({
  masterRecords,
  casesPerCell: args.casesPerCell,
  serviceMonth: args.serviceMonth
});
if (!args.dryRun) writeJsonAtomic(outputPath, document);
process.stdout.write(`${JSON.stringify({
  dryRun: args.dryRun,
  output: path.relative(repoRoot, outputPath),
  blueprintCount: document.blueprints.length,
  casesPerCell: document.casesPerCell
}, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    output: "data/tests/fee-specialty-matrix/non-outpatient-blueprints.json",
    masterDb: "python/data/master/standard-master.sqlite",
    python: process.env.PYTHON || "python3",
    serviceMonth: "2026-08",
    casesPerCell: 2,
    dryRun: false,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") parsed.output = next(index++, arg);
    else if (arg === "--master-db") parsed.masterDb = next(index++, arg);
    else if (arg === "--python") parsed.python = next(index++, arg);
    else if (arg === "--service-month") parsed.serviceMonth = next(index++, arg);
    else if (arg === "--cases-per-cell") parsed.casesPerCell = Number(next(index++, arg));
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!/^\d{4}-\d{2}$/u.test(parsed.serviceMonth)) {
    throw new Error("--service-month must use YYYY-MM");
  }
  return parsed;
}

function printHelp() {
  process.stdout.write("Generate deterministic home-visit, house-call, and telephone holdout blueprints.\n");
}
