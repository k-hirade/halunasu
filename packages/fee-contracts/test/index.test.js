import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateUpdateFeeSessionInput,
  validateCreateFeeCalculationInput,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  isClinicalDateRatioFalsePositiveContext
} from "../src/index.js";

test("normalizes fee session input to Platform identifiers", () => {
  const normalized = validateCreateFeeSessionInput({
    patient_id: "pat_123",
    patient_ref: "legacy-001",
    facility_id: "fac_123",
    department_id: "dep_123",
    service_date: "2026-05-28",
    claim_month: "2026-05",
    setting: "outpatient",
    clinical_text: "咳嗽。処方あり。",
    order_texts: [
      {
        order_id: "ord_1",
        order_type: "material",
        local_name: "テスト特定器材",
        standard_code: "710000001",
        quantity: "3"
      }
    ],
    claim_context: {
      material_inputs: [{ code: "710000001", quantity: 3 }]
    },
    calculation_options: {
      facility_standard_keys: ["検体検査管理加算1"]
    }
  });

  assert.equal(normalized.patientId, "pat_123");
  assert.equal(normalized.patientRef, "legacy-001");
  assert.equal(normalized.facilityId, "fac_123");
  assert.equal(normalized.departmentId, "dep_123");
  assert.equal(normalized.claimMonth, "2026-05");
  assert.equal(normalized.orders[0].orderType, "material");
  assert.equal(normalized.orders[0].quantity, 3);
  assert.equal(normalized.orders[0].sourceSystem, undefined);
  assert.deepEqual(normalized.claimContext.material_inputs, [{ code: "710000001", quantity: 3 }]);
  assert.deepEqual(normalized.calculationOptions.facility_standard_keys, ["検体検査管理加算1"]);
});

test("preserves user-added fee order audit metadata", () => {
  const normalized = validateUpdateFeeSessionInput({
    orders: [{
      orderType: "procedure",
      localName: "外来管理加算",
      standardCode: "112011010",
      standardName: "外来管理加算",
      quantity: 1,
      sourceSystem: "fee_web_user_added",
      sourceLabel: "ユーザー追加",
      note: "医事確認により追加",
      createdAt: "2026-06-16T00:00:00.000Z",
      createdBy: "user_1"
    }]
  });

  assert.equal(normalized.orders[0].sourceSystem, "fee_web_user_added");
  assert.equal(normalized.orders[0].sourceLabel, "ユーザー追加");
  assert.equal(normalized.orders[0].note, "医事確認により追加");
  assert.equal(normalized.orders[0].createdAt, "2026-06-16T00:00:00.000Z");
  assert.equal(normalized.orders[0].createdBy, "user_1");
});

test("allows draft fee session input before patient and facility are selected", () => {
  const normalized = validateCreateFeeSessionInput({});

  assert.equal(normalized.patientId, undefined);
  assert.equal(normalized.facilityId, undefined);
});

test("normalizes fee session update input", () => {
  const normalized = validateUpdateFeeSessionInput({
    patient_id: "pat_123",
    facility_id: "fac_123",
    department_id: null,
    service_date: "2026-05-29",
    clinical_text: "",
    orders: [],
    claimContext: null,
    calculationOptions: {
      history: {
        same_month_history_codes: ["160000410"]
      }
    },
    monthly_claim_work: {
      status: "diagnosis_requested",
      note: "病名出し済み",
      diagnosis_candidates: [{ name: "急性上気道炎" }],
      diagnosis_request_reason: "病名不足のため確認",
      doctor_name: "山田医師",
      collected_result: "急性上気道炎",
      applied_diagnosis_names: ["急性上気道炎"]
    },
    receipt_annotations: {
      comments: [{
        status: "confirmed",
        shinryo_identification: "60",
        code: "830000001",
        text: "コメント本文",
        source_review_item_id: "review_1"
      }],
      symptom_details: [{
        status: "draft",
        kubun: "01",
        text: "症状詳記本文"
      }]
    }
  });

  assert.equal(normalized.patientId, "pat_123");
  assert.equal(normalized.facilityId, "fac_123");
  assert.equal(normalized.departmentId, null);
  assert.equal(normalized.claimMonth, "2026-05");
  assert.equal(normalized.clinicalText, "");
  assert.deepEqual(normalized.orders, []);
  assert.equal(normalized.claimContext, null);
  assert.deepEqual(normalized.calculationOptions.history.same_month_history_codes, ["160000410"]);
  assert.equal(normalized.monthlyClaimWork.status, "diagnosis_requested");
  assert.equal(normalized.monthlyClaimWork.note, "病名出し済み");
  assert.equal(normalized.monthlyClaimWork.diagnosisCandidates[0].name, "急性上気道炎");
  assert.equal(normalized.monthlyClaimWork.diagnosisRequestReason, "病名不足のため確認");
  assert.equal(normalized.monthlyClaimWork.doctorName, "山田医師");
  assert.equal(normalized.monthlyClaimWork.collectedResult, "急性上気道炎");
  assert.deepEqual(normalized.monthlyClaimWork.appliedDiagnosisNames, ["急性上気道炎"]);
  assert.equal(normalized.receiptAnnotations.comments[0].status, "confirmed");
  assert.equal(normalized.receiptAnnotations.comments[0].shinryoIdentification, "60");
  assert.equal(normalized.receiptAnnotations.comments[0].sourceReviewItemId, "review_1");
  assert.equal(normalized.receiptAnnotations.symptomDetails[0].kubun, "01");
});

test("validates shared patient shape for fee patient creation", () => {
  const patient = validateCreateFeePatientInput({
    display_name: "山田 太郎",
    birth_date: "1970-01-01",
    sex: "male",
    external_patient_ids: ["legacy-001"]
  });

  assert.equal(patient.displayName, "山田 太郎");
  assert.deepEqual(patient.externalPatientIds, ["legacy-001"]);
});

test("normalizes calculation override input", () => {
  const input = validateCreateFeeCalculationInput({
    orders: [
      {
        content: "採血",
        orderType: "lab"
      }
    ],
    claimContext: {
      procedure_codes: ["160000410"]
    },
    calculationOptions: {
      comment_inputs: [{ code: "840000001", text: "コメント" }]
    },
    calculationMode: "reuse_clinical"
  });

  assert.equal(input.orders[0].orderType, "lab");
  assert.deepEqual(input.claimContext.procedure_codes, ["160000410"]);
  assert.deepEqual(input.calculationOptions.comment_inputs[0], { code: "840000001", text: "コメント" });
  assert.equal(input.calculationMode, "reuse_clinical");
});

test("detects performed blood collection using the shared strict predicate", () => {
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 静脈採血を実施し、血液検体を提出した。"), true);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 静脈採血でCRP 0.3mg/dLを確認した。"), true);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 採血の必要性を確認した。"), false);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("既往歴: 静脈血栓症。O: 尿検査を実施。"), false);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 血清Cr 1.2mg/dL、尿一般を確認。"), false);
  assert.equal(hasPerformedBloodCollectionEvidence({ specimen: "血清" }), true);
  assert.equal(hasPerformedBloodCollectionEvidence({ payload: { collection_method: "blood_venous" } }), true);
});

test("filters pain-scale ratios from clinical date extraction contexts", () => {
  assert.equal(isClinicalDateRatioFalsePositiveContext("疼痛 NRS 7/10、VAS 6/10"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("血圧 130/80"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10 再診、採血実施"), false);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10に再診予定"), false);
});
