"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatformAuth } from "./platform-auth";

const FEE_SESSION_PAGE_SIZE = 20;
const MAX_RENDERED_LINE_ITEMS = 120;
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
  { orderType: "lab", localName: "検体検査", patterns: [/検査/u, /採血/u, /血液/u, /尿検査/u, /CRP/iu, /HbA1c/iu] },
  { orderType: "procedure", localName: "処置・手技", patterns: [/処置/u, /創傷/u, /創部/u, /熱傷/u, /洗浄/u, /消毒/u, /縫合/u, /抜糸/u] },
  { orderType: "drug", localName: "薬剤処方", patterns: [/処方/u, /内服/u, /外用/u, /軟膏/u, /クリーム/u, /ゲーベン/u, /薬/u] },
  { orderType: "material", localName: "特定器材・材料", patterns: [/ガーゼ/u, /包帯/u, /テープ/u, /材料/u, /カテーテル/u] },
  { orderType: "injection", localName: "注射", patterns: [/注射/u, /点滴/u, /静注/u, /皮下注/u] },
  { orderType: "imaging", localName: "画像診断", patterns: [/画像/u, /レントゲン/u, /X線/iu, /CT/iu, /MRI/iu] },
  { orderType: "treatment", localName: "医学管理等", patterns: [/指導/u, /管理/u, /療養/u, /説明/u] }
];
const CLINICAL_DIAGNOSIS_RULES = [
  { name: "熱傷", patterns: [/熱傷/u, /やけど/u] },
  { name: "創傷", patterns: [/創傷/u, /創部/u, /裂創/u, /擦過傷/u] },
  { name: "急性上気道炎疑い", patterns: [/風邪/u, /上気道/u, /咽頭/u, /咳/u, /鼻汁/u, /発熱/u] },
  { name: "高血圧症", patterns: [/高血圧/u] },
  { name: "糖尿病", patterns: [/糖尿病/u, /HbA1c/iu] },
  { name: "脂質異常症", patterns: [/脂質異常/u, /高脂血/u] }
];

