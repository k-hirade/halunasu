// 受付一覧（デジカルの受付画面の表）の列・並べ替え・絞り込み。画面から切り離した純粋な関数だけを置く。
import { formatBirthDateJp, normalizeAppointmentStatus } from "@halunasu/eye-contracts";

// 列の並び（デジカルの「表示する項目」の順）。保険はレセコンで扱うので出さず、その位置に眼科の「目的」を置く。
// 進捗・散瞳・待ち時間は眼科独自の列で、最後に並べる。
// 先頭の「マーク」はトプコンの患者マーキング（車椅子・難聴など）、ステータスの後の「場所」はトプコンの場所一覧（受付・検査・暗室…）。
export const RECEPTION_COLUMNS = Object.freeze([
  { key: "marks", label: "マーク" },
  { key: "no", label: "番号" },
  { key: "time", label: "予約時間" },
  { key: "checkin", label: "受付時間" },
  { key: "status", label: "ステータス" },
  { key: "location", label: "場所" },
  { key: "number", label: "患者番号" },
  { key: "name", label: "氏名", fixed: true },
  { key: "birth", label: "生年月日" },
  { key: "age", label: "年齢" },
  { key: "purpose", label: "目的" },
  { key: "department", label: "診療科" },
  { key: "doctor", label: "医師" },
  { key: "previous", label: "前回受付日" },
  { key: "patientMemo", label: "患者メモ" },
  { key: "receptionMemo", label: "受付メモ" },
  { key: "billing", label: "会計" },
  { key: "progress", label: "進捗" },
  { key: "dilation", label: "散瞳" },
  { key: "wait", label: "待ち時間", short: "待ち" }
]);

// スマホ幅の端末で、まだ列を選んでいないときに隠しておく列（氏名・状態・待ちを 1 画面に収める）
export const NARROW_HIDDEN_COLUMNS = Object.freeze(["checkin", "location", "number", "birth", "department", "doctor", "previous", "patientMemo"]);
export const NARROW_MAX_WIDTH = 720;
// どの幅でも、まだ列を選んでいないときは隠しておく列（絞り込みの「表示する列」でいつでも出せる）。
// デジカルの受付一覧の既定の表示に無い列で、1366×768 で既定の列が横にスクロールせずに入るようにする。
// 生年月日は年齢の列で足りる。目的はデジカルでは保険の位置の列で、初診かどうかは前回受付日の「初」で分かる。
// 場所（トプコン）は行の中で変える操作があるので隠さない
export const WIDE_HIDDEN_COLUMNS = Object.freeze(["birth", "purpose"]);
// 1366px 未満（1280 のノート PC・タブレット）で、まだ列を選んでいないときに隠しておく列。
// 会計・進捗・行の操作が最初の表示で見えるよう、受付の操作に要らない列を外す（絞り込みの「表示する列」で戻せる）。
// 診療科・医師・患者メモを外した分、目的は出す
export const MEDIUM_HIDDEN_COLUMNS = Object.freeze(["birth", "department", "doctor", "patientMemo"]);
export const MEDIUM_MAX_WIDTH = 1365;

// 画面幅ごとの既定の隠す列（端末に記憶した列があればそちらを使う）
export function defaultHiddenColumns(width) {
  if (width <= NARROW_MAX_WIDTH) return [...NARROW_HIDDEN_COLUMNS];
  if (width <= MEDIUM_MAX_WIDTH) return [...MEDIUM_HIDDEN_COLUMNS];
  return [...WIDE_HIDDEN_COLUMNS];
}
export const DEFAULT_SORT = Object.freeze({ key: "no", dir: "asc" });
// 取消は既定で出さない（デジカルも取消した受付は一覧から消え、受付編集履歴で見る）
export const DEFAULT_FILTERS = Object.freeze({ hiddenStatuses: ["cancelled"], hiddenDoctors: [], hiddenDepartments: [], patientMemo: "", receptionMemo: "" });
export const COLUMNS_STORAGE_KEY = "halunasu-eye-reception-columns";
export const SORT_STORAGE_KEY = "halunasu-eye-reception-sort";
// 診療科・医師が空の受付をまとめて扱うための値
export const UNSET = "__unset__";

const STATUS_ORDER = ["booked", "checked_in", "waiting_doctor", "in_consult", "in_exam", "in_treatment", "checkout", "done", "rebill_waiting", "absent", "cancelled"];
const BILLING_ORDER = { rebill_waiting: 0, checkout: 1, done: 2 };

// 一覧で見せる状態（再計待・不在を反映）。古い no_show は不在。
export function displayStatusOf(appointment) {
  return normalizeAppointmentStatus(appointment.displayStatus || appointment.status);
}

