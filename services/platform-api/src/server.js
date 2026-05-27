import http from "node:http";
import { validateLoginInput } from "../../../packages/platform-contracts/src/index.js";
import { createOtpAuthUrl, generateMfaSecret, verifyTotpCode } from "./auth/mfa.js";
import { verifyPassword } from "./auth/password.js";
import {
  CSRF_COOKIE_NAME,
  clearSessionCookieHeaders,
  createCsrfToken,
  csrfCookieHeader,
  csrfTokenFromHeaders,
  parseCookies,
  sessionCookieHeader,
  sessionTokenFromHeaders,
  createSignedSession,
  unauthorizedError,
  verifySignedSession
} from "./auth/session.js";
import { createPlatformStoreFromEnv } from "./store/create-store.js";

export function createPlatformApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const store = options.store || createPlatformStoreFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handlePlatformApiRequest({
        method: req.method,
        path: req.url,
        body,
        env,
        projectId,
        region,
        startedAt,
        store,
        headers: req.headers
      });

      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export function resolvePlatformApiResponse(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/healthz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api"
      }
    };
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api",
        env: input.env || "local",
        projectId: input.projectId || "medical-core-stg",
        region: input.region || "asia-northeast1",
        startedAt: input.startedAt instanceof Date
          ? input.startedAt.toISOString()
          : new Date().toISOString()
      }
    };
  }

  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message: "Route not found"
    }
  };
}

export async function handlePlatformApiRequest(input = {}) {
  try {
    return await routePlatformApiRequest(input);
  } catch (error) {
    return errorResponse(error);
  }
}

