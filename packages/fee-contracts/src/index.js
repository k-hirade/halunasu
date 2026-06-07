export const feeSettings = Object.freeze(["outpatient", "inpatient"]);
export const feeSessionStatuses = Object.freeze([
  "draft",
  "ready",
  "calculating",
  "calculated",
  "needs_review",
  "failed"
]);
export const feeOrderTypes = Object.freeze([
  "lab",
  "drug",
  "injection",
  "material",
  "treatment",
  "imaging",
  "procedure",
  "other",
  "unknown"
]);
export const feeReviewDecisionStatuses = Object.freeze(["approved", "rejected", "edited"]);

export function validateCreateFeePatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName ?? input.display_name, "displayName"),
    displayNameKana: optionalString(input.displayNameKana ?? input.display_name_kana),
    birthDate: optionalBirthDate(input.birthDate ?? input.birth_date),
    sex: optionalEnum(input.sex, ["male", "female", "other", "unknown"], "sex") || "unknown",
    externalPatientIds: normalizeStringArray(input.externalPatientIds ?? input.external_patient_ids),
    notes: optionalString(input.notes)
  };
}

export function validateCreateFeeSessionInput(input = {}) {
  const patient = isPlainObject(input.patient)
    ? validateCreateFeePatientInput(input.patient)
    : undefined;
  const patientId = optionalString(input.patientId ?? input.patient_id);

  const serviceDate = optionalDate(input.serviceDate ?? input.service_date, "serviceDate");

  return compactObject({
    patientId,
    patient,
    patientRef: optionalString(input.patientRef ?? input.patient_ref),
    facilityId: optionalString(input.facilityId ?? input.facility_id),
    departmentId: optionalString(input.departmentId ?? input.department_id),
    serviceDate,
    claimMonth: optionalClaimMonth(input.claimMonth ?? input.claim_month) || (serviceDate ? serviceDate.slice(0, 7) : undefined),
    setting: optionalEnum(input.setting, feeSettings, "setting") || "outpatient",
    clinicalText: optionalMultilineString(input.clinicalText ?? input.clinical_text, 100000),
    orders: normalizeFeeOrders(input.orders ?? input.order_texts),
    diagnoses: normalizeDiagnoses(input.diagnoses),
    diagnosesSource: optionalEnum(input.diagnosesSource ?? input.diagnoses_source, ["manual", "clinical_auto"], "diagnosesSource"),
    diagnosesClinicalTextHash: optionalString(input.diagnosesClinicalTextHash ?? input.diagnoses_clinical_text_hash),
    insurance: isPlainObject(input.insurance) ? input.insurance : undefined,
    claimContext: hasOwn(input, "claimContext") || hasOwn(input, "claim_context")
      ? nullablePlainObject(input.claimContext ?? input.claim_context, "claimContext")
      : undefined,
    calculationOptions: hasOwn(input, "calculationOptions") || hasOwn(input, "calculation_options")
      ? nullablePlainObject(input.calculationOptions ?? input.calculation_options, "calculationOptions")
      : undefined,
    sourceSystem: optionalString(input.sourceSystem ?? input.source_system)
  });
}

export function validateUpdateFeeSessionInput(input = {}) {
  const patient = isPlainObject(input.patient)
    ? validateCreateFeePatientInput(input.patient)
    : undefined;
  const serviceDate = hasOwn(input, "serviceDate") || hasOwn(input, "service_date")
    ? optionalDate(input.serviceDate ?? input.service_date, "serviceDate")
    : undefined;
  const patch = {
    patientId: optionalString(input.patientId ?? input.patient_id),
    patient,
    patientRef: optionalString(input.patientRef ?? input.patient_ref),
    facilityId: optionalString(input.facilityId ?? input.facility_id),
    departmentId: hasOwn(input, "departmentId") || hasOwn(input, "department_id")
      ? nullableString(input.departmentId ?? input.department_id)
      : undefined,
    serviceDate,
    claimMonth: hasOwn(input, "claimMonth") || hasOwn(input, "claim_month")
      ? optionalClaimMonth(input.claimMonth ?? input.claim_month)
      : serviceDate
        ? serviceDate.slice(0, 7)
        : undefined,
    setting: optionalEnum(input.setting, feeSettings, "setting"),
    clinicalText: hasOwn(input, "clinicalText") || hasOwn(input, "clinical_text")
      ? multilineStringValue(input.clinicalText ?? input.clinical_text, 100000)
      : undefined,
    orders: hasOwn(input, "orders") || hasOwn(input, "order_texts")
      ? normalizeFeeOrders(input.orders ?? input.order_texts)
      : undefined,
    diagnoses: hasOwn(input, "diagnoses")
      ? normalizeDiagnoses(input.diagnoses)
      : undefined,
    diagnosesSource: hasOwn(input, "diagnosesSource") || hasOwn(input, "diagnoses_source")
      ? optionalEnum(input.diagnosesSource ?? input.diagnoses_source, ["manual", "clinical_auto"], "diagnosesSource")
      : undefined,
    diagnosesClinicalTextHash: hasOwn(input, "diagnosesClinicalTextHash") || hasOwn(input, "diagnoses_clinical_text_hash")
      ? optionalString(input.diagnosesClinicalTextHash ?? input.diagnoses_clinical_text_hash)
      : undefined,
    insurance: hasOwn(input, "insurance")
      ? nullablePlainObject(input.insurance, "insurance")
      : undefined,
    claimContext: hasOwn(input, "claimContext") || hasOwn(input, "claim_context")
      ? nullablePlainObject(input.claimContext ?? input.claim_context, "claimContext")
      : undefined,
    calculationOptions: hasOwn(input, "calculationOptions") || hasOwn(input, "calculation_options")
      ? nullablePlainObject(input.calculationOptions ?? input.calculation_options, "calculationOptions")
      : undefined,
    sourceSystem: optionalString(input.sourceSystem ?? input.source_system)
  };

  return compactObject(patch);
}

