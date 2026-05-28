export const chartingEncounterStatuses = Object.freeze([
  "ready",
  "recording",
  "stopped",
  "finalizing",
  "soap_ready",
  "approved",
  "failed"
]);

export const soapDraftStatuses = Object.freeze(["ready", "approved", "failed"]);

export function validateCreateChartingPatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName, "displayName"),
    displayNameKana: optionalString(input.displayNameKana),
    birthDate: optionalBirthDate(input.birthDate),
    sex: optionalEnum(input.sex, ["male", "female", "other", "unknown"], "sex") || "unknown",
    externalPatientIds: normalizeStringArray(input.externalPatientIds),
    notes: optionalString(input.notes)
  };
}

export function validateCreateChartingEncounterInput(input = {}) {
  const patient = isPlainObject(input.patient)
    ? validateCreateChartingPatientInput(input.patient)
    : undefined;
  const patientId = optionalString(input.patientId);

  if (!patientId && !patient) {
    throw validationError("patientId or patient is required", "patientId");
  }

  return compactObject({
    patientId,
    patient,
    facilityId: optionalString(input.facilityId),
    departmentId: optionalString(input.departmentId),
    doctorMemberId: optionalString(input.doctorMemberId),
    title: optionalString(input.title),
    visitReason: optionalString(input.visitReason),
    transcript: optionalMultilineString(input.transcript, 20000),
    notes: optionalMultilineString(input.notes, 5000)
  });
}

export function validatePatchChartingEncounterInput(input = {}) {
  return compactObject({
    facilityId: hasOwn(input, "facilityId") ? optionalString(input.facilityId) : undefined,
    departmentId: hasOwn(input, "departmentId") ? optionalString(input.departmentId) : undefined,
    title: hasOwn(input, "title") ? optionalString(input.title) : undefined,
    visitReason: hasOwn(input, "visitReason") ? optionalString(input.visitReason) : undefined,
    transcript: hasOwn(input, "transcript") ? optionalMultilineString(input.transcript, 20000) : undefined,
    notes: hasOwn(input, "notes") ? optionalMultilineString(input.notes, 5000) : undefined,
    status: hasOwn(input, "status")
      ? optionalEnum(input.status, chartingEncounterStatuses, "status")
      : undefined
  });
}

export function validateCreateSoapDraftInput(input = {}) {
  return {
    transcript: optionalMultilineString(input.transcript, 20000),
    notes: optionalMultilineString(input.notes, 5000)
  };
}

export function validatePatchSoapDraftInput(input = {}) {
  return compactObject({
    subjective: hasOwn(input, "subjective") ? optionalMultilineString(input.subjective, 10000) : undefined,
    objective: hasOwn(input, "objective") ? optionalMultilineString(input.objective, 10000) : undefined,
    assessment: hasOwn(input, "assessment") ? optionalMultilineString(input.assessment, 10000) : undefined,
    plan: hasOwn(input, "plan") ? optionalMultilineString(input.plan, 10000) : undefined,
    outputText: hasOwn(input, "outputText") ? optionalMultilineString(input.outputText, 40000) : undefined,
    status: hasOwn(input, "status")
      ? optionalEnum(input.status, soapDraftStatuses, "status")
      : undefined
  });
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function requiredString(value, field) {
  if (typeof value !== "string") {
    throw validationError(`${field} is required`, field);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw validationError(`${field} is required`, field);
  }

  return trimmed;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalMultilineString(value, maxLength) {
  const normalized = optionalString(value);
  if (!normalized) {
    return undefined;
  }

  const text = normalized
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (text.length > maxLength) {
    throw validationError(`text must be ${maxLength} characters or less`, "text");
  }

  return text;
}

function optionalBirthDate(value) {
  const normalized = optionalString(value);
  if (!normalized) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw validationError("birthDate must use YYYY-MM-DD", "birthDate");
  }

  return normalized;
}

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !allowed.includes(value)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  }

  return value;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(optionalString).filter(Boolean))];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}
