import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCalculationResult,
  applyFeeSessionPatch,
  applyReviewDecision,
  buildBillingSummary,
  buildCandidateWorkbench,
  buildReceiptDraft,
  buildMonthlyReceiptDraft,
  buildReceiptDenshin,
  buildReceiptExportValidation,
  serializeUke,
  buildFeeSession,
  normalizeCalculationResult,
  buildReviewItems,
  buildBaselineDiagnosis,
  buildMonthlyBaselineDiagnosis,
  engineClaimFromSessions,
  BASELINE_COMPARISON_STATUS,
  BASELINE_DIFF_CATEGORY
} from "../src/index.js";

test("aggregates a monthly receipt across a patient's visits", () => {
  function calculatedSession({ feeSessionId, serviceDate, lineItems, diagnoses, totalPoints }) {
    return applyCalculationResult(buildFeeSession({
      orgId: "org_123",
      patientId: "pat_month",
      facilityId: "fac_123",
      createdByMemberId: "mem_123",
      serviceDate,
      diagnoses
    }, { feeSessionId, now: new Date(`${serviceDate}T00:00:00.000Z`) }), {
      provider: "test",
      status: "completed",
      totalPoints,
      lineItems,
      warnings: []
    }, { calculationId: `calc_${feeSessionId}`, now: new Date(`${serviceDate}T00:01:00.000Z`) });
  }

  const sessions = [
    calculatedSession({
      feeSessionId: "fee_m1",
      serviceDate: "2026-06-03",
      totalPoints: 73,
      lineItems: [{ code: "112007410", name: "再診料", orderType: "basic", totalPoints: 73, quantity: 1 }],
      diagnoses: [{ name: "急性上気道炎", isPrimary: true }]
    }),
    calculatedSession({
      feeSessionId: "fee_m2",
      serviceDate: "2026-06-17",
      totalPoints: 133,
      lineItems: [
        { code: "112007410", name: "再診料", orderType: "basic", totalPoints: 73, quantity: 1 },
        { code: "160000000", name: "末梢血液一般", orderType: "lab", totalPoints: 60, quantity: 1 }
      ],
      diagnoses: [{ name: "急性上気道炎" }, { name: "高血圧症" }]
    })
  ];

  const receipt = buildMonthlyReceiptDraft(sessions, { patientId: "pat_month", claimMonth: "2026-06" });
  assert.equal(receipt.scope, "monthly");
  assert.equal(receipt.actualDays, 2);
  assert.equal(receipt.sessionCount, 2);
  assert.equal(receipt.totalPoints, 206);
  assert.equal(receipt.receiptType, "medical_outpatient");
  assert.deepEqual(receipt.receiptTypes, ["medical_outpatient"]);
  assert.match(receipt.claimKey, /^pat_month\|2026-06\|medical_outpatient\|/);
  const revisit = receipt.lines.find((line) => line.code === "112007410");
  assert.equal(revisit.quantity, 2);
  assert.equal(revisit.totalPoints, 146);
  assert.deepEqual(revisit.serviceDates, ["2026-06-03", "2026-06-17"]);
  assert.equal(receipt.lineOccurrences.length, 3);
  assert.deepEqual(
    receipt.lineOccurrences
      .filter((line) => line.code === "112007410")
      .map((line) => line.serviceDate),
    ["2026-06-03", "2026-06-17"]
  );
  assert.equal(receipt.diagnoses.length, 2);
  assert.equal(receipt.diagnoses.find((d) => d.name === "急性上気道炎").isPrimary, true);
  assert.equal(receipt.diagnoses.find((d) => d.name === "急性上気道炎").firstSeenServiceDate, "2026-06-03");
});

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

