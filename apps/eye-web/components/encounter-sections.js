"use client";

import { useState } from "react";
import { calculateEyeDropBottles } from "@halunasu/eye-core";
import { SKETCH_TEMPLATE_LABELS, SketchPad } from "./sketch-pad";
import {
  addDays,
  EYE_LABELS,
  formatDate,
  formatRefraction,
  IOP_METHOD_LABELS,
  PRESCRIPTION_KIND_LABELS
} from "../lib/format";

const SIDES = ["od", "os"];

export function Section({ title, id, children }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="form-section">
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}

export function ExamTable({ content, previous, update, confirmations = null, onConfirm = null, canConfirm = false }) {
  const numberInput = (side, path, props = {}) => {
    const value = getIn(content.exam[side], path);
    return (
      <input
        className="input input-num"
        inputMode="decimal"
        onChange={(event) => update(["exam", side, ...path], parseNumber(event.target.value))}
        type="number"
        value={value ?? ""}
        {...props}
      />
    );
  };
  const hint = (side, path, format = (value) => value) => {
    const value = previous ? getIn(previous.exam?.[side] || {}, path) : null;
    return value === null || value === undefined || value === "" ? null : <span className="prev-hint">前回 {format(value)}</span>;
  };

  return (
    <div className="table-scroll">
      <table className="exam-table">
        <thead>
          <tr>
            <th scope="col" />
            <th className="eye-od" scope="col">右眼 (R)</th>
            <th className="eye-os" scope="col">左眼 (L)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">裸眼視力</th>
            {SIDES.map((side) => (
              <td key={side}>
                <input aria-label={`${EYE_LABELS[side]} 裸眼視力`} className="input input-va" onChange={(event) => update(["exam", side, "vaUncorrected"], event.target.value)} placeholder="例 0.3" value={content.exam[side].vaUncorrected} />
                {hint(side, ["vaUncorrected"])}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">矯正視力</th>
            {SIDES.map((side) => (
              <td key={side}>
                <input aria-label={`${EYE_LABELS[side]} 矯正視力`} className="input input-va" onChange={(event) => update(["exam", side, "vaCorrected"], event.target.value)} placeholder="例 1.2" value={content.exam[side].vaCorrected} />
                {hint(side, ["vaCorrected"])}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">矯正 S / C / Ax</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="triple">
                  {numberInput(side, ["correction", "sphere"], { "aria-label": `${EYE_LABELS[side]} 矯正 球面`, step: 0.25, placeholder: "S" })}
                  {numberInput(side, ["correction", "cylinder"], { "aria-label": `${EYE_LABELS[side]} 矯正 円柱`, step: 0.25, placeholder: "C" })}
                  {numberInput(side, ["correction", "axis"], { "aria-label": `${EYE_LABELS[side]} 矯正 軸`, step: 1, min: 0, max: 180, placeholder: "Ax" })}
                </span>
                {previous ? <span className="prev-hint">{formatRefraction(previous.exam?.[side]?.correction) ? `前回 ${formatRefraction(previous.exam[side].correction)}` : ""}</span> : null}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">他覚屈折 S / C / Ax</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="triple">
                  {numberInput(side, ["refraction", "sphere"], { "aria-label": `${EYE_LABELS[side]} 屈折 球面`, step: 0.25, placeholder: "S" })}
                  {numberInput(side, ["refraction", "cylinder"], { "aria-label": `${EYE_LABELS[side]} 屈折 円柱`, step: 0.25, placeholder: "C" })}
                  {numberInput(side, ["refraction", "axis"], { "aria-label": `${EYE_LABELS[side]} 屈折 軸`, step: 1, min: 0, max: 180, placeholder: "Ax" })}
                </span>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">矯正の種類・測定時刻</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="pair">
                  <select aria-label={`${EYE_LABELS[side]} 矯正の種類`} className="input" onChange={(event) => update(["exam", side, "vaCorrectionType"], event.target.value)} value={content.exam[side].vaCorrectionType || ""}>
                    {Object.entries(CORRECTION_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input aria-label={`${EYE_LABELS[side]} 測定時刻`} className="input input-time" onChange={(event) => update(["exam", side, "measuredAt"], event.target.value)} type="time" value={content.exam[side].measuredAt || ""} />
                  <button className="btn btn-chip" onClick={() => update(["exam", side, "measuredAt"], nowTime())} type="button">今</button>
                </span>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">眼圧 (mmHg)</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="pair">
                  {numberInput(side, ["iop"], { "aria-label": `${EYE_LABELS[side]} 眼圧`, step: 1, min: 0, max: 90 })}
                  <select aria-label={`${EYE_LABELS[side]} 眼圧の測定法`} className="input" onChange={(event) => update(["exam", side, "iopMethod"], event.target.value)} value={content.exam[side].iopMethod}>
                    <option value="">測定法</option>
                    {Object.entries(IOP_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </span>
                {hint(side, ["iop"], (value) => `${value}`)}
                {Number.isFinite(content.exam[side].iop) && content.exam[side].iop > 21 ? <span className="flag">21 mmHg を超えています</span> : null}
              </td>
            ))}
          </tr>
          {confirmations ? (
            <tr className="confirm-row">
              <th scope="row">確認</th>
              {SIDES.map((side) => {
                const confirmation = confirmations[side];
                return (
                  <td key={side}>
                    {confirmation ? (
                      <span className="confirm-ok">
                        確認済み（{confirmation.by?.displayName} {formatTime(confirmation.at)}）
                        {canConfirm ? <button className="btn btn-chip" onClick={() => onConfirm(side, false)} type="button">取消</button> : null}
                      </span>
                    ) : hasExamValues(content.exam[side]) ? (
                      canConfirm ? <button className="btn btn-primary btn-sm" onClick={() => onConfirm(side, true)} type="button">{EYE_LABELS[side]}を確認</button> : <span className="confirm-pending">未確認</span>
                    ) : <span className="muted small">未入力</span>}
                  </td>
                );
              })}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

const CORRECTION_TYPE_LABELS = { "": "矯正の種類", glasses: "眼鏡", contact: "CL", pinhole: "ピンホール", trial: "検眼レンズ" };

export function hasExamValues(values = {}) {
  return Boolean(values.vaUncorrected || values.vaCorrected || Number.isFinite(values.iop)
    || [values.correction, values.refraction].some((item) => item && Object.values(item).some((value) => value !== null && value !== undefined)));
}

function nowTime() {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

const ORDER_STATUS_LABELS = { planned: "予定", performed: "実施済", cancelled: "取消" };

// 検査・処置のオーダー。予定 → 実施（または取消）。実施者と時刻はサーバーが記録する。
export function Orders({ content, catalog, update, editable }) {
  const [code, setCode] = useState(catalog[0]?.code || "");
  const [eye, setEye] = useState("ou");
  const rows = content.orders || [];
  const setStatus = (index, status) => update(["orders", index, "status"], status);
  const add = () => {
    const item = catalog.find((entry) => entry.code === code);
    if (!item) return;
    update(["orders"], [...rows, {
      orderId: `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      code: item.code,
      name: item.name,
      kind: item.kind,
      eye: item.requiresEye ? eye : "",
      status: "planned",
      note: ""
    }]);
  };
  return (
    <div>
      {rows.length === 0 ? <p className="empty">オーダーはありません。</p> : (
        <ul className="order-list">
          {rows.map((order, index) => (
            <li className={`order-row is-${order.status}`} key={order.orderId}>
              <span className="order-name">{order.name}{order.eye ? `（${EYE_LABELS[order.eye]}）` : ""}</span>
              <span className={`tag order-status-${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span>
              {order.statusChangedBy ? <span className="muted small">{order.statusChangedBy.displayName} {formatTime(order.statusChangedAt)}</span> : null}
              {editable ? (
                <span className="order-actions">
                  {order.status !== "performed" ? <button className="btn btn-primary btn-sm" onClick={() => setStatus(index, "performed")} type="button">実施</button> : null}
                  {order.status === "planned" ? <button className="btn btn-chip" onClick={() => setStatus(index, "cancelled")} type="button">取消</button> : null}
                  {order.status !== "planned" ? <button className="btn btn-chip" onClick={() => setStatus(index, "planned")} type="button">予定に戻す</button> : null}
                  {order.status === "planned" && !order.statusChangedBy ? (
                    <button aria-label={`${order.name}を削除`} className="btn btn-chip danger-text" onClick={() => update(["orders"], rows.filter((_, rowIndex) => rowIndex !== index))} type="button">削除</button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable && catalog.length ? (
        <div className="add-row">
          <select aria-label="検査・処置" className="input grow" onChange={(event) => setCode(event.target.value)} value={code}>
            {catalog.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </select>
          <select aria-label="オーダーの眼" className="input" onChange={(event) => setEye(event.target.value)} value={eye}>
            {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={add} type="button">オーダーを追加</button>
        </div>
      ) : null}
    </div>
  );
}

// 散瞳タイマーとフラグ。散瞳から20分を過ぎたら診察可能の目安として色を変える。
export function DilationFlags({ content, update, editable, now = Date.now() }) {
  const flags = content.flags || {};
  const minutes = flags.dilationStartedAt ? Math.max(0, Math.floor((now - Date.parse(flags.dilationStartedAt)) / 60000)) : null;
  return (
    <div className="flags-row">
      {flags.dilationStartedAt ? (
        <span className={`dilation-timer${minutes >= 20 ? " is-ready" : ""}`}>
          散瞳{flags.dilationEye ? `（${EYE_LABELS[flags.dilationEye]}）` : ""} {minutes}分経過{minutes >= 20 ? " ・ 診察可能の目安" : ""}
        </span>
      ) : <span className="muted small">散瞳していません</span>}
      {editable ? (
        flags.dilationStartedAt ? (
          <button className="btn btn-chip" onClick={() => update(["flags"], { ...flags, dilated: false, dilationStartedAt: "", dilationEye: "" })} type="button">散瞳を取り消す</button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={() => update(["flags"], { ...flags, dilated: true, dilationStartedAt: new Date().toISOString(), dilationEye: "ou" })} type="button">両眼散瞳を開始</button>
            <button className="btn btn-chip" onClick={() => update(["flags"], { ...flags, dilated: true, dilationStartedAt: new Date().toISOString(), dilationEye: "od" })} type="button">右眼のみ</button>
            <button className="btn btn-chip" onClick={() => update(["flags"], { ...flags, dilated: true, dilationStartedAt: new Date().toISOString(), dilationEye: "os" })} type="button">左眼のみ</button>
          </>
        )
      ) : null}
      <label className="check-line">
        <input checked={Boolean(flags.myopiaTreatment)} disabled={!editable} onChange={(event) => update(["flags"], { ...flags, myopiaTreatment: event.target.checked })} type="checkbox" />
        近視治療中
      </label>
    </div>
  );
}

export function Sketches({ content, editable, update }) {
  const [template, setTemplate] = useState("fundus");
  const [eye, setEye] = useState("od");
  const addSketch = () => {
    update(["sketches"], [...content.sketches, { sketchId: `sk_${Date.now().toString(36)}`, template, eye, caption: "", strokes: [] }]);
  };
  return (
    <div>
      {content.sketches.length === 0 ? <p className="empty">シェーマはありません。</p> : null}
      <div className="sketch-grid">
        {content.sketches.map((sketch, index) => (
          <div className="sketch-card" key={sketch.sketchId}>
            <div className="sketch-card-head">
              <strong>{EYE_LABELS[sketch.eye]} {SKETCH_TEMPLATE_LABELS[sketch.template]}</strong>
              {editable ? (
                <button className="btn btn-chip danger-text" onClick={() => update(["sketches"], content.sketches.filter((_, itemIndex) => itemIndex !== index))} type="button">削除</button>
              ) : null}
            </div>
            <SketchPad onChange={(next) => update(["sketches", index], next)} readOnly={!editable} sketch={sketch} />
            <input aria-label="シェーマの説明" className="input" onChange={(event) => update(["sketches", index, "caption"], event.target.value)} placeholder="説明（任意）" value={sketch.caption} />
          </div>
        ))}
      </div>
      {editable && content.sketches.length < 8 ? (
        <div className="add-row">
          <select aria-label="シェーマの眼" className="input" onChange={(event) => setEye(event.target.value)} value={eye}>
            {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="シェーマの種類" className="input" onChange={(event) => setTemplate(event.target.value)} value={template}>
            {Object.entries(SKETCH_TEMPLATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={addSketch} type="button">シェーマを追加</button>
        </div>
      ) : null}
    </div>
  );
}

export function Prescriptions({ content, drugPresets, nextDays, update, editable }) {
  const rows = content.prescriptions;
  const setRow = (index, patch) => update(["prescriptions", index], { ...rows[index], ...patch });
  const presetByName = new Map(drugPresets.map((preset) => [preset.name, preset]));

  function changeName(index, name) {
    const preset = presetByName.get(name);
    setRow(index, preset
      ? { name, presetId: preset.presetId, kind: preset.kind, timesPerDay: rows[index].timesPerDay ?? preset.defaultTimesPerDay ?? null }
      : { name, presetId: "" });
  }

  return (
    <div>
      <datalist id="drug-presets">
        {drugPresets.map((preset) => <option key={preset.presetId} value={preset.name} />)}
      </datalist>
      {rows.length === 0 ? <p className="empty">処方はありません。</p> : null}
      {rows.map((row, index) => {
        const preset = row.presetId ? drugPresets.find((item) => item.presetId === row.presetId) : null;
        const days = row.days || nextDays;
        const bottles = row.kind === "eye_drop"
          ? calculateEyeDropBottles({ timesPerDay: row.timesPerDay, eye: row.eye, days, dropsPerBottle: preset?.dropsPerBottle })
          : null;
        return (
          <div className="rx-row" key={index}>
            <div className="row-line">
              <select aria-label="処方の種類" className="input" onChange={(event) => setRow(index, { kind: event.target.value })} value={row.kind}>
                {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input aria-label="薬剤名" className="input grow" list="drug-presets" onChange={(event) => changeName(index, event.target.value)} placeholder="薬剤名" value={row.name} />
              <select aria-label="処方の眼" className="input" onChange={(event) => setRow(index, { eye: event.target.value })} value={row.eye}>
                <option value="">眼</option>
                {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <label className="inline-field">
                <span>1日</span>
                <input aria-label="1日の回数" className="input input-num" min="0" onChange={(event) => setRow(index, { timesPerDay: parseNumber(event.target.value) })} type="number" value={row.timesPerDay ?? ""} />
                <span>回</span>
              </label>
              <label className="inline-field">
                <input aria-label="数量" className="input input-num" min="0" onChange={(event) => setRow(index, { quantity: parseNumber(event.target.value) })} step="any" type="number" value={row.quantity ?? ""} />
                <input aria-label="単位" className="input input-unit" onChange={(event) => setRow(index, { unit: event.target.value })} placeholder="本" value={row.unit} />
              </label>
              <label className="inline-field">
                <input aria-label="日数" className="input input-num" min="0" onChange={(event) => setRow(index, { days: parseNumber(event.target.value) })} type="number" value={row.days ?? ""} />
                <span>日分</span>
              </label>
              <button aria-label="この処方を削除" className="btn btn-chip danger-text" onClick={() => update(["prescriptions"], rows.filter((_, rowIndex) => rowIndex !== index))} type="button">削除</button>
            </div>
            {bottles ? (
              <div className="rx-hint">
                {bottles.bottles ? (
                  <>
                    <span>
                      本数の目安 <strong>{bottles.bottles}本</strong>
                      <span className="muted small">（{days}日 × 1日{row.timesPerDay}回 × {row.eye === "ou" ? 2 : 1}眼 = {bottles.dropsNeeded}滴 ÷ 1本{bottles.dropsPerBottle}滴{row.days ? "" : "・日数は次回受診まで"}）</span>
                    </span>
                    {editable && !(row.quantity === bottles.bottles && row.unit === "本") ? (
                      <button className="btn btn-chip" onClick={() => setRow(index, { quantity: bottles.bottles, unit: "本" })} type="button">{bottles.bottles}本を反映</button>
                    ) : null}
                  </>
                ) : (
                  <span className="muted small">眼・1日の回数・次回受診（または日数）を入れると本数の目安を計算します。</span>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      <button className="btn btn-ghost" onClick={() => update(["prescriptions"], [...rows, { kind: "eye_drop", name: "", presetId: "", eye: "ou", timesPerDay: null, quantity: null, unit: "", days: null, note: "" }])} type="button">処方を追加</button>
    </div>
  );
}

export function NextVisit({ content, encounterDate, suggestion, update, editable }) {
  const weeks = content.nextVisit.intervalWeeks;
  const nextDate = weeks ? addDays(encounterDate, Math.round(weeks * 7)) : "";
  return (
    <div>
      <div className="row-line">
        <label className="inline-field">
          <input aria-label="次回まで（週）" className="input input-num" min="0" onChange={(event) => update(["nextVisit", "intervalWeeks"], parseNumber(event.target.value))} type="number" value={weeks ?? ""} />
          <span>週後</span>
        </label>
        {nextDate ? <span className="muted">目安 {formatDate(nextDate)}</span> : null}
        <input aria-label="次回のメモ" className="input grow" onChange={(event) => update(["nextVisit", "note"], event.target.value)} placeholder="メモ（例: 視野検査予定）" value={content.nextVisit.note} />
      </div>
      {editable && suggestion && suggestion.intervalWeeks !== weeks && !(suggestion.basis === "default" && weeks) ? (
        <div className="suggestion">
          <span>候補 <strong>{suggestion.intervalWeeks}週後</strong> <span className="muted small">{suggestion.explanation}</span></span>
          <button className="btn btn-chip" onClick={() => update(["nextVisit", "intervalWeeks"], suggestion.intervalWeeks)} type="button">採用</button>
        </div>
      ) : null}
    </div>
  );
}

export function parseNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function getIn(object, path) {
  return path.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

export function setIn(object, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(object)) {
    const copy = [...object];
    copy[head] = setIn(object[head], rest, value);
    return copy;
  }
  return { ...object, [head]: setIn(object?.[head], rest, value) };
}
