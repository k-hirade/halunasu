import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collections,
  auditEventPath,
  departmentPath,
  facilityPath,
  loginIdentityKey,
  loginIdentityPath,
  organizationPath,
  patientAliasPath,
  patientPath,
  productEntitlementPath,
  rateLimitPath,
  signupApplicationPath
} from "../src/index.js";

test("builds platform document paths", () => {
  assert.equal(organizationPath("org_123"), "organizations/org_123");
  assert.equal(facilityPath("org_123", "fac_456"), "organizations/org_123/facilities/fac_456");
  assert.equal(departmentPath("org_123", "dep_456"), "organizations/org_123/departments/dep_456");
  assert.equal(patientPath("org_123", "pat_456"), "organizations/org_123/patients/pat_456");
  assert.equal(
    productEntitlementPath("org_123", "charting"),
    "organizations/org_123/product_entitlements/charting"
  );
  assert.equal(auditEventPath("org_123", "aud_456"), "organizations/org_123/audit_events/aud_456");
  assert.equal(signupApplicationPath("app_123"), "signup_applications/app_123");
  assert.equal(rateLimitPath("login:local:clinic:admin"), "rate_limits/login:local:clinic:admin");
  assert.equal(
    patientAliasPath("org_123", "pat_456", "alias_789"),
    "organizations/org_123/patients/pat_456/aliases/alias_789"
  );
});

test("builds login identity keys and paths", () => {
  assert.equal(loginIdentityKey("clinic-a", "doctor"), "clinic-a:doctor");
  assert.equal(loginIdentityPath("clinic-a", "doctor"), "login_identities/clinic-a:doctor");
});

test("rejects invalid path segments", () => {
  assert.throws(() => organizationPath("bad/id"), /must not contain/);
  assert.throws(() => patientPath("org_123", ""), /patientId is required/);
});

test("exports canonical collection names", () => {
  assert.equal(collections.organizations, "organizations");
  assert.equal(collections.patients, "patients");
});
