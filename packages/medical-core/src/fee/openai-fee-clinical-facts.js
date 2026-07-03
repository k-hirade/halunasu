import { createStructuredOpenAiResponse } from "../openai/responses-structured.js";

export const FEE_CLINICAL_FACTS_PROMPT_VERSION = "fee-clinical-events-v11";

const LEGACY_EVENT_STATUSES = [
  "performed",
  "prescribed",
  "administered",
  "planned",
  "ordered",
  "considered",
  "instruction_only",
  "history",
  "other_provider",
  "negated",
  "unclear"
];

const ACTION_STATUSES = [
  "performed",
  "prescribed",
  "administered",
  "ordered",
  "planned",
  "considered",
  "instruction_only",
  "not_performed",
  "unknown"
];

const TEMPORAL_RELATIONS = [
  "current_visit",
  "same_day_but_unknown",
  "past",
  "future",
  "unknown"
];

const SOURCE_ORIGINS = [
  "own_clinic_record",
  "patient_reported",
  "external_document",
  "carried_in_result",
  "other_provider_record",
  "unknown"
];

const PROVIDER_OWNERSHIPS = [
  "own_clinic",
  "same_institution_other_department",
  "other_provider",
  "unknown"
];

const RESULT_ASSERTIONS = [
  "positive",
  "negative",
  "normal",
  "abnormal",
  "numeric",
  "not_applicable",
  "unknown"
];

const CERTAINTY_LEVELS = [
  "explicit",
  "inferred",
  "ambiguous"
];

const CHECKLIST_STATUSES = [
  "performed_today",
  "planned",
  "past_or_external",
  "mentioned_not_performed",
  "not_in_text",
  "unclear"
];

const EVENT_TYPES = [
  "outpatient_basic",
  "imaging",
  "procedure",
  "exam",
  "treatment",
  "medication",
  "injection",
  "material",
  "lab",
  "management",
  "counseling",
  "pathology",
  "emergency_time_addon",
  "follow_up",
  "other"
];

const BILLING_DOMAINS = [
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
  "split_multi_day",
  "unknown"
];

const feeClinicalFactsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "visit_type",
    "visit_facts",
    "diagnoses",
    "clinical_events",
    "checklist_findings",
    "excluded_events",
    "missing_information",
    "review_flags"
  ],
  properties: {
    visit_type: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "evidence", "confidence"],
      properties: {
        kind: {
          type: "string",
          enum: ["initial", "revisit", "unknown"]
        },
        evidence: { type: "string" },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"]
        }
      }
    },
    visit_facts: {
      type: "object",
      additionalProperties: false,
      required: [
        "outside_prescription_issued",
        "generic_name_prescription",
        "prescription_evidence"
      ],
      properties: {
        outside_prescription_issued: {
          type: "string",
          enum: ["yes", "no", "unknown"]
        },
        generic_name_prescription: {
          type: "string",
          enum: ["yes", "no", "unknown"]
        },
        prescription_evidence: shortString(90)
      }
    },
    diagnoses: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "evidence"],
        properties: {
          name: shortString(60),
          status: {
            type: "string",
            enum: ["confirmed", "suspected", "history", "denied", "unclear"]
          },
          evidence: shortString(90)
        }
      }
    },
    clinical_events: {
      type: "array",
      maxItems: 18,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "billing_domain",
          "name",
          "action_status",
          "temporal_relation",
          "source_origin",
          "provider_ownership",
          "result_assertion",
          "certainty",
          "section",
          "evidence",
          "evidence_line_ids",
          "char_start",
          "char_end",
          "search_queries",
          "modality",
          "body_site",
          "specimen",
          "collection_method",
          "quantity_per_day",
          "days",
          "total_quantity",
          "area_size_cm2",
          "review_reason"
        ],
        properties: eventProperties()
      }
    },
    checklist_findings: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["menu_id", "status", "evidence", "reason"],
        properties: {
          menu_id: shortString(50),
          status: { type: "string", enum: CHECKLIST_STATUSES },
          evidence: shortString(90),
          reason: shortString(70)
        }
      }
    },
    excluded_events: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "status", "evidence", "reason"],
        properties: {
          type: { type: "string", enum: EVENT_TYPES },
          name: shortString(60),
          status: { type: "string", enum: LEGACY_EVENT_STATUSES },
          evidence: shortString(90),
          reason: shortString(90)
        }
      }
    },
    missing_information: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "reason", "evidence"],
        properties: {
          field: shortString(40),
          reason: shortString(90),
          evidence: shortString(90)
        }
      }
    },
    review_flags: {
      type: "array",
      maxItems: 2,
      items: shortString(70)
    }
  }
};

