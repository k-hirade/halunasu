import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "halunasu_session";
export const CSRF_COOKIE_NAME = "halunasu_csrf";

const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOCAL_SESSION_SECRET = "local-only-halunasu-platform-session-secret";

export function createSignedSession(payload, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const ttlSeconds = options.ttlSeconds || DEFAULT_SESSION_TTL_SECONDS;
  const session = {
    ...payload,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    csrfToken: payload.csrfToken || createCsrfToken()
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(session));
  const signature = sign(encodedPayload, sessionSecret(options));

  return {
    token: `${encodedPayload}.${signature}`,
    session
  };
}

export function verifySignedSession(token, options = {}) {
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

export function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
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

export function sessionTokenFromHeaders(headers = {}, options = {}) {
  return parseCookies(headerValue(headers, "cookie"))[sessionCookieName(options)];
}

export function csrfTokenFromHeaders(headers = {}) {
  return headerValue(headers, "x-csrf-token");
}

export function sessionCookieHeader(token, options = {}) {
  return buildCookie(sessionCookieName(options), token, {
    httpOnly: true,
    maxAge: options.ttlSeconds || DEFAULT_SESSION_TTL_SECONDS,
    secure: Boolean(options.secure),
    domain: options.domain
  });
}

export function csrfCookieHeader(token, options = {}) {
  return buildCookie(csrfCookieName(options), token, {
    httpOnly: false,
    maxAge: options.ttlSeconds || DEFAULT_SESSION_TTL_SECONDS,
    secure: Boolean(options.secure),
    domain: options.domain
  });
}

export function clearSessionCookieHeaders(options = {}) {
  return [
    buildCookie(sessionCookieName(options), "", {
      httpOnly: true,
      maxAge: 0,
      secure: Boolean(options.secure),
      domain: options.domain
    }),
    buildCookie(csrfCookieName(options), "", {
      httpOnly: false,
      maxAge: 0,
      secure: Boolean(options.secure),
      domain: options.domain
    })
  ];
}

export function sessionCookieName(options = {}) {
  return options.sessionCookieName || process.env.APP_SESSION_COOKIE_NAME || SESSION_COOKIE_NAME;
}

export function csrfCookieName(options = {}) {
  return options.csrfCookieName || process.env.APP_CSRF_COOKIE_NAME || CSRF_COOKIE_NAME;
}

export function unauthorizedError(message = "Unauthorized") {
  const error = new Error(message);
  error.name = "UnauthorizedError";
  error.statusCode = 401;
  return error;
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

function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  return parts.join("; ");
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

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}
