// 記載の型（医師ごとの主訴・所見のひな形）と定型文の SOAP の区分。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-20T01:00:00.000Z");
const TODAY = "2026-11-20";
const SOAP = "S)\nO)\nA)\nP)";

test("chart templates: doctors edit their own, administrators edit any, revisions conflict and changes are audited", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const doctor2 = await signedHeaders(stores.platformStore, "doctor2");
  const clerk = await signedHeaders(stores.platformStore, "clerk");

  const listed = await request(stores, "GET", "/v1/eye/chart-templates", undefined, clerk);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.body.templates.map((item) => item.displayName).sort(), ["eye-director", "eye-doctor", "eye-doctor2"], "only staff with the doctor role");
  assert.equal(listed.body.canEditAll, false);
  assert.equal(listed.body.canEditOwn, false);
  const ids = Object.fromEntries(listed.body.templates.map((item) => [item.displayName, item.memberId]));
  const blank = listed.body.templates.find((item) => item.memberId === ids["eye-doctor"]);
  assert.deepEqual([blank.text, blank.active, blank.revision], ["", false, 0]);

  const path = `/v1/eye/chart-templates/${ids["eye-doctor"]}`;
  assert.equal((await request(stores, "PUT", path, { text: SOAP }, clerk)).statusCode, 403, "clerks cannot change templates");
  assert.equal((await request(stores, "PUT", path, { text: SOAP }, doctor2)).statusCode, 403, "a doctor cannot change another doctor's template");
  const { "x-csrf-token": _csrf, ...withoutCsrf } = doctor;
  assert.equal((await request(stores, "PUT", path, { text: SOAP }, withoutCsrf)).statusCode, 403);
  assert.equal((await request(stores, "PUT", path, { text: "x".repeat(2001) }, doctor)).statusCode, 400);

  const own = await request(stores, "PUT", path, { expectedRevision: 0, text: `${SOAP}\n\n` }, doctor);
  assert.equal(own.statusCode, 200);
  assert.deepEqual([own.body.template.text, own.body.template.active, own.body.template.revision], [SOAP, true, 1]);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, text: "古い画面" }, doctor)).statusCode, 409, "stale revision is rejected");

  // 管理者はほかの医師の型も直せる。医師でない職員には型を持たせない
  const byAdmin = await request(stores, "PUT", path, { expectedRevision: 1, text: SOAP, active: false }, director);
  assert.equal(byAdmin.statusCode, 200);
  assert.equal(byAdmin.body.template.revision, 2);
  assert.equal(byAdmin.body.template.updatedBy.loginId, "eye-director");
  const orgId = (await request(stores, "GET", "/v1/eye/context", undefined, clerk)).body.context.orgId;
  const clerkId = (await stores.platformStore.listMembers(orgId)).find((member) => member.loginId === "eye-clerk").memberId;
  assert.equal((await request(stores, "PUT", `/v1/eye/chart-templates/${clerkId}`, { text: SOAP }, director)).statusCode, 400);
  assert.equal((await request(stores, "PUT", "/v1/eye/chart-templates/unknown", { text: SOAP }, director)).statusCode, 404);

  // 無効の型はカルテに渡さない
  assert.deepEqual((await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor)).body.chartTemplates, []);
  await request(stores, "PUT", path, { expectedRevision: 2, text: SOAP, active: true }, doctor);
  assert.deepEqual((await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor)).body.chartTemplates, [{ memberId: ids["eye-doctor"], text: SOAP }]);
  const doctorList = await request(stores, "GET", "/v1/eye/chart-templates", undefined, doctor);
  assert.deepEqual([doctorList.body.canEditAll, doctorList.body.canEditOwn], [false, true]);

  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=settings", undefined, director);
  const saved = logs.body.auditLogs.filter((item) => item.eventType === "eye.chart_template_saved");
  assert.equal(saved.length, 3);
  assert.equal(JSON.stringify(saved).includes("S)"), false, "template text is not written to the audit log");
  assert.deepEqual(saved.find((item) => item.safePayload.active === false).safePayload, { active: false, length: SOAP.length });

  const exported = await request(stores, "GET", "/v1/eye/export", undefined, director);
  assert.equal(exported.body.settings.chartTemplates.length, 1);
  assert.equal(exported.body.settings.chartTemplates[0].text, SOAP);
});

