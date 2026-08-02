import {
  CARE_EMERGENCY_CONFLICT_FIELDS,
  CARE_EMERGENCY_SEVERE_FIELDS,
  CARE_EMERGENCY_TREATMENT_FIELDS
} from "../../care-fee-contracts/src/index.js";
import {
  loadDefaultEmergencyTreatmentMaster,
  resolveEmergencyTreatmentMaster,
  validateEmergencyTreatmentMaster
} from "./master.js";

export {
  loadDefaultEmergencyTreatmentMaster,
  resolveEmergencyTreatmentMaster,
  validateEmergencyTreatmentMaster
} from "./master.js";

export {
  CareFeeCsvError,
  decodeCareEmergencyCsv,
  parseCareEmergencyCsv,
  serializeCareEmergencyCsv,
  sha256Hex,
  stableJson
} from "./csv.js";

export const CARE_EMERGENCY_RULE_VERSION = "care-emergency-rules-v1";

export const CARE_EMERGENCY_REASON_MESSAGES_JA = Object.freeze({
  eligible_requirements_satisfied: "算定要件を満たす候補です。人による確認後に確定してください。",
  severe_condition_explicitly_absent: "対象となる重篤状態がすべて明示的に否定されています。",
  severe_condition_unknown: "対象となる重篤状態が確認できません。",
  emergency_care_not_required: "救命救急医療が必要との判断が明示的に否定されています。",
  emergency_care_requirement_unknown: "救命救急医療が必要との判断を確認してください。",
  emergency_care_rationale_missing: "救命救急医療が必要と判断した根拠がありません。",
  daily_treatment_unknown: "当日の投薬・検査・注射・処置の実施状況を確認してください。",
  daily_treatment_not_documented: "当日の投薬・検査・注射・処置が記録されていません。",
  physician_confirmation_missing: "医師確認が完了していません。",
  monthly_claim_history_unknown: "当月の既算定件数を確認してください。",
  monthly_limit_already_claimed: "同一患者について当月の既算定があります。",
  specific_treatment_conflict: "同日の特定治療と併算定できません。",
  specific_disease_facility_treatment_conflict: "同日の所定疾患施設療養費等との併算定を確認してください。",
  comprehensive_medical_management_conflict: "同日の総合医学管理加算等との併算定を確認してください。",
  concurrent_billing_unknown: "同日の併算定項目を確認してください。",
  service_master_not_found: "治療日に有効な介護サービスコードマスタがありません。",
  service_code_variant_required: "施設区分に対応する緊急時治療管理のサービスコードを確認してください。",
  acute_diagnosis_missing: "急性疾患の病名または診断記録を確認してください。",
  onset_at_missing: "急変の発生日時を確認してください。",
  treatment_detail_missing: "実施した投薬・検査・注射・処置の内容を確認してください。",
  physician_confirmation_details_missing: "医師確認者と確認日時を確認してください。",
  monthly_claim_start_date_missing: "当月の既算定がある場合は算定開始日を確認してください。",
  consecutive_day_limit_exceeded: "連続3日の上限を超えています。",
  non_consecutive_treatment_day: "同一エピソードの治療日が暦日連続ではありません。",
  cross_month_episode_requires_review: "月をまたぐエピソードの扱いを確認してください。",
  duplicate_treatment_day: "同じ患者・エピソード・治療日の行が重複しています。",
  inconsistent_episode_value: "同一エピソード内の共通項目が一致しません。"
});

const REPEATED_EPISODE_PROPERTIES = Object.freeze([
  "facilityCode",
  "careOfficeNumber",
  "careServiceType",
  "claimMonth",
  "patientKey",
  "episodeKey",
  "onsetAt",
  "acuteDiagnosis",
  ...CARE_EMERGENCY_SEVERE_FIELDS.map(camel),
  "emergencyCareRequired",
  "emergencyCareRationale",
  "facilityTreatmentRationale",
  "existingEmergencyClaimCountMonth",
  "existingEmergencyClaimStartDate"
]);

