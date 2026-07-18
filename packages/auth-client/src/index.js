import crypto from "node:crypto";
import { resolveMfaState } from "../../platform-contracts/src/index.js";

export const SESSION_COOKIE_NAME = "halunasu_session";
export const CSRF_COOKIE_NAME = "halunasu_csrf";

const LOCAL_SESSION_SECRET = "local-only-halunasu-platform-session-secret";
const ACTIVE_ENTITLEMENT_STATUSES = Object.freeze(["enabled", "trialing"]);
const DEFAULT_GLOBAL_PRODUCT_ROLES = Object.freeze(["org_admin", "platform_admin"]);
const PRODUCT_CONTEXT_CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(process.env.PRODUCT_CONTEXT_CACHE_TTL_MS || "3000", 10) || 0
);
const PRODUCT_CONTEXT_CACHE_MAX_ENTRIES = 1000;
const PUBLIC_AUTH_ERROR_CODES = new Set(["mfa_required", "mfa_enrollment_required"]);
const productContextCache = new Map();

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
  requireTokenBoundary(session, options);
  const cacheKey = productContextCacheKey(session, productId);
  const cached = getCachedProductContext(input, cacheKey);
  if (cached) {
    requireVerifiedMfa(cached);
    return cached;
  }

  const identity = await platformStore.getLoginIdentity(session.organizationCode, session.loginId);
  if (!identity || identity.status !== "active" || Number(identity.tokenVersion || 0) !== Number(session.tokenVersion || 0)) {
    throw unauthorizedError("Invalid session");
  }

  const member = await platformStore.getMember(session.orgId, session.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  const effectiveSession = {
    ...session,
    globalRoles: Array.isArray(member.globalRoles) ? member.globalRoles : [],
    productRoles: member.productRoles && typeof member.productRoles === "object"
      ? member.productRoles
      : {}
  };
  const mfaState = resolveMfaState(identity, member);
  const mfaContext = {
    session: effectiveSession,
    identity,
    member,
    mfaRequired: mfaState.required,
    mfaEnrolled: mfaState.enrolled
  };
  requireVerifiedMfa(mfaContext);

  const entitlement = await platformStore.getProductEntitlement(session.orgId, productId);
  const entitlementAllowsUse = entitlementAllowsProductUse(entitlement, input.now);
  const roleAllowsUse = hasProductAccess(effectiveSession, productId, allowedProductRoles, globalRoles);
  if (!entitlementAllowsUse || !roleAllowsUse) {
    throw forbiddenError(`${productLabel} product access is required`);
  }

  const context = {
    session: effectiveSession,
    identity,
    member,
    mfaRequired: mfaState.required,
    mfaEnrolled: mfaState.enrolled,
    entitlement,
    productId
  };
  setCachedProductContext(input, cacheKey, context);
  return context;
}

function requireTokenBoundary(session = {}, options = {}) {
  const tokenType = String(session.tokenType || "").trim();
  if (!tokenType) {
    if (options.requireScopedToken === true) {
      throw forbiddenError("Scoped product token is required");
    }
    return;
  }

  if (options.requireScopedToken !== true || tokenType !== String(options.tokenType || "scoped_product_access")) {
    throw forbiddenError("Scoped product token cannot access this route");
  }
  if (String(session.productId || "") !== String(options.productId || "")) {
    throw forbiddenError("Scoped product token product mismatch");
  }
  if (options.audience && String(session.audience || "") !== String(options.audience)) {
    throw forbiddenError("Scoped product token audience mismatch");
  }
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (options.requiredScope && !scopes.includes(options.requiredScope)) {
    throw forbiddenError("Scoped product token scope is required");
  }
}

function requireVerifiedMfa(context) {
  if (!context.mfaRequired || (context.mfaEnrolled && context.session.mfaVerified === true)) {
    return;
  }

  const error = forbiddenError(context.mfaEnrolled
    ? "MFA verification is required"
    : "MFA enrollment is required");
  error.code = context.mfaEnrolled ? "mfa_required" : "mfa_enrollment_required";
  throw error;
}

export function entitlementAllowsProductUse(entitlement = {}, nowInput = new Date()) {
  const status = entitlement?.status || "";
  if (ACTIVE_ENTITLEMENT_STATUSES.includes(status)) {
    return true;
  }
  if (status !== "cancel_scheduled") {
    return false;
  }

  const now = nowInput instanceof Date ? nowInput : new Date(nowInput || Date.now());
  const currentPeriodEndMs = entitlement.currentPeriodEnd ? Date.parse(entitlement.currentPeriodEnd) : NaN;
  return Number.isFinite(currentPeriodEndMs) && currentPeriodEndMs > now.getTime();
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

export function publicAuthErrorCode(error = {}) {
  const code = typeof error.code === "string" ? error.code : "";
  return PUBLIC_AUTH_ERROR_CODES.has(code) ? code : "";
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

function productContextCacheKey(session = {}, productId = "") {
  return [
    productId,
    session.orgId,
    session.memberId,
    session.organizationCode,
    session.loginId,
    Number(session.tokenVersion || 0),
    session.issuedAt,
    Boolean(session.mfaVerified),
    session.csrfToken,
    session.expiresAt,
    session.tokenType,
    session.productId,
    session.audience,
    (Array.isArray(session.scopes) ? session.scopes : []).slice().sort().join(","),
    session.extensionId,
    session.deviceId,
    session.proofKeyChallenge
  ].join(":");
}

function productContextCacheEnabled(input = {}) {
  const env = String(input.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "").toLowerCase();
  return PRODUCT_CONTEXT_CACHE_TTL_MS > 0 && !["", "local", "test", "development"].includes(env);
}

function getCachedProductContext(input, cacheKey) {
  if (!productContextCacheEnabled(input) || !cacheKey) {
    return null;
  }
  const cached = productContextCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    productContextCache.delete(cacheKey);
    return null;
  }
  return cached.context;
}

function setCachedProductContext(input, cacheKey, context) {
  if (!productContextCacheEnabled(input) || !cacheKey) {
    return;
  }
  if (productContextCache.size >= PRODUCT_CONTEXT_CACHE_MAX_ENTRIES) {
    productContextCache.delete(productContextCache.keys().next().value);
  }
  productContextCache.set(cacheKey, {
    context,
    expiresAt: Date.now() + PRODUCT_CONTEXT_CACHE_TTL_MS
  });
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
