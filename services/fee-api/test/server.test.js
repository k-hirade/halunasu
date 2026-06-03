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

test("searches fee master through authenticated fee route", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const response = await request(stores, "GET", "/v1/fee/master/search?type=drug&q=カルボ&limit=5", undefined, headers);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.query, "カルボ");
  assert.equal(response.body.type, "drug");
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].kind, "drug");
  assert.equal(response.body.items[0].code, "620000001");
  assert.equal(response.body.masterStatus.provider, "test_fee_engine");
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
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
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
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("病名")));
  assert.equal(calculation.body.calculationResult.coverage.scope, "candidate_review_support");
  assert.equal(calculation.body.calculationResult.lineItems[0].supportLevel, "candidate");
  assert.equal(calculation.body.calculationResult.lineItems[0].reviewRequired, true);
  assert.equal(detail.body.feeSession.orders[0].standardCode, "620000001");
  assert.equal(detail.body.feeSession.orders[0].standardName, "カルボシステイン錠");
  assert.equal(calculation.body.feeSession.status, "needs_review");
  assert.equal(calculation.body.receiptDraft.totalPoints, 137);
  assert.ok(calculation.body.reviewItems.length >= 1);
  assert.equal(receiptDraft.body.receiptDraft.totalPoints, 137);
  assert.ok(reviewItems.body.reviewItems.length >= 1);
  assert.equal(detail.body.receiptDraft.totalPoints, 137);
  assert.ok(detail.body.reviewItems.length >= 1);
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

test("resolves name-only orders against master before calculation", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedSession = null;
  stores.feeCalculator.searchMaster = async (input) => {
    assert.equal(input.type, "procedure");
    assert.equal(input.query, "創傷処置（１００ｃｍ２未満）");
    return {
      query: input.query,
      type: input.type,
      items: [{
        kind: "procedure",
        code: "140000610",
        name: "創傷処置（１００ｃｍ２未満）",
        points: 52
      }]
    };
  };
  stores.feeCalculator.calculate = async (feeSession) => {
    receivedSession = feeSession;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 52,
      lineItems: [{
        lineId: "line_1",
        code: feeSession.orders[0]?.standardCode,
        name: feeSession.orders[0]?.standardName,
        orderType: "procedure",
        points: 52,
        quantity: 1,
        totalPoints: 52,
        status: "candidate",
        source: "medical_procedure_master"
      }],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "熱傷 太郎"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: "右前腕部熱傷。創部4×6cm。ゲーベンクリーム塗布。",
    diagnoses: [{ name: "熱傷" }],
    orders: [{
      orderType: "procedure",
      localName: "創傷処置（１００ｃｍ２未満）",
      quantity: 1
    }]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedSession.orders[0].standardCode, "140000610");
  assert.equal(receivedSession.orders[0].standardName, "創傷処置（１００ｃｍ２未満）");
  assert.equal(calculation.body.calculationResult.totalPoints, 52);
  assert.equal(detail.body.feeSession.orders[0].standardCode, "140000610");
});

test("reconnects clinical text to legacy outpatient calculation input", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterItems = {
    "ロキソプロフェン": { kind: "drug", code: "620001001", name: "ロキソプロフェン錠60mg" },
    "レバミピド": { kind: "drug", code: "620001002", name: "レバミピド錠100mg" },
    "ロコアテープ": { kind: "drug", code: "620001003", name: "ロコアテープ" },
    "コルセット": { kind: "material", code: "710001001", name: "腰椎コルセット" }
  };
  stores.feeCalculator.searchMaster = async (input) => ({
    query: input.query,
    type: input.type,
    items: masterItems[input.query] ? [masterItems[input.query]] : []
  });
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 420,
      lineItems: [{
        lineId: "line_initial",
        code: "111000110",
        name: "初診料",
        orderType: "outpatient_basic",
        points: 288,
        quantity: 1,
        totalPoints: 288,
        status: "candidate",
        source: "outpatient_basic_fee"
      }],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Demo Patient",
    externalPatientIds: ["demo-001"]
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: [
      "症例設定：整形外科外来、腰痛初診／45歳男性",
      "O（Objective：客観的情報）",
      "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化、骨棘形成あり",
      "A（Assessment：評価）",
      "腰椎椎間板ヘルニア疑い（L4/5）",
      "P（Plan：計画）",
      "MRI腰椎オーダー（次回持参または当院撮影）",
      "ロキソプロフェン60mg 毎食後3錠／14日分処方（胃薬併用：レバミピド）",
      "湿布処方：ロコアテープ2枚／日",
      "腰椎コルセット装着指導"
    ].join("\n"),
    diagnoses: [{ name: "腰椎椎間板ヘルニア疑い" }],
    orders: [
      { orderType: "imaging", localName: "画像診断", quantity: 1 },
      { orderType: "treatment", localName: "医学管理等", quantity: 1 }
    ]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.calculationResult.totalPoints, 420);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind).sort(),
    ["mri", "simple_radiography"]
  );
  assert.deepEqual(
    receivedInput.calculationOptions.medication_orders.map((order) => order.drug_code).sort(),
    ["620001001", "620001002", "620001003"]
  );
  assert.deepEqual(receivedInput.calculationOptions.material_inputs, [{ code: "710001001", quantity: "1" }]);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI検査")));
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("オーダー「画像診断」")), false);
  assert.equal(detail.body.feeSession.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.equal(detail.body.feeSession.calculationOptions.imaging_orders.length, 2);
});

