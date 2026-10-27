"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { StatusTag } from "./home-workspace";
import { TrendPanel } from "./trend-chart";
import {
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  diagnosisText,
  formatDate,
  formatRefraction,
  patientLine,
  prescriptionText,
  todayIso,
  VISIT_TYPE_LABELS
} from "../lib/format";

export function PatientChart({ patientId }) {
  const api = useEyeApi();
  const router = useRouter();
  const [chart, setChart] = useState(null);
  const [context, setContext] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api(`/v1/eye/patients/${patientId}/chart`), api("/v1/eye/context")])
      .then(([chartPayload, contextPayload]) => {
        setChart(chartPayload);
        setContext(contextPayload.context);
      })
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId]);

  if (error) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!chart) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const { patient, encounters, latestFinalized, trend, upcomingAppointments = [] } = chart;
  const todayDraft = encounters.find((encounter) => encounter.encounterDate === todayIso() && encounter.status === "draft");
  const hasFinalized = Boolean(latestFinalized);

  async function startEncounter() {
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/encounters", {
        method: "POST",
        body: { patientId, encounterDate: todayIso(), visitType: hasFinalized ? "revisit" : "initial" }
      });
      router.push(`/encounters/${payload.encounter.encounterId}`);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <main className="eye-page">
      <header className="patient-head">
        <div>
          <a className="back-link" href="/">← 受診一覧</a>
          <h1>{patient.displayName} <span className="kana">{patient.displayNameKana}</span></h1>
          <p className="page-sub">{patientLine(patient)}{patient.birthDate ? ` ・ ${formatDate(patient.birthDate)}生` : ""}</p>
        </div>
        <div className="head-actions">
          {todayDraft ? (
            <a className="btn btn-primary" href={`/encounters/${todayDraft.encounterId}`}>本日のカルテを開く</a>
          ) : context?.canWrite ? (
            <button className="btn btn-primary" disabled={busy} onClick={startEncounter} type="button">
              {hasFinalized ? "本日のカルテを作成（前回から引き継ぐ）" : "初診カルテを作成"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="chart-grid">
        <div className="chart-main">
          <section className="panel">
            <h2>現在の状態</h2>
            {latestFinalized ? <LatestSummary encounter={latestFinalized} /> : <p className="empty">確定済みのカルテはまだありません。</p>}
          </section>
          <section className="panel">
            <h2>経過</h2>
            <TrendPanel trend={trend} />
          </section>
        </div>
        <aside className="chart-side">
          <section className="panel">
            <h2>今後の予約</h2>
            {upcomingAppointments.length === 0 ? <p className="empty">予約はありません。</p> : (
              <ul className="plain">
                {upcomingAppointments.map((item) => (
                  <li key={item.appointmentId}>
                    <strong>{formatDate(item.date)}</strong> {item.time || ""} {APPOINTMENT_PURPOSE_LABELS[item.purpose]}
                    {item.status !== "booked" ? <span className="tag"> {APPOINTMENT_STATUS_LABELS[item.status]}</span> : null}
                    {item.note ? <div className="small muted">{item.note}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
          <h2>カルテ履歴</h2>
          {encounters.length === 0 ? <p className="empty">まだカルテがありません。</p> : (
            <ol className="history">
              {encounters.map((encounter) => (
                <li key={encounter.encounterId}>
                  <a className="history-row" href={`/encounters/${encounter.encounterId}`}>
                    <span className="history-date">{formatDate(encounter.encounterDate)}</span>
                    <span className="history-tags">
                      <span className="tag">{VISIT_TYPE_LABELS[encounter.visitType]}</span>
                      <StatusTag encounter={encounter} />
                    </span>
                    <span className="muted small">{encounter.diagnoses.map(diagnosisText).join("、") || encounter.chiefComplaint || "—"}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function LatestSummary({ encounter }) {
  const { content } = encounter;
  const active = content.diagnoses.filter((diagnosis) => diagnosis.status !== "resolved");
  return (
    <div className="summary">
      <p className="muted small">最終確定: {formatDate(encounter.encounterDate)}</p>
      <table className="exam-table compact">
        <thead>
          <tr><th scope="col" /><th scope="col">右眼</th><th scope="col">左眼</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">視力</th>
            {["od", "os"].map((side) => (
              <td key={side}>
                {content.exam[side].vaUncorrected || "—"}
                {content.exam[side].vaCorrected ? ` (${content.exam[side].vaCorrected}${formatRefraction(content.exam[side].correction) ? ` × ${formatRefraction(content.exam[side].correction)}` : ""})` : ""}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">眼圧</th>
            {["od", "os"].map((side) => <td key={side}>{content.exam[side].iop ?? "—"}{content.exam[side].iop !== null ? " mmHg" : ""}</td>)}
          </tr>
        </tbody>
      </table>
      <div className="summary-cols">
        <div>
          <h3>病名</h3>
          {active.length ? <ul className="plain">{active.map((diagnosis, index) => <li key={index}>{diagnosisText(diagnosis)}</li>)}</ul> : <p className="muted">—</p>}
        </div>
        <div>
          <h3>処方中</h3>
          {content.prescriptions.length ? <ul className="plain">{content.prescriptions.map((item, index) => <li key={index}>{prescriptionText(item)}</li>)}</ul> : <p className="muted">—</p>}
        </div>
      </div>
      {content.plan ? <p className="summary-plan"><strong>方針</strong> {content.plan}</p> : null}
      {content.nextVisit.intervalWeeks ? <p className="muted small">前回の次回指示: {content.nextVisit.intervalWeeks}週後{content.nextVisit.note ? `（${content.nextVisit.note}）` : ""}</p> : null}
    </div>
  );
}
