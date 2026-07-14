import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { buildClinicalChecklistMenu } from "../src/clinical-calculation-input.js";
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
  const batchDecision = await request(
    stores,
    "PATCH",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/review-items`,
    {
      decisions: [
        { reviewItemId: reviewItems.body.reviewItems[0].reviewItemId, status: "approved" }
      ]
    },
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
  assert.equal(batchDecision.statusCode, 200);
  assert.equal(batchDecision.body.feeSession.reviewDecisions[reviewItems.body.reviewItems[0].reviewItemId].status, "approved");
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
  assert.ok(auditEvents.some((event) => event.eventType === "fee.review_items_decided"));
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

test("loads facility standards from Platform facility profile during calculation", async () => {
  const stores = createStores({ facilityStandardKeys: ["検体検査管理加算2"] });
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
    displayName: "Facility Profile Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: 尿検査を実施。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.facility_standard_keys, ["検体検査管理加算2"]);
  assert.ok(calculation.body.feeSession.calculationOptionsAutoKeys.includes("facility_standard_keys"));
});

test("traces facility imaging attributes applied to imaging orders", async () => {
  const stores = createStores({
    facilityStandardKeys: ["画像電子管理", "CT機器区分:multislice_16_to_64"]
  });
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", evidence: "初診", confidence: "medium" },
    diagnoses: [{ name: "頭部打撲", status: "confirmed", evidence: "頭部打撲" }],
    clinical_events: [{
      type: "imaging",
      name: "頭部CT",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence: "頭部CTを実施し、急性期出血なし。",
      search_queries: ["頭部CT"],
      modality: "ct"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Facility Imaging Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 頭部CTを実施し、急性期出血なし。"
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
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].electronic_image_management, true);
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].ct_equipment_kind, "multislice_16_to_64");
  const facilityTrace = calculation.body.calculationResult.clinicalExtraction.trace.find((item) => item.stage === "facility_imaging_profile");
  assert.equal(facilityTrace.selected.facilityElectronicImageManagement, true);
  assert.equal(facilityTrace.selected.orderElectronicImageManagement, true);
  assert.equal(facilityTrace.selected.orderCtEquipmentKind, "multislice_16_to_64");
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
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].projection_count, 2);
  assert.equal(receivedInput.calculationOptions.medication_orders, undefined);
  assert.equal(receivedInput.calculationOptions.material_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("レバミピド")));
  assert.equal(
    calculation.body.calculationResult.warnings.some((warning) => warning.includes("コルセット")),
    false
  );
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("オーダー「画像診断」")), false);
  assert.equal(detail.body.feeSession.calculationOptions.outpatient_basic.fee_kind, "initial");
  assert.equal(detail.body.feeSession.calculationOptions.imaging_orders.length, 1);
  assert.equal(detail.body.feeSession.calculationOptions.imaging_orders[0].projection_count, 2);
});

test("structured inpatient sessions suppress outpatient basic and infer inpatient basic fee", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      engineStatus: "ok",
      totalPoints: 1688,
      lineItems: [{
        lineId: "line_inpatient_basic",
        code: calculationInput.calculationOptions.inpatient_basic.basic_fee_code,
        name: "急性期一般入院料１",
        orderType: "inpatient_basic",
        points: 1688,
        quantity: calculationInput.calculationOptions.inpatient_basic.basic_fee_days,
        totalPoints: 1688,
        status: "candidate",
        source: "inpatient_basic_fee",
        reviewRequired: true
      }],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", evidence: "初診として入院", confidence: "high" },
    diagnoses: [{ name: "肺炎", status: "active", evidence: "肺炎で入院" }],
    billing_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Inpatient Structured"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    setting: "inpatient",
    serviceDate: "2026-06-05",
    clinicalText: "肺炎で入院。急性期一般入院料1として2日分を明示。初診として入院管理を開始した。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
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
  assert.deepEqual(receivedInput.calculationOptions.inpatient_basic, {
    basic_fee_code: "190117710",
    basic_fee_days: 2,
    facility_standard_key: "一般入院"
  });
  assert.deepEqual(receivedInput.calculationOptions.facility_standard_keys, ["一般入院"]);
  assert.equal(calculation.body.calculationResult.totalPoints, 1688);
  assert.deepEqual(
    detail.body.feeSession.calculationOptionsAutoKeys.sort(),
    ["facility_standard_keys", "inpatient_basic"].sort()
  );
  assert.ok(detail.body.feeSession.calculationProgress.extractedOrders.includes("入院基本料候補 2日分"));
});

test("rule based inpatient sessions infer inpatient basic without outpatient basic", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      engineStatus: "ok",
      totalPoints: 1688,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Inpatient Rules"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    setting: "inpatient",
    serviceDate: "2026-06-05",
    clinicalText: "肺炎で入院1日目。急性期一般入院料1で管理。初診時から継続して病棟で全身状態を観察。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic, undefined);
  assert.deepEqual(receivedInput.calculationOptions.inpatient_basic, {
    basic_fee_code: "190117710",
    basic_fee_days: 1,
    facility_standard_key: "一般入院"
  });
  assert.deepEqual(receivedInput.calculationOptions.facility_standard_keys, ["一般入院"]);
});

test("DPC inpatient sessions do not auto infer fee-for-service inpatient basic", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      engineStatus: "needs_review",
      totalPoints: 0,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "DPC Inpatient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    setting: "inpatient",
    serviceDate: "2026-06-05",
    clinicalText: "肺炎で入院3日目。DPC対象病院で管理中。当日確認した主な診療内容は「急性期一般入院料1、DPCレビュー」。"
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
  assert.equal(receivedInput.calculationOptions?.inpatient_basic, undefined);
  assert.equal(receivedInput.calculationOptions?.facility_standard_keys, undefined);
  assert.equal(detail.body.feeSession.calculationOptionsAutoKeys.includes("inpatient_basic"), false);
  assert.equal(detail.body.feeSession.calculationProgress.extractedOrders.includes("入院基本料候補 3日分"), false);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("DPCレビュー")));
});

test("missing setting with negated inpatient context remains outpatient", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      engineStatus: "ok",
      totalPoints: 288,
      lineItems: [],
      warnings: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Outpatient Missing Setting"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-06-05",
    clinicalText: "発熱と咽頭痛で初診。全身状態は安定しており、入院適応は低い。外来で経過観察とした。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers
  );

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions?.inpatient_basic, undefined);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "initial");
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

test("merges deterministic CT attributes into structured imaging event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 1095,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "頭部外傷", status: "suspected", evidence: "頭部外傷" }],
    clinical_events: [{
      type: "imaging",
      billing_domain: "standard_imaging",
      name: "頭部CT",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence: "頭部CT撮影を実施。",
      search_queries: ["頭部CT"],
      modality: "ct",
      body_site: "頭部",
      specimen: "",
      collection_method: "",
      quantity_per_day: "",
      days: "",
      total_quantity: "",
      area_size_cm2: "",
      review_reason: ""
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "CT Merge Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: [
      "O（Objective：客観的情報）",
      "CT撮影を実施し、16列以上64列未満マルチスライス型機器、電子保存あり、造影なしを確認した。"
    ].join("\n"),
    diagnoses: [{ name: "頭部外傷" }]
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
  assert.deepEqual(receivedInput.calculationOptions.imaging_orders, [{
    kind: "ct",
    contrast: false,
    electronic_image_management: true,
    ct_equipment_kind: "multislice_16_to_64"
  }]);
});

test("does not treat absent or unknown electronic image management as present", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 560,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = (evidence) => async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "頭部外傷", status: "suspected", evidence: "頭部外傷" }],
    clinical_events: [{
      type: "imaging",
      billing_domain: "standard_imaging",
      name: "頭部CT",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence,
      search_queries: ["頭部CT"],
      modality: "ct",
      body_site: "頭部"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Electronic Image Management Guard Patient"
  }, headers);
  const absent = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O（Objective：客観的情報）\n頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子画像管理なし。",
    diagnoses: [{ name: "頭部外傷" }]
  }, headers);
  let calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${absent.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor: clinicalFactsExtractor("頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子画像管理なし。") }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].electronic_image_management, undefined);

  receivedInput = null;
  const unknown = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-11",
    clinicalText: "O（Objective：客観的情報）\n頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子画像管理の有無を確認。",
    diagnoses: [{ name: "頭部外傷" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${unknown.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor: clinicalFactsExtractor("頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子画像管理の有無を確認。") }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].electronic_image_management, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("電子保存確認")));

  receivedInput = null;
  const chartLevelUnknown = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-12",
    clinicalText: [
      "O（Objective：客観的情報）",
      "頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。",
      "画像データの保存状況は診療録本文には残っていない。"
    ].join("\n"),
    diagnoses: [{ name: "頭部外傷" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${chartLevelUnknown.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor: clinicalFactsExtractor("頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。") }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].electronic_image_management, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("電子保存確認")));

  receivedInput = null;
  const externalStorage = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-13",
    clinicalText: [
      "O（Objective：客観的情報）",
      "頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。",
      "過去の他院画像は本人の説明のみで、画像データは持参されていない。"
    ].join("\n"),
    diagnoses: [{ name: "頭部外傷" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${externalStorage.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor: clinicalFactsExtractor("頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。") }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].electronic_image_management, undefined);
  assert.ok(!calculation.body.calculationResult.warnings.some((warning) => warning.includes("電子保存確認")));
});

test("keeps conflicting same-kind imaging orders separate", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 1120,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "頭部外傷", status: "suspected", evidence: "頭部外傷" }],
    clinical_events: [
      {
        type: "imaging",
        billing_domain: "standard_imaging",
        name: "頭部CT",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "normal",
        certainty: "explicit",
        section: "O",
        evidence: "頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子保存あり。造影なし。",
        search_queries: ["頭部CT"],
        modality: "ct",
        body_site: "頭部"
      },
      {
        type: "imaging",
        billing_domain: "standard_imaging",
        name: "腹部造影CT",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "abnormal",
        certainty: "explicit",
        section: "O",
        evidence: "腹部造影CT撮影を実施。16列以上64列未満マルチスライス型機器。電子保存あり。造影剤使用。",
        search_queries: ["腹部造影CT"],
        modality: "ct",
        body_site: "腹部"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Same Kind Imaging Conflict Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: [
      "O（Objective：客観的情報）",
      "頭部CT撮影を実施。16列以上64列未満マルチスライス型機器。電子保存あり。造影なし。",
      "腹部造影CT撮影を実施。16列以上64列未満マルチスライス型機器。電子保存あり。造影剤使用。"
    ].join("\n"),
    diagnoses: [{ name: "頭部外傷" }]
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
  assert.equal(receivedInput.calculationOptions.imaging_orders.length, 2);
  assert.deepEqual(
    receivedInput.calculationOptions.imaging_orders.map((order) => order.contrast).sort(),
    [false, true]
  );
});

test("emits contrast review when chart-level contrast uncertainty is separate from CT event evidence", async () => {
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "腹痛", status: "suspected", evidence: "腹痛" }],
    clinical_events: [{
      type: "imaging",
      billing_domain: "standard_imaging",
      name: "腹部CT",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence: "本日、腹部CTを施行。虫垂腫大は明らかでない。",
      search_queries: ["腹部CT"],
      modality: "ct",
      body_site: "腹部"
    }],
    checklist_findings: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Chart Level Contrast Review Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: [
      "O: 本日、腹部CTを施行。虫垂腫大は明らかでない。",
      "造影の有無は撮影実施記録で見直す。"
    ].join("\n"),
    diagnoses: [{ name: "腹痛" }]
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
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].contrast, false);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "contrast_check"
    && /造影/u.test(issue.messageForStaff)
  )));
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
    clinical_events: [
      {
        type: "imaging",
        name: "腰椎X線",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "abnormal",
        certainty: "explicit",
        section: "O",
        evidence: "腰椎X線（正面・側面）：L4/5椎間板スペース軽度狭小化",
        search_queries: ["腰椎X線"],
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
        action_status: "ordered",
        temporal_relation: "future",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "MRI腰椎オーダー（次回持参または当院撮影）",
        search_queries: ["MRI腰椎"],
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
        action_status: "prescribed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "ロキソプロフェン60mg 毎食後3錠／14日分処方",
        search_queries: ["ロキソプロフェン"],
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
        action_status: "prescribed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "胃薬併用：レバミピド",
        search_queries: ["レバミピド"],
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
        action_status: "prescribed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "湿布処方：ロコアテープ2枚／日",
        search_queries: ["ロコアテープ"],
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
        action_status: "instruction_only",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "腰椎コルセット装着指導",
        search_queries: ["コルセット"],
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
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].projection_count, 2);
  assert.deepEqual(
    receivedInput.calculationOptions.medication_orders.map((order) => order.drug_code).sort(),
    ["620001001", "620001002"]
  );
  assert.equal(receivedInput.calculationOptions.material_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI腰椎")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("ロコアテープ")));
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("コルセット")));
  assert.equal(calculation.body.calculationResult.clinicalExtraction.promptVersion, "fee-clinical-events-v14");
  assert.equal(calculation.body.calculationResult.clinicalExtraction.ruleSetVersion, "fee-clinical-rules-v10");
  assert.ok(calculation.body.calculationResult.clinicalEvents.some((event) => (
    event.name === "腰椎X線"
    && event.actionStatus === "performed"
    && event.temporalRelation === "current_visit"
  )));
  assert.ok(calculation.body.calculationResult.masterCandidates.some((candidate) => candidate.masterCode === "620001001"));
  assert.ok(calculation.body.calculationResult.billingCandidates.some((candidate) => candidate.code === "620001001"));
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.messageForStaff.includes("コルセット")));
});

test("prioritizes medication total quantity review only in medication context", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 75,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "皮膚炎", status: "suspected", evidence: "皮膚炎" }],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "外用薬総量確認",
        action_status: "planned",
        temporal_relation: "future",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "外用ステロイドを1日1回で短期使用する方針を説明したが、本文にはチューブ本数やg数が残っていない。処方内容の総量は薬剤記録と照合してから確定する。",
        search_queries: [],
        review_reason: "処方総量の確認が必要"
      },
      {
        type: "counseling",
        billing_domain: "standard_management",
        name: "チューブ訓練",
        action_status: "instruction_only",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "P",
        evidence: "肩関節の可動域維持として自宅でのチューブ訓練を紹介した。",
        search_queries: [],
        review_reason: "セルフケア指導"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Medication Total Quantity Review Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: [
      "P: 外用ステロイドを1日1回で短期使用する方針を説明したが、本文にはチューブ本数やg数が残っていない。",
      "処方内容の総量は薬剤記録と照合してから確定する。",
      "肩関節の可動域維持として自宅でのチューブ訓練を紹介した。"
    ].join("\n"),
    diagnoses: [{ name: "皮膚炎" }]
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
  const totalQuantityIssues = calculation.body.calculationResult.reviewIssues
    .filter((issue) => issue.topicLabel === "総量不足");
  assert.ok(totalQuantityIssues.length >= 1);
  assert.ok(totalQuantityIssues.some((issue) => /外用薬|外用ステロイド|総量/u.test(issue.messageForStaff)));
  assert.ok(!totalQuantityIssues.some((issue) => /チューブ訓練/u.test(issue.messageForStaff)));
});

test("gates lab master search to direct lab test items and records trace", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "ＣＲＰ") {
      return {
        query: input.query,
        type: input.type,
        items: [
          {
            kind: "procedure",
            code: "160061910",
            name: "生化学的検査（１）判断料",
            points: 144,
            feeCategory: "lab_judgment",
            itemRole: "judgment",
            directRetrievalAllowed: false
          },
          {
            kind: "procedure",
            code: "160000001",
            name: "ＣＲＰ",
            points: 16,
            feeCategory: "lab_test_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          }
        ]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "発熱", status: "confirmed", evidence: "発熱" }],
    clinical_events: [
      {
        type: "lab",
        name: "ＣＲＰ",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "numeric",
        certainty: "explicit",
        section: "O",
        evidence: "静脈採血を行い、ＣＲＰ 0.3 mg/dLを確認",
        search_queries: ["ＣＲＰ"]
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: ["NSAIDs注意"]
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Lab Gate Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-09",
    clinicalText: "O: 静脈採血を行い、ＣＲＰ 0.3 mg/dLを確認",
    diagnoses: [{ name: "発熱" }]
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
  assert.equal(masterSearches.some((input) => input.type === "procedure" && input.query === "ＣＲＰ"), true);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160000001"]);
  assert.deepEqual(receivedInput.calculationOptions.lab_options.collection_fee_inputs, ["blood_venous"]);
  assert.equal(
    calculation.body.calculationResult.masterCandidates.some((candidate) => candidate.masterCode === "160061910"),
    false
  );
  assert.ok(calculation.body.calculationResult.masterCandidates.some((candidate) => (
    candidate.masterCode === "160000001"
    && candidate.feeCategory === "lab_test_basic"
    && candidate.directRetrievalAllowed === true
  )));
  const trace = calculation.body.calculationResult.clinicalExtraction.trace;
  assert.ok(trace.some((item) => (
    item.stage === "master_search"
    && item.outcome === "matched"
    && item.searches.some((search) => search.filteredCandidates.some((candidate) => candidate.code === "160061910"))
  )));
  assert.ok(trace.some((item) => item.stage === "lab_rule_expansion"));
  assert.ok(trace.some((item) => (
    item.stage === "clinical_fact_review_flag_suppressed"
    && item.warning === "NSAIDs注意"
  )));
});

test("skips routine vital observation master search and avoids noisy query modifiers", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return {
      query: input.query,
      type: input.type,
      items: []
    };
  };
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 0,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [
      {
        clinical_event_id: "ce_spo2",
        type: "exam",
        name: "SpO2測定",
        action_status: "performed",
        temporal_relation: "current_visit",
        provider_ownership: "own_clinic",
        source_origin: "own_clinic_record",
        evidence: "SpO2 98%(室内気)",
        search_queries: ["SpO2測定"],
        modality: "none",
        body_site: ""
      },
      {
        clinical_event_id: "ce_visual_acuity",
        type: "exam",
        name: "右眼視力測定",
        action_status: "performed",
        temporal_relation: "current_visit",
        provider_ownership: "own_clinic",
        source_origin: "own_clinic_record",
        evidence: "右眼視力測定を実施。",
        search_queries: ["視力測定"],
        modality: "none",
        body_site: "右眼"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Routine Observation Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: SpO2 98%(室内気)。右眼視力測定を実施。",
    diagnoses: [{ name: "視力低下" }]
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
  assert.equal(masterSearches.some((input) => /SpO2|spo2/u.test(String(input.query || ""))), false);
  assert.equal(masterSearches.some((input) => /^none\s/u.test(String(input.query || ""))), false);
  assert.equal(masterSearches.some((input) => String(input.query || "").includes("右眼右眼")), false);
  assert.equal(masterSearches.some((input) => input.query === "右眼視力測定"), true);
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "non_billable_observation_skip"
    && item.eventName === "SpO2測定"
  )));
});

test("does not auto-code lab concepts that only appear in LLM search queries", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return {
      query: input.query,
      type: input.type,
      items: [{
        kind: "procedure",
        code: "160054710",
        name: "ＣＲＰ",
        points: 16,
        feeCategory: "lab_test_basic",
        itemRole: "base",
        directRetrievalAllowed: true
      }]
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "血液検査",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "unknown",
        certainty: "ambiguous",
        section: "O",
        evidence: "静脈採血を行い、検体提出した。",
        search_queries: ["ＣＲＰ"]
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Lab Query Guard Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-09",
    clinicalText: "O: 静脈採血を行い、検体提出した。"
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((input) => input.query === "ＣＲＰ"), false);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicCode === "lab_code_check"));
});

test("prefers exact master name over modifier siblings when modifier is not in the chart", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && input.query === "ＣＲＰ") {
      return {
        query: input.query,
        type: input.type,
        items: [
          {
            kind: "procedure",
            code: "160054610",
            name: "ＣＲＰ定性",
            points: 16,
            feeCategory: "lab_test_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          },
          {
            kind: "procedure",
            code: "160054710",
            name: "ＣＲＰ",
            points: 16,
            feeCategory: "lab_test_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          }
        ]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", evidence: "初診", confidence: "medium" },
    diagnoses: [{ name: "発熱", status: "confirmed", evidence: "発熱" }],
    clinical_events: [{
      type: "lab",
      billing_domain: "standard_lab",
      name: "ＣＲＰ",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "静脈採血を行い、ＣＲＰ 0.3mg/dLを確認",
      search_queries: ["ＣＲＰ"],
      specimen: "血液",
      collection_method: "静脈採血"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "CRP Master Selection Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 静脈採血を行い、ＣＲＰ 0.3mg/dLを確認。",
    diagnoses: [{ name: "発熱" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160054710"]);
});

test("uses evidence line ids to verify supported clinical facts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let extractorPreprocessedLines = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && input.query === "ＣＲＰ") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160054710",
          name: "ＣＲＰ",
          points: 16,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async ({ preprocessedLines }) => {
    extractorPreprocessedLines = preprocessedLines;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [{ name: "発熱", status: "confirmed", evidence: "発熱" }],
      clinical_events: [{
        type: "lab",
        billing_domain: "standard_lab",
        name: "ＣＲＰ",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "numeric",
        certainty: "explicit",
        section: "O",
        evidence: "CRP値を確認",
        evidence_line_ids: ["O-001"],
        search_queries: ["ＣＲＰ"],
        specimen: "血液",
        collection_method: "静脈採血"
      }],
      checklist_findings: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Evidence Line Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 静脈採血を行い、ＣＲＰ 0.3mg/dLを確認。",
    diagnoses: [{ name: "発熱" }]
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
  assert.equal(extractorPreprocessedLines?.[0]?.lineId, "O-001");
  assert.ok(extractorPreprocessedLines?.[0]?.candidateConcepts?.includes("lab:crp"));
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160054710"]);
  const fact = calculation.body.calculationResult.canonicalClinicalFacts.find((item) => item.conceptId === "lab:crp");
  assert.equal(fact.verification.status, "verified");
  assert.equal(fact.evidenceRefs[0].lineId, "O-001");
  assert.equal(fact.evidenceRefs[0].lineIdProvided, true);
});

test("blocks automatic billing when evidence line id is not found", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let masterLookupCount = 0;
  stores.feeCalculator.searchMaster = async (input) => {
    masterLookupCount += 1;
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "発熱", status: "confirmed", evidence: "発熱" }],
    clinical_events: [{
      type: "lab",
      billing_domain: "standard_lab",
      name: "ＣＲＰ",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "ＣＲＰ 0.3mg/dL",
      evidence_line_ids: ["O-999"],
      search_queries: ["ＣＲＰ"],
      specimen: "血液",
      collection_method: "静脈採血"
    }],
    checklist_findings: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Missing Evidence Line Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 静脈採血を行い、ＣＲＰ 0.3mg/dLを確認。",
    diagnoses: [{ name: "発熱" }]
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
  assert.equal(masterLookupCount, 0);
  assert.equal(receivedInput.calculationOptions.procedure_codes, undefined);
  const fact = calculation.body.calculationResult.canonicalClinicalFacts.find((item) => item.conceptId === "lab:crp");
  assert.equal(fact.verification.status, "review_required");
  assert.deepEqual(fact.verification.reasons, ["evidence_quote_not_found"]);
});

test("does not auto-select parenthetical method masters without chart support", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && input.query === "超音波") {
      return {
        query: input.query,
        type: input.type,
        items: [
          {
            kind: "procedure",
            code: "160072110",
            name: "超音波検査（Ａモード法）",
            points: 150,
            feeCategory: "procedure_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          },
          {
            kind: "procedure",
            code: "160072210",
            name: "超音波検査（断層撮影法）（胸腹部）",
            points: 530,
            feeCategory: "procedure_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          }
        ]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "腹痛", status: "confirmed", evidence: "腹痛" }],
    clinical_events: [{
      type: "imaging",
      billing_domain: "standard_imaging",
      name: "超音波",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence: "腹部超音波を実施し、明らかな異常なし",
      search_queries: ["超音波"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Ultrasound Ambiguous Method Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 腹部超音波を実施し、明らかな異常なし。",
    diagnoses: [{ name: "腹痛" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    String(issue.messageForStaff || issue.title || "").includes("マスター候補確認")
  )));
});

test("selects parenthetical method masters when the method is chart-supported", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && input.query === "超音波検査（Ａモード法）") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160072110",
          name: "超音波検査（Ａモード法）",
          points: 150,
          feeCategory: "procedure_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "眼科検査", status: "confirmed", evidence: "眼科検査" }],
    clinical_events: [{
      type: "exam",
      billing_domain: "standard_procedure",
      name: "超音波検査（Ａモード法）",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "normal",
      certainty: "explicit",
      section: "O",
      evidence: "超音波検査（Ａモード法）を実施",
      search_queries: ["超音波検査（Ａモード法）"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Ultrasound A Mode Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 超音波検査（Ａモード法）を実施。",
    diagnoses: [{ name: "眼科検査" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160072110"]);
});

test("recovers named performed lab events from checklist findings before master search", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let extractorChecklistMenu = [];
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async ({ checklistMenu }) => {
    extractorChecklistMenu = checklistMenu;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [],
      clinical_events: [],
      checklist_findings: [{
        menu_id: "lab:urine_general",
        status: "performed_today",
        evidence: "尿一般を実施",
        reason: "本文に実施記載あり"
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Lab Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 尿一般を実施。異常なし。",
    diagnoses: [{ name: "尿路感染症疑い" }]
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
  assert.ok(extractorChecklistMenu.some((item) => item.menuId === "lab:urine_general"));
  assert.ok(masterSearches.some((input) => input.type === "procedure" && input.query === "尿一般"));
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160000310"]);
  assert.ok(calculation.body.calculationResult.clinicalEvents.some((event) => (
    event.name === "尿一般"
    && event.actionStatus === "performed"
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_recall"
    && item.outcome === "recovered"
  )));
});

test("does not recover checklist findings without a quoted evidence span", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [],
    checklist_findings: [{
      menu_id: "lab:urine_general",
      status: "performed_today",
      evidence: "尿一般を実施",
      reason: "本文に実施記載あり"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Guard Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 尿検査の予定を説明。",
    diagnoses: [{ name: "尿路感染症疑い" }]
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
  assert.equal(masterSearches.some((input) => input.query === "尿一般"), false);
  assert.equal(receivedInput.calculationOptions?.procedure_codes, undefined);
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_recall"
    && item.outcome === "ignored"
  )));
});

test("does not recover performed checklist findings from negated evidence", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [],
    checklist_findings: [{
      menu_id: "imaging:simple_radiography",
      status: "performed_today",
      evidence: "胸部X線は本日は行っていない",
      reason: "LLMが実施済みと誤分類した"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Negated Evidence Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 呼吸状態は安定。胸部X線は本日は行っていない。",
    diagnoses: [{ name: "発熱" }]
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
  assert.equal(masterSearches.length, 0);
  assert.equal(receivedInput.calculationOptions?.imaging_orders, undefined);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "clinical_event_conflict_check"
    && /胸部X線/u.test(issue.messageForStaff)
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_recall"
    && item.outcome === "blocked"
    && item.message === "checklist_performed_evidence_negated_or_not_current"
  )));
});

test("recovers standard treatment events from checklist findings without direct word billing", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let extractorChecklistMenu = [];
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "熱傷処置") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "140032010",
          name: "熱傷処置（１００ｃｍ２未満）",
          points: 52,
          feeCategory: "treatment_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async ({ checklistMenu }) => {
    extractorChecklistMenu = checklistMenu;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [{ name: "熱傷", status: "confirmed", evidence: "熱傷" }],
      clinical_events: [],
      checklist_findings: [{
        menu_id: "procedure:burn_treatment",
        status: "performed_today",
        evidence: "左前腕の2度熱傷に対して創部洗浄を実施",
        reason: "熱傷への処置が本文にある"
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Burn Treatment Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 左前腕の2度熱傷に対して創部洗浄を実施。",
    diagnoses: [{ name: "熱傷" }]
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
  assert.ok(extractorChecklistMenu.some((item) => item.menuId === "procedure:burn_treatment"));
  assert.ok(masterSearches.some((input) => input.type === "procedure" && input.query === "熱傷処置"));
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["140032010"]);
  assert.ok(calculation.body.calculationResult.clinicalEvents.some((event) => (
    event.name === "熱傷処置"
    && event.source === "checklist_recall"
  )));
});

test("uses procedure area band evidence to select among burn treatment sibling masters", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "熱傷処置") {
      return {
        query: input.query,
        type: input.type,
        items: [
          {
            kind: "procedure",
            code: "140032110",
            name: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）",
            points: 60,
            feeCategory: "treatment_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          },
          {
            kind: "procedure",
            code: "140032010",
            name: "熱傷処置（１００ｃｍ２未満）",
            points: 52,
            feeCategory: "treatment_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          },
          {
            kind: "procedure",
            code: "140032210",
            name: "熱傷処置（５００ｃｍ２以上３０００ｃｍ２未満）",
            points: 90,
            feeCategory: "treatment_basic",
            itemRole: "base",
            directRetrievalAllowed: true
          }
        ]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "熱傷", status: "confirmed", evidence: "熱傷" }],
    clinical_events: [{
      type: "procedure",
      billing_domain: "standard_procedure",
      name: "熱傷処置",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "O",
      evidence: "当院で100cm2未満の熱傷処置を実施。創部を洗浄し、保護して被覆した。",
      search_queries: ["熱傷処置"],
      area_size_cm2: ""
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Burn Area Band Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 当院で100cm2未満の熱傷処置を実施。創部を洗浄し、保護して被覆した。",
    diagnoses: [{ name: "熱傷" }]
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
  assert.ok(masterSearches.some((input) => input.type === "procedure" && input.query === "熱傷処置"));
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["140032010"]);
});

test("recovers composite covid flu antigen checklist as an independent lab event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160230050",
          name: "ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性",
          points: 420,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "インフルエンザウイルス抗原定性") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160169450",
          name: "インフルエンザウイルス抗原定性",
          points: 132,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async ({ checklistMenu }) => {
    assert.ok(checklistMenu.some((item) => item.menuId === "lab:covid_flu_antigen" && item.compositeConcept === true));
    return {
      visit_type: { kind: "initial", evidence: "初診", confidence: "medium" },
      diagnoses: [],
      clinical_events: [{
        clinical_event_id: "ce_flu_component",
        type: "lab",
        name: "インフルB抗原検査",
        action_status: "performed",
        temporal_relation: "current_visit",
        provider_ownership: "own_clinic",
        source_origin: "own_clinic_record",
        evidence: "院内でコロナ・インフル同時抗原を実施。インフルB陽性、コロナ陰性。",
        search_queries: ["インフルエンザウイルス抗原定性"]
      }],
      checklist_findings: [{
        menu_id: "lab:covid_flu_antigen",
        status: "performed_today",
        evidence: "院内でコロナ・インフル同時抗原を実施",
        reason: "同時検査の実施記載"
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Composite Checklist Lab Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 院内でコロナ・インフル同時抗原を実施。インフルB陽性、コロナ陰性。",
    diagnoses: [{ name: "発熱" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160230050"]);
  assert.equal(masterSearches.some((input) => input.query === "インフルエンザウイルス抗原定性"), false);
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_composite_normalization"
    && item.outcome === "superseded"
  )));
});

test("recovers surgery review domain from excision wording in checklist menu", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let extractorChecklistMenu = [];
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 0,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async ({ checklistMenu }) => {
    extractorChecklistMenu = checklistMenu;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [{ name: "皮下腫瘤", status: "suspected", evidence: "皮下腫瘤" }],
      clinical_events: [],
      checklist_findings: [{
        menu_id: "domain:surgery",
        status: "performed_today",
        evidence: "背部皮下腫瘤を局所麻酔下に摘出",
        reason: "切除・摘出を含む手術領域の記載"
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Surgery Domain Checklist Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 背部皮下腫瘤を局所麻酔下に摘出。検体は病理へ提出。",
    diagnoses: [{ name: "皮下腫瘤" }]
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
  assert.ok(extractorChecklistMenu.some((item) => item.menuId === "domain:surgery"));
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "surgery_unsupported"
    && /手術未対応/u.test(issue.messageForStaff)
  )));
});

test("blocks billable free extraction when checklist contradicts the event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [{
      clinical_event_id: "ce_free_urine_general",
      type: "lab",
      name: "尿一般",
      action_status: "performed",
      temporal_relation: "current_visit",
      provider_ownership: "own_clinic",
      source_origin: "own_clinic_record",
      evidence: "尿一般を実施",
      search_queries: ["尿一般"]
    }],
    checklist_findings: [{
      menu_id: "lab:urine_general",
      status: "not_in_text",
      evidence: "",
      reason: "本文には尿一般の記載がない"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Conflict Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 尿一般を実施。異常なし。",
    diagnoses: [{ name: "尿路感染症疑い" }]
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
  assert.equal(masterSearches.some((input) => input.query === "尿一般"), false);
  assert.equal(receivedInput.calculationOptions?.procedure_codes, undefined);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "clinical_event_conflict_check"
    && /尿一般/u.test(issue.messageForStaff)
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_consistency"
    && item.outcome === "blocked"
  )));
});

test("does not enrich existing events from non-performed checklist findings", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "創傷処置") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "140000610",
          name: "創傷処置（１００ｃｍ２未満）",
          points: 52,
          feeCategory: "treatment_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    clinical_events: [{
      clinical_event_id: "ce_wound_observation",
      type: "exam",
      name: "創傷部位の観察",
      action_status: "performed",
      temporal_relation: "current_visit",
      provider_ownership: "own_clinic",
      source_origin: "own_clinic_record",
      evidence: "創傷部位を観察。発赤なし。",
      search_queries: ["創傷部位の観察"]
    }],
    checklist_findings: [{
      menu_id: "procedure:wound_treatment",
      status: "unclear",
      evidence: "創傷部位を観察。発赤なし。",
      reason: "処置実施か観察のみかは不明"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Checklist Non Performed Enrichment Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 創傷部位を観察。発赤なし。処置は本日行わず。",
    diagnoses: [{ name: "創傷" }]
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
  assert.equal(masterSearches.some((input) => input.query === "創傷処置"), false);
  assert.equal(receivedInput.calculationOptions?.procedure_codes, undefined);
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "checklist_recall"
    && item.outcome === "matched_existing_without_enrichment"
    && item.status === "unclear"
  )));
});

test("routes non-blood specimen collection fees to review instead of auto collection input", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && String(input.query || "").includes("インフル")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160169450",
          name: "インフルエンザウイルス抗原定性",
          points: 139,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "尿蛋白") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000410",
          name: "尿蛋白",
          points: 0,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "末梢血液一般検査") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160008010",
          name: "末梢血液一般検査",
          points: 21,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 139,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "インフルエンザ疑い", status: "suspected", evidence: "インフルエンザ疑い" }],
    clinical_events: [
      {
        type: "lab",
        name: "インフルエンザ抗原",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "positive",
        certainty: "explicit",
        section: "O",
        evidence: "鼻咽頭ぬぐい液でインフルエンザウイルス抗原定性を院内実施。",
        search_queries: ["インフルエンザ抗原"],
        specimen: "鼻咽頭ぬぐい液",
        collection_method: "スワブ採取"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Swab Review Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-09",
    clinicalText: "O: 鼻咽頭ぬぐい液でインフルエンザウイルス抗原定性を院内実施。",
    diagnoses: [{ name: "インフルエンザ疑い" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160169450"]);
  assert.equal(receivedInput.calculationOptions.lab_options, undefined);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.issueCode === "specimen_collection_fee_review_required"
    && issue.title === "検体採取確認"
  )));
  const trace = calculation.body.calculationResult.clinicalExtraction.trace;
  assert.ok(trace.some((item) => (
    item.stage === "lab_rule_expansion"
    && item.selected?.derived?.some((derived) => derived.kind === "collection_fee_review")
  )));
});

test("uses clinical text performed lab sentence as support but ignores template-only lab mentions", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const masterSearches = [];
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 26,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "膀胱炎疑い", status: "suspected", evidence: "膀胱炎疑い" }],
    clinical_events: [{
      type: "lab",
      billing_domain: "standard_lab",
      name: "尿一般",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "unknown",
      certainty: "explicit",
      section: "O",
      evidence: "尿一般を実施。",
      search_queries: ["尿一般"],
      modality: "none",
      body_site: "",
      specimen: "尿",
      collection_method: "院内尿検体",
      quantity_per_day: "",
      days: "",
      total_quantity: "",
      area_size_cm2: "",
      review_reason: ""
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Lab Full Text Support Patient"
  }, headers);
  const supported = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "再診。排尿時痛があり、尿一般を実施。",
    diagnoses: [{ name: "膀胱炎疑い" }]
  }, headers);
  let calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${supported.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160000310"]);
  assert.ok(masterSearches.some((search) => search.query === "尿一般"));

  masterSearches.length = 0;
  receivedInput = null;
  const templateOnly = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-11",
    clinicalText: "当日確認した主な診療内容は「尿一般」。確認すべき論点は「検査コード」。",
    diagnoses: [{ name: "膀胱炎疑い" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${templateOnly.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((search) => search.query === "尿一般"), false);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検査コード確認"));
});

test("does not support lab coding from past values or necessity confirmation only", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const masterSearches = [];
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "HbA1c") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160010010",
          name: "ＨｂＡ１ｃ",
          points: 49,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "糖尿病疑い", status: "suspected", evidence: "糖尿病疑い" }],
    clinical_events: [{
      type: "lab",
      billing_domain: "standard_lab",
      name: "HbA1c",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "ambiguous",
      section: "O",
      evidence: "検査を実施。",
      search_queries: ["HbA1c"],
      specimen: "血液",
      collection_method: "",
      review_reason: ""
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Past Lab Value Guard Patient"
  }, headers);
  const pastValue = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "再診。先月測定したHbA1cは7.2%。本日は療養指導を行った。",
    diagnoses: [{ name: "糖尿病疑い" }]
  }, headers);
  let calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${pastValue.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((search) => search.query === "HbA1c"), false);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検査コード確認"));

  masterSearches.length = 0;
  receivedInput = null;
  const necessityOnly = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-11",
    clinicalText: "再診。HbA1cの必要性を確認し、次回採血を検討する。",
    diagnoses: [{ name: "糖尿病疑い" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${necessityOnly.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((search) => search.query === "HbA1c"), false);
});

test("does not promote past or external numeric lab result assertions into performed lab coding", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const masterSearches = [];
  let receivedInput = null;
  let clinicalEvents = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && ["CRP", "HbA1c"].includes(String(input.query || ""))) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: input.query === "CRP" ? "160054710" : "160010010",
          name: input.query === "CRP" ? "ＣＲＰ" : "ＨｂＡ１ｃ",
          points: input.query === "CRP" ? 16 : 49,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "糖尿病疑い", status: "suspected", evidence: "糖尿病疑い" }],
    clinical_events: clinicalEvents,
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Past External Numeric Lab Guard Patient"
  }, headers);

  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "CRP",
    action_status: "performed",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "numeric",
    certainty: "ambiguous",
    section: "O",
    evidence: "前回CRP 2.4mg/dLであったため、今日は症状経過のみ確認した。",
    search_queries: ["CRP"]
  }];
  let session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-12",
    clinicalText: "再診。前回CRP 2.4mg/dLであったため、今日は症状経過のみ確認した。",
    diagnoses: [{ name: "糖尿病疑い" }]
  }, headers);
  let calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((search) => search.query === "CRP"), false);

  masterSearches.length = 0;
  receivedInput = null;
  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "HbA1c",
    action_status: "performed",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "numeric",
    certainty: "ambiguous",
    section: "O",
    evidence: "他院HbA1c 7.2%の結果を持参。自院では本日採血していない。",
    search_queries: ["HbA1c"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-13",
    clinicalText: "再診。他院HbA1c 7.2%の結果を持参。自院では本日採血していない。",
    diagnoses: [{ name: "糖尿病疑い" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.some((search) => search.query === "HbA1c"), false);
});

test("routes non-billable lab review contexts to specific review topics without coding", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const masterSearches = [];
  let receivedInput = null;
  let clinicalEvents = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "発熱", status: "suspected", evidence: "発熱" }],
    clinical_events: clinicalEvents,
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Non Billable Lab Review Patient"
  }, headers);

  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "追加検査の要否判断",
    action_status: "considered",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "A",
    evidence: "同じ月に当院で行った検査があるか院内履歴の照合が必要。",
    search_queries: ["追加検査", "院内履歴 照合"]
  }];
  let session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-12",
    clinicalText: "再診。同じ月に当院で行った検査があるか院内履歴の照合が必要。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  let calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"));

  masterSearches.length = 0;
  receivedInput = null;
  clinicalEvents = [{
    type: "management",
    billing_domain: "standard_management",
    name: "院内履歴照合を行った上で追加検査の要否を判断する方針",
    action_status: "considered",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "A",
    evidence: "検査を検討したが、同じ月に当院で行った検査があるか院内履歴の照合が必要。",
    search_queries: ["追加検査", "院内履歴 照合"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-12",
    clinicalText: "再診。検査を検討したが、同じ月に当院で行った検査があるか院内履歴の照合が必要。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"));

  masterSearches.length = 0;
  receivedInput = null;
  clinicalEvents = [{
    type: "management",
    billing_domain: "standard_management",
    name: "生活指導の方針確認",
    action_status: "considered",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "A",
    evidence: "現時点では生活指導と経過観察も選択肢。",
    search_queries: ["生活指導", "経過観察"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-12",
    clinicalText: "再診。現時点では生活指導と経過観察も選択肢。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"), false);

  masterSearches.length = 0;
  receivedInput = null;
  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "CRP",
    action_status: "planned",
    temporal_relation: "future",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "O",
    evidence: "CRPについて院内で確認する方針を立てたが、測定条件や検査区分は本文だけでは追えない。",
    search_queries: ["CRP", "検査区分"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-13",
    clinicalText: "再診。CRPについて院内で確認する方針を立てたが、測定条件や検査区分は本文だけでは追えない。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検査コード確認"));

  masterSearches.length = 0;
  receivedInput = null;
  const glycemicMenu = buildClinicalChecklistMenu("2型糖尿病で通院中。血糖管理検査について、直近検査から日が浅いため再検査の要否を相談。");
  const glycemicGroup = glycemicMenu.find((item) => item.menuId === "lab_group:glycemic_monitoring");
  assert.equal(glycemicGroup?.label, "血糖管理検査");
  assert.equal(glycemicGroup?.query, "");

  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "血糖管理検査",
    action_status: "considered",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "A",
    evidence: "血糖管理検査について、直近検査から日が浅いため再検査の要否を相談。",
    search_queries: ["血糖管理検査"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-13",
    clinicalText: "再診。2型糖尿病で通院中。血糖管理検査について、直近検査から日が浅いため再検査の要否を相談。",
    diagnoses: [{ name: "2型糖尿病" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"));
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検査コード確認"));

  masterSearches.length = 0;
  receivedInput = null;
  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "追加検査の要否判断",
    action_status: "considered",
    temporal_relation: "current_visit",
    source_origin: "own_clinic_record",
    provider_ownership: "own_clinic",
    result_assertion: "not_applicable",
    certainty: "ambiguous",
    section: "A",
    evidence: "同月に検査は行っていないため、経過観察とした。",
    search_queries: ["追加検査"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "再診。同月に検査は行っていないため、経過観察とした。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes || [], []);
  assert.equal(masterSearches.length, 0);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"), false);

  clinicalEvents = [{
    type: "lab",
    billing_domain: "standard_lab",
    name: "CRP",
    action_status: "considered",
    temporal_relation: "past",
    source_origin: "patient_reported",
    provider_ownership: "own_clinic",
    result_assertion: "negative",
    certainty: "ambiguous",
    section: "S",
    evidence: "先月CRP陰性と本人が話した。",
    search_queries: ["CRP"]
  }];
  session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-15",
    clinicalText: "再診。先月CRP陰性と本人が話した。",
    diagnoses: [{ name: "発熱" }]
  }, headers);
  calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "同月内検査確認"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検査コード確認"), false);
});

test("does not infer specimen collection fee review from throat findings alone", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && String(input.query || "").includes("インフル")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160169450",
          name: "インフルエンザウイルス抗原定性",
          points: 139,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 139,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "インフルエンザ疑い", status: "suspected", evidence: "インフルエンザ疑い" }],
    clinical_events: [
      {
        type: "lab",
        name: "インフルエンザ抗原",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "positive",
        certainty: "explicit",
        section: "O",
        evidence: "咽頭発赤あり。インフルエンザウイルス抗原定性を院内実施。",
        search_queries: ["インフルエンザ抗原"],
        specimen: "",
        collection_method: ""
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Throat Finding Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-09",
    clinicalText: "O: 咽頭発赤あり。インフルエンザウイルス抗原定性を院内実施。",
    diagnoses: [{ name: "インフルエンザ疑い" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160169450"]);
  assert.equal(receivedInput.calculationOptions.lab_options, undefined);
  assert.equal(
    calculation.body.calculationResult.reviewIssues.some((issue) => issue.issueCode === "specimen_collection_fee_review_required"),
    false
  );
});

test("persists structured diagnoses and resolves clinical event search queries with history-based basic fee", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let receivedSessionContext = null;
  const procedureItems = {
    "ＣＡ１２５": [{ kind: "procedure", code: "160038010", name: "ＣＡ１２５" }],
    "超音波検査（断層撮影法）（胸腹部）": [{ kind: "procedure", code: "160072210", name: "超音波検査（断層撮影法）（胸腹部）" }]
  };
  stores.feeCalculator.searchMaster = async (input) => {
    return {
      query: input.query,
      type: input.type,
      items: procedureItems[input.query] || []
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
        section: "O",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["超音波検査（断層撮影法）（胸腹部）"],
        modality: "ultrasound",
        review_reason: ""
      },
      {
        type: "lab",
        name: "CA125",
        status: "performed",
        evidence: "静脈採血でCA125 68 U/mLを確認",
        section: "O",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["ＣＡ１２５"],
        modality: "none",
        review_reason: ""
      },
      {
        type: "imaging",
        name: "MRI骨盤部",
        status: "ordered",
        evidence: "MRI骨盤部オーダー（子宮内膜症の範囲評価）",
        section: "P",
        date_relation: "future",
        provider_ownership: "own_clinic",
        search_queries: ["MRI撮影"],
        modality: "mri",
        review_reason: "予定・依頼"
      },
      {
        type: "medication",
        name: "低用量ピル（ルナベル配合錠LD）",
        status: "prescribed",
        evidence: "低用量ピル処方（ルナベル配合錠LD）",
        section: "P",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["ルナベル配合錠LD"],
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
        section: "P",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["ロキソプロフェン"],
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
      "静脈採血でCA125 68 U/mLを確認。",
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
  assert.equal(receivedInput.calculationOptions.comment_inputs, undefined);
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

test("rule-based fallback does not inject disease-specific procedure hints", async () => {
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
  assert.equal(receivedInput.calculationOptions.procedure_codes, undefined);
  assert.equal(receivedInput.calculationOptions.lab_options, undefined);
  assert.equal(receivedInput.calculationOptions.comment_inputs, undefined);
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("MRI")));
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
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("患者履歴が完全ではない")));
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

test("replaces stale auto diagnoses and resolves generic clinical event search queries", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const procedureItems = {
    "アルブミン定量（尿）": [{ kind: "procedure", code: "160004810", name: "アルブミン定量（尿）" }],
    "医学管理料": [{ kind: "procedure", code: "113900000", name: "医学管理料（テスト）" }]
  };
  stores.feeCalculator.searchMaster = async (input) => ({
    query: input.query,
    type: input.type,
    items: procedureItems[input.query] || []
  });
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
      {
        type: "lab",
        name: "尿アルブミン",
        status: "performed",
        evidence: "尿アルブミン：42mg/gCr",
        section: "O",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["アルブミン定量（尿）"],
        modality: "none",
        body_site: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "management",
        name: "療養計画書による管理指導",
        status: "performed",
        evidence: "療養計画書を患者に説明・署名取得",
        section: "P",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["医学管理料"],
        modality: "none",
        body_site: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      }
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
    ["160004810"]
  );
  assert.equal(receivedInput.calculationOptions.lab_options, undefined);
  assert.deepEqual(
    calculation.body.feeSession.diagnoses.map((diagnosis) => diagnosis.name),
    ["2型糖尿病", "糖尿病性腎症第2期", "高血圧症", "脂質異常症"]
  );
  assert.equal(
    calculation.body.feeSession.diagnoses.some((diagnosis) => diagnosis.name === "月経困難症"),
    false
  );
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => warning.includes("糖尿病合併症管理料")), false);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.issueCode === "management_fee_review_required"
    && issue.messageForStaff.includes("療養計画書による管理指導")
  )));
});

test("management events become adoptable proposals but never confirmed lines", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  const masterItems = {
    "特定疾患療養管理料": [{
      kind: "procedure",
      code: "113999001",
      name: "特定疾患療養管理料（テスト）",
      points: 225,
      sourceType: "medical_procedure_master"
    }]
  };
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return {
      query: input.query,
      type: input.type,
      items: masterItems[input.query] || []
    };
  };
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
      { name: "慢性疾患", status: "confirmed", evidence: "慢性疾患の継続管理" }
    ],
    billing_events: [
      {
        type: "management",
        name: "慢性疾患指導",
        status: "performed",
        evidence: "療養上の注意点を本日説明し、継続管理の方針を確認",
        section: "P",
        date_relation: "current_visit",
        provider_ownership: "own_clinic",
        search_queries: ["特定疾患療養管理料", "慢性疾患指導"],
        modality: "none",
        body_site: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      }
    ],
    excluded_events: [
      { type: "medication", name: "再指導", status: "history", evidence: "薬剤の使い方を再指導", reason: "指導" }
    ],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Management Proposal Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "慢性疾患" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: [
      "慢性疾患の継続管理。",
      "療養上の注意点を本日説明し、継続管理の方針を確認。",
      "薬剤の使い方を再指導。"
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
  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
  // 確定明細(procedure_codes)には決して入らない
  assert.equal(receivedInput.calculationOptions.procedure_codes, undefined);
  // 医学管理イベントもマスタ照合され、点数付きの承認待ち候補として提示される
  assert.ok(masterSearches.length >= 1);
  const managementProposal = calculation.body.calculationResult.candidateProposals
    .find((proposal) => proposal.code === "113999001");
  assert.ok(managementProposal, "マスタ照合された管理料候補が提示される");
  assert.equal(managementProposal.potentialPoints, 225);
  assert.equal(managementProposal.basis, "master_link_candidate");
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.issueCode === "management_fee_review_required"
    && issue.messageForStaff.includes("慢性疾患指導")
  )));
  assert.equal(
    calculation.body.calculationResult.warnings.some((warning) => warning.includes("再指導")),
    false
  );
});

test("recovers concrete topical drug from medication evidence when LLM event name is generic", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "drug" && String(input.query || "").includes("ゲーベン")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "drug",
          code: "620008991",
          name: "ゲーベンクリーム１％",
          points: 48,
          sourceType: "drug_master"
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 131,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "皮膚びらん", status: "confirmed", evidence: "皮膚びらん" }],
    clinical_events: [{
      type: "medication",
      billing_domain: "standard_medication",
      name: "院内外用薬",
      action_status: "prescribed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "O",
      evidence: "ゲーベンクリーム1%を5g院内で外用薬として処方。外用薬の調剤として扱う。",
      search_queries: ["院内外用薬"],
      modality: "none",
      body_site: "",
      specimen: "",
      collection_method: "",
      quantity_per_day: "",
      days: "",
      total_quantity: "",
      area_size_cm2: "",
      review_reason: ""
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Topical Drug Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "皮膚びらん" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "ゲーベンクリーム1%を5g院内で外用薬として処方。外用薬の調剤として扱う。"
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
  assert.ok(masterSearches.some((search) => String(search.query || "").includes("ゲーベン")));
  assert.equal(masterSearches.some((search) => /^(?:院内外用薬|外用薬)$/u.test(String(search.query || ""))), false);
  assert.deepEqual(receivedInput.calculationOptions.medication_orders, [{
    drug_code: "620008991",
    total_quantity: "5",
    dispensing_kind: "external"
  }]);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "in_house",
    prescription_category: "other"
  });
});

test("derives outside prescription fee options from structured visit facts without a drug line", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 68,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "yes",
      generic_name_prescription: "yes",
      prescription_evidence: "院外処方箋を一般名処方で交付"
    },
    diagnoses: [{ name: "アレルギー性結膜炎", status: "confirmed", evidence: "アレルギー性結膜炎" }],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Outside Prescription Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "院外処方箋を一般名処方で交付した。",
    diagnoses: [{ name: "アレルギー性結膜炎" }]
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
  assert.equal(receivedInput.calculationOptions.medication_orders, undefined);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "outside_prescription",
    prescription_category: "other",
    generic_name_prescription_add_on: "generic_name_add_on_1"
  });
});

test("verified outside prescription visit facts suppress institution drug charge lookup", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  let drugLookupCount = 0;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "drug") {
      drugLookupCount += 1;
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 60,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "yes",
      generic_name_prescription: "no",
      prescription_evidence: "院外処方箋を発行し、ブデソニド/ホルモテロール吸入を56日分処方"
    },
    diagnoses: [{ name: "気管支喘息", status: "confirmed", evidence: "気管支喘息" }],
    clinical_events: [{
      type: "medication",
      name: "ブデソニド/ホルモテロール吸入",
      action_status: "prescribed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "P",
      evidence: "院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分",
      search_queries: ["ブデソニド/ホルモテロール吸入"],
      days: "56"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Verified Outside Prescription Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "P: 院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分。",
    diagnoses: [{ name: "気管支喘息" }]
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
  assert.equal(drugLookupCount, 0);
  assert.equal(receivedInput.calculationOptions.medication_orders, undefined);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "outside_prescription",
    prescription_category: "other"
  });
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "medication_delivery_invariant"
    && item.message === "outside_prescription_medication_event_skipped_before_drug_master_lookup"
  )));
});

test("blocks outside prescription visit facts when evidence is past or external", async () => {
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "yes",
      generic_name_prescription: "no",
      prescription_evidence: "前医で先月、院外処方箋を発行された"
    },
    diagnoses: [{ name: "気管支喘息", status: "confirmed", evidence: "気管支喘息" }],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Past Outside Prescription Evidence Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "S: 前医で先月、院外処方箋を発行されたと本人が話した。本日は処方なし。",
    diagnoses: [{ name: "気管支喘息" }]
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
  assert.equal(receivedInput.calculationOptions?.medication, undefined);
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "medication_delivery_check"
  )));
});

test("does not infer outside prescription from negated prescription slip text", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "drug" && String(input.query || "").includes("ゲーベン")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "drug",
          code: "620008991",
          name: "ゲーベンクリーム1%",
          points: 0
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "熱傷", status: "confirmed", evidence: "熱傷" }],
    clinical_events: [{
      type: "medication",
      name: "ゲーベンクリーム1%",
      action_status: "prescribed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "P",
      evidence: "処方箋は発行せず、ゲーベンクリーム1%を10g院内で外用薬として処方",
      search_queries: ["ゲーベンクリーム1%"],
      total_quantity: "10"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Negated Prescription Slip Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "P: 処方箋は発行せず、ゲーベンクリーム1%を10g院内で外用薬として処方。",
    diagnoses: [{ name: "熱傷" }]
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
  assert.deepEqual(receivedInput.calculationOptions.medication_orders, [{
    drug_code: "620008991",
    total_quantity: "10",
    dispensing_kind: "external"
  }]);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "in_house",
    prescription_category: "other"
  });
});

test("structured no outside prescription visit fact overrides negated outside prescription words", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "drug" && String(input.query || "").includes("ゲーベン")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "drug",
          code: "620008991",
          name: "ゲーベンクリーム1%",
          points: 0
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "no",
      generic_name_prescription: "no",
      prescription_evidence: "院外処方箋は交付していない"
    },
    diagnoses: [{ name: "熱傷", status: "confirmed", evidence: "熱傷" }],
    clinical_events: [{
      type: "medication",
      name: "ゲーベンクリーム1%",
      action_status: "prescribed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "P",
      evidence: "ゲーベンクリーム1%を10g院内で外用薬として処方",
      search_queries: ["ゲーベンクリーム1%"],
      total_quantity: "10"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Structured No Outside Prescription Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "S: 前医では処方箋を交付されたと本人が話した。P: 本日は院外処方箋は交付していない。ゲーベンクリーム1%を10g院内で外用薬として処方。",
    diagnoses: [{ name: "熱傷" }]
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
  assert.deepEqual(receivedInput.calculationOptions.medication_orders, [{
    drug_code: "620008991",
    total_quantity: "10",
    dispensing_kind: "external"
  }]);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "in_house",
    prescription_category: "other"
  });
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "visit_facts_consistency"
    && item.message === "outside_prescription_visit_fact_no_in_house"
  )));
});

test("blocks outside prescription visit facts when quoted evidence conflicts with in-house medication", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "drug" && String(input.query || "").includes("ゲーベン")) {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "drug",
          code: "620008991",
          name: "ゲーベンクリーム1%",
          points: 0
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
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
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "yes",
      generic_name_prescription: "no",
      prescription_evidence: "ゲーベンクリーム1%を10g院内で外用薬として処方"
    },
    diagnoses: [{ name: "熱傷", status: "confirmed", evidence: "熱傷" }],
    clinical_events: [{
      type: "medication",
      name: "ゲーベンクリーム1%",
      action_status: "prescribed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "P",
      evidence: "ゲーベンクリーム1%を10g院内で外用薬として処方",
      search_queries: ["ゲーベンクリーム1%"],
      total_quantity: "10"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "In House Medication Conflict Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "P: ゲーベンクリーム1%を10g院内で外用薬として処方。",
    diagnoses: [{ name: "熱傷" }]
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
  assert.deepEqual(receivedInput.calculationOptions.medication_orders, [{
    drug_code: "620008991",
    total_quantity: "10",
    dispensing_kind: "external"
  }]);
  assert.deepEqual(receivedInput.calculationOptions.medication, {
    delivery_kind: "in_house",
    prescription_category: "other"
  });
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "medication_delivery_check"
    && issue.topicLabel === "院内外処方確認"
  )));
});

test("emits notification check for management events tied to facility registration context", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => ({ query: input.query, type: input.type, items: [] });
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 75,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "COPD", status: "confirmed", evidence: "COPD" }],
    clinical_events: [{
      type: "management",
      billing_domain: "management_fee",
      name: "呼吸訓練と管理内容の確認",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "O",
      evidence: "呼吸訓練や管理の扱いは、当院で実施できる内容と院内の登録情報を照合する必要がある。",
      search_queries: ["呼吸訓練 管理"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Facility Registration Management Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "O: 呼吸訓練や管理の扱いは、当院で実施できる内容と院内の登録情報を照合する必要がある。",
    diagnoses: [{ name: "COPD" }]
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
  assert.ok(calculation.body.calculationResult.reviewIssues.some((issue) => (
    issue.topicCode === "notification_check"
    && issue.topicLabel === "届出確認"
  )));
});

test("routes pathology and emergency time addon events into review-only domain topics", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    return { query: input.query, type: input.type, items: [] };
  };
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
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "術後創部", status: "confirmed", evidence: "術後創部" }],
    clinical_events: [
      {
        type: "pathology",
        billing_domain: "unknown",
        name: "病理診断/細胞診",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "O",
        evidence: "検体採取、提出先、標本種類、結果説明予定を記録。病理領域として要レビュー。",
        search_queries: ["病理診断", "細胞診"],
        modality: "none",
        body_site: "",
        specimen: "組織",
        collection_method: "検体提出",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "emergency_time_addon",
        billing_domain: "unknown",
        name: "時間外/休日/救急加算",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "O",
        evidence: "救急・時間外の記載はあるが、受付時刻と算定条件が不足している。",
        search_queries: ["救急加算", "時間外加算"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "受付時刻不足"
      },
      {
        type: "management",
        billing_domain: "rehabilitation",
        name: "運動器リハビリテーション",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "リハビリテーション料は実施単位と施設基準を確認する。",
        search_queries: ["運動器リハビリテーション"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "実施単位確認"
      },
      {
        type: "management",
        billing_domain: "home_care",
        name: "在宅医療",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "在宅医療の訪問診療区分と同月履歴を確認する。",
        search_queries: ["在宅医療", "訪問診療"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "訪問診療確認"
      },
      {
        type: "management",
        billing_domain: "psychiatry_special",
        name: "通院精神療法",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "精神科専門療法の算定条件を確認する。",
        search_queries: ["通院精神療法"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "精神科専門療法確認"
      },
      {
        type: "procedure",
        billing_domain: "surgery",
        name: "手術",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "手術の手技内容を確認する。",
        search_queries: ["手術"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "手技内容確認"
      },
      {
        type: "procedure",
        billing_domain: "anesthesia",
        name: "麻酔",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "麻酔方法と管理区分を確認する。",
        search_queries: ["麻酔"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "麻酔確認"
      },
      {
        type: "procedure",
        billing_domain: "anesthesia",
        name: "麻酔前評価",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "術前麻酔面接を実施した可能性があり、面接時間を確認する。",
        search_queries: ["術前麻酔面接"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "面接時間確認"
      },
      {
        type: "procedure",
        billing_domain: "anesthesia",
        name: "麻酔薬投与",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "麻酔薬剤の投与量と投与経路を確認する。",
        search_queries: ["麻酔薬"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "薬剤量確認"
      },
      {
        type: "procedure",
        billing_domain: "endoscopy",
        name: "内視鏡検査",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "内視鏡検査の生検有無を確認する。",
        search_queries: ["内視鏡"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "生検有無確認"
      },
      {
        type: "procedure",
        billing_domain: "dialysis",
        name: "透析",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "透析条件を確認する。",
        search_queries: ["透析"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "透析確認"
      },
      {
        type: "procedure",
        billing_domain: "transfusion",
        name: "輸血",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "輸血の実施内容を確認する。",
        search_queries: ["輸血"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "輸血確認"
      },
      {
        type: "procedure",
        billing_domain: "radiation_therapy",
        name: "放射線治療",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "放射線治療の照射条件を確認する。",
        search_queries: ["放射線治療"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "照射条件確認"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Review Domain Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01"
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "病理領域として要レビュー。救急・時間外の記載はあるが、受付時刻と算定条件が不足。"
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
  // review-only領域は自動確定しない(確定明細に入らない)
  assert.equal(receivedInput.calculationOptions.procedure_codes, undefined);
  // 実施済み(performed)のreview-onlyイベントは候補生成のためマスタ照合を試みる。
  // 検討中(considered)のイベントは照合しない。このモックはヒット0件なので候補も0件。
  assert.ok(masterSearches.length >= 1);
  assert.equal(calculation.body.calculationResult.candidateProposals
    .filter((proposal) => proposal.basis === "master_link_candidate").length, 0);
  const reviewIssues = calculation.body.calculationResult.reviewIssues;
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "病理未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "検体提出確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "救急加算確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "受付時刻確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "リハビリ未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "実施単位確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "在宅医療未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "訪問診療確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "精神科専門療法未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "手術未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "麻酔未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "手技内容確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "面接時間確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "薬剤量確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "内視鏡未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "生検有無確認"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "透析未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "輸血未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "放射線治療未対応"));
  assert.ok(reviewIssues.some((issue) => issue.topicLabel === "照射条件確認"));
  assert.equal(calculation.body.candidateWorkbench.proposals.length, 0);
});

test("does not treat a next outpatient revisit plan as home care", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 75,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "腰痛", status: "confirmed", evidence: "腰痛" }],
    clinical_events: [
      {
        type: "management",
        billing_domain: "home_care",
        name: "次回再診予定",
        action_status: "considered",
        temporal_relation: "future",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "1週間後に外来で再診予定。",
        search_queries: ["次回再診"],
        review_reason: "次回フォロー"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Next Revisit Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    setting: "outpatient",
    clinicalText: "P: 1週間後に外来で再診予定。",
    diagnoses: [{ name: "腰痛" }]
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
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "在宅医療未対応"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "訪問診療確認"), false);
});

test("does not divert ordinary lab specimen submission or symptom timing into review-only domains", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "ＣＲＰ") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160054710",
          name: "ＣＲＰ",
          points: 16,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "尿蛋白") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000410",
          name: "尿蛋白",
          points: 7,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "末梢血液一般検査") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160008010",
          name: "末梢血液一般検査",
          points: 21,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 91,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "発熱", status: "confirmed", evidence: "発熱" }],
    clinical_events: [
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "ＣＲＰ",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "numeric",
        certainty: "explicit",
        section: "O",
        evidence: "静脈採血も行い、検体提出。ＣＲＰ 0.3mg/dL。",
        search_queries: ["ＣＲＰ"],
        modality: "none",
        body_site: "",
        specimen: "血液",
        collection_method: "静脈採血",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "尿一般、尿蛋白",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "normal",
        certainty: "explicit",
        section: "O",
        evidence: "院内尿検体で尿一般、尿蛋白を実施。",
        search_queries: ["尿一般", "尿蛋白"],
        modality: "none",
        body_site: "",
        specimen: "尿",
        collection_method: "院内尿検体",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "末梢血液一般検査",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "unknown",
        certainty: "ambiguous",
        section: "O",
        evidence: "静脈採血も行い、検体提出。",
        search_queries: ["末梢血液一般検査"],
        modality: "none",
        body_site: "",
        specimen: "血液",
        collection_method: "静脈採血",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: "採血だけで検査名は不明"
      },
      {
        type: "other",
        billing_domain: "unknown",
        name: "夜間頻尿",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "patient_reported",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "S",
        evidence: "夜間頻尿を確認した。",
        search_queries: ["夜間頻尿"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      },
      {
        type: "emergency_time_addon",
        billing_domain: "emergency_time_addon",
        name: "救急加算",
        action_status: "not_performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "S",
        evidence: "救急要請はなかった。",
        search_queries: ["救急加算"],
        modality: "none",
        body_site: "",
        specimen: "",
        collection_method: "",
        quantity_per_day: "",
        days: "",
        total_quantity: "",
        area_size_cm2: "",
        review_reason: ""
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Domain Counterexample Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "再診。血圧130/80、再測定128/76。静脈採血も行い、検体提出。ＣＲＰ 0.3mg/dL。院内尿検体で尿一般、尿蛋白を実施。夜間頻尿を確認した。救急要請はなかった。",
    diagnoses: [{ name: "発熱" }]
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
  assert.ok(masterSearches.some((search) => search.type === "procedure" && search.query === "ＣＲＰ"));
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160054710", "160000310", "160000410"]);
  assert.equal(receivedInput.calculationOptions.procedure_codes.includes("160008010"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "病理未対応"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "検体提出確認"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "救急加算確認"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "受付時刻確認"), false);
  assert.equal(calculation.body.calculationResult.reviewIssues.some((issue) => issue.topicLabel === "複数日記録分割"), false);
  assert.ok(calculation.body.calculationResult.clinicalEvents.some((event) => (
    event.name === "ＣＲＰ"
    && event.billingDomain === "standard_lab"
    && event.specimen === "血液"
  )));
});

test("filters lab search-query concept smuggling without rejecting the anchored lab event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  const masterSearches = [];
  stores.feeCalculator.searchMaster = async (input) => {
    masterSearches.push(input);
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "尿蛋白") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000410",
          name: "尿蛋白",
          points: 7,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (input.type === "procedure" && input.query === "末梢血液一般検査") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160008010",
          name: "末梢血液一般検査",
          points: 21,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 26,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "膀胱炎", status: "confirmed", evidence: "膀胱炎" }],
    clinical_events: [
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "尿定性（尿一般）",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "abnormal",
        certainty: "explicit",
        section: "O",
        evidence: "院内で尿定性を実施。白血球反応陽性。",
        search_queries: ["尿一般", "尿蛋白"],
        specimen: "尿",
        collection_method: "院内尿検体"
      },
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "血液検査",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "unknown",
        certainty: "ambiguous",
        section: "O",
        evidence: "静脈採血も施行し、血液検体を外注へ提出。",
        search_queries: ["末梢血液一般検査"],
        specimen: "血液",
        collection_method: "静脈採血"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Lab Query Filter Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "再診。院内で尿定性を実施。白血球反応陽性。静脈採血も施行し、血液検体を外注へ提出。",
    diagnoses: [{ name: "膀胱炎" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160000310"]);
  assert.equal(masterSearches.some((search) => search.query === "尿蛋白"), false);
  assert.equal(masterSearches.some((search) => search.query === "末梢血液一般検査"), false);
});

test("does not infer B-V from venous thrombosis history or serum value mention", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => {
    if (input.type === "procedure" && input.query === "尿一般") {
      return {
        query: input.query,
        type: input.type,
        items: [{
          kind: "procedure",
          code: "160000310",
          name: "尿一般",
          points: 26,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 26,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [{ name: "尿路感染症疑い", status: "suspected", evidence: "尿路感染症疑い" }],
    clinical_events: [
      {
        type: "lab",
        billing_domain: "standard_lab",
        name: "尿一般",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "normal",
        certainty: "explicit",
        section: "O",
        evidence: "尿一般を実施。血清Cr 1.2。既往歴に静脈血栓症あり。",
        search_queries: ["尿一般"],
        specimen: "尿",
        collection_method: "院内尿検体"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Blood Collection False Positive Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "再診。尿一般を実施。血清Cr 1.2。既往歴に静脈血栓症あり。",
    diagnoses: [{ name: "尿路感染症疑い" }]
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
  assert.deepEqual(receivedInput.calculationOptions.procedure_codes, ["160000310"]);
  assert.deepEqual(receivedInput.calculationOptions.lab_options?.collection_fee_inputs || [], []);
});

test("emits visit type review topic from uncertain structured visit type", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 291,
    lineItems: [{
      lineId: "line_initial",
      code: "111000110",
      name: "初診料",
      orderType: "outpatient_basic",
      points: 291,
      quantity: 1,
      totalPoints: 291,
      status: "candidate",
      source: "outpatient_basic_fee",
      reviewRequired: true
    }],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: {
      kind: "unknown",
      confidence: "low",
      evidence: "初診か再診か、診療録だけでは確定しきれないため、追加確認が必要。"
    },
    diagnoses: [{ name: "頭痛", status: "active", evidence: "頭痛" }],
    clinical_events: [{
      type: "counseling",
      billing_domain: "standard_management",
      name: "初診/再診の確認",
      action_status: "considered",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "ambiguous",
      section: "A",
      evidence: "初診か再診か、診療録だけでは確定しきれないため、追加確認が必要。",
      review_reason: "初診/再診の確認が必要"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Visit Type Review Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "初診か再診か、診療録だけでは確定しきれないため、追加確認が必要。",
    diagnoses: [{ name: "頭痛" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  const reviewIssues = calculation.body.calculationResult.reviewIssues;
  assert.equal(calculation.statusCode, 201);
  assert.equal(reviewIssues.filter((issue) => issue.topicLabel === "初診/再診確認").length, 1);
  assert.equal(reviewIssues.some((issue) => issue.topicLabel === "対象疾患確認"), false);
});

test("maps taxonomy-labelled management review events before target disease fallback", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 291,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", confidence: "high", evidence: "初診" },
    diagnoses: [{ name: "角膜異物疑い", status: "suspected", evidence: "角膜異物疑い" }],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "同日重複確認（条件未確認の処置への対応方針）",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "A",
        evidence: "同日重複確認が必要。",
        review_reason: "同日重複確認"
      },
      {
        type: "management",
        billing_domain: "standard_management",
        name: "管理料の確認",
        action_status: "considered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "A",
        evidence: "管理料の対象疾患を確認する。",
        review_reason: "対象疾患確認"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Same Day Duplicate Review Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "同日重複確認が必要。管理料の対象疾患を確認する。",
    diagnoses: [{ name: "角膜異物疑い" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  const reviewIssues = calculation.body.calculationResult.reviewIssues;
  assert.equal(calculation.statusCode, 201);
  assert.equal(reviewIssues.filter((issue) => issue.topicLabel === "同日重複確認").length, 1);
  assert.equal(reviewIssues.filter((issue) => issue.topicLabel === "対象疾患確認").length, 1);
  assert.equal(calculation.body.candidateWorkbench.proposals.some((proposal) => /同日重複|初診\/再診/u.test(proposal.title || "")), false);
});

test("emits structural review topics for unresolved procedure, injection, and management events", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => ({ query: input.query, type: input.type, items: [] });
  stores.feeCalculator.calculate = async () => ({
    provider: "test_fee_engine",
    source: "test",
    status: "completed",
    totalPoints: 75,
    lineItems: [],
    warnings: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", confidence: "medium", evidence: "再診" },
    diagnoses: [{ name: "処置後状態", status: "active", evidence: "処置後状態" }],
    clinical_events: [
      {
        type: "procedure",
        billing_domain: "standard_procedure",
        name: "角膜異物除去",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "explicit",
        section: "O",
        evidence: "右眼角膜の異物を点眼麻酔下に除去。",
        body_site: "右眼角膜",
        search_queries: ["角膜異物除去"]
      },
      {
        type: "injection",
        billing_domain: "standard_injection",
        name: "補液",
        action_status: "administered",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "O",
        evidence: "脱水補正目的で補液を行ったが、経路と薬剤量の記録を確認する。",
        search_queries: ["補液"]
      },
      {
        type: "management",
        billing_domain: "standard_management",
        name: "慢性疾患管理",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "not_applicable",
        certainty: "ambiguous",
        section: "P",
        evidence: "療養上の注意と継続管理方針を説明した。",
        review_reason: "管理料条件の確認"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Structural Topic Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "右眼角膜の異物を点眼麻酔下に除去。脱水補正目的で補液を行ったが、経路と薬剤量の記録を確認する。療養上の注意と継続管理方針を説明した。",
    diagnoses: [{ name: "処置後状態" }]
  }, headers);

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );

  const labels = calculation.body.calculationResult.reviewIssues.map((issue) => issue.topicLabel);
  assert.equal(calculation.statusCode, 201);
  assert.ok(labels.includes("手技内容確認"));
  assert.ok(labels.includes("処置部位確認"));
  assert.ok(labels.includes("注射経路確認"));
  assert.ok(labels.includes("薬剤量確認"));
  assert.ok(labels.includes("療養計画確認"));
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
  assert.equal(receivedInput.calculationOptions.imaging_orders[0].projection_count, 2);
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
  const performance = calculation.body.feeSession.calculationProgress.metrics.performance;
  assert.equal(performance.schemaVersion, 1);
  assert.equal(performance.source, "fee-api");
  assert.equal(performance.clinical.source, "openai");
  assert.equal(typeof performance.totalDurationMs, "number");
  assert.equal(typeof performance.durations.pythonCalculatorMs, "number");
  assert.equal(typeof performance.durations.saveCalculationMs, "number");
  assert.equal(performance.counts.lineItemCount, 1);
  assert.equal(performance.counts.reviewIssueCount, calculation.body.calculationResult.reviewIssues.length);
  assert.ok(performance.stageTimings.some((entry) => entry.stage === "prepare"));
  assert.ok(performance.stageTimings.some((entry) => entry.stage === "pythonCalculator"));
  assert.ok(performance.stageTimings.some((entry) => entry.stage === "saveCalculation"));
  assert.ok(performance.stageTimings.some((entry) => entry.stage === "audit"));
  const stored = stores.feeStore.getSession(session.body.feeSession.orgId, session.body.feeSession.feeSessionId);
  assert.equal(stored.calculationProgress.metrics.performance.schemaVersion, 1);
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
      "Medication fee candidate for in_house",
      "In-house medication fee requires drug inputs",
      "Exclusion candidate: 140000610 創傷処置（１００ｃｍ２未満） and 140032110 熱傷処置（１００ｃｍ２以上５００ｃｍ２未満） matched from current",
      "Exclusion candidate: 140032110 熱傷処置（１００ｃｍ２以上５００ｃｍ２未満） and 140000610 創傷処置（１００ｃｍ２未満） matched from current"
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
  assert.equal(calculation.body.calculationResult.warnings.some((warning) => /Lab management|D026|Collection fee|Medication fee|In-house medication|Exclusion candidate/i.test(warning)), false);
  assert.equal(
    calculation.body.calculationResult.warnings.filter((warning) => warning.includes("施設基準")).length,
    1
  );
  assert.equal(
    calculation.body.calculationResult.warnings.filter((warning) => warning.includes("同日複数処置の確認")).length,
    1
  );
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "判断料確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "採血料確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "投薬料の確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "院内処方の薬剤情報確認"));
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "同日複数処置の確認"));
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

test("proposes review-only specific disease management opportunities from active management facts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => {
    const query = String(input.query || "");
    if (query.includes("特定疾患療養管理料")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "113000001", name: "特定疾患療養管理料（診療所）", points: 225 }]
      };
    }
    if (query.includes("特定疾患処方管理加算")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "120001001", name: "特定疾患処方管理加算２", points: 56 }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "定期再診", confidence: "medium" },
    diagnoses: [
      { name: "気管支喘息", status: "active", evidence: "気管支喘息（主病）" }
    ],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "喘息管理",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。"
      },
      {
        type: "medication",
        billing_domain: "standard_medication",
        name: "ブデソニド/ホルモテロール吸入",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分。"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Asthma Management Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-07",
    clinicalText: [
      "S: 気管支喘息で当院通院中の定期再診。",
      "O: 療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。",
      "A: 気管支喘息（主病）。",
      "P: 院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分。"
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
  const management = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患療養管理料"));
  const prescription = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患処方管理加算"));

  assert.ok(management);
  assert.ok(prescription);
  assert.equal(management.actionType, "not_billable_now");
  assert.equal(prescription.actionType, "not_billable_now");
  assert.equal(management.candidateLine?.code, "113000001");
  assert.equal(management.candidateLine?.totalPoints, 225);
  assert.equal(prescription.candidateLine?.code, "120001001");
  assert.equal(prescription.candidateLine?.totalPoints, 56);
  assert.equal(management.potentialPoints, 225);
  assert.equal(prescription.potentialPoints, 56);
  assert.equal(management.policy?.riskGate, "review_only");
  assert.equal(prescription.policy?.riskGate, "review_only");
  assert.equal(Array.isArray(management.resolutionOptions), true);
  assert.equal(Array.isArray(prescription.resolutionOptions), true);
});

test("specific disease increase proposals keep billable candidate lines when advisory master search misses", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => ({
    query: input.query,
    type: input.type,
    items: []
  });
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "定期再診", confidence: "medium" },
    visit_facts: {
      outside_prescription_issued: "yes",
      outside_prescription_evidence: "院外処方箋を発行"
    },
    diagnoses: [
      { name: "気管支喘息", status: "active", evidence: "気管支喘息（主病）" }
    ],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "喘息管理",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。"
      },
      {
        type: "medication",
        billing_domain: "standard_medication",
        name: "ブデソニド/ホルモテロール吸入",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分。"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Asthma Fallback Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-07",
    clinicalText: [
      "S: 気管支喘息で当院通院中の定期再診。",
      "O: 療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。",
      "A: 気管支喘息（主病）。",
      "P: 院外処方箋を発行。ブデソニド/ホルモテロール吸入 1回1吸入 1日2回 56日分。"
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
  const management = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患療養管理料"));
  const prescription = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患処方管理加算"));

  assert.equal(management?.candidateLine?.code, "113001810");
  assert.equal(management?.candidateLine?.totalPoints, 225);
  assert.equal(prescription?.candidateLine?.code, "120005710");
  assert.equal(prescription?.candidateLine?.totalPoints, 56);
});

test("specific disease management proposal includes same-month ordinal and prior dates", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => {
    const query = String(input.query || "");
    if (query.includes("特定疾患療養管理料")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "113001810", name: "特定疾患療養管理料（診療所）", points: 225 }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "定期再診", confidence: "medium" },
    diagnoses: [
      { name: "気管支喘息", status: "active", evidence: "気管支喘息（主病）" }
    ],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "喘息管理",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Asthma Same Month Patient"
  }, headers);
  const priorSession = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "気管支喘息で再診。療養指導を実施。"
  }, headers);
  stores.feeStore.saveCalculation(
    priorSession.body.feeSession.orgId,
    priorSession.body.feeSession.feeSessionId,
    {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 225,
      lineItems: [{
        lineId: "line_specific_disease_management",
        code: "113001810",
        name: "特定疾患療養管理料（診療所）",
        orderType: "procedure",
        points: 225,
        quantity: 1,
        totalPoints: 225,
        status: "candidate",
        includedInTotal: true
      }],
      warnings: []
    }
  );
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-20",
    clinicalText: [
      "S: 気管支喘息で当院通院中の定期再診。",
      "O: 療養計画に基づき吸入手技・増悪時対応を説明（要点を診療録に記載）。",
      "A: 気管支喘息（主病）。"
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
  const management = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患療養管理料"));

  assert.ok(management);
  assert.equal(management.candidateLine?.code, "113001810");
  assert.equal(management.monthlyLimit?.family, "specific_disease_management");
  assert.equal(management.monthlyLimit?.maxPerMonth, 2);
  assert.equal(management.monthlyLimit?.priorCount, 1);
  assert.equal(management.monthlyLimit?.currentOrdinal, 2);
  assert.equal(management.monthlyLimit?.status, "within_limit_exactly");
  assert.deepEqual(management.monthlyLimit?.previousDates, ["2026-06-14"]);
  assert.match(management.reason, /当月2回目/u);
  assert.match(management.reason, /2026-06-14/u);
});

test("specific disease management targets include official-list chronic disease families", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => {
    const query = String(input.query || "");
    if (query.includes("特定疾患療養管理料")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "113001810", name: "特定疾患療養管理料（診療所）", points: 225 }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "定期再診", confidence: "medium" },
    diagnoses: [
      { name: "虚血性心疾患", status: "active", evidence: "虚血性心疾患（主病）" }
    ],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "虚血性心疾患管理",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "内服継続と増悪時対応について説明し、療養方針を診療録に記載。"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "IHD Management Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-20",
    clinicalText: [
      "S: 虚血性心疾患で当院通院中の定期再診。",
      "O: 内服継続と増悪時対応について説明し、療養方針を診療録に記載。",
      "A: 虚血性心疾患（主病）。"
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
  const management = proposals.find((proposal) => String(proposal.title || "").includes("特定疾患療養管理料"));

  assert.ok(management);
  assert.equal(management.source, "clinical_billing_knowledge:specific_disease_management");
  assert.equal(management.knowledge?.target?.targetId, "ischemic_heart_disease");
  assert.equal(management.candidateLine?.code, "113001810");
});

test("clinical billing knowledge proposes management, home care, and mind-body signals from structured facts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeCalculator.searchMaster = async (input) => {
    const query = String(input.query || "");
    if (query.includes("在宅持続陽圧呼吸療法指導管理料")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "114010810", name: "在宅持続陽圧呼吸療法指導管理料", points: 250 }]
      };
    }
    if (query.includes("心身医学療法")) {
      return {
        query: input.query,
        type: input.type,
        items: [{ kind: "procedure", code: "180009010", name: "心身医学療法", points: 110 }]
      };
    }
    return { query: input.query, type: input.type, items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [
      { name: "睡眠時無呼吸症候群", status: "active", evidence: "睡眠時無呼吸症候群" },
      { name: "心身症", status: "active", evidence: "心身症" }
    ],
    clinical_events: [
      {
        type: "management",
        billing_domain: "standard_management",
        name: "CPAP使用状況確認",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "CPAPの使用状況を確認し、機器設定と装着継続について説明。"
      },
      {
        type: "counseling",
        billing_domain: "standard_management",
        name: "心身医学療法",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        certainty: "explicit",
        evidence: "心身医学療法としてストレス関連症状への面接を実施。"
      }
    ],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Management Signal Patient"
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-20",
    clinicalText: [
      "S: 睡眠時無呼吸症候群と心身症で通院中。",
      "O: CPAPの使用状況を確認。心身医学療法として面接を実施。",
      "A: 睡眠時無呼吸症候群、心身症。"
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
  const cpap = proposals.find((proposal) => proposal.ruleId === "C107_2_home_cpap_signal");
  const mindBody = proposals.find((proposal) => proposal.ruleId === "I004_mind_body_psychotherapy_signal");

  assert.ok(cpap);
  assert.ok(mindBody);
  assert.equal(cpap.source, "clinical_billing_knowledge:management_signal");
  assert.equal(mindBody.source, "clinical_billing_knowledge:management_signal");
  assert.equal(cpap.candidateLine?.code, "114010810");
  assert.equal(mindBody.candidateLine?.code, "180009010");
  assert.equal(cpap.knowledge?.signalRulesVersion, "management-signal-rules-2026-06-20-p1");
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

test("passes documented management explanation to outpatient revisit options", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 128,
      lineItems: [],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "initial", evidence: "初診として来院", confidence: "high" },
    diagnoses: [{ name: "気管支喘息", status: "confirmed", evidence: "気管支喘息" }],
    clinical_events: [{
      type: "management",
      billing_domain: "standard_management",
      name: "気管支喘息の療養管理",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "not_applicable",
      certainty: "explicit",
      section: "O",
      evidence: "療養計画に基づき吸入手技・増悪時対応を説明し、要点を診療録に記載した。",
      review_reason: "療養計画に基づく説明"
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "Outpatient Management Patient"
  }, headers);
  await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-05-01",
    diagnoses: [{ name: "気管支喘息" }]
  }, headers);
  const current = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-06",
    clinicalText: "初診として来院。気管支喘息。療養計画に基づき吸入手技・増悪時対応を説明し、要点を診療録に記載した。",
    diagnoses: [{ name: "気管支喘息" }]
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
  // 改革1(確定ゼロ揺れ): LLM抽出の管理説明根拠では外来管理加算を確定に入れない。
  // 代わりに承認待ち候補として提示される。
  assert.equal(receivedInput.calculationOptions.outpatient_basic.management_explanation_performed, undefined);
  const managementAddon = calculation.body.calculationResult.candidateProposals
    .find((proposal) => proposal.code === "112011010");
  assert.ok(managementAddon, "外来管理加算が承認待ち候補として提示される");
  assert.equal(managementAddon.basis, "deterministic_gate_candidate");
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
    clinicalText: "O: テスト特定器材を使用した。",
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
  assert.equal(calculation.body.calculationResult.inputSnapshot.clinicalText, "O: テスト特定器材を使用した。");
  assert.equal(calculation.body.calculationResult.inputSnapshot.versions.registryVersion, "fee-concept-registry-v1");
  assert.ok(Array.isArray(calculation.body.calculationResult.canonicalClinicalFacts));
});

test("reuses previous clinical extraction when repricing manual order changes", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let extractorCalls = 0;
  const clinicalFactsExtractor = async ({ preprocessedLines }) => {
    extractorCalls += 1;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
      diagnoses: [{ name: "気管支炎", status: "active", evidence: "気管支炎" }],
      clinical_events: [{
        type: "lab",
        name: "CRP",
        action_status: "performed",
        temporal_relation: "current_visit",
        source_origin: "own_clinic_record",
        provider_ownership: "own_clinic",
        result_assertion: "numeric",
        certainty: "explicit",
        section: "O",
        evidence: "O: CRP 1.2 を測定。",
        search_queries: ["CRP"]
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: [],
      // v14契約: 全行のline_reviewを返す(欠落すると検証駆動リトライで再抽出が走る)
      line_review: (preprocessedLines || []).map((line) => ({ line_id: line.lineId, has_billable_act: true }))
    };
  };
  let lastCalculationInput = null;
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    lastCalculationInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: (feeSession.orders || []).length ? 200 : 100,
      lineItems: (feeSession.orders || []).map((order, index) => ({
        lineId: `line_${index + 1}`,
        code: order.standardCode || order.localCode || `manual_${index + 1}`,
        name: order.standardName || order.localName || "手入力明細",
        orderType: order.orderType || "other",
        points: 100,
        quantity: 1,
        totalPoints: 100,
        status: "candidate",
        source: "test"
      })),
      warnings: []
    };
  };

  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "再計算 太郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: CRP 1.2 を測定。"
  }, headers);
  const first = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const second = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {
      calculationMode: "reuse_clinical",
      orders: [{
        orderType: "other",
        localName: "手入力明細",
        standardCode: "999000001",
        standardName: "手入力明細",
        quantity: 1,
        sourceSystem: "fee_web_user_added"
      }]
    },
    headers,
    {
      clinicalFactsExtractor: async () => {
        throw new Error("clinical extractor should not run during reuse_clinical");
      }
    }
  );
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers
  );

  assert.equal(first.statusCode, 201);
  assert.equal(extractorCalls, 1);
  assert.equal(second.statusCode, 201);
  assert.equal(second.body.calculationResult.clinicalExtraction.source, "reuse_clinical");
  assert.equal(lastCalculationInput.orders[0].standardCode, "999000001");
  assert.equal(detail.body.feeSession.orders[0].standardCode, "999000001");
  assert.equal(detail.body.feeSession.calculationResult.inputSnapshot.orders[0].standardCode, "999000001");
});

test("records line-bound verified evidence on canonical clinical facts", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "炎症反応高値", status: "active", evidence: "炎症反応高値" }],
    clinical_events: [{
      type: "lab",
      name: "CRP",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "O: CRP 1.2 を測定。",
      search_queries: ["CRP"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "根拠 行子" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: [
      "S: 咽頭痛。",
      "O: CRP 1.2 を測定。",
      "A: 炎症反応高値。"
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
  const facts = calculation.body.calculationResult.canonicalClinicalFacts || [];
  const crpFact = facts.find((fact) => fact.clinicalName === "CRP");

  assert.equal(calculation.statusCode, 201);
  assert.ok(crpFact);
  assert.notEqual(crpFact.status, "excluded");
  assert.equal(crpFact.verification.status, "verified");
  assert.equal(crpFact.evidenceRefs[0].lineId, "O-001");
  assert.equal(crpFact.evidenceRefs[0].section, "O");
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => item.stage === "evidence_verifier"));
});

test("records deterministic rules calculation in shadow mode without changing primary input", async () => {
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
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "影算 太郎" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "胸部X線：異常なし。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const shadows = calculation.body.calculationResult.shadowCalculations || [];

  assert.equal(calculation.statusCode, 201);
  assert.equal(receivedInput.calculationOptions.imaging_orders, undefined);
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].mode, "shadow");
  assert.equal(shadows[0].pipeline, "deterministic_rules");
  assert.equal(shadows[0].status, "completed");
  assert.ok(shadows[0].diff.calculationOptionKeys.onlyInShadow.includes("imaging_orders"));
  assert.ok(Array.isArray(shadows[0].result.calculationOptions.imaging_orders));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => item.stage === "shadow_calculation"));
});

test("can disable deterministic shadow calculation with environment flag", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "影算 花子" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "胸部X線：異常なし。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { processEnv: { FEE_CALCULATION_SHADOW_MODE: "off" } }
  );

  assert.equal(calculation.statusCode, 201);
  assert.deepEqual(calculation.body.calculationResult.shadowCalculations, []);
});

test("blocks performed clinical events when evidence is only future or planned", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let masterLookupCount = 0;
  stores.feeCalculator.searchMaster = async () => {
    masterLookupCount += 1;
    return { items: [{ kind: "procedure", code: "160054710", name: "ＣＲＰ", points: 16 }] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "咽頭炎", status: "active", evidence: "咽頭炎" }],
    clinical_events: [{
      type: "lab",
      name: "CRP",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "unknown",
      certainty: "ambiguous",
      section: "P",
      evidence: "P: CRPは次回必要時に検討。",
      search_queries: ["CRP"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "予定 検太" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "P: CRPは次回必要時に検討。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const facts = calculation.body.calculationResult.canonicalClinicalFacts || [];
  const crpFact = facts.find((fact) => fact.clinicalName === "CRP");

  assert.equal(calculation.statusCode, 201);
  assert.equal(masterLookupCount, 0);
  assert.equal(crpFact.verification.status, "blocked");
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "根拠確認"));
});

test("does not let unrelated past or future context on the same line block exact evidence", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let masterLookupCount = 0;
  stores.feeCalculator.searchMaster = async () => {
    masterLookupCount += 1;
    return { items: [{ kind: "procedure", code: "160054710", name: "ＣＲＰ", points: 16 }] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "炎症反応高値", status: "active", evidence: "炎症反応高値" }],
    clinical_events: [{
      type: "lab",
      name: "CRP",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "今回CRP 1.2を測定。",
      search_queries: ["CRP"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "根拠 文子" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "O: 前回HbA1c 7.2。今回CRP 1.2を測定。次回HbA1c再検を検討。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const facts = calculation.body.calculationResult.canonicalClinicalFacts || [];
  const crpFact = facts.find((fact) => fact.clinicalName === "CRP");

  assert.equal(calculation.statusCode, 201);
  assert.equal(crpFact.verification.status, "verified");
  assert.equal(crpFact.evidenceRefs[0].lineId, "O-001");
  assert.equal(crpFact.evidenceRefs[0].approximate, undefined);
  assert.equal(crpFact.verification.reasons.includes("past_or_external_context"), false);
  assert.equal(crpFact.verification.reasons.includes("future_or_order_only_context"), false);
});

test("requires review instead of auto-coding when evidence only approximately matches the chart", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let masterLookupCount = 0;
  stores.feeCalculator.searchMaster = async () => {
    masterLookupCount += 1;
    return { items: [{ kind: "procedure", code: "160054710", name: "ＣＲＰ", points: 16 }] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "炎症反応高値", status: "active", evidence: "炎症反応高値" }],
    clinical_events: [{
      type: "lab",
      name: "CRP",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "CRP 高値を測定",
      search_queries: ["CRP"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "近似 根子" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "O: CRP高値を確認。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const facts = calculation.body.calculationResult.canonicalClinicalFacts || [];
  const crpFact = facts.find((fact) => fact.clinicalName === "CRP");

  assert.equal(calculation.statusCode, 201);
  assert.equal(masterLookupCount, 0);
  assert.equal(crpFact.status, "review_required");
  assert.equal(crpFact.verification.status, "review_required");
  assert.ok(crpFact.verification.reasons.includes("evidence_quote_approximate"));
  assert.equal(crpFact.evidenceRefs[0].approximate, true);
  assert.ok(calculation.body.reviewItems.some((item) => item.title === "根拠確認"));
  assert.ok((calculation.body.calculationResult.reviewIssues || []).some((issue) => (
    issue.sourceFactId === crpFact.factId
  )));
});

test("accepts evidence quotes wrapped by LLM quotation marks without weakening approximate matching", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let masterLookupCount = 0;
  stores.feeCalculator.searchMaster = async (input) => {
    masterLookupCount += 1;
    const query = String(input.query || "");
    if (/CRP|ＣＲＰ|C反応性蛋白/u.test(query)) {
      return {
        items: [{
          kind: "procedure",
          code: "160054710",
          name: "ＣＲＰ",
          points: 16,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    if (/血算|末梢血液一般|CBC/u.test(query)) {
      return {
        items: [{
          kind: "procedure",
          code: "160008010",
          name: "末梢血液一般検査",
          points: 21,
          feeCategory: "lab_test_basic",
          itemRole: "base",
          directRetrievalAllowed: true
        }]
      };
    }
    return { items: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
    diagnoses: [{ name: "炎症反応高値", status: "active", evidence: "炎症反応高値" }],
    clinical_events: [{
      type: "lab",
      name: "CRP",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "「院内で血算とCRPを測定。」",
      search_queries: ["CRP"]
    }, {
      type: "lab",
      name: "末梢血液一般検査（血算）",
      action_status: "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      result_assertion: "numeric",
      certainty: "explicit",
      section: "O",
      evidence: "「院内で血算とCRPを測定。」「同日に静脈採血を実施し、血液検体を提出した。」",
      search_queries: ["末梢血液一般検査", "血算"]
    }],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "引用 根子" },
    facilityId: "fac_001",
    serviceDate: "2026-06-14",
    clinicalText: "O: 院内で血算とCRPを測定。同日に静脈採血を実施し、血液検体を提出した。"
  }, headers);
  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  const facts = calculation.body.calculationResult.canonicalClinicalFacts || [];
  const crpFact = facts.find((fact) => fact.clinicalName === "CRP");
  const cbcFact = facts.find((fact) => fact.clinicalName === "末梢血液一般検査（血算）");
  const masterCandidates = calculation.body.calculationResult.masterCandidates || [];
  const billingCandidates = calculation.body.calculationResult.billingCandidates || [];

  assert.equal(calculation.statusCode, 201);
  assert.ok(masterLookupCount > 0);
  assert.equal(crpFact.status, "eligible_for_billing");
  assert.equal(cbcFact.status, "eligible_for_billing");
  assert.equal(crpFact.verification.status, "verified");
  assert.equal(cbcFact.verification.status, "verified");
  assert.ok(masterCandidates.some((candidate) => candidate.sourceFactId === crpFact.factId && candidate.masterCode === "160054710"));
  assert.ok(billingCandidates.some((candidate) => candidate.sourceFactId === crpFact.factId && candidate.code === "160054710"));
  assert.ok((calculation.body.calculationResult.clinicalExtraction.billingIntentCount || 0) >= 2);
  assert.ok(billingCandidates.some((candidate) => (
    candidate.sourceFactId === crpFact.factId
    && String(candidate.sourceBillingIntentId || "").startsWith("intent_")
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "billing_intent_builder"
    && Number(item.intentCount || 0) >= 2
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "source_fact_lineage"
    && Number(item.missingSourceFactIdCount || 0) === 0
    && Number(item.autoBillableEventCount || 0) >= 2
  )));
  assert.ok(calculation.body.calculationResult.clinicalExtraction.trace.some((item) => (
    item.stage === "master_linker"
    && item.sourceFactId === crpFact.factId
    && String(item.sourceBillingIntentId || "").startsWith("intent_")
  )));
  assert.equal(crpFact.verification.reasons.includes("evidence_quote_approximate"), false);
  assert.equal(cbcFact.verification.reasons.includes("evidence_quote_approximate"), false);
  assert.ok(crpFact.evidenceRefs.some((ref) => ref.quote === "院内で血算とCRPを測定。"));
  assert.ok(cbcFact.evidenceRefs.some((ref) => ref.quote === "同日に静脈採血を実施し、血液検体を提出した。"));
});

test("creates calculation jobs with input snapshots without marking sessions calculating when queue is unavailable", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "非同期 太郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "S: 咳嗽。O: インフル迅速陰性。"
  }, headers);
  const job = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs`,
    {},
    headers,
    { processEnv: {} }
  );
  const fetched = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs/${job.body.calculationJob.calculationJobId}`,
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

  assert.equal(job.statusCode, 202);
  assert.equal(job.body.calculationJob.status, "enqueue_failed");
  assert.equal(job.body.calculationJob.enqueueStatus, "not_configured");
  assert.equal(job.body.calculationJob.inputSnapshot.clinicalText, "S: 咳嗽。O: インフル迅速陰性。");
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.body.calculationJob.calculationJobId, job.body.calculationJob.calculationJobId);
  assert.notEqual(detail.body.feeSession.status, "calculating");
});

test("enqueues calculation jobs to Cloud Tasks when configured", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "非同期 花子" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: 胸部X線を実施。"
  }, headers);
  let taskRequest = null;
  const job = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs`,
    {},
    headers,
    {
      processEnv: {
        FEE_CALCULATION_CLOUD_TASKS_QUEUE: "fee-calculation",
        FEE_CALCULATION_WORKER_URL: "https://fee-api.test/v1/fee/internal/calculation-jobs/run",
        FEE_CALCULATION_WORKER_TOKEN: "worker-secret"
      },
      cloudTasksClient: {
        async createTask(requestBody) {
          taskRequest = requestBody;
          return { name: "task_fee_001" };
        }
      }
    }
  );
  const detail = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/detail`,
    undefined,
    headers
  );

  assert.equal(job.statusCode, 202);
  assert.equal(job.body.calculationJob.status, "queued");
  assert.equal(job.body.calculationJob.enqueueStatus, "queued");
  assert.equal(job.body.calculationJob.enqueueProvider, "cloud_tasks");
  assert.equal(detail.body.feeSession.status, "calculating");
  assert.equal(taskRequest.parent, "projects/medical-core-stg/locations/asia-northeast1/queues/fee-calculation");
  assert.equal(taskRequest.task.httpRequest.url, "https://fee-api.test/v1/fee/internal/calculation-jobs/run");
  assert.equal(taskRequest.task.httpRequest.headers["x-fee-worker-token"], "worker-secret");
  const payload = JSON.parse(Buffer.from(taskRequest.task.httpRequest.body, "base64").toString("utf8"));
  assert.equal(payload.orgId, "org_001");
  assert.equal(payload.feeSessionId, session.body.feeSession.feeSessionId);
  assert.equal(payload.calculationJobId, job.body.calculationJob.calculationJobId);
});

test("enqueues calculation jobs to Pub/Sub when configured", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "非同期 三郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: 尿定性を実施。"
  }, headers);
  let publishRequest = null;
  const job = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs`,
    {},
    headers,
    {
      processEnv: {
        FEE_CALCULATION_PUBSUB_TOPIC: "fee-calculation-topic"
      },
      pubSubClient: {
        async publishMessage(requestBody) {
          publishRequest = requestBody;
          return { messageId: "msg_fee_001" };
        }
      }
    }
  );

  assert.equal(job.statusCode, 202);
  assert.equal(job.body.calculationJob.status, "queued");
  assert.equal(job.body.calculationJob.enqueueProvider, "pubsub");
  assert.equal(publishRequest.topic, "projects/medical-core-stg/topics/fee-calculation-topic");
  assert.equal(publishRequest.message.attributes.type, "fee_calculation_job");
  const payload = JSON.parse(Buffer.from(publishRequest.message.data, "base64").toString("utf8"));
  assert.equal(payload.orgId, "org_001");
  assert.equal(payload.feeSessionId, session.body.feeSession.feeSessionId);
  assert.equal(payload.calculationJobId, job.body.calculationJob.calculationJobId);
});