async function routePlatformApiRequest(input = {}) {
  const healthResponse = resolvePlatformApiResponse(input);
  if (healthResponse.statusCode !== 404 || !String(input.path || "").startsWith("/v1/")) {
    return healthResponse;
  }

  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const store = input.store || createPlatformStoreFromEnv();

  if (method === "POST" && matches(parts, ["v1", "auth", "login"])) {
    return login(input, store);
  }

  if (method === "GET" && matches(parts, ["v1", "auth", "session"])) {
    const context = await requireSession(input, store);
    return ok({ authenticated: true, session: sessionView(context) });
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "logout"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    await store.revokeMemberSessions(context.identity);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.logout",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    return ok(
      { authenticated: false },
      { "set-cookie": clearSessionCookieHeaders(cookieOptions(input)) }
    );
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "mfa", "enroll"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    requirePrivilegedMember(context.member);

    const secret = generateMfaSecret();
    await store.beginMfaEnrollment(context.identity, secret);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.mfa_enrollment_started",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    return created({
      mfa: {
        status: "pending",
        secret,
        otpauthUrl: createOtpAuthUrl({
          accountName: `${context.session.organizationCode}:${context.session.loginId}`,
          secret
        })
      }
    });
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "mfa", "verify"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);

    const code = requiredBodyString(input.body, "code");
    const secret = context.identity.mfaPendingSecret || context.identity.mfaSecret;
    if (!secret || !verifyTotpCode(secret, code, { now: input.now })) {
      throw unauthorizedError("Invalid MFA code");
    }

    const updatedIdentity = await store.completeMfaEnrollment(context.identity);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.mfa_verified",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    const sessionResponse = createSessionResponse({
      input,
      identity: updatedIdentity,
      member: context.member,
      organizationCode: context.session.organizationCode,
      mfaVerified: true
    });

    return ok({
      mfa: {
        enrolled: true
      },
      session: sessionResponse.sessionView,
      csrfToken: sessionResponse.csrfToken
    }, sessionResponse.headers);
  }

  if (method === "GET" && matches(parts, ["v1", "organizations"])) {
    return ok({ organizations: await store.listOrganizations() });
  }

  if (method === "POST" && matches(parts, ["v1", "organizations"])) {
    return created({ organization: await store.createOrganization(input.body || {}) });
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "organizations") {
    const organization = await store.getOrganization(parts[2]);
    if (!organization) {
      return notFound("organization not found");
    }
    return ok({ organization });
  }

  if (method === "GET" && isOrgChildCollection(parts, "members")) {
    return ok({ members: await store.listMembers(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "members")) {
    return created({ member: await store.createMember(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "members")) {
    const member = await store.getMember(parts[2], parts[4]);
    if (!member) {
      return notFound("member not found");
    }
    return ok({ member });
  }

  if (method === "GET" && isOrgChildCollection(parts, "facilities")) {
    return ok({ facilities: await store.listFacilities(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "facilities")) {
    return created({ facility: await store.createFacility(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "facilities")) {
    const facility = await store.getFacility(parts[2], parts[4]);
    if (!facility) {
      return notFound("facility not found");
    }
    return ok({ facility });
  }

  if (method === "GET" && isOrgChildCollection(parts, "departments")) {
    return ok({ departments: await store.listDepartments(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "departments")) {
    return created({ department: await store.createDepartment(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "departments")) {
    const department = await store.getDepartment(parts[2], parts[4]);
    if (!department) {
      return notFound("department not found");
    }
    return ok({ department });
  }

  if (method === "GET" && isOrgChildCollection(parts, "patients")) {
    return ok({ patients: await store.listPatients(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "patients")) {
    return created({ patient: await store.createPatient(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "patients")) {
    const patient = await store.getPatient(parts[2], parts[4]);
    if (!patient) {
      return notFound("patient not found");
    }
    return ok({ patient });
  }

  if (method === "GET" && isOrgChildCollection(parts, "product-entitlements")) {
    return ok({ productEntitlements: await store.listProductEntitlements(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "product-entitlements")) {
    return created({ productEntitlement: await store.upsertProductEntitlement(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "product-entitlements")) {
    const productEntitlement = await store.getProductEntitlement(parts[2], parts[4]);
    if (!productEntitlement) {
      return notFound("product entitlement not found");
    }
    return ok({ productEntitlement });
  }

  if (method === "GET" && isOrgChildCollection(parts, "audit-events")) {
    return ok({ auditEvents: await store.listAuditEvents(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "audit-events")) {
    return created({ auditEvent: await store.createAuditEvent(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "audit-events")) {
    const auditEvent = await store.getAuditEvent(parts[2], parts[4]);
    if (!auditEvent) {
      return notFound("audit event not found");
    }
    return ok({ auditEvent });
  }

  return notFound("Route not found");
}

async function login(input, store) {
  const credentials = validateLoginInput(input.body || {});
  const identity = await store.getLoginIdentity(credentials.organizationCode, credentials.loginId);
  if (!identity || identity.status !== "active") {
    throw unauthorizedError("Invalid credentials");
  }

  const member = await store.getMember(identity.orgId, identity.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid credentials");
  }

  if (!verifyPassword(credentials.password, identity.passwordHash)) {
    await store.recordLoginFailure(identity);
    await store.createAuditEvent(identity.orgId, {
      eventType: "auth.login_failed",
      actorMemberId: identity.memberId,
      actorLoginId: identity.loginId,
      safePayload: { reason: "invalid_password" }
    });
    throw unauthorizedError("Invalid credentials");
  }

  if (identity.mfaRequired && identity.mfaEnrolled) {
    if (!credentials.mfaCode) {
      const error = unauthorizedError("MFA code is required");
      error.code = "mfa_required";
      throw error;
    }

    if (!verifyTotpCode(identity.mfaSecret, credentials.mfaCode, { now: input.now })) {
      await store.recordLoginFailure(identity);
      throw unauthorizedError("Invalid MFA code");
    }
  }

  const refreshedIdentity = await store.recordLoginSuccess(identity);
  await store.createAuditEvent(identity.orgId, {
    eventType: "auth.login_succeeded",
    actorMemberId: identity.memberId,
    actorLoginId: identity.loginId,
    safePayload: { mfaVerified: Boolean(identity.mfaRequired && identity.mfaEnrolled) }
  });

  const sessionResponse = createSessionResponse({
    input,
    identity: refreshedIdentity,
    member,
    organizationCode: credentials.organizationCode,
    mfaVerified: Boolean(identity.mfaRequired && identity.mfaEnrolled)
  });

  return ok({
    session: sessionResponse.sessionView,
    csrfToken: sessionResponse.csrfToken
  }, sessionResponse.headers);
}

async function requireSession(input, store) {
  const token = sessionTokenFromHeaders(input.headers || {});
  const session = verifySignedSession(token, sessionOptions(input));
  const identity = await store.getLoginIdentity(session.organizationCode, session.loginId);

  if (!identity || identity.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  if (Number(identity.tokenVersion) !== Number(session.tokenVersion)) {
    throw unauthorizedError("Session revoked");
  }

  const member = await store.getMember(session.orgId, session.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  return { session, identity, member };
}

function requireCsrf(input, session) {
  const headerToken = csrfTokenFromHeaders(input.headers || {});
  const cookieToken = parseCookies(headerValue(input.headers || {}, "cookie"))[CSRF_COOKIE_NAME];

  if (!headerToken || !cookieToken || headerToken !== session.csrfToken || cookieToken !== session.csrfToken) {
    const error = new Error("CSRF token mismatch");
    error.name = "ForbiddenError";
    error.statusCode = 403;
    throw error;
  }
}

function requirePrivilegedMember(member) {
  if (member.globalRoles.includes("org_admin") || member.globalRoles.includes("billing_admin")) {
    return;
  }

  const error = new Error("Privileged member role is required");
  error.name = "ForbiddenError";
  error.statusCode = 403;
  throw error;
}

function createSessionResponse({ input, identity, member, organizationCode, mfaVerified }) {
  const csrfToken = createCsrfToken();
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: member.globalRoles,
    productRoles: member.productRoles,
    mfaVerified,
    csrfToken
  }, sessionOptions(input));

  return {
    csrfToken,
    sessionView: publicSessionView(session),
    headers: {
      "set-cookie": [
        sessionCookieHeader(token, cookieOptions(input)),
        csrfCookieHeader(csrfToken, cookieOptions(input))
      ]
    }
  };
}

function sessionView(context) {
  return publicSessionView(context.session);
}

function publicSessionView(session) {
  return {
    orgId: session.orgId,
    memberId: session.memberId,
    organizationCode: session.organizationCode,
    loginId: session.loginId,
    globalRoles: session.globalRoles || [],
    productRoles: session.productRoles || {},
    mfaVerified: Boolean(session.mfaVerified),
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt
  };
}

function sessionOptions(input) {
  return {
    sessionSecret: input.sessionSecret || process.env.APP_SESSION_SIGNING_SECRET,
    now: input.now,
    ttlSeconds: input.sessionTtlSeconds
  };
}

function cookieOptions(input) {
  return {
    secure: Boolean(input.secureCookies),
    ttlSeconds: input.sessionTtlSeconds
  };
}

function requiredBodyString(body = {}, field) {
  if (typeof body[field] !== "string" || !body[field].trim()) {
    const error = new Error(`${field} is required`);
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = field;
    throw error;
  }

  return body[field].trim();
}

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(payload);
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }
}

function ok(body, headers = {}) {
  return {
    statusCode: 200,
    body,
    headers
  };
}

function created(body, headers = {}) {
  return {
    statusCode: 201,
    body,
    headers
  };
}

function notFound(message) {
  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message
    }
  };
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const errorCode = statusCode === 500 ? "internal_error" : error.code || toErrorCode(error.name);

  return {
    statusCode,
    body: {
      error: errorCode,
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field
    }
  };
}

function toErrorCode(name) {
  return String(name || "error")
    .replace(/Error$/, "")
    .replace(/[A-Z]/g, (letter, index) => `${index === 0 ? "" : "_"}${letter.toLowerCase()}`) || "error";
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}

function isOrgChildCollection(parts, collectionName) {
  return parts.length === 4
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
}

function isOrgChildDocument(parts, collectionName) {
  return parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
}

function headerValue(headers, name) {
  const direct = headers[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct.join("; ") : direct;
  }

  const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = foundKey ? headers[foundKey] : undefined;
  return Array.isArray(value) ? value.join("; ") : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PLATFORM_API_PORT || "8080", 10);
  const server = createPlatformApiServer();

  server.listen(port, () => {
    console.log(`platform-api listening on :${port}`);
  });
}
