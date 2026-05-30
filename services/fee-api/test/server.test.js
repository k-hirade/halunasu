import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { handleFeeApiRequest } from "../src/server.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

test("requires Platform session for fee routes", async () => {
  const response = await request(createStores(), "GET", "/v1/fee/context");

  assert.equal(response.statusCode, 401);
});

test("readyz reports fee master readiness", async () => {
  const response = await request(createStores(), "GET", "/readyz");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.feeCalculator.provider, "test_fee_engine");
  assert.equal(response.body.feeCalculator.masterDbConfigured, true);
  assert.equal(response.body.feeCalculator.masterDbPathExists, true);
});

test("creates Platform patients and product-owned fee sessions", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "山田 太郎",
    birthDate: "1970-01-01",
    sex: "male",
    externalPatientIds: ["legacy-001"]
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    patientRef: "legacy-001",
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-05-28",
    clinicalText: "咳嗽。処方あり。",
    orders: [
      {
        orderId: "ord_1",
        orderType: "drug",
        localName: "カルボシステイン錠",
        quantity: 2
      }
    ]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );
  const receiptDraft = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/receipt-draft`,
    undefined,
    headers
  );
  const reviewItems = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/review-items`,
    undefined,
    headers
  );
  const decision = await request(
    stores,
    "PATCH",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/review-items/${encodeURIComponent(reviewItems.body.reviewItems[0].reviewItemId)}`,
    { status: "approved", note: "確認済み" },
    headers
  );
  const listed = await request(stores, "GET", "/v1/fee/sessions", undefined, headers);
  const bootstrap = await request(stores, "GET", "/v1/fee/bootstrap?page=1&pageSize=20", undefined, headers);
  const auditEvents = stores.platformStore.listAuditEvents("org_001");

  assert.equal(patient.statusCode, 201);
  assert.equal(session.statusCode, 201);
  assert.equal(session.body.feeSession.orgId, "org_001");
  assert.equal(session.body.feeSession.patientId, patient.body.patient.patientId);
  assert.equal(session.body.feeSession.patientRef, "legacy-001");
  assert.equal(session.body.feeSession.facilitySnapshot.medicalInstitutionCode, "1312345");
  assert.equal(session.body.feeSession.facilitySnapshot.regionalBureau, "kanto-shinetsu");
  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.calculationResult.provider, "test_fee_engine");
  assert.equal(calculation.body.calculationResult.totalPoints, 137);
  assert.equal(calculation.body.calculationResult.coverage.scope, "candidate_review_support");
  assert.equal(calculation.body.calculationResult.lineItems[0].supportLevel, "candidate");
  assert.equal(calculation.body.calculationResult.lineItems[0].reviewRequired, true);
  assert.equal(calculation.body.feeSession.status, "needs_review");
  assert.equal(receiptDraft.body.receiptDraft.totalPoints, 137);
  assert.ok(reviewItems.body.reviewItems.length >= 1);
  assert.equal(decision.body.feeSession.reviewDecisions[reviewItems.body.reviewItems[0].reviewItemId].status, "approved");
  assert.equal(listed.body.feeSessions.length, 1);
  assert.equal(listed.body.page, 1);
  assert.equal(listed.body.totalCount, 1);
  assert.equal(listed.body.feeSessions[0].calculationResult, undefined);
  assert.equal(listed.body.feeSessions[0].calculationSummary.totalPoints, 137);
  assert.equal(bootstrap.body.patients.length, 1);
  assert.equal(bootstrap.body.facilities.length, 1);
  assert.equal(bootstrap.body.departments.length, 1);
  assert.equal(bootstrap.body.feeSessions.length, 1);
  assert.ok(auditEvents.some((event) => event.eventType === "fee.session_created"));
  assert.ok(auditEvents.some((event) => event.eventType === "fee.calculated"));
  assert.ok(auditEvents.some((event) => event.eventType === "fee.review_item_decided"));
});

test("can create inline Platform patient when creating fee session", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: {
      displayName: "佐藤 花子"
    },
    patientRef: "legacy-002",
    facilityId: "fac_001",
    serviceDate: "2026-05-28"
  }, headers);
  const patients = stores.platformStore.listPatients("org_001");

  assert.equal(session.statusCode, 201);
  assert.equal(patients.length, 1);
  assert.equal(session.body.feeSession.patientId, patients[0].patientId);
  assert.equal(session.body.feeSession.patientSnapshot.displayName, "佐藤 花子");
});

test("rejects fee access without product entitlement", async () => {
  const stores = createStores({ entitlement: false });
  const headers = await signedHeaders(stores.platformStore);
  const response = await request(stores, "GET", "/v1/fee/context", undefined, headers);

  assert.equal(response.statusCode, 403);
});

test("fee-api no longer contains OPERATOR_ACCOUNTS_JSON production path", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

  assert.equal(source.includes("OPERATOR_ACCOUNTS_JSON"), false);
  assert.equal(source.includes("tenant_id"), false);
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
  const feeStore = new MemoryFeeStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const feeCalculator = {
    readiness() {
      return {
        provider: "test_fee_engine",
        masterDbConfigured: true,
        masterDbPathExists: true
      };
    },
    async calculate(feeSession) {
      return {
        provider: "test_fee_engine",
        source: "test",
        status: "completed",
        totalPoints: 137,
        lineItems: [{
          lineId: "line_1",
          code: "160000410",
          name: feeSession.orders[0]?.localName || "検査",
          orderType: "lab",
          points: 137,
          quantity: 1,
          totalPoints: 137,
          status: "candidate",
          source: "test",
          coverage: {
            scope: "candidate_rule",
            chapter: "D_lab",
            supportLevel: "candidate",
            reviewRequired: true
          }
        }],
        warnings: []
      };
    }
  };
  const organization = platformStore.createOrganization({
    organizationCode: "Clinic",
    displayName: "Clinic"
  });
  platformStore.createMember(organization.orgId, {
    loginId: "admin@example.com",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
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
      productId: "fee",
      status: "trialing"
    });
  }

  return { platformStore, feeStore, feeCalculator };
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
    productRoles: { fee: ["admin"] },
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
  return handleFeeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    feeStore: stores.feeStore,
    feeCalculator: stores.feeCalculator,
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-28T00:00:00.000Z"),
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
}
