"use client";

import QRCode from "qrcode";
import { startTransition, useEffect, useState } from "react";
import { BRAND_NAME } from "../lib/brand";
import { loginPlatformBillingSession } from "../lib/billing-api";
import { confirmOperatorMfaEnrollment, loginOperator, verifyOperatorMfa } from "../lib/operator-access";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";

export function OperatorLoginPanel({
  onAuthenticated,
  title = "ログイン",
  description = "病院コード、個人ID、パスワードでログインしてください。"
}) {
  const [organizationCode, setOrganizationCode] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaQrDataUrl, setMfaQrDataUrl] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!mfaChallenge?.totpUri) {
      setMfaQrDataUrl("");
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(mfaChallenge.totpUri, {
      margin: 1,
      width: 192
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setMfaQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMfaQrDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mfaChallenge?.totpUri]);

  function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setIsPending(true);

    startTransition(async () => {
      try {
        const result = await loginOperator({ organizationCode, loginId, password });
        if (result.requiresMfa || result.requiresMfaEnrollment) {
          setMfaChallenge(result);
          setMfaCode("");
          return;
        }
        await syncPlatformBillingSession({ organizationCode, loginId, password });
        onAuthenticated(result.accessToken);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError, "ログインに失敗しました。"));
      } finally {
        setIsPending(false);
      }
    });
  }

  function handleMfaSubmit(event) {
    event.preventDefault();
    if (!mfaChallenge) {
      return;
    }

    setError("");
    setIsPending(true);

    startTransition(async () => {
      try {
        const action = mfaChallenge.requiresMfaEnrollment ? confirmOperatorMfaEnrollment : verifyOperatorMfa;
        const result = await action({
          challengeId: mfaChallenge.challengeId,
          code: mfaCode
        });
        await syncPlatformBillingSession({ organizationCode, loginId, password, mfaCode });
        onAuthenticated(result.accessToken);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError, "確認に失敗しました。"));
      } finally {
        setIsPending(false);
      }
    });
  }

  async function syncPlatformBillingSession(credentials) {
    try {
      await loginPlatformBillingSession(credentials);
    } catch (syncError) {
      console.warn("platform billing session sync failed", syncError);
    }
  }

  if (mfaChallenge) {
    return (
      <div className="operator-gate">
        <div className="operator-gate-shell">
          <aside className="operator-gate-brand">
            <div className="operator-gate-brand-top">
              <img
                alt={BRAND_NAME}
                className="operator-gate-mark"
                height="56"
                src="/brand/harunas-mark.png"
                width="56"
              />
              <span className="operator-gate-wordmark">{BRAND_NAME}</span>
            </div>
            <div className="operator-gate-pitch">
              <h2>本人確認</h2>
              <p>認証アプリの6桁コードを入力してください。</p>
            </div>
          </aside>

          <section className="operator-gate-form-area">
            <form className="operator-gate-card" onSubmit={handleMfaSubmit}>
              <div>
                <h1>{mfaChallenge.requiresMfaEnrollment ? "認証アプリを登録" : "確認コード"}</h1>
                <p style={{ marginTop: 6 }}>
                  {mfaChallenge.requiresMfaEnrollment
                    ? "認証アプリにシークレットを登録し、表示された6桁コードを入力してください。"
                    : "認証アプリに表示された6桁コードを入力してください。"}
                </p>
              </div>
              {mfaChallenge.requiresMfaEnrollment ? (
                <>
                  {mfaQrDataUrl ? (
                    <div className="operator-mfa-qr">
                      <img alt="認証アプリ登録用QRコード" src={mfaQrDataUrl} />
                      <span>認証アプリでQRコードを読み取ってください。</span>
                    </div>
                  ) : null}
                  <div className="field">
                    <label htmlFor="operatorMfaSecret">シークレット</label>
                    <input id="operatorMfaSecret" readOnly type="text" value={mfaChallenge.secret || ""} />
                  </div>
                </>
              ) : null}
              <div className="field">
                <label htmlFor="operatorMfaCode">6桁コード</label>
                <input
                  id="operatorMfaCode"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  pattern="[0-9]{6}"
                  placeholder="123456"
                  type="text"
                  value={mfaCode}
                  autoComplete="one-time-code"
                />
              </div>
              <div className="operator-gate-actions">
                <button
                  className={`btn btn--primary btn--lg ${isPending ? "btn--loading" : ""}`}
                  disabled={isPending || mfaCode.length !== 6}
                  type="submit"
                >
                  <span>確認</span>
                  {isPending ? <span className="btn-spinner" aria-hidden="true" /> : null}
                </button>
                <button
                  className="btn btn--ghost btn--lg"
                  disabled={isPending}
                  onClick={() => {
                    setMfaChallenge(null);
                    setMfaCode("");
                    setMfaQrDataUrl("");
                    setPassword("");
                  }}
                  type="button"
                >
                  戻る
                </button>
              </div>
              {error ? <div className="inline-error">{error}</div> : null}
            </form>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="operator-gate">
        <div className="operator-gate-shell">
        <aside className="operator-gate-brand">
          <div className="operator-gate-brand-top">
            <img
              alt={BRAND_NAME}
              className="operator-gate-mark"
              height="56"
              src="/brand/harunas-mark.png"
              width="56"
            />
            <span className="operator-gate-wordmark">{BRAND_NAME}</span>
          </div>

          <div className="operator-gate-pitch">
            <h2>診療の記録を、<br />AI と一緒に。</h2>
            <p>
              診察中の会話をスマホで録音し、診療記録の下書きをその場で作成します。
              医師は内容を確認・修正してから、電子カルテへ転記できます。
            </p>
            <div className="operator-gate-features">
              <div className="operator-gate-feature">
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                <span>診察に集中したまま、その場で書き起こしを確認</span>
              </div>
              <div className="operator-gate-feature">
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                <span>診療記録の下書きを自動作成し、そのまま編集</span>
              </div>
              <div className="operator-gate-feature">
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                <span>確定した記録だけを保存し、操作履歴を残す</span>
              </div>
            </div>
          </div>

          <div className="operator-gate-foot">
            <span>© {BRAND_NAME}</span>
          </div>
        </aside>

        <section className="operator-gate-form-area">
          <form className="operator-gate-card" onSubmit={handleSubmit}>
            <div>
              <h1>{title}</h1>
              <p style={{ marginTop: 6 }}>{description}</p>
            </div>
            <div className="field">
              <label htmlFor="operatorOrganizationCode">病院コード</label>
              <input
                id="operatorOrganizationCode"
                onChange={(event) => setOrganizationCode(event.target.value)}
                placeholder="例: clinic_tokyo_001"
                type="text"
                value={organizationCode}
                autoComplete="organization"
              />
            </div>
            <div className="field">
              <label htmlFor="operatorLoginId">個人ID</label>
              <input
                id="operatorLoginId"
                onChange={(event) => setLoginId(event.target.value)}
                placeholder="例: yamada"
                type="text"
                value={loginId}
                autoComplete="username"
              />
            </div>
            <div className="field">
              <label htmlFor="operatorPassword">ログイン用パスワード</label>
              <div className="field-password">
                <input
                  id="operatorPassword"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="パスワードを入力"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div className="operator-gate-actions">
              <button
                className={`btn btn--primary btn--lg ${isPending ? "btn--loading" : ""}`}
                disabled={isPending || !organizationCode.trim() || !loginId.trim() || !password}
                type="submit"
              >
                <span>ログイン</span>
                {isPending ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
            {error ? <div className="inline-error">{error}</div> : null}
          </form>
        </section>
      </div>
    </div>
  );
}
