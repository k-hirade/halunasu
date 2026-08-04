import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFeeStoreFromEnv,
  feeProjectId,
  LazyFirestoreFeeStore
} from "../src/store/create-store.js";
import { FirestoreFeeStore } from "../src/store/firestore-store.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

function acknowledgementSidecarDraftInput(overrides = {}) {
  return {
    orgId: "org_123",
    sidecarDraftId: "sidecar_ack_001",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-ack-001",
    sourceRecordDisplayId: "10010718",
    idempotencyKeyHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "user",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123",
    expiresAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

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

test("LazyFirestoreFeeStore forwards sidecar acknowledgement operations", async () => {
  const store = new LazyFirestoreFeeStore();
  store.call = async (...args) => args;

  assert.deepEqual(
    await store.setSidecarCandidateAcknowledgement("org_123", "sidecar_123", { acknowledged: true }),
    ["setSidecarCandidateAcknowledgement", "org_123", "sidecar_123", { acknowledged: true }]
  );
  assert.deepEqual(
    await store.reconcileSidecarCandidateAcknowledgements("org_123", "sidecar_123", { activeCandidates: [] }),
    ["reconcileSidecarCandidateAcknowledgements", "org_123", "sidecar_123", { activeCandidates: [] }]
  );
  assert.deepEqual(
    await store.completeSidecarCandidateAcknowledgementAudit("org_123", "sidecar_123", "aud_123"),
    ["completeSidecarCandidateAcknowledgementAudit", "org_123", "sidecar_123", "aud_123"]
  );
  assert.deepEqual(
    await store.getPatientChargeContract("org_123", "fac_123", "pat_123", "home_medical_transport"),
    ["getPatientChargeContract", "org_123", "fac_123", "pat_123", "home_medical_transport"]
  );
  assert.deepEqual(
    await store.putPatientChargeContractSetting("org_123", { handling: "waive" }),
    ["putPatientChargeContractSetting", "org_123", { handling: "waive" }]
  );
  assert.deepEqual(
    await store.completePatientChargeContractAudit("org_123", "pcc_123", "aud_123"),
    ["completePatientChargeContractAudit", "org_123", "pcc_123", "aud_123"]
  );
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

test("MemoryFeeStore versions and reconciles sidecar candidate acknowledgements", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const created = store.upsertSidecarCalculationDraft(acknowledgementSidecarDraftInput());
  const calculated = store.saveSidecarCalculation("org_123", created.sidecarDraft.sidecarDraftId, {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{
      lineId: "line_1",
      code: "114001110",
      name: "在宅患者訪問診療料",
      points: 890,
      totalPoints: 890
    }]
  });
  const calculationBefore = structuredClone(calculated.calculationResult);
  const input = {
    acknowledged: true,
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    expectedAcknowledgementVersion: 0,
    candidateKey: "review_issue:issue_1",
    candidateId: "issue_1",
    candidateFingerprint: "c".repeat(64),
    updatedByMemberId: "mem_123",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_123"
  };
  const acknowledged = store.setSidecarCandidateAcknowledgement(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    input
  );
  const repeated = store.setSidecarCandidateAcknowledgement(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    input
  );

  assert.equal(acknowledged.changed, true);
  assert.equal(acknowledged.acknowledgement.status, "acknowledged");
  assert.equal(acknowledged.acknowledgement.version, 1);
  assert.equal(Object.keys(acknowledged.sidecarDraft.candidateAcknowledgementAuditOutbox).length, 1);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.sidecarDraft.calculationResult, calculationBefore);
  assert.throws(() => store.setSidecarCandidateAcknowledgement(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    { ...input, acknowledged: false }
  ), (error) => error.statusCode === 409);
  const excluded = store.setSidecarCandidateAcknowledgement(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    {
      ...input,
      acknowledged: undefined,
      status: "excluded",
      expectedAcknowledgementVersion: 1
    }
  );
  assert.equal(excluded.changed, true);
  assert.equal(excluded.acknowledgement.status, "excluded");
  assert.equal(excluded.acknowledgement.version, 2);
  assert.deepEqual(excluded.sidecarDraft.calculationResult, calculationBefore);

  const reconciled = store.reconcileSidecarCandidateAcknowledgements(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    {
      expectedSourceRevision: 1,
      expectedCalculationRevision: 1,
      activeCandidates: [],
      invalidatedByMemberId: "mem_recalculator",
      invalidatedByLoginId: "recalculator@example.com",
      invalidatedFromDeviceId: "device_recalculator"
    }
  );
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.invalidated[0].status, "stale");
  assert.equal(reconciled.invalidated[0].staleFromStatus, "excluded");
  assert.equal(reconciled.invalidated[0].staleReason, "candidate_missing");
  const [firstAuditEventId] = Object.keys(reconciled.sidecarDraft.candidateAcknowledgementAuditOutbox);
  const completedAudit = store.completeSidecarCandidateAcknowledgementAudit(
    "org_123",
    created.sidecarDraft.sidecarDraftId,
    firstAuditEventId
  );
  assert.equal(completedAudit.changed, true);
  assert.equal(
    Object.hasOwn(completedAudit.sidecarDraft.candidateAcknowledgementAuditOutbox, firstAuditEventId),
    false
  );
  assert.deepEqual(reconciled.sidecarDraft.calculationResult, calculationBefore);
});

