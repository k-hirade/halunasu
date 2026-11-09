"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";

// 担当医の候補（受付・予約で選ぶ医師）。画面をまたいで 1 回だけ引く（失敗したら次に開いたときに取り直す）。
let cached = null;

export function useDoctors() {
  const api = useEyeApi();
  const [doctors, setDoctors] = useState(cached?.value || []);
  useEffect(() => {
    // ログインし直したとき（api が変わったとき）は取り直す
    if (!cached || cached.api !== api) {
      const promise = api("/v1/eye/doctors").then((payload) => payload.doctors || []);
      cached = { api, promise, value: null };
      promise.then((value) => { if (cached?.promise === promise) cached.value = value; }).catch(() => { cached = null; });
    }
    let alive = true;
    cached.promise.then((value) => { if (alive) setDoctors(value); }).catch(() => {});
    return () => { alive = false; };
  }, [api]);
  return doctors;
}

export function doctorName(doctors, memberId) {
  if (!memberId) return "";
  return doctors.find((doctor) => doctor.memberId === memberId)?.displayName || "（登録外の医師）";
}

// 診療科の候補（マスタがないので、眼科と、これまでの受付で使った名前）
export const DEFAULT_DEPARTMENTS = ["眼科"];
