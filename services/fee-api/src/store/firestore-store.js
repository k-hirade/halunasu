import {
  applyReviewDecision,
  applyCalculationResult,
  applyFeeSessionPatch,
  buildReceiptDraft,
  buildReviewItems,
  buildFeeSession,
  createId
} from "../../../../packages/fee-core/src/index.js";
import {
  collections,
  feeBillingHistoryPath,
  feeSettingsPath,
  feeSessionPath,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import {
  matchesSearch,
  matchesStatus,
  monthlyBulkJobProgress,
  normalizeListOptions,
  notFoundError,
  toSessionSummary
} from "./memory-store.js";

const SESSION_SUMMARY_FIELDS = [
  "feeSessionId",
  "sessionId",
  "orgId",
  "patientId",
  "patientRef",
  "patientSnapshot",
  "facilityId",
  "facilitySnapshot",
  "departmentId",
  "departmentSnapshot",
  "createdByMemberId",
  "status",
  "serviceDate",
  "claimMonth",
  "setting",
  "sourceSystem",
  "latestCalculationId",
  "activeCalculationJobId",
  "calculationSummary",
  "createdAt",
  "updatedAt",
  "schemaVersion"
];

const PATIENT_HISTORY_FIELDS = [
  ...SESSION_SUMMARY_FIELDS,
  "diagnoses",
  "calculationResult",
  "calculationOptions",
  "calculationOptionsSource"
];

export class FirestoreFeeStore {
  constructor(options = {}) {
    if (!options.db) {
      throw new TypeError("db is required");
    }

    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
  }

  async createSession(input) {
    const session = sanitizeForFirestore(buildFeeSession(input, {
      feeSessionId: this.idFactory("fee"),
      now: this.timestamp()
    }));

    await this.doc(feeSessionPath(session.orgId, session.feeSessionId)).set(session);
    await this.writeSessionStatusView(session.orgId, session.feeSessionId, session);
    return session;
  }

  async listSessions(orgId, options) {
    const baseQuery = this.orgCollection(orgId, collections.feeSessions).orderBy("createdAt", "desc");
    if (options === undefined) {
      const snapshot = await baseQuery.get();
      return docsFromSnapshot(snapshot);
    }

    const listOptions = normalizeListOptions(options);
    if (listOptions.search || listOptions.statuses.length) {
      return this.listSessionsByBoundedScan(baseQuery, listOptions);
    }

    const totalCount = await countQuery(baseQuery);
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / listOptions.pageSize) : 0;
    const page = totalPages > 0 ? Math.min(listOptions.page, totalPages) : 1;
    const snapshot = await baseQuery
      .select(...SESSION_SUMMARY_FIELDS)
      .offset((page - 1) * listOptions.pageSize)
      .limit(listOptions.pageSize)
      .get();

    return {
      feeSessions: docsFromSnapshot(snapshot).map(toSessionSummary),
      page,
      pageSize: listOptions.pageSize,
      totalCount,
      totalPages
    };
  }

  async listSessionsByBoundedScan(baseQuery, listOptions) {
    const scanLimit = Math.max(
      listOptions.page * listOptions.pageSize,
      Number.parseInt(process.env.FEE_SESSION_LIST_SCAN_LIMIT || "500", 10) || 500
    );
    const snapshot = await baseQuery
      .select(...SESSION_SUMMARY_FIELDS)
      .limit(scanLimit)
      .get();
    const filtered = docsFromSnapshot(snapshot)
      .filter((session) => matchesStatus(session, listOptions.statuses))
      .filter((session) => matchesSearch(session, listOptions.search));
    const totalCount = filtered.length;
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / listOptions.pageSize) : 0;
    const page = totalPages > 0 ? Math.min(listOptions.page, totalPages) : 1;
    const startIndex = (page - 1) * listOptions.pageSize;

    return {
      feeSessions: filtered.slice(startIndex, startIndex + listOptions.pageSize).map(toSessionSummary),
      page,
      pageSize: listOptions.pageSize,
      totalCount,
      totalPages,
      totalCountApproximate: snapshot.size >= scanLimit
    };
  }

  async listPriorSessionsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    if (!normalizedPatientId) {
      return [];
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const excludeFeeSessionId = String(options.excludeFeeSessionId || "").trim();
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 10));

    try {
      let query = this.orgCollection(orgId, collections.feeSessions)
        .where("patientId", "==", normalizedPatientId);
      if (beforeServiceDate) {
        query = query.where("serviceDate", includeSameServiceDate ? "<=" : "<", beforeServiceDate);
      }
      if (sinceServiceDate) {
        query = query.where("serviceDate", ">=", sinceServiceDate);
      }
      const snapshot = await query
        .orderBy("serviceDate", "desc")
        .select(...PATIENT_HISTORY_FIELDS)
        .limit(limit)
        .get();
      return docsFromSnapshot(snapshot)
        .filter((session) => !excludeFeeSessionId || session.feeSessionId !== excludeFeeSessionId);
    } catch {
      return this.listPriorSessionsForPatientByBoundedScan(orgId, normalizedPatientId, {
        beforeServiceDate,
        sinceServiceDate,
        includeSameServiceDate,
        excludeFeeSessionId,
        limit
      });
    }
  }

  async listPriorSessionsForPatientByBoundedScan(orgId, patientId, options = {}) {
    const scanLimit = Number.parseInt(process.env.FEE_PATIENT_HISTORY_SCAN_LIMIT || "500", 10) || 500;
    const snapshot = await this.orgCollection(orgId, collections.feeSessions)
      .orderBy("createdAt", "desc")
      .select(...PATIENT_HISTORY_FIELDS)
      .limit(scanLimit)
      .get();
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const excludeFeeSessionId = String(options.excludeFeeSessionId || "").trim();
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 10));
    return docsFromSnapshot(snapshot)
      .filter((session) => String(session.patientId || "").trim() === patientId)
      .filter((session) => !excludeFeeSessionId || session.feeSessionId !== excludeFeeSessionId)
      .filter((session) => (
        !beforeServiceDate
        || (includeSameServiceDate
          ? String(session.serviceDate || "") <= beforeServiceDate
          : String(session.serviceDate || "") < beforeServiceDate)
      ))
      .filter((session) => !sinceServiceDate || String(session.serviceDate || "") >= sinceServiceDate)
      .sort((left, right) => (
        String(right.serviceDate || "").localeCompare(String(left.serviceDate || ""))
        || String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      ))
      .slice(0, limit);
  }

  async getSession(orgId, feeSessionId) {
    return docDataOrNull(await this.doc(feeSessionPath(orgId, feeSessionId)).get());
  }

  async getSessionStatus(orgId, feeSessionId) {
    const snapshot = await this.sessionStatusViewDoc(orgId, feeSessionId).get();
    let statusView = docDataOrNull(snapshot);
    if (!statusView) {
      const session = await this.getSession(orgId, feeSessionId);
      if (!session) {
        return null;
      }
      statusView = sessionStatusView(session);
      await this.writeSessionStatusView(orgId, feeSessionId, session);
    }

    const activeCalculationJobId = statusView.activeCalculationJobId || null;
    if (activeCalculationJobId) {
      const activeJob = await this.getCalculationJob(orgId, feeSessionId, activeCalculationJobId).catch(() => null);
      if (activeJob?.progress) {
        return {
          ...statusView,
          calculationProgress: activeJob.progress,
          updatedAt: activeJob.updatedAt || statusView.updatedAt || null
        };
      }
    }

    return statusView;
  }

  async updateSession(orgId, feeSessionId, patch) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = sanitizeForFirestore(applyFeeSessionPatch(current, patch, {
      now: this.timestamp()
    }));
    await this.writeSessionPatch(orgId, feeSessionId, current, updated);
    await this.writeSessionStatusView(orgId, feeSessionId, updated);

    return {
      feeSession: updated
    };
  }

  async saveCalculation(orgId, feeSessionId, calculationResult) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = sanitizeForFirestore(applyCalculationResult(current, calculationResult, {
      calculationId: this.idFactory("calc"),
      now: this.timestamp()
    }));
    await this.writeSessionPatch(orgId, feeSessionId, current, updated);
    await this.writeSessionStatusView(orgId, feeSessionId, updated);

    return {
      feeSession: updated,
      calculationResult: updated.calculationResult
    };
  }

  async getReceiptDraft(orgId, feeSessionId) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    return buildReceiptDraft(current, {
      now: this.timestamp()
    });
  }

  async listReviewItems(orgId, feeSessionId) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    return buildReviewItems(current);
  }

  async decideReviewItem(orgId, feeSessionId, reviewItemId, input) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = sanitizeForFirestore(applyReviewDecision(current, reviewItemId, input, {
      now: this.timestamp()
    }));
    await this.writeSessionPatch(orgId, feeSessionId, current, updated);
    await this.writeSessionStatusView(orgId, feeSessionId, updated);

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  async decideReviewItems(orgId, feeSessionId, decisions = []) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const now = this.timestamp();
    let updated = current;
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      updated = applyReviewDecision(updated, decision.reviewItemId, decision, {
        now
      });
    }
    updated = sanitizeForFirestore(updated);
    await this.writeSessionPatch(orgId, feeSessionId, current, updated);
    await this.writeSessionStatusView(orgId, feeSessionId, updated);

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  async createCalculationJob(orgId, feeSessionId, input = {}) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    const now = this.timestamp();
    const calculationJobId = this.idFactory("fee_calc_job");
    const job = sanitizeForFirestore({
      calculationJobId,
      jobId: calculationJobId,
      orgId,
      feeSessionId,
      status: input.status || "queued",
      phase: input.phase || "queued",
      calculationInput: input.calculationInput || {},
      inputSnapshot: input.inputSnapshot || null,
      enqueueStatus: input.enqueueStatus || "pending",
      enqueueProvider: input.enqueueProvider || null,
      enqueueMessage: input.enqueueMessage || null,
      createdByMemberId: input.createdByMemberId || null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    await this.calculationJobDoc(orgId, feeSessionId, calculationJobId).set(job);
    return { calculationJob: job };
  }

  async getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return docDataOrNull(await this.calculationJobDoc(orgId, feeSessionId, calculationJobId).get());
  }

  async updateCalculationJob(orgId, feeSessionId, calculationJobId, patch = {}) {
    const current = await this.getCalculationJob(orgId, feeSessionId, calculationJobId);
    if (!current) {
      throw notFoundError("fee calculation job not found");
    }
    const updated = sanitizeForFirestore({
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    });
    await this.calculationJobDoc(orgId, feeSessionId, calculationJobId).set(updated);
    return { calculationJob: updated };
  }

  async createMonthlyBulkJob(orgId, input = {}) {
    const now = this.timestamp();
    const monthlyBulkJobId = this.idFactory("fee_monthly_bulk_job");
    const job = sanitizeForFirestore({
      monthlyBulkJobId,
      jobId: monthlyBulkJobId,
      orgId,
      claimMonth: input.claimMonth || null,
      status: input.status || "planned",
      phase: input.phase || "planned",
      progress: input.progress || monthlyBulkJobProgress(input.items || []),
      items: Array.isArray(input.items) ? input.items : [],
      resultSummary: input.resultSummary || null,
      createdByMemberId: input.createdByMemberId || null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    await this.monthlyBulkJobDoc(orgId, monthlyBulkJobId).set(job);
    return { monthlyBulkJob: job };
  }

  async getMonthlyBulkJob(orgId, monthlyBulkJobId) {
    return docDataOrNull(await this.monthlyBulkJobDoc(orgId, monthlyBulkJobId).get());
  }

  async updateMonthlyBulkJob(orgId, monthlyBulkJobId, patch = {}) {
    const current = await this.getMonthlyBulkJob(orgId, monthlyBulkJobId);
    if (!current) {
      throw notFoundError("monthly bulk job not found");
    }
    const updated = sanitizeForFirestore({
      ...current,
      ...patch,
      progress: patch.progress || monthlyBulkJobProgress(patch.items || current.items || []),
      updatedAt: this.timestamp()
    });
    await this.monthlyBulkJobDoc(orgId, monthlyBulkJobId).set(updated);
    return { monthlyBulkJob: updated };
  }

  async getFeeSettings(orgId, facilityId = "default") {
    return docDataOrNull(await this.doc(feeSettingsPath(orgId, facilityId || "default")).get());
  }

  async updateFeeSettings(orgId, facilityId = "default", settings = {}) {
    const now = this.timestamp();
    const key = facilityId || "default";
    const current = await this.getFeeSettings(orgId, key);
    const updated = sanitizeForFirestore({
      ...(current || {}),
      ...settings,
      orgId,
      facilityId: key,
      schemaVersion: 1,
      createdAt: current?.createdAt || now,
      updatedAt: now
    });
    await this.doc(feeSettingsPath(orgId, key)).set(updated);
    return updated;
  }

  async createBillingHistoryEvent(orgId, input = {}) {
    const now = this.timestamp();
    const historyEventId = this.idFactory("fee_hist");
    const event = sanitizeForFirestore({
      historyEventId,
      orgId,
      ...input,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    await this.doc(feeBillingHistoryPath(orgId, historyEventId)).set(event);
    return event;
  }

  async listBillingHistoryEventsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    if (!normalizedPatientId) {
      return [];
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 100));
    try {
      let query = this.orgCollection(orgId, collections.feeBillingHistory)
        .where("patientId", "==", normalizedPatientId);
      if (beforeServiceDate) {
        query = query.where("serviceDate", includeSameServiceDate ? "<=" : "<", beforeServiceDate);
      }
      if (sinceServiceDate) {
        query = query.where("serviceDate", ">=", sinceServiceDate);
      }
      const snapshot = await query.orderBy("serviceDate", "desc").limit(limit).get();
      return docsFromSnapshot(snapshot);
    } catch {
      const scanLimit = Number.parseInt(process.env.FEE_BILLING_HISTORY_SCAN_LIMIT || "500", 10) || 500;
      const snapshot = await this.orgCollection(orgId, collections.feeBillingHistory)
        .orderBy("createdAt", "desc")
        .limit(scanLimit)
        .get();
      return docsFromSnapshot(snapshot)
        .filter((event) => String(event.patientId || "").trim() === normalizedPatientId)
        .filter((event) => (
          !beforeServiceDate
          || (includeSameServiceDate
            ? String(event.serviceDate || "") <= beforeServiceDate
            : String(event.serviceDate || "") < beforeServiceDate)
        ))
        .filter((event) => !sinceServiceDate || String(event.serviceDate || "") >= sinceServiceDate)
        .sort((left, right) => String(right.serviceDate || "").localeCompare(String(left.serviceDate || "")))
        .slice(0, limit);
    }
  }

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, collectionName) {
    return this.doc(organizationPath(orgId)).collection(collectionName);
  }

  calculationJobDoc(orgId, feeSessionId, calculationJobId) {
    return this.doc(feeSessionPath(orgId, feeSessionId))
      .collection("calculationJobs")
      .doc(calculationJobId);
  }

  monthlyBulkJobDoc(orgId, monthlyBulkJobId) {
    return this.orgCollection(orgId, "monthlyBulkJobs").doc(monthlyBulkJobId);
  }

  sessionStatusViewDoc(orgId, feeSessionId) {
    return this.doc(feeSessionPath(orgId, feeSessionId))
      .collection("views")
      .doc("status");
  }

  async writeSessionPatch(orgId, feeSessionId, current, updated) {
    const patch = changedTopLevelFields(current, updated);
    if (!Object.keys(patch).length) {
      return;
    }
    await this.doc(feeSessionPath(orgId, feeSessionId)).update(sanitizeForFirestore(patch));
  }

  async writeSessionStatusView(orgId, feeSessionId, session) {
    await this.sessionStatusViewDoc(orgId, feeSessionId).set(sanitizeForFirestore(sessionStatusView(session)));
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export async function createFirestoreDb(options = {}) {
  const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  const projectId = options.projectId
    || process.env.FEE_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "halunasu-fee-stg";
  const app = getApps().find((candidate) => candidate.name === "halunasu-fee-api")
    || initializeApp({ projectId }, "halunasu-fee-api");

  return getFirestore(app);
}

function docsFromSnapshot(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function sanitizeForFirestore(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, sanitizeForFirestore(item)])
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function countQuery(query) {
  if (typeof query.count === "function") {
    const snapshot = await query.count().get();
    return Number(snapshot.data().count || 0);
  }

  const snapshot = await query.select("feeSessionId").get();
  return snapshot.size;
}

function docDataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}

function sessionStatusView(session = {}) {
  return {
    feeSessionId: session.feeSessionId || session.sessionId || "",
    sessionId: session.sessionId || session.feeSessionId || "",
    status: session.status || "draft",
    calculationProgress: session.calculationProgress || null,
    calculationSummary: session.calculationSummary || null,
    latestCalculationId: session.latestCalculationId || null,
    activeCalculationJobId: session.activeCalculationJobId || null,
    updatedAt: session.updatedAt || null
  };
}

function changedTopLevelFields(current = {}, updated = {}) {
  const patch = {};
  const keys = new Set([
    ...Object.keys(current || {}),
    ...Object.keys(updated || {})
  ]);
  for (const key of keys) {
    if (JSON.stringify(current?.[key]) !== JSON.stringify(updated?.[key])) {
      patch[key] = updated?.[key] ?? null;
    }
  }
  return patch;
}
