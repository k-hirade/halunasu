"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { APPOINTMENT_TRANSITIONS } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { AppointmentDialog } from "./appointment-dialog";
import { linkAppointmentToPatient, PatientRegisterDialog } from "./patient-register-dialog";
import {
  addDays,
  ageOn,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  minutesSince,
  SEX_LABELS,
  todayIso
} from "../lib/format";

const REFRESH_MS = 15000;
const IN_CLINIC = ["checked_in", "in_exam", "waiting_doctor", "in_consult", "checkout"];
const FINISHED = ["done", "cancelled", "no_show"];
// 散瞳の点眼から診察できるまでの目安（分）
const DILATION_READY_MINUTES = 20;
// 段階ごとの待ち時間の目安（分）。超えたら数字だけを黄 → 赤にする
const WAIT_THRESHOLDS = { checked_in: [15, 30], in_exam: [20, 40], dilating: [30, 45], waiting_doctor: [30, 60], checkout: [10, 20] };
// 一覧のまとまり。上の人数チップと同じ順に並べる
const GROUPS = [
  { key: "booked", label: "来院予定" },
  { key: "checked_in", label: "受付済" },
  { key: "in_exam", label: "検査中" },
  { key: "dilating", label: "散瞳中" },
  { key: "waiting_doctor", label: "診察待ち" },
  { key: "in_consult", label: "診察中" },
  { key: "checkout", label: "会計待ち" },
  { key: "finished", label: "終了・キャンセル" }
];
const LIST_ORDER = ["checked_in", "in_exam", "dilating", "waiting_doctor", "in_consult", "checkout", "booked", "finished"];
const UPCOMING_WINDOW_MINUTES = 60;
// 次へ進める操作。受付から会計までを1つずつ進める
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
  const [filter, setFilter] = useState(null);
  const [expanded, setExpanded] = useState({ finished: false, upcomingAll: false });

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

  // 登録した（または選んだ）患者を受付に紐づける。再試行でも最新の版を使う
  async function linkRegistering(patient) {
    const current = data.appointments.find((item) => item.appointmentId === registering.appointmentId) || registering;
    await linkAppointmentToPatient(api, current, patient);
    setRegistering(null);
    await load();
  }

  // 行を押したとき: 来院中でカルテがあれば開く。なければ患者のページへ（押しただけでカルテは作らない）
  function openRow(appointment) {
    if (!appointment.patientId) {
      if (canReceive) setRegistering(appointment);
      return;
    }
    const existing = data.encountersByPatient[appointment.patientId];
    router.push(existing ? `/encounters/${existing.encounterId}` : `/patients/${appointment.patientId}`);
  }

  const canReceive = Boolean(context?.canReceive);
  const isToday = date === todayIso();
  const appointments = data.appointments;
  const groupOf = (item) => {
    if (FINISHED.includes(item.status)) return "finished";
    const encounter = data.encountersByPatient[item.patientId];
    if (["checked_in", "in_exam", "waiting_doctor"].includes(item.status) && encounter?.dilationStartedAt
      && minutesSince(encounter.dilationStartedAt, now) < DILATION_READY_MINUTES) return "dilating";
    return item.status;
  };
  const waitOf = (item) => minutesSince(item.statusHistory?.at(-1)?.at, now);
  const grouped = Object.fromEntries(GROUPS.map((group) => [group.key, []]));
  for (const item of appointments) grouped[groupOf(item)]?.push(item);
  for (const key of Object.keys(grouped)) {
    grouped[key].sort(key === "booked" || key === "finished"
      ? (left, right) => String(left.time || "99").localeCompare(String(right.time || "99"))
      : (left, right) => (waitOf(right) ?? 0) - (waitOf(left) ?? 0));
  }
  const nowMinutes = Math.floor((now + 9 * 3600000) % 86400000 / 60000);
  const inUpcomingWindow = (item) => !isToday || !item.time || toMinutes(item.time) <= nowMinutes + UPCOMING_WINDOW_MINUTES;
  const inClinicCount = appointments.filter((item) => IN_CLINIC.includes(item.status)).length;

  function rowMenu(item) {
    const encounter = data.encountersByPatient[item.patientId];
    const previous = (APPOINTMENT_TRANSITIONS[item.status] || []).find((status) => IN_CLINIC.includes(status) && IN_CLINIC.indexOf(status) < IN_CLINIC.indexOf(item.status));
    const entries = [];
    if (item.patientId && ["checked_in", "in_exam"].includes(item.status)) entries.push(["検査入力", () => openChart(item, "exam")]);
    if (item.patientId && IN_CLINIC.includes(item.status)) entries.push([encounter ? "カルテを開く" : "カルテ作成", () => openChart(item)]);
    if (item.patientId) entries.push(["患者のページ", () => router.push(`/patients/${item.patientId}`)]);
    if (!item.patientId && canReceive) entries.push(["患者登録", () => setRegistering(item)]);
    if (canReceive && previous) entries.push([`${APPOINTMENT_STATUS_LABELS[previous]}に戻す`, () => move(item, previous)]);
    if (canReceive && item.status === "booked") {
      entries.push(["キャンセル", () => move(item, "cancelled")]);
      if (isToday) entries.push(["来院なし", () => move(item, "no_show")]);
    }
    if (canReceive && ["cancelled", "no_show"].includes(item.status)) entries.push(["予約に戻す", () => move(item, "booked")]);
    return entries;
  }

  function renderRow(item) {
    const group = groupOf(item);
    const encounter = data.encountersByPatient[item.patientId];
    const next = NEXT_ACTIONS[item.status];
    const showNext = canReceive && next && (item.status !== "booked" || isToday);
    const wait = IN_CLINIC.includes(item.status) ? waitOf(item) : null;
    const [warnAt, alertAt] = WAIT_THRESHOLDS[group] || [];
    const waitLevel = wait === null || !warnAt ? "" : wait >= alertAt ? " is-alert" : wait >= warnAt ? " is-warn" : "";
    const snapshot = item.patientSnapshot || {};
    const age = ageOn(snapshot.birthDate, item.date);
    const menu = rowMenu(item);
    return (
      <li className={`flow-row status-${group}`} key={item.appointmentId}>
        <button aria-label={`${item.patientName} を開く`} className="flow-row-open" onClick={() => openRow(item)} type="button" />
        <span className="flow-slot mono">{item.queueNumber && item.status !== "booked" ? `#${item.queueNumber}` : ""}</span>
        <span className="flow-time mono" title={item.status === "booked" ? "予約時刻" : "受付時刻"}>{item.status === "booked" ? item.time || "—" : formatClock(item.checkedInAt) || item.time || "—"}</span>
        <span className="flow-name">
          <strong>{item.patientName}</strong>
          {snapshot.displayNameKana ? <span className="flow-kana">{snapshot.displayNameKana}</span> : null}
          {!item.patientId ? <span className="tag tag-warn">未登録</span> : null}
        </span>
        <span className="flow-age">{age !== null ? `${age}${SEX_LABELS[snapshot.sex] && snapshot.sex !== "unknown" ? SEX_LABELS[snapshot.sex] : ""}` : ""}</span>
        <span className="flow-purpose">
          {item.purpose === "initial" ? <span className="flow-new">新</span> : null}
          {APPOINTMENT_PURPOSE_LABELS[item.purpose]}{item.note ? <span className="flow-note" title={item.note}><span className="flow-note-label">メモ</span>{item.note}</span> : null}
        </span>
        <span className="flow-progress">{progressOf(item, encounter, now)}</span>
        <span className={`flow-wait${waitLevel}`}>{wait === null ? "" : `${group === "in_exam" ? "検" : "待"} ${wait}分`}</span>
        <span className="flow-actions">
          {showNext ? <button className="btn btn-primary btn-sm" onClick={() => move(item, next.status)} type="button">{next.label}</button> : null}
          {menu.length ? (
            <details className="more-menu">
              <summary aria-label={`${item.patientName} のその他の操作`} className="btn btn-chip">…</summary>
              <div className="more-menu-list">
                {menu.map(([label, action]) => (
                  <button className="btn btn-ghost" key={label} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); action(); }} type="button">{label}</button>
                ))}
              </div>
            </details>
          ) : null}
        </span>
      </li>
    );
  }

  const visibleGroups = filter ? [filter] : LIST_ORDER;

  return (
    <main className="eye-page">
      <header className="page-head">
        <div>
          <h1>受付</h1>
          <p className="page-sub">{isToday ? "本日" : formatDate(date)}：予約 {appointments.filter((item) => item.status !== "cancelled").length}件 ・ 院内 {inClinicCount}人 ・ 終了 {appointments.filter((item) => item.status === "done").length}人</p>
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

      <div aria-label="段階ごとの人数（押すとその段階だけを表示）" className="flow-chips" role="group">
        <button aria-pressed={filter === null} className="flow-chip flow-chip-all" onClick={() => setFilter(null)} type="button">
          すべて<strong>{appointments.length}</strong>
        </button>
        {GROUPS.map((group) => (
          <button aria-pressed={filter === group.key} className={`flow-chip status-${group.key}`} key={group.key} onClick={() => setFilter(filter === group.key ? null : group.key)} type="button">
            <span className="flow-dot" aria-hidden="true" />{group.label}<strong>{grouped[group.key].length}</strong>
          </button>
        ))}
      </div>

      <section aria-label="予約・受付の一覧" className="panel flow-list">
        {appointments.length === 0 ? <p className="empty">この日の予約・受付はありません。</p> : null}
        {visibleGroups.map((key) => {
          const group = GROUPS.find((item) => item.key === key);
          const items = grouped[key];
          if (!items.length && !filter) return null;
          const collapsed = key === "finished" && !expanded.finished && !filter;
          // 来院予定は次の 60 分（遅れている人を含む）だけを出す。少ないときは先頭の 3 件までは出す
          const shown = key === "booked" && !expanded.upcomingAll && !filter ? items.slice(0, Math.max(items.filter(inUpcomingWindow).length, 3)) : items;
          const hidden = items.length - shown.length;
          return (
            <section aria-label={group.label} className={`flow-group status-${key}`} key={key}>
              <h2 className="flow-group-head">
                {key === "finished" ? (
                  <button aria-expanded={!collapsed} className="flow-group-toggle" onClick={() => setExpanded({ ...expanded, finished: !expanded.finished })} type="button">{collapsed ? "▶" : "▼"} {group.label}</button>
                ) : <span>{group.label}</span>}
                <span className="count">{items.length}</span>
                {key === "booked" && isToday && !filter ? <span className="muted small">次の{UPCOMING_WINDOW_MINUTES}分</span> : null}
              </h2>
              {collapsed ? null : items.length === 0 ? <p className="empty">該当する患者はいません。</p> : (
                <ul className="flow-rows">{shown.map(renderRow)}</ul>
              )}
              {!collapsed && hidden > 0 ? (
                <button className="btn btn-chip flow-more" onClick={() => setExpanded({ ...expanded, upcomingAll: true })} type="button">ほか {hidden}件を表示</button>
              ) : null}
            </section>
          );
        })}
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
        <PatientRegisterDialog
          initial={{ displayName: registering.patientName }}
          onCancel={() => setRegistering(null)}
          onCreated={linkRegistering}
          onPickExisting={linkRegistering}
          pickExistingLabel="この患者で受付"
          submitLabel="登録して受付に紐づける"
          title={`患者登録（受付 #${registering.queueNumber ?? "—"}）`}
        />
      ) : null}
    </main>
  );
}

