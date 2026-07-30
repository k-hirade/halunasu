import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEncounterVariantToPreparation,
  deriveEstablishedPatient,
  hasTelephoneVisitWording
} from "../src/encounter-variants.js";

function prepared() {
  return {
    calculationOptions: {
      outpatient_basic: {
        fee_kind: "revisit",
        management_explanation_performed: true
      }
    },
    calculationOptionsAutoKeys: ["outpatient_basic"],
    candidateProposals: [{
      proposalId: "outpatient_management_addon",
      code: "112011010"
    }],
    reviewIssues: [],
    reviewWarnings: [],
    metrics: {}
  };
}

function facilityServiceSettings() {
  return {
    facilityServiceSchedules: [{
      scheduleId: "clinic-hours-2026",
      effectiveFrom: "2026-06-01",
      effectiveTo: "",
      timezone: "Asia/Tokyo",
      weeklyHours: {
        monday: [{ start: "09:00", end: "18:00" }],
        tuesday: [{ start: "09:00", end: "18:00" }],
        wednesday: [{ start: "09:00", end: "18:00" }],
        thursday: [{ start: "09:00", end: "18:00" }],
        friday: [{ start: "09:00", end: "18:00" }],
        saturday: [{ start: "09:00", end: "12:00" }],
        sunday: []
      },
      holidayDates: [],
      specialHours: [],
      status: "active"
    }]
  };
}

test("derives established relationship only from the same facility and complete history", () => {
  const session = { facilityId: "fac-a" };
  assert.equal(deriveEstablishedPatient({
    session,
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "partial"
  }), true);
  assert.equal(deriveEstablishedPatient({
    session,
    priorSessions: [{ facilityId: "fac-b", serviceDate: "2026-06-01" }],
    historyCompleteness: "complete"
  }), false);
  assert.equal(deriveEstablishedPatient({
    session,
    priorSessions: [],
    historyCompleteness: "partial"
  }), null);
  assert.equal(deriveEstablishedPatient({
    session,
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "unavailable"
  }), null);
});

test("telephone wording does not match a telephone number or contact metadata", () => {
  assert.equal(hasTelephoneVisitWording("家族から電話相談があり、療養上の指示をした。"), true);
  assert.equal(hasTelephoneVisitWording("電話再診として対応した。"), true);
  assert.equal(hasTelephoneVisitWording("連絡先電話番号 03-1234-5678"), false);
  assert.equal(hasTelephoneVisitWording("次回予約は受付へ電話してください。"), false);
});

test("telephone wording ignores past or external references without hiding a current telephone visit", () => {
  assert.equal(
    hasTelephoneVisitWording("先週電話で相談があった。本日対面で再診し血圧安定。"),
    false
  );
  assert.equal(
    hasTelephoneVisitWording("前回は電話再診だった。本日は来院。"),
    false
  );
  assert.equal(
    hasTelephoneVisitWording("他院で電話相談を受けた。本日は当院へ来院。"),
    false
  );
  assert.equal(
    hasTelephoneVisitWording("前回は対面診療だった。本日は電話再診として対応した。"),
    true
  );
  assert.equal(
    hasTelephoneVisitWording("前回は対面診療だったが本日は電話再診として対応した。"),
    true
  );
  assert.equal(
    hasTelephoneVisitWording("本日、家族から電話相談があり、電話にて必要な指示をした。"),
    true
  );
});

test("past telephone references leave the current in-person revisit unchanged", () => {
  for (const clinicalText of [
    "先週電話で相談があった。本日対面で再診し血圧安定。",
    "前回は電話再診だった。本日は来院。"
  ]) {
    const result = applyEncounterVariantToPreparation(prepared(), {
      session: {
        facilityId: "fac-a",
        setting: "outpatient",
        clinicalText,
        encounterDetails: null
      },
      priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
      historyCompleteness: "complete"
    });

    assert.equal(result.calculationOptions.outpatient_basic.fee_kind, "revisit");
    assert.equal(result.reviewIssues.length, 0);
    assert.equal(result.metrics.encounterVariant.outcome, "not_applicable");
  }
});

test("confirmed telephone eligibility selects the telephone axis and removes outpatient management", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      clinicalText: "家族から電話相談。必要な指示を行った。",
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "user",
        telephoneEligibility: {
          patientInitiated: true,
          instructionGiven: true,
          scheduledManagement: false
        }
      }
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "partial"
  });

  assert.deepEqual(result.calculationOptions.outpatient_basic, {
    fee_kind: "revisit",
    visit_kind: "telephone_revisit",
    telephone_eligibility: {
      established_patient: true,
      patient_initiated: true,
      instruction_given: true,
      scheduled_management: false
    }
  });
  assert.equal(result.candidateProposals.some((item) => item.code === "112011010"), false);
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(result.metrics.encounterVariant.outcome, "eligible");
});

