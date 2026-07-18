export const productIds = Object.freeze({
  charting: "charting",
  fee: "fee",
  referral: "referral",
  homisSidecar: "homis_sidecar"
});

export const organizationStatuses = Object.freeze(["active", "trialing", "suspended", "closed"]);
export const memberStatuses = Object.freeze(["active", "invited", "disabled"]);
export const loginIdentityStatuses = Object.freeze(["active", "locked", "disabled"]);
export const facilityStatuses = Object.freeze(["active", "inactive"]);
export const departmentStatuses = Object.freeze(["active", "inactive"]);
export const patientStatuses = Object.freeze(["active", "merged", "inactive"]);
export const patientSexes = Object.freeze(["male", "female", "other", "unknown"]);
export const productEntitlementStatuses = Object.freeze([
  "enabled",
  "trialing",
  "payment_required",
  "checkout_pending",
  "past_due",
  "cancel_scheduled",
  "canceled",
  "disabled"
]);
export const signupApplicationStatuses = Object.freeze(["submitted", "email_verified", "provisioned", "rejected"]);
export const dataRequestTypes = Object.freeze(["access", "export", "deletion", "correction"]);
export const dataRequestStatuses = Object.freeze(["submitted", "reviewing", "completed", "rejected", "cancelled"]);
export const recordingSources = Object.freeze(["linked_mobile", "local_browser"]);
export const mfaRequiredGlobalRoles = Object.freeze([
  "platform_admin",
  "org_owner",
  "org_admin",
  "it_admin",
  "billing_admin"
]);
// 保険種別: 社保 / 国保 / 後期高齢 / 自費 / その他
export const insurerTypes = Object.freeze(["shaho", "kokuho", "kouki", "jihi", "other"]);

export function memberRequiresMfa(member = {}) {
  const roles = Array.isArray(member.globalRoles) ? member.globalRoles : [];
  if (roles.some((role) => mfaRequiredGlobalRoles.includes(role))) {
    return true;
  }
  const productRoles = member.productRoles && typeof member.productRoles === "object"
    ? Object.values(member.productRoles)
    : [];
  if (productRoles.some((productRoleList) => (
    Array.isArray(productRoleList) && productRoleList.includes("admin")
  ))) {
    return true;
  }

  return Array.isArray(member.productRoles?.[productIds.homisSidecar])
    && member.productRoles[productIds.homisSidecar].length > 0;
}

export function resolveMfaState(identity = {}, member = {}) {
  return {
    required: Boolean(identity.mfaRequired) || memberRequiresMfa(member),
    enrolled: Boolean(identity.mfaEnrolled)
  };
}

export function normalizeOrganizationCode(value) {
  return requiredString(value, "organizationCode")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeLoginId(value) {
  return requiredString(value, "loginId").toLowerCase();
}

export function validateCreateOrganizationInput(input = {}) {
  const organizationCode = normalizeOrganizationCode(input.organizationCode);
  if (!organizationCode) {
    throw validationError("organizationCode must contain at least one letter or number", "organizationCode");
  }

  return {
    organizationCode,
    displayName: requiredString(input.displayName, "displayName"),
    legalName: optionalString(input.legalName),
    status: optionalEnum(input.status, organizationStatuses, "status") || "trialing",
    timezone: optionalString(input.timezone) || "Asia/Tokyo",
    locale: optionalString(input.locale) || "ja-JP",
    billing: isPlainObject(input.billing) ? input.billing : {},
    access: isPlainObject(input.access) ? input.access : defaultAccess()
  };
}

export function validatePatchOrganizationInput(input = {}) {
  if (hasOwn(input, "organizationCode")) {
    throw validationError("organizationCode cannot be changed", "organizationCode");
  }

  return compactObject({
    displayName: hasOwn(input, "displayName") ? requiredString(input.displayName, "displayName") : undefined,
    legalName: hasOwn(input, "legalName") ? optionalString(input.legalName) : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, organizationStatuses, "status") : undefined,
    timezone: hasOwn(input, "timezone") ? requiredString(input.timezone, "timezone") : undefined,
    locale: hasOwn(input, "locale") ? requiredString(input.locale, "locale") : undefined,
    billing: hasOwn(input, "billing") && isPlainObject(input.billing) ? input.billing : undefined,
    access: hasOwn(input, "access") && isPlainObject(input.access) ? input.access : undefined,
    defaultFacilityId: hasOwn(input, "defaultFacilityId") ? optionalString(input.defaultFacilityId) : undefined,
    defaultDepartmentId: hasOwn(input, "defaultDepartmentId") ? optionalString(input.defaultDepartmentId) : undefined,
    defaultPromptProfileId: hasOwn(input, "defaultPromptProfileId") ? optionalString(input.defaultPromptProfileId) : undefined,
    recordingMaxDurationMinutes: hasOwn(input, "recordingMaxDurationMinutes")
      ? optionalPositiveInteger(input.recordingMaxDurationMinutes, "recordingMaxDurationMinutes")
      : undefined
  });
}

