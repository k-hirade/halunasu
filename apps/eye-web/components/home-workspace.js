"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { linkAppointmentToPatient, PatientRegisterDialog } from "./patient-register-dialog";
import { formatClock, progressOf } from "./reception-workspace";
import {
  CONSULT_REFRESH_MS,
  CONSULT_STAGES,
  consultStageOf,
  flowGroupOf,
  publishWaitingCount
} from "../lib/consult-flow";
import {
  ageOn,
  APPOINTMENT_PURPOSE_LABELS,
  formatDate,
  minutesSince,
  SEX_LABELS,
  todayIso,
  VISIT_TYPE_LABELS
} from "../lib/format";

// 待ち時間の目安（分）。超えたら数字だけを黄 → 赤にする（受付と同じ値）
const WAIT_THRESHOLDS = { checked_in: [15, 30], in_exam: [20, 40], dilating: [30, 45], waiting_doctor: [30, 60] };
// 要対応の一覧は 4 回に 1 回（約 1 分ごと）だけ取り直す
const WORKLIST_EVERY = 4;
const TASKS = [
  { key: "drafts", label: "未確定カルテ", count: "draftEncounters" },
  { key: "papers", label: "要約未確認", count: "unreviewedPaperCharts" },
  { key: "documents", label: "文書の下書き", count: "draftDocuments" }
];
const DOCUMENT_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };
const UPCOMING_PREVIEW = 3;

