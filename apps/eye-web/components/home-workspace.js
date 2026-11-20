"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { PatientSummaryPane, usePatientSummary } from "./patient-summary-pane";
import { linkAppointmentToPatient, PatientRegisterDialog } from "./patient-register-dialog";
import { useMediaQuery } from "./use-media-query";
import { usePrintNames } from "./use-print-names";
import {
  consultStageOf,
  CONSULT_REFRESH_MS,
  ensureEncounterFor,
  LIST_STAGES,
  listStageOf,
  nextWaitingPatient,
  publishWaitingCount,
  stageEnteredAt,
  waitTimeOf
} from "../lib/consult-flow";
import { recordClock as formatClock } from "../lib/exam-record";
import { ageWithMonths } from "../lib/patient-summary";
import {
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  minutesSince,
  SEX_LABELS,
  todayIso,
  VISIT_TYPE_LABELS
} from "../lib/format";

// 待ち時間の目安（分）。超えたら数字だけを黄 → 赤にする（受付と同じ値）
const WAIT_THRESHOLDS = { exam: [20, 40], dark: [30, 45], waiting: [30, 60] };
// 要対応の一覧は 4 回に 1 回（約 1 分ごと）だけ取り直す
const WORKLIST_EVERY = 4;
const TASKS = [
  { key: "drafts", label: "未確定カルテ", count: "draftEncounters" },
  { key: "papers", label: "要約未確認", count: "unreviewedPaperCharts" },
  { key: "documents", label: "文書の下書き", count: "draftDocuments" }
];
// 承認待ち（指導医の承認）。承認者か、承認を使う医院で承認待ちがあるときだけタブを出す
const APPROVAL_TASK = { key: "approvals", label: "承認待ち", count: "approvalPending" };
const taskCount = (worklist, task) => (task.key === APPROVAL_TASK.key ? worklist.approvalPendingCount ?? 0 : worklist.counts[task.count]);
const tasksFor = (worklist) => (worklist?.approval?.canApprove || (worklist?.approval?.enabled && worklist?.approvalPendingCount) ? [...TASKS, APPROVAL_TASK] : TASKS);
const DOCUMENT_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };
const STAGE_LABELS = Object.fromEntries(LIST_STAGES.map((stage) => [stage.key, stage.label]));
const STAGE_ORDER = Object.fromEntries(LIST_STAGES.map((stage, index) => [stage.key, index]));

