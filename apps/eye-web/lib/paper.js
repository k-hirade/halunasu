// 紙面（処方箋・文書）の表示用の小さな関数。画面の部品から切り離してテストできるようにする。

// 処方箋の No.: 受診日 + カルテ ID の末尾 6 桁 + 確定版（例: 20261103-3F9A2C-1）。
// 院全体の連番は持たず、同じ版なら何度印刷しても同じ番号になる。
export function prescriptionSerial(encounterId = "", encounterDate = "", version = null) {
  const tail = String(encounterId || "").replace(/[^0-9a-z]/giu, "").slice(-6).toUpperCase();
  return [String(encounterDate || "").replaceAll("-", ""), tail, version ? String(version) : ""].filter(Boolean).join("-");
}

export const DEFAULT_HONORIFIC = "御侍史";
export const HONORIFIC_OPTIONS = [
  ["御侍史", "先生 御侍史"],
  ["御机下", "先生 御机下"],
  ["先生", "先生"],
  ["殿", "殿"],
  ["御中", "御中（施設宛て）"]
];

// 宛名の組み立て。敬称が未設定の文書は従来どおり「○○ 先生 御侍史」（医師名がなければ「ご担当 先生 御侍史」）。
// 戻り値: to（医療機関・診療科）、toSuffix（「御中」）、person（医師名の部分。"" は手書き用の空欄、null は行を出さない）、suffix（敬称）。
export function recipientLines(recipient = {}) {
  const to = [recipient.institution, recipient.department].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  const doctor = String(recipient.doctor || "").trim();
  const honorific = recipient.honorific || DEFAULT_HONORIFIC;
  if (honorific === "御中") {
    return { to, toSuffix: "御中", person: doctor ? `${doctor} 先生` : null, suffix: "" };
  }
  if (honorific === "殿") {
    return { to, toSuffix: "", person: doctor || (to ? "ご担当者" : ""), suffix: "殿" };
  }
  const person = doctor ? `${doctor} 先生` : to ? "ご担当 先生" : "";
  return { to, toSuffix: "", person, suffix: honorific === "先生" ? "" : honorific };
}
