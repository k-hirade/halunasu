// replicate-2 chart-main: 定期（患者ごとのセット）と、公開マスターのコード引き（点数・薬価）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { createMasterIndex, parseLookupCodes } from "../src/masters.js";
import { regularOrderDue, validateRegularUpdateInput } from "../src/regular-orders.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-11T01:00:00.000Z");

const content = {
  prescriptions: [
    { kind: "eye_drop", name: "ラタノプロスト点眼液0.005%", eye: "ou", timesPerDay: 1, quantity: 2, unit: "本", rpId: "rp_a", carriedOver: true, drugCode: "620000001" },
    { kind: "comment", rpId: "rp_a", text: "後発品変更不可", scope: "free" }
  ],
  orders: [
    { orderId: "o1", name: "眼圧検査", kind: "exam", eye: "ou", status: "performed", code: "iop" },
    { orderId: "o2", name: "取り消した検査", kind: "exam", eye: "ou", status: "cancelled" }
  ]
};

test("regular orders are registered per patient, kept out of the set list, and come due by their repeat rule", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const nurse = await signedHeaders(stores.platformStore, "nurse");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-11", content }, doctor);
  assert.equal(draft.statusCode, 201);
  const encounterId = draft.body.encounter.encounterId;
  const path = `/v1/eye/patients/${patient.patientId}/regular-orders`;

  assert.equal((await request(stores, "POST", path, { encounterId, name: "緑内障 定期" }, nurse)).statusCode, 403, "only doctors register");
  assert.equal((await request(stores, "POST", path, { encounterId, name: "緑内障 定期" }, withoutCsrf(doctor))).statusCode, 403);
  assert.equal((await request(stores, "POST", path, { encounterId, name: "" }, doctor)).body.field, "name");
  assert.equal((await request(stores, "POST", path, { encounterId, name: "x", repeat: "months", repeatMonths: 0 }, doctor)).body.field, "repeatMonths");
  assert.equal((await request(stores, "POST", path, { encounterId, name: "x", repeat: "weekly" }, doctor)).body.field, "repeat");

  const saved = await request(stores, "POST", path, { encounterId, name: "緑内障 定期", repeat: "every" }, doctor);
  assert.equal(saved.statusCode, 201);
  const regular = saved.body.regularOrder;
  assert.equal(regular.registeredDate, "2026-11-11");
  assert.equal(regular.due, false, "not due on the day it was registered");
  assert.notEqual(regular.prescriptions[0].carriedOver, true);
  assert.equal(regular.prescriptions[1].kind, "comment");
  assert.deepEqual(regular.orders.map((row) => [row.name, row.status]), [["眼圧検査", "planned"]], "cancelled orders are dropped and the rest are planned");

  // セットの一覧（bootstrap・/order-sets）には出さない
  assert.equal((await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor)).body.orderSets.length, 0);
  assert.equal((await request(stores, "GET", "/v1/eye/order-sets", undefined, doctor)).body.orderSets.length, 0);

  const listed = await request(stores, "GET", `${path}?date=2026-11-25`, undefined, clerk);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.regularOrders.length, 1);
  assert.equal(listed.body.regularOrders[0].due, true);
  assert.equal((await request(stores, "GET", `${path}?date=11/25`, undefined, clerk)).statusCode, 400);

  // 入れた記録は看護師も付けられる。名前の変更・削除は医師だけ
  const patchPath = `/v1/eye/regular-orders/${regular.setId}`;
  const applied = await request(stores, "PATCH", patchPath, { appliedDate: "2026-11-25" }, nurse);
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.body.regularOrder.lastAppliedDate, "2026-11-25");
  assert.equal(applied.body.regularOrder.due, false, "already applied today");
  assert.equal((await request(stores, "PATCH", patchPath, { name: "改名" }, nurse)).statusCode, 403);
  const renamed = await request(stores, "PATCH", patchPath, { name: "緑内障 3か月", repeat: "months", repeatMonths: 3 }, doctor);
  assert.equal(renamed.body.regularOrder.name, "緑内障 3か月");
  assert.equal(renamed.body.regularOrder.repeatMonths, 3);
  assert.equal(renamed.body.regularOrder.prescriptions.length, 2, "editing keeps the contents");
  assert.equal((await request(stores, "PATCH", "/v1/eye/regular-orders/eset_missing", { name: "x" }, doctor)).statusCode, 404);

  const removed = await request(stores, "PATCH", patchPath, { active: false }, doctor);
  assert.equal(removed.statusCode, 200);
  assert.equal((await request(stores, "GET", path, undefined, doctor)).body.regularOrders.length, 0);

  // 別の患者のカルテからは作れない
  const other = await createPatient(stores, doctor, "000999");
  assert.equal((await request(stores, "POST", `/v1/eye/patients/${other.patientId}/regular-orders`, { encounterId, name: "x" }, doctor)).statusCode, 400);
  // 中身の無いカルテからは作れない
  const empty = await request(stores, "POST", "/v1/eye/encounters", { patientId: other.patientId, encounterDate: "2026-11-11" }, doctor);
  assert.equal((await request(stores, "POST", `/v1/eye/patients/${other.patientId}/regular-orders`, { encounterId: empty.body.encounter.encounterId, name: "x" }, doctor)).statusCode, 400);
});