// 診察（医師・視能訓練士の作業場）。トプコンの「患者一覧＋カルテ概要」とデジカルの「患者リスト（診察待）」に倣う。
// - 上に場所（段階）のタブと人数。行を 1 回押すと右の概要が切り替わり（カルテは開かない）、
//   2 回押す・Enter でカルテを開く。↑↓ で行を移る。
// - 「次の患者」で診察待ちの先頭の診察を始める。
export function HomeWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const printNames = usePrintNames();
  const wide = useMediaQuery("(min-width: 1024px)", true);
  // 1280px 以上では、概要の右に縦のランチャー（トプコンの右端の縦の操作列）を置く
  const roomy = useMediaQuery("(min-width: 1280px)", true);
  const [data, setData] = useState({ appointments: [], encountersByPatient: {} });
  const [encounters, setEncounters] = useState([]);
  const [worklist, setWorklist] = useState(null);
  const [context, setContext] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [registering, setRegistering] = useState(null);
  const [busy, setBusy] = useState("");
  const tickRef = useRef(0);
  const tableRef = useRef(null);
  const date = todayIso();
  const canWrite = Boolean(context?.canWrite);
  const canStart = Boolean(context?.canReceive && canWrite);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch((nextError) => setError(nextError.message));
  }, [api]);

  // 後から出した要求の応答だけを使う（遅れて届いた前の応答で新しい一覧を上書きしない）
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const day = todayIso();
    const [appointmentPayload, encounterPayload] = await Promise.all([
      api(`/v1/eye/appointments?date=${day}`),
      api(`/v1/eye/encounters?date=${day}`)
    ]);
    if (seq !== loadSeq.current) return appointmentPayload;
    const at = Date.now();
    setData(appointmentPayload);
    setEncounters(encounterPayload.encounters || []);
    setNow(at);
    setLoaded(true);
    publishWaitingCount(appointmentPayload.appointments.filter((item) => consultStageOf(item, appointmentPayload.encountersByPatient, at) === "waiting").length);
    return appointmentPayload;
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

  const appointments = data.appointments;
  const byStage = useMemo(() => {
    const groups = Object.fromEntries(LIST_STAGES.map((stage) => [stage.key, []]));
    for (const item of appointments) {
      const stage = listStageOf(item, data.encountersByPatient, now);
      if (stage) groups[stage].push(item);
    }
    return groups;
  }, [appointments, data.encountersByPatient, now]);

  // 最初の表示: 診察待ちがいればそのタブ、いなければ全て
  useEffect(() => {
    if (loaded && tab === null) setTab(byStage.waiting.length ? "waiting" : "all");
  }, [byStage.waiting.length, loaded, tab]);

  const activeTab = tab || "all";
  const isTask = activeTab.startsWith("task:");
  const rows = useMemo(() => {
    if (isTask) return [];
    const list = activeTab === "all" ? Object.values(byStage).flat() : byStage[activeTab] || [];
    const stageOf = (item) => listStageOf(item, data.encountersByPatient, now);
    return [...list].sort((left, right) => {
      if (activeTab === "all") {
        const order = STAGE_ORDER[stageOf(left)] - STAGE_ORDER[stageOf(right)];
        if (order) return order;
      }
      if (stageOf(left) === "booked" || activeTab === "booked") return String(left.time || "99").localeCompare(String(right.time || "99"));
      return String(stageEnteredAt(left)).localeCompare(String(stageEnteredAt(right))) || (left.queueNumber || 0) - (right.queueNumber || 0);
    });
  }, [activeTab, byStage, data.encountersByPatient, isTask, now]);

  const selected = appointments.find((item) => item.appointmentId === selectedId) || null;
  const selectedEncounter = selected?.patientId ? data.encountersByPatient[selected.patientId] : null;
  const summaryState = usePatientSummary({
    patientId: selected?.patientId || "",
    todayEncounterId: selectedEncounter?.encounterId || "",
    todayRevision: selectedEncounter ? JSON.stringify([selectedEncounter.status, selectedEncounter.exam, selectedEncounter.orders]) : "",
    doctorName: selected?.doctorMemberId ? printNames[selected.doctorMemberId] || "" : ""
  });

  // 一覧が変わって選んでいた行が消えたら、選択を外す
  useEffect(() => {
    if (selectedId && loaded && !appointments.some((item) => item.appointmentId === selectedId)) setSelectedId("");
  }, [appointments, loaded, selectedId]);

  async function startConsult(item) {
    setError("");
    setBusy(item.appointmentId);
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
      setBusy("");
    }
  }

  // カルテがあれば開く。なければ作ってから開く（診察開始・カルテを開く から）
  async function openChart(item, view = "") {
    const encounterId = await ensureEncounterFor(api, item, data.encountersByPatient);
    router.push(`/encounters/${encounterId}${view ? `/${view}` : ""}`);
  }

  async function run(action) {
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  // デジカルの「患者リスト（診察待）」の先頭: 診察待ちになったのが早い人の診察を始める
  async function callNext() {
    setError("");
    setBusy("next");
    try {
      const payload = await load();
      const next = nextWaitingPatient(payload.appointments || [], payload.encountersByPatient || {}, Date.now());
      if (!next) {
        setError("診察待ちの患者はいません。");
        return;
      }
      setSelectedId(next.appointmentId);
      await startConsult(next);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy("");
    }
  }

  // 行を開く（2 回押す・Enter）: カルテがあれば開く。なければ患者のページへ（開くだけではカルテを作らない）
  function openRow(item) {
    if (!item.patientId) {
      if (context?.canRegisterPatients && context?.canReceive) setRegistering(item);
      return;
    }
    const existing = data.encountersByPatient[item.patientId];
    router.push(existing ? `/encounters/${existing.encounterId}` : `/patients/${item.patientId}`);
  }

  function selectRow(item, { focus = false } = {}) {
    setSelectedId(item.appointmentId);
    setSheetOpen(true);
    if (focus) tableRef.current?.querySelector(`[data-row-id="${item.appointmentId}"]`)?.focus();
  }

  function onRowKeyDown(event, item, index) {
    if (event.nativeEvent?.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      openRow(item);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) selectRow(next, { focus: true });
    } else if (event.key === " ") {
      event.preventDefault();
      selectRow(item);
    }
  }

  async function linkRegistering(patient) {
    const current = data.appointments.find((item) => item.appointmentId === registering.appointmentId) || registering;
    await linkAppointmentToPatient(api, current, patient);
    setRegistering(null);
    await load();
  }

  const linkedPatients = new Set(appointments.filter((item) => !["cancelled", "absent", "no_show"].includes(item.status)).map((item) => item.patientId).filter(Boolean));
  const unlinked = encounters.filter((encounter) => !linkedPatients.has(encounter.patientId));
  const inClinic = appointments.filter((item) => ["checked_in", "in_exam", "in_treatment", "waiting_doctor", "in_consult", "checkout"].includes(item.status)).length;
  const newPatients = appointments.filter((item) => item.purpose === "initial" && !["cancelled", "absent", "no_show", "booked"].includes(item.status)).length;
  const waitingNow = byStage.waiting.map((item) => minutesSince(stageEnteredAt(item), now)).filter((value) => value !== null);
  const averageWait = waitingNow.length ? Math.round(waitingNow.reduce((sum, value) => sum + value, 0) / waitingNow.length) : null;
  const totalShown = Object.values(byStage).reduce((sum, list) => sum + list.length, 0);
  const firstWaiting = nextWaitingPatient(appointments, data.encountersByPatient, now);

  function paneActions(item) {
    if (!item) return null;
    if (!item.patientId) {
      return context?.canRegisterPatients && context?.canReceive ? <button className="btn btn-primary btn-sm" onClick={() => setRegistering(item)} type="button">患者登録</button> : null;
    }
    const stage = listStageOf(item, data.encountersByPatient, now);
    const encounter = data.encountersByPatient[item.patientId];
    return (
      <>
        {stage === "waiting" && canStart ? (
          <button className="btn btn-primary btn-sm" disabled={busy !== ""} onClick={() => startConsult(item)} type="button">診察開始</button>
        ) : null}
        {encounter || (canWrite && item.status !== "booked") ? (
          <button className={`btn btn-sm ${stage === "consult" || (stage === "waiting" && !canStart) ? "btn-primary" : "btn-ghost"}`} onClick={() => run(() => openChart(item))} type="button">カルテを開く</button>
        ) : null}
        {canWrite && ["exam", "dark", "waiting"].includes(stage) ? (
          <button className="btn btn-ghost btn-sm" onClick={() => run(() => openChart(item, "exam"))} type="button">検査入力</button>
        ) : null}
        <Link className="btn btn-ghost btn-sm" href={`/patients/${item.patientId}`}>患者のページ</Link>
      </>
    );
  }

  function renderRow(item, index) {
    const stage = listStageOf(item, data.encountersByPatient, now);
    const snapshot = item.patientSnapshot || {};
    const entered = stage === "booked" ? "" : stageEnteredAt(item);
    // 待ちは次の状態に移った時刻で止める（会計済は会計待の間だけ）
    const waitTime = stage === "booked" ? null : waitTimeOf(item, { now, today: date });
    const wait = waitTime?.minutes ?? null;
    const [warnAt, alertAt] = WAIT_THRESHOLDS[stage] || [];
    const waitLevel = wait === null || !warnAt ? "" : wait >= alertAt ? " is-alert" : wait >= warnAt ? " is-warn" : "";
    const isSelected = item.appointmentId === selectedId;
    const encounter = data.encountersByPatient[item.patientId];
    const status = item.displayStatus || item.status;
    // 検査の段階のうち処置中は札を分ける（検査中と色・形で見分ける）
    const treating = stage === "exam" && status === "in_treatment";
    return (
      <tr
        aria-selected={isSelected}
        className={`consult-row stage-${stage}${isSelected ? " is-selected" : ""}`}
        data-row-id={item.appointmentId}
        key={item.appointmentId}
        onClick={() => selectRow(item)}
        onDoubleClick={() => openRow(item)}
        onKeyDown={(event) => onRowKeyDown(event, item, index)}
        tabIndex={0}
        title="1回押すと概要、2回押す（Enter）とカルテを開きます"
      >
        <td className="cl-no mono">{item.queueNumber && item.status !== "booked" ? item.queueNumber : ""}</td>
        <td className="cl-name">
          <span className="cl-name-main">
            {item.purpose === "initial" ? <span className="cl-new">新</span> : null}
            <strong>{item.patientName}</strong>
            {!item.patientId ? <span className="tag tag-warn">未登録</span> : null}
          </span>
          {snapshot.displayNameKana ? <span className="cl-kana">{snapshot.displayNameKana}</span> : null}
        </td>
        <td className={`cl-sex sex-${snapshot.sex || "unknown"}`}>{snapshot.sex && snapshot.sex !== "unknown" ? SEX_LABELS[snapshot.sex] : ""}</td>
        <td className="cl-age">{ageWithMonths(snapshot.birthDate, item.date)}</td>
        <td className="cl-stage">
          <span className={`cl-stage-tag stage-${stage}${treating ? " is-treatment" : ""}`}>{treating ? "処置" : STAGE_LABELS[stage]}</span>
          {stage === "consult" && encounter ? <span className="cl-sub">{encounter.status === "finalized" ? "確定済み" : "下書き"}</span> : null}
          {!treating && status !== LIST_STAGES.find((entry) => entry.key === stage)?.status && APPOINTMENT_STATUS_LABELS[status] ? <span className="cl-sub">{APPOINTMENT_STATUS_LABELS[status]}</span> : null}
        </td>
        <td className="cl-time mono">{formatClock(entered) || ""}</td>
        <td className={`cl-wait mono${waitLevel}`}>{waitTime?.unfinished ? <span title={`最後の更新 ${formatClock(waitTime.since)}`}>未終了</span> : wait === null ? "" : `${wait}分`}</td>
        <td className="cl-plan mono">{item.time || ""}</td>
        <td className="cl-purpose">
          {APPOINTMENT_PURPOSE_LABELS[item.purpose] || ""}
          {item.note ? <span className="cl-note" title={item.note}>{item.note}</span> : null}
        </td>
      </tr>
    );
  }

  function renderTaskRow({ key, href, date: rowDate, name, kana, state, detail, action }) {
    return (
      <li className="flow-row status-task" key={key}>
        <Link aria-label={`${name} の${action}`} className="flow-row-open" href={href} />
        <span className="flow-slot" />
        <span className="flow-time mono">{rowDate ? shortDate(rowDate) : "—"}</span>
        <span className="flow-name"><strong>{name || "（氏名なし）"}</strong>{kana ? <span className="flow-kana" title={kana}>{kana}</span> : null}</span>
        <span className="flow-age" />
        <span className="flow-purpose"><span className="consult-chart-state">{state}</span>{detail ? <span className="flow-note" title={detail}>{detail}</span> : null}</span>
        <span className="flow-progress" />
        <span className="flow-wait" />
        <span className="flow-actions"><Link className="btn btn-ghost btn-sm" href={href}>{action}</Link></span>
      </li>
    );
  }

  function renderTask(key) {
    if (!worklist) return <p className="empty">読み込み中…</p>;
    const task = tasksFor(worklist).find((item) => item.key === key) || TASKS[0];
    let taskRows = [];
    if (key === "drafts") {
      taskRows = worklist.draftEncounters.map((item) => renderTaskRow({
        key: item.encounterId,
        href: `/encounters/${item.encounterId}`,
        date: item.encounterDate,
        name: item.patientName,
        kana: item.patientNameKana,
        state: item.amending ? "修正中" : "下書き",
        detail: [item.updatedAt ? `最終保存 ${savedAt(item.updatedAt, date)}` : "", item.updatedBy].filter(Boolean).join(" "),
        action: "カルテを開く"
      }));
    } else if (key === APPROVAL_TASK.key) {
      taskRows = (worklist.approvalPending || []).map((item) => renderTaskRow({
        key: item.encounterId,
        href: `/encounters/${item.encounterId}`,
        date: item.encounterDate,
        name: item.patientName,
        kana: item.patientNameKana,
        state: `承認待ち v${item.version}`,
        detail: [item.finalizedBy ? `確定 ${item.finalizedBy}` : "", item.requestedAt ? savedAt(item.requestedAt, date) : ""].filter(Boolean).join(" "),
        action: worklist.approval?.canApprove ? "承認する" : "カルテを開く"
      }));
    } else if (key === "papers") {
      taskRows = worklist.unreviewedPaperCharts.map((item) => renderTaskRow({
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
      taskRows = worklist.draftDocuments.map((item) => renderTaskRow({
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
    const total = taskCount(worklist, task);
    return (
      <section aria-label={task.label} className="flow-group status-task">
        <h2 className="flow-group-head">
          <span>{task.label}</span><span className="count">{total}</span>
          {total > taskRows.length ? <span className="muted small">新しい順に {taskRows.length}件を表示</span> : null}
        </h2>
        {taskRows.length ? <ul className="flow-rows">{taskRows}</ul> : <p className="empty">ありません。</p>}
      </section>
    );
  }

  const launcher = !isTask && wide && roomy ? <ConsultLauncher busy={busy} canStart={canStart} firstWaiting={firstWaiting} item={selected} onNext={callNext} stage={selected?.patientId ? listStageOf(selected, data.encountersByPatient, now) : ""} encounter={selected?.patientId ? data.encountersByPatient[selected.patientId] : null} canWrite={canWrite} onOpenChart={(view) => run(() => openChart(selected, view))} onStartConsult={() => startConsult(selected)} onRegister={context?.canRegisterPatients && context?.canReceive ? () => setRegistering(selected) : null} /> : null;
  const pane = (
    <PatientSummaryPane
      actions={launcher ? null : paneActions(selected)}
      className={wide ? "" : "is-sheet"}
      error={summaryState.error}
      loading={summaryState.loading}
      summary={selected?.patientId ? summaryState.summary : null}
      title={selected ? `カルテ概要　${selected.patientName}` : "カルテ概要"}
    />
  );

  return (
    <main className="eye-page consult-page cl-page">
      <header className="page-head cl-head">
        <div>
          <h1>診察</h1>
          <p className="page-sub">{formatToday(date)}</p>
        </div>
        <dl aria-label="本日の集計" className="cl-stats">
          <div><dt>院内</dt><dd>{inClinic}</dd></div>
          <div><dt>診察待</dt><dd>{byStage.waiting.length}</dd></div>
          <div><dt>新患</dt><dd>{newPatients}</dd></div>
          <div><dt>平均待ち</dt><dd>{averageWait === null ? "—" : `${averageWait}分`}</dd></div>
        </dl>
        <div className="head-actions">
          {canStart ? (
            <button className="btn btn-primary btn-sm" disabled={!firstWaiting || busy !== ""} onClick={callNext} title={firstWaiting ? `${firstWaiting.patientName} の診察を始めます` : "診察待ちの患者はいません"} type="button">
              {busy === "next" ? "処理中…" : "次の患者"}
            </button>
          ) : null}
          {context?.canRegisterPatients ? <button className="btn btn-ghost btn-sm" onClick={() => setRegistering({})} type="button">新規患者</button> : null}
          <Link className="btn btn-ghost btn-sm" href="/reception">受付の一覧を開く</Link>
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <div aria-label="場所（段階）" className="cl-tabs" role="tablist">
        {LIST_STAGES.map((stage) => (
          <button aria-selected={activeTab === stage.key} className={`cl-tab stage-${stage.key}`} key={stage.key} onClick={() => setTab(stage.key)} role="tab" title={stage.title} type="button">
            {stage.label}<span className="cl-tab-count">{byStage[stage.key].length}</span>
          </button>
        ))}
        <button aria-selected={activeTab === "all"} className="cl-tab" onClick={() => setTab("all")} role="tab" type="button">
          全て<span className="cl-tab-count">{totalShown}</span>
        </button>
        {canWrite ? (
          <>
            <span aria-hidden="true" className="cl-tab-divider" />
            {tasksFor(worklist).map((task) => {
              const count = worklist ? taskCount(worklist, task) : null;
              return (
                <button aria-selected={activeTab === `task:${task.key}`} className={`cl-tab is-task${count ? " has-items" : ""}`} key={task.key} onClick={() => setTab(`task:${task.key}`)} role="tab" type="button">
                  {task.label}<span className="cl-tab-count">{count === null ? "…" : `${count}${worklist.truncated && count ? "+" : ""}`}</span>
                </button>
              );
            })}
          </>
        ) : null}
      </div>

      <div className={`cl-layout${isTask ? " is-task" : ""}${launcher ? " has-launcher" : ""}`}>
        <section aria-label={isTask ? "要対応の一覧" : "患者一覧"} className="panel cl-list">
          {isTask ? renderTask(activeTab.slice(5)) : (
            <>
              {!loaded ? <p className="empty">読み込み中…</p> : null}
              {loaded && rows.length === 0 ? (
                <p className="empty">
                  {appointments.length === 0 && unlinked.length === 0
                    ? "本日の予約・受付はまだありません。受付で当日受付するか、上の検索（/）から患者を開きます。"
                    : `「${activeTab === "all" ? "全て" : STAGE_LABELS[activeTab]}」の患者はいません。`}
                </p>
              ) : null}
              {rows.length ? (
                <div className="cl-table-wrap">
                  <table className="cl-table" ref={tableRef}>
                    <thead>
                      <tr>
                        <th className="cl-no" scope="col">No</th>
                        <th className="cl-name" scope="col">患者名</th>
                        <th className="cl-sex" scope="col">性別</th>
                        <th className="cl-age" scope="col">年齢</th>
                        <th className="cl-stage" scope="col">場所</th>
                        <th className="cl-time" scope="col">移動</th>
                        <th className="cl-wait" scope="col">経過</th>
                        <th className="cl-plan" scope="col">予定</th>
                        <th className="cl-purpose" scope="col">目的・メモ</th>
                      </tr>
                    </thead>
                    <tbody>{rows.map(renderRow)}</tbody>
                  </table>
                </div>
              ) : null}
              {loaded && activeTab === "all" && unlinked.length ? (
                <section aria-label="予約なしのカルテ" className="cl-unlinked">
                  <h2>予約なしのカルテ<span className="cl-tab-count">{unlinked.length}</span></h2>
                  <ul>
                    {unlinked.map((encounter) => (
                      <li key={encounter.encounterId}>
                        <Link href={`/encounters/${encounter.encounterId}`}>
                          <strong>{encounter.patientSnapshot?.displayName}</strong>
                          <span className="muted small">{VISIT_TYPE_LABELS[encounter.visitType] || ""}</span>
                          <span className="consult-chart-state">{encounter.status === "finalized" ? "確定済み" : encounter.amending ? "修正中" : "下書き"}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {rows.length ? <p className="cl-help muted small">1回押すと右に概要、2回押す（または Enter）とカルテを開きます。↑↓ で行を移ります。</p> : null}
            </>
          )}
        </section>
        {!isTask && wide ? pane : null}
        {launcher}
      </div>
      {!isTask && !wide && selected && sheetOpen ? (
        <div className="cl-sheet-backdrop" onClick={() => setSheetOpen(false)} role="presentation">
          <div aria-label="カルテ概要" aria-modal="true" className="cl-sheet" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) setSheetOpen(false); }} role="dialog">
            <button aria-label="概要を閉じる" className="btn btn-ghost btn-sm cl-sheet-close" onClick={() => setSheetOpen(false)} type="button">閉じる</button>
            {pane}
          </div>
        </div>
      ) : null}

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

// 概要の右の縦の操作列（トプコンのカルテ概要の右端のランチャー）。選んだ患者に対する操作を縦に並べる。
// アイコンは自前の文字。押せない操作は出さずに、並びの位置だけそろえる。
function ConsultLauncher({ item, stage, encounter, canWrite, canStart, busy, firstWaiting, onNext, onOpenChart, onStartConsult, onRegister }) {
  const patientId = item?.patientId || "";
  const entries = [
    canStart && stage === "waiting" ? { key: "start", icon: "▶", label: "診察開始", action: onStartConsult, primary: true } : null,
    patientId && (encounter || (canWrite && item.status !== "booked")) ? { key: "chart", icon: "✎", label: "カルテ", action: () => onOpenChart("") } : null,
    patientId && canWrite && ["exam", "dark", "waiting"].includes(stage) ? { key: "exam", icon: "◎", label: "検査入力", action: () => onOpenChart("exam") } : null,
    patientId ? { key: "patient", icon: "☰", label: "患者", href: `/patients/${patientId}` } : null,
    patientId ? { key: "vaiop", icon: "↗", label: "視力眼圧", href: `/patients/${patientId}?tab=va-iop` } : null,
    patientId ? { key: "images", icon: "▣", label: "画像", href: `/patients/${patientId}/images` } : null,
    patientId ? { key: "iol", icon: "◍", label: "IOL", href: `/patients/${patientId}?tab=iol` } : null,
    !patientId && item && onRegister ? { key: "register", icon: "＋", label: "患者登録", action: onRegister, primary: true } : null
  ].filter(Boolean);
  return (
    <nav aria-label="選んだ患者の操作" className="cl-launcher">
      {!item ? <p className="cl-launcher-empty">患者を選ぶと操作が出ます</p> : null}
      {entries.map((entry) => (entry.href ? (
        <Link className="cl-launch" href={entry.href} key={entry.key}>
          <span aria-hidden="true" className="cl-launch-icon">{entry.icon}</span>{entry.label}
        </Link>
      ) : (
        <button className={`cl-launch${entry.primary ? " is-primary" : ""}`} disabled={busy !== ""} key={entry.key} onClick={entry.action} type="button">
          <span aria-hidden="true" className="cl-launch-icon">{entry.icon}</span>{entry.label}
        </button>
      )))}
      {canStart ? (
        <button className="cl-launch is-next" disabled={!firstWaiting || busy !== ""} onClick={onNext} title={firstWaiting ? `${firstWaiting.patientName} の診察を始めます` : "診察待ちの患者はいません"} type="button">
          <span aria-hidden="true" className="cl-launch-icon">→</span>次の患者
        </button>
      ) : null}
    </nav>
  );
}
