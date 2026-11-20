import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { japanDate } from "../src/dates.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-10-27T01:00:00.000Z");

test("requires a Platform session with eye access", async () => {
  const stores = createStores();
  assert.equal((await request(stores, "GET", "/v1/eye/context")).statusCode, 401);

  const withoutEntitlement = createStores({ entitlement: false });
  const headers = await signedHeaders(withoutEntitlement.platformStore, "doctor");
  assert.equal((await request(withoutEntitlement, "GET", "/v1/eye/context", undefined, headers)).statusCode, 403);
});

test("reports role capabilities in the context", async () => {
  const stores = createStores();
  const doctor = await request(stores, "GET", "/v1/eye/context", undefined, await signedHeaders(stores.platformStore, "doctor"));
  const orthoptist = await request(stores, "GET", "/v1/eye/context", undefined, await signedHeaders(stores.platformStore, "orthoptist"));
  const clerk = await request(stores, "GET", "/v1/eye/context", undefined, await signedHeaders(stores.platformStore, "clerk"));

  assert.equal(doctor.body.context.canFinalize, true);
  assert.equal(orthoptist.body.context.canWrite, true);
  assert.equal(orthoptist.body.context.canFinalize, false);
  assert.equal(clerk.body.context.canWrite, false);
  assert.equal(clerk.body.context.canRegisterPatients, true);
});

test("runs the draft, finalize, amend, and refinalize lifecycle with immutable versions", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);

  const createdResponse = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial"
  }, doctor);
  assert.equal(createdResponse.statusCode, 201);
  const encounterId = createdResponse.body.encounter.encounterId;
  assert.equal(createdResponse.body.encounter.patientSnapshot.displayName, "眼科 太郎");

  const updated = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, {
    expectedRevision: 1,
    content: glaucomaContent({ iopOd: 18 })
  }, doctor);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.encounter.revision, 2);

  const stale = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, {
    expectedRevision: 1,
    sections: { exam: glaucomaContent({ iopOd: 30 }).exam }
  }, doctor);
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.body.details.sections, ["exam"]);

  // 未確認の検査値は確定を止めない（確認を促す warnings として出る）。ここでは確認してから確定する。
  const detailBefore = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, doctor);
  assert.deepEqual(detailBefore.body.readiness.blockers, []);
  assert.deepEqual(detailBefore.body.readiness.warnings.filter((item) => item.level === "high").map((item) => item.code), ["exam_unconfirmed", "exam_unconfirmed", "allergy_unconfirmed"]);

  const confirmed = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/exam-confirm`, { expectedRevision: 2, eye: "both" }, doctor);
  assert.equal(confirmed.body.encounter.examConfirmations.od.by.loginId, "eye-doctor");
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 3 }, doctor);
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.body.encounter.status, "finalized");
  assert.equal(finalized.body.version.version, 1);

  // 確定前の画面からの遅れた保存（確定後の版を見ていない）は、修正を始めずに止める
  const lateSave = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, {
    expectedRevision: 3,
    sections: { plan: "変更" }
  }, doctor);
  assert.equal(lateSave.statusCode, 409);

  const amended = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/amend`, { expectedRevision: 4, reason: "眼圧の転記誤り" }, doctor);
  assert.equal(amended.body.encounter.status, "draft");
  const corrected = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: 5, sections: { exam: glaucomaContent({ iopOd: 17 }).exam } }, doctor);
  assert.equal(corrected.body.encounter.examConfirmations.od, null, "changing a measurement clears its confirmation");
  assert.notEqual(corrected.body.encounter.examConfirmations.os, null, "the other eye keeps its confirmation");
  await request(stores, "POST", `/v1/eye/encounters/${encounterId}/exam-confirm`, { expectedRevision: 6, eye: "od" }, doctor);
  const refinalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 7 }, doctor);
  assert.equal(refinalized.body.version.version, 2);
  assert.equal(refinalized.body.version.amendmentReason, "眼圧の転記誤り");

  const v1 = await request(stores, "GET", `/v1/eye/encounters/${encounterId}/versions/1`, undefined, doctor);
  const v2 = await request(stores, "GET", `/v1/eye/encounters/${encounterId}/versions/2`, undefined, doctor);
  assert.equal(v1.body.version.content.exam.od.iop, 18);
  assert.equal(v2.body.version.content.exam.od.iop, 17);

  const discard = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/discard`, { expectedRevision: 8 }, doctor);
  assert.equal(discard.statusCode, 409);
});

test("merges concurrent edits to different sections and records who changed order status", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: { orders: [{ orderId: "ord1", code: "oct_retina", name: "OCT（網膜）", eye: "ou" }] }
  }, doctor);
  const id = draft.body.encounter.encounterId;

  // 同じ revision 1 を見ている2人が、別の項目を保存する
  const byOrthoptist = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: 1,
    sections: { exam: { od: { vaCorrected: "1.0", vaCorrectionType: "glasses", measuredAt: "09:05" }, os: {} } }
  }, orthoptist);
  const byDoctor = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 1, sections: { plan: "経過観察" } }, doctor);
  assert.equal(byOrthoptist.statusCode, 200);
  assert.equal(byDoctor.statusCode, 200);
  assert.equal(byDoctor.body.encounter.content.exam.od.vaCorrected, "1.0");
  assert.equal(byDoctor.body.encounter.content.plan, "経過観察");

  const performed = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: byDoctor.body.encounter.revision,
    sections: { orders: [{ orderId: "ord1", code: "oct_retina", name: "OCT（網膜）", eye: "ou", status: "performed", statusChangedBy: { displayName: "forged" } }] }
  }, orthoptist);
  assert.equal(performed.body.encounter.content.orders[0].statusChangedBy.displayName, "eye-ort");

  const noop = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 1, sections: { plan: "経過観察" } }, doctor);
  assert.equal(noop.statusCode, 200, "unchanged sections are not conflicts");
  assert.equal(noop.body.encounter.revision, performed.body.encounter.revision);
});

test("enforces role boundaries for writing, finalizing, and patient registration", async () => {
  const stores = createStores();
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const viewer = await signedHeaders(stores.platformStore, "viewer");

  const patient = await createPatient(stores, clerk);
  assert.ok(patient.patientId);
  assert.equal((await request(stores, "POST", "/v1/eye/patients", { displayName: "x" }, viewer)).statusCode, 403);

  const forbiddenEncounter = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, clerk);
  assert.equal(forbiddenEncounter.statusCode, 403);

  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, orthoptist);
  assert.equal(draft.statusCode, 201);
  const finalize = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, orthoptist);
  assert.equal(finalize.statusCode, 403);

  const viewerRead = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, undefined, viewer);
  assert.equal(viewerRead.statusCode, 200);
});

test("rejects mutations without a matching CSRF token", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const response = await request(stores, "POST", "/v1/eye/patients", { displayName: "x" }, { ...doctor, "x-csrf-token": "wrong" });
  assert.equal(response.statusCode, 403);
});

test("revisit copies the previous plan, shows changes, and suggests bottles and the next visit", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", glaucomaContent({ iopOd: 15 }));

  const revisit = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, doctor);
  const copied = revisit.body.encounter;
  assert.equal(copied.copiedFromEncounterId.startsWith("eenc_"), true);
  assert.equal(copied.content.exam.od.iop, null);
  assert.equal(copied.content.prescriptions[0].name, "ラタノプロスト点眼液");

  await request(stores, "PATCH", `/v1/eye/encounters/${copied.encounterId}`, {
    expectedRevision: 1,
    content: { ...copied.content, exam: glaucomaContent({ iopOd: 21 }).exam }
  }, doctor);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${copied.encounterId}`, undefined, doctor);

  assert.equal(detail.body.previous.encounterDate, "2026-07-28");
  assert.ok(detail.body.changes.some((change) => change.path === "exam.od.iop" && change.before === "15" && change.after === "21"));
  assert.deepEqual(
    detail.body.bottleSuggestions[0],
    { index: 0, applicable: true, days: 84, daysSource: "next_visit", bottles: 2, dropsNeeded: 168, dropsPerBottle: 100, reason: "calculated" }
  );
  assert.equal(detail.body.nextVisitSuggestion.intervalWeeks, 12);
  assert.equal(detail.body.nextVisitSuggestion.basis, "previous_plan");
});

test("uses facility drug presets for bottle capacity", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "director");
  assert.equal((await request(stores, "POST", "/v1/eye/drug-presets", { name: "x" }, await signedHeaders(stores.platformStore, "doctor"))).statusCode, 403);
  const preset = await request(stores, "POST", "/v1/eye/drug-presets", { name: "ヒアレイン点眼液0.1%", defaultTimesPerDay: 4, dropsPerBottle: 120 }, doctor);
  assert.equal(preset.statusCode, 200);
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: {
      prescriptions: [{ kind: "eye_drop", name: "ヒアレイン点眼液0.1%", presetId: preset.body.drugPreset.presetId, eye: "ou", timesPerDay: 4 }],
      nextVisit: { intervalWeeks: 4 }
    }
  }, doctor);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, undefined, doctor);

  assert.equal(detail.body.bottleSuggestions[0].dropsPerBottle, 120);
  assert.equal(detail.body.bottleSuggestions[0].bottles, 2);
});

test("builds the patient chart with trend and records view audit events", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", glaucomaContent({ iopOd: 15 }));
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-10-20", glaucomaContent({ iopOd: 19 }));

  const chart = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/chart`, undefined, doctor);
  assert.equal(chart.statusCode, 200);
  assert.deepEqual(chart.body.trend.points.map((point) => point.od.iop), [15, 19]);
  assert.equal(chart.body.encounters[0].encounterDate, "2026-10-20");
  assert.equal(chart.body.latestFinalized.encounterDate, "2026-10-20");

  const today = await request(stores, "GET", "/v1/eye/encounters?date=2026-10-20", undefined, doctor);
  assert.equal(today.body.encounters.length, 1);

  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs", undefined, doctor)).statusCode, 403);
  const logs = await request(stores, "GET", "/v1/eye/audit-logs", undefined, await signedHeaders(stores.platformStore, "director"));
  const types = logs.body.auditLogs.map((log) => log.eventType);
  assert.ok(types.includes("eye.chart_viewed"));
  assert.ok(types.includes("eye.encounter_finalized"));
  assert.equal(JSON.stringify(logs.body.auditLogs).includes("ラタノプロスト"), false);
  assert.equal(logs.body.patients[patient.patientId].displayName, patient.displayName);
});

test("filters and pages audit logs on the server and names the actors", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const members = stores.platformStore.listMembers((await request(stores, "GET", "/v1/eye/context", undefined, director)).body.context.orgId);
  const doctorMember = members.find((member) => member.loginId === "eye-doctor");
  const orgId = doctorMember.orgId;
  const seed = (createdAt, eventType, extra = {}) => stores.eyeStore.recordAudit(orgId, {
    createdAt, eventType, actorMemberId: doctorMember.memberId, actorLoginId: "eye-doctor", ...extra
  });
  // 日本時間 10/25 23:30 は UTC では 10/25 14:30、10/26 08:30 は UTC 10/25 23:30
  seed("2026-10-25T14:30:00.000Z", "eye.chart_viewed", { patientId: patient.patientId, targetType: "patient", targetId: patient.patientId });
  seed("2026-10-25T23:30:00.000Z", "eye.encounter_finalized", { patientId: patient.patientId });
  seed("2026-10-26T02:00:00.000Z", "eye.drug_preset_saved", { targetType: "drug_preset", targetId: "edp_x" });
  seed("2026-10-26T03:00:00.000Z", "eye.chart_viewed", { patientId: patient.patientId });

  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs?from=2026-10-26", undefined, doctor)).statusCode, 403);
  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs?from=2026/10/26", undefined, director)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs?from=2026-10-27&to=2026-10-26", undefined, director)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs?category=nope", undefined, director)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/audit-logs?limit=0", undefined, director)).statusCode, 400);

  const day = await request(stores, "GET", "/v1/eye/audit-logs?from=2026-10-26&to=2026-10-26", undefined, director);
  assert.equal(day.statusCode, 200);
  assert.deepEqual(day.body.auditLogs.map((log) => log.createdAt), ["2026-10-26T03:00:00.000Z", "2026-10-26T02:00:00.000Z", "2026-10-25T23:30:00.000Z"]);
  assert.deepEqual(day.body.range, { from: "2026-10-26", to: "2026-10-26" });
  assert.equal(day.body.nextCursor, null);
  assert.equal(day.body.actors[doctorMember.memberId].loginId, "eye-doctor");
  assert.equal(typeof day.body.actors[doctorMember.memberId].displayName, "string");
  assert.equal(JSON.stringify(day.body.actors).includes("password"), false);

  const settingsOnly = await request(stores, "GET", "/v1/eye/audit-logs?category=settings", undefined, director);
  assert.deepEqual(settingsOnly.body.auditLogs.map((log) => log.eventType), ["eye.drug_preset_saved"]);
  const views = await request(stores, "GET", `/v1/eye/audit-logs?category=view&patientId=${patient.patientId}&actor=${doctorMember.memberId}`, undefined, director);
  assert.ok(views.body.auditLogs.length >= 2);
  assert.ok(views.body.auditLogs.every((log) => log.eventType.endsWith("_viewed") && log.patientId === patient.patientId));
  const nobody = await request(stores, "GET", "/v1/eye/audit-logs?actor=someone-else", undefined, director);
  assert.deepEqual(nobody.body.auditLogs, []);
  assert.equal(nobody.body.nextCursor, null);

  // 2件ずつ読み進めて、重複も抜けもなく最後まで辿れる
  const seen = [];
  let cursor = "";
  for (let guard = 0; guard < 20; guard += 1) {
    const pageResponse = await request(stores, "GET", `/v1/eye/audit-logs?from=2026-10-25&to=2026-10-26&limit=2${cursor ? `&cursor=${cursor}` : ""}`, undefined, director);
    seen.push(...pageResponse.body.auditLogs.map((log) => log.auditLogId));
    if (!pageResponse.body.nextCursor) break;
    cursor = pageResponse.body.nextCursor;
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);

  // パラメータなしは従来どおり直近の記録(既定 200 件まで)
  const legacy = await request(stores, "GET", "/v1/eye/audit-logs", undefined, director);
  assert.ok(legacy.body.auditLogs.length >= 4);
  assert.equal(legacy.body.patients[patient.patientId].displayName, patient.displayName);
});

test("discards a never-finalized draft", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, doctor);
  const response = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/discard`, { expectedRevision: 1 }, doctor);
  assert.equal(response.statusCode, 200);
  assert.equal((await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, undefined, doctor)).statusCode, 404);
});

