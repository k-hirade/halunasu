import { randomInt } from "node:crypto";
import {
  DEFAULT_RECORDING_MAX_DURATION_MINUTES,
  MEMBER_ROLE_DEFINITIONS,
  RECORDING_SOURCES,
  canManageOrganizationRoles,
  canReadOrganizationSessionsRoles,
  normalizeRecordingMaxDurationMinutes
} from "@medical/contracts";
import { createId, nowIso, addMinutes } from "../lib/ids.js";
import { createPlainToken, hashToken } from "../lib/pairing-token.js";
import {
  assertPasswordPolicy,
  buildLoginIdentityKey,
  hashPassword,
  normalizeLoginIdentifier,
  verifyPassword
} from "../lib/password.js";
import {
  DEFAULT_SOAP_FORMAT_PROFILE,
  buildSoapFormatVersion,
  hashSoapFormatDefinition,
  normalizeSoapFormatDisplayNameKey,
  normalizeSoapFormatProfile,
  resolveActiveSoapFormatVersion,
  serializeSoapFormatProfile,
  validateSoapFormatDefinition
} from "../soap/soap-format.js";

const DEFAULT_PROMPT_PROFILE = DEFAULT_SOAP_FORMAT_PROFILE;
const DEFAULT_RECORDING_SOURCE = "linked_mobile";
const AUDIO_TEST_TTL_MINUTES = 10;
const MAX_FAILED_LOGIN_ATTEMPTS = 10;
const ACCOUNT_LOCK_MS = 10 * 60 * 1000;
const MFA_REQUIRED_ROLES = new Set(["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin", "auditor"]);
const ORG_ADMIN_LOCKOUT_ROLES = new Set(["platform_admin", "org_owner", "org_admin"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRecordingSource(value) {
  return RECORDING_SOURCES.includes(value) ? value : DEFAULT_RECORDING_SOURCE;
}

function duplicateSoapFormatDisplayNameError() {
  const error = new Error("同じ病院内に同じ名前のプロンプトがあります。別の名前にしてください。");
  error.statusCode = 409;
  return error;
}

function hasDuplicateSoapFormatDisplayName(promptProfiles, { orgId, displayName, excludeProfileId = null }) {
  const displayNameKey = normalizeSoapFormatDisplayNameKey(displayName);

  if (!displayNameKey) {
    return false;
  }

  return Array.from(promptProfiles.values()).some((profile) => (
    profile.orgId === orgId &&
    profile.profileId !== excludeProfileId &&
    normalizeSoapFormatDisplayNameKey(profile.displayName) === displayNameKey
  ));
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function rolesRequireMfa(roles = []) {
  return roles.some((role) => MFA_REQUIRED_ROLES.has(role));
}

function hasOrgAdminLockoutRole(roles = []) {
  return roles.some((role) => ORG_ADMIN_LOCKOUT_ROLES.has(role));
}

function lastOrgAdminError() {
  const error = new Error("病院内の最後の管理者は停止・降格できません。別の管理者を追加してから操作してください。");
  error.statusCode = 409;
  return error;
}

function assertDoesNotRemoveLastOrgAdmin(members, { memberId, nextStatus, nextRoles }) {
  const target = members.find((member) => member.memberId === memberId || member.userId === memberId);

  if (!target || (target.status || "active") !== "active" || !hasOrgAdminLockoutRole(target.roles || [])) {
    return;
  }

  const targetRemainsActiveAdmin =
    (nextStatus || target.status || "active") === "active" &&
    hasOrgAdminLockoutRole(nextRoles || target.roles || []);

  if (targetRemainsActiveAdmin) {
    return;
  }

  const hasOtherActiveAdmin = members.some((member) => (
    (member.memberId || member.userId) !== memberId &&
    (member.status || "active") === "active" &&
    hasOrgAdminLockoutRole(member.roles || [])
  ));

  if (!hasOtherActiveAdmin) {
    throw lastOrgAdminError();
  }
}

function trustedRecorderStoreKey(orgId, deviceId) {
  return `${orgId}:${deviceId}`;
}

function isLocked(identity, now = Date.now()) {
  return identity?.lockedUntil && Date.parse(identity.lockedUntil) > now;
}

function recordFailedLogin(identity, now = Date.now()) {
  const failedLoginCount = Number(identity.failedLoginCount || 0) + 1;
  identity.failedLoginCount = failedLoginCount;
  identity.lastFailedLoginAt = new Date(now).toISOString();
  identity.lockedUntil = failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS
    ? new Date(now + ACCOUNT_LOCK_MS).toISOString()
    : null;
  identity.updatedAt = identity.lastFailedLoginAt;
}

function resetFailedLoginState(identity, now = Date.now()) {
  identity.failedLoginCount = 0;
  identity.lockedUntil = null;
  identity.lastLoginAt = new Date(now).toISOString();
  identity.updatedAt = identity.lastLoginAt;
}

function buildLegacySoapOutputText(soapInput = {}) {
  return [
    soapInput.subjective ? `S\n${soapInput.subjective}` : "",
    soapInput.objective ? `O\n${soapInput.objective}` : "",
    soapInput.assessment ? `A\n${soapInput.assessment}` : "",
    soapInput.plan ? `P\n${soapInput.plan}` : ""
  ].filter(Boolean).join("\n\n").trim();
}

function buildPatientSnapshot(input) {
  if (input.patientSnapshot) {
    return clone(input.patientSnapshot);
  }

  if (!input.patientDisplayName && !input.visitReason) {
    return null;
  }

  return {
    displayName: input.patientDisplayName || null,
    visitReason: input.visitReason || null
  };
}

function sessionMatchesSearch(session, keyword) {
  const query = String(keyword || "").trim().toLowerCase();

  if (!query) {
    return true;
  }

  return [
    session.sessionId,
    session.patientDisplayName,
    session.title,
    session.visitReason,
    session.status
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function buildSession(input, { sessionId, pairing, createdAt }) {
  const orgId = input.orgId || input.clinicId;
  const createdByMemberId = input.createdByMemberId || input.createdByUserId || "demo-doctor";
  const doctorMemberId = input.doctorMemberId || input.assignedDoctorUserId || createdByMemberId;

  if (!orgId) {
    throw new Error("orgId is required to create an encounter");
  }

  return {
    sessionId,
    encounterId: sessionId,
    orgId,
    clinicId: orgId,
    facilityId: input.facilityId || null,
    departmentId: input.departmentId || null,
    createdByMemberId,
    createdByUserId: createdByMemberId,
    doctorMemberId,
    assignedDoctorUserId: doctorMemberId,
    accessMemberIds: uniqueValues([createdByMemberId, doctorMemberId, ...(input.accessMemberIds || [])]),
    hiddenByMemberIds: [],
    status: "ready",
    pairingCode: pairing.shortCode,
    pairingTokenId: pairing.pairingId,
    title: input.title || null,
    patientId: input.patientId || null,
    patientSnapshot: buildPatientSnapshot(input),
    patientDisplayName: input.patientDisplayName || null,
    visitReason: input.visitReason || null,
    promptProfileId: input.promptProfileId || null,
    promptProfileSelectedAt: input.promptProfileSelectedAt || null,
    promptProfileSelectedByMemberId: input.promptProfileSelectedByMemberId || null,
    promptProfileSelectionSource: input.promptProfileSelectionSource || "default",
    latestSoapVersionId: null,
    startedAt: null,
    stoppedAt: null,
    recordingMaxDurationMinutes: DEFAULT_RECORDING_MAX_DURATION_MINUTES,
    recordingExpiresAt: null,
    recordingAutoStopTaskName: null,
    recordingStopReason: null,
    finalizedAt: null,
    approvedAt: null,
    lastSequenceNo: 0,
    liveSttProvider: "openai",
    finalSttProvider: "openai",
    soapProvider: "openai",
    mobileConnectionState: "disconnected",
    audioSourceType: input.audioSourceType || null,
    audioConnectionState: "disconnected",
    audioDeviceId: null,
    audioDeviceLabel: null,
    pcConnectionCount: 0,
    latestPartialPreview: null,
    latestFinalTurnIndex: 0,
    rawAudioPath: null,
    errorCode: null,
    errorMessageSafe: null,
    createdAt,
    updatedAt: createdAt
  };
}

function normalizeOrganizationBilling(billing = null, updatedAt = nowIso()) {
  if (!billing) {
    return null;
  }

  return {
    provider: billing.provider || "stripe",
    planCode: billing.planCode || "medical_ai_monthly",
    status: billing.status || "pending_checkout",
    stripeCustomerId: billing.stripeCustomerId || null,
    stripeSubscriptionId: billing.stripeSubscriptionId || null,
    stripePriceId: billing.stripePriceId || null,
    trialEndsAt: billing.trialEndsAt || null,
    currentPeriodEnd: billing.currentPeriodEnd || null,
    gracePeriodEndsAt: billing.gracePeriodEndsAt || null,
    cancelAtPeriodEnd: Boolean(billing.cancelAtPeriodEnd),
    seatQuantity: Math.max(1, Number(billing.seatQuantity || 1)),
    lastStripeEventId: billing.lastStripeEventId || null,
    updatedAt: billing.updatedAt || updatedAt
  };
}

function normalizeOrganizationAccess(access = null, updatedAt = nowIso()) {
  const source = access || {};
  return {
    status: source.status || "pending_setup",
    reason: source.reason || null,
    restrictedAt: source.restrictedAt || null,
    updatedAt: source.updatedAt || updatedAt
  };
}

function resolveAccessAfterPasswordSetup(organization, updatedAt = nowIso()) {
  const currentAccess = organization?.access || null;
  const currentStatus = currentAccess?.status || "pending_setup";
  const billingStatus = organization?.billing?.status || "active";

  if (currentStatus === "suspended" || currentStatus === "canceled") {
    return normalizeOrganizationAccess(currentAccess, updatedAt);
  }

  if (["past_due", "grace_period", "unpaid"].includes(billingStatus)) {
    return normalizeOrganizationAccess({
      ...currentAccess,
      status: "billing_action_required",
      reason: `billing.${billingStatus}`,
      restrictedAt: currentAccess?.restrictedAt || updatedAt
    }, updatedAt);
  }

  if (billingStatus === "canceled") {
    return normalizeOrganizationAccess({
      ...currentAccess,
      status: "canceled",
      reason: "billing.canceled",
      restrictedAt: currentAccess?.restrictedAt || updatedAt
    }, updatedAt);
  }

  return normalizeOrganizationAccess({
    ...currentAccess,
    status: "active",
    reason: null,
    restrictedAt: null
  }, updatedAt);
}

function isPasswordSetupTokenExpired(record, now = Date.now()) {
  return !record?.expiresAt || Date.parse(record.expiresAt) <= now;
}

function passwordSetupTokenInvalidError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function emailVerificationTokenInvalidError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createAudioTestRecord({ orgId, createdByMemberId, createdAt = nowIso() }) {
  const testId = createId("atest");
  const plainToken = createPlainToken();

  return {
    testId,
    orgId,
    createdByMemberId: createdByMemberId || null,
    tokenHash: hashToken(plainToken),
    plainToken,
    status: "active",
    deviceId: null,
    deviceLabel: null,
    permissionState: "unknown",
    deviceState: "waiting",
    level: 0,
    inputLabel: null,
    sampleRate: null,
    claimedAt: null,
    lastSeenAt: null,
    expiresAt: addMinutes(createdAt, AUDIO_TEST_TTL_MINUTES),
    createdAt,
    updatedAt: createdAt
  };
}

function isAudioTestExpired(record, now = Date.now()) {
  return !record?.expiresAt || Date.parse(record.expiresAt) <= now;
}

function publicAudioTest(record) {
  const { plainToken: _plainToken, tokenHash: _tokenHash, ...publicRecord } = record;
  return clone(publicRecord);
}

export class InMemoryStore {
  constructor(options = {}) {
    this.options = options;
    this.allowRuntimeBootstrap = Boolean(options.allowRuntimeBootstrap);
    this.organizations = new Map();
    this.organizationCodes = new Map();
    this.members = new Map();
    this.identities = new Map();
    this.roleDefinitions = new Map(MEMBER_ROLE_DEFINITIONS.map((role) => [role.roleId, clone(role)]));
    this.sessions = new Map();
    this.sessionIndex = new Map();
    this.pairings = new Map();
    this.turns = new Map();
    this.soaps = new Map();
    this.auditEvents = new Map();
    this.organizationAuditEvents = new Map();
    this.promptProfiles = new Map();
    this.rateLimitBuckets = new Map();
    this.trustedRecorders = new Map();
    this.audioTests = new Map();
    this.signupApplications = new Map();
    this.emailVerificationTokens = new Map();
    this.stripeEventReceipts = new Map();
    this.passwordSetupTokens = new Map();
  }

  async authenticateMember({
    organizationCode,
    loginId,
    password,
    bootstrapPassword = "",
    defaultOrganizationCode = "clinic_tokyo_001",
    defaultLoginId = "admin",
    defaultOrgId = "org_default",
    defaultDisplayName = "管理者"
  }) {
    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const normalizedLoginId = normalizeLoginIdentifier(loginId);
    const identityKey = buildLoginIdentityKey(normalizedOrganizationCode, normalizedLoginId);
    let identity = this.identities.get(identityKey) || null;

    if (
      !identity &&
      this.allowRuntimeBootstrap &&
      bootstrapPassword &&
      password === bootstrapPassword &&
      normalizedOrganizationCode === normalizeLoginIdentifier(defaultOrganizationCode) &&
      normalizedLoginId === normalizeLoginIdentifier(defaultLoginId)
    ) {
      identity = await this.#bootstrapIdentity({
        organizationCode: normalizedOrganizationCode,
        loginId: normalizedLoginId,
        password,
        defaultOrgId,
        defaultDisplayName
      });
    }

    if (!identity || identity.status !== "active" || isLocked(identity)) {
      return null;
    }

    if (!verifyPassword(password, identity.passwordHash)) {
      recordFailedLogin(identity);
      this.identities.set(identity.identityId, identity);
      await this.appendOrganizationAuditEvent(identity.orgId, {
        type: "auth.login_failed",
        actorId: null,
        safePayload: {
          loginId: normalizedLoginId,
          reason: identity.lockedUntil ? "account_locked" : "bad_credentials"
        }
      });
      return null;
    }

    const organization = this.organizations.get(identity.orgId);
    const member = this.members.get(`${identity.orgId}:${identity.memberId}`);

    if (!organization || organization.status !== "active" || !member || member.status !== "active") {
      return null;
    }

    resetFailedLoginState(identity);
    this.identities.set(identity.identityId, identity);

    return {
      organization: clone(organization),
      member: clone(member),
      identity: {
        organizationCode: identity.organizationCode,
        loginId: identity.loginId,
        tokenVersion: Number(identity.tokenVersion || 0),
        mfaRequired: Boolean(identity.mfaRequired),
        mfaEnrolledAt: identity.mfaEnrolledAt || null,
        mfaSecretEncrypted: identity.mfaSecretEncrypted || null
      }
    };
  }

  async listOrganizations() {
    return Array.from(this.organizations.values())
      .sort((left, right) => String(left.displayName || "").localeCompare(String(right.displayName || ""), "ja"))
      .map((organization) => clone(organization));
  }

  async getOrganization(orgId) {
    const organization = this.organizations.get(orgId);
    return organization ? clone(organization) : null;
  }

  async getOrganizationByCode(organizationCode) {
    const orgId = this.organizationCodes.get(normalizeLoginIdentifier(organizationCode));
    return orgId ? clone(this.organizations.get(orgId) || null) : null;
  }

  async getLoginIdentity({ organizationCode, loginId } = {}) {
    if (!organizationCode || !loginId) {
      return null;
    }

    const identity = this.identities.get(buildLoginIdentityKey(
      normalizeLoginIdentifier(organizationCode),
      normalizeLoginIdentifier(loginId)
    ));
    return identity ? clone(identity) : null;
  }

  async createSignupApplication(input = {}) {
    const createdAt = nowIso();
    const signup = {
      signupId: input.signupId || createId("signup"),
      organizationCode: normalizeLoginIdentifier(input.organizationCode),
      displayName: input.displayName,
      adminLoginId: normalizeLoginIdentifier(input.adminLoginId),
      adminDisplayName: input.adminDisplayName,
      adminEmail: String(input.adminEmail || "").trim().toLowerCase(),
      planCode: input.planCode || "medical_ai_monthly",
      source: input.source || null,
      organizationName: input.organizationName || input.displayName || null,
      adminName: input.adminName || input.adminDisplayName || null,
      phoneNumber: input.phoneNumber || null,
      seatEstimate: Number.isInteger(input.seatEstimate) ? input.seatEstimate : null,
      notes: input.notes || null,
      consentAcceptedAt: input.consentAcceptedAt || null,
      consentVersion: input.consentVersion || null,
      consentTermsUrl: input.consentTermsUrl || null,
      consentPrivacyUrl: input.consentPrivacyUrl || null,
      consentClientIp: input.consentClientIp || null,
      consentUserAgent: input.consentUserAgent || null,
      emailVerifiedAt: input.emailVerifiedAt || null,
      expiresAt: input.expiresAt || null,
      status: input.status || "draft",
      stripeCustomerId: input.stripeCustomerId || null,
      stripeSubscriptionId: input.stripeSubscriptionId || null,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId || null,
      orgId: input.orgId || null,
      memberId: input.memberId || null,
      passwordSetupTokenId: input.passwordSetupTokenId || null,
      slackProvisionedNotificationSentAt: input.slackProvisionedNotificationSentAt || null,
      slackProvisionedNotificationErrorAt: input.slackProvisionedNotificationErrorAt || null,
      slackProvisionedNotificationErrorMessageSafe: input.slackProvisionedNotificationErrorMessageSafe || null,
      errorCode: input.errorCode || null,
      errorMessageSafe: input.errorMessageSafe || null,
      createdAt,
      updatedAt: createdAt
    };

    this.signupApplications.set(signup.signupId, signup);
    return clone(signup);
  }

  async getSignupApplication(signupId) {
    const signup = this.signupApplications.get(signupId);
    return signup ? clone(signup) : null;
  }

  async updateSignupApplication(signupId, patch = {}) {
    const signup = this.signupApplications.get(signupId);

    if (!signup) {
      return null;
    }

    const updated = {
      ...signup,
      ...clone(patch),
      updatedAt: patch.updatedAt || nowIso()
    };
    this.signupApplications.set(signupId, updated);
    return clone(updated);
  }

  async listSignupApplications({ status = null, limit = 100 } = {}) {
    return Array.from(this.signupApplications.values())
      .filter((signup) => !status || signup.status === status)
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
      .slice(0, limit)
      .map((signup) => clone(signup));
  }

  async findPendingSignupApplication({ organizationCode, adminLoginId } = {}) {
    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const normalizedLoginId = normalizeLoginIdentifier(adminLoginId);
    const activeStatuses = new Set(["draft", "checkout_created", "checkout_completed", "provisioning"]);

    const found = Array.from(this.signupApplications.values())
      .filter((signup) => signup.organizationCode === normalizedOrganizationCode)
      .find((signup) => signup.adminLoginId === normalizedLoginId && activeStatuses.has(signup.status));

    return found ? clone(found) : null;
  }

  async findActiveContactSignupApplication({ adminEmail } = {}) {
    const normalizedEmail = String(adminEmail || "").trim().toLowerCase();
    const activeStatuses = new Set(["submitted", "verified", "provisioning"]);

    const found = Array.from(this.signupApplications.values())
      .find((signup) => (
        signup.source === "lp_contact_form" &&
        signup.adminEmail === normalizedEmail &&
        activeStatuses.has(signup.status)
      ));

    return found ? clone(found) : null;
  }

  async findSignupApplicationByOrgId(orgId) {
    if (!orgId) {
      return null;
    }

    const found = Array.from(this.signupApplications.values())
      .filter((signup) => signup.orgId === orgId)
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0];

    return found ? clone(found) : null;
  }

  async findSignupApplicationByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) {
      return null;
    }

    const found = Array.from(this.signupApplications.values())
      .filter((signup) => signup.stripeSubscriptionId === stripeSubscriptionId)
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0];

    return found ? clone(found) : null;
  }

  async findSignupApplicationByStripeCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) {
      return null;
    }

    const found = Array.from(this.signupApplications.values())
      .filter((signup) => signup.stripeCustomerId === stripeCustomerId)
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0];

    return found ? clone(found) : null;
  }

  async createEmailVerificationToken(input = {}) {
    const createdAt = nowIso();
    const tokenId = input.tokenId || createPlainToken();
    const tokenHash = hashToken(tokenId);
    const record = {
      tokenHash,
      signupId: input.signupId,
      email: String(input.email || "").trim().toLowerCase(),
      status: input.status || "active",
      expiresAt: input.expiresAt || addMinutes(createdAt, 60 * 24),
      consumedAt: input.consumedAt || null,
      createdAt,
      updatedAt: createdAt
    };

    this.emailVerificationTokens.set(tokenHash, record);
    return {
      tokenId,
      record: clone({
        ...record,
        tokenId
      })
    };
  }

  async getEmailVerificationToken(tokenId, { includeInactive = false } = {}) {
    const tokenHash = hashToken(tokenId);
    const record = this.emailVerificationTokens.get(tokenHash);

    if (!record) {
      return null;
    }

    if (record.status === "active" && (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now())) {
      record.status = "expired";
      record.updatedAt = nowIso();
      this.emailVerificationTokens.set(tokenHash, record);
    }

    if (!includeInactive && record.status !== "active") {
      return null;
    }

    return clone({
      ...record,
      tokenId
    });
  }

  async consumeEmailVerificationToken({ tokenId } = {}) {
    const tokenHash = hashToken(tokenId);
    const record = this.emailVerificationTokens.get(tokenHash);

    if (!record) {
      throw emailVerificationTokenInvalidError("確認リンクが見つかりません。");
    }

    if (record.status !== "active") {
      throw emailVerificationTokenInvalidError("確認リンクはすでに無効です。");
    }

    if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) {
      record.status = "expired";
      record.updatedAt = nowIso();
      this.emailVerificationTokens.set(tokenHash, record);
      throw emailVerificationTokenInvalidError("確認リンクの有効期限が切れています。");
    }

    const updatedAt = nowIso();
    const updated = {
      ...record,
      status: "used",
      consumedAt: updatedAt,
      updatedAt
    };
    this.emailVerificationTokens.set(tokenHash, updated);

    return clone({
      ...updated,
      tokenId
    });
  }

  async createStripeEventReceipt(input = {}) {
    const eventId = String(input.eventId || "").trim();

    if (!eventId) {
      throw new Error("eventId is required.");
    }

    const existing = this.stripeEventReceipts.get(eventId);
    if (existing) {
      return clone(existing);
    }

    const createdAt = nowIso();
    const receipt = {
      eventId,
      type: input.type || null,
      livemode: Boolean(input.livemode),
      apiVersion: input.apiVersion || null,
      objectId: input.objectId || null,
      payloadHash: input.payloadHash || null,
      payload: input.payload || null,
      status: input.status || "received",
      processedAt: input.processedAt || null,
      errorMessageSafe: input.errorMessageSafe || null,
      createdAt,
      updatedAt: createdAt
    };

    this.stripeEventReceipts.set(eventId, receipt);
    return clone(receipt);
  }

  async getStripeEventReceipt(eventId) {
    const receipt = this.stripeEventReceipts.get(eventId);
    return receipt ? clone(receipt) : null;
  }

  async updateStripeEventReceipt(eventId, patch = {}) {
    const receipt = this.stripeEventReceipts.get(eventId);

    if (!receipt) {
      return null;
    }

    const updated = {
      ...receipt,
      ...clone(patch),
      updatedAt: patch.updatedAt || nowIso()
    };
    this.stripeEventReceipts.set(eventId, updated);
    return clone(updated);
  }

  async createPasswordSetupToken(input = {}) {
    const createdAt = nowIso();
    const tokenId = input.tokenId || createPlainToken();
    const tokenHash = hashToken(tokenId);
    const record = {
      tokenHash,
      orgId: input.orgId,
      memberId: input.memberId,
      organizationDisplayName: input.organizationDisplayName || null,
      memberDisplayName: input.memberDisplayName || null,
      email: input.email || null,
      status: input.status || "active",
      expiresAt: input.expiresAt || addMinutes(createdAt, 60 * 24),
      usedAt: input.usedAt || null,
      createdAt,
      updatedAt: createdAt
    };

    this.passwordSetupTokens.set(tokenHash, record);
    return {
      tokenId,
      record: clone({
        ...record,
        tokenId
      })
    };
  }

  async getPasswordSetupToken(tokenId, { includeInactive = false } = {}) {
    const tokenHash = hashToken(tokenId);
    const record = this.passwordSetupTokens.get(tokenHash);

    if (!record) {
      return null;
    }

    if (record.status === "active" && isPasswordSetupTokenExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
      this.passwordSetupTokens.set(tokenHash, record);
    }

    if (!includeInactive && record.status !== "active") {
      return null;
    }

    return clone({
      ...record,
      tokenId
    });
  }

  async consumePasswordSetupToken({ tokenId, password, actorId } = {}) {
    assertPasswordPolicy(password);

    const tokenHash = hashToken(tokenId);
    const record = this.passwordSetupTokens.get(tokenHash);

    if (!record) {
      throw passwordSetupTokenInvalidError("初回設定リンクが見つかりません。");
    }

    if (record.status !== "active") {
      throw passwordSetupTokenInvalidError("初回設定リンクはすでに無効です。");
    }

    if (isPasswordSetupTokenExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
      this.passwordSetupTokens.set(tokenHash, record);
      throw passwordSetupTokenInvalidError("初回設定リンクの有効期限が切れています。");
    }

    const organization = this.organizations.get(record.orgId);
    const memberKey = `${record.orgId}:${record.memberId}`;
    const member = this.members.get(memberKey);

    if (!organization || !member) {
      throw passwordSetupTokenInvalidError("初回設定の対象アカウントが見つかりません。");
    }

    const identityKey = buildLoginIdentityKey(organization.organizationCode, member.loginId);
    const identity = this.identities.get(identityKey);

    if (!identity) {
      throw passwordSetupTokenInvalidError("初回設定のログイン情報が見つかりません。");
    }

    const updatedAt = nowIso();
    identity.passwordHash = hashPassword(password);
    identity.status = "active";
    identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
    identity.failedLoginCount = 0;
    identity.lockedUntil = null;
    identity.lastFailedLoginAt = null;
    identity.updatedAt = updatedAt;
    member.updatedAt = updatedAt;
    organization.access = resolveAccessAfterPasswordSetup(organization, updatedAt);
    organization.updatedAt = updatedAt;
    record.status = "used";
    record.usedAt = updatedAt;
    record.updatedAt = updatedAt;

    this.identities.set(identityKey, identity);
    this.members.set(memberKey, member);
    this.organizations.set(record.orgId, organization);
    this.passwordSetupTokens.set(tokenHash, record);

    await this.appendOrganizationAuditEvent(record.orgId, {
      type: "billing.password_setup.completed",
      actorType: actorId ? "user" : "system",
      actorId: actorId || record.memberId,
      safePayload: {
        memberId: record.memberId
      }
    });

    return {
      organization: clone(organization),
      member: clone(member),
      token: clone({
        ...record,
        tokenId
      })
    };
  }

  async updateOrganizationBilling({ orgId, patch = {}, actorId = null, auditType = "billing.subscription.updated" } = {}) {
    const organization = this.organizations.get(orgId);

    if (!organization) {
      return null;
    }

    const updatedAt = patch.updatedAt || nowIso();
    organization.billing = normalizeOrganizationBilling({
      ...(organization.billing || {}),
      ...clone(patch)
    }, updatedAt);
    organization.updatedAt = updatedAt;
    this.organizations.set(orgId, organization);

    await this.appendOrganizationAuditEvent(orgId, {
      type: auditType,
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        status: organization.billing?.status || null,
        planCode: organization.billing?.planCode || null
      }
    });

    return clone(organization);
  }

  async updateOrganizationAccess({ orgId, patch = {}, actorId = null, auditType = "billing.access.updated" } = {}) {
    const organization = this.organizations.get(orgId);

    if (!organization) {
      return null;
    }

    const updatedAt = patch.updatedAt || nowIso();
    organization.access = normalizeOrganizationAccess({
      ...(organization.access || {}),
      ...clone(patch)
    }, updatedAt);
    organization.updatedAt = updatedAt;
    this.organizations.set(orgId, organization);

    await this.appendOrganizationAuditEvent(orgId, {
      type: auditType,
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        status: organization.access?.status || null,
        reason: organization.access?.reason || null
      }
    });

    return clone(organization);
  }

  async provisionOrganizationWithAdminMember({
    organizationCode,
    displayName,
    adminLoginId,
    adminDisplayName,
    adminEmail = null,
    billing = null,
    access = null,
    actorId = null
  }) {
    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const normalizedLoginId = normalizeLoginIdentifier(adminLoginId);
    const identityKey = buildLoginIdentityKey(normalizedOrganizationCode, normalizedLoginId);

    if (this.organizationCodes.has(normalizedOrganizationCode)) {
      throw new Error("この病院コードはすでに使われています。");
    }

    if (this.identities.has(identityKey)) {
      throw new Error("この個人IDはすでに使われています。");
    }

    const createdAt = nowIso();
    const orgId = createId("org");
    const memberId = createId("mem");
    const organization = {
      orgId,
      clinicId: orgId,
      organizationCode: normalizedOrganizationCode,
      displayName,
      status: "active",
      timezone: "Asia/Tokyo",
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      recordingMaxDurationMinutes: DEFAULT_RECORDING_MAX_DURATION_MINUTES,
      retentionPolicy: {
        audioDays: 90,
        transcriptDays: 365,
        auditDays: 365
      },
      featureFlags: {},
      billing: normalizeOrganizationBilling(billing, createdAt),
      access: normalizeOrganizationAccess(access, createdAt),
      createdAt,
      updatedAt: createdAt
    };
    const member = {
      memberId,
      userId: memberId,
      orgId,
      clinicId: orgId,
      loginId: normalizedLoginId,
      displayName: adminDisplayName,
      email: adminEmail ? String(adminEmail).trim().toLowerCase() : null,
      roles: ["org_admin", "doctor"],
      facilityIds: [],
      departmentIds: [],
      specialty: null,
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      defaultRecordingSource: DEFAULT_RECORDING_SOURCE,
      status: "active",
      mfaRequired: true,
      mfaEnrolledAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const identity = {
      identityId: identityKey,
      organizationCode: normalizedOrganizationCode,
      loginId: normalizedLoginId,
      orgId,
      memberId,
      passwordHash: null,
      status: "pending_password_setup",
      tokenVersion: 0,
      failedLoginCount: 0,
      lockedUntil: null,
      mfaRequired: true,
      mfaEnrolledAt: null,
      mfaSecretEncrypted: null,
      createdAt,
      updatedAt: createdAt
    };

    this.organizations.set(orgId, organization);
    this.organizationCodes.set(normalizedOrganizationCode, orgId);
    this.promptProfiles.set(`${orgId}:${DEFAULT_PROMPT_PROFILE.profileId}`, {
      ...clone(DEFAULT_PROMPT_PROFILE),
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    this.members.set(`${orgId}:${memberId}`, member);
    this.identities.set(identity.identityId, identity);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "billing.provisioning.completed",
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        organizationCode: normalizedOrganizationCode,
        adminLoginId: normalizedLoginId
      }
    });
    return {
      organization: clone(organization),
      member: clone(member)
    };
  }

  async updateOrganizationRecordingPolicy({ orgId, recordingMaxDurationMinutes, actorId }) {
    const organization = this.organizations.get(orgId);

    if (!organization) {
      return null;
    }

    const updatedAt = nowIso();
    const nextMinutes = normalizeRecordingMaxDurationMinutes(recordingMaxDurationMinutes);
    const previousRecordingMaxDurationMinutes = normalizeRecordingMaxDurationMinutes(
      organization.recordingMaxDurationMinutes
    );

    organization.recordingMaxDurationMinutes = nextMinutes;
    organization.updatedAt = updatedAt;

    await this.appendOrganizationAuditEvent(orgId, {
      type: "organization.recording_policy_updated",
      actorId,
      safePayload: {
        previousRecordingMaxDurationMinutes,
        recordingMaxDurationMinutes: nextMinutes
      }
    });

    return clone(organization);
  }

  async createOrganizationWithAdminMember({
    organizationCode,
    displayName,
    adminLoginId,
    adminDisplayName,
    adminPassword,
    actorId
  }) {
    assertPasswordPolicy(adminPassword);

    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const normalizedLoginId = normalizeLoginIdentifier(adminLoginId);
    const identityKey = buildLoginIdentityKey(normalizedOrganizationCode, normalizedLoginId);

    if (this.organizationCodes.has(normalizedOrganizationCode)) {
      throw new Error("この病院コードはすでに使われています。");
    }

    if (this.identities.has(identityKey)) {
      throw new Error("この個人IDはすでに使われています。");
    }

    const createdAt = nowIso();
    const orgId = createId("org");
    const memberId = createId("mem");
    const organization = {
      orgId,
      clinicId: orgId,
      organizationCode: normalizedOrganizationCode,
      displayName,
      status: "active",
      timezone: "Asia/Tokyo",
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      recordingMaxDurationMinutes: DEFAULT_RECORDING_MAX_DURATION_MINUTES,
      retentionPolicy: {
        audioDays: 90,
        transcriptDays: 365,
        auditDays: 365
      },
      featureFlags: {},
      createdAt,
      updatedAt: createdAt
    };
    const member = {
      memberId,
      userId: memberId,
      orgId,
      clinicId: orgId,
      loginId: normalizedLoginId,
      displayName: adminDisplayName,
      roles: ["org_admin", "doctor"],
      facilityIds: [],
      departmentIds: [],
      specialty: null,
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      defaultRecordingSource: DEFAULT_RECORDING_SOURCE,
      status: "active",
      mfaRequired: true,
      mfaEnrolledAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const identity = {
      identityId: identityKey,
      organizationCode: normalizedOrganizationCode,
      loginId: normalizedLoginId,
      orgId,
      memberId,
      passwordHash: hashPassword(adminPassword),
      status: "active",
      tokenVersion: 0,
      failedLoginCount: 0,
      lockedUntil: null,
      mfaRequired: true,
      mfaEnrolledAt: null,
      mfaSecretEncrypted: null,
      createdAt,
      updatedAt: createdAt
    };

    this.organizations.set(orgId, organization);
    this.organizationCodes.set(normalizedOrganizationCode, orgId);
    this.promptProfiles.set(`${orgId}:${DEFAULT_PROMPT_PROFILE.profileId}`, {
      ...clone(DEFAULT_PROMPT_PROFILE),
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    this.members.set(`${orgId}:${memberId}`, member);
    this.identities.set(identity.identityId, identity);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "organization.created",
      actorId,
      safePayload: {
        organizationCode: normalizedOrganizationCode,
        adminLoginId: normalizedLoginId
      }
    });
    return {
      organization: clone(organization),
      member: clone(member)
    };
  }

  async createMember({ orgId, loginId, displayName, password, roles = ["doctor"], defaultRecordingSource = DEFAULT_RECORDING_SOURCE, actorId }) {
    assertPasswordPolicy(password);

    const organization = this.organizations.get(orgId);

    if (!organization || organization.status !== "active") {
      throw new Error("病院が見つかりません。");
    }

    const normalizedLoginId = normalizeLoginIdentifier(loginId);
    const identityKey = buildLoginIdentityKey(organization.organizationCode, normalizedLoginId);

    if (this.identities.has(identityKey)) {
      throw new Error("この個人IDはすでに使われています。");
    }

    const createdAt = nowIso();
    const memberId = createId("mem");
    const member = {
      memberId,
      userId: memberId,
      orgId,
      clinicId: orgId,
      loginId: normalizedLoginId,
      displayName,
      roles: uniqueValues(roles),
      facilityIds: [],
      departmentIds: [],
      specialty: null,
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      defaultRecordingSource: normalizeRecordingSource(defaultRecordingSource),
      status: "active",
      mfaRequired: rolesRequireMfa(uniqueValues(roles)),
      mfaEnrolledAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const identity = {
      identityId: identityKey,
      organizationCode: organization.organizationCode,
      loginId: normalizedLoginId,
      orgId,
      memberId,
      passwordHash: hashPassword(password),
      status: "active",
      tokenVersion: 0,
      failedLoginCount: 0,
      lockedUntil: null,
      mfaRequired: rolesRequireMfa(member.roles),
      mfaEnrolledAt: null,
      mfaSecretEncrypted: null,
      createdAt,
      updatedAt: createdAt
    };

    this.members.set(`${orgId}:${memberId}`, member);
    this.identities.set(identity.identityId, identity);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.created",
      actorId,
      safePayload: {
        memberId,
        loginId: normalizedLoginId,
        roles: member.roles
      }
    });
    return clone(member);
  }

  async resetMemberPassword({ orgId, memberId, password, actorId }) {
    assertPasswordPolicy(password);

    const organization = this.organizations.get(orgId);
    const member = this.members.get(`${orgId}:${memberId}`);

    if (!organization || !member) {
      throw new Error("医師が見つかりません。");
    }

    const identityKey = buildLoginIdentityKey(organization.organizationCode, member.loginId);
    const identity = this.identities.get(identityKey);

    if (!identity) {
      throw new Error("ログイン情報が見つかりません。");
    }

    const updatedAt = nowIso();
    identity.passwordHash = hashPassword(password);
    identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
    identity.failedLoginCount = 0;
    identity.lockedUntil = null;
    identity.lastFailedLoginAt = null;
    identity.updatedAt = updatedAt;
    member.updatedAt = updatedAt;
    this.identities.set(identityKey, identity);
    this.members.set(`${orgId}:${memberId}`, member);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.password_reset",
      actorId,
      safePayload: {
        memberId,
        loginId: member.loginId
      }
    });
    return clone(member);
  }

  async createSession(input) {
    const createdAt = nowIso();
    const sessionId = createId("ses");
    const orgId = input.orgId || input.clinicId;
    const pairing = this.#createPairingArtifacts(sessionId, orgId, createdAt);
    const session = buildSession(input, { sessionId, pairing, createdAt });

    this.sessions.set(sessionId, session);
    this.sessionIndex.set(sessionId, { orgId: session.orgId, sessionId });
    this.pairings.set(pairing.pairingId, pairing);
    this.turns.set(sessionId, []);
    this.soaps.set(sessionId, []);
    this.auditEvents.set(sessionId, []);

    await this.appendAuditEvent(sessionId, {
      type: "encounter.created",
      actorType: "user",
      actorId: session.createdByMemberId,
      safePayload: {
        orgId: session.orgId,
        facilityId: session.facilityId,
        departmentId: session.departmentId
      }
    });

    return {
      session: clone(session),
      pairing: this.#publicPairing(pairing),
      plainToken: pairing.plainToken
    };
  }

  async refreshPairing(sessionId) {
    const session = this.#mustGetSession(sessionId);
    const createdAt = nowIso();
    const pairing = this.#createPairingArtifacts(sessionId, session.orgId, createdAt);

    if (session.pairingTokenId && this.pairings.has(session.pairingTokenId)) {
      const previousPairing = this.pairings.get(session.pairingTokenId);
      previousPairing.status = "revoked";
    }

    this.pairings.set(pairing.pairingId, pairing);
    session.pairingCode = pairing.shortCode;
    session.pairingTokenId = pairing.pairingId;
    session.updatedAt = createdAt;

    await this.appendAuditEvent(sessionId, {
      type: "pairing.created",
      actorType: "user",
      actorId: session.createdByMemberId,
      safePayload: {
        pairingId: pairing.pairingId
      }
    });

    return {
      pairing: this.#publicPairing(pairing),
      plainToken: pairing.plainToken
    };
  }

  async getSessionState(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    const pairing = this.pairings.get(session.pairingTokenId) || null;
    const turns = this.turns.get(sessionId) || [];
    const latestSoap = (this.soaps.get(sessionId) || []).at(-1) || null;

    return {
      session: clone(session),
      pairing: pairing ? this.#publicPairing(pairing) : null,
      turns: clone(turns),
      latestSoap: latestSoap ? clone(latestSoap) : null
    };
  }

  async listSessions({ orgId = null, memberId = null, roles = [], statuses = [], search = "", page = 1, pageSize = 20 } = {}) {
    const canReadAllSessions = canReadOrganizationSessionsRoles(roles);
    const filtered = Array.from(this.sessions.values())
      .filter((session) => !orgId || session.orgId === orgId || session.clinicId === orgId)
      .filter((session) => !memberId || canReadAllSessions || (session.accessMemberIds || []).includes(memberId))
      .filter((session) => !memberId || !(session.hiddenByMemberIds || []).includes(memberId))
      .filter((session) => !Array.isArray(statuses) || statuses.length === 0 || statuses.includes(session.status))
      .filter((session) => sessionMatchesSearch(session, search))
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
      .map((session) => clone(session));
    const totalCount = filtered.length;
    const safePageSize = Math.max(1, pageSize);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / safePageSize) : 0;
    const safePage = totalPages > 0 ? Math.min(Math.max(1, page), totalPages) : 1;
    const startIndex = (safePage - 1) * safePageSize;

    return {
      sessions: filtered.slice(startIndex, startIndex + safePageSize),
      page: safePage,
      pageSize: safePageSize,
      totalCount,
      totalPages
    };
  }

  async hideSessionForMember(sessionId, { memberId, actorId = memberId } = {}) {
    const session = this.#mustGetSession(sessionId);

    if (!memberId) {
      const error = new Error("memberId is required to hide a session");
      error.statusCode = 400;
      throw error;
    }

    session.hiddenByMemberIds = uniqueValues([...(session.hiddenByMemberIds || []), memberId]);
    session.updatedAt = nowIso();

    await this.appendAuditEvent(sessionId, {
      type: "encounter.hidden_from_home",
      actorType: "user",
      actorId,
      safePayload: {
        memberId
      }
    });

    return clone(session);
  }

  async claimPairing(pairingId, { token, deviceId, clinicId = null, orgId = null }) {
    const pairing = this.pairings.get(pairingId);

    if (!pairing) {
      return null;
    }

    const session = this.#mustGetSession(pairing.sessionId);
    const expectedOrgId = orgId || clinicId;

    if (expectedOrgId && session.orgId !== expectedOrgId && session.clinicId !== expectedOrgId) {
      return null;
    }

    if (session.pairingTokenId !== pairingId) {
      pairing.status = "revoked";
      return null;
    }

    if (pairing.status !== "active") {
      return null;
    }

    if (Date.parse(pairing.expiresAt) < Date.now()) {
      pairing.status = "expired";
      return null;
    }

    if (pairing.tokenHash !== hashToken(token)) {
      return null;
    }

    pairing.status = "claimed";
    pairing.claimedByDeviceId = deviceId;
    pairing.claimedAt = nowIso();

    const keepsLocalAudioSource = session.audioSourceType === "local_browser";

    session.status = session.status === "ready" ? "paired" : session.status;
    session.mobileConnectionState = "connected";
    if (!keepsLocalAudioSource) {
      session.audioSourceType = "linked_mobile";
      session.audioConnectionState = "connected";
      session.audioDeviceId = deviceId;
      session.audioDeviceLabel = "録音用スマホ";
    }
    session.updatedAt = nowIso();

    await this.appendAuditEvent(pairing.sessionId, {
      type: "pairing.claimed",
      actorType: "device",
      actorId: deviceId,
      safePayload: {
        pairingId
      }
    });

    return {
      session: clone(session),
      pairing: this.#publicPairing(pairing)
    };
  }

  async createAudioTest({ orgId, createdByMemberId = null } = {}) {
    if (!orgId) {
      throw new Error("orgId is required to create an audio test");
    }

    const record = createAudioTestRecord({
      orgId,
      createdByMemberId
    });
    this.audioTests.set(record.testId, record);
    return {
      audioTest: publicAudioTest(record),
      plainToken: record.plainToken
    };
  }

  async getAudioTest(testId) {
    const record = this.audioTests.get(testId);

    if (!record) {
      return null;
    }

    if (isAudioTestExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
    }

    return publicAudioTest(record);
  }

  async claimAudioTest(testId, { token, deviceId, deviceLabel = null } = {}) {
    const record = this.audioTests.get(testId);

    if (!record) {
      return null;
    }

    if (record.tokenHash !== hashToken(token)) {
      return null;
    }

    if (isAudioTestExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
      return null;
    }

    if (record.deviceId && record.deviceId !== deviceId) {
      const error = new Error("このテストは別のiPhoneで使用中です。PCで新しいQRを発行してください。");
      error.statusCode = 409;
      throw error;
    }

    record.deviceId = deviceId;
    record.deviceLabel = deviceLabel || record.deviceLabel || null;
    record.deviceState = "connected";
    record.claimedAt = record.claimedAt || nowIso();
    record.lastSeenAt = nowIso();
    record.updatedAt = record.lastSeenAt;

    return publicAudioTest(record);
  }

  async updateAudioTestState(testId, {
    token,
    deviceId,
    permissionState,
    deviceState,
    level,
    inputLabel,
    sampleRate,
    deviceLabel = null
  } = {}) {
    const record = this.audioTests.get(testId);

    if (!record) {
      return null;
    }

    if (record.tokenHash !== hashToken(token)) {
      return null;
    }

    if (isAudioTestExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
      return null;
    }

    if (record.deviceId && record.deviceId !== deviceId) {
      return null;
    }

    const updatedAt = nowIso();
    record.deviceId = deviceId;
    record.deviceLabel = deviceLabel || record.deviceLabel || null;
    record.permissionState = permissionState || record.permissionState || "unknown";
    record.deviceState = deviceState || record.deviceState || "connected";
    record.level = Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : (record.level || 0);
    record.inputLabel = inputLabel || record.inputLabel || null;
    record.sampleRate = Number.isFinite(sampleRate) ? Number(sampleRate) : (record.sampleRate || null);
    record.lastSeenAt = updatedAt;
    record.updatedAt = updatedAt;

    return publicAudioTest(record);
  }

  async completeAudioTest(testId, { token = null, deviceId = null, actorId = null } = {}) {
    const record = this.audioTests.get(testId);

    if (!record) {
      return null;
    }

    if (token && record.tokenHash !== hashToken(token)) {
      return null;
    }

    if (deviceId && record.deviceId && record.deviceId !== deviceId) {
      return null;
    }

    if (!token && !actorId) {
      return null;
    }

    const updatedAt = nowIso();
    record.status = "completed";
    record.deviceState = "idle";
    record.level = 0;
    record.updatedAt = updatedAt;
    record.lastSeenAt = updatedAt;

    return publicAudioTest(record);
  }

  async updateSession(sessionId, patch) {
    const session = this.#mustGetSession(sessionId);
    Object.assign(session, patch);
    session.updatedAt = patch.updatedAt || nowIso();
    return clone(session);
  }

  async updateSessionPromptProfile(sessionId, { promptProfileId, actorId }) {
    const session = this.#mustGetSession(sessionId);
    const versions = this.soaps.get(sessionId) || [];

    if (!["ready", "paired", "degraded_recording", "stopped"].includes(session.status)) {
      const error = new Error("録音中またはSOAP下書き作成後はプロンプトを変更できません。");
      error.statusCode = 409;
      error.publicMessage = "録音中またはSOAP下書き作成後はプロンプトを変更できません。";
      throw error;
    }

    if (session.latestSoapVersionId || versions.length > 0) {
      const error = new Error("SOAP下書き作成後はプロンプトを変更できません。");
      error.statusCode = 409;
      error.publicMessage = "SOAP下書き作成後はプロンプトを変更できません。";
      throw error;
    }

    const updatedAt = nowIso();
    const previousPromptProfileId = session.promptProfileId || null;
    session.promptProfileId = promptProfileId;
    session.promptProfileSelectedAt = updatedAt;
    session.promptProfileSelectedByMemberId = actorId || null;
    session.promptProfileSelectionSource = "manual";
    session.updatedAt = updatedAt;

    await this.appendAuditEvent(sessionId, {
      type: "session.prompt_profile_updated",
      actorType: "user",
      actorId,
      safePayload: {
        previousPromptProfileId,
        promptProfileId
      }
    });

    return clone(session);
  }

  async startRecording(sessionId, {
    deviceId,
    audioSourceType = "linked_mobile",
    deviceLabel = null,
    recordingMaxDurationMinutes = DEFAULT_RECORDING_MAX_DURATION_MINUTES,
    recordingExpiresAt = null,
    recordingAutoStopTaskName = null
  }) {
    const session = this.#mustGetSession(sessionId);
    const startedAt = nowIso();
    session.status = "recording";
    session.startedAt = startedAt;
    session.recordingMaxDurationMinutes = normalizeRecordingMaxDurationMinutes(recordingMaxDurationMinutes);
    session.recordingExpiresAt = recordingExpiresAt;
    session.recordingAutoStopTaskName = recordingAutoStopTaskName;
    session.recordingStopReason = null;
    session.mobileConnectionState = audioSourceType === "linked_mobile" ? "recording" : session.mobileConnectionState || "disconnected";
    session.audioSourceType = audioSourceType;
    session.audioConnectionState = "recording";
    session.audioDeviceId = deviceId;
    session.audioDeviceLabel = deviceLabel || (audioSourceType === "local_browser" ? "この端末のマイク" : "録音用スマホ");
    session.updatedAt = startedAt;

    await this.appendAuditEvent(sessionId, {
      type: "recording.started",
      actorType: "device",
      actorId: deviceId,
      safePayload: {
        recordingMaxDurationMinutes: session.recordingMaxDurationMinutes,
        recordingExpiresAt
      }
    });

    return clone(session);
  }

  async stopRecording(sessionId, {
    actorType = "user",
    actorId = null,
    stopReason = "manual"
  } = {}) {
    const session = this.#mustGetSession(sessionId);
    const stoppedAt = nowIso();
    const stoppedLinkedMobile = session.audioSourceType === "linked_mobile";
    session.status = "stopped";
    session.stoppedAt = stoppedAt;
    session.recordingStopReason = stopReason;
    session.mobileConnectionState = stoppedLinkedMobile
      ? "connected"
      : session.mobileConnectionState === "recording"
        ? "disconnected"
        : session.mobileConnectionState || "disconnected";
    session.audioConnectionState = stoppedLinkedMobile ? "connected" : "disconnected";
    session.updatedAt = stoppedAt;

    await this.appendAuditEvent(sessionId, {
      type: "recording.stopped",
      actorType,
      actorId: actorId || session.createdByMemberId,
      safePayload: {
        stopReason,
        recordingExpiresAt: session.recordingExpiresAt || null
      }
    });

    return clone(session);
  }

  async discardRecordingAttempt(sessionId, { actorId = "demo-doctor" } = {}) {
    const session = this.#mustGetSession(sessionId);
    const versions = this.soaps.get(sessionId) || [];

    const discardedTurnCount = (this.turns.get(sessionId) || []).length;
    const previousStartedAt = session.startedAt;
    const previousStoppedAt = session.stoppedAt;
    const previousDurationMs =
      previousStartedAt && previousStoppedAt
        ? Math.max(0, Date.parse(previousStoppedAt) - Date.parse(previousStartedAt))
        : null;
    const updatedAt = nowIso();
    const wasLinkedMobileRecording = session.audioSourceType === "linked_mobile";
    const nextMobileConnectionState =
      wasLinkedMobileRecording && session.mobileConnectionState !== "disconnected" ? "mic_ready" : "disconnected";

    this.turns.set(sessionId, []);
    session.status = "ready";
    session.startedAt = null;
    session.stoppedAt = null;
    session.recordingExpiresAt = null;
    session.recordingAutoStopTaskName = null;
    session.recordingStopReason = null;
    session.finalizedAt = null;
    session.approvedAt = null;
    session.latestSoapVersionId = null;
    session.latestPartialPreview = null;
    session.latestFinalTurnIndex = 0;
    session.errorCode = null;
    session.errorMessageSafe = null;
    session.mobileConnectionState = nextMobileConnectionState;
    session.audioConnectionState = nextMobileConnectionState === "disconnected" ? "disconnected" : "mic_ready";
    session.audioSourceType = null;
    if (!wasLinkedMobileRecording) {
      session.audioDeviceId = null;
      session.audioDeviceLabel = null;
    }
    session.updatedAt = updatedAt;

    await this.appendAuditEvent(sessionId, {
      type: "recording.discarded",
      actorType: "user",
      actorId,
      safePayload: {
        discardedTurnCount,
        previousDurationMs,
        previousStartedAt,
        previousStoppedAt,
        clearedSoap: versions.length > 0
      }
    });

    return clone(session);
  }

  async appendTurn(sessionId, turnInput) {
    const session = this.#mustGetSession(sessionId);
    const turnId = turnInput.turnId || createId("turn");
    const createdAt = nowIso();
    const turns = this.turns.get(sessionId) || [];
    const turn = {
      turnId,
      turnIndex: turnInput.turnIndex ?? session.latestFinalTurnIndex + 1,
      source: turnInput.source || "live_stt",
      speaker: turnInput.speaker || "unknown",
      text: turnInput.text,
      startMs: turnInput.startMs ?? 0,
      endMs: turnInput.endMs ?? 0,
      confidence: turnInput.confidence ?? null,
      isCorrected: turnInput.isCorrected ?? false,
      provider: turnInput.provider || "mock",
      createdAt,
      updatedAt: createdAt
    };

    turns.push(turn);
    this.turns.set(sessionId, turns);
    session.latestFinalTurnIndex = turn.turnIndex;
    session.updatedAt = createdAt;

    return clone(turn);
  }

  async listTurns(sessionId) {
    return clone(this.turns.get(sessionId) || []);
  }

  async saveSoapVersion(sessionId, soapInput) {
    const session = this.#mustGetSession(sessionId);
    const versions = this.soaps.get(sessionId) || [];
    const createdAt = nowIso();
    const soap = {
      versionId: createId("soap"),
      version: versions.length + 1,
      status: soapInput.status || "ready",
      outputText: soapInput.outputText || soapInput.output_text || soapInput.structuredJson?.outputText || buildLegacySoapOutputText(soapInput),
      structuredJson: soapInput.structuredJson || {},
      model: soapInput.model || "mock-soap-v1",
      promptVersion: soapInput.promptVersion || "draft-v1",
      templateKey: soapInput.templateKey || null,
      promptProfileId: soapInput.promptProfileId || null,
      promptProfileVersionId: soapInput.promptProfileVersionId || null,
      resolvedPromptHash: soapInput.resolvedPromptHash || null,
      inputTranscriptRevision: soapInput.inputTranscriptRevision || "local",
      createdBy: soapInput.createdBy || "system",
      approvedByUserId: soapInput.approvedByUserId || null,
      createdAt,
      updatedAt: createdAt
    };

    versions.push(soap);
    this.soaps.set(sessionId, versions);
    session.latestSoapVersionId = soap.versionId;
    session.updatedAt = createdAt;
    return clone(soap);
  }

  async approveSoapVersion(sessionId, { versionId, approvedByUserId }) {
    const session = this.#mustGetSession(sessionId);
    const versions = this.soaps.get(sessionId) || [];
    const targetSoap =
      (versionId ? versions.find((soap) => soap.versionId === versionId) : versions.at(-1)) || null;

    if (!targetSoap) {
      throw new Error("SOAP version not found");
    }

    const approvedAt = nowIso();
    targetSoap.status = "approved";
    targetSoap.approvedByUserId = approvedByUserId || null;
    targetSoap.updatedAt = approvedAt;

    session.status = "approved";
    session.approvedAt = approvedAt;
    session.updatedAt = approvedAt;

    return {
      session: clone(session),
      soap: clone(targetSoap)
    };
  }

  async appendAuditEvent(sessionId, eventInput) {
    const events = this.auditEvents.get(sessionId) || [];
    const event = {
      eventId: createId("evt"),
      type: eventInput.type,
      actorType: eventInput.actorType,
      actorId: eventInput.actorId,
      safePayload: eventInput.safePayload || {},
      createdAt: nowIso()
    };

    events.push(event);
    this.auditEvents.set(sessionId, events);
    return clone(event);
  }

  async appendOrganizationAuditEvent(orgId, eventInput) {
    const events = this.organizationAuditEvents.get(orgId) || [];
    const event = {
      eventId: createId("evt"),
      orgId,
      type: eventInput.type,
      actorType: eventInput.actorType || "user",
      actorId: eventInput.actorId,
      safePayload: eventInput.safePayload || {},
      createdAt: nowIso()
    };

    events.push(event);
    this.organizationAuditEvents.set(orgId, events);
    return clone(event);
  }

  async getMember({ orgId, memberId } = {}) {
    if (!orgId || !memberId) {
      return null;
    }

    const member = this.members.get(`${orgId}:${memberId}`);
    return member ? clone({
      ...member,
      defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource)
    }) : null;
  }

  async getMemberAuthContext({ orgId, memberId } = {}) {
    const member = this.members.get(`${orgId}:${memberId}`);
    const organization = this.organizations.get(orgId);

    if (!member || !organization) {
      return null;
    }

    const identity = this.#identityForMember(organization, member);

    if (!identity) {
      return null;
    }

    return clone({
      organization,
      member,
      identity: {
        organizationCode: identity.organizationCode,
        loginId: identity.loginId,
        status: identity.status,
        tokenVersion: Number(identity.tokenVersion || 0),
        mfaRequired: Boolean(identity.mfaRequired),
        mfaEnrolledAt: identity.mfaEnrolledAt || null,
        mfaSecretEncrypted: identity.mfaSecretEncrypted || null,
        lockedUntil: identity.lockedUntil || null
      }
    });
  }

  async enableMemberMfa({ orgId, memberId, mfaSecretEncrypted, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const organization = this.organizations.get(orgId);
    const member = this.members.get(memberKey);

    if (!organization || !member) {
      return null;
    }

    const identity = this.#identityForMember(organization, member);

    if (!identity) {
      return null;
    }

    const updatedAt = nowIso();
    identity.mfaRequired = true;
    identity.mfaEnrolledAt = updatedAt;
    identity.mfaSecretEncrypted = mfaSecretEncrypted;
    identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
    identity.updatedAt = updatedAt;
    member.mfaRequired = true;
    member.mfaEnrolledAt = updatedAt;
    member.updatedAt = updatedAt;
    this.identities.set(identity.identityId, identity);
    this.members.set(memberKey, member);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.mfa_enabled",
      actorId,
      safePayload: {
        memberId
      }
    });

    return clone(member);
  }

  async resetMemberMfa({ orgId, memberId, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const organization = this.organizations.get(orgId);
    const member = this.members.get(memberKey);

    if (!organization || !member) {
      return null;
    }

    const identity = this.#identityForMember(organization, member);

    if (!identity) {
      return null;
    }

    const updatedAt = nowIso();
    const mfaRequired = Boolean(identity.mfaRequired) || rolesRequireMfa(member.roles);

    identity.mfaRequired = mfaRequired;
    identity.mfaEnrolledAt = null;
    identity.mfaSecretEncrypted = null;
    identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
    identity.updatedAt = updatedAt;
    member.mfaRequired = mfaRequired;
    member.mfaEnrolledAt = null;
    member.updatedAt = updatedAt;
    this.identities.set(identity.identityId, identity);
    this.members.set(memberKey, member);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.mfa_reset",
      actorId,
      safePayload: {
        memberId
      }
    });

    return clone(member);
  }

  async updateMemberStatus({ orgId, memberId, status, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const organization = this.organizations.get(orgId);
    const member = this.members.get(memberKey);

    if (!organization || !member) {
      return null;
    }

    assertDoesNotRemoveLastOrgAdmin(Array.from(this.members.values()).filter((item) => item.orgId === orgId || item.clinicId === orgId), {
      memberId,
      nextStatus: status,
      nextRoles: member.roles || []
    });

    const identity = this.#identityForMember(organization, member);
    const updatedAt = nowIso();
    member.status = status;
    member.updatedAt = updatedAt;

    if (identity) {
      identity.status = status;
      identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
      identity.updatedAt = updatedAt;
      this.identities.set(identity.identityId, identity);
    }

    this.members.set(memberKey, member);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.status_updated",
      actorId,
      safePayload: {
        memberId,
        status
      }
    });

    return clone(member);
  }

  async updateMemberRoles({ orgId, memberId, roles, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const organization = this.organizations.get(orgId);
    const member = this.members.get(memberKey);

    if (!organization || !member) {
      return null;
    }

    const nextRoles = uniqueValues(roles);
    assertDoesNotRemoveLastOrgAdmin(Array.from(this.members.values()).filter((item) => item.orgId === orgId || item.clinicId === orgId), {
      memberId,
      nextStatus: member.status || "active",
      nextRoles
    });

    const identity = this.#identityForMember(organization, member);
    const updatedAt = nowIso();
    const mfaRequired = rolesRequireMfa(nextRoles);
    member.roles = nextRoles;
    member.mfaRequired = mfaRequired;
    member.updatedAt = updatedAt;

    if (identity) {
      identity.mfaRequired = mfaRequired;
      identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
      identity.updatedAt = updatedAt;
      this.identities.set(identity.identityId, identity);
    }

    this.members.set(memberKey, member);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.roles_updated",
      actorId,
      safePayload: {
        memberId,
        roles: nextRoles
      }
    });

    return clone(member);
  }

  async revokeMemberSessions({ orgId, memberId, actorId }) {
    const organization = this.organizations.get(orgId);
    const member = this.members.get(`${orgId}:${memberId}`);

    if (!organization || !member) {
      return null;
    }

    const identity = this.#identityForMember(organization, member);

    if (!identity) {
      return null;
    }

    const updatedAt = nowIso();
    identity.tokenVersion = Number(identity.tokenVersion || 0) + 1;
    identity.updatedAt = updatedAt;
    this.identities.set(identity.identityId, identity);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.sessions_revoked",
      actorId,
      safePayload: {
        memberId
      }
    });

    return { memberId, tokenVersion: identity.tokenVersion, updatedAt };
  }

  async updateMemberPreferences({ orgId, memberId, defaultRecordingSource, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const member = this.members.get(memberKey);

    if (!member) {
      return null;
    }

    member.defaultRecordingSource = normalizeRecordingSource(defaultRecordingSource);
    member.updatedAt = nowIso();
    this.members.set(memberKey, member);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.preferences_updated",
      actorId,
      safePayload: {
        memberId,
        defaultRecordingSource: member.defaultRecordingSource
      }
    });

    return clone(member);
  }

  async listOrganizationAuditEvents({ orgId, limit = 100 } = {}) {
    return clone(
      (this.organizationAuditEvents.get(orgId) || [])
        .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
        .slice(0, limit)
    );
  }

  async listMembers({ orgId } = {}) {
    return Array.from(this.members.values())
      .filter((member) => !orgId || member.orgId === orgId || member.clinicId === orgId)
      .sort((left, right) => String(left.displayName || left.loginId || "").localeCompare(String(right.displayName || right.loginId || ""), "ja"))
      .map((member) => clone(member));
  }

  async checkRateLimit({ bucket, identifier, limit, windowMs, now = Date.now() } = {}) {
    const key = `${bucket}:${identifier}`;
    const entry = this.rateLimitBuckets.get(key);

    if (!entry || now >= entry.resetAt) {
      const next = {
        count: 1,
        resetAt: now + windowMs
      };
      this.rateLimitBuckets.set(key, next);
      return { limited: false, count: next.count, resetAt: next.resetAt };
    }

    entry.count += 1;
    this.rateLimitBuckets.set(key, entry);
    return { limited: entry.count > limit, count: entry.count, resetAt: entry.resetAt };
  }

  async findTrustedRecorderByDeviceId(deviceId) {
    const recorder = Array.from(this.trustedRecorders.values()).find((item) => item.deviceId === deviceId && item.status === "active");
    return recorder ? clone(recorder) : null;
  }

  async registerTrustedRecorder({ orgId, deviceId, label, actorId }) {
    const organization = this.organizations.get(orgId);

    if (!organization) {
      return null;
    }

    const key = trustedRecorderStoreKey(orgId, deviceId);
    const existing = this.trustedRecorders.get(key);
    const updatedAt = nowIso();
    const recorder = {
      ...(existing || {}),
      recorderId: existing?.recorderId || key,
      orgId,
      clinicId: orgId,
      deviceId,
      label: label || existing?.label || "trusted-recorder",
      status: "active",
      registeredByMemberId: existing?.registeredByMemberId || actorId || null,
      lastSeenAt: Date.now(),
      revokedAt: null,
      revokedByMemberId: null,
      createdAt: existing?.createdAt || updatedAt,
      updatedAt
    };

    this.trustedRecorders.set(key, recorder);

    await this.appendOrganizationAuditEvent(orgId, {
      type: existing ? "trusted_recorder.refreshed" : "trusted_recorder.registered",
      actorId,
      safePayload: {
        deviceId,
        label: recorder.label
      }
    });

    return clone(recorder);
  }

  async listTrustedRecorders({ orgId, includeRevoked = false } = {}) {
    return Array.from(this.trustedRecorders.values())
      .filter((recorder) => !orgId || recorder.orgId === orgId || recorder.clinicId === orgId)
      .filter((recorder) => includeRevoked || recorder.status !== "revoked")
      .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0))
      .map((recorder) => clone(recorder));
  }

  async getTrustedRecorder({ orgId, deviceId } = {}) {
    const recorder = this.trustedRecorders.get(trustedRecorderStoreKey(orgId, deviceId));
    return recorder ? clone(recorder) : null;
  }

  async touchTrustedRecorder({ orgId, deviceId } = {}) {
    const key = trustedRecorderStoreKey(orgId, deviceId);
    const recorder = this.trustedRecorders.get(key);

    if (!recorder || recorder.status !== "active") {
      return null;
    }

    recorder.lastSeenAt = Date.now();
    recorder.updatedAt = nowIso();
    this.trustedRecorders.set(key, recorder);
    return clone(recorder);
  }

  async revokeTrustedRecorder({ orgId, deviceId, actorId }) {
    const key = trustedRecorderStoreKey(orgId, deviceId);
    const recorder = this.trustedRecorders.get(key);

    if (!recorder || recorder.status === "revoked") {
      return null;
    }

    const updatedAt = nowIso();
    recorder.status = "revoked";
    recorder.revokedAt = updatedAt;
    recorder.revokedByMemberId = actorId || null;
    recorder.updatedAt = updatedAt;
    this.trustedRecorders.set(key, recorder);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "trusted_recorder.revoked",
      actorId,
      safePayload: {
        deviceId
      }
    });

    return clone(recorder);
  }

  async runRetentionCleanup({ orgId = null, dryRun = true, now = new Date(), actorId = "retention-cleanup" } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const organizations = Array.from(this.organizations.values()).filter((organization) => !orgId || organization.orgId === orgId);
    const results = [];

    for (const organization of organizations) {
      const policy = organization.retentionPolicy || {};
      const audioCutoffMs = nowMs - Number(policy.audioDays || 90) * 24 * 60 * 60 * 1000;
      const transcriptCutoffMs = nowMs - Number(policy.transcriptDays || 365) * 24 * 60 * 60 * 1000;
      const auditCutoffMs = nowMs - Number(policy.auditDays || 365) * 24 * 60 * 60 * 1000;
      const orgAuditEvents = this.organizationAuditEvents.get(organization.orgId) || [];
      const auditEventsToDelete = orgAuditEvents.filter((event) => Date.parse(event.createdAt || 0) < auditCutoffMs);
      const sessionsToDelete = Array.from(this.sessions.values()).filter((session) => (
        (session.orgId === organization.orgId || session.clinicId === organization.orgId) &&
        Date.parse(session.updatedAt || session.createdAt || 0) < transcriptCutoffMs
      ));
      const sessionsToClearAudio = Array.from(this.sessions.values()).filter((session) => (
        (session.orgId === organization.orgId || session.clinicId === organization.orgId) &&
        session.rawAudioPath &&
        Date.parse(session.updatedAt || session.createdAt || 0) < audioCutoffMs
      ));

      if (!dryRun) {
        this.organizationAuditEvents.set(
          organization.orgId,
          orgAuditEvents.filter((event) => !auditEventsToDelete.some((item) => item.eventId === event.eventId))
        );

        for (const session of sessionsToClearAudio) {
          session.rawAudioPath = null;
          session.updatedAt = nowIso();
          this.sessions.set(session.sessionId, session);
        }

        for (const session of sessionsToDelete) {
          this.sessions.delete(session.sessionId);
          this.sessionIndex.delete(session.sessionId);
          this.turns.delete(session.sessionId);
          this.soaps.delete(session.sessionId);
          this.auditEvents.delete(session.sessionId);
        }

        await this.appendOrganizationAuditEvent(organization.orgId, {
          type: "retention.cleanup.completed",
          actorType: "system",
          actorId,
          safePayload: {
            auditEventsDeleted: auditEventsToDelete.length,
            rawAudioPointersCleared: sessionsToClearAudio.length,
            encountersDeleted: sessionsToDelete.length
          }
        });
      }

      results.push({
        orgId: organization.orgId,
        dryRun,
        auditEventsDeleted: auditEventsToDelete.length,
        rawAudioPointersCleared: sessionsToClearAudio.length,
        encountersDeleted: sessionsToDelete.length
      });
    }

    return { dryRun, organizations: results };
  }

  async listRoleDefinitions() {
    return Array.from(this.roleDefinitions.values())
      .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
      .map((role) => clone(role));
  }

  async listSoapFormatProfiles({ orgId, memberId = null, roles = [] } = {}) {
    const canSeeAll = canManageOrganizationRoles(roles);
    return Array.from(this.promptProfiles.values())
      .filter((profile) => !orgId || profile.orgId === orgId)
      .filter((profile) => canSeeAll || !profile.ownerMemberId || profile.ownerMemberId === memberId || profile.scope !== "member")
      .map((profile) => serializeSoapFormatProfile(profile))
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  }

  async listSoapFormatProfileSummaries({ orgId, memberId = null, roles = [] } = {}) {
    const canSeeAll = canManageOrganizationRoles(roles);
    return Array.from(this.promptProfiles.values())
      .filter((profile) => !orgId || profile.orgId === orgId)
      .filter((profile) => canSeeAll || !profile.ownerMemberId || profile.ownerMemberId === memberId || profile.scope !== "member")
      .map(({ versions: _versions, ...profile }) => serializeSoapFormatProfile(profile))
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  }

  async getSoapFormatProfile({ orgId, profileId }) {
    const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
    return profile ? serializeSoapFormatProfile(profile) : null;
  }

  async createSoapFormatProfile({ orgId, input, actorId }) {
    const createdAt = nowIso();
    const normalized = normalizeSoapFormatProfile(input);
    if (hasDuplicateSoapFormatDisplayName(this.promptProfiles, { orgId, displayName: normalized.displayName })) {
      throw duplicateSoapFormatDisplayNameError();
    }

    const profileId = createId("fmt");
    const version = buildSoapFormatVersion({
      profileId,
      previousVersion: 0,
      input: normalized,
      actorId,
      createdAt
    });
    const profile = {
      profileId,
      orgId,
      displayName: normalized.displayName,
      scope: normalized.scope,
      ownerMemberId: normalized.ownerMemberId,
      facilityId: normalized.facilityId,
      departmentId: normalized.departmentId,
      status: "draft",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: version.profileVersionId,
      templateKey: normalized.templateKey,
      outputTemplate: normalized.outputTemplate,
      customization: normalized.customization,
      sections: normalized.sections,
      versions: [version],
      createdByMemberId: actorId,
      updatedByMemberId: actorId,
      createdAt,
      updatedAt: createdAt
    };

    this.promptProfiles.set(`${orgId}:${profileId}`, profile);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.created",
      actorId,
      safePayload: {
        profileId,
        scope: profile.scope,
        ownerMemberId: profile.ownerMemberId
      }
    });

    return serializeSoapFormatProfile(profile);
  }

  async updateSoapFormatDraft({ orgId, profileId, input, actorId }) {
    const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
    if (!profile) {
      return null;
    }

    const updatedAt = nowIso();
    const normalized = normalizeSoapFormatProfile({
      displayName: input.displayName ?? profile.displayName,
      scope: input.scope ?? profile.scope,
      ownerMemberId: input.ownerMemberId ?? profile.ownerMemberId,
      facilityId: input.facilityId ?? profile.facilityId,
      departmentId: input.departmentId ?? profile.departmentId,
      templateKey: input.templateKey ?? profile.templateKey,
      outputTemplate: input.outputTemplate ?? profile.outputTemplate,
      customization: input.customization ?? profile.customization,
      sections: input.sections ?? profile.sections
    });
    if (hasDuplicateSoapFormatDisplayName(this.promptProfiles, { orgId, displayName: normalized.displayName, excludeProfileId: profileId })) {
      throw duplicateSoapFormatDisplayNameError();
    }

    const versions = Array.isArray(profile.versions) ? profile.versions : [];
    const existingDraft = versions.find((version) => version.profileVersionId === profile.currentDraftVersionId && version.status === "draft");
    const draftVersion = existingDraft || buildSoapFormatVersion({
      profileId,
      previousVersion: versions.reduce((max, version) => Math.max(max, version.version || 0), 0),
      input: normalized,
      actorId,
      createdAt: updatedAt
    });
    const validation = validateSoapFormatDefinition(normalized);
    Object.assign(draftVersion, {
      status: "draft",
      approved: false,
      validationStatus: validation.status,
      validationIssues: validation.issues,
      templateKey: normalized.templateKey,
      outputTemplate: normalized.outputTemplate,
      customization: normalized.customization,
      sections: normalized.sections,
      resolvedPromptHash: hashSoapFormatDefinition(normalized),
      updatedByMemberId: actorId,
      updatedAt
    });

    if (!existingDraft) {
      versions.push(draftVersion);
    }

    Object.assign(profile, {
      displayName: normalized.displayName,
      scope: normalized.scope,
      ownerMemberId: normalized.ownerMemberId,
      facilityId: normalized.facilityId,
      departmentId: normalized.departmentId,
      templateKey: normalized.templateKey,
      outputTemplate: normalized.outputTemplate,
      customization: normalized.customization,
      sections: normalized.sections,
      currentDraftVersionId: draftVersion.profileVersionId,
      versions,
      updatedByMemberId: actorId,
      updatedAt
    });

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.draft_updated",
      actorId,
      safePayload: {
        profileId,
        draftVersionId: draftVersion.profileVersionId,
        validationStatus: draftVersion.validationStatus
      }
    });

    return serializeSoapFormatProfile(profile);
  }

  async publishSoapFormatProfile({ orgId, profileId, versionId = null, actorId }) {
    const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
    if (!profile) {
      return null;
    }

    const versions = Array.isArray(profile.versions) ? profile.versions : [];
    const targetVersion =
      versions.find((version) => version.profileVersionId === (versionId || profile.currentDraftVersionId)) ||
      versions.find((version) => version.profileVersionId === profile.currentVersionId) ||
      null;

    if (!targetVersion) {
      const error = new Error("公開できるSOAPフォーマットのドラフトがありません。");
      error.statusCode = 409;
      throw error;
    }

    const validation = validateSoapFormatDefinition({
      customization: targetVersion.customization,
      outputTemplate: targetVersion.outputTemplate || profile.outputTemplate || DEFAULT_PROMPT_PROFILE.outputTemplate,
      sections: targetVersion.sections
    });
    if (validation.status !== "passed") {
      const error = new Error("安全性チェックに通過していないため公開できません。");
      error.statusCode = 422;
      error.publicMessage = "安全性チェックに通過していないため公開できません。";
      throw error;
    }

    const updatedAt = nowIso();
    for (const version of versions) {
      if (version.status === "active") {
        version.status = "archived";
      }
    }
    Object.assign(targetVersion, {
      status: "active",
      approved: true,
      validationStatus: "passed",
      validationIssues: [],
      updatedByMemberId: actorId,
      updatedAt
    });
    Object.assign(profile, {
      status: "active",
      approved: true,
      currentVersionId: targetVersion.profileVersionId,
      currentDraftVersionId: null,
      templateKey: targetVersion.templateKey,
      outputTemplate: targetVersion.outputTemplate || profile.outputTemplate || DEFAULT_PROMPT_PROFILE.outputTemplate,
      customization: targetVersion.customization,
      sections: targetVersion.sections,
      updatedByMemberId: actorId,
      updatedAt
    });

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.published",
      actorId,
      safePayload: {
        profileId,
        profileVersionId: targetVersion.profileVersionId,
        version: targetVersion.version
      }
    });

    return serializeSoapFormatProfile(profile);
  }

  async archiveSoapFormatProfile({ orgId, profileId, actorId }) {
    const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
    if (!profile) {
      return null;
    }

    if (profileId === DEFAULT_PROMPT_PROFILE.profileId) {
      const error = new Error("病院標準フォーマットは公開停止できません。");
      error.statusCode = 409;
      error.publicMessage = "病院標準フォーマットは公開停止できません。";
      throw error;
    }

    const updatedAt = nowIso();
    const versions = Array.isArray(profile.versions) ? profile.versions : [];
    for (const version of versions) {
      if (version.status === "active") {
        version.status = "archived";
        version.updatedByMemberId = actorId;
        version.updatedAt = updatedAt;
      }
    }

    let unassignedMemberCount = 0;
    for (const member of this.members.values()) {
      if ((member.orgId === orgId || member.clinicId === orgId) && member.defaultPromptProfileId === profileId) {
        member.defaultPromptProfileId = DEFAULT_PROMPT_PROFILE.profileId;
        member.updatedAt = updatedAt;
        unassignedMemberCount += 1;
      }
    }

    const organization = this.organizations.get(orgId);
    if (organization?.defaultPromptProfileId === profileId) {
      organization.defaultPromptProfileId = DEFAULT_PROMPT_PROFILE.profileId;
      organization.updatedAt = updatedAt;
    }

    Object.assign(profile, {
      status: "archived",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: null,
      updatedByMemberId: actorId,
      updatedAt
    });

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.archived",
      actorId,
      safePayload: {
        profileId,
        unassignedMemberCount
      }
    });

    return serializeSoapFormatProfile(profile);
  }

  async assignSoapFormatToMember({ orgId, memberId, profileId, actorId }) {
    const memberKey = `${orgId}:${memberId}`;
    const member = this.members.get(memberKey);
    if (!member) {
      return null;
    }

    if (profileId) {
      const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
      if (!profile || profile.status !== "active" || profile.approved !== true) {
        return null;
      }
    }

    member.defaultPromptProfileId = profileId || DEFAULT_PROMPT_PROFILE.profileId;
    member.updatedAt = nowIso();

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.assigned",
      actorId,
      safePayload: {
        memberId,
        profileId: member.defaultPromptProfileId
      }
    });

    return clone(member);
  }

  async assignSoapFormatToOrganization({ orgId, profileId, actorId }) {
    const organization = this.organizations.get(orgId);
    if (!organization) {
      return null;
    }

    if (profileId) {
      const profile = this.promptProfiles.get(`${orgId}:${profileId}`);
      if (!profile || profile.status !== "active" || profile.approved !== true) {
        return null;
      }
    }

    organization.defaultPromptProfileId = profileId || DEFAULT_PROMPT_PROFILE.profileId;
    organization.updatedAt = nowIso();

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.assigned",
      actorId,
      safePayload: {
        targetType: "organization",
        profileId: organization.defaultPromptProfileId
      }
    });

    return clone(organization);
  }

  async resolvePromptProfile({ orgId, memberId, promptProfileId = null } = {}) {
    const member = memberId ? this.members.get(`${orgId}:${memberId}`) : null;
    const organization = orgId ? this.organizations.get(orgId) : null;
    const resolvedProfileId = promptProfileId || member?.defaultPromptProfileId || organization?.defaultPromptProfileId || DEFAULT_PROMPT_PROFILE.profileId;
    const profile = this.promptProfiles.get(`${orgId}:${resolvedProfileId}`);

    if (!profile) {
      return clone(DEFAULT_PROMPT_PROFILE);
    }

    const activeVersion = resolveActiveSoapFormatVersion(profile);

    if (!activeVersion) {
      return clone(DEFAULT_PROMPT_PROFILE);
    }

    const resolved = {
      profileId: profile.profileId || resolvedProfileId,
      profileVersionId: activeVersion.profileVersionId || activeVersion.versionId,
      promptVersion: activeVersion.promptVersion || `${resolvedProfileId}-v${activeVersion.version || 1}`,
      templateKey: activeVersion.templateKey || profile.templateKey || "outpatient_soap_note",
      displayName: profile.displayName || "SOAPフォーマット",
      scope: profile.scope || "organization",
      ownerMemberId: profile.ownerMemberId || null,
      outputTemplate: activeVersion.outputTemplate || profile.outputTemplate || DEFAULT_PROMPT_PROFILE.outputTemplate,
      customization: activeVersion.customization || profile.customization || {},
      sections: activeVersion.sections || profile.sections || [],
      source: profile.source || "organization",
      resolvedPromptHash: activeVersion.resolvedPromptHash || hashSoapFormatDefinition(activeVersion)
    };

    return clone(resolved);
  }

  #mustGetSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return session;
  }

  async #bootstrapIdentity({ organizationCode, loginId, password, defaultOrgId, defaultDisplayName }) {
    const existingOrgId = this.organizationCodes.get(organizationCode);
    const orgId = existingOrgId || (defaultOrgId && !this.organizations.has(defaultOrgId) ? defaultOrgId : createId("org"));
    const memberId = createId("mem");
    const createdAt = nowIso();

    if (!existingOrgId) {
      const organization = {
        orgId,
        clinicId: orgId,
        organizationCode,
        displayName: organizationCode,
        status: "active",
        timezone: "Asia/Tokyo",
        defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
        recordingMaxDurationMinutes: DEFAULT_RECORDING_MAX_DURATION_MINUTES,
        retentionPolicy: {
          audioDays: 90,
          transcriptDays: 365,
          auditDays: 365
        },
        featureFlags: {},
        createdAt,
        updatedAt: createdAt
      };
      this.organizations.set(orgId, organization);
      this.organizationCodes.set(organizationCode, orgId);
      this.promptProfiles.set(`${orgId}:${DEFAULT_PROMPT_PROFILE.profileId}`, DEFAULT_PROMPT_PROFILE);
    }

    const member = {
      memberId,
      userId: memberId,
      orgId,
      clinicId: orgId,
      loginId,
      displayName: defaultDisplayName,
      roles: ["org_admin", "doctor"],
      facilityIds: [],
      departmentIds: [],
      specialty: null,
      defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
      defaultRecordingSource: DEFAULT_RECORDING_SOURCE,
      status: "active",
      mfaRequired: true,
      mfaEnrolledAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const identity = {
      identityId: buildLoginIdentityKey(organizationCode, loginId),
      organizationCode,
      loginId,
      orgId,
      memberId,
      passwordHash: hashPassword(password),
      status: "active",
      tokenVersion: 0,
      failedLoginCount: 0,
      lockedUntil: null,
      mfaRequired: true,
      mfaEnrolledAt: null,
      mfaSecretEncrypted: null,
      createdAt,
      updatedAt: createdAt
    };

    this.members.set(`${orgId}:${memberId}`, member);
    this.identities.set(identity.identityId, identity);
    return identity;
  }

  #identityForMember(organization, member) {
    if (!organization?.organizationCode || !member?.loginId) {
      return null;
    }

    return this.identities.get(buildLoginIdentityKey(organization.organizationCode, member.loginId)) || null;
  }

  #createPairingArtifacts(sessionId, orgId, createdAt) {
    const pairingId = createId("pair");
    const plainToken = createPlainToken();

    return {
      pairingId,
      sessionId,
      orgId,
      clinicId: orgId,
      tokenHash: hashToken(plainToken),
      plainToken,
      shortCode: String(randomInt(100000, 1000000)),
      status: "active",
      claimedByDeviceId: null,
      claimedAt: null,
      expiresAt: addMinutes(createdAt, 30),
      createdAt
    };
  }

  #publicPairing(pairing) {
    return {
      pairingId: pairing.pairingId,
      sessionId: pairing.sessionId,
      shortCode: pairing.shortCode,
      status: pairing.status,
      expiresAt: pairing.expiresAt,
      claimedByDeviceId: pairing.claimedByDeviceId,
      claimedAt: pairing.claimedAt,
      createdAt: pairing.createdAt
    };
  }
}
