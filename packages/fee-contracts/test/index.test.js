import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateUpdateFeeSessionInput,
  validateCreateFeeCalculationInput
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
  assert.deepEqual(normalized.claimContext.material_inputs, [{ code: "710000001", quantity: 3 }]);
  assert.deepEqual(normalized.calculationOptions.facility_standard_keys, ["検体検査管理加算1"]);
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
    }
  });

  assert.equal(input.orders[0].orderType, "lab");
  assert.deepEqual(input.claimContext.procedure_codes, ["160000410"]);
  assert.deepEqual(input.calculationOptions.comment_inputs[0], { code: "840000001", text: "コメント" });
});
