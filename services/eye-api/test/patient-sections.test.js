import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { createMasterIndex } from "../src/masters.js";
import { commonModifiers } from "../src/modifier-common.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

// カルテ左ペインの区画（副作用薬等・バイタル・問診・サマリー）の保存と、修飾語の候補一覧。
const NOW = new Date("2026-11-11T01:00:00.000Z");
const ROLE_PROFILES = {
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  nurse: { loginId: "eye-nurse", globalRoles: [], productRoles: { eye: ["nurse"] } },
  viewer: { loginId: "eye-viewer", globalRoles: [], productRoles: { eye: ["viewer"] } }
};

test("saves each left-pane section separately and keeps the others", async () => {
  const stores = createStores();
  const nurse = await signedHeaders(stores.platformStore, "nurse");
  const patient = await createPatient(stores, nurse);
  const path = `/v1/eye/patients/${patient.patientId}/profile/sections`;

  const adverse = await request(stores, "PUT", path, { expectedRevision: 0, section: "adverseDrugs", value: [{ name: "ロキソプロフェン", reaction: "発疹", onset: "2019-04" }] }, nurse);
  assert.equal(adverse.statusCode, 200);
  assert.equal(adverse.body.profile.revision, 1);
  assert.match(adverse.body.profile.adverseDrugs[0].itemId, /^eadr_/u);
  assert.equal(adverse.body.profile.adverseDrugs[0].onset, "2019-04");

  const meds = await request(stores, "PUT", path, { expectedRevision: 1, section: "regularMedications", value: [{ name: "アムロジピン錠5mg", usage: "1日1回朝", current: false }] }, nurse);
  assert.equal(meds.body.profile.regularMedications[0].current, false);
  assert.equal(meds.body.profile.adverseDrugs.length, 1);

  const allergies = await request(stores, "PUT", path, { expectedRevision: 2, section: "allergies", value: { allergies: [{ substance: "かに", reaction: "じんましん", onset: "2020" }] } }, nurse);
  assert.equal(allergies.body.profile.allergies[0].onset, "2020");
  assert.match(allergies.body.profile.allergies[0].allergyId, /^ealg_/u);

  const vitals = await request(stores, "PUT", path, { expectedRevision: 3, section: "vitals", value: [{ date: "2026-11-11", systolic: 128, diastolic: 76, temperature: 36.55 }, { date: "2026-10-01", pulse: 70 }] }, nurse);
  assert.deepEqual(vitals.body.profile.vitals.map((item) => item.date), ["2026-10-01", "2026-11-11"]);
  assert.equal(vitals.body.profile.vitals[1].temperature, 36.6);
  assert.equal(vitals.body.profile.vitals[1].recordedBy.loginId, "eye-nurse");

  const interviews = await request(stores, "PUT", path, { expectedRevision: 4, section: "interviews", value: [{ date: "2026-11-11", text: "昨日から右眼が赤い" }] }, nurse);
  assert.equal(interviews.body.profile.interviews[0].text, "昨日から右眼が赤い");

  const summary = await request(stores, "PUT", path, { expectedRevision: 5, section: "summary", value: "緑内障で通院中。点眼は良好。" }, nurse);
  assert.equal(summary.body.profile.summary, "緑内障で通院中。点眼は良好。");
  assert.equal(summary.body.profile.summaryUpdatedBy.loginId, "eye-nurse");

  // 既存のプロファイル保存（足した項目を知らない画面）でも、足した項目は消えない
  const legacy = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 6,
    allergies: summary.body.profile.allergies,
    noKnownAllergies: false,
    diagnoses: [],
    medicalHistory: "高血圧",
    ophthalmicHistory: "",
    contactLensUser: false
  }, nurse);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.body.profile.allergies[0].onset, "2020");
  assert.equal(legacy.body.profile.adverseDrugs[0].name, "ロキソプロフェン");
  assert.equal(legacy.body.profile.regularMedications.length, 1);
  assert.equal(legacy.body.profile.vitals.length, 2);
  assert.equal(legacy.body.profile.interviews.length, 1);
  assert.equal(legacy.body.profile.summary, "緑内障で通院中。点眼は良好。");
  assert.equal(legacy.body.profile.patientMemo, "");

  const history = await request(stores, "PUT", path, { expectedRevision: 7, section: "history", value: { medicalHistory: "高血圧\n糖尿病", contactLensUser: true } }, nurse);
  assert.equal(history.body.profile.medicalHistory, "高血圧\n糖尿病");
  assert.equal(history.body.profile.contactLensUser, true);
  assert.equal(history.body.profile.summary, "緑内障で通院中。点眼は良好。");
});

