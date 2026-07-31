import assert from "node:assert/strict";
import test from "node:test";
import {
  auditMockActCoverageCase,
  classifyMockAction,
  normalizeMockActionName,
  parseCsv,
  reconcileMockActCoverageRuns,
  resolveRateLimitRetryDelayMs,
  summarizeMockActCoverage,
  summarizeMockActCoverageRepetitions
} from "./fee-mock-act-coverage.mjs";

test("classifies mock action-list rows into the five evaluation classes", () => {
  assert.equal(classifyMockAction("在宅患者訪問診療料（１）１（同一建物居住者）"), "billable_line");
  assert.equal(classifyMockAction("同一患家 9日、23日"), "claim_comment");
  assert.equal(
    classifyMockAction("訪問診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日"),
    "claim_attribute"
  );
  assert.equal(classifyMockAction("単一建物診療患者数（施医総管）；6"), "claim_attribute");
  assert.equal(classifyMockAction("往診交通費"), "patient_charge");
  assert.equal(classifyMockAction("自由記載"), "unknown");
});

test("uses the generated action_class before legacy mapping status", () => {
  assert.equal(classifyMockAction("任意の表示名", {
    action_class: "patient_charge",
    match_status: "comment_or_nonclaim"
  }), "patient_charge");
  assert.equal(classifyMockAction("任意の表示名", {
    action_class: "claim_attribute",
    match_status: "comment_or_nonclaim"
  }), "claim_attribute");
});

test("normalizes dates and counts without retaining source values", () => {
  assert.equal(
    normalizeMockActionName("初回算定年月日（在宅移行早期加算）；令和 6年 11月22日"),
    "初回算定年月日(在宅移行早期加算);{date}"
  );
  assert.equal(
    normalizeMockActionName("単一建物診療患者数（施医総管）；6"),
    "単一建物診療患者数(施医総管);{count}"
  );
});

test("audits calculated lines, proposals, comments, and patient charges separately", () => {
  const run = auditMockActCoverageCase({
    caseId: "1001-2026-06-25",
    patientId: "1001",
    serviceDate: "2026-06-25",
    setting: "home_visit",
    clinicalText: "synthetic chart",
    actionList: [
      "在宅患者訪問診療料（１）１（同一建物居住者以外）",
      "在宅データ提出加算（在医総管・施医総管）",
      "同一患家 9日、23日",
      "往診交通費"
    ]
  }, {
    candidates: [
      {
        sourceType: "calculated_line",
        code: "114001110",
        name: "在宅患者訪問診療料（１）１（同一建物居住者以外）"
      },
      {
        sourceType: "proposal",
        code: "114057970",
        name: "在宅データ提出加算（在医総管・施医総管）"
      },
      {
        sourceType: "proposal",
        code: "999999999",
        name: "偽提案"
      }
    ],
    notices: [{ messageForStaff: "同一患家 9日、23日のコメントを確認してください。" }]
  }, [
    {
      action_key: "在宅患者訪問診療料（1）1（同一建物居住者以外）",
      sample_action_name: "在宅患者訪問診療料（１）１（同一建物居住者以外）",
      match_status: "exact_master_name",
      code: "114001110"
    },
    {
      sample_action_name: "在宅データ提出加算（在医総管・施医総管）",
      match_status: "exact_master_name",
      code: "114057970"
    }
  ]);

  assert.equal(run.metrics.billableCount, 2);
  assert.equal(run.metrics.confirmedCount, 1);
  assert.equal(run.metrics.candidateCount, 1);
  assert.equal(run.metrics.commentDetectedCount, 1);
  assert.equal(
    run.gold.find((item) => item.actionClass === "claim_comment").matchedCommentStatus,
    "legacy_detected"
  );
  assert.equal(run.metrics.patientChargeCount, 1);
  assert.equal(run.actual.falseProposalCount, 1);
  assert.equal(Object.hasOwn(run, "clinicalText"), false);

  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.billableMatchRate, 1);
  assert.equal(summary.commentDetectionRate, 1);
});

