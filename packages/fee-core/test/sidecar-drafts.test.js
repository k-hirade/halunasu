import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySidecarCalculationResult,
  applySidecarDraftInput,
  buildSidecarCalculationDraft,
  markSidecarDraftAdopted
} from "../src/sidecar-drafts.js";

function draftInput(overrides = {}) {
  return {
    orgId: "org_001",
    sidecarDraftId: "sidecar_001",
    sidecarPatientKey: "sidecar_patient_001",
    contractVersion: "v1",
    externalSourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    sourceRecordDisplayId: "1001-0718",
    idempotencyKeyHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    encounterTypeSource: "user",
    encounterDetails: {
      sameBuilding: false,
      sameBuildingSource: "user",
      singleBuildingPatientCount: 1
    },
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_001",
    serviceDate: "2026-07-18",
    setting: "home_visit",
    clinicalText: "O: 訪問診療を実施。",
    createdByMemberId: "mem_001",
    expiresAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

test("sidecar draft revisions the same immutable record instead of creating a fee session model", () => {
  const current = buildSidecarCalculationDraft(draftInput(), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  const revised = applySidecarDraftInput(current, draftInput({
    sourceRevisionHash: "c".repeat(64),
    clinicalText: "O: 訪問診療を実施。P: 継続する。",
    lastCalculatedByMemberId: "mem_002"
  }), {
    now: new Date("2026-07-18T00:01:00.000Z")
  });

  assert.equal(current.recordType, "sidecar_calculation_draft");
  assert.equal(current.lifecycleStatus, "draft");
  assert.equal(revised.sidecarDraftId, current.sidecarDraftId);
  assert.equal(revised.sourceRecordId, current.sourceRecordId);
  assert.equal(revised.sourceRevision, 2);
  assert.deepEqual(revised.encounterDetails, {
    sameBuilding: false,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 1
  });
  assert.match(revised.clinicalText, /継続/);
  assert.throws(() => applySidecarDraftInput(current, draftInput({ sourceRecordId: "record-002" })), /identity mismatch/);
});

test("sidecar draft persists a same-building override as calculation input", () => {
  const current = buildSidecarCalculationDraft(draftInput(), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  const revised = applySidecarDraftInput(current, draftInput({
    sourceRevisionHash: "d".repeat(64),
    encounterDetails: {
      sameBuilding: true,
      sameBuildingSource: "user",
      singleBuildingPatientCount: 4
    }
  }), {
    now: new Date("2026-07-18T00:01:00.000Z")
  });

  assert.equal(revised.sourceRevision, 2);
  assert.deepEqual(revised.encounterDetails, {
    sameBuilding: true,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 4
  });
});

test("sidecar calculation cannot persist confirmed lines and cannot recalculate after adoption", () => {
  const current = buildSidecarCalculationDraft(draftInput(), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  const calculated = applySidecarCalculationResult(current, {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{
      lineId: "line_1",
      code: "114001110",
      name: "在宅患者訪問診療料",
      points: 890,
      quantity: 1,
      totalPoints: 890,
      status: "confirmed",
      reviewRequired: false
    }]
  }, {
    calculationId: "sidecar_calc_001",
    now: new Date("2026-07-18T00:01:00.000Z")
  });
  const adopted = markSidecarDraftAdopted(calculated, "fee_001", {
    now: new Date("2026-07-18T00:02:00.000Z")
  });

  assert.equal(calculated.candidateOnly, true);
  assert.equal(calculated.status, "needs_review");
  assert.equal(calculated.calculationResult.lineItems[0].status, "candidate");
  assert.equal(calculated.calculationResult.lineItems[0].reviewRequired, true);
  assert.equal(adopted.lifecycleStatus, "adopted");
  assert.equal(adopted.adoptedFeeSessionId, "fee_001");
  assert.throws(() => applySidecarCalculationResult(adopted, { provider: "test" }), /cannot be recalculated/);
});