function shortString(maxLength = 70) {
  return { type: "string", maxLength };
}

function eventProperties() {
  return {
    type: { type: "string", enum: EVENT_TYPES },
    billing_domain: { type: "string", enum: BILLING_DOMAINS },
    name: shortString(60),
    action_status: { type: "string", enum: ACTION_STATUSES },
    temporal_relation: { type: "string", enum: TEMPORAL_RELATIONS },
    source_origin: { type: "string", enum: SOURCE_ORIGINS },
    provider_ownership: { type: "string", enum: PROVIDER_OWNERSHIPS },
    result_assertion: { type: "string", enum: RESULT_ASSERTIONS },
    certainty: { type: "string", enum: CERTAINTY_LEVELS },
    section: {
      type: "string",
      enum: ["S", "O", "A", "P", "unknown"]
    },
    evidence: shortString(90),
    evidence_line_ids: {
      type: "array",
      maxItems: 3,
      items: shortString(20)
    },
    char_start: {
      type: "string",
      maxLength: 12
    },
    char_end: {
      type: "string",
      maxLength: 12
    },
    search_queries: {
      type: "array",
      maxItems: 5,
      items: shortString(40)
    },
    modality: {
      type: "string",
      enum: ["simple_radiography", "ct", "mri", "ultrasound", "endoscopy", "other", "none"]
    },
    body_site: shortString(40),
    specimen: shortString(40),
    collection_method: shortString(40),
    quantity_per_day: shortString(20),
    days: shortString(20),
    total_quantity: shortString(20),
    area_size_cm2: shortString(20),
    review_reason: shortString(70)
  };
}

function checklistInstructionForMode(mode = "inline") {
  const value = String(mode || "inline").trim();
  if (value === "disabled") {
    return "Checklist verification is disabled for this pass. Return checklist_findings as an empty array and do not let the Checklist menu influence clinical_events.";
  }
  if (value === "checklist_only") {
    return "This is the checklist verification pass. Focus on answering checklist_findings for every item in the Checklist menu. Return clinical_events as an empty array unless a schema field requires otherwise. The checklist is only a recall aid and does not make an item billable by itself.";
  }
  if (value === "split") {
    return "This pass may be used as part of split extraction. In addition to free clinical_events extraction, answer checklist_findings for every item in the Checklist menu. The checklist is only a recall aid and does not make an item billable by itself.";
  }
  return "In addition to free clinical_events extraction, answer checklist_findings for every item in the Checklist menu. This checklist is only a recall aid: it does not make an item billable by itself. Downstream rules will still verify evidence, timing, ownership, master mapping, and policy gates.";
}

