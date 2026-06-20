export const referralStatuses = Object.freeze([
  "draft",
  "needs_review",
  "ready",
  "document_ready",
  "sent",
  "archived",
  "cancelled"
]);

export const referralDocumentTypes = Object.freeze([
  "clinical_information",
  "specialist_referral",
  "test_request",
  "admission_request",
  "reverse_referral",
  "reply"
]);

export const referralUrgencies = Object.freeze([
  "routine",
  "soon",
  "urgent"
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
    documentType: optionalEnum(input.documentType ?? input.document_type, referralDocumentTypes, "documentType") || "clinical_information",
    urgency: optionalEnum(input.urgency, referralUrgencies, "urgency") || "routine",
    title: optionalString(input.title) || "診療情報提供書",
    purpose: requiredMultilineString(input.purpose, "purpose", 2000),
    clinicalSummary: requiredMultilineString(input.clinicalSummary ?? input.clinical_summary, "clinicalSummary", 20000),
    diagnoses: normalizeTextLines(input.diagnoses, 50, "diagnoses"),
    medications: normalizeTextLines(input.medications, 100, "medications"),
    allergies: normalizeTextLines(input.allergies, 50, "allergies"),
    requestedAction: optionalMultilineString(input.requestedAction ?? input.requested_action, 5000),
    notes: optionalMultilineString(input.notes, 5000),
    referralFormSections: normalizeReferralFormSections(input.referralFormSections ?? input.referral_form_sections),
    sourceEvidenceRefs: normalizeSourceEvidenceRefs(input.sourceEvidenceRefs ?? input.source_evidence_refs),
    sectionEvidence: normalizeSectionEvidence(input.sectionEvidence ?? input.section_evidence),
    attachments: normalizeReferralAttachments(input.attachments),
    sourceImports: normalizeReferralSourceImports(input.sourceImports ?? input.source_imports)
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
    documentType: hasOwn(input, "documentType") || hasOwn(input, "document_type")
      ? optionalEnum(input.documentType ?? input.document_type, referralDocumentTypes, "documentType")
      : undefined,
    urgency: hasOwn(input, "urgency")
      ? optionalEnum(input.urgency, referralUrgencies, "urgency")
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
    referralFormSections: hasOwn(input, "referralFormSections") || hasOwn(input, "referral_form_sections")
      ? normalizeReferralFormSections(input.referralFormSections ?? input.referral_form_sections)
      : undefined,
    sourceEvidenceRefs: hasOwn(input, "sourceEvidenceRefs") || hasOwn(input, "source_evidence_refs")
      ? normalizeSourceEvidenceRefs(input.sourceEvidenceRefs ?? input.source_evidence_refs)
      : undefined,
    sectionEvidence: hasOwn(input, "sectionEvidence") || hasOwn(input, "section_evidence")
      ? normalizeSectionEvidence(input.sectionEvidence ?? input.section_evidence)
      : undefined,
    attachments: hasOwn(input, "attachments") ? normalizeReferralAttachments(input.attachments) : undefined,
    sourceImports: hasOwn(input, "sourceImports") || hasOwn(input, "source_imports")
      ? normalizeReferralSourceImports(input.sourceImports ?? input.source_imports)
      : undefined,
    reviewChecklist: hasOwn(input, "reviewChecklist") || hasOwn(input, "review_checklist")
      ? normalizeReviewChecklist(input.reviewChecklist ?? input.review_checklist)
      : undefined,
    feeLinkage: hasOwn(input, "feeLinkage") || hasOwn(input, "fee_linkage")
      ? validateFeeLinkageInput(input.feeLinkage ?? input.fee_linkage ?? {})
      : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, referralStatuses, "status") : undefined
  });
}

export function validateRenderReferralDocumentInput(input = {}) {
  return compactObject({
    fileName: optionalString(input.fileName ?? input.file_name),
    requestedAt: optionalDateTime(input.requestedAt ?? input.requested_at, "requestedAt")
  });
}

export function validateUpsertRecipientDirectoryInput(input = {}) {
  return compactObject({
    recipientId: optionalString(input.recipientId ?? input.recipient_id),
    institutionName: requiredString(input.institutionName ?? input.institution_name ?? input.displayName ?? input.display_name, "institutionName"),
    departmentName: optionalString(input.departmentName ?? input.department_name),
    doctorName: optionalString(input.doctorName ?? input.doctor_name),
    doctorTitle: optionalString(input.doctorTitle ?? input.doctor_title),
    medicalInstitutionCode: optionalString(input.medicalInstitutionCode ?? input.medical_institution_code),
    postalCode: optionalString(input.postalCode ?? input.postal_code),
    address: optionalString(input.address),
    phone: optionalString(input.phone),
    fax: optionalString(input.fax),
    notes: optionalMultilineString(input.notes, 5000),
    status: optionalEnum(input.status, ["active", "archived"], "status") || "active"
  });
}

