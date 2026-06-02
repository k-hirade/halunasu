"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getGatewayBaseUrl } from "../lib/runtime-config";
import { buildBillingBannerCopy } from "../lib/billing-display";
import { canCreateClinicalSession, canManageOrganization, canManagePlatform, fetchWithOperatorAuth, getCurrentOperatorSession, getOperatorAccessRestrictionMessage, useOperatorAccess } from "../lib/operator-access";
import { storePairing } from "../lib/pairing-session";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";
import { Icon } from "./icon";
import { OperatorLoginPanel } from "./operator-login-panel";

const SESSION_STATUS_LABELS = {
  ready: "準備中",
  paired: "スマホ接続済み",
  recording: "録音中",
  degraded_recording: "接続不安定",
  stopped: "録音終了",
  finalizing: "SOAP下書き作成中",
  soap_ready: "医師確認待ち",
  approved: "確定済み",
  failed: "要確認"
};

const SESSION_STATUS_FILTERS = [
  { value: "all", label: "すべて", statuses: [] },
  { value: "active", label: "進行中", statuses: ["ready", "paired", "recording", "degraded_recording", "stopped", "finalizing"] },
  { value: "review", label: "確認待ち", statuses: ["soap_ready"] },
  { value: "approved", label: "確定済み", statuses: ["approved"] },
  { value: "failed", label: "要確認", statuses: ["failed", "degraded_recording"] }
];

function formatTokyoDate(value, options = {}) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    ...options
  }).format(date);
}

function getTokyoDayKey(value) {
  return formatTokyoDate(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatSessionGroupLabel(dayKey) {
  const todayKey = getTokyoDayKey(new Date().toISOString());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayKey = getTokyoDayKey(yesterdayDate.toISOString());

  if (dayKey === todayKey) {
    return "今日";
  }

  if (dayKey === yesterdayKey) {
    return "昨日";
  }

  return dayKey;
}

function groupSessionsByDay(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const dayKey = getTokyoDayKey(session.createdAt) || "日付未設定";

    if (!groups.has(dayKey)) {
      groups.set(dayKey, []);
    }

    groups.get(dayKey).push(session);
  }

  return Array.from(groups.entries()).map(([dayKey, items]) => ({
    dayKey,
    label: formatSessionGroupLabel(dayKey),
    sessions: items
  }));
}

function buildSessionHistoryPageItems(page, totalPages) {
  if (totalPages <= 1) {
    return [1];
  }

  const pages = new Set([1, totalPages, page - 1, page, page + 1]);

  if (page <= 3) {
    pages.add(2);
    pages.add(3);
  }

  if (page >= totalPages - 2) {
    pages.add(totalPages - 1);
    pages.add(totalPages - 2);
  }

  const ordered = Array.from(pages)
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right);
  const items = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const previous = ordered[index - 1];

    if (index > 0 && current - previous > 1) {
      items.push(`ellipsis-${previous}-${current}`);
    }

    items.push(current);
  }

  return items;
}

