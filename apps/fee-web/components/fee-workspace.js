"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlatformAuth } from "./platform-auth";

const FEE_SESSION_PAGE_SIZE = 20;
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
const CLINICAL_ORDER_RULES = [
  {
    orderType: "procedure",
    localName: "創傷処置（１００ｃｍ２未満）",
    standardCode: "140000610",
    standardName: "創傷処置（１００ｃｍ２未満）",
    patterns: [/創傷/u, /創部/u, /熱傷/u, /洗浄/u, /ガーゼ/u]
  },
  {
    orderType: "drug",
    localName: "ゲーベンクリーム１％",
    standardCode: "620008991",
    standardName: "ゲーベンクリーム１％",
    patterns: [/ゲーベン/u]
  },
  {
    orderType: "material",
    localName: "非固着性シリコンガーゼ（平坦部位用）",
    standardCode: "710010306",
    standardName: "非固着性シリコンガーゼ（平坦部位用）",
    patterns: [/ノンスティックガーゼ/u, /非固着性.*ガーゼ/u]
  },
  { orderType: "lab", localName: "検体検査", patterns: [/検査/u, /採血/u, /血液/u, /尿検査/u, /CRP/iu, /HbA1c/iu] },
  { orderType: "injection", localName: "注射", patterns: [/注射/u, /点滴/u, /静注/u, /皮下注/u] },
  { orderType: "imaging", localName: "画像診断", patterns: [/画像/u, /レントゲン/u, /X線/iu, /(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])/iu, /(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])/iu] },
  { orderType: "treatment", localName: "医学管理等", patterns: [/指導/u, /管理/u, /療養/u, /説明/u] }
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
const CLINICAL_AUTO_CALCULATION_OPTION_KEYS = new Set([
  "outpatient_basic",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs"
]);
const CLINICAL_DIAGNOSIS_RULES = [
  { name: "腰椎椎間板ヘルニア疑い", patterns: [/腰椎椎間板ヘルニア/u, /椎間板ヘルニア/u] },
  { name: "腰痛症", patterns: [/腰痛/u] },
  { name: "熱傷", patterns: [/熱傷/u, /やけど/u] },
  { name: "創傷", patterns: [/創傷/u, /創部/u, /裂創/u, /擦過傷/u] },
  { name: "急性上気道炎疑い", patterns: [/風邪/u, /上気道/u, /咽頭/u, /咳/u, /鼻汁/u] },
  { name: "高血圧症", patterns: [/高血圧/u] },
  { name: "糖尿病", patterns: [/糖尿病/u, /HbA1c/iu] },
  { name: "脂質異常症", patterns: [/脂質異常/u, /高脂血/u] }
];

export function FeeWorkspace({ mode = "list", sessionId = "" }) {
  if (mode === "detail") {
    return <FeeSessionDetailView sessionId={sessionId} />;
  }

  return <FeeSessionListView />;
}

