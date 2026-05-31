import { addMinutes, nowIso } from "@medical/core";

import { jsonError } from "../lib/http.js";

const CONTACT_SIGNUP_SOURCE = "lp_contact_form";
const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;
const CONTACT_SIGNUP_CONSENT_VERSION = "halunasu-terms-privacy-2026-05-06";
const CONTACT_SIGNUP_TERMS_URL = "https://halunasu.com/terms.html";
const CONTACT_SIGNUP_PRIVACY_URL = "https://halunasu.com/privacy.html";

function buildConsentRecord({ clientIp = null, userAgent = null } = {}) {
  return {
    consentAcceptedAt: nowIso(),
    consentVersion: CONTACT_SIGNUP_CONSENT_VERSION,
    consentTermsUrl: CONTACT_SIGNUP_TERMS_URL,
    consentPrivacyUrl: CONTACT_SIGNUP_PRIVACY_URL,
    consentClientIp: clientIp ? String(clientIp).slice(0, 120) : null,
    consentUserAgent: userAgent ? String(userAgent).slice(0, 512) : null
  };
}

export async function createContactSignupHandler({ store, input, config, clientIp = null, userAgent = null }) {
  const existing = await store.findActiveContactSignupApplication?.({
    adminEmail: input.adminEmail
  });
  const consentRecord = buildConsentRecord({ clientIp, userAgent });

  if (existing) {
    const refreshedSignup = await store.updateSignupApplication?.(existing.signupId, consentRecord) || {
      ...existing,
      ...consentRecord
    };

    if (existing.status === "submitted" && !existing.emailVerifiedAt) {
      const verification = await store.createEmailVerificationToken({
        signupId: existing.signupId,
        email: existing.adminEmail,
        expiresAt: addMinutes(new Date().toISOString(), EMAIL_VERIFICATION_TTL_MINUTES)
      });

      return {
        signup: refreshedSignup,
        verificationToken: verification,
        reused: true
      };
    }

    return {
      signup: refreshedSignup,
      verificationToken: null,
      reused: true
    };
  }

  if (!store.createEmailVerificationToken) {
    throw jsonError("確認リンク発行の準備が完了していません。", 500);
  }

  const expiresAt = addMinutes(new Date().toISOString(), config.trialDays * 24 * 60);
  const signup = await store.createSignupApplication({
    source: CONTACT_SIGNUP_SOURCE,
    organizationCode: "",
    displayName: input.organizationName,
    organizationName: input.organizationName,
    adminLoginId: "",
    adminDisplayName: input.adminName,
    adminName: input.adminName,
    adminEmail: input.adminEmail,
    seatEstimate: input.seatEstimate ?? null,
    notes: input.notes || null,
    ...consentRecord,
    planCode: "medical_ai_monthly",
    status: "submitted",
    expiresAt
  });

  const verification = await store.createEmailVerificationToken({
    signupId: signup.signupId,
    email: signup.adminEmail,
    expiresAt: addMinutes(new Date().toISOString(), EMAIL_VERIFICATION_TTL_MINUTES)
  });

  return {
    signup,
    verificationToken: verification,
    reused: false
  };
}
