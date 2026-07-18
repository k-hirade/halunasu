"use client";

// 共通: platform-api 認証(ログイン/セッション/MFA)とログイン画面UI。
// fee/referral/core-admin で重複していた platform-auth.js を一本化した正(canonical)。
// ブランド(名称/プロダクト名/ログイン訴求)は PlatformAuthProvider の brand prop で受け取る。
// ※ charting は charting-gateway のオペレーター認証で別系統のため対象外。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingErrorMessage } from "./user-facing-error.js";
import { LoginFormView, MfaFormView } from "./login-views.js";
import {
  isPlatformSessionFullyAuthenticated,
  platformSessionAuthAction
} from "./platform-auth-state.js";

const PlatformAuthContext = createContext(null);
const ACCESS_TOKEN_STORAGE_KEY = "halunasu_platform_access_token";

const DEFAULT_BRAND = {
  name: "ハルナス",
  product: "",
  login: { title: "ログイン", copy: "", features: [] }
};

function normalizeBrand(brand) {
  const base = brand && typeof brand === "object" ? brand : {};
  const login = base.login && typeof base.login === "object" ? base.login : {};
  return {
    name: base.name || DEFAULT_BRAND.name,
    product: base.product || DEFAULT_BRAND.product,
    login: {
      title: login.title || DEFAULT_BRAND.login.title,
      copy: login.copy || "",
      features: Array.isArray(login.features) ? login.features : []
    }
  };
}

