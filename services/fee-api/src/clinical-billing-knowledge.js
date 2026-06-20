import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const specificDiseaseTargetsPath = fileURLToPath(new URL("./clinical-billing-knowledge-data/specific-disease-targets.json", import.meta.url));
const specificDiseaseTargetsData = JSON.parse(readFileSync(specificDiseaseTargetsPath, "utf8"));
const managementSignalRulesPath = fileURLToPath(new URL("./clinical-billing-knowledge-data/management-signal-rules.json", import.meta.url));
const managementSignalRulesData = JSON.parse(readFileSync(managementSignalRulesPath, "utf8"));

export const CLINICAL_BILLING_KNOWLEDGE_VERSION = "clinical-billing-knowledge-v1";
export const SPECIFIC_DISEASE_TARGETS_VERSION = specificDiseaseTargetsData.version || "specific-disease-targets-unknown";
export const MANAGEMENT_SIGNAL_RULES_VERSION = managementSignalRulesData.version || "management-signal-rules-unknown";

const SPECIFIC_DISEASE_MANAGEMENT_MASTER_CANDIDATES = Object.freeze({
  clinic: Object.freeze({
    code: "113001810",
    name: "特定疾患療養管理料（診療所）",
    points: 225
  })
});

const SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_MASTER_CANDIDATES = Object.freeze({
  in_house: Object.freeze({
    code: "120005610",
    name: "特定疾患処方管理加算（処方料）",
    points: 56
  }),
  outside_prescription: Object.freeze({
    code: "120005710",
    name: "特定疾患処方管理加算（処方箋料）",
    points: 56
  })
});

