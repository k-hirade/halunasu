import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ARTIFACT_URL = new URL(
  "./fee-rule-data/sidecar-selection-axes-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const OPTION_BY_CODE = new Map(
  asArray(ARTIFACT.options).map((option) => [String(option.code), option])
);

export function sidecarSelectionArtifactMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256,
    procedureChecksum: ARTIFACT.masterSource?.procedureChecksum || null,
    frequencyChecksum: ARTIFACT.masterSource?.frequencyChecksum || null
  };
}

export function narrowSidecarCandidateSelection(candidate = {}, context = {}) {
  const candidateCodes = uniqueStrings(candidate.codeCandidates);
  if (!candidateCodes.length) return null;
  const options = candidateCodes.map((code) => OPTION_BY_CODE.get(code)).filter(Boolean);
  if (!options.length || options.length !== candidateCodes.length) {
    return unresolvedSelection(candidateCodes.length, "selection_artifact_incomplete");
  }

  let remaining = options;
  const appliedFilters = [];
  let contextConflict = null;
  const apply = (axis, value, label, evidenceLabel, evidenceSource, {
    record = true,
    evidenceStatus = null,
    sourceRevision = null,
    observedAt = null,
    evidenceValue = null,
    completeness = null,
    artifactRevision = null,
    artifactPayloadSha256 = null
  } = {}) => {
    if (value === null || value === undefined || contextConflict) return false;
    const next = remaining.filter((option) => axisMatches(option.axes?.[axis], value));
    if (!next.length) {
      contextConflict = { axis, label, evidenceLabel, evidenceSource };
      return false;
    }
    remaining = next;
    if (record) appliedFilters.push({
      axis,
      label,
      evidenceLabel,
      evidenceSource,
      ...(evidenceStatus ? { evidenceStatus } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(evidenceValue !== null && evidenceValue !== undefined ? { value: evidenceValue } : {}),
      ...(completeness ? { completeness } : {}),
      ...(artifactRevision ? { artifactRevision } : {}),
      ...(artifactPayloadSha256 ? { artifactPayloadSha256 } : {})
    });
    return true;
  };

  const facilityClass = facilityClassFromContext(context);
  const bed = bedStatusFromContext(context);
  const facilityEvidence = [];
  const facilitySources = [];
  if (apply("facilityClass", facilityClass?.value, "施設類型", facilityClass?.label, facilityClass?.source, { record: false })) {
    facilityEvidence.push(facilityClass.label);
    facilitySources.push(facilityClass.source);
  }
  if (apply("bed", bed?.value, "病床", bed?.label, bed?.source, { record: false })) {
    facilityEvidence.push(bed.label);
    facilitySources.push(bed.source);
  }
  if (facilityEvidence.length) {
    appliedFilters.push({
      axis: "facilityProfile",
      label: "施設類型",
      evidenceLabel: facilityEvidence.join("・"),
      evidenceSource: facilitySources.join(",")
    });
  }

  const patientCountFact = normalizedEvidenceFact(
    context.selection?.singleBuildingPatientCount ?? context.singleBuildingPatientCount,
    "screen.singleBuildingPatientCount"
  );
  const patientCount = trustedPositiveInteger(patientCountFact);
  apply(
    "patientCount",
    patientCount === null ? null : { count: patientCount },
    "単一建物人数",
    patientCount === null ? null : `単一建物${patientCount}名`,
    patientCountFact.source,
    {
      evidenceStatus: patientCountFact.status,
      sourceRevision: patientCountFact.sourceRevision,
      observedAt: patientCountFact.observedAt,
      evidenceValue: patientCount,
      completeness: patientCountFact.completeness
    }
  );
  const monthlyVisitFact = normalizedEvidenceFact(
    context.selection?.qualifyingMonthlyVisits
      ?? context.qualifyingMonthlyVisits
      ?? context.currentMonthEncounterCount,
    "calendar.currentMonthEncounterCount"
  );
  const monthlyCount = trustedPositiveInteger(monthlyVisitFact);
  const monthlyVisitAxis = monthlyCount === null ? null : (monthlyCount >= 2 ? "two_or_more" : "one");
  apply(
    "monthlyVisits",
    monthlyVisitAxis,
    "当月訪問回数",
    monthlyCount === null ? null : `当月${monthlyCount}回訪問`,
    monthlyVisitFact.source,
    {
      evidenceStatus: monthlyVisitFact.status,
      sourceRevision: monthlyVisitFact.sourceRevision,
      observedAt: monthlyVisitFact.observedAt,
      evidenceValue: monthlyCount,
      completeness: monthlyVisitFact.completeness
    }
  );

  const setting = String(context.setting || "");
  const telemedicine = setting === "telephone_revisit"
    ? true
    : ["home_visit", "house_call", "outpatient"].includes(setting)
      ? false
      : null;
  apply(
    "telemedicine",
    telemedicine,
    "診療方法",
    telemedicine === null ? null : telemedicine ? "情報通信機器" : "対面診療",
    "encounter.setting"
  );

  const specialDiseaseFact = normalizedEvidenceFact(
    context.selection?.specialDisease ?? context.specialDisease ?? context.specialDiseaseStatus,
    "diagnosis.specialDiseaseTable"
  );
  const specialDiseaseStatus = trustedEnum(specialDiseaseFact, ["eligible", "not_eligible"]);
  // C002/C002-2 has no separate disease branch when the qualifying monthly visit count is one.
  if (monthlyVisitAxis === "two_or_more") {
    apply(
      "specialDisease",
      specialDiseaseStatus === "eligible" ? true : specialDiseaseStatus === "not_eligible" ? false : null,
      "疾病等区分",
      specialDiseaseStatus === "eligible" ? "対象疾病等" : specialDiseaseStatus === "not_eligible" ? "対象外" : null,
      specialDiseaseFact.source,
      {
        evidenceStatus: specialDiseaseFact.status,
        sourceRevision: specialDiseaseFact.sourceRevision,
        observedAt: specialDiseaseFact.observedAt,
        evidenceValue: specialDiseaseStatus,
        completeness: specialDiseaseFact.completeness,
        artifactRevision: specialDiseaseFact.artifactRevision,
        artifactPayloadSha256: specialDiseaseFact.artifactPayloadSha256
      }
    );
  }

  for (const [axis, label, contextKey] of [
    ["reduced", "減算区分", "reduced"],
    ["specialProvision", "特例区分", "specialProvision"]
  ]) {
    const fact = normalizedEvidenceFact(context.selection?.[contextKey] ?? context[contextKey], `selection.${contextKey}`);
    const value = trustedBoolean(fact);
    apply(
      axis,
      value,
      label,
      value === null ? null : value ? "該当" : "非該当",
      fact.source,
      {
        evidenceStatus: fact.status,
        sourceRevision: fact.sourceRevision,
        observedAt: fact.observedAt,
        evidenceValue: value,
        completeness: fact.completeness
      }
    );
  }

  if (contextConflict) {
    return {
      ...unresolvedSelection(candidateCodes.length, "selection_context_conflict"),
      appliedFilters,
      conflict: contextConflict
    };
  }

  const unresolvedAxes = varyingAxes(remaining);
  const primaryQuestion = unresolvedAxes
    .map((axis) => ARTIFACT.axisQuestions?.[axis])
    .find(Boolean) || "残る算定区分をHOMISで確認してください";
  const points = remaining.map((option) => Number(option.points || 0)).filter(Number.isFinite);
  return {
    selectionResolution: remaining.length === 1 ? "exact" : appliedFilters.length ? "ambiguous" : "insufficient",
    appliedFilters,
    remainingOptions: remaining.map((option) => ({
      code: option.code,
      qualifierLabel: option.qualifierLabel,
      points: Number(option.points || 0),
      axisQuestion: primaryQuestion
    })),
    remainingOptionCount: remaining.length,
    unresolvedAxes,
    pointRange: points.length ? { min: Math.min(...points), max: Math.max(...points) } : null,
    artifact: sidecarSelectionArtifactMetadata(),
    reason: null
  };
}

function unresolvedSelection(count, reason) {
  return {
    selectionResolution: "insufficient",
    appliedFilters: [],
    remainingOptions: [],
    remainingOptionCount: count,
    unresolvedAxes: [],
    pointRange: null,
    artifact: sidecarSelectionArtifactMetadata(),
    reason
  };
}

function facilityClassFromContext(context = {}) {
  const keys = new Set(uniqueStrings(context.facilityStandardKeys));
  for (const rule of asArray(ARTIFACT.facilityClassRules)) {
    const matched = asArray(rule.requiredAnyStandardKeys).find((key) => keys.has(String(key)));
    if (matched) return { value: rule.value, label: rule.label, source: `facilityStandard:${matched}` };
  }
  return null;
}

function bedStatusFromContext(context = {}) {
  const keys = new Set(uniqueStrings(context.facilityStandardKeys));
  for (const rule of asArray(ARTIFACT.bedRules)) {
    const matched = asArray(rule.requiredAnyStandardKeys).find((key) => keys.has(String(key)));
    if (matched) return { value: rule.value, label: rule.label, source: `facilityStandard:${matched}` };
  }
  return null;
}

function axisMatches(actual, expected) {
  if (expected && typeof expected === "object" && Number.isFinite(expected.count)) {
    const minimum = Number(actual?.min);
    const maximum = actual?.max === null ? Number.POSITIVE_INFINITY : Number(actual?.max);
    return Number.isFinite(minimum) && expected.count >= minimum && expected.count <= maximum;
  }
  return actual === expected;
}

function varyingAxes(options = []) {
  return [
    "facilityClass", "bed", "patientCount", "monthlyVisits",
    "telemedicine", "specialDisease", "reduced", "specialProvision"
  ].filter((axis) => new Set(options.map((option) => canonicalJson(option.axes?.[axis]))).size > 1);
}

function finitePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizedEvidenceFact(value, fallbackSource) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      value: value.value ?? null,
      status: String(value.status || "unknown"),
      source: String(value.source || fallbackSource),
      sourceRevision: value.sourceRevision || value.artifact?.artifactPayloadSha256 || null,
      observedAt: validIsoTimestamp(value.observedAt),
      completeness: normalizedEvidenceCompleteness(value.completeness ?? value.status),
      artifactRevision: normalizedOptionalString(value.artifact?.revision),
      artifactPayloadSha256: normalizedSha256(value.artifact?.artifactPayloadSha256)
    };
  }
  return {
    value: value ?? null,
    status: value === null || value === undefined || value === "unknown" ? "unknown" : "known",
    source: fallbackSource,
    sourceRevision: null,
    observedAt: null,
    completeness: null,
    artifactRevision: null,
    artifactPayloadSha256: null
  };
}

