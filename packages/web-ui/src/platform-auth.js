"use client";

// 共通: platform-api 認証(ログイン/セッション/MFA)とログイン画面UI。
// fee/referral/core-admin で重複していた platform-auth.js を一本化した正(canonical)。
// ブランド(名称/プロダクト名/ログイン訴求)は PlatformAuthProvider の brand prop で受け取る。
// ※ charting は charting-gateway のオペレーター認証で別系統のため対象外。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingErrorMessage } from "./user-facing-error.js";
import { LoginFormView, MfaFormView } from "./login-views.js";

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
    const enrollment = await api("/v1/auth/mfa/enroll", {
      method: "POST",
      csrf: true,
      csrfToken: token,
      accessToken: bearer,
      body: {}
    });
    setSession(payload.session || null);
    setCsrfToken(token);
    setMfa({ mode: "enroll", challenge: enrollment.mfa || null });
    setErrorMessage("");
    setStatus("mfa");
  }, [accessToken, api]);

  const continueAfterLogin = useCallback(async (payload) => {
    if (shouldPromptMfaEnrollment(payload.session)) {
      await beginMfaEnrollment(payload);
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

      setSession(payload.session);
      setCsrfToken(payload.csrfToken || readPlatformCsrfCookie());
      setAccessToken(payload.accessToken || accessToken || "");
      writeAccessToken(payload.accessToken || accessToken || "");
      setStatus("authenticated");
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
  }, [accessToken, api]);

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

        setSession(payload.session);
        setCsrfToken(payload.csrfToken || readPlatformCsrfCookie());
        setAccessToken(payload.accessToken || storedAccessToken || "");
        writeAccessToken(payload.accessToken || storedAccessToken || "");
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

export function getStoredPlatformAccessToken() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
}

function readAccessToken() {
  return getStoredPlatformAccessToken();
}

function writeAccessToken(token) {
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
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

function shouldPromptMfaEnrollment(session) {
  if (!session || session.mfaVerified) {
    return false;
  }
  const roles = Array.isArray(session.globalRoles) ? session.globalRoles : [];
  return roles.includes("org_admin") || roles.includes("billing_admin") || roles.includes("platform_admin");
}
