import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "halunasu_session";
export const CSRF_COOKIE_NAME = "halunasu_csrf";

const LOCAL_SESSION_SECRET = "local-only-halunasu-platform-session-secret";
const ACTIVE_ENTITLEMENT_STATUSES = Object.freeze(["enabled", "trialing"]);
const DEFAULT_GLOBAL_PRODUCT_ROLES = Object.freeze(["org_admin", "platform_admin"]);

export function verifyPlatformSessionFromHeaders(headers = {}, options = {}) {
  const token = platformSessionTokenFromHeaders(headers, options);
  return verifySignedPlatformSession(token, options);
}

export function verifySignedPlatformSession(token, options = {}) {
  if (typeof token !== "string" || !token.includes(".")) {
    throw unauthorizedError("Invalid session");
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = sign(encodedPayload, sessionSecret(options));
  if (!safeEqual(signature, expectedSignature)) {
    throw unauthorizedError("Invalid session");
  }

  let session;
  try {
    session = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw unauthorizedError("Invalid session");
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!session.expiresAt || new Date(session.expiresAt).getTime() <= now.getTime()) {
    throw unauthorizedError("Session expired");
  }

  return session;
}

export function requirePlatformCsrf(headers = {}, session = {}, options = {}) {
  const cookieToken = parseCookies(headerValue(headers, "cookie"))[csrfCookieName(options)];
  const headerToken = headerValue(headers, "x-csrf-token");

  if (!cookieToken || !headerToken || cookieToken !== headerToken || cookieToken !== session.csrfToken) {
    const error = new Error("CSRF token mismatch");
    error.name = "ForbiddenError";
    error.statusCode = 403;
    throw error;
  }
}

export function platformSessionTokenFromHeaders(headers = {}, options = {}) {
  const bearer = bearerTokenFromHeaders(headers);
  if (bearer) {
    return bearer;
  }

  return parseCookies(headerValue(headers, "cookie"))[sessionCookieName(options)];
}

export function sessionCookieName(options = {}) {
  return options.sessionCookieName || process.env.APP_SESSION_COOKIE_NAME || SESSION_COOKIE_NAME;
}

export function csrfCookieName(options = {}) {
  return options.csrfCookieName || process.env.APP_CSRF_COOKIE_NAME || CSRF_COOKIE_NAME;
}

export function hasProductRole(session = {}, productId, allowedRoles = []) {
  const roles = session.productRoles?.[productId] || [];
  if (!allowedRoles.length) {
    return roles.length > 0;
  }

  return roles.some((role) => allowedRoles.includes(role));
}

export function hasGlobalRole(session = {}, roles = []) {
  return (session.globalRoles || []).some((role) => roles.includes(role));
}

export function hasProductAccess(session = {}, productId, allowedProductRoles = [], globalRoles = DEFAULT_GLOBAL_PRODUCT_ROLES) {
  return hasProductRole(session, productId, allowedProductRoles) || hasGlobalRole(session, globalRoles);
}

export async function requireProductContext(input = {}, options = {}) {
  const {
    platformStore,
    productId,
    allowedProductRoles = [],
    globalRoles = DEFAULT_GLOBAL_PRODUCT_ROLES,
    productLabel = productId || "Product"
  } = options;
  if (!platformStore) {
    throw new TypeError("platformStore is required");
  }
  if (!productId) {
    throw new TypeError("productId is required");
  }

  const session = verifyPlatformSessionFromHeaders(input.headers || {}, {
    env: input.env,
    now: input.now,
    sessionSecret: input.sessionSecret,
    sessionCookieName: input.sessionCookieName
  });
  const identity = await platformStore.getLoginIdentity(session.organizationCode, session.loginId);
  if (!identity || identity.status !== "active" || Number(identity.tokenVersion || 0) !== Number(session.tokenVersion || 0)) {
    throw unauthorizedError("Invalid session");
  }

  const member = await platformStore.getMember(session.orgId, session.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  const entitlement = await platformStore.getProductEntitlement(session.orgId, productId);
  const entitlementAllowsUse = ACTIVE_ENTITLEMENT_STATUSES.includes(entitlement?.status);
  const roleAllowsUse = hasProductAccess(session, productId, allowedProductRoles, globalRoles);
  if (!entitlementAllowsUse || !roleAllowsUse) {
    throw forbiddenError(`${productLabel} product access is required`);
  }

  return {
    session,
    identity,
    member,
    entitlement,
    productId
  };
}

export function parseCookies(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf("=");
        if (separatorIndex === -1) {
          return [cookie, ""];
        }

        return [
          cookie.slice(0, separatorIndex),
          decodeURIComponent(cookie.slice(separatorIndex + 1))
        ];
      })
  );
}

export function unauthorizedError(message = "Unauthorized") {
  const error = new Error(message);
  error.name = "UnauthorizedError";
  error.statusCode = 401;
  return error;
}

export function forbiddenError(message = "Forbidden") {
  const error = new Error(message);
  error.name = "ForbiddenError";
  error.statusCode = 403;
  return error;
}

function bearerTokenFromHeaders(headers = {}) {
  const value = headerValue(headers, "authorization");
  if (!value || !value.startsWith("Bearer ")) {
    return "";
  }

  return value.slice("Bearer ".length).trim();
}

function sessionSecret(options = {}) {
  const configured = options.sessionSecret || process.env.APP_SESSION_SIGNING_SECRET;
  if (configured) {
    return configured;
  }
  if (requiresConfiguredSecret(options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV)) {
    throw new Error("APP_SESSION_SIGNING_SECRET is required outside local/test environments");
  }

  return LOCAL_SESSION_SECRET;
}

function requiresConfiguredSecret(env) {
  return !["", "local", "test", "development"].includes(String(env || "local").toLowerCase());
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