test("updates monthly claim work without clearing calculation results", () => {
  const calculated = applyCalculationResult(buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-03",
    diagnoses: [{ name: "急性上気道炎" }]
  }, {
    feeSessionId: "fee_monthly_work",
    now: new Date("2026-06-03T00:00:00.000Z")
  }), {
    provider: "test",
    status: "completed",
    totalPoints: 137,
    lineItems: [{ code: "111", name: "再診料", totalPoints: 73 }],
    warnings: []
  }, {
    calculationId: "calc_001",
    now: new Date("2026-06-03T00:01:00.000Z")
  });
  const updated = applyFeeSessionPatch(calculated, {
    monthlyClaimWork: {
      status: "doctor_confirming",
      note: "医師確認中",
      updatedByMemberId: "mem_123",
      updatedAt: "2026-06-03T00:02:00.000Z"
    }
  }, {
    now: new Date("2026-06-03T00:02:00.000Z")
  });

  assert.equal(updated.status, calculated.status);
  assert.equal(updated.calculationSummary.totalPoints, 137);
  assert.equal(updated.monthlyClaimWork.status, "doctor_confirming");
});

test("updates receipt annotations without clearing calculation results", () => {
  const calculated = applyCalculationResult(buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-03"
  }, {
    feeSessionId: "fee_receipt_annotations",
    now: new Date("2026-06-03T00:00:00.000Z")
  }), {
    provider: "test",
    status: "completed",
    totalPoints: 137,
    lineItems: [{ code: "111", name: "再診料", totalPoints: 73 }],
    warnings: []
  }, {
    calculationId: "calc_receipt_annotations",
    now: new Date("2026-06-03T00:01:00.000Z")
  });
  const updated = applyFeeSessionPatch(calculated, {
    receiptAnnotations: {
      comments: [{ status: "confirmed", shinryoIdentification: "60", code: "830000001", text: "コメント本文" }],
      symptomDetails: [{ status: "draft", kubun: "01", text: "症状詳記本文" }]
    }
  }, {
    now: new Date("2026-06-03T00:02:00.000Z")
  });

  assert.equal(updated.status, calculated.status);
  assert.equal(updated.calculationResult.calculationId, "calc_receipt_annotations");
  assert.equal(updated.receiptAnnotations.comments[0].text, "コメント本文");
  assert.equal(updated.receiptAnnotations.symptomDetails[0].status, "draft");
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
  assert.equal(workbench.issues.length, 1);
  assert.equal(workbench.hiddenIssues.length, 1);
  assert.equal(workbench.hiddenIssues[0].issueCategory, "facility");
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
      assessmentRisk: {
        riskCategory: "body_laterality",
        denialType: "A/B査定",
        reason: "疾患部位と画像・処置部位の相違",
        checkPoints: ["病名部位", "処置部位", "左右"]
      },
      bodyLateralityCheck: {
        mismatchType: "laterality",
        diagnosisLaterality: ["right"],
        targetLaterality: ["left"]
      },
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
  assert.equal(issue.assessmentRisk.denialType, "A/B査定");
  assert.equal(issue.bodyLateralityCheck.mismatchType, "laterality");
  assert.equal(issue.policy.riskGate, "review");
  assert.equal(workbench.issues[0].issueCategory, "specimen");
  assert.equal(workbench.issues[0].assessmentRisk.riskCategory, "body_laterality");
});

