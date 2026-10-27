import { createEyeFirestoreDb, FirestoreEyeStore } from "./firestore-store.js";
import { MemoryEyeStore } from "./memory-store.js";

export function createEyeStoreFromEnv(env = process.env) {
  const backend = (env.EYE_STORE_BACKEND || "memory").toLowerCase();
  if (backend === "memory") return new MemoryEyeStore();
  if (backend === "firestore") return new LazyFirestoreEyeStore({ projectId: eyeProjectId(env) });
  throw new Error(`Unsupported EYE_STORE_BACKEND: ${backend}`);
}

export function eyeProjectId(env = process.env) {
  return env.EYE_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "halunasu-eye-stg";
}

export class LazyFirestoreEyeStore {
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
      this.storePromise = createEyeFirestoreDb(this.options).then((db) => new FirestoreEyeStore({ db }));
    }
    return this.storePromise;
  }
}

for (const methodName of [
  "createEncounter",
  "getEncounter",
  "listPatientEncounters",
  "listEncountersByDate",
  "replaceEncounter",
  "deleteDraftEncounter",
  "listVersions",
  "getVersion",
  "upsertDrugPreset",
  "listDrugPresets",
  "createAppointment",
  "getAppointment",
  "listAppointmentsByDate",
  "listPatientAppointments",
  "replaceAppointment",
  "recordAudit",
  "listAuditLogs"
]) {
  LazyFirestoreEyeStore.prototype[methodName] = function lazyDelegate(...args) {
    return this.call(methodName, ...args);
  };
}