export function evaluateEmergencyTreatmentBatch(rows = [], options = {}) {
  const master = options.master || loadDefaultEmergencyTreatmentMaster();
  validateEmergencyTreatmentMaster(master);
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const rowErrors = detectBatchImportErrors(normalizedRows);
  const groups = groupRows(normalizedRows);
  const evaluationsByRow = new Map();
  const episodes = [];

  for (const groupRowsValue of groups.values()) {
    const groupHasImportError = groupRowsValue.some((row) => rowErrors.has(rowIdentity(row)));
    if (groupHasImportError) {
      for (const row of groupRowsValue) {
        const issues = rowErrors.get(rowIdentity(row)) || [batchIssue("inconsistent_episode_value")];
        evaluationsByRow.set(rowIdentity(row), importErrorResult(row, issues, master.masterVersion));
      }
      episodes.push({
        episodeKey: groupRowsValue[0]?.episodeKey || "",
        judgmentStatus: "import_error",
        rowCount: groupRowsValue.length
      });
      continue;
    }

    const evaluation = evaluateEmergencyTreatmentEpisode(groupRowsValue, {
      ...options,
      master
    });
    episodes.push(evaluation.episode);
    for (const row of evaluation.rows) {
      evaluationsByRow.set(row.rowIdentity, row);
    }
  }

  return Object.freeze({
    ruleVersion: CARE_EMERGENCY_RULE_VERSION,
    masterVersion: master.masterVersion,
    episodes: Object.freeze(episodes),
    rows: Object.freeze(normalizedRows.map((row) => evaluationsByRow.get(rowIdentity(row))))
  });
}

export function evaluateEmergencyTreatmentEpisode(rows = [], options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError("rows must contain at least one normalized treatment row");
  }
  const master = options.master || loadDefaultEmergencyTreatmentMaster();
  validateEmergencyTreatmentMaster(master);
  const sortedRows = [...rows].sort((left, right) => (
    left.treatmentDate.localeCompare(right.treatmentDate)
    || Number(left.rowNumber || 0) - Number(right.rowNumber || 0)
  ));
  const first = sortedRows[0];
  const facilitySettings = resolveFacilitySettings(first, options.facilitySettings);
  const globalReasons = [];
  const globalMissing = [];
  const globalConflicts = [];
  let explicitIneligible = false;

  if (!first.acuteDiagnosis) {
    add(globalReasons, "acute_diagnosis_missing");
    add(globalMissing, "acute_diagnosis");
  }

  if (!first.onsetAt) {
    add(globalReasons, "onset_at_missing");
    add(globalMissing, "onset_at");
  }

  const severeValues = CARE_EMERGENCY_SEVERE_FIELDS.map((field) => first[camel(field)]);
  if (!severeValues.includes(true)) {
    if (severeValues.every((value) => value === false)) {
      explicitIneligible = true;
      add(globalReasons, "severe_condition_explicitly_absent");
    } else {
      add(globalReasons, "severe_condition_unknown");
      for (const field of CARE_EMERGENCY_SEVERE_FIELDS) add(globalMissing, field);
    }
  }

  if (first.emergencyCareRequired === false) {
    explicitIneligible = true;
    add(globalReasons, "emergency_care_not_required");
  } else if (first.emergencyCareRequired !== true) {
    add(globalReasons, "emergency_care_requirement_unknown");
    add(globalMissing, "emergency_care_required");
  } else if (!first.emergencyCareRationale) {
    add(globalReasons, "emergency_care_rationale_missing");
    add(globalMissing, "emergency_care_rationale");
  }

  if (first.existingEmergencyClaimCountMonth === null) {
    add(globalReasons, "monthly_claim_history_unknown");
    add(globalMissing, "existing_emergency_claim_count_month");
  } else if (first.existingEmergencyClaimCountMonth > 0 || hasMonthlyPriorEpisode(first, options.monthlyPriorEpisodes)) {
    add(globalReasons, "monthly_limit_already_claimed");
    add(globalConflicts, "monthly_limit_already_claimed");
    if (!first.existingEmergencyClaimStartDate) {
      add(globalReasons, "monthly_claim_start_date_missing");
      add(globalMissing, "existing_emergency_claim_start_date");
    }
  }

  if (first.onsetAt && first.onsetAt.slice(0, 7) !== first.claimMonth) {
    add(globalReasons, "cross_month_episode_requires_review");
    add(globalMissing, "cross_month_episode_interpretation");
  }

  const firstDate = sortedRows[0].treatmentDate;
  const dayResults = sortedRows.map((row, index) => evaluateDay(row, {
    firstDate,
    index,
    master,
    facilitySettings,
    globalReasons,
    globalMissing,
    globalConflicts,
    explicitIneligible
  }));

  const allReasons = unique([...globalReasons, ...dayResults.flatMap((day) => day.reasonCodes)]);
  const allMissing = unique([...globalMissing, ...dayResults.flatMap((day) => day.missingFields)]);
  const allConflicts = unique([...globalConflicts, ...dayResults.flatMap((day) => day.conflictCodes)]);
  const hasDayReview = dayResults.some((day) => day.dayJudgment === "needs_review");
  const preliminaryEligible = dayResults.filter((day) => day.dayJudgment === "eligible");
  const judgmentStatus = explicitIneligible
    ? "not_eligible"
    : allConflicts.length > 0
      ? "conflict"
      : allMissing.length > 0 || hasDayReview
        ? "needs_review"
        : preliminaryEligible.length > 0
          ? "billing_candidate"
          : "not_eligible";

  const finalRows = dayResults.map((day) => {
    const eligibleDay = judgmentStatus === "billing_candidate" && day.dayJudgment === "eligible";
    return Object.freeze({
      ...day,
      importStatus: "accepted",
      judgmentStatus,
      eligibleDay,
      countedUnits: eligibleDay ? Number(day.unitScore || 0) : 0,
      reasonCodes: unique([...globalReasons, ...day.reasonCodes]),
      missingFields: unique([...globalMissing, ...day.missingFields]),
      conflictCodes: unique([...globalConflicts, ...day.conflictCodes]),
      masterVersion: master.masterVersion,
      ruleVersion: CARE_EMERGENCY_RULE_VERSION
    });
  });
  const episodeEligibleDayCount = finalRows.filter((row) => row.eligibleDay).length;
  const episodeTotalUnits = finalRows.reduce((sum, row) => sum + row.countedUnits, 0);
  const outputRows = finalRows.map((row) => Object.freeze({
    ...row,
    episodeEligibleDayCount,
    episodeTotalUnits
  }));

  return Object.freeze({
    episode: Object.freeze({
      facilityCode: first.facilityCode,
      patientKey: first.patientKey,
      episodeKey: first.episodeKey,
      claimMonth: first.claimMonth,
      judgmentStatus,
      eligibleDayCount: episodeEligibleDayCount,
      totalUnits: episodeTotalUnits,
      reasonCodes: allReasons,
      missingFields: allMissing,
      conflictCodes: allConflicts,
      masterVersion: master.masterVersion,
      ruleVersion: CARE_EMERGENCY_RULE_VERSION
    }),
    rows: Object.freeze(outputRows)
  });
}

