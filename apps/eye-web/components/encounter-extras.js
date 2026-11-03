"use client";

import {
  ADHERENCE_LABELS,
  ALIGNMENT_LABELS,
  CONSENT_LABELS,
  COUNSELLING_RECIPIENT_LABELS,
  COUNSELLING_TOPIC_LABELS,
  COUNSELLING_TOPICS,
  MOTILITY_LABELS,
  PUPIL_REACTION_LABELS,
  RAPD_LABELS
} from "@halunasu/eye-contracts";
import { moveToNextOnEnter, NumberField, VaField } from "./exam-inputs";
import { useMediaQuery } from "./use-media-query";
import { EYE_LABELS } from "../lib/format";

// カルテ・検査ページに足した項目（2026-11）。
// - 検査の追加: 近見視力・瞳孔（径・対光反射）・角膜曲率（眼ごと）、RAPD・眼位・眼球運動（両眼で 1 つ）。
// - 所見の追加（C/D 比・隅角）は所見の表の中、説明・同意と点眼アドヒアランスは右列（P）。
// どれも空なら保存データにキーを持たない（契約側で落とす）。「空欄を異常なし」の対象にもしない。

const SIDES = ["od", "os"];
const SOAP_TITLES = { S: "S（主観）", O: "O（客観）", A: "A（評価）", P: "P（計画）" };

// 見出しの SOAP の目印（表示だけ）。読み上げ・見出しの名前には含めない。
export function SoapMark({ letters }) {
  const list = String(letters || "").split("/").filter(Boolean);
  return (
    <span aria-hidden="true" className="soap-marks" title={`SOAP の ${list.map((letter) => SOAP_TITLES[letter] || letter).join("・")}`}>
      {list.map((letter) => <span className={`soap-mark is-${letter.toLowerCase()}`} key={letter}>{letter}</span>)}
    </span>
  );
}

export function soapTitle(title, letters) {
  return <>{title}<SoapMark letters={letters} /></>;
}

const isFilled = (value) => value !== null && value !== undefined && value !== "";

export function examExtrasHaveValues(exam = {}) {
  const sideHas = (values = {}) => isFilled(values.vaNear)
    || Object.values(values.pupil || {}).some(isFilled)
    || Object.values(values.keratometry || {}).some(isFilled);
  return SIDES.some((side) => sideHas(exam[side])) || Object.values(exam.binocular || {}).some(isFilled);
}