test("hides negated and excluded clinical event review items from the workspace", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_hidden_review",
    now: "2026-06-07T00:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    reviewIssues: [{
      reviewIssueId: "issue_nebulizer_not_done",
      issueCode: "planned_not_performed",
      severity: "warning",
      title: "ネブライザーの確認",
      messageForStaff: "ネブライザーは施行せずと記載されているため、算定候補には入れていません。",
      source: "clinical_event_rule"
    }, {
      reviewIssueId: "issue_comment_required",
      issueCode: "needs_review",
      severity: "warning",
      title: "レセプトコメントの確認",
      messageForStaff: "レセプトコメントの確認: 120002910 処方箋料に必要なコメント: 830100194 １を算定しない理由（処方箋料）",
      requiredInput: "コメント本文",
      source: "required_comment"
    }]
  }, {
    calculationId: "calc_hidden_review",
    now: "2026-06-07T00:01:00.000Z"
  });

  const reviewItems = buildReviewItems(calculated);
  const hiddenItem = reviewItems.find((item) => item.reviewIssue?.reviewIssueId === "issue_nebulizer_not_done");
  const commentItem = reviewItems.find((item) => item.reviewIssue?.reviewIssueId === "issue_comment_required");
  const workbench = buildCandidateWorkbench(calculated);

  assert.equal(hiddenItem.status, "hidden");
  assert.equal(hiddenItem.hiddenFromWorkspace, true);
  assert.equal(commentItem.status, "needs_review");
  assert.equal(workbench.issues.length, 1);
  assert.equal(workbench.issues[0].displayTitle, "レセプトコメントの確認");
  assert.equal(workbench.hiddenIssues.length, 1);
  assert.equal(workbench.needsReviewCount, 1);

  const hiddenOnly = applyCalculationResult(session, {
    reviewIssues: [{
      reviewIssueId: "issue_nebulizer_not_done",
      issueCode: "planned_not_performed",
      severity: "warning",
      title: "ネブライザーの確認",
      messageForStaff: "ネブライザーは施行せずと記載されているため、算定候補には入れていません。",
      source: "clinical_event_rule"
    }]
  }, {
    calculationId: "calc_hidden_only",
    now: "2026-06-07T00:02:00.000Z"
  });
  assert.equal(hiddenOnly.status, "calculated");
  assert.equal(buildCandidateWorkbench(hiddenOnly).needsReviewCount, 0);

  const facilityOnly = applyCalculationResult(session, {
    reviewIssues: [{
      reviewIssueId: "issue_facility_standard",
      issueCode: "hospital_profile_missing",
      severity: "warning",
      title: "施設基準確認",
      messageForStaff: "施設基準が登録されていないため、施設基準が必要な加算は自動追加していません。",
      source: "facility_standard"
    }]
  }, {
    calculationId: "calc_facility_hidden",
    now: "2026-06-07T00:03:00.000Z"
  });
  const facilityWorkbench = buildCandidateWorkbench(facilityOnly);
  assert.equal(facilityOnly.status, "calculated");
  assert.equal(facilityWorkbench.issues.length, 0);
  assert.equal(facilityWorkbench.hiddenIssues.length, 1);
  assert.equal(facilityWorkbench.needsReviewCount, 0);

  const missingDiagnosisOnly = applyCalculationResult(session, {
    totalPoints: 76,
    lineItems: [{
      id: "line_revisit",
      name: "再診料",
      code: "112007410",
      points: 76,
      status: "confirmed"
    }],
    warnings: ["病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。"]
  }, {
    calculationId: "calc_missing_diagnosis_hidden",
    now: "2026-06-07T00:04:00.000Z"
  });
  const missingDiagnosisWorkbench = buildCandidateWorkbench(missingDiagnosisOnly);
  assert.equal(missingDiagnosisOnly.status, "calculated");
  assert.equal(missingDiagnosisWorkbench.issues.length, 0);
  assert.equal(missingDiagnosisWorkbench.hiddenIssues.length, 1);
  assert.equal(missingDiagnosisWorkbench.needsReviewCount, 0);
});

test("normalizes electronic exclusion and in-house medication warnings for the workspace", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    createdByMemberId: "member_1",
    patientId: "patient_1",
    facilityId: "facility_1",
    serviceDate: "2026-06-07"
  }, {
    feeSessionId: "fee_warning_normalize",
    now: "2026-06-07T01:00:00.000Z"
  });
  const calculated = applyCalculationResult(session, {
    totalPoints: 277,
    lineItems: [{
      lineId: "line_burn",
      code: "140032110",
      name: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）",
      points: 147,
      status: "confirmed"
    }],
    warnings: [
      "In-house medication fee requires drug inputs",
      "Exclusion candidate: 140000610 創傷処置（１００ｃｍ２未満） and 140032110 熱傷処置（１００ｃｍ２以上５００ｃｍ２未満） matched from current",
      "Exclusion candidate: 140032110 熱傷処置（１００ｃｍ２以上５００ｃｍ２未満） and 140000610 創傷処置（１００ｃｍ２未満） matched from current"
    ]
  }, {
    calculationId: "calc_warning_normalize",
    now: "2026-06-07T01:01:00.000Z"
  });

  const workbench = buildCandidateWorkbench(calculated);
  assert.equal(workbench.issues.filter((item) => item.displayTitle === "同日複数処置の確認").length, 1);
  assert.equal(workbench.issues.filter((item) => item.displayTitle === "院内処方の薬剤情報確認").length, 1);
  assert.equal(workbench.issues.some((item) => /Exclusion candidate|In-house medication/i.test(item.displayReason)), false);
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

