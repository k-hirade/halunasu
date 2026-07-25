import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildExperimentalHoldoutDataset
} from "./lib/fee-specialty-experimental-holdout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  canonical: "data/tests/fee-specialty-matrix/cases.json",
  generated: "data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json",
  blueprints: "data/tests/fee-specialty-matrix/non-outpatient-blueprints.json",
  output: "data/tests/fee-specialty-matrix/experimental-machine-holdout.json"
};

function parseArgs(argv) {
  const result = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--canonical", "--generated", "--blueprints", "--output"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (!argv[index + 1]) {
      throw new Error(`${flag} requires a value`);
    }
    result[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.resolve(root, relativePath), "utf8"));
}

const args = parseArgs(process.argv.slice(2));
const result = buildExperimentalHoldoutDataset({
  canonicalDataset: await readJson(args.canonical),
  generatedDataset: await readJson(args.generated),
  blueprintDataset: await readJson(args.blueprints)
});
const outputPath = path.resolve(root, args.output);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output: path.relative(root, outputPath),
  coverage: result.coverage,
  notGold: result.notGold,
  humanReviewSkipped: result.humanReviewSkipped
}, null, 2));
