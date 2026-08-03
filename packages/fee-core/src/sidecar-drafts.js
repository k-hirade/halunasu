import { createHash } from "node:crypto";
import {
  applyCalculationResult,
  applyFeeSessionPatch,
  buildFeeSession
} from "./index.js";

export function buildSidecarCalculationDraft(input = {}, options = {}) {
  const now = timestamp(options.now);
  const sidecarDraftId = requiredString(input.sidecarDraftId, "sidecarDraftId");
  const session = buildFeeSession({
    ...input,
    patientId: requiredString(input.sidecarPatientKey, "sidecarPatientKey"),
    patientRef: requiredString(input.sidecarPatientKey, "sidecarPatientKey"),
    sourceSystem: "homis_sidecar",
    status: "ready",
    monthlyClaimWork: null
  }, {
    feeSessionId: sidecarDraftId,
    now
  });
  return {
    ...session,
    sidecarDraftId,
    recordType: "sidecar_calculation_draft",
    contractVersion: requiredString(input.contractVersion || "v1", "contractVersion"),
    lifecycleStatus: "draft",
    externalSourceSystem: requiredString(input.externalSourceSystem, "externalSourceSystem"),
    externalPatientId: requiredString(input.externalPatientId, "externalPatientId"),
    sourceRecordId: requiredString(input.sourceRecordId, "sourceRecordId"),
    sourceRecordDisplayId: input.sourceRecordDisplayId || null,
    idempotencyKeyHash: requiredString(input.idempotencyKeyHash, "idempotencyKeyHash"),
    sourceRevisionHash: requiredString(input.sourceRevisionHash, "sourceRevisionHash"),
    canonicalPatientId: input.canonicalPatientId || session.canonicalPatientId,
    canonicalPatientIdSource: input.canonicalPatientIdSource || session.canonicalPatientIdSource,
    patientIdentityAliases: Array.isArray(input.patientIdentityAliases)
      ? input.patientIdentityAliases
      : session.patientIdentityAliases,
    canonicalPatientResolutionStatus: input.canonicalPatientResolutionStatus || "not_linked",
    canonicalPatientLookupCompleteness: input.canonicalPatientLookupCompleteness || "complete",
    sourceRevision: 1,
    calculationRevision: 0,
    calculationSnapshot: null,
    calculationDiff: null,
    candidateAcknowledgements: {},
    candidateAcknowledgementAuditOutbox: {},
    candidateAcknowledgementAuditPending: false,
    encounterTypeSource: requiredString(input.encounterTypeSource, "encounterTypeSource"),
    extractionProof: input.extractionProof || null,
    lastCalculatedByMemberId: input.createdByMemberId,
    adoptedFeeSessionId: null,
    adoptedAt: null,
    expiresAt: input.expiresAt || null,
    createdAt: now,
    updatedAt: now
  };
}

export function applySidecarDraftInput(current = {}, input = {}, options = {}) {
  assertSameSourceRecord(current, input);
  const now = timestamp(options.now);
  const changed = current.sourceRevisionHash !== input.sourceRevisionHash;
  const patched = changed
    ? applyFeeSessionPatch(current, {
      facilityId: input.facilityId,
      facilitySnapshot: input.facilitySnapshot,
      departmentId: input.departmentId,
      departmentSnapshot: input.departmentSnapshot,
      serviceDate: input.serviceDate,
      claimMonth: String(input.serviceDate || "").slice(0, 7),
      setting: input.setting,
      encounterDetails: input.encounterDetails,
      receptionTime: input.receptionTime,
      clinicalText: input.clinicalText,
      sourceSurfaces: input.sourceSurfaces,
      structuredSourceFacts: input.structuredSourceFacts,
      sameHouseholdVisitContext: input.sameHouseholdVisitContext,
      orders: input.orders,
      diagnoses: input.diagnoses,
      diagnosesSource: input.diagnoses?.length ? "manual" : null,
      status: "ready"
    }, { now })
    : current;
  const auditOutbox = acknowledgementAuditOutbox(current.candidateAcknowledgementAuditOutbox);
  return {
    ...patched,
    sourceRecordDisplayId: input.sourceRecordDisplayId || current.sourceRecordDisplayId || null,
    contractVersion: input.contractVersion || current.contractVersion || "v1",
    sourceRevisionHash: input.sourceRevisionHash,
    canonicalPatientId: input.canonicalPatientId || current.canonicalPatientId || current.patientId,
    canonicalPatientIdSource: input.canonicalPatientIdSource || current.canonicalPatientIdSource || "sidecar_patient_key",
    patientIdentityAliases: Array.isArray(input.patientIdentityAliases)
      ? input.patientIdentityAliases
      : current.patientIdentityAliases || [],
    canonicalPatientResolutionStatus: input.canonicalPatientResolutionStatus
      || current.canonicalPatientResolutionStatus
      || "not_linked",
    canonicalPatientLookupCompleteness: input.canonicalPatientLookupCompleteness
      || current.canonicalPatientLookupCompleteness
      || "complete",
    sourceRevision: Number(current.sourceRevision || 1) + (changed ? 1 : 0),
    encounterTypeSource: input.encounterTypeSource,
    sourceSurfaces: input.sourceSurfaces || current.sourceSurfaces || null,
    structuredSourceFacts: input.structuredSourceFacts || current.structuredSourceFacts || null,
    sameHouseholdVisitContext: input.sameHouseholdVisitContext
      || current.sameHouseholdVisitContext
      || null,
    extractionProof: input.extractionProof || null,
    lastCalculatedByMemberId: input.lastCalculatedByMemberId || current.lastCalculatedByMemberId,
    candidateAcknowledgementAuditPending: hasAcknowledgementAuditEntries(auditOutbox),
    expiresAt: input.expiresAt || current.expiresAt || null,
    updatedAt: now
  };
}

