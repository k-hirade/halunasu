import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
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
        order_type: "drug",
        local_name: "カルボシステイン錠",
        quantity: "3"
      }
    ]
  });

  assert.equal(normalized.patientId, "pat_123");
  assert.equal(normalized.patientRef, "legacy-001");
  assert.equal(normalized.facilityId, "fac_123");
  assert.equal(normalized.departmentId, "dep_123");
  assert.equal(normalized.claimMonth, "2026-05");
  assert.equal(normalized.orders[0].orderType, "drug");
  assert.equal(normalized.orders[0].quantity, 3);
});

test("requires patientId or inline patient", () => {
  assert.throws(() => validateCreateFeeSessionInput({
    facilityId: "fac_123",
    serviceDate: "2026-05-28"
  }), /patientId or patient is required/);
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
    }
  });

  assert.equal(input.orders[0].orderType, "lab");
  assert.deepEqual(input.claimContext.procedure_codes, ["160000410"]);
});
