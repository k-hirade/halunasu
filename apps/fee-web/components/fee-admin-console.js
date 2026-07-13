"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toUserFacingErrorMessage } from "@halunasu/web-ui/user-facing-error";
import { useAdminNav } from "./admin-nav-context";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";
import { FeeBaselineDiffConsole } from "./fee-baseline-diff-console";
import { isFeeUploadToolsAllowed } from "../lib/baseline-diff";

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
    label: "設定",
    description: "算定の前提・施設基準・レセプト出力の既定値をまとめて管理します。"
  },
  {
    id: "baseline-diff",
    group: "設定",
    label: "再算定差分診断",
    description: "既存レセと当社再算定を突合し、算定もれ候補・要確認・検討を出します（STG/Demo限定）。",
    uploadToolsOnly: true
  },
  {
    id: "recept-checker",
    group: "設定",
    label: "レセプトチェッカー",
    description: "UKEをアップロードして、請求前の返戻・査定リスクをその場で点検します（STG/Demo限定）。",
    uploadToolsOnly: true
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

// 出力前チェックの全項目をグループ化して表示する（旧UIは7項目のみ露出していた）。
const RECEIPT_VALIDATION_GROUPS = [
  ["医療機関", [
    ["facilityMedicalInstitutionCode", "医療機関コード"],
    ["facilityPrefectureCode", "都道府県コード"]
  ]],
  ["患者", [
    ["patientDisplayName", "患者氏名"],
    ["patientSex", "患者性別"],
    ["patientBirthDate", "患者生年月日"]
  ]],
  ["診療・保険", [
    ["serviceDate", "診療日"],
    ["claimMonth", "請求月"],
    ["insuranceInsurerNumber", "保険者番号"],
    ["insuranceInsuredSymbol", "被保険者記号"],
    ["insuranceInsuredNumber", "被保険者番号"],
    ["publicInsurancePayerNumber", "公費負担者番号"],
    ["publicInsuranceRecipientNumber", "公費受給者番号"]
  ]],
  ["明細", [
    ["lineCode", "明細コード"],
    ["linePoints", "明細点数"],
    ["lineOrderType", "明細区分"]
  ]],
  ["コメント・症状詳記", [
    ["commentText", "コメント本文"],
    ["commentCode", "コメントコード"],
    ["commentShinryoIdentification", "コメント診療識別"],
    ["symptomDetailText", "症状詳記本文"],
    ["symptomDetailKubun", "症状詳記区分"]
  ]]
];

const RECEIPT_SEVERITY_OPTIONS = [
  ["warning", "警告"],
  ["error", "必須エラー"],
  ["off", "確認しない"]
];

const FACILITY_STANDARD_STATUS_OPTIONS = [
  ["active", "届出済み"],
  ["pending", "申請中"],
  ["expired", "失効"],
  ["withdrawn", "取下げ"]
];

function emptyFacilityStandard() {
  return { key: "", name: "", acceptanceNumber: "", claimStartDate: "", effectiveTo: "", status: "active" };
}

export function FeeAdminConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = usePlatformAuth();
  const activeTab = searchParams.get("section") || "home";
  const { registerAdminNav, clearAdminNav } = useAdminNav();
  const [isStgEnv, setIsStgEnv] = useState(false);
  const [uploadToolsAllowed, setUploadToolsAllowed] = useState(false);
  const adminSections = useMemo(
    () => ADMIN_SECTIONS.filter((section) => (
      (!section.stgOnly || isStgEnv)
      && (!section.uploadToolsOnly || uploadToolsAllowed)
    )),
    [isStgEnv, uploadToolsAllowed]
  );
  // 旧「レセプト設定」リンク(?section=receipt-settings)は統合した「設定」へ寄せる。
  const resolvedTab = activeTab === "receipt-settings" ? "settings" : activeTab;
  const currentSection = adminSections.find((section) => section.id === resolvedTab) || null;
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
    setUploadToolsAllowed(isFeeUploadToolsAllowed(auth.session));
  }, [auth.session]);

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
    if (tab === "master" || tab === "baseline-diff" || tab === "recept-checker") {
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
      if (tab === "settings" || tab === "receipt-settings") {
        const [bootstrap, settings] = await Promise.all([
          feeApi("/v1/fee/bootstrap?page=1&pageSize=1"),
          feeApi("/v1/fee/settings")
        ]);
        setFeeData({ ...bootstrap, ...settings });
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
        {loadingSection === activeTab ? <div className="fee-empty-state">読み込み中</div> : renderSection(activeTab, { auditFilter, auth, feeData, isStgEnv, platformData, uploadToolsAllowed })}
      </section>
    </main>
  );
}