test("searches patients by name", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  await createPatient(stores, doctor);
  const response = await request(stores, "POST", "/v1/eye/patients/search", { q: "眼科" }, doctor);
  assert.equal(response.body.patients.length, 1);
  const leaked = await request(stores, "GET", `/v1/eye/patients?q=${encodeURIComponent("眼科")}`, undefined, doctor);
  assert.equal(leaked.statusCode, 400, "search terms must not travel in the URL");
});

function glaucomaContent({ iopOd }) {
  return {
    chiefComplaint: "定期検査",
    exam: {
      od: { vaCorrected: "1.0", iop: iopOd, iopMethod: "nct" },
      os: { vaCorrected: "0.9", iop: 16, iopMethod: "nct" }
    },
    diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }],
    prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1 }],
    plan: "点眼継続",
    nextVisit: { intervalWeeks: 12 }
  };
}

async function createPatient(stores, headers, overrides = {}) {
  const response = await request(stores, "POST", "/v1/eye/patients", {
    displayName: "眼科 太郎",
    displayNameKana: "ガンカ タロウ",
    birthDate: "1950-04-01",
    sex: "male",
    primaryPatientNumber: "000123",
    ...overrides
  }, headers);
  assert.equal(response.statusCode, 201);
  return response.body.patient;
}

async function finalizedEncounter(stores, headers, patientId, encounterDate, content) {
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId, encounterDate, visitType: "initial", content }, headers);
  await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/exam-confirm`, { expectedRevision: 1, eye: "both" }, headers);
  const response = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 2 }, headers);
  assert.equal(response.statusCode, 200);
  return response.body.encounter;
}

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  orthoptist: { loginId: "eye-ort", globalRoles: [], productRoles: { eye: ["orthoptist"] } },
  clerk: { loginId: "eye-clerk", globalRoles: [], productRoles: { eye: ["medical_clerk"] } },
  viewer: { loginId: "eye-viewer", globalRoles: [], productRoles: { eye: ["viewer"] } }
};

function createStores(options = {}) {
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
  if (options.entitlement !== false) {
    platformStore.upsertProductEntitlement(organization.orgId, { productId: "eye", status: "trialing" });
  }
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
  }, {
    now: NOW,
    sessionSecret: "test-session-secret"
  });
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

function request(stores, method, path, body, headers = {}, rawBody = undefined) {
  return handleEyeApiRequest({
    method,
    path,
    body,
    rawBody,
    headers,
    platformStore: stores.platformStore,
    eyeStore: stores.eyeStore,
    blobStore: stores.blobStore,
    now: () => NOW,
    sessionSecret: "test-session-secret"
  });
}

test("refuses to finalize while a prescription row has no name", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    content: { prescriptions: [{ kind: "eye_drop", name: "" }] }
  }, doctor);
  assert.equal(draft.statusCode, 201);
  const finalize = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  assert.equal(finalize.statusCode, 400);
  assert.equal(finalize.body.field, "content.prescriptions.0.name");
  assert.equal(finalize.body.details.blockers[0].code, "prescription_name_missing");
});

test("books, checks in with sequential queue numbers, and walks the visit through the board", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, clerk);

  const booked = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", time: "09:30", patientId: patient.patientId, purpose: "revisit" }, clerk);
  assert.equal(booked.statusCode, 201);
  assert.equal(booked.body.appointment.status, "booked");
  assert.equal(booked.body.appointment.queueNumber, null);
  assert.equal(booked.body.appointment.patientName, "眼科 太郎");

  const walkIn = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", patientName: "飛込 花子", walkIn: true, purpose: "initial" }, clerk);
  assert.equal(walkIn.body.appointment.status, "checked_in");
  assert.equal(walkIn.body.appointment.queueNumber, 1);

  const id = booked.body.appointment.appointmentId;
  const checkedIn = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: 1, status: "checked_in" }, clerk);
  assert.equal(checkedIn.body.appointment.queueNumber, 2);

  const stale = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: 1, status: "in_exam" }, clerk);
  assert.equal(stale.statusCode, 409);

  let revision = 2;
  for (const status of ["in_exam", "waiting_doctor", "in_consult", "checkout", "done"]) {
    const moved = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: revision, status }, clerk);
    assert.equal(moved.statusCode, 200, status);
    revision = moved.body.appointment.revision;
  }

  // デジカルと同じく、どの状態からでも選んだ状態へ移れる（会計済から受付中へ戻すことも）
  const recheck = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: revision, status: "checked_in" }, clerk);
  assert.equal(recheck.statusCode, 200);
  assert.equal(recheck.body.appointment.queueNumber, 2, "the queue number stays from the first check-in");

  const list = await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk);
  assert.deepEqual(list.body.appointments.map((item) => item.time || "walk-in"), ["09:30", "walk-in"]);
});

test("links a walk-in to a newly registered patient and shows upcoming visits on the chart", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const walkIn = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", patientName: "眼科 太郎", walkIn: true }, doctor);
  const patient = await createPatient(stores, doctor);
  const linked = await request(stores, "PATCH", `/v1/eye/appointments/${walkIn.body.appointment.appointmentId}`, { expectedRevision: 1, patientId: patient.patientId }, doctor);
  assert.equal(linked.body.appointment.patientId, patient.patientId);
  assert.equal(linked.body.appointment.patientSnapshot.displayName, "眼科 太郎");

  await request(stores, "POST", "/v1/eye/appointments", { date: "2027-01-19", time: "10:00", patientId: patient.patientId }, doctor);
  await request(stores, "POST", "/v1/eye/appointments", { date: "2026-01-19", time: "10:00", patientId: patient.patientId }, doctor);
  const chart = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/chart`, undefined, doctor);
  assert.deepEqual(chart.body.upcomingAppointments.map((item) => item.date), ["2026-10-27", "2027-01-19"]);

  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, doctor);
  const board = await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, doctor);
  assert.equal(board.body.encountersByPatient[patient.patientId].encounterId, draft.body.encounter.encounterId);
  assert.deepEqual(board.body.encountersByPatient[patient.patientId].exam, { va: false, iop: false });

  await request(stores, "PATCH", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, {
    expectedRevision: draft.body.encounter.revision,
    sections: {
      exam: { od: { vaCorrected: "1.0", iop: 15 }, os: {} },
      orders: [{ orderId: "ord_1", code: "oct", name: "OCT", kind: "exam", eye: "ou", status: "planned" }]
    }
  }, doctor);
  const progressed = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, doctor)).body.encountersByPatient[patient.patientId];
  assert.deepEqual(progressed.exam, { va: true, iop: true });
  assert.deepEqual(progressed.orders, [{ name: "OCT", status: "planned" }]);
  assert.equal(JSON.stringify(progressed).includes("1.0"), false, "the board summary does not expose measured values");
});

test("viewers cannot change reception", async () => {
  const stores = createStores();
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  const response = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", patientName: "x" }, viewer);
  assert.equal(response.statusCode, 403);
  const invalid = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", time: "25:00", patientName: "x" }, await signedHeaders(stores.platformStore, "clerk"));
  assert.equal(invalid.statusCode, 400);
});

test("stored encounters never contain nested arrays (Firestore cannot store them)", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: { ...glaucomaContent({ iopOd: 15 }), sketches: [{ sketchId: "s1", template: "fundus", eye: "od", strokes: [{ points: [[10, 20], [30, 40]] }] }] }
  }, doctor);
  await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/exam-confirm`, { expectedRevision: 1, eye: "both" }, doctor);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 2 }, doctor);
  const version = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}/versions/1`, undefined, doctor);

  assert.deepEqual(finalized.body.encounter.content.sketches[0].strokes[0].points, [10, 20, 30, 40]);
  assertFirestoreCompatible(finalized.body.encounter);
  assertFirestoreCompatible(version.body.version);
});

function assertFirestoreCompatible(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assert.equal(Array.isArray(item), false, `nested array at ${path}[${index}]`);
      assertFirestoreCompatible(item, `${path}[${index}]`);
    });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertFirestoreCompatible(item, `${path}.${key}`);
  }
}

test("derives the patient profile from history until it is saved, then enforces roles and revisions", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", glaucomaContent({ iopOd: 15 }));

  const derived = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/profile`, undefined, clerk);
  assert.equal(derived.body.profile.revision, 0);
  assert.equal(derived.body.profile.derived, true);
  assert.deepEqual(derived.body.profile.diagnoses.map((item) => [item.name, item.startDate]), [["原発開放隅角緑内障", "2026-07-28"]]);

  const allergies = [{ category: "drug", substance: "ペニシリン系", reaction: "発疹", severity: "moderate" }];
  const byClerk = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 0,
    allergies,
    diagnoses: derived.body.profile.diagnoses
  }, clerk);
  assert.equal(byClerk.statusCode, 200);
  assert.equal(byClerk.body.profile.revision, 1);
  assert.match(byClerk.body.profile.allergies[0].allergyId, /^ealg_/u);

  const clerkDiagnosis = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 1,
    allergies,
    diagnoses: [...byClerk.body.profile.diagnoses, { name: "白内障", eye: "od" }]
  }, clerk);
  assert.equal(clerkDiagnosis.statusCode, 403);

  const stale = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, { expectedRevision: 0, allergies }, doctor);
  assert.equal(stale.statusCode, 409);

  const contradictory = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, { expectedRevision: 1, allergies, noKnownAllergies: true }, doctor);
  assert.equal(contradictory.statusCode, 400);
});

test("finalization snapshots the diagnoses that are current on the visit date", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 0,
    noKnownAllergies: true,
    diagnoses: [
      { name: "原発開放隅角緑内障", eye: "ou", status: "active", startDate: "2025-01-10", primary: true },
      { name: "アレルギー性結膜炎", eye: "ou", status: "resolved", startDate: "2026-03-01", endDate: "2026-05-01" },
      { name: "白内障", eye: "od", status: "suspected", startDate: "2026-12-01" }
    ]
  }, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", visitType: "initial" }, doctor);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);

  assert.deepEqual(finalized.body.encounter.content.diagnoses.map((item) => item.name), ["原発開放隅角緑内障"]);
  const chart = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/chart`, undefined, doctor);
  assert.equal(chart.body.profile.noKnownAllergies, true);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, undefined, doctor);
  assert.equal(detail.body.profile.revision, 1);
});