test("confirmed telephone revisit at 18:40 adds the schedule-backed revisit time add-on", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      serviceDate: "2026-06-15",
      receptionTime: "18:40",
      clinicalText: "患者から電話相談。必要な指示を行った。",
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "user",
        telephoneEligibility: {
          patientInitiated: true,
          instructionGiven: true,
          scheduledManagement: false
        }
      }
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "partial",
    feeSettings: facilityServiceSettings()
  });

  assert.equal(result.calculationOptions.outpatient_basic.visit_kind, "telephone_revisit");
  assert.deepEqual(result.calculationOptions.procedure_codes, ["112001110"]);
  assert.equal(result.metrics.encounterFeeSet.timeClass, "after_hours");
  assert.equal(result.metrics.encounterFeeSet.timeAddonCode, "112001110");
});

test("missing facility schedule never guesses a time add-on", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      serviceDate: "2026-06-15",
      receptionTime: "18:40",
      clinicalText: "対面で再診した。",
      encounterDetails: null
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "partial",
    feeSettings: {}
  });

  assert.equal(result.calculationOptions.procedure_codes, undefined);
  assert.equal(result.metrics.encounterFeeSet.scheduleStatus, "schedule_missing");
  assert.ok(result.reviewWarnings.some((warning) => /施設診療時間/u.test(warning)));
});

test("house call combines a history-derived revisit fee with the house-call fee", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "house_call",
      serviceDate: "2026-06-15",
      receptionTime: "10:00",
      clinicalText: "急変の連絡を受けて患家へ往診した。"
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "partial",
    feeSettings: facilityServiceSettings()
  });

  assert.equal(result.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.deepEqual(result.calculationOptions.procedure_codes, ["114000110"]);
  assert.equal(result.metrics.encounterVariant.outcome, "house_call_revisit");
});

test("house call with complete empty history selects initial, while incomplete history stays candidate-only", () => {
  const baseSession = {
    facilityId: "fac-a",
    setting: "house_call",
    serviceDate: "2026-06-15",
    receptionTime: "10:00",
    clinicalText: "急変の連絡を受けて患家へ往診した。"
  };
  const initial = applyEncounterVariantToPreparation(prepared(), {
    session: baseSession,
    priorSessions: [],
    historyCompleteness: "complete",
    feeSettings: facilityServiceSettings()
  });
  const unknown = applyEncounterVariantToPreparation(prepared(), {
    session: baseSession,
    priorSessions: [],
    historyCompleteness: "partial",
    feeSettings: facilityServiceSettings()
  });

  assert.equal(initial.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.equal(Object.hasOwn(unknown.calculationOptions, "outpatient_basic"), false);
  assert.deepEqual(
    unknown.candidateProposals.find(
      (proposal) => proposal.proposalId === "encounter_variant_house_call_basic_fee"
    ).codeCandidates,
    ["111000110", "112007410"]
  );
  assert.equal(unknown.reviewIssues[0].issueCode, "house_call_basic_fee_unconfirmed");
});

test("scheduled home visit suppresses only automatically inferred outpatient basic fees", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "home_visit",
      serviceDate: "2026-06-15",
      receptionTime: "18:40"
    },
    feeSettings: facilityServiceSettings()
  });

  assert.equal(Object.hasOwn(result.calculationOptions, "outpatient_basic"), false);
  assert.equal(result.calculationOptions.procedure_codes, undefined);
  assert.equal(result.metrics.encounterFeeSet.scheduleStatus, "not_applicable");
});

test("unknown telephone eligibility produces a review candidate without normal revisit fallback", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      clinicalText: "患者から電話相談。",
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "dom",
        telephoneEligibility: {
          patientInitiated: true,
          instructionGiven: null,
          scheduledManagement: false
        }
      }
    },
    priorSessions: [],
    historyCompleteness: "partial"
  });

  assert.equal(Object.hasOwn(result.calculationOptions, "outpatient_basic"), false);
  assert.equal(result.candidateProposals.some((item) => item.code === "112007950"), true);
  assert.equal(result.reviewIssues[0].issueCode, "telephone_revisit_eligibility_unconfirmed");
});

test("an explicit disqualifying fact suppresses the fee instead of suggesting adoption", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "user",
        telephoneEligibility: {
          patientInitiated: true,
          instructionGiven: true,
          scheduledManagement: true
        }
      }
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "complete"
  });

  assert.equal(Object.hasOwn(result.calculationOptions, "outpatient_basic"), false);
  assert.equal(result.candidateProposals.some((item) => item.code === "112007950"), false);
  assert.equal(result.reviewIssues[0].issueCode, "telephone_revisit_ineligible");
});

test("telephone wording without structured visit kind never falls back to normal revisit", () => {
  const result = applyEncounterVariantToPreparation(prepared(), {
    session: {
      facilityId: "fac-a",
      setting: "outpatient",
      clinicalText: "家族から電話で相談を受け、指示した。",
      encounterDetails: null
    },
    priorSessions: [{ facilityId: "fac-a", serviceDate: "2026-06-01" }],
    historyCompleteness: "complete"
  });

  assert.equal(Object.hasOwn(result.calculationOptions, "outpatient_basic"), false);
  assert.equal(result.reviewIssues[0].issueCode, "telephone_visit_kind_unconfirmed");
  assert.equal(result.candidateProposals.some((item) => item.code === "112007950"), false);
});
