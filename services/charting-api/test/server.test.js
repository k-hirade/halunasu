import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { handleChartingApiRequest } from "../src/server.js";
import { MemoryChartingStore } from "../src/store/memory-store.js";

test("requires Platform session for charting routes", async () => {
  const response = await request(createStores(), "GET", "/v1/charting/context");

  assert.equal(response.statusCode, 401);
});

test("creates Platform patients and product-owned charting encounters", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/charting/patients", {
    displayName: "山田 太郎",
    birthDate: "1970-01-01",
    sex: "male"
  }, headers);
  const encounter = await request(stores, "POST", "/v1/charting/encounters", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_123",
    departmentId: "dep_123",
    visitReason: "咳",
    transcript: "咳が続く。発熱なし。"
  }, headers);
  const draft = await request(stores, "POST", `/v1/charting/encounters/${encounter.body.encounter.encounterId}/mock-soap`, {
    transcript: "咳が続く。発熱なし。"
  }, headers);
  const listed = await request(stores, "GET", "/v1/charting/encounters", undefined, headers);
  const auditEvents = stores.platformStore.listAuditEvents("org_001");

  assert.equal(patient.statusCode, 201);
  assert.equal(encounter.statusCode, 201);
  assert.equal(encounter.body.encounter.patientId, patient.body.patient.patientId);
  assert.equal(encounter.body.encounter.patientSnapshot.displayName, "山田 太郎");
  assert.equal(encounter.body.encounter.facilityId, "fac_123");
  assert.equal(encounter.body.encounter.departmentId, "dep_123");
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.body.soapDraft.provider, "mock");
  assert.equal(listed.body.encounters.length, 1);
  assert.ok(auditEvents.some((event) => event.eventType === "charting.encounter_created"));
  assert.equal(stores.platformStore.listOrganizations().length, 1);
});

test("can create a patient inline when creating an encounter", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const encounter = await request(stores, "POST", "/v1/charting/encounters", {
    patient: {
      displayName: "佐藤 花子"
    },
    visitReason: "頭痛"
  }, headers);
  const patients = stores.platformStore.listPatients("org_001");

  assert.equal(encounter.statusCode, 201);
  assert.equal(patients.length, 1);
  assert.equal(encounter.body.encounter.patientId, patients[0].patientId);
  assert.equal(encounter.body.encounter.patientSnapshot.displayName, "佐藤 花子");
});

test("rejects charting access without product entitlement", async () => {
  const stores = createStores({ entitlement: false });
  const headers = await signedHeaders(stores.platformStore);
  const response = await request(stores, "GET", "/v1/charting/context", undefined, headers);

  assert.equal(response.statusCode, 403);
});

function createStores(options = {}) {
  let counter = 0;
  const platformStore = new MemoryPlatformStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`,
    tokenFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const chartingStore = new MemoryChartingStore({
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
    globalRoles: ["org_admin"],
    productRoles: { charting: ["admin"] },
    password: "correct horse battery staple"
  });
  if (options.entitlement !== false) {
    platformStore.upsertProductEntitlement(organization.orgId, {
      productId: "charting",
      status: "trialing"
    });
  }

  return { platformStore, chartingStore };
}

async function signedHeaders(platformStore) {
  const identity = platformStore.getLoginIdentity("clinic", "admin@example.com");
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: ["org_admin"],
    productRoles: { charting: ["admin"] },
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
  return handleChartingApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    chartingStore: stores.chartingStore,
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-28T00:00:00.000Z"),
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
}
