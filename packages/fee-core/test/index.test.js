import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCalculationResult,
  applyFeeSessionPatch,
  applyReviewDecision,
  buildCandidateWorkbench,
  buildReceiptDraft,
  buildFeeSession,
  normalizeCalculationResult,
  buildReviewItems
} from "../src/index.js";

test("builds Platform-scoped fee sessions", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    patientRef: "legacy-001",
    patientSnapshot: {
      patientId: "pat_123",
      displayName: "山田 太郎",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    facilityId: "fac_123",
    facilitySnapshot: {
      facilityId: "fac_123",
      displayName: "春ナスクリニック",
      medicalInstitutionCode: "1312345",
      regionalBureau: "kanto-shinetsu",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28",
    orders: [
      {
        orderId: "ord_1",
        orderType: "material",
        localName: "テスト特定器材",
        standardCode: "710000001"
      }
    ],
    claimContext: {
      material_inputs: [{ code: "710000001", quantity: 1 }]
    },
    calculationOptions: {
      facility_standard_keys: ["検体検査管理加算1"]
    }
  }, {
    feeSessionId: "fee_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(session.feeSessionId, "fee_001");
  assert.equal(session.orgId, "org_123");
  assert.equal(session.patientId, "pat_123");
  assert.equal(session.patientRef, "legacy-001");
  assert.equal(session.facilitySnapshot.medicalInstitutionCode, "1312345");
  assert.equal(session.orders[0].orderType, "material");
  assert.deepEqual(session.claimContext.material_inputs, [{ code: "710000001", quantity: 1 }]);
  assert.deepEqual(session.calculationOptions.facility_standard_keys, ["検体検査管理加算1"]);
});

test("builds draft fee sessions and promotes them when calculation context is saved", () => {
  const draft = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "mem_123"
  }, {
    feeSessionId: "fee_draft",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const updated = applyFeeSessionPatch(draft, {
    patientId: "pat_123",
    patientSnapshot: { patientId: "pat_123", displayName: "山田 太郎" },
    facilityId: "fac_123",
    facilitySnapshot: { facilityId: "fac_123", displayName: "春ナスクリニック" },
    serviceDate: "2026-05-29",
    orders: [{ orderId: "ord_1", orderType: "lab", localName: "血液検査" }],
    calculationOptions: {
      history: {
        same_month_history_codes: ["160000410"]
      }
    }
  }, {
    now: new Date("2026-05-28T00:05:00.000Z")
  });

  assert.equal(draft.status, "draft");
  assert.equal(draft.serviceDate, "2026-05-28");
  assert.equal(updated.status, "ready");
  assert.equal(updated.patientId, "pat_123");
  assert.equal(updated.claimMonth, "2026-05");
  assert.deepEqual(updated.calculationOptions.history.same_month_history_codes, ["160000410"]);
});

test("normalizes external calculation results", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    facilitySnapshot: {
      facilityId: "fac_123",
      displayName: "春ナスクリニック",
      medicalInstitutionCode: "1312345",
      regionalBureau: "kanto-shinetsu"
    },
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28",
    orders: [
      {
        orderId: "ord_1",
        orderType: "drug",
        localName: "内服薬",
        quantity: 2
      }
    ]
  }, {
    feeSessionId: "fee_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const calculation = normalizeCalculationResult(session, {
    provider: "medical_fee_calculation",
    source: "python.medical_fee_calculation",
    totalPoints: 137,
    lineItems: [{
      code: "160000410",
      name: "血液検査",
      orderType: "lab",
      points: 137,
      quantity: 1,
      totalPoints: 137,
      status: "confirmed",
      source: "medical_procedure_master"
    }],
    rawResult: { rows: Array.from({ length: 10 }, (_, index) => ({ index })) }
  }, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const updated = applyCalculationResult(session, calculation, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(calculation.provider, "medical_fee_calculation");
  assert.equal(calculation.totalPoints, 137);
  assert.equal(calculation.facility.medicalInstitutionCode, "1312345");
  assert.equal(Object.hasOwn(calculation.lineItems[0], "orderId"), false);
  assert.equal(Object.hasOwn(calculation, "rawResult"), false);
  assert.equal(calculation.lineItems[0].supportLevel, "review_required");
  assert.equal(calculation.lineItems[0].reviewRequired, true);
  assert.equal(calculation.coverage.reviewRequired, true);
  assert.equal(updated.status, "needs_review");
  assert.equal(updated.latestCalculationId, "calc_001");
  assert.equal(updated.calculationSummary.totalPoints, 137);
  assert.equal(updated.calculationSummary.lineCount, 1);
  assert.equal(updated.calculationSummary.reviewRequired, true);
});

