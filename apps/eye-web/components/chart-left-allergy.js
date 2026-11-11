"use client";

import { useState } from "react";
import { useMasterSearch } from "./chart-shared";
import { DeleteButton, LeftDialog, OnsetField, onsetText, saveErrorMessage, SectionHead, useSaveProfileSection } from "./chart-left-shared";

const CATEGORY_LABELS = { drug: "薬剤", food: "食物", contrast: "造影剤", latex: "ラテックス", other: "その他" };
const SEVERITY_LABELS = { unknown: "程度不明", mild: "軽度", moderate: "中等度", severe: "重篤" };

// 左「副作用薬等」（デジカルの副作用薬等タブ）。アレルギー・副作用薬・常用薬・既往歴の区画が縦に並び、
// 区画ごとに［＋］で追加、行の［✎］で編集ダイアログを開く。保存は区画ごと（ほかの区画は変えない）。
export function SideEffectsTab({ patientId, profile, context, onSaved }) {
  const save = useSaveProfileSection(patientId, profile, onSaved);
  const canEdit = Boolean(context?.canEditProfile);
  const [dialog, setDialog] = useState(null);
  const allergies = profile?.allergies || [];
  const adverse = profile?.adverseDrugs || [];
  const meds = profile?.regularMedications || [];
  const close = () => setDialog(null);
  const plus = (label, kind) => (canEdit ? (
    <button aria-label={`${label}を追加`} className="btn btn-chip cl-plus" onClick={() => setDialog({ kind, index: -1 })} title={`${label}を追加`} type="button">＋</button>
  ) : null);
  const pencil = (label, kind, index) => (canEdit ? (
    <button aria-label={`${label}を編集`} className="btn btn-chip cl-pencil" onClick={() => setDialog({ kind, index })} title="編集" type="button">✎</button>
  ) : null);

  return (
    <div className="cl-sections">
      <section aria-labelledby="cl-allergy" className="cl-section">
        <SectionHead count={allergies.length || null} id="cl-allergy" title="アレルギー">{plus("アレルギー", "allergy")}</SectionHead>
        {allergies.length ? (
          <table className="data-table cl-table">
            <thead><tr><th scope="col">アレルゲン</th><th scope="col">症状</th><th scope="col">発症</th><th scope="col">程度</th>{canEdit ? <th aria-label="編集" scope="col" /> : null}</tr></thead>
            <tbody>
              {allergies.map((item, index) => (
                <tr className={item.severity === "severe" ? "is-severe" : ""} key={item.allergyId || index}>
                  <td><span className="cl-kind">{CATEGORY_LABELS[item.category] || "薬剤"}</span>{item.substance}</td>
                  <td>{item.reaction || "—"}</td>
                  <td className="cl-nowrap">{onsetText(item.onset) || "—"}</td>
                  <td className="cl-nowrap">{SEVERITY_LABELS[item.severity] || ""}</td>
                  {canEdit ? <td className="cl-edit-cell">{pencil(item.substance, "allergy", index)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="cl-empty-line">
            <p className="empty">{profile?.noKnownAllergies ? "アレルギー・副作用歴なし（本人に確認済み）" : "アレルギーは登録されていません。"}</p>
            {canEdit && !profile?.noKnownAllergies ? <NoneConfirmButton onConfirm={() => save("allergies", { allergies: [], noKnownAllergies: true })} /> : null}
          </div>
        )}
      </section>

      <section aria-labelledby="cl-adverse" className="cl-section">
        <SectionHead count={adverse.length || null} id="cl-adverse" title="副作用薬">{plus("副作用薬", "adverse-add")}</SectionHead>
        {adverse.length ? (
          <table className="data-table cl-table">
            <thead><tr><th scope="col">薬品名</th><th scope="col">症状</th><th scope="col">発症</th>{canEdit ? <th aria-label="編集" scope="col" /> : null}</tr></thead>
            <tbody>
              {adverse.map((item, index) => (
                <tr key={item.itemId || index}>
                  <td>{item.name}{item.note ? <span className="muted small cl-sub">{item.note}</span> : null}</td>
                  <td>{item.reaction || "—"}</td>
                  <td className="cl-nowrap">{onsetText(item.onset) || "—"}</td>
                  {canEdit ? <td className="cl-edit-cell">{pencil(item.name, "adverse", index)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">副作用薬は登録されていません。</p>}
      </section>

      <section aria-labelledby="cl-regular" className="cl-section">
        <SectionHead count={meds.length || null} id="cl-regular" title="常用薬">{plus("常用薬", "regular-add")}</SectionHead>
        {meds.length ? (
          <table className="data-table cl-table">
            <thead><tr><th scope="col">薬品名</th><th scope="col">用法等</th><th className="cl-nowrap" scope="col">服用中</th>{canEdit ? <th aria-label="編集" scope="col" /> : null}</tr></thead>
            <tbody>
              {meds.map((item, index) => (
                <tr className={item.current === false ? "is-past" : ""} key={item.itemId || index}>
                  <td>{item.name}{item.note ? <span className="muted small cl-sub">{item.note}</span> : null}</td>
                  <td>{item.usage || "—"}</td>
                  <td className="cl-center">{item.current === false ? "" : "✓"}</td>
                  {canEdit ? <td className="cl-edit-cell">{pencil(item.name, "regular", index)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">常用薬は登録されていません。</p>}
      </section>

      <section aria-labelledby="cl-past" className="cl-section">
        <SectionHead id="cl-past" title="既往歴">{canEdit ? <button aria-label="既往歴を編集" className="btn btn-chip cl-pencil" onClick={() => setDialog({ kind: "history" })} title="編集" type="button">✎</button> : null}</SectionHead>
        <dl className="cl-kv">
          <dt>全身既往・内服</dt><dd className="pre">{profile?.medicalHistory || <span className="muted">未記入</span>}</dd>
          <dt>眼科既往</dt><dd className="pre">{profile?.ophthalmicHistory || <span className="muted">未記入</span>}</dd>
          <dt>CL</dt><dd>{profile?.contactLensUser ? "装用" : "—"}</dd>
        </dl>
      </section>
      {!canEdit ? <p className="muted small">この役割では編集できません。</p> : null}

      {dialog?.kind === "allergy" ? (
        <AllergyDialog
          item={dialog.index >= 0 ? allergies[dialog.index] : null}
          onClose={close}
          onDelete={() => save("allergies", { allergies: allergies.filter((_, index) => index !== dialog.index), noKnownAllergies: false })}
          onSave={(next) => save("allergies", { allergies: dialog.index >= 0 ? allergies.map((item, index) => (index === dialog.index ? next : item)) : [...allergies, next], noKnownAllergies: false })}
        />
      ) : null}
      {dialog?.kind === "adverse-add" || dialog?.kind === "regular-add" ? (
        <DrugAddDialog
          existing={dialog.kind === "adverse-add" ? adverse : meds}
          onAdd={(drug) => (dialog.kind === "adverse-add"
            ? save("adverseDrugs", [...adverse, { name: drug.name, ...(drug.code ? { code: drug.code } : {}), reaction: "", note: "" }])
            : save("regularMedications", [...meds, { name: drug.name, ...(drug.code ? { code: drug.code } : {}), usage: "", current: true, note: "" }]))}
          onClose={close}
          title={dialog.kind === "adverse-add" ? "副作用薬の追加" : "常用薬の追加"}
        />
      ) : null}
      {dialog?.kind === "adverse" && adverse[dialog.index] ? (
        <AdverseDialog
          item={adverse[dialog.index]}
          onClose={close}
          onDelete={() => save("adverseDrugs", adverse.filter((_, index) => index !== dialog.index))}
          onSave={(next) => save("adverseDrugs", adverse.map((item, index) => (index === dialog.index ? next : item)))}
        />
      ) : null}
      {dialog?.kind === "regular" && meds[dialog.index] ? (
        <RegularDialog
          item={meds[dialog.index]}
          onClose={close}
          onDelete={() => save("regularMedications", meds.filter((_, index) => index !== dialog.index))}
          onSave={(next) => save("regularMedications", meds.map((item, index) => (index === dialog.index ? next : item)))}
        />
      ) : null}
      {dialog?.kind === "history" ? <PastHistoryDialog onClose={close} onSave={(next) => save("history", next)} profile={profile} /> : null}
    </div>
  );
}

function NoneConfirmButton({ onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button className="btn btn-chip" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await onConfirm(); } catch (nextError) { setError(saveErrorMessage(nextError)); } finally { setBusy(false); } }} type="button">なし（確認済み）にする</button>
      {error ? <p className="alert alert-danger small" role="alert">{error}</p> : null}
    </>
  );
}

// 保存・削除の共通の流れ（失敗したらダイアログに残してエラーを出す）。
function useDialogSave(onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [armed, setArmed] = useState(false);
  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      onClose();
    } catch (nextError) {
      setError(saveErrorMessage(nextError));
      setBusy(false);
    }
  }
  return { busy, error, armed, setArmed, run };
}

function AllergyDialog({ item, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => ({ category: "drug", substance: "", reaction: "", severity: "unknown", onset: "", ...(item || {}) }));
  const state = useDialogSave(onClose);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <LeftDialog
      busy={state.busy}
      error={state.error}
      footerLeft={item ? <DeleteButton armed={state.armed} disabled={state.busy} onArm={() => state.setArmed(true)} onDelete={() => state.run(onDelete)} /> : null}
      onClose={onClose}
      onSubmit={() => {
        const { onset, ...rest } = draft;
        return state.run(() => onSave({ ...rest, substance: draft.substance.trim(), reaction: draft.reaction.trim(), ...(onset ? { onset } : {}) }));
      }}
      submitLabel={item ? "更新" : "登録"}
      title={item ? "アレルギーの編集" : "アレルギーの追加"}
    >
      <div className="cl-form">
        <label className="cl-row"><span>分類</span>
          <select aria-label="分類" className="input" onChange={(event) => set({ category: event.target.value })} value={draft.category}>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="cl-row"><span>アレルゲン</span><input aria-label="アレルゲン" className="input" maxLength={200} onChange={(event) => set({ substance: event.target.value })} placeholder="薬剤名・成分・食物など" required value={draft.substance} /></label>
        <div className="cl-row"><span>発症時期</span><OnsetField onChange={(onset) => set({ onset })} value={draft.onset} /></div>
        <label className="cl-row"><span>症状</span><input aria-label="症状" className="input" maxLength={200} onChange={(event) => set({ reaction: event.target.value })} placeholder="発疹・呼吸困難など" value={draft.reaction} /></label>
        <label className="cl-row"><span>程度</span>
          <select aria-label="程度" className="input" onChange={(event) => set({ severity: event.target.value })} value={draft.severity}>
            {Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
    </LeftDialog>
  );
}

// 薬の検索 → 行を押すとすぐ登録（ダイアログは開いたまま。続けて登録できる）。マスターにない薬はそのまま登録できる。
function DrugAddDialog({ title, existing, onAdd, onClose }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState([]);
  const search = useMasterSearch("drug", query);
  const have = new Set(existing.map((item) => item.name));
  async function add(drug) {
    setBusy(true);
    setError("");
    try {
      await onAdd(drug);
      setAdded((current) => [...current, drug.name]);
    } catch (nextError) {
      setError(saveErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }
  const free = query.trim();
  return (
    <LeftDialog busy={busy} error={error} onClose={onClose} title={title} wide>
      <input aria-label="医薬品を検索" className="input" onChange={(event) => setQuery(event.target.value)} placeholder="薬品名・カナで検索" value={query} />
      {search.error ? <p className="alert alert-danger small">{search.error}</p> : null}
      <ul className="cl-pick-list">
        {search.results.map((drug) => (
          <li key={drug.code}>
            <button className="cl-pick" disabled={busy || have.has(drug.name)} onClick={() => add(drug)} type="button">
              <span>{drug.name}</span>{have.has(drug.name) ? <span className="muted small">登録済み</span> : null}
            </button>
          </li>
        ))}
        {free && !search.loading && !search.results.some((drug) => drug.name === free) ? (
          <li><button className="cl-pick is-free" disabled={busy || have.has(free)} onClick={() => add({ name: free })} type="button">「{free}」をそのまま登録</button></li>
        ) : null}
        {search.loading ? <li className="muted small">検索中…</li> : null}
        {!free ? <li className="muted small">薬品名を入れると候補が出ます。押すと登録します。</li> : null}
      </ul>
      {added.length ? <p className="alert alert-ok small" role="status">登録しました: {added.join("、")}</p> : null}
    </LeftDialog>
  );
}

function AdverseDialog({ item, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => ({ reaction: "", note: "", onset: "", ...item }));
  const state = useDialogSave(onClose);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <LeftDialog
      busy={state.busy}
      error={state.error}
      footerLeft={<DeleteButton armed={state.armed} disabled={state.busy} onArm={() => state.setArmed(true)} onDelete={() => state.run(onDelete)} />}
      onClose={onClose}
      onSubmit={() => {
        const { onset, ...rest } = draft;
        return state.run(() => onSave({ ...rest, ...(onset ? { onset } : {}) }));
      }}
      submitLabel="更新"
      title="副作用薬の編集"
    >
      <div className="cl-form">
        <div className="cl-row"><span>薬品名</span><strong>{item.name}</strong></div>
        <label className="cl-row"><span>症状</span><input aria-label="症状" className="input" maxLength={200} onChange={(event) => set({ reaction: event.target.value })} placeholder="発疹・肝機能障害など" value={draft.reaction} /></label>
        <div className="cl-row"><span>発症時期</span><OnsetField onChange={(onset) => set({ onset })} value={draft.onset} /></div>
        <label className="cl-row"><span>メモ</span><input aria-label="メモ" className="input" maxLength={200} onChange={(event) => set({ note: event.target.value })} value={draft.note} /></label>
      </div>
    </LeftDialog>
  );
}

function RegularDialog({ item, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => ({ usage: "", note: "", ...item, current: item.current !== false }));
  const state = useDialogSave(onClose);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <LeftDialog
      busy={state.busy}
      error={state.error}
      footerLeft={<DeleteButton armed={state.armed} disabled={state.busy} onArm={() => state.setArmed(true)} onDelete={() => state.run(onDelete)} />}
      onClose={onClose}
      onSubmit={() => state.run(() => onSave(draft))}
      submitLabel="更新"
      title="常用薬の編集"
    >
      <div className="cl-form">
        <div className="cl-row"><span>薬品名</span><strong>{item.name}</strong></div>
        <label className="cl-row"><span>用法等</span><input aria-label="用法等" className="input" maxLength={200} onChange={(event) => set({ usage: event.target.value })} placeholder="1日1回 朝食後 など" value={draft.usage} /></label>
        <label className="cl-row"><span>服用中</span><input aria-label="服用中" checked={draft.current} onChange={(event) => set({ current: event.target.checked })} type="checkbox" /></label>
        <label className="cl-row"><span>メモ</span><input aria-label="メモ" className="input" maxLength={200} onChange={(event) => set({ note: event.target.value })} placeholder="処方元の医療機関など" value={draft.note} /></label>
      </div>
    </LeftDialog>
  );
}

function PastHistoryDialog({ profile, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({
    medicalHistory: profile?.medicalHistory || "",
    ophthalmicHistory: profile?.ophthalmicHistory || "",
    contactLensUser: Boolean(profile?.contactLensUser)
  }));
  const state = useDialogSave(onClose);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <LeftDialog busy={state.busy} error={state.error} onClose={onClose} onSubmit={() => state.run(() => onSave(draft))} submitLabel="更新" title="既往歴の編集" wide>
      <div className="cl-form">
        <label className="cl-row is-top"><span>全身既往・内服</span><textarea aria-label="全身既往・内服" className="input" maxLength={4000} onChange={(event) => set({ medicalHistory: event.target.value })} placeholder="高血圧、糖尿病、抗凝固薬内服 など" rows={3} value={draft.medicalHistory} /></label>
        <label className="cl-row is-top"><span>眼科既往</span><textarea aria-label="眼科既往" className="input" maxLength={4000} onChange={(event) => set({ ophthalmicHistory: event.target.value })} placeholder="手術・外傷など" rows={3} value={draft.ophthalmicHistory} /></label>
        <label className="cl-row"><span>コンタクトレンズ</span><span className="check-line"><input checked={draft.contactLensUser} onChange={(event) => set({ contactLensUser: event.target.checked })} type="checkbox" />装用している</span></label>
      </div>
    </LeftDialog>
  );
}
