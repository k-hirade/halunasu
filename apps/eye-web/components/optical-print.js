"use client";

import { useEffect, useState } from "react";
import { evaluateOpticalPrescription } from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { addDays, ageOn, formatDate, SEX_LABELS } from "../lib/format";

const PURPOSE_LABELS = { far: "遠用", near: "近用", middle: "中間", progressive: "遠近両用（累進）", bifocal: "二重焦点" };

// 眼鏡処方箋・コンタクトレンズ指示書の印刷。
export function OpticalPrint({ encounterId }) {
  const api = useEyeApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api(`/v1/eye/encounters/${encounterId}`), api("/v1/eye/bootstrap")])
      .then(([detail, bootstrap]) => setData({ encounter: detail.encounter, facility: bootstrap.facilities?.[0] || null }))
      .catch((nextError) => setError(nextError.message));
  }, [api, encounterId]);

  if (error) return <main className="print-page"><p className="alert alert-danger">{error}</p></main>;
  if (!data) return <main className="print-page"><p className="loading">読み込み中…</p></main>;

  const { encounter, facility } = data;
  const optical = encounter.content.optical || {};
  const contact = optical.type === "contact";
  const problems = evaluateOpticalPrescription({ ...optical, issue: true });
  const patient = encounter.patientSnapshot;
  const fmt = (value, signed = true) => (Number.isFinite(value) ? (signed && value > 0 ? `+${value.toFixed(2)}` : signed ? value.toFixed(2) : String(value)) : "—");
  const validUntil = optical.validDays ? addDays(encounter.encounterDate, optical.validDays) : "";

  return (
    <main className="print-page letter">
      <div className="print-toolbar no-print">
        {encounter.status !== "finalized" ? <span className="draft-mark">カルテ未確定</span> : null}
        {!optical.issue ? <span className="draft-mark">「発行する」になっていません</span> : null}
        <button className="btn btn-primary" onClick={() => window.print()} type="button">印刷する</button>
      </div>
      {problems.length ? <ul className="readiness no-print">{problems.map((item, index) => <li className="is-blocker" key={index}>{item.message}</li>)}</ul> : null}
      <h1 className="letter-title">{contact ? "コンタクトレンズ指示書" : "眼鏡処方箋"}</h1>
      <table className="exam-table print-table letter-patient">
        <tbody>
          <tr><th>氏名</th><td>{patient.displayName}（{patient.displayNameKana}）</td><th>性別・年齢</th><td>{SEX_LABELS[patient.sex]} {ageOn(patient.birthDate, encounter.encounterDate) ?? "—"}歳</td></tr>
          <tr><th>処方日</th><td>{formatDate(encounter.encounterDate)}</td><th>用途</th><td>{PURPOSE_LABELS[optical.purpose] || "—"}</td></tr>
        </tbody>
      </table>
      <table className="exam-table print-table optical-print-table">
        <thead>
          <tr>
            <th />
            <th>球面（S）</th><th>円柱（C）</th><th>軸（Ax）</th>
            {contact ? <><th>BC</th><th>DIA</th><th>製品</th></> : <><th>加入（ADD）</th><th>プリズム</th><th>基底</th></>}
            <th>矯正視力</th>
          </tr>
        </thead>
        <tbody>
          {["od", "os"].map((side) => (
            <tr key={side}>
              <th>{side === "od" ? "右（R）" : "左（L）"}</th>
              <td>{fmt(optical[side]?.sphere)}</td>
              <td>{fmt(optical[side]?.cylinder)}</td>
              <td>{Number.isFinite(optical[side]?.axis) ? `${optical[side].axis}°` : "—"}</td>
              {contact ? (
                <>
                  <td>{fmt(optical[side]?.bc, false)}</td>
                  <td>{fmt(optical[side]?.dia, false)}</td>
                  <td>{optical[side]?.product || "—"}</td>
                </>
              ) : (
                <>
                  <td>{fmt(optical[side]?.add)}</td>
                  <td>{fmt(optical[side]?.prism, false)}</td>
                  <td>{optical[side]?.base || "—"}</td>
                </>
              )}
              <td>{optical[side]?.va || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{!contact ? `瞳孔間距離（PD） ${Number.isFinite(optical.pd) ? `${optical.pd} mm` : "—"}　` : ""}{validUntil ? `有効期限 ${formatDate(validUntil)}まで` : ""}</p>
      {optical.note ? <p className="pre">備考: {optical.note}</p> : null}
      <div className="letter-sender">
        <p>{facility?.legalName || facility?.displayName || ""}</p>
        {facility?.phone ? <p>TEL {facility.phone}</p> : null}
        <p>医師 {encounter.finalizedBy?.displayName || encounter.updatedBy?.displayName || ""}</p>
      </div>
    </main>
  );
}