test("rejects stale revisions, bad values, unknown sections, viewers and missing CSRF", async () => {
  const stores = createStores();
  const nurse = await signedHeaders(stores.platformStore, "nurse");
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  const patient = await createPatient(stores, nurse);
  const path = `/v1/eye/patients/${patient.patientId}/profile/sections`;

  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "summary", value: "a" }, viewer)).statusCode, 403);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "summary", value: "a" }, withoutCsrf(nurse))).statusCode, 403);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "insurance", value: "a" }, nurse)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "vitals", value: [{ date: "2026-11-11", systolic: 999 }] }, nurse)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "vitals", value: [{ date: "2026-11-11" }] }, nurse)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "adverseDrugs", value: [{ name: "" }] }, nurse)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "adverseDrugs", value: [{ name: "a", onset: "2020-13" }] }, nurse)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "interviews", value: [{ date: "2026-11-11", text: "" }] }, nurse)).statusCode, 400);

  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "summary", value: "first" }, nurse)).statusCode, 200);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, section: "summary", value: "second" }, nurse)).statusCode, 409);
  // 失敗した保存は値を変えていない
  const profile = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/profile`, undefined, nurse);
  assert.equal(profile.body.profile.summary, "first");
  assert.equal(profile.body.profile.revision, 1);
});

test("returns common eye modifiers when the modifier query is empty and common=1", async () => {
  const index = createMasterIndex({ modifier: [
    { code: "2056", name: "右", kana: "ミギ", position: "prefix" },
    { code: "2049", name: "左", kana: "ヒダリ", position: "prefix" },
    { code: "3088", name: "術後", kana: "ジュツゴ", position: "prefix" },
    { code: "9999", name: "その他", kana: "ソノタ", position: "suffix" }
  ] });
  assert.deepEqual(commonModifiers(index).map((item) => item.name), ["右", "左", "術後"]);
  assert.equal(index.lookup("modifier", "9999").name, "その他");
  assert.equal(index.lookup("modifier", "0000"), null);

  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const common = await request(stores, "GET", "/v1/eye/masters/search?type=modifier&common=1", undefined, doctor, { masterIndex: index });
  assert.equal(common.statusCode, 200);
  assert.deepEqual(common.body.results.map((item) => item.code), ["2056", "2049", "3088"]);
  const empty = await request(stores, "GET", "/v1/eye/masters/search?type=modifier", undefined, doctor, { masterIndex: index });
  assert.deepEqual(empty.body.results, []);
  const disease = await request(stores, "GET", "/v1/eye/masters/search?type=disease&common=1", undefined, doctor, { masterIndex: index });
  assert.deepEqual(disease.body.results, []);
});

async function createPatient(stores, headers) {
  const response = await request(stores, "POST", "/v1/eye/patients", {
    displayName: "眼科 花子",
    displayNameKana: "ガンカ ハナコ",
    birthDate: "1960-05-01",
    sex: "female",
    primaryPatientNumber: "000777",
    contact: { postalCode: "1000001", prefecture: "東京都", address1: "千代田区千代田1-1", phone1: "03-0000-0000" }
  }, headers);
  assert.equal(response.statusCode, 201);
  return response.body.patient;
}

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
    platformStore.createMember(organization.orgId, {
      loginId: profile.loginId,
      displayName: profile.loginId,
      globalRoles: profile.globalRoles,
      productRoles: profile.productRoles,
      password: "correct horse battery staple"
    });
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
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

function withoutCsrf(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "x-csrf-token"));
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
