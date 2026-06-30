"use client";

import { clinicalAutoCalculationOptionKeys } from "@halunasu/fee-contracts";
import { toUserFacingErrorMessage } from "@halunasu/web-ui/user-facing-error";
import * as SelectPrimitive from "@radix-ui/react-select";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

const FEE_SESSION_PAGE_SIZE = 20;
const PATIENT_SEARCH_LIMIT = 30;
const CALCULATION_POLL_DELAYS_MS = [2500, 3500, 5000, 8000, 12000];
const CALCULATION_POLL_TIMEOUT_MS = 90000;
const EMPTY_SELECT_VALUE = "__fee_empty__";
const ORDER_TYPE_OPTIONS = [
  ["procedure", "処置・手技"],
  ["lab", "検査"],
  ["drug", "薬剤"],
  ["injection", "注射"],
  ["material", "特定器材"],
  ["imaging", "画像"],
  ["treatment", "医学管理等"],
  ["other", "その他"]
];
const MASTER_TYPES = [
  ["procedure", "診療行為"],
  ["drug", "薬剤"],
  ["material", "特定器材"],
  ["comment", "コメント"],
  ["all", "すべて"]
];
// サマリ兼フィルタのチップ。上部の重複した数値カードを廃止し、これ1本に集約する。
const MONTHLY_PRIMARY_FILTERS = [
  ["all", "すべて"],
  ["ready", "提出候補"],
  ["blocked", "要対応"],
  ["uncalculated", "未算定"]
];
const MONTHLY_WORK_STATUS_OPTIONS = [
  ["not_started", "未着手"],
  ["diagnosis_requested", "病名依頼中"],
  ["doctor_confirming", "医師確認中"],
  ["collected", "回収済み"],
  ["ready_for_claim", "提出可"],
  ["excluded", "請求対象外"]
];
const AUTO_PLACEHOLDER_ORDER_NAMES = new Set([
  "処置・手技",
  "薬剤処方",
  "特定器材・材料",
  "画像診断",
  "医学管理等",
  "検体検査",
  "注射",
  "カルテ記載内容から算定候補を確認"
]);
const CLINICAL_AUTO_CALCULATION_OPTION_KEYS = new Set(clinicalAutoCalculationOptionKeys);

function isMasterSearchAvailable(masterStatus) {
  if (!masterStatus || typeof masterStatus !== "object") {
    return false;
  }
  if (typeof masterStatus.available === "boolean") {
    return masterStatus.available;
  }
  if (masterStatus.provider === "custom") {
    return true;
  }
  if (masterStatus.masterDbConfigured === false) {
    return false;
  }
  return masterStatus.masterDbPathExists === true;
}

export function FeeWorkspace({ mode = "list", sessionId = "" }) {
  if (mode === "detail") {
    return <FeeSessionDetailView sessionId={sessionId} />;
  }
  if (mode === "monthly") {
    return <MonthlyClaimDashboard />;
  }

  return <FeeSessionListView />;
}

