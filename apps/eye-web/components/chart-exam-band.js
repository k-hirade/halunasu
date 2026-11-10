"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { buildTrend, pupilLabel, sortExamRecords } from "@halunasu/eye-core";
import { ALIGNMENT_LABELS, IOL_CL_LABELS, MOTILITY_LABELS, RAPD_LABELS } from "@halunasu/eye-contracts";
import { DilationFlags, formatTime, hasExamValues } from "./encounter-sections";
import { TrendPanel } from "./trend-chart";
import { formatRefraction, formatShortDate, formatVisualAcuityLine, IOP_METHOD_LABELS } from "../lib/format";

const SIDES = ["od", "os"];
const SIDE_MARK = { od: "RV", os: "LV" };

// 記録の中で、ある値を持つ最後の記録（時刻・検者を出すため）。
function lastRecordWith(records, pick) {
  return [...records].reverse().find((record) => pick(record.values || {})) || null;
}

function recordStamp(record) {
  if (!record) return "";
  return [formatTime(record.at), record.examinerName || record.recordedBy?.displayName || ""].filter(Boolean).join(" ");
}

// 視力の行（「0.9（1.2×S-1.00D=C-0.50D Ax180°）」）は空白で折らない。折るなら括弧の前で折れ、「Ax180°）」だけが次の行に残らない。
const keepTogether = (text) => (text ? text.replace(/ /gu, "\u00a0") : text);
const isFilled = (value) => value !== null && value !== undefined && value !== "";

function nearLine(row = {}) {
  const lens = formatRefraction(row);
  const corrected = row.corrected || lens ? `（${row.corrected || "—"}${lens ? `×${lens}` : ""}）` : "";
  if (!row.uncorrected && !corrected) return "";
  return `${row.uncorrected || "—"}${corrected}${row.iolCl ? ` ${IOL_CL_LABELS[row.iolCl]}` : ""}`;
}

