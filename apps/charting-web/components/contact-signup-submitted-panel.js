"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { getContactSignupStatus, resendContactSignupMail } from "../lib/billing-api";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";

export function ContactSignupSubmittedPanel() {
  const searchParams = useSearchParams();
  const signupId = searchParams.get("signup_id") || "";
  const previewUrl = searchParams.get("preview_url") || "";
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isResending, setIsResending] = useState(false);

  const isLoading = !payload && !error;
  const currentStatus = payload?.signup?.status || null;
  const organizationName = payload?.signup?.organizationName || "";
  const adminEmailMasked = payload?.signup?.adminEmailMasked || "";
  const isProcessingAfterVerification = ["verified", "provisioning"].includes(currentStatus || "");
  const showVerificationActions = Boolean(previewUrl) || currentStatus === "submitted";
  const shouldPoll = useMemo(() => {
    return Boolean(signupId) && ["submitted", "verified", "provisioning"].includes(currentStatus || "submitted");
  }, [currentStatus, signupId]);

  useEffect(() => {
    if (!signupId) {
      return;
    }

    let cancelled = false;
    let timer = null;

    const tick = async () => {
      try {
        const nextPayload = await getContactSignupStatus(signupId);
        if (cancelled) {
          return;
        }

        setPayload(nextPayload);
        setError("");

        if (["submitted", "verified", "provisioning"].includes(nextPayload.signup?.status || "")) {
          timer = window.setTimeout(tick, 5000);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(toUserFacingErrorMessage(loadError, "申込状態の取得に失敗しました。"));
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [signupId]);

  async function handleResend() {
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

  return (
    <main className="signup-status-shell">
      <section className="signup-panel signup-panel--single signup-status-panel">
        <div className="signup-heading">
          <h1>{isProcessingAfterVerification ? "利用開始の準備を進めています" : "確認メールを送信しました"}</h1>
          <p className="signup-lead">
            {isProcessingAfterVerification
              ? "メール確認を受け付けました。病院アカウントと初回設定の準備を進めています。"
              : "案内メールをご確認ください。メール内のリンクを開くと、病院アカウント作成と初回設定へ進みます。"}
          </p>
        </div>

        <div className="signup-status-primary-card signup-status-primary-card--waiting">
          {isLoading || isProcessingAfterVerification ? (
            <div className="signup-status-loading-head">
              <span className="btn-spinner" aria-hidden="true" />
              <span>{isProcessingAfterVerification ? "病院アカウントを準備しています" : "確認メールを準備しています"}</span>
            </div>
          ) : (
            <>
              <p className="signup-status-primary-title">次に、確認メールを開いてください</p>
              <p className="signup-status-primary-copy">メール内の確認リンクを開くと、病院アカウントの準備を開始します。</p>
            </>
          )}
          {showVerificationActions ? (
            <div className="signup-status-actions contact-signup-actions">
              {previewUrl ? <a className="signup-submit signup-submit-link" href={previewUrl}>確認リンクを開く</a> : null}
              {currentStatus === "submitted" ? (
                <button className={`btn btn--secondary ${isResending ? "btn--loading" : ""}`} type="button" onClick={handleResend} disabled={isResending}>
                  {isResending ? <span className="btn-spinner" aria-hidden="true" /> : null}
                  <span>{isResending ? "メールを再送中..." : "確認メールを再送"}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {previewUrl ? <p className="signup-inline-note">この確認リンク表示は STG / 開発環境のみです。</p> : null}

        {(organizationName || adminEmailMasked || isLoading) ? (
          <dl className="signup-status-meta">
            <div>
              <dt>医療機関名</dt>
              <dd>{organizationName || (isLoading ? <span className="skeleton skeleton-text signup-inline-skeleton" /> : "-")}</dd>
            </div>
            <div>
              <dt>案内先メールアドレス</dt>
              <dd>{adminEmailMasked || (isLoading ? <span className="skeleton skeleton-text signup-inline-skeleton" /> : "-")}</dd>
            </div>
          </dl>
        ) : null}

        {notice ? <p className="signup-inline-note">{notice}</p> : null}
        {error ? <p className="signup-error">{error}</p> : null}
      </section>
    </main>
  );
}
