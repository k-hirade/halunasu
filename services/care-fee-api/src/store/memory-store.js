import { randomUUID } from "node:crypto";
import { stableId } from "../episode-documents.js";

export class MemoryCareFeeStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.settingsByOrg = new Map();
    this.episodesByOrg = new Map();
    this.importJobsByOrg = new Map();
    this.monthlyRunsByOrg = new Map();
    this.claimsByOrg = new Map();
    this.receiptsByOrg = new Map();
    this.auditLogsByOrg = new Map();
  }

  upsertFacilitySettings(orgId, input) {
    const current = this.mapForOrg(this.settingsByOrg, orgId).get(input.facilityId);
    const settings = Object.freeze({
      ...current,
      ...input,
      orgId,
      createdAt: current?.createdAt || this.timestamp(),
      updatedAt: this.timestamp()
    });
    this.mapForOrg(this.settingsByOrg, orgId).set(input.facilityId, settings);
    return settings;
  }

  listFacilitySettings(orgId) {
    return sortBy(this.mapForOrg(this.settingsByOrg, orgId).values(), "facilityId");
  }

  getFacilitySettings(orgId, facilityId) {
    return this.mapForOrg(this.settingsByOrg, orgId).get(facilityId) || null;
  }

  recordImportJob(orgId, input) {
    const importJob = Object.freeze({
      ...input,
      importJobId: input.importJobId || this.idFactory("cij"),
      orgId,
      createdAt: input.createdAt || this.timestamp()
    });
    this.mapForOrg(this.importJobsByOrg, orgId).set(importJob.importJobId, importJob);
    return importJob;
  }

  listImportJobs(orgId) {
    return sortBy(this.mapForOrg(this.importJobsByOrg, orgId).values(), "createdAt", true);
  }

  upsertEpisodes(orgId, documents) {
    const episodes = this.mapForOrg(this.episodesByOrg, orgId);
    return (documents || []).map((document) => {
      const current = episodes.get(document.episodeId);
      if (current?.sourceRevisionHash === document.sourceRevisionHash) return current;
      const decisionHistory = current?.decisionStatus && current.decisionStatus !== "pending"
        ? [...(current.decisionHistory || []), {
          status: current.decisionStatus,
          decision: current.decision,
          supersededAt: this.timestamp()
        }]
        : [...(current?.decisionHistory || [])];
      const updated = Object.freeze({
        ...document,
        createdAt: current?.createdAt || document.createdAt,
        decisionHistory: Object.freeze(decisionHistory),
        claimReconciliationRequired: Boolean(current?.decisionStatus === "confirmed"),
        updatedAt: this.timestamp()
      });
      episodes.set(updated.episodeId, updated);
      return updated;
    });
  }

  listEpisodes(orgId, options = {}) {
    return sortBy([...this.mapForOrg(this.episodesByOrg, orgId).values()].filter((episode) => (
      (!options.facilityId || episode.facilityId === options.facilityId)
      && (!options.claimMonth || episode.claimMonth === options.claimMonth)
    )), "updatedAt", true);
  }

  getEpisode(orgId, episodeId) {
    return this.mapForOrg(this.episodesByOrg, orgId).get(episodeId) || null;
  }

  decideEpisode(orgId, episodeId, input) {
    const episodes = this.mapForOrg(this.episodesByOrg, orgId);
    const current = episodes.get(episodeId);
    if (!current) throw storeError("NotFoundError", 404, "care fee episode not found");
    if (current.decisionStatus !== "pending") {
      if (current.decisionStatus === input.status) return { episode: current, claim: this.claimForEpisode(orgId, episodeId) };
      throw storeError("ConflictError", 409, "care fee episode already has a final decision");
    }
    if (input.status === "confirmed" && current.evaluation.judgmentStatus !== "billing_candidate") {
      throw storeError("ConflictError", 409, "only a billing candidate can be confirmed");
    }

    let claim = null;
    if (input.status === "confirmed") {
      const claimId = stableId("ccm", orgId, current.facilityId, current.patientKey, current.claimMonth);
      const existingClaim = this.mapForOrg(this.claimsByOrg, orgId).get(claimId);
      if (existingClaim && existingClaim.episodeId !== episodeId) {
        throw storeError("ConflictError", 409, "an emergency treatment claim is already confirmed for this patient and month");
      }
      claim = existingClaim || Object.freeze({
        claimId,
        orgId,
        episodeId,
        episodeKey: current.episodeKey,
        facilityId: current.facilityId,
        patientKey: current.patientKey,
        claimMonth: current.claimMonth,
        eligibleDayCount: current.evaluation.eligibleDayCount,
        totalUnits: current.evaluation.totalUnits,
        ruleVersion: current.evaluation.ruleVersion,
        masterVersion: current.evaluation.masterVersion,
        confirmedByMemberId: input.memberId,
        confirmedAt: this.timestamp(),
        createdAt: this.timestamp(),
        updatedAt: this.timestamp()
      });
      this.mapForOrg(this.claimsByOrg, orgId).set(claimId, claim);
    }

    const episode = Object.freeze({
      ...current,
      decisionStatus: input.status,
      decision: Object.freeze({
        status: input.status,
        reason: input.reason || "",
        memberId: input.memberId,
        loginId: input.loginId,
        decidedAt: this.timestamp()
      }),
      claimReconciliationRequired: false,
      updatedAt: this.timestamp()
    });
    episodes.set(episodeId, episode);
    return { episode, claim };
  }

  listMonthlyClaims(orgId, options = {}) {
    return sortBy([...this.mapForOrg(this.claimsByOrg, orgId).values()].filter((claim) => (
      (!options.facilityId || claim.facilityId === options.facilityId)
      && (!options.claimMonth || claim.claimMonth === options.claimMonth)
    )), "createdAt");
  }

  getMonthlyRun(orgId, runId) {
    return this.mapForOrg(this.monthlyRunsByOrg, orgId).get(runId) || null;
  }

  recordMonthlyRun(orgId, input) {
    const existing = this.getMonthlyRun(orgId, input.runId);
    if (existing) return existing;
    const run = Object.freeze({ ...input, orgId, createdAt: input.createdAt || this.timestamp() });
    this.mapForOrg(this.monthlyRunsByOrg, orgId).set(run.runId, run);
    return run;
  }

  listMonthlyRuns(orgId, options = {}) {
    return sortBy([...this.mapForOrg(this.monthlyRunsByOrg, orgId).values()].filter((run) => (
      (!options.facilityId || run.facilityId === options.facilityId)
      && (!options.claimMonth || run.claimMonth === options.claimMonth)
    )), "createdAt", true);
  }

  getEvidenceReceipt(orgId, receiptId) {
    return this.mapForOrg(this.receiptsByOrg, orgId).get(receiptId) || null;
  }

  recordEvidenceReceipt(orgId, input) {
    const existing = this.getEvidenceReceipt(orgId, input.receiptId);
    if (existing) return existing;
    const receipt = Object.freeze({ ...input, orgId, createdAt: input.createdAt || this.timestamp() });
    this.mapForOrg(this.receiptsByOrg, orgId).set(receipt.receiptId, receipt);
    return receipt;
  }

  recordAudit(orgId, input) {
    const audit = Object.freeze({
      ...input,
      auditLogId: input.auditLogId || this.idFactory("cau"),
      orgId,
      createdAt: input.createdAt || this.timestamp()
    });
    this.mapForOrg(this.auditLogsByOrg, orgId).set(audit.auditLogId, audit);
    return audit;
  }

  listAuditLogs(orgId) {
    return sortBy(this.mapForOrg(this.auditLogsByOrg, orgId).values(), "createdAt", true);
  }

  claimForEpisode(orgId, episodeId) {
    return [...this.mapForOrg(this.claimsByOrg, orgId).values()].find((claim) => claim.episodeId === episodeId) || null;
  }

  mapForOrg(container, orgId) {
    if (!container.has(orgId)) container.set(orgId, new Map());
    return container.get(orgId);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

function sortBy(values, property, descending = false) {
  return [...values].sort((left, right) => {
    const result = String(left[property] || "").localeCompare(String(right[property] || ""));
    return descending ? -result : result;
  });
}

function storeError(name, statusCode, message) {
  const error = new Error(message);
  error.name = name;
  error.statusCode = statusCode;
  return error;
}
