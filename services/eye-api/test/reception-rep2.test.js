// replicate-2（受付）: 受付の設定（ラベル・患者マーク）、患者マーク、受付 1 件と受付編集履歴、ラベルと場所、患者検索の検索オプション。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { applyReceptionPatch, parseAdvancedSearch, validateReceptionSettingsInput } from "../src/reception.js";
import { appointmentHistory } from "../src/appointments.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-11T01:00:00.000Z");
const TODAY = "2026-11-11";

test("reception settings start with defaults and are saved by reception roles with revisions", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  const initial = await request(stores, "GET", "/v1/eye/reception-settings", undefined, viewer);
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.settings.revision, 0);
  assert.ok(initial.body.settings.labels.includes("紹介状あり"));
  assert.ok(initial.body.settings.marks.some((mark) => mark.key === "wheelchair" && mark.label === "車椅子"));

  assert.equal((await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: ["a"] }, viewer)).statusCode, 403);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = clerk;
  assert.equal((await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: ["a"] }, withoutCsrf)).statusCode, 403);
  assert.equal((await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: ["x".repeat(21)] }, clerk)).statusCode, 400);

  // ラベルだけを足す（マークの定義はそのまま）
  const saved = await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: [...initial.body.settings.labels, " 発熱あり ", "発熱あり"] }, clerk);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.settings.revision, 1);
  assert.equal(saved.body.settings.labels.filter((label) => label === "発熱あり").length, 1, "labels are trimmed and de-duplicated");
  assert.equal(saved.body.settings.marks.length, initial.body.settings.marks.length);
  assert.equal((await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: [] }, clerk)).statusCode, 409);

  assert.throws(() => validateReceptionSettingsInput({ marks: [{ key: "Bad Key", label: "x", symbol: "x" }] }), /mark key/u);
  assert.throws(() => validateReceptionSettingsInput({ marks: [{ key: "a", label: "x", symbol: "abc" }] }), /symbol/u);
});

test("patient marks are saved per patient, checked against the definitions, and listed for a day and in search", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, clerk);
  assert.deepEqual((await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/marks`, undefined, clerk)).body.marks, []);
  assert.equal((await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/marks`, { expectedRevision: 0, marks: ["unknown"] }, clerk)).statusCode, 400);
  const saved = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/marks`, { expectedRevision: 0, marks: ["wheelchair", "hearing", "wheelchair"] }, clerk);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.marks, ["wheelchair", "hearing"]);
  assert.equal((await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/marks`, { expectedRevision: 0, marks: [] }, clerk)).statusCode, 409);

  await request(stores, "POST", "/v1/eye/appointments", { date: TODAY, time: "09:00", patientId: patient.patientId, purpose: "revisit" }, clerk);
  const day = await request(stores, "GET", `/v1/eye/appointments/patient-marks?date=${TODAY}`, undefined, clerk);
  assert.deepEqual(day.body.patients[patient.patientId], { marks: ["wheelchair", "hearing"], revision: 1 });
  const search = await request(stores, "POST", "/v1/eye/patients/search", { q: "ガンカ", details: true }, clerk);
  assert.deepEqual(search.body.patients[0].marks, ["wheelchair", "hearing"]);
  assert.equal(search.body.advanced, undefined, "a plain search keeps its old shape");
});

test("a reception can be read with its edit history, and labels and location are changed with revisions", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, clerk);
  const created = (await request(stores, "POST", "/v1/eye/appointments", { date: TODAY, time: "09:00", patientId: patient.patientId, purpose: "revisit" }, clerk)).body.appointment;
  const edited = (await request(stores, "PATCH", `/v1/eye/appointments/${created.appointmentId}`, { expectedRevision: 1, time: "10:30", receptionMemo: "視野検査あり" }, clerk)).body.appointment;
  const moved = (await request(stores, "POST", `/v1/eye/appointments/${created.appointmentId}/status`, { expectedRevision: edited.revision, status: "checked_in" }, clerk)).body.appointment;

  assert.equal((await request(stores, "PATCH", `/v1/eye/appointments/${created.appointmentId}/reception`, { expectedRevision: moved.revision, location: "garden" }, clerk)).statusCode, 400);
  assert.equal((await request(stores, "PATCH", `/v1/eye/appointments/${created.appointmentId}/reception`, { expectedRevision: 1, location: "darkroom" }, clerk)).statusCode, 409);
  const labelled = await request(stores, "PATCH", `/v1/eye/appointments/${created.appointmentId}/reception`, { expectedRevision: moved.revision, receptionLabels: ["紹介状あり"], location: "darkroom" }, clerk);
  assert.equal(labelled.statusCode, 200);
  assert.deepEqual(labelled.body.appointment.receptionLabels, ["紹介状あり"]);
  assert.equal(labelled.body.appointment.location, "darkroom");
  assert.equal(labelled.body.appointment.locationStatus, "checked_in");
  assert.equal(labelled.body.appointment.note, "視野検査あり", "the memo text stays");

  const detail = await request(stores, "GET", `/v1/eye/appointments/${created.appointmentId}`, undefined, clerk);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.appointment.time, "10:30");
  // テストでは時刻が同じなので、種類ごとに確かめる
  const kinds = detail.body.history.map((item) => item.kind);
  assert.deepEqual(kinds.sort(), ["created", "edit", "edit", "status"]);
  const edits = detail.body.history.filter((item) => item.kind === "edit");
  assert.deepEqual(edits[0].changes.map((change) => change.field).sort(), ["note", "time"]);
  assert.deepEqual(edits[0].changes.find((change) => change.field === "time"), { field: "time", from: "09:00", to: "10:30" });
  assert.deepEqual(edits[1].changes.map((change) => change.field).sort(), ["location", "receptionLabels"]);
  assert.equal(detail.body.history.find((item) => item.kind === "status").status, "checked_in");
  assert.equal(edits[0].by.loginId, "eye-clerk");

  // 取消も履歴に残り、データは消えない
  const cancelled = await request(stores, "POST", `/v1/eye/appointments/${created.appointmentId}/status`, { expectedRevision: labelled.body.appointment.revision, status: "cancelled" }, clerk);
  assert.equal(cancelled.statusCode, 200);
  const after = await request(stores, "GET", `/v1/eye/appointments/${created.appointmentId}`, undefined, clerk);
  assert.equal(after.body.appointment.status, "cancelled");
  assert.ok(after.body.history.some((item) => item.kind === "status" && item.status === "cancelled"));
  // 予約状況・受付一覧の既存の一覧はそのまま使える
  assert.equal((await request(stores, "GET", `/v1/eye/appointments/range?from=${TODAY}&to=${TODAY}`, undefined, clerk)).statusCode, 200);
  assert.equal((await request(stores, "GET", "/v1/eye/appointments/eapt_999", undefined, clerk)).statusCode, 404);

  // 変わらない変更は版を上げない
  const current = after.body.appointment;
  assert.equal(applyReceptionPatch(current, { receptionLabels: current.receptionLabels }, { actor: {}, now: NOW.toISOString() }), null);
  assert.deepEqual(appointmentHistory({ createdAt: "a", statusHistory: [{ status: "booked", at: "a" }] }).map((item) => item.kind), ["created"]);
});