test("uses structured generated and input-required comments without changing comment recall", () => {
  const run = auditMockActCoverageCase({
    caseId: "structured-comments",
    patientId: "1004",
    serviceDate: "2026-06-25",
    setting: "home_visit",
    clinicalText: "synthetic chart",
    actionList: [
      "訪問診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日",
      "頻回な在宅患者訪問診療を行った必要性（在宅患者訪問診療料（１））"
    ]
  }, {
    candidates: [{
      sourceType: "calculated_line",
      code: "114030310",
      name: "在宅患者訪問診療料（１）１（同一建物居住者）",
      comments: [
        {
          commentCode: "850100095",
          name: "訪問診療年月日（在宅患者訪問診療料（１））",
          status: "generated",
          text: "訪問診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日"
        },
        {
          commentCode: "830100088",
          name: "頻回な在宅患者訪問診療を行った必要性（在宅患者訪問診療料（１））",
          status: "input_required",
          text: ""
        }
      ]
    }],
    notices: []
  }, [
    {
      sample_action_name: "訪問診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日",
      action_class: "claim_comment",
      comment_code: "850100095"
    },
    {
      sample_action_name: "頻回な在宅患者訪問診療を行った必要性（在宅患者訪問診療料（１））",
      action_class: "claim_comment",
      comment_code: "830100088"
    }
  ]);

  assert.equal(run.metrics.commentCount, 2);
  assert.equal(run.metrics.commentDetectedCount, 2);
  assert.equal(run.metrics.commentGeneratedCount, 1);
  assert.equal(run.metrics.commentInputRequiredCount, 1);
  assert.deepEqual(
    run.gold.map((item) => item.matchedCommentStatus),
    ["generated", "input_required"]
  );
  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.commentDetectionRate, 1);
  assert.equal(summary.commentGeneratedCount, 1);
  assert.equal(summary.commentInputRequiredCount, 1);
});

test("collects PHI-free standing-lane reasons and missing facts", () => {
  const run = auditMockActCoverageCase({
    caseId: "standing-diagnostics",
    patientId: "1001",
    serviceDate: "2026-06-01",
    setting: "home_visit",
    clinicalText: "synthetic",
    actionList: []
  }, {
    sidecarDraft: {
      calculation: {
        candidates: [],
        notices: [],
        metrics: {
          standingLane: {
            disabledReason: null,
            familyCount: 231,
            additionalSelectorResolvedCount: 19,
            structuredTriggers: {
              reasonCounts: {
                required_positive_fact_missing: 1
              },
              perTrigger: [{
                triggerId: "c002_home_management_review_candidate",
                ruleKind: "standing_family",
                reason: "required_positive_fact_missing",
                missingFacts: ["clinical.currentManagementOrCounselingCount"]
              }]
            },
            factsSummary: {
              residenceType: "private",
              plannedHomeVisit: true,
              activeDiagnosisCount: 1,
              currentManagementOrCounselingCount: 0,
              currentManagementEventCount: 0,
              currentManagementStandingMentionCount: 0,
              currentManagementTextSignalCount: 0,
              currentLongitudinalPlanSignalCount: 0,
              standingMentionCount: 0,
              deviceFactCount: 0,
              eventCount: 1,
              currentOwnEventCount: 0,
              eventTypeCounts: { counseling: 1 },
              actionStatusCounts: { instruction_only: 1 },
              temporalRelationCounts: { unknown: 1 },
              providerOwnershipCounts: { own_clinic: 1 }
            }
          }
        }
      }
    }
  });

  assert.equal(run.standingLane.familyCount, 231);
  assert.equal(
    run.standingLane.factsSummary.currentManagementOrCounselingCount,
    0
  );
  assert.deepEqual(
    {
      event: run.standingLane.factsSummary.currentManagementEventCount,
      mention: run.standingLane.factsSummary.currentManagementStandingMentionCount,
      text: run.standingLane.factsSummary.currentManagementTextSignalCount,
      plan: run.standingLane.factsSummary.currentLongitudinalPlanSignalCount
    },
    {
      event: 0,
      mention: 0,
      text: 0,
      plan: 0
    }
  );
  assert.deepEqual(
    run.standingLane.structuredTriggers.perTrigger[0].missingFacts,
    ["clinical.currentManagementOrCounselingCount"]
  );
  const summary = summarizeMockActCoverage([run]);
  assert.deepEqual(summary.standingLane, {
    observedRunCount: 1,
    missingRunCount: 0,
    disabledReasonCounts: {},
    reasonCounts: {
      required_positive_fact_missing: 1
    },
    missingFactCounts: {
      "clinical.currentManagementOrCounselingCount": 1
    }
  });
});