test("manages order sets and phrases for the clinic", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const set = await request(stores, "POST", "/v1/eye/order-sets", {
    name: "緑内障 定期",
    prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1, usage: "就寝前", route: "outside" }],
    orders: [{ code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou" }],
    plan: "点眼継続。"
  }, director);
  assert.equal(set.statusCode, 200);
  assert.equal(set.body.orderSet.orders[0].status, "planned");
  assert.equal(set.body.orderSet.prescriptions[0].usage, "就寝前");
  // 医師もセットを作れる（カルテから作るため）。看護師・視能訓練士は作れない。
  assert.equal((await request(stores, "POST", "/v1/eye/order-sets", { name: "x" }, doctor)).statusCode, 200);
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  assert.equal((await request(stores, "POST", "/v1/eye/order-sets", { name: "y" }, orthoptist)).statusCode, 403);

  const phrase = await request(stores, "POST", "/v1/eye/phrases", { target: "findings.fundus", label: "眼底正常", text: "異常なし" }, director);
  assert.equal(phrase.body.phrase.target, "findings.fundus");
  assert.equal((await request(stores, "POST", "/v1/eye/phrases", { target: "nowhere", text: "x" }, director)).statusCode, 400);

  const bootstrap = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(bootstrap.body.orderSets.length, 2);
  assert.deepEqual(bootstrap.body.setFolders, []);
  assert.equal(bootstrap.body.phrases.length, 1);
  assert.ok(bootstrap.body.orderCatalog.some((item) => item.code === "oct_retina"));
});

test("does not count bottles for prescriptions that are not issued this time", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: {
      prescriptions: [
        { kind: "eye_drop", name: "ラタノプロスト", eye: "ou", timesPerDay: 1, issued: false },
        { kind: "eye_drop", name: "チモロール", eye: "ou", timesPerDay: 2 }
      ],
      nextVisit: { intervalWeeks: 4 }
    }
  }, doctor);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}`, undefined, doctor);
  assert.equal(detail.body.bottleSuggestions[0].applicable, false);
  assert.equal(detail.body.bottleSuggestions[1].applicable, true);
  assert.equal(detail.body.encounter.content.prescriptions[1].route, "outside");
});

test("drafts a referral letter from the chart, finalizes it, and requires a copy for changes", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 0,
    allergies: [{ substance: "ペニシリン系", reaction: "発疹", severity: "moderate" }],
    diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou", startDate: "2026-07-01" }]
  }, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", glaucomaContent({ iopOd: 15 }));

  const created = await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, clerk);
  assert.equal(created.statusCode, 201);
  const document = created.body.document;
  assert.equal(document.title, "診療情報提供書");
  assert.match(document.body, /両眼 原発開放隅角緑内障/u);
  assert.match(document.body, /ペニシリン系（発疹・中等度）/u);
  assert.match(document.body, /眼圧 右 15 mmHg/u);
  assert.match(document.body, /ラタノプロスト点眼液（両眼 1日1回）/u);

  const edited = await request(stores, "PATCH", `/v1/eye/documents/${document.documentId}`, {
    expectedRevision: 1,
    recipient: { institution: "県立病院", department: "眼科", doctor: "山田" },
    body: document.body.replace("【紹介目的】\n", "【紹介目的】\n手術のご検討をお願いします。\n")
  }, clerk);
  assert.equal(edited.body.document.recipient.institution, "県立病院");

  assert.equal((await request(stores, "POST", `/v1/eye/documents/${document.documentId}/finalize`, { expectedRevision: 2 }, clerk)).statusCode, 403);
  const finalized = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/finalize`, { expectedRevision: 2 }, doctor);
  assert.equal(finalized.body.document.status, "finalized");
  assert.match(finalized.body.document.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal((await request(stores, "PATCH", `/v1/eye/documents/${document.documentId}`, { expectedRevision: 3, body: "x" }, doctor)).statusCode, 409);

  const copy = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/duplicate`, {}, doctor);
  assert.equal(copy.body.document.status, "draft");
  assert.equal(copy.body.document.sourceDocumentId, document.documentId);
  const list = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/documents`, undefined, doctor);
  assert.equal(list.body.documents.length, 2);
});

