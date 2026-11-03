"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { DocumentsPanel } from "./documents-panel";
import { FilesPanel, UploadDialog } from "./files-panel";
import { PatientBanner } from "./patient-banner";
import { TrendPanel } from "./trend-chart";
import { useMediaQuery } from "./use-media-query";
import {
  downloadJson,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatDate,
  prescriptionText,
  todayIso,
  VISIT_TYPE_LABELS
} from "../lib/format";

const SIDE_SHORT = { od: "右", os: "左", ou: "両" };
const VISIT_ROWS = 6;

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

  const reloadPaper = useCallback(() => {
    api(`/v1/eye/patients/${patientId}/files`)
      .then((payload) => setPaperFiles(payload.files.filter((item) => item.kind === "paper_chart" && item.paper?.summary)))
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
          <CurrentStrip encounter={latestFinalized} points={trend?.points || []} today={today} />
          <CourseBlock encounters={encounters} today={today} trend={trend} />
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
          onUploaded={() => { setFilesKey((value) => value + 1); reloadPaper(); }}
          patientId={patientId}
        />
      ) : null}
    </main>
  );
}

// 前回確定の要点（左右の視力・眼圧と前回差、処方中、方針、次回指示）を 1 つの帯に出す。
function CurrentStrip({ encounter, points, today }) {
  if (!encounter) {
    return (
      <section className="pt-current is-empty" aria-label="前回の状態">
        <p className="empty">確定済みのカルテはまだありません。</p>
      </section>
    );
  }
  const content = encounter.content || {};
  const exam = content.exam || {};
  const prescriptions = content.prescriptions || [];
  const index = points.findIndex((point) => point.encounterId === encounter.encounterId);
  const planLine = String(content.plan || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
  const weeks = content.nextVisit?.intervalWeeks;
  return (
    <section className="pt-current" aria-label="前回の状態">
      <div className="pt-current-head">
        <span className="pt-current-title">前回 {formatDate(encounter.encounterDate).slice(5)}</span>
        <span className="pt-current-ago">{agoLabel(encounter.encounterDate, today)}</span>
        <span className="pt-current-state">確定</span>
        {weeks ? <span className="pt-current-next">次回指示 {weeks}週後{content.nextVisit?.note ? `（${content.nextVisit.note}）` : ""}</span> : null}
      </div>
      <div className="pt-current-eyes">
        {["od", "os"].map((side) => {
          const values = exam[side] || {};
          const iop = isNumber(values.iop) ? values.iop : null;
          const previousIop = index > 0 ? previousValue(points, index, side, "iop") : null;
          const previousVa = index > 0 ? previousValue(points, index, side, "va") : null;
          const currentVa = index >= 0 ? points[index][side]?.va : null;
          const delta = iop !== null && previousIop ? iop - previousIop.value : null;
          return (
            <div className={`pt-eye pt-eye-${side}`} key={side}>
              <span className="pt-eye-label">{SIDE_SHORT[side]}</span>
              <span className="pt-metric">
                <span className="pt-metric-label">VA</span>
                <span className="pt-metric-value">
                  {values.vaUncorrected || (values.vaCorrected ? "" : "—")}
                  {values.vaCorrected ? <span className="pt-va-corrected">({values.vaCorrected})</span> : null}
                </span>
                {isNumber(currentVa) && previousVa && previousVa.value !== currentVa ? (
                  <span className="pt-delta" title={`前回 ${formatDate(previousVa.date)}: ${previousVa.label}`}>{currentVa > previousVa.value ? "↑" : "↓"}</span>
                ) : null}
              </span>
              <span className="pt-metric">
                <span className="pt-metric-label">IOP</span>
                <span className="pt-metric-value">{iop ?? "—"}</span>
                {delta !== null ? (
                  <span className={`pt-delta${delta >= 2 ? " is-up" : ""}`} title={`前回 ${formatDate(previousIop.date)}: ${previousIop.value} mmHg`}>
                    {delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : "→"}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <dl className="pt-current-lines">
        <div>
          <dt>処方中</dt>
          <dd title={prescriptions.map(prescriptionText).join("\n")}>
            {prescriptions.length ? prescriptions.map(shortPrescription).join(" ／ ") : "—"}
          </dd>
        </div>
        <div>
          <dt>方針</dt>
          <dd title={content.plan || ""}>{planLine || "—"}</dd>
        </div>
      </dl>
    </section>
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
        {open || !hasPoints ? <div className="pt-course-chart"><TrendPanel trend={trend} /></div> : null}
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

function previousValue(points, index, side, key) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = points[cursor]?.[side]?.[key];
    if (isNumber(value)) return { value, date: points[cursor].encounterDate, label: key === "va" ? points[cursor][side].vaLabel || String(value) : String(value) };
  }
  return null;
}

function agoLabel(iso, today) {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "本日";
  if (days < 7) return `${days}日前`;
  if (days < 7 * 9) return `${Math.round(days / 7)}週前`;
  if (days < 365 * 2) return `${Math.round(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

function shortPrescription(item = {}) {
  return [item.name, item.eye ? SIDE_SHORT[item.eye] : "", item.timesPerDay ? `${item.timesPerDay}回` : ""].filter(Boolean).join(" ");
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
