import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { procedureHintQueries } from "../src/clinical-master-resolver.js";
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

test("browses fee master only in stg", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const stgResponse = await request(
    stores,
    "GET",
    "/v1/fee/master/browse?type=procedure&q=初診&page=2&pageSize=25",
    undefined,
    headers,
    { env: "stg" }
  );
  const prodResponse = await request(
    stores,
    "GET",
    "/v1/fee/master/browse?type=procedure&q=初診",
    undefined,
    headers,
    { env: "prod" }
  );

  assert.equal(stgResponse.statusCode, 200);
  assert.equal(stgResponse.body.type, "procedure");
  assert.equal(stgResponse.body.query, "初診");
  assert.equal(stgResponse.body.page, 2);
  assert.equal(stgResponse.body.pageSize, 25);
  assert.equal(stgResponse.body.items[0].code, "111000110");
  assert.equal(stgResponse.body.sources[0].sourceType, "medical_procedure_master");
  assert.equal(stgResponse.body.masterStatus.provider, "test_fee_engine");
  assert.equal(prodResponse.statusCode, 404);
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
  assert.equal(decision.body.receiptDraft.totalPoints, 137);
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

test("calculates fee sessions inline outside test env", async () => {
  const stores = createStores();
  const headers = await signedBearerHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: {
      displayName: "非同期 太郎",
      sex: "unknown"
    },
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-05-28",
    clinicalText: "初診。血液検査を実施。"
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { env: "stg" }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.feeSession.status, "needs_review");
  assert.equal(calculation.body.calculationResult.totalPoints, 137);

  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers,
    { env: "stg" }
  );
  assert.equal(detail.body.feeSession.status, "needs_review");
  assert.equal(detail.body.feeSession.calculationSummary.totalPoints, 137);
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
  let receivedSessionContext = null;
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
    ["simple_radiography"]
  );
  assert.deepEqual(
    receivedInput.calculationOptions.medication_orders.map((order) => order.drug_code).sort(),
    ["620001001"]
  );
  assert.equal(receivedInput.calculationOptions.medication_orders.some((order) => order.drug_code === "620001003"), false);
  assert.equal(receivedInput.calculationOptions.material_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("レバミピド")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("コルセット")));
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("オーダー「画像診断」")), false);
  assert.equal(detail.body.feeSession.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.equal(detail.body.feeSession.calculationOptions.imaging_orders.length, 1);
});

test("does not promote placeholder categories to billing codes", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedSession = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.query === "画像診断") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "170012710",
          name: "胆管・膵管造影（胃・十二指腸ファイバースコピー）（画像診断）",
          points: 1140
        }]
      };
    }
    if (input.query === "医学管理等") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "113023770",
          name: "施設基準不適合減算（医学管理等）（１００分の７０）",
          points: 30
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession) => {
    receivedSession = feeSession;
    const codedOrders = (feeSession.orders || []).filter((order) => order.standardCode);
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: codedOrders.map((order, index) => ({
        lineId: `line_${index + 1}`,
        code: order.standardCode,
        name: order.standardName,
        orderType: order.orderType,
        points: 0,
        quantity: 1,
        totalPoints: 0,
        status: "candidate",
        source: "test"
      })),
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Placeholder Guard"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: "腰椎X線を確認。保存済み候補に画像診断と医学管理等がある。",
    diagnoses: [{ name: "腰痛症" }],
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

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedSession.orders.some((order) => order.standardCode === "170012710"), false);
  assert.equal(receivedSession.orders.some((order) => order.standardCode === "113023770"), false);
  assert.equal(calculation.body.calculationResult.lineItems.some((line) => line.code === "170012710"), false);
  assert.equal(calculation.body.calculationResult.lineItems.some((line) => line.code === "113023770"), false);
});