export function validateUpsertReferralTemplateInput(input = {}) {
  return compactObject({
    templateId: optionalString(input.templateId ?? input.template_id),
    templateType: optionalEnum(input.templateType ?? input.template_type, referralDocumentTypes, "templateType") || "clinical_information",
    displayName: requiredString(input.displayName ?? input.display_name, "displayName"),
    purposeTemplate: optionalMultilineString(input.purposeTemplate ?? input.purpose_template, 2000),
    clinicalSummaryTemplate: optionalMultilineString(input.clinicalSummaryTemplate ?? input.clinical_summary_template, 20000),
    requestedActionTemplate: optionalMultilineString(input.requestedActionTemplate ?? input.requested_action_template, 5000),
    requiredFields: normalizeStringArray(input.requiredFields ?? input.required_fields),
    status: optionalEnum(input.status, ["active", "archived"], "status") || "active"
  });
}

export function validateReferralImportInput(input = {}) {
  return compactObject({
    sourceProduct: requiredString(input.sourceProduct ?? input.source_product, "sourceProduct"),
    sourceType: requiredString(input.sourceType ?? input.source_type, "sourceType"),
    sourceId: requiredString(input.sourceId ?? input.source_id, "sourceId"),
    sourceSnapshot: input.sourceSnapshot ?? input.source_snapshot ?? {},
    selectedSections: normalizeStringArray(input.selectedSections ?? input.selected_sections),
    idempotencyKey: optionalString(input.idempotencyKey ?? input.idempotency_key),
    importedBy: optionalString(input.importedBy ?? input.imported_by)
  });
}

export function validateDraftAiInput(input = {}) {
  return compactObject({
    sourceText: optionalMultilineString(input.sourceText ?? input.source_text, 50000),
    sourceSnapshot: input.sourceSnapshot ?? input.source_snapshot ?? {},
    documentType: optionalEnum(input.documentType ?? input.document_type, referralDocumentTypes, "documentType"),
    templateId: optionalString(input.templateId ?? input.template_id),
    evidenceRefs: normalizeSourceEvidenceRefs(input.evidenceRefs ?? input.evidence_refs)
  });
}

export function validateReferralAssistantSuggestion(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("suggestion must be an object", "suggestion");
  }

  return compactObject({
    provider: optionalString(input.provider) || "unknown",
    generatedAt: optionalDateTime(input.generatedAt ?? input.generated_at, "generatedAt"),
    model: optionalString(input.model),
    promptVersion: optionalString(input.promptVersion ?? input.prompt_version),
    purpose: optionalMultilineString(input.purpose, 2000),
    clinicalSummary: optionalMultilineString(input.clinicalSummary ?? input.clinical_summary, 20000),
    diagnoses: normalizeTextLines(input.diagnoses, 50, "suggestion.diagnoses"),
    medications: normalizeTextLines(input.medications, 100, "suggestion.medications"),
    allergies: normalizeTextLines(input.allergies, 50, "suggestion.allergies"),
    requestedAction: optionalMultilineString(input.requestedAction ?? input.requested_action, 5000),
    sections: normalizeAssistantSections(input.sections),
    warnings: normalizeStringArray(input.warnings)
  });
}

export function validateReferralAttachmentInput(input = {}) {
  return compactObject({
    attachmentId: optionalString(input.attachmentId ?? input.attachment_id),
    attachmentType: optionalEnum(input.attachmentType ?? input.attachment_type, ["lab_result", "image", "medication", "document", "other"], "attachmentType") || "other",
    displayName: requiredString(input.displayName ?? input.display_name, "displayName"),
    description: optionalMultilineString(input.description, 5000),
    sourceProduct: optionalString(input.sourceProduct ?? input.source_product),
    sourceId: optionalString(input.sourceId ?? input.source_id),
    artifactId: optionalString(input.artifactId ?? input.artifact_id),
    status: optionalEnum(input.status, ["attached", "removed"], "status") || "attached"
  });
}

