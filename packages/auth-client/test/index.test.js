import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignedSession } from "../../../services/platform-api/src/auth/session.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  forbiddenError,
  hasGlobalRole,
  hasProductRole,
  requirePlatformCsrf,
  verifyPlatformSessionFromHeaders
} from "../src/index.js";

test("verifies Platform session cookies and product roles", () => {
  const { token, session } = createSignedSession({
    orgId: "org_123",
    memberId: "mem_123",
    organizationCode: "clinic",
    loginId: "doctor@example.com",
    tokenVersion: 1,
    globalRoles: ["org_admin"],
    productRoles: { charting: ["admin"] },
    csrfToken: "csrf_test"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const headers = {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=csrf_test`,
    "x-csrf-token": "csrf_test"
  };
  const verified = verifyPlatformSessionFromHeaders(headers, {
    now: new Date("2026-05-28T00:01:00.000Z"),
    sessionSecret: "secret"
  });

  assert.equal(verified.orgId, "org_123");
  assert.equal(session.csrfToken, "csrf_test");
  assert.equal(hasProductRole(verified, "charting", ["admin"]), true);
  assert.equal(hasGlobalRole(verified, ["org_admin"]), true);
  assert.doesNotThrow(() => requirePlatformCsrf(headers, verified));
});

test("rejects invalid CSRF tokens", () => {
  assert.throws(
    () => requirePlatformCsrf({ cookie: `${CSRF_COOKIE_NAME}=left`, "x-csrf-token": "right" }, { csrfToken: "left" }),
    /CSRF token mismatch/
  );
});

test("builds forbidden errors with status code", () => {
  const error = forbiddenError("nope");

  assert.equal(error.statusCode, 403);
  assert.equal(error.message, "nope");
});
