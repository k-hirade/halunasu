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

  listSessions(orgId) {
    return sortByCreatedAt([...this.sessionsForOrg(orgId).values()]);
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
