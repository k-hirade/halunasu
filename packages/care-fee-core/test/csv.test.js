import assert from "node:assert/strict";
import { test } from "node:test";
import iconv from "iconv-lite";
import {
  CARE_EMERGENCY_INPUT_COLUMNS,
  CARE_EMERGENCY_OUTPUT_COLUMNS
} from "../../care-fee-contracts/src/index.js";
import {
  CareFeeCsvError,
  parseCareEmergencyCsv,
  serializeCareEmergencyCsv
} from "../src/index.js";
import { evaluateCareEmergencyCsv } from "../src/csv-pipeline.js";

const headers = [...CARE_EMERGENCY_INPUT_COLUMNS];

test("parses UTF-8 BOM, UTF-8, and CP932 with quoted commas and newlines", () => {
  const row = validInputRow({
    acute_diagnosis: "肺炎, 急性呼吸不全",
    source_excerpt: "1行目\n2行目"
  });
  const utf8 = serializeCareEmergencyCsv(headers, [row]);
  const plain = serializeCareEmergencyCsv(headers, [row], { bom: false });
  const cp932 = iconv.encode(plain.subarray(0).toString("utf8"), "cp932");

  for (const input of [utf8, plain, cp932]) {
    const parsed = parseCareEmergencyCsv(input);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].values.acute_diagnosis, row.acute_diagnosis);
    assert.equal(parsed.rows[0].values.source_excerpt, row.source_excerpt);
  }
  assert.equal(parseCareEmergencyCsv(cp932).encoding, "cp932");
});

test("rejects missing, duplicate, conflicting, and malformed headers", () => {
  const withoutRequired = serializeCareEmergencyCsv(headers.slice(1), [validInputRow()], { bom: false });
  const duplicate = Buffer.from(`${headers.join(",")},schema_version\r\n`, "utf8");
  const conflict = Buffer.from(`${headers.join(",")},judgment_status\r\n`, "utf8");

  assertCsvError(() => parseCareEmergencyCsv(withoutRequired), "missing_required_headers");
  assertCsvError(() => parseCareEmergencyCsv(duplicate), "duplicate_header");
  assertCsvError(() => parseCareEmergencyCsv(conflict), "output_header_conflict");
  assertCsvError(() => parseCareEmergencyCsv(Buffer.from('a,b\r\n"open,b\r\n')), "unclosed_quote");
});

test("evaluates valid rows and preserves invalid rows in one deterministic output", () => {
  const inputRows = [
    validInputRow({ source_excerpt: "酸素, 点滴を実施" }),
    validInputRow({
      patient_key: "patient-002",
      episode_key: "episode-002",
      treatment_date: "2026-08-12",
      claim_month: "2026-08",
      emergency_care_required: "invalid"
    })
  ];
  const input = serializeCareEmergencyCsv(headers, inputRows);
  const options = { runId: "run-fixed", evaluatedAt: "2026-08-02T12:00:00+09:00" };
  const first = evaluateCareEmergencyCsv(input, options);
  const second = evaluateCareEmergencyCsv(input, options);

  assert.deepEqual(first.summary.statusCounts, {
    billing_candidate: 1,
    needs_review: 0,
    conflict: 0,
    not_eligible: 0,
    import_error: 1
  });
  assert.equal(first.rows[0].judgment_status, "billing_candidate");
  assert.equal(first.rows[1].judgment_status, "import_error");
  assert.equal(first.normalizedRows.length, 1);
  assert.equal(first.normalizedRows[0].patientKey, "patient-001");
  assert.equal(first.evaluation.rows.length, 1);
  assert.match(first.rows[1].reason_codes, /invalid_boolean/u);
  assert.equal(first.rows[0].source_excerpt, inputRows[0].source_excerpt);
  assert.equal(first.output.subarray(0, 3).toString("hex"), "efbbbf");
  assert.equal(first.output.toString("hex"), second.output.toString("hex"));
  assert.deepEqual(first.headers.slice(-CARE_EMERGENCY_OUTPUT_COLUMNS.length), CARE_EMERGENCY_OUTPUT_COLUMNS);
});

test("marks every row when schema versions are mixed", () => {
  const input = serializeCareEmergencyCsv(headers, [
    validInputRow(),
    validInputRow({
      schema_version: "care-emergency-csv-v0",
      patient_key: "patient-002",
      episode_key: "episode-002",
      treatment_date: "2026-08-12"
    })
  ]);
  const result = evaluateCareEmergencyCsv(input, {
    runId: "run-mixed",
    evaluatedAt: "2026-08-02T00:00:00Z"
  });

  assert.ok(result.rows.every((row) => row.judgment_status === "import_error"));
  assert.ok(result.rows.every((row) => row.reason_codes.includes("mixed_schema_versions")));
});

test("implementation code does not hardcode the emergency unit score", async () => {
  const source = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/index.js", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/csv-pipeline.js", import.meta.url), "utf8"))
  ]);
  assert.ok(source.every((text) => !text.includes("518")));
});

function validInputRow(overrides = {}) {
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
    onset_at: "2026-08-10T10:00:00+09:00",
    treatment_date: "2026-08-10",
    acute_diagnosis: "急性呼吸不全",
    severe_consciousness_disorder: "false",
    severe_respiratory_failure: "true",
    severe_heart_failure: "false",
    severe_shock: "false",
    severe_metabolic_disorder: "false",
    severe_other_poisoning: "false",
    emergency_care_required: "true",
    emergency_care_rationale: "酸素化低下のため救命救急医療が必要",
    facility_treatment_rationale: "施設内で治療継続",
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
    physician_confirmed_at: "2026-08-10T11:00:00+09:00",
    existing_emergency_claim_count_month: "0",
    existing_emergency_claim_start_date: "",
    concurrent_specific_treatment: "false",
    concurrent_specific_disease_facility_treatment: "false",
    concurrent_comprehensive_medical_management: "false",
    existing_claim_service_code: "556000",
    transfer_requested: "false",
    transfer_outcome: "施設内治療継続",
    source_record_id: "record-001",
    source_excerpt: "",
    input_origin: "csv_export",
    ...overrides
  };
}

function assertCsvError(callback, code) {
  assert.throws(callback, (error) => error instanceof CareFeeCsvError && error.code === code);
}