export function validateCreateMemberInput(input = {}) {
  return {
    loginId: normalizeLoginId(input.loginId),
    displayName: requiredString(input.displayName, "displayName"),
    email: optionalString(input.email),
    status: optionalEnum(input.status, memberStatuses, "status") || "active",
    globalRoles: normalizeStringArray(input.globalRoles),
    productRoles: normalizeProductRoles(input.productRoles),
    facilityIds: normalizeStringArray(input.facilityIds),
    departmentIds: normalizeStringArray(input.departmentIds),
    defaultFacilityId: optionalString(input.defaultFacilityId),
    defaultDepartmentId: optionalString(input.defaultDepartmentId),
    defaultPromptProfileId: optionalString(input.defaultPromptProfileId),
    defaultRecordingSource: optionalEnum(input.defaultRecordingSource, recordingSources, "defaultRecordingSource") || "linked_mobile"
  };
}

export function validatePatchMemberInput(input = {}) {
  if (hasOwn(input, "loginId")) {
    throw validationError("loginId cannot be changed", "loginId");
  }

  return compactObject({
    displayName: hasOwn(input, "displayName") ? requiredString(input.displayName, "displayName") : undefined,
    email: hasOwn(input, "email") ? optionalString(input.email) : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, memberStatuses, "status") : undefined,
    globalRoles: hasOwn(input, "globalRoles") ? normalizeStringArray(input.globalRoles) : undefined,
    productRoles: hasOwn(input, "productRoles") ? normalizeProductRoles(input.productRoles) : undefined,
    facilityIds: hasOwn(input, "facilityIds") ? normalizeStringArray(input.facilityIds) : undefined,
    departmentIds: hasOwn(input, "departmentIds") ? normalizeStringArray(input.departmentIds) : undefined,
    defaultFacilityId: hasOwn(input, "defaultFacilityId") ? optionalString(input.defaultFacilityId) : undefined,
    defaultDepartmentId: hasOwn(input, "defaultDepartmentId") ? optionalString(input.defaultDepartmentId) : undefined,
    defaultPromptProfileId: hasOwn(input, "defaultPromptProfileId") ? optionalString(input.defaultPromptProfileId) : undefined,
    defaultRecordingSource: hasOwn(input, "defaultRecordingSource")
      ? optionalEnum(input.defaultRecordingSource, recordingSources, "defaultRecordingSource")
      : undefined
  });
}

export function validateLoginInput(input = {}) {
  const organizationCode = normalizeOrganizationCode(input.organizationCode);
  if (!organizationCode) {
    throw validationError("organizationCode must contain at least one letter or number", "organizationCode");
  }

  return {
    organizationCode,
    loginId: normalizeLoginId(input.loginId),
    password: requiredString(input.password, "password"),
    mfaCode: optionalString(input.mfaCode)
  };
}

export function validateCreateSignupApplicationInput(input = {}) {
  const organizationCode = normalizeOrganizationCode(input.organizationCode);
  if (!organizationCode) {
    throw validationError("organizationCode must contain at least one letter or number", "organizationCode");
  }

  return {
    organizationCode,
    organizationDisplayName: requiredString(input.organizationDisplayName, "organizationDisplayName"),
    applicantName: requiredString(input.applicantName, "applicantName"),
    applicantEmail: requiredString(input.applicantEmail, "applicantEmail").toLowerCase(),
    status: optionalEnum(input.status, signupApplicationStatuses, "status") || "submitted",
    requestedProducts: normalizeRequestedProducts(input.requestedProducts),
    safePayload: sanitizeSignupApplicationSafePayload(input.safePayload)
  };
}

