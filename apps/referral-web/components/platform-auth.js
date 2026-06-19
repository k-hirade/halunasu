"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";

const PlatformAuthContext = createContext(null);
const ACCESS_TOKEN_STORAGE_KEY = "halunasu_platform_access_token";

export function PlatformAuthProvider({ children, platformBaseUrl }) {
  const [status, setStatus] = useState("checking");
  const [session, setSession] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const api = useCallback(async (path, options = {}) => {
    const headers = { "content-type": "application/json" };
    const bearer = options.accessToken || accessToken;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const token = options.csrfToken || csrfToken;
    if (options.csrf && token) headers["x-csrf-token"] = token;

    const response = await fetch(`${platformBaseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.code = payload.error || payload.code || "";
      error.status = response.status;
      throw error;
    }
    return payload;
  }, [accessToken, csrfToken, platformBaseUrl]);

  const finishLogin = useCallback((payload) => {
    const token = payload.accessToken || "";
    setSession(payload.session || null);
    setCsrfToken(payload.csrfToken || readPlatformCsrfCookie());
    setAccessToken(token);
    writeAccessToken(token);
    setErrorMessage("");
    setStatus("authenticated");
  }, []);

  const refreshSession = useCallback(async () => {
    setStatus("checking");
    setErrorMessage("");
    try {
      const storedAccessToken = readAccessToken();
      const payload = await fetch(`${platformBaseUrl}/v1/auth/session`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
          ...(storedAccessToken ? { authorization: `Bearer ${storedAccessToken}` } : {})
        },
        credentials: "include"
      }).then((response) => response.json().then((body) => ({ response, body })));
      if (!payload.response.ok || !payload.body.authenticated || !payload.body.session) {
        setSession(null);
        setCsrfToken("");
        setAccessToken("");
        writeAccessToken("");
        setStatus("unauthenticated");
        return;
      }
      setSession(payload.body.session);
      setCsrfToken(payload.body.csrfToken || readPlatformCsrfCookie());
      setAccessToken(payload.body.accessToken || storedAccessToken || "");
      writeAccessToken(payload.body.accessToken || storedAccessToken || "");
      setStatus("authenticated");
    } catch {
      setSession(null);
      setCsrfToken("");
      setAccessToken("");
      writeAccessToken("");
      setStatus("unauthenticated");
      setErrorMessage("セッションの復元に失敗しました。再ログインしてください。");
    }
  }, [platformBaseUrl]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const login = useCallback(async (credentials) => {
    setErrorMessage("");
    try {
      const payload = await api("/v1/auth/login", {
        method: "POST",
        body: credentials
      });
      finishLogin(payload);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "ログインに失敗しました。"));
      setStatus("unauthenticated");
    }
  }, [api, finishLogin]);

  const logout = useCallback(async () => {
    if (session || csrfToken) {
      await api("/v1/auth/logout", {
        method: "POST",
        csrf: true,
        body: {}
      }).catch(() => null);
    }
    setSession(null);
    setCsrfToken("");
    setAccessToken("");
    writeAccessToken("");
    setErrorMessage("");
    setStatus("unauthenticated");
  }, [api, csrfToken, session]);

  const value = useMemo(() => ({
    accessToken,
    api,
    csrfToken,
    errorMessage,
    login,
    logout,
    refreshSession,
    session,
    status
  }), [accessToken, api, csrfToken, errorMessage, login, logout, refreshSession, session, status]);

  return <PlatformAuthContext.Provider value={value}>{children}</PlatformAuthContext.Provider>;
}

export function AuthGate({ children }) {
  const auth = usePlatformAuth();
  if (auth.status === "checking") {
    return (
      <main className="auth-loading-page" aria-busy="true">
        <div className="auth-loading-panel">
          <div className="skeleton skeleton-heading" />
          <div className="skeleton skeleton-block" />
          <div className="skeleton skeleton-block" />
        </div>
      </main>
    );
  }
  if (auth.status === "unauthenticated") {
    return <LoginGate />;
  }
  return children;
}

function LoginGate() {
  const { errorMessage, login } = usePlatformAuth();
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    await login({
      organizationCode: form.get("organizationCode"),
      loginId: form.get("loginId"),
      password: form.get("password")
    });
    setBusy(false);
  }

  return (
    <div className="operator-gate">
      <div className="operator-gate-shell">
        <aside className="operator-gate-brand">
          <div className="operator-gate-brand-top">
            <img alt={BRAND_NAME} className="operator-gate-mark" height="56" src="/brand/harunas-mark.png" width="56" />
            <span className="operator-gate-wordmark">{BRAND_NAME}</span>
          </div>
          <div className="operator-gate-pitch">
            <h2>紹介状作成を、カルテから。</h2>
            <p>患者、カルテ、宛先、依頼事項をまとめて、診療情報提供書の下書きと印刷を支援します。</p>
            <div className="operator-gate-features">
              <div className="operator-gate-feature"><span>カルテ/SOAPから紹介状の下書きへ</span></div>
              <div className="operator-gate-feature"><span>宛先、テンプレート、確認項目を管理</span></div>
              <div className="operator-gate-feature"><span>医師確認後に印刷/PDF保存</span></div>
            </div>
          </div>
          <div className="operator-gate-foot">
            <span>© {BRAND_NAME}</span>
            <span>{PRODUCT_NAME}</span>
          </div>
        </aside>
        <section className="operator-gate-form-area">
          <form className="operator-gate-card" onSubmit={handleSubmit}>
            <div>
              <h1>ログイン</h1>
              <p>病院コード、個人ID、ログイン用パスワードでログインしてください。</p>
            </div>
            <div className="field">
              <label htmlFor="organizationCode">病院コード</label>
              <input id="organizationCode" name="organizationCode" autoComplete="organization" required />
            </div>
            <div className="field">
              <label htmlFor="loginId">個人ID</label>
              <input id="loginId" name="loginId" autoComplete="username" required />
            </div>
            <div className="field">
              <label htmlFor="password">ログイン用パスワード</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            {errorMessage ? <div className="inline-error" role="status">{errorMessage}</div> : null}
            <div className="operator-gate-actions">
              <button className="btn btn--primary btn--lg" disabled={busy} type="submit">ログイン</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

export function usePlatformAuth() {
  const context = useContext(PlatformAuthContext);
  if (!context) {
    throw new Error("usePlatformAuth must be used within PlatformAuthProvider");
  }
  return context;
}

function readAccessToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
}

function writeAccessToken(token) {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  }
}

function readPlatformCsrfCookie() {
  if (typeof document === "undefined") return "";
  const preferredNames = location.hostname.includes(".stg.")
    ? ["halunasu_stg_csrf", "halunasu_csrf"]
    : ["halunasu_csrf", "halunasu_stg_csrf"];
  const cookies = Object.fromEntries(
    document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf("=");
        if (separatorIndex === -1) return [cookie, ""];
        return [cookie.slice(0, separatorIndex), decodeURIComponent(cookie.slice(separatorIndex + 1))];
      })
  );
  for (const name of preferredNames) {
    if (cookies[name]) return cookies[name];
  }
  return "";
}

function toUserFacingErrorMessage(error, fallbackMessage) {
  const text = String(error?.message || "").trim();
  const lower = text.toLowerCase();
  const status = Number(error?.status || 0);
  if (lower.includes("invalid credentials")) return "病院コード、個人ID、またはログイン用パスワードが正しくありません。";
  if (lower.includes("csrf")) return "画面を再読み込みして、もう一度お試しください。";
  if (status === 403) return "この操作を行う権限がありません。";
  if (status >= 500) return "処理中に問題が発生しました。時間を置いてもう一度お試しください。";
  return /[ぁ-んァ-ヶ一-龠]/u.test(text) ? text : fallbackMessage;
}
