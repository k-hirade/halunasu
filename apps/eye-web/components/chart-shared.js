"use client";

import { useEffect, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";

// カルテ画面（デジカルの 3 ペイン）で共通に使う小さな部品と関数。

export const newRpId = () => `rp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newOrderId = () => `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 区分バッジ（処置・行為の行の頭。デジカルの「薬」「検」「処」に当たる）
export const RX_BADGES = { eye_drop: "点眼", eye_ointment: "眼軟", oral: "内服", injection: "注射", other: "外用" };
export const ORDER_BADGES = { exam: "検査", procedure: "処置" };
export const TOPICAL_KINDS = new Set(["eye_drop", "eye_ointment"]);

// 入力中（文字を打てる欄にフォーカスがある）か。1 文字のショートカットはこのとき効かせない。
export function isTypingTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.isContentEditable) return true;
  const field = target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  if (!field) return false;
  if (field.tagName === "INPUT") {
    const type = (field.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return true;
}

export function closeMenu(event) {
  const menu = event.currentTarget.closest("details");
  if (!menu) return;
  // 中の項目にフォーカスがあれば、閉じたあとは開いたボタン（summary）へ戻す（キーボードで続けて操作できるように）
  const hadFocus = menu.contains(document.activeElement);
  menu.open = false;
  if (hadFocus) menu.querySelector(":scope > summary")?.focus({ preventScroll: true });
}

// 公開マスターの検索（語を打ち終えてから 250ms 後に 1 回）。type: drug | disease | modifier | procedure
export function useMasterSearch(type, query, { eyeOnly = false, limit = 30, enabled = true } = {}) {
  const api = useEyeApi();
  const [state, setState] = useState({ results: [], loading: false, error: "", available: true });
  const seq = useRef(0);
  useEffect(() => {
    const q = String(query || "").trim();
    if (!enabled || !type || !q) {
      setState({ results: [], loading: false, error: "", available: true });
      return undefined;
    }
    const ticket = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: "" }));
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ type, q, limit: String(limit) });
        if (eyeOnly) params.set("eye", "1");
        const payload = await api(`/v1/eye/masters/search?${params}`);
        if (ticket === seq.current) setState({ results: payload.results || [], loading: false, error: "", available: payload.available !== false });
      } catch (error) {
        if (ticket === seq.current) setState({ results: [], loading: false, error: error.message, available: true });
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [api, type, query, eyeOnly, limit, enabled]);
  return state;
}

// 学習リスト（この医院でよく使う束）。カルテを開いたあと 1 回だけ読む。
export function useLearningList(enabled = true) {
  const api = useEyeApi();
  const [state, setState] = useState({ items: { prescription: [], order: [], diagnosis: [] }, loaded: false, error: "" });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api("/v1/eye/learning-list")
      .then((payload) => { if (alive) setState({ items: { prescription: [], order: [], diagnosis: [], ...payload.items }, loaded: true, error: "" }); })
      .catch((error) => { if (alive) setState((current) => ({ ...current, loaded: true, error: error.message })); });
    return () => { alive = false; };
  }, [api, enabled]);
  return state;
}

// マスターの医薬品から処方の行を作る（数量・用法は空。デジカルと同じく、入れてから決める）。
export function prescriptionFromDrug(drug, rpId) {
  const kind = ["eye_drop", "eye_ointment", "oral", "injection", "other"].includes(drug.kind) ? drug.kind : "other";
  return {
    kind,
    name: drug.name,
    presetId: drug.presetId || "",
    ...(drug.code ? { drugCode: drug.code } : {}),
    eye: TOPICAL_KINDS.has(kind) ? "ou" : "",
    timesPerDay: drug.defaultTimesPerDay ?? null,
    quantity: null,
    unit: kind === "eye_drop" ? "本" : drug.unit || "",
    days: null,
    note: "",
    route: drug.route || "outside",
    usage: drug.defaultUsage || "",
    issued: true,
    rpId
  };
}

// 診療行為（マスター）・検査の一覧（院内のカタログ）からオーダーの行を作る。追加した時点では「予定」。
export function orderFromItem(item, rpId) {
  const fromMaster = Boolean(item.section);
  const exam = fromMaster ? /^D/u.test(item.section) : item.kind !== "procedure";
  return {
    orderId: newOrderId(),
    code: fromMaster ? "" : item.code || "",
    name: item.name,
    kind: exam ? "exam" : "procedure",
    eye: item.requiresEye === false ? "" : "ou",
    status: "planned",
    note: "",
    ...(fromMaster && item.code ? { procedureCode: item.code } : {}),
    rpId
  };
}

// テキストエリアのカーソル位置に文字を差し込む（無ければ末尾に改行して足す）。
export function insertAtCursor(textarea, current, text) {
  const value = String(current || "");
  if (!textarea || typeof textarea.selectionStart !== "number" || document.activeElement !== textarea) {
    return value ? `${value}${value.endsWith("\n") ? "" : "\n"}${text}` : text;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  return `${value.slice(0, start)}${text}${value.slice(end)}`;
}

export const WEEKDAYS = "日月火水木金土";

export function dateWithWeekday(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.slice(0, 10).split("-");
  const weekday = WEEKDAYS[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()];
  return `${year}/${month}/${day} (${weekday})`;
}

// 過去カルテの束を、ドラッグ＆ドロップで今日のカルテへ運ぶときの種類。
export const COPY_DRAG_TYPE = "application/x-halunasu-copy";