export function validateReplyLetterInput(input = {}) {
  return compactObject({
    replyId: optionalString(input.replyId ?? input.reply_id),
    receivedAt: optionalDateTime(input.receivedAt ?? input.received_at, "receivedAt"),
    senderInstitution: optionalString(input.senderInstitution ?? input.sender_institution),
    senderDoctor: optionalString(input.senderDoctor ?? input.sender_doctor),
    summary: requiredMultilineString(input.summary, "summary", 20000),
    documentArtifact: input.documentArtifact ?? input.document_artifact
  });
}

export function validateFeeLinkageInput(input = {}) {
  return compactObject({
    feeSessionId: optionalString(input.feeSessionId ?? input.fee_session_id),
    suggestedBillingConcept: optionalString(input.suggestedBillingConcept ?? input.suggested_billing_concept) || "診療情報提供料",
    status: optionalEnum(input.status, ["not_linked", "suggested", "linked", "dismissed"], "status") || "suggested",
    notes: optionalMultilineString(input.notes, 5000)
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

function normalizeReferralAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 100).map(validateReferralAttachmentInput);
}

function normalizeReferralSourceImports(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 50).map(validateReferralImportInput);
}

function normalizeReferralFormSections(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const currentMedications = value.currentMedications ?? value.current_medications;
  const attachments = value.attachments;
  return compactObject({
    referralPurpose: optionalMultilineString(value.referralPurpose ?? value.referral_purpose, 2000),
    pastHistory: optionalMultilineString(value.pastHistory ?? value.past_history, 5000),
    familyHistory: optionalMultilineString(value.familyHistory ?? value.family_history, 5000),
    clinicalCourseAndFindings: optionalMultilineString(value.clinicalCourseAndFindings ?? value.clinical_course_and_findings, 20000),
    treatmentCourse: optionalMultilineString(value.treatmentCourse ?? value.treatment_course, 20000),
    currentMedications: normalizeTextLines(currentMedications, 100, "referralFormSections.currentMedications"),
    allergies: normalizeTextLines(value.allergies, 50, "referralFormSections.allergies"),
    diagnoses: normalizeTextLines(value.diagnoses, 50, "referralFormSections.diagnoses"),
    requestedAction: optionalMultilineString(value.requestedAction ?? value.requested_action, 5000),
    notes: optionalMultilineString(value.notes, 5000),
    attachments: normalizeStringArray(attachments)
  });
}

function normalizeSourceEvidenceRefs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 200).map((item, index) => {
    if (!isPlainObject(item)) {
      throw validationError("sourceEvidenceRefs item must be an object", `sourceEvidenceRefs.${index}`);
    }
    return compactObject({
      evidenceId: optionalString(item.evidenceId ?? item.evidence_id) || `evidence_${String(index + 1).padStart(3, "0")}`,
      sourceProduct: requiredString(item.sourceProduct ?? item.source_product ?? "manual", "sourceEvidenceRefs.sourceProduct"),
      sourceType: requiredString(item.sourceType ?? item.source_type ?? "clinical_text", "sourceEvidenceRefs.sourceType"),
      sourceId: optionalString(item.sourceId ?? item.source_id),
      sourceDate: optionalString(item.sourceDate ?? item.source_date),
      label: optionalString(item.label),
      excerpt: optionalMultilineString(item.excerpt, 5000),
      snapshotHash: optionalString(item.snapshotHash ?? item.snapshot_hash)
    });
  });
}

function normalizeSectionEvidence(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).map(([section, evidenceIds]) => [
    section,
    normalizeStringArray(evidenceIds).slice(0, 50)
  ]));
}

function normalizeAssistantSections(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).map(([section, item]) => {
    if (!isPlainObject(item)) {
      return [section, { text: optionalMultilineString(item, 20000) || "", evidenceIds: [], needsReview: true }];
    }
    return [section, compactObject({
      text: optionalMultilineString(item.text, 20000) || "",
      evidenceIds: normalizeStringArray(item.evidenceIds ?? item.evidence_ids),
      needsReview: Boolean(item.needsReview ?? item.needs_review),
      reviewReason: optionalString(item.reviewReason ?? item.review_reason)
    })];
  }));
}

function normalizeReviewChecklist(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 100).map((item) => compactObject({
    key: requiredString(item.key, "reviewChecklist.key"),
    label: requiredString(item.label, "reviewChecklist.label"),
    status: optionalEnum(item.status, ["passed", "missing", "warning"], "reviewChecklist.status") || "missing",
    message: optionalString(item.message),
    required: item.required === undefined ? true : Boolean(item.required)
  }));
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