export function applySidecarCalculationResult(current = {}, calculationResult = {}, options = {}) {
  if (current.lifecycleStatus !== "draft") {
    throw conflictError("adopted sidecar draft cannot be recalculated");
  }
  const updated = applyCalculationResult(current, candidateOnlyCalculationResult(calculationResult), options);
  const calculationSnapshot = buildSidecarCalculationSnapshot(updated.calculationResult);
  const calculationRevision = Number(current.calculationRevision || 0) + 1;
  return {
    ...updated,
    lifecycleStatus: "draft",
    candidateOnly: true,
    calculationRevision,
    calculationSnapshot,
    calculationDiff: calculationRevision > 1
      ? diffSidecarCalculationSnapshots(current.calculationSnapshot, calculationSnapshot)
      : null,
    reviewDecisions: {}
  };
}

export function applySidecarCandidateAcknowledgement(current = {}, input = {}, options = {}) {
  assertSidecarAcknowledgementDraft(current);
  const candidateKey = requiredString(input.candidateKey, "candidateKey");
  const candidateFingerprint = requiredSha256Hex(
    input.candidateFingerprint,
    "candidateFingerprint"
  );
  const expectedSourceRevision = requiredPositiveInteger(
    input.expectedSourceRevision,
    "expectedSourceRevision"
  );
  const expectedCalculationRevision = requiredPositiveInteger(
    input.expectedCalculationRevision,
    "expectedCalculationRevision"
  );
  const expectedVersion = requiredNonNegativeInteger(
    input.expectedAcknowledgementVersion,
    "expectedAcknowledgementVersion"
  );
  if (typeof input.acknowledged !== "boolean") {
    throw new TypeError("acknowledged must be a boolean");
  }
  const desiredStatus = input.acknowledged ? "acknowledged" : "unacknowledged";
  const updatedByMemberId = requiredString(input.updatedByMemberId, "updatedByMemberId");
  const updatedByLoginId = requiredString(input.updatedByLoginId, "updatedByLoginId");
  const updatedFromDeviceId = requiredString(input.updatedFromDeviceId, "updatedFromDeviceId");
  const acknowledgements = acknowledgementMap(current.candidateAcknowledgements);
  const previousAcknowledgement = acknowledgements[candidateKey] || null;
  const desiredAlreadyPersisted = previousAcknowledgement
    && previousAcknowledgement.status === desiredStatus
    && previousAcknowledgement.candidateFingerprint === candidateFingerprint
    && Number(previousAcknowledgement.sourceRevision) === Number(current.sourceRevision);
  if (desiredAlreadyPersisted) {
    return {
      sidecarDraft: current,
      acknowledgement: previousAcknowledgement,
      previousAcknowledgement,
      changed: false
    };
  }

  assertSidecarAcknowledgementRevisionValues(current, {
    expectedSourceRevision,
    expectedCalculationRevision
  });
  const currentVersion = Number(previousAcknowledgement?.version || 0);
  if (expectedVersion !== currentVersion) {
    throw conflictError(
      "sidecar candidate acknowledgement version mismatch",
      "SIDECAR_CANDIDATE_ACKNOWLEDGEMENT_CONFLICT"
    );
  }
  const now = timestamp(options.now);
  const acknowledgement = {
    candidateKey,
    candidateFingerprint,
    status: desiredStatus,
    sourceRevision: Number(current.sourceRevision),
    calculationRevision: Number(current.calculationRevision),
    version: currentVersion + 1,
    updatedByMemberId,
    updatedByLoginId,
    updatedFromDeviceId,
    updatedAt: now
  };
  const auditEntry = sidecarAcknowledgementAuditEntry(current, acknowledgement, now);
  const nextAuditOutbox = {
    ...acknowledgementAuditOutbox(current.candidateAcknowledgementAuditOutbox),
    [auditEntry.eventId]: auditEntry
  };
  return {
    sidecarDraft: {
      ...current,
      candidateAcknowledgements: {
        ...acknowledgements,
        [candidateKey]: acknowledgement
      },
      candidateAcknowledgementAuditOutbox: nextAuditOutbox,
      candidateAcknowledgementAuditPending: true,
      updatedAt: now
    },
    acknowledgement,
    previousAcknowledgement,
    changed: true
  };
}