export function detectBatchImportErrors(rows = []) {
  const errors = new Map();
  const keyGroups = new Map();
  for (const row of rows) {
    const key = [row.facilityCode, row.patientKey, row.episodeKey, row.treatmentDate].join("|");
    if (!keyGroups.has(key)) keyGroups.set(key, []);
    keyGroups.get(key).push(row);
  }
  for (const duplicates of keyGroups.values()) {
    if (duplicates.length < 2) continue;
    for (const row of duplicates) pushIssue(errors, row, batchIssue("duplicate_treatment_day"));
  }

  for (const group of groupRows(rows).values()) {
    for (const property of REPEATED_EPISODE_PROPERTIES) {
      const values = new Set(group.map((row) => stableValue(row[property])));
      if (values.size <= 1) continue;
      for (const row of group) {
        pushIssue(errors, row, batchIssue("inconsistent_episode_value", property));
      }
    }
  }
  return errors;
}

function evaluateDay(row, context) {
  const reasonCodes = [];
  const missingFields = [];
  const conflictCodes = [];
  const preferredServiceCode = row.existingClaimServiceCode
    || context.facilitySettings.emergencyServiceCodes?.[row.careServiceType]
    || "";
  const masterResolution = resolveEmergencyTreatmentMaster({
    careServiceType: row.careServiceType,
    serviceDate: row.treatmentDate,
    preferredServiceCode,
    facilityVariant: context.facilitySettings.facilityVariants?.[row.careServiceType]
  }, context.master);

  if (masterResolution.status === "not_found") {
    add(reasonCodes, "service_master_not_found");
    add(missingFields, "care_service_master");
  } else if (masterResolution.status === "ambiguous") {
    add(reasonCodes, "service_code_variant_required");
    add(missingFields, "existing_claim_service_code");
  }

  for (const field of CARE_EMERGENCY_CONFLICT_FIELDS) {
    const property = camel(field);
    if (row[property] === null) {
      add(reasonCodes, "concurrent_billing_unknown");
      add(missingFields, field);
    } else if (row[property] === true) {
      const conflictCode = conflictCodeForField(field);
      add(reasonCodes, conflictCode);
      add(conflictCodes, conflictCode);
    }
  }

  if (row.physicianConfirmed !== true) {
    add(reasonCodes, "physician_confirmation_missing");
    add(missingFields, "physician_confirmed");
  } else if (!row.physicianConfirmedBy || !row.physicianConfirmedAt) {
    add(reasonCodes, "physician_confirmation_details_missing");
    if (!row.physicianConfirmedBy) add(missingFields, "physician_confirmed_by");
    if (!row.physicianConfirmedAt) add(missingFields, "physician_confirmed_at");
  }

  const performedValues = CARE_EMERGENCY_TREATMENT_FIELDS.map((field) => row[camel(field.performed)]);
  if (!performedValues.includes(true)) {
    const reason = performedValues.every((value) => value === false)
      ? "daily_treatment_not_documented"
      : "daily_treatment_unknown";
    add(reasonCodes, reason);
    for (const field of CARE_EMERGENCY_TREATMENT_FIELDS) add(missingFields, field.performed);
  } else {
    for (const field of CARE_EMERGENCY_TREATMENT_FIELDS) {
      if (row[camel(field.performed)] === true && !row[camel(field.detail)]) {
        add(reasonCodes, "treatment_detail_missing");
        add(missingFields, field.detail);
      }
    }
  }

  const dayOffset = dateDifferenceDays(context.firstDate, row.treatmentDate);
  let dayJudgment = "eligible";
  if (context.explicitIneligible) {
    dayJudgment = "not_eligible";
  } else if (dayOffset !== context.index) {
    dayJudgment = "not_eligible";
    add(reasonCodes, "non_consecutive_treatment_day");
  } else if (dayOffset >= 3) {
    dayJudgment = "over_limit";
    add(reasonCodes, "consecutive_day_limit_exceeded");
  } else if (
    context.globalMissing.length > 0
    || context.globalConflicts.length > 0
    || missingFields.length > 0
    || conflictCodes.length > 0
  ) {
    dayJudgment = "needs_review";
  } else {
    add(reasonCodes, "eligible_requirements_satisfied");
  }

  return Object.freeze({
    rowIdentity: rowIdentity(row),
    rowNumber: row.rowNumber,
    facilityCode: row.facilityCode,
    patientKey: row.patientKey,
    episodeKey: row.episodeKey,
    treatmentDate: row.treatmentDate,
    dayJudgment,
    resolvedServiceCode: masterResolution.status === "resolved" ? masterResolution.serviceCode : "",
    resolvedServiceCodeName: masterResolution.status === "resolved" ? masterResolution.serviceCodeName : "",
    unitScore: Number(masterResolution.unitScore || 0),
    reasonCodes,
    missingFields,
    conflictCodes
  });
}

