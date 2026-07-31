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
  const apply = (axis, value, label, evidenceLabel, evidenceSource, { record = true } = {}) => {
    if (value === null || value === undefined || contextConflict) return false;
    const next = remaining.filter((option) => axisMatches(option.axes?.[axis], value));
    if (!next.length) {
      contextConflict = { axis, label, evidenceLabel, evidenceSource };
      return false;
    }
    remaining = next;
    if (record) appliedFilters.push({ axis, label, evidenceLabel, evidenceSource });
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

  const patientCount = finitePositiveInteger(context.singleBuildingPatientCount);
  apply(
    "patientCount",
    patientCount === null ? null : { count: patientCount },
    "単一建物人数",
    patientCount === null ? null : `単一建物${patientCount}名`,
    "screen.singleBuildingPatientCount"
  );
  const monthlyCount = finitePositiveInteger(context.currentMonthEncounterCount);
  apply(
    "monthlyVisits",
    monthlyCount === null ? null : (monthlyCount >= 2 ? "two_or_more" : "one"),
    "当月訪問回数",
    monthlyCount === null ? null : `当月${monthlyCount}回訪問`,
    "calendar.currentMonthEncounterCount"
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

  const specialDiseaseStatus = String(context.specialDiseaseStatus || "unknown");
  apply(
    "specialDisease",
    specialDiseaseStatus === "eligible" ? true : specialDiseaseStatus === "not_eligible" ? false : null,
    "疾病等区分",
    specialDiseaseStatus === "eligible" ? "対象疾病等" : specialDiseaseStatus === "not_eligible" ? "対象外" : null,
    "diagnosis.specialDiseaseTable"
  );

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
