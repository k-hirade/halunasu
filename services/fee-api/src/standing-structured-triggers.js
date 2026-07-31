import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isFutureOrOrderOnlyClinicalServiceContext,
  isNegatedClinicalServiceContext,
  isPastOrExternalClinicalServiceContext,
  normalizeClinicalPredicateText,
  splitClinicalEvidenceClauses
} from "../../../packages/fee-contracts/src/index.js";

const ARTIFACT_URL = new URL(
  "./fee-rule-data/standing-structured-triggers-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

export function standingStructuredTriggerArtifactMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256
  };
}

export function standingStructuredTriggerFamilySelectors() {
  const selectors = asArray(ARTIFACT.triggers).flatMap((trigger) => [
    trigger.familySelector,
    ...asArray(trigger.parentFamilySelectors)
  ]);
  return dedupeBy(selectors, (selector) => canonicalJson(selector));
}

export function standingStructuredFamilyCatalogDiagnostics(families = []) {
  const selectors = standingStructuredTriggerFamilySelectors();
  return {
    familyCount: asArray(families).length,
    additionalSelectorCount: selectors.length,
    additionalSelectorResolvedCount: selectors.filter((selector) => (
      asArray(families).filter((family) => standingFamilyMatchesSelector(family, selector)).length === 1
    )).length
  };
}

export function standingStructuredFactsSummary(structuredFacts = {}, {
  clinicalEvents = []
} = {}) {
  const events = asArray(clinicalEvents);
  const currentOwnEvents = events.filter(isCurrentOwnStructuredClinicalEvent);
  return {
    residenceType: valueAtPath(structuredFacts, "encounter.residenceType") || null,
    plannedHomeVisit: valueAtPath(structuredFacts, "encounter.plannedHomeVisit") === true,
    activeDiagnosisCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.activeDiagnosisCount")
    ),
    currentManagementOrCounselingCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.currentManagementOrCounselingCount")
    ),
    currentManagementEventCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.currentManagementEventCount")
    ),
    currentManagementStandingMentionCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.currentManagementStandingMentionCount")
    ),
    currentManagementTextSignalCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.currentManagementTextSignalCount")
    ),
    currentLongitudinalPlanSignalCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.currentLongitudinalPlanSignalCount")
    ),
    standingMentionCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.standingMentionCount")
    ),
    deviceFactCount: finiteCountOrZero(
      valueAtPath(structuredFacts, "clinical.deviceFactCount")
    ),
    eventCount: events.length,
    currentOwnEventCount: currentOwnEvents.length,
    eventTypeCounts: enumCounts(events.map(structuredClinicalEventType)),
    actionStatusCounts: enumCounts(events.map(structuredClinicalEventActionStatus)),
    temporalRelationCounts: enumCounts(events.map(structuredClinicalEventTemporalRelation)),
    providerOwnershipCounts: enumCounts(events.map(structuredClinicalEventProviderOwnership))
  };
}

