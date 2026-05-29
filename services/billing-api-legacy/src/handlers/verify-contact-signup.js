import { toVerifiedContactSignupSummary } from "../lib/contact-signup.js";
import { jsonError } from "../lib/http.js";
import { provisionContactSignupHandler } from "./provision-contact-signup.js";

export async function verifyContactSignupHandler({ store, token, config, mailer, slackNotifier }) {
  const tokenRecord = await store.getEmailVerificationToken?.(token, { includeInactive: true });

  if (!tokenRecord) {
    throw jsonError("確認リンクが見つかりません。", 404);
  }

  if (tokenRecord.status === "expired") {
    throw jsonError("確認リンクの有効期限が切れています。", 410);
  }

  const signup = await store.getSignupApplication?.(tokenRecord.signupId);

  if (!signup || signup.source !== "lp_contact_form") {
    throw jsonError("申込情報が見つかりません。", 404);
  }

  if (tokenRecord.status === "active") {
    const consumed = await store.consumeEmailVerificationToken?.({ tokenId: token });

    await store.updateSignupApplication?.(signup.signupId, {
      status: signup.status === "submitted" ? "verified" : signup.status,
      emailVerifiedAt: consumed.consumedAt || signup.emailVerifiedAt || new Date().toISOString()
    });
  }

  const provisioned = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config,
    mailer,
    slackNotifier
  });

  return {
    signup: toVerifiedContactSignupSummary(provisioned.signup),
    verificationConsumed: tokenRecord.status !== "used",
    loginUrl: provisioned.loginUrl,
    passwordSetupUrl: provisioned.passwordSetupUrl
  };
}