test("sanitizes previously resolved placeholder codes before calculation", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedSession = null;
  stores.feeCalculator.calculate = async (feeSession) => {
    receivedSession = feeSession;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Sanitize Placeholder"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: "腰椎X線を確認。",
    diagnoses: [{ name: "腰痛症" }],
    orders: [
      {
        orderType: "imaging",
        localName: "画像診断",
        standardCode: "170012710",
        standardName: "胆管・膵管造影（胃・十二指腸ファイバースコピー）（画像診断）",
        quantity: 1
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

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedSession.orders[0].standardCode, undefined);
  assert.equal(receivedSession.orders[0].standardName, undefined);
});

test("rebuilds stale generated calculation options from current clinical context", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Stale Auto Options"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-03",
    clinicalText: [
      "O（Objective：客観的情報）",
      "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化、骨棘形成あり",
      "P（Plan：計画）",
      "MRI腰椎オーダー（次回持参または当院撮影）",
      "2週間後に再診、MRI結果をもとに治療方針を再評価"
    ].join("\n"),
    diagnoses: [{ name: "腰椎椎間板ヘルニア疑い" }]
  }, headers);
  stores.feeStore.updateSession("org_001", session.body.feeSession.feeSessionId, {
    calculationOptions: {
      outpatient_basic: { fee_kind: "revisit" },
      imaging_orders: [
        {
          kind: "mri",
          mri_equipment_kind: "other",
          contrast: false,
          electronic_image_management: true
        },
        {
          kind: "simple_radiography",
          acquisition_kind: "digital",
          radiography_diagnostic_kind: "simple_i",
          electronic_image_management: true
        }
      ]
    },
    calculationOptionsSource: null,
    calculationOptionsAutoKeys: []
  });

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
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI検査は予定・依頼")));
  assert.equal(detail.body.feeSession.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(
    detail.body.feeSession.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.equal(detail.body.feeSession.calculationOptionsSource, "clinical_auto");
  assert.deepEqual(detail.body.feeSession.calculationOptionsAutoKeys.sort(), ["imaging_orders", "outpatient_basic"].sort());
});

test("uses structured clinical facts for calculation input when available", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterItems = {
    "ロキソプロフェン": { kind: "drug", code: "620001001", name: "ロキソプロフェン錠60mg" },
    "レバミピド": { kind: "drug", code: "620001002", name: "レバミピド錠100mg" },
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
      totalPoints: 349,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "2週間後に再診", confidence: "medium" },
    diagnoses: [
      { name: "腰椎椎間板ヘルニア疑い", status: "suspected", evidence: "腰椎椎間板ヘルニア疑い" }
    ],
    billing_events: [
      {
        type: "imaging",
        name: "腰椎X線",
        status: "performed",
        evidence: "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化",
        modality: "simple_radiography",
        body_site: "腰椎",
        dose: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        unit: "",
        frequency: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "imaging",
        name: "MRI腰椎",
        status: "ordered",
        evidence: "MRI腰椎オーダー（次回持参または当院撮影）",
        modality: "mri",
        body_site: "腰椎",
        dose: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        unit: "",
        frequency: "",
        area_size_cm2: "",
        review_reason: "予定・依頼として記載"
      },
      {
        type: "medication",
        name: "ロキソプロフェン",
        status: "prescribed",
        evidence: "ロキソプロフェン60mg 毎食後3錠／14日分処方",
        modality: "none",
        body_site: "",
        dose: "60mg",
        quantity_per_day: "3",
        days: "14",
        total_quantity: "",
        unit: "錠",
        frequency: "毎食後",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "medication",
        name: "レバミピド",
        status: "prescribed",
        evidence: "胃薬併用：レバミピド",
        modality: "none",
        body_site: "",
        dose: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "42",
        unit: "錠",
        frequency: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "medication",
        name: "ロコアテープ",
        status: "prescribed",
        evidence: "湿布処方：ロコアテープ2枚／日",
        modality: "none",
        body_site: "",
        dose: "",
        quantity_per_day: "2",
        days: "",
        total_quantity: "",
        unit: "枚",
        frequency: "",
        area_size_cm2: "",
        review_reason: "日数不足"
      },
      {
        type: "material",
        name: "コルセット",
        status: "instruction_only",
        evidence: "腰椎コルセット装着指導",
        modality: "none",
        body_site: "腰椎",
        dose: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        unit: "",
        frequency: "",
        area_size_cm2: "",
        review_reason: "指導のみ"
      }
    ],
    excluded_events: [],
    missing_information: [
      "空欄",
      "頓服であるが数量（日数/回数/総量）の明記なし"
    ],
    review_flags: [
      "文面から受診回数の明示なし",
      "適応検討のみで実施の記載なし"
    ]
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Structured Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-05",
    clinicalText: [
      "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化",
      "MRI腰椎オーダー（次回持参または当院撮影）",
      "ロキソプロフェン60mg 毎食後3錠／14日分処方（胃薬併用：レバミピド）",
      "湿布処方：ロコアテープ2枚／日",
      "腰椎コルセット装着指導"
    ].join("\n"),
    diagnoses: [{ name: "腰椎椎間板ヘルニア疑い" }]
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(receivedInput.calculationOptions.imaging_orders.map((order) => order.kind), ["simple_radiography"]);
  assert.deepEqual(
    receivedInput.calculationOptions.medication_orders.map((order) => order.drug_code).sort(),
    ["620001001", "620001002"]
  );
  assert.equal(receivedInput.calculationOptions.material_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI腰椎")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("ロコアテープ")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("コルセット")));
});

