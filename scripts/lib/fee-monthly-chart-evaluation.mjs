const encounterSettings = new Set(["outpatient", "inpatient", "home_visit", "house_call"]);

const visitTypeSettings = new Map([
  ["定期", "home_visit"],
  ["定期訪問", "home_visit"],
  ["往診", "house_call"],
  ["臨時", "house_call"],
  ["臨時往診", "house_call"],
  ["電話", "outpatient"],
  ["電話再診", "outpatient"]
]);

export function deriveMonthlyChartEncounterPlans({
  charts = [],
  patient = {},
  encounterSettingOverride = ""
} = {}) {
  if (!Array.isArray(charts) || !charts.length) {
    throw new Error("charts must contain at least one visit");
  }

  const override = normalizeEncounterSettingOverride(encounterSettingOverride);
  return charts.map((chart, index) => {
    const visitType = auditVisitType(chart);
    const setting = override || deriveEncounterSetting(chart, index);
    const encounterDetails = deriveEncounterDetails(patient, setting);
    return {
      serviceDate: String(chart?.service_date || "").trim(),
      visitType,
      setting,
      encounterDetails
    };
  });
}

export function encounterPlanAuditRows(plans = []) {
  return plans.map((plan) => ({
    serviceDate: String(plan?.serviceDate || ""),
    visitType: String(plan?.visitType || ""),
    setting: String(plan?.setting || ""),
    sameBuilding: plan?.encounterDetails?.sameBuilding ?? null,
    singleBuildingPatientCount: plan?.encounterDetails?.singleBuildingPatientCount ?? null
  }));
}

export function sanitizeEmptyExtractionGuard(value) {
  const guard = value && typeof value === "object" ? value : {};
  return {
    enabled: guard.enabled === true,
    triggered: guard.triggered === true,
    reasonCodes: uniqueStrings(guard.reasonCodes).sort(),
    retryAttempted: guard.retryAttempted === true,
    recovered: guard.recovered === true,
    initialEventCount: nullableNumber(guard.initialEventCount),
    finalEventCount: nullableNumber(guard.finalEventCount)
  };
}

export function summarizeExtractionObservability(visits = []) {
  const modes = visits.map((visit) => visit?.calculationMetrics?.extractionMode || "unknown");
  const guards = visits.map((visit) => visit?.calculationMetrics?.emptyExtractionGuard || {});
  return {
    extractionModeCounts: countStrings(modes),
    emptyExtractionGuard: {
      triggeredVisitCount: guards.filter((guard) => guard.triggered === true).length,
      recoveredVisitCount: guards.filter((guard) => guard.triggered === true && guard.recovered === true).length,
      unrecoveredVisitCount: guards.filter((guard) => guard.triggered === true && guard.recovered !== true).length
    }
  };
}

