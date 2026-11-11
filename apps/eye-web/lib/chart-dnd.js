// 過去カルテ（左の診療履歴）から今日のカルテ（中央）へのドラッグ＆ドロップの共通部品（トプコンの過去データのドラッグ＆ドロップ）。
// 描画から切り離した小道具だけを置く（node のテストから読めるよう JSX・React を使わない）。
// - 運ぶもの（payload）は { kind, encounterId, ... }。kind は COPY_KINDS のどれか。
// - ドロップ先は readCopyDrag で読み、形の違うデータは null にする（例外を出さない）。
// - 実際に今日のカルテへ入れるのは lib/chart-copy.js の applyCopy（"finding" "plan" はこのファイルの applyPartCopy）。

// components/chart-shared.js の COPY_DRAG_TYPE と同じ値（テストで一致を確かめる）。
export const COPY_DRAG_TYPE = "application/x-halunasu-copy";

// text: 自由記載 / left: 主訴・所見の列 / right: 処置・行為の列 / rx・orders: Rp 1 つ / sketch: シェーマ 1 枚
// finding: 眼別所見の 1 部位（右眼・左眼の両方）/ plan: 方針
export const COPY_KINDS = Object.freeze(["text", "left", "right", "rx", "orders", "sketch", "finding", "plan"]);

// 部位（左の診療履歴の行）→ 今日の findings のキー
export const FINDING_PART_KEYS = Object.freeze({
  anterior: ["anterior"],
  angle: ["angle", "angleNote"],
  lens: ["lens"],
  fundus: ["fundus"],
  cdRatio: ["cdRatio"],
  other: ["other"]
});
const FINDING_PART_LABELS = { anterior: "前眼部", angle: "隅角", lens: "中間透光体", fundus: "眼底", cdRatio: "C/D", other: "その他の所見" };

export function writeCopyDrag(event, payload, text = "") {
  if (!event?.dataTransfer) return;
  event.dataTransfer.setData(COPY_DRAG_TYPE, JSON.stringify(payload));
  if (text) event.dataTransfer.setData("text/plain", text);
  event.dataTransfer.effectAllowed = "copy";
}

// ドラッグ元に付ける属性。enabled が false なら何も付けない（読み取り専用の履歴）。
// 範囲を選んでドラッグしたときは、ブラウザの標準の文字のドラッグに任せる。
export function copyDragProps(enabled, payload, { text = "", title = "" } = {}) {
  if (!enabled) return {};
  return {
    draggable: true,
    "data-copy-kind": payload.kind,
    onDragStart: (event) => {
      if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return;
      event.stopPropagation();
      writeCopyDrag(event, payload, text);
    },
    ...(title ? { title } : {})
  };
}

export function hasCopyDrag(event) {
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  return typeof types.includes === "function" ? types.includes(COPY_DRAG_TYPE) : Array.from(types).includes(COPY_DRAG_TYPE);
}

// 運ばれたデータを読む。種類が分からない・形が違うものは null。
export function parseCopyPayload(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (!COPY_KINDS.includes(data.kind) || typeof data.encounterId !== "string" || !data.encounterId) return null;
    if (data.kind === "finding" && !Object.hasOwn(FINDING_PART_KEYS, data.part)) return null;
    return data;
  } catch {
    return null;
  }
}

export function readCopyDrag(event) {
  return parseCopyPayload(event?.dataTransfer?.getData(COPY_DRAG_TYPE) || "");
}

// ドロップ先に付ける属性。onActive(true/false) で「ここに落とせる」の表示を切り替える。
export function copyDropProps({ enabled, onDrop, onActive = () => {} }) {
  if (!enabled) return {};
  return {
    onDragOver: (event) => {
      if (!hasCopyDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      onActive(true);
    },
    onDragLeave: () => onActive(false),
    onDrop: (event) => {
      onActive(false);
      const data = readCopyDrag(event);
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      onDrop(data);
    }
  };
}

// 所見の 1 部位をドラッグしたときの文字（テキスト欄へ落としたとき用）
export function findingDragText(label, right, left) {
  return [right ? `${label} R ${right}` : "", left ? `${label} L ${left}` : ""].filter(Boolean).join("\n");
}

const filled = (value) => value !== undefined && value !== null && value !== "" && !(typeof value === "number" && !Number.isFinite(value));

// "finding"（部位 1 つ・両眼）と "plan"（方針）を今日のカルテへ入れる。
// 決まりは列の複写と同じで、今日が空の欄にだけ入れる（書きかけの文に足すと矛盾した文が並ぶため）。
export function applyPartCopy(current, source = {}, kind, payload = {}) {
  let next = current;
  let copied = 0;
  let skipped = 0;
  if (kind === "finding") {
    const keys = FINDING_PART_KEYS[payload.part] || [];
    for (const side of ["od", "os"]) {
      const values = source.findings?.[side] || {};
      const present = keys.filter((key) => filled(values[key]));
      if (!present.length) continue;
      const today = next.findings?.[side] || {};
      if (keys.some((key) => filled(today[key]))) {
        skipped += 1;
        continue;
      }
      const patch = Object.fromEntries(present.map((key) => [key, values[key]]));
      next = { ...next, findings: { ...(next.findings || {}), [side]: { ...today, ...patch } } };
      copied += 1;
    }
    return {
      content: next,
      label: FINDING_PART_LABELS[payload.part] || "所見",
      note: [skipped ? `入力済みの${skipped}眼はそのままにしました。` : "", !copied && !skipped ? "写す値がありません。" : ""].join("")
    };
  }
  if (kind === "plan") {
    if (!source.plan && !source.assessment) return { content: current, label: "方針", note: "写す値がありません。" };
    if ((next.plan && source.plan) || (next.assessment && source.assessment && !source.plan)) skipped += 1;
    next = { ...next, assessment: next.assessment || source.assessment || "", plan: next.plan || source.plan || "" };
    return { content: next, label: "方針", note: skipped ? "入力済みの方針はそのままにしました。" : "" };
  }
  return { content: current, label: "", note: "" };
}
