import {
  documentAllergyText,
  documentDiagnoses,
  documentDiagnosisText,
  documentFindingLines,
  documentHistoryText,
  documentIopLine,
  documentVaLine,
  prescriptionLabel
} from "../../../packages/eye-core/src/index.js";

// 文書雛形の差し込み。雛形の本文の {{患者氏名}} などを、文書の患者・差し込み元のカルテ・患者プロファイルの値に置き換える。
// 知らない差し込み名はそのまま残す（入力の欄として見える）。値が無いときは空にする。

export const TEMPLATE_PLACEHOLDERS = Object.freeze([
  ["患者氏名", "患者の氏名"],
  ["フリガナ", "患者のフリガナ"],
  ["生年月日", "生年月日（YYYY年M月D日）"],
  ["年齢", "発行日の年齢"],
  ["性別", "男・女"],
  ["傷病名", "病名（治癒を除く・1行ずつ）"],
  ["処方", "カルテの処方（1行ずつ）"],
  ["視力", "視力（右・左）"],
  ["眼圧", "眼圧（右・左）"],
  ["所見", "眼別の所見と主訴・所見の記載"],
  ["主訴", "主訴・現病歴"],
  ["方針", "カルテの方針（Plan）"],
  ["アレルギー", "アレルギー・副作用歴"],
  ["既往歴", "既往歴"],
  ["受診日", "差し込み元のカルテの日付"],
  ["発行日", "文書の発行日"],
  ["医療機関名", "差出人の医療機関名"],
  ["医師名", "差出人の医師名"]
]);

const SEX = { male: "男", female: "女" };
const PLACEHOLDER = /\{\{\s*([^{}\s]{1,20})\s*\}\}/gu;

export function templateValues({ document, encounter, profile }) {
  const patient = document?.patientSnapshot || {};
  const content = encounter?.content || {};
  const exam = content.exam || {};
  const diagnoses = documentDiagnoses(profile, content).map(documentDiagnosisText);
  const prescriptions = (content.prescriptions || []).filter((item) => item.name).map(prescriptionLabel);
  const findings = [
    ...documentFindingLines(content.findings).map((item) => item.text),
    ...(String(content.findingsText || "").trim() ? [String(content.findingsText).trim()] : [])
  ];
  const issueDate = document?.issueDate || "";
  const lines = (items) => items.map((item) => `・${item}`).join("\n");
  return {
    患者氏名: patient.displayName || "",
    フリガナ: patient.displayNameKana || "",
    生年月日: japaneseDate(patient.birthDate),
    年齢: ageText(patient.birthDate, issueDate),
    性別: SEX[patient.sex] || "",
    傷病名: lines(diagnoses),
    処方: lines(prescriptions),
    視力: encounter ? documentVaLine(exam) : "",
    眼圧: encounter ? documentIopLine(exam) : "",
    所見: findings.join("\n"),
    主訴: [content.chiefComplaint, content.history].filter(Boolean).join("\n"),
    方針: content.plan || "",
    アレルギー: documentAllergyText(profile),
    既往歴: documentHistoryText(profile),
    受診日: japaneseDate(encounter?.encounterDate),
    発行日: japaneseDate(issueDate),
    医療機関名: document?.sender?.facilityName || "",
    医師名: document?.sender?.doctorName || ""
  };
}

export function fillTemplate(body, values) {
  return String(body || "").replace(PLACEHOLDER, (match, name) => (Object.hasOwn(values, name) ? values[name] : match));
}

function japaneseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(value || ""));
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : "";
}

function ageText(birthDate, on) {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(birthDate || ""));
  const day = /^(\d{4})-(\d{2})-(\d{2})/u.exec(String(on || ""));
  if (!birth || !day) return "";
  let age = Number(day[1]) - Number(birth[1]);
  if (`${day[2]}${day[3]}` < `${birth[2]}${birth[3]}`) age -= 1;
  return age >= 0 ? `${age}歳` : "";
}
