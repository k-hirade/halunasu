import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ARTIFACT_URL = new URL(
  "./fee-rule-data/c002-special-disease-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const DESIGNATED_DISEASE_TERMS = ARTIFACT.designatedDiseases.flatMap((entry) => (
  diseaseMatchTerms(entry.name).map((term) => ({
    term,
    ruleId: `designated_disease_${entry.noticeNumber}`,
    label: entry.name,
    noticeNumber: entry.noticeNumber
  }))
));

export function c002SpecialDiseaseArtifactMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256,
    designatedDiseaseCount: ARTIFACT.designatedDiseases.length
  };
}

export function resolveC002SpecialDiseaseStatus({
  problems = [],
  problemsCompleteness = "unknown",
  devices = [],
  stateTexts = [],
  stateCompleteness = "unknown",
  serviceDate = null
} = {}) {
  const artifact = c002SpecialDiseaseArtifactMetadata();
  const provenance = {
    source: "feeRule.c002SpecialDisease.r8",
    sourceRevision: artifact.artifactPayloadSha256
  };
  if (!artifactAppliesOnServiceDate(artifact, serviceDate)) {
    return unresolved(
      "c002_artifact_not_effective_on_service_date",
      artifact,
      problemsCompleteness,
      stateCompleteness
    );
  }

  const problemRows = asArray(problems);
  const hasFutureProblem = problemRows.some((problem) => (
    problemStartsAfterServiceDate(problem, serviceDate)
  ));
  const relevantProblems = problemRows.filter((problem) => (
    !problemStartsAfterServiceDate(problem, serviceDate)
  ));
  const activeProblems = relevantProblems.filter((problem) => activeProblem(problem, serviceDate));
  const effectiveProblemsCompleteness = problemsCompleteness === "complete"
    && !hasFutureProblem
    && !relevantProblems.some((problem) => uncertainProblem(problem, serviceDate))
    ? "complete"
    : normalizedCompleteness(problemsCompleteness) === "complete"
      ? "incomplete"
      : normalizedCompleteness(problemsCompleteness);
  const problemTexts = activeProblems.map((problem) => normalizedText(problem.name)).filter(Boolean);
  const allStateTexts = [
    ...problemTexts,
    ...asArray(stateTexts).map(normalizedText).filter(Boolean)
  ];
  const deviceTypes = new Set(asArray(devices).map((device) => String(device?.type || "")).filter(Boolean));
  const evidence = [];

  for (const rule of asArray(ARTIFACT.directDiseaseRules)) {
    const matchedText = problemTexts.find((text) => ruleMatchesText(rule, text));
    if (matchedText) evidence.push(ruleEvidence(rule, "problem", matchedText));
  }
  for (const text of problemTexts) {
    const match = DESIGNATED_DISEASE_TERMS.find((entry) => designatedDiseaseMatchesText(text, entry.term));
    if (match) {
      evidence.push({
        ruleId: match.ruleId,
        label: match.label,
        source: "problems.designatedDisease",
        matchedText: text,
        noticeNumber: match.noticeNumber
      });
    }
  }
  for (const rule of asArray(ARTIFACT.stateRules)) {
    const matchedDeviceType = asArray(rule.deviceTypes).find((type) => deviceTypes.has(type));
    const matchedTexts = currentStateRuleMatchingTexts(rule, allStateTexts);
    const matchedText = matchedTexts.join(" / ") || null;
    if (matchedDeviceType || matchedText) {
      evidence.push({
        ruleId: rule.ruleId,
        label: rule.label,
        source: matchedDeviceType ? "currentChart.devices" : "problemsOrStateText",
        matchedDeviceType: matchedDeviceType || null,
        matchedText: matchedText || null
      });
    }
  }

  if (evidence.length) {
    return {
      value: "eligible",
      status: "known",
      reason: "positive_c002_table_8_2_evidence",
      evidence: uniqueEvidence(evidence),
      completeness: {
        problems: effectiveProblemsCompleteness,
        states: normalizedCompleteness(stateCompleteness)
      },
      artifact,
      ...provenance
    };
  }
  if (effectiveProblemsCompleteness === "complete" && stateCompleteness === "complete") {
    return {
      value: "not_eligible",
      status: "known",
      reason: "complete_sources_without_c002_table_8_2_match",
      evidence: [],
      completeness: { problems: "complete", states: "complete" },
      artifact,
      ...provenance
    };
  }
  return unresolved(
    "incomplete_c002_table_8_2_sources",
    artifact,
    effectiveProblemsCompleteness,
    stateCompleteness
  );
}

function unresolved(reason, artifact, problemsCompleteness, stateCompleteness) {
  return {
    value: "unknown",
    status: "unknown",
    reason,
    evidence: [],
    completeness: {
      problems: normalizedCompleteness(problemsCompleteness),
      states: normalizedCompleteness(stateCompleteness)
    },
    artifact,
    source: "feeRule.c002SpecialDisease.r8",
    sourceRevision: artifact.artifactPayloadSha256
  };
}

function activeProblem(problem, serviceDate) {
  if (!problem || typeof problem !== "object" || problem.suspected === true) return false;
  const status = String(problem.activeStatus || problem.status || "active");
  if (status !== "active") return false;
  return !isIsoDate(serviceDate)
    || (isIsoDate(problem.startDate) && String(problem.startDate) <= String(serviceDate));
}