test("buildBillingSummary computes copay from age-derived burden ratio", () => {
  const billing = buildBillingSummary({
    insuranceSnapshot: { insurance: {}, publicInsurance: [] },
    patientSnapshot: { birthDate: "1980-05-01" },
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 1234 }
  });
  assert.equal(billing.totalFee, 12340);
  assert.equal(billing.burdenRatio, 0.3);
  assert.equal(billing.burdenRatioSource, "age");
  assert.equal(billing.copay, 3700); // 12340*0.3=3702 -> 10円四捨五入
  assert.equal(billing.insurerPay, 8640);
});

test("buildBillingSummary applies preschool 2-wari and elderly defaults", () => {
  const preschool = buildBillingSummary({
    patientSnapshot: { birthDate: "2021-05-01" },
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 1000 }
  });
  assert.equal(preschool.burdenRatio, 0.2);

  const elderly = buildBillingSummary({
    patientSnapshot: { birthDate: "1949-05-01" },
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 1000 }
  });
  assert.equal(elderly.burdenRatio, 0.1);
  assert.ok(elderly.notes.some((n) => n.includes("所得区分")));
});

test("buildBillingSummary prefers explicit ratio and public override", () => {
  const explicit = buildBillingSummary({
    insuranceSnapshot: { insurance: { burdenRatio: 0.1 } },
    patientSnapshot: { birthDate: "1980-05-01" },
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 555 }
  });
  assert.equal(explicit.burdenRatioSource, "explicit");
  assert.equal(explicit.copay, 560); // 5550*0.1=555 -> 四捨五入 560

  const withPublic = buildBillingSummary({
    insuranceSnapshot: { insurance: { burdenRatio: 0.3 }, publicInsurance: [{ burdenRatioOverride: 0, priority: 1 }] },
    patientSnapshot: { birthDate: "1980-05-01" },
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 1000 }
  });
  assert.equal(withPublic.burdenRatioSource, "public");
  assert.equal(withPublic.copay, 0);
  assert.equal(withPublic.publicApplied, true);
});

test("buildBillingSummary degrades safely when birthDate is unknown", () => {
  const billing = buildBillingSummary({
    patientSnapshot: {},
    serviceDate: "2026-06-01",
    calculationResult: { totalPoints: 1234 }
  });
  assert.equal(billing.burdenRatioSource, "default_unknown");
  assert.ok(billing.notes.some((n) => n.includes("生年月日")));
});

test("buildReceiptDraft embeds a billing summary", () => {
  const draft = buildReceiptDraft({
    feeSessionId: "fee_1",
    orgId: "org_1",
    serviceDate: "2026-06-01",
    patientSnapshot: { birthDate: "1980-05-01" },
    insuranceSnapshot: { insurance: {} },
    calculationResult: { status: "ready", totalPoints: 100, lineItems: [{ lineId: "l1", name: "再診料", orderType: "basic", points: 100, quantity: 1, totalPoints: 100 }] }
  });
  assert.ok(draft.billing);
  assert.equal(draft.billing.totalFee, draft.totalPoints * 10);
});

function ukeFixtureDraft() {
  return buildReceiptDraft({
    feeSessionId: "fee_1",
    orgId: "org_1",
    serviceDate: "2026-06-01",
    claimMonth: "2026-06",
    patientId: "pat_1",
    patientSnapshot: { displayName: "山田 太郎", sex: "male", birthDate: "1970-01-02" },
    facilitySnapshot: { medicalInstitutionCode: "1312345", displayName: "春ナス内科", prefectureCode: "13" },
    insuranceSnapshot: {
      insurance: { insurerType: "shaho", insurerNumber: "01130012", insuredSymbol: "12", insuredNumber: "3456" },
      publicInsurance: [{ payerNumber: "54136015", recipientNumber: "0000001" }]
    },
    calculationResult: {
      status: "ready",
      totalPoints: 288,
      lineItems: [
        { lineId: "l1", code: "112007410", name: "再診料", orderType: "basic", points: 75, quantity: 1, totalPoints: 75 },
        { lineId: "l2", code: "620000123", name: "内服薬", orderType: "drug", points: 13, quantity: 1, totalPoints: 13 }
      ]
    }
  });
}

