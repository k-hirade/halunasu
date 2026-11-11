// replicate-2（admin）: 施設管理の追加の設定（文書雛形・検査会社/院内検査項目・受付ラベル/患者マーク・診療時間・帳票設定・その他設定）、
// 医療機関情報の追加の欄、文書雛形の差し込み、経営データ集計。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { DEFAULT_ORDER_CATALOG } from "../../../packages/eye-contracts/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { fillTemplate } from "../src/doc-templates.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-09T01:00:00.000Z");

test("clinic config sections default, save with revisions by administrators only, and appear in bootstrap and export", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");

  const empty = await request(stores, "GET", "/v1/eye/clinic-config", undefined, clerk);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body.clinicConfig.docTemplates.value, { templates: [] });
  assert.equal(empty.body.clinicConfig.printSettings.value.defaultHonorific, "御侍史");
  assert.equal(empty.body.clinicConfig.clinicHours.value.slotMinutes, 30);
  assert.equal(empty.body.clinicConfig.otherSettings.revision, 0);
  assert.equal((await request(stores, "GET", "/v1/eye/clinic-config/unknown", undefined, clerk)).statusCode, 404);

  // 受付ラベル・患者マークは受付の設定（/v1/eye/reception-settings）だけに保存する。この API の項目ではない
  assert.equal((await request(stores, "GET", "/v1/eye/clinic-config/receptionLabels", undefined, clerk)).statusCode, 404);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/receptionLabels", { expectedRevision: 0, value: { labels: [{ name: "要散瞳" }] } }, director)).statusCode, 404);
  assert.equal(empty.body.clinicConfig.receptionLabels, undefined);
  const doctorWrite = await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 0, value: { letterSeal: false } }, doctor);
  assert.equal(doctorWrite.statusCode, 403, "only administrators change settings");
  const { "x-csrf-token": _csrf, ...withoutCsrf } = director;
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 0, value: { letterSeal: false } }, withoutCsrf)).statusCode, 403);
  const print = await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 0, value: { defaultHonorific: "先生", footerNote: "散瞳後は運転しないでください" } }, director);
  assert.equal(print.statusCode, 200);
  assert.equal(print.body.revision, 1);
  assert.equal(print.body.updatedBy.loginId, "eye-director");
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 0, value: {} }, director)).statusCode, 409, "stale revision is rejected");
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 1, value: { defaultHonorific: "様" } }, director)).statusCode, 400);
  const print2 = await request(stores, "PUT", "/v1/eye/clinic-config/printSettings", { expectedRevision: 1, value: { ...print.body.value, letterSeal: false } }, director);
  assert.equal(print2.body.revision, 2);

  // 院内検査項目はオーダーの候補に加わる（停止中は出さない）
  const lab = await request(stores, "PUT", "/v1/eye/clinic-config/labLists", { value: { companies: [{ companyId: "c1", name: "中央検査センター", phone: "03-1111-2222" }], items: [{ name: "血液検査（糖尿病）", kind: "exam", requiresEye: false, companyId: "c1" }, { name: "停止中の項目", active: false }] } }, director);
  assert.equal(lab.statusCode, 200);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/labLists", { expectedRevision: 1, value: { companies: [], items: [{ name: "x", companyId: "missing" }] } }, director)).statusCode, 400);
  const boot = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(boot.body.orderCatalog.length, DEFAULT_ORDER_CATALOG.length + 1);
  const added = boot.body.orderCatalog.at(-1);
  assert.equal(added.name, "血液検査（糖尿病）");
  assert.match(added.code, /^lab:/u);
  assert.equal(added.requiresEye, false);
  assert.equal(added.labCompany, "中央検査センター");
  assert.equal(boot.body.clinicConfig.receptionLabels, undefined);
  assert.equal(boot.body.clinicConfig.printSettings.letterSeal, false);

  // 診療時間: 重なりと逆順は止める
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/clinicHours", { value: { slotMinutes: 15, days: { mon: [{ from: "09:00", to: "12:30" }, { from: "12:00", to: "18:00" }] } } }, director)).statusCode, 400);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/clinicHours", { value: { slotMinutes: 7 } }, director)).body.field, "slotMinutes");
  const hours = await request(stores, "PUT", "/v1/eye/clinic-config/clinicHours", { value: { slotMinutes: 15, days: { mon: [{ from: "14:30", to: "18:00" }, { from: "09:00", to: "12:30" }], sat: [{ from: "09:00", to: "13:00" }] }, note: "木曜・日曜・祝日は休診" } }, director);
  assert.equal(hours.statusCode, 200);
  assert.deepEqual(hours.body.value.days.mon.map((item) => item.from), ["09:00", "14:30"]);
  assert.deepEqual(hours.body.value.days.thu, []);

  const exported = await request(stores, "GET", "/v1/eye/export", undefined, director);
  assert.equal(exported.body.settings.clinicConfig.printSettings.revision, 2);
  assert.equal(exported.body.settings.receptionSettings, undefined, "unsaved reception settings are not exported");
  assert.equal(exported.body.settings.clinicConfig.docTemplates, undefined, "only saved sections are exported");
  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=settings", undefined, director);
  const log = logs.body.auditLogs.find((item) => item.eventType === "eye.clinic_config_saved" && item.targetId === "printSettings");
  assert.ok(log);
  assert.equal(JSON.stringify(log.safePayload).includes("散瞳"), false, "free text is not written to the audit log");
});

