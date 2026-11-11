"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";

// 帳票設定（施設管理）。紙の部品（紹介状・会計連絡票）が読む。1 回だけ読み、ページ間で使い回す。
// 読めない・古い API のときは既定の値（従来の紙と同じ）。
export const DEFAULT_PRINT_SETTINGS = Object.freeze({ defaultHonorific: "", letterSeal: true, billingSlipDiagnoses: true, footerNote: "" });
let cached = null;

export function clearPrintSettings() {
  cached = null;
}

export function usePrintSettings() {
  const api = useEyeApi();
  const [settings, setSettings] = useState(() => cached?.value || DEFAULT_PRINT_SETTINGS);
  useEffect(() => {
    let active = true;
    if (!cached) {
      const entry = { value: null, promise: null };
      entry.promise = api("/v1/eye/clinic-config/printSettings")
        .then((payload) => {
          entry.value = { ...DEFAULT_PRINT_SETTINGS, ...(payload.value || {}) };
          return entry.value;
        })
        .catch(() => {
          if (cached === entry) cached = null;
          return DEFAULT_PRINT_SETTINGS;
        });
      cached = entry;
    }
    cached.promise.then((value) => { if (active) setSettings(value); });
    return () => { active = false; };
  }, [api]);
  return settings;
}
