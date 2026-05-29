import assert from "node:assert/strict";
import test from "node:test";

import {
  COOKIE_OPERATOR_SESSION_TOKEN,
  OPERATOR_CSRF_COOKIE_NAME,
  OPERATOR_SESSION_COOKIE_NAME,
  appendSetCookieHeader,
  clearOperatorCsrfCookie,
  clearOperatorSessionCookie,
  createCsrfToken,
  extractBearerToken,
  extractOperatorCookieToken,
  extractOperatorCookieTokenFromHeader,
  resolveOperatorAccessToken,
  setOperatorCsrfCookie,
  setOperatorSessionCookie,
  signOperatorAccessToken,
  verifyOperatorSessionToken
} from "../src/index.js";
import { InMemoryStore } from "../src/store/in-memory-store.js";

function createResponseMock() {
  const headers = new Map();
  return {
    getHeader(name) {
      return headers.get(name) ?? null;
    },
    setHeader(name, value) {
      headers.set(name, value);
    }
  };
}

test("operator auth helpers share cookie and bearer token behavior", () => {
  const res = createResponseMock();
  const csrf = createCsrfToken();
  setOperatorSessionCookie(res, "session-token");
  setOperatorCsrfCookie(res, csrf);
  appendSetCookieHeader(res, "custom=value; Path=/");

  const cookies = res.getHeader("Set-Cookie");
  assert.equal(Array.isArray(cookies), true);
  assert.equal(cookies.length, 3);
  assert.equal(String(cookies[0]).includes(OPERATOR_SESSION_COOKIE_NAME), true);
  assert.equal(String(cookies[1]).includes(OPERATOR_CSRF_COOKIE_NAME), true);
  assert.equal(String(cookies[2]).includes("custom=value"), true);

  const secret = "unit-test-operator-secret";
  const signed = signOperatorAccessToken({
    memberId: "mem_1",
    orgId: "org_1",
    tokenVersion: 0,
    exp: Date.now() + 60_000
  }, secret);
  assert.equal(verifyOperatorSessionToken(signed, secret).memberId, "mem_1");
  assert.equal(COOKIE_OPERATOR_SESSION_TOKEN, "__cookie_operator_session__");
  assert.equal(extractOperatorCookieTokenFromHeader(`${OPERATOR_SESSION_COOKIE_NAME}=${signed}; theme=dark`), signed);
  assert.equal(extractOperatorCookieToken({ headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${signed}` } }), signed);
  assert.equal(extractBearerToken({ headers: { authorization: `Bearer ${signed}` } }), signed);
  assert.equal(resolveOperatorAccessToken({ headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${signed}` } }), signed);

  clearOperatorSessionCookie(res);
  clearOperatorCsrfCookie(res);
  const cleared = res.getHeader("Set-Cookie");
  assert.equal(cleared.length, 5);
  assert.equal(String(cleared[3]).includes(`${OPERATOR_SESSION_COOKIE_NAME}=`), true);
  assert.equal(String(cleared[4]).includes(`${OPERATOR_CSRF_COOKIE_NAME}=`), true);
});

