"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePlatformAuth } from "./platform-auth";

const ADMIN_SECTIONS = [
  {
    id: "organizations",
    group: "病院データ",
    label: "病院",
    title: "病院一覧",
    description: "病院コードと表示名を管理します。",
    icon: "settings",
    visible: (session) => hasGlobalRole(session, "platform_admin")
  },
  {
    id: "members",
    group: "病院データ",
    label: "職員",
    title: "職員一覧",
    description: "ログイン情報、全体権限、アプリごとの権限を管理します。",
    icon: "settings",
    visible: canManageOrg
  },
  {
    id: "facilities",
    group: "病院データ",
    label: "施設",
    title: "施設一覧",
    description: "医療機関コードや厚生局情報を管理します。",
    icon: "fileText",
    visible: () => true
  },
  {
    id: "departments",
    group: "病院データ",
    label: "診療科",
    title: "診療科一覧",
    description: "施設ごとの診療科を管理します。",
    icon: "layoutSplit",
    visible: () => true
  },
  {
    id: "patients",
    group: "病院データ",
    label: "患者",
    title: "患者一覧",
    description: "各アプリから参照する患者名簿を管理します。",
    icon: "fileText",
    visible: () => true
  },
  {
    id: "entitlements",
    group: "運用",
    label: "アプリ利用設定",
    title: "アプリ利用設定",
    description: "利用状態を確認します。契約状態の変更は決済処理またはシステム処理で反映されます。",
    icon: "checkCircle",
    visible: canManageBilling
  },
  {
    id: "data-requests",
    group: "運用",
    label: "個人情報の依頼",
    title: "個人情報の依頼",
    description: "患者情報の確認、出力、訂正、削除の依頼を管理します。",
    icon: "fileText",
    visible: canManageOrg
  },
  {
    id: "audit",
    group: "運用",
    label: "操作履歴",
    title: "操作履歴",
    description: "ログインやデータ変更の履歴を確認します。",
    icon: "alertCircle",
    visible: canManageOrg
  }
];

const ICONS = {
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  checkCircle: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  edit: (
    <>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </>
  ),
  layoutSplit: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </>
  ),
  logOut: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ),
  refreshCw: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.13.31.39.56.7.7.25.11.52.2.81.3H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  )
};