export function validateVerifySignupEmailInput(input = {}) {
  return {
    token: requiredString(input.token, "token")
  };
}

export function validateSetupAdminPasswordInput(input = {}) {
  return {
    token: requiredString(input.token, "token"),
    password: requiredString(input.password, "password")
  };
}

export function validateCreateFacilityInput(input = {}) {
  return {
    displayName: requiredString(input.displayName, "displayName"),
    legalName: optionalString(input.legalName),
    facilityType: optionalString(input.facilityType),
    medicalInstitutionCode: optionalString(input.medicalInstitutionCode),
    regionalBureau: optionalString(input.regionalBureau),
    prefecture: optionalString(input.prefecture),
    address: isPlainObject(input.address) ? input.address : {},
    phone: optionalString(input.phone),
    facilityStandardKeys: normalizeStringArray(input.facilityStandardKeys),
    status: optionalEnum(input.status, facilityStatuses, "status") || "active"
  };
}

export function validatePatchFacilityInput(input = {}) {
  return compactObject({
    displayName: hasOwn(input, "displayName") ? requiredString(input.displayName, "displayName") : undefined,
    legalName: hasOwn(input, "legalName") ? optionalString(input.legalName) : undefined,
    facilityType: hasOwn(input, "facilityType") ? optionalString(input.facilityType) : undefined,
    medicalInstitutionCode: hasOwn(input, "medicalInstitutionCode")
      ? optionalString(input.medicalInstitutionCode)
      : undefined,
    regionalBureau: hasOwn(input, "regionalBureau") ? optionalString(input.regionalBureau) : undefined,
    prefecture: hasOwn(input, "prefecture") ? optionalString(input.prefecture) : undefined,
    address: hasOwn(input, "address") && isPlainObject(input.address) ? input.address : undefined,
    phone: hasOwn(input, "phone") ? optionalString(input.phone) : undefined,
    facilityStandardKeys: hasOwn(input, "facilityStandardKeys")
      ? normalizeStringArray(input.facilityStandardKeys)
      : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, facilityStatuses, "status") : undefined
  });
}

export function validateCreateDepartmentInput(input = {}) {
  return {
    facilityId: optionalString(input.facilityId),
    displayName: requiredString(input.displayName, "displayName"),
    code: optionalString(input.code),
    specialty: optionalString(input.specialty),
    status: optionalEnum(input.status, departmentStatuses, "status") || "active"
  };
}

export function validatePatchDepartmentInput(input = {}) {
  return compactObject({
    facilityId: hasOwn(input, "facilityId") ? optionalString(input.facilityId) : undefined,
    displayName: hasOwn(input, "displayName") ? requiredString(input.displayName, "displayName") : undefined,
    code: hasOwn(input, "code") ? optionalString(input.code) : undefined,
    specialty: hasOwn(input, "specialty") ? optionalString(input.specialty) : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, departmentStatuses, "status") : undefined
  });
}

export function validateCreatePatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName, "displayName"),
    displayNameKana: optionalString(input.displayNameKana),
    birthDate: optionalBirthDate(input.birthDate),
    sex: optionalEnum(input.sex, patientSexes, "sex") || "unknown",
    primaryPatientNumber: optionalString(input.primaryPatientNumber || input.patientNumber),
    patientIdentifiers: normalizePatientIdentifiers(input.patientIdentifiers),
    externalPatientIds: normalizeStringArray(input.externalPatientIds),
    contact: isPlainObject(input.contact) ? input.contact : {},
    insurance: validateInsurance(input.insurance),
    publicInsurance: validatePublicInsurance(input.publicInsurance),
    consent: isPlainObject(input.consent) ? input.consent : {},
    duplicateCandidateIds: normalizeStringArray(input.duplicateCandidateIds),
    status: optionalEnum(input.status, patientStatuses, "status") || "active",
    notes: optionalString(input.notes)
  };
}

