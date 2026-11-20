"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DIRTY_CONFIRM_TEXT, confirmClose, createModalStack, isImeKey, isPrevented, trapTarget } from "../lib/modal";

// 共通のダイアログ。見た目はいままでの .dialog-backdrop / .dialog（設定画面は .master-backdrop / .master-panel）のまま。
// - Esc・背景のクリック（押したところと離したところが両方とも背景のとき）で閉じる。重なっているときは一番上だけ。
// - 日本語入力の変換中の Esc では閉じない。
// - 開いたらダイアログの中へフォーカスを移し、閉じたら開いたボタンへ戻す。Tab は中だけを回る。
// - 開いている間、後ろの画面は inert（クリック・フォーカスできない）。
// - dirty（入力途中）のときは、Esc・背景で閉じる前に確かめる。×・キャンセルは各ダイアログのまま。
// - busy の間は Esc・背景で閉じない。closeOnBackdrop={false} で背景のクリックだけ止められる。
// 使い方: <Modal onClose={close} labelledBy="xx-heading" className="dialog dialog-wide" as="form" onSubmit={submit}>…</Modal>
//   backdrop="sibling" は設定画面の形（背景とパネルが兄弟）。

const stack = createModalStack();

// ダイアログが開いているか（画面側のショートカット・Esc で、ダイアログの後ろを動かさないために使う）
export const isModalOpen = () => stack.size() > 0;

const FOCUSABLE = [
  "a[href]", "area[href]", "button", "input:not([type=hidden])", "select", "textarea", "iframe", "summary",
  "audio[controls]", "video[controls]", "[contenteditable]:not([contenteditable=false])", "[tabindex]"
].join(",");

function focusables(root) {
  const list = [...root.querySelectorAll(FOCUSABLE)].filter((element) => (
    element.tabIndex >= 0
    && !element.matches(":disabled")
    && !element.closest("[inert]")
    && element.getClientRects().length > 0
  ));
  // ラジオは、同じ組のうち Tab で止まる 1 つだけ（選ばれているもの、なければ最初）
  return list.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
    const group = list.filter((other) => other instanceof HTMLInputElement && other.type === "radio" && other.name === element.name && other.form === element.form);
    const checked = group.find((other) => other.checked);
    return element === (checked || group[0]);
  });
}

// 後ろの画面を inert にする（keep とその祖先以外の兄弟）。重なったダイアログ用に数を数え、元からあった inert は触らない。
const inertCount = new Map();

