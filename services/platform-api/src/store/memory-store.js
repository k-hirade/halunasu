import crypto from "node:crypto";
import {
  validateCreateMemberInput,
  validateCreateOrganizationInput,
  validateCreatePatientInput
} from "../../../../packages/platform-contracts/src/index.js";

export class MemoryPlatformStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || defaultIdFactory;
    this.organizations = new Map();
    this.organizationCodes = new Map();
    this.membersByOrg = new Map();
    this.patientsByOrg = new Map();
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
    this.patientsByOrg.set(orgId, new Map());

    return organization;
  }

  listOrganizations() {
    return sortByCreatedAt([...this.organizations.values()]);
  }

  getOrganization(orgId) {
    return this.organizations.get(orgId) || null;
  }

  createMember(orgId, input) {
    this.requireOrganization(orgId);
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

    this.membersForOrg(orgId).set(memberId, member);
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

  requireOrganization(orgId) {
    const organization = this.getOrganization(orgId);
    if (!organization) {
      throw notFoundError("organization not found");
    }
    return organization;
  }

  membersForOrg(orgId) {
    if (!this.membersByOrg.has(orgId)) {
      this.membersByOrg.set(orgId, new Map());
    }
    return this.membersByOrg.get(orgId);
  }

  patientsForOrg(orgId) {
    if (!this.patientsByOrg.has(orgId)) {
      this.patientsByOrg.set(orgId, new Map());
    }
    return this.patientsByOrg.get(orgId);
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
