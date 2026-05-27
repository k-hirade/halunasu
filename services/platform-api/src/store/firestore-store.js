import crypto from "node:crypto";
import {
  normalizeLoginId,
  normalizeOrganizationCode,
  validateCreateAuditEventInput,
  validateCreateDepartmentInput,
  validateCreateFacilityInput,
  validateCreateMemberInput,
  validateCreateOrganizationInput,
  validateCreatePatientInput,
  validateCreateSignupApplicationInput,
  validatePatchDepartmentInput,
  validatePatchFacilityInput,
  validatePatchMemberInput,
  validatePatchOrganizationInput,
  validatePatchPatientInput,
  validatePatchProductEntitlementInput,
  validateUpsertProductEntitlementInput
} from "../../../../packages/platform-contracts/src/index.js";
import {
  auditEventPath,
  collections,
  departmentPath,
  facilityPath,
  loginIdentityKey,
  loginIdentityPath,
  memberPath,
  organizationCodePath,
  organizationPath,
  patientPath,
  productEntitlementPath,
  rateLimitPath,
  signupApplicationPath
} from "../../../../packages/firestore-schema/src/index.js";
import { conflictError, notFoundError, rateLimitError } from "./memory-store.js";
import { hashPassword } from "../auth/password.js";

export class FirestorePlatformStore {
  constructor(options = {}) {
    if (!options.db) {
      throw new TypeError("db is required");
    }

    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory;
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

  async getSignupApplication(applicationId) {
    return docDataOrNull(await this.doc(signupApplicationPath(applicationId)).get());
  }

  async listSignupApplications() {
    const snapshot = await this.db.collection(collections.signupApplications).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
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
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.members).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getMember(orgId, memberId) {
    await this.requireOrganization(orgId);
    return docDataOrNull(await this.doc(memberPath(orgId, memberId)).get());
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
          mfaRequired: hasPrivilegedRole(updated),
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
      mfaPendingSecret: secret,
      updatedAt: this.timestamp()
    });

    await this.doc(loginIdentityPath(current.organizationCode, current.loginId)).set(updated);
    return updated;
  }

  async completeMfaEnrollment(identity) {
    const current = await this.requireLoginIdentity(identity);
    const updated = compactObject({
      ...current,
      mfaSecret: current.mfaPendingSecret || current.mfaSecret,
      mfaPendingSecret: undefined,
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
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    await this.doc(patientPath(orgId, patientId)).set(patient);
    return patient;
  }

  async listPatients(orgId) {
    await this.requireOrganization(orgId);
    const snapshot = await this.orgCollection(orgId, collections.patients).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
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
      updatedAt: this.timestamp()
    });

    await this.doc(patientPath(orgId, patientId)).set(updated);
    return updated;
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
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const app = getApps().find((candidate) => candidate.name === "halunasu-platform-api")
    || initializeApp({ projectId }, "halunasu-platform-api");

  return getFirestore(app);
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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
  return member.globalRoles.includes("org_admin") || member.globalRoles.includes("billing_admin");
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
