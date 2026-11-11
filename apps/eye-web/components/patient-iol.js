"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEyeApi } from "./eye-api";
import { formatDate, formatDiopter, todayIso } from "../lib/format";
import { hasPreopValues, preopSummary } from "../lib/preop";

// IOL 管理と術前検査ビューワー（トプコン IMAGEnet eカルテの「IOL管理」「術前検査ビューワー」に倣う）。患者ページのタブから使う。
const SIDES = [["od", "右眼", "R"], ["os", "左眼", "L"]];
export const IOL_STATUS_LABELS = { planned: "予定", implanted: "挿入済み", removed: "摘出" };
const LENS_TYPE_LABELS = { "": "—", monofocal: "単焦点", toric: "乱視矯正（トーリック）", multifocal: "多焦点", edof: "焦点深度拡張", other: "その他" };
const PLACEMENT_LABELS = { "": "—", bag: "嚢内", sulcus: "毛様溝", ac: "前房", scleral: "強膜内固定", other: "その他" };
const NUMBER_FIELDS = [
  ["power", "度数", "D", "0.5"],
  ["cylinder", "乱視度数", "D", "0.25"],
  ["axis", "軸", "°", "1"],
  ["aConstant", "A定数", "", "0.1"],
  ["targetRefraction", "目標屈折", "D", "0.25"],
  ["axialLength", "眼軸長", "mm", "0.01"],
  ["acd", "前房深度", "mm", "0.01"]
];

const blankRecord = (eye) => ({
  iolId: "", eye, status: "planned", model: "", manufacturer: "", lensType: "", power: "", cylinder: "", axis: "", aConstant: "",
  targetRefraction: "", axialLength: "", acd: "", formula: "", placement: "", serial: "", surgeryDate: todayIso(), surgeon: "", note: ""
});

// 患者の IOL の記録を読む・保存する（一覧ごと置き換える。revision が違えば 409）。
export function useIolRecords(patientId) {
  const api = useEyeApi();
  const [iol, setIol] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    return api(`/v1/eye/patients/${patientId}/iol`)
      .then((payload) => setIol(payload.iol))
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId]);
  useEffect(() => { load(); }, [load]);
  const save = useCallback(async (records) => {
    const payload = await api(`/v1/eye/patients/${patientId}/iol`, { method: "PUT", body: { expectedRevision: iol?.revision || 0, records } });
    setIol(payload.iol);
    return payload.iol;
  }, [api, iol?.revision, patientId]);
  return { iol, error, load, save };
}

function numberText(value, unit = "", digits = null) {
  if (value === null || value === undefined || value === "") return "—";
  const text = digits === "diopter" ? formatDiopter(value) : String(value);
  return `${text}${unit ? ` ${unit}` : ""}`;
}

