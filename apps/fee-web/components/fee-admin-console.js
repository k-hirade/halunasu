"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAdminNav } from "./admin-nav-context";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

const ADMIN_SECTIONS = [
  {
    id: "members",
    group: "管理",
    label: "権限管理",
    description: "診療報酬算定を利用する職員と権限を確認します。"
  },
  {
    id: "settings",
    group: "設定",
    label: "算定設定",
    description: "算定時の初期値、レビュー表示、マスター検索の扱いを管理します。"
  },
  {
    id: "master",
    group: "設定",
    label: "マスタ確認",
    description: "STGで算定に使う診療行為・薬剤・特定器材・コメントのマスタを確認します。",
    stgOnly: true
  },
  {
    id: "audit",
    group: "管理",
    label: "操作ログ",
    description: "算定、レビュー、設定変更の履歴を確認します。"
  },
  {
    id: "account",
    group: "管理",
    label: "アカウント",
    description: "ログイン中の職員情報と利用権限を確認します。"
  }
];

const MASTER_TYPES = [
  { id: "procedure", label: "診療行為", amountLabel: "点数" },
  { id: "drug", label: "薬剤", amountLabel: "単位薬価" },
  { id: "material", label: "特定器材", amountLabel: "単位価格" },
  { id: "comment", label: "コメント", amountLabel: "点数/金額" }
];

