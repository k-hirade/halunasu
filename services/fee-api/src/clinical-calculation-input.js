import {
  FEE_CLINICAL_FACTS_PROMPT_VERSION,
  extractFeeClinicalFactsWithOpenAi
} from "../../../packages/medical-core/src/fee/openai-fee-clinical-facts.js";
import {
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  isClinicalDateRatioFalsePositiveContext
} from "../../../packages/fee-contracts/src/index.js";

export const AUTO_PLACEHOLDER_ORDER_NAMES = new Set([
  "処置・手技",
  "薬剤処方",
  "特定器材・材料",
  "画像診断",
  "医学管理等",
  "検体検査",
  "注射",
  "カルテ記載内容から算定候補を確認"
]);

const CLINICAL_AUTO_OPTION_KEYS = new Set([
  "procedure_codes",
  "outpatient_basic",
  "inpatient_basic",
  "facility_standard_keys",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs",
  "comment_inputs",
  "lab_options"
]);

const ACUTE_GENERAL_INPATIENT_BASIC_CODES = Object.freeze({
  "1": "190117710",
  "2": "190199710",
  "3": "190199810",
  "4": "190199910",
  "5": "190200010",
  "6": "190077410"
});

const DPC_CONTEXT_PATTERN = /DPC|診断群分類|包括評価/u;
const NON_DPC_CONTEXT_PATTERN = /DPC\s*(?:対象外|対象ではない|対象でない|非対象)|DPC.{0,16}(?:ではない|でない|対象外|分け|別)|出来高.{0,20}(?:入院料|扱う|算定|確認)|包括評価.{0,16}(?:ではない|でない|対象外)|診断群分類.{0,16}(?:ではない|でない|対象外)/u;
const STRONG_INPATIENT_CONTEXT_PATTERN = /入院\s*\d{1,2}\s*日目|入院中|入院管理|病棟で|病棟管理|急性期一般入院料\s*[1-6]|入院基本料|DPC対象病院|DPC.*(?:管理|入院|対象)|(?:入院|病棟).*(?:継続|管理|観察)/u;
const NON_CURRENT_INPATIENT_CONTEXT_PATTERN = /入院適応(?:は)?低い|入院適応なし|入院不要|入院なし|入院は不要|退院後|退院希望|入院歴|過去.{0,12}入院|前回入院|入院前/u;
const THIRD_PARTY_INPATIENT_CONTEXT_PATTERN = /(?:母|父|妻|夫|家族|祖母|祖父|子|兄|弟|姉|妹).{0,16}入院中|入院中.{0,16}(?:母|父|妻|夫|家族|祖母|祖父|子|兄|弟|姉|妹)/u;
const OTHER_PROVIDER_DPC_CONTEXT_PATTERN = /DPC.{0,16}(?:病院|医療機関|他院|前医).{0,16}(?:転院|紹介|受診|から)|(?:転院|紹介).{0,16}DPC/u;
// Synthetic E2E prompt/meta sentences are not clinical evidence for billing.
// Keep this intentionally narrow so ordinary clinical phrases are not dropped.
const SYNTHETIC_CLINICAL_META_SENTENCE_PATTERN = /(当日確認した主な診療内容|確認すべき論点|点数に直結する名称|会計前に当日実施した内容|診療内容は最終確認|expectedClaimContext)/u;

export const FEE_CLINICAL_RULE_SET_VERSION = "fee-clinical-rules-v8";

const REVIEW_TOPIC_TAXONOMY = Object.freeze({
  contrast_check: Object.freeze({
    label: "造影確認",
    issueCode: "contrast_unknown"
  }),
  target_disease_check: Object.freeze({
    label: "対象疾患確認",
    issueCode: "management_fee_review_required"
  }),
  same_month_check: Object.freeze({
    label: "同月履歴確認",
    issueCode: "same_month_unknown"
  }),
  admission_days_check: Object.freeze({
    label: "入院日数確認",
    issueCode: "missing_inpatient_days"
  }),
  ward_type_check: Object.freeze({
    label: "病棟区分確認",
    issueCode: "missing_ward_type"
  }),
  facility_standard_check: Object.freeze({
    label: "施設基準確認",
    issueCode: "facility_unknown"
  }),
  electronic_image_management_check: Object.freeze({
    label: "電子保存確認",
    issueCode: "electronic_image_management_unknown"
  }),
  notification_check: Object.freeze({
    label: "届出確認",
    issueCode: "facility_notification_unknown"
  }),
  judgement_fee_check: Object.freeze({
    label: "判断料確認",
    issueCode: "judgement_fee_review_required"
  }),
  blood_collection_check: Object.freeze({
    label: "採血料確認",
    issueCode: "blood_collection_review_required"
  }),
  lab_code_check: Object.freeze({
    label: "検査コード確認",
    issueCode: "ambiguous_master"
  }),
  ambiguous_master_check: Object.freeze({
    label: "マスター候補確認",
    issueCode: "ambiguous_master"
  }),
  clinical_event_conflict_check: Object.freeze({
    label: "抽出結果確認",
    issueCode: "clinical_event_conflict"
  }),
  pathology_unsupported: Object.freeze({
    label: "病理未対応",
    issueCode: "pathology_unsupported"
  }),
  specimen_submission_check: Object.freeze({
    label: "検体提出確認",
    issueCode: "specimen_submission_check"
  }),
  emergency_addon_check: Object.freeze({
    label: "救急加算確認",
    issueCode: "emergency_addon_review_required"
  }),
  reception_time_check: Object.freeze({
    label: "受付時刻確認",
    issueCode: "missing_reception_time"
  }),
  missing_medication_days: Object.freeze({
    label: "薬剤日数不足",
    issueCode: "missing_quantity"
  }),
  missing_total_quantity: Object.freeze({
    label: "総量不足",
    issueCode: "missing_quantity"
  }),
  medication_amount_check: Object.freeze({
    label: "薬剤量確認",
    issueCode: "missing_medication_amount"
  }),
  anesthesia_interview_time_check: Object.freeze({
    label: "面接時間確認",
    issueCode: "anesthesia_interview_time_unknown"
  }),
  split_multi_day_check: Object.freeze({
    label: "複数日記録分割",
    issueCode: "split_multi_day_review_required"
  }),
  rehab_unsupported: Object.freeze({
    label: "リハビリ未対応",
    issueCode: "rehabilitation_unsupported"
  }),
  rehab_unit_check: Object.freeze({
    label: "実施単位確認",
    issueCode: "rehabilitation_unit_unknown"
  }),
  home_care_unsupported: Object.freeze({
    label: "在宅医療未対応",
    issueCode: "home_care_unsupported"
  }),
  home_visit_check: Object.freeze({
    label: "訪問診療確認",
    issueCode: "home_visit_unknown"
  }),
  psychiatry_special_unsupported: Object.freeze({
    label: "精神科専門療法未対応",
    issueCode: "psychiatry_special_unsupported"
  }),
  surgery_unsupported: Object.freeze({
    label: "手術未対応",
    issueCode: "surgery_unsupported"
  }),
  anesthesia_unsupported: Object.freeze({
    label: "麻酔未対応",
    issueCode: "anesthesia_unsupported"
  }),
  dialysis_unsupported: Object.freeze({
    label: "透析未対応",
    issueCode: "dialysis_unsupported"
  }),
  transfusion_unsupported: Object.freeze({
    label: "輸血未対応",
    issueCode: "transfusion_unsupported"
  }),
  endoscopy_unsupported: Object.freeze({
    label: "内視鏡未対応",
    issueCode: "endoscopy_unsupported"
  }),
  radiation_therapy_unsupported: Object.freeze({
    label: "放射線治療未対応",
    issueCode: "radiation_therapy_unsupported"
  }),
  biopsy_check: Object.freeze({
    label: "生検有無確認",
    issueCode: "biopsy_status_unknown"
  }),
  irradiation_condition_check: Object.freeze({
    label: "照射条件確認",
    issueCode: "irradiation_condition_unknown"
  }),
  procedure_detail_check: Object.freeze({
    label: "手技内容確認",
    issueCode: "procedure_detail_unknown"
  })
});

const DIRECT_RETRIEVAL_FEE_CATEGORIES_BY_EVENT_TYPE = Object.freeze({
  lab: new Set(["lab_test_basic"]),
  imaging: new Set(["imaging_basic", "physiological_exam_basic", "procedure_basic"]),
  exam: new Set(["lab_test_basic", "imaging_basic", "physiological_exam_basic", "procedure_basic"]),
  procedure: new Set(["procedure_basic", "treatment_basic", "physiological_exam_basic"]),
  treatment: new Set(["procedure_basic", "treatment_basic"]),
  management: new Set(),
  counseling: new Set()
});

const DERIVED_BILLING_ITEM_POLICIES = Object.freeze({
  lab_judgment: Object.freeze({
    generationSource: "derived_from_parent",
    riskGate: "auto",
    requiredAttributes: ["lab_classification"]
  }),
  blood_collection: Object.freeze({
    generationSource: "derived_from_parent",
    riskGate: "auto",
    requiredAttributes: ["blood_specimen_or_blood_draw"]
  }),
  specimen_collection: Object.freeze({
    generationSource: "derived_from_parent",
    riskGate: "review",
    requiredAttributes: ["specimen", "collection_method"]
  }),
  lab_management_addon: Object.freeze({
    generationSource: "derived_from_parent",
    riskGate: "auto",
    requiredAttributes: ["lab_judgment", "facility_standard"]
  }),
  management_fee: Object.freeze({
    generationSource: "conditional_independent",
    riskGate: "review_only",
    requiredAttributes: ["target_diagnosis", "management_record", "same_month_history"]
  })
});

function reviewTopicDefinition(topicCode = "") {
  return REVIEW_TOPIC_TAXONOMY[String(topicCode || "")] || null;
}

function withReviewTopic(issue = {}, topicCode = "") {
  const topic = reviewTopicDefinition(topicCode);
  if (!topic) {
    return issue;
  }
  return {
    ...issue,
    issueCode: issue.issueCode || topic.issueCode,
    topicCode,
    topicLabel: topic.label,
    title: issue.title || topic.label
  };
}

function reviewTopicCodeFromWarning(message = "", event = {}) {
  const text = String(message || "");
  if (/造影/u.test(text) && /(確認|未確定|不明|有無|必要)/u.test(text)) {
    return "contrast_check";
  }
  if (/対象疾患/u.test(text)) {
    return "target_disease_check";
  }
  if (/同月履歴|同月算定|同月/u.test(text)) {
    return "same_month_check";
  }
  if (/入院日数|算定日数/u.test(text)) {
    return "admission_days_check";
  }
  if (/病棟|入院料の種別/u.test(text)) {
    return "ward_type_check";
  }
  if (/届出|届け出|地方厚生局/u.test(text)) {
    return "notification_check";
  }
  if (/施設基準/u.test(text)) {
    return "facility_standard_check";
  }
  if (/電子(?:画像管理|保存|的.*保存)|電子.*管理/u.test(text) && /(確認|未確定|不明|有無|必要)/u.test(text)) {
    return "electronic_image_management_check";
  }
  if (/D026|検査判断料|判断料/u.test(text)) {
    return "judgement_fee_check";
  }
  if (/採血料|静脈採血料|Ｂ-?Ｖ|B-?V|blood_venous|Collection fee/u.test(text)) {
    return "blood_collection_check";
  }
  if (/検査コード|検査名|標準コード|検査項目/u.test(text) && /(確認|不明|未確定|不足)/u.test(text)) {
    return "lab_code_check";
  }
  if (/実施単位|単位数/u.test(text) && /リハビリ/u.test(text)) {
    return "rehab_unit_check";
  }
  if (/リハビリ未対応|リハビリテーション/u.test(text)) {
    return "rehab_unsupported";
  }
  if (/訪問診療/u.test(text)) {
    return "home_visit_check";
  }
  if (/在宅医療未対応|在宅医療|在宅/u.test(text)) {
    return "home_care_unsupported";
  }
  if (/精神科専門療法未対応|精神科専門療法/u.test(text)) {
    return "psychiatry_special_unsupported";
  }
  if (/手術未対応/u.test(text)) {
    return "surgery_unsupported";
  }
  if (/麻酔未対応/u.test(text)) {
    return "anesthesia_unsupported";
  }
  if (/透析未対応/u.test(text)) {
    return "dialysis_unsupported";
  }
  if (/輸血未対応/u.test(text)) {
    return "transfusion_unsupported";
  }
  if (/生検/u.test(text) && /(有無|確認|不明|必要)/u.test(text)) {
    return "biopsy_check";
  }
  if (/照射/u.test(text) && /(条件|部位|線量|回数|確認|不明|必要)/u.test(text)) {
    return "irradiation_condition_check";
  }
  if (/手技内容|手技/u.test(text) && /(確認|不明|必要)/u.test(text)) {
    return "procedure_detail_check";
  }
  if (/内視鏡未対応|内視鏡/u.test(text)) {
    return "endoscopy_unsupported";
  }
  if (/放射線治療未対応|放射線治療/u.test(text)) {
    return "radiation_therapy_unsupported";
  }
  if (/病理未対応|病理診断|細胞診/u.test(text)) {
    return "pathology_unsupported";
  }
  if (/検体提出|標本/u.test(text)) {
    return "specimen_submission_check";
  }
  if (/救急加算|時間外加算|休日加算|深夜加算/u.test(text)) {
    return "emergency_addon_check";
  }
  if (/受付時刻/u.test(text)) {
    return "reception_time_check";
  }
  if (/薬剤日数不足|処方日数|服用日数|使用日数/u.test(text)) {
    return "missing_medication_days";
  }
  if (/薬剤量|投与量|用量/u.test(text) && /(確認|不足|不明|未記載|明記|必要)/u.test(text)) {
    return "medication_amount_check";
  }
  if (/面接時間|術前(?:診察|面接|評価)|麻酔.*(?:面接|診察|評価)/u.test(text)) {
    return "anesthesia_interview_time_check";
  }
  if (/総量不足|総量|全量|本数|枚数/u.test(text) && /不足|不明|未記載|明記/u.test(text)) {
    return "missing_total_quantity";
  }
  if (/薬剤/u.test(text) && /数量|日数|総量|回数/u.test(text)) {
    return "missing_medication_days";
  }
  if (/マスター|標準コード|候補/u.test(text) && /確定でき|複数|確認/u.test(text)) {
    return "ambiguous_master_check";
  }
  if (/複数日|複数の日付|日別|分割/u.test(text) && /(記録|診療|確認|分割)/u.test(text)) {
    return "split_multi_day_check";
  }
  const type = normalizeClinicalEventType(event);
  if (type === "management" || type === "counseling") {
    return "target_disease_check";
  }
  return "";
}

const CT_EQUIPMENT_KIND_PATTERNS = Object.freeze([
  { kind: "multislice_128_or_more", pattern: /(?:128\s*列\s*以上|128列以上|百二十八列以上)/u },
  { kind: "multislice_64_to_128", pattern: /(?:64\s*列\s*以上\s*128\s*列\s*未満|64列以上128列未満|六十四列以上百二十八列未満)/u },
  { kind: "multislice_16_to_64", pattern: /(?:16\s*列\s*以上\s*64\s*列\s*未満|16列以上64列未満|十六列以上六十四列未満)/u },
  { kind: "multislice_4_to_16", pattern: /(?:4\s*列\s*以上\s*16\s*列\s*未満|4列以上16列未満|四列以上十六列未満)/u }
]);

const MRI_EQUIPMENT_KIND_PATTERNS = Object.freeze([
  { kind: "three_tesla", pattern: /(?:3\s*T|３\s*T|3テスラ|３テスラ|三テスラ)/iu },
  { kind: "one_point_five_tesla", pattern: /(?:1\.5\s*T|１\.５\s*T|1\.5テスラ|１\.５テスラ|一・五テスラ)/iu }
]);

export async function buildClinicalCalculationPreparation({
  session = {},
  calculationInput = {},
  feeCalculator,
  openAiApiKey = "",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  priorSessions = [],
  clinicalFactsExtractor = null
} = {}) {
  const manualOptions = manualCalculationOptions(session, calculationInput);
  if (isPlainObject(session.claimContext) || isPlainObject(calculationInput.claimContext)) {
    return {
      calculationOptions: Object.keys(manualOptions).length ? manualOptions : null,
      calculationOptionsAutoKeys: [],
      calculationOptionsSource: Object.keys(manualOptions).length ? "manual" : null,
      diagnoses: [],
      candidateProposals: [],
      reviewWarnings: [],
      clinicalEvents: [],
      masterCandidates: [],
      billingCandidates: [],
      reviewIssues: [],
      clinicalExtraction: clinicalExtractionMetadata({
        session,
        calculationInput,
        source: "manual",
        openAiModel,
        openAiReasoningEffort,
        feeCalculator
      }),
      metrics: {
        clinicalStructuring: {
          source: "manual",
          durationMs: 0,
          model: openAiModel,
          reasoningEffort: openAiReasoningEffort,
          promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
          ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
          masterVersion: feeMasterVersion(feeCalculator)
        }
      }
    };
  }

  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inferred = {};
  const inferredDiagnoses = [];
  const candidateProposals = [];
  const reviewWarnings = [];
  const clinicalEvents = [];
  const masterCandidates = [];
  const billingCandidates = [];
  const reviewIssues = [];
  const clinicalTrace = [];
  const metrics = {
    clinicalStructuring: {
      source: text ? "not_run" : "no_clinical_text",
      durationMs: 0,
      model: openAiModel,
      reasoningEffort: openAiReasoningEffort,
      promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
      ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
      masterVersion: feeMasterVersion(feeCalculator),
      timeoutMs: Number(openAiTimeoutMs || 0)
    },
    ruleBasedClinicalInference: {
      durationMs: 0,
      masterLookupCount: 0,
      masterLookupDurationMs: 0
    }
  };

  if (text) {
    const structured = await inferStructuredClinicalCalculationOptions({
      text,
      session,
      feeCalculator,
      openAiApiKey,
      openAiModel,
      openAiReasoningEffort,
      openAiTimeoutMs,
      clinicalFactsExtractor
    });
    metrics.clinicalStructuring = structured.metrics;
    const ruleMetrics = createMasterSearchMetrics(feeCalculator);
    const ruleStartedAt = Date.now();
    const ruleBased = structured.used
      ? await inferDeterministicSupplementalClinicalCalculationOptions({
        text,
        session,
        feeCalculator: ruleMetrics.calculator
      })
      : await inferRuleBasedClinicalCalculationOptions({
        text,
        session,
        feeCalculator: ruleMetrics.calculator
      });
    metrics.ruleBasedClinicalInference = {
      durationMs: Date.now() - ruleStartedAt,
      source: structured.used ? "objective_supplement" : "fallback_rules",
      ...ruleMetrics.snapshot()
    };

    if (structured.used) {
      Object.assign(inferred, normalizeClinicalInferredOptions(
        mergeCalculationOptions(structured.inferred, ruleBased.inferred)
      ));
      inferredDiagnoses.push(...asArray(structured.diagnoses));
      candidateProposals.push(...asArray(structured.candidateProposals), ...asArray(ruleBased.candidateProposals));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
      clinicalEvents.push(...asArray(structured.clinicalEvents));
      masterCandidates.push(...asArray(structured.masterCandidates));
      billingCandidates.push(...asArray(structured.billingCandidates));
      reviewIssues.push(...asArray(structured.reviewIssues));
      clinicalTrace.push(...asArray(structured.clinicalTrace));
    } else {
      Object.assign(inferred, ruleBased.inferred);
      candidateProposals.push(...asArray(ruleBased.candidateProposals));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
    }
  }

  const normalizedInferred = normalizeClinicalInferredOptions(inferred);
  if (isInpatientEncounter(session, text) && !hasOwn(manualOptions, "outpatient_basic")) {
    delete normalizedInferred.outpatient_basic;
  }
  if (!isInpatientEncounter(session, text) && !hasUnresolvedInpatientEncounterText(session, text)) {
    const historyBasic = inferOutpatientBasicFromPatientHistory({
      session,
      priorSessions,
      diagnoses: [
        ...asArray(session.diagnoses),
        ...inferredDiagnoses
      ],
      currentOutpatientBasic: normalizedInferred.outpatient_basic || null
    });
    if (
      !hasOwn(manualOptions, "outpatient_basic")
      && historyBasic.outpatientBasic
    ) {
      normalizedInferred.outpatient_basic = historyBasic.outpatientBasic;
    }
    reviewWarnings.push(...historyBasic.reviewWarnings);
    reviewWarnings.push(...inferPediatricAddOnReviewWarnings({
      session,
      text,
      outpatientBasic: normalizedInferred.outpatient_basic || historyBasic.outpatientBasic || null
    }));
  }

  const autoKeys = Object.keys(normalizedInferred).filter((key) => (
    CLINICAL_AUTO_OPTION_KEYS.has(key) && !hasOwn(manualOptions, key)
  ));
  const merged = normalizeClinicalInferredOptions(mergeCalculationOptions(manualOptions, normalizedInferred));
  return {
    calculationOptions: Object.keys(merged).length ? merged : null,
    calculationOptionsAutoKeys: autoKeys,
    calculationOptionsSource: calculationOptionsSource(manualOptions, autoKeys),
    diagnoses: normalizeClinicalDiagnoses(inferredDiagnoses),
    candidateProposals: normalizeCandidateProposals(candidateProposals),
    reviewWarnings: normalizeReviewWarnings(reviewWarnings),
    clinicalEvents: normalizeClinicalEventsForResult(clinicalEvents),
    masterCandidates: normalizeMasterCandidates(masterCandidates),
    billingCandidates: normalizeBillingCandidates(billingCandidates),
    reviewIssues: normalizeReviewIssues(reviewIssues),
    clinicalExtraction: clinicalExtractionMetadata({
      session,
      calculationInput,
      source: metrics.clinicalStructuring?.source || "unknown",
      openAiModel,
      openAiReasoningEffort,
      openAiTimeoutMs,
      feeCalculator,
      clinicalEventCount: clinicalEvents.length,
      masterCandidateCount: masterCandidates.length,
      billingCandidateCount: billingCandidates.length,
      reviewIssueCount: reviewIssues.length,
      clinicalTrace,
      responseId: metrics.clinicalStructuring?.responseId || null,
      usage: metrics.clinicalStructuring?.usage || null
    }),
    metrics
  };
}

export function isAutoPlaceholderOrderName(value) {
  return AUTO_PLACEHOLDER_ORDER_NAMES.has(String(value || "").trim());
}

export function normalizeClinicalText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .trim();
}

