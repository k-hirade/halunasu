"use client";

import { useEffect, useLayoutEffect } from "react";

// ポップオーバー（「…」メニュー・用法・テンキー・説明の吹き出しなど）の位置合わせ。
// CSS の既定の位置（下向き・右寄せなど）で画面やスクロール枠に収まれば何もしない。
// 収まらないときだけ、開いたときに位置を測り、上下の向き・左右の寄せを切り替え、画面の中に収める。
// - 位置は panel の style に直接書く（position:fixed。親のスクロール枠の端で切れないようにする）。
// - 画面下の固定バー（data-fixed-bar の付いた fixed の要素）と上の固定ヘッダーには重ねない。
// - 入りきらない高さ・幅は max-height / max-width にして、中をスクロールさせる。
// 使い方:
// - <details className="more-menu"> の直下の .more-menu-list、<details data-popover> の直下の [data-popover-panel] は
//   PopoverAutoPlacement（app/layout.js で 1 回だけ置く）が自動で合わせる。部品側の変更は要らない。
// - details 以外（テンキーなど）は usePopoverPlacement(panelRef, open) を使う。

const MARGIN = 8;
const DEFAULT_GAP = 4;
const STYLE_KEYS = ["position", "top", "left", "right", "bottom", "width", "maxHeight", "maxWidth", "overflowY"];
const PLACED = new WeakSet();

function viewportBox() {
  const viewport = window.visualViewport;
  const width = document.documentElement.clientWidth || window.innerWidth;
  // ソフトキーボードが出ているときは、見えている部分（visualViewport）を基準にする
  const top = viewport ? viewport.offsetTop : 0;
  const height = viewport ? viewport.height : window.innerHeight;
  return { top, left: 0, right: width, bottom: top + height };
}

function intersect(box, rect) {
  return {
    top: Math.max(box.top, rect.top),
    left: Math.max(box.left, rect.left),
    right: Math.min(box.right, rect.right),
    bottom: Math.min(box.bottom, rect.bottom)
  };
}

const clips = (style) => style.overflowX !== "visible" || style.overflowY !== "visible";

// position:fixed の基準になる祖先（transform・contain・container-type など）。なければ null（画面が基準）。
function fixedContainingBlock(element) {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.transform !== "none"
      || style.perspective !== "none"
      || style.filter !== "none"
      || (style.backdropFilter && style.backdropFilter !== "none")
      || /layout|paint|strict|content/u.test(style.contain || "")
      || (style.containerType && style.containerType !== "normal")
      || /transform|perspective|filter/u.test(style.willChange || "")
    ) return node;
  }
  return null;
}

// start から上の、はみ出しを切る祖先の枠と画面の重なり
function clipBox(start) {
  let box = viewportBox();
  for (let node = start; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (clips(getComputedStyle(node))) box = intersect(box, node.getBoundingClientRect());
  }
  return box;
}

// 固定のヘッダー・下のバーに重ならないようにする（開いた場所がそのバーの中なら除く）
function avoidBars(box, anchor) {
  let next = { ...box };
  const header = document.querySelector("header.eh");
  if (header && !header.contains(anchor)) {
    const style = getComputedStyle(header);
    if (style.position === "sticky" || style.position === "fixed") next.top = Math.max(next.top, header.getBoundingClientRect().bottom);
  }
  for (const bar of document.querySelectorAll("[data-fixed-bar]")) {
    if (bar.contains(anchor) || getComputedStyle(bar).position !== "fixed") continue;
    const rect = bar.getBoundingClientRect();
    if (!rect.height) continue;
    if (rect.top > (next.top + next.bottom) / 2) next.bottom = Math.min(next.bottom, rect.top);
    else next.top = Math.max(next.top, rect.bottom);
  }
  return next;
}

const inset = (box) => ({ top: box.top + MARGIN, left: box.left + MARGIN, right: box.right - MARGIN, bottom: box.bottom - MARGIN });
const fits = (rect, box) => rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5;

// 位置合わせで書いた style を消し、CSS の既定の位置に戻す
export function resetPopover(panel) {
  if (!panel) return;
  for (const key of STYLE_KEYS) panel.style[key] = "";
  delete panel.dataset.placement;
  PLACED.delete(panel);
}

