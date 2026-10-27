"use client";

import { useState } from "react";
import { useEyeApi } from "./eye-api";
import { EYE_LABELS, formatDate, patientLine } from "../lib/format";

const ALLERGY_CATEGORY_LABELS = { drug: "薬剤", food: "食物", contrast: "造影剤", latex: "ラテックス", other: "その他" };
const SEVERITY_LABELS = { unknown: "程度不明", mild: "軽度", moderate: "中等度", severe: "重篤" };
const STATUS_LABELS = { active: "確定", suspected: "疑い", resolved: "治癒・終了" };
const OUTCOME_LABELS = { "": "—", cured: "治癒", discontinued: "中止", transferred: "転医", deceased: "死亡", other: "その他" };

// 患者の帯。アレルギーはどの画面でも必ず見える位置に出す。
export function PatientBanner({ patient, profile, context, onProfileSaved, actions = null, sub = null }) {
  const [editing, setEditing] = useState(false);
  const active = (profile?.diagnoses || []).filter((item) => item.status !== "resolved");
  return (
    <div className="patient-banner">
      <div className="patient-banner-main">
        <div className="patient-banner-name">
          <h1>{patient.displayName} <span className="kana">{patient.displayNameKana}</span></h1>
          <span className="muted">{patientLine(patient)}{patient.birthDate ? ` ・ ${formatDate(patient.birthDate)}生` : ""}</span>
          {profile?.contactLensUser ? <span className="tag">CL装用</span> : null}
          {sub}
        </div>
        <div className="patient-banner-flags">
          <AllergyBadge profile={profile} />
          {active.slice(0, 4).map((item) => (
            <span className={`tag ${item.status === "suspected" ? "tag-warn" : ""}`} key={item.diagnosisId || item.name}>
              {item.primary ? "★" : ""}{EYE_LABELS[item.eye]} {item.name}{item.status === "suspected" ? "（疑い）" : ""}
            </span>
          ))}
          {active.length > 4 ? <span className="muted small">ほか{active.length - 4}件</span> : null}
          {context?.canEditProfile ? (
            <button className="btn btn-chip" onClick={() => setEditing(true)} type="button">アレルギー・病名</button>
          ) : null}
        </div>
      </div>
      {actions ? <div className="patient-banner-actions">{actions}</div> : null}
      {editing ? (
        <ProfileDialog
          canEditDiagnoses={Boolean(context?.canEditDiagnoses)}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => { setEditing(false); onProfileSaved?.(saved); }}
          patientId={patient.patientId}
          profile={profile}
        />
      ) : null}
    </div>
  );
}

export function AllergyBadge({ profile }) {
  if (!profile) return null;
  if (profile.allergies?.length) {
    const severe = profile.allergies.some((item) => item.severity === "severe");
    return (
      <span className={`allergy-badge${severe ? " is-severe" : ""}`} role="status">
        アレルギー: {profile.allergies.map((item) => `${item.substance}${item.reaction ? `（${item.reaction}）` : ""}`).join("、")}
      </span>
    );
  }
  if (profile.noKnownAllergies) return <span className="allergy-badge is-none">アレルギーなし（確認済み）</span>;
  return <span className="allergy-badge is-unknown">アレルギー未確認</span>;
}

