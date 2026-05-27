import { FirestorePlatformStore, createFirestoreDb } from "./firestore-store.js";
import { MemoryPlatformStore } from "./memory-store.js";

export function createPlatformStoreFromEnv(env = process.env) {
  const backend = (env.PLATFORM_STORE_BACKEND || env.STORE_BACKEND || "memory").toLowerCase();

  if (backend === "memory") {
    return new MemoryPlatformStore();
  }

  if (backend === "firestore") {
    return new LazyFirestorePlatformStore({
      projectId: env.GOOGLE_CLOUD_PROJECT || "medical-core-stg"
    });
  }

  throw new Error(`Unsupported PLATFORM_STORE_BACKEND: ${backend}`);
}

export class LazyFirestorePlatformStore {
  constructor(options = {}) {
    this.options = options;
    this.storePromise = null;
  }

  async createOrganization(input) {
    return (await this.store()).createOrganization(input);
  }

  async listOrganizations() {
    return (await this.store()).listOrganizations();
  }

  async getOrganization(orgId) {
    return this.call("getOrganization", orgId);
  }

  async updateOrganization(orgId, input) {
    return this.call("updateOrganization", orgId, input);
  }

  async createSignupApplication(input) {
    return this.call("createSignupApplication", input);
  }

  async getSignupApplication(applicationId) {
    return this.call("getSignupApplication", applicationId);
  }

  async listSignupApplications() {
    return this.call("listSignupApplications");
  }

  async createMember(orgId, input) {
    return this.call("createMember", orgId, input);
  }

  async listMembers(orgId) {
    return this.call("listMembers", orgId);
  }

  async getMember(orgId, memberId) {
    return this.call("getMember", orgId, memberId);
  }

  async updateMember(orgId, memberId, input) {
    return this.call("updateMember", orgId, memberId, input);
  }

  async getLoginIdentity(organizationCode, loginId) {
    return this.call("getLoginIdentity", organizationCode, loginId);
  }

  async recordLoginSuccess(identity) {
    return this.call("recordLoginSuccess", identity);
  }

  async recordLoginFailure(identity) {
    return this.call("recordLoginFailure", identity);
  }

  async beginMfaEnrollment(identity, secret) {
    return this.call("beginMfaEnrollment", identity, secret);
  }

  async completeMfaEnrollment(identity) {
    return this.call("completeMfaEnrollment", identity);
  }

  async revokeMemberSessions(identity) {
    return this.call("revokeMemberSessions", identity);
  }

  async createFacility(orgId, input) {
    return this.call("createFacility", orgId, input);
  }

  async listFacilities(orgId) {
    return this.call("listFacilities", orgId);
  }

  async getFacility(orgId, facilityId) {
    return this.call("getFacility", orgId, facilityId);
  }

  async updateFacility(orgId, facilityId, input) {
    return this.call("updateFacility", orgId, facilityId, input);
  }

  async createDepartment(orgId, input) {
    return this.call("createDepartment", orgId, input);
  }

  async listDepartments(orgId) {
    return this.call("listDepartments", orgId);
  }

  async getDepartment(orgId, departmentId) {
    return this.call("getDepartment", orgId, departmentId);
  }

  async updateDepartment(orgId, departmentId, input) {
    return this.call("updateDepartment", orgId, departmentId, input);
  }

  async createPatient(orgId, input) {
    return this.call("createPatient", orgId, input);
  }

  async listPatients(orgId) {
    return this.call("listPatients", orgId);
  }

  async getPatient(orgId, patientId) {
    return this.call("getPatient", orgId, patientId);
  }

  async updatePatient(orgId, patientId, input) {
    return this.call("updatePatient", orgId, patientId, input);
  }

  async upsertProductEntitlement(orgId, input) {
    return this.call("upsertProductEntitlement", orgId, input);
  }

  async listProductEntitlements(orgId) {
    return this.call("listProductEntitlements", orgId);
  }

  async getProductEntitlement(orgId, productId) {
    return this.call("getProductEntitlement", orgId, productId);
  }

  async updateProductEntitlement(orgId, productId, input) {
    return this.call("updateProductEntitlement", orgId, productId, input);
  }

  async createAuditEvent(orgId, input) {
    return this.call("createAuditEvent", orgId, input);
  }

  async listAuditEvents(orgId) {
    return this.call("listAuditEvents", orgId);
  }

  async getAuditEvent(orgId, eventId) {
    return this.call("getAuditEvent", orgId, eventId);
  }

  async consumeRateLimit(key, options) {
    return this.call("consumeRateLimit", key, options);
  }

  async call(methodName, ...args) {
    const store = await this.store();
    return store[methodName](...args);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createFirestoreDb(this.options).then((db) => new FirestorePlatformStore({ db }));
    }

    return this.storePromise;
  }
}