test("discards a never-finalized document draft, hides it from the list, and keeps finalized ones", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const draft = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "certificate" }, clerk)).body.document;
  const kept = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, doctor)).body.document;

  assert.equal((await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/discard`, {}, clerk)).statusCode, 400);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/discard`, { expectedRevision: 9 }, clerk)).statusCode, 409);
  const discarded = await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/discard`, { expectedRevision: 1 }, clerk);
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.body.document.status, "discarded");
  assert.equal(discarded.body.document.discardedBy.memberId.length > 0, true);
  // 破棄した下書きは一覧に出ず、編集・確定・複製・再破棄はできない。記録そのものは残る。
  const list = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/documents`, undefined, doctor);
  assert.deepEqual(list.body.documents.map((item) => item.documentId), [kept.documentId]);
  assert.equal((await request(stores, "GET", `/v1/eye/documents/${draft.documentId}`, undefined, doctor)).body.document.status, "discarded");
  assert.equal((await request(stores, "PATCH", `/v1/eye/documents/${draft.documentId}`, { expectedRevision: 2, body: "x" }, doctor)).statusCode, 409);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/finalize`, { expectedRevision: 2 }, doctor)).statusCode, 409);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/duplicate`, {}, doctor)).statusCode, 409);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${draft.documentId}/discard`, { expectedRevision: 2 }, doctor)).statusCode, 409);

  // 確定済みは破棄できない
  await request(stores, "PATCH", `/v1/eye/documents/${kept.documentId}`, { expectedRevision: 1, recipient: { institution: "県立病院" }, body: "本文" }, doctor);
  await request(stores, "POST", `/v1/eye/documents/${kept.documentId}/finalize`, { expectedRevision: 2 }, doctor);
  assert.equal((await request(stores, "POST", `/v1/eye/documents/${kept.documentId}/discard`, { expectedRevision: 3 }, doctor)).statusCode, 409);

  const logs = await request(stores, "GET", "/v1/eye/audit-logs", undefined, await signedHeaders(stores.platformStore, "director"));
  assert.ok(logs.body.auditLogs.some((log) => log.eventType === "eye.document_discarded" && log.targetId === draft.documentId));
});

test("suggests recipients from finalized documents across the clinic", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const first = await createPatient(stores, doctor);
  const second = await createPatient(stores, doctor, { displayName: "眼科 花子", displayNameKana: "ガンカ ハナコ", primaryPatientNumber: "000124" });
  const write = async (patientId, recipient, finalize = true) => {
    const document = (await request(stores, "POST", "/v1/eye/documents", { patientId, type: "referral" }, doctor)).body.document;
    await request(stores, "PATCH", `/v1/eye/documents/${document.documentId}`, { expectedRevision: 1, recipient, body: "本文" }, doctor);
    if (finalize) await request(stores, "POST", `/v1/eye/documents/${document.documentId}/finalize`, { expectedRevision: 2 }, doctor);
  };
  await write(first.patientId, { institution: "県立病院", department: "眼科", doctor: "山田" });
  await write(second.patientId, { institution: "県立病院", department: "眼科", doctor: "山田" });
  await write(second.patientId, { institution: "大学病院", department: "眼科", doctor: "" });
  await write(second.patientId, { institution: "下書き病院", department: "", doctor: "" }, false);
  await write(second.patientId, { institution: "", department: "", doctor: "" });

  const response = await request(stores, "GET", "/v1/eye/documents/recipients", undefined, doctor);
  assert.equal(response.statusCode, 200);
  const byName = Object.fromEntries(response.body.recipients.map((item) => [item.institution, item]));
  assert.deepEqual(Object.keys(byName).sort(), ["大学病院", "県立病院"]);
  assert.equal(byName["県立病院"].count, 2);
  assert.equal(byName["県立病院"].doctor, "山田");
  assert.equal(JSON.stringify(response.body).includes(first.patientId), false, "recipient suggestions carry no patient data");
});

test("finalizes an issued glasses prescription with inconsistent values but returns warnings", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: { optical: { type: "glasses", issue: true, od: { sphere: -2, cylinder: -0.5 }, os: { sphere: -1.5 }, pd: 62 } }
  }, doctor);
  // デジカルと同じく止めずに確定し、確認事項を warnings として返す（版にもコードを残す）
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  assert.equal(finalized.statusCode, 200);
  assert.ok(finalized.body.warnings.some((item) => item.code === "optical_axis_mismatch" && item.level === "high"));
  const version = await request(stores, "GET", `/v1/eye/encounters/${draft.body.encounter.encounterId}/versions/1`, undefined, doctor);
  assert.ok(version.body.version.warningCodes.includes("optical_axis_mismatch"));
});

test("uploads files through a short-lived URL, verifies their type, and serves them back", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");

  const started = await request(stores, "POST", "/v1/eye/files/uploads", {
    patientId: patient.patientId, kind: "vf", eye: "ou", takenOn: "2026-10-27", title: "Humphrey 24-2", contentType: "application/pdf", size: pdf.length
  }, clerk);
  assert.equal(started.statusCode, 201);
  assert.equal(started.body.file.status, "pending");
  const uploadPath = `/${started.body.upload.url}`;
  const put = await request(stores, "PUT", uploadPath, undefined, { ...clerk, "content-type": "application/pdf" }, pdf);
  assert.equal(put.statusCode, 200);
  const replay = await request(stores, "PUT", uploadPath, undefined, { ...clerk, "content-type": "application/pdf" }, pdf);
  assert.equal(replay.statusCode, 403, "upload tokens are single use");

  const fileId = started.body.file.fileId;
  const completed = await request(stores, "POST", `/v1/eye/files/${fileId}/complete`, {}, clerk);
  assert.equal(completed.body.file.status, "stored");
  assert.equal(completed.body.file.size, pdf.length);

  const list = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/files`, undefined, doctor);
  assert.deepEqual(list.body.files.map((item) => item.title), ["Humphrey 24-2"]);
  const link = await request(stores, "GET", `/v1/eye/files/${fileId}/url`, undefined, doctor);
  const blob = await request(stores, "GET", `/${link.body.download.url}`, undefined, doctor);
  assert.equal(blob.headers["content-type"], "application/pdf");
  assert.equal(Buffer.compare(blob.raw, pdf), 0);

  const archived = await request(stores, "POST", `/v1/eye/files/${fileId}/archive`, { expectedRevision: 2, reason: "別患者の検査" }, doctor);
  assert.equal(archived.body.file.archived, true);
  assert.equal((await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/files`, undefined, doctor)).body.files.length, 0);
});

test("rejects files whose content does not match the declared type", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const fake = Buffer.from("<html>not an image</html>");
  const started = await request(stores, "POST", "/v1/eye/files/uploads", {
    patientId: patient.patientId, kind: "fundus_photo", eye: "od", takenOn: "2026-10-27", contentType: "image/png", size: fake.length
  }, doctor);
  await request(stores, "PUT", `/${started.body.upload.url}`, undefined, { ...doctor, "content-type": "image/png" }, fake);
  const completed = await request(stores, "POST", `/v1/eye/files/${started.body.file.fileId}/complete`, {}, doctor);
  assert.equal(completed.statusCode, 400);
  assert.equal((await request(stores, "POST", "/v1/eye/files/uploads", { patientId: patient.patientId, takenOn: "2026-10-27", contentType: "text/html", size: 10 }, doctor)).statusCode, 400);
});

test("a doctor reviews the summary of a scanned paper chart", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const started = await request(stores, "POST", "/v1/eye/files/uploads", {
    patientId: patient.patientId, kind: "paper_chart", takenOn: "2019-04-01", title: "紙カルテ 2019", contentType: "image/jpeg", size: jpeg.length
  }, clerk);
  await request(stores, "PUT", `/${started.body.upload.url}`, undefined, { ...clerk, "content-type": "image/jpeg" }, jpeg);
  const fileId = started.body.file.fileId;
  await request(stores, "POST", `/v1/eye/files/${fileId}/complete`, {}, clerk);
  const summarized = await request(stores, "PATCH", `/v1/eye/files/${fileId}`, { expectedRevision: 2, summary: "2019年 両眼緑内障と診断。ラタノプロスト開始。" }, clerk);
  assert.equal(summarized.body.file.paper.reviewedBy, null);
  assert.equal((await request(stores, "POST", `/v1/eye/files/${fileId}/review`, { expectedRevision: 3 }, clerk)).statusCode, 403);
  const reviewed = await request(stores, "POST", `/v1/eye/files/${fileId}/review`, { expectedRevision: 3 }, doctor);
  assert.equal(reviewed.body.file.paper.reviewedBy.loginId, "eye-doctor");
  const edited = await request(stores, "PATCH", `/v1/eye/files/${fileId}`, { expectedRevision: 4, summary: "変更後の要約" }, clerk);
  assert.equal(edited.body.file.paper.reviewedBy, null, "changing the summary requires a new review");
});

test("builds the billing handoff from finalized charts and flags charts amended afterwards", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "revisit",
    content: {
      ...glaucomaContent({ iopOd: 15 }),
      orders: [
        { orderId: "o1", code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou", status: "performed" },
        { orderId: "o2", code: "oct_disc", name: "OCT（視神経乳頭）", kind: "exam", eye: "ou", status: "cancelled" }
      ],
      prescriptions: [
        { kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1, quantity: 3, unit: "本", usage: "就寝前" },
        { kind: "eye_drop", name: "チモロール", eye: "ou", timesPerDay: 2, issued: false }
      ],
      optical: { type: "glasses", issue: true, od: { sphere: -2 }, os: { sphere: -1.5 }, pd: 62 }
    }
  }, doctor);
  const id = draft.body.encounter.encounterId;
  await request(stores, "POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: 1, eye: "both" }, doctor);
  await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 2 }, doctor);
  await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, doctor);

  const day = await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk);
  assert.equal(day.statusCode, 200);
  assert.equal(day.body.drafts.length, 1, "unfinished charts are listed as warnings");
  const [billing] = day.body.encounters;
  assert.deepEqual(billing.items.map((item) => `${item.category}:${item.name}`), ["検査:静的視野検査", "処方:ラタノプロスト点眼液", "文書:眼鏡処方箋"]);
  assert.equal(billing.handoff.state, "pending");

  const handed = await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: [id] }, clerk);
  assert.equal(handed.statusCode, 201);
  assert.match(handed.body.csv, /^﻿診療日,患者番号/u);
  assert.match(handed.body.csv, /2026-10-27,000123,眼科 太郎,ガンカ タロウ,1950-04-01,男,再診,処方,,ラタノプロスト点眼液,両,3,本,,院外,1日1回 就寝前/u);
  assert.equal((await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk)).body.encounters[0].handoff.state, "handed_off");

  await request(stores, "POST", `/v1/eye/encounters/${id}/amend`, { expectedRevision: 3, reason: "検査の追記" }, doctor);
  const amending = await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk);
  assert.equal(amending.body.encounters.length, 0);
  const amendingDraft = amending.body.drafts.find((item) => item.encounterId === id);
  assert.equal(amendingDraft.amending, true, "a chart reopened after the handoff stays visible as amending");
  assert.equal(amendingDraft.amendmentReason, "検査の追記");
  assert.equal(amendingDraft.handoff.state, "handed_off");
  assert.equal(amendingDraft.handoff.version, 1);
  assert.equal(amendingDraft.patientSnapshot.primaryPatientNumber, "000123", "drafts carry the current patient number too");
  assert.equal(amending.body.drafts.find((item) => item.encounterId !== id).handoff.state, "pending");
  const current = (await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor)).body.encounter;
  const patched = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: current.revision,
    content: { ...current.content, orders: [...current.content.orders, { orderId: "o3", code: "iop", name: "眼圧検査", kind: "exam", eye: "ou", status: "performed" }] }
  }, doctor);
  assert.equal(patched.statusCode, 200);
  const refinalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: patched.body.encounter.revision }, doctor);
  assert.equal(refinalized.statusCode, 200, JSON.stringify(refinalized.body));
  const after = await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk);
  const changed = after.body.encounters[0];
  assert.equal(changed.handoff.state, "changed", "a re-finalized chart with different items needs another handoff");
  assert.deepEqual(changed.handoff.previousItems.map((item) => item.name), ["静的視野検査", "ラタノプロスト点眼液", "眼鏡処方箋"]);
  assert.equal(changed.handoff.version, 1);
  assert.equal(changed.version, 2);
  assert.equal(changed.amendmentReason, "検査の追記");
  assert.equal(changed.finalizedBy.displayName, "eye-doctor");
  assert.ok(changed.finalizedAt);
  assert.equal(after.body.handoffs[0].encounters[0].items, undefined, "the day listing leaves the item snapshot out");
  assert.equal(after.body.handoffs[0].hasSnapshot, true);

  const csv = await request(stores, "GET", "/v1/eye/billing/day.csv?date=2026-10-27", undefined, clerk);
  assert.equal(csv.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal((await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
  assert.equal((await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: ["eenc_missing"] }, clerk)).statusCode, 400);
});

test("a re-finalized chart with the same items stays handed off; old handoff records keep the old comparison", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const content = {
    ...glaucomaContent({ iopOd: 15 }),
    orders: [{ orderId: "o1", code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou", status: "performed" }],
    prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1, quantity: 3, unit: "本" }]
  };
  const first = await finalizedEncounter(stores, doctor, patient.patientId, "2026-10-27", content);
  const second = await finalizedEncounter(stores, doctor, patient.patientId, "2026-10-27", content);
  const day = (await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk)).body;
  const legacy = day.encounters.find((item) => item.encounterId === second.encounterId);
  // この機能より前の連携記録: 版を含む指紋だけで、品目の写しがない。
  const orgId = first.orgId;
  stores.eyeStore.createBillingHandoff(orgId, {
    handoffId: "ebh_legacy", orgId, date: "2026-10-27",
    encounters: [{ encounterId: legacy.encounterId, version: legacy.version, fingerprint: legacy.fingerprint }],
    csvSha256: "0".repeat(64), createdBy: { displayName: "受付" }, createdAt: "2026-10-27T01:00:00.000Z"
  });
  const handed = await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: [first.encounterId] }, clerk);
  assert.equal(handed.statusCode, 201);
  assertFirestoreSafe(handed.body.handoff);
  const stored = await stores.eyeStore.getBillingHandoff(orgId, handed.body.handoff.handoffId);
  assertFirestoreSafe(stored);
  assert.ok(stored.encounters[0].itemsFingerprint);
  assert.equal(stored.encounters[0].patient.primaryPatientNumber, "000123");

  const before = (await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk)).body;
  assert.equal(before.encounters.find((item) => item.encounterId === second.encounterId).handoff.state, "handed_off", "an old record still matches while nothing changed");

  for (const encounter of [first, second]) {
    const amended = await request(stores, "POST", `/v1/eye/encounters/${encounter.encounterId}/amend`, { expectedRevision: encounter.revision, reason: "所見の誤字" }, doctor);
    const finalized = await request(stores, "POST", `/v1/eye/encounters/${encounter.encounterId}/finalize`, { expectedRevision: amended.body.encounter.revision }, doctor);
    assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  }
  const after = (await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk)).body;
  const kept = after.encounters.find((item) => item.encounterId === first.encounterId);
  assert.equal(kept.version, 2);
  assert.equal(kept.handoff.state, "handed_off", "same items, new version: no re-handoff needed");
  assert.equal(kept.handoff.previousItems, undefined);
  const old = after.encounters.find((item) => item.encounterId === second.encounterId);
  assert.equal(old.handoff.state, "changed", "an old record keeps the version-based comparison");
  assert.equal(old.handoff.previousItems, null, "an old record has no item snapshot to diff against");
  assert.equal(after.handoffs.find((item) => item.handoffId === "ebh_legacy").hasSnapshot, false);
});

test("re-downloads the CSV of a past handoff from its snapshot", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const encounter = await finalizedEncounter(stores, doctor, patient.patientId, "2026-10-27", {
    ...glaucomaContent({ iopOd: 15 }),
    orders: [{ orderId: "o1", code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou", status: "performed" }],
    prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1, quantity: 3, unit: "本", usage: "=就寝前, \"必ず\"" }]
  });
  const handed = await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: [encounter.encounterId] }, clerk);
  const handoffId = handed.body.handoff.handoffId;
  const again = await request(stores, "GET", `/v1/eye/billing/handoffs/${handoffId}.csv`, undefined, clerk);
  assert.equal(again.statusCode, 200);
  assert.equal(again.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal(again.raw.toString("utf8"), handed.body.csv, "the re-downloaded CSV is byte-identical to the one handed off");
  assert.equal((await request(stores, "GET", `/v1/eye/billing/handoffs/${handoffId}.csv`, undefined, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
  assert.equal((await request(stores, "GET", "/v1/eye/billing/handoffs/ebh_missing.csv", undefined, clerk)).statusCode, 404);
  stores.eyeStore.createBillingHandoff(encounter.orgId, {
    handoffId: "ebh_legacy", orgId: encounter.orgId, date: "2026-10-27",
    encounters: [{ encounterId: encounter.encounterId, version: 1, fingerprint: "x" }],
    csvSha256: "0".repeat(64), createdBy: { displayName: "受付" }, createdAt: "2026-10-27T01:00:00.000Z"
  });
  assert.equal((await request(stores, "GET", "/v1/eye/billing/handoffs/ebh_legacy.csv", undefined, clerk)).statusCode, 409);
});

// Firestore は undefined の値と、配列の中の配列を保存できない。
function assertFirestoreSafe(value, path = "handoff", parentIsArray = false) {
  assert.notEqual(value, undefined, `${path} is undefined`);
  if (Array.isArray(value)) {
    assert.equal(parentIsArray, false, `${path} is an array inside an array`);
    value.forEach((item, index) => assertFirestoreSafe(item, `${path}[${index}]`, true));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertFirestoreSafe(item, `${path}.${key}`, false);
  }
}

test("exports a patient bundle and the clinic for migration", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", glaucomaContent({ iopOd: 15 }));

  const bundle = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/export`, undefined, doctor);
  assert.equal(bundle.body.format, "halunasu-eye-patient-v1");
  assert.equal(bundle.body.encounters.length, 1);
  assert.equal(bundle.body.encounterVersions.length, 1);
  assert.equal((await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/export`, undefined, clerk)).statusCode, 403);

  const clinic = await request(stores, "GET", "/v1/eye/export", undefined, director);
  assert.equal(clinic.body.format, "halunasu-eye-export-v1");
  assert.equal(clinic.body.patients.length, 1);
  assert.equal((await request(stores, "GET", "/v1/eye/export", undefined, doctor)).statusCode, 403);
});

test("dates follow Japan time, so early-morning documents are not dated the previous day", () => {
  assert.equal(japanDate(new Date("2026-10-31T23:28:00.000Z")), "2026-11-01");
  assert.equal(japanDate("2026-11-01T14:59:59.000Z"), "2026-11-01");
  assert.equal(japanDate("2026-11-01T15:00:00.000Z"), "2026-11-02");
});

test("searches patients by hiragana, katakana, given name, and birth date", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const hiraganaKana = await request(stores, "POST", "/v1/eye/patients", { displayName: "見本 花子", displayNameKana: "みほん はなこ", birthDate: "1953-01-09", sex: "female" }, doctor);
  const search = async (body) => (await request(stores, "POST", "/v1/eye/patients/search", body, doctor)).body.patients.map((item) => item.patientId);

  assert.deepEqual(await search({ q: "がんか" }), [patient.patientId], "hiragana finds a katakana name");
  assert.deepEqual(await search({ q: "ミホン" }), [hiraganaKana.body.patient.patientId], "katakana finds a name registered in hiragana");
  assert.deepEqual(await search({ q: "タロウ" }), [patient.patientId], "given name only");
  assert.deepEqual(await search({ q: "", birthDate: "1950-04-01" }), [patient.patientId]);
  assert.deepEqual(await search({ q: "", birthDate: "1950-04-02" }), []);
  assert.equal((await request(stores, "POST", "/v1/eye/patients/search", { birthDate: "S25.4.1" }, doctor)).statusCode, 400);
});

test("lists unfinished work across patients for clinical staff only", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);

  // 前日の下書き、確定済み（出ない）、文書の下書き、要約未確認の紙カルテ
  const older = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-20", visitType: "initial" }, doctor);
  await finalizedEncounter(stores, doctor, patient.patientId, "2026-10-13", glaucomaContent({ iopOd: 15 }));
  const document = await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, doctor);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const started = await request(stores, "POST", "/v1/eye/files/uploads", {
    patientId: patient.patientId, kind: "paper_chart", takenOn: "2019-04-01", title: "紙カルテ 2019", contentType: "image/jpeg", size: jpeg.length
  }, clerk);
  await request(stores, "PUT", `/${started.body.upload.url}`, undefined, { ...clerk, "content-type": "image/jpeg" }, jpeg);
  await request(stores, "POST", `/v1/eye/files/${started.body.file.fileId}/complete`, {}, clerk);
  // 取り込み途中（pending）のファイルは出さない
  await request(stores, "POST", "/v1/eye/files/uploads", {
    patientId: patient.patientId, kind: "paper_chart", takenOn: "2018-04-01", title: "途中", contentType: "image/jpeg", size: jpeg.length
  }, clerk);

  assert.equal((await request(stores, "GET", "/v1/eye/worklist", undefined, clerk)).statusCode, 403);
  const response = await request(stores, "GET", "/v1/eye/worklist", undefined, orthoptist);
  assert.equal(response.statusCode, 200);
  const worklist = response.body;
  assert.deepEqual(worklist.counts, { draftEncounters: 1, unreviewedPaperCharts: 1, draftDocuments: 1 });
  assert.equal(worklist.truncated, false);
  assert.deepEqual(worklist.draftEncounters[0], {
    encounterId: older.body.encounter.encounterId,
    patientId: patient.patientId,
    patientName: "眼科 太郎",
    patientNameKana: "ガンカ タロウ",
    encounterDate: "2026-10-20",
    amending: false,
    updatedAt: older.body.encounter.updatedAt,
    updatedBy: older.body.encounter.updatedBy.displayName
  });
  assert.equal(worklist.unreviewedPaperCharts[0].fileId, started.body.file.fileId);
  assert.equal(worklist.unreviewedPaperCharts[0].patientName, "眼科 太郎");
  assert.equal(worklist.unreviewedPaperCharts[0].hasSummary, false);
  assert.equal(worklist.draftDocuments[0].documentId, document.body.document.documentId);
  // 本文・要約・題名は返さない
  const serialized = JSON.stringify(worklist);
  for (const leaked of ["紙カルテ 2019", "body", "summary", "content", "chiefComplaint"]) assert.equal(serialized.includes(leaked), false, `${leaked} is not exposed`);

  // 要約を確認すると一覧から消える。修正中のカルテは「修正中」として出る
  const fileId = started.body.file.fileId;
  await request(stores, "PATCH", `/v1/eye/files/${fileId}`, { expectedRevision: 2, summary: "要約" }, clerk);
  await request(stores, "POST", `/v1/eye/files/${fileId}/review`, { expectedRevision: 3 }, doctor);
  const finalized = (await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/chart`, undefined, doctor)).body.latestFinalized;
  await request(stores, "POST", `/v1/eye/encounters/${finalized.encounterId}/amend`, { expectedRevision: finalized.revision, reason: "記載漏れ" }, doctor);
  const after = (await request(stores, "GET", "/v1/eye/worklist", undefined, doctor)).body;
  assert.equal(after.counts.unreviewedPaperCharts, 0);
  assert.equal(after.counts.draftEncounters, 2);
  assert.equal(after.draftEncounters.find((item) => item.encounterId === finalized.encounterId).amending, true);
});

