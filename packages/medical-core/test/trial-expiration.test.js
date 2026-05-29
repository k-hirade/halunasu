import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryStore } from "../src/store/in-memory-store.js";
import { enforceTrialExpirationHandler } from "../../../services/billing-api-legacy/src/handlers/enforce-trial-expiration.js";

test("trial expiration moves unpaid trial orgs to pending checkout and billing_action_required", async () => {
  const store = new InMemoryStore();
  const provisioned = await store.provisionOrganizationWithAdminMember({
    organizationCode: "trial-clinic",
    displayName: "トライアル病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    billing: {
      status: "trialing",
      stripeCustomerId: "cus_trial_1",
      stripeSubscriptionId: null,
      trialEndsAt: "2026-04-20T00:00:00.000Z"
    },
    access: {
      status: "active"
    }
  });

  const result = await enforceTrialExpirationHandler({
    store,
    now: "2026-04-28T00:00:00.000Z"
  });
  const updatedOrganization = await store.getOrganization(provisioned.organization.orgId);

  assert.equal(result.checkedCount, 1);
  assert.equal(result.expiredCount, 1);
  assert.equal(updatedOrganization.billing.status, "pending_checkout");
  assert.equal(updatedOrganization.access.status, "billing_action_required");
  assert.equal(updatedOrganization.access.reason, "billing.trial_expired");
});

test("trial expiration skips orgs that already have subscriptions or active trial time remaining", async () => {
  const store = new InMemoryStore();

  await store.provisionOrganizationWithAdminMember({
    organizationCode: "active-trial",
    displayName: "継続トライアル病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    billing: {
      status: "trialing",
      stripeCustomerId: "cus_trial_2",
      stripeSubscriptionId: null,
      trialEndsAt: "2026-05-10T00:00:00.000Z"
    },
    access: {
      status: "active"
    }
  });

  const subscribed = await store.provisionOrganizationWithAdminMember({
    organizationCode: "subscribed-trial",
    displayName: "決済済み病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    billing: {
      status: "trialing",
      stripeCustomerId: "cus_trial_3",
      stripeSubscriptionId: "sub_trial_3",
      trialEndsAt: "2026-04-20T00:00:00.000Z"
    },
    access: {
      status: "active"
    }
  });

  const result = await enforceTrialExpirationHandler({
    store,
    now: "2026-04-28T00:00:00.000Z"
  });
  const untouchedSubscribed = await store.getOrganization(subscribed.organization.orgId);

  assert.equal(result.expiredCount, 0);
  assert.equal(untouchedSubscribed.billing.status, "trialing");
  assert.equal(untouchedSubscribed.access.status, "active");
});
