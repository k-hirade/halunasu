import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCalculationResult,
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
        orderType: "lab",
        localName: "血液検査"
      }
    ]
  }, {
    feeSessionId: "fee_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(session.feeSessionId, "fee_001");
  assert.equal(session.orgId, "org_123");
  assert.equal(session.patientId, "pat_123");
  assert.equal(session.patientRef, "legacy-001");
  assert.equal(session.facilitySnapshot.medicalInstitutionCode, "1312345");
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
    }]
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
