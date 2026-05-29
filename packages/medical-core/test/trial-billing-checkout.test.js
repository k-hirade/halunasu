import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStore } from "../src/store/in-memory-store.js";
import { createOrganizationCheckoutSessionHandler } from "../../../services/billing-api-legacy/src/handlers/create-org-checkout-session.js";
import { processStripeEventHandler } from "../../../services/billing-api-legacy/src/handlers/process-stripe-event.js";
import { provisionContactSignupHandler } from "../../../services/billing-api-legacy/src/handlers/provision-contact-signup.js";

test("post-trial checkout session creation reuses provisioned signup and does not add a new trial", async () => {
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

  const provisioned = await provisionContactSignupHandler({
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

  const stripeCalls = [];
  const result = await createOrganizationCheckoutSessionHandler({
    store,
    config: {
      publicAppBaseUrl: "https://stg.app.halunasu.com",
      stripePriceLookupKey: "medical_ai_monthly_jpy_v2"
    },
    stripeClient: {
      async lookupPriceByLookupKey(lookupKey) {
        stripeCalls.push({ type: "lookupPrice", lookupKey });
        return { id: "price_test_1" };
      },
      async createCustomer(payload) {
        stripeCalls.push({ type: "createCustomer", payload });
        return { id: "cus_trial_1" };
      },
      async createCheckoutSession(payload) {
        stripeCalls.push({ type: "createCheckoutSession", payload });
        return {
          id: "cs_trial_1",
          url: "https://checkout.stripe.com/c/pay/cs_trial_1",
          expires_at: 1_777_777_777
        };
      }
    },
    orgId: provisioned.signup.orgId
  });

  const persistedSignup = await store.getSignupApplication(signup.signupId);
  const persistedOrganization = await store.getOrganization(provisioned.signup.orgId);
  const checkoutCall = stripeCalls.find((call) => call.type === "createCheckoutSession");

  assert.equal(result.checkout.checkoutSessionId, "cs_trial_1");
  assert.equal(result.checkout.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_trial_1");
  assert.ok(result.checkout.expiresAt);
  assert.equal(checkoutCall.payload.trialDays, null);
  assert.equal(checkoutCall.payload.metadata.signupId, signup.signupId);
  assert.equal(checkoutCall.payload.metadata.orgId, provisioned.signup.orgId);
  assert.equal(checkoutCall.payload.metadata.flow, "post_trial_checkout");
  assert.equal(persistedSignup.stripeCustomerId, "cus_trial_1");
  assert.equal(persistedSignup.stripeCheckoutSessionId, "cs_trial_1");
  assert.equal(persistedOrganization.billing.stripeCustomerId, "cus_trial_1");
  assert.equal(persistedOrganization.billing.status, "trialing");
});

test("checkout.session.completed updates provisioned contact signups instead of reprovisioning", async () => {
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

  const provisioned = await provisionContactSignupHandler({
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

  const outcome = await processStripeEventHandler({
    store,
    config: {
      gracePeriodDays: 7
    },
    event: {
      id: "evt_checkout_completed_1",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_trial_1",
          customer: "cus_trial_1",
          subscription: "sub_trial_1",
          client_reference_id: signup.signupId,
          metadata: {
            signupId: signup.signupId,
            orgId: provisioned.signup.orgId,
            flow: "post_trial_checkout"
          }
        }
      }
    }
  });

  const updatedSignup = await store.getSignupApplication(signup.signupId);
  const updatedOrganization = await store.getOrganization(provisioned.signup.orgId);
  const organizations = await store.listOrganizations();

  assert.equal(outcome.outcome.handled, true);
  assert.equal(updatedSignup.status, "provisioned");
  assert.equal(updatedSignup.stripeCustomerId, "cus_trial_1");
  assert.equal(updatedSignup.stripeSubscriptionId, "sub_trial_1");
  assert.equal(updatedSignup.stripeCheckoutSessionId, "cs_trial_1");
  assert.equal(updatedOrganization.billing.stripeCustomerId, "cus_trial_1");
  assert.equal(updatedOrganization.billing.stripeSubscriptionId, "sub_trial_1");
  assert.equal(organizations.length, 1);
});
