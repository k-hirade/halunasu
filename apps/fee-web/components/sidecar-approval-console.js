"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlatformAuth } from "./platform-auth";

export function SidecarApprovalConsole() {
  const auth = usePlatformAuth();
  const [userCode, setUserCode] = useState("");
  const [authorization, setAuthorization] = useState(null);
  const [grants, setGrants] = useState([]);
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const loadGrants = useCallback(async () => {
    try {
      const response = await auth.api("/v1/auth/sidecar-grants");
      setGrants(Array.isArray(response.sidecarGrants) ? response.sidecarGrants : []);
    } catch (error) {
      if (error.status !== 404) {
        setErrorMessage(sidecarErrorMessage(error));
      }
    }
  }, [auth]);

  const lookup = useCallback(async (codeInput) => {
    const normalized = normalizeDisplayCode(codeInput);
    if (normalized.replace("-", "").length !== 8) {
      setErrorMessage("拡張機能に表示された8文字の確認コードを入力してください。");
      return;
    }
    setBusyAction("lookup");
    setErrorMessage("");
    setMessage("");
    try {
      const response = await auth.api("/v1/auth/sidecar-device-authorizations/lookup", {
        method: "POST",
        csrf: true,
        body: { userCode: normalized }
      });
      setUserCode(normalized);
      setAuthorization(response.deviceAuthorization || null);
    } catch (error) {
      setAuthorization(null);
      setErrorMessage(sidecarErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }, [auth]);

  useEffect(() => {
    loadGrants();
    const code = new URLSearchParams(window.location.search).get("code");
    if (code) {
      const normalized = normalizeDisplayCode(code);
      setUserCode(normalized);
      lookup(normalized);
    }
  }, [loadGrants, lookup]);

  async function decide(action) {
    if (!authorization?.deviceAuthId) {
      return;
    }
    setBusyAction(action);
    setErrorMessage("");
    setMessage("");
    try {
      const response = await auth.api(
        `/v1/auth/sidecar-device-authorizations/${encodeURIComponent(authorization.deviceAuthId)}/${action}`,
        {
          method: "POST",
          csrf: true,
          body: { userCode }
        }
      );
      setAuthorization(response.deviceAuthorization || null);
      setMessage(action === "approve" ? "この端末を承認しました。" : "この端末からの接続を拒否しました。");
      await loadGrants();
    } catch (error) {
      setErrorMessage(sidecarErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function revoke(grantRecordId) {
    setBusyAction(`revoke:${grantRecordId}`);
    setErrorMessage("");
    setMessage("");
    try {
      await auth.api(`/v1/auth/sidecar-grants/${encodeURIComponent(grantRecordId)}/revoke`, {
        method: "POST",
        csrf: true,
        body: {}
      });
      setMessage("端末の接続を解除しました。");
      await loadGrants();
    } catch (error) {
      setErrorMessage(sidecarErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  return (
    <main className="sidecar-approval-page">
      <header className="fee-page-head">
        <div>
          <h1>HOMIS連携端末</h1>
          <p>拡張機能に表示されたコードを確認し、この施設への接続を承認します。</p>
        </div>
      </header>

      <section className="sidecar-approval-section" aria-labelledby="sidecar-device-code-heading">
        <div className="sidecar-approval-section-head">
          <div>
            <h2 id="sidecar-device-code-heading">端末を承認</h2>
            <p>心当たりのある端末だけを承認してください。</p>
          </div>
        </div>
        <form
          className="sidecar-code-form"
          onSubmit={(event) => {
            event.preventDefault();
            lookup(userCode);
          }}
        >
          <label htmlFor="sidecar-user-code">確認コード</label>
          <div className="sidecar-code-row">
            <input
              autoComplete="one-time-code"
              id="sidecar-user-code"
              inputMode="text"
              maxLength={9}
              onChange={(event) => setUserCode(normalizeDisplayCode(event.target.value))}
              placeholder="ABCD-EFGH"
              value={userCode}
            />
            <button className="btn btn--secondary" disabled={busyAction !== ""} type="submit">
              {busyAction === "lookup" ? "確認中" : "確認"}
            </button>
          </div>
        </form>

        {authorization ? (
          <div className="sidecar-device-review">
            <dl>
              <div><dt>状態</dt><dd>{authorizationStatusLabel(authorization.status)}</dd></div>
              <div><dt>拡張機能ID</dt><dd>{authorization.extensionId}</dd></div>
              <div><dt>端末ID</dt><dd>{authorization.deviceId}</dd></div>
              <div><dt>コード有効期限</dt><dd>{formatDateTime(authorization.expiresAt)}</dd></div>
            </dl>
            {authorization.status === "pending" ? (
              <div className="sidecar-decision-actions">
                <button
                  className="btn btn--primary"
                  disabled={busyAction !== ""}
                  onClick={() => decide("approve")}
                  type="button"
                >
                  承認
                </button>
                <button
                  className="btn btn--secondary"
                  disabled={busyAction !== ""}
                  onClick={() => decide("deny")}
                  type="button"
                >
                  拒否
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {message ? <p className="sidecar-feedback is-success" role="status">{message}</p> : null}
        {errorMessage ? <p className="sidecar-feedback is-error" role="alert">{errorMessage}</p> : null}
      </section>

      <section className="sidecar-approval-section" aria-labelledby="sidecar-approved-devices-heading">
        <div className="sidecar-approval-section-head">
          <div>
            <h2 id="sidecar-approved-devices-heading">承認済み端末</h2>
            <p>不要になった端末は接続を解除できます。</p>
          </div>
          <span>{grants.filter((grant) => grant.status === "active").length}件</span>
        </div>
        {grants.length ? (
          <div className="sidecar-grant-list">
            {grants.map((grant) => (
              <div className="sidecar-grant-row" key={grant.grantRecordId}>
                <div>
                  <strong>{grant.deviceId}</strong>
                  <small>
                    {authorizationStatusLabel(grant.status)} / 有効期限 {formatDateTime(grant.expiresAt)}
                  </small>
                </div>
                {grant.status === "active" ? (
                  <button
                    className="btn btn--secondary"
                    disabled={busyAction !== ""}
                    onClick={() => revoke(grant.grantRecordId)}
                    type="button"
                  >
                    {busyAction === `revoke:${grant.grantRecordId}` ? "解除中" : "接続を解除"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="sidecar-empty-state">承認済みの端末はありません。</p>
        )}
      </section>
    </main>
  );
}

function normalizeDisplayCode(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "").slice(0, 8);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function authorizationStatusLabel(status) {
  return {
    pending: "承認待ち",
    approved: "承認済み",
    denied: "拒否",
    consumed: "接続済み",
    active: "接続中",
    revoked: "解除済み"
  }[status] || "要確認";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "不明";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function sidecarErrorMessage(error) {
  if (error?.code === "expired_token") {
    return "確認コードの有効期限が切れています。拡張機能で新しいコードを発行してください。";
  }
  if (error?.code === "invalid_device_authorization") {
    return "確認コードが見つかりません。表示内容を確認してください。";
  }
  if (error?.code === "sidecar_facility_required") {
    return "承認前に施設情報を登録してください。";
  }
  if (error?.status === 404) {
    return "この環境ではHOMIS連携が有効になっていません。";
  }
  if (error?.status === 403) {
    return "この操作には組織管理者または診療報酬管理者の権限とMFA認証が必要です。";
  }
  return "処理を完了できませんでした。時間を置いて再度お試しください。";
}