export function PlatformAuthProvider({ children, platformBaseUrl, brand }) {
  const [status, setStatus] = useState("checking");
  const [session, setSession] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [pendingLogin, setPendingLogin] = useState(null);
  const [mfa, setMfa] = useState({ mode: "", challenge: null });
  const [errorMessage, setErrorMessage] = useState("");
  const authMutationRef = useRef(0);
  const normalizedBrand = useMemo(() => normalizeBrand(brand), [brand]);

  // デプロイ構成(same-origin プロキシ or クロスオリジン)に応じてトークン永続化方針を決める。
  // 副作用前(初回レンダー時)に確定させたいので useMemo で同期的に適用する。
  useMemo(() => {
    setPlatformAccessTokenPersistence(shouldPersistPlatformAccessToken(platformBaseUrl));
  }, [platformBaseUrl]);

  const api = useCallback(async (path, options = {}) => {
    const headers = { "content-type": "application/json" };
    const bearer = options.accessToken || accessToken || getStoredPlatformAccessToken();
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    }
    const token = options.csrfToken || csrfToken;
    if (options.csrf && token) {
      headers["x-csrf-token"] = token;
    }

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
    authMutationRef.current += 1;
    const token = payload.accessToken || accessToken || readAccessToken();
    setSession(payload.session || null);
    setCsrfToken(payload.csrfToken || readPlatformCsrfCookie());
    setAccessToken(token || "");
    writeAccessToken(token || "");
    setPendingLogin(null);
    setMfa({ mode: "", challenge: null });
    setErrorMessage("");
    setStatus("authenticated");
  }, [accessToken]);

  const beginMfaEnrollment = useCallback(async (payload) => {
    const token = payload.csrfToken || readPlatformCsrfCookie();
    const bearer = payload.accessToken || accessToken;
    setAccessToken(bearer || "");
    writeAccessToken(bearer || "");
    const enrollment = await requestMfaEnrollment({
      platformBaseUrl,
      csrfToken: token,
      accessToken: bearer
    });
    setSession(payload.session || null);
    setCsrfToken(token);
    setMfa({ mode: "enroll", challenge: enrollment.mfa || null });
    setErrorMessage("");
    setStatus("mfa");
  }, [accessToken, platformBaseUrl]);

  const continueAfterLogin = useCallback(async (payload) => {
    const action = platformSessionAuthAction(payload.session);
    if (action === "enroll") {
      await beginMfaEnrollment(payload);
      return;
    }
    if (action === "reauthenticate") {
      setSession(null);
      setCsrfToken("");
      setAccessToken("");
      writeAccessToken("");
      setPendingLogin(null);
      setMfa({ mode: "", challenge: null });
      setErrorMessage("ログイン用パスワードと認証アプリの6桁コードを入力し直してください。");
      setStatus("unauthenticated");
      return;
    }
    finishLogin(payload);
  }, [beginMfaEnrollment, finishLogin]);

  const refreshSession = useCallback(async () => {
    authMutationRef.current += 1;
    setStatus("checking");
    setErrorMessage("");
    try {
      const payload = await api("/v1/auth/session");
      if (!payload.authenticated || !payload.session) {
        setSession(null);
        setCsrfToken("");
        setAccessToken("");
        writeAccessToken("");
        setStatus("unauthenticated");
        return;
      }

      await continueAfterLogin({
        ...payload,
        csrfToken: payload.csrfToken || readPlatformCsrfCookie(),
        accessToken: payload.accessToken || accessToken || ""
      });
    } catch (error) {
      setSession(null);
      setCsrfToken("");
      setAccessToken("");
      writeAccessToken("");
      setStatus("unauthenticated");
      if (error.status && error.status !== 401) {
        setErrorMessage("セッションの復元に失敗しました。再ログインしてください。");
      }
    }
  }, [accessToken, api, continueAfterLogin]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSession() {
      const hydrateGeneration = authMutationRef.current;
      setStatus("checking");
      setErrorMessage("");
      try {
        const storedAccessToken = readAccessToken();
        if (storedAccessToken) {
          setAccessToken(storedAccessToken);
        }
        const response = await fetch(`${platformBaseUrl}/v1/auth/session`, {
          method: "GET",
          headers: {
            "content-type": "application/json",
            ...(storedAccessToken ? { authorization: `Bearer ${storedAccessToken}` } : {})
          },
          credentials: "include"
        });
        const payload = await response.json().catch(() => ({}));
        if (hydrateGeneration !== authMutationRef.current) {
          return;
        }
        if (cancelled) {
          return;
        }
        if (!response.ok || !payload.authenticated || !payload.session) {
          setSession(null);
          setCsrfToken("");
          setAccessToken("");
          writeAccessToken("");
          setStatus("unauthenticated");
          return;
        }

        const restoredAccessToken = payload.accessToken || storedAccessToken || "";
        const restoredCsrfToken = payload.csrfToken || readPlatformCsrfCookie();
        const action = platformSessionAuthAction(payload.session);
        if (action === "enroll") {
          const enrollment = await requestMfaEnrollment({
            platformBaseUrl,
            csrfToken: restoredCsrfToken,
            accessToken: restoredAccessToken
          });
          if (hydrateGeneration !== authMutationRef.current || cancelled) {
            return;
          }
          setSession(payload.session);
          setCsrfToken(restoredCsrfToken);
          setAccessToken(restoredAccessToken);
          writeAccessToken(restoredAccessToken);
          setMfa({ mode: "enroll", challenge: enrollment.mfa || null });
          setStatus("mfa");
          return;
        }
        if (action === "reauthenticate") {
          setSession(null);
          setCsrfToken("");
          setAccessToken("");
          writeAccessToken("");
          setErrorMessage("ログイン用パスワードと認証アプリの6桁コードを入力し直してください。");
          setStatus("unauthenticated");
          return;
        }

        setSession(payload.session);
        setCsrfToken(restoredCsrfToken);
        setAccessToken(restoredAccessToken);
        writeAccessToken(restoredAccessToken);
        setStatus("authenticated");
      } catch {
        if (hydrateGeneration !== authMutationRef.current) {
          return;
        }
        if (cancelled) {
          return;
        }
        setSession(null);
        setCsrfToken("");
        setAccessToken("");
        writeAccessToken("");
        setStatus("unauthenticated");
        setErrorMessage("セッションの復元に失敗しました。再ログインしてください。");
      }
    }

    hydrateSession();

    return () => {
      cancelled = true;
    };
  }, [platformBaseUrl]);

  const login = useCallback(async (credentials) => {
    authMutationRef.current += 1;
    setErrorMessage("");
    setPendingLogin(credentials);
    try {
      const payload = await api("/v1/auth/login", {
        method: "POST",
        body: credentials
      });
      await continueAfterLogin(payload);
    } catch (error) {
      if (error.code === "mfa_required") {
        setMfa({ mode: "verify-login", challenge: null });
        setStatus("mfa");
        return;
      }
      setPendingLogin(null);
      setErrorMessage(toUserFacingErrorMessage(error, "ログインに失敗しました。"));
      setStatus("unauthenticated");
    }
  }, [api, continueAfterLogin]);

  const verifyMfa = useCallback(async (code) => {
    const normalizedCode = String(code || "").replace(/\D+/g, "").slice(0, 6);
    if (normalizedCode.length !== 6) {
      setErrorMessage("認証アプリの6桁コードを入力してください。");
      return;
    }

    setErrorMessage("");
    try {
      if (mfa.mode === "verify-login") {
        const payload = await api("/v1/auth/login", {
          method: "POST",
          body: {
            ...pendingLogin,
            mfaCode: normalizedCode
          }
        });
        finishLogin(payload);
        return;
      }

      if (mfa.mode === "enroll") {
        const payload = await api("/v1/auth/mfa/verify", {
          method: "POST",
          csrf: true,
          body: { code: normalizedCode }
        });
        finishLogin(payload);
        return;
      }

      setErrorMessage("本人確認をやり直してください。");
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "本人確認に失敗しました。"));
    }
  }, [api, finishLogin, mfa.mode, pendingLogin]);

  const cancelMfa = useCallback(async () => {
    authMutationRef.current += 1;
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
    setPendingLogin(null);
    setMfa({ mode: "", challenge: null });
    setStatus("unauthenticated");
  }, [api, csrfToken, session]);

  const logout = useCallback(async () => {
    authMutationRef.current += 1;
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
    setPendingLogin(null);
    setMfa({ mode: "", challenge: null });
    setErrorMessage("");
    setStatus("unauthenticated");
  }, [api, csrfToken, session]);

  const value = useMemo(() => ({
    api,
    accessToken,
    brand: normalizedBrand,
    cancelMfa,
    csrfToken,
    errorMessage,
    login,
    logout,
    mfa,
    refreshSession,
    session,
    status,
    verifyMfa
  }), [
    api,
    accessToken,
    normalizedBrand,
    cancelMfa,
    csrfToken,
    errorMessage,
    login,
    logout,
    mfa,
    refreshSession,
    session,
    status,
    verifyMfa
  ]);

  return <PlatformAuthContext.Provider value={value}>{children}</PlatformAuthContext.Provider>;
}

