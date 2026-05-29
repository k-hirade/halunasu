import { buildEncounterGlossary } from "../medical/encounter-domains.js";

const TRANSCRIPTION_PROMPT_LEAK_MARKERS = [
  "これは日本語の外来診療会話の書き起こしです",
  "特に病名・症状・検査・薬剤・単位を重視してください",
  "以下は途中経過の自動 transcript",
  "参考語彙:"
];

export function buildMedicalTranscriptionPrompt({
  basePrompt = "",
  sessionContext = {},
  transcriptHint = ""
} = {}) {
  const { domainLabels, glossary } = buildEncounterGlossary({
    sessionContext,
    transcript: ""
  });
  const parts = [];

  if (basePrompt?.trim()) {
    parts.push(basePrompt.trim());
  }

  parts.push(
    "これは日本語の外来診療会話の書き起こしです。医療用語と数値を優先し、聞き取れた語を自然な日本語で正確に転写してください。"
  );
  parts.push(
    "特に病名・症状・検査・薬剤・単位を重視してください。似た音の一般語より医療語を優先してください。"
  );
  parts.push(
    "例: 腎盂腎炎、膀胱炎、排尿時痛、頻尿、血尿、抗菌薬、HbA1c、腰痛、前かがみ、湿布 など。"
  );
  parts.push(
    "聞き取りが曖昧な場合でも、医療語として自然な候補を優先してください。ただし、音声で裏付けが弱い語を決め打ちしないでください。"
  );
  parts.push(
    "特に日本語の音近誤りに注意してください。参考語彙や受診理由は補助情報にすぎないため、音声そのものと矛盾する補完はしないでください。"
  );

  if (sessionContext.patientDisplayName) {
    parts.push(`患者名の候補: ${sessionContext.patientDisplayName}`);
  }

  if (sessionContext.visitReason) {
    parts.push(`受診理由の候補: ${sessionContext.visitReason}`);
  }

  if (domainLabels.length) {
    parts.push(`参考になりうる診療領域: ${domainLabels.join("、")}`);
  }

  if (transcriptHint?.trim()) {
    parts.push(
      `以下は途中経過の自動 transcript です。誤りを多く含みうるため、会話の流れを把握する補助にだけ使ってください。語句や病名をそのまま採用しないでください: ${transcriptHint.trim().slice(0, 320)}`
    );
  }

  parts.push(`参考語彙: ${glossary.slice(0, 24).join("、")}`);

  return parts.join(" ");
}

export function sanitizeTranscriptionText(text) {
  const value = String(text || "").trim();

  if (!value) {
    return "";
  }

  const leakIndex = TRANSCRIPTION_PROMPT_LEAK_MARKERS
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (leakIndex == null) {
    return value;
  }

  return value.slice(0, leakIndex).trim();
}
