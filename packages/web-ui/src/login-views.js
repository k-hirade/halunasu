"use client";

// 共通: ログイン画面の見た目(プレゼンテーション)。認証ロジックからは独立。
// platform-api系(platform-auth)も charting(charting-gateway認証)も同じ見た目を使う。
// 認証の差し替えは onSubmit / props で吸収する。

import { useState } from "react";

export function AuthBrandPanel({ brandName, productName, title, copy, features = [] }) {
  return (
    <aside className="operator-gate-brand">
      <div className="operator-gate-brand-top">
        <img alt={brandName} className="operator-gate-mark" height="56" src="/brand/harunas-mark.png" width="56" />
        <span className="operator-gate-wordmark">{brandName}</span>
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
        <span>© {brandName}</span>
        {productName ? <span>{productName}</span> : null}
      </div>
    </aside>
  );
}

// パスワード表示トグルのアイコン(目)。表示トグルの正(canonical)。
export function PasswordToggleIcon({ visible }) {
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

// ログインフォーム(病院コード/個人ID/パスワード)。入力は uncontrolled(FormData)。
// onSubmit({ organizationCode, loginId, password }) を呼ぶ。
export function LoginFormView({
  brandName,
  productName,
  pitch = { title: "ログイン", copy: "", features: [] },
  heading = "ログイン",
  description = "病院コード、個人ID、ログイン用パスワードでログインしてください。",
  errorMessage,
  busy,
  onSubmit
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);

  function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      organizationCode: form.get("organizationCode"),
      loginId: form.get("loginId"),
      password: form.get("password")
    });
  }

  return (
    <div className="operator-gate">
      <div className="operator-gate-shell">
        <AuthBrandPanel
          brandName={brandName}
          productName={productName}
          title={pitch.title}
          copy={pitch.copy}
          features={pitch.features}
        />
        <section className="operator-gate-form-area">
          <form className="operator-gate-card" onSubmit={handleSubmit}>
            <div>
              <h1>{heading}</h1>
              <p>{description}</p>
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

// MFA(2段階認証)フォーム。コードは controlled(onCodeChange)。
export function MfaFormView({
  brandName,
  productName,
  isEnroll,
  qrCodeDataUrl,
  secret,
  code,
  onCodeChange,
  onSubmit,
  onBack,
  errorMessage,
  busy
}) {
  function handleSubmit(event) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="operator-gate">
      <div className="operator-gate-shell">
        <AuthBrandPanel
          brandName={brandName}
          productName={productName}
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
            {isEnroll && qrCodeDataUrl ? (
              <div className="operator-mfa-qr">
                <img alt="認証アプリ登録用QRコード" src={qrCodeDataUrl} />
                <span>認証アプリでQRコードを読み取ってください。</span>
              </div>
            ) : null}
            {isEnroll && secret ? (
              <div className="field">
                <label htmlFor="mfaSecret">シークレット</label>
                <input id="mfaSecret" readOnly type="text" value={secret} />
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
                onChange={(event) => onCodeChange(event.target.value.replace(/\D+/g, "").slice(0, 6))}
              />
            </div>
            {errorMessage ? <div className="inline-error" role="status">{errorMessage}</div> : null}
            <div className="operator-gate-actions">
              <button className="btn btn--primary btn--lg" disabled={busy || code.length !== 6} type="submit">確認</button>
              {onBack ? <button className="btn btn--ghost btn--lg" disabled={busy} onClick={onBack} type="button">戻る</button> : null}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
