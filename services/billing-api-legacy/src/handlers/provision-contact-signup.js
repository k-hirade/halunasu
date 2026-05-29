import crypto from "node:crypto";

import { addMinutes, nowIso } from "@medical/core";

import { jsonError } from "../lib/http.js";
import {
  buildLoginUrl,
  buildPasswordSetupUrl,
  ensurePasswordSetupToken
} from "../lib/contact-signup.js";

function randomSuffix(length = 6) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

async function generateOrganizationCode(store) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const organizationCode = `clinic-${randomSuffix(6)}`;
    const existing = await store.getOrganizationByCode?.(organizationCode);

    if (!existing) {
      return organizationCode;
    }
  }

  throw jsonError("病院コードの採番に失敗しました。時間を置いてもう一度お試しください。", 500);
}

async function ensureSignupIdentifiers(store, signup) {
  const organizationCode = signup.organizationCode || await generateOrganizationCode(store);
  const adminLoginId = signup.adminLoginId || "admin";

  if (!signup.organizationCode && await store.getOrganizationByCode?.(organizationCode)) {
    throw jsonError("病院コードの採番に失敗しました。時間を置いてもう一度お試しください。", 500);
  }

  return {
    organizationCode,
    adminLoginId
  };
}

async function maybeSendProvisionedSlackNotification({
  store,
  signup,
  organization,
  member,
  notifier
}) {
  if (!notifier?.isEnabled?.() || signup?.slackProvisionedNotificationSentAt) {
    return signup;
  }

  try {
    await notifier.sendProvisionedSignup({
      signup,
      organization,
      member
    });

    return await store.updateSignupApplication?.(signup.signupId, {
      slackProvisionedNotificationSentAt: nowIso(),
      slackProvisionedNotificationErrorAt: null,
      slackProvisionedNotificationErrorMessageSafe: null
    }) || signup;
  } catch (error) {
    console.error("[billing] slack signup notification failed", {
      signupId: signup.signupId,
      orgId: organization?.orgId || signup.orgId || null,
      memberId: member?.memberId || signup.memberId || null,
      code: error?.code || null,
      message: error?.message || null
    });

    return await store.updateSignupApplication?.(signup.signupId, {
      slackProvisionedNotificationErrorAt: nowIso(),
      slackProvisionedNotificationErrorMessageSafe: "Slack 通知の送信に失敗しました。"
    }) || signup;
  }
}

export async function provisionContactSignupHandler({
  store,
  signupId,
  config,
  mailer,
  slackNotifier
}) {
  const signup = await store.getSignupApplication?.(signupId);

  if (!signup || signup.source !== "lp_contact_form") {
    throw jsonError("申込情報が見つかりません。", 404);
  }

  if (signup.status === "provisioned" && signup.orgId && signup.memberId && signup.passwordSetupTokenId) {
    const organization = await store.getOrganization?.(signup.orgId);
    const member = await store.getMember?.({
      orgId: signup.orgId,
      memberId: signup.memberId
    });
    const notifiedSignup = organization && member
      ? await maybeSendProvisionedSlackNotification({
          store,
          signup,
          organization,
          member,
          notifier: slackNotifier
        })
      : signup;

    return {
      signup: notifiedSignup,
      loginUrl: buildLoginUrl(config),
      passwordSetupUrl: buildPasswordSetupUrl(config, signup.passwordSetupTokenId),
      reused: true
    };
  }

  const verifiedAt = signup.emailVerifiedAt || nowIso();
  const trialEndsAt = addMinutes(verifiedAt, (config.trialDays || 7) * 24 * 60);
  const identifiers = await ensureSignupIdentifiers(store, signup);

  let workingSignup = await store.updateSignupApplication?.(signup.signupId, {
    organizationCode: identifiers.organizationCode,
    adminLoginId: identifiers.adminLoginId,
    emailVerifiedAt: verifiedAt,
    status: "provisioning",
    errorCode: null,
    errorMessageSafe: null
  }) || signup;

  try {
    let organization = null;
    let member = null;

    if (workingSignup.orgId && workingSignup.memberId) {
      organization = await store.getOrganization?.(workingSignup.orgId);
      member = await store.getMember?.({
        orgId: workingSignup.orgId,
        memberId: workingSignup.memberId
      });
    }

    if (!organization || !member) {
      const provisioned = await store.provisionOrganizationWithAdminMember?.({
        organizationCode: identifiers.organizationCode,
        displayName: workingSignup.organizationName || workingSignup.displayName,
        adminLoginId: identifiers.adminLoginId,
        adminDisplayName: workingSignup.adminName || workingSignup.adminDisplayName,
        adminEmail: workingSignup.adminEmail,
        billing: {
          provider: "stripe",
          planCode: workingSignup.planCode,
          status: "trialing",
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          trialEndsAt,
          currentPeriodEnd: null,
          gracePeriodEndsAt: null,
          cancelAtPeriodEnd: false,
          seatQuantity: Math.max(1, Number(workingSignup.seatEstimate || 1)),
          lastStripeEventId: null
        },
        access: {
          status: "pending_setup",
          reason: "password_setup_required",
          restrictedAt: null
        }
      });

      organization = provisioned.organization;
      member = provisioned.member;
    }

    const passwordSetupToken = await ensurePasswordSetupToken({
      store,
      signup: workingSignup,
      organization,
      member
    });
    const passwordSetupUrl = buildPasswordSetupUrl(config, passwordSetupToken.tokenId);
    const loginUrl = buildLoginUrl(config);

    workingSignup = await store.updateSignupApplication?.(workingSignup.signupId, {
      organizationCode: identifiers.organizationCode,
      adminLoginId: identifiers.adminLoginId,
      emailVerifiedAt: verifiedAt,
      orgId: organization.orgId,
      memberId: member.memberId,
      passwordSetupTokenId: passwordSetupToken.tokenId,
      status: "provisioned",
      errorCode: null,
      errorMessageSafe: null
    }) || workingSignup;

    try {
      await mailer?.sendPasswordSetupMail?.({
        signup: workingSignup,
        loginUrl,
        passwordSetupUrl
      });
    } catch (error) {
      console.error("[billing] password setup mail failed after provisioning", {
        signupId: workingSignup.signupId,
        orgId: organization.orgId,
        memberId: member.memberId,
        code: error?.code || null,
        message: error?.message || null
      });
    }

    workingSignup = await maybeSendProvisionedSlackNotification({
      store,
      signup: workingSignup,
      organization,
      member,
      notifier: slackNotifier
    });

    return {
      signup: workingSignup,
      organization,
      member,
      loginUrl,
      passwordSetupUrl,
      reused: false
    };
  } catch (error) {
    await store.updateSignupApplication?.(workingSignup.signupId, {
      status: "failed",
      errorCode: error?.code || "contact_signup_provision_failed",
      errorMessageSafe: error?.publicMessage || error?.safeMessage || "病院作成に失敗しました。"
    });
    throw error;
  }
}
