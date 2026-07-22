import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLongitudinalL7Summary,
  deriveMonthlyChartEncounterPlans,
  encounterPlanAuditRows,
  sanitizeEmptyExtractionGuard,
  summarizeExtractionObservability
} from "../../../scripts/lib/fee-monthly-chart-evaluation.mjs";

test("monthly chart plan derives mixed home visit and telephone settings for facility patient 1002", () => {
  const plans = deriveMonthlyChartEncounterPlans({
    patient: { patient_id: "1002", is_facility: "True", facility_count: "4" },
    charts: [
      { service_date: "2026-06-02", visit_type: "定期", status: "定期" },
      { service_date: "2026-06-09", visit_type: "定期", status: "定期" },
      { service_date: "2026-06-16", visit_type: "電話", status: "電話再診" },
      { service_date: "2026-06-23", visit_type: "定期", status: "定期" }
    ]
  });

  assert.deepEqual(plans.map((plan) => plan.setting), [
    "home_visit",
    "home_visit",
    "outpatient",
    "home_visit"
  ]);
  assert.deepEqual(plans[0].encounterDetails, {
    sameBuilding: true,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 4
  });
  assert.equal(plans[2].encounterDetails, undefined);
  assert.deepEqual(encounterPlanAuditRows(plans)[0], {
    serviceDate: "2026-06-02",
    visitType: "定期",
    setting: "home_visit",
    sameBuilding: true,
    singleBuildingPatientCount: 4
  });
});

test("monthly chart plan rejects unknown and conflicting visit types", () => {
  const patient = { is_facility: "False", facility_count: "1" };
  assert.throws(() => deriveMonthlyChartEncounterPlans({
    patient,
    charts: [{ service_date: "2026-06-01", visit_type: "オンライン" }]
  }), /unknown visit_type: オンライン/u);
  assert.throws(() => deriveMonthlyChartEncounterPlans({
    patient,
    charts: [{ service_date: "2026-06-01", visit_type: "定期", status: "往診" }]
  }), /conflicting visit_type\/status/u);
});

test("monthly chart plan marks individual-home patient 1006 as outside same building", () => {
  const [plan] = deriveMonthlyChartEncounterPlans({
    patient: { patient_id: "1006", is_facility: "False", facility_count: "1" },
    charts: [{ service_date: "2026-06-05", visit_type: "臨時", status: "往診" }]
  });

  assert.equal(plan.setting, "house_call");
  assert.deepEqual(plan.encounterDetails, {
    sameBuilding: false,
    sameBuildingSource: "user"
  });
});

test("explicit encounter setting overrides chart labels but still derives compatible details", () => {
  const plans = deriveMonthlyChartEncounterPlans({
    patient: { is_facility: "True", facility_count: "6" },
    charts: [{ service_date: "2026-06-01", visit_type: "未対応区分" }],
    encounterSettingOverride: "home_visit"
  });

  assert.equal(plans[0].setting, "home_visit");
  assert.equal(plans[0].encounterDetails.sameBuilding, true);
  assert.equal(plans[0].encounterDetails.singleBuildingPatientCount, 6);
});

test("monthly chart metrics preserve empty extraction guard evidence and aggregate only triggered visits", () => {
  const recovered = sanitizeEmptyExtractionGuard({
    enabled: true,
    triggered: true,
    reasonCodes: ["positive_dictionary_match", "positive_dictionary_match", "diagnosis_mention"],
    retryAttempted: true,
    recovered: true,
    initialEventCount: 0,
    finalEventCount: 2
  });
  const unrecovered = sanitizeEmptyExtractionGuard({
    enabled: true,
    triggered: true,
    reasonCodes: ["order_mention"],
    retryAttempted: true,
    recovered: false,
    initialEventCount: 0,
    finalEventCount: 0
  });
  const inactive = sanitizeEmptyExtractionGuard(null);

  assert.deepEqual(recovered.reasonCodes, ["diagnosis_mention", "positive_dictionary_match"]);
  assert.equal(recovered.initialEventCount, 0);
  assert.equal(inactive.initialEventCount, null);

  const summary = summarizeExtractionObservability([
    { calculationMetrics: { extractionMode: "full_with_retry", emptyExtractionGuard: recovered } },
    { calculationMetrics: { extractionMode: "full_with_retry", emptyExtractionGuard: unrecovered } },
    { calculationMetrics: { extractionMode: "memo_only", emptyExtractionGuard: inactive } },
    { calculationMetrics: {} }
  ]);
  assert.deepEqual(summary.extractionModeCounts, {
    full_with_retry: 2,
    memo_only: 1,
    unknown: 1
  });
  assert.deepEqual(summary.emptyExtractionGuard, {
    triggeredVisitCount: 2,
    recoveredVisitCount: 1,
    unrecoveredVisitCount: 1
  });
});

