"use client";

import { useEffect, useMemo, useState } from "react";
import { diagnosisName } from "@halunasu/eye-core";
import { isSuspectedDiagnosis } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { useMasterSearch } from "./chart-shared";
import { COMMON_DIAGNOSES } from "./patient-banner";
import { EYE_LABELS, formatDate } from "../lib/format";

const OUTCOMES = [["", "継続"], ["cured", "治癒"], ["discontinued", "中止"], ["deceased", "死亡"], ["transferred", "移行（転医）"], ["other", "その他"]];
const OUTCOME_LABELS = Object.fromEntries(OUTCOMES);
const EYES = [["od", "右"], ["os", "左"], ["ou", "両"]];
export const DEFAULT_DEPARTMENT = "眼科";

// 病名の保存（患者ごと）。アレルギー・既往などほかの項目は今の値のまま送る。
export function useSaveDiagnoses(patientId, profile, onSaved) {
  const api = useEyeApi();
  return async (diagnoses) => {
    const payload = await api(`/v1/eye/patients/${patientId}/profile`, {
      method: "PUT",
      body: {
        allergies: profile?.allergies || [],
        noKnownAllergies: Boolean(profile?.noKnownAllergies),
        diagnoses,
        medicalHistory: profile?.medicalHistory || "",
        ophthalmicHistory: profile?.ophthalmicHistory || "",
        contactLensUser: Boolean(profile?.contactLensUser),
        expectedRevision: profile?.revision || 0
      }
    });
    onSaved(payload.profile);
    return payload.profile;
  };
}

const monthStart = (iso) => `${String(iso || "").slice(0, 7)}-01`;

