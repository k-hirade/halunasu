import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const FAMILY_SAFE_ID_PATTERN = /^[a-z0-9_]+$/u;
const ARTIFACT_URL = new URL(
  "./fee-rule-data/document-billing-families-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const CANDIDATE_ACTION_STATUSES = new Set(ARTIFACT.candidateActionStatuses);
const DOCUMENT_CODES = new Set(
  asArray(ARTIFACT.families)
    .flatMap((family) => asArray(family.procedures))
    .map((procedure) => String(procedure.code || ""))
    .filter(Boolean)
);

export function documentBillingMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256
  };
}

export function isSupportedDocumentClinicalEvent(event = {}) {
  return Boolean(documentFamily(documentEvidenceText(event)));
}

export function buildDocumentBillingLane({
  clinicalEvents = [],
  structuredSourceFacts = null,
  serviceDate = "",
  ruleEffectiveDate = ""
} = {}) {
  const normalizedServiceDate = isIsoDate(serviceDate) ? serviceDate : null;
  const normalizedRuleEffectiveDate = isIsoDate(ruleEffectiveDate)
    ? ruleEffectiveDate
    : null;
  const clinicalObservations = asArray(clinicalEvents)
    .map((event, index) => clinicalDocumentObservation(event, index, normalizedServiceDate))
    .filter(Boolean);
  const surfaceObservations = asArray(structuredSourceFacts?.documents)
    .map((fact, index) => surfaceDocumentObservation(fact, index, normalizedServiceDate))
    .filter(Boolean);
  const observations = [...clinicalObservations, ...surfaceObservations];
  const deferredClinicalEventIds = (normalizedServiceDate ? clinicalObservations : [])
    .map((observation) => observation.clinicalEventId)
    .filter(Boolean);
  const eligible = observations.filter((observation) => observation.eligible);
  const groups = groupEligibleDocumentObservations(eligible);
  const candidateProposals = groups.flatMap((group) => (
    activeProcedures(
      group.family,
      normalizedRuleEffectiveDate || group.documentDate
    ).map((procedure) => (
      candidateProposalFromDocumentGroup(group, procedure)
    ))
  ));
  const reviewIssues = [
    ...surfaceDateReviewIssues(surfaceObservations),
    ...documentSurfaceMismatchIssues({
      clinicalObservations,
      surfaceObservations,
      sourceStatus: structuredSourceFacts?.sourceStatus?.documents
    })
  ];
  const reviewWarnings = reviewIssues.map((issue) => issue.messageForStaff);

  return {
    candidateProposals,
    reviewIssues,
    reviewWarnings,
    deferredClinicalEventIds,
    clinicalTrace: [{
      traceId: `trace_document_billing_${shortHash(JSON.stringify([
        normalizedServiceDate,
        normalizedRuleEffectiveDate,
        observations.map((observation) => observation.observationId)
      ]))}`,
      stage: "document_billing_lane",
      outcome: candidateProposals.length ? "candidate_proposed" : "no_candidate",
      selected: {
        artifactRevision: ARTIFACT.revision,
        clinicalObservationCount: clinicalObservations.length,
        surfaceObservationCount: surfaceObservations.length,
        eligibleObservationCount: eligible.length,
        candidateCount: candidateProposals.length,
        excludedStatusCounts: countBy(
          observations.filter((observation) => !observation.eligible),
          (observation) => observation.exclusionReason || "unknown"
        )
      },
      message: "document_billing_facts_evaluated"
    }]
  };
}

export function dedupeDocumentBillingCandidateProposals(
  proposals = [],
  { serviceDate = "" } = {}
) {
  const values = asArray(proposals).filter(Boolean);
  const laneFacts = values
    .filter((proposal) => proposal?.basis === "document_billing_lane")
    .map((proposal) => ({
      code: proposalCode(proposal),
      familyId: String(proposal?.knowledge?.documentFamilyId || ""),
      documentDate: String(proposal?.knowledge?.documentDate || ""),
      proposal
    }))
    .filter((item) => item.code && item.familyId);
  if (!laneFacts.length) {
    return values;
  }

  return values.filter((proposal) => {
    if (proposal?.basis === "document_billing_lane") {
      return true;
    }
    const code = proposalCode(proposal);
    if (!DOCUMENT_CODES.has(code)) {
      return true;
    }
    const family = documentFamily(documentProposalEvidenceText(proposal));
    if (!family) {
      return true;
    }
    const proposalDate = isIsoDate(proposal?.knowledge?.documentDate)
      ? proposal.knowledge.documentDate
      : isIsoDate(serviceDate) ? serviceDate : "";
    return !laneFacts.some((lane) => (
      lane.code === code
      && lane.familyId === family.familyId
      && lane.documentDate === proposalDate
    ));
  });
}