async function inferStructuredClinicalCalculationOptions({
  text,
  session = {},
  feeCalculator,
  openAiApiKey = "",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  clinicalFactsExtractor = null
} = {}) {
  const extractor = typeof clinicalFactsExtractor === "function" ? clinicalFactsExtractor : null;
  if (!extractor && !String(openAiApiKey || "").trim()) {
    return {
      used: false,
      inferred: {},
      candidateProposals: [],
      reviewWarnings: [],
      metrics: {
        source: "rules_no_openai",
        durationMs: 0,
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        openAiProviderDurationMs: 0,
        clinicalFactsConvertDurationMs: 0,
        convertedDiagnosisCount: 0,
        convertedOptionKeys: [],
        convertedReviewWarningCount: 0,
        masterLookupCount: 0,
        masterLookupDurationMs: 0,
        timeoutMs: Number(openAiTimeoutMs || 0)
      }
    };
  }

  const startedAt = Date.now();
  const conversionSearch = createMasterSearchMetrics(feeCalculator);
  const checklistMenu = buildClinicalChecklistMenu(text);
  let openAiProviderDurationMs = 0;
  let firstOutputTextMs = null;
  let firstSnapshotSeen = false;
  try {
    const providerStartedAt = Date.now();
    const factsResult = extractor
      ? await extractor({
        clinicalText: text,
        session,
        sessionContext: buildFeeSessionContext(session),
        checklistMenu,
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        timeoutMs: openAiTimeoutMs
      })
      : await extractFeeClinicalFactsWithOpenAi({
        apiKey: openAiApiKey,
        clinicalText: text,
        sessionContext: buildFeeSessionContext(session),
        checklistMenu,
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        timeoutMs: openAiTimeoutMs,
        stream: true,
        onOutputTextSnapshot: () => {
          if (!firstSnapshotSeen) {
            firstSnapshotSeen = true;
            firstOutputTextMs = Date.now() - providerStartedAt;
          }
        }
      });
    openAiProviderDurationMs = Date.now() - providerStartedAt;
    const facts = factsResult?.parsed || factsResult || {};
    const conversionStartedAt = Date.now();
    const converted = await clinicalFactsToCalculationOptions(facts, {
      text,
      session,
      feeCalculator: conversionSearch.calculator,
      checklistMenu
    });
    const convertedOptionKeys = Object.keys(converted.inferred || {});
    return {
      used: true,
      ...converted,
      metrics: {
        source: "openai",
        durationMs: Date.now() - startedAt,
        openAiProviderDurationMs,
        firstOutputTextMs,
        clinicalFactsConvertDurationMs: Date.now() - conversionStartedAt,
        extractedDiagnosisCount: Array.isArray(facts?.diagnoses) ? facts.diagnoses.length : 0,
        extractedClinicalEventCount: clinicalEventsFromClinicalFacts(facts).length,
        extractedChecklistFindingCount: Array.isArray(facts?.checklist_findings) ? facts.checklist_findings.length : 0,
        checklistMenuCount: checklistMenu.length,
        extractedBillingEventCount: Array.isArray(facts?.billing_events) ? facts.billing_events.length : 0,
        extractedExcludedEventCount: Array.isArray(facts?.excluded_events) ? facts.excluded_events.length : 0,
        convertedDiagnosisCount: Array.isArray(converted.diagnoses) ? converted.diagnoses.length : 0,
        convertedOptionKeys,
        convertedReviewWarningCount: Array.isArray(converted.reviewWarnings) ? converted.reviewWarnings.length : 0,
        convertedMasterCandidateCount: Array.isArray(converted.masterCandidates) ? converted.masterCandidates.length : 0,
        convertedBillingCandidateCount: Array.isArray(converted.billingCandidates) ? converted.billingCandidates.length : 0,
        convertedReviewIssueCount: Array.isArray(converted.reviewIssues) ? converted.reviewIssues.length : 0,
        convertedClinicalTraceCount: Array.isArray(converted.clinicalTrace) ? converted.clinicalTrace.length : 0,
        ...conversionSearch.snapshot(),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: factsResult?.promptVersion || FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        timeoutMs: Number(openAiTimeoutMs || 0),
        responseId: factsResult?.responseId || null,
        usage: factsResult?.usage || null
      }
    };
  } catch (error) {
    return {
      used: false,
      inferred: {},
      diagnoses: [],
      candidateProposals: [],
      reviewWarnings: [
        "AI構造化に失敗したため、従来のルールベース抽出で算定候補を作成しました。"
      ],
      metrics: {
        source: "rules_fallback",
        durationMs: Date.now() - startedAt,
        openAiProviderDurationMs: openAiProviderDurationMs || Date.now() - startedAt,
        firstOutputTextMs,
        clinicalFactsConvertDurationMs: 0,
        convertedDiagnosisCount: 0,
        convertedOptionKeys: [],
        convertedReviewWarningCount: 0,
        ...conversionSearch.snapshot(),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        timeoutMs: Number(openAiTimeoutMs || 0),
        fallbackReason: safeClinicalStructuringError(error)
      }
    };
  }
}

function safeClinicalStructuringError(error) {
  return [
    error?.name || "Error",
    error?.safeProviderMessage || error?.providerErrorCode || error?.code || error?.message || ""
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(": ")
    .slice(0, 240);
}

function createMasterSearchMetrics(feeCalculator) {
  const metrics = {
    masterLookupCount: 0,
    masterLookupDurationMs: 0
  };
  if (typeof feeCalculator?.searchMaster !== "function") {
    return {
      calculator: feeCalculator,
      snapshot: () => ({ ...metrics })
    };
  }

  return {
    calculator: {
      ...feeCalculator,
      async searchMaster(input) {
        const startedAt = Date.now();
        metrics.masterLookupCount += 1;
        try {
          return await feeCalculator.searchMaster(input);
        } finally {
          metrics.masterLookupDurationMs += Date.now() - startedAt;
        }
      }
    },
    snapshot: () => ({ ...metrics })
  };
}

function feeMasterVersion(feeCalculator) {
  return String(
    feeCalculator?.masterVersion
    || feeCalculator?.version
    || process.env.FEE_MASTER_VERSION
    || process.env.FEE_MASTER_DB_VERSION
    || "runtime-master-current"
  );
}

function clinicalExtractionMetadata({
  session = {},
  calculationInput = {},
  source = "unknown",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  feeCalculator,
  clinicalEventCount = 0,
  masterCandidateCount = 0,
  billingCandidateCount = 0,
  reviewIssueCount = 0,
  clinicalTrace = [],
  responseId = null,
  usage = null
} = {}) {
  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inputHash = clinicalInputHash([
    session.orgId,
    session.feeSessionId,
    session.patientId,
    session.serviceDate,
    text
  ].join("\n"));
  return {
    runId: `clinical_${inputHash}`,
    source,
    inputHash,
    model: openAiModel,
    reasoningEffort: openAiReasoningEffort,
    timeoutMs: Number(openAiTimeoutMs || 0),
    promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
    ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
    masterVersion: feeMasterVersion(feeCalculator),
    responseId,
    usage: usage || null,
    clinicalEventCount: Number(clinicalEventCount || 0),
    masterCandidateCount: Number(masterCandidateCount || 0),
    billingCandidateCount: Number(billingCandidateCount || 0),
    reviewIssueCount: Number(reviewIssueCount || 0),
    trace: normalizeClinicalTrace(clinicalTrace)
  };
}

function clinicalInputHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function inferRuleBasedClinicalCalculationOptions({ text = "", session = {}, feeCalculator } = {}) {
  const inferred = {};
  const reviewWarnings = [];

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  } else if (!hasUnresolvedInpatientEncounterText(session, text)) {
    const outpatientBasic = inferOutpatientBasicOptions(text);
    if (outpatientBasic) {
      inferred.outpatient_basic = outpatientBasic;
    }
  }

  const imaging = inferImagingOrders(text);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  const drugInference = await inferMedicationOrders(text, feeCalculator);
  if (drugInference.orders.length) {
    inferred.medication_orders = drugInference.orders;
    inferred.medication = {
      delivery_kind: inferMedicationDeliveryKind(text),
      prescription_category: "other"
    };
  }
  reviewWarnings.push(...drugInference.reviewWarnings);

  const materialInference = await inferMaterialInputs(text, feeCalculator);
  if (materialInference.inputs.length) {
    inferred.material_inputs = materialInference.inputs;
  }
  reviewWarnings.push(...materialInference.reviewWarnings);

  return {
    inferred,
    reviewWarnings
  };
}

async function inferDeterministicSupplementalClinicalCalculationOptions({ text = "", session = {}, feeCalculator } = {}) {
  const objectiveText = objectiveClinicalText(text);
  if (!objectiveText) {
    return {
      inferred: {},
      reviewWarnings: []
    };
  }

  const inferred = {};
  const reviewWarnings = [];

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  }

  const imaging = inferImagingOrders(objectiveText);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  return {
    inferred,
    reviewWarnings
  };
}

async function clinicalFactsToCalculationOptions(facts = {}, { text = "", session = {}, feeCalculator, checklistMenu = [] } = {}) {
  const inferred = {};
  const diagnoses = diagnosesFromClinicalFacts(facts);
  const reviewWarnings = [];
  const procedureCodes = [];
  const imagingOrders = [];
  const medicationOrders = [];
  const materialInputs = [];
  const commentInputs = [];
  const collectionFeeInputs = [];
  const candidateProposals = [];
  const masterCandidates = [];
  const billingCandidates = [];
  const reviewIssues = [];
  const clinicalTrace = [];
  let clinicalEvents = clinicalEventsFromClinicalFacts(facts);
  const checklistContradictions = clinicalEventContradictionsFromChecklistFindings({
    facts,
    checklistMenu,
    clinicalText: text,
    existingEvents: clinicalEvents
  });
  if (checklistContradictions.blockedEventIds.size) {
    clinicalEvents = clinicalEvents.filter((event) => !checklistContradictions.blockedEventIds.has(clinicalEventIdentity(event)));
  }
  if (checklistContradictions.reviewIssues.length) {
    reviewIssues.push(...checklistContradictions.reviewIssues);
    reviewWarnings.push(...checklistContradictions.reviewIssues.map((issue) => issue.messageForStaff));
  }
  clinicalTrace.push(...checklistContradictions.traceEvents);
  const checklistRecovery = clinicalEventsFromChecklistFindings({
    facts,
    checklistMenu,
    clinicalText: text,
    existingEvents: clinicalEvents
  });
  if (checklistRecovery.events.length) {
    clinicalEvents = [...clinicalEvents, ...checklistRecovery.events];
  }
  const suppressedClinicalFactWarnings = [];
  let hasCaseLevelLabProcedureCode = false;
  let hasCaseLevelBloodCollectionEvidence = hasCaseLevelBloodCollectionEvidenceFromText(text);
  clinicalTrace.push(...checklistRecovery.traceEvents);

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  } else {
    const hasUnresolvedInpatientText = !hasExplicitEncounterSetting(session) && hasInpatientCareContext(text);
    if (hasUnresolvedInpatientText) {
      reviewWarnings.push(
        "病棟区分確認: 入院診療の可能性がある記載があります。外来/入院の診療区分を確認してください。本文だけでは入院基本料を自動候補化しません。",
        "入院日数確認: 入院基本料を算定する場合は、入院日と算定日数を確認してください。"
      );
    } else {
      const outpatientBasic = outpatientBasicFromStructuredVisit(facts?.visit_type, text);
      if (outpatientBasic) {
        inferred.outpatient_basic = outpatientBasic;
      }
    }
  }

  for (const event of excludedClinicalEventsFromClinicalFacts(facts)) {
    const issue = reviewIssueFromExcludedClinicalEvent(event);
    if (issue) {
      reviewIssues.push(issue);
      reviewWarnings.push(issue.messageForStaff);
    }
  }
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.missing_information));
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.review_flags, {
    onSuppressed: (warning, reason) => {
      suppressedClinicalFactWarnings.push({ warning, reason, source: "review_flags" });
    }
  }));
  const splitMultiDayIssue = reviewIssueFromSplitMultiDayText(text);
  if (splitMultiDayIssue) {
    reviewIssues.push(splitMultiDayIssue);
    reviewWarnings.push(splitMultiDayIssue.messageForStaff);
  }

  for (const event of clinicalEvents) {
    const type = normalizeClinicalEventType(event);
    if (!isBillableClinicalEvent(event)) {
      const reviewOnlyDomain = reviewOnlyClinicalEventDomain(event);
      if (reviewOnlyDomain && !isNegatedClinicalEvent(event)) {
        const domainIssues = reviewIssuesFromReviewOnlyDomainClinicalEvent(event);
        reviewIssues.push(...domainIssues);
        reviewWarnings.push(...domainIssues.map((issue) => issue.messageForStaff));
        clinicalTrace.push(clinicalTraceEvent({
          stage: "review_only_domain_gate",
          event,
          categoryLabel: reviewOnlyDomainLabel(reviewOnlyDomain),
          outcome: "review_required",
          message: "review_only_domain_non_billable_review_required"
        }));
        continue;
      }
      const issue = reviewIssueFromExcludedClinicalEvent(event);
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      continue;
    }
    if (hasExplicitBloodCollectionEvidence(event)) {
      hasCaseLevelBloodCollectionEvidence = true;
    }
    const reviewOnlyDomain = reviewOnlyClinicalEventDomain(event);
    const domainIssues = reviewIssuesFromReviewOnlyDomainClinicalEvent(event);
    if (domainIssues.length) {
      reviewIssues.push(...domainIssues);
      reviewWarnings.push(...domainIssues.map((issue) => issue.messageForStaff));
      clinicalTrace.push(clinicalTraceEvent({
        stage: "review_only_domain_gate",
        event,
        categoryLabel: reviewOnlyDomainLabel(reviewOnlyDomain),
        outcome: "review_required",
        message: "review_only_domain_direct_retrieval_disabled"
      }));
      continue;
    }

    if (type === "imaging") {
      const imaging = await imagingOrderFromClinicalEvent(event, feeCalculator, { clinicalText: text });
      if (imaging.order) imagingOrders.push(imaging.order);
      procedureCodes.push(...imaging.procedureCodes);
      commentInputs.push(...imaging.commentInputs);
      collectionFeeInputs.push(...imaging.collectionFeeInputs);
      masterCandidates.push(...asArray(imaging.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, imaging));
      reviewIssues.push(...reviewIssuesFromClinicalWarnings(event, imaging.reviewWarnings, {
        source: "clinical_imaging_rule"
      }));
      reviewWarnings.push(...imaging.reviewWarnings);
      clinicalTrace.push(...asArray(imaging.traceEvents));
      continue;
    }

    if (type === "lab") {
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel: "検体検査",
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event),
        clinicalText: text
      });
      const collectionFeeReviewIssues = labCollectionFeeReviewIssuesFromClinicalEvent(event, procedure);
      procedureCodes.push(...procedure.procedureCodes);
      if (asArray(procedure.procedureCodes).length) {
        hasCaseLevelLabProcedureCode = true;
      }
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs, ...labCollectionFeeInputsFromClinicalEvent(event, procedure));
      reviewIssues.push(...collectionFeeReviewIssues);
      reviewIssues.push(...reviewIssuesFromClinicalWarnings(event, procedure.reviewWarnings, {
        source: "clinical_event_lab_guard"
      }));
      masterCandidates.push(...asArray(procedure.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, procedure));
      reviewWarnings.push(...procedure.reviewWarnings);
      reviewWarnings.push(...collectionFeeReviewIssues.map((issue) => issue.messageForStaff));
      clinicalTrace.push(...asArray(procedure.traceEvents), ...labRuleTraceEvents(event, procedure));
      continue;
    }

    if (type === "medication") {
      const medication = await medicationOrderFromClinicalEvent(event, feeCalculator);
      if (medication.order) {
        medicationOrders.push(medication.order);
      }
      masterCandidates.push(...asArray(medication.masterCandidates));
      billingCandidates.push(...billingCandidatesFromMedicationResult(event, medication));
      reviewWarnings.push(...medication.reviewWarnings);
      continue;
    }

    if (type === "material") {
      const material = await materialInputFromClinicalEvent(event, feeCalculator);
      if (material.input) {
        materialInputs.push(material.input);
      }
      masterCandidates.push(...asArray(material.masterCandidates));
      billingCandidates.push(...billingCandidatesFromMaterialResult(event, material));
      reviewWarnings.push(...material.reviewWarnings);
      continue;
    }

    if (["procedure", "exam", "treatment"].includes(type)) {
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel: type === "exam" ? "検査・処置" : type === "treatment" ? "処置・手技" : "診療行為",
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      masterCandidates.push(...asArray(procedure.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, procedure));
      reviewWarnings.push(...procedure.reviewWarnings);
      clinicalTrace.push(...asArray(procedure.traceEvents));
      continue;
    }

    if (["management", "counseling"].includes(type)) {
      const categoryLabel = type === "management" ? "医学管理等" : "指導料";
      const issue = reviewIssueFromManagementClinicalEvent(event, { categoryLabel });
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      clinicalTrace.push(clinicalTraceEvent({
        stage: "management_review_gate",
        event,
        categoryLabel,
        outcome: "review_required",
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event),
        message: "management_fee_direct_retrieval_disabled"
      }));
      continue;
    }

    const issue = reviewIssueFromUnsupportedClinicalEvent(event);
    if (issue) {
      reviewIssues.push(issue);
      reviewWarnings.push(issue.messageForStaff);
    }
  }

  if (imagingOrders.length) {
    inferred.imaging_orders = dedupeObjects(imagingOrders);
  }
  if (procedureCodes.length) {
    inferred.procedure_codes = uniqueStrings(procedureCodes);
  }
  if (commentInputs.length) {
    inferred.comment_inputs = dedupeObjects(commentInputs, (item) => item?.code || item?.text || JSON.stringify(item));
  }
  if (hasCaseLevelLabProcedureCode && hasCaseLevelBloodCollectionEvidence) {
    collectionFeeInputs.push("blood_venous");
    clinicalTrace.push(clinicalTraceEvent({
      stage: "case_level_lab_collection",
      categoryLabel: "検体検査",
      outcome: "prepared",
      selected: {
        input: "blood_venous",
        policy: DERIVED_BILLING_ITEM_POLICIES.blood_collection
      },
      message: "case_level_blood_collection_evidence_applied"
    }));
  }
  if (collectionFeeInputs.length) {
    inferred.lab_options = {
      collection_fee_inputs: uniqueStrings(collectionFeeInputs)
    };
  }

  for (const suppressed of suppressedClinicalFactWarnings) {
    clinicalTrace.push({
      stage: "clinical_fact_review_flag_suppressed",
      outcome: "suppressed",
      source: suppressed.source,
      message: suppressed.reason,
      warning: suppressed.warning
    });
  }
  const visitMedication = medicationOptionsFromVisitFacts(facts?.visit_facts);
  if (medicationOrders.length) {
    inferred.medication_orders = dedupeObjects(medicationOrders, (item) => item.drug_code);
    inferred.medication = {
      delivery_kind: visitMedication?.delivery_kind || inferMedicationDeliveryKind(text),
      prescription_category: "other",
      ...(visitMedication?.generic_name_prescription_add_on ? {
        generic_name_prescription_add_on: visitMedication.generic_name_prescription_add_on
      } : {})
    };
  } else if (visitMedication) {
    inferred.medication = visitMedication;
  }
  if (materialInputs.length) {
    inferred.material_inputs = dedupeObjects(materialInputs, (item) => item.code);
  }

  return {
    inferred,
    diagnoses,
    candidateProposals: normalizeCandidateProposals(candidateProposals),
    reviewWarnings: normalizeReviewWarnings(reviewWarnings),
    clinicalEvents,
    masterCandidates: normalizeMasterCandidates(masterCandidates),
    billingCandidates: normalizeBillingCandidates(billingCandidates),
    reviewIssues: normalizeReviewIssues(reviewIssues),
    clinicalTrace: normalizeClinicalTrace(clinicalTrace)
  };
}

async function clinicalEventCandidateProposal(event = {}, feeCalculator, {
  categoryLabel = "診療行為",
  sortOrder = 50
} = {}) {
  const name = clinicalEventName(event);
  const evidence = clinicalEventEvidence(event);
  const title = `${name || categoryLabel}の算定確認`;
  const reason = `${name || categoryLabel}を${categoryLabel}に関係する医療イベントとして抽出しました。`;
  const conditionText = `${categoryLabel}として算定できる項目があれば、対象疾患・施設基準・同月算定条件を確認してください。`;
  const queries = clinicalEventSearchQueries(event, { categoryLabel });
  const item = await searchProcedureCandidateItem(feeCalculator, queries, [
    ...(name ? [new RegExp(escapeRegExp(name), "u")] : []),
    new RegExp(escapeRegExp(categoryLabel), "u")
  ], {
    allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
  });
  if (item?.code) {
    return candidateProposalFromProcedureItem({
      proposalId: `clinical_event_${candidateIdPart(name || categoryLabel)}_${item.code}`,
      title,
      reason,
      conditionText,
      evidence,
      item,
      sortOrder,
      basis: "カルテ本文から実施済みの医療イベントとして抽出しました。条件を満たす場合だけ採用してください。"
    });
  }
  return {
    proposalId: `clinical_event_${candidateIdPart([categoryLabel, name, evidence].join("_"))}_confirm`,
    title,
    reason,
    conditionText: `${conditionText} 標準コードはマスター検索で確認してください。`,
    evidence,
    actionType: "confirm_required",
    potentialPoints: 0,
    orderType: "procedure",
    source: "clinical_event_opportunity",
    sortOrder
  };
}

async function searchProcedureCandidateItem(feeCalculator, queries = [], preferredPatterns = [], options = {}) {
  if (typeof feeCalculator?.searchMaster !== "function") {
    return null;
  }
  const allowedFeeCategories = options.allowedFeeCategories || null;
  for (const query of uniqueStrings(queries).filter((value) => value.length >= 2)) {
    try {
      const result = await feeCalculator.searchMaster({ type: "procedure", query, limit: 20 });
      const items = asArray(result?.items).filter((item) => item?.code && (
        item.kind === "procedure"
        || item.sourceType === "medical_procedure_master"
        || item.source === "medical_procedure_master"
      ))
        .map((item) => annotateMedicalServiceCandidate(item))
        .filter((item) => !directRetrievalFilterReason(item, { allowedFeeCategories }));
      const candidate = bestProcedureCandidateForQuery(items, query, preferredPatterns);
      if (candidate?.code) {
        return candidate;
      }
    } catch {
      // Master search is advisory here; failed lookups should not block calculation.
    }
  }
  return null;
}

function bestProcedureCandidateForQuery(items = [], query = "", preferredPatterns = []) {
  const scored = asArray(items)
    .map((item, index) => ({
      item,
      index,
      score: procedureCandidateScore(item, query, preferredPatterns)
    }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score >= 30)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  if (!scored.length) {
    return null;
  }
  const [best, second] = scored;
  if (second && (best.score - second.score) < 12) {
    return null;
  }
  return best.item;
}

function procedureCandidateScore(item = {}, query = "", preferredPatterns = []) {
  const nameText = [item.name, item.baseName, item.displayName, item.shortName].filter(Boolean).join(" ");
  const normalizedName = normalizeMatchText(nameText);
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedName || !normalizedQuery) {
    return 0;
  }

  let score = 0;
  if (normalizedName === normalizedQuery) score += 120;
  if (normalizedName.includes(normalizedQuery)) score += 80;
  if (normalizedQuery.includes(normalizedName) && normalizedName.length >= 4) score += 60;

  const tokens = matchTokens(normalizedQuery);
  const matchedTokens = tokens.filter((token) => normalizedName.includes(token));
  score += matchedTokens.length * 18;
  if (tokens.length && matchedTokens.length === tokens.length) {
    score += 18;
  }

  if (preferredPatterns.some((pattern) => pattern.test(nameText))) {
    score += 70;
  }
  if (Number(item.points || item.totalPoints || 0) > 0) {
    score += 4;
  }

  score -= unrelatedBodySitePenalty(normalizedQuery, normalizedName);
  return score;
}

function normalizeMatchText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[（）()［\]\[\]、，,・･]/gu, "")
    .trim();
}

function matchTokens(text = "") {
  const tokens = [];
  for (const match of String(text || "").matchAll(/[一-龥ァ-ヶーA-Za-z0-9]{2,}/gu)) {
    const token = match[0];
    if (token.length >= 2) {
      tokens.push(token);
    }
  }
  return uniqueStrings(tokens).slice(0, 8);
}

function unrelatedBodySitePenalty(query = "", candidateName = "") {
  const bodySiteGroups = [
    ["胸腔", "胸部", "胸膜", "肺"],
    ["腹部", "胃", "十二指腸", "大腸", "肝", "胆", "膵"],
    ["眼", "眼底", "角膜", "水晶体"],
    ["耳", "鼻", "咽頭", "喉頭"],
    ["皮膚", "創傷", "創部", "熱傷", "褥瘡"],
    ["骨", "関節", "腰椎", "頸椎", "膝", "肩"]
  ];
  const queryGroups = bodySiteGroups
    .map((terms, index) => ({ index, hit: terms.some((term) => query.includes(term)) }))
    .filter((entry) => entry.hit)
    .map((entry) => entry.index);
  if (!queryGroups.length) {
    return 0;
  }
  const candidateGroups = bodySiteGroups
    .map((terms, index) => ({ index, hit: terms.some((term) => candidateName.includes(term)) }))
    .filter((entry) => entry.hit)
    .map((entry) => entry.index);
  if (!candidateGroups.length) {
    return 0;
  }
  return candidateGroups.some((index) => queryGroups.includes(index)) ? 0 : 90;
}

