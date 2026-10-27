"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { APPOINTMENT_PURPOSE_LABELS, patientLine } from "../lib/format";

// 予約の登録（当日受付を含む）。患者が決まっていなければ検索するか、未登録の氏名だけで受け付ける。
export function AppointmentDialog({ title, initial, fixedPatient = null, onCancel, onSaved }) {
  const api = useEyeApi();
  const [form, setForm] = useState({ time: "", purpose: "revisit", note: "", patientName: "", ...initial });
  const [patient, setPatient] = useState(fixedPatient);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (fixedPatient || patient || !query.trim()) {
      setCandidates([]);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api(`/v1/eye/patients?q=${encodeURIComponent(query.trim())}`)
        .then((payload) => { if (!cancelled) setCandidates(payload.patients.slice(0, 8)); })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, fixedPatient, patient, query]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/appointments", {
        method: "POST",
        body: {
          ...form,
          patientId: patient?.patientId || "",
          patientName: patient ? "" : (form.patientName || query).trim()
        }
      });
      onSaved(payload.appointment);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  const unregisteredName = (form.patientName || query).trim();

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="appointment-heading" className="dialog" onSubmit={submit} role="dialog">
        <h2 id="appointment-heading">{title}</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {patient ? (
          <div className="picked-patient">
            <div>
              <strong>{patient.displayName}</strong>
              <span className="muted small"> {patientLine(patient)}</span>
            </div>
            {fixedPatient ? null : <button className="btn btn-chip" onClick={() => setPatient(null)} type="button">変更</button>}
          </div>
        ) : (
          <div className="field">
            <span>患者</span>
            <input
              aria-label="患者を検索"
              autoFocus
              className="input"
              onChange={(event) => { setQuery(event.target.value); setForm({ ...form, patientName: "" }); }}
              placeholder="氏名・カナ・患者番号で検索（未登録なら氏名を入力）"
              value={query}
            />
            {candidates.length ? (
              <ul className="candidate-list">
                {candidates.map((candidate) => (
                  <li key={candidate.patientId}>
                    <button className="candidate" onClick={() => setPatient(candidate)} type="button">
                      <strong>{candidate.displayName}</strong>
                      <span className="muted small">{candidate.displayNameKana} {patientLine(candidate)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {query.trim() && !candidates.length ? <span className="muted small">該当なし。「{query.trim()}」として未登録のまま受け付け、あとで患者登録できます。</span> : null}
          </div>
        )}
        <div className="field-row">
          <label className="field">
            <span>日付</span>
            <input className="input" onChange={(event) => setForm({ ...form, date: event.target.value })} required type="date" value={form.date} />
          </label>
          <label className="field">
            <span>時刻{form.walkIn ? "（任意）" : ""}</span>
            <input className="input" onChange={(event) => setForm({ ...form, time: event.target.value })} step="300" type="time" value={form.time} />
          </label>
        </div>
        <label className="field">
          <span>目的</span>
          <select className="input" onChange={(event) => setForm({ ...form, purpose: event.target.value })} value={form.purpose}>
            {Object.entries(APPOINTMENT_PURPOSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>メモ</span>
          <input className="input" onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="例: 視野検査あり・散瞳予定" value={form.note} />
        </label>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || (!patient && !unregisteredName) || !form.date} type="submit">
            {form.walkIn ? "受け付ける" : "予約する"}
          </button>
        </div>
      </form>
    </div>
  );
}