test("stores optical prescription details and keeps old optical data without them", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const legacy = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId, encounterDate: "2026-10-27", content: { optical: { type: "glasses", od: { sphere: -2 }, os: { sphere: -1.5 }, pd: 62 } }
  }, doctor);
  assert.equal(legacy.statusCode, 201);
  assert.equal("material" in legacy.body.encounter.content.optical, false);
  assert.equal("wearMode" in legacy.body.encounter.content.optical, false);

  const encounterId = legacy.body.encounter.encounterId;
  const optical = {
    type: "glasses", issue: true, od: { sphere: -2 }, os: { sphere: -1.5 }, pd: 62,
    material: "organic", coating: "UVカット", tint: "ブラウン", wearMode: "always"
  };
  const saved = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: 1, sections: { optical } }, doctor);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.encounter.content.optical.material, "organic");
  assert.equal(saved.body.encounter.content.optical.coating, "UVカット");
  assert.equal(saved.body.encounter.content.optical.tint, "ブラウン");
  assert.equal(saved.body.encounter.content.optical.wearMode, "always");

  const contact = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, {
    expectedRevision: 2, sections: { optical: { type: "contact", od: { sphere: -2, bc: 8.6, dia: 14.2 }, os: { sphere: -2, bc: 8.6, dia: 14.2 }, wearSchedule: "daily_wear", replacement: "one_month" } }
  }, doctor);
  assert.equal(contact.body.encounter.content.optical.wearSchedule, "daily_wear");
  assert.equal(contact.body.encounter.content.optical.replacement, "one_month");

  const invalid = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: 3, sections: { optical: { replacement: "weekly" } } }, doctor);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.field, "content.optical.replacement");
});

test("saves the recipient honorific and keeps it when a document is duplicated", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const document = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, doctor)).body.document;
  assert.equal("honorific" in document.recipient, false);

  const invalid = await request(stores, "PATCH", `/v1/eye/documents/${document.documentId}`, { expectedRevision: 1, recipient: { institution: "県立病院", honorific: "様" }, body: "本文" }, doctor);
  assert.equal(invalid.statusCode, 400);
  const edited = await request(stores, "PATCH", `/v1/eye/documents/${document.documentId}`, { expectedRevision: 1, recipient: { institution: "県立病院", department: "眼科", honorific: "御中" }, body: "本文" }, doctor);
  assert.equal(edited.body.document.recipient.honorific, "御中");
  const finalized = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/finalize`, { expectedRevision: 2 }, doctor);
  assert.equal(finalized.statusCode, 200);
  const copy = await request(stores, "POST", `/v1/eye/documents/${document.documentId}/duplicate`, {}, doctor);
  assert.equal(copy.body.document.recipient.honorific, "御中");
});

test("manages print names for eye staff and uses them on paper", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orgId = (await request(stores, "GET", "/v1/eye/context", undefined, director)).body.context.orgId;
  const doctorMember = stores.platformStore.listMembers(orgId).find((member) => member.loginId === "eye-doctor");
  stores.platformStore.updateMember(orgId, doctorMember.memberId, { displayName: "眼科医（医師）" });

  // 印刷用の氏名が未設定なら、表示名から役割の括弧を除いた名前を使う
  const fallback = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(fallback.body.printNames[doctorMember.memberId], "眼科医");

  assert.equal((await request(stores, "GET", "/v1/eye/staff-profiles", undefined, doctor)).statusCode, 403);
  const list = await request(stores, "GET", "/v1/eye/staff-profiles", undefined, director);
  assert.equal(list.statusCode, 200);
  const doctorRow = list.body.staff.find((item) => item.memberId === doctorMember.memberId);
  assert.equal(doctorRow.loginId, "eye-doctor");
  assert.equal(doctorRow.displayName, "眼科医（医師）");
  assert.deepEqual(doctorRow.eyeRoles, ["doctor"]);
  assert.equal(doctorRow.printName, "");
  assert.ok(list.body.staff.every((item) => item.eyeRoles.length > 0));

  const path = `/v1/eye/staff-profiles/${doctorMember.memberId}`;
  assert.equal((await request(stores, "PUT", path, { printName: "山田 太郎" }, doctor)).statusCode, 403);
  assert.equal((await request(stores, "PUT", path, { printName: "x".repeat(41) }, director)).statusCode, 400);
  assert.equal((await request(stores, "PUT", "/v1/eye/staff-profiles/mem_unknown", { printName: "山田" }, director)).statusCode, 404);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = director;
  assert.equal((await request(stores, "PUT", path, { printName: "山田" }, withoutCsrf)).statusCode, 403);
  const saved = await request(stores, "PUT", path, { printName: " 山田 太郎 " }, director);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.staffProfile.printName, "山田 太郎");

  const bootstrap = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(bootstrap.body.printNames[doctorMember.memberId], "山田 太郎");
  const patient = await createPatient(stores, doctor);
  const document = (await request(stores, "POST", "/v1/eye/documents", { patientId: patient.patientId, type: "referral" }, doctor)).body.document;
  assert.equal(document.sender.doctorName, "山田 太郎");
  assert.equal(document.sender.memberId, doctorMember.memberId);

  await request(stores, "PUT", path, { printName: "" }, director);
  const reset = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(reset.body.printNames[doctorMember.memberId], "眼科医");

  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=settings", undefined, director);
  assert.ok(logs.body.auditLogs.some((log) => log.eventType === "eye.staff_profile_saved" && log.targetId === doctorMember.memberId));
});

test("saves the added exam, findings, counselling and adherence fields by section and keeps old charts unchanged", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId, encounterDate: "2026-10-27", visitType: "initial", content: glaucomaContent({ iopOd: 15 })
  }, doctor);
  assert.equal(draft.statusCode, 201);
  const legacy = draft.body.encounter.content;
  assert.deepEqual(Object.keys(legacy.exam), ["od", "os"]);
  assert.deepEqual(Object.keys(legacy.findings.od), ["anterior", "lens", "fundus"]);
  assert.equal("counselling" in legacy, false);
  assert.equal("adherence" in legacy, false);
  const id = draft.body.encounter.encounterId;

  // 検査員: 両眼を確認したあと、両眼の値（RAPD・眼位）だけを足しても眼ごとの確認は外れない
  const confirmed = await request(stores, "POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: 1, eye: "both" }, orthoptist);
  assert.equal(confirmed.statusCode, 200);
  const binocular = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: 2,
    sections: { exam: { ...legacy.exam, binocular: { rapd: "none", alignment: "exo", alignmentNote: "10Δ", motility: "normal" } } }
  }, orthoptist);
  assert.equal(binocular.statusCode, 200);
  assert.deepEqual(binocular.body.encounter.content.exam.binocular, { rapd: "none", alignment: "exo", alignmentNote: "10Δ", motility: "normal" });
  assert.ok(binocular.body.encounter.examConfirmations.od && binocular.body.encounter.examConfirmations.os);

  // 眼ごとの値（瞳孔）を変えると、その眼の確認だけが外れる（既存の検査値と同じ扱い）
  const pupil = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: 3,
    sections: {
      exam: {
        ...binocular.body.encounter.content.exam,
        od: { ...legacy.exam.od, vaNear: "0.7", pupil: { sizeMm: 3, reaction: "brisk" }, keratometry: { k1: 43.25, k2: 44, axis: 175 } }
      }
    }
  }, orthoptist);
  assert.equal(pupil.statusCode, 200);
  assert.deepEqual(pupil.body.encounter.content.exam.od.pupil, { sizeMm: 3, reaction: "brisk" });
  assert.equal(pupil.body.encounter.content.exam.od.vaNear, "0.7");
  assert.deepEqual(pupil.body.encounter.content.exam.od.keratometry, { k1: 43.25, k2: 44, axis: 175 });
  assert.equal(pupil.body.encounter.examConfirmations.od, null);
  assert.ok(pupil.body.encounter.examConfirmations.os);

  // 医師: 所見・説明・アドヒアランス（同じ revision を見ていても別の項目なので通る）
  const doctorSave = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: 3,
    sections: {
      findings: { od: { fundus: "C/D 拡大", other: "眼瞼正常", cdRatio: 0.7, angle: "3", angleNote: "開放" }, os: { cdRatio: 0.5 }, general: "全身状態良好" },
      counselling: { topics: ["eye_drop", "dilation"], recipient: "patient", consent: "not_required", note: "散瞳後は運転しない" },
      adherence: { status: "sometimes", note: "夜を忘れる" }
    }
  }, doctor);
  assert.equal(doctorSave.statusCode, 200);
  const saved = doctorSave.body.encounter.content;
  assert.equal(saved.findings.od.other, "眼瞼正常");
  assert.equal(saved.findings.od.cdRatio, 0.7);
  assert.equal(saved.findings.general, "全身状態良好");
  assert.deepEqual(saved.counselling.topics, ["eye_drop", "dilation"]);
  assert.equal(saved.adherence.status, "sometimes");
  assert.equal(saved.exam.od.pupil.reaction, "brisk", "the orthoptist's exam values are kept");

  // 新しい項目も項目ごとの版で衝突を判定する
  const stale = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 3, sections: { counselling: { consent: "obtained" } } }, orthoptist);
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.body.details.sections, ["counselling"]);
  const invalid = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 5, sections: { adherence: { status: "always" } } }, doctor);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.field, "content.adherence.status");

  // 確定（新しい項目で止まらない）と版の内容
  await request(stores, "POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: 5, eye: "od" }, doctor);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 6 }, doctor);
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  const version = await request(stores, "GET", `/v1/eye/encounters/${id}/versions/1`, undefined, doctor);
  assert.equal(version.body.version.content.counselling.note, "散瞳後は運転しない");
  assert.equal(version.body.version.content.exam.binocular.alignment, "exo");
  assertFirestoreCompatible(finalized.body.encounter);
  assertFirestoreCompatible(version.body.version);

  // 再診の前回コピー: 所見の自由記載は写し、測定値・説明・アドヒアランスは写さない
  const revisit = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-24" }, doctor);
  const copied = revisit.body.encounter.content;
  assert.equal(copied.findings.od.other, "眼瞼正常");
  assert.equal(copied.findings.general, "全身状態良好");
  assert.equal("cdRatio" in copied.findings.od, false);
  assert.equal("angle" in copied.findings.od, false);
  assert.equal("pupil" in copied.exam.od, false);
  assert.equal("binocular" in copied.exam, false);
  assert.equal("counselling" in copied, false);
  assert.equal("adherence" in copied, false);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${revisit.body.encounter.encounterId}`, undefined, doctor);
  assert.equal(detail.body.previous.content.findings.od.cdRatio, 0.7, "the previous C/D is available as a hint");
});

