// replicate-2 の統合: 受付ラベル・患者マークの保存先を受付の設定（/v1/eye/reception-settings）1 つにまとめた。
// 以前に施設管理（clinic-config の receptionLabels）へ保存した値は、読むときに取り込まれて消えない。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { mergeLegacyReceptionLabels, receptionSettingsView, validateReceptionSettingsInput } from "../src/reception.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-11T01:00:00.000Z");
const LEGACY = {
  section: "receptionLabels",
  revision: 2,
  value: {
    labels: [{ labelId: "erlb_1", name: "要散瞳", tone: "amber", active: true }, { labelId: "erlb_2", name: "紹介状あり", tone: "teal", active: true }],
    marks: [
      { markId: "epmk_AB1", name: "杖", symbol: "杖", tone: "gray", active: true },
      { markId: "epmk_2", name: "車椅子", symbol: "車", tone: "blue", active: true },
      { markId: "epmk_3", name: "以前の印", symbol: "旧", tone: "red", active: false }
    ]
  }
};

test("labels and marks saved in the old clinic-config section are merged into the reception settings on read and kept after a save", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const director = await signedHeaders(stores.platformStore, "director");
  await stores.eyeStore.saveClinicConfig(stores.orgId, "receptionLabels", { ...LEGACY, updatedAt: NOW.toISOString() }, 0);

  const read = (await request(stores, "GET", "/v1/eye/reception-settings", undefined, clerk)).body.settings;
  assert.equal(read.revision, 0);
  assert.ok(read.labels.includes("要散瞳"), "an old label is added");
  assert.equal(read.labels.filter((label) => label === "紹介状あり").length, 1, "a label with the same name is not doubled");
  const cane = read.marks.find((mark) => mark.label === "杖");
  assert.deepEqual(cane, { key: "c_epmk_ab1", label: "杖", symbol: "杖", tone: "neutral" });
  assert.equal(read.marks.filter((mark) => mark.label === "車椅子").length, 1, "a mark with the same name is not doubled");
  assert.equal(read.marks.find((mark) => mark.label === "以前の印").active, false);

  // 取り込んだマークは患者に付けられる
  const patient = (await request(stores, "POST", "/v1/eye/patients", { displayName: "眼科 太郎", displayNameKana: "ガンカ タロウ", birthDate: "1950-04-01", sex: "male" }, clerk)).body.patient;
  assert.equal((await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/marks`, { expectedRevision: 0, marks: [cane.key] }, clerk)).statusCode, 200);

  // 保存すると取り込んだ値が受付の設定に入り、そのあと消したものは戻らない
  const saved = await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 0, labels: read.labels.filter((label) => label !== "要散瞳"), marks: read.marks }, director);
  assert.equal(saved.statusCode, 200);
  const stored = await stores.eyeStore.getReceptionSettings(stores.orgId);
  assert.equal(stored.legacyRevision, 2);
  const again = (await request(stores, "GET", "/v1/eye/reception-settings", undefined, clerk)).body.settings;
  assert.equal(again.revision, 1);
  assert.equal(again.labels.includes("要散瞳"), false, "a label removed after the merge stays removed");
  assert.ok(again.marks.some((mark) => mark.key === cane.key));

  // ラベルだけを足す保存（受付メモの［＋］）でも取り込んだマークは残る
  const added = await request(stores, "PUT", "/v1/eye/reception-settings", { expectedRevision: 1, labels: [...again.labels, "発熱あり"] }, clerk);
  assert.ok(added.body.settings.marks.some((mark) => mark.key === cane.key));

  // 書き出しに受付の設定が入る
  const exported = await request(stores, "GET", "/v1/eye/export", undefined, director);
  assert.equal(exported.body.settings.receptionSettings.revision, 2);
});

test("a mark can be turned off without removing it from the patients that have it", () => {
  const validated = validateReceptionSettingsInput({ marks: [{ key: "cane", label: "杖", symbol: "杖", tone: "teal", active: false }, { key: "ear", label: "難聴", symbol: "耳", active: true }] });
  assert.deepEqual(validated.marks, [{ key: "cane", label: "杖", symbol: "杖", tone: "teal", active: false }, { key: "ear", label: "難聴", symbol: "耳", tone: "neutral" }]);
  const plain = receptionSettingsView(null);
  assert.equal(mergeLegacyReceptionLabels(plain, null), plain, "nothing to merge keeps the view");
  const view = receptionSettingsView({ labels: ["a"], marks: [], revision: 3, legacyRevision: 2 }, LEGACY);
  assert.deepEqual(view.labels, ["a"], "an already merged legacy revision is not merged again");
});

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
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
  return { platformStore, eyeStore, blobStore: new MemoryBlobStore(), orgId: organization.orgId };
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
