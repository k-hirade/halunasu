// 設定画面の表示用の小さな関数（画面の部品から切り離してテストできるようにする）。
import { calculateEyeDropBottles } from "@halunasu/eye-core";
import { APPOINTMENT_STATUS_LABELS, EYE_LABELS, PHRASE_TARGET_LABELS, PRESCRIPTION_KIND_LABELS } from "./format.js";

// 検索用の正規化: 全角半角をそろえ（NFKC）、カタカナをひらがなに、英字を小文字にする。
export function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .toLowerCase()
    .trim();
}

export function matchesSearch(query, values) {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  return values.some((value) => normalizeSearch(value).includes(needle));
}

export function drugSearchValues(preset) {
  return [preset.name, preset.defaultUsage, PRESCRIPTION_KIND_LABELS[preset.kind]];
}

export function setSearchValues(set) {
  return [
    set.name,
    set.description,
    set.plan,
    ...(set.prescriptions || []).map((row) => row.name),
    ...(set.orders || []).map((row) => row.name)
  ];
}

export function phraseSearchValues(phrase) {
  return [phrase.label, phrase.text, PHRASE_TARGET_LABELS[phrase.target]];
}

// 「1日4回・就寝前」のような既定値の要約
export function drugDefaultText(preset) {
  return [preset.defaultTimesPerDay ? `1日${preset.defaultTimesPerDay}回` : "", preset.defaultUsage || ""].filter(Boolean).join("・");
}

// 「5mL / 120滴」。点眼以外は出さない
export function drugBottleText(preset) {
  if (preset.kind !== "eye_drop") return "";
  return [preset.bottleVolumeMl ? `${preset.bottleVolumeMl}mL` : "", preset.dropsPerBottle ? `${preset.dropsPerBottle}滴` : ""].filter(Boolean).join(" / ");
}

export function setContentText(set) {
  return [
    set.prescriptions?.length ? `処方${set.prescriptions.length}` : "",
    set.orders?.length ? `検査${set.orders.length}` : "",
    set.plan ? "方針" : ""
  ].filter(Boolean).join(" ");
}

// 1本で何日分になるか。計算はカルテ側と同じ calculateEyeDropBottles に任せ、1本で足りる最大の日数を探す。
const MAX_DAYS_PER_BOTTLE = 365;
export function daysPerBottle({ timesPerDay, eye = "ou", dropsPerBottle } = {}) {
  const first = calculateEyeDropBottles({ timesPerDay, eye, days: 1, dropsPerBottle });
  if (first.bottles === null) return null;
  if (first.bottles > 1) return { days: 0, dropsPerBottle: first.dropsPerBottle, capped: false };
  let low = 1;
  let high = MAX_DAYS_PER_BOTTLE;
  if (calculateEyeDropBottles({ timesPerDay, eye, days: high, dropsPerBottle }).bottles === 1) {
    return { days: high, dropsPerBottle: first.dropsPerBottle, capped: true };
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (calculateEyeDropBottles({ timesPerDay, eye, days: middle, dropsPerBottle }).bottles === 1) low = middle;
    else high = middle;
  }
  return { days: low, dropsPerBottle: first.dropsPerBottle, capped: false };
}

// 操作記録の種類（API の category と同じキー）
export const AUDIT_CATEGORY_LABELS = {
  view: "閲覧",
  change: "作成・更新",
  finalize: "確定",
  export: "出力",
  settings: "設定",
  other: "その他"
};

