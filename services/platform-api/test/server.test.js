import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePlatformApiRequest, resolvePlatformApiResponse } from "../src/server.js";
import { MemoryPlatformStore } from "../src/store/memory-store.js";

test("GET /healthz returns ok", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/healthz"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "platform-api");
});

test("GET /readyz includes environment metadata", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/readyz",
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z")
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.env, "test");
  assert.equal(response.body.projectId, "medical-core-stg");
  assert.equal(response.body.region, "asia-northeast1");
  assert.equal(response.body.startedAt, "2026-05-27T00:00:00.000Z");
});

test("unknown route returns 404", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/missing"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "not_found");
});

test("creates and lists organizations", async () => {
  const store = createTestStore();

  const created = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic A",
    displayName: "Clinic A"
  });
  const listed = await request(store, "GET", "/v1/organizations");

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.organization.orgId, "org_001");
  assert.equal(created.body.organization.organizationCode, "clinic-a");
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.organizations.length, 1);
  assert.equal(listed.body.organizations[0].displayName, "Clinic A");
});

test("creates organization members and patients", async () => {
  const store = createTestStore();
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic B",
    displayName: "Clinic B"
  });
  const orgId = createdOrg.body.organization.orgId;

  const createdMember = await request(store, "POST", `/v1/organizations/${orgId}/members`, {
    loginId: "doctor",
    displayName: "Doctor",
    globalRoles: ["doctor"],
    productRoles: {
      charting: ["doctor"]
    }
  });
  const createdPatient = await request(store, "POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Yamada Taro",
    birthDate: "1970-01-01",
    sex: "male"
  });

  assert.equal(createdMember.statusCode, 201);
  assert.equal(createdMember.body.member.memberId, "mem_002");
  assert.equal(createdMember.body.member.orgId, orgId);
  assert.equal(createdPatient.statusCode, 201);
  assert.equal(createdPatient.body.patient.patientId, "pat_003");
  assert.equal(createdPatient.body.patient.orgId, orgId);

  const listedMembers = await request(store, "GET", `/v1/organizations/${orgId}/members`);
  const listedPatients = await request(store, "GET", `/v1/organizations/${orgId}/patients`);

  assert.equal(listedMembers.body.members.length, 1);
  assert.equal(listedPatients.body.patients.length, 1);
});

test("returns validation and conflict errors as responses", async () => {
  const store = createTestStore();

  const invalid = await request(store, "POST", "/v1/organizations", {
    organizationCode: "",
    displayName: ""
  });
  const first = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C"
  });
  const duplicate = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C Duplicate"
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "validation");
  assert.equal(first.statusCode, 201);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.error, "conflict");
});

function createTestStore() {
  let counter = 0;
  return new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
}

function request(store, method, path, body) {
  return handlePlatformApiRequest({
    method,
    path,
    body,
    store,
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z")
  });
}