// panel を anchor（既定は CSS の位置の基準になっている親）に合わせて置く
export function placePopover(panel, { anchor = null } = {}) {
  if (!panel || typeof window === "undefined" || !panel.isConnected) return;
  resetPopover(panel);
  const base = anchor || panel.offsetParent || panel.parentElement;
  if (!base) return;
  // CSS で fixed（スマホの下のシートなど）にしているものは触らない
  if (getComputedStyle(panel).position === "fixed") return;
  const a = base.getBoundingClientRect();
  const natural = panel.getBoundingClientRect();
  if (!natural.width && !natural.height) return;

  // 1) 既定の位置で収まるなら何もしない
  const naturalBox = inset(avoidBars(clipBox(panel.offsetParent || base), base));
  if (fits(natural, naturalBox)) return;

  // 2) fixed にして、親のスクロール枠の外へ出す（fixed の基準になる祖先があれば、その枠の中に収める）
  const containing = fixedContainingBlock(panel);
  const box = inset(avoidBars(containing ? clipBox(containing) : viewportBox(), base));
  const preferUp = natural.bottom <= a.top + 1;
  const preferEnd = Math.abs(natural.right - a.right) < Math.abs(natural.left - a.left);
  const gapDown = preferUp ? DEFAULT_GAP : Math.min(12, Math.max(0, natural.top - a.bottom));
  const gapUp = preferUp ? Math.min(12, Math.max(0, a.top - natural.bottom)) : DEFAULT_GAP;

  // 幅は既定の位置での幅のままにする（fixed にすると使える幅が変わり、中身に合わせて広がるため）
  const roomWidth = Math.max(0, box.right - box.left);
  panel.style.position = "fixed";
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.top = "0px";
  panel.style.left = "0px";
  panel.style.width = `${Math.min(natural.width, roomWidth)}px`;
  const origin = panel.getBoundingClientRect();
  const width = origin.width;
  const height = origin.height;

  // 縦: 既定の向きで入らなければ反対の向き、どちらも入らなければ広い方にして中をスクロールさせる
  const below = box.bottom - a.bottom - gapDown;
  const above = a.top - box.top - gapUp;
  let up;
  if (preferUp) up = height <= above || (height > below && above >= below);
  else up = !(height <= below || (height > above && below >= above));
  const room = Math.max(0, up ? above : below);
  const shown = Math.min(height, room);
  if (height > room) {
    panel.style.maxHeight = `${Math.floor(room)}px`;
    panel.style.overflowY = "auto";
  }
  const top = up ? a.top - gapUp - shown : a.bottom + gapDown;

  // 横: 既定の寄せで入らなければ反対の寄せ、どちらも入らなければ画面の中に寄せる
  const start = a.left;
  const end = a.right - width;
  const inside = (left) => left >= box.left - 0.5 && left + width <= box.right + 0.5;
  const first = preferEnd ? end : start;
  const second = preferEnd ? start : end;
  let left;
  if (inside(first)) left = first;
  else if (inside(second)) left = second;
  else left = Math.min(Math.max(first, box.left), Math.max(box.left, box.right - width));

  // fixed の基準が画面でない場合に備えて、いまの位置との差で置く
  panel.style.top = `${Math.round(top - origin.top)}px`;
  panel.style.left = `${Math.round(left - origin.left)}px`;
  panel.dataset.placement = up ? "up" : "down";
  PLACED.add(panel);
}

// スクロール・画面の大きさの変化で、開いているものを置き直す
const openPanels = new Map();
let frame = 0;
let listening = false;

function replaceAll() {
  frame = 0;
  for (const [panel, anchor] of openPanels) {
    if (!panel.isConnected) openPanels.delete(panel);
    else placePopover(panel, { anchor });
  }
  if (!openPanels.size) listen(false);
}

function schedule(event) {
  // パネルの中のスクロールでは置き直さない
  if (event?.type === "scroll" && event.target instanceof Node) {
    for (const panel of openPanels.keys()) if (panel.contains(event.target)) return;
  }
  if (!frame) frame = requestAnimationFrame(replaceAll);
}

function listen(on) {
  if (on === listening) return;
  listening = on;
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("scroll", schedule, { capture: true, passive: true });
  window[method]("resize", schedule);
  window.visualViewport?.[method]("resize", schedule);
}

function track(panel, anchor = null) {
  openPanels.set(panel, anchor);
  listen(true);
  placePopover(panel, { anchor });
}

function untrack(panel) {
  openPanels.delete(panel);
  resetPopover(panel);
  if (!openPanels.size) listen(false);
}

// details 以外のポップオーバー用。open の間だけ位置を合わせる（disabled の間は CSS のまま）。
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function usePopoverPlacement(panelRef, open, { anchorRef = null, disabled = false } = {}) {
  useIsoLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || disabled || !panel) return undefined;
    track(panel, anchorRef?.current || null);
    return () => untrack(panel);
  }, [open, disabled, panelRef, anchorRef]);
}

const DETAILS_PANEL = ":scope > .more-menu-list, :scope > [data-popover-panel]";
const isPopoverDetails = (node) => node instanceof HTMLDetailsElement && (node.classList.contains("more-menu") || node.hasAttribute("data-popover"));

function syncDetails(details) {
  const panel = details.querySelector(DETAILS_PANEL);
  if (!panel) return;
  if (details.open) track(panel);
  else untrack(panel);
}

// details.more-menu / details[data-popover] の開閉を見張り、開いたときに位置を合わせる。
// MutationObserver は描画の前に動くので、既定の位置が一瞬見えることはない。
export function PopoverAutoPlacement() {
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      for (const record of records) if (isPopoverDetails(record.target)) syncDetails(record.target);
    });
    observer.observe(document.body, { attributeFilter: ["open"], attributes: true, subtree: true });
    for (const details of document.querySelectorAll("details[open]")) if (isPopoverDetails(details)) syncDetails(details);
    return () => observer.disconnect();
  }, []);
  return null;
}
