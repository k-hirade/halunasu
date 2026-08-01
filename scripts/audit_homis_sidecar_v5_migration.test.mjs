import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSidecarV5Migration } from "./audit_homis_sidecar_v5_migration.mjs";

function adoptedDraft(overrides = {}) {
  return {
    sidecarDraftId: "sidecar_v4",
    facilityId: "fac_001",
    canonicalPatientId: "pat_001",
    serviceDate: "2026-07-18",
    sourceRecordDisplayId: "10010718",
    receptionTime: "14:30",
    setting: "home_visit",
    lifecycleStatus: "adopted",
    adoptedFeeSessionId: "fee_001",
    extractionProof: { selectorContractVersion: "homis-mock-v4" },
    ...overrides
  };
}

test("migration audit requires a guard backfill for an adopted v4 draft", () => {
  const result = analyzeSidecarV5Migration([adoptedDraft()], [], { facilityId: "fac_001" });
  assert.equal(result.report.migrationReady, false);
  assert.equal(result.report.guardBackfillRequiredCount, 1);
  assert.deepEqual(result.report.blockerCodes, ["adoption_guard_backfill_required"]);
  assert.equal(result.backfills.length, 1);
});

test("migration audit becomes ready after the matching adoption guard exists", () => {
  const before = analyzeSidecarV5Migration([adoptedDraft()], [], { facilityId: "fac_001" });
  const [{ visitFingerprint, draft }] = before.backfills;
  const after = analyzeSidecarV5Migration([draft], [{
    visitFingerprint,
    sidecarDraftId: draft.sidecarDraftId,
    adoptedFeeSessionId: draft.adoptedFeeSessionId
  }], { facilityId: "fac_001" });
  assert.equal(after.report.migrationReady, true);
  assert.equal(after.report.adoptedOldGuardCount, 1);
  assert.deepEqual(after.report.blockerCodes, []);
});

test("migration audit blocks active old drafts and incomplete adopted fingerprints", () => {
  const result = analyzeSidecarV5Migration([
    adoptedDraft({ sidecarDraftId: "active", lifecycleStatus: "draft", adoptedFeeSessionId: null }),
    adoptedDraft({ sidecarDraftId: "incomplete", sourceRecordDisplayId: null })
  ], [], { facilityId: "fac_001" });
  assert.equal(result.report.migrationReady, false);
  assert.equal(result.report.activeOldDraftCount, 1);
  assert.deepEqual(result.report.blockerCodes, [
    "active_old_drafts_present",
    "adopted_visit_fingerprint_invalid"
  ]);
});

test("migration audit blocks two adopted legacy drafts for the same visit", () => {
  const result = analyzeSidecarV5Migration([
    adoptedDraft(),
    adoptedDraft({ sidecarDraftId: "sidecar_v3", adoptedFeeSessionId: "fee_002" })
  ], [], { facilityId: "fac_001" });
  assert.equal(result.report.migrationReady, false);
  assert.deepEqual(result.report.blockerCodes, [
    "adopted_visit_fingerprint_invalid",
    "adoption_guard_backfill_required"
  ]);
  assert.equal(result.report.guardBackfillRequiredCount, 1);
  assert.deepEqual(result.report.fingerprintErrors, [{
    draftRef: result.report.fingerprintErrors[0].draftRef,
    reason: "duplicate_adopted_visit_fingerprint"
  }]);
});
