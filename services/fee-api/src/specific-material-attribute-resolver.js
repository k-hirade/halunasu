import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CATEGORY_SAFE_ID_PATTERN = /^[a-z0-9_]+$/u;
const ARTIFACT_URL = new URL(
  "./fee-rule-data/specific-material-classification-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const CATEGORY_BY_ID = new Map(
  asArray(ARTIFACT.categories).map((category) => [category.categoryId, category])
);

export function specificMaterialClassificationMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256
  };
}

export function resolveSpecificMaterialAttributes({
  event = {},
  structuredSourceFacts = null,
  serviceDate = ""
} = {}) {
  const text = materialEvidenceText(event);
  const category = identifyMaterialCategory(text);
  if (!category) {
    return {
      status: "unconfigured",
      categoryId: null,
      attributes: {},
      candidates: [],
      reasonCode: "material_category_not_configured",
      metadata: specificMaterialClassificationMetadata()
    };
  }

  const extracted = extractCategoryAttributes(category, text);
  const deviceAttributes = sourceDeviceAttributes(category, structuredSourceFacts);
  const merged = mergeKnownAttributes(extracted.attributes, deviceAttributes);
  if (extracted.conflicts.length || merged.conflicts.length) {
    return materialResolutionResult({
      status: "ambiguous",
      category,
      attributes: merged.attributes,
      candidates: activeCandidates(category.candidates, serviceDate),
      reasonCode: "conflicting_material_attributes",
      conflicts: [...extracted.conflicts, ...merged.conflicts]
    });
  }

  const active = activeCandidates(category.candidates, serviceDate);
  const exactNameCandidates = exactNameMatches(active, event);
  let candidates = exactNameCandidates.length ? exactNameCandidates : active;
  candidates = filterCandidatesByAttributes(candidates, merged.attributes);
  candidates = filterCandidatesByNotificationTable(
    candidates,
    notificationTableHint(event, text)
  );

  if (candidates.length === 1) {
    return materialResolutionResult({
      status: "exact",
      category,
      attributes: merged.attributes,
      candidates,
      reasonCode: "material_code_resolved"
    });
  }
  if (!candidates.length) {
    return materialResolutionResult({
      status: "insufficient",
      category,
      attributes: merged.attributes,
      candidates: [],
      reasonCode: "material_attributes_do_not_match_master"
    });
  }

  const hasUsefulEvidence = (
    exactNameCandidates.length > 0
    || Object.keys(merged.attributes).length > 0
    || notificationTableHint(event, text) !== null
  );
  return materialResolutionResult({
    status: hasUsefulEvidence ? "ambiguous" : "insufficient",
    category,
    attributes: merged.attributes,
    candidates,
    reasonCode: hasUsefulEvidence
      ? "multiple_material_codes_remain"
      : "material_attributes_missing"
  });
}

function materialResolutionResult({
  status,
  category,
  attributes,
  candidates,
  reasonCode,
  conflicts = []
}) {
  return {
    status,
    categoryId: category.categoryId,
    categoryName: category.displayName,
    attributes,
    candidates: asArray(candidates).map(publicCandidate),
    reasonCode,
    conflicts,
    metadata: specificMaterialClassificationMetadata()
  };
}

function publicCandidate(candidate = {}) {
  return {
    code: String(candidate.code || ""),
    name: String(candidate.name || ""),
    unitName: String(candidate.unitName || ""),
    unitAmountYen: finiteNumberOrNull(candidate.unitAmountYen),
    points: materialPoints(candidate.unitAmountYen),
    effectiveFrom: nullableString(candidate.effectiveFrom),
    effectiveTo: nullableString(candidate.effectiveTo),
    sourceVersion: nullableString(candidate.sourceVersion),
    notificationTableNumber: nullableString(candidate.notificationTableNumber),
    notificationSectionNumber: nullableString(candidate.notificationSectionNumber),
    attributes: isPlainObject(candidate.attributes) ? candidate.attributes : {}
  };
}

