const KEYWORD_LABELS = [
  ["咳", "咳"],
  ["発熱", "発熱"],
  ["熱", "発熱"],
  ["血圧", "血圧"],
  ["頭痛", "頭痛"],
  ["呼吸苦", "呼吸苦"],
  ["のど", "咽頭症状"]
];

export function buildHighlightsFromTurns(turns) {
  const transcript = turns.map((turn) => turn.text).join(" ");
  const items = [];

  for (const [keyword, label] of KEYWORD_LABELS) {
    if (transcript.includes(keyword)) {
      items.push({
        kind: "signal",
        label,
        value: "会話に出現"
      });
    }
  }

  if (transcript.includes("ありません") || transcript.includes("なし")) {
    items.push({
      kind: "negative",
      label: "否定所見",
      value: "あり"
    });
  }

  return items.slice(0, 6);
}
