import { buildEncounterGlossary } from "../medical/encounter-domains.js";
import { createStructuredOpenAiResponse } from "../openai/responses-structured.js";

const CLINICAL_FACTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    encounter_domains: {
      type: "array",
      items: { type: "string" }
    },
    chief_complaint: {
      type: "string"
    },
    hpi_summary: {
      type: "string"
    },
    symptom_timeline: {
      type: "string"
    },
    pertinent_positives: {
      type: "array",
      items: { type: "string" }
    },
    pertinent_negatives: {
      type: "array",
      items: { type: "string" }
    },
    symptoms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["present", "denied", "unclear"]
          },
          timeline: { type: "string" },
          evidence: { type: "string" }
        },
        required: ["name", "status", "timeline", "evidence"]
      }
    },
    red_flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["present", "denied", "unclear"]
          },
          evidence: { type: "string" }
        },
        required: ["name", "status", "evidence"]
      }
    },
    medications_mentioned: {
      type: "array",
      items: { type: "string" }
    },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["current", "past", "recommended", "prescribed", "questioned", "unknown"]
          },
          evidence: { type: "string" }
        },
        required: ["name", "status", "evidence"]
      }
    },
    allergies_mentioned: {
      type: "array",
      items: { type: "string" }
    },
    exam_or_test_findings_explicit: {
      type: "array",
      items: { type: "string" }
    },
    objective_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["vital", "exam", "test", "imaging", "other"]
          },
          text: { type: "string" },
          evidence: { type: "string" }
        },
        required: ["category", "text", "evidence"]
      }
    },
    assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          likelihood: {
            type: "string",
            enum: ["high", "medium", "low"]
          },
          rationale: { type: "string" }
        },
        required: ["name", "likelihood", "rationale"]
      }
    },
    plan_candidates: {
      type: "array",
      items: { type: "string" }
    },
    plan_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["medication", "test", "counseling", "activity", "follow_up", "return_precaution", "other"]
          },
          text: { type: "string" },
          evidence: { type: "string" }
        },
        required: ["category", "text", "evidence"]
      }
    },
    return_precautions: {
      type: "array",
      items: { type: "string" }
    },
    clinician_review_flags: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "encounter_domains",
    "chief_complaint",
    "hpi_summary",
    "symptom_timeline",
    "pertinent_positives",
    "pertinent_negatives",
    "symptoms",
    "red_flags",
    "medications_mentioned",
    "medications",
    "allergies_mentioned",
    "exam_or_test_findings_explicit",
    "objective_items",
    "assessments",
    "plan_candidates",
    "plan_items",
    "return_precautions",
    "clinician_review_flags"
  ]
};

function buildFactsInstructions({ glossary, domainLabels, domainIds }) {
  return [
    "You are generating structured clinical facts from a Japanese outpatient encounter transcript.",
    "Return only facts supported by the transcript or explicit session context.",
    "Do not invent vitals, physical exam findings, labs, diagnoses, or medications that are not explicitly mentioned.",
    "Preserve clinically important negatives and return precautions.",
    "Represent symptoms and red flags with explicit status fields. Use denied when the transcript clearly negates a symptom.",
    "For medications, separate current use from clinician recommendations. If a clinician only suggests or offers a medication, do not mark it as current.",
    "If no explicit objective information is present, objective_items must be an empty array.",
    "Do not place patient-reported symptoms into objective_items.",
    "If a plan item was only discussed as a possible option or recommendation, preserve that wording conservatively.",
    "When the transcript suggests but does not confirm a diagnosis, place it in assessments with rationale and conservative likelihood.",
    `If encounter_domains are strongly supported, use only these IDs: ${domainIds.join(", ") || "general_outpatient"}. If unclear, prefer an empty array.`,
    `Possible background domains (weak hints only): ${domainLabels.join(", ") || "general outpatient"}.`,
    `Glossary terms are weak disambiguation hints only: ${glossary.join("、")}. Never let them override direct transcript wording.`,
    "Only include return_precautions when they are explicitly stated in the transcript.",
    "Clinician review flags must be high-signal and encounter-specific. Do not add generic statements about unrelated disease categories. Return at most three flags."
  ].join(" ");
}

function buildFactsInput({ transcript, sessionContext, domainLabels, glossary }) {
  return [
    `Session title: ${sessionContext.title || ""}`,
    `Visit reason: ${sessionContext.visitReason || ""}`,
    `Patient display name: ${sessionContext.patientDisplayName || ""}`,
    `Optional domain hints: ${domainLabels.join(", ") || "none"}`,
    `Optional glossary hints: ${glossary.join("、")}`,
    "Transcript:",
    transcript
  ].join("\n");
}

export async function extractClinicalFactsWithOpenAi({
  apiKey,
  transcript,
  sessionContext = {},
  model = "gpt-5.4-nano",
  reasoningEffort = "low"
}) {
  if (!transcript.trim()) {
    throw new Error("Clinical facts extraction requires a non-empty transcript");
  }

  const { domains, domainLabels, glossary } = buildEncounterGlossary({
    sessionContext,
    transcript
  });

  const { parsed, responseId, usage } = await createStructuredOpenAiResponse({
    apiKey,
    model,
    reasoningEffort,
    schemaName: "clinical_facts",
    schema: CLINICAL_FACTS_SCHEMA,
    instructions: buildFactsInstructions({
      glossary,
      domainLabels,
      domainIds: domains
    }),
    input: buildFactsInput({
      transcript,
      sessionContext,
      domainLabels,
      glossary
    })
  });

  return {
    ...parsed,
    encounter_domains:
      parsed.encounter_domains?.length ? parsed.encounter_domains : domains,
    model,
    responseId,
    usage
  };
}
