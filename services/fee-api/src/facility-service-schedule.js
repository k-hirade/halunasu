import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ARTIFACT_URL = new URL(
  "./fee-rule-data/encounter-basic-fee-sets-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const WEEKDAY_KEYS = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
]);
const RULES_BY_ID = new Map(
  ARTIFACT.rules.map((rule) => [String(rule.ruleId || ""), rule])
);
const CORE_BASIC_RULE_IDS = Object.freeze([
  "basic_initial",
  "basic_revisit"
]);

export function encounterBasicFeeMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256
  };
}

export function encounterBasicFeeRule(ruleId = "") {
  return RULES_BY_ID.get(String(ruleId || "").trim()) || null;
}

export function encounterBasicFeeCoverage(serviceDate = "") {
  const date = normalizeDate(serviceDate);
  const coreRules = CORE_BASIC_RULE_IDS
    .map((ruleId) => RULES_BY_ID.get(ruleId))
    .filter(Boolean);
  const availableFrom = coreRules
    .map((rule) => normalizeDate(rule.effectiveFrom))
    .filter(Boolean)
    .sort()[0] || null;
  const availableTo = coreRules
    .map((rule) => normalizeDate(rule.effectiveTo))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  if (!date) {
    return {
      status: "invalid_service_date",
      serviceDate: null,
      revision: ARTIFACT.revision,
      availableFrom,
      availableTo,
      missingRuleIds: [...CORE_BASIC_RULE_IDS]
    };
  }

  const activeRuleIds = coreRules
    .filter((rule) => (
      normalizeDate(rule.effectiveFrom) <= date
      && normalizeDate(rule.effectiveTo) >= date
    ))
    .map((rule) => rule.ruleId);
  const missingRuleIds = CORE_BASIC_RULE_IDS
    .filter((ruleId) => !activeRuleIds.includes(ruleId));
  return {
    status: missingRuleIds.length ? "unavailable" : "available",
    serviceDate: date,
    revision: ARTIFACT.revision,
    availableFrom,
    availableTo,
    activeRuleIds,
    missingRuleIds
  };
}

export function timeAddonRule({ timeClass = "", feeKind = "" } = {}) {
  return ARTIFACT.rules.find((rule) => (
    rule.category === "time_addon"
    && rule.timeClass === timeClass
    && rule.feeKind === feeKind
  )) || null;
}

