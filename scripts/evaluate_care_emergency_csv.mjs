#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateCareEmergencyCsv } from "../packages/care-fee-core/src/csv-pipeline.js";

const options = parseArgs(process.argv.slice(2));
const inputPath = resolve(options.input);
const outputPath = resolve(options.output);
const facilitySettings = options.facilitySettings
  ? JSON.parse(await readFile(resolve(options.facilitySettings), "utf8"))
  : undefined;
const result = evaluateCareEmergencyCsv(await readFile(inputPath), {
  facilitySettings,
  runId: options.runId,
  evaluatedAt: options.evaluatedAt
});
await writeFile(outputPath, result.output);

process.stdout.write(`${JSON.stringify({
  input: inputPath,
  output: outputPath,
  runId: result.runId,
  masterVersion: result.masterVersion,
  ruleVersion: result.ruleVersion,
  sourceFileSha256: result.sourceFileSha256,
  summary: result.summary
}, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {};
  const names = new Map([
    ["--input", "input"],
    ["--output", "output"],
    ["--facility-settings", "facilitySettings"],
    ["--run-id", "runId"],
    ["--evaluated-at", "evaluatedAt"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name || index + 1 >= argv.length) {
      throw new Error(`unknown or incomplete option: ${argv[index]}`);
    }
    parsed[name] = argv[index + 1];
    index += 1;
  }
  if (!parsed.input || !parsed.output) {
    throw new Error("--input and --output are required");
  }
  return parsed;
}
