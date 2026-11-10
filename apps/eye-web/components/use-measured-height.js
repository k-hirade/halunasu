"use client";

import { useCallback, useRef } from "react";

// 要素の実際の高さ（枠線まで）を、:root の CSS 変数（例: --actionbar-h）に書き込む。
// 画面下の固定バーは、画面幅やボタンの数で 1〜3 段に変わるため、本文の下の余白を固定値にせずこの値を使う。
// 使い方: const barRef = useMeasuredHeight("--actionbar-h"); <div ref={barRef}>…</div>
// CSS: padding-bottom: calc(var(--actionbar-h, 72px) + 8px);（外したとき・計測前は既定値が効く）
export function useMeasuredHeight(variable) {
  const cleanupRef = useRef(null);
  return useCallback((node) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node || typeof window === "undefined") return;
    const root = document.documentElement;
    let last = "";
    const write = () => {
      const value = `${Math.ceil(node.getBoundingClientRect().height)}px`;
      if (value === last) return;
      last = value;
      root.style.setProperty(variable, value);
    };
    write();
    if (typeof ResizeObserver === "undefined") {
      cleanupRef.current = () => root.style.removeProperty(variable);
      return;
    }
    const observer = new ResizeObserver(write);
    observer.observe(node, { box: "border-box" });
    cleanupRef.current = () => {
      observer.disconnect();
      root.style.removeProperty(variable);
    };
  }, [variable]);
}
