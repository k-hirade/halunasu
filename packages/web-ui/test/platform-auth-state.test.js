import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPlatformSessionFullyAuthenticated,
  platformSessionAuthAction,
  shouldPromptMfaEnrollment
} from "../src/platform-auth-state.js";

test("routes an MFA-unregistered privileged session to enrollment", () => {
  const session = {
    globalRoles: ["org_admin"],
    mfaRequired: true,
    mfaEnrolled: false,
    mfaVerified: false
  };

  assert.equal(platformSessionAuthAction(session), "enroll");
  assert.equal(shouldPromptMfaEnrollment(session), true);
  assert.equal(isPlatformSessionFullyAuthenticated(session), false);
});

test("routes an enrolled but unverified session back to credential verification", () => {
  assert.equal(platformSessionAuthAction({
    globalRoles: ["billing_admin"],
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: false
  }), "reauthenticate");
});

test("accepts a fully verified privileged session", () => {
  assert.equal(platformSessionAuthAction({
    globalRoles: ["org_owner"],
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true
  }), "authenticated");
});

test("allows an explicit non-privileged session to skip MFA", () => {
  assert.equal(platformSessionAuthAction({
    globalRoles: ["doctor"],
    mfaRequired: false,
    mfaEnrolled: false,
    mfaVerified: false
  }), "authenticated");
});

test("fails closed for every legacy privileged role when new flags are absent", () => {
  for (const role of ["platform_admin", "org_owner", "org_admin", "it_admin", "billing_admin"]) {
    assert.equal(
      platformSessionAuthAction({ globalRoles: [role], mfaVerified: false }),
      "enroll",
      `${role} must not bypass MFA on an older API response`
    );
  }
  assert.equal(
    platformSessionAuthAction({ globalRoles: [], productRoles: { fee: ["admin"] }, mfaVerified: false }),
    "enroll"
  );
});