function candidateProposalFromProcedureItem({
  proposalId,
  title,
  reason,
  conditionText,
  basis = "",
  evidence = "",
  item = {},
  sortOrder = 50
} = {}) {
  const points = Number(item.points || item.totalPoints || 0);
  return {
    proposalId,
    title,
    reason,
    conditionText,
    basis,
    evidence,
    actionType: points > 0 ? "adoptable" : "confirm_required",
    potentialPoints: points,
    code: String(item.code || ""),
    orderType: "procedure",
    source: "clinical_billing_opportunity",
    sortOrder,
    candidateLine: {
      lineId: `proposal_line_${String(proposalId || item.code || "").replace(/[^\w-]/gu, "_")}`,
      code: String(item.code || ""),
      name: item.name || item.displayName || item.baseName || title,
      orderType: "procedure",
      points,
      quantity: 1,
      totalPoints: points,
      status: "candidate",
      reason,
      source: "medical_procedure_master",
      coverage: {
        scope: "master_lookup_only",
        chapter: "procedure_code_master",
        supportLevel: "review_required",
        reviewRequired: true
      },
      supportLevel: "review_required",
      reviewRequired: true
    }
  };
}

function masterCandidateFromItem(item = {}, event = {}, {
  masterType = "medical_service",
  rank = 1,
  candidateStatus = "strong_match",
  searchQuery = "",
  generatedBy = "master_search"
} = {}) {
  if (!item?.code) {
    return null;
  }
  const classified = classifyMedicalServiceCandidate(item);
  const code = String(item.code || "");
  const name = item.name || item.displayName || item.baseName || item.shortName || "";
  return {
    masterCandidateId: `mc_${candidateIdPart([event?.clinicalEventId, code, searchQuery].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterType,
    masterCode: code,
    masterName: name,
    points: Number(item.points || item.totalPoints || 0),
    category: item.kind || item.sourceType || item.source || "",
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    directRetrievalAllowed: classified.directRetrievalAllowed,
    requiresParentCode: classified.requiresParentCode,
    derivedOnly: classified.derivedOnly,
    searchQuery,
    searchScore: Number(item.score || 0) || null,
    rank,
    candidateStatus,
    source: item.sourceType || item.source || "",
    sourceVersion: item.sourceVersion || item.source_version || "",
    effectiveFrom: item.effectiveFrom || item.effective_from || "",
    effectiveTo: item.effectiveTo || item.effective_to || "",
    generatedBy
  };
}

function normalizeMasterCandidates(values = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of asArray(values).filter(Boolean)) {
    const key = [
      candidate.clinicalEventId,
      candidate.masterType,
      candidate.masterCode,
      candidate.searchQuery
    ].join("|");
    if (!candidate.masterCode || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, 80);
}

function stringValue(value) {
  return String(value || "").trim();
}

function annotateMedicalServiceCandidate(item = {}) {
  const classified = classifyMedicalServiceCandidate(item);
  return {
    ...item,
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    directRetrievalAllowed: classified.directRetrievalAllowed,
    requiresParentCode: classified.requiresParentCode,
    derivedOnly: classified.derivedOnly
  };
}

function classifyMedicalServiceCandidate(item = {}) {
  const explicitFeeCategory = stringValue(item.feeCategory || item.fee_category || item.categoryRole || item.category_role);
  const explicitItemRole = stringValue(item.itemRole || item.item_role || item.role);
  if (explicitFeeCategory || explicitItemRole) {
    const itemRole = normalizeMasterItemRole(explicitItemRole || inferRoleFromFeeCategory(explicitFeeCategory));
    const feeCategory = explicitFeeCategory || inferFeeCategoryFromRole(itemRole);
    return normalizedMedicalServiceClassification({
      feeCategory,
      itemRole,
      directRetrievalAllowed: item.directRetrievalAllowed ?? item.direct_retrieval_allowed,
      requiresParentCode: item.requiresParentCode ?? item.requires_parent_code
    });
  }

  const code = String(item.code || "");
  const text = normalizeProcedureMatchText([
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].filter(Boolean).join(" "));

  if (/減算|不適合/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "reduction", itemRole: "reduction" });
  }
  if (/判断料/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_judgment", itemRole: "judgment" });
  }
  if (/検体検査管理加算|外来迅速検体検査加算/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_addon", itemRole: "addon" });
  }
  if (/採血|静脈血|動脈血|B-V|ＢＶ|検体採取/iu.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_collection", itemRole: "collection" });
  }
  if (code.startsWith("111") || code.startsWith("112")) {
    return normalizedMedicalServiceClassification({ feeCategory: "basic_fee", itemRole: "base" });
  }
  if (code.startsWith("113") || /管理料|指導料/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "management_fee", itemRole: "base" });
  }
  if (code.startsWith("170") || /ct|mri|画像|撮影/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "imaging_basic", itemRole: "base" });
  }
  if (code.startsWith("160")) {
    if (/超音波|心電図|視野|眼圧|眼底|スリット|眼軸|内視鏡|呼吸機能/u.test(text)) {
      return normalizedMedicalServiceClassification({ feeCategory: "physiological_exam_basic", itemRole: "base" });
    }
    return normalizedMedicalServiceClassification({ feeCategory: "lab_test_basic", itemRole: "base" });
  }
  if (code.startsWith("140")) {
    return normalizedMedicalServiceClassification({ feeCategory: "treatment_basic", itemRole: "base" });
  }
  return normalizedMedicalServiceClassification({ feeCategory: "procedure_basic", itemRole: "base" });
}

function normalizedMedicalServiceClassification({
  feeCategory = "procedure_basic",
  itemRole = "base",
  directRetrievalAllowed = null,
  requiresParentCode = null
} = {}) {
  const normalizedRole = normalizeMasterItemRole(itemRole);
  const category = stringValue(feeCategory) || inferFeeCategoryFromRole(normalizedRole);
  const derivedOnly = ["addon", "judgment", "collection", "reduction"].includes(normalizedRole);
  const directAllowed = directRetrievalAllowed == null
    ? !derivedOnly
    : Boolean(directRetrievalAllowed);
  return {
    feeCategory: category,
    itemRole: normalizedRole,
    directRetrievalAllowed: directAllowed && !derivedOnly,
    requiresParentCode: requiresParentCode == null ? derivedOnly : Boolean(requiresParentCode),
    derivedOnly
  };
}

function normalizeMasterItemRole(value) {
  const role = stringValue(value);
  if (["addon", "judgment", "collection", "reduction", "comment", "material", "base"].includes(role)) {
    return role;
  }
  return "base";
}

function inferRoleFromFeeCategory(value) {
  const category = stringValue(value);
  if (category.includes("addon")) return "addon";
  if (category.includes("judgment")) return "judgment";
  if (category.includes("collection")) return "collection";
  if (category.includes("reduction")) return "reduction";
  return "base";
}

function inferFeeCategoryFromRole(role) {
  if (role === "addon") return "procedure_addon";
  if (role === "judgment") return "lab_judgment";
  if (role === "collection") return "lab_collection";
  if (role === "reduction") return "reduction";
  return "procedure_basic";
}

function directRetrievalFilterReason(item = {}, { allowedFeeCategories = null } = {}) {
  const classified = classifyMedicalServiceCandidate(item);
  if (classified.derivedOnly || !classified.directRetrievalAllowed) {
    return `derived_only:${classified.itemRole || classified.feeCategory}`;
  }
  const hasExplicitCategoryGate = allowedFeeCategories instanceof Set || Array.isArray(allowedFeeCategories);
  const allowed = allowedFeeCategorySet(allowedFeeCategories);
  if (hasExplicitCategoryGate && !allowed.has(classified.feeCategory)) {
    return `category_gate:${classified.feeCategory}`;
  }
  return "";
}

function allowedDirectRetrievalFeeCategoriesForEvent(event = {}) {
  const type = normalizeClinicalEventType(event);
  return DIRECT_RETRIEVAL_FEE_CATEGORIES_BY_EVENT_TYPE[type] || new Set(["procedure_basic"]);
}

function allowedFeeCategorySet(value) {
  if (value instanceof Set) {
    return value;
  }
  return new Set(asArray(value).map((item) => String(item || "").trim()).filter(Boolean));
}

function allowedFeeCategoriesForTrace(value) {
  return [...allowedFeeCategorySet(value)].sort();
}

function filteredCandidateTrace(candidate = {}, reason = "") {
  const classified = classifyMedicalServiceCandidate(candidate);
  return {
    code: String(candidate.code || ""),
    name: candidate.name || candidate.displayName || candidate.baseName || candidate.shortName || "",
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    reason
  };
}

function searchTraceSummary(query = "", search = {}) {
  return {
    query,
    outcome: search?.item?.code ? "matched" : search?.error ? "error" : "no_match",
    inspectedCount: Number(search?.inspectedCount || 0),
    selectedCode: search?.item?.code ? String(search.item.code) : "",
    filteredCandidates: asArray(search?.filteredCandidates).slice(0, 5),
    error: search?.error || ""
  };
}

function clinicalTraceEvent({
  stage = "unknown",
  event = {},
  categoryLabel = "",
  outcome = "",
  allowedFeeCategories = null,
  query = "",
  selected = null,
  searches = [],
  message = ""
} = {}) {
  return {
    traceId: `trace_${candidateIdPart([stage, event?.clinicalEventId || event?.clinical_event_id, outcome, query].join("_"))}`,
    stage,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    eventType: normalizeClinicalEventType(event),
    eventName: clinicalEventName(event),
    categoryLabel,
    outcome,
    allowedFeeCategories: allowedFeeCategoriesForTrace(allowedFeeCategories),
    query,
    selected,
    searches: asArray(searches),
    message
  };
}

function normalizeClinicalTrace(values = []) {
  const seen = new Set();
  const result = [];
  for (const trace of asArray(values).filter(Boolean)) {
    const key = trace.traceId || [
      trace.stage,
      trace.clinicalEventId,
      trace.eventName,
      trace.outcome,
      trace.query
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trace);
  }
  return result.slice(0, 120);
}

function billingCandidatesFromProcedureResult(event = {}, result = {}) {
  const procedureCodeSet = new Set(asArray(result?.procedureCodes).map((code) => String(code || "")));
  return asArray(result?.masterCandidates)
    .filter((candidate) => procedureCodeSet.has(String(candidate.masterCode || "")))
    .map((candidate) => ({
      billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, candidate.masterCode].join("_"))}`,
      clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
      masterCandidateId: candidate.masterCandidateId,
      candidateKind: "procedure",
      eligibilityStatus: "billable",
      safetyLevel: "safe_if_confirmed",
      code: candidate.masterCode,
      name: candidate.masterName,
      pointValue: candidate.points,
      feeCategory: candidate.feeCategory,
      itemRole: candidate.itemRole,
      generatedBy: candidate.generatedBy,
      source: "rule_engine_master_match"
    }));
}

function billingCandidatesFromMedicationResult(event = {}, result = {}) {
  if (!result?.order?.drug_code) {
    return [];
  }
  const candidate = asArray(result.masterCandidates).find((item) => item.masterCode === String(result.order.drug_code));
  return [{
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, result.order.drug_code].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: candidate?.masterCandidateId || "",
    candidateKind: "drug",
    eligibilityStatus: "billable",
    safetyLevel: "safe_if_confirmed",
    code: String(result.order.drug_code),
    name: candidate?.masterName || clinicalEventName(event),
    pointValue: candidate?.points || 0,
    source: "rule_engine_master_match"
  }];
}

function billingCandidatesFromMaterialResult(event = {}, result = {}) {
  if (!result?.input?.code) {
    return [];
  }
  const candidate = asArray(result.masterCandidates).find((item) => item.masterCode === String(result.input.code));
  return [{
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, result.input.code].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: candidate?.masterCandidateId || "",
    candidateKind: "material",
    eligibilityStatus: "billable",
    safetyLevel: "safe_if_confirmed",
    code: String(result.input.code),
    name: candidate?.masterName || clinicalEventName(event),
    pointValue: candidate?.points || 0,
    source: "rule_engine_master_match"
  }];
}

function billingCandidateFromProposal(event = {}, proposal = {}) {
  if (!proposal) {
    return null;
  }
  return {
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, proposal.proposalId].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: "",
    candidateKind: "proposal",
    eligibilityStatus: "proposal",
    safetyLevel: "safe_if_confirmed",
    code: proposal.code || proposal.candidateLine?.code || "",
    name: proposal.title || clinicalEventName(event),
    pointValue: Number(proposal.potentialPoints || proposal.candidateLine?.points || 0),
    source: "rule_engine_proposal"
  };
}

function normalizeBillingCandidates(values = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of asArray(values).filter(Boolean)) {
    const key = [
      candidate.clinicalEventId,
      candidate.candidateKind,
      candidate.code,
      candidate.name
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, 80);
}

function normalizeCandidateProposals(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const key = [
      value.proposalId,
      value.code,
      value.candidateLine?.code,
      value.title
    ].map((part) => String(part || "").trim()).filter(Boolean).join("|");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function outpatientBasicFromStructuredVisit(visitType = {}, text = "") {
  const kind = String(visitType?.kind || "").trim();
  const evidence = normalizeClinicalText(visitType?.evidence || "");
  if (!["initial", "revisit"].includes(kind) || !evidence) {
    return null;
  }
  if (isNegatedContext(evidence) || isFutureOrOrderOnlyContext(evidence)) {
    return null;
  }
  if (kind === "initial" && /(初診|初回受診|初めて|初来院)/u.test(evidence)) {
    return { fee_kind: "initial" };
  }
  if (kind === "revisit" && /(再診|再来|フォロー|経過観察)/u.test(evidence) && isCurrentVisitEvidence(evidence)) {
    return { fee_kind: "revisit" };
  }
  return null;
}

function inferOutpatientBasicOptions(text) {
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
      continue;
    }
    if (/(初診|初回受診|初めて|初来院)/u.test(sentence)) {
      return { fee_kind: "initial" };
    }
    if (/(再診|再来|フォロー|経過観察|再評価)/u.test(sentence) && isCurrentVisitEvidence(sentence)) {
      return { fee_kind: "revisit" };
    }
  }
  return null;
}

function inferInpatientBasicOptions(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (!isInpatientEncounter(session, normalizedText)) {
    return {
      inferred: {},
      reviewWarnings: []
    };
  }

  if (hasDpcContext(normalizedText, session)) {
    return {
      inferred: {},
      reviewWarnings: [
        "DPC対象またはDPC確認が必要な入院です。出来高の入院基本料は自動候補化せず、DPCレビューとして確認してください。"
      ]
    };
  }

  const acuteGeneral = acuteGeneralInpatientBasicFromText(normalizedText, session);
  if (!acuteGeneral) {
    return {
      inferred: {},
      reviewWarnings: [
        "病棟区分確認: 入院診療の記載があります。入院基本料の種別を確認してください。",
        "入院日数確認: 入院基本料の算定日数を確認してください。",
        "施設基準確認: 入院基本料の施設基準を確認してください。"
      ]
    };
  }

  const reviewWarnings = [
    `病棟区分確認: 急性期一般入院料${acuteGeneral.kind}をカルテ本文から候補化しました。病棟区分と施設基準を確認してください。`,
    `入院日数確認: 入院基本料の算定日数は${acuteGeneral.days}日として候補化しています。入退院日・算定日数を確認してください。`
  ];

  return {
    inferred: {
      inpatient_basic: {
        basic_fee_code: acuteGeneral.basicFeeCode,
        basic_fee_days: acuteGeneral.days,
        facility_standard_key: "一般入院"
      },
      facility_standard_keys: ["一般入院"]
    },
    reviewWarnings
  };
}

function acuteGeneralInpatientBasicFromText(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  const match = normalizedText.match(/急性期一般入院料\s*([1-6])/u);
  const kind = match?.[1] || "";
  const basicFeeCode = ACUTE_GENERAL_INPATIENT_BASIC_CODES[kind];
  if (!basicFeeCode) {
    return null;
  }
  return {
    kind,
    basicFeeCode,
    days: inferInpatientBasicDays(normalizedText, session)
  };
}

function inferInpatientBasicDays(text = "", session = {}) {
  const sessionDays = inpatientBasicDaysFromSession(session);
  if (sessionDays) {
    return sessionDays;
  }
  const normalizedText = normalizeClinicalText(text);
  const explicitDays = normalizedText.match(/(?:として)?\s*(\d{1,2})\s*日分/u);
  if (explicitDays) {
    return clampInpatientDays(explicitDays[1]);
  }
  const dayOfAdmission = normalizedText.match(/入院\s*(\d{1,2})\s*日目/u);
  if (dayOfAdmission) {
    return clampInpatientDays(dayOfAdmission[1]);
  }
  return 1;
}

function inpatientBasicDaysFromSession(session = {}) {
  const explicit = [
    session?.inpatientBasicDays,
    session?.inpatient_basic_days,
    session?.inpatientBasic?.basicFeeDays,
    session?.inpatient_basic?.basic_fee_days,
    session?.claimContext?.inpatient_basic?.basic_fee_days,
    session?.calculationOptions?.inpatient_basic?.basic_fee_days,
    session?.encounter?.inpatient_basic_days
  ].find((value) => value !== undefined && value !== null && value !== "");
  if (explicit) {
    return clampInpatientDays(explicit);
  }

  const admissionDate = sessionAdmissionDate(session);
  const serviceDate = sessionServiceDate(session);
  if (!admissionDate || !serviceDate) {
    return 0;
  }
  const admission = new Date(`${admissionDate}T00:00:00.000Z`);
  const service = new Date(`${serviceDate}T00:00:00.000Z`);
  if (Number.isNaN(admission.getTime()) || Number.isNaN(service.getTime()) || service < admission) {
    return 0;
  }
  return clampInpatientDays(Math.floor((service.getTime() - admission.getTime()) / 86400000) + 1);
}

function sessionAdmissionDate(session = {}) {
  return String(
    session?.admissionDate
    || session?.admission_date
    || session?.encounter?.admissionDate
    || session?.encounter?.admission_date
    || session?.claimContext?.encounter?.admission_date
    || session?.claimContext?.encounter?.admissionDate
    || session?.calculationOptions?.encounter?.admission_date
    || session?.calculationOptions?.encounter?.admissionDate
    || ""
  ).slice(0, 10);
}

function sessionServiceDate(session = {}) {
  return String(
    session?.serviceDate
    || session?.service_date
    || session?.date
    || session?.encounter?.serviceDate
    || session?.encounter?.service_date
    || session?.claimContext?.encounter?.service_date
    || session?.claimContext?.encounter?.serviceDate
    || ""
  ).slice(0, 10);
}

function clampInpatientDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1) {
    return 1;
  }
  return Math.min(31, Math.floor(days));
}

function isInpatientEncounter(session = {}, text = "") {
  const setting = encounterSetting(session);
  if (setting === "inpatient") {
    return true;
  }
  if (setting === "outpatient") {
    return false;
  }
  return false;
}

function hasInpatientCareContext(text = "") {
  const normalizedText = normalizeClinicalText(text);
  if (
    !normalizedText
    || NON_CURRENT_INPATIENT_CONTEXT_PATTERN.test(normalizedText)
    || THIRD_PARTY_INPATIENT_CONTEXT_PATTERN.test(normalizedText)
  ) {
    return false;
  }
  return STRONG_INPATIENT_CONTEXT_PATTERN.test(normalizedText);
}

function hasUnresolvedInpatientEncounterText(session = {}, text = "") {
  return !hasExplicitEncounterSetting(session) && hasInpatientCareContext(text);
}

function hasDpcContext(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (hasNonDpcContext(normalizedText, session)) {
    return false;
  }
  if (OTHER_PROVIDER_DPC_CONTEXT_PATTERN.test(normalizedText)) {
    return false;
  }
  if (DPC_CONTEXT_PATTERN.test(normalizedText)) {
    return true;
  }
  const dpcOptions = [
    session?.dpc,
    session?.calculationOptions?.dpc,
    session?.claimContext?.dpc,
    session?.encounter?.dpc
  ].filter(isPlainObject);
  return dpcOptions.some((option) => (
    Boolean(option.dpc_claim)
    || Boolean(option.dpcCode)
    || Boolean(option.dpc_code)
    || Boolean(option.classification_code)
  ));
}

function encounterSetting(session = {}) {
  return String(session?.setting || session?.encounter?.setting || "").trim().toLowerCase();
}

function hasExplicitEncounterSetting(session = {}) {
  return Boolean(encounterSetting(session));
}

function hasNonDpcContext(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (NON_DPC_CONTEXT_PATTERN.test(normalizedText)) {
    return true;
  }
  const dpcOptions = [
    session?.dpc,
    session?.calculationOptions?.dpc,
    session?.claimContext?.dpc,
    session?.encounter?.dpc
  ].filter(isPlainObject);
  return dpcOptions.some((option) => (
    option.dpc_claim === false
    || option.is_dpc === false
    || option.dpc === false
    || option.fee_for_service === true
  ));
}

function inferOutpatientBasicFromPatientHistory({
  session = {},
  priorSessions = [],
  diagnoses = [],
  currentOutpatientBasic = null
} = {}) {
  if (!session.patientId) {
    return {
      outpatientBasic: currentOutpatientBasic || null,
      reviewWarnings: ["患者IDがないため、過去受診履歴に基づく初診/再診判定ができません。"]
    };
  }

  const currentDiagnosisNames = diagnosisNames(diagnoses);
  const usablePriorSessions = asArray(priorSessions)
    .filter((prior) => prior && prior.feeSessionId !== session.feeSessionId);

  const historyBasedBasic = usablePriorSessions.length
    ? { fee_kind: "revisit" }
    : { fee_kind: "initial" };
  const reviewWarnings = [];

  if (currentOutpatientBasic?.fee_kind && currentOutpatientBasic.fee_kind !== historyBasedBasic.fee_kind) {
    if (historyBasedBasic.fee_kind === "revisit") {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を優先しています。新疾患初診として扱う場合は手動で確認してください。");
    } else {
      reviewWarnings.push("同一患者の過去算定記録が見つからないため初診料候補を優先しています。過去受診履歴がある場合は手動で確認してください。");
    }
    return {
      outpatientBasic: historyBasedBasic,
      reviewWarnings
    };
  }

  if (usablePriorSessions.length) {
    const priorDiagnosisNames = diagnosisNames(usablePriorSessions.flatMap((prior) => asArray(prior.diagnoses)));
    if (!currentDiagnosisNames.length) {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を立てています。病名が未入力のため、継続診療か新疾患初診かを確認してください。");
    } else if (priorDiagnosisNames.length && !hasRelatedDiagnosisName(currentDiagnosisNames, priorDiagnosisNames)) {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を立てています。過去病名と今回病名の継続性を確認してください。");
    }
  }

  return {
    outpatientBasic: currentOutpatientBasic || historyBasedBasic,
    reviewWarnings
  };
}

function diagnosisNames(values = []) {
  return normalizeClinicalDiagnoses(values)
    .map((diagnosis) => diagnosis.name)
    .filter(Boolean);
}

function hasRelatedDiagnosisName(currentNames = [], priorNames = []) {
  const currentKeys = currentNames.map(normalizeDiagnosisMatchKey).filter(Boolean);
  const priorKeys = priorNames.map(normalizeDiagnosisMatchKey).filter(Boolean);
  return currentKeys.some((current) => priorKeys.some((prior) => (
    current.includes(prior)
    || prior.includes(current)
    || shareDiagnosisToken(current, prior)
  )));
}

