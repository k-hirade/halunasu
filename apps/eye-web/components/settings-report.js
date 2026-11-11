"use client";

import { useEffect, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { SectionHead } from "./settings-master";
import { formatDate, formatDateTime, todayIso } from "../lib/format";
import { csvText, dailyReportRows, monthlyReportRows, monthRange, rangeDays, visitReportRows } from "../lib/admin";

const MAX_DAYS = 366;

function downloadCsv(rows, name) {
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 経営データ集計（デジカル p.192 の形: 期間 〜 期間 ・ メモを含めるか ・［集計する］→ 下に集計の記録とダウンロード）。
// 金額はレセコンで扱うので、ここは予約・受付の件数（日別・月別）と受診の一覧。
export function ReportSection() {
  const api = useEyeApi();
  const today = todayIso();
  const [range, setRange] = useState(() => monthRange(today));
  const [includeMemo, setIncludeMemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { report, generatedAt, includeMemo }
  const [history, setHistory] = useState(null);
  const [doctors, setDoctors] = useState({});
  const busyRef = useRef(false);
  const days = rangeDays(range.from, range.to);
  const rangeError = !range.from || !range.to ? "期間を入れてください。" : range.to < range.from ? "終わりの日は始まりの日以降にしてください。" : days > MAX_DAYS ? `期間は${MAX_DAYS}日までです。` : "";

  function loadHistory() {
    api("/v1/eye/audit-logs?category=export&limit=200")
      .then((payload) => setHistory((payload.auditLogs || []).filter((item) => item.eventType === "eye.report_exported").slice(0, 10).map((item) => ({ ...item, by: payload.actors?.[item.actorMemberId]?.displayName || item.actorLoginId }))))
      .catch(() => setHistory([]));
  }

  useEffect(() => {
    loadHistory();
    api("/v1/eye/doctors").then((payload) => setDoctors(Object.fromEntries((payload.doctors || []).map((item) => [item.memberId, item.printName || item.displayName])))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function run(nextRange = range, memo = includeMemo) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ from: nextRange.from, to: nextRange.to, ...(memo ? { includeMemo: "1" } : {}) });
      const payload = await api(`/v1/eye/reports/visits?${params}`);
      setResult({ ...payload, includeMemo: memo });
      loadHistory();
    } catch (nextError) {
      setError(nextError.status === 404 ? "この環境の API はまだ集計に対応していません。" : nextError.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const report = result?.report;
  const stamp = report ? `${report.range.from.replaceAll("-", "")}-${report.range.to.replaceAll("-", "")}` : "";
  return (
    <section aria-label="経営データ集計" className="settings-section admin-section">
      <SectionHead title="経営データ集計">期間を決めて、予約・受付の件数（日別・月別）と受診の一覧を CSV で出します。点数・金額はレセコンで集計してください。</SectionHead>
      <form className="panel report-form" onSubmit={(event) => { event.preventDefault(); if (!rangeError) run(); }}>
        <span className="report-label">集計の期間</span>
        <span className="report-range">
          <input aria-label="集計の開始日" className="input input-date" max={today} onChange={(event) => setRange({ ...range, from: event.target.value })} type="date" value={range.from} />
          <span aria-hidden="true">〜</span>
          <input aria-label="集計の終了日" className="input input-date" max={today} onChange={(event) => setRange({ ...range, to: event.target.value })} type="date" value={range.to} />
        </span>
        <label className="field-check"><input checked={includeMemo} onChange={(event) => setIncludeMemo(event.target.checked)} type="checkbox" />受付メモを含める</label>
        <button aria-busy={busy} className="btn btn-primary" disabled={busy || Boolean(rangeError)} type="submit">{busy ? "集計中…" : "集計する"}</button>
        <small className={rangeError ? "report-hint is-error" : "report-hint muted"}>{rangeError || `最大${MAX_DAYS}日まで（いま ${days}日）。個人情報を含む一覧は院内で決めた場所に保管してください。`}</small>
      </form>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      {report ? (
        <div className="panel report-result" role="region" aria-label="集計の結果">
          <div className="report-result-head">
            <h3>{formatDate(report.range.from)} 〜 {formatDate(report.range.to)}<span className="muted small">（{formatDateTime(result.generatedAt)} 集計）</span></h3>
            <div className="report-downloads">
              <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv(dailyReportRows(report), `eye-daily-${stamp}.csv`)} type="button">日別 CSV</button>
              <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv(monthlyReportRows(report), `eye-monthly-${stamp}.csv`)} type="button">月別 CSV</button>
              <button className="btn btn-primary btn-sm" onClick={() => downloadCsv(visitReportRows(report, { doctors, includeMemo: result.includeMemo }), `eye-visits-${stamp}.csv`)} type="button">受診一覧 CSV（{report.visits.length}件）</button>
            </div>
          </div>
          <dl className="report-totals">
            {[["来院", report.totals.arrived], ["初診", report.totals.initial], ["再診ほか", report.totals.revisit], ["予約なし来院", report.totals.walkIn], ["予約", report.totals.booked], ["取消", report.totals.cancelled], ["不在", report.totals.absent]].map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
          <h4 className="report-subhead">月別受付回数</h4>
          <div className="admin-table-wrap">
            <table className="data-table admin-table report-table">
              <thead><tr><th scope="col">月</th><th scope="col">来院</th><th scope="col">初診</th><th scope="col">再診ほか</th><th scope="col">取消</th><th scope="col">不在</th><th scope="col">来院のあった日</th></tr></thead>
              <tbody>
                {report.months.map((month) => (
                  <tr key={month.month}><td>{month.month.replace("-", "年")}月</td><td className="num">{month.arrived}</td><td className="num">{month.initial}</td><td className="num">{month.revisit}</td><td className="num">{month.cancelled}</td><td className="num">{month.absent}</td><td className="num">{month.openDays}日</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="panel report-history">
        <h3>集計の記録</h3>
        {history === null ? <p className="loading">読み込み中…</p> : history.length ? (
          <div className="admin-table-wrap">
            <table className="data-table admin-table">
              <thead><tr><th scope="col">期間（から）</th><th scope="col">期間（まで）</th><th scope="col">集計した日時</th><th scope="col">担当</th><th scope="col">件数</th><th aria-label="操作" scope="col" /></tr></thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.auditLogId}>
                    <td>{formatDate(item.safePayload?.from)}</td>
                    <td>{formatDate(item.safePayload?.to)}</td>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{item.by}</td>
                    <td className="num">{item.safePayload?.visitCount ?? ""}{item.safePayload?.includeMemo ? <span className="muted small">（メモあり）</span> : null}</td>
                    <td className="admin-edit">
                      <button className="btn btn-ghost btn-sm" disabled={busy || !item.safePayload?.from} onClick={() => { const next = { from: item.safePayload.from, to: item.safePayload.to }; setRange(next); setIncludeMemo(Boolean(item.safePayload.includeMemo)); run(next, Boolean(item.safePayload.includeMemo)); }} type="button">もう一度集計</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty master-empty">まだ集計していません。</p>}
      </div>
    </section>
  );
}
