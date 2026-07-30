import assert from "node:assert/strict";
import test from "node:test";

import {
  applySameHouseholdVisitGovernance,
  buildSameHouseholdVisitContext,
  hasSameHouseholdSameDayVisitEvidence
} from "../src/same-household-visit.js";

const SAME_HOUSEHOLD_TEXT = "妻と二人暮らしで、同一世帯として同日に訪問。";

test("same-household evidence excludes past, planned, and one-sided wording", () => {
  assert.equal(hasSameHouseholdSameDayVisitEvidence(SAME_HOUSEHOLD_TEXT), true);
  assert.equal(
    hasSameHouseholdSameDayVisitEvidence(
      "S）妻と同日訪問。\nP）次月も同一世帯の妻と併せて定期訪問予定。"
    ),
    true
  );
  assert.equal(
    hasSameHouseholdSameDayVisitEvidence("前回、同一世帯として同日に訪問した。"),
    false
  );
  assert.equal(
    hasSameHouseholdSameDayVisitEvidence("次回は同一世帯として同日に訪問する予定。"),
    false
  );
  assert.equal(hasSameHouseholdSameDayVisitEvidence("家族と同居している。"), false);
  assert.equal(hasSameHouseholdSameDayVisitEvidence("妻と同日訪問した。"), false);
  assert.equal(
    hasSameHouseholdSameDayVisitEvidence("次月から同一世帯となり、同日に訪問予定。"),
    false
  );
});

test("cross-draft comparison identifies only the later reception as second visit", () => {
  const first = draft({
    sidecarDraftId: "draft_first",
    externalPatientId: "patient_a",
    receptionTime: "14:30"
  });
  const second = draft({
    sidecarDraftId: "draft_second",
    externalPatientId: "patient_b",
    receptionTime: "14:45"
  });

  assert.equal(buildSameHouseholdVisitContext({
    currentDraft: first,
    siblingDrafts: [second]
  }).status, "first_visit");
  assert.equal(buildSameHouseholdVisitContext({
    currentDraft: second,
    siblingDrafts: [first]
  }).status, "second_visit");
});

test("missing counterpart evidence, different dates, ties, and multiple matches never become second visit", () => {
  const current = draft({
    sidecarDraftId: "draft_current",
    externalPatientId: "patient_current",
    receptionTime: "14:45"
  });
  const noEvidence = draft({
    sidecarDraftId: "draft_no_evidence",
    externalPatientId: "patient_no_evidence",
    receptionTime: "14:30",
    clinicalText: "家族と同居している。"
  });
  const differentDate = draft({
    sidecarDraftId: "draft_different_date",
    externalPatientId: "patient_different_date",
    receptionTime: "14:30",
    serviceDate: "2026-07-29"
  });
  const tied = draft({
    sidecarDraftId: "draft_tied",
    externalPatientId: "patient_tied",
    receptionTime: "14:45"
  });
  const earlierA = draft({
    sidecarDraftId: "draft_a",
    externalPatientId: "patient_a",
    receptionTime: "14:20"
  });
  const earlierB = draft({
    sidecarDraftId: "draft_b",
    externalPatientId: "patient_b",
    receptionTime: "14:30"
  });

  assert.equal(buildSameHouseholdVisitContext({
    currentDraft: current,
    siblingDrafts: [noEvidence, differentDate]
  }).status, "awaiting_counterpart");
  assert.equal(buildSameHouseholdVisitContext({
    currentDraft: current,
    siblingDrafts: [tied]
  }).status, "ambiguous_visit_order");
  assert.equal(buildSameHouseholdVisitContext({
    currentDraft: current,
    siblingDrafts: [earlierA, earlierB]
  }).status, "ambiguous_multiple_counterparts");
});

test("second visit suppresses only role-tagged home-visit confirmations and emits blocked candidates", () => {
  const prepared = {
    calculationOptions: {
      procedure_codes: ["114030310", "180726010", "114057970"]
    },
    candidateProposals: [],
    reviewIssues: [],
    reviewWarnings: [
      "施設恒常算定ルール: 訪問診療料(114030310)を施設設定に基づき算定へ自動追加しました。",
      "施設恒常算定ルール: ベースアップ(180726010)を施設設定に基づき算定へ自動追加しました。",
      "残す警告"
    ],
    metrics: {
      autoBillingRules: {
        appliedCount: 3,
        applied: [
          { code: "114030310", billingRole: "home_visit_basic" },
          { code: "180726010", billingRole: "home_visit_baseup" },
          { code: "114057970", billingRole: "standard" }
        ]
      }
    }
  };
  const result = applySameHouseholdVisitGovernance(prepared, {
    session: {
      sameHouseholdVisitContext: {
        status: "second_visit",
        receptionTime: "14:45",
        counterpartReceptionTime: "14:30",
        counterpartCount: 1
      }
    }
  });

  assert.deepEqual(result.calculationOptions.procedure_codes, ["114057970"]);
  assert.deepEqual(
    result.candidateProposals.map((proposal) => proposal.code),
    ["112007410", "112016070", "112015770", "112011010", "180725810"]
  );
  assert.ok(result.candidateProposals.every((proposal) => (
    proposal.candidateOnly === true
    && proposal.reviewRequired === true
    && proposal.adoptionBlocked === true
    && proposal.ruleArtifact?.effectiveFrom === "2026-06-01"
  )));
  assert.deepEqual(
    Object.fromEntries(result.candidateProposals.map((proposal) => [
      proposal.code,
      proposal.requiredFacilityStandardKeys
    ])),
    {
      "112007410": [],
      "112016070": ["jikan_gai_taio_taisei_1"],
      "112015770": ["meisaisho_hakko_taisei"],
      "112011010": [],
      "180725810": ["base_up_hyoka_1"]
    }
  );
  assert.deepEqual(result.metrics.autoBillingRules.applied.map((entry) => entry.code), [
    "114057970"
  ]);
  assert.equal(result.reviewWarnings.includes("残す警告"), true);
  assert.equal(result.metrics.sameHouseholdVisit.replacementCandidateCount, 5);
});

test("first visit keeps the normal home-visit calculation and emits no replacement candidate", () => {
  const prepared = {
    calculationOptions: { procedure_codes: ["114030310"] },
    candidateProposals: []
  };
  const result = applySameHouseholdVisitGovernance(prepared, {
    session: {
      sameHouseholdVisitContext: {
        status: "first_visit",
        receptionTime: "14:30",
        counterpartReceptionTime: "14:45",
        counterpartCount: 1
      }
    }
  });

  assert.deepEqual(result.calculationOptions.procedure_codes, ["114030310"]);
  assert.deepEqual(result.candidateProposals, []);
  assert.equal(result.metrics.sameHouseholdVisit.replacementCandidateCount, 0);
});

function draft(overrides = {}) {
  return {
    sidecarDraftId: "draft_fixture",
    externalPatientId: "patient_fixture",
    facilityId: "facility_fixture",
    serviceDate: "2026-07-30",
    setting: "home_visit",
    receptionTime: "14:30",
    clinicalText: SAME_HOUSEHOLD_TEXT,
    ...overrides
  };
}