function identifyMaterialCategory(text) {
  const normalized = normalizeMaterialText(text);
  const matches = asArray(ARTIFACT.categories).filter((category) => (
    asArray(category.inputCategoryPatterns).some((pattern) => (
      normalized.includes(normalizeMaterialText(pattern))
    ))
  ));
  return matches.length === 1 ? matches[0] : null;
}

function extractCategoryAttributes(category, text) {
  const normalized = normalizeMaterialText(text);
  const attributes = {};
  const conflicts = [];
  for (const axis of asArray(category.attributeAxes)) {
    const values = asArray(axis.values)
      .filter((definition) => (
        asArray(definition.inputPatterns).some((pattern) => (
          normalized.includes(normalizeMaterialText(pattern))
        ))
      ))
      .map((definition) => definition.value);
    const uniqueValues = uniqueJsonValues(values);
    if (uniqueValues.length === 1) {
      attributes[axis.key] = uniqueValues[0];
    } else if (uniqueValues.length > 1) {
      conflicts.push({
        key: axis.key,
        values: uniqueValues,
        source: "clinical_event"
      });
    }
  }
  return { attributes, conflicts };
}

function sourceDeviceAttributes(category, structuredSourceFacts) {
  const source = isPlainObject(structuredSourceFacts) ? structuredSourceFacts : {};
  const allowedTypes = new Set(asArray(category.deviceFactTypes).map(String));
  const matching = asArray(source.devices).filter((device) => (
    allowedTypes.has(String(device?.type || ""))
  ));
  const attributes = {};
  const conflicts = [];
  for (const device of matching) {
    const normalized = normalizeDeviceAttributes(category.categoryId, device?.attributes);
    for (const [key, value] of Object.entries(normalized)) {
      if (value === null || value === undefined || value === "") {
        continue;
      }
      if (Object.hasOwn(attributes, key) && !sameJsonValue(attributes[key], value)) {
        conflicts.push({
          key,
          values: uniqueJsonValues([attributes[key], value]),
          source: "structured_device_facts"
        });
        continue;
      }
      attributes[key] = value;
    }
  }
  return { attributes, conflicts };
}

function normalizeDeviceAttributes(categoryId, value) {
  const attributes = isPlainObject(value) ? value : {};
  if (categoryId === "tracheostomy_tube") {
    return compactObject({
      purpose: attributes.purpose,
      cuffed: nullableBoolean(attributes.cuffed),
      suctionEnabled: nullableBoolean(attributes.suctionEnabled),
      tubeStructure: attributes.tubeStructure
        || (attributes.doubleTube === true
          ? "double"
          : attributes.doubleTube === false ? "single" : null)
    });
  }
  if (categoryId === "nutrition_disposable_catheter") {
    return compactObject({
      route: attributes.route,
      variant: attributes.variant
    });
  }
  if (categoryId === "urinary_indwelling_catheter") {
    return compactObject({
      variant: attributes.variant,
      system: attributes.system
    });
  }
  if (categoryId === "gastrostomy_replacement_catheter") {
    return compactObject({
      placement: attributes.placement,
      retention: attributes.retention,
      guidewire: nullableBoolean(attributes.guidewire)
    });
  }
  return {};
}

function mergeKnownAttributes(...sources) {
  const attributes = {};
  const conflicts = [];
  for (const sourceValue of sources) {
    const source = isPlainObject(sourceValue?.attributes)
      ? sourceValue.attributes
      : isPlainObject(sourceValue) ? sourceValue : {};
    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined || value === "") {
        continue;
      }
      if (Object.hasOwn(attributes, key) && !sameJsonValue(attributes[key], value)) {
        conflicts.push({
          key,
          values: uniqueJsonValues([attributes[key], value]),
          source: "merged_sources"
        });
        continue;
      }
      attributes[key] = value;
    }
    conflicts.push(...asArray(sourceValue?.conflicts));
  }
  return { attributes, conflicts };
}

