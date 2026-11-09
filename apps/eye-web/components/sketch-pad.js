"use client";

import { useRef, useState } from "react";
import { EYE_LABELS } from "../lib/format";

const SIZE = 1000;
// 眼底図の慣例色: 黒=一般、赤=網膜・出血、青=剥離、緑=硝子体混濁。
const COLORS = [
  { value: "#1f2937", label: "黒" },
  { value: "#dc2626", label: "赤" },
  { value: "#2563eb", label: "青" },
  { value: "#16a34a", label: "緑" }
];
const WIDTHS = [{ value: 3, label: "細" }, { value: 8, label: "太" }];
export const SKETCH_TEMPLATE_LABELS = { anterior: "前眼部", fundus: "眼底", blank: "白紙" };

export function SketchPad({ sketch, onChange, readOnly = false }) {
  const svgRef = useRef(null);
  const [color, setColor] = useState(COLORS[0].value);
  const [width, setWidth] = useState(WIDTHS[0].value);
  const [activeStroke, setActiveStroke] = useState(null);

  function pointFromEvent(event) {
    const rect = svgRef.current.getBoundingClientRect();
    return [
      Math.round(((event.clientX - rect.left) / rect.width) * SIZE),
      Math.round(((event.clientY - rect.top) / rect.height) * SIZE)
    ];
  }

  function handlePointerDown(event) {
    if (readOnly || event.button > 0) return;
    event.preventDefault();
    svgRef.current.setPointerCapture(event.pointerId);
    setActiveStroke({ color, width, points: [pointFromEvent(event)] });
  }

  function handlePointerMove(event) {
    if (!activeStroke) return;
    const next = pointFromEvent(event);
    const last = activeStroke.points.at(-1);
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 3) return;
    setActiveStroke({ ...activeStroke, points: [...activeStroke.points, next] });
  }

  function handlePointerUp() {
    if (!activeStroke) return;
    const pairs = activeStroke.points.length === 1
      ? [...activeStroke.points, [activeStroke.points[0][0] + 1, activeStroke.points[0][1] + 1]]
      : activeStroke.points;
    setActiveStroke(null);
    // 保存形式は [x1, y1, x2, y2, ...] の平らな配列（Firestore は配列の入れ子を保存できない）。
    onChange({ ...sketch, strokes: [...sketch.strokes, { ...activeStroke, points: pairs.flat() }] });
  }

  return (
    <div className="sketch">
      {!readOnly ? (
        <div className="sketch-tools" role="toolbar" aria-label="シェーマの道具">
          {COLORS.map((option) => (
            <button
              aria-label={`${option.label}ペン`}
              aria-pressed={color === option.value}
              className="swatch"
              key={option.value}
              onClick={() => setColor(option.value)}
              style={{ "--swatch": option.value }}
              type="button"
            />
          ))}
          <span className="tool-sep" />
          {WIDTHS.map((option) => (
            <button aria-pressed={width === option.value} className="btn btn-chip" key={option.value} onClick={() => setWidth(option.value)} type="button">{option.label}</button>
          ))}
          <span className="tool-sep" />
          <button className="btn btn-chip" disabled={sketch.strokes.length === 0} onClick={() => onChange({ ...sketch, strokes: sketch.strokes.slice(0, -1) })} type="button">1つ戻す</button>
          <button className="btn btn-chip" disabled={sketch.strokes.length === 0} onClick={() => onChange({ ...sketch, strokes: [] })} type="button">消去</button>
        </div>
      ) : null}
      <svg
        aria-label={`${EYE_LABELS[sketch.eye] || ""}${SKETCH_TEMPLATE_LABELS[sketch.template]}のシェーマ`}
        className={`sketch-canvas${readOnly ? " is-readonly" : ""}`}
        onPointerCancel={handlePointerUp}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        ref={svgRef}
        role="img"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <rect fill="#ffffff" height={SIZE} width={SIZE} />
        <SketchTemplate eye={sketch.eye} template={sketch.template} />
        {[...sketch.strokes, ...(activeStroke ? [{ ...activeStroke, points: activeStroke.points.flat() }] : [])].map((stroke, index) => (
          <polyline
            fill="none"
            key={index}
            points={toPolylinePoints(stroke.points)}
            stroke={stroke.color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={stroke.width}
          />
        ))}
      </svg>
    </div>
  );
}

function toPolylinePoints(flat = []) {
  const pairs = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push(`${flat[index]},${flat[index + 1]}`);
  }
  return pairs.join(" ");
}

function SketchTemplate({ template, eye }) {
  const guide = { fill: "none", stroke: "#94a3b8", strokeWidth: 3 };
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
    // 右眼の眼底像では視神経乳頭が向かって右（鼻側）に来る。
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
  return null;
}

// 縮小図（読むだけ）。押すと描画ダイアログを開く（デジカルの主訴・所見の下に並ぶシェーマ）。
export function SketchThumb({ sketch, onOpen = null, label = "" }) {
  const title = label || `${EYE_LABELS[sketch.eye] || ""}${SKETCH_TEMPLATE_LABELS[sketch.template] || ""}`;
  const body = (
    <svg aria-hidden="true" className="sketch-thumb-svg" viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <rect fill="#ffffff" height={SIZE} width={SIZE} />
      <SketchTemplate eye={sketch.eye} template={sketch.template} />
      {(sketch.strokes || []).map((stroke, index) => (
        <polyline fill="none" key={index} points={toPolylinePoints(stroke.points)} stroke={stroke.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={stroke.width} />
      ))}
    </svg>
  );
  return (
    <figure className="sketch-thumb">
      {onOpen ? <button aria-label={`シェーマ ${title}を開く`} className="sketch-thumb-button" onClick={onOpen} type="button">{body}</button> : body}
      <figcaption>{title}{sketch.caption ? ` ・ ${sketch.caption}` : ""}</figcaption>
    </figure>
  );
}

// シェーマの追加: 下絵の格子から選ぶ（眼底・前眼部は右眼・左眼、白紙）。
export function SketchTemplateDialog({ onPick, onCancel }) {
  const choices = [["fundus", "od"], ["fundus", "os"], ["anterior", "od"], ["anterior", "os"], ["blank", "ou"]];
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="sketch-template-heading" className="dialog dialog-wide" role="dialog">
        <h2 id="sketch-template-heading">シェーマ追加</h2>
        <div className="sketch-template-grid">
          {choices.map(([template, eye]) => {
            const label = `${template === "blank" ? "" : EYE_LABELS[eye]}${SKETCH_TEMPLATE_LABELS[template]}`;
            return (
              <button aria-label={label} className="sketch-template-choice" key={`${template}-${eye}`} onClick={() => onPick({ template, eye })} type="button">
                <svg aria-hidden="true" viewBox={`0 0 ${SIZE} ${SIZE}`}>
                  <rect fill="#ffffff" height={SIZE} width={SIZE} />
                  <SketchTemplate eye={eye} template={template} />
                </svg>
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

// 描画ダイアログ。保存するまでカルテには入れない（キャンセルで元のまま）。
export function SketchEditDialog({ sketch, onSave, onCancel, onDelete = null, readOnly = false }) {
  const [draft, setDraft] = useState(sketch);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="sketch-edit-heading" className="dialog dialog-wide sketch-dialog" role="dialog">
        <h2 id="sketch-edit-heading">シェーマ {EYE_LABELS[sketch.eye] || ""}{SKETCH_TEMPLATE_LABELS[sketch.template]}</h2>
        <SketchPad onChange={setDraft} readOnly={readOnly} sketch={draft} />
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