export function validatePatchPatientInput(input = {}) {
  return compactObject({
    displayName: hasOwn(input, "displayName") ? requiredString(input.displayName, "displayName") : undefined,
    displayNameKana: hasOwn(input, "displayNameKana") ? optionalString(input.displayNameKana) : undefined,
    birthDate: hasOwn(input, "birthDate") ? optionalBirthDate(input.birthDate) : undefined,
    sex: hasOwn(input, "sex") ? optionalEnum(input.sex, patientSexes, "sex") || "unknown" : undefined,
    primaryPatientNumber: hasOwn(input, "primaryPatientNumber") || hasOwn(input, "patientNumber")
      ? optionalString(input.primaryPatientNumber || input.patientNumber)
      : undefined,
    patientIdentifiers: hasOwn(input, "patientIdentifiers")
      ? normalizePatientIdentifiers(input.patientIdentifiers)
      : undefined,
    externalPatientIds: hasOwn(input, "externalPatientIds") ? normalizeStringArray(input.externalPatientIds) : undefined,
    contact: hasOwn(input, "contact") && isPlainObject(input.contact) ? input.contact : undefined,
    insurance: hasOwn(input, "insurance") ? validateInsurance(input.insurance) : undefined,
    publicInsurance: hasOwn(input, "publicInsurance") ? validatePublicInsurance(input.publicInsurance) : undefined,
    consent: hasOwn(input, "consent") && isPlainObject(input.consent) ? input.consent : undefined,
    duplicateCandidateIds: hasOwn(input, "duplicateCandidateIds")
      ? normalizeStringArray(input.duplicateCandidateIds)
      : undefined,
    status: hasOwn(input, "status") ? optionalEnum(input.status, patientStatuses, "status") : undefined,
    mergedIntoPatientId: hasOwn(input, "mergedIntoPatientId")
      ? optionalString(input.mergedIntoPatientId)
      : undefined,
    notes: hasOwn(input, "notes") ? optionalString(input.notes) : undefined
  });
}

export function validateUpsertProductEntitlementInput(input = {}) {
  const productId = requiredString(input.productId, "productId");
  if (!Object.values(productIds).includes(productId)) {
    throw validationError(`productId must be one of: ${Object.values(productIds).join(", ")}`, "productId");
  }

  return {
    productId,
    status: optionalEnum(input.status, productEntitlementStatuses, "status") || "trialing",
    plan: optionalString(input.plan),
    pricingModel: optionalString(input.pricingModel),
    monthlyAmountJpy: optionalPositiveInteger(input.monthlyAmountJpy, "monthlyAmountJpy"),
    currency: optionalString(input.currency),
    limits: isPlainObject(input.limits) ? input.limits : {},
    features: isPlainObject(input.features) ? input.features : {},
    trialStartsAt: optionalDateTime(input.trialStartsAt, "trialStartsAt"),
    trialEndsAt: optionalDateTime(input.trialEndsAt, "trialEndsAt"),
    reminderStartsAt: optionalDateTime(input.reminderStartsAt, "reminderStartsAt"),
    lastReminderSentAt: optionalDateTime(input.lastReminderSentAt, "lastReminderSentAt"),
    reminderCount: optionalNonNegativeInteger(input.reminderCount, "reminderCount"),
    stripePriceLookupKey: optionalString(input.stripePriceLookupKey),
    stripePriceId: optionalString(input.stripePriceId),
    stripeSubscriptionItemId: optionalString(input.stripeSubscriptionItemId),
    seatBilling: isPlainObject(input.seatBilling) ? input.seatBilling : undefined,
    currentPeriodEnd: optionalDateTime(input.currentPeriodEnd, "currentPeriodEnd"),
    cancelAtPeriodEnd: optionalBoolean(input.cancelAtPeriodEnd),
    cancelScheduledAt: optionalDateTime(input.cancelScheduledAt, "cancelScheduledAt"),
    canceledAt: optionalDateTime(input.canceledAt, "canceledAt"),
    startsAt: optionalDateTime(input.startsAt, "startsAt"),
    endsAt: optionalDateTime(input.endsAt, "endsAt")
  };
}

