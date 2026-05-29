import assert from "node:assert/strict";
import test from "node:test";

import {
  getOrganizationAccessState,
  getOrganizationAccessStatus,
  hasOrganizationBillingAdmin,
  hasPlatformBillingBypass,
  organizationAccessAllowsAuthenticatedLogin,
  organizationAccessAllowsClinicalUse,
  organizationAccessAllowsReadOnlyUse,
  organizationAccessDeniedMessage
} from "../src/index.js";

test("billing access helpers default legacy organizations to active", () => {
  assert.deepEqual(getOrganizationAccessState(null), {
    status: "active",
    reason: null,
    restrictedAt: null,
    updatedAt: null
  });
  assert.equal(getOrganizationAccessStatus({}), "active");
  assert.equal(organizationAccessAllowsAuthenticatedLogin({}, { roles: ["doctor"] }), true);
  assert.equal(organizationAccessAllowsClinicalUse({}, { roles: ["doctor"] }), true);
});

test("billing access helpers enforce read-only and org admin exceptions", () => {
  const billingActionRequired = { access: { status: "billing_action_required", reason: "billing.past_due" } };
  const suspended = { access: { status: "suspended", reason: "billing.grace_period_expired" } };
  const canceled = { access: { status: "canceled", reason: "billing.subscription_deleted" } };

  assert.equal(organizationAccessAllowsAuthenticatedLogin(billingActionRequired, { roles: ["doctor"] }), true);
  assert.equal(organizationAccessAllowsReadOnlyUse(billingActionRequired, { roles: ["doctor"] }), true);
  assert.equal(organizationAccessAllowsClinicalUse(billingActionRequired, { roles: ["doctor"] }), false);
  assert.match(organizationAccessDeniedMessage(billingActionRequired, { roles: ["doctor"], mode: "clinical" }), /お支払い情報/);

  assert.equal(organizationAccessAllowsAuthenticatedLogin(suspended, { roles: ["doctor"] }), false);
  assert.equal(organizationAccessAllowsAuthenticatedLogin(suspended, { roles: ["org_admin"] }), true);
  assert.equal(organizationAccessAllowsReadOnlyUse(canceled, { roles: ["org_admin"] }), true);
  assert.equal(organizationAccessAllowsClinicalUse(canceled, { roles: ["org_admin"] }), false);
});

test("platform admins bypass billing access restrictions", () => {
  const suspended = { access: { status: "suspended" } };

  assert.equal(hasPlatformBillingBypass(["platform_admin"]), true);
  assert.equal(hasOrganizationBillingAdmin(["org_admin"]), true);
  assert.equal(organizationAccessAllowsAuthenticatedLogin(suspended, { roles: ["platform_admin"] }), true);
  assert.equal(organizationAccessAllowsReadOnlyUse(suspended, { roles: ["platform_admin"] }), true);
  assert.equal(organizationAccessAllowsClinicalUse(suspended, { roles: ["platform_admin"] }), true);
  assert.equal(organizationAccessDeniedMessage(suspended, { roles: ["platform_admin"], mode: "clinical" }), null);
});
