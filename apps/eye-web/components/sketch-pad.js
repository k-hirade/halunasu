"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EYE_LABELS } from "../lib/format";

const SIZE = 1000;
// 描いた線の色はデータ（カルテに保存される #RRGGBB）。眼底図の慣例色: 黒=一般、赤=網膜・出血、青=剥離、緑=硝子体混濁。
const COLORS = [
  { value: "#1f2937", label: "黒" },
  { value: "#dc2626", label: "赤" },
  { value: "#2563eb", label: "青" },
  { value: "#16a34a", label: "緑" },
  { value: "#ca8a04", label: "黄" },
  { value: "#92400e", label: "茶" }
];
const WIDTHS = [{ value: 3, label: "細" }, { value: 6, label: "中" }, { value: 10, label: "太" }];
const MAX_STROKES = 600;
const MAX_TOTAL_POINTS = 60000;
const HISTORY_LIMIT = 100;

export const SKETCH_TEMPLATE_LABELS = {
  fundus: "眼底",
  anterior: "前眼部",
  cornea: "角膜",
  lens: "水晶体",
  gonio: "隅角",
  eyelid: "眼瞼",
  vfgrid: "視野",
  blank: "白紙"
};
// 下絵の一覧（左右のあるものは右眼・左眼）。シェーマ追加の格子と、描画画面の右の一覧で使う。
const TEMPLATE_CHOICES = [
  ...["fundus", "anterior", "cornea", "lens", "gonio", "eyelid", "vfgrid"].flatMap((template) => [[template, "od"], [template, "os"]]),
  ["blank", "ou"]
];
const choiceLabel = (template, eye) => `${template === "blank" ? "" : EYE_LABELS[eye] || ""}${SKETCH_TEMPLATE_LABELS[template] || ""}`;

// 道具（アイコンは自前の文字）。図形は始点・終点の 2 点で保存する。
const TOOLS = [
  { key: "pen", label: "ペン", icon: "✎" },
  { key: "line", label: "直線", icon: "╱" },
  { key: "arrow", label: "矢印", icon: "↗" },
  { key: "ellipse", label: "円・楕円", icon: "◯" },
  { key: "rect", label: "四角", icon: "▭" },
  { key: "text", label: "文字", icon: "Ａ" },
  { key: "eraser", label: "消しゴム", icon: "⌫" }
];
const FILLS = [["", "なし"], ["solid", "塗り"], ["hatch", "斜線"]];
const CLOSED = new Set(["ellipse", "rect"]);

const toolOf = (stroke) => stroke.tool || "pen";
const fontSizeOf = (stroke) => Math.round(24 + (stroke.width || 3) * 3);
const safeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, "");

function pairs(flat = []) {
  const list = [];
  for (let index = 0; index + 1 < flat.length; index += 2) list.push([flat[index], flat[index + 1]]);
  return list;
}

function toPolylinePoints(flat = []) {
  return pairs(flat).map(([x, y]) => `${x},${y}`).join(" ");
}

function hatchIdFor(prefix, color) {
  return `${prefix}-h-${String(color || "").replace("#", "")}`;
}

// 斜線の塗り: 色ごとに 1 つ pattern を作る（pattern の中の線は参照元の色を継げないため）
function HatchDefs({ prefix, strokes }) {
  const colors = [...new Set(strokes.filter((stroke) => stroke.fill === "hatch").map((stroke) => stroke.color))];
  if (!colors.length) return null;
  return (
    <defs>
      {colors.map((color) => (
        <pattern height="24" id={hatchIdFor(prefix, color)} key={color} patternTransform="rotate(45)" patternUnits="userSpaceOnUse" width="24">
          <line stroke={color} strokeWidth="5" x1="0" x2="0" y1="0" y2="24" />
        </pattern>
      ))}
    </defs>
  );
}

