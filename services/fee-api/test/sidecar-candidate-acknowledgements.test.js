import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decorateSidecarCandidateAcknowledgements,
  findSidecarAcknowledgementCandidate,
  sidecarAcknowledgementTargets,
  sidecarCandidateFingerprint,
  sidecarCandidateKey
} from "../src/sidecar-candidate-acknowledgements.js";

test("sidecar acknowledgement identity is stable while decision content changes its fingerprint", () => {
  const candidate = decisionCandidate();
  assert.match(sidecarCandidateKey(candidate), /^sca_[a-f0-9]{26}$/u);
  assert.equal(sidecarCandidateKey(candidate), sidecarCandidateKey({ ...candidate, points: 200 }));
  assert.notEqual(
    sidecarCandidateFingerprint(candidate),
    sidecarCandidateFingerprint({ ...candidate, points: 200 })
  );
  assert.notEqual(
    sidecarCandidateFingerprint(candidate),
    sidecarCandidateFingerprint(candidate, {
      pricingBasis: { referenceDataDate: "2026-08-01" }
    })
  );
});

test("decision candidates receive current, excluded, stale, and unacknowledged acknowledgement views", () => {
  const candidate = decisionCandidate();
  const candidateKey = sidecarCandidateKey(candidate);
  const fingerprint = sidecarCandidateFingerprint(candidate, {
    pricingBasis: { referenceDataDate: "2026-06-15" }
  });
  const current = decorateSidecarCandidateAcknowledgements({
    candidates: [candidate],
    pricingBasis: { referenceDataDate: "2026-06-15" },
    sourceRevision: 2,
    candidateAcknowledgements: {
      [candidateKey]: {
        status: "acknowledged",
        candidateFingerprint: fingerprint,
        sourceRevision: 2,
        version: 3,
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    }
  });
  assert.deepEqual(current[0].acknowledgement, {
    status: "acknowledged",
    version: 3,
    updatedAt: "2026-08-03T00:00:00.000Z"
  });
  assert.deepEqual(sidecarAcknowledgementTargets(current), [{
    candidateKey,
    candidateFingerprint: fingerprint
  }]);
  assert.equal(findSidecarAcknowledgementCandidate(current, candidateKey)?.candidateId, candidate.candidateId);

  const excluded = decorateSidecarCandidateAcknowledgements({
    candidates: [candidate],
    pricingBasis: { referenceDataDate: "2026-06-15" },
    sourceRevision: 2,
    candidateAcknowledgements: {
      [candidateKey]: {
        status: "excluded",
        candidateFingerprint: fingerprint,
        sourceRevision: 2,
        version: 4,
        updatedAt: "2026-08-03T00:01:00.000Z"
      }
    }
  });
  assert.deepEqual(excluded[0].acknowledgement, {
    status: "excluded",
    version: 4,
    updatedAt: "2026-08-03T00:01:00.000Z"
  });
  assert.equal(excluded[0].candidateOnly, candidate.candidateOnly);
  assert.equal(excluded[0].estimatedTotalPoints, candidate.estimatedTotalPoints);

  const staleExcluded = decorateSidecarCandidateAcknowledgements({
    candidates: [{ ...candidate, points: 200 }],
    sourceRevision: 2,
    candidateAcknowledgements: {
      [candidateKey]: {
        status: "excluded",
        candidateFingerprint: fingerprint,
        sourceRevision: 2,
        version: 4
      }
    }
  });
  assert.equal(staleExcluded[0].acknowledgement.status, "stale");

  const stale = decorateSidecarCandidateAcknowledgements({
    candidates: [{ ...candidate, points: 200 }],
    sourceRevision: 2,
    candidateAcknowledgements: {
      [candidateKey]: {
        status: "acknowledged",
        candidateFingerprint: fingerprint,
        sourceRevision: 2,
        version: 3
      }
    }
  });
  assert.equal(stale[0].acknowledgement.status, "stale");

  const initial = decorateSidecarCandidateAcknowledgements({ candidates: [candidate] });
  assert.deepEqual(initial[0].acknowledgement, {
    status: "unacknowledged",
    version: 0,
    updatedAt: null
  });
});

test("included, blocked, missing-id, and duplicate candidates cannot be acknowledged", () => {
  const candidate = decisionCandidate();
  const decorated = decorateSidecarCandidateAcknowledgements({
    candidates: [
      { ...candidate, zone: "included" },
      { ...candidate, candidateId: "blocked", zone: "blocked" },
      { ...candidate, candidateId: null },
      candidate,
      { ...candidate }
    ]
  });
  assert.equal(decorated.every((item) => item.candidateKey === undefined), true);
  assert.deepEqual(sidecarAcknowledgementTargets(decorated), []);
});

function decisionCandidate() {
  return {
    candidateId: "management",
    sourceType: "proposal",
    zone: "review_required",
    billingEligibility: "review_required",
    code: "114000110",
    codeCandidates: [],
    name: "確認対象",
    display: { stem: "確認対象", qualifier: "" },
    points: 100,
    quantity: 1,
    estimatedTotalPoints: 100,
    candidateOnly: true,
    reason: "算定要件を確認してください。",
    selectionResolution: null,
    selectionNarrowing: null
  };
}
