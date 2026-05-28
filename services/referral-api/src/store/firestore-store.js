import {
  attachPdfPlaceholder,
  buildReferralDraft,
  createId,
  patchReferralDraft
} from "../../../../packages/referral-core/src/index.js";
import {
  collections,
  organizationPath,
  referralPath
} from "../../../../packages/firestore-schema/src/index.js";
import { notFoundError } from "./memory-store.js";

export class FirestoreReferralStore {
  constructor(options = {}) {
    if (!options.db) {
      throw new TypeError("db is required");
    }

    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
  }

  async createReferral(input) {
    const referral = buildReferralDraft(input, {
      referralId: this.idFactory("ref"),
      now: this.timestamp()
    });

    await this.doc(referralPath(referral.orgId, referral.referralId)).set(referral);
    return referral;
  }

  async listReferrals(orgId) {
    const snapshot = await this.orgCollection(orgId, collections.referrals).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getReferral(orgId, referralId) {
    return docDataOrNull(await this.doc(referralPath(orgId, referralId)).get());
  }

  async updateReferral(orgId, referralId, input) {
    const current = await this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = patchReferralDraft(current, input, {
      now: this.timestamp()
    });
    await this.doc(referralPath(orgId, referralId)).set(updated);
    return updated;
  }

  async createPdfPlaceholder(orgId, referralId, input) {
    const current = await this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = attachPdfPlaceholder(current, input, {
      pdfPlaceholderId: this.idFactory("pdf"),
      now: this.timestamp()
    });
    await this.doc(referralPath(orgId, referralId)).set(updated);

    return {
      referral: updated,
      pdfPlaceholder: updated.pdfPlaceholder
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
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const app = getApps().find((candidate) => candidate.name === "halunasu-referral-api")
    || initializeApp({ projectId }, "halunasu-referral-api");

  return getFirestore(app);
}

function docsFromSnapshot(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function docDataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}