// 1 本の線・図形・文字を描く（カルテ・縮小図・印刷で共通）
function StrokeShape({ stroke, prefix }) {
  const tool = toolOf(stroke);
  const points = pairs(stroke.points);
  const common = { stroke: stroke.color, strokeWidth: stroke.width, strokeLinecap: "round", strokeLinejoin: "round" };
  if (tool === "text") {
    const [x, y] = points[0] || [0, 0];
    return <text dominantBaseline="middle" fill={stroke.color} fontSize={fontSizeOf(stroke)} fontWeight="600" x={x} y={y}>{stroke.text || ""}</text>;
  }
  if (tool === "pen" || points.length < 2) return <polyline fill="none" points={toPolylinePoints(stroke.points)} {...common} />;
  const [[x1, y1], [x2, y2]] = points;
  const fill = stroke.fill === "solid" ? stroke.color : stroke.fill === "hatch" ? `url(#${hatchIdFor(prefix, stroke.color)})` : "none";
  const fillOpacity = stroke.fill === "solid" ? 0.45 : 1;
  if (tool === "line") return <line x1={x1} x2={x2} y1={y1} y2={y2} {...common} />;
  if (tool === "arrow") {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const length = 18 + stroke.width * 3;
    const head = [-0.45, 0.45].map((delta) => `${Math.round(x2 - length * Math.cos(angle + delta))},${Math.round(y2 - length * Math.sin(angle + delta))}`);
    return (
      <g>
        <line x1={x1} x2={x2} y1={y1} y2={y2} {...common} />
        <polygon fill={stroke.color} points={`${x2},${y2} ${head.join(" ")}`} stroke={stroke.color} strokeLinejoin="round" strokeWidth={Math.max(1, stroke.width / 2)} />
      </g>
    );
  }
  if (tool === "ellipse") {
    return <ellipse cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} fill={fill} fillOpacity={fillOpacity} rx={Math.abs(x2 - x1) / 2} ry={Math.abs(y2 - y1) / 2} {...common} />;
  }
  return <rect fill={fill} fillOpacity={fillOpacity} height={Math.abs(y2 - y1)} width={Math.abs(x2 - x1)} x={Math.min(x1, x2)} y={Math.min(y1, y2)} {...common} />;
}

function SketchLayers({ sketch, strokes, prefix }) {
  return (
    <>
      <HatchDefs prefix={prefix} strokes={strokes} />
      <rect fill="#ffffff" height={SIZE} width={SIZE} />
      <SketchTemplate eye={sketch.eye} template={sketch.template} />
      {strokes.map((stroke, index) => <StrokeShape key={index} prefix={prefix} stroke={stroke} />)}
    </>
  );
}