export function buildStandingStructuredFacts({
  prepared = {},
  session = {},
  facilityStandardKeys = [],
  historyCompleteness = "unknown",
  confirmedHistoryCodes = []
} = {}) {
  const encounterDetails = isPlainObject(session.encounterDetails)
    ? session.encounterDetails
    : {};
  const events = asArray(prepared.clinicalEvents);
  const standingMentions = asArray(prepared.standingMentions);
  const diagnoses = uniqueStructuredDiagnoses([
    ...asArray(session.diagnoses),
    ...asArray(prepared.diagnoses)
  ]);
  const currentEvents = events.filter(isCurrentOwnStructuredClinicalEvent);
  const currentManagementEvents = events.filter(isCurrentOwnStructuredManagementEvent);
  const currentManagementStandingMentions = standingMentions.filter(
    isCurrentManagementStandingMention
  );
  const currentManagementTextSignalCount = currentManagementOrCounselingTextSignalCount(
    session.clinicalText || prepared.clinicalText || ""
  );
  const currentLongitudinalPlanSignalCount = currentLongitudinalManagementPlanSignalCount(
    session.clinicalText || prepared.clinicalText || ""
  );
  const calculationOptions = isPlainObject(prepared.calculationOptions)
    ? prepared.calculationOptions
    : {};
  const sourceFacts = isPlainObject(session.structuredSourceFacts)
    ? session.structuredSourceFacts
    : isPlainObject(prepared.structuredSourceFacts)
      ? prepared.structuredSourceFacts
      : {};
  const sourceDevices = asArray(sourceFacts.devices);
  const sourcePrescriptions = asArray(sourceFacts.prescriptions);
  const serviceDate = isoDateOrNull(
    session.serviceDate
    || sourceFacts?.encounter?.serviceDate
  );
  const patientStartDate = isoDateOrNull(sourceFacts?.encounter?.patientStartDate);
  const monthlyVisitDays = uniqueStrings(
    asArray(sourceFacts?.encounter?.monthlyVisitDays).filter(isoDateOrNull)
  );
  const deviceTypes = uniqueStrings(
    sourceDevices.map((device) => device?.type)
  );
  const prescriptionTexts = uniqueStrings([
    ...sourcePrescriptions.map((entry) => entry?.text),
    ...structuredOptionTexts(calculationOptions, [
      "medications",
      "medication_orders",
      "medicationOrders",
      "drugs"
    ])
  ]);

  return {
    encounter: {
      setting: String(session.setting || ""),
      plannedHomeVisit: session.setting === "home_visit",
      residenceType: ["private", "facility"].includes(String(encounterDetails.residenceType || ""))
        ? String(encounterDetails.residenceType)
        : null,
      sameBuilding: typeof encounterDetails.sameBuilding === "boolean"
        ? encounterDetails.sameBuilding
        : null,
      singleBuildingPatientCount: positiveIntegerOrNull(
        encounterDetails.singleBuildingPatientCount
      ),
      patientStartDate,
      withinThreeMonthsOfPatientStart: withinThreeMonths(
        patientStartDate,
        serviceDate
      ),
      monthlyVisitDays,
      monthlyVisitDayCount: monthlyVisitDays.length
    },
    care: {
      certificationLevel: finiteNumberOrNull(sourceFacts?.care?.certificationLevel),
      visitingNurseWeeklyCount: finiteNumberOrNull(
        sourceFacts?.care?.visitingNurseWeeklyCount
      ),
      ictCoordination: sourceFacts?.care?.ictCoordination === true
        ? true
        : sourceFacts?.care?.ictCoordination === false
          ? false
          : null
    },
    clinical: {
      activeDiagnosisCount: diagnoses.size,
      activeDiagnosisNames: [...diagnoses].sort(),
      // The three sources may describe the same clause. Use the strongest
      // observed count so duplicate extraction paths cannot inflate the fact.
      currentManagementOrCounselingCount: Math.max(
        currentManagementEvents.length,
        currentManagementStandingMentions.length,
        currentManagementTextSignalCount,
        currentLongitudinalPlanSignalCount
      ),
      currentManagementEventCount: currentManagementEvents.length,
      currentManagementStandingMentionCount: currentManagementStandingMentions.length,
      currentManagementTextSignalCount,
      currentLongitudinalPlanSignalCount,
      standingMentionCount: standingMentions.length,
      medicationFactCount: currentEvents.filter((event) => (
        structuredClinicalEventType(event) === "medication"
      )).length + structuredOptionEntryCount(calculationOptions, [
        "medications",
        "medication_orders",
        "medicationOrders",
        "drugs"
      ]),
      deviceFactCount: currentEvents.filter((event) => (
        structuredClinicalEventType(event) === "material"
        || ["standard_material", "home_care"].includes(structuredClinicalEventBillingDomain(event))
      )).length + structuredOptionEntryCount(calculationOptions, [
        "devices",
        "device_orders",
        "deviceOrders",
        "materials"
      ]) + sourceDevices.length,
      deviceTypes,
      hasCancerPainDiagnosis: [...diagnoses].some((name) => (
        /(?:がん|癌).{0,12}(?:疼痛|痛)|(?:疼痛|痛).{0,12}(?:がん|癌)/u.test(name)
      )),
      hasNarcoticAnalgesicPrescription: prescriptionTexts.some((text) => (
        /(?:麻薬|モルヒネ|オキシコドン|フェンタニル|ヒドロモルフォン|メサドン|タペンタドール)/u.test(text)
      )),
      explicitMedicationReductionTwoOrMore: hasExplicitMedicationReductionTwoOrMore(
        session.clinicalText || prepared.clinicalText || ""
      ),
      testFactCount: currentEvents.filter((event) => (
        ["lab", "imaging", "pathology"].includes(structuredClinicalEventType(event))
      )).length + structuredOptionEntryCount(calculationOptions, [
        "tests",
        "test_orders",
        "testOrders",
        "lab_orders",
        "labOrders",
        "imaging_orders",
        "imagingOrders"
      ])
    },
    facility: {
      activeStandardKeys: uniqueStrings(facilityStandardKeys)
    },
    history: {
      completeness: ["complete", "partial", "unknown", "unavailable"].includes(
        String(historyCompleteness || "")
      ) ? String(historyCompleteness) : "unknown",
      confirmedCodes: uniqueStrings(confirmedHistoryCodes)
    }
  };
}

