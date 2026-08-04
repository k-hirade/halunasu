import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySidecarCandidateAcknowledgement,
  applySidecarCalculationResult,
  applySidecarDraftInput,
  buildSidecarCalculationDraft,
  completeSidecarCandidateAcknowledgementAudit,
  markSidecarDraftAdopted,
  reconcileSidecarCandidateAcknowledgements,
  sidecarVisitAdoptionFingerprint
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
      singleBuildingPatientCount: 1,
      residenceType: "private"
    },
    extractionProof: { domMutationDetected: false },
    facilityId: "fac_001",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
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
  assert.deepEqual(current.candidateAcknowledgements, {});
  assert.deepEqual(current.candidateAcknowledgementAuditOutbox, {});
  assert.equal(revised.sidecarDraftId, current.sidecarDraftId);
  assert.equal(revised.sourceRecordId, current.sourceRecordId);
  assert.equal(revised.sourceRevision, 2);
  assert.deepEqual(revised.encounterDetails, {
    sameBuilding: false,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 1,
    residenceType: "private",
    visitKind: null,
    visitKindSource: null,
    telephoneEligibility: null
  });
  assert.match(revised.clinicalText, /継続/);
  assert.throws(() => applySidecarDraftInput(current, draftInput({ sourceRecordId: "record-002" })), /identity mismatch/);
});

test("sidecar candidate acknowledgement is explicit, idempotent, and revision locked", () => {
  const calculated = applySidecarCalculationResult(
    buildSidecarCalculationDraft(draftInput(), {
      now: new Date("2026-07-18T00:00:00.000Z")
    }),
    {
      provider: "test",
      status: "completed",
      totalPoints: 890,
      lineItems: [{ lineId: "line_1", code: "114001110", name: "訪問診療料" }]
    },
    {
      calculationId: "calc_1",
      now: new Date("2026-07-18T00:01:00.000Z")
    }
  );
  const calculationBefore = structuredClone(calculated.calculationResult);
  const common = {
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    candidateKey: "review_issue:issue_1",
    candidateId: "issue_1",
    candidateFingerprint: "c".repeat(64),
    updatedByMemberId: "mem_001",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_001"
  };
  const acknowledged = applySidecarCandidateAcknowledgement(calculated, {
    ...common,
    acknowledged: true,
    expectedAcknowledgementVersion: 0
  }, {
    now: new Date("2026-07-18T00:02:00.000Z")
  });
  const repeated = applySidecarCandidateAcknowledgement(acknowledged.sidecarDraft, {
    ...common,
    acknowledged: true,
    expectedAcknowledgementVersion: 0
  }, {
    now: new Date("2026-07-18T00:03:00.000Z")
  });

  assert.equal(acknowledged.changed, true);
  assert.deepEqual(acknowledged.acknowledgement, {
    candidateKey: common.candidateKey,
    candidateFingerprint: common.candidateFingerprint,
    status: "acknowledged",
    sourceRevision: 1,
    calculationRevision: 1,
    version: 1,
    updatedByMemberId: "mem_001",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_001",
    updatedAt: "2026-07-18T00:02:00.000Z"
  });
  assert.equal(Object.hasOwn(acknowledged.acknowledgement, "candidateId"), false);
  assert.equal(Object.keys(acknowledged.sidecarDraft.candidateAcknowledgementAuditOutbox).length, 1);
  assert.equal(repeated.changed, false);
  assert.strictEqual(repeated.sidecarDraft, acknowledged.sidecarDraft);
  assert.deepEqual(repeated.sidecarDraft.calculationResult, calculationBefore);
  assert.throws(() => applySidecarCandidateAcknowledgement(acknowledged.sidecarDraft, {
    ...common,
    acknowledged: false,
    expectedAcknowledgementVersion: 0
  }), (error) => (
    error.statusCode === 409
    && error.code === "SIDECAR_CANDIDATE_ACKNOWLEDGEMENT_CONFLICT"
  ));

  const unacknowledged = applySidecarCandidateAcknowledgement(acknowledged.sidecarDraft, {
    ...common,
    acknowledged: false,
    expectedAcknowledgementVersion: 1
  }, {
    now: new Date("2026-07-18T00:04:00.000Z")
  });
  assert.equal(unacknowledged.acknowledgement.status, "unacknowledged");
  assert.equal(unacknowledged.acknowledgement.version, 2);
  assert.equal(Object.keys(unacknowledged.sidecarDraft.candidateAcknowledgementAuditOutbox).length, 2);
  const [completedEventId] = Object.keys(
    unacknowledged.sidecarDraft.candidateAcknowledgementAuditOutbox
  );
  const completedAudit = completeSidecarCandidateAcknowledgementAudit(
    unacknowledged.sidecarDraft,
    completedEventId
  );
  assert.equal(completedAudit.changed, true);
  assert.equal(Object.keys(completedAudit.sidecarDraft.candidateAcknowledgementAuditOutbox).length, 1);
  assert.equal(completeSidecarCandidateAcknowledgementAudit(
    completedAudit.sidecarDraft,
    completedEventId
  ).changed, false);
  const [remainingEventId] = Object.keys(
    completedAudit.sidecarDraft.candidateAcknowledgementAuditOutbox
  );
  const fullyCompletedAudit = completeSidecarCandidateAcknowledgementAudit(
    completedAudit.sidecarDraft,
    remainingEventId
  );
  assert.deepEqual(fullyCompletedAudit.sidecarDraft.candidateAcknowledgementAuditOutbox, {});
  assert.deepEqual(unacknowledged.sidecarDraft.calculationResult, calculationBefore);

  const adopted = markSidecarDraftAdopted(acknowledged.sidecarDraft, "fee_001");
  assert.throws(() => applySidecarCandidateAcknowledgement(adopted, {
    ...common,
    acknowledged: false,
    expectedAcknowledgementVersion: 1
  }), /cannot be changed/u);
});

