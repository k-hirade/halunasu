"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAdminNav } from "./admin-nav-context";
import { usePlatformAuth } from "./platform-auth";

const ADMIN_SECTIONS = [
  {
    id: "members",
    group: "病院データ",
    label: "職員",
    description: "ログイン情報、全体権限、アプリごとの権限を管理します。"
  },
  {
    id: "facilities",
    group: "病院データ",
    label: "施設",
    description: "医療機関コードや厚生局情報を管理します。"
  },
  {
    id: "departments",
    group: "病院データ",
    label: "診療科",
    description: "施設ごとの診療科を管理します。"
  },
  {
    id: "patients",
    group: "病院データ",
    label: "患者",
    description: "各アプリで使う患者情報を管理します。"
  },
  {
    id: "entitlements",
    group: "運用",
    label: "アプリ利用設定",
    description: "契約中アプリと利用状態を管理します。"
  },
  {
    id: "data-requests",
    group: "運用",
    label: "個人情報の依頼",
    description: "個人情報に関する依頼を管理します。"
  },
  {
    id: "audit",
    group: "運用",
    label: "操作ログ",
    description: "ログインやデータ変更の履歴を確認します。"
  },
  {
    id: "account",
    group: "運用",
    label: "アカウント",
    description: "ログイン中の職員情報と権限を確認します。"
  }
];

