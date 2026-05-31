import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
