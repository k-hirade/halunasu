import { FirestoreFeeStore, createFirestoreDb } from "./firestore-store.js";
import { MemoryFeeStore } from "./memory-store.js";

export function createFeeStoreFromEnv(env = process.env) {
  const backend = (env.FEE_STORE_BACKEND || env.PLATFORM_STORE_BACKEND || "memory").toLowerCase();

  if (backend === "memory") {
    return new MemoryFeeStore();
  }

  if (backend === "firestore") {
    return new LazyFirestoreFeeStore({
      projectId: feeProjectId(env)
    });
  }

  throw new Error(`Unsupported FEE_STORE_BACKEND: ${backend}`);
}

export function feeProjectId(env = process.env) {
  return env.FEE_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "halunasu-fee-stg";
}

export class LazyFirestoreFeeStore {
  constructor(options = {}) {
    this.options = options;
    this.storePromise = null;
  }

  async createSession(input) {
    return this.call("createSession", input);
  }

  async listSessions(orgId, options) {
    return this.call("listSessions", orgId, options);
  }

  async listPriorSessionsForPatient(orgId, patientId, options) {
    return this.call("listPriorSessionsForPatient", orgId, patientId, options);
  }

  async getSession(orgId, feeSessionId) {
    return this.call("getSession", orgId, feeSessionId);
  }

  async getSessionStatus(orgId, feeSessionId) {
    return this.call("getSessionStatus", orgId, feeSessionId);
  }

  async updateSession(orgId, feeSessionId, patch) {
    return this.call("updateSession", orgId, feeSessionId, patch);
  }

  async saveCalculation(orgId, feeSessionId, calculationResult) {
    return this.call("saveCalculation", orgId, feeSessionId, calculationResult);
  }

  async getReceiptDraft(orgId, feeSessionId) {
    return this.call("getReceiptDraft", orgId, feeSessionId);
  }

  async listReviewItems(orgId, feeSessionId) {
    return this.call("listReviewItems", orgId, feeSessionId);
  }

  async decideReviewItem(orgId, feeSessionId, reviewItemId, input) {
    return this.call("decideReviewItem", orgId, feeSessionId, reviewItemId, input);
  }

  async createCalculationJob(orgId, feeSessionId, input) {
    return this.call("createCalculationJob", orgId, feeSessionId, input);
  }

  async getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return this.call("getCalculationJob", orgId, feeSessionId, calculationJobId);
  }

  async updateCalculationJob(orgId, feeSessionId, calculationJobId, patch) {
    return this.call("updateCalculationJob", orgId, feeSessionId, calculationJobId, patch);
  }

  async createMonthlyBulkJob(orgId, input) {
    return this.call("createMonthlyBulkJob", orgId, input);
  }

  async getMonthlyBulkJob(orgId, monthlyBulkJobId) {
    return this.call("getMonthlyBulkJob", orgId, monthlyBulkJobId);
  }

  async updateMonthlyBulkJob(orgId, monthlyBulkJobId, patch) {
    return this.call("updateMonthlyBulkJob", orgId, monthlyBulkJobId, patch);
  }

  async call(methodName, ...args) {
    const store = await this.store();
    return store[methodName](...args);
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = createFirestoreDb(this.options).then((db) => new FirestoreFeeStore({ db }));
    }

    return this.storePromise;
  }
}
