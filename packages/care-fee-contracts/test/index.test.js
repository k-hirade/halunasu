import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARE_EMERGENCY_CSV_SCHEMA_VERSION,
  CARE_EMERGENCY_INPUT_COLUMNS,
  CareFeeValidationError,
  normalizeEmergencyTreatmentRow,
  validateCareFeeEpisodeDecisionInput,
  validateCareFeeEpisodeRowsInput,
  validateCareFeeEvidenceEventInput,
  validateCareFeeFacilitySettingsInput,
  validateEmergencyTreatmentRow
} from "../src/index.js";

test("normalizes a valid emergency treatment row without inferring blank facts", () => {
  const row = normalizeEmergencyTreatmentRow(validRow(), { rowNumber: 2 });

  assert.equal(row.rowNumber, 2);
  assert.equal(row.schemaVersion, CARE_EMERGENCY_CSV_SCHEMA_VERSION);
  assert.equal(row.severeRespiratoryFailure, true);
  assert.equal(row.severeShock, null);
  assert.equal(row.existingEmergencyClaimCountMonth, 0);
});

test("keeps false distinct from unknown", () => {
  const input = validRow();
  input.severe_respiratory_failure = "false";
  input.severe_shock = "";
  const row = normalizeEmergencyTreatmentRow(input);

  assert.equal(row.severeRespiratoryFailure, false);
  assert.equal(row.severeShock, null);
});

test("returns all structural errors with row and field locations", () => {
  const input = validRow();
  input.claim_month = "2026-07";
  input.medication_performed = "true";
  input.medication_detail = "";
  input.physician_confirmed_by = "";
  input.existing_emergency_claim_count_month = "x";
  const result = validateEmergencyTreatmentRow(input, { rowNumber: 4 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "claim_month_mismatch"));
  assert.ok(result.issues.some((entry) => entry.field === "medication_detail"));
  assert.ok(result.issues.some((entry) => entry.field === "physician_confirmed_by"));
  assert.ok(result.issues.every((entry) => entry.rowNumber === 4));
});

test("validates versioned evidence events and their rows", () => {
  const value = validateCareFeeEvidenceEventInput({
    contractVersion: "care-fee-evidence-v1",
    orgId: "org_001",
    sourceProduct: "fee",
    sourceRecordId: "fee_001",
    sourceRevisionHash: "a".repeat(64),
    facilityId: "fac_001",
    facilityCode: "facility-001",
    patientKey: "patient-001",
    observedAt: "2026-08-01T10:00:00+09:00",
    rows: [validRow()]
  });

  assert.equal(value.rows.length, 1);
  assert.equal(value.orgId, "org_001");
  assert.equal(value.rows[0].inputOrigin, "csv_export");
});

test("accepts incomplete clinical evidence for needs-review evaluation", () => {
  const row = validRow();
  row.acute_diagnosis = "";
  row.onset_at = "";
  row.emergency_care_rationale = "";
  row.medication_detail = "";
  const value = validateCareFeeEvidenceEventInput({
    contractVersion: "care-fee-evidence-v1",
    orgId: "org_001",
    sourceProduct: "fee",
    sourceRecordId: "fee_001",
    sourceRevisionHash: "a".repeat(64),
    facilityId: "fac_001",
    facilityCode: "facility-001",
    patientKey: "patient-001",
    evidenceMetadata: {
      extractorVersion: "fee-adapter-v1",
      confidence: 0.5,
      sourceScope: "fee_session"
    },
    rows: [row]
  });

  assert.equal(value.rows[0].acuteDiagnosis, "");
  assert.equal(value.rows[0].onsetAt, "");
  assert.equal(value.evidenceMetadata.extractorVersion, "fee-adapter-v1");
  assert.equal(value.evidenceMetadata.confidence, 0.5);
});

test("keeps standalone CSV validation strict for incomplete clinical facts", () => {
  const row = validRow();
  row.onset_at = "";
  row.medication_detail = "";

  assert.equal(validateEmergencyTreatmentRow(row).ok, false);
});

test("rejects unsupported evidence contracts", () => {
  assert.throws(() => validateCareFeeEvidenceEventInput({
    contractVersion: "v0",
    orgId: "org_001",
    sourceProduct: "fee",
    sourceRecordId: "fee_001",
    sourceRevisionHash: "a".repeat(64),
    facilityId: "fac_001",
    facilityCode: "facility-001",
    patientKey: "patient-001",
    rows: [validRow()]
  }), CareFeeValidationError);
});

test("validates facility settings, managed rows, and review decisions", () => {
  const settings = validateCareFeeFacilitySettingsInput({
    facilityId: "fac_001",
    facilityCode: "facility-001",
    timezone: "Asia/Tokyo",
    emergencyServiceCodes: { care_medical_institution: "556000" }
  });
  const episode = validateCareFeeEpisodeRowsInput({ facilityId: "fac_001", rows: [validRow()] });
  const decision = validateCareFeeEpisodeDecisionInput({ status: "excluded", reason: "他制度で算定" });

  assert.equal(settings.emergencyServiceCodes.care_medical_institution, "556000");
  assert.equal(episode.rows.length, 1);
  assert.equal(decision.status, "excluded");
  assert.throws(() => validateCareFeeEpisodeDecisionInput({ status: "excluded" }), CareFeeValidationError);
});

test("declares each CSV input column once", () => {
  assert.equal(new Set(CARE_EMERGENCY_INPUT_COLUMNS).size, CARE_EMERGENCY_INPUT_COLUMNS.length);
});

function validRow() {
  return {
    schema_version: "care-emergency-csv-v1",
    batch_id: "batch-001",
    facility_code: "facility-001",
    care_office_number: "1234567890",
    care_service_type: "care_medical_institution",
    claim_month: "2026-08",
    patient_key: "patient-001",
    patient_display_name: "",
    episode_key: "episode-001",
    onset_at: "2026-08-01T10:00:00+09:00",
    treatment_date: "2026-08-01",
    acute_diagnosis: "急性呼吸不全",
    severe_consciousness_disorder: "false",
    severe_respiratory_failure: "true",
    severe_heart_failure: "false",
    severe_shock: "",
    severe_metabolic_disorder: "false",
    severe_other_poisoning: "false",
    emergency_care_required: "true",
    emergency_care_rationale: "酸素化低下のため救命救急医療が必要",
    facility_treatment_rationale: "施設内で治療を継続",
    medication_performed: "true",
    medication_detail: "抗菌薬投与",
    test_performed: "false",
    test_detail: "",
    injection_performed: "false",
    injection_detail: "",
    procedure_performed: "false",
    procedure_detail: "",
    physician_confirmed: "true",
    physician_confirmed_by: "doctor-001",
    physician_confirmed_at: "2026-08-01T11:00:00+09:00",
    existing_emergency_claim_count_month: "0",
    existing_emergency_claim_start_date: "",
    concurrent_specific_treatment: "false",
    concurrent_specific_disease_facility_treatment: "false",
    concurrent_comprehensive_medical_management: "false",
    existing_claim_service_code: "556000",
    transfer_requested: "false",
    transfer_outcome: "施設内治療継続",
    source_record_id: "record-001",
    source_excerpt: "酸素化が低下したため治療を開始。",
    input_origin: "csv_export"
  };
}