// 受付番号の 3 桁表示（予約済など番号のない行は「-」）
export function queueLabel(appointment) {
  return appointment.queueNumber ? String(appointment.queueNumber).padStart(3, "0") : "-";
}

// 生年月日を「1954(S29)/05/03」の形で出す（デジカルと同じく西暦に和暦の略号を添える）
export function birthWithEra(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.slice(0, 10).split("-");
  const era = (formatBirthDateJp(iso) || "").match(/^[A-Z]\d+/u)?.[0] || "";
  return `${year}${era ? `(${era})` : ""}/${month}/${day}`;
}

export function kanaOf(appointment) {
  return appointment.patientSnapshot?.displayNameKana || "";
}

// 並べ替え。値のない行は昇順でも降順でも下に置く。番号は予約済（番号なし）を予約時刻の順に上へ置く（デジカルの既定）。
export function sortAppointments(rows, sort = DEFAULT_SORT, valueOf = defaultSortValue) {
  const direction = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, sort.key) }))
    .sort((left, right) => {
      if (sort.key === "no") {
        const leftBooked = !left.row.queueNumber;
        const rightBooked = !right.row.queueNumber;
        if (leftBooked !== rightBooked) return leftBooked ? -1 : 1;
        if (leftBooked) return compareValues(left.row.time || "99:99", right.row.time || "99:99") || left.index - right.index;
      }
      const leftEmpty = left.value === "" || left.value === null || left.value === undefined;
      const rightEmpty = right.value === "" || right.value === null || right.value === undefined;
      if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
      return direction * compareValues(left.value, right.value) || left.index - right.index;
    })
    .map((item) => item.row);
}

function compareValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""), "ja");
}

export function defaultSortValue(row, key) {
  const snapshot = row.patientSnapshot || {};
  switch (key) {
    case "no": return row.queueNumber ?? null;
    case "time": return row.time || "";
    case "checkin": return row.checkedInAt || "";
    case "status": return STATUS_ORDER.indexOf(displayStatusOf(row));
    case "number": return snapshot.primaryPatientNumber || "";
    case "name": return kanaOf(row) || row.patientName || "";
    case "birth": return snapshot.birthDate || "";
    // 年齢は生年月日の逆順（若いほど大きい）
    case "age": return snapshot.birthDate ? -Date.parse(snapshot.birthDate) : null;
    case "billing": return BILLING_ORDER[displayStatusOf(row)] ?? null;
    default: return row[key] ?? "";
  }
}

// 絞り込み。状態・医師・診療科は「外したもの」を持つ（新しい値は既定で出る）。メモは部分一致。
export function filterAppointments(rows, filters = DEFAULT_FILTERS, extras = {}) {
  const patientMemo = filters.patientMemo.trim();
  const receptionMemo = filters.receptionMemo.trim();
  return rows.filter((row) => {
    if (filters.hiddenStatuses.includes(displayStatusOf(row))) return false;
    if (filters.hiddenDoctors.includes(row.doctorMemberId || UNSET)) return false;
    if (filters.hiddenDepartments.includes(row.department || UNSET)) return false;
    if (receptionMemo && ![row.receptionMemo ?? row.note ?? "", ...(row.receptionLabels || [])].join("\n").includes(receptionMemo)) return false;
    if (patientMemo && !String(extras[row.patientId]?.patientMemo || "").includes(patientMemo)) return false;
    return true;
  });
}

export function isFiltered(filters = DEFAULT_FILTERS) {
  return filters.patientMemo.trim() !== ""
    || filters.receptionMemo.trim() !== ""
    || filters.hiddenDoctors.length > 0
    || filters.hiddenDepartments.length > 0
    || filters.hiddenStatuses.length !== DEFAULT_FILTERS.hiddenStatuses.length
    || filters.hiddenStatuses.some((status) => !DEFAULT_FILTERS.hiddenStatuses.includes(status));
}

// 端末ごとの記憶（表示する列・並べ替え）。読めない・書けない環境では既定に戻る。
export function readStored(key, fallback, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key, value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境では今回の表示だけ変える
  }
}

export function sanitizeHiddenColumns(value) {
  const known = new Set(RECEPTION_COLUMNS.filter((column) => !column.fixed).map((column) => column.key));
  return Array.isArray(value) ? value.filter((key) => known.has(key)) : [];
}

export function sanitizeSort(value) {
  return value && RECEPTION_COLUMNS.some((column) => column.key === value.key) && ["asc", "desc"].includes(value.dir) ? value : DEFAULT_SORT;
}