test("buildReceiptDenshin builds the standard UKE record set with wareki conversion", () => {
  const records = buildReceiptDenshin(ukeFixtureDraft());
  const byType = records.map((r) => r.record);
  assert.deepEqual(byType, ["IR", "RE", "HO", "KO", "SI", "IY"]);

  const ir = records.find((r) => r.record === "IR");
  assert.equal(ir.fields[6], "50806", "請求年月 = 令和8年6月");

  const re = records.find((r) => r.record === "RE");
  assert.equal(re.fields[5], "3450102", "生年月日 = 昭和45年1月2日");
  assert.equal(re.fields[4], "1", "性別=男");

  const ho = records.find((r) => r.record === "HO");
  assert.equal(ho.fields[0], "01130012");
  assert.equal(ho.fields[5], "88", "合計点数 = 75 + 13");

  // 医薬品は IY、再診は SI で診療識別12
  const si = records.find((r) => r.record === "SI");
  assert.equal(si.fields[0], "12");
  const iy = records.find((r) => r.record === "IY");
  assert.equal(iy.fields[2], "620000123");
});

test("serializeUke emits comma-separated CRLF records and trims trailing empties", () => {
  const text = serializeUke(buildReceiptDenshin(ukeFixtureDraft()));
  assert.ok(text.endsWith("\r\n"));
  const lines = text.trimEnd().split("\r\n");
  assert.ok(lines[0].startsWith("IR,"));
  // IR の末尾空項目(マルチボリューム等)は省略される
  assert.equal(lines[0], "IR,1,13,1,1312345,,春ナス内科,50806");
});

test("buildReceiptDenshin appends comment and symptom-detail records when provided", () => {
  const records = buildReceiptDenshin(ukeFixtureDraft(), {
    comments: [{ shinryoIdentification: "60", code: "830000001", text: "症状詳記コメント" }],
    symptomDetails: [{ kubun: "01", text: "経過良好" }]
  });
  assert.ok(records.some((r) => r.record === "CO" && r.fields[2] === "830000001"));
  assert.ok(records.some((r) => r.record === "SJ" && r.fields[1] === "経過良好"));
});

test("buildReceiptExportValidation reports required UKE draft fields", () => {
  const draft = ukeFixtureDraft();
  const validation = buildReceiptExportValidation(draft, {
    comments: [{ shinryoIdentification: "60", code: "830000001", text: "コメント" }],
    symptomDetails: [{ kubun: "01", text: "詳記" }]
  });
  assert.equal(validation.exportStatus, "ready_for_review");
  assert.equal(validation.blockingIssueCount, 0);

  const invalid = buildReceiptExportValidation({
    ...draft,
    patientSnapshot: {},
    facilitySnapshot: {},
    insuranceSnapshot: { insurance: {} }
  });
  assert.equal(invalid.exportStatus, "draft");
  assert.ok(invalid.issues.some((issue) => issue.field === "facility.medicalInstitutionCode" && issue.severity === "error"));
  assert.ok(invalid.issues.some((issue) => issue.field === "patient.displayName" && issue.severity === "error"));
  assert.ok(invalid.issues.some((issue) => issue.field === "insurance.insurerNumber" && issue.severity === "error"));
});

test("buildReceiptExportValidation applies facility receipt validation severity policy", () => {
  const validation = buildReceiptExportValidation({
    ...ukeFixtureDraft(),
    patientSnapshot: { displayName: "山田 太郎" }
  }, {
    receiptPolicy: {
      validationSeverity: {
        patientSex: "off",
        patientBirthDate: "error"
      }
    }
  });

  assert.ok(!validation.issues.some((issue) => issue.field === "patient.sex"));
  assert.ok(validation.issues.some((issue) => issue.field === "patient.birthDate" && issue.severity === "error"));
});

