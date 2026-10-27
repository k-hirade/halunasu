"use client";

import { useCallback } from "react";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

export function runtimeConfig() {
  if (typeof window === "undefined") return { eyeBaseUrl: "/api/eye" };
  return window.__HALUNASU_EYE_CONFIG__ || { eyeBaseUrl: "/api/eye" };
}

// eye-api への呼び出し。更新系は CSRF トークンを付ける。
export function useEyeApi() {
  const auth = usePlatformAuth();
  return useCallback(async (path, options = {}) => {
    const token = auth.accessToken || getStoredPlatformAccessToken();
    if (!token) throw new Error("ログイン情報を確認できません。もう一度ログインしてください。");
    const method = options.method || "GET";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (method !== "GET" && auth.csrfToken) headers["x-csrf-token"] = auth.csrfToken;
    const response = await fetch(`${runtimeConfig().eyeBaseUrl}${path}`, {
      method,
      credentials: "include",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(userMessage(response.status, payload));
      error.status = response.status;
      error.field = payload.field;
      error.details = payload.details;
      throw error;
    }
    return payload;
  }, [auth.accessToken, auth.csrfToken]);
}

function userMessage(status, payload) {
  if (status === 409) return payload.message && /[ぁ-んァ-ン一-龠]/u.test(payload.message) ? payload.message : "ほかの端末で更新されました。画面を読み込み直してください。";
  if (status === 403) return "この操作を行う権限がありません。";
  if (status === 404) return "対象が見つかりません。";
  if (status === 400 && payload.details?.blockers) return `確定できません: ${payload.details.blockers.map((item) => item.message).join(" ")}`;
  if (status === 400 && payload.field) return `入力を確認してください（${payload.field}）: ${payload.message}`;
  return payload.message || `エラーが発生しました（HTTP ${status}）`;
}
