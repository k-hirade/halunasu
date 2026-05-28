import {
  attachPdfPlaceholder,
  buildReferralDraft,
  createId,
  patchReferralDraft
} from "../../../../packages/referral-core/src/index.js";

export class MemoryReferralStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.referralsByOrg = new Map();
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

  createPdfPlaceholder(orgId, referralId, input) {
    const current = this.getReferral(orgId, referralId);
    if (!current) {
      throw notFoundError("referral not found");
    }

    const updated = attachPdfPlaceholder(current, input, {
      pdfPlaceholderId: this.idFactory("pdf"),
      now: this.timestamp()
    });
    this.referralsForOrg(orgId).set(referralId, updated);

    return {
      referral: updated,
      pdfPlaceholder: updated.pdfPlaceholder
    };
  }

  referralsForOrg(orgId) {
    if (!this.referralsByOrg.has(orgId)) {
      this.referralsByOrg.set(orgId, new Map());
    }

    return this.referralsByOrg.get(orgId);
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