function Select({ label, labels, value, onChange, placeholder = "—", className = "input xe-select" }) {
  return (
    <select aria-label={label} className={className} onChange={(event) => onChange(event.target.value)} value={value || ""}>
      <option value="">{placeholder}</option>
      {Object.entries(labels).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
}

// 検査の追加項目。DOM は「右眼の全項目 → 左眼の全項目 → 両眼の項目」の順（Enter もこの順に進む）。
// 主の検査表とは別の Enter の並びにして、既存の「右眼 → 左眼」の流れを変えない。
export function ExamExtras({ content, update, editable = true, layout = "chart", dilated = false }) {
  const exam = content.exam || {};
  const touch = useMediaQuery("(pointer: coarse)", false);
  const binocular = exam.binocular || {};
  const setEye = (side, path, value) => update(["exam", side, ...path], value);
  const setBinocular = (key, value) => update(["exam", "binocular", key], value);
  const place = (r, c) => ({ "--r": r, "--c": c });
  const pupilEmpty = SIDES.every((side) => !Object.values(exam[side]?.pupil || {}).some(isFilled)) && !binocular.rapd;
  const rows = [["near", "近見視力"], ["pupil", "瞳孔"], ["kerato", "角膜曲率"]];

  return (
    <div className={`xe-wrap is-${layout}`}>
      <div className="xe-grid" data-enter-root onKeyDown={moveToNextOnEnter}>
        <span aria-hidden="true" className="xe-colhead" style={place(1, 1)} />
        {rows.map(([key, label], index) => (
          <span aria-hidden="true" className="xe-label" key={key} style={place(index + 2, 1)}>
            {label}
            {key === "kerato" ? <span className="xe-unit">D</span> : null}
          </span>
        ))}
        {SIDES.map((side, column) => {
          const values = exam[side] || {};
          return (
            <div aria-label={`${EYE_LABELS[side]}の追加検査`} className={`xe-eye xe-eye-${side}`} key={side} role="group">
              <h4 className={`xe-colhead eye-${side}`} style={place(1, column + 2)}>{side === "od" ? "右眼 R" : "左眼 L"}</h4>
              <div className="xe-cell" style={place(2, column + 2)}>
                <span className="xe-mlabel">近見視力</span>
                <VaField aria-label={`${EYE_LABELS[side]} 近見視力`} className="input input-va xe-va" onChange={(value) => setEye(side, ["vaNear"], value)} touch={touch} value={values.vaNear || ""} />
              </div>
              <div className="xe-cell" style={place(3, column + 2)}>
                <span className="xe-mlabel">瞳孔</span>
                <span className="xe-pair">
                  <NumberField aria-label={`${EYE_LABELS[side]} 瞳孔径`} className="input input-num xe-num" max={12} min={0.5} onCommit={(value) => setEye(side, ["pupil", "sizeMm"], value)} placeholder="径" value={values.pupil?.sizeMm} />
                  <span className="xe-unit">mm</span>
                </span>
                <Select label={`${EYE_LABELS[side]} 対光反射`} labels={PUPIL_REACTION_LABELS} onChange={(value) => setEye(side, ["pupil", "reaction"], value)} placeholder="対光反射" value={values.pupil?.reaction} />
              </div>
              <div className="xe-cell" style={place(4, column + 2)}>
                <span className="xe-mlabel">角膜曲率（D）</span>
                <span className="xe-kerato">
                  <NumberField aria-label={`${EYE_LABELS[side]} 角膜曲率 K1`} className="input input-num xe-num" max={70} min={30} onCommit={(value) => setEye(side, ["keratometry", "k1"], value)} placeholder="K1" value={values.keratometry?.k1} />
                  <NumberField aria-label={`${EYE_LABELS[side]} 角膜曲率 K2`} className="input input-num xe-num" max={70} min={30} onCommit={(value) => setEye(side, ["keratometry", "k2"], value)} placeholder="K2" value={values.keratometry?.k2} />
                  <NumberField aria-label={`${EYE_LABELS[side]} 角膜曲率 軸`} className="input input-num xe-num xe-axis" inputMode="numeric" integer max={180} min={0} onCommit={(value) => setEye(side, ["keratometry", "axis"], value)} placeholder="Ax" title="K1 の軸（度）" value={values.keratometry?.axis} />
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div aria-label="両眼の検査" className="xe-binocular" role="group">
        <span className="xe-bino-item">
          <span className="xe-bino-label">RAPD</span>
          <Select label="RAPD" labels={RAPD_LABELS} onChange={(value) => setBinocular("rapd", value)} value={binocular.rapd} />
        </span>
        <span className="xe-bino-item">
          <span className="xe-bino-label">眼位</span>
          <Select label="眼位" labels={ALIGNMENT_LABELS} onChange={(value) => setBinocular("alignment", value)} value={binocular.alignment} />
          <input aria-label="眼位のメモ" className="input xe-note" maxLength={200} onChange={(event) => setBinocular("alignmentNote", event.target.value)} placeholder="メモ（例: 外斜視 15Δ）" value={binocular.alignmentNote || ""} />
        </span>
        <span className="xe-bino-item">
          <span className="xe-bino-label">眼球運動</span>
          <Select label="眼球運動" labels={MOTILITY_LABELS} onChange={(value) => setBinocular("motility", value)} value={binocular.motility} />
          <input aria-label="眼球運動のメモ" className="input xe-note" maxLength={200} onChange={(event) => setBinocular("motilityNote", event.target.value)} placeholder="メモ" value={binocular.motilityNote || ""} />
        </span>
      </div>
      {editable && dilated && pupilEmpty ? <p className="xe-hint">散瞳中です。瞳孔・RAPD は散瞳前の所見を記録してください。</p> : null}
      {editable && !dilated && layout === "workbench" ? <p className="xe-hint is-quiet">瞳孔・対光反射・RAPD は散瞳の前に確認します。</p> : null}
    </div>
  );
}

// 既往・全身疾患・内服（患者ごとの記録）をカルテに 1 行で出す。変更は患者帯と同じ編集ダイアログから。
export function PatientHistoryLine({ profile, onEdit = null }) {
  const medical = String(profile?.medicalHistory || "").trim();
  const ophthalmic = String(profile?.ophthalmicHistory || "").trim();
  const oneLine = (text) => text.replace(/\s*\n+\s*/gu, "、");
  const parts = [
    medical ? ["全身・内服", oneLine(medical)] : null,
    ophthalmic ? ["眼科", oneLine(ophthalmic)] : null,
    profile?.contactLensUser ? ["CL", "装用"] : null
  ].filter(Boolean);
  const full = [medical ? `全身既往・内服: ${medical}` : "", ophthalmic ? `眼科既往: ${ophthalmic}` : "", profile?.contactLensUser ? "コンタクトレンズ装用" : ""].filter(Boolean).join("\n");
  return (
    <div className={`history-line-bar${parts.length ? "" : " is-empty"}`}>
      <span className="history-line-label">既往</span>
      {parts.length ? (
        <span className="history-line-text" title={full}>
          {parts.map(([label, text], index) => (
            <span key={label}>
              {index ? <span aria-hidden="true" className="history-line-sep"> ／ </span> : null}
              <span className="history-line-kind">{label}</span> {text}
            </span>
          ))}
        </span>
      ) : <span className="history-line-text muted">全身既往・内服・眼科既往は未記入</span>}
      {onEdit ? <button aria-label="既往・内服を編集" className="link-button" onClick={onEdit} type="button">{parts.length ? "編集" : "記入"}</button> : null}
    </div>
  );
}

// 説明・同意の記録（P）。何を・誰に・同意・メモ。
export function CounsellingFields({ content, update, editable = true }) {
  const value = content.counselling || {};
  const topics = value.topics || [];
  const set = (key, next) => update(["counselling", key], next);
  const toggleTopic = (topic) => set("topics", topics.includes(topic) ? topics.filter((item) => item !== topic) : [...topics, topic]);
  return (
    <div className="counselling">
      <div aria-label="説明した内容" className="chip-toggles" role="group">
        {COUNSELLING_TOPICS.map((topic) => (
          <button aria-pressed={topics.includes(topic)} className="btn btn-chip chip-toggle" disabled={!editable} key={topic} onClick={() => toggleTopic(topic)} type="button">
            {COUNSELLING_TOPIC_LABELS[topic]}
          </button>
        ))}
      </div>
      <div className="row-line counselling-line">
        <label className="inline-field">
          <span>説明した相手</span>
          <Select className="input" label="説明した相手" labels={COUNSELLING_RECIPIENT_LABELS} onChange={(next) => set("recipient", next)} value={value.recipient} />
        </label>
        <label className="inline-field">
          <span>同意</span>
          <Select className="input" label="同意" labels={CONSENT_LABELS} onChange={(next) => set("consent", next)} value={value.consent} />
        </label>
      </div>
      <textarea aria-label="説明・同意のメモ" className="input auto-grow" onChange={(event) => set("note", event.target.value)} placeholder="説明の要点・質問への回答など" rows={1} value={value.note || ""} />
    </div>
  );
}

// 点眼アドヒアランス（処方の下に 1 行）。点眼の処方があるか、すでに値があるときだけ出す。
export function AdherenceLine({ content, update, editable = true }) {
  const value = content.adherence || {};
  const set = (key, next) => update(["adherence", key], next);
  return (
    <div aria-label="点眼アドヒアランス" className="adherence-line" role="group">
      <span className="adherence-label">点眼</span>
      <span className="chip-toggles">
        {Object.entries(ADHERENCE_LABELS).map(([key, label]) => (
          <button aria-pressed={value.status === key} className="btn btn-chip chip-toggle" disabled={!editable} key={key} onClick={() => set("status", value.status === key ? "" : key)} type="button">{label}</button>
        ))}
      </span>
      <input aria-label="点眼アドヒアランスのメモ" className="input adherence-note" maxLength={200} onChange={(event) => set("note", event.target.value)} placeholder="メモ（例: 夜の点眼を忘れる）" value={value.note || ""} />
    </div>
  );
}

export function showAdherence(content) {
  return (content.prescriptions || []).some((item) => item.kind === "eye_drop" || item.kind === "eye_ointment")
    || Object.values(content.adherence || {}).some(isFilled);
}

// C/D 比の前回値（確定済みの前回カルテ）。測り直す値なので写さず、ヒントとして出す。
export function previousCdHint(previous, side) {
  const value = previous?.content?.findings?.[side]?.cdRatio;
  return Number.isFinite(value) ? `前回 ${value}` : "";
}