test("runs queued calculation jobs through the internal worker route", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "非同期 次郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: CRPを実施。"
  }, headers);
  const job = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs`,
    {},
    headers,
    {
      processEnv: {
        FEE_CALCULATION_CLOUD_TASKS_QUEUE: "fee-calculation",
        FEE_CALCULATION_WORKER_URL: "https://fee-api.test/v1/fee/internal/calculation-jobs/run",
        FEE_CALCULATION_WORKER_TOKEN: "worker-secret"
      },
      cloudTasksClient: {
        async createTask() {
          return { name: "task_fee_002" };
        }
      }
    }
  );
  const worker = await request(
    stores,
    "POST",
    "/v1/fee/internal/calculation-jobs/run",
    {
      orgId: "org_001",
      feeSessionId: session.body.feeSession.feeSessionId,
      calculationJobId: job.body.calculationJob.calculationJobId
    },
    { "x-fee-worker-token": "worker-secret" },
    {
      processEnv: {
        FEE_CALCULATION_WORKER_TOKEN: "worker-secret"
      }
    }
  );
  const fetched = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs/${job.body.calculationJob.calculationJobId}`,
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

  assert.equal(worker.statusCode, 200);
  assert.equal(worker.body.calculationJob.status, "succeeded");
  assert.equal(worker.body.calculationJob.resultSummary.totalPoints, 137);
  assert.equal(fetched.body.calculationJob.status, "succeeded");
  assert.equal(detail.body.feeSession.calculationSummary.totalPoints, 137);
  assert.equal(detail.body.receiptDraft.totalPoints, 137);
  assert.notEqual(detail.body.feeSession.status, "calculating");
});

