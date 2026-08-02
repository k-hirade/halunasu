export const CARE_EMERGENCY_CSV_SCHEMA_VERSION = "care-emergency-csv-v1";
export const CARE_FEE_EVIDENCE_CONTRACT_VERSION = "care-fee-evidence-v1";

export const careServiceTypes = Object.freeze([
  "roken",
  "care_medical_institution",
  "short_stay_roken",
  "short_stay_care_medical_institution",
  "preventive_short_stay_roken",
  "preventive_short_stay_care_medical_institution"
]);

export const careInputOrigins = Object.freeze([
  "manual",
  "csv_export",
  "ocr",
  "fee_app",
  "api"
]);

export const careEmergencyJudgmentStatuses = Object.freeze([
  "billing_candidate",
  "needs_review",
  "conflict",
  "not_eligible",
  "import_error"
]);

export const careEmergencyDayJudgments = Object.freeze([
  "eligible",
  "needs_review",
  "over_limit",
  "not_eligible"
]);

export const careFeeEpisodeDecisionStatuses = Object.freeze([
  "pending",
  "confirmed",
  "excluded"
]);

export const CARE_EMERGENCY_SEVERE_FIELDS = Object.freeze([
  "severe_consciousness_disorder",
  "severe_respiratory_failure",
  "severe_heart_failure",
  "severe_shock",
  "severe_metabolic_disorder",
  "severe_other_poisoning"
]);

export const CARE_EMERGENCY_TREATMENT_FIELDS = Object.freeze([
  Object.freeze({ performed: "medication_performed", detail: "medication_detail", kind: "medication" }),
  Object.freeze({ performed: "test_performed", detail: "test_detail", kind: "test" }),
  Object.freeze({ performed: "injection_performed", detail: "injection_detail", kind: "injection" }),
  Object.freeze({ performed: "procedure_performed", detail: "procedure_detail", kind: "procedure" })
]);

export const CARE_EMERGENCY_CONFLICT_FIELDS = Object.freeze([
  "concurrent_specific_treatment",
  "concurrent_specific_disease_facility_treatment",
  "concurrent_comprehensive_medical_management"
]);

export const CARE_EMERGENCY_INPUT_COLUMNS = Object.freeze([
  "schema_version",
  "batch_id",
  "facility_code",
  "care_office_number",
  "care_service_type",
  "claim_month",
  "patient_key",
  "patient_display_name",
  "episode_key",
  "onset_at",
  "treatment_date",
  "acute_diagnosis",
  ...CARE_EMERGENCY_SEVERE_FIELDS,
  "emergency_care_required",
  "emergency_care_rationale",
  "facility_treatment_rationale",
  ...CARE_EMERGENCY_TREATMENT_FIELDS.flatMap((field) => [field.performed, field.detail]),
  "physician_confirmed",
  "physician_confirmed_by",
  "physician_confirmed_at",
  "existing_emergency_claim_count_month",
  "existing_emergency_claim_start_date",
  ...CARE_EMERGENCY_CONFLICT_FIELDS,
  "existing_claim_service_code",
  "transfer_requested",
  "transfer_outcome",
  "source_record_id",
  "source_excerpt",
  "input_origin"
]);

export const CARE_EMERGENCY_OUTPUT_COLUMNS = Object.freeze([
  "import_status",
  "judgment_status",
  "eligible_day",
  "day_judgment",
  "resolved_service_code",
  "resolved_service_code_name",
  "unit_score",
  "counted_units",
  "episode_eligible_day_count",
  "episode_total_units",
  "reason_codes",
  "missing_fields",
  "conflict_codes",
  "master_version",
  "rule_version",
  "source_file_sha256",
  "normalized_row_sha256",
  "run_id",
  "evaluated_at"
]);

const REQUIRED_TEXT_FIELDS = Object.freeze([
  "facility_code",
  "care_service_type",
  "claim_month",
  "patient_key",
  "episode_key",
  "onset_at",
  "treatment_date",
  "input_origin"
]);

