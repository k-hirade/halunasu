export const feeSettings = Object.freeze(["outpatient", "inpatient"]);
export {
  hasBloodCollectionNegationOrPlanningContext,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  hasStructuredBloodCollectionEvidence,
  isClinicalDateRatioFalsePositiveContext,
  normalizeClinicalPredicateText
} from "./clinical-predicates.js";
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
export const feeMonthlyClaimWorkStatuses = Object.freeze([
  "not_started",
  "diagnosis_requested",
  "doctor_confirming",
  "collected",
  "ready_for_claim",
  "excluded"
]);
export const feeReceiptAnnotationStatuses = Object.freeze(["draft", "confirmed", "rejected"]);
export const feeCalculationModes = Object.freeze(["full", "reuse_clinical"]);
export const feeHistoryCompletenessValues = Object.freeze(["complete", "partial", "unknown"]);
export const feeMissingHistoryBehaviors = Object.freeze(["candidate_with_review", "review_required", "suppress_history_dependent"]);
export const feePriorHistoryBehaviors = Object.freeze(["prefer_revisit_candidate", "warn_only"]);
export const feeNewDiseaseInitialHandlings = Object.freeze(["candidate_requires_review", "manual_only"]);
export const feeReviewPolicyModes = Object.freeze(["standard", "conservative", "review_heavy"]);
export const feeReceiptExportEncodings = Object.freeze(["shift_jis", "utf-8"]);
export const feeFacilityStandardStatuses = Object.freeze(["active", "pending", "expired", "withdrawn"]);
export const feeReceiptValidationSeverities = Object.freeze(["error", "warning", "off"]);
const defaultReceiptValidationSeverity = Object.freeze({
  facilityMedicalInstitutionCode: "error",
  facilityPrefectureCode: "warning",
  patientDisplayName: "error",
  patientSex: "warning",
  patientBirthDate: "warning",
  serviceDate: "error",
  claimMonth: "error",
  insuranceInsurerNumber: "error",
  insuranceInsuredSymbol: "warning",
  insuranceInsuredNumber: "warning",
  publicInsurancePayerNumber: "error",
  publicInsuranceRecipientNumber: "error",
  lineCode: "warning",
  linePoints: "warning",
  lineOrderType: "warning",
  commentText: "error",
  commentCode: "warning",
  commentShinryoIdentification: "warning",
  symptomDetailText: "error",
  symptomDetailKubun: "warning"
});
export const clinicalAutoCalculationOptionKeys = Object.freeze([
  "procedure_codes",
  "outpatient_basic",
  "inpatient_basic",
  "facility_standard_keys",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs",
  "comment_inputs",
  "lab_options"
]);

export function validateCreateFeePatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName ?? input.display_name, "displayName"),
    displayNameKana: optionalString(input.displayNameKana ?? input.display_name_kana),
    birthDate: optionalBirthDate(input.birthDate ?? input.birth_date),
    sex: optionalEnum(input.sex, ["male", "female", "other", "unknown"], "sex") || "unknown",
    externalPatientIds: normalizeStringArray(input.externalPatientIds ?? input.external_patient_ids),
    // 保険・公費は platform-contracts 側の validateInsurance/validatePublicInsurance で構造化される
    insurance: isPlainObject(input.insurance) ? input.insurance : undefined,
    publicInsurance: input.publicInsurance ?? input.public_insurance ?? undefined,
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
    admissionDate: optionalDate(input.admissionDate ?? input.admission_date, "admissionDate"),
    inpatientBasicDays: optionalPositiveInteger(input.inpatientBasicDays ?? input.inpatient_basic_days, "inpatientBasicDays"),
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
    admissionDate: hasOwn(input, "admissionDate") || hasOwn(input, "admission_date")
      ? optionalDate(input.admissionDate ?? input.admission_date, "admissionDate")
      : undefined,
    inpatientBasicDays: hasOwn(input, "inpatientBasicDays") || hasOwn(input, "inpatient_basic_days")
      ? optionalPositiveInteger(input.inpatientBasicDays ?? input.inpatient_basic_days, "inpatientBasicDays")
      : undefined,
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
    monthlyClaimWork: hasOwn(input, "monthlyClaimWork") || hasOwn(input, "monthly_claim_work")
      ? normalizeMonthlyClaimWork(input.monthlyClaimWork ?? input.monthly_claim_work)
      : undefined,
    receiptAnnotations: hasOwn(input, "receiptAnnotations") || hasOwn(input, "receipt_annotations")
      ? normalizeReceiptAnnotations(input.receiptAnnotations ?? input.receipt_annotations)
      : undefined,
    sourceSystem: optionalString(input.sourceSystem ?? input.source_system)
  };

  return compactObject(patch);
}