test("runs Pub/Sub push calculation job payloads through the internal worker route", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patient: { displayName: "非同期 四郎" },
    facilityId: "fac_001",
    serviceDate: "2026-05-28",
    clinicalText: "O: インフル迅速を実施。"
  }, headers);
  const job = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculation-jobs`,
    {},
    headers,
    {
      processEnv: {
        FEE_CALCULATION_PUBSUB_TOPIC: "fee-calculation-topic"
      },
      pubSubClient: {
        async publishMessage() {
          return { messageId: "msg_fee_002" };
        }
      }
    }
  );
  const payload = {
    orgId: "org_001",
    feeSessionId: session.body.feeSession.feeSessionId,
    calculationJobId: job.body.calculationJob.calculationJobId
  };
  const worker = await request(
    stores,
    "POST",
    "/v1/fee/internal/calculation-jobs/run",
    {
      message: {
        data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
      }
    },
    {},
    {
      env: "prod",
      processEnv: {
        FEE_CALCULATION_WORKER_AUTH_MODE: "iam"
      }
    }
  );

  assert.equal(worker.statusCode, 200);
  assert.equal(worker.body.calculationJob.status, "succeeded");
  assert.equal(worker.body.calculationJob.resultSummary.totalPoints, 137);
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

test("updates facility fee settings and records audit event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);

  const settings = await request(stores, "PATCH", "/v1/fee/settings/fac_001", {
    historyPolicy: {
      defaultLookbackMonths: 6,
      externalHistoryEnabled: true,
      historyCompleteness: "partial",
      missingHistoryBehavior: "review_required"
    },
    initialRevisitPolicy: {
      requireReviewWhenNoHistory: true
    },
    receiptPolicy: {
      ukeEncoding: "utf-8",
      blockExportOnErrors: true,
      connectorSpecVerified: true,
      validationSeverity: {
        patientBirthDate: "error",
        insuranceInsuredSymbol: "error"
      },
      annotationDefaults: {
        commentShinryoIdentification: "60",
        symptomDetailKubun: "01"
      }
    }
  }, headers);

  assert.equal(settings.statusCode, 200);
  assert.equal(settings.body.settings.facilityId, "fac_001");
  assert.equal(settings.body.settings.historyPolicy.defaultLookbackMonths, 6);
  assert.equal(settings.body.settings.historyPolicy.externalHistoryEnabled, true);
  assert.equal(settings.body.settings.historyPolicy.historyCompleteness, "partial");
  assert.equal(settings.body.settings.receiptPolicy.ukeEncoding, "utf-8");
  assert.equal(settings.body.settings.receiptPolicy.blockExportOnErrors, true);
  assert.equal(settings.body.settings.receiptPolicy.connectorSpecVerified, true);
  assert.equal(settings.body.settings.receiptPolicy.validationSeverity.patientBirthDate, "error");
  assert.equal(settings.body.settings.receiptPolicy.annotationDefaults.commentShinryoIdentification, "60");

  const bootstrap = await request(stores, "GET", "/v1/fee/settings", undefined, headers);
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.body.settings.fac_001.historyPolicy.defaultLookbackMonths, 6);
  assert.equal(bootstrap.body.settings.fac_001.receiptPolicy.ukeEncoding, "utf-8");

  const auditEvents = stores.platformStore.listAuditEvents("org_001");
  assert.ok(auditEvents.some((event) => event.eventType === "fee.settings_updated"));
});

test("imports external billing history for a patient", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "履歴 患者",
    birthDate: "1970-01-01",
    sex: "male"
  }, headers);

  const imported = await request(stores, "POST", `/v1/fee/patients/${patient.body.patient.patientId}/billing-history`, {
    serviceDate: "2026-04-10",
    source: "receipt_csv",
    lineItems: [{ code: "160000410", name: "生化学的検査判断料" }]
  }, headers);

  assert.equal(imported.statusCode, 201);
  assert.equal(imported.body.billingHistoryEvent.patientId, patient.body.patient.patientId);
  assert.equal(imported.body.billingHistoryEvent.lineItems[0].code, "160000410");

  const listed = await request(stores, "GET", `/v1/fee/patients/${patient.body.patient.patientId}/billing-history?limit=10`, undefined, headers);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.billingHistoryEvents.length, 1);
  assert.equal(listed.body.billingHistoryEvents[0].source, "receipt_csv");
});

test("runs clinic diagnosis on ingested receipts with claim checks and audit event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });

  // UKE取込(パース)・点検マスタlookup・病名コード化をフェイクで注入
  stores.feeCalculator.parseBaseline = async () => ({
    baselineClaims: [{
      patientId: "deadbeef01",
      claimMonth: "2026-06",
      sex: "2",
      birthDate: "3500615", // 昭和50年6月15日 → 2026-06時点50歳
      receiptType: "1112", // 医科・入院外
      diseases: [
        { code: "8834321", name: "妊娠", suspected: false },
        { code: "", name: "急性気管支炎の疑い", suspected: false }
      ],
      lines: [
        { code: "112007410", name: "再診料", points: 76, count: 1 },
        { code: "160008010", name: "末梢血液一般", points: 21, count: 1 },
        { code: "620000600", name: "アムロジピン錠", points: 1, count: 1 },
        { code: "620000601", name: "ワルファリン錠", points: 1, count: 1 }
      ]
    }, {
      patientId: "inpatient01",
      claimMonth: "2026-06",
      sex: "1",
      receiptType: "1111", // 医科・入院 → 外来前提のMI-003/MI-004は発火しない
      diseases: [],
      lines: [
        { code: "620000700", name: "入院用薬剤", points: 1, count: 1 }
      ]
    }, {
      patientId: "dpc01",
      claimMonth: "2026-06",
      receiptType: "3112", // DPC → 対象外スキップ
      diseases: [],
      lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }]
    }]
  });
  stores.feeCalculator.resolveDiseases = async ({ names }) => ({
    resolved: Object.fromEntries((names || []).map((name) => [
      name,
      name.includes("気管支") ? { code: "4660009", matchType: "exact", suspected: true } : { code: "", matchType: "none" }
    ]))
  });
  stores.feeCalculator.checkLookup = async () => ({
    drugIndications: { "620000600": [{ diseaseCode: "8830592", sex: "", ageMin: 0, ageMax: 999 }] },
    drugContraDiseases: { "620000600": ["8834321"] },
    drugInteractions: [["620000600", "620000601"]],
    actIndications: {},
    diseaseNames: { "8830592": "高血圧症", "8834321": "妊娠" },
    procedureMeta: { "160008010": { judgementKind: "1", judgementGroup: "2", name: "末梢血液一般" } }
  });

  const body = {
    claimMonth: "2026-06",
    baselineFormat: "uke",
    baselineContentBase64: Buffer.from("dummy", "utf8").toString("base64")
  };

  const prod = await request(stores, "POST", "/v1/fee/clinic-diagnosis", body, headers, { env: "prod" });
  assert.equal(prod.statusCode, 404); // STG限定

  const response = await request(stores, "POST", "/v1/fee/clinic-diagnosis", body, headers, { env: "stg" });
  assert.equal(response.statusCode, 200);
  const report = response.body.report;
  // DPCはスキップ、入院+外来の2claimが対象。取込サマリで可視化。
  assert.equal(response.body.ingestion.baselineClaimCount, 3);
  assert.equal(response.body.ingestion.analyzedClaimCount, 2);
  assert.equal(response.body.ingestion.inpatientClaimCount, 1);
  assert.equal(response.body.ingestion.dpcSkippedCount, 1);
  assert.equal(report.summary.claimCount, 2);
  assert.equal(report.summary.patientCount, 2);
  // 入院claimには外来前提の「基本診療料なし(MI-003)」「処方料もれ(MI-004)」を出さない
  const inpatientFindings = report.findings.filter((f) => f.patientKey === "inpatient01");
  assert.ok(!inpatientFindings.some((f) => f.ruleId === "MI-003" || f.ruleId === "MI-004"));
  // 算定もれ(判断料MI-002・処方料MI-004) と 査定リスク(適応なしIY-001/禁忌IY-003/併用IY-004)
  const rules = new Set(report.findings.map((f) => f.ruleId));
  assert.ok(rules.has("MI-002"), "検体検査判断料もれ");
  assert.ok(rules.has("MI-004"), "処方料もれ");
  assert.ok(rules.has("IY-001"), "適応病名なし");
  assert.ok(rules.has("IY-003"), "禁忌傷病名");
  assert.ok(rules.has("IY-004"), "併用禁忌");
  const iy003 = report.findings.find((f) => f.ruleId === "IY-003");
  assert.ok(iy003.message.includes("妊娠"));

  const audits = stores.platformStore.listAuditEvents("org_001");
  const audit = audits.find((event) => event.eventType === "fee.clinic_diagnosis_run");
  assert.ok(audit);
  assert.equal(audit.safePayload.claimCount, 2);
  assert.ok(audit.safePayload.billingMissCount >= 2);
  assert.ok(audit.safePayload.assessmentRiskCount >= 2);
});

test("runs baseline diagnosis with month-scoped sessions and records audit event", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });
  const june = stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "patA",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-06-10"
  });
  const may = stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "patA",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-05-10"
  });
  stores.feeStore.saveCalculation("org_001", june.feeSessionId, {
    provider: "test",
    status: "completed",
    lineItems: [{ code: "112007410", name: "再診料", points: 73, quantity: 1, status: "confirmed" }]
  });
  stores.feeStore.saveCalculation("org_001", may.feeSessionId, {
    provider: "test",
    status: "completed",
    lineItems: [{ code: "113001810", name: "特定疾患療養管理料", points: 225, quantity: 1, status: "confirmed" }]
  });

  const response = await request(stores, "POST", "/v1/fee/baseline-diagnosis", {
    claimMonth: "2026-06",
    baselineClaims: [
      { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 73, count: 1 }] },
      { patientId: "patA", claimMonth: "2026-05", lines: [{ code: "113001810", name: "特定疾患療養管理料", points: 225, count: 1 }] }
    ]
  }, headers, { env: "stg" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.patientCount, 1);
  assert.equal(response.body.summary.missingCandidateCount, 0);
  assert.equal(response.body.summary.needsReviewCount, 0);
  const auditEvents = stores.platformStore.listAuditEvents("org_001");
  assert.ok(auditEvents.some((event) => event.eventType === "fee.baseline_diagnosis_run" && event.safePayload.claimMonth === "2026-06"));
});

test("runs recalculation diff diagnosis from uploaded claim payloads without monthly sessions", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });
  const unrelated = stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "patA",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-06-10"
  });
  stores.feeStore.saveCalculation("org_001", unrelated.feeSessionId, {
    provider: "test",
    status: "completed",
    lineItems: [{ code: "999999999", name: "保存済みセッション由来", points: 999, quantity: 1, status: "confirmed" }]
  });
  const calls = [];
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    calls.push({ feeSession, calculationInput });
    const codes = calculationInput.claimContext.procedure_codes || [];
    return {
      provider: "test",
      status: "completed",
      totalPoints: codes.length * 100,
      lineItems: codes.map((code) => ({
        code,
        name: code === "113001810" ? "特定疾患療養管理料" : "再診料",
        points: code === "113001810" ? 225 : 73,
        quantity: 1,
        totalPoints: code === "113001810" ? 225 : 73,
        status: "confirmed"
      })),
      warnings: []
    };
  };
  const calculationPayloads = [{
    patient: { patient_id: "patA" },
    encounter: { service_date: "2026-06-10", is_outpatient: true },
    procedure_codes: ["112007410", "113001810"]
  }];

  const response = await request(stores, "POST", "/v1/fee/recalculation-diff-diagnosis", {
    claimMonth: "2026-06",
    baselineClaims: [
      { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 73, count: 1 }] }
    ],
    calculationPayloadContentBase64: Buffer.from(JSON.stringify(calculationPayloads), "utf8").toString("base64")
  }, headers, { env: "stg" });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feeSession.patientId, "patA");
  assert.equal(response.body.patientCount, 1);
  assert.equal(response.body.summary.missingCandidateCount, 1);
  assert.equal(response.body.diagnoses[0].findings[0].code, "113001810");
  assert.equal(response.body.diagnoses[0].findings.some((finding) => finding.code === "999999999"), false);
  const auditEvents = stores.platformStore.listAuditEvents("org_001");
  assert.ok(auditEvents.some((event) => event.eventType === "fee.recalculation_diff_diagnosis_run" && event.safePayload.calculationPayloadCount === 1));
});

test("builds recalculation diff claim payloads from uploaded patient chart order diagnosis files", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });
  const calls = [];
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    calls.push({ feeSession, calculationInput });
    const context = calculationInput.claimContext || {};
    const hasManagement = (context.procedure_codes || []).includes("113001810");
    return {
      provider: "test",
      status: "completed",
      totalPoints: hasManagement ? 301 : 76,
      lineItems: [
        { code: "112007410", name: "再診料", points: 76, quantity: 1, totalPoints: 76, status: "confirmed" },
        ...(hasManagement ? [{ code: "113001810", name: "特定疾患療養管理料", points: 225, quantity: 1, totalPoints: 225, status: "confirmed" }] : [])
      ],
      warnings: []
    };
  };
  stores.feeCalculator.parseBaseline = async () => ({
    baselineClaims: [
      { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }] }
    ]
  });

  const encode = (text) => Buffer.from(text, "utf8").toString("base64");
  const chartRecords = [
    { patient_id: "patA", service_date: "2026-06-10", clinical_text: "A：高血圧症。P：管理を継続。" },
    { patient_id: "patA", service_date: "2026-06-10", clinical_text: "O：血圧は目標範囲内。" }
  ];
  const response = await request(stores, "POST", "/v1/fee/recalculation-diff-diagnosis", {
    claimMonth: "2026-06",
    datasetFiles: [
      { fileName: "receipt.csv", format: "csv", contentBase64: encode("patient_id,claim_month,code,name,points,count\npatA,2026-06,112007410,再診料,76,1\n") },
      { fileName: "patients.csv", format: "csv", contentBase64: encode("patient_id,birth_date,sex,display_name\npatA,1970-01-01,male,山田 太郎\n") },
      { fileName: "charts.jsonl", format: "jsonl", contentBase64: encode(`${chartRecords.map((record) => JSON.stringify(record)).join("\n")}\n`) },
      { fileName: "orders.csv", format: "csv", contentBase64: encode("patient_id,service_date,order_type,code,name,status\npatA,2026-06-10,procedure,113001810,特定疾患療養管理料,performed\npatA,2026-06-10,procedure,140000610,創傷処置（１００ｃｍ２未満）,performed\npatA,2026-06-10,procedure_code,114001110,在宅患者訪問診療料（１）１（同一建物居住者以外）,performed\n") },
      { fileName: "diagnoses.csv", format: "csv", contentBase64: encode("patient_id,service_date,diagnosis_name,is_primary\npatA,2026-06-10,高血圧症,true\n") }
    ]
  }, headers, { env: "stg" });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].calculationInput.claimContext.patient.patient_id, "patA");
  assert.equal(calls[0].calculationInput.claimContext.patient.display_name, "山田 太郎");
  assert.equal(calls[0].calculationInput.claimContext.clinical_text.includes("高血圧症"), true);
  assert.equal(calls[0].calculationInput.claimContext.clinical_text.includes("血圧は目標範囲内"), true);
  assert.deepEqual(calls[0].calculationInput.claimContext.procedure_codes, ["113001810", "114001110"]);
  assert.equal(calls[0].calculationInput.claimContext.treatment_orders.length, 1);
  assert.equal(response.body.ingestion.calculationPayloadCount, 1);
  assert.equal(response.body.ingestion.stats.chartRecordCount, 2);
  assert.equal(response.body.diagnostics.receiptParse.format, "csv");
  assert.equal(response.body.diagnostics.receiptParse.lineCount, 1);
  assert.equal(response.body.diagnostics.recalculationAccuracy.sourceCodeCount, 3);
  assert.equal(response.body.diagnostics.recalculationAccuracy.engineCodeCount, 2);
  assert.equal(response.body.diagnostics.recalculationAccuracy.homeCareUnsupportedCount, 1);
  assert.equal(response.body.summary.missingCandidateCount, 1);
  assert.equal(response.body.diagnoses[0].findings[0].code, "113001810");
  assert.equal(response.body.summary.reproductionFailureCount, 2);
  assert.equal(response.body.reproductionFailures.find((row) => row.code === "140000610").sourceCount, 1);
  assert.equal(response.body.reproductionFailures.find((row) => row.code === "140000610").engineCount, 0);
  const homeFailure = response.body.reproductionFailures.find((row) => row.code === "114001110");
  assert.equal(homeFailure.supportStatus, "unsupported_home_care");
  assert.equal(homeFailure.supportStatusLabel, "当社未対応（在宅）");
});

test("recalculation diff dataset claimMonth overrides stale UI month", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });
  stores.feeCalculator.calculate = async (_feeSession, calculationInput) => ({
    provider: "test",
    status: "completed",
    totalPoints: 301,
    lineItems: [
      { code: "112007410", name: "再診料", points: 76, quantity: 1, totalPoints: 76, status: "confirmed" },
      { code: "113001810", name: "特定疾患療養管理料", points: 225, quantity: 1, totalPoints: 225, status: "confirmed" }
    ],
    warnings: [],
    inputContext: calculationInput.claimContext
  });

  const dataset = {
    manifest: { claimMonth: "2026-06" },
    baselineClaims: [
      { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }] }
    ],
    patients: [{ patient_id: "patA", birth_date: "1970-01-01", sex: "male" }],
    charts: [{ patient_id: "patA", service_date: "2026-06-10", clinical_text: "A：高血圧症。" }],
    orders: [{ patient_id: "patA", service_date: "2026-06-10", order_type: "procedure", code: "113001810", status: "performed" }],
    diagnoses: [{ patient_id: "patA", service_date: "2026-06-10", diagnosis_name: "高血圧症", is_primary: true }]
  };
  const response = await request(stores, "POST", "/v1/fee/recalculation-diff-diagnosis", {
    claimMonth: "2026-07",
    datasetFileName: "dataset.json",
    datasetFormat: "json",
    datasetContentBase64: Buffer.from(JSON.stringify(dataset), "utf8").toString("base64")
  }, headers, { env: "stg" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.claimMonth, "2026-06");
  assert.equal(response.body.summary.missingCandidateCount, 1);
});

test("recalculation diff multiple dataset files derive claimMonth from receipt data", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore, { globalRoles: [], productRoles: { fee: ["medical_clerk"] } });
  let parsedClaimMonth = "";
  stores.feeCalculator.parseBaseline = async (input) => {
    parsedClaimMonth = input.only_claim_month || input.claim_month || "";
    return {
      baselineClaims: [
        { patientId: "patA", claimMonth: "2026-06", lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }] }
      ]
    };
  };
  stores.feeCalculator.calculate = async () => ({
    provider: "test",
    status: "completed",
    totalPoints: 301,
    lineItems: [
      { code: "112007410", name: "再診料", points: 76, quantity: 1, totalPoints: 76, status: "confirmed" },
      { code: "113001810", name: "特定疾患療養管理料", points: 225, quantity: 1, totalPoints: 225, status: "confirmed" }
    ],
    warnings: []
  });

  const encode = (text) => Buffer.from(text, "utf8").toString("base64");
  const response = await request(stores, "POST", "/v1/fee/recalculation-diff-diagnosis", {
    claimMonth: "2026-07",
    datasetFiles: [
      { fileName: "receipt.csv", format: "csv", contentBase64: encode("patient_id,claim_month,code,name,points,count\npatA,2026-06,112007410,再診料,76,1\n") },
      { fileName: "patients.csv", format: "csv", contentBase64: encode("patient_id,birth_date,sex,display_name\npatA,1970-01-01,male,山田 太郎\n") },
      { fileName: "charts.jsonl", format: "jsonl", contentBase64: encode(`${JSON.stringify({ patient_id: "patA", service_date: "2026-06-10", clinical_text: "A：高血圧症。" })}\n`) },
      { fileName: "orders.csv", format: "csv", contentBase64: encode("patient_id,service_date,order_type,code,name,status\npatA,2026-06-10,procedure,113001810,特定疾患療養管理料,performed\n") },
      { fileName: "diagnoses.csv", format: "csv", contentBase64: encode("patient_id,service_date,diagnosis_name,is_primary\npatA,2026-06-10,高血圧症,true\n") }
    ]
  }, headers, { env: "stg" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.claimMonth, "2026-06");
  assert.equal(parsedClaimMonth, "2026-06");
  assert.equal(response.body.summary.missingCandidateCount, 1);
});

test("baseline diagnosis rejects missing csrf and viewer role", async () => {
  const stores = createStores();
  const adminHeaders = await signedHeaders(stores.platformStore);
  const csrfResponse = await request(stores, "POST", "/v1/fee/baseline-diagnosis", {
    claimMonth: "2026-06",
    baselineClaims: []
  }, { cookie: adminHeaders.cookie }, { env: "stg" });
  assert.equal(csrfResponse.statusCode, 403);

  stores.platformStore.createMember("org_001", {
    loginId: "viewer@example.com",
    displayName: "Viewer",
    globalRoles: [],
    productRoles: { fee: ["viewer"] },
    password: "viewer password"
  });
  const viewerHeaders = await signedHeaders(stores.platformStore, {
    loginId: "viewer@example.com",
    globalRoles: [],
    productRoles: { fee: ["viewer"] }
  });
  const viewerResponse = await request(stores, "POST", "/v1/fee/baseline-diagnosis", {
    claimMonth: "2026-06",
    baselineClaims: []
  }, viewerHeaders, { env: "stg" });
  assert.equal(viewerResponse.statusCode, 403);
});

test("baseline diagnosis is unavailable outside stg and rejects empty parsed uploads", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const prodResponse = await request(stores, "POST", "/v1/fee/baseline-diagnosis", {
    claimMonth: "2026-06",
    baselineClaims: []
  }, headers, { env: "prod" });
  assert.equal(prodResponse.statusCode, 404);

  const emptyUpload = await request(stores, "POST", "/v1/fee/baseline-diagnosis", {
    claimMonth: "2026-06",
    baselineFormat: "csv",
    baselineContentBase64: Buffer.from("patient_id,claim_month,code\n", "utf8").toString("base64")
  }, headers, { env: "stg" });
  assert.equal(emptyUpload.statusCode, 400);
  assert.match(emptyUpload.body.message, /既存レセを取り込めません/);
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
    async parseBaseline() {
      return { baselineClaims: [] };
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
    prefecture: "tokyo",
    facilityStandardKeys: options.facilityStandardKeys || []
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

async function signedHeaders(platformStore, options = {}) {
  const loginId = options.loginId || "admin@example.com";
  const identity = platformStore.getLoginIdentity("clinic", loginId);
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: options.globalRoles || ["org_admin"],
    productRoles: options.productRoles || { fee: ["admin"] },
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
    cloudTasksClient: overrides.cloudTasksClient,
    pubSubClient: overrides.pubSubClient,
    openAiApiKey: overrides.openAiApiKey,
    openAiFeeClinicalModel: overrides.openAiFeeClinicalModel,
    openAiFeeClinicalReasoningEffort: overrides.openAiFeeClinicalReasoningEffort,
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    processEnv: overrides.processEnv,
    startedAt: new Date("2026-05-28T00:00:00.000Z"),
    now: new Date("2026-05-28T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
}

test("allows netlify preview and localhost origins only outside production", async () => {
  const stores = createStores();
  const previewOrigin = "https://deploy-preview-42--halunasu-fee-stg.netlify.app";
  const localOrigin = "http://localhost:3000";

  const stgPreview = await request(stores, "GET", "/healthz", undefined, { origin: previewOrigin }, { env: "stg" });
  assert.equal(stgPreview.headers["access-control-allow-origin"], previewOrigin);
  const stgLocal = await request(stores, "GET", "/healthz", undefined, { origin: localOrigin }, { env: "stg" });
  assert.equal(stgLocal.headers["access-control-allow-origin"], localOrigin);

  const prodPreview = await request(stores, "GET", "/healthz", undefined, { origin: previewOrigin }, { env: "prod" });
  assert.equal(prodPreview.headers?.["access-control-allow-origin"], undefined);
  const prodLocal = await request(stores, "GET", "/healthz", undefined, { origin: localOrigin }, { env: "prod" });
  assert.equal(prodLocal.headers?.["access-control-allow-origin"], undefined);

  const prodCanonical = await request(stores, "GET", "/healthz", undefined, { origin: "https://fee.halunasu.com" }, { env: "prod" });
  assert.equal(prodCanonical.headers["access-control-allow-origin"], "https://fee.halunasu.com");
});

test("monthly summary rejects overflow instead of silently truncating sessions", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "pat_monthly_1",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-06-01"
  });
  stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "pat_monthly_2",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-06-02"
  });

  const response = await request(
    stores,
    "GET",
    "/v1/fee/monthly-summary?claimMonth=2026-06",
    undefined,
    headers,
    { processEnv: { FEE_MONTHLY_VIEW_SESSION_LIMIT: "1" } }
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /monthly view is limited to 1 sessions per claimMonth/);
});

test("monthly summary includes legacy sessions whose claimMonth is missing", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const legacy = stores.feeStore.createSession({
    orgId: "org_001",
    patientId: "pat_legacy",
    facilityId: "fac_001",
    createdByMemberId: "mem_001",
    serviceDate: "2026-06-02"
  });
  stores.feeStore.sessionsForOrg("org_001").set(legacy.feeSessionId, {
    ...legacy,
    claimMonth: null
  });

  const response = await request(
    stores,
    "GET",
    "/v1/fee/monthly-summary?claimMonth=2026-06",
    undefined,
    headers
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sessionCount, 1);
  assert.equal(response.body.patients[0].patientId, "pat_legacy");
  assert.equal(response.body.patients[0].sessions[0].claimMonth, "2026-06");
});

test("exports a receipt CSV with billing summary", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "山田 太郎",
    birthDate: "1970-01-01",
    sex: "male",
    insurance: { insurerType: "shaho", insurerNumber: "01130012", insuredSymbol: "12", insuredNumber: "3456" }
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-05-28",
    clinicalText: "咳嗽。処方あり。",
    orders: [{ orderId: "ord_1", orderType: "drug", localName: "カルボシステイン錠", quantity: 2 }]
  }, headers);
  await request(
    stores, "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {}, headers
  );
  const csv = await request(
    stores, "GET",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/receipt.csv`,
    undefined, headers
  );

  assert.equal(csv.statusCode, 200);
  assert.equal(csv.raw, true);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.headers["content-disposition"], /receipt_.*\.csv/);
  assert.equal(typeof csv.body, "string");
  assert.equal(csv.body.charCodeAt(0), 0xFEFF, "starts with UTF-8 BOM");
  assert.match(csv.body, /claimMonth,patientId,serviceDate/);
  assert.match(csv.body, /summary,totalPoints,totalFee,burdenRatio,copay,insurerPay/);
  assert.match(csv.body, /01130012/); // insurer number from snapshot
});