// 検査の進み具合（視力・眼圧・オーダー）と散瞳。値そのものは出さず、済んだかどうかだけを出す
export function progressOf(appointment, encounter, now) {
  if (!IN_CLINIC.includes(appointment.status) || !encounter) return null;
  const chips = [
    ["視", encounter.exam?.va ? "done" : "todo"],
    ["圧", encounter.exam?.iop ? "done" : "todo"],
    ...(encounter.orders || []).map((order) => [order.name, order.status === "performed" ? "done" : "todo"])
  ];
  const dilation = encounter.dilationStartedAt ? minutesSince(encounter.dilationStartedAt, now) : null;
  return (
    <>
      {chips.map(([label, state], index) => (
        <span className={`flow-step is-${state}`} key={`${label}${index}`} title={`${label}: ${state === "done" ? "済" : "未"}`}>{label}{state === "done" ? "✓" : "・"}</span>
      ))}
      {dilation !== null ? (
        dilation >= DILATION_READY_MINUTES
          ? <span className="flow-dilation is-ready">散瞳OK</span>
          : (
            <span className="flow-dilation" title={`散瞳から ${dilation}分`}>
              散瞳 {dilation}/{DILATION_READY_MINUTES}分
              <span className="flow-dilation-bar" aria-hidden="true"><span style={{ width: `${Math.round((dilation / DILATION_READY_MINUTES) * 100)}%` }} /></span>
            </span>
          )
      ) : null}
    </>
  );
}

function toMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + (minutes || 0);
}

export function formatClock(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}