function inferPediatricAddOnReviewWarnings({ session = {}, text = "", outpatientBasic = null } = {}) {
  if (!outpatientBasic?.fee_kind || isInpatientEncounter(session, text)) {
    return [];
  }
  const age = patientAgeOnServiceDate(session);
  const normalizedText = normalizeClinicalText(text);
  const explicitlyMentioned = /乳幼児|幼児|小児加算|乳幼児加算|小児科外来診療料/u.test(normalizedText);
  if (!(Number.isFinite(age) && age < 6) && !explicitlyMentioned) {
    return [];
  }
  return [
    "小児加算の確認: 患者年齢またはカルテ記載から小児加算の対象になり得ます。初診/再診、受付時刻、時間外・休日・深夜、施設区分を確認してください。"
  ];
}

function patientAgeOnServiceDate(session = {}) {
  const serviceDate = parseDateOnly(session?.serviceDate || session?.encounter?.serviceDate);
  const birthDate = parseDateOnly(
    session?.patientSnapshot?.birthDate
    || session?.patient?.birthDate
    || session?.patientBirthDate
  );
  if (!serviceDate || !birthDate || birthDate > serviceDate) {
    return Number.NaN;
  }
  let age = serviceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const serviceMonth = serviceDate.getUTCMonth();
  const birthMonth = birthDate.getUTCMonth();
  if (
    serviceMonth < birthMonth
    || (serviceMonth === birthMonth && serviceDate.getUTCDate() < birthDate.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

function parseDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function normalizeDiagnosisMatchKey(value) {
  return String(value || "")
    .replace(/疑い|の可能性|可能性|急性|慢性|症|病|疾患|障害|[\s（）()・、,]/gu, "")
    .trim()
    .toLowerCase();
}

function shareDiagnosisToken(left, right) {
  if (left.length < 3 || right.length < 3) {
    return false;
  }
  for (let index = 0; index <= left.length - 3; index += 1) {
    if (right.includes(left.slice(index, index + 3))) {
      return true;
    }
  }
  return false;
}

function ctEquipmentKindFromText(value = "") {
  const text = normalizeClinicalText(value);
  for (const { kind, pattern } of CT_EQUIPMENT_KIND_PATTERNS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return "";
}

function mriEquipmentKindFromText(value = "") {
  const text = normalizeClinicalText(value);
  for (const { kind, pattern } of MRI_EQUIPMENT_KIND_PATTERNS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return "";
}

function clinicalEventEquipmentKind(event = {}, imagingKind = "", clinicalText = "") {
  const explicit = [
    event?.equipment_kind,
    event?.equipmentKind,
    event?.ct_equipment_kind,
    event?.ctEquipmentKind,
    event?.mri_equipment_kind,
    event?.mriEquipmentKind,
    event?.payload?.equipment_kind,
    event?.payload?.equipmentKind,
    event?.payload?.ct_equipment_kind,
    event?.payload?.ctEquipmentKind,
    event?.payload?.mri_equipment_kind,
    event?.payload?.mriEquipmentKind
  ].map((value) => String(value || "").trim()).find(Boolean);
  if (explicit) {
    return normalizeImagingEquipmentKind(explicit, imagingKind);
  }
  const evidence = clinicalEventEvidence(event);
  const fromEvidence = imagingKind === "ct" ? ctEquipmentKindFromText(evidence) : mriEquipmentKindFromText(evidence);
  if (fromEvidence) {
    return fromEvidence;
  }
  return imagingEquipmentKindForKindInText(clinicalText, imagingKind);
}

function imagingEquipmentKindForKindInText(text = "", imagingKind = "") {
  if (!text || !imagingKind) {
    return "";
  }
  const objectiveText = objectiveClinicalText(text) || text;
  for (const sentence of splitClinicalSentences(objectiveText)) {
    if (isFutureOrOrderOnlyContext(sentence) || isNegatedClinicalServiceContext(sentence)) {
      continue;
    }
    if (!sentenceMatchesImagingKind(sentence, imagingKind)) {
      continue;
    }
    const equipmentKind = imagingKind === "ct" ? ctEquipmentKindFromText(sentence) : mriEquipmentKindFromText(sentence);
    if (equipmentKind) {
      return equipmentKind;
    }
  }
  return "";
}

function normalizeImagingEquipmentKind(value = "", imagingKind = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const known = new Set([
    "multislice_4_to_16",
    "multislice_16_to_64",
    "multislice_64_to_128",
    "multislice_128_or_more",
    "three_tesla",
    "one_point_five_tesla",
    "other"
  ]);
  if (known.has(normalized)) {
    return normalized;
  }
  return imagingKind === "ct" ? ctEquipmentKindFromText(normalized) : mriEquipmentKindFromText(normalized);
}

function inferImagingOrders(text) {
  const orders = [];
  const reviewWarnings = [];
  const sentences = splitClinicalSentences(text);

  for (const sentence of sentences) {
    if (isNegatedClinicalServiceContext(sentence)) {
      continue;
    }
    if (/(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("MRI検査は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "mri")) {
        const equipmentKind = mriEquipmentKindFromText(sentence);
        const contrastState = localContrastState(sentence, "mri");
        const electronicState = localElectronicImageManagementState(sentence);
        const order = {
          kind: "mri",
          contrast: contrastState === "present"
        };
        if (electronicState === "present") {
          order.electronic_image_management = true;
        } else if (electronicState === "unknown") {
          reviewWarnings.push("電子保存確認: MRI検査の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
        }
        if (contrastState === "unknown") {
          reviewWarnings.push("造影確認: MRI検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
        }
        if (equipmentKind) {
          order.mri_equipment_kind = equipmentKind;
        } else {
          reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
        }
        orders.push(order);
      }
      continue;
    }
    if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("CT検査は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "ct")) {
        const equipmentKind = ctEquipmentKindFromText(sentence);
        const contrastState = localContrastState(sentence, "ct");
        const electronicState = localElectronicImageManagementState(sentence);
        const order = {
          kind: "ct",
          contrast: contrastState === "present"
        };
        if (electronicState === "present") {
          order.electronic_image_management = true;
        } else if (electronicState === "unknown") {
          reviewWarnings.push("電子保存確認: CT検査の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
        }
        if (contrastState === "unknown") {
          reviewWarnings.push("造影確認: CT検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
        }
        if (equipmentKind) {
          order.ct_equipment_kind = equipmentKind;
        } else {
          reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
        }
        orders.push(order);
      }
      continue;
    }
    if (/(X線|Ｘ線|レントゲン|単純撮影)/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("単純X線は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "simple_radiography")) {
        const contrastState = localContrastState(sentence, "ct");
        const electronicState = localElectronicImageManagementState(sentence);
        const order = {
          kind: "simple_radiography",
          acquisition_kind: "digital",
          radiography_diagnostic_kind: "simple_i"
        };
        if (electronicState === "present") {
          order.electronic_image_management = true;
        } else if (electronicState === "unknown") {
          reviewWarnings.push("電子保存確認: 単純X線の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
        }
        if (contrastState === "unknown") {
          reviewWarnings.push("造影確認: 画像検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
        }
        orders.push(order);
        reviewWarnings.push("単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。");
      }
    }
  }

  return {
    orders: dedupeObjects(orders),
    reviewWarnings
  };
}

function isPerformedObjectiveFinding(sentence) {
  return /(:|：|所見|結果|高値|低値|基準値|貯留|病変|あり|認める|施行|実施|検査|撮影|テスト|クラス|\+{1,4}|陽性|陰性)/u.test(sentence);
}

async function inferMedicationOrders(text, feeCalculator) {
  const orders = [];
  const reviewWarnings = [];
  if (typeof feeCalculator?.searchMaster !== "function") {
    return { orders, reviewWarnings };
  }

  for (const candidate of medicationNameCandidatesFromClinicalText(text)) {
    const sentence = candidate.sentence;
    const query = candidate.query;
    if (!sentence) {
      continue;
    }
    if (isHistoricalMedicationContext(sentence)) {
      continue;
    }
    if (!isCurrentPrescriptionContext(sentence)) {
      reviewWarnings.push(`薬剤「${query}」は今回処方として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const quantity = inferMedicationQuantity(sentence, query);
    if (!hasCalculableMedicationQuantity(quantity)) {
      reviewWarnings.push(`薬剤「${query}」は数量または日数が不足しているため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "drug", query, "drug");
    if (!item?.code) {
      reviewWarnings.push(`薬剤「${query}」をマスターコードへ解決できませんでした。`);
      continue;
    }
    orders.push({
      drug_code: String(item.code),
      ...quantity,
      dispensing_kind: medicationDispensingKindFromText(sentence, query)
    });
  }
  return {
    orders: dedupeObjects(orders, (item) => item.drug_code),
    reviewWarnings
  };
}

function medicationNameCandidatesFromClinicalText(text = "") {
  const seen = new Set();
  const result = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (!isMedicationCandidateSentence(sentence)) {
      continue;
    }
    for (const rawName of extractMedicationNameCandidates(sentence)) {
      const query = canonicalMedicationName(rawName);
      if (!query || query.length < 2 || isMedicationNameNoise(query)) {
        continue;
      }
      const key = query.replace(/\s+/gu, "").toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ query, sentence });
    }
  }
  return result.slice(0, 12);
}

function isMedicationCandidateSentence(sentence = "") {
  return /(処方|内服|外用|投与|注射|点滴|開始|追加|増量|変更|切り替え|継続|頓服|日分|mg|ｍｇ|錠|カプセル|軟膏|クリーム|テープ|ローション|配合錠)/u.test(sentence)
    && !/(検討のみ|適応検討|説明のみ|指導のみ|中止|終了のみ)/u.test(sentence);
}

function extractMedicationNameCandidates(sentence = "") {
  const normalized = String(sentence || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const candidates = [];
  const patterns = [
    /([一-龥ァ-ヶーA-Za-z0-9]+(?:配合錠|錠|カプセル|軟膏|クリーム|テープ|ローション|散|顆粒|シロップ|注射液|点眼液|内服液|液))/gu,
    /([一-龥ァ-ヶーA-Za-z][一-龥ァ-ヶーA-Za-z0-9]{1,32})(?=\s*\d+(?:\.\d+)?\s*(?:mg|g|μg|mcg|mL|ml|%))/giu,
    /(?:併用|追加|変更|切り替え|処方)[:：]\s*([一-龥ァ-ヶーA-Za-z0-9]{2,32})/gu,
    /(?:処方|内服|外用|投与|開始|追加|変更|切り替え|継続|頓服)[:：]?\s*([^。、\n「」]{2,42})/gu
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = String(match[1] || "").trim();
      if (value) candidates.push(value);
    }
  }
  return uniqueStrings(candidates);
}

function inferMedicationQuantity(text, query) {
  const normalizedText = String(text || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const normalizedQuery = String(query || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const index = normalizedText.indexOf(normalizedQuery);
  const nearby = index >= 0 ? normalizedText.slice(index, index + 100) : normalizedText;
  const days = nearby.match(/(\d+)\s*日分/u)?.[1];
  const perDay = nearby.match(/(?:毎食後|毎食|1日|１日)\s*(\d+)\s*(?:錠|枚|包|回)?/u)?.[1]
    || nearby.match(/(\d+)\s*(?:錠|枚|包)\s*[/／]\s*日/u)?.[1];
  const totalQuantity = nearby.match(/総量\s*(\d+(?:\.\d+)?)/u)?.[1]
    || normalizedText.match(/総量\s*(\d+(?:\.\d+)?)/u)?.[1];
  const externalTotalQuantity = inferExternalMedicationTotalQuantity(nearby)
    || inferExternalMedicationTotalQuantity(normalizedText);
  return {
    ...(totalQuantity || externalTotalQuantity ? { total_quantity: totalQuantity || externalTotalQuantity } : {}),
    ...(perDay ? { quantity_per_day: perDay } : {}),
    ...(days ? { days } : {})
  };
}

function hasCalculableMedicationQuantity(quantity = {}) {
  return Boolean(quantity.total_quantity || (quantity.quantity_per_day && quantity.days));
}

function inferExternalMedicationTotalQuantity(text = "") {
  if (!isExternalMedicationContext(text)) {
    return "";
  }
  const match = String(text || "").match(/(?:を|総量|全量|合計)?\s*(\d+(?:\.\d+)?)\s*(?:g|Ｇ|ｍL|mL|ml|ＭＬ|本|枚|包)(?=\s*(?:院内|処方|外用|塗布|点眼|点鼻|貼付|$|[、。]))/iu);
  return match?.[1] || "";
}

function isExternalMedicationContext(text = "") {
  return /(外用|塗布|軟膏|クリーム|ローション|テープ|貼付|点眼|点鼻|点耳|ゲル|フォーム|スプレー|坐薬|膣錠|膣剤)/u.test(String(text || ""));
}

function medicationDispensingKindFromText(text = "", name = "") {
  return isExternalMedicationContext(`${text} ${name}`) ? "external" : "internal_or_prn";
}

function inferMedicationDeliveryKind(text) {
  if (/(院外|処方箋|院外処方)/u.test(text)) {
    return "outside_prescription";
  }
  return "in_house";
}

function medicationOptionsFromVisitFacts(visitFacts = {}) {
  if (!isPlainObject(visitFacts)) {
    return null;
  }
  if (String(visitFacts.outside_prescription_issued || "").trim() !== "yes") {
    return null;
  }
  return {
    delivery_kind: "outside_prescription",
    prescription_category: "other",
    ...(String(visitFacts.generic_name_prescription || "").trim() === "yes" ? {
      generic_name_prescription_add_on: "generic_name_add_on_1"
    } : {})
  };
}

async function inferMaterialInputs(text, feeCalculator) {
  const inputs = [];
  const reviewWarnings = [];
  if (typeof feeCalculator?.searchMaster !== "function") {
    return { inputs, reviewWarnings };
  }
  for (const candidate of materialNameCandidatesFromClinicalText(text)) {
    const sentence = candidate.sentence;
    const query = candidate.query;
    if (!sentence) {
      continue;
    }
    if (!isCurrentMaterialUseContext(sentence)) {
      reviewWarnings.push(`特定器材・材料「${query}」は今回使用として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "material", query, "material");
    if (!item?.code) {
      reviewWarnings.push(`特定器材・材料「${query}」をマスターコードへ解決できませんでした。`);
      continue;
    }
    inputs.push({ code: String(item.code), quantity: "1" });
  }
  return {
    inputs: dedupeObjects(inputs, (item) => item.code),
    reviewWarnings
  };
}

function materialNameCandidatesFromClinicalText(text = "") {
  const seen = new Set();
  const result = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (!/(材料|特定器材|使用|装着|保護|固定|交換|シーネ|包帯|カテーテル|ドレーン|フィルム|パッド)/u.test(sentence)) {
      continue;
    }
    const matches = sentence.matchAll(/([一-龥ァ-ヶーA-Za-z0-9]+(?:シーネ|包帯|カテーテル|ドレーン|チューブ|フィルム|パッド))/gu);
    for (const match of matches) {
      const query = String(match[1] || "").trim();
      if (!query || /(湿布|貼付薬)$/u.test(query)) {
        continue;
      }
      const key = query.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ query, sentence });
    }
  }
  return result.slice(0, 8);
}

function buildFeeSessionContext(session = {}) {
  return {
    patientDisplayName: session.patientSnapshot?.displayName || "",
    facilityName: session.facilitySnapshot?.displayName || "",
    departmentName: session.departmentSnapshot?.displayName || "",
    serviceDate: session.serviceDate || "",
    billingMonth: session.billingMonth || session.claimMonth || "",
    claimMonth: session.claimMonth || session.billingMonth || "",
    visitType: session.visitType || "",
    diagnoses: String(session.diagnosesSource || "").trim() === "manual" ? asArray(session.diagnoses)
      .map((diagnosis) => diagnosis?.name || diagnosis?.displayName || diagnosis)
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .slice(0, 20) : []
  };
}

function diagnosesFromClinicalFacts(facts = {}) {
  return normalizeClinicalDiagnoses(asArray(facts?.diagnoses)
    .map((diagnosis) => {
      const name = cleanClinicalDiagnosisName(diagnosis?.name || diagnosis?.displayName || diagnosis);
      if (!name) {
        return null;
      }
      const status = normalizeDiagnosisStatus(diagnosis?.status);
      if (!isUsableClinicalDiagnosisStatus(status)) {
        return null;
      }
      return {
        name,
        ...(status ? { status } : {})
      };
    })
    .filter(Boolean));
}

function clinicalEventsFromClinicalFacts(facts = {}) {
  const sourceEvents = asArray(facts?.clinical_events).length
    ? asArray(facts.clinical_events)
    : asArray(facts?.billing_events);
  return sourceEvents
    .flatMap((event, index) => {
      const normalized = normalizeClinicalEvent(event, index);
      return normalized ? expandCompositeLabClinicalEvent(normalized) : [];
    })
    .filter(Boolean);
}

function clinicalEventsFromChecklistFindings({
  facts = {},
  checklistMenu = [],
  clinicalText = "",
  existingEvents = []
} = {}) {
  const menuById = new Map(asArray(checklistMenu).map((item) => [String(item.menuId || item.menu_id || ""), item]));
  const existing = asArray(existingEvents);
  const events = [];
  const traceEvents = [];
  for (const [index, finding] of asArray(facts?.checklist_findings).entries()) {
    const menuId = String(finding?.menu_id || finding?.menuId || "").trim();
    const status = normalizeChecklistFindingStatus(finding?.status);
    const menu = menuById.get(menuId);
    if (!menu || status === "not_in_text") {
      continue;
    }
    const evidence = String(finding?.evidence || "").trim();
    if (!checklistFindingEvidenceIsUsable({ status, evidence, clinicalText })) {
      traceEvents.push({
        stage: "checklist_recall",
        outcome: "ignored",
        menuId,
        status,
        label: menu?.label || "",
        message: "checklist_evidence_missing_or_not_in_text"
      });
      continue;
    }
    if (existing.some((event) => clinicalEventMatchesChecklistMenu(event, menu))) {
      traceEvents.push({
        stage: "checklist_recall",
        outcome: "already_extracted",
        menuId,
        status,
        label: menu.label || ""
      });
      continue;
    }
    const event = normalizeClinicalEvent(checklistFindingToClinicalEvent({
      finding,
      menu,
      index
    }), index);
    if (!event) {
      continue;
    }
    events.push(event);
    existing.push(event);
    traceEvents.push(clinicalTraceEvent({
      stage: "checklist_recall",
      event,
      categoryLabel: menu.label || event.name,
      outcome: "recovered",
      message: `checklist_${status}`
    }));
  }
  return {
    events,
    traceEvents
  };
}

const BLOCKING_CHECKLIST_CONTRADICTION_STATUSES = new Set([
  "not_in_text",
  "mentioned_not_performed",
  "planned",
  "past_or_external"
]);

function clinicalEventContradictionsFromChecklistFindings({
  facts = {},
  checklistMenu = [],
  clinicalText = "",
  existingEvents = []
} = {}) {
  const menuById = new Map(asArray(checklistMenu).map((item) => [String(item.menuId || item.menu_id || ""), item]));
  const blockedEventIds = new Set();
  const reviewIssues = [];
  const traceEvents = [];
  for (const finding of asArray(facts?.checklist_findings)) {
    const menuId = String(finding?.menu_id || finding?.menuId || "").trim();
    const status = normalizeChecklistFindingStatus(finding?.status);
    const menu = menuById.get(menuId);
    if (!menu) {
      continue;
    }
    const matchingEvents = asArray(existingEvents).filter((event) => (
      isBillableClinicalEvent(event)
      && clinicalEventMatchesChecklistMenu(event, menu)
    ));
    if (!matchingEvents.length) {
      continue;
    }
    if (status === "unclear") {
      for (const event of matchingEvents) {
        traceEvents.push(clinicalTraceEvent({
          stage: "checklist_consistency",
          event,
          categoryLabel: menu.label || clinicalEventName(event),
          outcome: "warning",
          message: "checklist_unclear_for_billable_event"
        }));
      }
      continue;
    }
    if (!BLOCKING_CHECKLIST_CONTRADICTION_STATUSES.has(status)) {
      continue;
    }
    const evidence = String(finding?.evidence || "").trim();
    const evidenceUsable = status === "not_in_text"
      ? true
      : checklistFindingEvidenceIsUsable({ status, evidence, clinicalText });
    for (const event of matchingEvents) {
      const eventId = clinicalEventIdentity(event);
      blockedEventIds.add(eventId);
      const issue = reviewIssueFromChecklistContradiction({
        event,
        menu,
        finding,
        evidenceUsable
      });
      reviewIssues.push(issue);
      traceEvents.push(clinicalTraceEvent({
        stage: "checklist_consistency",
        event,
        categoryLabel: menu.label || clinicalEventName(event),
        outcome: "blocked",
        message: `checklist_contradiction_${status}${evidenceUsable ? "" : "_without_quoted_evidence"}`
      }));
    }
  }
  return {
    blockedEventIds,
    reviewIssues: dedupeObjects(reviewIssues, (issue) => issue.reviewIssueId),
    traceEvents
  };
}

function reviewIssueFromChecklistContradiction({ event = {}, menu = {}, finding = {}, evidenceUsable = true } = {}) {
  const name = clinicalEventName(event) || menu.label || "算定候補";
  const status = normalizeChecklistFindingStatus(finding?.status);
  const statusLabel = checklistFindingStatusLabel(status);
  const evidence = String(finding?.evidence || "").trim() || clinicalEventEvidence(event);
  const evidenceNote = evidenceUsable ? "" : " チェックリスト側の根拠引用が本文と一致しないため、特に確認が必要です。";
  const messageForStaff = `抽出結果確認: ${name}は自由抽出では今回実施として抽出されましたが、チェックリストでは「${statusLabel}」と判定されています。自動算定には入れず、カルテ上の実施事実を確認してください。${evidenceNote}`;
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([clinicalEventIdentity(event), menu.menuId || menu.menu_id, status, evidence].join("_"))}`,
    issueCode: "clinical_event_conflict",
    severity: "warning",
    title: "抽出結果確認",
    messageForStaff,
    relatedClinicalEventId: clinicalEventIdentity(event),
    evidence,
    source: "checklist_consistency"
  }, "clinical_event_conflict_check");
}

function checklistFindingStatusLabel(status = "") {
  return {
    performed_today: "今回実施",
    planned: "予定・依頼",
    past_or_external: "過去または他院",
    mentioned_not_performed: "未実施",
    not_in_text: "本文に記載なし",
    unclear: "不明"
  }[status] || "不明";
}

function normalizeChecklistFindingStatus(value = "") {
  const status = String(value || "").trim();
  return [
    "performed_today",
    "planned",
    "past_or_external",
    "mentioned_not_performed",
    "not_in_text",
    "unclear"
  ].includes(status) ? status : "unclear";
}

function checklistFindingEvidenceIsUsable({ status = "", evidence = "", clinicalText = "" } = {}) {
  if (status === "not_in_text") {
    return false;
  }
  const normalizedEvidence = normalizeClinicalText(evidence);
  if (!normalizedEvidence) {
    return false;
  }
  const normalizedText = normalizeClinicalText(clinicalText);
  return normalizedText.includes(normalizedEvidence);
}

function clinicalEventMatchesChecklistMenu(event = {}, menu = {}) {
  const menuType = String(menu.eventType || menu.type || menu.kind || "").trim();
  const menuDomain = String(menu.billingDomain || menu.billing_domain || "").trim();
  const eventType = normalizeClinicalEventType(event);
  const eventDomain = normalizeClinicalEventBillingDomain(event);
  if (menuDomain && menuDomain === eventDomain) {
    if (menu.kind === "domain") {
      return true;
    }
    if (menuType && menuType !== eventType) {
      return false;
    }
  }
  const eventName = normalizeClinicalText(clinicalEventName(event));
  const label = normalizeClinicalText(menu.label || menu.name || "");
  if (label && eventName.includes(label)) {
    return true;
  }
  if (menu.kind === "lab" && labConceptsFromClinicalEventName(event).some((concept) => concept.key === menu.conceptKey)) {
    return true;
  }
  if (menu.kind === "imaging") {
    const modality = String(event?.modality || "").trim();
    return modality && modality === menu.modality;
  }
  return false;
}

function checklistFindingToClinicalEvent({ finding = {}, menu = {}, index = 0 } = {}) {
  const status = normalizeChecklistFindingStatus(finding.status);
  const statusMapping = {
    performed_today: {
      action_status: menu.eventType === "medication" ? "prescribed" : "performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      certainty: "inferred"
    },
    planned: {
      action_status: "planned",
      temporal_relation: "future",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      certainty: "ambiguous"
    },
    past_or_external: {
      action_status: "performed",
      temporal_relation: "past",
      source_origin: "other_provider_record",
      provider_ownership: "other_provider",
      certainty: "ambiguous"
    },
    mentioned_not_performed: {
      action_status: "not_performed",
      temporal_relation: "current_visit",
      source_origin: "own_clinic_record",
      provider_ownership: "own_clinic",
      certainty: "explicit"
    },
    unclear: {
      action_status: "unknown",
      temporal_relation: "unknown",
      source_origin: "unknown",
      provider_ownership: "unknown",
      certainty: "ambiguous"
    }
  };
  const mapped = statusMapping[status] || statusMapping.unclear;
  return {
    clinical_event_id: `checklist_${candidateIdPart(menu.menuId || menu.menu_id || menu.label || index)}`,
    type: menu.eventType || menu.type || (menu.kind === "domain" ? "other" : menu.kind) || "other",
    billing_domain: menu.billingDomain || menu.billing_domain || "unknown",
    name: menu.name || menu.label || "確認項目",
    ...mapped,
    result_assertion: "unknown",
    section: "unknown",
    evidence: String(finding.evidence || "").trim(),
    search_queries: uniqueStrings([
      menu.query,
      menu.name,
      menu.label,
      ...asArray(menu.searchQueries),
      ...asArray(menu.search_queries)
    ].filter(Boolean)),
    modality: menu.modality || "none",
    body_site: "",
    specimen: "",
    collection_method: "",
    quantity_per_day: "",
    days: "",
    total_quantity: "",
    area_size_cm2: "",
    review_reason: String(finding.reason || "チェックリスト検証で回収").trim(),
    source: "checklist_recall"
  };
}

function expandCompositeLabClinicalEvent(event = {}) {
  const type = normalizeClinicalEventType(event);
  if (!["lab", "exam"].includes(type)) {
    return [event];
  }
  const concepts = labConceptsFromClinicalEventName(event);
  if (concepts.length <= 1) {
    return [event];
  }
  return concepts.map((concept) => {
    const clinicalEventId = `${event.clinicalEventId || event.clinical_event_id}_${concept.key}`;
    return {
      ...event,
      clinicalEventId,
      clinical_event_id: clinicalEventId,
      name: concept.name,
      search_queries: uniqueStrings([
        concept.query,
        ...concept.aliases
      ]),
      review_reason: event.review_reason || "複数の検査名を含む記載から検査ごとに分割"
    };
  });
}

function normalizeClinicalEventsForResult(values = []) {
  const seen = new Set();
  const result = [];
  for (const [index, event] of asArray(values).filter(Boolean).entries()) {
    const normalized = normalizeClinicalEvent(event, index);
    if (!normalized) {
      continue;
    }
    const key = [
      normalized.clinicalEventId,
      normalized.type,
      normalized.name,
      normalized.actionStatus,
      normalized.temporalRelation,
      normalized.providerOwnership,
      normalized.evidence
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      clinicalEventId: normalized.clinicalEventId,
      type: normalized.type,
      name: normalized.name,
      actionStatus: normalized.actionStatus,
      temporalRelation: normalized.temporalRelation,
      sourceOrigin: normalized.sourceOrigin,
      providerOwnership: normalized.providerOwnership,
      billingDomain: normalizeClinicalEventBillingDomain(normalized),
      resultAssertion: normalized.resultAssertion,
      certainty: normalized.certainty,
      section: normalized.section,
      evidence: normalized.evidence,
      modality: normalized.modality,
      bodySite: normalized.body_site,
      specimen: normalized.specimen,
      collectionMethod: normalized.collection_method,
      areaSizeCm2: normalized.area_size_cm2,
      quantityPerDay: normalized.quantity_per_day,
      days: normalized.days,
      totalQuantity: normalized.total_quantity,
      searchTerms: clinicalEventSearchQueries(normalized),
      reviewReason: normalized.review_reason,
      source: normalized.source || normalized.extractionSource || ""
    });
  }
  return result.slice(0, 120);
}

function excludedClinicalEventsFromClinicalFacts(facts = {}) {
  return asArray(facts?.excluded_events)
    .map((event, index) => normalizeClinicalEvent(event, index, { excluded: true }))
    .filter(Boolean);
}

function normalizeClinicalEvent(event = {}, index = 0, { excluded = false } = {}) {
  if (!isPlainObject(event)) {
    return null;
  }
  const type = normalizeClinicalEventType(event);
  const name = clinicalEventName(event);
  if (!name && !type) {
    return null;
  }
  const actionStatus = normalizeClinicalEventActionStatus(event, { excluded });
  const temporalRelation = normalizeClinicalEventTemporalRelation(event, { actionStatus });
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  const sourceOrigin = normalizeClinicalEventSourceOrigin(event, { providerOwnership, temporalRelation });
  const billingDomain = normalizeClinicalEventBillingDomain(event, { type });
  const resultAssertion = normalizeClinicalEventResultAssertion(event);
  const certainty = normalizeClinicalEventCertainty(event);
  const clinicalEventId = String(event?.clinical_event_id || event?.clinicalEventId || event?.event_id || event?.eventId || "")
    || `ce_${index + 1}_${candidateIdPart([type, name, clinicalEventEvidence(event)].join("_"))}`;
  const legacyStatus = legacyStatusFromClinicalEvent({
    actionStatus,
    temporalRelation,
    providerOwnership,
    originalStatus: event?.status
  });
  return {
    ...event,
    clinicalEventId,
    clinical_event_id: clinicalEventId,
    type,
    name,
    actionStatus,
    action_status: actionStatus,
    temporalRelation,
    temporal_relation: temporalRelation,
    sourceOrigin,
    source_origin: sourceOrigin,
    billingDomain,
    billing_domain: billingDomain,
    providerOwnership,
    provider_ownership: providerOwnership,
    resultAssertion,
    result_assertion: resultAssertion,
    certainty,
    status: legacyStatus,
    date_relation: legacyDateRelationFromClinicalEvent({ temporalRelation, providerOwnership }),
    section: normalizeClinicalSection(event?.section),
    evidence: String(event?.evidence || "").trim(),
    search_queries: uniqueStrings([
      ...asArray(event?.search_queries),
      ...asArray(event?.searchQueries)
    ]),
    modality: String(event?.modality || "none").trim() || "none",
    body_site: String(event?.body_site || event?.bodySite || "").trim(),
    specimen: String(event?.specimen || event?.payload?.specimen || "").trim(),
    collection_method: String(event?.collection_method || event?.collectionMethod || event?.payload?.collection_method || event?.payload?.collectionMethod || "").trim(),
    quantity_per_day: String(event?.quantity_per_day || event?.quantityPerDay || "").trim(),
    days: String(event?.days || "").trim(),
    total_quantity: String(event?.total_quantity || event?.totalQuantity || "").trim(),
    area_size_cm2: String(event?.area_size_cm2 || event?.areaSizeCm2 || "").trim(),
    review_reason: String(event?.review_reason || event?.reviewReason || event?.reason || "").trim()
  };
}

function normalizeClinicalEventActionStatus(event = {}, { excluded = false } = {}) {
  const explicit = String(event?.action_status || event?.actionStatus || "").trim();
  if ([
    "performed",
    "prescribed",
    "administered",
    "ordered",
    "planned",
    "considered",
    "instruction_only",
    "not_performed",
    "unknown"
  ].includes(explicit)) {
    return explicit;
  }

  const legacy = String(event?.status || "").trim();
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only"].includes(legacy)) {
    return legacy;
  }
  if (legacy === "negated") {
    return "not_performed";
  }
  if (legacy === "history" || legacy === "other_provider") {
    return "performed";
  }
  if (excluded) {
    return "unknown";
  }
  return legacy === "unclear" ? "unknown" : "unknown";
}

function normalizeClinicalEventTemporalRelation(event = {}, { actionStatus = "" } = {}) {
  const explicit = String(event?.temporal_relation || event?.temporalRelation || "").trim();
  if (["current_visit", "same_day_but_unknown", "past", "future", "unknown"].includes(explicit)) {
    return explicit;
  }
  const legacy = String(event?.date_relation || event?.dateRelation || "").trim();
  if (legacy === "current_visit") return "current_visit";
  if (legacy === "future") return "future";
  if (legacy === "past" || legacy === "other_provider") return "past";
  const status = String(event?.status || "").trim();
  if (["planned", "ordered", "considered"].includes(actionStatus) || ["planned", "ordered", "considered"].includes(status)) {
    return "future";
  }
  if (status === "history" || status === "other_provider") {
    return "past";
  }
  if (["performed", "prescribed", "administered"].includes(actionStatus)) {
    return "current_visit";
  }
  return "unknown";
}

function normalizeClinicalEventSourceOrigin(event = {}, { providerOwnership = "", temporalRelation = "" } = {}) {
  const explicit = String(event?.source_origin || event?.sourceOrigin || "").trim();
  if ([
    "own_clinic_record",
    "patient_reported",
    "external_document",
    "carried_in_result",
    "other_provider_record",
    "unknown"
  ].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (providerOwnership === "other_provider" || /他院|前医|かかりつけ|紹介元/u.test(text)) {
    return "other_provider_record";
  }
  if (/持参|健診結果|外部資料/u.test(text)) {
    return "carried_in_result";
  }
  if (temporalRelation === "past") {
    return "patient_reported";
  }
  return "own_clinic_record";
}

function normalizeClinicalEventResultAssertion(event = {}) {
  const explicit = String(event?.result_assertion || event?.resultAssertion || "").trim();
  if (["positive", "negative", "normal", "abnormal", "numeric", "not_applicable", "unknown"].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (/[<>]?\d+(?:\.\d+)?\s*(?:%|％|mg\/?dL|IU\/?mL|U\/?mL|mmHg|cm|mm|\/μL|\/uL)/iu.test(text)) {
    return "numeric";
  }
  if (/陰性|なし|異常なし|正常範囲|正常/u.test(text)) {
    return /異常なし|正常/u.test(text) ? "normal" : "negative";
  }
  if (/陽性|高値|低値|異常|あり|認める/u.test(text)) {
    return "abnormal";
  }
  return "unknown";
}

function normalizeClinicalEventCertainty(event = {}) {
  const explicit = String(event?.certainty || "").trim();
  if (["explicit", "inferred", "ambiguous"].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (/疑い|可能性|示唆|検討|かもしれない/u.test(text)) {
    return "ambiguous";
  }
  if (text) {
    return "explicit";
  }
  return "ambiguous";
}

function normalizeClinicalSection(value) {
  const section = String(value || "unknown").trim().toUpperCase();
  return ["S", "O", "A", "P"].includes(section) ? section : "unknown";
}

function legacyStatusFromClinicalEvent({
  actionStatus = "",
  temporalRelation = "",
  providerOwnership = "",
  originalStatus = ""
} = {}) {
  const original = String(originalStatus || "").trim();
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only", "history", "other_provider", "negated", "unclear"].includes(original)) {
    if (["history", "other_provider", "negated", "unclear"].includes(original)) {
      return original;
    }
  }
  if (providerOwnership === "other_provider") return "other_provider";
  if (temporalRelation === "past") return "history";
  if (actionStatus === "not_performed") return "negated";
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only"].includes(actionStatus)) {
    return actionStatus;
  }
  return "unclear";
}

function legacyDateRelationFromClinicalEvent({ temporalRelation = "", providerOwnership = "" } = {}) {
  if (providerOwnership === "other_provider") return "other_provider";
  if (temporalRelation === "future") return "future";
  if (temporalRelation === "past") return "past";
  if (temporalRelation === "current_visit" || temporalRelation === "same_day_but_unknown") return "current_visit";
  return "unknown";
}

function cleanClinicalDiagnosisName(value) {
  const name = String(value || "")
    .replace(/^\s*(?:病名|診断名)\s*[:：]\s*/u, "")
    .trim()
    .slice(0, 120);
  if (isClinicalFindingNotDiagnosis(name)) {
    return "";
  }
  return name;
}

function isClinicalFindingNotDiagnosis(value) {
  const text = normalizeClinicalText(value)
    .replace(/\s+/gu, "");
  if (!text) {
    return false;
  }
  if (/(高値|低値|陽性|陰性|基準値|結果|[<>]?\d+(?:\.\d+)?\s*(?:U\/?mL|IU\/?mL|mg\/?dL|ng\/?mL|pg\/?mL|%|％|\/μL|\/uL))/iu.test(text)
    && !/(炎|症|病|癌|腫瘍|不全|障害|嚢胞|症候群|疾患|異常)$/u.test(text)) {
    return true;
  }
  if (/^(?:血液検査|検査結果|検査値|所見)[:：]?/u.test(text)) {
    return true;
  }
  return false;
}

function normalizeClinicalDiagnoses(values = []) {
  const seen = new Set();
  const result = [];
  for (const diagnosis of asArray(values)) {
    const name = cleanClinicalDiagnosisName(diagnosis?.name || diagnosis?.displayName || diagnosis);
    if (!name) {
      continue;
    }
    const key = name.replace(/\s+/gu, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const status = normalizeDiagnosisStatus(diagnosis?.status);
    result.push({
      name,
      ...(status ? { status } : {})
    });
  }
  return result.slice(0, 20);
}

function normalizeDiagnosisStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["denied", "negated", "ruled_out", "family_history", "none"].includes(status)) {
    return "excluded";
  }
  if (["confirmed", "suspected", "history", "active"].includes(status)) {
    return status;
  }
  return "";
}

function isUsableClinicalDiagnosisStatus(status) {
  if (status === "excluded") {
    return false;
  }
  if (!status) {
    return true;
  }
  return ["confirmed", "suspected", "history", "active"].includes(status);
}

function normalizeClinicalEventType(event = {}) {
  return String(event?.type || "other").trim();
}

function normalizeClinicalEventBillingDomain(event = {}, { type = "" } = {}) {
  const value = String(event?.billing_domain || event?.billingDomain || event?.domain || "").trim();
  const allowed = new Set([
    "standard_lab",
    "standard_imaging",
    "standard_procedure",
    "standard_medication",
    "standard_material",
    "standard_management",
    "standard_counseling",
    "pathology",
    "emergency_time_addon",
    "psychiatry_special",
    "anesthesia",
    "surgery",
    "rehabilitation",
    "home_care",
    "endoscopy",
    "dialysis",
    "transfusion",
    "radiation_therapy",
    "injection_review_only",
    "unknown"
  ]);
  if (allowed.has(value) && value !== "unknown") {
    return value;
  }
  const eventType = String(type || normalizeClinicalEventType(event));
  return {
    lab: "standard_lab",
    imaging: "standard_imaging",
    procedure: "standard_procedure",
    treatment: "standard_procedure",
    medication: "standard_medication",
    injection: "standard_procedure",
    material: "standard_material",
    management: "standard_management",
    counseling: "standard_counseling",
    pathology: "pathology",
    emergency_time_addon: "emergency_time_addon",
    endoscopy: "endoscopy",
    dialysis: "dialysis",
    transfusion: "transfusion",
    radiation_therapy: "radiation_therapy",
    injection_review_only: "injection_review_only"
  }[eventType] || "unknown";
}

function normalizeClinicalEventStatus(event = {}) {
  return String(event?.status || legacyStatusFromClinicalEvent({
    actionStatus: event?.action_status || event?.actionStatus,
    temporalRelation: event?.temporal_relation || event?.temporalRelation,
    providerOwnership: event?.provider_ownership || event?.providerOwnership
  }) || "unclear").trim();
}

function isBillableClinicalEventStatus(status) {
  return ["performed", "prescribed", "administered"].includes(status);
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

function clinicalEventName(event = {}) {
  return String(event?.name || "").trim();
}

function clinicalEventIdentity(event = {}) {
  return String(event?.clinicalEventId || event?.clinical_event_id || event?.eventId || event?.event_id || "").trim();
}

function clinicalEventEvidence(event = {}) {
  return [event?.evidence, event?.name, event?.review_reason]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function excludedClinicalEventWarning(event = {}) {
  const type = normalizeClinicalEventType(event);
  const status = normalizeClinicalEventStatus(event);
  const dateRelation = normalizeClinicalEventDateRelation(event);
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  const name = clinicalEventName(event) || clinicalImagingDisplayName(event) || "項目";
  const reason = String(event?.reason || event?.review_reason || "").trim();

  if (type === "medication" && isMedicationNameNoise(name)) {
    return "";
  }
  if (["same_institution_other_department", "other_department", "other_provider"].includes(providerOwnership)) {
    return `${name}は他科・他院で管理または実施された内容として抽出されたため、今回の算定候補には入れていません。`;
  }
  if (["past", "other_provider"].includes(dateRelation)) {
    return `${name}は過去値・持参情報として抽出されたため、当日実施分としては算定候補に入れていません。`;
  }
  if (dateRelation === "future") {
    return `${name}は今後の予定として抽出されたため、今回の算定候補には入れていません。実施済みの場合は内容を確認してください。`;
  }
  if (type === "imaging" && ["planned", "ordered"].includes(status)) {
    return `${name}は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は内容を確認してください。`;
  }
  if (type === "medication" && status === "history") {
    return `薬剤「${name}」は既往薬・内服中として記載されているため、今回処方の算定候補には入れていません。`;
  }
  if (type === "medication" && ["planned", "ordered", "considered", "instruction_only", "unclear"].includes(status)) {
    return `薬剤「${name}」は今回処方として確定できないため、算定候補には入れていません。`;
  }
  if (type === "material" && status === "instruction_only") {
    return `特定器材・材料「${name}」は指導・説明のみとして記載されているため、算定候補には入れていません。`;
  }
  if (type === "material" && ["planned", "ordered", "considered", "unclear"].includes(status)) {
    return `特定器材・材料「${name}」は今回使用として確定できないため、算定候補には入れていません。`;
  }
  if (reason && ["planned", "ordered", "considered", "instruction_only", "history", "negated", "unclear"].includes(status)) {
    return reason;
  }
  return "";
}

function clinicalFactReviewWarnings(values = [], { onSuppressed } = {}) {
  return asArray(values)
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      const name = String(item?.name || item?.item || "").trim();
      const reason = String(item?.reason || item?.review_reason || item?.message || item?.detail || "").trim();
      if (name && reason && !reason.includes(name)) {
        return `${name}: ${reason}`;
      }
      return reason || name;
    })
    .filter((warning) => isActionableClinicalFactWarning(warning, { onSuppressed }))
    .filter(Boolean);
}

function isActionableClinicalFactWarning(warning, { onSuppressed } = {}) {
  const text = String(warning || "").trim();
  if (!text || /^(空欄|なし|無し|不明|未記載|確認事項)$/u.test(text)) {
    onSuppressed?.(text, "empty_or_placeholder_review_flag");
    return false;
  }
  if (reviewTopicCodeFromWarning(text)) {
    return true;
  }
  if (hasActionableClinicalReviewTarget(text)) {
    return true;
  }
  if (/文面から受診回数の明示なし/u.test(text)) {
    onSuppressed?.(text, "non_actionable_visit_count_flag");
    return false;
  }
  if (/初診\/再診の明記なし|初診・再診の明記なし|診療形態.*明記なし/u.test(text)) {
    onSuppressed?.(text, "non_actionable_visit_type_flag");
    return false;
  }
  if (/(billingMonth|claimMonth|請求月).*(未指定|未記載|不明)/iu.test(text)) {
    onSuppressed?.(text, "non_actionable_claim_month_flag");
    return false;
  }
  if (/適応検討のみで実施の記載なし/u.test(text)) {
    onSuppressed?.(text, "non_actionable_considered_only_flag");
    return false;
  }
  if (/(数量|日数|回数|総量).*(明記なし|不足|不明)/u.test(text) && !/[「:：]/u.test(text)) {
    onSuppressed?.(text, "quantity_flag_without_target");
    return false;
  }
  onSuppressed?.(text, "no_taxonomy_or_actionable_target");
  return false;
}

function hasActionableClinicalReviewTarget(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/\d{6,}/u.test(value)) return true;
  if (/[「『][^」』]{2,}[」』]/u.test(value)) return true;
  return /(薬剤|検査|画像|CT|ＣＴ|MRI|ＭＲＩ|X線|Ｘ線|超音波|処方|採血|検体|病理|細胞診|リハビリ|在宅|訪問診療|手術|麻酔|精神科|透析|輸血|内視鏡|放射線治療|尿|CRP|ＣＲＰ|HbA1c|ＨｂＡ１ｃ|インフル|溶連菌|SARS|COVID|コロナ|造影|電子保存|施設基準|届出)/iu.test(value);
}

function reviewOnlyClinicalEventDomain(event = {}) {
  const domain = normalizeClinicalEventBillingDomain(event);
  return [
    "pathology",
    "emergency_time_addon",
    "rehabilitation",
    "home_care",
    "psychiatry_special",
    "anesthesia",
    "surgery",
    "endoscopy",
    "dialysis",
    "transfusion",
    "radiation_therapy",
    "injection_review_only",
    "split_multi_day"
  ].includes(domain) ? domain : "";
}

function isNegatedClinicalEvent(event = {}) {
  const actionStatus = String(event?.action_status || event?.actionStatus || normalizeClinicalEventStatus(event)).trim();
  return ["not_performed", "negated"].includes(actionStatus);
}

function reviewOnlyDomainLabel(domain = "") {
  return {
    pathology: "病理診断",
    emergency_time_addon: "救急・時間外加算",
    rehabilitation: "リハビリテーション",
    home_care: "在宅医療",
    psychiatry_special: "精神科専門療法",
    anesthesia: "麻酔",
    surgery: "手術",
    endoscopy: "内視鏡",
    dialysis: "透析",
    transfusion: "輸血",
    radiation_therapy: "放射線治療",
    injection_review_only: "注射",
    split_multi_day: "複数日記録"
  }[String(domain || "")] || "未対応項目";
}

function reviewIssuesFromReviewOnlyDomainClinicalEvent(event = {}) {
  const domain = reviewOnlyClinicalEventDomain(event);
  if (!domain) {
    return [];
  }
  const name = clinicalEventName(event);
  const eventId = event?.clinicalEventId || event?.clinical_event_id || "";
  const evidence = clinicalEventEvidence(event);
  if (domain === "pathology") {
    return [
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "pathology_unsupported", name, evidence].join("_"))}`,
        issueCode: "pathology_unsupported",
        severity: "warning",
        title: "病理未対応",
        messageForStaff: `病理未対応: ${name || "病理診断/細胞診"}は病理診断・細胞診領域として抽出しました。現行の自動算定では確定算定せず、病理診断/細胞診の区分を人手で確認してください。`,
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "pathology_unsupported"),
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "specimen_submission_check", name, evidence].join("_"))}`,
        issueCode: "specimen_submission_check",
        severity: "warning",
        title: "検体提出確認",
        messageForStaff: `検体提出確認: ${name || "病理検体"}について、検体提出、標本種類、診断区分、結果説明予定を確認してください。自動算定には入れていません。`,
        requiredInput: "検体提出の有無、標本種類、病理診断/細胞診の区分",
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "specimen_submission_check")
    ];
  }
  if (domain === "emergency_time_addon") {
    return [
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "emergency_addon_check", name, evidence].join("_"))}`,
        issueCode: "emergency_addon_review_required",
        severity: "warning",
        title: "救急加算確認",
        messageForStaff: `救急加算確認: ${name || "救急・時間外加算"}は時間外・休日・深夜・救急加算に関係する記載として抽出しました。診療体制、受付時刻、休日/時間外条件を確認してください。自動算定には入れていません。`,
        requiredInput: "診療体制、受付時刻、休日/時間外/深夜条件",
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "emergency_addon_check"),
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "reception_time_check", name, evidence].join("_"))}`,
        issueCode: "missing_reception_time",
        severity: "warning",
        title: "受付時刻確認",
        messageForStaff: "受付時刻確認: 時間外・休日・深夜・救急加算の判定には受付時刻と診療日条件が必要です。未確認のため自動算定には入れていません。",
        requiredInput: "受付時刻、診療日、休日/時間外/深夜条件",
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "reception_time_check")
    ];
  }
  if (domain === "rehabilitation") {
    return [
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "rehab_unsupported", name, evidence].join("_"))}`,
        issueCode: "rehabilitation_unsupported",
        severity: "warning",
        title: "リハビリ未対応",
        messageForStaff: `リハビリ未対応: ${name || "リハビリテーション"}はリハビリテーション領域として抽出しました。現行の自動算定では確定算定せず、人手で確認してください。`,
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "rehab_unsupported"),
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "rehab_unit_check", name, evidence].join("_"))}`,
        issueCode: "rehabilitation_unit_unknown",
        severity: "warning",
        title: "実施単位確認",
        messageForStaff: "実施単位確認: リハビリテーション料の判定には疾患別区分、実施単位数、実施者、施設基準が必要です。未確認のため自動算定には入れていません。",
        requiredInput: "疾患別区分、実施単位数、実施者、施設基準",
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "rehab_unit_check")
    ];
  }
  if (domain === "home_care") {
    return [
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "home_care_unsupported", name, evidence].join("_"))}`,
        issueCode: "home_care_unsupported",
        severity: "warning",
        title: "在宅医療未対応",
        messageForStaff: `在宅医療未対応: ${name || "在宅医療"}は在宅医療領域として抽出しました。現行の自動算定では確定算定せず、人手で確認してください。`,
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "home_care_unsupported"),
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, "home_visit_check", name, evidence].join("_"))}`,
        issueCode: "home_visit_unknown",
        severity: "warning",
        title: "訪問診療確認",
        messageForStaff: "訪問診療確認: 在宅医療の判定には訪問診療/往診の実施区分、訪問日、同月履歴、施設基準が必要です。未確認のため自動算定には入れていません。",
        requiredInput: "訪問診療/往診の実施区分、訪問日、同月履歴、施設基準",
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, "home_visit_check")
    ];
  }
  if ([
    "psychiatry_special",
    "anesthesia",
    "surgery",
    "dialysis",
    "transfusion",
    "endoscopy",
    "radiation_therapy",
    "injection_review_only",
    "split_multi_day"
  ].includes(domain)) {
    const primaryTopicByDomain = {
      psychiatry_special: "psychiatry_special_unsupported",
      anesthesia: "anesthesia_unsupported",
      surgery: "surgery_unsupported",
      dialysis: "dialysis_unsupported",
      transfusion: "transfusion_unsupported",
      endoscopy: "endoscopy_unsupported",
      radiation_therapy: "radiation_therapy_unsupported",
      injection_review_only: "ambiguous_master_check",
      split_multi_day: "split_multi_day_check"
    };
    const helperTopicByDomain = {
      surgery: {
        topicCode: "procedure_detail_check",
        title: "手技内容確認",
        requiredInput: "術式、部位、左右、使用材料"
      },
      endoscopy: {
        topicCode: "biopsy_check",
        title: "生検有無確認",
        requiredInput: "生検の有無、検体提出、内視鏡の部位"
      },
      radiation_therapy: {
        topicCode: "irradiation_condition_check",
        title: "照射条件確認",
        requiredInput: "照射部位、線量、回数、方法"
      }
    };
    const topicCode = primaryTopicByDomain[domain] || "ambiguous_master_check";
    const label = reviewTopicDefinition(topicCode)?.label || reviewOnlyDomainLabel(domain);
    const issues = [
      withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, domain, name, evidence].join("_"))}`,
        issueCode: `${domain}_unsupported`,
        severity: "warning",
        title: label,
        messageForStaff: `${label}: ${name || reviewOnlyDomainLabel(domain)}は未対応または高リスク領域として抽出しました。現行の自動算定では確定算定せず、人手で確認してください。`,
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, topicCode)
    ];
    const helpers = domain === "anesthesia"
      ? anesthesiaHelperTopicsForClinicalEvent(event)
      : helperTopicByDomain[domain] ? [helperTopicByDomain[domain]] : [];
    for (const helper of helpers) {
      issues.push(withReviewTopic({
        reviewIssueId: `issue_${candidateIdPart([eventId, helper.topicCode, name, evidence].join("_"))}`,
        issueCode: helper.topicCode,
        severity: "warning",
        title: helper.title,
        messageForStaff: `${helper.title}: ${name || reviewOnlyDomainLabel(domain)}の算定判断に必要な情報を確認してください。自動算定には入れていません。`,
        requiredInput: helper.requiredInput,
        relatedClinicalEventId: eventId,
        evidence,
        source: "review_only_domain_gate",
        policy: { riskGate: "review_only", domain }
      }, helper.topicCode));
    }
    return issues;
  }
  return [];
}

function unsupportedClinicalEventWarning(event = {}) {
  const type = normalizeClinicalEventType(event);
  const name = clinicalEventName(event) || "抽出項目";
  if (type === "lab") {
    return `${name}は検体検査として抽出しましたが、現在の自動算定では検査コード確定が未対応です。実施内容をマスター検索で確認してください。`;
  }
  if (type === "management") {
    return `${name}は医学管理等として抽出しましたが、現在の自動算定では管理料コード確定が未対応です。算定条件を確認してください。`;
  }
  if (type === "counseling") {
    return `${name}は指導・説明として抽出しましたが、現在の自動算定では算定可否の自動判定が未対応です。算定条件を確認してください。`;
  }
  if (type && type !== "other") {
    return `${name}は${clinicalEventTypeLabel(type)}として抽出しましたが、現在の自動算定では直接候補化できないため、要確認です。`;
  }
  return "";
}

function reviewIssueFromExcludedClinicalEvent(event = {}) {
  const messageForStaff = excludedClinicalEventWarning(event);
  if (!messageForStaff) {
    return null;
  }
  const topicCode = reviewTopicCodeFromWarning(messageForStaff, event);
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), messageForStaff].join("_"))}`,
    issueCode: reviewIssueCodeFromWarning(messageForStaff, event),
    severity: "warning",
    title: reviewIssueTitleFromWarning(messageForStaff, event),
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "clinical_event_rule"
  }, topicCode);
}

