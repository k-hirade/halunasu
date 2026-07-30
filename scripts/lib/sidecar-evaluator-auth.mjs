import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_MS = 60_000;

export async function createTemporarySidecarEvaluatorAuth(options = {}) {
  const platformBaseUrl = normalizeBaseUrl(options.platformBaseUrl);
  const extensionId = requiredString(options.extensionId, "extensionId");
  const organizationCode = requiredString(options.organizationCode, "organizationCode");
  const loginId = requiredString(options.loginId, "loginId");
  const password = requiredString(options.password, "password");
  const mfaCode = requiredString(options.mfaCode, "mfaCode");
  if (!/^[a-p]{32}$/u.test(extensionId)) {
    throw new Error("extensionId must be an approved 32-character Chrome extension ID");
  }
  if (!/^\d{6}$/u.test(mfaCode)) {
    throw new Error("mfaCode must be the current 6-digit MFA code");
  }

  const request = options.requestJson || requestJson;
  const now = options.now || (() => new Date());
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const jar = new CookieJar();
  const deviceId = `hsc_eval_${crypto.randomBytes(24).toString("base64url")}`;
  const initialProof = createProofKey();

  const authorization = await request(
    `${platformBaseUrl}/v1/auth/sidecar-device-authorizations`,
    {
      method: "POST",
      body: {
        extensionId,
        deviceId,
        codeChallenge: initialProof.challenge
      },
      timeoutMs
    }
  );
  assertResponse(authorization, "start sidecar device authorization");
  const deviceAuthId = requiredResponseString(
    authorization.body?.deviceAuthId,
    "sidecar device authorization did not return deviceAuthId"
  );
  const userCode = requiredResponseString(
    authorization.body?.userCode,
    "sidecar device authorization did not return userCode"
  );

  const login = await request(`${platformBaseUrl}/v1/auth/login`, {
    method: "POST",
    body: {
      organizationCode,
      loginId,
      password,
      mfaCode
    },
    jar,
    timeoutMs
  });
  assertResponse(login, "sidecar evaluator login");
  const csrfToken = String(
    login.body?.csrfToken
    || jar.get("halunasu_stg_csrf")
    || jar.get("halunasu_csrf")
    || ""
  ).trim();
  if (!csrfToken) {
    throw new Error("sidecar evaluator login did not return a CSRF token");
  }

  const approval = await request(
    `${platformBaseUrl}/v1/auth/sidecar-device-authorizations/${encodeURIComponent(deviceAuthId)}/approve`,
    {
      method: "POST",
      body: { userCode },
      headers: { "x-csrf-token": csrfToken },
      jar,
      timeoutMs
    }
  );
  assertResponse(approval, "approve sidecar evaluator device");
  if (approval.body?.deviceAuthorization?.status !== "approved") {
    throw new Error("sidecar evaluator device authorization was not approved");
  }

  const issued = await request(`${platformBaseUrl}/v1/auth/sidecar-token`, {
    method: "POST",
    body: {
      deviceAuthId,
      deviceId,
      codeChallenge: initialProof.challenge
    },
    timeoutMs
  });
  assertResponse(issued, "issue sidecar evaluator token");

  let current = tokenState(issued.body, initialProof.verifier);
  const grantId = requiredResponseString(
    issued.body?.grantId,
    "sidecar evaluator token did not return grantId"
  );
  const grantRecordId = grantId.split(".", 1)[0];
  let closed = false;

  return {
    mode: "temporary_device_grant",
    sidecarContext: current.sidecarContext,
    metadata: {
      mode: "temporary_device_grant",
      grantRecordId,
      accessTokenPersisted: false,
      verifierPersisted: false
    },
    async credentials() {
      if (closed) {
        throw new Error("sidecar evaluator authorization is already closed");
      }
      if (Date.parse(current.expiresAt) - now().getTime() > REFRESH_SKEW_MS) {
        return credentialView(current);
      }
      const proof = createProofKey();
      const refreshed = await request(`${platformBaseUrl}/v1/auth/sidecar-token`, {
        method: "POST",
        body: {
          grantId,
          deviceId,
          codeChallenge: proof.challenge
        },
        timeoutMs
      });
      assertResponse(refreshed, "refresh sidecar evaluator token");
      current = tokenState(refreshed.body, proof.verifier);
      return credentialView(current);
    },
    async close() {
      if (closed) {
        return { revoked: true, alreadyClosed: true };
      }
      closed = true;
      try {
        const revoked = await request(
          `${platformBaseUrl}/v1/auth/sidecar-grants/${encodeURIComponent(grantRecordId)}/revoke`,
          {
            method: "POST",
            body: {},
            headers: { "x-csrf-token": csrfToken },
            jar,
            timeoutMs
          }
        );
        assertResponse(revoked, "revoke sidecar evaluator grant");
        return { revoked: true, alreadyClosed: false };
      } catch (error) {
        return {
          revoked: false,
          alreadyClosed: false,
          error: String(error?.message || error)
        };
      }
    }
  };
}

export function createStaticSidecarEvaluatorAuth({ accessToken, verifier } = {}) {
  const current = {
    accessToken: requiredString(accessToken, "accessToken"),
    verifier: requiredString(verifier, "verifier")
  };
  return {
    mode: "static_token",
    sidecarContext: null,
    metadata: {
      mode: "static_token",
      accessTokenPersisted: true,
      verifierPersisted: true
    },
    async credentials() {
      return credentialView(current);
    },
    async close() {
      return { revoked: false, notApplicable: true };
    }
  };
}

function createProofKey() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function tokenState(body = {}, verifier) {
  const accessToken = requiredResponseString(
    body.accessToken,
    "sidecar token response did not include accessToken"
  );
  const expiresAt = requiredResponseString(
    body.expiresAt,
    "sidecar token response did not include expiresAt"
  );
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("sidecar token response included an invalid expiresAt");
  }
  return {
    accessToken,
    expiresAt,
    verifier,
    sidecarContext: body.sidecarContext && typeof body.sidecarContext === "object"
      ? {
          facilityId: String(body.sidecarContext.facilityId || "").trim() || null,
          departmentId: String(body.sidecarContext.departmentId || "").trim() || null
        }
      : null
  };
}

function credentialView(value) {
  return {
    accessToken: value.accessToken,
    verifier: value.verifier,
    expiresAt: value.expiresAt || null
  };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers = []) {
    for (const header of headers) {
      const first = String(header || "").split(";")[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
      }
    }
  }

  get(name) {
    return this.cookies.get(name) || "";
  }

  header() {
    return [...this.cookies.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

async function requestJson(url, {
  method = "GET",
  body = undefined,
  headers = {},
  jar = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(jar?.header() ? { cookie: jar.header() } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : splitSetCookie(response.headers.get("set-cookie"));
    jar?.store(setCookies);
    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    return { statusCode: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

function assertResponse(response, label) {
  if (Number(response?.statusCode) >= 200 && Number(response?.statusCode) < 300) {
    return;
  }
  const message = String(
    response?.body?.message
    || response?.body?.error?.message
    || response?.body?.error
    || "request failed"
  );
  throw new Error(`${label} failed (HTTP ${response?.statusCode || "unknown"}): ${message.slice(0, 300)}`);
}

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function requiredResponseString(value, message) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  return requiredString(value, "platformBaseUrl").replace(/\/+$/u, "");
}

function splitSetCookie(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(/,(?=\s*[^;,=]+=[^;,]+)/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
