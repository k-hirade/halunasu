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
  feeSessionPath,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import {
  matchesSearch,
  matchesStatus,
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
  "calculationSummary",
  "createdAt",
  "updatedAt",
  "schemaVersion"
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
    const session = buildFeeSession(input, {
      feeSessionId: this.idFactory("fee"),
      now: this.timestamp()
    });

    await this.doc(feeSessionPath(session.orgId, session.feeSessionId)).set(session);
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

  async getSession(orgId, feeSessionId) {
    return docDataOrNull(await this.doc(feeSessionPath(orgId, feeSessionId)).get());
  }

  async updateSession(orgId, feeSessionId, patch) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = applyFeeSessionPatch(current, patch, {
      now: this.timestamp()
    });
    await this.doc(feeSessionPath(orgId, feeSessionId)).set(updated);

    return {
      feeSession: updated
    };
  }

  async saveCalculation(orgId, feeSessionId, calculationResult) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = applyCalculationResult(current, calculationResult, {
      calculationId: this.idFactory("calc"),
      now: this.timestamp()
    });
    await this.doc(feeSessionPath(orgId, feeSessionId)).set(updated);

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

    const updated = applyReviewDecision(current, reviewItemId, input, {
      now: this.timestamp()
    });
    await this.doc(feeSessionPath(orgId, feeSessionId)).set(updated);

    return {
      feeSession: updated,
      reviewItems: buildReviewItems(updated)
    };
  }

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, collectionName) {
    return this.doc(organizationPath(orgId)).collection(collectionName);
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
