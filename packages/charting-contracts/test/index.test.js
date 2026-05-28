import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateChartingEncounterInput,
  validateCreateChartingPatientInput,
  validateCreateSoapDraftInput
} from "../src/index.js";

test("validates patient input for Platform patient creation", () => {
  const input = validateCreateChartingPatientInput({
    displayName: " 山田 太郎 ",
    birthDate: "1970-01-01",
    sex: "male",
    externalPatientIds: ["P001", "P001", ""]
  });

  assert.equal(input.displayName, "山田 太郎");
  assert.equal(input.birthDate, "1970-01-01");
  assert.deepEqual(input.externalPatientIds, ["P001"]);
});

test("requires selected or newly created patient when creating encounters", () => {
  assert.deepEqual(validateCreateChartingEncounterInput({
    patientId: "pat_123",
    facilityId: "fac_123",
    departmentId: "dep_123",
    visitReason: "咳"
  }), {
    patientId: "pat_123",
    facilityId: "fac_123",
    departmentId: "dep_123",
    visitReason: "咳"
  });
  assert.deepEqual(validateCreateChartingEncounterInput({
    patient: { displayName: "佐藤 花子" }
  }).patient.displayName, "佐藤 花子");
  assert.throws(() => validateCreateChartingEncounterInput({ visitReason: "咳" }), /patientId or patient is required/);
});

test("validates mock SOAP draft input", () => {
  assert.deepEqual(validateCreateSoapDraftInput({
    transcript: "S: 咳\nO: 発熱なし"
  }), {
    transcript: "S: 咳\nO: 発熱なし",
    notes: undefined
  });
});
