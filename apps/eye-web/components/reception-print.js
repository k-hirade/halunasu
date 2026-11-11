"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { facilityInfo, pickFacility, PrintMessage, PrintShell, readStoredPaper, storePaper } from "./print-shell";
import { useEyeApi } from "./eye-api";
import { weekdayOf } from "./mini-calendar";
import { doctorName, useDoctors } from "./use-doctors";
import { ageOn, APPOINTMENT_PURPOSE_LABELS, SEX_LABELS, todayIso } from "../lib/format";
import { historyTime } from "../lib/reception-extras";
import { birthWithEra, queueLabel } from "../lib/reception-table";

const PAPER_KEY = "halunasu-eye-reception-slip-paper";

// 予約票（患者に渡す）と受付票（院内を回る受診票）。用紙は A5 / A4（端末に記憶）。
export function ReceptionPrint({ appointmentId }) {
  const api = useEyeApi();
  const doctors = useDoctors();
  const params = useSearchParams();
  const kind = params.get("kind") === "visit" ? "visit" : "booking";
  const withMemo = params.get("memo") === "1";
  const [state, setState] = useState({ loading: true, error: "", appointment: null, facility: null });
  const [paper, setPaper] = useState("A5");

  useEffect(() => { setPaper(readStoredPaper(PAPER_KEY, "A5")); }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([api(`/v1/eye/appointments/${encodeURIComponent(appointmentId)}`), api("/v1/eye/bootstrap").catch(() => ({ facilities: [] }))])
      .then(async ([detail, bootstrap]) => {
        // 患者番号は受付の写しに無いので、いまの患者情報から入れる（読めなければ写しのまま）
        const patientId = detail.appointment.patientId;
        const patient = patientId ? await api(`/v1/eye/patients/${patientId}`).then((payload) => payload.patient).catch(() => null) : null;
        const appointment = patient ? { ...detail.appointment, patientSnapshot: { ...detail.appointment.patientSnapshot, primaryPatientNumber: patient.primaryPatientNumber || "" } } : detail.appointment;
        if (alive) setState({ loading: false, error: "", appointment, facility: pickFacility(bootstrap.facilities || []) });
      })
      .catch((error) => { if (alive) setState({ loading: false, error: error.message, appointment: null, facility: null }); });
    return () => { alive = false; };
  }, [api, appointmentId]);

  const back = { backHref: `/reception${state.appointment ? `?date=${state.appointment.date}` : ""}`, backLabel: "受付へ" };
  if (state.loading) return <PrintMessage {...back}><p className="muted">読み込み中…</p></PrintMessage>;
  if (state.error) return <PrintMessage {...back}><p className="alert alert-danger" role="alert">{state.error}</p></PrintMessage>;

  const item = state.appointment;
  const facility = facilityInfo(state.facility);
  const snapshot = item.patientSnapshot || {};
  const title = kind === "visit" ? "受付票" : "予約票";
  const dateLabel = `${item.date.replaceAll("-", "/")}（${weekdayOf(item.date)}）`;
  const doctor = item.doctorMemberId ? doctorName(doctors, item.doctorMemberId) : "";
  const age = ageOn(snapshot.birthDate, item.date);

  return (
    <PrintShell
      {...back}
      draft={false}
      onPaperChange={(value) => { setPaper(value); storePaper(PAPER_KEY, value); }}
      paper={paper}
      paperOptions={["A5", "A4"]}
      sheetClassName="rcp-sheet"
      statusLabel={item.status === "cancelled" ? "取消済みの受付" : "印刷できます"}
      subject={item.patientName}
      title={title}
    >
      <header className="rcp-head">
        <h1 className="rcp-title">{title}</h1>
        <span className="rcp-issued">発行日 {todayIso().replaceAll("-", "/")}</span>
      </header>
      {item.status === "cancelled" ? <p className="rcp-cancelled">この受付は取り消されています</p> : null}
      <dl className="rcp-patient">
        <div><dt>患者番号</dt><dd className="mono">{snapshot.primaryPatientNumber || "—"}</dd></div>
        <div><dt>氏名</dt><dd><span className="rcp-name">{item.patientName}</span> 様</dd></div>
        {kind === "visit" ? <div><dt>生年月日</dt><dd className="mono">{birthWithEra(snapshot.birthDate)}{age !== null ? `（${age}歳${snapshot.sex && snapshot.sex !== "unknown" ? `・${SEX_LABELS[snapshot.sex]}` : ""}）` : ""}</dd></div> : null}
      </dl>

      {kind === "booking" ? (
        <>
          <table className="rcp-table">
            <tbody>
              <tr><th scope="row">予約日</th><td>{dateLabel}</td></tr>
              <tr><th scope="row">予約時間</th><td>{item.time || "時刻の指定なし"}</td></tr>
              <tr><th scope="row">担当医</th><td>{doctor || "—"}</td></tr>
              <tr><th scope="row">診療科</th><td>{item.department || "—"}</td></tr>
              {withMemo && (item.receptionMemo || item.note) ? <tr><th scope="row">備考</th><td className="rcp-memo">{item.receptionMemo || item.note}</td></tr> : null}
            </tbody>
          </table>
          <ul className="rcp-notes">
            <li>ご来院の際は、診察券とこの予約票をお持ちください。</li>
            <li>ご都合が悪くなったときは、お早めにお電話でお知らせください。</li>
          </ul>
        </>
      ) : (
        <>
          <div className="rcp-number">
            <span className="rcp-number-label">受付番号</span>
            <strong className="rcp-number-value">{queueLabel(item)}</strong>
            <span className="rcp-number-time">{historyTime(item.checkedInAt) || dateLabel}</span>
          </div>
          <table className="rcp-table">
            <tbody>
              <tr><th scope="row">受付日</th><td>{dateLabel}{item.time ? `（予約 ${item.time}）` : ""}</td></tr>
              <tr><th scope="row">目的</th><td>{APPOINTMENT_PURPOSE_LABELS[item.purpose] || "—"}</td></tr>
              <tr><th scope="row">診療科・担当医</th><td>{[item.department, doctor].filter(Boolean).join("・") || "—"}</td></tr>
              {(item.receptionLabels || []).length ? <tr><th scope="row">ラベル</th><td>{item.receptionLabels.join("・")}</td></tr> : null}
              {item.receptionMemo || item.note ? <tr><th scope="row">受付メモ</th><td className="rcp-memo">{item.receptionMemo || item.note}</td></tr> : null}
            </tbody>
          </table>
          {/* 院内を回るときの記入欄（済んだら印を付ける） */}
          <table className="rcp-checks">
            <thead><tr><th scope="col">検査・処置</th><th scope="col">済</th><th scope="col">担当</th><th scope="col">メモ</th></tr></thead>
            <tbody>
              {["視力", "眼圧", "屈折・角膜曲率", "散瞳", "", ""].map((label, index) => (
                <tr key={`${label}${index}`}><td>{label}</td><td /><td /><td /></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <footer className="rcp-facility">
        <strong>{facility.name}</strong>
        {facility.address ? <span>{facility.postalCode ? `〒${facility.postalCode} ` : ""}{facility.address}</span> : null}
        {facility.phone ? <span>電話 {facility.phone}</span> : null}
      </footer>
    </PrintShell>
  );
}