test("builds receipt drafts and resolves review items", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    facilitySnapshot: {
      facilityId: "fac_123",
      displayName: "春ナスクリニック",
      medicalInstitutionCode: "1312345",
      regionalBureau: "kanto-shinetsu"
    },
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28",
    orders: [
      {
        orderId: "ord_1",
        orderType: "lab",
        localName: "血液検査"
      }
    ]
  }, {
    feeSessionId: "fee_001",
    now: "2026-05-28T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    provider: "medical_fee_calculation",
    source: "python.medical_fee_calculation",
    totalPoints: 88,
    lineItems: [{
      lineId: "line_1",
      code: "160000410",
      name: "血液検査",
      orderType: "lab",
      points: 88,
      quantity: 1,
      totalPoints: 88,
      status: "candidate",
      source: "medical_procedure_master"
    }]
  }, {
    calculationId: "calc_001",
    now: "2026-05-28T00:10:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(calculated, {
    now: "2026-05-28T00:11:00.000Z"
  });
  const reviewItems = buildReviewItems(calculated);
  const decided = applyReviewDecision(calculated, reviewItems[0].reviewItemId, {
    status: "approved",
    note: "確認済み"
  }, {
    now: "2026-05-28T00:12:00.000Z"
  });

  assert.equal(receiptDraft.totalPoints, 88);
  assert.equal(receiptDraft.lineGroups.length, 1);
  assert.equal(receiptDraft.lines[0].supportLevel, "review_required");
  assert.ok(reviewItems.length >= 1);
  assert.equal(decided.reviewDecisions[reviewItems[0].reviewItemId].status, "approved");
});

test("builds target-specific warning review titles", () => {
  const reviewItems = buildReviewItems({
    calculationResult: {
      warnings: [
        "施設基準が登録されていないため、検体検査管理加算は自動追加していません。",
        "検査判断料の候補です。実施検査と同月算定条件を確認してください。",
        "薬剤「ロキソプロフェン」は数量または日数が不足しているため、算定候補には入れていません。"
      ],
      lineItems: []
    }
  });

  assert.deepEqual(
    reviewItems.map((item) => item.title),
    ["施設基準確認", "判断料確認", "ロキソプロフェンの確認"]
  );
});

test("excludes rejected line items from receipt totals", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_exclusion",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    lineItems: [
      {
        lineId: "line_1",
        code: "111000110",
        name: "初診料",
        orderType: "basic",
        points: 291,
        totalPoints: 291,
        status: "candidate",
        source: "outpatient_basic_fee"
      },
      {
        lineId: "line_2",
        code: "160000000",
        name: "検査候補",
        orderType: "lab",
        points: 100,
        totalPoints: 100,
        status: "candidate",
        source: "medical_procedure_master"
      }
    ]
  }, {
    calculationId: "calc_exclusion",
    now: "2026-06-07T00:01:00.000Z"
  });
  const rejected = applyReviewDecision(calculated, "line_line_2", {
    status: "rejected"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(rejected, {
    now: "2026-06-07T00:03:00.000Z"
  });

  assert.equal(receiptDraft.totalPoints, 291);
  assert.equal(receiptDraft.lines.length, 2);
  assert.equal(receiptDraft.lines.find((line) => line.sourceLineId === "line_2").includedInTotal, false);
  assert.equal(receiptDraft.lineGroups.reduce((sum, group) => sum + group.totalPoints, 0), 291);
});

