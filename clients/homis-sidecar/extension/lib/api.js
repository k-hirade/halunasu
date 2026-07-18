(function registerSidecarApi(global) {
  "use strict";

  const PLATFORM_BASE_URL = "https://platform-api-stg-lp2t3inhza-an.a.run.app";
  const FEE_BASE_URL = "https://fee-api-stg-wmfrwcpzkq-an.a.run.app";
  const APPROVAL_BASE_URL = "https://fee.stg.halunasu.com/settings/sidecar-approvals";
  const DEVICE_ID_KEY = "halunasuSidecarDeviceId";
  const GRANT_ID_KEY = "halunasuSidecarGrantId";
  let pendingAuthorization = null;
  let currentAccess = null;

  async function startDeviceAuthorization() {
    const deviceId = await getOrCreateDeviceId();
    const proofKey = await createProofKey();
    const response = await jsonRequest(`${PLATFORM_BASE_URL}/v1/auth/sidecar-device-authorizations`, {
      method: "POST",
      body: {
        extensionId: chrome.runtime.id,
        deviceId,
        codeChallenge: proofKey.challenge
      }
    });
    pendingAuthorization = {
      deviceId,
      verifier: proofKey.verifier,
      deviceAuthId: response.deviceAuthId,
      expiresAt: response.expiresAt,
      pollIntervalSeconds: response.pollIntervalSeconds
    };
    return {
      ...response,
      approvalUrl: `${APPROVAL_BASE_URL}?code=${encodeURIComponent(response.userCode)}`
    };
  }

  async function pollDeviceAuthorization() {
    if (!pendingAuthorization) {
      throw apiError("device_authorization_missing", "接続手続きを最初からやり直してください。", 400);
    }
    const response = await jsonRequest(`${PLATFORM_BASE_URL}/v1/auth/sidecar-token`, {
      method: "POST",
      body: {
        deviceAuthId: pendingAuthorization.deviceAuthId,
        deviceId: pendingAuthorization.deviceId,
        codeChallenge: await challengeForVerifier(pendingAuthorization.verifier)
      }
    });
    currentAccess = {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      verifier: pendingAuthorization.verifier,
      sidecarContext: response.sidecarContext
    };
    await storageSet({ [GRANT_ID_KEY]: response.grantId });
    pendingAuthorization = null;
    return response;
  }

  async function connectWithStoredGrant() {
    const stored = await storageGet([GRANT_ID_KEY]);
    if (!stored[GRANT_ID_KEY]) {
      return null;
    }
    try {
      return await refreshGrant(stored[GRANT_ID_KEY]);
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        await clearGrant();
        return null;
      }
      throw error;
    }
  }

  async function refreshGrant(grantIdInput) {
    const deviceId = await getOrCreateDeviceId();
    const proofKey = await createProofKey();
    const response = await jsonRequest(`${PLATFORM_BASE_URL}/v1/auth/sidecar-token`, {
      method: "POST",
      body: {
        grantId: grantIdInput,
        deviceId,
        codeChallenge: proofKey.challenge
      }
    });
    currentAccess = {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      verifier: proofKey.verifier,
      sidecarContext: response.sidecarContext
    };
    return response;
  }

  async function calculate(payload) {
    const stored = await storageGet([GRANT_ID_KEY]);
    if (!stored[GRANT_ID_KEY]) {
      throw apiError("grant_missing", "端末を接続してください。", 401);
    }
    await refreshGrant(stored[GRANT_ID_KEY]);
    const response = await fetch(`${FEE_BASE_URL}/v1/integrations/sidecar/calculate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentAccess.accessToken}`,
        "content-type": "application/json",
        "x-sidecar-code-verifier": currentAccess.verifier
      },
      body: JSON.stringify({
        ...payload,
        facilityId: currentAccess.sidecarContext?.facilityId,
        departmentId: currentAccess.sidecarContext?.departmentId || undefined
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = apiError(body.error || "calculation_failed", body.message || `HTTP ${response.status}`, response.status);
      error.resetAt = body.resetAt || null;
      if (response.status === 401) {
        await clearGrant();
      }
      throw error;
    }
    return body;
  }

  async function clearGrant() {
    currentAccess = null;
    pendingAuthorization = null;
    await storageRemove([GRANT_ID_KEY]);
  }

  async function getOrCreateDeviceId() {
    const stored = await storageGet([DEVICE_ID_KEY]);
    if (stored[DEVICE_ID_KEY]) {
      return stored[DEVICE_ID_KEY];
    }
    const deviceId = `hsc_${randomBase64Url(24)}`;
    await storageSet({ [DEVICE_ID_KEY]: deviceId });
    return deviceId;
  }

  async function createProofKey() {
    const verifier = randomBase64Url(64);
    return { verifier, challenge: await challengeForVerifier(verifier) };
  }

  async function challengeForVerifier(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return bytesToBase64Url(new Uint8Array(digest));
  }

  function randomBase64Url(byteLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    return bytesToBase64Url(bytes);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = apiError(body.error || "request_failed", body.message || `HTTP ${response.status}`, response.status);
      error.resetAt = body.resetAt || null;
      throw error;
    }
    return body;
  }

  function apiError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(value) {
    return chrome.storage.local.set(value);
  }

  function storageRemove(keys) {
    return chrome.storage.local.remove(keys);
  }

  global.HalunasuSidecarApi = Object.freeze({
    calculate,
    clearGrant,
    connectWithStoredGrant,
    pollDeviceAuthorization,
    startDeviceAuthorization
  });
})(globalThis);
