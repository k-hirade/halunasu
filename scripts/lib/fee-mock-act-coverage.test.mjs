import assert from "node:assert/strict";
import test from "node:test";
import {
  auditMockActCoverageCase,
  classifyMockAction,
  normalizeMockActionName,
  parseCsv,
  reconcileMockActCoverageRuns,
  summarizeMockActCoverage
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
  assert.equal(run.metrics.patientChargeCount, 1);
  assert.equal(run.actual.falseProposalCount, 1);
  assert.equal(Object.hasOwn(run, "clinicalText"), false);

  const summary = summarizeMockActCoverage([run]);
  assert.equal(summary.billableMatchRate, 1);
  assert.equal(summary.commentDetectionRate, 1);
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