// 左の「病名」タブ（デジカルの傷病名タブ）。表・新規登録（検索して［確定］［主病］［疑い］）・編集・一括転帰。
// レセコン送信（デジカルの傷病名タブの［レセコン送信］）: 病名は確定のときに今日のカルテへ写り、会計連携の送信でレセコンへ渡る。
// sendState が "finalized" なら onSend（カルテ画面の［送信］と同じ会計連携）を開き、"draft" なら確定が先であることを知らせる。
export function DiagnosisTab({ profile, patientId, canEdit, encounterDate, onSaved, learning, addOpen, setAddOpen, onSend = null, sendState = "" }) {
  const save = useSaveDiagnoses(patientId, profile, onSaved);
  const [thisMonth, setThisMonth] = useState(true);
  const [checked, setChecked] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [sortAsc, setSortAsc] = useState(false);
  const [error, setError] = useState("");
  const [sendNote, setSendNote] = useState("");
  const all = profile?.diagnoses || [];
  const rows = useMemo(() => all
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !thisMonth || item.status !== "resolved" || !item.endDate || item.endDate >= monthStart(encounterDate))
    .sort((left, right) => {
      const order = String(left.item.startDate || "").localeCompare(String(right.item.startDate || ""));
      return (sortAsc ? order : -order) || Number(Boolean(right.item.primary)) - Number(Boolean(left.item.primary));
    }), [all, thisMonth, encounterDate, sortAsc]);

  async function run(next) {
    setError("");
    try {
      await save(next);
      return true;
    } catch (nextError) {
      setError(nextError.message);
      return false;
    }
  }
  const toggle = (index) => {
    const next = new Set(checked);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setChecked(next);
  };

  return (
    <div className="dx-tab">
      <div className="pane-tools">
        {canEdit ? (
          <>
            <button className="btn btn-chip" disabled={!checked.size} onClick={async () => { if (await run(all.filter((_, index) => !checked.has(index)))) setChecked(new Set()); }} type="button">削除</button>
            <button className="btn btn-chip" disabled={!checked.size} onClick={() => setBulk(true)} type="button">一括転帰</button>
          </>
        ) : null}
        <span className="pane-tools-spacer" />
        <label className="check-line small"><input checked={thisMonth} onChange={(event) => setThisMonth(event.target.checked)} type="checkbox" />当月有効</label>
        {onSend ? (
          <button
            className="btn btn-chip dx-send"
            onClick={() => {
              if (sendState === "finalized") {
                setSendNote("");
                onSend();
              } else {
                setSendNote("病名は、今日のカルテを確定（→ 次へ）したときにカルテへ写り、会計連携の送信でレセコンへ渡ります。確定のあとにもう一度押してください。");
              }
            }}
            title="病名を会計連携（レセコン）へ送る"
            type="button"
          >
            レセコン送信
          </button>
        ) : null}
        {canEdit ? <button aria-label="病名を追加" className="btn btn-chip" onClick={() => setAddOpen(true)} title="病名を追加（B）" type="button">＋</button> : null}
      </div>
      {sendNote ? <p className="alert alert-ok small dx-send-note" role="status">{sendNote} <button className="btn btn-chip" onClick={() => setSendNote("")} type="button">閉じる</button></p> : null}
      {error ? <p className="alert alert-danger small" role="alert">{error}</p> : null}
      {rows.length === 0 ? <p className="empty">{all.length ? "当月有効の病名はありません。" : "登録された病名はありません。"}</p> : (
        <div className="table-scroll">
          <table className="data-table dx-table">
            <thead>
              <tr>
                {canEdit ? <th aria-label="選択" scope="col" /> : null}
                <th className="dx-col-primary" scope="col">主</th>
                <th scope="col">傷病名</th>
                <th scope="col">眼</th>
                <th className="dx-col-suspect" scope="col">疑い</th>
                <th aria-sort={sortAsc ? "ascending" : "descending"} scope="col">
                  <button className="link-button" onClick={() => setSortAsc(!sortAsc)} type="button">開始日{sortAsc ? "▲" : "▼"}</button>
                </th>
                <th className="dx-col-end" scope="col">転帰日</th>
                <th scope="col">転帰</th>
                <th className="dx-col-dept" scope="col">診療科</th>
                {canEdit ? <th aria-label="編集" scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, index }) => (
                <tr className={item.status === "resolved" ? "is-resolved" : ""} key={item.diagnosisId || index}>
                  {/* 選ぶチェックはセルいっぱいの label で包み、指で押しやすくする */}
                  {canEdit ? <td className="dx-check-cell"><label className="dx-check"><input aria-label={`${item.name}を選ぶ`} checked={checked.has(index)} onChange={() => toggle(index)} type="checkbox" /></label></td> : null}
                  <td className="dx-col-primary">{item.primary ? <span className="dx-primary">主</span> : ""}</td>
                  <td className="dx-name">
                    {/* ペインが狭いときは「主」「疑い」の列を省き、ここにバッジで出す */}
                    {item.primary ? <span className="dx-primary dx-inline-flag">主</span> : null}
                    {isSuspectedDiagnosis(item) ? <span className="dx-primary dx-inline-flag is-suspect">疑</span> : null}
                    {diagnosisName(item)}
                    {item.code ? <span className="dx-code">{item.code}</span> : null}
                    {item.note ? <span className="muted small dx-note">{item.note}</span> : null}
                    {item.department ? <span className="dx-inline-dept">{item.department}</span> : null}
                  </td>
                  <td>{EYE_LABELS[item.eye] ? EYE_LABELS[item.eye].slice(0, 1) : ""}</td>
                  <td className="dx-col-suspect">{isSuspectedDiagnosis(item) ? "疑" : ""}</td>
                  <td className="dx-date">{item.startDate ? formatDate(item.startDate) : ""}</td>
                  <td className="dx-col-end dx-date">{item.endDate ? formatDate(item.endDate) : ""}</td>
                  <td>
                    {item.status === "resolved" ? OUTCOME_LABELS[item.outcome || "cured"] || "治癒" : ""}
                    {/* 狭いときは転帰日の列を省き、転帰の下に出す */}
                    {item.endDate ? <span className="dx-inline-date">{formatDate(item.endDate)}</span> : null}
                  </td>
                  <td className="dx-col-dept">{item.department || ""}</td>
                  {canEdit ? <td><button aria-label={`${item.name}を編集`} className="btn btn-chip" onClick={() => setEditing(index)} type="button">✎</button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canEdit ? <p className="muted small">病名の変更は医師が行います。</p> : null}
      {addOpen ? (
        <DiagnosisAddDialog
          encounterDate={encounterDate}
          learning={learning}
          onAdd={(item) => run([...all, item])}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      {editing !== null && all[editing] ? (
        <DiagnosisEditDialog
          item={all[editing]}
          onCancel={() => setEditing(null)}
          onDelete={async () => { if (await run(all.filter((_, index) => index !== editing))) setEditing(null); }}
          onSave={async (next) => { if (await run(all.map((item, index) => (index === editing ? next : item)))) setEditing(null); }}
        />
      ) : null}
      {bulk ? (
        <BulkOutcomeDialog
          defaultDate={encounterDate}
          onCancel={() => setBulk(false)}
          onSave={async ({ outcome, endDate }) => {
            const next = all.map((item, index) => (checked.has(index) && item.status !== "resolved"
              ? { ...item, status: "resolved", outcome, endDate }
              : item));
            if (await run(next)) {
              setBulk(false);
              setChecked(new Set());
            }
          }}
        />
      ) : null}
    </div>
  );
}

// 新規登録: 検索（空なら学習リスト・よく使う病名）→ 行ごとに［確定］［主病］［疑い］。押すとすぐ登録し、ダイアログは開いたまま。
function DiagnosisAddDialog({ encounterDate, learning, onAdd, onClose }) {
  const [query, setQuery] = useState("");
  const [eye, setEye] = useState("ou");
  const [eyeOnly, setEyeOnly] = useState(true);
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState(false);
  const search = useMasterSearch("disease", query, { eyeOnly });
  const suggestions = query.trim()
    ? search.results.map((item) => ({ key: item.code, name: item.name, code: item.code }))
    : [
      ...(learning || []).map((item) => ({ key: `l-${item.key || item.label}`, name: item.rows?.[0]?.name || item.label, code: item.rows?.[0]?.code || "", modifiers: item.rows?.[0]?.modifiers, learned: item.count })),
      ...COMMON_DIAGNOSES.map((name) => ({ key: `c-${name}`, name, code: "" }))
    ].filter((item, index, list) => list.findIndex((other) => other.name === item.name) === index).slice(0, 40);

  async function add(entry, mode) {
    setBusy(true);
    const ok = await onAdd({
      name: entry.name,
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.modifiers?.length ? { modifiers: entry.modifiers } : {}),
      eye,
      status: "active",
      startDate: encounterDate,
      endDate: "",
      outcome: "",
      primary: mode === "primary",
      ...(mode === "suspected" ? { suspected: true } : {}),
      department: DEFAULT_DEPARTMENT,
      note: ""
    });
    setBusy(false);
    if (ok) setAdded((current) => [...current, `${entry.name}${mode === "suspected" ? "（疑い）" : mode === "primary" ? "（主病）" : ""}`]);
  }

  const buttons = (entry) => (
    <span className="dx-add-actions">
      <button className="btn btn-chip" disabled={busy} onClick={() => add(entry, "confirmed")} type="button">確定</button>
      <button className="btn btn-chip" disabled={busy} onClick={() => add(entry, "primary")} type="button">主病</button>
      <button className="btn btn-chip" disabled={busy} onClick={() => add(entry, "suspected")} type="button">疑い</button>
    </span>
  );

  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="dx-add-heading" className="dialog dialog-wide dx-add-dialog" role="dialog">
        <h2 id="dx-add-heading">傷病名新規登録</h2>
        <div className="dx-add-search">
          <input aria-label="傷病名を検索" autoFocus className="input grow" onChange={(event) => setQuery(event.target.value)} placeholder="傷病名・カナで検索" value={query} />
          <span aria-label="眼" className="segmented" role="group">
            {EYES.map(([key, label]) => <button aria-pressed={eye === key} key={key} onClick={() => setEye(key)} type="button">{label}</button>)}
          </span>
          <label className="check-line small"><input checked={eyeOnly} onChange={(event) => setEyeOnly(event.target.checked)} type="checkbox" />眼科のみ</label>
        </div>
        <p className="muted small">開始日は診療日（{formatDate(encounterDate)}）になります。{query.trim() ? "" : "空欄のときは、この医院でよく使う病名を出しています。"}</p>
        {search.error ? <p className="alert alert-danger small">{search.error}</p> : null}
        <ul className="dx-add-list">
          {suggestions.map((entry) => (
            <li className="dx-add-row" key={entry.key}>
              <span className="dx-add-name">{entry.name}{entry.code ? <span className="dx-code">{entry.code}</span> : null}{entry.learned ? <span className="muted small"> {entry.learned}回</span> : null}</span>
              {buttons(entry)}
            </li>
          ))}
          {query.trim() && !search.loading && !suggestions.some((entry) => entry.name === query.trim()) ? (
            <li className="dx-add-row is-free">
              <span className="dx-add-name">「{query.trim()}」をそのまま登録（コードなし）</span>
              {buttons({ name: query.trim(), code: "" })}
            </li>
          ) : null}
          {search.loading ? <li className="muted small">検索中…</li> : null}
        </ul>
        {added.length ? <p className="alert alert-ok small" role="status">登録しました: {added.join("、")}</p> : null}
        <div className="dialog-actions">
          <button className="btn btn-primary" onClick={onClose} type="button">閉じる</button>
        </div>
      </div>
    </div>
  );
}

// 編集: 左にフォーム（主病 → 傷病名＋疑い → 補足 → 開始日 → 転帰・転帰日 → 診療科）、右に修飾語の検索。
function DiagnosisEditDialog({ item, onSave, onCancel, onDelete }) {
  const [draft, setDraft] = useState(() => ({
    ...item,
    suspected: isSuspectedDiagnosis(item),
    status: item.status === "suspected" ? "active" : item.status,
    modifiers: item.modifiers || []
  }));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const search = useMasterSearch("modifier", query);
  const common = useCommonModifiers();
  const candidates = query.trim() ? search.results : common.results;
  const outcome = draft.status === "resolved" ? draft.outcome || "cured" : "";
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const setOutcome = (value) => set(value ? { status: "resolved", outcome: value, endDate: draft.endDate || "" } : { status: "active", outcome: "", endDate: "" });
  const addModifier = (modifier) => set({ modifiers: [...draft.modifiers, { code: modifier.code, name: modifier.name, position: modifier.position === "suffix" ? "suffix" : "prefix" }] });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    const { suspected, ...rest } = draft;
    await onSave({ ...rest, status: draft.status, ...(suspected ? { suspected: true } : { suspected: false }), modifiers: draft.modifiers });
    setBusy(false);
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="dx-edit-heading" className="dialog dialog-wide dx-edit-dialog" onSubmit={submit} role="dialog">
        <h2 id="dx-edit-heading">傷病名編集</h2>
        <div className="dx-edit-grid">
          <div className="dx-edit-form">
            <label className="check-line"><input checked={Boolean(draft.primary)} onChange={(event) => set({ primary: event.target.checked })} type="checkbox" />主病</label>
            <div className="dx-edit-name">
              <label className="field grow">
                <span>傷病名{draft.code ? <span className="dx-code">{draft.code}</span> : null}</span>
                <input aria-label="傷病名" className="input" maxLength={200} onChange={(event) => set({ name: event.target.value })} required value={draft.name} />
              </label>
              <label className="check-line"><input checked={draft.suspected} onChange={(event) => set({ suspected: event.target.checked })} type="checkbox" />疑い</label>
            </div>
            {draft.modifiers.length ? (
              <p className="dx-modifiers">
                表示: <strong>{diagnosisName(draft)}</strong>
                {draft.modifiers.map((modifier, index) => (
                  <button aria-label={`修飾語「${modifier.name}」を外す`} className="btn btn-chip" key={`${modifier.code || modifier.name}-${index}`} onClick={() => set({ modifiers: draft.modifiers.filter((_, modifierIndex) => modifierIndex !== index) })} type="button">{modifier.name} ×</button>
                ))}
              </p>
            ) : null}
            <label className="field">
              <span>眼</span>
              <select aria-label="眼" className="input" onChange={(event) => set({ eye: event.target.value })} value={draft.eye || "ou"}>
                {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>傷病名補足</span>
              <input aria-label="傷病名補足" className="input" maxLength={200} onChange={(event) => set({ note: event.target.value })} value={draft.note || ""} />
            </label>
            <label className="field">
              <span>開始日</span>
              <input aria-label="開始日" className="input input-date" onChange={(event) => set({ startDate: event.target.value })} type="date" value={draft.startDate || ""} />
            </label>
            <fieldset className="field plain-fieldset">
              <legend className="field-legend">転帰</legend>
              <div className="dx-outcomes" role="radiogroup">
                {OUTCOMES.map(([value, label]) => (
                  <label className="check-line" key={value || "active"}>
                    <input checked={outcome === value} name="dx-outcome" onChange={() => setOutcome(value)} type="radio" />{label}
                  </label>
                ))}
              </div>
              {draft.status === "resolved" ? (
                <label className="inline-field"><span>転帰日</span><input aria-label="転帰日" className="input input-date" onChange={(event) => set({ endDate: event.target.value })} type="date" value={draft.endDate || ""} /></label>
              ) : null}
            </fieldset>
            <label className="field">
              <span>診療科</span>
              <input aria-label="診療科" className="input" maxLength={40} onChange={(event) => set({ department: event.target.value })} value={draft.department || ""} />
            </label>
          </div>
          <div className="dx-edit-modifiers">
            <h3>修飾語</h3>
            <input aria-label="修飾語を検索" className="input" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} placeholder="修飾語を検索（例: 急性・術後）" value={query} />
            <p className="muted small dx-modifier-hint">{query.trim() ? "押すと傷病名に付きます。" : "よく使う修飾語です。押すと傷病名に付きます（前 = 病名の前、後 = 病名の後）。"}</p>
            <ul aria-label="修飾語の候補" className="dx-modifier-list dx-modifier-candidates">
              {candidates.map((modifier) => (
                <li key={modifier.code}>
                  <button aria-label={`修飾語「${modifier.name}」を付ける（${modifier.position === "suffix" ? "後" : "前"}）`} className="dx-modifier-pick" onClick={() => addModifier(modifier)} type="button">
                    <span aria-hidden="true" className={`dx-modifier-pos${modifier.position === "suffix" ? " is-suffix" : ""}`}>{modifier.position === "suffix" ? "後" : "前"}</span>
                    <span>{modifier.name}</span>
                  </button>
                </li>
              ))}
              {query.trim() && search.loading ? <li className="muted small">検索中…</li> : null}
              {query.trim() && !search.loading && !search.results.length ? <li className="muted small">見つかりません。</li> : null}
              {!query.trim() && common.error ? <li className="muted small">候補を読み込めませんでした。検索してください。</li> : null}
            </ul>
          </div>
        </div>
        <div className="dialog-actions">
          {confirmDelete ? (
            <button className="btn btn-danger dialog-action-left" onClick={onDelete} type="button">本当に削除する</button>
          ) : (
            <button className="btn btn-ghost danger-text dialog-action-left" onClick={() => setConfirmDelete(true)} type="button">削除</button>
          )}
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy} type="submit">保存</button>
        </div>
      </form>
    </div>
  );
}