export function evaluateStandingStructuredTriggers({
  families = [],
  structuredFacts = {},
  availableParentFamilyIds = []
} = {}) {
  const matches = [];
  const sensorWarnings = [];
  const reasonCounts = {};
  const matchedCountsByKind = {};
  const perTrigger = [];
  const availableParentIds = new Set(uniqueStrings(availableParentFamilyIds));
  const countReason = (reason) => {
    reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
  };
  const recordTrigger = (trigger, reason, detail = {}) => {
    perTrigger.push({
      triggerId: String(trigger?.triggerId || ""),
      ruleKind: String(trigger?.ruleKind || ""),
      reason,
      missingFacts: uniqueStrings(detail.missingFacts),
      ...(Number.isInteger(detail.familyMatchCount)
        ? { familyMatchCount: detail.familyMatchCount }
        : {}),
      ...(detail.unresolvedConditionIds?.length
        ? { unresolvedConditionIds: uniqueStrings(detail.unresolvedConditionIds) }
        : {})
    });
  };

  const orderedTriggers = asArray(ARTIFACT.triggers).sort((left, right) => (
    triggerKindOrder(left.ruleKind) - triggerKindOrder(right.ruleKind)
    || String(left.triggerId || "").localeCompare(String(right.triggerId || ""))
  ));
  for (const trigger of orderedTriggers) {
    const familyMatches = asArray(families).filter((family) => (
      standingFamilyMatchesSelector(family, trigger.familySelector)
    ));
    if (familyMatches.length !== 1) {
      const reason = familyMatches.length ? "family_selector_ambiguous" : "family_not_in_current_master";
      countReason(reason);
      if (trigger.failureMode === "sensor_warning") {
        sensorWarnings.push({
          triggerId: trigger.triggerId,
          reason,
          familyMatchCount: familyMatches.length
        });
      }
      recordTrigger(trigger, reason, { familyMatchCount: familyMatches.length });
      continue;
    }
    const family = familyMatches[0];
    let parentFamilyIds = [];
    const unresolvedConditions = [];
    if (trigger.ruleKind === "dependent_addon") {
      parentFamilyIds = asArray(trigger.parentFamilySelectors)
        .flatMap((selector) => asArray(families)
          .filter((candidate) => standingFamilyMatchesSelector(candidate, selector))
          .map((candidate) => String(candidate.familyId || "")))
        .filter((familyId) => availableParentIds.has(familyId));
      if (!parentFamilyIds.length) {
        countReason("parent_family_missing");
        recordTrigger(trigger, "parent_family_missing");
        continue;
      }
      const facilityKey = String(trigger.requiredFacilityStandardKey || "");
      if (
        facilityKey
        && !asArray(valueAtPath(structuredFacts, "facility.activeStandardKeys"))
          .includes(facilityKey)
      ) {
        if (trigger.failureMode === "confirm_with_note") {
          unresolvedConditions.push({
            conditionId: "required_facility_standard",
            instruction: `施設基準「${facilityKey}」の届出状況を確認してください。`
          });
        } else {
          countReason("facility_standard_missing");
          recordTrigger(trigger, "facility_standard_missing");
          continue;
        }
      }
    }
    const factResults = asArray(trigger.requiredPositiveFacts).map((condition) => ({
      fact: condition.fact,
      passed: factConditionPasses(condition, structuredFacts)
    }));
    if (factResults.some((result) => !result.passed)) {
      const missingFacts = factResults
        .filter((result) => !result.passed)
        .map((result) => result.fact);
      countReason("required_positive_fact_missing");
      if (trigger.failureMode === "sensor_warning") {
        sensorWarnings.push({
          triggerId: trigger.triggerId,
          reason: "required_positive_fact_missing",
          missingFacts
        });
      }
      recordTrigger(trigger, "required_positive_fact_missing", { missingFacts });
      continue;
    }
    const matchedReason = unresolvedConditions.length
      ? "matched_with_conditions"
      : "matched";
    countReason(matchedReason);
    matchedCountsByKind[trigger.ruleKind] = Number(
      matchedCountsByKind[trigger.ruleKind] || 0
    ) + 1;
    availableParentIds.add(String(family.familyId || ""));
    recordTrigger(trigger, matchedReason, {
      unresolvedConditionIds: unresolvedConditions.map((condition) => condition.conditionId)
    });
    matches.push({
      trigger,
      family,
      parentFamilyIds,
      matchedFacts: factResults.map((result) => result.fact),
      humanVerifiableConditions: asArray(trigger.humanVerifiableConditions),
      unresolvedConditions
    });
  }

  return {
    matches,
    sensorWarnings,
    diagnostics: {
      artifact: standingStructuredTriggerArtifactMetadata(),
      triggerCount: asArray(ARTIFACT.triggers).length,
      matchedCount: matches.length,
      matchedCountsByKind,
      sensorWarningCount: sensorWarnings.length,
      reasonCounts,
      perTrigger
    }
  };
}

