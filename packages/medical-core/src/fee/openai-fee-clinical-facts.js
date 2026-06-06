import { createStructuredOpenAiResponse } from "../openai/responses-structured.js";

const EVENT_STATUSES = [
  "performed",
  "prescribed",
  "administered",
  "planned",
  "ordered",
  "instruction_only",
  "history",
  "negated",
  "unclear"
];

const EVENT_TYPES = [
  "outpatient_basic",
  "imaging",
  "procedure",
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
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "name",
          "status",
          "evidence",
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
    evidence: shortString(90),
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
      "For materials and devices, mark instruction_only when the text only says 装着指導, 説明, or self-care guidance rather than actual billed use.",
      "Each diagnosis and event must include a short evidence excerpt from the input text.",
      "Keep the response compact: evidence and reasons should be short excerpts, not explanations. Do not add dosage/unit/frequency details unless they are needed for quantity_per_day, days, total_quantity, or area_size_cm2.",
      "Prefer billing_events and excluded_events. Keep missing_information and review_flags empty unless they add information not already present in an event."
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
    billingMonth: context.billingMonth || "",
    visitType: context.visitType || "",
    diagnoses: Array.isArray(context.diagnoses) ? context.diagnoses.slice(0, 20) : []
  };
}
