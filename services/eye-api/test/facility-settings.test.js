// 段階 2D: 医療機関情報（眼科の設定）と、設定画面からのセットの保存（フォルダから出す・病名を消す）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { effectiveFacility, facilitiesWithSettings, validateFacilitySettingsInput } from "../src/facility.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-09T01:00:00.000Z");

test("facility settings are read by everyone, saved by administrators with revisions, and printed on paper", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const orgId = (await request(stores, "GET", "/v1/eye/context", undefined, director)).body.context.orgId;
  stores.platformStore.createFacility(orgId, { displayName: "あさおか眼科", prefecture: "東京都", address: { prefecture: "東京都", city: "千代田区", line1: "1-1" }, phone: "03-0000-0000", status: "active" });

  // 何も入れていなければ、基本の施設情報のまま（bootstrap の形も従来どおり）
  const before = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(before.body.facilities[0].displayName, "あさおか眼科");
  assert.equal(before.body.facilities[0].address.city, "千代田区");
  assert.equal(before.body.facilitySettings.revision, 0);
  const empty = await request(stores, "GET", "/v1/eye/facility-settings", undefined, clerk);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.facilitySettings.name, "");
  assert.equal(empty.body.facility.phone, "03-0000-0000");

  const body = { expectedRevision: 0, name: "医療法人 あさおか眼科クリニック", postalCode: "1000001", address: "東京都千代田区千代田 1-1 2階", phone: "03-1111-2222", fax: "03-1111-3333", email: "info@example.jp", founder: "医療法人 あさおか会", administrator: "朝岡 一郎", medicalInstitutionCode: "1312345678" };
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", body, doctor)).statusCode, 403, "only administrators change the clinic information");
  const { "x-csrf-token": _csrf, ...withoutCsrf } = director;
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", body, withoutCsrf)).statusCode, 403);
  const badPostal = await request(stores, "PUT", "/v1/eye/facility-settings", { ...body, postalCode: "12-34" }, director);
  assert.equal(badPostal.statusCode, 400);
  assert.equal(badPostal.body.field, "postalCode");
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...body, email: "not-mail" }, director)).body.field, "email");
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...body, name: "x".repeat(101) }, director)).statusCode, 400);

  const saved = await request(stores, "PUT", "/v1/eye/facility-settings", body, director);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.facilitySettings.revision, 1);
  assert.equal(saved.body.facilitySettings.postalCode, "100-0001");
  assert.equal(saved.body.facilitySettings.updatedBy.loginId, "eye-director");
  assert.equal(saved.body.facility.legalName, "医療法人 あさおか眼科クリニック");
  // 2 つの画面から同時に直したときは、あとの保存を止める
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...body, phone: "03-9999-9999" }, director)).statusCode, 409);

  // 紙が読む facilities は入力を重ねた値。住所は 1 行なので都道府県を二重に出さない
  const after = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  const facility = after.body.facilities[0];
  assert.equal(facility.displayName, "医療法人 あさおか眼科クリニック");
  assert.equal(facility.address.line1, "東京都千代田区千代田 1-1 2階");
  assert.equal(facility.address.prefecture, "");
  assert.equal(facility.prefecture, "");
  assert.equal(facility.address.postalCode, "100-0001");
  assert.equal(facility.phone, "03-1111-2222");
  assert.equal(facility.administrator, "朝岡 一郎");
  assert.equal(after.body.facilitySettings.fax, "03-1111-3333");
  // 基本の施設情報そのものは書き換えない
  assert.equal(stores.platformStore.listFacilities(orgId)[0].displayName, "あさおか眼科");

  const patient = await createPatient(stores, doctor);
  const document = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, doctor)).body.document;
  assert.equal(document.sender.facilityName, "医療法人 あさおか眼科クリニック");
  assert.equal(document.sender.address, "〒100-0001 東京都千代田区千代田 1-1 2階");
  assert.equal(document.sender.phone, "03-1111-2222");
  assert.equal(document.sender.fax, "03-1111-3333");

  // 空に戻すと基本の値に戻る
  const cleared = await request(stores, "PUT", "/v1/eye/facility-settings", { expectedRevision: 1 }, director);
  assert.equal(cleared.statusCode, 200);
  assert.equal((await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor)).body.facilities[0].displayName, "あさおか眼科");

  const exported = await request(stores, "GET", "/v1/eye/export", undefined, director);
  assert.equal(exported.body.settings.facilitySettings.revision, 2);
  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=settings", undefined, director);
  const log = logs.body.auditLogs.find((item) => item.eventType === "eye.facility_settings_saved");
  assert.ok(log, "saving the clinic information is a settings change in the audit log");
  assert.ok(log.safePayload.changedFields.includes("name"));
});

