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
  "eye.chart_template_saved": "記載の型を保存",
  "eye.staff_profile_saved": "印刷用の氏名を保存",
  "eye.set_folder_saved": "セットのフォルダを保存",
  "eye.facility_settings_saved": "医療機関情報を保存",
  "eye.billing_handoff_redownloaded": "連携した回の CSV を再出力",
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
  if (log.targetType === "staff_profile") {
    const actor = masters.actors?.[log.targetId];
    return actor ? actor.displayName || actor.loginId : `ID ${String(log.targetId || "").slice(0, 10)}`;
  }
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

// 印刷用の氏名の一覧の検索対象
export function staffSearchValues(member) {
  return [member.displayName, member.loginId, member.printName, ...(member.eyeRoles || []).map((role) => EYE_ROLE_LABELS[role] || role)];
}

export const EYE_ROLE_LABELS = { admin: "管理者", doctor: "医師", orthoptist: "視能訓練士", nurse: "看護師", medical_clerk: "医療事務", viewer: "閲覧" };

// 期間の選択肢（日本時間の日付）
export function auditRangeFor(preset, today) {
  const offsets = { today: 0, week: 6, month: 29 };
  if (!(preset in offsets)) return null;
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offsets[preset]);
  return { from: date.toISOString().slice(0, 10), to: today };
}

// ───────── 医療機関情報 ─────────

export const FACILITY_FIELDS = [
  { key: "name", label: "医療機関名", max: 100, wide: true },
  { key: "medicalInstitutionCode", label: "医療機関コード", max: 20, inputMode: "numeric", placeholder: "10桁" },
  { key: "postalCode", label: "郵便番号", max: 10, inputMode: "numeric", placeholder: "123-4567" },
  { key: "address", label: "住所", max: 200, wide: true },
  { key: "phone", label: "電話番号", max: 30, inputMode: "tel", type: "tel" },
  { key: "fax", label: "FAX番号", max: 30, inputMode: "tel", type: "tel" },
  { key: "email", label: "メールアドレス", max: 200, type: "email", wide: true },
  { key: "founder", label: "開設者", max: 100 },
  { key: "administrator", label: "管理者", max: 100 }
];

// 基本の施設情報（platform の facility）から、その項目の値を作る。表の「基本情報」と入力欄の薄い字に使う。
export function facilityBaseValue(facility, key) {
  if (!facility) return "";
  const address = facility.address || {};
  if (key === "name") return facility.legalName || facility.displayName || "";
  if (key === "postalCode") return address.postalCode || "";
  if (key === "address") return [address.prefecture || facility.prefecture || "", address.city || "", address.line1 || address.street || "", address.line2 || ""].filter(Boolean).join(" ");
  return typeof facility[key] === "string" ? facility[key] : "";
}

// ───────── 利用者 ─────────

export const MEMBER_STATUS_LABELS = { active: "有効", disabled: "無効", inactive: "無効", locked: "ロック中", invited: "招待中" };

// 役割の並び（医師 → 視能訓練士 → 看護師 → 医療事務 → 閲覧）。管理者は「設定権限」の列に出す。
const ROLE_ORDER = ["doctor", "orthoptist", "nurse", "medical_clerk", "viewer"];
export function memberRoleText(roles = []) {
  const shown = ROLE_ORDER.filter((role) => roles.includes(role));
  return shown.length ? shown.map((role) => EYE_ROLE_LABELS[role]).join("・") : roles.includes("admin") ? "管理のみ" : "—";
}

export function sortMembers(members = []) {
  const rank = (member) => {
    const index = ROLE_ORDER.findIndex((role) => (member.eyeRoles || []).includes(role));
    return index < 0 ? ROLE_ORDER.length : index;
  };
  return [...members].sort((left, right) => rank(left) - rank(right) || String(left.loginId).localeCompare(String(right.loginId)));
}

// ───────── セットのフォルダ ─────────

const bySortThenName = (left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || String(left.name || "").localeCompare(String(right.name || ""), "ja");

// フォルダの木。親が見つからない・輪になっているフォルダは最上位に置く（見えなくならないように）。
// 返す節: { folder, depth, children: [節], setCount: 直下の有効なセット数, totalCount: 下の全部 }
export function buildFolderTree(folders = [], sets = []) {
  const active = folders.filter((item) => item.active !== false);
  const ids = new Set(active.map((item) => item.folderId));
  const childrenOf = new Map();
  for (const folder of active) {
    const parent = folder.parentId && ids.has(folder.parentId) && folder.parentId !== folder.folderId ? folder.parentId : "";
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(folder);
  }
  const direct = new Map();
  for (const set of sets) {
    if (set.active === false) continue;
    const key = set.folderId && ids.has(set.folderId) ? set.folderId : "";
    direct.set(key, (direct.get(key) || 0) + 1);
  }
  const seen = new Set();
  const build = (parentId, depth) => [...(childrenOf.get(parentId) || [])].sort(bySortThenName).flatMap((folder) => {
    if (seen.has(folder.folderId)) return [];
    seen.add(folder.folderId);
    const children = build(folder.folderId, depth + 1);
    const setCount = direct.get(folder.folderId) || 0;
    return [{ folder, depth, children, setCount, totalCount: setCount + children.reduce((sum, child) => sum + child.totalCount, 0) }];
  });
  const roots = build("", 0);
  // 輪になっていて上からたどれなかったフォルダ
  for (const folder of active.filter((item) => !seen.has(item.folderId)).sort(bySortThenName)) {
    seen.add(folder.folderId);
    const setCount = direct.get(folder.folderId) || 0;
    roots.push({ folder, depth: 0, children: [], setCount, totalCount: setCount });
  }
  return { roots, unfiled: direct.get("") || 0 };
}

// 木を上から順に平らにする（select の選択肢用）。collapsed に入っている節の下は出さない。
export function flattenFolderTree(nodes = [], collapsed = new Set()) {
  return nodes.flatMap((node) => [node, ...(collapsed.has(node.folder.folderId) ? [] : flattenFolderTree(node.children, collapsed))]);
}

// そのフォルダと、その下のすべてのフォルダの ID（親に自分の子孫を選ばせないため）
export function descendantFolderIds(folders = [], folderId) {
  const result = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.folderId)) {
        result.add(folder.folderId);
        grew = true;
      }
    }
  }
  return result;
}

export function folderPathText(folders = [], folderId) {
  const byId = new Map(folders.map((item) => [item.folderId, item]));
  const names = [];
  const seen = new Set();
  for (let cursor = byId.get(folderId); cursor && !seen.has(cursor.folderId); cursor = byId.get(cursor.parentId)) {
    seen.add(cursor.folderId);
    names.unshift(cursor.name);
  }
  return names.join(" / ");
}

// フォルダの中のセットの並び（sortOrder → 名前）。folderId "" はフォルダなし（停止・見つからないフォルダを含む）。
export function setsInFolder(sets = [], folders = [], folderId) {
  const ids = new Set(folders.filter((item) => item.active !== false).map((item) => item.folderId));
  return sets
    .filter((set) => (folderId ? set.folderId === folderId : !set.folderId || !ids.has(set.folderId)))
    .sort(bySortThenName);
}

// 1 つ上・下へ動かしたあとの並びで、sortOrder を振り直す必要のあるセット（[{ set, sortOrder }]）
export function moveSet(ordered = [], setId, delta) {
  const index = ordered.findIndex((item) => item.setId === setId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ordered.length) return [];
  const next = [...ordered];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next.map((set, position) => ({ set, sortOrder: position })).filter(({ set, sortOrder }) => (set.sortOrder ?? null) !== sortOrder);
}