test("sidecar candidate decisions cycle through acknowledged, excluded, and unacknowledged", () => {
  const calculated = applySidecarCalculationResult(
    buildSidecarCalculationDraft(draftInput()),
    {
      provider: "test",
      status: "completed",
      totalPoints: 890,
      lineItems: [{ lineId: "line_1", code: "114001110", name: "訪問診療料" }]
    },
    { calculationId: "calc_1", now: new Date("2026-07-18T00:01:00.000Z") }
  );
  const calculationBefore = structuredClone(calculated.calculationResult);
  const common = {
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    candidateKey: "review_issue:issue_1",
    candidateFingerprint: "c".repeat(64),
    updatedByMemberId: "mem_001",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_001"
  };
  const acknowledged = applySidecarCandidateAcknowledgement(calculated, {
    ...common,
    status: "acknowledged",
    expectedAcknowledgementVersion: 0
  }, { now: new Date("2026-07-18T00:02:00.000Z") });
  const excluded = applySidecarCandidateAcknowledgement(acknowledged.sidecarDraft, {
    ...common,
    status: "excluded",
    expectedAcknowledgementVersion: 1
  }, { now: new Date("2026-07-18T00:03:00.000Z") });
  const unacknowledged = applySidecarCandidateAcknowledgement(excluded.sidecarDraft, {
    ...common,
    status: "unacknowledged",
    expectedAcknowledgementVersion: 2
  }, { now: new Date("2026-07-18T00:04:00.000Z") });
  const auditTransitions = Object.values(
    unacknowledged.sidecarDraft.candidateAcknowledgementAuditOutbox
  ).sort((left, right) => left.acknowledgementVersion - right.acknowledgementVersion);

  assert.deepEqual([
    acknowledged.acknowledgement.status,
    excluded.acknowledgement.status,
    unacknowledged.acknowledgement.status
  ], ["acknowledged", "excluded", "unacknowledged"]);
  assert.deepEqual([
    acknowledged.acknowledgement.version,
    excluded.acknowledgement.version,
    unacknowledged.acknowledgement.version
  ], [1, 2, 3]);
  assert.deepEqual(auditTransitions.map((entry) => ({
    previousStatus: entry.previousStatus,
    status: entry.status,
    acknowledged: entry.acknowledged
  })), [{
    previousStatus: "unacknowledged",
    status: "acknowledged",
    acknowledged: true
  }, {
    previousStatus: "acknowledged",
    status: "excluded",
    acknowledged: false
  }, {
    previousStatus: "excluded",
    status: "unacknowledged",
    acknowledged: false
  }]);
  assert.equal(new Set(auditTransitions.map((entry) => entry.eventId)).size, 3);
  assert.deepEqual(unacknowledged.sidecarDraft.calculationResult, calculationBefore);
});

