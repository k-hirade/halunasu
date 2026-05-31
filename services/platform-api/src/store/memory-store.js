import crypto from "node:crypto";
import {
  normalizeLoginId,
  normalizeOrganizationCode,
  validateCreateAuditEventInput,
  validateCreateDataRequestInput,
  validateCreateDepartmentInput,
  validateCreateFacilityInput,
  validateCreateMemberInput,
  validateCreateOrganizationInput,
  validateCreatePatientInput,
  validateCreateSignupApplicationInput,
  validatePatchDepartmentInput,
  validatePatchFacilityInput,
  validatePatchDataRequestInput,
  validatePatchMemberInput,
  validatePatchOrganizationInput,
  validatePatchPatientInput,
  validatePatchProductEntitlementInput,
  validateSetupAdminPasswordInput,
  validateUpsertProductEntitlementInput,
  validateVerifySignupEmailInput
} from "../../../../packages/platform-contracts/src/index.js";
import { loginIdentityKey } from "../../../../packages/firestore-schema/src/index.js";
import { hashPassword } from "../auth/password.js";
import {
  buildOrganizationBillingState,
  buildPendingSetupEntitlement,
  buildTrialEntitlement,
  normalizeSignupProductSelection
} from "../billing/catalog.js";

export class MemoryPlatformStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory;
    this.tokenFactory = options.tokenFactory || defaultTokenFactory;
    this.organizations = new Map();
    this.organizationCodes = new Map();
    this.signupApplications = new Map();
    this.signupEmailTokens = new Map();
    this.passwordSetupTokens = new Map();
    this.stripeEventReceipts = new Map();
    this.rateLimits = new Map();
    this.loginIdentities = new Map();
    this.membersByOrg = new Map();
    this.facilitiesByOrg = new Map();
    this.departmentsByOrg = new Map();
    this.patientsByOrg = new Map();
    this.productEntitlementsByOrg = new Map();
    this.auditEventsByOrg = new Map();
    this.dataRequestsByOrg = new Map();
  }

  createOrganization(input) {
    const normalized = validateCreateOrganizationInput(input);
    if (this.organizationCodes.has(normalized.organizationCode)) {
      throw conflictError("organizationCode already exists", "organizationCode");
    }

    const now = this.timestamp();
    const orgId = this.idFactory("org");
    const organization = compactObject({
      orgId,
      ...normalized,
      defaultFacilityId: undefined,
      defaultDepartmentId: undefined,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.organizations.set(orgId, organization);
    this.organizationCodes.set(normalized.organizationCode, orgId);
    this.membersByOrg.set(orgId, new Map());
    this.facilitiesByOrg.set(orgId, new Map());
    this.departmentsByOrg.set(orgId, new Map());
    this.patientsByOrg.set(orgId, new Map());
    this.productEntitlementsByOrg.set(orgId, new Map());
    this.auditEventsByOrg.set(orgId, new Map());
    this.dataRequestsByOrg.set(orgId, new Map());

    return organization;
  }

  listOrganizations() {
    return sortByCreatedAt([...this.organizations.values()]);
  }

  getOrganization(orgId) {
    return this.organizations.get(orgId) || null;
  }

  updateOrganization(orgId, input) {
    const current = this.requireOrganization(orgId);
    const patch = validatePatchOrganizationInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.organizations.set(orgId, updated);
    return updated;
  }

  findOrganizationByStripeCustomerId(stripeCustomerId) {
    return [...this.organizations.values()]
      .find((organization) => organization.billing?.stripeCustomerId === stripeCustomerId) || null;
  }

  findOrganizationByStripeSubscriptionId(stripeSubscriptionId) {
    return [...this.organizations.values()]
      .find((organization) => organization.billing?.stripeSubscriptionId === stripeSubscriptionId) || null;
  }

  createSignupApplication(input) {
    const normalized = validateCreateSignupApplicationInput(input);
    const now = this.timestamp();
    const applicationId = this.idFactory("app");
    const application = compactObject({
      applicationId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.signupApplications.set(applicationId, application);
    return application;
  }

  createSignupApplicationWithEmailToken(input) {
    const signupApplication = this.createSignupApplication({
      ...input,
      status: "submitted"
    });
    const emailVerification = this.createSignupEmailToken(signupApplication);

    return { signupApplication, emailVerification };
  }

  getSignupApplication(applicationId) {
    return this.signupApplications.get(applicationId) || null;
  }

  listSignupApplications() {
    return sortByCreatedAt([...this.signupApplications.values()]);
  }

  verifySignupEmail(input) {
    const { token } = validateVerifySignupEmailInput(input);
    const tokenKey = digestToken(token);
    const tokenRecord = this.requireActiveToken(this.signupEmailTokens, token, "email verification token");
    const currentApplication = this.getSignupApplication(tokenRecord.applicationId);
    if (!currentApplication) {
      throw notFoundError("signup application not found");
    }
    if (currentApplication.status !== "submitted") {
      throw conflictError("signup application is not waiting for email verification", "token");
    }

    const now = this.timestamp();
    const requestedProducts = normalizeSignupProductSelection(currentApplication.requestedProducts);
    const organization = this.createOrganization({
      organizationCode: currentApplication.organizationCode,
      displayName: currentApplication.organizationDisplayName,
      status: "trialing",
      billing: buildOrganizationBillingState(now),
      access: {
        status: "active",
        enabledProducts: requestedProducts
      }
    });
    const adminMember = this.createMember(organization.orgId, {
      loginId: currentApplication.applicantEmail,
      displayName: currentApplication.applicantName,
      email: currentApplication.applicantEmail,
      globalRoles: ["org_admin"],
      productRoles: productAdminRoles(requestedProducts),
      password: `${this.tokenFactory("initial_password")}_temporary`
    });
    const productEntitlements = requestedProducts.map((productId) => this.upsertProductEntitlement(
      organization.orgId,
      buildPendingSetupEntitlement(productId, this.now())
    ));
    const signupApplication = compactObject({
      ...currentApplication,
      status: "provisioned",
      emailVerifiedAt: now,
      provisionedAt: now,
      orgId: organization.orgId,
      adminMemberId: adminMember.memberId,
      updatedAt: now
    });
    const consumedEmailToken = compactObject({
      ...tokenRecord,
      status: "consumed",
      consumedAt: now,
      updatedAt: now
    });
    const passwordSetup = this.createPasswordSetupToken(signupApplication, organization, adminMember);

    this.signupApplications.set(signupApplication.applicationId, signupApplication);
    this.signupEmailTokens.set(tokenKey, consumedEmailToken);
    this.createAuditEvent(organization.orgId, {
      eventType: "signup.email_verified",
      actorMemberId: adminMember.memberId,
      actorLoginId: adminMember.loginId,
      targetType: "signup_application",
      targetId: signupApplication.applicationId,
      safePayload: {
        applicationId: signupApplication.applicationId
      }
    });
    this.createAuditEvent(organization.orgId, {
      eventType: "signup.provisioned",
      actorMemberId: adminMember.memberId,
      actorLoginId: adminMember.loginId,
      targetType: "organization",
      targetId: organization.orgId,
      safePayload: {
        applicationId: signupApplication.applicationId,
        adminMemberId: adminMember.memberId,
        productIds: requestedProducts
      }
    });

    return {
      signupApplication,
      organization,
      adminMember,
      productEntitlements,
      passwordSetup
    };
  }

  setupAdminPassword(input) {
    const { token, password } = validateSetupAdminPasswordInput(input);
    const tokenKey = digestToken(token);
    const tokenRecord = this.requireActiveToken(this.passwordSetupTokens, token, "password setup token");
    const adminMember = this.updateMember(tokenRecord.orgId, tokenRecord.memberId, { password });
    const currentApplication = this.getSignupApplication(tokenRecord.applicationId);
    const now = this.timestamp();
    const signupApplication = currentApplication
      ? compactObject({
        ...currentApplication,
        adminPasswordSetAt: now,
        updatedAt: now
      })
      : null;
    const consumedSetupToken = compactObject({
      ...tokenRecord,
      status: "consumed",
      consumedAt: now,
      updatedAt: now
    });

    if (signupApplication) {
      this.signupApplications.set(signupApplication.applicationId, signupApplication);
    }
    this.passwordSetupTokens.set(tokenKey, consumedSetupToken);
    for (const productId of normalizeSignupProductSelection(signupApplication?.requestedProducts || [])) {
      this.upsertProductEntitlement(tokenRecord.orgId, buildTrialEntitlement(productId, this.now()));
    }
    this.createAuditEvent(tokenRecord.orgId, {
      eventType: "signup.admin_password_set",
      actorMemberId: adminMember.memberId,
      actorLoginId: adminMember.loginId,
      targetType: "member",
      targetId: adminMember.memberId,
      safePayload: {
        applicationId: tokenRecord.applicationId,
        memberId: adminMember.memberId
      }
    });

    return {
      signupApplication,
      organization: this.requireOrganization(tokenRecord.orgId),
      adminMember,
      login: {
        organizationCode: tokenRecord.organizationCode,
        loginId: adminMember.loginId
      }
    };
  }

  createMember(orgId, input) {
    const organization = this.requireOrganization(orgId);
    const normalized = validateCreateMemberInput(input);
    const now = this.timestamp();
    const memberId = this.idFactory("mem");
    const member = compactObject({
      memberId,
      orgId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    const identity = input.password !== undefined
      ? createLoginIdentity({
        organization,
        member,
        password: input.password,
        now
      })
      : null;

    if (identity && this.loginIdentities.has(identity.identityKey)) {
      throw conflictError("loginId already exists for organization", "loginId");
    }

    this.membersForOrg(orgId).set(memberId, member);
    if (identity) {
      this.loginIdentities.set(identity.identityKey, identity);
    }

    return member;
  }

  listMembers(orgId) {
    const organization = this.requireOrganization(orgId);
    return sortByCreatedAt([...this.membersForOrg(orgId).values()])
      .map((member) => this.withMemberMfaState(organization, member));
  }

  getMember(orgId, memberId) {
    this.requireOrganization(orgId);
    return this.membersForOrg(orgId).get(memberId) || null;
  }

  withMemberMfaState(organization, member) {
    const identity = this.getLoginIdentity(organization.organizationCode, member.loginId);
    return compactObject({
      ...member,
      mfaRequired: identity?.mfaRequired,
      mfaEnrolled: identity?.mfaEnrolled
    });
  }

  updateMember(orgId, memberId, input) {
    this.requireOrganization(orgId);
    const current = this.getMember(orgId, memberId);
    if (!current) {
      throw notFoundError("member not found");
    }

    const patch = validatePatchMemberInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });
    const identity = this.getLoginIdentity(
      this.requireOrganization(orgId).organizationCode,
      current.loginId
    );

    if (identity) {
      const updatedIdentity = compactObject({
        ...identity,
        status: updated.status === "disabled" ? "disabled" : activeIdentityStatus(identity.status),
        passwordHash: input.password !== undefined ? hashPassword(input.password) : identity.passwordHash,
        passwordUpdatedAt: input.password !== undefined ? this.timestamp() : identity.passwordUpdatedAt,
        tokenVersion: input.password !== undefined
          ? Number(identity.tokenVersion || 0) + 1
          : identity.tokenVersion,
        mfaRequired: hasPrivilegedRole(updated),
        updatedAt: this.timestamp()
      });
      this.loginIdentities.set(identity.identityKey, updatedIdentity);
    }

    this.membersForOrg(orgId).set(memberId, updated);
    return updated;
  }

  getLoginIdentity(organizationCode, loginId) {
    const identityKey = loginIdentityKey(
      normalizeOrganizationCode(organizationCode),
      normalizeLoginId(loginId)
    );

    return this.loginIdentities.get(identityKey) || null;
  }

  recordLoginSuccess(identity) {
    const current = this.requireLoginIdentity(identity);
    const updated = {
      ...current,
      failedLoginCount: 0,
      lockedUntil: undefined,
      lastLoginAt: this.timestamp(),
      updatedAt: this.timestamp()
    };

    this.loginIdentities.set(current.identityKey, compactObject(updated));
    return this.loginIdentities.get(current.identityKey);
  }

  recordLoginFailure(identity) {
    const current = this.requireLoginIdentity(identity);
    const updated = {
      ...current,
      failedLoginCount: Number(current.failedLoginCount || 0) + 1,
      updatedAt: this.timestamp()
    };

    this.loginIdentities.set(current.identityKey, compactObject(updated));
    return this.loginIdentities.get(current.identityKey);
  }

  beginMfaEnrollment(identity, secret) {
    const current = this.requireLoginIdentity(identity);
    const updated = {
      ...current,
      mfaPendingSecret: secret,
      updatedAt: this.timestamp()
    };

    this.loginIdentities.set(current.identityKey, compactObject(updated));
    return this.loginIdentities.get(current.identityKey);
  }

  completeMfaEnrollment(identity) {
    const current = this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      mfaSecret: current.mfaPendingSecret || current.mfaSecret,
      mfaPendingSecret: undefined,
      mfaEnrolled: true,
      mfaRequired: true,
      tokenVersion: Number(current.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    });

    this.loginIdentities.set(current.identityKey, updated);
    return this.loginIdentities.get(current.identityKey);
  }

  revokeMemberSessions(identity) {
    const current = this.requireLoginIdentity(identity);
    const updated = {
      ...current,
      tokenVersion: Number(current.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    };

    this.loginIdentities.set(current.identityKey, compactObject(updated));
    return this.loginIdentities.get(current.identityKey);
  }

  resetMemberMfa(orgId, memberId) {
    const organization = this.requireOrganization(orgId);
    const member = this.getMember(orgId, memberId);
    if (!member) {
      throw notFoundError("member not found");
    }
    const identity = this.getLoginIdentity(organization.organizationCode, member.loginId);
    if (!identity) {
      throw notFoundError("login identity not found");
    }

    const updated = compactObject({
      ...identity,
      mfaSecret: undefined,
      mfaPendingSecret: undefined,
      mfaEnrolled: false,
      mfaRequired: hasPrivilegedRole(member),
      tokenVersion: Number(identity.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    });
    this.loginIdentities.set(identity.identityKey, updated);
    return updated;
  }

  createFacility(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateCreateFacilityInput(input);
    const now = this.timestamp();
    const facilityId = this.idFactory("fac");
    const facility = compactObject({
      facilityId,
      orgId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.facilitiesForOrg(orgId).set(facilityId, facility);
    return facility;
  }

  listFacilities(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.facilitiesForOrg(orgId).values()]);
  }

  getFacility(orgId, facilityId) {
    this.requireOrganization(orgId);
    return this.facilitiesForOrg(orgId).get(facilityId) || null;
  }

  updateFacility(orgId, facilityId, input) {
    this.requireOrganization(orgId);
    const current = this.getFacility(orgId, facilityId);
    if (!current) {
      throw notFoundError("facility not found");
    }

    const patch = validatePatchFacilityInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.facilitiesForOrg(orgId).set(facilityId, updated);
    return updated;
  }

  createDepartment(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateCreateDepartmentInput(input);
    const now = this.timestamp();
    const departmentId = this.idFactory("dep");
    const department = compactObject({
      departmentId,
      orgId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.departmentsForOrg(orgId).set(departmentId, department);
    return department;
  }

  listDepartments(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.departmentsForOrg(orgId).values()]);
  }

  getDepartment(orgId, departmentId) {
    this.requireOrganization(orgId);
    return this.departmentsForOrg(orgId).get(departmentId) || null;
  }

  updateDepartment(orgId, departmentId, input) {
    this.requireOrganization(orgId);
    const current = this.getDepartment(orgId, departmentId);
    if (!current) {
      throw notFoundError("department not found");
    }

    const patch = validatePatchDepartmentInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.departmentsForOrg(orgId).set(departmentId, updated);
    return updated;
  }

  createPatient(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateCreatePatientInput(input);
    const now = this.timestamp();
    const patientId = this.idFactory("pat");
    const patient = compactObject({
      patientId,
      orgId,
      ...normalized,
      mergedIntoPatientId: undefined,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.patientsForOrg(orgId).set(patientId, patient);
    return patient;
  }

  listPatients(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.patientsForOrg(orgId).values()]);
  }

  getPatient(orgId, patientId) {
    this.requireOrganization(orgId);
    return this.patientsForOrg(orgId).get(patientId) || null;
  }

  updatePatient(orgId, patientId, input) {
    this.requireOrganization(orgId);
    const current = this.getPatient(orgId, patientId);
    if (!current) {
      throw notFoundError("patient not found");
    }

    const patch = validatePatchPatientInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.patientsForOrg(orgId).set(patientId, updated);
    return updated;
  }

  upsertProductEntitlement(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateUpsertProductEntitlementInput(input);
    const now = this.timestamp();
    const existing = this.productEntitlementsForOrg(orgId).get(normalized.productId);
    const entitlement = compactObject({
      productId: normalized.productId,
      orgId,
      ...normalized,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.productEntitlementsForOrg(orgId).set(normalized.productId, entitlement);
    return entitlement;
  }

  listProductEntitlements(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.productEntitlementsForOrg(orgId).values()]);
  }

  getProductEntitlement(orgId, productId) {
    this.requireOrganization(orgId);
    return this.productEntitlementsForOrg(orgId).get(productId) || null;
  }

  updateProductEntitlement(orgId, productId, input) {
    this.requireOrganization(orgId);
    const current = this.getProductEntitlement(orgId, productId);
    if (!current) {
      throw notFoundError("product entitlement not found");
    }

    const patch = validatePatchProductEntitlementInput({ ...input, productId });
    const updated = compactObject({
      ...current,
      ...patch,
      productId,
      updatedAt: this.timestamp()
    });

    this.productEntitlementsForOrg(orgId).set(productId, updated);
    return updated;
  }

  createAuditEvent(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateCreateAuditEventInput(input);
    const now = this.timestamp();
    const eventId = this.idFactory("aud");
    const event = compactObject({
      eventId,
      orgId,
      ...normalized,
      createdAt: now,
      schemaVersion: 1
    });

    this.auditEventsForOrg(orgId).set(eventId, event);
    return event;
  }

  createDataRequest(orgId, input) {
    this.requireOrganization(orgId);
    const normalized = validateCreateDataRequestInput(input);
    const now = this.timestamp();
    const requestId = this.idFactory("drq");
    const dataRequest = compactObject({
      requestId,
      orgId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.dataRequestsForOrg(orgId).set(requestId, dataRequest);
    return dataRequest;
  }

  createStripeEventReceipt(input = {}) {
    const now = this.timestamp();
    const receipt = compactObject({
      eventId: requiredString(input.eventId, "eventId"),
      type: input.type || "unknown",
      livemode: Boolean(input.livemode),
      apiVersion: input.apiVersion || null,
      objectId: input.objectId || null,
      payloadHash: input.payloadHash || null,
      status: input.status || "received",
      receivedAt: input.receivedAt || now,
      processedAt: input.processedAt || null,
      errorMessageSafe: input.errorMessageSafe || null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    this.stripeEventReceipts.set(receipt.eventId, receipt);
    return receipt;
  }

  getStripeEventReceipt(eventId) {
    return this.stripeEventReceipts.get(eventId) || null;
  }

  updateStripeEventReceipt(eventId, patch = {}) {
    const current = this.getStripeEventReceipt(eventId);
    if (!current) {
      throw notFoundError("stripe event receipt not found");
    }

    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.stripeEventReceipts.set(eventId, updated);
    return updated;
  }

  listDataRequests(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.dataRequestsForOrg(orgId).values()]);
  }

  getDataRequest(orgId, requestId) {
    this.requireOrganization(orgId);
    return this.dataRequestsForOrg(orgId).get(requestId) || null;
  }

  updateDataRequest(orgId, requestId, input) {
    this.requireOrganization(orgId);
    const current = this.getDataRequest(orgId, requestId);
    if (!current) {
      throw notFoundError("data request not found");
    }

    const patch = validatePatchDataRequestInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    this.dataRequestsForOrg(orgId).set(requestId, updated);
    return updated;
  }

  listAuditEvents(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.auditEventsForOrg(orgId).values()]);
  }

  getAuditEvent(orgId, eventId) {
    this.requireOrganization(orgId);
    return this.auditEventsForOrg(orgId).get(eventId) || null;
  }

  consumeRateLimit(key, options = {}) {
    const limit = options.limit || 5;
    const windowSeconds = options.windowSeconds || 60;
    const nowMs = this.now().getTime();
    const now = this.timestamp();
    const existing = this.rateLimits.get(key);
    const resetAtMs = existing?.resetAt ? new Date(existing.resetAt).getTime() : 0;
    const windowIsActive = existing && resetAtMs > nowMs;
    const count = windowIsActive ? Number(existing.count || 0) + 1 : 1;
    const resetAt = windowIsActive
      ? existing.resetAt
      : new Date(nowMs + windowSeconds * 1000).toISOString();
    const record = {
      key,
      count,
      limit,
      resetAt,
      updatedAt: now,
      schemaVersion: 1
    };

    this.rateLimits.set(key, record);
    if (count > limit) {
      throw rateLimitError("Too many requests", resetAt);
    }

    return record;
  }

  requireOrganization(orgId) {
    const organization = this.getOrganization(orgId);
    if (!organization) {
      throw notFoundError("organization not found");
    }
    return organization;
  }

  requireLoginIdentity(identity) {
    if (!identity?.identityKey || !this.loginIdentities.has(identity.identityKey)) {
      throw notFoundError("login identity not found");
    }

    return this.loginIdentities.get(identity.identityKey);
  }

  membersForOrg(orgId) {
    if (!this.membersByOrg.has(orgId)) {
      this.membersByOrg.set(orgId, new Map());
    }
    return this.membersByOrg.get(orgId);
  }

  facilitiesForOrg(orgId) {
    if (!this.facilitiesByOrg.has(orgId)) {
      this.facilitiesByOrg.set(orgId, new Map());
    }

    return this.facilitiesByOrg.get(orgId);
  }

  departmentsForOrg(orgId) {
    if (!this.departmentsByOrg.has(orgId)) {
      this.departmentsByOrg.set(orgId, new Map());
    }

    return this.departmentsByOrg.get(orgId);
  }

  patientsForOrg(orgId) {
    if (!this.patientsByOrg.has(orgId)) {
      this.patientsByOrg.set(orgId, new Map());
    }
    return this.patientsByOrg.get(orgId);
  }

  productEntitlementsForOrg(orgId) {
    if (!this.productEntitlementsByOrg.has(orgId)) {
      this.productEntitlementsByOrg.set(orgId, new Map());
    }

    return this.productEntitlementsByOrg.get(orgId);
  }

  auditEventsForOrg(orgId) {
    if (!this.auditEventsByOrg.has(orgId)) {
      this.auditEventsByOrg.set(orgId, new Map());
    }

    return this.auditEventsByOrg.get(orgId);
  }

  dataRequestsForOrg(orgId) {
    if (!this.dataRequestsByOrg.has(orgId)) {
      this.dataRequestsByOrg.set(orgId, new Map());
    }

    return this.dataRequestsByOrg.get(orgId);
  }

  createSignupEmailToken(signupApplication) {
    const now = this.timestamp();
    const token = this.tokenFactory("emv");
    const tokenDigest = digestToken(token);
    const record = {
      tokenDigest,
      applicationId: signupApplication.applicationId,
      status: "active",
      expiresAt: daysFromNow(this.now(), 1),
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };

    this.signupEmailTokens.set(tokenDigest, record);
    return tokenView(record, token);
  }

  createPasswordSetupToken(signupApplication, organization, adminMember) {
    const now = this.timestamp();
    const token = this.tokenFactory("setup");
    const tokenDigest = digestToken(token);
    const record = {
      tokenDigest,
      applicationId: signupApplication.applicationId,
      orgId: organization.orgId,
      organizationCode: organization.organizationCode,
      memberId: adminMember.memberId,
      status: "active",
      expiresAt: daysFromNow(this.now(), 7),
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };

    this.passwordSetupTokens.set(tokenDigest, record);
    return tokenView(record, token);
  }

  requireActiveToken(tokens, token, label) {
    const record = tokens.get(digestToken(token));
    if (!record) {
      throw notFoundError(`${label} not found`);
    }
    if (record.status !== "active") {
      throw conflictError(`${label} is already used`, "token");
    }
    if (new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      throw conflictError(`${label} expired`, "token");
    }

    return record;
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

export function conflictError(message, field) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  error.field = field;
  return error;
}

export function rateLimitError(message, resetAt) {
  const error = new Error(message);
  error.name = "RateLimitError";
  error.statusCode = 429;
  error.resetAt = resetAt;
  return error;
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function defaultTokenFactory(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function digestToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function daysFromNow(now, days) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function sortByCreatedAt(items) {
  return items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required`);
  }

  return value.trim();
}

function tokenView(record, token) {
  return {
    token,
    expiresAt: record.expiresAt
  };
}

function productAdminRoles(productIds) {
  return Object.fromEntries(productIds.map((productId) => [productId, ["admin"]]));
}

function createLoginIdentity({ organization, member, password, now }) {
  const identityKey = loginIdentityKey(organization.organizationCode, member.loginId);

  return {
    identityKey,
    organizationCode: organization.organizationCode,
    loginId: member.loginId,
    orgId: organization.orgId,
    memberId: member.memberId,
    passwordHash: hashPassword(password),
    passwordUpdatedAt: now,
    tokenVersion: 1,
    mfaRequired: hasPrivilegedRole(member),
    mfaEnrolled: false,
    status: "active",
    failedLoginCount: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

function hasPrivilegedRole(member) {
  return member.globalRoles.includes("org_admin")
    || member.globalRoles.includes("org_owner")
    || member.globalRoles.includes("it_admin")
    || member.globalRoles.includes("billing_admin")
    || member.globalRoles.includes("platform_admin");
}

function activeIdentityStatus(currentStatus) {
  return currentStatus === "disabled" ? "active" : currentStatus;
}
