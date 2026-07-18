export const collections = Object.freeze({
  organizations: "organizations",
  organizationCodes: "organization_codes",
  loginIdentities: "login_identities",
  signupApplications: "signup_applications",
  signupEmailTokens: "signup_email_tokens",
  passwordSetupTokens: "password_setup_tokens",
  stripeEventReceipts: "stripe_event_receipts",
  rateLimits: "rate_limits",
  sidecarDeviceAuthorizations: "sidecar_device_authorizations",
  sidecarDeviceGrants: "sidecar_device_grants",
  members: "members",
  facilities: "facilities",
  departments: "departments",
  patients: "patients",
  patientAliases: "aliases",
  productEntitlements: "product_entitlements",
  auditEvents: "audit_events",
  dataRequests: "data_requests",
  chartingEncounters: "charting_encounters",
  feeSettings: "fee_settings",
  feeBillingHistory: "fee_billing_history",
  feeSessions: "fee_sessions",
  sidecarCalculationDrafts: "sidecar_calculation_drafts",
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

export function stripeEventReceiptPath(eventId) {
  return joinPath(collections.stripeEventReceipts, segment(eventId, "eventId"));
}

export function rateLimitPath(key) {
  return joinPath(collections.rateLimits, segment(key, "key"));
}

export function sidecarDeviceAuthorizationPath(deviceAuthId) {
  return joinPath(
    collections.sidecarDeviceAuthorizations,
    segment(deviceAuthId, "deviceAuthId")
  );
}

export function sidecarDeviceGrantPath(grantRecordId) {
  return joinPath(collections.sidecarDeviceGrants, segment(grantRecordId, "grantRecordId"));
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

export function dataRequestPath(orgId, requestId) {
  return orgDocPath(orgId, collections.dataRequests, requestId, "requestId");
}

export function chartingEncounterPath(orgId, encounterId) {
  return orgDocPath(orgId, collections.chartingEncounters, encounterId, "encounterId");
}

export function feeSessionPath(orgId, feeSessionId) {
  return orgDocPath(orgId, collections.feeSessions, feeSessionId, "feeSessionId");
}

export function sidecarCalculationDraftPath(orgId, sidecarDraftId) {
  return orgDocPath(orgId, collections.sidecarCalculationDrafts, sidecarDraftId, "sidecarDraftId");
}

export function feeSettingsPath(orgId, facilityId = "default") {
  return orgDocPath(orgId, collections.feeSettings, facilityId || "default", "facilityId");
}

export function feeBillingHistoryPath(orgId, historyEventId) {
  return orgDocPath(orgId, collections.feeBillingHistory, historyEventId, "historyEventId");
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