const BOOLEAN_FIELDS = Object.freeze([
  ...CARE_EMERGENCY_SEVERE_FIELDS,
  "emergency_care_required",
  ...CARE_EMERGENCY_TREATMENT_FIELDS.map((field) => field.performed),
  "physician_confirmed",
  ...CARE_EMERGENCY_CONFLICT_FIELDS,
  "transfer_requested"
]);

const FIELD_TO_PROPERTY = Object.freeze(Object.fromEntries(
  CARE_EMERGENCY_INPUT_COLUMNS.map((field) => [field, snakeToCamel(field)])
));

export class CareFeeValidationError extends Error {
  constructor(issues, message = "Care fee input is invalid") {
    super(message);
    this.name = "CareFeeValidationError";
    this.statusCode = 400;
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

export function validateEmergencyTreatmentRow(input = {}, options = {}) {
  try {
    return {
      ok: true,
      value: normalizeEmergencyTreatmentRow(input, options),
      issues: []
    };
  } catch (error) {
    if (!(error instanceof CareFeeValidationError)) {
      throw error;
    }
    return { ok: false, value: null, issues: error.issues };
  }
}

export function normalizeEmergencyTreatmentRow(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw new CareFeeValidationError([
      issue("row", "invalid_type", "row must be an object", options.rowNumber)
    ]);
  }

  const rowNumber = positiveIntegerOrNull(options.rowNumber);
  const issues = [];
  const normalized = { rowNumber };

  for (const field of CARE_EMERGENCY_INPUT_COLUMNS) {
    const property = FIELD_TO_PROPERTY[field];
    if (BOOLEAN_FIELDS.includes(field)) {
      normalized[property] = triStateBoolean(input[field], field, issues, rowNumber);
      continue;
    }
    normalized[property] = optionalString(input[field]);
  }

  if (normalized.schemaVersion !== CARE_EMERGENCY_CSV_SCHEMA_VERSION) {
    issues.push(issue(
      "schema_version",
      "unsupported_schema_version",
      `schema_version must be ${CARE_EMERGENCY_CSV_SCHEMA_VERSION}`,
      rowNumber
    ));
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    const property = FIELD_TO_PROPERTY[field];
    if (options.allowIncompleteClinicalFacts === true && field === "onset_at") {
      continue;
    }
    if (!normalized[property]) {
      issues.push(issue(field, "required", `${field} is required`, rowNumber));
    }
  }

  if (normalized.careServiceType && !careServiceTypes.includes(normalized.careServiceType)) {
    issues.push(issue("care_service_type", "invalid_enum", "care_service_type is not supported", rowNumber));
  }
  if (normalized.inputOrigin && !careInputOrigins.includes(normalized.inputOrigin)) {
    issues.push(issue("input_origin", "invalid_enum", "input_origin is not supported", rowNumber));
  }
  if (normalized.claimMonth && !isClaimMonth(normalized.claimMonth)) {
    issues.push(issue("claim_month", "invalid_month", "claim_month must be YYYY-MM", rowNumber));
  }
  if (normalized.treatmentDate && !isIsoDate(normalized.treatmentDate)) {
    issues.push(issue("treatment_date", "invalid_date", "treatment_date must be YYYY-MM-DD", rowNumber));
  }
  if (normalized.onsetAt && !isIsoDateTime(normalized.onsetAt)) {
    issues.push(issue("onset_at", "invalid_datetime", "onset_at must be an ISO 8601 datetime", rowNumber));
  }
  if (normalized.physicianConfirmedAt && !isIsoDateTime(normalized.physicianConfirmedAt)) {
    issues.push(issue(
      "physician_confirmed_at",
      "invalid_datetime",
      "physician_confirmed_at must be an ISO 8601 datetime",
      rowNumber
    ));
  }
  if (normalized.existingEmergencyClaimStartDate && !isIsoDate(normalized.existingEmergencyClaimStartDate)) {
    issues.push(issue(
      "existing_emergency_claim_start_date",
      "invalid_date",
      "existing_emergency_claim_start_date must be YYYY-MM-DD",
      rowNumber
    ));
  }
  if (
    normalized.claimMonth
    && normalized.treatmentDate
    && isClaimMonth(normalized.claimMonth)
    && isIsoDate(normalized.treatmentDate)
    && normalized.treatmentDate.slice(0, 7) !== normalized.claimMonth
  ) {
    issues.push(issue(
      "claim_month",
      "claim_month_mismatch",
      "claim_month must match treatment_date",
      rowNumber
    ));
  }

  normalized.existingEmergencyClaimCountMonth = nonNegativeIntegerOrNull(
    input.existing_emergency_claim_count_month,
    "existing_emergency_claim_count_month",
    issues,
    rowNumber
  );

  if (
    options.allowIncompleteClinicalFacts !== true
    && normalized.emergencyCareRequired === true
    && !normalized.emergencyCareRationale
  ) {
    issues.push(issue(
      "emergency_care_rationale",
      "required_when_true",
      "emergency_care_rationale is required when emergency_care_required is true",
      rowNumber
    ));
  }

  for (const treatment of CARE_EMERGENCY_TREATMENT_FIELDS) {
    if (
      options.allowIncompleteClinicalFacts !== true
      && normalized[FIELD_TO_PROPERTY[treatment.performed]] === true
      && !normalized[FIELD_TO_PROPERTY[treatment.detail]]
    ) {
      issues.push(issue(
        treatment.detail,
        "required_when_true",
        `${treatment.detail} is required when ${treatment.performed} is true`,
        rowNumber
      ));
    }
  }

  if (options.allowIncompleteClinicalFacts !== true && normalized.physicianConfirmed === true) {
    if (!normalized.physicianConfirmedBy) {
      issues.push(issue(
        "physician_confirmed_by",
        "required_when_true",
        "physician_confirmed_by is required when physician_confirmed is true",
        rowNumber
      ));
    }
    if (!normalized.physicianConfirmedAt) {
      issues.push(issue(
        "physician_confirmed_at",
        "required_when_true",
        "physician_confirmed_at is required when physician_confirmed is true",
        rowNumber
      ));
    }
  }

  if (
    options.allowIncompleteClinicalFacts !== true
    && normalized.existingEmergencyClaimCountMonth > 0
    && !normalized.existingEmergencyClaimStartDate
  ) {
    issues.push(issue(
      "existing_emergency_claim_start_date",
      "required_when_positive",
      "existing_emergency_claim_start_date is required when an existing claim is present",
      rowNumber
    ));
  }

  if (normalized.existingClaimServiceCode && !/^[0-9A-Z]{6}$/u.test(normalized.existingClaimServiceCode)) {
    issues.push(issue(
      "existing_claim_service_code",
      "invalid_service_code",
      "existing_claim_service_code must contain 6 uppercase letters or digits",
      rowNumber
    ));
  }

  if (issues.length > 0) {
    throw new CareFeeValidationError(issues);
  }

  return Object.freeze(normalized);
}

export function validateCareFeeEvidenceEventInput(input = {}) {
  const issues = [];
  const contractVersion = optionalString(input.contractVersion ?? input.contract_version);
  if (contractVersion !== CARE_FEE_EVIDENCE_CONTRACT_VERSION) {
    issues.push(issue("contractVersion", "unsupported_contract_version", "unsupported evidence contract version"));
  }

  const value = {
    contractVersion,
    orgId: requiredValue(input.orgId ?? input.org_id, "orgId", issues),
    sourceProduct: requiredValue(input.sourceProduct ?? input.source_product, "sourceProduct", issues),
    sourceRecordId: requiredValue(input.sourceRecordId ?? input.source_record_id, "sourceRecordId", issues),
    sourceRevisionHash: requiredValue(input.sourceRevisionHash ?? input.source_revision_hash, "sourceRevisionHash", issues),
    organizationCode: optionalString(input.organizationCode ?? input.organization_code),
    facilityId: requiredValue(input.facilityId ?? input.facility_id, "facilityId", issues),
    facilityCode: requiredValue(input.facilityCode ?? input.facility_code, "facilityCode", issues),
    patientKey: requiredValue(input.patientKey ?? input.patient_key, "patientKey", issues),
    observedAt: optionalString(input.observedAt ?? input.observed_at),
    evidenceMetadata: normalizeCareFeeEvidenceMetadata(
      input.evidenceMetadata ?? input.evidence_metadata,
      issues
    ),
    rows: []
  };
  if (value.sourceRevisionHash && !/^[a-f0-9]{64}$/u.test(value.sourceRevisionHash)) {
    issues.push(issue("sourceRevisionHash", "invalid_sha256", "sourceRevisionHash must be a lowercase SHA-256"));
  }
  if (value.observedAt && !isIsoDateTime(value.observedAt)) {
    issues.push(issue("observedAt", "invalid_datetime", "observedAt must be an ISO 8601 datetime"));
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    issues.push(issue("rows", "required", "rows must contain at least one item"));
  } else {
    input.rows.forEach((row, index) => {
      const result = validateEmergencyTreatmentRow(row, {
        rowNumber: index + 1,
        allowIncompleteClinicalFacts: true
      });
      if (result.ok) {
        value.rows.push(result.value);
      } else {
        issues.push(...result.issues.map((entry) => ({ ...entry, field: `rows.${index}.${entry.field}` })));
      }
    });
  }

  if (issues.length > 0) {
    throw new CareFeeValidationError(issues, "Care fee evidence event is invalid");
  }
  return value;
}

function normalizeCareFeeEvidenceMetadata(input, issues) {
  if (input === undefined || input === null) return Object.freeze({});
  if (!isPlainObject(input)) {
    issues.push(issue("evidenceMetadata", "invalid_type", "evidenceMetadata must be an object"));
    return Object.freeze({});
  }
  const confidence = input.confidence === undefined || input.confidence === null
    ? null
    : Number(input.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    issues.push(issue("evidenceMetadata.confidence", "invalid_range", "confidence must be between 0 and 1"));
  }
  const generatedAt = optionalString(input.generatedAt ?? input.generated_at);
  if (generatedAt && !isIsoDateTime(generatedAt)) {
    issues.push(issue("evidenceMetadata.generatedAt", "invalid_datetime", "generatedAt must be an ISO 8601 datetime"));
  }
  return Object.freeze({
    extractorVersion: optionalString(input.extractorVersion ?? input.extractor_version),
    confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
    sourceScope: optionalString(input.sourceScope ?? input.source_scope),
    generatedAt
  });
}

export function validateCareFeeFacilitySettingsInput(input = {}) {
  if (!isPlainObject(input)) {
    throw new CareFeeValidationError([issue("settings", "invalid_type", "settings must be an object")]);
  }
  const issues = [];
  const facilityId = requiredValue(input.facilityId ?? input.facility_id, "facilityId", issues);
  const facilityCode = requiredValue(input.facilityCode ?? input.facility_code, "facilityCode", issues);
  const emergencyServiceCodes = normalizeStringMap(input.emergencyServiceCodes ?? input.emergency_service_codes);
  const facilityVariants = normalizeStringMap(input.facilityVariants ?? input.facility_variants);
  for (const [serviceType, serviceCode] of Object.entries(emergencyServiceCodes)) {
    if (!careServiceTypes.includes(serviceType)) {
      issues.push(issue("emergencyServiceCodes", "invalid_service_type", `unsupported service type: ${serviceType}`));
    }
    if (!/^[0-9A-Z]{6}$/u.test(serviceCode)) {
      issues.push(issue("emergencyServiceCodes", "invalid_service_code", `invalid service code for ${serviceType}`));
    }
  }
  for (const serviceType of Object.keys(facilityVariants)) {
    if (!careServiceTypes.includes(serviceType)) {
      issues.push(issue("facilityVariants", "invalid_service_type", `unsupported service type: ${serviceType}`));
    }
  }
  const timezone = optionalString(input.timezone) || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: timezone });
  } catch {
    issues.push(issue("timezone", "invalid_timezone", "timezone must be an IANA timezone"));
  }
  if (issues.length > 0) {
    throw new CareFeeValidationError(issues, "Care fee facility settings are invalid");
  }
  return Object.freeze({
    facilityId,
    facilityCode,
    careOfficeNumber: optionalString(input.careOfficeNumber ?? input.care_office_number),
    timezone,
    emergencyServiceCodes: Object.freeze(emergencyServiceCodes),
    facilityVariants: Object.freeze(facilityVariants),
    enabled: input.enabled !== false
  });
}