export function reconcileSidecarCandidateAcknowledgements(current = {}, input = {}, options = {}) {
  assertSidecarAcknowledgementDraft(current);
  assertSidecarAcknowledgementRevisions(current, input);
  if (!Array.isArray(input.activeCandidates)) {
    throw new TypeError("activeCandidates must be an array");
  }
  const activeCandidates = new Map(input.activeCandidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError(`activeCandidates[${index}] must be an object`);
    }
    return [
      requiredString(candidate.candidateKey, `activeCandidates[${index}].candidateKey`),
      requiredSha256Hex(
        candidate.candidateFingerprint,
        `activeCandidates[${index}].candidateFingerprint`
      )
    ];
  }));
  const acknowledgements = acknowledgementMap(current.candidateAcknowledgements);
  const nextAcknowledgements = { ...acknowledgements };
  const nextAuditOutbox = {
    ...acknowledgementAuditOutbox(current.candidateAcknowledgementAuditOutbox)
  };
  const invalidated = [];
  const now = timestamp(options.now);

  for (const [candidateKey, record] of Object.entries(acknowledgements)) {
    if (!record || record.status !== "acknowledged") {
      continue;
    }
    let staleReason = null;
    if (Number(record.sourceRevision) !== Number(current.sourceRevision)) {
      staleReason = "source_revision_changed";
    } else if (!activeCandidates.has(candidateKey)) {
      staleReason = "candidate_missing";
    } else if (activeCandidates.get(candidateKey) !== record.candidateFingerprint) {
      staleReason = "candidate_fingerprint_changed";
    }
    if (!staleReason) {
      continue;
    }
    const staleRecord = {
      ...record,
      status: "stale",
      version: Number(record.version || 0) + 1,
      updatedAt: now,
      staleReason,
      invalidationSourceRevision: Number(current.sourceRevision),
      invalidationCalculationRevision: Number(current.calculationRevision),
      invalidatedByMemberId: requiredString(
        input.invalidatedByMemberId,
        "invalidatedByMemberId"
      ),
      invalidatedByLoginId: requiredString(
        input.invalidatedByLoginId,
        "invalidatedByLoginId"
      ),
      invalidatedFromDeviceId: requiredString(
        input.invalidatedFromDeviceId,
        "invalidatedFromDeviceId"
      ),
      invalidatedAt: now
    };
    nextAcknowledgements[candidateKey] = staleRecord;
    const auditEntry = sidecarAcknowledgementAuditEntry(current, staleRecord, now);
    nextAuditOutbox[auditEntry.eventId] = auditEntry;
    invalidated.push(staleRecord);
  }

  if (!invalidated.length) {
    return { sidecarDraft: current, invalidated, changed: false };
  }
  return {
    sidecarDraft: {
      ...current,
      candidateAcknowledgements: nextAcknowledgements,
      candidateAcknowledgementAuditOutbox: nextAuditOutbox,
      candidateAcknowledgementAuditPending: true,
      updatedAt: now
    },
    invalidated,
    changed: true
  };
}

export function completeSidecarCandidateAcknowledgementAudit(current = {}, eventIdInput = "") {
  const eventId = requiredString(eventIdInput, "eventId");
  const outbox = acknowledgementAuditOutbox(current.candidateAcknowledgementAuditOutbox);
  if (!outbox[eventId]) {
    return { sidecarDraft: current, changed: false };
  }
  const nextOutbox = { ...outbox };
  delete nextOutbox[eventId];
  return {
    sidecarDraft: {
      ...current,
      candidateAcknowledgementAuditOutbox: nextOutbox,
      candidateAcknowledgementAuditPending: hasAcknowledgementAuditEntries(nextOutbox)
    },
    changed: true
  };
}