test("sidecar acknowledgement reconciliation stales acknowledged and excluded decisions", () => {
  const calculationResult = {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{ lineId: "line_1", code: "114001110", name: "訪問診療料" }]
  };
  const calculated = applySidecarCalculationResult(
    buildSidecarCalculationDraft(draftInput()),
    calculationResult,
    { calculationId: "calc_1", now: new Date("2026-07-18T00:01:00.000Z") }
  );
  const makeRecord = (candidateKey, candidateFingerprint, overrides = {}) => ({
    candidateKey,
    candidateFingerprint,
    status: "acknowledged",
    sourceRevision: 1,
    calculationRevision: 1,
    version: 1,
    updatedByMemberId: "mem_001",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_001",
    updatedAt: "2026-07-18T00:02:00.000Z",
    ...overrides
  });
  const keepFingerprint = "a".repeat(64);
  const changedFingerprint = "b".repeat(64);
  const current = {
    ...calculated,
    candidateAcknowledgements: {
      keep: makeRecord("keep", keepFingerprint),
      missing: makeRecord("missing", "c".repeat(64)),
      changed: makeRecord("changed", changedFingerprint),
      old_source: makeRecord("old_source", "d".repeat(64), { sourceRevision: 0 }),
      excluded_keep: makeRecord("excluded_keep", "1".repeat(64), { status: "excluded" }),
      excluded_changed: makeRecord("excluded_changed", "2".repeat(64), { status: "excluded" }),
      excluded_old_source: makeRecord("excluded_old_source", "3".repeat(64), {
        status: "excluded",
        sourceRevision: 0
      }),
      opted_out: makeRecord("opted_out", "e".repeat(64), { status: "unacknowledged" }),
      already_stale: makeRecord("already_stale", "f".repeat(64), {
        status: "stale",
        staleReason: "candidate_missing"
      })
    }
  };
  const calculationBefore = structuredClone(current.calculationResult);
  const reconciled = reconcileSidecarCandidateAcknowledgements(current, {
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    activeCandidates: [
      { candidateKey: "keep", candidateFingerprint: keepFingerprint },
      { candidateKey: "changed", candidateFingerprint: "9".repeat(64) },
      { candidateKey: "old_source", candidateFingerprint: "d".repeat(64) },
      { candidateKey: "excluded_keep", candidateFingerprint: "1".repeat(64) },
      { candidateKey: "excluded_changed", candidateFingerprint: "8".repeat(64) },
      { candidateKey: "excluded_old_source", candidateFingerprint: "3".repeat(64) },
      { candidateKey: "opted_out", candidateFingerprint: "e".repeat(64) },
      { candidateKey: "already_stale", candidateFingerprint: "f".repeat(64) }
    ],
    invalidatedByMemberId: "mem_recalculator",
    invalidatedByLoginId: "recalculator@example.com",
    invalidatedFromDeviceId: "device_recalculator"
  }, {
    now: new Date("2026-07-18T00:03:00.000Z")
  });

  assert.equal(reconciled.changed, true);
  assert.deepEqual(reconciled.invalidated.map((record) => [
    record.candidateKey,
    record.staleReason,
    record.version
  ]), [
    ["missing", "candidate_missing", 2],
    ["changed", "candidate_fingerprint_changed", 2],
    ["old_source", "source_revision_changed", 2],
    ["excluded_changed", "candidate_fingerprint_changed", 2],
    ["excluded_old_source", "source_revision_changed", 2]
  ]);
  assert.equal(reconciled.sidecarDraft.candidateAcknowledgements.keep.status, "acknowledged");
  assert.equal(reconciled.sidecarDraft.candidateAcknowledgements.excluded_keep.status, "excluded");
  assert.equal(reconciled.sidecarDraft.candidateAcknowledgements.opted_out.status, "unacknowledged");
  assert.equal(reconciled.sidecarDraft.candidateAcknowledgements.already_stale.version, 1);
  assert.equal(reconciled.invalidated[0].invalidatedByMemberId, "mem_recalculator");
  assert.equal(reconciled.invalidated[0].invalidatedByLoginId, "recalculator@example.com");
  assert.equal(reconciled.invalidated[0].invalidationCalculationRevision, 1);
  assert.deepEqual(reconciled.invalidated.slice(-2).map((record) => record.staleFromStatus), [
    "excluded",
    "excluded"
  ]);
  assert.equal(Object.keys(reconciled.sidecarDraft.candidateAcknowledgementAuditOutbox).length, 5);
  assert.deepEqual(reconciled.sidecarDraft.calculationResult, calculationBefore);

  const repeated = reconcileSidecarCandidateAcknowledgements(reconciled.sidecarDraft, {
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    activeCandidates: [
      { candidateKey: "keep", candidateFingerprint: keepFingerprint },
      { candidateKey: "excluded_keep", candidateFingerprint: "1".repeat(64) }
    ]
  });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.invalidated, []);
  assert.strictEqual(repeated.sidecarDraft, reconciled.sidecarDraft);
  assert.throws(() => reconcileSidecarCandidateAcknowledgements(current, {
    expectedSourceRevision: 2,
    expectedCalculationRevision: 1,
    activeCandidates: []
  }), (error) => error.statusCode === 409);
});

