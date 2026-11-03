"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { formatDate } from "../lib/format";

export const DOCUMENT_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };
const TYPE_LABELS = DOCUMENT_TYPE_LABELS;

// 患者の文書（紹介状・返書・診断書）の一覧と作成。
// variant="side" は患者ページの右列用（一覧が先、作成は「＋作成」メニュー 1 つ）。既定はカルテ画面の文書タブ用。
export function DocumentsPanel({ patientId, encounterId = "", canWrite, variant = "default" }) {
  const api = useEyeApi();
  const router = useRouter();
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api(`/v1/eye/patients/${patientId}/documents`)
      .then((payload) => setDocuments(payload.documents))
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId]);

  async function create(type) {
    if (creating) return;
    setCreating(true);
    try {
      const payload = await api("/v1/eye/documents", { method: "POST", body: { patientId, encounterId, type } });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
      setCreating(false);
    }
  }

  const sourceNote = encounterId ? "このカルテの内容を差し込みます。" : "直近の確定カルテの内容を差し込みます。";

  if (variant === "side") {
    return (
      <section className="panel side-panel">
        <div className="side-head">
          <h2>文書{documents?.length ? <span className="side-count">{documents.length}</span> : null}</h2>
          {canWrite ? (
            <details className="more-menu">
              <summary className="btn btn-chip btn-sm">＋作成</summary>
              <div className="more-menu-list">
                {Object.entries(TYPE_LABELS).map(([type, label]) => (
                  <button
                    className="btn btn-ghost"
                    disabled={creating}
                    key={type}
                    onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); create(type); }}
                    type="button"
                  >
                    {label}を作成
                  </button>
                ))}
                <p className="more-menu-note">{sourceNote}</p>
              </div>
            </details>
          ) : null}
        </div>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {documents === null ? <p className="loading">読み込み中…</p> : documents.length === 0 ? <p className="empty">文書はまだありません。</p> : (
          <ul className="side-list">
            {documents.map((item) => (
              <li key={item.documentId}>
                <Link className="side-row" href={`/documents/${item.documentId}`}>
                  <span className="side-row-date">{formatDate(item.issueDate).slice(2)}</span>
                  <span className="side-row-title" title={item.recipient?.institution || ""}>
                    {item.title}{item.recipient?.institution ? <span className="side-row-sub"> {item.recipient.institution}</span> : null}
                  </span>
                  <span className={`side-row-status${item.status === "finalized" ? "" : " is-draft"}`}>{item.status === "finalized" ? "確定" : "下書き"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>文書</h2>
      {error ? <p className="alert alert-danger">{error}</p> : null}
      {canWrite ? (
        <div className="doc-create">
          {Object.entries(TYPE_LABELS).map(([type, label]) => (
            <button className="btn btn-chip" disabled={creating} key={type} onClick={() => create(type)} type="button">{label}を作成</button>
          ))}
        </div>
      ) : null}
      <p className="muted small">{sourceNote}</p>
      {documents === null ? <p className="loading">読み込み中…</p> : documents.length === 0 ? <p className="empty">文書はまだありません。</p> : (
        <ul className="plain doc-list">
          {documents.map((item) => (
            <li key={item.documentId}>
              <Link href={`/documents/${item.documentId}`}>{item.title}</Link>
              <span className="muted small"> {formatDate(item.issueDate)} {item.recipient?.institution || ""}</span>
              <span className={`tag ${item.status === "finalized" ? "tag-ok" : "tag-draft"}`}>{item.status === "finalized" ? "確定" : "下書き"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
