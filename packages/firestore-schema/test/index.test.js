import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collections,
  auditEventPath,
  chartingEncounterPath,
  dataRequestPath,
  departmentPath,
  facilityPath,
  feeSessionPath,
  loginIdentityKey,
  loginIdentityPath,
  organizationPath,
  passwordSetupTokenPath,
  patientAliasPath,
  patientPath,
  productEntitlementPath,
  rateLimitPath,
  referralPath,
  signupEmailTokenPath,
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
  assert.equal(
    dataRequestPath("org_123", "drq_456"),
    "organizations/org_123/data_requests/drq_456"
  );
  assert.equal(
    chartingEncounterPath("org_123", "enc_456"),
    "organizations/org_123/charting_encounters/enc_456"
  );
  assert.equal(
    feeSessionPath("org_123", "fee_456"),
    "organizations/org_123/fee_sessions/fee_456"
  );
  assert.equal(
    referralPath("org_123", "ref_456"),
    "organizations/org_123/referrals/ref_456"
  );
  assert.equal(signupApplicationPath("app_123"), "signup_applications/app_123");
  assert.equal(signupEmailTokenPath("emv_123"), "signup_email_tokens/emv_123");
  assert.equal(passwordSetupTokenPath("setup_123"), "password_setup_tokens/setup_123");
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
