import { createHash } from "node:crypto";
import { createId, nowIso } from "../lib/ids.js";

export const SOAP_FORMAT_SCOPES = ["organization", "facility", "department", "member"];
export const SOAP_SECTION_STYLES = ["paragraph", "bullet", "problem_list"];
export const SOAP_DETAIL_LEVELS = ["brief", "standard", "detailed"];
export const SOAP_EMPTY_BEHAVIORS = ["empty", "mention_not_discussed"];
export const SOAP_HEADING_STYLES = ["soap_letters", "japanese_labels", "none"];
export const SOAP_COPY_FORMATS = ["emr_plain_text", "markdown_like"];

export const SOAP_PROMPT_TEMPLATE_MARKER = "【テンプレート】";
export const SOAP_PROMPT_EXAMPLE_MARKER = "【出力例】";
export const SOAP_PROMPT_STYLE_MARKER = "【スタイル】";

const DEFAULT_SOAP_TEMPLATE_BODY = `#
S
【主訴】
【現病歴】
【併存症】
【既往歴】
【内服薬】
【家族歴】
【アレルギー】
【生活歴】

O
【全身状態】
【バイタル】
【身体所見】
【検体検査】
【生理検査】
【画像検査】

A
#1
所見の要約:
鑑別診断と根拠:
評価:

P
Dx:
Tx:
Ex:`;

const DEFAULT_SOAP_OUTPUT_EXAMPLE = `S
【主訴】胸が痛い
【現病歴】本日午前10時頃、安静時に突然左前胸部の締め付けるような痛みが出現。持続時間は約15分。冷汗を伴った。嘔気なし、呼吸困難なし。来院時には痛みは軽減している。
【既往歴】高血圧、脂質異常症、2型糖尿病
【内服薬】アムロジピン5mg 1錠 朝、ロスバスタチン2.5mg 1錠 夕、メトホルミン500mg 2錠 朝夕
【家族歴】父が62歳時に心筋梗塞、母が70歳時に脳梗塞
【アレルギー】薬剤アレルギーなし、食物アレルギーなし
【生活歴】喫煙20本/日を35年、飲酒ビール350ml/日、ADL自立

O
意識清明。BT 36.5℃、BP 158/92mmHg、HR 88/分、RR 18/分、SpO2 98%（室内気）。心音整、呼吸音清。下肢浮腫なし。トロポニンI軽度上昇。

A
急性冠症候群疑い。冠危険因子を複数有し、心筋虚血の鑑別が必要。

P
循環器内科コンサルト
心電図モニター装着、安静
トロポニン再検
必要時ニトログリセリン頓用
禁煙指導`;

const DEFAULT_SOAP_STYLE_GUIDE = `出力例は文体と粒度の参考として使い、症状、数値、診断名、処方内容は現在の会話にある事実だけを書く。
会話にない身体所見、検査値、家族歴、既往歴は補わない。
Pは簡潔な改行列挙で記載する。`;

const SOAP_PROMPT_MARKER_TO_KEY = new Map([
  [SOAP_PROMPT_TEMPLATE_MARKER, "templateText"],
  [SOAP_PROMPT_EXAMPLE_MARKER, "exampleText"],
  [SOAP_PROMPT_STYLE_MARKER, "styleText"]
]);

function composePromptBlock(marker, body) {
  const cleanBody = cleanMultilineText(body, 12000);
  return cleanBody ? `${marker}\n${cleanBody}` : marker;
}

export function buildSoapPromptSpecification({
  templateText = DEFAULT_SOAP_TEMPLATE_BODY,
  exampleText = DEFAULT_SOAP_OUTPUT_EXAMPLE,
  styleText = DEFAULT_SOAP_STYLE_GUIDE
} = {}) {
  const blocks = [
    composePromptBlock(SOAP_PROMPT_TEMPLATE_MARKER, templateText),
    composePromptBlock(SOAP_PROMPT_EXAMPLE_MARKER, exampleText)
  ];
  const cleanedStyle = cleanMultilineText(styleText, 4000);
  if (cleanedStyle) {
    blocks.push(composePromptBlock(SOAP_PROMPT_STYLE_MARKER, cleanedStyle));
  }
  return blocks.join("\n\n");
}

export const DEFAULT_SOAP_OUTPUT_TEMPLATE = buildSoapPromptSpecification();

