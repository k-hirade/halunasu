"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, SaveIndicator } from "./encounter-dialogs";
import { useEyeApi } from "./eye-api";
import { ageOn, formatDate, formatDateTime, SEX_LABELS } from "../lib/format";

const AUTOSAVE_MS = 1500;

// 文書の編集。下書きは自動保存し、医師が確定すると変更できない（修正は複製して行う）。
export function DocumentEditor({ documentId }) {
  const api = useEyeApi();
  const router = useRouter();
  const [document, setDocument] = useState(null);
  const [context, setContext] = useState(null);
  const [form, setForm] = useState(null);
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    Promise.all([apiRef.current(`/v1/eye/documents/${documentId}`), apiRef.current("/v1/eye/context")])
      .then(([payload, contextPayload]) => {
        setDocument(payload.document);
        setForm(formFrom(payload.document));
        setContext(contextPayload.context);
        revisionRef.current = payload.document.revision;
      })
      .catch((nextError) => setError(nextError.message));
  }, [documentId]);

  const editable = Boolean(document && document.status === "draft" && context?.canWriteDocuments);

  async function save() {
    if (!dirtyRef.current || !editable) return true;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const payload = await apiRef.current(`/v1/eye/documents/${documentId}`, {
        method: "PATCH",
        body: { expectedRevision: revisionRef.current, ...form }
      });
      revisionRef.current = payload.document.revision;
      setDocument(payload.document);
      setSaveState(dirtyRef.current ? "dirty" : "saved");
      return true;
    } catch (nextError) {
      dirtyRef.current = true;
      setSaveState("error");
      setError(nextError.message);
      return false;
    }
  }

  useEffect(() => {
    if (saveState !== "dirty") return undefined;
    const handle = setTimeout(() => { save(); }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function change(patch) {
    setForm((current) => ({ ...current, ...patch }));
    dirtyRef.current = true;
    setSaveState("dirty");
  }

  async function finalize() {
    if (!(await save())) return;
    try {
      const payload = await api(`/v1/eye/documents/${documentId}/finalize`, { method: "POST", body: { expectedRevision: revisionRef.current } });
      setDocument(payload.document);
      revisionRef.current = payload.document.revision;
      setConfirming(false);
    } catch (nextError) {
      setConfirming(false);
      setError(nextError.message);
    }
  }

  async function duplicate() {
    try {
      const payload = await api(`/v1/eye/documents/${documentId}/duplicate`, { method: "POST", body: {} });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  if (error && !document) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!document || !form) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  return (
    <main className="eye-page document-page">
      <header className="page-head">
        <div>
          <a className="back-link" href={`/patients/${document.patientId}`}>← {document.patientSnapshot.displayName} のカルテ一覧</a>
          <h1>{form.title} <span className={`tag ${document.status === "finalized" ? "tag-ok" : "tag-draft"}`}>{document.status === "finalized" ? "確定" : "下書き"}</span></h1>
          {document.status === "finalized" ? <p className="page-sub">確定 {formatDateTime(document.finalizedAt)} {document.finalizedBy?.displayName}</p> : null}
        </div>
        <div className="encounter-actions">
          {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
          <a className="btn btn-ghost" href={`/documents/${documentId}/print`} rel="noreferrer" target="_blank">印刷</a>
          {document.status === "finalized" && context?.canWriteDocuments ? <button className="btn btn-ghost" onClick={duplicate} type="button">複製して修正</button> : null}
          {document.status === "draft" && context?.canFinalize ? <button className="btn btn-primary" onClick={() => setConfirming(true)} type="button">確定する</button> : null}
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {document.status === "draft" && !context?.canFinalize ? <p className="alert alert-info">下書きとして保存されます。確定は医師が行います。</p> : null}

      <fieldset className="encounter-form document-form" disabled={!editable}>
        <section className="form-section">
          <label className="field"><span>表題</span><input className="input" onChange={(event) => change({ title: event.target.value })} value={form.title} /></label>
          <div className="field-row">
            <label className="field"><span>宛先 医療機関</span><input className="input" onChange={(event) => change({ recipient: { ...form.recipient, institution: event.target.value } })} value={form.recipient.institution} /></label>
            <label className="field"><span>診療科</span><input className="input" onChange={(event) => change({ recipient: { ...form.recipient, department: event.target.value } })} value={form.recipient.department} /></label>
          </div>
          <div className="field-row">
            <label className="field"><span>先生</span><input className="input" onChange={(event) => change({ recipient: { ...form.recipient, doctor: event.target.value } })} placeholder="氏名（「先生」は自動で付きます）" value={form.recipient.doctor} /></label>
            <label className="field"><span>発行日</span><input className="input" onChange={(event) => change({ issueDate: event.target.value })} type="date" value={form.issueDate} /></label>
          </div>
          <label className="field"><span>本文</span><textarea className="input document-body" onChange={(event) => change({ body: event.target.value })} rows={24} value={form.body} /></label>
        </section>
      </fieldset>

      {confirming ? (
        <ConfirmDialog confirmLabel="確定する" onCancel={() => setConfirming(false)} onConfirm={finalize} title="文書を確定しますか？">
          <p>確定すると内容は変更できません。修正が必要な場合は「複製して修正」から新しい文書を作ります。</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

// 文書の印刷。
export function DocumentPrint({ documentId }) {
  const api = useEyeApi();
  const [document, setDocument] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/v1/eye/documents/${documentId}`).then((payload) => setDocument(payload.document)).catch((nextError) => setError(nextError.message));
  }, [api, documentId]);

  if (error) return <main className="print-page"><p className="alert alert-danger">{error}</p></main>;
  if (!document) return <main className="print-page"><p className="loading">読み込み中…</p></main>;
  const patient = document.patientSnapshot;
  const age = ageOn(patient.birthDate, document.issueDate);
  return (
    <main className="print-page letter">
      <div className="print-toolbar no-print">
        {document.status !== "finalized" ? <span className="draft-mark">下書き（未確定）</span> : null}
        <button className="btn btn-primary" onClick={() => window.print()} type="button">印刷する</button>
      </div>
      <h1 className="letter-title">{document.title}</h1>
      <p className="letter-date">{formatDate(document.issueDate)}</p>
      {document.recipient.institution || document.recipient.doctor ? (
        <p className="letter-recipient">
          {document.recipient.institution} {document.recipient.department}<br />
          {document.recipient.doctor ? `${document.recipient.doctor} 先生` : "ご担当 先生"} 御侍史
        </p>
      ) : null}
      <div className="letter-sender">
        <p>{document.sender.facilityName}</p>
        {document.sender.address ? <p>{document.sender.address}</p> : null}
        {document.sender.phone ? <p>TEL {document.sender.phone}</p> : null}
        <p>医師 {document.finalizedBy?.displayName || document.sender.doctorName}</p>
      </div>
      <table className="exam-table print-table letter-patient">
        <tbody>
          <tr><th>患者氏名</th><td>{patient.displayName}（{patient.displayNameKana}）</td><th>性別</th><td>{SEX_LABELS[patient.sex]}</td></tr>
          <tr><th>生年月日</th><td>{formatDate(patient.birthDate)}</td><th>年齢</th><td>{age === null ? "—" : `${age}歳`}</td></tr>
        </tbody>
      </table>
      <div className="letter-body pre">{document.body}</div>
      {document.contentHash ? <p className="small muted">文書ID {document.documentId} ・ 内容ハッシュ {document.contentHash.slice(0, 16)}</p> : null}
    </main>
  );
}

function formFrom(document) {
  return {
    title: document.title,
    recipient: { ...document.recipient },
    body: document.body,
    issueDate: document.issueDate
  };
}