function sidecarAcknowledgementAuditEntry(current, record, occurredAt) {
  const invalidated = record.status === "stale";
  const eventType = invalidated
    ? "fee.sidecar_candidate_acknowledgement_invalidated"
    : "fee.sidecar_candidate_acknowledgement_changed";
  const eventId = sidecarAcknowledgementAuditEventId(
    invalidated ? "invalidated" : "changed",
    current.sidecarDraftId,
    record.candidateKey,
    record.version
  );
  return {
    eventId,
    eventType,
    candidateKey: record.candidateKey,
    candidateFingerprint: record.candidateFingerprint,
    sourceRevision: invalidated
      ? record.invalidationSourceRevision
      : record.sourceRevision,
    calculationRevision: invalidated
      ? record.invalidationCalculationRevision
      : record.calculationRevision,
    acknowledgementVersion: record.version,
    acknowledged: record.status === "acknowledged",
    actorMemberId: invalidated ? record.invalidatedByMemberId : record.updatedByMemberId,
    actorLoginId: invalidated ? record.invalidatedByLoginId : record.updatedByLoginId,
    deviceId: invalidated ? record.invalidatedFromDeviceId : record.updatedFromDeviceId,
    staleReason: invalidated ? record.staleReason : null,
    occurredAt
  };
}

function sidecarAcknowledgementAuditEventId(eventType, sidecarDraftId, candidateKey, version) {
  const fingerprint = createHash("sha256")
    .update([eventType, sidecarDraftId, candidateKey, Number(version || 0)].join("\u001f"))
    .digest("hex")
    .slice(0, 40);
  return `aud_sidecar_${fingerprint}`;
}

function buildSidecarCalculationSnapshot(calculation = {}) {
  const candidateKeys = [
    ...(Array.isArray(calculation.lineItems) ? calculation.lineItems : []).map((line) => stableDigest([
      "line",
      line?.lineId,
      line?.code,
      line?.name,
      line?.quantity
    ])),
    ...(Array.isArray(calculation.candidateProposals) ? calculation.candidateProposals : []).map((proposal) => stableDigest([
      "proposal",
      proposal?.proposalId || proposal?.candidateId,
      proposal?.code,
      ...(Array.isArray(proposal?.codeCandidates) ? [...proposal.codeCandidates].sort() : []),
      proposal?.name || proposal?.title
    ])),
    ...(Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : [])
      .filter((issue) => [
        "auxiliary_extraction_unresolved",
        "line_coverage_gap",
        "line_review_incomplete",
        "empty_clinical_extraction"
      ].includes(String(issue?.issueCode || "")))
      .map((issue) => stableDigest(["sensor", issue?.reviewIssueId, issue?.issueCode]))
  ].sort();
  const noticeKeys = [
    ...(Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : []).map((issue) => stableDigest([
      "issue",
      issue?.reviewIssueId,
      issue?.issueCode,
      issue?.topicCode,
      issue?.messageForStaff || issue?.message || issue?.title
    ])),
    ...(Array.isArray(calculation.warnings) ? calculation.warnings : []).map((warning) => stableDigest([
      "warning",
      typeof warning === "string" ? warning : warning?.messageForStaff || warning?.message || warning?.title
    ]))
  ].sort();
  return {
    candidateKeys: [...new Set(candidateKeys)],
    noticeKeys: [...new Set(noticeKeys)],
    totalPoints: Number(calculation.totalPoints || 0)
  };
}

function diffSidecarCalculationSnapshots(previous = null, current = null) {
  const previousSnapshot = previous && typeof previous === "object" ? previous : {};
  const currentSnapshot = current && typeof current === "object" ? current : {};
  const candidateDiff = diffStableKeySets(previousSnapshot.candidateKeys, currentSnapshot.candidateKeys);
  const noticeDiff = diffStableKeySets(previousSnapshot.noticeKeys, currentSnapshot.noticeKeys);
  return {
    candidates: candidateDiff,
    notices: noticeDiff,
    pointDelta: Number(currentSnapshot.totalPoints || 0) - Number(previousSnapshot.totalPoints || 0)
  };
}

function diffStableKeySets(previousValues = [], currentValues = []) {
  const previous = new Set(Array.isArray(previousValues) ? previousValues : []);
  const current = new Set(Array.isArray(currentValues) ? currentValues : []);
  return {
    addedCount: [...current].filter((value) => !previous.has(value)).length,
    removedCount: [...previous].filter((value) => !current.has(value)).length
  };
}

function stableDigest(parts = []) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "").normalize("NFKC").trim()).join("\u001f"))
    .digest("hex");
}