test("Firestore transactions persist sidecar acknowledgement CAS and stale reconciliation", async () => {
  let counter = 0;
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const draftInput = acknowledgementSidecarDraftInput({ sidecarDraftId: "sidecar_firestore_ack" });
  await store.upsertSidecarCalculationDraft(draftInput);
  const calculated = await store.saveSidecarCalculation("org_123", draftInput.sidecarDraftId, {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{
      lineId: "line_1",
      code: "114001110",
      name: "在宅患者訪問診療料",
      points: 890,
      totalPoints: 890
    }]
  });
  const calculationBefore = structuredClone(calculated.calculationResult);
  const acknowledgementInput = {
    acknowledged: true,
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    expectedAcknowledgementVersion: 0,
    candidateKey: "line_item:line_1",
    candidateId: "line_1",
    candidateFingerprint: "d".repeat(64),
    updatedByMemberId: "mem_123",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_123"
  };
  const acknowledged = await store.setSidecarCandidateAcknowledgement(
    "org_123",
    draftInput.sidecarDraftId,
    acknowledgementInput
  );
  const repeated = await store.setSidecarCandidateAcknowledgement(
    "org_123",
    draftInput.sidecarDraftId,
    acknowledgementInput
  );

  assert.equal(acknowledged.changed, true);
  assert.equal(repeated.changed, false);
  await assert.rejects(
    store.setSidecarCandidateAcknowledgement("org_123", draftInput.sidecarDraftId, {
      ...acknowledgementInput,
      acknowledged: false
    }),
    (error) => error.statusCode === 409
  );
  const excluded = await store.setSidecarCandidateAcknowledgement(
    "org_123",
    draftInput.sidecarDraftId,
    {
      ...acknowledgementInput,
      acknowledged: undefined,
      status: "excluded",
      expectedAcknowledgementVersion: 1
    }
  );
  assert.equal(excluded.changed, true);
  assert.equal(excluded.acknowledgement.status, "excluded");
  assert.equal(excluded.acknowledgement.version, 2);
  const reconciled = await store.reconcileSidecarCandidateAcknowledgements(
    "org_123",
    draftInput.sidecarDraftId,
    {
      expectedSourceRevision: 1,
      expectedCalculationRevision: 1,
      activeCandidates: [{
        candidateKey: acknowledgementInput.candidateKey,
        candidateFingerprint: "e".repeat(64)
      }],
      invalidatedByMemberId: "mem_recalculator",
      invalidatedByLoginId: "recalculator@example.com",
      invalidatedFromDeviceId: "device_recalculator"
    }
  );
  const stored = docs.get(
    "organizations/org_123/sidecar_calculation_drafts/sidecar_firestore_ack"
  );

  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.invalidated[0].staleReason, "candidate_fingerprint_changed");
  assert.equal(reconciled.invalidated[0].staleFromStatus, "excluded");
  const [firstAuditEventId] = Object.keys(stored.candidateAcknowledgementAuditOutbox);
  const completedAudit = await store.completeSidecarCandidateAcknowledgementAudit(
    "org_123",
    draftInput.sidecarDraftId,
    firstAuditEventId
  );
  assert.equal(completedAudit.changed, true);
  assert.equal(stored.candidateAcknowledgements[acknowledgementInput.candidateKey].status, "stale");
  assert.deepEqual(stored.calculationResult, calculationBefore);
  assert.equal(stored.calculationResult.totalPoints, 890);
  assert.ok(db.transactionCount >= 6);
});

