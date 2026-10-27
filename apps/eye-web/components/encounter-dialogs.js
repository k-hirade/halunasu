"use client";

import { useState } from "react";

export function SaveIndicator({ state, onRetry }) {
  if (state === "saving") return <span className="save-state">保存中…</span>;
  if (state === "dirty") return <span className="save-state">未保存の変更</span>;
  if (state === "error") return <button className="btn btn-chip danger-text" onClick={onRetry} type="button">保存に失敗・再試行</button>;
  return <span className="save-state is-saved">保存済み</span>;
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, danger = false }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="confirm-heading" className="dialog" role="dialog">
        <h2 id="confirm-heading">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }} type="button">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function AmendDialog({ onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog confirmLabel="修正を始める" onCancel={onCancel} onConfirm={() => (reason.trim() ? onConfirm(reason.trim()) : null)} title="確定済みのカルテを修正">
      <p>修正内容は新しい版として保存され、元の版も残ります。</p>
      <label className="field">
        <span>修正理由 <em>必須</em></span>
        <textarea autoFocus className="input" onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
      </label>
    </ConfirmDialog>
  );
}

