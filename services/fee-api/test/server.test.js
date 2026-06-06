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
    ["620001001", "620001002"]
  );
  assert.equal(receivedInput.calculationOptions.medication_orders.some((order) => order.drug_code === "620001003"), false);
  assert.equal(receivedInput.calculationOptions.material_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI")));
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
  assert.equal(receivedInput.calculationOptions.outpatient_basic, undefined);
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI検査は予定・依頼")));
  assert.equal(detail.body.feeSession.calculationOptions.outpatient_basic, undefined);
  assert.deepEqual(
    detail.body.feeSession.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.equal(detail.body.feeSession.calculationOptionsSource, "clinical_auto");
  assert.deepEqual(detail.body.feeSession.calculationOptionsAutoKeys, ["imaging_orders"]);
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
    missing_information: [],
    review_flags: []
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
  assert.equal(receivedInput.calculationOptions.outpatient_basic, undefined);
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
  assert.equal(receivedInput.calculationOptions.outpatient_basic, undefined);
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.kind),
    ["simple_radiography"]
  );
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI腰椎")));
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
  assert.equal(extractorInput.reasoningEffort, "minimal");
  assert.equal(progressDuringCalculation.phase, "calculate");
  assert.ok(progressDuringCalculation.percent >= 50);
  assert.equal(calculation.body.feeSession.calculationProgress.phase, "complete");
  assert.equal(calculation.body.feeSession.calculationProgress.totalPoints, 288);
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.source, "openai");
  assert.equal(calculation.body.feeSession.calculationProgress.metrics.clinicalStructuring.reasoningEffort, "minimal");
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
