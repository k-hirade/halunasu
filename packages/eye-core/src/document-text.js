// 文書（紹介状・返書・診断書）にカルテの内容を差し込むときの文の組み立て。
// サーバーの定型文（新規作成時）と、画面の「カルテから挿入」で同じ書式にするため共用する。

const EYE_NAMES = Object.freeze({ od: "右眼", os: "左眼", ou: "両眼" });
const ALLERGY_SEVERITY = Object.freeze({ unknown: "", mild: "軽度", moderate: "中等度", severe: "重篤" });
const FINDING_LABELS = Object.freeze([["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]]);

// 「異常なし」などの正常を表す所見。「異常のみ」で差し込むときに除く（文全体がこれだけのときに限る）。
const NORMAL_FINDING = /^(?:異常(?:所見)?なし|正常(?:範囲)?|特記(?:事項|すべき(?:所見|事項)?)?なし|所見なし|著変なし|著明な変化なし|変化なし|清明|透明|n\.?p\.?|wnl|nad)[。．.]?$/iu;

export function documentDiagnosisText(item = {}) {
  return `${EYE_NAMES[item.eye] || ""} ${item.name}${item.status === "suspected" ? "（疑い）" : ""}`.trim();
}

// 差し込む病名。治癒した病名は除く。患者プロファイルがあればそちらを使う。
export function documentDiagnoses(profile, content = {}) {
  return (profile?.diagnoses || content.diagnoses || []).filter((item) => item.status !== "resolved" && String(item.name || "").trim());
}

export function documentAllergyText(profile) {
  if (profile?.allergies?.length) {
    return profile.allergies
      .map((item) => `${item.substance}${item.reaction ? `（${item.reaction}${ALLERGY_SEVERITY[item.severity] ? `・${ALLERGY_SEVERITY[item.severity]}` : ""}）` : ""}`)
      .join("、");
  }
  return profile?.noKnownAllergies ? "なし" : "未確認";
}

export function documentHistoryText(profile) {
  return [profile?.ophthalmicHistory, profile?.medicalHistory].filter(Boolean).join("\n");
}

export function documentVaText(value = {}) {
  const corrected = value.vaCorrected ? `（${value.vaCorrected}）` : "";
  return value.vaUncorrected || corrected ? `${value.vaUncorrected || "—"}${corrected}` : "—";
}

export function documentIopText(value = {}) {
  return Number.isFinite(value?.iop) ? `${value.iop} mmHg` : "—";
}

export function documentVaLine(exam = {}) {
  return `視力 右 ${documentVaText(exam.od)}　左 ${documentVaText(exam.os)}`;
}

export function documentIopLine(exam = {}) {
  return `眼圧 右 ${documentIopText(exam.od)}　左 ${documentIopText(exam.os)}`;
}

export function isNormalFinding(text) {
  return NORMAL_FINDING.test(String(text || "").trim());
}

// 所見を「右眼 前眼部: …」の行にする。abnormalOnly なら「異常なし」などの正常所見を除く。
export function documentFindingLines(findings = {}, { abnormalOnly = false } = {}) {
  return ["od", "os"].flatMap((side) => FINDING_LABELS
    .filter(([key]) => findings?.[side]?.[key])
    .filter(([key]) => !abnormalOnly || !isNormalFinding(findings[side][key]))
    .map(([key, label]) => ({ side, key, text: `${EYE_NAMES[side]} ${label}: ${findings[side][key]}` })));
}
