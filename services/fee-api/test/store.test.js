import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFeeStoreFromEnv,
  feeProjectId,
  LazyFirestoreFeeStore
} from "../src/store/create-store.js";
import { FirestoreFeeStore } from "../src/store/firestore-store.js";
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

test("lists fee sessions for a single claim month", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28"
  });
  store.createSession({
    orgId: "org_123",
    patientId: "pat_456",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-02"
  });

  const maySessions = store.listSessionsForClaimMonth("org_123", "2026-05");
  const juneSessions = store.listSessionsForClaimMonth("org_123", "2026-06");

  assert.deepEqual(maySessions.map((session) => session.feeSessionId), ["fee_001"]);
  assert.deepEqual(juneSessions.map((session) => session.feeSessionId), ["fee_002"]);
});

test("stores monthly bulk jobs with progress", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const created = store.createMonthlyBulkJob("org_123", {
    claimMonth: "2026-06",
    items: [
      { itemId: "item_1", feeSessionId: "fee_1", status: "pending" },
      { itemId: "item_2", feeSessionId: "fee_2", status: "skipped" }
    ],
    createdByMemberId: "mem_123"
  });
  const updated = store.updateMonthlyBulkJob("org_123", created.monthlyBulkJob.monthlyBulkJobId, {
    items: [
      { itemId: "item_1", feeSessionId: "fee_1", status: "queued" },
      { itemId: "item_2", feeSessionId: "fee_2", status: "skipped" }
    ]
  });

  assert.equal(created.monthlyBulkJob.monthlyBulkJobId, "fee_monthly_bulk_job_001");
  assert.equal(updated.monthlyBulkJob.progress.totalCount, 2);
  assert.equal(updated.monthlyBulkJob.progress.queuedCount, 1);
  assert.equal(updated.monthlyBulkJob.progress.skippedCount, 1);
  assert.equal(store.getMonthlyBulkJob("org_123", "fee_monthly_bulk_job_001").claimMonth, "2026-06");
});

test("Firestore fee store strips undefined review decision fields before persisting", async () => {
  let counter = 0;
  const docs = new Map();
  const store = new FirestoreFeeStore({
    db: fakeFirestoreDb(docs),
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = await store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28"
  });
  await store.saveCalculation("org_123", session.feeSessionId, {
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 88,
    warnings: ["施設基準を確認してください。"],
    lineItems: [{
      lineId: "line_1",
      code: "160000410",
      name: "血液検査",
      orderType: "lab",
      points: 88,
      totalPoints: 88,
      status: "candidate",
      source: "test"
    }]
  });
  const reviewItems = await store.listReviewItems("org_123", session.feeSessionId);
  const warningReviewItem = reviewItems.find((item) => item.sourceType === "warning");
  const held = await store.decideReviewItem("org_123", session.feeSessionId, "warning_1", {
    status: "edited"
  });
  const excluded = await store.decideReviewItem("org_123", session.feeSessionId, "line_line_1", {
    status: "rejected"
  });
  const receiptDraft = await store.getReceiptDraft("org_123", session.feeSessionId);

  assert.ok(warningReviewItem.reviewItemId.startsWith("warning_"));
  assert.equal(warningReviewItem.legacyReviewItemId, "warning_1");
  assert.equal(held.feeSession.reviewDecisions[warningReviewItem.reviewItemId].status, "edited");
  assert.equal(Object.hasOwn(held.feeSession.reviewDecisions[warningReviewItem.reviewItemId], "note"), false);
  assert.equal(Object.hasOwn(excluded.feeSession.reviewDecisions.line_line_1, "replacementText"), false);
  assertNoUndefined(docs.get("organizations/org_123/fee_sessions/fee_001"));
  assert.equal(receiptDraft.totalPoints, 0);
});

function fakeFirestoreDb(docs) {
  return {
    doc(path) {
      return {
        async get() {
          return {
            exists: docs.has(path),
            data: () => docs.get(path)
          };
        },
        async set(value) {
          assertNoUndefined(value);
          docs.set(path, value);
        },
        async update(value) {
          assertNoUndefined(value);
          docs.set(path, {
            ...(docs.get(path) || {}),
            ...value
          });
        },
        collection(name) {
          return fakeCollection(`${path}/${name}`, docs);
        }
      };
    }
  };
}

function fakeCollection(path, docs) {
  return {
    doc(id) {
      return fakeFirestoreDb(docs).doc(`${path}/${id}`);
    }
  };
}

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
