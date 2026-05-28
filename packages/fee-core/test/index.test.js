import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMockCalculation,
  applyReviewDecision,
  buildReceiptDraft,
  buildFeeSession,
  buildMockFeeCalculation,
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

test("creates deterministic mock calculation without external providers", () => {
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
  const calculation = buildMockFeeCalculation(session, {}, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const updated = applyMockCalculation(session, {}, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(calculation.provider, "mock");
  assert.equal(calculation.totalPoints, 424);
  assert.equal(calculation.facility.medicalInstitutionCode, "1312345");
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
  const calculated = applyMockCalculation(session, {}, {
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

  assert.equal(receiptDraft.totalPoints, 348);
  assert.equal(receiptDraft.lineGroups.length, 2);
  assert.ok(reviewItems.length >= 1);
  assert.equal(decided.reviewDecisions[reviewItems[0].reviewItemId].status, "approved");
});
