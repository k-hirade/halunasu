import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCareFeeEvidenceEventInput } from "../../../packages/care-fee-contracts/src/index.js";
import { evaluateEmergencyTreatmentBatch } from "../../../packages/care-fee-core/src/index.js";
import {
  buildCareFeeEvidenceOutboxEvent,
  detectCareFeeEvidenceSignal,
  dispatchPendingCareFeeEvidence,
  enqueueCareFeeEvidenceForSession
} from "../src/care-fee-evidence-outbox.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

const feeSettings = {
  careFeeIntegration: {
    enabled: true,
    facilityCode: "care-facility-001",
    careOfficeNumber: "1234567890",
    careServiceType: "care_medical_institution",
    signalPolicy: "conservative"
  }
};

test("detects only current conservative emergency-treatment evidence", () => {
  assert.equal(detectCareFeeEvidenceSignal({
    clinicalText: "本日急変し呼吸不全。酸素投与と点滴を開始した。"
  }, feeSettings).detected, true);
  assert.equal(detectCareFeeEvidenceSignal({
    clinicalText: "前回は急変し、酸素投与と点滴を実施した。本日は状態安定。"
  }, feeSettings).detected, false);
  assert.equal(detectCareFeeEvidenceSignal({
    clinicalText: "次回、急変時には酸素投与を検討する。"
  }, feeSettings).detected, false);
});

test("builds incomplete versioned evidence that resolves to needs_review", () => {
  const event = buildCareFeeEvidenceOutboxEvent({
    orgId: "org_001",
    organizationCode: "clinic-001",
    feeSettings,
    now: new Date("2026-08-02T01:00:00.000Z"),
    session: baseSession()
  });
  const validated = validateCareFeeEvidenceEventInput(event.payload);
  const evaluation = evaluateEmergencyTreatmentBatch(validated.rows);

  assert.match(event.eventId, /^fce_[a-f0-9]{64}$/u);
  assert.equal(validated.evidenceMetadata.sourceScope, "conservative_clinical_signal");
  assert.equal(validated.rows[0].onsetAt, "");
  assert.equal(validated.rows[0].emergencyCareRequired, null);
  assert.equal(evaluation.episodes[0].judgmentStatus, "needs_review");
  assert.ok(evaluation.episodes[0].missingFields.includes("onset_at"));
});

test("queues idempotently and removes the payload after successful delivery", async () => {
  const store = new MemoryFeeStore({ now: () => new Date("2026-08-02T01:00:00.000Z") });
  const input = {
    feeStore: store,
    orgId: "org_001",
    organizationCode: "clinic-001",
    feeSettings,
    now: new Date("2026-08-02T01:00:00.000Z"),
    session: baseSession()
  };
  const first = await enqueueCareFeeEvidenceForSession(input);
  const duplicate = await enqueueCareFeeEvidenceForSession(input);
  const dispatched = await dispatchPendingCareFeeEvidence({
    feeStore: store,
    orgId: "org_001",
    endpoint: "https://care-api.example.test/v1/care-fee/internal/evidence",
    token: "secret",
    now: new Date("2026-08-02T01:00:00.000Z"),
    fetchImpl: async () => response(201, { receipt: { receiptId: "cer_001" } })
  });
  const delivered = store.careFeeEvidenceOutboxForOrg("org_001").get(first.event.eventId);

  assert.equal(first.status, "queued");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(dispatched.deliveredCount, 1);
  assert.equal(delivered.deliveryState, "delivered");
  assert.equal(delivered.receiptId, "cer_001");
  assert.equal(delivered.payload, null);
});

test("retries transient failures and dead-letters invalid evidence responses", async () => {
  const store = new MemoryFeeStore({ now: () => new Date("2026-08-02T01:00:00.000Z") });
  const queued = await enqueueCareFeeEvidenceForSession({
    feeStore: store,
    orgId: "org_001",
    feeSettings,
    session: baseSession(),
    now: new Date("2026-08-02T01:00:00.000Z")
  });
  await dispatchPendingCareFeeEvidence({
    feeStore: store,
    orgId: "org_001",
    endpoint: "https://care-api.example.test/v1/care-fee/internal/evidence",
    token: "secret",
    now: new Date("2026-08-02T01:00:00.000Z"),
    fetchImpl: async () => response(503, {})
  });
  const failed = store.careFeeEvidenceOutboxForOrg("org_001").get(queued.event.eventId);
  assert.equal(failed.deliveryState, "failed");
  assert.equal(failed.attemptCount, 1);
  assert.ok(failed.nextAttemptAt > "2026-08-02T01:00:00.000Z");

  failed.nextAttemptAt = "2026-08-02T01:00:00.000Z";
  await dispatchPendingCareFeeEvidence({
    feeStore: store,
    orgId: "org_001",
    endpoint: "https://care-api.example.test/v1/care-fee/internal/evidence",
    token: "secret",
    now: new Date("2026-08-02T01:01:00.000Z"),
    fetchImpl: async () => response(400, {})
  });
  assert.equal(failed.eventId, queued.event.eventId);
  assert.equal(store.careFeeEvidenceOutboxForOrg("org_001").get(queued.event.eventId).deliveryState, "dead_letter");
});

function baseSession() {
  return {
    feeSessionId: "fee_001",
    sourceRecordId: "chart_001",
    facilityId: "fac_001",
    patientId: "pat_001",
    canonicalPatientId: "pat_001",
    serviceDate: "2026-08-01",
    clinicalText: "本日急変し急性呼吸不全。酸素投与と点滴を開始した。",
    diagnoses: [{ name: "急性呼吸不全" }]
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}