export function CoreAdminConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = usePlatformAuth();
  const requestedTab = searchParams.get("section") || "";
  const visibleSections = useMemo(
    () => ADMIN_SECTIONS.filter((section) => section.visible(auth.session)),
    [auth.session]
  );
  const activeTab = visibleSections.some((section) => section.id === requestedTab)
    ? requestedTab
    : visibleSections[0]?.id || "facilities";
  const currentSection = ADMIN_SECTIONS.find((section) => section.id === activeTab) || ADMIN_SECTIONS[0];
  const [bootstrap, setBootstrap] = useState({});
  const [loadingSection, setLoadingSection] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [message, setMessage] = useState(null);
  const [patientFilter, setPatientFilter] = useState("");
  const [auditFilter, setAuditFilter] = useState("");
  const [modal, setModal] = useState(null);

  const loadSection = useCallback(async (tab = activeTab) => {
    const orgId = auth.session?.orgId;
    if (!orgId) {
      return;
    }

    setLoadingSection(tab);
    setErrorMessage("");
    try {
      const section = coreAdminSectionForTab(tab);
      const response = await auth.api(
        `/v1/organizations/${encodeURIComponent(orgId)}/admin-bootstrap?section=${encodeURIComponent(section)}`
      );
      setBootstrap((current) => ({
        ...current,
        ...response
      }));
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "表示内容を読み込めませんでした。"));
    } finally {
      setLoadingSection("");
    }
  }, [activeTab, auth]);

  useEffect(() => {
    if (requestedTab !== activeTab) {
      router.replace(`/admin?section=${encodeURIComponent(activeTab)}`);
    }
  }, [activeTab, requestedTab, router]);

  useEffect(() => {
    loadSection(activeTab);
  }, [activeTab, loadSection]);

  function selectTab(tabId) {
    router.push(`/admin?section=${encodeURIComponent(tabId)}`);
  }

  async function refreshCurrentView() {
    setMessage(null);
    await loadSection(activeTab);
  }

  async function createItem(type, formData) {
    const config = createPayload(type, formData, {
      facilities: bootstrap.facilities || [],
      orgId: auth.session?.orgId,
      patients: bootstrap.patients || []
    });
    if (!config) {
      return;
    }
    await mutate(config.path, "POST", config.body, `${editableTypeLabel(type)}を追加しました。`);
    setModal(null);
    await loadSection(activeTab);
  }

  async function updateItem(type, id, formData) {
    const config = editPayload(type, formData);
    if (!config || !auth.session?.orgId) {
      return;
    }
    await mutate(
      `/v1/organizations/${encodeURIComponent(auth.session.orgId)}/${config.collection}/${encodeURIComponent(id)}`,
      "PATCH",
      config.body,
      `${editableTypeLabel(type)}を更新しました。`
    );
    setModal(null);
    await loadSection(activeTab);
  }

  async function mutate(path, method, body, successText) {
    setMessage(null);
    setErrorMessage("");
    try {
      await auth.api(path, { method, csrf: true, body });
      setMessage({ type: "success", text: successText });
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "保存できませんでした。") });
      throw error;
    }
  }

  async function resetMfa(memberId) {
    if (!auth.session?.orgId || !window.confirm("この職員の2段階認証登録をリセットしますか？")) {
      return;
    }
    setMessage(null);
    try {
      await auth.api(`/v1/organizations/${encodeURIComponent(auth.session.orgId)}/members/${encodeURIComponent(memberId)}/mfa-reset`, {
        method: "POST",
        csrf: true,
        body: {}
      });
      setMessage({ type: "success", text: "2段階認証登録をリセットしました。" });
      await loadSection("members");
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "2段階認証登録をリセットできませんでした。") });
    }
  }

  async function completeDataRequest(requestId) {
    if (!auth.session?.orgId) {
      return;
    }
    setMessage(null);
    try {
      await auth.api(`/v1/organizations/${encodeURIComponent(auth.session.orgId)}/data-requests/${encodeURIComponent(requestId)}`, {
        method: "PATCH",
        csrf: true,
        body: {
          status: "completed",
          completedAt: new Date().toISOString()
        }
      });
      setMessage({ type: "success", text: "依頼を更新しました。" });
      await loadSection("data-requests");
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "依頼を更新できませんでした。") });
    }
  }

  function openCreateModal(type) {
    setModal({ mode: "create", type });
  }

  function openEditModal(type, item) {
    setModal({ mode: "edit", type, item });
  }

  const isLoading = loadingSection === activeTab;

  return (
    <div className="app">
      <Topbar
        auth={auth}
        onRefresh={refreshCurrentView}
      />
      <main className="main">
        <Sidebar
          activeTab={activeTab}
          onSelect={selectTab}
          sections={visibleSections}
        />
        <section className="workspace">
          {message ? <div className={`message ${message.type}`} role="status">{message.text}</div> : <div className="message" />}
          <section className="view active" role="tabpanel" aria-labelledby={`view-title-${activeTab}`}>
            <ViewHeader
              activeTab={activeTab}
              auditFilter={auditFilter}
              canManageOrg={canManageOrg(auth.session)}
              canManagePlatform={hasGlobalRole(auth.session, "platform_admin")}
              currentSection={currentSection}
              onAuditFilter={setAuditFilter}
              onCreate={openCreateModal}
              onPatientFilter={setPatientFilter}
              patientFilter={patientFilter}
            />
            <div className="table-panel">
              {errorMessage ? <div className="empty-state error-state" role="status">{errorMessage}</div> : null}
              {isLoading ? (
                <div className="loading-state">読み込み中</div>
              ) : (
                renderSection(activeTab, {
                  auth,
                  auditFilter,
                  bootstrap,
                  completeDataRequest,
                  openEditModal,
                  patientFilter,
                  resetMfa
                })
              )}
            </div>
          </section>
        </section>
      </main>
      {modal ? (
        <EditModal
          bootstrap={bootstrap}
          modal={modal}
          onClose={() => setModal(null)}
          onCreate={createItem}
          onUpdate={updateItem}
        />
      ) : null}
    </div>
  );
}