export function validatePatchProductEntitlementInput(input = {}) {
  if (hasOwn(input, "productId")) {
    const productId = requiredString(input.productId, "productId");
    if (!Object.values(productIds).includes(productId)) {
      throw validationError(`productId must be one of: ${Object.values(productIds).join(", ")}`, "productId");
    }
  }

  return compactObject({
    status: hasOwn(input, "status")
      ? optionalEnum(input.status, productEntitlementStatuses, "status")
      : undefined,
    plan: hasOwn(input, "plan") ? optionalString(input.plan) : undefined,
    pricingModel: hasOwn(input, "pricingModel") ? optionalString(input.pricingModel) : undefined,
    monthlyAmountJpy: hasOwn(input, "monthlyAmountJpy")
      ? optionalPositiveInteger(input.monthlyAmountJpy, "monthlyAmountJpy")
      : undefined,
    currency: hasOwn(input, "currency") ? optionalString(input.currency) : undefined,
    limits: hasOwn(input, "limits") && isPlainObject(input.limits) ? input.limits : undefined,
    features: hasOwn(input, "features") && isPlainObject(input.features) ? input.features : undefined,
    trialStartsAt: hasOwn(input, "trialStartsAt") ? optionalDateTime(input.trialStartsAt, "trialStartsAt") : undefined,
    trialEndsAt: hasOwn(input, "trialEndsAt") ? optionalDateTime(input.trialEndsAt, "trialEndsAt") : undefined,
    reminderStartsAt: hasOwn(input, "reminderStartsAt") ? optionalDateTime(input.reminderStartsAt, "reminderStartsAt") : undefined,
    lastReminderSentAt: hasOwn(input, "lastReminderSentAt")
      ? optionalDateTime(input.lastReminderSentAt, "lastReminderSentAt")
      : undefined,
    reminderCount: hasOwn(input, "reminderCount")
      ? optionalNonNegativeInteger(input.reminderCount, "reminderCount")
      : undefined,
    stripePriceLookupKey: hasOwn(input, "stripePriceLookupKey") ? optionalString(input.stripePriceLookupKey) : undefined,
    stripePriceId: hasOwn(input, "stripePriceId") ? optionalString(input.stripePriceId) : undefined,
    stripeSubscriptionItemId: hasOwn(input, "stripeSubscriptionItemId")
      ? optionalString(input.stripeSubscriptionItemId)
      : undefined,
    seatBilling: hasOwn(input, "seatBilling") && isPlainObject(input.seatBilling) ? input.seatBilling : undefined,
    currentPeriodEnd: hasOwn(input, "currentPeriodEnd") ? optionalDateTime(input.currentPeriodEnd, "currentPeriodEnd") : undefined,
    cancelAtPeriodEnd: hasOwn(input, "cancelAtPeriodEnd") ? optionalBoolean(input.cancelAtPeriodEnd) : undefined,
    cancelScheduledAt: hasOwn(input, "cancelScheduledAt") ? optionalDateTime(input.cancelScheduledAt, "cancelScheduledAt") : undefined,
    canceledAt: hasOwn(input, "canceledAt") ? optionalDateTime(input.canceledAt, "canceledAt") : undefined,
    startsAt: hasOwn(input, "startsAt") ? optionalDateTime(input.startsAt, "startsAt") : undefined,
    endsAt: hasOwn(input, "endsAt") ? optionalDateTime(input.endsAt, "endsAt") : undefined
  });
}

export function validateCreateAuditEventInput(input = {}) {
  const productId = optionalString(input.productId);
  if (productId && !Object.values(productIds).includes(productId)) {
    throw validationError(`productId must be one of: ${Object.values(productIds).join(", ")}`, "productId");
  }

  return {
    eventType: requiredString(input.eventType, "eventType"),
    actorMemberId: optionalString(input.actorMemberId),
    actorLoginId: optionalString(input.actorLoginId),
    productId,
    targetType: optionalString(input.targetType),
    targetId: optionalString(input.targetId),
    safePayload: sanitizeSafePayload(input.safePayload)
  };
}

