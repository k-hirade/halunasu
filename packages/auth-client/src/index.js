import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "halunasu_session";
export const CSRF_COOKIE_NAME = "halunasu_csrf";

const LOCAL_SESSION_SECRET = "local-only-halunasu-platform-session-secret";

export function verifyPlatformSessionFromHeaders(headers = {}, options = {}) {
  const token = platformSessionTokenFromHeaders(headers);
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

export function requirePlatformCsrf(headers = {}, session = {}) {
  const cookieToken = parseCookies(headerValue(headers, "cookie"))[CSRF_COOKIE_NAME];
  const headerToken = headerValue(headers, "x-csrf-token");

  if (!cookieToken || !headerToken || cookieToken !== headerToken || cookieToken !== session.csrfToken) {
    const error = new Error("CSRF token mismatch");
    error.name = "ForbiddenError";
    error.statusCode = 403;
    throw error;
  }
}

export function platformSessionTokenFromHeaders(headers = {}) {
  const bearer = bearerTokenFromHeaders(headers);
  if (bearer) {
    return bearer;
  }

  return parseCookies(headerValue(headers, "cookie"))[SESSION_COOKIE_NAME];
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
  return options.sessionSecret || process.env.APP_SESSION_SIGNING_SECRET || LOCAL_SESSION_SECRET;
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
