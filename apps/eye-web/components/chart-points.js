"use client";

import { useEffect, useMemo, useState } from "react";
import { useEyeApi } from "./eye-api";

// 公開マスターの点数（診療行為）と薬価（医薬品）をコードで引く。デジカルのオーダー欄・処置行為の「75点」にあたる。
// 同じコードは画面の間で 1 回だけ引く（ページを開いている間のキャッシュ）。引けなくても画面は止めない（点数を出さないだけ）。
const cache = { procedure: new Map(), drug: new Map() };
const LOOKUP_LIMIT = 100;

export function useMasterLookup(type, codes) {
  const api = useEyeApi();
  const key = useMemo(() => [...new Set((codes || []).filter((code) => /^[0-9A-Za-z]{1,20}$/u.test(String(code || ""))).map(String))].sort().join(","), [codes]);
  const [, setVersion] = useState(0);
  useEffect(() => {
    const table = cache[type];
    if (!table || !key) return undefined;
    const missing = key.split(",").filter((code) => !table.has(code)).slice(0, LOOKUP_LIMIT);
    if (!missing.length) return undefined;
    let alive = true;
    for (const code of missing) table.set(code, null);
    api(`/v1/eye/masters/lookup?type=${type}&codes=${missing.join(",")}`)
      .then((payload) => {
        for (const record of payload.results || []) table.set(String(record.code), record);
        if (alive) setVersion((value) => value + 1);
      })
      .catch(() => { for (const code of missing) table.delete(code); });
    return () => { alive = false; };
  }, [api, type, key]);
  const table = cache[type];
  return (code) => (table && code ? table.get(String(code)) || null : null);
}

// 表示: 診療行為は「82点」、医薬品は「205.9円」（薬価。単位あたり）。
export function pointsLabel(record) {
  if (!record) return "";
  if (Number.isFinite(record.points)) return `${record.points}点`;
  if (Number.isFinite(record.price)) return `${record.price}円`;
  return "";
}
