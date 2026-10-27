"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { formatDate } from "../lib/format";

const TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };

// 患者の文書（紹介状・返書・診断書）の一覧と作成。
export function DocumentsPanel({ patientId, encounterId = "", canWrite }) {
  const api = useEyeApi();
  const router = useRouter();
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/v1/eye/patients/${patientId}/documents`)
      .then((payload) => setDocuments(payload.documents))
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId]);

  async function create(type) {
    try {
      const payload = await api("/v1/eye/documents", { method: "POST", body: { patientId, encounterId, type } });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <section className="panel">
      <h2>文書</h2>
      {error ? <p className="alert alert-danger">{error}</p> : null}
      {canWrite ? (
        <div className="doc-create">
          {Object.entries(TYPE_LABELS).map(([type, label]) => (
            <button className="btn btn-chip" key={type} onClick={() => create(type)} type="button">{label}を作成</button>
          ))}
        </div>
      ) : null}
      <p className="muted small">{encounterId ? "このカルテの内容を差し込みます。" : "直近の確定カルテの内容を差し込みます。"}</p>
      {documents === null ? <p className="loading">読み込み中…</p> : documents.length === 0 ? <p className="empty">文書はまだありません。</p> : (
        <ul className="plain doc-list">
          {documents.map((item) => (
            <li key={item.documentId}>
              <a href={`/documents/${item.documentId}`}>{item.title}</a>
              <span className="muted small"> {formatDate(item.issueDate)} {item.recipient?.institution || ""}</span>
              <span className={`tag ${item.status === "finalized" ? "tag-ok" : "tag-draft"}`}>{item.status === "finalized" ? "確定" : "下書き"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
