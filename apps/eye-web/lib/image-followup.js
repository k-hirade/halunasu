// 画像の「経過」表示（IMAGEnet 6 の Follow-up に倣う）: 上段＝経過（今回）、下段＝基準（ベースライン）。
// 各段は 1 回の受診日の画像を種類ごとに横に並べる。描画から切り離してテストする。

// 列の並び（眼底写真 → OCT → 視野 → 前眼部 → 角膜形状 → その他）。紙カルテ・紹介状は画像の比較に出さない。
export const FOLLOWUP_KIND_ORDER = ["fundus_photo", "oct", "vf", "anterior_photo", "topography", "other"];

// 眼の絞り込み（"" はすべて）。両眼（ou）のファイルはどちらの眼でも出す。
export function matchesEye(file, eye) {
  return !eye || file.eye === eye || file.eye === "ou";
}

function newestFirst(left, right) {
  return String(right.takenOn || "").localeCompare(String(left.takenOn || "")) || String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

// 経過表示に使えるファイル（種類が列にあり、検査日があるもの）
export function followupFiles(files = [], eye = "") {
  return files.filter((file) => FOLLOWUP_KIND_ORDER.includes(file.kind) && file.takenOn && matchesEye(file, eye));
}

// 画像のある受診日（古い → 新しい）
export function followupDates(files = [], eye = "") {
  return [...new Set(followupFiles(files, eye).map((file) => file.takenOn))].sort();
}

// その日の画像（種類の列の順、同じ種類は右眼 → 左眼 → 新しい順）
export function filesOnDate(files = [], date = "", eye = "") {
  const sideRank = { od: 0, os: 1, ou: 2 };
  return followupFiles(files, eye)
    .filter((file) => file.takenOn === date)
    .sort((left, right) => FOLLOWUP_KIND_ORDER.indexOf(left.kind) - FOLLOWUP_KIND_ORDER.indexOf(right.kind)
      || (sideRank[left.eye] ?? 3) - (sideRank[right.eye] ?? 3)
      || newestFirst(left, right));
}

// 2 段で共通の列（どちらかの段にある種類）
export function followupColumns(...rows) {
  const kinds = new Set(rows.flat().map((file) => file.kind));
  return FOLLOWUP_KIND_ORDER.filter((kind) => kinds.has(kind));
}

// 既定の日付。経過＝最新、基準＝前回（rule "previous"）または初回（rule "first"）。
// 選んだ日付（picked）がまだ一覧にあればそれを使う。基準は経過より前の日を優先する。
export function resolveFollowupDates(dates = [], { followup = "", baseline = "", rule = "previous" } = {}) {
  if (!dates.length) return { followup: "", baseline: "" };
  const follow = dates.includes(followup) ? followup : dates.at(-1);
  if (dates.includes(baseline)) return { followup: follow, baseline };
  const before = dates.filter((date) => date < follow);
  if (!before.length) return { followup: follow, baseline: dates.length > 1 ? dates.find((date) => date !== follow) : "" };
  return { followup: follow, baseline: rule === "first" ? before[0] : before.at(-1) };
}

// 画像のある受診日が 2 日以上あれば、経過表示を既定にする
export function prefersFollowup(files = []) {
  return followupDates(files).length >= 2;
}
