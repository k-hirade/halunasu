import {
  FEE_CLINICAL_FACTS_PROMPT_VERSION,
  extractFeeClinicalFactsWithOpenAi
} from "../../../packages/medical-core/src/fee/openai-fee-clinical-facts.js";
import {
  clinicalAutoCalculationOptionKeys,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  isClinicalDateRatioFalsePositiveContext
} from "../../../packages/fee-contracts/src/index.js";
import {
  FEE_CONCEPT_REGISTRY_VERSION,
  LAB_CONCEPT_DEFINITIONS,
  LAB_CONCEPT_GROUP_DEFINITIONS,
  PROCEDURE_CHECKLIST_DEFINITIONS,
  REVIEW_ONLY_DOMAIN_CHECKLIST_DEFINITIONS
} from "./clinical-concept-registry.js";

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

const CLINICAL_AUTO_OPTION_KEYS = new Set(clinicalAutoCalculationOptionKeys);

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

export const FEE_CLINICAL_RULE_SET_VERSION = "fee-clinical-rules-v10";

const REVIEW_TOPIC_TAXONOMY = Object.freeze({
  visit_type_check: Object.freeze({
    label: "初診/再診確認",
    issueCode: "visit_type_unknown"
  }),
  same_day_duplicate_check: Object.freeze({
    label: "同日重複確認",
    issueCode: "same_day_duplicate_unknown"
  }),
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
  monthly_lab_duplicate_check: Object.freeze({
    label: "同月内検査確認",
    issueCode: "same_month_lab_unknown"
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
  equipment_kind_check: Object.freeze({
    label: "機器区分確認",
    issueCode: "equipment_kind_unknown"
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
  procedure_site_check: Object.freeze({
    label: "処置部位確認",
    issueCode: "procedure_site_unknown"
  }),
  care_plan_check: Object.freeze({
    label: "療養計画確認",
    issueCode: "care_plan_unknown"
  }),
  injection_route_check: Object.freeze({
    label: "注射経路確認",
    issueCode: "injection_route_unknown"
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
  evidence_verification_check: Object.freeze({
    label: "根拠確認",
    issueCode: "evidence_verification_required"
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
  medication_delivery_check: Object.freeze({
    label: "院内外処方確認",
    issueCode: "medication_delivery_unknown"
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

const SINGLETON_REVIEW_TOPIC_CODES = new Set([
  "target_disease_check",
  "care_plan_check",
  "visit_type_check",
  "same_day_duplicate_check",
  "monthly_lab_duplicate_check"
]);

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

const REVIEW_TOPIC_RESOLUTION_OPTIONS = Object.freeze({
  medication_delivery_check: Object.freeze([
    { value: "outside_prescription", label: "院外処方箋を交付した" },
    { value: "in_house", label: "院内処方として扱う" },
    { value: "not_prescribed", label: "今回は処方していない" }
  ]),
  contrast_check: Object.freeze([
    { value: "with_contrast", label: "造影あり" },
    { value: "without_contrast", label: "造影なし" },
    { value: "unknown", label: "カルテだけでは不明" }
  ]),
  electronic_image_management_check: Object.freeze([
    { value: "electronic_storage", label: "電子保存あり" },
    { value: "no_electronic_storage", label: "電子保存なし" },
    { value: "facility_profile", label: "施設設定で確認" }
  ]),
  equipment_kind_check: Object.freeze([
    { value: "facility_profile", label: "施設の機器区分で確認" },
    { value: "order_attribute", label: "オーダー属性で確認" },
    { value: "unknown", label: "区分不明として保留" }
  ]),
  target_disease_check: Object.freeze([
    { value: "target_disease_confirmed", label: "対象疾患に該当する" },
    { value: "target_disease_not_confirmed", label: "対象疾患に該当しない" },
    { value: "needs_chart_update", label: "病名・管理記録を追記して再計算" }
  ]),
  care_plan_check: Object.freeze([
    { value: "care_plan_documented", label: "療養計画・指導記録あり" },
    { value: "care_plan_missing", label: "記録不足" },
    { value: "same_month_history_needed", label: "同月履歴を確認" }
  ]),
  same_month_check: Object.freeze([
    { value: "not_billed_this_month", label: "同月未算定" },
    { value: "already_billed_this_month", label: "同月算定済み" },
    { value: "unknown", label: "履歴不明" }
  ]),
  monthly_lab_duplicate_check: Object.freeze([
    { value: "not_duplicate", label: "同月重複なし" },
    { value: "duplicate_or_recent", label: "同月重複の可能性あり" },
    { value: "unknown", label: "検査履歴不明" }
  ]),
  lab_code_check: Object.freeze([
    { value: "performed_and_code_known", label: "当日実施・標準コード確定" },
    { value: "performed_code_unknown", label: "当日実施だがコード未確定" },
    { value: "not_performed", label: "当日実施ではない" }
  ]),
  judgement_fee_check: Object.freeze([
    { value: "judgement_fee_applicable", label: "判断料の対象" },
    { value: "judgement_fee_not_applicable", label: "判断料の対象外" },
    { value: "same_month_history_needed", label: "同月判断料履歴を確認" }
  ])
});

const SPECIFIC_DISEASE_TARGET_PATTERNS = Object.freeze([
  /気管支喘息|喘息/u
]);

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
    title: issue.title || topic.label,
    resolutionOptions: Array.isArray(issue.resolutionOptions) && issue.resolutionOptions.length
      ? issue.resolutionOptions
      : asArray(REVIEW_TOPIC_RESOLUTION_OPTIONS[topicCode])
  };
}

function reviewTopicCodeFromTaxonomyLabel(text = "") {
  const normalized = normalizeClinicalText(text);
  if (!normalized) return "";
  for (const [topicCode, topic] of Object.entries(REVIEW_TOPIC_TAXONOMY)) {
    const label = normalizeClinicalText(topic?.label || "");
    if (label && new RegExp(escapeRegExp(label), "u").test(normalized)) {
      return topicCode;
    }
  }
  if (/初診\s*\/\s*再診(?:の)?確認|初診(?:か|・|\/)再診(?:か)?(?:の)?確認|初診\/再診.*(?:不明|未確定|必要)|初診か再診か/u.test(normalized)) {
    return "visit_type_check";
  }
  return "";
}

function medicationReviewContextText(message = "", event = {}) {
  return normalizeClinicalText([
    message,
    clinicalEventName(event),
    event?.review_reason,
    event?.reviewReason,
    clinicalEventEvidence(event)
  ].filter(Boolean).join(" "));
}

function hasMedicationContextForQuantityReview(text = "") {
  return /(薬剤|処方|投薬|外用|内服|頓服|点眼|点鼻|貼付|塗布|軟膏|クリーム|ローション|ゲル|ステロイド|抗菌薬|保湿剤|錠|カプセル|散|液|シロップ|注射薬)/u.test(normalizeClinicalText(text));
}

function hasMedicationTotalQuantityReviewContext(text = "") {
  const normalized = normalizeClinicalText(text);
  if (!normalized || !hasMedicationContextForQuantityReview(normalized)) {
    return false;
  }
  if (/総量不足/u.test(normalized)) {
    return true;
  }
  const hasTotalQuantityCue = /(?:総量|全量|本数|枚数|包数|瓶数|チューブ本数|g数|グラム数|mL|ml|ML)/u.test(normalized);
  const hasMissingCue = /(?:不足|不明|未記載|記載なし|記録なし|残っていない|未確定|確定でき|照合|確認|不十分)/u.test(normalized);
  return hasTotalQuantityCue && hasMissingCue;
}

function reviewTopicCodeFromWarning(message = "", event = {}) {
  const text = String(message || "");
  const medicationContextText = medicationReviewContextText(text, event);
  const taxonomyTopicCode = reviewTopicCodeFromTaxonomyLabel([
    text,
    clinicalEventName(event),
    event?.review_reason,
    event?.reviewReason
  ].join(" "));
  if (taxonomyTopicCode) {
    return taxonomyTopicCode;
  }
  if (/造影/u.test(text) && /(確認|未確定|不明|有無|必要)/u.test(text)) {
    return "contrast_check";
  }
  if (/初診|再診|受診履歴|診療形態/u.test(text) && /(確認|未確定|不明|必要|明記なし)/u.test(text)) {
    return "visit_type_check";
  }
  if (/同日|同一日/u.test(text) && /(重複|併算定|複数|確認|未確定|必要)/u.test(text)) {
    return "same_day_duplicate_check";
  }
  if (/対象疾患/u.test(text)) {
    return "target_disease_check";
  }
  if (/(?:同月内検査|同じ月に当院で行った検査|院内履歴.{0,12}(?:照合|確認)|検査.{0,18}(?:同月|同じ月|月内|重複|前回|直近|再検|検査間隔)|(?:同月|同じ月|月内|前回|直近|再検|検査間隔).{0,18}(?:検査|検体|採血|重複))/u.test(text)) {
    return "monthly_lab_duplicate_check";
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
  if (/(?:届出|届け出|地方厚生局|院内(?:の)?登録情報|院内登録|登録情報.{0,12}(?:照合|確認|不明|必要)|(?:実施|提供|対応|扱える).{0,18}(?:院内|当院).{0,18}(?:登録|届出|施設))/u.test(text)) {
    return "notification_check";
  }
  if (/施設基準/u.test(text)) {
    return "facility_standard_check";
  }
  if (/電子(?:画像管理|保存|的.*保存)|電子.*管理/u.test(text) && /(確認|未確定|不明|有無|必要)/u.test(text)) {
    return "electronic_image_management_check";
  }
  if (/(?:機器区分|装置区分|撮影装置|ct_equipment_kind|mri_equipment_kind)/iu.test(text) && /(確認|未確定|不明|不足|必要|なし|無い|ない)/u.test(text)) {
    return "equipment_kind_check";
  }
  if (/D026|検査判断料|判断料/u.test(text)) {
    return "judgement_fee_check";
  }
  if (/採血料|静脈採血料|Ｂ-?Ｖ|B-?V|blood_venous|Collection fee/u.test(text)) {
    return "blood_collection_check";
  }
  if (/処置部位|部位確認/u.test(text)) {
    return "procedure_site_check";
  }
  if (/療養計画|管理計画|指導計画/u.test(text)) {
    return "care_plan_check";
  }
  if (/注射経路|投与経路|経路確認/u.test(text)) {
    return "injection_route_check";
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
  if (hasMedicationTotalQuantityReviewContext(medicationContextText)) {
    return "missing_total_quantity";
  }
  if (/薬剤日数不足|処方日数|服用日数|使用日数/u.test(text)) {
    return "missing_medication_days";
  }
  if (/薬剤量|投与量|用量/u.test(text) && /(確認|不足|不明|未記載|明記|必要)/u.test(text)) {
    return "medication_amount_check";
  }
  if (/院内外処方|院内処方|院外処方|処方箋/u.test(text) && /(確認|矛盾|不明|必要)/u.test(text)) {
    return "medication_delivery_check";
  }
  if (/面接時間|術前(?:診察|面接|評価)|麻酔.*(?:面接|診察|評価)/u.test(text)) {
    return "anesthesia_interview_time_check";
  }
  if (/薬剤/u.test(text) && /数量|日数|回数/u.test(text)) {
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
          registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
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
  const canonicalClinicalFacts = [];
  const masterCandidates = [];
  const billingCandidates = [];
  const billingIntents = [];
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
      registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
      masterVersion: feeMasterVersion(feeCalculator),
      timeoutMs: Number(openAiTimeoutMs || 0)
    },
    ruleBasedClinicalInference: {
      durationMs: 0,
      masterLookupCount: 0,
      masterLookupDurationMs: 0
    }
  };
  let extractedVisitFacts = null;
  let checklistFindingStatusCounts = null;

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
    extractedVisitFacts = structured.visitFacts || null;
    checklistFindingStatusCounts = structured.checklistFindingStatusCounts || null;
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
      canonicalClinicalFacts.push(...asArray(structured.canonicalClinicalFacts));
      masterCandidates.push(...asArray(structured.masterCandidates));
      billingCandidates.push(...asArray(structured.billingCandidates));
      billingIntents.push(...asArray(structured.billingIntents));
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
    canonicalClinicalFacts: normalizeCanonicalClinicalFacts(canonicalClinicalFacts),
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
      billingIntentCount: billingIntents.length,
      reviewIssueCount: reviewIssues.length,
      clinicalTrace,
      visitFacts: extractedVisitFacts,
      checklistFindingStatusCounts,
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

function buildClinicalTextPreprocessing(text = "") {
  const rawText = String(text || "").replace(/\r\n?/gu, "\n");
  const sectionCounts = {};
  const lines = [];
  let currentSection = "unknown";
  let offset = 0;
  for (const [index, line] of rawText.split("\n").entries()) {
    const trimmed = line.trim();
    const detectedSection = clinicalSectionFromLine(trimmed);
    if (detectedSection) {
      currentSection = detectedSection;
    }
    const sectionKey = currentSection === "unknown" ? "L" : currentSection.toUpperCase();
    sectionCounts[sectionKey] = Number(sectionCounts[sectionKey] || 0) + 1;
    lines.push({
      lineId: `${sectionKey}-${String(sectionCounts[sectionKey]).padStart(3, "0")}`,
      index: index + 1,
      section: currentSection,
      charStart: offset,
      charEnd: offset + line.length,
      text: line,
      normalizedText: normalizeClinicalText(line),
      cues: clinicalLineCues(line),
      candidateConcepts: []
    });
    offset += line.length + 1;
  }
  const deterministicCandidates = deterministicClinicalCandidatesFromLines(lines);
  const conceptsByLineId = new Map();
  for (const candidate of deterministicCandidates) {
    if (!candidate.lineId || !candidate.conceptId) {
      continue;
    }
    const current = conceptsByLineId.get(candidate.lineId) || [];
    current.push(candidate.conceptId);
    conceptsByLineId.set(candidate.lineId, uniqueStrings(current).slice(0, 12));
  }
  for (const line of lines) {
    line.candidateConcepts = conceptsByLineId.get(line.lineId) || [];
  }
  return {
    text: rawText,
    normalizedText: normalizeClinicalText(rawText),
    lines,
    deterministicCandidates,
    lineCount: lines.length,
    sectionCounts: Object.fromEntries(Object.entries(sectionCounts).map(([key, value]) => [key, Number(value || 0)]))
  };
}

function clinicalSectionFromLine(line = "") {
  const text = String(line || "").trim();
  if (/^(?:S|Subjective)\b|^S[（(:：]|主観的情報/u.test(text)) return "S";
  if (/^(?:O|Objective)\b|^O[（(:：]|客観的情報/u.test(text)) return "O";
  if (/^(?:A|Assessment)\b|^A[（(:：]|評価/u.test(text)) return "A";
  if (/^(?:P|Plan)\b|^P[（(:：]|計画/u.test(text)) return "P";
  return "";
}

function clinicalLineCues(line = "") {
  const text = String(line || "");
  return {
    futureOrOrderOnly: isFutureOrOrderOnlyContext(text),
    negatedService: isNegatedClinicalServiceContext(text),
    pastOrExternal: isPastOrExternalClinicalServiceContext(text),
    currentVisit: isCurrentVisitEvidence(text),
    syntheticMeta: isClinicalMetaSentence(text)
  };
}

function deterministicClinicalCandidatesFromLines(lines = []) {
  const candidates = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line?.text || "");
    const normalizedText = String(line?.normalizedText || normalizeClinicalText(text));
    if (!normalizedText.trim() || line?.cues?.syntheticMeta) {
      continue;
    }
    for (const concept of labConceptsFromText(normalizedText)) {
      candidates.push(preprocessingCandidate({
        kind: "lab",
        conceptId: `lab:${concept.key}`,
        label: concept.name || concept.key,
        line,
        evidence: text,
        confidence: hasLabResultContext(text, concept) || hasPerformedLabContext(text) ? "medium" : "low"
      }));
    }
    for (const group of labConceptGroupsFromText(normalizedText)) {
      candidates.push(preprocessingCandidate({
        kind: "lab_group",
        conceptId: `lab_group:${group.key}`,
        label: group.name || group.key,
        line,
        evidence: text,
        confidence: "low"
      }));
    }
    for (const imaging of imagingConceptsFromPreprocessedLine(normalizedText)) {
      candidates.push(preprocessingCandidate({
        kind: "imaging",
        conceptId: `imaging:${imaging.key}`,
        label: imaging.label,
        line,
        evidence: text,
        confidence: line?.cues?.futureOrOrderOnly || line?.cues?.pastOrExternal || line?.cues?.negatedService ? "low" : "medium"
      }));
    }
    for (const procedure of PROCEDURE_CHECKLIST_DEFINITIONS) {
      if (procedure.pattern?.test?.(normalizedText)) {
        candidates.push(preprocessingCandidate({
          kind: "procedure",
          conceptId: `procedure:${procedure.key}`,
          label: procedure.label || procedure.query || procedure.key,
          line,
          evidence: text,
          confidence: line?.cues?.futureOrOrderOnly || line?.cues?.pastOrExternal || line?.cues?.negatedService ? "low" : "medium"
        }));
      }
    }
    for (const domain of REVIEW_ONLY_DOMAIN_CHECKLIST_DEFINITIONS) {
      if (domain.pattern?.test?.(normalizedText)) {
        candidates.push(preprocessingCandidate({
          kind: "review_domain",
          conceptId: `domain:${domain.domain}`,
          label: domain.label || domain.domain,
          line,
          evidence: text,
          confidence: "review"
        }));
      }
    }
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.conceptId}:${candidate.lineId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 80);
}

function preprocessingCandidate({ kind, conceptId, label, line, evidence, confidence }) {
  return {
    candidateId: candidateIdPart([kind, conceptId, line?.lineId || ""].join("_")),
    kind,
    conceptId,
    label,
    lineId: line?.lineId || "",
    lineIndex: line?.index || null,
    section: line?.section || "unknown",
    evidence: String(evidence || "").slice(0, 180),
    cues: line?.cues || {},
    confidence: confidence || "low"
  };
}

function imagingConceptsFromPreprocessedLine(text = "") {
  const value = String(text || "");
  const concepts = [];
  if (/CT|ＣＴ|コンピュータ断層|断層撮影/u.test(value)) {
    concepts.push({ key: "ct", label: "CT" });
  }
  if (/MRI|ＭＲＩ|磁気共鳴/u.test(value)) {
    concepts.push({ key: "mri", label: "MRI" });
  }
  if (/X線|Ｘ線|レントゲン|胸写|XP|ＸＰ/u.test(value)) {
    concepts.push({ key: "simple_radiography", label: "単純X線" });
  }
  if (/超音波|エコー/u.test(value)) {
    concepts.push({ key: "ultrasound", label: "超音波" });
  }
  return concepts;
}

function evidenceRefsForClinicalEvent(event = {}, preprocessing = null) {
  const quote = clinicalEventEvidenceQuote(event);
  const section = normalizeClinicalSection(event?.section);
  if (!quote || !preprocessing?.lines?.length) {
    return quote ? [{
      source: "clinical_text",
      section,
      quote
    }] : [];
  }
  const explicitLineIds = clinicalEventEvidenceLineIds(event);
  if (explicitLineIds.length) {
    const lineById = new Map(preprocessing.lines.map((line) => [line.lineId, line]));
    const quoteCandidates = clinicalEventEvidenceQuoteCandidates(quote);
    const explicitSpan = clinicalEventEvidenceSpan(event);
    const refs = [];
    for (const lineId of explicitLineIds) {
      const line = lineById.get(lineId);
      if (!line) {
        refs.push({
          source: "clinical_text",
          lineId,
          section,
          quote,
          notFoundInText: true,
          reason: "evidence_line_id_not_found",
          lineIdProvided: true
        });
        continue;
      }
      const lineText = String(line.text || "");
      const normalizedLine = String(line.normalizedText || "");
      let matchedQuote = "";
      let rawIndex = -1;
      let normalizedOnly = false;
      for (const quoteCandidate of quoteCandidates) {
        rawIndex = lineText.indexOf(quoteCandidate);
        if (rawIndex >= 0) {
          matchedQuote = quoteCandidate;
          break;
        }
        const normalizedQuote = normalizeClinicalText(quoteCandidate);
        if (normalizedQuote && normalizedLine.includes(normalizedQuote)) {
          matchedQuote = quoteCandidate;
          normalizedOnly = true;
          break;
        }
      }
      const hasExplicitSpan = explicitSpan
        && explicitSpan.charStart >= line.charStart
        && explicitSpan.charEnd <= line.charEnd;
      const charStart = hasExplicitSpan
        ? explicitSpan.charStart
        : rawIndex >= 0
          ? line.charStart + rawIndex
          : line.charStart;
      const charEnd = hasExplicitSpan
        ? explicitSpan.charEnd
        : rawIndex >= 0
          ? line.charStart + rawIndex + matchedQuote.length
          : line.charEnd;
      refs.push({
        source: "clinical_text",
        lineId: line.lineId,
        lineIndex: line.index,
        section: line.section || section || "unknown",
        quote: matchedQuote || quote,
        originalQuote: matchedQuote && matchedQuote !== quote ? quote : undefined,
        lineText,
        verificationContext: rawIndex >= 0
          ? sentenceContainingRange(lineText, rawIndex, rawIndex + matchedQuote.length)
          : lineText,
        charStart,
        charEnd,
        cues: line.cues || {},
        exact: rawIndex >= 0 || hasExplicitSpan,
        normalizedOnly,
        lineIdProvided: true,
        quoteNotOnLine: !matchedQuote && Boolean(quote)
      });
    }
    if (refs.length) {
      return refs.slice(0, 4);
    }
  }
  const quoteCandidates = clinicalEventEvidenceQuoteCandidates(quote);
  const refs = [];
  const seenRefs = new Set();
  for (const quoteCandidate of quoteCandidates) {
    const normalizedQuote = normalizeClinicalText(quoteCandidate);
    for (const line of preprocessing.lines) {
      const lineText = String(line.text || "");
      const normalizedLine = String(line.normalizedText || "");
      const rawIndex = lineText.indexOf(quoteCandidate);
      const normalizedHit = normalizedQuote && normalizedLine.includes(normalizedQuote);
      if (rawIndex < 0 && !normalizedHit) {
        continue;
      }
      const key = `${line.lineId || line.index}:${quoteCandidate}:${rawIndex >= 0 ? rawIndex : "normalized"}`;
      if (seenRefs.has(key)) {
        continue;
      }
      seenRefs.add(key);
      refs.push({
        source: "clinical_text",
        lineId: line.lineId,
        lineIndex: line.index,
        section: line.section || section || "unknown",
        quote: quoteCandidate,
        originalQuote: quoteCandidate === quote ? undefined : quote,
        quoteNormalization: quoteCandidate === quote ? undefined : "quote_wrapper_stripped",
        lineText,
        verificationContext: rawIndex >= 0 ? sentenceContainingRange(lineText, rawIndex, rawIndex + quoteCandidate.length) : quoteCandidate,
        charStart: rawIndex >= 0 ? line.charStart + rawIndex : line.charStart,
        charEnd: rawIndex >= 0 ? line.charStart + rawIndex + quoteCandidate.length : line.charEnd,
        cues: line.cues || {},
        exact: rawIndex >= 0,
        normalizedOnly: rawIndex < 0 && Boolean(normalizedHit)
      });
    }
  }
  if (refs.length) {
    return refs.slice(0, 4);
  }
  const bestLine = quoteCandidates
    .map((candidate) => ({ candidate, line: bestEvidenceLineByTokenOverlap(candidate, preprocessing.lines) }))
    .find((result) => result.line);
  return bestLine ? [{
    source: "clinical_text",
    lineId: bestLine.line.lineId,
    lineIndex: bestLine.line.index,
    section: bestLine.line.section || section || "unknown",
    quote: bestLine.candidate,
    originalQuote: bestLine.candidate === quote ? undefined : quote,
    quoteNormalization: bestLine.candidate === quote ? undefined : "quote_wrapper_stripped",
    lineText: bestLine.line.text,
    verificationContext: bestLine.candidate,
    charStart: bestLine.line.charStart,
    charEnd: bestLine.line.charEnd,
    cues: bestLine.line.cues || {},
    approximate: true
  }] : [{
    source: "clinical_text",
    section,
    quote,
    notFoundInText: true
  }];
}

function clinicalEventEvidenceQuoteCandidates(quote = "") {
  const raw = String(quote || "").trim();
  if (!raw) {
    return [];
  }
  const candidates = [raw];
  const stripped = stripClinicalQuoteWrapper(raw);
  if (stripped && stripped !== raw) {
    candidates.push(stripped);
  }
  const quotedSegmentPattern = /[「『“"']([^「」『』“”"']{1,500})[」』”"']/gu;
  for (const match of raw.matchAll(quotedSegmentPattern)) {
    const segment = stripClinicalQuoteWrapper(match[1]);
    if (segment) {
      candidates.push(segment);
    }
  }
  return uniqueStrings(candidates)
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function stripClinicalQuoteWrapper(value = "") {
  let text = String(value || "").trim();
  const pairs = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["\"", "\""],
    ["'", "'"]
  ];
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    for (const [left, right] of pairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        text = text.slice(left.length, text.length - right.length).trim();
        changed = true;
        break;
      }
    }
  }
  return text;
}

function sentenceContainingRange(text = "", start = 0, end = 0) {
  const value = String(text || "");
  if (!value) {
    return "";
  }
  const safeStart = Math.max(0, Math.min(Number(start) || 0, value.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, value.length));
  const boundaryPattern = /[。．.!！?？\n\r]/u;
  let left = safeStart;
  while (left > 0 && !boundaryPattern.test(value[left - 1])) {
    left -= 1;
  }
  let right = safeEnd;
  if (right > 0 && boundaryPattern.test(value[right - 1])) {
    // The evidence quote itself already includes the sentence terminator.
  } else {
    while (right < value.length && !boundaryPattern.test(value[right])) {
      right += 1;
    }
    if (right < value.length && boundaryPattern.test(value[right])) {
      right += 1;
    }
  }
  return value.slice(left, right).trim() || value.slice(safeStart, safeEnd).trim() || value.trim();
}

function bestEvidenceLineByTokenOverlap(quote = "", lines = []) {
  const tokens = normalizeClinicalText(quote)
    .split(/[、。，．\s（）()【】「」:：/]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
  if (!tokens.length) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const line of lines) {
    const normalizedLine = String(line.normalizedText || "");
    const score = tokens.reduce((sum, token) => sum + (normalizedLine.includes(token) ? 1 : 0), 0);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return bestScore >= Math.max(1, Math.ceil(tokens.length / 3)) ? best : null;
}

function verifyClinicalEventEvidence(event = {}, preprocessing = null) {
  const evidenceRefs = evidenceRefsForClinicalEvent(event, preprocessing);
  const quote = clinicalEventEvidenceQuote(event);
  const reasons = [];
  if (!quote) {
    reasons.push("missing_evidence_quote");
  }
  if (evidenceRefs.some((ref) => ref.notFoundInText)) {
    reasons.push("evidence_quote_not_found");
  }
  if (evidenceRefs.some((ref) => ref.approximate)) {
    reasons.push("evidence_quote_approximate");
  }
  const contexts = verificationContextsForClinicalEvent(event, evidenceRefs, quote).join("\n");
  const billable = isBillableClinicalEvent(event);
  const type = normalizeClinicalEventType(event);
  const reviewOnlyDomain = reviewOnlyClinicalEventDomain(event);
  const appliesToAutoBillingGuard = billable
    && !reviewOnlyDomain
    && !["medication", "management", "counseling"].includes(type);
  if (contexts && isNegatedClinicalServiceContext(contexts)) {
    reasons.push("negated_service_context");
  }
  if (contexts && isFutureOrOrderOnlyContext(contexts)) {
    reasons.push("future_or_order_only_context");
  }
  if (contexts && type !== "medication" && isPastOrExternalClinicalServiceContext(contexts)) {
    reasons.push("past_or_external_context");
  }
  const blockingReasons = reasons.filter((reason) => [
    "negated_service_context",
    "future_or_order_only_context",
    "past_or_external_context"
  ].includes(reason));
  const status = appliesToAutoBillingGuard && blockingReasons.length
    ? "blocked"
    : reasons.includes("evidence_quote_not_found") || reasons.includes("evidence_quote_approximate") || reasons.includes("missing_evidence_quote")
      ? "review_required"
      : "verified";
  return {
    status,
    reasons,
    evidenceRefs,
    checkedAtRuleSetVersion: FEE_CLINICAL_RULE_SET_VERSION
  };
}

function verificationContextsForClinicalEvent(event = {}, evidenceRefs = [], quote = "") {
  const contexts = [];
  const rawQuote = String(quote || "").trim();
  if (rawQuote) {
    contexts.push(rawQuote);
  }
  for (const ref of asArray(evidenceRefs)) {
    if (ref?.approximate || ref?.notFoundInText) {
      continue;
    }
    const context = scopedVerificationContextForClinicalEvent(event, ref);
    if (context) {
      contexts.push(context);
    }
  }
  return uniqueStrings(contexts).filter(Boolean);
}

function scopedVerificationContextForClinicalEvent(event = {}, evidenceRef = {}) {
  const context = String(evidenceRef.verificationContext || evidenceRef.quote || "").trim();
  if (!context) {
    return "";
  }
  const tokens = clinicalEventScopeTokens(event);
  if (!tokens.length) {
    return context;
  }
  const clauses = splitClinicalClauses(context);
  const matchedClauses = clauses.filter((clause) => tokens.some((token) => clause.includes(token)));
  if (!matchedClauses.length) {
    return context;
  }

  // Ownership cues such as "前医で" at the beginning of a sentence often scope
  // over every following comma-separated clause. Keep the whole sentence so we
  // do not accidentally turn outside/past references into current in-house facts.
  if (leadingOwnershipOrPastCueScopesOverContext(context, matchedClauses[0])) {
    return context;
  }
  return uniqueStrings(matchedClauses).join("。");
}

function splitClinicalClauses(text = "") {
  return String(text || "")
    .split(/[。．.!！?？\n\r、，；;]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function leadingOwnershipOrPastCueScopesOverContext(context = "", firstMatchedClause = "") {
  const value = String(context || "");
  const clause = String(firstMatchedClause || "");
  if (!value || !clause) {
    return false;
  }
  const firstMatchIndex = value.indexOf(clause);
  const prefix = firstMatchIndex > 0 ? value.slice(0, firstMatchIndex) : "";
  const sameSentencePrefix = prefix.split(/[。．.!！?？\n\r]/u).pop() || "";
  if (!/(前医|他院|紹介状|持参|健診|先月|前回|以前|過去)/u.test(sameSentencePrefix)) {
    return false;
  }
  const cueIndex = Math.max(
    sameSentencePrefix.lastIndexOf("前医"),
    sameSentencePrefix.lastIndexOf("他院"),
    sameSentencePrefix.lastIndexOf("紹介状"),
    sameSentencePrefix.lastIndexOf("持参"),
    sameSentencePrefix.lastIndexOf("健診"),
    sameSentencePrefix.lastIndexOf("先月"),
    sameSentencePrefix.lastIndexOf("前回"),
    sameSentencePrefix.lastIndexOf("以前"),
    sameSentencePrefix.lastIndexOf("過去")
  );
  const afterCue = cueIndex >= 0 ? sameSentencePrefix.slice(cueIndex) : sameSentencePrefix;
  return !/(本日|今回|当院|院内|自院|当日)/u.test(afterCue);
}

function clinicalEventScopeTokens(event = {}) {
  const tokens = [
    clinicalEventName(event),
    event?.body_site,
    event?.bodySite,
    event?.modality,
    event?.specimen,
    event?.collection_method,
    ...labConceptsFromClinicalEventName(event).flatMap((concept) => [
      concept.name,
      concept.query,
      ...asArray(concept.aliases)
    ])
  ];
  return uniqueStrings(tokens
    .map((token) => normalizeClinicalText(token))
    .filter((token) => token && token.length >= 2)
  ).slice(0, 12);
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
  const clinicalTextPreprocessing = buildClinicalTextPreprocessing(text);
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
        preprocessedLines: clinicalTextPreprocessing.lines,
        checklistMenu,
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        timeoutMs: openAiTimeoutMs
      })
      : await extractFeeClinicalFactsWithOpenAi({
        apiKey: openAiApiKey,
        clinicalText: text,
        sessionContext: buildFeeSessionContext(session),
        preprocessedLines: clinicalTextPreprocessing.lines,
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
        registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        timeoutMs: Number(openAiTimeoutMs || 0),
        responseId: factsResult?.responseId || null,
        usage: factsResult?.usage || null
      },
      visitFacts: normalizeVisitFactsForTrace(facts?.visit_facts),
      checklistFindingStatusCounts: checklistFindingStatusCounts(facts?.checklist_findings)
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
        registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
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

function normalizeVisitFactsForTrace(visitFacts = null) {
  if (!isPlainObject(visitFacts)) {
    return null;
  }
  const result = {};
  for (const [key, value] of Object.entries(visitFacts)) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 8).map((item) => String(item || "").slice(0, 120));
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = Object.fromEntries(Object.entries(value).slice(0, 12).map(([childKey, childValue]) => [
        childKey,
        String(childValue || "").slice(0, 120)
      ]));
      continue;
    }
    result[key] = String(value || "").slice(0, 160);
  }
  return Object.keys(result).length ? result : null;
}

function checklistFindingStatusCounts(findings = []) {
  const counts = {};
  for (const finding of asArray(findings)) {
    const status = normalizeChecklistFindingStatus(finding?.status);
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return Object.keys(counts).length ? counts : null;
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
  billingIntentCount = 0,
  reviewIssueCount = 0,
  clinicalTrace = [],
  visitFacts = null,
  checklistFindingStatusCounts = null,
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
    registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
    masterVersion: feeMasterVersion(feeCalculator),
    responseId,
    usage: usage || null,
    clinicalEventCount: Number(clinicalEventCount || 0),
    masterCandidateCount: Number(masterCandidateCount || 0),
    billingCandidateCount: Number(billingCandidateCount || 0),
    billingIntentCount: Number(billingIntentCount || 0),
    reviewIssueCount: Number(reviewIssueCount || 0),
    visitFacts: normalizeVisitFactsForTrace(visitFacts),
    checklistFindingStatusCounts: checklistFindingStatusCounts || null,
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
  const clinicalTextPreprocessing = buildClinicalTextPreprocessing(text);
  clinicalTrace.push({
    stage: "clinical_text_preprocess",
    outcome: "prepared",
    lineCount: clinicalTextPreprocessing.lineCount,
    sectionCounts: clinicalTextPreprocessing.sectionCounts,
    message: "clinical_text_lines_and_cues_prepared"
  });
  clinicalTrace.push({
    stage: "deterministic_preprocessing",
    outcome: "prepared",
    candidateCount: clinicalTextPreprocessing.deterministicCandidates.length,
    candidates: clinicalTextPreprocessing.deterministicCandidates.slice(0, 24).map((candidate) => ({
      kind: candidate.kind,
      conceptId: candidate.conceptId,
      label: candidate.label,
      lineId: candidate.lineId,
      section: candidate.section,
      confidence: candidate.confidence,
      cues: candidate.cues
    })),
    message: "deterministic_candidates_prepared_for_observability_only"
  });
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
  if (checklistRecovery.reviewIssues?.length) {
    reviewIssues.push(...checklistRecovery.reviewIssues);
    reviewWarnings.push(...checklistRecovery.reviewIssues.map((issue) => issue.messageForStaff));
  }
  const compositeSupersededEventIds = supersededClinicalEventIdsFromCompositeChecklistRecovery({
    existingEvents: clinicalEvents,
    recoveredEvents: checklistRecovery.events
  });
  if (compositeSupersededEventIds.size) {
    clinicalEvents = clinicalEvents.filter((event) => {
      const keep = !compositeSupersededEventIds.has(clinicalEventIdentity(event));
      if (!keep) {
        clinicalTrace.push(clinicalTraceEvent({
          stage: "checklist_composite_normalization",
          event,
          categoryLabel: "複合検査",
          outcome: "superseded",
          message: "component_event_superseded_by_composite_checklist"
        }));
      }
      return keep;
    });
  }
  if (checklistRecovery.events.length) {
    clinicalEvents = [...clinicalEvents, ...checklistRecovery.events];
  }
  const {
    canonicalClinicalFactsForCalculation,
    clinicalEventsForCalculation,
    billingIntentsForCalculation
  } = buildCanonicalFactCalculationLedger(clinicalEvents, {
    preprocessing: clinicalTextPreprocessing
  });
  clinicalTrace.push({
    stage: "evidence_verifier",
    outcome: "prepared",
    summary: evidenceVerificationSummary(canonicalClinicalFactsForCalculation),
    message: "clinical_event_evidence_verified_before_calculation"
  });
  clinicalTrace.push({
    stage: "canonical_fact_ledger",
    outcome: "prepared",
    source: "clinical_events",
    factCount: canonicalClinicalFactsForCalculation.length,
    eligibleFactCount: canonicalClinicalFactsForCalculation.filter((fact) => (
      ["eligible_for_master_search", "eligible_for_billing"].includes(fact.status)
    )).length,
    reviewFactCount: canonicalClinicalFactsForCalculation.filter((fact) => fact.status === "review_required").length,
    excludedFactCount: canonicalClinicalFactsForCalculation.filter((fact) => fact.status === "excluded").length
  });
  clinicalTrace.push({
    stage: "billing_intent_builder",
    outcome: "prepared",
    source: "canonical_clinical_facts",
    intentCount: billingIntentsForCalculation.length,
    intents: billingIntentsForCalculation.slice(0, 24).map((intent) => ({
      billingIntentId: intent.billingIntentId,
      sourceFactId: intent.sourceFactId,
      intentType: intent.intentType,
      conceptId: intent.conceptId,
      clinicalName: intent.clinicalName
    })),
    message: "verified_canonical_facts_converted_to_billing_intents"
  });
  const suppressedClinicalFactWarnings = [];
  let hasCaseLevelLabProcedureCode = false;
  let hasCaseLevelBloodCollectionEvidence = hasCaseLevelBloodCollectionEvidenceFromText(text);
  clinicalTrace.push(...checklistRecovery.traceEvents);

  const visitMedicationDecision = medicationOptionsDecisionFromVisitFacts(facts?.visit_facts, {
    clinicalText: text,
    clinicalEvents: clinicalEventsForCalculation,
    medicationOrders: []
  });
  if (visitMedicationDecision.reviewIssue) {
    reviewIssues.push(visitMedicationDecision.reviewIssue);
    reviewWarnings.push(visitMedicationDecision.reviewIssue.messageForStaff);
    clinicalTrace.push({
      stage: "visit_facts_consistency",
      outcome: "blocked",
      topicCode: visitMedicationDecision.reviewIssue.topicCode,
      message: "outside_prescription_visit_fact_conflicted_or_unverified",
      visitFacts: compactVisitFactsForTrace(facts?.visit_facts)
    });
  } else if (visitMedicationDecision.trace) {
    clinicalTrace.push(visitMedicationDecision.trace);
  }
  const visitMedication = visitMedicationDecision.options;
  const verifiedOutsidePrescription = visitMedication?.delivery_kind === "outside_prescription";

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
  const visitTypeIssue = reviewIssueFromVisitTypeFact(facts?.visit_type);
  if (visitTypeIssue) {
    reviewIssues.push(visitTypeIssue);
    reviewWarnings.push(visitTypeIssue.messageForStaff);
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

  for (const event of clinicalEventsForCalculation) {
    const type = normalizeClinicalEventType(event);
    if (event.evidenceVerificationStatus === "blocked") {
      const issue = reviewIssueFromEvidenceVerificationBlocked(event);
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      const reasons = asArray(event.evidenceVerificationReasons);
      if (["lab", "exam"].includes(type) && reasons.includes("past_or_external_context")) {
        const labIssue = reviewIssueFromNonBillableLabClinicalEvent(event, "lab_code_check", {
          message: `検査コード確認: ${clinicalEventName(event) || "検査"}は検査名として抽出されましたが、根拠文が過去・他院・持参情報の文脈です。今回自院で実施済みの場合は標準コード、検査区分、検体、測定条件を確認してください。`,
          requiredInput: "標準コード、検査区分、検体、測定条件、当日自院実施の根拠"
        });
        if (labIssue) {
          reviewIssues.push(labIssue);
          reviewWarnings.push(labIssue.messageForStaff);
        }
      }
      clinicalTrace.push(clinicalTraceEvent({
        stage: "evidence_verifier",
        event,
        categoryLabel: "根拠確認",
        outcome: "blocked",
        selected: {
          reasons: asArray(event.evidenceVerificationReasons),
          evidenceRefs: asArray(event.evidenceRefs).map((ref) => ({
            lineId: ref.lineId,
            section: ref.section,
            approximate: Boolean(ref.approximate)
          }))
        },
        message: "clinical_event_blocked_by_evidence_verifier"
      }));
      continue;
    }
    if (event.evidenceVerificationStatus === "review_required" && ["lab", "exam"].includes(type)) {
      const evidenceIssue = reviewIssueFromEvidenceVerificationBlocked(event);
      if (evidenceIssue) {
        reviewIssues.push(evidenceIssue);
        reviewWarnings.push(evidenceIssue.messageForStaff);
      }
      const issue = reviewIssueFromNonBillableLabClinicalEvent(event, "lab_code_check", {
        message: `検査コード確認: ${clinicalEventName(event) || "検査"}は検査名として抽出されましたが、カルテ本文の根拠引用を確認できません。実施済みの場合は標準コード、検査区分、検体、測定条件を確認してください。`,
        requiredInput: "標準コード、検査区分、検体、測定条件、当日実施の根拠"
      });
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      clinicalTrace.push(clinicalTraceEvent({
        stage: "evidence_verifier",
        event,
        categoryLabel: "検体検査",
        outcome: "review_required",
        selected: {
          reasons: asArray(event.evidenceVerificationReasons)
        },
        message: "lab_event_requires_review_due_to_unverified_evidence"
      }));
      continue;
    }
    if (event.evidenceVerificationStatus === "review_required" && isBillableClinicalEvent(event) && !reviewOnlyClinicalEventDomain(event)) {
      const issue = reviewIssueFromEvidenceVerificationBlocked(event);
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      clinicalTrace.push(clinicalTraceEvent({
        stage: "evidence_verifier",
        event,
        categoryLabel: "根拠確認",
        outcome: "review_required",
        selected: {
          reasons: asArray(event.evidenceVerificationReasons),
          evidenceRefs: asArray(event.evidenceRefs).map((ref) => ({
            lineId: ref.lineId,
            section: ref.section,
            approximate: Boolean(ref.approximate)
          }))
        },
        message: "clinical_event_requires_review_due_to_unverified_evidence"
      }));
      continue;
    }
    if (canonicalFactBlocksAutomaticBilling(event)) {
      const issue = reviewIssueFromCanonicalFactGate(event);
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      clinicalTrace.push(clinicalTraceEvent({
        stage: "canonical_fact_gate",
        event,
        categoryLabel: "検証済み臨床事実",
        outcome: "blocked",
        selected: {
          canonicalFactId: sourceFactIdFromClinicalEvent(event),
          canonicalFactStatus: event.canonicalFactStatus || "unknown",
          evidenceVerificationStatus: event.evidenceVerificationStatus || "unknown"
        },
        message: "clinical_event_not_eligible_from_canonical_fact"
      }));
      continue;
    }
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
      const nonBillableLabIssues = reviewIssuesFromNonBillableLabClinicalEvent(event);
      if (nonBillableLabIssues.length) {
        reviewIssues.push(...nonBillableLabIssues);
        reviewWarnings.push(...nonBillableLabIssues.map((issue) => issue.messageForStaff));
        clinicalTrace.push(clinicalTraceEvent({
          stage: "non_billable_lab_review_gate",
          event,
          categoryLabel: "検体検査",
          outcome: "review_required",
          message: "non_billable_lab_event_review_required"
        }));
        continue;
      }
      const labRelatedPlanningIssues = reviewIssuesFromNonBillableLabRelatedClinicalEvent(event);
      if (labRelatedPlanningIssues.length) {
        reviewIssues.push(...labRelatedPlanningIssues);
        reviewWarnings.push(...labRelatedPlanningIssues.map((issue) => issue.messageForStaff));
        clinicalTrace.push(clinicalTraceEvent({
          stage: "non_billable_lab_review_gate",
          event,
          categoryLabel: "検体検査",
          outcome: "review_required",
          message: "non_billable_lab_related_event_review_required"
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
      if (verifiedOutsidePrescription) {
        clinicalTrace.push(clinicalTraceEvent({
          stage: "medication_delivery_invariant",
          event,
          categoryLabel: "投薬",
          outcome: "excluded",
          selected: {
            delivery_kind: "outside_prescription",
            policy: "outside_prescription_excludes_institution_drug_charges"
          },
          message: "outside_prescription_medication_event_skipped_before_drug_master_lookup"
        }));
        continue;
      }
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
      reviewIssues.push(...reviewIssuesFromClinicalWarnings(event, procedure.reviewWarnings, {
        source: "clinical_procedure_rule"
      }));
      reviewWarnings.push(...procedure.reviewWarnings);
      clinicalTrace.push(...asArray(procedure.traceEvents));
      continue;
    }

    if (["management", "counseling"].includes(type)) {
      const categoryLabel = type === "management" ? "医学管理等" : "指導料";
      const issues = reviewIssuesFromManagementClinicalEvent(event, { categoryLabel });
      reviewIssues.push(...issues);
      reviewWarnings.push(...issues.map((issue) => issue.messageForStaff));
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

    const issues = reviewIssuesFromUnsupportedClinicalEvent(event);
    reviewIssues.push(...issues);
    reviewWarnings.push(...issues.map((issue) => issue.messageForStaff));
  }

  const specificDiseaseProposals = candidateProposalsFromSpecificDiseaseOpportunities({
    diagnoses,
    clinicalEvents: clinicalEventsForCalculation,
    visitMedication,
    clinicalText: text
  });
  if (specificDiseaseProposals.length) {
    candidateProposals.push(...specificDiseaseProposals);
    clinicalTrace.push({
      stage: "increase_proposal_rule",
      outcome: "proposed",
      proposalIds: specificDiseaseProposals.map((proposal) => proposal.proposalId),
      message: "specific_disease_management_opportunities_proposed"
    });
  }

  if (imagingOrders.length) {
    const preparedImagingOrders = dedupeObjects(imagingOrders);
    inferred.imaging_orders = preparedImagingOrders;
    for (const order of preparedImagingOrders) {
      clinicalTrace.push({
        traceId: `trace_${candidateIdPart(["imaging_order_prepared", JSON.stringify(imagingOrderTraceSelected(order))].join("_"))}`,
        stage: "imaging_order_prepared",
        outcome: "prepared",
        selected: imagingOrderTraceSelected(order),
        message: "imaging_order_attributes_prepared"
      });
    }
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
  const medicationDeliveryKind = medicationDeliveryKindFromStructuredOrText(visitMedication, text);
  if (medicationOrders.length) {
    if (medicationDeliveryKind !== "outside_prescription") {
      inferred.medication_orders = dedupeObjects(medicationOrders, (item) => item.drug_code);
    } else {
      clinicalTrace.push({
        traceId: `trace_${candidateIdPart(["outside_prescription_medication_orders_excluded", medicationOrders.length].join("_"))}`,
        stage: "medication_delivery_invariant",
        outcome: "excluded",
        selected: {
          delivery_kind: medicationDeliveryKind,
          medication_order_count: medicationOrders.length
        },
        message: "outside_prescription_excludes_institution_drug_charges"
      });
    }
    inferred.medication = {
      delivery_kind: medicationDeliveryKind,
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

  const reviewIssuesWithFactLineage = attachSourceFactIdsToReviewIssues(reviewIssues, clinicalEventsForCalculation);
  return {
    inferred,
    diagnoses,
    candidateProposals: normalizeCandidateProposals(candidateProposals),
    reviewWarnings: normalizeReviewWarnings(reviewWarnings),
    clinicalEvents,
    canonicalClinicalFacts: normalizeCanonicalClinicalFacts(canonicalClinicalFactsFromEvents(clinicalEventsForCalculation, {
      billingCandidates,
      reviewIssues: reviewIssuesWithFactLineage,
      masterCandidates,
      preprocessing: clinicalTextPreprocessing
    })),
    billingIntents: normalizeBillingIntents(billingIntentsForCalculation),
    masterCandidates: normalizeMasterCandidates(masterCandidates),
    billingCandidates: normalizeBillingCandidates(billingCandidates),
    reviewIssues: normalizeReviewIssues(reviewIssuesWithFactLineage),
    clinicalTrace: normalizeClinicalTrace(clinicalTrace)
  };
}

function attachSourceFactIdsToReviewIssues(reviewIssues = [], clinicalEvents = []) {
  const factIdByEventId = new Map();
  for (const event of asArray(clinicalEvents)) {
    const eventId = clinicalEventIdentity(event);
    const factId = sourceFactIdFromClinicalEvent(event);
    if (eventId && factId) {
      factIdByEventId.set(eventId, factId);
    }
  }
  return asArray(reviewIssues).map((issue) => {
    if (!issue || typeof issue !== "object" || issue.sourceFactId || issue.source_fact_id) {
      return issue;
    }
    const relatedIds = [
      issue.relatedClinicalEventId,
      issue.related_clinical_event_id,
      issue.relatedEventId,
      issue.related_event_id,
      ...asArray(issue.relatedClinicalEventIds),
      ...asArray(issue.related_event_ids)
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const factId = relatedIds.map((id) => factIdByEventId.get(id)).find(Boolean);
    return factId ? { ...issue, sourceFactId: factId } : issue;
  });
}

function buildCanonicalFactCalculationLedger(clinicalEvents = [], { preprocessing = null } = {}) {
  const canonicalClinicalFactsForCalculation = normalizeCanonicalClinicalFacts(
    canonicalClinicalFactsFromEvents(clinicalEvents, { preprocessing })
  );
  const billingIntentsForCalculation = billingIntentsFromCanonicalClinicalFacts(canonicalClinicalFactsForCalculation);
  const clinicalEventsForCalculation = attachBillingIntentsToClinicalEvents(clinicalEventsFromCanonicalClinicalFacts(
    canonicalClinicalFactsForCalculation,
    clinicalEvents
  ), billingIntentsForCalculation);
  return {
    canonicalClinicalFactsForCalculation,
    clinicalEventsForCalculation,
    billingIntentsForCalculation
  };
}

const CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES = Object.freeze([
  "eligible_for_master_search",
  "eligible_for_billing"
]);

function billingIntentsFromCanonicalClinicalFacts(facts = []) {
  return normalizeBillingIntents(asArray(facts)
    .filter((fact) => canonicalFactCanProceedToAutomaticBillingFact(fact))
    .map((fact) => {
      const sourceFactId = String(fact?.factId || fact?.fact_id || "").trim();
      const intentType = billingIntentTypeFromFact(fact);
      return {
        billingIntentId: `intent_${candidateIdPart([sourceFactId, intentType].join("_"))}`,
        sourceFactId,
        intentType,
        conceptId: String(fact?.conceptId || fact?.concept_id || "").trim(),
        eventType: String(fact?.eventType || fact?.event_type || "").trim(),
        billingDomain: String(fact?.billingDomain || fact?.billing_domain || "").trim(),
        clinicalName: String(fact?.clinicalName || fact?.clinical_name || "").trim(),
        evidenceRefs: asArray(fact?.evidenceRefs || fact?.evidence_refs),
        status: "ready_for_master_linking",
        source: "canonical_clinical_fact"
      };
    }));
}

function normalizeBillingIntents(values = []) {
  const seen = new Set();
  const result = [];
  for (const intent of asArray(values)) {
    if (!intent || typeof intent !== "object") {
      continue;
    }
    const key = [
      intent.billingIntentId,
      intent.sourceFactId,
      intent.intentType
    ].join("|");
    if (!intent.sourceFactId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(intent);
  }
  return result.slice(0, 120);
}

function billingIntentTypeFromFact(fact = {}) {
  const type = String(fact?.eventType || fact?.event_type || "").trim();
  if (type === "lab" || type === "exam") return "lab_test";
  if (type === "imaging") return "imaging_order";
  if (type === "medication") return "medication_order";
  if (type === "material") return "material_input";
  if (type === "procedure" || type === "treatment") return "procedure_code";
  if (type === "management" || type === "counseling") return "management_review";
  return "clinical_event";
}

function canonicalFactCanProceedToAutomaticBillingFact(fact = {}) {
  const status = String(fact?.status || "").trim();
  const verificationStatus = String(fact?.verification?.status || fact?.verificationStatus || fact?.verification_status || "").trim();
  return CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES.includes(status)
    && verificationStatus === "verified";
}

function attachBillingIntentsToClinicalEvents(events = [], billingIntents = []) {
  const intentByFactId = new Map(asArray(billingIntents)
    .map((intent) => [String(intent.sourceFactId || "").trim(), intent])
    .filter(([factId]) => factId));
  return asArray(events).map((event) => {
    const factId = sourceFactIdFromClinicalEvent(event);
    const intent = factId ? intentByFactId.get(factId) : null;
    if (!intent) {
      return event;
    }
    return {
      ...event,
      billingIntentId: intent.billingIntentId,
      sourceBillingIntentId: intent.billingIntentId,
      billingIntentType: intent.intentType
    };
  });
}

function sourceFactIdFromClinicalEvent(event = {}) {
  return String(event?.canonicalFactId || event?.sourceFactId || event?.source_fact_id || "").trim();
}

function sourceBillingIntentIdFromClinicalEvent(event = {}) {
  return String(event?.billingIntentId || event?.sourceBillingIntentId || event?.source_billing_intent_id || "").trim();
}

function canonicalFactStatusFromClinicalEvent(event = {}) {
  return String(event?.canonicalFactStatus || event?.canonical_fact_status || "").trim();
}

function canonicalFactCanProceedToAutomaticBilling(event = {}) {
  const status = canonicalFactStatusFromClinicalEvent(event);
  return CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES.includes(status)
    && String(event?.evidenceVerificationStatus || "").trim() === "verified";
}

function canonicalFactBlocksAutomaticBilling(event = {}) {
  if (!isBillableClinicalEvent(event) || reviewOnlyClinicalEventDomain(event)) {
    return false;
  }
  return !canonicalFactCanProceedToAutomaticBilling(event);
}

function reviewIssueFromCanonicalFactGate(event = {}) {
  const name = clinicalEventName(event) || "抽出結果";
  const status = canonicalFactStatusFromClinicalEvent(event) || "unknown";
  const verificationStatus = String(event?.evidenceVerificationStatus || "unknown").trim();
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, sourceFactIdFromClinicalEvent(event), "canonical_fact_gate"].join("_"))}`,
    issueCode: "canonical_fact_verification_required",
    severity: "warning",
    title: "根拠確認",
    messageForStaff: `根拠確認: ${name}は検証済み臨床事実として自動算定条件を満たしていません。自動算定には入れず、当日・自院・実施済みの根拠と算定条件を確認してください。`,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    evidence: clinicalEventEvidence(event),
    requiredInput: "当日実施、自院実施、予定・過去・他院情報ではないこと、マスター候補",
    source: "canonical_fact_gate",
    policy: {
      riskGate: "review_only",
      canonicalFactStatus: status,
      evidenceVerificationStatus: verificationStatus
    }
  }, "evidence_verification_check");
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
  const normalizedQueries = uniqueStrings(queries).filter((value) => value.length >= 2);
  const searchInputs = normalizedQueries.map((query) => ({ type: "procedure", query, limit: 20 }));
  const searchResults = typeof feeCalculator.searchMasterMany === "function"
    ? await feeCalculator.searchMasterMany(searchInputs)
    : await Promise.all(searchInputs.map((input) => feeCalculator.searchMaster(input).catch(() => null)));
  for (const [index, query] of normalizedQueries.entries()) {
    try {
      const result = searchResults[index];
      if (!result || result.error) {
        continue;
      }
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

function candidateProposalsFromSpecificDiseaseOpportunities({
  diagnoses = [],
  clinicalEvents = [],
  visitMedication = null,
  clinicalText = ""
} = {}) {
  const target = specificDiseaseTargetFromDiagnoses(diagnoses);
  if (!target) {
    return [];
  }
  const managementEvidence = currentSpecificDiseaseManagementEvidence(clinicalEvents);
  const proposals = [];
  if (managementEvidence) {
    proposals.push(reviewOnlyIncreaseProposal({
      proposalId: `specific_disease_management_${candidateIdPart([target.name, managementEvidence.name, managementEvidence.evidence].join("_"))}`,
      title: "特定疾患療養管理料の確認",
      reason: `${target.name}を主病として管理・指導した可能性があります。対象疾患、管理主体、療養計画、同月履歴を確認してください。`,
      conditionText: "対象疾患に該当し、療養上の管理・指導を診療録に記録し、同月算定条件を満たす場合に算定候補になります。自動では点数に入れていません。",
      evidence: managementEvidence.evidence,
      potentialPoints: 225,
      orderType: "procedure",
      source: "specific_disease_management_opportunity",
      topicCode: "target_disease_check",
      requiredInput: "対象疾患、主病管理、療養計画・指導記録、同月算定履歴",
      resolutionOptions: REVIEW_TOPIC_RESOLUTION_OPTIONS.target_disease_check
    }));
  }
  const longPrescriptionEvidence = longTermSpecificDiseasePrescriptionEvidence({
    clinicalEvents,
    visitMedication,
    clinicalText
  });
  if (longPrescriptionEvidence) {
    proposals.push(reviewOnlyIncreaseProposal({
      proposalId: `specific_disease_prescription_management_${candidateIdPart([target.name, longPrescriptionEvidence.evidence].join("_"))}`,
      title: "特定疾患処方管理加算の確認",
      reason: `${target.name}の患者に長期処方がある可能性があります。処方日数、主病、同月履歴を確認してください。`,
      conditionText: "特定疾患を主病として管理しており、処方日数などの要件を満たす場合に算定候補になります。自動では点数に入れていません。",
      evidence: longPrescriptionEvidence.evidence,
      potentialPoints: 56,
      orderType: "medication",
      source: "specific_disease_prescription_opportunity",
      topicCode: "same_month_check",
      requiredInput: "対象疾患、処方日数、同月算定履歴、院内/院外処方の区分",
      resolutionOptions: REVIEW_TOPIC_RESOLUTION_OPTIONS.same_month_check
    }));
  }
  return normalizeCandidateProposals(proposals);
}

function specificDiseaseTargetFromDiagnoses(diagnoses = []) {
  for (const diagnosis of asArray(diagnoses)) {
    const name = normalizeClinicalText(diagnosis?.name || diagnosis?.diagnosisName || diagnosis);
    const status = normalizeClinicalText(diagnosis?.status || "");
    if (!name || /既往|家族歴|疑い/u.test(status)) {
      continue;
    }
    if (SPECIFIC_DISEASE_TARGET_PATTERNS.some((pattern) => pattern.test(name))) {
      return { name };
    }
  }
  return null;
}

function currentSpecificDiseaseManagementEvidence(clinicalEvents = []) {
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
  title,
  reason,
  conditionText,
  evidence = "",
  potentialPoints = 0,
  orderType = "procedure",
  source = "increase_opportunity",
  topicCode = "",
  requiredInput = "",
  resolutionOptions = []
} = {}) {
  return {
    proposalId,
    title,
    reason,
    conditionText,
    basis: "カルテ本文と病名から、算定漏れの可能性として抽出しました。条件確認が必要なため自動算定には入れていません。",
    evidence,
    actionType: "not_billable_now",
    potentialPoints: Number(potentialPoints || 0),
    orderType,
    source,
    policy: {
      generationSource: "conditional_independent",
      riskGate: "review_only",
      requiredInput
    },
    resolutionOptions: asArray(resolutionOptions)
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
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
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
    outcome: search?.item?.code ? "matched" : search?.error ? "error" : search?.ambiguousCandidates?.length ? "ambiguous" : "no_match",
    inspectedCount: Number(search?.inspectedCount || 0),
    selectedCode: search?.item?.code ? String(search.item.code) : "",
    filteredCandidates: asArray(search?.filteredCandidates).slice(0, 5),
    ambiguousCandidates: asArray(search?.ambiguousCandidates).slice(0, 5),
    ambiguityReason: search?.ambiguityReason || "",
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
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
    canonicalFactStatus: canonicalFactStatusFromClinicalEvent(event) || "",
    evidenceVerificationStatus: event?.evidenceVerificationStatus || "",
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
      sourceFactId: sourceFactIdFromClinicalEvent(event) || candidate.sourceFactId || "",
      sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event) || candidate.sourceBillingIntentId || "",
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
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
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
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
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
    sourceFactId: sourceFactIdFromClinicalEvent(event),
    sourceBillingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
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

function reviewIssueFromVisitTypeFact(visitType = {}) {
  if (!visitType || typeof visitType !== "object") {
    return null;
  }
  const kind = String(visitType.kind || "").trim();
  const confidence = String(visitType.confidence || "").trim();
  if (kind && kind !== "unknown" && confidence !== "low") {
    return null;
  }
  const evidence = normalizeClinicalText(visitType.evidence || "");
  const messageForStaff = "初診/再診確認: 初診か再診かを構造化抽出だけでは確定できません。患者の受診履歴、今回病名との継続性、紹介・新疾患初診の扱いを確認してください。";
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart(["visit_type", kind || "unknown", confidence || "unknown", evidence].join("_"))}`,
    issueCode: "visit_type_unknown",
    severity: "warning",
    title: "初診/再診確認",
    messageForStaff,
    requiredInput: "患者の過去受診履歴、今回病名との継続性、初診/再診の扱い",
    evidence,
    source: "visit_type_rule"
  }, "visit_type_check");
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
    if (
      isFutureOrOrderOnlyContext(sentence)
      || isNegatedClinicalServiceContext(sentence)
      || isPastOrExternalClinicalServiceContext(sentence)
    ) {
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
        const localState = localContrastState(sentence, "mri");
        const contrastState = localState === "absent" && chartLevelUnknownContrastStateForKind(text, "mri") === "unknown"
          ? "unknown"
          : localState;
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
          reviewWarnings.push("機器区分確認: MRI検査は機器区分が施設プロファイルまたはカルテ本文から確定できないため、機器区分を確認してください。");
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
        const localState = localContrastState(sentence, "ct");
        const contrastState = localState === "absent" && chartLevelUnknownContrastStateForKind(text, "ct") === "unknown"
          ? "unknown"
          : localState;
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
          reviewWarnings.push("機器区分確認: CT検査は機器区分が施設プロファイルまたはカルテ本文から確定できないため、機器区分を確認してください。");
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
          radiography_diagnostic_kind: "simple_i",
          projection_count: simpleRadiographyProjectionCount(sentence)
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
  if (isOutsidePrescriptionEvidence(text)) {
    return "outside_prescription";
  }
  return "in_house";
}

function medicationDeliveryKindFromStructuredOrText(visitMedication = null, text = "") {
  const structured = String(visitMedication?.delivery_kind || "").trim();
  if (["in_house", "outside_prescription"].includes(structured)) {
    return structured;
  }
  return inferMedicationDeliveryKind(text);
}

function medicationOptionsFromVisitFacts(visitFacts = {}) {
  if (!isPlainObject(visitFacts)) {
    return null;
  }
  const outsidePrescriptionIssued = String(visitFacts.outside_prescription_issued || "").trim();
  if (outsidePrescriptionIssued === "no") {
    return {
      delivery_kind: "in_house",
      prescription_category: "other"
    };
  }
  if (outsidePrescriptionIssued !== "yes") {
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

function medicationOptionsDecisionFromVisitFacts(visitFacts = {}, {
  clinicalText = "",
  clinicalEvents = [],
  medicationOrders = []
} = {}) {
  const options = medicationOptionsFromVisitFacts(visitFacts);
  if (!options) {
    return { options: null, reviewIssue: null, trace: null };
  }
  if (options.delivery_kind === "in_house") {
    return {
      options,
      reviewIssue: null,
      trace: {
        stage: "visit_facts_consistency",
        outcome: "accepted",
        message: "outside_prescription_visit_fact_no_in_house",
        visitFacts: compactVisitFactsForTrace(visitFacts)
      }
    };
  }
  const evidence = String(visitFacts?.prescription_evidence || "").trim();
  const support = outsidePrescriptionEvidenceSupportFromClinicalText({
    evidence,
    clinicalText
  });
  const evidenceQuoted = support.quoted;
  const evidenceSupportsOutside = support.supported;
  const evidenceConflictsWithOutside = support.conflictsWithOutside;
  const hasInHouseMedication = asArray(clinicalEvents).some((event) => (
    normalizeClinicalEventType(event) === "medication"
    && isInHousePrescriptionEvidence(clinicalEventEvidence(event))
  ));

  if (!evidenceSupportsOutside || evidenceConflictsWithOutside) {
    return {
      options: null,
      reviewIssue: reviewIssueFromMedicationDeliveryConflict({
        evidence,
        reason: evidenceQuoted
          ? "outside_prescription_evidence_not_supported"
          : "outside_prescription_evidence_not_quoted",
        hasInHouseMedication,
        medicationOrderCount: asArray(medicationOrders).length
      }),
      trace: null
    };
  }

  if (hasInHouseMedication) {
    return {
      options: null,
      reviewIssue: reviewIssueFromMedicationDeliveryConflict({
        evidence,
        reason: "outside_prescription_with_in_house_medication_event",
        hasInHouseMedication: true,
        medicationOrderCount: asArray(medicationOrders).length
      }),
      trace: null
    };
  }

  return {
    options,
    reviewIssue: null,
    trace: {
      stage: "visit_facts_consistency",
      outcome: "accepted",
      message: "outside_prescription_visit_fact_verified",
      evidenceSupport: support.reason,
      visitFacts: compactVisitFactsForTrace(visitFacts)
    }
  };
}

function outsidePrescriptionEvidenceSupportFromClinicalText({
  evidence = "",
  clinicalText = ""
} = {}) {
  const rawEvidence = String(evidence || "").trim();
  if (!rawEvidence) {
    return {
      supported: false,
      quoted: false,
      conflictsWithOutside: false,
      reason: "missing_prescription_evidence"
    };
  }
  const normalizedText = normalizeClinicalText(clinicalText);
  const candidates = clinicalEventEvidenceQuoteCandidates(rawEvidence);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeClinicalText(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    const quoted = normalizedText.includes(normalizedCandidate);
    if (!quoted) {
      continue;
    }
    const unsafeContext = isUnsafePrescriptionEvidenceContext(candidate);
    return {
      supported: isOutsidePrescriptionEvidence(candidate) && !unsafeContext,
      quoted: true,
      conflictsWithOutside: isInHousePrescriptionEvidence(candidate),
      reason: unsafeContext ? "unsafe_prescription_evidence_context" : "exact_prescription_evidence_quote"
    };
  }

  const evidenceLooksOutside = candidates.some((candidate) => isOutsidePrescriptionEvidence(candidate));
  const evidenceLooksInHouse = candidates.some((candidate) => isInHousePrescriptionEvidence(candidate));
  if (!evidenceLooksOutside || evidenceLooksInHouse) {
    return {
      supported: false,
      quoted: false,
      conflictsWithOutside: evidenceLooksInHouse,
      reason: evidenceLooksInHouse ? "evidence_conflicts_with_outside_prescription" : "evidence_not_outside_prescription"
    };
  }

  for (const sentence of splitClinicalSentences(clinicalText)) {
    if (!isOutsidePrescriptionEvidence(sentence) || isInHousePrescriptionEvidence(sentence)) {
      continue;
    }
    if (isUnsafePrescriptionEvidenceContext(sentence)) {
      continue;
    }
    const normalizedSentence = normalizeClinicalText(sentence);
    const overlaps = candidates.some((candidate) => {
      const normalizedCandidate = normalizeClinicalText(candidate);
      if (!normalizedCandidate || !normalizedSentence) {
        return false;
      }
      return normalizedSentence.includes(normalizedCandidate)
        || normalizedCandidate.includes(normalizedSentence)
        || outsidePrescriptionCoreEvidenceMatches(normalizedCandidate, normalizedSentence)
        || prescriptionEvidenceTokenOverlap(normalizedCandidate, normalizedSentence) >= 2;
    });
    if (overlaps) {
      return {
        supported: true,
        quoted: true,
        conflictsWithOutside: false,
        reason: "approximate_prescription_evidence_sentence"
      };
    }
  }

  return {
    supported: false,
    quoted: false,
    conflictsWithOutside: false,
    reason: "prescription_evidence_not_found_in_clinical_text"
  };
}

function outsidePrescriptionCoreEvidenceMatches(left = "", right = "") {
  const hasPrescriptionSubject = (text) => /(?:院外処方(?:箋)?|処方箋|処方せん)/u.test(text);
  const hasPrescriptionAction = (text) => /(?:交付|発行|出した|発行した|交付した)/u.test(text);
  return hasPrescriptionSubject(left)
    && hasPrescriptionSubject(right)
    && hasPrescriptionAction(left)
    && hasPrescriptionAction(right);
}

function isUnsafePrescriptionEvidenceContext(text = "") {
  const normalized = normalizeClinicalText(text)
    // "院外処方" is the target structured fact, not other-provider context.
    .replace(/院外処方(?:箋)?/gu, "処方箋");
  return isFutureOrOrderOnlyContext(normalized) || isPastOrExternalClinicalServiceContext(normalized);
}

function prescriptionEvidenceTokenOverlap(left = "", right = "") {
  const rightText = String(right || "");
  return uniqueStrings(String(left || "")
    .split(/[、。，．\s（）()【】「」:：/]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 16))
    .reduce((count, token) => count + (rightText.includes(token) ? 1 : 0), 0);
}

function reviewIssueFromMedicationDeliveryConflict({
  evidence = "",
  reason = "",
  hasInHouseMedication = false,
  medicationOrderCount = 0
} = {}) {
  const detail = hasInHouseMedication || medicationOrderCount
    ? " 院内処方として解決できる薬剤イベントがあるため、院外処方箋料を自動追加しません。"
    : " 院外処方箋交付の根拠が確認できないため、院外処方箋料を自動追加しません。";
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart(["medication_delivery", reason, evidence].join("_"))}`,
    issueCode: "medication_delivery_unknown",
    severity: "warning",
    title: "院内外処方確認",
    messageForStaff: `院内外処方確認: visit_factsは院外処方を示していますが、根拠引用が院外処方箋交付として確認できません。${detail}`,
    evidence,
    source: "visit_facts_consistency",
    details: {
      reason,
      hasInHouseMedication,
      medicationOrderCount
    }
  }, "medication_delivery_check");
}

function isOutsidePrescriptionEvidence(text = "") {
  const value = String(text || "");
  if (isNegatedOutsidePrescriptionEvidence(value)) {
    return false;
  }
  if (/(?:院外処方(?:箋)?|処方箋|処方せん).{0,12}(?:検討|予定|次回|希望のみ|相談のみ)/u.test(value)) {
    return false;
  }
  return /(?:院外処方(?:箋)?|院外処方(?:箋)?.{0,8}(?:交付|発行|あり|有り|行う|行った|交付した|発行した)|処方箋(?:を)?(?:交付|発行)|処方せん(?:を)?(?:交付|発行))/u.test(value);
}

function isNegatedOutsidePrescriptionEvidence(text = "") {
  const value = String(text || "");
  return /(?:院外処方(?:箋)?|処方箋|処方せん).{0,12}(?:交付していない|交付せず|交付なし|交付無し|発行していない|発行せず|発行なし|発行無し|出していない|出さず|なし|無し|ない|無い)/u.test(value)
    || /(?:交付|発行).{0,8}(?:していない|せず|なし|無し|ない|無い).{0,8}(?:院外処方(?:箋)?|処方箋|処方せん)/u.test(value);
}

function isInHousePrescriptionEvidence(text = "") {
  return /(院内(?:で|処方|投薬)|院内外用薬|院内処方|院内で外用薬として処方)/u.test(String(text || ""));
}

function compactVisitFactsForTrace(visitFacts = {}) {
  if (!isPlainObject(visitFacts)) {
    return null;
  }
  return {
    outside_prescription_issued: String(visitFacts.outside_prescription_issued || ""),
    generic_name_prescription: String(visitFacts.generic_name_prescription || ""),
    prescription_evidence: String(visitFacts.prescription_evidence || "").slice(0, 100)
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
  const reviewIssues = [];
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
    if (
      status === "performed_today"
      && !checklistPerformedEvidenceSupportsCurrentService(evidence)
    ) {
      reviewIssues.push(reviewIssueFromUnsafeChecklistRecovery({ menu, finding }));
      traceEvents.push({
        stage: "checklist_recall",
        outcome: "blocked",
        menuId,
        status,
        label: menu?.label || "",
        message: "checklist_performed_evidence_negated_or_not_current"
      });
      continue;
    }
    const matchedExisting = existing.find((event) => clinicalEventMatchesChecklistMenu(event, menu));
    if (matchedExisting) {
      const shouldEnrich = status === "performed_today";
      const enriched = shouldEnrich ? enrichClinicalEventWithChecklistMenu(matchedExisting, menu) : false;
      traceEvents.push({
        stage: "checklist_recall",
        outcome: enriched
          ? "enriched_existing"
          : (shouldEnrich ? "already_extracted" : "matched_existing_without_enrichment"),
        menuId,
        status,
        label: menu.label || "",
        eventName: clinicalEventName(matchedExisting)
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
    reviewIssues: dedupeObjects(reviewIssues, (issue) => issue.reviewIssueId),
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

function checklistPerformedEvidenceSupportsCurrentService(evidence = "") {
  const text = normalizeClinicalText(evidence);
  if (!text) {
    return false;
  }
  return splitClinicalSentences(text).some((sentence) => {
    const normalized = normalizeClinicalText(sentence);
    if (!normalized || isClinicalMetaSentence(normalized)) {
      return false;
    }
    return !(
      isNegatedClinicalServiceContext(normalized)
      || isFutureOrOrderOnlyContext(normalized)
      || isPastOrExternalClinicalServiceContext(normalized)
    );
  });
}

function reviewIssueFromUnsafeChecklistRecovery({ menu = {}, finding = {} } = {}) {
  const name = String(menu.label || menu.name || "確認項目").trim();
  const evidence = String(finding?.evidence || "").trim();
  const evidencePart = evidence ? ` 根拠引用: ${evidence}` : "";
  const messageForStaff = `抽出結果確認: ${name}はチェックリストでは今回実施として返されましたが、根拠引用に未実施・予定・過去・他院を示す文脈があります。自動算定には入れず、カルテ上の実施事実を確認してください。${evidencePart}`;
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart(["unsafe_checklist_recovery", menu.menuId || menu.menu_id, evidence].join("_"))}`,
    issueCode: "clinical_event_conflict",
    severity: "warning",
    title: "抽出結果確認",
    messageForStaff,
    evidence,
    source: "checklist_recall"
  }, "clinical_event_conflict_check");
}

function supersededClinicalEventIdsFromCompositeChecklistRecovery({
  existingEvents = [],
  recoveredEvents = []
} = {}) {
  const compositeMenuIds = new Set();
  for (const event of asArray(recoveredEvents)) {
    for (const menuId of [
      ...asArray(event?.checklistMenuIds),
      ...asArray(event?.checklist_menu_ids)
    ]) {
      if (String(menuId || "") === "lab:covid_flu_antigen") {
        compositeMenuIds.add("lab:covid_flu_antigen");
      }
    }
  }
  if (!compositeMenuIds.size) {
    return new Set();
  }
  const result = new Set();
  for (const event of asArray(existingEvents)) {
    if (compositeMenuIds.has("lab:covid_flu_antigen") && isCovidOrInfluenzaComponentLabEvent(event)) {
      result.add(clinicalEventIdentity(event));
    }
  }
  return result;
}

function isCovidOrInfluenzaComponentLabEvent(event = {}) {
  if (!["lab", "exam"].includes(normalizeClinicalEventType(event))) {
    return false;
  }
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
  const hasViralTarget = /(COVID|SARS|コロナ|新型コロナ|インフル|influenza|flu)/iu.test(text);
  const hasTestContext = /(抗原|迅速|検査|陽性|陰性|判定)/u.test(text);
  return hasViralTarget && hasTestContext;
}

function clinicalEventMatchesChecklistMenu(event = {}, menu = {}) {
  const menuType = String(menu.eventType || menu.type || menu.kind || "").trim();
  const menuDomain = String(menu.billingDomain || menu.billing_domain || "").trim();
  const eventType = normalizeClinicalEventType(event);
  const eventDomain = normalizeClinicalEventBillingDomain(event);
  const eventName = normalizeClinicalText(clinicalEventName(event));
  const eventText = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
  const label = normalizeClinicalText(menu.label || menu.name || "");
  const query = normalizeClinicalText(menu.query || "");
  if (menu.compositeConcept) {
    return Boolean(
      (label && eventName.includes(label))
      || (query && eventText.includes(query))
      || asArray(event.checklistMenuIds).includes(menu.menuId || menu.menu_id)
      || asArray(event.checklist_menu_ids).includes(menu.menuId || menu.menu_id)
    );
  }
  if (menuDomain && menuDomain === eventDomain) {
    if (menu.kind === "domain") {
      return true;
    }
    if (menuType && !clinicalChecklistEventTypesEquivalent(menuType, eventType)) {
      return false;
    }
  }
  if (label && eventName.includes(label)) {
    return true;
  }
  const matchTerms = uniqueStrings(asArray(menu.matchTerms)).map((term) => normalizeClinicalText(term)).filter(Boolean);
  if (matchTerms.length && matchTerms.some((term) => eventText.includes(term))) {
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

function clinicalChecklistEventTypesEquivalent(a = "", b = "") {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right || left === right) {
    return true;
  }
  const groups = [
    new Set(["procedure", "treatment"]),
    new Set(["exam", "lab"]),
    new Set(["exam", "imaging"])
  ];
  return groups.some((group) => group.has(left) && group.has(right));
}

function enrichClinicalEventWithChecklistMenu(event = {}, menu = {}) {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (menu.kind === "lab_group") {
    return false;
  }
  const additions = uniqueStrings([
    menu.query,
    menu.name,
    menu.label,
    ...asArray(menu.searchQueries),
    ...asArray(menu.search_queries)
  ]).filter(Boolean);
  if (!additions.length) {
    return false;
  }
  const current = uniqueStrings([
    ...asArray(event.search_queries),
    ...asArray(event.searchQueries)
  ]);
  const merged = uniqueStrings([...current, ...additions]).slice(0, 12);
  const changed = merged.length !== current.length || merged.some((value, index) => value !== current[index]);
  if (changed) {
    event.search_queries = merged;
    event.searchQueries = merged;
  }
  const menuIds = uniqueStrings([
    ...asArray(event.checklistMenuIds),
    ...asArray(event.checklist_menu_ids),
    menu.menuId || menu.menu_id
  ]).filter(Boolean);
  if (menuIds.length) {
    event.checklistMenuIds = menuIds;
    event.checklist_menu_ids = menuIds;
  }
  return changed;
}

function checklistFindingToClinicalEvent({ finding = {}, menu = {}, index = 0 } = {}) {
  const status = normalizeChecklistFindingStatus(finding.status);
  const checklistMenuIds = uniqueStrings([menu.menuId || menu.menu_id]).filter(Boolean);
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
    checklistMenuIds,
    checklist_menu_ids: checklistMenuIds,
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

function canonicalClinicalFactsFromEvents(events = [], {
  billingCandidates = [],
  reviewIssues = [],
  masterCandidates = [],
  preprocessing = null
} = {}) {
  const billableEventIds = new Set(asArray(billingCandidates)
    .map((candidate) => String(candidate?.clinicalEventId || candidate?.clinical_event_id || "").trim())
    .filter(Boolean));
  const reviewEventIds = new Set();
  for (const issue of asArray(reviewIssues)) {
    for (const id of [
      issue?.relatedClinicalEventId,
      issue?.clinicalEventId,
      ...asArray(issue?.relatedClinicalEventIds),
      ...asArray(issue?.relatedEventIds)
    ]) {
      const normalized = String(id || "").trim();
      if (normalized) {
        reviewEventIds.add(normalized);
      }
    }
  }
  const masterEventIds = new Set(asArray(masterCandidates)
    .map((candidate) => String(candidate?.clinicalEventId || candidate?.clinical_event_id || "").trim())
    .filter(Boolean));

  return asArray(events)
    .map((event, index) => normalizeClinicalEvent(event, index))
    .filter(Boolean)
    .map((event) => {
      const eventId = clinicalEventIdentity(event);
      const eligible = isBillableClinicalEvent(event) && !reviewOnlyClinicalEventDomain(event);
      const verification = verifyClinicalEventEvidence(event, preprocessing);
      const status = verification.status === "blocked"
        ? "excluded"
        : verification.status === "review_required"
          ? "review_required"
          : reviewEventIds.has(eventId)
            ? "review_required"
            : billableEventIds.has(eventId)
              ? "eligible_for_billing"
              : eligible
                ? "eligible_for_master_search"
                : "excluded";
      return {
        factId: `fact_${candidateIdPart(eventId || [event.type, event.name, event.evidence].join("_"))}`,
        clinicalEventId: eventId,
        conceptId: canonicalClinicalFactConceptId(event),
        eventType: normalizeClinicalEventType(event),
        billingDomain: normalizeClinicalEventBillingDomain(event),
        clinicalName: clinicalEventName(event),
        status,
        actionStatus: event.actionStatus,
        temporalRelation: event.temporalRelation,
        sourceOrigin: event.sourceOrigin,
        providerOwnership: event.providerOwnership,
        resultAssertion: event.resultAssertion,
        certainty: event.certainty,
        evidenceRefs: verification.evidenceRefs,
        normalization: {
          modality: event.modality || "none",
          bodySite: event.body_site || "",
          specimen: event.specimen || "",
          collectionMethod: event.collection_method || "",
          areaSizeCm2: event.area_size_cm2 || "",
          quantityPerDay: event.quantity_per_day || "",
          days: event.days || "",
          totalQuantity: event.total_quantity || ""
        },
        extraction: {
          source: event.source || event.extractionSource || "llm_clinical_event",
          registryVersion: FEE_CONCEPT_REGISTRY_VERSION,
          masterCandidateAvailable: masterEventIds.has(eventId)
        },
        verification: {
          status: verification.status,
          reasons: verification.reasons,
          checkedAtRuleSetVersion: verification.checkedAtRuleSetVersion
        }
      };
    });
}

function evidenceVerificationSummary(facts = []) {
  const counts = {};
  for (const fact of asArray(facts)) {
    const status = String(fact?.verification?.status || "unknown");
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return counts;
}

function canonicalClinicalFactConceptId(event = {}) {
  const type = normalizeClinicalEventType(event);
  const labConcept = labConceptsFromClinicalEventName(event)[0];
  if (labConcept?.key) {
    return `lab:${labConcept.key}`;
  }
  const billingDomain = normalizeClinicalEventBillingDomain(event, { type });
  const name = candidateIdPart(clinicalEventName(event) || billingDomain || type || "unknown");
  return `${billingDomain || type || "unknown"}:${name}`;
}

function clinicalEventsFromCanonicalClinicalFacts(facts = [], events = []) {
  const eventsById = new Map();
  for (const [index, event] of asArray(events).entries()) {
    const normalized = normalizeClinicalEvent(event, index);
    const eventId = normalized ? clinicalEventIdentity(normalized) : "";
    if (eventId) {
      eventsById.set(eventId, normalized);
    }
  }
  return asArray(facts)
    .map((fact, index) => {
      const eventId = String(fact?.clinicalEventId || fact?.clinical_event_id || "").trim();
      const original = eventId ? eventsById.get(eventId) : null;
      if (original) {
        return {
          ...original,
          canonicalFactId: fact.factId || fact.fact_id || "",
          sourceFactId: fact.factId || fact.fact_id || "",
          canonicalFactStatus: fact.status || "unknown",
          conceptId: fact.conceptId || fact.concept_id || original.conceptId || null,
          evidenceRefs: asArray(fact.evidenceRefs || fact.evidence_refs),
          evidenceVerificationStatus: fact?.verification?.status || "unknown",
          evidenceVerificationReasons: asArray(fact?.verification?.reasons)
        };
      }
      const evidenceRef = asArray(fact?.evidenceRefs || fact?.evidence_refs)[0] || {};
      const normalization = isPlainObject(fact?.normalization) ? fact.normalization : {};
      const reconstructed = normalizeClinicalEvent({
        clinical_event_id: eventId || `canonical_fact_${index + 1}`,
        type: fact?.eventType || fact?.event_type || "other",
        billing_domain: fact?.billingDomain || fact?.billing_domain || "unknown",
        name: fact?.clinicalName || fact?.clinical_name || "",
        action_status: fact?.actionStatus || fact?.action_status || "unknown",
        temporal_relation: fact?.temporalRelation || fact?.temporal_relation || "unknown",
        source_origin: fact?.sourceOrigin || fact?.source_origin || "unknown",
        provider_ownership: fact?.providerOwnership || fact?.provider_ownership || "unknown",
        result_assertion: fact?.resultAssertion || fact?.result_assertion || "unknown",
        certainty: fact?.certainty || "ambiguous",
        section: evidenceRef.section || "unknown",
        evidence: evidenceRef.quote || "",
        modality: normalization.modality || "none",
        body_site: normalization.bodySite || normalization.body_site || "",
        specimen: normalization.specimen || "",
        collection_method: normalization.collectionMethod || normalization.collection_method || "",
        area_size_cm2: normalization.areaSizeCm2 || normalization.area_size_cm2 || "",
        quantity_per_day: normalization.quantityPerDay || normalization.quantity_per_day || "",
        days: normalization.days || "",
        total_quantity: normalization.totalQuantity || normalization.total_quantity || "",
        source: fact?.extraction?.source || "canonical_clinical_fact"
      }, index);
      if (!reconstructed) {
        return null;
      }
      return {
        ...reconstructed,
        canonicalFactId: fact.factId || fact.fact_id || "",
        sourceFactId: fact.factId || fact.fact_id || "",
        canonicalFactStatus: fact.status || "unknown",
        conceptId: fact.conceptId || fact.concept_id || null,
        evidenceRefs: asArray(fact.evidenceRefs || fact.evidence_refs),
        evidenceVerificationStatus: fact?.verification?.status || "unknown",
        evidenceVerificationReasons: asArray(fact?.verification?.reasons)
      };
    })
    .filter(Boolean);
}

function normalizeCanonicalClinicalFacts(values = []) {
  const seen = new Set();
  const result = [];
  for (const fact of asArray(values)) {
    if (!fact || typeof fact !== "object") {
      continue;
    }
    const key = [
      fact.factId,
      fact.clinicalEventId,
      fact.status,
      fact.clinicalName
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(fact);
  }
  return result.slice(0, 160);
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

function clinicalEventEvidenceLineIds(event = {}) {
  const candidates = [
    event?.evidence_line_ids,
    event?.evidenceLineIds,
    event?.evidence?.line_ids,
    event?.evidence?.lineIds
  ];
  const result = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      result.push(...candidate);
    } else if (candidate) {
      result.push(candidate);
    }
  }
  return uniqueStrings(result
    .map((value) => String(value || "").trim())
    .filter(Boolean))
    .slice(0, 4);
}

function clinicalEventEvidenceSpan(event = {}) {
  const start = integerLikeValue(event?.char_start)
    ?? integerLikeValue(event?.charStart)
    ?? integerLikeValue(event?.evidence_char_start);
  const end = integerLikeValue(event?.char_end)
    ?? integerLikeValue(event?.charEnd)
    ?? integerLikeValue(event?.evidence_char_end);
  if (start === null || end === null || start < 0 || end <= start) {
    return null;
  }
  return {
    charStart: start,
    charEnd: end
  };
}

function integerLikeValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    return null;
  }
  return Number(text);
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

function clinicalEventEvidenceQuote(event = {}) {
  return String(event?.evidence || "").trim();
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
  if (domain === "home_care" && !hasExplicitHomeCareContext(event)) {
    return "";
  }
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

function hasExplicitHomeCareContext(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.review_reason,
    event?.reviewReason
  ].filter(Boolean).join(" "));
  if (!text) {
    return false;
  }
  return /(在宅医療|在宅患者|在宅療養|訪問診療|往診|訪問看護|自宅訪問|居宅訪問|在宅酸素|在宅自己注射|在宅自己導尿)/u.test(text);
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

function reviewIssuesFromNonBillableLabClinicalEvent(event = {}) {
  if (!isReviewableNonBillableLabClinicalEvent(event)) {
    return [];
  }
  const text = nonBillableLabReviewText(event);
  if (!text || isNegatedClinicalServiceContext(text)) {
    return [];
  }
  const issues = [];
  if (hasMonthlyLabDuplicateReviewContext(text)) {
    issues.push(reviewIssueFromNonBillableLabClinicalEvent(event, "monthly_lab_duplicate_check", {
      message: "同月内検査確認: 同月内の院内検査履歴や重複の有無を確認してください。実施済み検査としては扱わず、自動算定には入れていません。",
      requiredInput: "同月内の検査履歴、重複の有無、当日実施する検査項目"
    }));
  }
  if (hasLabCodeReviewContext(event, text)) {
    issues.push(reviewIssueFromNonBillableLabClinicalEvent(event, "lab_code_check", {
      message: "検査コード確認: 検査名または検査区分が記載されていますが、今回実施済みとしては確定できません。実施する場合は標準コード、検査区分、検体、測定条件を確認してください。",
      requiredInput: "標準コード、検査区分、検体、測定条件、実施有無"
    }));
  }
  return dedupeObjects(issues.filter(Boolean), (issue) => issue.topicCode || issue.issueCode);
}

function reviewIssuesFromNonBillableLabRelatedClinicalEvent(event = {}) {
  if (!isReviewableNonBillableLabRelatedClinicalEvent(event)) {
    return [];
  }
  const text = nonBillableLabReviewText(event);
  if (!text || isNegatedClinicalServiceContext(text) || !hasMonthlyLabDuplicateReviewContext(text)) {
    return [];
  }
  const issue = reviewIssueFromNonBillableLabClinicalEvent(event, "monthly_lab_duplicate_check", {
    message: "同月内検査確認: 同月内の院内検査履歴や重複の有無を確認してください。実施済み検査としては扱わず、自動算定には入れていません。",
    requiredInput: "同月内の検査履歴、重複の有無、当日実施する検査項目"
  });
  return issue ? [issue] : [];
}

function isReviewableNonBillableLabClinicalEvent(event = {}) {
  const type = normalizeClinicalEventType(event);
  if (!["lab", "exam"].includes(type)) {
    return false;
  }
  const status = normalizeClinicalEventStatus(event);
  if (!["planned", "ordered", "considered", "unclear"].includes(status)) {
    return false;
  }
  const dateRelation = normalizeClinicalEventDateRelation(event);
  if (["past", "other_provider"].includes(dateRelation)) {
    return false;
  }
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  if (["same_institution_other_department", "other_department", "other_provider"].includes(providerOwnership)) {
    return false;
  }
  return !isNegatedClinicalEvent(event);
}

function isReviewableNonBillableLabRelatedClinicalEvent(event = {}) {
  const type = normalizeClinicalEventType(event);
  if (!["management", "counseling", "follow_up"].includes(type)) {
    return false;
  }
  const status = normalizeClinicalEventStatus(event);
  if (!["planned", "ordered", "considered", "unclear", "instruction_only"].includes(status)) {
    return false;
  }
  const dateRelation = normalizeClinicalEventDateRelation(event);
  if (["past", "other_provider"].includes(dateRelation)) {
    return false;
  }
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  if (["same_institution_other_department", "other_department", "other_provider"].includes(providerOwnership)) {
    return false;
  }
  return !isNegatedClinicalEvent(event);
}

function nonBillableLabReviewText(event = {}) {
  return normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.review_reason,
    event?.reviewReason,
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
}

function hasMonthlyLabDuplicateReviewContext(text = "") {
  if (/(?:同月|同じ月|月内).{0,20}(?:検査|検体|採血|院内履歴|履歴|重複).{0,12}(?:なし|ない|無い|未実施|行っていない)|(?:検査|検体|採血|院内履歴|履歴|重複).{0,20}(?:同月|同じ月|月内).{0,12}(?:なし|ない|無い|未実施|行っていない)/u.test(text)) {
    return false;
  }
  const hasExplicitMonthOrHistory = /同月|同じ月|月内|院内履歴|履歴照合|履歴の照合|重複の有無|重複/u.test(text);
  const hasIntervalOrRepeatContext = /前回検査|直近検査|前回採血|直近採血|再検|再検査|検査間隔|短期間での検査|前回分|前回値|最近の検査|検査履歴/u.test(text);
  const hasLabContext = /検査|検体|採血|追加検査|検査履歴|院内履歴|HbA1c|ＨｂＡ１ｃ|血糖|グルコース|CRP|ＣＲＰ/u.test(text);
  return (hasExplicitMonthOrHistory || hasIntervalOrRepeatContext) && hasLabContext;
}

function hasLabCodeReviewContext(event = {}, text = "") {
  const hasSpecificLabConcept = labConceptsFromClinicalEventName(event).length > 0 || labConceptsFromText(text).length > 0;
  const hasSpecificLabGroup = labConceptGroupsFromClinicalEventName(event).length > 0 || labConceptGroupsFromText(text).length > 0;
  const hasCodeUncertainty = /検査コード|標準コード|検査項目|検査区分|測定条件|測定方法|検体|方法|依頼先|どれに対応|確定|不明|追えない|分からない|わからない|不足/u.test(text);
  const hasGenericLabReviewContext = /検査|検体|測定|採血/u.test(text) && hasCodeUncertainty;
  return hasSpecificLabConcept || hasSpecificLabGroup || hasGenericLabReviewContext;
}

function reviewIssueFromNonBillableLabClinicalEvent(event = {}, topicCode = "", { message = "", requiredInput = "" } = {}) {
  const topic = reviewTopicDefinition(topicCode);
  if (!topic) {
    return null;
  }
  const name = clinicalEventName(event) || topic.label;
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, topicCode, name, message].join("_"))}`,
    issueCode: topic.issueCode,
    severity: "warning",
    title: topic.label,
    messageForStaff: message,
    requiredInput,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "non_billable_lab_review_gate",
    policy: { riskGate: "review_only", eventType: normalizeClinicalEventType(event) }
  }, topicCode);
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

function reviewIssueFromEvidenceVerificationBlocked(event = {}) {
  const name = clinicalEventName(event) || "抽出結果";
  const reasons = asArray(event.evidenceVerificationReasons);
  const reasonText = reasons.includes("negated_service_context")
    ? "根拠文に未実施・中止・否定の文脈があります。"
    : reasons.includes("future_or_order_only_context")
      ? "根拠文が予定・依頼・検討の文脈です。"
	    : reasons.includes("past_or_external_context")
	      ? "根拠文が過去・他院・持参情報の文脈です。"
	      : reasons.includes("missing_evidence_quote")
	        ? "根拠引用がありません。"
	        : reasons.includes("evidence_quote_not_found")
	          ? "根拠引用をカルテ本文から確認できません。"
	          : reasons.includes("evidence_quote_approximate")
	            ? "根拠引用がカルテ本文と完全一致せず、近い記載への対応づけに留まっています。"
	            : "根拠文と実施扱いに不整合があります。";
  const messageForStaff = `根拠確認: ${name}は実施済み候補として抽出されましたが、${reasonText}自動算定には入れず、カルテ上の当日・自院・実施済みの根拠を確認してください。`;
  return withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, name, "evidence_verifier"].join("_"))}`,
    issueCode: "evidence_verification_required",
    severity: "warning",
    title: "根拠確認",
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    requiredInput: "当日実施、自院実施、予定・過去・他院情報ではないこと",
    source: "evidence_verifier",
    policy: {
      riskGate: "review_only",
      reasons
    }
  }, "evidence_verification_check");
}

function reviewIssuesFromUnsupportedClinicalEvent(event = {}) {
  const messageForStaff = unsupportedClinicalEventWarning(event);
  if (!messageForStaff) {
    return [];
  }
  const primaryIssue = {
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), messageForStaff].join("_"))}`,
    issueCode: "unsupported_event",
    severity: "warning",
    title: clinicalEventName(event) ? `${clinicalEventName(event)}の確認` : "確認事項",
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "clinical_event_rule"
  };
  return [
    primaryIssue,
    ...supplementalReviewIssuesFromClinicalWarning(event, messageForStaff, { source: "clinical_event_rule" })
  ];
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

function reviewIssuesFromManagementClinicalEvent(event = {}, { categoryLabel = "医学管理等" } = {}) {
  const name = clinicalEventName(event);
  const title = name ? `対象疾患確認: ${name}` : `対象疾患確認: ${categoryLabel}`;
  const policy = DERIVED_BILLING_ITEM_POLICIES.management_fee;
  const messageForStaff = `対象疾患確認: ${name || categoryLabel}は管理料・指導料に関係する記載として抽出しました。管理料確認、同月履歴確認、対象疾患、指導・説明の記録、管理主体、施設基準を人手で確認してください。自動算定には入れていません。`;
  const targetDiseaseIssue = withReviewTopic({
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
  const issues = [targetDiseaseIssue];
  if (facilityNotificationReviewNeededForClinicalEvent(event)) {
    const notificationMessage = `届出確認: ${name || categoryLabel}は院内の登録情報・届出状況に関係する記載として抽出しました。対象の届出、施設基準、同月履歴を人手で確認してください。自動算定には入れていません。`;
    issues.push(withReviewTopic({
      reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, "notification_check", notificationMessage].join("_"))}`,
      issueCode: "facility_notification_unknown",
      severity: "warning",
      title: "届出確認",
      messageForStaff: notificationMessage,
      requiredInput: "届出状況、施設基準、同月算定履歴",
      relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
      evidence: clinicalEventEvidence(event),
      source: "management_review_gate",
      policy
    }, "notification_check"));
  }
  if (!carePlanReviewNeededForManagementClinicalEvent(event)) {
    return issues;
  }
  const carePlanMessage = `療養計画確認: ${name || categoryLabel}は管理・指導に関係する記載として抽出しました。療養計画、指導内容、説明記録、同月履歴を人手で確認してください。自動算定には入れていません。`;
  const carePlanIssue = withReviewTopic({
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, "care_plan_check", carePlanMessage].join("_"))}`,
    issueCode: "care_plan_unknown",
    severity: "warning",
    title: "療養計画確認",
    messageForStaff: carePlanMessage,
    requiredInput: "療養計画、指導内容、説明記録、同月算定履歴",
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "management_review_gate",
    policy
  }, "care_plan_check");
  issues.push(carePlanIssue);
  return issues;
}

function facilityNotificationReviewNeededForClinicalEvent(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.review_reason,
    event?.reviewReason,
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
  return /(?:届出|届け出|地方厚生局|院内(?:の)?登録情報|院内登録|登録情報.{0,12}(?:照合|確認|不明|必要)|(?:当院|院内).{0,18}(?:実施|提供|対応|扱える).{0,18}(?:登録|届出|施設)|(?:実施|提供|対応|扱える).{0,18}(?:当院|院内).{0,18}(?:登録|届出|施設))/u.test(text);
}

function carePlanReviewNeededForManagementClinicalEvent(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.review_reason,
    event?.reviewReason,
    ...asArray(event?.search_queries),
    ...asArray(event?.searchQueries)
  ].join(" "));
  return /(療養|計画|指導|説明|教育|管理方針|継続管理|生活指導|服薬指導|栄養指導|運動指導|自己管理|治療方針|注意事項)/u.test(text);
}

function reviewIssuesFromClinicalWarnings(event = {}, warnings = [], { source = "clinical_event_rule" } = {}) {
  return asArray(warnings)
    .flatMap((messageForStaff) => [
      reviewIssueFromClinicalWarning(event, messageForStaff, { source }),
      ...supplementalReviewIssuesFromClinicalWarning(event, messageForStaff, { source })
    ])
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

function supplementalReviewIssuesFromClinicalWarning(event = {}, messageForStaff = "", { source = "clinical_event_rule" } = {}) {
  const message = String(messageForStaff || "").trim();
  if (!message || !isUnresolvedClinicalEventWarning(message)) {
    return [];
  }
  const type = normalizeClinicalEventType(event);
  const topics = [];
  if (type === "injection") {
    topics.push({
      topicCode: "injection_route_check",
      requiredInput: "投与経路、注射方法、実施部位"
    }, {
      topicCode: "medication_amount_check",
      requiredInput: "薬剤名、投与量、希釈量、実施時間"
    });
  }
  if (["procedure", "treatment"].includes(type)) {
    topics.push({
      topicCode: "procedure_detail_check",
      requiredInput: "手技内容、実施方法、使用材料、同日重複の有無"
    });
    if (procedureSiteReviewNeeded(event)) {
      topics.push({
        topicCode: "procedure_site_check",
        requiredInput: "処置部位、左右、対象範囲"
      });
    }
  }
  return dedupeObjects(topics, (topic) => topic.topicCode).map((topic) => {
    const definition = reviewTopicDefinition(topic.topicCode);
    const label = definition?.label || "確認事項";
    const name = clinicalEventName(event) || label;
    const messageForTopic = `${label}: ${name}の算定判断に必要な情報を確認してください。自動算定には入れていません。`;
    return withReviewTopic({
      reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, topic.topicCode, name, source].join("_"))}`,
      issueCode: definition?.issueCode || "needs_review",
      severity: "warning",
      title: label,
      messageForStaff: messageForTopic,
      requiredInput: topic.requiredInput,
      relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
      evidence: clinicalEventEvidence(event),
      source
    }, topic.topicCode);
  });
}

function isUnresolvedClinicalEventWarning(message = "") {
  const text = String(message || "");
  return /標準コードを自動確定できません|マスター検索で確認|複数の標準コード候補|直接候補化できない|要確認/u.test(text);
}

function procedureSiteReviewNeeded(event = {}) {
  const site = String(event?.body_site || event?.bodySite || "").trim();
  if (!site) {
    return true;
  }
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    site
  ].join(" "));
  return /(右|左|両側|眼|耳|鼻|咽頭|角膜|皮膚|創|患部|上肢|下肢|手|足|指|趾|部位)/u.test(text);
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
    const key = issue.topicCode && SINGLETON_REVIEW_TOPIC_CODES.has(issue.topicCode)
      ? `topic|${issue.topicCode}`
      : [
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
    const contrastState = clinicalEventContrastState(event, {
      clinicalText: options.clinicalText,
      imagingKind: "mri"
    });
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
    if (contrastState === "unknown") {
      reviewWarnings.push("造影確認: MRI検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
    }
    if (equipmentKind) {
      order.mri_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("機器区分確認: MRI検査は機器区分が施設プロファイルまたはカルテ本文から確定できないため、機器区分を確認してください。");
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
    const contrastState = clinicalEventContrastState(event, {
      clinicalText: options.clinicalText,
      imagingKind: "ct"
    });
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
    if (contrastState === "unknown") {
      reviewWarnings.push("造影確認: CT検査の造影有無がカルテ本文から確定できません。造影剤を使用したか確認してください。");
    }
    if (equipmentKind) {
      order.ct_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("機器区分確認: CT検査は機器区分が施設プロファイルまたはカルテ本文から確定できないため、機器区分を確認してください。");
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
      radiography_diagnostic_kind: "simple_i",
      projection_count: simpleRadiographyProjectionCount(evidence)
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
  if (isRoutineNonBillableObservationEvent(event)) {
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: [],
      traceEvents: [clinicalTraceEvent({
        stage: "non_billable_observation_skip",
        event,
        categoryLabel,
        outcome: "skipped",
        message: "routine_observation_not_sent_to_master_search"
      })]
    };
  }
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
  return linkProcedureBillingIntentToMaster(feeCalculator, {
    event,
    name,
    categoryLabel,
    queries,
    allowedFeeCategories: options.allowedFeeCategories || allowedDirectRetrievalFeeCategoriesForEvent(event),
    resolvedMessage: options.resolvedMessage || `${name || categoryLabel}を実施済みの${categoryLabel}としてマスター候補に反映しました。算定条件を確認してください。`,
    unresolvedMessage: options.unresolvedMessage || `${name || categoryLabel}は実施済みの${categoryLabel}として抽出しましたが、標準コードを自動確定できませんでした。マスター検索で確認してください。`
  });
}

async function linkProcedureBillingIntentToMaster(feeCalculator, options = {}) {
  const result = await searchPerformedProcedureCode(feeCalculator, options);
  const event = options.event || {};
  const traceEvents = [
    clinicalTraceEvent({
      stage: "master_linker",
      event,
      categoryLabel: options.categoryLabel || "診療行為",
      outcome: asArray(result?.procedureCodes).length
        ? "linked"
        : asArray(result?.reviewWarnings).length
          ? "review_required"
          : "unresolved",
      allowedFeeCategories: options.allowedFeeCategories,
      selected: {
        billingIntentId: sourceBillingIntentIdFromClinicalEvent(event),
        sourceFactId: sourceFactIdFromClinicalEvent(event),
        queryCount: uniqueStrings(options.queries || []).length,
        linkedCodes: asArray(result?.procedureCodes)
      },
      message: "master_linker_resolved_verified_fact_intent"
    }),
    ...asArray(result?.traceEvents)
  ];
  return {
    ...result,
    traceEvents
  };
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
  let ambiguousSearch = null;
  for (const query of normalizedQueries) {
    const search = await searchProcedureMasterItem(feeCalculator, query, {
      event,
      name,
      categoryLabel,
      allowedFeeCategories
    });
    searchTrace.push(searchTraceSummary(query, search));
    if (search?.ambiguousCandidates?.length && !ambiguousSearch) {
      ambiguousSearch = { query, search };
      continue;
    }
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
    reviewWarnings: [ambiguousSearch
      ? `マスター候補確認: ${name || categoryLabel}は複数の標準コード候補があり、カルテ本文から修飾条件を自動確定できませんでした。候補を確認してください。`
      : unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、標準コードを自動確定できませんでした。`],
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
    const viableCandidates = [];
    for (const candidate of candidates) {
      const filterReason = directRetrievalFilterReason(candidate, context);
      if (filterReason) {
        filteredCandidates.push(filteredCandidateTrace(candidate, filterReason));
        continue;
      }
      const assessment = procedureMasterCandidateAssessment(candidate, { ...context, query });
      if (assessment.highConfidence) {
        viableCandidates.push({
          item: candidate,
          ...assessment
        });
      }
    }
    const selected = selectProcedureMasterCandidate(viableCandidates, { ...context, query });
    if (selected?.ambiguous) {
      return {
        item: null,
        inspectedCount: candidates.length,
        filteredCandidates,
        ambiguousCandidates: selected.candidates.map((candidate) => ambiguousCandidateTrace(candidate)),
        ambiguityReason: selected.reason
      };
    }
    if (selected?.item) {
      return {
        item: selected.item,
        inspectedCount: candidates.length,
        filteredCandidates
      };
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
  return procedureMasterCandidateAssessment(item, { query, name, categoryLabel }).highConfidence;
}

function procedureMasterCandidateAssessment(item = {}, { query = "", name = "", categoryLabel = "", event = {} } = {}) {
  const rawItemText = [
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].filter(Boolean).join(" ");
  const rawContextText = [
    query,
    name,
    categoryLabel,
    event?.area_size_cm2,
    event?.areaSizeCm2,
    clinicalEventEvidence(event)
  ].filter(Boolean).join(" ");
  const itemText = normalizeProcedureMatchText(rawItemText);
  const contextText = normalizeProcedureMatchText(rawContextText);
  if (!itemText || !contextText) {
    return {
      highConfidence: false,
      score: 0,
      unmatchedModifiers: []
    };
  }

  const queryKey = normalizeProcedureMatchText(query);
  const nameKey = normalizeProcedureMatchText(name);
  const queryTokens = procedureMatchTokens(query);
  const nameTokens = procedureMatchTokens(name);
  const itemNameKeys = procedureCandidateNameKeys(item);
  const contextModifiers = procedureModifierSet(rawContextText);
  const itemModifiers = procedureModifierSet(rawItemText);
  const unmatchedModifiers = [...itemModifiers].filter((modifier) => !contextModifiers.has(modifier));
  const contextAreaBand = procedureAreaBandKey(rawContextText);
  const itemAreaBand = procedureAreaBandKey(rawItemText);
  let score = 0;
  if (queryKey && itemNameKeys.has(queryKey)) score += 110;
  if (nameKey && itemNameKeys.has(nameKey)) score += 110;
  if (queryKey && itemText.includes(queryKey)) score += 70;
  if (nameKey && itemText.includes(nameKey)) score += 70;
  if (queryTokens.some((token) => token.length >= 3 && itemText.includes(token))) score += 35;
  if (nameTokens.some((token) => token.length >= 3 && itemText.includes(token))) score += 35;
  if (contextAreaBand && itemAreaBand === contextAreaBand) score += 95;
  if (contextAreaBand && itemAreaBand && itemAreaBand !== contextAreaBand) score -= 65;
  if (unmatchedModifiers.length && !contextModifiers.size) score -= 45;
  if (unmatchedModifiers.length && contextModifiers.size) score -= 15;
  return {
    highConfidence: score >= PROCEDURE_MASTER_HIGH_CONFIDENCE_SCORE,
    score,
    unmatchedModifiers,
    matchedModifiers: [...itemModifiers].filter((modifier) => contextModifiers.has(modifier)),
    contextAreaBand,
    itemAreaBand
  };
}

function procedureAreaBandKey(value = "") {
  const source = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/平方(?:センチメートル|センチ|cm)/gu, "cm2")
    .replace(/㎠/gu, "cm2")
    .replace(/cm²/gu, "cm2")
    .replace(/ｃｍ２/gu, "cm2");
  if (/^[0-9]+(?:\.[0-9]+)?$/u.test(source)) {
    return areaBandFromNumber(Number(source));
  }
  if (/100(?:cm2)?未満/u.test(source)) return "lt100";
  if (/100(?:cm2)?以上.*500(?:cm2)?未満/u.test(source)) return "100_500";
  if (/500(?:cm2)?以上.*3000(?:cm2)?未満/u.test(source)) return "500_3000";
  if (/3000(?:cm2)?以上.*6000(?:cm2)?未満/u.test(source)) return "3000_6000";
  if (/6000(?:cm2)?以上/u.test(source)) return "gte6000";
  const numeric = numericAreaSizeCm2(source);
  if (numeric != null) {
    return areaBandFromNumber(numeric);
  }
  return "";
}

function numericAreaSizeCm2(source = "") {
  const exact = String(source || "").match(/(?:^|[^0-9])([0-9]+(?:\.[0-9]+)?)(?:cm2|平方センチ|平方cm)(?:未満|以上)?/u);
  if (exact) {
    return Number(exact[1]);
  }
  const rectangle = String(source || "").match(/([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)(?:cm)?/u);
  if (rectangle) {
    return Number(rectangle[1]) * Number(rectangle[2]);
  }
  return null;
}

function areaBandFromNumber(area) {
  if (!Number.isFinite(area)) return "";
  if (area < 100) return "lt100";
  if (area < 500) return "100_500";
  if (area < 3000) return "500_3000";
  if (area < 6000) return "3000_6000";
  return "gte6000";
}

function normalizeProcedureMatchText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[（）()・、,，.\-－ー]/gu, "")
    .toLowerCase();
}

const PROCEDURE_MASTER_HIGH_CONFIDENCE_SCORE = 40;
const PROCEDURE_MASTER_AMBIGUOUS_SCORE_MARGIN = 8;

const PROCEDURE_MODIFIER_TERMS = Object.freeze([
  "定性",
  "定量",
  "半定量",
  "精密",
  "簡易",
  "断層",
  "造影",
  "単純"
]);

function procedureModifierSet(value = "") {
  const text = normalizeProcedureMatchText(value);
  return new Set([
    ...PROCEDURE_MODIFIER_TERMS.filter((term) => text.includes(normalizeProcedureMatchText(term))),
    ...procedureParentheticalMethodModifiers(value)
  ].map((term) => normalizeProcedureMatchText(term)).filter(Boolean));
}

function procedureParentheticalMethodModifiers(value = "") {
  const modifiers = [];
  const source = String(value || "");
  const parentheticalMatches = source.matchAll(/[（(]([^（）()]{1,32})[）)]/gu);
  for (const match of parentheticalMatches) {
    const content = String(match?.[1] || "").trim();
    if (!content) {
      continue;
    }
    for (const segment of content.split(/[、,，・/／]/u).map((part) => part.trim()).filter(Boolean)) {
      if (/(?:法|型|方式|モード|撮影法)$/u.test(segment)) {
        modifiers.push(segment);
      }
    }
  }
  return modifiers;
}

function procedureCandidateNameKeys(item = {}) {
  return new Set([
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].map((value) => normalizeProcedureMatchText(value)).filter(Boolean));
}

function selectProcedureMasterCandidate(candidates = [], context = {}) {
  if (!candidates.length) {
    return null;
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  // The scorer gives exact name matches 110 points, substring matches 70, and weak token
  // matches 35. Require more than a token-only match for auto-selection, and treat near
  // ties as review-required because code-order fallback is unsafe for sibling masters.
  const tied = sorted.filter((candidate) => Math.abs(candidate.score - top.score) <= PROCEDURE_MASTER_AMBIGUOUS_SCORE_MARGIN);
  if (tied.length > 1) {
    return {
      ambiguous: true,
      candidates: tied.slice(0, 5),
      reason: "similar_candidate_scores"
    };
  }
  if (top.unmatchedModifiers?.length && hasSiblingWithoutUnmatchedModifier(top, sorted, context)) {
    return {
      ambiguous: true,
      candidates: sorted.slice(0, 5),
      reason: "modifier_without_context"
    };
  }
  return {
    item: top.item
  };
}

function hasSiblingWithoutUnmatchedModifier(top = {}, candidates = [], context = {}) {
  const topCore = stripProcedureModifiers(top.item?.name || top.item?.baseName || top.item?.displayName || top.item?.shortName || "");
  if (!topCore) {
    return false;
  }
  return candidates.some((candidate) => (
    candidate !== top
    && stripProcedureModifiers(candidate.item?.name || candidate.item?.baseName || candidate.item?.displayName || candidate.item?.shortName || "") === topCore
    && !candidate.unmatchedModifiers?.length
  ));
}

function stripProcedureModifiers(value = "") {
  let text = normalizeProcedureMatchText(value);
  for (const modifier of PROCEDURE_MODIFIER_TERMS) {
    text = text.replaceAll(normalizeProcedureMatchText(modifier), "");
  }
  return text;
}

function ambiguousCandidateTrace(candidate = {}) {
  const item = candidate.item || {};
  return {
    code: String(item.code || ""),
    name: item.name || item.displayName || item.baseName || item.shortName || "",
    feeCategory: item.feeCategory || "",
    itemRole: item.itemRole || "",
    score: Number(candidate.score || 0),
    unmatchedModifiers: asArray(candidate.unmatchedModifiers),
    contextAreaBand: candidate.contextAreaBand || "",
    itemAreaBand: candidate.itemAreaBand || ""
  };
}

function procedureMatchTokens(value = "") {
  return normalizeProcedureMatchText(value)
    .split(/(?:検査|測定|撮影|処置|管理料|指導料|料|法|術|血液|尿|眼|鼻|耳|皮膚|腹部|胸部)/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

const ROUTINE_OBSERVATION_NAME_PATTERN = /^(?:体温|血圧|BP|脈拍|心拍数|HR|呼吸数|SpO2|酸素飽和度|身長|体重|BMI|意識|JCS|GCS)(?:測定|確認|記録)?$/iu;
const ROUTINE_FINDING_NAME_PATTERN = /(?:所見|聴診|視診|触診)$/u;
const BILLABLE_EXAM_CUE_PATTERN = /(?:検査|テスト|試験|撮影|内視鏡|心電図|脳波|筋電図|超音波|エコー|CT|MRI|X線|レントゲン|眼底|眼圧|視力|視野|細隙灯|プリック|パッチテスト|負荷|肺機能|呼吸機能|血液|尿|便)/iu;

function isRoutineNonBillableObservationEvent(event = {}) {
  if (normalizeClinicalEventType(event) !== "exam") {
    return false;
  }
  const name = normalizeClinicalText(clinicalEventName(event));
  if (!name) {
    return false;
  }
  const compactName = normalizeMatchText(name);
  const evidence = normalizeClinicalText(clinicalEventEvidence(event));
  const compactEvidence = normalizeMatchText(evidence);
  if (BILLABLE_EXAM_CUE_PATTERN.test(name) && !ROUTINE_OBSERVATION_NAME_PATTERN.test(name)) {
    return false;
  }
  if (ROUTINE_OBSERVATION_NAME_PATTERN.test(name) || ROUTINE_OBSERVATION_NAME_PATTERN.test(compactName)) {
    return true;
  }
  if (
    ROUTINE_FINDING_NAME_PATTERN.test(name)
    && !BILLABLE_EXAM_CUE_PATTERN.test(name)
    && !BILLABLE_EXAM_CUE_PATTERN.test(evidence)
  ) {
    return true;
  }
  if (
    /(?:聴診|呼吸音|wheeze|ラ音|咽頭所見|鼻腔所見|眼所見|耳所見)/iu.test(compactName)
    && !BILLABLE_EXAM_CUE_PATTERN.test(evidence)
  ) {
    return true;
  }
  if (
    /(?:体温|血圧|脈拍|心拍数|呼吸数|spo2|酸素飽和度)/iu.test(compactName)
    && /(?:\d|正常|清明|整|室内気|なし|無し)/u.test(compactEvidence)
    && !BILLABLE_EXAM_CUE_PATTERN.test(evidence)
  ) {
    return true;
  }
  return false;
}

function normalizedSearchModifier(value = "") {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const normalized = normalizeMatchText(text);
  if (!normalized || ["none", "unknown", "null", "なし", "無し", "不明"].includes(normalized)) {
    return "";
  }
  return text;
}

function bodySiteNameQuery(bodySite = "", name = "") {
  const site = String(bodySite || "").trim();
  const eventName = String(name || "").trim();
  if (!site || !eventName) {
    return "";
  }
  const normalizedSite = normalizeProcedureMatchText(site);
  const normalizedName = normalizeProcedureMatchText(eventName);
  if (normalizedSite && normalizedName.startsWith(normalizedSite)) {
    return "";
  }
  return `${site}${eventName}`;
}

function clinicalEventSearchQueries(event = {}, { categoryLabel = "", extraQueries = [] } = {}) {
  const name = clinicalEventName(event);
  const evidence = clinicalEventEvidence(event);
  const bodySite = normalizedSearchModifier(event?.body_site || event?.bodySite);
  const modality = normalizedSearchModifier(event?.modality);
  const deterministicTerms = [
    name,
    bodySiteNameQuery(bodySite, name),
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
      query: Object.prototype.hasOwnProperty.call(item, "query") ? item.query : (item.name || label),
      searchQueries: uniqueStrings(asArray(item.searchQueries)),
      modality: item.modality || "none",
      conceptKey: item.conceptKey || "",
      matchTerms: uniqueStrings(asArray(item.matchTerms)),
      compositeConcept: Boolean(item.compositeConcept)
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

  for (const group of labConceptGroupsFromText(normalized)) {
    addMenu({
      menuId: `lab_group:${group.key}`,
      label: group.name,
      kind: "lab_group",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: group.name,
      query: "",
      searchQueries: [],
      conceptKey: group.key,
      matchTerms: [group.name, ...asArray(group.aliases)]
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

  for (const procedure of procedureChecklistItems(normalized)) {
    addMenu(procedure);
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

function procedureChecklistItems(text = "") {
  return PROCEDURE_CHECKLIST_DEFINITIONS
    .filter((definition) => definition.pattern.test(text))
    .map((definition) => ({
      menuId: `procedure:${definition.key}`,
      label: definition.label,
      kind: "procedure",
      eventType: "treatment",
      billingDomain: "standard_procedure",
      name: definition.label,
      query: definition.query,
      searchQueries: [definition.query, ...definition.aliases],
      matchTerms: definition.matchTerms || []
    }));
}

function rapidLabChecklistItems(text = "") {
  const items = [];
  const hasCovid = /COVID|SARS|コロナ|新型コロナ/u.test(text);
  const hasInfluenza = /インフル|influenza|flu/u.test(text);
  const hasRapidOrAntigen = /迅速|抗原|定性|Ag/u.test(text);
  const hasSimultaneousContext = /同時|同時検出|同一キット|一括|まとめて/u.test(text);
  if (hasCovid && hasInfluenza && hasRapidOrAntigen && hasSimultaneousContext) {
    items.push({
      menuId: "lab:covid_flu_antigen",
      label: "新型コロナ・インフル抗原同時検査",
      kind: "lab",
      eventType: "lab",
      billingDomain: "standard_lab",
      name: "新型コロナ・インフル抗原同時検査",
      query: "ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性",
      searchQueries: ["ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性"],
      compositeConcept: true
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
  return REVIEW_ONLY_DOMAIN_CHECKLIST_DEFINITIONS
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

function labConceptsFromClinicalEventName(event = {}) {
  const text = normalizeClinicalText(clinicalEventName(event));
  return labConceptsFromText(text);
}

function labConceptGroupsFromClinicalEventName(event = {}) {
  const text = normalizeClinicalText(clinicalEventName(event));
  return labConceptGroupsFromText(text);
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

function labConceptGroupsFromText(text = "") {
  const normalized = normalizeClinicalText(text);
  const concepts = [];
  for (const concept of LAB_CONCEPT_GROUP_DEFINITIONS) {
    if (concept.pattern.test(normalized)) {
      concepts.push(concept);
    }
  }
  return concepts;
}

function labEventNameSupportedByRawEvidence(event = {}, clinicalText = "") {
  const nameConcepts = labConceptsFromClinicalEventName(event);
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

function isPastOrExternalClinicalServiceContext(sentence = "") {
  const text = normalizeClinicalText(sentence);
  return /(前回|先月|以前|過去|過去値|既知値|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|外部|前に|過去に)/u.test(text);
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
  return /(未実施|未施行|行わず|行っていない|行っていません|施行せず|施行していない|実施していない|撮影せず|撮影していない|検査せず|検査していない|撮影なし|検査なし|中止)/u.test(sentence);
}

function hasLocalContrastContext(sentence, kind) {
  return localContrastState(sentence, kind) === "present";
}

function clinicalEventContrastState(event = {}, options = {}) {
  const imagingKind = String(options.imagingKind || "").trim();
  const localState = localContrastState(clinicalEventEvidence(event), imagingKind);
  if (localState !== "absent") {
    return localState;
  }
  const chartState = chartLevelUnknownContrastStateForKind(options.clinicalText, imagingKind);
  return chartState === "unknown" ? "unknown" : localState;
}

function chartLevelUnknownContrastStateForKind(text = "", imagingKind = "") {
  if (!text || !["ct", "mri"].includes(String(imagingKind || "").trim())) {
    return "";
  }
  const texts = uniqueStrings([
    objectiveClinicalText(text),
    text
  ]).filter(Boolean);
  for (const sourceText of texts) {
    for (const sentence of splitClinicalSentences(sourceText)) {
      const normalized = normalizeClinicalText(sentence);
      if (!normalized || isClinicalMetaSentence(normalized)) {
        continue;
      }
      if (isNegatedClinicalServiceContext(normalized) || isFutureOrOrderOnlyContext(normalized)) {
        continue;
      }
      if (localContrastState(normalized, imagingKind) === "unknown") {
        return "unknown";
      }
    }
  }
  return "";
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
    if (
      isFutureOrOrderOnlyContext(sentence)
      || isNegatedClinicalServiceContext(sentence)
      || isPastOrExternalClinicalServiceContext(sentence)
    ) {
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
  const chartLevelStorageState = chartLevelUnknownImageStorageStateForKind(text, imagingKind);
  if (chartLevelStorageState === "unknown") {
    return "unknown";
  }
  if (
    sentenceMatchesImagingKind(objectiveText, imagingKind)
    && /(電子|フィルム|紙焼き)/u.test(objectiveText)
    && !isFutureOrOrderOnlyContext(objectiveText)
    && !isPastOrExternalClinicalServiceContext(objectiveText)
  ) {
    const state = localElectronicImageManagementState(objectiveText);
    if (state === "present" || state === "unknown" || state === "absent") {
      return state;
    }
  }
  return "";
}

function chartLevelUnknownImageStorageStateForKind(text = "", imagingKind = "") {
  if (!text || !imagingKind) {
    return "";
  }
  const texts = uniqueStrings([
    objectiveClinicalText(text),
    text
  ]).filter(Boolean);
  for (const sourceText of texts) {
    if (!sentenceMatchesImagingKind(sourceText, imagingKind)) {
      continue;
    }
    for (const sentence of splitClinicalSentences(sourceText)) {
      const normalized = normalizeClinicalText(sentence);
      if (!normalized || isClinicalMetaSentence(normalized)) {
        continue;
      }
      if (
        isFutureOrOrderOnlyContext(normalized)
        || isNegatedClinicalServiceContext(normalized)
        || isPastOrExternalClinicalServiceContext(normalized)
      ) {
        continue;
      }
      if (hasChartLevelUnknownImageStorageContext(normalized)) {
        return "unknown";
      }
    }
  }
  return "";
}

function hasChartLevelUnknownImageStorageContext(sentence = "") {
  const text = normalizeClinicalText(sentence);
  if (!/(画像データ|画像情報|画像記録|撮影データ|画像.{0,8}保存|保存状況|保存.{0,8}状況)/u.test(text)) {
    return false;
  }
  return /(不明|未確定|確認|要確認|必要|残っていない|記録.{0,8}ない|記載.{0,8}ない|読み取れない|分からない|わからない|照合)/u.test(text);
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
      if (field === "projection_count" || field === "view_count") {
        existing.projection_count = Math.max(
          positiveIntegerOrOne(existing.projection_count || existing.view_count),
          positiveIntegerOrOne(value)
        );
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

function positiveIntegerOrOne(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 1;
  }
  return Math.max(1, Math.trunc(numeric));
}

function simpleRadiographyProjectionCount(text = "") {
  const normalized = normalizeClinicalText(text);
  if (!normalized) {
    return 1;
  }
  if (/(正面.{0,12}側面|側面.{0,12}正面|正側|2方向|２方向|二方向|2面|２面|二面|AP.{0,12}側面|PA.{0,12}側面|側面.{0,12}AP|側面.{0,12}PA)/iu.test(normalized)) {
    return 2;
  }
  if (/(3方向|３方向|三方向|3面|３面|三面)/u.test(normalized)) {
    return 3;
  }
  return 1;
}

function imagingOrderTraceSelected(order = {}) {
  return {
    kind: order.kind || null,
    acquisition_kind: order.acquisition_kind || null,
    radiography_diagnostic_kind: order.radiography_diagnostic_kind || null,
    projection_count: positiveIntegerOrOne(order.projection_count || order.view_count),
    ct_equipment_kind: order.ct_equipment_kind || null,
    mri_equipment_kind: order.mri_equipment_kind || null,
    contrast: order.contrast === true,
    electronic_image_management: order.electronic_image_management === true,
    diagnostic_management_add_on: order.diagnostic_management_add_on === true,
    remote_diagnostic_management_add_on: order.remote_diagnostic_management_add_on === true
  };
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
