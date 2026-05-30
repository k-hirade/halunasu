import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFeeStoreFromEnv,
  feeProjectId,
  LazyFirestoreFeeStore
} from "../src/store/create-store.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

test("uses fee product project for Firestore", () => {
  const env = {
    FEE_STORE_BACKEND: "firestore",
    FEE_GOOGLE_CLOUD_PROJECT: "halunasu-fee-stg",
    PLATFORM_GOOGLE_CLOUD_PROJECT: "medical-core-stg",
    GOOGLE_CLOUD_PROJECT: "halunasu-fee-stg"
  };
  const store = createFeeStoreFromEnv(env);

  assert.ok(store instanceof LazyFirestoreFeeStore);
  assert.equal(feeProjectId(env), "halunasu-fee-stg");
  assert.equal(store.options.projectId, "halunasu-fee-stg");
});

test("stores fee sessions by organization and saves calculation results", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
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
  });
  const result = store.saveCalculation("org_123", session.feeSessionId, {
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
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
      source: "test"
    }]
  });
  const receiptDraft = store.getReceiptDraft("org_123", session.feeSessionId);
  const reviewItems = store.listReviewItems("org_123", session.feeSessionId);
  const decided = store.decideReviewItem("org_123", session.feeSessionId, reviewItems[0].reviewItemId, {
    status: "approved"
  });

  assert.equal(session.feeSessionId, "fee_001");
  assert.equal(store.listSessions("org_123").length, 1);
  const page = store.listSessions("org_123", { page: 1, pageSize: 20 });
  assert.equal(page.feeSessions.length, 1);
  assert.equal(page.totalCount, 1);
  assert.equal(page.feeSessions[0].calculationResult, undefined);
  assert.equal(page.feeSessions[0].calculationSummary.totalPoints, 88);
  assert.equal(result.calculationResult.calculationId, "calc_002");
  assert.equal(result.calculationResult.provider, "test_fee_engine");
  assert.equal(result.feeSession.status, "needs_review");
  assert.equal(receiptDraft.totalPoints, 88);
  assert.ok(reviewItems.length >= 1);
  assert.equal(decided.feeSession.reviewDecisions[reviewItems[0].reviewItemId].status, "approved");
});