test("receipt CSV returns 404 for unknown session", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const missing = await request(stores, "GET", "/v1/fee/sessions/fee_missing/receipt.csv", undefined, headers);
  assert.equal(missing.statusCode, 404);
});

test("exports a receipt UKE in Shift_JIS by default and UTF-8 on request", async () => {
  const { decode } = (await import("iconv-lite")).default;
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  const patient = await request(stores, "POST", "/v1/fee/patients", {
    displayName: "山田 太郎",
    birthDate: "1970-01-02",
    sex: "male",
    insurance: { insurerType: "shaho", insurerNumber: "01130012", insuredSymbol: "12", insuredNumber: "3456" }
  }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    departmentId: "dep_001",
    serviceDate: "2026-05-28",
    clinicalText: "咳嗽。処方あり。",
    orders: [{ orderId: "ord_1", orderType: "drug", localName: "カルボシステイン錠", quantity: 2 }]
  }, headers);
  await request(stores, "POST", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`, {}, headers);

  const sjis = await request(stores, "GET", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/receipt.uke`, undefined, headers);
  assert.equal(sjis.statusCode, 200);
  assert.equal(sjis.raw, true);
  assert.match(sjis.headers["content-type"], /charset=shift_jis/);
  assert.match(sjis.headers["content-disposition"], /receipt_.*\.UKE/);
  assert.ok(Buffer.isBuffer(sjis.body));
  const decoded = decode(sjis.body, "Shift_JIS");
  assert.match(decoded, /^IR,/);
  assert.match(decoded, /\r\nRE,/);
  assert.match(decoded, /山田 太郎/);

  const utf8 = await request(stores, "GET", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/receipt.uke?encoding=utf-8`, undefined, headers);
  assert.match(utf8.headers["content-type"], /charset=utf-8/);
  assert.match(utf8.body.toString("utf-8"), /^IR,/);

  await request(stores, "PATCH", "/v1/fee/settings/fac_001", {
    receiptPolicy: {
      ukeEncoding: "utf-8",
      connectorSpecVerified: true
    }
  }, headers);
  const configured = await request(stores, "GET", `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/receipt.uke`, undefined, headers);
  assert.match(configured.headers["content-type"], /charset=utf-8/);
  assert.equal(configured.headers["x-halunasu-connector-status"], "spec-verified");
});

test("施設恒常算定ルール: 届出キー・confirm/candidate・在宅受診区分の外来基本料抑制", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => ({ query: input.query, type: input.type, items: [] });
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return {
      provider: "test_fee_engine",
      source: "test",
      status: "completed",
      totalPoints: 890,
      lineItems: [{
        lineId: "visit_fee",
        code: "114001110",
        name: "在宅患者訪問診療料（１）１",
        orderType: "procedure",
        points: 890,
        quantity: 1,
        totalPoints: 890,
        status: "needs_review",
        source: "medical_procedure_master"
      }],
      warnings: []
    };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  const settings = await request(stores, "PATCH", "/v1/fee/settings/fac_001", {
    facilityStandards: [
      { key: "zaitaku_data_teishutsu", name: "在宅データ提出加算", claimStartDate: "2026-01-01", status: "active" },
      { key: "expired_key", name: "期限切れ", claimStartDate: "2025-01-01", effectiveTo: "2025-12-31", status: "active" }
    ],
    autoBillingRules: [
      { ruleId: "home_visit_fee", title: "在宅患者訪問診療料", code: "114001110", action: "confirm", settings: ["home_visit"] },
      { ruleId: "data_addon", title: "在宅データ提出加算", code: "114057970", action: "candidate", settings: ["home_visit"], requiredFacilityStandardKey: "zaitaku_data_teishutsu", potentialPoints: 50 },
      { ruleId: "gated_off", title: "未届出ルール", code: "199999999", action: "confirm", settings: ["home_visit"], requiredFacilityStandardKey: "not_registered" },
      { ruleId: "outpatient_only", title: "外来専用ルール", code: "188888888", action: "confirm", settings: ["outpatient"] }
    ]
  }, headers);
  assert.equal(settings.statusCode, 200);
  assert.equal(settings.body.settings.autoBillingRules.length, 4);

  const patient = await request(stores, "POST", "/v1/fee/patients", { displayName: "在宅ルール患者" }, headers);
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-11",
    setting: "home_visit",
    clinicalText: "定期訪問。バイタル安定。処方継続。"
  }, headers);
  assert.equal(session.statusCode, 201);
  assert.equal(session.body.feeSession.setting, "home_visit");

  const calculation = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${session.body.feeSession.feeSessionId}/calculate`,
    {},
    headers,
    { clinicalFactsExtractor }
  );
  assert.equal(calculation.statusCode, 201);

  // confirmルール: 算定入力へ追加(エンジンがマスタ照合・制約チェック)。設定対象外・未届出は追加されない。
  assert.ok(receivedInput.calculationOptions.procedure_codes.includes("114001110"));
  assert.ok(!receivedInput.calculationOptions.procedure_codes.includes("199999999"));
  assert.ok(!receivedInput.calculationOptions.procedure_codes.includes("188888888"));
  // fee設定の届出キー(有効期間内のみ)が施設基準キーへ合流する
  assert.ok(receivedInput.calculationOptions.facility_standard_keys.includes("zaitaku_data_teishutsu"));
  assert.ok(!receivedInput.calculationOptions.facility_standard_keys.includes("expired_key"));
  // 在宅受診区分では外来基本料を自動算定しない
  assert.equal(receivedInput.calculationOptions.outpatient_basic, undefined);

  // candidateルール: 承認待ち候補として提示される
  const facilityProposal = calculation.body.calculationResult.candidateProposals
    .find((proposal) => proposal.code === "114057970");
  assert.ok(facilityProposal, "施設ルール候補が提示される");
  assert.equal(facilityProposal.basis, "facility_auto_billing_rule");
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => warning.includes("在宅区分の算定方針")));
  // confirmで自動追加した明細は出所が警告として明示される
  assert.ok(calculation.body.calculationResult.warnings.some((warning) => (
    warning.includes("施設恒常算定ルール") && warning.includes("114001110")
  )));
  // 在宅区分ではMI-003(基本診療料なし)を指摘しない
  assert.ok(!calculation.body.calculationResult.reviewIssues.some((issue) => issue.ruleId === "MI-003"));
});