test("billing foundation store methods support signup, provisioning, and password setup", async () => {
  const store = new InMemoryStore();

  const signup = await store.createSignupApplication({
    organizationCode: "clinic-b",
    displayName: "B病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    planCode: "medical_ai_monthly"
  });
  assert.equal(signup.status, "draft");
  assert.equal((await store.getSignupApplication(signup.signupId)).adminEmail, "admin@example.com");
  assert.equal((await store.updateSignupApplication(signup.signupId, { status: "checkout_created" })).status, "checkout_created");
  assert.equal((await store.findPendingSignupApplication({ organizationCode: "clinic-b", adminLoginId: "admin" })).signupId, signup.signupId);

  const firstReceipt = await store.createStripeEventReceipt({
    eventId: "evt_test_1",
    type: "checkout.session.completed",
    livemode: false,
    objectId: "cs_test_1"
  });
  const secondReceipt = await store.createStripeEventReceipt({
    eventId: "evt_test_1",
    type: "should-not-overwrite"
  });
  assert.equal(firstReceipt.type, "checkout.session.completed");
  assert.equal(secondReceipt.type, "checkout.session.completed");
  assert.equal((await store.updateStripeEventReceipt("evt_test_1", { status: "processed" })).status, "processed");

  const provisioned = await store.provisionOrganizationWithAdminMember({
    organizationCode: "clinic-b",
    displayName: "B病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    billing: {
      status: "trialing",
      stripeCustomerId: "cus_test_1",
      stripeSubscriptionId: "sub_test_1",
      stripePriceId: "price_test_1",
      trialEndsAt: "2026-05-01T00:00:00.000Z"
    },
    access: {
      status: "pending_setup"
    }
  });

  assert.equal(provisioned.organization.billing.status, "trialing");
  assert.equal(provisioned.organization.access.status, "pending_setup");
  assert.equal((await store.getOrganizationByCode("clinic-b")).orgId, provisioned.organization.orgId);
  assert.equal((await store.getLoginIdentity({ organizationCode: "clinic-b", loginId: "admin" })).status, "pending_password_setup");

  const tokenResult = await store.createPasswordSetupToken({
    orgId: provisioned.organization.orgId,
    memberId: provisioned.member.memberId,
    organizationDisplayName: provisioned.organization.displayName,
    memberDisplayName: provisioned.member.displayName,
    email: "admin@example.com"
  });
  assert.equal((await store.getPasswordSetupToken(tokenResult.tokenId)).status, "active");

  const consumed = await store.consumePasswordSetupToken({
    tokenId: tokenResult.tokenId,
    password: "Temporary-password-1!"
  });
  assert.equal(consumed.organization.access.status, "active");
  assert.equal((await store.getPasswordSetupToken(tokenResult.tokenId)), null);

  const authenticated = await store.authenticateMember({
    organizationCode: "clinic-b",
    loginId: "admin",
    password: "Temporary-password-1!"
  });
  assert.ok(authenticated);
  assert.equal(authenticated.organization.orgId, provisioned.organization.orgId);

  const updatedBilling = await store.updateOrganizationBilling({
    orgId: provisioned.organization.orgId,
    patch: {
      status: "past_due",
      gracePeriodEndsAt: "2026-05-08T00:00:00.000Z"
    }
  });
  const updatedAccess = await store.updateOrganizationAccess({
    orgId: provisioned.organization.orgId,
    patch: {
      status: "billing_action_required",
      reason: "invoice.payment_failed"
    }
  });

  assert.equal(updatedBilling.billing.status, "past_due");
  assert.equal(updatedAccess.access.status, "billing_action_required");
  assert.equal((await store.listSignupApplications({ limit: 10 })).length, 1);

  const restrictedProvisioned = await store.provisionOrganizationWithAdminMember({
    organizationCode: "clinic-c",
    displayName: "C病院",
    adminLoginId: "owner",
    adminDisplayName: "契約管理者",
    adminEmail: "owner@example.com",
    billing: {
      status: "past_due",
      stripeCustomerId: "cus_test_2",
      stripeSubscriptionId: "sub_test_2"
    },
    access: {
      status: "billing_action_required",
      reason: "billing.past_due"
    }
  });
  const restrictedToken = await store.createPasswordSetupToken({
    orgId: restrictedProvisioned.organization.orgId,
    memberId: restrictedProvisioned.member.memberId,
    organizationDisplayName: restrictedProvisioned.organization.displayName,
    memberDisplayName: restrictedProvisioned.member.displayName,
    email: "owner@example.com"
  });
  const restrictedConsumed = await store.consumePasswordSetupToken({
    tokenId: restrictedToken.tokenId,
    password: "Temporary-password-2!"
  });

  assert.equal(restrictedConsumed.organization.access.status, "billing_action_required");
  assert.equal(restrictedConsumed.organization.access.reason, "billing.past_due");
});

test("billing foundation store methods support contact signups and email verification tokens", async () => {
  const store = new InMemoryStore();

  const contactSignup = await store.createSignupApplication({
    source: "lp_contact_form",
    organizationCode: "",
    displayName: "サンプルクリニック",
    organizationName: "サンプルクリニック",
    adminLoginId: "",
    adminDisplayName: "山田 太郎",
    adminName: "山田 太郎",
    adminEmail: "contact@example.com",
    phoneNumber: "03-0000-0000",
    seatEstimate: 5,
    notes: "trial希望",
    planCode: "medical_ai_monthly",
    status: "submitted"
  });

  assert.equal(contactSignup.source, "lp_contact_form");
  assert.equal(contactSignup.organizationName, "サンプルクリニック");
  assert.equal(contactSignup.adminName, "山田 太郎");
  assert.equal(contactSignup.phoneNumber, "03-0000-0000");
  assert.equal(contactSignup.seatEstimate, 5);
  assert.equal(contactSignup.emailVerifiedAt, null);

  const activeContact = await store.findActiveContactSignupApplication({
    adminEmail: "contact@example.com"
  });
  assert.equal(activeContact.signupId, contactSignup.signupId);

  const verification = await store.createEmailVerificationToken({
    signupId: contactSignup.signupId,
    email: "contact@example.com"
  });
  assert.equal((await store.getEmailVerificationToken(verification.tokenId)).status, "active");

  const consumed = await store.consumeEmailVerificationToken({
    tokenId: verification.tokenId
  });
  assert.equal(consumed.status, "used");
  assert.equal(consumed.signupId, contactSignup.signupId);
  assert.equal((await store.getEmailVerificationToken(verification.tokenId)), null);

  const verifiedSignup = await store.updateSignupApplication(contactSignup.signupId, {
    status: "verified",
    emailVerifiedAt: consumed.consumedAt
  });
  assert.equal(verifiedSignup.status, "verified");
  assert.ok(verifiedSignup.emailVerifiedAt);
});