function reviewIssueFromUnsupportedClinicalEvent(event = {}) {
  const messageForStaff = unsupportedClinicalEventWarning(event);
  if (!messageForStaff) {
    return null;
  }
  return {
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), messageForStaff].join("_"))}`,
    issueCode: "unsupported_event",
    severity: "warning",
    title: clinicalEventName(event) ? `${clinicalEventName(event)}の確認` : "確認事項",
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "clinical_event_rule"
  };
}

function anesthesiaHelperTopicsForClinicalEvent(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.review_reason,
    event?.reviewReason,
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
  const helpers = [];
  if (/(薬剤|麻酔薬|投与|用量|投与量|投与経路|mg|mL|ml|単位|持続|静注|吸入)/iu.test(text)) {
    helpers.push({
      topicCode: "medication_amount_check",
      title: "薬剤量確認",
      requiredInput: "麻酔薬剤名、投与量、投与経路、実施時間"
    });
  }
  if (/(面接|術前診察|術前面接|術前評価|麻酔科診察|麻酔前評価|説明時間)/u.test(text)) {
    helpers.push({
      topicCode: "anesthesia_interview_time_check",
      title: "面接時間確認",
      requiredInput: "術前診察・面接の実施有無、実施時間、担当者"
    });
  }
  if (!helpers.length || /(麻酔方法|管理区分|手技|方法|区分|全身麻酔|局所麻酔|硬膜外|脊椎麻酔)/u.test(text)) {
    helpers.push({
      topicCode: "procedure_detail_check",
      title: "手技内容確認",
      requiredInput: "麻酔方法、管理区分、実施時間、併用手技"
    });
  }
  return dedupeObjects(helpers, (helper) => helper.topicCode);
}

function reviewIssueFromSplitMultiDayText(text = "") {
  if (!hasSplitMultiDayRecordContext(text)) {
    return null;
  }
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart(["split_multi_day", normalizeClinicalText(text).slice(0, 80)].join("_"))}`,
    issueCode: "split_multi_day_review_required",
    severity: "warning",
    title: "複数日記録分割",
    messageForStaff: "複数日記録分割: 複数日の診療内容が同じカルテ本文に含まれる可能性があります。当日分と別日分を分けて確認してください。自動算定には入れていません。",
    requiredInput: "当日分の診療内容、別日分の診療内容、各診療日",
    source: "split_multi_day_guard",
    evidence: ""
  }, "split_multi_day_check");
}

