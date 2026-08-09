import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const AXIS_ARTIFACT = JSON.parse(readFileSync(
  new URL("./fee-rule-data/sidecar-label-axes-2026.generated.json", import.meta.url),
  "utf8"
));
const AGE_ARTIFACT = JSON.parse(readFileSync(
  new URL("./fee-rule-data/fee-age-constraints-2026.generated.json", import.meta.url),
  "utf8"
));
assertArtifactIntegrity(AXIS_ARTIFACT);
assertArtifactIntegrity(AGE_ARTIFACT);

const AGE_CONSTRAINT_BY_CODE = new Map(
  asArray(AGE_ARTIFACT.constraints).map((entry) => [String(entry.code), entry])
);

export function sidecarLabelAxisArtifactMetadata() {
  return {
    schemaVersion: AXIS_ARTIFACT.schemaVersion,
    revision: AXIS_ARTIFACT.revision,
    effectiveFrom: AXIS_ARTIFACT.effectiveFrom,
    artifactPayloadSha256: AXIS_ARTIFACT.artifactPayloadSha256,
    ageArtifactPayloadSha256: AGE_ARTIFACT.artifactPayloadSha256,
    ageConstraintCount: Number(AGE_ARTIFACT.constraintCount || 0)
  };
}

/**
 * 区分名称から軸を導出して絞り込む。絞り込み用 artifact に収録の無いファミリでも、
 * 名称に現れる語だけで判定できる軸(情報通信機器・初回/2回目以降・親管理料など)を適用する。
 * 事実が無い軸は適用しないので、結果は必ず「絞れた分だけ残る」。
 */
export function narrowSidecarCandidateByLabelAxes(options = [], context = {}) {
  const normalized = asArray(options)
    .map((option) => ({
      code: String(option?.code || "").trim(),
      qualifierLabel: String(option?.qualifierLabel || "").trim(),
      points: Number(option?.points || 0)
    }))
    .filter((option) => option.code && option.qualifierLabel);
  if (normalized.length < 2) {
    return null;
  }

  const classified = normalized.map((option) => ({
    ...option,
    axes: classifyLabelAxes(option.qualifierLabel, normalized)
  }));

  let remaining = classified;
  const appliedFilters = [];
  let conflict = null;

  for (const axis of asArray(AXIS_ARTIFACT.axes)) {
    if (conflict) break;
    const factValue = axis.axisId === "claimSequence"
      ? resolveClaimSequenceFact(normalized, context)
      : resolveAxisFact(axis, context);
    if (factValue === null || factValue === undefined) continue;
    const varying = new Set(remaining.map((option) => canonicalJson(option.axes[axis.axisId]))).size > 1;
    if (!varying) continue;
    const next = remaining.filter((option) => axisValueMatches(
      option.axes[axis.axisId],
      factValue,
      axis.axisId
    ));
    if (!next.length) {
      conflict = { axis: axis.axisId, label: axis.label };
      break;
    }
    remaining = next;
    appliedFilters.push({
      axis: axis.axisId,
      label: axis.label,
      evidenceLabel: axisEvidenceLabel(axis, factValue),
      evidenceSource: `labelAxis.${axis.factKey}`
    });
  }

  const unresolvedAxes = asArray(AXIS_ARTIFACT.axes)
    .map((axis) => axis.axisId)
    .filter((axisId) => (
      new Set(remaining.map((option) => canonicalJson(option.axes[axisId]))).size > 1
    ));
  const question = asArray(AXIS_ARTIFACT.axes)
    .find((axis) => unresolvedAxes.includes(axis.axisId))?.question
    || "算定区分を選択してください";
  const points = remaining.map((option) => option.points).filter(Number.isFinite);

  return {
    selectionResolution: conflict
      ? "insufficient"
      : remaining.length === 1
        ? "exact"
        : appliedFilters.length
          ? "ambiguous"
          : "insufficient",
    appliedFilters,
    remainingOptions: remaining.map((option) => ({
      code: option.code,
      qualifierLabel: option.qualifierLabel,
      points: option.points,
      axisQuestion: question
    })),
    remainingOptionCount: remaining.length,
    unresolvedAxes,
    pointRange: points.length ? { min: Math.min(...points), max: Math.max(...points) } : null,
    artifact: sidecarLabelAxisArtifactMetadata(),
    reason: conflict ? "label_axis_context_conflict" : null,
    ...(conflict ? { conflict } : {})
  };
}

/**
 * 患者年齢が判明している場合に、年齢要件を満たさないコードを弾く。
 * 年齢が不明なとき、及び年齢制約が数値で確定できないコードは弾かない(取りこぼし側に倒す)。
 */