test("buildBaselineDiagnosis classifies missing / review / consider with over二義性", () => {
  const baseline = {
    patientId: "patA",
    claimMonth: "2026-06",
    lines: [
      { code: "112007410", name: "再診料", points: 73, count: 2 },
      { code: "900000000", name: "未対応算定", points: 150, count: 1 },
      { code: "160000000", name: "末梢血液一般", points: 60, count: 2 }
    ]
  };
  const engine = {
    patientId: "patA",
    claimMonth: "2026-06",
    lines: [
      { code: "112007410", name: "再診料", points: 73, count: 2 },
      { code: "113001810", name: "特定疾患療養管理料", points: 225, count: 1 },
      { code: "160000000", name: "末梢血液一般", points: 60, count: 1 },
      { code: "220000000", name: "低確信候補", points: 50, count: 1 }
    ],
    lowConfidenceCodes: ["220000000"]
  };
  const diag = buildBaselineDiagnosis(baseline, engine, { knownUnsupportedCodes: ["900000000"] });
  const byCode = Object.fromEntries(diag.findings.map((f) => [f.code, f]));
  assert.equal(byCode["113001810"].category, BASELINE_DIFF_CATEGORY.MISSING); // engine only confirmed
  assert.equal(byCode["900000000"].category, BASELINE_DIFF_CATEGORY.CONSIDER); // 未対応→検討(過剰にしない)
  assert.equal(byCode["220000000"].category, BASELINE_DIFF_CATEGORY.CONSIDER); // 低確信→検討
  assert.equal(byCode["160000000"].category, BASELINE_DIFF_CATEGORY.REVIEW); // baseline多い→要確認
  assert.equal(byCode["112007410"], undefined); // 一致→所見なし
  assert.equal(byCode["113001810"].estimatedYen, 2250);

  const comparisonsByCode = Object.fromEntries(diag.comparisonRows.map((row) => [row.code, row]));
  assert.equal(comparisonsByCode["112007410"].comparisonStatus, BASELINE_COMPARISON_STATUS.MATCHED);
  assert.equal(comparisonsByCode["113001810"].comparisonStatus, BASELINE_COMPARISON_STATUS.ENGINE_ONLY);
  assert.equal(comparisonsByCode["900000000"].comparisonStatus, BASELINE_COMPARISON_STATUS.BASELINE_ONLY);
  assert.equal(comparisonsByCode["160000000"].comparisonStatus, BASELINE_COMPARISON_STATUS.BOTH_DELTA);
  assert.equal(comparisonsByCode["160000000"].deltaPoints, -60);
});

test("engineClaimFromSessions aggregates lineItems and marks low confidence", () => {
  const sessions = [
    { patientId: "patA", claimMonth: "2026-06", calculationResult: { lineItems: [
      { code: "112007410", name: "再診料", points: 73, quantity: 1, status: "confirmed" },
      { code: "160061710", name: "判断料", points: 34, quantity: 1, status: "candidate" },
      { code: "999", name: "却下", points: 10, quantity: 1, status: "blocked" }
    ] } },
    { patientId: "patA", claimMonth: "2026-06", calculationResult: { lineItems: [
      { code: "112007410", name: "再診料", points: 73, quantity: 1, status: "confirmed" }
    ] } }
  ];
  const engine = engineClaimFromSessions(sessions, { patientId: "patA", claimMonth: "2026-06" });
  const byCode = Object.fromEntries(engine.lines.map((l) => [l.code, l]));
  assert.equal(byCode["999"], undefined); // blocked 除外
  assert.equal(byCode["112007410"].count, 2); // 同月2受診合算
  assert.ok(engine.lowConfidenceCodes.includes("160061710"));
  assert.ok(!engine.lowConfidenceCodes.includes("112007410"));
});

test("buildMonthlyBaselineDiagnosis pairs sessions and uploaded baseline by patient", () => {
  const sessions = [
    { patientId: "patA", claimMonth: "2026-06", calculationResult: { lineItems: [
      { code: "112007410", name: "再診料", points: 73, quantity: 2, status: "confirmed" },
      { code: "113001810", name: "特定疾患療養管理料", points: 225, quantity: 1, status: "confirmed" }
    ] } }
  ];
  const baselineClaims = [
    { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 73, count: 2 }] }
  ];
  const result = buildMonthlyBaselineDiagnosis({ sessions, baselineClaims, claimMonth: "2026-06" });
  assert.equal(result.patientCount, 1);
  assert.equal(result.summary.missingCandidateCount, 1); // 特定疾患療養管理料が算定もれ候補
  assert.equal(result.summary.missingCandidatePoints, 225);
  assert.equal(result.summary.engineOnlyCount, 1);
  assert.equal(result.summary.matchedCount, 1);
});

