export const collections = Object.freeze({
  organizations: "organizations",
  organizationCodes: "organization_codes",
  loginIdentities: "login_identities",
  signupApplications: "signup_applications",
  signupEmailTokens: "signup_email_tokens",
  passwordSetupTokens: "password_setup_tokens",
  rateLimits: "rate_limits",
  members: "members",
  facilities: "facilities",
  departments: "departments",
  patients: "patients",
  patientAliases: "aliases",
  productEntitlements: "product_entitlements",
  auditEvents: "audit_events",
  dataRequests: "data_requests",
  chartingEncounters: "charting_encounters",
  feeSessions: "fee_sessions",
  referrals: "referrals"
});

export function organizationPath(orgId) {
  return joinPath(collections.organizations, segment(orgId, "orgId"));
}

export function organizationCodePath(organizationCode) {
  return joinPath(collections.organizationCodes, segment(organizationCode, "organizationCode"));
}

export function signupApplicationPath(applicationId) {
  return joinPath(collections.signupApplications, segment(applicationId, "applicationId"));
}

export function signupEmailTokenPath(token) {
  return joinPath(collections.signupEmailTokens, segment(token, "token"));
}

export function passwordSetupTokenPath(token) {
  return joinPath(collections.passwordSetupTokens, segment(token, "token"));
}

export function rateLimitPath(key) {
  return joinPath(collections.rateLimits, segment(key, "key"));
}

export function loginIdentityKey(organizationCode, loginId) {
  return `${segment(organizationCode, "organizationCode")}:${segment(loginId, "loginId")}`;
}

export function loginIdentityPath(organizationCode, loginId) {
  return joinPath(collections.loginIdentities, loginIdentityKey(organizationCode, loginId));
}

export function organizationSubcollectionPath(orgId, collectionName) {
  return `${organizationPath(orgId)}/${segment(collectionName, "collectionName")}`;
}

export function memberPath(orgId, memberId) {
  return orgDocPath(orgId, collections.members, memberId, "memberId");
}

export function facilityPath(orgId, facilityId) {
  return orgDocPath(orgId, collections.facilities, facilityId, "facilityId");
}

export function departmentPath(orgId, departmentId) {
  return orgDocPath(orgId, collections.departments, departmentId, "departmentId");
}

export function patientPath(orgId, patientId) {
  return orgDocPath(orgId, collections.patients, patientId, "patientId");
}

export function patientAliasPath(orgId, patientId, aliasId) {
  return [
    patientPath(orgId, patientId),
    collections.patientAliases,
    segment(aliasId, "aliasId")
  ].join("/");
}

export function productEntitlementPath(orgId, productId) {
  return orgDocPath(orgId, collections.productEntitlements, productId, "productId");
}

export function auditEventPath(orgId, eventId) {
  return orgDocPath(orgId, collections.auditEvents, eventId, "eventId");
}

export function chartingEncounterPath(orgId, encounterId) {
  return orgDocPath(orgId, collections.chartingEncounters, encounterId, "encounterId");
}

export function feeSessionPath(orgId, feeSessionId) {
  return orgDocPath(orgId, collections.feeSessions, feeSessionId, "feeSessionId");
}

export function referralPath(orgId, referralId) {
  return orgDocPath(orgId, collections.referrals, referralId, "referralId");
}

export function orgDocPath(orgId, collectionName, documentId, documentLabel = "documentId") {
  return [
    organizationPath(orgId),
    segment(collectionName, "collectionName"),
    segment(documentId, documentLabel)
  ].join("/");
}

export function joinPath(...parts) {
  return parts.map((part) => segment(part, "pathPart")).join("/");
}

export function segment(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${label} is required`);
  }

  if (trimmed.includes("/")) {
    throw new TypeError(`${label} must not contain "/"`);
  }

  return trimmed;
}
