"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { formatDate, todayIso } from "../lib/format";
import { AUDIT_CATEGORY_LABELS, AUDIT_EVENT_LABELS, auditRangeFor, auditTargetLabel } from "../lib/settings";

const PAGE_SIZE = 100;
const RANGE_OPTIONS = [["today", "今日"], ["week", "7日間"], ["month", "30日間"], ["custom", "期間を指定"]];

function timeText(iso, withYear) {
  if (!iso) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${withYear ? `${parts.year}/` : ""}${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function AuditLogSection({ masters }) {
  const api = useEyeApi();
  const today = todayIso();
  const [rangePreset, setRangePreset] = useState("week");
  const [custom, setCustom] = useState(() => auditRangeFor("week", today));
  const [category, setCategory] = useState(null);
  const [actor, setActor] = useState("");
  const [patient, setPatient] = useState(null); // { patientId, displayName, primaryPatientNumber }
  const [patientQuery, setPatientQuery] = useState("");
  const [patientChoices, setPatientChoices] = useState(null);
  const [rows, setRows] = useState([]);
  const [patients, setPatients] = useState({});
  const [actors, setActors] = useState({});
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const range = auditRangeFor(rangePreset, today) || custom;
  const rangeValid = Boolean(range.from && range.to && range.from <= range.to);

  function query(cursor) {
    const params = new URLSearchParams({ from: range.from, to: range.to, limit: String(PAGE_SIZE) });
    if (category) params.set("category", category);
    if (actor) params.set("actor", actor);
    if (patient) params.set("patientId", patient.patientId);
    if (cursor) params.set("cursor", cursor);
    return `/v1/eye/audit-logs?${params}`;
  }

  async function load(cursor = "") {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const payload = await api(query(cursor));
      if (id !== requestId.current) return;
      setRows((current) => (cursor ? [...current, ...payload.auditLogs] : payload.auditLogs));
      setPatients((current) => ({ ...(cursor ? current : {}), ...(payload.patients || {}) }));
      setActors((current) => ({ ...current, ...(payload.actors || {}) }));
      setNextCursor(payload.nextCursor || null);
    } catch (nextError) {
      if (id === requestId.current) setError(nextError.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!rangeValid) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, category, actor, patient?.patientId, rangeValid]);

  async function findPatient(event) {
    event.preventDefault();
    const text = patientQuery.trim();
    if (!text) return;
    setPatientChoices(null);
    try {
      const { patients: found } = await api("/v1/eye/patients/search", { method: "POST", body: { q: text } });
      if (found.length === 1) choosePatient(found[0]);
      else setPatientChoices(found.slice(0, 8));
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  function choosePatient(item) {
    setPatient({ patientId: item.patientId, displayName: item.displayName, primaryPatientNumber: item.primaryPatientNumber || "" });
    setPatientChoices(null);
    setPatientQuery("");
  }

  const actorOptions = Object.entries(actors).sort(([, left], [, right]) => String(left.displayName).localeCompare(String(right.displayName), "ja"));
  const crossesYear = range.from.slice(0, 4) !== range.to.slice(0, 4) || range.to.slice(0, 4) !== today.slice(0, 4);

  return (
    <section aria-label="操作記録" className="settings-section">
      <header className="settings-section-head">
        <h2>操作記録</h2>
        <p className="muted">いつ・誰が・どの患者の記録を見たり変えたりしたかを確認します。</p>
      </header>

      <div className="audit-filters">
        <label className="audit-filter-field">
          <span>期間</span>
          <select aria-label="期間" className="input" onChange={(event) => {
            const next = event.target.value;
            if (next === "custom") setCustom(range);
            setRangePreset(next);
          }} value={rangePreset}>
            {RANGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {rangePreset === "custom" ? (
          <span className="audit-range-inputs">
            <input aria-label="開始日" className="input input-date" max={today} onChange={(event) => setCustom({ ...custom, from: event.target.value })} type="date" value={custom.from} />
            <span aria-hidden="true">〜</span>
            <input aria-label="終了日" className="input input-date" max={today} onChange={(event) => setCustom({ ...custom, to: event.target.value })} type="date" value={custom.to} />
          </span>
        ) : null}
        <label className="audit-filter-field">
          <span>担当</span>
          <select aria-label="担当" className="input" onChange={(event) => setActor(event.target.value)} value={actor}>
            <option value="">すべて</option>
            {actorOptions.map(([memberId, item]) => <option key={memberId} value={memberId}>{item.displayName}{item.loginId && item.loginId !== item.displayName ? `（${item.loginId}）` : ""}</option>)}
          </select>
        </label>
        {patient ? (
          <span className="audit-patient-chip">
            患者: <strong>{patient.displayName}</strong>{patient.primaryPatientNumber ? <span className="muted"> No.{patient.primaryPatientNumber}</span> : null}
            <button aria-label="患者の絞り込みを外す" className="audit-chip-clear" onClick={() => setPatient(null)} type="button">×</button>
          </span>
        ) : (
          <form className="audit-patient-search" onSubmit={findPatient} role="search">
            <input
              aria-label="患者で絞り込む"
              className="input"
              onChange={(event) => setPatientQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
              placeholder="患者名・患者番号"
              type="search"
              value={patientQuery}
            />
            <button className="btn btn-ghost" type="submit">絞る</button>
          </form>
        )}
      </div>
      {patientChoices ? (
        <div className="audit-patient-choices" role="group" aria-label="患者を選ぶ">
          {patientChoices.length === 0 ? <span className="muted">該当する患者がいません。</span> : patientChoices.map((item) => (
            <button className="btn btn-chip" key={item.patientId} onClick={() => choosePatient(item)} type="button">
              {item.displayName}{item.primaryPatientNumber ? ` No.${item.primaryPatientNumber}` : ""}{item.birthDate ? ` ${formatDate(item.birthDate)}生` : ""}
            </button>
          ))}
          <button className="btn btn-chip" onClick={() => setPatientChoices(null)} type="button">閉じる</button>
        </div>
      ) : null}

      <div aria-label="種類で絞り込む" className="flow-chips master-chips" role="group">
        <button aria-pressed={category === null} className="flow-chip" onClick={() => setCategory(null)} type="button">すべて</button>
        {Object.entries(AUDIT_CATEGORY_LABELS).map(([key, label]) => (
          <button aria-pressed={category === key} className="flow-chip" key={key} onClick={() => setCategory(category === key ? null : key)} type="button">{label}</button>
        ))}
      </div>

      <p className="audit-range-line" role="status">
        {!rangeValid ? "開始日と終了日を確認してください。" : (
          <>
            {range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} 〜 ${formatDate(range.to)}`}
            {" の記録 "}
            <strong>{rows.length}件</strong>
            {nextCursor ? "（続きがあります）" : ""}
            {loading ? " 読み込み中…" : ""}
          </>
        )}
      </p>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <div className="panel audit-panel">
        <table className="data-table audit-table">
          <thead>
            <tr><th>日時</th><th>操作</th><th>担当</th><th>患者</th><th>対象・内容</th></tr>
          </thead>
          <tbody>
            {rows.map((log) => {
              const person = log.patientId ? patients[log.patientId] : null;
              const who = actors[log.actorMemberId];
              const detail = auditTargetLabel(log, { ...masters, actors });
              return (
                <tr key={log.auditLogId}>
                  <td className="audit-time">{timeText(log.createdAt, crossesYear)}</td>
                  <td className="audit-event">{AUDIT_EVENT_LABELS[log.eventType] || "その他の操作"}</td>
                  <td className="audit-actor" title={log.actorLoginId}>{who?.displayName || log.actorLoginId || "—"}</td>
                  <td className="audit-patient">
                    {person ? (
                      <><Link href={`/patients/${log.patientId}`}>{person.displayName}</Link>{person.primaryPatientNumber ? <span className="muted small"> No.{person.primaryPatientNumber}</span> : null}</>
                    ) : log.patientId ? <span className="muted small">（不明な患者）</span> : <span className="muted">—</span>}
                  </td>
                  <td className={`audit-detail${detail ? "" : " is-empty"}`}>{detail || <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && rangeValid ? <tr><td className="empty" colSpan={5}>この条件の記録はありません。</td></tr> : null}
          </tbody>
        </table>
        {nextCursor ? (
          <div className="audit-more">
            <button className="btn btn-ghost" disabled={loading} onClick={() => load(nextCursor)} type="button">{loading ? "読み込み中…" : "さらに読み込む"}</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
