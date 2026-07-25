#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStructuredOpenAiResponse } from "../packages/medical-core/src/openai/responses-structured.js";
import {
  generateHoldoutTexts,
  HOLDOUT_TEXT_SCHEMA,
  validateNonOutpatientBlueprintDataset
} from "./lib/fee-specialty-holdout-generation.mjs";
import { writeJsonAtomic } from "./lib/fee-specialty-promotion.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
const inputPath = path.resolve(repoRoot, args.input);
const outputPath = path.resolve(repoRoot, args.output);
const blueprintDocument = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const blueprintValidation = validateNonOutpatientBlueprintDataset({
  document: blueprintDocument,
  requireClinicalText: false
});
if (!blueprintValidation.ok) {
  throw new Error(`blueprint validation failed: ${blueprintValidation.errors.join("; ")}`);
}
if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    input: path.relative(repoRoot, inputPath),
    output: path.relative(repoRoot, outputPath),
    blueprintCount: blueprintValidation.itemCount,
    model: args.model,
    modelRevision: args.modelRevision || null,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    schema: HOLDOUT_TEXT_SCHEMA
  }, null, 2)}\n`);
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
if (!args.modelRevision) {
  throw new Error("--model-revision is required for immutable generation provenance");
}
const document = await generateHoldoutTexts({
  blueprintDocument,
  model: args.model,
  modelRevision: args.modelRevision,
  maxAttempts: args.maxAttempts,
  generator: async ({ blueprint, instructions, schema, model }) => {
    const response = await createStructuredOpenAiResponse({
      apiKey: process.env.OPENAI_API_KEY,
      model,
      instructions,
      input: JSON.stringify({
        task: "Create one synthetic SOAP note from this immutable billing blueprint.",
        specialty: blueprint.specialtyLabel,
        encounterSetting: blueprint.encounterSetting,
        style: blueprint.style,
        requiredPhrases: blueprint.requiredPhrases,
        forbiddenPhrases: blueprint.forbiddenPhrases,
        billingTargets: blueprint.billingTargets.map(({ name }) => name),
        encounterFacts: blueprint.expectedClaimContext
      }),
      schemaName: "fee_specialty_holdout_note",
      schema,
      reasoningEffort: "low",
      timeoutMs: args.timeoutMs,
      maxOutputTokens: 2200
    });
    return {
      clinicalText: response.parsed.clinicalText,
      responseId: response.responseId,
      usage: response.usage
    };
  }
});
writeJsonAtomic(outputPath, document);
process.stdout.write(`${JSON.stringify({
  output: path.relative(repoRoot, outputPath),
  caseCount: document.cases.length,
  model: args.model,
  modelRevision: args.modelRevision
}, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    input: "data/tests/fee-specialty-matrix/non-outpatient-blueprints.json",
    output: "data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json",
    model: process.env.OPENAI_FEE_CLINICAL_MODEL || "gpt-5.4-nano",
    modelRevision: "",
    maxAttempts: 2,
    timeoutMs: 60_000,
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
    else if (arg === "--output") parsed.output = next(index++, arg);
    else if (arg === "--model") parsed.model = next(index++, arg);
    else if (arg === "--model-revision") parsed.modelRevision = next(index++, arg);
    else if (arg === "--max-attempts") parsed.maxAttempts = Number(next(index++, arg));
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(next(index++, arg));
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1 || parsed.maxAttempts > 5) {
    throw new Error("--max-attempts must be an integer from 1 to 5");
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Generate synthetic SOAP text for non-outpatient holdout blueprints.
Non-dry runs require OPENAI_API_KEY and --model-revision.
`);
}