function hasExplicitMedicationReductionTwoOrMore(value = "") {
  return splitClinicalEvidenceClauses(value).some((clause) => {
    const text = normalizeClinicalPredicateText(clause?.text || "");
    if (
      !text
      || isPastOrExternalClinicalServiceContext(text)
      || isFutureOrOrderOnlyClinicalServiceContext(text)
      || /(?:中止|減薬|減量).{0,8}(?:せず|しない|していない|なし)/u.test(text)
    ) {
      return false;
    }
    const count = "(?:[2-9２-９]|二|三|四|五|六|七|八|九)";
    const medicationCount = new RegExp(`${count}(?:剤|種類|薬剤)`, "u");
    const reduction = /(?:中止|減薬|減量|削減|整理)/u;
    if (!medicationCount.test(text) || !reduction.test(text)) {
      return false;
    }
    const countBeforeAction = new RegExp(
      `${count}(?:剤|種類|薬剤).{0,32}(?:中止|減薬|減量|削減|整理)`,
      "u"
    );
    const actionBeforeCount = new RegExp(
      `(?:中止|減薬|減量|削減|整理).{0,32}${count}(?:剤|種類|薬剤)`,
      "u"
    );
    return countBeforeAction.test(text) || actionBeforeCount.test(text);
  });
}

function standingFamilyMatchesSelector(family = {}, selector = {}) {
  if (String(family.name || "") !== String(selector.name || "")) {
    return false;
  }
  const hierarchy = family.hierarchy || {};
  return ["chapter", "part", "alphaPart", "section", "branch"].every((field) => (
    String(hierarchy[field] || "") === String(selector?.hierarchy?.[field] || "")
  ));
}

function factConditionPasses(condition = {}, facts = {}) {
  const actual = valueAtPath(facts, String(condition.fact || ""));
  if (condition.operator === "equals") {
    return actual === condition.value;
  }
  if (condition.operator === "gte") {
    return Number.isFinite(Number(actual)) && Number(actual) >= Number(condition.value);
  }
  if (condition.operator === "contains") {
    return asArray(actual).includes(condition.value);
  }
  if (condition.operator === "contains_any") {
    const actualValues = new Set(asArray(actual));
    return asArray(condition.value).some((value) => actualValues.has(value));
  }
  if (condition.operator === "not_contains") {
    return !asArray(actual).includes(condition.value);
  }
  return false;
}

function valueAtPath(value, path) {
  return path.split(".").filter(Boolean).reduce((current, key) => (
    current && typeof current === "object" ? current[key] : undefined
  ), value);
}