test("parses quoted CSV mapping rows", () => {
  const rows = parseCsv('action_key,sample_action_name,note\nx,"a,b","quoted ""value"""\n');
  assert.deepEqual(rows, [{
    action_key: "x",
    sample_action_name: "a,b",
    note: 'quoted "value"'
  }]);
});

test("consumes visit-scoped candidates one-to-one", () => {
  const mapping = [{
    sample_action_name: "一般採血",
    action_class: "billable_line",
    match_status: "exact_master_name",
    code: "160000310",
    billing_scope: "per_visit",
    billing_scope_source: "fixture"
  }];
  const run = auditMockActCoverageCase({
    caseId: "visit-one-to-one",
    patientId: "1001",
    serviceDate: "2026-06-01",
    clinicalText: "synthetic",
    actionList: ["一般採血", "一般採血"]
  }, {
    candidates: [{
      sourceType: "calculated_line",
      code: "160000310",
      name: "一般採血"
    }]
  }, mapping);

  assert.deepEqual(run.gold.map((item) => item.matchStatus), ["confirmed", "missing"]);
  assert.equal(run.metrics.confirmedCount, 1);
  assert.equal(run.metrics.missingCount, 1);
});

test("reconciles monthly candidates by patient-month without reusing one unit", () => {
  const mapping = [{
    sample_action_name: "在宅人工呼吸指導管理料",
    action_class: "billable_line",
    match_status: "exact_master_name",
    code: "114005410",
    billing_scope: "per_month",
    billing_scope_source: "electronic_frequency_limits:fixture"
  }];
  const first = auditMockActCoverageCase({
    caseId: "1002-20260602",
    patientId: "1002",
    serviceDate: "2026-06-02",
    clinicalText: "synthetic",
    actionList: ["在宅人工呼吸指導管理料"]
  }, {
    candidates: [{
      sourceType: "proposal",
      code: "114005410",
      name: "在宅人工呼吸指導管理料"
    }]
  }, mapping);
  const second = auditMockActCoverageCase({
    caseId: "1002-20260623",
    patientId: "1002",
    serviceDate: "2026-06-23",
    clinicalText: "synthetic",
    actionList: ["在宅人工呼吸指導管理料"]
  }, { candidates: [] }, mapping);

  reconcileMockActCoverageRuns([first, second], mapping);

  assert.deepEqual(
    [first.gold[0].matchStatus, second.gold[0].matchStatus],
    ["candidate", "missing"]
  );
  const summary = summarizeMockActCoverage([first, second]);
  assert.equal(summary.byScope.per_month.billableCount, 2);
  assert.equal(summary.byScope.per_month.matchedBillableCount, 1);
});