export function buildLongitudinalL7Summary({
  results = [],
  readinessBefore = {},
  readinessAfter = {},
  runId = ""
} = {}) {
  if (!Array.isArray(results) || !results.length) {
    throw new Error("L7 summary requires at least one monthly result");
  }
  for (const result of results) {
    if (!String(result?.schemaVersion || "").startsWith("fee-monthly-chart-e2e.")) {
      throw new Error("L7 summary received an unsupported monthly result schema");
    }
  }

  const sortedResults = [...results].sort((left, right) => (
    String(left?.inputAudit?.patientRef || "").localeCompare(String(right?.inputAudit?.patientRef || ""))
  ));
  const patientRefs = sortedResults.map((result) => String(result?.inputAudit?.patientRef || ""));
  if (patientRefs.some((value) => !value) || new Set(patientRefs).size !== patientRefs.length) {
    throw new Error("L7 summary requires one unique patientRef per monthly result");
  }

  const organizationCode = requireSingleValue(
    sortedResults.map((result) => result?.environment?.organizationCode),
    "organizationCode"
  );
  const facilityRef = requireSingleValue(
    sortedResults.map((result) => result?.environment?.facilityRef),
    "facilityRef"
  );
  const departmentRef = requireSingleValue(
    sortedResults.map((result) => result?.environment?.departmentRef),
    "departmentRef"
  );
  const repeatCounts = sortedResults.map((result) => Number(result?.summary?.repeatCount || 0));
  const visitCounts = sortedResults.map((result) => Number(result?.summary?.visitCountPerRepeat || 0));
  const allVisits = sortedResults.flatMap((result) => (
    (Array.isArray(result?.repeats) ? result.repeats : []).flatMap((repeat) => repeat?.visits || [])
  ));
  const calculateTimings = sortedResults.flatMap((result) => (
    (Array.isArray(result?.repeats) ? result.repeats : []).flatMap((repeat) => (
      (Array.isArray(repeat?.requestTimings) ? repeat.requestTimings : [])
        .filter((timing) => timing?.operation === "calculate")
        .map((timing) => Number(timing.durationMs))
    ))
  ));
  const readiness = {
    before: sanitizeReadiness(readinessBefore),
    after: sanitizeReadiness(readinessAfter),
    sameRevision: Boolean(
      readinessBefore?.runtime?.cloudRunRevision
      && readinessBefore.runtime.cloudRunRevision === readinessAfter?.runtime?.cloudRunRevision
    )
  };

  const patients = sortedResults.map((result) => {
    const summary = result.summary || {};
    const longitudinal = summary.longitudinalContext || {};
    return {
      patientId: String(result.inputAudit.patientRef),
      inputAudit: {
        claimMonth: String(result.inputAudit.claimMonth || ""),
        visits: Array.isArray(result.inputAudit.visits) ? result.inputAudit.visits : []
      },
      uke: {
        codeCount: Number(summary.baselineCodeCount || result.inputAudit.baselineCodeCount || 0),
        totalPoints: Number(summary.baselineTotalPoints || result.inputAudit.baselineTotalPoints || 0)
      },
      monthlyConfirmedPoints: summary.monthlyTotalPoints || [],
      monthlyCandidatePoints: summary.monthlyCandidateTotalPoints || [],
      exactMatchedCodes: summary.matchedCodeCounts || [],
      detectedCodes: summary.detectionMatchedCodeCounts || [],
      sessionCandidateSetStable: summary.candidateResultStable === true,
      monthlyConfirmedPointsStable: summary.monthlyResultStable === true,
      monthlyCandidatePointsStable: allEqual(summary.monthlyCandidateTotalPoints || []),
      reviewIssueCounts: summary.reviewIssueCounts || [],
      reviewIssuesStable: summary.reviewIssueResultStable === true,
      extraction: {
        eventCounts: summary.clinicalEventCounts || [],
        maxSpread: Number(summary.extractionStability?.maxSpread || 0),
        stableVisitCount: Number(summary.extractionStability?.stableVisitCount || 0),
        modeCounts: summary.extractionModeCounts || {}
      },
      emptyExtractionGuard: summary.emptyExtractionGuard || {
        triggeredVisitCount: 0,
        recoveredVisitCount: 0,
        unrecoveredVisitCount: 0
      },
      longitudinalContext: {
        memoEnabledVisitCount: Number(longitudinal.memoEnabledVisitCount || 0),
        memoUsedVisitCount: Number(longitudinal.memoUsedVisitCount || 0),
        memoHitLineRatio: longitudinal.memoHitLineRatio || null,
        historyCompletenessCounts: longitudinal.historyCompletenessCounts || {},
        historyUnavailableCount: Number(longitudinal.historyUnavailableCount || 0)
      },
      openAi: {
        callCount: Number(longitudinal.openAiCallCount || 0),
        inputTokens: Number(longitudinal.openAiInputTokens || 0),
        cachedInputTokens: Number(longitudinal.cachedInputTokens || 0),
        outputTokens: Number(longitudinal.openAiOutputTokens || 0)
      },
      calculateRequestMs: summary.calculateRequestMs || null
    };
  });

  const inputVisits = patients.flatMap((patient) => patient.inputAudit.visits || []);
  const inputSettingCounts = countStrings(inputVisits.map((visit) => visit?.setting || "unknown"));
  const extractionModeCounts = mergeCountObjects(patients.map((patient) => patient.extraction.modeCounts));
  const guardTotals = sumGuardCounts(patients.map((patient) => patient.emptyExtractionGuard));
  const inputTokens = patients.reduce((sum, patient) => sum + patient.openAi.inputTokens, 0);
  const cachedInputTokens = patients.reduce((sum, patient) => sum + patient.openAi.cachedInputTokens, 0);

  return {
    schemaVersion: "fee-longitudinal-l7-summary.v2",
    generatedAt: new Date().toISOString(),
    runId: String(runId || ""),
    readiness,
    evaluation: {
      organizationCode,
      facilityRef,
      departmentRef,
      encounterSettingModeCounts: countStrings(
        sortedResults.map((result) => result?.evaluationOptions?.encounterSettingMode || "unknown")
      ),
      inputVisitSettingCounts: inputSettingCounts,
      seedKnownPriorHistory: sortedResults.every((result) => result?.evaluationOptions?.seedKnownPriorHistory === true),
      repeatCount: allEqual(repeatCounts) ? repeatCounts[0] : null,
      visitCountPerRepeat: allEqual(visitCounts) ? visitCounts[0] : null,
      patientCount: patients.length,
      calculateCount: calculateTimings.length
    },
    patients,
    aggregate: {
      memoEnabledVisitCount: patients.reduce((sum, patient) => sum + patient.longitudinalContext.memoEnabledVisitCount, 0),
      memoUsedVisitCount: patients.reduce((sum, patient) => sum + patient.longitudinalContext.memoUsedVisitCount, 0),
      historyUnavailableCount: patients.reduce((sum, patient) => sum + patient.longitudinalContext.historyUnavailableCount, 0),
      stableMonthlyConfirmedPatientCount: patients.filter((patient) => patient.monthlyConfirmedPointsStable).length,
      stableMonthlyCandidatePatientCount: patients.filter((patient) => patient.monthlyCandidatePointsStable).length,
      stableReviewIssuePatientCount: patients.filter((patient) => patient.reviewIssuesStable).length,
      extractionModeCounts,
      emptyExtractionGuard: guardTotals,
      openAiCallCount: patients.reduce((sum, patient) => sum + patient.openAi.callCount, 0),
      openAiInputTokens: inputTokens,
      cachedInputTokens,
      cacheHitRatio: inputTokens > 0 ? cachedInputTokens / inputTokens : null,
      openAiOutputTokens: patients.reduce((sum, patient) => sum + patient.openAi.outputTokens, 0),
      calculateRequestMs: distribution(calculateTimings),
      observedVisitCount: allVisits.length
    }
  };
}