test("accepts phrases for the added free-text fields", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  for (const target of ["findings.other", "findings.general", "counselling.note"]) {
    const response = await request(stores, "POST", "/v1/eye/phrases", { target, label: target, text: "定型文" }, director);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(response.body.phrase.target, target);
  }
});

test("adds and edits timed exam records, keeps exam as the derived latest view, and maps chart edits into the current record", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  // 記録の導入前の形で入力された検査値（古いカルテと同じ）
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: glaucomaContent({ iopOd: 18 })
  }, doctor);
  const id = draft.body.encounter.encounterId;
  assert.equal("examRecords" in draft.body.encounter.content, false, "charts without records keep the old shape");
  const confirmed = await request(stores, "POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: 1, eye: "both" }, doctor);
  assert.equal(confirmed.statusCode, 200);

  const path = `/v1/eye/encounters/${id}/exam-records`;
  const afternoon = {
    expectedRevision: 2,
    at: "2026-10-27T05:00:00.000Z",
    values: { iop: { od: { readings: [20, 21, 22], method: "goldmann", at: "14:00" } }, vision: { near: { od: { uncorrected: "0.5", corrected: "0.9" } } } }
  };
  assert.equal((await request(stores, "POST", path, afternoon, clerk)).statusCode, 403);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = orthoptist;
  assert.equal((await request(stores, "POST", path, afternoon, withoutCsrf)).statusCode, 403);
  assert.equal((await request(stores, "POST", path, { ...afternoon, values: { iop: { od: { readings: [1, 2, 3, 4] } } } }, orthoptist)).statusCode, 400);

  const added = await request(stores, "POST", path, afternoon, orthoptist);
  assert.equal(added.statusCode, 201, JSON.stringify(added.body));
  const records = added.body.encounter.content.examRecords;
  assert.equal(records.length, 2, "the old exam becomes the first record so nothing is lost");
  assert.equal(records[0].source, "chart");
  assert.equal(records[0].values.vision.far.od.corrected, "1.0");
  assert.equal(added.body.record.examinerName, "eye-ort");
  assert.equal(added.body.record.values.iop.od.average, 21);
  const exam = added.body.encounter.content.exam;
  assert.equal(exam.od.iop, 21);
  assert.equal(exam.od.iopMethod, "goldmann");
  assert.equal(exam.od.vaCorrected, "1.0", "earlier values stay in the latest view");
  assert.equal(exam.od.vaNear, "0.5");
  assert.equal(exam.os.iop, 16);
  assert.equal(added.body.encounter.examConfirmations.od, null, "the changed eye needs confirming again");
  assert.notEqual(added.body.encounter.examConfirmations.os, null, "the unchanged eye keeps its confirmation");

  // 古い revision からの追加・変更は止める
  const stale = await request(stores, "POST", path, { ...afternoon, expectedRevision: 2 }, orthoptist);
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.body.details.sections, ["exam", "examRecords"]);

  // 記録の変更: values を送ると置き換え、exam を作り直す
  const recordId = added.body.record.recordId;
  const revision = added.body.encounter.revision;
  const patched = await request(stores, "PATCH", `${path}/${recordId}`, {
    expectedRevision: revision,
    note: "散瞳後",
    values: { iop: { od: { readings: [19, 20], method: "goldmann", at: "14:05" } } }
  }, orthoptist);
  assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.record.note, "散瞳後");
  assert.equal(patched.body.record.updatedBy.loginId, "eye-ort");
  assert.equal(patched.body.encounter.content.exam.od.iop, 19.5);
  assert.equal(patched.body.encounter.content.exam.od.vaNear, undefined, "near values that were replaced are gone from the latest view");
  assert.equal((await request(stores, "PATCH", `${path}/exr_missing`, { expectedRevision: patched.body.encounter.revision, note: "x" }, orthoptist)).statusCode, 404);

  // 今の画面（exam を直接編集）からの保存は、いまの記録（最後の記録）に入る
  const chartExam = patched.body.encounter.content.exam;
  const chartSave = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: patched.body.encounter.revision,
    sections: { exam: { ...chartExam, od: { ...chartExam.od, vaCorrected: "0.9" } } }
  }, doctor);
  assert.equal(chartSave.statusCode, 200);
  const saved = chartSave.body.encounter;
  assert.equal(saved.content.exam.od.vaCorrected, "0.9");
  assert.equal(saved.content.examRecords.length, 2);
  assert.equal(saved.content.examRecords[0].values.vision.far.od.corrected, "1.0", "the earlier record keeps its value");
  assert.equal(saved.content.examRecords[1].values.vision.far.od.corrected, "0.9");
  assert.deepEqual(saved.content.examRecords[1].values.iop.od.readings, [{ value: 19 }, { value: 20 }], "untouched readings stay");
  assert.equal(saved.sectionRevisions.examRecords, saved.revision);
  // Firestore は undefined を保存できない
  for (const encounter of [added.body.encounter, patched.body.encounter, saved]) {
    assert.deepEqual(JSON.parse(JSON.stringify(encounter)), encounter);
  }

  // 確定: 版には記録も入り、内容は検証を通しても変わらない
  await request(stores, "POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: saved.revision, eye: "both" }, doctor);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: saved.revision + 1 }, doctor);
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  const version = await request(stores, "GET", `/v1/eye/encounters/${id}/versions/1`, undefined, doctor);
  assert.deepEqual(version.body.version.content.examRecords, saved.content.examRecords);
  assert.equal((await request(stores, "POST", path, { ...afternoon, expectedRevision: finalized.body.encounter.revision }, orthoptist)).statusCode, 409, "finalized charts need amending first");

  const chart = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/chart`, undefined, doctor);
  const point = chart.body.trend.points.at(-1);
  assert.equal(point.od.iop, 19.5);
  assert.equal(point.od.iopAverage, 19.5);
  assert.deepEqual(point.od.iopReadings, [19, 20]);

  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=change", undefined, await signedHeaders(stores.platformStore, "director"));
  const types = logs.body.auditLogs.map((log) => log.eventType);
  assert.ok(types.includes("eye.exam_record_created"));
  assert.ok(types.includes("eye.exam_record_updated"));
});

test("turns the previous next-visit plan (items x eye) into planned orders on the next encounter", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const first = await finalizedEncounter(stores, doctor, patient.patientId, "2026-07-28", {
    ...glaucomaContent({ iopOd: 15 }),
    nextVisit: {
      intervalWeeks: 12,
      note: "視野",
      planItems: [
        { code: "va", name: "視力検査", eye: "ou" },
        { code: "vf_static", name: "静的視野検査", eye: "os", comment: "30-2" },
        { name: "結果説明", eye: "none" }
      ]
    }
  });
  assert.equal(first.content.nextVisit.planItems.length, 3);

  // 前回コピーの再診: 予定がオーダー（予定）として出る。次回予定そのものは写さない。
  const revisit = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-20" }, doctor);
  assert.equal(revisit.statusCode, 201);
  const orders = revisit.body.encounter.content.orders;
  assert.deepEqual(orders.map((order) => [order.code, order.name, order.eye, order.status]), [
    ["va", "視力検査", "ou", "planned"],
    ["vf_static", "静的視野検査", "os", "planned"],
    ["", "結果説明", "", "planned"]
  ]);
  assert.equal(orders[1].note, "30-2");
  assert.ok(orders.every((order) => order.sourceEncounterId === first.encounterId));
  assert.equal(revisit.body.encounter.content.nextVisit.planItems, undefined);

  // すでに同じ項目・同じ眼のオーダーがあれば重ねない
  const withOrders = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-21",
    content: { orders: [{ orderId: "o1", code: "va", name: "視力検査", eye: "ou" }] }
  }, doctor);
  assert.deepEqual(withOrders.body.encounter.content.orders.map((order) => order.code), ["va", "vf_static", ""]);
  assert.equal(withOrders.body.encounter.content.orders[0].orderId, "o1");
});

// ---- 段階 1A: 受付の 11 状態・担当医・受付メモ・予約状況・診察終了・1 人ずつの会計連携 ----

async function contextOf(stores, headers) {
  return (await request(stores, "GET", "/v1/eye/context", undefined, headers)).body.context;
}

async function book(stores, headers, body) {
  const response = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", ...body }, headers);
  assert.equal(response.statusCode, 201, JSON.stringify(response.body));
  return response.body.appointment;
}

async function moveTo(stores, headers, appointment, status) {
  const response = await request(stores, "POST", `/v1/eye/appointments/${appointment.appointmentId}/status`, { expectedRevision: appointment.revision, status }, headers);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  return response.body.appointment;
}

// 確定できる（止まる条件のない）カルテの中身
function closableContent() {
  return { chiefComplaint: "定期", plan: "経過観察", diagnoses: [{ name: "結膜炎", eye: "od" }] };
}

function withoutCsrf(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "x-csrf-token"));
}

test("moves between all DigiKar statuses freely, keeps the first queue number, and reads the old no-show as absent", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, clerk);
  let appointment = await book(stores, clerk, { time: "10:00", patientId: patient.patientId });

  // 予約済から診察待へ直接移すと受付になる（受付番号と受付時刻が付く）
  appointment = await moveTo(stores, clerk, appointment, "waiting_doctor");
  assert.equal(appointment.queueNumber, 1);
  assert.equal(appointment.checkedInAt, NOW.toISOString());
  for (const status of ["in_treatment", "in_exam", "absent", "booked", "in_consult", "checkout", "done", "checked_in"]) {
    appointment = await moveTo(stores, clerk, appointment, status);
    assert.equal(appointment.status, status);
  }
  assert.equal(appointment.queueNumber, 1, "the queue number is assigned once");
  assert.deepEqual(appointment.statusHistory.map((item) => item.status).slice(-3), ["checkout", "done", "checked_in"]);

  // 同じ状態への変更は保存しない
  const same = await request(stores, "POST", `/v1/eye/appointments/${appointment.appointmentId}/status`, { expectedRevision: appointment.revision, status: "checked_in" }, clerk);
  assert.equal(same.statusCode, 200);
  assert.equal(same.body.appointment.revision, appointment.revision);

  // 名前の検証。再計待は派生なので選べない
  for (const status of ["rebill_waiting", "unknown", ""]) {
    const invalid = await request(stores, "POST", `/v1/eye/appointments/${appointment.appointmentId}/status`, { expectedRevision: appointment.revision, status }, clerk);
    assert.equal(invalid.statusCode, 400, status);
  }

  // 古い no_show は入力でも受け付け、不在（absent）として保存する
  const legacy = await request(stores, "POST", `/v1/eye/appointments/${appointment.appointmentId}/status`, { expectedRevision: appointment.revision, status: "no_show" }, clerk);
  assert.equal(legacy.body.appointment.status, "absent");

  // 保存済みの no_show はそのまま読め、一覧では不在として出る
  const old = await book(stores, clerk, { time: "11:00", patientName: "旧 データ" });
  const { orgId } = await contextOf(stores, clerk);
  const records = stores.eyeStore.appointments.get(orgId);
  records.set(old.appointmentId, { ...records.get(old.appointmentId), status: "no_show" });
  const list = await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk);
  const shown = list.body.appointments.find((item) => item.appointmentId === old.appointmentId);
  assert.equal(shown.status, "no_show");
  assert.equal(shown.displayStatus, "absent");
  const revived = await request(stores, "POST", `/v1/eye/appointments/${old.appointmentId}/status`, { expectedRevision: old.revision, status: "booked" }, clerk);
  assert.equal(revived.statusCode, 200);

  // 受付は受付の役割、変更には CSRF が要る
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  assert.equal((await request(stores, "POST", `/v1/eye/appointments/${old.appointmentId}/status`, { expectedRevision: 2, status: "checked_in" }, viewer)).statusCode, 403);
  assert.equal((await request(stores, "POST", `/v1/eye/appointments/${old.appointmentId}/status`, { expectedRevision: 2, status: "checked_in" }, withoutCsrf(clerk))).statusCode, 403);
});

test("refuses to cancel a reception whose patient already has a chart that day", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const other = await createPatient(stores, doctor, { displayName: "別 患者", primaryPatientNumber: "000999" });
  const withChart = await book(stores, clerk, { patientId: patient.patientId, walkIn: true });
  const withoutChart = await book(stores, clerk, { patientId: other.patientId, walkIn: true });
  await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27" }, doctor);

  const refused = await request(stores, "POST", `/v1/eye/appointments/${withChart.appointmentId}/status`, { expectedRevision: withChart.revision, status: "cancelled" }, clerk);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body.message, /カルテ/u);
  const cancelled = await moveTo(stores, clerk, withoutChart, "cancelled");
  assert.equal(cancelled.status, "cancelled");
  // 取消から戻すことはできる
  assert.equal((await moveTo(stores, clerk, cancelled, "booked")).status, "booked");
});

test("stores the doctor, department and reception memo on appointments and keeps the old note readable", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const doctorContext = await contextOf(stores, await signedHeaders(stores.platformStore, "doctor"));
  const clerkContext = await contextOf(stores, clerk);
  const patient = await createPatient(stores, clerk);

  const booked = await book(stores, clerk, { time: "09:00", patientId: patient.patientId, doctorMemberId: doctorContext.memberId, department: "眼科", receptionMemo: "保険証確認\n駐車券" });
  assert.equal(booked.doctorMemberId, doctorContext.memberId);
  assert.equal(booked.department, "眼科");
  assert.equal(booked.receptionMemo, "保険証確認\n駐車券");
  assert.equal(booked.note, "保険証確認\n駐車券", "the reception memo is stored in the existing note field");

  const legacy = await book(stores, clerk, { time: "09:30", patientName: "古い 形", note: "メモ" });
  assert.equal(legacy.receptionMemo, "メモ");
  assert.equal(legacy.doctorMemberId, "");
  assert.equal(legacy.department, "");

  for (const doctorMemberId of [clerkContext.memberId, "emem_missing"]) {
    const invalid = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", patientName: "x", doctorMemberId }, clerk);
    assert.equal(invalid.statusCode, 400, doctorMemberId);
    assert.equal(invalid.body.field, "doctorMemberId");
  }
  const tooLong = await request(stores, "POST", "/v1/eye/appointments", { date: "2026-10-27", patientName: "x", department: "あ".repeat(41) }, clerk);
  assert.equal(tooLong.statusCode, 400);

  const patched = await request(stores, "PATCH", `/v1/eye/appointments/${legacy.appointmentId}`, { expectedRevision: 1, receptionMemo: "新しいメモ", doctorMemberId: doctorContext.memberId }, clerk);
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.appointment.note, "新しいメモ");
  assert.equal(patched.body.appointment.receptionMemo, "新しいメモ");
  const untouched = await request(stores, "PATCH", `/v1/eye/appointments/${legacy.appointmentId}`, { expectedRevision: 2, time: "10:00" }, clerk);
  assert.equal(untouched.body.appointment.receptionMemo, "新しいメモ", "a patch without the memo keeps it");
  assert.equal(untouched.body.appointment.doctorMemberId, doctorContext.memberId);

  const list = await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk);
  assert.equal(list.body.appointments.find((item) => item.appointmentId === booked.appointmentId).receptionMemo, "保険証確認\n駐車券");
});

test("keeps a patient memo on the profile, saved from reception without touching the rest", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const initial = await request(stores, "GET", `/v1/eye/patients/${patient.patientId}/profile`, undefined, clerk);
  assert.equal(initial.body.profile.patientMemo, "");

  const saved = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 0, allergies: [{ substance: "ペニシリン" }], patientMemo: "耳が遠い"
  }, doctor);
  assert.equal(saved.body.profile.patientMemo, "耳が遠い");
  // 患者メモを送らない古い画面の保存では消えない
  const older = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, { expectedRevision: 1, allergies: [{ substance: "ペニシリン" }], contactLensUser: true }, doctor);
  assert.equal(older.body.profile.patientMemo, "耳が遠い");

  const memo = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/memo`, { expectedRevision: 2, patientMemo: "車いす" }, clerk);
  assert.equal(memo.statusCode, 200, JSON.stringify(memo.body));
  assert.equal(memo.body.profile.patientMemo, "車いす");
  assert.equal(memo.body.profile.allergies[0].substance, "ペニシリン");
  assert.equal(memo.body.profile.contactLensUser, true);
  assert.equal((await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/memo`, { expectedRevision: 2, patientMemo: "x" }, clerk)).statusCode, 409);
  assert.equal((await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/memo`, { expectedRevision: 3, patientMemo: "x" }, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
});

