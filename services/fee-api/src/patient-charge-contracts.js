import crypto from "node:crypto";

export const HOME_MEDICAL_TRANSPORT_CHARGE_TYPE = "home_medical_transport";

export function patientChargeContractId({
  orgId,
  facilityId,
  canonicalPatientId,
  chargeType = HOME_MEDICAL_TRANSPORT_CHARGE_TYPE
} = {}) {
  const key = [orgId, facilityId, canonicalPatientId, chargeType]
    .map((value) => requiredString(value, "patient charge contract identity"))
    .join("\u001f");
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return `pcc_${digest.slice(0, 32)}`;
}

export function buildPatientChargeContract(input = {}, options = {}) {
  if (nonNegativeInteger(input.expectedRevision, "expectedRevision") !== 0) {
    throw patientChargeRevisionConflict();
  }
  const now = timestamp(options.now);
  const identity = contractIdentity(input);
  const revision = 1;
  const patientChargeContract = {
    patientChargeContractId: patientChargeContractId(identity),
    ...identity,
    revision,
    settingEvents: [settingEvent(input, { revision, now })],
    createdByMemberId: input.updatedByMemberId || null,
    createdAt: now,
    updatedByMemberId: input.updatedByMemberId || null,
    updatedAt: now,
    schemaVersion: 1
  };
  return withPatientChargeAuditEntry(patientChargeContract, input, null, now);
}

export function applyPatientChargeContractSetting(current = {}, input = {}, options = {}) {
  const identity = contractIdentity(input);
  assertSameIdentity(current, identity);
  const expectedRevision = nonNegativeInteger(input.expectedRevision, "expectedRevision");
  const currentRevision = nonNegativeInteger(current.revision || 0, "revision");
  if (expectedRevision !== currentRevision) {
    throw patientChargeRevisionConflict();
  }
  const now = timestamp(options.now);
  const revision = currentRevision + 1;
  const patientChargeContract = {
    ...current,
    ...identity,
    patientChargeContractId: current.patientChargeContractId || patientChargeContractId(identity),
    revision,
    settingEvents: [
      ...(Array.isArray(current.settingEvents) ? current.settingEvents : []),
      settingEvent(input, { revision, now })
    ],
    updatedByMemberId: input.updatedByMemberId || null,
    updatedAt: now,
    schemaVersion: 1
  };
  return withPatientChargeAuditEntry(
    patientChargeContract,
    input,
    resolvePatientChargeSetting(current, input.effectiveFrom),
    now
  );
}

