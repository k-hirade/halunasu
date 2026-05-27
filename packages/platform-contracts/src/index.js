export const productIds = Object.freeze({
  charting: "charting",
  fee: "fee",
  referral: "referral"
});

export const organizationStatuses = Object.freeze(["active", "trialing", "suspended", "closed"]);
export const memberStatuses = Object.freeze(["active", "invited", "disabled"]);
export const loginIdentityStatuses = Object.freeze(["active", "locked", "disabled"]);
export const facilityStatuses = Object.freeze(["active", "inactive"]);
export const departmentStatuses = Object.freeze(["active", "inactive"]);
export const patientStatuses = Object.freeze(["active", "merged", "inactive"]);
export const patientSexes = Object.freeze(["male", "female", "other", "unknown"]);
export const productEntitlementStatuses = Object.freeze(["enabled", "trialing", "disabled"]);

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
    defaultDepartmentId: optionalString(input.defaultDepartmentId)
  };
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

export function validateCreateDepartmentInput(input = {}) {
  return {
    facilityId: optionalString(input.facilityId),
    displayName: requiredString(input.displayName, "displayName"),
    code: optionalString(input.code),
    specialty: optionalString(input.specialty),
    status: optionalEnum(input.status, departmentStatuses, "status") || "active"
  };
}

export function validateCreatePatientInput(input = {}) {
  return {
    displayName: requiredString(input.displayName, "displayName"),
    displayNameKana: optionalString(input.displayNameKana),
    birthDate: optionalBirthDate(input.birthDate),
    sex: optionalEnum(input.sex, patientSexes, "sex") || "unknown",
    externalPatientIds: normalizeStringArray(input.externalPatientIds),
    status: optionalEnum(input.status, patientStatuses, "status") || "active",
    notes: optionalString(input.notes)
  };
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
    limits: isPlainObject(input.limits) ? input.limits : {},
    features: isPlainObject(input.features) ? input.features : {},
    startsAt: optionalDateTime(input.startsAt, "startsAt"),
    endsAt: optionalDateTime(input.endsAt, "endsAt")
  };
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
    safePayload: isPlainObject(input.safePayload) ? input.safePayload : {}
  };
}

export function patientSnapshot(patient, snapshotAt = new Date()) {
  return {
    patientId: requiredString(patient.patientId, "patientId"),
    displayName: requiredString(patient.displayName, "displayName"),
    displayNameKana: optionalString(patient.displayNameKana),
    birthDate: optionalBirthDate(patient.birthDate),
    sex: optionalEnum(patient.sex, patientSexes, "sex") || "unknown",
    snapshotAt: snapshotAt instanceof Date
      ? snapshotAt.toISOString()
      : requiredString(snapshotAt, "snapshotAt")
  };
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
