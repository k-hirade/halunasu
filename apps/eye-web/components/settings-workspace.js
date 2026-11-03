"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { AuditLogSection } from "./settings-audit";
import { FilterChips, InactiveGroup, MasterEditorPanel, MasterRows, MasterToolbar, useMasterEditor } from "./settings-master";
import { COMMON_USAGES, downloadJson, formatDateTime, PHRASE_TARGET_LABELS, PRESCRIPTION_KIND_LABELS, todayIso } from "../lib/format";
import {
  daysPerBottle,
  drugBottleText,
  drugDefaultText,
  drugSearchValues,
  matchesSearch,
  normalizeSearch,
  phraseSearchValues,
  setContentText,
  setSearchValues
} from "../lib/settings";

const SECTIONS = [
  { key: "drugs", label: "よく使う薬剤", group: "input" },
  { key: "sets", label: "セット", group: "input" },
  { key: "phrases", label: "定型文", group: "input" },
  { key: "export", label: "データ出力", group: "admin" },
  { key: "audit", label: "操作記録", group: "admin" }
];
const NAV_GROUPS = [["input", "カルテ入力の候補"], ["admin", "管理"]];

function readHash() {
  if (typeof window === "undefined") return "";
  return decodeURIComponent(window.location.hash.replace(/^#/u, ""));
}

const byName = (key) => (left, right) => String(left[key] || "").localeCompare(String(right[key] || ""), "ja");
const phraseSortKey = (item) => item.label || item.text || "";

export function SettingsWorkspace() {
  const api = useEyeApi();
  const [context, setContext] = useState(null);
  const [presets, setPresets] = useState([]);
  const [orderSets, setOrderSets] = useState([]);
  const [phrases, setPhrases] = useState([]);
  const [orderCatalog, setOrderCatalog] = useState([]);
  const [error, setError] = useState("");
  const [hash, setHash] = useState("");
  const [pendingSection, setPendingSection] = useState(null);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((dirty) => { dirtyRef.current = dirty; }, []);

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/bootstrap").then((payload) => {
      if (cancelled) return;
      setContext(payload.context);
      setPresets(payload.drugPresets || []);
      setOrderSets(payload.orderSets || []);
      setPhrases(payload.phrases || []);
      setOrderCatalog(payload.orderCatalog || []);
    }).catch((nextError) => { if (!cancelled) setError(nextError.message); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    setHash(readHash());
    const onHashChange = () => setHash(readHash());
    // 保存していない変更があるときは、画面を離れる前にブラウザの確認を出す
    const onBeforeUnload = (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  const visibleSections = SECTIONS.filter((item) => item.group !== "admin" || context?.canManageSettings);
  const section = visibleSections.some((item) => item.key === hash) ? hash : "drugs";
  const counts = {
    drugs: presets.filter((item) => item.active !== false).length,
    sets: orderSets.filter((item) => item.active !== false).length,
    phrases: phrases.filter((item) => item.active !== false).length
  };

  function go(key) {
    setPendingSection(null);
    dirtyRef.current = false;
    if (key === section) return;
    window.location.hash = key;
    setHash(key);
  }

  function requestSection(event, key) {
    if (dirtyRef.current && key !== section) {
      event?.preventDefault();
      setPendingSection(key);
      return;
    }
    if (event) event.preventDefault();
    go(key);
  }

  const upsert = (setter, idKey, sortKey) => (item) => setter((items) => {
    const next = items.some((entry) => entry[idKey] === item[idKey])
      ? items.map((entry) => (entry[idKey] === item[idKey] ? item : entry))
      : [...items, item];
    return next.sort((left, right) => String(sortKey(left)).localeCompare(String(sortKey(right)), "ja"));
  });

  if (!context) return <main className="eye-page">{error ? <p className="alert alert-danger" role="alert">{error}</p> : <p className="loading">読み込み中…</p>}</main>;

  const current = SECTIONS.find((item) => item.key === section);
  return (
    <main className="eye-page settings-page">
      <div className="settings-layout">
        <nav aria-label="設定の項目" className="settings-nav">
          <h1 className="settings-title">設定</h1>
          <label className="settings-nav-select">
            <span className="sr-only">設定の項目</span>
            <select aria-label="設定の項目を選ぶ" className="input" onChange={(event) => requestSection(null, event.target.value)} value={section}>
              {visibleSections.map((item) => <option key={item.key} value={item.key}>{item.label}{counts[item.key] !== undefined ? `（${counts[item.key]}）` : ""}</option>)}
            </select>
          </label>
          {NAV_GROUPS.map(([group, label]) => {
            const items = visibleSections.filter((item) => item.group === group);
            if (!items.length) return null;
            return (
              <div className="settings-nav-group" key={group}>
                <p className="settings-nav-label">{label}</p>
                <ul>
                  {items.map((item) => (
                    <li key={item.key}>
                      <a aria-current={item.key === section ? "page" : undefined} className="settings-nav-item" href={`#${item.key}`} onClick={(event) => requestSection(event, item.key)}>
                        <span>{item.label}</span>
                        {counts[item.key] !== undefined ? <span className="settings-nav-count">{counts[item.key]}</span> : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="settings-main">
          {pendingSection ? (
            <div className="master-guard settings-guard" role="alert">
              <span>「{current.label}」に保存していない変更があります。</span>
              <button className="btn btn-chip danger-text" onClick={() => go(pendingSection)} type="button">変更を破棄して移動</button>
              <button className="btn btn-chip" onClick={() => setPendingSection(null)} type="button">編集に戻る</button>
            </div>
          ) : null}
          {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
          {section === "drugs" ? <DrugsSection canEdit={context.canManageSettings} onDirtyChange={onDirtyChange} onSaved={upsert(setPresets, "presetId", (item) => item.name)} presets={presets} /> : null}
          {section === "sets" ? <OrderSetsSection canEdit={context.canManageSettings} catalog={orderCatalog} onDirtyChange={onDirtyChange} onSaved={upsert(setOrderSets, "setId", (item) => item.name)} orderSets={orderSets} presets={presets} /> : null}
          {section === "phrases" ? <PhrasesSection canEdit={context.canManageSettings} onDirtyChange={onDirtyChange} onSaved={upsert(setPhrases, "phraseId", phraseSortKey)} phrases={phrases} /> : null}
          {section === "export" ? <ExportSection context={context} /> : null}
          {section === "audit" ? <AuditLogSection masters={{ drugPresets: presets, orderSets, phrases }} /> : null}
        </div>
      </div>
    </main>
  );
}

function SectionHead({ title, count, children }) {
  return (
    <header className="settings-section-head">
      <h2>{title}{count !== undefined ? <span className="settings-head-count">{count}</span> : null}</h2>
      {children ? <p className="muted">{children}</p> : null}
    </header>
  );
}

function EmptyList({ total, canEdit, addLabel, noun }) {
  if (total === 0) return <p className="empty master-empty">まだ登録されていません。{canEdit ? `「＋ ${addLabel}」から登録します。` : ""}</p>;
  return <p className="empty master-empty">該当する{noun}はありません。</p>;
}

/* ───────── よく使う薬剤 ───────── */

const EMPTY_PRESET = { name: "", kind: "eye_drop", defaultTimesPerDay: null, dropsPerBottle: null, bottleVolumeMl: null, defaultUsage: "", route: "outside", active: true };
const numberText = (value) => (value === null || value === undefined ? "" : String(value));
const textNumber = (value) => (String(value).trim() === "" ? null : Number(value));

function presetToDraft(item) {
  const source = item || EMPTY_PRESET;
  return {
    presetId: source.presetId || "",
    name: source.name || "",
    kind: source.kind || "eye_drop",
    defaultTimesPerDay: numberText(source.defaultTimesPerDay),
    dropsPerBottle: numberText(source.dropsPerBottle),
    bottleVolumeMl: numberText(source.bottleVolumeMl),
    defaultUsage: source.defaultUsage || "",
    route: source.route || "outside",
    active: source.active !== false
  };
}

function presetBody(draft) {
  return {
    ...(draft.presetId ? { presetId: draft.presetId } : {}),
    name: draft.name.trim(),
    kind: draft.kind,
    defaultTimesPerDay: textNumber(draft.defaultTimesPerDay),
    dropsPerBottle: textNumber(draft.dropsPerBottle),
    bottleVolumeMl: textNumber(draft.bottleVolumeMl),
    defaultUsage: draft.defaultUsage.trim(),
    route: draft.route,
    active: draft.active
  };
}

const PRESET_FIELDS = { name: "薬剤名", defaultTimesPerDay: "1日の回数", dropsPerBottle: "1本あたりの滴数", bottleVolumeMl: "容量", defaultUsage: "既定の用法" };

function DrugsSection({ presets, canEdit, onSaved, onDirtyChange }) {
  const api = useEyeApi();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState(null);
  const editor = useMasterEditor({
    idKey: "presetId",
    toDraft: presetToDraft,
    toBody: presetBody,
    fieldLabels: PRESET_FIELDS,
    onDirtyChange,
    validate: (draft) => (draft.name.trim() ? "" : "薬剤名を入れてください。"),
    save: async (body) => {
      const { drugPreset } = await api("/v1/eye/drug-presets", { method: "POST", body });
      onSaved(drugPreset);
      return drugPreset;
    }
  });
  const searched = presets.filter((item) => matchesSearch(query, drugSearchValues(item)));
  const shown = searched.filter((item) => !kind || item.kind === kind);
  const active = shown.filter((item) => item.active !== false);
  const inactive = shown.filter((item) => item.active === false);
  const chipOptions = [
    { value: null, label: "すべて", count: searched.length },
    ...Object.entries(PRESCRIPTION_KIND_LABELS)
      .map(([value, label]) => ({ value, label, count: searched.filter((item) => item.kind === value).length }))
      .filter((option) => option.count > 0 || option.value === kind)
  ];
  const renderRow = (item) => (
    <>
      <span className="master-name">
        <strong>{item.name}</strong>
        {item.route === "inside" ? <span className="tag master-tag">院内</span> : null}
      </span>
      <span className="master-kind">{PRESCRIPTION_KIND_LABELS[item.kind] || ""}</span>
      <span className="master-default">{drugDefaultText(item) || <span className="muted">—</span>}</span>
      <span className="master-num">{drugBottleText(item)}</span>
    </>
  );

  return (
    <section aria-label="よく使う薬剤" className="settings-section">
      <SectionHead count={presets.filter((item) => item.active !== false).length} title="よく使う薬剤">
        カルテの処方の候補に出ます。{canEdit ? "" : "登録・変更は管理者が行います。"}
      </SectionHead>
      <div className={`master-layout${editor.selection ? " has-panel" : ""}`}>
        <div className="master-list">
          <MasterToolbar addLabel="薬剤を追加" onAdd={canEdit ? editor.openNew : null} onQuery={setQuery} placeholder="薬剤名・用法で検索" query={query} searchLabel="薬剤を検索" />
          {presets.length ? <FilterChips label="種類で絞り込む" onChange={setKind} options={chipOptions} value={kind} /> : null}
          {active.length ? (
            <div className="master-table">
              <div aria-hidden="true" className="master-head drug-cols"><span>薬剤名</span><span>種類</span><span>既定</span><span className="master-num">1本</span></div>
              <MasterRows className="drug-cols" idKey="presetId" items={active} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
            </div>
          ) : <EmptyList addLabel="薬剤を追加" canEdit={canEdit} noun="薬剤" total={presets.length} />}
          <InactiveGroup forceOpen={Boolean(normalizeSearch(query))} items={inactive}>
            <MasterRows className="drug-cols" idKey="presetId" items={inactive} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
          </InactiveGroup>
        </div>
        <MasterEditorPanel canEdit={canEdit} editor={editor} label="薬剤の編集" title={editor.selection?.id ? editor.selection.original.name : "薬剤を追加"}>
          {editor.selection ? <DrugPresetForm draft={editor.selection.draft} presets={presets} setDraft={editor.setDraft} /> : null}
        </MasterEditorPanel>
      </div>
    </section>
  );
}

function DrugPresetForm({ draft, setDraft, presets }) {
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  const duplicate = draft.name.trim() && presets.some((item) => item.presetId !== draft.presetId && normalizeSearch(item.name) === normalizeSearch(draft.name));
  const showTimes = draft.kind !== "injection";
  const showBottle = draft.kind === "eye_drop";
  const times = textNumber(draft.defaultTimesPerDay);
  const drops = textNumber(draft.dropsPerBottle);
  const both = showBottle && times > 0 ? daysPerBottle({ timesPerDay: times, eye: "ou", dropsPerBottle: drops }) : null;
  const single = showBottle && times > 0 ? daysPerBottle({ timesPerDay: times, eye: "od", dropsPerBottle: drops }) : null;
  const daysText = (result) => (result.capped ? `${result.days}日分以上` : `約${result.days}日分`);
  return (
    <>
      <label className="field">
        <span>薬剤名<em>必須</em></span>
        <input autoComplete="off" className="input" maxLength={200} onChange={set("name")} required value={draft.name} />
        {duplicate ? <small className="field-warn" role="status">同じ名前の薬剤があります（停止中を含む）。このまま保存もできます。</small> : null}
      </label>
      <div className="field-row">
        <label className="field">
          <span>種類</span>
          <select className="input" onChange={set("kind")} value={draft.kind}>
            {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>院内・院外</span>
          <select className="input" onChange={set("route")} value={draft.route}>
            <option value="outside">院外</option>
            <option value="inside">院内</option>
          </select>
        </label>
      </div>
      {showTimes ? (
        <div className="field-row">
          <label className="field">
            <span>1日の回数</span>
            <span className="input-with-unit"><input className="input input-num" inputMode="numeric" max={24} min={0} onChange={set("defaultTimesPerDay")} step={1} type="number" value={draft.defaultTimesPerDay} /><span>回</span></span>
          </label>
          <label className="field">
            <span>既定の用法</span>
            <input className="input" list="settings-usages" maxLength={200} onChange={set("defaultUsage")} value={draft.defaultUsage} />
            <datalist id="settings-usages">{COMMON_USAGES.map((usage) => <option key={usage} value={usage} />)}</datalist>
          </label>
        </div>
      ) : null}
      {showBottle ? (
        <div className="master-subsection">
          <h3>点眼の本数計算</h3>
          <div className="field-row">
            <label className="field">
              <span>容量</span>
              <span className="input-with-unit"><input className="input input-num" inputMode="decimal" max={100} min={0.1} onChange={set("bottleVolumeMl")} step="any" type="number" value={draft.bottleVolumeMl} /><span>mL</span></span>
            </label>
            <label className="field">
              <span>1本あたりの滴数</span>
              <span className="input-with-unit"><input className="input input-num" inputMode="numeric" max={2000} min={1} onChange={set("dropsPerBottle")} step={1} type="number" value={draft.dropsPerBottle} /><span>滴</span></span>
            </label>
          </div>
          <p className="muted small">滴数が空なら1本100滴で本数を計算します。</p>
          <p className="bottle-example" role="status">
            {both && single ? (
              both.days === 0
                ? "1日で1本を使い切る計算です。滴数を確認してください。"
                : <>1日{times}回なら 1本で <strong>両眼 {daysText(both)}</strong> ・ 片眼 {daysText(single)}<span className="muted">（1本{both.dropsPerBottle}滴・1回1滴で計算）</span></>
            ) : "1日の回数を入れると、1本で何日分になるかを表示します。"}
          </p>
        </div>
      ) : null}
    </>
  );
}

/* ───────── セット ───────── */

function setToDraft(item) {
  return {
    setId: item?.setId || "",
    name: item?.name || "",
    description: item?.description || "",
    plan: item?.plan || "",
    prescriptions: (item?.prescriptions || []).map((row) => ({ ...row })),
    orders: (item?.orders || []).map((row) => ({ ...row })),
    active: item ? item.active !== false : true
  };
}

function setBody(draft) {
  return {
    ...(draft.setId ? { setId: draft.setId } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    plan: draft.plan,
    prescriptions: draft.prescriptions.map((row) => ({ ...row, name: String(row.name || "").trim() })),
    orders: draft.orders,
    active: draft.active
  };
}

function validateSet(draft) {
  if (!draft.name.trim()) return "セット名を入れてください。";
  if (draft.prescriptions.some((row) => !String(row.name || "").trim())) return "薬剤名が空の処方があります。入れるか、行を削除してください。";
  if (draft.orders.some((row) => !row.code)) return "検査が選ばれていない行があります。選ぶか、行を削除してください。";
  return "";
}

function OrderSetsSection({ orderSets, presets, catalog, canEdit, onSaved, onDirtyChange }) {
  const api = useEyeApi();
  const [query, setQuery] = useState("");
  const editor = useMasterEditor({
    idKey: "setId",
    toDraft: setToDraft,
    toBody: setBody,
    validate: validateSet,
    fieldLabels: { name: "セット名", description: "説明", plan: "方針に追加する文" },
    onDirtyChange,
    save: async (body) => {
      const { orderSet } = await api("/v1/eye/order-sets", { method: "POST", body });
      onSaved(orderSet);
      return orderSet;
    }
  });
  const shown = orderSets.filter((item) => matchesSearch(query, setSearchValues(item)));
  const active = shown.filter((item) => item.active !== false);
  const inactive = shown.filter((item) => item.active === false);
  const renderRow = (item) => (
    <>
      <span className="master-name">
        <strong>{item.name}</strong>
        {item.description ? <span className="master-desc">{item.description}</span> : null}
      </span>
      <span className="master-default">{setContentText(item) || <span className="muted">空</span>}</span>
    </>
  );
  return (
    <section aria-label="セット" className="settings-section">
      <SectionHead count={orderSets.filter((item) => item.active !== false).length} title="セット">
        処方・検査・方針の組み合わせ。カルテの「候補」から一括で追加できます。{canEdit ? "" : "登録・変更は管理者が行います。"}
      </SectionHead>
      <div className={`master-layout${editor.selection ? " has-panel" : ""}`}>
        <div className="master-list">
          <MasterToolbar addLabel="セットを追加" onAdd={canEdit ? editor.openNew : null} onQuery={setQuery} placeholder="セット名・薬剤・検査で検索" query={query} searchLabel="セットを検索" />
          {active.length ? (
            <div className="master-table">
              <div aria-hidden="true" className="master-head set-cols"><span>セット名</span><span>中身</span></div>
              <MasterRows className="set-cols" idKey="setId" items={active} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
            </div>
          ) : <EmptyList addLabel="セットを追加" canEdit={canEdit} noun="セット" total={orderSets.length} />}
          <InactiveGroup forceOpen={Boolean(normalizeSearch(query))} items={inactive}>
            <MasterRows className="set-cols" idKey="setId" items={inactive} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
          </InactiveGroup>
        </div>
        <MasterEditorPanel canEdit={canEdit} editor={editor} label="セットの編集" title={editor.selection?.id ? editor.selection.original.name : "セットを追加"}>
          {editor.selection ? <OrderSetForm catalog={catalog} draft={editor.selection.draft} presets={presets} setDraft={editor.setDraft} /> : null}
        </MasterEditorPanel>
      </div>
    </section>
  );
}

const EYE_OPTIONS = [["ou", "両眼"], ["od", "右眼"], ["os", "左眼"]];

function EyeSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} className="input set-eye" onChange={(event) => onChange(event.target.value)} value={value || ""}>
      {!value ? <option disabled value="">（未設定）</option> : null}
      {EYE_OPTIONS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
}

function OrderSetForm({ draft, setDraft, presets, catalog }) {
  const activePresets = presets.filter((item) => item.active !== false);
  const updateRow = (listKey, index, patch) => setDraft((current) => ({
    ...current,
    [listKey]: current[listKey].map((row, i) => (i === index ? { ...row, ...patch } : row))
  }));
  const removeRow = (listKey, index) => setDraft((current) => ({ ...current, [listKey]: current[listKey].filter((_, i) => i !== index) }));
  return (
    <>
      <label className="field">
        <span>セット名<em>必須</em></span>
        <input autoComplete="off" className="input" maxLength={200} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required value={draft.name} />
      </label>
      <label className="field">
        <span>説明</span>
        <input className="input" maxLength={200} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="例: 眼圧安定例。3か月ごと" value={draft.description} />
      </label>

      <div className="master-subsection">
        <div className="master-subhead">
          <h3>処方 <span className="master-count">{draft.prescriptions.length}</span></h3>
          <button className="btn btn-chip" onClick={() => setDraft((current) => ({ ...current, prescriptions: [...current.prescriptions, { kind: "eye_drop", name: "", eye: "ou", timesPerDay: null, usage: "", route: "outside" }] }))} type="button">＋ 処方</button>
        </div>
        {draft.prescriptions.map((row, index) => (
          <div className="set-line" key={index}>
            <div className="set-line-main">
              <input
                aria-label={`処方${index + 1} 薬剤名`}
                className="input"
                list="settings-drugs"
                onChange={(event) => {
                  const name = event.target.value;
                  const preset = activePresets.find((item) => item.name === name);
                  updateRow("prescriptions", index, preset
                    ? { name, presetId: preset.presetId, kind: preset.kind, route: preset.route || "outside", timesPerDay: row.timesPerDay ?? preset.defaultTimesPerDay ?? null, usage: row.usage || preset.defaultUsage || "" }
                    : { name, presetId: "" });
                }}
                placeholder="薬剤名（よく使う薬剤から選べます）"
                value={row.name || ""}
              />
              <span className="muted small set-kind">{PRESCRIPTION_KIND_LABELS[row.kind] || "点眼"}・{row.route === "inside" ? "院内" : "院外"}</span>
              <button aria-label={`処方${index + 1}を削除`} className="btn btn-chip danger-text" onClick={() => removeRow("prescriptions", index)} type="button">削除</button>
            </div>
            <div className="set-line-sub">
              <EyeSelect label={`処方${index + 1} 眼`} onChange={(eye) => updateRow("prescriptions", index, { eye })} value={row.eye} />
              <span className="input-with-unit">
                <input aria-label={`処方${index + 1} 1日の回数`} className="input input-num" inputMode="numeric" max={24} min={0} onChange={(event) => updateRow("prescriptions", index, { timesPerDay: textNumber(event.target.value) })} step={1} type="number" value={numberText(row.timesPerDay)} />
                <span>回/日</span>
              </span>
              <input aria-label={`処方${index + 1} 用法`} className="input set-usage" list="settings-usages-set" onChange={(event) => updateRow("prescriptions", index, { usage: event.target.value })} placeholder="用法" value={row.usage || ""} />
            </div>
          </div>
        ))}
        <datalist id="settings-drugs">{activePresets.map((item) => <option key={item.presetId} value={item.name} />)}</datalist>
        <datalist id="settings-usages-set">{COMMON_USAGES.map((usage) => <option key={usage} value={usage} />)}</datalist>
        {draft.prescriptions.length ? <p className="muted small">薬剤の既定値はセットに写して保存します。あとで薬剤の設定を変えても、このセットは変わりません。</p> : null}
      </div>

      <div className="master-subsection">
        <div className="master-subhead">
          <h3>検査・処置 <span className="master-count">{draft.orders.length}</span></h3>
          <button className="btn btn-chip" onClick={() => setDraft((current) => ({ ...current, orders: [...current.orders, { code: "", name: "", kind: "exam", eye: "ou" }] }))} type="button">＋ 検査</button>
        </div>
        {draft.orders.map((row, index) => (
          <div className="set-line set-line-order" key={index}>
            <select
              aria-label={`検査${index + 1}`}
              className="input"
              onChange={(event) => {
                const item = catalog.find((entry) => entry.code === event.target.value);
                if (item) updateRow("orders", index, { code: item.code, name: item.name, kind: item.kind });
              }}
              value={row.code || ""}
            >
              {!row.code ? <option disabled value="">検査を選ぶ</option> : null}
              {row.code && !catalog.some((item) => item.code === row.code) ? <option value={row.code}>{row.name || row.code}</option> : null}
              {catalog.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
            </select>
            <EyeSelect label={`検査${index + 1} 眼`} onChange={(eye) => updateRow("orders", index, { eye })} value={row.eye} />
            <button aria-label={`検査${index + 1}を削除`} className="btn btn-chip danger-text" onClick={() => removeRow("orders", index)} type="button">削除</button>
          </div>
        ))}
      </div>

      <label className="field">
        <span>方針に追加する文</span>
        <textarea className="input" maxLength={4000} onChange={(event) => setDraft((current) => ({ ...current, plan: event.target.value }))} rows={3} value={draft.plan} />
      </label>
    </>
  );
}

/* ───────── 定型文 ───────── */

const PHRASE_TARGETS = Object.keys(PHRASE_TARGET_LABELS);

function phraseToDraft(item) {
  return { phraseId: item?.phraseId || "", target: item?.target || "plan", label: item?.label || "", text: item?.text || "", active: item ? item.active !== false : true };
}

function phraseBody(draft) {
  return { ...(draft.phraseId ? { phraseId: draft.phraseId } : {}), target: draft.target, label: draft.label.trim(), text: draft.text, active: draft.active };
}

function PhrasesSection({ phrases, canEdit, onSaved, onDirtyChange }) {
  const api = useEyeApi();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState(null);
  const lastTarget = useRef("plan");
  const editor = useMasterEditor({
    idKey: "phraseId",
    toDraft: (item) => phraseToDraft(item || { target: target || lastTarget.current, active: true }),
    toBody: phraseBody,
    validate: (draft) => (draft.text.trim() ? "" : "本文を入れてください。"),
    fieldLabels: { label: "表示名", text: "本文", target: "差し込む欄" },
    onDirtyChange,
    save: async (body) => {
      const { phrase } = await api("/v1/eye/phrases", { method: "POST", body });
      lastTarget.current = phrase.target;
      onSaved(phrase);
      return phrase;
    }
  });
  const searched = phrases.filter((item) => matchesSearch(query, phraseSearchValues(item)));
  const shown = searched.filter((item) => !target || item.target === target);
  const active = shown.filter((item) => item.active !== false);
  const inactive = shown.filter((item) => item.active === false);
  const chipOptions = [
    { value: null, label: "すべて", count: searched.length },
    ...PHRASE_TARGETS
      .map((value) => ({ value, label: PHRASE_TARGET_LABELS[value], count: searched.filter((item) => item.target === value).length }))
      .filter((option) => option.count > 0 || option.value === target)
  ];
  const renderRow = (item) => (
    <>
      <span className="master-name"><strong>{item.label || <span className="muted">（表示名なし）</span>}</strong></span>
      <span className="master-desc">{item.text}</span>
      <span className="master-kind">{item.active === false ? PHRASE_TARGET_LABELS[item.target] : ""}</span>
    </>
  );
  const groups = target
    ? [[target, active]]
    : PHRASE_TARGETS.map((key) => [key, active.filter((item) => item.target === key)]).filter(([, items]) => items.length);

  return (
    <section aria-label="定型文" className="settings-section">
      <SectionHead count={phrases.filter((item) => item.active !== false).length} title="定型文">
        カルテの「候補」に、表示名（空なら本文）で出ます。{canEdit ? "" : "登録・変更は管理者が行います。"}
      </SectionHead>
      <div className={`master-layout${editor.selection ? " has-panel" : ""}`}>
        <div className="master-list">
          <MasterToolbar addLabel="定型文を追加" onAdd={canEdit ? editor.openNew : null} onQuery={setQuery} placeholder="表示名・本文で検索" query={query} searchLabel="定型文を検索" />
          {phrases.length ? <FilterChips label="差し込む欄で絞り込む" onChange={setTarget} options={chipOptions} value={target} /> : null}
          {active.length ? groups.map(([key, items]) => (
            <div className="master-group" key={key}>
              {target ? null : (
                <h3 className="master-group-head">
                  {PHRASE_TARGET_LABELS[key]} <span className="master-count">{items.length}</span>
                  {key.startsWith("findings.") ? <span className="muted small">カルテで右・左・両を選んで入れます</span> : null}
                </h3>
              )}
              <MasterRows className="phrase-cols" idKey="phraseId" items={items} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
            </div>
          )) : <EmptyList addLabel="定型文を追加" canEdit={canEdit} noun="定型文" total={phrases.length} />}
          <InactiveGroup forceOpen={Boolean(normalizeSearch(query))} items={inactive}>
            <MasterRows className="phrase-cols" idKey="phraseId" items={inactive} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
          </InactiveGroup>
        </div>
        <MasterEditorPanel canEdit={canEdit} editor={editor} label="定型文の編集" title={editor.selection?.id ? (editor.selection.original.label || "定型文") : "定型文を追加"}>
          {editor.selection ? <PhraseForm draft={editor.selection.draft} setDraft={editor.setDraft} /> : null}
        </MasterEditorPanel>
      </div>
    </section>
  );
}

function PhraseForm({ draft, setDraft }) {
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  return (
    <>
      <div className="field-row">
        <label className="field">
          <span>差し込む欄</span>
          <select className="input" onChange={set("target")} value={draft.target}>
            {PHRASE_TARGETS.map((value) => <option key={value} value={value}>{PHRASE_TARGET_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>表示名（任意）</span>
          <input autoComplete="off" className="input" maxLength={60} onChange={set("label")} value={draft.label} />
        </label>
      </div>
      <label className="field">
        <span>本文<em>必須</em></span>
        <textarea className="input phrase-text-input" maxLength={4000} onChange={set("text")} required rows={5} value={draft.text} />
      </label>
      <p className="muted small">
        {draft.target.startsWith("findings.") ? "カルテでは右・左・両を選んで、その眼の所見に入ります。" : `カルテの「${PHRASE_TARGET_LABELS[draft.target]}」に入ります。`}
        改行もそのまま入ります。
      </p>
    </>
  );
}

/* ───────── データ出力 ───────── */

function ExportSection({ context }) {
  const api = useEyeApi();
  const [step, setStep] = useState("idle"); // idle | confirm | busy
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastExport, setLastExport] = useState(undefined);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/audit-logs?category=export&limit=100").then((payload) => {
      if (cancelled) return;
      const log = (payload.auditLogs || []).find((item) => item.eventType === "eye.clinic_exported");
      setLastExport(log
        ? { at: log.createdAt, by: payload.actors?.[log.actorMemberId]?.displayName || log.actorLoginId, patientCount: log.safePayload?.patientCount }
        : { none: payload.nextCursor ? "直近の操作記録には見つかりません" : "まだ出力していません" });
    }).catch(() => { if (!cancelled) setLastExport(null); });
    return () => { cancelled = true; };
  }, [api]);

  async function runExport() {
    if (busyRef.current) return;
    busyRef.current = true;
    setStep("busy");
    setError("");
    setNotice("");
    try {
      const payload = await api("/v1/eye/export");
      downloadJson(payload, `eye-clinic-export-${todayIso()}.json`);
      const count = payload.patients?.length ?? 0;
      setLastExport({ at: payload.exportedAt || new Date().toISOString(), by: context.displayName, patientCount: count });
      setNotice(`出力しました（患者 ${count}人）。`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      busyRef.current = false;
      setStep("idle");
    }
  }

  return (
    <section aria-label="データ出力" className="settings-section">
      <SectionHead title="データ出力">システムの移行や院内での保管のために、医院のデータをまとめて JSON で保存します。</SectionHead>
      <div className="panel export-card">
        <h3>医院データの一括出力 <span className="muted small">JSON・halunasu-eye-export-v1</span></h3>
        <dl className="export-facts">
          <dt>含むもの</dt>
          <dd>全患者の患者情報・アレルギー・病名・カルテ（確定版を含む）・文書・予約・画像と書類の情報と保管場所、よく使う薬剤・セット・定型文</dd>
          <dt>含まないもの</dt>
          <dd>画像・書類のファイル本体</dd>
          <dt>最後の出力</dt>
          <dd>{lastExport === undefined ? "確認中…" : !lastExport || lastExport.none ? (lastExport?.none || "確認できませんでした") : `${formatDateTime(lastExport.at)}　${lastExport.by}${Number.isFinite(lastExport.patientCount) ? `（患者 ${lastExport.patientCount}人）` : ""}`}</dd>
        </dl>
        <p className="export-warn">個人情報を含みます。出力したファイルは院内で決めた場所に保管してください。患者が多いと出力に時間がかかります。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {notice ? <p className="alert alert-ok" role="status">{notice}</p> : null}
        <div className="export-actions">
          {step === "confirm" ? (
            <>
              <span>全患者のデータを出力します。よろしいですか？</span>
              <button className="btn btn-ghost" onClick={() => setStep("idle")} type="button">やめる</button>
              <button className="btn btn-primary" onClick={runExport} type="button">出力する</button>
            </>
          ) : (
            <button aria-busy={step === "busy"} className="btn btn-primary" disabled={step === "busy"} onClick={() => setStep("confirm")} type="button">
              {step === "busy" ? "出力中…" : "医院データを出力"}
            </button>
          )}
        </div>
      </div>
      <p className="muted small">患者1人分の出力は、患者のページから行えます。</p>
    </section>
  );
}