export async function candidateProposalsFromClinicalBillingKnowledge({
  diagnoses = [],
  clinicalEvents = [],
  visitMedication = null,
  clinicalText = "",
  priorSessions = [],
  serviceDate = "",
  medicationDeliveryKind = "",
  searchProcedureCandidateItem = null,
  candidateLineFromProcedureCandidate = null,
  resolutionOptions = {}
} = {}) {
  const proposals = [];
  const target = specificDiseaseTargetFromDiagnoses(diagnoses);

  const managementEvidence = target ? currentSpecificDiseaseManagementEvidence(clinicalEvents) : null;
  if (target && managementEvidence) {
    const managementProposalId = `specific_disease_management_${candidateIdPart([target.name, managementEvidence.name, managementEvidence.evidence].join("_"))}`;
    const managementMasterItem = await advisoryProcedureMasterItem(searchProcedureCandidateItem, [
      "特定疾患療養管理料（診療所）",
      "特定疾患療養管理料"
    ], [
      /特定疾患療養管理料/u,
      /診療所/u
    ]) || fallbackSpecificDiseaseManagementMasterItem();
    const monthlyLimit = specificDiseaseManagementMonthlyLimit({
      priorSessions,
      serviceDate,
      currentCode: managementMasterItem?.code || fallbackSpecificDiseaseManagementMasterItem().code
    });
    const monthlyLimitText = specificDiseaseManagementMonthlyLimitText(monthlyLimit);
    const managementPotentialPoints = Number(managementMasterItem?.points || managementMasterItem?.totalPoints || 225);
    proposals.push(reviewOnlyIncreaseProposal({
      proposalId: managementProposalId,
      ruleId: "B000_specific_disease_management",
      title: "特定疾患療養管理料の確認",
      reason: [
        `${target.name}を主病として管理・指導した可能性があります。`,
        monthlyLimitText,
        "対象疾患、管理主体、療養計画、同月履歴を確認してください。"
      ].filter(Boolean).join(""),
      conditionText: [
        "対象疾患に該当し、療養上の管理・指導を診療録に記録し、同月算定条件を満たす場合に算定候補になります。",
        monthlyLimitText,
        "自動では点数に入れていません。"
      ].filter(Boolean).join(""),
      evidence: managementEvidence.evidence,
      potentialPoints: managementPotentialPoints,
      orderType: "procedure",
      source: "clinical_billing_knowledge:specific_disease_management",
      topicCode: "target_disease_check",
      requiredInput: "対象疾患、主病管理、療養計画・指導記録、同月算定履歴",
      resolutionOptions: resolutionOptions.targetDiseaseCheck,
      monthlyLimit,
      knowledge: {
        version: CLINICAL_BILLING_KNOWLEDGE_VERSION,
        targetVersion: SPECIFIC_DISEASE_TARGETS_VERSION,
        target,
        status: monthlyLimit.status === "limit_reached" ? "needs_review" : "candidate_high"
      },
      candidateLine: managementMasterItem?.code && typeof candidateLineFromProcedureCandidate === "function"
        ? candidateLineFromProcedureCandidate({
          proposalId: managementProposalId,
          reason: [
            "特定疾患療養管理料は条件確認後に算定候補へ移せます。",
            monthlyLimitText
          ].filter(Boolean).join(""),
          item: managementMasterItem,
          title: "特定疾患療養管理料"
        })
        : null
    }));
  }

  const longPrescriptionEvidence = longTermSpecificDiseasePrescriptionEvidence({
    clinicalEvents,
    visitMedication,
    clinicalText
  });
  if (target && longPrescriptionEvidence) {
    const prescriptionProposalId = `specific_disease_prescription_management_${candidateIdPart([target.name, longPrescriptionEvidence.evidence].join("_"))}`;
    const prescriptionMasterItem = await advisoryProcedureMasterItem(searchProcedureCandidateItem, [
      "特定疾患処方管理加算",
      "特定疾患処方管理加算２",
      "特定疾患処方管理加算2"
    ], [
      /特定疾患処方管理加算/u
    ]) || fallbackSpecificDiseasePrescriptionManagementMasterItem(medicationDeliveryKind);
    proposals.push(reviewOnlyIncreaseProposal({
      proposalId: prescriptionProposalId,
      ruleId: "F_specific_disease_prescription_management",
      title: "特定疾患処方管理加算の確認",
      reason: `${target.name}の患者に長期処方がある可能性があります。処方日数、主病、同月履歴を確認してください。`,
      conditionText: "特定疾患を主病として管理しており、処方日数などの要件を満たす場合に算定候補になります。自動では点数に入れていません。",
      evidence: longPrescriptionEvidence.evidence,
      potentialPoints: Number(prescriptionMasterItem?.points || prescriptionMasterItem?.totalPoints || 56),
      orderType: "medication",
      source: "clinical_billing_knowledge:specific_disease_prescription",
      topicCode: "same_month_check",
      requiredInput: "対象疾患、処方日数、同月算定履歴、院内/院外処方の区分",
      resolutionOptions: resolutionOptions.sameMonthCheck,
      knowledge: {
        version: CLINICAL_BILLING_KNOWLEDGE_VERSION,
        targetVersion: SPECIFIC_DISEASE_TARGETS_VERSION,
        target,
        status: "candidate_high"
      },
      candidateLine: prescriptionMasterItem?.code && typeof candidateLineFromProcedureCandidate === "function"
        ? candidateLineFromProcedureCandidate({
          proposalId: prescriptionProposalId,
          reason: "特定疾患処方管理加算は条件確認後に算定候補へ移せます。",
          item: prescriptionMasterItem,
          title: "特定疾患処方管理加算"
        })
        : null
    }));
  }

  proposals.push(...await candidateProposalsFromManagementSignalRules({
    diagnoses,
    clinicalEvents,
    clinicalText,
    searchProcedureCandidateItem,
    candidateLineFromProcedureCandidate,
    resolutionOptions
  }));

  return normalizeCandidateProposals(proposals);
}

export function currentSpecificDiseaseManagementEvidence(clinicalEvents = []) {
  const events = asArray(clinicalEvents).filter((event) => (
    ["management", "counseling"].includes(normalizeClinicalEventType(event))
    && isBillableClinicalEvent(event)
    && !isNegatedClinicalEvent(event)
  ));
  for (const event of events) {
    const evidence = clinicalEventEvidence(event);
    const text = normalizeClinicalText([
      clinicalEventName(event),
      evidence,
      event?.review_reason,
      event?.reviewReason
    ].join(" "));
    if (!text || isPastOrExternalClinicalServiceContext(text) || isFutureOrOrderOnlyContext(text)) {
      continue;
    }
    if (/(療養計画|管理|指導|説明|服薬|増悪時|生活指導|継続管理|方針)/u.test(text)) {
      return {
        name: clinicalEventName(event),
        evidence
      };
    }
  }
  return null;
}

