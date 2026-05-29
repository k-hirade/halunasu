import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateReferralDraftInput,
  validateCreateReferralPatientInput,
  validatePatchReferralDraftInput,
  validateRenderReferralDocumentInput
} from "../src/index.js";

test("normalizes referral draft input to Platform references", () => {
  const input = validateCreateReferralDraftInput({
    patient_id: "pat_123",
    facility_id: "fac_123",
    department_id: "dep_123",
    author_member_id: "mem_123",
    recipient_institution: {
      display_name: "紹介先病院",
      medical_institution_code: "9912345"
    },
    recipient_doctor: {
      display_name: "紹介 先生"
    },
    purpose: "精査依頼",
    clinical_summary: "咳嗽が持続しています。",
    diagnoses: "咳嗽\n気管支炎"
  });

  assert.equal(input.patientId, "pat_123");
  assert.equal(input.facilityId, "fac_123");
  assert.equal(input.departmentId, "dep_123");
  assert.equal(input.authorMemberId, "mem_123");
  assert.equal(input.recipientInstitution.medicalInstitutionCode, "9912345");
  assert.deepEqual(input.diagnoses, ["咳嗽", "気管支炎"]);
});

test("requires core Platform references and recipient snapshots", () => {
  assert.throws(() => validateCreateReferralDraftInput({}), /patientId is required/);
  assert.throws(() => validateCreateReferralDraftInput({
    patientId: "pat_123",
    facilityId: "fac_123",
    departmentId: "dep_123",
    recipientInstitution: { displayName: "紹介先病院" },
    recipientDoctor: {},
    purpose: "精査依頼",
    clinicalSummary: "咳嗽"
  }), /recipientDoctor.displayName is required/);
});

test("validates shared patient creation input", () => {
  const patient = validateCreateReferralPatientInput({
    display_name: "山田 太郎",
    birth_date: "1970-01-01",
    sex: "male"
  });

  assert.equal(patient.displayName, "山田 太郎");
});

test("normalizes patch and document render input", () => {
  const patch = validatePatchReferralDraftInput({
    status: "ready",
    medications: "内服薬A\n内服薬B"
  });
  const document = validateRenderReferralDocumentInput({
    file_name: "referral.html",
    requested_at: "2026-05-28T00:00:00.000Z"
  });

  assert.equal(patch.status, "ready");
  assert.deepEqual(patch.medications, ["内服薬A", "内服薬B"]);
  assert.equal(document.fileName, "referral.html");
  assert.equal(document.requestedAt, "2026-05-28T00:00:00.000Z");
});