function filterCandidatesByAttributes(candidates, attributes) {
  const known = Object.entries(attributes);
  if (!known.length) {
    return candidates;
  }
  return asArray(candidates).filter((candidate) => (
    known.every(([key, value]) => (
      Object.hasOwn(candidate?.attributes || {}, key)
      && sameJsonValue(candidate.attributes[key], value)
    ))
  ));
}

function filterCandidatesByNotificationTable(candidates, hint) {
  if (hint === null) {
    return candidates;
  }
  return asArray(candidates).filter((candidate) => (
    String(candidate.notificationTableNumber || "") === hint
  ));
}

function exactNameMatches(candidates, event) {
  const names = uniqueStrings([
    event?.name,
    event?.event_name,
    event?.eventName,
    event?.material_name,
    event?.materialName
  ]).map(normalizeMaterialText).filter(Boolean);
  if (!names.length) {
    return [];
  }
  return asArray(candidates).filter((candidate) => (
    names.includes(normalizeMaterialText(candidate?.name))
  ));
}

function notificationTableHint(event, text) {
  const supplied = String(
    event?.notification_table_no
    || event?.notificationTableNumber
    || event?.material_notification_table_no
    || event?.materialNotificationTableNumber
    || ""
  ).trim();
  if (["1", "2"].includes(supplied)) {
    return supplied;
  }
  const normalized = normalizeMaterialText(text);
  if (normalized.includes("（在宅）") || /材料価格基準(?:別表)?Ⅰ/u.test(text)) {
    return "1";
  }
  if (/材料価格基準(?:別表)?Ⅱ/u.test(text)) {
    return "2";
  }
  return null;
}

function activeCandidates(candidates, serviceDate) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(String(serviceDate || ""))
    ? String(serviceDate)
    : null;
  if (!date) {
    return asArray(candidates);
  }
  return asArray(candidates).filter((candidate) => (
    (!candidate.effectiveFrom || candidate.effectiveFrom <= date)
    && (!candidate.effectiveTo || candidate.effectiveTo >= date)
  ));
}

function materialEvidenceText(event) {
  return [
    event?.name,
    event?.event_name,
    event?.eventName,
    event?.material_name,
    event?.materialName,
    event?.evidence,
    event?.evidence_text,
    event?.evidenceText,
    event?.body_site,
    event?.bodySite,
    JSON.stringify(event?.material_attributes || event?.materialAttributes || {})
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
}

function materialPoints(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount / 10) : 0;
}

function normalizeMaterialText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/\(/gu, "（")
    .replace(/\)/gu, "）")
    .toUpperCase();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    item !== null && item !== undefined && item !== ""
  )));
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueJsonValues(values) {
  const byJson = new Map();
  for (const value of asArray(values)) {
    byJson.set(JSON.stringify(value), value);
  }
  return [...byJson.values()];
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertArtifactIntegrity(value) {
  if (value?.schemaVersion !== "fee-specific-material-classification-artifact-v1") {
    throw new TypeError("unsupported specific material classification artifact");
  }
  const { artifactPayloadSha256, ...payload } = value;
  const actual = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(String(artifactPayloadSha256 || "")) || actual !== artifactPayloadSha256) {
    throw new TypeError("specific material classification artifact integrity check failed");
  }
  for (const category of asArray(value.categories)) {
    if (!CATEGORY_SAFE_ID_PATTERN.test(String(category?.categoryId || ""))) {
      throw new TypeError("specific material category id is invalid");
    }
    if (!asArray(category?.candidates).length) {
      throw new TypeError(`specific material category has no candidates: ${category?.categoryId}`);
    }
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Kept for diagnostics and future category-specific policy lookups.
export function specificMaterialCategory(categoryId) {
  return CATEGORY_BY_ID.get(String(categoryId || "")) || null;
}
