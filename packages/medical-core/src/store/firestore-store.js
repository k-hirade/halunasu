import { initializeApp, applicationDefault, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash, randomInt } from "node:crypto";
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
const SESSION_SUMMARY_FIELDS = [
  "sessionId",
  "encounterId",
  "orgId",
  "clinicId",
  "facilityId",
  "departmentId",
  "createdByMemberId",
  "createdByUserId",
  "doctorMemberId",
  "assignedDoctorUserId",
  "accessMemberIds",
  "hiddenByMemberIds",
  "status",
  "title",
  "patientId",
  "patientSnapshot",
  "patientDisplayName",
  "visitReason",
  "promptProfileId",
  "promptProfileSelectedAt",
  "promptProfileSelectedByMemberId",
  "promptProfileSelectionSource",
  "latestSoapVersionId",
  "startedAt",
  "stoppedAt",
  "recordingMaxDurationMinutes",
  "recordingExpiresAt",
  "recordingAutoStopTaskName",
  "recordingStopReason",
  "finalizedAt",
  "approvedAt",
  "createdAt",
  "updatedAt"
];

function initAdminApp(options = {}) {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  if (options.serviceAccount) {
    return initializeApp({
      credential: cert(options.serviceAccount),
      projectId: options.projectId || process.env.GOOGLE_CLOUD_PROJECT
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    projectId: options.projectId || process.env.GOOGLE_CLOUD_PROJECT
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRecordingSource(value) {
  return RECORDING_SOURCES.includes(value) ? value : DEFAULT_RECORDING_SOURCE;
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

function isLocked(identity, now = Date.now()) {
  return identity?.lockedUntil && Date.parse(identity.lockedUntil) > now;
}

function buildFailedLoginPatch(identity, now = Date.now()) {
  const failedLoginCount = Number(identity.failedLoginCount || 0) + 1;
  const updatedAt = new Date(now).toISOString();

  return {
    failedLoginCount,
    lastFailedLoginAt: updatedAt,
    lockedUntil: failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS ? new Date(now + ACCOUNT_LOCK_MS).toISOString() : null,
    updatedAt
  };
}

function buildSuccessfulLoginPatch(now = Date.now()) {
  const updatedAt = new Date(now).toISOString();

  return {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: updatedAt,
    updatedAt
  };
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

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
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

function duplicateSoapFormatDisplayNameError() {
  const error = new Error("同じ病院内に同じ名前のプロンプトがあります。別の名前にしてください。");
  error.statusCode = 409;
  return error;
}

export class FirestoreStore {
  constructor(options = {}) {
    this.options = options;
    this.allowRuntimeBootstrap = Boolean(options.allowRuntimeBootstrap);
    this.app = initAdminApp(options);
    this.db = getFirestore(this.app);
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
    const identityRef = this.#identityRef(identityKey);
    let identitySnap = await identityRef.get();

    if (
      !identitySnap.exists &&
      this.allowRuntimeBootstrap &&
      bootstrapPassword &&
      password === bootstrapPassword &&
      normalizedOrganizationCode === normalizeLoginIdentifier(defaultOrganizationCode) &&
      normalizedLoginId === normalizeLoginIdentifier(defaultLoginId)
    ) {
      await this.#bootstrapIdentity({
        organizationCode: normalizedOrganizationCode,
        loginId: normalizedLoginId,
        password,
        defaultOrgId,
        defaultDisplayName
      });
      identitySnap = await identityRef.get();
    }

    if (!identitySnap.exists) {
      return null;
    }

    const identity = identitySnap.data();

    if (identity.status !== "active" || isLocked(identity)) {
      return null;
    }

    if (!verifyPassword(password, identity.passwordHash)) {
      const failurePatch = buildFailedLoginPatch(identity);
      await identityRef.update(failurePatch);
      await this.appendOrganizationAuditEvent(identity.orgId, {
        type: "auth.login_failed",
        actorId: null,
        safePayload: {
          loginId: normalizedLoginId,
          reason: failurePatch.lockedUntil ? "account_locked" : "bad_credentials"
        }
      });
      return null;
    }

    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(identity.orgId).get(),
      this.#memberRef(identity.orgId, identity.memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();

    if (organization.status !== "active" || member.status !== "active") {
      return null;
    }

    await identityRef.update(buildSuccessfulLoginPatch());

    return {
      organization,
      member,
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
    const snap = await this.db.collection("organizations").get();
    return snap.docs
      .map((doc) => doc.data())
      .sort((left, right) => String(left.displayName || "").localeCompare(String(right.displayName || ""), "ja"));
  }

  async getOrganization(orgId) {
    const snap = await this.#organizationRef(orgId).get();
    return snap.exists ? snap.data() : null;
  }

  async getOrganizationByCode(organizationCode) {
    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const codeSnap = await this.#organizationCodeRef(normalizedOrganizationCode).get();

    if (!codeSnap.exists) {
      return null;
    }

    const orgId = codeSnap.data().orgId;
    return this.getOrganization(orgId);
  }

  async getLoginIdentity({ organizationCode, loginId } = {}) {
    if (!organizationCode || !loginId) {
      return null;
    }

    const snap = await this.#identityRef(buildLoginIdentityKey(
      normalizeLoginIdentifier(organizationCode),
      normalizeLoginIdentifier(loginId)
    )).get();
    return snap.exists ? clone(snap.data()) : null;
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

    await this.#signupApplicationRef(signup.signupId).set(signup);
    return clone(signup);
  }

  async getSignupApplication(signupId) {
    const snap = await this.#signupApplicationRef(signupId).get();
    return snap.exists ? clone(snap.data()) : null;
  }

  async updateSignupApplication(signupId, patch = {}) {
    const ref = this.#signupApplicationRef(signupId);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const updated = {
      ...snap.data(),
      ...clone(patch),
      updatedAt: patch.updatedAt || nowIso()
    };
    await ref.set(updated);
    return clone(updated);
  }

  async listSignupApplications({ status = null, limit = 100 } = {}) {
    const query = status
      ? this.db.collection("signup_applications").where("status", "==", status)
      : this.db.collection("signup_applications");
    const snap = await query.orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((doc) => clone(doc.data()));
  }

  async findPendingSignupApplication({ organizationCode, adminLoginId } = {}) {
    const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
    const normalizedLoginId = normalizeLoginIdentifier(adminLoginId);
    const activeStatuses = new Set(["draft", "checkout_created", "checkout_completed", "provisioning"]);
    const snap = await this.db.collection("signup_applications")
      .where("organizationCode", "==", normalizedOrganizationCode)
      .limit(20)
      .get();
    const found = snap.docs
      .map((doc) => doc.data())
      .find((signup) => signup.adminLoginId === normalizedLoginId && activeStatuses.has(signup.status));
    return found ? clone(found) : null;
  }

  async findActiveContactSignupApplication({ adminEmail } = {}) {
    const normalizedEmail = String(adminEmail || "").trim().toLowerCase();
    const activeStatuses = new Set(["submitted", "verified", "provisioning"]);
    const snap = await this.db.collection("signup_applications")
      .where("adminEmail", "==", normalizedEmail)
      .limit(20)
      .get();
    const found = snap.docs
      .map((doc) => doc.data())
      .find((signup) => signup.source === "lp_contact_form" && activeStatuses.has(signup.status));
    return found ? clone(found) : null;
  }

  async findSignupApplicationByOrgId(orgId) {
    if (!orgId) {
      return null;
    }

    const snap = await this.db.collection("signup_applications")
      .where("orgId", "==", orgId)
      .limit(10)
      .get();
    const found = snap.docs
      .map((doc) => doc.data())
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0];
    return found ? clone(found) : null;
  }

  async findSignupApplicationByStripeSubscriptionId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) {
      return null;
    }

    const snap = await this.db.collection("signup_applications")
      .where("stripeSubscriptionId", "==", stripeSubscriptionId)
      .limit(10)
      .get();
    const found = snap.docs
      .map((doc) => doc.data())
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0];
    return found ? clone(found) : null;
  }

  async findSignupApplicationByStripeCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) {
      return null;
    }

    const snap = await this.db.collection("signup_applications")
      .where("stripeCustomerId", "==", stripeCustomerId)
      .limit(10)
      .get();
    const found = snap.docs
      .map((doc) => doc.data())
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

    await this.#emailVerificationTokenRef(tokenHash).set(record);
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
    const ref = this.#emailVerificationTokenRef(tokenHash);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

    if (record.status === "active" && (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now())) {
      record.status = "expired";
      record.updatedAt = nowIso();
      await ref.set(record);
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
    const tokenRef = this.#emailVerificationTokenRef(tokenHash);
    let result = null;

    await this.db.runTransaction(async (transaction) => {
      const tokenSnap = await transaction.get(tokenRef);

      if (!tokenSnap.exists) {
        throw emailVerificationTokenInvalidError("確認リンクが見つかりません。");
      }

      const token = tokenSnap.data();

      if (token.status !== "active") {
        throw emailVerificationTokenInvalidError("確認リンクはすでに無効です。");
      }

      if (!token.expiresAt || Date.parse(token.expiresAt) <= Date.now()) {
        transaction.set(tokenRef, {
          ...token,
          status: "expired",
          updatedAt: nowIso()
        });
        throw emailVerificationTokenInvalidError("確認リンクの有効期限が切れています。");
      }

      const updatedAt = nowIso();
      const updated = {
        ...token,
        status: "used",
        consumedAt: updatedAt,
        updatedAt
      };
      transaction.set(tokenRef, updated);
      result = {
        ...updated,
        tokenId
      };
    });

    return clone(result);
  }

  async createStripeEventReceipt(input = {}) {
    const eventId = String(input.eventId || "").trim();

    if (!eventId) {
      throw new Error("eventId is required.");
    }

    const ref = this.#stripeEventReceiptRef(eventId);
    let receipt = null;

    await this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);

      if (snap.exists) {
        receipt = snap.data();
        return;
      }

      const createdAt = nowIso();
      receipt = {
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
      transaction.set(ref, receipt);
    });

    return clone(receipt);
  }

  async getStripeEventReceipt(eventId) {
    const snap = await this.#stripeEventReceiptRef(eventId).get();
    return snap.exists ? clone(snap.data()) : null;
  }

  async updateStripeEventReceipt(eventId, patch = {}) {
    const ref = this.#stripeEventReceiptRef(eventId);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const updated = {
      ...snap.data(),
      ...clone(patch),
      updatedAt: patch.updatedAt || nowIso()
    };
    await ref.set(updated);
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

    await this.#passwordSetupTokenRef(tokenHash).set(record);
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
    const ref = this.#passwordSetupTokenRef(tokenHash);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

    if (record.status === "active" && isPasswordSetupTokenExpired(record)) {
      record.status = "expired";
      record.updatedAt = nowIso();
      await ref.set(record);
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
    const tokenRef = this.#passwordSetupTokenRef(tokenHash);
    let result = null;

    await this.db.runTransaction(async (transaction) => {
      const tokenSnap = await transaction.get(tokenRef);

      if (!tokenSnap.exists) {
        throw passwordSetupTokenInvalidError("初回設定リンクが見つかりません。");
      }

      const token = tokenSnap.data();

      if (token.status !== "active") {
        throw passwordSetupTokenInvalidError("初回設定リンクはすでに無効です。");
      }

      if (isPasswordSetupTokenExpired(token)) {
        transaction.set(tokenRef, {
          ...token,
          status: "expired",
          updatedAt: nowIso()
        });
        throw passwordSetupTokenInvalidError("初回設定リンクの有効期限が切れています。");
      }

      const orgRef = this.#organizationRef(token.orgId);
      const memberRef = this.#memberRef(token.orgId, token.memberId);
      const organizationSnap = await transaction.get(orgRef);
      const memberSnap = await transaction.get(memberRef);

      if (!organizationSnap.exists || !memberSnap.exists) {
        throw passwordSetupTokenInvalidError("初回設定の対象アカウントが見つかりません。");
      }

      const organization = organizationSnap.data();
      const member = memberSnap.data();
      const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
      const identitySnap = await transaction.get(identityRef);

      if (!identitySnap.exists) {
        throw passwordSetupTokenInvalidError("初回設定のログイン情報が見つかりません。");
      }

      const updatedAt = nowIso();
      const updatedOrganization = {
        ...organization,
        access: resolveAccessAfterPasswordSetup(organization, updatedAt),
        updatedAt
      };
      const updatedMember = {
        ...member,
        updatedAt
      };
      const identity = identitySnap.data();
      const updatedToken = {
        ...token,
        status: "used",
        usedAt: updatedAt,
        updatedAt
      };

      transaction.set(orgRef, updatedOrganization);
      transaction.set(memberRef, updatedMember);
      transaction.update(identityRef, {
        passwordHash: hashPassword(password),
        status: "active",
        tokenVersion: Number(identity.tokenVersion || 0) + 1,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        updatedAt
      });
      transaction.set(tokenRef, updatedToken);

      result = {
        organization: updatedOrganization,
        member: updatedMember,
        token: {
          ...updatedToken,
          tokenId
        }
      };
    });

    await this.appendOrganizationAuditEvent(result.organization.orgId, {
      type: "billing.password_setup.completed",
      actorType: actorId ? "user" : "system",
      actorId: actorId || result.member.memberId,
      safePayload: {
        memberId: result.member.memberId
      }
    });

    return clone(result);
  }

  async updateOrganizationBilling({ orgId, patch = {}, actorId = null, auditType = "billing.subscription.updated" } = {}) {
    const organizationRef = this.#organizationRef(orgId);
    const organizationSnap = await organizationRef.get();

    if (!organizationSnap.exists) {
      return null;
    }

    const updatedAt = patch.updatedAt || nowIso();
    const organization = organizationSnap.data();
    const updatedOrganization = {
      ...organization,
      billing: normalizeOrganizationBilling({
        ...(organization.billing || {}),
        ...clone(patch)
      }, updatedAt),
      updatedAt
    };

    await organizationRef.set(updatedOrganization);
    await this.appendOrganizationAuditEvent(orgId, {
      type: auditType,
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        status: updatedOrganization.billing?.status || null,
        planCode: updatedOrganization.billing?.planCode || null
      }
    });

    return clone(updatedOrganization);
  }

  async updateOrganizationAccess({ orgId, patch = {}, actorId = null, auditType = "billing.access.updated" } = {}) {
    const organizationRef = this.#organizationRef(orgId);
    const organizationSnap = await organizationRef.get();

    if (!organizationSnap.exists) {
      return null;
    }

    const updatedAt = patch.updatedAt || nowIso();
    const organization = organizationSnap.data();
    const updatedOrganization = {
      ...organization,
      access: normalizeOrganizationAccess({
        ...(organization.access || {}),
        ...clone(patch)
      }, updatedAt),
      updatedAt
    };

    await organizationRef.set(updatedOrganization);
    await this.appendOrganizationAuditEvent(orgId, {
      type: auditType,
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        status: updatedOrganization.access?.status || null,
        reason: updatedOrganization.access?.reason || null
      }
    });

    return clone(updatedOrganization);
  }

  async updateOrganizationRecordingPolicy({ orgId, recordingMaxDurationMinutes, actorId }) {
    const organizationRef = this.#organizationRef(orgId);
    const organizationSnap = await organizationRef.get();

    if (!organizationSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const updatedAt = nowIso();
    const nextMinutes = normalizeRecordingMaxDurationMinutes(recordingMaxDurationMinutes);
    const previousRecordingMaxDurationMinutes = normalizeRecordingMaxDurationMinutes(
      organization.recordingMaxDurationMinutes
    );
    const patch = {
      recordingMaxDurationMinutes: nextMinutes,
      updatedAt
    };

    await organizationRef.update(patch);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "organization.recording_policy_updated",
      actorId,
      safePayload: {
        previousRecordingMaxDurationMinutes,
        recordingMaxDurationMinutes: nextMinutes
      }
    });

    return {
      ...organization,
      ...patch
    };
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
    const codeRef = this.#organizationCodeRef(normalizedOrganizationCode);
    const identityRef = this.#identityRef(identityKey);
    const [codeSnap, identitySnap] = await Promise.all([codeRef.get(), identityRef.get()]);

    if (codeSnap.exists) {
      throw new Error("この病院コードはすでに使われています。");
    }

    if (identitySnap.exists) {
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
    const batch = this.db.batch();
    const profileRef = this.#promptProfileRef(orgId, DEFAULT_PROMPT_PROFILE.profileId);
    const auditEventId = createId("evt");

    batch.set(codeRef, {
      organizationCode: normalizedOrganizationCode,
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(this.#organizationRef(orgId), organization);
    batch.set(profileRef, {
      ...DEFAULT_PROMPT_PROFILE,
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(profileRef.collection("versions").doc(DEFAULT_PROMPT_PROFILE.profileVersionId), {
      ...DEFAULT_PROMPT_PROFILE,
      orgId,
      version: 1,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(this.#memberRef(orgId, memberId), member);
    batch.set(identityRef, identity);
    batch.set(this.#organizationRef(orgId).collection("audit_events").doc(auditEventId), {
      eventId: auditEventId,
      orgId,
      type: "organization.created",
      actorType: "user",
      actorId,
      safePayload: {
        organizationCode: normalizedOrganizationCode,
        adminLoginId: normalizedLoginId
      },
      createdAt
    });
    await batch.commit();
    return {
      organization: clone(organization),
      member: clone(member)
    };
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
    const codeRef = this.#organizationCodeRef(normalizedOrganizationCode);
    const identityRef = this.#identityRef(identityKey);
    const [codeSnap, identitySnap] = await Promise.all([codeRef.get(), identityRef.get()]);

    if (codeSnap.exists) {
      throw new Error("この病院コードはすでに使われています。");
    }

    if (identitySnap.exists) {
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
    const batch = this.db.batch();
    const profileRef = this.#promptProfileRef(orgId, DEFAULT_PROMPT_PROFILE.profileId);
    const auditEventId = createId("evt");

    batch.set(codeRef, {
      organizationCode: normalizedOrganizationCode,
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(this.#organizationRef(orgId), organization);
    batch.set(profileRef, {
      ...DEFAULT_PROMPT_PROFILE,
      orgId,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(profileRef.collection("versions").doc(DEFAULT_PROMPT_PROFILE.profileVersionId), {
      ...DEFAULT_PROMPT_PROFILE,
      orgId,
      version: 1,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(this.#memberRef(orgId, memberId), member);
    batch.set(identityRef, identity);
    batch.set(this.#organizationRef(orgId).collection("audit_events").doc(auditEventId), {
      eventId: auditEventId,
      orgId,
      type: "billing.provisioning.completed",
      actorType: actorId ? "user" : "system",
      actorId,
      safePayload: {
        organizationCode: normalizedOrganizationCode,
        adminLoginId: normalizedLoginId
      },
      createdAt
    });
    await batch.commit();
    return {
      organization: clone(organization),
      member: clone(member)
    };
  }

  async createMember({ orgId, loginId, displayName, password, roles = ["doctor"], defaultRecordingSource = DEFAULT_RECORDING_SOURCE, actorId }) {
    assertPasswordPolicy(password);

    const organizationSnap = await this.#organizationRef(orgId).get();

    if (!organizationSnap.exists || organizationSnap.data().status !== "active") {
      throw new Error("病院が見つかりません。");
    }

    const organization = organizationSnap.data();
    const normalizedLoginId = normalizeLoginIdentifier(loginId);
    const identityKey = buildLoginIdentityKey(organization.organizationCode, normalizedLoginId);
    const identityRef = this.#identityRef(identityKey);
    const identitySnap = await identityRef.get();

    if (identitySnap.exists) {
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
    const batch = this.db.batch();
    const auditEventId = createId("evt");

    batch.set(this.#memberRef(orgId, memberId), member);
    batch.set(identityRef, identity);
    batch.set(this.#organizationRef(orgId).collection("audit_events").doc(auditEventId), {
      eventId: auditEventId,
      orgId,
      type: "member.created",
      actorType: "user",
      actorId,
      safePayload: {
        memberId,
        loginId: normalizedLoginId,
        roles: member.roles
      },
      createdAt
    });
    await batch.commit();
    return clone(member);
  }

  async resetMemberPassword({ orgId, memberId, password, actorId }) {
    assertPasswordPolicy(password);

    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      throw new Error("医師が見つかりません。");
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const identityKey = buildLoginIdentityKey(organization.organizationCode, member.loginId);
    const identityRef = this.#identityRef(identityKey);
    const identitySnap = await identityRef.get();

    if (!identitySnap.exists) {
      throw new Error("ログイン情報が見つかりません。");
    }

    const updatedAt = nowIso();
    const batch = this.db.batch();
    const auditEventId = createId("evt");

    batch.update(identityRef, {
      passwordHash: hashPassword(password),
      tokenVersion: Number(identitySnap.data().tokenVersion || 0) + 1,
      failedLoginCount: 0,
      lockedUntil: null,
      lastFailedLoginAt: null,
      updatedAt
    });
    batch.update(this.#memberRef(orgId, memberId), { updatedAt });
    batch.set(this.#organizationRef(orgId).collection("audit_events").doc(auditEventId), {
      eventId: auditEventId,
      orgId,
      type: "member.password_reset",
      actorType: "user",
      actorId,
      safePayload: {
        memberId,
        loginId: member.loginId
      },
      createdAt: updatedAt
    });
    await batch.commit();
    return {
      ...member,
      updatedAt
    };
  }

  async getMember({ orgId, memberId } = {}) {
    if (!orgId || !memberId) {
      return null;
    }

    const memberSnap = await this.#memberRef(orgId, memberId).get();
    if (!memberSnap.exists) {
      return null;
    }

    const member = memberSnap.data();
    return clone({
      ...member,
      defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource)
    });
  }

  async getMemberAuthContext({ orgId, memberId } = {}) {
    if (!orgId || !memberId) {
      return null;
    }

    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const identitySnap = await this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId)).get();

    if (!identitySnap.exists) {
      return null;
    }

    const identity = identitySnap.data();

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
    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
    const identitySnap = await identityRef.get();

    if (!identitySnap.exists) {
      return null;
    }

    const updatedAt = nowIso();
    const batch = this.db.batch();

    batch.update(identityRef, {
      mfaRequired: true,
      mfaEnrolledAt: updatedAt,
      mfaSecretEncrypted,
      tokenVersion: Number(identitySnap.data().tokenVersion || 0) + 1,
      updatedAt
    });
    batch.update(this.#memberRef(orgId, memberId), {
      mfaRequired: true,
      mfaEnrolledAt: updatedAt,
      updatedAt
    });
    await batch.commit();
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.mfa_enabled",
      actorId,
      safePayload: {
        memberId
      }
    });

    return {
      ...member,
      mfaRequired: true,
      mfaEnrolledAt: updatedAt,
      updatedAt
    };
  }

  async resetMemberMfa({ orgId, memberId, actorId }) {
    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
    const identitySnap = await identityRef.get();

    if (!identitySnap.exists) {
      return null;
    }

    const identity = identitySnap.data();
    const updatedAt = nowIso();
    const mfaRequired = Boolean(identity.mfaRequired) || rolesRequireMfa(member.roles);
    const batch = this.db.batch();

    batch.update(identityRef, {
      mfaRequired,
      mfaEnrolledAt: null,
      mfaSecretEncrypted: null,
      tokenVersion: Number(identity.tokenVersion || 0) + 1,
      updatedAt
    });
    batch.update(this.#memberRef(orgId, memberId), {
      mfaRequired,
      mfaEnrolledAt: null,
      updatedAt
    });
    await batch.commit();
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.mfa_reset",
      actorId,
      safePayload: {
        memberId
      }
    });

    return {
      ...member,
      mfaRequired,
      mfaEnrolledAt: null,
      updatedAt
    };
  }

  async updateMemberStatus({ orgId, memberId, status, actorId }) {
    const [organizationSnap, memberSnap, membersSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get(),
      this.#organizationRef(orgId).collection("members").get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const members = membersSnap.docs.map((doc) => doc.data());
    assertDoesNotRemoveLastOrgAdmin(members, {
      memberId,
      nextStatus: status,
      nextRoles: member.roles || []
    });
    const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
    const identitySnap = await identityRef.get();
    const updatedAt = nowIso();
    const batch = this.db.batch();

    batch.update(this.#memberRef(orgId, memberId), { status, updatedAt });

    if (identitySnap.exists) {
      batch.update(identityRef, {
        status,
        tokenVersion: Number(identitySnap.data().tokenVersion || 0) + 1,
        updatedAt
      });
    }

    await batch.commit();
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.status_updated",
      actorId,
      safePayload: {
        memberId,
        status
      }
    });

    return {
      ...member,
      status,
      updatedAt
    };
  }

  async updateMemberRoles({ orgId, memberId, roles, actorId }) {
    const nextRoles = uniqueValues(roles);
    const [organizationSnap, memberSnap, membersSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get(),
      this.#organizationRef(orgId).collection("members").get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const members = membersSnap.docs.map((doc) => doc.data());
    assertDoesNotRemoveLastOrgAdmin(members, {
      memberId,
      nextStatus: member.status || "active",
      nextRoles
    });

    const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
    const identitySnap = await identityRef.get();
    const updatedAt = nowIso();
    const mfaRequired = rolesRequireMfa(nextRoles);
    const batch = this.db.batch();

    batch.update(this.#memberRef(orgId, memberId), {
      roles: nextRoles,
      mfaRequired,
      updatedAt
    });

    if (identitySnap.exists) {
      batch.update(identityRef, {
        mfaRequired,
        tokenVersion: Number(identitySnap.data().tokenVersion || 0) + 1,
        updatedAt
      });
    }

    await batch.commit();
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.roles_updated",
      actorId,
      safePayload: {
        memberId,
        roles: nextRoles
      }
    });

    return {
      ...member,
      roles: nextRoles,
      mfaRequired,
      updatedAt
    };
  }

  async revokeMemberSessions({ orgId, memberId, actorId }) {
    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      this.#memberRef(orgId, memberId).get()
    ]);

    if (!organizationSnap.exists || !memberSnap.exists) {
      return null;
    }

    const organization = organizationSnap.data();
    const member = memberSnap.data();
    const identityRef = this.#identityRef(buildLoginIdentityKey(organization.organizationCode, member.loginId));
    const identitySnap = await identityRef.get();

    if (!identitySnap.exists) {
      return null;
    }

    const updatedAt = nowIso();
    const tokenVersion = Number(identitySnap.data().tokenVersion || 0) + 1;
    await identityRef.update({
      tokenVersion,
      updatedAt
    });
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.sessions_revoked",
      actorId,
      safePayload: {
        memberId
      }
    });

    return { memberId, tokenVersion, updatedAt };
  }

  async updateMemberPreferences({ orgId, memberId, defaultRecordingSource, actorId }) {
    const memberRef = this.#memberRef(orgId, memberId);
    const memberSnap = await memberRef.get();

    if (!memberSnap.exists) {
      return null;
    }

    const updatedAt = nowIso();
    const patch = {
      defaultRecordingSource: normalizeRecordingSource(defaultRecordingSource),
      updatedAt
    };

    await memberRef.update(patch);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "member.preferences_updated",
      actorId,
      safePayload: {
        memberId,
        defaultRecordingSource: patch.defaultRecordingSource
      }
    });

    return {
      ...memberSnap.data(),
      ...patch
    };
  }

  async createSession(input) {
    const createdAt = nowIso();
    const sessionId = createId("ses");
    const orgId = input.orgId || input.clinicId;
    const pairing = this.#createPairingArtifacts(sessionId, orgId, createdAt);
    const session = buildSession(input, { sessionId, pairing, createdAt });
    const encounterRef = this.#encounterRef(session.orgId, sessionId);

    const batch = this.db.batch();
    batch.set(encounterRef, session);
    batch.set(this.#encounterIndexRef(sessionId), {
      sessionId,
      encounterId: sessionId,
      orgId: session.orgId,
      createdAt,
      updatedAt: createdAt
    });
    batch.set(this.#pairingRef(pairing.pairingId), this.#persistedPairing(pairing));
    await batch.commit();

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
    const record = await this.#mustGetSessionRecord(sessionId);
    const session = record.session;
    const createdAt = nowIso();
    const pairing = this.#createPairingArtifacts(sessionId, session.orgId, createdAt);

    const batch = this.db.batch();

    if (session.pairingTokenId) {
      batch.set(this.#pairingRef(session.pairingTokenId), { status: "revoked" }, { merge: true });
    }

    batch.update(record.ref, {
      pairingCode: pairing.shortCode,
      pairingTokenId: pairing.pairingId,
      updatedAt: createdAt
    });
    batch.set(this.#pairingRef(pairing.pairingId), this.#persistedPairing(pairing));
    await batch.commit();

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
    const record = await this.#getSessionRecord(sessionId);

    if (!record) {
      return null;
    }

    const session = record.session;
    const pairingPromise = session.pairingTokenId ? this.#pairingRef(session.pairingTokenId).get() : null;
    const turnsPromise = record.ref.collection("turns").orderBy("turnIndex").get();
    const soapsPromise = record.ref.collection("soap_versions").orderBy("version", "desc").limit(1).get();

    const [pairingSnap, turnsSnap, soapsSnap] = await Promise.all([
      pairingPromise,
      turnsPromise,
      soapsPromise
    ]);

    return {
      session,
      pairing: pairingSnap?.exists ? this.#publicPairing(pairingSnap.data()) : null,
      turns: turnsSnap.docs.map((doc) => doc.data()),
      latestSoap: soapsSnap.empty ? null : soapsSnap.docs[0].data()
    };
  }

  async listSessions({ orgId = null, memberId = null, roles = [], statuses = [], search = "", page = 1, pageSize = 20 } = {}) {
    if (!orgId) {
      return {
        sessions: [],
        page: 1,
        pageSize,
        totalCount: 0,
        totalPages: 0
      };
    }

    let query = canReadOrganizationSessionsRoles(roles) || !memberId
      ? this.#encountersRef(orgId)
      : this.#encountersRef(orgId).where("accessMemberIds", "array-contains", memberId);

    query = query.orderBy("createdAt", "desc");

    if (String(search || "").trim() || (Array.isArray(statuses) && statuses.length > 0)) {
      return this.#listSessionsByBoundedScan(query, {
        memberId,
        statuses,
        search,
        page,
        pageSize
      });
    }

    const safePageSize = Math.max(1, Math.min(50, pageSize));
    const totalCount = await countQuery(query);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / safePageSize) : 0;
    const safePage = totalPages > 0 ? Math.min(Math.max(1, page), totalPages) : 1;
    const snap = await query
      .select(...SESSION_SUMMARY_FIELDS)
      .offset((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .get();
    const sessions = snap.docs
      .map((doc) => clone(doc.data()))
      .filter((session) => !memberId || !(session.hiddenByMemberIds || []).includes(memberId));

    return {
      sessions,
      page: safePage,
      pageSize: safePageSize,
      totalCount,
      totalPages
    };
  }

  async #listSessionsByBoundedScan(query, { memberId, statuses = [], search = "", page = 1, pageSize = 20 } = {}) {
    const safePageSize = Math.max(1, Math.min(50, pageSize));
    const safePage = Math.max(1, page);
    const scanLimit = Math.max(
      safePage * safePageSize,
      Number.parseInt(process.env.CHARTING_SESSION_SEARCH_SCAN_LIMIT || "500", 10) || 500
    );
    const snap = await query
      .select(...SESSION_SUMMARY_FIELDS)
      .limit(scanLimit)
      .get();
    const filtered = snap.docs
      .map((doc) => clone(doc.data()))
      .filter((session) => !memberId || !(session.hiddenByMemberIds || []).includes(memberId))
      .filter((session) => !Array.isArray(statuses) || statuses.length === 0 || statuses.includes(session.status))
      .filter((session) => sessionMatchesSearch(session, search));
    const totalCount = filtered.length;
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / safePageSize) : 0;
    const normalizedPage = totalPages > 0 ? Math.min(safePage, totalPages) : 1;
    const startIndex = (normalizedPage - 1) * safePageSize;

    return {
      sessions: filtered.slice(startIndex, startIndex + safePageSize),
      page: normalizedPage,
      pageSize: safePageSize,
      totalCount,
      totalPages,
      totalCountApproximate: snap.size >= scanLimit
    };
  }

  async hideSessionForMember(sessionId, { memberId, actorId = memberId } = {}) {
    const record = await this.#mustGetSessionRecord(sessionId);

    if (!memberId) {
      const error = new Error("memberId is required to hide a session");
      error.statusCode = 400;
      throw error;
    }

    const hiddenByMemberIds = uniqueValues([...(record.session.hiddenByMemberIds || []), memberId]);
    const updatedAt = nowIso();
    const patch = {
      hiddenByMemberIds,
      updatedAt
    };

    await record.ref.update(patch);
    await this.appendAuditEvent(sessionId, {
      type: "encounter.hidden_from_home",
      actorType: "user",
      actorId,
      safePayload: {
        memberId
      }
    });

    return {
      ...record.session,
      ...patch
    };
  }

  async claimPairing(pairingId, { token, deviceId, clinicId = null, orgId = null }) {
    const pairingSnap = await this.#pairingRef(pairingId).get();

    if (!pairingSnap.exists) {
      return null;
    }

    const pairing = pairingSnap.data();
    const record = await this.#mustGetSessionRecord(pairing.sessionId);
    const session = record.session;
    const expectedOrgId = orgId || clinicId;

    if (expectedOrgId && session.orgId !== expectedOrgId && session.clinicId !== expectedOrgId) {
      return null;
    }

    if (session.pairingTokenId !== pairingId) {
      await this.#pairingRef(pairingId).set({ status: "revoked" }, { merge: true });
      return null;
    }

    if (pairing.status !== "active") {
      return null;
    }

    if (Date.parse(pairing.expiresAt) < Date.now()) {
      await this.#pairingRef(pairingId).update({ status: "expired" });
      return null;
    }

    if (pairing.tokenHash !== hashToken(token)) {
      return null;
    }

    const claimedAt = nowIso();
    const keepsLocalAudioSource = session.audioSourceType === "local_browser";
    const sessionPatch = {
      status: session.status === "ready" ? "paired" : session.status,
      mobileConnectionState: "connected",
      updatedAt: claimedAt
    };

    if (!keepsLocalAudioSource) {
      sessionPatch.audioSourceType = "linked_mobile";
      sessionPatch.audioConnectionState = "connected";
      sessionPatch.audioDeviceId = deviceId;
      sessionPatch.audioDeviceLabel = "録音用スマホ";
    }

    await Promise.all([
      this.#pairingRef(pairingId).update({
        status: "claimed",
        claimedByDeviceId: deviceId,
        claimedAt
      }),
      record.ref.update(sessionPatch)
    ]);

    await this.appendAuditEvent(pairing.sessionId, {
      type: "pairing.claimed",
      actorType: "device",
      actorId: deviceId,
      safePayload: {
        pairingId
      }
    });

    return {
      session: {
        ...session,
        ...sessionPatch
      },
      pairing: this.#publicPairing({
        ...pairing,
        status: "claimed",
        claimedByDeviceId: deviceId,
        claimedAt
      })
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

    await this.#audioTestRef(record.testId).set(this.#persistedAudioTest(record));

    return {
      audioTest: this.#publicAudioTest(record),
      plainToken: record.plainToken
    };
  }

  async getAudioTest(testId) {
    const snap = await this.#audioTestRef(testId).get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

    if (isAudioTestExpired(record) && record.status !== "expired") {
      await this.#audioTestRef(testId).set({
        status: "expired",
        updatedAt: nowIso()
      }, { merge: true });
      record.status = "expired";
    }

    return this.#publicAudioTest(record);
  }

  async claimAudioTest(testId, { token, deviceId, deviceLabel = null } = {}) {
    const ref = this.#audioTestRef(testId);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

    if (record.tokenHash !== hashToken(token)) {
      return null;
    }

    if (isAudioTestExpired(record)) {
      await ref.set({
        status: "expired",
        updatedAt: nowIso()
      }, { merge: true });
      return null;
    }

    if (record.deviceId && record.deviceId !== deviceId) {
      const error = new Error("このテストは別のiPhoneで使用中です。PCで新しいQRを発行してください。");
      error.statusCode = 409;
      throw error;
    }

    const claimedAt = nowIso();
    const patch = {
      deviceId,
      deviceLabel: deviceLabel || record.deviceLabel || null,
      deviceState: "connected",
      claimedAt: record.claimedAt || claimedAt,
      lastSeenAt: claimedAt,
      updatedAt: claimedAt
    };

    await ref.set(patch, { merge: true });

    return this.#publicAudioTest({
      ...record,
      ...patch
    });
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
    const ref = this.#audioTestRef(testId);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

    if (record.tokenHash !== hashToken(token)) {
      return null;
    }

    if (isAudioTestExpired(record)) {
      await ref.set({
        status: "expired",
        updatedAt: nowIso()
      }, { merge: true });
      return null;
    }

    if (record.deviceId && record.deviceId !== deviceId) {
      return null;
    }

    const updatedAt = nowIso();
    const patch = {
      deviceId,
      deviceLabel: deviceLabel || record.deviceLabel || null,
      permissionState: permissionState || record.permissionState || "unknown",
      deviceState: deviceState || record.deviceState || "connected",
      level: Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : (record.level || 0),
      inputLabel: inputLabel || record.inputLabel || null,
      sampleRate: Number.isFinite(sampleRate) ? Number(sampleRate) : (record.sampleRate || null),
      lastSeenAt: updatedAt,
      updatedAt
    };

    await ref.set(patch, { merge: true });

    return this.#publicAudioTest({
      ...record,
      ...patch
    });
  }

  async completeAudioTest(testId, { token = null, deviceId = null, actorId = null } = {}) {
    const ref = this.#audioTestRef(testId);
    const snap = await ref.get();

    if (!snap.exists) {
      return null;
    }

    const record = snap.data();

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
    const patch = {
      status: "completed",
      deviceState: "idle",
      level: 0,
      updatedAt,
      lastSeenAt: updatedAt
    };

    await ref.set(patch, { merge: true });

    return this.#publicAudioTest({
      ...record,
      ...patch
    });
  }

  async updateSession(sessionId, patch) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const mergedPatch = {
      ...patch,
      updatedAt: patch.updatedAt || nowIso()
    };
    await record.ref.update(mergedPatch);
    return {
      ...record.session,
      ...mergedPatch
    };
  }

  async updateSessionPromptProfile(sessionId, { promptProfileId, actorId }) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const session = record.session;

    if (!["ready", "paired", "degraded_recording", "stopped"].includes(session.status)) {
      const error = new Error("録音中またはSOAP下書き作成後はプロンプトを変更できません。");
      error.statusCode = 409;
      error.publicMessage = "録音中またはSOAP下書き作成後はプロンプトを変更できません。";
      throw error;
    }

    if (session.latestSoapVersionId) {
      const error = new Error("SOAP下書き作成後はプロンプトを変更できません。");
      error.statusCode = 409;
      error.publicMessage = "SOAP下書き作成後はプロンプトを変更できません。";
      throw error;
    }

    const updatedAt = nowIso();
    const patch = {
      promptProfileId,
      promptProfileSelectedAt: updatedAt,
      promptProfileSelectedByMemberId: actorId || null,
      promptProfileSelectionSource: "manual",
      updatedAt
    };

    await record.ref.update(patch);
    await this.appendAuditEvent(sessionId, {
      type: "session.prompt_profile_updated",
      actorType: "user",
      actorId,
      safePayload: {
        previousPromptProfileId: session.promptProfileId || null,
        promptProfileId
      }
    });

    return {
      ...session,
      ...patch
    };
  }

  async startRecording(sessionId, {
    deviceId,
    audioSourceType = "linked_mobile",
    deviceLabel = null,
    recordingMaxDurationMinutes = DEFAULT_RECORDING_MAX_DURATION_MINUTES,
    recordingExpiresAt = null,
    recordingAutoStopTaskName = null
  }) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const session = record.session;
    const startedAt = nowIso();
    const patch = {
      status: "recording",
      startedAt,
      recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(recordingMaxDurationMinutes),
      recordingExpiresAt,
      recordingAutoStopTaskName,
      recordingStopReason: null,
      mobileConnectionState: audioSourceType === "linked_mobile" ? "recording" : session.mobileConnectionState || "disconnected",
      audioSourceType,
      audioConnectionState: "recording",
      audioDeviceId: deviceId,
      audioDeviceLabel: deviceLabel || (audioSourceType === "local_browser" ? "この端末のマイク" : "録音用スマホ"),
      updatedAt: startedAt
    };
    await record.ref.update(patch);
    await this.appendAuditEvent(sessionId, {
      type: "recording.started",
      actorType: "device",
      actorId: deviceId,
      safePayload: {
        recordingMaxDurationMinutes: patch.recordingMaxDurationMinutes,
        recordingExpiresAt
      }
    });
    return {
      ...session,
      ...patch
    };
  }

  async stopRecording(sessionId, {
    actorType = "user",
    actorId = null,
    stopReason = "manual"
  } = {}) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const session = record.session;
    const stoppedAt = nowIso();
    const stoppedLinkedMobile = session.audioSourceType === "linked_mobile";
    const patch = {
      status: "stopped",
      stoppedAt,
      recordingStopReason: stopReason,
      mobileConnectionState: stoppedLinkedMobile
        ? "connected"
        : session.mobileConnectionState === "recording"
          ? "disconnected"
          : session.mobileConnectionState || "disconnected",
      audioConnectionState: stoppedLinkedMobile ? "connected" : "disconnected",
      updatedAt: stoppedAt
    };
    await record.ref.update(patch);
    await this.appendAuditEvent(sessionId, {
      type: "recording.stopped",
      actorType,
      actorId: actorId || session.createdByMemberId || session.createdByUserId,
      safePayload: {
        stopReason,
        recordingExpiresAt: session.recordingExpiresAt || null
      }
    });
    return {
      ...session,
      ...patch
    };
  }

  async discardRecordingAttempt(sessionId, { actorId = "demo-doctor" } = {}) {
    const state = await this.getSessionState(sessionId);

    if (!state) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const record = await this.#mustGetSessionRecord(sessionId);
    const session = state.session;
    const discardedTurnCount = state.turns.length;
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
    const patch = {
      status: "ready",
      startedAt: null,
      stoppedAt: null,
      recordingExpiresAt: null,
      recordingAutoStopTaskName: null,
      recordingStopReason: null,
      finalizedAt: null,
      approvedAt: null,
      latestSoapVersionId: null,
      latestPartialPreview: null,
      latestFinalTurnIndex: 0,
      errorCode: null,
      errorMessageSafe: null,
      mobileConnectionState: nextMobileConnectionState,
      audioConnectionState: nextMobileConnectionState === "disconnected" ? "disconnected" : "mic_ready",
      audioSourceType: null,
      audioDeviceId: wasLinkedMobileRecording ? session.audioDeviceId || null : null,
      audioDeviceLabel: wasLinkedMobileRecording ? session.audioDeviceLabel || null : null,
      updatedAt
    };

    await this.#deleteCollection(record.ref.collection("turns"));
    await record.ref.update(patch);

    await this.appendAuditEvent(sessionId, {
      type: "recording.discarded",
      actorType: "user",
      actorId,
      safePayload: {
        discardedTurnCount,
        previousDurationMs,
        previousStartedAt,
        previousStoppedAt,
        clearedSoap: Boolean(state.latestSoap)
      }
    });

    return {
      ...session,
      ...patch
    };
  }

  async appendTurn(sessionId, turnInput) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const session = record.session;
    const createdAt = nowIso();
    const turn = {
      turnId: turnInput.turnId || createId("turn"),
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

    await record.ref.collection("turns").doc(turn.turnId).set(turn);
    await record.ref.update({
      latestFinalTurnIndex: turn.turnIndex,
      updatedAt: createdAt
    });
    return clone(turn);
  }

  async listTurns(sessionId) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const snap = await record.ref.collection("turns").orderBy("turnIndex").get();
    return snap.docs.map((doc) => doc.data());
  }

  async saveSoapVersion(sessionId, soapInput) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const versionsSnap = await record.ref.collection("soap_versions").orderBy("version", "desc").limit(1).get();
    const nextVersion = versionsSnap.empty ? 1 : versionsSnap.docs[0].data().version + 1;
    const createdAt = nowIso();
    const soap = {
      versionId: createId("soap"),
      version: nextVersion,
      status: soapInput.status || "ready",
      outputText: soapInput.outputText || soapInput.output_text || soapInput.structuredJson?.outputText || buildLegacySoapOutputText(soapInput),
      structuredJson: soapInput.structuredJson || {},
      model: soapInput.model || "mock-soap-v1",
      promptVersion: soapInput.promptVersion || "draft-v1",
      templateKey: soapInput.templateKey || null,
      promptProfileId: soapInput.promptProfileId || null,
      promptProfileVersionId: soapInput.promptProfileVersionId || null,
      resolvedPromptHash: soapInput.resolvedPromptHash || null,
      inputTranscriptRevision: soapInput.inputTranscriptRevision || "firestore",
      createdBy: soapInput.createdBy || "system",
      approvedByUserId: soapInput.approvedByUserId || null,
      createdAt,
      updatedAt: createdAt
    };

    await Promise.all([
      record.ref.collection("soap_versions").doc(soap.versionId).set(soap),
      record.ref.update({
        latestSoapVersionId: soap.versionId,
        updatedAt: createdAt
      })
    ]);
    return clone(soap);
  }

  async approveSoapVersion(sessionId, { versionId, approvedByUserId }) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const soapQuery = versionId
      ? record.ref.collection("soap_versions").doc(versionId).get()
      : record.ref.collection("soap_versions").orderBy("version", "desc").limit(1).get();

    const soapResult = await soapQuery;
    const soap =
      versionId
        ? soapResult.exists
          ? soapResult.data()
          : null
        : soapResult.empty
          ? null
          : soapResult.docs[0].data();

    if (!soap) {
      throw new Error("SOAP version not found");
    }

    const approvedAt = nowIso();
    const soapPatch = {
      status: "approved",
      approvedByUserId: approvedByUserId || null,
      updatedAt: approvedAt
    };
    const sessionPatch = {
      status: "approved",
      approvedAt,
      updatedAt: approvedAt
    };

    await Promise.all([
      record.ref.collection("soap_versions").doc(soap.versionId).update(soapPatch),
      record.ref.update(sessionPatch)
    ]);

    return {
      session: {
        ...record.session,
        ...sessionPatch
      },
      soap: {
        ...soap,
        ...soapPatch
      }
    };
  }

  async appendAuditEvent(sessionId, eventInput) {
    const record = await this.#mustGetSessionRecord(sessionId);
    const event = {
      eventId: createId("evt"),
      type: eventInput.type,
      actorType: eventInput.actorType,
      actorId: eventInput.actorId,
      safePayload: eventInput.safePayload || {},
      createdAt: nowIso()
    };
    await record.ref.collection("audit_events").doc(event.eventId).set(event);
    return clone(event);
  }

  async appendOrganizationAuditEvent(orgId, eventInput) {
    const event = {
      eventId: createId("evt"),
      orgId,
      type: eventInput.type,
      actorType: eventInput.actorType || "user",
      actorId: eventInput.actorId,
      safePayload: eventInput.safePayload || {},
      createdAt: nowIso()
    };
    await this.#organizationRef(orgId).collection("audit_events").doc(event.eventId).set(event);
    return clone(event);
  }

  async listOrganizationAuditEvents({ orgId, limit = 100 } = {}) {
    if (!orgId) {
      return [];
    }

    const snap = await this.#organizationRef(orgId)
      .collection("audit_events")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((doc) => doc.data());
  }

  async listMembers({ orgId } = {}) {
    if (!orgId) {
      return [];
    }

    const snap = await this.#organizationRef(orgId).collection("members").get();
    return snap.docs
      .map((doc) => doc.data())
      .sort((left, right) => String(left.displayName || left.loginId || "").localeCompare(String(right.displayName || right.loginId || ""), "ja"));
  }

  async checkRateLimit({ bucket, identifier, limit, windowMs, now = Date.now() } = {}) {
    const identifierHash = hashText(`${bucket}:${identifier}`);
    const ref = this.#rateLimitRef(bucket, identifier);
    let outcome = { limited: false, count: 1, resetAt: now + windowMs };

    await this.db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists ? snap.data() : null;
      const currentResetAt = current?.resetAt ? Date.parse(current.resetAt) : 0;
      const updatedAt = new Date(now).toISOString();

      if (!current || currentResetAt <= now) {
        outcome = {
          limited: false,
          count: 1,
          resetAt: now + windowMs
        };
        transaction.set(ref, {
          bucket,
          identifierHash,
          count: outcome.count,
          resetAt: new Date(outcome.resetAt).toISOString(),
          createdAt: current?.createdAt || updatedAt,
          updatedAt
        });
        return;
      }

      const count = Number(current.count || 0) + 1;
      outcome = {
        limited: count > limit,
        count,
        resetAt: currentResetAt
      };
      transaction.update(ref, {
        count,
        updatedAt
      });
    });

    return outcome;
  }

  async findTrustedRecorderByDeviceId(deviceId) {
    if (!deviceId) {
      return null;
    }

    const snap = await this.db.collectionGroup("trusted_recorders")
      .where("deviceId", "==", deviceId)
      .limit(10)
      .get();
    const match = snap.docs.map((doc) => doc.data()).find((recorder) => recorder.status === "active");
    return match || null;
  }

  async registerTrustedRecorder({ orgId, deviceId, label, actorId }) {
    const organizationSnap = await this.#organizationRef(orgId).get();

    if (!organizationSnap.exists) {
      return null;
    }

    const ref = this.#trustedRecorderRef(orgId, deviceId);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : null;
    const updatedAt = nowIso();
    const recorder = {
      ...(existing || {}),
      recorderId: existing?.recorderId || hashText(deviceId),
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

    await ref.set(recorder, { merge: false });
    await this.appendOrganizationAuditEvent(orgId, {
      type: existing ? "trusted_recorder.refreshed" : "trusted_recorder.registered",
      actorId,
      safePayload: {
        deviceId,
        label: recorder.label
      }
    });

    return recorder;
  }

  async listTrustedRecorders({ orgId, includeRevoked = false } = {}) {
    if (!orgId) {
      return [];
    }

    const snap = await this.#organizationRef(orgId).collection("trusted_recorders").get();
    return snap.docs
      .map((doc) => doc.data())
      .filter((recorder) => includeRevoked || recorder.status !== "revoked")
      .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0));
  }

  async getTrustedRecorder({ orgId, deviceId } = {}) {
    if (!orgId || !deviceId) {
      return null;
    }

    const snap = await this.#trustedRecorderRef(orgId, deviceId).get();
    return snap.exists ? snap.data() : null;
  }

  async touchTrustedRecorder({ orgId, deviceId } = {}) {
    if (!orgId || !deviceId) {
      return null;
    }

    const ref = this.#trustedRecorderRef(orgId, deviceId);
    const snap = await ref.get();

    if (!snap.exists || snap.data().status !== "active") {
      return null;
    }

    const patch = {
      lastSeenAt: Date.now(),
      updatedAt: nowIso()
    };
    await ref.update(patch);
    return {
      ...snap.data(),
      ...patch
    };
  }

  async revokeTrustedRecorder({ orgId, deviceId, actorId }) {
    if (!orgId || !deviceId) {
      return null;
    }

    const ref = this.#trustedRecorderRef(orgId, deviceId);
    const snap = await ref.get();

    if (!snap.exists || snap.data().status === "revoked") {
      return null;
    }

    const updatedAt = nowIso();
    const patch = {
      status: "revoked",
      revokedAt: updatedAt,
      revokedByMemberId: actorId || null,
      updatedAt
    };
    await ref.update(patch);
    await this.appendOrganizationAuditEvent(orgId, {
      type: "trusted_recorder.revoked",
      actorId,
      safePayload: {
        deviceId
      }
    });

    return {
      ...snap.data(),
      ...patch
    };
  }

  async runRetentionCleanup({ orgId = null, dryRun = true, now = new Date(), actorId = "retention-cleanup" } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const organizationSnaps = orgId
      ? [await this.#organizationRef(orgId).get()].filter((snap) => snap.exists)
      : (await this.db.collection("organizations").get()).docs;
    const results = [];

    for (const organizationSnap of organizationSnaps) {
      const organization = organizationSnap.data();
      const policy = organization.retentionPolicy || {};
      const audioCutoff = new Date(nowMs - Number(policy.audioDays || 90) * 24 * 60 * 60 * 1000).toISOString();
      const transcriptCutoff = new Date(nowMs - Number(policy.transcriptDays || 365) * 24 * 60 * 60 * 1000).toISOString();
      const auditCutoff = new Date(nowMs - Number(policy.auditDays || 365) * 24 * 60 * 60 * 1000).toISOString();
      const orgRef = this.#organizationRef(organization.orgId);
      const [auditSnap, audioSnap, encounterSnap] = await Promise.all([
        orgRef.collection("audit_events").where("createdAt", "<", auditCutoff).limit(200).get(),
        orgRef.collection("encounters").where("updatedAt", "<", audioCutoff).limit(200).get(),
        orgRef.collection("encounters").where("updatedAt", "<", transcriptCutoff).limit(100).get()
      ]);
      const audioDocs = audioSnap.docs.filter((doc) => Boolean(doc.data().rawAudioPath));
      const encounterDocs = encounterSnap.docs;

      if (!dryRun) {
        const batch = this.db.batch();
        let batchHasWrites = false;

        for (const doc of auditSnap.docs) {
          batch.delete(doc.ref);
          batchHasWrites = true;
        }

        for (const doc of audioDocs) {
          batch.update(doc.ref, {
            rawAudioPath: null,
            updatedAt: nowIso()
          });
          batchHasWrites = true;
        }

        if (batchHasWrites) {
          await batch.commit();
        }

        for (const doc of encounterDocs) {
          if (typeof this.db.recursiveDelete === "function") {
            await this.db.recursiveDelete(doc.ref);
          } else {
            await doc.ref.delete();
          }
          await this.db.collection("encounter_index").doc(doc.id).delete().catch(() => {});
        }

        await this.appendOrganizationAuditEvent(organization.orgId, {
          type: "retention.cleanup.completed",
          actorType: "system",
          actorId,
          safePayload: {
            auditEventsDeleted: auditSnap.size,
            rawAudioPointersCleared: audioDocs.length,
            encountersDeleted: encounterDocs.length
          }
        });
      }

      results.push({
        orgId: organization.orgId,
        dryRun,
        auditEventsDeleted: auditSnap.size,
        rawAudioPointersCleared: audioDocs.length,
        encountersDeleted: encounterDocs.length
      });
    }

    return { dryRun, organizations: results };
  }

  async listRoleDefinitions() {
    const snap = await this.db.collection("role_definitions").get();
    const definitions = snap.empty
      ? MEMBER_ROLE_DEFINITIONS
      : snap.docs.map((doc) => ({ roleId: doc.id, ...doc.data() }));

    return definitions
      .map((definition) => clone(definition))
      .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
  }

  async listSoapFormatProfiles({ orgId, memberId = null, roles = [] } = {}) {
    if (!orgId) {
      return [];
    }

    const canSeeAll = canManageOrganizationRoles(roles);
    const snap = await this.#organizationRef(orgId).collection("prompt_profiles").get();
    const profiles = await Promise.all(snap.docs.map((doc) => this.#profileWithVersions(orgId, doc.id, doc.data())));

    return profiles
      .filter((profile) => canSeeAll || !profile.ownerMemberId || profile.ownerMemberId === memberId || profile.scope !== "member")
      .map((profile) => serializeSoapFormatProfile(profile))
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  }

  async listSoapFormatProfileSummaries({ orgId, memberId = null, roles = [] } = {}) {
    if (!orgId) {
      return [];
    }

    const canSeeAll = canManageOrganizationRoles(roles);
    const snap = await this.#organizationRef(orgId).collection("prompt_profiles").get();

    return snap.docs
      .map((doc) => ({
        ...doc.data(),
        profileId: doc.data().profileId || doc.id,
        orgId
      }))
      .filter((profile) => canSeeAll || !profile.ownerMemberId || profile.ownerMemberId === memberId || profile.scope !== "member")
      .map((profile) => serializeSoapFormatProfile(profile))
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  }

  async getSoapFormatProfile({ orgId, profileId }) {
    if (!orgId || !profileId) {
      return null;
    }

    const profile = await this.#profileWithVersions(orgId, profileId);
    return profile ? serializeSoapFormatProfile(profile) : null;
  }

  async #findSoapFormatDisplayNameConflict({ orgId, displayName, excludeProfileId = null }) {
    const displayNameKey = normalizeSoapFormatDisplayNameKey(displayName);

    if (!orgId || !displayNameKey) {
      return null;
    }

    const snap = await this.#organizationRef(orgId).collection("prompt_profiles").get();
    const duplicate = snap.docs.find((doc) => (
      doc.id !== excludeProfileId &&
      normalizeSoapFormatDisplayNameKey(doc.data().displayName) === displayNameKey
    ));

    return duplicate?.id || null;
  }

  async createSoapFormatProfile({ orgId, input, actorId }) {
    const createdAt = nowIso();
    const normalized = normalizeSoapFormatProfile(input);
    const existingConflictId = await this.#findSoapFormatDisplayNameConflict({
      orgId,
      displayName: normalized.displayName
    });

    if (existingConflictId) {
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
      createdByMemberId: actorId,
      updatedByMemberId: actorId,
      createdAt,
      updatedAt: createdAt
    };
    const profileRef = this.#promptProfileRef(orgId, profileId);
    const displayNameKey = normalizeSoapFormatDisplayNameKey(normalized.displayName);
    const nameKeyRef = this.#promptProfileNameKeyRef(orgId, displayNameKey);

    await this.db.runTransaction(async (transaction) => {
      const nameKeySnap = await transaction.get(nameKeyRef);

      if (nameKeySnap.exists && nameKeySnap.data().profileId !== profileId) {
        throw duplicateSoapFormatDisplayNameError();
      }

      transaction.set(profileRef, profile);
      transaction.set(profileRef.collection("versions").doc(version.profileVersionId), {
        ...version,
        orgId
      });
      transaction.set(nameKeyRef, {
        displayNameKey,
        displayName: normalized.displayName,
        profileId,
        createdAt,
        updatedAt: createdAt
      });
    });

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.created",
      actorId,
      safePayload: {
        profileId,
        scope: profile.scope,
        ownerMemberId: profile.ownerMemberId
      }
    });

    return serializeSoapFormatProfile({
      ...profile,
      versions: [version]
    });
  }

  async updateSoapFormatDraft({ orgId, profileId, input, actorId }) {
    const profile = await this.#profileWithVersions(orgId, profileId);
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
    const existingConflictId = await this.#findSoapFormatDisplayNameConflict({
      orgId,
      displayName: normalized.displayName,
      excludeProfileId: profileId
    });

    if (existingConflictId) {
      throw duplicateSoapFormatDisplayNameError();
    }

    const versions = profile.versions || [];
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

    const profilePatch = {
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
      updatedByMemberId: actorId,
      updatedAt
    };

    const previousDisplayNameKey = normalizeSoapFormatDisplayNameKey(profile.displayName);
    const nextDisplayNameKey = normalizeSoapFormatDisplayNameKey(normalized.displayName);
    const nextNameKeyRef = this.#promptProfileNameKeyRef(orgId, nextDisplayNameKey);
    const previousNameKeyRef = previousDisplayNameKey && previousDisplayNameKey !== nextDisplayNameKey
      ? this.#promptProfileNameKeyRef(orgId, previousDisplayNameKey)
      : null;
    const profileRef = this.#promptProfileRef(orgId, profileId);
    const versionRef = profileRef.collection("versions").doc(draftVersion.profileVersionId);

    await this.db.runTransaction(async (transaction) => {
      const nextNameKeySnap = await transaction.get(nextNameKeyRef);
      const previousNameKeySnap = previousNameKeyRef ? await transaction.get(previousNameKeyRef) : null;

      if (nextNameKeySnap.exists && nextNameKeySnap.data().profileId !== profileId) {
        throw duplicateSoapFormatDisplayNameError();
      }

      transaction.set(profileRef, profilePatch, { merge: true });
      transaction.set(versionRef, {
        ...draftVersion,
        orgId
      }, { merge: true });
      transaction.set(nextNameKeyRef, {
        displayNameKey: nextDisplayNameKey,
        displayName: normalized.displayName,
        profileId,
        updatedAt
      }, { merge: true });

      if (previousNameKeyRef && (!previousNameKeySnap.exists || previousNameKeySnap.data().profileId === profileId)) {
        transaction.delete(previousNameKeyRef);
      }
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

    return this.getSoapFormatProfile({ orgId, profileId });
  }

  async publishSoapFormatProfile({ orgId, profileId, versionId = null, actorId }) {
    const profile = await this.#profileWithVersions(orgId, profileId);
    if (!profile) {
      return null;
    }

    const targetVersion =
      (profile.versions || []).find((version) => version.profileVersionId === (versionId || profile.currentDraftVersionId)) ||
      (profile.versions || []).find((version) => version.profileVersionId === profile.currentVersionId) ||
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
    const batch = this.db.batch();
    for (const version of profile.versions || []) {
      if (version.status === "active") {
        batch.set(this.#promptProfileRef(orgId, profileId).collection("versions").doc(version.profileVersionId), {
          status: "archived",
          updatedAt
        }, { merge: true });
      }
    }
    batch.set(this.#promptProfileRef(orgId, profileId).collection("versions").doc(targetVersion.profileVersionId), {
      status: "active",
      approved: true,
      validationStatus: "passed",
      validationIssues: [],
      updatedByMemberId: actorId,
      updatedAt
    }, { merge: true });
    batch.set(this.#promptProfileRef(orgId, profileId), {
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
    }, { merge: true });
    await batch.commit();

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.published",
      actorId,
      safePayload: {
        profileId,
        profileVersionId: targetVersion.profileVersionId,
        version: targetVersion.version
      }
    });

    return this.getSoapFormatProfile({ orgId, profileId });
  }

  async archiveSoapFormatProfile({ orgId, profileId, actorId }) {
    const profile = await this.#profileWithVersions(orgId, profileId);
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
    const batch = this.db.batch();
    for (const version of profile.versions || []) {
      if (version.status === "active") {
        batch.set(this.#promptProfileRef(orgId, profileId).collection("versions").doc(version.profileVersionId), {
          status: "archived",
          updatedByMemberId: actorId,
          updatedAt
        }, { merge: true });
      }
    }

    const membersSnap = await this.#organizationRef(orgId)
      .collection("members")
      .where("defaultPromptProfileId", "==", profileId)
      .get();
    for (const doc of membersSnap.docs) {
      batch.set(doc.ref, {
        defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
        updatedAt
      }, { merge: true });
    }

    const organizationSnap = await this.#organizationRef(orgId).get();
    if (organizationSnap.exists && organizationSnap.data().defaultPromptProfileId === profileId) {
      batch.set(this.#organizationRef(orgId), {
        defaultPromptProfileId: DEFAULT_PROMPT_PROFILE.profileId,
        updatedAt
      }, { merge: true });
    }

    batch.set(this.#promptProfileRef(orgId, profileId), {
      status: "archived",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: null,
      updatedByMemberId: actorId,
      updatedAt
    }, { merge: true });

    await batch.commit();

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.archived",
      actorId,
      safePayload: {
        profileId,
        unassignedMemberCount: membersSnap.size
      }
    });

    return this.getSoapFormatProfile({ orgId, profileId });
  }

  async assignSoapFormatToMember({ orgId, memberId, profileId, actorId }) {
    const memberRef = this.#memberRef(orgId, memberId);
    const memberSnap = await memberRef.get();

    if (!memberSnap.exists) {
      return null;
    }

    if (profileId) {
      const profileSnap = await this.#promptProfileRef(orgId, profileId).get();
      const profile = profileSnap.exists ? profileSnap.data() : null;
      if (!profile || profile.status !== "active" || profile.approved !== true) {
        return null;
      }
    }

    const updatedAt = nowIso();
    const patch = {
      defaultPromptProfileId: profileId || DEFAULT_PROMPT_PROFILE.profileId,
      updatedAt
    };
    await memberRef.update(patch);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.assigned",
      actorId,
      safePayload: {
        memberId,
        profileId: patch.defaultPromptProfileId
      }
    });

    return {
      ...memberSnap.data(),
      ...patch
    };
  }

  async assignSoapFormatToOrganization({ orgId, profileId, actorId }) {
    const organizationRef = this.#organizationRef(orgId);
    const organizationSnap = await organizationRef.get();

    if (!organizationSnap.exists) {
      return null;
    }

    if (profileId) {
      const profileSnap = await this.#promptProfileRef(orgId, profileId).get();
      const profile = profileSnap.exists ? profileSnap.data() : null;
      if (!profile || profile.status !== "active" || profile.approved !== true) {
        return null;
      }
    }

    const updatedAt = nowIso();
    const patch = {
      defaultPromptProfileId: profileId || DEFAULT_PROMPT_PROFILE.profileId,
      updatedAt
    };
    await organizationRef.update(patch);

    await this.appendOrganizationAuditEvent(orgId, {
      type: "soap_format.assigned",
      actorId,
      safePayload: {
        targetType: "organization",
        profileId: patch.defaultPromptProfileId
      }
    });

    return {
      ...organizationSnap.data(),
      ...patch
    };
  }

  async resolvePromptProfile({ orgId, memberId, promptProfileId = null } = {}) {
    if (!orgId) {
      return clone(DEFAULT_PROMPT_PROFILE);
    }

    const [organizationSnap, memberSnap] = await Promise.all([
      this.#organizationRef(orgId).get(),
      memberId ? this.#memberRef(orgId, memberId).get() : null
    ]);
    const organization = organizationSnap.exists ? organizationSnap.data() : null;
    const member = memberSnap?.exists ? memberSnap.data() : null;
    const resolvedProfileId = promptProfileId || member?.defaultPromptProfileId || organization?.defaultPromptProfileId || DEFAULT_PROMPT_PROFILE.profileId;
    const profile = await this.#profileWithVersions(orgId, resolvedProfileId);

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
      promptVersion: activeVersion.promptVersion || profile.promptVersion || `${resolvedProfileId}-v${activeVersion.version || 1}`,
      templateKey: activeVersion.templateKey || profile.templateKey || "outpatient_soap_note",
      displayName: profile.displayName || "SOAPフォーマット",
      scope: profile.scope || "organization",
      ownerMemberId: profile.ownerMemberId || null,
      outputTemplate: activeVersion.outputTemplate || profile.outputTemplate || DEFAULT_PROMPT_PROFILE.outputTemplate,
      customization: activeVersion.customization || profile.customization || {},
      sections: activeVersion.sections || profile.sections || [],
      source: "organization",
      resolvedPromptHash: activeVersion.resolvedPromptHash || hashJson(activeVersion)
    };

    return resolved;
  }

  async #bootstrapIdentity({ organizationCode, loginId, password, defaultOrgId, defaultDisplayName }) {
    const codeRef = this.#organizationCodeRef(organizationCode);
    const codeSnap = await codeRef.get();
    const orgId = codeSnap.exists
      ? codeSnap.data().orgId
      : defaultOrgId && !(await this.#organizationRef(defaultOrgId).get()).exists
        ? defaultOrgId
        : createId("org");
    const memberId = createId("mem");
    const createdAt = nowIso();
    const batch = this.db.batch();

    if (!codeSnap.exists) {
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
      batch.set(codeRef, {
        organizationCode,
        orgId,
        createdAt,
        updatedAt: createdAt
      });
      batch.set(this.#organizationRef(orgId), organization);
      batch.set(this.#promptProfileRef(orgId, DEFAULT_PROMPT_PROFILE.profileId), {
        ...DEFAULT_PROMPT_PROFILE,
        orgId,
        createdAt,
        updatedAt: createdAt
      });
      batch.set(this.#promptProfileRef(orgId, DEFAULT_PROMPT_PROFILE.profileId).collection("versions").doc(DEFAULT_PROMPT_PROFILE.profileVersionId), {
        ...DEFAULT_PROMPT_PROFILE,
        orgId,
        version: 1,
        createdAt,
        updatedAt: createdAt
      });
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

    batch.set(this.#memberRef(orgId, memberId), member);
    batch.set(this.#identityRef(identity.identityId), identity);
    await batch.commit();
  }

  async #getSessionRecord(sessionId) {
    const indexSnap = await this.#encounterIndexRef(sessionId).get();

    if (indexSnap.exists) {
      const index = indexSnap.data();
      const ref = this.#encounterRef(index.orgId, sessionId);
      const snap = await ref.get();
      return snap.exists ? { ref, session: snap.data(), orgId: index.orgId } : null;
    }

    return null;
  }

  async #mustGetSessionRecord(sessionId) {
    const record = await this.#getSessionRecord(sessionId);

    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return record;
  }

  async #deleteCollection(collectionRef, batchSize = 250) {
    while (true) {
      const snap = await collectionRef.limit(batchSize).get();

      if (snap.empty) {
        return;
      }

      const batch = this.db.batch();
      for (const doc of snap.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  }

  async #profileWithVersions(orgId, profileId, existingProfile = null) {
    const profileRef = this.#promptProfileRef(orgId, profileId);
    const profile = existingProfile || (await profileRef.get()).data();

    if (!profile) {
      return null;
    }

    const versionsSnap = await profileRef.collection("versions").orderBy("version", "desc").limit(20).get();
    return {
      ...profile,
      profileId: profile.profileId || profileId,
      orgId,
      versions: versionsSnap.docs.map((doc) => doc.data())
    };
  }

  #organizationRef(orgId) {
    return this.db.collection("organizations").doc(orgId);
  }

  #organizationCodeRef(organizationCode) {
    return this.db.collection("organization_codes").doc(organizationCode);
  }

  #identityRef(identityKey) {
    return this.db.collection("login_identities").doc(identityKey);
  }

  #signupApplicationRef(signupId) {
    return this.db.collection("signup_applications").doc(signupId);
  }

  #stripeEventReceiptRef(eventId) {
    return this.db.collection("stripe_event_receipts").doc(eventId);
  }

  #passwordSetupTokenRef(tokenHash) {
    return this.db.collection("password_setup_tokens").doc(tokenHash);
  }

  #emailVerificationTokenRef(tokenHash) {
    return this.db.collection("email_verification_tokens").doc(tokenHash);
  }

  #rateLimitRef(bucket, identifier) {
    return this.db.collection("rate_limits").doc(hashText(`${bucket}:${identifier}`));
  }

  #memberRef(orgId, memberId) {
    return this.#organizationRef(orgId).collection("members").doc(memberId);
  }

  #trustedRecorderRef(orgId, deviceId) {
    return this.#organizationRef(orgId).collection("trusted_recorders").doc(hashText(deviceId));
  }

  #encountersRef(orgId) {
    return this.#organizationRef(orgId).collection("encounters");
  }

  #encounterRef(orgId, sessionId) {
    return this.#encountersRef(orgId).doc(sessionId);
  }

  #encounterIndexRef(sessionId) {
    return this.db.collection("encounter_index").doc(sessionId);
  }

  #pairingRef(pairingId) {
    return this.db.collection("pairings").doc(pairingId);
  }

  #audioTestRef(testId) {
    return this.db.collection("audio_tests").doc(testId);
  }

  #promptProfileRef(orgId, profileId) {
    return this.#organizationRef(orgId).collection("prompt_profiles").doc(profileId);
  }

  #promptProfileNameKeyRef(orgId, displayNameKey) {
    return this.#organizationRef(orgId).collection("prompt_profile_name_keys").doc(hashText(displayNameKey));
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

  #persistedPairing(pairing) {
    const { plainToken: _plainToken, ...persisted } = pairing;
    return persisted;
  }

  #persistedAudioTest(record) {
    const { plainToken: _plainToken, ...persisted } = record;
    return persisted;
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

  #publicAudioTest(record) {
    return clone({
      testId: record.testId,
      orgId: record.orgId,
      createdByMemberId: record.createdByMemberId || null,
      status: record.status || "active",
      deviceId: record.deviceId || null,
      deviceLabel: record.deviceLabel || null,
      permissionState: record.permissionState || "unknown",
      deviceState: record.deviceState || "waiting",
      level: Number(record.level || 0),
      inputLabel: record.inputLabel || null,
      sampleRate: record.sampleRate || null,
      claimedAt: record.claimedAt || null,
      lastSeenAt: record.lastSeenAt || null,
      expiresAt: record.expiresAt || null,
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null
    });
  }
}

async function countQuery(query) {
  if (typeof query.count === "function") {
    const snapshot = await query.count().get();
    return Number(snapshot.data().count || 0);
  }

  const snapshot = await query.select("sessionId").get();
  return snapshot.size;
}
