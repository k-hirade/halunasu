"use client";

import { useEffect, useMemo, useState } from "react";
import { closeMenu, COPY_DRAG_TYPE, insertAtCursor } from "./chart-shared";
import { CounsellingFields, PatientHistoryLine, previousCdHint } from "./encounter-extras";
import { NumberField } from "./exam-inputs";
import { SketchEditDialog, SketchTemplateDialog, SketchThumb } from "./sketch-pad";
import { EYE_LABELS } from "../lib/format";

const SIDES = ["od", "os"];
const FONT_KEY = "halunasu-eye-findings-font";
const FONT_SIZES = [13, 14, 16, 18, 20];
const MAX_SKETCHES = 8;
// 「空欄を異常なし」の対象（追加の欄 その他・C/D・隅角・両眼全体は対象にしない）
const NORMAL_PARTS = ["anterior", "lens", "fundus"];
const SHAFFER_GRADES = ["0", "1", "2", "3", "4"];

// 空なら「＋」チップに畳む追加の欄（値が 1 つでもあれば開いたまま。一度開いたらこの画面のあいだは閉じない）
const OPTIONAL = [
  ["chief", "主訴"],
  ["history", "現病歴・経過"],
  ["eyes", "眼別の所見"],
  ["plan", "評価・方針"],
  ["counselling", "説明・同意"],
  ["staff-note", "スタッフメモ"]
];

function readFontSize() {
  try {
    const value = Number(window.localStorage.getItem(FONT_KEY));
    return FONT_SIZES.includes(value) ? value : 14;
  } catch {
    return 14;
  }
}

function findingsFilled(findings = {}) {
  return SIDES.some((side) => Object.entries(findings[side] || {}).some(([, value]) => value !== null && value !== undefined && value !== ""))
    || Boolean(findings.general);
}