function hasSplitMultiDayRecordContext(text = "") {
  const normalized = normalizeClinicalText(text);
  if (/複数日記録|複数日の診療|複数日診療|日別ケース|日別に?分割/u.test(normalized)) {
    return true;
  }
  const dates = extractClinicalDateMentions(normalized);
  return dates.length >= 2 && /(初診|再診|受診|外来|検査|処置|説明|結果)/u.test(normalized);
}

function extractClinicalDateMentions(text = "") {
  const dates = new Set();
  const normalized = normalizeClinicalText(text);
  const patterns = [
    { regex: /20(\d{2})[/-](\d{1,2})[/-](\d{1,2})/gu, monthGroup: 2, dayGroup: 3 },
    { regex: /(^|[^\d])(\d{1,2})[/-](\d{1,2})(?!\d)/gu, monthGroup: 2, dayGroup: 3 },
    { regex: /(\d{1,2})月(\d{1,2})日/gu, monthGroup: 1, dayGroup: 2 }
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern.regex)) {
      const raw = match[0].trim();
      const month = Number(match[pattern.monthGroup]);
      const day = Number(match[pattern.dayGroup]);
      const index = match.index || 0;
      const context = normalized.slice(Math.max(0, index - 16), Math.min(normalized.length, index + raw.length + 16));
      if (!isValidMonthDay(month, day) || isVitalOrRatioDateFalsePositiveContext(context)) {
        continue;
      }
      dates.add(raw.replace(/^[^\d]+/u, ""));
    }
  }
  return [...dates];
}

function isValidMonthDay(month, day) {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isVitalOrRatioDateFalsePositiveContext(text = "") {
  return isClinicalDateRatioFalsePositiveContext(text);
}

function reviewIssueFromManagementClinicalEvent(event = {}, { categoryLabel = "医学管理等" } = {}) {
  const name = clinicalEventName(event);
  const title = name ? `対象疾患確認: ${name}` : `対象疾患確認: ${categoryLabel}`;
  const policy = DERIVED_BILLING_ITEM_POLICIES.management_fee;
  const messageForStaff = `対象疾患確認: ${name || categoryLabel}は管理料・指導料に関係する記載として抽出しました。管理料確認、同月履歴確認、対象疾患、指導・説明の記録、管理主体、施設基準を人手で確認してください。自動算定には入れていません。`;
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, title, messageForStaff].join("_"))}`,
    issueCode: "management_fee_review_required",
    severity: "warning",
    title,
    messageForStaff,
    requiredInput: "対象疾患、指導・説明の記録、管理主体、施設基準、同月算定履歴",
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "management_review_gate",
    policy
  }, "target_disease_check");
}

function reviewIssuesFromClinicalWarnings(event = {}, warnings = [], { source = "clinical_event_rule" } = {}) {
  return asArray(warnings)
    .map((messageForStaff) => reviewIssueFromClinicalWarning(event, messageForStaff, { source }))
    .filter(Boolean);
}

function reviewIssueFromClinicalWarning(event = {}, messageForStaff = "", { source = "clinical_event_rule" } = {}) {
  const message = String(messageForStaff || "").trim();
  if (!message) {
    return null;
  }
  const topicCode = reviewTopicCodeFromWarning(message, event);
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), message, source].join("_"))}`,
    issueCode: reviewIssueCodeFromWarning(message, event),
    severity: "warning",
    title: reviewIssueTitleFromWarning(message, event),
    messageForStaff: message,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source
  }, topicCode);
}

function reviewIssueCodeFromWarning(message = "", event = {}) {
  const text = String(message || "");
  const status = normalizeClinicalEventStatus(event);
  if (/他科|他院/u.test(text)) return "other_provider";
  if (/過去値|持参/u.test(text)) return "past_or_carried_in";
  if (/予定|依頼|今後/u.test(text)) return "planned_not_performed";
  if (/数量|日数|総量|回数/u.test(text)) return "missing_quantity";
  if (/施設基準/u.test(text)) return "facility_unknown";
  if (["planned", "ordered", "considered"].includes(status)) return "planned_not_performed";
  if (status === "instruction_only") return "instruction_only";
  return "needs_review";
}

function reviewIssueTitleFromWarning(message = "", event = {}) {
  const text = String(message || "");
  const topic = reviewTopicDefinition(reviewTopicCodeFromWarning(text, event));
  if (topic?.label) return topic.label;
  if (/他科|他院/u.test(text)) return "他科・他院情報";
  if (/過去値|持参/u.test(text)) return "過去値・持参情報";
  if (/予定|依頼|今後/u.test(text)) return "実施確認";
  if (/数量|日数|総量|回数/u.test(text)) return "数量・日数の確認";
  if (/施設基準/u.test(text)) return "施設基準確認";
  const name = clinicalEventName(event);
  return name ? `${name}の確認` : "確認事項";
}

