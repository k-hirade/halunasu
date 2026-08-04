// 受診区分。home_visit(定期的な訪問診療)は外来基本料を使わない。
// house_call(患者・家族の求めによる往診)は初再診料と往診料を組み合わせる。
export const feeSettings = Object.freeze(["outpatient", "inpatient", "home_visit", "house_call"]);
export const sidecarEncounterTypeSources = Object.freeze(["dom", "user"]);
export const feeResidenceTypes = Object.freeze(["private", "facility"]);
export const feeVisitKinds = Object.freeze(["telephone_revisit"]);
export const sidecarContractVersions = Object.freeze(["v1"]);
export const sidecarCandidateDecisionStatuses = Object.freeze([
  "unacknowledged",
  "acknowledged",
  "excluded"
]);
export const patientChargeTypes = Object.freeze(["home_medical_transport"]);
export const patientChargeHandlings = Object.freeze([
  "inherit",
  "charge",
  "waive",
  "included_in_contract"
]);
export const patientChargeAmountModes = Object.freeze(["actual", "fixed"]);
export const sidecarSourceSurfaceStatuses = Object.freeze(["ok", "unavailable"]);
export const sidecarSourceSurfaceUnavailableReasons = Object.freeze([
  "fetch_failed",
  "http_error",
  "selector_mismatch",
  "timeout"
]);
const sidecarSourceSurfaceNames = Object.freeze([
  "currentChart",
  "documents",
  "problems",
  "visitPlan"
]);
const sidecarSourceListCompletenessValues = Object.freeze([
  "complete",
  "incomplete",
  "unknown"
]);
export {
  CLAUSE_SEGMENTATION_VERSION,
  clinicalServiceContextCues,
  clinicalServiceContextCuesForMention,
  hasCurrentVisitClinicalServiceContext,
  hasBloodCollectionNegationOrPlanningContext,
  hasPerformedClinicalServiceEvidence,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  hasStructuredBloodCollectionEvidence,
  isClinicalDateRatioFalsePositiveContext,
  isFutureOrOrderOnlyClinicalServiceContext,
  isNegatedClinicalServiceContext,
  isPastOrExternalClinicalServiceContext,
  normalizeClinicalPredicateText,
  resolveClinicalServiceMentionScope,
  splitClinicalEvidenceClauses
} from "./clinical-predicates.js";
export const feeSessionStatuses = Object.freeze([
  "draft",
  "ready",
  "calculating",
  "calculated",
  "needs_review",
  "failed"
]);
export const careFeeIntegrationServiceTypes = Object.freeze([
  "roken",
  "care_medical_institution",
  "short_stay_roken",
  "short_stay_care_medical_institution",
  "preventive_short_stay_roken",
  "preventive_short_stay_care_medical_institution"
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
export const feePricingModes = Object.freeze(["service_date", "current_master"]);
export const feeHistoryCompletenessValues = Object.freeze(["complete", "partial", "unknown"]);
export const feeMissingHistoryBehaviors = Object.freeze(["candidate_with_review", "review_required", "suppress_history_dependent"]);
export const feePriorHistoryBehaviors = Object.freeze(["prefer_revisit_candidate", "warn_only"]);
export const feeNewDiseaseInitialHandlings = Object.freeze(["candidate_requires_review", "manual_only"]);
export const feeReviewPolicyModes = Object.freeze(["standard", "conservative", "review_heavy"]);
export const feeReceiptExportEncodings = Object.freeze(["shift_jis", "utf-8"]);
export const feeFacilityStandardStatuses = Object.freeze(["active", "pending", "expired", "withdrawn"]);
const MEISAISHO_HAKKO_STANDARD_KEY = "meisaisho_hakko_taisei";
const DENSHITEKI_SHINRYO_JOHO_RENKEI_STANDARD_KEY = "denshiteki_shinryo_joho_renkei_taisei";
const AFTER_HOURS_RESPONSE_STANDARD_KEYS = Object.freeze([
  "jikan_gai_taio_taisei_1",
  "jikan_gai_taio_taisei_2",
  "jikan_gai_taio_taisei_3",
  "jikan_gai_taio_taisei_4"
]);
const FACILITY_SERVICE_SCHEDULE_WEEKDAYS = Object.freeze([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
]);
// 恒常算定ルールの動作: confirm=算定入力へ自動追加(エンジンがマスタ照合・制約チェック),
// candidate=承認待ち候補として提示(合計に入らない)。
export const feeAutoBillingRuleActions = Object.freeze(["confirm", "candidate"]);
export const feeAutoBillingRuleRoles = Object.freeze([
  "standard",
  "home_visit_basic",
  "home_visit_baseup"
]);
export const feeReceiptScopes = Object.freeze(["service_date", "monthly"]);
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
    encounterDetails: hasOwn(input, "encounterDetails") || hasOwn(input, "encounter_details")
      ? normalizeFeeEncounterDetails(input.encounterDetails ?? input.encounter_details)
      : undefined,
    receptionTime: optionalReceptionTime(input.receptionTime ?? input.reception_time),
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

export function validateSidecarCalculationInput(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("request body must be an object", "body");
  }
  if (Object.hasOwn(input, "sourceUrl") || Object.hasOwn(input, "source_url")) {
    throw validationError("sourceUrl must not be sent", "sourceUrl");
  }

  const externalPatientId = boundedRequiredString(
    input.externalPatientId ?? input.external_patient_id,
    "externalPatientId",
    256
  );
  const sourceRecordId = boundedRequiredString(
    input.sourceRecordId ?? input.source_record_id,
    "sourceRecordId",
    256
  );
  const clinicalText = optionalMultilineString(input.clinicalText ?? input.clinical_text, 100000);
  if (!clinicalText) {
    throw validationError("clinicalText is required", "clinicalText");
  }
  const setting = optionalEnum(input.setting, feeSettings, "setting");
  if (!setting) {
    throw validationError("setting is required", "setting");
  }
  const encounterTypeSource = optionalEnum(
    input.encounterTypeSource ?? input.encounter_type_source,
    sidecarEncounterTypeSources,
    "encounterTypeSource"
  );
  if (!encounterTypeSource) {
    throw validationError("encounterTypeSource is required", "encounterTypeSource");
  }

  const selectorContractVersion = boundedRequiredString(
    input.extractionProof?.selectorContractVersion
      ?? input.extraction_proof?.selector_contract_version,
    "extractionProof.selectorContractVersion",
    128
  );
  const sourceSurfaces = validateSidecarSourceSurfaces(
    input.sourceSurfaces ?? input.source_surfaces,
    { externalPatientId, sourceRecordId, selectorContractVersion }
  );
  const proof = validateSidecarExtractionProof(
    input.extractionProof ?? input.extraction_proof,
    { externalPatientId, sourceRecordId, sourceSurfaces }
  );
  const encounterDetails = normalizeFeeEncounterDetails({
    sameBuilding: hasOwn(input, "sameBuilding") || hasOwn(input, "same_building")
      ? (input.sameBuilding ?? input.same_building)
      : null,
    sameBuildingSource: hasOwn(input, "sameBuildingSource") || hasOwn(input, "same_building_source")
      ? (input.sameBuildingSource ?? input.same_building_source)
      : null,
    singleBuildingPatientCount: hasOwn(input, "singleBuildingPatientCount") || hasOwn(input, "single_building_patient_count")
      ? (input.singleBuildingPatientCount ?? input.single_building_patient_count)
      : null,
    residenceType: hasOwn(input, "residenceType") || hasOwn(input, "residence_type")
      ? (input.residenceType ?? input.residence_type)
      : null,
    visitKind: hasOwn(input, "visitKind") || hasOwn(input, "visit_kind")
      ? (input.visitKind ?? input.visit_kind)
      : null,
    visitKindSource: hasOwn(input, "visitKindSource") || hasOwn(input, "visit_kind_source")
      ? (input.visitKindSource ?? input.visit_kind_source)
      : null,
    telephoneEligibility: hasOwn(input, "telephoneEligibility") || hasOwn(input, "telephone_eligibility")
      ? (input.telephoneEligibility ?? input.telephone_eligibility)
      : null
  });
  return compactObject({
    contractVersion: optionalEnum(
      input.contractVersion ?? input.contract_version ?? "v1",
      sidecarContractVersions,
      "contractVersion"
    ),
    facilityId: boundedRequiredString(input.facilityId ?? input.facility_id, "facilityId", 256),
    departmentId: optionalString(input.departmentId ?? input.department_id),
    sourceSystem: optionalEnum(input.sourceSystem ?? input.source_system, ["homis"], "sourceSystem") || "homis",
    externalPatientId,
    sourceRecordId,
    sourceRecordDisplayId: optionalString(input.sourceRecordDisplayId ?? input.source_record_display_id),
    serviceDate: requiredDate(input.serviceDate ?? input.service_date, "serviceDate"),
    receptionTime: optionalReceptionTime(input.receptionTime ?? input.reception_time),
    setting,
    encounterTypeSource,
    sameBuilding: encounterDetails.sameBuilding,
    sameBuildingSource: encounterDetails.sameBuildingSource,
    singleBuildingPatientCount: encounterDetails.singleBuildingPatientCount,
    residenceType: encounterDetails.residenceType,
    visitKind: encounterDetails.visitKind,
    visitKindSource: encounterDetails.visitKindSource,
    telephoneEligibility: encounterDetails.telephoneEligibility,
    clinicalText,
    orders: normalizeFeeOrders(input.orders),
    diagnoses: normalizeDiagnoses(input.diagnoses),
    sourceSurfaces,
    extractionProof: proof
  });
}

export function validateSidecarCandidateAcknowledgementInput(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("request body must be an object", "body");
  }
  const contractVersion = boundedRequiredString(
    input.contractVersion ?? input.contract_version,
    "contractVersion",
    16
  );
  if (!sidecarContractVersions.includes(contractVersion)) {
    throw validationError(
      `contractVersion must be one of: ${sidecarContractVersions.join(", ")}`,
      "contractVersion"
    );
  }
  const candidateFingerprint = input.candidateFingerprint ?? input.candidate_fingerprint;
  if (typeof candidateFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(candidateFingerprint)) {
    throw validationError(
      "candidateFingerprint must be a 64-character lowercase hexadecimal value",
      "candidateFingerprint"
    );
  }
  const explicitStatus = optionalEnum(
    input.status,
    sidecarCandidateDecisionStatuses,
    "status"
  );
  const hasLegacyAcknowledged = hasOwn(input, "acknowledged");
  const legacyStatus = hasLegacyAcknowledged
    ? (strictBoolean(input.acknowledged, "acknowledged") ? "acknowledged" : "unacknowledged")
    : null;
  if (!explicitStatus && !legacyStatus) {
    throw validationError("status is required", "status");
  }
  if (explicitStatus && legacyStatus && explicitStatus !== legacyStatus) {
    throw validationError("status and acknowledged must describe the same decision", "status");
  }

  return {
    contractVersion,
    status: explicitStatus || legacyStatus,
    expectedSourceRevision: requiredPositiveInteger(
      input.expectedSourceRevision ?? input.expected_source_revision,
      "expectedSourceRevision"
    ),
    expectedCalculationRevision: requiredPositiveInteger(
      input.expectedCalculationRevision ?? input.expected_calculation_revision,
      "expectedCalculationRevision"
    ),
    expectedAcknowledgementVersion: requiredNonNegativeInteger(
      input.expectedAcknowledgementVersion ?? input.expected_acknowledgement_version,
      "expectedAcknowledgementVersion"
    ),
    candidateFingerprint
  };
}