test("persists structured diagnoses and reviews unsupported extracted events with history-based basic fee", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let receivedSessionContext = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && /CA\s*125|CA125|ＣＡ１２５/u.test(input.query)) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "160038010", name: "ＣＡ１２５" }]
      };
    }
    if (input.type === "procedure" && /(経腟|経膣|超音波)/u.test(input.query)) {
      return {
        query: input.query,
        type: input.type,
        items: [
          { kind: "procedure", code: "160072110", name: "超音波検査（Ａモード法）" },
          { kind: "procedure", code: "160072210", name: "超音波検査（断層撮影法）（胸腹部）" }
        ]
      };
    }
    return {
      query: input.query,
      type: input.type,
      items: []
    };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async ({ sessionContext }) => {
    receivedSessionContext = sessionContext;
    return ({
    visit_type: { kind: "revisit", evidence: "3ヶ月後に再診", confidence: "medium" },
    diagnoses: [
      { name: "月経困難症", status: "confirmed", evidence: "月経困難症" },
      { name: "子宮内膜症疑い", status: "suspected", evidence: "子宮内膜症疑い" },
      { name: "左卵巣嚢胞", status: "suspected", evidence: "左卵巣に嚢胞性病変" },
      { name: "CA125軽度高値", status: "confirmed", evidence: "CA125 68 U/mL" }
    ],
    billing_events: [
      {
        type: "imaging",
        name: "経腟超音波",
        status: "performed",
        evidence: "経腟超音波：左卵巣に約3cm程度の嚢胞性病変",
        modality: "ultrasound",
        review_reason: ""
      },
      {
        type: "lab",
        name: "CA125",
        status: "performed",
        evidence: "血液検査：CA125 68 U/mL",
        modality: "none",
        review_reason: ""
      },
      {
        type: "imaging",
        name: "MRI骨盤部",
        status: "ordered",
        evidence: "MRI骨盤部オーダー（子宮内膜症の範囲評価）",
        modality: "mri",
        review_reason: "予定・依頼"
      },
      {
        type: "medication",
        name: "低用量ピル（ルナベル配合錠LD）",
        status: "prescribed",
        evidence: "低用量ピル処方（ルナベル配合錠LD）",
        modality: "none",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        review_reason: "数量または日数不足"
      },
      {
        type: "medication",
        name: "ロキソプロフェン60mg",
        status: "prescribed",
        evidence: "ロキソプロフェン60mg 月経痛時頓服処方",
        modality: "none",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        review_reason: "数量または日数不足"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
    });
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Gynecology Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    claimMonth: "2026-06",
    clinicalText: [
      "月経困難症、子宮内膜症疑い。",
      "経腟超音波：左卵巣に約3cm程度の嚢胞性病変。",
      "血液検査：CA125 68 U/mL。",
      "MRI骨盤部オーダー（子宮内膜症の範囲評価）。",
      "低用量ピル処方（ルナベル配合錠LD）。",
      "ロキソプロフェン60mg 月経痛時頓服処方。",
      "3ヶ月後に再診、嚢胞サイズ・症状の変化を評価。"
    ].join("\n")
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedSessionContext.billingMonth, "2026-06");
  assert.equal(receivedSessionContext.claimMonth, "2026-06");
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(
    receivedInput.calculationOptions.procedure_codes.sort(),
    ["160038010", "160072210"].sort()
  );
  assert.deepEqual(receivedInput.calculationOptions.lab_options.collection_fee_inputs, ["blood_venous"]);
  assert.deepEqual(receivedInput.calculationOptions.comment_inputs, [{
    code: "820100683",
    text: "超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域"
  }]);
  assert.deepEqual(
    calculation.body.feeSession.diagnoses.map((diagnosis) => diagnosis.name),
    ["月経困難症", "子宮内膜症疑い", "左卵巣嚢胞"]
  );
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("経腟超音波") && warning.includes("標準コードを自動確定")), false);
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("CA125") && warning.includes("マスター候補")), false);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI骨盤部")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("ルナベル")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("ロキソプロフェン")));
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("空欄")), false);
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("文面から受診回数")), false);
  assert.equal(
    calculation.body.calculationResult.warnings.filter((warning) => warning.includes("ロキソプロフェン")).length,
    1
  );
  assert.equal(
    calculation.body.calculationResult.warnings.filter((warning) => /経腟|経膣|超音波/u.test(warning)).length,
    0
  );
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("病名が入力されていません")), false);
});