export function CoreAdminConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = usePlatformAuth();
  const activeTab = searchParams.get("section") || "home";
  const { registerAdminNav, clearAdminNav } = useAdminNav();
  const currentSection = ADMIN_SECTIONS.find((section) => section.id === activeTab) || null;
  const [bootstrap, setBootstrap] = useState({});
  const [loadingSection, setLoadingSection] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [message, setMessage] = useState(null);
  const [patientFilter, setPatientFilter] = useState("");
  const [auditFilter, setAuditFilter] = useState("");
  const [modal, setModal] = useState(null);

  const navSections = useMemo(() => ADMIN_SECTIONS.map((section) => ({
    ...section,
    href: `/admin?section=${encodeURIComponent(section.id)}`
  })), []);

  const loadSection = useCallback(async (tab = activeTab) => {
    if (tab === "home" || tab === "account") {
      return;
    }

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

  useEffect(() => {
    loadSection(activeTab);
  }, [activeTab, loadSection]);

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
    if (!auth.session?.orgId || !window.confirm("この職員の2段階認証をリセットしますか？")) {
      return;
    }
    setMessage(null);
    try {
      await auth.api(`/v1/organizations/${encodeURIComponent(auth.session.orgId)}/members/${encodeURIComponent(memberId)}/mfa-reset`, {
        method: "POST",
        csrf: true,
        body: {}
      });
      setMessage({ type: "success", text: "2段階認証をリセットしました。" });
      await loadSection("members");
    } catch (error) {
      setMessage({ type: "error", text: toUserFacingErrorMessage(error, "2段階認証をリセットできませんでした。") });
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

  if (activeTab === "home") {
    return (
      <main className="core-admin-shell">
        <header className="core-page-head">
          <div>
            <h1>病院共通データ</h1>
            <p>各アプリで使う病院の基本情報を管理します。</p>
          </div>
        </header>
        <section className="settings-home">
          {["病院データ", "運用"].map((group) => (
            <div className="settings-home-group" key={group}>
              <h2>{group}</h2>
              <div className="settings-home-list">
                {ADMIN_SECTIONS.filter((section) => section.group === group).map((section) => (
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

  const isLoading = loadingSection === activeTab;

  return (
    <main className="core-admin-shell">
      <header className="core-page-head">
        <div>
          <h1>{currentSection?.label || "病院共通データ"}</h1>
          <p>{currentSection?.description || "病院共通データを管理します。"}</p>
        </div>
        <HeaderActions
          activeTab={activeTab}
          auditFilter={auditFilter}
          canManageBilling={canManageBilling(auth.session)}
          canManageOrg={canManageOrg(auth.session)}
          onAuditFilter={setAuditFilter}
          onCreate={openCreateModal}
          onRefresh={() => loadSection(activeTab)}
          patientFilter={patientFilter}
          onPatientFilter={setPatientFilter}
        />
      </header>
      {message ? <div className={`core-message core-message--${message.type}`} role="status">{message.text}</div> : null}
      <section className="core-card">
        {errorMessage ? <div className="core-error-state" role="status">{errorMessage}</div> : null}
        {isLoading ? <div className="core-loading-state">読み込み中</div> : renderSection(activeTab, {
          auth,
          auditFilter,
          bootstrap,
          completeDataRequest,
          openEditModal,
          patientFilter,
          resetMfa
        })}
      </section>
      {modal ? (
        <EditModal
          bootstrap={bootstrap}
          modal={modal}
          onClose={() => setModal(null)}
          onCreate={createItem}
          onUpdate={updateItem}
        />
      ) : null}
    </main>
  );
}

function HeaderActions({
  activeTab,
  auditFilter,
  canManageBilling,
  canManageOrg,
  onAuditFilter,
  onCreate,
  onPatientFilter,
  onRefresh,
  patientFilter
}) {
  if (activeTab === "account") {
    return null;
  }
  return (
    <div className="core-header-actions">
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
      <button className="btn btn--ghost" onClick={onRefresh} type="button">更新</button>
      {activeTab === "members" && canManageOrg ? <button className="btn btn--primary" onClick={() => onCreate("member")} type="button">新規</button> : null}
      {activeTab === "facilities" && canManageOrg ? <button className="btn btn--primary" onClick={() => onCreate("facility")} type="button">新規</button> : null}
      {activeTab === "departments" && canManageOrg ? <button className="btn btn--primary" onClick={() => onCreate("department")} type="button">新規</button> : null}
      {activeTab === "patients" && canManageOrg ? <button className="btn btn--primary" onClick={() => onCreate("patient")} type="button">新規</button> : null}
      {activeTab === "data-requests" && canManageOrg ? <button className="btn btn--primary" onClick={() => onCreate("dataRequest")} type="button">新規</button> : null}
      {activeTab === "entitlements" && !canManageBilling ? <span className="core-action-note">閲覧のみ</span> : null}
    </div>
  );
}

function renderSection(activeTab, context) {
  const { auth, auditFilter, bootstrap, completeDataRequest, openEditModal, patientFilter, resetMfa } = context;

  if (activeTab === "account") {
    return (
      <div className="core-placeholder account-summary">
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
            <dt>2段階認証</dt>
            <dd>{auth.session?.mfaVerified ? "確認済み" : "未確認"}</dd>
          </div>
        </dl>
        <div className="account-actions">
          <button className="btn btn--primary" onClick={auth.logout} type="button">ログアウト</button>
        </div>
      </div>
    );
  }

  if (["members", "data-requests", "audit"].includes(activeTab) && !canManageOrg(auth.session)) {
    return <div className="core-empty-state">このページを表示する権限がありません。病院管理者に依頼してください。</div>;
  }
  if (activeTab === "entitlements" && !canManageBilling(auth.session)) {
    return <div className="core-empty-state">アプリ利用設定を見る権限がありません。契約管理者に依頼してください。</div>;
  }

  if (activeTab === "members") {
    return (
      <DataTable
        empty="職員はまだ登録されていません。"
        rows={bootstrap.members || []}
        columns={[
          ["個人ID", (item) => item.loginId],
          ["表示名", (item) => item.displayName],
          ["全体権限", (item) => labelsForList(item.globalRoles) || "なし"],
          ["アプリごとの権限", (item) => productRolesLabel(item.productRoles)],
          ["2段階認証", (item) => item.mfaEnrolled ? "登録済み" : item.mfaRequired ? "登録が必要" : "-"],
          ["状態", (item) => statusLabel(item.status)],
          ["操作", (item) => (
            <div className="core-row-actions">
              <CopyButton value={item.loginId} />
              <button className="btn btn--ghost btn--sm" onClick={() => resetMfa(item.memberId || item.loginId)} type="button">2段階認証リセット</button>
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
          ["状態", (item) => statusLabel(item.status)],
          ["操作", (item) => (
            <div className="core-row-actions">
              <CopyButton value={item.facilityId} />
              {canManageOrg(auth.session) ? <button className="btn btn--ghost btn--sm" onClick={() => openEditModal("facility", item)} type="button">編集</button> : null}
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
          ["状態", (item) => statusLabel(item.status)],
          ["操作", (item) => (
            <div className="core-row-actions">
              <CopyButton value={item.departmentId} />
              {canManageOrg(auth.session) ? <button className="btn btn--ghost btn--sm" onClick={() => openEditModal("department", item)} type="button">編集</button> : null}
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
        empty="患者はまだ登録されていません。"
        rows={rows.slice(0, 100)}
        columns={[
          ["患者番号", (item) => item.primaryPatientNumber || "-"],
          ["氏名", (item) => item.displayName],
          ["生年月日", (item) => item.birthDate || "-"],
          ["性別", (item) => sexLabel(item.sex)],
          ["状態", (item) => statusLabel(item.status)],
          ["操作", (item) => (
            <div className="core-row-actions">
              <CopyButton value={item.patientId} />
              {canManageOrg(auth.session) ? <button className="btn btn--ghost btn--sm" onClick={() => openEditModal("patient", item)} type="button">編集</button> : null}
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
          ["状態", (item) => statusLabel(item.status)],
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
          ["状態", (item) => statusLabel(item.status)],
          ["操作", (item) => (
            <div className="core-row-actions">
              <CopyButton value={item.requestId} />
              {item.status !== "completed" ? <button className="btn btn--ghost btn--sm" onClick={() => completeDataRequest(item.requestId)} type="button">完了にする</button> : null}
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
        event.targetId
      ].join(" ")).includes(keyword))
      : (bootstrap.auditEvents || []);
    return (
      <DataTable
        empty="操作ログはまだありません。"
        rows={rows.slice(0, 100)}
        columns={[
          ["日時", (item) => formatDateTime(item.createdAt)],
          ["イベント", (item) => eventTypeLabel(item.eventType)],
          ["操作者", (item) => item.actorLoginId || "-"],
          ["対象", (item) => [targetTypeLabel(item.targetType), item.targetId].filter(Boolean).join(" / ") || "-"],
          ["操作", (item) => <CopyButton value={JSON.stringify(item)} />]
        ]}
      />
    );
  }

  return <div className="core-placeholder">移行中です。</div>;
}

function DataTable({ columns, empty, rows }) {
  if (!rows.length) {
    return <div className="core-empty-state">{empty}</div>;
  }

  return (
    <div className="core-table-wrap">
      <table className="core-data-table">
        <thead>
          <tr>
            {columns.map(([label]) => <th key={label}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.memberId || row.facilityId || row.departmentId || row.patientId || row.entitlementId || row.requestId || row.eventId || rowIndex}>
              {columns.map(([label, getter]) => (
                <td key={label}>{getter(row) || "-"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        <button className="modal-close-button" onClick={onClose} type="button" aria-label="閉じる">x</button>
        <div className="admin-modal-head">
          <h2 id="edit-modal-title">{meta.title}</h2>
          <p>{meta.description}</p>
        </div>
        {errorMessage ? <div className="core-error-state" role="status">{errorMessage}</div> : null}
        <form className="admin-modal-form" onSubmit={handleSubmit}>
          <FormFields bootstrap={bootstrap} item={modal.item || {}} mode={modal.mode} type={modal.type} />
          <div className="admin-modal-footer">
            <button className="btn btn--ghost" disabled={submitting} onClick={onClose} type="button">キャンセル</button>
            <button className="btn btn--primary" disabled={submitting} type="submit">{modal.mode === "create" ? "作成" : "保存"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function FormFields({ bootstrap, item, mode, type }) {
  if (type === "member") {
    return (
      <>
        <div className="core-form-grid core-form-grid--two">
          <TextField label="個人ID" name="loginId" required value={item.loginId} />
          <TextField label="表示名" name="displayName" required value={item.displayName} />
        </div>
        <div className="core-form-grid core-form-grid--two">
          <TextField label="メールアドレス" name="email" type="email" value={item.email} />
          <TextField label="初期ログイン用パスワード" name="password" type="password" />
        </div>
        <TextField label="全体権限" name="globalRoles" placeholder="org_admin,billing_admin,platform_admin" value={csvValue(item.globalRoles)} />
        <div className="core-form-grid core-form-grid--three">
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
        <div className="core-form-grid core-form-grid--two">
          <TextField label="医療機関コード" name="medicalInstitutionCode" value={item.medicalInstitutionCode} />
          <TextField label="厚生局" name="regionalBureau" value={item.regionalBureau} />
        </div>
        <div className="core-form-grid core-form-grid--two">
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
        <div className="core-form-grid core-form-grid--two">
          <SelectField label="施設" name="facilityId" value={item.facilityId || ""} options={facilityOptions} />
          <TextField label="コード" name="code" value={item.code} />
        </div>
        <div className="core-form-grid core-form-grid--two">
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
        <div className="core-form-grid core-form-grid--two">
          <TextField label="表示名" name="displayName" required value={item.displayName} />
          <TextField label="かな" name="displayNameKana" value={item.displayNameKana} />
        </div>
        <div className="core-form-grid core-form-grid--two">
          <TextField label="患者番号" name="primaryPatientNumber" value={item.primaryPatientNumber} />
          <TextField label="生年月日" name="birthDate" type="date" value={item.birthDate} />
        </div>
        <div className="core-form-grid core-form-grid--two">
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
        <label className="core-field">
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
        <div className="core-form-grid core-form-grid--two">
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
    <label className="core-field">
      <span>{label}</span>
      <input name={name} placeholder={placeholder} required={required} type={type} defaultValue={value || ""} />
    </label>
  );
}

function SelectField({ label, name, options, value = "" }) {
  return (
    <label className="core-field">
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

function CopyButton({ value }) {
  async function copy() {
    if (!value) {
      return;
    }
    await navigator.clipboard?.writeText(String(value)).catch(() => null);
  }
  return <button className="btn btn--ghost btn--icon" onClick={copy} type="button" aria-label="コピー">コピー</button>;
}

function createPayload(type, data, context) {
  const orgId = context.orgId;
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
    .map(([productId, roles]) => `${productLabel(productId)}: ${labelsForList(roles)}`);
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

function statusLabel(value) {
  return ({
    active: "有効",
    inactive: "停止中",
    enabled: "有効",
    disabled: "停止中",
    trialing: "トライアル中",
    past_due: "支払い確認中",
    unpaid: "未払い",
    canceled: "キャンセル済み",
    cancelled: "キャンセル済み",
    submitted: "受付済み",
    reviewing: "確認中",
    completed: "完了",
    rejected: "却下"
  })[value] || value || "-";
}

function sexLabel(value) {
  return ({
    male: "男性",
    female: "女性",
    other: "その他",
    unknown: "不明"
  })[value] || value || "-";
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
    "auth.logout": "ログアウト",
    "auth.mfa_verified": "2段階認証登録",
    "member.created": "職員作成",
    "member.updated": "職員更新",
    "member.mfa_reset": "2段階認証リセット",
    "facility.created": "施設作成",
    "facility.updated": "施設更新",
    "department.created": "診療科作成",
    "department.updated": "診療科更新",
    "patient.created": "患者作成",
    "patient.updated": "患者更新",
    "data_request.created": "個人情報の依頼作成",
    "data_request.updated": "個人情報の依頼更新"
  })[value] || value || "-";
}

function targetTypeLabel(value) {
  return ({
    member: "職員",
    facility: "施設",
    department: "診療科",
    patient: "患者",
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
  return hasGlobalRole(session, "org_admin") || hasGlobalRole(session, "platform_admin");
}

function canManageBilling(session) {
  return hasGlobalRole(session, "billing_admin") || hasGlobalRole(session, "platform_admin");
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