test("stores review decisions without undefined optional fields", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_review_decision",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    warnings: ["施設基準を確認してください。"],
    lineItems: [{
      lineId: "line_1",
      code: "111000110",
      name: "初診料",
      orderType: "basic",
      points: 291,
      totalPoints: 291,
      status: "candidate",
      source: "outpatient_basic_fee"
    }]
  }, {
    calculationId: "calc_review_decision",
    now: "2026-06-07T00:01:00.000Z"
  });
  const warningReviewItemId = buildReviewItems(calculated).find((item) => item.sourceType === "warning").reviewItemId;
  const heldWarning = applyReviewDecision(calculated, warningReviewItemId, {
    status: "edited"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const excludedLine = applyReviewDecision(heldWarning, "line_line_1", {
    status: "rejected"
  }, {
    now: "2026-06-07T00:03:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(excludedLine, {
    now: "2026-06-07T00:04:00.000Z"
  });

  assert.equal(excludedLine.reviewDecisions[warningReviewItemId].status, "edited");
  assert.equal(Object.hasOwn(excludedLine.reviewDecisions[warningReviewItemId], "note"), false);
  assert.equal(Object.hasOwn(excludedLine.reviewDecisions[warningReviewItemId], "replacementText"), false);
  assert.equal(Object.hasOwn(excludedLine.reviewDecisions.line_line_1, "note"), false);
  assertNoUndefined(excludedLine.reviewDecisions);
  assert.equal(receiptDraft.totalPoints, 0);
});

test("builds structured candidate workbench buckets from receipt and review data", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_workbench",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    warnings: [
      "施設基準が登録されていないため、検体検査管理加算は自動追加していません。",
      "薬剤「ロキソプロフェン」は数量または日数が不足しているため、算定候補には入れていません。"
    ],
    lineItems: [
      {
        lineId: "line_1",
        code: "112007410",
        name: "再診料",
        orderType: "basic",
        points: 75,
        totalPoints: 75,
        status: "candidate",
        source: "outpatient_basic_fee"
      },
      {
        lineId: "line_2",
        code: "160000000",
        name: "検査候補",
        orderType: "lab",
        points: 100,
        totalPoints: 100,
        status: "candidate",
        source: "medical_procedure_master"
      }
    ]
  }, {
    calculationId: "calc_workbench",
    now: "2026-06-07T00:01:00.000Z"
  });
  const pending = applyReviewDecision(calculated, "line_line_2", {
    status: "edited"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const workbench = buildCandidateWorkbench(pending, {
    now: "2026-06-07T00:03:00.000Z"
  });

  assert.equal(workbench.includedTotalPoints, 75);
  assert.equal(workbench.includedLines.length, 1);
  assert.equal(workbench.pendingLines.length, 1);
  assert.equal(workbench.excludedLines.length, 0);
  assert.equal(workbench.proposals.length, 0);
  assert.equal(workbench.issues.length, 2);
  assert.ok(workbench.issues.every((item) => item.kind === "issue"));
  assert.ok(workbench.issues.find((item) => item.displayTitle === "ロキソプロフェンの確認").conditionText.includes("60mg 1日2回 7日分"));
});

test("attaches visit-fee review warnings to the basic fee line", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_visit_warning",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    warnings: [
      "同一患者の過去算定記録があるため再診料候補を立てています。過去病名と今回病名の継続性を確認してください。"
    ],
    lineItems: [{
      lineId: "line_1",
      code: "112007410",
      name: "再診料",
      orderType: "basic",
      points: 75,
      totalPoints: 75,
      status: "candidate",
      source: "outpatient_basic_fee"
    }]
  }, {
    calculationId: "calc_visit_warning",
    now: "2026-06-07T00:01:00.000Z"
  });
  const workbench = buildCandidateWorkbench(calculated, {
    now: "2026-06-07T00:02:00.000Z"
  });

  assert.equal(workbench.proposals.length, 0);
  assert.equal(workbench.issues.length, 0);
  assert.equal(workbench.includedLines[0].attentionNotes.length, 1);
  assert.match(workbench.includedLines[0].attentionNotes[0], /過去病名と今回病名/u);
});

