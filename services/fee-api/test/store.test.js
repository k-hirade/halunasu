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
  const lineReviewItem = reviewItems.find((item) => item.sourceType === "line_item");
  const decided = store.decideReviewItem("org_123", session.feeSessionId, lineReviewItem.reviewItemId, {
    status: "approved"
  });
  const approvedReceiptDraft = store.getReceiptDraft("org_123", session.feeSessionId);

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
  assert.equal(receiptDraft.totalPoints, 0);
  assert.equal(receiptDraft.pendingLineCount, 1);
  assert.ok(reviewItems.length >= 1);
  assert.equal(decided.feeSession.reviewDecisions[lineReviewItem.reviewItemId].status, "approved");
  assert.equal(approvedReceiptDraft.totalPoints, 88);
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

test("calculation job leases reject duplicate claims and stale worker updates", () => {
  let counter = 0;
  let now = new Date("2026-06-01T00:00:00.000Z");
  const store = new MemoryFeeStore({
    now: () => now,
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-01"
  });
  const { calculationJob } = store.createCalculationJob("org_123", session.feeSessionId);
  const jobId = calculationJob.calculationJobId;

  const first = store.claimCalculationJob("org_123", session.feeSessionId, jobId, {
    leaseToken: "lease_first",
    leaseExpiresAt: "2026-06-01T00:15:00.000Z",
    now
  });
  const duplicate = store.claimCalculationJob("org_123", session.feeSessionId, jobId, {
    leaseToken: "lease_duplicate",
    leaseExpiresAt: "2026-06-01T00:15:00.000Z",
    now
  });

  assert.equal(first.claimed, true);
  assert.equal(first.calculationJob.attemptCount, 1);
  assert.equal(first.feeSession.activeCalculationJobId, jobId);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.calculationJob.leaseToken, "lease_first");
  assert.throws(
    () => store.updateCalculationJob("org_123", session.feeSessionId, jobId, {
      status: "enqueue_failed"
    }, {
      expectedStatus: "queued",
      expectedEnqueueStatus: "pending"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_CALCULATION_JOB_STATE_CONFLICT"
  );
  assert.throws(
    () => store.updateCalculationJob("org_123", session.feeSessionId, jobId, { phase: "failed" }, {
      expectedLeaseToken: "lease_duplicate"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_CALCULATION_JOB_LEASE_CONFLICT"
  );

  now = new Date("2026-06-01T00:16:00.000Z");
  assert.throws(
    () => store.updateSession("org_123", session.feeSessionId, { clinicalText: "stale worker" }, {
      calculationJobId: jobId,
      expectedLeaseToken: "lease_first"
    }),
    (error) => error.statusCode === 409
  );
  assert.throws(
    () => store.saveCalculation("org_123", session.feeSessionId, {
      provider: "stale_worker",
      status: "completed",
      totalPoints: 999,
      lineItems: []
    }, {
      calculationJobId: jobId,
      expectedLeaseToken: "lease_first"
    }),
    (error) => error.statusCode === 409
  );
  assert.throws(
    () => store.updateCalculationJob("org_123", session.feeSessionId, jobId, { phase: "complete" }, {
      expectedLeaseToken: "lease_first"
    }),
    (error) => error.statusCode === 409
  );
  const reclaimed = store.claimCalculationJob("org_123", session.feeSessionId, jobId, {
    leaseToken: "lease_second",
    leaseExpiresAt: "2026-06-01T00:31:00.000Z",
    now
  });
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.calculationJob.attemptCount, 2);
  assert.equal(reclaimed.feeSession.status, "calculating");
  assert.equal(reclaimed.feeSession.activeCalculationJobId, jobId);
  assert.throws(
    () => store.updateCalculationJob("org_123", session.feeSessionId, jobId, { status: "failed" }, {
      expectedLeaseToken: "lease_first"
    }),
    (error) => error.statusCode === 409
  );
  const currentWorkerUpdate = store.updateSession("org_123", session.feeSessionId, {
    clinicalText: "current worker"
  }, {
    calculationJobId: jobId,
    expectedLeaseToken: "lease_second"
  });
  assert.equal(currentWorkerUpdate.feeSession.clinicalText, "current worker");
  const completed = store.updateCalculationJob("org_123", session.feeSessionId, jobId, {
    status: "succeeded",
    leaseToken: null,
    leaseExpiresAt: null
  }, { expectedLeaseToken: "lease_second" });
  assert.equal(completed.calculationJob.status, "succeeded");
});

test("memory store reserves one latest calculation job and blocks unleased session mutations", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-06-02T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-02"
  });
  const first = store.createCalculationJob("org_123", session.feeSessionId).calculationJob;
  const reserved = store.getSession("org_123", session.feeSessionId);

  assert.equal(reserved.status, "calculating");
  assert.equal(reserved.activeCalculationJobId, first.calculationJobId);
  assert.equal(reserved.latestCalculationJobId, first.calculationJobId);
  assert.throws(
    () => store.createCalculationJob("org_123", session.feeSessionId),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  assert.equal(store.calculationJobsForOrg("org_123").size, 1, "a rejected reservation creates no orphan job");

  const blockedMutations = [
    () => store.updateSession("org_123", session.feeSessionId, { clinicalText: "new input" }),
    () => store.saveCalculation("org_123", session.feeSessionId, {
      provider: "sync_worker",
      status: "completed",
      totalPoints: 1,
      lineItems: []
    }),
    () => store.decideReviewItems("org_123", session.feeSessionId, [])
  ];
  for (const mutation of blockedMutations) {
    assert.throws(
      mutation,
      (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
    );
  }

  store.updateSession("org_123", session.feeSessionId, {
    status: "failed",
    activeCalculationJobId: null
  }, { expectedActiveCalculationJobId: first.calculationJobId });
  const second = store.createCalculationJob("org_123", session.feeSessionId).calculationJob;
  const secondClaim = store.claimCalculationJob("org_123", session.feeSessionId, second.calculationJobId, {
    leaseToken: "lease_second_job",
    leaseExpiresAt: "2026-06-02T00:15:00.000Z",
    now: "2026-06-02T00:00:00.000Z"
  });
  store.saveCalculation("org_123", session.feeSessionId, {
    provider: "async_worker",
    status: "completed",
    totalPoints: 2,
    lineItems: []
  }, {
    calculationJobId: second.calculationJobId,
    expectedLeaseToken: secondClaim.calculationJob.leaseToken
  });
  store.updateCalculationJob("org_123", session.feeSessionId, second.calculationJobId, {
    status: "succeeded",
    leaseToken: null,
    leaseExpiresAt: null
  }, { expectedLeaseToken: secondClaim.calculationJob.leaseToken });

  assert.throws(
    () => store.claimCalculationJob("org_123", session.feeSessionId, first.calculationJobId, {
      leaseToken: "stale_first_job",
      leaseExpiresAt: "2026-06-02T00:15:00.000Z",
      now: "2026-06-02T00:00:01.000Z"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  const completedSession = store.getSession("org_123", session.feeSessionId);
  assert.equal(completedSession.activeCalculationJobId, null);
  assert.equal(completedSession.latestCalculationJobId, second.calculationJobId);
  assert.equal(completedSession.calculationResult.totalPoints, 2);
});

test("a stale worker cannot mutate a session after a newer job completes", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-06-03T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-03"
  });
  const first = store.createCalculationJob("org_123", session.feeSessionId).calculationJob;
  const firstClaim = store.claimCalculationJob("org_123", session.feeSessionId, first.calculationJobId, {
    leaseToken: "lease_first_window",
    leaseExpiresAt: "2026-06-03T00:30:00.000Z",
    now: "2026-06-03T00:00:00.000Z"
  });
  store.saveCalculation("org_123", session.feeSessionId, {
    provider: "first_worker",
    status: "completed",
    totalPoints: 1,
    lineItems: []
  }, {
    calculationJobId: first.calculationJobId,
    expectedLeaseToken: firstClaim.calculationJob.leaseToken
  });

  const second = store.createCalculationJob("org_123", session.feeSessionId).calculationJob;
  const secondClaim = store.claimCalculationJob("org_123", session.feeSessionId, second.calculationJobId, {
    leaseToken: "lease_second_window",
    leaseExpiresAt: "2026-06-03T00:30:00.000Z",
    now: "2026-06-03T00:00:01.000Z"
  });
  store.saveCalculation("org_123", session.feeSessionId, {
    provider: "second_worker",
    status: "completed",
    totalPoints: 2,
    lineItems: []
  }, {
    calculationJobId: second.calculationJobId,
    expectedLeaseToken: secondClaim.calculationJob.leaseToken
  });

  assert.throws(
    () => store.updateSession("org_123", session.feeSessionId, {
      status: "failed",
      calculationProgress: { phase: "failed" }
    }, {
      calculationJobId: first.calculationJobId,
      expectedLeaseToken: firstClaim.calculationJob.leaseToken,
      allowClearedActiveCalculationJob: true
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_CALCULATION_JOB_LEASE_CONFLICT"
  );
  const completed = store.getSession("org_123", session.feeSessionId);
  assert.equal(completed.latestCalculationJobId, second.calculationJobId);
  assert.equal(completed.calculationResult.provider, "second_worker");
  assert.equal(completed.calculationResult.totalPoints, 2);
  assert.notEqual(completed.status, "failed");
});

test("Firestore calculation job claim and lease CAS run in transactions", async () => {
  let counter = 0;
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = await store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-01"
  });
  const { calculationJob } = await store.createCalculationJob("org_123", session.feeSessionId);
  const jobId = calculationJob.calculationJobId;
  const first = await store.claimCalculationJob("org_123", session.feeSessionId, jobId, {
    leaseToken: "lease_firestore",
    leaseExpiresAt: "2026-06-01T00:15:00.000Z",
    now: "2026-06-01T00:00:00.000Z"
  });
  const duplicate = await store.claimCalculationJob("org_123", session.feeSessionId, jobId, {
    leaseToken: "lease_duplicate",
    leaseExpiresAt: "2026-06-01T00:15:00.000Z",
    now: "2026-06-01T00:00:01.000Z"
  });

  assert.equal(first.claimed, true);
  assert.equal(first.feeSession.activeCalculationJobId, jobId);
  assert.equal(duplicate.alreadyRunning, true);
  await assert.rejects(
    store.updateCalculationJob("org_123", session.feeSessionId, jobId, {
      status: "enqueue_failed"
    }, {
      expectedStatus: "queued",
      expectedEnqueueStatus: "pending"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_CALCULATION_JOB_STATE_CONFLICT"
  );
  const sessionUpdate = await store.updateSession("org_123", session.feeSessionId, {
    clinicalText: "lease protected"
  }, {
    calculationJobId: jobId,
    expectedLeaseToken: "lease_firestore"
  });
  assert.equal(sessionUpdate.feeSession.clinicalText, "lease protected");
  await assert.rejects(
    store.updateCalculationJob("org_123", session.feeSessionId, jobId, { phase: "complete" }, {
      expectedLeaseToken: "lease_duplicate"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_CALCULATION_JOB_LEASE_CONFLICT"
  );
  assert.equal(db.transactionCount, 6);
  assert.equal(
    docs.get(`organizations/org_123/fee_sessions/${session.feeSessionId}/calculationJobs/${jobId}`).leaseToken,
    "lease_firestore"
  );
});

test("Firestore atomically reserves the latest job and rejects stale claims and unleased writes", async () => {
  let counter = 0;
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const session = await store.createSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    createdByMemberId: "mem_123",
    serviceDate: "2026-06-02"
  });
  const first = (await store.createCalculationJob("org_123", session.feeSessionId)).calculationJob;

  await assert.rejects(
    store.createCalculationJob("org_123", session.feeSessionId),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  await assert.rejects(
    store.updateSession("org_123", session.feeSessionId, { clinicalText: "new input" }),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  await assert.rejects(
    store.saveCalculation("org_123", session.feeSessionId, {
      provider: "sync_worker",
      status: "completed",
      totalPoints: 1,
      lineItems: []
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  await assert.rejects(
    store.decideReviewItems("org_123", session.feeSessionId, []),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );

  await store.updateSession("org_123", session.feeSessionId, {
    status: "failed",
    activeCalculationJobId: null
  }, { expectedActiveCalculationJobId: first.calculationJobId });
  const second = (await store.createCalculationJob("org_123", session.feeSessionId)).calculationJob;
  const claim = await store.claimCalculationJob("org_123", session.feeSessionId, second.calculationJobId, {
    leaseToken: "lease_firestore_second",
    leaseExpiresAt: "2026-06-02T00:15:00.000Z",
    now: "2026-06-02T00:00:00.000Z"
  });
  await store.saveCalculation("org_123", session.feeSessionId, {
    provider: "async_worker",
    status: "completed",
    totalPoints: 2,
    lineItems: []
  }, {
    calculationJobId: second.calculationJobId,
    expectedLeaseToken: claim.calculationJob.leaseToken
  });
  await store.updateCalculationJob("org_123", session.feeSessionId, second.calculationJobId, {
    status: "succeeded",
    leaseToken: null,
    leaseExpiresAt: null
  }, { expectedLeaseToken: claim.calculationJob.leaseToken });

  await assert.rejects(
    store.claimCalculationJob("org_123", session.feeSessionId, first.calculationJobId, {
      leaseToken: "stale_firestore_first",
      leaseExpiresAt: "2026-06-02T00:15:00.000Z",
      now: "2026-06-02T00:00:01.000Z"
    }),
    (error) => error.statusCode === 409 && error.code === "FEE_SESSION_CALCULATION_CONFLICT"
  );
  const completedSession = await store.getSession("org_123", session.feeSessionId);
  assert.equal(completedSession.activeCalculationJobId, null);
  assert.equal(completedSession.latestCalculationJobId, second.calculationJobId);
  assert.equal(completedSession.calculationResult.totalPoints, 2);
});

test("Firestore mutation fails closed when transactions are unavailable", async () => {
  const store = new FirestoreFeeStore({ db: {} });
  await assert.rejects(
    store.updateSession("org_123", "fee_123", { clinicalText: "unsafe fallback" }),
    (error) => error.name === "ConfigurationError" && /transactions are required/.test(error.message)
  );
});

test("Firestore fee store strips undefined review decision fields before persisting", async () => {
  let counter = 0;
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
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
  assert.equal(db.transactionCount, 3, "calculation and review mutations use Firestore transactions");
});

function fakeFirestoreDb(docs) {
  const db = {
    transactionCount: 0,
    async runTransaction(callback) {
      db.transactionCount += 1;
      return callback({
        get: (ref) => ref.get(),
        set: (ref, value) => ref.set(value),
        update: (ref, value) => ref.update(value)
      });
    },
    doc(path) {
      return {
        path,
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
  return db;
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
