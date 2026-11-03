// 文書の本文（1つの文字列）を【見出し】ごとに読み取る。表示・確認・紹介目的の欄だけに使い、
// 保存する本文の形式（body: string）は変えない。

const HEADER = /^【([^】\n]+)】(.*)$/u;
export const PURPOSE_HEADING = "紹介目的";
export const URGENT_LINE = "※至急でのご高診をお願いいたします。";

export function parseLetter(body) {
  const lines = String(body || "").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = HEADER.exec(line);
    if (match) {
      current = { heading: match[1].trim(), note: match[2].trim(), line: index, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  });
  return {
    preamble: trimBlankLines(preamble).join("\n"),
    sections: sections.map(({ lines: sectionLines, ...section }) => ({ ...section, text: trimBlankLines(sectionLines).join("\n") }))
  };
}

export function findSection(body, heading) {
  return parseLetter(body).sections.find((section) => section.heading === heading) || null;
}

// 見出しの下の文だけを置き換える。見出しがなければ本文はそのまま。前後の見出しや他の文には触れない。
export function setSectionText(body, heading, text) {
  const lines = String(body || "").split("\n");
  const index = lines.findIndex((line) => HEADER.exec(line)?.[1].trim() === heading);
  if (index < 0) return body;
  let end = index + 1;
  while (end < lines.length && !HEADER.test(lines[end])) end += 1;
  const content = lines.slice(index + 1, end);
  let trailing = 0;
  while (trailing < content.length && !content[content.length - 1 - trailing].trim()) trailing += 1;
  const allBlank = trailing === content.length;
  const atEnd = end >= lines.length;
  const keep = allBlank ? (atEnd ? 0 : 1) : (atEnd ? trailing : Math.max(1, trailing));
  const nextText = String(text || "").replace(/\s+$/u, "");
  const replacement = [...(nextText ? nextText.split("\n") : []), ...Array(keep).fill("")];
  return [...lines.slice(0, index + 1), ...replacement, ...lines.slice(end)].join("\n");
}

// 紹介目的の欄。先頭行が至急の定型文なら、それを除いた文を返す。
export function readPurpose(body) {
  const section = findSection(body, PURPOSE_HEADING);
  if (!section) return null;
  const [first, ...rest] = section.text.split("\n");
  const urgent = first === URGENT_LINE;
  return { urgent, text: urgent ? rest.join("\n").replace(/^\n+/u, "") : section.text };
}

export function writePurpose(body, { text, urgent }) {
  // 欄の中で見出しを作らないよう、隅付き括弧は置き換える
  const safe = String(text || "").replace(/【/gu, "［").replace(/】/gu, "］");
  return setSectionText(body, PURPOSE_HEADING, [urgent ? URGENT_LINE : "", safe].filter(Boolean).join("\n"));
}

// 確定前の確認。level: "blocker" は確定できない、"warning" は確認を促すだけ。
export function letterChecks({ type, recipient = {}, body = "", sender = {} }) {
  const checks = [];
  if (!String(body).trim()) checks.push({ code: "body_empty", level: "blocker", message: "本文が空です。" });
  if (type === "referral") {
    const purpose = readPurpose(body);
    if (!purpose) checks.push({ code: "purpose_missing", level: "warning", message: "本文に【紹介目的】の見出しがありません。" });
    else if (!purpose.text.trim()) checks.push({ code: "purpose_empty", level: "blocker", message: "紹介目的が空です。" });
  }
  if ((type === "referral" || type === "reply") && !String(recipient.institution || "").trim()) {
    checks.push({ code: "recipient_empty", level: "warning", message: "宛先の医療機関が空です。" });
  }
  const missing = [
    sender.facilityName ? "" : "医療機関名",
    sender.address ? "" : "住所",
    sender.phone ? "" : "電話番号"
  ].filter(Boolean);
  if (missing.length) {
    checks.push({ code: "sender_incomplete", level: "warning", message: `差出人の${missing.join("・")}が未登録です（施設情報の登録が必要です）。` });
  }
  return checks;
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}