function FeeSessionListView() {
  const feeApi = useFeeApi();
  const [sessions, setSessions] = useState([]);
  const [pageInfo, setPageInfo] = useState({
    page: 1,
    pageSize: FEE_SESSION_PAGE_SIZE,
    totalCount: 0,
    totalPages: 0,
    totalCountApproximate: false
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const query = useMemo(() => ({ search, status }), [search, status]);

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

  return (
    <main className="fee-shell">
      <header className="fee-page-head">
        <div>
          <h1>算定一覧</h1>
        </div>
      </header>

      <section className="fee-card fee-quick-start">
        <div>
          <span className="label">新しい算定</span>
          <h2>算定記録を作成します</h2>
          <p>患者とカルテ本文を入力して算定候補を作成します。</p>
        </div>
        <button className="btn btn--primary" disabled={creating} onClick={createSession} type="button">
          算定を開始
        </button>
      </section>

      <section className="fee-card">
        <div className="fee-section-head">
          <div>
            <span className="label">履歴</span>
            <h2>過去の算定</h2>
          </div>
          <span className="fee-count">{pageInfo.totalCountApproximate ? "直近" : ""}{Number(pageInfo.totalCount).toLocaleString()}件</span>
        </div>
        <div className="fee-toolbar">
          <label>
            <span>検索</span>
            <input
              type="search"
              placeholder="患者名・患者IDで検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
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
        {errorMessage ? <div className="fee-error-state" role="status">{errorMessage}</div> : null}
        {loading ? <SessionSkeleton /> : (
          <>
            <SessionList sessions={sessions} />
            <Pagination pageInfo={pageInfo} onPageChange={loadSessions} />
          </>
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
  const [reviewItems, setReviewItems] = useState([]);
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
  const [message, setMessage] = useState(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState("saved");
  const [autoSaveError, setAutoSaveError] = useState("");
  const [candidateDetail, setCandidateDetail] = useState(null);
  const [settingsModalMode, setSettingsModalMode] = useState(null);
  const suppressAutoSaveRef = useRef(false);
  const autoSaveTimerRef = useRef(null);
  const pendingAutoSaveRef = useRef(null);

  const masterSearchAvailable = Boolean(masterStatus);
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
    () => patients.find((patient) => patient.patientId === form.patientId) || null,
    [form.patientId, patients]
  );

  const applyDetail = useCallback((detail) => {
    suppressAutoSaveRef.current = true;
    applyDetailResponse(detail, {
      setFeeSession,
      setReceiptDraft,
      setReviewItems,
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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [bootstrap, detail] = await Promise.all([
        feeApi(`/v1/fee/bootstrap${sessionListQuery({ page: 1 })}`),
        feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/detail`)
      ]);
      setPatients(bootstrap.patients || []);
      setFacilities(bootstrap.facilities || []);
      setDepartments(bootstrap.departments || []);
      setMasterStatus(bootstrap.masterStatus || null);
      applyDetail(detail);
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "算定詳細を読み込めませんでした。") });
    } finally {
      setLoading(false);
    }
  }, [applyDetail, feeApi, sessionId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshDetail = useCallback(async () => {
    const detail = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/detail`);
    applyDetail(detail);
    return detail;
  }, [applyDetail, feeApi, sessionId]);

  useEffect(() => {
    if (feeSession?.status !== "calculating") {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const detail = await refreshDetail();
        if (cancelled) {
          return;
        }
        const status = detail.feeSession?.status;
        if (status && status !== "calculating") {
          window.clearInterval(timer);
          setMessage({
            type: status === "failed" ? "error" : "success",
            text: status === "failed"
              ? "算定候補の作成に失敗しました。入力内容を確認してもう一度お試しください。"
              : "算定が完了しました。"
          });
        }
      } catch (error) {
        if (!cancelled) {
          setMessage({ type: "error", text: toUserFacingErrorMessage(error, "算定結果を更新できませんでした。") });
        }
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [feeSession?.status, refreshDetail]);

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
        setMessage({ type: "error", text: toUserFacingErrorMessage(error, "マスター検索に失敗しました。") });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [feeApi, masterQuery, masterSearchAvailable, masterStatus, masterType]);

  const displayReviewItems = useMemo(() => buildDisplayReviewItems(reviewItems), [reviewItems]);

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
    const body = buildFeeSessionPayload({
      defaultFacilityId,
      form,
      orderRows,
      patients,
      diagnosesTouched,
      orderRowsTouched,
      clinicalTextBaselineHash
    });
    const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      csrf: true,
      body
    });
    applyDetail(response);
    if (!options.silent) {
      setMessage({ type: "success", text: "入力を保存しました。" });
    }
    return response;
  }, [
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

  async function calculate() {
    await runBusy(setBusy, setMessage, async () => {
      window.clearTimeout(autoSaveTimerRef.current);
      if (pendingAutoSaveRef.current) {
        await pendingAutoSaveRef.current;
      }
      const saved = await saveDetails({ silent: true });
      setFeeSession((current) => ({
        ...(saved.feeSession || current || {}),
        status: "calculating",
        calculationResult: null,
        calculationSummary: null,
        calculationProgress: buildClientCalculationProgress({
          phase: "extract",
          percent: 10,
          message: "カルテ本文から算定に必要な情報を抽出しています。"
        })
      }));
      setMessage({ type: "success", text: "算定候補を作成しています。" });
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/calculate`, {
        method: "POST",
        csrf: true,
        body: {}
      });
      applyDetail(response);
      setMessage({
        type: "success",
        text: response.feeSession?.status === "calculating"
          ? "算定候補を作成しています。"
          : "算定が完了しました。"
      });
    });
  }

  async function createPatient(event) {
    event.preventDefault();
    await runBusy(setBusy, setMessage, async () => {
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
      setPatients((current) => [...current, patient]);
      setForm((current) => ({
        ...current,
        patientId: patient?.patientId || current.patientId
      }));
      setNewPatient(defaultPatientForm());
      setMessage({ type: "success", text: "患者を作成しました。" });
    });
  }

  async function decideReviewItem(reviewItemId, status) {
    await runBusy(setBusy, setMessage, async () => {
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/review-items/${encodeURIComponent(reviewItemId)}`, {
        method: "PATCH",
        csrf: true,
        body: { status }
      });
      setFeeSession(response.feeSession || feeSession);
      setReviewItems(response.reviewItems || []);
      setReceiptDraft(response.receiptDraft || receiptDraft);
      setCandidateWorkbench(response.candidateWorkbench || null);
      setAutoSaveStatus("saved");
      setAutoSaveError("");
      setMessage({ type: "success", text: "採否を更新しました。" });
    });
  }

  async function copyReceiptDraft() {
    if (!receiptDraft) {
      setMessage({ type: "error", text: "コピーできるレセプト案がまだありません。" });
      return;
    }
    await runBusy(setBusy, setMessage, async () => {
      const text = formatReceiptDraftForClipboard({ feeSession, receiptDraft });
      await writeClipboardText(text);
      setMessage({ type: "success", text: "レセプト案をコピーしました。" });
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
    if (item.kind === "comment") {
      try {
        const options = parseJsonObjectField(form.calculationOptionsText, "算定オプション JSON") || {};
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
        updateForm("calculationOptionsText", formatJsonObject(options));
        setMessage({ type: "success", text: "コメントを算定オプションに追加しました。" });
      } catch (error) {
        setMessage({ type: "error", text: toUserFacingErrorMessage(error, "算定オプション JSONを確認してください。") });
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
        quantity: "1"
      }
    ]);
    setMessage({ type: "success", text: "マスターからオーダーを追加しました。" });
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
  const patientName = feeSession?.patientSnapshot?.displayName || feeSession?.patientRef || feeSession?.patientId || "患者未選択";
  const isCalculating = feeSession?.status === "calculating";
  const saveStatusLabel = autoSaveLabel(autoSaveStatus, autoSaveError);

  return (
    <main className="fee-shell fee-shell--detail">
      <header className="fee-page-head fee-detail-head">
        <div>
          <span className="label">算定記録</span>
          <h1>{patientName}</h1>
          <p className="fee-detail-meta">
            <span>{feeSession?.serviceDate || "診療日未設定"}</span>
            <span>{feeSession?.claimMonth || "請求月未設定"}</span>
            <span className={badgeClass(feeSession?.status)}>{statusLabel(feeSession?.status)}</span>
          </p>
        </div>
        <a className="btn btn--ghost" href="/sessions">一覧へ戻る</a>
      </header>

      {message ? <div className={`fee-message fee-message--${message.type}`} role="status">{message.text}</div> : null}

      <div className="fee-detail-grid">
        <section className="fee-card fee-detail-input-card">
          <div className="fee-section-head">
            <div>
              <h2>算定条件</h2>
              <p>患者とカルテ本文を中心に、補完された病名・オーダーを確認します。</p>
            </div>
            <span className="badge review">要レビュー前提</span>
          </div>

          <form className="fee-detail-form" id="fee-session-detail-form">
            <div className="patient-picker-row">
              <PatientPicker
                filteredPatients={filteredPatients}
                isOpen={patientPickerOpen}
                onFilterChange={setPatientFilter}
                onOpenChange={setPatientPickerOpen}
                onSelect={selectPatient}
                patientFilter={patientFilter}
                selectedPatient={selectedPatient}
              />
              <PatientCreateForm
                disabled={busy}
                patient={newPatient}
                setPatient={setNewPatient}
                onSubmit={createPatient}
              />
            </div>

            <label className="clinical-text-field">
              <span>カルテの内容</span>
              <textarea
                className="clinical-textarea"
                placeholder={"S/O/A/Pや診療メモをそのまま貼り付けてください。"}
                value={form.clinicalText}
                onChange={(event) => updateClinicalText(event.target.value)}
              />
              <small>本文から病名・オーダー候補を自動補完します。必要な場合だけ下の条件を修正してください。</small>
            </label>

            <FeeInputSummary
              departments={departments}
              form={form}
              orderCount={parseOrdersFromRows(orderRows).length}
              onOpenConditions={() => setSettingsModalMode("conditions")}
              onOpenOrders={() => setSettingsModalMode("orders")}
            />
          </form>
        </section>

        <div className="fee-detail-main">
          <section className="fee-card fee-result-card">
            <CandidateWorkbench
              calculation={calculation}
              disabled={busy}
              feeSession={feeSession}
              onDecision={decideReviewItem}
              onOpenDetail={setCandidateDetail}
              candidateWorkbench={candidateWorkbench}
              receiptDraft={receiptDraft}
              reviewItems={displayReviewItems}
            />
          </section>

          <section className="fee-card fee-receipt-card">
            <h2>レセプト案</h2>
            <ReceiptDraft receiptDraft={receiptDraft} selected={Boolean(sessionId)} />
          </section>
        </div>
      </div>

      <div className="fee-action-bar">
        <div>
          <strong>{saveStatusLabel}</strong>
          <small>{autoSaveStatus === "error" ? "通信状態を確認してください。" : "入力と採否は自動保存されます。"}</small>
        </div>
        <div className="fee-action-buttons">
          <button className="btn btn--primary" disabled={busy || isCalculating} onClick={calculate} type="button">
            {isCalculating ? "算定候補を作成中" : "カルテから算定候補を作成"}
          </button>
          <button className="btn btn--ghost" disabled={busy || !receiptDraft} onClick={copyReceiptDraft} type="button">
            レセプト案をコピー
          </button>
          <button className="btn btn--ghost btn--icon" disabled={busy} onClick={loadAll} type="button" aria-label="最新の状態に更新">↻</button>
        </div>
      </div>
      <FeeSettingsModal
        available={masterSearchAvailable}
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
        onClose={() => setSettingsModalMode(null)}
        onMasterQueryChange={setMasterQuery}
        onMasterTypeChange={setMasterType}
        onRemoveOrderRow={removeOrderRow}
        onUpdateForm={updateForm}
        onUpdateDiagnosesText={updateDiagnosesText}
        onUpdateOrderRow={updateOrderRow}
        orderRows={orderRows}
        orderCount={parseOrdersFromRows(orderRows).length}
        selectedMasterIndex={selectedMasterIndex}
      />
      <CandidateDetailModal item={candidateDetail} disabled={busy} onClose={() => setCandidateDetail(null)} onDecision={decideReviewItem} />
    </main>
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
  onClose,
  onMasterQueryChange,
  onMasterTypeChange,
  onRemoveOrderRow,
  onUpdateDiagnosesText,
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
                    <select value={form.facilityId || defaultFacilityId} onChange={(event) => onUpdateForm("facilityId", event.target.value)}>
                      <option value="">施設を選択</option>
                      {facilities.map((facility) => (
                        <option key={facility.facilityId} value={facility.facilityId}>
                          {facility.displayName} ({facility.medicalInstitutionCode || "code未設定"})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  <span>診療科</span>
                  <select value={form.departmentId} onChange={(event) => onUpdateForm("departmentId", event.target.value)}>
                    <option value="">未指定</option>
                    {departments.map((department) => (
                      <option key={department.departmentId} value={department.departmentId}>
                        {department.displayName || "名称未設定"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>区分</span>
                  <select value={form.setting} onChange={(event) => onUpdateForm("setting", event.target.value)}>
                    <option value="outpatient">外来</option>
                    <option value="inpatient">入院（限定対応）</option>
                  </select>
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
              <label>
                <span>病名</span>
                <textarea
                  className="diagnosis-textarea"
                  placeholder={"例: 熱傷\n創傷"}
                  value={form.diagnosesText}
                  onChange={(event) => onUpdateDiagnosesText(event.target.value)}
                />
                <small>未入力の場合はカルテ本文から候補を補完し、不足時はレビューに出します。</small>
              </label>
              <ScopeNotice setting={form.setting} />
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
                  <select value={masterType} onChange={(event) => onMasterTypeChange(event.target.value)} disabled={!available}>
                    {MASTER_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
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
          <button className="btn btn--primary" onClick={onClose} type="button">閉じる</button>
        </footer>
      </section>
    </div>
  );
}

function PatientPicker({ filteredPatients, isOpen, onFilterChange, onOpenChange, onSelect, patientFilter, selectedPatient }) {
  const selectedLabel = selectedPatient
    ? `${selectedPatient.displayName || "患者名未入力"} (${selectedPatient.patientCode || selectedPatient.primaryPatientNumber || selectedPatient.externalPatientIds?.[0] || selectedPatient.patientId})`
    : "患者を選択";
  return (
    <div className="patient-picker-field">
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
  return (
    <details className="patient-inline-create">
      <summary>＋ 患者追加</summary>
      <form className="patient-create-form" onSubmit={onSubmit}>
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
            <select
              value={patient.sex}
              onChange={(event) => setPatient((current) => ({ ...current, sex: event.target.value }))}
            >
              <option value="unknown">不明</option>
              <option value="male">男性</option>
              <option value="female">女性</option>
              <option value="other">その他</option>
            </select>
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
        <button className="btn btn--ghost" disabled={disabled} type="submit">患者を追加</button>
      </form>
    </details>
  );
}
function MasterStatus({ available }) {
  if (available) {
    return null;
  }
  return <div className="master-status">マスター検索APIの反映待ちです。通常の算定入力は利用できます。</div>;
}

function ScopeNotice({ setting }) {
  const inpatientText = setting === "inpatient"
    ? "入院/DPCは限定対応です。入院基本料候補とDPCレビューに留まり、確定算定ではありません。"
    : "外来検体検査を中心に候補を作成します。未対応章はマスター参照のみ、または要レビューとして扱います。";
  return (
    <div className="notice-card scope-notice">
      <strong>対応範囲</strong>
      <p>{inpatientText} 手術、麻酔、在宅、リハビリ、精神科専門療法、病理診断などは確定算定として扱わないでください。</p>
    </div>
  );
}

function MasterSearchResults({ available, items, onAdd, query, selectedIndex = 0 }) {
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
            {item.kind === "comment" ? "コメントに追加" : "オーダーに追加"}
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
            <select value={row.orderType} onChange={(event) => onUpdate(index, "orderType", event.target.value)}>
              {ORDER_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
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

function CandidateWorkbench({ calculation, candidateWorkbench, disabled, feeSession, onDecision, onOpenDetail, receiptDraft, reviewItems }) {
  if (feeSession?.status === "calculating") {
    return (
      <div className="result result-empty">
        <div className="notice-card">
          <strong>算定候補を作成中です</strong>
          <p>{feeSession?.patientSnapshot?.displayName || feeSession?.patientId || "患者未選択"} / {feeSession?.serviceDate || "診療日未設定"} / 計算中</p>
        </div>
        <CalculationProgress progress={feeSession?.calculationProgress} />
        <p className="field-note">完了すると算定候補、確認項目、レセプト案が自動で更新されます。</p>
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
    candidateWorkbench || buildCandidateWorkbenchModel({ calculation, receiptDraft, reviewItems })
  );
  const adjustmentLines = [...model.pendingLines, ...model.excludedLines];
  const needsReviewCount = Number(model.counts?.needsReview ?? model.needsReviewCount ?? (model.proposals.length + model.issues.length + model.pendingLines.length));
  const potentialPointsTotal = Number(model.potentialPointsTotal || 0);
  const coverageSummary = model.coverageSummary || {};
  return (
    <div className="candidate-workbench">
      <div className="fee-section-head">
        <div>
          <h2>算定候補</h2>
          <p>算定できる可能性を見逃さないよう、提案・採用中・修正が必要な項目に分けています。</p>
        </div>
      </div>

      <div className="candidate-summary">
        <div className="candidate-total">
          <span>{coverageSummary.title || "候補化済み部分合計"}</span>
          <strong>{Number(model.includedTotalPoints || 0).toLocaleString()}点</strong>
          <small>{coverageSummary.description || "確定請求ではありません。採否を変えると合計も変わります。"}</small>
        </div>
        <div className="candidate-summary-grid">
          <div><span>算定中</span><strong>{model.includedCount.toLocaleString()}件</strong></div>
          <div><span>要確認</span><strong>{needsReviewCount.toLocaleString()}件</strong></div>
          <div><span>増点余地</span><strong>{potentialPointsTotal > 0 ? `+${potentialPointsTotal.toLocaleString()}点` : `${model.proposals.length.toLocaleString()}件`}</strong></div>
        </div>
      </div>
      {Array.isArray(coverageSummary.badges) && coverageSummary.badges.length ? (
        <div className="candidate-coverage-badges" aria-label="候補化範囲">
          {coverageSummary.badges.map((badge) => (
            <span key={badge}>{badge}</span>
          ))}
        </div>
      ) : null}

      <section className="candidate-bucket candidate-bucket--proposal">
        <BucketHeader title="増点できる（提案）" count={model.proposals.length} note="条件を満たすなら点数にできる可能性がある項目です。" />
        {model.proposals.length ? (
          <div className="proposal-list">
            {model.proposals.map((item) => (
              <ProposalCard disabled={disabled} item={item} key={item.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : <p className="field-note">今の入力から追加で提案できる項目はありません。</p>}
      </section>

      <section className="candidate-bucket">
        <BucketHeader title="算定中" count={model.includedCount} note="いま合計点数に入っている明細です。必要に応じて外せます。" />
        {model.includedLines.length ? (
          <div className="candidate-line-list">
            {model.includedLines.map((line) => (
              <CandidateLineRow disabled={disabled} item={line} key={line.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : <p className="field-note">算定中の明細はまだありません。</p>}
      </section>

      {adjustmentLines.length ? (
        <section className="candidate-bucket">
          <BucketHeader title="外し/保留" count={adjustmentLines.length} note="合計から外している、または後で判断する明細です。" />
          <div className="candidate-line-list">
            {adjustmentLines.map((line) => (
              <CandidateLineRow disabled={disabled} item={line} key={line.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="candidate-bucket">
        <BucketHeader title="確認・修正が必要" count={model.issues.length} note="このままだと算定しづらい項目です。内容を確認してください。" />
        {model.issues.length ? (
          <div className="issue-list">
            {model.issues.map((item) => (
              <IssueCard disabled={disabled} item={item} key={item.reviewItemId} onDecision={onDecision} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        ) : <p className="field-note">追加で確認が必要な項目はありません。</p>}
      </section>
    </div>
  );
}

function BucketHeader({ count, note, title }) {
  return (
    <header className="candidate-bucket-head">
      <div>
        <h3>{title}</h3>
        <p>{note}</p>
      </div>
      <span>{count.toLocaleString()}件</span>
    </header>
  );
}

function ProposalCard({ disabled, item, onDecision, onOpenDetail }) {
  return (
    <article className="proposal-card">
      <div className="proposal-card-main">
        <span className="proposal-kicker">条件を満たせば算定できます</span>
        <h4>{item.displayTitle}</h4>
        <p>{item.displayReason}</p>
        <small>{item.conditionText}</small>
      </div>
      <div className="proposal-card-actions">
        <span className="proposal-points">{item.pointsLabel || "点数確認"}</span>
        <button className="btn btn--primary btn--sm" disabled={disabled} onClick={() => onOpenDetail(item)} type="button">
          条件を確認
        </button>
      </div>
    </article>
  );
}

function CandidateLineRow({ disabled, item, onDecision, onOpenDetail }) {
  return (
    <article className={`candidate-line-row candidate-line-row--${item.inclusionStatus}`}>
      <div className="candidate-line-action">
        <select
          aria-label={`${item.name}の採否`}
          disabled={disabled}
          value={item.decisionStatus}
          onChange={(event) => onDecision(item.reviewItemId, event.target.value)}
        >
          <option value="approved">算定する</option>
          <option value="edited">保留</option>
          <option value="rejected">算定しない</option>
        </select>
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

function IssueCard({ disabled, item, onDecision, onOpenDetail }) {
  return (
    <article className={`issue-card issue-card--${item.issueCategory || "rule"}`}>
      <div>
        <span className="issue-category-badge">{item.issueCategoryLabel || "確認事項"}</span>
        <strong>{item.displayTitle}</strong>
        <p>{item.displayReason}</p>
        {item.conditionText ? <small>{item.conditionText}</small> : null}
      </div>
      <div className="issue-card-actions">
        <button className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(item)} type="button">確認する</button>
        <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "edited")} type="button">保留</button>
      </div>
    </article>
  );
}

function CandidateDetailModal({ disabled, item, onClose, onDecision }) {
  if (!item) {
    return null;
  }
  const canDecide = Boolean(item.reviewItemId);
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
        </div>
        <footer className="fee-modal-footer">
          {canDecide && item.kind === "line" ? (
            <>
              <button className="btn btn--primary" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "approved")} type="button">算定する</button>
              <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "edited")} type="button">保留</button>
              <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected")} type="button">算定しない</button>
            </>
          ) : canDecide && item.kind === "proposal" && item.canAdopt ? (
            <>
              <button className="btn btn--primary" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "approved")} type="button">{item.nextActionLabel || `算定する ${item.pointsLabel || ""}`.trim()}</button>
              <button className="btn btn--ghost" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "edited")} type="button">保留</button>
            </>
          ) : canDecide ? (
            <button className="btn btn--primary" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "edited")} type="button">保留にする</button>
          ) : null}
        </footer>
      </section>
    </div>
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
    <div className="fee-session-list">
      <div className="session-card--loading" />
      <div className="session-card--loading" />
      <div className="session-card--loading" />
    </div>
  );
}

function SessionList({ sessions }) {
  if (!sessions.length) {
    return <div className="fee-empty-state">条件に一致する算定履歴はありません。</div>;
  }

  return (
    <div className="fee-session-list">
      {sessions.map((session) => (
        <article className="fee-session-card" key={session.feeSessionId}>
          <a className="fee-session-card-link" href={`/sessions/${encodeURIComponent(session.feeSessionId)}`}>
            <div className="fee-session-card-info">
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

function Pagination({ onPageChange, pageInfo }) {
  if (pageInfo.totalPages <= 1) {
    return null;
  }
  return (
    <nav className="fee-pagination" aria-label="算定履歴ページ移動">
      <button className="btn btn--ghost btn--sm" disabled={pageInfo.page <= 1} onClick={() => onPageChange(pageInfo.page - 1)} type="button">前へ</button>
      <div className="fee-page-list">
        {buildPageItems(pageInfo.page, pageInfo.totalPages).map((item, index) => (
          item === "ellipsis"
            ? <span className="fee-page-ellipsis" key={`ellipsis-${index}`}>...</span>
            : (
              <button
                className={`fee-page-chip ${item === pageInfo.page ? "is-active" : ""}`}
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
      <button className="btn btn--ghost btn--sm" disabled={pageInfo.page >= pageInfo.totalPages} onClick={() => onPageChange(pageInfo.page + 1)} type="button">次へ</button>
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

async function runBusy(setBusy, setMessage, task) {
  setBusy(true);
  setMessage(null);
  try {
    await task();
  } catch (error) {
    setMessage({ type: "error", text: toUserFacingErrorMessage(error, "処理に失敗しました。") });
  } finally {
    setBusy(false);
  }
}

function applyDetailResponse(response, setters) {
  const session = response.feeSession || response;
  setters.setFeeSession(session || null);
  setters.setReceiptDraft(response.receiptDraft || null);
  setters.setReviewItems(response.reviewItems || []);
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
    claimContext: parseJsonObjectField(form.claimContextText, "詳細条件 JSON"),
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
    claimContextText: "",
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
    claimContextText: formatJsonObject(session.claimContext),
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
  const rows = [];
  for (const rule of CLINICAL_ORDER_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      rows.push({
        orderType: rule.orderType,
        localName: rule.localName,
        standardCode: rule.standardCode || "",
        standardName: rule.standardName || "",
        quantity: "1"
      });
    }
  }
  if (!rows.length && text.length >= 20) {
    rows.push({
      orderType: "other",
      localName: "カルテ記載内容から算定候補を確認",
      standardCode: "",
      quantity: "1"
    });
  }
  return dedupeRows(rows);
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
  const names = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (isHistoricalDiagnosisContext(sentence)) {
      continue;
    }
    for (const rule of CLINICAL_DIAGNOSIS_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(sentence))) {
        names.push(rule.name);
      }
    }
  }
  return Array.from(new Set(names)).join("\n");
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

function splitClinicalSentences(value) {
  return normalizeClinicalText(value)
    .split(/[\n。]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isHistoricalDiagnosisContext(value) {
  return /(既往|既往歴|内服中|持病|併存|合併症|服用中|常用)/u.test(value);
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.orderType}:${row.localName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
      quantity: String(row.quantity || "1").trim() || "1"
    }))
    .filter((row) => !isAutoPlaceholderOrderRow(row))
    .filter((row) => row.localName || row.standardCode)
    .map((row, index) => ({
      orderId: `ui_order_${index + 1}`,
      orderType: row.orderType,
      localName: row.localName || row.standardCode,
      standardCode: row.standardCode || undefined,
      standardName: row.standardName || undefined,
      quantity: Number(row.quantity || 1)
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
    quantity: String(order.quantity || "1")
  }));
}

function createEmptyOrderRow() {
  return {
    orderType: "procedure",
    localName: "",
    standardCode: "",
    standardName: "",
    quantity: "1"
  };
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

function buildDisplayReviewItems(items = []) {
  const lineTexts = (Array.isArray(items) ? items : [])
    .filter((item) => item?.sourceType === "line_item")
    .map((item) => `${item.lineItem?.name || ""} ${item.title || ""}`)
    .join(" ");
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.sourceType === "warning" && shouldSuppressWarningForExistingLine(item, lineTexts)) {
      continue;
    }
    const displayTitle = reviewItemTitle(item);
    const displayReason = humanizeReviewMessage(item.reason || item.lineItem?.reason || "");
    const key = semanticReviewKey(item, displayTitle, displayReason);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      ...item,
      displayTitle,
      displayReason
    });
  }
  return result;
}

function normalizeCandidateWorkbenchModel(model = {}) {
  const lines = Array.isArray(model.lines) ? model.lines : [];
  const includedLines = Array.isArray(model.includedLines)
    ? model.includedLines
    : lines.filter((line) => line.inclusionStatus !== "pending" && line.inclusionStatus !== "excluded");
  const pendingLines = Array.isArray(model.pendingLines)
    ? model.pendingLines
    : lines.filter((line) => line.inclusionStatus === "pending");
  const excludedLines = Array.isArray(model.excludedLines)
    ? model.excludedLines
    : lines.filter((line) => line.inclusionStatus === "excluded");
  const proposals = Array.isArray(model.proposals) ? model.proposals : [];
  const issues = Array.isArray(model.issues) ? model.issues : [];
  const includedCount = Number(model.includedCount ?? model.counts?.included ?? includedLines.length);
  const pendingCount = Number(model.pendingCount ?? model.counts?.pending ?? pendingLines.length);
  const excludedCount = Number(model.excludedCount ?? model.counts?.excluded ?? excludedLines.length);
  const needsReview = Number(model.counts?.needsReview ?? model.needsReviewCount ?? (proposals.length + issues.length + pendingLines.length));
  const potentialPointsTotal = Number(model.potentialPointsTotal ?? proposals.reduce((sum, item) => sum + Number(item.potentialPoints || 0), 0));
  return {
    ...model,
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    proposals,
    issues,
    counts: {
      ...(model.counts || {}),
      included: includedCount,
      pending: pendingCount,
      excluded: excludedCount,
      proposals: Number(model.counts?.proposals ?? proposals.length),
      issues: Number(model.counts?.issues ?? issues.length),
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

function buildCandidateWorkbenchModel({ calculation, receiptDraft, reviewItems }) {
  const items = Array.isArray(reviewItems) ? reviewItems : [];
  const lineReviewMap = new Map(items
    .filter((item) => item?.sourceType === "line_item")
    .map((item) => [lineReviewItemClientId(item.lineItem || {}), item]));
  const receiptLineMap = new Map((receiptDraft?.lines || []).map((line) => [receiptLineKey(line), line]));
  const lines = (Array.isArray(calculation?.lineItems) ? calculation.lineItems : []).map((line) => {
    const reviewItem = lineReviewMap.get(lineReviewItemClientId(line)) || null;
    const receiptLine = receiptLineMap.get(lineReviewItemClientId(line)) || receiptLineMap.get(line.code || "") || null;
    const decisionStatus = lineDecisionStatus(reviewItem, receiptLine);
    const inclusionStatus = decisionStatus === "rejected" ? "excluded" : decisionStatus === "edited" ? "pending" : "included";
    return {
      kind: "line",
      kindLabel: "算定中の明細",
      reviewItemId: reviewItem?.reviewItemId || lineReviewItemClientId(line),
      name: line.name || "未分類",
      displayTitle: line.name || "算定候補",
      displayReason: lineDisplayReason(line, reviewItem),
      conditionText: lineConditionText(line),
      decisionStatus,
      inclusionStatus,
      metaLabel: lineMetaLabel(line),
      statusLabel: inclusionStatusLabel(inclusionStatus),
      totalPoints: Number(line.totalPoints || 0),
      pointsLabel: `${Number(line.totalPoints || 0).toLocaleString()}点`,
      lineItem: line
    };
  });
  const warningItems = items.filter((item) => item?.sourceType !== "line_item");
  const proposals = [];
  const issues = [];
  for (const item of warningItems) {
    const normalized = normalizeActionItem(item);
    if (isIncreaseProposal(item, normalized)) {
      proposals.push({
        ...normalized,
        kind: "proposal",
        kindLabel: "増点提案",
        pointsLabel: normalized.pointsLabel || "点数確認"
      });
    } else {
      issues.push({
        ...normalized,
        kind: "issue",
        kindLabel: "確認・修正"
      });
    }
  }
  const includedLines = lines.filter((line) => line.inclusionStatus === "included");
  const pendingLines = lines.filter((line) => line.inclusionStatus === "pending");
  const excludedLines = lines.filter((line) => line.inclusionStatus === "excluded");
  return {
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    proposals,
    issues,
    includedCount: includedLines.length,
    excludedCount: excludedLines.length,
    pendingCount: pendingLines.length,
    includedTotalPoints: receiptDraft?.totalPoints ?? includedLines.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0)
  };
}

function lineReviewItemClientId(line = {}) {
  return `line_${line.lineId || line.sourceLineId || line.code || line.name}`;
}

function receiptLineKey(line = {}) {
  return line.sourceLineId ? `line_${line.sourceLineId}` : line.code || line.name || "";
}

function lineDecisionStatus(reviewItem, receiptLine) {
  if (["approved", "rejected", "edited"].includes(reviewItem?.status)) {
    return reviewItem.status;
  }
  if (receiptLine?.inclusionStatus === "excluded") return "rejected";
  if (receiptLine?.inclusionStatus === "pending") return "edited";
  return "approved";
}

function inclusionStatusLabel(status) {
  return {
    included: "算定中",
    excluded: "算定しない",
    pending: "保留"
  }[status] || "算定中";
}

function lineDisplayReason(line = {}, reviewItem = null) {
  const reason = reviewItem?.displayReason || humanizeReviewMessage(line.reason || reviewItem?.reason || "");
  if (reason && reason !== "算定候補の内容を確認してください。") {
    return reason;
  }
  return `${line.name || "この明細"}を候補化しています。条件に合わない場合は「算定しない」に変更してください。`;
}

function lineConditionText(line = {}) {
  const category = lineBusinessCategory(line);
  if (category === "基本料") return "受診履歴と初診/再診の条件を確認してください。";
  if (category === "画像") return "実施済みの検査であること、撮影内容、機器区分を確認してください。";
  if (category === "薬剤" || category === "投薬") return "今回処方した薬剤・日数・数量を確認してください。";
  if (category === "検査" || category === "診療行為") return "当日に実施した内容であること、必要なコメントや病名を確認してください。";
  return "カルテ内容と算定条件を確認してください。";
}

function normalizeActionItem(item = {}) {
  const displayTitle = item.displayTitle || reviewItemTitle(item);
  const displayReason = item.displayReason || humanizeReviewMessage(item.reason || item.lineItem?.reason || "");
  const conditionText = proposalConditionText(displayTitle, displayReason);
  const issueCategory = item.issueCategory
    ? { key: item.issueCategory, label: item.issueCategoryLabel || "確認事項" }
    : issueCategoryForActionItem(item, { displayTitle, displayReason, conditionText });
  return {
    reviewItemId: item.reviewItemId,
    displayTitle,
    displayReason,
    conditionText,
    reasonText: displayReason,
    pointsLabel: proposalPointsLabel(item, displayTitle, displayReason),
    issueCategory: issueCategory.key,
    issueCategoryLabel: issueCategory.label,
    sourceItem: item
  };
}

function issueCategoryForActionItem(item = {}, normalized = {}) {
  const text = [
    normalized.displayTitle,
    normalized.displayReason,
    normalized.conditionText,
    item.title,
    item.reason,
    item.candidateProposal?.conditionText,
    item.lineItem?.name
  ].filter(Boolean).join(" ");
  if (/施設基準|地方厚生局|届け出|届出|facility_standard|hospital_profile/u.test(text)) {
    return { key: "facility", label: "施設設定" };
  }
  if (/病名|傷病名|コメント|適応|査定/u.test(text)) {
    return { key: "diagnosis", label: "病名・コメント" };
  }
  if (/薬剤|処方|数量|日数|総量|1回量|1日回数/u.test(text)) {
    return { key: "medication", label: "薬剤情報" };
  }
  if (/標準コード|マスター|コード確定|候補を選ぶ|検索/u.test(text)) {
    return { key: "master", label: "マスター確認" };
  }
  if (/実施|予定|依頼|オーダー|検討|指導のみ|説明のみ|当日/u.test(text)) {
    return { key: "evidence", label: "実施確認" };
  }
  if (/未入力|不足|入力|空欄/u.test(text)) {
    return { key: "input", label: "入力不足" };
  }
  return { key: "rule", label: "算定条件" };
}

function isIncreaseProposal(item = {}, normalized = {}) {
  const text = `${normalized.displayTitle || ""} ${normalized.displayReason || ""} ${item.title || ""} ${item.reason || ""}`;
  if (/終了|中止|既往薬|内服中|保留|次回判断|今回処方として確定できない/u.test(text)) {
    return false;
  }
  return /加算|算定できます|算定でき|実施済みの場合|届出|施設基準|病名|コメント|数量|日数|処方|MRI|CT|超音波|CA125|検査判断料|採血料/u.test(text)
    && !/次回|予定のみ|指導のみ|実施していません/u.test(text);
}

function proposalConditionText(title = "", reason = "") {
  const text = `${title} ${reason}`;
  if (/施設基準|届け出|届出/u.test(text)) {
    return "施設基準を地方厚生局に届け出済みなら、該当する加算を算定できます。";
  }
  if (/MRI|CT|画像|撮影/u.test(text)) {
    return "実際に当日実施した検査なら算定できます。予定や依頼だけの場合は保留にしてください。";
  }
  if (/薬剤|処方|数量|日数/u.test(text)) {
    return "今回処方した薬剤で、日数・数量を確認できれば算定できます。";
  }
  if (/病名|コメント/u.test(text)) {
    return "必要な病名またはレセプトコメントを確認・追記できれば算定できます。";
  }
  return "条件を満たす場合は算定できます。満たさない場合は保留にしてください。";
}

function proposalPointsLabel(item = {}, title = "", reason = "") {
  const linePoints = Number(item.lineItem?.totalPoints || 0);
  if (linePoints > 0) return `+${linePoints.toLocaleString()}点`;
  const match = `${title} ${reason}`.match(/([+＋]\s*)?(\d{1,4})\s*点/u);
  if (match) return `+${Number(match[2]).toLocaleString()}点`;
  return "";
}

function shouldSuppressWarningForExistingLine(item = {}, lineTexts = "") {
  const text = `${item.title || ""} ${item.reason || ""}`;
  return /レバミピド/u.test(text) && /数量|日数|不足/u.test(text) && /レバミピド/u.test(lineTexts);
}

function semanticReviewKey(item = {}, title = "", reason = "") {
  const text = `${title} ${reason} ${item.title || ""} ${item.reason || ""} ${item.lineItem?.name || ""}`.toLowerCase();
  if (/施設基準|hospital_profile_missing|facility_standard/u.test(text)) return "warning:facility_standard";
  if (/ca\s*125|ca125/u.test(text)) return item.sourceType === "line_item" ? "line:lab:ca125" : "warning:lab:ca125";
  if (/経腟|経膣|超音波|エコー|ultrasound/u.test(text)) return item.sourceType === "line_item" ? "line:procedure:ultrasound" : "warning:procedure:ultrasound";
  if (/mri|ｍｒｉ/u.test(text) && /予定|依頼|オーダー|planned|ordered/u.test(text)) return "warning:mri_planned";
  if (/単純x線|x線|レントゲン|simple_radiography/u.test(text) && /撮影方式|写真診断|機器|条件/u.test(text)) return "warning:simple_radiography_condition";
  if (/レバミピド/u.test(text) && /数量|日数|不足/u.test(text)) return "warning:drug_quantity:rebamipide";
  if (/ロコア/u.test(text) && /数量|日数|不足/u.test(text)) return "warning:drug_quantity:locoa";
  if (/ロコア|湿布/u.test(text) && /マスター|解決でき/u.test(text)) return "warning:patch_master";
  if (/コルセット/u.test(text)) return "warning:corset_instruction";
  if (item.sourceType === "line_item") return `line:${item.lineItem?.code || item.lineItem?.name || item.reviewItemId}`;
  return `${item.sourceType || "review"}:${title}:${reason}`;
}

function reviewItemTitle(item = {}) {
  const text = `${item.title || ""} ${item.reason || ""} ${item.lineItem?.name || ""}`;
  if (/施設基準|hospital_profile_missing|facility_standard/u.test(text)) return "施設基準の確認";
  if (/mri|ｍｒｉ/u.test(text) && /予定|依頼|オーダー|planned|ordered/u.test(text)) return "MRIは予定扱い";
  if (/単純X線|単純x線|X線|x線|レントゲン|simple_radiography/u.test(text) && /撮影方式|写真診断|機器|条件/u.test(text)) return "単純X線の撮影条件確認";
  if (/CA\s*125|CA125/u.test(text)) return "CA125検査の算定確認";
  if (/経腟|経膣|超音波|エコー|ultrasound/u.test(text)) return "経腟超音波の算定確認";
  if (/レバミピド/u.test(text) && /数量|日数|不足/u.test(text)) return "レバミピドの数量/日数確認";
  if (/ロコア/u.test(text) && /数量|日数|不足/u.test(text)) return "湿布の数量/日数確認";
  if (/ロコア|湿布/u.test(text) && /マスター|解決でき/u.test(text)) return "湿布のマスター確認";
  if (/コルセット/u.test(text)) return "コルセットは指導のみ";
  if (/調剤料|処方料|Medication fee/i.test(text)) return "投薬料の確認";
  if (/単純撮影|画像|Imaging fee/i.test(text)) return "画像診断料の確認";
  if (/初診|再診|Outpatient basic/i.test(text)) return "初再診料の確認";
  if (item.sourceType === "warning") return "確認事項";
  return item.title || item.lineItem?.name || "算定候補の確認";
}

function humanizeReviewMessage(message = "") {
  const raw = String(message || "").trim();
  if (!raw) return "算定候補の内容を確認してください。";
  const text = raw.replace(/^[a-z][a-z0-9_]*:\s*/iu, "").trim();
  if (/hospital_profile_missing|facility_standard|Lab management fee skipped|施設基準がない|施設基準/u.test(raw)) {
    return "施設基準が登録されていないため、施設基準が必要な加算は自動追加していません。";
  }
  if (/This result is a billing candidate/i.test(text)) {
    return "この結果は算定候補です。確定請求前に内容を確認してください。";
  }
  if (/Input drug code; medical drug fee rounded/i.test(text)) {
    return "入力された薬剤コードから薬剤料を候補化しました。薬価合計を点数に換算しています。";
  }
  if (/Medication fee candidate for in_house/i.test(text)) {
    return "院内処方に関する投薬料候補です。処方内容と算定条件を確認してください。";
  }
  if (/D026 judgement fee for group/i.test(text)) {
    return "検査判断料の候補です。実施検査と同月算定条件を確認してください。";
  }
  if (/Collection fee requested by blood_venous/i.test(text)) {
    return "静脈採血料の候補です。採血実施と算定条件を確認してください。";
  }
  if (/Outpatient rapid lab add-on skipped/i.test(text)) {
    return "外来迅速検体検査加算は、当日説明・文書要件を確認できないため自動追加していません。";
  }
  if (/Required comment candidate:/i.test(text)) {
    return text
      .replace(/^Required comment candidate:\s*/iu, "レセプトコメントの確認: ")
      .replace(/\s+needs\s+/iu, " に必要なコメント: ");
  }
  if (/Imaging fee candidate for simple_radiography/i.test(text)) {
    return "単純X線に関する画像診断料候補です。撮影方式と写真診断区分を確認してください。";
  }
  if (/Imaging fee candidate for ct/i.test(text)) {
    return "CT撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Imaging fee candidate for mri/i.test(text)) {
    return "MRI撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Outpatient basic fee candidate for initial/i.test(text)) {
    return "初診料の候補です。受診履歴と初診の条件を確認してください。";
  }
  if (/Outpatient basic fee candidate for revisit/i.test(text)) {
    return "再診料の候補です。受診履歴と再診の条件を確認してください。";
  }
  if (/Input medical procedure code matched master only/i.test(text)) {
    return "標準マスターには一致しましたが、章ごとの算定条件は未確認です。";
  }
  return text
    .replace(/\bmaster lookup\b/giu, "マスター照合")
    .replace(/\bin_house\b/giu, "院内処方")
    .replace(/\bsimple_radiography\b/giu, "単純X線")
    .replace(/\bmedical_fee_calculation\b/giu, "算定エンジン")
    .replace(/\bdrug_master\b|\bmedical_procedure_master\b|\bmaterial_master\b/giu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function lineMetaLabel(line = {}) {
  const code = String(line.code || "").trim();
  const category = lineBusinessCategory(line);
  return [code, category].filter(Boolean).join(" / ") || category || "分類未設定";
}

function lineBusinessCategory(line = {}) {
  const text = `${line.orderType || ""} ${line.source || ""} ${line.coverage?.scope || ""}`.toLowerCase();
  if (/outpatient_basic|basic/u.test(text)) return "基本料";
  if (/medication_fee/u.test(text)) return "投薬";
  if (/drug/u.test(text)) return "薬剤";
  if (/imaging/u.test(text)) return "画像";
  if (/lab/u.test(text)) return "検査";
  if (/material/u.test(text)) return "特定器材";
  if (/procedure|treatment|medical_procedure/u.test(text)) return "診療行為";
  return "算定候補";
}

function humanizeCoverageDescription(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/billing candidate and review-support draft/i.test(text)) {
    return "対応範囲内で候補化できた算定行です。確定請求前にレビューしてください。";
  }
  return humanizeReviewMessage(text);
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
    edited: "保留",
    not_calculated: "未算定"
  })[value] || value || "-";
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
