const BASELINE_SCHEMA_VERSION = "fee-extraction-stability-baseline.v1";

export function candidateKey(item = {}) {
  const code = String(item.code || "").trim();
  const codeCandidates = uniqueStrings(item.codeCandidates).sort();
  const title = normalizeText(item.title);
  return JSON.stringify({ code, codeCandidates, title });
}

export function candidateKeySet(items = []) {
  return new Set((Array.isArray(items) ? items : []).map(candidateKey));
}

export function jaccardSimilarity(leftItems = [], rightItems = []) {
  const left = candidateKeySet(leftItems);
  const right = candidateKeySet(rightItems);
  if (!left.size && !right.size) return 1;
  const intersection = [...left].filter((key) => right.has(key)).length;
  const union = new Set([...left, ...right]).size;
  return round(intersection / union, 6);
}

export function summarizeStabilityCase({
  caseId,
  runs = [],
  minimumCandidateJaccard = null
} = {}) {
  if (!String(caseId || "").trim()) {
    throw new Error("caseId is required");
  }
  if (!Array.isArray(runs) || runs.length < 3) {
    throw new Error("stability evaluation requires at least three runs per case");
  }

  const confirmedPoints = runs.map((run) => finiteNumber(run?.totalPoints));
  const eventCounts = runs.map((run) => nonNegativeInteger(run?.extraction?.clinicalEventCount));
  const candidateCounts = runs.map((run) => candidateKeySet(run?.candidateItems).size);
  const candidatePairs = [];
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      candidatePairs.push({
        leftRun: left + 1,
        rightRun: right + 1,
        jaccard: jaccardSimilarity(runs[left]?.candidateItems, runs[right]?.candidateItems)
      });
    }
  }

  const pointVariance = populationVariance(confirmedPoints);
  const minimumObservedCandidateJaccard = Math.min(...candidatePairs.map((pair) => pair.jaccard));
  const baseline = normalizeBaselineValue(minimumCandidateJaccard);
  const candidateGate = baseline === null
    ? { status: "baseline_required", minimum: null, observed: minimumObservedCandidateJaccard, pass: null }
    : {
        status: minimumObservedCandidateJaccard >= baseline ? "pass" : "fail",
        minimum: baseline,
        observed: minimumObservedCandidateJaccard,
        pass: minimumObservedCandidateJaccard >= baseline
      };
  const confirmedPointsPass = pointVariance === 0;
  const verdict = !confirmedPointsPass || candidateGate.pass === false
    ? "fail"
    : candidateGate.pass === null
      ? "baseline_required"
      : "pass";

  return {
    caseId: String(caseId),
    runCount: runs.length,
    verdict,
    confirmedPoints: {
      values: confirmedPoints,
      variance: pointVariance,
      stable: confirmedPointsPass,
      pass: confirmedPointsPass
    },
    candidates: {
      counts: candidateCounts,
      pairwiseJaccard: candidatePairs,
      minimumJaccard: minimumObservedCandidateJaccard,
      meanJaccard: round(mean(candidatePairs.map((pair) => pair.jaccard)), 6),
      gate: candidateGate
    },
    clinicalEvents: {
      counts: eventCounts,
      minimum: Math.min(...eventCounts),
      maximum: Math.max(...eventCounts),
      spread: Math.max(...eventCounts) - Math.min(...eventCounts)
    }
  };
}

export function summarizeStabilitySuite({
  cases = [],
  baseline = null
} = {}) {
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error("stability suite requires at least one case");
  }
  const baselineCases = baseline?.cases && typeof baseline.cases === "object"
    ? baseline.cases
    : {};
  const caseSummaries = cases.map((item) => summarizeStabilityCase({
    caseId: item.id,
    runs: item.runs,
    minimumCandidateJaccard: baselineCases[item.id]?.minimumCandidateJaccard
  }));
  const baselineRequired = caseSummaries.some((item) => item.candidates.gate.status === "baseline_required");
  const failed = caseSummaries.some((item) => item.verdict === "fail");
  return {
    verdict: failed ? "fail" : baselineRequired ? "baseline_required" : "pass",
    allConfirmedPointVarianceZero: caseSummaries.every((item) => item.confirmedPoints.pass),
    allCandidateJaccardChecksPassed: baselineRequired
      ? null
      : caseSummaries.every((item) => item.candidates.gate.pass),
    baselineRequired,
    caseCount: caseSummaries.length,
    runCount: caseSummaries.reduce((sum, item) => sum + item.runCount, 0),
    cases: caseSummaries
  };
}

export function buildStabilityBaseline(summary, {
  sourceRunId = "",
  generatedAt = new Date().toISOString()
} = {}) {
  if (!summary?.allConfirmedPointVarianceZero) {
    throw new Error("cannot baseline a run whose confirmed point variance is non-zero");
  }
  const entries = Array.isArray(summary.cases) ? summary.cases : [];
  if (!entries.length) {
    throw new Error("cannot build an empty stability baseline");
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt,
    sourceRunId: String(sourceRunId || ""),
    policy: {
      confirmedPointVariance: 0,
      candidateThreshold: "per-case minimum pairwise Jaccard observed in the reviewed baseline run"
    },
    cases: Object.fromEntries(entries.map((item) => [
      item.caseId,
      {
        minimumCandidateJaccard: item.candidates.minimumJaccard,
        observedCandidateCounts: item.candidates.counts,
        observedClinicalEventSpread: item.clinicalEvents.spread
      }
    ]))
  };
}

export function validateStabilityBaseline(value = {}, expectedCaseIds = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stability baseline must be an object");
  }
  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(`unsupported stability baseline schema: ${value.schemaVersion || "missing"}`);
  }
  const cases = value.cases;
  if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
    throw new Error("stability baseline cases must be an object");
  }
  for (const caseId of expectedCaseIds) {
    const threshold = normalizeBaselineValue(cases[caseId]?.minimumCandidateJaccard);
    if (threshold === null) {
      throw new Error(`stability baseline is missing minimumCandidateJaccard for ${caseId}`);
    }
  }
  return value;
}

function populationVariance(values) {
  const average = mean(values);
  return round(mean(values.map((value) => (value - average) ** 2)), 12);
}

function mean(values) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function finiteNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`expected a finite number, received ${value}`);
  return numeric;
}

function nonNegativeInteger(value) {
  const numeric = finiteNumber(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`expected a non-negative integer, received ${value}`);
  }
  return numeric;
}

function normalizeBaselineValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = finiteNumber(value);
  if (numeric < 0 || numeric > 1) {
    throw new Error(`candidate Jaccard baseline must be between 0 and 1, received ${value}`);
  }
  return numeric;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}
