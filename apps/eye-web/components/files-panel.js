"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEyeApi, useEyeFileTransfer } from "./eye-api";
import { EYE_LABELS, formatDate, formatDateTime, todayIso } from "../lib/format";

export const FILE_KIND_LABELS = {
  oct: "OCT",
  vf: "視野",
  fundus_photo: "眼底写真",
  anterior_photo: "前眼部写真",
  topography: "角膜形状",
  paper_chart: "紙カルテ",
  referral_in: "他院からの紹介状",
  other: "その他"
};
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 20 * 1024 * 1024;

// ファイルの閲覧用 URL。開発用のメモリ保管はログイン付きで取得して blob URL にする。
export function useFileObjectUrl() {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  return useCallback(async (fileId) => {
    const { download } = await api(`/v1/eye/files/${fileId}/url`);
    if (/^https?:\/\//u.test(download.url)) return download.url;
    const response = await transfer(download.url);
    return URL.createObjectURL(await response.blob());
  }, [api, transfer]);
}

// 患者のファイル（検査結果・写真・紙カルテ）。取り込みと一覧。
export function FilesPanel({ patientId, encounterId = "", context, onChanged }) {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  const objectUrl = useFileObjectUrl();
  const [files, setFiles] = useState(null);
  const [form, setForm] = useState({ kind: "oct", eye: "ou", takenOn: todayIso(), title: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/patients/${patientId}/files`);
    setFiles(payload.files);
  }, [api, patientId]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  async function upload(event) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("20MB を超えるファイルは取り込めません。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const started = await api("/v1/eye/files/uploads", {
        method: "POST",
        body: { patientId, encounterId, ...form, title: form.title || file.name, fileName: file.name, contentType: file.type, size: file.size }
      });
      await transfer(started.upload.url, { method: "PUT", headers: started.upload.headers, body: file });
      await api(`/v1/eye/files/${started.file.fileId}/complete`, { method: "POST", body: {} });
      inputRef.current.value = "";
      setForm({ ...form, title: "" });
      await load();
      onChanged?.();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function open(file) {
    try {
      setViewing({ file, url: await objectUrl(file.fileId) });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const canUpload = Boolean(context?.canWriteDocuments);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>画像・ファイル</h2>
        <a className="btn btn-chip" href={`/patients/${patientId}/images`}>比較表示</a>
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {canUpload ? (
        <form className="upload-form" onSubmit={upload}>
          <input accept={ACCEPT} aria-label="ファイル" className="input" ref={inputRef} required type="file" />
          <div className="row-line">
            <select aria-label="ファイルの種類" className="input" onChange={(event) => setForm({ ...form, kind: event.target.value })} value={form.kind}>
              {Object.entries(FILE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select aria-label="ファイルの眼" className="input" onChange={(event) => setForm({ ...form, eye: event.target.value })} value={form.eye}>
              <option value="">眼の指定なし</option>
              {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input aria-label="検査日" className="input" onChange={(event) => setForm({ ...form, takenOn: event.target.value })} type="date" value={form.takenOn} />
          </div>
          <div className="row-line">
            <input aria-label="ファイルの題名" className="input grow" onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="題名（省略時はファイル名）" value={form.title} />
            <button className="btn btn-primary" disabled={busy} type="submit">{busy ? "取り込み中…" : "取り込む"}</button>
          </div>
          <p className="muted small">PDF・JPEG・PNG・WebP、20MB まで。</p>
        </form>
      ) : null}
      {files === null ? <p className="loading">読み込み中…</p> : files.length === 0 ? <p className="empty">ファイルはまだありません。</p> : (
        <ul className="plain file-list">
          {files.map((file) => (
            <li key={file.fileId}>
              <button className="file-link" onClick={() => open(file)} type="button">{file.title}</button>
              <span className="muted small"> {FILE_KIND_LABELS[file.kind]} {file.eye ? EYE_LABELS[file.eye] : ""} {formatDate(file.takenOn)}</span>
              {file.kind === "paper_chart" ? (
                <span className={`tag ${file.paper?.reviewedBy ? "tag-ok" : "tag-warn"}`}>{file.paper?.reviewedBy ? "要約確認済み" : "要約未確認"}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {viewing ? (
        <FileViewerDialog
          context={context}
          file={viewing.file}
          onClose={() => setViewing(null)}
          onSaved={async () => { setViewing(null); await load(); onChanged?.(); }}
          url={viewing.url}
        />
      ) : null}
    </section>
  );
}

export function FilePreview({ file, url }) {
  if (!url) return <div className="file-preview is-empty">表示するファイルを選んでください</div>;
  return file.contentType === "application/pdf"
    ? <iframe className="file-preview" src={url} title={file.title} />
    : <img alt={file.title} className="file-preview" src={url} />;
}

function FileViewerDialog({ file, url, context, onClose, onSaved }) {
  const api = useEyeApi();
  const [summary, setSummary] = useState(file.paper?.summary || "");
  const [reason, setReason] = useState("");
  const [current, setCurrent] = useState(file);
  const [error, setError] = useState("");

  async function saveSummary() {
    try {
      const payload = await api(`/v1/eye/files/${current.fileId}`, { method: "PATCH", body: { expectedRevision: current.revision, summary } });
      setCurrent(payload.file);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function review() {
    try {
      const payload = await api(`/v1/eye/files/${current.fileId}/review`, { method: "POST", body: { expectedRevision: current.revision } });
      setCurrent(payload.file);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function archive() {
    try {
      await api(`/v1/eye/files/${current.fileId}/archive`, { method: "POST", body: { expectedRevision: current.revision, reason } });
      onSaved();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="viewer-heading" className="dialog dialog-viewer" role="dialog">
        <div className="panel-head">
          <h2 id="viewer-heading">{current.title}</h2>
          <button className="btn btn-ghost" onClick={onClose} type="button">閉じる</button>
        </div>
        <p className="muted small">{FILE_KIND_LABELS[current.kind]} {current.eye ? EYE_LABELS[current.eye] : ""} ・ 検査日 {formatDate(current.takenOn)} ・ 取り込み {formatDateTime(current.createdAt)} {current.uploadedBy?.displayName}</p>
        {error ? <p className="alert alert-danger">{error}</p> : null}
        <FilePreview file={current} url={url} />
        {current.kind === "paper_chart" ? (
          <div className="paper-summary">
            <label className="field">
              <span>紙カルテの要約（病名・処方の変更・視力や眼圧の推移など）</span>
              <textarea className="input" disabled={!context?.canWriteDocuments} onChange={(event) => setSummary(event.target.value)} rows={4} value={summary} />
            </label>
            <div className="row-line">
              {context?.canWriteDocuments ? <button className="btn btn-ghost" disabled={summary === (current.paper?.summary || "")} onClick={saveSummary} type="button">要約を保存</button> : null}
              {current.paper?.reviewedBy ? (
                <span className="confirm-ok">医師確認済み（{current.paper.reviewedBy.displayName} {formatDateTime(current.paper.reviewedAt)}）</span>
              ) : context?.canFinalize ? (
                <button className="btn btn-primary" disabled={!current.paper?.summary || summary !== current.paper.summary} onClick={review} type="button">要約を確認済みにする</button>
              ) : <span className="confirm-pending">医師の確認待ち</span>}
            </div>
          </div>
        ) : null}
        {context?.canFinalize ? (
          <details className="archive-box">
            <summary>このファイルを削除する</summary>
            <div className="row-line">
              <input aria-label="削除の理由" className="input grow" onChange={(event) => setReason(event.target.value)} placeholder="理由（例: 別の患者のファイルだった）" value={reason} />
              <button className="btn btn-danger" disabled={!reason.trim()} onClick={archive} type="button">削除する</button>
            </div>
            <p className="muted small">一覧から消えますが、記録は残ります。</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
