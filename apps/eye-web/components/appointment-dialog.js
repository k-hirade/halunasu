"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookingCalendar } from "./booking-calendar";
import { useEyeApi } from "./eye-api";
import { Modal } from "./modal";
import { PatientRegisterDialog } from "./patient-register-dialog";
import { formatDayButton } from "./mini-calendar";
import { useClinicSchedule } from "./use-clinic-hours";
import { DEFAULT_DEPARTMENTS, doctorName, useDoctors } from "./use-doctors";
import { ageOn, APPOINTMENT_PURPOSE_LABELS, APPOINTMENT_STATUS_LABELS, patientLine, SEX_LABELS, todayIso } from "../lib/format";
import { birthWithEra } from "../lib/reception-table";
import { outsideHoursNotice } from "../lib/booking-hours";
import { isImeKey } from "../lib/modal";
import { receptionPrintHref, registerInitialFromQuery } from "../lib/reception-extras";

// 予約登録・受付登録・受付編集（デジカルの予約登録ダイアログと受付登録ダイアログ）。
// - 予約（walkIn なし）: 左にこの患者の予約一覧（✎ 編集・取消・カルテ）、右に予約フォーム（予約日＋予約状況・医師・診療科・目的・予約時間（空欄可）・受付メモ）。
// - 当日受付（walkIn）: 1 列のフォーム（受付日・患者・医師・診療科・目的・受付メモ）。
// - 編集（appointment を渡す）: 同じフォームで［更新］。
// 医師と診療科は、この患者の前回の受付の値を最初から入れる。
// 予約は登録済みの患者だけ（検索して選ぶか、［新規患者登録］で登録してそのまま選ぶ）。未登録の氏名だけで受け付けられるのは当日受付だけ。
// 前に氏名だけで取った予約（未登録）を編集するときは、患者を選ぶか登録して紐づけるよう促す（紐づけずに更新もできる）。
export function AppointmentDialog({ title, initial = {}, fixedPatient = null, appointment: editing = null, onCancel, onSaved }) {
  const api = useEyeApi();
  const doctors = useDoctors();
  const schedule = useClinicSchedule();
  const [form, setForm] = useState(() => formFrom(editing, initial));
  const [editingItem, setEditingItem] = useState(editing);
  const [patient, setPatient] = useState(fixedPatient || (editing?.patientId ? snapshotPatient(editing) : null));
  const [query, setQuery] = useState(initial.patientName || (editing && !editing.patientId ? editing.patientName || "" : ""));
  // 新規患者登録（予約の患者欄から開く）
  const [registering, setRegistering] = useState(false);
  const [candidates, setCandidates] = useState([]);
  // 候補を引き終えた検索語と、候補があっても「別の人として登録」を選んだ氏名（同じ人の重複登録を防ぐ）
  const [searchedQuery, setSearchedQuery] = useState("");
  const [asNewName, setAsNewName] = useState("");
  const [history, setHistory] = useState({ patientId: "", items: [], loading: false });
  const [calendarOpen, setCalendarOpen] = useState(false);
  // 720px 以下で予約一覧を開いているか（広い画面では常に出す。CSS で切り替える）
  const [listOpen, setListOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 印刷（デジカルの「予約票」「受付メモを備考に印字する」、トプコンの受診票）。登録のあと別のタブで印刷画面を開く
  const [printSlip, setPrintSlip] = useState(false);
  const [printMemo, setPrintMemo] = useState(false);
  const touched = useRef({ doctor: Boolean(initial.doctorMemberId || editing), department: Boolean(initial.department || editing) });
  const walkIn = Boolean(form.walkIn) && !editingItem;
  // 氏名だけの予約（患者登録を必須にする前に取ったもの）の編集。患者を選ぶ・登録すると紐づける
  const linkingLegacy = Boolean(editingItem && !editingItem.patientId && editingItem.status === "booked" && !editingItem.walkIn);
  // 来院済みの受付の編集（受付編集）は 1 列。予約の登録・編集は左に予約一覧を出す 2 列
  const twoPane = !walkIn && !(editing && editing.status !== "booked");

  // 入力を 1 度でも変えたら dirty（Esc・背景で閉じる前に確かめる）
  const [edited, setEdited] = useState(false);
  // Esc は、開いている予約状況・取消の確認を先に閉じる（ダイアログは閉じない）
  const closeInnerOnEscape = (event) => {
    if (event.key !== "Escape" || isImeKey(event) || !(calendarOpen || confirmCancel)) return;
    event.preventDefault();
    if (busy) return;
    if (calendarOpen) setCalendarOpen(false);
    else setConfirmCancel(null);
  };

  useEffect(() => {
    if (fixedPatient || patient || !query.trim()) {
      setCandidates([]);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: { q: query.trim() } })
        .then((payload) => { if (!cancelled) { setCandidates(payload.patients.slice(0, 8)); setSearchedQuery(query.trim()); } })
        .catch(() => { if (!cancelled) { setCandidates([]); setSearchedQuery(query.trim()); } });
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
    // 印刷のタブは押した直後に開いておく（保存を待ってから開くとポップアップとして止められる）
    const printKind = !printSlip ? "" : walkIn || (editingItem && editingItem.status !== "booked") ? "visit" : "booking";
    const printWindow = printKind ? window.open("about:blank", "_blank") : null;
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
        if (linkingLegacy && patient) body.patientId = patient.patientId;
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
            patientName: patient || !walkIn ? "" : (form.patientName || query).trim()
          }
        })).appointment;
      }
      if (printWindow) printWindow.location.href = receptionPrintHref(saved.appointmentId, printKind, { memo: printKind === "booking" && printMemo });
      onSaved(saved);
    } catch (nextError) {
      printWindow?.close();
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
  // 未登録の氏名で登録できるのは、候補を引き終えて、候補が無いか「別の人として登録」を選んだときだけ
  const candidatesShown = !patient && (!editingItem || linkingLegacy) && Boolean(query.trim()) && candidates.length > 0;
  const unregisteredReady = Boolean(unregisteredName) && searchedQuery === query.trim() && (!candidatesShown || asNewName === query.trim());
  const departments = [...new Set([...DEFAULT_DEPARTMENTS, ...history.items.map((item) => item.department).filter(Boolean)])];
  const today = todayIso();
  const upcoming = history.items.filter((item) => item.status !== "cancelled");
  const submitLabel = editingItem ? "更新" : "登録";
  const submitHint = patient || editingItem ? undefined
    : !walkIn ? "予約は登録済みの患者で取ります。患者を選ぶか［新規患者登録］をしてください"
      : candidatesShown && asNewName !== query.trim() ? "候補から選ぶか「別の人として登録」を押してください" : undefined;

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
              {fixedPatient || (editingItem && !linkingLegacy) ? null : <button className="btn btn-chip" onClick={() => setPatient(null)} type="button">変更</button>}
            </div>
          ) : editingItem && !linkingLegacy ? (
            <strong>{editingItem.patientName}<span className="tag tag-warn">未登録</span></strong>
          ) : (
            <>
              {linkingLegacy ? (
                <p className="ap-link-note" role="status">
                  <strong>{editingItem.patientName}</strong><span className="tag tag-warn">未登録</span>
                  <span className="small">この予約は患者が未登録です。患者を選ぶか新規患者登録をすると、この予約に紐づけます。</span>
                </p>
              ) : null}
              <div className="ap-patient-search">
                <input
                  aria-label="患者を検索"
                  autoFocus
                  className="input"
                  onChange={(event) => { setQuery(event.target.value); setForm({ ...form, patientName: "" }); }}
                  placeholder="氏名・カナ・患者番号"
                  value={query}
                />
                {walkIn ? null : <button className="btn btn-ghost btn-sm" onClick={() => setRegistering(true)} type="button">新規患者登録</button>}
              </div>
              {query.trim() ? null : <span className="muted small ap-hint">{walkIn ? "未登録の患者は、氏名を入れるとそのまま登録できます。" : "予約は登録済みの患者で取ります。見つからないときは［新規患者登録］から登録してください。"}</span>}
              {candidates.length ? (
                <ul className="candidate-list">
                  {candidates.map((candidate) => (
                    <li key={candidate.patientId}>
                      <button className="candidate" onClick={() => setPatient(candidate)} type="button">
                        <strong>{candidate.displayName}</strong>
                        <span className="muted small">{candidate.displayNameKana} {candidateLine(candidate)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {walkIn && candidatesShown && asNewName !== query.trim() ? (
                <div className="ap-new-person">
                  <span className="muted small">同じ人がいれば選んでください。いなければ</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAsNewName(query.trim())} type="button">別の人として登録</button>
                </div>
              ) : null}
              {walkIn && candidatesShown && asNewName === query.trim() ? <span className="muted small">候補とは別の人として「{query.trim()}」を未登録のまま登録します。</span> : null}
              {walkIn && query.trim() && !candidates.length && searchedQuery === query.trim() ? <span className="muted small">該当なし。「{query.trim()}」として未登録のまま登録し、あとで患者登録できます。</span> : null}
              {!walkIn && query.trim() && !candidates.length && searchedQuery === query.trim() ? <span className="muted small">該当なし。［新規患者登録］から登録すると、そのまま予約できます。</span> : null}
              {!walkIn && candidatesShown ? <span className="muted small">候補から選んでください。いなければ［新規患者登録］から登録します。</span> : null}
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
          {/* 刻みは施設管理の予約枠（未設定は 5 分）。診療時間外・休診日は注意だけ出す（登録はできる） */}
          <input className="input" id="ap-time" onChange={(event) => setForm({ ...form, time: event.target.value })} step={schedule.configured ? schedule.slotMinutes * 60 : 300} type="time" value={form.time} />
          <span className="muted small">空欄でも登録できます</span>
          {!walkIn && outsideHoursNotice(schedule, form.date, form.time) ? <span className="ap-hours-note" role="status">{outsideHoursNotice(schedule, form.date, form.time)}</span> : null}
        </div>
      </div>
      <div className="ap-row">
        <label className="ap-label" htmlFor="ap-memo">受付メモ</label>
        <textarea className="input ap-value" id="ap-memo" maxLength={1000} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="例: 視野検査あり・散瞳予定" rows={4} value={form.note} />
      </div>
      <div className="ap-row ap-print-row">
        <span className="ap-label">印刷</span>
        <div className="ap-value ap-print">
          {walkIn || (editingItem && editingItem.status !== "booked") ? (
            <label className="ap-check"><input checked={printSlip} onChange={(event) => setPrintSlip(event.target.checked)} type="checkbox" />受付票を印刷する</label>
          ) : (
            <>
              <label className="ap-check"><input checked={printSlip} onChange={(event) => setPrintSlip(event.target.checked)} type="checkbox" />予約票を印刷する</label>
              <label className="ap-check"><input checked={printMemo} disabled={!printSlip} onChange={(event) => setPrintMemo(event.target.checked)} type="checkbox" />受付メモを備考に印字する</label>
            </>
          )}
        </div>
      </div>
      {walkIn ? <p className="muted small ap-insurance-note">保険・公費・資格確認はレセコンで入力します。</p> : null}
    </>
  );

  return (
    <>
    <Modal as="form" busy={busy} className={`dialog ap-dialog${twoPane ? " is-two-pane" : ""}${calendarOpen ? " is-calendar" : ""}`} dirty={edited} labelledBy="appointment-heading" onChange={() => setEdited(true)} onClose={onCancel} onKeyDown={closeInnerOnEscape} onSubmit={submit}>
      <h2 id="appointment-heading">{editingItem && editingItem !== editing ? "予約の編集" : title}</h2>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      <div className="ap-body">
        {twoPane ? (
          <section aria-label="この患者の予約" className={`ap-list${listOpen ? " is-open" : ""}`}>
            <div className="ap-list-head">
              <strong className="ap-list-title">予約一覧</strong>
              {/* 720px 以下は一覧をたたみ、フォームと［登録］を先に見せる */}
              <button aria-expanded={listOpen} className="btn btn-ghost btn-sm ap-list-toggle" onClick={() => setListOpen(!listOpen)} type="button">
                予約一覧{patient && upcoming.length ? `（${upcoming.length}件）` : ""} {listOpen ? "▴" : "▾"}
              </button>
              {patient ? <button aria-label="新しい予約" className="btn btn-ghost btn-sm" disabled={!editingItem} onClick={startNew} type="button">＋</button> : null}
            </div>
            <div className="ap-list-content">
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
            </div>
          </section>
        ) : null}
        <div className="ap-form">{formFields}</div>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
        <button className="btn btn-primary" disabled={busy || (!patient && !editingItem && !(walkIn && unregisteredReady)) || !form.date} title={submitHint} type="submit">{submitLabel}</button>
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
    </Modal>
    {registering ? (
      <PatientRegisterDialog
        initial={registerInitialFromQuery(query)}
        onCancel={() => setRegistering(false)}
        onCreated={(created) => { setRegistering(false); setPatient(created); setEdited(true); }}
        onPickExisting={(picked) => { setRegistering(false); setPatient(picked); setEdited(true); }}
        pickExistingLabel="この患者で予約"
        submitLabel="登録して予約へ"
        title="新規患者登録"
      />
    ) : null}
    </>
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

// 候補の 1 行: 患者番号・生年月日（和暦）・年齢・性別（同姓同名を見分ける）
function candidateLine(patient = {}) {
  const age = ageOn(patient.birthDate);
  return [
    patient.primaryPatientNumber ? `患者番号 ${patient.primaryPatientNumber}` : "",
    patient.birthDate ? birthWithEra(patient.birthDate) : "生年月日なし",
    age === null ? "" : `${age}歳`,
    patient.sex && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] || "" : ""
  ].filter(Boolean).join(" ・ ");
}