test("deduplicates the same monthly proposal emitted on multiple visits", () => {
  const mapping = [{
    sample_action_name: "在宅データ提出加算",
    action_class: "billable_line",
    match_status: "exact_master_name",
    code: "114057970",
    billing_scope: "per_month",
    billing_scope_source: "electronic_frequency_limits:fixture"
  }];
  const makeRun = (date, actionList) => auditMockActCoverageCase({
    caseId: `1002-${date}`,
    patientId: "1002",
    serviceDate: date,
    clinicalText: "synthetic",
    actionList
  }, {
    candidates: [{
      sourceType: "proposal",
      code: "114057970",
      name: "在宅データ提出加算"
    }]
  }, mapping);
  const first = makeRun("2026-06-02", ["在宅データ提出加算"]);
  const second = makeRun("2026-06-23", []);

  reconcileMockActCoverageRuns([first, second], mapping);

  assert.equal(first.gold[0].matchStatus, "candidate");
  assert.equal(first.actual.falseProposalCount + second.actual.falseProposalCount, 0);
  assert.equal(
    first.actual.duplicateMonthlyCandidateCount + second.actual.duplicateMonthlyCandidateCount,
    1
  );
});

test("separates act coverage from billable-ready matches and point totals", () => {
  const mapping = [{
    sample_action_name: "在宅データ提出加算",
    action_class: "billable_line",
    match_status: "exact_master_name",
    code: "114057970",
    points: "50",
    billing_scope: "per_visit",
    billing_scope_source: "fixture"
  }];
  const blocked = auditMockActCoverageCase({
    caseId: "blocked-candidate",
    patientId: "1001",
    serviceDate: "2026-06-01",
    clinicalText: "synthetic",
    actionList: ["在宅データ提出加算"]
  }, {
    candidates: [{
      sourceType: "proposal",
      code: "114057970",
      name: "在宅データ提出加算",
      points: 50,
      adoptionBlocked: true
    }]
  }, mapping);

  const summary = summarizeMockActCoverage([blocked]);
  assert.equal(summary.actCoverageRecall, 1);
  assert.equal(summary.billableReadyMatchRate, 0);
  assert.equal(summary.conditionalCandidateCount, 1);
  assert.equal(summary.expectedPointTotal, 50);
  assert.equal(summary.billableReadyExpectedPointTotal, 0);
  assert.equal(summary.detectedBillableReadyPointTotal, 0);
  assert.equal(summary.pointTotalsComparable, false);
  assert.equal(summary.pointTotalsMatch, false);
});

test("counts unmatched calculated lines as dangerous false positives", () => {
  const run = auditMockActCoverageCase({
    caseId: "dangerous-false-positive",
    patientId: "1001",
    serviceDate: "2026-06-01",
    clinicalText: "synthetic",
    actionList: []
  }, {
    candidates: [{
      sourceType: "calculated_line",
      code: "999999999",
      name: "行為欄にない確定行",
      points: 100
    }, {
      sourceType: "proposal",
      code: "888888888",
      name: "行為欄にない確認候補",
      points: 50
    }]
  }, []);

  reconcileMockActCoverageRuns([run], []);
  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.dangerousFalsePositiveCount, 1);
  assert.equal(summary.falseProposalCount, 2);
  assert.equal(summary.candidateProposalCount, 1);
  assert.equal(summary.candidatePrecision, 0);
});

test("matches billable-ready points only when code and points are resolved", () => {
  const mapping = [{
    sample_action_name: "往診",
    action_class: "billable_line",
    match_status: "manual_reviewed_mapping",
    code: "114000110",
    points: "720",
    billing_scope: "per_visit",
    billing_scope_source: "fixture"
  }];
  const run = auditMockActCoverageCase({
    caseId: "resolved-points",
    patientId: "1001",
    serviceDate: "2026-06-01",
    clinicalText: "synthetic",
    actionList: ["往診"]
  }, {
    candidates: [{
      sourceType: "proposal",
      code: "114000110",
      name: "往診料",
      points: 720,
      requiresSelection: false
    }]
  }, mapping);

  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.billableReadyMatchRate, 1);
  assert.equal(summary.billableReadyExpectedPointTotal, 720);
  assert.equal(summary.detectedBillableReadyPointTotal, 720);
  assert.equal(summary.pointTotalsMatch, true);
});

