import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCandidateProposalGovernance,
  proposalGovernanceArtifactMetadata
} from "../src/candidate-proposal-governance.js";

const DEMENTIA_CODES = [
  "113014610",
  "113022610",
  "113022710",
  "113042610"
];

test("proposal governance artifact is versioned and checksum-protected", () => {
  const metadata = proposalGovernanceArtifactMetadata();
  assert.equal(metadata.schemaVersion, "fee-proposal-governance-artifact-v2");
  assert.equal(metadata.effectiveFrom, "2026-06-01");
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.match(metadata.sourceDefinitionSha256, /^[a-f0-9]{64}$/u);
});

test("facility-standard governance supports satisfied, not-satisfied, and unknown states", () => {
  const proposals = [proposal("dementia-1", DEMENTIA_CODES[1])];

  const satisfied = applyCandidateProposalGovernance({
    candidateProposals: proposals,
    facilityStandardsConfirmed: true,
    facilityStandardKeys: ["ninchisho_shikkan_iryo_center"]
  });
  assert.equal(satisfied.candidateProposals.length, 1);
  assert.equal(satisfied.candidateProposals[0].facilityStandardStatus, "satisfied");
  assert.equal(satisfied.reviewIssues.length, 0);

  const notSatisfied = applyCandidateProposalGovernance({
    candidateProposals: proposals,
    facilityStandardsConfirmed: true,
    facilityStandardKeys: []
  });
  assert.equal(notSatisfied.candidateProposals.length, 0);
  assert.equal(notSatisfied.reviewIssues[0].issueCode, "facility_standard_not_satisfied");

  const unknown = applyCandidateProposalGovernance({
    candidateProposals: proposals,
    facilityStandardsConfirmed: false,
    facilityStandardKeys: []
  });
  assert.equal(unknown.candidateProposals.length, 1);
  assert.equal(unknown.candidateProposals[0].facilityStandardStatus, "unknown");
  assert.equal(unknown.candidateProposals[0].adoptionBlocked, true);
  assert.equal(unknown.candidateProposals[0].actionType, "confirm_required");
  assert.equal(unknown.reviewIssues[0].issueCode, "facility_standard_unconfirmed");
});

test("official variant family groups mutually exclusive candidate proposals", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("dementia-1", DEMENTIA_CODES[1]),
      proposal("dementia-2", DEMENTIA_CODES[0])
    ],
    facilityStandardsConfirmed: true,
    facilityStandardKeys: ["ninchisho_shikkan_iryo_center"]
  });
  assert.equal(result.candidateProposals.length, 2);
  assert.equal(result.diagnostics.variantFamilyGroupCount, 1);
  assert.equal(result.candidateProposals[0].selectionGroupId, result.candidateProposals[1].selectionGroupId);
  assert.equal(result.candidateProposals[0].selectionMode, "choose_one");
  assert.equal(result.candidateProposals[0].mutuallyExclusive, true);
});

test("unconditional canonical pairs group without transitive closure", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("a", "111000001"),
      proposal("b", "111000002"),
      proposal("c", "111000003")
    ],
    canonicalExclusionRules: [{
      scope: "same_day",
      codeA: "111000001",
      codeB: "111000002",
      resolution: "demote_lower_points",
      specialCondition: "0",
      ruleFingerprint: "a".repeat(64)
    }]
  });
  assert.equal(result.diagnostics.canonicalExclusionGroupCount, 1);
  assert.equal(result.candidateProposals[0].selectionGroupId, result.candidateProposals[1].selectionGroupId);
  assert.equal(result.candidateProposals[0].selectionGroupLabel, "同時算定不可項目");
  assert.equal(result.candidateProposals[2].selectionGroupId, undefined);
});

test("overlapping canonical edges remain warnings instead of creating inconsistent groups", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("a", "111000001"),
      proposal("b", "111000002"),
      proposal("c", "111000003")
    ],
    canonicalExclusionRules: [
      {
        scope: "same_day",
        codeA: "111000001",
        codeB: "111000002",
        resolution: "choose_one",
        specialCondition: "0"
      },
      {
        scope: "same_day",
        codeA: "111000002",
        codeB: "111000003",
        resolution: "choose_one",
        specialCondition: "0"
      }
    ]
  });
  assert.equal(result.diagnostics.canonicalExclusionGroupCount, 0);
  assert.equal(result.diagnostics.canonicalAmbiguousComponentCount, 1);
  assert.equal(result.candidateProposals.some((entry) => entry.selectionGroupId), false);
});

test("conditional canonical rules and unrelated proposals are not grouped", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("a", "111000001"),
      proposal("b", "111000002")
    ],
    canonicalExclusionRules: [{
      scope: "same_day",
      codeA: "111000001",
      codeB: "111000002",
      resolution: "conditional_review",
      specialCondition: "1"
    }]
  });
  assert.equal(result.diagnostics.canonicalExclusionGroupCount, 0);
  assert.equal(result.diagnostics.ignoredConditionalExclusionRuleCount, 1);
  assert.equal(result.candidateProposals.some((entry) => entry.selectionGroupId), false);
});

test("confirmed home ventilator management suppresses bundled J045 proposals with one reason", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("ventilation-short", "140009310"),
      proposal("ventilation-long", "140023510"),
      proposal("unrelated", "111000001")
    ],
    confirmedProcedureCodes: ["114005410"]
  });

  assert.deepEqual(
    result.candidateProposals.map((entry) => entry.proposalId),
    ["unrelated"]
  );
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].issueCode, "bundled_procedure_suppressed");
  assert.equal(result.diagnostics.bundlingSuppressedProposalCount, 2);
});

test("candidate-stage home ventilator management retains J045 with a bundling review", () => {
  const result = applyCandidateProposalGovernance({
    candidateProposals: [
      proposal("management", "114005410"),
      proposal("ventilation", "140009310")
    ]
  });

  assert.equal(result.candidateProposals.length, 2);
  const ventilation = result.candidateProposals.find((entry) => (
    entry.proposalId === "ventilation"
  ));
  assert.equal(ventilation.bundlingReviewRequired, true);
  assert.equal(ventilation.actionType, "confirm_required");
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].issueCode, "bundled_procedure_review_required");
});

test("unrelated proposals are unchanged when no management parent exists", () => {
  const input = proposal("ventilation", "140009310");
  const result = applyCandidateProposalGovernance({
    candidateProposals: [input]
  });
  assert.deepEqual(result.candidateProposals, [input]);
  assert.equal(result.reviewIssues.length, 0);
});

function proposal(proposalId, code) {
  return {
    proposalId,
    title: proposalId,
    code,
    candidateOnly: true,
    candidateLine: {
      code,
      name: proposalId,
      points: 100
    }
  };
}
