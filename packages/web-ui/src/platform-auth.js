"use client";

// 共通: platform-api 認証(ログイン/セッション/MFA)とログイン画面UI。
// fee/referral/core-admin で重複していた platform-auth.js を一本化した正(canonical)。
// ブランド(名称/プロダクト名/ログイン訴求)は PlatformAuthProvider の brand prop で受け取る。
// ※ charting は charting-gateway のオペレーター認証で別系統のため対象外。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingErrorMessage } from "./user-facing-error.js";

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
  const [passwordVisible, setPasswordVisible] = useState(false);
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
        <AuthBrandPanel
          brand={brand}
          title={brand.login.title}
          copy={brand.login.copy}
          features={brand.login.features}
        />
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
              <div className="field-password">
                <input
                  id="password"
                  name="password"
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="current-password"
                  required
                />
                <button
                  aria-label={passwordVisible ? "ログイン用パスワードを隠す" : "ログイン用パスワードを表示"}
                  className="password-toggle"
                  onClick={() => setPasswordVisible((current) => !current)}
                  type="button"
                >
                  <PasswordToggleIcon visible={passwordVisible} />
                </button>
              </div>
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

function MfaGate() {
  const { brand, cancelMfa, errorMessage, mfa, verifyMfa } = usePlatformAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const isEnroll = mfa.mode === "enroll";

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    await verifyMfa(code);
    setBusy(false);
  }

  return (
    <div className="operator-gate">
      <div className="operator-gate-shell">
        <AuthBrandPanel
          brand={brand}
          title={isEnroll ? "2段階認証を登録" : "本人確認"}
          copy={isEnroll ? "認証アプリにシークレットを登録し、表示された6桁コードを入力してください。" : "認証アプリの6桁コードを入力してください。"}
          features={["病院データを安全に扱うため、管理操作では本人確認を行います。"]}
        />
        <section className="operator-gate-form-area">
          <form className="operator-gate-card" onSubmit={handleSubmit}>
            <div>
              <h1>{isEnroll ? "認証アプリを登録" : "確認コード"}</h1>
              <p>{isEnroll ? "認証アプリに登録してから、6桁コードを入力してください。" : "認証アプリに表示された6桁コードを入力してください。"}</p>
            </div>
            {isEnroll && mfa.challenge?.qrCodeDataUrl ? (
              <div className="operator-mfa-qr">
                <img alt="認証アプリ登録用QRコード" src={mfa.challenge.qrCodeDataUrl} />
                <span>認証アプリでQRコードを読み取ってください。</span>
              </div>
            ) : null}
            {isEnroll && mfa.challenge?.secret ? (
              <div className="field">
                <label htmlFor="mfaSecret">シークレット</label>
                <input id="mfaSecret" readOnly type="text" value={mfa.challenge.secret} />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="mfaCode">6桁コード</label>
              <input
                id="mfaCode"
                name="mfaCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
              />
            </div>
            {errorMessage ? <div className="inline-error" role="status">{errorMessage}</div> : null}
            <div className="operator-gate-actions">
              <button className="btn btn--primary btn--lg" disabled={busy || code.length !== 6} type="submit">確認</button>
              <button className="btn btn--ghost btn--lg" disabled={busy} onClick={cancelMfa} type="button">戻る</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

// パスワード表示トグルのアイコン(目)。表示トグルの正をアイコン+aria-labelに統一(ステップ3)。
function PasswordToggleIcon({ visible }) {
  if (visible) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function AuthBrandPanel({ brand, copy, features, title }) {
  return (
    <aside className="operator-gate-brand">
      <div className="operator-gate-brand-top">
        <img alt={brand.name} className="operator-gate-mark" height="56" src="/brand/harunas-mark.png" width="56" />
        <span className="operator-gate-wordmark">{brand.name}</span>
      </div>
      <div className="operator-gate-pitch">
        <h2>{title}</h2>
        {copy ? <p>{copy}</p> : null}
        <div className="operator-gate-features">
          {features.map((feature) => (
            <div className="operator-gate-feature" key={feature}>
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
              <span>{feature}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="operator-gate-foot">
        <span>© {brand.name}</span>
        <span>{brand.product}</span>
      </div>
    </aside>
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