export function specificDiseaseTargetFromDiagnoses(diagnoses = []) {
  for (const diagnosis of asArray(diagnoses)) {
    const name = normalizeClinicalText(diagnosis?.name || diagnosis?.diagnosisName || diagnosis);
    const status = normalizeClinicalText(diagnosis?.status || "");
    if (!name || /既往|家族歴|疑い/u.test(status)) {
      continue;
    }
    const target = specificDiseaseTargets().find((entry) => asArray(entry.matchTerms).some((term) => {
      const normalizedTerm = normalizeClinicalText(term);
      return normalizedTerm && name.includes(normalizedTerm);
    }));
    if (target) {
      return {
        targetId: target.targetId,
        name,
        label: target.label || name,
        billingFamilies: asArray(target.billingFamilies),
        source: target.source || specificDiseaseTargetsData.source || "",
        targetVersion: SPECIFIC_DISEASE_TARGETS_VERSION
      };
    }
  }
  return null;
}

export function specificDiseaseManagementMonthlyLimit({
  priorSessions = [],
  serviceDate = "",
  currentCode = ""
} = {}) {
  const currentMonth = String(serviceDate || "").slice(0, 7);
  const events = [];
  const seen = new Set();
  for (const prior of asArray(priorSessions)) {
    const priorDate = String(prior?.serviceDate || "").trim();
    if (!priorDate || !currentMonth || priorDate.slice(0, 7) !== currentMonth) {
      continue;
    }
    const lineItems = asArray(prior?.calculationResult?.lineItems);
    for (const line of lineItems) {
      if (!isHistoryCountableCalculationLine(line) || !isSpecificDiseaseManagementFeeLine(line)) {
        continue;
      }
      const code = String(line?.code || currentCode || "").trim();
      const key = `${priorDate}|${code || normalizeClinicalText(line?.name || "")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      events.push({
        serviceDate: priorDate,
        code,
        name: String(line?.name || "").trim(),
        points: Number(line?.points || line?.totalPoints || 0) || null
      });
    }
  }
  events.sort((left, right) => String(left.serviceDate || "").localeCompare(String(right.serviceDate || "")));
  const priorCount = events.length;
  const maxPerMonth = 2;
  return {
    family: "specific_disease_management",
    maxPerMonth,
    priorCount,
    currentOrdinal: priorCount + 1,
    previousDates: uniqueStrings(events.map((event) => event.serviceDate)).slice(0, 8),
    previousEvents: events.slice(0, 8),
    status: priorCount >= maxPerMonth
      ? "limit_reached"
      : priorCount === maxPerMonth - 1
        ? "within_limit_exactly"
        : "within_limit"
  };
}

function specificDiseaseTargets() {
  return asArray(specificDiseaseTargetsData.targets);
}

function managementSignalRules() {
  return asArray(managementSignalRulesData.rules);
}

async function candidateProposalsFromManagementSignalRules({
  diagnoses = [],
  clinicalEvents = [],
  clinicalText = "",
  searchProcedureCandidateItem = null,
  candidateLineFromProcedureCandidate = null,
  resolutionOptions = {}
} = {}) {
  const proposals = [];
  const diagnosisMatches = activeDiagnosisMatches(diagnoses);
  for (const rule of managementSignalRules()) {
    const diagnosis = matchingDiagnosisForTerms(diagnosisMatches, rule.diagnosisTerms);
    if (asArray(rule.diagnosisTerms).length && !diagnosis && rule.requireDiagnosisMatch !== false) {
      continue;
    }
    const evidence = managementSignalEvidence(rule, {
      clinicalEvents,
      clinicalText
    });
    if (!evidence) {
      continue;
    }
    const proposalId = `management_signal_${candidateIdPart([rule.ruleId, diagnosis?.name, evidence.evidence].join("_"))}`;
    const masterItem = await advisoryProcedureMasterItem(
      searchProcedureCandidateItem,
      asArray(rule.queryHints),
      asArray(rule.preferredPatterns).map((pattern) => new RegExp(pattern, "u"))
    );
    const potentialPoints = Number(masterItem?.points || masterItem?.totalPoints || rule.potentialPoints || 0);
    proposals.push(reviewOnlyIncreaseProposal({
      proposalId,
      ruleId: rule.ruleId,
      title: rule.title,
      reason: [
        rule.clinicalLabel || `${rule.displayName || rule.title}に関係する記載があります。`,
        diagnosis ? `関連病名: ${diagnosis.name}。` : "",
        "算定する場合は条件と同月履歴を確認してください。"
      ].filter(Boolean).join(""),
      conditionText: `${rule.displayName || rule.title}は、対象疾患・実施内容・記録・同月履歴などを満たす場合に候補になります。自動では点数に入れていません。`,
      evidence: evidence.evidence,
      potentialPoints,
      orderType: rule.orderType || "procedure",
      source: "clinical_billing_knowledge:management_signal",
      topicCode: rule.topicCode || "target_disease_check",
      requiredInput: rule.requiredInput || "対象疾患、実施内容、記録、同月算定履歴",
      resolutionOptions: resolutionOptions[rule.topicCode] || [],
      knowledge: {
        version: CLINICAL_BILLING_KNOWLEDGE_VERSION,
        signalRulesVersion: MANAGEMENT_SIGNAL_RULES_VERSION,
        ruleId: rule.ruleId,
        family: rule.family,
        diagnosis: diagnosis || null,
        status: "candidate_medium"
      },
      candidateLine: masterItem?.code && typeof candidateLineFromProcedureCandidate === "function"
        ? candidateLineFromProcedureCandidate({
          proposalId,
          reason: `${rule.displayName || rule.title}は条件確認後に算定候補へ移せます。`,
          item: masterItem,
          title: rule.displayName || rule.title
        })
        : null
    }));
  }
  return proposals;
}

function managementSignalEvidence(rule = {}, {
  clinicalEvents = [],
  clinicalText = ""
} = {}) {
  const terms = asArray(rule.eventTerms).map(normalizeClinicalText).filter(Boolean);
  if (!terms.length) {
    return null;
  }
  for (const event of asArray(clinicalEvents)) {
    if (!isBillableClinicalEvent(event) || isNegatedClinicalEvent(event)) {
      continue;
    }
    const evidence = clinicalEventEvidence(event);
    const text = normalizeClinicalText([
      clinicalEventName(event),
      evidence,
      event?.review_reason,
      event?.reviewReason
    ].join(" "));
    if (!text || isPastOrExternalClinicalServiceContext(text) || isFutureOrOrderOnlyContext(text)) {
      continue;
    }
    if (terms.some((term) => text.includes(term))) {
      return {
        source: "clinical_event",
        name: clinicalEventName(event),
        evidence: evidence || clinicalEventName(event)
      };
    }
  }
  for (const sentence of splitClinicalSentences(clinicalText)) {
    const text = normalizeClinicalText(sentence);
    if (!text || isPastOrExternalClinicalServiceContext(text) || isFutureOrOrderOnlyContext(text) || isNegatedClinicalServiceContext(text)) {
      continue;
    }
    if (terms.some((term) => text.includes(term))) {
      return {
        source: "clinical_text",
        evidence: sentence
      };
    }
  }
  return null;
}

function activeDiagnosisMatches(diagnoses = []) {
  const result = [];
  for (const diagnosis of asArray(diagnoses)) {
    const name = normalizeClinicalText(diagnosis?.name || diagnosis?.diagnosisName || diagnosis);
    const status = normalizeClinicalText(diagnosis?.status || "");
    if (!name || /既往|家族歴|疑い/u.test(status)) {
      continue;
    }
    result.push({
      name,
      status
    });
  }
  return result;
}

function matchingDiagnosisForTerms(diagnoses = [], terms = []) {
  const normalizedTerms = asArray(terms).map(normalizeClinicalText).filter(Boolean);
  if (!normalizedTerms.length) {
    return null;
  }
  return asArray(diagnoses).find((diagnosis) => normalizedTerms.some((term) => diagnosis.name.includes(term))) || null;
}

async function advisoryProcedureMasterItem(searchProcedureCandidateItem, queries = [], preferredPatterns = []) {
  if (typeof searchProcedureCandidateItem !== "function") {
    return null;
  }
  try {
    return await searchProcedureCandidateItem(queries, preferredPatterns);
  } catch {
    return null;
  }
}

function fallbackSpecificDiseaseManagementMasterItem() {
  return SPECIFIC_DISEASE_MANAGEMENT_MASTER_CANDIDATES.clinic;
}

function fallbackSpecificDiseasePrescriptionManagementMasterItem(deliveryKind = "") {
  const normalized = String(deliveryKind || "").trim();
  if (normalized === "outside_prescription") {
    return SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_MASTER_CANDIDATES.outside_prescription;
  }
  return SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_MASTER_CANDIDATES.in_house;
}

function isSpecificDiseaseManagementFeeLine(line = {}) {
  const code = String(line?.code || line?.procedure_code || line?.procedureCode || "").trim();
  const name = normalizeClinicalText(line?.name || line?.procedure_name || line?.procedureName || "");
  if (code === "113001810") {
    return true;
  }
  return /特定疾患療養管理料/u.test(name);
}

function isHistoryCountableCalculationLine(line = {}) {
  const status = String(line?.status || "").trim().toLowerCase();
  if (status === "rejected" || status === "blocked" || status === "excluded") {
    return false;
  }
  if (line?.includedInTotal === false) {
    return false;
  }
  return true;
}

function specificDiseaseManagementMonthlyLimitText(monthlyLimit = {}) {
  if (!monthlyLimit || typeof monthlyLimit !== "object") {
    return "";
  }
  const maxPerMonth = Number(monthlyLimit.maxPerMonth || 2);
  const priorCount = Number(monthlyLimit.priorCount || 0);
  const ordinal = Number(monthlyLimit.currentOrdinal || priorCount + 1);
  const previousDates = asArray(monthlyLimit.previousDates).map((date) => String(date || "").trim()).filter(Boolean);
  if (monthlyLimit.status === "limit_reached") {
    const datesText = previousDates.length ? `前回: ${previousDates.join("、")}。` : "";
    return `同月${maxPerMonth}回までの候補です。すでに同月${priorCount}回の履歴があります。${datesText}算定する場合は同月履歴を確認してください。`;
  }
  if (monthlyLimit.status === "within_limit_exactly") {
    const datesText = previousDates.length ? `前回: ${previousDates.join("、")}。` : "";
    return `同月${maxPerMonth}回までの候補です。本日は当月${ordinal}回目で上限ちょうどです。${datesText}`;
  }
  return `同月${maxPerMonth}回までの候補です。本日は当月${ordinal}回目として扱える可能性があります。`;
}

function longTermSpecificDiseasePrescriptionEvidence({
  clinicalEvents = [],
  visitMedication = null,
  clinicalText = ""
} = {}) {
  const medicationEvents = asArray(clinicalEvents).filter((event) => (
    normalizeClinicalEventType(event) === "medication"
    && isBillableClinicalEvent(event)
    && !isNegatedClinicalEvent(event)
  ));
  for (const event of medicationEvents) {
    const days = Number(event?.days || event?.durationDays || event?.quantity?.days || 0);
    const evidence = clinicalEventEvidence(event);
    if (Number.isFinite(days) && days >= 28) {
      return { evidence };
    }
    const inferredDays = prescriptionDaysFromText(evidence);
    if (inferredDays >= 28) {
      return { evidence };
    }
  }
  const deliveryKind = String(visitMedication?.delivery_kind || "").trim();
  if (deliveryKind && deliveryKind !== "outside_prescription" && deliveryKind !== "in_house") {
    return null;
  }
  for (const sentence of splitClinicalSentences(clinicalText)) {
    if (!/(処方|処方箋|院外|院内|投薬)/u.test(sentence)) {
      continue;
    }
    if (isPastOrExternalClinicalServiceContext(sentence) || isFutureOrOrderOnlyContext(sentence) || isNegatedClinicalServiceContext(sentence)) {
      continue;
    }
    if (prescriptionDaysFromText(sentence) >= 28) {
      return { evidence: sentence };
    }
  }
  return null;
}

function prescriptionDaysFromText(text = "") {
  const match = normalizeClinicalText(text).match(/(\d{1,3})\s*日分/u);
  const days = Number(match?.[1] || 0);
  return Number.isFinite(days) ? days : 0;
}

function reviewOnlyIncreaseProposal({
  proposalId,
  ruleId = "",
  title,
  reason,
  conditionText,
  evidence = "",
  potentialPoints = 0,
  orderType = "procedure",
  source = "increase_opportunity",
  topicCode = "",
  requiredInput = "",
  resolutionOptions = [],
  monthlyLimit = null,
  candidateLine = null,
  knowledge = null
} = {}) {
  return {
    proposalId,
    ruleId,
    title,
    reason,
    conditionText,
    basis: "カルテ本文と病名から、算定漏れの可能性として抽出しました。条件確認が必要なため自動算定には入れていません。",
    evidence,
    actionType: "not_billable_now",
    potentialPoints: Number(potentialPoints || 0),
    orderType,
    source,
    monthlyLimit,
    candidateLine,
    knowledge,
    policy: {
      generationSource: "clinical_billing_knowledge",
      riskGate: "review_only",
      requiredInput
    },
    resolutionOptions: asArray(resolutionOptions)
  };
}

function normalizeCandidateProposals(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    if (!value?.proposalId || seen.has(value.proposalId)) {
      continue;
    }
    seen.add(value.proposalId);
    result.push(value);
  }
  return result.slice(0, 50);
}

function normalizeClinicalEventType(event = {}) {
  return String(event?.type || "other").trim();
}

function normalizeClinicalEventStatus(event = {}) {
  return String(event?.status || legacyStatusFromClinicalEvent({
    actionStatus: event?.action_status || event?.actionStatus,
    temporalRelation: event?.temporal_relation || event?.temporalRelation,
    providerOwnership: event?.provider_ownership || event?.providerOwnership
  }) || "unclear").trim();
}

function isBillableClinicalEvent(event = {}) {
  const actionStatus = String(event?.action_status || event?.actionStatus || normalizeClinicalEventStatus(event)).trim();
  if (!["performed", "prescribed", "administered"].includes(actionStatus)) {
    return false;
  }
  const temporalRelation = String(event?.temporal_relation || event?.temporalRelation || normalizeClinicalEventDateRelation(event)).trim();
  if (["future", "past"].includes(temporalRelation)) {
    return false;
  }
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  if (["same_institution_other_department", "other_provider"].includes(providerOwnership)) {
    return false;
  }
  return true;
}

function normalizeClinicalEventDateRelation(event = {}) {
  return legacyDateRelationFromClinicalEvent({
    temporalRelation: event?.temporal_relation || event?.temporalRelation || event?.date_relation || event?.dateRelation,
    providerOwnership: event?.provider_ownership || event?.providerOwnership
  });
}

function normalizeClinicalEventProviderOwnership(event = {}) {
  const value = String(event?.provider_ownership || event?.providerOwnership || "unknown").trim();
  if (value === "other_department") {
    return "same_institution_other_department";
  }
  return value;
}

function isNegatedClinicalEvent(event = {}) {
  const actionStatus = String(event?.action_status || event?.actionStatus || normalizeClinicalEventStatus(event)).trim();
  return ["not_performed", "negated"].includes(actionStatus);
}

function clinicalEventName(event = {}) {
  return String(event?.name || "").trim();
}

function clinicalEventEvidence(event = {}) {
  return [event?.evidence, event?.name, event?.review_reason]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function legacyStatusFromClinicalEvent({
  actionStatus = "",
  temporalRelation = "",
  providerOwnership = ""
} = {}) {
  const action = String(actionStatus || "").trim();
  if (["performed", "administered", "prescribed"].includes(action)) {
    return action === "prescribed" ? "prescribed" : "performed";
  }
  if (["not_performed", "negated"].includes(action)) {
    return "not_performed";
  }
  const temporal = String(temporalRelation || "").trim();
  if (["future", "planned", "considered"].includes(temporal)) {
    return "planned";
  }
  const ownership = String(providerOwnership || "").trim();
  if (["other_provider", "same_institution_other_department"].includes(ownership)) {
    return "external";
  }
  return "";
}

function legacyDateRelationFromClinicalEvent({
  temporalRelation = "",
  providerOwnership = ""
} = {}) {
  const temporal = String(temporalRelation || "").trim();
  if (["current_visit", "current"].includes(temporal)) {
    return "current";
  }
  if (["future", "planned", "considered"].includes(temporal)) {
    return "future";
  }
  if (temporal === "past") {
    return "past";
  }
  const ownership = String(providerOwnership || "").trim();
  if (["other_provider", "same_institution_other_department"].includes(ownership)) {
    return "past";
  }
  return "unknown";
}

function isPastOrExternalClinicalServiceContext(sentence = "") {
  const text = normalizeClinicalText(sentence);
  return /(前回|先月|以前|過去|過去値|既知値|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|外部|前に|過去に)/u.test(text);
}

function isFutureOrOrderOnlyContext(sentence = "") {
  return /(\d+\s*(?:日|週間|週|か月|カ月|ヶ月|ケ月|月)後|予定|次回|後日|紹介|持参|検討|依頼|オーダー|予約|後で|今後)/u.test(sentence);
}

function isNegatedClinicalServiceContext(sentence = "") {
  return /(未実施|未施行|行わず|行っていない|行っていません|施行せず|施行していない|実施していない|撮影せず|撮影していない|検査せず|検査していない|撮影なし|検査なし|中止)/u.test(sentence);
}

function splitClinicalSentences(text) {
  return normalizeClinicalText(text)
    .split(/[\n。]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeClinicalText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function candidateIdPart(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "item";
}
