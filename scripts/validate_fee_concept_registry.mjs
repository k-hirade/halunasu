import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const registryPath = path.join(repoRoot, "services/fee-api/src/clinical-concept-registry.json");

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const errors = [];
const warnings = [];

validateVersion(registry);
validateDefinitions("labConcepts", registry.labConcepts, ["key", "name", "query", "pattern"]);
validateDefinitions("labConceptGroups", registry.labConceptGroups, ["key", "name", "pattern"]);
validateDefinitions("procedureChecklist", registry.procedureChecklist, ["key", "label", "query", "pattern"]);
validateDefinitions("reviewOnlyDomains", registry.reviewOnlyDomains, ["domain", "label", "pattern"]);

if (warnings.length) {
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

console.log(`fee concept registry ok: ${registry.version}`);

function validateVersion(value = {}) {
  const version = String(value.version || "").trim();
  if (!/^fee-concept-registry-v\d+(?:[._-][0-9A-Za-z]+)?$/.test(version)) {
    errors.push("version must look like fee-concept-registry-v1");
  }
}

function validateDefinitions(section, items, requiredFields = []) {
  if (!Array.isArray(items)) {
    errors.push(`${section} must be an array`);
    return;
  }
  const seenKeys = new Set();
  for (const [index, item] of items.entries()) {
    const label = `${section}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const stableKey = String(item.key || item.domain || "").trim();
    if (!stableKey) {
      errors.push(`${label} must have key or domain`);
    } else if (seenKeys.has(stableKey)) {
      errors.push(`${label} duplicates key/domain ${stableKey}`);
    } else {
      seenKeys.add(stableKey);
    }
    for (const field of requiredFields) {
      if (!String(item[field] || "").trim()) {
        errors.push(`${label}.${field} is required`);
      }
    }
    validatePattern(`${label}.pattern`, item.pattern);
    validateStringArray(`${label}.aliases`, item.aliases, { optional: true });
    validateStringArray(`${label}.matchTerms`, item.matchTerms, { optional: true });
    validateNoBillingSystemPhrases(label, [
      item.name,
      item.label,
      item.query,
      ...asArray(item.aliases),
      ...asArray(item.matchTerms)
    ]);
  }
}

function validatePattern(label, pattern) {
  const source = String(pattern || "").trim();
  if (!source) {
    return;
  }
  try {
    new RegExp(source, "u");
  } catch (error) {
    errors.push(`${label} is invalid RegExp: ${error.message}`);
  }
}

function validateStringArray(label, values, { optional = false } = {}) {
  if (values == null && optional) {
    return;
  }
  if (!Array.isArray(values)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const [index, value] of values.entries()) {
    if (!String(value || "").trim()) {
      errors.push(`${label}[${index}] must be a non-empty string`);
    }
  }
}

function validateNoBillingSystemPhrases(label, values = []) {
  const systemPhrasePattern = /自動確定|算定候補|会計前に確認|請求候補|算定へ反映|算定に反映/u;
  for (const value of values) {
    if (systemPhrasePattern.test(String(value || ""))) {
      errors.push(`${label} contains billing-system phrase: ${value}`);
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