test("facility settings make a facility when the organization has none", () => {
  assert.deepEqual(facilitiesWithSettings([], null), []);
  const made = facilitiesWithSettings([], { name: "みなと眼科", phone: "045-000-0000" });
  assert.equal(made.length, 1);
  assert.equal(made[0].displayName, "みなと眼科");
  assert.equal(made[0].status, "active");
  const facilities = [{ facilityId: "f1", displayName: "旧", status: "inactive" }, { facilityId: "f2", displayName: "本院", status: "active", phone: "1" }];
  const merged = facilitiesWithSettings(facilities, { phone: "2" });
  assert.equal(merged[0], facilities[0], "only the facility in use is changed");
  assert.equal(merged[1].phone, "2");
  assert.equal(merged[1].displayName, "本院", "empty fields keep the base value");
  assert.equal(effectiveFacility(facilities[1], { name: "", phone: "" }), facilities[1]);
  assert.equal(validateFacilitySettingsInput({ postalCode: "１００－０００１" }).values.postalCode, "100-0001");
  assert.throws(() => validateFacilitySettingsInput({ expectedRevision: -1 }), /expectedRevision/u);
  assert.throws(() => validateFacilitySettingsInput({ phone: 123 }), /phone/u);
});

test("saving a set from the settings screen can take it out of a folder and clear its diagnoses", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const folder = (await request(stores, "POST", "/v1/eye/set-folders", { name: "緑内障" }, director)).body.setFolder;
  const created = await request(stores, "POST", "/v1/eye/order-sets", {
    name: "緑内障 定期",
    folderId: folder.folderId,
    sortOrder: 3,
    diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }],
    findingsText: "視野 安定",
    orders: [{ code: "iop", name: "眼圧", kind: "exam", eye: "ou" }]
  }, director);
  assert.equal(created.statusCode, 200);
  const setId = created.body.orderSet.setId;
  assert.equal(created.body.orderSet.folderId, folder.folderId);

  // 送らなかった項目は残る（並び替えなど）
  const reordered = await request(stores, "POST", "/v1/eye/order-sets", { setId, name: "緑内障 定期", sortOrder: 0, orders: created.body.orderSet.orders }, director);
  assert.equal(reordered.body.orderSet.folderId, folder.folderId);
  assert.equal(reordered.body.orderSet.sortOrder, 0);
  assert.equal(reordered.body.orderSet.diagnoses.length, 1);
  assert.equal(reordered.body.orderSet.findingsText, "視野 安定");

  // 送って空にした項目は空になる
  const moved = await request(stores, "POST", "/v1/eye/order-sets", { setId, name: "緑内障 定期", folderId: "", diagnoses: [], findingsText: "", orders: created.body.orderSet.orders }, director);
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.body.orderSet.folderId, "");
  assert.deepEqual(moved.body.orderSet.diagnoses, []);
  assert.equal(moved.body.orderSet.findingsText, "");
  assert.equal(moved.body.orderSet.sortOrder, 0);
  const listed = await request(stores, "GET", "/v1/eye/order-sets", undefined, director);
  assert.equal(listed.body.orderSets.find((item) => item.setId === setId).folderId, "");
});

test("a referral draft includes the free-text chief complaint and findings", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const encounter = (await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", content: { findingsText: "右眼 視野の進行あり" } }, doctor)).body.encounter;
  const document = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, encounterId: encounter.encounterId, type: "referral" }, doctor)).body.document;
  assert.match(document.body, /【検査所見】（2026-11-09）[\s\S]*右眼 視野の進行あり/u);
});

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
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

async function createPatient(stores, headers) {
  const response = await request(stores, "POST", "/v1/eye/patients", { displayName: "眼科 太郎", displayNameKana: "ガンカ タロウ", birthDate: "1950-04-01", sex: "male", primaryPatientNumber: "000123" }, headers);
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