function clinicalDocumentObservation(event, index, serviceDate) {
  const extractionSource = String(
    event?.extractionSource
    || event?.extraction_source
    || event?.source
    || ""
  ).trim();
  if (extractionSource === "openai_auxiliary_recheck") {
    return null;
  }
  const evidence = documentEvidenceText(event);
  const family = documentFamily(evidence);
  if (!family) {
    return null;
  }
  const actionStatus = documentActionStatus(evidence);
  const temporalRelation = String(
    event?.temporal_relation
    || event?.temporalRelation
    || event?.date_relation
    || event?.dateRelation
    || ""
  ).trim();
  const providerOwnership = String(
    event?.provider_ownership
    || event?.providerOwnership
    || ""
  ).trim();
  const sourceOrigin = String(event?.source_origin || event?.sourceOrigin || "").trim();
  const eventActionStatus = String(
    event?.action_status
    || event?.actionStatus
    || event?.status
    || ""
  ).trim();
  const isCurrent = !["past", "future", "history"].includes(temporalRelation)
    && !["planned", "ordered", "considered", "not_performed", "negated"].includes(eventActionStatus);
  const isOwnProvider = ["own", "own_clinic"].includes(providerOwnership)
    || (
      !["other_provider", "same_institution_other_department", "other_department"].includes(providerOwnership)
      && sourceOrigin === "own_clinic_record"
    );
  const candidateAction = CANDIDATE_ACTION_STATUSES.has(actionStatus);
  const clinicalEventId = String(
    event?.clinicalEventId
    || event?.clinical_event_id
    || event?.eventId
    || event?.event_id
    || ""
  ).trim();
  let exclusionReason = null;
  if (!candidateAction) {
    exclusionReason = `document_action_${actionStatus || "unknown"}`;
  } else if (!serviceDate) {
    exclusionReason = "service_date_unknown";
  } else if (!isCurrent) {
    exclusionReason = "document_not_current";
  } else if (!isOwnProvider) {
    exclusionReason = "document_not_own_provider";
  }
  return {
    observationId: clinicalEventId || `clinical_document_${index + 1}`,
    clinicalEventId,
    source: "clinical_text",
    family,
    actionStatus,
    documentDate: serviceDate,
    evidence: evidence.slice(0, 240),
    eligible: exclusionReason === null,
    exclusionReason
  };
}

function surfaceDocumentObservation(fact, index, serviceDate) {
  const evidence = [
    fact?.kind,
    fact?.statusText,
    fact?.writtenDateText,
    fact?.periodText
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" / ");
  const family = documentFamily(evidence);
  if (!family) {
    return null;
  }
  const actionStatus = String(fact?.actionStatus || "").trim()
    || documentActionStatus(String(fact?.statusText || ""));
  const documentDate = isIsoDate(fact?.documentDate)
    ? fact.documentDate
    : parseDocumentDate(fact?.writtenDateText, serviceDate);
  const sameClaimMonth = Boolean(
    serviceDate
    && documentDate
    && serviceDate.slice(0, 7) === documentDate.slice(0, 7)
  );
  let exclusionReason = null;
  if (!CANDIDATE_ACTION_STATUSES.has(actionStatus)) {
    exclusionReason = `document_action_${actionStatus || "unknown"}`;
  } else if (!documentDate) {
    exclusionReason = "document_date_unknown";
  } else if (!sameClaimMonth) {
    exclusionReason = "document_outside_claim_month";
  }
  return {
    observationId: `surface_document_${Number(fact?.sourceIndex ?? index) + 1}`,
    clinicalEventId: "",
    source: "documents_surface",
    family,
    actionStatus,
    documentDate,
    evidence: evidence.slice(0, 240),
    eligible: exclusionReason === null,
    exclusionReason
  };
}

function groupEligibleDocumentObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const evidenceFingerprint = normalizedDocumentEvidenceFingerprint(observation);
    const key = [
      observation.family.familyId,
      observation.documentDate,
      evidenceFingerprint
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        family: observation.family,
        documentDate: observation.documentDate,
        evidenceFingerprint,
        observations: []
      });
    }
    groups.get(key).observations.push(observation);
  }
  return [...groups.values()];
}