// 修飾語の候補（語が空のとき）。公開マスターから眼科でよく使うものを 1 回だけ読む。
function useCommonModifiers() {
  const api = useEyeApi();
  const [state, setState] = useState({ results: [], error: "" });
  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/masters/search?type=modifier&common=1")
      .then((payload) => { if (!cancelled) setState({ results: payload.results || [], error: "" }); })
      .catch((error) => { if (!cancelled) setState({ results: [], error: error.message }); });
    return () => { cancelled = true; };
  }, [api]);
  return state;
}

function BulkOutcomeDialog({ defaultDate, onSave, onCancel }) {
  const [endDate, setEndDate] = useState(defaultDate);
  const [outcome, setOutcome] = useState("cured");
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="dx-bulk-heading" className="dialog" role="dialog">
        <h2 id="dx-bulk-heading">一括転帰</h2>
        <p className="muted small">選んだ病名のうち、転帰がまだ入っていないものにだけ入れます。</p>
        <label className="field"><span>転帰日</span><input aria-label="転帰日" className="input input-date" onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} /></label>
        <label className="field">
          <span>転帰</span>
          <select aria-label="転帰" className="input" onChange={(event) => setOutcome(event.target.value)} value={outcome}>
            {OUTCOMES.filter(([value]) => value).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !endDate} onClick={async () => { setBusy(true); await onSave({ outcome, endDate }); setBusy(false); }} type="button">登録</button>
        </div>
      </div>
    </div>
  );
}
