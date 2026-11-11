"use client";

import { useMemo, useState } from "react";
import { resolveReferenceRanges } from "@halunasu/eye-core";
import { ResultMatrix } from "./chart-left-matrix";
import { DeleteButton, LeftDialog, saveErrorMessage, SectionHead, useSaveProfileSection } from "./chart-left-shared";
import { formatDate, formatDateTime, formatShortDate } from "../lib/format";

// 左「問診」「バイタル」「サマリー」（デジカルの同名タブ）。どれも患者ごとの記録で、区画ごとに保存する。

// バイタルの項目。基準値は成人の一般的な目安（表の色分けとグラフの破線に使う。診断の基準ではない）。
// ここの ref は既定の値で、医院の設定（設定 › 基準値）があればそちらを使う（VitalsTab の ranges）。
export const VITAL_ITEMS = [
  { key: "systolic", label: "血圧（上）", short: "血圧上", unit: "mmHg", ref: { low: 90, high: 139 }, graphUnit: "血圧 mmHg", step: 1 },
  { key: "diastolic", label: "血圧（下）", short: "血圧下", unit: "mmHg", ref: { high: 89 }, graphUnit: "血圧 mmHg", step: 1 },
  { key: "pulse", label: "脈拍", unit: "回/分", ref: { low: 60, high: 100 }, step: 1 },
  { key: "temperature", label: "体温", unit: "℃", ref: { low: 35.5, high: 37.4 }, step: 0.1 },
  { key: "spo2", label: "SpO2", unit: "%", ref: { low: 96 }, step: 1 },
  { key: "glucose", label: "血糖", unit: "mg/dL", ref: { low: 70, high: 139 }, step: 1 },
  { key: "height", label: "身長", unit: "cm", step: 0.1 },
  { key: "weight", label: "体重", unit: "kg", step: 0.1 }
];

export function bmiOf(entry) {
  if (!Number.isFinite(entry?.height) || !Number.isFinite(entry?.weight) || entry.height <= 0) return null;
  return Math.round((entry.weight / ((entry.height / 100) ** 2)) * 10) / 10;
}

// 主訴・所見へ写す 1 行（血圧は上/下をまとめる）。例「11/11 血圧 128/76 mmHg 体温 36.6 ℃」
export function vitalText(entry, { withDate = true } = {}) {
  const parts = [];
  if (Number.isFinite(entry.systolic) || Number.isFinite(entry.diastolic)) parts.push(`血圧 ${entry.systolic ?? "—"}/${entry.diastolic ?? "—"} mmHg`);
  for (const item of VITAL_ITEMS.filter((vital) => vital.key !== "systolic" && vital.key !== "diastolic")) {
    if (Number.isFinite(entry[item.key])) parts.push(`${item.label} ${entry[item.key]} ${item.unit}`);
  }
  const bmi = bmiOf(entry);
  if (bmi !== null) parts.push(`BMI ${bmi}`);
  if (entry.note) parts.push(entry.note);
  return [withDate ? formatShortDate(entry.date) : "", parts.join(" ")].filter(Boolean).join(" ");
}

export function VitalsTab({ patientId, profile, context, onSaved, encounterDate, onInsert = null, ranges = null }) {
  const save = useSaveProfileSection(patientId, profile, onSaved);
  const canEdit = Boolean(context?.canEditProfile);
  const [dialog, setDialog] = useState(null);
  const vitals = profile?.vitals || [];
  const { columns, rows } = useMemo(() => {
    const columnList = vitals.map((entry) => ({
      key: entry.vitalId,
      date: entry.date,
      label: formatDate(entry.date).slice(2),
      axisLabel: `${Number(entry.date.slice(5, 7))}/${Number(entry.date.slice(8, 10))}`,
      today: entry.date === encounterDate,
      title: "この日のバイタルを編集",
      entry
    }));
    const refs = resolveReferenceRanges(ranges).vitals;
    const rowList = [
      ...VITAL_ITEMS.map((item) => ({
        ...item,
        ref: refs[item.key] || item.ref,
        values: Object.fromEntries(vitals.filter((entry) => Number.isFinite(entry[item.key])).map((entry) => [entry.vitalId, { value: entry[item.key], text: String(entry[item.key]) }]))
      })),
      {
        key: "bmi", label: "BMI", unit: "", ref: refs.bmi,
        values: Object.fromEntries(vitals.map((entry) => [entry.vitalId, bmiOf(entry)]).filter(([, value]) => value !== null).map(([id, value]) => [id, { value, text: String(value) }]))
      }
    ];
    return { columns: columnList, rows: rowList };
  }, [vitals, encounterDate, ranges]);

  return (
    <div className="cl-sections">
      <section aria-labelledby="cl-vitals" className="cl-section">
        <SectionHead count={vitals.length || null} id="cl-vitals" title="バイタル">
          {canEdit ? <button aria-label="バイタルを追加" className="btn btn-chip cl-plus" onClick={() => setDialog({ index: -1 })} title="バイタルを追加" type="button">＋</button> : null}
        </SectionHead>
        <ResultMatrix
          cellTitle={onInsert ? "主訴・所見へ日付つきで書き込む" : ""}
          columns={columns}
          defaultSelected={["systolic", "diastolic"]}
          emptyText="バイタルの記録はありません。"
          label="バイタル"
          onCellClick={onInsert ? (row, column, cell) => onInsert(`${formatShortDate(column.date)} ${row.label} ${cell.text}${row.unit ? ` ${row.unit}` : ""}`) : null}
          onHeaderClick={canEdit ? (column) => setDialog({ index: vitals.findIndex((entry) => entry.vitalId === column.key) }) : null}
          rows={rows}
        />
      </section>
      {dialog ? (
        <VitalDialog
          encounterDate={encounterDate}
          entry={dialog.index >= 0 ? vitals[dialog.index] : null}
          onClose={() => setDialog(null)}
          onDelete={() => save("vitals", vitals.filter((_, index) => index !== dialog.index))}
          onInsert={onInsert}
          onSave={(next) => save("vitals", dialog.index >= 0 ? vitals.map((entry, index) => (index === dialog.index ? next : entry)) : [...vitals, next])}
        />
      ) : null}
    </div>
  );
}