test("patient search options filter by phone, visit period, diagnosis and chart text", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const first = await createPatient(stores, doctor, { contact: { phone1: "03-1234-5678" } });
  const second = await createPatient(stores, doctor, { displayName: "検索 花子", displayNameKana: "ケンサク ハナコ", primaryPatientNumber: "000456", contact: { phone1: "090-0000-1111" } });
  await request(stores, "POST", "/v1/eye/encounters", { patientId: first.patientId, encounterDate: "2026-10-01", visitType: "initial", content: { diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }], plan: "ラタノプロスト点眼を継続" } }, doctor);
  await request(stores, "POST", "/v1/eye/encounters", { patientId: second.patientId, encounterDate: "2026-11-05", visitType: "initial", content: { diagnoses: [{ name: "アレルギー性結膜炎", eye: "ou" }], plan: "点眼で経過観察" } }, doctor);
  const ids = (response) => response.body.patients.map((patient) => patient.patientId);

  const byPhone = await request(stores, "POST", "/v1/eye/patients/search", { q: "", phone: "1234-5678" }, doctor);
  assert.equal(byPhone.statusCode, 200);
  assert.deepEqual(ids(byPhone), [first.patientId]);
  assert.equal(byPhone.body.advanced, true);

  const byVisit = await request(stores, "POST", "/v1/eye/patients/search", { q: "", visitFrom: "2026-11-01", visitTo: "2026-11-30" }, doctor);
  assert.deepEqual(ids(byVisit), [second.patientId]);
  assert.equal((await request(stores, "POST", "/v1/eye/patients/search", { visitFrom: "2026-12-01", visitTo: "2026-11-01" }, doctor)).statusCode, 400);

  assert.deepEqual(ids(await request(stores, "POST", "/v1/eye/patients/search", { diagnosis: "緑内障" }, doctor)), [first.patientId]);
  assert.deepEqual(ids(await request(stores, "POST", "/v1/eye/patients/search", { diagnosis: "緑内障 結膜炎" }, doctor)).sort(), [first.patientId, second.patientId].sort(), "any word matches by default");
  assert.deepEqual(ids(await request(stores, "POST", "/v1/eye/patients/search", { diagnosis: "緑内障 結膜炎", diagnosisAll: true }, doctor)), [], "all words must match when asked");
  assert.deepEqual(ids(await request(stores, "POST", "/v1/eye/patients/search", { history: "ラタノプロスト" }, doctor)), [first.patientId]);
  // 語の検索と組み合わせる
  assert.deepEqual(ids(await request(stores, "POST", "/v1/eye/patients/search", { q: "ケンサク", history: "ラタノプロスト" }, doctor)), []);
  const detailed = await request(stores, "POST", "/v1/eye/patients/search", { q: "ケンサク", history: "経過", details: true }, doctor);
  assert.deepEqual(ids(detailed), [second.patientId]);
  assert.equal(detailed.body.patients[0].lastVisitDate, "2026-11-05");

  assert.equal(parseAdvancedSearch({ q: "x" }), null);
  assert.equal(parseAdvancedSearch({ phone: "０３－１２" }).phone, "0312");
});

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
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

async function createPatient(stores, headers, overrides = {}) {
  const response = await request(stores, "POST", "/v1/eye/patients", { displayName: "眼科 太郎", displayNameKana: "ガンカ タロウ", birthDate: "1950-04-01", sex: "male", primaryPatientNumber: "000123", ...overrides }, headers);
  assert.equal(response.statusCode, 201);
  return response.body.patient;
}

function request(stores, method, path, body, headers = {}) {
  return handleEyeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    eyeStore: stores.eyeStore,
    blobStore: stores.blobStore,
    now: () => NOW,
    sessionSecret: "test-session-secret"
  });
}