function candidateOnlyCalculationResult(calculationResult = {}) {
  return {
    ...calculationResult,
    candidateOnly: true,
    lineItems: (Array.isArray(calculationResult.lineItems) ? calculationResult.lineItems : []).map((line) => ({
      ...line,
      status: "candidate",
      candidateOnly: true,
      reviewRequired: true,
      coverage: {
        ...(line.coverage || {}),
        supportLevel: "candidate",
        reviewRequired: true
      }
    })),
    candidateProposals: (Array.isArray(calculationResult.candidateProposals)
      ? calculationResult.candidateProposals
      : []).map((proposal) => ({
      ...proposal,
      status: "needs_review",
      candidateOnly: true,
      reviewRequired: true
    }))
  };
}

export function markSidecarDraftAdopted(current = {}, feeSessionId, options = {}) {
  if (current.adoptedFeeSessionId) {
    return current;
  }
  const now = timestamp(options.now);
  return {
    ...current,
    lifecycleStatus: "adopted",
    canonicalPatientId: options.canonicalPatientId || current.canonicalPatientId || current.patientId,
    canonicalPatientIdSource: options.canonicalPatientIdSource || current.canonicalPatientIdSource || "patient_id",
    patientIdentityAliases: Array.isArray(options.patientIdentityAliases)
      ? options.patientIdentityAliases
      : current.patientIdentityAliases || [],
    canonicalPatientResolutionStatus: "resolved",
    canonicalPatientLookupCompleteness: "complete",
    adoptedFeeSessionId: requiredString(feeSessionId, "feeSessionId"),
    adoptedAt: now,
    updatedAt: now
  };
}

export function sidecarVisitAdoptionFingerprint(draft = {}, sessionInput = {}) {
  const parts = [
    sessionInput.facilityId || draft.facilityId,
    sessionInput.canonicalPatientId || sessionInput.patientId || draft.canonicalPatientId || draft.patientId,
    sessionInput.serviceDate || draft.serviceDate,
    draft.sourceRecordDisplayId,
    sessionInput.receptionTime || draft.receptionTime,
    sessionInput.setting || draft.setting
  ].map((value) => String(value || "").normalize("NFKC").trim());
  if (parts.some((value) => !value)) {
    throw conflictError(
      "この算定案は受診識別情報が不足しているため採用できません。新しい拡張機能でHOMIS画面を再読み取りし、算定案を再作成してください。",
      "SIDECAR_ADOPTION_VISIT_FINGERPRINT_INCOMPLETE"
    );
  }
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function assertSameSourceRecord(current, input) {
  const fields = [
    "sidecarDraftId",
    "contractVersion",
    "idempotencyKeyHash",
    "externalSourceSystem",
    "externalPatientId",
    "sourceRecordId"
  ];
  if (fields.some((field) => String(current[field] || "") !== String(input[field] || ""))) {
    throw conflictError("sidecar draft source identity mismatch");
  }
  if (current.lifecycleStatus !== "draft") {
    throw conflictError("adopted sidecar draft cannot be updated");
  }
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new TypeError(`${field} is required`);
  }
  return normalized;
}

function requiredSha256Hex(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a 64-character lowercase hexadecimal value`);
  }
  return value;
}

function requiredPositiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function requiredNonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function acknowledgementMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function acknowledgementAuditOutbox(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasAcknowledgementAuditEntries(value) {
  return Object.keys(acknowledgementAuditOutbox(value)).length > 0;
}

function assertSidecarAcknowledgementDraft(current) {
  if (current.lifecycleStatus !== "draft") {
    throw conflictError(
      "adopted sidecar draft candidate acknowledgement cannot be changed",
      "SIDECAR_CANDIDATE_ACKNOWLEDGEMENT_CONFLICT"
    );
  }
}

function assertSidecarAcknowledgementRevisions(current, input) {
  const expectedSourceRevision = requiredPositiveInteger(
    input.expectedSourceRevision,
    "expectedSourceRevision"
  );
  const expectedCalculationRevision = requiredPositiveInteger(
    input.expectedCalculationRevision,
    "expectedCalculationRevision"
  );
  assertSidecarAcknowledgementRevisionValues(current, {
    expectedSourceRevision,
    expectedCalculationRevision
  });
}

function assertSidecarAcknowledgementRevisionValues(current, expected) {
  if (
    expected.expectedSourceRevision !== Number(current.sourceRevision)
    || expected.expectedCalculationRevision !== Number(current.calculationRevision)
  ) {
    throw conflictError(
      "sidecar draft revision mismatch",
      "SIDECAR_CANDIDATE_ACKNOWLEDGEMENT_CONFLICT"
    );
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString();
}

function conflictError(message, code = null) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  if (code) {
    error.code = code;
  }
  return error;
}
