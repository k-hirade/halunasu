import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStandingBillingEvidence,
  applyStandingBillingManualState,
  buildStandingBillingLane,
  isFinalStandingStopText,
  standingBillingEvidenceKey,
  standingBillingProfileId,
  standingFrequencyEligibility
} from "../src/standing-billing-profiles.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

const FAMILY = Object.freeze({
  familyId: "family_home_management",
  name: "在宅呼吸管理料",
  aliases: ["在宅呼吸管理", "人工呼吸器管理"],
  variants: [
    {
      code: "113000001",
      name: "在宅呼吸管理料",
      points: 2800,
      aliases: ["在宅呼吸管理料"],
      frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
    }
  ]
});

const HOME_MANAGEMENT_FAMILY = Object.freeze({
  familyId: "fee_family_home_management",
  name: "在医総管",
  aliases: ["在医総管", "在宅時医学総合管理料"],
  hierarchy: {
    chapter: "2",
    part: "02",
    alphaPart: "C",
    section: "002",
    branch: "00"
  },
  variants: [
    {
      code: "114100001",
      name: "在医総管（機能強化在支診等・月２回以上・１人）",
      points: 5000,
      frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
    },
    {
      code: "114100002",
      name: "在医総管（在支診等以外・月１回・１人）",
      points: 2500,
      frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
    }
  ]
});

const MEDICATION_REDUCTION_FAMILY = Object.freeze({
  familyId: "fee_family_medication_reduction",
  name: "薬剤総合評価調整管理料",
  aliases: ["薬剤総合評価調整管理料"],
  hierarchy: {
    chapter: "2",
    part: "01",
    alphaPart: "B",
    section: "008",
    branch: "02"
  },
  variants: [
    {
      code: "113043210",
      name: "薬剤総合評価調整管理料",
      points: 250,
      frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
    }
  ]
});

function homeManagementStructuredFacts(overrides = {}) {
  return {
    encounter: {
      plannedHomeVisit: true,
      residenceType: "private",
      ...overrides.encounter
    },
    clinical: {
      activeDiagnosisCount: 2,
      currentManagementOrCounselingCount: 1,
      medicationFactCount: 2,
      deviceFactCount: 0,
      testFactCount: 1,
      ...overrides.clinical
    }
  };
}

function confirmedProfile(overrides = {}) {
  return applyStandingBillingEvidence(null, {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-06",
    family: FAMILY,
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_1"
    },
    ...overrides
  }, { now: new Date("2026-06-20T00:00:00.000Z") });
}

test("standing profile and evidence IDs are deterministic and facility scoped", () => {
  const base = {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    feeFamily: "family_1"
  };
  assert.equal(standingBillingProfileId(base), standingBillingProfileId(base));
  assert.notEqual(
    standingBillingProfileId(base),
    standingBillingProfileId({ ...base, facilityId: "fac_2" })
  );
  assert.equal(
    standingBillingEvidenceKey({
      type: "confirmed_claim",
      ref: "fee_1",
      claimMonth: "2026-06"
    }),
    standingBillingEvidenceKey({
      type: "confirmed_claim",
      ref: "fee_1",
      claimMonth: "2026-06"
    })
  );
});

test("replaying the same evidence is idempotent", () => {
  const first = confirmedProfile();
  const replay = applyStandingBillingEvidence(first, {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-06",
    family: FAMILY,
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_1"
    }
  }, { now: new Date("2026-06-21T00:00:00.000Z") });

  assert.equal(replay.evidence.length, 1);
  assert.equal(replay.confirmedOccurrences.length, 1);
  assert.deepEqual(replay.evidence, first.evidence);
});

