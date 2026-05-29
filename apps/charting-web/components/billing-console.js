"use client";

import { useEffect, useMemo, useState } from "react";

import { createBillingPortalSession, getCurrentBillingStatus } from "../lib/billing-api";
import {
  canManageOrganization,
  canManagePlatform,
  getCurrentOperatorSession,
  useOperatorAccess
} from "../lib/operator-access";
import { OperatorLoginPanel } from "./operator-login-panel";

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

function formatBillingStatus(status) {
  switch (status) {
    case "trialing":
      return "無料期間";
    case "active":
      return "利用中";
    case "past_due":
      return "支払い失敗";
    case "grace_period":
      return "猶予期間";
    case "unpaid":
      return "未払い";
    case "canceled":
      return "解約済み";
    case "pending_checkout":
      return "Checkout待ち";
    case "suspended":
      return "利用停止";
    default:
      return status || "未設定";
  }
}

function formatAccessStatus(status) {
  switch (status) {
    case "pending_setup":
      return "初回設定待ち";
    case "active":
      return "利用可能";
    case "billing_action_required":
      return "支払い対応待ち";
    case "suspended":
      return "停止中";
    case "canceled":
      return "解約済み";
    default:
      return status || "未設定";
  }
}

export function BillingConsole() {
  const { accessToken, isHydrated, setAccessToken } = useOperatorAccess();
  const [operatorSession, setOperatorSession] = useState(null);
  const [billingStatus, setBillingStatus] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLaunchingPortal, setIsLaunchingPortal] = useState(false);

  useEffect(() => {
    if (!accessToken) {
      setOperatorSession(null);
      setBillingStatus(null);
      setError("");
      return;
    }

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError("");

      try {
        const [sessionPayload, billingPayload] = await Promise.all([
          getCurrentOperatorSession(accessToken),
          getCurrentBillingStatus(accessToken)
        ]);

        if (cancelled) {
          return;
        }

        setOperatorSession(sessionPayload?.session || null);
        setBillingStatus(billingPayload);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message || "契約情報の取得に失敗しました。");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const canManageBilling = useMemo(() => (
    canManageOrganization(operatorSession) || canManagePlatform(operatorSession)
  ), [operatorSession]);

  async function handleOpenPortal() {
    setIsLaunchingPortal(true);
    setError("");

    try {
      const payload = await createBillingPortalSession(accessToken);
      window.location.assign(payload.url);
    } catch (portalError) {
      setError(portalError.message || "Customer Portal を開けませんでした。");
      setIsLaunchingPortal(false);
    }
  }

  if (!isHydrated) {
    return (
      <main className="dashboard">
        <div className="dashboard-header">
          <div className="skeleton skeleton-heading" style={{ width: 180 }} />
        </div>
        <div className="card session-card session-card--loading">
          <div className="session-card-info">
            <div className="skeleton skeleton-heading" style={{ width: 180, marginBottom: 0 }} />
            <div className="skeleton" style={{ width: 220, height: 14 }} />
          </div>
        </div>
      </main>
    );
  }

  if (!accessToken) {
    return (
      <OperatorLoginPanel
        onAuthenticated={setAccessToken}
        title="契約情報にログイン"
        description="契約状態の確認と請求管理にはログインが必要です。"
      />
    );
  }

  return (
    <main className="dashboard billing-dashboard">
      <div className="dashboard-header">
        <h1>契約と請求</h1>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      <section className="card billing-overview-card">
        <div className="billing-overview-head">
          <div>
            <span className="label">Billing</span>
            <h2>現在の契約状態</h2>
          </div>
          {canManageBilling ? (
            <button
              className={`btn btn--primary ${isLaunchingPortal ? "btn--loading" : ""}`}
              type="button"
              disabled={isLaunchingPortal || isLoading}
              onClick={handleOpenPortal}
            >
              {isLaunchingPortal ? <span className="btn-spinner" aria-hidden="true" /> : null}
              <span>{isLaunchingPortal ? "起動中..." : "Customer Portal を開く"}</span>
            </button>
          ) : null}
        </div>

        {!canManageBilling ? (
          <div className="alert alert--warning">契約管理者のみ Customer Portal を開けます。</div>
        ) : null}

        {isLoading && !billingStatus ? (
          <div className="billing-status-loading-grid" aria-label="契約情報を読み込み中">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index}>
                <div className="skeleton skeleton-text" style={{ width: "42%", height: 12 }} />
                <div className="skeleton skeleton-heading" style={{ width: index % 2 === 0 ? "64%" : "56%", marginTop: 10, marginBottom: 0 }} />
              </div>
            ))}
          </div>
        ) : (
          <dl className="signup-status-grid billing-status-grid">
            <div>
              <dt>課金状態</dt>
              <dd>{formatBillingStatus(billingStatus?.billing?.status)}</dd>
            </div>
            <div>
              <dt>利用状態</dt>
              <dd>{formatAccessStatus(billingStatus?.access?.status)}</dd>
            </div>
            <div>
              <dt>無料期間終了</dt>
              <dd>{formatDateTime(billingStatus?.billing?.trialEndsAt)}</dd>
            </div>
            <div>
              <dt>契約期間終了</dt>
              <dd>{formatDateTime(billingStatus?.billing?.currentPeriodEnd)}</dd>
            </div>
            <div>
              <dt>猶予期限</dt>
              <dd>{formatDateTime(billingStatus?.billing?.gracePeriodEndsAt)}</dd>
            </div>
            <div>
              <dt>プラン</dt>
              <dd>{billingStatus?.billing?.planCode || "-"}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
