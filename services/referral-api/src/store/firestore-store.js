import {
  addReferralAttachment,
  addReferralImport,
  addReplyLetter,
  attachReferralDocument,
  buildDraftSuggestion,
  buildReferralDraft,
  buildReferralReviewChecklist,
  buildReferralTemplate,
  buildRecipientDirectoryEntry,
  createId,
  finalizeReferral,
  patchReferralDraft,
  patchReferralTemplate,
  patchRecipientDirectoryEntry,
  updateFeeLinkage
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

  async createReferralDocument(orgId, referralId, input) {
    const current = await this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = attachReferralDocument(current, input, {
      documentArtifactId: this.idFactory("doc"),
      now: this.timestamp()
    });
    await this.doc(referralPath(orgId, referralId)).set(updated);

    return {
      referral: updated,
      documentArtifact: updated.documentArtifact
    };
  }

  async listRecipientDirectory(orgId) {
    const snapshot = await this.orgCollection(orgId, "recipient_directory").orderBy("updatedAt", "desc").get();
    return docsFromSnapshot(snapshot);
  }

  async upsertRecipientDirectory(orgId, input) {
    const recipientId = input.recipientId || this.idFactory("rcp");
    const ref = this.orgCollection(orgId, "recipient_directory").doc(recipientId);
    const current = docDataOrNull(await ref.get());
    const entry = current
      ? patchRecipientDirectoryEntry(current, input, { now: this.timestamp() })
      : buildRecipientDirectoryEntry(input, {
        recipientId,
        now: this.timestamp()
      });
    await ref.set(entry);
    return entry;
  }

  async getRecipientDirectoryEntry(orgId, recipientId) {
    return docDataOrNull(await this.orgCollection(orgId, "recipient_directory").doc(recipientId).get());
  }

  async listReferralTemplates(orgId) {
    const snapshot = await this.orgCollection(orgId, "referral_templates").orderBy("updatedAt", "desc").get();
    return docsFromSnapshot(snapshot);
  }

  async upsertReferralTemplate(orgId, input) {
    const templateId = input.templateId || this.idFactory("tpl");
    const ref = this.orgCollection(orgId, "referral_templates").doc(templateId);
    const current = docDataOrNull(await ref.get());
    const entry = current
      ? patchReferralTemplate(current, input, { now: this.timestamp() })
      : buildReferralTemplate(input, {
        templateId,
        now: this.timestamp()
      });
    await ref.set(entry);
    return entry;
  }

  async getReferralTemplate(orgId, templateId) {
    return docDataOrNull(await this.orgCollection(orgId, "referral_templates").doc(templateId).get());
  }

  async createReferralImport(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReferralImport(current, input, {
      importId: this.idFactory("imp"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  async addReferralAttachment(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReferralAttachment(current, input, {
      attachmentId: this.idFactory("att"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  async addReplyLetter(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReplyLetter(current, input, {
      replyId: this.idFactory("rpl"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  async updateFeeLinkage(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => updateFeeLinkage(current, input, {
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  async validateReferral(orgId, referralId) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => ({
      ...current,
      reviewChecklist: buildReferralReviewChecklist(current),
      updatedAt: this.timestamp()
    }));
  }

  async draftReferralWithAssistant(orgId, referralId, input) {
    const suggestion = buildDraftSuggestion(input);
    const referral = await this.updateReferralWithTransform(orgId, referralId, (current) => patchReferralDraft(current, {
      purpose: current.purpose || suggestion.purpose,
      clinicalSummary: current.clinicalSummary || suggestion.clinicalSummary,
      diagnoses: current.diagnoses?.length ? current.diagnoses : suggestion.diagnoses,
      medications: current.medications?.length ? current.medications : suggestion.medications,
      allergies: current.allergies?.length ? current.allergies : suggestion.allergies,
      requestedAction: current.requestedAction || suggestion.requestedAction
    }, {
      now: this.timestamp()
    }));

    return { referral, suggestion };
  }

  async finalizeReferral(orgId, referralId, input = {}, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => finalizeReferral(current, input, {
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  async updateReferralWithTransform(orgId, referralId, transform) {
    const current = await this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }
    const updated = transform(current);
    await this.doc(referralPath(orgId, referralId)).set(updated);
    return updated;
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
    || process.env.REFERRAL_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "halunasu-referral-stg";
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
