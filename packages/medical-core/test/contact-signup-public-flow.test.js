import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStore } from "../src/store/in-memory-store.js";
import { createContactSignupHandler } from "../../../services/billing-api-legacy/src/handlers/create-contact-signup.js";
import { inspectContactSignupVerificationHandler } from "../../../services/billing-api-legacy/src/handlers/inspect-contact-signup-verification.js";
import { resendContactSignupMailHandler } from "../../../services/billing-api-legacy/src/handlers/resend-contact-signup-mail.js";
import { verifyContactSignupHandler } from "../../../services/billing-api-legacy/src/handlers/verify-contact-signup.js";
import { assertWithinRateLimit } from "../../../services/billing-api-legacy/src/lib/rate-limit.js";

const TEST_CONFIG = {
  trialDays: 7,
  isProduction: false,
  publicAppBaseUrl: "https://stg.app.halunasu.com"
};

test("contact signup inspection is side-effect free and explicit verify provisions the org", async () => {
  const store = new InMemoryStore();
  const created = await createContactSignupHandler({
    store,
    config: TEST_CONFIG,
    input: {
      organizationName: "サンプル医院",
      adminName: "山田 太郎",
      adminEmail: "admin@example.com",
      phoneNumber: "03-0000-0000",
      consentAccepted: true
    },
    clientIp: "203.0.113.10",
    userAgent: "node-test"
  });

  const token = created.verificationToken.tokenId;
  const inspection = await inspectContactSignupVerificationHandler({
    store,
    token
  });

  assert.equal(inspection.tokenStatus, "active");
  assert.equal(inspection.signup.status, "submitted");
  assert.equal(inspection.signup.adminEmailMasked, "a***n@example.com");

  const signupAfterInspect = await store.getSignupApplication(created.signup.signupId);
  assert.equal(signupAfterInspect.status, "submitted");
  assert.equal(signupAfterInspect.emailVerifiedAt, null);
  assert.equal(signupAfterInspect.consentVersion, "halunasu-terms-privacy-2026-05-06");
  assert.equal(signupAfterInspect.consentTermsUrl, "https://halunasu.com/terms.html");
  assert.equal(signupAfterInspect.consentPrivacyUrl, "https://halunasu.com/privacy.html");
  assert.equal(signupAfterInspect.consentClientIp, "203.0.113.10");
  assert.equal(signupAfterInspect.consentUserAgent, "node-test");
  assert.ok(signupAfterInspect.consentAcceptedAt);

  const verified = await verifyContactSignupHandler({
    store,
    token,
    config: TEST_CONFIG,
    mailer: {
      async sendPasswordSetupMail() {
        return { delivered: false };
      }
    }
  });

  assert.equal(verified.signup.status, "provisioned");
  assert.equal(verified.signup.adminLoginId, "admin");
  assert.equal(verified.signup.organizationCode.startsWith("clinic-"), true);
  assert.equal(verified.signup.adminEmailMasked, "a***n@example.com");
  assert.equal(verified.signup.orgId, undefined);
  assert.equal(typeof verified.passwordSetupUrl, "string");

  const signupAfterVerify = await store.getSignupApplication(created.signup.signupId);
  assert.equal(signupAfterVerify.status, "provisioned");
  assert.ok(signupAfterVerify.emailVerifiedAt);
});

test("public contact signup rate limit blocks the fourth attempt for the same email", async () => {
  const store = new InMemoryStore();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.doesNotReject(() => assertWithinRateLimit({
      store,
      bucket: "billing-contact-signup-email",
      identifier: "rate-limit@example.com",
      limit: 3,
      windowMs: 30 * 60_000
    }));
  }

  await assert.rejects(
    () => assertWithinRateLimit({
      store,
      bucket: "billing-contact-signup-email",
      identifier: "rate-limit@example.com",
      limit: 3,
      windowMs: 30 * 60_000
    }),
    (error) => error?.statusCode === 429
  );
});

test("contact signup mail resend switches between verification and password setup phases", async () => {
  const store = new InMemoryStore();
  const deliveries = [];
  const created = await createContactSignupHandler({
    store,
    config: TEST_CONFIG,
    input: {
      organizationName: "サンプル医院",
      adminName: "山田 太郎",
      adminEmail: "resend@example.com",
      phoneNumber: "03-0000-0000",
      consentAccepted: true
    }
  });

  const verificationResend = await resendContactSignupMailHandler({
    store,
    signupId: created.signup.signupId,
    config: TEST_CONFIG,
    signupMailer: {
      async sendVerificationMail(payload) {
        deliveries.push({ mode: "verification", payload });
        return { delivered: false };
      },
      async sendPasswordSetupMail(payload) {
        deliveries.push({ mode: "password_setup", payload });
        return { delivered: false };
      }
    },
    buildVerificationUrl: (tokenId) => `${TEST_CONFIG.publicAppBaseUrl}/contact-signup/verify?token=${tokenId}`
  });
  assert.equal(verificationResend.mode, "verification");
  assert.equal(verificationResend.previewUrl.includes("/contact-signup/verify?token="), true);

  await verifyContactSignupHandler({
    store,
    token: created.verificationToken.tokenId,
    config: TEST_CONFIG,
    mailer: {
      async sendPasswordSetupMail(payload) {
        deliveries.push({ mode: "password_setup", payload });
        return { delivered: false };
      }
    }
  });

  const passwordResend = await resendContactSignupMailHandler({
    store,
    signupId: created.signup.signupId,
    config: TEST_CONFIG,
    signupMailer: {
      async sendVerificationMail(payload) {
        deliveries.push({ mode: "verification", payload });
        return { delivered: false };
      },
      async sendPasswordSetupMail(payload) {
        deliveries.push({ mode: "password_setup", payload });
        return { delivered: false };
      }
    },
    buildVerificationUrl: (tokenId) => `${TEST_CONFIG.publicAppBaseUrl}/contact-signup/verify?token=${tokenId}`
  });
  assert.equal(passwordResend.mode, "password_setup");
  assert.equal(passwordResend.previewUrl, null);
});