export function excludeCodesOutsideAgeRange(codes = [], patientAgeYears = null) {
  const age = finiteAge(patientAgeYears);
  const normalized = asArray(codes).map((code) => String(code || "").trim()).filter(Boolean);
  if (age === null) {
    return { codes: normalized, excluded: [] };
  }
  const excluded = [];
  const kept = normalized.filter((code) => {
    const constraint = AGE_CONSTRAINT_BY_CODE.get(code);
    if (!constraint) return true;
    if (codeAllowsAge(constraint, age)) return true;
    excluded.push({
      code,
      name: constraint.name || "",
      minAgeYearsInclusive: constraint.minAgeYearsInclusive,
      maxAgeYearsExclusive: constraint.maxAgeYearsExclusive
    });
    return false;
  });
  return { codes: kept, excluded };
}

export function ageConstraintForCode(code = "") {
  return AGE_CONSTRAINT_BY_CODE.get(String(code || "").trim()) || null;
}

export function codeAllowsAge(constraint = {}, patientAgeYears = null) {
  const age = finiteAge(patientAgeYears);
  if (age === null) return true;
  const min = Number.isInteger(constraint.minAgeYearsInclusive) ? constraint.minAgeYearsInclusive : null;
  const max = Number.isInteger(constraint.maxAgeYearsExclusive) ? constraint.maxAgeYearsExclusive : null;
  if (min !== null && age < min) return false;
  if (max !== null && age >= max) return false;
  return true;
}

function classifyLabelAxes(label, siblings = []) {
  const axes = {};
  for (const axis of asArray(AXIS_ARTIFACT.axes)) {
    const matched = asArray(axis.values).find((entry) => (
      asArray(entry.patterns).some((pattern) => label.includes(pattern))
    ));
    if (matched) {
      axes[axis.axisId] = matched.value;
      continue;
    }
    // 同一ファミリ内に軸語を含む区分があるときだけ、含まない区分へ既定値を与える。
    const axisUsedInFamily = siblings.some((sibling) => (
      asArray(axis.values).some((entry) => (
        asArray(entry.patterns).some((pattern) => sibling.qualifierLabel.includes(pattern))
      ))
    ));
    axes[axis.axisId] = axisUsedInFamily && axis.defaultValue !== undefined
      ? axis.defaultValue
      : null;
  }
  return axes;
}

// 初回/2回目以降は「当月に同じファミリのコードを算定済みか」で決まる。
// 履歴が揃っていない月は判定しない(誤って2回目以降を選ばない)。
function resolveClaimSequenceFact(options = [], context = {}) {
  if (context.monthlyClaimHistoryCompleteness !== "complete") {
    return null;
  }
  const claimed = new Set(asArray(context.monthlyClaimedCodes).map((code) => String(code || "").trim()));
  if (!claimed.size) {
    return "first";
  }
  return options.some((option) => claimed.has(option.code)) ? "subsequent" : "first";
}

function resolveAxisFact(axis, context = {}) {
  const value = context?.[axis.factKey];
  if (value === null || value === undefined || value === "") return null;
  if (axis.axisId === "singleBuildingPatientRange") {
    const count = Number(value);
    return Number.isInteger(count) && count > 0 ? count : null;
  }
  return value;
}

function axisValueMatches(optionValue, factValue, axisId) {
  if (optionValue === null || optionValue === undefined) {
    // 区分名から軸を読み取れないものは、その軸では落とさない。
    return true;
  }
  if (axisId === "singleBuildingPatientRange") {
    const min = Number.isInteger(optionValue?.min) ? optionValue.min : null;
    const max = Number.isInteger(optionValue?.max) ? optionValue.max : null;
    if (min !== null && factValue < min) return false;
    if (max !== null && factValue > max) return false;
    return true;
  }
  return canonicalJson(optionValue) === canonicalJson(factValue);
}

function axisEvidenceLabel(axis, factValue) {
  if (axis.axisId === "singleBuildingPatientRange") {
    return `単一建物${factValue}名`;
  }
  const matched = asArray(axis.values).find((entry) => (
    canonicalJson(entry.value) === canonicalJson(factValue)
  ));
  return matched?.optionLabel || String(factValue);
}

function finiteAge(value) {
  const age = Number(value);
  return Number.isInteger(age) && age >= 0 && age <= 130 ? age : null;
}

function assertArtifactIntegrity(artifact) {
  const { artifactPayloadSha256, ...payload } = artifact;
  const digest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (digest !== artifactPayloadSha256) {
    throw new Error(`fee rule artifact payload digest mismatch: ${artifact.schemaVersion}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
