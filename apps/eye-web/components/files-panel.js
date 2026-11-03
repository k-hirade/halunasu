"use client";

import Link from "next/link";
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

export function isImageFile(file) {
  return /^image\//u.test(file?.contentType || "");
}

export function revokeObjectUrl(url) {
  if (typeof url === "string" && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

// 表示用 URL を fileId ごとに読み込む。使わなくなった blob URL とアンマウント時はすべて解放する。
export function useFileUrls(fileIds) {
  const objectUrl = useFileObjectUrl();
  const [urls, setUrls] = useState({});
  const [failed, setFailed] = useState({});
  const urlsRef = useRef({});
  const key = [...new Set(fileIds.filter(Boolean))].sort().join(",");

  useEffect(() => {
    const wanted = new Set(key ? key.split(",") : []);
    let cancelled = false;
    const kept = {};
    for (const [fileId, url] of Object.entries(urlsRef.current)) {
      if (wanted.has(fileId)) kept[fileId] = url;
      else revokeObjectUrl(url);
    }
    urlsRef.current = kept;
    setUrls(kept);
    for (const fileId of wanted) {
      if (kept[fileId]) continue;
      objectUrl(fileId)
        .then((url) => {
          if (cancelled) {
            revokeObjectUrl(url);
            return;
          }
          urlsRef.current = { ...urlsRef.current, [fileId]: url };
          setUrls(urlsRef.current);
        })
        .catch(() => { if (!cancelled) setFailed((current) => ({ ...current, [fileId]: true })); });
    }
    return () => { cancelled = true; };
  }, [key, objectUrl]);

  useEffect(() => () => {
    for (const url of Object.values(urlsRef.current)) revokeObjectUrl(url);
    urlsRef.current = {};
  }, []);

  return { urls, failed };
}

export function byNewest(left, right) {
  return String(right.takenOn || "").localeCompare(String(left.takenOn || "")) || String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

// 種類ごとに最新 1 件（新しい順、最大 limit 件）。
export function latestPerKind(files, limit = 4) {
  const seen = new Set();
  const picked = [];
  for (const file of [...files].sort(byNewest)) {
    if (seen.has(file.kind)) continue;
    seen.add(file.kind);
    picked.push(file);
    if (picked.length >= limit) break;
  }
  return picked;
}

export const EYE_SHORT_LABELS = { od: "右", os: "左", ou: "両" };

// 今年の日付は月/日だけにする（サムネイルの幅に収める）
export function compactDate(iso) {
  if (!iso) return "";
  return iso.slice(0, 4) === todayIso().slice(0, 4) ? formatDate(iso).slice(5) : formatDate(iso).slice(2);
}

export function shortDate(iso) {
  return iso ? formatDate(iso).slice(2) : "";
}

// 患者のファイル（検査結果・写真・紙カルテ）。種類ごとの最新をサムネイルで出し、取り込みはダイアログで行う。
export function FilesPanel({ patientId, context, onChanged, onUpload, reloadKey = 0 }) {
  const api = useEyeApi();
  const objectUrl = useFileObjectUrl();
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/patients/${patientId}/files`);
    setFiles(payload.files);
  }, [api, patientId]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load, reloadKey]);

  const thumbs = files ? latestPerKind(files, 4) : [];
  const { urls, failed } = useFileUrls(thumbs.filter(isImageFile).map((file) => file.fileId));

  async function open(file) {
    try {
      setViewing({ file, url: await objectUrl(file.fileId) });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  function close() {
    revokeObjectUrl(viewing?.url);
    setViewing(null);
  }

  const canUpload = Boolean(context?.canWriteDocuments) && Boolean(onUpload);
  const others = files ? files.length - thumbs.length : 0;
  return (
    <section className="panel side-panel">
      <div className="side-head">
        <h2>画像{files?.length ? <span className="side-count">{files.length}</span> : null}</h2>
        <span className="side-head-actions">
          {files?.length ? <Link className="btn btn-chip btn-sm" href={`/patients/${patientId}/images`}>比較 ›</Link> : null}
          {canUpload ? <button className="btn btn-chip btn-sm" onClick={onUpload} type="button">＋取込</button> : null}
        </span>
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {files === null ? <p className="loading">読み込み中…</p> : files.length === 0 ? <p className="empty">ファイルはまだありません。</p> : (
        <>
          <ul className="thumb-grid">
            {thumbs.map((file) => (
              <li key={file.fileId}>
                <button aria-label={file.title} className="thumb" onClick={() => open(file)} title={`${file.title}（${formatDate(file.takenOn)}）`} type="button">
                  <ThumbImage failed={failed[file.fileId]} file={file} url={urls[file.fileId]} />
                  <span className="thumb-caption">
                    <strong>{FILE_KIND_LABELS[file.kind] || "ファイル"}</strong>
                    <span>{file.eye ? `${EYE_SHORT_LABELS[file.eye]} ` : ""}{compactDate(file.takenOn)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {others > 0 ? (
            <button aria-expanded={showAll} className="side-more" onClick={() => setShowAll(!showAll)} type="button">
              {showAll ? "一覧を閉じる" : `ほか ${others}件を一覧で見る`}
            </button>
          ) : null}
          {showAll ? (
            <ul className="side-list">
              {[...files].sort(byNewest).map((file) => (
                <li key={file.fileId}>
                  <button className="side-row" onClick={() => open(file)} type="button">
                    <span className="side-row-date">{shortDate(file.takenOn)}</span>
                    <span className="side-row-title">{file.title}</span>
                    <span className="side-row-meta">{FILE_KIND_LABELS[file.kind]}{file.eye ? ` ${EYE_SHORT_LABELS[file.eye]}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {viewing ? (
        <FileViewerDialog
          context={context}
          file={viewing.file}
          onClose={close}
          onSaved={async () => { close(); await load(); onChanged?.(); }}
          url={viewing.url}
        />
      ) : null}
    </section>
  );
}

export function ThumbImage({ file, url, failed }) {
  if (isImageFile(file) && url) return <img alt="" className="thumb-img" decoding="async" loading="lazy" src={url} />;
  const label = file.contentType === "application/pdf" ? "PDF" : isImageFile(file) ? (failed ? "表示不可" : "…") : "ファイル";
  return <span aria-hidden="true" className="thumb-img is-icon">{label}</span>;
}

// 取り込みダイアログ。患者ページと画像の比較で共通に使う。ファイル選択欄はドロップ先も兼ねる。
export function UploadDialog({ patientId, encounterId = "", defaultKind = "oct", onClose, onUploaded }) {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  const [form, setForm] = useState({ kind: defaultKind, eye: "ou", takenOn: todayIso(), title: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer?.files;
    if (!dropped?.length || !inputRef.current) return;
    try {
      inputRef.current.files = dropped;
      setFileName(dropped[0].name);
    } catch {
      setError("「ファイルを選択」から選んでください。");
    }
  }

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
      setBusy(false);
      onClose();
      onUploaded?.(started.file);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="upload-heading" className="dialog upload-dialog" onSubmit={upload} role="dialog">
        <h2 id="upload-heading">画像・ファイルを取り込む</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {/* ブラウザ標準の「Choose File」は英語表示になるため、見た目は日本語のボタンにする */}
        <label
          className={`file-picker file-drop${dragging ? " is-dragging" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDrop={onDrop}
        >
          <input accept={ACCEPT} aria-label="ファイル" className="file-picker-input" onChange={(event) => setFileName(event.target.files?.[0]?.name || "")} ref={inputRef} required type="file" />
          <span className="btn btn-ghost" aria-hidden="true">ファイルを選択</span>
          <span className={fileName ? "file-picker-name" : "muted small"}>{fileName || "またはここにドロップ（PDF・JPEG・PNG・WebP、20MB まで）"}</span>
        </label>
        <div className="upload-fields">
          <label className="field">
            <span>種類</span>
            <select aria-label="ファイルの種類" className="input" onChange={(event) => setForm({ ...form, kind: event.target.value })} value={form.kind}>
              {Object.entries(FILE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>眼</span>
            <select aria-label="ファイルの眼" className="input" onChange={(event) => setForm({ ...form, eye: event.target.value })} value={form.eye}>
              <option value="">指定なし</option>
              {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>検査日</span>
            <input aria-label="検査日" className="input" onChange={(event) => setForm({ ...form, takenOn: event.target.value })} type="date" value={form.takenOn} />
          </label>
        </div>
        <label className="field">
          <span>題名</span>
          <input aria-label="ファイルの題名" className="input" onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="省略時はファイル名" value={form.title} />
        </label>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onClose} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy} type="submit">{busy ? "取り込み中…" : "取り込む"}</button>
        </div>
      </form>
    </div>
  );
}

export function FilePreview({ file, url }) {
  if (!url) return <div className="file-preview is-empty">表示するファイルを選んでください</div>;
  return file.contentType === "application/pdf"
    ? <iframe className="file-preview" src={url} title={file.title} />
    : <img alt={file.title} className="file-preview" src={url} />;
}

export function FileViewerDialog({ file, url, context, onClose, onSaved }) {
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
