"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { setPreamble } from "../lib/admin";
import { parseLetter, PURPOSE_HEADING, setSectionText } from "../lib/letter";

// 文書の「項目ごと」の入力（デジカルの診療情報提供書の作成 p.118 と同じく、項目名と入力欄を縦に並べ、右の紙面に組み上がる）。
// 本文（1 つの文字列）の【見出し】ごとに欄を作り、欄を直すとその見出しの下だけを書き換える。保存する形式は変えない。

export function DocumentFieldsEditor({ body, onChange, skipPurpose }) {
  const letter = parseLetter(body);
  const sections = letter.sections.filter((section) => !(skipPurpose && section.heading === PURPOSE_HEADING));
  const seen = new Map();
  return (
    <div className="doc-fields">
      <FieldRow label="前文" onChange={(text) => onChange(setPreamble(body, text))} placeholder="あいさつ・紹介の文（空でもかまいません）" value={letter.preamble} />
      {sections.map((section) => {
        // 同じ見出しが2つあるときは、最初のものだけを欄にする（2つ目以降は「本文全体」で直す）
        const count = (seen.get(section.heading) || 0) + 1;
        seen.set(section.heading, count);
        if (count > 1) return null;
        return <FieldRow key={`${section.line}-${section.heading}`} label={section.heading} note={section.note} onChange={(text) => onChange(setSectionText(body, section.heading, text.replace(/【/gu, "［").replace(/】/gu, "］")))} value={section.text} />;
      })}
      {!letter.sections.length ? <p className="doc-hint">本文に【見出し】の行がありません。「本文全体」で見出しを書くか、雛形から作ると項目ごとに入力できます。</p> : null}
    </div>
  );
}

function FieldRow({ label, note, value, onChange, placeholder = "" }) {
  const ref = useRef(null);
  const [draft, setDraft] = useState(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [value, draft]);
  return (
    <label className="doc-field-row">
      <span className="doc-field-label">{label}{note ? <small className="muted">{note}</small> : null}</span>
      <textarea
        aria-label={label}
        className="input doc-field-input"
        onBlur={() => setDraft(null)}
        onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }}
        placeholder={placeholder}
        ref={ref}
        rows={2}
        value={draft ?? value}
      />
    </label>
  );
}

// 雛形の選択（施設管理の「文書雛形」）。同じ種類のものを先に並べる。
export function TemplatePicker({ templates, type, busy, onApply }) {
  const sorted = [...templates].sort((left, right) => Number(right.type === type) - Number(left.type === type) || String(left.name).localeCompare(String(right.name), "ja"));
  const [choice, setChoice] = useState("");
  if (!sorted.length) return null;
  return (
    <div className="doc-template-picker">
      <label className="field">
        <span>雛形から作る</span>
        <select aria-label="文書雛形" className="input" onChange={(event) => setChoice(event.target.value)} value={choice}>
          <option value="">雛形を選ぶ…</option>
          {sorted.map((item) => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}
        </select>
      </label>
      <button className="btn btn-ghost" disabled={!choice || busy} onClick={() => onApply(sorted.find((item) => item.templateId === choice))} type="button">{busy ? "作成中…" : "雛形を使う"}</button>
    </div>
  );
}
