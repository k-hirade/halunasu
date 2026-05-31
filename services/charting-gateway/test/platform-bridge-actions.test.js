import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { DEFAULT_SOAP_FORMAT_PROFILE } from "@medical/core";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.CHARTING_GATEWAY_AUTOSTART = "false";
process.env.CHARTING_GATEWAY_PLATFORM_AUTH_BRIDGE = "true";
process.env.STORE_BACKEND = "memory";
process.env.PLATFORM_STORE_BACKEND = "memory";
process.env.APP_ALLOW_OPERATOR_BEARER_AUTH = "true";
process.env.APP_REQUIRE_PRIVILEGED_MFA = "false";
process.env.APP_SESSION_SIGNING_SECRET = "test-session-secret-with-enough-length";
process.env.PAIRING_SIGNING_SECRET = "test-pairing-secret-with-enough-length";
process.env.FINALIZE_MODE = "inline";
delete process.env.OPENAI_API_KEY;

const { server, __testHooks } = await import("../src/server.js");

let baseUrl;
let org;
let admin;
let doctor;
let customPrompt;
let authHeaders;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  org = __testHooks.platformStore.createOrganization({
    organizationCode: "charting-test",
    displayName: "Charting Test Clinic",
    status: "active",
    access: {
      status: "active",
      enabledProducts: ["charting"]
    }
  });
  admin = __testHooks.platformStore.createMember(org.orgId, {
    loginId: "admin",
    displayName: "Admin User",
    password: "correct horse battery staple",
    globalRoles: ["org_admin"],
    productRoles: {
      charting: ["admin"]
    }
  });
  doctor = __testHooks.platformStore.createMember(org.orgId, {
    loginId: "doctor",
    displayName: "Doctor User",
    password: "correct horse battery staple",
    globalRoles: [],
    productRoles: {
      charting: ["editor"]
    }
  });
  __testHooks.platformStore.upsertProductEntitlement(org.orgId, {
    productId: "charting",
    status: "enabled",
    plan: "test"
  });

  const draftPrompt = await __testHooks.store.createSoapFormatProfile({
    orgId: org.orgId,
    actorId: admin.memberId,
    input: {
      displayName: "検査用SOAPプロンプト",
      scope: "organization",
      outputTemplate: DEFAULT_SOAP_FORMAT_PROFILE.outputTemplate,
      customization: {},
      sections: []
    }
  });
  customPrompt = await __testHooks.store.publishSoapFormatProfile({
    orgId: org.orgId,
    profileId: draftPrompt.profileId,
    actorId: admin.memberId
  });

  const identity = __testHooks.platformStore.getLoginIdentity(org.organizationCode, admin.loginId);
  const token = __testHooks.buildOperatorSessionTokenFromPayload({
    sub: admin.memberId,
    memberId: admin.memberId,
    orgId: org.orgId,
    clinicId: org.orgId,
    organizationCode: org.organizationCode,
    loginId: admin.loginId,
    displayName: admin.displayName,
    roles: ["org_admin", "clinical_admin", "doctor"],
    tokenVersion: Number(identity.tokenVersion || 0),
    amr: ["pwd", "otp"],
    mfaAt: Date.now(),
    exp: Date.now() + 60 * 60 * 1000
  });
  authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("platform bridge member management mutating APIs use Core Platform data", async () => {
  const created = await request("POST", "/api/v1/admin/members", {
    loginId: "new-doctor",
    displayName: "New Doctor",
    password: "correct horse battery staple",
    roles: ["doctor"],
    defaultRecordingSource: "local_browser"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.member.defaultRecordingSource, "local_browser");

  const memberId = created.body.member.memberId;
  const roles = await request("PATCH", `/api/v1/admin/members/${memberId}/roles`, {
    roles: ["doctor", "readonly_clinical"]
  });
  assert.equal(roles.status, 200);
  assert.deepEqual(new Set(roles.body.member.roles), new Set(["doctor", "readonly_clinical"]));

  const password = await request("POST", `/api/v1/admin/members/${memberId}/password`, {
    password: "another correct horse battery staple"
  });
  assert.equal(password.status, 200);

  const mfaReset = await request("POST", `/api/v1/admin/members/${memberId}/mfa-reset`, {});
  assert.equal(mfaReset.status, 200);

  const revoke = await request("POST", `/api/v1/admin/members/${memberId}/revoke-sessions`, {});
  assert.equal(revoke.status, 200);

  const disabled = await request("PATCH", `/api/v1/admin/members/${memberId}/status`, {
    status: "disabled"
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.member.status, "disabled");
});

test("platform bridge member preferences accept charting recording source values", async () => {
  const response = await request("PATCH", `/api/v1/admin/members/${doctor.memberId}/preferences`, {
    defaultRecordingSource: "local_browser"
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.member.defaultRecordingSource, "local_browser");
  assert.equal(
    __testHooks.platformStore.getMember(org.orgId, doctor.memberId).defaultRecordingSource,
    "local_browser"
  );
});

test("platform bridge prompt assignments update Core organization and members without product member docs", async () => {
  const memberDefault = await request("POST", "/api/v1/admin/soap-format-assignments", {
    targetType: "member",
    memberId: doctor.memberId,
    formatId: "system-default"
  });
  assert.equal(memberDefault.status, 200, JSON.stringify(memberDefault.body));
  assert.equal(memberDefault.body.member.defaultPromptProfileId, "system-default");

  const memberCustom = await request("POST", "/api/v1/admin/soap-format-assignments", {
    targetType: "member",
    memberId: doctor.memberId,
    formatId: customPrompt.profileId
  });
  assert.equal(memberCustom.status, 200);
  assert.equal(memberCustom.body.member.defaultPromptProfileId, customPrompt.profileId);
  assert.equal(
    __testHooks.platformStore.getMember(org.orgId, doctor.memberId).defaultPromptProfileId,
    customPrompt.profileId
  );

  const organizationCustom = await request("POST", "/api/v1/admin/soap-format-assignments", {
    targetType: "organization",
    formatId: customPrompt.profileId
  });
  assert.equal(organizationCustom.status, 200);
  assert.equal(organizationCustom.body.organization.defaultPromptProfileId, customPrompt.profileId);
  assert.equal(
    __testHooks.platformStore.getOrganization(org.orgId).defaultPromptProfileId,
    customPrompt.profileId
  );
});

test("admin bootstrap aggregates settings data for the selected organization", async () => {
  const bootstrap = await request("GET", `/api/v1/admin/bootstrap?orgId=${org.orgId}`);

  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  assert.equal(bootstrap.body.session.member.memberId, admin.memberId);
  assert.equal(bootstrap.body.selectedOrgId, org.orgId);
  assert.equal(bootstrap.body.organizations.some((item) => item.orgId === org.orgId), true);
  assert.equal(bootstrap.body.members.some((item) => item.memberId === doctor.memberId), true);
  assert.equal(bootstrap.body.formats.some((item) => item.formatId === customPrompt.profileId), true);
  assert.equal(bootstrap.body.roles.some((item) => item.roleId === "org_admin"), true);
  assert.equal(Array.isArray(bootstrap.body.events), true);
});

test("admin bootstrap formats section skips unrelated data and returns prompt summaries", async () => {
  const bootstrap = await request("GET", `/api/v1/admin/bootstrap?orgId=${org.orgId}&section=formats&selectedFormatId=${customPrompt.profileId}`);

  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  assert.equal(bootstrap.body.section, "formats");
  assert.equal(bootstrap.body.roles.length, 0);
  assert.equal(bootstrap.body.events.length, 0);
  assert.equal(bootstrap.body.members.some((item) => item.memberId === doctor.memberId), true);
  const promptSummary = bootstrap.body.formats.find((item) => item.formatId === customPrompt.profileId);
  assert.ok(promptSummary);
  assert.equal(Object.hasOwn(promptSummary, "outputTemplate"), false);
  assert.equal(Object.hasOwn(promptSummary, "customization"), false);
  assert.equal(bootstrap.body.selectedFormat.formatId, customPrompt.profileId);
  assert.equal(Object.hasOwn(bootstrap.body.selectedFormat, "outputTemplate"), true);
  assert.equal(Object.hasOwn(bootstrap.body.selectedFormat, "customization"), true);

  const detail = await request("GET", `/api/v1/admin/soap-formats/${customPrompt.profileId}?orgId=${org.orgId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(typeof detail.body.format.outputTemplate, "string");
});

test("operator context hydration reuses the short process cache", async () => {
  __testHooks.clearOperatorContextCache();
  const countedMethods = ["getLoginIdentity", "getOrganization", "getMember", "getProductEntitlement"];
  const originals = new Map();
  const counts = Object.fromEntries(countedMethods.map((method) => [method, 0]));

  for (const method of countedMethods) {
    originals.set(method, __testHooks.platformStore[method]);
    __testHooks.platformStore[method] = (...args) => {
      counts[method] += 1;
      return originals.get(method).apply(__testHooks.platformStore, args);
    };
  }

  try {
    const first = await request("GET", "/api/v1/operator/me");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    for (const method of countedMethods) {
      assert.ok(counts[method] > 0, `${method} should be read on the initial request`);
    }

    const countsAfterFirstRequest = { ...counts };
    const second = await request("GET", "/api/v1/operator/me");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(counts, countsAfterFirstRequest);
    assert.equal(__testHooks.getOperatorContextCacheSize(), 1);
  } finally {
    for (const [method, original] of originals.entries()) {
      __testHooks.platformStore[method] = original;
    }
    __testHooks.clearOperatorContextCache();
  }
});

test("session creation applies Core Platform recording and prompt defaults", async () => {
  const preference = await request("PATCH", `/api/v1/admin/members/${doctor.memberId}/preferences`, {
    defaultRecordingSource: "local_browser"
  });
  assert.equal(preference.status, 200, JSON.stringify(preference.body));

  const assignment = await request("POST", "/api/v1/admin/soap-format-assignments", {
    targetType: "member",
    memberId: doctor.memberId,
    formatId: customPrompt.profileId
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.body));

  const created = await request("POST", "/api/v1/sessions", {
    doctorMemberId: doctor.memberId,
    patientDisplayName: "既定値患者",
    visitReason: "既定値反映の確認"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const state = await __testHooks.store.getSessionState(created.body.sessionId);
  assert.equal(state.session.audioSourceType, "local_browser");
  assert.equal(state.session.promptProfileId, customPrompt.profileId);
  assert.equal(state.session.promptProfileSelectionSource, "default");
});

test("session prompt selection and regeneration work through charting APIs", async () => {
  const created = await request("POST", "/api/v1/sessions", {
    doctorMemberId: doctor.memberId,
    patientDisplayName: "テスト患者",
    visitReason: "プロンプト選択の確認",
    promptProfileId: customPrompt.profileId
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.sessionId;

  const options = await request("GET", `/api/v1/sessions/${sessionId}/prompt-options`);
  assert.equal(options.status, 200);
  assert.ok(options.body.options.some((option) => option.profileId === "system-default"));
  assert.ok(options.body.options.some((option) => option.profileId === customPrompt.profileId));

  const selectedDefault = await request("POST", `/api/v1/sessions/${sessionId}/prompt-profile`, {
    promptProfileId: "system-default"
  });
  assert.equal(selectedDefault.status, 200);
  assert.equal(selectedDefault.body.session.promptProfileId, "system-default");

  const metadata = await request("POST", `/api/v1/sessions/${sessionId}/metadata`, {
    patientDisplayName: "更新後患者",
    visitReason: "更新後主訴"
  });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.session.patientDisplayName, "更新後患者");

  await __testHooks.store.appendTurn(sessionId, {
    speaker: "doctor",
    text: "患者は発熱と咳を訴えています。"
  });
  await __testHooks.store.saveSoapVersion(sessionId, {
    status: "ready",
    outputText: "S\n発熱と咳。\nO\n発熱あり。\nA\n上気道炎疑い。\nP\n経過観察。",
    structuredJson: {
      finalTranscript: "患者は発熱と咳を訴えています。"
    },
    promptProfileId: "system-default"
  });
  await __testHooks.store.updateSession(sessionId, {
    status: "soap_ready"
  });

  const regenerated = await request("POST", `/api/v1/sessions/${sessionId}/regenerate-soap`, {
    promptProfileId: customPrompt.profileId
  });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.session.promptProfileId, customPrompt.profileId);
});

test("claimed mobile recorder can start and append recording without a PC start action", async () => {
  const deviceId = "phone-qr-only";
  const created = await request("POST", "/api/v1/sessions", {
    doctorMemberId: admin.memberId,
    patientDisplayName: "スマホ開始患者",
    visitReason: "スマホ単独開始の確認"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const claimed = await claimPairing(created.body.pairingId, created.body.pairingToken, deviceId);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const started = await mobileRequest("POST", `/api/v1/mobile/sessions/${created.body.sessionId}/recording/start`, claimed.body.streamToken, {
    deviceId
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "recording");
  assert.equal(started.body.audioSourceType, "linked_mobile");

  const stopped = await mobileRequest("POST", `/api/v1/mobile/sessions/${created.body.sessionId}/recording/stop`, claimed.body.streamToken, {
    deviceId
  });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.status, "stopped");

  const restarted = await mobileRequest("POST", `/api/v1/mobile/sessions/${created.body.sessionId}/recording/start`, claimed.body.streamToken, {
    deviceId
  });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.equal(restarted.body.status, "recording");

  const finalStop = await mobileRequest("POST", `/api/v1/mobile/sessions/${created.body.sessionId}/recording/stop`, claimed.body.streamToken, {
    deviceId
  });
  assert.equal(finalStop.status, 200, JSON.stringify(finalStop.body));
});

test("stopping mobile recording keeps an open prepared phone ready for PC-side additional recording", async () => {
  const deviceId = "phone-pc-add";
  const created = await request("POST", "/api/v1/sessions", {
    doctorMemberId: admin.memberId,
    patientDisplayName: "追加録音患者",
    visitReason: "PC追加録音の確認"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const claimed = await claimPairing(created.body.pairingId, created.body.pairingToken, deviceId);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const ws = await connectMobileSocket({
    sessionId: created.body.sessionId,
    pairingId: created.body.pairingId,
    streamToken: claimed.body.streamToken,
    deviceId
  });

  try {
    await waitFor(async () => {
      const state = await __testHooks.store.getSessionState(created.body.sessionId);
      return state.session.mobileConnectionState === "mic_ready" ? state : null;
    });

    const started = await request("POST", `/api/v1/sessions/${created.body.sessionId}/recording/start`, {
      deviceId,
      source: "linked_mobile"
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, "recording");

    const stopped = await request("POST", `/api/v1/sessions/${created.body.sessionId}/recording/stop`, {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.status, "stopped");
    assert.equal(stopped.body.mobileConnectionState, "mic_ready");

    const restarted = await request("POST", `/api/v1/sessions/${created.body.sessionId}/recording/start`, {
      deviceId,
      source: "linked_mobile"
    });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
    assert.equal(restarted.body.status, "recording");

    const finalStop = await request("POST", `/api/v1/sessions/${created.body.sessionId}/recording/stop`, {});
    assert.equal(finalStop.status, 200, JSON.stringify(finalStop.body));
  } finally {
    ws.close();
  }
});

test("recording discard route resets stopped session and transcript turns", async () => {
  const created = await request("POST", "/api/v1/sessions", {
    doctorMemberId: admin.memberId,
    patientDisplayName: "録り直し患者",
    visitReason: "録音破棄APIの確認"
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.sessionId;

  const selectedSource = await request("POST", `/api/v1/sessions/${sessionId}/recording/source`, {
    source: "local_browser"
  });
  assert.equal(selectedSource.status, 200);

  const started = await request("POST", `/api/v1/sessions/${sessionId}/recording/start`, {
    deviceId: "pc-discard-test",
    deviceLabel: "テストPC",
    source: "local_browser"
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "recording");

  await __testHooks.store.appendTurn(sessionId, {
    speaker: "doctor",
    text: "誤って録音した内容です。"
  });

  const stopped = await request("POST", `/api/v1/sessions/${sessionId}/recording/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, "stopped");

  const discarded = await request("POST", `/api/v1/sessions/${sessionId}/recording/discard`, {});
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.session.status, "ready");
  assert.equal(discarded.body.session.latestFinalTurnIndex, 0);
  assert.equal(discarded.body.session.audioSourceType, null);

  const state = await __testHooks.store.getSessionState(sessionId);
  assert.equal(state.session.status, "ready");
  assert.deepEqual(state.turns, []);
});

async function request(method, path, body = undefined) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return {
    status: response.status,
    body: parsed
  };
}

async function mobileRequest(method, path, streamToken, body = undefined) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${streamToken}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return {
    status: response.status,
    body: parsed
  };
}

async function claimPairing(pairingId, token, deviceId) {
  const response = await fetch(`${baseUrl}/api/v1/pairings/${pairingId}/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token,
      deviceId,
      deviceInfo: {
        platform: "node-test",
        browser: "ws"
      }
    })
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return {
    status: response.status,
    body: parsed
  };
}

async function connectMobileSocket({ sessionId, pairingId, streamToken, deviceId }) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("mobile websocket auth timed out"));
    }, 1000);

    const finish = (callback) => {
      clearTimeout(timeout);
      callback();
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "auth.hello",
        role: "mobile",
        sessionId,
        token: streamToken,
        deviceId,
        pairingId
      }));
    });

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === "auth.ok") {
        ws.send(JSON.stringify({ type: "mic.ready" }));
        finish(resolve);
      }
      if (message.type === "error") {
        finish(() => reject(new Error(message.message || message.code || "mobile websocket error")));
      }
    });

    ws.on("error", (error) => finish(() => reject(error)));
    ws.on("close", () => finish(() => reject(new Error("mobile websocket closed before auth"))));
  });

  return ws;
}

async function waitFor(callback, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await callback();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met in time");
}