function Topbar({ auth, onRefresh }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionLabel = `${auth.session?.organizationCode || "-"} / ${auth.session?.loginId || "-"}`;
  const roleText = labelsForList((auth.session?.globalRoles || []).map(roleLabel)) || "なし";

  return (
    <header className="topbar">
      <div className="brand">
        <img alt="ハルナス" className="brand-mark" height="36" src="/brand/harunas-mark.png" width="36" />
        <div>施設管理画面</div>
      </div>
      <div className="topbar-main">
        <div className="topbar-actions">
          <button className="secondary icon-only" onClick={onRefresh} type="button" aria-label="再読み込み">
            <Icon name="refreshCw" />
          </button>
          <button
            className="session-chip-button"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
            aria-expanded={menuOpen}
            aria-controls="session-menu"
          >
            <Icon name="settings" />
            <span className="session-chip">{sessionLabel}</span>
          </button>
          <div className="session-menu" id="session-menu" hidden={!menuOpen}>
            <p className="session-menu-title">{sessionLabel}</p>
            <p className="session-menu-meta">権限: {roleText}</p>
            <button className="danger" onClick={auth.logout} type="button">
              <Icon name="logOut" />
              ログアウト
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

function Sidebar({ activeTab, onSelect, sections }) {
  const groups = ["病院データ", "運用"]
    .map((group) => ({
      group,
      sections: sections.filter((section) => section.group === group)
    }))
    .filter((entry) => entry.sections.length);

  return (
    <aside className="sidebar" aria-label="施設管理ナビゲーション">
      <nav className="side-nav">
        {groups.map(({ group, sections: groupSections }) => (
          <div className="nav-group" key={group}>
            <div className="nav-group-label">{group}</div>
            {groupSections.map((section) => (
              <button
                aria-selected={activeTab === section.id}
                className={`tab ${activeTab === section.id ? "active" : ""}`}
                key={section.id}
                onClick={() => onSelect(section.id)}
                role="tab"
                type="button"
              >
                <Icon name={section.icon} />
                {section.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function ViewHeader({
  activeTab,
  auditFilter,
  canManageOrg: canCreateOrgData,
  canManagePlatform,
  currentSection,
  onAuditFilter,
  onCreate,
  onPatientFilter,
  patientFilter
}) {
  return (
    <div className="view-head">
      <div className="view-title">
        <h1 id={`view-title-${activeTab}`}>{currentSection.title}</h1>
        <p>{currentSection.description}</p>
      </div>
      <div className="view-actions">
        {activeTab === "patients" ? (
          <input
            className="table-search"
            placeholder="患者名・患者番号で検索"
            type="search"
            value={patientFilter}
            onChange={(event) => onPatientFilter(event.target.value)}
          />
        ) : null}
        {activeTab === "audit" ? (
          <input
            className="table-search"
            placeholder="種別・操作者で検索"
            type="search"
            value={auditFilter}
            onChange={(event) => onAuditFilter(event.target.value)}
          />
        ) : null}
        {activeTab === "organizations" && canManagePlatform ? (
          <button className="accent" onClick={() => onCreate("organization")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
        {activeTab === "members" && canCreateOrgData ? (
          <button className="accent" onClick={() => onCreate("member")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
        {activeTab === "facilities" && canCreateOrgData ? (
          <button className="accent" onClick={() => onCreate("facility")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
        {activeTab === "departments" && canCreateOrgData ? (
          <button className="accent" onClick={() => onCreate("department")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
        {activeTab === "patients" && canCreateOrgData ? (
          <button className="accent" onClick={() => onCreate("patient")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
        {activeTab === "data-requests" && canCreateOrgData ? (
          <button className="accent" onClick={() => onCreate("dataRequest")} type="button">
            <Icon name="check" />
            新規
          </button>
        ) : null}
      </div>
    </div>
  );
}

function renderSection(activeTab, context) {
  const { auth, auditFilter, bootstrap, completeDataRequest, openEditModal, patientFilter, resetMfa } = context;

  if (["members", "data-requests", "audit"].includes(activeTab) && !canManageOrg(auth.session)) {
    return <div className="empty-state">このページを表示する権限がありません。病院管理者に依頼してください。</div>;
  }
  if (activeTab === "entitlements" && !canManageBilling(auth.session)) {
    return <div className="empty-state">アプリ利用設定を見る権限がありません。契約管理者に依頼してください。</div>;
  }

  if (activeTab === "organizations") {
    return (
      <DataTable
        empty="病院はまだ登録されていません。"
        rows={bootstrap.organizations || []}
        columns={[
          ["病院コード", (item) => item.organizationCode],
          ["表示名", (item) => item.displayName],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="管理用IDをコピー" value={item.orgId} />
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "members") {
    return (
      <DataTable
        empty="職員はまだ登録されていません。"
        rows={bootstrap.members || []}
        columns={[
          ["個人ID", (item) => item.loginId],
          ["表示名", (item) => item.displayName],
          ["全体権限", (item) => labelsForList((item.globalRoles || []).map(roleLabel)) || "なし"],
          ["アプリごとの権限", (item) => productRolesLabel(item.productRoles)],
          ["2段階認証", (item) => <StatusBadge value={item.mfaEnrolled ? "enrolled" : item.mfaRequired ? "required" : ""} />],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="管理用IDをコピー" value={item.memberId || item.loginId} />
              <button className="secondary" onClick={() => resetMfa(item.memberId || item.loginId)} type="button">
                <Icon name="refreshCw" />
                2段階認証リセット
              </button>
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "facilities") {
    return (
      <DataTable
        empty="施設はまだ登録されていません。"
        rows={bootstrap.facilities || []}
        columns={[
          ["施設名", (item) => item.displayName],
          ["医療機関コード", (item) => item.medicalInstitutionCode || "-"],
          ["厚生局", (item) => item.regionalBureau || "-"],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="施設IDをコピー" value={item.facilityId} />
              {canManageOrg(auth.session) ? (
                <button className="secondary" onClick={() => openEditModal("facility", item)} type="button">
                  <Icon name="edit" />
                  編集
                </button>
              ) : null}
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "departments") {
    return (
      <DataTable
        empty="診療科はまだ登録されていません。"
        rows={bootstrap.departments || []}
        columns={[
          ["診療科名", (item) => item.displayName],
          ["施設", (item) => facilityName(item.facilityId, bootstrap.facilities)],
          ["コード", (item) => item.code || "-"],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="診療科IDをコピー" value={item.departmentId} />
              {canManageOrg(auth.session) ? (
                <button className="secondary" onClick={() => openEditModal("department", item)} type="button">
                  <Icon name="edit" />
                  編集
                </button>
              ) : null}
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "patients") {
    const keyword = normalizeSearch(patientFilter);
    const rows = keyword
      ? (bootstrap.patients || []).filter((patient) => normalizeSearch([
        patient.displayName,
        patient.displayNameKana,
        patient.patientId,
        patient.primaryPatientNumber
      ].join(" ")).includes(keyword))
      : (bootstrap.patients || []);
    return (
      <DataTable
        empty={keyword ? "条件に一致する患者はいません。" : "患者はまだ登録されていません。"}
        rows={rows.slice(0, 100)}
        columns={[
          ["患者番号", (item) => item.primaryPatientNumber || "-"],
          ["氏名", (item) => item.displayName],
          ["生年月日", (item) => item.birthDate || "-"],
          ["性別", (item) => sexLabel(item.sex)],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="患者IDをコピー" value={item.patientId} />
              {canManageOrg(auth.session) ? (
                <button className="secondary" onClick={() => openEditModal("patient", item)} type="button">
                  <Icon name="edit" />
                  編集
                </button>
              ) : null}
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "entitlements") {
    return (
      <DataTable
        empty="アプリ利用設定はまだ登録されていません。"
        rows={bootstrap.productEntitlements || []}
        columns={[
          ["アプリ", (item) => productLabel(item.productId)],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["料金プラン", (item) => item.plan || "-"],
          ["開始日", (item) => formatDateTime(item.startsAt)],
          ["終了日", (item) => formatDateTime(item.endsAt)]
        ]}
      />
    );
  }

  if (activeTab === "data-requests") {
    return (
      <DataTable
        empty="個人情報の依頼はまだ登録されていません。"
        rows={bootstrap.dataRequests || []}
        columns={[
          ["依頼内容", (item) => requestTypeLabel(item.requestType)],
          ["対象患者", (item) => patientName(item.subjectPatientId, bootstrap.patients)],
          ["対象アプリ", (item) => labelsForList((item.productIds || []).map(productLabel)) || "-"],
          ["状態", (item) => <StatusBadge value={item.status} />],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="依頼IDをコピー" value={item.requestId} />
              {item.status !== "completed" ? (
                <button className="secondary" onClick={() => completeDataRequest(item.requestId)} type="button">
                  <Icon name="check" />
                  完了
                </button>
              ) : null}
            </div>
          )]
        ]}
      />
    );
  }

  if (activeTab === "audit") {
    const keyword = normalizeSearch(auditFilter);
    const rows = keyword
      ? (bootstrap.auditEvents || []).filter((event) => normalizeSearch([
        event.eventType,
        event.actorLoginId,
        event.targetType,
        event.targetId,
        event.createdAt
      ].join(" ")).includes(keyword))
      : (bootstrap.auditEvents || []);
    return (
      <DataTable
        empty={keyword ? "条件に一致する操作履歴はありません。" : "操作履歴はまだありません。"}
        rows={rows.slice(0, 100)}
        columns={[
          ["日時", (item) => formatDateTime(item.createdAt)],
          ["イベント", (item) => eventTypeLabel(item.eventType)],
          ["操作者", (item) => item.actorLoginId || "-"],
          ["対象", (item) => [targetTypeLabel(item.targetType), item.targetId].filter(Boolean).join(" / ") || "-"],
          ["", (item) => (
            <div className="row-actions">
              <CopyButton ariaLabel="イベントIDをコピー" value={item.eventId || JSON.stringify(item)} />
            </div>
          )]
        ]}
      />
    );
  }

  return <div className="empty-state">表示できるデータがありません。</div>;
}

function DataTable({ columns, empty, rows }) {
  if (!rows.length) {
    return <div className="empty-state">{empty}</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map(([label], index) => <th key={label || `action-${index}`}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.orgId || row.memberId || row.facilityId || row.departmentId || row.patientId || row.entitlementId || row.productId || row.requestId || row.eventId || rowIndex}>
              {columns.map(([label, getter], columnIndex) => (
                <td key={label || `action-${columnIndex}`}>{cellValue(getter(row))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellValue(value) {
  if (value === undefined || value === null || value === "") {
    return <span>-</span>;
  }
  return value;
}

function StatusBadge({ value }) {
  const raw = String(value || "");
  if (!raw) {
    return <span>-</span>;
  }
  return <span className={`status ${statusTone(raw)}`}>{uiLabel(raw)}</span>;
}

function CopyButton({ ariaLabel, value }) {
  async function copy() {
    if (!value) {
      return;
    }
    await navigator.clipboard?.writeText(String(value)).catch(() => null);
  }
  return (
    <button className="secondary icon-only" onClick={copy} type="button" aria-label={ariaLabel || "コピー"}>
      <Icon name="copy" />
    </button>
  );
}

function EditModal({ bootstrap, modal, onClose, onCreate, onUpdate }) {
  const meta = modalMeta(modal.type, modal.mode);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setSubmitting(true);
    setErrorMessage("");
    try {
      if (modal.mode === "create") {
        await onCreate(modal.type, formData);
      } else {
        await onUpdate(modal.type, itemIdForType(modal.type, modal.item), formData);
      }
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, "保存できませんでした。"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="admin-modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
        <button className="modal-close-button" onClick={onClose} type="button" aria-label="閉じる">
          <Icon name="x" />
        </button>
        <div className="admin-modal-head">
          <h2 id="edit-modal-title">{meta.title}</h2>
          <p>{meta.description}</p>
        </div>
        {errorMessage ? <div className="empty-state error-state" role="status">{errorMessage}</div> : null}
        <form className="admin-modal-form" onSubmit={handleSubmit}>
          <FormFields bootstrap={bootstrap} item={modal.item || {}} mode={modal.mode} type={modal.type} />
          <div className="admin-modal-footer">
            <button className="secondary" disabled={submitting} onClick={onClose} type="button">キャンセル</button>
            <button className="accent" disabled={submitting} type="submit">{modal.mode === "create" ? "作成" : "保存"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function FormFields({ bootstrap, item, mode, type }) {
  if (type === "organization") {
    return (
      <>
        <TextField label="病院コード" name="organizationCode" required value={item.organizationCode} />
        <TextField label="表示名" name="displayName" required value={item.displayName} />
      </>
    );
  }

  if (type === "member") {
    return (
      <>
        <div className="grid-2">
          <TextField label="個人ID" name="loginId" required value={item.loginId} />
          <TextField label="表示名" name="displayName" required value={item.displayName} />
        </div>
        <div className="grid-2">
          <TextField label="メールアドレス" name="email" type="email" value={item.email} />
          <TextField label="初期ログイン用パスワード" name="password" type="password" />
        </div>
        <TextField label="全体権限" name="globalRoles" placeholder="org_admin,billing_admin,platform_admin" value={csvValue(item.globalRoles)} />
        <div className="grid-3">
          <TextField label="カルテ作成の権限" name="chartingRoles" placeholder="admin,doctor" value={csvValue(item.productRoles?.charting)} />
          <TextField label="診療報酬算定の権限" name="feeRoles" placeholder="admin,medical_clerk" value={csvValue(item.productRoles?.fee)} />
          <TextField label="紹介状作成の権限" name="referralRoles" placeholder="admin,doctor" value={csvValue(item.productRoles?.referral)} />
        </div>
      </>
    );
  }

  if (type === "facility") {
    return (
      <>
        {mode === "edit" ? <ReadonlyField label="管理用ID" value={item.facilityId} /> : null}
        <TextField label="表示名" name="displayName" required value={item.displayName} />
        <div className="grid-2">
          <TextField label="医療機関コード" name="medicalInstitutionCode" value={item.medicalInstitutionCode} />
          <TextField label="厚生局" name="regionalBureau" value={item.regionalBureau} />
        </div>
        <div className="grid-2">
          <TextField label="都道府県" name="prefecture" value={item.prefecture} />
          {mode === "edit" ? (
            <SelectField label="状態" name="status" value={item.status || "active"} options={[
              ["active", "有効"],
              ["inactive", "無効"]
            ]} />
          ) : null}
        </div>
      </>
    );
  }

  if (type === "department") {
    const facilityOptions = [
      ["", "施設を指定しない"],
      ...(bootstrap.facilities || []).map((facility) => [facility.facilityId, facility.displayName || facility.facilityId])
    ];
    return (
      <>
        {mode === "edit" ? <ReadonlyField label="管理用ID" value={item.departmentId} /> : null}
        <TextField label="表示名" name="displayName" required value={item.displayName} />
        <div className="grid-2">
          <SelectField label="施設" name="facilityId" value={item.facilityId || ""} options={facilityOptions} />
          <TextField label="コード" name="code" value={item.code} />
        </div>
        <div className="grid-2">
          <TextField label="専門領域" name="specialty" value={item.specialty} />
          {mode === "edit" ? (
            <SelectField label="状態" name="status" value={item.status || "active"} options={[
              ["active", "有効"],
              ["inactive", "無効"]
            ]} />
          ) : null}
        </div>
      </>
    );
  }

  if (type === "patient") {
    return (
      <>
        {mode === "edit" ? <ReadonlyField label="管理用ID" value={item.patientId} /> : null}
        <div className="grid-2">
          <TextField label="表示名" name="displayName" required value={item.displayName} />
          <TextField label="かな" name="displayNameKana" value={item.displayNameKana} />
        </div>
        <div className="grid-2">
          <TextField label="患者番号" name="primaryPatientNumber" value={item.primaryPatientNumber} />
          <TextField label="生年月日" name="birthDate" type="date" value={item.birthDate} />
        </div>
        <div className="grid-2">
          <SelectField label="性別" name="sex" value={item.sex || "unknown"} options={[
            ["unknown", "不明"],
            ["male", "男性"],
            ["female", "女性"],
            ["other", "その他"]
          ]} />
          <SelectField label="状態" name="status" value={item.status || "active"} options={[
            ["active", "有効"],
            ["inactive", "無効"],
            ["merged", "統合済み"]
          ]} />
        </div>
        <label className="field">
          <span>メモ</span>
          <textarea name="notes" rows={4} defaultValue={item.notes || ""} />
        </label>
      </>
    );
  }

  if (type === "dataRequest") {
    const patientOptions = [
      ["", "患者を指定しない"],
      ...(bootstrap.patients || []).map((patient) => [patient.patientId, patient.displayName || patient.primaryPatientNumber || patient.patientId])
    ];
    return (
      <>
        <div className="grid-2">
          <SelectField label="依頼内容" name="requestType" value="access" options={[
            ["access", "閲覧"],
            ["export", "エクスポート"],
            ["deletion", "削除"],
            ["correction", "訂正"]
          ]} />
          <SelectField label="対象患者" name="subjectPatientId" value="" options={patientOptions} />
        </div>
        <TextField label="対象アプリ" name="productIds" placeholder="charting,fee,referral" value="charting" />
      </>
    );
  }

  return null;
}

function TextField({ label, name, placeholder = "", required = false, type = "text", value = "" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} placeholder={placeholder} required={required} type={type} defaultValue={value || ""} />
    </label>
  );
}

function SelectField({ label, name, options, value = "" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value || ""}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function ReadonlyField({ label, value }) {
  return (
    <div className="readonly-field">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function Icon({ name }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">{ICONS[name] || ICONS.fileText}</svg>
    </span>
  );
}

function createPayload(type, data, context) {
  const orgId = context.orgId;
  if (type === "organization") {
    return {
      path: "/v1/organizations",
      body: {
        organizationCode: data.get("organizationCode"),
        displayName: data.get("displayName")
      }
    };
  }

  if (type === "member") {
    return {
      path: `/v1/organizations/${encodeURIComponent(orgId)}/members`,
      body: {
        loginId: data.get("loginId"),
        displayName: data.get("displayName"),
        email: emptyToNull(data.get("email")),
        password: emptyToNull(data.get("password")),
        globalRoles: csv(data.get("globalRoles")),
        productRoles: {
          charting: csv(data.get("chartingRoles")),
          fee: csv(data.get("feeRoles")),
          referral: csv(data.get("referralRoles"))
        }
      }
    };
  }

  if (type === "facility") {
    return {
      path: `/v1/organizations/${encodeURIComponent(orgId)}/facilities`,
      body: {
        displayName: data.get("displayName"),
        medicalInstitutionCode: emptyToNull(data.get("medicalInstitutionCode")),
        regionalBureau: emptyToNull(data.get("regionalBureau")),
        prefecture: emptyToNull(data.get("prefecture"))
      }
    };
  }

  if (type === "department") {
    return {
      path: `/v1/organizations/${encodeURIComponent(orgId)}/departments`,
      body: {
        displayName: data.get("displayName"),
        facilityId: emptyToNull(data.get("facilityId")),
        code: emptyToNull(data.get("code")),
        specialty: emptyToNull(data.get("specialty"))
      }
    };
  }

  if (type === "patient") {
    return {
      path: `/v1/organizations/${encodeURIComponent(orgId)}/patients`,
      body: {
        displayName: data.get("displayName"),
        displayNameKana: emptyToNull(data.get("displayNameKana")),
        primaryPatientNumber: emptyToNull(data.get("primaryPatientNumber")),
        birthDate: emptyToNull(data.get("birthDate")),
        sex: data.get("sex"),
        status: data.get("status"),
        notes: emptyToNull(data.get("notes"))
      }
    };
  }

  if (type === "dataRequest") {
    return {
      path: `/v1/organizations/${encodeURIComponent(orgId)}/data-requests`,
      body: {
        requestType: data.get("requestType"),
        subjectPatientId: emptyToNull(data.get("subjectPatientId")),
        productIds: csv(data.get("productIds"))
      }
    };
  }

  return null;
}

function editPayload(type, data) {
  if (type === "facility") {
    return {
      collection: "facilities",
      body: {
        displayName: data.get("displayName"),
        medicalInstitutionCode: emptyToNull(data.get("medicalInstitutionCode")),
        regionalBureau: emptyToNull(data.get("regionalBureau")),
        prefecture: emptyToNull(data.get("prefecture")),
        status: data.get("status")
      }
    };
  }

  if (type === "department") {
    return {
      collection: "departments",
      body: {
        displayName: data.get("displayName"),
        facilityId: emptyToNull(data.get("facilityId")),
        code: emptyToNull(data.get("code")),
        specialty: emptyToNull(data.get("specialty")),
        status: data.get("status")
      }
    };
  }

  if (type === "patient") {
    return {
      collection: "patients",
      body: {
        displayName: data.get("displayName"),
        displayNameKana: emptyToNull(data.get("displayNameKana")),
        primaryPatientNumber: emptyToNull(data.get("primaryPatientNumber")),
        birthDate: emptyToNull(data.get("birthDate")),
        sex: data.get("sex"),
        status: data.get("status"),
        notes: emptyToNull(data.get("notes"))
      }
    };
  }

  return null;
}

function coreAdminSectionForTab(tab) {
  return ({
    organizations: "organizations",
    members: "members",
    facilities: "facilities",
    departments: "departments",
    patients: "patients",
    entitlements: "entitlements",
    "data-requests": "data-requests",
    audit: "audit"
  })[tab] || "organizations";
}

function modalMeta(type, mode) {
  const action = mode === "create" ? "追加" : "編集";
  return ({
    organization: {
      title: `病院を${action}`,
      description: "病院コードと表示名を登録します。"
    },
    member: {
      title: `職員を${action}`,
      description: "ログイン情報、全体権限、アプリごとの権限を登録します。"
    },
    facility: {
      title: `施設を${action}`,
      description: "病院内で共通利用する施設情報を登録します。"
    },
    department: {
      title: `診療科を${action}`,
      description: "カルテ作成や診療報酬算定で参照する診療科情報を登録します。"
    },
    patient: {
      title: `患者を${action}`,
      description: "各アプリで参照する患者名簿を登録します。"
    },
    dataRequest: {
      title: `個人情報の依頼を${action}`,
      description: "個人情報の閲覧、出力、訂正、削除に関する依頼を登録します。"
    }
  })[type] || {
    title: mode === "create" ? "新規作成" : "編集",
    description: "病院共通データを更新します。"
  };
}

function itemIdForType(type, item = {}) {
  return ({
    facility: item.facilityId,
    department: item.departmentId,
    patient: item.patientId
  })[type] || "";
}

function editableTypeLabel(type) {
  return ({
    organization: "病院",
    member: "職員",
    facility: "施設",
    department: "診療科",
    patient: "患者情報",
    dataRequest: "個人情報の依頼"
  })[type] || "データ";
}

function labelsForList(values) {
  return Array.isArray(values) && values.length ? values.join("、") : "";
}

function productRolesLabel(productRoles = {}) {
  const entries = Object.entries(productRoles || {})
    .filter(([, roles]) => Array.isArray(roles) && roles.length)
    .map(([productId, roles]) => `${productLabel(productId)}: ${labelsForList(roles.map(roleLabel))}`);
  return entries.length ? entries.join(" / ") : "なし";
}

function productLabel(value) {
  return ({
    charting: "カルテ作成",
    fee: "診療報酬算定",
    referral: "紹介状作成"
  })[value] || value || "-";
}

function requestTypeLabel(value) {
  return ({
    access: "閲覧",
    export: "エクスポート",
    deletion: "削除",
    correction: "訂正"
  })[value] || value || "-";
}

function uiLabel(value) {
  return ({
    active: "有効",
    inactive: "停止中",
    enabled: "有効",
    disabled: "停止中",
    trialing: "トライアル中",
    submitted: "受付済み",
    reviewing: "確認中",
    completed: "完了",
    rejected: "却下",
    cancelled: "キャンセル",
    canceled: "解約済み",
    suspended: "停止中",
    provisioned: "準備完了",
    enrolled: "登録済み",
    required: "登録が必要",
    pending_checkout: "決済待ち",
    past_due: "支払い確認中",
    grace_period: "猶予期間",
    unpaid: "未払い",
    unknown: "不明",
    male: "男性",
    female: "女性",
    other: "その他",
    access: "閲覧",
    export: "エクスポート",
    deletion: "削除",
    correction: "訂正"
  })[value] || value || "-";
}

function statusTone(value) {
  const text = String(value || "");
  if (["enabled", "active", "completed", "provisioned", "enrolled"].includes(text)) {
    return "good";
  }
  if (["trialing", "submitted", "reviewing", "required", "pending_checkout", "past_due", "grace_period"].includes(text)) {
    return "warn";
  }
  if (["disabled", "rejected", "cancelled", "canceled", "suspended", "inactive", "unpaid"].includes(text)) {
    return "bad";
  }
  return "";
}

function roleLabel(value) {
  return ({
    org_admin: "病院管理者",
    org_owner: "病院オーナー",
    billing_admin: "契約管理",
    platform_admin: "全体管理",
    it_admin: "IT管理",
    admin: "管理者",
    doctor: "医師",
    medical_clerk: "医療事務",
    viewer: "閲覧",
    editor: "編集"
  })[value] || value;
}

function sexLabel(value) {
  return uiLabel(value);
}

function facilityName(facilityId, facilities = []) {
  return facilities.find((facility) => facility.facilityId === facilityId)?.displayName || facilityId || "-";
}

function patientName(patientId, patients = []) {
  return patients.find((patient) => patient.patientId === patientId)?.displayName || patientId || "-";
}

function eventTypeLabel(value) {
  return ({
    "auth.login_succeeded": "ログイン成功",
    "auth.login_failed": "ログイン失敗",
    "auth.logout": "ログアウト",
    "auth.mfa_verified": "2段階認証登録",
    "auth.mfa_enrollment_started": "2段階認証登録開始",
    "member.created": "職員作成",
    "member.updated": "職員更新",
    "member.mfa_reset": "2段階認証リセット",
    "organization.created": "病院作成",
    "organization.updated": "病院更新",
    "facility.created": "施設作成",
    "facility.updated": "施設更新",
    "department.created": "診療科作成",
    "department.updated": "診療科更新",
    "patient.created": "患者作成",
    "patient.updated": "患者更新",
    "product_entitlement.upserted": "アプリ利用設定保存",
    "product_entitlement.updated": "アプリ利用設定更新",
    "data_request.created": "個人情報の依頼作成",
    "data_request.updated": "個人情報の依頼更新"
  })[value] || value || "-";
}

function targetTypeLabel(value) {
  return ({
    organization: "病院",
    member: "職員",
    facility: "施設",
    department: "診療科",
    patient: "患者",
    product_entitlement: "アプリ利用設定",
    data_request: "個人情報の依頼"
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

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function csvValue(value) {
  return Array.isArray(value) ? value.join(",") : "";
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function hasGlobalRole(session, role) {
  return Boolean(session?.globalRoles?.includes(role));
}

function canManageOrg(session) {
  return (
    hasGlobalRole(session, "platform_admin") ||
    hasGlobalRole(session, "org_owner") ||
    hasGlobalRole(session, "org_admin")
  );
}

function canManageBilling(session) {
  return (
    hasGlobalRole(session, "platform_admin") ||
    hasGlobalRole(session, "org_owner") ||
    hasGlobalRole(session, "org_admin") ||
    hasGlobalRole(session, "billing_admin")
  );
}

function toUserFacingErrorMessage(error, fallbackMessage) {
  const rawMessage = typeof error === "string" ? error : error?.message;
  const status = typeof error === "object" && error ? Number(error.status || error.statusCode || 0) : 0;
  const text = String(rawMessage || "").trim();
  const lower = text.toLowerCase();
  if (lower.includes("csrf")) return "画面を再読み込みして、もう一度お試しください。";
  if (lower.includes("invalid session") || lower.includes("session expired") || lower.includes("session revoked") || lower === "unauthorized") return "ログイン状態を確認できません。もう一度ログインしてください。";
  if (lower.includes("role is required") || lower.includes("access is required") || lower === "forbidden" || status === 403) return "この操作を行う権限がありません。";
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower === "load failed") return "通信に失敗しました。接続を確認して、もう一度お試しください。";
  if (status >= 500) return "処理中に問題が発生しました。時間を置いてもう一度お試しください。";
  return /[ぁ-んァ-ヶ一-龠]/u.test(text) ? text : fallbackMessage;
}
