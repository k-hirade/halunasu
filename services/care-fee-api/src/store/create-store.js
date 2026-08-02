import { createCareFeeFirestoreDb, FirestoreCareFeeStore } from "./firestore-store.js";
import { MemoryCareFeeStore } from "./memory-store.js";

export function createCareFeeStoreFromEnv(env = process.env) {
  const backend = (env.CARE_FEE_STORE_BACKEND || "memory").toLowerCase();
  if (backend === "memory") return new MemoryCareFeeStore();
  if (backend === "firestore") return new LazyFirestoreCareFeeStore({ projectId: careFeeProjectId(env) });
  throw new Error(`Unsupported CARE_FEE_STORE_BACKEND: ${backend}`);
}

export function careFeeProjectId(env = process.env) {
  return env.CARE_FEE_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "halunasu-care-stg";
}

export class LazyFirestoreCareFeeStore {
  constructor(options = {}) {
    this.options = options;
    this.storePromise = null;
  }

  async call(methodName, ...args) {
    const store = await this.store();
    return store[methodName](...args);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createCareFeeFirestoreDb(this.options).then((db) => new FirestoreCareFeeStore({ db }));
    }
    return this.storePromise;
  }
}

for (const methodName of [
  "upsertFacilitySettings",
  "listFacilitySettings",
  "getFacilitySettings",
  "recordImportJob",
  "listImportJobs",
  "upsertEpisodes",
  "listEpisodes",
  "getEpisode",
  "decideEpisode",
  "listMonthlyClaims",
  "getMonthlyRun",
  "recordMonthlyRun",
  "listMonthlyRuns",
  "getEvidenceReceipt",
  "recordEvidenceReceipt",
  "recordAudit",
  "listAuditLogs"
]) {
  LazyFirestoreCareFeeStore.prototype[methodName] = function lazyDelegate(...args) {
    return this.call(methodName, ...args);
  };
}
