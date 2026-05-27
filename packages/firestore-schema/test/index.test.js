import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collections,
  loginIdentityKey,
  loginIdentityPath,
  organizationPath,
  patientAliasPath,
  patientPath
} from "../src/index.js";

test("builds platform document paths", () => {
  assert.equal(organizationPath("org_123"), "organizations/org_123");
  assert.equal(patientPath("org_123", "pat_456"), "organizations/org_123/patients/pat_456");
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