export function validateCreateDataRequestInput(input = {}) {
  return {
    requestType: optionalEnum(input.requestType, dataRequestTypes, "requestType") || "deletion",
    requesterMemberId: optionalString(input.requesterMemberId),
    requesterEmail: optionalString(input.requesterEmail),
    subjectPatientId: optionalString(input.subjectPatientId),
    productIds: normalizeProductIds(input.productIds || input.requestedProducts),
    reason: optionalString(input.reason),
    status: optionalEnum(input.status, dataRequestStatuses, "status") || "submitted",
    safePayload: sanitizeSafePayload(input.safePayload)
  };
}

export function validatePatchDataRequestInput(input = {}) {
  return compactObject({
    status: hasOwn(input, "status") ? optionalEnum(input.status, dataRequestStatuses, "status") : undefined,
    assignedMemberId: hasOwn(input, "assignedMemberId") ? optionalString(input.assignedMemberId) : undefined,
    completedAt: hasOwn(input, "completedAt") ? optionalDateTime(input.completedAt, "completedAt") : undefined,
    rejectionReason: hasOwn(input, "rejectionReason") ? optionalString(input.rejectionReason) : undefined,
    safePayload: hasOwn(input, "safePayload") ? sanitizeSafePayload(input.safePayload) : undefined
  });
}

export function patientSnapshot(patient, snapshotAt = new Date()) {
  return compactObject({
    patientId: requiredString(patient.patientId, "patientId"),
    displayName: requiredString(patient.displayName, "displayName"),
    displayNameKana: optionalString(patient.displayNameKana),
    birthDate: optionalBirthDate(patient.birthDate),
    sex: optionalEnum(patient.sex, patientSexes, "sex") || "unknown",
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  });
}

// 患者の保険情報を構造化する。既知フィールドは検証し、未知キーは後方互換のため保持する。
export function validateInsurance(input = {}) {
  if (!isPlainObject(input)) {
    return {};
  }
  const known = compactObject({
    insurerType: optionalEnum(input.insurerType, insurerTypes, "insurance.insurerType"),
    insurerNumber: optionalString(input.insurerNumber),
    insuredSymbol: optionalString(input.insuredSymbol),
    insuredNumber: optionalString(input.insuredNumber),
    branchNumber: optionalString(input.branchNumber),
    burdenRatio: optionalBurdenRatio(input.burdenRatio, "insurance.burdenRatio"),
    validFrom: optionalDate(input.validFrom, "insurance.validFrom"),
    validTo: optionalDate(input.validTo, "insurance.validTo")
  });
  const KNOWN_KEYS = new Set([
    "insurerType", "insurerNumber", "insuredSymbol", "insuredNumber",
    "branchNumber", "burdenRatio", "validFrom", "validTo"
  ]);
  const preserved = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_KEYS.has(key)) {
      preserved[key] = value;
    }
  }
  return { ...preserved, ...known };
}

