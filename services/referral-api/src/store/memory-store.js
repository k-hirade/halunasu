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

export class MemoryReferralStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.referralsByOrg = new Map();
    this.recipientsByOrg = new Map();
    this.templatesByOrg = new Map();
  }

  createReferral(input) {
    const referral = buildReferralDraft(input, {
      referralId: this.idFactory("ref"),
      now: this.timestamp()
    });

    this.referralsForOrg(referral.orgId).set(referral.referralId, referral);
    return referral;
  }

  listReferrals(orgId) {
    return sortByCreatedAt([...this.referralsForOrg(orgId).values()]);
  }

  getReferral(orgId, referralId) {
    return this.referralsForOrg(orgId).get(referralId) || null;
  }

  updateReferral(orgId, referralId, input) {
    const current = this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = patchReferralDraft(current, input, {
      now: this.timestamp()
    });
    this.referralsForOrg(orgId).set(referralId, updated);
    return updated;
  }

  createReferralDocument(orgId, referralId, input) {
    const current = this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = attachReferralDocument(current, input, {
      documentArtifactId: this.idFactory("doc"),
      now: this.timestamp()
    });
    this.referralsForOrg(orgId).set(referralId, updated);

    return {
      referral: updated,
      documentArtifact: updated.documentArtifact
    };
  }

  listRecipientDirectory(orgId) {
    return sortByUpdatedAt([...this.mapForOrg(this.recipientsByOrg, orgId).values()]);
  }

  upsertRecipientDirectory(orgId, input) {
    const recipients = this.mapForOrg(this.recipientsByOrg, orgId);
    const current = input.recipientId ? recipients.get(input.recipientId) : null;
    const entry = current
      ? patchRecipientDirectoryEntry(current, input, { now: this.timestamp() })
      : buildRecipientDirectoryEntry(input, {
        recipientId: this.idFactory("rcp"),
        now: this.timestamp()
      });
    recipients.set(entry.recipientId, entry);
    return entry;
  }

  getRecipientDirectoryEntry(orgId, recipientId) {
    return this.mapForOrg(this.recipientsByOrg, orgId).get(recipientId) || null;
  }

  listReferralTemplates(orgId) {
    return sortByUpdatedAt([...this.mapForOrg(this.templatesByOrg, orgId).values()]);
  }

  upsertReferralTemplate(orgId, input) {
    const templates = this.mapForOrg(this.templatesByOrg, orgId);
    const current = input.templateId ? templates.get(input.templateId) : null;
    const entry = current
      ? patchReferralTemplate(current, input, { now: this.timestamp() })
      : buildReferralTemplate(input, {
        templateId: this.idFactory("tpl"),
        now: this.timestamp()
      });
    templates.set(entry.templateId, entry);
    return entry;
  }

  getReferralTemplate(orgId, templateId) {
    return this.mapForOrg(this.templatesByOrg, orgId).get(templateId) || null;
  }

  createReferralImport(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReferralImport(current, input, {
      importId: this.idFactory("imp"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  addReferralAttachment(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReferralAttachment(current, input, {
      attachmentId: this.idFactory("att"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  addReplyLetter(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => addReplyLetter(current, input, {
      replyId: this.idFactory("rpl"),
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  updateFeeLinkage(orgId, referralId, input, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => updateFeeLinkage(current, input, {
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  validateReferral(orgId, referralId) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => ({
      ...current,
      reviewChecklist: buildReferralReviewChecklist(current),
      updatedAt: this.timestamp()
    }));
  }

  draftReferralWithAssistant(orgId, referralId, input) {
    const suggestion = buildDraftSuggestion(input);
    const referral = this.updateReferralWithTransform(orgId, referralId, (current) => patchReferralDraft(current, {
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

  finalizeReferral(orgId, referralId, input = {}, options = {}) {
    return this.updateReferralWithTransform(orgId, referralId, (current) => finalizeReferral(current, input, {
      memberId: options.memberId,
      now: this.timestamp()
    }));
  }

  updateReferralWithTransform(orgId, referralId, transform) {
    const current = this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }
    const updated = transform(current);
    this.referralsForOrg(orgId).set(referralId, updated);
    return updated;
  }

  referralsForOrg(orgId) {
    return this.mapForOrg(this.referralsByOrg, orgId);
  }

  mapForOrg(container, orgId) {
    if (!container.has(orgId)) {
      container.set(orgId, new Map());
    }

    return container.get(orgId);
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

function sortByUpdatedAt(items) {
  return items.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
}