// 中央の「主訴・所見」の上に出す検査の帯（トプコンの過去カルテの【自覚検査】【眼圧検査】の読み方）。入力は検査ページで行う。
export function ExamBand({ content, encounterId, confirmations, canConfirm, onConfirm, previous, previousDate, editable, update, now }) {
  const [busy, setBusy] = useState(false);
  const exam = content.exam || {};
  const records = useMemo(() => sortExamRecords(content.examRecords || []), [content.examRecords]);
  const visionRecord = lastRecordWith(records, (values) => values.vision);
  const iopRecord = lastRecordWith(records, (values) => values.iop);
  const binocularVa = visionRecord?.values?.vision?.far?.ou || {};
  const near = visionRecord?.values?.vision?.near || {};
  const any = SIDES.some((side) => hasExamValues(exam[side]) || isFilled(exam[side]?.vaNear)) || records.length > 0;
  const needsConfirm = (side) => confirmations && !confirmations[side] && hasExamValues(exam[side]);
  const pending = SIDES.filter(needsConfirm);

  async function confirmBoth() {
    setBusy(true);
    try {
      for (const side of pending) {
        if (!(await onConfirm(side, true))) break;
      }
    } finally {
      setBusy(false);
    }
  }

  const iopText = (side) => {
    const item = iopRecord?.values?.iop?.[side];
    if (item?.readings?.length > 1) return `${item.readings.map((reading) => reading.value).join(" / ")}（平均 ${item.average}）`;
    return Number.isFinite(exam[side]?.iop) ? String(exam[side].iop) : "—";
  };
  const iopMethod = IOP_METHOD_LABELS[exam.od?.iopMethod || exam.os?.iopMethod] || "";
  const refraction = SIDES.map((side) => formatRefraction(exam[side]?.refraction || {}));
  const kerato = SIDES.map((side) => {
    const value = exam[side]?.keratometry || {};
    return [isFilled(value.k1) ? `K1 ${value.k1}` : "", isFilled(value.k2) ? `K2 ${value.k2}` : "", isFilled(value.axis) ? `Ax${value.axis}°` : ""].filter(Boolean).join(" ");
  });
  const binocular = exam.binocular || {};
  const pupils = SIDES.map((side) => {
    const text = pupilLabel(exam[side]?.pupil);
    return text ? `${side === "od" ? "R" : "L"} ${text}` : "";
  }).filter(Boolean).join(" ");
  const extras = [
    pupils ? `瞳孔 ${pupils}` : "",
    binocular.rapd ? `RAPD ${RAPD_LABELS[binocular.rapd]}` : "",
    binocular.alignment || binocular.alignmentNote ? `眼位 ${[ALIGNMENT_LABELS[binocular.alignment], binocular.alignmentNote].filter(Boolean).join(" ")}` : "",
    binocular.motility || binocular.motilityNote ? `眼球運動 ${[MOTILITY_LABELS[binocular.motility], binocular.motilityNote].filter(Boolean).join(" ")}` : ""
  ].filter(Boolean);
  const prev = previous?.exam;

  const confirmCell = (side) => {
    const confirmation = confirmations?.[side];
    if (confirmation) {
      return (
        <span className="exam-confirmed" title="確認済み">
          {side === "od" ? "R" : "L"} ✓ {confirmation.by?.displayName} {formatTime(confirmation.at)}
          {canConfirm ? <button aria-label={`${side === "od" ? "右眼" : "左眼"}の確認を取り消す`} className="rp-x" onClick={() => onConfirm(side, false)} type="button">×</button> : null}
        </span>
      );
    }
    if (!hasExamValues(exam[side])) return null;
    return canConfirm
      ? <button aria-label={`${side === "od" ? "右眼" : "左眼"}を確認`} className="btn btn-chip" disabled={busy} onClick={() => onConfirm(side, true)} type="button">{side === "od" ? "R" : "L"} 確認</button>
      : <span className="confirm-pending">{side === "od" ? "R" : "L"} 未確認</span>;
  };

  return (
    <section aria-labelledby="exam-heading" className="exam-band" id="sec-exam">
      <div className="exam-band-head">
        <h3 id="exam-heading">検査</h3>
        <DilationFlags content={content} editable={editable} now={now} update={update} variant="chip" />
        {records.length ? <span className="muted small">記録 {records.length}件</span> : null}
        <Link className="btn btn-chip exam-band-open" href={`/encounters/${encounterId}/exam`}>検査入力を開く</Link>
      </div>
      {!any ? <p className="muted small exam-band-empty">検査値はまだありません。</p> : (
        <div className="exam-band-body">
          <div className="exam-block">
            <span className="exam-block-label">【視力】{visionRecord ? <span className="exam-block-stamp" title={recordStamp(visionRecord)}>{recordStamp(visionRecord)}</span> : null}</span>
            <div className="exam-block-values">
              {SIDES.map((side) => (
                <span className={`exam-va eye-${side}`} key={side}>
                  <span className="exam-eye-mark">{SIDE_MARK[side]}=</span>{keepTogether(formatVisualAcuityLine(exam[side] || {})) || "—"}
                </span>
              ))}
              {binocularVa.uncorrected || binocularVa.corrected ? (
                <span className="exam-va"><span className="exam-eye-mark">BV=</span>{binocularVa.uncorrected || "—"}{binocularVa.corrected ? `（${binocularVa.corrected}）` : ""}</span>
              ) : null}
            </div>
            {SIDES.some((side) => nearLine(near[side]) || exam[side]?.vaNear) ? (
              <div className="exam-block-values is-near">
                <span className="exam-near-label">近見</span>
                {SIDES.map((side) => (
                  <span className={`exam-va eye-${side}`} key={side}><span className="exam-eye-mark">{SIDE_MARK[side]}=</span>{nearLine(near[side]) || exam[side]?.vaNear || "—"}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="exam-block">
            <span className="exam-block-label">【眼圧】{iopMethod ? <span className="exam-block-stamp">{iopMethod}</span> : null}{iopRecord ? <span className="exam-block-stamp" title={recordStamp(iopRecord)}>{recordStamp(iopRecord)}</span> : null}</span>
            <div className="exam-block-values">
              {SIDES.map((side) => (
                <span className={`exam-iop eye-${side}${exam[side]?.iop > 21 ? " is-high" : ""}`} key={side}>
                  <span className="exam-eye-mark">{side === "od" ? "R" : "L"}</span> {iopText(side)}
                </span>
              ))}
              <span className="muted small">mmHg</span>
            </div>
          </div>
          {refraction.some(Boolean) || kerato.some(Boolean) ? (
            <div className="exam-block">
              <span className="exam-block-label">【屈折】</span>
              <div className="exam-block-values">
                {SIDES.map((side, index) => (refraction[index] || kerato[index] ? (
                  <span className={`exam-va eye-${side}`} key={side}><span className="exam-eye-mark">{side === "od" ? "R" : "L"}</span> {[refraction[index], kerato[index]].filter(Boolean).join("　")}</span>
                ) : null))}
              </div>
            </div>
          ) : null}
          {extras.length ? <p className="exam-extras-line">{extras.join("　")}</p> : null}
          {confirmations ? (
            <div className="exam-confirm-row">
              {SIDES.map((side) => <span key={side}>{confirmCell(side)}</span>)}
              {canConfirm && pending.length === 2 ? <button className="btn btn-chip" disabled={busy} onClick={confirmBoth} type="button">両眼を確認</button> : null}
            </div>
          ) : null}
        </div>
      )}
      {prev && SIDES.some((side) => hasExamValues(prev[side])) ? (
        <p className="exam-prev-line">
          前回{previousDate ? ` ${formatShortDate(previousDate)}` : ""}:
          {SIDES.map((side) => (
            <span key={side}> <span className={`eye-${side}`}>{side === "od" ? "R" : "L"}</span> {formatVisualAcuityLine(prev[side] || {}) || "—"}{Number.isFinite(prev[side]?.iop) ? ` 眼圧 ${prev[side].iop}` : ""}</span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

// 左の「検査」タブ: 視力・眼圧の表（トプコンの視力眼圧タブ）と推移のグラフ。値を押すと主訴・所見へ日付付きで書き込む。
export function ExamHistoryTab({ history, current, currentDate, onInsert, editable }) {
  const rows = useMemo(() => {
    const visits = [
      ...(current ? [{ encounterId: "current", encounterDate: currentDate, content: current, today: true }] : []),
      ...history
    ];
    return visits.filter((visit) => SIDES.some((side) => hasExamValues(visit.content?.exam?.[side])));
  }, [history, current, currentDate]);
  const trend = useMemo(() => buildTrend(history), [history]);
  const insert = (date, text) => onInsert(`${formatShortDate(date)} ${text}`);
  const cell = (visit, side, text, label) => (text ? (
    editable ? (
      <button className="exam-cell-button" onClick={() => insert(visit.encounterDate, `${side === "od" ? "右眼" : "左眼"} ${label} ${text}`)} title="主訴・所見へ書き込む" type="button">{text}</button>
    ) : text
  ) : "—");
  return (
    <div className="exam-tab">
      {rows.length === 0 ? <p className="empty">視力・眼圧の記録はありません。</p> : (
        <>
          <table className="data-table exam-history-table" aria-label="視力">
            <thead><tr><th scope="col">検査日</th><th scope="col">右眼 視力</th><th scope="col">左眼 視力</th></tr></thead>
            <tbody>
              {rows.map((visit) => (
                <tr className={visit.today ? "is-today" : ""} key={visit.encounterId}>
                  <th scope="row">{formatShortDate(visit.encounterDate)}{visit.today ? <span className="tag">今日</span> : null}</th>
                  {SIDES.map((side) => <td key={side}>{cell(visit, side, formatVisualAcuityLine(visit.content.exam[side] || {}), "視力")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <table className="data-table exam-history-table" aria-label="眼圧">
            <thead><tr><th scope="col">検査日</th><th scope="col">方式</th><th scope="col">右眼 眼圧</th><th scope="col">左眼 眼圧</th></tr></thead>
            <tbody>
              {rows.map((visit) => {
                const exam = visit.content.exam;
                const method = IOP_METHOD_LABELS[exam.od?.iopMethod || exam.os?.iopMethod] || "";
                return (
                  <tr className={visit.today ? "is-today" : ""} key={visit.encounterId}>
                    <th scope="row">{formatShortDate(visit.encounterDate)}</th>
                    <td>{method || "—"}</td>
                    {SIDES.map((side) => (
                      <td className={exam[side]?.iop > 21 ? "is-high" : ""} key={side}>{cell(visit, side, Number.isFinite(exam[side]?.iop) ? String(exam[side].iop) : "", "眼圧")}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <table className="data-table exam-history-table" aria-label="屈折">
            <thead><tr><th scope="col">検査日</th><th scope="col">右眼 屈折</th><th scope="col">左眼 屈折</th></tr></thead>
            <tbody>
              {rows.filter((visit) => SIDES.some((side) => formatRefraction(visit.content.exam[side]?.refraction || {}))).map((visit) => (
                <tr key={visit.encounterId}>
                  <th scope="row">{formatShortDate(visit.encounterDate)}</th>
                  {SIDES.map((side) => <td key={side}>{formatRefraction(visit.content.exam[side]?.refraction || {}) || "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {trend.points.length > 1 ? <div className="exam-tab-trend"><TrendPanel trend={trend} /></div> : null}
      {current?.examRecords?.length ? (
        <section className="exam-records-today">
          <h3>本日の検査記録</h3>
          <ol className="plain">
            {sortExamRecords(current.examRecords).map((record) => (
              <li key={record.recordId}>
                <strong>{formatTime(record.at)}</strong> {record.examinerName || record.recordedBy?.displayName || ""}
                <span className="muted small"> {recordSummary(record.values)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function recordSummary(values = {}) {
  const parts = [];
  if (values.vision) parts.push("視力");
  if (values.iop) parts.push("眼圧");
  if (values.refraction) parts.push("屈折");
  if (values.keratometry) parts.push("角膜曲率");
  if (values.pupil) parts.push("瞳孔");
  if (values.binocular) parts.push("眼位など");
  if (values.devices) parts.push("機器");
  return parts.join("・");
}

