import { createStructuredOpenAiResponse } from "../openai/responses-structured.js";
import {
  buildSoapPromptSpecification,
  DEFAULT_SOAP_FORMAT_CUSTOMIZATION,
  DEFAULT_SOAP_FORMAT_SECTIONS,
  DEFAULT_SOAP_OUTPUT_TEMPLATE,
  normalizeSoapFormatCustomization,
  parseSoapPromptSpecification
} from "./soap-format.js";

const INFERRED_SOAP_FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    display_name_suggestion: { type: "string" },
    rationale: { type: "string" },
    warnings: {
      type: "array",
      items: { type: "string" }
    },
    output_template: { type: "string" },
    tone: { type: "string" },
    detail_level: {
      type: "string",
      enum: ["brief", "standard", "detailed"]
    },
    heading_style: {
      type: "string",
      enum: ["soap_letters", "japanese_labels", "none"]
    },
    global_instruction: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          style: {
            type: "string",
            enum: ["paragraph", "bullet", "problem_list"]
          },
          detail_level: {
            type: "string",
            enum: ["brief", "standard", "detailed"]
          },
          empty_behavior: {
            type: "string",
            enum: ["empty", "mention_not_discussed"]
          },
          custom_instruction: { type: "string" }
        },
        required: [
          "key",
          "label",
          "style",
          "detail_level",
          "empty_behavior",
          "custom_instruction"
        ]
      }
    }
  },
  required: [
    "display_name_suggestion",
    "rationale",
    "warnings",
    "output_template",
    "tone",
    "detail_level",
    "heading_style",
    "global_instruction",
    "sections"
  ]
};

function cleanSingleLine(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMultiline(value, maxLength = 8000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").trimEnd())
    .join("\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeSectionKey(value, index) {
  const normalized = cleanSingleLine(value, 80)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || `section_${index + 1}`;
}

function buildInferenceInstructions() {
  return [
    "You are inferring a reusable Japanese outpatient note output format from example completed notes.",
    "The notes are examples of desired final output shape, not facts to preserve.",
    "Infer the structure, headings, order, tone, and degree of detail that best fits the examples.",
    "Return a blank reusable template in output_template. Do not copy patient-specific content into the template.",
    "Prefer stable headings over one-off phrases from a single sample.",
    "If the examples clearly use SOAP, preserve SOAP and place subjective subheadings inside S rather than before it.",
    "If headings are inconsistent across samples, choose the most clinically reusable common structure.",
    "Keep warnings concise and practical.",
    "global_instruction should be a short Japanese instruction that helps generation follow the inferred style.",
    "sections should describe the major sections that the template uses, in output order.",
    "If uncertain, fall back toward a conventional outpatient SOAP structure instead of inventing a novel format."
  ].join(" ");
}

function buildInferenceInput({ samples, preferredDisplayName }) {
  const blocks = [];

  if (preferredDisplayName) {
    blocks.push(`Preferred display name: ${cleanSingleLine(preferredDisplayName, 120)}`);
  }

  blocks.push(`Sample note count: ${samples.length}`);

  samples.forEach((sample, index) => {
    blocks.push(`--- SAMPLE NOTE ${index + 1} START ---\n${cleanMultiline(sample, 12000)}\n--- SAMPLE NOTE ${index + 1} END ---`);
  });

  return blocks.join("\n\n");
}

function buildFallbackInference({ preferredDisplayName, samples }) {
  return {
    display_name_suggestion: cleanSingleLine(preferredDisplayName, 120) || "普段のカルテに合わせたSOAP",
    rationale: "ローカル推定では高精度な構造抽出ができないため、標準SOAPを土台にしたドラフトを返しています。",
    warnings: [
      "OPENAI_API_KEY未設定のため、標準SOAPをベースにした簡易ドラフトです。",
      samples.length < 3 ? "サンプルは3件以上あると、普段のカルテの共通構造を推定しやすくなります。" : ""
    ].filter(Boolean),
    output_template: DEFAULT_SOAP_OUTPUT_TEMPLATE,
    tone: DEFAULT_SOAP_FORMAT_CUSTOMIZATION.tone,
    detail_level: DEFAULT_SOAP_FORMAT_CUSTOMIZATION.detailLevel,
    heading_style: DEFAULT_SOAP_FORMAT_CUSTOMIZATION.outputPreferences.headingStyle,
    global_instruction: "サンプルカルテの見出し順と粒度を保ちつつ、会話に基づく事実だけで簡潔に記載する。",
    sections: DEFAULT_SOAP_FORMAT_SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      style: section.style,
      detail_level: section.detailLevel,
      empty_behavior: section.emptyBehavior,
      custom_instruction: section.customInstruction
    }))
  };
}

