#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_STATUSES,
  BILLING_DOMAINS,
  CERTAINTY_LEVELS,
  CHECKLIST_STATUSES,
  EVENT_TYPES,
  FEE_CLINICAL_FACTS_PROMPT_VERSION,
  FEE_CLINICAL_LINE_ROLES,
  PROVIDER_OWNERSHIPS,
  RESULT_ASSERTIONS,
  SOURCE_ORIGINS,
  STANDING_STATUSES,
  TEMPORAL_RELATIONS
} from "../packages/medical-core/src/fee/openai-fee-clinical-facts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  repoRoot,
  "packages/medical-core/generated/clinical-axes.schema.json"
);
const checkOnly = process.argv.includes("--check");

const axes = {
  actionStatus: ACTION_STATUSES,
  temporalRelation: TEMPORAL_RELATIONS,
  sourceOrigin: SOURCE_ORIGINS,
  providerOwnership: PROVIDER_OWNERSHIPS,
  standingStatus: STANDING_STATUSES
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://halunasu.com/schemas/fee-clinical-axes.schema.json",
  title: "Halunasu fee clinical extraction axes",
  description: "Canonical enums shared by fee extraction datasets and runtimes.",
  type: "object",
  additionalProperties: false,
  required: Object.keys(axes),
  properties: Object.fromEntries(
    Object.entries(axes).map(([name, values]) => [
      name,
      { type: "string", enum: [...values] }
    ])
  ),
  $defs: {
    lineRole: { type: "string", enum: [...FEE_CLINICAL_LINE_ROLES] },
    resultAssertion: { type: "string", enum: [...RESULT_ASSERTIONS] },
    certainty: { type: "string", enum: [...CERTAINTY_LEVELS] },
    checklistStatus: { type: "string", enum: [...CHECKLIST_STATUSES] },
    eventType: { type: "string", enum: [...EVENT_TYPES] },
    billingDomain: { type: "string", enum: [...BILLING_DOMAINS] }
  },
  "x-halunasu-prompt-version": FEE_CLINICAL_FACTS_PROMPT_VERSION
};

const serialized = `${JSON.stringify(schema, null, 2)}\n`;

if (checkOnly) {
  if (!fs.existsSync(outputPath)) {
    console.error(`Generated schema is missing: ${path.relative(repoRoot, outputPath)}`);
    process.exitCode = 1;
  } else if (fs.readFileSync(outputPath, "utf8") !== serialized) {
    console.error(
      `Generated schema is stale: ${path.relative(repoRoot, outputPath)}. `
      + "Run npm run build:fee-clinical-axes."
    );
    process.exitCode = 1;
  } else {
    console.log(`Clinical axes schema is current: ${path.relative(repoRoot, outputPath)}`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
