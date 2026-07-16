"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingErrorMessage } from "@halunasu/web-ui/user-facing-error";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";
import { tokyoClaimMonth } from "../lib/tokyo-date";
import {
  BASELINE_COLUMN_FIELDS,
  BASELINE_UKE_FIELDS,
  baselineComparisonRows,
  baselineDiffToCsv,
  baselineDiffToHtml,
  buildBaselineDiffRequest,
  buildRecalculationDatasetDiffRequest,
  clinicDiagnosisSeverityLabel,
  clinicDiagnosisToCsv,
  clinicDiagnosisToHtml,
  downloadTextFile,
  emptyBaselineDiffOptions,
  isFeeUploadToolsAllowed,
  reproductionFailureRows
} from "../lib/baseline-diff";

function defaultClaimMonth() {
  return tokyoClaimMonth();
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
      error.status = response.status;
      throw error;
    }
    return payload;
  }, [auth.accessToken, auth.csrfToken]);
}

function countComparisonRows(comparisonRows, reproductionRows, summary = {}) {
  const countByStatus = (status) => comparisonRows.filter((row) => row.comparisonStatus === status).length;
  return {
    baseline_only: countByStatus("baseline_only"),
    engine_only: countByStatus("engine_only"),
    both_delta: countByStatus("both_delta"),
    matched: countByStatus("matched"),
    reproduction_failed: Number(summary?.reproductionFailureCount ?? reproductionRows.length) || 0
  };
}

function formatPointCell(value) {
  if (!Number.isFinite(Number(value))) {
    return "—";
  }
  return `${Number(value || 0).toLocaleString()}点`;
}

function formatDeltaPointCell(value) {
  if (!Number.isFinite(Number(value))) {
    return "—";
  }
  const numeric = Number(value || 0);
  return `${numeric > 0 ? "+" : ""}${numeric.toLocaleString()}点`;
}

