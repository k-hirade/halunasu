"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SERVICE_TYPES = [
  ["roken", "介護老人保健施設"],
  ["care_medical_institution", "介護医療院"],
  ["short_stay_roken", "短期入所療養介護（老健）"],
  ["short_stay_care_medical_institution", "短期入所療養介護（医療院）"],
  ["preventive_short_stay_roken", "介護予防短期入所（老健）"],
  ["preventive_short_stay_care_medical_institution", "介護予防短期入所（医療院）"]
];
const STATUS_LABELS = {
  billing_candidate: "算定候補",
  needs_review: "要確認",
  conflict: "競合あり",
  not_eligible: "対象外",
  import_error: "取込エラー",
  pending: "未判断",
  confirmed: "確認済み",
  excluded: "除外"
};
const REASON_LABELS = {
  eligible_requirements_satisfied: "算定要件を満たしています",
  monthly_claim_history_unknown: "当月の既算定履歴を確認してください",
  monthly_limit_already_claimed: "当月に確認済みの症例があります",
  physician_confirmation_missing: "医師確認が不足しています",
  service_code_variant_required: "施設区分またはサービスコードの指定が必要です",
  service_master_not_found: "診療日の適用マスタが見つかりません",
  concurrent_billing_unknown: "併算定の有無を確認してください",
  cross_month_episode_requires_review: "月をまたぐ症例の扱いを確認してください",
  consecutive_day_limit_exceeded: "連続3日を超えています",
  non_consecutive_treatment_day: "治療日が連続していません"
};

