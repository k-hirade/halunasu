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

export class MemoryFeeStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.sessionsByOrg = new Map();
    this.calculationJobsByOrg = new Map();
    this.monthlyBulkJobsByOrg = new Map();
    this.feeSettingsByOrg = new Map();
    this.billingHistoryByOrg = new Map();
    this.sidecarDraftsByOrg = new Map();
  }

  createSession(input) {
    const session = buildFeeSession(input, {
      feeSessionId: this.idFactory("fee"),
      now: this.timestamp()
    });

    this.sessionsForOrg(session.orgId).set(session.feeSessionId, session);
    return session;
  }

  upsertSidecarCalculationDraft(input) {
    const drafts = this.sidecarDraftsForOrg(input.orgId);
    const current = drafts.get(input.sidecarDraftId) || null;
    const draft = current
      ? applySidecarDraftInput(current, input, { now: this.timestamp() })
      : buildSidecarCalculationDraft(input, { now: this.timestamp() });
    drafts.set(draft.sidecarDraftId, draft);
    return { sidecarDraft: draft, created: !current };
  }

  getSidecarCalculationDraft(orgId, sidecarDraftId) {
    return this.sidecarDraftsForOrg(orgId).get(sidecarDraftId) || null;
  }

  listSidecarCalculationDrafts(orgId, options = {}) {
    const normalized = normalizeSidecarDraftListOptions(options);
    const filtered = [...this.sidecarDraftsForOrg(orgId).values()]
      .filter((draft) => normalized.lifecycleStatus === "all"
        || draft.lifecycleStatus === normalized.lifecycleStatus)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const totalCount = filtered.length;
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / normalized.pageSize) : 0;
    const page = totalPages > 0 ? Math.min(normalized.page, totalPages) : 1;
    const offset = (page - 1) * normalized.pageSize;
    return {
      sidecarDrafts: filtered.slice(offset, offset + normalized.pageSize),
      page,
      pageSize: normalized.pageSize,
      totalCount,
      totalPages
    };
  }

  updateSidecarCalculationDraft(orgId, sidecarDraftId, patch) {
    const current = this.getSidecarCalculationDraft(orgId, sidecarDraftId);
    if (!current) {
      throw notFoundError("sidecar calculation draft not found");
    }
    if (current.lifecycleStatus !== "draft") {
      throw conflictError("adopted sidecar draft cannot be updated");
    }
    const updated = applyFeeSessionPatch(current, patch, { now: this.timestamp() });
    this.sidecarDraftsForOrg(orgId).set(sidecarDraftId, updated);
    return { feeSession: updated, sidecarDraft: updated };
  }

  saveSidecarCalculation(orgId, sidecarDraftId, calculationResult) {
    const current = this.getSidecarCalculationDraft(orgId, sidecarDraftId);
    if (!current) {
      throw notFoundError("sidecar calculation draft not found");
    }
    const updated = applySidecarCalculationResult(current, calculationResult, {
      calculationId: this.idFactory("sidecar_calc"),
      now: this.timestamp()
    });
    this.sidecarDraftsForOrg(orgId).set(sidecarDraftId, updated);
    return {
      feeSession: updated,
      sidecarDraft: updated,
      calculationResult: updated.calculationResult
    };
  }

  listPriorSidecarDraftsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const excludeFeeSessionId = String(options.excludeFeeSessionId || "").trim();
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 10));
    return [...this.sidecarDraftsForOrg(orgId).values()]
      .filter((draft) => ["draft", "adopted"].includes(draft.lifecycleStatus))
      .filter((draft) => draft.patientId === normalizedPatientId)
      .filter((draft) => !excludeFeeSessionId || draft.sidecarDraftId !== excludeFeeSessionId)
      .filter((draft) => !beforeServiceDate || (includeSameServiceDate
        ? String(draft.serviceDate || "") <= beforeServiceDate
        : String(draft.serviceDate || "") < beforeServiceDate))
      .filter((draft) => !sinceServiceDate || String(draft.serviceDate || "") >= sinceServiceDate)
      .sort((left, right) => String(right.serviceDate || "").localeCompare(String(left.serviceDate || "")))
      .slice(0, limit);
  }

  adoptSidecarCalculationDraft(orgId, sidecarDraftId, sessionInput) {
    const current = this.getSidecarCalculationDraft(orgId, sidecarDraftId);
    if (!current) {
      throw notFoundError("sidecar calculation draft not found");
    }
    if (current.adoptedFeeSessionId) {
      return {
        sidecarDraft: current,
        feeSession: this.getSession(orgId, current.adoptedFeeSessionId),
        alreadyAdopted: true
      };
    }
    const feeSession = buildFeeSession(sessionInput, {
      feeSessionId: this.idFactory("fee"),
      now: this.timestamp()
    });
    const adopted = markSidecarDraftAdopted(current, feeSession.feeSessionId, { now: this.timestamp() });
    this.sessionsForOrg(orgId).set(feeSession.feeSessionId, feeSession);
    this.sidecarDraftsForOrg(orgId).set(sidecarDraftId, adopted);
    return { sidecarDraft: adopted, feeSession, alreadyAdopted: false };
  }

  listSessions(orgId, options) {
    const sessions = sortByCreatedAtDesc([...this.sessionsForOrg(orgId).values()]);
    if (options === undefined) {
      return sortByCreatedAt([...sessions]);
    }

    const listOptions = normalizeListOptions(options);
    const filtered = sessions
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
      totalPages
    };
  }

  listSessionsForClaimMonth(orgId, claimMonth, options = {}) {
    const month = String(claimMonth || "").trim().slice(0, 7);
    if (!month) {
      return [];
    }
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || 5000);
    const patientFilter = monthlyPatientFilter(options);
    return sortByCreatedAt([...this.sessionsForOrg(orgId).values()])
      .filter((session) => sessionClaimMonth(session) === month)
      .filter((session) => (
        patientFilter === null || patientFilter.has(String(session.patientId || "").trim())
      ))
      .slice(0, limit);
  }

  listPriorSessionsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    if (!normalizedPatientId) {
      return [];
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const excludeFeeSessionId = String(options.excludeFeeSessionId || "").trim();
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 10));

    return [...this.sessionsForOrg(orgId).values()]
      .filter((session) => String(session.patientId || "").trim() === normalizedPatientId)
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

  getSession(orgId, feeSessionId) {
    return this.sessionsForOrg(orgId).get(feeSessionId) || null;
  }

  getSessionStatus(orgId, feeSessionId) {
    const session = this.getSession(orgId, feeSessionId);
    if (!session) {
      return null;
    }
    const activeCalculationJobId = session.activeCalculationJobId || null;
    const activeJob = activeCalculationJobId
      ? this.getCalculationJob(orgId, feeSessionId, activeCalculationJobId)
      : null;
    return sessionStatusView(session, activeJob);
  }

  updateSession(orgId, feeSessionId, patch, options = {}) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    this.assertSessionMutationAllowed(orgId, feeSessionId, current, options);

    const updated = preserveLatestCalculationJobReservation(current, applyFeeSessionPatch(current, patch, {
      now: this.timestamp()
    }), options);
    this.sessionsForOrg(orgId).set(feeSessionId, updated);

    return {
      feeSession: updated
    };
  }

  saveCalculation(orgId, feeSessionId, calculationResult, options = {}) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    this.assertSessionMutationAllowed(orgId, feeSessionId, current, options);

    const updated = preserveLatestCalculationJobReservation(current, applyCalculationResult(current, calculationResult, {
      calculationId: this.idFactory("calc"),
      now: this.timestamp()
    }), options);
    this.sessionsForOrg(orgId).set(feeSessionId, updated);

    return {
      feeSession: updated,
      calculationResult: updated.calculationResult
    };
  }

  getReceiptDraft(orgId, feeSessionId) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    return buildReceiptDraft(current, {
      now: this.timestamp()
    });
  }

  listReviewItems(orgId, feeSessionId) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    return buildReviewItems(current);
  }

  decideReviewItem(orgId, feeSessionId, reviewItemId, input) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    assertNoActiveSessionCalculation(current);

    const updated = applyReviewDecision(current, reviewItemId, input, {
      now: this.timestamp()
    });
    this.sessionsForOrg(orgId).set(feeSessionId, updated);

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  decideReviewItems(orgId, feeSessionId, decisions = []) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    assertNoActiveSessionCalculation(current);

    const now = this.timestamp();
    let updated = current;
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      updated = applyReviewDecision(updated, decision.reviewItemId, decision, {
        now
      });
    }
    this.sessionsForOrg(orgId).set(feeSessionId, updated);

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  createCalculationJob(orgId, feeSessionId, input = {}) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }
    assertNoActiveSessionCalculation(current);
    const now = this.timestamp();
    const calculationJobId = this.idFactory("fee_calc_job");
    const job = {
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
    };
    const updatedSession = applyFeeSessionPatch(current, {
      status: "calculating",
      activeCalculationJobId: calculationJobId,
      latestCalculationJobId: calculationJobId,
      ...(input.calculationProgress ? { calculationProgress: input.calculationProgress } : {})
    }, { now });
    this.calculationJobsForOrg(orgId).set(calculationJobKey(feeSessionId, calculationJobId), job);
    this.sessionsForOrg(orgId).set(feeSessionId, updatedSession);
    return { calculationJob: job, feeSession: updatedSession };
  }

  getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return this.calculationJobsForOrg(orgId).get(calculationJobKey(feeSessionId, calculationJobId)) || null;
  }

  claimCalculationJob(orgId, feeSessionId, calculationJobId, input = {}) {
    const current = this.getCalculationJob(orgId, feeSessionId, calculationJobId);
    if (!current) {
      throw notFoundError("fee calculation job not found");
    }
    const now = timestampValue(input.now, this.timestamp());
    const leaseToken = String(input.leaseToken || "").trim();
    const leaseExpiresAt = timestampValue(input.leaseExpiresAt, now);
    if (!leaseToken) {
      throw new TypeError("leaseToken is required");
    }
    if (current.status === "succeeded") {
      return { calculationJob: current, claimed: false, alreadyCompleted: true };
    }
    const session = this.getSession(orgId, feeSessionId);
    if (!session) {
      throw notFoundError("fee session not found");
    }
    assertCalculationJobCanClaimSession(session, calculationJobId);
    if (current.status === "running" && isActiveLease(current, now)) {
      return { calculationJob: current, claimed: false, alreadyRunning: true };
    }

    const updated = {
      ...current,
      status: "running",
      phase: input.phase || "extract",
      attemptCount: Number(current.attemptCount || 0) + 1,
      startedAt: current.startedAt || now,
      lastAttemptAt: now,
      leaseToken,
      leaseExpiresAt,
      updatedAt: now
    };
    this.calculationJobsForOrg(orgId).set(calculationJobKey(feeSessionId, calculationJobId), updated);
    const updatedSession = applyFeeSessionPatch(session, {
      status: "calculating",
      activeCalculationJobId: calculationJobId
    }, { now });
    this.sessionsForOrg(orgId).set(feeSessionId, updatedSession);
    return { calculationJob: updated, feeSession: updatedSession, claimed: true };
  }

  updateCalculationJob(orgId, feeSessionId, calculationJobId, patch = {}, options = {}) {
    const current = this.getCalculationJob(orgId, feeSessionId, calculationJobId);
    if (!current) {
      throw notFoundError("fee calculation job not found");
    }
    assertCalculationJobExpectedState(current, options);
    if (Object.hasOwn(options || {}, "expectedLeaseToken")) {
      assertActiveCalculationJobLease(current, options.expectedLeaseToken, this.timestamp());
    }
    const updated = {
      ...current,
      ...patch,
      updatedAt: this.timestamp()
    };
    this.calculationJobsForOrg(orgId).set(calculationJobKey(feeSessionId, calculationJobId), updated);
    return { calculationJob: updated };
  }

  createMonthlyBulkJob(orgId, input = {}) {
    const now = this.timestamp();
    const monthlyBulkJobId = this.idFactory("fee_monthly_bulk_job");
    const job = {
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
    };
    this.monthlyBulkJobsForOrg(orgId).set(monthlyBulkJobId, job);
    return { monthlyBulkJob: job };
  }

  getMonthlyBulkJob(orgId, monthlyBulkJobId) {
    return this.monthlyBulkJobsForOrg(orgId).get(monthlyBulkJobId) || null;
  }

  updateMonthlyBulkJob(orgId, monthlyBulkJobId, patch = {}) {
    const current = this.getMonthlyBulkJob(orgId, monthlyBulkJobId);
    if (!current) {
      throw notFoundError("monthly bulk job not found");
    }
    const updated = {
      ...current,
      ...patch,
      progress: patch.progress || monthlyBulkJobProgress(patch.items || current.items || []),
      updatedAt: this.timestamp()
    };
    this.monthlyBulkJobsForOrg(orgId).set(monthlyBulkJobId, updated);
    return { monthlyBulkJob: updated };
  }

  getFeeSettings(orgId, facilityId = "default") {
    return this.feeSettingsForOrg(orgId).get(facilityId || "default") || null;
  }

  updateFeeSettings(orgId, facilityId = "default", settings = {}) {
    const now = this.timestamp();
    const key = facilityId || "default";
    const current = this.getFeeSettings(orgId, key) || {};
    const updated = {
      ...current,
      ...settings,
      orgId,
      facilityId: key,
      schemaVersion: 1,
      createdAt: current.createdAt || now,
      updatedAt: now
    };
    this.feeSettingsForOrg(orgId).set(key, updated);
    return updated;
  }

  createBillingHistoryEvent(orgId, input = {}) {
    const now = this.timestamp();
    const historyEventId = this.idFactory("fee_hist");
    const event = {
      historyEventId,
      orgId,
      ...input,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };
    this.billingHistoryForOrg(orgId).set(historyEventId, event);
    return event;
  }

  listBillingHistoryEventsForPatient(orgId, patientId, options = {}) {
    const normalizedPatientId = String(patientId || "").trim();
    if (!normalizedPatientId) {
      return [];
    }
    const beforeServiceDate = String(options.beforeServiceDate || "").trim();
    const sinceServiceDate = String(options.sinceServiceDate || "").trim();
    const includeSameServiceDate = options.includeSameServiceDate === true;
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 100));
    return [...this.billingHistoryForOrg(orgId).values()]
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

  sessionsForOrg(orgId) {
    if (!this.sessionsByOrg.has(orgId)) {
      this.sessionsByOrg.set(orgId, new Map());
    }

    return this.sessionsByOrg.get(orgId);
  }

  sidecarDraftsForOrg(orgId) {
    if (!this.sidecarDraftsByOrg.has(orgId)) {
      this.sidecarDraftsByOrg.set(orgId, new Map());
    }
    return this.sidecarDraftsByOrg.get(orgId);
  }

  calculationJobsForOrg(orgId) {
    if (!this.calculationJobsByOrg.has(orgId)) {
      this.calculationJobsByOrg.set(orgId, new Map());
    }

    return this.calculationJobsByOrg.get(orgId);
  }

  assertSessionMutationAllowed(orgId, feeSessionId, session, options = {}) {
    if (Object.hasOwn(options || {}, "expectedCalculationJobStatus")) {
      const calculationJobId = String(options.calculationJobId || "").trim();
      if (!calculationJobId) {
        throw new TypeError("calculationJobId is required with expectedCalculationJobStatus");
      }
      assertCalculationJobExpectedState(
        this.getCalculationJob(orgId, feeSessionId, calculationJobId),
        { expectedStatus: options.expectedCalculationJobStatus }
      );
    }
    if (!Object.hasOwn(options || {}, "expectedLeaseToken")) {
      assertUnleasedSessionMutationAllowed(session, options);
      return;
    }
    const calculationJobId = String(options.calculationJobId || "").trim();
    if (!calculationJobId) {
      throw new TypeError("calculationJobId is required with expectedLeaseToken");
    }
    const job = this.getCalculationJob(orgId, feeSessionId, calculationJobId);
    assertActiveCalculationJobLease(job, options.expectedLeaseToken, this.timestamp());
    const activeCalculationJobId = String(session.activeCalculationJobId || "").trim();
    const latestCalculationJobId = String(session.latestCalculationJobId || "").trim();
    if (
      (latestCalculationJobId && latestCalculationJobId !== calculationJobId)
      || (!latestCalculationJobId && activeCalculationJobId !== calculationJobId)
    ) {
      throw calculationJobLeaseConflictError();
    }
    if (
      activeCalculationJobId !== calculationJobId
      && !(options.allowClearedActiveCalculationJob === true && !activeCalculationJobId)
    ) {
      throw calculationJobLeaseConflictError();
    }
  }

  monthlyBulkJobsForOrg(orgId) {
    if (!this.monthlyBulkJobsByOrg.has(orgId)) {
      this.monthlyBulkJobsByOrg.set(orgId, new Map());
    }

    return this.monthlyBulkJobsByOrg.get(orgId);
  }

  feeSettingsForOrg(orgId) {
    if (!this.feeSettingsByOrg.has(orgId)) {
      this.feeSettingsByOrg.set(orgId, new Map());
    }

    return this.feeSettingsByOrg.get(orgId);
  }

  billingHistoryForOrg(orgId) {
    if (!this.billingHistoryByOrg.has(orgId)) {
      this.billingHistoryByOrg.set(orgId, new Map());
    }

    return this.billingHistoryByOrg.get(orgId);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export function monthlyBulkJobProgress(items = []) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item.status || "pending");
    counts[status] = Number(counts[status] || 0) + 1;
  }
  const totalCount = Array.isArray(items) ? items.length : 0;
  const processedCount = ["queued", "succeeded", "failed", "skipped", "canceled"].reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  return {
    totalCount,
    processedCount,
    pendingCount: Number(counts.pending || 0),
    queuedCount: Number(counts.queued || 0),
    succeededCount: Number(counts.succeeded || 0),
    failedCount: Number(counts.failed || 0),
    skippedCount: Number(counts.skipped || 0),
    canceledCount: Number(counts.canceled || 0),
    percent: totalCount ? Math.round((processedCount / totalCount) * 100) : 100
  };
}