test("adopts structured increase proposals into receipt totals", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_proposal",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    lineItems: [{
      lineId: "line_1",
      code: "112007410",
      name: "再診料",
      orderType: "basic",
      points: 75,
      totalPoints: 75,
      status: "candidate",
      source: "outpatient_basic_fee"
    }],
    candidateProposals: [{
      proposalId: "lab_management_addon",
      title: "検体検査管理加算",
      reason: "施設基準を届け出済みなら算定できます。",
      conditionText: "検体検査管理加算の施設基準を届け出済みであることを確認してください。",
      potentialPoints: 40,
      candidateLine: {
        code: "160000000",
        name: "検体検査管理加算",
        orderType: "lab",
        points: 40,
        totalPoints: 40,
        status: "candidate",
        source: "lab_management_fee"
      }
    }]
  }, {
    calculationId: "calc_proposal",
    now: "2026-06-07T00:01:00.000Z"
  });
  const proposal = buildCandidateWorkbench(calculated).proposals[0];
  const adopted = applyReviewDecision(calculated, proposal.reviewItemId, {
    status: "approved"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(adopted, {
    now: "2026-06-07T00:03:00.000Z"
  });
  const workbench = buildCandidateWorkbench(adopted, {
    receiptDraft,
    now: "2026-06-07T00:04:00.000Z"
  });

  assert.equal(proposal.canAdopt, true);
  assert.equal(proposal.pointsLabel, "+40点");
  assert.equal(receiptDraft.totalPoints, 115);
  assert.equal(receiptDraft.lines.some((line) => line.sourceProposalId === "lab_management_addon"), true);
  assert.equal(workbench.proposals.length, 0);
  assert.equal(workbench.includedLines.length, 2);
  assert.equal(workbench.includedTotalPoints, 115);
});

test("adopts confirm-required proposals with candidate lines after manual confirmation", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_confirm_required_proposal",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    lineItems: [{
      lineId: "line_1",
      code: "112007410",
      name: "再診料",
      orderType: "basic",
      points: 75,
      totalPoints: 75,
      status: "candidate",
      source: "outpatient_basic_fee"
    }],
    candidateProposals: [{
      proposalId: "manual_confirm_addon",
      title: "確認後に算定できる加算",
      reason: "条件確認が必要です。",
      conditionText: "条件を確認した場合のみ算定してください。",
      potentialPoints: 20,
      actionType: "confirm_required",
      candidateLine: {
        code: "160000001",
        name: "確認後加算",
        orderType: "lab",
        points: 20,
        totalPoints: 20,
        status: "candidate",
        source: "manual_confirm"
      }
    }]
  }, {
    calculationId: "calc_confirm_required_proposal",
    now: "2026-06-07T00:01:00.000Z"
  });
  const proposal = buildCandidateWorkbench(calculated).proposals[0];
  const adopted = applyReviewDecision(calculated, proposal.reviewItemId, {
    status: "approved"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(adopted, {
    now: "2026-06-07T00:03:00.000Z"
  });
  const workbench = buildCandidateWorkbench(adopted, {
    receiptDraft,
    now: "2026-06-07T00:04:00.000Z"
  });

  assert.equal(proposal.canAdopt, false);
  assert.equal(proposal.actionType, "confirm_required");
  assert.equal(receiptDraft.totalPoints, 95);
  assert.equal(receiptDraft.lines.some((line) => line.sourceProposalId === "manual_confirm_addon"), true);
  assert.equal(workbench.proposals.length, 0);
  assert.equal(workbench.includedLines.length, 2);
});

test("adopts review-only proposals with candidate lines after manual confirmation", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_review_only_proposal",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    lineItems: [{
      lineId: "line_1",
      code: "112007410",
      name: "再診料",
      orderType: "basic",
      points: 75,
      totalPoints: 75,
      status: "candidate",
      source: "outpatient_basic_fee"
    }],
    candidateProposals: [{
      proposalId: "management_review_only",
      title: "管理料確認",
      reason: "管理料は人手確認が必要です。",
      potentialPoints: 225,
      actionType: "not_billable_now",
      policy: {
        generationSource: "conditional_independent",
        riskGate: "review_only"
      },
      candidateLine: {
        code: "113999001",
        name: "管理料テスト",
        orderType: "procedure",
        points: 225,
        totalPoints: 225,
        status: "candidate",
        source: "management_fee"
      }
    }]
  }, {
    calculationId: "calc_review_only_proposal",
    now: "2026-06-07T00:01:00.000Z"
  });
  const initialWorkbench = buildCandidateWorkbench(calculated, {
    now: "2026-06-07T00:01:30.000Z"
  });
  const items = buildReviewItems(calculated);
  const proposalReviewItem = items.find((item) => item.candidateProposal?.proposalId === "management_review_only");
  const adopted = applyReviewDecision(calculated, proposalReviewItem.reviewItemId, {
    status: "approved"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(adopted, {
    now: "2026-06-07T00:03:00.000Z"
  });
  const workbench = buildCandidateWorkbench(adopted, {
    receiptDraft,
    now: "2026-06-07T00:04:00.000Z"
  });

  assert.equal(initialWorkbench.proposals.length, 1);
  assert.equal(initialWorkbench.proposals[0].reviewOnly, true);
  assert.equal(initialWorkbench.proposals[0].canAdopt, false);
  assert.equal(initialWorkbench.issues.length, 0);
  assert.equal(receiptDraft.totalPoints, 300);
  assert.equal(receiptDraft.lines.some((line) => line.sourceProposalId === "management_review_only"), true);
  assert.equal(workbench.proposals.length, 0);
  assert.equal(workbench.includedLines.length, 2);
});

