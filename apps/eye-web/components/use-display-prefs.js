"use client";

import { useCallback, useEffect, useState } from "react";
import { DISPLAY_PREFS_EVENT, displayPrefsKey, normalizeDisplayPrefs, readDisplayPrefs, writeDisplayPrefs } from "../lib/display-prefs";

// 表示の設定（lib/display-prefs.js）を読む。ヘッダーで変えたら、同じ画面のカルテにも合図ですぐ反映する。
// context は /v1/eye/context の中身（orgId・memberId で利用者ごとに分ける）。読み込む前は既定のまま（ready: false）。
export function useDisplayPrefs(context) {
  const key = displayPrefsKey(context?.orgId, context?.memberId);
  const [state, setState] = useState(() => ({ key: "", prefs: normalizeDisplayPrefs(null) }));

  useEffect(() => {
    if (!key) return undefined;
    setState({ key, prefs: readDisplayPrefs(key) });
    const reload = (event) => {
      if (event.type === "storage" && event.key && event.key !== key) return;
      if (event.type === DISPLAY_PREFS_EVENT && event.detail?.key !== key) return;
      setState({ key, prefs: readDisplayPrefs(key) });
    };
    window.addEventListener(DISPLAY_PREFS_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(DISPLAY_PREFS_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [key]);

  const save = useCallback((next) => {
    const prefs = writeDisplayPrefs(key, next);
    setState({ key, prefs });
    window.dispatchEvent(new CustomEvent(DISPLAY_PREFS_EVENT, { detail: { key } }));
    return prefs;
  }, [key]);

  return { prefs: state.prefs, ready: Boolean(key) && state.key === key, save };
}

// 文字の大きさを <html> に当てる（最初の描画の前は <head> のスクリプトが端末の値で当てている）
export function applyTextSize(textSize) {
  if (typeof document === "undefined") return;
  if (textSize === "large") document.documentElement.dataset.textSize = "large";
  else delete document.documentElement.dataset.textSize;
}
