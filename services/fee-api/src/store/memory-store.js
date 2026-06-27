import {
  applyReviewDecision,
  applyCalculationResult,
  applyFeeSessionPatch,
  buildReceiptDraft,
  buildReviewItems,
  buildFeeSession,
  createId
} from "../../../../packages/fee-core/src/index.js";

export class MemoryFeeStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.sessionsByOrg = new Map();
    this.calculationJobsByOrg = new Map();
    this.monthlyBulkJobsByOrg = new Map();
    this.feeSettingsByOrg = new Map();
    this.billingHistoryByOrg = new Map();
  }

  createSession(input) {
    const session = buildFeeSession(input, {
      feeSessionId: this.idFactory("fee"),
      now: this.timestamp()
    });

    this.sessionsForOrg(session.orgId).set(session.feeSessionId, session);
    return session;
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

  updateSession(orgId, feeSessionId, patch) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = applyFeeSessionPatch(current, patch, {
      now: this.timestamp()
    });
    this.sessionsForOrg(orgId).set(feeSessionId, updated);

    return {
      feeSession: updated
    };
  }

  saveCalculation(orgId, feeSessionId, calculationResult) {
    const current = this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = applyCalculationResult(current, calculationResult, {
      calculationId: this.idFactory("calc"),
      now: this.timestamp()
    });
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

    const updated = applyReviewDecision(current, reviewItemId, input, {
      now: this.timestamp()
    });
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
    this.calculationJobsForOrg(orgId).set(calculationJobKey(feeSessionId, calculationJobId), job);
    return { calculationJob: job };
  }

  getCalculationJob(orgId, feeSessionId, calculationJobId) {
    return this.calculationJobsForOrg(orgId).get(calculationJobKey(feeSessionId, calculationJobId)) || null;
  }

  updateCalculationJob(orgId, feeSessionId, calculationJobId, patch = {}) {
    const current = this.getCalculationJob(orgId, feeSessionId, calculationJobId);
    if (!current) {
      throw notFoundError("fee calculation job not found");
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

  calculationJobsForOrg(orgId) {
    if (!this.calculationJobsByOrg.has(orgId)) {
      this.calculationJobsByOrg.set(orgId, new Map());
    }

    return this.calculationJobsByOrg.get(orgId);
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

function sessionStatusView(session = {}, activeJob = null) {
  return {
    feeSessionId: session.feeSessionId || session.sessionId || "",
    sessionId: session.sessionId || session.feeSessionId || "",
    status: session.status || "draft",
    calculationProgress: activeJob?.progress || session.calculationProgress || null,
    calculationSummary: session.calculationSummary || null,
    latestCalculationId: session.latestCalculationId || null,
    activeCalculationJobId: session.activeCalculationJobId || null,
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