function VitalDialog({ entry, encounterDate, onSave, onDelete, onClose, onInsert }) {
  const [draft, setDraft] = useState(() => ({
    date: entry?.date || encounterDate,
    note: entry?.note || "",
    ...Object.fromEntries(VITAL_ITEMS.map((item) => [item.key, Number.isFinite(entry?.[item.key]) ? String(entry[item.key]) : ""]))
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [armed, setArmed] = useState(false);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const built = () => ({
    ...(entry || {}),
    date: draft.date,
    note: draft.note.trim(),
    ...Object.fromEntries(VITAL_ITEMS.map((item) => [item.key, draft[item.key] === "" ? null : Number(draft[item.key])]))
  });
  const empty = VITAL_ITEMS.every((item) => draft[item.key] === "") && !draft.note.trim();
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
  const submit = (copy) => {
    if (empty) {
      setError("1 つ以上の値を入れてください。");
      return;
    }
    const next = Object.fromEntries(Object.entries(built()).filter(([, value]) => value !== null));
    run(async () => {
      await onSave(next);
      if (copy && onInsert) onInsert(vitalText(next));
    });
  };
  return (
    <LeftDialog
      busy={busy}
      error={error}
      extraActions={onInsert ? <button className="btn btn-ghost" disabled={busy} onClick={() => submit(true)} type="button">登録して複写</button> : null}
      footerLeft={entry ? <DeleteButton armed={armed} disabled={busy} onArm={() => setArmed(true)} onDelete={() => run(onDelete)} /> : null}
      onClose={onClose}
      onSubmit={() => submit(false)}
      submitLabel={entry ? "更新" : "登録"}
      title={entry ? "バイタルの編集" : "バイタルの追加"}
    >
      <div className="cl-form cl-vital-form">
        <label className="cl-row"><span>測定日</span><input aria-label="測定日" className="input input-date" onChange={(event) => set({ date: event.target.value })} required type="date" value={draft.date} /></label>
        {VITAL_ITEMS.map((item) => (
          <label className="cl-row" key={item.key}>
            <span>{item.label}</span>
            <span className="cl-unit-input">
              <input aria-label={item.label} className="input input-num" inputMode="decimal" onChange={(event) => set({ [item.key]: event.target.value.replace(/[^0-9.]/gu, "") })} step={item.step} value={draft[item.key]} />
              <span className="cl-unit">{item.unit}</span>
            </span>
          </label>
        ))}
        <label className="cl-row"><span>メモ</span><input aria-label="バイタルのメモ" className="input" maxLength={200} onChange={(event) => set({ note: event.target.value })} placeholder="測定の条件など" value={draft.note} /></label>
      </div>
    </LeftDialog>
  );
}

// 問診: 日付と内容の一覧（新しい順）。行の［複写］で主訴・所見へ、［✎］で編集。
export function InterviewTab({ patientId, profile, context, onSaved, encounterDate, onInsert = null }) {
  const save = useSaveProfileSection(patientId, profile, onSaved);
  const canEdit = Boolean(context?.canEditProfile);
  const [dialog, setDialog] = useState(null);
  const interviews = profile?.interviews || [];
  return (
    <div className="cl-sections">
      <section aria-labelledby="cl-interview" className="cl-section">
        <SectionHead count={interviews.length || null} id="cl-interview" title="問診">
          {canEdit ? <button aria-label="問診を追加" className="btn btn-chip cl-plus" onClick={() => setDialog({ index: -1 })} title="問診を追加" type="button">＋</button> : null}
        </SectionHead>
        {interviews.length ? (
          <ul className="cl-entries">
            {interviews.map((item, index) => (
              <li className="cl-entry" key={item.interviewId || index}>
                <div className="cl-entry-head">
                  <strong>{formatDate(item.date)}</strong>
                  <span className="muted small">{item.updatedBy?.displayName || ""}</span>
                  <span className="cl-entry-actions">
                    {onInsert ? <button aria-label={`${formatDate(item.date)} の問診を主訴・所見へ複写`} className="btn btn-chip" onClick={() => onInsert(`${formatShortDate(item.date)} 問診: ${item.text}`)} title="主訴・所見へ複写" type="button">複写</button> : null}
                    {canEdit ? <button aria-label={`${formatDate(item.date)} の問診を編集`} className="btn btn-chip cl-pencil" onClick={() => setDialog({ index })} title="編集" type="button">✎</button> : null}
                  </span>
                </div>
                <p className="pre cl-entry-text">{item.text}</p>
              </li>
            ))}
          </ul>
        ) : <p className="empty">問診は登録されていません。</p>}
      </section>
      {dialog ? (
        <TextEntryDialog
          dateValue={dialog.index >= 0 ? interviews[dialog.index].date : encounterDate}
          onClose={() => setDialog(null)}
          onDelete={dialog.index >= 0 ? () => save("interviews", interviews.filter((_, index) => index !== dialog.index)) : null}
          onSave={({ date, text }) => save("interviews", dialog.index >= 0
            ? interviews.map((item, index) => (index === dialog.index ? { ...item, date, text, updatedAt: "", updatedBy: null } : item))
            : [...interviews, { date, text }])}
          textValue={dialog.index >= 0 ? interviews[dialog.index].text : ""}
          title={dialog.index >= 0 ? "問診の編集" : "問診の追加"}
        />
      ) : null}
    </div>
  );
}

function TextEntryDialog({ title, dateValue, textValue, onSave, onDelete, onClose }) {
  const [date, setDate] = useState(dateValue || "");
  const [text, setText] = useState(textValue || "");
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
  return (
    <LeftDialog
      busy={busy}
      error={error}
      footerLeft={onDelete ? <DeleteButton armed={armed} disabled={busy} onArm={() => setArmed(true)} onDelete={() => run(onDelete)} /> : null}
      onClose={onClose}
      onSubmit={() => (text.trim() ? run(() => onSave({ date, text: text.trim() })) : setError("内容を入れてください。"))}
      submitLabel={onDelete ? "更新" : "登録"}
      title={title}
      wide
    >
      <div className="cl-form">
        <label className="cl-row"><span>日付</span><input aria-label="問診の日付" className="input input-date" onChange={(event) => setDate(event.target.value)} required type="date" value={date} /></label>
        <label className="cl-row is-top"><span>内容</span><textarea aria-label="問診の内容" className="input" maxLength={4000} onChange={(event) => setText(event.target.value)} placeholder="来院の理由・いつから・どちらの眼・症状など" rows={6} value={text} /></label>
      </div>
    </LeftDialog>
  );
}

// サマリー: 患者ごとの自由記述 1 つ（経過のまとめ・申し送り）。見出しの［✎］で編集。
export function SummaryTab({ patientId, profile, context, onSaved }) {
  const save = useSaveProfileSection(patientId, profile, onSaved);
  const canEdit = Boolean(context?.canEditProfile);
  const [editing, setEditing] = useState(false);
  const summary = profile?.summary || "";
  return (
    <div className="cl-sections">
      <section aria-labelledby="cl-summary" className="cl-section">
        <SectionHead id="cl-summary" title="サマリー">
          {canEdit ? <button aria-label="サマリーを編集" className="btn btn-chip cl-pencil" onClick={() => setEditing(true)} title="編集" type="button">✎</button> : null}
        </SectionHead>
        {summary ? (
          <>
            <p className="pre cl-summary-text">{summary}</p>
            {profile?.summaryUpdatedAt ? <p className="muted small">更新 {formatDateTime(profile.summaryUpdatedAt)} {profile.summaryUpdatedBy?.displayName || ""}</p> : null}
          </>
        ) : <p className="empty">サマリーは登録されていません。</p>}
      </section>
      {editing ? <SummaryDialog onClose={() => setEditing(false)} onSave={(text) => save("summary", text)} value={summary} /> : null}
    </div>
  );
}

function SummaryDialog({ value, onSave, onClose }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <LeftDialog
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError("");
        try {
          await onSave(text.trim());
          onClose();
        } catch (nextError) {
          setError(saveErrorMessage(nextError));
          setBusy(false);
        }
      }}
      submitLabel="更新"
      title="サマリーの編集"
      wide
    >
      <textarea aria-label="サマリー" className="input cl-summary-input" maxLength={8000} onChange={(event) => setText(event.target.value)} placeholder="経過のまとめ・申し送りなど" rows={10} value={text} />
    </LeftDialog>
  );
}
