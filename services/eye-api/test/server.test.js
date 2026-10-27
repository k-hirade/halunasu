import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
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

  const blocked = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 2 }, doctor);
  assert.equal(blocked.statusCode, 400);
  assert.deepEqual(blocked.body.details.blockers.map((item) => item.code), ["exam_unconfirmed", "exam_unconfirmed"]);

  const confirmed = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/exam-confirm`, { expectedRevision: 2, eye: "both" }, doctor);
  assert.equal(confirmed.body.encounter.examConfirmations.od.by.loginId, "eye-doctor");
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 3 }, doctor);
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.body.encounter.status, "finalized");
  assert.equal(finalized.body.version.version, 1);

  const editFinalized = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, {
    expectedRevision: 4,
    sections: { plan: "変更" }
  }, doctor);
  assert.equal(editFinalized.statusCode, 409);

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
  const response = await request(stores, "GET", `/v1/eye/patients?q=${encodeURIComponent("眼科")}`, undefined, doctor);
  assert.equal(response.body.patients.length, 1);
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

async function createPatient(stores, headers) {
  const response = await request(stores, "POST", "/v1/eye/patients", {
    displayName: "眼科 太郎",
    displayNameKana: "ガンカ タロウ",
    birthDate: "1950-04-01",
    sex: "male",
    primaryPatientNumber: "000123"
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

  const skip = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: 2, status: "done" }, clerk);
  assert.equal(skip.statusCode, 409);
  const stale = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: 1, status: "in_exam" }, clerk);
  assert.equal(stale.statusCode, 409);

  let revision = 2;
  for (const status of ["in_exam", "waiting_doctor", "in_consult", "checkout", "done"]) {
    const moved = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: revision, status }, clerk);
    assert.equal(moved.statusCode, 200, status);
    revision = moved.body.appointment.revision;
  }

  const back = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: revision, status: "checkout" }, clerk);
  const recheck = await request(stores, "POST", `/v1/eye/appointments/${id}/status`, { expectedRevision: back.body.appointment.revision, status: "checked_in" }, clerk);
  assert.equal(recheck.statusCode, 409, "a finished visit cannot jump back to reception");

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
  assert.equal((await request(stores, "POST", "/v1/eye/order-sets", { name: "x" }, doctor)).statusCode, 403);

  const phrase = await request(stores, "POST", "/v1/eye/phrases", { target: "findings.fundus", label: "眼底正常", text: "異常なし" }, director);
  assert.equal(phrase.body.phrase.target, "findings.fundus");
  assert.equal((await request(stores, "POST", "/v1/eye/phrases", { target: "nowhere", text: "x" }, director)).statusCode, 400);

  const bootstrap = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.equal(bootstrap.body.orderSets.length, 1);
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

test("blocks finalizing an issued glasses prescription with inconsistent values", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-10-27",
    visitType: "initial",
    content: { optical: { type: "glasses", issue: true, od: { sphere: -2, cylinder: -0.5 }, os: { sphere: -1.5 }, pd: 62 } }
  }, doctor);
  const blocked = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  assert.equal(blocked.statusCode, 400);
  assert.deepEqual(blocked.body.details.blockers.map((item) => item.code), ["optical_axis_mismatch"]);
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
  await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 4 }, doctor);
  const after = await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, clerk);
  assert.equal(after.body.encounters[0].handoff.state, "changed", "a re-finalized chart needs another handoff");

  const csv = await request(stores, "GET", "/v1/eye/billing/day.csv?date=2026-10-27", undefined, clerk);
  assert.equal(csv.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal((await request(stores, "GET", "/v1/eye/billing/day?date=2026-10-27", undefined, await signedHeaders(stores.platformStore, "viewer"))).statusCode, 403);
  assert.equal((await request(stores, "POST", "/v1/eye/billing/handoffs", { date: "2026-10-27", encounterIds: ["eenc_missing"] }, clerk)).statusCode, 400);
});
