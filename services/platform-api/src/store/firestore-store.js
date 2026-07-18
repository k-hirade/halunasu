import crypto from "node:crypto";
import {
  memberRequiresMfa,
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
import {
  auditEventPath,
  collections,
  dataRequestPath,
  departmentPath,
  facilityPath,
  loginIdentityKey,
  loginIdentityPath,
  memberPath,
  organizationCodePath,
  organizationPath,
  passwordSetupTokenPath,
  patientPath,
  productEntitlementPath,
  rateLimitPath,
  signupEmailTokenPath,
  signupApplicationPath,
  stripeEventReceiptPath
} from "../../../../packages/firestore-schema/src/index.js";
import { conflictError, notFoundError, rateLimitError } from "./memory-store.js";
import { encryptSensitiveField } from "../auth/field-secret.js";
import { hashPassword } from "../auth/password.js";
import {
  buildOrganizationBillingState,
  buildPendingSetupEntitlement,
  buildTrialEntitlement,
  normalizeSignupProductSelection
} from "../billing/catalog.js";

export class FirestorePlatformStore {
  constructor(options = {}) {
    if (!options.db) {
      throw new TypeError("db is required");
    }

    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory;
    this.tokenFactory = options.tokenFactory || defaultTokenFactory;
  }

  async createOrganization(input) {
    const normalized = validateCreateOrganizationInput(input);
    const orgId = this.idFactory("org");
    const now = this.timestamp();
    const organization = compactObject({
      orgId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    const codeRecord = {
      organizationCode: normalized.organizationCode,
      orgId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };

    await this.db.runTransaction(async (transaction) => {
      const codeRef = this.doc(organizationCodePath(normalized.organizationCode));
      const orgRef = this.doc(organizationPath(orgId));
      const existingCode = await transaction.get(codeRef);

      if (existingCode.exists) {
        throw conflictError("organizationCode already exists", "organizationCode");
      }

      transaction.set(orgRef, organization);
      transaction.set(codeRef, codeRecord);
    });

    return organization;
  }

  async listOrganizations() {
    const snapshot = await this.db.collection(collections.organizations).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getOrganization(orgId) {
    return docDataOrNull(await this.doc(organizationPath(orgId)).get());
  }

  async updateOrganization(orgId, input) {
    const current = await this.requireOrganization(orgId);
    const patch = validatePatchOrganizationInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    await this.doc(organizationPath(orgId)).set(updated);
    return updated;
  }

  async findOrganizationByStripeCustomerId(stripeCustomerId) {
    const snapshot = await this.db.collection(collections.organizations)
      .where("billing.stripeCustomerId", "==", stripeCustomerId)
      .limit(1)
      .get();
    return docsFromSnapshot(snapshot)[0] || null;
  }

  async findOrganizationByStripeSubscriptionId(stripeSubscriptionId) {
    const snapshot = await this.db.collection(collections.organizations)
      .where("billing.stripeSubscriptionId", "==", stripeSubscriptionId)
      .limit(1)
      .get();
    return docsFromSnapshot(snapshot)[0] || null;
  }

  async createSignupApplication(input) {
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

    await this.doc(signupApplicationPath(applicationId)).set(application);
    return application;
  }

  async createSignupApplicationWithEmailToken(input) {
    const signupApplication = await this.createSignupApplication({
      ...input,
      status: "submitted"
    });
    const emailVerification = await this.createSignupEmailToken(signupApplication);

    return { signupApplication, emailVerification };
  }

  async getSignupApplication(applicationId) {
    return docDataOrNull(await this.doc(signupApplicationPath(applicationId)).get());
  }

  async listSignupApplications() {
    const snapshot = await this.db.collection(collections.signupApplications).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async verifySignupEmail(input) {
    const { token } = validateVerifySignupEmailInput(input);
    const tokenPath = signupEmailTokenPath(digestToken(token));
    const tokenRecord = await this.requireActiveToken(tokenPath, "email verification token");
    const currentApplication = await this.getSignupApplication(tokenRecord.applicationId);
    if (!currentApplication) {
      throw notFoundError("signup application not found");
    }
    if (currentApplication.status !== "submitted") {
      throw conflictError("signup application is not waiting for email verification", "token");
    }

    const now = this.timestamp();
    const requestedProducts = normalizeSignupProductSelection(currentApplication.requestedProducts);
    const organization = await this.createOrganization({
      organizationCode: currentApplication.organizationCode,
      displayName: currentApplication.organizationDisplayName,
      status: "trialing",
      billing: buildOrganizationBillingState(now),
      access: {
        status: "active",
        enabledProducts: requestedProducts
      }
    });
    const adminMember = await this.createMember(organization.orgId, {
      loginId: currentApplication.applicantEmail,
      displayName: currentApplication.applicantName,
      email: currentApplication.applicantEmail,
      globalRoles: ["org_admin"],
      productRoles: productAdminRoles(requestedProducts),
      password: `${this.tokenFactory("initial_password")}_temporary`
    });
    const productEntitlements = [];
    for (const productId of requestedProducts) {
      productEntitlements.push(await this.upsertProductEntitlement(
        organization.orgId,
        buildPendingSetupEntitlement(productId, this.now())
      ));
    }

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
    const passwordSetup = await this.createPasswordSetupToken(signupApplication, organization, adminMember);

    await this.doc(signupApplicationPath(signupApplication.applicationId)).set(signupApplication);
    await this.doc(tokenPath).set(consumedEmailToken);
    await this.createAuditEvent(organization.orgId, {
      eventType: "signup.email_verified",
      actorMemberId: adminMember.memberId,
      actorLoginId: adminMember.loginId,
      targetType: "signup_application",
      targetId: signupApplication.applicationId,
      safePayload: {
        applicationId: signupApplication.applicationId
      }
    });
    await this.createAuditEvent(organization.orgId, {
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

  async setupAdminPassword(input) {
    const { token, password } = validateSetupAdminPasswordInput(input);
    const tokenPath = passwordSetupTokenPath(digestToken(token));
    const tokenRecord = await this.requireActiveToken(tokenPath, "password setup token");
    const adminMember = await this.updateMember(tokenRecord.orgId, tokenRecord.memberId, { password });
    const currentApplication = await this.getSignupApplication(tokenRecord.applicationId);
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
      await this.doc(signupApplicationPath(signupApplication.applicationId)).set(signupApplication);
    }
    await this.doc(tokenPath).set(consumedSetupToken);
    for (const productId of normalizeSignupProductSelection(signupApplication?.requestedProducts || [])) {
      await this.upsertProductEntitlement(tokenRecord.orgId, buildTrialEntitlement(productId, this.now()));
    }
    await this.createAuditEvent(tokenRecord.orgId, {
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
      organization: await this.requireOrganization(tokenRecord.orgId),
      adminMember,
      login: {
        organizationCode: tokenRecord.organizationCode,
        loginId: adminMember.loginId
      }
    };
  }

  async createMember(orgId, input) {
    const organization = await this.requireOrganization(orgId);
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

    await this.db.runTransaction(async (transaction) => {
      if (identity) {
        const identityRef = this.doc(loginIdentityPath(organization.organizationCode, member.loginId));
        const existingIdentity = await transaction.get(identityRef);
        if (existingIdentity.exists) {
          throw conflictError("loginId already exists for organization", "loginId");
        }

        transaction.set(identityRef, identity);
      }

      transaction.set(this.doc(memberPath(orgId, memberId)), member);
    });

    return member;
  }

  async listMembers(orgId) {
    const organization = await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.members).orderBy("createdAt", "asc").get();
    const members = docsFromSnapshot(snapshot);
    return this.withMembersMfaState(organization, members);
  }

  async getMember(orgId, memberId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(memberPath(orgId, memberId)).get());
  }

  async withMemberMfaState(organization, member) {
    const identity = await this.getLoginIdentity(organization.organizationCode, member.loginId);
    return this.applyMemberMfaState(member, identity);
  }

  async withMembersMfaState(organization, members) {
    if (!members.length) {
      return [];
    }

    const identityRefs = members.map((member) => this.doc(loginIdentityPath(organization.organizationCode, member.loginId)));
    const identitySnapshots = typeof this.db.getAll === "function"
      ? await this.db.getAll(...identityRefs)
      : await Promise.all(identityRefs.map((ref) => ref.get()));

    return members.map((member, index) => this.applyMemberMfaState(member, docDataOrNull(identitySnapshots[index])));
  }

  applyMemberMfaState(member, identity) {
    return compactObject({
      ...member,
      mfaRequired: identity?.mfaRequired,
      mfaEnrolled: identity?.mfaEnrolled
    });
  }

  async updateMember(orgId, memberId, input) {
    const organization = await this.requireOrganization(orgId);
    const current = await this.getMember(orgId, memberId);
    if (!current) {
      throw notFoundError("member not found");
    }

    const patch = validatePatchMemberInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });
    const identity = await this.getLoginIdentity(organization.organizationCode, current.loginId);

    await this.db.runTransaction(async (transaction) => {
      transaction.set(this.doc(memberPath(orgId, memberId)), updated);

      if (identity) {
        const updatedIdentity = compactObject({
          ...identity,
          status: updated.status === "disabled" ? "disabled" : activeIdentityStatus(identity.status),
          passwordHash: input.password !== undefined ? hashPassword(input.password) : identity.passwordHash,
          passwordUpdatedAt: input.password !== undefined ? this.timestamp() : identity.passwordUpdatedAt,
          tokenVersion: input.password !== undefined
            ? Number(identity.tokenVersion || 0) + 1
            : identity.tokenVersion,
          mfaRequired: memberRequiresMfa(updated),
          updatedAt: this.timestamp()
        });
        transaction.set(this.doc(loginIdentityPath(identity.organizationCode, identity.loginId)), updatedIdentity);
      }
    });

    return updated;
  }

  async getLoginIdentity(organizationCode, loginId) {
    return docDataOrNull(await this.doc(loginIdentityPath(
      normalizeOrganizationCode(organizationCode),
      normalizeLoginId(loginId)
    )).get());
  }

  async recordLoginSuccess(identity) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      failedLoginCount: 0,
      lockedUntil: undefined,
      lastLoginAt: this.timestamp(),
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async recordLoginFailure(identity) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      failedLoginCount: Number(current.failedLoginCount || 0) + 1,
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async beginMfaEnrollment(identity, secret) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      mfaPendingSecret: undefined,
      mfaPendingSecretEncrypted: encryptSensitiveField(secret),
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async completeMfaEnrollment(identity) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      mfaSecret: undefined,
      mfaPendingSecret: undefined,
      mfaSecretEncrypted: current.mfaPendingSecretEncrypted
        || current.mfaSecretEncrypted
        || (current.mfaPendingSecret || current.mfaSecret
          ? encryptSensitiveField(current.mfaPendingSecret || current.mfaSecret)
          : undefined),
      mfaPendingSecretEncrypted: undefined,
      mfaEnrolled: true,
      mfaRequired: true,
      tokenVersion: Number(current.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async revokeMemberSessions(identity) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      tokenVersion: Number(current.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async resetMemberMfa(orgId, memberId) {
    const organization = await this.requireOrganization(orgId);
    const member = await this.getMember(orgId, memberId);
    if (!member) {
      throw notFoundError("member not found");
    }
    const identity = await this.getLoginIdentity(organization.organizationCode, member.loginId);
    if (!identity) {
      throw notFoundError("login identity not found");
    }

    const updated = compactObject({
      ...identity,
      mfaSecret: undefined,
      mfaPendingSecret: undefined,
      mfaSecretEncrypted: undefined,
      mfaPendingSecretEncrypted: undefined,
      mfaEnrolled: false,
      mfaRequired: memberRequiresMfa(member),
      tokenVersion: Number(identity.tokenVersion || 0) + 1,
      updatedAt: this.timestamp()
    });
    await this.doc(loginIdentityPath(identity.organizationCode, identity.loginId)).set(updated);
    return updated;
  }

  async createFacility(orgId, input) {
    await this.requireOrganization(orgId);
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

    await this.doc(facilityPath(orgId, facilityId)).set(facility);
    return facility;
  }

  async listFacilities(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.facilities).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getFacility(orgId, facilityId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(facilityPath(orgId, facilityId)).get());
  }

  async updateFacility(orgId, facilityId, input) {
    await this.requireOrganization(orgId);
    const current = await this.getFacility(orgId, facilityId);
    if (!current) {
      throw notFoundError("facility not found");
    }

    const patch = validatePatchFacilityInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    await this.doc(facilityPath(orgId, facilityId)).set(updated);
    return updated;
  }

  async createDepartment(orgId, input) {
    await this.requireOrganization(orgId);
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

    await this.doc(departmentPath(orgId, departmentId)).set(department);
    return department;
  }

  async listDepartments(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.departments).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getDepartment(orgId, departmentId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(departmentPath(orgId, departmentId)).get());
  }

  async updateDepartment(orgId, departmentId, input) {
    await this.requireOrganization(orgId);
    const current = await this.getDepartment(orgId, departmentId);
    if (!current) {
      throw notFoundError("department not found");
    }

    const patch = validatePatchDepartmentInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    await this.doc(departmentPath(orgId, departmentId)).set(updated);
    return updated;
  }

  async createPatient(orgId, input) {
    await this.requireOrganization(orgId);
    const normalized = validateCreatePatientInput(input);
    const now = this.timestamp();
    const patientId = this.idFactory("pat");
    const patient = compactObject({
      patientId,
      orgId,
      ...normalized,
      ...buildPatientSearchFields({ patientId, orgId, ...normalized }),
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    await this.doc(patientPath(orgId, patientId)).set(patient);
    return patientPublicView(patient);
  }

  async listPatients(orgId, options = undefined) {
    await this.requireOrganization(orgId);
    if (!options) {
      const snapshot = await this.orgCollection(orgId, collections.patients).orderBy("createdAt", "asc").get();
      return docsFromSnapshot(snapshot).map(patientPublicView);
    }
    const listOptions = normalizePatientListOptions(options);
    const keyword = normalizePatientSearchValue(listOptions.search);
    if (!keyword) {
      const snapshot = await this.orgCollection(orgId, collections.patients)
        .orderBy("updatedAt", "desc")
        .limit(listOptions.limit)
        .get();
      return docsFromSnapshot(snapshot).map(patientPublicView);
    }
    return this.searchPatients(orgId, keyword, listOptions.limit);
  }

  async getPatient(orgId, patientId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(patientPath(orgId, patientId)).get());
  }

  async updatePatient(orgId, patientId, input) {
    await this.requireOrganization(orgId);
    const current = await this.getPatient(orgId, patientId);
    if (!current) {
      throw notFoundError("patient not found");
    }

    const patch = validatePatchPatientInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      ...buildPatientSearchFields({ ...current, ...patch }),
      updatedAt: this.timestamp()
    });

    await this.doc(patientPath(orgId, patientId)).set(updated);
    return patientPublicView(updated);
  }

  async searchPatients(orgId, keyword, limit) {
    const byPatientId = new Map();
    const prefixSnapshot = await this.orgCollection(orgId, collections.patients)
      .where("patientSearchPrefixes", "array-contains", keyword)
      .limit(limit)
      .get();
    for (const patient of docsFromSnapshot(prefixSnapshot)) {
      if (patient?.patientId && patientMatchesPatientSearch(patient, keyword)) {
        byPatientId.set(patient.patientId, patient);
      }
    }
    if (byPatientId.size >= limit) {
      return [...byPatientId.values()]
        .sort(comparePatientsByRecentUpdate)
        .slice(0, limit)
        .map(patientPublicView);
    }

    const fields = [
      "patientSearchName",
      "patientSearchKana",
      "patientSearchPrimaryNumber",
      "patientSearchExternalId",
      "patientSearchId"
    ];
    for (const field of fields) {
      const snapshot = await this.orgCollection(orgId, collections.patients)
        .where(field, ">=", keyword)
        .where(field, "<", `${keyword}\uf8ff`)
        .orderBy(field, "asc")
        .limit(limit)
        .get();
      for (const patient of docsFromSnapshot(snapshot)) {
        if (patient?.patientId && patientMatchesPatientSearch(patient, keyword)) {
          byPatientId.set(patient.patientId, patient);
        }
      }
      if (byPatientId.size >= limit) {
        break;
      }
    }
    return [...byPatientId.values()]
      .sort(comparePatientsByRecentUpdate)
      .slice(0, limit)
      .map(patientPublicView);
  }

  async upsertProductEntitlement(orgId, input) {
    await this.requireOrganization(orgId);
    const normalized = validateUpsertProductEntitlementInput(input);
    const now = this.timestamp();
    const existing = await this.getProductEntitlement(orgId, normalized.productId);
    const entitlement = compactObject({
      productId: normalized.productId,
      orgId,
      ...normalized,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      schemaVersion: 1
    });

    await this.doc(productEntitlementPath(orgId, normalized.productId)).set(entitlement);
    return entitlement;
  }

  async listProductEntitlements(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.productEntitlements).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getProductEntitlement(orgId, productId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(productEntitlementPath(orgId, productId)).get());
  }

  async updateProductEntitlement(orgId, productId, input) {
    await this.requireOrganization(orgId);
    const current = await this.getProductEntitlement(orgId, productId);
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

    await this.doc(productEntitlementPath(orgId, productId)).set(updated);
    return updated;
  }

  async createAuditEvent(orgId, input) {
    await this.requireOrganization(orgId);
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

    await this.doc(auditEventPath(orgId, eventId)).set(event);
    return event;
  }

  async createDataRequest(orgId, input) {
    await this.requireOrganization(orgId);
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

    await this.doc(dataRequestPath(orgId, requestId)).set(dataRequest);
    return dataRequest;
  }

  async createStripeEventReceipt(input = {}) {
    const now = this.timestamp();
    const eventId = requiredString(input.eventId, "eventId");
    const receipt = compactObject({
      eventId,
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

    await this.doc(stripeEventReceiptPath(eventId)).set(receipt);
    return receipt;
  }

  async getStripeEventReceipt(eventId) {
    return docDataOrNull(await this.doc(stripeEventReceiptPath(eventId)).get());
  }

  async updateStripeEventReceipt(eventId, patch = {}) {
    const current = await this.getStripeEventReceipt(eventId);
    if (!current) {
      throw notFoundError("stripe event receipt not found");
    }

    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    await this.doc(stripeEventReceiptPath(eventId)).set(updated);
    return updated;
  }

  async listDataRequests(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.dataRequests).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getDataRequest(orgId, requestId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(dataRequestPath(orgId, requestId)).get());
  }

  async updateDataRequest(orgId, requestId, input) {
    await this.requireOrganization(orgId);
    const current = await this.getDataRequest(orgId, requestId);
    if (!current) {
      throw notFoundError("data request not found");
    }

    const patch = validatePatchDataRequestInput(input);
    const updated = compactObject({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });

    await this.doc(dataRequestPath(orgId, requestId)).set(updated);
    return updated;
  }

  async listAuditEvents(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.auditEvents).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getAuditEvent(orgId, eventId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(auditEventPath(orgId, eventId)).get());
  }

  async consumeRateLimit(key, options = {}) {
    const limit = options.limit || 5;
    const windowSeconds = options.windowSeconds || 60;
    const nowMs = this.now().getTime();
    const now = this.timestamp();
    let record;

    await this.db.runTransaction(async (transaction) => {
      const ref = this.doc(rateLimitPath(key));
      const snapshot = await transaction.get(ref);
      const existing = docDataOrNull(snapshot);
      const resetAtMs = existing?.resetAt ? new Date(existing.resetAt).getTime() : 0;
      const windowIsActive = existing && resetAtMs > nowMs;
      const count = windowIsActive ? Number(existing.count || 0) + 1 : 1;
      const resetAt = windowIsActive
        ? existing.resetAt
        : new Date(nowMs + windowSeconds * 1000).toISOString();

      record = {
        key,
        count,
        limit,
        resetAt,
        updatedAt: now,
        schemaVersion: 1
      };

      transaction.set(ref, record);
    });

    if (record.count > limit) {
      throw rateLimitError("Too many requests", record.resetAt);
    }

    return record;
  }

  async requireOrganization(orgId) {
    const organization = await this.getOrganization(orgId);
    if (!organization) {
      throw notFoundError("organization not found");
    }
    return organization;
  }

  async requireLoginIdentity(identity) {
    if (!identity?.identityKey) {
      throw notFoundError("login identity not found");
    }

    const current = await this.getLoginIdentity(identity.organizationCode, identity.loginId);
    if (!current) {
      throw notFoundError("login identity not found");
    }

    return current;
  }

  async createSignupEmailToken(signupApplication) {
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

    await this.doc(signupEmailTokenPath(tokenDigest)).set(record);
    return tokenView(record, token);
  }

  async createPasswordSetupToken(signupApplication, organization, adminMember) {
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

    await this.doc(passwordSetupTokenPath(tokenDigest)).set(record);
    return tokenView(record, token);
  }

  async requireActiveToken(path, label) {
    const record = docDataOrNull(await this.doc(path).get());
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

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, collectionName) {
    return this.doc(organizationPath(orgId)).collection(collectionName);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export async function createFirestoreDb(options = {}) {
  const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  const projectId = options.projectId
    || process.env.PLATFORM_GOOGLE_CLOUD_PROJECT
    || process.env.CORE_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "medical-core-stg";
  const appName = options.appName || "halunasu-platform-api";
  const app = getApps().find((candidate) => candidate.name === appName)
    || initializeApp({ projectId }, appName);

  return getFirestore(app);
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

function normalizePatientListOptions(options = {}) {
  return {
    search: String(options.search || "").trim(),
    limit: Math.min(Math.max(Number.parseInt(options.limit, 10) || 30, 1), 100)
  };
}

function patientPublicView(patient = {}) {
  const {
    patientSearchName,
    patientSearchKana,
    patientSearchPrimaryNumber,
    patientSearchExternalId,
    patientSearchId,
    patientSearchPrefixes,
    patientSearchText,
    ...publicPatient
  } = patient || {};
  return structuredClone(publicPatient);
}

function comparePatientsByRecentUpdate(left = {}, right = {}) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0;
  if (safeLeftTime !== safeRightTime) {
    return safeRightTime - safeLeftTime;
  }
  return String(left.displayName || left.patientId || "").localeCompare(String(right.displayName || right.patientId || ""), "ja");
}

function buildPatientSearchFields(patient = {}) {
  const primaryCode = patient.primaryPatientNumber
    || patient.patientCode
    || firstPatientIdentifierValue(patient)
    || "";
  const externalId = Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds[0] : "";
  const name = normalizePatientSearchValue(patient.displayName);
  const kana = normalizePatientSearchValue(patient.displayNameKana);
  const primaryNumber = normalizePatientSearchValue(primaryCode);
  const external = normalizePatientSearchValue(externalId);
  const patientId = normalizePatientSearchValue(patient.patientId);
  return compactObject({
    patientSearchName: name || undefined,
    patientSearchKana: kana || undefined,
    patientSearchPrimaryNumber: primaryNumber || undefined,
    patientSearchExternalId: external || undefined,
    patientSearchId: patientId || undefined,
    patientSearchPrefixes: buildPatientSearchPrefixes(patient),
    patientSearchText: normalizePatientSearchValue([
      patient.displayName,
      patient.displayNameKana,
      primaryCode,
      externalId,
      patient.patientId
    ].filter(Boolean).join(" ")) || undefined
  });
}

function patientMatchesPatientSearch(patient = {}, keyword = "") {
  const normalizedKeyword = normalizePatientSearchValue(keyword);
  if (!normalizedKeyword) {
    return true;
  }
  return patientSearchCandidates(patient).some((candidate) => (
    candidate.startsWith(normalizedKeyword) || candidate.includes(normalizedKeyword)
  ));
}

function patientSearchCandidates(patient = {}) {
  const fields = buildPatientSearchFields(patient);
  return [
    fields.patientSearchName,
    fields.patientSearchKana,
    fields.patientSearchPrimaryNumber,
    fields.patientSearchExternalId,
    fields.patientSearchId,
    fields.patientSearchText,
    ...normalizePatientIdentifierValues(patient)
  ].filter(Boolean);
}

function buildPatientSearchPrefixes(patient = {}) {
  const fields = buildPatientSearchFieldsWithoutPrefixes(patient);
  const values = [
    fields.patientSearchName,
    fields.patientSearchKana,
    fields.patientSearchPrimaryNumber,
    fields.patientSearchExternalId,
    fields.patientSearchId,
    ...normalizePatientIdentifierValues(patient)
  ].filter(Boolean);
  const prefixes = new Set();
  for (const value of values) {
    const chars = [...value].slice(0, 32);
    for (let index = 1; index <= chars.length; index += 1) {
      prefixes.add(chars.slice(0, index).join(""));
    }
  }
  return prefixes.size ? [...prefixes].slice(0, 200) : undefined;
}

function buildPatientSearchFieldsWithoutPrefixes(patient = {}) {
  const primaryCode = patient.primaryPatientNumber
    || patient.patientCode
    || firstPatientIdentifierValue(patient)
    || "";
  const externalId = Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds[0] : "";
  return compactObject({
    patientSearchName: normalizePatientSearchValue(patient.displayName) || undefined,
    patientSearchKana: normalizePatientSearchValue(patient.displayNameKana) || undefined,
    patientSearchPrimaryNumber: normalizePatientSearchValue(primaryCode) || undefined,
    patientSearchExternalId: normalizePatientSearchValue(externalId) || undefined,
    patientSearchId: normalizePatientSearchValue(patient.patientId) || undefined
  });
}

function firstPatientIdentifierValue(patient = {}) {
  return normalizePatientIdentifierValues(patient)[0] || "";
}

function normalizePatientIdentifierValues(patient = {}) {
  const identifiers = Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : [];
  return identifiers
    .map((identifier) => identifier?.value || identifier?.patientNumber || identifier?.id || "")
    .map(normalizePatientSearchValue)
    .filter(Boolean);
}

function normalizePatientSearchValue(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
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
    mfaRequired: memberRequiresMfa(member),
    mfaEnrolled: false,
    status: "active",
    failedLoginCount: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

function activeIdentityStatus(currentStatus) {
  return currentStatus === "disabled" ? "active" : currentStatus;
}

function docsFromSnapshot(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function docDataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}