test("same-fingerprint acknowledgement survives recalculation but not a source revision change", () => {
  const calculationResult = {
    provider: "test",
    status: "completed",
    totalPoints: 890,
    lineItems: [{ lineId: "line_1", code: "114001110", name: "訪問診療料" }]
  };
  const firstCalculation = applySidecarCalculationResult(
    buildSidecarCalculationDraft(draftInput()),
    calculationResult,
    { calculationId: "calc_1", now: new Date("2026-07-18T00:01:00.000Z") }
  );
  const candidateFingerprint = "7".repeat(64);
  const acknowledgementInput = {
    acknowledged: true,
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    expectedAcknowledgementVersion: 0,
    candidateKey: "candidate_1",
    candidateFingerprint,
    updatedByMemberId: "mem_001",
    updatedByLoginId: "admin@example.com",
    updatedFromDeviceId: "device_001"
  };
  const acknowledged = applySidecarCandidateAcknowledgement(
    firstCalculation,
    acknowledgementInput
  ).sidecarDraft;
  const recalculated = applySidecarCalculationResult(acknowledged, calculationResult, {
    calculationId: "calc_2",
    now: new Date("2026-07-18T00:02:00.000Z")
  });
  const retained = reconcileSidecarCandidateAcknowledgements(recalculated, {
    expectedSourceRevision: 1,
    expectedCalculationRevision: 2,
    activeCandidates: [{ candidateKey: "candidate_1", candidateFingerprint }]
  });
  const oldRequestReplay = applySidecarCandidateAcknowledgement(retained.sidecarDraft, {
    ...acknowledgementInput,
    expectedCalculationRevision: 1
  });

  assert.equal(retained.changed, false);
  assert.equal(retained.sidecarDraft.candidateAcknowledgements.candidate_1.status, "acknowledged");
  assert.equal(retained.sidecarDraft.candidateAcknowledgements.candidate_1.calculationRevision, 1);
  assert.equal(oldRequestReplay.changed, false);

  const revisedSource = applySidecarDraftInput(retained.sidecarDraft, draftInput({
    sourceRevisionHash: "9".repeat(64),
    clinicalText: "O: 訪問診療を実施。所見を更新。"
  }));
  const recalculatedSource = applySidecarCalculationResult(revisedSource, calculationResult, {
    calculationId: "calc_3",
    now: new Date("2026-07-18T00:03:00.000Z")
  });
  const invalidated = reconcileSidecarCandidateAcknowledgements(recalculatedSource, {
    expectedSourceRevision: 2,
    expectedCalculationRevision: 3,
    activeCandidates: [{ candidateKey: "candidate_1", candidateFingerprint }],
    invalidatedByMemberId: "mem_recalculator",
    invalidatedByLoginId: "recalculator@example.com",
    invalidatedFromDeviceId: "device_recalculator"
  });
  assert.equal(invalidated.changed, true);
  assert.equal(invalidated.invalidated[0].staleReason, "source_revision_changed");
});

