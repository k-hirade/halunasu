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
    sourceRevision: 1,
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
      receptionTime: input.receptionTime,
      clinicalText: input.clinicalText,
      orders: input.orders,
      diagnoses: input.diagnoses,
      diagnosesSource: input.diagnoses?.length ? "manual" : null,
      status: "ready"
    }, { now })
    : current;
  return {
    ...patched,
    sourceRecordDisplayId: input.sourceRecordDisplayId || current.sourceRecordDisplayId || null,
    contractVersion: input.contractVersion || current.contractVersion || "v1",
    sourceRevisionHash: input.sourceRevisionHash,
    sourceRevision: Number(current.sourceRevision || 1) + (changed ? 1 : 0),
    encounterTypeSource: input.encounterTypeSource,
    extractionProof: input.extractionProof || null,
    lastCalculatedByMemberId: input.lastCalculatedByMemberId || current.lastCalculatedByMemberId,
    expiresAt: input.expiresAt || current.expiresAt || null,
    updatedAt: now
  };
}

export function applySidecarCalculationResult(current = {}, calculationResult = {}, options = {}) {
  if (current.lifecycleStatus !== "draft") {
    throw conflictError("adopted sidecar draft cannot be recalculated");
  }
  const updated = applyCalculationResult(current, candidateOnlyCalculationResult(calculationResult), options);
  return {
    ...updated,
    lifecycleStatus: "draft",
    candidateOnly: true,
    reviewDecisions: {}
  };
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
    adoptedFeeSessionId: requiredString(feeSessionId, "feeSessionId"),
    adoptedAt: now,
    updatedAt: now
  };
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

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString();
}

function conflictError(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}
