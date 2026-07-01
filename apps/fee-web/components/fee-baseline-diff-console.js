"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingErrorMessage } from "@halunasu/web-ui/user-facing-error";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";
import {
  BASELINE_COLUMN_FIELDS,
  BASELINE_UKE_FIELDS,
  baselineDiffRows,
  baselineDiffToCsv,
  baselineDiffToHtml,
  buildRecalculationDatasetDiffRequest,
  downloadTextFile,
  emptyBaselineDiffOptions,
  isStgFeeEnvironment
} from "../lib/baseline-diff";

function defaultClaimMonth() {
  return new Date().toISOString().slice(0, 7);
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

export function FeeBaselineDiffConsole() {
  const feeApi = useFeeApi();
  const [stg, setStg] = useState(true);
  const [claimMonth, setClaimMonth] = useState(defaultClaimMonth());
  const [options, setOptions] = useState(emptyBaselineDiffOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [datasetFile, setDatasetFile] = useState(null);
  const [datasetFileName, setDatasetFileName] = useState("");
  const [baselineFile, setBaselineFile] = useState(null);
  const [baselineFileName, setBaselineFileName] = useState("");
  const [recalculationFile, setRecalculationFile] = useState(null);
  const [recalculationFileName, setRecalculationFileName] = useState("");
  const [sourceFiles, setSourceFiles] = useState({});
  const [sourceFileNames, setSourceFileNames] = useState({});
  const [result, setResult] = useState(null);
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
    setStg(isStgFeeEnvironment());
  }, []);

  const selectBaselineFile = useCallback((file) => {
    if (!file) {
      return;
    }
    setBaselineFile(file);
    setBaselineFileName(file.name || "");
    setResult(null);
    setError("");
  }, []);

  const selectDatasetFile = useCallback((file) => {
    if (!file) {
      return;
    }
    setDatasetFile(file);
    setDatasetFileName(file.name || "");
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

  const canRunDiagnosis = Boolean(datasetFile || (baselineFile && (recalculationFile || sourceFiles.orders)));

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
  }, [baselineFile, canRunDiagnosis, claimMonth, datasetFile, feeApi, options, recalculationFile, sourceFiles]);

  const updateOptions = useCallback((patch) => setOptions((current) => ({ ...current, ...patch })), []);

  const findings = useMemo(() => baselineDiffRows(result), [result]);
  const summary = result?.summary || null;
  const ingestion = result?.ingestion || null;
  const sourceDropConfigs = [
    ["patients", "患者情報", ".csv / .jsonl", patientInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["charts", "カルテ", ".csv / .jsonl", chartInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["orders", "オーダー", ".csv / .jsonl", orderInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["diagnoses", "病名", ".csv / .jsonl", diagnosisInputRef, ".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json"],
    ["facility", "施設設定", ".json / .csv", facilityInputRef, ".json,.csv,.tsv,application/json,text/csv"]
  ];

  if (!stg) {
    return (
      <div className="baseline-diff-locked">
        <strong>この機能はSTG環境でのみ利用できます。</strong>
        <p>実患者データを扱うため、STG限定の運用型診断として提供しています。</p>
      </div>
    );
  }

  return (
    <div className="baseline-diff">
      <div className="baseline-diff-toolbar">
        <label className="baseline-diff-month">
          <span>請求月</span>
          <input type="month" value={claimMonth} onChange={(event) => setClaimMonth(event.target.value)} />
        </label>
        <p className="baseline-diff-note">既存レセと再算定元データを取り込み、当社エンジンの再算定結果と患者×月で突合します。差分はすべて要確認です。</p>
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
          onDrop={(event) => { event.preventDefault(); setDragOverTarget(""); const file = event.dataTransfer.files?.[0]; if (file) { selectDatasetFile(file); } }}
          role="button"
          tabIndex={0}
        >
          <strong>診断データセット</strong>
          <span>manifest.json付き .zip / bundle .json</span>
          {datasetFileName ? <small>取込: {datasetFileName}</small> : null}
          <input
            accept=".zip,.json,application/zip,application/json"
            disabled={busy}
            hidden
            onChange={(event) => { const file = event.target.files?.[0]; if (file) { selectDatasetFile(file); } event.target.value = ""; }}
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
        </div>

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
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`baseline-diff_${claimMonth || "month"}.csv`, baselineDiffToCsv(result), "text/csv;charset=utf-8")} type="button">CSV出力</button>
              <button className="btn btn--ghost btn--sm" onClick={() => downloadTextFile(`baseline-diff_${claimMonth || "month"}.html`, baselineDiffToHtml(result), "text/html;charset=utf-8")} type="button">HTML出力</button>
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
            <div className="baseline-diff-summary">
              <article className="baseline-diff-metric baseline-diff-metric--missing">
                <span>算定もれ候補</span>
                <strong>{summary.missingCandidateCount.toLocaleString()}件</strong>
                <small>約{Number(summary.missingCandidateEstimatedYen || 0).toLocaleString()}円</small>
              </article>
              <article className="baseline-diff-metric baseline-diff-metric--review">
                <span>要確認</span>
                <strong>{summary.needsReviewCount.toLocaleString()}件</strong>
              </article>
              <article className="baseline-diff-metric baseline-diff-metric--consider">
                <span>検討</span>
                <strong>{summary.considerCount.toLocaleString()}件</strong>
              </article>
            </div>
            <p className="baseline-diff-disclaimer">概算影響額は点数×10円・総医療費ベースの概算です（負担按分なし）。実施事実・算定要件・施設基準・病名を確認のうえ判断してください。</p>
            {findings.length ? (
              <div className="baseline-diff-table-wrap">
                <table className="baseline-diff-table">
                  <thead>
                    <tr><th>患者</th><th>分類</th><th>コード</th><th>名称</th><th>点数</th><th>概算影響額</th><th>理由</th></tr>
                  </thead>
                  <tbody>
                    {findings.map((finding, index) => (
                      <tr className={`baseline-diff-row baseline-diff-row--${finding.category}`} key={`${finding.patientId}-${finding.code}-${index}`}>
                        <td>{finding.patientId}</td>
                        <td className="baseline-diff-cat">{finding.categoryLabel}</td>
                        <td>{finding.code}</td>
                        <td>{finding.name || "—"}</td>
                        <td className="num">{Number(finding.points || 0).toLocaleString()}点</td>
                        <td className="num">約{Number(finding.estimatedYen || 0).toLocaleString()}円</td>
                        <td>{finding.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="fee-empty-state">差分はありません（既存レセと当社再算定が一致）。</div>}
          </>
        ) : (!busy && !error ? <div className="fee-empty-state">既存レセと再算定元データを選択して実行すると、ここに診断結果が表示されます。</div> : null)}
      </section>
    </div>
  );
}
