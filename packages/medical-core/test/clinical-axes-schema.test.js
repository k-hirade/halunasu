import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
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
} from "../src/fee/openai-fee-clinical-facts.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(packageRoot, "generated/clinical-axes.schema.json");

test("generated clinical axes schema stays aligned with the runtime contract", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

  assert.deepEqual(schema.required, [
    "actionStatus",
    "temporalRelation",
    "sourceOrigin",
    "providerOwnership",
    "standingStatus"
  ]);
  assert.deepEqual(schema.properties.actionStatus.enum, ACTION_STATUSES);
  assert.deepEqual(schema.properties.temporalRelation.enum, TEMPORAL_RELATIONS);
  assert.deepEqual(schema.properties.sourceOrigin.enum, SOURCE_ORIGINS);
  assert.deepEqual(schema.properties.providerOwnership.enum, PROVIDER_OWNERSHIPS);
  assert.deepEqual(schema.properties.standingStatus.enum, STANDING_STATUSES);
  assert.deepEqual(schema.$defs.lineRole.enum, FEE_CLINICAL_LINE_ROLES);
  assert.deepEqual(schema.$defs.resultAssertion.enum, RESULT_ASSERTIONS);
  assert.deepEqual(schema.$defs.certainty.enum, CERTAINTY_LEVELS);
  assert.deepEqual(schema.$defs.checklistStatus.enum, CHECKLIST_STATUSES);
  assert.deepEqual(schema.$defs.eventType.enum, EVENT_TYPES);
  assert.deepEqual(schema.$defs.billingDomain.enum, BILLING_DOMAINS);
  assert.equal(
    schema["x-halunasu-prompt-version"],
    FEE_CLINICAL_FACTS_PROMPT_VERSION
  );
});

test("shared clinical axis enums cannot be mutated at runtime", () => {
  for (const values of [
    ACTION_STATUSES,
    TEMPORAL_RELATIONS,
    SOURCE_ORIGINS,
    PROVIDER_OWNERSHIPS,
    STANDING_STATUSES
  ]) {
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => values.push("invalid"));
  }
});