// 点と線分の距離
function segmentDistance([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 消しゴム: 押した所に触れている線（上にあるもの）を 1 本返す。無ければ -1。
export function hitStroke(strokes, point, tolerance = 18) {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    const tool = toolOf(stroke);
    const list = pairs(stroke.points);
    const reach = tolerance + (stroke.width || 3) / 2;
    if (!list.length) continue;
    if (tool === "text") {
      const [x, y] = list[0];
      const size = fontSizeOf(stroke);
      const width = Math.max(1, (stroke.text || "").length) * size;
      if (point[0] >= x - tolerance && point[0] <= x + width + tolerance && Math.abs(point[1] - y) <= size / 2 + tolerance) return index;
      continue;
    }
    if (tool === "ellipse" || tool === "rect") {
      const [[x1, y1], [x2, y2] = list[0]] = list;
      const inside = point[0] >= Math.min(x1, x2) - reach && point[0] <= Math.max(x1, x2) + reach
        && point[1] >= Math.min(y1, y2) - reach && point[1] <= Math.max(y1, y2) + reach;
      if (inside) return index;
      continue;
    }
    if (list.length === 1 && Math.hypot(point[0] - list[0][0], point[1] - list[0][1]) <= reach) return index;
    for (let segment = 0; segment + 1 < list.length; segment += 1) {
      if (segmentDistance(point, list[segment], list[segment + 1]) <= reach) return index;
    }
  }
  return -1;
}

// 描画面。tool などを渡さなければ黒のペン（従来の SketchPad と同じ）。
function SketchCanvas({ sketch, readOnly = false, tool = "pen", color = COLORS[0].value, width = WIDTHS[0].value, fill = "", text = "", onAdd, onErase, onNeedText }) {
  const svgRef = useRef(null);
  const [active, setActive] = useState(null);
  const prefix = safeId(useId());
  const strokes = sketch.strokes || [];

  function pointFromEvent(event) {
    const svg = svgRef.current;
    const clamp = (value) => Math.max(0, Math.min(SIZE, Math.round(value)));
    // 画面の座標 → 図の座標（縦横比を保った余白があってもずれないよう、SVG の変換行列を使う）
    const matrix = svg.getScreenCTM?.();
    if (matrix && svg.createSVGPoint) {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return [clamp(local.x), clamp(local.y)];
    }
    const rect = svg.getBoundingClientRect();
    return [clamp(((event.clientX - rect.left) / rect.width) * SIZE), clamp(((event.clientY - rect.top) / rect.height) * SIZE)];
  }

  function handlePointerDown(event) {
    if (readOnly || event.button > 0) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (tool === "eraser") {
      const index = hitStroke(strokes, point);
      if (index >= 0) onErase?.(index);
      setActive({ eraser: true });
      svgRef.current.setPointerCapture?.(event.pointerId);
      return;
    }
    if (tool === "text") {
      const value = text.trim();
      if (!value) {
        onNeedText?.();
        return;
      }
      onAdd?.({ tool: "text", color, width, text: value, points: point });
      return;
    }
    svgRef.current.setPointerCapture?.(event.pointerId);
    setActive({ tool, color, width, ...(CLOSED.has(tool) && fill ? { fill } : {}), points: [point, point] });
  }

  function handlePointerMove(event) {
    if (!active) return;
    const next = pointFromEvent(event);
    if (active.eraser) {
      if (event.buttons === 0) return;
      const index = hitStroke(strokes, next);
      if (index >= 0) onErase?.(index);
      return;
    }
    if (active.tool === "pen") {
      const last = active.points.at(-1);
      if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 3) return;
      const points = active.points.length === 2 && active.points[0] === active.points[1] ? [active.points[0], next] : [...active.points, next];
      setActive({ ...active, points });
      return;
    }
    setActive({ ...active, points: [active.points[0], next] });
  }

  function handlePointerUp() {
    if (!active) return;
    const current = active;
    setActive(null);
    if (current.eraser) return;
    const [start, end] = current.points;
    if (current.tool === "pen") {
      // 点を押しただけでも小さな点として残す
      const list = current.points[0] === current.points[1] ? [start, [start[0] + 1, start[1] + 1]] : current.points;
      // 保存形式は [x1, y1, x2, y2, ...] の平らな配列（Firestore は配列の入れ子を保存できない）。ペンは tool を持たない（従来の形）。
      onAdd?.({ color: current.color, width: current.width, points: list.flat() });
      return;
    }
    if (Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]) < 6) return;
    onAdd?.({ ...current, points: [start, end].flat() });
  }

  const preview = active && !active.eraser ? [{ ...active, points: active.points.flat() }] : [];
  return (
    <svg
      aria-label={`${EYE_LABELS[sketch.eye] || ""}${SKETCH_TEMPLATE_LABELS[sketch.template] || ""}のシェーマ`}
      className={`sketch-canvas sketch-surface${readOnly ? " is-readonly" : ""} is-tool-${tool}`}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={svgRef}
      role="img"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
    >
      <SketchLayers prefix={prefix} sketch={sketch} strokes={[...strokes, ...preview]} />
    </svg>
  );
}

// 従来の描画面（印刷では readOnly で使う）。描くときは黒のペン。
export function SketchPad({ sketch, onChange, readOnly = false }) {
  return (
    <div className="sketch">
      <SketchCanvas onAdd={(stroke) => onChange({ ...sketch, strokes: [...(sketch.strokes || []), stroke] })} readOnly={readOnly} sketch={sketch} />
    </div>
  );
}