test("既存レセ一括取込が外部請求履歴になり、初診/再診判定に使われる", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  let receivedInput = null;
  stores.feeCalculator.searchMaster = async (input) => ({ query: input.query, type: input.type, items: [] });
  stores.feeCalculator.calculate = async (feeSession, calculationInput) => {
    receivedInput = calculationInput;
    return { provider: "test", source: "test", status: "completed", totalPoints: 76, lineItems: [], warnings: [] };
  };
  const clinicalFactsExtractor = async () => ({
    visit_type: { kind: "unknown", evidence: "", confidence: "low" },
    diagnoses: [{ name: "高血圧症", status: "confirmed", evidence: "高血圧症の継続管理" }],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });

  await request(stores, "PATCH", "/v1/fee/settings/fac_001", {
    historyPolicy: { externalHistoryEnabled: true, historyCompleteness: "partial" }
  }, headers);

  const patient = await request(stores, "POST", "/v1/fee/patients", { displayName: "履歴取込患者" }, headers);
  const patientId = patient.body.patient.patientId;

  // UKE由来のbaselineClaims(患者×月)を外部請求履歴として一括取込
  const imported = await request(stores, "POST", `/v1/fee/patients/${patientId}/billing-history/import-baseline`, {
    baselineClaims: [
      {
        patientId: "1001",
        claimMonth: "2026-05",
        lines: [{ code: "112007410", name: "再診料", points: 76, count: 2 }]
      },
      {
        patientId: "1001",
        claimMonth: "2026-04",
        lines: [{ code: "113002310", name: "特定疾患療養管理料", points: 225, count: 1 }]
      }
    ],
    externalPatientId: "1001"
  }, headers);
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.body.importedClaimCount, 2);

  // externalPatientId無しで複数患者のレセが混ざっている入力は拒否する
  const mixed = await request(stores, "POST", `/v1/fee/patients/${patientId}/billing-history/import-baseline`, {
    baselineClaims: [
      { patientId: "1001", claimMonth: "2026-03", lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }] },
      { patientId: "1002", claimMonth: "2026-03", lines: [{ code: "112007410", name: "再診料", points: 76, count: 1 }] }
    ]
  }, headers);
  assert.equal(mixed.statusCode, 400);

  const listed = await request(stores, "GET", `/v1/fee/patients/${patientId}/billing-history`, undefined, headers);
  assert.equal(listed.body.billingHistoryEvents.length, 2);
  assert.ok(listed.body.billingHistoryEvents.every((event) => event.source === "baseline_import"));

  // 取り込んだ履歴により、履歴ゼロの新規患者でも「再診」判定になる(初診料の誤確定防止)
  const session = await request(stores, "POST", "/v1/fee/sessions", {
    patientId,
    facilityId: "fac_001",
    serviceDate: "2026-06-10",
    clinicalText: "高血圧症の継続管理。血圧安定。"
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
  assert.equal(receivedInput.calculationOptions.outpatient_basic.fee_kind, "revisit");
});
