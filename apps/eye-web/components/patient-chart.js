"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { DocumentsPanel } from "./documents-panel";
import { FilesPanel, UploadDialog } from "./files-panel";
import { PatientBanner } from "./patient-banner";
import { IolPanel, PreopViewer, useIolRecords } from "./patient-iol";
import { notifyPatientPhotoChanged } from "./patient-photo";
import { PatientSummaryPane } from "./patient-summary-pane";
import { TrendPanel } from "./trend-chart";
import { VaIopView } from "./va-iop-view";
import { useMediaQuery } from "./use-media-query";
import {
  downloadJson,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  todayIso,
  VISIT_TYPE_LABELS
} from "../lib/format";

const VISIT_ROWS = 6;
// 表示のタブ（トプコンの患者の画面のタブ: カルテ内容・視力眼圧・IOL管理・術前検査）。?tab= で開ける。
const VIEWS = [["summary", "カルテ概要"], ["va-iop", "視力眼圧"], ["iol", "IOL"], ["preop", "術前検査"]];

export function PatientChart({ patientId }) {
  const api = useEyeApi();
  const router = useRouter();
  const [chart, setChart] = useState(null);
  const [context, setContext] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filesKey, setFilesKey] = useState(0);
  const [paperFiles, setPaperFiles] = useState([]);
  const [allFiles, setAllFiles] = useState([]);
  const iolState = useIolRecords(patientId);
  const [view, setView] = useState("summary");
  const [todayEncounter, setTodayEncounter] = useState(null);
  const todayEncounterId = chart?.encounters?.find((encounter) => encounter.encounterDate === todayIso())?.encounterId || "";

  // 概要には今日のカルテ（検査室で入れた値・本日予定）も出す
  useEffect(() => {
    if (!todayEncounterId) return undefined;
    let active = true;
    api(`/v1/eye/encounters/${todayEncounterId}`).then((payload) => { if (active) setTodayEncounter(payload.encounter); }).catch(() => {});
    return () => { active = false; };
  }, [api, todayEncounterId]);

  // ?tab=va-iop（検査入力の「過去履歴」から）などで、そのタブを開く
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (VIEWS.some(([key]) => key === tab)) setView(tab);
  }, []);

  const reloadPaper = useCallback(() => {
    api(`/v1/eye/patients/${patientId}/files`)
      .then((payload) => {
        setAllFiles(payload.files);
        setPaperFiles(payload.files.filter((item) => item.kind === "paper_chart" && item.paper?.summary));
      })
      .catch(() => {});
  }, [api, patientId]);

  useEffect(() => {
    Promise.all([api(`/v1/eye/patients/${patientId}/chart`), api("/v1/eye/context")])
      .then(([chartPayload, contextPayload]) => {
        setChart(chartPayload);
        setContext(contextPayload.context);
      })
      .catch((nextError) => setLoadError(nextError.message));
    reloadPaper();
  }, [api, patientId, reloadPaper]);

  if (loadError) return <main className="eye-page"><p className="alert alert-danger" role="alert">{loadError}</p></main>;
  if (!chart) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const { patient, encounters = [], latestFinalized, trend, upcomingAppointments = [] } = chart;
  const today = todayIso();
  const todayDraft = encounters.find((encounter) => encounter.encounterDate === today && encounter.status === "draft");
  const hasFinalized = Boolean(latestFinalized);
  const canUpload = Boolean(context?.canWriteDocuments);

  async function startEncounter() {
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/encounters", {
        method: "POST",
        body: { patientId, encounterDate: today, visitType: hasFinalized ? "revisit" : "initial" }
      });
      router.push(`/encounters/${payload.encounter.encounterId}`);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  async function exportData() {
    setError("");
    try {
      downloadJson(await api(`/v1/eye/patients/${patientId}/export`), `eye-patient-${patient.primaryPatientNumber || patientId}.json`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const primary = todayDraft ? (
    <Link className="btn btn-primary" href={`/encounters/${todayDraft.encounterId}`}>本日のカルテを開く</Link>
  ) : context?.canWrite ? (
    <button className="btn btn-primary" disabled={busy} onClick={startEncounter} title={hasFinalized ? "前回の確定カルテから処方などを引き継ぎます" : undefined} type="button">
      {hasFinalized ? "本日のカルテを作成" : "初診カルテを作成"}
    </button>
  ) : null;

  const menu = [
    canUpload ? { label: "画像・ファイルを取り込む", action: () => setUploading(true) } : null,
    { label: "画像の比較", href: `/patients/${patientId}/images` },
    context?.canFinalize ? { label: "この患者のデータを出力", note: "開示請求・移行用（JSON）", action: exportData } : null
  ].filter(Boolean);

  return (
    <main className="eye-page pt-page">
      <div className="encounter-bar is-static">
        <PatientBanner
          actions={(
            <div className="pt-actions">
              {primary}
              <details className="more-menu">
                <summary aria-label="その他の操作" className="btn btn-chip">…</summary>
                <div className="more-menu-list pt-menu">
                  {menu.map((item) => item.href ? (
                    <Link className="btn btn-ghost" href={item.href} key={item.label}>{item.label}</Link>
                  ) : (
                    <button className="btn btn-ghost" key={item.label} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); item.action(); }} type="button">
                      <span>{item.label}{item.note ? <span className="more-menu-sub">{item.note}</span> : null}</span>
                    </button>
                  ))}
                </div>
              </details>
            </div>
          )}
          compact
          context={context}
          leading={<Link aria-label="ホームへ戻る" className="back-link" href="/">←</Link>}
          onProfileSaved={(saved) => setChart((current) => ({ ...current, profile: saved }))}
          patient={patient}
          profile={chart.profile}
        />
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <div className="chart-grid pt-grid">
        <div className="chart-main">
          <div aria-label="表示" className="pt-tabs" role="tablist">
            {VIEWS.map(([key, label]) => (
              <button aria-selected={view === key} className="pt-tab" key={key} onClick={() => setView(key)} role="tab" type="button">{label}</button>
            ))}
            <Link className="pt-tab is-link" href={`/patients/${patientId}/images`}>画像 ›</Link>
          </div>
          {view === "va-iop" ? (
            <section aria-label="視力眼圧" className="panel pt-va-iop" role="tabpanel">
              <VaIopView dense plotHeight={210} points={trend?.points || []} />
            </section>
          ) : view === "iol" ? (
            <section aria-label="IOL" className="panel pt-iol" role="tabpanel">
              <IolPanel canWrite={Boolean(context?.canWrite)} state={iolState} />
            </section>
          ) : view === "preop" ? (
            <section aria-label="術前検査" className="panel pt-preop" role="tabpanel">
              <PreopViewer encounters={[todayEncounter, latestFinalized]} files={allFiles} iolState={iolState} patientId={patientId} />
            </section>
          ) : (
            <div role="tabpanel">
              <PatientSummaryPane
                summary={{
                  patient,
                  profile: chart.profile,
                  latestFinalized,
                  today: todayEncounter,
                  lastVisitDate: encounters.find((encounter) => encounter.encounterDate < today)?.encounterDate || ""
                }}
                title="カルテ概要"
              />
              <CourseBlock encounters={encounters} today={today} trend={trend} />
            </div>
          )}
        </div>
        <aside className="chart-side pt-side">
          <AppointmentsPanel items={upcomingAppointments} today={today} />
          <FilesPanel
            context={context}
            onChanged={reloadPaper}
            onUpload={canUpload ? () => setUploading(true) : undefined}
            patientId={patientId}
            reloadKey={filesKey}
          />
          <DocumentsPanel canWrite={Boolean(context?.canWriteDocuments)} patientId={patientId} variant="side" />
          {paperFiles.length ? (
            <section className="panel side-panel">
              <div className="side-head"><h2>紙カルテからの要約<span className="side-count">{paperFiles.length}</span></h2></div>
              <ul className="side-list">
                {paperFiles.map((file) => (
                  <li className="paper-item" key={file.fileId}>
                    <div className="paper-item-head">
                      <strong>{formatDate(file.takenOn)} {file.title}</strong>
                      <span className={`side-row-status${file.paper.reviewedBy ? "" : " is-warn"}`}>{file.paper.reviewedBy ? "医師確認済み" : "未確認"}</span>
                    </div>
                    <p className="paper-item-summary" title={file.paper.summary}>{file.paper.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
      {uploading ? (
        <UploadDialog
          onClose={() => setUploading(false)}
          onUploaded={(file) => { setFilesKey((value) => value + 1); reloadPaper(); if (file?.kind === "face_photo") notifyPatientPhotoChanged(patientId); }}
          patientId={patientId}
        />
      ) : null}
    </main>
  );
}

// 経過: 視力・眼圧のグラフ（点眼の印つき）と、1 受診 1 行の表。
function CourseBlock({ encounters, trend, today }) {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [chartOpen, setChartOpen] = useState(null);
  const open = chartOpen ?? !isPhone;
  const hasPoints = (trend?.points || []).length > 0;
  return (
    <section className="panel pt-course" aria-labelledby="course-heading">
      <div className="side-head">
        <h2 id="course-heading">経過</h2>
        {hasPoints ? (
          <button aria-expanded={open} className="btn btn-chip btn-sm pt-chart-toggle" onClick={() => setChartOpen(!open)} type="button">
            {open ? "グラフをたたむ" : "グラフを表示"}
          </button>
        ) : null}
      </div>
      <div className="pt-course-body">
        {open || !hasPoints ? <div className="pt-course-chart"><TrendPanel band={isPhone ? 112 : 150} trend={trend} /></div> : null}
        <VisitTable encounters={encounters} today={today} trend={trend} />
      </div>
    </section>
  );
}

function VisitTable({ encounters, trend, today }) {
  const [expanded, setExpanded] = useState(false);
  if (encounters.length === 0) return <p className="empty">まだカルテがありません。</p>;
  const pointsById = new Map((trend?.points || []).map((point) => [point.encounterId, point]));
  const changesByDate = new Map();
  const addChange = (date, change) => changesByDate.set(date, [...(changesByDate.get(date) || []), change]);
  for (const event of trend?.medicationEvents || []) addChange(event.encounterDate, { kind: event.type, label: event.label });
  for (const event of trend?.injections || []) addChange(event.encounterDate, { kind: "injection", label: event.label });
  const rows = expanded ? encounters : encounters.slice(0, VISIT_ROWS);
  return (
    <div className="visit-table">
      <div aria-hidden="true" className="visit-row visit-head">
        <span className="v-date">日付</span>
        <span className="v-type">区分</span>
        <span className="v-va v-od">右VA</span>
        <span className="v-va v-os">左VA</span>
        <span className="v-iop v-od">右IOP</span>
        <span className="v-iop v-os">左IOP</span>
        <span className="v-changes">処方の変更</span>
        <span className="v-status">状態</span>
      </div>
      <ol className="visit-rows">
        {rows.map((encounter) => {
          const point = pointsById.get(encounter.encounterId);
          // 点眼の変更は確定済みの回（経過の点がある回）に日付で結び付ける。同じ日に 2 回あれば両方に出す。
          const changes = point ? changesByDate.get(encounter.encounterDate) || [] : [];
          const isToday = encounter.encounterDate === today;
          return (
            <li key={encounter.encounterId}>
              <Link className={`visit-row${point ? "" : " is-open"}`} href={`/encounters/${encounter.encounterId}`}>
                <span className="v-date">{formatDate(encounter.encounterDate)}{isToday ? <span className="v-today">本日</span> : null}</span>
                <span className="v-type">{VISIT_TYPE_LABELS[encounter.visitType] || ""}</span>
                <span className="v-vals">
                  <span className="v-va v-od"><span className="v-eye">右</span>{vaText(point?.od)}</span>
                  <span className="v-va v-os"><span className="v-eye">左</span>{vaText(point?.os)}</span>
                  <span className="v-iop v-od"><span className="v-eye">右</span>{iopText(point?.od)}</span>
                  <span className="v-iop v-os"><span className="v-eye">左</span>{iopText(point?.os)}</span>
                </span>
                <span className="v-changes" title={changes.map((change) => `${CHANGE_PREFIX[change.kind]}${change.label}`).join("\n")}>
                  {changes.length ? <ChangeList changes={changes} /> : <span className="v-none">—</span>}
                </span>
                <span className="v-status"><VisitStatus encounter={encounter} /></span>
              </Link>
            </li>
          );
        })}
      </ol>
      {encounters.length > VISIT_ROWS ? (
        <button aria-expanded={expanded} className="side-more" onClick={() => setExpanded(!expanded)} type="button">
          {expanded ? "最近の 6 件だけ表示" : `すべて表示（${encounters.length}件）`}
        </button>
      ) : null}
    </div>
  );
}

const CHANGE_PREFIX = { started: "＋", stopped: "−", injection: "◆" };

function ChangeList({ changes }) {
  const shown = changes.slice(0, 2);
  return (
    <>
      {shown.map((change, index) => (
        <span className={`v-change is-${change.kind}`} key={index}>{CHANGE_PREFIX[change.kind]}{shortLabel(change.label)}</span>
      ))}
      {changes.length > shown.length ? <span className="v-change is-more">ほか{changes.length - shown.length}</span> : null}
    </>
  );
}

// 版番号は修正があったとき（v2 以上）だけ出す。
function VisitStatus({ encounter }) {
  if (encounter.status === "finalized") {
    return <span className="v-state is-final">確定{encounter.versionCount > 1 ? ` v${encounter.versionCount}` : ""}</span>;
  }
  if (encounter.amending) return <span className="v-state is-amending">修正中</span>;
  return <span className="v-state is-draft">下書き</span>;
}

function AppointmentsPanel({ items, today }) {
  const sorted = [...items].sort((left, right) => `${left.date} ${left.time || ""}`.localeCompare(`${right.date} ${right.time || ""}`));
  const [next, ...rest] = sorted;
  return (
    <section className="panel side-panel">
      <div className="side-head"><h2>予約</h2></div>
      {!next ? <p className="empty">予約はありません。</p> : (
        <>
          <AppointmentLine item={next} primary today={today} />
          {rest.length ? (
            <ul className="side-list">
              {rest.slice(0, 3).map((item) => <li key={item.appointmentId}><AppointmentLine item={item} today={today} /></li>)}
            </ul>
          ) : null}
          {rest.length > 3 ? <p className="muted small">ほか {rest.length - 3}件</p> : null}
        </>
      )}
    </section>
  );
}

function AppointmentLine({ item, today, primary = false }) {
  const isToday = item.date === today;
  return (
    <div className={`appt-line${primary ? " is-next" : ""}`}>
      <span className="appt-when">{isToday ? "本日" : formatDate(item.date).slice(5)} {item.time || ""}</span>
      <span className="appt-what">{APPOINTMENT_PURPOSE_LABELS[item.purpose] || ""}</span>
      {item.status !== "booked" ? <span className="side-row-status">{APPOINTMENT_STATUS_LABELS[item.status] || ""}</span> : null}
      {item.note ? <span className="appt-note" title={item.note}>{item.note}</span> : null}
    </div>
  );
}

function shortLabel(label = "") {
  return String(label).replace(/（[^（）]*）$/u, "");
}

function vaText(value) {
  if (!value) return "—";
  return value.vaLabel || (isNumber(value.va) ? String(value.va) : "—");
}

function iopText(value) {
  return value && isNumber(value.iop) ? value.iop : "—";
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