export function IolPanel({ state, canWrite }) {
  const { iol, error, load, save } = state;
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState(null);
  const records = iol?.records || [];

  async function saveRecords(next, text) {
    setMessage(null);
    try {
      await save(next);
      setMessage({ kind: "ok", text });
      return true;
    } catch (nextError) {
      setMessage({ kind: "danger", text: nextError.message, reload: nextError.status === 409 });
      return false;
    }
  }

  async function submit(record) {
    // 空の欄は "" のまま送る（サーバーで空として扱う。消した値が前の値に戻らないように）
    const next = record.iolId ? records.map((item) => (item.iolId === record.iolId ? record : item)) : [...records, record];
    if (await saveRecords(next.map(stripMeta), "IOL の記録を保存しました。")) setEditing(null);
  }

  async function remove(record) {
    if (!window.confirm(`${record.model} の記録を削除しますか？`)) return;
    await saveRecords(records.filter((item) => item.iolId !== record.iolId).map(stripMeta), "IOL の記録を削除しました。");
  }

  if (error && !iol) return <p className="alert alert-danger" role="alert">{error}</p>;
  if (!iol) return <p className="loading">読み込み中…</p>;
  return (
    <div className="iol-panel">
      <div className="iol-head">
        <h2>IOL 管理</h2>
        <span className="muted small">眼内レンズの予定・挿入・摘出の記録です。度数の計算はしません。</span>
      </div>
      {message ? (
        <p className={`alert ${message.kind === "ok" ? "alert-info" : "alert-danger"}`} role="status">
          {message.text}
          {message.reload ? <> <button className="btn btn-chip btn-sm" onClick={() => { load(); setMessage(null); }} type="button">最新を読み込む</button></> : null}
        </p>
      ) : null}
      <div className="iol-eyes">
        {SIDES.map(([side, label, mark]) => {
          const rows = records.filter((item) => item.eye === side);
          return (
            <section aria-label={`${label}の IOL`} className="iol-eye" key={side}>
              <div className="iol-eye-head">
                <h3><span className={`eye-mark eye-${side}`}>{mark}</span>{label}</h3>
                {canWrite ? <button className="btn btn-ghost btn-sm" onClick={() => setEditing(blankRecord(side))} type="button">＋ {label}に追加</button> : null}
              </div>
              {rows.length === 0 ? <p className="empty">記録はありません。</p> : (
                <div className="iol-table-wrap" role="region" aria-label={`${label}の IOL の一覧`} tabIndex={0}>
                  <table className="iol-table">
                    <thead>
                      <tr>
                        <th scope="col">状態</th><th scope="col">手術日</th><th scope="col">レンズ</th><th scope="col">度数</th>
                        <th scope="col">A定数</th><th scope="col">目標</th><th scope="col">眼軸長</th><th scope="col">挿入位置</th>
                        {canWrite ? <th aria-label="操作" scope="col" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((item) => (
                        <tr className={`is-${item.status}`} key={item.iolId}>
                          <td><span className={`tag iol-status is-${item.status}`}>{IOL_STATUS_LABELS[item.status]}</span></td>
                          <td className="mono">{item.surgeryDate ? formatDate(item.surgeryDate) : "—"}</td>
                          <td>
                            <strong>{item.model}</strong>
                            <span className="muted small iol-sub">{[item.manufacturer, item.lensType ? LENS_TYPE_LABELS[item.lensType] : "", item.serial ? `ロット ${item.serial}` : ""].filter(Boolean).join(" ・ ")}</span>
                          </td>
                          <td className="mono">{numberText(item.power, "D", "diopter")}{item.cylinder ? <span className="iol-sub">C {item.cylinder} / {item.axis ?? "—"}°</span> : null}</td>
                          <td className="mono">{numberText(item.aConstant)}</td>
                          <td className="mono">{numberText(item.targetRefraction, "D", "diopter")}</td>
                          <td className="mono">{numberText(item.axialLength, "mm")}</td>
                          <td>{PLACEMENT_LABELS[item.placement || ""]}{item.surgeon ? <span className="muted small iol-sub">{item.surgeon}</span> : null}</td>
                          {canWrite ? (
                            <td className="iol-actions">
                              <button aria-label={`${item.model} を編集`} className="btn btn-chip btn-sm" onClick={() => setEditing(formRecord(item))} type="button">編集</button>
                              <button aria-label={`${item.model} を削除`} className="btn btn-chip btn-sm danger-text" onClick={() => remove(item)} type="button">削除</button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rows.some((item) => item.note) ? (
                <ul className="iol-notes">{rows.filter((item) => item.note).map((item) => <li key={item.iolId}><strong>{item.model}</strong> {item.note}</li>)}</ul>
              ) : null}
            </section>
          );
        })}
      </div>
      {editing ? createPortal(<IolDialog onCancel={() => setEditing(null)} onSubmit={submit} record={editing} />, document.body) : null}
    </div>
  );
}

function stripMeta({ createdAt, updatedAt, ...rest }) {
  return rest;
}

function formRecord(item) {
  const record = blankRecord(item.eye);
  for (const key of Object.keys(record)) record[key] = item[key] ?? "";
  return record;
}

function IolDialog({ record, onSubmit, onCancel }) {
  const [draft, setDraft] = useState(record);
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !event.isComposing) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    const numbers = Object.fromEntries(NUMBER_FIELDS.map(([key]) => [key, draft[key] === "" ? "" : Number(draft[key])]));
    await onSubmit({ ...draft, ...numbers });
    setBusy(false);
  }
  const eyeLabel = SIDES.find(([side]) => side === draft.eye)?.[1] || "";
  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="iol-dialog-heading" className="dialog dialog-wide iol-dialog" onSubmit={submit} role="dialog">
        <h2 id="iol-dialog-heading">IOL の記録（{eyeLabel}）</h2>
        <div className="iol-form">
          <label className="field"><span>眼</span>
            <select className="input" onChange={set("eye")} value={draft.eye}>{SIDES.map(([side, label]) => <option key={side} value={side}>{label}</option>)}</select>
          </label>
          <label className="field"><span>状態</span>
            <select className="input" onChange={set("status")} value={draft.status}>{Object.entries(IOL_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </label>
          <label className="field"><span>手術日</span><input className="input" onChange={set("surgeryDate")} type="date" value={draft.surgeryDate} /></label>
          <label className="field is-wide"><span>レンズ（型番）</span><input className="input" maxLength={100} onChange={set("model")} required value={draft.model} /></label>
          <label className="field"><span>メーカー</span><input className="input" maxLength={100} onChange={set("manufacturer")} value={draft.manufacturer} /></label>
          <label className="field"><span>種類</span>
            <select className="input" onChange={set("lensType")} value={draft.lensType}>{Object.entries(LENS_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </label>
          {NUMBER_FIELDS.map(([key, label, unit, step]) => (
            <label className="field" key={key}>
              <span>{label}{unit ? `（${unit}）` : ""}</span>
              <input className="input mono" inputMode="decimal" onChange={set(key)} step={step} type="number" value={draft[key]} />
            </label>
          ))}
          <label className="field"><span>計算式</span><input className="input" maxLength={40} onChange={set("formula")} placeholder="例: SRK/T" value={draft.formula} /></label>
          <label className="field"><span>挿入位置</span>
            <select className="input" onChange={set("placement")} value={draft.placement}>{Object.entries(PLACEMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </label>
          <label className="field"><span>ロット・シリアル</span><input className="input" maxLength={60} onChange={set("serial")} value={draft.serial} /></label>
          <label className="field"><span>術者</span><input className="input" maxLength={100} onChange={set("surgeon")} value={draft.surgeon} /></label>
          <label className="field is-wide"><span>メモ</span><textarea className="input" maxLength={500} onChange={set("note")} rows={2} value={draft.note} /></label>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !draft.model.trim()} type="submit">{busy ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}

// 術前検査ビューワー: 眼ごとに 視力・屈折・角膜曲率・眼圧 と、IOL の計算に入れる値（眼軸長・前房深度・A定数・目標屈折）を 1 画面に並べる。
export function PreopViewer({ patientId, encounters, iolState, files = [] }) {
  const summary = preopSummary({ encounters, iolRecords: iolState.iol?.records || [] });
  const related = files.filter((item) => ["topography", "anterior_photo", "oct"].includes(item.kind));
  if (!iolState.iol && !iolState.error) return <p className="loading">読み込み中…</p>;
  return (
    <div className="preop">
      <div className="iol-head">
        <h2>術前検査</h2>
        <span className="muted small">最新の検査値（本日 → 前回の確定カルテ）と IOL の記録を眼ごとに並べます。</span>
      </div>
      {!hasPreopValues(summary) ? <p className="empty">術前の検査値・IOL の記録はまだありません。検査入力（角膜曲率など）か IOL 管理で入れると、ここに並びます。</p> : null}
      <div className="preop-eyes">
        {SIDES.map(([side, label, mark]) => {
          const eye = summary[side];
          const kerato = eye.kerato?.value;
          const iol = eye.iol;
          return (
            <section aria-label={`${label}の術前検査`} className="preop-eye" key={side}>
              <h3><span className={`eye-mark eye-${side}`}>{mark}</span>{label}</h3>
              <dl className="preop-dl">
                <div className="preop-band"><dt>視力</dt><dd>{eye.va ? <>{eye.va.value.uncorrected || "—"}（{eye.va.value.corrected || "—"}）<When date={eye.va.date} /></> : "—"}</dd></div>
                <div><dt>屈折</dt><dd className="mono">{eye.refraction ? <>{["S", formatDiopter(eye.refraction.value.sphere)].join("")} {Number.isFinite(eye.refraction.value.cylinder) ? `C${formatDiopter(eye.refraction.value.cylinder)}` : ""} {Number.isFinite(eye.refraction.value.axis) ? `A${eye.refraction.value.axis}` : ""}<When date={eye.refraction.date} /></> : "—"}</dd></div>
                <div className="preop-band"><dt>角膜曲率</dt><dd className="mono">{kerato ? (
                  <>
                    K1 {kerato.k1 ?? "—"}D{kerato.r1 ? `（${kerato.r1}mm）` : ""} ・ K2 {kerato.k2 ?? "—"}D{kerato.r2 ? `（${kerato.r2}mm）` : ""} ・ 軸 {kerato.axis ?? "—"}°
                    <span className="preop-sub">平均K {kerato.average ?? "—"}D ・ 角膜乱視 {kerato.cylinder ?? "—"}D</span>
                    <When date={eye.kerato.date} />
                  </>
                ) : "—"}</dd></div>
                <div><dt>眼圧</dt><dd className="mono">{eye.iop ? <>{eye.iop.value} mmHg<When date={eye.iop.date} /></> : "—"}</dd></div>
                <div className="preop-band"><dt>眼軸長</dt><dd className="mono">{numberText(iol?.axialLength, "mm")}</dd></div>
                <div><dt>前房深度</dt><dd className="mono">{numberText(iol?.acd, "mm")}</dd></div>
                <div className="preop-band"><dt>IOL</dt><dd>{iol ? <><span className={`tag iol-status is-${iol.status}`}>{IOL_STATUS_LABELS[iol.status]}</span> <strong>{iol.model}</strong> <span className="mono">{numberText(iol.power, "D", "diopter")}</span></> : "—"}</dd></div>
                <div><dt>A定数・目標</dt><dd className="mono">{numberText(iol?.aConstant)} ・ 目標 {numberText(iol?.targetRefraction, "D", "diopter")}{iol?.formula ? ` ・ ${iol.formula}` : ""}</dd></div>
              </dl>
            </section>
          );
        })}
      </div>
      {related.length ? (
        <p className="muted small preop-files">
          関連する画像 {related.length}件（角膜形状・前眼部・OCT）
          <Link className="preop-files-link" href={`/patients/${patientId}/images`}>画像の比較で見る ›</Link>
        </p>
      ) : null}
    </div>
  );
}

function When({ date }) {
  if (!date) return null;
  return <span className="preop-when">{date === todayIso() ? "本日" : formatDate(date)}</span>;
}