export function deriveEncounterSetting(chart = {}, index = 0) {
  const candidates = [
    ["visit_type", chart?.visit_type],
    ["status", chart?.status]
  ].map(([field, value]) => ({ field, value: normalizeVisitType(value) }))
    .filter((item) => item.value);

  if (!candidates.length) {
    throw new Error(`chart ${index + 1} does not include visit_type or status`);
  }

  const mapped = candidates.map((item) => {
    const setting = visitTypeSettings.get(item.value);
    if (!setting) {
      throw new Error(`chart ${index + 1} has unknown ${item.field}: ${item.value}`);
    }
    return { ...item, setting };
  });
  const settings = new Set(mapped.map((item) => item.setting));
  if (settings.size !== 1) {
    throw new Error(
      `chart ${index + 1} has conflicting visit_type/status: ${mapped.map((item) => `${item.field}=${item.value}`).join(", ")}`
    );
  }
  return mapped[0].setting;
}

export function deriveEncounterDetails(patient = {}, setting = "") {
  if (!encounterSettings.has(setting)) {
    throw new Error(`unsupported encounter setting: ${setting || "(empty)"}`);
  }
  if (!["home_visit", "house_call"].includes(setting)) {
    return undefined;
  }

  const isFacility = parseRequiredBoolean(patient.is_facility, "patients.csv is_facility");
  if (!isFacility) {
    return { sameBuilding: false, sameBuildingSource: "user" };
  }

  const patientCount = parsePositiveInteger(patient.facility_count, "patients.csv facility_count");
  if (patientCount < 2) {
    return { sameBuilding: false, sameBuildingSource: "user" };
  }
  return {
    sameBuilding: true,
    sameBuildingSource: "user",
    singleBuildingPatientCount: patientCount
  };
}

function normalizeEncounterSettingOverride(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!encounterSettings.has(normalized)) {
    throw new Error(`--encounter-setting must be one of: ${[...encounterSettings].join(", ")}`);
  }
  return normalized;
}

function normalizeVisitType(value) {
  return String(value || "").replace(/[\s\u3000]+/gu, "").trim();
}

function auditVisitType(chart = {}) {
  return normalizeVisitType(chart.visit_type) || normalizeVisitType(chart.status);
}

function parseRequiredBoolean(value, label) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new Error(`${label} must be True or False for home_visit/house_call`);
}

function parsePositiveInteger(value, label) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer for a facility patient`);
  }
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
}

function countStrings(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = String(value || "unknown");
    counts.set(normalized, Number(counts.get(normalized) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireSingleValue(values, label) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (unique.length !== 1) {
    throw new Error(`L7 summary requires one ${label}; found ${unique.length}`);
  }
  return unique[0];
}

function sanitizeReadiness(value = {}) {
  return {
    status: String(value.status || ""),
    revision: String(value.runtime?.cloudRunRevision || ""),
    extractionMemoEnabled: value.runtimeFeatures?.extractionMemoEnabled === true,
    emptyExtractionRetryEnabled: value.runtimeFeatures?.emptyExtractionRetryEnabled === true
  };
}

function allEqual(values) {
  return values.length > 0 && new Set(values.map((value) => JSON.stringify(value))).size === 1;
}

function mergeCountObjects(objects) {
  const counts = new Map();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object || {})) {
      counts.set(key, Number(counts.get(key) || 0) + Number(value || 0));
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sumGuardCounts(guards) {
  return guards.reduce((sum, guard) => ({
    triggeredVisitCount: sum.triggeredVisitCount + Number(guard?.triggeredVisitCount || 0),
    recoveredVisitCount: sum.recoveredVisitCount + Number(guard?.recoveredVisitCount || 0),
    unrecoveredVisitCount: sum.unrecoveredVisitCount + Number(guard?.unrecoveredVisitCount || 0)
  }), {
    triggeredVisitCount: 0,
    recoveredVisitCount: 0,
    unrecoveredVisitCount: 0
  });
}

function distribution(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: round(sorted[sorted.length - 1])
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