export function validateSidecarCandidateSelectionInput(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("request body must be an object", "body");
  }
  const contractVersion = boundedRequiredString(
    input.contractVersion ?? input.contract_version,
    "contractVersion",
    16
  );
  if (!sidecarContractVersions.includes(contractVersion)) {
    throw validationError(
      `contractVersion must be one of: ${sidecarContractVersions.join(", ")}`,
      "contractVersion"
    );
  }
  const candidateFingerprint = input.candidateFingerprint ?? input.candidate_fingerprint;
  if (typeof candidateFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(candidateFingerprint)) {
    throw validationError(
      "candidateFingerprint must be a 64-character lowercase hexadecimal value",
      "candidateFingerprint"
    );
  }
  const rawSelectedCode = input.selectedCode ?? input.selected_code ?? "";
  if (typeof rawSelectedCode !== "string") {
    throw validationError("selectedCode must be a string", "selectedCode");
  }
  const selectedCode = rawSelectedCode.trim();
  // 空文字は「選択の取り消し」を意味する。
  if (selectedCode && !/^[0-9A-Za-z]{1,20}$/u.test(selectedCode)) {
    throw validationError("selectedCode must be an alphanumeric master code", "selectedCode");
  }

  return {
    contractVersion,
    selectedCode,
    expectedSourceRevision: requiredPositiveInteger(
      input.expectedSourceRevision ?? input.expected_source_revision,
      "expectedSourceRevision"
    ),
    expectedCalculationRevision: requiredPositiveInteger(
      input.expectedCalculationRevision ?? input.expected_calculation_revision,
      "expectedCalculationRevision"
    ),
    expectedSelectionVersion: requiredNonNegativeInteger(
      input.expectedSelectionVersion ?? input.expected_selection_version,
      "expectedSelectionVersion"
    ),
    candidateFingerprint
  };
}

export function validateSidecarPatientChargeSettingInput(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("request body must be an object", "body");
  }
  const contractVersion = boundedRequiredString(
    input.contractVersion ?? input.contract_version,
    "contractVersion",
    16
  );
  if (!sidecarContractVersions.includes(contractVersion)) {
    throw validationError(
      `contractVersion must be one of: ${sidecarContractVersions.join(", ")}`,
      "contractVersion"
    );
  }
  const chargeType = optionalEnum(
    input.chargeType ?? input.charge_type ?? "home_medical_transport",
    patientChargeTypes,
    "chargeType"
  );
  const clear = hasOwn(input, "clear")
    ? strictBoolean(input.clear, "clear")
    : false;
  const hasHandling = hasOwn(input, "handling")
    || hasOwn(input, "billingHandling")
    || hasOwn(input, "billing_handling");
  if (clear && hasHandling) {
    throw validationError("handling must be omitted when clear is true", "handling");
  }
  const handling = optionalEnum(
    input.handling ?? input.billingHandling ?? input.billing_handling,
    patientChargeHandlings,
    "handling"
  );
  if (!clear && !handling) {
    throw validationError("handling is required", "handling");
  }
  const suppliedAmountYen = input.amountYen ?? input.amount_yen;
  const amountYen = nullablePositiveInteger(suppliedAmountYen, "amountYen");
  let amountMode = optionalEnum(
    input.amountMode ?? input.amount_mode,
    patientChargeAmountModes,
    "amountMode"
  );
  if (handling === "charge") {
    amountMode ||= amountYen === null ? "actual" : "fixed";
    if (amountMode === "fixed" && amountYen === null) {
      throw validationError("amountYen is required when amountMode is fixed", "amountYen");
    }
    if (amountMode === "actual" && amountYen !== null) {
      throw validationError("amountYen must be omitted when amountMode is actual", "amountYen");
    }
  } else if (amountMode || amountYen !== null) {
    throw validationError("amount fields are only valid when handling is charge", "amountMode");
  }

  const effectiveFrom = optionalDate(
    input.effectiveFrom ?? input.effective_from,
    "effectiveFrom"
  );
  const rawEffectiveTo = input.effectiveTo ?? input.effective_to;
  const effectiveTo = rawEffectiveTo === null || rawEffectiveTo === undefined || rawEffectiveTo === ""
    ? null
    : optionalDate(rawEffectiveTo, "effectiveTo");
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    throw validationError("effectiveTo must not be before effectiveFrom", "effectiveTo");
  }

  return compactObject({
    contractVersion,
    chargeType,
    clear: clear ? true : undefined,
    handling: clear ? null : handling,
    amountMode: handling === "charge" ? amountMode : null,
    amountYen: handling === "charge" ? amountYen : null,
    effectiveFrom,
    effectiveTo,
    expectedRevision: requiredNonNegativeInteger(
      input.expectedRevision ?? input.expected_revision,
      "expectedRevision"
    ),
    expectedSourceRevision: requiredPositiveInteger(
      input.expectedSourceRevision ?? input.expected_source_revision,
      "expectedSourceRevision"
    ),
    expectedCalculationRevision: requiredPositiveInteger(
      input.expectedCalculationRevision ?? input.expected_calculation_revision,
      "expectedCalculationRevision"
    )
  });
}