function SketchTemplate({ template, eye }) {
  const guide = { fill: "none", stroke: "#94a3b8", strokeWidth: 3 };
  const label = { fill: "#94a3b8", fontSize: 34, textAnchor: "middle", dominantBaseline: "middle" };
  // 右眼の図では鼻側が向かって右（眼底の視神経乳頭と同じ向き）
  const nasalRight = eye !== "os";
  if (template === "anterior") {
    return (
      <g>
        <ellipse cx="500" cy="500" rx="470" ry="300" {...guide} strokeDasharray="10 10" />
        <circle cx="500" cy="500" r="290" {...guide} />
        <circle cx="500" cy="500" r="170" {...guide} />
        <circle cx="500" cy="500" r="70" {...guide} />
      </g>
    );
  }
  if (template === "fundus") {
    const discX = eye === "os" ? 330 : 670;
    const direction = eye === "os" ? 1 : -1;
    return (
      <g>
        <circle cx="500" cy="500" r="470" {...guide} />
        <circle cx="500" cy="500" r="300" {...guide} strokeDasharray="8 10" />
        <circle cx={discX} cy="500" r="55" {...guide} />
        <circle cx="500" cy="500" r="16" {...guide} />
        <path d={`M${discX},470 C${discX + direction * 120},320 ${discX + direction * 300},300 ${discX + direction * 440},330`} {...guide} />
        <path d={`M${discX},530 C${discX + direction * 120},680 ${discX + direction * 300},700 ${discX + direction * 440},670`} {...guide} />
      </g>
    );
  }
  if (template === "cornea") {
    // 角膜（正面）: 輪部・瞳孔と時計の目盛り
    return (
      <g>
        <circle cx="500" cy="500" r="420" {...guide} />
        <circle cx="500" cy="500" r="150" {...guide} strokeDasharray="8 10" />
        {Array.from({ length: 12 }, (_, hour) => {
          const angle = (hour / 12) * Math.PI * 2;
          return <line key={hour} x1={500 + 420 * Math.sin(angle)} x2={500 + 455 * Math.sin(angle)} y1={500 - 420 * Math.cos(angle)} y2={500 - 455 * Math.cos(angle)} {...guide} />;
        })}
        <text {...label} x="500" y="22">12</text>
        <text {...label} x={nasalRight ? 960 : 40} y="500">鼻</text>
        <text {...label} x={nasalRight ? 40 : 960} y="500">耳</text>
      </g>
    );
  }
  if (template === "lens") {
    // 水晶体: 正面（上）と断面（下）
    return (
      <g>
        <circle cx="500" cy="300" r="250" {...guide} />
        <ellipse cx="500" cy="300" rx="140" ry="140" {...guide} strokeDasharray="8 10" />
        <text {...label} x="500" y="30">正面</text>
        <path d="M300,800 C300,650 700,650 700,800 C700,950 300,950 300,800 Z" {...guide} />
        <ellipse cx="500" cy="800" rx="110" ry="70" {...guide} strokeDasharray="8 10" />
        <text {...label} x="500" y="615">断面</text>
      </g>
    );
  }
  if (template === "gonio") {
    // 隅角: 4 象限の輪
    return (
      <g>
        <circle cx="500" cy="500" r="440" {...guide} />
        <circle cx="500" cy="500" r="280" {...guide} />
        <circle cx="500" cy="500" r="360" {...guide} strokeDasharray="8 10" />
        {[45, 135, 225, 315].map((degree) => {
          const angle = (degree * Math.PI) / 180;
          return <line key={degree} x1={500 + 280 * Math.cos(angle)} x2={500 + 440 * Math.cos(angle)} y1={500 + 280 * Math.sin(angle)} y2={500 + 440 * Math.sin(angle)} {...guide} />;
        })}
        <text {...label} x="500" y="500">隅角</text>
        <text {...label} x="500" y="40">上</text>
        <text {...label} x="500" y="965">下</text>
        <text {...label} x={nasalRight ? 970 : 30} y="500">鼻</text>
        <text {...label} x={nasalRight ? 30 : 970} y="500">耳</text>
      </g>
    );
  }
  if (template === "eyelid") {
    // 眼瞼: 上下の瞼・二重の線・角膜
    const inner = nasalRight ? 900 : 100;
    const outer = nasalRight ? 100 : 900;
    return (
      <g>
        <path d={`M${outer},520 C300,240 700,240 ${inner},520`} {...guide} />
        <path d={`M${outer},520 C300,760 700,760 ${inner},520`} {...guide} />
        <path d={`M${outer + (nasalRight ? 40 : -40)},450 C300,170 700,170 ${inner + (nasalRight ? -40 : 40)},450`} {...guide} strokeDasharray="8 10" />
        <circle cx="500" cy="510" r="190" {...guide} />
        <circle cx="500" cy="510" r="70" {...guide} />
        <text {...label} x={inner} y="600">鼻</text>
        <text {...label} x={outer} y="600">耳</text>
      </g>
    );
  }
  if (template === "vfgrid") {
    // 視野: 10°ごとの同心円（30°まで）と十字。盲点は耳側 15°。
    const blindX = 500 + (nasalRight ? 1 : -1) * 225;
    return (
      <g>
        {[150, 300, 450].map((radius) => <circle cx="500" cy="500" key={radius} r={radius} {...guide} />)}
        <line x1="40" x2="960" y1="500" y2="500" {...guide} />
        <line x1="500" x2="500" y1="40" y2="960" {...guide} />
        {[["10", 150], ["20", 300], ["30", 450]].map(([text, radius]) => <text {...label} fontSize="26" key={text} x={500 + radius + 18} y="480">{text}</text>)}
        <ellipse cx={blindX} cy="520" rx="28" ry="40" {...guide} strokeDasharray="6 6" />
      </g>
    );
  }
  return null;
}