test("lists appointments in a date range with per-day and per-hour counts for the booking grid", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const doctorContext = await contextOf(stores, await signedHeaders(stores.platformStore, "doctor"));
  await book(stores, clerk, { date: "2026-11-02", time: "09:00", patientName: "A", doctorMemberId: doctorContext.memberId });
  await book(stores, clerk, { date: "2026-11-02", time: "09:45", patientName: "B" });
  await book(stores, clerk, { date: "2026-11-02", patientName: "C" });
  const cancelled = await book(stores, clerk, { date: "2026-11-03", time: "13:00", patientName: "D" });
  await moveTo(stores, clerk, cancelled, "cancelled");
  await book(stores, clerk, { date: "2026-11-08", time: "13:10", patientName: "E" });
  await book(stores, clerk, { date: "2026-11-09", time: "13:10", patientName: "outside" });

  const week = await request(stores, "GET", "/v1/eye/appointments/range?from=2026-11-02&to=2026-11-08", undefined, clerk);
  assert.equal(week.statusCode, 200, JSON.stringify(week.body));
  assert.equal(week.body.days.length, 7);
  assert.deepEqual(week.body.appointments.map((item) => item.patientName), ["A", "B", "C", "D", "E"]);
  const monday = week.body.days[0];
  assert.deepEqual({ total: monday.total, untimed: monday.untimed, slots: monday.slots, halfSlots: monday.halfSlots }, {
    total: 3, untimed: 1, slots: { "09": 2 }, halfSlots: { "09:00": 1, "09:30": 1 }
  });
  assert.equal(week.body.days[1].total, 0, "cancelled appointments are not counted");
  assert.deepEqual(week.body.days[6].slots, { 13: 1 });

  const byDoctor = await request(stores, "GET", `/v1/eye/appointments/range?from=2026-11-02&to=2026-11-08&doctorMemberId=${doctorContext.memberId}`, undefined, clerk);
  assert.deepEqual(byDoctor.body.appointments.map((item) => item.patientName), ["A"]);
  assert.equal(byDoctor.body.days[0].total, 1);

  assert.equal((await request(stores, "GET", "/v1/eye/appointments/range?from=2026-11-02&to=2026-12-14", undefined, clerk)).statusCode, 400, "at most 42 days");
  assert.equal((await request(stores, "GET", "/v1/eye/appointments/range?from=2026-11-02&to=2026-12-13", undefined, clerk)).statusCode, 200);
  assert.equal((await request(stores, "GET", "/v1/eye/appointments/range?from=2026-11-08&to=2026-11-02", undefined, clerk)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/appointments/range?from=2026-11-02", undefined, clerk)).statusCode, 400);
});

test("closes a visit: finalizes, moves the reception to checkout, and returns the next waiting patient", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const second = await createPatient(stores, doctor, { displayName: "二番 次郎", primaryPatientNumber: "000200" });
  const third = await createPatient(stores, doctor, { displayName: "三番 三郎", primaryPatientNumber: "000300" });
  let mine = await book(stores, clerk, { patientId: patient.patientId, walkIn: true });
  mine = await moveTo(stores, clerk, mine, "in_consult");
  // 三番が先に診察待になり、二番があとから。次は三番。
  let later = await book(stores, clerk, { patientId: second.patientId, walkIn: true });
  let earlier = await book(stores, clerk, { patientId: third.patientId, walkIn: true });
  earlier = await moveTo(stores, clerk, earlier, "waiting_doctor");
  const { orgId } = await contextOf(stores, clerk);
  const records = stores.eyeStore.appointments.get(orgId);
  records.set(earlier.appointmentId, { ...records.get(earlier.appointmentId), statusHistory: [{ status: "waiting_doctor", at: "2026-10-27T00:10:00.000Z" }] });
  later = await moveTo(stores, clerk, later, "waiting_doctor");
  const thirdChart = await request(stores, "POST", "/v1/eye/encounters", { patientId: third.patientId, encounterDate: "2026-10-27" }, doctor);

  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", visitType: "initial", content: closableContent() }, doctor);
  const id = draft.body.encounter.encounterId;

  // 医師だけが使える。CSRF も要る
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1 }, await signedHeaders(stores.platformStore, "orthoptist"))).statusCode, 403);
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1 }, withoutCsrf(doctor))).statusCode, 403);
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1, nextStatus: "cancelled" }, doctor)).statusCode, 400);
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1, appointmentId: later.appointmentId }, doctor)).statusCode, 400);
  assert.equal((await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor)).body.encounter.status, "draft", "a wrong appointment is rejected before finalizing");

  const closed = await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1 }, doctor);
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.encounter.status, "finalized");
  assert.equal(closed.body.version.version, 1);
  assert.equal(closed.body.alreadyFinalized, false);
  assert.deepEqual(closed.body.warnings, []);
  assert.equal(closed.body.appointment.appointmentId, mine.appointmentId);
  assert.equal(closed.body.appointment.status, "checkout");
  assert.equal(closed.body.appointmentMoved, true);
  assert.equal(closed.body.appointmentError, null);
  assert.deepEqual(closed.body.nextPatient, {
    appointmentId: earlier.appointmentId,
    patientId: third.patientId,
    patientName: "三番 三郎",
    queueNumber: earlier.queueNumber,
    waitingSince: "2026-10-27T00:10:00.000Z",
    encounterId: thirdChart.body.encounter.encounterId
  });

  // すでに確定したカルテでも、受付を別の状態へ動かせる（版は作らない）
  const again = await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: closed.body.encounter.revision, nextStatus: "in_exam" }, doctor);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.alreadyFinalized, true);
  assert.equal(again.body.version, null);
  assert.equal(again.body.appointment.status, "in_exam");
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1 }, doctor)).statusCode, 409);
});