test("visit adoption fingerprint is independent of v4 and v5 source record keys", () => {
  const v4 = buildSidecarCalculationDraft(draftInput({
    sourceRecordId: "legacy-record-001",
    contractVersion: "v1"
  }));
  const v5 = buildSidecarCalculationDraft(draftInput({
    sidecarDraftId: "sidecar_002",
    sourceRecordId: "homis-visible-record-v1\u001fhomis\u001f1001\u001f2026-07-18\u001f1001-0718\u001f14:30",
    idempotencyKeyHash: "c".repeat(64)
  }));
  const session = {
    canonicalPatientId: "patient_001",
    patientId: "patient_001",
    facilityId: "fac_001",
    serviceDate: "2026-07-18",
    receptionTime: "14:30",
    setting: "home_visit"
  };

  assert.equal(
    sidecarVisitAdoptionFingerprint(v4, session),
    sidecarVisitAdoptionFingerprint(v5, session)
  );
  assert.notEqual(
    sidecarVisitAdoptionFingerprint(v5, { ...session, receptionTime: "14:45" }),
    sidecarVisitAdoptionFingerprint(v5, session)
  );
  assert.notEqual(
    sidecarVisitAdoptionFingerprint(v5, { ...session, setting: "house_call" }),
    sidecarVisitAdoptionFingerprint(v5, session)
  );
});

test("visit adoption fingerprint fails closed with recovery guidance for an incomplete legacy draft", () => {
  const legacyDraft = buildSidecarCalculationDraft(draftInput({
    receptionTime: null
  }));

  assert.throws(
    () => sidecarVisitAdoptionFingerprint(legacyDraft, {
      canonicalPatientId: "patient_001",
      facilityId: "fac_001",
      serviceDate: "2026-07-18",
      setting: "home_visit"
    }),
    (error) => {
      assert.equal(error.name, "ConflictError");
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "SIDECAR_ADOPTION_VISIT_FINGERPRINT_INCOMPLETE");
      assert.match(error.message, /新しい拡張機能でHOMIS画面を再読み取り/u);
      assert.match(error.message, /算定案を再作成/u);
      return true;
    }
  );
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
      singleBuildingPatientCount: 4,
      residenceType: "facility"
    }
  }), {
    now: new Date("2026-07-18T00:01:00.000Z")
  });

  assert.equal(revised.sourceRevision, 2);
  assert.deepEqual(revised.encounterDetails, {
    sameBuilding: true,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 4,
    residenceType: "facility",
    visitKind: null,
    visitKindSource: null,
    telephoneEligibility: null
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
    }],
    reviewIssues: [{
      reviewIssueId: "coverage_1",
      issueCode: "line_coverage_gap",
      severity: "warning",
      messageForStaff: "未確認の行為があります。",
      sidecarDisplay: {
        fragments: ["創傷処置を実施"],
        fragmentHashes: ["a".repeat(64), "invalid"]
      }
    }],
    metrics: {
      standingLane: {
        disabledReason: null,
        familyCount: 231
      },
      autoBillingRules: {
        appliedCount: 1,
        applied: [{
          ruleId: "home_visit",
          code: "114001110",
          action: "confirm",
          billingRole: "home_visit_base",
          sameBuilding: false,
          variant: "outside_same_building",
          clinicalText: "must not persist"
        }]
      },
      sameHouseholdVisit: {
        status: "first_visit",
        replacementCandidateCount: 0,
        suppressedCodeCount: 0,
        counterpartDraftId: "must_not_persist"
      },
      untrustedMetric: {
        clinicalText: "must not persist"
      }
    }
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
  assert.deepEqual(calculated.calculationResult.metrics, {
    standingLane: {
      disabledReason: null,
      familyCount: 231
    },
    autoBillingRules: {
      applied: [{
        ruleId: "home_visit",
        code: "114001110",
        action: "confirm",
        billingRole: "home_visit_base",
        sameBuilding: false,
        variant: "outside_same_building"
      }],
      appliedCount: 1
    },
    sameHouseholdVisit: {
      status: "first_visit",
      replacementCandidateCount: 0,
      suppressedCodeCount: 0
    }
  });
  assert.deepEqual(calculated.calculationResult.reviewIssues[0].sidecarDisplay, {
    fragments: ["創傷処置を実施"],
    fragmentHashes: ["a".repeat(64)]
  });
  assert.equal(adopted.lifecycleStatus, "adopted");
  assert.equal(adopted.adoptedFeeSessionId, "fee_001");
  assert.throws(() => applySidecarCalculationResult(adopted, { provider: "test" }), /cannot be recalculated/);
});

