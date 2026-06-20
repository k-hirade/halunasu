"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredPlatformAccessToken, usePlatformAuth } from "./platform-auth";

const DEFAULT_RECIPIENT = {
  institutionName: "",
  departmentName: "",
  doctorName: "",
  fax: "",
  phone: "",
  address: ""
};

export function ReferralWorkspace({ mode = "list", referralId = "" }) {
  const auth = usePlatformAuth();
  const [bootstrap, setBootstrap] = useState(emptyBootstrap());
  const [selectedReferralId, setSelectedReferralId] = useState(referralId);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const referralBaseUrl = runtimeConfig().referralBaseUrl;
  const selectedReferral = useMemo(
    () => bootstrap.referrals.find((referral) => referral.referralId === selectedReferralId) || null,
    [bootstrap.referrals, selectedReferralId]
  );

  const api = useCallback(async (path, options = {}) => {
    const headers = { "content-type": "application/json" };
    const accessToken = auth.accessToken || getStoredPlatformAccessToken();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    } else {
      const error = new Error("Invalid session");
      error.status = 401;
      throw error;
    }
    if (options.csrf && auth.csrfToken) headers["x-csrf-token"] = auth.csrfToken;
    const response = await fetch(`${referralBaseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const nextError = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      nextError.status = response.status;
      throw nextError;
    }
    return payload;
  }, [auth.accessToken, auth.csrfToken, referralBaseUrl]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api("/v1/referral/bootstrap");
      setBootstrap({
        patients: payload.patients || [],
        facilities: payload.facilities || [],
        departments: payload.departments || [],
        referrals: payload.referrals || [],
        recipients: payload.recipients || [],
        templates: payload.templates || []
      });
      if (!selectedReferralId && payload.referrals?.[0]?.referralId && mode === "detail") {
        setSelectedReferralId(payload.referrals[0].referralId);
      }
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [api, mode, selectedReferralId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function mutate(path, body, options = {}) {
    setBusy(true);
    setError("");
    try {
      const payload = await api(path, {
        method: options.method || "POST",
        csrf: true,
        body
      });
      setToast(options.toast || "更新しました。");
      setTimeout(() => setToast(""), 2400);
      await refresh();
      if (payload.referral?.referralId) {
        setSelectedReferralId(payload.referral.referralId);
      }
      return payload;
    } catch (nextError) {
      setError(toMessage(nextError));
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="referral-page"><div className="panel">読み込み中...</div></main>;
  }

  return (
    <main className="referral-page">
      {toast ? <div className="referral-toast" role="status">{toast}</div> : null}
      {error ? <div className="referral-error" role="alert">{error}</div> : null}

      {mode === "new" ? (
        <NewReferralView bootstrap={bootstrap} busy={busy} mutate={mutate} />
      ) : mode === "admin" ? (
        <ReferralAdminView bootstrap={bootstrap} busy={busy} mutate={mutate} />
      ) : mode === "detail" ? (
        <ReferralDetailView
          bootstrap={bootstrap}
          busy={busy}
          mutate={mutate}
          referral={selectedReferral}
          setSelectedReferralId={setSelectedReferralId}
        />
      ) : (
        <ReferralListView bootstrap={bootstrap} />
      )}
    </main>
  );
}

function ReferralListView({ bootstrap }) {
  return (
    <div className="referral-shell">
      <section className="panel referral-list-panel">
        <div className="section-head">
          <div>
            <span className="eyebrow">紹介状</span>
            <h1>紹介状一覧</h1>
            <p>下書き、確認待ち、発行済みの診療情報提供書を管理します。</p>
          </div>
          <a className="btn btn--primary" href="/referrals/new">新規作成</a>
        </div>
        <div className="referral-table">
          {bootstrap.referrals.length ? bootstrap.referrals.map((referral) => (
            <a className="referral-row" href={`/referrals/${referral.referralId}`} key={referral.referralId}>
              <div>
                <strong>{referral.patientSnapshot?.displayName || referral.patientId}</strong>
                <span>{referral.purpose || "目的未入力"}</span>
              </div>
              <div>
                <strong>{referral.recipientInstitutionSnapshot?.displayName || "宛先未入力"}</strong>
                <span>{referral.recipientDoctorSnapshot?.displayName || referral.recipientInstitutionSnapshot?.departmentName || ""}</span>
              </div>
              <StatusBadge status={referral.status} />
              <time>{formatDate(referral.updatedAt)}</time>
            </a>
          )) : (
            <div className="empty-state">紹介状はまだありません。</div>
          )}
        </div>
      </section>
    </div>
  );
}

function NewReferralView({ bootstrap, busy, mutate }) {
  const [recipientMode, setRecipientMode] = useState("directory");
  const firstPatient = bootstrap.patients[0]?.patientId || "";
  const firstFacility = bootstrap.facilities[0]?.facilityId || "";
  const firstDepartment = bootstrap.departments[0]?.departmentId || "";

  async function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const directoryRecipient = bootstrap.recipients.find((recipient) => recipient.recipientId === form.get("recipientId"));
    const recipientInstitution = recipientMode === "directory" && directoryRecipient
      ? recipientInstitutionFromDirectory(directoryRecipient)
      : {
        displayName: form.get("recipientInstitution"),
        departmentName: form.get("recipientDepartment"),
        address: form.get("recipientAddress"),
        phone: form.get("recipientPhone"),
        fax: form.get("recipientFax")
      };
    const recipientDoctor = recipientMode === "directory" && directoryRecipient
      ? recipientDoctorFromDirectory(directoryRecipient)
      : {
        displayName: form.get("recipientDoctor") || "ご担当先生",
        departmentName: form.get("recipientDepartment")
      };
    const payload = await mutate("/v1/referral/referrals", {
      patientId: form.get("patientId"),
      facilityId: form.get("facilityId"),
      departmentId: form.get("departmentId"),
      documentType: form.get("documentType"),
      urgency: form.get("urgency"),
      recipientInstitution,
      recipientDoctor,
      title: "診療情報提供書",
      purpose: form.get("purpose") || "ご高診のお願い",
      clinicalSummary: form.get("clinicalSummary") || "診療経過を入力してください。",
      diagnoses: lines(form.get("diagnoses")),
      medications: lines(form.get("medications")),
      requestedAction: form.get("requestedAction") || "ご高診のほどよろしくお願いいたします。",
      referralFormSections: referralFormSectionsFromForm(form)
    }, { toast: "紹介状下書きを作成しました。" });
    if (payload?.referral?.referralId) {
      window.location.href = `/referrals/${payload.referral.referralId}`;
    }
  }

  return (
    <div className="referral-shell">
      <form className="panel referral-form" onSubmit={handleSubmit}>
        <div className="section-head">
          <div>
            <span className="eyebrow">新規作成</span>
            <h1>紹介状下書き</h1>
            <p>患者、宛先、目的を選んで診療情報提供書の下書きを作成します。</p>
          </div>
          <a className="btn" href="/referrals">一覧へ</a>
        </div>
        <div className="form-grid">
          <SelectField label="患者" name="patientId" defaultValue={firstPatient} items={bootstrap.patients.map((patient) => [patient.patientId, `${patient.displayName} ${patient.externalPatientIds?.[0] || ""}`])} />
          <SelectField label="施設" name="facilityId" defaultValue={firstFacility} items={bootstrap.facilities.map((facility) => [facility.facilityId, facility.displayName])} />
          <SelectField label="診療科" name="departmentId" defaultValue={firstDepartment} items={bootstrap.departments.map((department) => [department.departmentId, department.displayName])} />
          <SelectField label="文書種別" name="documentType" defaultValue="clinical_information" items={[
            ["clinical_information", "診療情報提供書"],
            ["specialist_referral", "専門医紹介"],
            ["test_request", "検査依頼"],
            ["admission_request", "入院依頼"],
            ["reverse_referral", "逆紹介"],
            ["reply", "返書"]
          ]} />
          <SelectField label="緊急度" name="urgency" defaultValue="routine" items={[
            ["routine", "通常"],
            ["soon", "早め"],
            ["urgent", "至急"]
          ]} />
        </div>
        <div className="segmented-row">
          <button className={recipientMode === "directory" ? "is-active" : ""} onClick={() => setRecipientMode("directory")} type="button">宛先マスタ</button>
          <button className={recipientMode === "manual" ? "is-active" : ""} onClick={() => setRecipientMode("manual")} type="button">手入力</button>
        </div>
        {recipientMode === "directory" ? (
          <SelectField label="宛先" name="recipientId" items={bootstrap.recipients.map((recipient) => [recipient.recipientId, `${recipient.institutionName} ${recipient.departmentName || ""} ${recipient.doctorName || ""}`])} />
        ) : (
          <RecipientFields />
        )}
        <TextField label="紹介目的" name="purpose" placeholder="例: 持続する腹痛の精査依頼" />
        <TextArea label="経過" name="clinicalSummary" placeholder="主訴、経過、所見、検査結果など" />
        <TextArea label="傷病名" name="diagnoses" placeholder="1行に1つずつ入力" />
        <TextArea label="処方" name="medications" placeholder="1行に1つずつ入力" />
        <TextArea label="依頼事項" name="requestedAction" placeholder="ご高診・精査・入院適応評価など" />
        <div className="action-footer-inline">
          <a className="btn" href="/referrals">閉じる</a>
          <button className="btn btn--primary" disabled={busy} type="submit">下書きを作成</button>
        </div>
      </form>
    </div>
  );
}

function ReferralDetailView({ bootstrap, busy, mutate, referral, setSelectedReferralId }) {
  const [tab, setTab] = useState("edit");
  const [sourceText, setSourceText] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [replySummary, setReplySummary] = useState("");

  if (!referral) {
    return (
      <div className="referral-shell">
        <section className="panel">
          <h1>紹介状が見つかりません</h1>
          <p>一覧から紹介状を選択してください。</p>
          <a className="btn btn--primary" href="/referrals">一覧へ</a>
        </section>
      </div>
    );
  }

  async function patchReferral(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(`/v1/referral/referrals/${referral.referralId}`, {
      documentType: form.get("documentType"),
      urgency: form.get("urgency"),
      title: form.get("title"),
      purpose: form.get("purpose"),
      clinicalSummary: form.get("clinicalSummary"),
      diagnoses: lines(form.get("diagnoses")),
      medications: lines(form.get("medications")),
      allergies: lines(form.get("allergies")),
      requestedAction: form.get("requestedAction"),
      notes: form.get("notes"),
      status: form.get("status"),
      referralFormSections: referralFormSectionsFromForm(form)
    }, { method: "PATCH", toast: "下書きを保存しました。" });
  }

  async function createDocument() {
    await mutate(`/v1/referral/referrals/${referral.referralId}/document`, {}, { toast: "プレビュー文書を作成しました。" });
  }

  async function validateReferral() {
    await mutate(`/v1/referral/referrals/${referral.referralId}/validate`, {}, { toast: "確認項目を更新しました。" });
  }

  async function finalizeReferral() {
    await mutate(`/v1/referral/referrals/${referral.referralId}/finalize`, {
      status: "ready"
    }, { toast: "紹介状を確定しました。" });
  }

  async function applyDraftAssistant() {
    await mutate(`/v1/referral/referrals/${referral.referralId}/draft-ai`, {
      sourceText,
      documentType: referral.documentType
    }, { toast: "下書き候補を反映しました。" });
  }

  async function importSource() {
    await mutate(`/v1/referral/referrals/${referral.referralId}/imports`, {
      sourceProduct: "manual",
      sourceType: "clinical_text",
      sourceId: `manual_${Date.now()}`,
      selectedSections: ["clinicalText"],
      sourceSnapshot: { clinicalText: sourceText }
    }, { toast: "カルテ情報を取り込みました。" });
  }

  async function addAttachment() {
    if (!attachmentName.trim()) return;
    await mutate(`/v1/referral/referrals/${referral.referralId}/attachments`, {
      displayName: attachmentName,
      attachmentType: "document"
    }, { toast: "添付情報を追加しました。" });
    setAttachmentName("");
  }

  async function addReply() {
    if (!replySummary.trim()) return;
    await mutate(`/v1/referral/referrals/${referral.referralId}/replies`, {
      summary: replySummary
    }, { toast: "返書を登録しました。" });
    setReplySummary("");
  }

  async function linkFee(status) {
    await mutate(`/v1/referral/referrals/${referral.referralId}/fee-linkage`, {
      status,
      suggestedBillingConcept: "診療情報提供料"
    }, { toast: "算定連携状態を更新しました。" });
  }

  return (
    <div className="referral-workspace">
      <aside className="referral-source-pane">
        <section className="panel">
          <div className="section-head compact">
            <div>
              <span className="eyebrow">患者</span>
              <h2>{referral.patientSnapshot?.displayName || referral.patientId}</h2>
            </div>
            <StatusBadge status={referral.status} />
          </div>
          <dl className="info-list">
            <div><dt>施設</dt><dd>{referral.facilitySnapshot?.displayName || referral.facilityId}</dd></div>
            <div><dt>診療科</dt><dd>{referral.departmentSnapshot?.displayName || referral.departmentId}</dd></div>
            <div><dt>作成者</dt><dd>{referral.authorMemberSnapshot?.displayName || referral.authorMemberId}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <h2>カルテ/SOAP取り込み</h2>
          <p>カルテ作成アプリからの明示インポート、または手動貼り付けで紹介状下書きに使います。</p>
          <textarea className="source-textarea" value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="S/O/A/Pや検査結果、処方などを貼り付け" />
          <div className="button-row">
            <button className="btn" disabled={busy || !sourceText.trim()} onClick={importSource} type="button">取り込み</button>
            <button className="btn btn--primary" disabled={busy || !sourceText.trim()} onClick={applyDraftAssistant} type="button">下書き補助</button>
          </div>
        </section>
        <section className="panel">
          <h2>添付・返書</h2>
          <div className="inline-form">
            <input value={attachmentName} onChange={(event) => setAttachmentName(event.target.value)} placeholder="添付名: 採血結果、画像CDなど" />
            <button className="btn" onClick={addAttachment} type="button">添付追加</button>
          </div>
          <ul className="plain-list">{(referral.attachments || []).map((attachment) => <li key={attachment.attachmentId}>{attachment.displayName}</li>)}</ul>
          <textarea className="small-textarea" value={replySummary} onChange={(event) => setReplySummary(event.target.value)} placeholder="返書を受領した場合の要約" />
          <button className="btn" disabled={busy || !replySummary.trim()} onClick={addReply} type="button">返書登録</button>
        </section>
      </aside>
      <section className="referral-main-pane panel">
        <div className="workspace-tabs">
          {["edit", "preview", "check"].map((item) => (
            <button className={tab === item ? "is-active" : ""} key={item} onClick={() => setTab(item)} type="button">
              {item === "edit" ? "下書き編集" : item === "preview" ? "プレビュー" : "確認項目"}
            </button>
          ))}
        </div>
        {tab === "edit" ? (
          <form className="referral-editor" onSubmit={patchReferral}>
            <div className="form-grid">
              <SelectField label="文書種別" name="documentType" defaultValue={referral.documentType || "clinical_information"} items={[
                ["clinical_information", "診療情報提供書"],
                ["specialist_referral", "専門医紹介"],
                ["test_request", "検査依頼"],
                ["admission_request", "入院依頼"],
                ["reverse_referral", "逆紹介"],
                ["reply", "返書"]
              ]} />
              <SelectField label="緊急度" name="urgency" defaultValue={referral.urgency || "routine"} items={[["routine", "通常"], ["soon", "早め"], ["urgent", "至急"]]} />
              <SelectField label="状態" name="status" defaultValue={referral.status || "draft"} items={[
                ["draft", "下書き"],
                ["needs_review", "確認待ち"],
                ["archived", "保管"]
              ]} />
            </div>
            <TextField label="タイトル" name="title" defaultValue={referral.title || "診療情報提供書"} />
            <TextArea label="紹介目的" name="purpose" defaultValue={referral.purpose} />
            <TextArea label="経過" name="clinicalSummary" defaultValue={referral.clinicalSummary} tall />
            <TextArea label="傷病名" name="diagnoses" defaultValue={(referral.diagnoses || []).join("\n")} />
            <TextArea label="処方" name="medications" defaultValue={(referral.medications || []).join("\n")} />
            <TextArea label="アレルギー" name="allergies" defaultValue={(referral.allergies || []).join("\n")} />
            <TextArea label="依頼事項" name="requestedAction" defaultValue={referral.requestedAction} />
            <TextArea label="備考" name="notes" defaultValue={referral.notes} />
            <div className="action-footer-inline">
              <button className="btn" disabled={busy} onClick={validateReferral} type="button">確認項目を更新</button>
              <button className="btn btn--primary" disabled={busy} type="submit">保存</button>
            </div>
          </form>
        ) : null}
        {tab === "preview" ? (
          <PreviewPanel busy={busy} createDocument={createDocument} referral={referral} />
        ) : null}
        {tab === "check" ? (
          <CheckPanel busy={busy} finalizeReferral={finalizeReferral} linkFee={linkFee} referral={referral} />
        ) : null}
      </section>
    </div>
  );
}

function PreviewPanel({ busy, createDocument, referral }) {
  const html = referral.documentArtifact?.renderedHtml || "";
  function openPrintWindow() {
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    win.document.write(html || "<p>文書を作成してください。</p>");
    win.document.close();
    win.focus();
    win.print();
  }

  return (
    <div className="preview-layout">
      <div className="button-row">
        <button className="btn btn--primary" disabled={busy} onClick={createDocument} type="button">プレビュー文書を作成</button>
        <button className="btn" disabled={!html} onClick={openPrintWindow} type="button">印刷/PDF保存</button>
      </div>
      {html ? (
        <iframe className="document-preview" title="紹介状プレビュー" srcDoc={html} />
      ) : (
        <div className="empty-state">文書プレビューはまだ作成されていません。</div>
      )}
    </div>
  );
}

function CheckPanel({ busy, finalizeReferral, linkFee, referral }) {
  const checklist = referral.reviewChecklist || [];
  const missingCount = checklist.filter((item) => item.status !== "passed").length;
  const canFinalize = missingCount === 0;
  return (
    <div className="check-panel">
      <div className="summary-cards">
        <div><span>確認不足</span><strong>{missingCount}件</strong></div>
        <div><span>添付</span><strong>{referral.attachments?.length || 0}件</strong></div>
        <div><span>返書</span><strong>{referral.replies?.length || 0}件</strong></div>
      </div>
      <div className="check-list">
        {checklist.map((item) => (
          <div className={`check-item ${item.status}`} key={item.key}>
            <strong>{item.label}</strong>
            <span>{item.status === "passed" ? "確認済み" : item.message}</span>
          </div>
        ))}
      </div>
      <div className="finalize-panel">
        <h3>医師確認・確定</h3>
        <p>未確認項目がないことを確認してから、医師操作として紹介状を確定します。</p>
        <button className="btn btn--primary" disabled={busy || !canFinalize} onClick={finalizeReferral} type="button">
          紹介状を確定
        </button>
      </div>
      <div className="fee-linkage">
        <h3>診療情報提供料の算定連携</h3>
        <p>紹介状作成の事実を診療報酬算定アプリへ橋渡しします。点数・要件判定はFee側で行います。</p>
        <div className="button-row">
          <button className="btn" onClick={() => linkFee("suggested")} type="button">候補として記録</button>
          <button className="btn" onClick={() => linkFee("linked")} type="button">算定連携済み</button>
          <button className="btn" onClick={() => linkFee("dismissed")} type="button">対象外</button>
        </div>
        <small>現在: {referral.feeLinkage?.status || "not_linked"}</small>
      </div>
    </div>
  );
}

function ReferralAdminView({ bootstrap, busy, mutate }) {
  async function addRecipient(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate("/v1/referral/recipient-directory", {
      institutionName: form.get("institutionName"),
      departmentName: form.get("departmentName"),
      doctorName: form.get("doctorName"),
      fax: form.get("fax"),
      phone: form.get("phone"),
      address: form.get("address")
    }, { toast: "宛先を保存しました。" });
    event.currentTarget.reset();
  }

  async function addTemplate(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate("/v1/referral/templates", {
      templateType: form.get("templateType"),
      displayName: form.get("displayName"),
      purposeTemplate: form.get("purposeTemplate"),
      clinicalSummaryTemplate: form.get("clinicalSummaryTemplate"),
      requestedActionTemplate: form.get("requestedActionTemplate")
    }, { toast: "テンプレートを保存しました。" });
    event.currentTarget.reset();
  }

  return (
    <div className="admin-grid">
      <section className="panel">
        <h1>宛先マスタ</h1>
        <form className="stack-form" onSubmit={addRecipient}>
          <TextField label="医療機関名" name="institutionName" required />
          <TextField label="診療科" name="departmentName" />
          <TextField label="医師名" name="doctorName" />
          <TextField label="FAX" name="fax" />
          <TextField label="電話" name="phone" />
          <TextField label="住所" name="address" />
          <button className="btn btn--primary" disabled={busy} type="submit">保存</button>
        </form>
        <ul className="plain-list">{bootstrap.recipients.map((recipient) => <li key={recipient.recipientId}>{recipient.institutionName} {recipient.departmentName} {recipient.doctorName}</li>)}</ul>
      </section>
      <section className="panel">
        <h1>テンプレート</h1>
        <form className="stack-form" onSubmit={addTemplate}>
          <SelectField label="種別" name="templateType" defaultValue="clinical_information" items={[["clinical_information", "診療情報提供書"], ["test_request", "検査依頼"], ["admission_request", "入院依頼"], ["reply", "返書"]]} />
          <TextField label="テンプレート名" name="displayName" required />
          <TextArea label="紹介目的テンプレート" name="purposeTemplate" />
          <TextArea label="経過テンプレート" name="clinicalSummaryTemplate" />
          <TextArea label="依頼事項テンプレート" name="requestedActionTemplate" />
          <button className="btn btn--primary" disabled={busy} type="submit">保存</button>
        </form>
        <ul className="plain-list">{bootstrap.templates.map((template) => <li key={template.templateId}>{template.displayName}</li>)}</ul>
      </section>
    </div>
  );
}

function RecipientFields() {
  return (
    <div className="form-grid">
      <TextField label="宛先医療機関" name="recipientInstitution" required />
      <TextField label="宛先診療科" name="recipientDepartment" />
      <TextField label="宛先医師" name="recipientDoctor" />
      <TextField label="FAX" name="recipientFax" />
      <TextField label="電話" name="recipientPhone" />
      <TextField label="住所" name="recipientAddress" />
    </div>
  );
}

function TextField({ defaultValue = "", label, name, placeholder = "", required = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input defaultValue={defaultValue || ""} name={name} placeholder={placeholder} required={required} />
    </label>
  );
}

function TextArea({ defaultValue = "", label, name, placeholder = "", tall = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className={tall ? "textarea-tall" : ""} defaultValue={defaultValue || ""} name={name} placeholder={placeholder} />
    </label>
  );
}

function SelectField({ defaultValue = "", items = [], label, name }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select defaultValue={defaultValue} name={name}>
        {items.length ? items.map(([value, text]) => <option key={value} value={value}>{text || value}</option>) : <option value="">未登録</option>}
      </select>
    </label>
  );
}

function StatusBadge({ status }) {
  const labels = {
    draft: "下書き",
    needs_review: "確認待ち",
    ready: "発行可能",
    document_ready: "文書作成済み",
    sent: "送付済み",
    archived: "保管",
    cancelled: "取消"
  };
  return <span className={`status-badge ${status || "draft"}`}>{labels[status] || status || "下書き"}</span>;
}

function recipientInstitutionFromDirectory(recipient = DEFAULT_RECIPIENT) {
  return {
    displayName: recipient.institutionName,
    departmentName: recipient.departmentName,
    medicalInstitutionCode: recipient.medicalInstitutionCode,
    postalCode: recipient.postalCode,
    address: recipient.address,
    phone: recipient.phone,
    fax: recipient.fax
  };
}

function recipientDoctorFromDirectory(recipient = DEFAULT_RECIPIENT) {
  return {
    displayName: recipient.doctorName || "ご担当先生",
    title: recipient.doctorTitle,
    departmentName: recipient.departmentName
  };
}

function lines(value) {
  return String(value || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function referralFormSectionsFromForm(form) {
  return {
    referralPurpose: form.get("purpose") || "",
    clinicalCourseAndFindings: form.get("clinicalSummary") || "",
    diagnoses: lines(form.get("diagnoses")),
    currentMedications: lines(form.get("medications")),
    allergies: lines(form.get("allergies")),
    requestedAction: form.get("requestedAction") || "",
    remarks: form.get("notes") || ""
  };
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("ja-JP");
}

function runtimeConfig() {
  if (typeof window === "undefined") {
    return { referralBaseUrl: "/api/referral" };
  }
  return window.__HALUNASU_REFERRAL_CONFIG__ || { referralBaseUrl: "/api/referral" };
}

function emptyBootstrap() {
  return {
    patients: [],
    facilities: [],
    departments: [],
    referrals: [],
    recipients: [],
    templates: []
  };
}

function toMessage(error) {
  const text = String(error?.message || "").trim();
  if (!text || /^HTTP \d+$/i.test(text)) return "処理に失敗しました。";
  return text;
}
