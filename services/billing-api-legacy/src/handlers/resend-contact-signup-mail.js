import { addMinutes } from "@medical/core";

import {
  buildLoginUrl,
  buildPasswordSetupUrl,
  ensurePasswordSetupToken
} from "../lib/contact-signup.js";
import { jsonError } from "../lib/http.js";

const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;

export async function resendContactSignupMailHandler({
  store,
  signupId,
  config,
  signupMailer,
  buildVerificationUrl
}) {
  const signup = await store.getSignupApplication?.(signupId);

  if (!signup || signup.source !== "lp_contact_form") {
    throw jsonError("申込情報が見つかりません。", 404);
  }

  if (signup.status === "submitted" && !signup.emailVerifiedAt) {
    const verification = await store.createEmailVerificationToken?.({
      signupId: signup.signupId,
      email: signup.adminEmail,
      expiresAt: addMinutes(new Date().toISOString(), EMAIL_VERIFICATION_TTL_MINUTES)
    });
    const verificationUrl = buildVerificationUrl(verification.tokenId);

    const delivery = await signupMailer?.sendVerificationMail?.({
      signup,
      verificationUrl,
      expiresAt: verification.record?.expiresAt || null
    }) || { delivered: false };

    return {
      mode: "verification",
      delivered: Boolean(delivery.delivered),
      previewUrl: config.isProduction ? null : verificationUrl
    };
  }

  if (signup.status === "verified" || signup.status === "provisioning") {
    throw jsonError("病院アカウントを準備中です。数秒後にもう一度お試しください。", 409);
  }

  if (signup.status !== "provisioned" || !signup.orgId || !signup.memberId) {
    throw jsonError("再送できるメールがまだありません。", 409);
  }

  const organization = await store.getOrganization?.(signup.orgId);
  const member = await store.getMember?.({
    orgId: signup.orgId,
    memberId: signup.memberId
  });

  if (!organization || !member) {
    throw jsonError("病院アカウント情報の取得に失敗しました。", 500);
  }

  const token = await ensurePasswordSetupToken({
    store,
    signup,
    organization,
    member
  });
  const loginUrl = buildLoginUrl(config);
  const passwordSetupUrl = buildPasswordSetupUrl(config, token.tokenId);
  const delivery = await signupMailer?.sendPasswordSetupMail?.({
    signup,
    loginUrl,
    passwordSetupUrl
  }) || { delivered: false };

  return {
    mode: "password_setup",
    delivered: Boolean(delivery.delivered),
    previewUrl: null
  };
}