export function validateCreateFeeCalculationInput(input = {}) {
  return compactObject({
    calculationMode: optionalEnum(input.calculationMode ?? input.calculation_mode, feeCalculationModes, "calculationMode"),
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

export function defaultFeeSettings(input = {}) {
  const facilityId = optionalString(input.facilityId ?? input.facility_id) || "default";
  return {
    facilityId,
    effectiveFrom: optionalDate(input.effectiveFrom ?? input.effective_from, "effectiveFrom") || "2026-06-01",
    historyPolicy: {
      defaultLookbackMonths: 12,
      externalHistoryEnabled: false,
      historyCompleteness: "unknown"
    },
    initialRevisitPolicy: {
      requireReviewWhenNoHistory: true
    },
    facilityStandards: [],
    receiptPolicy: {
      ukeEncoding: "shift_jis",
      blockExportOnErrors: false,
      connectorSpecVerified: false,
      validationSeverity: { ...defaultReceiptValidationSeverity },
      annotationDefaults: {
        commentShinryoIdentification: "",
        symptomDetailKubun: ""
      }
    }
  };
}

export function validateUpdateFeeSettingsInput(input = {}) {
  const current = isPlainObject(input.current) ? input.current : {};
  const currentHistoryPolicy = isPlainObject(current.historyPolicy ?? current.history_policy) ? (current.historyPolicy ?? current.history_policy) : {};
  const currentInitialRevisitPolicy = isPlainObject(current.initialRevisitPolicy ?? current.initial_revisit_policy)
    ? (current.initialRevisitPolicy ?? current.initial_revisit_policy)
    : {};
  const currentReceiptPolicy = isPlainObject(current.receiptPolicy ?? current.receipt_policy) ? (current.receiptPolicy ?? current.receipt_policy) : {};
  const inputHistoryPolicy = isPlainObject(input.historyPolicy ?? input.history_policy) ? (input.historyPolicy ?? input.history_policy) : {};
  const inputInitialRevisitPolicy = isPlainObject(input.initialRevisitPolicy ?? input.initial_revisit_policy)
    ? (input.initialRevisitPolicy ?? input.initial_revisit_policy)
    : {};
  const inputReceiptPolicy = isPlainObject(input.receiptPolicy ?? input.receipt_policy) ? (input.receiptPolicy ?? input.receipt_policy) : {};
  const base = defaultFeeSettings({
    facilityId: input.facilityId ?? input.facility_id ?? current.facilityId ?? current.facility_id,
    effectiveFrom: input.effectiveFrom ?? input.effective_from ?? current.effectiveFrom ?? current.effective_from
  });
  const baseHistoryPolicy = { ...base.historyPolicy, ...currentHistoryPolicy, ...inputHistoryPolicy };
  const baseInitialRevisitPolicy = { ...base.initialRevisitPolicy, ...currentInitialRevisitPolicy, ...inputInitialRevisitPolicy };
  const baseReceiptPolicy = mergeReceiptPolicy(base.receiptPolicy, currentReceiptPolicy, inputReceiptPolicy);
  const facilityStandardsInput = hasOwn(input, "facilityStandards") || hasOwn(input, "facility_standards")
    ? (input.facilityStandards ?? input.facility_standards)
    : (current.facilityStandards ?? current.facility_standards);
  return {
    facilityId: optionalString(input.facilityId ?? input.facility_id ?? current.facilityId ?? current.facility_id) || base.facilityId,
    effectiveFrom: optionalDate(input.effectiveFrom ?? input.effective_from ?? current.effectiveFrom ?? current.effective_from, "effectiveFrom") || base.effectiveFrom,
    historyPolicy: normalizeHistoryPolicy(baseHistoryPolicy),
    initialRevisitPolicy: normalizeInitialRevisitPolicy(baseInitialRevisitPolicy),
    facilityStandards: normalizeFacilityStandards(facilityStandardsInput),
    receiptPolicy: normalizeReceiptPolicy(baseReceiptPolicy)
  };
}

export function validateReviewDecisionInput(input = {}) {
  return compactObject({
    status: optionalEnum(input.status, feeReviewDecisionStatuses, "status") || "approved",
    note: optionalMultilineString(input.note, 5000),
    replacementText: optionalMultilineString(input.replacementText ?? input.replacement_text, 20000)
  });
}

function normalizeMonthlyClaimWork(input) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw validationError("monthlyClaimWork must be an object", "monthlyClaimWork");
  }
  return compactObject({
    status: optionalEnum(input.status, feeMonthlyClaimWorkStatuses, "monthlyClaimWork.status") || "not_started",
    note: optionalMultilineString(input.note, 5000),
    diagnosisCandidates: hasOwn(input, "diagnosisCandidates") || hasOwn(input, "diagnosis_candidates")
      ? normalizeDiagnoses(input.diagnosisCandidates ?? input.diagnosis_candidates)
      : undefined,
    diagnosisRequestReason: optionalMultilineString(input.diagnosisRequestReason ?? input.diagnosis_request_reason, 5000),
    doctorName: optionalString(input.doctorName ?? input.doctor_name),
    requestedAt: optionalString(input.requestedAt ?? input.requested_at),
    collectedAt: optionalString(input.collectedAt ?? input.collected_at),
    collectedResult: optionalMultilineString(input.collectedResult ?? input.collected_result, 10000),
    appliedDiagnosisNames: normalizeStringArray(input.appliedDiagnosisNames ?? input.applied_diagnosis_names),
    updatedByMemberId: optionalString(input.updatedByMemberId ?? input.updated_by_member_id),
    updatedAt: optionalString(input.updatedAt ?? input.updated_at)
  });
}

function normalizeReceiptAnnotations(input) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw validationError("receiptAnnotations must be an object", "receiptAnnotations");
  }
  return compactObject({
    comments: normalizeReceiptAnnotationList(input.comments, "receiptAnnotations.comments", normalizeReceiptCommentAnnotation),
    symptomDetails: normalizeReceiptAnnotationList(
      input.symptomDetails ?? input.symptom_details,
      "receiptAnnotations.symptomDetails",
      normalizeReceiptSymptomDetailAnnotation
    ),
    updatedByMemberId: optionalString(input.updatedByMemberId ?? input.updated_by_member_id),
    updatedAt: optionalString(input.updatedAt ?? input.updated_at)
  });
}

