// replicate-2（approval）: カルテの承認（指導医の承認）と、基準値（バイタル・検査）の設定。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { auditEventCategory } from "../../../packages/eye-contracts/src/index.js";
import { DEFAULT_REFERENCE_RANGES, referenceLevel, resolveReferenceRanges, validateReferenceRanges } from "../../../packages/eye-core/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { approvalRequirement } from "../src/approval.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-11T01:00:00.000Z");

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  mentor: { loginId: "eye-mentor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  resident: { loginId: "eye-resident", globalRoles: [], productRoles: { eye: ["doctor"] } },
  orthoptist: { loginId: "eye-ort", globalRoles: [], productRoles: { eye: ["orthoptist"] } },
  clerk: { loginId: "eye-clerk", globalRoles: [], productRoles: { eye: ["medical_clerk"] } }
};

test("approval is off by default: finalize keeps the old behaviour and no approval state is added", async () => {
  const stores = createStores();
  const resident = await signedHeaders(stores.platformStore, "resident");
  const director = await signedHeaders(stores.platformStore, "director");
  await setFlags(stores, director, "resident", { requiresApproval: true });
  const encounterId = await createEncounter(stores, resident);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 1 }, resident);
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.body.encounter.approval, undefined);
  assert.equal(finalized.body.approval, null);
  const detail = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, resident);
  assert.equal(detail.body.approvalContext.enabled, false);
  assert.equal(detail.body.approval, null);
});

test("staff approval flags: administrators only, approver must be a doctor, flags and print name saved independently", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const mentor = await signedHeaders(stores.platformStore, "mentor");
  const ids = memberIds(stores);
  assert.equal((await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.resident}`, { requiresApproval: true }, mentor)).statusCode, 403);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = director;
  assert.equal((await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.resident}`, { requiresApproval: true }, withoutCsrf)).statusCode, 403);
  assert.equal((await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.orthoptist}`, { approver: true }, director)).statusCode, 400, "only doctors approve");
  assert.equal((await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.resident}`, { approver: "yes" }, director)).statusCode, 400);
  await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.mentor}`, { printName: "指導 一郎" }, director);
  const flagged = await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.mentor}`, { approver: true }, director);
  assert.equal(flagged.statusCode, 200);
  assert.equal(flagged.body.staffProfile.printName, "指導 一郎", "saving only flags keeps the print name");
  await request(stores, "PUT", `/v1/eye/staff-profiles/${ids.mentor}`, { printName: "指導 一郎（印）" }, director);
  const staff = await request(stores, "GET", "/v1/eye/staff-profiles", undefined, director);
  const row = staff.body.staff.find((item) => item.memberId === ids.mentor);
  assert.equal(row.approver, true, "saving only the print name keeps the flags");
  assert.equal(row.requiresApproval, false);
  const logs = await request(stores, "GET", "/v1/eye/audit-logs", undefined, director);
  assert.ok(logs.body.auditLogs.some((item) => item.eventType === "eye.staff_profile_saved" && item.safePayload?.approver === true));
});

