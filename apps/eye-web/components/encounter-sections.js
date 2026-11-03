"use client";

import { useEffect, useRef, useState } from "react";
import { calculateEyeDropBottles, evaluateOpticalPrescription } from "@halunasu/eye-core";
import { AxisField, DiopterField, moveToNextOnEnter, NumberField, VaDatalist, VaField } from "./exam-inputs";
import { SKETCH_TEMPLATE_LABELS, SketchPad } from "./sketch-pad";
import { useMediaQuery } from "./use-media-query";
import {
  addDays,
  COMMON_USAGES,
  EYE_LABELS,
  EYE_SHORT,
  formatDiopter,
  formatRefraction,
  formatShortDate,
  IOP_METHOD_LABELS,
  PRESCRIPTION_KIND_LABELS
} from "../lib/format";

const SIDES = ["od", "os"];
const IOP_ALERT = 21;

export function Section({ title, id, children, actions = null, className = "" }) {
  return (
    <section aria-labelledby={`${id}-heading`} className={`form-section${className ? ` ${className}` : ""}`} id={`sec-${id}`}>
      <div className="form-section-head">
        <h2 id={`${id}-heading`}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const LAST_IOP_METHOD_KEY = "halunasu-eye-last-iop-method";
const CORRECTION_TYPE_LABELS = { "": "種類", glasses: "眼鏡", contact: "CL", pinhole: "ピンホール", trial: "検眼レンズ" };
const REFRACTION_KEYS = [["sphere", "球面", "S"], ["cylinder", "円柱", "C"], ["axis", "軸", "Ax"]];

const isBlank = (value) => value === null || value === undefined || value === "";

// 検査値。layout="chart" はカルテ用（1 眼 1 行・前回は各眼の下に 1 行・他覚屈折などは「詳細」）、
// layout="workbench" は検査ページ用（検査の順に 4 行・右端に前回列・タッチ入力）。
// どちらも DOM の順（Tab・Enter）は「右眼の全項目 → 左眼の全項目」のまま、表示の位置だけをグリッドで決める。
export function ExamTable({
  layout = "chart", content, previous, previousDate = "", update, confirmations = null, onConfirm = null,
  canConfirm = false, editable = true
}) {
  const exam = content.exam;
  const touch = useMediaQuery("(pointer: coarse)", false);
  const [busy, setBusy] = useState(false);
  const [lastCopy, setLastCopy] = useState(null);
  const prevExam = previous?.exam || null;
  const prevOf = (side, path) => (prevExam ? getIn(prevExam[side] || {}, path) : undefined);
  const otherSide = (side) => (side === "od" ? "os" : "od");
  const workbench = layout === "workbench";
  const skip = workbench ? {} : { "data-enter-skip": true };

  useEffect(() => {
    if (!lastCopy) return undefined;
    const handle = setTimeout(() => setLastCopy(null), 8000);
    return () => clearTimeout(handle);
  }, [lastCopy]);

  // 測定法・矯正の種類は、反対眼が未選択なら同じものを入れる（両眼同じ方法で測ることがほとんどのため）。
  const setShared = (side, key, value) => {
    update(["exam", side, key], value);
    if (value && !exam[otherSide(side)][key]) update(["exam", otherSide(side), key], value);
    if (key === "iopMethod" && value) rememberIopMethod(value);
  };
  const setIop = (side, value) => {
    update(["exam", side, "iop"], value);
    const last = lastIopMethod();
    if (value !== null && !exam[side].iopMethod && last) update(["exam", side, "iopMethod"], last);
  };

  // 前回値・反対眼・他覚屈折の値を、空欄にだけ写す（入力済みの欄は上書きしない）。元に戻せる。
  function fill(label, entries) {
    const applied = entries.filter(([side, path, value]) => !isBlank(value) && isBlank(getIn(exam[side], path)));
    for (const [side, path, value] of applied) update(["exam", side, ...path], value);
    setLastCopy({ label, applied });
  }
  function undoCopy() {
    for (const [side, path, value] of lastCopy?.applied || []) {
      if (getIn(exam[side], path) === value) update(["exam", side, ...path], typeof value === "string" ? "" : null);
    }
    setLastCopy(null);
  }
  const refractionEntries = (side, group, source) => REFRACTION_KEYS.map(([key]) => [side, [group, key], source?.[key] ?? null]);

  const diopter = (side, group, key, name, short) => (
    key === "axis" ? (
      <AxisField
        {...skip}
        aria-label={`${EYE_LABELS[side]} ${group === "correction" ? "矯正" : "屈折"} ${name}`}
        className={`input input-num xt-axis${hasCylinder(exam[side][group]) ? "" : " is-dim"}`}
        onCommit={(value) => update(["exam", side, group, key], value)}
        placeholder={short}
        previous={prevOf(side, [group, key])}
        touch={touch}
        value={exam[side][group]?.[key]}
      />
    ) : (
      <DiopterField
        {...skip}
        aria-label={`${EYE_LABELS[side]} ${group === "correction" ? "矯正" : "屈折"} ${name}`}
        className="input input-num xt-diopter"
        limit={key === "cylinder" ? 20 : 40}
        onCommit={(value) => update(["exam", side, group, key], value)}
        placeholder={short}
        previous={prevOf(side, [group, key])}
        touch={touch}
        value={exam[side][group]?.[key]}
      />
    )
  );
  const triple = (side, group) => (
    <span className="xt-triple">
      {REFRACTION_KEYS.map(([key, name, short]) => <span className="xt-slot" key={key}>{diopter(side, group, key, name, short)}</span>)}
    </span>
  );
  const va = (side, key, label) => (
    <VaField
      aria-label={`${EYE_LABELS[side]} ${label}`}
      className="input input-va xt-va"
      onChange={(value) => update(["exam", side, key], value)}
      previous={prevOf(side, [key]) || ""}
      touch={touch}
      value={exam[side][key]}
    />
  );
  const iopHigh = (side) => Number.isFinite(exam[side].iop) && exam[side].iop > IOP_ALERT;
  const iop = (side) => (
    <NumberField
      aria-label={`${EYE_LABELS[side]} 眼圧`}
      className={`input input-num input-iop${iopHigh(side) ? " is-high" : ""}`}
      max={90}
      min={0}
      onCommit={(value) => setIop(side, value)}
      title={iopHigh(side) ? `${IOP_ALERT} mmHg 超` : undefined}
      value={exam[side].iop}
    />
  );
  const method = (side) => (
    <select aria-label={`${EYE_LABELS[side]} 眼圧の測定法`} className="input xt-select" data-enter-skip onChange={(event) => setShared(side, "iopMethod", event.target.value)} value={exam[side].iopMethod || ""}>
      <option value="">測定法</option>
      {Object.entries(IOP_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
  const correctionType = (side) => (
    <select aria-label={`${EYE_LABELS[side]} 矯正の種類`} className="input xt-select" data-enter-skip onChange={(event) => setShared(side, "vaCorrectionType", event.target.value)} value={exam[side].vaCorrectionType || ""}>
      {Object.entries(CORRECTION_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
  const time = (side) => (
    <span className="xt-time">
      <input aria-label={`${EYE_LABELS[side]} 測定時刻`} className="input input-time" data-enter-skip onChange={(event) => update(["exam", side, "measuredAt"], event.target.value)} type="time" value={exam[side].measuredAt || ""} />
      {editable ? <button aria-label={`${EYE_LABELS[side]} 測定時刻を今に`} className="btn btn-chip" onClick={() => update(["exam", side, "measuredAt"], nowTime())} type="button">今</button> : null}
    </span>
  );

  if (workbench) {
    const rows = [
      {
        key: "refraction",
        label: "他覚屈折",
        cell: (side) => (
          <>
            {triple(side, "refraction")}
            {editable && hasRefraction(exam[side].refraction) ? (
              <button
                aria-label={`${EYE_LABELS[side]} 他覚屈折を矯正レンズへ写す`}
                className="btn btn-chip xt-mini"
                onClick={() => fill("他覚屈折を矯正レンズへ", refractionEntries(side, "correction", exam[side].refraction))}
                title="矯正レンズの空欄にだけ写します"
                type="button"
              >
                →矯正
              </button>
            ) : null}
          </>
        ),
        previous: (side) => formatLens(prevOf(side, ["refraction"])),
        copy: (side) => refractionEntries(side, "refraction", prevOf(side, ["refraction"]))
      },
      {
        key: "vaUncorrected",
        label: "裸眼視力",
        cell: (side) => va(side, "vaUncorrected", "裸眼視力"),
        previous: (side) => prevOf(side, ["vaUncorrected"]) || "",
        copy: (side) => [[side, ["vaUncorrected"], prevOf(side, ["vaUncorrected"]) || ""]]
      },
      {
        key: "vaCorrected",
        label: "矯正視力",
        cell: (side) => (
          <>
            {va(side, "vaCorrected", "矯正視力")}
            <span className="xt-lens-group" title="矯正レンズ S / C / Ax">{triple(side, "correction")}</span>
            {correctionType(side)}
          </>
        ),
        previous: (side) => {
          const value = prevOf(side, ["vaCorrected"]) || "";
          const lens = formatLens(prevOf(side, ["correction"]));
          return value || lens ? `${value || "—"}${lens ? `(${lens})` : ""}` : "";
        },
        copy: (side) => [
          [side, ["vaCorrected"], prevOf(side, ["vaCorrected"]) || ""],
          ...refractionEntries(side, "correction", prevOf(side, ["correction"])),
          [side, ["vaCorrectionType"], prevOf(side, ["vaCorrectionType"]) || ""]
        ]
      },
      {
        key: "iop",
        label: "眼圧",
        cell: (side) => (
          <>
            {iop(side)}
            {iopHigh(side) ? <span className="xt-alert">{IOP_ALERT}超</span> : null}
            {method(side)}
            {time(side)}
          </>
        ),
        previous: (side) => {
          const value = prevOf(side, ["iop"]);
          const way = IOP_METHOD_LABELS[prevOf(side, ["iopMethod"])] || "";
          return Number.isFinite(value) ? `${value}${way ? ` ${way}` : ""}` : "";
        },
        copy: (side) => [[side, ["iop"], prevOf(side, ["iop"]) ?? null], [side, ["iopMethod"], prevOf(side, ["iopMethod"]) || ""]]
      }
    ];
    const place = (r, c, rs, cs) => ({ "--r": r, "--c": c, "--rs": rs, "--cs": cs });
    return (
      <div className="xt-wrap">
        <div className="xt-grid is-workbench" data-enter-root onKeyDown={moveToNextOnEnter}>
          <VaDatalist />
          {rows.map((row, index) => (
            <div className="xt-cell xt-label" key={row.key} style={place(index + 2, 1, 2 + index * 3, "1 / -1")}>{row.label}</div>
          ))}
          {SIDES.map((side, column) => (
            <div aria-label={EYE_LABELS[side]} className={`xt-eye xt-eye-${side}`} key={side} role="group">
              <h3 className={`xt-cell xt-head eye-${side}`} style={place(1, column + 2, 1, column + 1)}>{side === "od" ? "右眼 R" : "左眼 L"}</h3>
              {rows.map((row, index) => (
                <div className={`xt-cell xt-value xt-${row.key}`} key={row.key} style={place(index + 2, column + 2, 3 + index * 3, column + 1)}>
                  {row.cell(side)}
                </div>
              ))}
            </div>
          ))}
          <div className="xt-cell xt-head xt-prev-head" style={place(1, 4, 1, "1 / -1")}>
            前回{previousDate ? ` ${formatShortDate(previousDate)}` : ""}
          </div>
          {rows.map((row, index) => (
            <div className="xt-cell xt-prev" key={row.key} style={place(index + 2, 4, 4 + index * 3, "1 / -1")}>
              {SIDES.map((side) => {
                const text = row.previous(side);
                if (!text) return <span className="xt-prev-empty" key={side}>{EYE_SHORT[side]} —</span>;
                const entries = row.copy(side);
                const room = entries.some(([eye, path, value]) => !isBlank(value) && isBlank(getIn(exam[eye], path)));
                return (
                  <button
                    aria-label={`前回の${EYE_LABELS[side]} ${row.label}（${text}）を空欄に写す`}
                    className="xt-prev-value"
                    disabled={!editable || !room}
                    key={side}
                    onClick={() => fill(`前回の${EYE_LABELS[side]} ${row.label}`, entries)}
                    title={room ? "空欄に写す" : "入力済みのため写せません"}
                    type="button"
                  >
                    <span className={`eye-${side}`}>{EYE_SHORT[side]}</span> {text}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {editable ? (
          <div className="xt-actions">
            <button
              className="btn btn-chip"
              onClick={() => fill("右眼の屈折・レンズを左眼へ", [
                ...refractionEntries("os", "refraction", exam.od.refraction),
                ...refractionEntries("os", "correction", exam.od.correction),
                ["os", ["vaCorrectionType"], exam.od.vaCorrectionType || ""],
                ["os", ["iopMethod"], exam.od.iopMethod || ""]
              ])}
              title="左眼の空欄にだけ写します（視力・眼圧の値は写しません）"
              type="button"
            >
              右の屈折・レンズを左へ
            </button>
            {prevExam ? (
              <button
                className="btn btn-chip"
                onClick={() => fill("前回の矯正レンズ", SIDES.flatMap((side) => refractionEntries(side, "correction", prevOf(side, ["correction"]))))}
                title="矯正レンズの空欄にだけ写します（視力は写しません）"
                type="button"
              >
                前回の矯正レンズを写す
              </button>
            ) : null}
            <CopyToast copy={lastCopy} onUndo={undoCopy} />
          </div>
        ) : null}
      </div>
    );
  }

  // カルテ用: 1 眼 1 行。
  const detailHasValues = SIDES.some((side) => hasRefraction(exam[side].refraction) || exam[side].vaCorrectionType || exam[side].measuredAt)
    || Boolean(content.flags?.myopiaTreatment);
  return (
    <ChartExam
      busy={busy}
      canConfirm={canConfirm}
      confirmations={confirmations}
      content={content}
      detailHasValues={detailHasValues}
      editable={editable}
      onConfirm={onConfirm}
      parts={{ triple, va, iop, method, correctionType, time }}
      prevExam={prevExam}
      previousDate={previousDate}
      setBusy={setBusy}
      update={update}
    />
  );
}

function ChartExam({ content, prevExam, previousDate, confirmations, onConfirm, canConfirm, editable, update, detailHasValues, parts, busy, setBusy }) {
  const exam = content.exam;
  const [detailOpen, setDetailOpen] = useState(detailHasValues);
  // 値が入ったら自動で開く（値が隠れないように）。閉じるのは利用者の操作だけ。
  useEffect(() => {
    if (detailHasValues) setDetailOpen(true);
  }, [detailHasValues]);
  const flags = content.flags || {};
  const place = (r, c, rs, cs) => ({ "--r": r, "--c": c, "--rs": rs, "--cs": cs });
  const needsConfirm = (side) => confirmations && !confirmations[side] && hasExamValues(exam[side]);
  const pending = SIDES.filter(needsConfirm);

  async function confirmBoth() {
    setBusy(true);
    try {
      // 片方が失敗したら、その眼は未確認のまま残す（エラーは画面上部に出る）。
      for (const side of pending) {
        if (!(await onConfirm(side, true))) break;
      }
    } finally {
      setBusy(false);
    }
  }

  const confirmCell = (side) => {
    const confirmation = confirmations?.[side];
    if (confirmation) {
      return (
        <span className="xt-confirmed">
          <span className="exam-confirmed" title="確認済み">✓ {confirmation.by?.displayName} {formatTime(confirmation.at)}</span>
          {canConfirm ? <button aria-label={`${EYE_LABELS[side]}の確認を取り消す`} className="xt-unconfirm" onClick={() => onConfirm(side, false)} type="button">×</button> : null}
        </span>
      );
    }
    if (!hasExamValues(exam[side])) return <span className="muted small">未入力</span>;
    return canConfirm
      ? <button aria-label={`${EYE_LABELS[side]}を確認`} className="btn btn-chip xt-confirm" disabled={busy} onClick={() => onConfirm(side, true)} type="button">確認</button>
      : <span className="confirm-pending">未確認</span>;
  };

  return (
    <div className="xt-grid is-chart" data-enter-root onKeyDown={moveToNextOnEnter}>
      <VaDatalist />
      <div className="xt-cell xt-colhead" style={place(1, 2)}>裸眼</div>
      <div className="xt-cell xt-colhead" style={place(1, 3)}>矯正</div>
      <div className="xt-cell xt-colhead xt-colhead-lens" style={place(1, "4 / span 3")}>矯正レンズ S / C / Ax</div>
      <div className="xt-cell xt-colhead" style={place(1, 7)}>眼圧</div>
      <div className="xt-cell xt-colhead" style={place(1, 8)}>方法</div>
      <div className="xt-cell xt-colhead xt-colhead-confirm" style={place(1, 9)}>
        {canConfirm && pending.length === 2 ? (
          <button className="btn btn-chip xt-confirm-both" disabled={busy} onClick={confirmBoth} type="button">両眼を確認</button>
        ) : "確認"}
      </div>
      {SIDES.map((side, index) => {
        const row = 2 + index * 2;
        const small = 2 + index * 3;
        const prev = prevExam ? prevSummary(prevExam[side] || {}) : "";
        return (
          <div aria-label={EYE_LABELS[side]} className={`xt-eye xt-eye-${side}`} key={side} role="group">
            <div className={`xt-cell xt-eye-label eye-${side}`} style={place(row, 1, small, 1)}>{side === "od" ? "R" : "L"}</div>
            <div className="xt-cell" style={place(row, 2, small, 2)}><span className="xt-mlabel">裸眼</span>{parts.va(side, "vaUncorrected", "裸眼視力")}</div>
            <div className="xt-cell" style={place(row, 3, small, 3)}><span className="xt-mlabel">矯正</span>{parts.va(side, "vaCorrected", "矯正視力")}</div>
            <div className="xt-cell xt-lens" style={place(row, "4 / span 3", small + 1, "2 / span 3")}><span className="xt-mlabel">矯正レンズ</span>{parts.triple(side, "correction")}</div>
            <div className="xt-cell" style={place(row, 7, small, 4)}><span className="xt-mlabel">眼圧</span>{parts.iop(side)}</div>
            <div className="xt-cell" style={place(row, 8, small, 5)}><span className="xt-mlabel">方法</span>{parts.method(side)}</div>
            <div className="xt-cell xt-confirm-cell" style={place(row, 9, small + 1, 5)}>{confirmCell(side)}</div>
            {prev ? (
              <div className="xt-cell xt-prev-line" style={place(row + 1, "2 / -1", small + 2, "2 / -1")}>
                前回{previousDate ? ` ${formatShortDate(previousDate)}` : ""}: {prev}
              </div>
            ) : null}
            {detailOpen ? (
              <div className="xt-cell xt-detail" style={place(6 + index, "1 / -1", 8 + index, "1 / -1")}>
                <span className={`xt-detail-eye eye-${side}`}>{side === "od" ? "R" : "L"}</span>
                <span className="xt-detail-item"><span className="xt-detail-label">他覚屈折</span>{parts.triple(side, "refraction")}</span>
                <span className="xt-detail-item"><span className="xt-detail-label">矯正の種類</span>{parts.correctionType(side)}</span>
                <span className="xt-detail-item"><span className="xt-detail-label">測定時刻</span>{parts.time(side)}</span>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="xt-cell xt-detail-toggle" style={place(8, "1 / -1", 10, "1 / -1")}>
        <button aria-expanded={detailOpen} className="link-button" onClick={() => setDetailOpen(!detailOpen)} type="button">
          {detailOpen ? "▾ 他覚屈折・矯正の種類・時刻" : "▸ 他覚屈折・矯正の種類・時刻"}
        </button>
        {detailOpen ? (
          <label className="check-line xt-myopia">
            <input checked={Boolean(flags.myopiaTreatment)} disabled={!editable} onChange={(event) => update(["flags"], { ...flags, myopiaTreatment: event.target.checked })} type="checkbox" />
            近視治療中
          </label>
        ) : null}
      </div>
    </div>
  );
}

function CopyToast({ copy, onUndo }) {
  if (!copy) return null;
  if (!copy.applied.length) return <span className="xt-toast" role="status">{copy.label}: 写せる空欄がありません</span>;
  return (
    <span className="xt-toast" role="status">
      {copy.label}を写しました（{copy.applied.length}欄）
      <button className="btn btn-chip" onClick={onUndo} type="button">元に戻す</button>
    </span>
  );
}

// 「1.0(1.2 × S-1.00 C-0.50 Ax180°) 眼圧 13 NCT」の形（日本の視力の書き方: 括弧の外が裸眼、内が矯正）。
function prevSummary(values) {
  const lens = formatRefraction(values.correction || {});
  const corrected = values.vaCorrected || lens ? `(${values.vaCorrected || "—"}${lens ? ` × ${lens}` : ""})` : "";
  const vision = values.vaUncorrected || corrected ? `${values.vaUncorrected || "—"}${corrected}` : "";
  const pressure = Number.isFinite(values.iop) ? `眼圧 ${values.iop}${values.iopMethod ? ` ${IOP_METHOD_LABELS[values.iopMethod] || ""}` : ""}` : "";
  return [vision, pressure].filter(Boolean).join("　");
}

function formatLens(value) {
  if (!value) return "";
  const parts = [];
  if (Number.isFinite(value.sphere)) parts.push(formatDiopter(value.sphere));
  if (Number.isFinite(value.cylinder)) parts.push(formatDiopter(value.cylinder));
  if (Number.isFinite(value.axis)) parts.push(String(value.axis));
  return parts.join(" ");
}

function hasRefraction(value) {
  return Boolean(value) && Object.values(value).some((item) => item !== null && item !== undefined);
}

function hasCylinder(value) {
  return Number.isFinite(value?.cylinder) && value.cylinder !== 0;
}

function lastIopMethod() {
  try {
    return window.localStorage.getItem(LAST_IOP_METHOD_KEY) || "";
  } catch {
    return "";
  }
}

function rememberIopMethod(value) {
  try {
    window.localStorage.setItem(LAST_IOP_METHOD_KEY, value);
  } catch {
    // 覚えられない環境では毎回選ぶ
  }
}

export function hasExamValues(values = {}) {
  return Boolean(values.vaUncorrected || values.vaCorrected || Number.isFinite(values.iop)
    || [values.correction, values.refraction].some((item) => item && Object.values(item).some((value) => value !== null && value !== undefined)));
}

function nowTime() {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

export function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

function closeMenu(event) {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

const ORDER_STATUS_LABELS = { planned: "予定", performed: "実施済", cancelled: "取消" };
const COMMON_ORDER_CODES = ["va", "iop", "refraction", "oct_retina", "fundus_photo", "vf_static"];

const newOrderId = () => `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 検査・処置のオーダー。予定 → 実施（または取消）。実施者と時刻はサーバーが記録する。
// variant="checklist" は検査ページ用の「本日の検査」（予定が上、押すと実施）。
export function Orders({ content, catalog, update, editable, variant = "list" }) {
  const [code, setCode] = useState(catalog[0]?.code || "");
  const [eye, setEye] = useState("ou");
  const rows = content.orders || [];
  const setStatus = (index, status) => update(["orders", index, "status"], status);
  const remove = (index) => update(["orders"], rows.filter((_, rowIndex) => rowIndex !== index));
  const addItem = (item, orderEye) => update(["orders"], [...rows, {
    orderId: newOrderId(),
    code: item.code,
    name: item.name,
    kind: item.kind,
    eye: item.requiresEye ? orderEye : "",
    status: "planned",
    note: ""
  }]);
  if (variant === "checklist") {
    return <OrderChecklist addItem={addItem} catalog={catalog} content={content} editable={editable} remove={remove} rows={rows} setStatus={setStatus} />;
  }
  const add = () => {
    const item = catalog.find((entry) => entry.code === code);
    if (item) addItem(item, eye);
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
                  {order.status !== "performed" ? <button className="btn btn-ghost btn-sm" onClick={() => setStatus(index, "performed")} type="button">実施</button> : null}
                  {order.status === "planned" ? <button className="btn btn-chip" onClick={() => setStatus(index, "cancelled")} type="button">取消</button> : null}
                  {order.status !== "planned" ? <button className="btn btn-chip" onClick={() => setStatus(index, "planned")} type="button">予定に戻す</button> : null}
                  {order.status === "planned" && !order.statusChangedBy ? (
                    <button aria-label={`${order.name}を削除`} className="btn btn-chip danger-text" onClick={() => remove(index)} type="button">削除</button>
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

const STATUS_RANK = { planned: 0, performed: 1, cancelled: 2 };

function OrderChecklist({ content, catalog, rows, editable, setStatus, remove, addItem }) {
  const [adding, setAdding] = useState(false);
  const [eye, setEye] = useState("ou");
  const [showAll, setShowAll] = useState(false);
  const sorted = rows.map((order, index) => ({ order, index }))
    .sort((a, b) => (STATUS_RANK[a.order.status] ?? 3) - (STATUS_RANK[b.order.status] ?? 3) || a.index - b.index);
  const active = rows.filter((order) => order.status !== "cancelled");
  const done = active.filter((order) => order.status === "performed").length;
  const common = COMMON_ORDER_CODES.map((code) => catalog.find((item) => item.code === code)).filter(Boolean);
  const choices = showAll ? catalog : common;
  return (
    <div className="checklist">
      <div className="mini-head">
        <h2>本日の検査</h2>
        {active.length ? <span className={`checklist-count${done === active.length ? " is-done" : ""}`}>{done}/{active.length}</span> : null}
      </div>
      {rows.length === 0 ? <p className="empty">指示された検査はありません。</p> : (
        <ul className="order-list checklist-list">
          {sorted.map(({ order, index }) => (
            <li className={`order-row checklist-row is-${order.status}`} key={order.orderId}>
              <button
                aria-label={order.status === "performed" ? `${order.name}は実施済み` : `${order.name}を実施済みにする`}
                aria-pressed={order.status === "performed"}
                className="check-toggle"
                disabled={!editable || order.status !== "planned"}
                onClick={() => setStatus(index, "performed")}
                type="button"
              >
                {order.status === "performed" ? "✓" : ""}
              </button>
              <span className="order-name">{order.name}</span>
              {order.eye ? <span className="muted small">{EYE_SHORT[order.eye]}</span> : null}
              {order.status === "planned" && orderHasValues(order, content.exam) ? <span className="checklist-hint" title="検査値が入っています。実施済みにするのを忘れていないか確認してください">値あり</span> : null}
              <span className="checklist-meta">
                {order.status !== "planned" ? <span className={`tag order-status-${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span> : null}
                {order.statusChangedBy ? <span className="muted small">{formatTime(order.statusChangedAt)}</span> : null}
              </span>
              {editable ? (
                <details className="more-menu">
                  <summary aria-label={`${order.name}の操作`} className="btn btn-chip">…</summary>
                  <div className="more-menu-list">
                    {order.status === "planned" ? <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setStatus(index, "cancelled"); }} type="button">取消</button> : null}
                    {order.status !== "planned" ? <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setStatus(index, "planned"); }} type="button">予定に戻す</button> : null}
                    {order.status === "planned" && !order.statusChangedBy ? (
                      <button className="btn btn-ghost danger-text" onClick={(event) => { closeMenu(event); remove(index); }} type="button">削除</button>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable && catalog.length ? (
        adding ? (
          <div className="checklist-add">
            <div aria-label="検査の眼" className="segmented" role="group">
              {["ou", "od", "os"].map((value) => (
                <button aria-pressed={eye === value} key={value} onClick={() => setEye(value)} type="button">{EYE_SHORT[value]}</button>
              ))}
            </div>
            <div className="checklist-choices">
              {choices.map((item) => (
                <button className="btn btn-chip" key={item.code} onClick={() => addItem(item, eye)} type="button">{item.name}</button>
              ))}
              {catalog.length > common.length ? (
                <button aria-expanded={showAll} className="link-button" onClick={() => setShowAll(!showAll)} type="button">{showAll ? "よく使う検査だけ" : "ほかの検査"}</button>
              ) : null}
            </div>
            <button className="link-button" onClick={() => setAdding(false)} type="button">閉じる</button>
          </div>
        ) : (
          <button className="link-button checklist-add-open" onClick={() => setAdding(true)} type="button">＋ 検査を追加</button>
        )
      ) : null}
    </div>
  );
}

// 値の入力からオーダーを「実施」にはしない（算定に結び付くため）。値があることだけを知らせる。
function orderHasValues(order, exam) {
  const sides = order.eye === "od" || order.eye === "os" ? [order.eye] : SIDES;
  return sides.some((side) => {
    const values = exam?.[side] || {};
    if (order.code === "va") return Boolean(values.vaUncorrected || values.vaCorrected);
    if (order.code === "iop") return Number.isFinite(values.iop);
    if (order.code === "iop_gat") return Number.isFinite(values.iop) && values.iopMethod === "goldmann";
    if (order.code === "refraction") return hasRefraction(values.refraction);
    return false;
  });
}

const DILATION_EYES = [["ou", "両眼"], ["od", "右のみ"], ["os", "左のみ"]];

// 散瞳タイマー。散瞳から20分を過ぎたら診察可能の目安として色を変える。
// variant="chip" はカルテの検査欄の見出し用（押すと選択肢）、"panel" は検査ページ用（ボタン 1 つ + 眼の選択）。
// 散瞳オーダーは自動では実施にしない（確認付きで提案するだけ）。
export function DilationFlags({ content, update, editable, now = Date.now(), variant = "chip" }) {
  const [eye, setEye] = useState("ou");
  const flags = content.flags || {};
  const active = Boolean(flags.dilationStartedAt);
  const minutes = active ? Math.max(0, Math.floor((now - Date.parse(flags.dilationStartedAt)) / 60000)) : null;
  const ready = active && minutes >= 20;
  const start = (target) => update(["flags"], { ...flags, dilated: true, dilationStartedAt: new Date().toISOString(), dilationEye: target });
  const cancel = () => update(["flags"], { ...flags, dilated: false, dilationStartedAt: "", dilationEye: "" });
  const eyeShort = flags.dilationEye ? EYE_SHORT[flags.dilationEye] : "";

  if (variant === "chip") {
    const label = active ? `散瞳（${eyeShort}）${minutes}分` : "散瞳なし";
    if (!editable) return active ? <span className={`dilation-chip is-static${ready ? " is-ready" : " is-active"}`}>{label}</span> : null;
    return (
      <details className="more-menu dilation-menu">
        <summary className={`btn btn-chip dilation-chip${active ? (ready ? " is-ready" : " is-active") : ""}`} title={ready ? "20分を過ぎました（診察可能の目安）" : undefined}>{label} ▾</summary>
        <div className="more-menu-list">
          {active ? (
            <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); cancel(); }} type="button">散瞳を取り消す</button>
          ) : DILATION_EYES.map(([value, text]) => (
            <button className="btn btn-ghost" key={value} onClick={(event) => { closeMenu(event); start(value); }} type="button">{value === "ou" ? "両眼散瞳を開始" : `${text}散瞳`}</button>
          ))}
        </div>
      </details>
    );
  }

  const orders = content.orders || [];
  const plannedDilation = orders.findIndex((order) => order.code === "dilation" && order.status === "planned");
  return (
    <div className="dilation-panel">
      <div className="mini-head"><h2>散瞳</h2></div>
      {active ? (
        <>
          <p className={`dilation-status${ready ? " is-ready" : ""}`}>
            散瞳中（{EYE_LABELS[flags.dilationEye] || ""}） <strong>{minutes}分</strong> / 20分{ready ? " ・ 診察可能の目安" : ""}
          </p>
          <span aria-hidden="true" className="dilation-bar"><span style={{ width: `${Math.min(100, (minutes / 20) * 100)}%` }} /></span>
          {editable && plannedDilation >= 0 ? (
            <p className="dilation-order-hint">
              散瞳のオーダーが「予定」のままです。
              <button className="btn btn-chip" onClick={() => update(["orders", plannedDilation, "status"], "performed")} type="button">散瞳オーダーを実施にする</button>
            </p>
          ) : null}
          {editable ? <button className="link-button" onClick={cancel} type="button">散瞳を取り消す</button> : null}
        </>
      ) : editable ? (
        <div className="dilation-start">
          <div aria-label="散瞳する眼" className="segmented" role="group">
            {[["ou", "両"], ["od", "右"], ["os", "左"]].map(([value, text]) => (
              <button aria-pressed={eye === value} key={value} onClick={() => setEye(value)} type="button">{text}</button>
            ))}
          </div>
          <button className="btn btn-ghost" onClick={() => start(eye)} type="button">散瞳開始</button>
        </div>
      ) : <p className="muted small">散瞳していません。</p>}
    </div>
  );
}

const OPTICAL_PURPOSE_LABELS = { far: "遠用", near: "近用", middle: "中間", progressive: "遠近両用（累進）", bifocal: "二重焦点" };
const OPTICAL_DIOPTER_KEYS = new Set(["sphere", "cylinder", "add"]);

// 眼鏡・コンタクトレンズの処方。「発行する」にすると確定前チェックの対象になる。
export function OpticalSection({ content, update, editable, encounterId }) {
  const optical = content.optical || { type: "", purpose: "far", od: {}, os: {}, issue: false };
  const set = (patch) => update(["optical"], { ...optical, ...patch });
  const setSide = (side, key, value) => update(["optical"], { ...optical, [side]: { ...optical[side], [key]: value } });
  const problems = evaluateOpticalPrescription({ ...optical, issue: true });
  const contact = optical.type === "contact";

  function copyFromExam() {
    const next = { ...optical };
    for (const side of SIDES) {
      const correction = content.exam[side].correction || {};
      next[side] = { ...optical[side], sphere: correction.sphere ?? null, cylinder: correction.cylinder ?? null, axis: correction.axis ?? null, va: content.exam[side].vaCorrected || "" };
    }
    update(["optical"], next);
  }

  // 文字入力で受ける（入力途中の「-」が消えないように）。範囲の確認は確定前チェックで行う。
  const numberCell = (side, key, props = {}) => (
    <NumberField
      aria-label={`${EYE_LABELS[side]} ${props.label || key}`}
      className="input input-num"
      format={OPTICAL_DIOPTER_KEYS.has(key) ? formatDiopter : undefined}
      onCommit={(value) => setSide(side, key, value)}
      value={optical[side]?.[key]}
    />
  );

  return (
    <div>
      <div className="row-line">
        <select aria-label="眼鏡・CL の種類" className="input" onChange={(event) => set({ type: event.target.value })} value={optical.type}>
          <option value="">処方しない</option>
          <option value="glasses">眼鏡</option>
          <option value="contact">コンタクトレンズ</option>
        </select>
        {optical.type ? (
          <>
            <select aria-label="用途" className="input" onChange={(event) => set({ purpose: event.target.value })} value={optical.purpose}>
              {Object.entries(OPTICAL_PURPOSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {editable ? <button className="btn btn-chip" onClick={copyFromExam} type="button">検査の矯正値を写す</button> : null}
          </>
        ) : null}
      </div>
      {optical.type ? (
        <>
          <div className="table-scroll">
            <table className="exam-table optical-table">
              <thead>
                <tr>
                  <th />
                  <th>S</th><th>C</th><th>Ax</th>
                  {contact ? <><th>BC</th><th>DIA</th><th>製品名</th></> : <><th>ADD</th><th>プリズム</th><th>基底</th></>}
                  <th>矯正視力</th>
                </tr>
              </thead>
              <tbody>
                {SIDES.map((side) => (
                  <tr key={side}>
                    <th className={`eye-${side}`} scope="row">{EYE_LABELS[side]}</th>
                    <td>{numberCell(side, "sphere", { label: "S" })}</td>
                    <td>{numberCell(side, "cylinder", { label: "C" })}</td>
                    <td>{numberCell(side, "axis", { label: "Ax" })}</td>
                    {contact ? (
                      <>
                        <td>{numberCell(side, "bc", { label: "BC" })}</td>
                        <td>{numberCell(side, "dia", { label: "DIA" })}</td>
                        <td><input aria-label={`${EYE_LABELS[side]} 製品名`} className="input" onChange={(event) => setSide(side, "product", event.target.value)} value={optical[side]?.product || ""} /></td>
                      </>
                    ) : (
                      <>
                        <td>{numberCell(side, "add", { label: "ADD" })}</td>
                        <td>{numberCell(side, "prism", { label: "プリズム" })}</td>
                        <td><input aria-label={`${EYE_LABELS[side]} 基底`} className="input input-unit" onChange={(event) => setSide(side, "base", event.target.value)} placeholder="BI等" value={optical[side]?.base || ""} /></td>
                      </>
                    )}
                    <td><input aria-label={`${EYE_LABELS[side]} 矯正視力（眼鏡）`} className="input input-unit" onChange={(event) => setSide(side, "va", event.target.value)} value={optical[side]?.va || ""} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-line">
            {!contact ? (
              <label className="inline-field"><span>PD</span><input aria-label="瞳孔間距離" className="input input-num" onChange={(event) => set({ pd: parseNumber(event.target.value) })} step="0.5" type="number" value={optical.pd ?? ""} /><span>mm</span></label>
            ) : null}
            <label className="inline-field"><span>有効期間</span><input aria-label="有効期間" className="input input-num" onChange={(event) => set({ validDays: parseNumber(event.target.value) })} type="number" value={optical.validDays ?? ""} /><span>日</span></label>
            <input aria-label="備考" className="input grow" onChange={(event) => set({ note: event.target.value })} placeholder="備考（装用時間・レンズの種類など）" value={optical.note || ""} />
          </div>
          <div className="row-line">
            <label className="check-line"><input checked={Boolean(optical.issue)} onChange={(event) => set({ issue: event.target.checked })} type="checkbox" />今回{contact ? "CL 指示書" : "眼鏡処方箋"}を発行する</label>
            {optical.issue ? <a className="btn btn-chip" href={`/encounters/${encounterId}/optical`} rel="noreferrer" target="_blank">{contact ? "CL 指示書" : "眼鏡処方箋"}を印刷</a> : null}
          </div>
          {optical.issue && problems.length ? (
            <ul className="readiness">{problems.map((item, index) => <li className="is-blocker" key={index}>{item.message}</li>)}</ul>
          ) : null}
        </>
      ) : null}
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
      {content.sketches.length === 0 && !editable ? <p className="empty">シェーマはありません。</p> : null}
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

const TOPICAL = new Set(["eye_drop", "eye_ointment"]);

// 処方 1 剤の読める 1 行（薬剤名・眼・回数・用法・数量・院内外・日数）。
function prescriptionLine(row) {
  return [
    row.eye ? EYE_LABELS[row.eye] : "",
    row.timesPerDay ? `1日${row.timesPerDay}回` : "",
    row.usage || "",
    row.issued !== false && row.quantity ? `${row.quantity}${row.unit || ""}` : "",
    row.route === "inside" ? "院内" : "院外",
    row.issued !== false && row.days ? `${row.days}日分` : ""
  ].filter(Boolean).join(" ");
}

// 処方。1 剤 1 行で表示し、押した行だけ編集欄を開く。開くだけでは内容を変えない（引き継ぎの確認状態もそのまま）。
export function Prescriptions({ content, drugPresets, nextDays, update, editable }) {
  const rows = content.prescriptions;
  const [expanded, setExpanded] = useState(() => new Set());
  const listRef = useRef(null);
  // 行を編集したら、その処方は今回の内容として確認したものとみなす。
  const setRow = (index, patch) => update(["prescriptions", index], { ...rows[index], carriedOver: false, ...patch });
  const carriedCount = rows.filter((row) => row.carriedOver).length;
  const presetByName = new Map(drugPresets.map((preset) => [preset.name, preset]));

  const focusRow = (index) => requestAnimationFrame(() => {
    listRef.current?.querySelector(`[data-rx-index="${index}"] .rx-edit input`)?.focus();
  });
  function toggle(index) {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else {
      next.add(index);
      focusRow(index);
    }
    setExpanded(next);
  }
  function collapse(index) {
    const next = new Set(expanded);
    next.delete(index);
    setExpanded(next);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-rx-index="${index}"] .rx-line`)?.focus());
  }

  function changeName(index, name) {
    const preset = presetByName.get(name);
    setRow(index, preset
      ? {
        name,
        presetId: preset.presetId,
        kind: preset.kind,
        timesPerDay: rows[index].timesPerDay ?? preset.defaultTimesPerDay ?? null,
        usage: rows[index].usage || preset.defaultUsage || "",
        route: preset.route || rows[index].route || "outside"
      }
      : { name, presetId: "" });
  }

  // 両眼の処方を、右眼・左眼の2行に分ける（片眼だけ変更・中止するとき）。
  function splitEyes(index) {
    const row = rows[index];
    const next = [...rows];
    next.splice(index, 1, { ...row, eye: "od", quantity: null }, { ...row, eye: "os", quantity: null });
    update(["prescriptions"], next);
    const opened = new Set([...expanded].map((item) => (item > index ? item + 1 : item)));
    opened.add(index);
    opened.add(index + 1);
    setExpanded(opened);
  }

  function removeRow(index) {
    update(["prescriptions"], rows.filter((_, rowIndex) => rowIndex !== index));
    setExpanded(new Set([...expanded].filter((item) => item !== index).map((item) => (item > index ? item - 1 : item))));
  }

  function addRow() {
    update(["prescriptions"], [...rows, { kind: "eye_drop", name: "", presetId: "", eye: "ou", timesPerDay: null, quantity: null, unit: "", days: null, note: "", route: "outside", usage: "", issued: true }]);
    setExpanded(new Set([...expanded, rows.length]));
    focusRow(rows.length);
  }

  return (
    <div ref={listRef}>
      <datalist id="drug-presets">
        {drugPresets.map((preset) => <option key={preset.presetId} value={preset.name} />)}
      </datalist>
      <datalist id="common-usages">
        {COMMON_USAGES.map((usage) => <option key={usage} value={usage} />)}
      </datalist>
      {carriedCount ? (
        <p className="rx-carried">
          <span>前回からの引き継ぎ <strong>{carriedCount}件</strong></span>
          {editable ? (
            <button className="btn btn-chip" onClick={() => update(["prescriptions"], rows.map((row) => ({ ...row, carriedOver: false })))} title="引き継いだ処方を、今回の処方として確認します（確定時にも確認できます）" type="button">このまま継続</button>
          ) : null}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="empty">処方はありません。</p> : null}
      <ul className="rx-list">
        {rows.map((row, index) => {
          const open = expanded.has(index);
          const preset = row.presetId ? drugPresets.find((item) => item.presetId === row.presetId) : null;
          const days = row.days || nextDays;
          const bottles = row.kind === "eye_drop" && row.issued !== false
            ? calculateEyeDropBottles({ timesPerDay: row.timesPerDay, eye: row.eye, days, dropsPerBottle: preset?.dropsPerBottle })
            : null;
          const eyeMissing = TOPICAL.has(row.kind) && !row.eye;
          return (
            <li className={`rx-row${row.issued === false ? " is-not-issued" : ""}${row.carriedOver ? " is-carried" : ""}${open ? " is-open" : ""}`} data-rx-index={index} key={index}>
              <button aria-expanded={open} className="rx-line" onClick={() => toggle(index)} title={open ? "閉じる" : "押して編集"} type="button">
                {row.issued === false ? <span className="rx-off">（今回なし）</span> : null}
                <span className={`rx-line-name${row.name ? "" : " is-missing"}`}>{row.name || "（薬剤名なし）"}</span>
                <span className="rx-line-detail">{prescriptionLine(row)}</span>
                {eyeMissing ? <span className="rx-line-missing">眼 未指定</span> : null}
                {row.carriedOver ? <span className="tag tag-warn rx-carried-tag" title="前回から引き継いだ処方です">引継</span> : null}
              </button>
              {open ? (
                <div
                  className="rx-edit"
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                      event.stopPropagation();
                      collapse(index);
                    }
                  }}
                >
                  <div className="rx-main">
                    <input aria-label="薬剤名" className="input rx-name" list="drug-presets" onChange={(event) => changeName(index, event.target.value)} placeholder="薬剤名" value={row.name} />
                    <select aria-label="処方の眼" className="input rx-eye" onChange={(event) => setRow(index, { eye: event.target.value })} value={row.eye}>
                      <option value="">眼</option>
                      {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <label className="inline-field">
                      <span>1日</span>
                      <input aria-label="1日の回数" className="input input-num input-short" inputMode="numeric" min="0" onChange={(event) => setRow(index, { timesPerDay: parseNumber(event.target.value) })} type="number" value={row.timesPerDay ?? ""} />
                      <span>回</span>
                    </label>
                    <input aria-label="用法" className="input rx-usage" list="common-usages" onChange={(event) => setRow(index, { usage: event.target.value })} placeholder="用法" value={row.usage || ""} />
                  </div>
                  <div className="rx-sub">
                    <select aria-label="処方の種類" className="input input-compact" onChange={(event) => setRow(index, { kind: event.target.value })} value={row.kind}>
                      {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <select aria-label="院内・院外" className="input input-compact" onChange={(event) => setRow(index, { route: event.target.value })} value={row.route || "outside"}>
                      <option value="outside">院外</option>
                      <option value="inside">院内</option>
                    </select>
                    <label className="inline-field">
                      <input aria-label="数量" className="input input-num input-short input-compact" disabled={row.issued === false} min="0" onChange={(event) => setRow(index, { quantity: parseNumber(event.target.value) })} step="any" type="number" value={row.quantity ?? ""} />
                      <input aria-label="単位" className="input input-unit input-compact" disabled={row.issued === false} onChange={(event) => setRow(index, { unit: event.target.value })} placeholder="本" value={row.unit} />
                    </label>
                    <label className="inline-field">
                      <input aria-label="日数" className="input input-num input-short input-compact" disabled={row.issued === false} min="0" onChange={(event) => setRow(index, { days: parseNumber(event.target.value) })} type="number" value={row.days ?? ""} />
                      <span>日分</span>
                    </label>
                    <label className="check-line rx-issued" title="継続中だが今回は薬を出さない場合にチェック">
                      <input checked={row.issued === false} onChange={(event) => setRow(index, { issued: !event.target.checked })} type="checkbox" />
                      今回は出さない
                    </label>
                    {bottles?.bottles ? (
                      <span className="rx-bottles">
                        目安 <strong>{bottles.bottles}本</strong>
                        <span className="muted small" title={`${days}日 × 1日${row.timesPerDay}回 × ${row.eye === "ou" ? 2 : 1}眼 = ${bottles.dropsNeeded}滴 ÷ 1本${bottles.dropsPerBottle}滴`}>（{days}日{row.days ? "" : "・次回まで"}）</span>
                        {editable && !(row.quantity === bottles.bottles && row.unit === "本") ? (
                          <button className="btn btn-chip" onClick={() => setRow(index, { quantity: bottles.bottles, unit: "本" })} type="button">反映</button>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="rx-actions">
                      {row.eye === "ou" && TOPICAL.has(row.kind) ? (
                        <button className="btn btn-chip" onClick={() => splitEyes(index)} type="button">左右に分ける</button>
                      ) : null}
                      <button aria-label="この処方を削除" className="btn btn-chip danger-text" onClick={() => removeRow(index)} type="button">削除</button>
                      <button className="btn btn-chip" onClick={() => collapse(index)} type="button">閉じる</button>
                    </span>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button className="link-button rx-add" onClick={addRow} type="button">＋ 処方を追加</button>
    </div>
  );
}

export function NextVisit({ content, encounterDate, suggestion, update, editable, action = null }) {
  const weeks = content.nextVisit.intervalWeeks;
  const nextDate = weeks ? addDays(encounterDate, Math.round(weeks * 7)) : "";
  return (
    <div>
      <div className="row-line next-visit-line">
        <label className="inline-field">
          <input aria-label="次回まで（週）" className="input input-num input-short" inputMode="decimal" min="0" onChange={(event) => update(["nextVisit", "intervalWeeks"], parseNumber(event.target.value))} type="number" value={weeks ?? ""} />
          <span>週後</span>
        </label>
        {nextDate ? <span className="muted">{formatShortDate(nextDate)}</span> : null}
        <input aria-label="次回のメモ" className="input grow" onChange={(event) => update(["nextVisit", "note"], event.target.value)} placeholder="メモ（例: 視野検査予定）" value={content.nextVisit.note} />
        {action}
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
