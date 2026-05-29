function joinTurnTexts(turns) {
  return turns.map((turn) => turn.text.trim()).filter(Boolean).join("\n");
}

function extractObjectivePoints(transcript) {
  const points = [];

  if (transcript.includes("熱")) {
    points.push("発熱に関する訴えあり。数値の確認は医師レビュー前提。");
  }

  if (transcript.includes("咳")) {
    points.push("咳症状に関する発言あり。");
  }

  if (transcript.includes("血圧")) {
    points.push("血圧に関する会話あり。");
  }

  if (points.length === 0) {
    points.push("診察会話ログ由来の草案であり、身体所見は医師確認前提。");
  }

  return points.join("\n");
}

function buildMockOutputText({ session, transcript, objectiveText }) {
  const patientName = session.patientDisplayName || "患者";

  return [
    "#",
    `【主訴】${transcript}`,
    "【現病歴】会話ログに基づく確認用の仮下書きです。",
    "【既往歴】",
    "【内服薬】",
    "【家族歴】",
    "【アレルギー】",
    "【生活歴】",
    "",
    "S",
    transcript,
    "",
    "O",
    objectiveText,
    "",
    "A",
    `${patientName}の訴えに基づく初期草案です。確定診断や鑑別は医師レビューで補完してください。`,
    "",
    "P",
    "必要な診察・検査・処方方針を医師が確認し、EMR転記前に表現と不足情報を見直してください。"
  ].join("\n");
}

export function buildMockSoapDraft({ session, turns, transcriptOverride = "" }) {
  const transcript = transcriptOverride.trim() || joinTurnTexts(turns);
  const shortTranscript = transcript || "会話ログがまだ十分に取得されていません。";
  const objectiveText = extractObjectivePoints(shortTranscript);

  return {
    outputText: buildMockOutputText({
      session,
      transcript: shortTranscript,
      objectiveText
    }),
    structuredJson: {
      provenance: "mock",
      transcriptLength: shortTranscript.length
    }
  };
}
