"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { APPOINTMENT_TRANSITIONS } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { AppointmentDialog } from "./appointment-dialog";
import {
  addDays,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  minutesSince,
  todayIso
} from "../lib/format";

const REFRESH_MS = 15000;
const BOARD_COLUMNS = ["checked_in", "in_exam", "waiting_doctor", "in_consult", "checkout"];
// 次へ進める操作。受付から会計までを1つずつ進める。
const NEXT_ACTIONS = {
  booked: { status: "checked_in", label: "受付する" },
  checked_in: { status: "in_exam", label: "検査開始" },
  in_exam: { status: "waiting_doctor", label: "検査終了" },
  waiting_doctor: { status: "in_consult", label: "診察開始" },
  in_consult: { status: "checkout", label: "診察終了" },
  checkout: { status: "done", label: "会計済み" }
};

export function ReceptionWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState({ appointments: [], encountersByPatient: {} });
  const [context, setContext] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/appointments?date=${date}`);
    setData(payload);
    setNow(Date.now());
  }, [api, date]);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch((nextError) => setError(nextError.message));
  }, [api]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
    const handle = setInterval(() => { load().catch(() => {}); }, REFRESH_MS);
    return () => clearInterval(handle);
  }, [load]);

  async function move(appointment, status) {
    setError("");
    try {
      await api(`/v1/eye/appointments/${appointment.appointmentId}/status`, {
        method: "POST",
        body: { expectedRevision: appointment.revision, status }
      });
      await load();
    } catch (nextError) {
      setError(nextError.message);
      await load().catch(() => {});
    }
  }

  async function openChart(appointment) {
    const existing = data.encountersByPatient[appointment.patientId];
    if (existing) {
      router.push(`/encounters/${existing.encounterId}`);
      return;
    }
    try {
      const chart = await api(`/v1/eye/patients/${appointment.patientId}/chart`);
      const payload = await api("/v1/eye/encounters", {
        method: "POST",
        body: {
          patientId: appointment.patientId,
          encounterDate: appointment.date,
          visitType: chart.latestFinalized ? "revisit" : "initial"
        }
      });
      router.push(`/encounters/${payload.encounter.encounterId}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const canReceive = Boolean(context?.canReceive);
  const appointments = data.appointments;
  const booked = appointments.filter((item) => item.status === "booked");
  const finished = appointments.filter((item) => ["done", "cancelled", "no_show"].includes(item.status));
  const isToday = date === todayIso();

  return (
    <main className="eye-page">
      <header className="page-head">
        <div>
          <h1>受付</h1>
          <p className="page-sub">{isToday ? "本日" : formatDate(date)}：予約 {appointments.filter((item) => item.status !== "cancelled").length}件 ・ 院内 {appointments.filter((item) => BOARD_COLUMNS.includes(item.status)).length}人 ・ 終了 {appointments.filter((item) => item.status === "done").length}人</p>
        </div>
        <div className="head-actions">
          <div className="date-nav">
            <button aria-label="前日" className="btn btn-ghost" onClick={() => setDate(addDays(date, -1))} type="button">‹</button>
            <input aria-label="日付" className="input input-date" onChange={(event) => setDate(event.target.value || todayIso())} type="date" value={date} />
            <button aria-label="翌日" className="btn btn-ghost" onClick={() => setDate(addDays(date, 1))} type="button">›</button>
            {!isToday ? <button className="btn btn-ghost" onClick={() => setDate(todayIso())} type="button">今日</button> : null}
          </div>
          {canReceive ? (
            <>
              <button className="btn btn-ghost" onClick={() => setDialog({ walkIn: false })} type="button">予約を追加</button>
              {isToday ? <button className="btn btn-primary" onClick={() => setDialog({ walkIn: true })} type="button">当日受付</button> : null}
            </>
          ) : null}
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <section className="board" aria-label="院内の進捗">
        {BOARD_COLUMNS.map((status) => {
          const items = appointments.filter((item) => item.status === status);
          return (
            <div className={`board-column board-${status}`} key={status}>
              <h2>{APPOINTMENT_STATUS_LABELS[status]} <span className="count">{items.length}</span></h2>
              {items.map((item) => (
                <BoardCard
                  appointment={item}
                  canReceive={canReceive}
                  encounter={data.encountersByPatient[item.patientId]}
                  key={item.appointmentId}
                  now={now}
                  onMove={move}
                  onOpenChart={openChart}
                  onRegister={() => setRegistering(item)}
                />
              ))}
              {items.length === 0 ? <p className="board-empty">—</p> : null}
            </div>
          );
        })}
      </section>

      <div className="reception-lists">
        <section className="panel" aria-labelledby="booked-heading">
          <h2 id="booked-heading">未来院の予約 <span className="count">{booked.length}</span></h2>
          {booked.length === 0 ? <p className="empty">未来院の予約はありません。</p> : (
            <table className="data-table">
              <thead><tr><th>時刻</th><th>患者</th><th>目的</th><th>メモ</th><th /></tr></thead>
              <tbody>
                {booked.map((item) => (
                  <tr key={item.appointmentId}>
                    <td className="mono">{item.time || "—"}</td>
                    <td>{item.patientId ? <a href={`/patients/${item.patientId}`}>{item.patientName}</a> : <>{item.patientName} <span className="tag tag-warn">未登録</span></>}</td>
                    <td>{APPOINTMENT_PURPOSE_LABELS[item.purpose]}</td>
                    <td className="small">{item.note}</td>
                    <td>
                      {canReceive ? (
                        <div className="row-actions">
                          {isToday ? <button className="btn btn-primary btn-sm" onClick={() => move(item, "checked_in")} type="button">受付する</button> : null}
                          <button className="btn btn-chip" onClick={() => move(item, "cancelled")} type="button">キャンセル</button>
                          {isToday ? <button className="btn btn-chip" onClick={() => move(item, "no_show")} type="button">来院なし</button> : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="panel" aria-labelledby="finished-heading">
          <h2 id="finished-heading">終了・キャンセル <span className="count">{finished.length}</span></h2>
          {finished.length === 0 ? <p className="empty">まだありません。</p> : (
            <ul className="finished-list">
              {finished.map((item) => (
                <li key={item.appointmentId}>
                  <span className="mono small">{item.queueNumber ? `#${item.queueNumber}` : item.time || "—"}</span>
                  <span>{item.patientName}</span>
                  <span className={`tag ${item.status === "done" ? "tag-ok" : ""}`}>{APPOINTMENT_STATUS_LABELS[item.status]}</span>
                  {canReceive && item.status !== "done" ? (
                    <button className="btn btn-chip" onClick={() => move(item, "booked")} type="button">予約に戻す</button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dialog ? (
        <AppointmentDialog
          initial={{ date, walkIn: dialog.walkIn, purpose: "revisit", time: "" }}
          onCancel={() => setDialog(null)}
          onSaved={async () => { setDialog(null); await load(); }}
          title={dialog.walkIn ? "当日受付" : "予約を追加"}
        />
      ) : null}
      {registering ? (
        <RegisterDialog
          appointment={registering}
          onCancel={() => setRegistering(null)}
          onSaved={async () => { setRegistering(null); await load(); }}
        />
      ) : null}
    </main>
  );
}

function BoardCard({ appointment, canReceive, encounter, now, onMove, onOpenChart, onRegister }) {
  const next = NEXT_ACTIONS[appointment.status];
  const previous = (APPOINTMENT_TRANSITIONS[appointment.status] || []).find((status) => BOARD_COLUMNS.includes(status) && BOARD_COLUMNS.indexOf(status) < BOARD_COLUMNS.indexOf(appointment.status));
  const lastChange = appointment.statusHistory?.at(-1)?.at;
  const waited = minutesSince(lastChange, now);
  const sinceCheckIn = minutesSince(appointment.checkedInAt, now);
  return (
    <article className={`board-card${waited !== null && waited >= 30 ? " is-long" : ""}`}>
      <div className="board-card-head">
        <span className="queue-number">{appointment.queueNumber ?? "—"}</span>
        <div>
          <strong>{appointment.patientName}</strong>
          <div className="small muted">
            {APPOINTMENT_PURPOSE_LABELS[appointment.purpose]}
            {appointment.time ? ` ・ 予約 ${appointment.time}` : " ・ 予約なし"}
          </div>
        </div>
      </div>
      {appointment.note ? <p className="small board-note">{appointment.note}</p> : null}
      <p className="small muted">この状態で {waited ?? 0}分{sinceCheckIn !== null ? ` ・ 受付から ${sinceCheckIn}分` : ""}</p>
      <div className="board-actions">
        {canReceive && next ? <button className="btn btn-primary btn-sm" onClick={() => onMove(appointment, next.status)} type="button">{next.label}</button> : null}
        {appointment.patientId ? (
          <button className="btn btn-chip" onClick={() => onOpenChart(appointment)} type="button">{encounter ? "カルテを開く" : "カルテ作成"}</button>
        ) : canReceive ? (
          <button className="btn btn-chip" onClick={onRegister} type="button">患者登録</button>
        ) : null}
        {canReceive && previous ? <button className="btn btn-chip" onClick={() => onMove(appointment, previous)} type="button" aria-label={`${APPOINTMENT_STATUS_LABELS[previous]}に戻す`}>戻す</button> : null}
      </div>
    </article>
  );
}

function RegisterDialog({ appointment, onCancel, onSaved }) {
  const api = useEyeApi();
  const [draft, setDraft] = useState({ displayName: appointment.patientName, displayNameKana: "", birthDate: "", sex: "unknown", primaryPatientNumber: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const { patient } = await api("/v1/eye/patients", { method: "POST", body: draft });
      await api(`/v1/eye/appointments/${appointment.appointmentId}`, {
        method: "PATCH",
        body: { expectedRevision: appointment.revision, patientId: patient.patientId }
      });
      onSaved();
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="register-heading" className="dialog" onSubmit={submit} role="dialog">
        <h2 id="register-heading">患者登録（受付 #{appointment.queueNumber ?? "—"}）</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <label className="field"><span>氏名 <em>必須</em></span><input autoFocus className="input" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required value={draft.displayName} /></label>
        <label className="field"><span>フリガナ</span><input className="input" onChange={(event) => setDraft({ ...draft, displayNameKana: event.target.value })} value={draft.displayNameKana} /></label>
        <div className="field-row">
          <label className="field"><span>生年月日</span><input className="input" onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })} type="date" value={draft.birthDate} /></label>
          <label className="field">
            <span>性別</span>
            <select className="input" onChange={(event) => setDraft({ ...draft, sex: event.target.value })} value={draft.sex}>
              <option value="unknown">未設定</option><option value="male">男</option><option value="female">女</option><option value="other">その他</option>
            </select>
          </label>
        </div>
        <label className="field"><span>患者番号（カルテ番号）</span><input className="input" onChange={(event) => setDraft({ ...draft, primaryPatientNumber: event.target.value })} value={draft.primaryPatientNumber} /></label>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !draft.displayName.trim()} type="submit">登録して受付に紐づける</button>
        </div>
      </form>
    </div>
  );
}
