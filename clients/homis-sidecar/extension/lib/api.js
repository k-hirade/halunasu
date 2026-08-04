(function registerSidecarApi(global) {
  "use strict";

  const configuration = validateConfiguration(global.HalunasuSidecarConfig);
  const PLATFORM_BASE_URL = configuration.platformBaseUrl;
  const FEE_BASE_URL = configuration.feeBaseUrl;
  const APPROVAL_BASE_URL = configuration.approvalBaseUrl;
  const STORAGE_PREFIX = `halunasuSidecar:${configuration.environment}`;
  const DEVICE_ID_KEY = `${STORAGE_PREFIX}:deviceId`;
  const GRANT_ID_KEY = `${STORAGE_PREFIX}:grantId`;
  const LEGACY_DEVICE_ID_KEY = "halunasuSidecarDeviceId";
  const LEGACY_GRANT_ID_KEY = "halunasuSidecarGrantId";
  const ACCESS_REUSE_WINDOW_MS = 30_000;
  let accessGeneration = 0;
  let grantResetInProgress = false;
  let pendingAuthorization = null;
  let pendingAccessRefresh = null;
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
    const authorization = pendingAuthorization;
    const generation = accessGeneration;
    const response = await jsonRequest(`${PLATFORM_BASE_URL}/v1/auth/sidecar-token`, {
      method: "POST",
      body: {
        deviceAuthId: authorization.deviceAuthId,
        deviceId: authorization.deviceId,
        codeChallenge: await challengeForVerifier(authorization.verifier)
      }
    });
    assertAccessGeneration(generation);
    currentAccess = {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      grantId: response.grantId,
      verifier: authorization.verifier,
      sidecarContext: response.sidecarContext
    };
    await storageSet({ [GRANT_ID_KEY]: response.grantId });
    pendingAuthorization = null;
    return response;
  }

  async function connectWithStoredGrant() {
    await migrateLegacyStgStorage();
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
    const grantId = String(grantIdInput || "").trim();
    if (pendingAccessRefresh?.grantId === grantId) {
      return pendingAccessRefresh.promise;
    }
    const promise = refreshGrantOnce(grantId, accessGeneration);
    pendingAccessRefresh = { grantId, promise };
    try {
      return await promise;
    } finally {
      if (pendingAccessRefresh?.promise === promise) {
        pendingAccessRefresh = null;
      }
    }
  }

  async function refreshGrantOnce(grantId, generation) {
    const deviceId = await getOrCreateDeviceId();
    const proofKey = await createProofKey();
    const response = await jsonRequest(`${PLATFORM_BASE_URL}/v1/auth/sidecar-token`, {
      method: "POST",
      body: {
        grantId,
        deviceId,
        codeChallenge: proofKey.challenge
      }
    });
    assertAccessGeneration(generation);
    currentAccess = {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      grantId,
      verifier: proofKey.verifier,
      sidecarContext: response.sidecarContext
    };
    return response;
  }

  async function calculate(payload) {
    return authorizedFeeRequest("/v1/integrations/sidecar/calculate", {
      method: "POST",
      body: (access) => ({
        ...payload,
        facilityId: access.sidecarContext?.facilityId,
        departmentId: access.sidecarContext?.departmentId || undefined
      })
    });
  }

  async function setCandidateAcknowledgement(input = {}) {
    const sidecarDraftId = String(input.sidecarDraftId || "").trim();
    const candidateKey = String(input.candidateKey || "").trim();
    const status = String(input.status || "").trim();
    if (
      !sidecarDraftId
      || !candidateKey
      || !["unacknowledged", "acknowledged", "excluded"].includes(status)
    ) {
      throw apiError(
        "candidate_acknowledgement_target_missing",
        "確認状態の保存先を特定できません。算定案を作成し直してください。",
        400
      );
    }
    return authorizedFeeRequest(
      `/v1/integrations/sidecar/drafts/${encodeURIComponent(sidecarDraftId)}`
        + `/candidate-acknowledgements/${encodeURIComponent(candidateKey)}`,
      {
        method: "PUT",
        body: {
          contractVersion: "v1",
          status,
          expectedSourceRevision: input.expectedSourceRevision,
          expectedCalculationRevision: input.expectedCalculationRevision,
          expectedAcknowledgementVersion: input.expectedAcknowledgementVersion,
          candidateFingerprint: input.candidateFingerprint
        }
      }
    );
  }

  async function setCandidateSelection(input = {}) {
    const sidecarDraftId = String(input.sidecarDraftId || "").trim();
    const candidateKey = String(input.candidateKey || "").trim();
    const selectedCode = String(input.selectedCode ?? "").trim();
    if (!sidecarDraftId || !candidateKey) {
      throw apiError(
        "candidate_selection_target_missing",
        "算定区分の保存先を特定できません。算定案を作成し直してください。",
        400
      );
    }
    return authorizedFeeRequest(
      `/v1/integrations/sidecar/drafts/${encodeURIComponent(sidecarDraftId)}`
        + `/candidate-selections/${encodeURIComponent(candidateKey)}`,
      {
        method: "PUT",
        body: {
          contractVersion: "v1",
          selectedCode,
          expectedSourceRevision: input.expectedSourceRevision,
          expectedCalculationRevision: input.expectedCalculationRevision,
          expectedSelectionVersion: input.expectedSelectionVersion,
          candidateFingerprint: input.candidateFingerprint
        }
      }
    );
  }

  async function setPatientChargeSetting(input = {}) {
    const sidecarDraftId = String(input.sidecarDraftId || "").trim();
    const allowedHandlings = new Set(["unknown", "charge", "waive"]);
    const handling = String(input.handling || "").trim();
    if (!sidecarDraftId || !allowedHandlings.has(handling)) {
      throw apiError(
        "patient_charge_setting_invalid",
        "患者負担設定の保存内容が不正です。算定案を作成し直してください。",
        400
      );
    }
    return authorizedFeeRequest(
      `/v1/integrations/sidecar/drafts/${encodeURIComponent(sidecarDraftId)}/patient-charge-setting`,
      {
        method: "PUT",
        body: {
          contractVersion: "v1",
          chargeType: "home_medical_transport",
          ...(handling === "unknown" ? { clear: true } : { handling }),
          amountMode: input.amountMode,
          amountYen: input.amountYen,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          expectedRevision: input.expectedRevision,
          expectedSourceRevision: input.expectedSourceRevision,
          expectedCalculationRevision: input.expectedCalculationRevision
        }
      }
    );
  }

  async function authorizedFeeRequest(path, options = {}) {
    if (grantResetInProgress) {
      throw grantMissingError();
    }
    const stored = await storageGet([GRANT_ID_KEY]);
    if (grantResetInProgress || !stored[GRANT_ID_KEY]) {
      throw grantMissingError();
    }
    const grantId = String(stored[GRANT_ID_KEY]);
    if (!canReuseCurrentAccess(grantId)) {
      await refreshGrant(grantId);
    }
    const access = currentAccess;
    const requestBody = typeof options.body === "function"
      ? options.body(access)
      : options.body;
    const response = await fetch(`${FEE_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json",
        "x-sidecar-code-verifier": access.verifier
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
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
    grantResetInProgress = true;
    accessGeneration += 1;
    currentAccess = null;
    pendingAccessRefresh = null;
    pendingAuthorization = null;
    try {
      await storageRemove([GRANT_ID_KEY]);
    } finally {
      grantResetInProgress = false;
    }
  }

  function assertAccessGeneration(generation) {
    if (generation !== accessGeneration || grantResetInProgress) {
      throw grantMissingError();
    }
  }

  function grantMissingError() {
    return apiError("grant_missing", "端末を接続してください。", 401);
  }

  function canReuseCurrentAccess(grantId) {
    const expiresAtMs = Date.parse(String(currentAccess?.expiresAt || ""));
    return currentAccess?.grantId === grantId
      && typeof currentAccess.accessToken === "string"
      && currentAccess.accessToken.length > 0
      && typeof currentAccess.verifier === "string"
      && currentAccess.verifier.length > 0
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > Date.now() + ACCESS_REUSE_WINDOW_MS;
  }

  async function getOrCreateDeviceId() {
    await migrateLegacyStgStorage();
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

  async function migrateLegacyStgStorage() {
    if (configuration.environment !== "stg") {
      return;
    }
    const stored = await storageGet([
      DEVICE_ID_KEY,
      GRANT_ID_KEY,
      LEGACY_DEVICE_ID_KEY,
      LEGACY_GRANT_ID_KEY
    ]);
    const migration = {};
    if (!stored[DEVICE_ID_KEY] && stored[LEGACY_DEVICE_ID_KEY]) {
      migration[DEVICE_ID_KEY] = stored[LEGACY_DEVICE_ID_KEY];
    }
    if (!stored[GRANT_ID_KEY] && stored[LEGACY_GRANT_ID_KEY]) {
      migration[GRANT_ID_KEY] = stored[LEGACY_GRANT_ID_KEY];
    }
    if (Object.keys(migration).length > 0) {
      await storageSet(migration);
    }
    if (stored[LEGACY_DEVICE_ID_KEY] || stored[LEGACY_GRANT_ID_KEY]) {
      await storageRemove([LEGACY_DEVICE_ID_KEY, LEGACY_GRANT_ID_KEY]);
    }
  }

  function validateConfiguration(value) {
    const input = value && typeof value === "object" ? value : {};
    const environment = String(input.environment || "").trim();
    if (!["stg", "prod"].includes(environment)) {
      throw new Error("HOMISサイドカーの実行環境設定が不正です。");
    }
    const platformBaseUrl = secureOrigin(input.platformBaseUrl, "Platform API");
    const feeBaseUrl = secureOrigin(input.feeBaseUrl, "Fee API");
    const approvalBaseUrl = secureUrl(input.approvalBaseUrl, "承認ページ");
    return Object.freeze({
      environment,
      platformBaseUrl,
      feeBaseUrl,
      approvalBaseUrl
    });
  }

  function secureOrigin(value, label) {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${label}のURL設定が不正です。`);
    }
    return url.origin;
  }

  function secureUrl(value, label) {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label}のURL設定が不正です。`);
    }
    return url.toString().replace(/\/$/u, "");
  }

  global.HalunasuSidecarApi = Object.freeze({
    calculate,
    clearGrant,
    connectWithStoredGrant,
    environment: configuration.environment,
    pollDeviceAuthorization,
    setCandidateAcknowledgement,
    setCandidateSelection,
    setPatientChargeSetting,
    startDeviceAuthorization
  });
})(globalThis);
