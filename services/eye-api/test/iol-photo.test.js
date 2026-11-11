// replicate-2（眼科パッケージ）: IOL 管理と顔写真（ファイルの種類 face_photo）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { validateIolRecordsInput } from "../src/iol.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-11T01:00:00.000Z");

test("IOL records are read by everyone, saved by chart writers with revisions, and exported", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  const patient = await createPatient(stores, doctor);
  const path = `/v1/eye/patients/${patient.patientId}/iol`;

  const empty = await request(stores, "GET", path, undefined, viewer);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body.iol, { patientId: patient.patientId, records: [], revision: 0 });

  const record = { eye: "od", status: "implanted", model: "SN60WF", manufacturer: "Alcon", power: "21.5", aConstant: 119.0, targetRefraction: -0.5, axialLength: 23.45, acd: 3.1, surgeryDate: "2026-10-01", placement: "bag" };
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 0, records: [record] }, clerk)).statusCode, 403, "clerks cannot change IOL records");
  const saved = await request(stores, "PUT", path, { expectedRevision: 0, records: [{ eye: "os", status: "planned", model: "ZCB00", power: 22 }, record] }, orthoptist);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.iol.revision, 1);
  assert.deepEqual(saved.body.iol.records.map((item) => item.eye), ["od", "os"], "sorted right eye first");
  assert.equal(saved.body.iol.records[0].power, 21.5);
  assert.match(saved.body.iol.records[0].iolId, /^iol_/u);
  assert.equal(saved.body.iol.orgId, undefined);

  const stale = await request(stores, "PUT", path, { expectedRevision: 0, records: [] }, doctor);
  assert.equal(stale.statusCode, 409);

  // id を付けて送ると同じ記録の更新になり、作った日時は残る
  const edited = await request(stores, "PUT", path, { expectedRevision: 1, records: saved.body.iol.records.map((item) => (item.eye === "os" ? { ...item, status: "implanted", surgeryDate: "2026-11-10" } : item)) }, doctor);
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.iol.records[1].iolId, saved.body.iol.records[1].iolId);
  assert.equal(edited.body.iol.records[1].status, "implanted");
  assert.equal(edited.body.iol.records[1].createdAt, saved.body.iol.records[1].createdAt);

  const bad = await request(stores, "PUT", path, { expectedRevision: 2, records: [{ eye: "od", model: "", power: 22 }] }, doctor);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.field, "records.0.model");
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 2, records: [{ eye: "ou", model: "X" }] }, doctor)).statusCode, 400);
  assert.equal((await request(stores, "PUT", path, { expectedRevision: 2, records: [{ eye: "od", model: "X", power: 99 }] }, doctor)).statusCode, 400);

  const exported = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/export`, undefined, doctor);
  assert.equal(exported.body.iolRecords.length, 2);
  const audit = stores.eyeStore.listAuditLogs((await request(stores, "GET", "/v1/eye/context", undefined, doctor)).body.context.orgId);
  assert.ok((await audit).some((entry) => entry.eventType === "eye.iol_updated"));
});

test("IOL input validation rejects duplicated ids and too many rows", () => {
  assert.throws(() => validateIolRecordsInput({ expectedRevision: 0, records: [{ iolId: "a", eye: "od", model: "X" }, { iolId: "a", eye: "os", model: "Y" }] }), /duplicated/u);
  assert.throws(() => validateIolRecordsInput({ expectedRevision: 0, records: Array.from({ length: 21 }, () => ({ eye: "od", model: "X" })) }), /at most 20/u);
  assert.throws(() => validateIolRecordsInput({ expectedRevision: -1, records: [] }), /expectedRevision/u);
  assert.throws(() => validateIolRecordsInput({ expectedRevision: 0, records: [{ eye: "od", model: "X", surgeryDate: "2026-13-40" }] }), /YYYY-MM-DD/u);
});

test("a face photo is stored as its own file kind and can be listed alone", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, clerk);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  for (const kind of ["face_photo", "oct"]) {
    const started = await request(stores, "POST", "/v1/eye/files/uploads", { patientId: patient.patientId, kind, eye: kind === "oct" ? "od" : "ou", takenOn: "2026-11-11", title: kind, contentType: "image/png", size: png.length }, clerk);
    assert.equal(started.statusCode, 201);
    await request(stores, "PUT", `/${started.body.upload.url}`, undefined, { ...clerk, "content-type": "image/png" }, { rawBody: png });
    const completed = await request(stores, "POST", `/v1/eye/files/${started.body.file.fileId}/complete`, {}, clerk);
    assert.equal(completed.statusCode, 200);
  }
  const all = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/files`, undefined, clerk);
  assert.equal(all.body.files.length, 2);
  const photos = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/files?kind=face_photo`, undefined, clerk);
  assert.deepEqual(photos.body.files.map((item) => item.kind), ["face_photo"]);
  assert.equal((await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/files?kind=selfie`, undefined, clerk)).statusCode, 400);
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
