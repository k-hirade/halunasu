import { toPublicContactSignupSummary } from "../lib/contact-signup.js";
import { jsonError } from "../lib/http.js";

export async function inspectContactSignupVerificationHandler({ store, token }) {
  const tokenRecord = await store.getEmailVerificationToken?.(token, { includeInactive: true });

  if (!tokenRecord) {
    throw jsonError("確認リンクが見つかりません。", 404);
  }

  const signup = await store.getSignupApplication?.(tokenRecord.signupId);

  if (!signup || signup.source !== "lp_contact_form") {
    throw jsonError("申込情報が見つかりません。", 404);
  }

  const tokenStatus = tokenRecord.status === "active" && tokenRecord.expiresAt && Date.parse(tokenRecord.expiresAt) <= Date.now()
    ? "expired"
    : tokenRecord.status;

  return {
    signup: toPublicContactSignupSummary(signup),
    tokenStatus,
    canProceed: tokenStatus !== "expired"
  };
}
