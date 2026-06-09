import { createStructuredOpenAiResponse } from "../openai/responses-structured.js";

const EVENT_STATUSES = [
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
  "follow_up",
  "other"
];

const feeClinicalFactsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "visit_type",
    "diagnoses",
    "billing_events",
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
    diagnoses: {
      type: "array",
      maxItems: 4,
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
    billing_events: {
      type: "array",
      maxItems: 18,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "name",
          "status",
          "section",
          "date_relation",
          "provider_ownership",
          "evidence",
          "search_queries",
          "modality",
          "body_site",
          "quantity_per_day",
          "days",
          "total_quantity",
          "area_size_cm2",
          "review_reason"
        ],
        properties: eventProperties()
      }
    },
    excluded_events: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "status", "evidence", "reason"],
        properties: {
          type: { type: "string", enum: EVENT_TYPES },
          name: shortString(60),
          status: { type: "string", enum: EVENT_STATUSES },
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
    name: shortString(60),
    status: { type: "string", enum: EVENT_STATUSES },
    section: {
      type: "string",
      enum: ["S", "O", "A", "P", "unknown"]
    },
    date_relation: {
      type: "string",
      enum: ["current_visit", "future", "past", "other_provider", "unknown"]
    },
    provider_ownership: {
      type: "string",
      enum: ["own_clinic", "other_department", "other_provider", "unknown"]
    },
    evidence: shortString(90),
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
    quantity_per_day: shortString(20),
    days: shortString(20),
    total_quantity: shortString(20),
    area_size_cm2: shortString(20),
    review_reason: shortString(70)
  };
}

export async function extractFeeClinicalFactsWithOpenAi({
  apiKey,
  clinicalText,
  sessionContext = {},
  model = "gpt-5.4-nano",
  reasoningEffort = "low",
  timeoutMs = 0,
  stream = false,
  onOutputTextSnapshot = null
}) {
  const input = [
    "診療報酬算定の前処理として、カルテ本文から算定候補に関係する臨床事実だけを抽出してください。",
    "",
    "Session context:",
    JSON.stringify(safeSessionContext(sessionContext), null, 2),
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
      "Do not calculate points. Do not choose billing codes. Do not invent performed services.",
      "Separate performed/prescribed/administered events from planned, ordered, instruction-only, history, negated, and unclear mentions.",
      "If a test or procedure is described with 次回, 予定, 後日, 持参, 検討, 依頼, オーダー, 予約, or 今後, mark it planned or ordered unless the same sentence clearly says it was already performed.",
      "If a medication is described as 既往, 内服中, 持参薬, 常用, 継続中, or 以前から, mark it history unless the text clearly says it was newly prescribed today.",
      "For medications, extract days and quantity per day only when explicitly written. Otherwise leave the fields empty and add missing_information.",
      "For imaging, set modality to simple_radiography, ct, mri, ultrasound, endoscopy, or other when explicit. Planned imaging should not be mixed with performed imaging.",
      "For every billing_event, set section to S/O/A/P when clear, date_relation to current_visit/future/past/other_provider/unknown, and provider_ownership to own_clinic/other_department/other_provider/unknown.",
      "Use other_department or other_provider when the text says another department or outside doctor is managing it, for example 内科主治医, 他院, かかりつけ, 紹介元, 持参結果.",
      "search_queries must be Japanese master-search phrases for the event, not billing codes or point values. Include concise synonyms when useful, e.g. 眼圧測定, 細隙灯顕微鏡検査, 精密眼底検査, 視野検査, 眼軸長測定.",
      "For materials and devices, mark instruction_only when the text only says 装着指導, 説明, or self-care guidance rather than actual billed use.",
      "Do not put lab values, abnormal findings, or measurement results into diagnoses. Numeric test values, marker elevations, and isolated imaging findings are findings/events, not diagnoses.",
      "Each diagnosis and event must include a short evidence excerpt from the input text.",
      "Keep the response compact: evidence and reasons should be short excerpts, not explanations. Do not add dosage/unit/frequency details unless they are needed for quantity_per_day, days, total_quantity, or area_size_cm2.",
      "Prefer billing_events and excluded_events. Keep missing_information and review_flags empty unless they add information not already present in an event.",
      "The examples below are schema examples only. Do not prefer those diseases, drugs, tests, or specialties. Apply the same event extraction rules to any clinical specialty.",
      "When a performed lab value, imaging result, treatment, management, or counseling event is present in Objective or Plan, extract the event generically by its clinical name even if it is not shown in the examples.",
      "",
      "Examples:",
      "- Text: O欄に「検査名：数値/所見」がある場合 -> billing_events include that test or exam as status=performed, section=O, date_relation=current_visit, provider_ownership=own_clinic, with search_queries suitable for master search.",
      "- Text: P欄に「検査オーダー」「次回」「予定」「後日」がある場合 -> status=planned or ordered, section=P, date_relation=future. Do not mix it with performed events unless O欄 also has same-day results.",
      "- Text: 既往歴、持参結果、他科主治医、他院、かかりつけで管理中 -> status=history or other_provider, date_relation=past or other_provider, provider_ownership=other_department/other_provider. Do not mark it as own_clinic billing.",
      "- Text: 処方薬は、今回新規処方/変更/継続処方が明確な場合だけ medication status=prescribed. 説明・指導・検討だけなら counseling/management or planned, not medication.",
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
    responseId: result.responseId || null,
    usage: result.usage || null
  };
}

function safeSessionContext(context = {}) {
  return {
    patientDisplayName: context.patientDisplayName || "",
    facilityName: context.facilityName || "",
    departmentName: context.departmentName || "",
    serviceDate: context.serviceDate || "",
    billingMonth: context.billingMonth || context.claimMonth || "",
    claimMonth: context.claimMonth || context.billingMonth || "",
    visitType: context.visitType || "",
    diagnoses: Array.isArray(context.diagnoses) ? context.diagnoses.slice(0, 20) : []
  };
}