export function validateCareFeeEpisodeRowsInput(input = {}) {
  const issues = [];
  const facilityId = requiredValue(input.facilityId ?? input.facility_id, "facilityId", issues);
  const rows = [];
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    issues.push(issue("rows", "required", "rows must contain at least one item"));
  } else {
    input.rows.forEach((row, index) => {
      const result = validateEmergencyTreatmentRow(row, { rowNumber: index + 1 });
      if (result.ok) rows.push(result.value);
      else issues.push(...result.issues.map((entry) => ({ ...entry, field: `rows.${index}.${entry.field}` })));
    });
  }
  if (issues.length > 0) {
    throw new CareFeeValidationError(issues, "Care fee episode rows are invalid");
  }
  return Object.freeze({ facilityId, rows: Object.freeze(rows) });
}

export function validateCareFeeEpisodeDecisionInput(input = {}) {
  const status = optionalString(input.status);
  const issues = [];
  if (!careFeeEpisodeDecisionStatuses.includes(status) || status === "pending") {
    issues.push(issue("status", "invalid_enum", "status must be confirmed or excluded"));
  }
  const reason = optionalString(input.reason);
  if (status === "excluded" && !reason) {
    issues.push(issue("reason", "required", "reason is required when excluding an episode"));
  }
  if (issues.length > 0) throw new CareFeeValidationError(issues, "Care fee decision is invalid");
  return Object.freeze({ status, reason });
}