function validateSidecarExtractionProof(value, expected) {
  if (!isPlainObject(value)) {
    throw validationError("extractionProof is required", "extractionProof");
  }
  const proof = {
    patientIdBefore: boundedRequiredString(value.patientIdBefore ?? value.patient_id_before, "extractionProof.patientIdBefore", 256),
    patientIdAfter: boundedRequiredString(value.patientIdAfter ?? value.patient_id_after, "extractionProof.patientIdAfter", 256),
    sourceRecordIdBefore: boundedRequiredString(value.sourceRecordIdBefore ?? value.source_record_id_before, "extractionProof.sourceRecordIdBefore", 256),
    sourceRecordIdAfter: boundedRequiredString(value.sourceRecordIdAfter ?? value.source_record_id_after, "extractionProof.sourceRecordIdAfter", 256),
    selectorContractVersion: boundedRequiredString(value.selectorContractVersion ?? value.selector_contract_version, "extractionProof.selectorContractVersion", 128),
    extractedAt: requiredIsoTimestamp(value.extractedAt ?? value.extracted_at, "extractionProof.extractedAt"),
    domMutationDetected: value.domMutationDetected ?? value.dom_mutation_detected,
    contractValidationPassed: value.contractValidationPassed ?? value.contract_validation_passed,
    previewMatched: value.previewMatched ?? value.preview_matched,
    requiredElementCount: optionalPositiveInteger(
      value.requiredElementCount ?? value.required_element_count,
      "extractionProof.requiredElementCount"
    ),
    matchedRequiredElementCount: optionalPositiveInteger(
      value.matchedRequiredElementCount ?? value.matched_required_element_count,
      "extractionProof.matchedRequiredElementCount"
    ),
    clinicalTextNodeCount: optionalPositiveInteger(
      value.clinicalTextNodeCount ?? value.clinical_text_node_count,
      "extractionProof.clinicalTextNodeCount"
    ),
    surfaceProofs: validateSidecarSurfaceProofs(
      value.surfaceProofs ?? value.surface_proofs,
      expected
    )
  };
  if (proof.domMutationDetected !== false) {
    throw validationError("DOM changed during extraction", "extractionProof.domMutationDetected");
  }
  if (
    proof.patientIdBefore !== expected.externalPatientId
    || proof.patientIdAfter !== expected.externalPatientId
    || proof.sourceRecordIdBefore !== expected.sourceRecordId
    || proof.sourceRecordIdAfter !== expected.sourceRecordId
  ) {
    throw validationError("patient or source record changed during extraction", "extractionProof");
  }
  if (proof.contractValidationPassed !== true) {
    throw validationError("selector contract validation failed", "extractionProof.contractValidationPassed");
  }
  if (proof.previewMatched !== true) {
    throw validationError("preview and payload identity do not match", "extractionProof.previewMatched");
  }
  if (
    !proof.requiredElementCount
    || proof.matchedRequiredElementCount !== proof.requiredElementCount
    || !proof.clinicalTextNodeCount
  ) {
    throw validationError("required chart elements are missing", "extractionProof");
  }
  return proof;
}

function validateSidecarSourceSurfaces(value, expected) {
  const enhancedSelectionSurfaces = ["homis-mock-v6", "homis-mock-v7"]
    .includes(expected.selectorContractVersion);
  const required = ["homis-mock-v4", "homis-mock-v5", "homis-mock-v6", "homis-mock-v7"]
    .includes(expected.selectorContractVersion);
  if (value === undefined || value === null) {
    if (required) {
      throw validationError(
        `sourceSurfaces is required for ${expected.selectorContractVersion}`,
        "sourceSurfaces"
      );
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw validationError("sourceSurfaces must be an object", "sourceSurfaces");
  }
  const currentChart = validateSidecarSourceSurface(value.currentChart ?? value.current_chart, {
    name: "currentChart",
    externalPatientId: expected.externalPatientId,
    allowUnavailable: false
  });
  const documents = validateSidecarSourceSurface(value.documents, {
    name: "documents",
    externalPatientId: expected.externalPatientId,
    allowUnavailable: true
  });
  const problems = enhancedSelectionSurfaces
    ? validateSidecarSourceSurface(value.problems, {
      name: "problems",
      externalPatientId: expected.externalPatientId,
      allowUnavailable: true
    })
    : undefined;
  const visitPlan = enhancedSelectionSurfaces
    ? validateSidecarSourceSurface(value.visitPlan ?? value.visit_plan, {
      name: "visitPlan",
      externalPatientId: expected.externalPatientId,
      sourceRecordId: expected.sourceRecordId,
      selectorContractVersion: expected.selectorContractVersion,
      allowUnavailable: true
    })
    : undefined;
  if (required && (!currentChart || !documents)) {
    throw validationError(
      `currentChart and documents source surfaces are required for ${expected.selectorContractVersion}`,
      "sourceSurfaces"
    );
  }
  if (enhancedSelectionSurfaces && (!problems || !visitPlan)) {
    throw validationError(
      `problems and visitPlan source surfaces are required for ${expected.selectorContractVersion}`,
      "sourceSurfaces"
    );
  }
  return compactObject({ currentChart, documents, problems, visitPlan });
}

function validateSidecarSourceSurface(value, options) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const field = `sourceSurfaces.${options.name}`;
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  const status = optionalEnum(value.status, sidecarSourceSurfaceStatuses, `${field}.status`);
  if (!status) {
    throw validationError(`${field}.status is required`, `${field}.status`);
  }
  if (status === "unavailable" && options.allowUnavailable !== true) {
    throw validationError(`${field} cannot be unavailable`, `${field}.status`);
  }
  const patientId = boundedRequiredString(
    value.patientId ?? value.patient_id,
    `${field}.patientId`,
    256
  );
  if (patientId !== options.externalPatientId) {
    throw validationError(`${field} patient does not match the displayed chart`, `${field}.patientId`);
  }
  const observedAt = requiredIsoTimestamp(
    value.observedAt ?? value.observed_at,
    `${field}.observedAt`
  );
  const surfaceHash = validateSidecarSurfaceHash(
    value.surfaceHash ?? value.surface_hash,
    `${field}.surfaceHash`
  );
  if (status === "unavailable") {
    return {
      status,
      patientId,
      observedAt,
      surfaceHash,
      unavailableReason: optionalEnum(
        value.unavailableReason ?? value.unavailable_reason,
        sidecarSourceSurfaceUnavailableReasons,
        `${field}.unavailableReason`
      ) || "fetch_failed"
    };
  }
  return {
    status,
    patientId,
    observedAt,
    surfaceHash,
    raw: validateSidecarSourceSurfaceRaw(options.name, value.raw, `${field}.raw`, options)
  };
}

