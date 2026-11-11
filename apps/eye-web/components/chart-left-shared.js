"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEyeApi } from "./eye-api";

// カルテ左ペインのタブで共通に使う部品（区画の見出し・小さな編集ダイアログ・区画ごとの保存）。

// 区画（アレルギー・副作用薬…）ごとに保存する。ほかの項目は変えない。版（revision）がずれていれば 409 になる。
export function useSaveProfileSection(patientId, profile, onSaved) {
  const api = useEyeApi();
  return useCallback(async (section, value) => {
    const payload = await api(`/v1/eye/patients/${patientId}/profile/sections`, {
      method: "PUT",
      body: { expectedRevision: profile?.revision || 0, section, value }
    });
    onSaved(payload.profile);
    return payload.profile;
  }, [api, onSaved, patientId, profile?.revision]);
}

// 見出しの帯（左に名前、右に［＋］などの操作）。
export function SectionHead({ title, count = null, children = null, id }) {
  return (
    <div className="cl-section-head">
      <h3 className="cl-section-title" id={id}>{title}{count ? <span className="cl-count">{count}</span> : null}</h3>
      {children ? <span className="cl-section-actions">{children}</span> : null}
    </div>
  );
}

// 小さな編集ダイアログ。Esc で閉じ、開いたら最初の入力へ、閉じたら元の場所へフォーカスを戻す。
// Enter は IME の変換中（isComposing）なら送らない。
export function LeftDialog({ title, onClose, onSubmit, busy = false, error = "", children, footerLeft = null, submitLabel = "保存", extraActions = null, wide = false, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    const first = ref.current?.querySelector("input:not([type=hidden]):not([disabled]), textarea, select");
    first?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const headingId = `cl-dialog-${String(label || title).replace(/[^a-z0-9]/giu, "") || "x"}`;
  const dialog = (
    <div className="dialog-backdrop" role="presentation">
      <form
        aria-label={label || title}
        className={`dialog cl-dialog${wide ? " dialog-wide" : ""}`}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
        onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit?.(event); }}
        ref={ref}
        role="dialog"
      >
        <h2 className="cl-dialog-title" id={headingId}>{title}</h2>
        <div className="cl-dialog-body">{children}</div>
        {error ? <p className="alert alert-danger small" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {footerLeft}
          <button className="btn btn-ghost" disabled={busy} onClick={onClose} type="button">キャンセル</button>
          {extraActions}
          {onSubmit ? <button className="btn btn-primary" disabled={busy} type="submit">{busy ? "保存中…" : submitLabel}</button> : null}
        </div>
      </form>
    </div>
  );
  return inPortal(dialog);
}

// 左ペインはコンテナクエリの入れ物なので、ダイアログは body の直下に出す（画面全体に重ねる）。
export function inPortal(node) {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

// 削除は 2 段階（押すと「本当に削除する」に変わる）。
export function DeleteButton({ armed, onArm, onDelete, disabled = false }) {
  return armed ? (
    <button className="btn btn-danger dialog-action-left" disabled={disabled} onClick={onDelete} type="button">本当に削除する</button>
  ) : (
    <button className="btn btn-ghost danger-text dialog-action-left" disabled={disabled} onClick={onArm} type="button">削除</button>
  );
}

// 発症時期（年・月）の選択。値は "YYYY" か "YYYY-MM"、空は ""。
export function OnsetField({ value, onChange, label = "発症時期" }) {
  const [year = "", month = ""] = String(value || "").split("-");
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 100 }, (_, index) => String(thisYear - index));
  const set = (nextYear, nextMonth) => onChange(nextYear ? (nextMonth ? `${nextYear}-${nextMonth}` : nextYear) : "");
  return (
    <span className="cl-onset">
      <select aria-label={`${label}（年）`} className="input" onChange={(event) => set(event.target.value, month)} value={year}>
        <option value="">—</option>
        {years.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <span>年</span>
      <select aria-label={`${label}（月）`} className="input" disabled={!year} onChange={(event) => set(year, event.target.value)} value={month}>
        <option value="">—</option>
        {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((item) => <option key={item} value={item}>{Number(item)}</option>)}
      </select>
      <span>月</span>
    </span>
  );
}

export function onsetText(value) {
  if (!value) return "";
  const [year, month] = String(value).split("-");
  return month ? `${year}年${Number(month)}月` : `${year}年`;
}

// 同時に保存しようとして版がずれたとき（409）の言い方。
export function saveErrorMessage(error) {
  if (error?.status === 409) return "ほかの端末で患者の情報が更新されました。画面を読み込み直してから、もう一度保存してください。";
  return error?.message || "保存できませんでした。";
}