test("Firestore keeps sidecar drafts isolated and adopts exactly once in one transaction", async () => {
  let counter = 0;
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const draftInput = {
    orgId: "org_123",
    sidecarDraftId: "sidecar_001",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    sourceRecordDisplayId: "10010718",
    idempotencyKeyHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "user",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123",
    expiresAt: "2026-08-17T00:00:00.000Z"
  };
  const created = await store.upsertSidecarCalculationDraft(draftInput);
  await store.saveSidecarCalculation("org_123", created.sidecarDraft.sidecarDraftId, {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{
      lineId: "line_1",
      code: "114001110",
      name: "在宅患者訪問診療料",
      points: 890,
      totalPoints: 890,
      status: "confirmed",
      reviewRequired: false
    }]
  });

  assert.equal([...docs.keys()].some((path) => path.includes("/fee_sessions/")), false);
  const storedDraft = docs.get("organizations/org_123/sidecar_calculation_drafts/sidecar_001");
  assert.equal(storedDraft.calculationResult.lineItems[0].status, "candidate");
  assert.ok(storedDraft.purgeAt instanceof Date);
  assert.equal(storedDraft.purgeAt.toISOString(), draftInput.expiresAt);

  const sessionInput = {
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: storedDraft.clinicalText,
    createdByMemberId: "mem_123",
    sourceSystem: "homis_sidecar_adopted"
  };
  const adopted = await store.adoptSidecarCalculationDraft("org_123", "sidecar_001", sessionInput);
  const adoptedAgain = await store.adoptSidecarCalculationDraft("org_123", "sidecar_001", sessionInput);

  assert.equal(adopted.alreadyAdopted, false);
  assert.equal(adoptedAgain.alreadyAdopted, true);
  assert.equal(adoptedAgain.feeSession.feeSessionId, adopted.feeSession.feeSessionId);
  assert.equal([...docs.keys()].filter((path) => /\/fee_sessions\/[^/]+$/.test(path)).length, 1);
  assert.equal([...docs.keys()].filter((path) => /\/sidecar_adoption_guards\/[^/]+$/.test(path)).length, 1);
  assert.equal(docs.get("organizations/org_123/sidecar_calculation_drafts/sidecar_001").lifecycleStatus, "adopted");
});