export function SessionLauncher() {
  const router = useRouter();
  const { accessToken, isHydrated, setAccessToken, clearAccess } = useOperatorAccess();
  const sessionSearchInputRef = useRef(null);
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [createPhase, setCreatePhase] = useState("idle");
  const [isProcessingOverlayDismissed, setIsProcessingOverlayDismissed] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionListError, setSessionListError] = useState("");
  const [deleteTargetSession, setDeleteTargetSession] = useState(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [sessionSearchDraft, setSessionSearchDraft] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionStatusFilter, setSessionStatusFilter] = useState("all");
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPageSize] = useState(20);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [sessionTotalPages, setSessionTotalPages] = useState(0);
  const [sessionReloadToken, setSessionReloadToken] = useState(0);
  const [operatorSession, setOperatorSession] = useState(null);

  useEffect(() => {
    const nextSearch = sessionSearchDraft.trim();
    const timeoutId = window.setTimeout(() => {
      setSessionSearch((current) => (current === nextSearch ? current : nextSearch));
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [sessionSearchDraft]);

  useEffect(() => {
    setSessionPage(1);
  }, [sessionSearch, sessionStatusFilter]);

  const loadSessions = useCallback(async ({ requestedPage = sessionPage } = {}) => {
    if (!accessToken) {
      return;
    }

    setIsLoadingSessions(true);
    setSessionListError("");

    try {
      const currentOperator = await getCurrentOperatorSession(accessToken).catch(() => null);
      if (currentOperator?.authenticated) {
        setOperatorSession(currentOperator.session || null);
      }

      const params = new URLSearchParams({
        page: String(requestedPage),
        pageSize: String(sessionPageSize),
        status: sessionStatusFilter
      });

      if (sessionSearch) {
        params.set("q", sessionSearch);
      }

      const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions?${params.toString()}`, {
        cache: "no-store",
      }, accessToken);

      if (!response.ok) {
        if (response.status === 401) {
          clearAccess();
          return;
        }

        throw new Error("診療履歴を取得できませんでした。");
      }

      const data = await response.json();
      const nextPage = Math.max(1, Number(data.page || requestedPage));

      setSessions(data.sessions || []);
      setSessionTotalCount(Number(data.totalCount || 0));
      setSessionTotalPages(Number(data.totalPages || 0));
      if (nextPage !== sessionPage) {
        setSessionPage(nextPage);
      }
    } catch (nextError) {
      setSessionListError(toUserFacingErrorMessage(nextError, "診療履歴を取得できませんでした。"));
    } finally {
      setIsLoadingSessions(false);
    }
  }, [accessToken, clearAccess, sessionPage, sessionPageSize, sessionSearch, sessionStatusFilter]);

  useEffect(() => {
    if (!accessToken) {
      setSessions([]);
      setSessionListError("");
      setSessionSearchDraft("");
      setSessionSearch("");
      setSessionPage(1);
      setSessionTotalCount(0);
      setSessionTotalPages(0);
      setOperatorSession(null);
      return;
    }

    let isCancelled = false;

    loadSessions({ requestedPage: sessionPage }).catch(() => null);

    return () => {
      isCancelled = true;
    };
  }, [accessToken, sessionPage, sessionSearch, sessionStatusFilter, sessionReloadToken, loadSessions]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (!isTyping && event.key === "/") {
        event.preventDefault();
        sessionSearchInputRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function createSession() {
    setError("");
    setIsProcessingOverlayDismissed(false);
    setCreatePhase("creating");
    setIsPending(true);

    startTransition(async () => {
      let didNavigate = false;

      try {
        const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions`, {
          method: "POST",
          body: JSON.stringify({
            title: new Date().toLocaleString("ja-JP")
          })
        }, accessToken);

        if (!response.ok) {
          if (response.status === 401) {
            clearAccess();
          }

          const body = await response.json().catch(() => ({ error: "" }));
          throw new Error(toUserFacingErrorMessage(body.error || "", "新しい診療記録を開けませんでした。通信状態を確認し、もう一度お試しください。"));
        }

        const data = await response.json();
        storePairing(data.sessionId, {
          pairingId: data.pairingId,
          token: data.pairingToken || ""
        });
        setCreatePhase("redirecting");
        didNavigate = true;
        router.push(`/sessions/${data.sessionId}`);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError, "新しい診療記録を開けませんでした。通信状態を確認し、もう一度お試しください。"));
        setCreatePhase("idle");
      } finally {
        if (!didNavigate) {
          setIsPending(false);
        }
      }
    });
  }

  async function hideSessionFromHome(sessionId) {
    setIsDeletingSession(true);
    setSessionListError("");

    try {
      const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions/${sessionId}`, {
        method: "DELETE",
      }, accessToken);

      if (!response.ok) {
        if (response.status === 401) {
          clearAccess();
          return;
        }

        const body = await response.json().catch(() => ({ error: "診療を一覧から外せませんでした。もう一度お試しください。" }));
        throw new Error(toUserFacingErrorMessage(body.error || "", "診療を一覧から外せませんでした。もう一度お試しください。"));
      }

      setDeleteTargetSession(null);
      if (sessions.length === 1 && sessionPage > 1) {
        setSessionPage((current) => Math.max(1, current - 1));
      } else {
        setSessionReloadToken((current) => current + 1);
      }
    } catch (nextError) {
      setSessionListError(toUserFacingErrorMessage(nextError, "診療を一覧から外せませんでした。もう一度お試しください。"));
    } finally {
      setIsDeletingSession(false);
    }
  }

  const groupedSessions = groupSessionsByDay(sessions);
  const sessionHistoryPageItems = buildSessionHistoryPageItems(sessionPage, sessionTotalPages);
  const sessionHistoryRangeStart = sessionTotalCount > 0 ? (sessionPage - 1) * sessionPageSize + 1 : 0;
  const sessionHistoryRangeEnd = sessionTotalCount > 0 ? sessionHistoryRangeStart + sessions.length - 1 : 0;
  const isFilteredSessionHistory = Boolean(sessionSearch) || sessionStatusFilter !== "all";
  const canCreateSession = canCreateClinicalSession(operatorSession);
  const canManageBilling = canManageOrganization(operatorSession) || canManagePlatform(operatorSession);
  const accessRestrictionMessage = getOperatorAccessRestrictionMessage(operatorSession);
  const billingBanner = buildBillingBannerCopy({
    billing: operatorSession?.organization?.billing || null,
    access: operatorSession?.organization?.access || null,
    productEntitlements: operatorSession?.organization?.productEntitlements || null,
    productId: "charting",
    onlyShowTrialInReminderWindow: true
  });
  const processingCopy =
    createPhase === "redirecting"
      ? {
          title: "診療記録を開いています",
          body: "診療記録を開いています。録音方法は次の画面で選べます。"
        }
      : {
          title: "新しい診療記録を準備しています",
          body: "診療記録を準備しています。画面を閉じずにお待ちください。"
        };

  if (!isHydrated) {
    return (
      <main className="dashboard">
        <div className="dashboard-header">
          <div className="skeleton skeleton-heading" style={{ width: 180 }} />
          <div className="skeleton" style={{ width: 160, height: 38, borderRadius: 8 }} />
        </div>
        <div className="session-list">
          <div className="skeleton skeleton-block" />
          <div className="skeleton skeleton-block" />
        </div>
      </main>
    );
  }

  if (!accessToken) {
    return (
      <OperatorLoginPanel
        onAuthenticated={setAccessToken}
        title="診療画面にログイン"
        description="診療画面の作成と閲覧にはログイン用パスワードが必要です。"
      />
    );
  }

  return (
    <main className="dashboard">
      <div className="dashboard-header">
        <h1>診療一覧</h1>
      </div>

      {accessRestrictionMessage ? (
        <div className="alert alert--warning">{accessRestrictionMessage}</div>
      ) : null}

      {billingBanner ? (
        <div className={`alert ${billingBanner.tone === "success" ? "alert--success" : "alert--warning"} session-billing-banner`}>
          <div className="session-billing-banner-copy">
            <strong>{billingBanner.title}</strong>
            <span>{billingBanner.body}</span>
          </div>
          {canManageBilling ? (
            <button className="btn btn--ghost" type="button" onClick={() => router.push("/admin?section=account")}>
              支払い設定を確認
            </button>
          ) : null}
        </div>
      ) : null}

      {canCreateSession ? (
        <section className="card quick-start-panel">
          <div className="quick-start-copy">
            <span className="label">新しい診療</span>
            <h2>新しい診療記録を作成します</h2>
            <p>次の画面で患者名や症状を入力できます。新しい診療記録を開いてください。</p>
          </div>
          <div className="quick-start-actions">
            <button
              className={`btn btn--primary btn--lg ${isPending ? "btn--loading" : ""}`}
              disabled={isPending}
              onClick={createSession}
              type="button"
            >
              <span>診療記録を作成</span>
              {isPending ? <span className="btn-spinner" aria-hidden="true" /> : null}
            </button>
          </div>

          {error ? <div className="inline-error">{error}</div> : null}
        </section>
      ) : null}

      <section className="session-history">
        <div className="session-history-head">
          <div>
            <span className="label">履歴</span>
            <h2>過去の診療</h2>
          </div>
          <span className="session-history-count">
            {isFilteredSessionHistory ? `検索結果 ${sessionTotalCount} 件` : `${sessionTotalCount} 件`}
          </span>
        </div>

        <div className="session-history-toolbar" role="search">
          <label className="session-history-search">
            <span>検索</span>
            <input
              ref={sessionSearchInputRef}
              value={sessionSearchDraft}
              onChange={(event) => setSessionSearchDraft(event.target.value)}
              placeholder="患者名・症状で検索"
              type="search"
            />
          </label>
          <label className="session-history-filter">
            <span>状態</span>
            <select value={sessionStatusFilter} onChange={(event) => setSessionStatusFilter(event.target.value)}>
              {SESSION_STATUS_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
          </label>
        </div>

        {sessionListError ? <div className="inline-error">{sessionListError}</div> : null}

        {isLoadingSessions ? (
          <div className="session-list">
            <div className="card session-card session-card--loading">
              <div className="session-card-info">
                <div className="skeleton skeleton-heading" style={{ width: 220, marginBottom: 0 }} />
                <div className="skeleton" style={{ width: 180, height: 14 }} />
              </div>
              <div className="skeleton" style={{ width: 86, height: 30, borderRadius: 999 }} />
            </div>
            <div className="card session-card session-card--loading">
              <div className="session-card-info">
                <div className="skeleton skeleton-heading" style={{ width: 180, marginBottom: 0 }} />
                <div className="skeleton" style={{ width: 220, height: 14 }} />
              </div>
              <div className="skeleton" style={{ width: 92, height: 30, borderRadius: 999 }} />
            </div>
          </div>
        ) : groupedSessions.length > 0 ? (
          <div className="session-history-results">
            <div className="session-history-page-summary">
              {sessionHistoryRangeStart > 0
                ? `${sessionHistoryRangeStart}-${sessionHistoryRangeEnd} 件を表示`
                : "0 件"}
            </div>
            <div className="session-history-groups">
              {groupedSessions.map((group) => (
                <section className="session-history-group" key={group.dayKey}>
                  <div className="session-history-date">{group.label}</div>
                  <div className="session-list">
                    {group.sessions.map((session) => (
                      <div className="card session-card" key={session.sessionId}>
                        <a className="session-card-link" href={`/sessions/${session.sessionId}`}>
                          <div className="session-card-info">
                            <strong>{session.patientDisplayName || session.title || "患者名なし"}</strong>
                            <span>{session.visitReason || "症状メモなし"}</span>
                            <span>
                              作成 {formatTokyoDate(session.createdAt, { hour: "2-digit", minute: "2-digit" })}
                              {session.approvedAt
                                ? ` ・ 確定 ${formatTokyoDate(session.approvedAt, { hour: "2-digit", minute: "2-digit" })}`
                                : session.finalizedAt
                                  ? ` ・ SOAP下書き ${formatTokyoDate(session.finalizedAt, { hour: "2-digit", minute: "2-digit" })}`
                                  : ""}
                            </span>
                          </div>
                          <span className={`badge badge--${session.status}`}>{SESSION_STATUS_LABELS[session.status] || session.status}</span>
                        </a>
                        <button
                          className="btn btn--ghost session-delete-button"
                          aria-label={`${session.patientDisplayName || session.title || "この診療"}を一覧から外す`}
                          onClick={() => setDeleteTargetSession(session)}
                          type="button"
                        >
                          一覧から外す
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            {sessionTotalPages > 1 ? (
              <nav className="session-history-pagination" aria-label="診療履歴ページ移動">
                <button
                  className="btn btn--ghost session-history-page-button"
                  disabled={sessionPage <= 1 || isLoadingSessions}
                  onClick={() => setSessionPage((current) => Math.max(1, current - 1))}
                  type="button"
                >
                  前へ
                </button>
                <div className="session-history-page-list">
                  {sessionHistoryPageItems.map((item) => (
                    typeof item === "number" ? (
                      <button
                        key={item}
                        className={`session-history-page-chip${item === sessionPage ? " is-active" : ""}`}
                        aria-current={item === sessionPage ? "page" : undefined}
                        disabled={isLoadingSessions}
                        onClick={() => setSessionPage(item)}
                        type="button"
                      >
                        {item}
                      </button>
                    ) : (
                      <span className="session-history-page-ellipsis" key={item} aria-hidden="true">…</span>
                    )
                  ))}
                </div>
                <button
                  className="btn btn--ghost session-history-page-button"
                  disabled={sessionPage >= sessionTotalPages || isLoadingSessions}
                  onClick={() => setSessionPage((current) => Math.min(sessionTotalPages, current + 1))}
                  type="button"
                >
                  次へ
                </button>
              </nav>
            ) : null}
          </div>
        ) : (
          <div className="session-list">
            <div className="session-list-empty">
              {isFilteredSessionHistory
                ? "条件に一致する診療履歴はありません。検索条件を変更してください。"
                : canCreateSession
                  ? "まだ診療履歴はありません。上のボタンから新しい診療記録を作成できます。"
                  : "表示できる診療履歴はありません。"}
            </div>
          </div>
        )}
      </section>

      {createPhase !== "idle" && !isProcessingOverlayDismissed ? (
        <div className="processing-overlay" role="dialog" aria-labelledby="session-create-title" aria-describedby="session-create-description">
          <div className="processing-card">
            <button className="processing-close-button" type="button" onClick={() => setIsProcessingOverlayDismissed(true)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <div className="spinner" aria-hidden="true" />
            <div className="processing-card-copy">
              <h2 id="session-create-title">{processingCopy.title}</h2>
              <p id="session-create-description">{processingCopy.body}</p>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTargetSession ? (
        <div className="confirm-overlay" onClick={(event) => { if (event.target === event.currentTarget) setDeleteTargetSession(null); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="session-delete-title">
            <button className="confirm-close-button" type="button" onClick={() => setDeleteTargetSession(null)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="session-delete-title">この診療を一覧から非表示にしますか？</h3>
            <p>ホーム画面の一覧から非表示にします。診療記録そのものは残ります。</p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" disabled={isDeletingSession} onClick={() => setDeleteTargetSession(null)} type="button">
                キャンセル
              </button>
              <button
                className={`btn btn--danger ${isDeletingSession ? "btn--loading" : ""}`}
                disabled={isDeletingSession}
                onClick={() => hideSessionFromHome(deleteTargetSession.sessionId)}
                type="button"
              >
                一覧から外す
                {isDeletingSession ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