export function CareFeeWorkspace() {
  const auth = usePlatformAuth();
  const [activeView, setActiveView] = useState("csv");
  const [bootstrap, setBootstrap] = useState(emptyBootstrap());
  const [facilityId, setFacilityId] = useState("");
  const [claimMonth, setClaimMonth] = useState(currentClaimMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [csvFile, setCsvFile] = useState(null);
  const [csvMode, setCsvMode] = useState("spot");
  const [csvImportSummary, setCsvImportSummary] = useState(null);
  const [csvResult, setCsvResult] = useState(null);
  const [decisionTarget, setDecisionTarget] = useState(null);
  const [decisionReason, setDecisionReason] = useState("");
  const fileInputRef = useRef(null);

  const runtime = runtimeConfig();
  const selectedFacility = bootstrap.facilities.find((facility) => facility.facilityId === facilityId) || null;
  const selectedSettings = bootstrap.settings.find((settings) => settings.facilityId === facilityId) || null;
  const canDecide = hasAnyRole(auth.session, ["admin", "doctor", "medical_clerk"]);

  const api = useCallback(async (path, options = {}) => {
    const token = auth.accessToken || getStoredPlatformAccessToken();
    if (!token) throw new Error("ログイン情報を確認できません。");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };
    if (options.csrf && auth.csrfToken) headers["x-csrf-token"] = auth.csrfToken;
    const response = await fetch(`${runtime.careFeeBaseUrl}${path}`, {
      method: options.method || "GET",
      credentials: "include",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const nextError = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      nextError.status = response.status;
      throw nextError;
    }
    return payload;
  }, [auth.accessToken, auth.csrfToken, runtime.careFeeBaseUrl]);

  const refresh = useCallback(async (nextFacilityId = facilityId, nextClaimMonth = claimMonth) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams();
      if (nextFacilityId) query.set("facilityId", nextFacilityId);
      if (nextClaimMonth) query.set("claimMonth", nextClaimMonth);
      const payload = await api(`/v1/care-fee/bootstrap?${query}`);
      setBootstrap(normalizeBootstrap(payload));
      if (!nextFacilityId && payload.facilities?.[0]?.facilityId) {
        setFacilityId(payload.facilities[0].facilityId);
      }
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setLoading(false);
    }
  }, [api, claimMonth, facilityId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function evaluateCsv() {
    if (!csvFile) return;
    if (!facilityId) {
      setError("対象施設を選択してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const bytes = new Uint8Array(await csvFile.arrayBuffer());
      const managed = csvMode === "managed";
      const payload = await api(managed ? "/v1/care-fee/imports/csv" : "/v1/care-fee/evaluations/csv", {
        method: "POST",
        csrf: true,
        body: {
          facilityId,
          fileName: csvFile.name,
          fileBase64: bytesToBase64(bytes)
        }
      });
      setCsvResult(payload.result || null);
      setCsvImportSummary(payload.importSummary || null);
      showNotice(managed ? "月次管理への取込が完了しました。" : "一括点検が完了しました。");
      if (managed) await refresh(facilityId, claimMonth);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(false);
    }
  }

  function selectFile(file) {
    setError("");
    setCsvResult(null);
    setCsvImportSummary(null);
    if (!file) {
      setCsvFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("CSVファイルを選択してください。");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("CSVファイルは10MB以下にしてください。");
      return;
    }
    setCsvFile(file);
  }

  function downloadResult() {
    if (!csvResult?.outputBase64) return;
    const bytes = base64ToBytes(csvResult.outputBase64);
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = resultFileName(csvFile?.name);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function runMonthly() {
    if (!facilityId) return setError("対象施設を選択してください。");
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/care-fee/monthly-runs", {
        method: "POST",
        csrf: true,
        body: { facilityId, claimMonth, timezone: selectedSettings?.timezone || "Asia/Tokyo" }
      });
      showNotice(payload.reused ? "同じ入力の点検結果を表示しました。" : "月次点検が完了しました。");
      await refresh(facilityId, claimMonth);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function decideEpisode() {
    if (!decisionTarget) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/care-fee/episodes/${decisionTarget.episodeId}/decision`, {
        method: "POST",
        csrf: true,
        body: { status: decisionTarget.status, reason: decisionReason }
      });
      showNotice(decisionTarget.status === "confirmed" ? "算定候補を確認済みにしました。" : "症例を除外しました。");
      setDecisionTarget(null);
      setDecisionReason("");
      await refresh(facilityId, claimMonth);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(settings) {
    setBusy(true);
    setError("");
    try {
      await api("/v1/care-fee/facility-settings", {
        method: "POST",
        csrf: true,
        body: settings
      });
      showNotice("施設設定を保存しました。");
      await refresh(settings.facilityId, claimMonth);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(false);
    }
  }

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  return (
    <main className="care-page">
      {notice ? <div className="app-toast" role="status">{notice}</div> : null}
      {error ? <div className="app-error" role="alert">{error}</div> : null}

      <header className="page-heading">
        <div>
          <span className="eyebrow">介護保険請求点検</span>
          <h1>緊急時治療管理</h1>
          <p>症例を一括点検し、月次の算定候補と要確認事項を施設単位で確認します。</p>
        </div>
        <span className="environment-label">{environmentLabel(runtime.halunasuEnv)}</span>
      </header>

      <section className="context-bar" aria-label="点検条件">
        <label>
          <span>対象施設</span>
          <select
            aria-label="対象施設"
            disabled={loading}
            value={facilityId}
            onChange={(event) => {
              const next = event.target.value;
              setFacilityId(next);
              refresh(next, claimMonth);
            }}
          >
            <option value="">選択してください</option>
            {bootstrap.facilities.map((facility) => (
              <option key={facility.facilityId} value={facility.facilityId}>{facility.displayName}</option>
            ))}
          </select>
        </label>
        <label>
          <span>請求月</span>
          <input
            aria-label="請求月"
            type="month"
            value={claimMonth}
            onChange={(event) => {
              setClaimMonth(event.target.value);
              refresh(facilityId, event.target.value);
            }}
          />
        </label>
        <div className="context-detail">
          <span>施設コード</span>
          <strong>{selectedSettings?.facilityCode || "未設定"}</strong>
        </div>
      </section>

      <nav className="view-tabs" aria-label="緊急時治療管理メニュー">
        <TabButton active={activeView === "csv"} onClick={() => setActiveView("csv")}>CSV一括点検</TabButton>
        <TabButton active={activeView === "monthly"} onClick={() => setActiveView("monthly")}>月次点検</TabButton>
        <TabButton active={activeView === "settings"} onClick={() => setActiveView("settings")}>施設設定</TabButton>
      </nav>

      {loading ? (
        <section className="content-band loading-band">読み込み中...</section>
      ) : activeView === "csv" ? (
        <CsvView
          busy={busy}
          file={csvFile}
          fileInputRef={fileInputRef}
          onDownload={downloadResult}
          onEvaluate={evaluateCsv}
          onFile={selectFile}
          onMode={setCsvMode}
          importSummary={csvImportSummary}
          mode={csvMode}
          result={csvResult}
        />
      ) : activeView === "monthly" ? (
        <MonthlyView
          busy={busy}
          canDecide={canDecide}
          claimMonth={claimMonth}
          episodes={bootstrap.episodes}
          monthlyRuns={bootstrap.monthlyRuns}
          onDecision={setDecisionTarget}
          onRun={runMonthly}
        />
      ) : (
        <SettingsView
          busy={busy}
          facility={selectedFacility}
          facilityId={facilityId}
          onSave={saveSettings}
          settings={selectedSettings}
        />
      )}

      {decisionTarget ? (
        <DecisionDialog
          busy={busy}
          onCancel={() => {
            setDecisionTarget(null);
            setDecisionReason("");
          }}
          onConfirm={decideEpisode}
          reason={decisionReason}
          setReason={setDecisionReason}
          target={decisionTarget}
        />
      ) : null}
    </main>
  );
}

function CsvView({ busy, file, fileInputRef, importSummary, mode, onDownload, onEvaluate, onFile, onMode, result }) {
  const managed = mode === "managed";
  return (
    <div className="view-stack">
      <section className="content-band upload-layout">
        <div className="csv-intro">
          <span className="section-number">1</span>
          <h2>点検データを選択</h2>
          <p>{managed
            ? "有効な症例を月次管理へ登録します。取込エラー行は登録せず、結果CSVに残します。"
            : "点検結果だけを返します。元データと結果行は保存されません。"}</p>
          <fieldset className="csv-mode-control">
            <legend>取込方法</legend>
            <div className="segmented-control">
              <button aria-pressed={!managed} className={!managed ? "is-active" : ""} onClick={() => onMode("spot")} type="button">スポット点検</button>
              <button aria-pressed={managed} className={managed ? "is-active" : ""} onClick={() => onMode("managed")} type="button">月次管理に取込</button>
            </div>
          </fieldset>
        </div>
        <div
          className="file-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            onFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input
            accept=".csv,text/csv"
            className="visually-hidden"
            onChange={(event) => onFile(event.target.files?.[0])}
            ref={fileInputRef}
            type="file"
          />
          <strong>{file?.name || "CSVファイルを選択"}</strong>
          <span>{file ? `${formatBytes(file.size)} / CSV` : "UTF-8・Shift_JIS、10MBまで"}</span>
          <button className="button button--secondary" onClick={() => fileInputRef.current?.click()} type="button">ファイルを選択</button>
        </div>
        <button className="button button--primary evaluate-button" disabled={!file || busy} onClick={onEvaluate} type="button">
          {busy ? "処理中..." : managed ? "月次管理に取り込む" : "一括点検を実行"}
        </button>
      </section>

      {result ? (
        <section className="content-band result-section">
          <div className="section-heading-row">
            <div>
              <span className="section-number">2</span>
              <h2>点検結果</h2>
              <p>{result.summary.rowCount}行・{result.summary.episodeCount}症例を点検しました。</p>
            </div>
            <button className="button button--secondary" onClick={onDownload} type="button">結果CSVを出力</button>
          </div>
          {importSummary ? (
            <div className="managed-import-summary" role="status">
              <strong>{importSummary.persistedEpisodeCount}症例を月次管理に取り込みました</strong>
              <span>新規 {importSummary.createdEpisodeCount}件 / 更新 {importSummary.updatedEpisodeCount}件 / 変更なし {importSummary.unchangedEpisodeCount}件</span>
            </div>
          ) : null}
          <SummaryStrip summary={result.summary} />
          <ResultTable rows={result.rows || []} />
          <footer className="result-meta">
            <span>ルール {result.ruleVersion}</span>
            <span>マスタ {result.masterVersion}</span>
            <span>文字コード {result.inputEncoding}</span>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

function SummaryStrip({ summary }) {
  const statuses = summary.statusCounts || {};
  return (
    <div className="summary-strip">
      <SummaryMetric label="算定候補" value={statuses.billing_candidate || 0} tone="positive" />
      <SummaryMetric label="要確認" value={statuses.needs_review || 0} tone="warning" />
      <SummaryMetric label="競合" value={statuses.conflict || 0} tone="danger" />
      <SummaryMetric label="対象外" value={statuses.not_eligible || 0} />
      <SummaryMetric label="候補単位" value={`${number(summary.candidateUnits)}単位`} tone="accent" />
    </div>
  );
}

function SummaryMetric({ label, tone = "neutral", value }) {
  return <div className={`summary-metric summary-metric--${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ResultTable({ rows }) {
  return (
    <div className="table-scroll">
      <table className="result-table">
        <thead>
          <tr>
            <th>患者</th>
            <th>治療日</th>
            <th>判定</th>
            <th>サービスコード</th>
            <th className="numeric">単位</th>
            <th>確認内容</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.normalized_row_sha256 || index}`}>
              <td><strong>{row.patient_display_name || row.patient_key || "-"}</strong><small>{row.patient_key || ""}</small></td>
              <td>{row.treatment_date || "-"}</td>
              <td><StatusBadge status={row.judgment_status} /></td>
              <td>{row.resolved_service_code_name || "未確定"}<small>{row.resolved_service_code || ""}</small></td>
              <td className="numeric">{number(row.counted_units)}</td>
              <td><ReasonList codes={splitCodes(row.reason_codes)} missing={splitCodes(row.missing_fields)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyView({ busy, canDecide, claimMonth, episodes, monthlyRuns, onDecision, onRun }) {
  const latestRun = monthlyRuns[0] || null;
  return (
    <div className="view-stack monthly-print-surface">
      <section className="content-band monthly-toolbar">
        <div>
          <h2>{displayMonth(claimMonth)} 月次点検</h2>
          <p>連携済みの症例と当月の確認履歴を再評価します。同じ入力では同じ実行結果を再利用します。</p>
        </div>
        <div className="monthly-actions">
          <button className="button button--secondary" disabled={!episodes.length} onClick={() => window.print()} type="button">印刷</button>
          <button className="button button--primary" disabled={busy} onClick={onRun} type="button">{busy ? "点検中..." : "月次点検を実行"}</button>
        </div>
      </section>
      {latestRun ? <MonthlyRunSummary run={latestRun} /> : null}
      <section className="content-band">
        <div className="section-heading-row compact-heading">
          <div><h2>症例一覧</h2><p>{episodes.length}件</p></div>
          {!canDecide ? <span className="permission-note">確認操作には管理者または確認担当権限が必要です。</span> : null}
        </div>
        {episodes.length ? (
          <div className="episode-list">
            {episodes.map((episode) => (
              <article className="episode-row" key={episode.episodeId}>
                <div className="episode-patient">
                  <strong>{episode.patientDisplayName || episode.patientKey}</strong>
                  <span>{episode.patientKey}</span>
                </div>
                <div><span className="cell-label">治療日</span><strong>{episode.treatmentDates?.join(" / ") || "-"}</strong></div>
                <div><span className="cell-label">判定</span><StatusBadge status={episode.evaluation?.judgmentStatus} /></div>
                <div className="numeric"><span className="cell-label">候補単位</span><strong>{number(episode.evaluation?.totalUnits)}</strong></div>
                <div><span className="cell-label">確認状態</span><StatusBadge status={episode.decisionStatus} /></div>
                <div className="episode-actions">
                  <button
                    className="button button--small button--primary"
                    disabled={!canDecide || episode.decisionStatus !== "pending" || episode.evaluation?.judgmentStatus !== "billing_candidate"}
                    onClick={() => onDecision({ ...episode, status: "confirmed" })}
                    type="button"
                  >確認</button>
                  <button
                    className="button button--small button--secondary"
                    disabled={!canDecide || episode.decisionStatus !== "pending"}
                    onClick={() => onDecision({ ...episode, status: "excluded" })}
                    type="button"
                  >除外</button>
                </div>
                <div className="episode-reasons"><ReasonList codes={episode.evaluation?.reasonCodes || []} missing={episode.evaluation?.missingFields || []} /></div>
              </article>
            ))}
          </div>
        ) : <div className="empty-state">この請求月の連携済み症例はありません。</div>}
      </section>
    </div>
  );
}

function MonthlyRunSummary({ run }) {
  return (
    <section className="run-summary-band">
      <div><span>対象症例</span><strong>{run.coverage?.sourceEpisodeCount || 0}</strong></div>
      <div><span>算定候補</span><strong>{run.summary?.candidateCount || 0}</strong></div>
      <div><span>要確認</span><strong>{run.summary?.needsReviewCount || 0}</strong></div>
      <div><span>確認済み</span><strong>{run.coverage?.claimCount || 0}</strong></div>
      <time>{formatDateTime(run.createdAt)}</time>
    </section>
  );
}

function SettingsView({ busy, facility, facilityId, onSave, settings }) {
  const key = `${facilityId}:${settings?.updatedAt || "new"}`;
  return (
    <SettingsForm
      busy={busy}
      facility={facility}
      facilityId={facilityId}
      key={key}
      onSave={onSave}
      settings={settings}
    />
  );
}

function SettingsForm({ busy, facility, facilityId, onSave, settings }) {
  const [codes, setCodes] = useState(() => ({ ...(settings?.emergencyServiceCodes || {}) }));
  const [variants, setVariants] = useState(() => ({ ...(settings?.facilityVariants || {}) }));

  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      facilityId,
      facilityCode: String(form.get("facilityCode") || "").trim(),
      careOfficeNumber: String(form.get("careOfficeNumber") || "").trim(),
      timezone: String(form.get("timezone") || "Asia/Tokyo").trim(),
      emergencyServiceCodes: compactMap(codes),
      facilityVariants: compactMap(variants),
      enabled: form.get("enabled") === "on"
    });
  }

  if (!facilityId) return <section className="content-band empty-state">対象施設を選択してください。</section>;
  return (
    <form className="content-band settings-form" onSubmit={submit}>
      <div className="section-heading-row">
        <div><h2>施設設定</h2><p>{facility?.displayName || facilityId}</p></div>
        <label className="toggle-field"><input defaultChecked={settings?.enabled !== false} name="enabled" type="checkbox" /><span>点検を有効にする</span></label>
      </div>
      <div className="settings-grid">
        <Field label="施設コード"><input defaultValue={settings?.facilityCode || ""} name="facilityCode" required /></Field>
        <Field label="介護事業所番号"><input defaultValue={settings?.careOfficeNumber || ""} name="careOfficeNumber" /></Field>
        <Field label="タイムゾーン"><input defaultValue={settings?.timezone || "Asia/Tokyo"} name="timezone" required /></Field>
      </div>
      <div className="service-map">
        <div className="service-map-heading"><strong>緊急時治療管理サービスコード</strong><span>施設で使用する区分だけ入力してください。</span></div>
        {SERVICE_TYPES.map(([value, label]) => (
          <div className="service-map-row" key={value}>
            <label htmlFor={`code-${value}`}>{label}</label>
            <input
              id={`code-${value}`}
              inputMode="text"
              maxLength={6}
              onChange={(event) => setCodes((current) => ({ ...current, [value]: event.target.value.toUpperCase() }))}
              placeholder="6桁コード"
              value={codes[value] || ""}
            />
            {value.includes("roken") ? (
              <select
                aria-label={`${label}の施設区分`}
                onChange={(event) => setVariants((current) => ({ ...current, [value]: event.target.value }))}
                value={variants[value] || ""}
              >
                <option value="">区分未指定</option>
                <option value="standard">基本型</option>
                <option value="long_term_care_type">介護療養型</option>
              </select>
            ) : <span className="not-applicable">区分指定なし</span>}
          </div>
        ))}
      </div>
      <div className="form-actions"><button className="button button--primary" disabled={busy} type="submit">{busy ? "保存中..." : "施設設定を保存"}</button></div>
    </form>
  );
}

function DecisionDialog({ busy, onCancel, onConfirm, reason, setReason, target }) {
  const excluding = target.status === "excluded";
  return (
    <div className="dialog-backdrop" role="presentation">
      <section aria-labelledby="decision-title" aria-modal="true" className="decision-dialog" role="dialog">
        <h2 id="decision-title">{excluding ? "症例を除外" : "算定候補を確認"}</h2>
        <p>{target.patientDisplayName || target.patientKey} / {target.treatmentDates?.join(" / ")}</p>
        <label className="field">
          <span>{excluding ? "除外理由" : "確認メモ（任意）"}</span>
          <textarea autoFocus={excluding} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        <div className="dialog-actions">
          <button className="button button--secondary" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="button button--primary" disabled={busy || (excluding && !reason.trim())} onClick={onConfirm} type="button">{excluding ? "除外する" : "確認済みにする"}</button>
        </div>
      </section>
    </div>
  );
}

function TabButton({ active, children, onClick }) {
  return <button aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} onClick={onClick} type="button">{children}</button>;
}

function StatusBadge({ status }) {
  const normalized = status || "pending";
  return <span className={`status-badge status-badge--${normalized}`}>{STATUS_LABELS[normalized] || normalized}</span>;
}

function ReasonList({ codes, missing }) {
  const values = Array.isArray(codes) ? codes : splitCodes(codes);
  const missingValues = Array.isArray(missing) ? missing : splitCodes(missing);
  if (!values.length && !missingValues.length) return <span className="muted">なし</span>;
  return (
    <div className="reason-list">
      {values.slice(0, 3).map((code) => <span key={code}>{REASON_LABELS[code] || code}</span>)}
      {missingValues.length ? <span>不足: {missingValues.join("、")}</span> : null}
    </div>
  );
}

function Field({ children, label }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function emptyBootstrap() {
  return { facilities: [], settings: [], episodes: [], monthlyRuns: [], monthlyClaims: [], importJobs: [] };
}

function normalizeBootstrap(payload) {
  return {
    facilities: payload.facilities || [],
    settings: payload.settings || [],
    episodes: payload.episodes || [],
    monthlyRuns: [...(payload.monthlyRuns || [])].sort(byNewest),
    monthlyClaims: payload.monthlyClaims || [],
    importJobs: payload.importJobs || []
  };
}

function runtimeConfig() {
  if (typeof window === "undefined") return { halunasuEnv: "local", careFeeBaseUrl: "/api/care-fee" };
  return window.__HALUNASU_CARE_FEE_CONFIG__ || { halunasuEnv: "local", careFeeBaseUrl: "/api/care-fee" };
}

function currentClaimMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}`;
}

function hasAnyRole(session, roles) {
  const actual = session?.productRoles?.care_fee || [];
  return actual.some((role) => roles.includes(role)) || session?.globalRoles?.includes("org_admin");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function splitCodes(value) {
  return String(value || "").split(";").map((entry) => entry.trim()).filter(Boolean);
}

function compactMap(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, entry]) => String(entry || "").trim()));
}

function messageFor(error) {
  if (error?.status === 401) return "ログインの有効期限が切れました。再度ログインしてください。";
  if (error?.status === 403) return "この操作を行う権限がありません。";
  return error?.message || "処理に失敗しました。";
}

function number(value) {
  return new Intl.NumberFormat("ja-JP").format(Number(value || 0));
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date) : "";
}

function displayMonth(value) {
  const [year, month] = String(value || "").split("-");
  return year && month ? `${year}年${Number(month)}月` : value;
}

function resultFileName(inputName = "care-emergency.csv") {
  return `${inputName.replace(/\.csv$/iu, "")}-checked.csv`;
}

function environmentLabel(value) {
  if (value === "prod") return "PROD";
  if (value === "stg") return "STG";
  return "LOCAL";
}

function byNewest(left, right) {
  return String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || ""));
}