function normalizeHistoryPolicy(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return {
    defaultLookbackMonths: clampInteger(value.defaultLookbackMonths ?? value.default_lookback_months, 1, 12, 12),
    externalHistoryEnabled: optionalBoolean(value.externalHistoryEnabled ?? value.external_history_enabled, false),
    historyCompleteness: optionalEnum(value.historyCompleteness ?? value.history_completeness, feeHistoryCompletenessValues, "historyPolicy.historyCompleteness") || "unknown"
  };
}

function normalizeInitialRevisitPolicy(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return {
    requireReviewWhenNoHistory: optionalBoolean(value.requireReviewWhenNoHistory ?? value.require_review_when_no_history, true)
  };
}

// 施設基準・届出の構造化管理。key は算定エンジンが参照する施設基準キー、
// 残りは届出管理(受理番号・算定開始日・有効期限・状態)のメタ情報。
function normalizeFacilityStandards(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry) => {
      const value = isPlainObject(entry) ? entry : {};
      return {
        key: optionalString(value.key ?? value.standardKey ?? value.standard_key) || "",
        name: optionalString(value.name ?? value.standardName ?? value.standard_name) || "",
        acceptanceNumber: optionalString(value.acceptanceNumber ?? value.acceptance_number) || "",
        claimStartDate: optionalDate(value.claimStartDate ?? value.claim_start_date, "facilityStandards.claimStartDate") || "",
        effectiveTo: optionalDate(value.effectiveTo ?? value.effective_to, "facilityStandards.effectiveTo") || "",
        status: optionalEnum(value.status, feeFacilityStandardStatuses, "facilityStandards.status") || "active"
      };
    })
    .filter((entry) => entry.key || entry.name);
}

function mergeReceiptPolicy(base = {}, current = {}, input = {}) {
  return {
    ...base,
    ...current,
    ...input,
    validationSeverity: {
      ...(base.validationSeverity || {}),
      ...(current.validationSeverity ?? current.validation_severity ?? {}),
      ...(input.validationSeverity ?? input.validation_severity ?? {})
    },
    annotationDefaults: {
      ...(base.annotationDefaults || {}),
      ...(current.annotationDefaults ?? current.annotation_defaults ?? {}),
      ...(input.annotationDefaults ?? input.annotation_defaults ?? {})
    }
  };
}

