import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStore } from "../src/store/in-memory-store.js";
import { provisionContactSignupHandler } from "../../../services/billing-api-legacy/src/handlers/provision-contact-signup.js";

test("contact signup provisioning creates org, admin, and password setup token", async () => {
  const store = new InMemoryStore();
  const sentMails = [];
  const signup = await store.createSignupApplication({
    source: "lp_contact_form",
    organizationCode: "",
    displayName: "ハルナス内科",
    organizationName: "ハルナス内科",
    adminLoginId: "",
    adminDisplayName: "山田 太郎",
    adminName: "山田 太郎",
    adminEmail: "contact@example.com",
    phoneNumber: "03-0000-0000",
    seatEstimate: 3,
    planCode: "medical_ai_monthly",
    status: "verified",
    emailVerifiedAt: "2026-04-27T00:00:00.000Z"
  });

  const result = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail(payload) {
        sentMails.push(payload);
      }
    }
  });

  assert.equal(result.reused, false);
  assert.equal(result.signup.status, "provisioned");
  assert.equal(result.signup.adminLoginId, "admin");
  assert.match(result.signup.organizationCode, /^clinic-[a-z0-9]{6}$/);
  assert.ok(result.signup.orgId);
  assert.ok(result.signup.memberId);
  assert.ok(result.signup.passwordSetupTokenId);
  assert.equal(result.organization.billing.status, "trialing");
  assert.equal(result.organization.access.status, "pending_setup");
  assert.equal(result.organization.billing.trialEndsAt, "2026-05-04T00:00:00.000Z");
  assert.equal(result.member.email, "contact@example.com");
  assert.equal(
    result.passwordSetupUrl,
    `https://stg.app.halunasu.com/setup-password/${encodeURIComponent(result.signup.passwordSetupTokenId)}`
  );
  assert.equal(result.loginUrl, "https://stg.app.halunasu.com/");
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].signup.signupId, signup.signupId);
});

test("contact signup provisioning is idempotent for already provisioned signups", async () => {
  const store = new InMemoryStore();
  const signup = await store.createSignupApplication({
    source: "lp_contact_form",
    organizationCode: "",
    displayName: "ハルナス内科",
    organizationName: "ハルナス内科",
    adminLoginId: "",
    adminDisplayName: "山田 太郎",
    adminName: "山田 太郎",
    adminEmail: "contact@example.com",
    planCode: "medical_ai_monthly",
    status: "verified",
    emailVerifiedAt: "2026-04-27T00:00:00.000Z"
  });

  const first = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail() {}
    }
  });

  const second = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail() {}
    }
  });

  const organizations = await store.listOrganizations();

  assert.equal(first.signup.orgId, second.signup.orgId);
  assert.equal(first.signup.memberId, second.signup.memberId);
  assert.equal(first.signup.passwordSetupTokenId, second.signup.passwordSetupTokenId);
  assert.equal(second.reused, true);
  assert.equal(organizations.length, 1);
});

test("contact signup provisioning sends slack notification only once", async () => {
  const store = new InMemoryStore();
  const slackCalls = [];
  const signup = await store.createSignupApplication({
    source: "lp_contact_form",
    organizationCode: "",
    displayName: "ハルナス内科",
    organizationName: "ハルナス内科",
    adminLoginId: "",
    adminDisplayName: "山田 太郎",
    adminName: "山田 太郎",
    adminEmail: "contact@example.com",
    planCode: "medical_ai_monthly",
    status: "verified",
    emailVerifiedAt: "2026-04-27T00:00:00.000Z"
  });

  const first = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail() {}
    },
    slackNotifier: {
      isEnabled() {
        return true;
      },
      async sendProvisionedSignup(payload) {
        slackCalls.push(payload);
      }
    }
  });

  const second = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail() {}
    },
    slackNotifier: {
      isEnabled() {
        return true;
      },
      async sendProvisionedSignup(payload) {
        slackCalls.push(payload);
      }
    }
  });

  assert.equal(slackCalls.length, 1);
  assert.ok(first.signup.slackProvisionedNotificationSentAt);
  assert.equal(second.signup.slackProvisionedNotificationSentAt, first.signup.slackProvisionedNotificationSentAt);
  assert.equal(second.signup.slackProvisionedNotificationErrorAt, null);
});

test("contact signup provisioning ignores slack notification failures", async () => {
  const store = new InMemoryStore();
  const signup = await store.createSignupApplication({
    source: "lp_contact_form",
    organizationCode: "",
    displayName: "ハルナス内科",
    organizationName: "ハルナス内科",
    adminLoginId: "",
    adminDisplayName: "山田 太郎",
    adminName: "山田 太郎",
    adminEmail: "contact@example.com",
    planCode: "medical_ai_monthly",
    status: "verified",
    emailVerifiedAt: "2026-04-27T00:00:00.000Z"
  });

  const result = await provisionContactSignupHandler({
    store,
    signupId: signup.signupId,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      trialDays: 7
    },
    mailer: {
      async sendPasswordSetupMail() {}
    },
    slackNotifier: {
      isEnabled() {
        return true;
      },
      async sendProvisionedSignup() {
        throw new Error("slack down");
      }
    }
  });

  assert.equal(result.signup.status, "provisioned");
  assert.equal(result.signup.slackProvisionedNotificationSentAt, null);
  assert.ok(result.signup.slackProvisionedNotificationErrorAt);
  assert.equal(result.signup.slackProvisionedNotificationErrorMessageSafe, "Slack 通知の送信に失敗しました。");
});