function setBackgroundInert(keep) {
  const nodes = keep.filter(Boolean);
  if (!nodes.length || typeof document === "undefined") return () => {};
  const path = new Set();
  for (const node of nodes) for (let current = node; current && current !== document.documentElement; current = current.parentElement) path.add(current);
  const marked = [];
  for (const node of path) {
    const parent = node.parentElement;
    if (!parent || node === document.body) continue;
    for (const sibling of parent.children) {
      if (path.has(sibling) || marked.includes(sibling) || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/u.test(sibling.tagName)) continue;
      const entry = inertCount.get(sibling);
      if (entry) entry.count += 1;
      else {
        inertCount.set(sibling, { count: 1, preexisting: sibling.hasAttribute("inert") });
        sibling.setAttribute("inert", "");
      }
      marked.push(sibling);
    }
  }
  return () => {
    for (const sibling of marked) {
      const entry = inertCount.get(sibling);
      if (!entry) continue;
      entry.count -= 1;
      if (entry.count > 0) continue;
      inertCount.delete(sibling);
      if (!entry.preexisting) sibling.removeAttribute("inert");
    }
  };
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// 開いたときの値から変わったか（dirty の目安）。値は JSON にできるもの。
export function useChangedSince(value) {
  const [initial] = useState(() => JSON.stringify(value ?? null));
  return JSON.stringify(value ?? null) !== initial;
}

export function Modal({ open = true, ...props }) {
  return open ? <ModalBox {...props} /> : null;
}

function ModalBox({
  onClose,
  as: Tag = "div",
  className = "dialog",
  backdrop = "wrap",
  backdropClassName,
  role = "dialog",
  labelledBy,
  label,
  dirty = false,
  confirmDirtyText = DIRTY_CONFIRM_TEXT,
  closeOnBackdrop = true,
  closeOnEsc = true,
  busy = false,
  initialFocus = null,
  dialogRef = null,
  isolate = false,
  children,
  ...rest
}) {
  const nodeRef = useRef(null);
  const backdropRef = useRef(null);
  const latest = useRef(null);
  latest.current = { onClose, dirty, confirmDirtyText, closeOnBackdrop, closeOnEsc, busy };
  // 開いたときのフォーカスの場所（閉じたら戻す）。描画の時点で取る（中の autoFocus より前）。
  // 前のダイアログの中から開いた（入れ替わる）ときは、そのダイアログを開いた場所も控えておく。
  const [entry] = useState(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    const parent = active ? stack.find((item) => item.node?.contains(active)) : null;
    return { node: null, opener: active, fallback: parent ? parent.opener : null };
  });
  const press = useRef({ down: false, up: false });

  const requestClose = (reason) => {
    const current = latest.current;
    if (current.busy || !current.onClose) return;
    if (reason === "escape" && !current.closeOnEsc) return;
    if (reason === "backdrop" && !current.closeOnBackdrop) return;
    if (!confirmClose({ dirty: current.dirty, text: current.confirmDirtyText, confirm: (text) => window.confirm(text) })) return;
    current.onClose();
  };
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;

  const setNode = (node) => {
    nodeRef.current = node;
    entry.node = node;
    if (typeof dialogRef === "function") dialogRef(node);
    else if (dialogRef) dialogRef.current = node;
  };

  // 重なりに入れ、後ろを inert にする。閉じたら元に戻してフォーカスを戻す。
  useIsoLayoutEffect(() => {
    const remove = stack.push(entry);
    const restoreInert = setBackgroundInert([nodeRef.current, backdropRef.current]);
    return () => {
      remove();
      restoreInert();
      // 消えたあと（同じ描画の終わり）に戻す。開発時の StrictMode の付け外し（要素は残る）では戻さない。
      const node = nodeRef.current;
      queueMicrotask(() => {
        if (node?.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const target = [entry.opener, entry.fallback].find((item) => item instanceof HTMLElement && item.isConnected && !item.closest("[inert]"));
        target?.focus({ preventScroll: true });
      });
    };
  }, [entry]);

  // 開いたら中へフォーカスを移す（autoFocus の付いた入力があればそのまま）
  useEffect(() => {
    const node = nodeRef.current;
    if (!node || node.contains(document.activeElement)) return;
    let target = null;
    if (initialFocus && typeof initialFocus === "object") target = initialFocus.current;
    else if (typeof initialFocus === "string") target = [...node.querySelectorAll(initialFocus)].find((element) => !element.matches(":disabled")) || null;
    (target || node).focus({ preventScroll: !target });
    // 開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc で閉じる・Tab を中で回す（一番上のダイアログだけ）。
  // 中のキーはダイアログの onKeyDown で受ける（中の部品が先に Esc を使ったとき＝preventDefault 済みは閉じない）。
  // フォーカスが外（body など）にあるときのために window でも受ける。
  const handleKey = (event) => {
    if (!stack.isTop(entry) || isPrevented(event)) return;
    const node = nodeRef.current;
    if (event.key === "Escape") {
      if (isImeKey(event)) return;
      event.preventDefault();
      requestRef.current("escape");
      return;
    }
    if (event.key !== "Tab" || !node || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = focusables(node);
    if (!list.length) {
      event.preventDefault();
      node.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    const index = list.indexOf(active);
    // 中ほど（一覧にない入れ子の場所を含む）はブラウザに任せる
    if (node.contains(active) && index < 0 && active !== node) return;
    const next = trapTarget(list.length, index, event.shiftKey);
    if (next < 0) return;
    event.preventDefault();
    list[next].focus();
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useEffect(() => {
    function onKeyDown(event) {
      const node = nodeRef.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      handleKeyRef.current(event);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 背景のクリック: 押したところと離したところが両方とも背景のときだけ（中から外へのドラッグでは閉じない）
  // isolate: 押した操作・キーをダイアログの外（React の親）へ伝えない（Rp の中から開くコメント追加など）
  const stop = isolate ? (event) => event.stopPropagation() : () => {};
  const backdropHandlers = {
    onMouseDown: (event) => { press.current = { down: event.target === event.currentTarget, up: false }; stop(event); },
    onMouseUp: (event) => { press.current.up = press.current.down && event.target === event.currentTarget; stop(event); },
    onClick: (event) => {
      const ok = press.current.down && press.current.up && event.target === event.currentTarget;
      press.current = { down: false, up: false };
      stop(event);
      if (ok && stack.isTop(entry)) requestRef.current("backdrop");
    },
    ...(isolate ? { onKeyDown: stop } : {})
  };
  const { onKeyDown: ownKeyDown, ...boxProps } = rest;

  const box = (
    <Tag
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-modal="true"
      className={className}
      data-modal=""
      ref={setNode}
      role={role}
      tabIndex={-1}
      {...boxProps}
      onKeyDown={(event) => {
        ownKeyDown?.(event);
        handleKey(event);
      }}
    >
      {children}
    </Tag>
  );

  if (backdrop === "sibling") {
    return (
      <>
        <div aria-hidden="true" className={backdropClassName || "master-backdrop"} ref={backdropRef} {...backdropHandlers} />
        {box}
      </>
    );
  }
  return (
    <div className={backdropClassName || "dialog-backdrop"} ref={backdropRef} role="presentation" {...backdropHandlers}>
      {box}
    </div>
  );
}