test("late import of an older claim does not roll back the latest confirmed codes", () => {
  const family = {
    ...FAMILY,
    maxWindowMonths: 3,
    variants: [
      ...FAMILY.variants,
      {
        code: "113000002",
        name: "在宅呼吸管理料（旧区分）",
        points: 2700,
        aliases: ["在宅呼吸管理料旧区分"],
        frequencyLimits: [{ windowMonths: 3, maxCount: 3 }]
      }
    ]
  };
  const latest = confirmedProfile({
    family,
    claimMonth: "2026-07",
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_july"
    },
    maxWindowMonths: 3
  });
  const importedOlder = applyStandingBillingEvidence(latest, {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-06",
    family,
    codes: [{ code: "113000002", name: "在宅呼吸管理料（旧区分）" }],
    evidence: {
      type: "confirmed_claim",
      ref: "external_claim_june"
    },
    maxWindowMonths: 3
  }, { now: new Date("2026-07-25T00:00:00.000Z") });

  assert.equal(importedOlder.lastConfirmedClaimMonth, "2026-07");
  assert.deepEqual(
    importedOlder.lastConfirmedCodes.map((entry) => entry.code),
    ["113000001"]
  );
  assert.deepEqual(
    importedOlder.confirmedOccurrences.map((entry) => entry.claimMonth),
    ["2026-06", "2026-07"]
  );
});

test("same-month evidence merges latest codes independently of import order", () => {
  const family = {
    ...FAMILY,
    variants: [
      ...FAMILY.variants,
      {
        code: "113000002",
        name: "人工呼吸器加算",
        points: 7480,
        aliases: ["人工呼吸器加算"],
        frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
      }
    ]
  };
  const evidence = [
    {
      code: "113000001",
      name: "在宅呼吸管理料",
      ref: "confirmed_management"
    },
    {
      code: "113000002",
      name: "人工呼吸器加算",
      ref: "confirmed_device"
    }
  ];
  const applyInOrder = (ordered) => ordered.reduce((profile, item) => (
    applyStandingBillingEvidence(profile, {
      orgId: "org_1",
      facilityId: "fac_1",
      canonicalPatientId: "pat_1",
      claimMonth: "2026-07",
      family,
      codes: [{ code: item.code, name: item.name }],
      evidence: {
        type: "confirmed_claim",
        ref: item.ref
      }
    }, { now: new Date("2026-07-25T00:00:00.000Z") })
  ), null);

  const forward = applyInOrder(evidence);
  const reverse = applyInOrder([...evidence].reverse());

  assert.deepEqual(forward.lastConfirmedCodes, reverse.lastConfirmedCodes);
  assert.deepEqual(
    forward.lastConfirmedCodes.map((entry) => entry.code),
    ["113000001", "113000002"]
  );
});

test("manual stop wins over later confirmed evidence until a human resumes it", () => {
  const stopped = applyStandingBillingManualState(confirmedProfile(), {
    stopped: true,
    byMemberId: "mem_admin",
    note: "対象外を確認"
  }, { now: new Date("2026-06-22T00:00:00.000Z") });
  const confirmedAgain = applyStandingBillingEvidence(stopped, {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-07",
    family: FAMILY,
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_2"
    }
  }, { now: new Date("2026-07-20T00:00:00.000Z") });

  assert.equal(confirmedAgain.status, "ended");
  assert.equal(confirmedAgain.manualStop.stopped, true);
  assert.equal(confirmedAgain.evidence.length, 2);
});

test("active prior-month profile proposes a candidate but current-month confirmation suppresses it", () => {
  const profile = confirmedProfile();
  const proposed = buildStandingBillingLane({
    profiles: [profile],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-10",
    historyCompleteness: "complete"
  });
  assert.equal(proposed.candidateProposals.length, 1);
  assert.equal(proposed.candidateProposals[0].candidateOnly, true);
  assert.match(proposed.candidateProposals[0].reason, /2026-06に確定済み/u);

  const currentMonth = applyStandingBillingEvidence(profile, {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-07",
    family: FAMILY,
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_2"
    }
  }, { now: new Date("2026-07-10T00:00:00.000Z") });
  const suppressed = buildStandingBillingLane({
    profiles: [currentMonth],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-15",
    historyCompleteness: "complete"
  });
  assert.equal(suppressed.candidateProposals.length, 0);
  assert.equal(suppressed.metrics.reasons.already_confirmed_current_month, 1);
});

