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
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "evidence"],
        properties: {
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["confirmed", "suspected", "history", "denied", "unclear"]
          },
          evidence: { type: "string" }
        }
      }
    },
    billing_events: {
      type: "array",
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
          "dose",
          "quantity_per_day",
          "days",
          "total_quantity",
          "unit",
          "frequency",
          "area_size_cm2",
          "review_reason"
        ],
        properties: eventProperties()
      }
    },
    excluded_events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "status", "evidence", "reason"],
        properties: {
          type: { type: "string", enum: EVENT_TYPES },
          name: { type: "string" },
          status: { type: "string", enum: EVENT_STATUSES },
          evidence: { type: "string" },
          reason: { type: "string" }
        }
      }
    },
    missing_information: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "reason", "evidence"],
        properties: {
          field: { type: "string" },
          reason: { type: "string" },
          evidence: { type: "string" }
        }
      }
    },
    review_flags: {
      type: "array",
      items: { type: "string" }
    }
  }
};

function eventProperties() {
  return {
    type: { type: "string", enum: EVENT_TYPES },
    name: { type: "string" },
    status: { type: "string", enum: EVENT_STATUSES },
    evidence: { type: "string" },
    modality: {
      type: "string",
      enum: ["simple_radiography", "ct", "mri", "ultrasound", "endoscopy", "other", "none"]
    },
    body_site: { type: "string" },
    dose: { type: "string" },
    quantity_per_day: { type: "string" },
    days: { type: "string" },
    total_quantity: { type: "string" },
    unit: { type: "string" },
    frequency: { type: "string" },
    area_size_cm2: { type: "string" },
    review_reason: { type: "string" }
  };
}

export async function extractFeeClinicalFactsWithOpenAi({
  apiKey,
  clinicalText,
  sessionContext = {},
  model = "gpt-5.4-nano",
  reasoningEffort = "low"
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
      "Each diagnosis and event must include a short evidence excerpt from the input text."
    ].join("\n"),
    input,
    schemaName: "fee_clinical_facts",
    schema: feeClinicalFactsSchema
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