function renderSection(activeTab, { auditFilter, auth, feeData, isStgEnv, platformData, uploadToolsAllowed }) {
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

  if (activeTab === "settings" || activeTab === "receipt-settings") {
    return <FeeSettingsPanel data={feeData} initialGroup={activeTab === "receipt-settings" ? "receipt" : "billing"} />;
  }

  if (activeTab === "baseline-diff") {
    if (!uploadToolsAllowed) {
      return <div className="fee-empty-state">この画面はSTG環境または許可されたDemo組織だけで利用できます。</div>;
    }
    return <FeeBaselineDiffConsole />;
  }

  if (activeTab === "recept-checker") {
    if (!uploadToolsAllowed) {
      return <div className="fee-empty-state">この画面はSTG環境または許可されたDemo組織だけで利用できます。</div>;
    }
    return <ReceptCheckerLaunchPanel />;
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

function ReceptCheckerLaunchPanel() {
  const url = process.env.NEXT_PUBLIC_RECEPT_CHECKER_URL || process.env.NEXT_PUBLIC_RECEPT_CHECKER_STG_URL || "";
  return (
    <div className="fee-admin-placeholder">
      <h2>レセプトチェッカー</h2>
      <p>
        UKEファイルをアップロードして、請求前の形式・病名・適応・併算定・回数制限・算定もれをその場で点検します。
        このデモ版は一時点検用で、履歴DBへの保存は行いません。
      </p>
      {url ? (
        <a className="btn btn--primary" href={url} rel="noreferrer" target="_blank">レセプトチェッカーを開く</a>
      ) : (
        <div className="fee-empty-state">NEXT_PUBLIC_RECEPT_CHECKER_URL または NEXT_PUBLIC_RECEPT_CHECKER_STG_URL を設定してください。</div>
      )}
    </div>
  );
}

function FeeSettingsPanel({ data, initialGroup = "billing" }) {
  const facilities = Array.isArray(data.facilities) ? data.facilities : [];
  const settingsMap = data.settings || {};
  const firstFacilityId = facilities[0]?.facilityId || "default";
  const [selectedFacilityId, setSelectedFacilityId] = useState(firstFacilityId);
  const selectedFacility = facilities.find((facility) => facility.facilityId === selectedFacilityId) || facilities[0] || null;
  const selectedSettings = settingsMap[selectedFacilityId] || settingsMap.default || defaultSettingsForFacility(selectedFacilityId);
  const [facilityStandards, setFacilityStandards] = useState(initialFacilityStandards(selectedSettings, selectedFacility));
  const [draft, setDraft] = useState(selectedSettings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [activeSection, setActiveSection] = useState(initialGroup === "receipt" ? "receipt-output" : "history");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setSelectedFacilityId(firstFacilityId);
  }, [firstFacilityId]);

  useEffect(() => {
    setFacilityStandards(initialFacilityStandards(selectedSettings, selectedFacility));
    setDraft(selectedSettings);
    setDirty(false);
    setSavedMessage("");
    setErrorMessage("");
  }, [selectedFacility?.facilityId, selectedSettings]);

  async function saveSettings() {
    setSaving(true);
    setSavedMessage("");
    setErrorMessage("");
    try {
      const cleanedStandards = facilityStandards.filter((entry) => (entry.key || entry.name));
      // 算定の正は有効期間付きの fee設定(facilityStandards)。platform側キーは
      // 設定未登録施設の移行用フォールバックのため、本日時点で有効な届出だけを平坦化する。
      const today = new Date().toISOString().slice(0, 10);
      const facilityStandardKeys = cleanedStandards
        .filter((entry) => entry.status === "active" && entry.key)
        .filter((entry) => !entry.claimStartDate || entry.claimStartDate <= today)
        .filter((entry) => !entry.effectiveTo || entry.effectiveTo >= today)
        .map((entry) => entry.key);
      if (selectedFacility?.facilityId) {
        const facilityResponse = await feeApi(`/v1/fee/facilities/${encodeURIComponent(selectedFacility.facilityId)}`, {
          method: "PATCH",
          body: { facilityStandardKeys }
        });
        selectedFacility.facilityStandardKeys = facilityResponse.facility?.facilityStandardKeys || facilityStandardKeys;
      }
      const settingsResponse = await feeApi(`/v1/fee/settings/${encodeURIComponent(selectedFacilityId || "default")}`, {
        method: "PATCH",
        body: { ...draft, facilityStandards: cleanedStandards }
      });
      setDraft(settingsResponse.settings || draft);
      setFacilityStandards(initialFacilityStandards(settingsResponse.settings || draft, selectedFacility));
      setDirty(false);
      setSavedMessage("保存しました。次回算定からこの設定を参照します。");
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "算定設定を保存できませんでした。"));
    } finally {
      setSaving(false);
    }
  }

  function markDirty() {
    setDirty(true);
    setSavedMessage("");
  }

  function updateFacilityStandard(index, patch) {
    markDirty();
    setFacilityStandards((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)));
  }

  function addFacilityStandard() {
    markDirty();
    setFacilityStandards((current) => [...current, emptyFacilityStandard()]);
  }

  function removeFacilityStandard(index) {
    markDirty();
    setFacilityStandards((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  function updateHistoryPolicy(patch) {
    markDirty();
    setDraft((current) => ({ ...current, historyPolicy: { ...(current.historyPolicy || {}), ...patch } }));
  }

  function updateInitialRevisitPolicy(patch) {
    markDirty();
    setDraft((current) => ({ ...current, initialRevisitPolicy: { ...(current.initialRevisitPolicy || {}), ...patch } }));
  }

  function updateReceiptPolicy(patch) {
    markDirty();
    setDraft((current) => {
      const currentPolicy = receiptPolicyForDraft(current, selectedFacilityId);
      return { ...current, receiptPolicy: { ...currentPolicy, ...patch } };
    });
  }

  function updateReceiptValidationSeverity(key, value) {
    markDirty();
    setDraft((current) => {
      const currentPolicy = receiptPolicyForDraft(current, selectedFacilityId);
      return {
        ...current,
        receiptPolicy: {
          ...currentPolicy,
          validationSeverity: {
            ...(currentPolicy.validationSeverity || {}),
            [key]: value
          }
        }
      };
    });
  }

  function updateReceiptAnnotationDefaults(patch) {
    markDirty();
    setDraft((current) => {
      const currentPolicy = receiptPolicyForDraft(current, selectedFacilityId);
      return {
        ...current,
        receiptPolicy: {
          ...currentPolicy,
          annotationDefaults: {
            ...(currentPolicy.annotationDefaults || {}),
            ...patch
          }
        }
      };
    });
  }

  if (!facilities.length) {
    return <div className="fee-empty-state">施設が登録されていません。Core Adminで施設を登録してください。</div>;
  }

  const receiptPolicy = receiptPolicyForDraft(draft, selectedFacilityId);
  const receiptAnnotationDefaults = receiptPolicy.annotationDefaults || {};
  const keyword = search.trim().toLowerCase();
  const visibleNav = keyword
    ? SETTINGS_NAV.filter((section) => `${section.label} ${section.keywords || ""}`.toLowerCase().includes(keyword))
    : SETTINGS_NAV;
  const currentSectionId = visibleNav.some((section) => section.id === activeSection)
    ? activeSection
    : (visibleNav[0]?.id || activeSection);
  const navGroups = [...new Set(visibleNav.map((section) => section.group))];

  return (
    <div className="fee-settings-app">
      <div className="fee-settings-bar">
        <div className="fee-settings-bar-main">
          <select className="fee-settings-facility" value={selectedFacilityId} onChange={(event) => setSelectedFacilityId(event.target.value)}>
            {facilities.map((facility) => (
              <option key={facility.facilityId} value={facility.facilityId}>{facility.displayName || facility.facilityId}</option>
            ))}
          </select>
          <input
            className="fee-settings-search"
            type="search"
            placeholder="設定を検索…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="fee-settings-bar-actions">
          {dirty ? <span className="fee-settings-dirty">未保存の変更</span> : null}
          <button className="btn btn--primary" disabled={saving || !dirty} onClick={saveSettings} type="button">
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      </div>
      {errorMessage ? <div className="fee-error-state" role="status">{errorMessage}</div> : null}
      {savedMessage ? <div className="fee-empty-state" role="status">{savedMessage}</div> : null}

      <div className="fee-settings-body">
        <nav className="fee-settings-nav" aria-label="設定セクション">
          {navGroups.map((group) => (
            <div className="fee-settings-nav-group" key={group || "_"}>
              {group ? <span className="fee-settings-nav-group-label">{group}</span> : null}
              {visibleNav.filter((section) => section.group === group).map((section) => (
                <button
                  className={`fee-settings-nav-item ${currentSectionId === section.id ? "is-active" : ""}`}
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  type="button"
                >
                  {section.label}
                </button>
              ))}
            </div>
          ))}
          {visibleNav.length === 0 ? <p className="fee-setting-help">一致する設定はありません。</p> : null}
        </nav>

        <div className="fee-settings-content">
          {currentSectionId === "facility" ? (
            <SettingsSection title="施設情報" help="Core Adminで管理する施設の基本情報です（ここでは編集できません）。">
              <dl className="account-definition-list">
                <div><dt>医療機関名</dt><dd>{selectedFacility?.displayName || "-"}</dd></div>
                <div><dt>医療機関コード</dt><dd>{selectedFacility?.medicalInstitutionCode || "-"}</dd></div>
                <div><dt>施設種別</dt><dd>{selectedFacility?.facilityType || "-"}</dd></div>
                <div><dt>都道府県</dt><dd>{selectedFacility?.prefecture || "-"}</dd></div>
                <div><dt>地方厚生局</dt><dd>{selectedFacility?.regionalBureau || "-"}</dd></div>
              </dl>
            </SettingsSection>
          ) : null}

          {currentSectionId === "history" ? (
            <SettingsSection title="履歴の扱い" help="過去受診の参照範囲と、履歴が不完全なときの確認方針です。点数・算定ルールは公式マスタで固定で、上書きしません。">
              <SettingRow label="参照期間" help="過去の受診をどこまで遡って参照するか。">
                <select value={draft.historyPolicy?.defaultLookbackMonths || 12} onChange={(event) => updateHistoryPolicy({ defaultLookbackMonths: Number(event.target.value) })}>
                  {[2, 3, 4, 6, 12].map((month) => <option key={month} value={month}>{month}か月</option>)}
                </select>
              </SettingRow>
              <SettingRow label="履歴完全性" help="取り込めている過去履歴の完全さ。算定の確信度に影響します。">
                <select value={draft.historyPolicy?.historyCompleteness || "unknown"} onChange={(event) => updateHistoryPolicy({ historyCompleteness: event.target.value })}>
                  <option value="complete">完全</option>
                  <option value="partial">一部</option>
                  <option value="unknown">不明</option>
                </select>
              </SettingRow>
              <SettingRow label="外部履歴を利用する" help="外部レセ・CSV・手入力で取り込んだ履歴も参照します。">
                <ToggleInput checked={draft.historyPolicy?.externalHistoryEnabled === true} onChange={(checked) => updateHistoryPolicy({ externalHistoryEnabled: checked })} />
              </SettingRow>
            </SettingsSection>
          ) : null}

          {currentSectionId === "initial-revisit" ? (
            <SettingsSection title="初診・再診" help="初診/再診の公式定義は上書きしません。履歴が不完全なときの確認方針のみ管理します。">
              <SettingRow label="履歴なしはレビュー必須" help="過去履歴が無い場合、初診/再診の確定を医事レビューに回します。">
                <ToggleInput checked={draft.initialRevisitPolicy?.requireReviewWhenNoHistory !== false} onChange={(checked) => updateInitialRevisitPolicy({ requireReviewWhenNoHistory: checked })} />
              </SettingRow>
            </SettingsSection>
          ) : null}

          {currentSectionId === "facility-standards" ? (
            <SettingsSection
              title="施設基準・届出"
              help="届出済みの施設基準を管理します。状態が「届出済み」の行のキーだけを算定の前提に使います（受理番号・算定開始日・有効期限は届出管理用）。"
              action={<button className="btn btn--ghost btn--sm" onClick={addFacilityStandard} type="button">＋ 追加</button>}
            >
              {facilityStandards.length ? (
                <div className="fee-standard-table-wrap">
                  <table className="fee-standard-table">
                    <thead>
                      <tr>
                        <th>施設基準キー</th>
                        <th>名称</th>
                        <th>受理番号</th>
                        <th>算定開始日</th>
                        <th>有効期限</th>
                        <th>状態</th>
                        <th aria-label="操作" />
                      </tr>
                    </thead>
                    <tbody>
                      {facilityStandards.map((entry, index) => (
                        <tr className={facilityStandardExpiryClass(entry)} key={index}>
                          <td><input value={entry.key} placeholder="例: lab_management_1" onChange={(event) => updateFacilityStandard(index, { key: event.target.value })} /></td>
                          <td><input value={entry.name} placeholder="例: 検体検査管理加算(I)" onChange={(event) => updateFacilityStandard(index, { name: event.target.value })} /></td>
                          <td><input value={entry.acceptanceNumber} placeholder="第○号" onChange={(event) => updateFacilityStandard(index, { acceptanceNumber: event.target.value })} /></td>
                          <td><input type="date" value={entry.claimStartDate} onChange={(event) => updateFacilityStandard(index, { claimStartDate: event.target.value })} /></td>
                          <td>
                            <input type="date" value={entry.effectiveTo} onChange={(event) => updateFacilityStandard(index, { effectiveTo: event.target.value })} />
                            {facilityStandardExpiryNote(entry) ? <small className="fee-standard-expiry">{facilityStandardExpiryNote(entry)}</small> : null}
                          </td>
                          <td>
                            <select value={entry.status} onChange={(event) => updateFacilityStandard(index, { status: event.target.value })}>
                              {FACILITY_STANDARD_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </td>
                          <td><button className="btn btn--ghost btn--sm" onClick={() => removeFacilityStandard(index)} type="button">削除</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="fee-setting-help">届出済みの施設基準を「＋追加」から登録してください。</p>}
            </SettingsSection>
          ) : null}

          {currentSectionId === "receipt-output" ? (
            <SettingsSection title="レセプト出力" help="提出物(レセ電/CSV)の形式の既定値です。点数・算定要件は上書きしません。">
              <SettingRow label="レセプト表示単位の既定" help="プレビュー/出力の既定スコープ。施設ごとに上書きできます。">
                <select value={receiptPolicy.defaultReceiptScope || "service_date"} onChange={(event) => updateReceiptPolicy({ defaultReceiptScope: event.target.value })}>
                  <option value="service_date">診療日単位</option>
                  <option value="monthly">月次集計</option>
                </select>
              </SettingRow>
              <SettingRow label="レセ電(UKE)の既定文字コード" help="レセ電出力の文字コード。">
                <select value={receiptPolicy.ukeEncoding || "shift_jis"} onChange={(event) => updateReceiptPolicy({ ukeEncoding: event.target.value })}>
                  <option value="shift_jis">Shift_JIS</option>
                  <option value="utf-8">UTF-8</option>
                </select>
              </SettingRow>
              <SettingRow label="接続先レセコンの仕様を確認済み" help="CSV/UKE/APIの取込仕様を検証済みとして扱います。">
                <ToggleInput checked={receiptPolicy.connectorSpecVerified === true} onChange={(checked) => updateReceiptPolicy({ connectorSpecVerified: checked })} />
              </SettingRow>
              <SettingRow label="必須エラー時は出力を止める" help="出力前チェックの必須エラーがある場合、CSV/UKE出力をブロックします。">
                <ToggleInput checked={receiptPolicy.blockExportOnErrors === true} onChange={(checked) => updateReceiptPolicy({ blockExportOnErrors: checked })} />
              </SettingRow>
            </SettingsSection>
          ) : null}

          {currentSectionId === "receipt-validation" ? (
            <SettingsSection title="出力前チェック" help="提出前に不足項目を検出する重大度です。「必須エラー」は出力停止の対象にできます。">
              {RECEIPT_VALIDATION_GROUPS.map(([groupLabel, fields]) => (
                <div className="fee-severity-group" key={groupLabel}>
                  <div className="fee-severity-group-top">
                    <span className="fee-severity-group-label">{groupLabel}</span>
                    <div className="fee-severity-bulk">
                      {RECEIPT_SEVERITY_OPTIONS.map(([value, label]) => (
                        <button
                          className="btn btn--ghost btn--xs"
                          key={value}
                          onClick={() => fields.forEach(([key]) => updateReceiptValidationSeverity(key, value))}
                          type="button"
                        >
                          全て{label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {fields.map(([key, label]) => (
                    <ReceiptSeveritySelect
                      key={key}
                      label={label}
                      value={receiptPolicy.validationSeverity?.[key] || "warning"}
                      onChange={(value) => updateReceiptValidationSeverity(key, value)}
                    />
                  ))}
                </div>
              ))}
            </SettingsSection>
          ) : null}

          {currentSectionId === "receipt-annotations" ? (
            <SettingsSection title="コメント・症状詳記の既定値" help="レセプトのコメント・症状詳記に使う既定の区分です。">
              <SettingRow label="コメントの既定診療識別" help="コメント(CO)に既定で付与する診療識別。">
                <input maxLength={8} placeholder="例: 60" value={receiptAnnotationDefaults.commentShinryoIdentification || ""} onChange={(event) => updateReceiptAnnotationDefaults({ commentShinryoIdentification: event.target.value })} />
              </SettingRow>
              <SettingRow label="症状詳記の既定区分" help="症状詳記(SJ)に既定で付与する区分。">
                <input maxLength={8} placeholder="例: 01" value={receiptAnnotationDefaults.symptomDetailKubun || ""} onChange={(event) => updateReceiptAnnotationDefaults({ symptomDetailKubun: event.target.value })} />
              </SettingRow>
            </SettingsSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const SETTINGS_NAV = [
  { id: "facility", label: "施設情報", group: null, keywords: "医療機関 都道府県 厚生局" },
  { id: "history", label: "履歴の扱い", group: "算定", keywords: "参照期間 完全性 外部履歴" },
  { id: "initial-revisit", label: "初診・再診", group: "算定", keywords: "初診 再診 レビュー" },
  { id: "facility-standards", label: "施設基準・届出", group: "算定", keywords: "施設基準 届出 受理番号 算定開始日 有効期限" },
  { id: "receipt-output", label: "レセプト出力", group: "レセプト", keywords: "uke レセ電 csv 文字コード 表示単位 月次" },
  { id: "receipt-validation", label: "出力前チェック", group: "レセプト", keywords: "チェック 重大度 必須 エラー 警告" },
  { id: "receipt-annotations", label: "コメント・症状詳記", group: "レセプト", keywords: "コメント 症状詳記 診療識別 区分" }
];

function SettingsSection({ action = null, children, help, title }) {
  return (
    <section className="fee-settings-section">
      <header className="fee-settings-section-head">
        <div>
          <h3>{title}</h3>
          {help ? <p>{help}</p> : null}
        </div>
        {action}
      </header>
      <div className="fee-settings-section-body">{children}</div>
    </section>
  );
}

function SettingRow({ children, help, label }) {
  return (
    <div className="fee-settings-row">
      <div className="fee-settings-row-label">
        <strong>{label}</strong>
        {help ? <small>{help}</small> : null}
      </div>
      <div className="fee-settings-row-control">{children}</div>
    </div>
  );
}

function ToggleInput({ checked, onChange }) {
  return (
    <label className="fee-toggle">
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span>{checked ? "ON" : "OFF"}</span>
    </label>
  );
}

function facilityStandardExpiryInfo(entry = {}) {
  const raw = String(entry.effectiveTo || "").trim();
  if (!raw || entry.status === "withdrawn") {
    return null;
  }
  const end = new Date(raw.length === 7 ? `${raw}-01` : raw);
  if (Number.isNaN(end.getTime())) {
    return null;
  }
  const days = Math.floor((end.getTime() - Date.now()) / 86400000);
  if (days < 0) {
    return { level: "expired", note: "有効期限切れ" };
  }
  if (days <= 60) {
    return { level: "soon", note: `あと${days}日で期限` };
  }
  return null;
}

function facilityStandardExpiryClass(entry) {
  const info = facilityStandardExpiryInfo(entry);
  return info ? `fee-standard-row--${info.level}` : "";
}

function facilityStandardExpiryNote(entry) {
  return facilityStandardExpiryInfo(entry)?.note || "";
}

function initialFacilityStandards(settings = {}, facility = null) {
  const fromSettings = Array.isArray(settings?.facilityStandards) ? settings.facilityStandards : [];
  if (fromSettings.length) {
    return fromSettings.map((entry) => ({ ...emptyFacilityStandard(), ...entry }));
  }
  // 旧データ(facilityStandardKeys のみ)からの移行: キーだけの行として表示する。
  const keys = Array.isArray(facility?.facilityStandardKeys) ? facility.facilityStandardKeys : [];
  return keys.map((key) => ({ ...emptyFacilityStandard(), key: String(key || ""), status: "active" }));
}

function ReceiptSeveritySelect({ label, onChange, value }) {
  return (
    <label className="fee-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {RECEIPT_SEVERITY_OPTIONS.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
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

function defaultSettingsForFacility(facilityId = "default") {
  return {
    facilityId,
    effectiveFrom: "2026-06-01",
    historyPolicy: {
      defaultLookbackMonths: 12,
      externalHistoryEnabled: false,
      historyCompleteness: "unknown"
    },
    initialRevisitPolicy: {
      requireReviewWhenNoHistory: true
    },
    facilityStandards: [],
    receiptPolicy: {
      ukeEncoding: "shift_jis",
      blockExportOnErrors: false,
      connectorSpecVerified: false,
      defaultReceiptScope: "service_date",
      validationSeverity: {
        facilityMedicalInstitutionCode: "error",
        facilityPrefectureCode: "warning",
        patientDisplayName: "error",
        patientSex: "warning",
        patientBirthDate: "warning",
        serviceDate: "error",
        claimMonth: "error",
        insuranceInsurerNumber: "error",
        insuranceInsuredSymbol: "warning",
        insuranceInsuredNumber: "warning",
        publicInsurancePayerNumber: "error",
        publicInsuranceRecipientNumber: "error",
        lineCode: "warning",
        linePoints: "warning",
        lineOrderType: "warning",
        commentText: "error",
        commentCode: "warning",
        commentShinryoIdentification: "warning",
        symptomDetailText: "error",
        symptomDetailKubun: "warning"
      },
      annotationDefaults: {
        commentShinryoIdentification: "",
        symptomDetailKubun: ""
      }
    }
  };
}

function receiptPolicyForDraft(draft = {}, facilityId = "default") {
  const defaults = defaultSettingsForFacility(facilityId).receiptPolicy;
  const current = draft.receiptPolicy || {};
  return {
    ...defaults,
    ...current,
    validationSeverity: {
      ...(defaults.validationSeverity || {}),
      ...(current.validationSeverity || {})
    },
    annotationDefaults: {
      ...(defaults.annotationDefaults || {}),
      ...(current.annotationDefaults || {})
    }
  };
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

// toUserFacingErrorMessage は @halunasu/web-ui に一本化(ステップ1)。

function facilityAdminUrl() {
  if (typeof window !== "undefined" && window.location.hostname.includes(".stg.")) {
    return "https://admin.stg.halunasu.com/";
  }
  return "https://admin.halunasu.com/";
}
