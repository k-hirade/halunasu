import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCalculationResult,
  applyFeeSessionPatch,
  applyReviewDecision,
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
    ["施設基準の確認", "検査判断料の確認", "ロキソプロフェンの確認"]
  );
});