// 縮小図（読むだけ）。押すと描画ダイアログを開く（デジカルの主訴・所見の下に並ぶシェーマ）。
export function SketchThumb({ sketch, onOpen = null, label = "" }) {
  const prefix = safeId(useId());
  const title = label || `${EYE_LABELS[sketch.eye] || ""}${SKETCH_TEMPLATE_LABELS[sketch.template] || ""}`;
  const body = (
    <svg aria-hidden="true" className="sketch-thumb-svg sketch-surface" viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <SketchLayers prefix={prefix} sketch={sketch} strokes={sketch.strokes || []} />
    </svg>
  );
  return (
    <figure className="sketch-thumb">
      {onOpen ? <button aria-label={`シェーマ ${title}を開く`} className="sketch-thumb-button" onClick={onOpen} type="button">{body}</button> : body}
      <figcaption>{title}{sketch.caption ? ` ・ ${sketch.caption}` : ""}</figcaption>
    </figure>
  );
}

function TemplatePreview({ template, eye }) {
  return (
    <svg aria-hidden="true" className="sketch-surface" viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <rect fill="#ffffff" height={SIZE} width={SIZE} />
      <SketchTemplate eye={eye} template={template} />
    </svg>
  );
}

// シェーマの追加: 下絵の格子から選ぶ（左右のある図は右眼・左眼、白紙）。
export function SketchTemplateDialog({ onPick, onCancel }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="sketch-template-heading" className="dialog dialog-wide" role="dialog">
        <h2 id="sketch-template-heading">シェーマ追加</h2>
        <div className="sketch-template-grid">
          {TEMPLATE_CHOICES.map(([template, eye]) => {
            const label = choiceLabel(template, eye);
            return (
              <button aria-label={label} className="sketch-template-choice" key={`${template}-${eye}`} onClick={() => onPick({ template, eye })} type="button">
                <TemplatePreview eye={eye} template={template} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
        </div>
      </div>
    </div>
  );
}

function countPoints(strokes) {
  return strokes.reduce((sum, stroke) => sum + (stroke.points?.length || 0) / 2, 0);
}

// 描画ダイアログ（トプコンの専用ツールに倣う: 左に道具、その横に色・太さ・塗り、中央に大きな図、右に下絵の一覧と前回のシェーマ）。
// 保存するまでカルテには入れない（キャンセルで元のまま）。元に戻す・やり直しはダイアログの中だけ。
export function SketchEditDialog({ sketch, onSave, onCancel, onDelete = null, readOnly = false, pastSketches = [] }) {
  const [draft, setDraft] = useState(sketch);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(COLORS[0].value);
  const [width, setWidth] = useState(WIDTHS[0].value);
  const [fill, setFill] = useState("");
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const textRef = useRef(null);
  const strokes = draft.strokes || [];

  const commit = useCallback((next) => {
    setPast((list) => [...list.slice(-(HISTORY_LIMIT - 1)), draft]);
    setFuture([]);
    setDraft(next);
  }, [draft]);

  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture((list) => [draft, ...list]);
    setDraft(past.at(-1));
    setPast(past.slice(0, -1));
  }, [draft, past]);

  const redo = useCallback(() => {
    if (!future.length) return;
    setPast((list) => [...list, draft]);
    setDraft(future[0]);
    setFuture(future.slice(1));
  }, [draft, future]);

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（文字の入力中・変換中は文字欄の標準の動きに任せる）
  useEffect(() => {
    if (readOnly) return undefined;
    const onKey = (event) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
      else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, redo, undo]);

  function addStroke(stroke) {
    if (strokes.length >= MAX_STROKES || countPoints(strokes) + stroke.points.length / 2 > MAX_TOTAL_POINTS) {
      setHint("これ以上は描けません（線の数の上限）。不要な線を消してください。");
      return;
    }
    setHint("");
    commit({ ...draft, strokes: [...strokes, stroke] });
  }

  function overlay(source) {
    const room = MAX_STROKES - strokes.length;
    const added = (source.strokes || []).slice(0, Math.max(0, room));
    if (!added.length || countPoints(strokes) + countPoints(added) > MAX_TOTAL_POINTS) {
      setHint("前回のシェーマを重ねる余裕がありません。");
      return;
    }
    setHint(added.length < (source.strokes || []).length ? "上限のため一部だけ重ねました。" : "");
    commit({ ...draft, strokes: [...strokes, ...added.map((stroke) => ({ ...stroke }))] });
  }

  const closed = CLOSED.has(tool);
  const title = `シェーマ ${EYE_LABELS[draft.eye] && draft.template !== "blank" ? EYE_LABELS[draft.eye] : ""}${SKETCH_TEMPLATE_LABELS[draft.template] || ""}`;

  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="sketch-edit-heading" className={`dialog dialog-wide sketch-dialog${readOnly ? "" : " sketch-editor-dialog"}`} role="dialog">
        <h2 id="sketch-edit-heading">{title}</h2>
        {readOnly ? (
          <SketchCanvas readOnly sketch={draft} />
        ) : (
          <div className="sketch-editor">
            <div aria-label="シェーマの道具" aria-orientation="vertical" className="sketch-toolbar" role="toolbar">
              {TOOLS.map((item) => (
                <button aria-label={item.label} aria-pressed={tool === item.key} className="sketch-tool" key={item.key} onClick={() => { setTool(item.key); setHint(""); if (item.key === "text") requestAnimationFrame(() => textRef.current?.focus()); }} title={item.label} type="button">
                  <span aria-hidden="true" className="sketch-tool-icon">{item.icon}</span>
                  <span className="sketch-tool-label">{item.label}</span>
                </button>
              ))}
              <span className="sketch-toolbar-sep" />
              <button aria-label="元に戻す" className="sketch-tool" disabled={!past.length} onClick={undo} title="元に戻す（Ctrl+Z）" type="button">
                <span aria-hidden="true" className="sketch-tool-icon">↶</span><span className="sketch-tool-label">戻す</span>
              </button>
              <button aria-label="やり直す" className="sketch-tool" disabled={!future.length} onClick={redo} title="やり直す（Ctrl+Shift+Z）" type="button">
                <span aria-hidden="true" className="sketch-tool-icon">↷</span><span className="sketch-tool-label">やり直し</span>
              </button>
              <button aria-label="すべて消す" className="sketch-tool" disabled={!strokes.length} onClick={() => commit({ ...draft, strokes: [] })} title="書き込みをすべて消す（元に戻せます）" type="button">
                <span aria-hidden="true" className="sketch-tool-icon">✕</span><span className="sketch-tool-label">全消去</span>
              </button>
            </div>
            <div className="sketch-props" aria-label="線の設定" role="group">
              <span className="sketch-props-label">色</span>
              <div className="sketch-colors" role="group" aria-label="色">
                {COLORS.map((option) => (
                  <button aria-label={`${option.label}ペン`} aria-pressed={color === option.value} className="sketch-color" key={option.value} onClick={() => setColor(option.value)} style={{ "--swatch": option.value }} title={option.label} type="button">
                    <span aria-hidden="true" className="sketch-color-chip" />
                    <span className="sketch-color-name">{option.label}</span>
                  </button>
                ))}
              </div>
              <span className="sketch-props-label">太さ</span>
              <div className="sketch-widths" role="group" aria-label="太さ">
                {WIDTHS.map((option) => (
                  <button aria-label={`太さ ${option.label}`} aria-pressed={width === option.value} className="btn btn-chip btn-sm" key={option.value} onClick={() => setWidth(option.value)} type="button">{option.label}</button>
                ))}
              </div>
              <span className="sketch-props-label">塗り</span>
              <div className="sketch-fills" role="group" aria-label="塗り">
                {FILLS.map(([value, label]) => (
                  <button aria-label={`塗り ${label}`} aria-pressed={fill === value} className="btn btn-chip btn-sm" disabled={!closed} key={value || "none"} onClick={() => setFill(value)} title={closed ? "" : "円・四角のときに使えます"} type="button">{label}</button>
                ))}
              </div>
              {tool === "text" ? (
                <label className="sketch-text-field">
                  <span className="sketch-props-label">文字</span>
                  <input aria-label="シェーマに書く文字" className="input input-compact" maxLength={100} onChange={(event) => setText(event.target.value)} placeholder="例: KP+" ref={textRef} value={text} />
                </label>
              ) : null}
            </div>
            <div className="sketch-stage">
              <SketchCanvas
                color={color}
                fill={fill}
                onAdd={addStroke}
                onErase={(index) => commit({ ...draft, strokes: strokes.filter((_, itemIndex) => itemIndex !== index) })}
                onNeedText={() => { setHint("左の「文字」の欄に書く文字を入れてから、図を押してください。"); textRef.current?.focus(); }}
                sketch={draft}
                text={text}
                tool={tool}
                width={width}
              />
              {hint ? <p className="sketch-hint" role="status">{hint}</p> : null}
            </div>
            <aside aria-label="下絵と前回のシェーマ" className="sketch-side">
              <h3 className="sketch-side-head">下絵</h3>
              <ul className="sketch-template-list">
                {TEMPLATE_CHOICES.map(([template, eye]) => {
                  const selected = draft.template === template && (template === "blank" || draft.eye === eye);
                  return (
                    <li key={`${template}-${eye}`}>
                      <button aria-label={`下絵を${choiceLabel(template, eye)}にする`} aria-pressed={selected} className="sketch-template-row" onClick={() => { if (!selected) commit({ ...draft, template, eye }); }} type="button">
                        <TemplatePreview eye={eye} template={template} />
                        <span>{choiceLabel(template, eye)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {pastSketches.length ? (
                <>
                  <h3 className="sketch-side-head">前回のシェーマ</h3>
                  <ul className="sketch-past-list">
                    {pastSketches.map((item) => (
                      <li className="sketch-past" key={item.sketchId}>
                        <SketchThumb sketch={item} />
                        <button aria-label={`前回の${EYE_LABELS[item.eye] || ""}${SKETCH_TEMPLATE_LABELS[item.template] || ""}の書き込みを重ねる`} className="btn btn-chip btn-sm" disabled={!(item.strokes || []).length} onClick={() => overlay(item)} type="button">重ねる</button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </aside>
          </div>
        )}
        {!readOnly ? (
          <input aria-label="シェーマの説明" className="input" maxLength={200} onChange={(event) => setDraft({ ...draft, caption: event.target.value })} placeholder="説明（任意）" value={draft.caption || ""} />
        ) : null}
        <div className="dialog-actions">
          {onDelete && !readOnly ? <button className="btn btn-ghost danger-text dialog-action-left" onClick={onDelete} type="button">削除</button> : null}
          <button className="btn btn-ghost" onClick={onCancel} type="button">{readOnly ? "閉じる" : "キャンセル"}</button>
          {!readOnly ? <button className="btn btn-primary" onClick={() => onSave(draft)} type="button">保存</button> : null}
        </div>
      </div>
    </div>
  );
}