test("rule-based fallback resolves gynecology lab and ultrasound aliases", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 925,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Fallback Gynecology"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: [
      "O（Objective：客観的情報）",
      "経腟超音波：ダグラス窩に少量の液体貯留、左卵巣に約3cm程度の嚢胞性病変。",
      "血液検査：CA125 68 U/mL（基準値35以下）。",
      "P（Plan：計画）",
      "MRI骨盤部オーダー（子宮内膜症の範囲評価）。"
    ].join("\n")
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSessionId || session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(
    receivedInput.calculationOptions.procedure_codes.sort(),
    ["160038010", "160072210"].sort()
  );
  assert.deepEqual(receivedInput.calculationOptions.lab_options.collection_fee_inputs, ["blood_venous"]);
  assert.deepEqual(receivedInput.calculationOptions.comment_inputs, [{
    code: "820100683",
    text: "超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域"
  }]);
});

test("infers revisit basic fee from prior patient fee sessions", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 75,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "History Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "腰痛症" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "下腹部痛で受診。",
    diagnoses: [{ name: "月経困難症" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("過去病名と今回病名")));
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.patientHistory.priorSessionCount, 1);
});

test("counts same-day existing patient sessions as patient history for basic fee", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 75,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Same Day Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    diagnoses: [{ name: "月経困難症" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "月経困難症で受診。",
    diagnoses: [{ name: "月経困難症" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.patientHistory.priorSessionCount, 1);
});

test("replaces stale auto diagnoses and resolves chronic diabetes clinical facts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 700,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [
      { name: "2型糖尿病", status: "confirmed", evidence: "2型糖尿病" },
      { name: "糖尿病性腎症第2期", status: "suspected", evidence: "微量アルブミン尿" },
      { name: "高血圧症", status: "confirmed", evidence: "高血圧合併" },
      { name: "脂質異常症", status: "confirmed", evidence: "脂質異常症合併" }
    ],
    billing_events: [
      { type: "lab", name: "HbA1c", status: "performed", evidence: "HbA1c：7.8%", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "lab", name: "LDLコレステロール", status: "performed", evidence: "LDL：132mg/dL", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "lab", name: "中性脂肪", status: "performed", evidence: "TG：168mg/dL", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "lab", name: "クレアチニン", status: "performed", evidence: "eGFR：62mL/min/1.73m²", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "lab", name: "尿アルブミン", status: "performed", evidence: "尿アルブミン：42mg/gCr", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "management", name: "糖尿病合併症管理料", status: "performed", evidence: "糖尿病合併症管理料算定、療養計画書を説明・署名取得", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Diabetes Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "2型糖尿病" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: [
      "HbA1c：7.8%。LDL：132mg/dL、TG：168mg/dL。",
      "eGFR：62mL/min/1.73m²。尿アルブミン：42mg/gCr。",
      "2型糖尿病、糖尿病性腎症第2期、高血圧合併、脂質異常症合併。",
      "糖尿病合併症管理料算定、療養計画書を患者に説明・署名取得。"
    ].join("\n"),
    diagnoses: [{ name: "月経困難症" }],
    diagnosesSource: "clinical_auto"
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.deepEqual(
    receivedInput.calculationOptions.procedure_codes.sort(),
    ["113010010", "160004810", "160010010", "160019210", "160020910", "160167250"].sort()
  );
  assert.deepEqual(receivedInput.calculationOptions.lab_options.collection_fee_inputs, ["blood_venous"]);
  assert.deepEqual(
    calculation.body.feeSession.diagnoses.map((diagnosis) => diagnosis.name),
    ["2型糖尿病", "糖尿病性腎症第2期", "高血圧症", "脂質異常症"]
  );
  assert.equal(
    calculation.body.feeSession.diagnoses.some((diagnosis) => diagnosis.name === "月経困難症"),
    false
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("糖尿病合併症管理料")));
});

test("proposes dermatology chronic management and objective allergy labs without noisy medication warnings", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterItems = {
    "皮膚科特定疾患指導管理料": [{
      kind: "procedure",
      code: "113999001",
      name: "皮膚科特定疾患指導管理料（II）",
      points: 100,
      sourceType: "medical_procedure_master"
    }],
    "皮膚科特定疾患": [{
      kind: "procedure",
      code: "113999001",
      name: "皮膚科特定疾患指導管理料（II）",
      points: 100,
      sourceType: "medical_procedure_master"
    }],
    "非特異的ＩｇＥ": [{
      kind: "procedure",
      code: "160999001",
      name: "非特異的ＩｇＥ",
      points: 110,
      sourceType: "medical_procedure_master"
    }],
    IgE: [{
      kind: "procedure",
      code: "160999001",
      name: "非特異的ＩｇＥ",
      points: 110,
      sourceType: "medical_procedure_master"
    }],
    "好酸球": [{
      kind: "procedure",
      code: "160999002",
      name: "好酸球",
      points: 15,
      sourceType: "medical_procedure_master"
    }],
    "末梢血液像": [{
      kind: "procedure",
      code: "160999002",
      name: "好酸球",
      points: 15,
      sourceType: "medical_procedure_master"
    }]
  };
  stores.feeCalculator.searchMaster = async (input) => ({
    query: input.query,
    type: input.type,
    items: masterItems[input.query] || []
  });
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 75,
      lineItems: [{
        lineId: "basic_revisit",
        code: "112007410",
        name: "再診料",
        orderType: "basic",
        points: 75,
        quantity: 1,
        totalPoints: 75,
        status: "candidate",
        source: "outpatient_basic_fee",
        reviewRequired: true
      }],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [
      { name: "アトピー性皮膚炎", status: "confirmed", evidence: "アトピー性皮膚炎、中等症" }
    ],
    billing_events: [
      { type: "lab", name: "IgE", status: "performed", evidence: "IgE：680 IU/mL", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "lab", name: "好酸球", status: "performed", evidence: "好酸球：520/μL", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "management", name: "スキンケア指導", status: "performed", evidence: "保湿剤を朝晩塗るよう再指導、入浴指導", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" },
      { type: "counseling", name: "デュピクセント説明", status: "performed", evidence: "適応・費用・投与方法を本日説明", modality: "none", body_site: "", quantity_per_day: "", days: "", total_quantity: "", area_size_cm2: "", review_reason: "" }
    ],
    excluded_events: [
      { type: "medication", name: "塗布再指導", status: "history", evidence: "保湿剤を朝晩塗るよう再指導", reason: "指導" }
    ],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Derm Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "アトピー性皮膚炎" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: [
      "アトピー性皮膚炎、中等症。IgE：680 IU/mL、好酸球：520/μL。",
      "外用薬の部位別使い分け、保湿、スキンケア、入浴指導を実施。",
      "デュピクセントの適応・費用・投与方法を本日説明。"
    ].join("\n")
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const proposal = calculation.body.candidateWorkbench.proposals.find((item) => (
    item.displayTitle.includes("皮膚科")
  ));
  assert.ok(proposal);
  const adopted = await request(
    stores,
    "PATCH",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/review-items/${encodeURIComponent(proposal.reviewItemId)}`,
    { status: "approved", note: "条件確認済み" },
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.deepEqual(
    receivedInput.calculationOptions.procedure_codes.sort(),
    ["160999001", "160999002"].sort()
  );
  assert.equal(proposal.canAdopt, true);
  assert.equal(proposal.potentialPoints, 100);
  assert.equal(calculation.body.candidateWorkbench.potentialPointsTotal, 100);
  assert.equal(
    calculation.body.calculationResult.warnings.some((warning) => warning.includes("塗布再指導")),
    false
  );
  assert.equal(adopted.statusCode, 200);
  assert.equal(adopted.body.receiptDraft.totalPoints, 175);
});

test("merges deterministic performed imaging when structured facts miss it", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 210,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [],
    billing_events: [
      {
        type: "imaging",
        name: "MRI腰椎",
        status: "ordered",
        evidence: "MRI腰椎オーダー（次回持参または当院撮影）",
        modality: "mri",
        body_site: "腰椎",
        dose: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        unit: "",
        frequency: "",
        area_size_cm2: "",
        review_reason: "予定・依頼"
      }
    ],
    excluded_events: [
      {
        type: "imaging",
        name: "MRI腰椎",
        status: "ordered",
        evidence: "MRI腰椎オーダー（次回持参または当院撮影）",
        reason: "予定・依頼"
      }
    ],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Structured Miss Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-05",
    clinicalText: [
      "O（Objective：客観的情報）",
      "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化、骨棘形成あり",
      "P（Plan：計画）",
      "MRI腰椎オーダー（次回持参または当院撮影）",
      "2週間後に再診、MRI結果をもとに治療方針を再評価"
    ].join("\n"),
    diagnoses: [{ name: "腰椎椎間板ヘルニア疑い" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI腰椎")));
});

test("supplements structured facts only from objective findings", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 680,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [
      { name: "脳梗塞疑い", status: "suspected", evidence: "左中大脳動脈領域脳梗塞" }
    ],
    billing_events: [],
    excluded_events: [
      {
        type: "imaging",
        name: "頭部MRI・MRA",
        status: "ordered",
        evidence: "頭部MRI・MRA緊急撮影",
        reason: "計画欄の撮影予定"
      }
    ],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Stroke Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: [
      "O（Objective：客観的情報）",
      "頭部CT：明らかな出血なし、早期虚血変化あり（左MCA領域）",
      "血液検査：血糖142mg/dL",
      "A（Assessment：評価）",
      "左中大脳動脈領域脳梗塞（急性期）",
      "P（Plan：計画）",
      "頭部MRI・MRA緊急撮影（DWI・FLAIR）"
    ].join("\n")
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind),
    ["ct"]
  );
  assert.equal(
    receivedInput.calculationOptions.imaging_orders.some((order) => order.kind === "mri"),
    false
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("頭部MRI")));
});

test("records fee calculation progress and split clinical structuring metrics", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let extractorInput = null;
  let progressDuringCalculation = null;
  stores.feeCalculator.calculate = async (feeSession) => {
    progressDuringCalculation = stores.feeStore.getSession(feeSession.orgId, feeSession.feeSessionId).calculationProgress;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 288,
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
  const clinicalFactsExtractor = async (input) => {
    extractorInput = input;
    return {
      visit_type: { kind: "initial", evidence: "初診", confidence: "high" },
      diagnoses: [{ name: "腰痛症", status: "suspected", evidence: "腰痛" }],
      billing_events: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Progress Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-05",
    clinicalText: "腰痛で初診。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(extractorInput.reasoningEffort, "low");
  assert.equal(progressDuringCalculation.phase, "calculate");
  assert.ok(progressDuringCalculation.percent >= 50);
  assert.equal(calculation.body.feeSession.calculationProgress.phase, "complete");
  assert.equal(calculation.body.feeSession.calculationProgress.totalPoints, 288);
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.source, "openai");
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.reasoningEffort, "low");
  assert.equal(typeof calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.openAiProviderDurationMs, "number");
  assert.equal(typeof calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.clinicalFactsConvertDurationMs, "number");
  assert.equal(typeof calculation.body.feeSession.calculationProgress.metrics.ruleBasedClinicalInference.durationMs, "number");
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

test("normalizes internal calculator warnings before returning review output", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 0,
    lineItems: [],
    warnings: [
      "Lab management fee skipped: facility_standard_not_found",
      "hospital_profile_missing: 施設基準がないため検体検査管理加算は自動追加しない",
      "D026 judgement fee for group 3",
      "Collection fee requested by blood_venous",
      "Medication fee candidate for in_house"
    ]
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Warning Normalize Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "血液検査を実施。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => /Lab management|D026|Collection fee|Medication fee/i.test(warning)), false);
  assert.equal(
    calculation.body.calculationResult.warnings.filter((warning) => warning.includes("施設基準")).length,
    1
  );
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "検査判断料の確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "採血料の確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "投薬料の確認"));
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
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.equal(detail.body.feeSession.calculationOptionsSource, "manual");
  assert.deepEqual(detail.body.feeSession.calculationOptionsAutoKeys, []);
});

test("clears stale clinical-auto diagnoses when clinical text changes", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Clinical Reset Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "月経困難症。経腟超音波を実施。",
    diagnoses: [{ name: "月経困難症" }],
    diagnosesSource: "clinical_auto",
    diagnosesClinicalTextHash: "old_hash"
  }, headers);

  const updated = await request(stores, "PATCH", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}`, {
    clinicalText: "2型糖尿病。HbA1cを確認し、療養計画書を説明した。",
    diagnoses: [{ name: "月経困難症" }],
    diagnosesSource: "clinical_auto"
  }, headers);

  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.body.feeSession.diagnoses, []);
  assert.equal(updated.body.feeSession.diagnosesSource, "clinical_auto");
  assert.notEqual(updated.body.feeSession.diagnosesClinicalTextHash, "old_hash");
});

