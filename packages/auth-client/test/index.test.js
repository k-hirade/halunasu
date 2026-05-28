import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignedSession } from "../../../services/platform-api/src/auth/session.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  forbiddenError,
  hasGlobalRole,
  hasProductAccess,
  hasProductRole,
  requirePlatformCsrf,
  requireProductContext,
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
  assert.equal(hasProductAccess(verified, "charting", ["doctor"]), true);
  assert.doesNotThrow(() => requirePlatformCsrf(headers, verified));
});

test("builds shared product context with entitlement and token version checks", async () => {
  const { token } = createSignedSession({
    orgId: "org_123",
    memberId: "mem_123",
    organizationCode: "clinic",
    loginId: "doctor@example.com",
    tokenVersion: 1,
    globalRoles: [],
    productRoles: { charting: ["doctor"] },
    csrfToken: "csrf_test"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const headers = {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=csrf_test`
  };
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic",
      loginId: "doctor@example.com",
      orgId: "org_123",
      memberId: "mem_123",
      tokenVersion: 1,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_123",
      orgId: "org_123",
      displayName: "Doctor",
      status: "active"
    }),
    getProductEntitlement: async () => ({
      productId: "charting",
      orgId: "org_123",
      status: "trialing"
    })
  };
  const context = await requireProductContext({
    headers,
    now: new Date("2026-05-28T00:01:00.000Z"),
    sessionSecret: "secret"
  }, {
    platformStore,
    productId: "charting",
    productLabel: "Charting",
    allowedProductRoles: ["doctor"]
  });

  assert.equal(context.session.orgId, "org_123");
  assert.equal(context.member.memberId, "mem_123");
  assert.equal(context.entitlement.status, "trialing");
});

test("rejects shared product context without entitlement", async () => {
  const { token } = createSignedSession({
    orgId: "org_123",
    memberId: "mem_123",
    organizationCode: "clinic",
    loginId: "doctor@example.com",
    tokenVersion: 1,
    globalRoles: [],
    productRoles: { charting: ["doctor"] },
    csrfToken: "csrf_test"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic",
      loginId: "doctor@example.com",
      orgId: "org_123",
      memberId: "mem_123",
      tokenVersion: 1,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_123",
      orgId: "org_123",
      displayName: "Doctor",
      status: "active"
    }),
    getProductEntitlement: async () => null
  };

  await assert.rejects(
    () => requireProductContext({
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=csrf_test`
      },
      now: new Date("2026-05-28T00:01:00.000Z"),
      sessionSecret: "secret"
    }, {
      platformStore,
      productId: "charting",
      productLabel: "Charting",
      allowedProductRoles: ["doctor"]
    }),
    /Charting product access is required/
  );
});

test("rejects invalid CSRF tokens", () => {
  assert.throws(
    () => requirePlatformCsrf({ cookie: `${CSRF_COOKIE_NAME}=left`, "x-csrf-token": "right" }, { csrfToken: "left" }),
    /CSRF token mismatch/
  );
});

test("supports environment-specific Platform cookie names", () => {
  const { token, session } = createSignedSession({
    orgId: "org_stg",
    memberId: "mem_stg",
    organizationCode: "clinic",
    loginId: "doctor@example.com",
    tokenVersion: 1,
    globalRoles: [],
    productRoles: { fee: ["admin"] },
    csrfToken: "csrf_stg"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const headers = {
    cookie: `halunasu_stg_session=${encodeURIComponent(token)}; halunasu_stg_csrf=csrf_stg`,
    "x-csrf-token": "csrf_stg"
  };
  const verified = verifyPlatformSessionFromHeaders(headers, {
    now: new Date("2026-05-28T00:01:00.000Z"),
    sessionSecret: "secret",
    sessionCookieName: "halunasu_stg_session"
  });

  assert.equal(verified.orgId, "org_stg");
  assert.doesNotThrow(() => requirePlatformCsrf(headers, session, {
    csrfCookieName: "halunasu_stg_csrf"
  }));
});

test("builds forbidden errors with status code", () => {
  const error = forbiddenError("nope");

  assert.equal(error.statusCode, 403);
  assert.equal(error.message, "nope");
});
