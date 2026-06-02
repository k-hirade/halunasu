import assert from "node:assert/strict";
import test from "node:test";

import { createSignupMailer } from "../../../services/billing-api-legacy/src/lib/signup-mailer.js";

test("signup mailer uses console preview outside production when no provider is configured", async () => {
  const originalConsoleLog = console.log;
  const previews = [];
  console.log = (...args) => previews.push(args);

  try {
    const mailer = createSignupMailer({
      config: {
        isProduction: false,
        emailDeliveryProvider: "",
        emailFromAddress: "",
        resendApiKey: ""
      }
    });

    const result = await mailer.sendVerificationMail({
      signup: {
        signupId: "signup_1",
        adminEmail: "contact@example.com"
      },
      verificationUrl: "https://example.com/verify?token=abc",
      expiresAt: "2026-04-29T00:00:00.000Z"
    });

    assert.equal(result.mode, "console_preview");
    assert.equal(result.delivered, false);
    assert.equal(previews.length, 1);
    assert.equal(previews[0][0], "[billing] contact signup verification mail preview");
  } finally {
    console.log = originalConsoleLog;
  }
});

test("signup mailer sends through resend when configured", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ id: "email_123" });
      }
    };
  };

  try {
    const mailer = createSignupMailer({
      config: {
        isProduction: true,
        emailDeliveryProvider: "resend",
        emailFromAddress: "Harunas <no-reply@example.com>",
        emailReplyToAddress: "support@example.com",
        publicManualUrl: "https://halunasu.com/manual",
        resendApiKey: "re_test_123",
        resendApiBaseUrl: "https://api.resend.test/emails"
      }
    });

    const result = await mailer.sendPasswordSetupMail({
      signup: {
        signupId: "signup_2",
        adminName: "山田 太郎",
        adminEmail: "contact@example.com",
        organizationCode: "clinic-123456",
        adminLoginId: "admin"
      },
      loginUrl: "https://app.halunasu.com/",
      passwordSetupUrl: "https://app.halunasu.com/setup-password/token_123"
    });

    assert.equal(result.mode, "resend");
    assert.equal(result.delivered, true);
    assert.equal(result.providerMessageId, "email_123");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.resend.test/emails");
    assert.equal(requests[0].options.method, "POST");

    const headers = requests[0].options.headers;
    assert.equal(headers.Authorization, "Bearer re_test_123");
    assert.equal(headers["Content-Type"], "application/json");

    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.from, "Harunas <no-reply@example.com>");
    assert.deepEqual(body.to, ["contact@example.com"]);
    assert.equal(body.reply_to, "support@example.com");
    assert.equal(body.subject, "【ハルナス】初回ログイン設定のご案内");
    assert.match(body.text, /病院コード: clinic-123456/);
    assert.match(body.text, /利用マニュアル: https:\/\/halunasu.com\/manual/);
    assert.match(body.html, /setup-password\/token_123/);
    assert.match(body.html, /https:\/\/halunasu.com\/manual/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
