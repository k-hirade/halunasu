"use client";

import { useEffect, useMemo, useState } from "react";
import { useEyeApi } from "./eye-api";
import { FILE_KIND_LABELS, FilePreview, useFileObjectUrl } from "./files-panel";
import { EYE_LABELS, formatDate, patientLine } from "../lib/format";

// 画像の比較。種類と眼を選び、左右に日付の違う検査を並べる（判定はしない）。
export function ImageCompare({ patientId }) {
  const api = useEyeApi();
  const objectUrl = useFileObjectUrl();
  const [patient, setPatient] = useState(null);
  const [files, setFiles] = useState([]);
  const [kind, setKind] = useState("oct");
  const [eye, setEye] = useState("");
  const [selection, setSelection] = useState({ left: "", right: "" });
  const [urls, setUrls] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api(`/v1/eye/patients/${patientId}`), api(`/v1/eye/patients/${patientId}/files`)])
      .then(([patientPayload, filesPayload]) => {
        setPatient(patientPayload.patient);
        setFiles(filesPayload.files);
        const kinds = [...new Set(filesPayload.files.map((item) => item.kind))];
        if (kinds.length && !kinds.includes("oct")) setKind(kinds[0]);
      })
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId]);

  const candidates = useMemo(() => files
    .filter((item) => item.kind === kind && (!eye || item.eye === eye || item.eye === "ou"))
    .sort((left, right) => right.takenOn.localeCompare(left.takenOn)), [files, kind, eye]);

  useEffect(() => {
    setSelection({ left: candidates[1]?.fileId || "", right: candidates[0]?.fileId || "" });
  }, [candidates]);

  useEffect(() => {
    for (const fileId of [selection.left, selection.right]) {
      if (!fileId || urls[fileId]) continue;
      objectUrl(fileId)
        .then((url) => setUrls((current) => ({ ...current, [fileId]: url })))
        .catch((nextError) => setError(nextError.message));
    }
  }, [objectUrl, selection, urls]);

  const byId = new Map(files.map((item) => [item.fileId, item]));
  return (
    <main className="eye-page">
      <a className="back-link" href={`/patients/${patientId}`}>← カルテ一覧</a>
      <header className="page-head">
        <div>
          <h1>画像の比較{patient ? ` ・ ${patient.displayName}` : ""}</h1>
          {patient ? <p className="page-sub">{patientLine(patient)}</p> : null}
        </div>
        <div className="head-actions">
          <select aria-label="種類" className="input" onChange={(event) => setKind(event.target.value)} value={kind}>
            {Object.entries(FILE_KIND_LABELS).filter(([value]) => value !== "paper_chart").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="眼" className="input" onChange={(event) => setEye(event.target.value)} value={eye}>
            <option value="">両眼とも</option>
            <option value="od">右眼</option>
            <option value="os">左眼</option>
          </select>
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {candidates.length === 0 ? <p className="empty">この種類のファイルはまだありません。患者ページの「画像・ファイル」から取り込めます。</p> : (
        <div className="compare-grid">
          {["left", "right"].map((side) => {
            const file = byId.get(selection[side]);
            return (
              <section className="panel" key={side}>
                <select aria-label={side === "left" ? "比較元" : "比較先"} className="input" onChange={(event) => setSelection({ ...selection, [side]: event.target.value })} value={selection[side]}>
                  <option value="">選択してください</option>
                  {candidates.map((item) => <option key={item.fileId} value={item.fileId}>{formatDate(item.takenOn)} {item.eye ? EYE_LABELS[item.eye] : ""} {item.title}</option>)}
                </select>
                {file ? <FilePreview file={file} url={urls[file.fileId]} /> : <FilePreview file={{}} url="" />}
              </section>
            );
          })}
        </div>
      )}
      <p className="muted small">比較表示は記録の確認用です。変化の判定は医師が行います。</p>
    </main>
  );
}
