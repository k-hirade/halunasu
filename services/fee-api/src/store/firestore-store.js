import {
  applyMockCalculation,
  buildFeeSession,
  createId
} from "../../../../packages/fee-core/src/index.js";
import {
  collections,
  feeSessionPath,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import { notFoundError } from "./memory-store.js";

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

  async listSessions(orgId) {
    const snapshot = await this.orgCollection(orgId, collections.feeSessions).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getSession(orgId, feeSessionId) {
    return docDataOrNull(await this.doc(feeSessionPath(orgId, feeSessionId)).get());
  }

  async createMockCalculation(orgId, feeSessionId, input) {
    const current = await this.getSession(orgId, feeSessionId);
    if (!current) {
      throw notFoundError("fee session not found");
    }

    const updated = applyMockCalculation(current, input, {
      calculationId: this.idFactory("calc"),
      now: this.timestamp()
    });
    await this.doc(feeSessionPath(orgId, feeSessionId)).set(updated);

    return {
      feeSession: updated,
      calculationResult: updated.calculationResult
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

function docDataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}