test("sidecar adoption guard blocks the same visit across record-key versions but permits another visit", async () => {
  let counter = 0;
  const docs = new Map();
  const store = new FirestoreFeeStore({
    db: fakeFirestoreDb(docs),
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const baseDraft = {
    orgId: "org_123",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordDisplayId: "10010718",
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "dom",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123",
    expiresAt: "2026-08-17T00:00:00.000Z"
  };
  for (const [sidecarDraftId, sourceRecordId, idempotencyKeyHash, receptionTime, setting] of [
    ["sidecar_v4", "legacy-record-001", "a".repeat(64), "14:30", "home_visit"],
    ["sidecar_v5", "homis-visible-record-v1\u001fhomis\u001f1001", "c".repeat(64), "14:30", "home_visit"],
    ["sidecar_other_time", "homis-visible-record-v1\u001fhomis\u001f1001-other-time", "d".repeat(64), "14:45", "home_visit"],
    ["sidecar_house_call", "homis-visible-record-v1\u001fhomis\u001f1001-house-call", "e".repeat(64), "14:30", "house_call"]
  ]) {
    await store.upsertSidecarCalculationDraft({
      ...baseDraft,
      sidecarDraftId,
      sourceRecordId,
      idempotencyKeyHash,
      receptionTime,
      setting
    });
  }
  const sessionInput = (receptionTime, setting = "home_visit") => ({
    orgId: "org_123",
    patientId: "pat_123",
    canonicalPatientId: "pat_123",
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime,
    setting,
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123",
    sourceSystem: "homis_sidecar_adopted"
  });

  await store.adoptSidecarCalculationDraft("org_123", "sidecar_v4", sessionInput("14:30"));
  await assert.rejects(
    store.adoptSidecarCalculationDraft("org_123", "sidecar_v5", sessionInput("14:30")),
    (error) => error.statusCode === 409 && /already been adopted/u.test(error.message)
  );
  const otherTime = await store.adoptSidecarCalculationDraft(
    "org_123",
    "sidecar_other_time",
    sessionInput("14:45")
  );
  const houseCall = await store.adoptSidecarCalculationDraft(
    "org_123",
    "sidecar_house_call",
    sessionInput("14:30", "house_call")
  );
  assert.equal(otherTime.alreadyAdopted, false);
  assert.equal(houseCall.alreadyAdopted, false);
  assert.equal([...docs.keys()].filter((path) => /\/sidecar_adoption_guards\/[^/]+$/.test(path)).length, 3);
});

test("MemoryFeeStore blocks the same adopted visit across record-key versions", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const baseDraft = {
    orgId: "org_123",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordDisplayId: "10010718",
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "dom",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123"
  };
  store.upsertSidecarCalculationDraft({
    ...baseDraft,
    sidecarDraftId: "sidecar_v4",
    sourceRecordId: "legacy-record-001",
    idempotencyKeyHash: "a".repeat(64)
  });
  store.upsertSidecarCalculationDraft({
    ...baseDraft,
    sidecarDraftId: "sidecar_v5",
    sourceRecordId: "homis-visible-record-v1\u001fhomis\u001f1001",
    idempotencyKeyHash: "c".repeat(64)
  });
  const sessionInput = {
    orgId: "org_123",
    patientId: "pat_123",
    canonicalPatientId: "pat_123",
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123",
    sourceSystem: "homis_sidecar_adopted"
  };

  store.adoptSidecarCalculationDraft("org_123", "sidecar_v4", sessionInput);
  assert.throws(
    () => store.adoptSidecarCalculationDraft("org_123", "sidecar_v5", sessionInput),
    (error) => error.statusCode === 409 && /already been adopted/u.test(error.message)
  );
});

test("MemoryFeeStore rejects an incomplete legacy visit with actionable recovery guidance", () => {
  const store = new MemoryFeeStore({
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_001`
  });
  store.upsertSidecarCalculationDraft({
    orgId: "org_123",
    sidecarDraftId: "sidecar_legacy_incomplete",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "legacy-record-incomplete",
    sourceRecordDisplayId: "10010718",
    idempotencyKeyHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "dom",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-18",
    receptionTime: null,
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_123"
  });

  assert.throws(
    () => store.adoptSidecarCalculationDraft("org_123", "sidecar_legacy_incomplete", {
      orgId: "org_123",
      patientId: "pat_123",
      canonicalPatientId: "pat_123",
      facilityId: "fac_123",
      serviceDate: "2026-07-18",
      setting: "home_visit",
      clinicalText: "O: 訪問診療を実施。",
      createdByMemberId: "mem_123",
      sourceSystem: "homis_sidecar_adopted"
    }),
    (error) => error.statusCode === 409
      && error.code === "SIDECAR_ADOPTION_VISIT_FINGERPRINT_INCOMPLETE"
      && /新しい拡張機能でHOMIS画面を再読み取り/u.test(error.message)
      && /算定案を再作成/u.test(error.message)
  );
});

test("MemoryFeeStore lists same-date sidecar drafts within the organization and facility", () => {
  let counter = 0;
  const store = new MemoryFeeStore({
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const base = {
    orgId: "org_123",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    idempotencyKeyHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "user",
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_123",
    serviceDate: "2026-07-30",
    setting: "home_visit",
    clinicalText: "同一世帯として同日に訪問。",
    createdByMemberId: "mem_123"
  };
  store.upsertSidecarCalculationDraft({
    ...base,
    sidecarDraftId: "sidecar_001",
    sidecarPatientKey: "patient_001",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    receptionTime: "14:30"
  });
  store.upsertSidecarCalculationDraft({
    ...base,
    sidecarDraftId: "sidecar_002",
    sidecarPatientKey: "patient_002",
    externalPatientId: "1002",
    sourceRecordId: "record-002",
    receptionTime: "14:45"
  });
  store.upsertSidecarCalculationDraft({
    ...base,
    sidecarDraftId: "sidecar_other_facility",
    sidecarPatientKey: "patient_003",
    externalPatientId: "1003",
    sourceRecordId: "record-003",
    facilityId: "fac_other"
  });

  const drafts = store.listSidecarDraftsForServiceDate("org_123", {
    serviceDate: "2026-07-30",
    facilityId: "fac_123",
    excludeDraftId: "sidecar_002"
  });

  assert.deepEqual(drafts.map((draft) => draft.sidecarDraftId), ["sidecar_001"]);
});

test("Firestore same-day lookup filters facility, date, and lifecycle before applying its limit", async () => {
  const calls = [];
  const store = new FirestoreFeeStore({ db: {} });
  store.orgCollection = () => recordingSidecarDraftCollection(calls);

  const drafts = await store.listSidecarDraftsForServiceDate("org_123", {
    serviceDate: "2026-07-30",
    facilityId: "fac_123",
    excludeDraftId: "sidecar_current",
    limit: 200
  });

  assert.deepEqual(drafts.map((draft) => draft.sidecarDraftId), ["sidecar_sibling"]);
  assert.deepEqual(calls, [[
    { kind: "where", field: "facilityId", operator: "==", value: "fac_123" },
    { kind: "where", field: "serviceDate", operator: "==", value: "2026-07-30" },
    {
      kind: "where",
      field: "lifecycleStatus",
      operator: "in",
      value: ["draft", "adopted"]
    },
    { kind: "limit", value: 201 }
  ]]);
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

function recordingSidecarDraftCollection(calls) {
  const createQuery = (steps = []) => ({
    where(field, operator, value) {
      return createQuery([...steps, { kind: "where", field, operator, value }]);
    },
    limit(value) {
      return createQuery([...steps, { kind: "limit", value }]);
    },
    async get() {
      calls.push(steps);
      return {
        docs: [
          {
            data: () => ({
              sidecarDraftId: "sidecar_current",
              facilityId: "fac_123",
              serviceDate: "2026-07-30",
              lifecycleStatus: "draft",
              receptionTime: "14:45"
            })
          },
          {
            data: () => ({
              sidecarDraftId: "sidecar_sibling",
              facilityId: "fac_123",
              serviceDate: "2026-07-30",
              lifecycleStatus: "adopted",
              receptionTime: "14:30"
            })
          }
        ]
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

test("MemoryFeeStore stores, selects, and deletes dedicated extraction snapshots", () => {
  const store = new MemoryFeeStore({
    now: () => new Date("2026-06-20T00:00:00.000Z")
  });
  store.saveExtractionSnapshot("org_1", {
    snapshotId: "extract_1",
    canonicalPatientId: "pat_1",
    sourceSessionId: "fee_1",
    serviceDate: "2026-06-01",
    extractedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-07-01T00:00:00.000Z",
    schemaVersion: 1,
    promptVersion: "prompt-v1",
    lines: []
  });
  store.saveExtractionSnapshot("org_1", {
    snapshotId: "extract_2",
    canonicalPatientId: "pat_1",
    sourceSessionId: "fee_2",
    serviceDate: "2026-06-15",
    extractedAt: "2026-06-15T00:00:00.000Z",
    expiresAt: "2026-07-15T00:00:00.000Z",
    schemaVersion: 1,
    promptVersion: "prompt-v1",
    lines: []
  });

  assert.equal(
    store.getLatestExtractionSnapshotForPatient("org_1", ["pat_1"])?.sourceSessionId,
    "fee_2"
  );
  assert.equal(
    store.getLatestExtractionSnapshotForPatient("org_1", ["pat_1"], {
      excludeSourceSessionId: "fee_2"
    })?.sourceSessionId,
    "fee_1"
  );
  assert.deepEqual(store.deleteExtractionSnapshotsForSource("org_1", "fee_2"), { deletedCount: 1 });
  assert.equal(
    store.getLatestExtractionSnapshotForPatient("org_1", ["pat_1"])?.sourceSessionId,
    "fee_1"
  );
});

test("patient charge contracts are effective-dated and revision locked in memory", () => {
  const store = new MemoryFeeStore({
    now: () => new Date("2026-08-03T10:00:00.000Z")
  });
  store.upsertSidecarCalculationDraft(acknowledgementSidecarDraftInput({
    orgId: "org_1",
    sidecarDraftId: "sidecar_charge_1",
    sidecarPatientKey: "pat_1",
    canonicalPatientId: "pat_1",
    canonicalPatientIdSource: "patient_identifier",
    canonicalPatientResolutionStatus: "resolved",
    facilityId: "fac_1",
    serviceDate: "2026-08-03",
    expiresAt: "2026-08-17T00:00:00.000Z"
  }));
  const base = {
    sidecarDraftId: "sidecar_charge_1",
    expectedDraftSourceRevision: 1,
    expectedDraftCalculationRevision: 0,
    expectedDraftServiceDate: "2026-08-03",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    chargeType: "home_medical_transport",
    handling: "charge",
    amountMode: "actual",
    amountYen: null,
    effectiveFrom: "2026-08-03",
    effectiveTo: null,
    expectedRevision: 0,
    updatedByMemberId: "mem_1",
    updatedByLoginId: "member@example.test",
    updatedFromDeviceId: "device_1"
  };
  const created = store.putPatientChargeContractSetting("org_1", base);
  assert.equal(created.patientChargeContract.revision, 1);
  assert.equal(created.patientChargeContract.settingEvents[0].handling, "charge");
  assert.equal(store.getPatientChargeContract(
    "org_1",
    "fac_1",
    "pat_1",
    "home_medical_transport"
  )?.patientChargeContractId, created.patientChargeContract.patientChargeContractId);
  assert.equal(Object.keys(created.patientChargeContract.auditOutbox).length, 1);

  const revised = store.putPatientChargeContractSetting("org_1", {
    ...base,
    handling: "waive",
    amountMode: null,
    expectedRevision: 1,
    effectiveFrom: "2026-09-01"
  });
  assert.equal(revised.previousSetting.handling, "charge");
  assert.equal(revised.patientChargeContract.revision, 2);
  assert.deepEqual(
    revised.patientChargeContract.settingEvents.map((event) => [event.effectiveFrom, event.handling]),
    [["2026-08-03", "charge"], ["2026-09-01", "waive"]]
  );
  assert.equal(Object.keys(revised.patientChargeContract.auditOutbox).length, 2);
  assert.throws(() => store.putPatientChargeContractSetting("org_1", {
    ...base,
    handling: "included_in_contract",
    amountMode: null,
    expectedRevision: 1
  }), /revision mismatch/u);

  const cleared = store.putPatientChargeContractSetting("org_1", {
    ...base,
    clear: true,
    handling: null,
    amountMode: null,
    amountYen: null,
    expectedRevision: 2,
    effectiveFrom: "2026-10-01"
  });
  assert.equal(cleared.previousSetting.handling, "waive");
  assert.equal(cleared.patientChargeContract.revision, 3);
  assert.deepEqual(cleared.patientChargeContract.settingEvents[2], {
    revision: 3,
    action: "clear",
    handling: null,
    amountMode: null,
    amountYen: null,
    effectiveFrom: "2026-10-01",
    effectiveTo: null,
    source: "homis_sidecar",
    updatedByMemberId: "mem_1",
    updatedFromDeviceId: "device_1",
    updatedAt: "2026-08-03T10:00:00.000Z"
  });
  const clearAudit = Object.values(cleared.patientChargeContract.auditOutbox)
    .find((entry) => entry.safePayload.revision === 3);
  assert.equal(clearAudit.safePayload.beforeHandling, "waive");
  assert.equal(clearAudit.safePayload.afterHandling, null);

  const clearRetry = store.putPatientChargeContractSetting("org_1", {
    ...base,
    clear: true,
    handling: null,
    amountMode: null,
    amountYen: null,
    expectedRevision: 2,
    effectiveFrom: "2026-10-01"
  });
  assert.equal(clearRetry.changed, false);
  assert.equal(clearRetry.patientChargeContract.revision, 3);
  assert.equal(clearRetry.patientChargeContract.settingEvents.length, 3);
});

test("Firestore patient charge contract updates use a deterministic document and transaction", async () => {
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-08-03T10:00:00.000Z")
  });
  docs.set("organizations/org_1/sidecar_calculation_drafts/sidecar_charge_1", {
    orgId: "org_1",
    sidecarDraftId: "sidecar_charge_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    canonicalPatientResolutionStatus: "resolved",
    lifecycleStatus: "draft",
    setting: "home_visit",
    serviceDate: "2026-08-03",
    sourceRevision: 1,
    calculationRevision: 1,
    expiresAt: "2026-08-17T00:00:00.000Z"
  });
  const created = await store.putPatientChargeContractSetting("org_1", {
    sidecarDraftId: "sidecar_charge_1",
    expectedDraftSourceRevision: 1,
    expectedDraftCalculationRevision: 1,
    expectedDraftServiceDate: "2026-08-03",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    chargeType: "home_medical_transport",
    handling: "included_in_contract",
    amountMode: null,
    amountYen: null,
    effectiveFrom: "2026-08-03",
    effectiveTo: null,
    expectedRevision: 0,
    updatedByMemberId: "mem_1",
    updatedByLoginId: "member@example.test",
    updatedFromDeviceId: "device_1"
  });
  const path = `organizations/org_1/fee_patient_charge_contracts/${created.patientChargeContract.patientChargeContractId}`;
  assert.equal(docs.get(path).revision, 1);
  assert.equal(docs.get(path).canonicalPatientId, "pat_1");
  assert.equal(Object.keys(docs.get(path).auditOutbox).length, 1);
  assert.equal(db.transactionCount, 1);
  assert.deepEqual(
    await store.getPatientChargeContract("org_1", "fac_1", "pat_1", "home_medical_transport"),
    docs.get(path)
  );
  const eventId = Object.keys(docs.get(path).auditOutbox)[0];
  const completed = await store.completePatientChargeContractAudit(
    "org_1",
    created.patientChargeContract.patientChargeContractId,
    eventId
  );
  assert.equal(completed.changed, true);
  assert.deepEqual(docs.get(path).auditOutbox, {});
});

test("Firestore patient charge contract update rejects a changed draft inside its transaction", async () => {
  const docs = new Map();
  const db = fakeFirestoreDb(docs);
  const store = new FirestoreFeeStore({
    db,
    now: () => new Date("2026-08-03T10:00:00.000Z")
  });
  docs.set("organizations/org_1/sidecar_calculation_drafts/sidecar_charge_stale", {
    orgId: "org_1",
    sidecarDraftId: "sidecar_charge_stale",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    canonicalPatientResolutionStatus: "resolved",
    lifecycleStatus: "adopted",
    setting: "home_visit",
    serviceDate: "2026-08-03",
    sourceRevision: 2,
    calculationRevision: 2,
    expiresAt: "2026-08-17T00:00:00.000Z"
  });

  await assert.rejects(store.putPatientChargeContractSetting("org_1", {
    sidecarDraftId: "sidecar_charge_stale",
    expectedDraftSourceRevision: 1,
    expectedDraftCalculationRevision: 1,
    expectedDraftServiceDate: "2026-08-03",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    chargeType: "home_medical_transport",
    handling: "waive",
    amountMode: null,
    amountYen: null,
    effectiveFrom: "2026-08-03",
    effectiveTo: null,
    expectedRevision: 0,
    updatedByMemberId: "mem_1",
    updatedByLoginId: "member@example.test",
    updatedFromDeviceId: "device_1"
  }), /sidecar draft changed/u);
  assert.equal(
    [...docs.keys()].some((path) => path.includes("fee_patient_charge_contracts")),
    false
  );
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