test("approval workflow: pending → return with comment → amend → pending v2 → approve; versions kept and audited", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const resident = await signedHeaders(stores.platformStore, "resident");
  const mentor = await signedHeaders(stores.platformStore, "mentor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  await enableApproval(stores, director);
  await setFlags(stores, director, "resident", { requiresApproval: true });
  await setFlags(stores, director, "mentor", { approver: true });

  const encounterId = await createEncounter(stores, resident);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: 1 }, resident);
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.body.approval.status, "pending");
  assert.equal(finalized.body.approval.version, 1);
  assert.equal(finalized.body.approval.current, true);

  // 一覧（患者のカルテ・その日のカルテ・承認待ち・診察の要対応）に出る
  const list = await request(stores, "GET", "/v1/eye/approvals", undefined, mentor);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.canApprove, true);
  assert.equal(list.body.items[0].encounterId, encounterId);
  assert.equal(list.body.items[0].finalizedBy, "eye-resident");
  const worklist = await request(stores, "GET", "/v1/eye/worklist", undefined, mentor);
  assert.equal(worklist.body.approvalPendingCount, 1);
  assert.equal(worklist.body.approval.canApprove, true);
  const day = await request(stores, "GET", "/v1/eye/encounters?date=2026-11-11", undefined, resident);
  assert.equal(day.body.encounters[0].approval.status, "pending");
  assert.equal((await request(stores, "GET", "/v1/eye/approvals", undefined, clerk)).statusCode, 403);

  // 承認できるのは承認者だけ。自分が確定した版は承認できない。CSRF が要る。
  const residentView = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, resident);
  assert.equal(residentView.body.approvalContext.canDecide, false);
  const mentorView = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, mentor);
  assert.equal(mentorView.body.approvalContext.canDecide, true);
  const revision = mentorView.body.encounter.revision;
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: revision, version: 1 }, resident)).statusCode, 403);
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: revision, version: 1 }, director)).statusCode, 403, "admins without the approver flag cannot approve");
  const { "x-csrf-token": _csrf, ...noCsrf } = mentor;
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: revision, version: 1 }, noCsrf)).statusCode, 403);
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: revision, version: 2 }, mentor)).statusCode, 409, "only the version on screen");
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/return`, { expectedRevision: revision, version: 1, comment: "" }, mentor)).body.field, "comment", "returning needs a reason");

  const returned = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/return`, { expectedRevision: revision, version: 1, comment: "眼圧の測定方法を追記してください" }, mentor);
  assert.equal(returned.statusCode, 200);
  assert.equal(returned.body.encounter.status, "finalized", "a returned chart stays finalized (billing is not blocked)");
  assert.equal(returned.body.approval.status, "returned");
  assert.equal(returned.body.approval.comment, "眼圧の測定方法を追記してください");
  assert.equal((await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: returned.body.encounter.revision, version: 1 }, mentor)).statusCode, 409, "a returned chart is not pending");
  assert.equal((await request(stores, "GET", "/v1/eye/approvals", undefined, mentor)).body.count, 0);

  // 書いた人が直す（確定のときに開いていた画面からでも、承認で進んだ版に止められずに修正を始められる）
  const edit = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: finalized.body.encounter.revision, sections: { plan: "眼圧はGAT で測定" } }, resident);
  assert.equal(edit.statusCode, 200);
  assert.equal(edit.body.amendStarted, true);
  const refinalized = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: edit.body.encounter.revision }, resident);
  assert.equal(refinalized.body.version.version, 2);
  assert.equal(refinalized.body.approval.status, "pending");
  assert.equal(refinalized.body.approval.version, 2);

  const mentorView2 = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, mentor);
  const approved = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/approve`, { expectedRevision: mentorView2.body.encounter.revision, version: 2 }, mentor);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.approval.status, "approved");
  assert.equal(approved.body.approval.decidedBy.loginId, "eye-mentor");
  assert.equal(approved.body.approval.decidedAt, NOW.toISOString());
  assert.equal(approved.body.encounter.approval.contentHash, refinalized.body.version.contentHash, "approval records the approved version's hash");

  // 版は 2 つとも残り、版ごとの承認の記録が付く
  const after = await request(stores, "GET", `/v1/eye/encounters/${encounterId}`, undefined, resident);
  assert.deepEqual(after.body.versions.map((item) => item.version), [1, 2]);
  assert.deepEqual(after.body.versions[0].approvalEvents.map((item) => item.action), ["requested", "returned"]);
  assert.deepEqual(after.body.versions[1].approvalEvents.map((item) => item.action), ["requested", "approved"]);
  const v1 = await request(stores, "GET", `/v1/eye/encounters/${encounterId}/versions/1`, undefined, resident);
  assert.equal(v1.body.version.content.plan, "");

  // 承認後の修正は新しい版で、また承認が要る
  const edit2 = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: refinalized.body.encounter.revision, sections: { plan: "次回 視野" } }, resident);
  assert.equal(edit2.statusCode, 200);
  const v3 = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: edit2.body.encounter.revision }, resident);
  assert.equal(v3.body.approval.status, "pending");
  assert.equal(v3.body.approval.version, 3);

  // 指導医が直して確定したときは、その版をそのまま承認済みにする
  const edit3 = await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: v3.body.encounter.revision, sections: { plan: "次回 視野・OCT" } }, mentor);
  const v4 = await request(stores, "POST", `/v1/eye/encounters/${encounterId}/finalize`, { expectedRevision: edit3.body.encounter.revision }, mentor);
  assert.equal(v4.body.approval.status, "approved");
  assert.equal(v4.body.encounter.approval.auto, true);

  // 会計の一覧には承認の状態を出す（止めない）
  const billing = await request(stores, "GET", "/v1/eye/billing/day?date=2026-11-11", undefined, director);
  assert.equal(billing.body.encounters[0].approval.status, "approved");

  const logs = await request(stores, "GET", "/v1/eye/audit-logs", undefined, director);
  const types = logs.body.auditLogs.map((item) => item.eventType);
  assert.ok(types.includes("eye.encounter_approval_requested"));
  assert.ok(types.includes("eye.encounter_returned"));
  assert.ok(types.includes("eye.encounter_approved"));
  const returnedLog = logs.body.auditLogs.find((item) => item.eventType === "eye.encounter_returned");
  assert.equal(returnedLog.safePayload.hasComment, true);
  assert.equal(JSON.stringify(returnedLog.safePayload).includes("眼圧"), false, "the comment text is not in the audit log");
  assert.equal(auditEventCategory("eye.encounter_approved"), "finalize");
});

test("approval requirement rules", () => {
  assert.equal(approvalRequirement({ enabled: false, staffProfile: { requiresApproval: true }, current: {} }), null);
  assert.equal(approvalRequirement({ enabled: true, staffProfile: null, current: {} }), null);
  assert.equal(approvalRequirement({ enabled: true, staffProfile: { requiresApproval: true }, current: {} }), "pending");
  assert.equal(approvalRequirement({ enabled: true, staffProfile: null, current: { approval: { status: "approved" } } }), "pending", "a chart already in the flow needs approval again");
  assert.equal(approvalRequirement({ enabled: true, staffProfile: { approver: true }, current: { approval: { status: "pending" } } }), "auto_approved");
  assert.equal(approvalRequirement({ enabled: true, staffProfile: { approver: true }, current: {} }), null);
});

test("reference ranges: defaults, partial save, validation, and bootstrap", async () => {
  const stores = createStores();
  const director = await signedHeaders(stores.platformStore, "director");
  const mentor = await signedHeaders(stores.platformStore, "mentor");
  const empty = await request(stores, "GET", "/v1/eye/clinic-config/referenceRanges", undefined, mentor);
  assert.deepEqual(empty.body.value.exam.iop, { low: 10, high: 21 });
  assert.deepEqual(empty.body.value.vitals.systolic, { low: 90, high: 139 });
  assert.equal(empty.body.revision, 0);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/referenceRanges", { value: { exam: { iop: { low: 22, high: 21 } } } }, director)).body.field, "exam.iop.low");
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/referenceRanges", { value: { exam: { iop: { low: "abc" } } } }, director)).statusCode, 400);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/referenceRanges", { value: { vitals: { spo2: { low: 120 } } } }, director)).statusCode, 400);
  assert.equal((await request(stores, "PUT", "/v1/eye/clinic-config/referenceRanges", { value: { exam: { iop: { low: 9, high: 20 } } } }, mentor)).statusCode, 403);
  const saved = await request(stores, "PUT", "/v1/eye/clinic-config/referenceRanges", { value: { exam: { iop: { low: 9, high: 20 }, cd: { low: null, high: null } }, vitals: { systolic: { low: "100", high: 130 } } } }, director);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body.value.exam.iop, { low: 9, high: 20 });
  assert.deepEqual(saved.body.value.exam.cd, { low: null, high: null }, "a blank range turns the reference off");
  assert.deepEqual(saved.body.value.vitals.systolic, { low: 100, high: 130 });
  assert.deepEqual(saved.body.value.exam.k1, { low: 41, high: 47 }, "unsent items keep the defaults");
  const boot = await request(stores, "GET", "/v1/eye/bootstrap", undefined, mentor);
  assert.deepEqual(boot.body.clinicConfig.referenceRanges.exam.iop, { low: 9, high: 20 });
  assert.equal(boot.body.clinicConfig.approval.enabled, false);

  // 保存の後で項目が増えても、既定の値が入る
  assert.deepEqual(resolveReferenceRanges({ exam: { iop: { low: 9, high: 20 } } }).exam.pupil, { low: 2, high: 5 });
  assert.deepEqual(validateReferenceRanges({}).vitals.bmi, { low: 18.5, high: 24.9 });
  assert.equal(referenceLevel(0.6, DEFAULT_REFERENCE_RANGES.exam.vac), "low");
  assert.equal(referenceLevel(0.7, DEFAULT_REFERENCE_RANGES.exam.cd), "high");
  assert.equal(referenceLevel(18, DEFAULT_REFERENCE_RANGES.exam.iop), "");
});

async function enableApproval(stores, director) {
  const saved = await request(stores, "PUT", "/v1/eye/clinic-config/approval", { expectedRevision: 0, value: { enabled: true } }, director);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.value.enabled, true);
}

async function setFlags(stores, director, profileName, flags) {
  const response = await request(stores, "PUT", `/v1/eye/staff-profiles/${memberIds(stores)[profileName]}`, flags, director);
  assert.equal(response.statusCode, 200);
}

function memberIds(stores) {
  const orgId = stores.orgId;
  return Object.fromEntries(Object.entries(ROLE_PROFILES).map(([name, profile]) => [name, stores.platformStore.listMembers(orgId).find((member) => member.loginId === profile.loginId).memberId]));
}

async function createEncounter(stores, headers) {
  const patient = await request(stores, "POST", "/v1/eye/patients", { displayName: "承認 花子", displayNameKana: "ショウニン ハナコ", birthDate: "1960-01-01", sex: "female", primaryPatientNumber: "000777" }, await signedHeaders(stores.platformStore, "clerk"));
  assert.equal(patient.statusCode, 201);
  const created = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.body.patient.patientId, encounterDate: "2026-11-11", visitType: "revisit" }, headers);
  assert.equal(created.statusCode, 201);
  return created.body.encounter.encounterId;
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