// 診察（医師・視能訓練士の作業場）: 次に診る人と、患者をまたいだやり残し。
export function HomeWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const [data, setData] = useState({ appointments: [], encountersByPatient: {} });
  const [encounters, setEncounters] = useState([]);
  const [worklist, setWorklist] = useState(null);
  const [context, setContext] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState(null);
  const [showBooked, setShowBooked] = useState(false);
  const [registering, setRegistering] = useState(null);
  const [busyId, setBusyId] = useState("");
  const tickRef = useRef(0);
  const date = todayIso();
  const canWrite = Boolean(context?.canWrite);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch((nextError) => setError(nextError.message));
  }, [api]);

  const load = useCallback(async () => {
    const day = todayIso();
    const [appointmentPayload, encounterPayload] = await Promise.all([
      api(`/v1/eye/appointments?date=${day}`),
      api(`/v1/eye/encounters?date=${day}`)
    ]);
    const at = Date.now();
    setData(appointmentPayload);
    setEncounters(encounterPayload.encounters || []);
    setNow(at);
    setLoaded(true);
    publishWaitingCount(appointmentPayload.appointments.filter((item) => consultStageOf(item, appointmentPayload.encountersByPatient, at) === "waiting").length);
  }, [api]);

  const loadWorklist = useCallback(async () => {
    setWorklist(await api("/v1/eye/worklist"));
  }, [api]);

  // 15 秒ごとに更新（受付と同じ）。タブが見えていない間は止め、戻ったらすぐ取り直す
  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
    const handle = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load().catch(() => {});
    }, CONSULT_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load().catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(handle); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  useEffect(() => {
    if (!canWrite) return undefined;
    loadWorklist().catch(() => setWorklist(null));
    const handle = setInterval(() => {
      tickRef.current += 1;
      if (document.visibilityState === "hidden" || tickRef.current % WORKLIST_EVERY) return;
      loadWorklist().catch(() => {});
    }, CONSULT_REFRESH_MS);
    return () => clearInterval(handle);
  }, [canWrite, loadWorklist]);

  async function startConsult(item) {
    setError("");
    setBusyId(item.appointmentId);
    try {
      await api(`/v1/eye/appointments/${item.appointmentId}/status`, {
        method: "POST",
        body: { expectedRevision: item.revision, status: "in_consult" }
      });
      await openChart(item);
    } catch (nextError) {
      setError(nextError.message);
      await load().catch(() => {});
    } finally {
      setBusyId("");
    }
  }

  // カルテがあれば開く。なければ作ってから開く（診察開始・カルテを開く から）
  async function openChart(item, view = "") {
    const suffix = view ? `/${view}` : "";
    const existing = data.encountersByPatient[item.patientId];
    if (existing) {
      router.push(`/encounters/${existing.encounterId}${suffix}`);
      return;
    }
    const chart = await api(`/v1/eye/patients/${item.patientId}/chart`);
    const payload = await api("/v1/eye/encounters", {
      method: "POST",
      body: { patientId: item.patientId, encounterDate: item.date, visitType: chart.latestFinalized ? "revisit" : "initial" }
    });
    router.push(`/encounters/${payload.encounter.encounterId}${suffix}`);
  }

  async function run(action) {
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  // 行を押したとき: カルテがあれば開く。なければ患者のページへ（押しただけではカルテを作らない）
  function openRow(item) {
    if (!item.patientId) {
      if (context?.canRegisterPatients && context?.canReceive) setRegistering(item);
      return;
    }
    const existing = data.encountersByPatient[item.patientId];
    router.push(existing ? `/encounters/${existing.encounterId}` : `/patients/${item.patientId}`);
  }

  async function linkRegistering(patient) {
    const current = data.appointments.find((item) => item.appointmentId === registering.appointmentId) || registering;
    await linkAppointmentToPatient(api, current, patient);
    setRegistering(null);
    await load();
  }

  const appointments = data.appointments;
  const waitOf = (item) => minutesSince(item.statusHistory?.at(-1)?.at, now);
  const stages = Object.fromEntries(CONSULT_STAGES.map((stage) => [stage.key, []]));
  for (const item of appointments) {
    const stage = consultStageOf(item, data.encountersByPatient, now);
    if (stage) stages[stage].push(item);
  }
  for (const [key, items] of Object.entries(stages)) {
    items.sort(key === "booked"
      ? (left, right) => String(left.time || "99").localeCompare(String(right.time || "99"))
      : (left, right) => (waitOf(right) ?? 0) - (waitOf(left) ?? 0));
  }
  const linkedPatients = new Set(appointments.filter((item) => !["cancelled", "no_show"].includes(item.status)).map((item) => item.patientId).filter(Boolean));
  const unlinked = encounters.filter((encounter) => !linkedPatients.has(encounter.patientId));
  const inClinic = appointments.filter((item) => ["checked_in", "in_exam", "waiting_doctor", "in_consult", "checkout"].includes(item.status)).length;

  function rowMenu(item) {
    const encounter = data.encountersByPatient[item.patientId];
    const entries = [];
    if (!item.patientId) {
      if (context?.canRegisterPatients && context?.canReceive) entries.push(["患者登録", () => setRegistering(item)]);
      return entries;
    }
    if (canWrite && ["checked_in", "in_exam"].includes(item.status)) entries.push(["検査入力", () => run(() => openChart(item, "exam"))]);
    if (encounter) entries.push(["カルテを開く", () => router.push(`/encounters/${encounter.encounterId}`)]);
    else if (canWrite && item.status !== "booked") entries.push(["カルテ作成", () => run(() => openChart(item))]);
    entries.push(["患者のページ", () => router.push(`/patients/${item.patientId}`)]);
    entries.push(["受付で見る", () => router.push("/reception")]);
    return entries;
  }

  function primaryAction(item, stage) {
    if (!item.patientId) return null;
    const encounter = data.encountersByPatient[item.patientId];
    if (stage === "waiting" && context?.canReceive && canWrite) {
      return <button className="btn btn-primary btn-sm" disabled={busyId === item.appointmentId} onClick={() => startConsult(item)} type="button">診察開始</button>;
    }
    if ((stage === "waiting" || stage === "consult") && (encounter || canWrite)) {
      return <button className={`btn btn-sm ${stage === "consult" ? "btn-primary" : "btn-ghost"}`} onClick={() => run(() => openChart(item))} type="button">カルテを開く</button>;
    }
    return null;
  }

  function renderRow(item, stage) {
    const group = flowGroupOf(item, data.encountersByPatient, now);
    const encounter = data.encountersByPatient[item.patientId];
    const snapshot = item.patientSnapshot || {};
    const age = ageOn(snapshot.birthDate, item.date);
    const wait = stage === "booked" ? null : waitOf(item);
    const [warnAt, alertAt] = WAIT_THRESHOLDS[group] || [];
    const waitLevel = wait === null || !warnAt ? "" : wait >= alertAt ? " is-alert" : wait >= warnAt ? " is-warn" : "";
    const waitPrefix = group === "in_exam" ? "検" : group === "in_consult" ? "診" : "待";
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
        <span className="flow-age">{age !== null ? `${age}${snapshot.sex && snapshot.sex !== "unknown" ? SEX_LABELS[snapshot.sex] || "" : ""}` : ""}</span>
        <span className="flow-purpose">
          {item.purpose === "initial" ? <span className="flow-new">新</span> : null}
          {APPOINTMENT_PURPOSE_LABELS[item.purpose]}{item.note ? <span className="flow-note" title={item.note}><span className="flow-note-label">メモ</span>{item.note}</span> : null}
        </span>
        <span className="flow-progress">
          {stage === "consult" && encounter ? <span className="consult-chart-state">{encounter.status === "finalized" ? "確定済み" : "下書き"}</span> : progressOf(item, encounter, now)}
        </span>
        <span className={`flow-wait${waitLevel}`}>{wait === null ? "" : `${waitPrefix} ${wait}分`}</span>
        <span className="flow-actions">
          {primaryAction(item, stage)}
          {menu.length ? <RowMenu entries={menu} label={item.patientName} /> : null}
        </span>
      </li>
    );
  }

  function renderUnlinked(encounter) {
    const snapshot = encounter.patientSnapshot || {};
    const age = ageOn(snapshot.birthDate, encounter.encounterDate);
    return (
      <li className={`flow-row ${encounter.status === "finalized" ? "status-finished" : "status-task"}`} key={encounter.encounterId}>
        <Link aria-label={`${snapshot.displayName} のカルテを開く`} className="flow-row-open" href={`/encounters/${encounter.encounterId}`} />
        <span className="flow-slot" />
        <span className="flow-time mono">—</span>
        <span className="flow-name"><strong>{snapshot.displayName}</strong>{snapshot.displayNameKana ? <span className="flow-kana">{snapshot.displayNameKana}</span> : null}</span>
        <span className="flow-age">{age !== null ? `${age}${snapshot.sex && snapshot.sex !== "unknown" ? SEX_LABELS[snapshot.sex] || "" : ""}` : ""}</span>
        <span className="flow-purpose">{VISIT_TYPE_LABELS[encounter.visitType] || ""}</span>
        <span className="flow-progress"><span className="consult-chart-state">{encounter.status === "finalized" ? "確定済み" : encounter.amending ? "修正中" : "下書き"}</span></span>
        <span className="flow-wait" />
        <span className="flow-actions"><Link className="btn btn-ghost btn-sm" href={`/encounters/${encounter.encounterId}`}>カルテを開く</Link></span>
      </li>
    );
  }

  function renderTaskRow({ key, href, date: rowDate, name, kana, state, detail, action }) {
    return (
      <li className="flow-row status-task" key={key}>
        <Link aria-label={`${name} の${action}`} className="flow-row-open" href={href} />
        <span className="flow-slot" />
        <span className="flow-time mono">{rowDate ? shortDate(rowDate) : "—"}</span>
        <span className="flow-name"><strong>{name || "（氏名なし）"}</strong>{kana ? <span className="flow-kana">{kana}</span> : null}</span>
        <span className="flow-age" />
        <span className="flow-purpose"><span className="consult-chart-state">{state}</span>{detail ? <span className="flow-note">{detail}</span> : null}</span>
        <span className="flow-progress" />
        <span className="flow-wait" />
        <span className="flow-actions"><Link className="btn btn-ghost btn-sm" href={href}>{action}</Link></span>
      </li>
    );
  }

  function renderTask(key) {
    const task = TASKS.find((item) => item.key === key);
    if (!worklist) return <p className="empty">読み込み中…</p>;
    let rows = [];
    if (key === "drafts") {
      rows = worklist.draftEncounters.map((item) => renderTaskRow({
        key: item.encounterId,
        href: `/encounters/${item.encounterId}`,
        date: item.encounterDate,
        name: item.patientName,
        kana: item.patientNameKana,
        state: item.amending ? "修正中" : "下書き",
        detail: [item.updatedAt ? `最終保存 ${savedAt(item.updatedAt, date)}` : "", item.updatedBy].filter(Boolean).join(" "),
        action: "カルテを開く"
      }));
    } else if (key === "papers") {
      rows = worklist.unreviewedPaperCharts.map((item) => renderTaskRow({
        key: item.fileId,
        href: `/patients/${item.patientId}`,
        date: item.takenOn,
        name: item.patientName,
        kana: item.patientNameKana,
        state: item.hasSummary ? "要約あり・未確認" : "要約なし",
        detail: "",
        action: "患者のページ"
      }));
    } else {
      rows = worklist.draftDocuments.map((item) => renderTaskRow({
        key: item.documentId,
        href: `/documents/${item.documentId}`,
        date: item.issueDate,
        name: item.patientName,
        kana: item.patientNameKana,
        state: DOCUMENT_TYPE_LABELS[item.type] || "文書",
        detail: item.updatedAt ? `最終保存 ${savedAt(item.updatedAt, date)}` : "",
        action: "文書を開く"
      }));
    }
    const total = worklist.counts[task.count];
    return (
      <section aria-label={task.label} className="flow-group status-task">
        <h2 className="flow-group-head">
          <span>{task.label}</span><span className="count">{total}</span>
          {total > rows.length ? <span className="muted small">新しい順に {rows.length}件を表示</span> : null}
        </h2>
        {rows.length ? <ul className="flow-rows">{rows}</ul> : <p className="empty">ありません。</p>}
      </section>
    );
  }

  const upcoming = stages.booked;
  const visible = filter && !filter.startsWith("task:") ? [filter] : ["waiting", "consult", "soon", "booked"];
  const taskFilter = filter?.startsWith("task:") ? filter.slice(5) : null;
  const toggle = (key) => setFilter(filter === key ? null : key);
  const totalShown = stages.waiting.length + stages.consult.length + stages.soon.length + stages.booked.length;

  return (
    <main className="eye-page consult-page">
      <header className="page-head">
        <div>
          <h1>診察</h1>
          <p className="page-sub">
            {formatToday(date)}　診察待ち {stages.waiting.length} ・ 診察中 {stages.consult.length} ・ 院内 {inClinic}
          </p>
        </div>
        <div className="head-actions">
          {context?.canRegisterPatients ? <button className="btn btn-ghost btn-sm" onClick={() => setRegistering({})} type="button">新規患者</button> : null}
          <Link className="btn btn-ghost btn-sm" href="/reception">受付の一覧を開く</Link>
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <div aria-label="段階ごとの人数と要対応（押すとその一覧だけを表示）" className="flow-chips consult-chips" role="group">
        <button aria-pressed={filter === null} className="flow-chip flow-chip-all" onClick={() => setFilter(null)} type="button">
          すべて<strong>{totalShown}</strong>
        </button>
        {CONSULT_STAGES.map((stage) => (
          <button aria-pressed={filter === stage.key} className={`flow-chip status-${stage.status}`} key={stage.key} onClick={() => toggle(stage.key)} type="button">
            <span className="flow-dot" aria-hidden="true" />{stage.label}<strong>{stages[stage.key].length}</strong>
          </button>
        ))}
        {canWrite ? (
          <>
            <span aria-hidden="true" className="consult-chip-divider" />
            {TASKS.map((task) => {
              const count = worklist ? worklist.counts[task.count] : null;
              return (
                <button
                  aria-pressed={filter === `task:${task.key}`}
                  className={`flow-chip consult-task-chip${count ? " has-items" : ""}`}
                  key={task.key}
                  onClick={() => toggle(`task:${task.key}`)}
                  type="button"
                >
                  {task.label}<strong>{count === null ? "…" : `${count}${worklist.truncated && count ? "+" : ""}`}</strong>
                </button>
              );
            })}
          </>
        ) : null}
      </div>

      <section aria-label={taskFilter ? "要対応の一覧" : "診察の一覧"} className="panel flow-list">
        {taskFilter ? renderTask(taskFilter) : (
          <>
            {!loaded ? <p className="empty">読み込み中…</p> : null}
            {loaded && appointments.length === 0 && unlinked.length === 0 ? (
              <p className="empty">本日の予約・受付はまだありません。受付で当日受付するか、上の検索（<kbd>/</kbd>）から患者を開きます。</p>
            ) : null}
            {loaded ? visible.map((key) => {
              const stage = CONSULT_STAGES.find((item) => item.key === key);
              const items = stages[key];
              if (!items.length && !filter) return null;
              if (key === "booked" && !filter) {
                return (
                  <section aria-label={stage.label} className="flow-group status-booked" key={key}>
                    <h2 className="flow-group-head">
                      <button aria-expanded={showBooked} className="flow-group-toggle" onClick={() => setShowBooked(!showBooked)} type="button">{showBooked ? "▼" : "▶"} {stage.label}</button>
                      <span className="count">{items.length}</span>
                      {!showBooked ? (
                        <span className="consult-upcoming muted">
                          次: {items.slice(0, UPCOMING_PREVIEW).map((item) => `${item.time || "時刻なし"} ${item.patientName}${item.patientId ? "" : "（未登録）"}`).join("　")}
                        </span>
                      ) : null}
                    </h2>
                    {showBooked ? <ul className="flow-rows">{items.map((item) => renderRow(item, key))}</ul> : null}
                  </section>
                );
              }
              return (
                <section aria-label={stage.label} className={`flow-group status-${stage.status}`} key={key}>
                  <h2 className="flow-group-head">
                    <span>{stage.label}</span><span className="count">{items.length}</span>
                    {key === "soon" ? <span className="muted small">受付済・検査中・散瞳中</span> : null}
                  </h2>
                  {items.length ? <ul className="flow-rows">{items.map((item) => renderRow(item, key))}</ul> : <p className="empty">該当する患者はいません。</p>}
                </section>
              );
            }) : null}
            {loaded && !filter && unlinked.length ? (
              <section aria-label="予約なしのカルテ" className="flow-group status-task">
                <h2 className="flow-group-head"><span>予約なしのカルテ</span><span className="count">{unlinked.length}</span></h2>
                <ul className="flow-rows">{unlinked.map(renderUnlinked)}</ul>
              </section>
            ) : null}
          </>
        )}
      </section>

      {registering ? (
        registering.appointmentId ? (
          <PatientRegisterDialog
            initial={{ displayName: registering.patientName }}
            onCancel={() => setRegistering(null)}
            onCreated={linkRegistering}
            onPickExisting={linkRegistering}
            pickExistingLabel="この患者で受付"
            submitLabel="登録して受付に紐づける"
            title={`患者登録（受付 #${registering.queueNumber ?? "—"}）`}
          />
        ) : (
          <PatientRegisterDialog
            onCancel={() => setRegistering(null)}
            onCreated={(patient) => router.push(`/patients/${patient.patientId}`)}
            onPickExisting={(patient) => router.push(`/patients/${patient.patientId}`)}
          />
        )
      ) : null}
    </main>
  );
}

function RowMenu({ entries, label }) {
  return (
    <details className="more-menu">
      <summary aria-label={`${label} のその他の操作`} className="btn btn-chip">…</summary>
      <div className="more-menu-list">
        {entries.map(([text, action]) => (
          <button className="btn btn-ghost" key={text} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); action(); }} type="button">{text}</button>
        ))}
      </div>
    </details>
  );
}

function formatToday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = "日月火水木金土"[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日（${weekday}）`;
}

function shortDate(iso) {
  if (iso === todayIso()) return "本日";
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return year === Number(todayIso().slice(0, 4)) ? `${month}/${day}` : formatDate(iso);
}

function savedAt(iso, today) {
  const clock = formatClock(iso);
  const day = new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
  return day === today ? clock : `${shortDate(day)} ${clock}`;
}

export function StatusTag({ encounter }) {
  if (encounter.status === "finalized") return <span className="tag tag-ok">確定 v{encounter.versionCount}</span>;
  if (encounter.amending) return <span className="tag tag-warn">修正中</span>;
  return <span className="tag tag-draft">下書き</span>;
}