export function AuthGate({ children }) {
  const auth = usePlatformAuth();

  if (auth.status === "checking") {
    return <AuthChecking />;
  }

  if (auth.status === "unauthenticated") {
    return <LoginGate />;
  }

  if (auth.status === "mfa") {
    return <MfaGate />;
  }

  if (!isPlatformSessionFullyAuthenticated(auth.session)) {
    return <LoginGate />;
  }

  return children;
}

function AuthChecking() {
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

function LoginGate() {
  const { brand, errorMessage, login } = usePlatformAuth();
  const [busy, setBusy] = useState(false);

  async function handleSubmit(credentials) {
    setBusy(true);
    await login(credentials);
    setBusy(false);
  }

  return (
    <LoginFormView
      brandName={brand.name}
      productName={brand.product}
      pitch={brand.login}
      errorMessage={errorMessage}
      busy={busy}
      onSubmit={handleSubmit}
    />
  );
}

function MfaGate() {
  const { brand, cancelMfa, errorMessage, mfa, verifyMfa } = usePlatformAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    await verifyMfa(code);
    setBusy(false);
  }

  return (
    <MfaFormView
      brandName={brand.name}
      productName={brand.product}
      isEnroll={mfa.mode === "enroll"}
      qrCodeDataUrl={mfa.challenge?.qrCodeDataUrl || ""}
      secret={mfa.challenge?.secret || ""}
      code={code}
      onCodeChange={setCode}
      onSubmit={handleSubmit}
      onBack={cancelMfa}
      errorMessage={errorMessage}
      busy={busy}
    />
  );
}

export function usePlatformAuth() {
  const context = useContext(PlatformAuthContext);
  if (!context) {
    throw new Error("usePlatformAuth must be used within PlatformAuthProvider");
  }
  return context;
}

// アクセストークンの保存方針:
// 既定(same-origin プロキシ経由 = /api/... 相対URL)では HttpOnly セッション cookie が同一オリジンで
// 認証を担うため、Bearer トークンを localStorage に永続保存しない(XSSによる持ち出し面を排除)。
// 生存期間中はメモリ上のミラーだけを保持し、リロード時は cookie を使った /v1/auth/session で復元する。
// クロスオリジンの API ベースURL(NEXT_PUBLIC_*_BASE_URL に絶対URLを設定)を使う構成では、
// SameSite=Lax cookie がクロスサイト fetch で送られないため、従来どおり localStorage 永続化にフォールバックする。
let accessTokenPersistenceEnabled = false;
let inMemoryAccessToken = "";

export function setPlatformAccessTokenPersistence(enabled) {
  accessTokenPersistenceEnabled = Boolean(enabled);
  if (typeof window === "undefined") {
    return;
  }
  if (!accessTokenPersistenceEnabled) {
    // same-origin 構成に切り替わった場合、過去に永続化された古いトークンを掃除する。
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  }
}

// API ベースURLが絶対URL(http/https)= クロスオリジン構成かどうか。相対URL(/api/...)は same-origin プロキシ。
export function shouldPersistPlatformAccessToken(baseUrl) {
  return /^https?:\/\//iu.test(String(baseUrl || "").trim());
}

export function getStoredPlatformAccessToken() {
  if (inMemoryAccessToken) {
    return inMemoryAccessToken;
  }
  if (typeof window === "undefined" || !accessTokenPersistenceEnabled) {
    return "";
  }
  return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
}

function readAccessToken() {
  return getStoredPlatformAccessToken();
}

function writeAccessToken(token) {
  inMemoryAccessToken = token || "";
  if (typeof window === "undefined") {
    return;
  }
  if (accessTokenPersistenceEnabled && token) {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  }
}

function readPlatformCsrfCookie() {
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
        if (separatorIndex === -1) {
          return [cookie, ""];
        }
        return [cookie.slice(0, separatorIndex), decodeURIComponent(cookie.slice(separatorIndex + 1))];
      })
  );
  for (const name of preferredNames) {
    if (cookies[name]) {
      return cookies[name];
    }
  }
  return "";
}

async function requestMfaEnrollment({ platformBaseUrl, csrfToken, accessToken }) {
  const headers = { "content-type": "application/json" };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }

  const response = await fetch(`${platformBaseUrl}/v1/auth/mfa/enroll`, {
    method: "POST",
    headers,
    credentials: "include",
    body: "{}"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.code = payload.error || payload.code || "";
    error.status = response.status;
    throw error;
  }
  return payload;
}