test("calculation revision and set diff detect simultaneous additions and removals", () => {
  const draft = buildSidecarCalculationDraft(draftInput(), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  const first = applySidecarCalculationResult(draft, {
    provider: "test",
    status: "completed",
    totalPoints: 100,
    lineItems: [{ lineId: "line_a", code: "100000001", name: "候補A", quantity: 1 }],
    warnings: ["警告A"],
    reviewIssues: []
  }, {
    calculationId: "calc_1",
    now: new Date("2026-07-18T00:01:00.000Z")
  });
  const second = applySidecarCalculationResult(first, {
    provider: "test",
    status: "completed",
    totalPoints: 100,
    lineItems: [{ lineId: "line_b", code: "100000002", name: "候補B", quantity: 1 }],
    warnings: ["警告B"],
    reviewIssues: []
  }, {
    calculationId: "calc_2",
    now: new Date("2026-07-18T00:02:00.000Z")
  });

  assert.equal(first.sourceRevision, 1);
  assert.equal(first.calculationRevision, 1);
  assert.equal(first.calculationDiff, null);
  assert.equal(second.sourceRevision, 1);
  assert.equal(second.calculationRevision, 2);
  assert.deepEqual(second.calculationDiff, {
    candidates: { addedCount: 1, removedCount: 1 },
    notices: { addedCount: 1, removedCount: 1 },
    pointDelta: 0
  });
});

test("sidecar calculation keeps only structured selection evidence in metrics", () => {
  const current = buildSidecarCalculationDraft(draftInput(), {
    now: new Date("2026-07-18T00:00:00.000Z")
  });
  const calculated = applySidecarCalculationResult(current, {
    provider: "test",
    status: "completed",
    totalPoints: 0,
    lineItems: [],
    metrics: {
      sidecarSelectionContext: {
        facilityStandardKeys: ["home_support_clinic", "home_support_clinic", ""],
        facilityStandardKeysSource: "facility_profile",
        setting: "home_visit",
        selection: {
          singleBuildingPatientCount: {
            value: 1,
            status: "known",
            source: "derived:screen.privateResidence+screen.sameBuildingOutside",
            sourceRevision: "a".repeat(64),
            observedAt: "2026-07-18T00:00:00.000Z",
            clinicalText: "must not persist"
          },
          qualifyingMonthlyVisits: {
            value: 2,
            status: "complete",
            source: "homis.encounterHistory+currentChart.calendar",
            sourceRevision: "b".repeat(64),
            observedAt: "2026-07-18T00:00:01.000Z",
            serviceDates: ["2026-07-02", "2026-07-02", "2026-07-16"],
            rows: [{ clinicalText: "must not persist" }]
          },
          specialDisease: {
            value: true,
            status: "known",
            source: "c002-special-disease-2026",
            sourceRevision: "c".repeat(64),
            observedAt: "not-an-iso-timestamp",
            evidence: [{ name: "must not persist" }]
          },
          unknownFact: {
            value: true,
            clinicalText: "must not persist"
          }
        }
      }
    }
  }, {
    calculationId: "sidecar_calc_selection_metrics",
    now: new Date("2026-07-18T00:01:00.000Z")
  });

  assert.deepEqual(calculated.calculationResult.metrics.sidecarSelectionContext, {
    facilityStandardKeys: ["home_support_clinic"],
    facilityStandardKeysSource: "facility_profile",
    currentMonthEncounterCount: null,
    singleBuildingPatientCount: null,
    setting: "home_visit",
    specialDiseaseStatus: "unknown",
    selection: {
      singleBuildingPatientCount: {
        value: 1,
        status: "known",
        source: "derived:screen.privateResidence+screen.sameBuildingOutside",
        sourceRevision: "a".repeat(64),
        observedAt: "2026-07-18T00:00:00.000Z"
      },
      qualifyingMonthlyVisits: {
        value: 2,
        status: "complete",
        source: "homis.encounterHistory+currentChart.calendar",
        sourceRevision: "b".repeat(64),
        observedAt: "2026-07-18T00:00:01.000Z",
        serviceDates: ["2026-07-02", "2026-07-16"]
      },
      specialDisease: {
        value: true,
        status: "known",
        source: "c002-special-disease-2026",
        sourceRevision: "c".repeat(64)
      }
    }
  });
});
