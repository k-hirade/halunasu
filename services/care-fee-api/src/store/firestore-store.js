import {
  careFeeAuditLogPath,
  careFeeEpisodePath,
  careFeeEvidenceReceiptPath,
  careFeeFacilitySettingsPath,
  careFeeImportJobPath,
  careFeeMonthlyClaimPath,
  careFeeMonthlyRunPath,
  collections,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import { stableId } from "../episode-documents.js";

export class FirestoreCareFeeStore {
  constructor(options = {}) {
    if (!options.db) throw new TypeError("db is required");
    this.db = options.db;
    this.now = options.now || (() => new Date());
  }

  async upsertFacilitySettings(orgId, input) {
    const ref = this.doc(careFeeFacilitySettingsPath(orgId, input.facilityId));
    const current = dataOrNull(await ref.get());
    const settings = {
      ...current,
      ...input,
      orgId,
      createdAt: current?.createdAt || this.timestamp(),
      updatedAt: this.timestamp()
    };
    await ref.set(settings);
    return settings;
  }

  async listFacilitySettings(orgId) {
    return sorted(await this.all(orgId, collections.careFeeFacilitySettings), "facilityId");
  }

  async getFacilitySettings(orgId, facilityId) {
    return dataOrNull(await this.doc(careFeeFacilitySettingsPath(orgId, facilityId)).get());
  }

  async recordImportJob(orgId, input) {
    const importJobId = input.importJobId;
    const importJob = {
      ...input,
      importJobId,
      orgId,
      createdAt: input.createdAt || this.timestamp(),
      purgeAt: input.purgeAt instanceof Date ? input.purgeAt : new Date(input.purgeAt)
    };
    await this.doc(careFeeImportJobPath(orgId, importJobId)).set(importJob);
    return serializeDates(importJob);
  }

  async listImportJobs(orgId) {
    return sorted(await this.all(orgId, collections.careFeeImportJobs), "createdAt", true).map(serializeDates);
  }

  async upsertEpisodes(orgId, documents) {
    return Promise.all((documents || []).map((document) => this.db.runTransaction(async (transaction) => {
      const ref = this.doc(careFeeEpisodePath(orgId, document.episodeId));
      const current = dataOrNull(await transaction.get(ref));
      if (current?.sourceRevisionHash === document.sourceRevisionHash) return current;
      const decisionHistory = current?.decisionStatus && current.decisionStatus !== "pending"
        ? [...(current.decisionHistory || []), {
          status: current.decisionStatus,
          decision: current.decision,
          supersededAt: this.timestamp()
        }]
        : [...(current?.decisionHistory || [])];
      const updated = {
        ...document,
        createdAt: current?.createdAt || document.createdAt,
        decisionHistory,
        claimReconciliationRequired: Boolean(current?.decisionStatus === "confirmed"),
        updatedAt: this.timestamp()
      };
      transaction.set(ref, updated);
      return updated;
    })));
  }

  async listEpisodes(orgId, options = {}) {
    let query = this.orgCollection(orgId, collections.careFeeEpisodes);
    if (options.facilityId && options.claimMonth) {
      query = query.where("facilityClaimMonthKey", "==", `${options.facilityId}|${options.claimMonth}`);
    } else if (options.facilityId) {
      query = query.where("facilityId", "==", options.facilityId);
    } else if (options.claimMonth) {
      query = query.where("claimMonth", "==", options.claimMonth);
    }
    return sorted(docs(await query.get()), "updatedAt", true);
  }

  async getEpisode(orgId, episodeId) {
    return dataOrNull(await this.doc(careFeeEpisodePath(orgId, episodeId)).get());
  }

  async decideEpisode(orgId, episodeId, input) {
    return this.db.runTransaction(async (transaction) => {
      const episodeRef = this.doc(careFeeEpisodePath(orgId, episodeId));
      const current = dataOrNull(await transaction.get(episodeRef));
      if (!current) throw storeError("NotFoundError", 404, "care fee episode not found");
      if (current.decisionStatus !== "pending") {
        if (current.decisionStatus === input.status) {
          return { episode: current, claim: null };
        }
        throw storeError("ConflictError", 409, "care fee episode already has a final decision");
      }
      if (input.status === "confirmed" && current.evaluation.judgmentStatus !== "billing_candidate") {
        throw storeError("ConflictError", 409, "only a billing candidate can be confirmed");
      }

      let claim = null;
      if (input.status === "confirmed") {
        const claimId = stableId("ccm", orgId, current.facilityId, current.patientKey, current.claimMonth);
        const claimRef = this.doc(careFeeMonthlyClaimPath(orgId, claimId));
        const existingClaim = dataOrNull(await transaction.get(claimRef));
        if (existingClaim && existingClaim.episodeId !== episodeId) {
          throw storeError("ConflictError", 409, "an emergency treatment claim is already confirmed for this patient and month");
        }
        claim = existingClaim || {
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
        };
        transaction.set(claimRef, claim);
      }

      const episode = {
        ...current,
        decisionStatus: input.status,
        decision: {
          status: input.status,
          reason: input.reason || "",
          memberId: input.memberId,
          loginId: input.loginId,
          decidedAt: this.timestamp()
        },
        claimReconciliationRequired: false,
        updatedAt: this.timestamp()
      };
      transaction.set(episodeRef, episode);
      return { episode, claim };
    });
  }

  async listMonthlyClaims(orgId, options = {}) {
    const all = await this.all(orgId, collections.careFeeMonthlyClaims);
    return sorted(all.filter((claim) => (
      (!options.facilityId || claim.facilityId === options.facilityId)
      && (!options.claimMonth || claim.claimMonth === options.claimMonth)
    )), "createdAt");
  }

  async getMonthlyRun(orgId, runId) {
    return dataOrNull(await this.doc(careFeeMonthlyRunPath(orgId, runId)).get());
  }

  async recordMonthlyRun(orgId, input) {
    const ref = this.doc(careFeeMonthlyRunPath(orgId, input.runId));
    return this.db.runTransaction(async (transaction) => {
      const current = dataOrNull(await transaction.get(ref));
      if (current) return current;
      const run = { ...input, orgId, createdAt: input.createdAt || this.timestamp() };
      transaction.set(ref, run);
      return run;
    });
  }

  async listMonthlyRuns(orgId, options = {}) {
    const all = await this.all(orgId, collections.careFeeMonthlyRuns);
    return sorted(all.filter((run) => (
      (!options.facilityId || run.facilityId === options.facilityId)
      && (!options.claimMonth || run.claimMonth === options.claimMonth)
    )), "createdAt", true);
  }

  async getEvidenceReceipt(orgId, receiptId) {
    return dataOrNull(await this.doc(careFeeEvidenceReceiptPath(orgId, receiptId)).get());
  }

  async recordEvidenceReceipt(orgId, input) {
    const ref = this.doc(careFeeEvidenceReceiptPath(orgId, input.receiptId));
    return this.db.runTransaction(async (transaction) => {
      const current = dataOrNull(await transaction.get(ref));
      if (current) return current;
      const receipt = { ...input, orgId, createdAt: input.createdAt || this.timestamp() };
      transaction.set(ref, receipt);
      return receipt;
    });
  }

  async recordAudit(orgId, input) {
    const audit = {
      ...input,
      orgId,
      createdAt: input.createdAt || this.timestamp()
    };
    await this.doc(careFeeAuditLogPath(orgId, audit.auditLogId)).set(audit);
    return audit;
  }

  async listAuditLogs(orgId) {
    return sorted(await this.all(orgId, collections.careFeeAuditLogs), "createdAt", true);
  }

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, name) {
    return this.doc(organizationPath(orgId)).collection(name);
  }

  async all(orgId, name) {
    return docs(await this.orgCollection(orgId, name).get());
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export async function createCareFeeFirestoreDb(options = {}) {
  const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  const projectId = options.projectId
    || process.env.CARE_FEE_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "halunasu-care-stg";
  const name = "halunasu-care-fee-api";
  const app = getApps().find((candidate) => candidate.name === name) || initializeApp({ projectId }, name);
  return getFirestore(app);
}

function docs(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function dataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}

function sorted(values, property, descending = false) {
  return [...values].sort((left, right) => {
    const result = String(left[property] || "").localeCompare(String(right[property] || ""));
    return descending ? -result : result;
  });
}

function serializeDates(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item instanceof Date ? item.toISOString() : item
  ]));
}

function storeError(name, statusCode, message) {
  const error = new Error(message);
  error.name = name;
  error.statusCode = statusCode;
  return error;
}