export function FeeAdminConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = usePlatformAuth();
  const activeTab = searchParams.get("section") || "home";
  const { registerAdminNav, clearAdminNav } = useAdminNav();
  const [isStgEnv, setIsStgEnv] = useState(false);
  const adminSections = useMemo(
    () => ADMIN_SECTIONS.filter((section) => !section.stgOnly || isStgEnv),
    [isStgEnv]
  );
  const currentSection = adminSections.find((section) => section.id === activeTab) || null;
  const [platformData, setPlatformData] = useState({});
  const [feeData, setFeeData] = useState({});
  const [loadingSection, setLoadingSection] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [auditFilter, setAuditFilter] = useState("");

  const navSections = useMemo(() => adminSections.map((section) => ({
    ...section,
    href: `/admin?section=${encodeURIComponent(section.id)}`
  })), [adminSections]);

  useEffect(() => {
    setIsStgEnv(isStgFeeEnvironment());
  }, []);

  useEffect(() => {
    registerAdminNav({
      activeTab,
      currentPage: currentSection,
      isAvailable: true,
      sections: navSections,
      selectTab: (tabId) => {
        router.push(tabId === "home" ? "/admin" : `/admin?section=${encodeURIComponent(tabId)}`);
      }
    });

    return () => clearAdminNav();
  }, [activeTab, clearAdminNav, currentSection, navSections, registerAdminNav, router]);

  const loadSection = useCallback(async (tab = activeTab) => {
    if (tab === "home" || tab === "account") {
      return;
    }
    if (tab === "master") {
      return;
    }
    setLoadingSection(tab);
    setErrorMessage("");
    try {
      if (tab === "members" || tab === "audit") {
        const section = tab === "members" ? "members" : "audit";
        const response = await auth.api(`/v1/organizations/${encodeURIComponent(auth.session?.orgId)}/admin-bootstrap?section=${section}`);
        setPlatformData((current) => ({ ...current, ...response }));
      }
      if (tab === "settings") {
        const response = await feeApi("/v1/fee/bootstrap?page=1&pageSize=1");
        setFeeData(response);
      }
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "表示内容を読み込めませんでした。"));
    } finally {
      setLoadingSection("");
    }
  }, [activeTab, auth]);

  useEffect(() => {
    loadSection(activeTab);
  }, [activeTab, loadSection]);

  if (activeTab === "home") {
    return (
      <main className="fee-admin-shell">
        <header className="fee-page-head">
          <div>
            <h1>診療報酬算定の設定</h1>
            <p>SOAPと同じ構造で、算定に関する管理と設定をまとめます。</p>
          </div>
        </header>
        <section className="settings-home">
          {["設定", "管理"].map((group) => (
            <div className="settings-home-group" key={group}>
              <h2>{group}</h2>
              <div className="settings-home-list">
                {adminSections.filter((section) => section.group === group).map((section) => (
                  <a className="settings-home-item" href={`/admin?section=${section.id}`} key={section.id}>
                    <span className="settings-home-copy">
                      <strong>{section.label}</strong>
                      <small>{section.description}</small>
                    </span>
                    <span className="settings-home-open">開く</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main className="fee-admin-shell">
      <header className="fee-page-head">
        <div>
          <h1>{currentSection?.label || "設定"}</h1>
          <p>{currentSection?.description || "診療報酬算定の設定を確認します。"}</p>
        </div>
      </header>
      <section className="fee-card">
        {errorMessage ? <div className="fee-error-state" role="status">{errorMessage}</div> : null}
        {activeTab === "audit" ? (
          <div className="fee-admin-filter">
            <input
              type="search"
              placeholder="種別・操作者で検索"
              value={auditFilter}
              onChange={(event) => setAuditFilter(event.target.value)}
            />
          </div>
        ) : null}
        {loadingSection === activeTab ? <div className="fee-empty-state">読み込み中</div> : renderSection(activeTab, { auditFilter, auth, feeData, isStgEnv, platformData })}
      </section>
    </main>
  );
}

function renderSection(activeTab, { auditFilter, auth, feeData, isStgEnv, platformData }) {
  if (activeTab === "members") {
    return (
      <DataTable
        empty="職員はまだ登録されていません。"
        rows={platformData.members || []}
        columns={[
          ["個人ID", (item) => item.loginId],
          ["表示名", (item) => item.displayName],
          ["診療報酬算定の権限", (item) => labelsForList(item.productRoles?.fee) || "なし"],
          ["全体権限", (item) => labelsForList(item.globalRoles) || "なし"],
          ["状態", (item) => statusLabel(item.status)]
        ]}
      />
    );
  }

  if (activeTab === "settings") {
    const masterStatus = feeData.masterStatus || null;
    return (
      <div className="fee-admin-placeholder fee-settings-grid">
        <h2>算定設定</h2>
        <div className="fee-setting-card">
          <strong>算定範囲</strong>
          <p>外来検体検査を中心に候補を作成します。入院/DPCは限定対応としてレビュー前提で扱います。</p>
        </div>
        <div className="fee-setting-card">
          <strong>マスター検索</strong>
          <p>{masterStatus ? "診療行為・薬剤・特定器材・コメントの検索を利用できます。" : "マスター検索APIの反映待ちです。通常の算定入力は利用できます。"}</p>
        </div>
        <div className="fee-setting-card">
          <strong>レビュー方針</strong>
          <p>未対応章、病名不足、施設基準確認、コメント確認が必要な行はレビュー対象として表示します。</p>
        </div>
      </div>
    );
  }

  if (activeTab === "master") {
    if (!isStgEnv) {
      return <div className="fee-empty-state">この画面はSTG環境だけで利用できます。</div>;
    }
    return <MasterBrowser />;
  }

  if (activeTab === "audit") {
    const keyword = normalizeSearch(auditFilter);
    const rows = keyword
      ? (platformData.auditEvents || []).filter((event) => normalizeSearch([
        event.eventType,
        event.actorLoginId,
        event.targetType,
        event.targetId
      ].join(" ")).includes(keyword))
      : (platformData.auditEvents || []);
    return (
      <DataTable
        empty="操作ログはまだありません。"
        rows={rows.slice(0, 100)}
        columns={[
          ["日時", (item) => formatDateTime(item.createdAt)],
          ["イベント", (item) => eventTypeLabel(item.eventType)],
          ["操作者", (item) => item.actorLoginId || "-"],
          ["対象", (item) => [targetTypeLabel(item.targetType), item.targetId].filter(Boolean).join(" / ") || "-"]
        ]}
      />
    );
  }

  if (activeTab === "account") {
    return (
      <div className="fee-admin-placeholder account-summary">
        <h2>アカウント</h2>
        <dl className="account-definition-list">
          <div>
            <dt>病院コード</dt>
            <dd>{auth.session?.organizationCode || "-"}</dd>
          </div>
          <div>
            <dt>個人ID</dt>
            <dd>{auth.session?.loginId || "-"}</dd>
          </div>
          <div>
            <dt>全体権限</dt>
            <dd>{labelsForList(auth.session?.globalRoles) || "なし"}</dd>
          </div>
          <div>
            <dt>診療報酬算定の権限</dt>
            <dd>{labelsForList(auth.session?.productRoles?.fee) || "なし"}</dd>
          </div>
          <div>
            <dt>2段階認証</dt>
            <dd>{auth.session?.mfaVerified ? "確認済み" : "未確認"}</dd>
          </div>
        </dl>
        <div className="account-actions">
          <a className="btn btn--ghost" href={facilityAdminUrl()}>施設管理画面を開く</a>
          <button className="btn btn--primary" onClick={auth.logout} type="button">ログアウト</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fee-admin-placeholder">
      <h2>設定</h2>
      <p>移行中です。</p>
    </div>
  );
}

function MasterBrowser() {
  const [masterType, setMasterType] = useState("procedure");
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const currentType = MASTER_TYPES.find((type) => type.id === masterType) || MASTER_TYPES[0];

  const loadMaster = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const params = new URLSearchParams({
        type: masterType,
        q: query,
        page: String(page),
        pageSize: "50"
      });
      const response = await feeApi(`/v1/fee/master/browse?${params.toString()}`);
      setData(response);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "マスタを読み込めませんでした。"));
    } finally {
      setLoading(false);
    }
  }, [masterType, page, query]);

  useEffect(() => {
    loadMaster();
  }, [loadMaster]);

  function changeType(nextType) {
    setMasterType(nextType);
    setPage(1);
  }

  function submitSearch(event) {
    event.preventDefault();
    setQuery(searchText.trim());
    setPage(1);
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const source = sourceForMasterType(sources, masterType);
  const totalPages = Math.max(1, Number(data?.totalPages || 1));
  const totalCount = Number(data?.totalCount || 0);

  return (
    <div className="master-browser">
      <div className="master-browser-head">
        <div>
          <h2>マスタ確認</h2>
          <p>STGで算定とマスター検索に使っているSQLiteマスタを確認します。</p>
        </div>
        <button
          className="btn btn--ghost"
          disabled={!items.length}
          onClick={() => downloadCurrentMasterCsv(data, currentType)}
          type="button"
        >
          表示中をCSV保存
        </button>
      </div>

      {sources.length ? (
        <div className="master-source-grid" aria-label="マスタソース">
          {sources.map((item) => (
            <div className="master-source-card" key={item.sourceType}>
              <strong>{sourceLabel(item.sourceType)}</strong>
              <span>{formatNumber(item.rowCount)}件 / {item.sourceVersion || "-"}</span>
              <small>{formatSourcePath(item.rawPath)}</small>
            </div>
          ))}
        </div>
      ) : null}

      <div className="master-browser-tabs" role="tablist" aria-label="マスタ種別">
        {MASTER_TYPES.map((type) => (
          <button
            aria-selected={masterType === type.id}
            className={`master-browser-tab ${masterType === type.id ? "is-active" : ""}`}
            key={type.id}
            onClick={() => changeType(type.id)}
            role="tab"
            type="button"
          >
            {type.label}
          </button>
        ))}
      </div>

      <form className="master-browser-toolbar" onSubmit={submitSearch}>
        <label>
          <span>検索</span>
          <input
            type="search"
            placeholder="コード・名称・かなで検索"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <button className="btn btn--primary" type="submit">検索</button>
        <button
          className="btn btn--ghost"
          onClick={() => {
            setSearchText("");
            setQuery("");
            setPage(1);
          }}
          type="button"
        >
          クリア
        </button>
      </form>

      <div className="master-browser-meta">
        <span>{currentType.label}</span>
        <span>{formatNumber(totalCount)}件</span>
        {query ? <span>検索: {query}</span> : null}
        {source ? <span>公開日: {source.publishedAt || "-"}</span> : null}
      </div>

      {errorMessage ? <div className="fee-error-state" role="status">{errorMessage}</div> : null}
      {loading ? <div className="fee-empty-state">読み込み中</div> : null}
      {!loading && !items.length ? <div className="fee-empty-state">該当するマスタはありません。</div> : null}
      {!loading && items.length ? (
        <>
          <div className="fee-table-wrap master-table-wrap">
            <table className="fee-data-table master-data-table">
              <thead>
                <tr>
                  <th>コード</th>
                  <th>名称</th>
                  <th>{currentType.amountLabel}</th>
                  <th>単位・分類</th>
                  <th>有効期間</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.kind}-${item.code}`}>
                    <td>{item.code}</td>
                    <td>
                      <span className="master-name-cell">
                        <strong>{item.name || "-"}</strong>
                        {item.baseName || item.kana ? <small>{[item.baseName, item.kana].filter(Boolean).join(" / ")}</small> : null}
                      </span>
                    </td>
                    <td>{masterAmount(item)}</td>
                    <td>{masterCategory(item)}</td>
                    <td>{[item.effectiveFrom, item.effectiveTo].filter(Boolean).join(" - ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="master-pagination">
            <button className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">前へ</button>
            <span>{formatNumber(page)} / {formatNumber(totalPages)}</span>
            <button className="btn btn--ghost" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} type="button">次へ</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function labelsForList(values) {
  return Array.isArray(values) && values.length ? values.join("、") : "";
}

function DataTable({ columns, empty, rows }) {
  if (!rows.length) {
    return <div className="fee-empty-state">{empty}</div>;
  }
  return (
    <div className="fee-table-wrap">
      <table className="fee-data-table">
        <thead>
          <tr>{columns.map(([label]) => <th key={label}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.memberId || row.eventId || index}>
              {columns.map(([label, getter]) => <td key={label}>{getter(row) || "-"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function feeApi(path, options = {}) {
  const config = typeof window !== "undefined" ? window.__HALUNASU_FEE_CONFIG__ || {} : {};
  const baseUrl = config.feeBaseUrl || "/api/fee";
  const accessToken = getStoredPlatformAccessToken();
  const headers = { "content-type": "application/json" };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
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
}

function sourceForMasterType(sources = [], masterType) {
  const sourceType = ({
    procedure: "medical_procedure_master",
    drug: "drug_master",
    material: "specific_material_master",
    comment: "comment_master"
  })[masterType];
  return sources.find((source) => source.sourceType === sourceType) || null;
}

function sourceLabel(sourceType) {
  return ({
    medical_procedure_master: "診療行為",
    drug_master: "薬剤",
    specific_material_master: "特定器材",
    comment_master: "コメント",
    medical_electronic_fee_table: "電子点数表"
  })[sourceType] || sourceType || "-";
}

function formatSourcePath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) {
    return "-";
  }
  if (!value.startsWith("{")) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    const entries = Object.values(parsed).filter(Boolean);
    return `${entries.length}個のCSV: ${entries[0] || ""}`;
  } catch {
    return value;
  }
}

function masterAmount(item) {
  if (item.points !== undefined) {
    return `${formatNumber(item.points)}点`;
  }
  if (item.unitAmountYen !== undefined) {
    return `${formatNumber(item.unitAmountYen)}円`;
  }
  if (item.upperPoints !== undefined) {
    return `${formatNumber(item.upperPoints)}点`;
  }
  return "-";
}

function masterCategory(item) {
  const values = [
    item.unitName,
    item.chapter,
    item.part,
    item.section,
    item.dosageForm,
    item.materialKind,
    item.amountKind,
    item.inoutApplicability
  ].filter(Boolean);
  return values.length ? values.join(" / ") : "-";
}

function downloadCurrentMasterCsv(data, currentType) {
  if (typeof window === "undefined") {
    return;
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    return;
  }
  const source = sourceForMasterType(data?.sources || [], currentType.id);
  const columns = [
    ["type", () => currentType.label],
    ["source_version", () => source?.sourceVersion || ""],
    ["published_at", () => source?.publishedAt || ""],
    ["code", (item) => item.code],
    ["name", (item) => item.name],
    ["base_name", (item) => item.baseName],
    ["kana", (item) => item.kana],
    ["points", (item) => item.points],
    ["unit_name", (item) => item.unitName],
    ["unit_amount_yen", (item) => item.unitAmountYen],
    ["chapter", (item) => item.chapter],
    ["part", (item) => item.part],
    ["section", (item) => item.section],
    ["effective_from", (item) => item.effectiveFrom],
    ["effective_to", (item) => item.effectiveTo]
  ];
  const csv = [
    columns.map(([label]) => escapeCsv(label)).join(","),
    ...items.map((item) => columns.map(([, getter]) => escapeCsv(getter(item))).join(","))
  ].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fee-master-${currentType.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/u.test(text)) {
    return text;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value === undefined || value === null || value === "" ? "-" : String(value);
  }
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: Number.isInteger(numeric) ? 0 : 2
  }).format(numeric);
}

function isStgFeeEnvironment() {
  if (typeof window === "undefined") {
    return false;
  }
  const config = window.__HALUNASU_FEE_CONFIG__ || {};
  const env = String(config.halunasuEnv || "").trim().toLowerCase();
  const host = String(window.location.hostname || "").toLowerCase();
  return env === "stg"
    || host === "fee.stg.halunasu.com"
    || host === "halunasu-fee-stg.netlify.app"
    || host.endsWith("--halunasu-fee-stg.netlify.app");
}

function statusLabel(value) {
  return ({
    active: "有効",
    inactive: "停止中",
    enabled: "有効",
    disabled: "停止中",
    completed: "完了"
  })[value] || value || "-";
}

function eventTypeLabel(value) {
  return ({
    "fee.session.created": "算定作成",
    "fee.session.updated": "算定更新",
    "fee.calculation.created": "算定候補作成",
    "fee.review.updated": "レビュー更新",
    "auth.login_succeeded": "ログイン成功",
    "auth.logout": "ログアウト"
  })[value] || value || "-";
}

function targetTypeLabel(value) {
  return ({
    fee_session: "算定記録",
    review_item: "レビュー",
    member: "職員"
  })[value] || value || "";
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

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function toUserFacingErrorMessage(error, fallbackMessage) {
  const rawMessage = typeof error === "string" ? error : error?.message;
  const status = typeof error === "object" && error ? Number(error.status || error.statusCode || 0) : 0;
  const text = String(rawMessage || "").trim();
  const lower = text.toLowerCase();
  if (lower.includes("invalid session") || lower.includes("session expired") || lower.includes("session revoked") || lower === "unauthorized") return "ログイン状態を確認できません。もう一度ログインしてください。";
  if (lower.includes("role is required") || lower.includes("product access is required") || lower === "forbidden" || status === 403) return "この操作を行う権限がありません。";
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower === "load failed") return "通信に失敗しました。接続を確認して、もう一度お試しください。";
  if (status >= 500) return "処理中に問題が発生しました。時間を置いてもう一度お試しください。";
  return /[ぁ-んァ-ヶ一-龠]/u.test(text) ? text : fallbackMessage;
}

function facilityAdminUrl() {
  if (typeof window !== "undefined" && window.location.hostname.includes(".stg.")) {
    return "https://admin.stg.halunasu.com/";
  }
  return "https://admin.halunasu.com/";
}