export function validateMonthlyCareFeeRunInput(input = {}) {
  const issues = [];
  const claimMonth = optionalString(input.claimMonth ?? input.claim_month);
  const facilityId = requiredValue(input.facilityId ?? input.facility_id, "facilityId", issues);
  if (!claimMonth || !isClaimMonth(claimMonth)) {
    issues.push(issue("claimMonth", "invalid_month", "claimMonth must be YYYY-MM"));
  }
  const timezone = optionalString(input.timezone) || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: timezone });
  } catch {
    issues.push(issue("timezone", "invalid_timezone", "timezone must be an IANA timezone"));
  }
  if (issues.length > 0) {
    throw new CareFeeValidationError(issues);
  }
  return { claimMonth, facilityId, timezone };
}

export function careEmergencyColumnProperty(column) {
  return FIELD_TO_PROPERTY[column] || snakeToCamel(column);
}

function triStateBoolean(value, field, issues, rowNumber) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  issues.push(issue(field, "invalid_boolean", `${field} must be true, false, or blank`, rowNumber));
  return null;
}

function nonNegativeIntegerOrNull(value, field, issues, rowNumber) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    issues.push(issue(field, "invalid_non_negative_integer", `${field} must be a non-negative integer`, rowNumber));
    return null;
  }
  return Number.parseInt(text, 10);
}

function isClaimMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
}

function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

function isIsoDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/u.exec(value);
  if (!match || !isIsoDate(match[1])) return false;
  return Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4] || 0) <= 59;
}

function requiredValue(value, field, issues) {
  const normalized = optionalString(value);
  if (!normalized) {
    issues.push(issue(field, "required", `${field} is required`));
  }
  return normalized;
}

function issue(field, code, message, rowNumber = null) {
  return Object.freeze({ field, code, message, rowNumber });
}

function optionalString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function snakeToCamel(value) {
  return String(value).replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringMap(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    String(key).trim(),
    optionalString(item)
  ]).filter(([key, item]) => key && item));
}