function uniqueStructuredDiagnoses(values = []) {
  const excludedStatuses = new Set([
    "denied",
    "excluded",
    "family_history",
    "history",
    "inactive",
    "negated",
    "none",
    "resolved",
    "ruled_out"
  ]);
  const names = new Set();
  for (const value of values) {
    const diagnosis = isPlainObject(value) ? value : { name: value };
    const status = String(diagnosis.status || "").trim().toLowerCase();
    const name = String(diagnosis.name || diagnosis.displayName || "").trim();
    if (!name || excludedStatuses.has(status)) {
      continue;
    }
    names.add(name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase());
  }
  return names;
}

function isCurrentOwnStructuredClinicalEvent(event = {}) {
  const actionStatus = structuredClinicalEventActionStatus(event);
  if (!["performed", "prescribed", "administered", "instruction_only"].includes(actionStatus)) {
    return false;
  }
  const temporalRelation = String(
    event?.temporalRelation
    || event?.temporal_relation
    || event?.dateRelation
    || event?.date_relation
    || ""
  ).trim();
  if (!["current_visit", "same_day_but_unknown"].includes(temporalRelation)) {
    return false;
  }
  const providerOwnership = String(
    event?.providerOwnership
    || event?.provider_ownership
    || ""
  ).trim();
  return providerOwnership === "own_clinic";
}

function isCurrentOwnStructuredManagementEvent(event = {}) {
  if (!["management", "counseling"].includes(structuredClinicalEventType(event))) {
    return false;
  }
  if (!["performed", "instruction_only", "unknown", ""].includes(
    structuredClinicalEventActionStatus(event)
  )) {
    return false;
  }
  if (!["current_visit", "same_day_but_unknown"].includes(
    structuredClinicalEventTemporalRelation(event)
  )) {
    return false;
  }
  return structuredClinicalEventProviderOwnership(event) === "own_clinic";
}

function structuredClinicalEventType(event = {}) {
  return String(event?.type || event?.eventType || event?.event_type || "").trim();
}

function structuredClinicalEventActionStatus(event = {}) {
  return String(event?.actionStatus || event?.action_status || event?.status || "").trim();
}

function structuredClinicalEventBillingDomain(event = {}) {
  return String(event?.billingDomain || event?.billing_domain || "").trim();
}

function structuredClinicalEventTemporalRelation(event = {}) {
  return String(
    event?.temporalRelation
    || event?.temporal_relation
    || event?.dateRelation
    || event?.date_relation
    || ""
  ).trim();
}

function structuredClinicalEventProviderOwnership(event = {}) {
  return String(
    event?.providerOwnership
    || event?.provider_ownership
    || ""
  ).trim();
}

function isCurrentManagementStandingMention(mention = {}) {
  const status = String(mention?.status || "").trim();
  if (!["continued", "changed"].includes(status)) {
    return false;
  }
  const target = String(mention?.target || "").trim();
  const text = String(mention?.text || "").trim();
  const clauses = text
    ? splitClinicalEvidenceClauses(text).map((clause) => clause?.text || "")
    : [];
  const values = clauses.length ? clauses : [target];
  return uniqueStrings(values).some((value) => {
    const normalized = normalizeClinicalPredicateText(value);
    return Boolean(normalized)
      && !isNegatedClinicalServiceContext(normalized)
      && !isPastOrExternalClinicalServiceContext(normalized)
      && !isFutureOrOrderOnlyClinicalServiceContext(normalized)
      && !/(?:先週|前週|昨日|一昨日|昨年|前年|次月|翌月|来月|次週|翌週|来週|次年度|翌年度)/u.test(normalized)
      && /(?:管理|指導|療養|連携|ケア|支援|情報共有|共有|調整|フォロー)/u.test(normalized);
  });
}

function currentManagementOrCounselingTextSignalCount(value = "") {
  return splitClinicalEvidenceClauses(value).filter((clause) => {
    const normalized = normalizeClinicalPredicateText(clause?.text || "");
    if (!normalized
      || isNegatedClinicalServiceContext(normalized)
      || isPastOrExternalClinicalServiceContext(normalized)
      || isFutureOrOrderOnlyClinicalServiceContext(normalized)
      || /(?:算定|請求|点数|レセプト|施設基準).{0,20}(?:説明|指導|確認|検討)|(?:説明|指導|確認|検討).{0,20}(?:算定|請求|点数|レセプト|施設基準)/u.test(normalized)
      || /(?:説明|指導|助言|確認|傾聴|相談|連携|共有|調整|支援)(?:は|を)?(?:せず|しない|していない|なし)|注意(?:を)?促(?:さず|していない|していません)/u.test(normalized)) {
      return false;
    }
    return /(?:再)?(?:説明|指導(?!管理料)|助言|確認|傾聴|相談|連携|情報共有|共有|調整|支援)(?:(?:を|し|して|した|する|継続|済み|あり)|[。．.!！?？]|$)|注意(?:を)?促(?:し|して|した|す|した。|す。)/u.test(normalized);
  }).length;
}