function normalizeReceiptPolicy(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return {
    ukeEncoding: optionalEnum(normalizeReceiptEncoding(value.ukeEncoding ?? value.uke_encoding), feeReceiptExportEncodings, "receiptPolicy.ukeEncoding") || "shift_jis",
    blockExportOnErrors: optionalBoolean(value.blockExportOnErrors ?? value.block_export_on_errors, false),
    connectorSpecVerified: optionalBoolean(value.connectorSpecVerified ?? value.connector_spec_verified, false),
    validationSeverity: normalizeReceiptValidationSeverity(value.validationSeverity ?? value.validation_severity),
    annotationDefaults: normalizeReceiptAnnotationDefaults(value.annotationDefaults ?? value.annotation_defaults)
  };
}

function normalizeReceiptValidationSeverity(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return Object.fromEntries(Object.entries(defaultReceiptValidationSeverity).map(([key, fallback]) => [
    key,
    optionalEnum(value[key], feeReceiptValidationSeverities, `receiptPolicy.validationSeverity.${key}`) || fallback
  ]));
}

function normalizeReceiptAnnotationDefaults(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return {
    commentShinryoIdentification: optionalString(value.commentShinryoIdentification ?? value.comment_shinryo_identification) || "",
    symptomDetailKubun: optionalString(value.symptomDetailKubun ?? value.symptom_detail_kubun) || ""
  };
}

function normalizeReceiptEncoding(value) {
  const normalized = optionalString(value)?.toLowerCase().replace(/[-_]/g, "");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "utf8" || normalized === "utf") {
    return "utf-8";
  }
  if (normalized === "shiftjis" || normalized === "sjis") {
    return "shift_jis";
  }
  return value;
}

function clampInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return Boolean(value);
}

function normalizeReceiptAnnotationList(value, field, normalize) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`, field);
  }
  return value.map((entry, index) => normalize(entry, `${field}[${index}]`));
}

function normalizeReceiptCommentAnnotation(input, field) {
  if (!isPlainObject(input)) {
    throw validationError(`${field} must be an object`, field);
  }
  const text = optionalMultilineString(input.text, 5000);
  return compactObject({
    annotationId: optionalString(input.annotationId ?? input.annotation_id),
    status: optionalEnum(input.status, feeReceiptAnnotationStatuses, `${field}.status`) || "draft",
    shinryoIdentification: optionalString(input.shinryoIdentification ?? input.shinryo_identification),
    code: optionalString(input.code),
    text,
    sourceReviewItemId: optionalString(input.sourceReviewItemId ?? input.source_review_item_id),
    sourceLabel: optionalString(input.sourceLabel ?? input.source_label),
    note: optionalMultilineString(input.note, 5000),
    createdAt: optionalString(input.createdAt ?? input.created_at),
    createdByMemberId: optionalString(input.createdByMemberId ?? input.created_by_member_id),
    updatedAt: optionalString(input.updatedAt ?? input.updated_at),
    updatedByMemberId: optionalString(input.updatedByMemberId ?? input.updated_by_member_id)
  });
}

function normalizeReceiptSymptomDetailAnnotation(input, field) {
  if (!isPlainObject(input)) {
    throw validationError(`${field} must be an object`, field);
  }
  const text = optionalMultilineString(input.text, 10000);
  return compactObject({
    annotationId: optionalString(input.annotationId ?? input.annotation_id),
    status: optionalEnum(input.status, feeReceiptAnnotationStatuses, `${field}.status`) || "draft",
    kubun: optionalString(input.kubun),
    text,
    sourceReviewItemId: optionalString(input.sourceReviewItemId ?? input.source_review_item_id),
    sourceLabel: optionalString(input.sourceLabel ?? input.source_label),
    note: optionalMultilineString(input.note, 5000),
    createdAt: optionalString(input.createdAt ?? input.created_at),
    createdByMemberId: optionalString(input.createdByMemberId ?? input.created_by_member_id),
    updatedAt: optionalString(input.updatedAt ?? input.updated_at),
    updatedByMemberId: optionalString(input.updatedByMemberId ?? input.updated_by_member_id)
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
    sourceSystem: optionalString(input.sourceSystem ?? input.source_system),
    sourceLabel: optionalString(input.sourceLabel ?? input.source_label),
    note: optionalMultilineString(input.note, 5000),
    createdAt: optionalString(input.createdAt ?? input.created_at),
    createdBy: optionalString(input.createdBy ?? input.created_by)
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

function optionalPositiveInteger(value, field) {
  const number = optionalPositiveNumber(value, field);
  if (number === undefined) {
    return undefined;
  }
  if (!Number.isInteger(number)) {
    throw validationError(`${field} must be a positive integer`, field);
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