test("point totals compare the same billable-ready scope on both sides", () => {
  const mapping = [
    {
      sample_action_name: "往診",
      action_class: "billable_line",
      match_status: "manual_reviewed_mapping",
      code: "114000110",
      points: "720",
      billing_scope: "per_visit",
      billing_scope_source: "fixture"
    },
    {
      sample_action_name: "在宅データ提出加算",
      action_class: "billable_line",
      match_status: "exact_master_name",
      code: "114057970",
      points: "50",
      billing_scope: "per_visit",
      billing_scope_source: "fixture"
    }
  ];
  const run = auditMockActCoverageCase({
    caseId: "mixed-point-scope",
    patientId: "1001",
    serviceDate: "2026-06-01",
    clinicalText: "synthetic",
    actionList: ["往診", "在宅データ提出加算"]
  }, {
    candidates: [
      {
        sourceType: "proposal",
        code: "114000110",
        name: "往診料",
        points: 720
      },
      {
        sourceType: "proposal",
        code: "114057970",
        name: "在宅データ提出加算",
        points: 50,
        adoptionBlocked: true
      }
    ]
  }, mapping);

  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.expectedPointTotal, 770);
  assert.equal(summary.billableReadyExpectedPointTotal, 720);
  assert.equal(summary.detectedBillableReadyPointTotal, 720);
  assert.equal(summary.pointTotalsMatch, true);
});

test("honors Retry-After and otherwise uses bounded exponential backoff", () => {
  assert.equal(resolveRateLimitRetryDelayMs("12", {
    attempt: 0,
    baseDelayMs: 5_000,
    maxDelayMs: 60_000
  }), 12_000);
  assert.equal(resolveRateLimitRetryDelayMs(
    "Thu, 01 Jan 2026 00:00:09 GMT",
    {
      nowMs: Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"),
      baseDelayMs: 5_000,
      maxDelayMs: 60_000
    }
  ), 9_000);
  assert.equal(resolveRateLimitRetryDelayMs("", {
    attempt: 1,
    baseDelayMs: 5_000,
    maxDelayMs: 60_000
  }), 10_000);
  assert.equal(resolveRateLimitRetryDelayMs("", {
    attempt: 10,
    baseDelayMs: 5_000,
    maxDelayMs: 60_000
  }), 60_000);
});

test("does not report determinism when only part of the requested repeats completed", () => {
  const passingSummary = {
    actCoverageRecall: 1,
    dangerousFalsePositiveCount: 0,
    commentCount: 0,
    commentDetectionRate: null,
    pointTotalsMatch: true
  };
  const summary = summarizeMockActCoverageRepetitions([
    {
      repeatIndex: 1,
      status: "complete",
      summary: passingSummary,
      outputSha256: "same"
    },
    {
      repeatIndex: 2,
      status: "running",
      summary: passingSummary
    }
  ]);

  assert.equal(summary.repeatCoverageComplete, false);
  assert.equal(summary.deterministicOutputs, false);
  assert.equal(summary.allAcceptanceChecksPassed, false);
  assert.equal(summary.repeatAcceptance[0].commentDetectionPassed, true);
});

test("accepts two complete identical repeats when no comment rows exist", () => {
  const passingSummary = {
    rateLimitRetryCount: 1,
    actCoverageRecall: 1,
    dangerousFalsePositiveCount: 0,
    commentCount: 0,
    commentDetectionRate: null,
    pointTotalsMatch: true
  };
  const summary = summarizeMockActCoverageRepetitions([1, 2].map((repeatIndex) => ({
    repeatIndex,
    status: "complete",
    summary: passingSummary,
    outputSha256: "same"
  })));

  assert.equal(summary.repeatCoverageComplete, true);
  assert.equal(summary.deterministicOutputs, true);
  assert.equal(summary.allAcceptanceChecksPassed, true);
  assert.equal(summary.rateLimitRetryCount, 2);
});
