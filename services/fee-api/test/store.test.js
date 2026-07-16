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
  store.createSession({
    orgId: "org_123",
    patientId: "pat_789",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-03"
  });

  const maySessions = store.listSessionsForClaimMonth("org_123", "2026-05");
  const juneSessions = store.listSessionsForClaimMonth("org_123", "2026-06");
  const singlePatient = store.listSessionsForClaimMonth("org_123", "2026-06", {
    patientId: " pat_456 ",
    patientIds: ["pat_789"]
  });
  const selectedPatients = store.listSessionsForClaimMonth("org_123", "2026-06", {
    patientIds: ["pat_789", "", "pat_789", "pat_456"]
  });
  const overChunkLimit = store.listSessionsForClaimMonth("org_123", "2026-06", {
    patientIds: Array.from({ length: 101 }, (_, index) => `pat_${index}`)
  });

  assert.deepEqual(maySessions.map((session) => session.feeSessionId), ["fee_001"]);
  assert.deepEqual(juneSessions.map((session) => session.feeSessionId), ["fee_002", "fee_003"]);
  assert.deepEqual(singlePatient.map((session) => session.patientId), ["pat_456"]);
  assert.deepEqual(selectedPatients.map((session) => session.patientId), ["pat_456", "pat_789"]);
  assert.deepEqual(overChunkLimit.map((session) => session.patientId), ["pat_456", "pat_789"]);
});

test("Firestore monthly sessions apply patient filters to both query lanes and dedupe chunks", async () => {
  const calls = [];
  const store = new FirestoreFeeStore({ db: {} });
  store.orgCollection = () => recordingMonthlyCollection(calls);
  const patientIds = Array.from({ length: 51 }, (_, index) => `pat_${String(index).padStart(3, "0")}`);

  const sessions = await store.listSessionsForClaimMonth("org_123", "2026-06", { patientIds });

  assert.equal(calls.length, 6, "three 25-patient chunks each issue claimMonth and serviceDate queries");
  assert.equal(sessions.length, 1, "the same feeSessionId returned by multiple lanes/chunks is deduplicated");
  assert.deepEqual(
    calls.map((call) => call.find((step) => step.kind === "where" && step.field === "patientId")?.value.length),
    [25, 25, 25, 25, 1, 1]
  );
  assert.ok(calls.every((call) => call.some((step) => step.kind === "where" && step.field === "patientId" && step.operator === "in")));

  calls.length = 0;
  await store.listSessionsForClaimMonth("org_123", "2026-06", {
    patientId: "pat_priority",
    patientIds
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.some((step) => (
    step.kind === "where"
    && step.field === "patientId"
    && step.operator === "=="
    && step.value === "pat_priority"
  ))));

  calls.length = 0;
  await store.listSessionsForClaimMonth("org_123", "2026-06", {
    patientIds: Array.from({ length: 101 }, (_, index) => `pat_${index}`)
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.some((step) => step.kind === "where" && step.field === "patientId")));
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

function recordingMonthlyCollection(calls) {
  const createQuery = (steps = []) => ({
    where(field, operator, value) {
      return createQuery([...steps, { kind: "where", field, operator, value }]);
    },
    orderBy(field, direction) {
      return createQuery([...steps, { kind: "orderBy", field, direction }]);
    },
    limit(value) {
      return createQuery([...steps, { kind: "limit", value }]);
    },
    async get() {
      calls.push(steps);
      return {
        docs: [{
          data: () => ({
            feeSessionId: "fee_shared",
            patientId: "pat_000",
            claimMonth: "2026-06",
            serviceDate: "2026-06-01",
            createdAt: "2026-06-01T00:00:00.000Z"
          })
        }]
      };
    }
  });
  return createQuery();
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

test("LazyFirestoreFeeStore は server.js が使う全メソッドを delegate している", async () => {
  // server.js は `typeof feeStore.method === "function"` でフォールバックするため、
  // delegate漏れは「保存せずエコー」等の沈黙劣化になる(STGで実際に発生した)。
  const { LazyFirestoreFeeStore } = await import("../src/store/create-store.js");
  const { readFileSync } = await import("node:fs");
  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const usedMethods = [...new Set(
    [...serverSource.matchAll(/feeStore\.([a-zA-Z]+)/gu)].map((match) => match[1])
  )];
  assert.ok(usedMethods.length >= 15, "抽出が機能していること");
  const missing = usedMethods.filter((method) => typeof LazyFirestoreFeeStore.prototype[method] !== "function");
  assert.deepEqual(missing, [], `LazyFirestoreFeeStore に delegate が無いメソッド: ${missing.join(", ")}`);
});

test("LazyFirestorePlatformStore は fee-api が使う全メソッドを delegate している", async () => {
  const { LazyFirestorePlatformStore } = await import("../../platform-api/src/store/create-store.js");
  const { readFileSync } = await import("node:fs");
  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const usedMethods = [...new Set(
    [...serverSource.matchAll(/platformStore\.([a-zA-Z]+)/gu)].map((match) => match[1])
  )];
  assert.ok(usedMethods.length >= 5, "抽出が機能していること");
  const missing = usedMethods.filter((method) => typeof LazyFirestorePlatformStore.prototype[method] !== "function");
  assert.deepEqual(missing, [], `LazyFirestorePlatformStore に delegate が無いメソッド: ${missing.join(", ")}`);
});