test("a new chart gets the attending doctor's template only when its free text is empty", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const doctor2 = await signedHeaders(stores.platformStore, "doctor2");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const ids = Object.fromEntries((await request(stores, "GET", "/v1/eye/chart-templates", undefined, director)).body.templates.map((item) => [item.displayName, item.memberId]));
  await request(stores, "PUT", `/v1/eye/chart-templates/${ids["eye-doctor"]}`, { text: SOAP }, doctor);
  await request(stores, "PUT", `/v1/eye/chart-templates/${ids["eye-doctor2"]}`, { text: "【経過観察】\n自覚症状：\n所見：\n方針：" }, doctor2);

  // 作った人が医師なら、その人の型
  const first = await createPatient(stores, director, "000201");
  const own = await request(stores, "POST", "/v1/eye/encounters", { patientId: first.patientId, encounterDate: TODAY }, doctor);
  assert.equal(own.statusCode, 201);
  assert.equal(own.body.encounter.content.findingsText, SOAP);
  assert.equal(own.body.encounter.templateMemberId, ids["eye-doctor"]);

  // 予約の担当医がいれば、作った人（視能訓練士）ではなく担当医の型
  const second = await createPatient(stores, director, "000202");
  const booked = await request(stores, "POST", "/v1/eye/appointments", { patientId: second.patientId, date: TODAY, time: "10:00", doctorMemberId: ids["eye-doctor2"] }, director);
  assert.equal(booked.statusCode, 201, JSON.stringify(booked.body));
  const byAppointment = await request(stores, "POST", "/v1/eye/encounters", { patientId: second.patientId, encounterDate: TODAY }, orthoptist);
  assert.match(byAppointment.body.encounter.content.findingsText, /^【経過観察】/u);
  assert.equal(byAppointment.body.encounter.templateMemberId, ids["eye-doctor2"]);

  // 担当医もなく、作った人が医師でもなければ入れない
  const third = await createPatient(stores, director, "000203");
  const none = await request(stores, "POST", "/v1/eye/encounters", { patientId: third.patientId, encounterDate: TODAY }, orthoptist);
  assert.equal(none.body.encounter.content.findingsText ?? "", "");
  assert.equal(none.body.encounter.templateMemberId, undefined);

  // 中身を送って作るとき（取り込み）は入れない。前回の主訴・所見が写る再診のカルテにも入れない（上書きしない）
  const fourth = await createPatient(stores, director, "000204");
  const previous = (await request(stores, "POST", "/v1/eye/encounters", { patientId: fourth.patientId, encounterDate: "2026-11-01", content: { findingsText: "前回の所見", chiefComplaint: "かすみ" } }, doctor)).body.encounter;
  assert.equal(previous.content.findingsText, "前回の所見");
  assert.equal(previous.templateMemberId, undefined);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${previous.encounterId}/finalize`, { expectedRevision: previous.revision }, doctor);
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  const revisit = await request(stores, "POST", "/v1/eye/encounters", { patientId: fourth.patientId, encounterDate: TODAY, visitType: "revisit" }, doctor);
  assert.equal(revisit.body.encounter.content.findingsText, "前回の所見");
  assert.equal(revisit.body.encounter.templateMemberId, undefined);

  const logs = await request(stores, "GET", "/v1/eye/audit-logs", undefined, director);
  assert.ok(logs.body.auditLogs.some((item) => item.eventType === "eye.encounter_created" && item.safePayload?.chartTemplateMemberId === ids["eye-doctor"]));
});

test("phrases keep their SOAP category, and saving without one keeps the saved category", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const saved = await request(stores, "POST", "/v1/eye/phrases", { target: "findingsText", label: "S) 変わりなし", text: "S) 変わりなし", soap: "S" }, director);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.phrase.soap, "S");
  const again = await request(stores, "POST", "/v1/eye/phrases", { phraseId: saved.body.phrase.phraseId, target: "findingsText", text: "S) 自覚症状の変化なし" }, director);
  assert.equal(again.body.phrase.soap, "S", "an older screen without the category does not clear it");
  assert.equal((await request(stores, "POST", "/v1/eye/phrases", { target: "plan", text: "x", soap: "Q" }, director)).statusCode, 400);
  const boot = await request(stores, "GET", "/v1/eye/bootstrap", undefined, director);
  assert.deepEqual(boot.body.phrases.map((item) => [item.text, item.soap]), [["S) 自覚症状の変化なし", "S"]]);
});

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  doctor2: { loginId: "eye-doctor2", globalRoles: [], productRoles: { eye: ["doctor"] } },
  orthoptist: { loginId: "eye-ort", globalRoles: [], productRoles: { eye: ["orthoptist"] } },
  clerk: { loginId: "eye-clerk", globalRoles: [], productRoles: { eye: ["medical_clerk"] } },
  viewer: { loginId: "eye-viewer", globalRoles: [], productRoles: { eye: ["viewer"] } }
};

function createStores() {
  const counters = new Map();
  const idFactory = (prefix) => {
    const next = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(3, "0")}`;
  };
  const now = () => NOW;
  const platformStore = new MemoryPlatformStore({ now, idFactory, tokenFactory: idFactory });
  const eyeStore = new MemoryEyeStore({ now, idFactory });
  const organization = platformStore.createOrganization({ organizationCode: "Asaoka", displayName: "あさおか眼科" });
  for (const profile of Object.values(ROLE_PROFILES)) {
    platformStore.createMember(organization.orgId, { loginId: profile.loginId, displayName: profile.loginId, globalRoles: profile.globalRoles, productRoles: profile.productRoles, password: "correct horse battery staple" });
  }
  platformStore.upsertProductEntitlement(organization.orgId, { productId: "eye", status: "trialing" });
  return { platformStore, eyeStore, blobStore: new MemoryBlobStore() };
}

async function signedHeaders(platformStore, profileName) {
  const profile = ROLE_PROFILES[profileName];
  const initial = platformStore.getLoginIdentity("asaoka", profile.loginId);
  const identity = initial.mfaRequired && !initial.mfaEnrolled
    ? platformStore.completeMfaEnrollment(platformStore.beginMfaEnrollment(initial, "MZXW6YTBOI======"))
    : initial;
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: profile.globalRoles,
    productRoles: profile.productRoles,
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true,
    csrfToken: `csrf_${profile.loginId}`
  }, { now: NOW, sessionSecret: "test-session-secret" });
  return { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`, "x-csrf-token": session.csrfToken };
}

async function createPatient(stores, headers, number = "000123") {
  const response = await request(stores, "POST", "/v1/eye/patients", { displayName: "眼科 太郎", displayNameKana: "ガンカ タロウ", birthDate: "1950-04-01", sex: "male", primaryPatientNumber: number }, headers);
  assert.equal(response.statusCode, 201);
  return response.body.patient;
}

function request(stores, method, path, body, headers = {}, extra = {}) {
  return handleEyeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    eyeStore: stores.eyeStore,
    blobStore: stores.blobStore,
    now: () => NOW,
    sessionSecret: "test-session-secret",
    ...extra
  });
}
