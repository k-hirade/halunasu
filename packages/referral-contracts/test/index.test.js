import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateReferralDraftInput,
  validateCreateReferralPatientInput,
  validatePatchReferralDraftInput,
  validateReferralAssistantSuggestion,
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
    diagnoses: "咳嗽\n気管支炎",
    referral_form_sections: {
      referral_purpose: "精査依頼",
      clinical_course_and_findings: "咳嗽が持続しています。",
      diagnoses: ["咳嗽", "気管支炎"],
      current_medications: "内服薬A\n内服薬B"
    },
    source_evidence_refs: [{
      evidence_id: "evidence_001",
      source_product: "charting",
      source_type: "encounter",
      source_id: "enc_001",
      excerpt: "S：咳嗽。"
    }],
    section_evidence: {
      diagnoses: ["evidence_001"]
    }
  });

  assert.equal(input.patientId, "pat_123");
  assert.equal(input.facilityId, "fac_123");
  assert.equal(input.departmentId, "dep_123");
  assert.equal(input.authorMemberId, "mem_123");
  assert.equal(input.recipientInstitution.medicalInstitutionCode, "9912345");
  assert.deepEqual(input.diagnoses, ["咳嗽", "気管支炎"]);
  assert.equal(input.referralFormSections.referralPurpose, "精査依頼");
  assert.deepEqual(input.referralFormSections.currentMedications, ["内服薬A", "内服薬B"]);
  assert.equal(input.sourceEvidenceRefs[0].sourceProduct, "charting");
  assert.deepEqual(input.sectionEvidence.diagnoses, ["evidence_001"]);
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

test("normalizes assistant suggestions with section-level evidence", () => {
  const suggestion = validateReferralAssistantSuggestion({
    provider: "halunasu_draft_assistant",
    purpose: "精査依頼",
    diagnoses: ["咳嗽"],
    sections: {
      referralPurpose: {
        text: "咳嗽精査をお願いします。",
        evidenceIds: ["evidence_001"],
        needsReview: false
      }
    },
    warnings: ["根拠確認が必要です"]
  });

  assert.equal(suggestion.provider, "halunasu_draft_assistant");
  assert.equal(suggestion.sections.referralPurpose.text, "咳嗽精査をお願いします。");
  assert.deepEqual(suggestion.sections.referralPurpose.evidenceIds, ["evidence_001"]);
  assert.deepEqual(suggestion.diagnoses, ["咳嗽"]);
});
