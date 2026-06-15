import { readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync(new URL("./clinical-concept-registry.json", import.meta.url), "utf8"));

export const FEE_CONCEPT_REGISTRY_VERSION = String(registry.version || "fee-concept-registry-unknown");

export const LAB_CONCEPT_DEFINITIONS = freezeDefinitions(registry.labConcepts);

export const LAB_CONCEPT_GROUP_DEFINITIONS = freezeDefinitions(registry.labConceptGroups);

export const PROCEDURE_CHECKLIST_DEFINITIONS = freezeDefinitions(registry.procedureChecklist);

export const REVIEW_ONLY_DOMAIN_CHECKLIST_DEFINITIONS = freezeDefinitions(registry.reviewOnlyDomains);

function freezeDefinitions(items = []) {
  return Object.freeze((Array.isArray(items) ? items : []).map((item) => Object.freeze({
    ...item,
    aliases: Array.isArray(item.aliases) ? Object.freeze([...item.aliases]) : Object.freeze([]),
    matchTerms: Array.isArray(item.matchTerms) ? Object.freeze([...item.matchTerms]) : Object.freeze([]),
    pattern: compileRegistryPattern(item.pattern)
  })));
}

function compileRegistryPattern(pattern) {
  const source = String(pattern || "").trim();
  if (!source) {
    return /$^/u;
  }
  return new RegExp(source, "u");
}