export function assertPatientChargeDraftWriteScope(sidecarDraft = null, input = {}, options = {}) {
  if (!sidecarDraft) {
    const error = new Error("sidecar calculation draft not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const expiresAt = Date.parse(String(sidecarDraft.expiresAt || ""));
  const matchesIdentity = String(sidecarDraft.sidecarDraftId || "") === String(input.sidecarDraftId || "")
    && String(sidecarDraft.orgId || "") === String(input.orgId || "")
    && String(sidecarDraft.facilityId || "") === String(input.facilityId || "")
    && String(sidecarDraft.canonicalPatientId || "") === String(input.canonicalPatientId || "")
    && Number(sidecarDraft.sourceRevision || 0) === Number(input.expectedDraftSourceRevision || 0)
    && Number(sidecarDraft.calculationRevision || 0)
      === Number(input.expectedDraftCalculationRevision || 0)
    && String(sidecarDraft.serviceDate || "") === String(input.expectedDraftServiceDate || "");
  if (
    !matchesIdentity
    || sidecarDraft.canonicalPatientResolutionStatus !== "resolved"
    || sidecarDraft.lifecycleStatus !== "draft"
    || !["home_visit", "house_call"].includes(sidecarDraft.setting)
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(expiresAt)
    || expiresAt <= now.getTime()
  ) {
    throw patientChargeDraftConflict();
  }
  return sidecarDraft;
}

export function completePatientChargeContractAudit(current = {}, eventIdInput = "") {
  const eventId = requiredString(eventIdInput, "eventId");
  const outbox = auditOutbox(current.auditOutbox);
  if (!outbox[eventId]) {
    return { patientChargeContract: current, changed: false };
  }
  const nextOutbox = { ...outbox };
  delete nextOutbox[eventId];
  return {
    patientChargeContract: {
      ...current,
      auditOutbox: nextOutbox
    },
    changed: true
  };
}

export function resolvePatientChargeSetting(contract = null, serviceDate = "") {
  if (!contract) {
    return null;
  }
  const date = requiredDate(serviceDate, "serviceDate");
  const latestByEffectiveFrom = new Map();
  for (const event of Array.isArray(contract.settingEvents) ? contract.settingEvents : []) {
    if (!event || String(event.effectiveFrom || "") > date) {
      continue;
    }
    const key = String(event.effectiveFrom || "");
    const previous = latestByEffectiveFrom.get(key);
    if (!previous || Number(event.revision || 0) > Number(previous.revision || 0)) {
      latestByEffectiveFrom.set(key, event);
    }
  }
  const active = [...latestByEffectiveFrom.values()]
    .sort((left, right) => (
      String(right.effectiveFrom || "").localeCompare(String(left.effectiveFrom || ""))
      || Number(right.revision || 0) - Number(left.revision || 0)
    ))[0] || null;
  if (!active || (active.effectiveTo && date > active.effectiveTo)) {
    return null;
  }
  return { ...active };
}

export function isPatientChargeSettingRetry(contract = null, input = {}) {
  if (!contract || Number(input.expectedRevision) !== Number(contract.revision || 0) - 1) {
    return false;
  }
  const latest = (Array.isArray(contract.settingEvents) ? contract.settingEvents : [])
    .findLast((event) => Number(event?.revision || 0) === Number(contract.revision || 0));
  if (!latest) {
    return false;
  }
  return latest.handling === input.handling
    && (latest.amountMode || null) === (input.amountMode || null)
    && (latest.amountYen ?? null) === (input.amountYen ?? null)
    && latest.effectiveFrom === input.effectiveFrom
    && (latest.effectiveTo || null) === (input.effectiveTo || null)
    && (latest.source || "homis_sidecar") === (input.source || "homis_sidecar");
}

export function resolvePatientChargeSettingBeforeRevision(contract, serviceDate, revision) {
  if (!contract) {
    return null;
  }
  return resolvePatientChargeSetting({
    ...contract,
    settingEvents: (Array.isArray(contract.settingEvents) ? contract.settingEvents : [])
      .filter((event) => Number(event?.revision || 0) < Number(revision || 0))
  }, serviceDate);
}

function contractIdentity(input = {}) {
  return {
    orgId: requiredString(input.orgId, "orgId"),
    facilityId: requiredString(input.facilityId, "facilityId"),
    canonicalPatientId: requiredString(input.canonicalPatientId, "canonicalPatientId"),
    chargeType: requiredString(
      input.chargeType || HOME_MEDICAL_TRANSPORT_CHARGE_TYPE,
      "chargeType"
    )
  };
}

function settingEvent(input = {}, { revision, now }) {
  const effectiveFrom = requiredDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo
    ? requiredDate(input.effectiveTo, "effectiveTo")
    : null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw validationError("effectiveTo must not be before effectiveFrom");
  }
  return {
    revision,
    handling: requiredString(input.handling, "handling"),
    amountMode: input.amountMode || null,
    amountYen: Number.isInteger(input.amountYen) ? input.amountYen : null,
    effectiveFrom,
    effectiveTo,
    source: input.source || "homis_sidecar",
    updatedByMemberId: input.updatedByMemberId || null,
    updatedFromDeviceId: input.updatedFromDeviceId || null,
    updatedAt: now
  };
}

function withPatientChargeAuditEntry(contract, input, previousSetting, occurredAt) {
  if (!String(input.sidecarDraftId || "").trim()) {
    return contract;
  }
  const eventId = patientChargeAuditEventId(contract);
  const entry = {
    eventId,
    eventType: "fee.patient_charge_contract_updated",
    actorMemberId: requiredString(input.updatedByMemberId, "updatedByMemberId"),
    actorLoginId: requiredString(input.updatedByLoginId, "updatedByLoginId"),
    targetType: "fee_patient_charge_contract",
    targetId: contract.patientChargeContractId,
    safePayload: {
      patientChargeContractId: contract.patientChargeContractId,
      sidecarDraftId: requiredString(input.sidecarDraftId, "sidecarDraftId"),
      patientId: contract.canonicalPatientId,
      facilityId: contract.facilityId,
      chargeType: contract.chargeType,
      beforeHandling: previousSetting?.handling || null,
      afterHandling: requiredString(input.handling, "handling"),
      effectiveFrom: requiredDate(input.effectiveFrom, "effectiveFrom"),
      effectiveTo: input.effectiveTo || null,
      revision: contract.revision,
      amountMode: input.amountMode || null,
      amountYen: Number.isInteger(input.amountYen) ? input.amountYen : null,
      deviceId: input.updatedFromDeviceId || null
    },
    occurredAt
  };
  return {
    ...contract,
    auditOutbox: {
      ...auditOutbox(contract.auditOutbox),
      [eventId]: entry
    }
  };
}

function patientChargeAuditEventId(contract = {}) {
  const contractId = String(contract.patientChargeContractId || "").replace(/^pcc_/u, "");
  const revision = Number(contract.revision || 0);
  return `aud_pcc_${contractId.slice(0, 32)}_${revision}`;
}

function auditOutbox(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assertSameIdentity(current, expected) {
  for (const field of ["orgId", "facilityId", "canonicalPatientId", "chargeType"]) {
    if (String(current?.[field] || "") !== String(expected[field] || "")) {
      throw patientChargeRevisionConflict("patient charge contract identity mismatch");
    }
  }
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw validationError(`${field} is required`);
  }
  return normalized;
}

function requiredDate(value, field) {
  const normalized = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw validationError(`${field} must use YYYY-MM-DD`);
  }
  return normalized;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative integer`);
  }
  return value;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw validationError("invalid timestamp");
  }
  return date.toISOString();
}

function validationError(message) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  return error;
}

function patientChargeRevisionConflict(message = "patient charge contract revision mismatch") {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "PATIENT_CHARGE_CONTRACT_REVISION_CONFLICT";
  return error;
}

function patientChargeDraftConflict(
  message = "sidecar draft changed before patient charge setting was saved"
) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "SIDECAR_PATIENT_CHARGE_DRAFT_CONFLICT";
  return error;
}
