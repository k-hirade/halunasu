"use client";

import { useEffect, useState } from "react";
import { AllergyBadge } from "./patient-banner";
import { useEyeApi } from "./eye-api";
import { PatientPhoto } from "./patient-photo";
import {
  activeDiagnoses,
  ageWithMonths,
  elapsedLabel,
  latestIop,
  latestVision,
  todayPlan
} from "../lib/patient-summary";
import { splitAtBreaks } from "../lib/label-layout.mjs";
import { diagnosisText, formatDate, IOP_METHOD_LABELS, prescriptionText, SEX_LABELS, todayIso } from "../lib/format";

// 患者の概要（トプコンの「カルテ概要」に倣う 2 列 × 4 段）。
// 左: カルテ情報 / 視力 / 眼圧 / 患者特記、右: 本日予定 / 処方 / 病名。
// 何も選んでいないときも枠と見出しは出し、値だけを空にする。
export function PatientSummaryPane({ summary = null, loading = false, error = "", title = "カルテ概要", actions = null, className = "" }) {
  const date = todayIso();
  const patient = summary?.patient || null;
  const profile = summary?.profile || null;
  const finalized = summary?.latestFinalized || null;
  const today = summary?.today || null;
  const vision = summary ? latestVision({ today, finalized, todayDate: date }) : null;
  const iop = summary ? latestIop({ today, finalized, todayDate: date }) : null;
  const plan = summary ? todayPlan({ today, finalized }) : [];
  const diagnoses = summary ? activeDiagnoses(profile, finalized) : [];
  const prescriptions = (finalized?.content?.prescriptions || []).filter((item) => item.kind !== "comment");
  const lastVisit = summary?.lastVisitDate || "";
  const empty = <span className="ps-empty">—</span>;
  return (
    <section aria-label={title} className={`ps-pane${className ? ` ${className}` : ""}`}>
      <div className="ps-head">
        <h2>{title}</h2>
        {loading ? <span className="ps-loading" role="status">読み込み中…</span> : null}
        {actions ? <div className="ps-actions">{actions}</div> : null}
      </div>
      {error ? <p className="alert alert-danger ps-error" role="alert">{error}</p> : null}
      <div className="ps-grid">
        <section aria-label="カルテ情報" className="ps-cell ps-info">
          <h3>カルテ情報</h3>
          {patient?.patientId ? <PatientPhoto name={patient.displayName} patientId={patient.patientId} size="lg" /> : null}
          {patient ? (
            <dl className="ps-dl">
              <div><dt>患者ID</dt><dd className="mono">{patient.primaryPatientNumber || "—"}</dd></div>
              <div><dt>氏名</dt><dd><strong className="ps-nw">{patient.displayName}</strong>{patient.displayNameKana ? <> <span className="ps-kana">{patient.displayNameKana}</span></> : null}</dd></div>
              <div><dt>性別・生年月日</dt><dd><Breakable parts={[SEX_LABELS[patient.sex] && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] : "", patient.birthDate ? formatDate(patient.birthDate) : "", patient.birthDate ? `（${ageWithMonths(patient.birthDate, date)}）` : ""]} /></dd></div>
              <div><dt>担当医</dt><dd>{summary.doctorName || "—"}</dd></div>
              <div><dt>前回来院</dt><dd>{lastVisit ? <Breakable parts={[formatDate(lastVisit), `（${elapsedLabel(lastVisit, date)}経過）`]} /> : "初診"}</dd></div>
            </dl>
          ) : empty}
          {profile ? <div className="ps-allergy"><AllergyBadge profile={profile} /></div> : null}
        </section>
        <section aria-label="本日予定" className="ps-cell ps-plan">
          <h3>本日予定</h3>
          {plan.length ? (
            <ul className="ps-list">
              {plan.map((item) => (
                <li className={item.done ? "is-done" : ""} key={item.key}>
                  <span className="ps-eye">{item.eye}</span>{item.name}{item.done ? <span className="ps-done">済</span> : null}
                </li>
              ))}
            </ul>
          ) : empty}
        </section>
        <section aria-label="視力" className="ps-cell ps-va">
          <h3>視力{vision ? <span className="ps-when">{whenText(vision)}</span> : null}</h3>
          {vision ? (
            <div className="ps-lines mono">
              <p className="ps-sub">{vision.type} &lt;遠見&gt;</p>
              <p><Breakable text={`RV=${vision.far.od || "—"}`} /></p>
              <p><Breakable text={`LV=${vision.far.os || "—"}`} /></p>
              {vision.near ? (
                <>
                  <p className="ps-sub">&lt;近見&gt;</p>
                  <p><Breakable text={`RV=${vision.near.od || "—"}`} /></p>
                  <p><Breakable text={`LV=${vision.near.os || "—"}`} /></p>
                </>
              ) : null}
            </div>
          ) : empty}
        </section>
        <section aria-label="処方" className="ps-cell ps-rx">
          <h3>処方{finalized && prescriptions.length ? <span className="ps-when">【{formatDate(finalized.encounterDate)}】</span> : null}</h3>
          {prescriptions.length ? (
            <ul className="ps-list">
              {prescriptions.map((item, index) => <li key={item.prescriptionId || index}>{prescriptionText(item)}</li>)}
            </ul>
          ) : empty}
        </section>
        <section aria-label="眼圧" className="ps-cell ps-iop">
          <h3>眼圧{iop ? <span className="ps-when">{whenText(iop)}</span> : null}</h3>
          {iop ? (
            <div className="ps-lines mono">
              <p className="ps-sub">測定方法: {IOP_METHOD_LABELS[iop.method] || "—"}</p>
              {[["od", "R"], ["os", "L"]].map(([side, label]) => (
                <p key={side}>&lt;{label}&gt; {iop[side].readings.length ? <>{iop[side].readings.join(" ")}{iop[side].readings.length > 1 ? <strong className="ps-avg"> 平均 {iop[side].average}</strong> : null}</> : "—"}</p>
              ))}
            </div>
          ) : empty}
        </section>
        <section aria-label="病名" className="ps-cell ps-dx">
          <h3>病名</h3>
          {diagnoses.length ? (
            <ul className="ps-list">
              {diagnoses.map((item, index) => <li key={item.diagnosisId || index}>{item.primary ? <span className="ps-primary">主</span> : null}{diagnosisText(item)}</li>)}
            </ul>
          ) : empty}
        </section>
        <section aria-label="患者特記" className="ps-cell ps-memo">
          <h3>患者特記</h3>
          <p className="ps-memo-body">{profile?.patientMemo || ""}</p>
        </section>
      </div>
    </section>
  );
}