test("keeps rejected candidate proposals visible so they can be approved later", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_rejected_proposal",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    lineItems: [{
      lineId: "line_1",
      code: "112007410",
      name: "再診料",
      orderType: "basic",
      points: 75,
      totalPoints: 75,
      status: "candidate",
      source: "outpatient_basic_fee"
    }],
    candidateProposals: [{
      proposalId: "reversible_addon",
      title: "後から採用できる加算",
      reason: "条件を満たす場合に算定できます。",
      conditionText: "内容を確認して採用してください。",
      potentialPoints: 40,
      candidateLine: {
        code: "160000002",
        name: "後から採用できる加算",
        orderType: "lab",
        points: 40,
        totalPoints: 40,
        status: "candidate",
        source: "reversible_addon"
      }
    }]
  }, {
    calculationId: "calc_rejected_proposal",
    now: "2026-06-07T00:01:00.000Z"
  });
  const proposal = buildCandidateWorkbench(calculated).proposals[0];
  const rejected = applyReviewDecision(calculated, proposal.reviewItemId, {
    status: "rejected"
  }, {
    now: "2026-06-07T00:02:00.000Z"
  });
  const rejectedWorkbench = buildCandidateWorkbench(rejected, {
    now: "2026-06-07T00:03:00.000Z"
  });
  const approved = applyReviewDecision(rejected, proposal.reviewItemId, {
    status: "approved"
  }, {
    now: "2026-06-07T00:04:00.000Z"
  });
  const receiptDraft = buildReceiptDraft(approved, {
    now: "2026-06-07T00:05:00.000Z"
  });

  assert.equal(rejectedWorkbench.proposals.length, 1);
  assert.equal(rejectedWorkbench.proposals[0].decisionStatus, "rejected");
  assert.equal(rejectedWorkbench.potentialPointsTotal, 0);
  assert.equal(buildReceiptDraft(rejected).totalPoints, 75);
  assert.equal(receiptDraft.totalPoints, 115);
  assert.equal(receiptDraft.lines.some((line) => line.sourceProposalId === "reversible_addon"), true);
});

test("preserves clinical event specimen and review issue policy metadata", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_metadata",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    clinicalEvents: [{
      clinicalEventId: "event_swab",
      type: "lab",
      billingDomain: "standard_lab",
      name: "インフルエンザ迅速検査",
      actionStatus: "performed",
      specimen: "鼻咽頭ぬぐい液",
      collectionMethod: "スワブ採取",
      evidence: "鼻咽頭ぬぐい液で迅速検査を実施"
    }],
    reviewIssues: [{
      reviewIssueId: "issue_swab",
      issueCode: "specimen_collection_fee_review_required",
      severity: "warning",
      title: "検体採取確認",
      messageForStaff: "検体採取料は人手確認が必要です。",
      relatedClinicalEventId: "event_swab",
      source: "derived_item_policy",
      policy: {
        generationSource: "derived_from_parent",
        riskGate: "review"
      }
    }]
  }, {
    calculationId: "calc_metadata",
    now: "2026-06-07T00:01:00.000Z"
  });
  const event = calculated.calculationResult.clinicalEvents[0];
  const issue = calculated.calculationResult.reviewIssues[0];
  const workbench = buildCandidateWorkbench(calculated, {
    now: "2026-06-07T00:02:00.000Z"
  });

  assert.equal(event.specimen, "鼻咽頭ぬぐい液");
  assert.equal(event.collectionMethod, "スワブ採取");
  assert.equal(event.billingDomain, "standard_lab");
  assert.equal(issue.source, "derived_item_policy");
  assert.equal(issue.policy.riskGate, "review");
  assert.equal(workbench.issues[0].issueCategory, "specimen");
});

function assertNoUndefined(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoUndefined);
    return;
  }
  if (!value || typeof value !== "object") {
    assert.notEqual(value, undefined);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${key} should not be undefined`);
    assertNoUndefined(item);
  }
}