function ProfileDialog({ patientId, profile, canEditDiagnoses, onCancel, onSaved }) {
  const api = useEyeApi();
  const [draft, setDraft] = useState(() => ({
    allergies: profile?.allergies || [],
    noKnownAllergies: Boolean(profile?.noKnownAllergies),
    diagnoses: profile?.diagnoses || [],
    medicalHistory: profile?.medicalHistory || "",
    ophthalmicHistory: profile?.ophthalmicHistory || "",
    contactLensUser: Boolean(profile?.contactLensUser)
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const setAllergy = (index, patch) => setDraft({ ...draft, allergies: draft.allergies.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const setDiagnosis = (index, patch) => setDraft({ ...draft, diagnoses: draft.diagnoses.map((item, i) => (i === index ? { ...item, ...patch } : item)) });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api(`/v1/eye/patients/${patientId}/profile`, {
        method: "PUT",
        body: { ...draft, expectedRevision: profile?.revision || 0 }
      });
      onSaved(payload.profile);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="profile-heading" className="dialog dialog-wide" onSubmit={submit} role="dialog">
        <h2 id="profile-heading">アレルギー・病名・既往</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

        <h3>アレルギー・副作用歴</h3>
        <label className="check-line">
          <input checked={draft.noKnownAllergies} disabled={draft.allergies.length > 0} onChange={(event) => setDraft({ ...draft, noKnownAllergies: event.target.checked })} type="checkbox" />
          アレルギー・副作用歴なし（本人に確認済み）
        </label>
        {draft.allergies.map((item, index) => (
          <div className="row-line" key={item.allergyId || index}>
            <select aria-label="分類" className="input" onChange={(event) => setAllergy(index, { category: event.target.value })} value={item.category}>
              {Object.entries(ALLERGY_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input aria-label="原因" className="input grow" onChange={(event) => setAllergy(index, { substance: event.target.value })} placeholder="原因（薬剤名・成分など）" required value={item.substance} />
            <input aria-label="症状" className="input grow" onChange={(event) => setAllergy(index, { reaction: event.target.value })} placeholder="症状（発疹など）" value={item.reaction} />
            <select aria-label="程度" className="input" onChange={(event) => setAllergy(index, { severity: event.target.value })} value={item.severity}>
              {Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button aria-label="このアレルギーを削除" className="btn btn-chip danger-text" onClick={() => setDraft({ ...draft, allergies: draft.allergies.filter((_, i) => i !== index) })} type="button">削除</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => setDraft({ ...draft, noKnownAllergies: false, allergies: [...draft.allergies, { category: "drug", substance: "", reaction: "", severity: "unknown" }] })} type="button">アレルギーを追加</button>

        <h3>傷病名{canEditDiagnoses ? "" : "（変更は医師のみ）"}</h3>
        <fieldset className="plain-fieldset" disabled={!canEditDiagnoses}>
          {draft.diagnoses.map((item, index) => (
            <div className="dx-row" key={item.diagnosisId || index}>
              <div className="row-line">
                <label className="inline-field" title="主病名"><input checked={Boolean(item.primary)} onChange={(event) => setDiagnosis(index, { primary: event.target.checked })} type="checkbox" /><span>主</span></label>
                <input aria-label="傷病名" className="input grow" list="common-diagnoses" onChange={(event) => setDiagnosis(index, { name: event.target.value })} placeholder="傷病名" required value={item.name} />
                <select aria-label="眼" className="input" onChange={(event) => setDiagnosis(index, { eye: event.target.value })} value={item.eye}>
                  {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select aria-label="状態" className="input" onChange={(event) => setDiagnosis(index, { status: event.target.value, outcome: event.target.value === "resolved" ? (item.outcome || "cured") : "" })} value={item.status}>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <button aria-label="この傷病名を削除" className="btn btn-chip danger-text" onClick={() => setDraft({ ...draft, diagnoses: draft.diagnoses.filter((_, i) => i !== index) })} type="button">削除</button>
              </div>
              <div className="row-line">
                <label className="inline-field"><span>開始日</span><input className="input" onChange={(event) => setDiagnosis(index, { startDate: event.target.value })} type="date" value={item.startDate || ""} /></label>
                {item.status === "resolved" ? (
                  <>
                    <label className="inline-field"><span>終了日</span><input className="input" onChange={(event) => setDiagnosis(index, { endDate: event.target.value })} type="date" value={item.endDate || ""} /></label>
                    <label className="inline-field">
                      <span>転帰</span>
                      <select className="input" onChange={(event) => setDiagnosis(index, { outcome: event.target.value })} value={item.outcome || "cured"}>
                        {Object.entries(OUTCOME_LABELS).filter(([value]) => value).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                  </>
                ) : null}
              </div>
            </div>
          ))}
          <button className="btn btn-ghost" onClick={() => setDraft({ ...draft, diagnoses: [...draft.diagnoses, { name: "", eye: "ou", status: "active", startDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), endDate: "", outcome: "", primary: false, note: "" }] })} type="button">傷病名を追加</button>
        </fieldset>

        <h3>既往・その他</h3>
        <label className="check-line"><input checked={draft.contactLensUser} onChange={(event) => setDraft({ ...draft, contactLensUser: event.target.checked })} type="checkbox" />コンタクトレンズ装用者</label>
        <label className="field"><span>眼科既往（手術・外傷など）</span><textarea className="input" onChange={(event) => setDraft({ ...draft, ophthalmicHistory: event.target.value })} rows={2} value={draft.ophthalmicHistory} /></label>
        <label className="field"><span>全身既往・内服</span><textarea className="input" onChange={(event) => setDraft({ ...draft, medicalHistory: event.target.value })} rows={2} value={draft.medicalHistory} /></label>

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy} type="submit">保存</button>
        </div>
      </form>
    </div>
  );
}

export const COMMON_DIAGNOSES = [
  "原発開放隅角緑内障", "正常眼圧緑内障", "原発閉塞隅角緑内障", "高眼圧症", "加齢性白内障", "白内障術後", "後発白内障",
  "糖尿病網膜症", "糖尿病黄斑浮腫", "滲出型加齢黄斑変性", "網膜静脈分枝閉塞症", "網膜剥離", "網膜裂孔", "後部硝子体剥離",
  "アレルギー性結膜炎", "細菌性結膜炎", "流行性角結膜炎", "ドライアイ", "眼精疲労", "近視", "遠視", "乱視", "老視",
  "麦粒腫", "霰粒腫", "飛蚊症", "角膜びらん", "眼瞼下垂", "斜視", "弱視"
];

export function CommonDiagnosesList() {
  return (
    <datalist id="common-diagnoses">
      {COMMON_DIAGNOSES.map((name) => <option key={name} value={name} />)}
    </datalist>
  );
}