function validateSidecarSourceSurfaceRaw(name, value, field, options = {}) {
  if (name === "currentChart") return validateSidecarCurrentChartRaw(value, field);
  if (name === "documents") return validateSidecarDocumentsRaw(value, field);
  if (name === "problems") return validateSidecarProblemsRaw(value, field);
  if (name === "visitPlan") return validateSidecarVisitPlanRaw(value, field, options);
  throw validationError(`unsupported source surface: ${name}`, field);
}

function validateSidecarCurrentChartRaw(value, field) {
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  return {
    careInsuranceText: multilineStringValue(value.careInsuranceText ?? value.care_insurance_text, 10_000),
    visitingNurseText: multilineStringValue(value.visitingNurseText ?? value.visiting_nurse_text, 10_000),
    deviceManagementText: multilineStringValue(value.deviceManagementText ?? value.device_management_text, 20_000),
    deviceManagementListCompleteness: optionalEnum(
      value.deviceManagementListCompleteness ?? value.device_management_list_completeness,
      sidecarSourceListCompletenessValues,
      `${field}.deviceManagementListCompleteness`
    ) || "unknown",
    prescriptionRows: boundedTextArray(
      value.prescriptionRows ?? value.prescription_rows,
      `${field}.prescriptionRows`,
      { maxItems: 256, maxLength: 2_000 }
    ),
    patientStartDate: optionalDate(
      value.patientStartDate ?? value.patient_start_date,
      `${field}.patientStartDate`
    ) || null,
    calendarMonth: optionalClaimMonth(value.calendarMonth ?? value.calendar_month) || null,
    calendarVisitDates: boundedDateArray(
      value.calendarVisitDates ?? value.calendar_visit_dates,
      `${field}.calendarVisitDates`,
      62
    ),
    calendarVisitListCompleteness: optionalEnum(
      value.calendarVisitListCompleteness ?? value.calendar_visit_list_completeness,
      sidecarSourceListCompletenessValues,
      `${field}.calendarVisitListCompleteness`
    ) || "unknown"
  };
}

function validateSidecarProblemsRaw(value, field) {
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  const rows = boundedObjectRows(value.rows, `${field}.rows`, 500);
  return {
    listCompleteness: optionalEnum(
      value.listCompleteness ?? value.list_completeness,
      sidecarSourceListCompletenessValues,
      `${field}.listCompleteness`
    ) || "unknown",
    rows: rows.map((row, index) => {
      const rowField = `${field}.rows[${index}]`;
      return {
        name: boundedRequiredString(row.name, `${rowField}.name`, 2_000),
        main: strictBoolean(row.main, `${rowField}.main`),
        startDate: optionalDate(row.startDate ?? row.start_date, `${rowField}.startDate`) || null,
        outcome: multilineStringValue(row.outcome, 256),
        suspected: strictBoolean(row.suspected, `${rowField}.suspected`)
      };
    })
  };
}

function validateSidecarVisitPlanRaw(value, field, options = {}) {
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  const rows = boundedObjectRows(value.rows, `${field}.rows`, 100);
  const basis = optionalEnum(
    value.basis,
    ["encounter_history", "schedule_only", "unknown"],
    `${field}.basis`
  ) || "unknown";
  const collectionMethod = optionalEnum(
    value.collectionMethod ?? value.collection_method,
    ["chart_navigation"],
    `${field}.collectionMethod`
  ) || null;
  const traversalComplete = hasOwn(value, "traversalComplete") || hasOwn(value, "traversal_complete")
    ? strictBoolean(
      value.traversalComplete ?? value.traversal_complete,
      `${field}.traversalComplete`
    )
    : null;
  const calendarReconciled = hasOwn(value, "calendarReconciled") || hasOwn(value, "calendar_reconciled")
    ? strictBoolean(
      value.calendarReconciled ?? value.calendar_reconciled,
      `${field}.calendarReconciled`
    )
    : null;
  const originalSourceRecordId = optionalBoundedSourceRecordId(
    value.originalSourceRecordId ?? value.original_source_record_id,
    `${field}.originalSourceRecordId`
  );
  const restoredSourceRecordId = optionalBoundedSourceRecordId(
    value.restoredSourceRecordId ?? value.restored_source_record_id,
    `${field}.restoredSourceRecordId`
  );
  if (collectionMethod === "chart_navigation") {
    if (
      traversalComplete === null
      || calendarReconciled === null
      || !originalSourceRecordId
      || !restoredSourceRecordId
    ) {
      throw validationError(
        `${field} chart_navigation integrity fields are required`,
        field
      );
    }
    if (
      options.selectorContractVersion === "homis-mock-v7"
      && options.sourceRecordId
      && (
        originalSourceRecordId !== options.sourceRecordId
        || restoredSourceRecordId !== options.sourceRecordId
      )
    ) {
      throw validationError(
        `${field} chart_navigation did not restore the displayed chart`,
        `${field}.restoredSourceRecordId`
      );
    }
  }
  const normalized = {
    calendarMonth: optionalClaimMonth(value.calendarMonth ?? value.calendar_month) || null,
    category: multilineStringValue(value.category, 256),
    patternText: multilineStringValue(value.patternText ?? value.pattern_text, 2_000),
    basis,
    listCompleteness: optionalEnum(
      value.listCompleteness ?? value.list_completeness,
      sidecarSourceListCompletenessValues,
      `${field}.listCompleteness`
    ) || "unknown",
    rows: rows.map((row, index) => {
      const rowField = `${field}.rows[${index}]`;
      const encounterType = optionalEnum(
        row.encounterType ?? row.encounter_type,
        ["home_visit", "house_call", "outpatient"],
        `${rowField}.encounterType`
      );
      const status = optionalEnum(
        row.status,
        ["planned", "completed", "cancelled"],
        `${rowField}.status`
      );
      if (!encounterType || !status) {
        throw validationError(
          `${rowField}.encounterType and status are required`,
          rowField
        );
      }
      const rawSourceRecordId = row.sourceRecordId ?? row.source_record_id;
      const sourceRecordId = basis === "encounter_history"
        ? boundedRequiredString(rawSourceRecordId, `${rowField}.sourceRecordId`, 512)
        : nullableString(rawSourceRecordId);
      if (sourceRecordId && sourceRecordId.length > 512) {
        throw validationError(
          `${rowField}.sourceRecordId must be 512 characters or less`,
          `${rowField}.sourceRecordId`
        );
      }
      return {
        serviceDate: requiredDate(row.serviceDate ?? row.service_date, `${rowField}.serviceDate`),
        encounterType,
        visitKind: optionalEnum(
          row.visitKind ?? row.visit_kind,
          feeVisitKinds,
          `${rowField}.visitKind`
        ) || null,
        status,
        sourceRecordId
      };
    })
  };
  if (collectionMethod) {
    normalized.collectionMethod = collectionMethod;
    normalized.traversalComplete = traversalComplete;
    normalized.calendarReconciled = calendarReconciled;
    normalized.originalSourceRecordId = originalSourceRecordId;
    normalized.restoredSourceRecordId = restoredSourceRecordId;
  }
  return normalized;
}

function optionalBoundedSourceRecordId(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return boundedRequiredString(value, field, 512);
}

