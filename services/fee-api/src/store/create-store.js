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

  async upsertSidecarCalculationDraft(input) {
    return this.call("upsertSidecarCalculationDraft", input);
  }

  async getSidecarCalculationDraft(orgId, sidecarDraftId) {
    return this.call("getSidecarCalculationDraft", orgId, sidecarDraftId);
  }

  async listSidecarCalculationDrafts(orgId, options) {
    return this.call("listSidecarCalculationDrafts", orgId, options);
  }

  async updateSidecarCalculationDraft(orgId, sidecarDraftId, patch) {
    return this.call("updateSidecarCalculationDraft", orgId, sidecarDraftId, patch);
  }

  async saveSidecarCalculation(orgId, sidecarDraftId, calculationResult) {
    return this.call("saveSidecarCalculation", orgId, sidecarDraftId, calculationResult);
  }

  async listPriorSidecarDraftsForPatient(orgId, patientId, options) {
    return this.call("listPriorSidecarDraftsForPatient", orgId, patientId, options);
  }

  async adoptSidecarCalculationDraft(orgId, sidecarDraftId, sessionInput) {
    return this.call("adoptSidecarCalculationDraft", orgId, sidecarDraftId, sessionInput);
  }

  async listSessions(orgId, options) {
    return this.call("listSessions", orgId, options);
  }

  async listSessionsForClaimMonth(orgId, claimMonth, options) {
    return this.call("listSessionsForClaimMonth", orgId, claimMonth, options);
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

  async updateSession(orgId, feeSessionId, patch, options) {
    return this.call("updateSession", orgId, feeSessionId, patch, options);
  }

  async saveCalculation(orgId, feeSessionId, calculationResult, options) {
    return this.call("saveCalculation", orgId, feeSessionId, calculationResult, options);
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

  async decideReviewItems(orgId, feeSessionId, decisions) {
    return this.call("decideReviewItems", orgId, feeSessionId, decisions);
  }

  async createCalculationJob(orgId, feeSessionId, input) {
    return this.call("createCalculationJob", orgId, feeSessionId, input);
  }

  async getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return this.call("getCalculationJob", orgId, feeSessionId, calculationJobId);
  }

  async claimCalculationJob(orgId, feeSessionId, calculationJobId, input) {
    return this.call("claimCalculationJob", orgId, feeSessionId, calculationJobId, input);
  }

  async updateCalculationJob(orgId, feeSessionId, calculationJobId, patch, options) {
    return this.call("updateCalculationJob", orgId, feeSessionId, calculationJobId, patch, options);
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

  // 注意: server.js は `typeof feeStore.method === "function"` でフォールバックするため、
  // ここに delegate が無いメソッドは「保存せずエコー」等の沈黙劣化になる。
  // FirestoreFeeStore にメソッドを追加したら、必ずここにも delegate を追加すること。
  async getFeeSettings(orgId, facilityId) {
    return this.call("getFeeSettings", orgId, facilityId);
  }

  async updateFeeSettings(orgId, facilityId, settings) {
    return this.call("updateFeeSettings", orgId, facilityId, settings);
  }

  async createBillingHistoryEvent(orgId, input) {
    return this.call("createBillingHistoryEvent", orgId, input);
  }

  async listBillingHistoryEventsForPatient(orgId, patientId, options) {
    return this.call("listBillingHistoryEventsForPatient", orgId, patientId, options);
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