// 値の途中（「1.00D」「Ax180°」の中など）で折り返さないよう、区切りごとに nowrap の span にする。
// text は lib/label-layout.mjs の splitAtBreaks で区切る（空白・「×」「=」の後と括弧の前）。parts を渡すと、その単位で区切る（空のものは省く）。
function Breakable({ text = "", parts = null }) {
  const pieces = parts ? parts.filter(Boolean) : splitAtBreaks(text);
  if (!pieces.length) return "—";
  return pieces.map((piece, index) => (
    <span key={index}>{index ? <wbr /> : null}<span className="ps-nw">{parts && index && !/^[(（]/u.test(piece) ? ` ${piece}` : piece}</span></span>
  ));
}

function whenText(item) {
  const day = item.isToday ? "本日" : formatDate(item.date);
  return [day, item.time, item.examiner].filter(Boolean).join(" ");
}

// 一覧で選んだ患者の概要を読む。前回の確定カルテ（GET /patients/:id/chart）と、今日のカルテ（あれば）を合わせる。
// 同じ患者・同じ版は 1 分間覚えておき、選び直しても取り直さない。
const cache = new Map();
const CACHE_MS = 60000;

export function usePatientSummary({ patientId, todayEncounterId = "", todayRevision = 0, doctorName = "" }) {
  const api = useEyeApi();
  const [state, setState] = useState({ summary: null, loading: false, error: "" });
  useEffect(() => {
    if (!patientId) {
      setState({ summary: null, loading: false, error: "" });
      return undefined;
    }
    const key = `${patientId}|${todayEncounterId}|${todayRevision}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setState({ summary: { ...hit.summary, doctorName }, loading: false, error: "" });
      return undefined;
    }
    let active = true;
    setState((current) => ({ summary: current.summary?.patient?.patientId === patientId ? current.summary : null, loading: true, error: "" }));
    Promise.all([
      api(`/v1/eye/patients/${patientId}/chart`),
      todayEncounterId ? api(`/v1/eye/encounters/${todayEncounterId}`).catch(() => null) : Promise.resolve(null)
    ])
      .then(([chart, todayPayload]) => {
        const date = todayIso();
        const lastVisit = (chart.encounters || []).find((item) => item.encounterDate < date)?.encounterDate || "";
        const summary = {
          patient: chart.patient,
          profile: chart.profile,
          latestFinalized: chart.latestFinalized,
          today: todayPayload?.encounter || null,
          lastVisitDate: lastVisit
        };
        cache.set(key, { at: Date.now(), summary });
        if (active) setState({ summary: { ...summary, doctorName }, loading: false, error: "" });
      })
      .catch((nextError) => { if (active) setState({ summary: null, loading: false, error: nextError.message }); });
    return () => { active = false; };
  }, [api, doctorName, patientId, todayEncounterId, todayRevision]);
  return state;
}