function normalizeReviewIssues(values = []) {
  const seen = new Set();
  const result = [];
  for (const issue of asArray(values)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const key = [
      issue.issueCode,
      issue.topicCode || "",
      issue.relatedClinicalEventId,
      normalizeReviewTarget(issue.messageForStaff || issue.title || "")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(issue);
  }
  return result.slice(0, 40);
}

function clinicalEventTypeLabel(type) {
  return {
    injection: "注射",
    rehabilitation: "リハビリ",
    surgery: "手術",
    home_care: "在宅",
    pathology: "病理",
    psychiatric: "精神科専門療法",
    emergency_time_addon: "救急・時間外加算"
  }[String(type || "").trim()] || "未対応項目";
}

async function imagingOrderFromClinicalEvent(event = {}, feeCalculator, options = {}) {
  const reviewWarnings = [];
  const procedureCodes = [];
  const kind = clinicalImagingKind(event);
  const evidence = clinicalEventEvidence(event);
  if (hasUnknownContrastContext(evidence)) {
    reviewWarnings.push("造影確認: 画像検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
  }
  if (kind === "mri") {
    const equipmentKind = clinicalEventEquipmentKind(event, "mri", options.clinicalText);
    const contrastState = localContrastState(evidence, "mri");
    const electronicState = clinicalEventElectronicImageManagementState(event, {
      clinicalText: options.clinicalText,
      imagingKind: "mri"
    });
    const order = {
      kind: "mri",
      contrast: contrastState === "present"
    };
    if (electronicState === "present") {
      order.electronic_image_management = true;
    } else if (electronicState === "unknown") {
      reviewWarnings.push("電子保存確認: MRI検査の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
    }
    if (equipmentKind) {
      order.mri_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
    }
    return {
      order,
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }
  if (kind === "ct") {
    const equipmentKind = clinicalEventEquipmentKind(event, "ct", options.clinicalText);
    const contrastState = localContrastState(evidence, "ct");
    const electronicState = clinicalEventElectronicImageManagementState(event, {
      clinicalText: options.clinicalText,
      imagingKind: "ct"
    });
    const order = {
      kind: "ct",
      contrast: contrastState === "present"
    };
    if (electronicState === "present") {
      order.electronic_image_management = true;
    } else if (electronicState === "unknown") {
      reviewWarnings.push("電子保存確認: CT検査の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
    }
    if (equipmentKind) {
      order.ct_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
    }
    return {
      order,
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }
  if (kind === "simple_radiography") {
    const contrastState = localContrastState(evidence, "ct");
    const electronicState = clinicalEventElectronicImageManagementState(event, {
      clinicalText: options.clinicalText,
      imagingKind: "simple_radiography"
    });
    reviewWarnings.push("単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。");
    if (contrastState === "unknown") {
      reviewWarnings.push("造影確認: 画像検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
    }
    if (electronicState === "unknown") {
      reviewWarnings.push("電子保存確認: 単純X線の電子保存・電子画像管理の有無がカルテ本文から確定できません。算定条件を確認してください。");
    }
    const order = {
      kind: "simple_radiography",
      acquisition_kind: "digital",
      radiography_diagnostic_kind: "simple_i"
    };
    if (electronicState === "present") {
      order.electronic_image_management = true;
    }
    return {
      order,
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }

  if (kind === "ultrasound") {
    const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
      categoryLabel: "超音波検査",
      allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event),
      unresolvedMessage: `${clinicalEventName(event) || "超音波検査"}は超音波検査として抽出しましたが、標準コードを自動確定できませんでした。部位と検査内容をマスター検索で確認してください。`,
      resolvedMessage: `${clinicalEventName(event) || "超音波検査"}を実施済みとしてマスター候補に反映しました。部位・検査方法・算定条件を確認してください。`
    });
    return {
      order: null,
      procedureCodes: procedure.procedureCodes,
      commentInputs: procedure.commentInputs,
      collectionFeeInputs: procedure.collectionFeeInputs,
      masterCandidates: procedure.masterCandidates,
      reviewWarnings: procedure.reviewWarnings,
      traceEvents: procedure.traceEvents
    };
  }

  if (kind) {
    reviewWarnings.push(`${clinicalEventName(event) || clinicalImagingDisplayName(event)}は現在の算定ルールで直接候補化できないため、要確認です。`);
  }
  return { order: null, procedureCodes, commentInputs: [], collectionFeeInputs: [], masterCandidates: [], reviewWarnings };
}

function clinicalImagingKind(event = {}) {
  const modality = String(event?.modality || "").trim();
  if (["mri", "ct", "simple_radiography", "ultrasound"].includes(modality)) {
    return modality;
  }
  const text = clinicalEventEvidence(event);
  if (/(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(text)) return "mri";
  if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(text)) return "ct";
  if (/(X線|Ｘ線|レントゲン|単純撮影)/u.test(text)) return "simple_radiography";
  if (/(超音波|エコー)/u.test(text)) return "ultrasound";
  return modality && modality !== "none" ? modality : "";
}

function clinicalImagingDisplayName(event = {}) {
  const kind = clinicalImagingKind(event);
  if (kind === "mri") return "MRI検査";
  if (kind === "ct") return "CT検査";
  if (kind === "simple_radiography") return "単純X線";
  if (kind === "ultrasound") return "超音波検査";
  return "";
}

async function medicationOrderFromClinicalEvent(event = {}, feeCalculator) {
  const reviewWarnings = [];
  const rawName = clinicalEventName(event);
  if (isMedicationNameNoise(rawName)) {
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const name = canonicalMedicationName(rawName);
  if (!name) {
    reviewWarnings.push("薬剤名がカルテ本文から確定できないため、薬剤算定候補には入れていません。");
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const quantity = medicationQuantityFromClinicalEvent(event);
  if (!hasCalculableMedicationQuantity(quantity)) {
    reviewWarnings.push(...medicationQuantityReviewWarnings(name, event, quantity));
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const medicationSearch = await searchMedicationMasterForClinicalEvent(feeCalculator, event, name);
  const item = medicationSearch.item;
  if (!item?.code) {
    reviewWarnings.push(`薬剤「${name}」をマスターコードへ解決できませんでした。`);
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const resolvedName = medicationSearch.query || name;
  return {
    order: {
      drug_code: String(item.code),
      ...quantity,
      dispensing_kind: medicationDispensingKindFromText(clinicalEventEvidence(event), resolvedName)
    },
    masterCandidates: [
      masterCandidateFromItem(item, event, {
        masterType: "drug",
        searchQuery: resolvedName
      })
    ].filter(Boolean),
    reviewWarnings
  };
}

async function searchMedicationMasterForClinicalEvent(feeCalculator, event = {}, primaryName = "") {
  const queries = uniqueStrings([
    primaryName,
    ...clinicalEventSearchQueries(event),
    ...medicationNameCandidatesFromClinicalText(clinicalEventEvidence(event)).map((candidate) => candidate.query)
  ].map(canonicalMedicationName).filter((query) => query && !isMedicationSearchCategoryNoise(query)));
  for (const query of queries) {
    const item = await searchFirstMasterItem(feeCalculator, "drug", query, "drug");
    if (item?.code) {
      return { item, query };
    }
  }
  return { item: null, query: primaryName };
}

function medicationQuantityReviewWarnings(name = "薬剤", event = {}, quantity = {}) {
  const warnings = [];
  const text = `${clinicalEventEvidence(event)} ${clinicalEventName(event)} ${name}`;
  const external = medicationDispensingKindFromText(text, name) === "external";
  if (external && !quantity.total_quantity) {
    warnings.push(`総量不足: 薬剤「${name}」は総量（例: 5g、1本、10mL）が不足しているため、算定候補には入れていません。`);
  }
  if (!external && !(quantity.quantity_per_day && quantity.days) && !quantity.total_quantity) {
    warnings.push(`薬剤日数不足: 薬剤「${name}」は日数または総量が不足しているため、算定候補には入れていません。`);
  }
  if (!warnings.length) {
    warnings.push(`薬剤日数不足: 薬剤「${name}」は数量または日数が不足しているため、算定候補には入れていません。`);
  }
  return warnings;
}

function isMedicationSearchCategoryNoise(value = "") {
  const text = String(value || "").replace(/\s+/gu, "").trim();
  if (!text) {
    return true;
  }
  return /^(?:薬剤|処方薬|外用薬|内服薬|頓服薬|院内処方|院外処方|院内外用薬|点眼薬|点鼻薬|貼付薬|塗布薬|抗菌薬|抗生剤|鎮痛薬|解熱鎮痛薬|降圧薬|スタチン|保湿剤|ステロイド軟膏)$/u.test(text);
}

function canonicalMedicationName(value) {
  let name = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .trim();
  if (!name) {
    return "";
  }
  if (isMedicationNameNoise(name)) {
    return "";
  }
  const parenthesized = name.match(/[（(]([^（）()]+)[）)]/u)?.[1];
  if (parenthesized && !/胃薬|湿布|頓服|併用|処方/u.test(parenthesized)) {
    name = parenthesized;
  }
  name = name
    .replace(/^(?:薬剤|処方薬)[:：]/u, "")
    .replace(/(?:錠|カプセル|配合錠|テープ|クリーム|軟膏|散|顆粒|シロップ).*$/u, (match) => {
      if (/^(?:錠|カプセル|配合錠|テープ|クリーム|軟膏|散|顆粒|シロップ)$/u.test(match)) {
        return match;
      }
      return "";
    })
    .replace(/\d+(?:\.\d+)?\s*(?:mg|g|μg|mcg|mL|ml|%|ｍｇ|ｇ|μｇ|ｍＬ|％).*$/iu, "")
    .replace(/[（(].*?[）)]/gu, "")
    .trim();
  return name;
}

function isMedicationNameNoise(value) {
  const text = String(value || "")
    .replace(/\s+/gu, "")
    .trim();
  if (!text) {
    return true;
  }
  return /^(?:再指導|終了|継続|増量検討|切り替え|説明|指導)$/u.test(text)
    || /指導|説明|検討|予定|予約|案内|許可|禁止|終了$/u.test(text);
}

function medicationQuantityFromClinicalEvent(event = {}) {
  const fromEvent = {
    ...(numericText(event?.total_quantity) ? { total_quantity: numericText(event.total_quantity) } : {}),
    ...(numericText(event?.quantity_per_day) ? { quantity_per_day: numericText(event.quantity_per_day) } : {}),
    ...(integerText(event?.days) ? { days: integerText(event.days) } : {})
  };
  if (hasCalculableMedicationQuantity(fromEvent)) {
    return fromEvent;
  }

  return {
    ...inferMedicationQuantity(clinicalEventEvidence(event), clinicalEventName(event)),
    ...fromEvent
  };
}

async function materialInputFromClinicalEvent(event = {}, feeCalculator) {
  const reviewWarnings = [];
  const name = clinicalEventName(event);
  if (!name) {
    reviewWarnings.push("特定器材・材料名がカルテ本文から確定できないため、算定候補には入れていません。");
    return { input: null, masterCandidates: [], reviewWarnings };
  }
  const item = await searchFirstMasterItem(feeCalculator, "material", name, "material");
  if (!item?.code) {
    reviewWarnings.push(`特定器材・材料「${name}」をマスターコードへ解決できませんでした。`);
    return { input: null, masterCandidates: [], reviewWarnings };
  }
  return {
    input: {
      code: String(item.code),
      quantity: numericText(event?.total_quantity) || numericText(event?.quantity_per_day) || "1"
    },
    masterCandidates: [
      masterCandidateFromItem(item, event, {
        masterType: "material",
        searchQuery: name
      })
    ].filter(Boolean),
    reviewWarnings
  };
}

function labCollectionFeeInputsFromClinicalEvent(event = {}, procedure = {}) {
  if (!asArray(procedure?.procedureCodes).length) {
    return [];
  }
  const inputs = [];
  if (hasExplicitBloodCollectionEvidence(event)) {
    inputs.push("blood_venous");
  }
  return uniqueStrings(inputs);
}

function hasExplicitBloodCollectionEvidence(event = {}) {
  return hasPerformedBloodCollectionEvidence({
    name: clinicalEventName(event),
    evidence: clinicalEventEvidence(event),
    specimen: event?.specimen,
    sample: event?.sample,
    collection_method: event?.collection_method,
    payload: event?.payload
  });
}

function hasCaseLevelBloodCollectionEvidenceFromText(text = "") {
  for (const sentence of splitClinicalSentences(text)) {
    if (/(前回|過去|他院|前医|持参|予定|次回|後日|必要性|必要|検討|判断|未実施|実施なし)/u.test(sentence)) {
      continue;
    }
    if (hasPerformedBloodCollectionEvidenceInText(sentence)) {
      return true;
    }
  }
  return false;
}

function labCollectionFeeReviewIssuesFromClinicalEvent(event = {}, procedure = {}) {
  if (!asArray(procedure?.procedureCodes).length) {
    return [];
  }
  if (!hasSpecimenCollectionFeeReviewEvidence(event)) {
    return [];
  }
  const name = clinicalEventName(event) || "検体検査";
  const policy = DERIVED_BILLING_ITEM_POLICIES.specimen_collection;
  return [{
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, name, "specimen_collection_fee"].join("_"))}`,
    issueCode: "specimen_collection_fee_review_required",
    severity: "warning",
    title: "検体採取確認",
    messageForStaff: `検体採取確認: ${name}に検体採取の記載があります。検体採取料は検査本体から自動算定せず、採取方法、同日算定条件、必要な親行為を確認してから採用してください。`,
    requiredInput: "検体、採取方法、同日算定条件",
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "derived_item_policy",
    policy
  }];
}

function hasSpecimenCollectionFeeReviewEvidence(event = {}) {
  if (hasExplicitBloodCollectionEvidence(event)) {
    return false;
  }
  const structured = normalizeClinicalText([
    event?.specimen,
    event?.sample,
    event?.payload?.specimen,
    event?.collection_method,
    event?.collectionMethod,
    event?.payload?.collection_method,
    event?.payload?.collectionMethod
  ].filter(Boolean).join("\n"));
  if (structured && /(?:ぬぐい|拭い|スワブ|swab|採取|穿刺|吸引)/iu.test(structured)) {
    return true;
  }
  const evidence = normalizeClinicalText(clinicalEventEvidence(event));
  return /(?:ぬぐい液|拭い液|スワブ採取|検体採取|鼻咽頭スワブ|鼻腔スワブ|咽頭スワブ|swab)/iu.test(evidence);
}

function labRuleTraceEvents(event = {}, procedure = {}) {
  const procedureCodes = asArray(procedure?.procedureCodes).map((code) => String(code || "")).filter(Boolean);
  if (!procedureCodes.length) {
    return [];
  }
  const derived = [
    {
      kind: "lab_judgment_fee",
      generatedBy: "python.lab_rules.add_d026_judgement_fees",
      reason: "検査実施料コードから検査判断料を派生します。"
    },
    {
      kind: "lab_management_fee",
      generatedBy: "python.lab_rules.add_lab_management_fee",
      reason: "判断料と施設基準が確認できる場合のみ検体検査管理加算を派生します。"
    }
  ];
  for (const input of labCollectionFeeInputsFromClinicalEvent(event, { procedureCodes })) {
    derived.push({
      kind: "collection_fee_input",
      generatedBy: "clinical_event.lab_collection_input",
      input,
      reason: collectionFeeInputTraceReason(input)
    });
  }
  if (hasSpecimenCollectionFeeReviewEvidence(event)) {
    derived.push({
      kind: "collection_fee_review",
      generatedBy: "derived_item_policy.specimen_collection",
      policy: DERIVED_BILLING_ITEM_POLICIES.specimen_collection,
      reason: "検体採取料は検査本体から自動算定せず、採取方法と算定条件をレビューに回します。"
    });
  }
  return [
    clinicalTraceEvent({
      stage: "lab_rule_expansion",
      event,
      categoryLabel: "検体検査",
      outcome: "prepared",
      message: "lab_derived_items_are_generated_by_python_rules",
      selected: {
        procedureCodes,
        derived
      }
    })
  ];
}

function collectionFeeInputTraceReason(input = "") {
  if (input === "blood_venous") {
    return "カルテに採血または血液検査の明示があるため、採血料の候補入力を渡します。";
  }
  if (input === "nasopharyngeal_swab") {
    return "カルテに鼻咽頭・鼻腔・咽頭ぬぐい等の検体採取が明示されているため、検体採取料の候補入力を渡します。";
  }
  return "カルテに検体採取が明示されているため、検体採取料の候補入力を渡します。";
}

async function procedureCodesFromPerformedClinicalEvent(event = {}, feeCalculator, options = {}) {
  const status = normalizeClinicalEventStatus(event);
  if (!isBillableClinicalEventStatus(status)) {
    const warning = excludedClinicalEventWarning(event);
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: warning ? [warning] : []
    };
  }

  const name = clinicalEventName(event);
  const categoryLabel = options.categoryLabel || "診療行為";
  if (["lab", "exam"].includes(normalizeClinicalEventType(event)) && !labEventNameSupportedByRawEvidence(event, options.clinicalText)) {
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: [`検査コード確認: ${name || categoryLabel}は検査名として抽出されましたが、カルテ本文の根拠から具体的な検査項目を確定できません。採血や検体提出だけから検査名を推定せず、検査項目を確認してください。`],
      traceEvents: [clinicalTraceEvent({
        stage: "lab_evidence_guard",
        event,
        categoryLabel,
        outcome: "review_required",
        message: "lab_name_not_supported_by_raw_evidence"
      })]
    };
  }
  const queries = clinicalEventSearchQueries(event, {
    categoryLabel,
    extraQueries: options.queries
  });
  return searchPerformedProcedureCode(feeCalculator, {
    event,
    name,
    categoryLabel,
    queries,
    allowedFeeCategories: options.allowedFeeCategories || allowedDirectRetrievalFeeCategoriesForEvent(event),
    resolvedMessage: options.resolvedMessage || `${name || categoryLabel}を実施済みの${categoryLabel}としてマスター候補に反映しました。算定条件を確認してください。`,
    unresolvedMessage: options.unresolvedMessage || `${name || categoryLabel}は実施済みの${categoryLabel}として抽出しましたが、標準コードを自動確定できませんでした。マスター検索で確認してください。`
  });
}

async function searchPerformedProcedureCode(feeCalculator, {
  event = {},
  name = "",
  categoryLabel = "診療行為",
  queries = [],
  allowedFeeCategories = null,
  resolvedMessage = "",
  unresolvedMessage = ""
} = {}) {
  if (typeof feeCalculator?.searchMaster !== "function") {
    const traceEvents = [clinicalTraceEvent({
      stage: "master_search",
      event,
      categoryLabel,
      outcome: "unavailable",
      allowedFeeCategories,
      message: "master_search_unavailable"
    })];
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、マスター検索を利用できません。`],
      traceEvents
    };
  }

  const normalizedQueries = uniqueStrings(queries).filter((query) => query.length >= 2).slice(0, 8);
  const searchTrace = [];
  for (const query of normalizedQueries) {
    const search = await searchProcedureMasterItem(feeCalculator, query, {
      name,
      categoryLabel,
      allowedFeeCategories
    });
    searchTrace.push(searchTraceSummary(query, search));
    if (search?.item?.code) {
      const item = search.item;
      if (isUnsupportedLabMasterMatchForEvent(event, item)) {
        searchTrace.push({
          query,
          outcome: "filtered",
          reason: "lab_master_concept_not_present_in_event_name",
          item: {
            code: item.code,
            name: item.name
          }
        });
        continue;
      }
      const masterCandidate = masterCandidateFromItem(item, event, {
        masterType: "medical_service",
        searchQuery: query
      });
      return {
        procedureCodes: [String(item.code)],
        commentInputs: [],
        collectionFeeInputs: [],
        masterCandidates: [masterCandidate].filter(Boolean),
        reviewWarnings: [],
        traceEvents: [
          clinicalTraceEvent({
            stage: "master_search",
            event,
            categoryLabel,
            outcome: "matched",
            allowedFeeCategories,
            query,
            selected: masterCandidate,
            searches: searchTrace
          })
        ]
      };
    }
  }

  const traceEvents = [clinicalTraceEvent({
    stage: "master_search",
    event,
    categoryLabel,
    outcome: "unresolved",
    allowedFeeCategories,
    searches: searchTrace
  })];
  return {
    procedureCodes: [],
    commentInputs: [],
    collectionFeeInputs: [],
    masterCandidates: [],
    reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、標準コードを自動確定できませんでした。`],
    traceEvents
  };
}

async function searchProcedureMasterItem(feeCalculator, query, context = {}) {
  try {
    const result = await feeCalculator.searchMaster({ type: "procedure", query, limit: 5 });
    const items = Array.isArray(result?.items) ? result.items : [];
    const candidates = items.filter((item) => (
      item?.code
      && (
        item.kind === "procedure"
        || item.sourceType === "medical_procedure_master"
        || item.source === "medical_procedure_master"
      )
    ))
      .map((item) => annotateMedicalServiceCandidate(item));
    const filteredCandidates = [];
    for (const candidate of candidates) {
      const filterReason = directRetrievalFilterReason(candidate, context);
      if (filterReason) {
        filteredCandidates.push(filteredCandidateTrace(candidate, filterReason));
        continue;
      }
      if (isHighConfidenceProcedureMasterItem(candidate, { ...context, query })) {
        return {
          item: candidate,
          inspectedCount: candidates.length,
          filteredCandidates
        };
      }
    }
    return {
      item: null,
      inspectedCount: candidates.length,
      filteredCandidates
    };
  } catch (error) {
    return {
      item: null,
      inspectedCount: 0,
      filteredCandidates: [],
      error: "master_search_failed",
      message: error instanceof Error ? error.message : String(error || "")
    };
  }
}

function isHighConfidenceProcedureMasterItem(item = {}, { query = "", name = "", categoryLabel = "" } = {}) {
  const itemText = normalizeProcedureMatchText([
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].filter(Boolean).join(" "));
  const contextText = normalizeProcedureMatchText([query, name, categoryLabel].filter(Boolean).join(" "));
  if (!itemText || !contextText) {
    return false;
  }

  const queryKey = normalizeProcedureMatchText(query);
  const nameKey = normalizeProcedureMatchText(name);
  const queryTokens = procedureMatchTokens(query);
  const nameTokens = procedureMatchTokens(name);
  return Boolean(
    (queryKey && itemText.includes(queryKey))
    || (nameKey && itemText.includes(nameKey))
    || queryTokens.some((token) => token.length >= 3 && itemText.includes(token))
    || nameTokens.some((token) => token.length >= 3 && itemText.includes(token))
  );
}

function normalizeProcedureMatchText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[（）()・、,，.\-－ー]/gu, "")
    .toLowerCase();
}

function procedureMatchTokens(value = "") {
  return normalizeProcedureMatchText(value)
    .split(/(?:検査|測定|撮影|処置|管理料|指導料|料|法|術|血液|尿|眼|鼻|耳|皮膚|腹部|胸部)/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function clinicalEventSearchQueries(event = {}, { categoryLabel = "", extraQueries = [] } = {}) {
  const name = clinicalEventName(event);
  const evidence = clinicalEventEvidence(event);
  const bodySite = String(event?.body_site || event?.bodySite || "").trim();
  const modality = String(event?.modality || "").trim();
  const deterministicTerms = [
    name,
    bodySite && name ? `${bodySite}${name}` : "",
    modality && name ? `${modality} ${name}` : "",
    ...procedureMasterQueriesFromEvidence(evidence),
    ...clinicalEventAliasQueries(event),
    categoryLabel
  ];
  // LLM search phrases are only a fallback hint. Master search should primarily
  // follow normalized clinical-event attributes and evidence-derived terms.
  const llmHints = [
    ...(event?.search_terms?.primary ? [event.search_terms.primary] : []),
    ...asArray(event?.search_terms?.synonyms),
    ...(event?.searchTerms?.primary ? [event.searchTerms.primary] : []),
    ...asArray(event?.searchTerms?.synonyms),
    ...asArray(event?.searchQueries),
    ...asArray(event?.search_queries)
  ];
  return filterClinicalEventSearchQueries(event, uniqueStrings([
    ...asArray(extraQueries),
    ...deterministicTerms,
    ...llmHints
  ]));
}

function filterClinicalEventSearchQueries(event = {}, queries = []) {
  const type = normalizeClinicalEventType(event);
  if (!["lab", "exam"].includes(type)) {
    return uniqueStrings(queries);
  }
  const nameConceptKeys = new Set(labConceptsFromClinicalEventName(event).map((concept) => concept.key));
  return uniqueStrings(queries).filter((query) => {
    const queryConcepts = labConceptsFromText(query);
    if (!queryConcepts.length) {
      return true;
    }
    return queryConcepts.some((concept) => nameConceptKeys.has(concept.key));
  });
}

function isUnsupportedLabMasterMatchForEvent(event = {}, item = {}) {
  const type = normalizeClinicalEventType(event);
  if (!["lab", "exam"].includes(type)) {
    return false;
  }
  const nameConceptKeys = new Set(labConceptsFromClinicalEventName(event).map((concept) => concept.key));
  const itemConcepts = labConceptsFromText([
    item?.name,
    item?.masterName,
    item?.normalizedName
  ].filter(Boolean).join(" "));
  if (!itemConcepts.length) {
    return false;
  }
  return !itemConcepts.some((concept) => nameConceptKeys.has(concept.key));
}

function clinicalEventAliasQueries(event = {}) {
  const type = normalizeClinicalEventType(event);
  if (type === "lab" || type === "exam") {
    return labAliasQueries(event);
  }
  if (type === "imaging") {
    return imagingAliasQueries(event);
  }
  return [];
}

export function buildClinicalChecklistMenu(text = "") {
  const clinicalOnlyText = splitClinicalSentences(text)
    .filter((sentence) => !isClinicalMetaSentence(sentence))
    .join("\n");
  const normalized = normalizeClinicalText(clinicalOnlyText);
  const menu = [];
  const addMenu = (item = {}) => {
    const menuId = String(item.menuId || "").trim();
    const label = String(item.label || item.name || "").trim();
    if (!menuId || !label || menu.some((existing) => existing.menuId === menuId)) {
      return;
    }
    menu.push({
      menuId,
      label,
      kind: item.kind || item.eventType || "other",
      eventType: item.eventType || item.kind || "other",
      billingDomain: item.billingDomain || "unknown",
      name: item.name || label,
      query: item.query || item.name || label,
      searchQueries: uniqueStrings(asArray(item.searchQueries)),
      modality: item.modality || "none",
      conceptKey: item.conceptKey || ""
    });
  };

  for (const concept of labConceptsFromText(normalized)) {
    addMenu({
      menuId: `lab:${concept.key}`,
      label: concept.name,
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: concept.name,
      query: concept.query,
      searchQueries: [concept.query, ...concept.aliases],
      conceptKey: concept.key
    });
  }

  for (const rapid of rapidLabChecklistItems(normalized)) {
    addMenu(rapid);
  }

  if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(normalized)) {
    addMenu({
      menuId: "imaging:ct",
      label: "CT",
      kind: "imaging",
      eventType: "imaging",
      billingDomain: "standard_imaging",
      name: "CT",
      query: "ＣＴ撮影",
      searchQueries: ["ＣＴ撮影"],
      modality: "ct"
    });
  }
  if (/(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(normalized)) {
    addMenu({
      menuId: "imaging:mri",
      label: "MRI",
      kind: "imaging",
      eventType: "imaging",
      billingDomain: "standard_imaging",
      name: "MRI",
      query: "ＭＲＩ撮影",
      searchQueries: ["ＭＲＩ撮影"],
      modality: "mri"
    });
  }
  if (/(X線|Ｘ線|レントゲン|単純撮影)/u.test(normalized)) {
    addMenu({
      menuId: "imaging:simple_radiography",
      label: "単純X線",
      kind: "imaging",
      eventType: "imaging",
      billingDomain: "standard_imaging",
      name: "単純X線",
      query: "単純撮影",
      searchQueries: ["単純撮影", "Ｘ線"],
      modality: "simple_radiography"
    });
  }
  if (/(超音波|エコー)/u.test(normalized)) {
    addMenu({
      menuId: "imaging:ultrasound",
      label: "超音波検査",
      kind: "imaging",
      eventType: "imaging",
      billingDomain: "standard_imaging",
      name: "超音波検査",
      query: "超音波検査",
      searchQueries: ["超音波検査"],
      modality: "ultrasound"
    });
  }

  if (/(特定器材|材料|医療材料|ガーゼ|創傷被覆材|被覆材|シーネ|コルセット|カテーテル|チューブ)/u.test(normalized)) {
    addMenu({
      menuId: "material:medical_material",
      label: "特定器材・材料",
      kind: "material",
      eventType: "material",
      billingDomain: "standard_material",
      name: "特定器材・材料",
      query: "特定器材 材料"
    });
  }

  for (const domain of reviewOnlyDomainChecklistItems(normalized)) {
    addMenu(domain);
  }

  return menu.slice(0, 30);
}

function rapidLabChecklistItems(text = "") {
  const items = [];
  const hasCovid = /COVID|SARS|コロナ|新型コロナ/u.test(text);
  const hasInfluenza = /インフル|influenza|flu/u.test(text);
  const hasRapidOrAntigen = /迅速|抗原|定性|Ag/u.test(text);
  if (hasCovid && hasInfluenza && hasRapidOrAntigen) {
    items.push({
      menuId: "lab:covid_flu_antigen",
      label: "新型コロナ・インフル抗原同時検査",
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: "新型コロナ・インフル抗原同時検査",
      query: "ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性",
      searchQueries: ["ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性"]
    });
  } else if (hasCovid && hasRapidOrAntigen) {
    items.push({
      menuId: "lab:covid_antigen",
      label: "新型コロナ抗原検査",
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: "新型コロナ抗原検査",
      query: "ＳＡＲＳ－ＣｏＶ－２抗原検出",
      searchQueries: ["ＳＡＲＳ－ＣｏＶ－２抗原検出"]
    });
  } else if (hasInfluenza && hasRapidOrAntigen) {
    items.push({
      menuId: "lab:influenza_antigen",
      label: "インフルエンザ抗原検査",
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: "インフルエンザ抗原検査",
      query: "インフルエンザウイルス抗原定性",
      searchQueries: ["インフルエンザウイルス抗原定性"]
    });
  }
  if (/溶連菌|A群|strep/u.test(text)) {
    items.push({
      menuId: "lab:group_a_strep_rapid",
      label: "A群β溶連菌迅速検査",
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: "A群β溶連菌迅速検査",
      query: "Ａ群β溶連菌迅速試験定性",
      searchQueries: ["Ａ群β溶連菌迅速試験定性", "溶連菌迅速検査"]
    });
  }
  return items;
}

function reviewOnlyDomainChecklistItems(text = "") {
  const definitions = [
    { domain: "surgery", label: "手術", pattern: /手術|術式|切除術|縫合術|手術同意|手術説明/u },
    { domain: "anesthesia", label: "麻酔", pattern: /麻酔|術前診察|麻酔科|全身麻酔|局所麻酔/u },
    { domain: "pathology", label: "病理診断・細胞診", pattern: /病理|細胞診|組織診|標本|生検/u },
    { domain: "rehabilitation", label: "リハビリテーション", pattern: /リハビリ|運動器リハ|脳血管リハ|廃用症候群リハ|実施単位/u },
    { domain: "home_care", label: "在宅医療", pattern: /在宅医療|訪問診療|往診|在宅自己注射|在宅酸素/u },
    { domain: "psychiatry_special", label: "精神科専門療法", pattern: /精神科専門療法|通院精神療法|精神療法|認知行動療法/u },
    { domain: "endoscopy", label: "内視鏡", pattern: /内視鏡|胃カメラ|大腸カメラ|上部消化管内視鏡|下部消化管内視鏡/u },
    { domain: "dialysis", label: "透析", pattern: /透析|血液透析|腹膜透析/u },
    { domain: "transfusion", label: "輸血", pattern: /輸血|赤血球液|血小板製剤|血漿/u },
    { domain: "radiation_therapy", label: "放射線治療", pattern: /放射線治療|照射|線量/u },
    { domain: "emergency_time_addon", label: "救急・時間外加算", pattern: /救急加算|時間外加算|休日加算|深夜加算|受付時刻/u }
  ];
  return definitions
    .filter((definition) => definition.pattern.test(text))
    .map((definition) => ({
      menuId: `domain:${definition.domain}`,
      label: definition.label,
      kind: "domain",
      eventType: ["pathology", "emergency_time_addon"].includes(definition.domain) ? definition.domain : "other",
      billingDomain: definition.domain,
      name: definition.label,
      query: definition.label
    }));
}

function labAliasQueries(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    ...asArray(event?.payload?.pathogenTargets),
    event?.payload?.method,
    event?.payload?.specimen
  ].filter(Boolean).join(" "));
  const queries = [];
  for (const concept of labConceptsFromText(text)) {
    queries.push(concept.query, ...concept.aliases);
  }

  const hasCovid = /COVID|ＣＯＶＩＤ|SARS|ＳＡＲＳ|コロナ|新型コロナ/u.test(text);
  const hasInfluenza = /インフル|influenza|ＩＮＦＬＵＥＮＺＡ|flu|ＦＬＵ/u.test(text);
  const hasRapidOrAntigen = /迅速|抗原|定性|Ag|Ａｇ/u.test(text);
  if (hasCovid && hasInfluenza) {
    queries.push("ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性");
    queries.push("新型コロナ インフルエンザ 抗原同時検出");
  } else if (hasCovid && hasRapidOrAntigen) {
    queries.push("ＳＡＲＳ－ＣｏＶ－２抗原検出");
  } else if (hasInfluenza && hasRapidOrAntigen) {
    queries.push("インフルエンザウイルス抗原定性");
  }

  if (/溶連菌|A群|Ａ群|strep|ＳＴＲＥＰ/u.test(text)) {
    queries.push("Ａ群β溶連菌迅速試験定性");
    queries.push("溶連菌迅速検査");
  }
  return uniqueStrings(queries);
}

const LAB_CONCEPT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "urine_general",
    name: "尿一般",
    query: "尿一般",
    aliases: ["尿中一般物質定性半定量検査", "尿定性"],
    pattern: /尿一般|尿定性|尿中一般物質|尿検査/u
  }),
  Object.freeze({
    key: "urine_protein",
    name: "尿蛋白",
    query: "尿蛋白",
    aliases: ["蛋白尿"],
    pattern: /尿蛋白|蛋白尿|尿.*蛋白/u
  }),
  Object.freeze({
    key: "crp",
    name: "ＣＲＰ",
    query: "ＣＲＰ",
    aliases: ["C反応性蛋白", "Ｃ反応性蛋白"],
    pattern: /\bCRP\b|ＣＲＰ|C反応性蛋白|Ｃ反応性蛋白/u
  }),
  Object.freeze({
    key: "cbc",
    name: "末梢血液一般検査",
    query: "末梢血液一般検査",
    aliases: ["血算", "ＣＢＣ"],
    pattern: /CBC|ＣＢＣ|血算|末梢血液一般|血球計算|白血球|赤血球|血小板/u
  }),
  Object.freeze({
    key: "glucose",
    name: "グルコース",
    query: "グルコース",
    aliases: ["血糖"],
    pattern: /グルコース|血糖/u
  }),
  Object.freeze({
    key: "hba1c",
    name: "ＨｂＡ１ｃ",
    query: "ＨｂＡ１ｃ",
    aliases: ["HbA1c"],
    pattern: /HbA1c|ＨｂＡ１ｃ/u
  }),
  Object.freeze({
    key: "tcho",
    name: "Ｔｃｈｏ",
    query: "Ｔｃｈｏ",
    aliases: ["総コレステロール"],
    pattern: /Tcho|Ｔｃｈｏ|総コレステロール|総コレステ/u
  }),
  Object.freeze({
    key: "ldl",
    name: "ＬＤＬ－コレステロール",
    query: "ＬＤＬ－コレステロール",
    aliases: ["LDL"],
    pattern: /\bLDL\b|ＬＤＬ/u
  }),
  Object.freeze({
    key: "tg",
    name: "ＴＧ",
    query: "ＴＧ",
    aliases: ["中性脂肪"],
    pattern: /\bTG\b|ＴＧ|中性脂肪/u
  }),
  Object.freeze({
    key: "creatinine",
    name: "クレアチニン",
    query: "クレアチニン",
    aliases: ["Cr"],
    pattern: /クレアチニン|(?:^|[^\p{L}])Cr(?:$|[^\p{L}])/u
  })
]);

function labConceptsFromClinicalEventName(event = {}) {
  const text = normalizeClinicalText(clinicalEventName(event));
  return labConceptsFromText(text);
}

function labConceptsFromText(text = "") {
  const normalized = normalizeClinicalText(text);
  const concepts = [];
  for (const concept of LAB_CONCEPT_DEFINITIONS) {
    if (concept.pattern.test(normalized)) {
      concepts.push(concept);
    }
  }
  return concepts;
}

function labEventNameSupportedByRawEvidence(event = {}, clinicalText = "") {
  const nameConcepts = labConceptsFromClinicalEventName(event);
  const nameConceptKeys = new Set(nameConcepts.map((concept) => concept.key));
  const queryConceptKeys = new Set(labConceptsFromText([
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries),
    event?.search_terms?.primary,
    ...asArray(event?.search_terms?.synonyms),
    event?.searchTerms?.primary,
    ...asArray(event?.searchTerms?.synonyms)
  ].filter(Boolean).join(" ")).map((concept) => concept.key));
  const unsupportedQueryConcepts = [...queryConceptKeys].filter((key) => !nameConceptKeys.has(key));
  if (unsupportedQueryConcepts.length) {
    return false;
  }
  if (!nameConcepts.length) {
    return true;
  }
  const eventEvidence = normalizeClinicalText([
    event?.evidence
  ].filter(Boolean).join(" "));
  if (eventEvidence && nameConcepts.some((concept) => labConceptAppearsInPerformedClinicalSentence(eventEvidence, concept))) {
    return true;
  }
  return nameConcepts.some((concept) => labConceptAppearsInPerformedClinicalSentence(clinicalText, concept));
}

function labConceptAppearsInPerformedClinicalSentence(text = "", concept = {}) {
  if (!concept?.pattern) {
    return false;
  }
  for (const sentence of splitClinicalSentences(text)) {
    const normalized = normalizeClinicalText(sentence);
    if (!normalized || isClinicalMetaSentence(normalized)) {
      continue;
    }
    if (
      isFutureOrOrderOnlyContext(normalized)
      || isNegatedClinicalServiceContext(normalized)
      || isPastOrExternalLabReferenceContext(normalized)
    ) {
      continue;
    }
    if (!concept.pattern.test(normalized)) {
      continue;
    }
    if (hasPerformedLabContext(normalized) || hasLabResultContext(normalized, concept)) {
      return true;
    }
  }
  return false;
}

function isClinicalMetaSentence(sentence = "") {
  return SYNTHETIC_CLINICAL_META_SENTENCE_PATTERN.test(String(sentence || ""));
}

function isPastOrExternalLabReferenceContext(sentence = "") {
  const text = normalizeClinicalText(sentence);
  return /(前回|先月|以前|過去|過去値|既知値|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|内科で|外来で確認済み)/u.test(text);
}

function hasPerformedLabContext(sentence = "") {
  const text = normalizeClinicalText(sentence);
  return /(実施|施行|行った|行い|検査した|測定した|測定|採取した|提出した|検体提出|検査結果|結果)/u.test(text);
}

function hasLabResultContext(sentence = "", concept = {}) {
  const text = normalizeClinicalText(sentence);
  if (!concept?.pattern?.test(text)) {
    return false;
  }
  return /[:：＝=]|陽性|陰性|正常|異常なし|高値|低値|\d+(?:\.\d+)?\s*(?:mg\/dL|U\/mL|%|％|\/μL|\/uL|mL\/min|IU\/mL)/iu.test(text);
}

function imagingAliasQueries(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.payload?.bodySite,
    event?.body_site,
    event?.bodySite,
    event?.modality
  ].filter(Boolean).join(" "));
  const queries = [];
  if (/眼軸長|IOL|ＩＯＬ|眼内レンズ度数/u.test(text)) {
    queries.push("光学的眼軸長測定");
  }
  if (/細隙灯|スリット/u.test(text)) {
    queries.push("スリットＭ");
  }
  if (/眼底/u.test(text)) {
    queries.push("精密眼底検査");
  }
  if (/視野/u.test(text)) {
    queries.push("精密視野検査");
  }
  if (/眼圧/u.test(text)) {
    queries.push("精密眼圧測定");
  }
  return uniqueStrings(queries);
}

function procedureMasterQueriesFromEvidence(evidence = "") {
  const queries = [];
  const text = normalizeClinicalText(evidence);
  for (const sentence of splitClinicalSentences(text)) {
    const head = sentence.split(/[:：]/u)[0]?.trim();
    if (head && head.length >= 2 && head.length <= 40) {
      queries.push(head);
    }
    for (const match of sentence.matchAll(/([一-龥ァ-ヶーA-Za-z0-9]{2,30}(?:検査|測定|撮影|処置|管理料|指導料|計算|テスト|スクリーニング))/gu)) {
      queries.push(match[1]);
    }
  }
  return uniqueStrings(queries);
}

async function searchFirstMasterItem(feeCalculator, type, query, expectedKind) {
  try {
    const result = await feeCalculator.searchMaster({ type, query, limit: 5 });
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.find((item) => item?.kind === expectedKind && item.code)
      || items.find((item) => item?.code)
      || null;
  } catch {
    return null;
  }
}

function splitClinicalSentences(text) {
  return normalizeClinicalText(text)
    .split(/[\n。]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function objectiveClinicalText(text) {
  const lines = normalizeClinicalText(text)
    .split("\n")
    .map((line) => line.trim());
  const objectiveLines = [];
  let inObjective = false;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (isObjectiveSectionHeading(line)) {
      inObjective = true;
      const inline = line.replace(/^O(?:bjective)?\s*[（(：:「\-\s]*(?:Objective)?[^）)：:]*[）):：]?\s*/iu, "").trim();
      if (inline && inline !== line && !isClinicalSectionHeading(inline)) {
        objectiveLines.push(inline);
      }
      continue;
    }
    if (inObjective && isClinicalSectionHeading(line)) {
      break;
    }
    if (inObjective) {
      objectiveLines.push(line);
    }
  }

  return objectiveLines.join("\n").trim();
}

function isObjectiveSectionHeading(line) {
  const text = String(line || "").trim();
  return /^(?:O|Objective)\b/iu.test(text)
    || /^O[（(：:]/iu.test(text)
    || /客観的情報/u.test(text);
}

function isClinicalSectionHeading(line) {
  const text = String(line || "").trim();
  return /^(?:S|Subjective|A|Assessment|P|Plan)\b/iu.test(text)
    || /^[SAP][（(：:]/iu.test(text)
    || /(主観的情報|評価|計画)/u.test(text);
}

function isPerformedImagingContext(sentence, kind) {
  if (/(施行|実施|撮影済み|撮影|確認|所見|正面|側面|結果|あり|認める|狭小化|骨棘)/u.test(sentence)) {
    return true;
  }
  if (kind === "simple_radiography" && /(X線|Ｘ線|レントゲン)/u.test(sentence)) {
    return true;
  }
  return false;
}

function isFutureOrOrderOnlyContext(sentence) {
  return /(\d+\s*(?:日|週間|週|か月|カ月|ヶ月|ケ月|月)後|予定|次回|後日|紹介|持参|検討|依頼|オーダー|予約|後で|今後)/u.test(sentence);
}

function isCurrentVisitEvidence(sentence) {
  return /(本日|今回|当日|外来|来院|受診|診察|診療|継続診療|定期受診|再来)/u.test(sentence);
}

function isNegatedContext(sentence) {
  return /(なし|無し|否定|未実施|行わず|施行せず|撮影せず|中止)/u.test(sentence);
}

function isNegatedClinicalServiceContext(sentence) {
  return /(未実施|行わず|施行せず|撮影せず|検査せず|撮影なし|検査なし|中止)/u.test(sentence);
}

function hasLocalContrastContext(sentence, kind) {
  return localContrastState(sentence, kind) === "present";
}

function localContrastState(sentence, kind) {
  const text = normalizeClinicalText(sentence);
  if (/(造影なし|造影無し|非造影|単純(?:CT|ＣＴ|MRI|ＭＲＩ))/u.test(text)) {
    return "absent";
  }
  if (/(造影有無|造影の有無|造影.*確認|造影.*未確定|造影.*不明|造影.*要確認)/u.test(text)) {
    return "unknown";
  }
  const modality = kind === "mri" ? "(?:MRI|ＭＲＩ)" : "(?:CT|ＣＴ)";
  if (new RegExp(`(?:造影.{0,12}${modality}|${modality}.{0,12}造影|造影剤使用|造影剤投与)`, "u").test(text)) {
    return "present";
  }
  if (/造影/u.test(text) && /(検査|撮影|画像|確認|有無)/u.test(text)) {
    return "unknown";
  }
  return "absent";
}

function hasUnknownContrastContext(sentence) {
  return localContrastState(sentence, "ct") === "unknown" || localContrastState(sentence, "mri") === "unknown";
}

function clinicalEventElectronicImageManagementState(event = {}, options = {}) {
  const explicitValues = [
    event?.electronic_image_management,
    event?.electronicImageManagement,
    event?.payload?.electronic_image_management,
    event?.payload?.electronicImageManagement
  ];
  for (const value of explicitValues) {
    if (value === true || value === "true" || value === "present" || value === "yes") {
      return "present";
    }
    if (value === false || value === "false" || value === "absent" || value === "no") {
      return "absent";
    }
  }
  const textState = electronicImageManagementStateForKindInText(options.clinicalText, options.imagingKind);
  if (textState) {
    return textState;
  }
  return localElectronicImageManagementState(clinicalEventEvidence(event));
}

function electronicImageManagementStateForKindInText(text = "", imagingKind = "") {
  if (!text || !imagingKind) {
    return "";
  }
  const objectiveText = objectiveClinicalText(text) || text;
  for (const sentence of splitClinicalSentences(objectiveText)) {
    if (isFutureOrOrderOnlyContext(sentence) || isNegatedClinicalServiceContext(sentence)) {
      continue;
    }
    if (!sentenceMatchesImagingKind(sentence, imagingKind)) {
      continue;
    }
    if (!/(電子|フィルム|紙焼き)/u.test(sentence)) {
      continue;
    }
    const state = localElectronicImageManagementState(sentence);
    if (state === "present" || state === "unknown" || state === "absent") {
      return state;
    }
  }
  if (sentenceMatchesImagingKind(objectiveText, imagingKind) && /(電子|フィルム|紙焼き)/u.test(objectiveText)) {
    const state = localElectronicImageManagementState(objectiveText);
    if (state === "present" || state === "unknown" || state === "absent") {
      return state;
    }
  }
  return "";
}

function sentenceMatchesImagingKind(sentence = "", imagingKind = "") {
  const text = normalizeClinicalText(sentence);
  if (imagingKind === "ct") {
    return /(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(text);
  }
  if (imagingKind === "mri") {
    return /(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(text);
  }
  if (imagingKind === "simple_radiography") {
    return /(X線|Ｘ線|レントゲン|単純撮影)/u.test(text);
  }
  return false;
}

function localElectronicImageManagementState(sentence = "") {
  const text = normalizeClinicalText(sentence);
  if (!/電子/u.test(text)) {
    return "absent";
  }
  if (/(?:電子画像管理|電子保存|電子的保存|電子.*管理)(?:は|を|が|の)?(?:なし|無し|行わず|未実施)|(?:なし|無し|行わず|未実施).{0,8}(?:電子画像管理|電子保存|電子的保存|電子.*管理)|(?:フィルム|紙焼き).{0,12}(?:保存|管理)/u.test(text)) {
    return "absent";
  }
  if (/(電子画像管理あり|電子保存あり|電子的に保存(?:した|済み)?|電子保存・管理あり|電子.*保存.*管理(?:あり|済み|した)|電子.*管理.*保存(?:あり|済み|した))/u.test(text)) {
    return "present";
  }
  if (/(電子画像管理|電子保存|電子的保存|電子.*管理).{0,24}(?:確認|有無|未確定|不明|必要|要確認)|(?:確認|有無|未確定|不明|必要|要確認).{0,24}(?:電子画像管理|電子保存|電子的保存|電子.*管理)/u.test(text)) {
    return "unknown";
  }
  return "unknown";
}

function isCurrentPrescriptionContext(sentence) {
  if (isNegatedContext(sentence)) {
    return false;
  }
  return /(処方|投与|開始|追加|併用|毎食|分処方|日分|貼付|塗布)/u.test(sentence);
}

function isHistoricalMedicationContext(sentence) {
  return /(既往|内服中|持参薬|常用|継続中|服用中|既に|以前から|アレルギー)/u.test(sentence);
}

function isCurrentMaterialUseContext(sentence) {
  if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
    return false;
  }
  if (/(指導|説明|検討|予定)/u.test(sentence)) {
    return false;
  }
  return /(使用|装着|貼付|保護|交換|処置|材料)/u.test(sentence);
}

function mergeCalculationOptions(existing = {}, inferred = {}) {
  const result = isPlainObject(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(inferred || {})) {
    if (Array.isArray(value)) {
      result[key] = uniqueObjects([...(Array.isArray(result[key]) ? result[key] : []), ...value]);
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = { ...value, ...(isPlainObject(result[key]) ? result[key] : {}) };
      continue;
    }
    if (!hasOwn(result, key)) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeClinicalInferredOptions(options = {}) {
  if (!isPlainObject(options)) {
    return {};
  }
  const result = { ...options };
  if (Array.isArray(result.procedure_codes)) {
    result.procedure_codes = uniqueStrings(result.procedure_codes);
  }
  if (Array.isArray(result.imaging_orders)) {
    result.imaging_orders = mergeImagingOrders(result.imaging_orders);
  }
  if (Array.isArray(result.treatment_orders)) {
    result.treatment_orders = dedupeObjects(result.treatment_orders);
  }
  if (Array.isArray(result.medication_orders)) {
    result.medication_orders = dedupeObjects(result.medication_orders, (item) => item?.drug_code || JSON.stringify(item));
  }
  if (Array.isArray(result.material_inputs)) {
    result.material_inputs = dedupeObjects(result.material_inputs, (item) => item?.code || JSON.stringify(item));
  }
  if (Array.isArray(result.comment_inputs)) {
    result.comment_inputs = dedupeObjects(result.comment_inputs, (item) => item?.code || item?.text || JSON.stringify(item));
  }
  if (isPlainObject(result.lab_options) && Array.isArray(result.lab_options.collection_fee_inputs)) {
    result.lab_options = {
      ...result.lab_options,
      collection_fee_inputs: uniqueStrings(result.lab_options.collection_fee_inputs)
    };
  }
  return result;
}

function mergeImagingOrders(orders = []) {
  const result = [];
  for (const order of asArray(orders)) {
    if (!isPlainObject(order)) {
      continue;
    }
    const kind = String(order.kind || "").trim();
    const existing = kind
      ? result.find((item) => String(item.kind || "").trim() === kind && !imagingOrdersConflict(item, order))
      : null;
    if (!existing) {
      const copy = { ...order };
      result.push(copy);
      continue;
    }
    for (const [field, value] of Object.entries(order)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (!hasOwn(existing, field) || existing[field] === undefined || existing[field] === null || existing[field] === "") {
        existing[field] = value;
        continue;
      }
    }
  }
  return dedupeObjects(result);
}

function imagingOrdersConflict(left = {}, right = {}) {
  const fields = [
    "contrast",
    "electronic_image_management",
    "ct_equipment_kind",
    "mri_equipment_kind",
    "acquisition_kind",
    "radiography_diagnostic_kind"
  ];
  return fields.some((field) => {
    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue === undefined || leftValue === null || leftValue === "") {
      return false;
    }
    if (rightValue === undefined || rightValue === null || rightValue === "") {
      return false;
    }
    return leftValue !== rightValue;
  });
}

function manualCalculationOptions(session = {}, calculationInput = {}) {
  if (isPlainObject(calculationInput.calculationOptions)) {
    return calculationInput.calculationOptions;
  }
  if (!isPlainObject(session.calculationOptions)) {
    return {};
  }

  const source = String(session.calculationOptionsSource || "").trim();
  if (source === "manual") {
    return session.calculationOptions;
  }

  const autoKeys = calculationOptionsAutoKeys(session);
  if (autoKeys.length) {
    return omitCalculationOptionKeys(session.calculationOptions, autoKeys);
  }

  if (source === "clinical_auto") {
    return {};
  }

  if (normalizeClinicalText(session.clinicalText)) {
    return omitCalculationOptionKeys(session.calculationOptions, [...CLINICAL_AUTO_OPTION_KEYS]);
  }

  return session.calculationOptions;
}

function calculationOptionsAutoKeys(session = {}) {
  if (Array.isArray(session.calculationOptionsAutoKeys)) {
    return session.calculationOptionsAutoKeys.map((key) => String(key || "").trim()).filter(Boolean);
  }
  return [];
}

function omitCalculationOptionKeys(options = {}, keys = []) {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !omitted.has(key))
  );
}

function calculationOptionsSource(manualOptions = {}, autoKeys = []) {
  const hasManual = Object.keys(manualOptions).length > 0;
  const hasAuto = autoKeys.length > 0;
  if (hasManual && hasAuto) {
    return "manual_with_clinical_auto";
  }
  if (hasManual) {
    return "manual";
  }
  if (hasAuto) {
    return "clinical_auto";
  }
  return null;
}

function dedupeObjects(values = [], keyFn = (item) => JSON.stringify(item)) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueObjects(values = []) {
  return dedupeObjects(values);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeReviewWarnings(values = []) {
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    const warning = cleanReviewWarning(raw);
    if (!warning || isLowValueClinicalReviewWarning(warning)) {
      continue;
    }
    const key = reviewWarningDedupKey(warning);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(warning);
  }
  return result
    .slice(0, 20);
}

function cleanReviewWarning(value) {
  let warning = String(value || "").trim();
  if (!warning) {
    return "";
  }
  warning = warning.replace(/\s+/gu, " ");
  if (/Lab management fee skipped: facility_standard_not_found|facility_standard_not_found/u.test(warning)) {
    return "施設基準確認: 検体検査管理加算の届出確認が必要です。施設基準が登録されていないため、検体検査管理加算は自動追加していません。";
  }
  warning = warning.replace(/^(?:hospital_profile_missing|facility_standard_not_found)\s*[:：]\s*/u, "");
  warning = warning.replace(/薬剤「([^」]+)」/gu, (match, name) => {
    const canonical = canonicalMedicationName(name);
    return canonical ? `薬剤「${canonical}」` : match;
  });
  return isActionableClinicalFactWarning(warning) ? warning : "";
}

function reviewWarningDedupKey(warning) {
  const procedureCode = warning.match(/\b(\d{6,})\b/u)?.[1];
  if (procedureCode) {
    return `procedure:${procedureCode}:${reviewWarningReasonKey(warning)}`;
  }
  const medication = warning.match(/薬剤「([^」]+)」/u)?.[1];
  if (medication) {
    return `medication:${canonicalMedicationName(medication)}:${reviewWarningReasonKey(warning)}`;
  }
  if (/施設基準/u.test(warning)) {
    return `facility:${reviewWarningReasonKey(warning)}`;
  }
  const planned = warning.match(/^(.+?)は予定・依頼/u)?.[1];
  if (planned) {
    return `planned:${normalizeReviewTarget(planned)}`;
  }
  const unsupported = warning.match(/^(.+?)は(?:実施済みの)?(?:検体検査|超音波検査|医学管理等|指導・説明|.+?)として/u)?.[1];
  if (unsupported) {
    return `unsupported:${normalizeReviewTarget(unsupported)}:${reviewWarningReasonKey(warning)}`;
  }
  const basic = warning.match(/(初診|再診|受診履歴|過去算定記録)/u)?.[1];
  if (basic) {
    return `visit:${reviewWarningReasonKey(warning)}`;
  }
  return warning;
}

function normalizeReviewTarget(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[「」『』（）()]/gu, "")
    .toLowerCase();
}

function reviewWarningReasonKey(warning) {
  if (/(数量|日数|総量|回数).*(不足|不明|明記なし)/u.test(warning)) {
    return "quantity_missing";
  }
  if (/(予定|依頼|オーダー|次回|今後)/u.test(warning)) {
    return "planned_only";
  }
  if (/(未対応|コード確定|自動確定|標準コード|直接候補化できない)/u.test(warning)) {
    return "unsupported";
  }
  if (/施設基準/u.test(warning)) {
    return "facility_standard";
  }
  if (/(初診|再診|受診履歴|過去算定記録)/u.test(warning)) {
    return "visit_history";
  }
  return normalizeReviewTarget(warning).slice(0, 80);
}

function isLowValueClinicalReviewWarning(warning) {
  return !String(warning || "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numericText(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .match(/\d+(?:\.\d+)?/u)?.[0];
  return normalized || "";
}

function integerText(value) {
  const normalized = numericText(value);
  if (!normalized) return "";
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return "";
  return String(Math.round(number));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(Object(object), key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateIdPart(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "item";
}