export async function extractFeeClinicalFactsWithOpenAi({
  apiKey,
  clinicalText,
  sessionContext = {},
  preprocessedLines = [],
  checklistMenu = [],
  checklistVerificationMode = "inline",
  model = "gpt-5.4-nano",
  reasoningEffort = "low",
  timeoutMs = 0,
  stream = false,
  onOutputTextSnapshot = null
}) {
  const input = [
    "診療報酬算定の前処理として、カルテ本文から臨床イベントだけを抽出してください。",
    "",
    "Session context:",
    JSON.stringify(safeSessionContext(sessionContext), null, 2),
    "",
    "Preprocessed clinical lines:",
    JSON.stringify(safePreprocessedClinicalLines(preprocessedLines), null, 2),
    "",
    "Checklist verification mode:",
    String(checklistVerificationMode || "inline"),
    "",
    "Checklist menu:",
    JSON.stringify(checklistVerificationMode === "disabled" ? [] : safeClinicalChecklistMenu(checklistMenu), null, 2),
    "",
    "Clinical text:",
    String(clinicalText || "").trim()
  ].join("\n");

  const result = await createStructuredOpenAiResponse({
    apiKey,
    model,
    reasoningEffort,
    instructions: [
      "You are a Japanese medical billing clinical-structure extraction engine.",
      "Return only facts supported by the provided clinical text and session context.",
      "Your output is clinical_events, not billing candidates. Do not calculate points. Do not choose billing codes. Do not decide billable/proposal/review eligibility. Downstream master search and rules will decide those.",
      checklistInstructionForMode(checklistVerificationMode),
      "For each checklist menu item, return exactly one checklist_finding with the same menu_id. Use status=performed_today only when the note supports that the item happened in this clinic during this encounter. Use planned for future/order/予定/依頼/予約/次回. Use past_or_external for 前回/以前/他院/前医/持参/健診/他科/主治医. Use mentioned_not_performed when the note says the act was not done. Use not_in_text when the menu item is not actually supported by the note. Use unclear when named but timing/ownership/performance cannot be determined.",
      "For checklist_findings evidence, quote a short exact excerpt from the clinical text when status is not_in_text leave evidence empty. Do not invent evidence.",
      "For every clinical_event, when a matching item exists in Preprocessed clinical lines, set evidence_line_ids to the relevant line_id values; use an empty array only when no line can be identified. evidence must still be a short quote from the original clinical text. Set char_start/char_end to decimal character offsets only when you can identify the original span exactly; otherwise set them to empty strings.",
      "For each clinical_event, set billing_domain as a structured meaning label. Use standard_lab for ordinary specimen tests including blood/urine/rapid tests and ordinary specimen submission; pathology only for pathology diagnosis, cytology, histology, tissue specimen pathology submission, or specimen preparation in a pathology-diagnosis context; emergency_time_addon only for emergency/time-after-hours/holiday/night billing add-on context such as 救急加算, 時間外加算, 休日加算, 深夜加算, or受付時刻確認 for those add-ons. Do not mark symptom timing such as 夜間頻尿 or 夜間咳嗽 as emergency_time_addon.",
      "Separate action_status, temporal_relation, source_origin, provider_ownership, result_assertion, and certainty. Do not compress them into one status.",
      "Use action_status=performed/prescribed/administered only for actions that happened during the current encounter or are clearly prescribed/administered by this clinic today.",
      "For tests and procedures, if the act itself was performed, set action_status=performed even when the result is normal, negative, no abnormality, unchanged, or ruled out. Do not exclude the event just because the result is 陰性/正常/異常なし. Set result_assertion=negative/normal instead. Use action_status=not_performed only when the clinical text says the act itself was not performed, cancelled, or denied.",
      "If a test or procedure is described with 次回, 予定, 後日, 検討, 依頼, オーダー, 予約, or 今後, set action_status=planned/ordered/considered and temporal_relation=future unless the same sentence clearly says it was already performed.",
      "If a result or treatment is described as 持参, 前医, 他院, かかりつけ, 健診, 内科主治医, or outside records, keep the clinical event but set source_origin and provider_ownership accordingly. Do not treat it as own_clinic current billing.",
      "If a medication is described as 既往, 内服中, 持参薬, 常用, 継続中, or 以前から, do not mark it prescribed unless the text clearly says it was prescribed today.",
      "For medication events, name must be the exact drug/product/generic name written in the note. Do not use category labels such as 処方薬, 院内処方, 院内外用薬, 外用薬, or 薬剤 as the event name when a concrete drug name appears in the evidence. One drug equals one medication event.",
      "For lab events, one performed test equals one clinical_event. If a sentence lists multiple tests such as 尿一般、尿蛋白, CRPと末梢血液一般, HbA1cと血糖, split them into separate lab clinical_events with the concrete test name in each name/search_queries. Do not merge multiple test names into one lab event.",
      "Event preservation rule: if a concrete test, procedure, treatment, medication, imaging exam, management fee context, or unsupported billing-domain topic is named in the note, preserve it as a clinical_event even when implementation status is uncertain. Use certainty=ambiguous and action_status=unknown/considered/planned as appropriate; do not drop the named event into generic missing_information only.",
      "Do not infer a concrete blood test name from blood collection alone. A sentence such as 静脈採血を行った, 採血して検体提出, or 血液検体を採取 supports specimen/collection_method, but it does not by itself support CBC, 末梢血液一般, CRP, HbA1c, or other analytes unless those test names or results are explicitly written.",
      "Set visit_facts.outside_prescription_issued=yes only when the note explicitly says an outside prescription or prescription slip was issued today, such as 院外処方, 処方箋交付, or 処方箋を交付. Set generic_name_prescription=yes only when the note explicitly says 一般名処方 or generic-name prescription. These are visit-level facts, not medication names.",
      "For medications, extract days and quantity per day only when explicitly written. Otherwise leave the fields empty and add missing_information.",
      "For lab tests and specimen-based procedures, extract specimen and collection_method only when explicit, such as blood, urine, nasal swab, nasopharyngeal swab, throat swab, sputum, stool, tissue, or puncture fluid. Leave them empty when the note only describes a finding such as 咽頭発赤 or 鼻汁 without specimen collection.",
      "For rehabilitation, home medical care, psychiatry-special therapy, anesthesia, surgery, endoscopy, dialysis, transfusion, radiation therapy, pathology, injection review-only topics, split-multi-day notes, and emergency/time add-on topics, preserve them as clinical_events with the appropriate billing_domain. Do not convert them into standard_procedure just because the text contains 行為, 指導, 管理, or 確認.",
      "Domain contrast examples: 静脈採血後に検体提出 is billing_domain=standard_lab, not pathology. 組織標本を病理提出 or 細胞診検体を提出 is billing_domain=pathology. 内視鏡検査・生検はbilling_domain=endoscopy. 透析はbilling_domain=dialysis. 輸血はbilling_domain=transfusion. 放射線治療・照射条件はbilling_domain=radiation_therapy. 背部皮下腫瘤切除, 粉瘤摘出, 体表腫瘤摘出, or 手術室/局所麻酔下の切除 is billing_domain=surgery, not standard_procedure. 夜間頻尿 is a symptom/time context, not emergency_time_addon. 時間外加算の算定条件確認 is billing_domain=emergency_time_addon. 次回再診, 2週間後再診, or 外来フォロー予定 is follow_up/planned, not home_care.",
      "For imaging, set modality to simple_radiography, ct, mri, ultrasound, endoscopy, or other when explicit. Planned imaging should not be mixed with performed imaging.",
      "When a procedure or treatment may vary by body site or measured size, such as wound, burn, dermatology, or site-dependent procedures, extract body_site and numeric area_size_cm2 whenever they are explicitly written. Do not infer a size that is not written; leave area_size_cm2 empty and add review_reason for missing size when the size affects billing classification.",
      "For every clinical_event, set section to S/O/A/P when clear. Use temporal_relation=current_visit/past/future/unknown; source_origin=own_clinic_record/patient_reported/external_document/carried_in_result/other_provider_record/unknown; provider_ownership=own_clinic/same_institution_other_department/other_provider/unknown.",
      "search_queries must be Japanese master-search phrases for the clinical event, not billing codes, point values, or reimbursement conclusions. Include concise synonyms when useful, but do not invent a reimbursement item that is not anchored in the note.",
      "For materials and devices, mark instruction_only when the text only says 装着指導, 説明, or self-care guidance rather than actual billed use.",
      "Do not put lab values, abnormal findings, or measurement results into diagnoses. Numeric test values, marker elevations, and isolated imaging findings are findings/events, not diagnoses.",
      "Each diagnosis and event must include a short evidence excerpt from the input text.",
      "Keep the response compact: evidence and reasons should be short excerpts, not explanations. Do not add dosage/unit/frequency details unless they are needed for quantity_per_day, days, total_quantity, or area_size_cm2.",
      "Prefer clinical_events. Keep excluded_events, missing_information, and review_flags empty unless they add information not already present in a clinical event.",
      "The examples below are schema examples only. Do not prefer those diseases, drugs, tests, or specialties. Apply the same event extraction rules to any clinical specialty.",
      "When a performed lab value, imaging result, treatment, management, or counseling event is present in Objective or Plan, extract the event generically by its clinical name even if it is not shown in the examples.",
      "",
      "Examples:",
      "- Text: O欄に「検査名：数値/所見」がある場合 -> clinical_events include that test or exam as action_status=performed, section=O, temporal_relation=current_visit, source_origin=own_clinic_record, provider_ownership=own_clinic, with result_assertion and search_queries suitable for master search.",
      "- Text: P欄に「検査オーダー」「次回」「予定」「後日」がある場合 -> action_status=planned or ordered, section=P, temporal_relation=future. Do not mix it with performed events unless O欄 also has same-day results.",
      "- Text: 既往歴、持参結果、他科主治医、他院、かかりつけで管理中 -> temporal_relation=past or unknown, source_origin=carried_in_result/other_provider_record, provider_ownership=same_institution_other_department/other_provider. Do not mark it as own_clinic current billing.",
      "- Text: 処方薬は、今回新規処方/変更/継続処方が明確な場合だけ medication action_status=prescribed. 説明・指導・検討だけなら counseling/management or planned/considered, not medication.",
      "- Do not create review_flags such as 今後の検討 or 方針確認 when the phrase is only follow-up planning and not a billable event."
    ].join("\n"),
    input,
    schemaName: "fee_clinical_facts",
    schema: feeClinicalFactsSchema,
    stream,
    onOutputTextSnapshot,
    timeoutMs
  });

  return {
    ...result.parsed,
    provider: "openai",
    model,
    promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
    responseId: result.responseId || null,
    usage: result.usage || null
  };
}