export function FeeWorkspace({ mode = "list", sessionId = "" }) {
  if (mode === "new") {
    return <NewFeeSessionView />;
  }

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

function NewFeeSessionView() {
  const feeApi = useFeeApi();
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

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
      window.location.replace(`/sessions/${encodeURIComponent(nextId)}`);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "算定記録を作成できませんでした。"));
      setCreating(false);
    }
  }

  return (
    <main className="fee-shell">
      <header className="fee-page-head">
        <div>
          <h1>新しい算定</h1>
          <p>空の算定記録を作成してから、患者、診療日、オーダーを入力します。</p>
        </div>
        <a className="btn btn--ghost" href="/sessions">一覧へ戻る</a>
      </header>

      <section className="fee-card fee-quick-start">
        <div>
          <span className="label">算定記録</span>
          <h2>入力画面を開きます</h2>
          <p>作成後、自動的に算定詳細へ移動します。詳細画面で入力保存、算定候補作成、レビュー更新ができます。</p>
        </div>
        <button className="btn btn--primary btn--lg" disabled={creating} onClick={createSession} type="button">
          算定記録を作成
        </button>
      </section>
      {errorMessage ? <div className="fee-error-state" role="status">{errorMessage}</div> : null}
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
  const [form, setForm] = useState(defaultFeeForm);
  const [orderRows, setOrderRows] = useState([createEmptyOrderRow()]);
  const [patientFilter, setPatientFilter] = useState("");
  const [newPatient, setNewPatient] = useState(defaultPatientForm);
  const [masterType, setMasterType] = useState("procedure");
  const [masterQuery, setMasterQuery] = useState("");
  const [masterItems, setMasterItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

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
      applyDetailResponse(detail, {
        setFeeSession,
        setReceiptDraft,
        setReviewItems,
        setForm,
        setOrderRows
      });
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "算定詳細を読み込めませんでした。") });
    } finally {
      setLoading(false);
    }
  }, [feeApi, sessionId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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

  function updateForm(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function saveDetails(options = {}) {
    const body = buildFeeSessionPayload({
      defaultFacilityId,
      form,
      orderRows,
      patients
    });
    const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      csrf: true,
      body
    });
    applyDetailResponse(response, {
      setFeeSession,
      setReceiptDraft,
      setReviewItems,
      setForm,
      setOrderRows
    });
    if (!options.silent) {
      setMessage({ type: "success", text: "入力を保存しました。" });
    }
    return response;
  }

  async function handleSave(event) {
    event.preventDefault();
    await runBusy(setBusy, setMessage, async () => {
      await saveDetails();
    });
  }

  async function calculate() {
    await runBusy(setBusy, setMessage, async () => {
      await saveDetails({ silent: true });
      const response = await feeApi(`/v1/fee/sessions/${encodeURIComponent(sessionId)}/calculate`, {
        method: "POST",
        csrf: true,
        body: {}
      });
      applyDetailResponse(response, {
        setFeeSession,
        setReceiptDraft,
        setReviewItems,
        setForm,
        setOrderRows
      });
      setMessage({ type: "success", text: "算定が完了しました。" });
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
      setReviewItems(response.reviewItems || []);
      setMessage({ type: "success", text: "レビューを更新しました。" });
    });
  }

  function addOrderRow() {
    setOrderRows((current) => [...current.filter((row) => row.localName || row.standardCode), createEmptyOrderRow()]);
  }

  function updateOrderRow(index, field, value) {
    setOrderRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [field]: value } : row
    )));
  }

  function removeOrderRow(index) {
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

    setOrderRows((current) => [
      ...current.filter((row) => row.localName || row.standardCode),
      {
        orderType: orderTypeFromMasterKind(item.kind),
        localName: item.name || "",
        standardCode: item.code || "",
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

  return (
    <main className="fee-shell">
      <header className="fee-page-head">
        <div>
          <span className="label">算定記録</span>
          <h1>{patientName}</h1>
          <p>作成 {formatDateTime(feeSession?.createdAt)} ・ {feeSession?.serviceDate || "診療日未設定"}</p>
        </div>
        <a className="btn btn--ghost" href="/sessions">一覧へ戻る</a>
      </header>

      {message ? <div className={`fee-message fee-message--${message.type}`} role="status">{message.text}</div> : null}

      <div className="fee-detail-grid">
        <section className="fee-card">
          <div className="fee-section-head">
            <div>
              <h2>カルテから算定候補を作成</h2>
              <p>患者を選び、カルテ本文を貼り付けるだけで算定候補を作成します。</p>
            </div>
            <span className="badge review">要レビュー前提</span>
          </div>

          <form className="fee-detail-form" onSubmit={handleSave}>
            <label>
              <span>患者検索</span>
              <input
                placeholder="氏名・患者番号で検索"
                value={patientFilter}
                onChange={(event) => setPatientFilter(event.target.value)}
              />
            </label>
            <label>
              <span>患者</span>
              <select value={form.patientId} onChange={(event) => updateForm("patientId", event.target.value)}>
                <option value="">患者を選択</option>
                {filteredPatients.map((patient) => (
                  <option key={patient.patientId} value={patient.patientId}>
                    {patient.displayName} ({patient.patientCode || patient.primaryPatientNumber || patient.externalPatientIds?.[0] || patient.patientId})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>カルテの内容</span>
              <textarea
                className="clinical-textarea"
                placeholder={"S/O/A/Pや診療メモをそのまま貼り付けてください。"}
                value={form.clinicalText}
                onChange={(event) => updateForm("clinicalText", event.target.value)}
              />
              <small>本文から病名・オーダー候補を自動補完します。必要な場合だけ詳細を開いて修正してください。</small>
            </label>

            <details className="advanced-fee-inputs fee-detail-advanced">
              <summary>詳細を確認・修正</summary>
              <div className="advanced-fee-inputs-body">
                <ScopeNotice setting={form.setting} />
                <MasterStatus available={masterSearchAvailable} />
                <PatientCreateForm
                  disabled={busy}
                  patient={newPatient}
                  setPatient={setNewPatient}
                  onSubmit={createPatient}
                />
                <div className="fee-form-grid fee-form-grid--two">
                  {facilities.length > 1 ? (
                    <label>
                      <span>施設</span>
                      <select value={form.facilityId || defaultFacilityId} onChange={(event) => updateForm("facilityId", event.target.value)}>
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
                    <select value={form.departmentId} onChange={(event) => updateForm("departmentId", event.target.value)}>
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
                    <select value={form.setting} onChange={(event) => updateForm("setting", event.target.value)}>
                      <option value="outpatient">外来</option>
                      <option value="inpatient">入院（限定対応）</option>
                    </select>
                  </label>
                  <label>
                    <span>診療日</span>
                    <input type="date" value={form.serviceDate} onChange={(event) => updateForm("serviceDate", event.target.value)} />
                  </label>
                  <label>
                    <span>請求月</span>
                    <input type="month" value={form.claimMonth} onChange={(event) => updateForm("claimMonth", event.target.value)} />
                  </label>
                </div>
                <label>
                  <span>病名</span>
                  <textarea
                    placeholder={"例: 高血圧症\n糖尿病疑い"}
                    value={form.diagnosesText}
                    onChange={(event) => updateForm("diagnosesText", event.target.value)}
                  />
                  <small>未入力の場合はカルテ本文から候補を補完し、不足時はレビューに出します。</small>
                </label>

                <div className="order-editor-field">
                  <span className="field-label">オーダー</span>
                  <p className="field-note">通常はカルテ本文から候補を補完します。必要な場合のみ、マスター検索または手入力で修正してください。</p>
                  <div className="master-search-panel">
                    <div className="master-search-controls">
                      <select value={masterType} onChange={(event) => setMasterType(event.target.value)} disabled={!masterSearchAvailable}>
                        {MASTER_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <input
                        type="search"
                        placeholder={masterSearchAvailable ? "名称またはコードで検索" : "マスター検索APIの反映待ちです"}
                        value={masterQuery}
                        onChange={(event) => setMasterQuery(event.target.value)}
                        disabled={!masterSearchAvailable}
                      />
                    </div>
                    <MasterSearchResults
                      available={masterSearchAvailable}
                      items={masterItems}
                      query={masterQuery}
                      onAdd={addMasterSearchItem}
                    />
                  </div>
                  <OrderEditor rows={orderRows} onAdd={addOrderRow} onRemove={removeOrderRow} onUpdate={updateOrderRow} />
                </div>

                <details className="advanced-fee-inputs advanced-fee-inputs--nested">
                  <summary>詳細条件・算定オプション</summary>
                  <div className="fee-form-grid fee-form-grid--two advanced-fee-inputs-grid">
                    <label>
                      <span>詳細条件 JSON</span>
                      <textarea
                        className="mono-textarea"
                        spellCheck={false}
                        value={form.claimContextText}
                        onChange={(event) => updateForm("claimContextText", event.target.value)}
                      />
                    </label>
                    <label>
                      <span>算定オプション JSON</span>
                      <textarea
                        className="mono-textarea"
                        spellCheck={false}
                        value={form.calculationOptionsText}
                        onChange={(event) => updateForm("calculationOptionsText", event.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </div>
            </details>

            <div className="button-row">
              <button className="btn btn--ghost" disabled={busy} type="submit">入力を保存</button>
              <button className="btn btn--primary" disabled={busy} onClick={calculate} type="button">カルテから算定候補を作成</button>
              <button className="btn btn--ghost" disabled={busy} onClick={loadAll} type="button">最新の状態に更新</button>
            </div>
          </form>
        </section>

        <div className="fee-detail-main">
          <section className="fee-card">
            <div className="fee-section-head">
              <div>
                <h2>算定候補</h2>
                <p>対応範囲と確認が必要な理由を確認してください。</p>
              </div>
            </div>
            <CalculationResult feeSession={feeSession} calculation={calculation} />
          </section>

          <section className="fee-card">
            <h2>レビュー</h2>
            <ReviewList disabled={busy} items={reviewItems} onDecision={decideReviewItem} selected={Boolean(sessionId)} />
          </section>

          <section className="fee-card">
            <h2>レセプト案</h2>
            <ReceiptDraft receiptDraft={receiptDraft} selected={Boolean(sessionId)} />
          </section>
        </div>
      </div>
    </main>
  );
}

function PatientCreateForm({ disabled, onSubmit, patient, setPatient }) {
  return (
    <details className="patient-inline-create">
      <summary>登録されていない患者を追加する</summary>
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

function MasterSearchResults({ available, items, onAdd, query }) {
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
        <article className="master-search-result" key={`${item.kind || "master"}-${item.code || index}`}>
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

function CalculationResult({ calculation, feeSession }) {
  if (!calculation) {
    return (
      <div className="result result-empty">
        <div className="notice-card">
          <strong>算定記録を準備しました</strong>
          <p>{feeSession?.patientSnapshot?.displayName || feeSession?.patientId || "患者未選択"} / {feeSession?.serviceDate || "診療日未設定"} / {statusLabel(feeSession?.status || "ready")}</p>
        </div>
        <p className="field-note">患者とカルテ本文を確認し、「カルテから算定候補を作成」で候補を作成してください。</p>
      </div>
    );
  }

  const coverage = calculation.coverage || {};
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  return (
    <div className="result">
      <div className="metric-row">
        <div className="metric">
          <span>合計点数候補</span>
          <strong>{Number(calculation.totalPoints || 0).toLocaleString()}</strong>
        </div>
        <div className="metric">
          <span>レビュー対象</span>
          <strong>{Number(coverage.reviewLineCount || lineItems.filter((line) => line.reviewRequired).length).toLocaleString()}</strong>
        </div>
        <div className="metric">
          <span>対応範囲</span>
          <strong>{supportLevelLabel(coverage.supportLevel || coverage.support_level)}</strong>
        </div>
      </div>
      <div className="notice-card">
        <strong>{scopeLabel(coverage.scope)}</strong>
        <p>{coverage.description || "算定候補・レビュー支援として表示しています。確定請求前に内容を確認してください。"}</p>
      </div>
      <CalculationWarnings warnings={calculation.warnings} />
      <LineItemTable lineItems={lineItems} />
    </div>
  );
}

function CalculationWarnings({ warnings }) {
  if (!Array.isArray(warnings) || !warnings.length) {
    return null;
  }
  return (
    <div className="notice-card">
      <strong>確認が必要な理由</strong>
      <p>{warnings.join("\n")}</p>
    </div>
  );
}

function LineItemTable({ lineItems }) {
  if (!lineItems.length) {
    return <p className="field-note">算定行はまだありません。</p>;
  }
  const visibleLineItems = lineItems.slice(0, MAX_RENDERED_LINE_ITEMS);
  const hiddenCount = lineItems.length - visibleLineItems.length;
  return (
    <>
      {hiddenCount > 0 ? (
        <p className="field-note">算定行が多いため、先頭{MAX_RENDERED_LINE_ITEMS}件を表示しています。残り{hiddenCount.toLocaleString()}件はレセプト案で確認してください。</p>
      ) : null}
      <div className="line-table-wrap">
        <table className="line-table">
          <thead>
            <tr>
              <th>算定候補</th>
              <th>状態</th>
              <th>対応</th>
              <th>理由</th>
              <th>点数</th>
            </tr>
          </thead>
          <tbody>
            {visibleLineItems.map((line, index) => (
              <tr key={`${line.code || "line"}-${index}`}>
                <td>
                  <div className="line-name">
                    <strong>{line.name || "未分類"}</strong>
                    <small>{line.code || ""} / {line.orderType || "unknown"} / {line.source || "source未設定"}</small>
                  </div>
                </td>
                <td><span className={badgeClass(line.status)}>{statusLabel(line.status)}</span></td>
                <td>{supportLevelLabel(line.supportLevel || line.support_level || line.coverage?.supportLevel || line.coverage?.support_level)}</td>
                <td>
                  {line.reason || coverageLabel(line.coverage)}
                  <div className="field-note">{coverageLabel(line.coverage)}</div>
                </td>
                <td>{Number(line.totalPoints || 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReviewList({ disabled, items, onDecision, selected }) {
  if (!items.length) {
    return <div className="fee-empty-state">{selected ? "確認が必要な項目はありません。" : "算定記録を選択してください。"}</div>;
  }
  return (
    <div className="review-list">
      {items.map((item) => (
        <article className="review-item" key={item.reviewItemId}>
          <header>
            <span>{item.title}</span>
            <span className={badgeClass(item.status)}>{statusLabel(item.status)}</span>
          </header>
          <p>{item.reason || ""}</p>
          {item.lineItem ? <p>{coverageLabel(item.lineItem.coverage)}</p> : null}
          <div className="button-row">
            <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "approved")} type="button">承認</button>
            <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "rejected")} type="button">却下</button>
            <button className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onDecision(item.reviewItemId, "edited")} type="button">修正済み</button>
          </div>
        </article>
      ))}
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
  }, [auth.csrfToken]);
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
  setters.setForm(formFromFeeSession(session || {}));
  setters.setOrderRows(orderRowsFromOrders(session?.orders || []));
}

function buildFeeSessionPayload({ defaultFacilityId, form, orderRows, patients }) {
  const patient = patients.find((item) => item.patientId === form.patientId);
  const chartInput = buildChartOnlyInput(form, orderRows);
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
    calculationOptionsText: formatJsonObject(session.calculationOptions)
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

function buildChartOnlyInput(form, orderRows) {
  const hasManualOrders = parseOrdersFromRows(orderRows).length > 0;
  const derivedOrderRows = hasManualOrders ? [] : deriveOrderRowsFromClinicalText(form.clinicalText);
  const diagnosesText = String(form.diagnosesText || "").trim() || deriveDiagnosesTextFromClinicalText(form.clinicalText);
  return {
    diagnosesText,
    orderRows: hasManualOrders || !derivedOrderRows.length ? orderRows : derivedOrderRows
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
        standardCode: "",
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
  for (const rule of CLINICAL_DIAGNOSIS_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      names.push(rule.name);
    }
  }
  return Array.from(new Set(names)).join("\n");
}

function normalizeClinicalText(value) {
  return String(value || "").trim();
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
      quantity: String(row.quantity || "1").trim() || "1"
    }))
    .filter((row) => row.localName || row.standardCode)
    .map((row, index) => ({
      orderId: `ui_order_${index + 1}`,
      orderType: row.orderType,
      localName: row.localName || row.standardCode,
      standardCode: row.standardCode || undefined,
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
    quantity: String(order.quantity || "1")
  }));
}

function createEmptyOrderRow() {
  return {
    orderType: "procedure",
    localName: "",
    standardCode: "",
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

function statusLabel(value) {
  return ({
    active: "作成中",
    review: "確認待ち",
    calculated: "算定候補作成済み",
    failed: "要確認",
    draft: "作成中",
    ready: "準備完了",
    needs_review: "要確認",
    completed: "完了",
    candidate: "候補",
    confirmed: "確認済み",
    approved: "承認",
    rejected: "却下",
    edited: "修正済み",
    not_calculated: "未算定"
  })[value] || value || "-";
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
    master_lookup_only: "マスターlookupのみ",
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
  if (["confirmed", "approved", "calculated", "completed", "ready", "active"].includes(status)) {
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
