"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { SKETCH_TEMPLATE_LABELS, SketchPad } from "./sketch-pad";
import {
  diagnosisText,
  EYE_LABELS,
  formatDate,
  formatDateTime,
  formatRefraction,
  IOP_METHOD_LABELS,
  patientLine,
  prescriptionText,
  VISIT_TYPE_LABELS
} from "../lib/format";

// 印刷用の1枚。版番号の指定があれば確定済みの版をそのまま出す。
export function PrintView({ encounterId }) {
  const api = useEyeApi();
  const searchParams = useSearchParams();
  const versionNumber = searchParams.get("version");
  const [record, setRecord] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const detail = await api(`/v1/eye/encounters/${encounterId}`);
      if (versionNumber) {
        const { version } = await api(`/v1/eye/encounters/${encounterId}/versions/${Number(versionNumber)}`);
        setRecord({ encounter: detail.encounter, content: version.content, encounterDate: version.encounterDate, visitType: version.visitType, version });
      } else {
        setRecord({ encounter: detail.encounter, content: detail.encounter.content, encounterDate: detail.encounter.encounterDate, visitType: detail.encounter.visitType, version: null });
      }
    })().catch((nextError) => setError(nextError.message));
  }, [api, encounterId, versionNumber]);

  if (error) return <main className="print-page"><p className="alert alert-danger">{error}</p></main>;
  if (!record) return <main className="print-page"><p className="loading">読み込み中…</p></main>;

  const { encounter, content, version } = record;
  const status = version
    ? `確定 v${version.version}（${formatDateTime(version.finalizedAt)} ${version.finalizedBy?.displayName || ""}）`
    : encounter.status === "finalized"
      ? `確定 v${encounter.versionCount}（${formatDateTime(encounter.finalizedAt)} ${encounter.finalizedBy?.displayName || ""}）`
      : "下書き（未確定）";

  return (
    <main className="print-page">
      <div className="print-toolbar no-print">
        <button className="btn btn-primary" onClick={() => window.print()} type="button">印刷する</button>
      </div>
      <header className="print-head">
        <div>
          <h1>{encounter.patientSnapshot.displayName}<span className="kana"> {encounter.patientSnapshot.displayNameKana}</span></h1>
          <p>{patientLine(encounter.patientSnapshot)}</p>
        </div>
        <div className="print-meta">
          <p>{formatDate(record.encounterDate)}　{VISIT_TYPE_LABELS[record.visitType]}</p>
          <p className={encounter.status === "finalized" || version ? "" : "draft-mark"}>{status}</p>
        </div>
      </header>

      {content.chiefComplaint || content.history ? (
        <section>
          <h2>主訴・経過</h2>
          {content.chiefComplaint ? <p><strong>主訴</strong> {content.chiefComplaint}</p> : null}
          {content.history ? <p className="pre">{content.history}</p> : null}
        </section>
      ) : null}

      <section>
        <h2>検査</h2>
        <table className="exam-table print-table">
          <thead><tr><th /><th>右眼</th><th>左眼</th></tr></thead>
          <tbody>
            <tr><th>裸眼視力</th>{["od", "os"].map((side) => <td key={side}>{content.exam[side].vaUncorrected || "—"}</td>)}</tr>
            <tr><th>矯正視力</th>{["od", "os"].map((side) => <td key={side}>{content.exam[side].vaCorrected || "—"} {formatRefraction(content.exam[side].correction)}</td>)}</tr>
            <tr><th>他覚屈折</th>{["od", "os"].map((side) => <td key={side}>{formatRefraction(content.exam[side].refraction) || "—"}</td>)}</tr>
            <tr><th>眼圧</th>{["od", "os"].map((side) => <td key={side}>{content.exam[side].iop ?? "—"}{content.exam[side].iop !== null ? " mmHg" : ""} {IOP_METHOD_LABELS[content.exam[side].iopMethod] || ""}</td>)}</tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>所見</h2>
        <table className="exam-table print-table">
          <thead><tr><th /><th>右眼</th><th>左眼</th></tr></thead>
          <tbody>
            {[["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]].map(([key, label]) => (
              <tr key={key}><th>{label}</th>{["od", "os"].map((side) => <td className="pre" key={side}>{content.findings[side][key] || "—"}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </section>

      {content.sketches.length ? (
        <section>
          <h2>シェーマ</h2>
          <div className="print-sketches">
            {content.sketches.map((sketch) => (
              <figure key={sketch.sketchId}>
                <SketchPad onChange={() => {}} readOnly sketch={sketch} />
                <figcaption>{EYE_LABELS[sketch.eye]} {SKETCH_TEMPLATE_LABELS[sketch.template]}{sketch.caption ? `：${sketch.caption}` : ""}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2>病名</h2>
        <p>{content.diagnoses.map(diagnosisText).join("、") || "—"}</p>
      </section>
      {content.assessment || content.plan ? (
        <section>
          <h2>評価・方針</h2>
          {content.assessment ? <p className="pre">{content.assessment}</p> : null}
          {content.plan ? <p className="pre">{content.plan}</p> : null}
        </section>
      ) : null}
      <section>
        <h2>処方</h2>
        {content.prescriptions.length ? <ul>{content.prescriptions.map((item, index) => <li key={index}>{prescriptionText(item)}</li>)}</ul> : <p>—</p>}
      </section>
      <section>
        <h2>次回</h2>
        <p>{content.nextVisit.intervalWeeks ? `${content.nextVisit.intervalWeeks}週後` : "—"}{content.nextVisit.note ? `　${content.nextVisit.note}` : ""}</p>
      </section>
      {version?.amendmentReason ? <p className="small">修正理由: {version.amendmentReason}</p> : null}
      {version ? <p className="small muted">内容ハッシュ: {version.contentHash}</p> : null}
    </main>
  );
}
