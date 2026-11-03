"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { APPOINTMENT_TRANSITIONS } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { AppointmentDialog } from "./appointment-dialog";
import { useMediaQuery } from "./use-media-query";
import {
  addDays,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  minutesSince,
  todayIso
} from "../lib/format";

const REFRESH_MS = 15000;
const LIST_TABS = [["booked", "未来院"], ["finished", "終了・キャンセル"], ["all", "すべて"]];
const LIST_EMPTY = { booked: "未来院の予約はありません。", finished: "終了・キャンセルはまだありません。", all: "この日の予約・受付はありません。" };
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
  const [filter, setFilter] = useState("active");
  const [listTab, setListTab] = useState("booked");
  const wide = useMediaQuery("(min-width: 1024px)", true);

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

  async function openChart(appointment, view = "") {
    const suffix = view ? `/${view}` : "";
    const existing = data.encountersByPatient[appointment.patientId];
    if (existing) {
      router.push(`/encounters/${existing.encounterId}${suffix}`);
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
      router.push(`/encounters/${payload.encounter.encounterId}${suffix}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const canReceive = Boolean(context?.canReceive);
  const appointments = data.appointments;
  const booked = appointments.filter((item) => item.status === "booked");
  const finished = appointments.filter((item) => ["done", "cancelled", "no_show"].includes(item.status));
  const isToday = date === todayIso();
  const inHouse = appointments.filter((item) => BOARD_COLUMNS.includes(item.status));
  const filtered = filter === "active" ? inHouse : appointments.filter((item) => item.status === filter);

  function listItems(key) {
    if (key === "booked") return booked;
    if (key === "finished") return finished;
    return [...appointments].sort((left, right) => String(left.time || "99").localeCompare(String(right.time || "99")));
  }

  function rowActions(item) {
    if (!canReceive) return null;
    if (item.status === "booked") {
      return (
        <>
          {isToday ? <button className="btn btn-primary btn-sm" onClick={() => move(item, "checked_in")} type="button">受付する</button> : null}
          <details className="more-menu">
            <summary aria-label={`${item.patientName} のその他の操作`} className="btn btn-chip">…</summary>
            <div className="more-menu-list">
              <button className="btn btn-ghost" onClick={() => move(item, "cancelled")} type="button">キャンセル</button>
              {isToday ? <button className="btn btn-ghost" onClick={() => move(item, "no_show")} type="button">来院なし</button> : null}
            </div>
          </details>
        </>
      );
    }
    if (item.status === "cancelled" || item.status === "no_show") {
      return <button className="btn btn-chip" onClick={() => move(item, "booked")} type="button">予約に戻す</button>;
    }
    if (BOARD_COLUMNS.includes(item.status) && item.patientId) {
      return <button className="btn btn-chip" onClick={() => openChart(item)} type="button">{data.encountersByPatient[item.patientId] ? "カルテを開く" : "カルテ作成"}</button>;
    }
    return null;
  }

  function renderCard(item, showStatus = false) {
    return (
      <BoardCard
        appointment={item}
        canReceive={canReceive}
        encounter={data.encountersByPatient[item.patientId]}
        key={item.appointmentId}
        now={now}
        onMove={move}
        onOpenChart={openChart}
        onRegister={() => setRegistering(item)}
        showStatus={showStatus}
      />
    );
  }

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

      {wide ? (
        <section className="board" aria-label="院内の進捗">
          {BOARD_COLUMNS.map((status) => {
            const items = appointments.filter((item) => item.status === status);
            return (
              <div className={`board-column board-${status}${items.length ? "" : " is-empty"}`} key={status}>
                <h2>{APPOINTMENT_STATUS_LABELS[status]} <span className="count">{items.length}</span></h2>
                {items.map((item) => renderCard(item))}
                {items.length === 0 ? <p className="board-empty">なし</p> : null}
              </div>
            );
          })}
        </section>
      ) : (
        <section aria-label="院内の進捗" className="board-compact">
          <div className="status-tabs" role="tablist">
            {[["active", "院内すべて", inHouse.length], ...BOARD_COLUMNS.map((status) => [status, APPOINTMENT_STATUS_LABELS[status], appointments.filter((item) => item.status === status).length])].map(([key, label, count]) => (
              <button aria-selected={filter === key} className="status-tab" key={key} onClick={() => setFilter(key)} role="tab" type="button">
                {label} <span className="count">{count}</span>
              </button>
            ))}
          </div>
          {filtered.length === 0 ? <p className="empty">該当する患者はいません。</p> : (
            <div className="board-list">{filtered.map((item) => renderCard(item, true))}</div>
          )}
        </section>
      )}

      <section aria-label="予約・受付の一覧" className="panel list-panel">
        <div className="status-tabs" role="tablist">
          {LIST_TABS.map(([key, label]) => (
            <button aria-selected={listTab === key} className="status-tab" key={key} onClick={() => setListTab(key)} role="tab" type="button">
              {label} <span className="count">{listItems(key).length}</span>
            </button>
          ))}
        </div>
        {listItems(listTab).length === 0 ? (
          <p className="empty">{LIST_EMPTY[listTab]}</p>
        ) : (
          <ul className="upcoming-list">
            {listItems(listTab).map((item) => (
              <li className={`upcoming-row is-${item.status}`} key={item.appointmentId}>
                <span className="upcoming-time mono">{item.queueNumber && item.status !== "booked" ? `#${item.queueNumber}` : item.time || "—"}</span>
                <span className="upcoming-patient">
                  {item.patientId ? <Link href={`/patients/${item.patientId}`}>{item.patientName}</Link> : <>{item.patientName} <span className="tag tag-warn">未登録</span></>}
                  <span className="tag">{APPOINTMENT_PURPOSE_LABELS[item.purpose]}</span>
                  {item.status !== "booked" ? <span className={`tag appointment-${item.status}`}>{APPOINTMENT_STATUS_LABELS[item.status]}</span> : null}
                </span>
                <span className="upcoming-note small muted">{item.note}</span>
                <span className="row-actions">{rowActions(item)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

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

function BoardCard({ appointment, canReceive, encounter, now, onMove, onOpenChart, onRegister, showStatus = false }) {
  const next = NEXT_ACTIONS[appointment.status];
  const previous = (APPOINTMENT_TRANSITIONS[appointment.status] || []).find((status) => BOARD_COLUMNS.includes(status) && BOARD_COLUMNS.indexOf(status) < BOARD_COLUMNS.indexOf(appointment.status));
  const lastChange = appointment.statusHistory?.at(-1)?.at;
  const waited = minutesSince(lastChange, now);
  const sinceCheckIn = minutesSince(appointment.checkedInAt, now);
  return (
    <article className={`board-card${waited !== null && waited >= 30 ? " is-long" : ""}`}>
      <div className="board-card-head">
        <span className="queue-number">{appointment.queueNumber ?? "—"}</span>
        <div className="board-card-title">
          <strong className="board-card-name">{appointment.patientName}</strong>
          <div className="small muted">
            {showStatus ? <span className="tag">{APPOINTMENT_STATUS_LABELS[appointment.status]}</span> : null}{" "}
            {APPOINTMENT_PURPOSE_LABELS[appointment.purpose]}
            {appointment.time ? ` ・ 予約 ${appointment.time}` : " ・ 予約なし"}
          </div>
        </div>
      </div>
      {appointment.note ? <p className="small board-note">{appointment.note}</p> : null}
      <p className="small muted">この状態で {waited ?? 0}分{sinceCheckIn !== null ? ` ・ 受付から ${sinceCheckIn}分` : ""}</p>
      {encounter?.dilationStartedAt ? (
        <p className={`small dilation-timer${minutesSince(encounter.dilationStartedAt, now) >= 20 ? " is-ready" : ""}`}>散瞳 {minutesSince(encounter.dilationStartedAt, now)}分</p>
      ) : null}
      {encounter?.plannedOrders?.length ? <p className="small muted">未実施: {encounter.plannedOrders.join("、")}</p> : null}
      <div className="board-actions">
        {canReceive && next ? <button className="btn btn-primary btn-sm" onClick={() => onMove(appointment, next.status)} type="button">{next.label}</button> : null}
        {appointment.patientId && ["checked_in", "in_exam"].includes(appointment.status) ? (
          <button className="btn btn-chip" onClick={() => onOpenChart(appointment, "exam")} type="button">検査入力</button>
        ) : null}
        {appointment.patientId ? (
          <button className="btn btn-chip" onClick={() => onOpenChart(appointment)} type="button">{encounter ? "カルテを開く" : "カルテ作成"}</button>
        ) : canReceive ? (
          <button className="btn btn-chip" onClick={onRegister} type="button">患者登録</button>
        ) : null}
        {canReceive && previous ? <button className="btn btn-chip board-back" onClick={() => onMove(appointment, previous)} type="button" aria-label={`${APPOINTMENT_STATUS_LABELS[previous]}に戻す`}>戻す</button> : null}
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
