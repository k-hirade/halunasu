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
  applySidecarCalculationResult,
  applySidecarDraftInput,
  buildSidecarCalculationDraft,
  markSidecarDraftAdopted
} from "../../../../packages/fee-core/src/sidecar-drafts.js";
import {
  collections,
  feeBillingHistoryPath,
  feeExtractionSnapshotPath,
  feeMonthlyExclusionResolutionPath,
  feeStandingBillingProfilePath,
  feeSettingsPath,
  feeSessionPath,
  sidecarCalculationDraftPath,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import {
  applyStandingBillingEvidence,
  applyStandingBillingManualState,
  applyStandingBillingStatus,
  standingBillingProfileId
} from "../standing-billing-profiles.js";
import {
  matchesSearch,
  matchesStatus,
  monthlyBulkJobProgress,
  normalizeListOptions,
  normalizeSidecarDraftListOptions,
  notFoundError,
  toSessionSummary
} from "./memory-store.js";

const SESSION_SUMMARY_FIELDS = [
  "feeSessionId",
  "sessionId",
  "orgId",
  "patientId",
  "patientRef",
  "canonicalPatientId",
  "canonicalPatientIdSource",
  "patientIdentityAliases",
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
  "externalSourceSystem",
  "externalPatientId",
  "sourceRecordId",
  "latestCalculationId",
  "activeCalculationJobId",
  "latestCalculationJobId",
  "calculationSummary",
  "createdAt",
  "updatedAt",
  "schemaVersion"
];

const PATIENT_HISTORY_FIELDS = [
  ...SESSION_SUMMARY_FIELDS,
  "diagnoses",
  "calculationResult",
  "reviewDecisions",
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

  async upsertSidecarCalculationDraft(input) {
    requireFirestoreTransactions(this.db);
    const draftRef = this.doc(sidecarCalculationDraftPath(input.orgId, input.sidecarDraftId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(draftRef));
      const sidecarDraft = sanitizeForFirestore(withSidecarPurgeTimestamp(current
        ? applySidecarDraftInput(current, input, { now: this.timestamp() })
        : buildSidecarCalculationDraft(input, { now: this.timestamp() })));
      transaction.set(draftRef, sidecarDraft);
      return { sidecarDraft, created: !current };
    });
  }

  async getSidecarCalculationDraft(orgId, sidecarDraftId) {
    return docDataOrNull(await this.doc(sidecarCalculationDraftPath(orgId, sidecarDraftId)).get());
  }

  async listSidecarCalculationDrafts(orgId, options = {}) {
    const normalized = normalizeSidecarDraftListOptions(options);
    let query = this.orgCollection(orgId, collections.sidecarCalculationDrafts);
    if (normalized.lifecycleStatus !== "all") {
      query = query.where("lifecycleStatus", "==", normalized.lifecycleStatus);
    }
    query = query.orderBy("updatedAt", "desc");
    const totalCount = await countQuery(query, "sidecarDraftId");
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / normalized.pageSize) : 0;
    const page = totalPages > 0 ? Math.min(normalized.page, totalPages) : 1;
    const snapshot = await query
      .offset((page - 1) * normalized.pageSize)
      .limit(normalized.pageSize)
      .get();
    return {
      sidecarDrafts: docsFromSnapshot(snapshot),
      page,
      pageSize: normalized.pageSize,
      totalCount,
      totalPages
    };
  }

  async updateSidecarCalculationDraft(orgId, sidecarDraftId, patch) {
    const { updated } = await this.mutateSidecarDraft(orgId, sidecarDraftId, (current) => {
      if (current.lifecycleStatus !== "draft") {
        throw conflictError("adopted sidecar draft cannot be updated");
      }
      return applyFeeSessionPatch(current, patch, { now: this.timestamp() });
    });
    return { feeSession: updated, sidecarDraft: updated };
  }

  async saveSidecarCalculation(orgId, sidecarDraftId, calculationResult) {
    const calculationId = this.idFactory("sidecar_calc");
    const { updated } = await this.mutateSidecarDraft(orgId, sidecarDraftId, (current) => (
      applySidecarCalculationResult(current, calculationResult, {
        calculationId,
        now: this.timestamp()
      })
    ));
    return {
      feeSession: updated,
      sidecarDraft: updated,
      calculationResult: updated.calculationResult
    };
  }

  async listPriorSidecarDraftsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    if (!normalizedPatientId) {
      return [];
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const excludeFeeSessionId = String(options.excludeFeeSessionId || "").trim();
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 10));
    let query = this.orgCollection(orgId, collections.sidecarCalculationDrafts)
      .where("patientId", "==", normalizedPatientId)
      .where("lifecycleStatus", "in", ["draft", "adopted"]);
    if (beforeServiceDate) {
      query = query.where("serviceDate", includeSameServiceDate ? "<=" : "<", beforeServiceDate);
    }
    if (sinceServiceDate) {
      query = query.where("serviceDate", ">=", sinceServiceDate);
    }
    const snapshot = await query.orderBy("serviceDate", "desc").limit(limit + 1).get();
    return docsFromSnapshot(snapshot)
      .filter((draft) => !excludeFeeSessionId || draft.sidecarDraftId !== excludeFeeSessionId)
      .slice(0, limit);
  }

  async adoptSidecarCalculationDraft(orgId, sidecarDraftId, sessionInput) {
    requireFirestoreTransactions(this.db);
    const draftRef = this.doc(sidecarCalculationDraftPath(orgId, sidecarDraftId));
    const candidateFeeSessionId = this.idFactory("fee");
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(draftRef));
      if (!current) {
        throw notFoundError("sidecar calculation draft not found");
      }
      if (current.adoptedFeeSessionId) {
        const existing = docDataOrNull(await transaction.get(this.doc(feeSessionPath(orgId, current.adoptedFeeSessionId))));
        return { sidecarDraft: current, feeSession: existing, alreadyAdopted: true };
      }
      const feeSession = sanitizeForFirestore(buildFeeSession(sessionInput, {
        feeSessionId: candidateFeeSessionId,
        now: this.timestamp()
      }));
      const adopted = sanitizeForFirestore(withSidecarPurgeTimestamp(markSidecarDraftAdopted(
        current,
        feeSession.feeSessionId,
        {
          now: this.timestamp(),
          canonicalPatientId: feeSession.canonicalPatientId,
          canonicalPatientIdSource: feeSession.canonicalPatientIdSource,
          patientIdentityAliases: feeSession.patientIdentityAliases
        }
      )));
      const sessionRef = this.doc(feeSessionPath(orgId, feeSession.feeSessionId));
      transaction.set(sessionRef, feeSession);
      transaction.set(this.sessionStatusViewDoc(orgId, feeSession.feeSessionId), sanitizeForFirestore(sessionStatusView(feeSession)));
      transaction.set(draftRef, adopted);
      return { sidecarDraft: adopted, feeSession, alreadyAdopted: false };
    });
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

  async listSessionsForClaimMonth(orgId, claimMonth, options = {}) {
    const month = String(claimMonth || "").trim().slice(0, 7);
    if (!month) {
      return [];
    }
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || 5000);
    const collection = this.orgCollection(orgId, collections.feeSessions);
    const patientFilters = monthlyPatientQueryFilters(options);
    const snapshots = await Promise.all(patientFilters.flatMap((patientFilter) => {
      let claimMonthQuery = collection.where("claimMonth", "==", month);
      let serviceDateQuery = collection
        .where("serviceDate", ">=", `${month}-01`)
        .where("serviceDate", "<", nextClaimMonthStart(month));
      if (patientFilter) {
        claimMonthQuery = claimMonthQuery.where("patientId", patientFilter.operator, patientFilter.value);
        serviceDateQuery = serviceDateQuery.where("patientId", patientFilter.operator, patientFilter.value);
      }
      return [
        claimMonthQuery.limit(limit).get(),
        serviceDateQuery.orderBy("serviceDate", "asc").limit(limit).get()
      ];
    }));
    return mergeMonthlySessionSnapshots(snapshots, month)
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
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
  }

  getHistoryIdentityCompleteness() {
    return "complete";
  }

  async saveExtractionSnapshot(orgId, input = {}) {
    const now = this.timestamp();
    const snapshot = sanitizeForFirestore(withExtractionSnapshotPurgeTimestamp({
      ...input,
      orgId,
      createdAt: input.createdAt || now,
      updatedAt: now
    }));
    await this.doc(feeExtractionSnapshotPath(orgId, snapshot.snapshotId)).set(snapshot);
    return snapshot;
  }

  async getLatestExtractionSnapshotForPatient(orgId, patientIds, options = {}) {
    const normalizedPatientIds = [...new Set((Array.isArray(patientIds) ? patientIds : [patientIds])
      .map((value) => String(value || "").trim())
      .filter(Boolean))].slice(0, 10);
    if (!normalizedPatientIds.length) {
      return null;
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const excludeSourceSessionId = String(options.excludeSourceSessionId || "").trim();
    const snapshots = await Promise.all(normalizedPatientIds.map(async (patientId) => {
      let query = this.orgCollection(orgId, collections.feeExtractionSnapshots)
        .where("canonicalPatientId", "==", patientId);
      if (beforeServiceDate) {
        query = query.where("serviceDate", "<=", beforeServiceDate);
      }
      const result = await query.orderBy("serviceDate", "desc").limit(3).get();
      return docsFromSnapshot(result);
    }));
    return latestExtractionSnapshot(snapshots.flat(), { excludeSourceSessionId });
  }

  async deleteExtractionSnapshotsForSource(orgId, sourceSessionId) {
    const normalizedSourceSessionId = String(sourceSessionId || "").trim();
    if (!normalizedSourceSessionId) {
      return { deletedCount: 0 };
    }
    const snapshot = await this.orgCollection(orgId, collections.feeExtractionSnapshots)
      .where("sourceSessionId", "==", normalizedSourceSessionId)
      .get();
    if (snapshot.empty) {
      return { deletedCount: 0 };
    }
    const batch = this.db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    return { deletedCount: snapshot.size };
  }

  async getStandingBillingProfile(orgId, standingFactId) {
    return docDataOrNull(
      await this.doc(feeStandingBillingProfilePath(orgId, standingFactId)).get()
    );
  }

  async listStandingBillingProfilesForPatient(orgId, facilityId, canonicalPatientId) {
    const normalizedFacilityId = String(facilityId || "").trim();
    const normalizedPatientId = String(canonicalPatientId || "").trim();
    if (!normalizedFacilityId || !normalizedPatientId) {
      return [];
    }
    const snapshot = await this.orgCollection(orgId, collections.feeStandingBillingProfiles)
      .where("facilityId", "==", normalizedFacilityId)
      .where("canonicalPatientId", "==", normalizedPatientId)
      .get();
    return docsFromSnapshot(snapshot)
      .sort((left, right) => String(left.feeFamily || "").localeCompare(String(right.feeFamily || "")));
  }

  async recordStandingBillingEvidence(orgId, input = {}) {
    requireFirestoreTransactions(this.db);
    const standingFactId = standingBillingProfileId({
      orgId,
      facilityId: input.facilityId,
      canonicalPatientId: input.canonicalPatientId,
      feeFamily: input.family?.familyId
    });
    const profileRef = this.doc(feeStandingBillingProfilePath(orgId, standingFactId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(profileRef));
      const updated = sanitizeForFirestore(applyStandingBillingEvidence(current, {
        ...input,
        orgId
      }, { now: this.now() }));
      transaction.set(profileRef, updated);
      return updated;
    });
  }

  async updateStandingBillingProfileStatus(orgId, standingFactId, input = {}) {
    requireFirestoreTransactions(this.db);
    const profileRef = this.doc(feeStandingBillingProfilePath(orgId, standingFactId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(profileRef));
      if (!current) {
        throw notFoundError("standing billing profile not found");
      }
      const updated = sanitizeForFirestore(
        applyStandingBillingStatus(current, input, { now: this.now() })
      );
      transaction.set(profileRef, updated);
      return updated;
    });
  }

  async updateStandingBillingProfileManualState(orgId, standingFactId, input = {}) {
    requireFirestoreTransactions(this.db);
    const profileRef = this.doc(feeStandingBillingProfilePath(orgId, standingFactId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(profileRef));
      if (!current) {
        throw notFoundError("standing billing profile not found");
      }
      const updated = sanitizeForFirestore(
        applyStandingBillingManualState(current, input, { now: this.now() })
      );
      transaction.set(profileRef, updated);
      return updated;
    });
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

  async updateSession(orgId, feeSessionId, patch, options = {}) {
    const now = this.timestamp();
    const { updated } = await this.mutateSession(orgId, feeSessionId, (current) => (
      applyFeeSessionPatch(current, patch, { now })
    ), options);

    return {
      feeSession: updated
    };
  }

  async saveCalculation(orgId, feeSessionId, calculationResult, options = {}) {
    const now = this.timestamp();
    const calculationId = this.idFactory("calc");
    const { updated } = await this.mutateSession(orgId, feeSessionId, (current) => (
      applyCalculationResult(current, calculationResult, { calculationId, now })
    ), options);

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
    const now = this.timestamp();
    const { updated } = await this.mutateSession(orgId, feeSessionId, (current) => (
      applyReviewDecision(current, reviewItemId, input, { now })
    ));

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  async decideReviewItems(orgId, feeSessionId, decisions = []) {
    const now = this.timestamp();
    const normalizedDecisions = Array.isArray(decisions) ? decisions : [];
    const { updated } = await this.mutateSession(orgId, feeSessionId, (current) => {
      let next = current;
      for (const decision of normalizedDecisions) {
        next = applyReviewDecision(next, decision.reviewItemId, decision, { now });
      }
      return next;
    });

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  async createCalculationJob(orgId, feeSessionId, input = {}) {
    requireFirestoreTransactions(this.db);
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
    const sessionRef = this.doc(feeSessionPath(orgId, feeSessionId));
    const jobRef = this.calculationJobDoc(orgId, feeSessionId, calculationJobId);
    const statusRef = this.sessionStatusViewDoc(orgId, feeSessionId);
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(sessionRef));
      if (!current) {
        throw notFoundError("fee session not found");
      }
      assertNoActiveSessionCalculation(current);
      const updatedSession = sanitizeForFirestore(applyFeeSessionPatch(current, {
        status: "calculating",
        activeCalculationJobId: calculationJobId,
        latestCalculationJobId: calculationJobId,
        ...(input.calculationProgress ? { calculationProgress: input.calculationProgress } : {})
      }, { now }));
      const sessionPatch = changedTopLevelFields(current, updatedSession);
      transaction.set(jobRef, job);
      if (Object.keys(sessionPatch).length) {
        transaction.update(sessionRef, sanitizeForFirestore(sessionPatch));
      }
      transaction.set(statusRef, sanitizeForFirestore(sessionStatusView(updatedSession)));
      return { calculationJob: job, feeSession: updatedSession };
    });
  }

  async getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return docDataOrNull(await this.calculationJobDoc(orgId, feeSessionId, calculationJobId).get());
  }

  async claimCalculationJob(orgId, feeSessionId, calculationJobId, input = {}) {
    requireFirestoreTransactions(this.db);
    const now = timestampValue(input.now, this.timestamp());
    const leaseToken = String(input.leaseToken || "").trim();
    const leaseExpiresAt = timestampValue(input.leaseExpiresAt, now);
    if (!leaseToken) {
      throw new TypeError("leaseToken is required");
    }

    const jobRef = this.calculationJobDoc(orgId, feeSessionId, calculationJobId);
    const sessionRef = this.doc(feeSessionPath(orgId, feeSessionId));
    const statusRef = this.sessionStatusViewDoc(orgId, feeSessionId);
    return this.db.runTransaction(async (transaction) => {
      const [jobSnapshot, sessionSnapshot] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(sessionRef)
      ]);
      const current = docDataOrNull(jobSnapshot);
      const session = docDataOrNull(sessionSnapshot);
      if (!current) {
        throw notFoundError("fee calculation job not found");
      }
      if (!session) {
        throw notFoundError("fee session not found");
      }
      if (current.status === "succeeded") {
        return {
          calculationJob: current,
          claimed: false,
          alreadyCompleted: true
        };
      }
      assertCalculationJobCanClaimSession(session, calculationJobId);
      if (current.status === "running" && isActiveLease(current, now)) {
        return {
          calculationJob: current,
          claimed: false,
          alreadyRunning: true
        };
      }

      const calculationJob = sanitizeForFirestore({
        ...current,
        status: "running",
        phase: input.phase || "extract",
        attemptCount: Number(current.attemptCount || 0) + 1,
        startedAt: current.startedAt || now,
        lastAttemptAt: now,
        leaseToken,
        leaseExpiresAt,
        updatedAt: now
      });
      const updatedSession = sanitizeForFirestore(applyFeeSessionPatch(session, {
        status: "calculating",
        activeCalculationJobId: calculationJobId
      }, { now }));
      const sessionPatch = changedTopLevelFields(session, updatedSession);
      transaction.set(jobRef, calculationJob);
      if (Object.keys(sessionPatch).length) {
        transaction.update(sessionRef, sanitizeForFirestore(sessionPatch));
      }
      transaction.set(statusRef, sanitizeForFirestore(sessionStatusView(updatedSession)));
      return {
        calculationJob,
        feeSession: updatedSession,
        claimed: true
      };
    });
  }

  async updateCalculationJob(orgId, feeSessionId, calculationJobId, patch = {}, options = {}) {
    const hasExpectedLeaseToken = Object.hasOwn(options || {}, "expectedLeaseToken");
    const expectedLeaseToken = hasExpectedLeaseToken
      ? String(options.expectedLeaseToken || "")
      : null;
    return this.mutateCalculationJob(orgId, feeSessionId, calculationJobId, (current) => {
      assertCalculationJobExpectedState(current, options);
      if (hasExpectedLeaseToken) {
        assertActiveCalculationJobLease(current, expectedLeaseToken, this.timestamp());
      }
      return {
        calculationJob: {
          ...current,
          ...patch,
          updatedAt: this.timestamp()
        }
      };
    });
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

  async listMonthlyExclusionResolutions(orgId, patientId, claimMonth) {
    const snapshot = await this.orgCollection(orgId, collections.feeMonthlyExclusionResolutions)
      .where("patientId", "==", String(patientId || ""))
      .get();
    return docsFromSnapshot(snapshot)
      .filter((resolution) => resolution.claimMonth === String(claimMonth || ""))
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
  }

  async getMonthlyExclusionResolution(orgId, resolutionId) {
    return docDataOrNull(
      await this.doc(feeMonthlyExclusionResolutionPath(orgId, resolutionId)).get()
    );
  }

  async putMonthlyExclusionResolution(orgId, resolutionId, input = {}, options = {}) {
    requireFirestoreTransactions(this.db);
    const ref = this.doc(feeMonthlyExclusionResolutionPath(orgId, resolutionId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(ref));
      if (!current && input.revoke) {
        throw notFoundError("monthly exclusion resolution not found");
      }
      if (
        current
        && !input.revoke
        && current.action === input.action
        && String(current.basisNote || "") === String(input.basisNote || "")
        && !current.revokedAt
      ) {
        return { previous: current, resolution: current, changed: false };
      }
      if (current?.revokedAt && input.revoke) {
        return { previous: current, resolution: current, changed: false };
      }
      assertMonthlyResolutionVersion(current, options.expectedUpdatedAt);
      const now = this.timestamp();
      const updated = sanitizeForFirestore(input.revoke
        ? {
          ...current,
          revokedAt: current.revokedAt || now,
          revokedByMemberId: input.resolvedByMemberId || null,
          updatedAt: now
        }
        : {
          ...current,
          ...input,
          resolutionId,
          orgId,
          revokedAt: null,
          resolvedAt: now,
          createdAt: current?.createdAt || now,
          updatedAt: now,
          schemaVersion: 1
        });
      transaction.set(ref, updated);
      return { previous: current, resolution: updated, changed: true };
    });
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

  async mutateSession(orgId, feeSessionId, mutator, options = {}) {
    requireFirestoreTransactions(this.db);
    const sessionRef = this.doc(feeSessionPath(orgId, feeSessionId));
    const statusRef = this.sessionStatusViewDoc(orgId, feeSessionId);
    const calculationJobId = String(options.calculationJobId || "").trim();
    const hasExpectedLeaseToken = Object.hasOwn(options || {}, "expectedLeaseToken");
    const hasExpectedCalculationJobStatus = Object.hasOwn(options || {}, "expectedCalculationJobStatus");
    const jobRef = calculationJobId
      ? this.calculationJobDoc(orgId, feeSessionId, calculationJobId)
      : null;
    if (hasExpectedLeaseToken && !jobRef) {
      throw new TypeError("calculationJobId is required with expectedLeaseToken");
    }
    if (hasExpectedCalculationJobStatus && !jobRef) {
      throw new TypeError("calculationJobId is required with expectedCalculationJobStatus");
    }

    return this.db.runTransaction(async (transaction) => {
      const [sessionSnapshot, jobSnapshot] = await Promise.all([
        transaction.get(sessionRef),
        jobRef ? transaction.get(jobRef) : Promise.resolve(null)
      ]);
      const current = docDataOrNull(sessionSnapshot);
      if (!current) {
        throw notFoundError("fee session not found");
      }
      const calculationJob = docDataOrNull(jobSnapshot);
      if (hasExpectedCalculationJobStatus) {
        assertCalculationJobExpectedState(calculationJob, {
          expectedStatus: options.expectedCalculationJobStatus
        });
      }
      if (hasExpectedLeaseToken) {
        assertCalculationSessionLease(current, calculationJob, calculationJobId, options, this.timestamp());
      } else {
        assertUnleasedSessionMutationAllowed(current, options);
      }
      const mutated = mutator(current);
      const updated = sanitizeForFirestore(hasExpectedLeaseToken
        ? {
          ...mutated,
          latestCalculationJobId: current.latestCalculationJobId || null
        }
        : mutated);
      const patch = changedTopLevelFields(current, updated);
      if (Object.keys(patch).length) {
        transaction.update(sessionRef, sanitizeForFirestore(patch));
      }
      transaction.set(statusRef, sanitizeForFirestore(sessionStatusView(updated)));
      return { current, updated };
    });
  }

  async mutateSidecarDraft(orgId, sidecarDraftId, mutator) {
    requireFirestoreTransactions(this.db);
    const draftRef = this.doc(sidecarCalculationDraftPath(orgId, sidecarDraftId));
    return this.db.runTransaction(async (transaction) => {
      const current = docDataOrNull(await transaction.get(draftRef));
      if (!current) {
        throw notFoundError("sidecar calculation draft not found");
      }
      const updated = sanitizeForFirestore(withSidecarPurgeTimestamp(mutator(current)));
      const patch = changedTopLevelFields(current, updated);
      if (Object.keys(patch).length) {
        transaction.update(draftRef, sanitizeForFirestore(patch));
      }
      return { current, updated };
    });
  }

  async mutateCalculationJob(orgId, feeSessionId, calculationJobId, mutator) {
    requireFirestoreTransactions(this.db);
    const jobRef = this.calculationJobDoc(orgId, feeSessionId, calculationJobId);
    const runMutation = async (current, write) => {
      if (!current) {
        throw notFoundError("fee calculation job not found");
      }
      const result = mutator(current);
      const updated = result.calculationJob === current
        ? current
        : sanitizeForFirestore(result.calculationJob);
      if (updated !== current) {
        await write(updated);
      }
      return { ...result, calculationJob: updated };
    };

    return this.db.runTransaction(async (transaction) => (
      runMutation(
        docDataOrNull(await transaction.get(jobRef)),
        (updated) => transaction.set(jobRef, updated)
      )
    ));
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

function mergeMonthlySessionSnapshots(snapshots = [], month = "") {
  const byId = new Map();
  for (const snapshot of snapshots) {
    for (const session of docsFromSnapshot(snapshot)) {
      if (sessionClaimMonth(session) !== month) {
        continue;
      }
      const key = session.feeSessionId || session.sessionId;
      if (!key) {
        continue;
      }
      byId.set(key, session);
    }
  }
  return [...byId.values()];
}

function sessionClaimMonth(session = {}) {
  const raw = String(session.claimMonth || (session.serviceDate ? String(session.serviceDate).slice(0, 7) : "") || "").trim();
  return raw ? raw.slice(0, 7) : "";
}

function nextClaimMonthStart(month = "") {
  const [yearText, monthText] = String(month || "").split("-");
  const year = Number.parseInt(yearText, 10);
  const monthNumber = Number.parseInt(monthText, 10);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return `${month}-32`;
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

function monthlyPatientQueryFilters(options = {}) {
  const patientId = String(options.patientId || "").trim();
  if (patientId) {
    return [{ operator: "==", value: patientId }];
  }
  const patientIds = [...new Set(
    (Array.isArray(options.patientIds) ? options.patientIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!patientIds.length || patientIds.length > 100) {
    return [null];
  }
  const filters = [];
  for (let index = 0; index < patientIds.length; index += 25) {
    filters.push({ operator: "in", value: patientIds.slice(index, index + 25) });
  }
  return filters;
}

function sanitizeForFirestore(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item));
  }
  if (value instanceof Date || isFirestoreTimestamp(value)) {
    return value;
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

function withSidecarPurgeTimestamp(sidecarDraft = {}) {
  const expiresAtMs = Date.parse(String(sidecarDraft.expiresAt || ""));
  if (!Number.isFinite(expiresAtMs)) {
    const error = new Error("sidecar calculation draft requires a valid expiration timestamp");
    error.name = "ConfigurationError";
    error.statusCode = 500;
    throw error;
  }
  return {
    ...sidecarDraft,
    purgeAt: new Date(expiresAtMs)
  };
}

function withExtractionSnapshotPurgeTimestamp(snapshot = {}) {
  const expiresAtMs = Date.parse(String(snapshot.expiresAt || ""));
  if (!Number.isFinite(expiresAtMs)) {
    const error = new Error("fee extraction snapshot requires a valid expiration timestamp");
    error.name = "ConfigurationError";
    error.statusCode = 500;
    throw error;
  }
  return {
    ...snapshot,
    purgeAt: new Date(expiresAtMs)
  };
}

function latestExtractionSnapshot(values = [], { excludeSourceSessionId = "" } = {}) {
  return (Array.isArray(values) ? values : [])
    .filter((snapshot) => !excludeSourceSessionId || snapshot.sourceSessionId !== excludeSourceSessionId)
    .sort((left, right) => (
      String(right.serviceDate || "").localeCompare(String(left.serviceDate || ""))
      || String(right.extractedAt || "").localeCompare(String(left.extractedAt || ""))
    ))[0] || null;
}

function isFirestoreTimestamp(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.toDate === "function"
    && typeof value.toMillis === "function";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampValue(value, fallback) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isActiveLease(job = {}, now) {
  const expiresAt = Date.parse(String(job.leaseExpiresAt || ""));
  const nowMs = Date.parse(String(now || ""));
  return Boolean(job.leaseToken) && Number.isFinite(expiresAt) && Number.isFinite(nowMs) && expiresAt > nowMs;
}

function assertActiveCalculationJobLease(job, expectedLeaseToken, now) {
  if (
    !job
    || job.status !== "running"
    || String(job.leaseToken || "") !== String(expectedLeaseToken || "")
    || !isActiveLease(job, now)
  ) {
    throw calculationJobLeaseConflictError();
  }
}

function assertCalculationJobExpectedState(job, options = {}) {
  if (!job) {
    throw calculationJobStateConflictError();
  }
  if (
    Object.hasOwn(options || {}, "expectedStatus")
    && String(job.status || "") !== String(options.expectedStatus || "")
  ) {
    throw calculationJobStateConflictError();
  }
  if (
    Object.hasOwn(options || {}, "expectedEnqueueStatus")
    && String(job.enqueueStatus || "") !== String(options.expectedEnqueueStatus || "")
  ) {
    throw calculationJobStateConflictError();
  }
}

function assertCalculationSessionLease(session, job, calculationJobId, options, now) {
  assertActiveCalculationJobLease(job, options.expectedLeaseToken, now);
  const activeCalculationJobId = String(session.activeCalculationJobId || "").trim();
  const latestCalculationJobId = String(session.latestCalculationJobId || "").trim();
  if (
    (latestCalculationJobId && latestCalculationJobId !== calculationJobId)
    || (!latestCalculationJobId && activeCalculationJobId !== calculationJobId)
  ) {
    throw calculationJobLeaseConflictError();
  }
  const allowsClearedActiveJob = options.allowClearedActiveCalculationJob === true;
  if (
    activeCalculationJobId !== calculationJobId
    && !(allowsClearedActiveJob && !activeCalculationJobId)
  ) {
    throw calculationJobLeaseConflictError();
  }
}

function assertNoActiveSessionCalculation(session = {}) {
  if (session.activeCalculationJobId || session.status === "calculating") {
    throw feeSessionCalculationConflictError();
  }
}

function assertCalculationJobCanClaimSession(session = {}, calculationJobId) {
  const activeCalculationJobId = String(session.activeCalculationJobId || "").trim();
  const latestCalculationJobId = String(session.latestCalculationJobId || "").trim();
  if (
    (latestCalculationJobId && latestCalculationJobId !== calculationJobId)
    || (!latestCalculationJobId && activeCalculationJobId !== calculationJobId)
  ) {
    throw feeSessionCalculationConflictError("a newer fee calculation job owns this session");
  }
  if (activeCalculationJobId && activeCalculationJobId !== calculationJobId) {
    throw feeSessionCalculationConflictError("another fee calculation job owns this session");
  }
  if (!activeCalculationJobId && session.status === "calculating") {
    throw feeSessionCalculationConflictError();
  }
}

function assertUnleasedSessionMutationAllowed(session = {}, options = {}) {
  const expectedActiveCalculationJobId = String(options.expectedActiveCalculationJobId || "").trim();
  const activeCalculationJobId = String(session.activeCalculationJobId || "").trim();
  if (expectedActiveCalculationJobId) {
    if (activeCalculationJobId !== expectedActiveCalculationJobId) {
      throw feeSessionCalculationConflictError();
    }
    return;
  }
  if (activeCalculationJobId) {
    throw feeSessionCalculationConflictError();
  }
  if (session.status === "calculating" && options.allowCalculatingSessionMutation !== true) {
    throw feeSessionCalculationConflictError();
  }
}

function conflictError(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}

function assertMonthlyResolutionVersion(current, expectedUpdatedAt) {
  const expected = String(expectedUpdatedAt || "");
  if (!current && !expected) {
    return;
  }
  if (!current || !expected || String(current.updatedAt || "") !== expected) {
    throw conflictError("monthly exclusion resolution was updated by another user");
  }
}

function requireFirestoreTransactions(db) {
  if (typeof db?.runTransaction === "function") {
    return;
  }
  const error = new Error("Firestore transactions are required for fee session and calculation job mutations");
  error.name = "ConfigurationError";
  error.statusCode = 500;
  throw error;
}

function calculationJobLeaseConflictError() {
  const error = new Error("fee calculation job lease is no longer owned by this worker");
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "FEE_CALCULATION_JOB_LEASE_CONFLICT";
  return error;
}

function calculationJobStateConflictError() {
  const error = new Error("fee calculation job state changed before the requested update");
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "FEE_CALCULATION_JOB_STATE_CONFLICT";
  return error;
}

function feeSessionCalculationConflictError(message = "fee session calculation is already in progress") {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "FEE_SESSION_CALCULATION_CONFLICT";
  return error;
}

async function countQuery(query, identifierField = "feeSessionId") {
  if (typeof query.count === "function") {
    const snapshot = await query.count().get();
    return Number(snapshot.data().count || 0);
  }

  const snapshot = await query.select(identifierField).get();
  return snapshot.size;
}

function docDataOrNull(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
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
    latestCalculationJobId: session.latestCalculationJobId || null,
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