test("close returns warnings, stops only on finalize errors, and reports when the reception cannot be moved", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const appointment = await book(stores, clerk, { patientId: patient.patientId, walkIn: true });

  // 確定そのものが止めるエラー: 何も変えない
  const blocked = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", content: { prescriptions: [{ kind: "eye_drop", name: "" }] } }, doctor);
  const refused = await request(stores, "POST", `/v1/eye/encounters/${blocked.body.encounter.encounterId}/close`, { expectedRevision: 1 }, doctor);
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.details.blockers[0].code, "prescription_name_missing");
  assert.equal((await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments[0].status, "checked_in");
  await request(stores, "POST", `/v1/eye/encounters/${blocked.body.encounter.encounterId}/discard`, { expectedRevision: 1 }, doctor);

  // 警告（主訴・方針が空）は止めずに返す
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", visitType: "initial" }, doctor);
  const id = draft.body.encounter.encounterId;
  // 受付の保存が失敗する（ほかの人が同時に変えた）ようにする
  const original = stores.eyeStore.replaceAppointment;
  stores.eyeStore.replaceAppointment = () => {
    const error = new Error("appointment was updated by someone else; reload and try again");
    error.name = "ConflictError";
    error.statusCode = 409;
    throw error;
  };
  const closed = await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1, nextStatus: "in_treatment" }, doctor);
  stores.eyeStore.replaceAppointment = original;
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.encounter.status, "finalized", "the finalize is not rolled back");
  assert.deepEqual(closed.body.warnings.map((item) => item.code), ["chief_complaint_empty", "plan_empty"]);
  assert.equal(closed.body.appointmentMoved, false);
  assert.equal(closed.body.appointmentError.code, "conflict");
  assert.match(closed.body.appointmentError.message, /updated by someone else/u);
  assert.equal(closed.body.appointment.status, "checked_in");
  assert.equal((await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor)).body.encounter.status, "finalized");

  // 受付がない・複数あるときは動かさずに知らせる
  const other = await createPatient(stores, doctor, { displayName: "受付 なし", primaryPatientNumber: "000777" });
  const lonely = await request(stores, "POST", "/v1/eye/encounters", { patientId: other.patientId, encounterDate: "2026-10-27", content: closableContent() }, doctor);
  const none = await request(stores, "POST", `/v1/eye/encounters/${lonely.body.encounter.encounterId}/close`, { expectedRevision: 1 }, doctor);
  assert.equal(none.statusCode, 200);
  assert.equal(none.body.appointment, null);
  assert.equal(none.body.appointmentError.code, "no_appointment");
  await book(stores, clerk, { patientId: patient.patientId, walkIn: true });
  const twice = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", content: closableContent() }, doctor);
  const multiple = await request(stores, "POST", `/v1/eye/encounters/${twice.body.encounter.encounterId}/close`, { expectedRevision: 1 }, doctor);
  assert.equal(multiple.body.appointmentError.code, "multiple_appointments");
  assert.equal(multiple.body.appointmentError.appointmentIds.length, 2);
  const chosen = await request(stores, "POST", `/v1/eye/encounters/${twice.body.encounter.encounterId}/close`, { expectedRevision: multiple.body.encounter.revision, appointmentId: appointment.appointmentId }, doctor);
  assert.equal(chosen.body.appointment.status, "checkout");
});

test("sends one patient's billing, marks the reception paid, and shows 再計待 after the chart changes", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const other = await createPatient(stores, doctor, { displayName: "別 患者", primaryPatientNumber: "000999" });
  await book(stores, clerk, { patientId: patient.patientId, walkIn: true });
  const otherAppointment = await book(stores, clerk, { patientId: other.patientId, walkIn: true });
  const content = { ...closableContent(), orders: [{ orderId: "o1", code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou", status: "performed" }] };
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-10-27", content }, doctor);
  const id = draft.body.encounter.encounterId;
  const otherDraft = await request(stores, "POST", "/v1/eye/encounters", { patientId: other.patientId, encounterDate: "2026-10-27", content: closableContent() }, doctor);

  const listBefore = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments;
  assert.deepEqual(listBefore.map((item) => item.billingState), ["draft", "draft"]);
  const notYet = await request(stores, "POST", "/v1/eye/billing/send", { date: "2026-10-27", encounterId: id }, clerk);
  assert.equal(notYet.statusCode, 400, "an unfinalized chart cannot be sent");

  const closed = await request(stores, "POST", `/v1/eye/encounters/${id}/close`, { expectedRevision: 1 }, doctor);
  assert.equal(closed.body.appointment.status, "checkout");
  await request(stores, "POST", `/v1/eye/encounters/${otherDraft.body.encounter.encounterId}/close`, { expectedRevision: 1 }, doctor);
  const pending = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments;
  assert.deepEqual(pending.map((item) => [item.billingState, item.displayStatus]), [["pending", "checkout"], ["pending", "checkout"]]);

  assert.equal((await request(stores, "POST", "/v1/eye/billing/send", { date: "2026-10-27", encounterId: id }, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
  const sent = await request(stores, "POST", "/v1/eye/billing/send", { date: "2026-10-27", encounterId: id }, clerk);
  assert.equal(sent.statusCode, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.handoff.encounters.length, 1);
  assert.equal(sent.body.handoff.encounters[0].encounterId, id);
  assert.match(sent.body.csv, /静的視野検査/u);
  assert.doesNotMatch(sent.body.csv, /別 患者/u, "only this patient is handed off");
  assert.equal(sent.body.appointment.status, "done");
  assert.equal(sent.body.appointmentMoved, true);

  const afterSend = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments;
  assert.deepEqual(afterSend.map((item) => [item.billingState, item.displayStatus]), [["handed_off", "done"], ["pending", "checkout"]]);

  // カルテを直して品目が変わると、会計済の受付は「再計待」と出る
  await request(stores, "POST", `/v1/eye/encounters/${id}/amend`, { expectedRevision: closed.body.encounter.revision, reason: "検査の追記" }, doctor);
  const reopened = (await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor)).body.encounter;
  const patched = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: reopened.revision,
    sections: { orders: [...reopened.content.orders, { orderId: "o2", code: "iop", name: "眼圧検査", kind: "exam", eye: "ou", status: "performed" }] }
  }, doctor);
  const refinalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: patched.body.encounter.revision }, doctor);
  assert.equal(refinalized.statusCode, 200);
  const rebill = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments[0];
  assert.equal(rebill.status, "done");
  assert.equal(rebill.billingState, "changed");
  assert.equal(rebill.displayStatus, "rebill_waiting");

  // もう一度送ると連携済に戻る（受付は会計済のまま）。テストの時計は止まっているので、前回の連携を少し前にずらす。
  const handoffs = stores.eyeStore.billingHandoffs.get((await contextOf(stores, clerk)).orgId);
  handoffs.set(sent.body.handoff.handoffId, { ...handoffs.get(sent.body.handoff.handoffId), createdAt: "2026-10-27T00:30:00.000Z" });
  const resent = await request(stores, "POST", "/v1/eye/billing/send", { date: "2026-10-27", encounterId: id }, clerk);
  assert.equal(resent.statusCode, 201);
  assert.equal(resent.body.appointmentMoved, false);
  const settled = (await request(stores, "GET", "/v1/eye/appointments?date=2026-10-27", undefined, clerk)).body.appointments[0];
  assert.deepEqual([settled.status, settled.billingState, settled.displayStatus], ["done", "handed_off", "done"]);

  // 受付の更新に失敗しても連携は残し、失敗を知らせる
  const original = stores.eyeStore.replaceAppointment;
  stores.eyeStore.replaceAppointment = () => { throw Object.assign(new Error("store unavailable"), { statusCode: 500 }); };
  const partial = await request(stores, "POST", "/v1/eye/billing/send", { date: "2026-10-27", encounterId: otherDraft.body.encounter.encounterId, appointmentId: otherAppointment.appointmentId }, clerk);
  stores.eyeStore.replaceAppointment = original;
  assert.equal(partial.statusCode, 201);
  assert.equal(partial.body.appointmentMoved, false);
  assert.equal(partial.body.appointmentError.message, "store unavailable");
  const day = (await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk)).body;
  assert.equal(day.encounters.find((item) => item.encounterId === otherDraft.body.encounter.encounterId).handoff.state, "handed_off");

  // まとめての連携も従来どおり使える
  const bulk = await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: [id, otherDraft.body.encounter.encounterId] }, clerk);
  assert.equal(bulk.statusCode, 201);
  assert.equal(bulk.body.handoff.encounters.length, 2);
});

test("reception extras: doctors, a patient's appointments, memo and previous visit per patient, and search details", async () => {
  const stores = createStores();
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const doctorContext = await contextOf(stores, await signedHeaders(stores.platformStore, "doctor"));
  const patient = await createPatient(stores, clerk);

  const doctors = await request(stores, "GET", "/v1/eye/doctors", undefined, clerk);
  assert.equal(doctors.statusCode, 200);
  const doctorIds = doctors.body.doctors.map((item) => item.memberId);
  assert.ok(doctorIds.includes(doctorContext.memberId));
  assert.equal(doctorIds.length, 2, "the director (admin + doctor) and the doctor; never the clerk");

  const earlier = await book(stores, clerk, { date: "2026-10-20", time: "09:00", patientId: patient.patientId, doctorMemberId: doctorContext.memberId, department: "眼科" });
  await moveTo(stores, clerk, earlier, "done");
  await book(stores, clerk, { date: "2026-10-24", time: "09:00", patientId: patient.patientId });
  const today = await book(stores, clerk, { time: "10:00", patientId: patient.patientId });
  await book(stores, clerk, { time: "10:30", patientName: "未登録 さん" });

  const own = await request(stores, "GET", `/v1/eye/appointments?patientId=${patient.patientId}`, undefined, clerk);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.body.appointments.map((item) => item.date), ["2026-10-27", "2026-10-24", "2026-10-20"], "newest first");
  assert.equal(own.body.appointments[2].doctorMemberId, doctorContext.memberId);
  assert.equal((await request(stores, "GET", "/v1/eye/appointments?patientId=missing", undefined, clerk)).statusCode, 404);

  await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/memo`, { expectedRevision: 0, patientMemo: "車いす" }, clerk);
  const details = await request(stores, "GET", `/v1/eye/appointments/patient-details?date=${today.date}`, undefined, clerk);
  assert.equal(details.statusCode, 200);
  assert.deepEqual(details.body.patients, { [patient.patientId]: { primaryPatientNumber: "000123", patientMemo: "車いす", patientMemoRevision: 1, previousVisitDate: "2026-10-20" } }, "a booking that never arrived is not a visit");

  const plain = await request(stores, "POST", "/v1/eye/patients/search", { q: "ガンカ" }, clerk);
  assert.equal(plain.body.patients[0].lastVisitDate, undefined, "the header search stays light");
  const detailed = await request(stores, "POST", "/v1/eye/patients/search", { q: "ガンカ", details: true }, clerk);
  assert.equal(detailed.body.patients[0].patientMemo, "車いす");
  assert.equal(detailed.body.patients[0].lastVisitDate, "2026-10-20");
});
