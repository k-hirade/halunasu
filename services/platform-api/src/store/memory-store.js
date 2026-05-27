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
  validateUpsertProductEntitlementInput
} from "../../../../packages/platform-contracts/src/index.js";
import { loginIdentityKey } from "../../../../packages/firestore-schema/src/index.js";
import { hashPassword } from "../auth/password.js";

export class MemoryPlatformStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory;
    this.organizations = new Map();
    this.organizationCodes = new Map();
    this.loginIdentities = new Map();
    this.membersByOrg = new Map();
    this.facilitiesByOrg = new Map();
    this.departmentsByOrg = new Map();
    this.patientsByOrg = new Map();
    this.productEntitlementsByOrg = new Map();
    this.auditEventsByOrg = new Map();
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

    return organization;
  }

  listOrganizations() {
    return sortByCreatedAt([...this.organizations.values()]);
  }

  getOrganization(orgId) {
    return this.organizations.get(orgId) || null;
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
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.membersForOrg(orgId).values()]);
  }

  getMember(orgId, memberId) {
    this.requireOrganization(orgId);
    return this.membersForOrg(orgId).get(memberId) || null;
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

  listAuditEvents(orgId) {
    this.requireOrganization(orgId);
    return sortByCreatedAt([...this.auditEventsForOrg(orgId).values()]);
  }

  getAuditEvent(orgId, eventId) {
    this.requireOrganization(orgId);
    return this.auditEventsForOrg(orgId).get(eventId) || null;
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

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function sortByCreatedAt(items) {
  return items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
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
