import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDocumentBillingLane,
  dedupeDocumentBillingCandidateProposals,
  documentBillingMetadata,
  isSupportedDocumentClinicalEvent
} from "../src/document-billing-lane.js";

function ownCurrentDocumentEvent({
  id,
  name,
  evidence
}) {
  return {
    clinicalEventId: id,
    type: "management",
    name,
    evidence,
    action_status: "performed",
    temporal_relation: "current_visit",
    provider_ownership: "own_clinic",
    source_origin: "own_clinic_record"
  };
}

test("document billing artifact is integrity checked and versioned", () => {
  const metadata = documentBillingMetadata();
  assert.equal(metadata.schemaVersion, "fee-document-billing-artifact-v1");
  assert.equal(metadata.revision, "2026-06-first-wave-v1");
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
});

test("1011-style visiting nursing documents are candidate-only and deduplicated across text and surface", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-06",
    clinicalEvents: [
      ownCurrentDocumentEvent({
        id: "visit_instruction",
        name: "訪問看護指示書の交付",
        evidence: "今月より訪問看護指示書を交付した。"
      }),
      ownCurrentDocumentEvent({
        id: "special_instruction",
        name: "特別訪問看護指示書の交付",
        evidence: "特別訪問看護指示書も併せて交付した。"
      })
    ],
    structuredSourceFacts: {
      sourceStatus: {
        documents: { status: "known", unavailableReason: null }
      },
      documents: [
        {
          sourceIndex: 0,
          kind: "訪看指示書",
          writtenDateText: "6/6",
          statusText: "作成済",
          actionStatus: "created",
          documentDate: "2026-06-06"
        },
        {
          sourceIndex: 1,
          kind: "特別訪看指示書",
          writtenDateText: "6/6",
          statusText: "作成済",
          actionStatus: "created",
          documentDate: "2026-06-06"
        }
      ]
    }
  });

  assert.deepEqual(result.candidateProposals.map((proposal) => proposal.code).sort(), [
    "114008010",
    "114008370"
  ]);
  assert.ok(result.candidateProposals.every((proposal) => proposal.candidateOnly));
  assert.ok(result.candidateProposals.every((proposal) => proposal.reviewRequired));
  assert.ok(result.candidateProposals.every((proposal) => (
    proposal.deduplication?.sources?.includes("clinical_text")
    && proposal.deduplication?.sources?.includes("documents_surface")
  )));
  assert.deepEqual(result.reviewIssues, []);
});

test("1012-style created and sent referral document becomes one review candidate", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-08",
    clinicalEvents: [ownCurrentDocumentEvent({
      id: "referral",
      name: "診療情報提供書",
      evidence: "循環器内科へ診療情報提供書を作成・送付した。"
    })]
  });

  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].code, "180016110");
  assert.equal(result.candidateProposals[0].potentialPoints, 250);
});

test("current-master repricing applies current document rules to an old visit without changing its evidence date", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2025-01-15",
    ruleEffectiveDate: "2026-06-15",
    clinicalEvents: [ownCurrentDocumentEvent({
      id: "historical_referral",
      name: "診療情報提供書",
      evidence: "循環器内科へ診療情報提供書を作成・送付した。"
    })]
  });

  assert.equal(result.candidateProposals.length, 1);
  assert.equal(result.candidateProposals[0].code, "180016110");
  assert.equal(result.candidateProposals[0].potentialPoints, 250);
});

test("1013-style opinion and consent documents resolve to separate official codes", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-13",
    clinicalEvents: [
      ownCurrentDocumentEvent({
        id: "allowance",
        name: "傷病手当金意見書",
        evidence: "休業に伴う傷病手当金意見書を作成・交付した。"
      }),
      ownCurrentDocumentEvent({
        id: "consent",
        name: "療養費同意書",
        evidence: "鍼灸マッサージ継続のため療養費同意書を交付した。"
      })
    ]
  });

  assert.deepEqual(result.candidateProposals.map((proposal) => proposal.code).sort(), [
    "113004310",
    "180000710"
  ]);
});

test("received, carried-in, past and planned documents are deferred but never proposed", () => {
  const carriedIn = ownCurrentDocumentEvent({
    id: "carried_in",
    name: "訪問看護指示書",
    evidence: "他院で発行された訪問看護指示書を患者が持参した。"
  });
  const past = {
    ...ownCurrentDocumentEvent({
      id: "past",
      name: "傷病手当金意見書",
      evidence: "前回、傷病手当金意見書を交付した。"
    }),
    temporal_relation: "past"
  };
  const planned = {
    ...ownCurrentDocumentEvent({
      id: "planned",
      name: "療養費同意書",
      evidence: "次回、療養費同意書を作成する予定。"
    }),
    action_status: "planned",
    temporal_relation: "future"
  };
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-13",
    clinicalEvents: [carriedIn, past, planned]
  });

  assert.equal(isSupportedDocumentClinicalEvent(carriedIn), true);
  assert.deepEqual(result.deferredClinicalEventIds.sort(), ["carried_in", "past", "planned"]);
  assert.deepEqual(result.candidateProposals, []);
});

test("known surface conflict emits a review issue instead of guessing a date", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-13",
    clinicalEvents: [ownCurrentDocumentEvent({
      id: "allowance",
      name: "傷病手当金意見書",
      evidence: "傷病手当金意見書を作成・交付した。"
    })],
    structuredSourceFacts: {
      sourceStatus: {
        documents: { status: "known", unavailableReason: null }
      },
      documents: [{
        sourceIndex: 0,
        kind: "傷病手当金意見書",
        writtenDateText: "6/12",
        statusText: "作成済",
        actionStatus: "created",
        documentDate: "2026-06-12"
      }]
    }
  });

  assert.ok(result.reviewIssues.some((issue) => (
    issue.issueCode === "document_surface_mismatch"
  )));
  assert.equal(result.candidateProposals.length, 2);
});

test("surface-only current-month document is proposed but a missing date stays review-only", () => {
  const result = buildDocumentBillingLane({
    serviceDate: "2026-06-27",
    structuredSourceFacts: {
      sourceStatus: {
        documents: { status: "known", unavailableReason: null }
      },
      documents: [
        {
          sourceIndex: 0,
          kind: "療養費同意書",
          writtenDateText: "6/27",
          statusText: "作成済"
        },
        {
          sourceIndex: 1,
          kind: "傷病手当金意見書",
          writtenDateText: "",
          statusText: "作成済"
        }
      ]
    }
  });

  assert.deepEqual(result.candidateProposals.map((proposal) => proposal.code), ["113004310"]);
  assert.ok(result.reviewIssues.some((issue) => issue.issueCode === "document_date_unknown"));
});

test("generic document proposal for the same code and visit is replaced by the deterministic lane", () => {
  const lane = buildDocumentBillingLane({
    serviceDate: "2026-06-13",
    clinicalEvents: [ownCurrentDocumentEvent({
      id: "allowance",
      name: "傷病手当金意見書",
      evidence: "傷病手当金意見書を作成・交付した。"
    })]
  }).candidateProposals[0];
  const generic = {
    proposalId: "generic",
    title: "傷病手当金意見書交付料の算定確認",
    evidence: "傷病手当金意見書を作成・交付した。",
    code: "180000710",
    candidateLine: { code: "180000710" }
  };

  const result = dedupeDocumentBillingCandidateProposals([generic, lane], {
    serviceDate: "2026-06-13"
  });
  assert.deepEqual(result.map((proposal) => proposal.proposalId), [lane.proposalId]);
});