export function facilityDerivedAddonRules({
  feeKind = "",
  facilityStandardKeys = []
} = {}) {
  const keys = new Set(
    asArray(facilityStandardKeys)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  return ARTIFACT.rules.filter((rule) => (
    rule.category === "facility_addon"
    && rule.feeKind === feeKind
    && keys.has(String(rule.requiredFacilityStandardKey || ""))
  ));
}

export function classifyFacilityServiceTime({
  receptionTime = "",
  serviceDate = "",
  scheduleEffectiveDate = "",
  feeSettings = {}
} = {}) {
  const time = normalizeTime(receptionTime);
  const date = normalizeDate(serviceDate);
  const effectiveDate = normalizeDate(scheduleEffectiveDate) || date;
  if (!time || !date) {
    return {
      status: "invalid_input",
      timeClass: null,
      scheduleId: null,
      receptionTime: time,
      serviceDate: date,
      scheduleEffectiveDate: effectiveDate
    };
  }

  const activeSchedules = asArray(feeSettings?.facilityServiceSchedules)
    .filter((schedule) => scheduleIsActiveOnDate(schedule, effectiveDate));
  if (!activeSchedules.length) {
    return {
      status: "schedule_missing",
      timeClass: null,
      scheduleId: null,
      receptionTime: time,
      serviceDate: date,
      scheduleEffectiveDate: effectiveDate
    };
  }
  if (activeSchedules.length > 1) {
    return {
      status: "schedule_ambiguous",
      timeClass: null,
      scheduleId: null,
      receptionTime: time,
      serviceDate: date,
      scheduleEffectiveDate: effectiveDate,
      matchingScheduleIds: activeSchedules.map((schedule) => schedule.scheduleId)
    };
  }

  const schedule = activeSchedules[0];
  const specialHours = asArray(schedule.specialHours)
    .find((entry) => entry?.date === date);
  const weeklyHours = asArray(
    schedule.weeklyHours?.[WEEKDAY_KEYS[weekdayIndex(date)]]
  );
  const isExplicitHoliday = asArray(schedule.holidayDates).includes(date);
  const hours = specialHours ? asArray(specialHours.hours) : weeklyHours;

  let timeClass = "within_hours";
  if (isLateNight(time)) {
    timeClass = "late_night";
  } else if (!specialHours && isExplicitHoliday) {
    timeClass = "holiday";
  } else if (!hours.length) {
    return {
      status: "closed_day_unclassified",
      timeClass: null,
      scheduleId: schedule.scheduleId,
      receptionTime: time,
      serviceDate: date,
      scheduleEffectiveDate: effectiveDate,
      timezone: schedule.timezone || "Asia/Tokyo",
      source: "weekly_hours"
    };
  } else if (!hours.some((window) => timeWithinWindow(time, window))) {
    timeClass = "after_hours";
  }

  return {
    status: "classified",
    timeClass,
    scheduleId: schedule.scheduleId,
    receptionTime: time,
    serviceDate: date,
    scheduleEffectiveDate: effectiveDate,
    timezone: schedule.timezone || "Asia/Tokyo",
    source: specialHours
      ? "special_hours"
      : isExplicitHoliday ? "holiday_date" : "weekly_hours"
  };
}

export function facilityServiceTimeReviewWarning(classification = {}) {
  if (classification.status === "invalid_input") {
    return "";
  }
  if (classification.status === "schedule_missing") {
    return "施設診療時間が算定日に対して設定されていないため、時間外・休日・深夜加算を自動判定していません。届出上の診療時間と受診時刻を確認してください。";
  }
  if (classification.status === "schedule_ambiguous") {
    return "算定日に有効な施設診療時間設定が複数あるため、時間外・休日・深夜加算を自動判定していません。設定の有効期間を確認してください。";
  }
  if (classification.status === "closed_day_unclassified") {
    return `診療日${classification.serviceDate}は施設診療時間が登録されていない曜日ですが、休日加算の対象日か通常の休診日かを確定できないため、時間外・休日加算を自動判定していません。休日設定を確認してください。`;
  }
  if (classification.timeClass === "late_night") {
    return `深夜加算判定: 受付時刻${classification.receptionTime}を、施設診療時間設定と深夜帯（22時〜6時）に基づき深夜として判定しました。`;
  }
  if (classification.timeClass === "holiday") {
    return `休日加算判定: 診療日${classification.serviceDate}を、施設の休日設定に基づき休日として判定しました。`;
  }
  if (classification.timeClass === "after_hours") {
    return `時間外加算判定: 受付時刻${classification.receptionTime}を、施設の表示診療時間外として判定しました。`;
  }
  return "";
}

function scheduleIsActiveOnDate(schedule = {}, date = "") {
  if (!schedule || String(schedule.status || "active") !== "active") {
    return false;
  }
  const effectiveFrom = normalizeDate(schedule.effectiveFrom);
  const effectiveTo = normalizeDate(schedule.effectiveTo);
  return Boolean(
    effectiveFrom
    && effectiveFrom <= date
    && (!effectiveTo || effectiveTo >= date)
  );
}

function weekdayIndex(date = "") {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function timeWithinWindow(time = "", window = {}) {
  const start = normalizeTime(window?.start);
  const end = normalizeTime(window?.end);
  return Boolean(start && end && start <= time && time < end);
}

function isLateNight(time = "") {
  return time >= "22:00" || time < "06:00";
}

function normalizeTime(value = "") {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/u.test(text) ? text : "";
}

function normalizeDate(value = "") {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return "";
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text
    ? ""
    : text;
}

function assertArtifactIntegrity(artifact = {}) {
  if (artifact.schemaVersion !== "fee-encounter-basic-artifact-v1") {
    throw new Error("unsupported fee encounter basic artifact schema");
  }
  if (!Array.isArray(artifact.rules) || !artifact.rules.length) {
    throw new Error("fee encounter basic artifact rules are missing");
  }
  const ruleIds = new Set();
  for (const rule of artifact.rules) {
    if (!rule?.ruleId || !rule?.code || !rule?.name) {
      throw new Error("fee encounter basic artifact rule is incomplete");
    }
    if (ruleIds.has(rule.ruleId)) {
      throw new Error(`duplicate fee encounter basic rule: ${rule.ruleId}`);
    }
    ruleIds.add(rule.ruleId);
  }
  const payload = { ...artifact };
  delete payload.artifactPayloadSha256;
  if (sha256(canonicalJson(payload)) !== artifact.artifactPayloadSha256) {
    throw new Error("fee encounter basic artifact checksum mismatch");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