export const DEFAULT_SOAP_FORMAT_SECTIONS = [
  {
    key: "subjective",
    label: "S",
    order: 1,
    style: "paragraph",
    detailLevel: "standard",
    emptyBehavior: "empty",
    customInstruction: "患者の主訴、現病歴、経過、関連する陰性所見を会話に基づいて簡潔にまとめる。"
  },
  {
    key: "objective",
    label: "O",
    order: 2,
    style: "paragraph",
    detailLevel: "standard",
    emptyBehavior: "empty",
    customInstruction: "会話内で明示されたバイタル、身体所見、検査結果、観察事実のみを記載する。"
  },
  {
    key: "assessment",
    label: "A",
    order: 3,
    style: "paragraph",
    detailLevel: "standard",
    emptyBehavior: "empty",
    customInstruction: "会話から支持される評価と鑑別を、断定しすぎず医師が確認しやすい粒度で記載する。"
  },
  {
    key: "plan",
    label: "P",
    order: 4,
    style: "paragraph",
    detailLevel: "standard",
    emptyBehavior: "empty",
    customInstruction: "会話で説明された治療、検査、生活指導、再診目安、悪化時対応のみを記載する。"
  }
];

export const DEFAULT_SOAP_FORMAT_CUSTOMIZATION = {
  tone: "簡潔で臨床現場で編集しやすい日本語",
  detailLevel: "standard",
  globalInstruction: "診療会話、患者情報、明示された文脈で確認できた内容だけを用いる。鑑別に必要な陽性所見と陰性所見を区別し、問題が複数ある場合は#1、#2のように整理する。PはDx、Tx、Exに分けて臨床現場で転記しやすい形にする。",
  additionalInstructions: [],
  outputPreferences: {
    headingStyle: "soap_letters",
    copyFormat: "emr_plain_text"
  }
};

export const DEFAULT_SOAP_FORMAT_PROFILE = {
  profileId: "system-default",
  profileVersionId: "system-default-v1",
  promptVersion: "system-default-v1",
  templateKey: "outpatient_soap_note",
  displayName: "病院標準: 外来SOAP（基本型）",
  scope: "organization",
  ownerMemberId: null,
  facilityId: null,
  departmentId: null,
  status: "active",
  approved: true,
  outputTemplate: DEFAULT_SOAP_OUTPUT_TEMPLATE,
  customization: DEFAULT_SOAP_FORMAT_CUSTOMIZATION,
  sections: [],
  source: "system"
};

