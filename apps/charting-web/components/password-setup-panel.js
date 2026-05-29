"use client";

import { useEffect, useState } from "react";

import { getPasswordSetupState, submitPasswordSetup } from "../lib/billing-api";

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function PasswordSetupPanel({ tokenId }) {
  const [payload, setPayload] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [didComplete, setDidComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getPasswordSetupState(tokenId)
      .then((nextPayload) => {
        if (!cancelled) {
          setPayload(nextPayload);
          setError("");
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError.message || "初回設定リンクの確認に失敗しました。");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  async function handleSubmit(event) {
    event.preventDefault();

    if (password.length < 12) {
      setError("パスワードは12文字以上で入力してください。");
      return;
    }

    if (password !== confirmPassword) {
      setError("確認用パスワードが一致しません。");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const response = await submitPasswordSetup(tokenId, password);
      setPayload({
        token: response.token
      });
      setDidComplete(true);
      setPassword("");
      setConfirmPassword("");
    } catch (submitError) {
      setError(submitError.message || "パスワード設定に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const token = payload?.token || null;
  const tokenStatus = token?.status || null;
  const canSubmit = tokenStatus === "active" && !didComplete;
  const isUsed = tokenStatus === "used";
  const isExpired = tokenStatus === "expired";

  let heading = "初回パスワード設定";
  let lead = "病院作成は完了しています。管理者アカウントの初回パスワードを設定してください。";

  if (didComplete) {
    heading = "初回設定が完了しました";
    lead = "ログイン画面へ進み、申込時に入力した病院コードと管理者ログインIDで利用を開始してください。";
  } else if (isUsed) {
    heading = "このリンクは使用済みです";
    lead = "すでに初回設定は完了しています。ログイン画面からサインインしてください。";
  } else if (isExpired) {
    heading = "このリンクの有効期限が切れています";
    lead = "初回設定リンクの再発行が必要です。管理者へお問い合わせください。";
  }

  return (
    <main className="signup-status-shell password-setup-page">
      <section className="signup-panel signup-panel--single signup-status-panel">
        <div className="signup-heading">
          <h1>{heading}</h1>
          <p className="signup-lead">{lead}</p>
        </div>

        <dl className="signup-status-meta password-setup-meta">
          <div>
            <dt>病院名</dt>
            <dd>{token?.organizationDisplayName || "-"}</dd>
          </div>
          <div>
            <dt>管理者メール</dt>
            <dd>{token?.email || "-"}</dd>
          </div>
          <div>
            <dt>{isUsed ? "設定完了時刻" : "有効期限"}</dt>
            <dd>{formatDateTime(isUsed ? token?.usedAt : token?.expiresAt)}</dd>
          </div>
        </dl>

        {canSubmit ? (
          <form className="signup-form signup-status-primary-card password-setup-form" onSubmit={handleSubmit}>
            <label>
              <span>新しいパスワード</span>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="12文字以上"
              />
            </label>
            <label>
              <span>確認用パスワード</span>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="もう一度入力"
              />
            </label>

            <p className="password-setup-note">英字・数字・記号を組み合わせた12文字以上を推奨します。</p>

            <button className="signup-submit" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "設定中..." : "パスワードを設定する"}
            </button>
          </form>
        ) : null}

        {didComplete || isUsed ? (
          <div className="signup-status-actions password-setup-success">
            <a className="signup-submit signup-submit-link" href="/">ログイン画面へ進む</a>
          </div>
        ) : null}

        {error ? <p className="signup-error">{error}</p> : null}
      </section>
    </main>
  );
}
