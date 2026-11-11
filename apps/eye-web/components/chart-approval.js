"use client";

import { useState } from "react";
import { approvalTag, isUnapproved, versionApproval } from "../lib/approval";
import { formatDateTime } from "../lib/format";

// カルテの承認（指導医の承認）の画面の部品。トプコン IMAGEnet eカルテの「承認」、研修医のカルテの指導医承認に倣う。
// 承認を使っていないカルテでは何も出さない（従来の画面のまま）。

// 一覧・見出しの札（承認待ち・承認済み・差し戻し）。
export function ApprovalTag({ approval, compact = false }) {
  const tag = approvalTag(approval);
  if (!tag) return null;
  return <span className={`tag approval-tag is-${tag.tone}${compact ? " is-compact" : ""}`} data-approval={approval.status} title={tag.title}>{tag.label}</span>;
}

// 会計の一覧・送信のダイアログの「未承認」（送れるが、承認がまだであることを知らせる）。
export function UnapprovedTag({ approval }) {
  if (!isUnapproved(approval)) return null;
  return <span className="tag approval-tag is-warn" data-approval="unapproved" title={approval.status === "returned" ? "差し戻し中（未承認）です。会計へは送れます。" : "承認待ち（未承認）です。会計へは送れます。"}>未承認</span>;
}

// カルテの中央の見出しの下: 承認の状態と、承認者の［承認］［差し戻し］。差し戻しの理由は書いた人にも見える。
export function ApprovalBar({ approval, approvalContext, versionCount, onApprove, onReturn }) {
  const [returning, setReturning] = useState(false);
  if (!approval) return null;
  const canDecide = Boolean(approvalContext?.canDecide);
  if (!approval.current) {
    // 修正中（下書き）: 前の版の承認の状態を添える
    return (
      <p className="alert alert-info chart-alert approval-bar" data-approval-bar="amending">
        修正中です。確定すると v{versionCount + 1} として{approvalContext?.approver ? "記録されます" : "もう一度承認を受けます"}（前の版: v{approval.version} {approval.status === "approved" ? "承認済み" : approval.status === "returned" ? "差し戻し" : "承認待ち"}）。
      </p>
    );
  }
  if (approval.status === "approved") {
    return (
      <p className="alert alert-ok chart-alert approval-bar" data-approval-bar="approved">
        <strong>承認済み</strong> v{approval.version}　{approval.auto ? `指導医 ${approval.decidedBy?.displayName || ""} が確定` : `${approval.decidedBy?.displayName || ""} が承認`}（{formatDateTime(approval.decidedAt)}）。直すと新しい版になり、もう一度承認を受けます。
      </p>
    );
  }
  return (
    <div className={`alert chart-alert approval-bar ${approval.status === "returned" ? "alert-danger" : "alert-warn"}`} data-approval-bar={approval.status} role="status">
      <span className="approval-bar-text">
        {approval.status === "returned" ? (
          <>
            <strong>差し戻し</strong> v{approval.version}　{approval.decidedBy?.displayName || ""}（{formatDateTime(approval.decidedAt)}）
            {approval.comment ? <span className="approval-comment">理由: {approval.comment}</span> : null}
            <span className="muted small">直して確定（→ 次へ）すると、次の版が承認待ちになります。</span>
          </>
        ) : (
          <>
            <strong>承認待ち</strong> v{approval.version}　{approval.requestedBy?.displayName || ""} が確定（{formatDateTime(approval.requestedAt)}）
            {!canDecide ? <span className="muted small">{approvalContext?.canApprove ? "自分が確定した版は承認できません。" : "承認者（指導医）の承認を待っています。"}</span> : null}
          </>
        )}
      </span>
      {canDecide && approval.status === "pending" ? (
        <span className="approval-actions">
          <button className="btn btn-primary btn-sm" data-approval-action="approve" onClick={onApprove} type="button">承認</button>
          <button className="btn btn-ghost btn-sm danger-text" data-approval-action="return" onClick={() => setReturning(true)} type="button">差し戻し…</button>
        </span>
      ) : null}
      {returning ? <ReturnDialog onCancel={() => setReturning(false)} onConfirm={async (comment) => { const done = await onReturn(comment); if (done) setReturning(false); return done; }} version={approval.version} /> : null}
    </div>
  );
}

// 差し戻しの理由（必須）。IME の変換中の Enter では送らない。
function ReturnDialog({ version, onConfirm, onCancel }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (!comment.trim()) { setError("差し戻しの理由を入れてください。"); return; }
    setBusy(true);
    setError("");
    const done = await onConfirm(comment.trim());
    setBusy(false);
    if (!done) setError("差し戻せませんでした。画面を読み込み直してください。");
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="approval-return-heading" className="dialog" role="dialog">
        <h2 id="approval-return-heading">v{version} を差し戻す</h2>
        <p className="small">書いた人に直してもらう点を入れます。カルテは確定済みのまま残り、会計へも送れます。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <label className="field">
          <span>差し戻しの理由<em>必須</em></span>
          <textarea
            autoFocus
            className="input"
            maxLength={1000}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) submit(); }}
            rows={3}
            value={comment}
          />
        </label>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-danger" disabled={busy} onClick={submit} type="button">{busy ? "送っています…" : "差し戻す"}</button>
        </div>
      </div>
    </div>
  );
}

// 版履歴の 1 行に添える承認の記録。
export function VersionApprovalLine({ events }) {
  const state = versionApproval(events);
  if (!state) return null;
  if (state.approved) return <div className="small approval-version is-ok">{state.auto ? "承認（指導医が確定）" : "承認"} {formatDateTime(state.at)} {state.by}</div>;
  if (state.returned) return <div className="small approval-version is-danger">差し戻し {formatDateTime(state.at)} {state.by}{state.comment ? `（${state.comment}）` : ""}</div>;
  return <div className="small approval-version is-warn">未承認</div>;
}
