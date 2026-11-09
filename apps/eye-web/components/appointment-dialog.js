"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookingCalendar } from "./booking-calendar";
import { useEyeApi } from "./eye-api";
import { formatDayButton } from "./mini-calendar";
import { DEFAULT_DEPARTMENTS, doctorName, useDoctors } from "./use-doctors";
import { APPOINTMENT_PURPOSE_LABELS, APPOINTMENT_STATUS_LABELS, patientLine, todayIso } from "../lib/format";

// 予約登録・受付登録・受付編集（デジカルの予約登録ダイアログと受付登録ダイアログ）。
// - 予約（walkIn なし）: 左にこの患者の予約一覧（✎ 編集・取消・カルテ）、右に予約フォーム（予約日＋予約状況・医師・診療科・目的・予約時間（空欄可）・受付メモ）。
// - 当日受付（walkIn）: 1 列のフォーム（受付日・患者・医師・診療科・目的・受付メモ）。
// - 編集（appointment を渡す）: 同じフォームで［更新］。
// 医師と診療科は、この患者の前回の受付の値を最初から入れる。患者が決まっていなければ検索するか、未登録の氏名だけで受け付ける。
export function AppointmentDialog({ title, initial = {}, fixedPatient = null, appointment: editing = null, onCancel, onSaved }) {
  const api = useEyeApi();
  const doctors = useDoctors();
  const [form, setForm] = useState(() => formFrom(editing, initial));
  const [editingItem, setEditingItem] = useState(editing);
  const [patient, setPatient] = useState(fixedPatient || (editing?.patientId ? snapshotPatient(editing) : null));
  const [query, setQuery] = useState(initial.patientName || "");
  const [candidates, setCandidates] = useState([]);
  const [history, setHistory] = useState({ patientId: "", items: [], loading: false });
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const touched = useRef({ doctor: Boolean(initial.doctorMemberId || editing), department: Boolean(initial.department || editing) });
  const walkIn = Boolean(form.walkIn) && !editingItem;
  // 来院済みの受付の編集（受付編集）は 1 列。予約の登録・編集は左に予約一覧を出す 2 列
  const twoPane = !walkIn && !(editing && editing.status !== "booked");

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape" || busy) return;
      if (calendarOpen) setCalendarOpen(false);
      else if (confirmCancel) setConfirmCancel(null);
      else onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, calendarOpen, confirmCancel, onCancel]);

  useEffect(() => {
    if (fixedPatient || patient || !query.trim()) {
      setCandidates([]);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: { q: query.trim() } })
        .then((payload) => { if (!cancelled) setCandidates(payload.patients.slice(0, 8)); })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, fixedPatient, patient, query]);

  // この患者の予約・受付（左の一覧と、医師・診療科の初期値）
  const patientId = patient?.patientId || "";
  async function loadHistory(id = patientId) {
    if (!id) {
      setHistory({ patientId: "", items: [], loading: false });
      return [];
    }
    setHistory((current) => ({ ...current, patientId: id, loading: true }));
    try {
      const payload = await api(`/v1/eye/appointments?patientId=${encodeURIComponent(id)}`);
      setHistory({ patientId: id, items: payload.appointments, loading: false });
      return payload.appointments;
    } catch {
      setHistory({ patientId: id, items: [], loading: false });
      return [];
    }
  }
  useEffect(() => {
    let alive = true;
    loadHistory().then((items) => {
      if (!alive || !items.length) return;
      const last = items.find((item) => item.doctorMemberId || item.department);
      if (!last) return;
      setForm((current) => ({
        ...current,
        doctorMemberId: touched.current.doctor || current.doctorMemberId ? current.doctorMemberId : last.doctorMemberId || "",
        department: touched.current.department || current.department ? current.department : last.department || ""
      }));
    });
    return () => { alive = false; };
    // 患者が変わったときだけ引き直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, patientId]);

  function startEdit(item) {
    setEditingItem(item);
    setForm(formFrom(item, {}));
    touched.current = { doctor: true, department: true };
    setError("");
  }

  function startNew() {
    setEditingItem(null);
    setForm(formFrom(null, { ...initial, walkIn: false, doctorMemberId: form.doctorMemberId, department: form.department }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let saved;
      if (editingItem) {
        const body = {
          expectedRevision: editingItem.revision,
          time: form.time,
          purpose: form.purpose,
          receptionMemo: form.note,
          doctorMemberId: form.doctorMemberId,
          department: form.department.trim()
        };
        if (editingItem.status === "booked") body.date = form.date;
        saved = (await api(`/v1/eye/appointments/${editingItem.appointmentId}`, { method: "PATCH", body })).appointment;
      } else {
        saved = (await api("/v1/eye/appointments", {
          method: "POST",
          body: {
            date: form.date,
            time: form.time,
            purpose: form.purpose,
            receptionMemo: form.note,
            doctorMemberId: form.doctorMemberId,
            department: form.department.trim(),
            walkIn: walkIn,
            ...(form.sourceEncounterId ? { sourceEncounterId: form.sourceEncounterId } : {}),
            patientId: patient?.patientId || "",
            patientName: patient ? "" : (form.patientName || query).trim()
          }
        })).appointment;
      }
      onSaved(saved);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  async function cancelAppointment(item) {
    setBusy(true);
    setError("");
    try {
      await api(`/v1/eye/appointments/${item.appointmentId}/status`, { method: "POST", body: { expectedRevision: item.revision, status: "cancelled" } });
      setConfirmCancel(null);
      if (editingItem?.appointmentId === item.appointmentId) startNew();
      await loadHistory();
    } catch (nextError) {
      setError(nextError.message);
      setConfirmCancel(null);
    } finally {
      setBusy(false);
    }
  }

  const unregisteredName = (form.patientName || query).trim();
  const departments = [...new Set([...DEFAULT_DEPARTMENTS, ...history.items.map((item) => item.department).filter(Boolean)])];
  const today = todayIso();
  const upcoming = history.items.filter((item) => item.status !== "cancelled");
  const submitLabel = editingItem ? "更新" : "登録";

  const formFields = (
    <>
      {walkIn || (editingItem && editingItem.status !== "booked") ? (
        <div className="ap-row">
          <span className="ap-label">受付日</span>
          <span className="ap-value">{formatDayButton(form.date)}</span>
        </div>
      ) : (
        <div className="ap-row">
          <label className="ap-label" htmlFor="ap-date">予約日</label>
          <div className="ap-value ap-date">
            <input className="input" id="ap-date" onChange={(event) => setForm({ ...form, date: event.target.value })} required type="date" value={form.date} />
            <button aria-expanded={calendarOpen} className="btn btn-ghost btn-sm" onClick={() => setCalendarOpen(true)} type="button">予約状況</button>
          </div>
        </div>
      )}
      <div className="ap-row">
        <span className="ap-label">患者</span>
        <div className="ap-value">
          {patient ? (
            <div className="picked-patient">
              <div>
                <strong>{patient.displayName}</strong>
                <span className="muted small"> {patientLine(patient)}</span>
              </div>
              {fixedPatient || editingItem ? null : <button className="btn btn-chip" onClick={() => setPatient(null)} type="button">変更</button>}
            </div>
          ) : editingItem ? (
            <strong>{editingItem.patientName}<span className="tag tag-warn">未登録</span></strong>
          ) : (
            <>
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
              {query.trim() && !candidates.length ? <span className="muted small">該当なし。「{query.trim()}」として未登録のまま登録し、あとで患者登録できます。</span> : null}
            </>
          )}
        </div>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-doctor">医師</label>
        <select className="input ap-value" id="ap-doctor" onChange={(event) => { touched.current.doctor = true; setForm({ ...form, doctorMemberId: event.target.value }); }} value={form.doctorMemberId}>
          <option value="">指定なし</option>
          {doctors.map((doctor) => <option key={doctor.memberId} value={doctor.memberId}>{doctor.displayName}</option>)}
          {form.doctorMemberId && !doctors.some((doctor) => doctor.memberId === form.doctorMemberId) ? <option value={form.doctorMemberId}>{doctorName(doctors, form.doctorMemberId)}</option> : null}
        </select>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-department">診療科</label>
        <input className="input ap-value" id="ap-department" list="ap-departments" maxLength={40} onChange={(event) => { touched.current.department = true; setForm({ ...form, department: event.target.value }); }} value={form.department} />
        <datalist id="ap-departments">{departments.map((name) => <option key={name} value={name} />)}</datalist>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-purpose">目的</label>
        <select className="input ap-value" id="ap-purpose" onChange={(event) => setForm({ ...form, purpose: event.target.value })} value={form.purpose}>
          {Object.entries(APPOINTMENT_PURPOSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-time">予約時間</label>
        <div className="ap-value ap-time">
          <input className="input" id="ap-time" onChange={(event) => setForm({ ...form, time: event.target.value })} step="300" type="time" value={form.time} />
          <span className="muted small">空欄でも登録できます</span>
        </div>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-memo">受付メモ</label>
        <textarea className="input ap-value" id="ap-memo" maxLength={1000} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="例: 視野検査あり・散瞳予定" rows={3} value={form.note} />
      </div>
    </>
  );

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="appointment-heading" aria-modal="true" className={`dialog ap-dialog${twoPane ? " is-two-pane" : ""}${calendarOpen ? " is-calendar" : ""}`} onSubmit={submit} role="dialog">
        <h2 id="appointment-heading">{editingItem && editingItem !== editing ? "予約の編集" : title}</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <div className="ap-body">
          {twoPane ? (
            <section aria-label="この患者の予約" className="ap-list">
              <div className="ap-list-head">
                <strong>予約一覧</strong>
                {patient ? <button aria-label="新しい予約" className="btn btn-ghost btn-sm" disabled={!editingItem} onClick={startNew} type="button">＋</button> : null}
              </div>
              {!patient ? <p className="muted small">患者を選ぶと、その人の予約が出ます。</p>
                : history.loading && history.patientId !== patientId ? <p className="muted small">読み込み中…</p>
                  : upcoming.length === 0 ? <p className="muted small">予約はありません。</p> : (
                    <ul className="ap-list-rows">
                      {upcoming.map((item) => (
                        <li className={`ap-list-row${item.date < today ? " is-past" : ""}${editingItem?.appointmentId === item.appointmentId ? " is-selected" : ""}`} key={item.appointmentId}>
                          <div className="ap-list-main">
                            <span className="mono">{item.date.replaceAll("-", "/")} {item.time || "時刻なし"}</span>
                            <span className="muted small">{APPOINTMENT_STATUS_LABELS[item.displayStatus || item.status]}{item.doctorMemberId ? ` ・ ${doctorName(doctors, item.doctorMemberId)}` : ""}</span>
                          </div>
                          <div className="ap-list-actions">
                            <button aria-label={`${item.date} の予約を編集`} className="btn btn-ghost btn-sm" onClick={() => startEdit(item)} type="button">✎</button>
                            {item.status === "booked" ? <button aria-label={`${item.date} の予約を取り消す`} className="btn btn-ghost btn-sm" onClick={() => setConfirmCancel(item)} type="button">取消</button> : null}
                            {patient ? <Link className="btn btn-ghost btn-sm" href={`/patients/${patient.patientId}`}>カルテ</Link> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
            </section>
          ) : null}
          <div className="ap-form">{formFields}</div>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || (!patient && !editingItem && !unregisteredName) || !form.date} type="submit">{submitLabel}</button>
        </div>

        {calendarOpen ? (
          <div className="ap-calendar" role="dialog" aria-label="予約状況">
            <div className="ap-calendar-head">
              <strong>予約状況</strong>
              <span className="muted small">枠を押すと予約日と予約時間に入ります</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setCalendarOpen(false)} type="button">閉じる</button>
            </div>
            <BookingCalendar date={form.date || today} onPickSlot={(date, time) => { setForm((current) => ({ ...current, date, time })); setCalendarOpen(false); }} />
          </div>
        ) : null}
        {confirmCancel ? (
          <div className="ap-confirm" role="alertdialog" aria-label="予約の取消">
            <p>{confirmCancel.date.replaceAll("-", "/")} {confirmCancel.time} の予約を取り消しますか。</p>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmCancel(null)} type="button">戻る</button>
              <button className="btn btn-danger" disabled={busy} onClick={() => cancelAppointment(confirmCancel)} type="button">取り消す</button>
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function formFrom(appointment, initial) {
  if (appointment) {
    return {
      date: appointment.date,
      time: appointment.time || "",
      purpose: appointment.purpose || "revisit",
      note: appointment.receptionMemo ?? appointment.note ?? "",
      doctorMemberId: appointment.doctorMemberId || "",
      department: appointment.department || "",
      walkIn: false,
      patientName: ""
    };
  }
  return {
    date: todayIso(),
    time: "",
    purpose: "revisit",
    doctorMemberId: "",
    department: "",
    patientName: "",
    ...initial,
    ...{ note: initial.note ?? initial.receptionMemo ?? "" }
  };
}

function snapshotPatient(appointment) {
  return { patientId: appointment.patientId, displayName: appointment.patientName, ...(appointment.patientSnapshot || {}) };
}
