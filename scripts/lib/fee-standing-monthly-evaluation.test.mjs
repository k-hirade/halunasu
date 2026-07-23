import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStandingMonthlyFixture,
  previousClaimMonth,
  standingProfileAudit,
  standingProposalSelection,
  summarizeStandingMonthlyRepeats
} from "./fee-standing-monthly-evaluation.mjs";

const CHART_TEXT = "P）在宅人工呼吸指導管理を継続する。";

function fixture(overrides = {}) {
  return {
    schemaVersion: "fee-standing-monthly-e2e.v1",
    patientId: "1002",
    priorMonth: {
      claimMonth: "2026-05",
      serviceDate: "2026-05-26",
      visitType: "定期",
      status: "定期",
      clinicalText: CHART_TEXT,
      expectedStandingCodes: ["114005410"]
    },
    currentMonth: {
      claimMonth: "2026-06",
      copyForwardServiceDate: "2026-06-02",
      expectedStandingCodes: ["114005410"]
    },
    acceptance: {
      requireMemoHit: true,
      requireCurrentStandingApproval: true
    },
    ...overrides
  };
}

test("normalizes a previous-month copy-forward standing fixture", () => {
  const result = normalizeStandingMonthlyFixture(fixture(), {
    claimMonth: "2026-06",
    patientId: "1002",
    charts: [{
      service_date: "2026-06-02",
      clinical_text: CHART_TEXT
    }]
  });

  assert.equal(result.priorMonth.claimMonth, "2026-05");
  assert.equal(result.currentMonth.copyForwardServiceDate, "2026-06-02");
  assert.deepEqual(result.currentMonth.expectedStandingCodes, ["114005410"]);
});

test("rejects a fixture that is not an exact copy-forward input", () => {
  assert.throws(() => normalizeStandingMonthlyFixture(fixture(), {
    claimMonth: "2026-06",
    patientId: "1002",
    charts: [{
      service_date: "2026-06-02",
      clinical_text: "different"
    }]
  }), /exactly match/u);
});

test("requires the immediately preceding claim month", () => {
  assert.equal(previousClaimMonth("2026-01"), "2025-12");
  assert.throws(() => previousClaimMonth("2026-13"), /calendar month/u);
  assert.throws(() => normalizeStandingMonthlyFixture(fixture({
    priorMonth: {
      ...fixture().priorMonth,
      claimMonth: "2026-04",
      serviceDate: "2026-04-26"
    }
  }), {
    claimMonth: "2026-06",
    patientId: "1002",
    charts: [{
      service_date: "2026-06-02",
      clinical_text: CHART_TEXT
    }]
  }), /prior month must be 2026-05/u);
});

test("selects only expected standing-lane proposals", () => {
  const selection = standingProposalSelection([
    {
      reviewItemId: "proposal_expected",
      sourceType: "candidate_proposal",
      candidateProposal: {
        proposalId: "standing_expected",
        code: "114005410",
        basis: "standing_mention_first_month_candidate",
        source: "standing_fact_lane"
      }
    },
    {
      reviewItemId: "proposal_other",
      sourceType: "candidate_proposal",
      candidateProposal: {
        proposalId: "other",
        code: "114005410",
        basis: "other",
        source: "dictionary_scan"
      }
    }
  ], {
    expectedCodes: ["114005410"],
    expectedBasis: "standing_mention_first_month_candidate"
  });

  assert.deepEqual(selection.matchedCodes, ["114005410"]);
  assert.deepEqual(selection.missingCodes, []);
  assert.deepEqual(selection.decisions, [{
    reviewItemId: "proposal_expected",
    status: "approved"
  }]);
});

test("audits confirmed profile occurrences by claim month", () => {
  const audit = standingProfileAudit([
    {
      standingFactId: "fact_ended",
      feeFamily: "family_1",
      status: "ended",
      confirmedOccurrences: [
        { claimMonth: "2026-06", codes: ["114005410"] }
      ]
    },
    {
      standingFactId: "fact_1",
      feeFamily: "family_1",
      status: "active",
      confirmedOccurrences: [
        { claimMonth: "2026-05", codes: ["114005410"] },
        { claimMonth: "2026-06", codes: ["114005410"] }
      ]
    }
  ], ["114005410"], "2026-06");

  assert.equal(audit.profileCount, 1);
  assert.deepEqual(audit.matchedCodes, ["114005410"]);
  assert.deepEqual(audit.missingCodes, []);
});

test("summarizes all standing acceptance checks across repeats", () => {
  const summary = summarizeStandingMonthlyRepeats([
    {
      standingTimeline: {
        acceptance: {
          priorCandidateObserved: true,
          priorConfirmationRecorded: true,
          currentCandidateObserved: true,
          currentConfirmationRecorded: true,
          currentMonthlyLineIncluded: true,
          memoHit: true,
          passed: true
        }
      }
    },
    {
      standingTimeline: {
        acceptance: {
          priorCandidateObserved: true,
          priorConfirmationRecorded: true,
          currentCandidateObserved: true,
          currentConfirmationRecorded: true,
          currentMonthlyLineIncluded: true,
          memoHit: true,
          passed: true
        }
      }
    }
  ]);

  assert.equal(summary.repeatCount, 2);
  assert.equal(summary.memoHitCount, 2);
  assert.equal(summary.allAcceptanceChecksPassed, true);
});