function boundedObjectRows(value, field, maxItems) {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`, field);
  }
  if (value.length > maxItems) {
    throw validationError(`${field} must contain ${maxItems} items or less`, field);
  }
  return value.map((row, index) => {
    if (!isPlainObject(row)) {
      throw validationError(`${field}[${index}] must be an object`, `${field}[${index}]`);
    }
    return row;
  });
}

function validateSidecarDocumentsRaw(value, field) {
  if (!isPlainObject(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  const rows = value.rows;
  if (!Array.isArray(rows)) {
    throw validationError(`${field}.rows must be an array`, `${field}.rows`);
  }
  if (rows.length > 200) {
    throw validationError(`${field}.rows must contain 200 items or less`, `${field}.rows`);
  }
  return {
    rows: rows.map((row, index) => {
      const rowField = `${field}.rows[${index}]`;
      if (!isPlainObject(row)) {
        throw validationError(`${rowField} must be an object`, rowField);
      }
      return {
        kind: multilineStringValue(row.kind, 2_000),
        period: multilineStringValue(row.period, 2_000),
        writtenDate: multilineStringValue(row.writtenDate ?? row.written_date, 256),
        status: multilineStringValue(row.status, 256)
      };
    })
  };
}

function validateSidecarSurfaceProofs(value, expected) {
  const required = expected.sourceSurfaces !== undefined;
  if (value === undefined || value === null) {
    if (required) {
      throw validationError("extractionProof.surfaceProofs is required", "extractionProof.surfaceProofs");
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw validationError(
      "extractionProof.surfaceProofs must be an object",
      "extractionProof.surfaceProofs"
    );
  }
  const result = {};
  for (const name of sidecarSourceSurfaceNames) {
    const source = expected.sourceSurfaces?.[name];
    const proof = value[name];
    if (!source && !proof) {
      continue;
    }
    if (!source || !isPlainObject(proof)) {
      throw validationError(
        `extractionProof.surfaceProofs.${name} does not match sourceSurfaces`,
        `extractionProof.surfaceProofs.${name}`
      );
    }
    const normalized = {
      status: optionalEnum(
        proof.status,
        sidecarSourceSurfaceStatuses,
        `extractionProof.surfaceProofs.${name}.status`
      ),
      patientId: boundedRequiredString(
        proof.patientId ?? proof.patient_id,
        `extractionProof.surfaceProofs.${name}.patientId`,
        256
      ),
      observedAt: requiredIsoTimestamp(
        proof.observedAt ?? proof.observed_at,
        `extractionProof.surfaceProofs.${name}.observedAt`
      ),
      surfaceHash: validateSidecarSurfaceHash(
        proof.surfaceHash ?? proof.surface_hash,
        `extractionProof.surfaceProofs.${name}.surfaceHash`
      )
    };
    if (
      normalized.status !== source.status
      || normalized.patientId !== source.patientId
      || normalized.observedAt !== source.observedAt
      || normalized.surfaceHash !== source.surfaceHash
    ) {
      throw validationError(
        `extractionProof.surfaceProofs.${name} does not match sourceSurfaces`,
        `extractionProof.surfaceProofs.${name}`
      );
    }
    result[name] = normalized;
  }
  return result;
}

function validateSidecarSurfaceHash(value, field) {
  const normalized = boundedRequiredString(value, field, 128);
  if (!/^(?:sha256-[A-Za-z0-9_-]{43}|fnv1a64-[0-9a-f]{16})$/u.test(normalized)) {
    throw validationError(`${field} is invalid`, field);
  }
  return normalized;
}

function boundedTextArray(value, field, options) {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`, field);
  }
  if (value.length > options.maxItems) {
    throw validationError(`${field} must contain ${options.maxItems} items or less`, field);
  }
  return value.map((item, index) => multilineStringValue(
    item,
    options.maxLength,
    `${field}[${index}]`
  ));
}