function factIsTrusted(fact) {
  return ["known", "complete"].includes(fact.status);
}

function trustedPositiveInteger(fact) {
  return factIsTrusted(fact) ? finitePositiveInteger(fact.value) : null;
}

function trustedEnum(fact, values) {
  return factIsTrusted(fact) && values.includes(fact.value) ? fact.value : null;
}

function trustedBoolean(fact) {
  return factIsTrusted(fact) && typeof fact.value === "boolean" ? fact.value : null;
}

function validIsoTimestamp(value) {
  const timestamp = String(value || "");
  return timestamp.includes("T") && Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : null;
}

function normalizedOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizedSha256(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function normalizedEvidenceCompleteness(value) {
  if (["complete", "incomplete", "unavailable"].includes(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .filter(([, status]) => ["complete", "incomplete", "unavailable", "unknown"].includes(status));
  return entries.length ? Object.fromEntries(entries) : null;
}

function assertArtifactIntegrity(artifact) {
  if (artifact?.schemaVersion !== "fee-sidecar-selection-axes-v1") {
    throw new Error("unsupported sidecar selection artifact schema");
  }
  const { artifactPayloadSha256, ...payload } = artifact;
  const actual = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (!artifactPayloadSha256 || actual !== artifactPayloadSha256) {
    throw new Error("sidecar selection artifact checksum mismatch");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
