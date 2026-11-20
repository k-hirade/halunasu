"use client";

import { useEffect, useState } from "react";
import { eraYearLabel } from "@halunasu/eye-contracts";
import { inPortal } from "./chart-left-shared";
import { useEyeApi } from "./eye-api";
import { AllergyBadge } from "./patient-banner";
import { PatientRegisterDialog } from "./patient-register-dialog";
import { ageOn, SEX_LABELS } from "../lib/format";

const SEX_FULL = { male: "男性", female: "女性", other: "その他", unknown: "不明" };

export function addressText(contact = {}) {
  const postal = String(contact.postalCode || "").replace(/[^0-9]/gu, "");
  const zip = postal.length === 7 ? `〒${postal.slice(0, 3)}-${postal.slice(3)}` : postal ? `〒${postal}` : "";
  const line = [contact.prefecture, contact.address1, contact.address2, contact.address3].filter(Boolean).join(" ");
  return [zip, line].filter(Boolean).join(" ");
}

export function birthText(birthDate) {
  if (!birthDate) return "";
  const [year, month, day] = birthDate.split("-").map(Number);
  const era = eraYearLabel(birthDate);
  return `${year}年${era ? `（${era}）` : ""}${month}月${day}日`;
}

// 左「患者情報」（デジカルの患者情報タブ）。ラベルと値の表（氏名・性別・生年月日・年齢・住所・電話）を大きく出し、
// 見出しの［✎］で患者情報の編集（受付の患者登録と同じダイアログ）を開く。下にアレルギー・既往・患者メモ。
// 住所・電話は platform の患者情報（contact）にあるので、開いたときに最新を読み直す。
export function PatientInfoTab({ patient: snapshot, profile, context, onEditProfile, onProfileSaved }) {
  const api = useEyeApi();
  const [patient, setPatient] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [memo, setMemo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patientId = snapshot?.patientId;

  useEffect(() => {
    if (!patientId) return undefined;
    let cancelled = false;
    api(`/v1/eye/patients/${patientId}`)
      .then((payload) => { if (!cancelled) setPatient(payload.patient); })
      .catch((nextError) => { if (!cancelled) setLoadError(nextError.message); });
    return () => { cancelled = true; };
  }, [api, patientId]);

  const shown = patient || snapshot || {};
  const contact = patient?.contact || {};
  const age = ageOn(shown.birthDate);
  const phones = [contact.phone1, contact.phone2].filter(Boolean);
  const current = profile?.patientMemo || "";

  async function saveMemo() {
    setBusy(true);
    setError("");
    try {
      const payload = await api(`/v1/eye/patients/${patientId}/memo`, { method: "PUT", body: { expectedRevision: profile?.revision || 0, patientMemo: memo } });
      onProfileSaved(payload.profile);
      setMemo(null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cl-info">
      <section aria-labelledby="cl-info-title" className="cl-card">
        <div className="cl-card-head">
          <h3 id="cl-info-title">患者情報</h3>
          {context?.canRegisterPatients ? (
            <button aria-label="患者情報を編集" className="btn btn-chip cl-pencil" disabled={!patient} onClick={() => setEditing(true)} title="患者情報を編集（氏名・生年月日・住所・電話）" type="button">✎</button>
          ) : null}
        </div>
        {loadError ? <p className="alert alert-danger small" role="alert">{loadError}</p> : null}
        <table className="cl-info-table">
          <tbody>
            <tr><th scope="row">患者番号</th><td className="mono">{shown.primaryPatientNumber || <span className="muted">—</span>}</td></tr>
            <tr>
              <th scope="row">氏名</th>
              <td>
                {shown.displayNameKana ? <span className="cl-kana">{shown.displayNameKana}</span> : null}
                <span className="cl-name">{shown.displayName}</span>
              </td>
            </tr>
            <tr><th scope="row">性別</th><td>{SEX_FULL[shown.sex] || SEX_LABELS[shown.sex] || "—"}</td></tr>
            <tr><th scope="row">生年月日</th><td>{birthText(shown.birthDate) || "—"}</td></tr>
            <tr><th scope="row">年齢</th><td>{age === null ? "—" : `${age}歳`}</td></tr>
            <tr><th scope="row">住所</th><td>{patient ? addressText(contact) || <span className="muted">未記入</span> : <span className="muted">読み込み中…</span>}</td></tr>
            <tr><th scope="row">電話番号</th><td className="mono">{patient ? (phones.length ? phones.join(" ／ ") : <span className="muted">未記入</span>) : <span className="muted">読み込み中…</span>}</td></tr>
          </tbody>
        </table>
      </section>

      <section aria-labelledby="cl-clinical-title" className="cl-card">
        <div className="cl-card-head">
          <h3 id="cl-clinical-title">診療の注意</h3>
          {context?.canEditProfile ? <button aria-label="アレルギー・既往を編集" className="btn btn-chip cl-pencil" onClick={onEditProfile} title="アレルギー・既往を編集" type="button">✎</button> : null}
        </div>
        <table className="cl-info-table">
          <tbody>
            <tr><th scope="row">アレルギー</th><td><AllergyBadge profile={profile} /></td></tr>
            <tr><th scope="row">副作用薬</th><td>{(profile?.adverseDrugs || []).map((item) => item.name).join("、") || <span className="muted">—</span>}</td></tr>
            <tr><th scope="row">全身既往・内服</th><td className="pre">{profile?.medicalHistory || <span className="muted">未記入</span>}</td></tr>
            <tr><th scope="row">眼科既往</th><td className="pre">{profile?.ophthalmicHistory || <span className="muted">未記入</span>}</td></tr>
            <tr><th scope="row">CL</th><td>{profile?.contactLensUser ? "装用" : "—"}</td></tr>
          </tbody>
        </table>
      </section>

      <section aria-labelledby="cl-memo-title" className="cl-card">
        <div className="cl-card-head">
          <h3 id="cl-memo-title">患者メモ</h3>
          {context?.canReceive && memo === null ? <button aria-label="患者メモを編集" className="btn btn-chip cl-pencil" onClick={() => setMemo(current)} title="患者メモを編集" type="button">✎</button> : null}
        </div>
        {memo === null ? (
          <p className="pre cl-memo">{current || <span className="muted">メモはありません。</span>}</p>
        ) : (
          <div className="cl-memo-edit">
            <textarea aria-label="患者メモ" autoFocus className="input" maxLength={2000} onChange={(event) => setMemo(event.target.value)} rows={3} value={memo} />
            {error ? <p className="alert alert-danger small">{error}</p> : null}
            <span className="row-line">
              <button className="btn btn-ghost" onClick={() => setMemo(null)} type="button">キャンセル</button>
              <button className="btn btn-primary" disabled={busy} onClick={saveMemo} type="button">保存</button>
            </span>
          </div>
        )}
      </section>
      {editing && patient ? inPortal(
        <PatientRegisterDialog
          onCancel={() => setEditing(false)}
          onUpdated={(updated) => { setPatient(updated); setEditing(false); }}
          patient={patient}
        />
      ) : null}
    </div>
  );
}