function boundedDateArray(value, field, maxItems) {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`, field);
  }
  if (value.length > maxItems) {
    throw validationError(`${field} must contain ${maxItems} items or less`, field);
  }
  return value.map((item, index) => requiredDate(item, `${field}[${index}]`));
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
    encounterDetails: hasOwn(input, "encounterDetails") || hasOwn(input, "encounter_details")
      ? normalizeFeeEncounterDetails(input.encounterDetails ?? input.encounter_details)
      : undefined,
    receptionTime: hasOwn(input, "receptionTime") || hasOwn(input, "reception_time")
      ? optionalReceptionTime(input.receptionTime ?? input.reception_time)
      : undefined,
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

// 受付時刻(HH:MM)。時間外・休日・深夜加算の判定材料。
// null は「クリア」の明示(update時にキーを残して保存値を消す)。
function optionalReceptionTime(value) {
  if (value === null) {
    return null;
  }
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(text)) {
    throw validationError("receptionTime must use HH:MM", "receptionTime");
  }
  return text;
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
    standingFactsPolicy: {
      stalenessMonths: 3
    },
    pricingPolicy: {
      mode: "service_date"
    },
    careFeeIntegration: {
      enabled: false,
      facilityCode: "",
      careOfficeNumber: "",
      careServiceType: "",
      signalPolicy: "conservative"
    },
    sidecarPatientAutoProvision: false,
    facilityStandardsConfirmed: false,
    facilityStandards: [],
    facilityServiceSchedules: [],
    autoBillingRules: [],
    receiptPolicy: {
      ukeEncoding: "shift_jis",
      blockExportOnErrors: true,
      connectorSpecVerified: false,
      defaultReceiptScope: "service_date",
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
  const currentStandingFactsPolicy = isPlainObject(current.standingFactsPolicy ?? current.standing_facts_policy)
    ? (current.standingFactsPolicy ?? current.standing_facts_policy)
    : {};
  const currentPricingPolicy = isPlainObject(current.pricingPolicy ?? current.pricing_policy)
    ? (current.pricingPolicy ?? current.pricing_policy)
    : {};
  const inputHistoryPolicy = isPlainObject(input.historyPolicy ?? input.history_policy) ? (input.historyPolicy ?? input.history_policy) : {};
  const inputInitialRevisitPolicy = isPlainObject(input.initialRevisitPolicy ?? input.initial_revisit_policy)
    ? (input.initialRevisitPolicy ?? input.initial_revisit_policy)
    : {};
  const inputReceiptPolicy = isPlainObject(input.receiptPolicy ?? input.receipt_policy) ? (input.receiptPolicy ?? input.receipt_policy) : {};
  const inputStandingFactsPolicy = isPlainObject(input.standingFactsPolicy ?? input.standing_facts_policy)
    ? (input.standingFactsPolicy ?? input.standing_facts_policy)
    : {};
  const inputPricingPolicy = isPlainObject(input.pricingPolicy ?? input.pricing_policy)
    ? (input.pricingPolicy ?? input.pricing_policy)
    : {};
  const currentCareFeeIntegration = isPlainObject(current.careFeeIntegration ?? current.care_fee_integration)
    ? (current.careFeeIntegration ?? current.care_fee_integration)
    : {};
  const inputCareFeeIntegration = isPlainObject(input.careFeeIntegration ?? input.care_fee_integration)
    ? (input.careFeeIntegration ?? input.care_fee_integration)
    : {};
  const base = defaultFeeSettings({
    facilityId: input.facilityId ?? input.facility_id ?? current.facilityId ?? current.facility_id,
    effectiveFrom: input.effectiveFrom ?? input.effective_from ?? current.effectiveFrom ?? current.effective_from
  });
  const baseHistoryPolicy = { ...base.historyPolicy, ...currentHistoryPolicy, ...inputHistoryPolicy };
  const baseInitialRevisitPolicy = { ...base.initialRevisitPolicy, ...currentInitialRevisitPolicy, ...inputInitialRevisitPolicy };
  const baseStandingFactsPolicy = {
    ...base.standingFactsPolicy,
    ...currentStandingFactsPolicy,
    ...inputStandingFactsPolicy
  };
  const basePricingPolicy = {
    ...base.pricingPolicy,
    ...currentPricingPolicy,
    ...inputPricingPolicy
  };
  const baseReceiptPolicy = mergeReceiptPolicy(base.receiptPolicy, currentReceiptPolicy, inputReceiptPolicy);
  const baseCareFeeIntegration = {
    ...base.careFeeIntegration,
    ...currentCareFeeIntegration,
    ...inputCareFeeIntegration
  };
  const facilityStandardsInput = hasOwn(input, "facilityStandards") || hasOwn(input, "facility_standards")
    ? (input.facilityStandards ?? input.facility_standards)
    : (current.facilityStandards ?? current.facility_standards);
  const autoBillingRulesInput = hasOwn(input, "autoBillingRules") || hasOwn(input, "auto_billing_rules")
    ? (input.autoBillingRules ?? input.auto_billing_rules)
    : (current.autoBillingRules ?? current.auto_billing_rules);
  const facilityServiceSchedulesInput = hasOwn(input, "facilityServiceSchedules")
    || hasOwn(input, "facility_service_schedules")
    ? (input.facilityServiceSchedules ?? input.facility_service_schedules)
    : (current.facilityServiceSchedules ?? current.facility_service_schedules);
  const facilityStandards = normalizeFacilityStandards(facilityStandardsInput);
  validateExclusiveFacilityStandards(facilityStandards);
  const facilityServiceSchedules = normalizeFacilityServiceSchedules(
    facilityServiceSchedulesInput
  );
  validateNonOverlappingFacilityServiceSchedules(facilityServiceSchedules);
  const sidecarPatientAutoProvisionInput = hasOwn(input, "sidecarPatientAutoProvision")
    || hasOwn(input, "sidecar_patient_auto_provision")
    ? (input.sidecarPatientAutoProvision ?? input.sidecar_patient_auto_provision)
    : (
        hasOwn(current, "sidecarPatientAutoProvision")
        || hasOwn(current, "sidecar_patient_auto_provision")
          ? (current.sidecarPatientAutoProvision ?? current.sidecar_patient_auto_provision)
          : base.sidecarPatientAutoProvision
      );
  const facilityStandardsConfirmedInput = hasOwn(input, "facilityStandardsConfirmed")
    || hasOwn(input, "facility_standards_confirmed")
    ? (input.facilityStandardsConfirmed ?? input.facility_standards_confirmed)
    : (
        hasOwn(current, "facilityStandardsConfirmed")
        || hasOwn(current, "facility_standards_confirmed")
          ? (current.facilityStandardsConfirmed ?? current.facility_standards_confirmed)
          : base.facilityStandardsConfirmed
      );
  return {
    facilityId: optionalString(input.facilityId ?? input.facility_id ?? current.facilityId ?? current.facility_id) || base.facilityId,
    effectiveFrom: optionalDate(input.effectiveFrom ?? input.effective_from ?? current.effectiveFrom ?? current.effective_from, "effectiveFrom") || base.effectiveFrom,
    historyPolicy: normalizeHistoryPolicy(baseHistoryPolicy),
    initialRevisitPolicy: normalizeInitialRevisitPolicy(baseInitialRevisitPolicy),
    standingFactsPolicy: normalizeStandingFactsPolicy(baseStandingFactsPolicy),
    pricingPolicy: normalizePricingPolicy(basePricingPolicy),
    careFeeIntegration: normalizeCareFeeIntegration(baseCareFeeIntegration),
    sidecarPatientAutoProvision: strictBoolean(
      sidecarPatientAutoProvisionInput,
      "sidecarPatientAutoProvision"
    ),
    facilityStandardsConfirmed: strictBoolean(
      facilityStandardsConfirmedInput,
      "facilityStandardsConfirmed"
    ),
    facilityStandards,
    facilityServiceSchedules,
    autoBillingRules: normalizeAutoBillingRules(autoBillingRulesInput),
    receiptPolicy: normalizeReceiptPolicy(baseReceiptPolicy)
  };
}

function normalizeCareFeeIntegration(input = {}) {
  const enabled = strictBoolean(input.enabled ?? false, "careFeeIntegration.enabled");
  const facilityCode = optionalString(input.facilityCode ?? input.facility_code);
  const careOfficeNumber = optionalString(input.careOfficeNumber ?? input.care_office_number);
  const careServiceType = optionalString(input.careServiceType ?? input.care_service_type);
  const signalPolicy = optionalEnum(
    input.signalPolicy ?? input.signal_policy,
    ["conservative", "explicit_only"],
    "careFeeIntegration.signalPolicy"
  ) || "conservative";
  if (enabled && !facilityCode) {
    throw validationError("careFeeIntegration.facilityCode is required when enabled", "careFeeIntegration.facilityCode");
  }
  if (enabled && !careFeeIntegrationServiceTypes.includes(careServiceType)) {
    throw validationError("careFeeIntegration.careServiceType is required when enabled", "careFeeIntegration.careServiceType");
  }
  return {
    enabled,
    facilityCode,
    careOfficeNumber,
    careServiceType,
    signalPolicy
  };
}

function normalizeFacilityServiceSchedules(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw validationError(
        "facilityServiceSchedules entries must be objects",
        "facilityServiceSchedules"
      );
    }
    const scheduleId = optionalString(entry.scheduleId ?? entry.schedule_id)
      || `facility_schedule_${index + 1}`;
    const effectiveFrom = optionalDate(
      entry.effectiveFrom ?? entry.effective_from,
      "facilityServiceSchedules.effectiveFrom"
    );
    const effectiveTo = optionalDate(
      entry.effectiveTo ?? entry.effective_to,
      "facilityServiceSchedules.effectiveTo"
    ) || "";
    if (!effectiveFrom) {
      throw validationError(
        "facilityServiceSchedules.effectiveFrom is required",
        "facilityServiceSchedules.effectiveFrom"
      );
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw validationError(
        "facilityServiceSchedules.effectiveTo must be on or after effectiveFrom",
        "facilityServiceSchedules.effectiveTo"
      );
    }
    const timezone = optionalString(entry.timezone) || "Asia/Tokyo";
    if (timezone !== "Asia/Tokyo") {
      throw validationError(
        "facilityServiceSchedules.timezone must be Asia/Tokyo",
        "facilityServiceSchedules.timezone"
      );
    }
    const weeklyHours = normalizeFacilityWeeklyHours(
      entry.weeklyHours ?? entry.weekly_hours
    );
    if (!Object.values(weeklyHours).some((windows) => windows.length > 0)) {
      throw validationError(
        "facilityServiceSchedules.weeklyHours must contain at least one opening window",
        "facilityServiceSchedules.weeklyHours"
      );
    }
    const holidayDates = normalizeUniqueDates(
      entry.holidayDates ?? entry.holiday_dates,
      "facilityServiceSchedules.holidayDates"
    );
    const specialHours = normalizeFacilitySpecialHours(
      entry.specialHours ?? entry.special_hours
    );
    const duplicateOverride = specialHours.find((override) => (
      holidayDates.includes(override.date)
    ));
    if (duplicateOverride) {
      throw validationError(
        `facilityServiceSchedules date cannot be both a holiday and special opening: ${duplicateOverride.date}`,
        "facilityServiceSchedules.specialHours"
      );
    }
    return {
      scheduleId,
      effectiveFrom,
      effectiveTo,
      timezone,
      weeklyHours,
      holidayDates,
      specialHours,
      status: optionalEnum(
        entry.status,
        feeFacilityStandardStatuses,
        "facilityServiceSchedules.status"
      ) || "active"
    };
  });
}

function normalizeFacilityWeeklyHours(input) {
  if (!isPlainObject(input)) {
    throw validationError(
      "facilityServiceSchedules.weeklyHours must be an object",
      "facilityServiceSchedules.weeklyHours"
    );
  }
  return Object.fromEntries(
    FACILITY_SERVICE_SCHEDULE_WEEKDAYS.map((weekday) => [
      weekday,
      normalizeFacilityTimeWindows(
        input[weekday],
        `facilityServiceSchedules.weeklyHours.${weekday}`
      )
    ])
  );
}

function normalizeFacilitySpecialHours(input) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw validationError(
      "facilityServiceSchedules.specialHours must be an array",
      "facilityServiceSchedules.specialHours"
    );
  }
  const dates = new Set();
  return input.map((entry) => {
    if (!isPlainObject(entry)) {
      throw validationError(
        "facilityServiceSchedules.specialHours entries must be objects",
        "facilityServiceSchedules.specialHours"
      );
    }
    const date = optionalDate(
      entry.date,
      "facilityServiceSchedules.specialHours.date"
    );
    if (!date) {
      throw validationError(
        "facilityServiceSchedules.specialHours.date is required",
        "facilityServiceSchedules.specialHours.date"
      );
    }
    if (dates.has(date)) {
      throw validationError(
        `duplicate facilityServiceSchedules special date: ${date}`,
        "facilityServiceSchedules.specialHours"
      );
    }
    dates.add(date);
    const hours = normalizeFacilityTimeWindows(
      entry.hours,
      "facilityServiceSchedules.specialHours.hours"
    );
    if (!hours.length) {
      throw validationError(
        "facilityServiceSchedules.specialHours.hours must not be empty",
        "facilityServiceSchedules.specialHours.hours"
      );
    }
    return { date, hours };
  }).sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeFacilityTimeWindows(input, field) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw validationError(`${field} must be an array`, field);
  }
  const windows = input.map((entry) => {
    if (!isPlainObject(entry)) {
      throw validationError(`${field} entries must be objects`, field);
    }
    const start = normalizeFacilityTime(entry.start, `${field}.start`);
    const end = normalizeFacilityTime(entry.end, `${field}.end`);
    if (start >= end) {
      throw validationError(`${field} start must be before end`, field);
    }
    return { start, end };
  }).sort((left, right) => left.start.localeCompare(right.start));
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].start < windows[index - 1].end) {
      throw validationError(`${field} windows must not overlap`, field);
    }
  }
  return windows;
}

function normalizeFacilityTime(value, field) {
  const text = optionalString(value);
  if (!text || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(text)) {
    throw validationError(`${field} must use HH:MM`, field);
  }
  return text;
}

function normalizeUniqueDates(input, field) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw validationError(`${field} must be an array`, field);
  }
  return [...new Set(input.map((value) => {
    const date = optionalDate(value, field);
    if (!date) {
      throw validationError(`${field} must contain YYYY-MM-DD values`, field);
    }
    return date;
  }))].sort();
}

function validateNonOverlappingFacilityServiceSchedules(schedules) {
  const active = schedules
    .filter((schedule) => schedule.status === "active")
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const current = active[index];
    if (!previous.effectiveTo || current.effectiveFrom <= previous.effectiveTo) {
      throw validationError(
        `active facilityServiceSchedules effective periods overlap: ${previous.scheduleId} / ${current.scheduleId}`,
        "facilityServiceSchedules"
      );
    }
  }
}

function normalizeStandingFactsPolicy(input = {}) {
  const parsed = Number.parseInt(
    input.stalenessMonths ?? input.staleness_months,
    10
  );
  return {
    stalenessMonths: Math.min(6, Math.max(1, Number.isFinite(parsed) ? parsed : 3))
  };
}

// 施設ごとの恒常算定ルール: 「この施設では条件を満たす受診に必ずXを算定/候補提示する」。
// 項目追加を「実装」でなく「設定」にするためのデータ。コードはエンジンがマスタ照合するため
// 点数はここに持たない(candidate表示用のpotentialPointsのみ任意)。
function normalizeAutoBillingRules(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry, index) => {
      const value = isPlainObject(entry) ? entry : {};
      const code = optionalString(value.code ?? value.procedureCode ?? value.procedure_code) || "";
      const settings = Array.isArray(value.settings)
        ? value.settings.map((item) => optionalEnum(item, feeSettings, "autoBillingRules.settings")).filter(Boolean)
        : [];
      return {
        ruleId: optionalString(value.ruleId ?? value.rule_id) || `facility_rule_${index + 1}`,
        title: optionalString(value.title ?? value.name) || "",
        code,
        sameBuildingCode: optionalString(value.sameBuildingCode ?? value.same_building_code) || "",
        sameBuildingTitle: optionalString(value.sameBuildingTitle ?? value.same_building_title) || "",
        action: optionalEnum(value.action, feeAutoBillingRuleActions, "autoBillingRules.action") || "candidate",
        billingRole: optionalEnum(
          value.billingRole ?? value.billing_role,
          feeAutoBillingRuleRoles,
          "autoBillingRules.billingRole"
        ) || "standard",
        settings,
        requiredFacilityStandardKey: optionalString(value.requiredFacilityStandardKey ?? value.required_facility_standard_key) || "",
        potentialPoints: Number(value.potentialPoints ?? value.potential_points ?? 0) || 0,
        note: optionalString(value.note) || "",
        status: optionalEnum(value.status, feeFacilityStandardStatuses, "autoBillingRules.status") || "active"
      };
    })
    .filter((entry) => entry.code);
}

export function normalizeFeeEncounterDetails(input) {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw validationError("encounterDetails must be an object", "encounterDetails");
  }

  const sameBuilding = nullableBoolean(
    input.sameBuilding ?? input.same_building,
    "encounterDetails.sameBuilding"
  );
  const sameBuildingSource = nullableEnum(
    input.sameBuildingSource ?? input.same_building_source,
    sidecarEncounterTypeSources,
    "encounterDetails.sameBuildingSource"
  );
  const singleBuildingPatientCount = nullablePositiveInteger(
    input.singleBuildingPatientCount ?? input.single_building_patient_count,
    "encounterDetails.singleBuildingPatientCount"
  );
  const residenceType = nullableEnum(
    input.residenceType ?? input.residence_type,
    feeResidenceTypes,
    "encounterDetails.residenceType"
  );
  const visitKind = nullableEnum(
    input.visitKind ?? input.visit_kind,
    feeVisitKinds,
    "encounterDetails.visitKind"
  );
  const visitKindSource = nullableEnum(
    input.visitKindSource ?? input.visit_kind_source,
    sidecarEncounterTypeSources,
    "encounterDetails.visitKindSource"
  );
  const telephoneEligibility = normalizeTelephoneEligibility(
    input.telephoneEligibility ?? input.telephone_eligibility
  );

  if (sameBuilding !== null && !sameBuildingSource) {
    throw validationError(
      "encounterDetails.sameBuildingSource is required when sameBuilding is known",
      "encounterDetails.sameBuildingSource"
    );
  }
  if (sameBuilding === null && sameBuildingSource !== null) {
    throw validationError(
      "encounterDetails.sameBuildingSource must be null when sameBuilding is unknown",
      "encounterDetails.sameBuildingSource"
    );
  }
  if (
    sameBuildingSource === "dom"
    && sameBuilding === true
    && (singleBuildingPatientCount === null || singleBuildingPatientCount < 2)
  ) {
    throw validationError(
      "encounterDetails.singleBuildingPatientCount must be at least 2 for a DOM-derived same-building decision",
      "encounterDetails.singleBuildingPatientCount"
    );
  }
  if (
    sameBuildingSource === "dom"
    && sameBuilding === false
    && singleBuildingPatientCount !== null
    && singleBuildingPatientCount !== 1
  ) {
    throw validationError(
      "encounterDetails.singleBuildingPatientCount must be 1 for a DOM-derived outside decision",
      "encounterDetails.singleBuildingPatientCount"
    );
  }
  if (visitKind !== null && !visitKindSource) {
    throw validationError(
      "encounterDetails.visitKindSource is required when visitKind is known",
      "encounterDetails.visitKindSource"
    );
  }
  if (visitKind === null && visitKindSource !== null) {
    throw validationError(
      "encounterDetails.visitKindSource must be null when visitKind is unknown",
      "encounterDetails.visitKindSource"
    );
  }
  if (telephoneEligibility !== null && visitKind !== "telephone_revisit") {
    throw validationError(
      "encounterDetails.telephoneEligibility is only valid for telephone_revisit",
      "encounterDetails.telephoneEligibility"
    );
  }

  return {
    sameBuilding,
    sameBuildingSource,
    singleBuildingPatientCount,
    residenceType,
    visitKind,
    visitKindSource,
    telephoneEligibility
  };
}

function normalizeTelephoneEligibility(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!isPlainObject(input)) {
    throw validationError(
      "encounterDetails.telephoneEligibility must be an object",
      "encounterDetails.telephoneEligibility"
    );
  }
  return {
    establishedPatient: nullableBoolean(
      input.establishedPatient ?? input.established_patient,
      "encounterDetails.telephoneEligibility.establishedPatient"
    ),
    patientInitiated: nullableBoolean(
      input.patientInitiated ?? input.patient_initiated,
      "encounterDetails.telephoneEligibility.patientInitiated"
    ),
    instructionGiven: nullableBoolean(
      input.instructionGiven ?? input.instruction_given,
      "encounterDetails.telephoneEligibility.instructionGiven"
    ),
    scheduledManagement: nullableBoolean(
      input.scheduledManagement ?? input.scheduled_management,
      "encounterDetails.telephoneEligibility.scheduledManagement"
    )
  };
}

export function validateReviewDecisionInput(input = {}) {
  const status = optionalEnum(input.status, feeReviewDecisionStatuses, "status") || "approved";
  const rejectReason = optionalEnum(
    input.rejectReason ?? input.reject_reason,
    feeExtractionRejectReasons,
    "rejectReason"
  );
  if (status !== "rejected" && rejectReason) {
    throw validationError("rejectReason is only valid when status is rejected", "rejectReason");
  }
  return compactObject({
    status,
    rejectReason,
    note: optionalMultilineString(input.note, 5000),
    replacementText: optionalMultilineString(input.replacementText ?? input.replacement_text, 20000)
  });
}

export const feeExtractionRejectReasons = Object.freeze([
  "extraction_wrong",
  "duplicate",
  "facility_standard_missing",
  "frequency_limit",
  "clinical_judgment",
  "other"
]);

export const feeMonthlyExclusionResolutions = Object.freeze([
  "auto_winner",
  "demote_lower_points",
  "conditional_review",
  "unsupported_rule_kind"
]);

export const feeMonthlyExclusionActions = Object.freeze([
  "acknowledge_auto",
  "choose_a",
  "choose_b",
  "allow_both_with_basis",
  "reject_both"
]);

export function validateMonthlyExclusionResolutionInput(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("monthly exclusion resolution must be an object", "resolution");
  }
  const revoke = input.revoke === true;
  const action = revoke
    ? undefined
    : optionalEnum(input.action, feeMonthlyExclusionActions, "action");
  if (!revoke && !action) {
    throw validationError("action is required", "action");
  }
  const basisNote = optionalMultilineString(input.basisNote ?? input.basis_note, 5000);
  if (action === "allow_both_with_basis" && !basisNote) {
    throw validationError("basisNote is required for allow_both_with_basis", "basisNote");
  }
  const claimMonth = optionalClaimMonth(input.claimMonth ?? input.claim_month);
  if (!claimMonth) {
    throw validationError("claimMonth is required", "claimMonth");
  }
  return compactObject({
    patientId: requiredString(input.patientId ?? input.patient_id, "patientId"),
    claimMonth,
    pairKey: requiredString(input.pairKey ?? input.pair_key, "pairKey"),
    scopeKey: requiredString(input.scopeKey ?? input.scope_key, "scopeKey"),
    ruleFingerprint: requiredString(
      input.ruleFingerprint ?? input.rule_fingerprint,
      "ruleFingerprint"
    ),
    resolution: optionalEnum(
      input.resolution,
      feeMonthlyExclusionResolutions,
      "resolution"
    ),
    action,
    basisNote,
    expectedUpdatedAt: optionalString(input.expectedUpdatedAt ?? input.expected_updated_at),
    revoke
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

function normalizePricingPolicy(input = {}) {
  const value = isPlainObject(input) ? input : {};
  return {
    mode: optionalEnum(
      value.mode,
      feePricingModes,
      "pricingPolicy.mode"
    ) || "service_date"
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

function validateExclusiveFacilityStandards(facilityStandards) {
  const activeKeys = new Set(
    facilityStandards
      .filter((entry) => entry.status === "active")
      .map((entry) => entry.key)
  );
  if (
    activeKeys.has(MEISAISHO_HAKKO_STANDARD_KEY)
    && activeKeys.has(DENSHITEKI_SHINRYO_JOHO_RENKEI_STANDARD_KEY)
  ) {
    throw validationError(
      "meisaisho_hakko_taisei and denshiteki_shinryo_joho_renkei_taisei cannot both be active",
      "facilityStandards"
    );
  }
  const activeAfterHoursResponseKeys = AFTER_HOURS_RESPONSE_STANDARD_KEYS.filter(
    (key) => activeKeys.has(key)
  );
  if (activeAfterHoursResponseKeys.length > 1) {
    throw validationError(
      `only one after-hours response system standard can be active: ${activeAfterHoursResponseKeys.join(", ")}`,
      "facilityStandards"
    );
  }
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
    defaultReceiptScope: optionalEnum(value.defaultReceiptScope ?? value.default_receipt_scope, feeReceiptScopes, "receiptPolicy.defaultReceiptScope") || "service_date",
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

function strictBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw validationError(`${field} must be a boolean`, field);
  }
  return value;
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

function boundedRequiredString(value, field, maxLength) {
  const normalized = requiredString(value, field);
  if (normalized.length > maxLength) {
    throw validationError(`${field} must be ${maxLength} characters or less`, field);
  }
  return normalized;
}

function requiredIsoTimestamp(value, field) {
  const normalized = requiredString(value, field);
  if (!normalized.includes("T") || !Number.isFinite(Date.parse(normalized))) {
    throw validationError(`${field} must be an ISO timestamp`, field);
  }
  return new Date(normalized).toISOString();
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

function nullableEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return optionalEnum(value, allowed, field) || null;
}

function nullableBoolean(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw validationError(`${field} must be a boolean or null`, field);
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

function requiredPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    throw validationError(`${field} is required`, field);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw validationError(`${field} must be a positive integer`, field);
  }
  return value;
}

function requiredNonNegativeInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    throw validationError(`${field} is required`, field);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative integer`, field);
  }
  return value;
}

function nullablePositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return optionalPositiveInteger(value, field) ?? null;
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