test("buildMonthlyBaselineDiagnosis filters baseline claims by claimMonth and keeps months isolated", () => {
  const sessions = [
    { patientId: "patA", claimMonth: "2026-06", calculationResult: { lineItems: [
      { code: "112007410", name: "再診料", points: 73, quantity: 1, status: "confirmed" }
    ] } }
  ];
  const baselineClaims = [
    { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 73, count: 1 }] },
    { patientId: "patA", claimMonth: "2026-05", lines: [{ code: "113001810", name: "特定疾患療養管理料", points: 225, count: 1 }] }
  ];

  const june = buildMonthlyBaselineDiagnosis({ sessions, baselineClaims, claimMonth: "2026-06" });

  assert.equal(june.patientCount, 1);
  assert.equal(june.diagnoses[0].claimMonth, "2026-06");
  assert.equal(june.diagnoses[0].findings.length, 0);
});

test("monthly receipt aggregates pending candidate proposals into a second tier", () => {
  function sessionWithProposals({ feeSessionId, serviceDate, lineItems = [], candidateProposals = [], reviewDecisions = null }) {
    const session = applyCalculationResult(buildFeeSession({
      orgId: "org_123",
      patientId: "pat_cand",
      facilityId: "fac_123",
      createdByMemberId: "mem_123",
      serviceDate
    }, { feeSessionId, now: new Date(`${serviceDate}T00:00:00.000Z`) }), {
      provider: "test",
      status: "completed",
      totalPoints: lineItems.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0),
      lineItems,
      candidateProposals,
      warnings: []
    }, { calculationId: `calc_${feeSessionId}`, now: new Date(`${serviceDate}T00:01:00.000Z`) });
    if (reviewDecisions) {
      session.reviewDecisions = reviewDecisions;
    }
    return session;
  }

  const cancerPainProposal = (suffix) => ({
    proposalId: `master_link_cancer_${suffix}`,
    title: "がん性疼痛緩和指導管理料の算定確認",
    reason: "カルテに医学管理等の実施記載があります。",
    conditionText: "対象病名・同月の算定回数を確認してください。",
    basis: "master_link_candidate",
    evidence: "オピオイドを増量しレスキュー使用を指導",
    code: "113012810",
    potentialPoints: 200,
    source: "clinical_billing_opportunity",
    candidateLine: { code: "113012810", name: "がん性疼痛緩和指導管理料", orderType: "procedure", points: 200, totalPoints: 200, quantity: 1 }
  });

  const homeVisitProposal = {
    proposalId: "master_link_home_visit",
    title: "在宅患者訪問診療料の算定確認",
    reason: "在宅医療の実施記載があります。",
    basis: "master_link_candidate",
    code: "114001110",
    potentialPoints: 890,
    candidateLine: { code: "114001110", name: "在宅患者訪問診療料（１）１", orderType: "procedure", points: 890, totalPoints: 890, quantity: 1 }
  };

  const rejectedProposal = {
    proposalId: "master_link_rejected",
    title: "却下済み候補",
    code: "199999999",
    potentialPoints: 999,
    candidateLine: { code: "199999999", name: "却下済み候補", orderType: "procedure", points: 999, totalPoints: 999, quantity: 1 }
  };

  const sessions = [
    sessionWithProposals({
      feeSessionId: "fee_c1",
      serviceDate: "2026-06-03",
      lineItems: [{ code: "112011010", name: "外来管理加算", orderType: "basic", totalPoints: 52, quantity: 1 }],
      candidateProposals: [cancerPainProposal("a"), homeVisitProposal]
    }),
    sessionWithProposals({ feeSessionId: "fee_c2", serviceDate: "2026-06-10", candidateProposals: [cancerPainProposal("b")] }),
    sessionWithProposals({ feeSessionId: "fee_c3", serviceDate: "2026-06-17", candidateProposals: [cancerPainProposal("c")] }),
    sessionWithProposals({
      feeSessionId: "fee_c4",
      serviceDate: "2026-06-24",
      candidateProposals: [cancerPainProposal("d"), rejectedProposal],
      reviewDecisions: { proposal_master_link_rejected: { status: "rejected" } }
    })
  ];

  const receipt = buildMonthlyReceiptDraft(sessions, {
    patientId: "pat_cand",
    claimMonth: "2026-06",
    actFrequencyLimits: { "113012810": [{ unitCode: "131", unit: "月", maxCount: 1 }] },
    actExclusions: [
      { exclusionTable: "exclusions_day", baseCode: "114001110", baseName: "在宅患者訪問診療料（１）１", excludedCode: "112011010", excludedName: "外来管理加算", ruleKind: "1" }
    ]
  });

  // 上段(確定側)は candidateProposals の影響を受けない
  assert.equal(receipt.totalPoints, 52);

  const cancerPain = receipt.candidateLines.find((line) => line.code === "113012810");
  assert.ok(cancerPain);
  assert.equal(cancerPain.occurrenceCount, 4);
  assert.equal(cancerPain.quantity, 1); // 月1回上限で畳む
  assert.equal(cancerPain.suppressedOccurrenceCount, 3);
  assert.equal(cancerPain.totalPoints, 200);
  assert.ok(cancerPain.evidence.includes("オピオイド"));

  const homeVisit = receipt.candidateLines.find((line) => line.code === "114001110");
  assert.ok(homeVisit);
  assert.equal(homeVisit.totalPoints, 890);
  assert.equal(homeVisit.conflicts.length, 1);
  assert.equal(homeVisit.conflicts[0].withCode, "112011010"); // 確定側の外来管理加算と背反

  // 却下済みは候補に出ない
  assert.ok(!receipt.candidateLines.some((line) => line.code === "199999999"));
  assert.equal(receipt.candidateTotalPoints, 200 + 890);
});