function safeSessionContext(context = {}) {
  return {
    // 患者氏名は要配慮個人情報であり、臨床イベント抽出には不要なため外部AIへ構造化フィールドとしては送らない。
    // 氏名の有無だけを非識別のフラグで伝える(本人/家族の判別はカルテ本文中の 本人/母/父/家族 等の語で行う)。
    patientDisplayNameRedacted: Boolean(String(context.patientDisplayName || "").trim()),
    facilityName: context.facilityName || "",
    departmentName: context.departmentName || "",
    serviceDate: context.serviceDate || "",
    billingMonth: context.billingMonth || context.claimMonth || "",
    claimMonth: context.claimMonth || context.billingMonth || "",
    visitType: context.visitType || "",
    diagnoses: Array.isArray(context.diagnoses) ? context.diagnoses.slice(0, 20) : []
  };
}

function safePreprocessedClinicalLines(lines = []) {
  return Array.isArray(lines)
    ? lines.slice(0, 80).map((line) => ({
      line_id: String(line?.lineId || line?.line_id || "").slice(0, 20),
      section: String(line?.section || "unknown").slice(0, 10),
      text: String(line?.text || "").slice(0, 220),
      cues: {
        future_or_order_only: Boolean(line?.cues?.futureOrOrderOnly),
        negated_service: Boolean(line?.cues?.negatedService),
        past_or_external: Boolean(line?.cues?.pastOrExternal),
        current_visit: Boolean(line?.cues?.currentVisit),
        synthetic_meta: Boolean(line?.cues?.syntheticMeta)
      },
      candidate_concepts: Array.isArray(line?.candidateConcepts)
        ? line.candidateConcepts.slice(0, 8).map((item) => String(item || "").slice(0, 60))
        : []
    })).filter((line) => line.line_id && line.text)
    : [];
}

function safeClinicalChecklistMenu(menu = []) {
  return Array.isArray(menu)
    ? menu.slice(0, 30).map((item) => ({
      menu_id: String(item?.menuId || item?.menu_id || "").slice(0, 50),
      label: String(item?.label || "").slice(0, 60),
      kind: String(item?.kind || "").slice(0, 40),
      domain: String(item?.billingDomain || item?.billing_domain || "").slice(0, 40)
    })).filter((item) => item.menu_id && item.label)
    : [];
}
