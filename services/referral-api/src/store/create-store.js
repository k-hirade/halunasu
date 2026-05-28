import { FirestoreReferralStore, createFirestoreDb } from "./firestore-store.js";
import { MemoryReferralStore } from "./memory-store.js";

export function createReferralStoreFromEnv(env = process.env) {
  const backend = (env.REFERRAL_STORE_BACKEND || env.PLATFORM_STORE_BACKEND || "memory").toLowerCase();

  if (backend === "memory") {
    return new MemoryReferralStore();
  }

  if (backend === "firestore") {
    return new LazyFirestoreReferralStore({
      projectId: env.GOOGLE_CLOUD_PROJECT || "medical-core-stg"
    });
  }

  throw new Error(`Unsupported REFERRAL_STORE_BACKEND: ${backend}`);
}

export class LazyFirestoreReferralStore {
  constructor(options = {}) {
    this.options = options;
    this.storePromise = null;
  }

  async createReferral(input) {
    return this.call("createReferral", input);
  }

  async listReferrals(orgId) {
    return this.call("listReferrals", orgId);
  }

  async getReferral(orgId, referralId) {
    return this.call("getReferral", orgId, referralId);
  }

  async updateReferral(orgId, referralId, input) {
    return this.call("updateReferral", orgId, referralId, input);
  }

  async createPdfPlaceholder(orgId, referralId, input) {
    return this.call("createPdfPlaceholder", orgId, referralId, input);
  }

  async call(methodName, ...args) {
    const store = await this.store();
    return store[methodName](...args);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createFirestoreDb(this.options).then((db) => new FirestoreReferralStore({ db }));
    }

    return this.storePromise;
  }
}