function calculationJobKey(feeSessionId, calculationJobId) {
  return `${feeSessionId}::${calculationJobId}`;
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

function preserveLatestCalculationJobReservation(current = {}, updated = {}, options = {}) {
  if (!Object.hasOwn(options || {}, "expectedLeaseToken")) {
    return updated;
  }
  return {
    ...updated,
    latestCalculationJobId: current.latestCalculationJobId || null
  };
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

function sessionStatusView(session = {}, activeJob = null) {
  return {
    feeSessionId: session.feeSessionId || session.sessionId || "",
    sessionId: session.sessionId || session.feeSessionId || "",
    status: session.status || "draft",
    calculationProgress: activeJob?.progress || session.calculationProgress || null,
    calculationSummary: session.calculationSummary || null,
    latestCalculationId: session.latestCalculationId || null,
    activeCalculationJobId: session.activeCalculationJobId || null,
    latestCalculationJobId: session.latestCalculationJobId || null,
    updatedAt: session.updatedAt || null
  };
}

export function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

function sortByCreatedAt(items) {
  return items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function sortByCreatedAtDesc(items) {
  return items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function sessionClaimMonth(session = {}) {
  const raw = String(session.claimMonth || (session.serviceDate ? String(session.serviceDate).slice(0, 7) : "") || "").trim();
  return raw ? raw.slice(0, 7) : "";
}

function monthlyPatientFilter(options = {}) {
  const patientId = String(options.patientId || "").trim();
  if (patientId) {
    return new Set([patientId]);
  }
  const patientIds = [...new Set(
    (Array.isArray(options.patientIds) ? options.patientIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!patientIds.length || patientIds.length > 100) {
    return null;
  }
  return new Set(patientIds);
}

export function normalizeListOptions(options = {}) {
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(options.pageSize, 10) || 20));
  const statuses = Array.isArray(options.statuses)
    ? options.statuses.map((status) => String(status || "").trim()).filter(Boolean)
    : [];

  return {
    page,
    pageSize,
    search: normalizeSearch(options.search || ""),
    statuses
  };
}

export function normalizeSidecarDraftListOptions(options = {}) {
  const lifecycleStatus = ["draft", "adopted", "all"].includes(options.lifecycleStatus)
    ? options.lifecycleStatus
    : "draft";
  return {
    page: Math.max(1, Number.parseInt(options.page, 10) || 1),
    pageSize: Math.min(50, Math.max(1, Number.parseInt(options.pageSize, 10) || 20)),
    lifecycleStatus
  };
}

export function toSessionSummary(session = {}) {
  return {
    feeSessionId: session.feeSessionId,
    sessionId: session.sessionId || session.feeSessionId,
    orgId: session.orgId,
    patientId: session.patientId,
    patientRef: session.patientRef,
    patientSnapshot: session.patientSnapshot || null,
    facilityId: session.facilityId,
    facilitySnapshot: session.facilitySnapshot || null,
    departmentId: session.departmentId || null,
    departmentSnapshot: session.departmentSnapshot || null,
    createdByMemberId: session.createdByMemberId,
    status: session.status,
    serviceDate: session.serviceDate,
    claimMonth: session.claimMonth,
    setting: session.setting,
    sourceSystem: session.sourceSystem || null,
    latestCalculationId: session.latestCalculationId || null,
    latestCalculationJobId: session.latestCalculationJobId || null,
    calculationSummary: session.calculationSummary || summarizeCalculationResult(session.calculationResult),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    schemaVersion: session.schemaVersion
  };
}

export function matchesStatus(session = {}, statuses = []) {
  return !statuses.length || statuses.includes(String(session.status || ""));
}

export function matchesSearch(session = {}, search = "") {
  if (!search) {
    return true;
  }
  const haystack = normalizeSearch([
    session.feeSessionId,
    session.sessionId,
    session.patientId,
    session.patientRef,
    session.patientSnapshot?.displayName,
    session.patientSnapshot?.displayNameKana,
    ...(Array.isArray(session.patientSnapshot?.externalPatientIds) ? session.patientSnapshot.externalPatientIds : []),
    session.facilitySnapshot?.displayName,
    session.departmentSnapshot?.displayName,
    session.serviceDate,
    session.claimMonth,
    session.status
  ].join(" "));

  return haystack.includes(search);
}

function summarizeCalculationResult(calculation = null) {
  if (!calculation) {
    return null;
  }
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const coverage = calculation.coverage || {};
  return {
    calculationId: calculation.calculationId || null,
    provider: calculation.provider || null,
    status: calculation.status || null,
    engineStatus: calculation.engineStatus || calculation.engine_status || null,
    totalPoints: Number(calculation.totalPoints || 0),
    lineCount: Number(coverage.lineCount ?? coverage.line_count ?? lineItems.length),
    reviewLineCount: Number(
      coverage.reviewLineCount
      ?? coverage.review_line_count
      ?? lineItems.filter((line) => line.reviewRequired === true).length
    ),
    supportLevel: coverage.supportLevel || coverage.support_level || null,
    reviewRequired: coverage.reviewRequired ?? coverage.review_required ?? false,
    generatedAt: calculation.generatedAt || null
  };
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}