export function validateCreateFeeCalculationInput(input = {}) {
  return compactObject({
    clinicalText: hasOwn(input, "clinicalText") || hasOwn(input, "clinical_text")
      ? optionalMultilineString(input.clinicalText ?? input.clinical_text, 100000)
      : undefined,
    orders: hasOwn(input, "orders") || hasOwn(input, "order_texts")
      ? normalizeFeeOrders(input.orders ?? input.order_texts)
      : undefined,
    claimContext: hasOwn(input, "claimContext") || hasOwn(input, "claim_context")
      ? nullablePlainObject(input.claimContext ?? input.claim_context, "claimContext")
      : undefined,
    calculationOptions: hasOwn(input, "calculationOptions") || hasOwn(input, "calculation_options")
      ? nullablePlainObject(input.calculationOptions ?? input.calculation_options, "calculationOptions")
      : undefined
  });
}

export function validateReviewDecisionInput(input = {}) {
  return compactObject({
    status: optionalEnum(input.status, feeReviewDecisionStatuses, "status") || "approved",
    note: optionalMultilineString(input.note, 5000),
    replacementText: optionalMultilineString(input.replacementText ?? input.replacement_text, 20000)
  });
}

export function normalizeFeeOrders(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((order, index) => normalizeFeeOrder(order, index));
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function normalizeFeeOrder(input = {}, index = 0) {
  if (!isPlainObject(input)) {
    throw validationError(`orders[${index}] must be an object`, `orders[${index}]`);
  }

  const content = optionalMultilineString(input.content, 50000);
  const localCode = optionalString(input.localCode ?? input.local_code);
  const localName = optionalString(input.localName ?? input.local_name);
  const standardCode = optionalString(input.standardCode ?? input.standard_code);
  const standardName = optionalString(input.standardName ?? input.standard_name);
  if (!content && !localCode && !localName && !standardCode && !standardName) {
    throw validationError(
      `orders[${index}] requires content, localName, localCode, standardName, or standardCode`,
      `orders[${index}]`
    );
  }

  return compactObject({
    orderId: optionalString(input.orderId ?? input.order_id) || `order_${index + 1}`,
    orderType: optionalEnum(input.orderType ?? input.order_type, feeOrderTypes, `orders[${index}].orderType`) || "unknown",
    content,
    localCode,
    localName,
    standardCode,
    standardName,
    quantity: optionalPositiveNumber(input.quantity, `orders[${index}].quantity`),
    unit: optionalString(input.unit),
    status: optionalString(input.status) || "ordered",
    sourceSystem: optionalString(input.sourceSystem ?? input.source_system)
  });
}

function normalizeDiagnoses(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((diagnosis, index) => {
    if (!isPlainObject(diagnosis)) {
      throw validationError(`diagnoses[${index}] must be an object`, `diagnoses[${index}]`);
    }
    const name = optionalString(diagnosis.name);
    const icd10Code = optionalString(diagnosis.icd10Code ?? diagnosis.icd10_code);
    if (!name && !icd10Code) {
      throw validationError(`diagnoses[${index}] requires name or icd10Code`, `diagnoses[${index}]`);
    }

    return compactObject({
      diagnosisId: optionalString(diagnosis.diagnosisId ?? diagnosis.diagnosis_id) || `diagnosis_${index + 1}`,
      name,
      icd10Code,
      outcome: optionalString(diagnosis.outcome) || "unknown",
      isPrimary: Boolean(diagnosis.isPrimary ?? diagnosis.is_primary)
    });
  });
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

function requiredDate(value, field) {
  const normalized = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw validationError(`${field} must use YYYY-MM-DD`, field);
  }

  return normalized;
}

function optionalDate(value, field) {
  const normalized = optionalString(value);
  if (!normalized) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw validationError(`${field} must use YYYY-MM-DD`, field);
  }

  return normalized;
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

function optionalClaimMonth(value) {
  const normalized = optionalString(value);
  if (!normalized) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw validationError("claimMonth must use YYYY-MM", "claimMonth");
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

function optionalPlainObject(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }

  return value;
}

function nullablePlainObject(value, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  return value;
}

function nullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return optionalString(value) || null;
}

function multilineStringValue(value, maxLength) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (text.length > maxLength) {
    throw validationError(`text must be ${maxLength} characters or less`, "text");
  }

  return text;
}

function optionalPositiveNumber(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw validationError(`${field} must be a positive number`, field);
  }

  return number;
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