function candidateProposalFromDocumentGroup(group, procedure) {
  const sourceReferences = group.observations.map((observation) => ({
    observationId: observation.observationId,
    source: observation.source,
    actionStatus: observation.actionStatus,
    evidence: observation.evidence
  }));
  const evidence = uniqueStrings(sourceReferences.map((reference) => reference.evidence))
    .join(" / ")
    .slice(0, 320);
  const factKey = shortHash([
    procedure.code,
    group.documentDate,
    group.evidenceFingerprint
  ].join("|"));
  const proposalId = `document_${factKey}`;
  const points = Number(procedure.points || 0);
  const deduplication = sourceReferences.length >= 2
    ? {
      reason: "document_code_date_evidence",
      proposalIds: sourceReferences.map((reference) => reference.observationId),
      sources: uniqueStrings(sourceReferences.map((reference) => reference.source))
    }
    : undefined;
  const reason = `${group.documentDate}に自院で${group.family.displayName}を作成・交付した記録があります。`;
  return {
    proposalId,
    title: `${procedure.name}の算定確認`,
    reason,
    conditionText: "交付相手、様式、対象月の算定回数、通知上の要件を確認してから採用してください。",
    basis: "document_billing_lane",
    evidence,
    actionType: points > 0 ? "adoptable" : "confirm_required",
    potentialPoints: points,
    code: String(procedure.code || ""),
    orderType: "procedure",
    source: "document_billing_lane",
    sortOrder: 42,
    candidateOnly: true,
    reviewRequired: true,
    ...(deduplication ? { deduplication } : {}),
    knowledge: {
      documentFamilyId: group.family.familyId,
      documentDate: group.documentDate,
      evidenceFingerprint: group.evidenceFingerprint,
      documentFactKey: factKey,
      artifactRevision: ARTIFACT.revision,
      sourceReferences
    },
    candidateLine: {
      lineId: `proposal_line_${proposalId}`,
      code: String(procedure.code || ""),
      name: String(procedure.name || group.family.displayName),
      orderType: "procedure",
      points,
      quantity: 1,
      totalPoints: points,
      status: "candidate",
      reason,
      source: "document_billing_lane",
      extractionSource: "document_billing_lane",
      supportLevel: "review_required",
      reviewRequired: true,
      coverage: {
        scope: "document_code_date_evidence",
        chapter: "document_billing",
        supportLevel: "review_required",
        reviewRequired: true
      }
    }
  };
}

function surfaceDateReviewIssues(observations) {
  return observations
    .filter((observation) => observation.exclusionReason === "document_date_unknown")
    .map((observation) => documentReviewIssue({
      issueCode: "document_date_unknown",
      family: observation.family,
      evidence: observation.evidence,
      message: `${observation.family.displayName}の作成日は書類画面から確定できませんでした。対象月と作成・交付日を確認してください。`
    }));
}

function documentSurfaceMismatchIssues({
  clinicalObservations,
  surfaceObservations,
  sourceStatus
}) {
  if (sourceStatus?.status !== "known") {
    return [];
  }
  const result = [];
  for (const clinical of clinicalObservations.filter((observation) => observation.eligible)) {
    const sameFamily = surfaceObservations.filter((surface) => (
      surface.family.familyId === clinical.family.familyId
    ));
    const matching = sameFamily.some((surface) => (
      surface.eligible
      && surface.documentDate === clinical.documentDate
    ));
    if (matching) {
      continue;
    }
    result.push(documentReviewIssue({
      issueCode: "document_surface_mismatch",
      family: clinical.family,
      evidence: uniqueStrings([
        clinical.evidence,
        ...sameFamily.map((surface) => surface.evidence)
      ]).join(" / ").slice(0, 240),
      message: `${clinical.family.displayName}の本文記載と書類画面の作成日・状態が一致しません。二重計上せず、実際の作成・交付日を確認してください。`
    }));
  }
  return dedupeBy(result, (issue) => issue.reviewIssueId);
}

function documentReviewIssue({ issueCode, family, evidence, message }) {
  return {
    reviewIssueId: `issue_document_${shortHash([issueCode, family.familyId, evidence].join("|"))}`,
    issueCode,
    severity: "warning",
    title: "文書算定の確認",
    messageForStaff: message,
    evidence: String(evidence || "").slice(0, 240),
    requiredInput: "文書種別、作成・交付日、交付相手、様式",
    source: "document_billing_lane",
    topicCode: "document_billing_check"
  };
}

function documentFamily(value) {
  const normalized = normalizeDocumentText(value);
  if (!normalized) {
    return null;
  }
  const matches = asArray(ARTIFACT.families).filter((family) => (
    asArray(family.inputPatterns).some((pattern) => (
      normalized.includes(normalizeDocumentText(pattern))
    ))
    && !asArray(family.excludePatterns).some((pattern) => (
      normalized.includes(normalizeDocumentText(pattern))
    ))
  ));
  if (!matches.length) {
    return null;
  }
  return [...matches].sort((left, right) => (
    longestPatternLength(right) - longestPatternLength(left)
  ))[0];
}