test("future confirmed evidence does not leak into a historical recalculation", () => {
  const futureProfile = confirmedProfile({
    claimMonth: "2026-07",
    evidence: {
      type: "confirmed_claim",
      ref: "fee_session_july"
    }
  });
  const result = buildStandingBillingLane({
    profiles: [futureProfile],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-06-15",
    historyCompleteness: "complete"
  });

  assert.equal(result.candidateProposals.length, 0);
  assert.equal(result.metrics.reasons.future_only_evidence, 1);
});

test("rolling limit counts occurrences rather than treating the period as an interval", () => {
  const variant = {
    frequencyLimits: [{ windowMonths: 2, maxCount: 2 }]
  };
  const once = {
    confirmedOccurrences: [
      { claimMonth: "2026-06", evidenceKey: "e1", codes: ["code_1"] }
    ]
  };
  assert.equal(standingFrequencyEligibility(once, variant, "2026-07").allowed, true);

  const twice = {
    confirmedOccurrences: [
      { claimMonth: "2026-06", evidenceKey: "e1", codes: ["code_1"] },
      { claimMonth: "2026-06", evidenceKey: "e2", codes: ["code_2"] }
    ]
  };
  const reached = standingFrequencyEligibility(twice, variant, "2026-07");
  assert.equal(reached.allowed, false);
  assert.equal(reached.reason, "rolling_limit_reached");
});

test("standing lane works without extracted clinical events", () => {
  const result = buildStandingBillingLane({
    profiles: [confirmedProfile()],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-10",
    standingMentions: []
  });
  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.trace.stage, "standing_fact_lane");
});

test("multi-variant families use current encounter inputs instead of the previous code", () => {
  const family = {
    familyId: "family_home_visit_management",
    name: "在宅管理料",
    aliases: ["在宅管理"],
    variants: [
      {
        code: "113100001",
        name: "在宅管理料（月１回・同一建物居住者以外・１人）",
        points: 100,
        frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
      },
      {
        code: "113100002",
        name: "在宅管理料（月２回以上・同一建物居住者・２～９人）",
        points: 200,
        frequencyLimits: [{ windowMonths: 1, maxCount: 1 }]
      }
    ]
  };
  const profile = confirmedProfile({
    family,
    codes: [{ code: "113100001", name: family.variants[0].name }]
  });
  const result = buildStandingBillingLane({
    profiles: [profile],
    catalog: { families: [family] },
    serviceDate: "2026-07-10",
    currentInputs: {
      encounterDetails: {
        sameBuilding: true,
        singleBuildingPatientCount: 4
      },
      currentMonthEncounterCount: 2
    }
  });

  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].code, "113100002");
  assert.notEqual(result.candidateProposals[0].code, profile.lastConfirmedCodes[0].code);
});

test("multi-variant families remain unresolved when current inputs cannot select one", () => {
  const family = {
    familyId: "family_variant_input_required",
    name: "在宅管理料",
    aliases: ["在宅管理"],
    variants: [
      { code: "113200001", name: "在宅管理料（同一建物居住者以外）", points: 100 },
      { code: "113200002", name: "在宅管理料（同一建物居住者）", points: 80 }
    ]
  };
  const profile = confirmedProfile({
    family,
    codes: [{ code: "113200001", name: family.variants[0].name }]
  });
  const result = buildStandingBillingLane({
    profiles: [profile],
    catalog: { families: [family] },
    serviceDate: "2026-07-10"
  });

  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].code, "");
  assert.equal(result.candidateProposals[0].actionType, "confirm_required");
  assert.deepEqual(result.candidateProposals[0].codeCandidates, ["113200001", "113200002"]);
});

