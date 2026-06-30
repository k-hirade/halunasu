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
  buildBaselineDiffRequest,
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
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uncalculatedCount, setUncalculatedCount] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    setStg(isStgFeeEnvironment());
  }, []);

  // 当該請求月の未算定件数(engineClaim過少評価の注意喚起)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const summary = await feeApi(`/v1/fee/monthly-summary?claimMonth=${encodeURIComponent(claimMonth)}`);
        if (!cancelled) {
          setUncalculatedCount(Number(summary?.uncalculatedCount || 0));
        }
      } catch {
        if (!cancelled) {
          setUncalculatedCount(0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [feeApi, claimMonth]);

  const runDiagnosis = useCallback(async (file) => {
    if (!file) {
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setFileName(file.name || "");
    try {
      const body = await buildBaselineDiffRequest(file, { claimMonth, options });
      const response = await feeApi("/v1/fee/baseline-diagnosis", { method: "POST", csrf: true, body });
      setResult(response || null);
    } catch (err) {
      setError(toUserFacingErrorMessage(err, "差分診断を実行できませんでした。"));
    } finally {
      setBusy(false);
    }
  }, [feeApi, claimMonth, options]);

  const updateOptions = useCallback((patch) => setOptions((current) => ({ ...current, ...patch })), []);

  const findings = useMemo(() => baselineDiffRows(result), [result]);
  const summary = result?.summary || null;

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
        <p className="baseline-diff-note">既存レセ（レセコン出力）と当社再算定を患者×月で突合し、算定もれ候補／要確認／検討を出します。差分はすべて要確認です。</p>
      </div>

      {uncalculatedCount ? (
        <div className="baseline-diff-warning" role="status">
          この請求月に未算定の受診が {uncalculatedCount.toLocaleString()} 件あります。当社側（再算定）が不足し差分を過少評価する可能性があります。
          <a className="btn btn--ghost btn--sm" href="/monthly">月次レセ点検で一括候補化</a>
        </div>
      ) : null}

      <section className="baseline-diff-card">
        <div className="baseline-diff-card-head">
          <h3>1. 既存レセを取込</h3>
          <span>.csv / .uke（Shift_JIS可）</span>
        </div>
        <div
          className={`baseline-diff-drop ${dragOver ? "is-over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files?.[0]; if (file) { runDiagnosis(file); } }}
          role="button"
          tabIndex={0}
        >
          <strong>ファイルをドラッグ＆ドロップ</strong>
          <span>またはクリックして選択（.csv / .uke）</span>
          {fileName ? <small>取込: {fileName}</small> : null}
          <input
            accept=".csv,.uke,.txt,text/csv"
            disabled={busy}
            hidden
            onChange={(event) => { const file = event.target.files?.[0]; if (file) { runDiagnosis(file); } event.target.value = ""; }}
            ref={inputRef}
            type="file"
          />
        </div>

        <details className="baseline-diff-options">
          <summary>詳細設定（列マッピング・UKE位置・未対応コード・コード対応表）</summary>
          <div className="baseline-diff-options-body">
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
        ) : (!busy && !error ? <div className="fee-empty-state">既存レセを取込むと、ここに診断結果が表示されます。</div> : null)}
      </section>
    </div>
  );
}
