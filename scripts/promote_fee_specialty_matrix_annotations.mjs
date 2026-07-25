#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectQueueMasterCodes,
  promoteReviewedAnnotations,
  queryFeeMasterCodes,
  SpecialtyPromotionError,
  writeJsonAtomic
} from "./lib/fee-specialty-promotion.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const inputPath = resolvePath(args.input);
  const datasetPath = resolvePath(args.dataset);
  const queueDocument = readJson(inputPath);
  const dataset = readJson(datasetPath);
  const matrix = readJson(resolvePath(args.matrix));
  const clinicalAxesSchema = readJson(resolvePath(args.clinicalAxesSchema));
  const masterDbPath = resolvePath(args.masterDb);
  const masterRecords = queryFeeMasterCodes({
    codes: collectQueueMasterCodes(queueDocument),
    masterDbPath,
    repoRoot,
    pythonBinary: args.python
  });
  const result = promoteReviewedAnnotations({
    queueDocument,
    dataset,
    matrix,
    clinicalAxesSchema,
    masterRecords,
    replace: args.replace,
    strict: args.strict,
    reviewedAt: args.reviewedAt
  });
  if (!args.dryRun) writeJsonAtomic(datasetPath, result.dataset);
  process.stdout.write(`${JSON.stringify({
    dryRun: args.dryRun,
    output: path.relative(repoRoot, datasetPath),
    promotedCaseIds: result.promoted.map((item) => item.caseId),
    caseCount: result.dataset.cases.length,
    completeCellCount: result.validation.completeCellCount,
    cellCount: result.validation.cellCount,
    warnings: result.validation.warnings
  }, null, 2)}\n`);
} catch (error) {
  const details = error instanceof SpecialtyPromotionError ? error.details : [];
  process.stderr.write(`${JSON.stringify({
    error: error.name || "Error",
    message: error.message,
    details
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {
    input: "",
    dataset: "data/tests/fee-specialty-matrix/cases.json",
    matrix: "data/tests/fee-specialty-matrix/matrix-v3.json",
    clinicalAxesSchema: "packages/medical-core/generated/clinical-axes.schema.json",
    masterDb: "python/data/master/standard-master.sqlite",
    python: process.env.PYTHON || "python3",
    reviewedAt: "",
    replace: false,
    strict: false,
    dryRun: false,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") parsed.input = next(index++, arg);
    else if (arg === "--dataset") parsed.dataset = next(index++, arg);
    else if (arg === "--matrix") parsed.matrix = next(index++, arg);
    else if (arg === "--clinical-axes-schema") parsed.clinicalAxesSchema = next(index++, arg);
    else if (arg === "--master-db") parsed.masterDb = next(index++, arg);
    else if (arg === "--python") parsed.python = next(index++, arg);
    else if (arg === "--reviewed-at") parsed.reviewedAt = next(index++, arg);
    else if (arg === "--replace") parsed.replace = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!parsed.help && !parsed.input) throw new Error("--input is required");
  return parsed;
}

function resolvePath(value) {
  return path.resolve(repoRoot, value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/promote_fee_specialty_matrix_annotations.mjs --input reviewed-queue.json [options]

Options:
  --dataset <path>               Target cases.json
  --matrix <path>                Specialty matrix contract
  --clinical-axes-schema <path>  Generated clinical axes schema
  --master-db <path>             Standard fee master SQLite
  --reviewed-at <YYYY-MM-DD>     Review date (default: today)
  --replace                      Replace only an identical-source holdout
  --strict                       Require every matrix cell to be complete
  --dry-run                      Validate without writing
`);
}