export const AUDIT_EVENT_LABELS = {
  "eye.chart_viewed": "患者カルテを閲覧",
  "eye.encounter_viewed": "カルテを閲覧",
  "eye.version_viewed": "確定版を閲覧",
  "eye.encounter_created": "カルテを作成",
  "eye.encounter_updated": "カルテを更新",
  "eye.encounter_finalized": "カルテを確定",
  "eye.encounter_amend_started": "確定版の修正を開始",
  "eye.encounter_discarded": "下書きを破棄",
  "eye.drug_preset_saved": "薬剤設定を保存",
  "eye.order_set_saved": "セットを保存",
  "eye.phrase_saved": "定型文を保存",
  "eye.profile_updated": "アレルギー・病名を更新",
  "eye.exam_confirmed": "検査値を確認",
  "eye.exam_unconfirmed": "検査値の確認を取消",
  "eye.appointment_created": "予約・受付を登録",
  "eye.appointment_updated": "予約を変更",
  "eye.appointment_status_changed": "受付の状態を変更",
  "eye.patient_created": "患者を登録",
  "eye.patient_updated": "患者情報を更新",
  "eye.patient_exported": "患者データを出力",
  "eye.clinic_exported": "医院データを出力",
  "eye.document_created": "文書を作成",
  "eye.document_updated": "文書を更新",
  "eye.document_finalized": "文書を確定",
  "eye.document_viewed": "文書を閲覧",
  "eye.file_uploaded": "画像・書類を取り込み",
  "eye.file_updated": "画像・書類の情報を更新",
  "eye.file_archived": "画像・書類を保管済みに",
  "eye.file_viewed": "画像・書類を閲覧",
  "eye.paper_reviewed": "紙カルテの要約を確認",
  "eye.billing_exported": "会計連携 CSV を出力",
  "eye.billing_handed_off": "会計へ連携"
};

const DOCUMENT_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };

function shortDate(value) {
  const match = /^\d{4}-(\d{2})-(\d{2})/u.exec(String(value || ""));
  return match ? `${match[1]}/${match[2]}` : "";
}

// 操作記録の「対象・内容」。設定の対象は名前を引き、ほかは記録に残した件数などを文にする。
export function auditTargetLabel(log, masters = {}) {
  const payload = log.safePayload || {};
  const findName = (items, key, pick) => {
    const found = (items || []).find((item) => item[key] === log.targetId);
    return found ? pick(found) : `ID ${String(log.targetId || "").slice(0, 10)}`;
  };
  if (log.targetType === "drug_preset") return findName(masters.drugPresets, "presetId", (item) => item.name);
  if (log.targetType === "order_set") return findName(masters.orderSets, "setId", (item) => item.name);
  if (log.targetType === "phrase") {
    return findName(masters.phrases, "phraseId", (item) => item.label || (item.text.length > 24 ? `${item.text.slice(0, 24)}…` : item.text));
  }
  const parts = [];
  if (Number.isFinite(payload.patientCount)) parts.push(`患者 ${payload.patientCount}人`);
  const day = payload.date || (log.targetType === "billing_day" ? log.targetId : "");
  if (Number.isFinite(payload.encounterCount)) parts.push(`${day ? `${shortDate(day)}分・` : ""}${payload.encounterCount}件`);
  if (payload.from && payload.to) parts.push(`${APPOINTMENT_STATUS_LABELS[payload.from] || payload.from} → ${APPOINTMENT_STATUS_LABELS[payload.to] || payload.to}`);
  if (log.eventType?.startsWith("eye.exam_") && payload.eye) parts.push(payload.eye === "both" ? "両眼" : EYE_LABELS[payload.eye] || "");
  if (Number.isFinite(payload.version)) parts.push(`第${payload.version}版`);
  if (Number.isFinite(payload.fromVersion)) parts.push(`第${payload.fromVersion}版から`);
  if (payload.type && DOCUMENT_TYPE_LABELS[payload.type]) parts.push(DOCUMENT_TYPE_LABELS[payload.type]);
  return parts.filter(Boolean).join("・");
}

// 期間の選択肢（日本時間の日付）
export function auditRangeFor(preset, today) {
  const offsets = { today: 0, week: 6, month: 29 };
  if (!(preset in offsets)) return null;
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offsets[preset]);
  return { from: date.toISOString().slice(0, 10), to: today };
}