test("stopped mentions suspend a profile while deliberation and continuation do not", () => {
  assert.equal(isFinalStandingStopText("人工呼吸器を抜去した。"), true);
  assert.equal(isFinalStandingStopText("中止も検討したが、人工呼吸器管理を継続する。"), false);
  assert.equal(isFinalStandingStopText("中止せず管理を継続する。"), false);

  const result = buildStandingBillingLane({
    profiles: [confirmedProfile()],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-10",
    standingMentions: [{
      lineId: "L1",
      target: "人工呼吸器管理",
      status: "stopped",
      text: "人工呼吸器を抜去した。"
    }]
  });
  assert.equal(result.candidateProposals.length, 0);
  assert.equal(result.statusTransitions[0].status, "suspended");
  assert.equal(result.reviewIssues[0].issueCode, "standing_fact_stopped");
});

test("stale profiles and unavailable history produce review issues instead of candidates", () => {
  const stale = buildStandingBillingLane({
    profiles: [confirmedProfile({ claimMonth: "2026-03" })],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-10",
    stalenessMonths: 3
  });
  assert.equal(stale.candidateProposals.length, 0);
  assert.equal(stale.reviewIssues[0].issueCode, "standing_fact_stale");

  const unavailable = buildStandingBillingLane({
    profiles: [confirmedProfile()],
    catalog: { families: [FAMILY] },
    serviceDate: "2026-07-10",
    historyCompleteness: "unavailable"
  });
  assert.equal(unavailable.candidateProposals.length, 0);
  assert.equal(unavailable.reviewIssues[0].issueCode, "standing_history_unavailable");
});

test("first-month management mention creates only a review candidate and no profile", () => {
  const wordingVariantFamily = {
    ...FAMILY,
    aliases: ["在宅人工呼吸指導管理料"]
  };
  const result = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [wordingVariantFamily] },
    serviceDate: "2026-07-10",
    standingMentions: [{
      lineId: "L1",
      target: "人工呼吸器管理",
      status: "continued",
      text: "人工呼吸器管理を継続する。"
    }]
  });
  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].basis, "standing_mention_first_month_candidate");
  assert.equal(result.candidateProposals[0].candidateOnly, true);
  assert.equal(result.statusTransitions.length, 0);
});

test("W1c emits an unresolved review-only family candidate from structured positive facts", () => {
  const result = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [HOME_MANAGEMENT_FAMILY] },
    serviceDate: "2026-07-10",
    standingMentions: [],
    currentInputs: {
      structuredFacts: homeManagementStructuredFacts()
    }
  });

  assert.equal(result.candidateProposals.length, 1);
  const proposal = result.candidateProposals[0];
  assert.equal(proposal.basis, "standing_structured_trigger_candidate");
  assert.equal(proposal.candidateOnly, true);
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.actionType, "confirm_required");
  assert.equal(proposal.code, "");
  assert.equal(proposal.candidateLine, null);
  assert.deepEqual(proposal.codeCandidates, ["114100001", "114100002"]);
  assert.equal(proposal.standingTrigger.version, "2026");
  assert.equal(result.metrics.reasons.structured_trigger_candidate, 1);
});

test("W1c does not infer management from outpatient or medication-only facts", () => {
  const outpatient = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [HOME_MANAGEMENT_FAMILY] },
    serviceDate: "2026-07-10",
    currentInputs: {
      structuredFacts: homeManagementStructuredFacts({
        encounter: { plannedHomeVisit: false }
      })
    }
  });
  assert.equal(outpatient.candidateProposals.length, 0);

  const medicationOnly = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [HOME_MANAGEMENT_FAMILY] },
    serviceDate: "2026-07-10",
    currentInputs: {
      structuredFacts: homeManagementStructuredFacts({
        clinical: {
          currentManagementOrCounselingCount: 0,
          medicationFactCount: 4
        }
      })
    }
  });
  assert.equal(medicationOnly.candidateProposals.length, 0);
});

