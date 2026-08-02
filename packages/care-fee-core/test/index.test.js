import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CARE_EMERGENCY_RULE_VERSION,
  detectBatchImportErrors,
  evaluateEmergencyTreatmentBatch,
  loadDefaultEmergencyTreatmentMaster,
  resolveEmergencyTreatmentMaster,
  validateEmergencyTreatmentMaster
} from "../src/index.js";

const gold = JSON.parse(readFileSync(
  new URL("../../../data/tests/care-fee-gold/emergency-treatment-cases.json", import.meta.url),
  "utf8"
));

test("default care service master is valid and effective-dated", () => {
  const master = loadDefaultEmergencyTreatmentMaster();
  assert.equal(validateEmergencyTreatmentMaster(master), master);
  assert.ok(master.records.length >= 9);
  assert.equal(CARE_EMERGENCY_RULE_VERSION, "care-emergency-rules-v1");
});

test("resolves a unique service code and abstains on an ambiguous roken variant", () => {
  const master = loadDefaultEmergencyTreatmentMaster();
  const exact = resolveEmergencyTreatmentMaster({
    careServiceType: "care_medical_institution",
    serviceDate: "2026-08-01"
  }, master);
  const ambiguous = resolveEmergencyTreatmentMaster({
    careServiceType: "roken",
    serviceDate: "2026-08-01"
  }, master);

  assert.equal(exact.status, "resolved");
  assert.equal(exact.serviceCode, "556000");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

for (const fixture of gold.cases) {
  test(`gold: ${fixture.caseId}`, () => {
    const rows = fixture.rows.map((row, index) => buildRow({
      ...fixture.overrides,
      ...row,
      rowNumber: index + 1,
      sourceRecordId: `${fixture.caseId}-${index + 1}`
    }));
    const result = evaluateEmergencyTreatmentBatch(rows);
    const episode = result.episodes[0];

    assert.equal(episode.judgmentStatus, fixture.expected.status);
    if (fixture.expected.eligibleDayCount !== undefined) {
      assert.equal(episode.eligibleDayCount, fixture.expected.eligibleDayCount);
    }
    if (fixture.expected.totalUnits !== undefined) {
      assert.equal(episode.totalUnits, fixture.expected.totalUnits);
    }
    if (fixture.expected.reason) {
      assert.ok(episode.reasonCodes.includes(fixture.expected.reason), JSON.stringify(episode));
    }
    if (fixture.expected.serviceCode) {
      assert.equal(result.rows[0].resolvedServiceCode, fixture.expected.serviceCode);
    }
    for (const [date, reason] of Object.entries(fixture.expected.rowReason || {})) {
      const output = result.rows.find((row) => row.treatmentDate === date);
      assert.ok(output.reasonCodes.includes(reason), JSON.stringify(output));
    }
  });
}

test("flags duplicate treatment days as import errors", () => {
  const rows = [buildRow({ rowNumber: 1 }), buildRow({ rowNumber: 2 })];
  const result = evaluateEmergencyTreatmentBatch(rows);

  assert.equal(detectBatchImportErrors(rows).size, 2);
  assert.ok(result.rows.every((row) => row.judgmentStatus === "import_error"));
  assert.ok(result.rows.every((row) => row.reasonCodes.includes("duplicate_treatment_day")));
});

test("flags inconsistent repeated episode values", () => {
  const rows = [
    buildRow({ rowNumber: 1, treatmentDate: "2026-08-10" }),
    buildRow({ rowNumber: 2, treatmentDate: "2026-08-11", acuteDiagnosis: "別病名" })
  ];
  const result = evaluateEmergencyTreatmentBatch(rows);

  assert.ok(result.rows.every((row) => row.judgmentStatus === "import_error"));
  assert.ok(result.rows.every((row) => row.reasonCodes.includes("inconsistent_episode_value")));
});

test("keeps a missing acute diagnosis as needs_review instead of an import error", () => {
  const result = evaluateEmergencyTreatmentBatch([buildRow({ acuteDiagnosis: "" })]);

  assert.equal(result.rows[0].judgmentStatus, "needs_review");
  assert.equal(result.rows[0].reasonCodes.includes("acute_diagnosis_missing"), true);
  assert.equal(result.rows[0].missingFields.includes("acute_diagnosis"), true);
});

test("keeps incomplete API evidence as needs_review without inventing clinical facts", () => {
  const result = evaluateEmergencyTreatmentBatch([buildRow({
    onsetAt: "",
    medicationDetail: "",
    physicianConfirmedBy: "",
    physicianConfirmedAt: ""
  })]);

  assert.equal(result.rows[0].judgmentStatus, "needs_review");
  assert.ok(result.rows[0].reasonCodes.includes("onset_at_missing"));
  assert.ok(result.rows[0].reasonCodes.includes("treatment_detail_missing"));
  assert.ok(result.rows[0].reasonCodes.includes("physician_confirmation_details_missing"));
});

test("is deterministic for 100 repeated evaluations", () => {
  const rows = [
    buildRow({ rowNumber: 1, treatmentDate: "2026-08-10" }),
    buildRow({ rowNumber: 2, treatmentDate: "2026-08-11" })
  ];
  const baseline = JSON.stringify(evaluateEmergencyTreatmentBatch(rows));
  for (let index = 0; index < 100; index += 1) {
    assert.equal(JSON.stringify(evaluateEmergencyTreatmentBatch(rows)), baseline);
  }
});

function buildRow(overrides = {}) {
  return {
    rowNumber: 1,
    schemaVersion: "care-emergency-csv-v1",
    batchId: "batch-001",
    facilityCode: "facility-001",
    careOfficeNumber: "1234567890",
    careServiceType: "care_medical_institution",
    claimMonth: "2026-08",
    patientKey: "patient-001",
    patientDisplayName: "",
    episodeKey: "episode-001",
    onsetAt: "2026-08-10T10:00:00+09:00",
    treatmentDate: "2026-08-10",
    acuteDiagnosis: "急性呼吸不全",
    severeConsciousnessDisorder: false,
    severeRespiratoryFailure: true,
    severeHeartFailure: false,
    severeShock: false,
    severeMetabolicDisorder: false,
    severeOtherPoisoning: false,
    emergencyCareRequired: true,
    emergencyCareRationale: "酸素化低下のため救命救急医療が必要",
    facilityTreatmentRationale: "施設内で治療継続",
    medicationPerformed: true,
    medicationDetail: "抗菌薬投与",
    testPerformed: false,
    testDetail: "",
    injectionPerformed: false,
    injectionDetail: "",
    procedurePerformed: false,
    procedureDetail: "",
    physicianConfirmed: true,
    physicianConfirmedBy: "doctor-001",
    physicianConfirmedAt: "2026-08-10T11:00:00+09:00",
    existingEmergencyClaimCountMonth: 0,
    existingEmergencyClaimStartDate: "",
    concurrentSpecificTreatment: false,
    concurrentSpecificDiseaseFacilityTreatment: false,
    concurrentComprehensiveMedicalManagement: false,
    existingClaimServiceCode: "556000",
    transferRequested: false,
    transferOutcome: "施設内治療継続",
    sourceRecordId: "record-001",
    sourceExcerpt: "",
    inputOrigin: "csv_export",
    ...overrides
  };
}