const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;
const DANGEROUS_PROMPT_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s*:/i,
  /developer\s*:/i,
  /必ず診断を確定/i,
  /会話にない.{0,20}(補完|記載|追加|生成|作成|推定)/i,
  /(捏造|架空).{0,12}(して|する|してよい|して良い|可|よい|良い)/i
];

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(CONTROL_CHARS_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeSoapFormatDisplayNameKey(value) {
  return cleanText(String(value || "").normalize("NFKC"), 120).toLocaleLowerCase("ja-JP");
}

function cleanMultilineText(value, maxLength = 8000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").trimEnd())
    .join("\n")
    .trim()
    .slice(0, maxLength);
}

function extractSoapLetterHeadings(text) {
  const headings = new Set();
  for (const line of cleanMultilineText(text, 12000).split("\n")) {
    const normalized = line.trim().toUpperCase();
    if (["S", "O", "A", "P"].includes(normalized)) {
      headings.add(normalized);
    }
  }
  return headings;
}

export function parseSoapPromptSpecification(value) {
  const rawText = cleanMultilineText(value, 12000);
  const lines = rawText.split("\n");
  const sectionLines = {
    templateText: [],
    exampleText: [],
    styleText: []
  };
  const markerOrder = [];
  let currentKey = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const nextKey = SOAP_PROMPT_MARKER_TO_KEY.get(line);

    if (nextKey) {
      markerOrder.push(line);
      currentKey = nextKey;
      continue;
    }

    if (currentKey) {
      sectionLines[currentKey].push(rawLine);
    }
  }

  const hasStructuredBlocks = markerOrder.length > 0;
  const templateText = cleanMultilineText(sectionLines.templateText.join("\n"), 8000);
  const exampleText = cleanMultilineText(sectionLines.exampleText.join("\n"), 12000);
  const styleText = cleanMultilineText(sectionLines.styleText.join("\n"), 4000);

  return {
    rawText,
    hasStructuredBlocks,
    markerOrder,
    templateText: hasStructuredBlocks ? templateText : rawText,
    exampleText: hasStructuredBlocks ? exampleText : "",
    styleText: hasStructuredBlocks ? styleText : ""
  };
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeOutputPreferences(value = {}) {
  return {
    headingStyle: normalizeEnum(value.headingStyle, SOAP_HEADING_STYLES, "soap_letters"),
    copyFormat: normalizeEnum(value.copyFormat, SOAP_COPY_FORMATS, "emr_plain_text")
  };
}

export function normalizeSoapFormatSections(sections = DEFAULT_SOAP_FORMAT_SECTIONS) {
  const source = Array.isArray(sections) && sections.length > 0 ? sections : DEFAULT_SOAP_FORMAT_SECTIONS;

  return source
    .slice(0, 12)
    .map((section, index) => ({
      key: cleanText(section.key || DEFAULT_SOAP_FORMAT_SECTIONS[index]?.key || `section_${index + 1}`, 80),
      label: cleanText(section.label || DEFAULT_SOAP_FORMAT_SECTIONS[index]?.label || `項目${index + 1}`, 80),
      order: Number.isInteger(section.order) ? section.order : index + 1,
      style: normalizeEnum(section.style, SOAP_SECTION_STYLES, "paragraph"),
      detailLevel: normalizeEnum(section.detailLevel, SOAP_DETAIL_LEVELS, "standard"),
      emptyBehavior: normalizeEnum(section.emptyBehavior, SOAP_EMPTY_BEHAVIORS, "empty"),
      customInstruction: cleanText(section.customInstruction, 1000)
    }))
    .filter((section) => section.key && section.label)
    .sort((left, right) => left.order - right.order)
    .map((section, index) => ({
      ...section,
      order: index + 1
    }));
}

export function normalizeSoapFormatCustomization(customization = {}) {
  return {
    tone: cleanText(customization.tone || DEFAULT_SOAP_FORMAT_CUSTOMIZATION.tone, 200),
    detailLevel: normalizeEnum(customization.detailLevel, SOAP_DETAIL_LEVELS, "standard"),
    globalInstruction: cleanText(customization.globalInstruction, 2000),
    additionalInstructions: Array.isArray(customization.additionalInstructions)
      ? customization.additionalInstructions
          .slice(0, 12)
          .map((item) => cleanText(item, 500))
          .filter(Boolean)
      : [],
    outputPreferences: normalizeOutputPreferences(customization.outputPreferences)
  };
}

export function normalizeSoapFormatProfile(input = {}) {
  return {
    displayName: cleanText(input.displayName || "新しいSOAPフォーマット", 120),
    scope: normalizeEnum(input.scope, SOAP_FORMAT_SCOPES, "member"),
    ownerMemberId: cleanText(input.ownerMemberId, 120) || null,
    facilityId: cleanText(input.facilityId, 120) || null,
    departmentId: cleanText(input.departmentId, 120) || null,
    templateKey: cleanText(input.templateKey || "outpatient_soap_note", 120),
    outputTemplate: cleanMultilineText(input.outputTemplate || input.customization?.outputTemplate || DEFAULT_SOAP_OUTPUT_TEMPLATE, 8000),
    customization: normalizeSoapFormatCustomization(input.customization),
    sections: Array.isArray(input.sections) && input.sections.length > 0 ? normalizeSoapFormatSections(input.sections) : []
  };
}

export function validateSoapFormatDefinition({ customization = {}, outputTemplate = "", sections = [] } = {}) {
  const issues = [];
  const parsedPrompt = parseSoapPromptSpecification(outputTemplate);
  const texts = [
    parsedPrompt.templateText || outputTemplate,
    parsedPrompt.exampleText,
    parsedPrompt.styleText,
    customization.globalInstruction,
    ...(customization.additionalInstructions || []),
    ...(sections || []).map((section) => section.customInstruction)
  ].filter(Boolean);

  for (const text of texts) {
    for (const pattern of DANGEROUS_PROMPT_PATTERNS) {
      if (pattern.test(text)) {
        issues.push({
          code: "unsafe_instruction",
          message: "安全ルールを上書きする可能性がある指示が含まれています。"
        });
        break;
      }
    }
  }

  if (!cleanMultilineText(outputTemplate, 8000)) {
    issues.push({
      code: "output_template_required",
      message: "出力フォーマット本文が必要です。"
    });
  }

  if (cleanMultilineText(outputTemplate, 8000) && !parsedPrompt.hasStructuredBlocks) {
    issues.push({
      code: "prompt_block_markers_required",
      message: "プロンプト本文は「【テンプレート】」「【出力例】」の見出しを含めて記入してください。"
    });
  }

  if (parsedPrompt.hasStructuredBlocks && !parsedPrompt.templateText) {
    issues.push({
      code: "template_block_required",
      message: "「【テンプレート】」の中身を入力してください。"
    });
  }

  if (parsedPrompt.hasStructuredBlocks && !parsedPrompt.exampleText) {
    issues.push({
      code: "example_block_required",
      message: "「【出力例】」の中身を入力してください。"
    });
  }

  if (parsedPrompt.hasStructuredBlocks) {
    const expectedOrder = [SOAP_PROMPT_TEMPLATE_MARKER, SOAP_PROMPT_EXAMPLE_MARKER];
    const hasExpectedLeadingOrder = expectedOrder.every((marker, index) => parsedPrompt.markerOrder[index] === marker);

    if (!hasExpectedLeadingOrder) {
      issues.push({
        code: "prompt_block_order_invalid",
        message: "プロンプト本文は「【テンプレート】」の後に「【出力例】」を置いてください。"
      });
    }

    const templateHeadings = extractSoapLetterHeadings(parsedPrompt.templateText);
    const exampleHeadings = extractSoapLetterHeadings(parsedPrompt.exampleText);
    const missingHeadings = [...templateHeadings].filter((heading) => !exampleHeadings.has(heading));

    if (missingHeadings.length) {
      issues.push({
        code: "example_headings_missing",
        message: `出力例には ${missingHeadings.join(" / ")} を含めてください。`
      });
    }
  }

  return {
    status: issues.length ? "failed" : "passed",
    issues
  };
}

export function hashSoapFormatDefinition(definition) {
  return createHash("sha256").update(JSON.stringify(definition || {})).digest("hex");
}

export function buildSoapFormatVersion({
  profileId,
  previousVersion = 0,
  input,
  status = "draft",
  approved = false,
  actorId = "system",
  createdAt = nowIso()
}) {
  const normalized = normalizeSoapFormatProfile(input);
  const validation = validateSoapFormatDefinition(normalized);
  const version = previousVersion + 1;
  const versionId = createId("fmtv");
  const definitionHash = hashSoapFormatDefinition(normalized);

  return {
    profileVersionId: versionId,
    versionId,
    profileId,
    version,
    status,
    approved,
    validationStatus: validation.status,
    validationIssues: validation.issues,
    templateKey: normalized.templateKey,
    promptVersion: `${profileId}-v${version}`,
    outputTemplate: normalized.outputTemplate,
    customization: normalized.customization,
    sections: normalized.sections,
    resolvedPromptHash: definitionHash,
    createdByMemberId: actorId,
    updatedByMemberId: actorId,
    createdAt,
    updatedAt: createdAt
  };
}

export function resolveActiveSoapFormatVersion(profile = {}) {
  const versions = Array.isArray(profile.versions) ? profile.versions : [];
  const activeVersion = versions
    .filter((version) => (!version.status || version.status === "active") && version.approved !== false)
    .sort((left, right) => (right.version || 0) - (left.version || 0))[0];

  if (activeVersion) {
    return activeVersion;
  }

  if ((profile.status && profile.status !== "active") || profile.approved === false) {
    return null;
  }

  return {
    profileVersionId: profile.profileVersionId || profile.currentVersionId || `${profile.profileId}-v1`,
    versionId: profile.profileVersionId || profile.currentVersionId || `${profile.profileId}-v1`,
    version: profile.version || 1,
    status: profile.status || "active",
    approved: profile.approved !== false,
    templateKey: profile.templateKey || "outpatient_soap_note",
    promptVersion: profile.promptVersion || `${profile.profileId}-v1`,
    outputTemplate: profile.outputTemplate || DEFAULT_SOAP_OUTPUT_TEMPLATE,
    customization: profile.customization || DEFAULT_SOAP_FORMAT_CUSTOMIZATION,
    sections: profile.sections || [],
    resolvedPromptHash: profile.resolvedPromptHash || null
  };
}

export function serializeSoapFormatProfile(profile = {}) {
  const versions = Array.isArray(profile.versions)
    ? [...profile.versions].sort((left, right) => (right.version || 0) - (left.version || 0))
    : [];
  const activeVersion = resolveActiveSoapFormatVersion(profile);
  const latestVersion = versions[0] || activeVersion || null;

  return {
    profileId: profile.profileId,
    formatId: profile.profileId,
    displayName: profile.displayName || "SOAPフォーマット",
    scope: profile.scope || "organization",
    ownerMemberId: profile.ownerMemberId || null,
    facilityId: profile.facilityId || null,
    departmentId: profile.departmentId || null,
    status: profile.status || "draft",
    approved: profile.approved === true,
    currentVersionId: profile.currentVersionId || activeVersion?.profileVersionId || null,
    currentDraftVersionId: profile.currentDraftVersionId || null,
    templateKey: latestVersion?.templateKey || profile.templateKey || "outpatient_soap_note",
    outputTemplate: latestVersion?.outputTemplate || profile.outputTemplate || DEFAULT_SOAP_OUTPUT_TEMPLATE,
    customization: latestVersion?.customization || profile.customization || DEFAULT_SOAP_FORMAT_CUSTOMIZATION,
    sections: latestVersion?.sections || profile.sections || [],
    latestVersion: latestVersion
      ? {
          profileVersionId: latestVersion.profileVersionId || latestVersion.versionId,
          versionId: latestVersion.versionId || latestVersion.profileVersionId,
          version: latestVersion.version || 1,
          status: latestVersion.status || "active",
          approved: latestVersion.approved !== false,
          validationStatus: latestVersion.validationStatus || "passed",
          validationIssues: latestVersion.validationIssues || [],
          createdAt: latestVersion.createdAt || null,
          updatedAt: latestVersion.updatedAt || null
        }
      : null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null
  };
}