function longestPatternLength(family) {
  return Math.max(0, ...asArray(family.inputPatterns).map((pattern) => (
    normalizeDocumentText(pattern).length
  )));
}

function documentActionStatus(value) {
  const text = normalizeDocumentText(value);
  if (!text) return "unknown";
  const created = /(?:作成(?:済|した|し|を)?|記入(?:済|した|し|を)?)/u.test(text);
  const issued = /(?:交付(?:済|した|し|を)?|発行(?:済|した|し|を)?)/u.test(text);
  const received = /(?:受領(?:済|した|し|を)?|持参(?:された|した|あり|有)?|受け取(?:った|り|る)?)/u.test(text);
  const sent = /(?:送付(?:済|した|し|を)?|発送(?:済|した|し|を)?)/u.test(text);
  if (received && /(?:他院|前医|外部|患者|家族).{0,20}(?:発行|交付|作成)|(?:発行|交付|作成).{0,20}(?:他院|前医|外部|持参)/u.test(text)) {
    return "received";
  }
  if (issued) return "issued";
  if (created) return "created";
  if (received) return "received";
  if (sent) return "sent";
  return "unknown";
}

function normalizedDocumentEvidenceFingerprint(observation) {
  return [
    observation.family.familyId,
    CANDIDATE_ACTION_STATUSES.has(observation.actionStatus) ? "created_or_issued" : observation.actionStatus
  ].join(":");
}

function activeProcedures(family, ruleEffectiveDate) {
  if (!isIsoDate(ruleEffectiveDate)) {
    return [];
  }
  return asArray(family.procedures).filter((procedure) => (
    (!procedure.effectiveFrom || procedure.effectiveFrom <= ruleEffectiveDate)
    && (!procedure.effectiveTo || procedure.effectiveTo >= ruleEffectiveDate)
  ));
}

function parseDocumentDate(value, serviceDate) {
  const text = String(value || "").normalize("NFKC").trim();
  if (isIsoDate(text)) {
    return validDateOnly(text) ? text : null;
  }
  if (!isIsoDate(serviceDate)) {
    return null;
  }
  const match = text.match(/(?:令和\s*(\d+)\s*年\s*)?(\d{1,2})\s*月?\s*[\/月]\s*(\d{1,2})\s*日?/u)
    || text.match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/u);
  if (!match) {
    return null;
  }
  let year = Number(serviceDate.slice(0, 4));
  let month;
  let day;
  if (match.length === 4) {
    if (match[1]) {
      year = 2018 + Number(match[1]);
    }
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    month = Number(match[1]);
    day = Number(match[2]);
  }
  const result = [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
  return validDateOnly(result) ? result : null;
}

function validDateOnly(value) {
  if (!isIsoDate(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function documentEvidenceText(event) {
  return [
    event?.name,
    event?.event_name,
    event?.eventName,
    event?.evidence,
    event?.evidence_text,
    event?.evidenceText,
    event?.review_reason,
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
}

function documentProposalEvidenceText(proposal) {
  return [
    proposal?.title,
    proposal?.reason,
    proposal?.evidence,
    proposal?.candidateLine?.name
  ].map((value) => String(value || "")).filter(Boolean).join("\n");
}

function proposalCode(proposal) {
  return String(proposal?.code || proposal?.candidateLine?.code || "").trim();
}

function normalizeDocumentText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/[()]/gu, (character) => character === "(" ? "（" : "）")
    .toLowerCase();
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = String(keyFn(value) || "unknown");
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(String).map((value) => value.trim()).filter(Boolean))];
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertArtifactIntegrity(artifact) {
  if (artifact?.schemaVersion !== "fee-document-billing-artifact-v1") {
    throw new Error("Unsupported fee document billing artifact schema");
  }
  const payload = { ...artifact };
  delete payload.artifactPayloadSha256;
  const calculated = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (calculated !== artifact.artifactPayloadSha256) {
    throw new Error("Fee document billing artifact checksum mismatch");
  }
  for (const family of asArray(artifact.families)) {
    if (!FAMILY_SAFE_ID_PATTERN.test(String(family.familyId || ""))) {
      throw new Error(`Invalid document family id: ${family.familyId}`);
    }
    if (!asArray(family.procedures).length) {
      throw new Error(`Document family has no procedures: ${family.familyId}`);
    }
  }
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
