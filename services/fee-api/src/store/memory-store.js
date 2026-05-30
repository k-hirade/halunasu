import {
  applyReviewDecision,
  applyCalculationResult,
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

  getSession(orgId, feeSessionId) {
    return this.sessionsForOrg(orgId).get(feeSessionId) || null;
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

  sessionsForOrg(orgId) {
    if (!this.sessionsByOrg.has(orgId)) {
      this.sessionsByOrg.set(orgId, new Map());
    }

    return this.sessionsByOrg.get(orgId);
  }

  timestamp() {
    return this.now().toISOString();
  }
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
