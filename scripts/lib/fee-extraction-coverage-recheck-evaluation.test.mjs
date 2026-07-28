import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCoverageRecheckCase,
  buildCoverageRecheckSessionInput,
  compareCoverageRecheckControl,
  summarizeCoverageRecheckResult
} from "./fee-extraction-coverage-recheck-evaluation.mjs";

const currentCase = {
  id: "current",
  safetyClass: "current_own",
  serviceDate: "2026-06-01",
  setting: "outpatient",
  clinicalText: "O）本日、創傷処置を実施した。",
  patient: {
    birthDate: "1970-01-01",
    sex: "female"
  },
  diagnoses: ["挫創"]
};

test("buildCoverageRecheckSessionInput creates a synthetic isolated session", () => {
  const input = buildCoverageRecheckSessionInput(currentCase, {
    facilityId: "fac_1",
    departmentId: "dep_1",
    runId: "run_1"
  });

  assert.equal(input.facilityId, "fac_1");
  assert.equal(input.departmentId, "dep_1");
  assert.equal(input.claimMonth, "2026-06");
  assert.deepEqual(input.diagnoses, [{ name: "挫創" }]);
  assert.deepEqual(input.patient.externalPatientIds, ["run_1:current"]);
});

test("audit accepts candidate-only auxiliary recovery and persists no raw clinical event name", () => {
  const audit = auditCoverageRecheckCase(currentCase, detail({
    clinicalEvents: [{
      name: "創傷処置",
      type: "procedure",
      actionStatus: "performed",
      source: "openai_auxiliary_recheck"
    }],
    candidateProposals: [{
      code: "140000110",
      name: "創傷処置",
      source: "openai_auxiliary_recheck",
      candidateOnly: true,
      reviewRequired: true
    }]
  }), {
    expectedRevision: "fee-api-stg-00001-test"
  });

  assert.equal(audit.hardCheckPassed, true);
  assert.equal(audit.auxiliaryClinicalEvents.length, 1);
  assert.equal("name" in audit.auxiliaryClinicalEvents[0], false);
  assert.equal(audit.candidateProposals[0].candidateOnly, true);
});

test("audit rejects auxiliary confirmed lines and unsafe-context promotion", () => {
  const unsafeCase = {
    ...currentCase,
    id: "past",
    safetyClass: "past",
    allowedConfirmedLineSources: ["outpatient_basic_fee"]
  };
  const audit = auditCoverageRecheckCase(unsafeCase, detail({
    lineItems: [{
      code: "140000110",
      source: "openai_auxiliary_recheck",
      points: 52
    }],
    candidateProposals: [{
      code: "140000110",
      source: "openai_auxiliary_recheck",
      candidateOnly: false,
      reviewRequired: false
    }]
  }), {
    expectedRevision: "fee-api-stg-00001-test"
  });

  assert.equal(audit.checks.noAuxiliaryConfirmedLines, false);
  assert.equal(audit.checks.auxiliaryCandidatesRequireReview, false);
  assert.equal(audit.checks.unsafeContextNotPromoted, false);
  assert.equal(audit.hardCheckPassed, false);
});

test("audit rejects any unexpected confirmed line in an unsafe context", () => {
  const unsafeCase = {
    ...currentCase,
    id: "past-imaging",
    safetyClass: "past",
    allowedConfirmedLineSources: ["outpatient_basic_fee"]
  };
  const audit = auditCoverageRecheckCase(unsafeCase, detail({
    lineItems: [
      {
        code: "112007410",
        source: "outpatient_basic_fee",
        points: 76,
        quantity: 1
      },
      {
        code: "170000000",
        source: "imaging_fee",
        points: 85,
        quantity: 1
      }
    ]
  }), {
    expectedRevision: "fee-api-stg-00001-test"
  });

  assert.equal(audit.checks.noAuxiliaryConfirmedLines, true);
  assert.equal(audit.checks.noUnexpectedUnsafeConfirmedLines, false);
  assert.equal(audit.unsafeConfirmedLineAudit.unexpectedLineItems.length, 1);
  assert.equal(audit.hardCheckPassed, false);
});

test("audit rejects an auxiliary candidate that duplicates a confirmed code", () => {
  const audit = auditCoverageRecheckCase(currentCase, detail({
    lineItems: [{
      code: "140000110",
      source: "clinical_event",
      points: 52,
      quantity: 1
    }],
    candidateProposals: [{
      code: "140000110",
      source: "openai_auxiliary_recheck",
      candidateOnly: true,
      reviewRequired: true
    }]
  }), {
    expectedRevision: "fee-api-stg-00001-test"
  });

  assert.equal(audit.checks.noDuplicateAuxiliaryCandidates, false);
  assert.equal(audit.auxiliaryCandidateAudit.duplicateCount, 1);
  assert.equal(audit.auxiliaryCandidateAudit.netNewCount, 0);
  assert.equal(audit.hardCheckPassed, false);
});