function MonthlyClaimDashboard() {
  const feeApi = useFeeApi();
  const [claimMonth, setClaimMonth] = useState(defaultClaimMonth());
  const [filter, setFilter] = useState("all");
  const [summary, setSummary] = useState(null);
  const [bulkPlan, setBulkPlan] = useState(null);
  const [bulkJob, setBulkJob] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [drawerPatientKey, setDrawerPatientKey] = useState("");
  const [savingSessionId, setSavingSessionId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const params = new URLSearchParams();
      if (claimMonth) {
        params.set("claimMonth", claimMonth);
      }
      const [summaryResponse, bulkPlanResponse] = await Promise.all([
        feeApi(`/v1/fee/monthly-summary?${params.toString()}`),
        feeApi(`/v1/fee/monthly-bulk-candidates?${params.toString()}`)
      ]);
      setSummary(summaryResponse);
      setBulkPlan(bulkPlanResponse);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "月次レセ点検を読み込めませんでした。"));
    } finally {
      setLoading(false);
    }
  }, [claimMonth, feeApi]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const patients = summary?.patients || [];
  const filteredPatients = patients.filter((patient) => monthlyPatientMatchesFilter(patient, filter));
  const blockedPatientCount = patients.filter((patient) => patient.blocked).length;
  const readyPatientCount = patients.filter((patient) => patient.readyForClaim).length;
  const uncalculatedPatientCount = patients.filter((patient) => Number(patient.uncalculatedCount || 0) > 0).length;
  const filterCounts = {
    all: patients.length,
    ready: readyPatientCount,
    blocked: blockedPatientCount,
    uncalculated: uncalculatedPatientCount
  };
  const bulkTargetCount = Number(bulkPlan?.targetCount || 0);
  const drawerPatient = patients.find((patient) => monthlyPatientKey(patient) === drawerPatientKey) || null;

  async function updateMonthlyWork(session, patch) {
    if (!session?.feeSessionId) {
      return;
    }
    setSavingSessionId(session.feeSessionId);
    setErrorMessage("");
    try {
      const currentWork = session.monthlyClaimWork || {};
      const nextWork = {
        ...currentWork,
        ...(typeof patch === "string" ? { status: patch } : patch)
      };
      await feeApi(`/v1/fee/sessions/${encodeURIComponent(session.feeSessionId)}`, {
        method: "PATCH",
        csrf: true,
        body: {
          monthlyClaimWork: nextWork
        }
      });
      await loadSummary();
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "作業ステータスを保存できませんでした。"));
    } finally {
      setSavingSessionId("");
    }
  }

  async function applyMonthlyDiagnoses(session, collectedResult, workPatch = {}) {
    if (!session?.feeSessionId) {
      return;
    }
    const diagnoses = parseDiagnoses(collectedResult);
    if (!diagnoses.length) {
      setErrorMessage("反映する病名がありません。回収結果に病名を1行ずつ入力してください。");
      return;
    }
    setSavingSessionId(session.feeSessionId);
    setErrorMessage("");
    try {
      await feeApi(`/v1/fee/sessions/${encodeURIComponent(session.feeSessionId)}`, {
        method: "PATCH",
        csrf: true,
        body: {
          diagnoses,
          diagnosesSource: "manual",
          monthlyClaimWork: {
            ...(session.monthlyClaimWork || {}),
            ...workPatch,
            status: "collected",
            collectedResult,
            appliedDiagnosisNames: diagnoses.map((diagnosis) => diagnosis.name).filter(Boolean)
          }
        }
      });
      await loadSummary();
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "回収した病名を反映できませんでした。"));
    } finally {
      setSavingSessionId("");
    }
  }

  async function updateMonthlyReceiptAnnotations(session, receiptAnnotations) {
    if (!session?.feeSessionId) {
      return;
    }
    setSavingSessionId(session.feeSessionId);
    setErrorMessage("");
    try {
      await feeApi(`/v1/fee/sessions/${encodeURIComponent(session.feeSessionId)}`, {
        method: "PATCH",
        csrf: true,
        body: {
          receiptAnnotations
        }
      });
      await loadSummary();
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "コメント・詳記を保存できませんでした。"));
    } finally {
      setSavingSessionId("");
    }
  }

  async function createMonthlyBulkJob() {
    setBulkBusy(true);
    setErrorMessage("");
    try {
      const response = await feeApi("/v1/fee/monthly-bulk-jobs", {
        method: "POST",
        csrf: true,
        body: {
          claimMonth,
          autoRun: true
        }
      });
      setBulkJob(response.monthlyBulkJob || null);
      await loadSummary();
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "一括候補化ジョブを作成できませんでした。"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function updateMonthlyBulkJob(action) {
    if (!bulkJob?.monthlyBulkJobId) {
      return;
    }
    setBulkBusy(true);
    setErrorMessage("");
    try {
      const response = await feeApi(`/v1/fee/monthly-bulk-jobs/${encodeURIComponent(bulkJob.monthlyBulkJobId)}`, {
        method: "PATCH",
        csrf: true,
        body: { action }
      });
      setBulkJob(response.monthlyBulkJob || null);
      await loadSummary();
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "一括候補化ジョブを更新できませんでした。"));
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <main className="dashboard fee-monthly-dashboard">
      <div className="dashboard-header fee-monthly-header">
        <div>
          <span className="label">月次レセ点検</span>
          <h1>請求月ごとの確認状況</h1>
        </div>
        <div className="fee-monthly-header-actions">
          <label className="fee-monthly-month-field">
            <span>請求月</span>
            <input type="month" value={claimMonth} onChange={(event) => setClaimMonth(event.target.value)} />
          </label>
          <a className="btn btn--ghost" href="/sessions">算定一覧</a>
        </div>
      </div>

      {errorMessage ? <div className="inline-error" role="status">{errorMessage}</div> : null}

      <section className="card fee-monthly-worklist">
        <div className="fee-monthly-worklist-head">
          <div>
            <h2>患者別点検リスト</h2>
            <p>要対応の患者から確認できます。合計 {Number(summary?.totalPoints || 0).toLocaleString()}点 / {Number(summary?.sessionCount || 0).toLocaleString()}受診分。</p>
          </div>
          {bulkTargetCount || bulkJob ? (
            <button className="btn btn--ghost btn--sm" onClick={() => setBulkOpen((current) => !current)} type="button">
              {bulkOpen ? "一括候補化を閉じる" : `未算定をまとめて候補化（${bulkTargetCount.toLocaleString()}件）`}
            </button>
          ) : null}
        </div>

        <div className="fee-monthly-filterbar" role="group" aria-label="月次点検フィルタ">
          {MONTHLY_PRIMARY_FILTERS.map(([value, label]) => (
            <button
              className={`fee-filter-chip ${filter === value ? "is-active" : ""}`}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {label}<span>{Number(filterCounts[value] || 0).toLocaleString()}</span>
            </button>
          ))}
        </div>

        {bulkOpen ? (
          <MonthlyBulkPanel
            busy={bulkBusy}
            job={bulkJob}
            onCancel={() => updateMonthlyBulkJob("cancel")}
            onConfirmSafe={() => updateMonthlyBulkJob("confirm_safe")}
            onCreate={createMonthlyBulkJob}
            onRetryFailed={() => updateMonthlyBulkJob("retry_failed")}
            plan={bulkPlan}
          />
        ) : null}

        {loading ? (
          <MonthlySkeleton />
        ) : filteredPatients.length ? (
          <div className="fee-monthly-table-wrap">
            <table className="fee-monthly-table">
              <thead>
                <tr>
                  <th>患者</th>
                  <th>受診</th>
                  <th>点数</th>
                  <th>状態</th>
                  <th>次にやること</th>
                </tr>
              </thead>
              <tbody>
                {filteredPatients.map((patient) => (
                  <MonthlyPatientRow
                    key={monthlyPatientKey(patient)}
                    onOpen={() => setDrawerPatientKey(monthlyPatientKey(patient))}
                    patient={patient}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="session-list-empty">この条件に一致する算定記録はありません。</div>
        )}
      </section>

      <MonthlyPatientDrawer
        onApplyDiagnoses={applyMonthlyDiagnoses}
        onClose={() => setDrawerPatientKey("")}
        onUpdateReceiptAnnotations={updateMonthlyReceiptAnnotations}
        onUpdateWork={updateMonthlyWork}
        patient={drawerPatient}
        savingSessionId={savingSessionId}
      />
    </main>
  );
}

function MonthlyBulkPanel({ busy, job, onCancel, onConfirmSafe, onCreate, onRetryFailed, plan }) {
  const progress = job?.progress || {};
  const targetCount = Number(plan?.targetCount || 0);
  const failedCount = Number(progress.failedCount || 0);
  const queuedCount = Number(progress.queuedCount || 0);
  const skippedCount = Number(progress.skippedCount || 0);
  return (
    <section className="card fee-monthly-bulk-panel" aria-label="一括候補化">
      <div className="fee-monthly-bulk-head">
        <div>
          <span className="label">一括候補化</span>
          <h2>未算定・再計算対象 {targetCount.toLocaleString()}件</h2>
          <p>請求月内の対象を抽出し、既存の単票算定ジョブへ順に投入します。</p>
        </div>
        <button className="btn btn--primary btn--sm" disabled={busy || targetCount === 0} onClick={onCreate} type="button">
          候補化ジョブ作成
        </button>
      </div>
      {job ? (
        <>
          <dl className="fee-monthly-bulk-metrics">
            <div>
              <dt>投入済み</dt>
              <dd>{queuedCount.toLocaleString()}件</dd>
            </div>
            <div>
              <dt>失敗</dt>
              <dd>{failedCount.toLocaleString()}件</dd>
            </div>
            <div>
              <dt>除外</dt>
              <dd>{skippedCount.toLocaleString()}件</dd>
            </div>
          </dl>
          <div className="fee-monthly-bulk-status">
            <div>
              <strong>{monthlyBulkStatusLabel(job.status)}</strong>
              <small>{Number(progress.percent || 0).toLocaleString()}% / {Number(progress.processedCount || 0).toLocaleString()}件処理</small>
            </div>
            <div className="fee-monthly-bulk-actions">
              <button className="btn btn--ghost btn--sm" disabled={busy || failedCount === 0} onClick={onRetryFailed} type="button">
                失敗のみ再実行
              </button>
              <button className="btn btn--ghost btn--sm" disabled={busy || job.status === "canceled"} onClick={onCancel} type="button">
                キャンセル
              </button>
              <button className="btn btn--primary btn--sm" disabled={busy} onClick={onConfirmSafe} type="button">
                リスクなしを提出候補へ
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="fee-monthly-bulk-empty">未算定または再計算が必要な受診分だけを対象にします。実行可能 {Number(plan?.runnableCount || 0).toLocaleString()}件。</p>
      )}
      {Array.isArray(job?.items) && job.items.length ? (
        <div className="fee-monthly-bulk-items">
          {job.items.slice(0, 6).map((item) => (
            <div key={item.itemId || item.feeSessionId}>
              <span className={badgeClass(item.status === "failed" ? "needs_review" : item.status === "queued" ? "ready" : "partial")}>{monthlyBulkItemStatusLabel(item.status)}</span>
              <strong>{item.patientName || item.patientId || "患者未設定"}</strong>
              <small>{item.serviceDate || "受診日未設定"} / {item.reasonLabel || item.reason}{item.errorMessage ? ` / ${item.errorMessage}` : ""}</small>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// 確認列に詰め込んでいた最大5種を、優先度順の先頭1件＋「他N」に圧縮する。
function monthlyPatientPrimaryTask(patient = {}) {
  const tasks = [
    Number(patient.missingDiagnosisCount || 0) ? `病名不足 ${Number(patient.missingDiagnosisCount).toLocaleString()}件` : "",
    Number(patient.uncalculatedCount || 0) ? `未算定 ${Number(patient.uncalculatedCount).toLocaleString()}件` : "",
    Number(patient.needsReviewCount || 0) ? `要確認 ${Number(patient.needsReviewCount).toLocaleString()}件` : "",
    Number(patient.pendingReceiptAnnotationCount || 0) ? `詳記未対応 ${Number(patient.pendingReceiptAnnotationCount).toLocaleString()}件` : "",
    Number(patient.symptomDetailCandidateCount || 0) ? `詳記候補 ${Number(patient.symptomDetailCandidateCount).toLocaleString()}件` : ""
  ].filter(Boolean);
  return { primary: tasks[0] || "", restCount: Math.max(0, tasks.length - 1) };
}

function MonthlyPatientRow({ onOpen, patient }) {
  const status = patient.readyForClaim ? "ready" : patient.blocked ? "needs_review" : "partial";
  const { primary, restCount } = monthlyPatientPrimaryTask(patient);

  return (
    <tr className="fee-monthly-row" onClick={onOpen}>
      <td>
        <button className="fee-monthly-patient-button" onClick={onOpen} type="button">
          <strong>{patient.patientName || patient.patientId || "患者未設定"}</strong>
          <small>{patient.patientId || "患者ID未設定"}</small>
        </button>
      </td>
      <td>{Number(patient.sessionCount || 0).toLocaleString()}件</td>
      <td>{Number(patient.totalPoints || 0).toLocaleString()}点</td>
      <td><span className={badgeClass(status)}>{patient.readyForClaim ? "提出候補" : patient.blocked ? "要対応" : "確認中"}</span></td>
      <td className="fee-monthly-task-cell">
        {primary ? (
          <>
            <span>{primary}</span>
            {restCount ? <small>他 {restCount.toLocaleString()}</small> : null}
          </>
        ) : <span className="fee-monthly-task-none">追加確認なし</span>}
      </td>
    </tr>
  );
}

// STEP4: 患者の点検詳細を右ドロワーで開く。テーブルのインライン展開を廃止して一覧の見通しを保つ。
function MonthlyPatientDrawer({ onApplyDiagnoses, onClose, onUpdateReceiptAnnotations, onUpdateWork, patient, savingSessionId }) {
  useEffect(() => {
    if (!patient) {
      return undefined;
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [patient, onClose]);

  if (!patient) {
    return null;
  }
  const firstSession = Array.isArray(patient.sessions) ? patient.sessions[0] : null;
  const status = patient.readyForClaim ? "提出候補" : patient.blocked ? "要対応" : "確認中";
  return (
    <div className="fee-drawer-overlay" role="presentation" onMouseDown={onClose}>
      <aside className="fee-drawer-panel" role="dialog" aria-modal="true" aria-label="患者の点検詳細" onMouseDown={(event) => event.stopPropagation()}>
        <header className="fee-drawer-head">
          <div>
            <strong>{patient.patientName || patient.patientId || "患者未設定"}</strong>
            <small>{patient.patientId || "患者ID未設定"} / {Number(patient.sessionCount || 0).toLocaleString()}受診 / {Number(patient.totalPoints || 0).toLocaleString()}点 / {status}</small>
          </div>
          <div className="fee-drawer-head-actions">
            {firstSession?.feeSessionId ? (
              <a className="btn btn--ghost btn--sm" href={`/sessions/${encodeURIComponent(firstSession.feeSessionId)}`}>算定画面で開く</a>
            ) : null}
            <button className="btn btn--ghost btn--icon" onClick={onClose} type="button" aria-label="閉じる">×</button>
          </div>
        </header>
        <div className="fee-drawer-body">
          <div className="fee-monthly-session-list">
            {(patient.sessions || []).map((session) => (
              <MonthlySessionReview
                key={session.feeSessionId || session.serviceDate}
                onApplyDiagnoses={onApplyDiagnoses}
                onUpdateReceiptAnnotations={onUpdateReceiptAnnotations}
                onUpdateWork={onUpdateWork}
                saving={savingSessionId === session.feeSessionId}
                session={session}
              />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function MonthlySessionReview({ onApplyDiagnoses, onUpdateReceiptAnnotations, onUpdateWork, saving, session }) {
  const issues = Array.isArray(session.readiness?.issues) ? session.readiness.issues : [];
  const workStatus = session.monthlyClaimWork?.status || "not_started";
  const firstAnnotation = firstReceiptAnnotation(session.receiptAnnotations);
  const [doctorName, setDoctorName] = useState(session.monthlyClaimWork?.doctorName || "");
  const [candidatesText, setCandidatesText] = useState(formatDiagnoses(session.monthlyClaimWork?.diagnosisCandidates || []));
  const [reason, setReason] = useState(session.monthlyClaimWork?.diagnosisRequestReason || defaultDiagnosisRequestReason(session));
  const [collectedResult, setCollectedResult] = useState(session.monthlyClaimWork?.collectedResult || "");
  const [annotationKind, setAnnotationKind] = useState(firstAnnotation.kind || "symptom_detail");
  const [annotationStatus, setAnnotationStatus] = useState(firstAnnotation.status || "draft");
  const [annotationCode, setAnnotationCode] = useState(firstAnnotation.code || "");
  const [annotationText, setAnnotationText] = useState(firstAnnotation.text || defaultReceiptAnnotationText(session));

  useEffect(() => {
    const nextAnnotation = firstReceiptAnnotation(session.receiptAnnotations);
    setDoctorName(session.monthlyClaimWork?.doctorName || "");
    setCandidatesText(formatDiagnoses(session.monthlyClaimWork?.diagnosisCandidates || []));
    setReason(session.monthlyClaimWork?.diagnosisRequestReason || defaultDiagnosisRequestReason(session));
    setCollectedResult(session.monthlyClaimWork?.collectedResult || "");
    setAnnotationKind(nextAnnotation.kind || "symptom_detail");
    setAnnotationStatus(nextAnnotation.status || "draft");
    setAnnotationCode(nextAnnotation.code || "");
    setAnnotationText(nextAnnotation.text || defaultReceiptAnnotationText(session));
  }, [session]);

  const diagnosisTarget = Boolean(session.readiness?.diagnosisRequestCandidate || session.monthlyClaimWork?.diagnosisRequestReason || session.monthlyClaimWork?.collectedResult);
  const annotationTarget = Boolean(
    session.readiness?.pendingReceiptAnnotationCount
    || session.readiness?.symptomDetailCandidateCount
    || firstAnnotation.text
  );

  function saveDiagnosisWork(nextStatus = workStatus) {
    onUpdateWork(session, {
      status: nextStatus,
      doctorName,
      diagnosisCandidates: parseDiagnoses(candidatesText),
      diagnosisRequestReason: reason,
      collectedResult
    });
  }

  function saveReceiptAnnotation(nextStatus = annotationStatus) {
    const nextAnnotations = upsertReceiptAnnotation(session.receiptAnnotations, {
      kind: annotationKind,
      status: nextStatus,
      code: annotationCode,
      text: annotationText,
      sourceReviewItemId: monthlyReceiptAnnotationSourceId(session),
      sourceLabel: "月次点検"
    });
    onUpdateReceiptAnnotations(session, nextAnnotations);
  }

  return (
    <article className="fee-monthly-session-review">
      <div className="fee-monthly-session-review-head">
        <div>
          <strong>{session.serviceDate || "受診日未設定"}</strong>
          <small>{Number(session.totalPoints || 0).toLocaleString()}点 / {monthlySessionStatusLabel(session)}</small>
        </div>
        <label>
          <span>作業状態</span>
          <select
            disabled={saving}
            onChange={(event) => onUpdateWork(session, { status: event.target.value })}
            value={workStatus}
          >
            {MONTHLY_WORK_STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      {issues.length ? (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${issue.type || "issue"}-${index}`}>
              <span>{issue.label || "要確認"}</span>
              <p>{issue.detail || "確認内容の詳細を確認してください。"}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>この受診分に追加確認はありません。</p>
      )}
      {diagnosisTarget ? (
        <div className="fee-monthly-diagnosis-task">
          <div className="fee-monthly-diagnosis-grid">
            <label>
              <span>依頼先医師</span>
              <input disabled={saving} onChange={(event) => setDoctorName(event.target.value)} value={doctorName} />
            </label>
            <label>
              <span>候補病名</span>
              <textarea disabled={saving} onChange={(event) => setCandidatesText(event.target.value)} rows={3} value={candidatesText} />
            </label>
            <label>
              <span>確認理由</span>
              <textarea disabled={saving} onChange={(event) => setReason(event.target.value)} rows={3} value={reason} />
            </label>
            <label>
              <span>回収結果</span>
              <textarea disabled={saving} onChange={(event) => setCollectedResult(event.target.value)} rows={3} value={collectedResult} />
            </label>
          </div>
          <div className="fee-monthly-diagnosis-actions">
            <button className="btn btn--ghost btn--sm" disabled={saving} onClick={() => saveDiagnosisWork("diagnosis_requested")} type="button">
              病名依頼として保存
            </button>
            <button className="btn btn--ghost btn--sm" disabled={saving} onClick={() => saveDiagnosisWork("doctor_confirming")} type="button">
              医師確認中にする
            </button>
            <button className="btn btn--ghost btn--sm" disabled={saving} onClick={() => saveDiagnosisWork("collected")} type="button">
              回収済みにする
            </button>
            <button
              className="btn btn--primary btn--sm"
              disabled={saving}
              onClick={() => onApplyDiagnoses(session, collectedResult, {
                doctorName,
                diagnosisCandidates: parseDiagnoses(candidatesText),
                diagnosisRequestReason: reason
              })}
              type="button"
            >
              病名へ反映
            </button>
          </div>
          <div className="fee-monthly-diagnosis-history">
            {session.monthlyClaimWork?.requestedAt ? <span>依頼 {formatDateTime(session.monthlyClaimWork.requestedAt)}</span> : null}
            {session.monthlyClaimWork?.collectedAt ? <span>回収 {formatDateTime(session.monthlyClaimWork.collectedAt)}</span> : null}
            {session.monthlyClaimWork?.appliedDiagnosisNames?.length ? <span>反映済み {session.monthlyClaimWork.appliedDiagnosisNames.join("、")}</span> : null}
          </div>
        </div>
      ) : null}
      {annotationTarget ? (
        <div className="fee-monthly-annotation-task">
          <div className="fee-monthly-diagnosis-grid">
            <label>
              <span>種別</span>
              <select disabled={saving} onChange={(event) => setAnnotationKind(event.target.value)} value={annotationKind}>
                <option value="symptom_detail">症状詳記</option>
                <option value="comment">コメント</option>
              </select>
            </label>
            <label>
              <span>状態</span>
              <select disabled={saving} onChange={(event) => setAnnotationStatus(event.target.value)} value={annotationStatus}>
                <option value="draft">下書き</option>
                <option value="confirmed">確定</option>
                <option value="rejected">不要</option>
              </select>
            </label>
            {annotationKind === "comment" ? (
              <label>
                <span>コメントコード</span>
                <input disabled={saving} onChange={(event) => setAnnotationCode(event.target.value)} value={annotationCode} />
              </label>
            ) : null}
            <label className="fee-monthly-annotation-text">
              <span>{annotationKind === "comment" ? "コメント本文" : "症状詳記本文"}</span>
              <textarea disabled={saving} onChange={(event) => setAnnotationText(event.target.value)} rows={4} value={annotationText} />
            </label>
          </div>
          <div className="fee-monthly-diagnosis-actions">
            <button className="btn btn--ghost btn--sm" disabled={saving || !annotationText.trim()} onClick={() => saveReceiptAnnotation("draft")} type="button">
              下書き保存
            </button>
            <button className="btn btn--primary btn--sm" disabled={saving || !annotationText.trim()} onClick={() => saveReceiptAnnotation("confirmed")} type="button">
              確定して出力対象
            </button>
            <button className="btn btn--ghost btn--sm" disabled={saving} onClick={() => saveReceiptAnnotation("rejected")} type="button">
              不要にする
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function MonthlySkeleton() {
  return (
    <div className="fee-monthly-skeleton">
      <div className="skeleton skeleton-block" />
      <div className="skeleton skeleton-block" />
      <div className="skeleton skeleton-block" />
    </div>
  );
}

function FeeSessionListView() {
  const feeApi = useFeeApi();
  const sessionSearchInputRef = useRef(null);
  const [sessions, setSessions] = useState([]);
  const [pageInfo, setPageInfo] = useState({
    page: 1,
    pageSize: FEE_SESSION_PAGE_SIZE,
    totalCount: 0,
    totalPages: 0,
    totalCountApproximate: false
  });
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const query = useMemo(() => ({ search, status }), [search, status]);

  useEffect(() => {
    const nextSearch = searchDraft.trim();
    const timeoutId = window.setTimeout(() => {
      setSearch((current) => (current === nextSearch ? current : nextSearch));
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchDraft]);

  const loadSessions = useCallback(async (page = 1) => {
    setLoading(true);
    setErrorMessage("");
    try {
      const response = await feeApi(`/v1/fee/sessions${sessionListQuery({ page, ...query })}`);
      setSessions(response.feeSessions || []);
      setPageInfo({
        page: Number(response.page || page),
        pageSize: Number(response.pageSize || FEE_SESSION_PAGE_SIZE),
        totalCount: Number(response.totalCount || response.feeSessions?.length || 0),
        totalPages: Number(response.totalPages || 0),
        totalCountApproximate: Boolean(response.totalCountApproximate)
      });
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "算定履歴を読み込めませんでした。"));
    } finally {
      setLoading(false);
    }
  }, [feeApi, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadSessions(1);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [loadSessions]);

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

  async function createSession() {
    setCreating(true);
    setErrorMessage("");
    try {
      const response = await feeApi("/v1/fee/sessions", {
        method: "POST",
        csrf: true,
        body: {}
      });
      const nextId = response.feeSession?.feeSessionId;
      if (!nextId) {
        throw new Error("作成した算定記録のIDを取得できませんでした。");
      }
      window.location.assign(`/sessions/${encodeURIComponent(nextId)}`);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "算定記録を作成できませんでした。"));
      setCreating(false);
    }
  }

  const groupedSessions = groupFeeSessionsByDay(sessions);
  const pageItems = buildPageItems(pageInfo.page, pageInfo.totalPages);
  const rangeStart = pageInfo.totalCount > 0 ? (pageInfo.page - 1) * pageInfo.pageSize + 1 : 0;
  const rangeEnd = pageInfo.totalCount > 0 ? rangeStart + sessions.length - 1 : 0;
  const isFiltered = Boolean(search) || status !== "all";

  return (
    <main className="dashboard fee-session-dashboard">
      <div className="dashboard-header">
        <h1>算定一覧</h1>
      </div>

      <section className="card quick-start-panel">
        <div className="quick-start-copy">
          <span className="label">新しい算定</span>
          <h2>新しい算定記録を作成します</h2>
          <p>患者とカルテ本文を入力して、算定候補を作成できます。</p>
        </div>
        <div className="quick-start-actions">
          <button className="btn btn--primary btn--lg" disabled={creating} onClick={createSession} type="button">
            <span>算定記録を作成</span>
          </button>
          <a className="btn btn--ghost btn--lg" href="/monthly">
            月次レセ点検
          </a>
        </div>
      </section>

      <section className="session-history">
        <div className="session-history-head">
          <div>
            <span className="label">履歴</span>
            <h2>過去の算定</h2>
          </div>
          <span className="session-history-count">
            {isFiltered ? `検索結果 ${Number(pageInfo.totalCount).toLocaleString()} 件` : `${pageInfo.totalCountApproximate ? "直近 " : ""}${Number(pageInfo.totalCount).toLocaleString()} 件`}
          </span>
        </div>

        <div className="session-history-toolbar" role="search">
          <label className="session-history-search">
            <span>検索</span>
            <input
              ref={sessionSearchInputRef}
              type="search"
              placeholder="患者名・患者IDで検索"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </label>
          <label className="session-history-filter">
            <span>状態</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">すべて</option>
              <option value="active">作成中</option>
              <option value="review">確認待ち</option>
              <option value="calculated">算定済み</option>
              <option value="failed">要確認</option>
            </select>
          </label>
        </div>

        {errorMessage ? <div className="inline-error" role="status">{errorMessage}</div> : null}
        {loading ? (
          <SessionSkeleton />
        ) : groupedSessions.length > 0 ? (
          <div className="session-history-results">
            <div className="session-history-page-summary">
              {rangeStart > 0 ? `${rangeStart}-${rangeEnd} 件を表示` : "0 件"}
            </div>
            <div className="session-history-groups">
              {groupedSessions.map((group) => (
                <section className="session-history-group" key={group.dayKey}>
                  <div className="session-history-date">{group.label}</div>
                  <SessionList sessions={group.sessions} />
                </section>
              ))}
            </div>
            <Pagination pageInfo={pageInfo} pageItems={pageItems} onPageChange={loadSessions} />
          </div>
        ) : (
          <div className="session-list">
            <div className="session-list-empty">
              {isFiltered ? "条件に一致する算定履歴はありません。検索条件を変更してください。" : "まだ算定履歴はありません。上のボタンから新しい算定記録を作成できます。"}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function FeeSessionDetailView({ sessionId }) {
  const feeApi = useFeeApi();
  const downloadReceiptCsvFile = useFeeReceiptCsvDownload();
  const downloadReceiptUkeFile = useFeeReceiptUkeDownload();
  const downloadMonthlyReceiptCsvFile = useFeeMonthlyReceiptCsvDownload();
  const downloadMonthlyReceiptUkeFile = useFeeMonthlyReceiptUkeDownload();
  const [patients, setPatients] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [masterStatus, setMasterStatus] = useState(null);
  const [feeSession, setFeeSession] = useState(null);
  const [receiptDraft, setReceiptDraft] = useState(null);
  const [candidateWorkbench, setCandidateWorkbench] = useState(null);
  const [form, setForm] = useState(defaultFeeForm);
  const [diagnosesTouched, setDiagnosesTouched] = useState(false);
  const [diagnosesEditedSinceLoad, setDiagnosesEditedSinceLoad] = useState(false);
  const [orderRows, setOrderRows] = useState([createEmptyOrderRow()]);
  const [orderRowsTouched, setOrderRowsTouched] = useState(false);
  const [clinicalTextBaselineHash, setClinicalTextBaselineHash] = useState("");
  const [patientFilter, setPatientFilter] = useState("");
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);
  const [newPatient, setNewPatient] = useState(defaultPatientForm);
  const [patientPickerOpen, setPatientPickerOpen] = useState(false);
  const [masterType, setMasterType] = useState("procedure");
  const [masterQuery, setMasterQuery] = useState("");
  const [masterItems, setMasterItems] = useState([]);
  const [selectedMasterIndex, setSelectedMasterIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [candidateDetail, setCandidateDetail] = useState(null);
  const [settingsModalMode, setSettingsModalMode] = useState(null);
  const [manualItemModalOpen, setManualItemModalOpen] = useState(false);
  const [manualItemDraft, setManualItemDraft] = useState(defaultManualBillingItemDraft);
  const [missingDiagnosisPromptOpen, setMissingDiagnosisPromptOpen] = useState(false);
  const [missingDiagnosisDraft, setMissingDiagnosisDraft] = useState("");
  const [activeMainTab, setActiveMainTab] = useState("work");
  const [pendingReviewDecisions, setPendingReviewDecisions] = useState({});
  const bootstrapLoadedRef = useRef(false);
  const toastTimersRef = useRef(new Map());
  const toastExitTimersRef = useRef(new Map());
  const patientSearchCacheRef = useRef(new Map());
  const patientSearchRequestSeqRef = useRef(0);
  const masterSearchCacheRef = useRef(new Map());
  const masterSearchRequestSeqRef = useRef(0);

  const dismissToast = useCallback((id) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }

    const exitTimer = toastExitTimersRef.current.get(id);
    if (exitTimer) {
      window.clearTimeout(exitTimer);
    }

    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    const nextExitTimer = window.setTimeout(() => {
      toastExitTimersRef.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 220);
    toastExitTimersRef.current.set(id, nextExitTimer);
  }, []);

  const addToast = useCallback((text, variant = "default") => {
    if (!text) {
      return;
    }
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, variant }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      dismissToast(id);
    }, 2800);
    toastTimersRef.current.set(id, timer);
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timer of toastTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    for (const timer of toastExitTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    toastTimersRef.current.clear();
    toastExitTimersRef.current.clear();
  }, []);

  const masterSearchAvailable = isMasterSearchAvailable(masterStatus);
  const patientSearchReady = shouldFetchPatientSearch(patientFilter);
  const filteredPatients = useMemo(() => patients.slice(0, PATIENT_SEARCH_LIMIT), [patients]);

  const defaultFacilityId = facilities.length === 1 ? facilities[0].facilityId : "";
  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.patientId === form.patientId)
      || patientFromSessionSnapshot(feeSession, form.patientId),
    [feeSession, form.patientId, patients]
  );
  const projectedReviewState = useMemo(() => projectPendingReviewDecisions({
    feeSession,
    receiptDraft,
    candidateWorkbench,
    pendingReviewDecisions
  }), [candidateWorkbench, feeSession, pendingReviewDecisions, receiptDraft]);
  const effectiveFeeSession = projectedReviewState.feeSession;
  const effectiveReceiptDraft = projectedReviewState.receiptDraft;
  const effectiveCandidateWorkbench = projectedReviewState.candidateWorkbench;
  const pendingReviewDecisionCount = projectedReviewState.pendingCount;
  const effectiveCandidateDetail = useMemo(() => (
    candidateDetail?.reviewItemId
      ? findCandidateWorkbenchItemByReviewItemId(effectiveCandidateWorkbench, candidateDetail.reviewItemId) || candidateDetail
      : candidateDetail
  ), [candidateDetail, effectiveCandidateWorkbench]);

  const applyDetail = useCallback((detail, options = {}) => {
    applyDetailResponse(detail, {
      setFeeSession,
      setReceiptDraft,
      setCandidateWorkbench,
      setForm,
      setDiagnosesTouched,
      setDiagnosesEditedSinceLoad,
      setOrderRows,
      setOrderRowsTouched,
      setClinicalTextBaselineHash
    }, options);
    if (!options.preservePendingReviewDecisions) {
      setPendingReviewDecisions({});
    }
  }, []);

  useEffect(() => {
    setSelectedMasterIndex(0);
  }, [masterItems, masterQuery, masterType]);

  const loadBootstrap = useCallback(async ({ force = false } = {}) => {
    if (bootstrapLoadedRef.current && !force) {
      return null;
    }
    const bootstrap = await feeApi("/v1/fee/bootstrap?include=facilities,departments,masterStatus");
    setFacilities(bootstrap.facilities || []);
    setDepartments(bootstrap.departments || []);
    setMasterStatus(bootstrap.masterStatus || null);
    bootstrapLoadedRef.current = true;
    return bootstrap;
  }, [feeApi]);

  const loadAll = useCallback(async ({ forceBootstrap = false } = {}) => {
    setLoading(true);
    try {
      const [, detail] = await Promise.all([
        loadBootstrap({ force: forceBootstrap }),
        feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/detail?includeReviewItems=false`)
      ]);
      applyDetail(detail);
    } catch (error) {
      addToast(toUserFacingErrorMessage(error, "算定詳細を読み込めませんでした。"), "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, applyDetail, feeApi, loadBootstrap, sessionId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshDetail = useCallback(async () => {
    const detail = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/detail?includeReviewItems=false`);
    applyDetail(detail);
    return detail;
  }, [applyDetail, feeApi, sessionId]);

  const refreshCalculationStatus = useCallback(async () => {
    const detail = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/detail-lite`);
    setFeeSession((current) => ({
      ...(current || {}),
      ...(detail.feeSession || {})
    }));
    return detail;
  }, [feeApi, sessionId]);

  useEffect(() => {
    if (!patientPickerOpen) {
      patientSearchRequestSeqRef.current += 1;
      setPatientSearchLoading(false);
      return undefined;
    }
    const rawQuery = patientFilter.trim();
    if (!shouldFetchPatientSearch(rawQuery)) {
      patientSearchRequestSeqRef.current += 1;
      setPatientSearchLoading(false);
      setPatients((current) => mergeSelectedPatient(current.slice(0, PATIENT_SEARCH_LIMIT), patientFromSessionSnapshot(feeSession, form.patientId)));
      return undefined;
    }
    const requestSeq = ++patientSearchRequestSeqRef.current;
    const cacheKey = normalizePatientSearchCacheKey(rawQuery);
    const cached = patientSearchCacheRef.current.get(cacheKey);
    if (cached?.expiresAt > Date.now()) {
      setPatients(mergeSelectedPatient(cached.patients || [], patientFromSessionSnapshot(feeSession, form.patientId)));
    }
    setPatientSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: String(PATIENT_SEARCH_LIMIT) });
        if (rawQuery) {
          params.set("q", rawQuery);
        }
        const response = await feeApi(`/v1/fee/patients?${params.toString()}`);
        if (requestSeq !== patientSearchRequestSeqRef.current) {
          return;
        }
        const nextPatients = response.patients || [];
        patientSearchCacheRef.current.set(cacheKey, {
          patients: nextPatients,
          expiresAt: Date.now() + 5 * 60 * 1000
        });
        prunePatientSearchCache(patientSearchCacheRef.current);
        setPatients(mergeSelectedPatient(nextPatients, patientFromSessionSnapshot(feeSession, form.patientId)));
      } catch {
        // Patient search is advisory; keep the current list if the request fails.
      } finally {
        if (requestSeq === patientSearchRequestSeqRef.current) {
          setPatientSearchLoading(false);
        }
      }
    }, cached ? 80 : 220);
    return () => window.clearTimeout(timer);
  }, [feeApi, feeSession, form.patientId, patientFilter, patientPickerOpen]);

  useEffect(() => {
    if (feeSession?.status !== "calculating") {
      return undefined;
    }
    let cancelled = false;
    let timeoutId = null;
    let attempt = 0;
    const startedAt = Date.now();

    const schedule = () => {
      const delay = CALCULATION_POLL_DELAYS_MS[Math.min(attempt, CALCULATION_POLL_DELAYS_MS.length - 1)];
      timeoutId = window.setTimeout(poll, delay);
    };

    const poll = async () => {
      try {
        const detail = await refreshCalculationStatus();
        if (cancelled) {
          return;
        }
        const status = detail.feeSession?.status;
        if (status && status !== "calculating") {
          await refreshDetail();
          if (status === "failed") {
            addToast("算定候補の作成に失敗しました。入力内容を確認してもう一度お試しください。", "error");
          }
          return;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= CALCULATION_POLL_TIMEOUT_MS) {
          addToast("算定候補の作成に時間がかかっています。しばらくしてから最新の状態に更新するか、再度お試しください。", "error");
          return;
        }
        attempt += 1;
        schedule();
      } catch (error) {
        if (!cancelled) {
          const fallback = Number(error?.status) === 504
            ? "算定候補の作成がタイムアウトしました。最新の状態に更新するか、入力内容を確認して再試行してください。"
            : "算定結果を更新できませんでした。";
          addToast(toUserFacingErrorMessage(error, fallback), "error");
        }
      }
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [addToast, feeSession?.status, refreshCalculationStatus, refreshDetail]);

  useEffect(() => {
    if (!pendingReviewDecisionCount) {
      return undefined;
    }
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [pendingReviewDecisionCount]);

  useEffect(() => {
    if (!masterSearchAvailable) {
      masterSearchRequestSeqRef.current += 1;
      setMasterItems([]);
      return undefined;
    }
    const query = masterQuery.trim();
    if (query.length < 2) {
      masterSearchRequestSeqRef.current += 1;
      setMasterItems([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      const requestSeq = ++masterSearchRequestSeqRef.current;
      const cacheKey = JSON.stringify({
        type: masterType || "all",
        query,
        limit: 10
      });
      const cached = masterSearchCacheRef.current.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setMasterItems(cached.items || []);
        if (cached.masterStatus) {
          setMasterStatus(cached.masterStatus);
        }
        return;
      }
      try {
        const params = new URLSearchParams({
          type: masterType || "all",
          q: query,
          limit: "10"
        });
        const response = await feeApi(`/v1/fee/master/search?${params.toString()}`);
        if (requestSeq !== masterSearchRequestSeqRef.current) {
          return;
        }
        masterSearchCacheRef.current.set(cacheKey, {
          items: response.items || [],
          masterStatus: response.masterStatus || null,
          expiresAt: Date.now() + 5 * 60 * 1000
        });
        pruneMasterSearchCache(masterSearchCacheRef.current);
        setMasterItems(response.items || []);
        if (response.masterStatus) {
          setMasterStatus(response.masterStatus);
        }
      } catch (error) {
        if (requestSeq !== masterSearchRequestSeqRef.current) {
          return;
        }
        addToast(toUserFacingErrorMessage(error, "マスター検索に失敗しました。"), "error");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [addToast, feeApi, masterQuery, masterSearchAvailable, masterType]);

  function updateForm(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateClinicalText(value) {
    const nextHash = clinicalTextHash(value);
    const shouldResetLoadedDiagnoses = diagnosesTouched
      && !diagnosesEditedSinceLoad
      && Boolean(clinicalTextBaselineHash)
      && nextHash !== clinicalTextBaselineHash;
    if (shouldResetLoadedDiagnoses) {
      setDiagnosesTouched(false);
    }
    setForm((current) => ({
      ...current,
      clinicalText: value,
      diagnosesText: (diagnosesTouched && !shouldResetLoadedDiagnoses)
        ? current.diagnosesText
        : deriveDiagnosesTextFromClinicalText(value)
    }));
  }

  function updateDiagnosesText(value) {
    setDiagnosesTouched(true);
    setDiagnosesEditedSinceLoad(true);
    updateForm("diagnosesText", value);
  }

  function selectPatient(patientId) {
    updateForm("patientId", patientId);
    setPatientPickerOpen(false);
  }

  function handleMasterSearchKeyDown(event) {
    if (!masterItems.length) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedMasterIndex((current) => Math.min(masterItems.length - 1, current + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedMasterIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      addMasterSearchItem(masterItems[selectedMasterIndex] || masterItems[0]);
    }
  }

  const saveDetails = useCallback(async (options = {}) => {
    const rowsForPayload = Array.isArray(options.orderRowsOverride) ? options.orderRowsOverride : orderRows;
    const formForPayload = options.formOverride || form;
    const body = buildFeeSessionPayload({
      defaultFacilityId,
      form: formForPayload,
      orderRows: rowsForPayload,
      patients,
      diagnosesTouched: options.diagnosesTouchedOverride ?? diagnosesTouched,
      orderRowsTouched: options.orderRowsTouchedOverride ?? orderRowsTouched,
      clinicalTextBaselineHash
    });
    const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      csrf: true,
      body
    });
    applyDetail(response, {
      preserveCalculationOutput: true,
      currentFeeSession: feeSession,
      currentReceiptDraft: receiptDraft,
      currentCandidateWorkbench: candidateWorkbench
    });
    if (!options.silent) {
      addToast("入力を保存しました。", "success");
    }
    return response;
  }, [
    addToast,
    applyDetail,
    candidateWorkbench,
    clinicalTextBaselineHash,
    defaultFacilityId,
    diagnosesTouched,
    feeApi,
    feeSession,
    form,
    orderRows,
    orderRowsTouched,
    patients,
    receiptDraft,
    sessionId
  ]);

  async function savePendingReviewDecisions(options = {}) {
    const decisions = Object.entries(pendingReviewDecisions)
      .map(([reviewItemId, decision]) => ({
        reviewItemId,
        status: decision.status
      }))
      .filter((decision) => decision.reviewItemId && decision.status);
    if (!decisions.length) {
      return true;
    }
    let succeeded = false;
    await runBusy(setBusy, addToast, async () => {
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/review-items`, {
        method: "PATCH",
        csrf: true,
        body: { decisions }
      });
      setFeeSession(response.feeSession || effectiveFeeSession || feeSession);
      setReceiptDraft(response.receiptDraft || effectiveReceiptDraft || receiptDraft);
      setCandidateWorkbench(response.candidateWorkbench || effectiveCandidateWorkbench || null);
      setPendingReviewDecisions({});
      succeeded = true;
      if (!options.silent) {
        addToast("採否変更を保存しました。", "success");
      }
    });
    return succeeded;
  }

  async function calculate(options = {}) {
    if (!options.skipSaveReviewDecisions && pendingReviewDecisionCount) {
      const saved = await savePendingReviewDecisions({ silent: true });
      if (!saved) {
        return;
      }
    }
    await runBusy(setBusy, addToast, async () => {
      let saved = null;
      let calculationBody = {};
      if (options.skipSaveDetails) {
        const payload = buildFeeSessionPayload({
          defaultFacilityId,
          form: options.formOverride || form,
          orderRows: Array.isArray(options.orderRowsOverride) ? options.orderRowsOverride : orderRows,
          patients,
          diagnosesTouched: options.diagnosesTouchedOverride ?? diagnosesTouched,
          orderRowsTouched: options.orderRowsOverride ? true : orderRowsTouched,
          clinicalTextBaselineHash
        });
        if (options.calculationMode) {
          calculationBody.calculationMode = options.calculationMode;
        }
        if (options.includeOrdersForCalculation) {
          calculationBody.orders = payload.orders || [];
        }
        if (options.includeCalculationOptionsForCalculation) {
          calculationBody.calculationOptions = payload.calculationOptions || null;
        }
      } else {
        saved = await saveDetails({
          silent: true,
          formOverride: options.formOverride,
          orderRowsOverride: options.orderRowsOverride,
          diagnosesTouchedOverride: options.diagnosesTouchedOverride,
          orderRowsTouchedOverride: options.orderRowsOverride ? true : undefined
        });
        if (options.calculationMode) {
          calculationBody.calculationMode = options.calculationMode;
        }
      }
      setFeeSession((current) => ({
        ...(saved?.feeSession || current || {}),
        status: "calculating",
        calculationResult: saved?.feeSession?.calculationResult || current?.calculationResult || null,
        calculationSummary: saved?.feeSession?.calculationSummary || current?.calculationSummary || null,
        calculationProgress: buildClientCalculationProgress({
          phase: "extract",
          percent: 10,
          message: "カルテ本文から算定に必要な情報を抽出しています。"
        })
      }));
      let response;
      try {
        response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/calculation-jobs`, {
          method: "POST",
          csrf: true,
          body: calculationBody
        });
      } catch (error) {
        await refreshCalculationStatus().catch(() => refreshDetail().catch(() => null));
        throw error;
      }
      const jobStatus = String(response.calculationJob?.status || "").trim();
      const jobQueued = ["queued", "waiting_for_worker", "running"].includes(jobStatus);
      const statusDetail = await refreshCalculationStatus();
      const refreshedStatus = String(statusDetail.feeSession?.status || "").trim();
      if (jobQueued && refreshedStatus && refreshedStatus !== "calculating") {
        await refreshDetail();
        if (refreshedStatus === "failed") {
          addToast("算定候補の作成に失敗しました。入力内容を確認してもう一度お試しください。", "error");
        }
        return;
      }
      if (!jobQueued) {
        addToast("算定ジョブを開始できませんでした。Cloud Tasks または Pub/Sub の設定を確認して再度お試しください。", "error");
      }
    });
  }

  async function requestCalculate() {
    if (!hasDiagnosisInput(form.diagnosesText)) {
      setMissingDiagnosisDraft("");
      setMissingDiagnosisPromptOpen(true);
      return;
    }
    await calculate();
  }

  async function calculateWithoutDiagnosis() {
    setMissingDiagnosisPromptOpen(false);
    await calculate({ allowMissingDiagnosis: true });
  }

  async function calculateWithDiagnosis() {
    const nextDiagnosesText = String(missingDiagnosisDraft || "").trim();
    if (!nextDiagnosesText) {
      addToast("病名を入力するか、病名なしで進んでください。", "error");
      return;
    }
    const nextForm = {
      ...form,
      diagnosesText: nextDiagnosesText
    };
    setDiagnosesTouched(true);
    setDiagnosesEditedSinceLoad(true);
    setForm(nextForm);
    setMissingDiagnosisPromptOpen(false);
    await calculate({
      allowMissingDiagnosis: true,
      formOverride: nextForm,
      diagnosesTouchedOverride: true
    });
  }

  async function createPatient(event) {
    event.preventDefault();
    await runBusy(setBusy, addToast, async () => {
      const externalPatientIds = newPatient.patientRef.trim() ? [newPatient.patientRef.trim()] : [];
      const response = await feeApi("/v1/fee/patients", {
        method: "POST",
        csrf: true,
        body: {
          displayName: newPatient.displayName,
          birthDate: emptyToNull(newPatient.birthDate),
          sex: newPatient.sex,
          externalPatientIds
        }
      });
      const patient = response.patient;
      setPatients((current) => mergeSelectedPatient(current, patient));
      setForm((current) => ({
        ...current,
        patientId: patient?.patientId || current.patientId
      }));
      setNewPatient(defaultPatientForm());
      addToast("患者を作成しました。", "success");
    });
  }

  function decideReviewItem(reviewItemId, status, previousStatus = "") {
    if (!reviewItemId) {
      return;
    }
    const nextStatus = decisionSelectValue(status);
    setPendingReviewDecisions((current) => {
      const currentDecision = current[reviewItemId] || null;
      const baselineItem = findCandidateWorkbenchItemByReviewItemId(candidateWorkbench, reviewItemId);
      const baseStatus = currentDecision?.baseStatus
        || decisionSelectValue(baselineItem?.decisionStatus || baselineItem?.status || previousStatus);
      const next = { ...current };
      if (nextStatus === baseStatus) {
        delete next[reviewItemId];
      } else {
        next[reviewItemId] = {
          baseStatus,
          status: nextStatus,
          decidedAt: new Date().toISOString()
        };
      }
      return next;
    });
  }

  async function saveReceiptAnnotationFromItem(item, draft) {
    await runBusy(setBusy, addToast, async () => {
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        csrf: true,
        body: {
          receiptAnnotations: upsertReceiptAnnotation(feeSession?.receiptAnnotations, {
            ...draft,
            sourceReviewItemId: item?.reviewItemId || draft.sourceReviewItemId,
            sourceLabel: item?.displayTitle || item?.name || "算定候補"
          })
        }
      });
      setFeeSession(response.feeSession || feeSession);
      setReceiptDraft(response.receiptDraft || receiptDraft);
      setCandidateWorkbench(response.candidateWorkbench || null);
      addToast("コメント・詳記を保存しました。", "success");
    });
  }

  async function copyReceiptDraft(options = {}) {
    const target = options.scope === "monthly" ? options.receiptDraft : effectiveReceiptDraft;
    if (!target) {
      addToast("コピーできるレセプト案がまだありません。", "error");
      return;
    }
    await runBusy(setBusy, addToast, async () => {
      const text = formatReceiptDraftForClipboard({ feeSession: effectiveFeeSession, receiptDraft: target });
      await writeClipboardText(text);
      addToast(options.scope === "monthly" ? "月次集計レセプトをコピーしました。" : "レセプト案をコピーしました。", "success");
    });
  }

  async function downloadReceiptCsv(options = {}) {
    if (options.scope === "monthly") {
      if (!options.patientId || !options.claimMonth) {
        addToast("月次集計CSVを出力する患者・請求月がありません。", "error");
        return;
      }
      await runBusy(setBusy, addToast, async () => {
        await downloadMonthlyReceiptCsvFile(options.patientId, options.claimMonth);
        addToast("月次集計レセプトCSVをダウンロードしました。", "success");
      });
      return;
    }
    if (!sessionId) {
      addToast("CSVを出力できるセッションがありません。", "error");
      return;
    }
    if (pendingReviewDecisionCount) {
      addToast("未保存の採否変更があります。保存してからCSVを出力してください。", "error");
      return;
    }
    await runBusy(setBusy, addToast, async () => {
      await downloadReceiptCsvFile(sessionId);
      addToast("レセプト取込用CSVをダウンロードしました。", "success");
    });
  }

  async function downloadReceiptUke(encoding = "shift_jis", options = {}) {
    if (options.scope === "monthly") {
      if (!options.patientId || !options.claimMonth) {
        addToast("月次集計レセ電を出力する患者・請求月がありません。", "error");
        return;
      }
      await runBusy(setBusy, addToast, async () => {
        await downloadMonthlyReceiptUkeFile(options.patientId, options.claimMonth, encoding);
        addToast("月次集計レセプト電算(UKE)をダウンロードしました。", "success");
      });
      return;
    }
    if (!sessionId) {
      addToast("レセ電を出力できるセッションがありません。", "error");
      return;
    }
    if (pendingReviewDecisionCount) {
      addToast("未保存の採否変更があります。保存してからレセ電を出力してください。", "error");
      return;
    }
    await runBusy(setBusy, addToast, async () => {
      await downloadReceiptUkeFile(sessionId, encoding);
      addToast("レセプト電算(UKE)をダウンロードしました。", "success");
    });
  }

  function addOrderRow() {
    setOrderRowsTouched(true);
    setOrderRows((current) => [...current.filter((row) => row.localName || row.standardCode), createEmptyOrderRow()]);
  }

  function updateOrderRow(index, field, value) {
    setOrderRowsTouched(true);
    setOrderRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [field]: value } : row
    )));
  }

  function removeOrderRow(index) {
    setOrderRowsTouched(true);
    setOrderRows((current) => {
      const nextRows = current.filter((_, rowIndex) => rowIndex !== index);
      return nextRows.length ? nextRows : [createEmptyOrderRow()];
    });
  }

  function addMasterSearchItem(item = {}) {
    addOrderFromMasterItem(item);
  }

  function addOrderFromMasterItem(item = {}, options = {}) {
    if (item.kind === "comment") {
      try {
        updateForm("calculationOptionsText", calculationOptionsTextWithComment(form.calculationOptionsText, item));
        if (!options.silent) {
          addToast("コメントを算定オプションに追加しました。", "success");
        }
      } catch (error) {
        addToast(toUserFacingErrorMessage(error, "算定オプション JSONを確認してください。"), "error");
      }
      return;
    }

    setOrderRowsTouched(true);
    setOrderRows((current) => [
      ...current.filter((row) => row.localName || row.standardCode),
      {
        orderType: orderTypeFromMasterKind(item.kind),
        localName: item.name || "",
        standardCode: item.code || "",
        standardName: item.name || "",
        quantity: String(options.quantity || "1"),
        sourceSystem: "fee_web_user_added",
        sourceLabel: "ユーザー追加",
        note: options.note || "",
        createdAt: new Date().toISOString()
      }
    ]);
    if (!options.silent) {
      addToast("マスターからオーダーを追加しました。", "success");
    }
  }

  async function applyManualOrdersAndCalculate() {
    setSettingsModalMode(null);
    await calculate();
  }

  async function addManualBillingItemAndCalculate() {
    const selectedItems = manualDraftSelectedItems(manualItemDraft);
    if (!selectedItems.length) {
      addToast("追加するマスターを選択してください。", "error");
      return;
    }
    const duplicate = manualBillingBatchDuplicateReason({ entries: selectedItems, orderRows, receiptDraft });
    if (duplicate) {
      addToast(duplicate, "error");
      return;
    }

    let nextForm = form;
    const orderEntries = [];
    for (const entry of selectedItems) {
      const item = entry.item || {};
      if (item.kind === "comment") {
        nextForm = {
          ...nextForm,
          calculationOptionsText: calculationOptionsTextWithComment(nextForm.calculationOptionsText, item)
        };
        continue;
      }
      orderEntries.push({
        orderType: orderTypeFromMasterKind(item.kind),
        localName: item.name || "",
        standardCode: item.code || "",
        standardName: item.name || "",
        quantity: String(entry.quantity || "1"),
        sourceSystem: "fee_web_user_added",
        sourceLabel: "ユーザー追加",
        note: manualItemDraft.note || "",
        createdAt: new Date().toISOString()
      });
    }

    const nextRows = orderEntries.length
      ? [...orderRows.filter((row) => row.localName || row.standardCode), ...orderEntries]
      : orderRows;
    if (nextForm !== form) {
      setForm(nextForm);
    }
    if (orderEntries.length) {
      setOrderRowsTouched(true);
      setOrderRows(nextRows);
    }
    setManualItemDraft(defaultManualBillingItemDraft());
    setManualItemModalOpen(false);
    const canReuseClinical = canReuseClinicalCalculationForManualChange({
      feeSession,
      form,
      nextForm,
      defaultFacilityId,
      clinicalTextBaselineHash
    });
    await calculate({
      formOverride: nextForm !== form ? nextForm : undefined,
      orderRowsOverride: orderEntries.length ? nextRows : undefined,
      skipSaveDetails: canReuseClinical,
      calculationMode: canReuseClinical ? "reuse_clinical" : undefined,
      includeOrdersForCalculation: canReuseClinical && orderEntries.length > 0,
      includeCalculationOptionsForCalculation: canReuseClinical && nextForm !== form
    });
  }

  async function removeManualOrderAndCalculate(rowIndex) {
    const nextRows = orderRows.filter((_, index) => index !== rowIndex);
    const normalizedRows = nextRows.length ? nextRows : [createEmptyOrderRow()];
    setOrderRowsTouched(true);
    setOrderRows(normalizedRows);
    const canReuseClinical = canReuseClinicalCalculationForManualChange({
      feeSession,
      form,
      nextForm: form,
      defaultFacilityId,
      clinicalTextBaselineHash
    });
    await calculate({
      orderRowsOverride: normalizedRows,
      skipSaveDetails: canReuseClinical,
      calculationMode: canReuseClinical ? "reuse_clinical" : undefined,
      includeOrdersForCalculation: canReuseClinical
    });
  }

  function updateOutpatientBasicKind(value) {
    try {
      const options = parseJsonObjectField(form.calculationOptionsText, "算定オプション JSON") || {};
      if (!value) {
        delete options.outpatient_basic;
      } else {
        const currentBasic = options.outpatient_basic && typeof options.outpatient_basic === "object" && !Array.isArray(options.outpatient_basic)
          ? options.outpatient_basic
          : {};
        options.outpatient_basic = {
          ...currentBasic,
          fee_kind: value
        };
      }
      updateForm("calculationOptionsText", formatJsonObject(options));
      addToast(value ? "初診/再診の手動指定を更新しました。再計算すると反映されます。" : "初診/再診を自動判定に戻しました。再計算すると反映されます。", "default");
    } catch (error) {
      addToast(toUserFacingErrorMessage(error, "算定オプション JSONを確認してください。"), "error");
    }
  }

  if (loading) {
    return (
      <main className="fee-shell">
        <header className="fee-page-head">
          <div>
            <span className="label">算定記録</span>
            <h1>算定詳細</h1>
            <p>読み込み中です。</p>
          </div>
          <a className="btn btn--ghost" href="/sessions">一覧へ戻る</a>
        </header>
        <SessionSkeleton />
      </main>
    );
  }

  const calculation = feeSession?.calculationResult || null;
  const isCalculating = feeSession?.status === "calculating";

  return (
    <main className="fee-shell fee-shell--detail">
      <div className="fee-toast-container" aria-live="polite">
        {toasts.map((toast) => (
          <div
            className={`fee-toast ${toast.variant === "success" ? "fee-toast--success" : toast.variant === "error" ? "fee-toast--error" : ""} ${toast.leaving ? "fee-toast--leaving" : ""}`}
            key={toast.id}
            role="status"
          >
            {toast.variant === "success" ? <span aria-hidden="true" className="fee-toast-icon">✓</span> : null}
            {toast.variant === "error" ? <span aria-hidden="true" className="fee-toast-icon">!</span> : null}
            <span className="fee-toast-message">{toast.text}</span>
            <button className="fee-toast-close-button" onClick={() => dismissToast(toast.id)} type="button" aria-label="通知を閉じる">
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="fee-session-workspace">
        <SourcePane
          busy={busy}
          candidateWorkbench={effectiveCandidateWorkbench}
          feeSession={effectiveFeeSession}
          filteredPatients={filteredPatients}
          form={form}
          newPatient={newPatient}
          onCreatePatient={createPatient}
          onOpenConditions={() => setSettingsModalMode("conditions")}
          onOpenOrders={() => setSettingsModalMode("orders")}
          onSelectPatient={selectPatient}
          onUpdateClinicalText={updateClinicalText}
          onUpdateDiagnosesText={updateDiagnosesText}
          orderCount={parseOrdersFromRows(orderRows).length}
          patientFilter={patientFilter}
          patientPickerOpen={patientPickerOpen}
          patientSearchLoading={patientSearchLoading}
          patientSearchReady={patientSearchReady}
          selectedPatient={selectedPatient}
          setNewPatient={setNewPatient}
          setPatientFilter={setPatientFilter}
          setPatientPickerOpen={setPatientPickerOpen}
        />
        <WorkPane
          activeMainTab={activeMainTab}
          calculation={calculation}
          candidateWorkbench={effectiveCandidateWorkbench}
          disabled={busy}
          feeSession={effectiveFeeSession}
          onCopyReceipt={copyReceiptDraft}
          onDownloadCsv={downloadReceiptCsv}
          onDownloadUke={downloadReceiptUke}
          onDecision={decideReviewItem}
          onOpenDetail={setCandidateDetail}
          onOpenManualItem={() => {
            setManualItemDraft(defaultManualBillingItemDraft());
            setManualItemModalOpen(true);
            setActiveMainTab("work");
          }}
          onSetMainTab={setActiveMainTab}
          onRemoveManualOrder={removeManualOrderAndCalculate}
          orderRows={orderRows}
          receiptDraft={effectiveReceiptDraft}
          selected={Boolean(sessionId)}
        />
      </div>
      <SessionActionFooter
        busy={busy}
        calculate={requestCalculate}
        isCalculating={isCalculating}
        onRefresh={() => {
          if (pendingReviewDecisionCount && !window.confirm("未保存の採否変更を破棄して最新状態に更新しますか？")) {
            return;
          }
          loadAll({ forceBootstrap: true });
        }}
        onSaveReviewDecisions={savePendingReviewDecisions}
        pendingReviewDecisionCount={pendingReviewDecisionCount}
      />
      <FeeSettingsModal
        available={masterSearchAvailable}
        busy={busy}
        defaultFacilityId={defaultFacilityId}
        departments={departments}
        facilities={facilities}
        form={form}
        handleMasterSearchKeyDown={handleMasterSearchKeyDown}
        items={masterItems}
        masterQuery={masterQuery}
        masterType={masterType}
        mode={settingsModalMode}
        onAddMaster={addMasterSearchItem}
        onAddOrderRow={addOrderRow}
        onApplyOrders={applyManualOrdersAndCalculate}
        onClose={() => setSettingsModalMode(null)}
        onMasterQueryChange={setMasterQuery}
        onMasterTypeChange={setMasterType}
        onRemoveOrderRow={removeOrderRow}
        onUpdateOutpatientBasicKind={updateOutpatientBasicKind}
        onUpdateForm={updateForm}
        onUpdateOrderRow={updateOrderRow}
        orderRows={orderRows}
        orderCount={parseOrdersFromRows(orderRows).length}
        selectedMasterIndex={selectedMasterIndex}
      />
      <CandidateDetailModal
        disabled={busy}
        item={effectiveCandidateDetail}
        onClose={() => setCandidateDetail(null)}
        onDecision={decideReviewItem}
        onSaveReceiptAnnotation={saveReceiptAnnotationFromItem}
      />
      <MissingDiagnosisWarningModal
        disabled={busy}
        onChange={setMissingDiagnosisDraft}
        onClose={() => setMissingDiagnosisPromptOpen(false)}
        onProceedWithDiagnosis={calculateWithDiagnosis}
        onProceedWithoutDiagnosis={calculateWithoutDiagnosis}
        open={missingDiagnosisPromptOpen}
        value={missingDiagnosisDraft}
      />
      <ManualBillingItemModal
        available={masterSearchAvailable}
        disabled={busy}
        draft={manualItemDraft}
        items={masterItems}
        masterQuery={masterQuery}
        masterType={masterType}
        onAdd={addManualBillingItemAndCalculate}
        onClose={() => setManualItemModalOpen(false)}
        onDraftChange={setManualItemDraft}
        onMasterQueryChange={setMasterQuery}
        onMasterTypeChange={setMasterType}
        onSelectMaster={(item) => setManualItemDraft((current) => ({
          ...current,
          selectedItems: appendManualBillingDraftItem(current, item)
        }))}
        onRemoveSelected={(index) => setManualItemDraft((current) => ({
          ...current,
          selectedItems: manualDraftSelectedItems(current).filter((_, itemIndex) => itemIndex !== index)
        }))}
        onUpdateSelectedQuantity={(index, quantity) => setManualItemDraft((current) => ({
          ...current,
          selectedItems: manualDraftSelectedItems(current).map((entry, itemIndex) => (
            itemIndex === index ? { ...entry, quantity } : entry
          ))
        }))}
        open={manualItemModalOpen}
        orderRows={orderRows}
        receiptDraft={effectiveReceiptDraft}
        selectedMasterIndex={selectedMasterIndex}
      />
    </main>
  );
}

function SessionActionFooter({ busy, calculate, isCalculating, onRefresh, onSaveReviewDecisions, pendingReviewDecisionCount = 0 }) {
  return (
    <footer className="fee-session-action-footer">
      <div className="source-action-buttons">
        {pendingReviewDecisionCount ? (
          <button className="btn btn--primary" disabled={busy || isCalculating} onClick={() => onSaveReviewDecisions()} type="button">
            変更を保存（{pendingReviewDecisionCount.toLocaleString()}件）
          </button>
        ) : null}
        <button className="btn btn--primary" disabled={busy || isCalculating} onClick={calculate} type="button">
          {isCalculating ? "算定候補を作成中" : "カルテから算定候補を作成"}
        </button>
        <button className="btn btn--ghost btn--icon" disabled={busy} onClick={onRefresh} type="button" aria-label="最新の状態に更新">↻</button>
      </div>
    </footer>
  );
}

function MissingDiagnosisWarningModal({
  disabled,
  onChange,
  onClose,
  onProceedWithDiagnosis,
  onProceedWithoutDiagnosis,
  open,
  value
}) {
  if (!open) {
    return null;
  }
  const canProceedWithDiagnosis = hasDiagnosisInput(value);
  return (
    <div className="fee-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section className="fee-modal-card missing-diagnosis-modal" role="dialog" aria-modal="true" aria-label="病名未入力の確認" onMouseDown={(event) => event.stopPropagation()}>
        <header className="fee-modal-head">
          <div>
            <h2>病名が未入力です</h2>
          </div>
          <button className="btn btn--ghost btn--icon" disabled={disabled} onClick={onClose} type="button" aria-label="閉じる">×</button>
        </header>
        <div className="fee-modal-body">
          <p>
            病名なしでも算定候補は作成できますが、査定・返戻確認では病名が算定根拠になります。分かる範囲で入力してから進むことを推奨します。
          </p>
          <label className="missing-diagnosis-field">
            <span>病名</span>
            <textarea
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              placeholder={"例: 急性胃腸炎（ウイルス性疑い）\n例: 高血圧症（コントロール良好）"}
              rows={4}
              value={value}
            />
          </label>
        </div>
        <footer className="fee-modal-footer">
          <button className="btn btn--ghost" disabled={disabled} onClick={onClose} type="button">キャンセル</button>
          <button className="btn btn--ghost" disabled={disabled} onClick={onProceedWithoutDiagnosis} type="button">病名なしで進む</button>
          <button className="btn btn--primary" disabled={disabled || !canProceedWithDiagnosis} onClick={onProceedWithDiagnosis} type="button">病名を入れて進む</button>
        </footer>
      </section>
    </div>
  );
}

function SourcePane({
  busy,
  candidateWorkbench,
  feeSession,
  filteredPatients,
  form,
  newPatient,
  onCreatePatient,
  onOpenConditions,
  onOpenOrders,
  onSelectPatient,
  onUpdateClinicalText,
  onUpdateDiagnosesText,
  orderCount,
  patientFilter,
  patientPickerOpen,
  patientSearchLoading,
  patientSearchReady,
  selectedPatient,
  setNewPatient,
  setPatientFilter,
  setPatientPickerOpen
}) {
  const diagnosisCount = form.diagnosesText.split(/\n+/u).map((item) => item.trim()).filter(Boolean).length;
  const clinicalAnnotations = clinicalTextAnnotationsFromCalculationContext({
    calculationResult: feeSession?.calculationResult,
    workbench: candidateWorkbench
  });

  return (
    <section className="fee-source-pane" aria-label="算定条件とカルテ">
      <div className="fee-source-form" id="fee-session-detail-form">
        <section className="source-section">
          <div className="source-section-head">
            <div>
              <h2>患者</h2>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={onOpenConditions} type="button">算定条件</button>
          </div>
          <div className="patient-picker-row">
            <PatientPicker
              filteredPatients={filteredPatients}
              isOpen={patientPickerOpen}
              onFilterChange={setPatientFilter}
              onOpenChange={setPatientPickerOpen}
              onSelect={onSelectPatient}
              patientFilter={patientFilter}
              searchLoading={patientSearchLoading}
              searchReady={patientSearchReady}
              selectedPatient={selectedPatient}
            />
            <PatientCreateForm
              disabled={busy}
              patient={newPatient}
              setPatient={setNewPatient}
              onSubmit={onCreatePatient}
            />
          </div>
        </section>

        <section className="source-section source-section--chart">
          <div className="source-section-head">
            <div>
              <h2>カルテ本文・病名</h2>
              <p>病名 {diagnosisCount.toLocaleString()}件</p>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={onOpenOrders} type="button">
              オーダーを確認
            </button>
          </div>
          <label className="diagnosis-inline-field">
            <span>病名</span>
            <textarea
              className="diagnosis-textarea"
              placeholder={"必要に応じて病名を1行ずつ入力してください"}
              value={form.diagnosesText}
              onChange={(event) => onUpdateDiagnosesText(event.target.value)}
            />
            <small>未入力の場合は算定候補作成時に確認します。</small>
          </label>
          <label className="clinical-text-field">
            <span>カルテの内容</span>
            <ClinicalTextEditor
              annotationRevisionKey={candidateWorkbench}
              annotations={clinicalAnnotations}
              onChange={onUpdateClinicalText}
              value={form.clinicalText}
            />
          </label>
          <div className="source-order-summary">
            <span>手入力オーダー</span>
            <strong>{orderCount.toLocaleString()}件</strong>
          </div>
        </section>
      </div>
    </section>
  );
}

function ClinicalTextEditor({ annotationRevisionKey = null, annotations = [], onChange, value = "" }) {
  const editorRef = useRef(null);
  const acceptedAnnotationKeysRef = useRef(new Set());
  const isComposingRef = useRef(false);
  const [acceptedAnnotationVersion, setAcceptedAnnotationVersion] = useState(0);
  const renderedHtml = useMemo(
    () => renderClinicalTextEditorHtml(value, annotations, { suppressedAnnotationKeys: acceptedAnnotationKeysRef.current }),
    [acceptedAnnotationVersion, annotations, value]
  );

  useEffect(() => {
    acceptedAnnotationKeysRef.current = new Set();
    setAcceptedAnnotationVersion((current) => current + 1);
  }, [annotationRevisionKey]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor || isComposingRef.current) {
      return;
    }
    const current = clinicalTextFromEditor(editor);
    if (current !== String(value || "") || editor.innerHTML !== renderedHtml) {
      editor.innerHTML = renderedHtml;
    }
  }, [renderedHtml, value]);

  function rememberAcceptedAnnotationKeys(acceptedKeys = []) {
    if (!acceptedKeys.length) {
      return false;
    }
    let changed = false;
    for (const key of acceptedKeys) {
      if (!acceptedAnnotationKeysRef.current.has(key)) {
        acceptedAnnotationKeysRef.current.add(key);
        changed = true;
      }
    }
    return changed;
  }

  function handleInput() {
    const editor = editorRef.current;
    rememberAcceptedAnnotationKeys(acceptEditedSuggestionAnnotations(editor));
    const next = clinicalTextFromEditor(editor);
    onChange(next);
  }

  function handleBlur() {
    const editor = editorRef.current;
    const changed = rememberAcceptedAnnotationKeys(acceptEditedSuggestionAnnotations(editor));
    if (editor) {
      const next = clinicalTextFromEditor(editor);
      if (next !== String(value || "")) {
        onChange(next);
      }
    }
    if (changed) {
      setAcceptedAnnotationVersion((current) => current + 1);
    }
  }

  function handleCompositionStart() {
    isComposingRef.current = true;
  }

  function handleCompositionEnd() {
    isComposingRef.current = false;
    handleInput();
  }

  function handlePaste(event) {
    const plainText = event.clipboardData?.getData("text/plain");
    if (!plainText) {
      return;
    }
    event.preventDefault();
    document.execCommand("insertText", false, plainText);
  }

  return (
    <div className="clinical-text-editor">
      <div
        aria-label="カルテの内容"
        className="clinical-text-editable"
        contentEditable
        data-placeholder="S/O/A/Pや診療メモをそのまま貼り付けてください。"
        onBlur={handleBlur}
        onCompositionEnd={handleCompositionEnd}
        onCompositionStart={handleCompositionStart}
        onInput={handleInput}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
        tabIndex={0}
      />
    </div>
  );
}

function normalizeEditableClinicalText(value = "") {
  return String(value || "").replace(/\u00a0/gu, " ").replace(/\n$/u, "");
}

function clinicalTextFromEditor(editor) {
  if (!editor) {
    return "";
  }
  const clone = editor.cloneNode(true);
  clone.querySelectorAll?.("[data-clinical-annotation-status='suggestion']").forEach((node) => node.remove());
  return normalizeEditableClinicalText(clone.innerText || clone.textContent || "");
}

function renderClinicalTextEditorHtml(value = "", annotations = [], options = {}) {
  const clinicalText = String(value || "");
  if (!clinicalText) {
    return "";
  }
  const suppressedAnnotationKeys = options.suppressedAnnotationKeys instanceof Set
    ? options.suppressedAnnotationKeys
    : new Set();
  const inlineAnnotations = annotations
    .map((annotation) => resolveClinicalInlineAnnotation(annotation, clinicalText))
    .filter((annotation) => annotation?.inlineText && !suppressedAnnotationKeys.has(annotation.key));
  const placements = clinicalInlineAnnotationPlacements(clinicalText, inlineAnnotations);
  if (!placements.length) {
    return escapeHtml(clinicalText);
  }
  const placementMap = new Map();
  for (const placement of placements) {
    const list = placementMap.get(placement.index) || [];
    list.push(placement);
    placementMap.set(placement.index, list);
  }
  let html = "";
  for (let index = 0; index <= clinicalText.length; index += 1) {
    if (index > 0) {
      html += escapeHtml(clinicalText[index - 1]);
    }
    const list = placementMap.get(index);
    if (list?.length) {
      for (const placement of list) {
        html += `<span class="clinical-text-inline-annotation" data-clinical-annotation="true" data-clinical-annotation-key="${escapeHtml(placement.key)}" data-clinical-annotation-original="${escapeHtml(placement.text)}" data-clinical-annotation-status="suggestion"> ${escapeHtml(placement.text)}</span>`;
      }
    }
  }
  return html;
}

function acceptEditedSuggestionAnnotations(editor) {
  if (!editor) {
    return [];
  }
  const acceptedKeys = [];
  editor.querySelectorAll?.("[data-clinical-annotation-status='suggestion']").forEach((span) => {
    const original = normalizeAnnotationInlineText(span.getAttribute("data-clinical-annotation-original") || "");
    const current = normalizeAnnotationInlineText(span.textContent || "");
    if (original && current && original !== current) {
      const key = acceptSuggestionAnnotationSpan(span);
      if (key) acceptedKeys.push(key);
    }
  });
  return acceptedKeys;
}

function acceptSuggestionAnnotationSpan(span) {
  const key = String(span?.getAttribute?.("data-clinical-annotation-key") || "").trim();
  span?.setAttribute?.("data-clinical-annotation-status", "accepted");
  span?.classList?.remove("clinical-text-inline-annotation");
  return key;
}

function normalizeAnnotationInlineText(value = "") {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function resolveClinicalInlineAnnotation(annotation = {}, clinicalText = "") {
  if (annotation.inlineKind === "same_day_wound_treatment") {
    return {
      ...annotation,
      inlineText: sameDayWoundTreatmentInlineText(clinicalText) || annotation.inlineText
    };
  }
  return annotation;
}

function sameDayWoundTreatmentInlineText(clinicalText = "") {
  const details = woundTreatmentDetailsFromClinicalText(clinicalText);
  if (details.length >= 2) {
    return `${details.join("、")}。別部位としてそれぞれ処置。`;
  }
  if (details.length === 1) {
    return `${details[0]}。別部位・別創傷として処置した場合は部位、面積、処置内容を追記。`;
  }
  return "";
}

function woundTreatmentDetailsFromClinicalText(clinicalText = "") {
  const candidates = indexedClinicalSentences(clinicalText)
    .flatMap((sentence, sentenceIndex) => woundDetailCandidatesFromSentence(sentence.text, sentence.start + sentenceIndex / 100));
  const bestByKey = new Map();
  for (const candidate of candidates) {
    const current = bestByKey.get(candidate.key);
    if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.text.length > current.text.length)) {
      bestByKey.set(candidate.key, candidate);
    }
  }
  return [...bestByKey.values()]
    .sort((left, right) => left.order - right.order)
    .slice(0, 3)
    .map((candidate) => candidate.text);
}

function woundDetailCandidatesFromSentence(sentence = "", order = 0) {
  const text = String(sentence || "").replace(/\s+/gu, " ").trim();
  if (!/(熱傷|やけど|創傷|擦過創|切創|裂創|挫創)/u.test(text)) {
    return [];
  }
  const candidates = [];
  const woundTypePattern = /((?:(?:[IVXⅠⅡⅢⅣⅤ]+|[1-5])度?)?熱傷|やけど|創傷|擦過創|切創|裂創|挫創)/gu;
  for (const match of text.matchAll(woundTypePattern)) {
    const typeStart = match.index ?? 0;
    const typeEnd = typeStart + String(match[0] || "").length;
    if (isProcedureOnlyWoundTerm(text, typeStart, typeEnd)) {
      continue;
    }
    const context = woundContextAroundType(text, typeStart, typeEnd);
    const site = woundSiteBeforeType(context.before);
    const area = woundAreaFromContext(context.full);
    const type = normalizeWoundType(match[1], context.after);
    if (!site && !area) {
      continue;
    }
    const display = woundDetailDisplayText({ site, type, area });
    if (!display) {
      continue;
    }
    candidates.push({
      key: woundDetailKey(site, type),
      order: order + typeStart / 100000,
      score: woundDetailSpecificityScore({ sentence: text, site, type, area }),
      text: display
    });
  }
  return candidates;
}

function isProcedureOnlyWoundTerm(text = "", start = 0, end = 0) {
  const after = String(text || "").slice(end, end + 4);
  const before = String(text || "").slice(Math.max(0, start - 4), start);
  return /^(?:処置|処理|手術|術)/u.test(after) && !/(右|左|部|面|側)$/u.test(before);
}

function woundContextAroundType(sentence = "", start = 0, end = 0) {
  const text = String(sentence || "");
  const beforeDelimiter = Math.max(
    text.lastIndexOf("。", start),
    text.lastIndexOf("、", start),
    text.lastIndexOf("；", start),
    text.lastIndexOf(";", start),
    text.lastIndexOf("\n", start)
  );
  const afterPunctuation = ["。", "、", "；", ";", "\n"]
    .map((char) => text.indexOf(char, end))
    .filter((index) => index >= 0);
  const afterDelimiter = afterPunctuation.length ? Math.min(...afterPunctuation) : text.length;
  const contextStart = Math.max(0, beforeDelimiter + 1);
  const contextEnd = Math.min(text.length, Math.max(afterDelimiter, end + 24));
  return {
    before: text.slice(contextStart, start),
    after: text.slice(end, contextEnd),
    full: text.slice(contextStart, contextEnd)
  };
}

function woundSiteBeforeType(value = "") {
  let text = String(value || "")
    .replace(/^[SOAＰP]\s*[：:]/u, "")
    .replace(/(?:当日|本日|同時に|同時|また|さらに|加えて|および|及び|ならびに|並びに)/gu, "")
    .replace(/[（）()]/gu, " ")
    .replace(/\s+/gu, "")
    .replace(/[にのをへで]+$/u, "")
    .trim();
  if (!text) {
    return "";
  }
  if (/(右|左)/u.test(text)) {
    text = text.replace(/^.*?(右|左)/u, "$1");
  }
  const siteMatch = text.match(/((?:右|左)?[一-龥ァ-ヶーA-Za-z0-9]*(?:前腕|上腕|下腿|大腿|手指|足趾|手背|足背|手掌|足底|膝|肘|肩|頬|額|顔面|頭部|胸部|腹部|背部|臀部|体幹|指|趾|腕|脚|足|手|部)(?:前面|後面|内側|外側|部)?)/u);
  return (siteMatch?.[1] || text)
    .replace(/[にのをへで]+$/u, "")
    .trim();
}

function woundAreaFromContext(value = "") {
  const text = String(value || "");
  const match = text.match(/(?:範囲|大きさ|サイズ)?\s*(?:約)?\s*(\d+(?:\.\d+)?\s*(?:cm²|cm2|㎠|平方cm)|\d+(?:\.\d+)?\s*[×xX]\s*\d+(?:\.\d+)?\s*(?:cm²|cm2|㎠|平方cm|cm)?)/u);
  if (!match) {
    return "";
  }
  return String(match[1] || "")
    .replace(/\s+/gu, "")
    .replace(/cm2/giu, "cm²")
    .replace(/㎠|平方cm/gu, "cm²")
    .replace(/x/gu, "×")
    .replace(/X/gu, "×")
    .trim();
}

function normalizeWoundType(type = "", after = "") {
  const text = String(type || "").replace(/\s+/gu, "").trim();
  if (text === "熱傷") {
    const degree = String(after || "").match(/[（(]?\s*((?:[IVXⅠⅡⅢⅣⅤ]+|[1-5])度)/u)?.[1];
    return degree ? `${degree}熱傷` : text;
  }
  if (/^(?:[IVXⅠⅡⅢⅣⅤ]+|[1-5])熱傷$/u.test(text)) {
    return text.replace(/熱傷$/u, "度熱傷");
  }
  return text;
}

function woundDetailDisplayText({ site = "", type = "", area = "" } = {}) {
  const body = `${site}${type}`.replace(/\s+/gu, "").trim();
  if (!body) {
    return "";
  }
  return area ? `${body} ${area}` : body;
}

function woundDetailSpecificityScore({ sentence = "", site = "", type = "", area = "" } = {}) {
  let score = 0;
  if (site) score += 20;
  if (/(右|左)/u.test(site)) score += 8;
  if (area) score += 30;
  if (/(?:[IVXⅠⅡⅢⅣⅤ]+|[1-5])度/u.test(type)) score += 12;
  if (/擦過創|切創|裂創|挫創/u.test(type)) score += 10;
  if (/処置|施行|洗浄|塗布|被覆|保護/u.test(sentence)) score += 6;
  if (/やけど/u.test(type)) score -= 8;
  if (/既往|前回|初回処置済み|受傷後|経過/u.test(sentence) && !area) score -= 5;
  return score;
}

function woundDetailKey(site = "", type = "") {
  const normalizedSite = normalizeSearchText(site);
  const side = String(site || "").match(/[右左]/u)?.[0] || "";
  const region = [
    "前腕", "上腕", "下腿", "大腿", "手指", "足趾", "手背", "足背", "手掌", "足底",
    "顔面", "頭部", "胸部", "腹部", "背部", "臀部", "体幹", "膝", "肘", "肩", "頬", "額", "指", "趾", "腕", "脚", "足", "手"
  ].find((candidate) => normalizedSite.includes(normalizeSearchText(candidate))) || normalizedSite;
  const family = /熱傷|やけど/u.test(type) ? "burn" : "wound";
  return `${family}:${side}:${region}`;
}

function clinicalInlineAnnotationPlacements(clinicalText = "", annotations = []) {
  const occupied = new Set();
  return annotations
    .map((annotation) => {
      const index = clinicalInlineAnnotationIndex(clinicalText, annotation);
      if (index < 0 || occupied.has(index)) {
        return null;
      }
      occupied.add(index);
      return {
        index,
        key: annotation.key,
        text: annotation.inlineText
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index);
}

function clinicalInlineAnnotationIndex(clinicalText = "", annotation = {}) {
  if (annotation.inlineKind === "same_day_wound_treatment") {
    const treatmentIndex = sameDayWoundTreatmentAnnotationIndex(clinicalText, annotation);
    if (treatmentIndex >= 0) {
      return treatmentIndex;
    }
  }
  const targets = annotationTargetCandidates(annotation);
  if (!targets.length) {
    return -1;
  }
  const lines = indexedTextLines(clinicalText);
  let best = null;
  for (const line of lines) {
    for (const target of targets) {
      const match = normalizedIndexOf(line.text, target);
      if (!match) {
        continue;
      }
      const endIndex = extendMedicationInsertionIndex(clinicalText, line.start + match.end);
      const score = clinicalAnnotationLineScore(line.text, match.text);
      if (!best || score > best.score || (score === best.score && endIndex < best.index)) {
        best = { index: endIndex, score };
      }
    }
  }
  return best?.index ?? -1;
}

function sameDayWoundTreatmentAnnotationIndex(clinicalText = "", annotation = {}) {
  const targets = annotationTargetCandidates(annotation);
  const sentences = indexedClinicalSentences(clinicalText);
  let best = null;
  for (const sentence of sentences) {
    const score = sameDayWoundTreatmentSentenceScore(sentence.text, targets);
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score || (score === best.score && sentence.end < best.index)) {
      best = {
        index: sentence.end,
        score
      };
    }
  }
  return best?.index ?? -1;
}

function sameDayWoundTreatmentSentenceScore(sentence = "", targets = []) {
  const text = String(sentence || "");
  const normalized = normalizeSearchText(text);
  const targetMatched = targets.some((target) => normalized.includes(normalizeSearchText(target)));
  const hasWoundContext = /(熱傷|やけど|創傷|擦過創|切創|裂創|挫創|潰瘍)/u.test(text);
  const hasTreatmentAction = /(処置|施行|洗浄|軟膏塗布|塗布|被覆|保護|デブリードマン|創処置)/u.test(text);
  if (!targetMatched && !(hasWoundContext && hasTreatmentAction)) {
    return 0;
  }
  let score = 0;
  if (targetMatched) score += 40;
  if (hasWoundContext) score += 18;
  if (hasTreatmentAction) score += 18;
  if (/当日|本日|同時|同日|別部位|別創傷/u.test(text)) score += 8;
  if (/洗浄|被覆|軟膏塗布|塗布/u.test(text)) score += 6;
  return score;
}

function indexedClinicalSentences(value = "") {
  const text = String(value || "");
  const sentences = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextTwo = text.slice(index + 1, index + 3);
    const isSentenceEnd = /[。；;]/u.test(char)
      || char === "\n"
      || (/^[A-ZＡ-Ｚ][：:]/u.test(nextTwo) && index > start);
    if (!isSentenceEnd) {
      continue;
    }
    const end = char === "\n" ? index : index + 1;
    const sentence = text.slice(start, end);
    if (sentence.trim()) {
      sentences.push({ text: sentence, start, end });
    }
    start = char === "\n" ? index + 1 : index + 1;
  }
  if (start < text.length) {
    const sentence = text.slice(start);
    if (sentence.trim()) {
      sentences.push({ text: sentence, start, end: text.length });
    }
  }
  return sentences;
}

function annotationTargetCandidates(annotation = {}) {
  const candidates = [
    annotation.targetText,
    annotation.title,
    annotation.text
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const expanded = [];
  for (const candidate of candidates) {
    const withoutConfirm = candidate.replace(/の確認$/u, "").trim();
    expanded.push(withoutConfirm);
    expanded.push(withoutConfirm.replace(/(OD)?錠|カプセル|散|細粒|顆粒|シロップ|液|坐剤$/u, "").trim());
  }
  return [...new Set(expanded.map((value) => value.trim()).filter((value) => value.length >= 2))]
    .sort((left, right) => right.length - left.length);
}

function indexedTextLines(value = "") {
  const lines = [];
  let start = 0;
  for (const part of String(value || "").split(/(\n)/u)) {
    if (part === "\n") {
      start += 1;
      continue;
    }
    lines.push({ text: part, start });
    start += part.length;
  }
  return lines.length ? lines : [{ text: String(value || ""), start: 0 }];
}

function normalizedIndexOf(source = "", target = "") {
  const sourceMap = normalizedSearchTextWithMap(source);
  const normalizedTarget = normalizeSearchText(target);
  if (!normalizedTarget) {
    return null;
  }
  const start = sourceMap.text.indexOf(normalizedTarget);
  if (start < 0) {
    return null;
  }
  const endNormalizedIndex = start + normalizedTarget.length - 1;
  return {
    start: sourceMap.map[start] ?? 0,
    end: (sourceMap.map[endNormalizedIndex] ?? 0) + 1,
    text: target
  };
}

function normalizedSearchTextWithMap(value = "") {
  let text = "";
  const map = [];
  Array.from(String(value || "")).forEach((char, index) => {
    const normalized = normalizeSearchText(char);
    text += normalized;
    for (let offset = 0; offset < normalized.length; offset += 1) {
      map.push(index);
    }
  });
  return { text, map };
}

function normalizeSearchText(value = "") {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function extendMedicationInsertionIndex(text = "", index = 0) {
  let nextIndex = index;
  while (/[）)\]】」』]/u.test(String(text[nextIndex] || ""))) {
    nextIndex += 1;
  }
  return nextIndex;
}

function clinicalAnnotationLineScore(line = "", target = "") {
  let score = 0;
  if (/\bP\s*[：:]/u.test(line) || /^P\s*[：:]/u.test(line.trim())) {
    score += 20;
  }
  if (/院内処方|院外処方|処方|投薬|内服|頓用|薬剤/u.test(line)) {
    score += 10;
  }
  score += Math.min(5, String(target || "").length / 4);
  return score;
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function WorkPane({
  activeMainTab,
  calculation,
  candidateWorkbench,
  disabled,
  feeSession,
  onCopyReceipt,
  onDownloadCsv,
  onDownloadUke,
  onDecision,
  onOpenDetail,
  onOpenManualItem,
  onRemoveManualOrder,
  onSetMainTab,
  orderRows = [],
  receiptDraft,
  selected
}) {
  return (
    <section className="fee-work-pane" aria-label="算定作業とレセプト案">
      <div className="fee-main-tabs" role="tablist" aria-label="算定画面">
        <TabButton active={activeMainTab === "work"} onClick={() => onSetMainTab("work")}>算定作業</TabButton>
        <TabButton active={activeMainTab === "receipt"} onClick={() => onSetMainTab("receipt")}>レセプト案</TabButton>
      </div>
      <div className="fee-work-pane-body">
        {activeMainTab === "work" ? (
          <CandidateWorkbench
            calculation={calculation}
            disabled={disabled}
            feeSession={feeSession}
            onDecision={onDecision}
            onOpenManualItem={onOpenManualItem}
            onOpenDetail={onOpenDetail}
            candidateWorkbench={candidateWorkbench}
          />
        ) : (
          <ReceiptDraftPane
            disabled={disabled}
            feeSession={feeSession}
            onCopyReceipt={onCopyReceipt}
            onDownloadCsv={onDownloadCsv}
            onDownloadUke={onDownloadUke}
            onOpenManualItem={onOpenManualItem}
            onRemoveManualOrder={onRemoveManualOrder}
            orderRows={orderRows}
            receiptDraft={receiptDraft}
            selected={selected}
          />
        )}
      </div>
    </section>
  );
}

function TabButton({ active, children, count, onClick }) {
  return (
    <button className={`fee-tab-button ${active ? "is-active" : ""}`} onClick={onClick} role="tab" type="button">
      <span>{children}</span>
      {typeof count === "number" ? <strong>{count.toLocaleString()}</strong> : null}
    </button>
  );
}

function FeeInputSummary({ departments, form, onOpenConditions, onOpenOrders, orderCount }) {
  const department = departments.find((item) => item.departmentId === form.departmentId);
  const diagnosisCount = form.diagnosesText.split(/\n+/u).map((item) => item.trim()).filter(Boolean).length;
  return (
    <section className="fee-subsection fee-input-summary">
      <div className="fee-subsection-head">
        <div>
          <span className="label">自動補完</span>
          <h3>算定条件と手動オーダー</h3>
        </div>
      </div>
      <div className="fee-input-summary-grid">
        <div>
          <span>診療科</span>
          <strong>{department?.displayName || "未指定"}</strong>
        </div>
        <div>
          <span>区分</span>
          <strong>{form.setting === "inpatient" ? "入院（限定対応）" : "外来"}</strong>
        </div>
        <div>
          <span>診療日</span>
          <strong>{form.serviceDate || "未設定"}</strong>
        </div>
        <div>
          <span>請求月</span>
          <strong>{form.claimMonth || "未設定"}</strong>
        </div>
        <div>
          <span>病名</span>
          <strong>{diagnosisCount ? `${diagnosisCount.toLocaleString()}件` : "自動補完"}</strong>
        </div>
        <div>
          <span>手入力オーダー</span>
          <strong>{orderCount.toLocaleString()}件</strong>
        </div>
      </div>
      <div className="button-row">
        <button className="btn btn--ghost" onClick={onOpenConditions} type="button">算定条件を確認</button>
        <button className="btn btn--ghost" onClick={onOpenOrders} type="button">オーダーを確認</button>
      </div>
    </section>
  );
}

function FeeSettingsModal({
  available,
  busy = false,
  defaultFacilityId,
  departments,
  facilities,
  form,
  handleMasterSearchKeyDown,
  items,
  masterQuery,
  masterType,
  mode,
  onAddMaster,
  onAddOrderRow,
  onApplyOrders,
  onClose,
  onMasterQueryChange,
  onMasterTypeChange,
  onRemoveOrderRow,
  onUpdateOutpatientBasicKind,
  onUpdateForm,
  onUpdateOrderRow,
  orderCount,
  orderRows,
  selectedMasterIndex
}) {
  if (!mode) {
    return null;
  }
  const showConditions = mode === "conditions";
  const selectedFacility = facilities.find((facility) => facility.facilityId === (form.facilityId || defaultFacilityId));
  const outpatientBasicKind = outpatientBasicKindFromOptionsText(form.calculationOptionsText);
  return (
    <div className="fee-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section className="fee-modal-card fee-settings-modal" role="dialog" aria-modal="true" aria-label={showConditions ? "算定条件の確認" : "オーダーの確認"} onMouseDown={(event) => event.stopPropagation()}>
        <header className="fee-modal-head">
          <div>
            <span className="label">{showConditions ? "算定条件" : "オーダー"}</span>
            <h2>{showConditions ? "算定条件を確認" : "オーダーを確認"}</h2>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose} type="button" aria-label="閉じる">×</button>
        </header>
        <div className="fee-modal-body">
          {showConditions ? (
            <div className="fee-settings-section">
              <MasterStatus available={available} />
              <div className="fee-form-grid fee-form-grid--conditions">
                {facilities.length > 1 ? (
                  <label>
                    <span>施設</span>
                    <AdminSelect
                      ariaLabel="施設"
                      options={[
                        { value: "", label: "施設を選択" },
                        ...facilities.map((facility) => ({
                          value: facility.facilityId,
                          label: facility.displayName || "施設名未設定",
                          description: facility.medicalInstitutionCode || "医療機関コード未設定"
                        }))
                      ]}
                      value={form.facilityId || defaultFacilityId}
                      onValueChange={(value) => onUpdateForm("facilityId", value)}
                    />
                  </label>
                ) : (
                  <div className="source-static-field">
                    <span>施設</span>
                    <strong>{selectedFacility?.displayName || "未設定"}</strong>
                  </div>
                )}
                <label>
                  <span>診療科</span>
                  <AdminSelect
                    ariaLabel="診療科"
                    options={[
                      { value: "", label: "未指定" },
                      ...departments.map((department) => ({
                        value: department.departmentId,
                        label: department.displayName || "名称未設定"
                      }))
                    ]}
                    value={form.departmentId}
                    onValueChange={(value) => onUpdateForm("departmentId", value)}
                  />
                </label>
                <label>
                  <span>区分</span>
                  <AdminSelect
                    ariaLabel="区分"
                    options={[
                      { value: "outpatient", label: "外来" },
                      { value: "inpatient", label: "入院（限定対応）" }
                    ]}
                    value={form.setting}
                    onValueChange={(value) => onUpdateForm("setting", value)}
                  />
                </label>
                <label>
                  <span>初診/再診</span>
                  <AdminSelect
                    ariaLabel="初診/再診"
                    options={[
                      { value: "", label: "自動判定" },
                      { value: "initial", label: "初診料" },
                      { value: "revisit", label: "再診料" }
                    ]}
                    value={outpatientBasicKind}
                    onValueChange={onUpdateOutpatientBasicKind}
                  />
                </label>
                <label>
                  <span>診療日</span>
                  <input type="date" value={form.serviceDate} onChange={(event) => onUpdateForm("serviceDate", event.target.value)} />
                </label>
                <label>
                  <span>請求月</span>
                  <input type="month" value={form.claimMonth} onChange={(event) => onUpdateForm("claimMonth", event.target.value)} />
                </label>
              </div>
            </div>
          ) : (
            <div className="fee-settings-section">
              <div className="fee-section-head">
                <div>
                  <h3>候補を確認・編集</h3>
                  <p>カルテ本文から候補を補完します。必要な場合だけマスター検索または表で修正してください。</p>
                </div>
                <span className="fee-count">手入力 {orderCount.toLocaleString()}件</span>
              </div>
              <div className="master-search-panel master-search-panel--command">
                <div className="master-search-controls">
                  <AdminSelect
                    ariaLabel="マスター種別"
                    disabled={!available}
                    options={MASTER_TYPES.map(([value, label]) => ({ value, label }))}
                    value={masterType}
                    onValueChange={onMasterTypeChange}
                  />
                  <input
                    type="search"
                    placeholder={available ? "名称またはコードで検索" : "マスター検索APIの反映待ちです"}
                    value={masterQuery}
                    onChange={(event) => onMasterQueryChange(event.target.value)}
                    onKeyDown={handleMasterSearchKeyDown}
                    disabled={!available}
                  />
                </div>
                <MasterSearchResults
                  available={available}
                  items={items}
                  query={masterQuery}
                  onAdd={onAddMaster}
                  selectedIndex={selectedMasterIndex}
                />
              </div>
              <OrderEditor rows={orderRows} onAdd={onAddOrderRow} onRemove={onRemoveOrderRow} onUpdate={onUpdateOrderRow} />
            </div>
          )}
        </div>
        <footer className="fee-modal-footer">
          {showConditions ? (
            <button className="btn btn--primary" onClick={onClose} type="button">閉じる</button>
          ) : (
            <>
              <button className="btn btn--ghost" disabled={busy} onClick={onClose} type="button">閉じる</button>
              <button className="btn btn--primary" disabled={busy} onClick={onApplyOrders} type="button">保存して再計算</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function PatientPicker({ filteredPatients, isOpen, onFilterChange, onOpenChange, onSelect, patientFilter, searchLoading, searchReady, selectedPatient }) {
  const pickerRef = useRef(null);
  const selectedLabel = selectedPatient
    ? selectedPatient.displayName || "患者名未入力"
    : "患者を選択";
  const hasQuery = Boolean(patientFilter.trim());

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      const root = pickerRef.current;
      if (!root || root.contains(event.target)) {
        return;
      }
      onOpenChange(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onOpenChange]);

  return (
    <div className="patient-picker-field" ref={pickerRef}>
      <span className="field-label">患者</span>
      <button
        className={`patient-chip ${selectedPatient ? "is-selected" : ""}`}
        onClick={() => onOpenChange(!isOpen)}
        type="button"
      >
        <span>{selectedLabel}</span>
        <small>{selectedPatient ? "変更" : "検索して選択"}</small>
      </button>
      {isOpen ? (
        <div className="patient-popover" role="dialog" aria-label="患者検索">
          <label>
            <span>患者検索</span>
            <input
              autoFocus
              placeholder="氏名・患者番号で検索"
              value={patientFilter}
              onChange={(event) => onFilterChange(event.target.value)}
            />
          </label>
          {!searchReady ? (
            <div className="patient-search-status">氏名は2文字以上、患者番号は1文字以上入力すると検索できます。</div>
          ) : searchLoading && filteredPatients.length ? (
            <div className="patient-search-status">検索結果を更新中です。</div>
          ) : null}
          <div className="patient-result-list">
            {filteredPatients.length ? filteredPatients.map((patient) => (
              <button
                className="patient-result"
                key={patient.patientId}
                onClick={() => onSelect(patient.patientId)}
                type="button"
              >
                <strong>{patient.displayName || "患者名未入力"}</strong>
                <small>{patient.patientCode || patient.primaryPatientNumber || patient.externalPatientIds?.[0] || patient.patientId}</small>
              </button>
            )) : (
              <div className="fee-empty-state">
                {searchLoading
                  ? "患者を検索しています。"
                  : !searchReady
                    ? "氏名は2文字以上、患者番号は1文字以上入力すると検索できます。"
                    : hasQuery
                      ? "一致する患者はいません。"
                      : "最近更新された患者はありません。"}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PatientCreateForm({ disabled, onSubmit, patient, setPatient }) {
  const [isOpen, setIsOpen] = useState(false);
  async function handleSubmit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!formElement.checkValidity()) {
      formElement.reportValidity();
      return;
    }
    await onSubmit(event);
    setIsOpen(false);
  }

  return (
    <div className="patient-inline-create">
      <button className="btn btn--ghost" disabled={disabled} onClick={() => setIsOpen(true)} type="button">
        ＋ 患者追加
      </button>
      {isOpen ? (
        <div className="fee-modal-overlay" role="presentation" onMouseDown={() => setIsOpen(false)}>
          <section className="fee-modal-card patient-create-modal" role="dialog" aria-modal="true" aria-label="患者追加" onMouseDown={(event) => event.stopPropagation()}>
            <header className="fee-modal-head">
              <div>
                <span className="label">患者</span>
                <h2>患者を追加</h2>
              </div>
              <button className="btn btn--ghost btn--icon" onClick={() => setIsOpen(false)} type="button" aria-label="閉じる">×</button>
            </header>
            <form className="patient-create-form" onSubmit={handleSubmit}>
              <label>
                <span>氏名</span>
                <input
                  required
                  value={patient.displayName}
                  onChange={(event) => setPatient((current) => ({ ...current, displayName: event.target.value }))}
                />
              </label>
              <div className="fee-form-grid fee-form-grid--two">
                <label>
                  <span>生年月日</span>
                  <input
                    type="date"
                    value={patient.birthDate}
                    onChange={(event) => setPatient((current) => ({ ...current, birthDate: event.target.value }))}
                  />
                </label>
                <label>
                  <span>性別</span>
                  <AdminSelect
                    ariaLabel="性別"
                    options={[
                      { value: "unknown", label: "不明" },
                      { value: "male", label: "男性" },
                      { value: "female", label: "女性" },
                      { value: "other", label: "その他" }
                    ]}
                    value={patient.sex}
                    onValueChange={(value) => setPatient((current) => ({ ...current, sex: value }))}
                  />
                </label>
              </div>
              <label>
                <span>患者番号</span>
                <input
                  placeholder="例: legacy-001"
                  value={patient.patientRef}
                  onChange={(event) => setPatient((current) => ({ ...current, patientRef: event.target.value }))}
                />
              </label>
              <footer className="fee-modal-footer">
                <button className="btn btn--ghost" onClick={() => setIsOpen(false)} type="button">閉じる</button>
                <button className="btn btn--primary" disabled={disabled} type="submit">患者を追加</button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function MasterStatus({ available }) {
  if (available) {
    return null;
  }
  return <div className="master-status">マスター検索APIの反映待ちです。通常の算定入力は利用できます。</div>;
}

function MasterSearchResults({ actionLabel = "", available, items, onAdd, query, selectedIndex = 0 }) {
  if (!available) {
    return <div className="master-search-results">API反映後にマスター検索を利用できます。</div>;
  }
  if (query.trim().length < 2) {
    return <div className="master-search-results">2文字以上入力するとマスターを検索できます。</div>;
  }
  if (!items.length) {
    return <div className="master-search-results">該当するマスターはありません。</div>;
  }
  return (
    <div className="master-search-results">
      {items.map((item, index) => (
        <article className={`master-search-result ${index === selectedIndex ? "is-selected" : ""}`} key={`${item.kind || "master"}-${item.code || index}`}>
          <div>
            <strong>{item.name || item.code || "名称未設定"}</strong>
            <small>{masterKindLabel(item.kind)} / {item.code || ""}{item.points !== undefined ? ` / ${Number(item.points).toLocaleString()}点` : ""}{item.unitAmountYen !== undefined ? ` / ${Number(item.unitAmountYen).toLocaleString()}円` : ""}</small>
            <small>{masterSourceLabel(item)}</small>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => onAdd(item)} type="button">
            {actionLabel || (item.kind === "comment" ? "コメントに追加" : "オーダーに追加")}
          </button>
        </article>
      ))}
    </div>
  );
}

function OrderEditor({ onAdd, onRemove, onUpdate, rows }) {
  return (
    <div className="order-editor">
      {rows.map((row, index) => (
        <div className="order-editor-row" key={index}>
          <label>
            <span>種別</span>
            <AdminSelect
              ariaLabel="オーダー種別"
              options={ORDER_TYPE_OPTIONS.map(([value, label]) => ({ value, label }))}
              value={row.orderType}
              onValueChange={(value) => onUpdate(index, "orderType", value)}
            />
          </label>
          <label>
            <span>名称</span>
            <input value={row.localName} onChange={(event) => onUpdate(index, "localName", event.target.value)} placeholder="例: 血液検査" />
          </label>
          <label>
            <span>標準コード</span>
            <input value={row.standardCode} onChange={(event) => onUpdate(index, "standardCode", event.target.value)} placeholder="任意" />
          </label>
          <label>
            <span>数量</span>
            <input inputMode="decimal" value={row.quantity} onChange={(event) => onUpdate(index, "quantity", event.target.value)} />
          </label>
          <button className="btn btn--ghost btn--icon" onClick={() => onRemove(index)} type="button" aria-label="オーダー行を削除">
            削除
          </button>
        </div>
      ))}
      <button className="btn btn--ghost btn--sm" onClick={onAdd} type="button">オーダー行を追加</button>
    </div>
  );
}

function CandidateWorkbench({ calculation, candidateWorkbench, disabled, feeSession, onDecision, onOpenManualItem, onOpenDetail }) {
  if (feeSession?.status === "calculating") {
    return (
      <div className="result result-empty">
        <div className="calculation-waiting-card" role="status" aria-live="polite">
          <strong>カルテ本文を読み取り算定中</strong>
          <p>候補化が完了すると、算定候補と不足情報を更新します。</p>
          <div className="calculation-waiting-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    );
  }

  if (!calculation) {
    return (
      <div className="result result-empty">
        <div className="fee-section-head">
          <div>
            <h2>算定候補</h2>
            <p>患者とカルテ本文を確認し、「カルテから算定候補を作成」で候補を作成してください。</p>
          </div>
        </div>
      </div>
    );
  }

  const model = normalizeCandidateWorkbenchModel(
    candidateWorkbench || emptyCandidateWorkbenchModel({ calculation })
  );
  const includedCount = model.includedLines.length;
  const proposalCount = model.proposals.length;
  const issueCount = model.issues.length + model.pendingLines.length;
  const candidateCount = includedCount + proposalCount + issueCount;
  const potentialPointsTotal = Number(model.potentialPointsTotal || 0);
  const coverageSummary = model.coverageSummary || {};
  return (
    <div className="candidate-workbench">
      <div className="candidate-summary">
        <div className="candidate-total">
          <span>{coverageSummary.title || "候補化済み部分合計"}</span>
          <strong>{Number(model.includedTotalPoints || 0).toLocaleString()}点</strong>
        </div>
        <div className="candidate-summary-grid">
          <div><span>算定候補</span><strong>{candidateCount.toLocaleString()}件</strong></div>
          <div><span>不足情報</span><strong>{issueCount.toLocaleString()}件</strong></div>
          <div><span>増点余地</span><strong>{potentialPointsTotal > 0 ? `+${potentialPointsTotal.toLocaleString()}点` : `${proposalCount.toLocaleString()}件`}</strong></div>
        </div>
      </div>

      <section className="candidate-bucket">
        <BucketHeader
          action={(
            <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={onOpenManualItem} type="button">
              明細を追加
            </button>
          )}
          title="算定候補"
          note="点数に入っている明細と、条件確認で採用できる提案を表示します。未実施・否定・他院・過去情報は表示しません。"
        />
        {model.includedLines.length ? (
          <div className="candidate-line-list">
            {model.includedLines.map((line) => (
              <CandidateLineRow disabled={disabled} item={line} key={line.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : null}
        {model.proposals.length ? (
          <div className="proposal-list">
            {model.proposals.map((item) => (
              <ProposalLineRow disabled={disabled} item={item} key={item.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : null}
        {model.pendingLines.length ? (
          <div className="candidate-line-list candidate-line-list--review">
            {model.pendingLines.map((line) => (
              <CandidateLineRow disabled={disabled} item={line} key={line.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : null}
        {!model.includedLines.length && !model.proposals.length && !model.issues.length && !model.pendingLines.length ? <p className="field-note">算定候補はまだありません。</p> : null}
      </section>

      <TaskInbox items={model.issues} onOpenDetail={onOpenDetail} />
    </div>
  );
}

function BucketHeader({ action = null, count, note, title }) {
  return (
    <header className="candidate-bucket-head">
      <div>
        <h3>{title}</h3>
        <p>{note}</p>
      </div>
      <div className="candidate-bucket-head-actions">
        {typeof count === "number" ? <span>{count.toLocaleString()}件</span> : null}
        {action}
      </div>
    </header>
  );
}

function ProposalLineRow({ disabled, item, onDecision, onOpenDetail }) {
  const canApprove = canApproveReviewItem(item);
  const decisionStatus = decisionSelectValue(item.decisionStatus);
  const metaLabel = [
    item.code,
    orderTypeLabel(item.orderType || item.candidateLine?.orderType),
    item.issueCategoryLabel
  ].filter(Boolean).join(" / ") || "提案";
  const pointsLabel = item.pointsLabel || (Number(item.potentialPoints || 0) > 0 ? `+${Number(item.potentialPoints || 0).toLocaleString()}点` : "点数確認");
  return (
    <article className={`candidate-line-row candidate-line-row--proposal ${canApprove ? "" : "candidate-line-row--confirm-required"}`}>
      <div className="candidate-line-action">
        <CandidateDecisionToggle
          ariaLabel={`${item.displayTitle || "提案"}の採否`}
          disabled={disabled || !canApprove}
          value={decisionStatus}
          onChange={(value) => onDecision(item.reviewItemId, value, decisionStatus)}
        />
      </div>
      <div className="candidate-line-main">
        <strong>{item.displayTitle}</strong>
        <small>{metaLabel}</small>
      </div>
      <span className="candidate-line-status">{canApprove ? "提案" : "確認必要"}</span>
      <strong className="candidate-line-points">{pointsLabel}</strong>
      <button className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(item)} type="button">詳細</button>
    </article>
  );
}

function CandidateLineRow({ disabled, item, onDecision, onOpenDetail }) {
  const canApprove = canApproveReviewItem(item);
  const decisionStatus = decisionSelectValue(item.decisionStatus);
  return (
    <article className={`candidate-line-row candidate-line-row--${item.inclusionStatus}`}>
      <div className="candidate-line-action">
        <CandidateDecisionToggle
          ariaLabel={`${item.name}の採否`}
          disabled={disabled || !canApprove}
          value={decisionStatus}
          onChange={(value) => onDecision(item.reviewItemId, value, decisionStatus)}
        />
      </div>
      <div className="candidate-line-main">
        <strong>{item.name}</strong>
        <small>{item.metaLabel}</small>
        {Array.isArray(item.attentionNotes) && item.attentionNotes.length ? (
          <div className="candidate-line-notes">
            {item.attentionNotes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </div>
        ) : null}
      </div>
      <strong className="candidate-line-points">{Number(item.totalPoints || 0).toLocaleString()}点</strong>
      <button className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(item)} type="button">詳細</button>
    </article>
  );
}

function CandidateDecisionToggle({ ariaLabel = "採否", disabled = false, onChange, value = "" }) {
  const checked = decisionSelectValue(value) === "approved";
  const nextValue = checked ? "rejected" : "approved";
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`candidate-decision-toggle ${checked ? "candidate-decision-toggle--on" : "candidate-decision-toggle--off"}`}
      disabled={disabled}
      onClick={() => onChange(nextValue)}
      role="switch"
      title={checked ? "クリックすると算定しないに変更します" : "クリックすると算定するに変更します"}
      type="button"
    >
      <span className="candidate-decision-toggle-track" aria-hidden="true">
        <span className="candidate-decision-toggle-knob" />
      </span>
    </button>
  );
}

// 確認事項(不足情報・査定リスク・要確認)を「やること」インボックスとして表示する。
// 1件=1行に圧縮し、詳細は展開ではなくポップアップ(CandidateDetailModal)で開く。
const TASK_SEVERITY_META = {
  action: { rank: 0, label: "要対応", icon: "!" },
  check: { rank: 1, label: "確認", icon: "?" },
  info: { rank: 2, label: "情報", icon: "i" }
};

function taskSeverity(item = {}) {
  if (assessmentRiskForItem(item)) {
    return "action";
  }
  const tone = issueTone(item);
  if (tone === "danger") {
    return "action";
  }
  if (tone === "info" || tone === "neutral") {
    return "info";
  }
  return "check";
}

// CTAは「何をすればいいか」が伝わる動詞にする。押下時はいずれもポップアップを開く。
function taskActionLabel(item = {}) {
  const blob = `${item.displayTitle || ""} ${item.displayReason || ""} ${reviewRequiredInput(item) || ""}`;
  if (/コメント/u.test(blob)) {
    return "理由を記載";
  }
  if (/病名/u.test(blob)) {
    return "病名を確認";
  }
  return taskSeverity(item) === "info" ? "確認する" : "対応する";
}

function TaskInbox({ items = [], onOpenDetail }) {
  const tasks = Array.isArray(items) ? items : [];
  if (!tasks.length) {
    return null;
  }
  const counts = { action: 0, check: 0, info: 0 };
  const sorted = tasks
    .map((item, index) => {
      const severity = taskSeverity(item);
      counts[severity] += 1;
      return { item, severity, index };
    })
    .sort((a, b) => (TASK_SEVERITY_META[a.severity].rank - TASK_SEVERITY_META[b.severity].rank) || (a.index - b.index));
  return (
    <section className="todo-section">
      <header className="todo-head">
        <div>
          <h3>やること</h3>
          <p>確認・対応が必要な項目です。各行のボタンから内容を確認できます。</p>
        </div>
        <div className="todo-counts" role="status" aria-live="polite">
          {(["action", "check", "info"]).map((severity) => (
            counts[severity] ? (
              <span className={`todo-chip todo-chip--${severity}`} key={severity}>
                {TASK_SEVERITY_META[severity].label} {counts[severity]}
              </span>
            ) : null
          ))}
        </div>
      </header>
      <div className="todo-list">
        {sorted.map(({ item, severity }) => (
          <TaskRow item={item} key={item.reviewItemId} onOpenDetail={onOpenDetail} severity={severity} />
        ))}
      </div>
    </section>
  );
}

function TaskRow({ item, onOpenDetail, severity }) {
  const meta = TASK_SEVERITY_META[severity] || TASK_SEVERITY_META.check;
  const ask = String(item.displayReason || item.conditionText || "内容を確認してください。").trim();
  return (
    <article className={`todo-row todo-row--${severity}`}>
      <span className={`todo-dot todo-dot--${severity}`} aria-hidden="true">{meta.icon}</span>
      <div className="todo-main">
        <div className="todo-meta">
          <span className="todo-kind">{item.displayTitle || "確認事項"}</span>
          <span className="todo-sev">{meta.label}</span>
        </div>
        <p className="todo-ask">{ask}</p>
      </div>
      <button className="btn btn--sm" onClick={() => onOpenDetail(item)} type="button">
        {taskActionLabel(item)}
      </button>
    </article>
  );
}

function CandidateDetailModal({ disabled, item, onClose, onDecision, onSaveReceiptAnnotation }) {
  const [confirmAdoptionChecked, setConfirmAdoptionChecked] = useState(false);
  const [annotationKind, setAnnotationKind] = useState("symptom_detail");
  const [annotationStatus, setAnnotationStatus] = useState("draft");
  const [annotationCode, setAnnotationCode] = useState("");
  const [annotationText, setAnnotationText] = useState("");
  useEffect(() => {
    setConfirmAdoptionChecked(false);
    setAnnotationKind("symptom_detail");
    setAnnotationStatus("draft");
    setAnnotationCode("");
    setAnnotationText(defaultReceiptAnnotationTextForItem(item));
  }, [item?.reviewItemId]);
  if (!item) {
    return null;
  }
  const canDecide = Boolean(item.reviewItemId);
  const itemDecisionStatus = decisionSelectValue(item.decisionStatus || item.status);
  const canDirectAdopt = canDecide && (
    item.kind === "line"
      ? canApproveReviewItem(item)
      : item.kind === "proposal" && canApproveReviewItem(item)
  );
  const canConfirmAdopt = canDecide && confirmableProposalForAdoption(item);
  const canReject = canDecide && (item.reviewOnly !== true || canDirectAdopt || canConfirmAdopt);
  const canManualAdopt = canDirectAdopt || canConfirmAdopt;
  const directAdoptLabel = item.kind === "proposal"
    ? item.canAdopt === true
      ? item.nextActionLabel || `算定する ${item.pointsLabel || ""}`.trim()
      : `算定する ${item.pointsLabel || ""}`.trim()
    : "算定する";
  return (
    <div className="fee-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section className="fee-modal-card" role="dialog" aria-modal="true" aria-label={item.displayTitle || item.name || "算定候補の説明"} onMouseDown={(event) => event.stopPropagation()}>
        <header className="fee-modal-head">
          <div>
            <span className="label">{item.kindLabel || "算定候補"}</span>
            <h2>{item.displayTitle || item.name}</h2>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose} type="button" aria-label="閉じる">×</button>
        </header>
        <div className="fee-modal-body">
          <div className="modal-point-summary">
            <span>点数</span>
            <strong>{item.pointsLabel || `${Number(item.totalPoints || 0).toLocaleString()}点`}</strong>
          </div>
          <section>
            <h3>判断のポイント</h3>
            <p>{item.displayReason || item.reasonText || "算定条件を確認してください。"}</p>
          </section>
          <section>
            <h3>条件</h3>
            <p>{item.conditionText || "カルテ内容、実施状況、施設基準を確認してください。"}</p>
          </section>
          {reviewRequiredInput(item) ? (
            <section>
              <h3>確認する情報</h3>
              <p>{reviewRequiredInput(item)}</p>
            </section>
          ) : null}
          {reviewResolutionOptions(item).length ? (
            <section>
              <h3>確認の選択肢</h3>
              <ul className="fee-modal-option-list">
                {reviewResolutionOptions(item).map((option) => (
                  <li key={option.value || option.label}>{option.label || option.value}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {(item.reviewOnly || item.actionType === "not_billable_now") && !canManualAdopt ? (
            <section>
              <h3>操作方針</h3>
              <p>この項目は自動採用できません。人手で内容を確認し、必要ならカルテまたは手入力オーダーを修正してください。</p>
            </section>
          ) : null}
          {canConfirmAdopt ? (
            <section className="fee-modal-confirm-adoption">
              <label>
                <input
                  checked={confirmAdoptionChecked}
                  disabled={disabled}
                  onChange={(event) => setConfirmAdoptionChecked(event.target.checked)}
                  type="checkbox"
                />
                <span>条件を確認したので算定に含める</span>
              </label>
              <p>この提案は自動採用にはしていませんが、候補コードと点数はあります。内容を確認した場合のみ算定中へ移します。</p>
            </section>
          ) : null}
          {onSaveReceiptAnnotation && canCreateReceiptAnnotationFromItem(item) ? (
            <section className="fee-modal-receipt-annotation">
              <h3>コメント・詳記</h3>
              <div className="fee-modal-annotation-grid">
                <label>
                  <span>種別</span>
                  <select disabled={disabled} onChange={(event) => setAnnotationKind(event.target.value)} value={annotationKind}>
                    <option value="symptom_detail">症状詳記</option>
                    <option value="comment">コメント</option>
                  </select>
                </label>
                <label>
                  <span>状態</span>
                  <select disabled={disabled} onChange={(event) => setAnnotationStatus(event.target.value)} value={annotationStatus}>
                    <option value="draft">下書き</option>
                    <option value="confirmed">確定</option>
                    <option value="rejected">不要</option>
                  </select>
                </label>
                {annotationKind === "comment" ? (
                  <label>
                    <span>コメントコード</span>
                    <input disabled={disabled} onChange={(event) => setAnnotationCode(event.target.value)} value={annotationCode} />
                  </label>
                ) : null}
                <label className="fee-modal-annotation-text">
                  <span>{annotationKind === "comment" ? "コメント本文" : "症状詳記本文"}</span>
                  <textarea disabled={disabled} onChange={(event) => setAnnotationText(event.target.value)} rows={5} value={annotationText} />
                </label>
              </div>
              <div className="fee-modal-annotation-actions">
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={disabled || !annotationText.trim()}
                  onClick={() => onSaveReceiptAnnotation(item, {
                    kind: annotationKind,
                    status: "draft",
                    code: annotationCode,
                    text: annotationText
                  })}
                  type="button"
                >
                  下書き保存
                </button>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={disabled || !annotationText.trim()}
                  onClick={() => onSaveReceiptAnnotation(item, {
                    kind: annotationKind,
                    status: annotationStatus === "rejected" ? "rejected" : "confirmed",
                    code: annotationCode,
                    text: annotationText
                  })}
                  type="button"
                >
                  確定して出力対象
                </button>
              </div>
            </section>
          ) : null}
        </div>
        <footer className="fee-modal-footer">
          {canDirectAdopt ? (
            <>
              <button className="btn btn--primary" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "approved", itemDecisionStatus)} type="button">
                {directAdoptLabel}
              </button>
              {canReject ? (
                <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected", itemDecisionStatus)} type="button">算定しない</button>
              ) : null}
            </>
          ) : canConfirmAdopt ? (
            <>
              <button className="btn btn--primary" disabled={disabled || !confirmAdoptionChecked} onClick={() => onDecision(item.reviewItemId, "approved", itemDecisionStatus)} type="button">算定する</button>
              <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected", itemDecisionStatus)} type="button">算定しない</button>
            </>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function clinicalTextAnnotationsFromCalculationContext({ workbench = {}, calculationResult = null } = {}) {
  return clinicalTextAnnotationsFromIssues([
    ...(Array.isArray(workbench?.issues) ? workbench.issues : []),
    ...clinicalTextAnnotationIssuesFromCalculationWarnings(calculationResult)
  ]);
}

function clinicalTextAnnotationsFromWorkbench(workbench = {}) {
  return clinicalTextAnnotationsFromIssues(Array.isArray(workbench?.issues) ? workbench.issues : []);
}

function clinicalTextAnnotationsFromIssues(issues = []) {
  const seen = new Set();
  return issues
    .map(clinicalTextAnnotationForIssue)
    .filter(Boolean)
    .filter((annotation) => {
      const key = annotation.targetText && annotation.inlineText
        ? [annotation.targetText, annotation.inlineText].join("::")
        : [annotation.targetText, annotation.inlineText, annotation.text].filter(Boolean).join("::");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map((annotation, index) => ({
      ...annotation,
      key: `${annotation.key || "clinical_text_annotation"}_${index}`
    }));
}

function clinicalTextAnnotationIssuesFromCalculationWarnings(calculationResult = null) {
  const warnings = Array.isArray(calculationResult?.warnings) ? calculationResult.warnings : [];
  return warnings
    .map((message, index) => clinicalTextAnnotationIssueFromCalculationWarning(message, index))
    .filter(Boolean);
}

function clinicalTextAnnotationIssueFromCalculationWarning(message = "", index = 0) {
  const text = String(message || "").trim();
  if (!text || isFacilityStandardClinicalIssue(text) || isMissingDiagnosisClinicalIssue(text)) {
    return null;
  }
  const drugName = medicationNameFromCalculationWarning(text);
  if (!drugName) {
    return null;
  }
  if (!/薬剤|処方|数量|日数|総量|1回量|1日回数|不足/u.test(text)) {
    return null;
  }
  return {
    reviewItemId: `calculation_warning_medication_${clinicalTextHash(`${drugName}:${index}:${text}`)}`,
    displayTitle: `${drugName}の確認`,
    displayReason: text,
    reasonText: text,
    issueCategory: "medication",
    sourceType: "calculation_warning"
  };
}

function clinicalTextAnnotationForIssue(item = {}) {
  if (!item || item.hiddenFromWorkspace === true) {
    return null;
  }
  const text = clinicalIssueText(item);
  if (!text || isFacilityStandardClinicalIssue(text, item) || isMissingDiagnosisClinicalIssue(text, item)) {
    return null;
  }
  if (!isClinicalTextActionableIssue(text, item)) {
    return null;
  }

  const title = String(item.displayTitle || item.title || item.name || "不足情報").trim();
  const category = String(item.issueCategory || "").trim();
  const requiredInput = reviewRequiredInput(item);
  const reason = String(item.displayReason || item.reasonText || item.reason || "").trim();
  const materialName = materialNameFromClinicalIssue(text);
  if (materialName) {
    return {
      key: item.reviewItemId || `${materialName}_material`,
      title: `${materialName}の確認`,
      targetText: materialName,
      text: `${materialName}: 使用量または規格を追記してください。`,
      inlineText: materialAnnotationExample(materialName)
    };
  }
  if (/同日複数処置|創傷処置|熱傷処置/u.test(text) && /レセプトコメント|コメント|同日複数処置/u.test(text)) {
    return {
      key: item.reviewItemId || title,
      title,
      targetText: "熱傷処置",
      text: "同日複数処置の根拠を追記してください。",
      inlineKind: "same_day_wound_treatment",
      inlineText: "別部位・別創傷としてそれぞれ処置。"
    };
  }
  if (/レセプトコメント|コメント/u.test(text)) {
    return null;
  }
  if (category === "medication" || /薬剤|数量|日数|総量|1回量|1日回数/u.test(text)) {
    const targetText = medicationAnnotationTarget(title);
    if (!targetText || isGenericMedicationAnnotationTarget(targetText)) {
      return null;
    }
    return {
      key: item.reviewItemId || title,
      title,
      targetText,
      text: `${title}: ${requiredInput || compactRequiredInformation(item.conditionText) || "1回量、1日回数、日数または総量を追記してください。"}`,
      inlineText: medicationAnnotationExample(targetText || title)
    };
  }
  if (requiredInput) {
    return {
      key: item.reviewItemId || title,
      text: `${title}: ${requiredInput}`
    };
  }
  return {
    key: item.reviewItemId || title,
    text: `${title}: ${compactClinicalIssueReason(reason || text)}`
  };
}

function clinicalIssueText(item = {}) {
  return [
    item.displayTitle,
    item.displayReason,
    item.reasonText,
    item.requiredInput,
    item.reviewIssue?.issueCode,
    item.reviewIssue?.title,
    item.reviewIssue?.messageForStaff,
    item.candidateProposal?.reason
  ].filter(Boolean).join(" ");
}

function isFacilityStandardClinicalIssue(text = "", item = {}) {
  const code = String(item.issueCode || item.reviewIssue?.issueCode || item.reviewIssue?.issue_code || "").trim();
  return ["facility_unknown", "hospital_profile_missing", "facility_standard_not_found"].includes(code)
    || /施設基準|地方厚生局|届け出|届出|facility_standard|hospital_profile/u.test(String(text || ""));
}

function isMissingDiagnosisClinicalIssue(text = "", item = {}) {
  const code = String(item.issueCode || item.reviewIssue?.issueCode || item.reviewIssue?.issue_code || "").trim();
  return code === "missing_diagnosis"
    || /病名が入力されていません|病名が未入力|病名未入力|算定根拠として使う病名が未入力/u.test(String(text || ""));
}

function isClinicalTextActionableIssue(text = "", item = {}) {
  const category = String(item.issueCategory || "").trim();
  if (["facility", "management", "unsupported"].includes(category)) {
    return false;
  }
  if (["medication", "diagnosis", "input", "claim-risk", "time", "imaging", "specimen"].includes(category)) {
    return true;
  }
  return /レセプトコメント|コメント|症状詳記|病名|傷病名|適応|理由|査定|薬剤|処方|数量|日数|総量|1回量|1日回数|部位|左右|造影|機器区分|受付時刻|同月|検体|採取/u.test(String(text || ""));
}

function humanReadableReceiptCommentReason(value = "") {
  const text = String(value || "").trim();
  if (/複数診療科で処方/u.test(text)) {
    return "複数診療科で処方している場合は、その旨をレセプトコメントに記載してください。";
  }
  if (/[１1]を算定しない理由/u.test(text)) {
    return "処方料1を算定しない理由を確認し、該当する場合は理由をレセプトコメントに記載してください。";
  }
  return "レセプトコメントの要否を確認し、必要な理由を記載してください。";
}

function receiptCommentExample(value = "") {
  const text = String(value || "").trim();
  if (/複数診療科で処方/u.test(text)) {
    return "複数診療科で処方。";
  }
  if (/[１1]を算定しない理由/u.test(text)) {
    return "処方料1を算定しない理由: ○○のため。";
  }
  return "";
}

function medicationAnnotationExample(title = "") {
  const name = String(title || "").replace(/の確認$/u, "").trim() || "薬剤名";
  if (/軟膏|クリーム|ローション/u.test(name)) {
    return `${name} XXgを塗布。`;
  }
  if (/テープ|貼付薬|湿布/u.test(name)) {
    return `${name} XX枚を貼付。`;
  }
  if (/シロップ|液/u.test(name)) {
    return `${name} XXmL 1日X回 X日分。`;
  }
  return `${name} XXmg 1日X回 X日分。`;
}

function medicationAnnotationTarget(title = "") {
  return String(title || "")
    .replace(/の確認$/u, "")
    .replace(/(OD)?錠|カプセル|散|細粒|顆粒|シロップ|液|坐剤$/u, "")
    .trim();
}

function medicationNameFromCalculationWarning(value = "") {
  const text = String(value || "").trim();
  const quoted = text.match(/薬剤「([^」]+)」/u)?.[1]?.trim();
  if (quoted) {
    return quoted;
  }
  const titled = text.match(/(?:^|[:：\s])([^:：\n]{1,40})の確認/u)?.[1]?.trim();
  if (titled && !isGenericMedicationAnnotationTarget(titled)) {
    return titled;
  }
  return "";
}

function isGenericMedicationAnnotationTarget(value = "") {
  return /^(?:薬剤|処方|投薬|院内処方|院内処方の薬剤情報確認|薬剤情報確認)$/u.test(String(value || "").trim());
}

function materialNameFromClinicalIssue(text = "") {
  const name = String(text || "").match(/特定器材・材料「([^」]+)」をマスターコードへ解決できませんでした/u)?.[1];
  if (!name || /^(?:特定器材|材料|特定器材・材料|医療材料|材料名)$/u.test(name)) {
    return "";
  }
  return name;
}

function materialAnnotationExample(name = "") {
  const value = String(name || "").trim() || "材料名";
  if (/ガーゼ|フィルム|フォーム|被覆材|保護材|固定材|パッド/u.test(value)) {
    return `${value} XXcm²を使用。`;
  }
  if (/チューブ|カテーテル|ドレーン/u.test(value)) {
    return `${value} XX本を使用。`;
  }
  return `${value} XX個を使用。`;
}

function compactRequiredInformation(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/必要な情報\s*[:：]\s*(.+)$/u);
  return match ? match[1] : "";
}

function compactClinicalIssueReason(value = "") {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function reviewRequiredInput(item = {}) {
  return String(
    item.requiredInput
    || item.required_input
    || item.reviewIssue?.requiredInput
    || item.reviewIssue?.required_input
    || item.candidateProposal?.policy?.requiredInput
    || item.candidateProposal?.policy?.required_input
    || item.candidateProposal?.requiredInput
    || item.candidateProposal?.required_input
    || item.sourceItem?.reviewIssue?.requiredInput
    || item.sourceItem?.reviewIssue?.required_input
    || item.sourceItem?.candidateProposal?.policy?.requiredInput
    || item.sourceItem?.candidateProposal?.policy?.required_input
    || item.sourceItem?.candidateProposal?.requiredInput
    || item.sourceItem?.candidateProposal?.required_input
    || ""
  ).trim();
}

function assessmentRiskForItem(item = {}) {
  return item.assessmentRisk
    || item.assessment_risk
    || item.reviewIssue?.assessmentRisk
    || item.reviewIssue?.assessment_risk
    || item.sourceItem?.assessmentRisk
    || item.sourceItem?.reviewIssue?.assessmentRisk
    || null;
}

function reviewResolutionOptions(item = {}) {
  const raw = item.resolutionOptions
    || item.resolution_options
    || item.reviewIssue?.resolutionOptions
    || item.reviewIssue?.resolution_options
    || item.candidateProposal?.resolutionOptions
    || item.candidateProposal?.resolution_options
    || item.sourceItem?.resolutionOptions
    || item.sourceItem?.reviewIssue?.resolutionOptions
    || item.sourceItem?.candidateProposal?.resolutionOptions
    || [];
  return Array.isArray(raw)
    ? raw
      .map((option) => {
        if (typeof option === "string") return { value: option, label: option };
        if (!option || typeof option !== "object") return null;
        return {
          value: String(option.value || option.key || option.label || ""),
          label: String(option.label || option.value || option.key || "")
        };
      })
      .filter((option) => option && option.label)
    : [];
}

function issueTone(item = {}) {
  const category = item.issueCategory || "";
  if (category === "input") return "danger";
  if (category === "medication") return "warning";
  if (category === "facility") return "notice";
  if (category === "master") return "info";
  if (category === "evidence") return "warning";
  if (category === "claim-risk") return "warning";
  return "neutral";
}

function canApproveReviewItem(item = {}) {
  if (confirmableProposalForAdoption(item)) {
    return true;
  }
  if (item.kind === "proposal" && item.canAdopt === true) {
    return true;
  }
  return item.reviewOnly !== true
    && item.actionType !== "not_billable_now"
    && item.canAdopt !== false;
}

function decisionSelectValue(value = "") {
  return value === "approved" ? "approved" : "rejected";
}

function confirmableProposalForAdoption(item = {}) {
  const candidateLine = item.candidateLine || item.candidateProposal?.candidateLine || null;
  const hasCandidateLine = candidateLine && typeof candidateLine === "object" && !Array.isArray(candidateLine);
  const points = Number(item.potentialPoints || candidateLine?.totalPoints || candidateLine?.points || 0);
  return item.kind === "proposal"
    && item.canAdopt !== true
    && hasCandidateLine
    && points > 0;
}

function ReceiptDraftPane({
  disabled,
  feeSession,
  onCopyReceipt,
  onDownloadCsv,
  onDownloadUke,
  onOpenManualItem,
  onRemoveManualOrder,
  orderRows = [],
  receiptDraft,
  selected
}) {
  const feeApi = useFeeApi();
  const manualOrders = manualBillingOrderEntries(orderRows);
  const exportValidation = receiptDraft?.exportValidation || null;
  const [ukeEncoding, setUkeEncoding] = useState("shift_jis");
  const [scope, setScope] = useState("service_date");
  const [monthlyReceipt, setMonthlyReceipt] = useState(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState("");
  const patientId = feeSession?.patientId || "";
  const claimMonth = feeSession?.claimMonth || String(feeSession?.serviceDate || "").slice(0, 7);

  // 施設のレセプト表示単位(a/b)の既定値を読み、初期スコープに反映する(ベストエフォート)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await feeApi("/v1/fee/settings");
        const settingsMap = response?.settings || {};
        const facilityScope = settingsMap[feeSession?.facilityId]?.receiptPolicy?.defaultReceiptScope
          || settingsMap.default?.receiptPolicy?.defaultReceiptScope;
        if (!cancelled && (facilityScope === "monthly" || facilityScope === "service_date")) {
          setScope(facilityScope);
        }
      } catch {
        // 既定スコープの取得失敗時は診療日単位のまま。
      }
    })();
    return () => { cancelled = true; };
  }, [feeApi, feeSession?.facilityId]);

  // 月次集計スコープのときだけ、患者×請求月の集計レセプトを取得する。
  useEffect(() => {
    if (scope !== "monthly" || !patientId || !claimMonth) {
      return undefined;
    }
    let cancelled = false;
    setMonthlyLoading(true);
    setMonthlyError("");
    (async () => {
      try {
        const params = new URLSearchParams({ patientId, claimMonth });
        const response = await feeApi(`/v1/fee/monthly-receipt?${params.toString()}`);
        if (!cancelled) {
          setMonthlyReceipt(response?.receiptDraft || null);
        }
      } catch (error) {
        if (!cancelled) {
          setMonthlyError(toUserFacingErrorMessage(error, "月次集計レセプトを取得できませんでした。"));
        }
      } finally {
        if (!cancelled) {
          setMonthlyLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [scope, patientId, claimMonth, feeApi, feeSession?.status]);

  const previewReceiptDraft = scope === "monthly" ? monthlyReceipt : receiptDraft;
  const exportTarget = scope === "monthly" ? monthlyReceipt : receiptDraft;
  const exportOptions = scope === "monthly"
    ? { scope: "monthly", patientId, claimMonth, receiptDraft: monthlyReceipt }
    : { scope: "service_date" };
  function printReceiptDraft() {
    if (typeof window !== "undefined") {
      window.print();
    }
  }
  return (
    <div className="receipt-draft-pane">
      <div className="receipt-pane-head">
        <div>
          <h2>レセプト案</h2>
          <p>提出前の帳票プレビューです。修正後にCSV・レセ電(UKE)を出力できます。</p>
          <div className="receipt-scope-toggle" role="group" aria-label="レセプト表示単位">
            {[["service_date", "診療日単位"], ["monthly", "月次集計"]].map(([value, label]) => (
              <button
                className={`fee-filter-chip ${scope === value ? "is-active" : ""}`}
                key={value}
                onClick={() => setScope(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="receipt-pane-actions">
          <button className="btn btn--ghost btn--sm" disabled={disabled || !exportTarget} onClick={printReceiptDraft} type="button">
            印刷/PDF
          </button>
          <button className="btn btn--ghost btn--sm" disabled={disabled || !exportTarget} onClick={() => onCopyReceipt(exportOptions)} type="button">
            コピー
          </button>
          <button className="btn btn--ghost btn--sm" disabled={disabled || !exportTarget} onClick={() => onDownloadCsv(exportOptions)} type="button">
            CSV出力
          </button>
          <span className="receipt-uke-group">
            <select
              className="receipt-uke-encoding"
              aria-label="レセ電の文字コード"
              disabled={disabled || !exportTarget}
              value={ukeEncoding}
              onChange={(event) => setUkeEncoding(event.target.value)}
            >
              <option value="shift_jis">Shift_JIS</option>
              <option value="utf-8">UTF-8</option>
            </select>
            <button className="btn btn--ghost btn--sm" disabled={disabled || !exportTarget} onClick={() => onDownloadUke(ukeEncoding, exportOptions)} type="button">
              レセ電(UKE)出力
            </button>
          </span>
        </div>
      </div>
      <div className="receipt-review-layout">
        {scope === "monthly" && monthlyLoading ? (
          <div className="fee-empty-state">月次集計レセプトを作成しています…</div>
        ) : scope === "monthly" && monthlyError ? (
          <div className="fee-error-state" role="status">{monthlyError}</div>
        ) : (
          <ReceiptDraft receiptDraft={previewReceiptDraft} feeSession={feeSession} selected={selected} />
        )}
        <ReceiptCorrectionPanel
          disabled={disabled}
          manualOrders={manualOrders}
          onOpenManualItem={onOpenManualItem}
          onRemoveManualOrder={onRemoveManualOrder}
          receiptDraft={receiptDraft}
          validation={exportValidation}
        />
      </div>
    </div>
  );
}

function ReceiptExportValidation({ validation }) {
  if (!validation) {
    return null;
  }
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  return (
    <section className={`receipt-export-validation receipt-export-validation--${validation.exportStatus || "draft"}`} aria-label="出力前検証">
      <div>
        <span>{validation.label || "レセ電下書き"}</span>
        <strong>{Number(validation.blockingIssueCount || 0) ? "必須項目の不足があります" : "下書き出力の基本項目は揃っています"}</strong>
        <small>必須 {Number(validation.blockingIssueCount || 0).toLocaleString()}件 / 警告 {Number(validation.warningIssueCount || 0).toLocaleString()}件</small>
      </div>
      {issues.length ? (
        <ul>
          {issues.slice(0, 5).map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>
              <span>{issue.severity === "error" ? "必須" : "警告"}</span>
              <p>{issue.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const BURDEN_RATIO_SOURCE_LABEL = {
  explicit: "保険情報の指定",
  age: "年齢から自動判定",
  public: "公費による上書き",
  default_unknown: "不明(要確認・暫定3割)"
};

function BillingSummary({ billing }) {
  if (!billing) {
    return null;
  }
  const yen = (value) => `¥${Number(value || 0).toLocaleString()}`;
  const ratioPercent = Math.round(Number(billing.burdenRatio || 0) * 100);
  const needsReview = billing.burdenRatioSource === "default_unknown";
  return (
    <section className={`billing-summary ${needsReview ? "billing-summary--review" : ""}`} aria-label="会計(窓口負担)">
      <div className="billing-summary-grid">
        <div className="billing-metric">
          <span>総医療費</span>
          <strong>{yen(billing.totalFee)}</strong>
          <small>{Number(billing.totalPoints || 0).toLocaleString()}点</small>
        </div>
        <div className="billing-metric">
          <span>負担割合</span>
          <strong>{ratioPercent}%</strong>
          <small>{BURDEN_RATIO_SOURCE_LABEL[billing.burdenRatioSource] || billing.burdenRatioSource}</small>
        </div>
        <div className="billing-metric billing-metric--accent">
          <span>窓口負担</span>
          <strong>{yen(billing.copay)}</strong>
          <small>保険者負担 {yen(billing.insurerPay)}</small>
        </div>
      </div>
      {Array.isArray(billing.notes) && billing.notes.length ? (
        <ul className="billing-notes">
          {billing.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ManualBillingItemModal({
  available,
  disabled,
  draft,
  items,
  masterQuery,
  masterType,
  onAdd,
  onClose,
  onDraftChange,
  onMasterQueryChange,
  onMasterTypeChange,
  onRemoveSelected,
  onSelectMaster,
  onUpdateSelectedQuantity,
  open,
  orderRows = [],
  receiptDraft,
  selectedMasterIndex = 0
}) {
  if (!open) {
    return null;
  }
  const selectedItems = manualDraftSelectedItems(draft);
  const duplicateReason = manualBillingBatchDuplicateReason({ entries: selectedItems, orderRows, receiptDraft });
  return (
    <div className="fee-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section className="fee-modal-card manual-billing-modal" role="dialog" aria-modal="true" aria-label="明細を追加" onMouseDown={(event) => event.stopPropagation()}>
        <header className="fee-modal-head">
          <div>
            <span className="label">ユーザー追加</span>
            <h2>明細を追加</h2>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose} type="button" aria-label="閉じる">×</button>
        </header>
        <div className="fee-modal-body">
          <section className="manual-billing-section manual-billing-search-section">
            <h3>マスター検索</h3>
            <p>追加したい診療行為・薬剤・材料・コメントを複数選択できます。点数は保存後に算定エンジンで再計算します。</p>
            <div className="master-search-panel">
              <div className="master-search-controls">
                <AdminSelect
                  ariaLabel="マスター種別"
                  disabled={!available || disabled}
                  options={MASTER_TYPES.map(([value, label]) => ({ value, label }))}
                  value={masterType}
                  onValueChange={onMasterTypeChange}
                />
                <input
                  disabled={!available || disabled}
                  onChange={(event) => onMasterQueryChange(event.target.value)}
                  placeholder={available ? "名称またはコードで検索" : "マスター検索APIの反映待ちです"}
                  type="search"
                  value={masterQuery}
                />
              </div>
              <div className="manual-billing-scroll-region">
                <MasterSearchResults
                  available={available}
                  items={items}
                  query={masterQuery}
                  selectedIndex={selectedMasterIndex}
                  onAdd={onSelectMaster}
                  actionLabel="選択"
                />
              </div>
            </div>
          </section>

          <section className="manual-billing-section manual-billing-selected-section">
            <h3>追加内容</h3>
            {selectedItems.length ? (
              <div className="manual-billing-selected-list">
                {selectedItems.map((entry, index) => {
                  const selected = entry.item || {};
                  return (
                    <div className="manual-billing-selected" key={`${manualBillingItemKey(selected)}-${index}`}>
                      <div>
                        <strong>{selected.name || selected.code || "名称未設定"}</strong>
                        <small>{masterKindLabel(selected.kind)} / {selected.code || "コード未設定"}{selected.points !== undefined ? ` / ${Number(selected.points).toLocaleString()}点` : ""}</small>
                      </div>
                      <label>
                        <span>数量</span>
                        <input
                          disabled={disabled || selected.kind === "comment"}
                          inputMode="decimal"
                          min="0.01"
                          onChange={(event) => onUpdateSelectedQuantity(index, event.target.value)}
                          type="number"
                          value={entry.quantity || "1"}
                        />
                      </label>
                      <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onRemoveSelected(index)} type="button">
                        解除
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="fee-empty-state">上の検索結果から追加する項目を選択してください。</div>
            )}
            <div className="manual-billing-fields">
              <label>
                <span>追加理由・メモ</span>
                <textarea
                  disabled={disabled}
                  onChange={(event) => onDraftChange((current) => ({ ...current, note: event.target.value }))}
                  placeholder="例: 医事確認により追加"
                  value={draft.note}
                />
              </label>
            </div>
            {duplicateReason ? <div className="inline-error" role="status">{duplicateReason}</div> : null}
          </section>
        </div>
        <footer className="fee-modal-footer">
          <button className="btn btn--ghost" disabled={disabled} onClick={onClose} type="button">閉じる</button>
          <button className="btn btn--primary" disabled={disabled || !selectedItems.length || Boolean(duplicateReason)} onClick={onAdd} type="button">
            {selectedItems.length > 1 ? `${selectedItems.length.toLocaleString()}件を追加して再計算` : "追加して再計算"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AdminSelect({
  ariaLabel,
  className = "",
  disabled = false,
  onValueChange,
  options,
  placeholder = "選択",
  value
}) {
  const normalizedValue = value || EMPTY_SELECT_VALUE;
  const selectedOption = options.find((option) => (option.value || EMPTY_SELECT_VALUE) === normalizedValue);
  const triggerClassName = ["admin-select-trigger", className].filter(Boolean).join(" ");
  return (
    <SelectPrimitive.Root
      disabled={disabled}
      value={normalizedValue}
      onValueChange={(nextValue) => onValueChange(nextValue === EMPTY_SELECT_VALUE ? "" : nextValue)}
    >
      <SelectPrimitive.Trigger className={triggerClassName} aria-label={ariaLabel} title={selectedOption?.label || placeholder}>
        <span className="admin-select-value">
          <SelectPrimitive.Value>
            <span className="admin-select-trigger-value">{selectedOption?.label || placeholder}</span>
          </SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <span className="admin-select-affordance" aria-hidden="true">
            <span className="admin-select-chevron" />
          </span>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="admin-select-content" position="popper" align="start" sideOffset={6}>
          <SelectPrimitive.Viewport className="admin-select-viewport">
            {options.map((option) => {
              const optionValue = option.value || EMPTY_SELECT_VALUE;
              return (
                <SelectPrimitive.Item
                  className="admin-select-item"
                  disabled={option.disabled}
                  key={optionValue}
                  textValue={option.label}
                  value={optionValue}
                >
                  <span className="admin-select-item-indicator">
                    <SelectPrimitive.ItemIndicator>✓</SelectPrimitive.ItemIndicator>
                  </span>
                  <span className="admin-select-item-copy">
                    <SelectPrimitive.ItemText>
                      <span className="admin-select-item-label">{option.label}</span>
                    </SelectPrimitive.ItemText>
                    {option.description ? <span className="admin-select-item-description">{option.description}</span> : null}
                  </span>
                </SelectPrimitive.Item>
              );
            })}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function CalculationProgress({ progress }) {
  const normalized = normalizeCalculationProgress(progress);
  const diagnoses = Array.isArray(normalized.diagnoses) ? normalized.diagnoses : [];
  const extractedOrders = Array.isArray(normalized.extractedOrders) ? normalized.extractedOrders : [];
  const lineItems = Array.isArray(normalized.lineItems) ? normalized.lineItems : [];
  const steps = [
    ["extract", "抽出"],
    ["calculate", "算定"],
    ["aggregate", "集計"],
    ["complete", "完了"]
  ];
  return (
    <div className="calculation-progress" aria-live="polite">
      <div className="calculation-progress-head">
        <div>
          <strong>{normalized.label}</strong>
          <p>{normalized.message}</p>
        </div>
        <span>{Number(normalized.percent || 0).toLocaleString()}%</span>
      </div>
      <div className="calculation-progress-track" aria-hidden="true">
        <span style={{ width: `${Math.max(6, Math.min(100, Number(normalized.percent || 0)))}%` }} />
      </div>
      <ol className="calculation-progress-steps">
        {steps.map(([phase, label]) => (
          <li className={progressStepClass(phase, normalized.phase)} key={phase}>{label}</li>
        ))}
      </ol>
      {(diagnoses.length || extractedOrders.length || lineItems.length) ? (
        <div className="calculation-progress-preview">
          {diagnoses.length ? (
            <div>
              <span>病名</span>
              <ul>{diagnoses.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
          {extractedOrders.length ? (
            <div>
              <span>抽出した候補</span>
              <ul>{extractedOrders.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
          {lineItems.length ? (
            <div>
              <span>算定行</span>
              <ul>{lineItems.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReceiptCorrectionPanel({
  disabled,
  manualOrders = [],
  onOpenManualItem,
  onRemoveManualOrder,
  receiptDraft,
  validation
}) {
  return (
    <aside className="receipt-correction-panel" aria-label="レセプト修正">
      <section className="receipt-correction-section">
        <div className="receipt-correction-head">
          <h3>修正</h3>
          <span>{Number(receiptDraft?.totalPoints || 0).toLocaleString()}点</span>
        </div>
        <div className="receipt-correction-actions">
          <button className="btn btn--primary btn--sm" disabled={disabled || !receiptDraft} onClick={onOpenManualItem} type="button">
            明細を追加
          </button>
        </div>
      </section>
      <ReceiptExportValidation validation={validation} />
      {manualOrders.length ? (
        <section className="manual-billing-list" aria-label="ユーザー追加明細">
          <div className="manual-billing-list-head">
            <div>
              <h3>ユーザー追加明細</h3>
              <p>削除すると再計算します。</p>
            </div>
            <span>{manualOrders.length.toLocaleString()}件</span>
          </div>
          {manualOrders.map(({ row, rowIndex }) => (
            <article className="manual-billing-row" key={`${row.standardCode || row.localName || "manual"}-${rowIndex}`}>
              <div>
                <strong>{row.standardName || row.localName || row.standardCode || "名称未設定"}</strong>
                <small>{orderTypeLabel(row.orderType)} / {row.standardCode || "コード未設定"} / 数量 {row.quantity || "1"}</small>
                {row.note ? <small>{row.note}</small> : null}
              </div>
              <span>手入力</span>
              <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onRemoveManualOrder(rowIndex)} type="button">
                削除
              </button>
            </article>
          ))}
        </section>
      ) : null}
    </aside>
  );
}

function ReceiptDraft({ feeSession, receiptDraft, selected }) {
  if (!receiptDraft) {
    return <div className="fee-empty-state">{selected ? "算定候補を作成すると、レセプト案が表示されます。" : "算定記録を選択してください。"}</div>;
  }
  const patient = receiptDraft.patientSnapshot || {};
  const facility = receiptDraft.facilitySnapshot || {};
  const insurance = receiptDraft.insuranceSnapshot?.insurance || {};
  const publicInsurance = Array.isArray(receiptDraft.insuranceSnapshot?.publicInsurance) ? receiptDraft.insuranceSnapshot.publicInsurance : [];
  const billing = receiptDraft.billing || {};
  const groups = Array.isArray(receiptDraft.lineGroups) ? receiptDraft.lineGroups : [];
  const lines = groups.flatMap((group) => (Array.isArray(group.lines) ? group.lines : []));
  const sections = receiptBenefitSections(lines);
  // 月次集計(scope=monthly)では傷病名・注記・実日数を receiptDraft 側が持つ。診療日単位は feeSession から。
  const annotationSource = receiptDraft.receiptAnnotations ? { receiptAnnotations: receiptDraft.receiptAnnotations } : feeSession;
  const annotations = receiptDisplayAnnotations(annotationSource);
  const diagnoses = Array.isArray(receiptDraft.diagnoses) && receiptDraft.diagnoses.length
    ? receiptDraft.diagnoses
    : (Array.isArray(feeSession?.diagnoses) ? feeSession.diagnoses : []);
  const actualDays = Number(receiptDraft.actualDays || 1);
  const burdenRatio = typeof billing.burdenRatio === "number" ? billing.burdenRatio : null;
  const benefitPercent = burdenRatio !== null ? Math.round((1 - burdenRatio) * 100) : null;
  return (
    <div className="receipt-paper-shell">
      <article className="receipt-paper receipt-form" aria-label="レセプト提出前プレビュー">
        <header className="receipt-form-top">
          <div className="receipt-form-title">
            <span className="receipt-paper-kicker">提出前プレビュー</span>
            <h3>診療報酬明細書</h3>
            <small>（医科）{receiptSettingLabel(receiptDraft.setting)} / {statusLabel(receiptDraft.status)}</small>
          </div>
          <div className="receipt-form-period">
            <span>診療年月</span>
            <strong>{warekiYearMonth(receiptDraft.claimMonth || receiptDraft.serviceDate)}</strong>
          </div>
          <dl className="receipt-form-insurance">
            <div><dt>保険者番号</dt><dd>{insurance.insurerNumber || "—"}</dd></div>
            <div><dt>記号・番号</dt><dd>{[insurance.insuredSymbol, insurance.insuredNumber].filter(Boolean).join(" ・ ") || "—"}</dd></div>
            <div><dt>給付割合</dt><dd>{benefitPercent !== null ? `${benefitPercent}%` : "—"}</dd></div>
            <div><dt>公費</dt><dd>{publicInsurance.length ? `${publicInsurance.length}件` : "なし"}</dd></div>
          </dl>
        </header>

        <section className="receipt-form-patient" aria-label="患者・医療機関">
          <div><span>氏名</span><strong>{patient.displayName || receiptDraft.patientRef || "—"}</strong></div>
          <div><span>性別</span><strong>{sexLabel(patient.sex)}</strong></div>
          <div><span>生年月日</span><strong>{warekiDate(patient.birthDate) || "—"}</strong></div>
          <div><span>医療機関</span><strong>{facility.displayName || "—"}</strong><small>コード {facility.medicalInstitutionCode || "—"} / 都道府県 {facility.prefectureCode || "—"}</small></div>
        </section>

        <section className="receipt-form-block" aria-label="傷病名">
          <div className="receipt-form-block-head">
            <h4>傷病名</h4>
            <span>診療開始日 {warekiDate(receiptDraft.serviceDate) || "—"}</span>
          </div>
          {diagnoses.length ? (
            <table className="receipt-form-disease">
              <thead>
                <tr><th>#</th><th>傷病名</th><th>ICD10</th><th>主病</th><th>転帰</th></tr>
              </thead>
              <tbody>
                {diagnoses.map((diagnosis, index) => (
                  <tr key={diagnosis.diagnosisId || index}>
                    <td>{index + 1}</td>
                    <td>{diagnosis.name || "—"}</td>
                    <td>{diagnosis.icd10Code || "—"}</td>
                    <td className="receipt-form-disease-primary">{diagnosis.isPrimary ? "●" : ""}</td>
                    <td>{diagnosisOutcomeLabel(diagnosis.outcome)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="receipt-paper-empty">傷病名が未入力です。カルテ本文・病名欄で入力してください。</p>}
        </section>

        <section className="receipt-form-benefit" aria-label="点数欄と摘要">
          <table className="receipt-form-points">
            <thead>
              <tr><th>区分</th><th>回数</th><th>点数</th></tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                <tr className={section.count ? "" : "is-empty"} key={section.key}>
                  <td>{section.label}</td>
                  <td>{section.count ? section.count.toLocaleString() : "—"}</td>
                  <td>{section.points ? section.points.toLocaleString() : "—"}</td>
                </tr>
              ))}
              <tr className="receipt-form-points-total">
                <td>合計</td>
                <td />
                <td>{Number(receiptDraft.totalPoints || 0).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          <div className="receipt-form-tekiyo">
            <div className="receipt-form-block-head">
              <h4>摘要</h4>
              <span>診療実日数 {actualDays.toLocaleString()}日</span>
            </div>
            {sections.some((section) => section.lines.length) ? (
              <ul>
                {sections.filter((section) => section.lines.length).map((section) => (
                  <li key={section.key}>
                    <span className="receipt-form-tekiyo-cat">{section.label}</span>
                    {section.lines.map((line, lineIndex) => (
                      <p key={`${line.receiptLineId || line.code || lineIndex}-${lineIndex}`}>
                        {line.name || line.code || "—"}　{Number(line.points || 0).toLocaleString()}点 × {Number(line.quantity || 1).toLocaleString()}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            ) : <p className="receipt-paper-empty">明細がありません。</p>}
          </div>
        </section>

        <section className="receipt-form-block" aria-label="コメントと症状詳記">
          <div className="receipt-form-block-head">
            <h4>コメント・症状詳記</h4>
            <span>{(annotations.comments.length + annotations.symptomDetails.length).toLocaleString()}件</span>
          </div>
          {annotations.comments.length || annotations.symptomDetails.length ? (
            <div className="receipt-paper-annotations">
              {annotations.comments.map((comment) => (
                <div key={comment.annotationId || `${comment.code}-${comment.text}`}>
                  <span>コメント {comment.code || "—"}</span>
                  <p>{comment.text}</p>
                </div>
              ))}
              {annotations.symptomDetails.map((detail) => (
                <div key={detail.annotationId || `${detail.kubun}-${detail.text}`}>
                  <span>症状詳記 {detail.kubun || "—"}</span>
                  <p>{detail.text}</p>
                </div>
              ))}
            </div>
          ) : <p className="receipt-paper-empty">コメント・症状詳記はありません。</p>}
        </section>

        <footer className="receipt-form-foot">
          <div><span>請求点数</span><strong>{Number(receiptDraft.totalPoints || 0).toLocaleString()}点</strong></div>
          <div><span>総医療費</span><strong>¥{Number(billing.totalFee || 0).toLocaleString()}</strong></div>
          <div><span>一部負担金</span><strong>¥{Number(billing.copay || 0).toLocaleString()}</strong></div>
        </footer>
      </article>
    </div>
  );
}

// 出来高の点数欄を公式区分(初診〜その他)へ寄せる。lineは先に一致した区分へ一度だけ割り当てる。
const RECEIPT_BENEFIT_SECTIONS = [
  ["shoshin", "初診", (line) => line.orderType === "basic" && (/初診/u.test(line.name || "") || String(line.code || "").startsWith("1110"))],
  ["saishin", "再診", (line) => line.orderType === "basic"],
  ["kanri", "医学管理", (line) => line.orderType === "management" || /管理料|指導料/u.test(line.name || "")],
  ["zaitaku", "在宅", (line) => line.orderType === "home" || /在宅/u.test(line.name || "")],
  ["toyaku", "投薬", (line) => ["drug", "medication"].includes(line.orderType)],
  ["chusha", "注射", (line) => line.orderType === "injection"],
  ["shochi", "処置", (line) => line.orderType === "treatment"],
  ["shujutsu", "手術・麻酔", (line) => ["procedure", "surgery", "anesthesia"].includes(line.orderType)],
  ["kensa", "検査・病理", (line) => ["lab", "pathology"].includes(line.orderType)],
  ["gazo", "画像診断", (line) => line.orderType === "imaging"],
  ["sonota", "その他", () => true]
];

function receiptBenefitSections(lines = []) {
  const used = new Array(lines.length).fill(false);
  return RECEIPT_BENEFIT_SECTIONS.map(([key, label, match]) => {
    const matched = [];
    lines.forEach((line, index) => {
      if (!used[index] && match(line)) {
        used[index] = true;
        matched.push(line);
      }
    });
    return {
      key,
      label,
      count: matched.reduce((sum, line) => sum + Number(line.quantity || 1), 0),
      points: matched.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0),
      lines: matched
    };
  });
}

function diagnosisOutcomeLabel(outcome = "") {
  return ({
    cured: "治ゆ",
    recovered: "治ゆ",
    improved: "軽快",
    unchanged: "不変",
    deteriorated: "増悪",
    death: "死亡",
    died: "死亡",
    transferred: "転医",
    discontinued: "中止",
    ongoing: "—",
    unknown: "—"
  })[outcome] || outcome || "—";
}

function parseReceiptDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = /^\d{4}-\d{2}$/u.test(raw) ? `${raw}-01` : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function warekiParts(date) {
  const eras = [
    ["令和", 2019, 5, 1],
    ["平成", 1989, 1, 8],
    ["昭和", 1926, 12, 25]
  ];
  for (const [era, year, month, day] of eras) {
    if (date >= new Date(year, month - 1, day)) {
      return { era, year: date.getFullYear() - year + 1 };
    }
  }
  return { era: "西暦", year: date.getFullYear() };
}

function warekiDate(value) {
  const date = parseReceiptDate(value);
  if (!date) {
    return "";
  }
  const { era, year } = warekiParts(date);
  return `${era}${year}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function warekiYearMonth(value) {
  const date = parseReceiptDate(String(value || "").slice(0, 7));
  if (!date) {
    return value || "—";
  }
  const { era, year } = warekiParts(date);
  return `${era}${year}年${date.getMonth() + 1}月`;
}

function receiptDisplayAnnotations(feeSession = {}) {
  const annotations = normalizeReceiptAnnotationsForClient(feeSession?.receiptAnnotations);
  return {
    comments: annotations.comments.filter((item) => String(item?.text || "").trim()),
    symptomDetails: annotations.symptomDetails.filter((item) => String(item?.text || "").trim())
  };
}

function receiptSettingLabel(value = "") {
  return ({
    outpatient: "外来",
    inpatient: "入院"
  })[value] || value || "区分未設定";
}

function sexLabel(value = "") {
  return ({
    male: "男性",
    female: "女性",
    other: "その他",
    unknown: "性別未設定"
  })[value] || value || "性別未設定";
}

function formatReceiptDraftForClipboard({ feeSession, receiptDraft }) {
  const patientName = feeSession?.patientSnapshot?.displayName || feeSession?.patientRef || feeSession?.patientId || "患者未選択";
  const serviceDate = feeSession?.serviceDate || "診療日未設定";
  const claimMonth = receiptDraft?.claimMonth || feeSession?.claimMonth || "請求月未設定";
  const totalPoints = Number(receiptDraft?.totalPoints || 0);
  const lines = [
    "レセプト案",
    `患者: ${patientName}`,
    `診療日: ${serviceDate}`,
    `請求月: ${claimMonth}`,
    `合計: ${totalPoints.toLocaleString()}点`,
    ""
  ];

  const groups = Array.isArray(receiptDraft?.lineGroups) ? receiptDraft.lineGroups : [];
  if (groups.length) {
    for (const group of groups) {
      lines.push(`${group.label || "未分類"}: ${Number(group.totalPoints || 0).toLocaleString()}点`);
      for (const line of group.lines || []) {
        lines.push(`- ${line.name || "名称未設定"} ${Number(line.totalPoints || 0).toLocaleString()}点 (${statusLabel(line.status)})`);
      }
      lines.push("");
    }
  } else {
    const receiptLines = Array.isArray(receiptDraft?.lines) ? receiptDraft.lines : [];
    for (const line of receiptLines) {
      lines.push(`- ${line.name || "名称未設定"} ${Number(line.totalPoints || 0).toLocaleString()}点 (${statusLabel(line.status)})`);
    }
  }

  return lines.join("\n").trim();
}

async function writeClipboardText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("クリップボードを利用できません。");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("クリップボードへコピーできませんでした。");
  }
}

function SessionSkeleton() {
  return (
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
  );
}

function SessionList({ sessions }) {
  if (!sessions.length) {
    return <div className="fee-empty-state">条件に一致する算定履歴はありません。</div>;
  }

  return (
    <div className="session-list">
      {sessions.map((session) => (
        <article className="card session-card" key={session.feeSessionId}>
          <a className="session-card-link" href={`/sessions/${encodeURIComponent(session.feeSessionId)}`}>
            <div className="session-card-info">
              <strong>{session.patientSnapshot?.displayName || session.patientRef || session.patientId || "患者名未入力"}</strong>
              <span>{session.serviceDate || "診療日未設定"} ・ {session.facilitySnapshot?.displayName || "施設未設定"} ・ {session.departmentSnapshot?.displayName || "診療科未指定"}</span>
              <span>作成 {formatDateTime(session.createdAt)} ・ {totalPointsLabel(session)} ・ {reviewLabel(session)}</span>
            </div>
            <span className={badgeClass(session.status)}>
              {statusLabel(session.status)}
            </span>
          </a>
        </article>
      ))}
    </div>
  );
}

function Pagination({ onPageChange, pageInfo, pageItems = [] }) {
  if (pageInfo.totalPages <= 1) {
    return null;
  }
  return (
    <nav className="session-history-pagination" aria-label="算定履歴ページ移動">
      <button className="btn btn--ghost session-history-page-button" disabled={pageInfo.page <= 1} onClick={() => onPageChange(pageInfo.page - 1)} type="button">前へ</button>
      <div className="session-history-page-list">
        {pageItems.map((item, index) => (
          item === "ellipsis"
            ? <span className="session-history-page-ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>
            : (
              <button
                className={`session-history-page-chip ${item === pageInfo.page ? "is-active" : ""}`}
                aria-current={item === pageInfo.page ? "page" : undefined}
                disabled={item === pageInfo.page}
                key={item}
                onClick={() => onPageChange(item)}
                type="button"
              >
                {item}
              </button>
          )
        ))}
      </div>
      <button className="btn btn--ghost session-history-page-button" disabled={pageInfo.page >= pageInfo.totalPages} onClick={() => onPageChange(pageInfo.page + 1)} type="button">次へ</button>
    </nav>
  );
}

function useFeeApi() {
  const auth = usePlatformAuth();
  return useCallback(async (path, options = {}) => {
    const config = typeof window !== "undefined" ? window.__HALUNASU_FEE_CONFIG__ || {} : {};
    const baseUrl = config.feeBaseUrl || "/api/fee";
    const headers = { "content-type": "application/json" };
    const accessToken = auth.accessToken || getStoredPlatformAccessToken();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    if (options.csrf && auth.csrfToken) {
      headers["x-csrf-token"] = auth.csrfToken;
    }
    const response = await fetch(`${baseUrl}${path}`, {
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
  }, [auth.accessToken, auth.csrfToken]);
}

// レセコン取込用CSVのダウンロード(JSONではなくテキスト応答を扱う)
function useFeeReceiptCsvDownload() {
  const auth = usePlatformAuth();
  return useCallback(async (sessionId) => {
    const config = typeof window !== "undefined" ? window.__HALUNASU_FEE_CONFIG__ || {} : {};
    const baseUrl = config.feeBaseUrl || "/api/fee";
    const headers = {};
    const accessToken = auth.accessToken || getStoredPlatformAccessToken();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    const response = await fetch(
      `${baseUrl}/v1/fee/sessions/${encodeURIComponent(sessionId)}/receipt.csv`,
      { method: "GET", headers, credentials: "include" }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `receipt_${sessionId}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [auth.accessToken]);
}

// レセプト電算(UKE)のダウンロード。文字コードを選択(既定 Shift_JIS)。
function useFeeReceiptUkeDownload() {
  const auth = usePlatformAuth();
  return useCallback(async (sessionId, encoding = "shift_jis") => {
    const config = typeof window !== "undefined" ? window.__HALUNASU_FEE_CONFIG__ || {} : {};
    const baseUrl = config.feeBaseUrl || "/api/fee";
    const headers = {};
    const accessToken = auth.accessToken || getStoredPlatformAccessToken();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    const response = await fetch(
      `${baseUrl}/v1/fee/sessions/${encodeURIComponent(sessionId)}/receipt.uke?encoding=${encodeURIComponent(encoding)}`,
      { method: "GET", headers, credentials: "include" }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `receipt_${sessionId}.UKE`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [auth.accessToken]);
}

function useFeeReceiptBlobDownload() {
  const auth = usePlatformAuth();
  return useCallback(async (path, filename) => {
    const config = typeof window !== "undefined" ? window.__HALUNASU_FEE_CONFIG__ || {} : {};
    const baseUrl = config.feeBaseUrl || "/api/fee";
    const headers = {};
    const accessToken = auth.accessToken || getStoredPlatformAccessToken();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    const response = await fetch(`${baseUrl}${path}`, { method: "GET", headers, credentials: "include" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [auth.accessToken]);
}

function useFeeMonthlyReceiptCsvDownload() {
  const download = useFeeReceiptBlobDownload();
  return useCallback((patientId, claimMonth) => {
    const params = new URLSearchParams({ patientId, claimMonth });
    return download(`/v1/fee/monthly-receipt.csv?${params.toString()}`, `receipt_monthly_${claimMonth || "month"}.csv`);
  }, [download]);
}

function useFeeMonthlyReceiptUkeDownload() {
  const download = useFeeReceiptBlobDownload();
  return useCallback((patientId, claimMonth, encoding = "shift_jis") => {
    const params = new URLSearchParams({ patientId, claimMonth, encoding });
    return download(`/v1/fee/monthly-receipt.uke?${params.toString()}`, `receipt_monthly_${claimMonth || "month"}.UKE`);
  }, [download]);
}

async function runBusy(setBusy, addToast, task) {
  setBusy(true);
  try {
    await task();
  } catch (error) {
    addToast(toUserFacingErrorMessage(error, "処理に失敗しました。"), "error");
  } finally {
    setBusy(false);
  }
}

function applyDetailResponse(response, setters, options = {}) {
  const sourceSession = response.feeSession || response;
  let session = sourceSession || null;
  let receiptDraft = response.receiptDraft || null;
  let candidateWorkbench = response.candidateWorkbench || null;
  if (options.preserveCalculationOutput && options.currentFeeSession?.calculationResult && !sourceSession?.calculationResult) {
    session = {
      ...(sourceSession || {}),
      calculationResult: options.currentFeeSession.calculationResult,
      calculationSummary: options.currentFeeSession.calculationSummary || sourceSession?.calculationSummary || null,
      latestCalculationId: options.currentFeeSession.latestCalculationId || sourceSession?.latestCalculationId || null,
      status: ["calculated", "needs_review"].includes(options.currentFeeSession.status)
        ? options.currentFeeSession.status
        : sourceSession?.status
    };
    receiptDraft = options.currentReceiptDraft || receiptDraft;
    candidateWorkbench = options.currentCandidateWorkbench || candidateWorkbench;
  }
  setters.setFeeSession(session || null);
  setters.setReceiptDraft(receiptDraft);
  setters.setCandidateWorkbench?.(candidateWorkbench);
  setters.setForm(formFromFeeSession(session || {}));
  setters.setDiagnosesTouched?.(String(session?.diagnosesSource || "").trim() === "manual");
  setters.setDiagnosesEditedSinceLoad?.(false);
  setters.setOrderRows(orderRowsFromOrders(session?.orders || []));
  setters.setOrderRowsTouched?.(false);
  setters.setClinicalTextBaselineHash?.(clinicalTextHash(session?.clinicalText || ""));
}

function buildFeeSessionPayload({
  defaultFacilityId,
  form,
  orderRows,
  patients,
  diagnosesTouched = false,
  orderRowsTouched = false,
  clinicalTextBaselineHash = ""
}) {
  const patient = patients.find((item) => item.patientId === form.patientId);
  const chartInput = buildChartOnlyInput(form, orderRows, {
    orderRowsTouched,
    clinicalTextBaselineHash
  });
  const diagnosesSource = diagnosesTouched ? "manual" : "clinical_auto";
  return {
    patientId: emptyToNull(form.patientId),
    patientRef: patient?.externalPatientIds?.[0] || emptyToNull(form.patientId),
    facilityId: emptyToNull(form.facilityId) || defaultFacilityId || null,
    departmentId: emptyToNull(form.departmentId),
    serviceDate: form.serviceDate,
    claimMonth: emptyToNull(form.claimMonth),
    setting: form.setting,
    clinicalText: form.clinicalText,
    diagnoses: parseDiagnoses(chartInput.diagnosesText),
    diagnosesSource,
    diagnosesClinicalTextHash: clinicalTextHash(form.clinicalText),
    orders: parseOrdersFromRows(chartInput.orderRows),
    calculationOptions: parseJsonObjectField(form.calculationOptionsText, "算定オプション JSON")
  };
}

function defaultFeeForm() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    patientId: "",
    facilityId: "",
    departmentId: "",
    serviceDate: today,
    claimMonth: today.slice(0, 7),
    setting: "outpatient",
    clinicalText: "",
    diagnosesText: "",
    calculationOptionsText: ""
  };
}

function hasDiagnosisInput(value) {
  return parseDiagnoses(value).length > 0;
}

function defaultClaimMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthlyPatientKey(patient = {}) {
  return patient.patientId || "unassigned";
}

function monthlyPatientMatchesFilter(patient = {}, filter = "all") {
  if (filter === "diagnosis") {
    return Boolean(patient.diagnosisRequestCandidate);
  }
  if (filter === "doctor") {
    return Boolean(patient.doctorConfirmationCandidate);
  }
  if (filter === "annotation") {
    return Number(patient.pendingReceiptAnnotationCount || 0) > 0;
  }
  if (filter === "blocked") {
    return Boolean(patient.blocked);
  }
  if (filter === "ready") {
    return Boolean(patient.readyForClaim);
  }
  if (filter === "uncalculated") {
    return Number(patient.uncalculatedCount || 0) > 0;
  }
  return true;
}

function monthlySessionStatusLabel(session = {}) {
  if (session.readiness?.readyForClaim) {
    return "提出候補";
  }
  if (session.readiness?.blocked) {
    return "要対応";
  }
  return statusLabel(session.status || "partial");
}

function monthlyBulkStatusLabel(status = "") {
  return {
    planned: "作成済み",
    running: "実行中",
    completed: "完了",
    completed_with_errors: "失敗あり",
    canceled: "キャンセル済み"
  }[status] || "未作成";
}

function monthlyBulkItemStatusLabel(status = "") {
  return {
    pending: "待機",
    queued: "投入済み",
    succeeded: "完了",
    failed: "失敗",
    skipped: "除外",
    canceled: "取消"
  }[status] || "未処理";
}

function defaultDiagnosisRequestReason(session = {}) {
  const issues = Array.isArray(session.readiness?.issues) ? session.readiness.issues : [];
  const missing = issues.find((issue) => issue.type === "missing_diagnosis");
  if (missing?.detail) {
    return missing.detail;
  }
  if (session.readiness?.missingDiagnosis) {
    return "算定根拠として使う病名が未入力です。";
  }
  return "";
}

function normalizeReceiptAnnotationsForClient(value = null) {
  return {
    comments: Array.isArray(value?.comments) ? value.comments : [],
    symptomDetails: Array.isArray(value?.symptomDetails) ? value.symptomDetails : []
  };
}

function upsertReceiptAnnotation(currentAnnotations = null, draft = {}) {
  const next = normalizeReceiptAnnotationsForClient(currentAnnotations);
  const kind = draft.kind === "comment" ? "comment" : "symptom_detail";
  const sourceReviewItemId = String(draft.sourceReviewItemId || "").trim();
  const listKey = kind === "comment" ? "comments" : "symptomDetails";
  const existing = [...next.comments, ...next.symptomDetails].find((entry) => (
    (draft.annotationId && entry.annotationId === draft.annotationId)
    || (sourceReviewItemId && entry.sourceReviewItemId === sourceReviewItemId)
  ));
  const annotationId = draft.annotationId || existing?.annotationId || `receipt_annotation_${Date.now()}`;
  const base = {
    annotationId,
    status: ["draft", "confirmed", "rejected"].includes(draft.status) ? draft.status : "draft",
    text: String(draft.text || "").trim(),
    sourceReviewItemId: sourceReviewItemId || undefined,
    sourceLabel: String(draft.sourceLabel || existing?.sourceLabel || "").trim() || undefined
  };
  const entry = kind === "comment"
    ? {
      ...base,
      shinryoIdentification: String(draft.shinryoIdentification || existing?.shinryoIdentification || "").trim(),
      code: String(draft.code || existing?.code || "").trim()
    }
    : {
      ...base,
      kubun: String(draft.kubun || existing?.kubun || "01").trim()
    };

  return {
    comments: (listKey === "comments" ? [...next.comments.filter((item) => item.annotationId !== annotationId && item.sourceReviewItemId !== sourceReviewItemId), entry] : next.comments.filter((item) => item.annotationId !== annotationId && item.sourceReviewItemId !== sourceReviewItemId)),
    symptomDetails: (listKey === "symptomDetails" ? [...next.symptomDetails.filter((item) => item.annotationId !== annotationId && item.sourceReviewItemId !== sourceReviewItemId), entry] : next.symptomDetails.filter((item) => item.annotationId !== annotationId && item.sourceReviewItemId !== sourceReviewItemId))
  };
}

function firstReceiptAnnotation(value = null) {
  const annotations = normalizeReceiptAnnotationsForClient(value);
  const comment = annotations.comments[0];
  if (comment) {
    return {
      kind: "comment",
      status: comment.status || "draft",
      code: comment.code || "",
      text: comment.text || ""
    };
  }
  const detail = annotations.symptomDetails[0];
  if (detail) {
    return {
      kind: "symptom_detail",
      status: detail.status || "draft",
      code: "",
      text: detail.text || ""
    };
  }
  return {};
}

function defaultReceiptAnnotationText(session = {}) {
  const issues = Array.isArray(session.readiness?.issues) ? session.readiness.issues : [];
  const target = issues.find((issue) => ["symptom_detail", "receipt_annotation", "review"].includes(issue.type));
  return target?.detail || "";
}

function monthlyReceiptAnnotationSourceId(session = {}) {
  return `monthly_${session.feeSessionId || session.serviceDate || "session"}`;
}

function defaultReceiptAnnotationTextForItem(item = {}) {
  item = item || {};
  return [
    item.displayReason,
    item.reasonText,
    item.reviewIssue?.messageForStaff,
    item.candidateProposal?.reason,
    reviewRequiredInput(item)
  ].map((value) => String(value || "").trim()).filter(Boolean)[0] || "";
}

function canCreateReceiptAnnotationFromItem(item = {}) {
  item = item || {};
  if (!item.reviewItemId) {
    return false;
  }
  const text = [
    item.displayTitle,
    item.displayReason,
    item.reasonText,
    item.reviewIssue?.messageForStaff,
    item.candidateProposal?.reason,
    reviewRequiredInput(item)
  ].join(" ");
  return item.kind === "issue" || /詳記|症状詳記|コメント|照会|返戻|査定/u.test(text);
}

function defaultPatientForm() {
  return {
    displayName: "",
    birthDate: "",
    sex: "unknown",
    patientRef: ""
  };
}

function defaultManualBillingItemDraft() {
  return {
    selectedItems: [],
    note: ""
  };
}

function manualBillingItemKey(item = {}) {
  return `${item.kind || "master"}:${item.code || item.name || ""}`;
}

function manualDraftSelectedItems(draft = {}) {
  if (Array.isArray(draft.selectedItems)) {
    return draft.selectedItems
      .map((entry) => {
        const item = entry?.item || entry?.masterItem || entry;
        if (!item || typeof item !== "object") {
          return null;
        }
        return {
          item,
          quantity: String(entry?.quantity || draft.quantity || "1")
        };
      })
      .filter((entry) => entry?.item && (entry.item.code || entry.item.name));
  }
  if (draft.masterItem) {
    return [{ item: draft.masterItem, quantity: String(draft.quantity || "1") }];
  }
  return [];
}

function appendManualBillingDraftItem(draft = {}, item = {}) {
  if (!item?.code && !item?.name) {
    return manualDraftSelectedItems(draft);
  }
  const current = manualDraftSelectedItems(draft);
  const itemKey = manualBillingItemKey(item);
  if (current.some((entry) => manualBillingItemKey(entry.item) === itemKey)) {
    return current;
  }
  return [...current, { item, quantity: "1" }];
}

function formFromFeeSession(session = {}) {
  const fallback = defaultFeeForm();
  const editableCalculationOptions = userEditableCalculationOptions(session);
  return {
    patientId: session.patientId || "",
    facilityId: session.facilityId || "",
    departmentId: session.departmentId || "",
    serviceDate: session.serviceDate || fallback.serviceDate,
    claimMonth: session.claimMonth || String(session.serviceDate || fallback.serviceDate).slice(0, 7),
    setting: session.setting || "outpatient",
    clinicalText: session.clinicalText || "",
    diagnosesText: formatDiagnoses(session.diagnoses),
    calculationOptionsText: formatJsonObject(editableCalculationOptions)
  };
}

function sessionListQuery({ page, search, status }) {
  const params = new URLSearchParams();
  params.set("page", String(page || 1));
  params.set("pageSize", String(FEE_SESSION_PAGE_SIZE));
  if (search?.trim()) {
    params.set("q", search.trim());
  }
  if (status && status !== "all") {
    params.set("status", status);
  }
  return `?${params.toString()}`;
}

function buildChartOnlyInput(form, orderRows, options = {}) {
  const clinicalTextChanged = Boolean(options.clinicalTextBaselineHash)
    && options.clinicalTextBaselineHash !== clinicalTextHash(form.clinicalText);
  const shouldIgnoreSavedRows = clinicalTextChanged && !options.orderRowsTouched;
  const manualOrderRows = shouldIgnoreSavedRows
    ? []
    : orderRows.filter((row) => !isAutoPlaceholderOrderRow(row));
  const hasManualOrders = parseOrdersFromRows(manualOrderRows).length > 0;
  const derivedOrderRows = hasManualOrders ? [] : deriveOrderRowsFromClinicalText(form.clinicalText);
  const diagnosesText = String(form.diagnosesText || "").trim() || deriveDiagnosesTextFromClinicalText(form.clinicalText);
  return {
    diagnosesText,
    orderRows: hasManualOrders || !derivedOrderRows.length ? manualOrderRows : derivedOrderRows
  };
}

function deriveOrderRowsFromClinicalText(value) {
  const text = normalizeClinicalText(value);
  if (!text) {
    return [];
  }
  return [];
}

function isAutoPlaceholderOrderRow(row = {}) {
  const name = String(row.localName || "").trim();
  const code = String(row.standardCode || "").trim();
  return !code && AUTO_PLACEHOLDER_ORDER_NAMES.has(name);
}

function deriveDiagnosesTextFromClinicalText(value) {
  const text = normalizeClinicalText(value);
  if (!text) {
    return "";
  }
  const explicitDiagnosis = text.match(/(?:病名|診断)[:：\s]+([^\n]+)/u)?.[1]?.trim();
  if (explicitDiagnosis) {
    return explicitDiagnosis;
  }
  return "";
}

function normalizeClinicalText(value) {
  return String(value || "").trim();
}

function clinicalTextHash(value) {
  const text = normalizeClinicalText(value).replace(/\r\n?/gu, "\n");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return text ? `ui_${Math.abs(hash).toString(36)}` : "";
}

function canReuseClinicalCalculationForManualChange({
  feeSession = null,
  form = {},
  nextForm = form,
  defaultFacilityId = null,
  clinicalTextBaselineHash = ""
} = {}) {
  if (!feeSession?.calculationResult || !feeSession?.calculationOptions) {
    return false;
  }
  const formForCalculation = nextForm || form || {};
  const currentClinicalHash = clinicalTextHash(formForCalculation.clinicalText || "");
  if (!clinicalTextBaselineHash || currentClinicalHash !== clinicalTextBaselineHash) {
    return false;
  }
  const expectedFacilityId = formForCalculation.facilityId || defaultFacilityId || null;
  const comparisons = [
    [formForCalculation.patientId || null, feeSession.patientId || null],
    [expectedFacilityId, feeSession.facilityId || null],
    [formForCalculation.departmentId || null, feeSession.departmentId || null],
    [formForCalculation.serviceDate || null, feeSession.serviceDate || null],
    [formForCalculation.claimMonth || null, feeSession.claimMonth || null],
    [formForCalculation.setting || "outpatient", feeSession.setting || "outpatient"]
  ];
  return comparisons.every(([left, right]) => String(left || "") === String(right || ""));
}

function parseDiagnoses(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split("|").map((part) => part.trim());
      return {
        diagnosisId: `ui_diagnosis_${index + 1}`,
        name: parts[0],
        icd10Code: parts[1] || undefined,
        outcome: "unknown",
        isPrimary: index === 0
      };
    });
}

function formatDiagnoses(diagnoses) {
  if (!Array.isArray(diagnoses) || !diagnoses.length) {
    return "";
  }
  return diagnoses.map((diagnosis) => [
    diagnosis.name || "",
    diagnosis.icd10Code || diagnosis.icd10_code || ""
  ].filter(Boolean).join("|")).join("\n");
}

function parseOrdersFromRows(rows) {
  return rows
    .map((row) => ({
      orderType: row.orderType || "procedure",
      localName: String(row.localName || "").trim(),
      standardCode: String(row.standardCode || "").trim(),
      standardName: String(row.standardName || "").trim(),
      quantity: String(row.quantity || "1").trim() || "1",
      sourceSystem: String(row.sourceSystem || "").trim(),
      sourceLabel: String(row.sourceLabel || "").trim(),
      note: String(row.note || "").trim(),
      createdAt: String(row.createdAt || "").trim(),
      createdBy: String(row.createdBy || "").trim()
    }))
    .filter((row) => !isAutoPlaceholderOrderRow(row))
    .filter((row) => row.localName || row.standardCode)
    .map((row, index) => ({
      orderId: `ui_order_${index + 1}`,
      orderType: row.orderType,
      localName: row.localName || row.standardCode,
      standardCode: row.standardCode || undefined,
      standardName: row.standardName || undefined,
      quantity: Number(row.quantity || 1),
      sourceSystem: row.sourceSystem || undefined,
      sourceLabel: row.sourceLabel || undefined,
      note: row.note || undefined,
      createdAt: row.createdAt || undefined,
      createdBy: row.createdBy || undefined
    }));
}

function orderRowsFromOrders(orders) {
  if (!Array.isArray(orders) || !orders.length) {
    return [createEmptyOrderRow()];
  }
  return orders.map((order) => ({
    orderType: order.orderType || "procedure",
    localName: order.localName || order.standardName || order.content || "",
    standardCode: order.standardCode || order.localCode || "",
    standardName: order.standardName || "",
    quantity: String(order.quantity || "1"),
    sourceSystem: order.sourceSystem || order.source_system || "",
    sourceLabel: order.sourceLabel || order.source_label || "",
    note: order.note || "",
    createdAt: order.createdAt || order.created_at || "",
    createdBy: order.createdBy || order.created_by || ""
  }));
}

function createEmptyOrderRow() {
  return {
    orderType: "procedure",
    localName: "",
    standardCode: "",
    standardName: "",
    quantity: "1",
    sourceSystem: "",
    sourceLabel: "",
    note: "",
    createdAt: "",
    createdBy: ""
  };
}

function calculationOptionsTextWithComment(value, item = {}) {
  const options = parseJsonObjectField(value, "算定オプション JSON") || {};
  const commentInputs = Array.isArray(options.comment_inputs) ? options.comment_inputs : [];
  if (!commentInputs.some((comment) => String(comment.code || "") === String(item.code || ""))) {
    options.comment_inputs = [
      ...commentInputs,
      {
        code: item.code,
        text: item.name || ""
      }
    ];
  }
  return formatJsonObject(options);
}

function manualBillingOrderEntries(rows = []) {
  return rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => String(row?.sourceSystem || row?.source_system || "") === "fee_web_user_added");
}

function manualBillingDuplicateReason({ item = {}, orderRows = [], receiptDraft = null } = {}) {
  const code = String(item.code || "").trim();
  if (!code || item.kind === "comment") {
    return "";
  }
  const existingManual = orderRows.some((row) => String(row.standardCode || row.standard_code || "").trim() === code);
  if (existingManual) {
    return "同じコードが手入力明細に既に追加されています。数量を変更するか、既存の明細を削除してください。";
  }
  if (receiptDraftLineCodes(receiptDraft).has(code)) {
    return "同じコードが現在のレセプト案に既に含まれています。二重算定を避けるため追加できません。";
  }
  return "";
}

function manualBillingBatchDuplicateReason({ entries = [], orderRows = [], receiptDraft = null } = {}) {
  const seen = new Set();
  for (const entry of entries) {
    const item = entry?.item || {};
    const code = String(item.code || "").trim();
    if (code && item.kind !== "comment") {
      if (seen.has(code)) {
        return "同じコードが追加内容に複数含まれています。数量を調整するか、重複した選択を解除してください。";
      }
      seen.add(code);
    }
    const duplicate = manualBillingDuplicateReason({ item, orderRows, receiptDraft });
    if (duplicate) {
      return duplicate;
    }
  }
  return "";
}

function receiptDraftLineCodes(receiptDraft = null) {
  const codes = new Set();
  const collect = (line = {}) => {
    const code = String(line.code || line.masterCode || line.master_code || line.standardCode || line.standard_code || "").trim();
    if (code) {
      codes.add(code);
    }
  };
  if (Array.isArray(receiptDraft?.lines)) {
    receiptDraft.lines.forEach(collect);
  }
  if (Array.isArray(receiptDraft?.lineGroups)) {
    for (const group of receiptDraft.lineGroups) {
      if (Array.isArray(group?.lines)) {
        group.lines.forEach(collect);
      }
    }
  }
  return codes;
}

function parseJsonObjectField(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}がJSONとして正しくありません。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}はJSON objectで入力してください。`);
  }
  return parsed;
}

function formatJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function outpatientBasicKindFromOptionsText(value = "") {
  try {
    const options = parseJsonObjectField(value, "算定オプション JSON") || {};
    const kind = String(options.outpatient_basic?.fee_kind || "").trim();
    return ["initial", "revisit"].includes(kind) ? kind : "";
  } catch {
    return "";
  }
}

function userEditableCalculationOptions(session = {}) {
  if (!session.calculationOptions || typeof session.calculationOptions !== "object" || Array.isArray(session.calculationOptions)) {
    return null;
  }
  const source = String(session.calculationOptionsSource || "").trim();
  if (source === "clinical_auto") {
    return null;
  }
  const autoKeys = Array.isArray(session.calculationOptionsAutoKeys)
    ? session.calculationOptionsAutoKeys
    : source
      ? []
      : [...CLINICAL_AUTO_CALCULATION_OPTION_KEYS];
  const result = Object.fromEntries(
    Object.entries(session.calculationOptions).filter(([key]) => !autoKeys.includes(key))
  );
  return Object.keys(result).length ? result : null;
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function totalPointsLabel(session) {
  const totalPoints = session.calculationSummary?.totalPoints;
  return totalPoints === undefined || totalPoints === null ? "未算定" : `${Number(totalPoints).toLocaleString()}点`;
}

function reviewLabel(session) {
  const count = Number(session.calculationSummary?.reviewLineCount || 0);
  return count ? `レビュー ${count.toLocaleString()}件` : "レビューなし";
}

function buildClientCalculationProgress({
  phase = "extract",
  percent = 10,
  message = ""
} = {}) {
  return {
    phase,
    label: calculationPhaseLabel(phase),
    message,
    percent,
    updatedAt: new Date().toISOString(),
    diagnoses: [],
    extractedOrders: [],
    lineItems: []
  };
}

function normalizeCalculationProgress(progress) {
  if (!progress || typeof progress !== "object") {
    return buildClientCalculationProgress({
      phase: "extract",
      percent: 10,
      message: "カルテ本文から算定に必要な情報を抽出しています。"
    });
  }
  const phase = String(progress.phase || "extract");
  return {
    phase,
    label: progress.label || calculationPhaseLabel(phase),
    message: progress.message || "算定候補を作成しています。",
    percent: Number(progress.percent || 0),
    diagnoses: asStringList(progress.diagnoses),
    extractedOrders: asStringList(progress.extractedOrders),
    lineItems: asStringList(progress.lineItems),
    totalPoints: progress.totalPoints,
    updatedAt: progress.updatedAt || ""
  };
}

function calculationPhaseLabel(phase) {
  return {
    extract: "抽出中",
    calculate: "算定中",
    aggregate: "集計中",
    complete: "完了",
    failed: "失敗"
  }[phase] || "算定中";
}

function progressStepClass(step, current) {
  const order = ["extract", "calculate", "aggregate", "complete"];
  const stepIndex = order.indexOf(step);
  const currentIndex = order.indexOf(current);
  if (current === "failed") return stepIndex <= 0 ? "is-current" : "";
  if (step === current) return "is-current";
  if (stepIndex >= 0 && currentIndex >= 0 && stepIndex < currentIndex) return "is-done";
  return "";
}

function asStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function projectPendingReviewDecisions({
  feeSession,
  receiptDraft,
  candidateWorkbench,
  pendingReviewDecisions = {}
} = {}) {
  const entries = Object.entries(pendingReviewDecisions)
    .filter(([reviewItemId, decision]) => reviewItemId && decision?.status);
  if (!entries.length) {
    return {
      feeSession,
      receiptDraft,
      candidateWorkbench,
      pendingCount: 0
    };
  }
  const decisionById = new Map(entries.map(([reviewItemId, decision]) => [reviewItemId, decision]));
  const nextFeeSession = feeSession
    ? {
      ...feeSession,
      reviewDecisions: {
        ...(feeSession.reviewDecisions || {})
      }
    }
    : feeSession;
  if (nextFeeSession) {
    for (const [reviewItemId, decision] of entries) {
      nextFeeSession.reviewDecisions[reviewItemId] = {
        ...(nextFeeSession.reviewDecisions[reviewItemId] || {}),
        status: decision.status,
        decidedAt: decision.decidedAt
      };
    }
  }
  const nextReceiptDraft = projectReceiptDraftForReviewDecisions(receiptDraft, candidateWorkbench, decisionById);
  const nextCandidateWorkbench = projectCandidateWorkbenchForReviewDecisions(candidateWorkbench, nextReceiptDraft, decisionById);
  return {
    feeSession: nextFeeSession,
    receiptDraft: nextReceiptDraft,
    candidateWorkbench: nextCandidateWorkbench,
    pendingCount: entries.length
  };
}

function projectReceiptDraftForReviewDecisions(receiptDraft, candidateWorkbench, decisionById) {
  if (!receiptDraft) {
    return receiptDraft;
  }
  const sourceLines = receiptDraftLines(receiptDraft);
  let lines = sourceLines.map((line) => ({ ...line }));
  const workbenchItems = candidateWorkbenchItems(candidateWorkbench);
  for (const item of workbenchItems.filter((entry) => entry.kind === "line")) {
    const decision = decisionById.get(item.reviewItemId);
    if (!decision?.status) {
      continue;
    }
    let matched = false;
    lines = lines.map((line) => {
      if (!receiptLineMatchesCandidateItem(line, item)) {
        return line;
      }
      matched = true;
      return projectReceiptLineDecision(line, decision.status);
    });
    if (!matched && decision.status === "approved") {
      lines.push(projectReceiptLineDecision(receiptLineFromCandidateLineItem(item), "approved"));
    }
  }
  for (const item of workbenchItems.filter((entry) => entry.kind === "proposal")) {
    const decision = decisionById.get(item.reviewItemId);
    if (!decision?.status) {
      continue;
    }
    const existingIndex = lines.findIndex((line) => receiptLineMatchesCandidateItem(line, item));
    if (decision.status === "approved") {
      const nextLine = projectReceiptLineDecision(receiptLineFromProposalItem(item, existingIndex), "approved");
      if (existingIndex >= 0) {
        lines[existingIndex] = {
          ...lines[existingIndex],
          ...nextLine,
          receiptLineId: lines[existingIndex].receiptLineId || nextLine.receiptLineId
        };
      } else {
        lines.push(nextLine);
      }
    } else if (existingIndex >= 0) {
      lines[existingIndex] = projectReceiptLineDecision(lines[existingIndex], decision.status);
    }
  }
  lines = uniqueReceiptLines(lines);
  const includedLines = lines.filter((line) => line.includedInTotal !== false);
  const totalPoints = includedLines.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0);
  return {
    ...receiptDraft,
    totalPoints,
    billing: projectBillingSummary(receiptDraft.billing, totalPoints),
    lines,
    lineGroups: groupReceiptDraftLines(includedLines)
  };
}

function projectCandidateWorkbenchForReviewDecisions(candidateWorkbench, receiptDraft, decisionById) {
  if (!candidateWorkbench) {
    return candidateWorkbench;
  }
  const model = normalizeCandidateWorkbenchModel(candidateWorkbench);
  const baseLines = uniqueCandidateLines([
    ...model.lines,
    ...model.includedLines,
    ...model.pendingLines,
    ...model.excludedLines
  ]);
  let lines = baseLines.map((line) => {
    const decision = decisionById.get(line.reviewItemId);
    return decision?.status ? projectCandidateLineDecision(line, decision.status) : line;
  });
  const proposals = model.proposals
    .map((item) => {
      const decision = decisionById.get(item.reviewItemId);
      return decision?.status ? { ...item, decisionStatus: decision.status, status: decision.status } : item;
    })
    .filter((item) => reviewDecisionStatusValue(item) !== "approved");
  for (const item of model.proposals) {
    const decision = decisionById.get(item.reviewItemId);
    if (decision?.status !== "approved") {
      continue;
    }
    lines.push(candidateLineFromProposalItem(item, receiptDraft));
  }
  lines = uniqueCandidateLines(lines);
  const includedLines = lines.filter((line) => line.inclusionStatus === "included");
  const pendingLines = lines.filter((line) => line.inclusionStatus === "pending");
  const excludedLines = lines.filter((line) => line.inclusionStatus === "excluded");
  const issues = Array.isArray(model.issues) ? model.issues : [];
  const hiddenIssues = Array.isArray(model.hiddenIssues) ? model.hiddenIssues : [];
  const potentialPointsTotal = proposals
    .filter((item) => reviewDecisionStatusValue(item) !== "rejected")
    .reduce((sum, item) => sum + Number(item.potentialPoints || item.candidateLine?.totalPoints || 0), 0);
  return {
    ...model,
    totalPoints: Number(receiptDraft?.totalPoints ?? model.totalPoints ?? 0),
    includedTotalPoints: Number(receiptDraft?.totalPoints ?? model.includedTotalPoints ?? model.totalPoints ?? 0),
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    proposals,
    issues,
    hiddenIssues,
    counts: {
      included: includedLines.length,
      pending: pendingLines.length,
      excluded: excludedLines.length,
      hidden: hiddenIssues.length,
      proposals: proposals.length,
      issues: issues.length,
      needsReview: issues.length + pendingLines.length + proposals.length
    },
    includedCount: includedLines.length,
    pendingCount: pendingLines.length,
    excludedCount: excludedLines.length,
    hiddenIssueCount: hiddenIssues.length,
    needsReviewCount: issues.length + pendingLines.length + proposals.length,
    potentialPointsTotal
  };
}

function candidateWorkbenchItems(workbench = {}) {
  const model = workbench ? normalizeCandidateWorkbenchModel(workbench) : emptyCandidateWorkbenchModel();
  return [
    ...model.includedLines,
    ...model.pendingLines,
    ...model.excludedLines,
    ...model.proposals,
    ...model.issues
  ].filter((item) => item?.reviewItemId);
}

function findCandidateWorkbenchItemByReviewItemId(workbench = {}, reviewItemId = "") {
  if (!reviewItemId) {
    return null;
  }
  return candidateWorkbenchItems(workbench).find((item) => item.reviewItemId === reviewItemId) || null;
}

function reviewDecisionStatusValue(item = {}) {
  return String(item.decisionStatus || item.status || "").trim();
}

function receiptDraftLines(receiptDraft = {}) {
  if (Array.isArray(receiptDraft.lines)) {
    return receiptDraft.lines;
  }
  return Array.isArray(receiptDraft.lineGroups)
    ? receiptDraft.lineGroups.flatMap((group) => Array.isArray(group.lines) ? group.lines : [])
    : [];
}

function receiptLineMatchesCandidateItem(line = {}, item = {}) {
  if (line.reviewItemId && item.reviewItemId && line.reviewItemId === item.reviewItemId) {
    return true;
  }
  if (line.receiptLineId && item.receiptLineId && line.receiptLineId === item.receiptLineId) {
    return true;
  }
  if (line.sourceLineId && item.sourceLineId && line.sourceLineId === item.sourceLineId) {
    return true;
  }
  if (line.sourceProposalId && item.candidateProposal?.proposalId && line.sourceProposalId === item.candidateProposal.proposalId) {
    return true;
  }
  const candidateLine = item.candidateLine || item.candidateProposal?.candidateLine || item.lineItem || {};
  if (line.sourceLineId && candidateLine.lineId && line.sourceLineId === candidateLine.lineId) {
    return true;
  }
  return Boolean(line.code || item.code || candidateLine.code)
    && String(line.code || "") === String(item.code || candidateLine.code || "")
    && normalizeSearchText(line.name || "") === normalizeSearchText(item.name || item.displayTitle || candidateLine.name || "")
    && String(line.orderType || "") === String(item.orderType || candidateLine.orderType || "");
}

function projectReceiptLineDecision(line = {}, status = "") {
  const approved = decisionSelectValue(status) === "approved";
  return {
    ...line,
    decisionStatus: approved ? "approved" : "rejected",
    inclusionStatus: approved ? "included" : "excluded",
    includedInTotal: approved
  };
}

function projectCandidateLineDecision(line = {}, status = "") {
  const approved = decisionSelectValue(status) === "approved";
  return {
    ...line,
    decisionStatus: approved ? "approved" : "rejected",
    status: approved ? "approved" : "rejected",
    inclusionStatus: approved ? "included" : "excluded"
  };
}

function receiptLineFromProposalItem(item = {}, index = 0) {
  const candidateLine = item.candidateLine || item.candidateProposal?.candidateLine || {};
  const proposal = item.candidateProposal || {};
  const points = Number(candidateLine.points || item.potentialPoints || proposal.potentialPoints || 0);
  const quantity = Number(candidateLine.quantity || 1);
  const totalPoints = Number(candidateLine.totalPoints || item.potentialPoints || proposal.potentialPoints || points * quantity || 0);
  return {
    receiptLineId: `proposal_${proposal.proposalId || item.reviewItemId || index + 1}`,
    sourceLineId: candidateLine.lineId || null,
    sourceProposalId: proposal.proposalId || null,
    reviewItemId: item.reviewItemId || null,
    code: candidateLine.code || item.code || proposal.code || null,
    name: candidateLine.name || item.displayTitle || item.name || proposal.title || "増点提案",
    orderType: candidateLine.orderType || item.orderType || proposal.orderType || "other",
    points,
    quantity,
    totalPoints,
    status: candidateLine.status || "candidate",
    source: candidateLine.source || proposal.source || "candidate_proposal",
    coverage: candidateLine.coverage || null,
    supportLevel: candidateLine.supportLevel || "candidate",
    reviewRequired: true
  };
}

function receiptLineFromCandidateLineItem(item = {}) {
  const line = item.lineItem || {};
  const points = Number(line.points || item.points || 0);
  const quantity = Number(line.quantity || 1);
  const totalPoints = Number(line.totalPoints || item.totalPoints || points * quantity || 0);
  return {
    receiptLineId: item.receiptLineId || line.lineId || item.reviewItemId,
    sourceLineId: item.sourceLineId || line.lineId || null,
    reviewItemId: item.reviewItemId || null,
    code: line.code || item.code || null,
    name: line.name || item.name || item.displayTitle || "算定候補",
    orderType: line.orderType || item.orderType || "other",
    points,
    quantity,
    totalPoints,
    status: line.status || "candidate",
    source: line.source || "fee-core",
    coverage: line.coverage || null,
    supportLevel: line.supportLevel || "candidate",
    reviewRequired: line.reviewRequired ?? item.reviewRequired ?? true
  };
}

function candidateLineFromProposalItem(item = {}, receiptDraft = {}) {
  const receiptLine = receiptDraftLines(receiptDraft).find((line) => receiptLineMatchesCandidateItem(line, item));
  const candidateLine = item.candidateLine || item.candidateProposal?.candidateLine || {};
  const orderType = receiptLine?.orderType || candidateLine.orderType || item.orderType || "other";
  const totalPoints = Number(receiptLine?.totalPoints || candidateLine.totalPoints || item.potentialPoints || 0);
  const code = receiptLine?.code || candidateLine.code || item.code || null;
  return {
    kind: "line",
    kindLabel: "算定中の明細",
    reviewItemId: item.reviewItemId,
    sourceReviewItemId: item.reviewItemId,
    receiptLineId: receiptLine?.receiptLineId || `proposal_${item.candidateProposal?.proposalId || item.reviewItemId}`,
    sourceLineId: receiptLine?.sourceLineId || candidateLine.lineId || null,
    name: receiptLine?.name || candidateLine.name || item.displayTitle || item.name || "増点提案",
    displayTitle: receiptLine?.name || candidateLine.name || item.displayTitle || item.name || "増点提案",
    displayReason: item.displayReason || item.reasonText || "条件を確認して算定に含めました。",
    conditionText: item.conditionText || "採用済みの算定候補です。",
    decisionStatus: "approved",
    status: "approved",
    inclusionStatus: "included",
    metaLabel: code ? `${code} / ${orderTypeLabel(orderType)}` : orderTypeLabel(orderType),
    statusLabel: "算定中",
    totalPoints,
    pointsLabel: `${totalPoints.toLocaleString()}点`,
    code,
    orderType,
    businessCategory: orderTypeLabel(orderType),
    reviewRequired: true,
    sourceProposalId: item.candidateProposal?.proposalId || null,
    candidateLine,
    candidateProposal: item.candidateProposal || null
  };
}

function uniqueReceiptLines(lines = []) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = [
      line.reviewItemId || "",
      line.receiptLineId || "",
      line.sourceProposalId || "",
      line.sourceLineId || "",
      line.code || "",
      normalizeSearchText(line.name || ""),
      line.orderType || ""
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}

function groupReceiptDraftLines(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.orderType || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: key,
        label: orderTypeLabel(key),
        totalPoints: 0,
        lines: []
      });
    }
    const group = groups.get(key);
    group.totalPoints += Number(line.totalPoints || 0);
    group.lines.push(line);
  }
  return [...groups.values()];
}

function projectBillingSummary(billing = {}, totalPoints = 0) {
  if (!billing || typeof billing !== "object") {
    return billing;
  }
  const totalFee = Number(totalPoints || 0) * 10;
  const burdenRatio = typeof billing.burdenRatio === "number" ? billing.burdenRatio : null;
  const copay = burdenRatio === null ? billing.copay : Math.round((totalFee * burdenRatio) / 10) * 10;
  return {
    ...billing,
    totalPoints,
    totalFee,
    copay,
    insurerPay: typeof copay === "number" ? totalFee - copay : billing.insurerPay
  };
}

function normalizeCandidateWorkbenchModel(model = {}) {
  const lines = Array.isArray(model.lines) ? model.lines : [];
  const rawIncludedLines = Array.isArray(model.includedLines)
    ? model.includedLines
    : lines.filter((line) => line.inclusionStatus !== "pending" && line.inclusionStatus !== "excluded");
  const rawPendingLines = Array.isArray(model.pendingLines)
    ? model.pendingLines
    : lines.filter((line) => line.inclusionStatus === "pending");
  const rawExcludedLines = Array.isArray(model.excludedLines)
    ? model.excludedLines
    : lines.filter((line) => line.inclusionStatus === "excluded");
  const rejectedLines = uniqueCandidateLines([
    ...rawPendingLines,
    ...rawExcludedLines,
    ...lines
  ].filter((line) => decisionSelectValue(line?.decisionStatus) === "rejected"));
  const includedLines = uniqueCandidateLines([...rawIncludedLines, ...rejectedLines]);
  const pendingLines = rawPendingLines.filter((line) => decisionSelectValue(line?.decisionStatus) !== "rejected");
  const excludedLines = rawExcludedLines.filter((line) => decisionSelectValue(line?.decisionStatus) !== "rejected");
  const proposals = Array.isArray(model.proposals) ? model.proposals : [];
  const issues = Array.isArray(model.issues)
    ? model.issues.filter((item) => item?.hiddenFromWorkspace !== true && item?.bucket !== "hidden")
    : [];
  const hiddenIssues = Array.isArray(model.hiddenIssues) ? model.hiddenIssues : [];
  const rawCounts = model.counts && typeof model.counts === "object" ? model.counts : {};
  const includedCount = includedLines.length;
  const pendingCount = pendingLines.length;
  const excludedCount = excludedLines.length;
  const proposalCount = proposals.length;
  const issueCount = issues.length;
  const needsReview = issueCount + pendingCount;
  const potentialPointsTotal = Number(model.potentialPointsTotal ?? 0);
  return {
    ...model,
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    proposals,
    issues,
    hiddenIssues,
    counts: {
      included: includedCount,
      pending: pendingCount,
      excluded: excludedCount,
      hidden: hiddenIssues.length,
      proposals: proposalCount,
      issues: issueCount,
      needsReview
    },
    includedCount,
    pendingCount,
    excludedCount,
    hiddenIssueCount: hiddenIssues.length,
    needsReviewCount: needsReview,
    potentialPointsTotal,
    coverageSummary: model.coverageSummary || null,
    includedTotalPoints: Number(model.includedTotalPoints ?? model.totalPoints ?? 0)
  };
}

function uniqueCandidateLines(lines = []) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = String(line?.reviewItemId || line?.receiptLineId || line?.sourceLineId || line?.code || line?.name || result.length);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}

function emptyCandidateWorkbenchModel({ calculation } = {}) {
  const totalPoints = Number(calculation?.totalPoints || 0);
  return {
    schemaVersion: 1,
    totalPoints,
    includedTotalPoints: totalPoints,
    lines: [],
    includedLines: [],
    pendingLines: [],
    excludedLines: [],
    hiddenIssues: [],
    proposals: [],
    issues: [],
    counts: {
      included: 0,
      pending: 0,
      excluded: 0,
      hidden: 0,
      proposals: 0,
      issues: 0,
      needsReview: 0
    },
    coverageSummary: {
      title: "候補化済み部分合計",
      description: "算定候補の表示モデルを取得できませんでした。再度「カルテから算定候補を作成」を実行してください。"
    },
    potentialPointsTotal: 0
  };
}

function statusLabel(value) {
  return ({
    active: "作成中",
    calculating: "計算中",
    review: "確認待ち",
    calculated: "算定候補作成済み",
    failed: "要確認",
    draft: "作成中",
    ready: "準備完了",
    needs_review: "要確認",
    completed: "完了",
    candidate: "候補",
    confirmed: "確認済み",
    approved: "算定する",
    rejected: "算定しない",
    edited: "確認中",
    not_calculated: "未算定"
  })[value] || value || "-";
}

function orderTypeLabel(value = "") {
  return ORDER_TYPE_OPTIONS.find(([key]) => key === value)?.[1] || "";
}

function supportLevelLabel(level) {
  return ({
    supported: "対応済み",
    partial: "部分対応",
    candidate: "候補",
    review_required: "要確認",
    unsupported: "未対応"
  })[level] || level || "部分対応";
}

function scopeLabel(scope) {
  return ({
    candidate_review_support: "算定候補・レビュー支援",
    master_lookup_only: "マスター照合のみ",
    deterministic_rule: "ルール対応",
    candidate_rule: "候補ルール",
    review_required: "要確認"
  })[scope] || scope || "算定候補・レビュー支援";
}

function coverageLabel(coverage = {}) {
  if (!coverage || typeof coverage !== "object") {
    return "対応範囲: 部分対応";
  }
  return [
    scopeLabel(coverage.scope),
    supportLevelLabel(coverage.supportLevel || coverage.support_level),
    coverage.reviewRequired || coverage.review_required ? "レビュー必要" : "レビュー任意"
  ].join(" / ");
}

function badgeClass(status) {
  if (["needs_review", "candidate", "rejected", "review", "failed"].includes(status)) {
    return "badge review";
  }
  if (["confirmed", "approved", "calculated", "completed", "ready", "active", "calculating"].includes(status)) {
    return "badge supported";
  }
  return "badge partial";
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function orderTypeFromMasterKind(kind) {
  return {
    procedure: "procedure",
    drug: "drug",
    material: "material"
  }[kind] || "procedure";
}

function masterKindLabel(kind) {
  return {
    procedure: "診療行為",
    drug: "薬剤",
    material: "特定器材",
    comment: "コメント"
  }[kind] || "マスター";
}

function masterSourceLabel(item = {}) {
  return [
    item.sourceVersion ? `版 ${item.sourceVersion}` : "",
    item.publishedAt ? `公開 ${item.publishedAt}` : "",
    item.effectiveFrom ? `有効 ${item.effectiveFrom}${item.effectiveTo ? `-${item.effectiveTo}` : ""}` : ""
  ].filter(Boolean).join(" / ") || "マスター情報";
}

function buildPageItems(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const items = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push("ellipsis");
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

function groupFeeSessionsByDay(sessions = []) {
  const groups = new Map();
  for (const session of sessions) {
    const dayKey = getTokyoDayKey(session.createdAt || session.serviceDate) || "日付未設定";
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
  if (dayKey === todayKey) return "今日";
  if (dayKey === yesterdayKey) return "昨日";
  return dayKey;
}

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

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function patientFromSessionSnapshot(feeSession = {}, patientId = "") {
  const snapshot = feeSession?.patientSnapshot;
  const id = patientId || feeSession?.patientId || snapshot?.patientId || "";
  if (!snapshot || !id) {
    return null;
  }
  return {
    ...snapshot,
    patientId: id,
    displayName: snapshot.displayName || snapshot.name || "患者名未入力",
    patientCode: snapshot.patientCode || snapshot.primaryPatientNumber || snapshot.patientRef || "",
    primaryPatientNumber: snapshot.primaryPatientNumber || snapshot.patientCode || snapshot.patientRef || "",
    externalPatientIds: Array.isArray(snapshot.externalPatientIds) ? snapshot.externalPatientIds : []
  };
}

function mergeSelectedPatient(patients = [], selectedPatient = null) {
  const list = Array.isArray(patients) ? patients : [];
  if (!selectedPatient?.patientId || list.some((patient) => patient.patientId === selectedPatient.patientId)) {
    return list;
  }
  return [selectedPatient, ...list];
}

function shouldFetchPatientSearch(value = "") {
  const query = String(value || "").trim();
  if (!query) {
    return true;
  }
  const normalized = normalizeSearch(query);
  if (!normalized) {
    return false;
  }
  return /[0-9a-z]/u.test(normalized) || [...normalized].length >= 2;
}

function normalizePatientSearchCacheKey(value = "") {
  const query = String(value || "").trim();
  return query ? `q:${normalizeSearch(query)}` : "recent";
}

function prunePatientSearchCache(cache) {
  if (!cache || cache.size <= 30) {
    return;
  }
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (!value || value.expiresAt <= now) {
      cache.delete(key);
    }
  }
  while (cache.size > 30) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function pruneMasterSearchCache(cache) {
  if (!cache || cache.size <= 50) {
    return;
  }
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (!value || value.expiresAt <= now) {
      cache.delete(key);
    }
  }
  while (cache.size > 50) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

// toUserFacingErrorMessage は @halunasu/web-ui に一本化(ステップ1)。
