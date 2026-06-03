"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  inspectContactSignupVerification,
  resendContactSignupMail,
  verifyContactSignup
} from "../lib/billing-api";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";

export function ContactSignupVerifyPanel() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const [inspection, setInspection] = useState(null);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("確認トークンが見つかりません。");
      return;
    }

    let cancelled = false;

    inspectContactSignupVerification(token)
      .then((nextPayload) => {
        if (!cancelled) {
          setInspection(nextPayload);
          setError("");
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(toUserFacingErrorMessage(loadError, "確認処理に失敗しました。"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleVerify() {
    if (!token || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError("");
    setNotice("");

    try {
      const nextPayload = await verifyContactSignup(token);
      setPayload(nextPayload);
      setInspection((current) => current ? {
        ...current,
        signup: {
          ...current.signup,
          status: nextPayload.signup.status,
          organizationName: nextPayload.signup.organizationName,
          adminEmailMasked: nextPayload.signup.adminEmailMasked,
          updatedAt: nextPayload.signup.updatedAt
        },
        tokenStatus: "used",
        canProceed: true
      } : current);
    } catch (submitError) {
      setError(toUserFacingErrorMessage(submitError, "確認処理に失敗しました。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    const signupId = inspection?.signup?.signupId || payload?.signup?.signupId || "";
    if (!signupId || isResending) {
      return;
    }

    setIsResending(true);
    setError("");
    setNotice("");

    try {
      const result = await resendContactSignupMail(signupId);
      setNotice(result.mode === "verification"
        ? "確認メールを再送しました。"
        : "初回設定メールを再送しました。");
    } catch (resendError) {
      setError(toUserFacingErrorMessage(resendError, "メールの再送に失敗しました。"));
    } finally {
      setIsResending(false);
    }
  }

  const currentSignup = payload?.signup || inspection?.signup || null;
  const isLoading = !inspection && !error;
  const tokenStatus = inspection?.tokenStatus || null;
  const canProceed = inspection?.canProceed && !payload;
  const canResend = Boolean(inspection?.signup?.signupId) && ["submitted", "provisioned", "failed"].includes(inspection?.signup?.status || "");
  const primaryLabel = tokenStatus === "active" ? "メール確認を完了して利用開始へ進む" : "利用開始情報を表示";
  const title = payload?.passwordSetupUrl
    ? "利用開始の準備ができました"
    : canProceed
      ? "利用開始の準備を進めます"
      : tokenStatus === "expired"
        ? "この確認リンクの有効期限が切れています"
        : "メール確認を反映しています";
  const lead = payload?.passwordSetupUrl
    ? "ログイン用パスワード設定を完了すると利用を開始できます。"
    : canProceed
      ? "メール確認後に病院アカウントを作成します。準備ができたら次の設定へ進めます。"
      : tokenStatus === "expired"
        ? "確認メールを再送して、新しいリンクからもう一度お進みください。"
        : "利用開始情報を準備しています。";
  const showProvisionedMeta = Boolean(payload?.signup?.organizationCode || payload?.signup?.adminLoginId || currentSignup?.adminEmailMasked || isLoading);

  return (
    <main className="signup-status-shell">
      <section className="signup-panel signup-panel--single signup-status-panel">
        <div className="signup-heading">
          <h1>{title}</h1>
          <p className="signup-lead">{lead}</p>
        </div>

        {payload?.passwordSetupUrl ? (
          <div className="signup-status-primary-card">
            <p className="signup-status-primary-title">初回設定を完了すると利用を開始できます</p>
            <p className="signup-status-primary-copy">管理者のログイン用パスワード設定が終わると、そのままログインして利用を開始できます。</p>
            <div className="signup-status-actions contact-signup-actions">
              <a className="signup-submit signup-submit-link" href={payload.passwordSetupUrl}>ログイン用パスワード設定へ進む</a>
            </div>
          </div>
        ) : null}

        {!payload && canProceed ? (
          <div className="signup-status-primary-card">
            <p className="signup-status-primary-title">メール確認を完了して利用開始へ進みます</p>
            <p className="signup-status-primary-copy">この操作のあと、病院アカウントの作成と管理者設定の準備を進めます。</p>
            <div className="signup-status-actions contact-signup-actions">
              <button className="signup-submit" type="button" onClick={handleVerify} disabled={isSubmitting}>
                <span>{isSubmitting ? "利用開始情報を準備中..." : primaryLabel}</span>
              </button>
            </div>
          </div>
        ) : null}

        {!payload && tokenStatus === "expired" && canResend ? (
          <div className="signup-status-primary-card">
            <p className="signup-status-primary-title">確認リンクの有効期限が切れています</p>
            <p className="signup-status-primary-copy">確認メールを再送して、新しいリンクからもう一度お進みください。</p>
            <div className="signup-status-actions contact-signup-actions">
              <button className="signup-submit" type="button" onClick={handleResend} disabled={isResending}>
                <span>{isResending ? "メールを再送中..." : "確認メールを再送"}</span>
              </button>
            </div>
          </div>
        ) : null}

        {payload?.passwordSetupUrl ? (
          <div className="signup-status-support">
            <a className="signup-status-support-link" href={payload.loginUrl}>ログイン画面へ</a>
            <button className="signup-status-support-link" type="button" onClick={handleResend} disabled={isResending}>
              {isResending ? "初回設定メールを再送中..." : "初回設定メールを再送"}
            </button>
          </div>
        ) : null}

        {showProvisionedMeta ? (
          <dl className="signup-status-meta">
            <div>
              <dt>病院コード</dt>
              <dd>{payload?.signup?.organizationCode || (isLoading ? <span className="skeleton skeleton-text signup-inline-skeleton" /> : "-")}</dd>
            </div>
            <div>
              <dt>個人ID</dt>
              <dd>{payload?.signup?.adminLoginId || (isLoading ? <span className="skeleton skeleton-text signup-inline-skeleton" /> : "-")}</dd>
            </div>
            <div>
              <dt>案内先メールアドレス</dt>
              <dd>{currentSignup?.adminEmailMasked || (isLoading ? <span className="skeleton skeleton-text signup-inline-skeleton" /> : "-")}</dd>
            </div>
          </dl>
        ) : null}

        {notice ? <p className="signup-inline-note">{notice}</p> : null}
        {error ? <p className="signup-error">{error}</p> : null}
      </section>
    </main>
  );
}
