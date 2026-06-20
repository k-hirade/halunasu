"use client";

import QRCode from "qrcode";
import { startTransition, useEffect, useState } from "react";
import { LoginFormView, MfaFormView } from "@halunasu/web-ui/login-views";
import { BRAND_NAME } from "../lib/brand";
import { loginPlatformBillingSession } from "../lib/billing-api";
import { confirmOperatorMfaEnrollment, loginOperator, verifyOperatorMfa } from "../lib/operator-access";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";

// ログイン画面UIは @halunasu/web-ui/login-views を共有(ステップ3)。
// 認証は charting-gateway のオペレーター認証(operator-access)で別系統のまま。
const LOGIN_PITCH = {
  title: "診療の記録を、AI と一緒に。",
  copy: "診察中の会話をスマホで録音し、診療記録の下書きをその場で作成します。 医師は内容を確認・修正してから、電子カルテへ転記できます。",
  features: [
    "診察に集中したまま、その場で書き起こしを確認",
    "診療記録の下書きを自動作成し、そのまま編集",
    "確定した記録だけを保存し、操作履歴を残す"
  ]
};

export function OperatorLoginPanel({
  onAuthenticated,
  title = "ログイン",
  description = "病院コード、個人ID、ログイン用パスワードでログインしてください。"
}) {
  const [credentials, setCredentials] = useState({ organizationCode: "", loginId: "", password: "" });
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

    QRCode.toDataURL(mfaChallenge.totpUri, { margin: 1, width: 192 })
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

  async function syncPlatformBillingSession(nextCredentials) {
    try {
      await loginPlatformBillingSession(nextCredentials);
    } catch (syncError) {
      console.warn("platform billing session sync failed", syncError);
    }
  }

  function handleLogin(nextCredentials) {
    setCredentials(nextCredentials);
    setError("");
    setIsPending(true);

    startTransition(async () => {
      try {
        const result = await loginOperator(nextCredentials);
        if (result.requiresMfa || result.requiresMfaEnrollment) {
          setMfaChallenge(result);
          setMfaCode("");
          return;
        }
        await syncPlatformBillingSession(nextCredentials);
        onAuthenticated(result.accessToken);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError, "ログインに失敗しました。"));
      } finally {
        setIsPending(false);
      }
    });
  }

  function handleMfaSubmit() {
    if (!mfaChallenge) {
      return;
    }

    setError("");
    setIsPending(true);

    startTransition(async () => {
      try {
        const action = mfaChallenge.requiresMfaEnrollment ? confirmOperatorMfaEnrollment : verifyOperatorMfa;
        const result = await action({ challengeId: mfaChallenge.challengeId, code: mfaCode });
        await syncPlatformBillingSession({ ...credentials, mfaCode });
        onAuthenticated(result.accessToken);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError, "確認に失敗しました。"));
      } finally {
        setIsPending(false);
      }
    });
  }

  if (mfaChallenge) {
    return (
      <MfaFormView
        brandName={BRAND_NAME}
        isEnroll={Boolean(mfaChallenge.requiresMfaEnrollment)}
        qrCodeDataUrl={mfaQrDataUrl}
        secret={mfaChallenge.secret || ""}
        code={mfaCode}
        onCodeChange={setMfaCode}
        onSubmit={handleMfaSubmit}
        onBack={() => {
          setMfaChallenge(null);
          setMfaCode("");
          setMfaQrDataUrl("");
          setCredentials((current) => ({ ...current, password: "" }));
        }}
        errorMessage={error}
        busy={isPending}
      />
    );
  }

  return (
    <LoginFormView
      brandName={BRAND_NAME}
      pitch={LOGIN_PITCH}
      heading={title}
      description={description}
      errorMessage={error}
      busy={isPending}
      onSubmit={handleLogin}
    />
  );
}
