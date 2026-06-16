"use client";

import { clinicalAutoCalculationOptionKeys } from "@halunasu/fee-contracts";
import * as SelectPrimitive from "@radix-ui/react-select";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlatformAuth } from "./platform-auth";

const FEE_SESSION_PAGE_SIZE = 20;
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

  return <FeeSessionListView />;
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
  const [newPatient, setNewPatient] = useState(defaultPatientForm);
  const [patientPickerOpen, setPatientPickerOpen] = useState(false);
  const [masterType, setMasterType] = useState("procedure");
  const [masterQuery, setMasterQuery] = useState("");
  const [masterItems, setMasterItems] = useState([]);
  const [selectedMasterIndex, setSelectedMasterIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [autoSaveStatus, setAutoSaveStatus] = useState("saved");
  const [autoSaveError, setAutoSaveError] = useState("");
  const [candidateDetail, setCandidateDetail] = useState(null);
  const [settingsModalMode, setSettingsModalMode] = useState(null);
  const [manualItemModalOpen, setManualItemModalOpen] = useState(false);
  const [manualItemDraft, setManualItemDraft] = useState(defaultManualBillingItemDraft);
  const [activeMainTab, setActiveMainTab] = useState("work");
  const [activeWorkTab, setActiveWorkTab] = useState("candidates");
  const suppressAutoSaveRef = useRef(false);
  const autoSaveTimerRef = useRef(null);
  const pendingAutoSaveRef = useRef(null);
  const bootstrapLoadedRef = useRef(false);
  const toastTimersRef = useRef(new Map());
  const toastExitTimersRef = useRef(new Map());

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
  const filteredPatients = useMemo(() => {
    const keyword = normalizeSearch(patientFilter);
    if (!keyword) {
      return patients;
    }
    return patients.filter((patient) => normalizeSearch([
      patient.displayName,
      patient.patientId,
      patient.primaryPatientNumber,
      ...(Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds : [])
    ].join(" ")).includes(keyword));
  }, [patientFilter, patients]);

  const defaultFacilityId = facilities.length === 1 ? facilities[0].facilityId : "";
  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.patientId === form.patientId)
      || patientFromSessionSnapshot(feeSession, form.patientId),
    [feeSession, form.patientId, patients]
  );

  const applyDetail = useCallback((detail) => {
    suppressAutoSaveRef.current = true;
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
    });
    setAutoSaveStatus("saved");
    setAutoSaveError("");
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
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (patientFilter.trim()) {
          params.set("q", patientFilter.trim());
        }
        const response = await feeApi(`/v1/fee/patients?${params.toString()}`);
        if (!cancelled) {
          setPatients(mergeSelectedPatient(response.patients || [], patientFromSessionSnapshot(feeSession, form.patientId)));
        }
      } catch {
        // Patient search is advisory; keep the current list if the request fails.
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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
    if (!masterSearchAvailable) {
      setMasterItems([]);
      return undefined;
    }
    const query = masterQuery.trim();
    if (query.length < 2) {
      setMasterItems([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          type: masterType || "all",
          q: query,
          limit: "10"
        });
        const response = await feeApi(`/v1/fee/master/search?${params.toString()}`);
        setMasterItems(response.items || []);
        setMasterStatus(response.masterStatus || masterStatus);
      } catch (error) {
        addToast(toUserFacingErrorMessage(error, "マスター検索に失敗しました。"), "error");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [addToast, feeApi, masterQuery, masterSearchAvailable, masterStatus, masterType]);

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
      diagnosesTouched,
      orderRowsTouched: options.orderRowsTouchedOverride ?? orderRowsTouched,
      clinicalTextBaselineHash
    });
    const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      csrf: true,
      body
    });
    applyDetail(response);
    if (!options.silent) {
      addToast("入力を保存しました。", "success");
    }
    return response;
  }, [
    addToast,
    applyDetail,
    clinicalTextBaselineHash,
    defaultFacilityId,
    diagnosesTouched,
    feeApi,
    form,
    orderRows,
    orderRowsTouched,
    patients,
    sessionId
  ]);

  useEffect(() => {
    if (loading || !feeSession?.feeSessionId || feeSession.status === "calculating") {
      return undefined;
    }
    if (suppressAutoSaveRef.current) {
      suppressAutoSaveRef.current = false;
      return undefined;
    }
    window.clearTimeout(autoSaveTimerRef.current);
    setAutoSaveStatus("pending");
    setAutoSaveError("");
    autoSaveTimerRef.current = window.setTimeout(() => {
      setAutoSaveStatus("saving");
      const task = saveDetails({ silent: true, auto: true })
        .then(() => {
          setAutoSaveStatus("saved");
          setAutoSaveError("");
        })
        .catch((error) => {
          setAutoSaveStatus("error");
          setAutoSaveError(toUserFacingErrorMessage(error, "自動保存できませんでした。"));
        })
        .finally(() => {
          pendingAutoSaveRef.current = null;
        });
      pendingAutoSaveRef.current = task;
    }, 700);
    return () => window.clearTimeout(autoSaveTimerRef.current);
  }, [
    feeSession?.feeSessionId,
    feeSession?.status,
    form,
    loading,
    orderRows,
    saveDetails
  ]);

  async function calculate(options = {}) {
    await runBusy(setBusy, addToast, async () => {
      window.clearTimeout(autoSaveTimerRef.current);
      if (pendingAutoSaveRef.current) {
        await pendingAutoSaveRef.current;
      }
      let saved = null;
      let calculationBody = {};
      if (options.skipSaveDetails) {
        const payload = buildFeeSessionPayload({
          defaultFacilityId,
          form: options.formOverride || form,
          orderRows: Array.isArray(options.orderRowsOverride) ? options.orderRowsOverride : orderRows,
          patients,
          diagnosesTouched,
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
          orderRowsTouchedOverride: options.orderRowsOverride ? true : undefined
        });
        if (options.calculationMode) {
          calculationBody.calculationMode = options.calculationMode;
        }
      }
      setFeeSession((current) => ({
        ...(saved?.feeSession || current || {}),
        status: "calculating",
        calculationResult: null,
        calculationSummary: null,
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
      await refreshCalculationStatus();
      if (!jobQueued) {
        addToast("算定ジョブを開始できませんでした。Cloud Tasks または Pub/Sub の設定を確認して再度お試しください。", "error");
      }
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

  async function decideReviewItem(reviewItemId, status) {
    await runBusy(setBusy, addToast, async () => {
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/review-items/${encodeURIComponent(reviewItemId)}`, {
        method: "PATCH",
        csrf: true,
        body: { status }
      });
      setFeeSession(response.feeSession || feeSession);
      setReceiptDraft(response.receiptDraft || receiptDraft);
      setCandidateWorkbench(response.candidateWorkbench || null);
      setAutoSaveStatus("saved");
      setAutoSaveError("");
      addToast("採否を更新しました。", "success");
    });
  }

  async function copyReceiptDraft() {
    if (!receiptDraft) {
      addToast("コピーできるレセプト案がまだありません。", "error");
      return;
    }
    await runBusy(setBusy, addToast, async () => {
      const text = formatReceiptDraftForClipboard({ feeSession, receiptDraft });
      await writeClipboardText(text);
      addToast("レセプト案をコピーしました。", "success");
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
  const saveStatusLabel = autoSaveLabel(autoSaveStatus, autoSaveError);

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
          selectedPatient={selectedPatient}
          setNewPatient={setNewPatient}
          setPatientFilter={setPatientFilter}
          setPatientPickerOpen={setPatientPickerOpen}
        />
        <WorkPane
          activeMainTab={activeMainTab}
          activeWorkTab={activeWorkTab}
          calculation={calculation}
          candidateWorkbench={candidateWorkbench}
          disabled={busy}
          feeSession={feeSession}
          onCopyReceipt={copyReceiptDraft}
          onDecision={decideReviewItem}
          onOpenDetail={setCandidateDetail}
          onOpenManualItem={() => {
            setManualItemDraft(defaultManualBillingItemDraft());
            setManualItemModalOpen(true);
            setActiveMainTab("work");
            setActiveWorkTab("candidates");
          }}
          onSetMainTab={setActiveMainTab}
          onSetWorkTab={setActiveWorkTab}
          onRemoveManualOrder={removeManualOrderAndCalculate}
          orderRows={orderRows}
          receiptDraft={receiptDraft}
          selected={Boolean(sessionId)}
        />
      </div>
      <SessionActionFooter
        autoSaveError={autoSaveError}
        autoSaveLabelText={saveStatusLabel}
        autoSaveStatus={autoSaveStatus}
        busy={busy}
        calculate={calculate}
        isCalculating={isCalculating}
        onRefresh={() => loadAll({ forceBootstrap: true })}
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
      <CandidateDetailModal item={candidateDetail} disabled={busy} onClose={() => setCandidateDetail(null)} onDecision={decideReviewItem} />
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
        receiptDraft={receiptDraft}
        selectedMasterIndex={selectedMasterIndex}
      />
    </main>
  );
}

function SessionActionFooter({ autoSaveError, autoSaveLabelText, autoSaveStatus, busy, calculate, isCalculating, onRefresh }) {
  return (
    <footer className="fee-session-action-footer">
      <div>
        <strong>{autoSaveLabelText}</strong>
        <small>{autoSaveStatus === "error" ? autoSaveError || "通信状態を確認してください。" : "入力と採否は自動保存されます。"}</small>
      </div>
      <div className="source-action-buttons">
        <button className="btn btn--primary" disabled={busy || isCalculating} onClick={calculate} type="button">
          {isCalculating ? "算定候補を作成中" : "カルテから算定候補を作成"}
        </button>
        <button className="btn btn--ghost btn--icon" disabled={busy} onClick={onRefresh} type="button" aria-label="最新の状態に更新">↻</button>
      </div>
    </footer>
  );
}

function SourcePane({
  busy,
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
  selectedPatient,
  setNewPatient,
  setPatientFilter,
  setPatientPickerOpen
}) {
  const diagnosisCount = form.diagnosesText.split(/\n+/u).map((item) => item.trim()).filter(Boolean).length;

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
              <h2>カルテ本文</h2>
            </div>
          </div>
          <label className="clinical-text-field">
            <span>カルテの内容</span>
            <textarea
              className="clinical-textarea"
              placeholder={"S/O/A/Pや診療メモをそのまま貼り付けてください。"}
              value={form.clinicalText}
              onChange={(event) => onUpdateClinicalText(event.target.value)}
            />
          </label>
        </section>

        <section className="source-section">
          <div className="source-section-head">
            <div>
              <h2>病名</h2>
              <p>{diagnosisCount.toLocaleString()}件</p>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={onOpenOrders} type="button">
              オーダーを確認
            </button>
          </div>
          <label>
            <span>病名・補足</span>
            <textarea
              className="diagnosis-textarea"
              placeholder={"必要に応じて病名を1行ずつ入力してください"}
              value={form.diagnosesText}
              onChange={(event) => onUpdateDiagnosesText(event.target.value)}
            />
            <small>未入力の場合はカルテ本文から候補を補完し、不足時はレビューに出します。</small>
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

function WorkPane({
  activeMainTab,
  activeWorkTab,
  calculation,
  candidateWorkbench,
  disabled,
  feeSession,
  onCopyReceipt,
  onDecision,
  onOpenDetail,
  onOpenManualItem,
  onRemoveManualOrder,
  onSetMainTab,
  onSetWorkTab,
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
            activeTab={activeWorkTab}
            calculation={calculation}
            disabled={disabled}
            feeSession={feeSession}
            onDecision={onDecision}
            onOpenManualItem={onOpenManualItem}
            onOpenDetail={onOpenDetail}
            onTabChange={onSetWorkTab}
            candidateWorkbench={candidateWorkbench}
          />
        ) : (
          <ReceiptDraftPane
            disabled={disabled}
            onCopyReceipt={onCopyReceipt}
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

function PatientPicker({ filteredPatients, isOpen, onFilterChange, onOpenChange, onSelect, patientFilter, selectedPatient }) {
  const pickerRef = useRef(null);
  const selectedLabel = selectedPatient
    ? selectedPatient.displayName || "患者名未入力"
    : "患者を選択";

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
            )) : <div className="fee-empty-state">一致する患者はいません。</div>}
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

function CandidateWorkbench({ activeTab = "issues", calculation, candidateWorkbench, disabled, feeSession, onDecision, onOpenManualItem, onOpenDetail, onTabChange }) {
  if (feeSession?.status === "calculating") {
    return (
      <div className="result result-empty">
        <div className="calculation-waiting-card" role="status" aria-live="polite">
          <strong>カルテ本文を読み取り算定中</strong>
          <p>候補化が完了すると、算定候補と要確認を更新します。</p>
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
        <div className="notice-card">
          <strong>算定記録を準備しました</strong>
          <p>{feeSession?.patientSnapshot?.displayName || feeSession?.patientId || "患者未選択"} / {feeSession?.serviceDate || "診療日未設定"} / {statusLabel(feeSession?.status || "ready")}</p>
        </div>
      </div>
    );
  }

  const model = normalizeCandidateWorkbenchModel(
    candidateWorkbench || emptyCandidateWorkbenchModel({ calculation })
  );
  const adjustmentLines = [...model.pendingLines, ...model.excludedLines];
  const includedCount = model.includedLines.length;
  const proposalCount = model.proposals.length;
  const candidateCount = includedCount + proposalCount;
  const needsReviewCount = model.issues.length + adjustmentLines.length;
  const potentialPointsTotal = Number(model.potentialPointsTotal || 0);
  const coverageSummary = model.coverageSummary || {};
  const selectedWorkTab = activeTab === "lines" || activeTab === "proposals" ? "candidates" : activeTab;
  return (
    <div className="candidate-workbench">
      <div className="candidate-summary">
        <div className="candidate-total">
          <span>{coverageSummary.title || "候補化済み部分合計"}</span>
          <strong>{Number(model.includedTotalPoints || 0).toLocaleString()}点</strong>
        </div>
        <div className="candidate-summary-grid">
          <div><span>算定候補</span><strong>{candidateCount.toLocaleString()}件</strong></div>
          <div><span>要確認</span><strong>{needsReviewCount.toLocaleString()}件</strong></div>
          <div><span>増点余地</span><strong>{potentialPointsTotal > 0 ? `+${potentialPointsTotal.toLocaleString()}点` : `${proposalCount.toLocaleString()}件`}</strong></div>
        </div>
      </div>

      <div className="fee-sub-tabs" role="tablist" aria-label="算定作業">
        <TabButton active={selectedWorkTab === "candidates"} count={candidateCount} onClick={() => onTabChange("candidates")}>算定候補</TabButton>
        <TabButton active={selectedWorkTab === "issues"} count={needsReviewCount} onClick={() => onTabChange("issues")}>要確認</TabButton>
      </div>

      {selectedWorkTab === "issues" ? (
        <section className="candidate-bucket">
          <BucketHeader title="確認・修正が必要" count={needsReviewCount} note="このままだと算定しづらい項目です。内容を確認してください。" />
          {model.issues.length ? (
            <div className="issue-list">
              {model.issues.map((item) => (
                <IssueCard item={item} key={item.reviewItemId} onOpenDetail={onOpenDetail} />
              ))}
            </div>
          ) : null}
          {adjustmentLines.length ? (
            <div className="candidate-line-list candidate-line-list--review">
              {adjustmentLines.map((line) => (
                <CandidateLineRow disabled={disabled} item={line} key={line.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
              ))}
            </div>
          ) : null}
          {!model.issues.length && !adjustmentLines.length ? <p className="field-note">追加で確認が必要な項目はありません。</p> : null}
        </section>
      ) : null}

      {selectedWorkTab === "candidates" ? (
        <section className="candidate-bucket">
          <BucketHeader
            action={(
              <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={onOpenManualItem} type="button">
                明細を追加
              </button>
            )}
            title="算定候補"
            note="合計点数に入っている明細と、条件を満たすと採用できる提案です。"
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
          {!model.includedLines.length && !model.proposals.length ? <p className="field-note">算定候補はまだありません。</p> : null}
        </section>
      ) : null}
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
  const options = [
    { value: "approved", label: "算定する" },
    { value: "rejected", label: "算定しない" }
  ];
  const metaLabel = [
    item.code,
    orderTypeLabel(item.orderType || item.candidateLine?.orderType),
    item.issueCategoryLabel
  ].filter(Boolean).join(" / ") || "提案";
  const pointsLabel = item.pointsLabel || (Number(item.potentialPoints || 0) > 0 ? `+${Number(item.potentialPoints || 0).toLocaleString()}点` : "点数確認");
  return (
    <article className={`candidate-line-row candidate-line-row--proposal ${canApprove ? "" : "candidate-line-row--confirm-required"}`}>
      <div className="candidate-line-action">
        <AdminSelect
          ariaLabel={`${item.displayTitle || "提案"}の採否`}
          disabled={disabled || !canApprove}
          className="candidate-decision-select"
          options={options}
          placeholder={canApprove ? "確認中" : confirmableProposalForAdoption(item) ? "詳細で確認" : item.nextActionLabel || "条件確認"}
          value={decisionStatus}
          onValueChange={(value) => {
            if (value) {
              onDecision(item.reviewItemId, value);
            }
          }}
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
        <AdminSelect
          ariaLabel={`${item.name}の採否`}
          disabled={disabled || !canApprove}
          className="candidate-decision-select"
          options={[
            { value: "approved", label: "算定する" },
            { value: "rejected", label: "算定しない" }
          ]}
          placeholder="確認中"
          value={decisionStatus}
          onValueChange={(value) => {
            if (value) {
              onDecision(item.reviewItemId, value);
            }
          }}
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
      <span className="candidate-line-status">{item.statusLabel}</span>
      <strong className="candidate-line-points">{Number(item.totalPoints || 0).toLocaleString()}点</strong>
      <button className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(item)} type="button">詳細</button>
    </article>
  );
}

function IssueCard({ item, onOpenDetail }) {
  const requiredInput = reviewRequiredInput(item);
  const resolutionOptions = reviewResolutionOptions(item);
  const tone = issueTone(item);
  return (
    <article className={`issue-card issue-card--${item.issueCategory || "rule"}`}>
      <span className={`issue-tone-dot issue-tone-dot--${tone}`} aria-hidden="true">
        {issueToneIcon(tone)}
      </span>
      <div>
        <span className="issue-category-badge">{item.issueCategoryLabel || "確認事項"}</span>
        <strong>{item.displayTitle}</strong>
        <p>{item.displayReason}</p>
        {item.conditionText ? <small>{item.conditionText}</small> : null}
        {requiredInput ? (
          <div className="issue-required-input">
            <span>確認する情報</span>
            <strong>{requiredInput}</strong>
          </div>
        ) : null}
        {resolutionOptions.length ? (
          <div className="issue-resolution-options" aria-label="確認の選択肢">
            {resolutionOptions.slice(0, 4).map((option) => (
              <span key={option.value || option.label}>{option.label || option.value}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="issue-card-actions">
        <button className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(item)} type="button">詳細</button>
      </div>
    </article>
  );
}

function CandidateDetailModal({ disabled, item, onClose, onDecision }) {
  const [confirmAdoptionChecked, setConfirmAdoptionChecked] = useState(false);
  useEffect(() => {
    setConfirmAdoptionChecked(false);
  }, [item?.reviewItemId]);
  if (!item) {
    return null;
  }
  const canDecide = Boolean(item.reviewItemId);
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
        </div>
        <footer className="fee-modal-footer">
          {canDirectAdopt ? (
            <>
              <button className="btn btn--primary" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "approved")} type="button">
                {directAdoptLabel}
              </button>
              {canReject ? (
                <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected")} type="button">算定しない</button>
              ) : null}
            </>
          ) : canConfirmAdopt ? (
            <>
              <button className="btn btn--primary" disabled={disabled || !confirmAdoptionChecked} onClick={() => onDecision(item.reviewItemId, "approved")} type="button">算定する</button>
              <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected")} type="button">算定しない</button>
            </>
          ) : null}
        </footer>
      </section>
    </div>
  );
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
  return "neutral";
}

function issueToneIcon(tone) {
  return {
    danger: "!",
    warning: "!",
    notice: "i",
    info: "?",
    neutral: "?"
  }[tone] || "?";
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
  return ["approved", "rejected"].includes(value) ? value : "";
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

function ReceiptDraftPane({ disabled, onCopyReceipt, onRemoveManualOrder, orderRows = [], receiptDraft, selected }) {
  const manualOrders = manualBillingOrderEntries(orderRows);
  return (
    <div className="receipt-draft-pane">
      <div className="receipt-pane-head">
        <div>
          <h2>レセプト案</h2>
          <p>区分別合計と明細です。確認後にコピーできます。</p>
        </div>
        <div className="receipt-pane-actions">
          <button className="btn btn--ghost btn--sm" disabled={disabled || !receiptDraft} onClick={onCopyReceipt} type="button">
            コピー
          </button>
          <button className="btn btn--primary btn--sm" disabled title="確定APIが未実装です" type="button">
            確定
          </button>
        </div>
      </div>
      {manualOrders.length ? (
        <section className="manual-billing-list" aria-label="ユーザー追加明細">
          <div className="manual-billing-list-head">
            <div>
              <h3>ユーザー追加明細</h3>
              <p>カルテ自動抽出ではなく、人手で追加した算定入力です。削除すると再計算します。</p>
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
                削除して再計算
              </button>
            </article>
          ))}
        </section>
      ) : null}
      <ReceiptDraft receiptDraft={receiptDraft} selected={selected} />
    </div>
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

function ReceiptDraft({ receiptDraft, selected }) {
  if (!receiptDraft) {
    return <div className="fee-empty-state">{selected ? "算定候補を作成すると、レセプト案が表示されます。" : "算定記録を選択してください。"}</div>;
  }
  return (
    <div className="receipt-list">
      <article className="receipt-line">
        <header>
          <span>{receiptDraft.claimMonth} / {statusLabel(receiptDraft.status)}</span>
          <span>{Number(receiptDraft.totalPoints || 0).toLocaleString()} 点</span>
        </header>
        <p>請求月ごとのレセプト案です。内容を確認してから確定してください。</p>
      </article>
      {(receiptDraft.lineGroups || []).map((group, index) => (
        <article className="receipt-line" key={`${group.label || "group"}-${index}`}>
          <header>
            <span>{group.label}</span>
            <span>{Number(group.totalPoints || 0).toLocaleString()} 点</span>
          </header>
          <p>{(group.lines || []).map((line) => `${line.name} ${line.totalPoints}点 (${statusLabel(line.status)})`).join(" / ")}</p>
        </article>
      ))}
    </div>
  );
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
    if (auth.accessToken) {
      headers.authorization = `Bearer ${auth.accessToken}`;
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

function applyDetailResponse(response, setters) {
  const session = response.feeSession || response;
  setters.setFeeSession(session || null);
  setters.setReceiptDraft(response.receiptDraft || null);
  setters.setCandidateWorkbench?.(response.candidateWorkbench || null);
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
  const issues = Array.isArray(model.issues) ? model.issues : [];
  const rawCounts = model.counts && typeof model.counts === "object" ? model.counts : {};
  const includedCount = includedLines.length;
  const pendingCount = pendingLines.length;
  const excludedCount = excludedLines.length;
  const proposalCount = proposals.length;
  const issueCount = issues.length;
  const needsReview = issueCount + pendingCount + excludedCount;
  const potentialPointsTotal = Number(model.potentialPointsTotal ?? 0);
  return {
    ...model,
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    proposals,
    issues,
    counts: {
      included: includedCount,
      pending: pendingCount,
      excluded: excludedCount,
      proposals: proposalCount,
      issues: issueCount,
      needsReview
    },
    includedCount,
    pendingCount,
    excludedCount,
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
    proposals: [],
    issues: [],
    counts: {
      included: 0,
      pending: 0,
      excluded: 0,
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

function autoSaveLabel(status, error = "") {
  if (status === "saving") return "保存中...";
  if (status === "pending") return "変更を自動保存します。";
  if (status === "error") return error || "自動保存できませんでした。";
  return "保存済み";
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

function toUserFacingErrorMessage(error, fallbackMessage) {
  const rawMessage = typeof error === "string" ? error : error?.message;
  const code = typeof error === "object" && error ? String(error.code || error.error || "") : "";
  const status = typeof error === "object" && error ? Number(error.status || error.statusCode || 0) : 0;
  const text = String(rawMessage || "").trim();
  const lower = text.toLowerCase();
  const normalizedCode = code.toLowerCase();

  if (normalizedCode === "mfa_required" || lower.includes("mfa code is required")) return "2段階認証コードを入力してください。";
  if (lower.includes("invalid mfa")) return "2段階認証コードが正しくありません。";
  if (lower.includes("invalid credentials")) return "病院コード、個人ID、またはログイン用パスワードが正しくありません。";
  if (lower.includes("csrf")) return "画面を再読み込みして、もう一度お試しください。";
  if (lower.includes("invalid session") || lower.includes("session expired") || lower.includes("session revoked") || lower === "unauthorized") return "ログイン状態を確認できません。もう一度ログインしてください。";
  if (lower.includes("role is required") || lower.includes("access is required") || lower.includes("product access is required") || lower === "forbidden" || status === 403) return "この操作を行う権限がありません。";
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower === "load failed") return "通信に失敗しました。接続を確認して、もう一度お試しください。";
  if (lower.includes("not found") || status === 404) return "対象のデータが見つかりませんでした。画面を再読み込みしてからもう一度お試しください。";
  if (lower.includes("rate limit") || status === 429) return "短時間に操作が続いています。少し待ってからもう一度お試しください。";
  if (lower.includes("internal server error") || /^http 5\d\d$/iu.test(text) || status >= 500) return "処理中に問題が発生しました。時間を置いてもう一度お試しください。";
  if (!text || /^http \d{3}$/iu.test(text)) return fallbackMessage;
  return /[ぁ-んァ-ヶ一-龠]/u.test(text) ? text : fallbackMessage;
}