test("コード未確定の知識ルール候補は ruleId で畳まれ monthlyLimit フォールバックが効く", () => {
  function sessionWithProposal(feeSessionId, serviceDate, proposal) {
    return applyCalculationResult(buildFeeSession({
      orgId: "org_123",
      patientId: "pat_rule",
      facilityId: "fac_123",
      createdByMemberId: "mem_123",
      serviceDate
    }, { feeSessionId, now: new Date(`${serviceDate}T00:00:00.000Z`) }), {
      provider: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: [],
      candidateProposals: [proposal],
      warnings: []
    }, { calculationId: `calc_${feeSessionId}`, now: new Date(`${serviceDate}T00:01:00.000Z`) });
  }

  // 難病外来指導管理料: マスタに1/2があり曖昧なため code 無し。evidenceが受診ごとに違い proposalId も異なる。
  const proposal = (suffix, evidence) => ({
    proposalId: `management_signal_B001_intractable_${suffix}`,
    ruleId: "B001_intractable_disease_guidance_signal",
    title: "難病外来指導管理料の確認",
    potentialPoints: 270,
    monthlyLimit: { unit: "月", maxCount: 1 },
    evidence
  });

  const receipt = buildMonthlyReceiptDraft([
    sessionWithProposal("fee_r1", "2026-06-13", proposal("a", "多発性硬化症で継続管理")),
    sessionWithProposal("fee_r2", "2026-06-27", proposal("b", "難病の療養指導を実施"))
  ], { patientId: "pat_rule", claimMonth: "2026-06" });

  assert.equal(receipt.candidateLines.length, 1);
  const line = receipt.candidateLines[0];
  assert.equal(line.code, null);
  assert.equal(line.occurrenceCount, 2);
  assert.equal(line.quantity, 1); // ルール側 monthlyLimit で月1回に畳む
  assert.equal(line.suppressedOccurrenceCount, 1);
  assert.equal(line.totalPoints, 270);
  assert.deepEqual(line.frequencyLimits, [{ unit: "月", unitCode: "", maxCount: 1 }]);
  assert.equal(receipt.candidateTotalPoints, 270);
});