function currentLongitudinalManagementPlanSignalCount(value = "") {
  const clauses = splitClinicalEvidenceClauses(value).map((clause) => (
    normalizeClinicalPredicateText(clause?.text || "")
  )).filter(Boolean);
  const currentClauses = clauses.filter((text) => (
    !isNegatedClinicalServiceContext(text)
    && !isPastOrExternalClinicalServiceContext(text)
    && !/(?:継続|維持|管理|フォロー|見直(?:し|す))(?:は|を)?(?:しない|せず|していない|なし)/u.test(text)
  ));
  const hasCurrentAssessment = currentClauses.some((text) => (
    /^A[)）]/u.test(text)
    && /(?:安定|不変|改善|増悪|維持|コントロール|経過|状態|所見|症状|診断)/u.test(text)
  ));
  const hasCurrentPlan = currentClauses.some((text) => (
    /^P[)）]/u.test(text)
    && !isFutureOrOrderOnlyClinicalServiceContext(text)
    && /(?:継続|維持|経過観察|フォロー|変更|調整|見直し)/u.test(text)
  ));
  const hasFollowupPlan = clauses.some((text) => (
    !isNegatedClinicalServiceContext(text)
    && !isPastOrExternalClinicalServiceContext(text)
    && /(?:次回|次月|来月|次週|来週|今後|後日)/u.test(text)
    && /(?:訪問|再評価|評価|見直(?:し|す)|確認|フォロー|診察|受診|経過)/u.test(text)
  ));
  return hasCurrentAssessment && hasCurrentPlan && hasFollowupPlan ? 1 : 0;
}

function enumCounts(values = []) {
  const counts = {};
  for (const value of values) {
    const key = String(value || "").trim() || "missing";
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function finiteCountOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function structuredOptionEntryCount(options = {}, keys = []) {
  return keys.reduce((count, key) => (
    count + (Array.isArray(options?.[key]) ? options[key].length : 0)
  ), 0);
}

function structuredOptionTexts(options = {}, keys = []) {
  return keys.flatMap((key) => asArray(options?.[key]).map((entry) => (
    typeof entry === "string"
      ? entry
      : [
        entry?.name,
        entry?.displayName,
        entry?.drugName,
        entry?.text
      ].filter(Boolean).join(" ")
  ))).filter(Boolean);
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function withinThreeMonths(startDate, serviceDate) {
  if (!startDate || !serviceDate || serviceDate < startDate) {
    return null;
  }
  const start = new Date(`${startDate}T00:00:00Z`);
  const boundary = new Date(start);
  boundary.setUTCMonth(boundary.getUTCMonth() + 3);
  return serviceDate < boundary.toISOString().slice(0, 10);
}

function isoDateOrNull(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : null;
}

function triggerKindOrder(value) {
  if (value === "standing_family") return 0;
  if (value === "device_management") return 1;
  if (value === "dependent_addon") return 2;
  return 9;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertArtifactIntegrity(artifact) {
  if (artifact?.schemaVersion !== "fee-standing-structured-trigger-artifact-v3") {
    throw new TypeError("unsupported fee standing trigger artifact schema");
  }
  const payload = {
    schemaVersion: artifact.schemaVersion,
    revision: artifact.revision,
    effectiveFrom: artifact.effectiveFrom,
    verifiedAt: artifact.verifiedAt,
    sourceDefinitionSha256: artifact.sourceDefinitionSha256,
    sourceDocuments: artifact.sourceDocuments,
    triggers: artifact.triggers
  };
  const actual = sha256(canonicalJson(payload));
  if (actual !== artifact.artifactPayloadSha256) {
    throw new TypeError("fee standing trigger artifact integrity check failed");
  }
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  return asArray(values).filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
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
