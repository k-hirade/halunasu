import {
  CARE_EMERGENCY_INPUT_COLUMNS,
  CARE_EMERGENCY_OUTPUT_COLUMNS,
  CARE_EMERGENCY_CSV_SCHEMA_VERSION,
  validateEmergencyTreatmentRow
} from "../../care-fee-contracts/src/index.js";
import {
  CARE_EMERGENCY_RULE_VERSION,
  evaluateEmergencyTreatmentBatch,
  loadDefaultEmergencyTreatmentMaster
} from "./index.js";
import {
  parseCareEmergencyCsv,
  serializeCareEmergencyCsv,
  sha256Hex,
  stableJson
} from "./csv.js";

export function evaluateCareEmergencyCsv(input, options = {}) {
  const parsed = parseCareEmergencyCsv(input);
  const master = options.master || loadDefaultEmergencyTreatmentMaster();
  const validationByRow = new Map();
  const normalizedRows = [];
  const schemaVersions = new Set();

  for (const row of parsed.rows) {
    const schemaVersion = String(row.values.schema_version || "").trim();
    if (schemaVersion) schemaVersions.add(schemaVersion);
    const result = validateEmergencyTreatmentRow(row.values, { rowNumber: row.rowNumber });
    validationByRow.set(row.rowNumber, result);
    if (result.ok) normalizedRows.push(result.value);
  }

  if (schemaVersions.size > 1) {
    for (const row of parsed.rows) {
      const result = validationByRow.get(row.rowNumber);
      validationByRow.set(row.rowNumber, {
        ok: false,
        value: null,
        issues: [
          ...(result?.issues || []),
          Object.freeze({
            field: "schema_version",
            code: "mixed_schema_versions",
            message: "schema_version must not be mixed in one CSV file",
            rowNumber: row.rowNumber
          })
        ]
      });
    }
    normalizedRows.length = 0;
  }

  const evaluated = evaluateEmergencyTreatmentBatch(normalizedRows, {
    master,
    facilitySettings: options.facilitySettings,
    monthlyPriorEpisodes: options.monthlyPriorEpisodes
  });
  const evaluationByRow = new Map(evaluated.rows.map((row) => [row.rowNumber, row]));
  const evaluatedAt = normalizeEvaluatedAt(options.evaluatedAt);
  const runId = String(options.runId || defaultRunId(parsed.sourceFileSha256, evaluatedAt));
  const outputHeaders = [...parsed.headers, ...CARE_EMERGENCY_OUTPUT_COLUMNS];
  const outputRows = parsed.rows.map((row) => {
    const validation = validationByRow.get(row.rowNumber);
    const evaluation = evaluationByRow.get(row.rowNumber);
    const resultValues = validation?.ok && evaluation
      ? acceptedResultValues(evaluation)
      : invalidResultValues(validation?.issues || [], master.masterVersion);
    const normalizedValue = validation?.ok
      ? normalizedHashValue(validation.value)
      : Object.fromEntries(CARE_EMERGENCY_INPUT_COLUMNS.map((column) => [column, row.values[column] ?? ""]));
    return Object.freeze({
      ...row.values,
      ...resultValues,
      source_file_sha256: parsed.sourceFileSha256,
      normalized_row_sha256: sha256Hex(stableJson(normalizedValue)),
      run_id: runId,
      evaluated_at: evaluatedAt
    });
  });
  const summary = summarize(outputRows, parsed);

  return Object.freeze({
    schemaVersion: CARE_EMERGENCY_CSV_SCHEMA_VERSION,
    ruleVersion: CARE_EMERGENCY_RULE_VERSION,
    masterVersion: master.masterVersion,
    runId,
    evaluatedAt,
    sourceFileSha256: parsed.sourceFileSha256,
    inputEncoding: parsed.encoding,
    headers: Object.freeze(outputHeaders),
    rows: Object.freeze(outputRows),
    normalizedRows: Object.freeze(normalizedRows),
    evaluation: evaluated,
    summary,
    output: serializeCareEmergencyCsv(outputHeaders, outputRows)
  });
}

function acceptedResultValues(evaluation) {
  return {
    import_status: evaluation.importStatus,
    judgment_status: evaluation.judgmentStatus,
    eligible_day: evaluation.eligibleDay,
    day_judgment: evaluation.dayJudgment,
    resolved_service_code: evaluation.resolvedServiceCode,
    resolved_service_code_name: evaluation.resolvedServiceCodeName,
    unit_score: evaluation.unitScore,
    counted_units: evaluation.countedUnits,
    episode_eligible_day_count: evaluation.episodeEligibleDayCount,
    episode_total_units: evaluation.episodeTotalUnits,
    reason_codes: evaluation.reasonCodes.join(";"),
    missing_fields: evaluation.missingFields.join(";"),
    conflict_codes: evaluation.conflictCodes.join(";"),
    master_version: evaluation.masterVersion,
    rule_version: evaluation.ruleVersion
  };
}

function invalidResultValues(issues, masterVersion) {
  return {
    import_status: "import_error",
    judgment_status: "import_error",
    eligible_day: false,
    day_judgment: "not_eligible",
    resolved_service_code: "",
    resolved_service_code_name: "",
    unit_score: 0,
    counted_units: 0,
    episode_eligible_day_count: 0,
    episode_total_units: 0,
    reason_codes: unique(issues.map((issue) => issue.code)).join(";"),
    missing_fields: unique(issues.map((issue) => issue.field)).join(";"),
    conflict_codes: "",
    master_version: masterVersion,
    rule_version: CARE_EMERGENCY_RULE_VERSION
  };
}

function summarize(rows, parsed) {
  const statusCounts = Object.fromEntries([
    "billing_candidate",
    "needs_review",
    "conflict",
    "not_eligible",
    "import_error"
  ].map((status) => [status, rows.filter((row) => row.judgment_status === status).length]));
  return Object.freeze({
    rowCount: rows.length,
    episodeCount: new Set(rows.map((row) => [row.facility_code, row.patient_key, row.episode_key].join("|"))).size,
    acceptedCount: rows.filter((row) => row.import_status === "accepted").length,
    importErrorCount: rows.filter((row) => row.import_status === "import_error").length,
    eligibleDayCount: rows.filter((row) => row.eligible_day === true).length,
    candidateUnits: rows.reduce((sum, row) => sum + Number(row.counted_units || 0), 0),
    statusCounts: Object.freeze(statusCounts),
    inputEncoding: parsed.encoding
  });
}

function normalizedHashValue(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rowNumber"));
}

function normalizeEvaluatedAt(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("evaluatedAt must be a valid ISO datetime");
  return date.toISOString();
}

function defaultRunId(sourceHash, evaluatedAt) {
  return `care-${evaluatedAt.replaceAll(/[-:.TZ]/gu, "").slice(0, 14)}-${sourceHash.slice(0, 12)}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