// 中央の左の列「主訴・所見」（デジカルの 1 つの自由記載＋シェーマ）。上に検査の帯、下に追加の欄。
export function FindingsColumn({
  content, update, replaceContent, editable, previous, profile, onEditHistory, textareaRef, onDropCopy, onClearText, templates = []
}) {
  const [fontSize, setFontSize] = useState(14);
  const [opened, setOpened] = useState(() => new Set());
  const [sketchDialog, setSketchDialog] = useState(null);
  const [dropping, setDropping] = useState(false);
  useEffect(() => { setFontSize(readFontSize()); }, []);
  const changeFont = (delta) => {
    const index = Math.min(FONT_SIZES.length - 1, Math.max(0, FONT_SIZES.indexOf(fontSize) + delta));
    setFontSize(FONT_SIZES[index]);
    try { window.localStorage.setItem(FONT_KEY, String(FONT_SIZES[index])); } catch { /* 覚えられない環境では毎回 14 */ }
  };

  const filled = useMemo(() => ({
    chief: Boolean(content.chiefComplaint),
    history: Boolean(content.history),
    eyes: findingsFilled(content.findings),
    plan: Boolean(content.plan || content.assessment),
    counselling: Object.values(content.counselling || {}).some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))),
    "staff-note": Boolean(content.staffNote)
  }), [content]);
  useEffect(() => {
    const keys = Object.keys(filled).filter((key) => filled[key] && !opened.has(key));
    if (keys.length) setOpened((current) => new Set([...current, ...keys]));
  }, [filled, opened]);
  const isOpen = (key) => opened.has(key) || filled[key];
  const open = (key) => {
    setOpened((current) => new Set([...current, key]));
    requestAnimationFrame(() => document.getElementById(`field-${key}`)?.querySelector("textarea, input, select")?.focus());
  };

  function onDrop(event) {
    const raw = event.dataTransfer.getData(COPY_DRAG_TYPE);
    setDropping(false);
    if (!raw || !editable) return;
    event.preventDefault();
    try {
      onDropCopy(JSON.parse(raw), "left");
    } catch {
      // 形の違うデータは無視する
    }
  }

  const sketches = content.sketches || [];
  function saveSketch(sketch) {
    const index = sketches.findIndex((item) => item.sketchId === sketch.sketchId);
    update(["sketches"], index >= 0 ? sketches.map((item, itemIndex) => (itemIndex === index ? sketch : item)) : [...sketches, sketch]);
    setSketchDialog(null);
  }

  return (
    <section
      aria-labelledby="findings-col-heading"
      className={`chart-col chart-col-findings${dropping ? " is-drop-target" : ""}`}
      id="sec-findings"
      onDragLeave={() => setDropping(false)}
      onDragOver={(event) => {
        if (!editable || !event.dataTransfer.types.includes(COPY_DRAG_TYPE)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDrop={onDrop}
      style={{ "--findings-fs": `${fontSize}px` }}
    >
      <div className="chart-col-head">
        <h2 id="findings-col-heading">主訴・所見</h2>
        <span className="col-tools" role="toolbar" aria-label="主訴・所見の表示">
          <button aria-label="文字を小さく" className="col-tool" disabled={fontSize === FONT_SIZES[0]} onClick={() => changeFont(-1)} type="button">A−</button>
          <span className="col-tool-value" aria-label="文字の大きさ">{fontSize}</span>
          <button aria-label="文字を大きく" className="col-tool" disabled={fontSize === FONT_SIZES.at(-1)} onClick={() => changeFont(1)} type="button">A＋</button>
          {editable && templates.length ? <TemplateMenu onInsert={(text) => update(["findingsText"], insertAtCursor(textareaRef?.current, content.findingsText, text))} templates={templates} /> : null}
          {editable && content.findingsText ? <button aria-label="主訴・所見の自由記載を消す" className="col-tool" onClick={onClearText} type="button">🗑</button> : null}
        </span>
      </div>
      <div className="chart-col-body">
        <PatientHistoryLine onEdit={onEditHistory} profile={profile} />
        <textarea
          aria-label="主訴・所見"
          className="input findings-text-main"
          maxLength={10000}
          onChange={(event) => update(["findingsText"], event.target.value)}
          placeholder={editable ? "主訴・所見を書く（過去の所見を選んでドラッグすると入ります）" : ""}
          readOnly={!editable}
          ref={textareaRef}
          value={content.findingsText || ""}
        />
        <div className="sketch-strip" id="sec-sketches">
          {sketches.map((sketch) => (
            <SketchThumb key={sketch.sketchId} onOpen={() => setSketchDialog({ sketch, isNew: false })} sketch={sketch} />
          ))}
          {editable && sketches.length < MAX_SKETCHES ? (
            <button className="btn btn-chip sketch-add" onClick={() => setSketchDialog({ picking: true })} type="button">シェーマ追加</button>
          ) : null}
        </div>

        {isOpen("chief") ? (
          <label className="field" id="field-chief">
            <span>主訴</span>
            <textarea aria-label="主訴" className="input auto-grow" onChange={(event) => update(["chiefComplaint"], event.target.value)} readOnly={!editable} rows={1} value={content.chiefComplaint || ""} />
          </label>
        ) : null}
        {isOpen("history") ? (
          <label className="field" id="field-history">
            <span>現病歴・経過</span>
            <textarea aria-label="現病歴・経過" className="input auto-grow" onChange={(event) => update(["history"], event.target.value)} readOnly={!editable} rows={1} value={content.history || ""} />
          </label>
        ) : null}
        {isOpen("eyes") ? (
          <EyeFindings content={content} editable={editable} forceOpen={opened.has("eyes") && !filled.eyes} previous={previous} replaceContent={replaceContent} update={update} />
        ) : null}
        {isOpen("plan") ? (
          <div className="field-pair" id="field-plan">
            <label className="field">
              <span>評価</span>
              <textarea aria-label="評価" className="input auto-grow" onChange={(event) => update(["assessment"], event.target.value)} readOnly={!editable} rows={1} value={content.assessment || ""} />
            </label>
            <label className="field">
              <span>方針</span>
              <textarea aria-label="方針" className="input auto-grow" onChange={(event) => update(["plan"], event.target.value)} readOnly={!editable} rows={1} value={content.plan || ""} />
            </label>
          </div>
        ) : null}
        {isOpen("counselling") ? (
          <fieldset className="field plain-fieldset" disabled={!editable} id="field-counselling">
            <legend className="field-legend">説明・同意</legend>
            <CounsellingFields content={content} editable={editable} update={update} />
          </fieldset>
        ) : null}
        {isOpen("staff-note") ? (
          <label className="field" id="field-staff-note">
            <span>スタッフメモ</span>
            <textarea aria-label="スタッフメモ" className="input auto-grow" onChange={(event) => update(["staffNote"], event.target.value)} readOnly={!editable} rows={1} value={content.staffNote || ""} />
          </label>
        ) : null}
        {editable && OPTIONAL.some(([key]) => !isOpen(key)) ? (
          <div className="add-chips">
            {OPTIONAL.filter(([key]) => !isOpen(key)).map(([key, label]) => (
              <button className="add-chip" key={key} onClick={() => open(key)} type="button">＋ {label}</button>
            ))}
          </div>
        ) : null}
      </div>
      {sketchDialog?.picking ? (
        <SketchTemplateDialog
          onCancel={() => setSketchDialog(null)}
          onPick={({ template, eye }) => setSketchDialog({ sketch: { sketchId: `sk_${Date.now().toString(36)}`, template, eye, caption: "", strokes: [] }, isNew: true })}
        />
      ) : null}
      {sketchDialog?.sketch ? (
        <SketchEditDialog
          onCancel={() => setSketchDialog(null)}
          onDelete={sketchDialog.isNew ? null : () => { update(["sketches"], sketches.filter((item) => item.sketchId !== sketchDialog.sketch.sketchId)); setSketchDialog(null); }}
          onSave={saveSketch}
          pastSketches={previous?.content?.sketches || []}
          readOnly={!editable}
          sketch={sketchDialog.sketch}
        />
      ) : null}
    </section>
  );
}

// 記載の型を入れる（要望 #40。型は設定の「記載の型」で医師ごとに決める）。カーソルの位置に入れる（自由記載の外なら末尾）。
// 候補は このカルテの担当医 → 自分 → ほかの医師 の順。1 つならすぐ入れ、2 つ以上なら選ぶ。
// 押してもフォーカスを自由記載から外さない（カーソルの位置を保つ）。
const keepFocus = (event) => event.preventDefault();

function TemplateMenu({ templates, onInsert }) {
  if (templates.length === 1) {
    return <button className="col-tool" onClick={() => onInsert(templates[0].text)} onMouseDown={keepFocus} title={`${templates[0].name}の記載の型を入れます`} type="button">型を入れる</button>;
  }
  return (
    <details className="more-menu findings-template-menu">
      <summary className="col-tool" onMouseDown={keepFocus} title="記載の型を入れます">型を入れる ▾</summary>
      <div className="more-menu-list">
        {templates.map((template) => (
          <button className="btn btn-ghost" key={template.memberId} onClick={(event) => { closeMenu(event); onInsert(template.text); }} onMouseDown={keepFocus} title={template.text} type="button">{template.name}の型</button>
        ))}
      </div>
    </details>
  );
}

// 眼別の所見（従来の構造化された欄）。古いカルテ・前回から写った所見を読めるように残す。普段は畳んでおく。
function EyeFindings({ content, update, replaceContent, editable, previous, forceOpen }) {
  const [extra, setExtra] = useState(() => new Set());
  // 開閉は利用者の操作で決める（＋チップで開いたあと、値を入れても閉じない）
  const [open, setOpen] = useState(Boolean(forceOpen));
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const findings = content.findings || { od: {}, os: {} };
  const has = (key) => SIDES.some((side) => {
    const value = findings[side]?.[key];
    return value !== null && value !== undefined && value !== "";
  });
  const showAngle = extra.has("angle") || has("angle") || has("angleNote");
  const showCd = extra.has("cd") || has("cdRatio") || SIDES.some((side) => Number.isFinite(previous?.content?.findings?.[side]?.cdRatio));
  const showOther = extra.has("other") || has("other");
  const rows = [
    ["anterior", "前眼部"],
    showAngle ? ["angle", "隅角"] : null,
    ["lens", "中間透光体"],
    ["fundus", "眼底"],
    showCd ? ["cdRatio", "C/D 比"] : null,
    showOther ? ["other", "その他"] : null
  ].filter(Boolean);
  const count = SIDES.reduce((total, side) => total + Object.values(findings[side] || {}).filter((value) => value !== null && value !== undefined && value !== "").length, 0) + (findings.general ? 1 : 0);

  function fillNormal(sides) {
    let next = content;
    for (const side of sides) {
      for (const key of NORMAL_PARTS) {
        if (!next.findings[side][key]) next = { ...next, findings: { ...next.findings, [side]: { ...next.findings[side], [key]: "異常なし" } } };
      }
    }
    replaceContent(next);
  }

  return (
    <details className="eye-findings" id="field-eyes" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary>
        <span className="eye-findings-title">眼別の所見</span>
        <span className="muted small">{count ? `${count}項目` : "未記入"}（右眼・左眼の欄）</span>
      </summary>
      {editable ? (
        <div className="eye-findings-tools">
          <button className="btn btn-chip" onClick={() => fillNormal(SIDES)} title="両眼の空欄を「異常なし」にします" type="button">空欄を異常なし</button>
          {!showAngle ? <button className="add-chip" onClick={() => setExtra(new Set([...extra, "angle"]))} type="button">＋ 隅角</button> : null}
          {!showCd ? <button className="add-chip" onClick={() => setExtra(new Set([...extra, "cd"]))} type="button">＋ C/D 比</button> : null}
          {!showOther ? <button className="add-chip" onClick={() => setExtra(new Set([...extra, "other"]))} type="button">＋ その他</button> : null}
        </div>
      ) : null}
      <fieldset className="plain-fieldset" disabled={!editable}>
        <div className="findings-grid">
          {SIDES.map((side, column) => (
            <div aria-label={EYE_LABELS[side]} className="findings-eye" key={side} role="group">
              <div className="findings-head" style={{ "--c": column + 2 }}>
                <h3 className={`eye-heading eye-${side}`}>{side === "od" ? "右眼 R" : "左眼 L"}</h3>
                {editable ? <button aria-label={`${EYE_LABELS[side]}の空欄を異常なしに`} className="btn btn-chip findings-normal" onClick={() => fillNormal([side])} type="button">異常なし</button> : null}
              </div>
              {/* 列が狭いときは右眼・左眼を上下に積むので、眼ごとにも項目名を持つ（広いときは隠す） */}
              {rows.map(([key, label], row) => (
                <span aria-hidden="true" className="findings-label is-per-eye" key={`label-${key}`} style={{ "--r": row + 2 }}>{label}</span>
              ))}
              {rows.map(([key, label], row) => {
                const style = { "--c": column + 2, "--r": row + 2 };
                if (key === "cdRatio") {
                  const hint = previousCdHint(previous, side);
                  return (
                    <span className="findings-cell findings-cd" key={key} style={style}>
                      <NumberField aria-label={`${EYE_LABELS[side]} C/D 比`} className="input input-num findings-cd-input" max={1} min={0} onCommit={(value) => update(["findings", side, "cdRatio"], value)} placeholder="0.0" value={findings[side]?.cdRatio} />
                      {hint ? <span className="findings-hint" title="前回の確定カルテの値（写しません）">{hint}</span> : null}
                    </span>
                  );
                }
                if (key === "angle") {
                  return (
                    <span className="findings-cell findings-angle" key={key} style={style}>
                      <input aria-label={`${EYE_LABELS[side]} 隅角`} className="input findings-angle-grade" list="shaffer-grades" maxLength={20} onChange={(event) => update(["findings", side, "angle"], event.target.value)} placeholder="Gr" value={findings[side]?.angle || ""} />
                      <input aria-label={`${EYE_LABELS[side]} 隅角のメモ`} className="input findings-angle-note" maxLength={200} onChange={(event) => update(["findings", side, "angleNote"], event.target.value)} placeholder="メモ" value={findings[side]?.angleNote || ""} />
                    </span>
                  );
                }
                return (
                  <textarea aria-label={`${EYE_LABELS[side]} ${label}`} className="input auto-grow findings-input" key={key} onChange={(event) => update(["findings", side, key], event.target.value)} rows={1} style={style} value={findings[side]?.[key] || ""} />
                );
              })}
            </div>
          ))}
          {rows.map(([key, label], row) => (
            <span aria-hidden="true" className="findings-label" key={key} style={{ "--r": row + 2 }}>{label}</span>
          ))}
        </div>
        <datalist id="shaffer-grades">
          {SHAFFER_GRADES.map((grade) => <option key={grade} value={grade}>Shaffer {grade}</option>)}
        </datalist>
        <label className="field findings-general">
          <span>両眼・全体</span>
          <textarea aria-label="両眼・全体" className="input auto-grow" onChange={(event) => update(["findings", "general"], event.target.value)} placeholder="眼瞼・涙器・全身状態など" rows={1} value={findings.general || ""} />
        </label>
      </fieldset>
    </details>
  );
}
