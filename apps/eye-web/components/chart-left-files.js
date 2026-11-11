"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { closeMenu } from "./chart-shared";
import { inPortal } from "./chart-left-shared";
import { DOCUMENT_TEMPLATES, DOCUMENT_TYPE_LABELS } from "./documents-panel";
import { useEyeApi } from "./eye-api";
import { EYE_SHORT_LABELS, FILE_KIND_LABELS, FileViewerDialog, revokeObjectUrl, useFileObjectUrl } from "./files-panel";
import { formatDate } from "../lib/format";

// 左「ファイル」（デジカルのファイルタブ）。上に［文書作成 ▾］［文書雛形 ▾］［⟳］［＋］、下に文書と取り込みファイルを 1 つの表（日付の新しい順）。
// - 文書作成: 書式（紹介状・返書・診断書…）を選ぶと、カルテの内容を差し込んだ下書きを作って開く。
// - 文書雛形: この患者の過去の文書を雛形にして複製し、今日の日付の下書きとして開く。
// - ＋: 画像・PDF の取り込み。行の［開く］で文書の編集・ファイルの表示、［印刷］は確定済みの文書だけ。
export function FilesTab({ patientId, encounterId = "", context, onUpload = null, reloadKey = 0 }) {
  const api = useEyeApi();
  const router = useRouter();
  const objectUrl = useFileObjectUrl();
  const [documents, setDocuments] = useState(null);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const canWrite = Boolean(context?.canWriteDocuments);

  const load = useCallback(async () => {
    const [docs, stored] = await Promise.all([
      api(`/v1/eye/patients/${patientId}/documents`),
      api(`/v1/eye/patients/${patientId}/files`)
    ]);
    setDocuments(docs.documents || []);
    setFiles(stored.files || []);
  }, [api, patientId]);

  useEffect(() => {
    setError("");
    load().catch((nextError) => setError(nextError.message));
  }, [load, reloadKey]);

  const rows = useMemo(() => {
    if (!documents || !files) return null;
    return [
      ...documents.map((item) => ({ key: `d-${item.documentId}`, kind: "document", date: item.issueDate || "", updatedAt: item.updatedAt || "", item })),
      ...files.map((item) => ({ key: `f-${item.fileId}`, kind: "file", date: item.takenOn || "", updatedAt: item.createdAt || "", item }))
    ].sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt));
  }, [documents, files]);
  const pastDocuments = (documents || []).filter((item) => item.status !== "discarded").slice(0, 20);

  async function reload() {
    setBusy(true);
    setError("");
    try {
      await load();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function create(type) {
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/documents", { method: "POST", body: { patientId, encounterId, type } });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  async function fromTemplate(documentId) {
    setBusy(true);
    setError("");
    try {
      const payload = await api(`/v1/eye/documents/${documentId}/duplicate`, { method: "POST", body: {} });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  async function openFile(file) {
    try {
      setViewing({ file, url: await objectUrl(file.fileId) });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  function closeViewer() {
    revokeObjectUrl(viewing?.url);
    setViewing(null);
  }

  return (
    <div className="cl-files">
      <div className="cl-files-tools">
        {canWrite ? (
          <details className="more-menu cl-menu">
            <summary aria-disabled={busy} className="btn btn-chip">文書作成 ▾</summary>
            <div className="more-menu-list cl-menu-list">
              {DOCUMENT_TEMPLATES.map((template) => (
                <button aria-label={`${template.label}を作成`} className="btn btn-ghost cl-menu-item" disabled={busy} key={template.type} onClick={(event) => { closeMenu(event); create(template.type); }} type="button">
                  <span className="cl-menu-name">{template.label}<span className="muted small"> {template.form}</span></span>
                  <span className="muted small">{template.note}</span>
                </button>
              ))}
              <p className="more-menu-note">{encounterId ? "このカルテの内容を差し込みます。" : "直近の確定カルテの内容を差し込みます。"}</p>
            </div>
          </details>
        ) : null}
        {canWrite ? (
          <details className="more-menu cl-menu">
            <summary aria-disabled={busy} className="btn btn-chip">文書雛形 ▾</summary>
            <div className="more-menu-list cl-menu-list">
              {pastDocuments.length ? pastDocuments.map((item) => (
                <button aria-label={`${formatDate(item.issueDate)} の${item.title}を雛形にして作成`} className="btn btn-ghost cl-menu-item" disabled={busy} key={item.documentId} onClick={(event) => { closeMenu(event); fromTemplate(item.documentId); }} type="button">
                  <span className="cl-menu-name">{item.title}<span className="muted small"> {formatDate(item.issueDate)}</span></span>
                  <span className="muted small">{recipientText(item.recipient) || DOCUMENT_TYPE_LABELS[item.type] || ""}</span>
                </button>
              )) : <p className="more-menu-note">雛形にできる文書がまだありません。</p>}
              <p className="more-menu-note">選んだ文書を写して、今日の日付の下書きを作ります。</p>
            </div>
          </details>
        ) : null}
        <span className="pane-tools-spacer" />
        <button aria-label="ファイルの一覧を読み込み直す" className="btn btn-chip" disabled={busy} onClick={reload} title="読み込み直す" type="button">⟳</button>
        {canWrite && onUpload ? <button aria-label="ファイルを取り込む" className="btn btn-chip cl-plus" onClick={onUpload} title="画像・PDF を取り込む" type="button">＋</button> : null}
      </div>
      {error ? <p className="alert alert-danger small" role="alert">{error}</p> : null}
      {rows === null ? <p className="loading">読み込み中…</p> : rows.length === 0 ? (
        <p className="empty">文書・ファイルはまだありません。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table cl-files-table">
            <thead>
              <tr><th scope="col">日付</th><th scope="col">名前・備考</th><th scope="col">種類</th><th scope="col"><span className="sr-only">操作</span></th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (row.kind === "document" ? (
                <tr key={row.key}>
                  <td className="cl-nowrap mono">{formatDate(row.date)}</td>
                  <td>
                    <Link href={`/documents/${row.item.documentId}`}>{row.item.title}</Link>
                    {recipientText(row.item.recipient) ? <span className="muted small cl-sub">{recipientText(row.item.recipient)}</span> : null}
                  </td>
                  <td className="cl-nowrap">
                    <span className="cl-file-kind is-doc">{DOCUMENT_TYPE_LABELS[row.item.type] || "文書"}</span>
                    <span className={`tag ${row.item.status === "finalized" ? "tag-ok" : "tag-draft"}`}>{row.item.status === "finalized" ? "確定" : "下書き"}</span>
                  </td>
                  <td className="cl-row-actions">
                    {row.item.status === "finalized" ? <Link aria-label={`${row.item.title}を印刷`} className="btn btn-chip" href={`/documents/${row.item.documentId}/print`}>印刷</Link> : null}
                    <Link aria-label={`${row.item.title}を${row.item.status === "finalized" ? "開く" : "編集"}`} className="btn btn-chip" href={`/documents/${row.item.documentId}`}>{row.item.status === "finalized" ? "開く" : "編集"}</Link>
                  </td>
                </tr>
              ) : (
                <tr key={row.key}>
                  <td className="cl-nowrap mono">{formatDate(row.date)}</td>
                  <td>
                    <button className="link-button" onClick={() => openFile(row.item)} type="button">{row.item.title}</button>
                    {row.item.kind === "paper_chart" && !row.item.paper?.reviewedBy ? <span className="muted small cl-sub">要約の確認待ち</span> : null}
                  </td>
                  <td className="cl-nowrap">
                    <span className="cl-file-kind">{FILE_KIND_LABELS[row.item.kind] || "ファイル"}</span>
                    {row.item.eye ? <span className="muted small">{EYE_SHORT_LABELS[row.item.eye]}</span> : null}
                    <span className="muted small"> {row.item.contentType === "application/pdf" ? "PDF" : "画像"}</span>
                  </td>
                  <td className="cl-row-actions">
                    <button aria-label={`${row.item.title}を開く`} className="btn btn-chip" onClick={() => openFile(row.item)} type="button">開く</button>
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {files?.length ? <p className="cl-files-foot"><Link href={`/patients/${patientId}/images`}>画像を並べて比較 ›</Link></p> : null}
      {viewing ? inPortal(
        <FileViewerDialog context={context} file={viewing.file} onClose={closeViewer} onSaved={async () => { closeViewer(); await load(); }} url={viewing.url} />
      ) : null}
    </div>
  );
}

function recipientText(recipient = {}) {
  return [recipient?.institution, recipient?.department, recipient?.doctor ? `${recipient.doctor} 先生` : ""].filter(Boolean).join(" ");
}