test("L7 summary v2 aggregates encounter audit, extraction modes, and empty extraction guard", () => {
  const monthlyResult = {
    schemaVersion: "fee-monthly-chart-e2e.v1",
    inputAudit: {
      patientRef: "1002",
      claimMonth: "2026-06",
      baselineCodeCount: 2,
      baselineTotalPoints: 100,
      visits: [{
        serviceDate: "2026-06-02",
        visitType: "定期",
        setting: "home_visit",
        sameBuilding: true,
        singleBuildingPatientCount: 4
      }]
    },
    environment: {
      organizationCode: "fee-longitudinal-e2e-stg",
      facilityRef: "facility-ref",
      departmentRef: "department-ref"
    },
    evaluationOptions: {
      encounterSettingMode: "derived",
      seedKnownPriorHistory: true
    },
    summary: {
      repeatCount: 1,
      visitCountPerRepeat: 1,
      baselineCodeCount: 2,
      baselineTotalPoints: 100,
      monthlyTotalPoints: [90],
      monthlyCandidateTotalPoints: [10],
      matchedCodeCounts: [1],
      detectionMatchedCodeCounts: [2],
      candidateResultStable: true,
      monthlyResultStable: true,
      reviewIssueCounts: [1],
      reviewIssueResultStable: true,
      clinicalEventCounts: [[2]],
      extractionStability: { maxSpread: 0, stableVisitCount: 1 },
      extractionModeCounts: { full_with_retry: 1 },
      emptyExtractionGuard: {
        triggeredVisitCount: 1,
        recoveredVisitCount: 1,
        unrecoveredVisitCount: 0
      },
      longitudinalContext: {
        memoEnabledVisitCount: 1,
        memoUsedVisitCount: 0,
        historyUnavailableCount: 0,
        openAiCallCount: 2,
        openAiInputTokens: 100,
        cachedInputTokens: 80,
        openAiOutputTokens: 20
      },
      calculateRequestMs: { count: 1, min: 900, median: 900, mean: 900, max: 900 }
    },
    repeats: [{
      visits: [{}],
      requestTimings: [{ operation: "calculate", durationMs: 900 }]
    }]
  };
  const readiness = {
    status: "ok",
    runtime: { cloudRunRevision: "fee-api-stg-00170-test" },
    runtimeFeatures: { extractionMemoEnabled: true, emptyExtractionRetryEnabled: true }
  };

  const summary = buildLongitudinalL7Summary({
    results: [monthlyResult],
    readinessBefore: readiness,
    readinessAfter: readiness,
    runId: "test-run"
  });

  assert.equal(summary.schemaVersion, "fee-longitudinal-l7-summary.v2");
  assert.equal(summary.readiness.sameRevision, true);
  assert.deepEqual(summary.evaluation.inputVisitSettingCounts, { home_visit: 1 });
  assert.deepEqual(summary.aggregate.extractionModeCounts, { full_with_retry: 1 });
  assert.deepEqual(summary.aggregate.emptyExtractionGuard, {
    triggeredVisitCount: 1,
    recoveredVisitCount: 1,
    unrecoveredVisitCount: 0
  });
});