function toFormatDraft(inference, { preferredDisplayName, ownerMemberId = null, samples = [] } = {}) {
  const displayName = cleanSingleLine(preferredDisplayName, 120)
    || cleanSingleLine(inference.display_name_suggestion, 120)
    || "普段のカルテに合わせたSOAP";
  const parsedTemplate = parseSoapPromptSpecification(inference.output_template || DEFAULT_SOAP_OUTPUT_TEMPLATE);
  const templateText = cleanMultiline(parsedTemplate.templateText, 8000) || cleanMultiline(inference.output_template, 8000);
  const exampleText = cleanMultiline(parsedTemplate.exampleText, 12000) || cleanMultiline(samples[0] || "", 12000);

  return {
    displayName,
    scope: "member",
    ownerMemberId,
    facilityId: null,
    departmentId: null,
    templateKey: "outpatient_soap_note",
    outputTemplate: buildSoapPromptSpecification({
      templateText: templateText || DEFAULT_SOAP_OUTPUT_TEMPLATE,
      exampleText,
      styleText: cleanSingleLine(inference.global_instruction, 2000)
    }),
    customization: normalizeSoapFormatCustomization({
      ...DEFAULT_SOAP_FORMAT_CUSTOMIZATION,
      tone: cleanSingleLine(inference.tone, 200) || DEFAULT_SOAP_FORMAT_CUSTOMIZATION.tone,
      detailLevel: inference.detail_level || DEFAULT_SOAP_FORMAT_CUSTOMIZATION.detailLevel,
      globalInstruction: cleanSingleLine(inference.global_instruction, 2000),
      outputPreferences: {
        ...DEFAULT_SOAP_FORMAT_CUSTOMIZATION.outputPreferences,
        headingStyle: inference.heading_style || DEFAULT_SOAP_FORMAT_CUSTOMIZATION.outputPreferences.headingStyle
      }
    }),
    sections: Array.isArray(inference.sections)
      ? inference.sections.slice(0, 12).map((section, index) => ({
          key: normalizeSectionKey(section.key, index),
          label: cleanSingleLine(section.label, 80) || `項目${index + 1}`,
          order: index + 1,
          style: section.style || "paragraph",
          detailLevel: section.detail_level || "standard",
          emptyBehavior: section.empty_behavior || "empty",
          customInstruction: cleanSingleLine(section.custom_instruction, 1000)
        }))
      : []
  };
}

export async function inferSoapFormatFromSampleNotes({
  apiKey,
  samples,
  preferredDisplayName = "",
  ownerMemberId = null,
  model = "gpt-5.4-nano",
  reasoningEffort = "low"
}) {
  const normalizedSamples = Array.isArray(samples)
    ? samples.map((sample) => cleanMultiline(sample, 12000)).filter(Boolean)
    : [];

  if (!normalizedSamples.length) {
    throw new Error("カルテ例を少なくとも1件入力してください。");
  }

  let inferred;
  let provider = "openai";
  let responseId = null;
  let usage = null;

  if (apiKey) {
    const response = await createStructuredOpenAiResponse({
      apiKey,
      model,
      reasoningEffort,
      schemaName: "inferred_soap_format",
      schema: INFERRED_SOAP_FORMAT_SCHEMA,
      instructions: buildInferenceInstructions(),
      input: buildInferenceInput({
        samples: normalizedSamples,
        preferredDisplayName
      })
    });

    inferred = response.parsed;
    responseId = response.responseId;
    usage = response.usage;
  } else {
    provider = "local_fallback";
    inferred = buildFallbackInference({
      preferredDisplayName,
      samples: normalizedSamples
    });
  }

  return {
    provider,
    responseId,
    usage,
    inferred: {
      displayNameSuggestion: cleanSingleLine(inferred.display_name_suggestion, 120),
      rationale: cleanSingleLine(inferred.rationale, 1200),
      warnings: Array.isArray(inferred.warnings)
        ? inferred.warnings.map((item) => cleanSingleLine(item, 300)).filter(Boolean)
        : []
    },
    format: toFormatDraft(inferred, {
      preferredDisplayName,
      ownerMemberId,
      samples: normalizedSamples
    })
  };
}
