import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { handleReferralApiRequest } from "../src/server.js";
import { MemoryReferralStore } from "../src/store/memory-store.js";

test("requires Platform session for referral routes", async () => {
  const response = await request(createStores(), "GET", "/v1/referral/context");

  assert.equal(response.statusCode, 401);
});

test("creates Platform patients and product-owned referral drafts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/referral/patients", {
    displayName: "山田 太郎",
    birthDate: "1970-01-01",
    sex: "male"
  }, headers);
  const draft = await request(stores, "POST", "/v1/referral/referrals", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    recipientInstitution: {
      displayName: "紹介先病院",
      medicalInstitutionCode: "9912345"
    },
    recipientDoctor: {
      displayName: "紹介 先生"
    },
    purpose: "精査依頼",
    clinicalSummary: "咳嗽が持続しています。",
    diagnoses: ["咳嗽"]
  }, headers);
  const pdf = await request(
    stores,
    "POST",
    `/v1/referral/referrals/${draft.body.referral.referralId}/document`,
    {},
    headers
  );
  const listed = await request(stores, "GET", "/v1/referral/referrals", undefined, headers);
  const auditEvents = stores.platformStore.listAuditEvents("org_001");

  assert.equal(patient.statusCode, 201);
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.body.referral.orgId, "org_001");
  assert.equal(draft.body.referral.patientId, patient.body.patient.patientId);
  assert.equal(draft.body.referral.patientSnapshot.displayName, "山田 太郎");
  assert.equal(draft.body.referral.facilitySnapshot.displayName, "春ナスクリニック");
  assert.equal(draft.body.referral.departmentSnapshot.displayName, "内科");
  assert.equal(draft.body.referral.authorMemberId, "mem_001");
  assert.equal(draft.body.referral.authorMemberSnapshot.displayName, "Admin");
  assert.equal(draft.body.referral.recipientInstitutionSnapshot.medicalInstitutionCode, "9912345");
  assert.equal(pdf.statusCode, 201);
  assert.equal(pdf.body.documentArtifact.provider, "halunasu_html");
  assert.equal(pdf.body.referral.status, "document_ready");
  assert.equal(listed.body.referrals.length, 1);
  assert.ok(auditEvents.some((event) => event.eventType === "referral.draft_created"));
  assert.ok(auditEvents.some((event) => event.eventType === "referral.document_created"));
});

test("patches referral drafts with validated product-owned fields", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = stores.platformStore.createPatient("org_001", { displayName: "佐藤 花子" });
  const draft = await request(stores, "POST", "/v1/referral/referrals", {
    patientId: patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    recipientInstitution: {
      displayName: "紹介先病院"
    },
    recipientDoctor: {
      displayName: "紹介 先生"
    },
    purpose: "精査依頼",
    clinicalSummary: "頭痛が続いています。"
  }, headers);
  const patched = await request(stores, "PATCH", `/v1/referral/referrals/${draft.body.referral.referralId}`, {
    status: "ready",
    medications: ["内服薬A"]
  }, headers);

  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.referral.status, "ready");
  assert.deepEqual(patched.body.referral.medications, ["内服薬A"]);
});

test("rejects referral access without product entitlement", async () => {
  const stores = createStores({ entitlement: false });
  const headers = await signedHeaders(stores.platformStore);
  const response = await request(stores, "GET", "/v1/referral/context", undefined, headers);

  assert.equal(response.statusCode, 403);
});

test("rejects referral writes for viewer-only product role", async () => {
  const stores = createStores({ globalRoles: [], productRoles: { referral: ["viewer"] } });
  const headers = await signedHeaders(stores.platformStore, {
    globalRoles: [],
    productRoles: { referral: ["viewer"] }
  });
  const response = await request(stores, "POST", "/v1/referral/patients", {
    displayName: "山田 太郎"
  }, headers);

  assert.equal(response.statusCode, 403);
});

test("referral-api does not import sibling product services", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

  assert.equal(source.includes("charting-api"), false);
  assert.equal(source.includes("fee-api"), false);
});

function createStores(options = {}) {
  let counter = 0;
  const platformCounters = new Map();
  const platformStore = new MemoryPlatformStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => {
      const next = Number(platformCounters.get(prefix) || 0) + 1;
      platformCounters.set(prefix, next);
      return `${prefix}_${String(next).padStart(3, "0")}`;
    },
    tokenFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const referralStore = new MemoryReferralStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = platformStore.createOrganization({
    organizationCode: "Clinic",
    displayName: "Clinic"
  });
  platformStore.createMember(organization.orgId, {
    loginId: "admin@example.com",
    displayName: "Admin",
    globalRoles: options.globalRoles ?? ["org_admin"],
    productRoles: options.productRoles ?? { referral: ["admin"] },
    password: "correct horse battery staple"
  });
  platformStore.createFacility(organization.orgId, {
    displayName: "春ナスクリニック",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo"
  });
  platformStore.createDepartment(organization.orgId, {
    facilityId: "fac_001",
    displayName: "内科",
    code: "01"
  });
  if (options.entitlement !== false) {
    platformStore.upsertProductEntitlement(organization.orgId, {
      productId: "referral",
      status: "trialing"
    });
  }

  return { platformStore, referralStore };
}

async function signedHeaders(platformStore, overrides = {}) {
  const identity = platformStore.getLoginIdentity("clinic", "admin@example.com");
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: overrides.globalRoles ?? ["org_admin"],
    productRoles: overrides.productRoles ?? { referral: ["admin"] },
    csrfToken: "csrf_test"
  }, {
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });

  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

function request(stores, method, path, body, headers = {}) {
  return handleReferralApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    referralStore: stores.referralStore,
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-28T00:00:00.000Z"),
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
}
