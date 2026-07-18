import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignedSession } from "../../../services/platform-api/src/auth/session.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  entitlementAllowsProductUse,
  forbiddenError,
  hasGlobalRole,
  hasProductAccess,
  hasProductRole,
  publicAuthErrorCode,
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

test("allows cancel_scheduled entitlement until currentPeriodEnd", () => {
  assert.equal(entitlementAllowsProductUse({
    status: "cancel_scheduled",
    currentPeriodEnd: "2026-05-29T00:00:00.000Z"
  }, new Date("2026-05-28T00:00:00.000Z")), true);
  assert.equal(entitlementAllowsProductUse({
    status: "cancel_scheduled",
    currentPeriodEnd: "2026-05-27T00:00:00.000Z"
  }, new Date("2026-05-28T00:00:00.000Z")), false);
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
      globalRoles: [],
      productRoles: { charting: ["doctor"] },
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

test("uses current member roles instead of stale roles in the signed session", async () => {
  const { token } = createSignedSession({
    orgId: "org_roles",
    memberId: "mem_roles",
    organizationCode: "clinic-roles",
    loginId: "former-doctor@example.com",
    tokenVersion: 1,
    globalRoles: [],
    productRoles: { charting: ["doctor"] },
    csrfToken: "csrf_roles"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic-roles",
      loginId: "former-doctor@example.com",
      orgId: "org_roles",
      memberId: "mem_roles",
      tokenVersion: 1,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_roles",
      orgId: "org_roles",
      globalRoles: [],
      productRoles: { charting: ["viewer"] },
      status: "active"
    }),
    getProductEntitlement: async () => ({ productId: "charting", status: "enabled" })
  };

  await assert.rejects(
    () => requireProductContext({
      headers: { authorization: `Bearer ${token}` },
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

test("rejects product API access until required MFA enrollment is verified", async () => {
  const { token } = createSignedSession({
    orgId: "org_mfa",
    memberId: "mem_mfa",
    organizationCode: "clinic-mfa",
    loginId: "admin@example.com",
    tokenVersion: 1,
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    mfaRequired: true,
    mfaEnrolled: false,
    mfaVerified: false,
    csrfToken: "csrf_mfa"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic-mfa",
      loginId: "admin@example.com",
      orgId: "org_mfa",
      memberId: "mem_mfa",
      tokenVersion: 1,
      mfaRequired: true,
      mfaEnrolled: false,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_mfa",
      orgId: "org_mfa",
      globalRoles: ["org_admin"],
      status: "active"
    }),
    getProductEntitlement: async () => ({ productId: "fee", status: "enabled" })
  };

  await assert.rejects(
    () => requireProductContext({
      headers: { authorization: `Bearer ${token}` },
      now: new Date("2026-05-28T00:01:00.000Z"),
      sessionSecret: "secret"
    }, {
      platformStore,
      productId: "fee",
      productLabel: "Fee",
      allowedProductRoles: ["admin"]
    }),
    (error) => error.statusCode === 403 && error.code === "mfa_enrollment_required"
  );
});

test("accepts product API access after required MFA is enrolled and verified", async () => {
  const { token } = createSignedSession({
    orgId: "org_mfa",
    memberId: "mem_mfa",
    organizationCode: "clinic-mfa",
    loginId: "admin@example.com",
    tokenVersion: 2,
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true,
    csrfToken: "csrf_mfa"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic-mfa",
      loginId: "admin@example.com",
      orgId: "org_mfa",
      memberId: "mem_mfa",
      tokenVersion: 2,
      mfaRequired: true,
      mfaEnrolled: true,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_mfa",
      orgId: "org_mfa",
      globalRoles: ["org_admin"],
      status: "active"
    }),
    getProductEntitlement: async () => ({ productId: "fee", status: "enabled" })
  };

  const context = await requireProductContext({
    headers: { authorization: `Bearer ${token}` },
    now: new Date("2026-05-28T00:01:00.000Z"),
    sessionSecret: "secret"
  }, {
    platformStore,
    productId: "fee",
    productLabel: "Fee",
    allowedProductRoles: ["admin"]
  });

  assert.equal(context.mfaRequired, true);
  assert.equal(context.mfaEnrolled, true);
});

test("enforces scoped product tokens in both directions", async () => {
  const basePayload = {
    orgId: "org_sidecar",
    memberId: "mem_sidecar",
    organizationCode: "clinic-sidecar",
    loginId: "clerk@example.com",
    tokenVersion: 3,
    globalRoles: [],
    productRoles: { homis_sidecar: ["medical_clerk"], fee: ["medical_clerk"] },
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true,
    csrfToken: "csrf_sidecar"
  };
  const scoped = createSignedSession({
    ...basePayload,
    tokenType: "scoped_product_access",
    productId: "homis_sidecar",
    audience: "fee-api",
    scopes: ["sidecar:calculate"]
  }, {
    now: new Date("2026-07-18T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const ordinary = createSignedSession(basePayload, {
    now: new Date("2026-07-18T00:00:00.000Z"),
    sessionSecret: "secret"
  });
  const platformStore = {
    getLoginIdentity: async () => ({
      organizationCode: "clinic-sidecar",
      loginId: "clerk@example.com",
      orgId: "org_sidecar",
      memberId: "mem_sidecar",
      tokenVersion: 3,
      mfaRequired: true,
      mfaEnrolled: true,
      status: "active"
    }),
    getMember: async () => ({
      memberId: "mem_sidecar",
      orgId: "org_sidecar",
      globalRoles: [],
      productRoles: { homis_sidecar: ["medical_clerk"], fee: ["medical_clerk"] },
      status: "active"
    }),
    getProductEntitlement: async (_orgId, productId) => ({ productId, status: "enabled" })
  };
  const inputFor = (token) => ({
    headers: { authorization: `Bearer ${token}` },
    now: new Date("2026-07-18T00:01:00.000Z"),
    sessionSecret: "secret"
  });

  const context = await requireProductContext(inputFor(scoped.token), {
    platformStore,
    productId: "homis_sidecar",
    allowedProductRoles: ["medical_clerk"],
    requireScopedToken: true,
    tokenType: "scoped_product_access",
    audience: "fee-api",
    requiredScope: "sidecar:calculate"
  });
  assert.equal(context.productId, "homis_sidecar");

  await assert.rejects(() => requireProductContext(inputFor(ordinary.token), {
    platformStore,
    productId: "homis_sidecar",
    allowedProductRoles: ["medical_clerk"],
    requireScopedToken: true,
    requiredScope: "sidecar:calculate"
  }), /Scoped product token is required/);
  await assert.rejects(() => requireProductContext(inputFor(scoped.token), {
    platformStore,
    productId: "fee",
    allowedProductRoles: ["medical_clerk"]
  }), /cannot access this route/);
  await assert.rejects(() => requireProductContext(inputFor(scoped.token), {
    platformStore,
    productId: "homis_sidecar",
    allowedProductRoles: ["medical_clerk"],
    requireScopedToken: true,
    audience: "wrong-api",
    requiredScope: "sidecar:calculate"
  }), /audience mismatch/);
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

test("exposes only public MFA error codes", () => {
  assert.equal(publicAuthErrorCode({ code: "mfa_required" }), "mfa_required");
  assert.equal(publicAuthErrorCode({ code: "mfa_enrollment_required" }), "mfa_enrollment_required");
  assert.equal(publicAuthErrorCode({ code: "FEE_CALCULATION_JOB_LEASE_CONFLICT" }), "");
  assert.equal(publicAuthErrorCode({ code: "ENOENT" }), "");
});