// 公費は併用ありのため配列。各エントリの既知フィールドを検証する。
export function validatePublicInsurance(value) {
  if (isPlainObject(value)) {
    // 後方互換: 旧データが単一オブジェクトの場合は1要素配列として扱う
    value = [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainObject)
    .map((entry, index) => compactObject({
      payerNumber: optionalString(entry.payerNumber),
      recipientNumber: optionalString(entry.recipientNumber),
      burdenRatioOverride: optionalBurdenRatio(entry.burdenRatioOverride, `publicInsurance[${index}].burdenRatioOverride`),
      priority: optionalNonNegativeInteger(entry.priority, `publicInsurance[${index}].priority`)
    }))
    .filter((entry) => Object.keys(entry).length > 0);
}

// 受診日時点の保険・公費をセッションに固定するためのスナップショット。
export function insuranceSnapshot(patient = {}, serviceDate, snapshotAt = new Date()) {
  const insurance = validateInsurance(patient.insurance);
  const publicInsurance = validatePublicInsurance(patient.publicInsurance);
  return compactObject({
    insurance: Object.keys(insurance).length ? insurance : undefined,
    publicInsurance: publicInsurance.length ? publicInsurance : undefined,
    serviceDate: optionalDate(serviceDate, "serviceDate"),
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  });
}

export function facilitySnapshot(facility, snapshotAt = new Date()) {
  return compactObject({
    facilityId: requiredString(facility.facilityId, "facilityId"),
    displayName: requiredString(facility.displayName, "displayName"),
    legalName: optionalString(facility.legalName),
    facilityType: optionalString(facility.facilityType),
    medicalInstitutionCode: optionalString(facility.medicalInstitutionCode),
    regionalBureau: optionalString(facility.regionalBureau),
    prefecture: optionalString(facility.prefecture),
    facilityStandardKeys: normalizeStringArray(facility.facilityStandardKeys),
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  });
}

export function departmentSnapshot(department, snapshotAt = new Date()) {
  return compactObject({
    departmentId: requiredString(department.departmentId, "departmentId"),
    facilityId: optionalString(department.facilityId),
    displayName: requiredString(department.displayName, "displayName"),
    code: optionalString(department.code),
    specialty: optionalString(department.specialty),
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  });
}

export function memberSnapshot(member, snapshotAt = new Date()) {
  return compactObject({
    memberId: requiredString(member.memberId, "memberId"),
    displayName: requiredString(member.displayName, "displayName"),
    loginId: optionalString(member.loginId),
    email: optionalString(member.email),
    globalRoles: normalizeStringArray(member.globalRoles),
    productRoles: isPlainObject(member.productRoles) ? member.productRoles : {},
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  });
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function defaultAccess() {
  return {
    status: "active",
    enabledProducts: [productIds.charting, productIds.fee, productIds.referral]
  };
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

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !allowed.includes(value)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  }

  return value;
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

function optionalBurdenRatio(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw validationError(`${field} must be a ratio between 0 and 1 (e.g. 0.3)`, field);
  }

  return parsed;
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

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw validationError(`${field} must be a positive integer`, field);
  }

  return parsed;
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw validationError(`${field} must be a non-negative integer`, field);
  }

  return parsed;
}

function optionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  return Boolean(value);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function normalizeProductRoles(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const normalized = {};
  for (const [productId, roles] of Object.entries(value)) {
    if (!Object.values(productIds).includes(productId)) {
      continue;
    }

    normalized[productId] = normalizeStringArray(roles);
  }

  return normalized;
}

function normalizeRequestedProducts(value) {
  const products = normalizeStringArray(value).filter((productId) => Object.values(productIds).includes(productId));
  return products.length > 0 ? products : [productIds.charting];
}

function normalizeProductIds(value) {
  return normalizeStringArray(value).filter((productId) => Object.values(productIds).includes(productId));
}

function normalizePatientIdentifiers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlainObject)
    .map((identifier) => compactObject({
      sourceSystem: optionalString(identifier.sourceSystem),
      facilityId: optionalString(identifier.facilityId),
      patientNumber: optionalString(identifier.patientNumber),
      value: optionalString(identifier.value),
      status: optionalString(identifier.status) || "active"
    }))
    .filter((identifier) => identifier.patientNumber || identifier.value)
    .map((identifier) => ({
      ...identifier,
      value: identifier.value || identifier.patientNumber
    }));
}

function sanitizeSafePayload(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const allowed = new Set([
    "applicationId",
    "assignedMemberId",
    "authorMemberId",
    "baselineClaimCount",
    "baselineFormat",
    "calculationId",
    "calculationPayloadCount",
    "changedFields",
    "claimMonth",
    "count",
    "dataRequestId",
    "datasetWarningCount",
    "departmentId",
    "encounterId",
    "eventId",
    "facilityId",
    "feeSessionId",
    "loginIdentityCreated",
    "memberId",
    "mfaVerified",
    "missingCandidateCount",
    "needsReviewCount",
    "orgId",
    "patientId",
    "pdfPlaceholderId",
    "productId",
    "productIds",
    "provider",
    "referralId",
    "requestType",
    "soapDraftId",
    "status",
    "considerCount",
    "sessionCount",
    "targetId",
    "targetType",
    "totalPoints",
    // 売上改善診断(clinic-diagnosis)の集計(件数のみ・PHIなし)
    "assessmentRiskCount",
    "billingMissCount",
    "claimCount",
    "errorCount",
    "patientCount"
  ]);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => allowed.has(key) && safePayloadValue(item))
  );
}

function sanitizeSignupApplicationSafePayload(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const { phoneNumber: _phoneNumber, ...rest } = value;
  return rest;
}

function safePayloadValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => ["string", "number", "boolean"].includes(typeof item));
  }
  return false;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
