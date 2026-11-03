"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

// 紙に載せる職員の氏名（memberId → 氏名）。/bootstrap の printNames を1回だけ読み、ページ間で使い回す。
// 設定で印刷用の氏名を変えたら clearPrintNames() で捨てる。ログインし直すと（トークンが変わるので）読み直す。
let cached = null;

export function clearPrintNames() {
  cached = null;
}

export function usePrintNames() {
  const api = useEyeApi();
  const auth = usePlatformAuth();
  const key = auth.accessToken || (typeof window === "undefined" ? "" : getStoredPlatformAccessToken()) || "";
  const [printNames, setPrintNames] = useState(() => (cached?.key === key && cached.value) || {});
  useEffect(() => {
    let active = true;
    if (!cached || cached.key !== key) {
      const entry = { key, value: null, promise: null };
      entry.promise = api("/v1/eye/bootstrap")
        .then((payload) => {
          entry.value = payload.printNames || {};
          return entry.value;
        })
        .catch(() => {
          if (cached === entry) cached = null;
          return {};
        });
      cached = entry;
    }
    cached.promise.then((value) => { if (active) setPrintNames(value); });
    return () => { active = false; };
  }, [api, key]);
  return printNames;
}
