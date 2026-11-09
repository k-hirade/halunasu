"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { formatDate } from "../lib/format";

export const DOCUMENT_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他の文書" };

// 「文書作成 ▾」で選ぶ雛形（デジカルのファイルタブの［文書作成▾］にあたる）。書式名と、何が自動で入るか。
export const DOCUMENT_TEMPLATES = [
  { type: "referral", label: "紹介状", form: "診療情報提供書", note: "医療機関・患者・傷病名・検査所見・処方・アレルギー" },
  { type: "reply", label: "返書", form: "診療情報提供書（返書）", note: "傷病名・検査所見・方針" },
  { type: "certificate", label: "診断書", form: "診断書", note: "傷病名・検査所見" },
  { type: "other", label: "その他の文書", form: "白紙", note: "宛先と本文だけ" }
];

// 患者の文書（紹介状・返書・診断書）の一覧と作成。デジカルと同じく、上に［文書作成 ▾］［⟳］、下に日付順の表。
// variant="side" は患者ページの右列用（狭いので表ではなく 1 行ずつ）。既定はカルテ画面の文書タブ用。
export function DocumentsPanel({ patientId, encounterId = "", canWrite, variant = "default" }) {
  const api = useEyeApi();
  const router = useRouter();
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/patients/${patientId}/documents`);
    setDocuments(sortDocuments(payload.documents || []));
  }, [api, patientId]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  async function reload() {
    setReloading(true);
    setError("");
    try {
      await load();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setReloading(false);
    }
  }

  async function create(type) {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const payload = await api("/v1/eye/documents", { method: "POST", body: { patientId, encounterId, type } });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
      setCreating(false);
    }
  }

  const sourceNote = encounterId ? "このカルテの内容を差し込みます。" : "直近の確定カルテの内容を差し込みます。";
  const count = documents?.length || 0;
  const toolbar = (
    <div className="docs-toolbar">
      {canWrite ? (
        <details className="more-menu docs-create">
          <summary aria-disabled={creating} className={`btn ${variant === "side" ? "btn-chip btn-sm" : "btn-primary btn-sm"}`}>{creating ? "作成中…" : "文書作成 ▾"}</summary>
          <div className="more-menu-list docs-template-list">
            {DOCUMENT_TEMPLATES.map((template) => (
              <button
                aria-label={`${template.label}を作成`}
                className="btn btn-ghost docs-template"
                disabled={creating}
                key={template.type}
                onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); create(template.type); }}
                type="button"
              >
                <span className="docs-template-name">{template.label}<span className="docs-template-form">{template.form}</span></span>
                <span className="docs-template-note">{template.note}</span>
              </button>
            ))}
            <p className="more-menu-note">{sourceNote}</p>
          </div>
        </details>
      ) : null}
      <button aria-label="文書の一覧を読み込み直す" className="btn btn-ghost btn-sm docs-reload" disabled={reloading} onClick={reload} title="読み込み直す" type="button">⟳</button>
    </div>
  );

  if (variant === "side") {
    return (
      <section className="panel side-panel">
        <div className="side-head">
          <h2>文書{count ? <span className="side-count">{count}</span> : null}</h2>
          {toolbar}
        </div>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {documents === null ? <p className="loading">読み込み中…</p> : count === 0 ? <p className="empty">文書はまだありません。</p> : (
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
    <section className="panel docs-panel">
      <div className="docs-head">
        <h2>文書{count ? <span className="side-count">{count}</span> : null}</h2>
        {toolbar}
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {documents === null ? <p className="loading">読み込み中…</p> : count === 0 ? (
        <p className="empty">文書はまだありません。{canWrite ? "「文書作成」から雛形を選ぶと、カルテの内容を差し込んだ下書きができます。" : ""}</p>
      ) : (
        <table className="data-table docs-table">
          <thead>
            <tr><th scope="col">日付</th><th scope="col">文書</th><th scope="col">宛先・備考</th><th scope="col">状態</th><th scope="col"><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {documents.map((item) => (
              <tr key={item.documentId}>
                <td className="docs-date mono">{formatDate(item.issueDate)}</td>
                <td className="docs-title"><Link href={`/documents/${item.documentId}`}>{item.title}</Link><span className="docs-type">{DOCUMENT_TYPE_LABELS[item.type] || ""}</span></td>
                <td className="docs-note">{recipientText(item.recipient) || <span className="muted">—</span>}</td>
                <td><span className={`tag ${item.status === "finalized" ? "tag-ok" : "tag-draft"}`}>{item.status === "finalized" ? "確定" : "下書き"}</span></td>
                <td className="docs-actions">
                  {item.status === "finalized" ? <Link aria-label={`${item.title}を印刷`} className="btn btn-ghost btn-sm" href={`/documents/${item.documentId}/print`}>印刷</Link> : null}
                  <Link aria-label={`${item.title}を${item.status === "finalized" ? "開く" : "編集"}`} className="btn btn-ghost btn-sm" href={`/documents/${item.documentId}`}>{item.status === "finalized" ? "開く" : "編集"}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// 新しい日付が上（同じ日は下書きを上に、更新の新しい順）
function sortDocuments(documents) {
  return [...documents].sort((left, right) => String(right.issueDate || "").localeCompare(String(left.issueDate || ""))
    || Number(left.status === "finalized") - Number(right.status === "finalized")
    || String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

function recipientText(recipient = {}) {
  return [recipient?.institution, recipient?.department, recipient?.doctor ? `${recipient.doctor} 先生` : ""].filter(Boolean).join(" ");
}
