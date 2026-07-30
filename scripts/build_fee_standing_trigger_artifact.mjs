import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "data/fee-rules/source/standing-structured-triggers-2026.json");
const OUTPUT_PATH = path.join(
  ROOT,
  "services/fee-api/src/fee-rule-data/standing-structured-triggers-2026.generated.json"
);
const ALLOWED_OPERATORS = new Set([
  "contains",
  "contains_any",
  "equals",
  "gte",
  "not_contains"
]);
const ALLOWED_FAILURE_MODES = new Set(["silent", "sensor_warning"]);
const ALLOWED_RULE_KINDS = new Set([
  "dependent_addon",
  "device_management",
  "standing_family"
]);

const args = new Set(process.argv.slice(2));
const source = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
validateSource(source);

const payload = {
  schemaVersion: "fee-standing-structured-trigger-artifact-v2",
  revision: source.revision,
  effectiveFrom: source.effectiveFrom,
  verifiedAt: source.verifiedAt,
  sourceDefinitionSha256: sha256(canonicalJson(source)),
  sourceDocuments: [...source.sourceDocuments].sort(byField("sourceId")),
  triggers: [...source.triggers].sort(byField("triggerId"))
};
const artifact = {
  ...payload,
  artifactPayloadSha256: sha256(canonicalJson(payload))
};
const rendered = `${JSON.stringify(artifact, null, 2)}\n`;

if (args.has("--check")) {
  const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
  if (current !== rendered) {
    throw new Error(`fee standing trigger artifact is stale: ${OUTPUT_PATH}`);
  }
  console.log(`fee standing trigger artifact is current: ${OUTPUT_PATH}`);
} else {
  await writeFile(OUTPUT_PATH, rendered, "utf8");
  console.log(OUTPUT_PATH);
}

function validateSource(value) {
  if (value?.schemaVersion !== "fee-standing-structured-trigger-source-v1") {
    throw new TypeError("unsupported standing trigger source schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value.effectiveFrom || ""))) {
    throw new TypeError("effectiveFrom must use YYYY-MM-DD");
  }
  const sourceIds = new Set();
  for (const document of array(value.sourceDocuments)) {
    const sourceId = required(document.sourceId, "sourceDocuments.sourceId");
    if (sourceIds.has(sourceId)) {
      throw new TypeError(`duplicate source document: ${sourceId}`);
    }
    sourceIds.add(sourceId);
    if (!/^https:\/\/(?:www\.)?mhlw\.go\.jp\//u.test(String(document.url || ""))) {
      throw new TypeError(`source URL must be an official MHLW URL: ${sourceId}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(document.sha256 || ""))) {
      throw new TypeError(`source sha256 is invalid: ${sourceId}`);
    }
  }

  const triggerIds = new Set();
  for (const trigger of array(value.triggers)) {
    const triggerId = required(trigger.triggerId, "triggers.triggerId");
    if (triggerIds.has(triggerId)) {
      throw new TypeError(`duplicate standing trigger: ${triggerId}`);
    }
    triggerIds.add(triggerId);
    const ruleKind = required(trigger.ruleKind, `${triggerId}.ruleKind`);
    if (!ALLOWED_RULE_KINDS.has(ruleKind)) {
      throw new TypeError(`${triggerId} has an unsupported ruleKind`);
    }
    required(trigger.version, `${triggerId}.version`);
    validateFamilySelector(trigger.familySelector, `${triggerId}.familySelector`);
    if (!array(trigger.requiredPositiveFacts).length) {
      throw new TypeError(`${triggerId} requires at least one positive fact`);
    }
    for (const condition of trigger.requiredPositiveFacts) {
      required(condition.fact, `${triggerId}.requiredPositiveFacts.fact`);
      if (!ALLOWED_OPERATORS.has(String(condition.operator || ""))) {
        throw new TypeError(`${triggerId} uses an unsupported fact operator`);
      }
      if (!Object.hasOwn(condition, "value")) {
        throw new TypeError(`${triggerId} fact condition requires value`);
      }
    }
    if (!ALLOWED_FAILURE_MODES.has(String(trigger.failureMode || ""))) {
      throw new TypeError(`${triggerId} has an unsupported failureMode`);
    }
    if (ruleKind === "dependent_addon") {
      if (!array(trigger.parentFamilySelectors).length) {
        throw new TypeError(`${triggerId} requires parentFamilySelectors`);
      }
      trigger.parentFamilySelectors.forEach((selector, index) => (
        validateFamilySelector(selector, `${triggerId}.parentFamilySelectors[${index}]`)
      ));
      required(
        trigger.requiredFacilityStandardKey,
        `${triggerId}.requiredFacilityStandardKey`
      );
      if (trigger.scope !== "per_month") {
        throw new TypeError(`${triggerId}.scope must be per_month`);
      }
    } else if (
      trigger.parentFamilySelectors !== undefined
      || trigger.requiredFacilityStandardKey !== undefined
      || trigger.scope !== undefined
    ) {
      throw new TypeError(`${triggerId} has dependent-addon-only fields`);
    }
    if (!sourceIds.has(String(trigger.source?.sourceId || ""))) {
      throw new TypeError(`${triggerId} references an unknown source`);
    }
    required(trigger.source?.section, `${triggerId}.source.section`);
    required(trigger.source?.requirementSummary, `${triggerId}.source.requirementSummary`);
  }
}

function validateFamilySelector(selector, label) {
  required(selector?.name, `${label}.name`);
  for (const field of ["chapter", "part", "alphaPart", "section", "branch"]) {
    required(selector?.hierarchy?.[field], `${label}.hierarchy.${field}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byField(field) {
  return (left, right) => String(left?.[field] || "").localeCompare(String(right?.[field] || ""));
}

function required(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    throw new TypeError(`${label} is required`);
  }
  return text;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