test("confirm-with-note trigger exposes an exact candidate but keeps adoption blocked", () => {
  const result = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [MEDICATION_REDUCTION_FAMILY] },
    serviceDate: "2026-07-10",
    currentInputs: {
      structuredFacts: {
        clinical: {
          explicitMedicationReductionTwoOrMore: true
        }
      }
    }
  });

  assert.equal(result.candidateProposals.length, 1);
  const proposal = result.candidateProposals[0];
  assert.equal(proposal.code, "113043210");
  assert.equal(proposal.potentialPoints, 250);
  assert.equal(proposal.candidateOnly, true);
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.adoptionBlocked, true);
  assert.equal(proposal.adoptionBlockReason, "human_verification_required");
  assert.match(proposal.conditionText, /6種類以上/u);
  assert.match(proposal.conditionText, /4週間以上/u);
});

test("confirm-with-note trigger stays silent without its minimum positive fact", () => {
  const result = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [MEDICATION_REDUCTION_FAMILY] },
    serviceDate: "2026-07-10",
    currentInputs: {
      structuredFacts: {
        clinical: {
          explicitMedicationReductionTwoOrMore: false
        }
      }
    }
  });

  assert.equal(result.candidateProposals.length, 0);
});

test("W1 confirmed history suppresses W1c for the same family", () => {
  const profile = confirmedProfile({
    family: HOME_MANAGEMENT_FAMILY,
    codes: [{
      code: HOME_MANAGEMENT_FAMILY.variants[0].code,
      name: HOME_MANAGEMENT_FAMILY.variants[0].name
    }]
  });
  const result = buildStandingBillingLane({
    profiles: [profile],
    catalog: { families: [HOME_MANAGEMENT_FAMILY] },
    serviceDate: "2026-07-10",
    currentInputs: {
      structuredFacts: homeManagementStructuredFacts()
    }
  });

  assert.equal(
    result.candidateProposals.some((proposal) => proposal.basis === "standing_structured_trigger_candidate"),
    false
  );
  assert.equal(result.metrics.reasons.structured_trigger_suppressed_by_history, 1);
});

test("W1b explicit first-month mention suppresses duplicate W1c output", () => {
  const result = buildStandingBillingLane({
    profiles: [],
    catalog: { families: [HOME_MANAGEMENT_FAMILY] },
    serviceDate: "2026-07-10",
    standingMentions: [{
      lineId: "L1",
      target: "在医総管",
      status: "continued",
      text: "在医総管を継続する。"
    }],
    currentInputs: {
      structuredFacts: homeManagementStructuredFacts()
    }
  });

  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].basis, "standing_mention_first_month_candidate");
  assert.equal(result.metrics.reasons.structured_trigger_suppressed_by_mention, 1);
});

test("memory store persists profiles by facility and applies manual state transitions", () => {
  const store = new MemoryFeeStore({
    now: () => new Date("2026-06-20T00:00:00.000Z")
  });
  const profile = store.recordStandingBillingEvidence("org_1", {
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    claimMonth: "2026-06",
    family: FAMILY,
    codes: [{ code: "113000001", name: "在宅呼吸管理料" }],
    evidence: { type: "confirmed_claim", ref: "fee_session_1" }
  });

  assert.equal(
    store.listStandingBillingProfilesForPatient("org_1", "fac_1", "pat_1").length,
    1
  );
  assert.equal(
    store.listStandingBillingProfilesForPatient("org_1", "fac_2", "pat_1").length,
    0
  );
  const stopped = store.updateStandingBillingProfileManualState(
    "org_1",
    profile.standingFactId,
    { stopped: true, byMemberId: "mem_admin" }
  );
  assert.equal(stopped.status, "ended");
  assert.equal(store.getStandingBillingProfile("org_1", profile.standingFactId).manualStop.stopped, true);
});
