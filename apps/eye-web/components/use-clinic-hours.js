"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { scheduleOf } from "../lib/booking-hours";

// 施設管理の「診療時間・予約枠」。画面をまたいで 1 回だけ引く（施設管理で保存したら clearClinicHoursCache で取り直す）。
// 読めない・古い API（404）のときは未設定として扱う（従来の 8〜18 時・30 分）。
let cached = null;

export function clearClinicHoursCache() {
  cached = null;
}

export function useClinicSchedule() {
  const api = useEyeApi();
  const [schedule, setSchedule] = useState(() => scheduleOf(cached?.value || null));
  useEffect(() => {
    if (!cached || cached.api !== api) {
      let failed = false;
      const promise = api("/v1/eye/clinic-config/clinicHours").then((payload) => payload.value || null).catch(() => { failed = true; return null; });
      cached = { api, promise, value: null };
      // 失敗したときは覚えず、次に開いたときに取り直す
      promise.then((value) => { if (cached?.promise === promise) { if (failed) cached = null; else cached.value = value; } });
    }
    let alive = true;
    cached.promise.then((value) => { if (alive) setSchedule(scheduleOf(value)); });
    return () => { alive = false; };
  }, [api]);
  return schedule;
}