function importErrorResult(row, issues, masterVersion) {
  return Object.freeze({
    rowIdentity: rowIdentity(row),
    rowNumber: row.rowNumber,
    facilityCode: row.facilityCode,
    patientKey: row.patientKey,
    episodeKey: row.episodeKey,
    treatmentDate: row.treatmentDate,
    importStatus: "import_error",
    judgmentStatus: "import_error",
    eligibleDay: false,
    dayJudgment: "not_eligible",
    resolvedServiceCode: "",
    resolvedServiceCodeName: "",
    unitScore: 0,
    countedUnits: 0,
    episodeEligibleDayCount: 0,
    episodeTotalUnits: 0,
    reasonCodes: unique(issues.map((entry) => entry.code)),
    missingFields: unique(issues.map((entry) => entry.field).filter(Boolean)),
    conflictCodes: [],
    masterVersion,
    ruleVersion: CARE_EMERGENCY_RULE_VERSION
  });
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.facilityCode, row.patientKey, row.episodeKey].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function resolveFacilitySettings(row, settings) {
  if (!settings || typeof settings !== "object") return {};
  if (settings[row.facilityCode] && typeof settings[row.facilityCode] === "object") {
    return settings[row.facilityCode];
  }
  return settings;
}

function hasMonthlyPriorEpisode(row, episodes) {
  return (Array.isArray(episodes) ? episodes : []).some((episode) => (
    episode.facilityCode === row.facilityCode
    && episode.patientKey === row.patientKey
    && episode.claimMonth === row.claimMonth
    && episode.episodeKey !== row.episodeKey
    && ["billing_candidate", "confirmed"].includes(episode.status || episode.judgmentStatus)
  ));
}

function conflictCodeForField(field) {
  return {
    concurrent_specific_treatment: "specific_treatment_conflict",
    concurrent_specific_disease_facility_treatment: "specific_disease_facility_treatment_conflict",
    concurrent_comprehensive_medical_management: "comprehensive_medical_management_conflict"
  }[field];
}

function dateDifferenceDays(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000);
}

function rowIdentity(row) {
  return [
    row.facilityCode,
    row.patientKey,
    row.episodeKey,
    row.treatmentDate,
    row.rowNumber ? `row:${row.rowNumber}` : ""
  ].join("|");
}

function pushIssue(map, row, issue) {
  const key = rowIdentity(row);
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(issue);
}

function batchIssue(code, field = "") {
  return Object.freeze({ code, field });
}

function stableValue(value) {
  return value === null || value === undefined ? "<null>" : JSON.stringify(value);
}

function camel(value) {
  return String(value).replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function add(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