export function FeeBaselineDiffConsole() {
  const feeApi = useFeeApi();
  const auth = usePlatformAuth();
  const [uploadToolsAllowed, setUploadToolsAllowed] = useState(false);
  const [claimMonth, setClaimMonth] = useState(defaultClaimMonth());
  const [options, setOptions] = useState(emptyBaselineDiffOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [datasetFile, setDatasetFile] = useState(null);
  const [datasetFiles, setDatasetFiles] = useState([]);
  const [datasetFileName, setDatasetFileName] = useState("");
  const [baselineFile, setBaselineFile] = useState(null);
  const [baselineFileName, setBaselineFileName] = useState("");
  const [recalculationFile, setRecalculationFile] = useState(null);
  const [recalculationFileName, setRecalculationFileName] = useState("");
  const [sourceFiles, setSourceFiles] = useState({});
  const [sourceFileNames, setSourceFileNames] = useState({});
  const [result, setResult] = useState(null);
  const [activeResultTab, setActiveResultTab] = useState("baseline_only");
  const [dragOverTarget, setDragOverTarget] = useState("");
  const datasetInputRef = useRef(null);
  const baselineInputRef = useRef(null);
  const recalculationInputRef = useRef(null);
  const patientInputRef = useRef(null);
  const chartInputRef = useRef(null);
  const orderInputRef = useRef(null);
  const diagnosisInputRef = useRef(null);
  const facilityInputRef = useRef(null);

  useEffect(() => {
    setUploadToolsAllowed(isFeeUploadToolsAllowed(auth.session));
  }, [auth.session]);

  const selectBaselineFile = useCallback((file) => {
    if (!file) {
      return;
    }
    setBaselineFile(file);
    setBaselineFileName(file.name || "");
    setResult(null);
    setError("");
  }, []);

  const selectDatasetFiles = useCallback((files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) {
      return;
    }
    setDatasetFiles(list);
    setDatasetFile(list.length === 1 ? list[0] : null);
    setDatasetFileName(list.length === 1
      ? (list[0].name || "")
      : `${list.length.toLocaleString()}ファイルを取込`);
    setResult(null);
    setError("");
  }, []);

  const selectRecalculationFile = useCallback((file) => {
    if (!file) {
      return;
    }
    setRecalculationFile(file);
    setRecalculationFileName(file.name || "");
    setResult(null);
    setError("");
  }, []);

  const selectSourceFile = useCallback((key, file) => {
    if (!file) {
      return;
    }
    setSourceFiles((current) => ({ ...current, [key]: file }));
    setSourceFileNames((current) => ({ ...current, [key]: file.name || "" }));
    setResult(null);
    setError("");
  }, []);

  const hasDatasetFiles = datasetFiles.length > 0 || Boolean(datasetFile);
  const canRunDiagnosis = Boolean(hasDatasetFiles || (baselineFile && (recalculationFile || sourceFiles.orders)));
  const [clinicBusy, setClinicBusy] = useState(false);
  const [clinicError, setClinicError] = useState("");
  const [clinicReport, setClinicReport] = useState(null);
  const [clinicIngestion, setClinicIngestion] = useState(null);

  // 売上改善診断(算定もれ・適応/禁忌/併用): 既存レセ(UKE/CSV)だけで実行できる。
  const runClinicDiagnosis = useCallback(async () => {
    if (!baselineFile) {
      setClinicError("既存レセ(.uke / .csv)を選択してください。");
      return;
    }
    setClinicBusy(true);
    setClinicError("");
    setClinicReport(null);
    setClinicIngestion(null);
    try {
      const body = await buildBaselineDiffRequest(baselineFile, { claimMonth, options });
      const response = await feeApi("/v1/fee/clinic-diagnosis", { method: "POST", csrf: true, body });
      setClinicReport(response?.report || null);
      setClinicIngestion(response?.ingestion || null);
    } catch (err) {
      setClinicError(toUserFacingErrorMessage(err, "売上改善診断を実行できませんでした。"));
    } finally {
      setClinicBusy(false);
    }
  }, [baselineFile, claimMonth, feeApi, options]);

  const runDiagnosis = useCallback(async () => {
    if (!canRunDiagnosis) {
      setError("診断データセット、または既存レセと再算定元データを選択してください。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = await buildRecalculationDatasetDiffRequest({
        datasetFile,
        datasetFiles,
        sourceFiles: {
          baselineReceipt: baselineFile,
          calculationPayloads: recalculationFile,
          ...sourceFiles
        },
        claimMonth,
        options
      });
      const response = await feeApi("/v1/fee/recalculation-diff-diagnosis", { method: "POST", csrf: true, body });
      setResult(response || null);
    } catch (err) {
      setError(toUserFacingErrorMessage(err, "差分診断を実行できませんでした。"));
    } finally {
      setBusy(false);
    }
  }, [baselineFile, canRunDiagnosis, claimMonth, datasetFile, datasetFiles, feeApi, options, recalculationFile, sourceFiles]);

  const updateOptions = useCallback((patch) => setOptions((current) => ({ ...current, ...patch })), []);

  const comparisonRows = useMemo(() => baselineComparisonRows(result), [result]);
  const reproductionRows = useMemo(() => reproductionFailureRows(result), [result]);
  const summary = result?.summary || null;
  const ingestion = result?.ingestion || null;
  const diagnostics = result?.diagnostics || null;
  const receiptParse = diagnostics?.receiptParse || null;
  const recalculationAccuracy = diagnostics?.recalculationAccuracy || null;
  const resultClaimMonth = result?.claimMonth || claimMonth || "month";
  const resultTabs = useMemo(() => {
    const counts = countComparisonRows(comparisonRows, reproductionRows, summary);
    return [
      { id: "baseline_only", label: "既存のみ", count: counts.baseline_only, className: "baseline" },
      { id: "engine_only", label: "当社のみ", count: counts.engine_only, className: "engine" },
      { id: "both_delta", label: "両方差分あり", count: counts.both_delta, className: "both" },
      { id: "matched", label: "一致", count: counts.matched, className: "matched" },
      { id: "reproduction_failed", label: "再現失敗", count: counts.reproduction_failed, className: "repro" }
    ];
  }, [comparisonRows, reproductionRows, summary]);
  const visibleRows = useMemo(() => {
    if (activeResultTab === "reproduction_failed") {
      return reproductionRows;
    }
    return comparisonRows.filter((row) => row.comparisonStatus === activeResultTab);
  }, [activeResultTab, comparisonRows, reproductionRows]);
  const sourceDropConfigs = [
    ["patients", "患者情報", ".csv / .jsonl", patientInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["charts", "カルテ", ".csv / .jsonl", chartInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["orders", "オーダー", ".csv / .jsonl", orderInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["diagnoses", "病名", ".csv / .jsonl", diagnosisInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["facility", "施設設定", ".json / .csv", facilityInputRef, ".json,.csv,.tsv,application/json,text/csv"]
  ];

  useEffect(() => {
    if (!summary) {
      return;
    }
    const nextTab = resultTabs.find((tab) => tab.count > 0)?.id || "baseline_only";
    setActiveResultTab(nextTab);
  }, [resultTabs, summary]);

  if (!uploadToolsAllowed) {
    return (
      <div className="baseline-diff-locked">
        <strong>この機能はSTG環境または許可されたDemo組織だけで利用できます。</strong>
        <p>実患者データを扱う可能性があるため、通常のPROD組織には開放していません。</p>
      </div>
    );
  }

  return (
    <div className="baseline-diff">
      <div className="baseline-diff-toolbar">
        <label className="baseline-diff-month">
          <span>{hasDatasetFiles ? "請求月（データ内にない場合のみ使用）" : "請求月"}</span>
          <input type="month" value={claimMonth} onChange={(event) => setClaimMonth(event.target.value)} />
        </label>
        <p className="baseline-diff-note">診断データセット内の請求月を優先して、既存レセと当社再算定を患者×月で突合します。差分はすべて要確認です。</p>
      </div>

      <section className="baseline-diff-card">
        <div className="baseline-diff-card-head">
          <h3>1. データを取込</h3>
          <span>ZIP一括 または 個別ファイル</span>
        </div>
        <div
          className={`baseline-diff-drop baseline-diff-drop--wide ${dragOverTarget === "dataset" ? "is-over" : ""}`}
          onClick={() => datasetInputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragOverTarget("dataset"); }}
          onDragLeave={() => setDragOverTarget("")}
          onDrop={(event) => { event.preventDefault(); setDragOverTarget(""); selectDatasetFiles(event.dataTransfer.files); }}
          role="button"
          tabIndex={0}
        >
          <strong>診断データセット</strong>
          <span>manifest.json付き .zip / CSV・JSON複数選択</span>
          {datasetFileName ? <small>取込: {datasetFileName}</small> : null}
          <input
            accept=".zip,.json,.jsonl,.ndjson,.csv,.tsv,.uke,.txt,application/zip,application/json,text/csv"
            disabled={busy}
            hidden
            multiple
            onChange={(event) => { selectDatasetFiles(event.target.files); event.target.value = ""; }}
            ref={datasetInputRef}
            type="file"
          />
        </div>
        <div className="baseline-diff-upload-grid">
          <div
            className={`baseline-diff-drop ${dragOverTarget === "baseline" ? "is-over" : ""}`}
            onClick={() => baselineInputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragOverTarget("baseline"); }}
            onDragLeave={() => setDragOverTarget("")}
            onDrop={(event) => { event.preventDefault(); setDragOverTarget(""); const file = event.dataTransfer.files?.[0]; if (file) { selectBaselineFile(file); } }}
            role="button"
            tabIndex={0}
          >
            <strong>既存レセ</strong>
            <span>.csv / .uke（Shift_JIS可）</span>
            {baselineFileName ? <small>取込: {baselineFileName}</small> : null}
            <input
              accept=".csv,.uke,.txt,text/csv"
              disabled={busy}
              hidden
              onChange={(event) => { const file = event.target.files?.[0]; if (file) { selectBaselineFile(file); } event.target.value = ""; }}
              ref={baselineInputRef}
              type="file"
            />
          </div>
          <div
            className={`baseline-diff-drop ${dragOverTarget === "recalculation" ? "is-over" : ""}`}
            onClick={() => recalculationInputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragOverTarget("recalculation"); }}
            onDragLeave={() => setDragOverTarget("")}
            onDrop={(event) => { event.preventDefault(); setDragOverTarget(""); const file = event.dataTransfer.files?.[0]; if (file) { selectRecalculationFile(file); } }}
            role="button"
            tabIndex={0}
          >
            <strong>再算定元データ</strong>
            <span>再算定用 .json / .jsonl</span>
            {recalculationFileName ? <small>取込: {recalculationFileName}</small> : null}
            <input
              accept=".json,.jsonl,.ndjson,application/json"
              disabled={busy}
              hidden
              onChange={(event) => { const file = event.target.files?.[0]; if (file) { selectRecalculationFile(file); } event.target.value = ""; }}
              ref={recalculationInputRef}
              type="file"
            />
          </div>
        </div>
        <div className="baseline-diff-run">
          <button className="btn btn--primary" disabled={busy || !canRunDiagnosis} onClick={runDiagnosis} type="button">
            {busy ? "診断中..." : "差分診断を実行"}
          </button>
          <button className="btn btn--secondary" disabled={clinicBusy || !baselineFile} onClick={runClinicDiagnosis} type="button">
            {clinicBusy ? "点検中..." : "売上改善診断を実行（既存レセのみでOK）"}
          </button>
        </div>
        <p className="baseline-diff-note">アップロードは<strong>匿名化済みデータのみ</strong>にしてください（氏名・保険者番号等の直接識別子を含めない）。売上改善診断は既存レセに決定論点検（算定もれ・適応病名・禁忌・併用禁忌）を行います。<strong>SY（傷病名）付きUKE推奨</strong>：CSVの場合、性別・生年月日・病名の列マッピングが無いと適応・禁忌・年齢性別の点検は効かず、算定もれ中心の診断になります。DPCレセプトは対象外（スキップ件数を表示）。</p>

        <details className="baseline-diff-options">
          <summary>個別ファイル・詳細設定</summary>
          <div className="baseline-diff-options-body">
            <div className="baseline-diff-fieldset">
              <span className="baseline-diff-fieldset-label">個別ファイル（ZIPを使わない場合、または一部だけ差し替える場合）</span>
              <div className="baseline-diff-upload-grid baseline-diff-upload-grid--compact">
                {sourceDropConfigs.map(([key, label, hint, inputRef, accept]) => (
                  <div
                    className={`baseline-diff-drop ${dragOverTarget === key ? "is-over" : ""}`}
                    key={key}
                    onClick={() => inputRef.current?.click()}
                    onDragOver={(event) => { event.preventDefault(); setDragOverTarget(key); }}
                    onDragLeave={() => setDragOverTarget("")}
                    onDrop={(event) => { event.preventDefault(); setDragOverTarget(""); const file = event.dataTransfer.files?.[0]; if (file) { selectSourceFile(key, file); } }}
                    role="button"
                    tabIndex={0}
                  >
                    <strong>{label}</strong>
                    <span>{hint}</span>
                    {sourceFileNames[key] ? <small>取込: {sourceFileNames[key]}</small> : null}
                    <input
                      accept={accept}
                      disabled={busy}
                      hidden
                      onChange={(event) => { const file = event.target.files?.[0]; if (file) { selectSourceFile(key, file); } event.target.value = ""; }}
                      ref={inputRef}
                      type="file"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="baseline-diff-fieldset">
              <span className="baseline-diff-fieldset-label">CSV列マッピング（空欄=標準列名。列名が違う場合は指定）</span>
              <div className="baseline-diff-grid">
                {BASELINE_COLUMN_FIELDS.map(([key, label]) => (
                  <label className="fee-field" key={key}>
                    <span>{label}</span>
                    <input value={options.columnMap?.[key] || ""} onChange={(event) => updateOptions({ columnMap: { ...options.columnMap, [key]: event.target.value } })} />
                  </label>
                ))}
              </div>
            </div>
            <div className="baseline-diff-fieldset">
              <span className="baseline-diff-fieldset-label">UKEフィールド位置（.uke取込時のみ・0始まり・空欄=既定）</span>
              <div className="baseline-diff-grid">
                {BASELINE_UKE_FIELDS.map(([key, label]) => (
                  <label className="fee-field" key={key}>
                    <span>{label}</span>
                    <input inputMode="numeric" value={options.ukeLayout?.[key] || ""} onChange={(event) => updateOptions({ ukeLayout: { ...options.ukeLayout, [key]: event.target.value } })} />
                  </label>
                ))}
              </div>
            </div>
            <label className="fee-field">
              <span>当社未対応コード（カンマ/改行区切り。差分は「検討」に分類）</span>
              <textarea rows={2} value={options.knownUnsupportedText} onChange={(event) => updateOptions({ knownUnsupportedText: event.target.value })} />
            </label>
            <label className="fee-field">
              <span>コード対応表（1行に「既存コード=正規コード」）</span>
              <textarea rows={2} placeholder={"例)\nOLD_A=112007410"} value={options.codeMapText} onChange={(event) => updateOptions({ codeMapText: event.target.value })} />
            </label>
          </div>
        </details>
      </section>

      <section className="baseline-diff-card">
        <div className="baseline-diff-card-head">
          <h3>2. 診断結果</h3>
          {summary ? (
            <div className="baseline-diff-actions">
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`baseline-diff_${resultClaimMonth}.csv`, baselineDiffToCsv(result), "text/csv;charset=utf-8")} type="button">CSV出力</button>
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`baseline-diff_${resultClaimMonth}.html`, baselineDiffToHtml(result), "text/html;charset=utf-8")} type="button">HTML出力</button>
            </div>
          ) : null}
        </div>

        {busy ? <div className="fee-empty-state">差分診断を実行しています…</div> : null}
        {error ? <div className="inline-error" role="status">{error}</div> : null}

        {summary ? (
          <>
            {ingestion ? (
              <div className="baseline-diff-ingestion">
                <span>取込: レセ {Number(ingestion.baselineClaimCount || 0).toLocaleString()}件</span>
                <span>再算定 {Number(ingestion.calculationPayloadCount || 0).toLocaleString()}件</span>
                {Number(ingestion.warningCount || 0) ? <span>確認 {Number(ingestion.warningCount || 0).toLocaleString()}件</span> : null}
              </div>
            ) : null}
            {(receiptParse || recalculationAccuracy) ? (
              <div className="baseline-diff-phase-grid" aria-label="診断段階">
                {receiptParse ? (
                  <article className="baseline-diff-phase">
                    <span>既存レセ解析確認</span>
                    <strong>{Number(receiptParse.lineCount || 0).toLocaleString()}明細</strong>
                    <small>レセ {Number(receiptParse.claimCount || 0).toLocaleString()}件 / {receiptParse.formatLabel || receiptParse.format || "取込済み"}</small>
                  </article>
                ) : null}
                {recalculationAccuracy ? (
                  <article className="baseline-diff-phase">
                    <span>再算定精度確認</span>
                    <strong>{Number(recalculationAccuracy.reproductionFailureCount || 0).toLocaleString()}件</strong>
                    <small>再算定元 {Number(recalculationAccuracy.sourceCodeCount || 0).toLocaleString()}件 / 当社出力 {Number(recalculationAccuracy.engineCodeCount || 0).toLocaleString()}件</small>
                  </article>
                ) : null}
              </div>
            ) : null}
            <div className="baseline-diff-summary">
              {resultTabs.map((tab) => (
                <article className={`baseline-diff-metric baseline-diff-metric--${tab.className}`} key={tab.id}>
                  <span>{tab.label}</span>
                  <strong>{tab.count.toLocaleString()}件</strong>
                  {tab.id === "engine_only" ? <small>約{Number(summary.missingCandidateEstimatedYen || 0).toLocaleString()}円</small> : null}
                </article>
              ))}
            </div>
            <p className="baseline-diff-disclaimer">既存レセ解析確認は既存レセを読めたかの確認、再算定精度確認は当社エンジンで再現できたかの確認です。概算影響額は点数×10円・総医療費ベースの概算です（負担按分なし）。実施事実・算定要件・施設基準・病名を確認のうえ判断してください。</p>
            <div className="baseline-diff-tabs" role="tablist" aria-label="診断結果の分類">
              {resultTabs.map((tab) => (
                <button
                  aria-selected={activeResultTab === tab.id}
                  className={`baseline-diff-tab ${activeResultTab === tab.id ? "is-active" : ""}`}
                  key={tab.id}
                  onClick={() => setActiveResultTab(tab.id)}
                  role="tab"
                  type="button"
                >
                  <span>{tab.label}</span>
                  <strong>{tab.count.toLocaleString()}</strong>
                </button>
              ))}
            </div>
            {visibleRows.length ? (
              <div className="baseline-diff-table-wrap">
                <table className="baseline-diff-table">
                  <thead>
                    <tr><th>患者</th><th>分類</th><th>コード</th><th>名称</th><th>既存</th><th>当社</th><th>差分</th><th>理由</th></tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row, index) => {
                      const isReproductionFailure = row.comparisonStatus === "reproduction_failed";
                      return (
                        <tr className={`baseline-diff-row baseline-diff-row--${row.comparisonStatus || row.category}`} key={`${row.patientId}-${row.code}-${index}`}>
                          <td>{row.patientId}</td>
                          <td className="baseline-diff-cat">{row.comparisonStatusLabel || row.categoryLabel}</td>
                          <td>{row.code}</td>
                          <td>{row.name || "—"}</td>
                          <td className="num">{isReproductionFailure ? `${Number(row.sourceCount || 0).toLocaleString()}回` : formatPointCell(row.baselinePoints)}</td>
                          <td className="num">{isReproductionFailure ? `${Number(row.engineCount || 0).toLocaleString()}回` : formatPointCell(row.enginePoints)}</td>
                          <td className="num">{isReproductionFailure ? `-${Number(row.missingCount || 0).toLocaleString()}回` : formatDeltaPointCell(row.deltaPoints)}</td>
                          <td>{row.reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="fee-empty-state">{activeResultTab === "matched" ? "一致した明細はありません。" : "この分類の明細はありません。"}</div>}
          </>
        ) : (!busy && !error ? <div className="fee-empty-state">既存レセと再算定元データを選択して実行すると、ここに診断結果が表示されます。</div> : null)}
      </section>

      <section className="baseline-diff-card">
        <div className="baseline-diff-card-head">
          <h3>3. 売上改善診断（算定もれ・査定リスク）</h3>
          {clinicReport ? (
            <div className="baseline-diff-actions">
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`clinic-diagnosis_${claimMonth}.csv`, clinicDiagnosisToCsv(clinicReport), "text/csv;charset=utf-8")} type="button">CSV出力</button>
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`clinic-diagnosis_${claimMonth}.html`, clinicDiagnosisToHtml(clinicReport, { subtitle: `請求月 ${claimMonth}（匿名データ）` }), "text/html;charset=utf-8")} type="button">HTML出力</button>
            </div>
          ) : null}
        </div>

        {clinicBusy ? <div className="fee-empty-state">決定論点検を実行しています…</div> : null}
        {clinicError ? <div className="inline-error" role="status">{clinicError}</div> : null}

        {clinicReport ? (
          <>
            {clinicIngestion ? (
              <div className="baseline-diff-ingestion">
                <span>取込: レセ {Number(clinicIngestion.baselineClaimCount || 0).toLocaleString()}件</span>
                <span>診断対象 {Number(clinicIngestion.analyzedClaimCount || 0).toLocaleString()}件</span>
                {Number(clinicIngestion.inpatientClaimCount || 0) ? <span>うち入院 {Number(clinicIngestion.inpatientClaimCount || 0).toLocaleString()}件</span> : null}
                {Number(clinicIngestion.dpcSkippedCount || 0) ? <span>DPC対象外 {Number(clinicIngestion.dpcSkippedCount || 0).toLocaleString()}件</span> : null}
              </div>
            ) : null}
            <div className="baseline-diff-summary">
              <article className="baseline-diff-metric"><span>対象患者</span><strong>{Number(clinicReport.summary?.patientCount || 0).toLocaleString()}人</strong></article>
              <article className="baseline-diff-metric"><span>対象レセ</span><strong>{Number(clinicReport.summary?.claimCount || 0).toLocaleString()}件</strong></article>
              <article className="baseline-diff-metric baseline-diff-metric--engine"><span>算定もれ候補</span><strong>{Number(clinicReport.summary?.billingMissCount || 0).toLocaleString()}件</strong></article>
              <article className="baseline-diff-metric baseline-diff-metric--baseline"><span>査定・返戻リスク</span><strong>{Number(clinicReport.summary?.assessmentRiskCount || 0).toLocaleString()}件</strong></article>
              <article className="baseline-diff-metric baseline-diff-metric--repro"><span>要修正</span><strong>{Number(clinicReport.summary?.errorCount || 0).toLocaleString()}件</strong></article>
            </div>
            <p className="baseline-diff-disclaimer">決定論点検（公的マスタ準拠）による確認候補の提示です。最終判断は告示・通知・審査取扱いに基づき医事課/診療部門で行ってください。</p>
            {(clinicReport.findings || []).length ? (
              <div className="baseline-diff-table-wrap">
                <table className="baseline-diff-table">
                  <thead>
                    <tr><th>患者</th><th>請求月</th><th>重大度</th><th>分類</th><th>指摘</th><th>対応の目安</th></tr>
                  </thead>
                  <tbody>
                    {(clinicReport.findings || []).map((finding, index) => (
                      <tr className={`baseline-diff-row baseline-diff-row--clinic-${finding.severity}`} key={`${finding.patientKey}-${finding.ruleId}-${index}`}>
                        <td>{finding.patientKey}</td>
                        <td>{finding.claimMonth}</td>
                        <td className="baseline-diff-cat">{clinicDiagnosisSeverityLabel(finding.severity)}</td>
                        <td>{finding.category}</td>
                        <td>{finding.message}</td>
                        <td>{finding.suggestion}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="fee-empty-state">指摘はありません。</div>}
          </>
        ) : (!clinicBusy && !clinicError ? <div className="fee-empty-state">既存レセ（.uke / .csv）を選択して「売上改善診断を実行」すると、算定もれ・査定リスクの点検結果が表示されます。</div> : null)}
      </section>
    </div>
  );
}