test("adds review warning when calculation produces no candidate lines", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => ({
    query: input.query,
    type: input.type,
    items: []
  });
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 0,
    lineItems: [],
    warnings: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Zero Candidate"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: "初診。診療内容は記載されているが具体的な標準コードがない。",
    diagnoses: [{ name: "腰痛症" }],
    orders: [{ orderType: "other", localName: "カルテ記載内容から算定候補を確認", quantity: 1 }]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.feeSession.status, "needs_review");
  assert.ok(calculation.body.calculationResult.warnings.length >= 1);
  assert.ok(calculation.body.reviewItems.length >= 1);
});

test("keeps explicit legacy calculation options over inferred values", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 73,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Explicit Options"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: "初診として来院。実際には継続診療の再診扱い。",
    diagnoses: [{ name: "腰痛症" }],
    calculationOptions: {
      outpatient_basic: { fee_kind: "revisit" }
    }
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
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

test("creates draft fee sessions and updates them before calculation", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "山田 太郎"
  }, headers);
  const draft = await request(stores, "POST", "/v1/fee/sessions", {}, headers);
  const draftReceipt = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${draft.body.feeSession.feeSessionId}/receipt-draft`,
    undefined,
    headers
  );
  const rejected = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${draft.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );
  const updated = await request(stores, "PATCH", `/v1/fee/sessions/${draft.body.feeSession.feeSessionId}`, {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-29",
    clinicalText: "発熱。",
    orders: [{
      orderType: "lab",
      localName: "血液検査"
    }]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${draft.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(draft.statusCode, 201);
  assert.equal(draft.body.feeSession.status, "draft");
  assert.equal(draftReceipt.statusCode, 200);
  assert.equal(draftReceipt.body.receiptDraft.status, "not_calculated");
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.message, /患者/);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.feeSession.status, "ready");
  assert.equal(updated.body.feeSession.patientSnapshot.displayName, "山田 太郎");
  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.feeSession.status, "needs_review");
});

test("persists detailed calculation input and passes it to calculator", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 55,
      lineItems: [{
        lineId: "line_1",
        code: feeSession.orders[0]?.standardCode,
        name: feeSession.orders[0]?.localName,
        orderType: "material",
        points: 55,
        quantity: 1,
        totalPoints: 55,
        status: "candidate",
        source: "specific_material_master"
      }],
      warnings: []
    };
  };

  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "材料 太郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    orders: [{
      orderType: "material",
      localName: "テスト特定器材",
      standardCode: "710000001",
      quantity: 1
    }],
    claimContext: {
      record_id: "legacy-claim-1",
      material_inputs: [{ code: "710000001", quantity: 1 }]
    },
    calculationOptions: {
      facility_standard_keys: ["検体検査管理加算1"],
      comment_inputs: [{ code: "840000001", text: "コメント" }]
    }
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(session.statusCode, 201);
  assert.equal(session.body.feeSession.orders[0].orderType, "material");
  assert.deepEqual(session.body.feeSession.claimContext.material_inputs, [{ code: "710000001", quantity: 1 }]);
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.claimContext.material_inputs, [{ code: "710000001", quantity: 1 }]);
  assert.deepEqual(receivedInput.calculationOptions.comment_inputs, [{ code: "840000001", text: "コメント" }]);
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
    async searchMaster(input) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "drug",
          code: "620000001",
          name: "カルボシステイン錠",
          unitName: "錠",
          sourceVersion: "test-master"
        }]
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
