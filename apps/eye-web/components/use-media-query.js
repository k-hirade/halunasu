"use client";

import { useEffect, useState } from "react";

// 画面幅などのメディアクエリに合わせて表示を切り替える。サーバー描画時は fallback を使う。
export function useMediaQuery(query, fallback = false) {
  const [matches, setMatches] = useState(fallback);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