test("regular order due rules", () => {
  const base = { registeredDate: "2026-01-31", active: true };
  assert.equal(regularOrderDue({ ...base, repeat: "next" }, "2026-01-31"), false);
  assert.equal(regularOrderDue({ ...base, repeat: "next" }, "2026-02-01"), true);
  assert.equal(regularOrderDue({ ...base, repeat: "next", lastAppliedDate: "2026-02-01" }, "2026-02-10"), false, "next is used once");
  assert.equal(regularOrderDue({ ...base, repeat: "every", lastAppliedDate: "2026-02-01" }, "2026-02-10"), true);
  assert.equal(regularOrderDue({ ...base, repeat: "months", repeatMonths: 1 }, "2026-02-27"), false);
  assert.equal(regularOrderDue({ ...base, repeat: "months", repeatMonths: 1 }, "2026-02-28"), true, "month end is clamped");
  assert.equal(regularOrderDue({ ...base, repeat: "months", repeatMonths: 3, lastAppliedDate: "2026-03-10" }, "2026-06-09"), false);
  assert.equal(regularOrderDue({ ...base, repeat: "months", repeatMonths: 3, lastAppliedDate: "2026-03-10" }, "2026-06-10"), true);
  assert.equal(regularOrderDue({ ...base, repeat: "every", active: false }, "2026-06-10"), false);
  assert.throws(() => validateRegularUpdateInput({ appliedDate: "2026/06/10" }), /appliedDate/u);
  assert.throws(() => validateRegularUpdateInput({ repeat: "months" }), /repeatMonths/u);
});

test("master lookup returns points and prices by code", async () => {
  const index = createMasterIndex({
    procedure: [{ code: "160072410", name: "眼圧検査", kana: "ガンアツケンサ", points: 82, section: "D264" }],
    drug: [{ code: "620000001", name: "ラタノプロスト点眼液0.005%", kana: "ラタノプロスト", price: 205.9, unit: "mL", kind: "eye_drop" }]
  });
  assert.deepEqual(index.lookup("procedure", ["160072410", "999", "160072410"]).map((item) => item.points), [82]);
  assert.equal(index.lookup("modifier", ["1"]).length, 0);
  assert.throws(() => parseLookupCodes("abc,x-y"), /alphanumeric/u);
  assert.throws(() => parseLookupCodes(Array.from({ length: 101 }, (_, i) => String(i)).join(",")), /100/u);

  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const response = await request(stores, "GET", "/v1/eye/masters/lookup?type=drug&codes=620000001,1", undefined, clerk, { masterIndex: index });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.results[0].price, 205.9);
  assert.equal((await request(stores, "GET", "/v1/eye/masters/lookup?type=x&codes=1", undefined, clerk, { masterIndex: index })).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/masters/lookup?type=drug&codes=a;b", undefined, clerk, { masterIndex: index })).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/masters/lookup?type=drug&codes=", undefined, clerk, { masterIndex: index })).body.results.length, 0);
});

const ROLE_PROFILES = {
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  nurse: { loginId: "eye-nurse", globalRoles: [], productRoles: { eye: ["nurse"] } },
  clerk: { loginId: "eye-clerk", globalRoles: [], productRoles: { eye: ["medical_clerk"] } }
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

function withoutCsrf(headers) {
  const { "x-csrf-token": _csrf, ...rest } = headers;
  return rest;
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
