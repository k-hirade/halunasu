import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "data/fee-rules/source/proposal-governance-2026.json");
const OUTPUT_PATH = path.join(
  ROOT,
  "services/fee-api/src/fee-rule-data/proposal-governance-2026.generated.json"
);

const args = new Set(process.argv.slice(2));
const sourceText = await readFile(SOURCE_PATH, "utf8");
const source = JSON.parse(sourceText);
validateSource(source);

const payload = {
  schemaVersion: "fee-proposal-governance-artifact-v2",
  revision: source.revision,
  effectiveFrom: source.effectiveFrom,
  verifiedAt: source.verifiedAt,
  sourceDefinitionSha256: sha256(canonicalJson(source)),
  sourceDocuments: [...source.sourceDocuments].sort(byField("sourceId")),
  facilityStandardRequirements: [...source.facilityStandardRequirements].sort(byField("code")),
  variantFamilies: [...source.variantFamilies].sort(byField("familyId")),
  bundlingRules: [...source.bundlingRules].sort(byField("ruleId"))
};
const artifact = {
  ...payload,
  artifactPayloadSha256: sha256(canonicalJson(payload))
};
const rendered = `${JSON.stringify(artifact, null, 2)}\n`;

if (args.has("--check")) {
  const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
  if (current !== rendered) {
    throw new Error(`fee proposal governance artifact is stale: ${OUTPUT_PATH}`);
  }
  console.log(`fee proposal governance artifact is current: ${OUTPUT_PATH}`);
} else {
  await writeFile(OUTPUT_PATH, rendered, "utf8");
  console.log(OUTPUT_PATH);
}

function validateSource(value) {
  if (value?.schemaVersion !== "fee-proposal-governance-source-v1") {
    throw new TypeError("unsupported proposal governance source schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value.effectiveFrom || ""))) {
    throw new TypeError("effectiveFrom must use YYYY-MM-DD");
  }
  const sourceIds = new Set();
  for (const document of array(value.sourceDocuments)) {
    required(document.sourceId, "sourceDocuments.sourceId");
    if (sourceIds.has(document.sourceId)) {
      throw new TypeError(`duplicate source document: ${document.sourceId}`);
    }
    sourceIds.add(document.sourceId);
    if (!/^https:\/\/(?:www\.)?mhlw\.go\.jp\//u.test(String(document.url || ""))) {
      throw new TypeError(`source URL must be an official MHLW URL: ${document.sourceId}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(document.sha256 || ""))) {
      throw new TypeError(`source sha256 is invalid: ${document.sourceId}`);
    }
  }

  const requirementCodes = new Set();
  for (const requirement of array(value.facilityStandardRequirements)) {
    const code = required(requirement.code, "facilityStandardRequirements.code");
    if (requirementCodes.has(code)) {
      throw new TypeError(`duplicate facility requirement code: ${code}`);
    }
    requirementCodes.add(code);
    if (!array(requirement.requiredAllOf).length) {
      throw new TypeError(`facility requirement has no required keys: ${code}`);
    }
    validateSourceRef(requirement.sourceRef, sourceIds, `facility requirement ${code}`);
  }

  const familyIds = new Set();
  for (const family of array(value.variantFamilies)) {
    const familyId = required(family.familyId, "variantFamilies.familyId");
    if (familyIds.has(familyId)) {
      throw new TypeError(`duplicate variant family: ${familyId}`);
    }
    familyIds.add(familyId);
    if (family.selectionMode !== "choose_one" || family.mutuallyExclusive !== true) {
      throw new TypeError(`variant family must be mutually-exclusive choose_one: ${familyId}`);
    }
    const codes = new Set(array(family.codes).map((code) => required(code, `${familyId}.codes`)));
    if (codes.size < 2) {
      throw new TypeError(`variant family requires at least two distinct codes: ${familyId}`);
    }
    validateSourceRef(family.sourceRef, sourceIds, `variant family ${familyId}`);
  }

  const bundlingRuleIds = new Set();
  for (const rule of array(value.bundlingRules)) {
    const ruleId = required(rule.ruleId, "bundlingRules.ruleId");
    if (bundlingRuleIds.has(ruleId)) {
      throw new TypeError(`duplicate bundling rule: ${ruleId}`);
    }
    bundlingRuleIds.add(ruleId);
    const managementCodes = new Set(
      array(rule.managementCodes).map((code) => required(code, `${ruleId}.managementCodes`))
    );
    const includedCodes = new Set(
      array(rule.includedProcedureCodes)
        .map((code) => required(code, `${ruleId}.includedProcedureCodes`))
    );
    if (!managementCodes.size || !includedCodes.size) {
      throw new TypeError(`${ruleId} requires management and included procedure codes`);
    }
    if (rule.scope !== "same_month") {
      throw new TypeError(`${ruleId}.scope must be same_month`);
    }
    validateSourceRef(rule.sourceRef, sourceIds, `bundling rule ${ruleId}`);
  }
}

function validateSourceRef(sourceRef, sourceIds, label) {
  if (!sourceIds.has(String(sourceRef?.sourceId || ""))) {
    throw new TypeError(`${label} references an unknown source`);
  }
  required(sourceRef?.section, `${label}.sourceRef.section`);
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
