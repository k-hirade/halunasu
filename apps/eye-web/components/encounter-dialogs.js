"use client";

import { useState } from "react";
import { prescriptionText } from "../lib/format";

// 保存状態。自動保存なので「いま保存されているか」だけをはっきり見せる。
export function SaveIndicator({ state, onRetry }) {
  if (state === "saving") return <span aria-live="polite" className="save-state is-saving">保存中…</span>;
  if (state === "dirty") return <span aria-live="polite" className="save-state is-dirty" title="⌘/Ctrl + S ですぐ保存">● 未保存</span>;
  if (state === "error") return <button className="btn btn-chip danger-text" onClick={onRetry} type="button">保存に失敗・再試行</button>;
  return <span aria-live="polite" className="save-state is-saved">✓ 保存済み</span>;
}

// このダイアログの中で解消できる確認（検査値の確認・引き継ぎ処方の確認）。それ以外の止まる理由があると確定できない。
const RESOLVED_IN_DIALOG = new Set(["exam_unconfirmed", "prescription_carried_over"]);

export function FinalizeDialog({ content, changes, confirmations, readiness, version, error = "", onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  const blockers = readiness.blockers.filter((item) => !RESOLVED_IN_DIALOG.has(item.code));
  const needsReview = readiness.blockers.some((item) => RESOLVED_IN_DIALOG.has(item.code));
  const exam = content.exam;
  const issued = content.prescriptions.filter((item) => item.name);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="finalize-heading" className="dialog dialog-wide" role="dialog">
        <h2 id="finalize-heading">カルテを確定しますか？（v{version}）</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <table className="data-table finalize-summary">
          <tbody>
            <tr>
              <th scope="row">視力</th>
              <td><span className="eye-od">R</span> {exam.od.vaUncorrected || "—"}（{exam.od.vaCorrected || "—"}）　<span className="eye-os">L</span> {exam.os.vaUncorrected || "—"}（{exam.os.vaCorrected || "—"}）</td>
            </tr>
            <tr>
              <th scope="row">眼圧</th>
              <td><span className="eye-od">R</span> {exam.od.iop ?? "—"}　<span className="eye-os">L</span> {exam.os.iop ?? "—"} mmHg</td>
            </tr>
            <tr>
              <th scope="row">処方</th>
              <td>
                {issued.length === 0 ? "なし" : (
                  <ul className="plain">
                    {issued.map((item, index) => (
                      <li key={index}>{prescriptionText(item)}{item.carriedOver ? <span className="tag tag-warn">前回から引き継ぎ</span> : null}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
            {changes.length ? (
              <tr>
                <th scope="row">前回から</th>
                <td>{changes.map((change) => change.label).join("、")}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {blockers.length ? (
          <ul className="readiness">{blockers.map((item, index) => <li className="is-blocker" key={index}>{item.message}</li>)}</ul>
        ) : null}
        {readiness.warnings.length ? (
          <ul className="readiness">{readiness.warnings.map((item, index) => <li className="is-warning" key={index}>{item.message}</li>)}</ul>
        ) : null}
        {needsReview && !blockers.length ? (
          <p className="muted small">
            確定すると、{["od", "os"].some((side) => !confirmations[side]) ? "検査値を確認済みにし、" : ""}
            {content.prescriptions.some((item) => item.carriedOver) ? "引き継いだ処方を今回の処方として確定します。" : "確定します。"}
          </p>
        ) : null}
        <p className="muted small">確定後の変更は「修正する」から理由を付けて行い、元の版も残ります。</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">戻って編集</button>
          <button
            autoFocus
            className="btn btn-primary"
            disabled={busy || blockers.length > 0}
            onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}
            type="button"
          >
            {needsReview ? "内容を確認して確定する" : "確定する"}
          </button>
        </div>
      </div>
    </div>
  );
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

