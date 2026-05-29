import crypto from "node:crypto";

import { verifyOperatorAccessToken } from "./pairing-token.js";

export const DEFAULT_OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const OPERATOR_SESSION_COOKIE_NAME = "soaplane_operator_session";
export const OPERATOR_CSRF_COOKIE_NAME = "soaplane_operator_csrf";
export const COOKIE_OPERATOR_SESSION_TOKEN = "__cookie_operator_session__";

export function operatorSessionCookieOptions({ maxAgeMs = DEFAULT_OPERATOR_SESSION_TTL_MS, isProduction = false } = {}) {
  return [
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    isProduction ? "Secure" : "",
    isProduction ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
}

export function operatorCsrfCookieOptions({ maxAgeMs = DEFAULT_OPERATOR_SESSION_TTL_MS, isProduction = false } = {}) {
  return [
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    isProduction ? "Secure" : "",
    isProduction ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
}

export function appendSetCookieHeader(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");

  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  res.setHeader("Set-Cookie", Array.isArray(current) ? [...current, cookieValue] : [current, cookieValue]);
}

export function setOperatorSessionCookie(res, token, options = {}) {
  appendSetCookieHeader(
    res,
    `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${operatorSessionCookieOptions(options).join("; ")}`
  );
}

export function clearOperatorSessionCookie(res, options = {}) {
  appendSetCookieHeader(
    res,
    `${OPERATOR_SESSION_COOKIE_NAME}=; ${operatorSessionCookieOptions({ ...options, maxAgeMs: 0 }).join("; ")}`
  );
}

export function createCsrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function setOperatorCsrfCookie(res, token = createCsrfToken(), options = {}) {
  appendSetCookieHeader(
    res,
    `${OPERATOR_CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; ${operatorCsrfCookieOptions(options).join("; ")}`
  );
  return token;
}

export function clearOperatorCsrfCookie(res, options = {}) {
  appendSetCookieHeader(
    res,
    `${OPERATOR_CSRF_COOKIE_NAME}=; ${operatorCsrfCookieOptions({ ...options, maxAgeMs: 0 }).join("; ")}`
  );
}

function cookieValueFromHeader(cookieHeader, cookieName) {
  if (typeof cookieHeader !== "string" || !cookieHeader) {
    return null;
  }

  const prefix = `${cookieName}=`;
  const match = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

export function extractOperatorCookieTokenFromHeader(cookieHeader) {
  return cookieValueFromHeader(cookieHeader, OPERATOR_SESSION_COOKIE_NAME);
}

export function extractOperatorCookieToken(req) {
  return req?.cookies?.[OPERATOR_SESSION_COOKIE_NAME] ||
    extractOperatorCookieTokenFromHeader(req?.headers?.cookie || "");
}

export function extractBearerToken(reqOrHeader) {
  const headerValue = typeof reqOrHeader === "string"
    ? reqOrHeader
    : reqOrHeader?.get?.("authorization") || reqOrHeader?.headers?.authorization || "";
  const match = String(headerValue || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function verifyOperatorSessionToken(token, secret) {
  return token ? verifyOperatorAccessToken(token, secret) : null;
}

export function resolveOperatorAccessToken(req, { allowBearerAuth = true } = {}) {
  return extractOperatorCookieToken(req) || (allowBearerAuth ? extractBearerToken(req) : null);
}