test("clears carried-over manual diagnoses when clinical text is replaced", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Manual Diagnosis Carryover"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-07",
    clinicalText: "S: 咳と鼻水。A: 急性上気道炎疑い",
    diagnoses: [{ name: "急性上気道炎疑い" }],
    diagnosesSource: "manual"
  }, headers);

  const patched = await request(stores, "PATCH", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}`, {
    clinicalText: [
      "A（Assessment：評価）",
      "季節性アレルギー性鼻炎（スギ・ヒノキ花粉症）",
      "アレルギー性結膜炎合併"
    ].join("\n"),
    diagnoses: [{ name: "急性上気道炎疑い" }],
    diagnosesSource: "manual"
  }, headers);

  assert.equal(patched.statusCode, 200);
  assert.deepEqual(patched.body.feeSession.diagnoses, []);
  assert.equal(patched.body.feeSession.diagnosesSource, "clinical_auto");
});

test("does not propose chronic management fee from past history only", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => {
    if (String(input.query || "").includes("特定疾患療養管理料")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "113000001", name: "特定疾患療養管理料", points: 225 }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "2週間後に再診", confidence: "medium" },
    diagnoses: [
      { name: "季節性アレルギー性鼻炎", status: "active", evidence: "季節性アレルギー性鼻炎" },
      { name: "アレルギー性結膜炎", status: "active", evidence: "アレルギー性結膜炎" }
    ],
    billing_events: [
      {
        type: "counseling",
        name: "アレルゲン免疫療法の説明",
        status: "performed",
        evidence: "適応・効果・期間について説明",
        review_reason: ""
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Allergy Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-07",
    clinicalText: [
      "既往歴：小児期に軽度の気管支喘息（現在は無症状）",
      "A: 季節性アレルギー性鼻炎、アレルギー性結膜炎",
      "P: アレルゲン免疫療法の適応・効果・期間について説明"
    ].join("\n")
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  const proposals = calculation.body.calculationResult.candidateProposals || [];
  assert.equal(proposals.some((proposal) => String(proposal.title || "").includes("特定疾患療養管理料")), false);
});

test("builds allergy test master hints by test type", () => {
  assert.deepEqual(
    procedureHintQueries("血液検査：IgE 412 IU/mL"),
    ["非特異的ＩｇＥ", "IgE"]
  );
  assert.ok(procedureHintQueries("特異的IgE：スギ クラス4、ヒノキ クラス3").includes("特異的ＩｇＥ"));
  assert.ok(procedureHintQueries("皮膚プリックテスト：スギ（+++）、ヒノキ（++）").includes("皮膚反応検査"));
});

test("patient history overrides structured initial visit inference", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 75,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", evidence: "初診として来院", confidence: "high" },
    diagnoses: [{ name: "糖尿病", status: "confirmed", evidence: "糖尿病" }],
    billing_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "History Override Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "糖尿病" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "初診として来院。糖尿病の継続管理。",
    diagnoses: [{ name: "糖尿病" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${current.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("再診料候補を優先")));
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
    async browseMaster(input) {
      return {
        type: input.type,
        query: input.query,
        page: input.page,
        pageSize: input.pageSize,
        totalCount: 1,
        totalPages: 1,
        items: [{
          kind: "procedure",
          code: "111000110",
          name: "初診料",
          points: 291,
          sourceVersion: "test-master"
        }],
        sources: [{
          sourceType: "medical_procedure_master",
          sourceVersion: "test-master",
          rowCount: 1
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

async function signedBearerHeaders(platformStore) {
  const identity = platformStore.getLoginIdentity("clinic", "admin@example.com");
  const { token } = createSignedSession({
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
    authorization: `Bearer ${token}`
  };
}

function request(stores, method, path, body, headers = {}, overrides = {}) {
  return handleFeeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    feeStore: stores.feeStore,
    feeCalculator: stores.feeCalculator,
    env: overrides.env || "test",
    clinicalFactsExtractor: overrides.clinicalFactsExtractor,
    openAiApiKey: overrides.openAiApiKey,
    openAiFeeClinicalModel: overrides.openAiFeeClinicalModel,
    openAiFeeClinicalReasoningEffort: overrides.openAiFeeClinicalReasoningEffort,
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-28T00:00:00.000Z"),
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
}