function uncertainProblem(problem, serviceDate) {
  if (!problem || typeof problem !== "object") return true;
  if (problem.suspected === true) return true;
  const status = String(problem.activeStatus || problem.status || "active");
  if (!isIsoDate(serviceDate)) return !["active", "inactive"].includes(status);
  if (status !== "active") return true;
  return !isIsoDate(problem.startDate);
}

function problemStartsAfterServiceDate(problem, serviceDate) {
  return isIsoDate(serviceDate)
    && isIsoDate(problem?.startDate)
    && String(problem.startDate) > String(serviceDate);
}

function ruleMatchesText(rule, text) {
  const normalized = normalizedText(text);
  if (!normalized) return false;
  const anyTerms = asArray(rule.anyTerms);
  if (anyTerms.some((term) => includesTerm(normalized, term))) return true;
  const groups = asArray(rule.allTermGroups);
  return groups.length > 0 && groups.every((group) => (
    asArray(group).some((term) => includesTerm(normalized, term))
  ));
}

function designatedDiseaseMatchesText(text, term) {
  const normalized = normalizedText(text);
  const normalizedTerm = normalizedText(term);
  if (!normalized || !normalizedTerm || !normalized.startsWith(normalizedTerm)) return false;
  const suffix = normalized.slice(normalizedTerm.length);
  return suffix === "" || /^(?:\([^()]+\))+$/u.test(suffix);
}

function currentStateRuleMatchesText(rule, text) {
  const normalized = normalizedText(text);
  if (!normalized) return false;
  const anyTerms = asArray(rule.anyTerms);
  if (anyTerms.some((term) => hasCurrentTermOccurrence(normalized, term))) return true;
  const groups = asArray(rule.allTermGroups);
  return groups.length > 0 && groups.every((group) => (
    asArray(group).some((term) => hasCurrentTermOccurrence(normalized, term))
  ));
}

function currentStateRuleMatchingTexts(rule, texts = []) {
  const normalizedTexts = asArray(texts).map(normalizedText).filter(Boolean);
  const anyTerms = asArray(rule.anyTerms);
  const anyMatch = normalizedTexts.find((text) => (
    anyTerms.some((term) => hasCurrentTermOccurrence(text, term))
  ));
  if (anyMatch) {
    return [anyMatch];
  }
  const groups = asArray(rule.allTermGroups);
  if (!groups.length) {
    return [];
  }
  const groupMatches = groups.map((group) => normalizedTexts.find((text) => (
    asArray(group).some((term) => hasCurrentTermOccurrence(text, term))
  )) || null);
  return groupMatches.every(Boolean) ? [...new Set(groupMatches)] : [];
}

function hasCurrentTermOccurrence(text, term) {
  const normalizedTerm = normalizedText(term);
  if (!normalizedTerm) return false;
  let offset = text.indexOf(normalizedTerm);
  while (offset >= 0) {
    if (!hasNonCurrentStateQualifier(text, offset, normalizedTerm.length)) return true;
    offset = text.indexOf(normalizedTerm, offset + normalizedTerm.length);
  }
  return false;
}

function hasNonCurrentStateQualifier(text, offset, termLength) {
  const marker = "(?:未実施|中止|終了|抜去|離脱|検討|予定|なし)";
  const separator = "(?:[()\\[\\]{}・:：、,，。/\\-]|は|を|が|の|から|へ|導入|実施|使用|施行|投与|装着|留置|造設|開始)";
  const before = text.slice(Math.max(0, offset - 18), offset);
  const after = text.slice(offset + termLength, offset + termLength + 18);
  return new RegExp(`^${separator}{0,6}${marker}`, "u").test(after)
    || new RegExp(`${marker}(?:済み|済|中|後|した|している|していた)?${separator}{0,6}$`, "u").test(before);
}

function ruleEvidence(rule, source, matchedText) {
  return {
    ruleId: rule.ruleId,
    label: rule.label,
    source,
    matchedText
  };
}

function diseaseMatchTerms(value) {
  const normalized = normalizedText(value);
  return [...new Set([
    normalized,
    ...normalized.split(/[\uFF0F/]/u).map((part) => part.trim())
  ].filter((term) => term.length >= 3))];
}

function includesTerm(text, term) {
  return normalizedText(text).includes(normalizedText(term));
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((entry) => {
    const key = `${entry.ruleId}:${entry.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedCompleteness(value) {
  return ["complete", "incomplete", "unavailable"].includes(value) ? value : "unknown";
}

function artifactAppliesOnServiceDate(artifact, serviceDate) {
  if (!isIsoDate(serviceDate)) return true;
  if (isIsoDate(artifact?.effectiveFrom) && serviceDate < artifact.effectiveFrom) return false;
  return !isIsoDate(artifact?.effectiveTo) || serviceDate <= artifact.effectiveTo;
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

function assertArtifactIntegrity(artifact) {
  if (artifact?.schemaVersion !== "fee-c002-special-disease-v1") {
    throw new Error("unsupported C002 special-disease artifact schema");
  }
  const { artifactPayloadSha256, ...payload } = artifact;
  const actual = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (!artifactPayloadSha256 || actual !== artifactPayloadSha256) {
    throw new Error("C002 special-disease artifact checksum mismatch");
  }
  if (asArray(artifact.designatedDiseases).length !== 348) {
    throw new Error("incomplete C002 designated-disease artifact");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
