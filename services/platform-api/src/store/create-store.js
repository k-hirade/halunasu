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
    return (await this.store()).getOrganization(orgId);
  }

  async createMember(orgId, input) {
    return (await this.store()).createMember(orgId, input);
  }

  async listMembers(orgId) {
    return (await this.store()).listMembers(orgId);
  }

  async getMember(orgId, memberId) {
    return (await this.store()).getMember(orgId, memberId);
  }

  async createPatient(orgId, input) {
    return (await this.store()).createPatient(orgId, input);
  }

  async listPatients(orgId) {
    return (await this.store()).listPatients(orgId);
  }

  async getPatient(orgId, patientId) {
    return (await this.store()).getPatient(orgId, patientId);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createFirestoreDb(this.options).then((db) => new FirestorePlatformStore({ db }));
    }

    return this.storePromise;
  }
}

