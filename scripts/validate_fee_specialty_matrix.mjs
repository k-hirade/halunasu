#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateFeeSpecialtyMatrix } from "./lib/fee-specialty-matrix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetDir = path.join(repoRoot, "data/tests/fee-specialty-matrix");
const strict = process.argv.includes("--strict");
const matrix = JSON.parse(
  fs.readFileSync(path.join(datasetDir, "matrix-v3.json"), "utf8")
);
const dataset = JSON.parse(
  fs.readFileSync(path.join(datasetDir, "cases.json"), "utf8")
);
const clinicalAxesSchema = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      "packages/medical-core/generated/clinical-axes.schema.json"
    ),
    "utf8"
  )
);

const result = validateFeeSpecialtyMatrix({
  matrix,
  dataset,
  clinicalAxesSchema,
  strict
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
