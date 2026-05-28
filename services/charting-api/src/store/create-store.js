import { FirestoreChartingStore, createFirestoreDb } from "./firestore-store.js";
import { MemoryChartingStore } from "./memory-store.js";

export function createChartingStoreFromEnv(env = process.env) {
  const backend = (env.CHARTING_STORE_BACKEND || env.PLATFORM_STORE_BACKEND || "memory").toLowerCase();

  if (backend === "memory") {
    return new MemoryChartingStore();
  }

  if (backend === "firestore") {
    return new LazyFirestoreChartingStore({
      projectId: chartingProjectId(env)
    });
  }

  throw new Error(`Unsupported CHARTING_STORE_BACKEND: ${backend}`);
}

export function chartingProjectId(env = process.env) {
  return env.CHARTING_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "halunasu-charting-stg";
}

export class LazyFirestoreChartingStore {
  constructor(options = {}) {
    this.options = options;
    this.storePromise = null;
  }

  async createEncounter(input) {
    return this.call("createEncounter", input);
  }

  async listEncounters(orgId) {
    return this.call("listEncounters", orgId);
  }

  async getEncounter(orgId, encounterId) {
    return this.call("getEncounter", orgId, encounterId);
  }

  async updateEncounter(orgId, encounterId, input) {
    return this.call("updateEncounter", orgId, encounterId, input);
  }

  async createMockSoapDraft(orgId, encounterId, input) {
    return this.call("createMockSoapDraft", orgId, encounterId, input);
  }

  async listSoapDrafts(orgId, encounterId) {
    return this.call("listSoapDrafts", orgId, encounterId);
  }

  async call(methodName, ...args) {
    const store = await this.store();
    return store[methodName](...args);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createFirestoreDb(this.options).then((db) => new FirestoreChartingStore({ db }));
    }

    return this.storePromise;
  }
}