test("summary distinguishes safety checks from an observed recovery", () => {
  const baseRun = auditCoverageRecheckCase(currentCase, detail(), {
    expectedRevision: "fee-api-stg-00001-test"
  });
  const withoutRecovery = summarizeCoverageRecheckResult({
    status: "complete",
    runs: [baseRun]
  });
  assert.equal(withoutRecovery.hardCheckPassed, true);
  assert.equal(withoutRecovery.allAcceptanceChecksPassed, false);

  const recoveredRun = {
    ...baseRun,
    auxiliaryCoverage: {
      ...baseRun.auxiliaryCoverage,
      recoveredClinicalEventCount: 1,
      recheckAttempted: true,
      recheckSucceeded: true
    }
  };
  const withRecovery = summarizeCoverageRecheckResult({
    status: "complete",
    runs: [recoveredRun]
  });
  assert.equal(withRecovery.allAcceptanceChecksPassed, false);
  assert.equal(withRecovery.controlComparisonComplete, false);

  const withRecoveryAndControl = summarizeCoverageRecheckResult({
    status: "complete",
    methodology: {
      controlComparisonRequested: true
    },
    runs: [{
      ...recoveredRun,
      controlComparison: {
        controlFound: true,
        totalPointsEqual: true,
        confirmedLinesEqual: true,
        candidatesEqual: false,
        candidateComparisonPassed: true,
        unsafeCandidateSetEqual: true
      }
    }]
  });
  assert.equal(withRecoveryAndControl.controlComparisonComplete, true);
  assert.equal(withRecoveryAndControl.allAcceptanceChecksPassed, true);
});

test("control comparison requires points and confirmed lines to remain equal", () => {
  const active = {
    safetyClass: "past",
    totalPoints: 78,
    lineItems: [{ code: "112007410", points: 76, quantity: 1 }],
    candidateProposals: []
  };
  const equal = compareCoverageRecheckControl(active, {
    totalPoints: 78,
    lineItems: [{ code: "112007410", points: 76, quantity: 1 }],
    candidateProposals: []
  });
  assert.equal(equal.totalPointsEqual, true);
  assert.equal(equal.confirmedLinesEqual, true);
  assert.equal(equal.candidateComparisonPassed, true);

  const changed = compareCoverageRecheckControl(active, {
    totalPoints: 130,
    lineItems: [{ code: "140000110", points: 52, quantity: 1 }],
    candidateProposals: []
  });
  assert.equal(changed.totalPointsEqual, false);
  assert.equal(changed.confirmedLinesEqual, false);
});

test("control comparison allows candidate differences only for an observed safe recovery", () => {
  const base = {
    safetyClass: "current_own",
    totalPoints: 78,
    lineItems: [{ code: "112007410", points: 76, quantity: 1 }],
    candidateProposals: [{
      code: "140000110",
      source: "openai_auxiliary_recheck",
      candidateOnly: true,
      reviewRequired: true
    }]
  };
  const control = {
    totalPoints: 78,
    lineItems: [{ code: "112007410", points: 76, quantity: 1 }],
    candidateProposals: []
  };

  const withoutRecovery = compareCoverageRecheckControl(base, control);
  assert.equal(withoutRecovery.candidatesEqual, false);
  assert.equal(withoutRecovery.candidateComparisonPassed, false);

  const withRecovery = compareCoverageRecheckControl({
    ...base,
    auxiliaryCoverage: {
      recoveredClinicalEventCount: 1
    }
  }, control);
  assert.equal(withRecovery.candidateComparisonPassed, true);
});

function detail({
  clinicalEvents = [],
  candidateProposals = [],
  lineItems = []
} = {}) {
  return {
    feeSession: {
      feeSessionId: "fee_1",
      status: "needs_review",
      calculationResult: {
        totalPoints: lineItems.reduce(
          (sum, line) => sum + Number(line.points || 0) * Number(line.quantity || 1),
          0
        ),
        clinicalEvents,
        candidateProposals,
        lineItems
      },
      calculationProgress: {
        metrics: {
          performance: {
            runtime: {
              cloudRunRevision: "fee-api-stg-00001-test"
            },
            auxiliaryExtractionCoverage: {
              mode: "verify",
              detectorAvailable: true,
              detectedSpanCount: 1,
              gapSpanCount: clinicalEvents.length ? 1 : 0,
              recheckAttempted: clinicalEvents.length > 0,
              recheckSucceeded: clinicalEvents.length > 0,
              recoveredClinicalEventCount: clinicalEvents.length,
              additionalOpenAiCallCount: clinicalEvents.length ? 1 : 0
            }
          }
        }
      }
    }
  };
}
