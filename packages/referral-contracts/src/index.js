export const referralStatuses = Object.freeze([
  "draft",
  "ready",
  "document_ready",
  "sent",
  "archived"
]);

export function validateCreateReferralPatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName ?? input.display_name, "displayName"),
    displayNameKana: optionalString(input.displayNameKana ?? input.display_name_kana),
    birthDate: optionalBirthDate(input.birthDate ?? input.birth_date),
    sex: optionalEnum(input.sex, ["male", "female", "other", "unknown"], "sex") || "unknown",
    externalPatientIds: normalizeStringArray(input.externalPatientIds ?? input.external_patient_ids),
    notes: optionalString(input.notes)
  };
}

export function validateCreateReferralDraftInput(input = {}) {
  return {
    patientId: requiredString(input.patientId ?? input.patient_id, "patientId"),
    facilityId: requiredString(input.facilityId ?? input.facility_id, "facilityId"),
    departmentId: requiredString(input.departmentId ?? input.department_id, "departmentId"),
    authorMemberId: optionalString(input.authorMemberId ?? input.author_member_id),
    recipientInstitution: validateRecipientInstitution(input.recipientInstitution ?? input.recipient_institution ?? {}),
    recipientDoctor: validateRecipientDoctor(input.recipientDoctor ?? input.recipient_doctor ?? {}),
    title: optionalString(input.title) || "診療情報提供書",
    purpose: requiredMultilineString(input.purpose, "purpose", 2000),
    clinicalSummary: requiredMultilineString(input.clinicalSummary ?? input.clinical_summary, "clinicalSummary", 20000),
    diagnoses: normalizeTextLines(input.diagnoses, 50, "diagnoses"),
    medications: normalizeTextLines(input.medications, 100, "medications"),
    allergies: normalizeTextLines(input.allergies, 50, "allergies"),
    requestedAction: optionalMultilineString(input.requestedAction ?? input.requested_action, 5000),
    notes: optionalMultilineString(input.notes, 5000)
  };
}

export function validatePatchReferralDraftInput(input = {}) {
  return compactObject({
    facilityId: hasOwn(input, "facilityId") || hasOwn(input, "facility_id")
      ? optionalString(input.facilityId ?? input.facility_id)
      : undefined,
    departmentId: hasOwn(input, "departmentId") || hasOwn(input, "department_id")
      ? optionalString(input.departmentId ?? input.department_id)
      : undefined,
    authorMemberId: hasOwn(input, "authorMemberId") || hasOwn(input, "author_member_id")
      ? optionalString(input.authorMemberId ?? input.author_member_id)
      : undefined,
    recipientInstitution: hasOwn(input, "recipientInstitution") || hasOwn(input, "recipient_institution")
      ? validateRecipientInstitution(input.recipientInstitution ?? input.recipient_institution ?? {})
      : undefined,
    recipientDoctor: hasOwn(input, "recipientDoctor") || hasOwn(input, "recipient_doctor")
      ? validateRecipientDoctor(input.recipientDoctor ?? input.recipient_doctor ?? {})
      : undefined,
    title: hasOwn(input, "title") ? optionalString(input.title) : undefined,
    purpose: hasOwn(input, "purpose") ? optionalMultilineString(input.purpose, 2000) : undefined,
    clinicalSummary: hasOwn(input, "clinicalSummary") || hasOwn(input, "clinical_summary")
      ? optionalMultilineString(input.clinicalSummary ?? input.clinical_summary, 20000)
      : undefined,
    diagnoses: hasOwn(input, "diagnoses") ? normalizeTextLines(input.diagnoses, 50, "diagnoses") : undefined,
    medications: hasOwn(input, "medications") ? normalizeTextLines(input.medications, 100, "medications") : undefined,
    allergies: hasOwn(input, "allergies") ? normalizeTextLines(input.allergies, 50, "allergies") : undefined,
    requestedAction: hasOwn(input, "requestedAction") || hasOwn(input, "requested_action")
      ? optionalMultilineString(input.requestedAction ?? input.requested_action, 5000)
      : undefined,
    notes: hasOwn(input, "notes") ? optionalMultilineString(input.notes, 5000) : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, referralStatuses, "status") : undefined
  });
}

export function validateRenderReferralDocumentInput(input = {}) {
  return compactObject({
    fileName: optionalString(input.fileName ?? input.file_name),
    requestedAt: optionalDateTime(input.requestedAt ?? input.requested_at, "requestedAt")
  });
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function validateRecipientInstitution(input) {
  if (!isPlainObject(input)) {
    throw validationError("recipientInstitution must be an object", "recipientInstitution");
  }

  return compactObject({
    displayName: requiredString(input.displayName ?? input.display_name, "recipientInstitution.displayName"),
    departmentName: optionalString(input.departmentName ?? input.department_name),
    medicalInstitutionCode: optionalString(input.medicalInstitutionCode ?? input.medical_institution_code),
    postalCode: optionalString(input.postalCode ?? input.postal_code),
    address: optionalString(input.address),
    phone: optionalString(input.phone),
    fax: optionalString(input.fax)
  });
}

function validateRecipientDoctor(input) {
  if (!isPlainObject(input)) {
    throw validationError("recipientDoctor must be an object", "recipientDoctor");
  }

  return compactObject({
    displayName: requiredString(input.displayName ?? input.display_name, "recipientDoctor.displayName"),
    title: optionalString(input.title),
    departmentName: optionalString(input.departmentName ?? input.department_name)
  });
}

function normalizeTextLines(value, maxItems, field) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const values = Array.isArray(value)
    ? value
    : String(value).split(/\n+/);
  const normalized = values
    .map(optionalString)
    .filter(Boolean)
    .slice(0, maxItems);

  if (Array.isArray(value) && value.length > maxItems) {
    throw validationError(`${field} must contain ${maxItems} items or less`, field);
  }

  return normalized;
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

function requiredMultilineString(value, field, maxLength) {
  const normalized = optionalMultilineString(value, maxLength);
  if (!normalized) {
    throw validationError(`${field} is required`, field);
  }

  return normalized;
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

function optionalDateTime(value, field) {
  const normalized = optionalString(value);
  if (!normalized) {
    return undefined;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw validationError(`${field} must be a valid ISO 8601 timestamp`, field);
  }

  return date.toISOString();
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