test("facility settings accept kana, representative, prescription route and invoice number", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const base = { expectedRevision: 0, name: "あさおか眼科", nameKana: "アサオカガンカ", representative: "朝岡 一郎", representativeKana: "アサオカ イチロウ", prescriptionRoute: "outside", invoiceRegistrationNumber: "t1234567890123" };
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...base, nameKana: "asaoka" }, director)).body.field, "nameKana");
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...base, prescriptionRoute: "both" }, director)).body.field, "prescriptionRoute");
  assert.equal((await request(stores, "PUT", "/v1/eye/facility-settings", { ...base, invoiceRegistrationNumber: "T123" }, director)).body.field, "invoiceRegistrationNumber");
  const saved = await request(stores, "PUT", "/v1/eye/facility-settings", base, director);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.facilitySettings.invoiceRegistrationNumber, "T1234567890123");
  assert.equal(saved.body.facilitySettings.representative, "朝岡 一郎");
  assert.equal(saved.body.facility.prescriptionRoute, "outside");
  assert.equal(saved.body.facility.nameKana, "アサオカガンカ");
});

test("document templates fill patient and chart values into a draft and keep finalized documents unchanged", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, director);
  const template = { templateId: "tpl1", name: "白内障手術の紹介", type: "referral", title: "診療情報提供書（手術）", body: "{{患者氏名}} 様（{{年齢}}・{{性別}}）\n【傷病名】\n{{傷病名}}\n【紹介目的】\n手術のご検討をお願いいたします。\n【未知】{{未知の欄}}" };
  await request(stores, "PUT", "/v1/eye/clinic-config/docTemplates", { value: { templates: [template, { templateId: "tpl2", name: "停止中", body: "x", active: false }] } }, director);
  const document = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, director)).body.document;

  assert.equal((await request(stores, "POST", `/v1/eye/documents/${document.documentId}/apply-template`, { expectedRevision: document.revision, templateId: "tpl2" }, director)).statusCode, 404, "inactive templates cannot be used");
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${document.documentId}/apply-template`, { expectedRevision: document.revision, templateId: "tpl1" }, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
  const applied = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/apply-template`, { expectedRevision: document.revision, templateId: "tpl1" }, clerk);
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.body.document.title, "診療情報提供書（手術）");
  assert.match(applied.body.document.body, /^眼科 太郎 様（76歳・男）/u);
  assert.match(applied.body.document.body, /\{\{未知の欄\}\}/u, "unknown placeholders stay visible");
  assert.equal(applied.body.document.revision, document.revision + 1);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${document.documentId}/apply-template`, { expectedRevision: document.revision, templateId: "tpl1" }, director)).statusCode, 409);

  const finalized = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/finalize`, { expectedRevision: applied.body.document.revision }, director);
  assert.equal(finalized.statusCode, 200);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${document.documentId}/apply-template`, { expectedRevision: finalized.body.document.revision, templateId: "tpl1" }, director)).statusCode, 409);
  assert.equal(fillTemplate("{{ 患者氏名 }}/{{x}}", { 患者氏名: "A" }), "A/{{x}}");
});

test("visit report counts arrivals per day and month for administrators and records the export", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, director);
  const booked = (await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", time: "09:30", patientId: patient.patientId, purpose: "initial", note: "右眼かすみ" }, clerk)).body.appointment;
  await request(stores, "POST", `/v1/eye/appointments/${booked.appointmentId}/status`, { expectedRevision: booked.revision, status: "checked_in" }, clerk);
  await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-28", patientName: "飛込 花子", walkIn: true, purpose: "revisit" }, clerk);
  const cancelled = (await request(stores, "POST", "/v1/eye/appointments", { date: "2026-11-02", time: "10:00", patientId: patient.patientId, purpose: "revisit" }, clerk)).body.appointment;
  await request(stores, "POST", `/v1/eye/appointments/${cancelled.appointmentId}/status`, { expectedRevision: cancelled.revision, status: "cancelled" }, clerk);

  assert.equal((await request(stores, "GET", "/v1/eye/reports/visits?from=2026-10-01&to=2026-11-30", undefined, clerk)).statusCode, 403);
  assert.equal((await request(stores, "GET", "/v1/eye/reports/visits?from=2026-11-30&to=2026-10-01", undefined, director)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/reports/visits?from=2025-01-01&to=2026-11-30", undefined, director)).body.field, "to");
  const response = await request(stores, "GET", "/v1/eye/reports/visits?from=2026-10-01&to=2026-11-30", undefined, director);
  assert.equal(response.statusCode, 200);
  const { report } = response.body;
  assert.equal(report.days.length, 61);
  assert.deepEqual(report.totals, { booked: 2, arrived: 2, initial: 1, revisit: 1, walkIn: 1, cancelled: 1, absent: 0 });
  assert.deepEqual(report.months.map((item) => [item.month, item.arrived, item.cancelled, item.openDays]), [["2026-10", 2, 0, 2], ["2026-11", 0, 1, 0]]);
  assert.equal(report.visits[0].patientName, "眼科 太郎");
  assert.equal(report.visits[0].receptionMemo, undefined, "memos only when asked");
  const withMemo = await request(stores, "GET", "/v1/eye/reports/visits?from=2026-10-27&to=2026-10-27&includeMemo=1", undefined, director);
  assert.equal(withMemo.body.report.visits[0].receptionMemo, "右眼かすみ");
  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=export", undefined, director);
  assert.ok(logs.body.auditLogs.some((item) => item.eventType === "eye.report_exported" && item.safePayload.includeMemo === true));
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
