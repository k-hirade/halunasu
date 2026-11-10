"use client";

import { useMemo, useState } from "react";
import { PER_EYE_PHRASE_TARGETS } from "@halunasu/eye-contracts";
import { RX_BADGES, useMasterSearch } from "./chart-shared";
import { PHRASE_TARGET_LABELS } from "../lib/format";

// 右のオーダー欄の区分タブ（デジカルの 2 段の区分 + 全て）。key はショートカットの数字キー。
export const ORDER_CATEGORIES = [
  { id: "set", label: "セット", key: "1" },
  { id: "consult", label: "診察", key: "2", sections: ["A"] },
  { id: "drug", label: "投薬", key: "3" },
  { id: "injection", label: "注射", key: "4", sections: ["G"] },
  { id: "procedure", label: "処置", key: "5", sections: ["J"] },
  { id: "surgery", label: "手術", key: "6", sections: ["K"] },
  { id: "exam", label: "検査", key: "7", sections: ["D"] },
  { id: "imaging", label: "画像", key: "8", sections: ["E"] },
  { id: "optical", label: "眼鏡・CL", key: "9" },
  { id: "phrase", label: "定型文", key: "0" },
  { id: "all", label: "全て", key: "¥" }
];
const DRUG_CATEGORIES = new Set(["drug", "injection", "all"]);
const PROCEDURE_CATEGORIES = new Set(["consult", "injection", "procedure", "surgery", "exam", "imaging", "all"]);
const LEARNING_LIMIT = 30;

function bundleLine(bundle) {
  const rp = bundle.rp || {};
  return [
    rp.route === "inside" ? "院内" : rp.route ? "院外" : "",
    rp.eye ? { od: "右", os: "左", ou: "両" }[rp.eye] : "",
    rp.timesPerDay ? `1日${rp.timesPerDay}回` : "",
    rp.usage || "",
    rp.days ? `${rp.days}日` : ""
  ].filter(Boolean).join(" ");
}

export function OrderPanel({
  editable, category, setCategory, drugPresets, catalog, orderSets, setFolders, phrases, learning, canManageSets, selectedRp,
  onAddDrug, onAddOrder, onAddLearning, onApplySet, onInsertPhrase, onCreateSet, onAddOptical, searchRef
}) {
  const [query, setQuery] = useState("");
  const [eyeOnly, setEyeOnly] = useState(true);
  const current = ORDER_CATEGORIES.find((item) => item.id === category) || ORDER_CATEGORIES[2];
  const q = query.trim();
  const drugSearch = useMasterSearch("drug", q, { eyeOnly: eyeOnly && category === "drug", enabled: DRUG_CATEGORIES.has(category) });
  const procedureEyeOnly = eyeOnly && ["procedure", "surgery", "exam"].includes(category);
  const procedureSearch = useMasterSearch("procedure", q, { eyeOnly: procedureEyeOnly, enabled: PROCEDURE_CATEGORIES.has(category) });
  const sections = current.sections || null;

  const drugResults = useMemo(() => {
    const results = drugSearch.results.filter((item) => (category === "injection" ? item.kind === "injection" : true));
    const presets = drugPresets.filter((preset) => preset.active !== false && q && preset.name.includes(q) && (category !== "injection" || preset.kind === "injection"));
    return [...presets.map((preset) => ({ ...preset, preset: true })), ...results];
  }, [drugSearch.results, drugPresets, q, category]);
  const procedureResults = useMemo(() => procedureSearch.results
    .filter((item) => !sections || sections.some((prefix) => String(item.section || "").startsWith(prefix))), [procedureSearch.results, sections]);
  const catalogItems = useMemo(() => {
    if (!["exam", "procedure", "all"].includes(category)) return [];
    const kind = category === "exam" ? "exam" : category === "procedure" ? "procedure" : null;
    return catalog.filter((item) => (!kind || item.kind === kind) && (!q || item.name.includes(q)));
  }, [catalog, category, q]);

  const learnedRx = (learning.prescription || []).filter((bundle) => (category === "injection" ? bundle.rows?.some((row) => row.kind === "injection") : category === "drug" ? !bundle.rows?.every((row) => row.kind === "injection") : true));
  const learnedOrders = (learning.order || []).filter((bundle) => {
    if (category === "exam") return bundle.rows?.some((row) => row.kind === "exam");
    if (category === "procedure" || category === "surgery") return bundle.rows?.some((row) => row.kind === "procedure");
    return category === "all";
  });

  const target = selectedRp ? (selectedRp.field === "prescriptions" ? "選択中の処方 Rp に入ります" : "選択中の検査・処置の束に入ります") : "新しい束として入ります";
  const showSearch = !["set", "optical", "phrase"].includes(category);

  return (
    <div className="order-panel">
      <div aria-label="オーダーの区分" className="order-cats" role="tablist">
        {ORDER_CATEGORIES.map((item) => (
          <button
            aria-selected={category === item.id}
            className={`order-cat${item.id === "all" ? " is-all" : ""}`}
            key={item.id}
            onClick={() => setCategory(item.id)}
            role="tab"
            title={`${item.label}（${item.key}）`}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {showSearch ? (
        <div className="order-search">
          <input
            aria-label="オーダーを検索"
            className="input"
            title="漢字・かな・英字で検索できます"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) setQuery("");
            }}
            placeholder={`${current.label}を検索`}
            ref={searchRef}
            type="search"
            value={query}
          />
          {["drug", "procedure", "surgery", "exam"].includes(category) ? (
            <label className="check-line small"><input checked={eyeOnly} onChange={(event) => setEyeOnly(event.target.checked)} type="checkbox" />眼科のみ</label>
          ) : null}
        </div>
      ) : null}
      {editable && showSearch ? <p className="order-target muted small">{target}</p> : null}
      <div className="order-results" role="tabpanel">
        {category === "set" ? (
          <SetTree canManageSets={canManageSets} editable={editable} onApplySet={onApplySet} onCreateSet={onCreateSet} orderSets={orderSets} setFolders={setFolders} />
        ) : null}
        {category === "phrase" ? <PhraseList editable={editable} onInsertPhrase={onInsertPhrase} phrases={phrases} /> : null}
        {category === "optical" ? (
          <div className="order-optical">
            <button className="order-item" disabled={!editable} onClick={() => onAddOptical("glasses")} type="button"><span className="rp-badge is-optical">眼鏡</span>眼鏡処方箋</button>
            <button className="order-item" disabled={!editable} onClick={() => onAddOptical("contact")} type="button"><span className="rp-badge is-optical">CL</span>コンタクトレンズ指示書</button>
            <p className="muted small">処置・行為に眼鏡・CL の欄が入ります。検査の矯正値を写せます。</p>
          </div>
        ) : null}
        {showSearch && q ? (
          <>
            {catalogItems.length ? (
              <ResultGroup title="院内の検査・処置">
                {catalogItems.map((item) => (
                  <button className="order-item" disabled={!editable} key={item.code} onClick={() => onAddOrder(item)} type="button">
                    <span className="rp-badge is-order">{item.kind === "procedure" ? "処置" : "検査"}</span>{item.name}
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {DRUG_CATEGORIES.has(category) && drugResults.length ? (
              <ResultGroup title="医薬品">
                {drugResults.map((item) => (
                  <button className="order-item" disabled={!editable} key={item.presetId || item.code} onClick={() => onAddDrug(item)} title={item.generic || item.name} type="button">
                    <span className="rp-badge">{RX_BADGES[item.kind] || "薬"}</span>
                    <span className="order-item-name">{item.name}</span>
                    {item.preset ? <span className="muted small">よく使う</span> : item.price ? <span className="muted small">{item.price}円</span> : null}
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {PROCEDURE_CATEGORIES.has(category) && procedureResults.length ? (
              <ResultGroup title="診療行為">
                {procedureResults.map((item) => (
                  <button className="order-item" disabled={!editable} key={item.code} onClick={() => onAddOrder(item)} type="button">
                    <span className="rp-badge is-order">{/^D/u.test(item.section || "") ? "検査" : "処置"}</span>
                    <span className="order-item-name">{item.name}</span>
                    {item.points ? <span className="muted small">{item.points}点</span> : null}
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {drugSearch.loading || procedureSearch.loading ? <p className="muted small">検索中…</p> : null}
            {drugSearch.error || procedureSearch.error ? <p className="alert alert-danger small">{drugSearch.error || procedureSearch.error}</p> : null}
            {editable && !drugSearch.loading && !procedureSearch.loading ? (
              <button
                className="order-item is-free"
                onClick={() => (DRUG_CATEGORIES.has(category) && category !== "all" && category !== "injection"
                  ? onAddDrug({ name: q, kind: "eye_drop" })
                  : category === "injection" ? onAddDrug({ name: q, kind: "injection" }) : onAddOrder({ name: q, kind: "procedure", code: "" }))}
                type="button"
              >
                「{q}」を{DRUG_CATEGORIES.has(category) ? "薬剤名" : "行為"}としてそのまま入れる
              </button>
            ) : null}
          </>
        ) : null}
        {showSearch && !q ? (
          <>
            {DRUG_CATEGORIES.has(category) ? (
              <ResultGroup title="学習リスト（よく使う処方）">
                {learnedRx.length ? learnedRx.slice(0, LEARNING_LIMIT).map((bundle) => (
                  <button className="order-bundle" disabled={!editable} key={bundle.key} onClick={() => onAddLearning("prescriptions", bundle)} type="button">
                    {bundle.rows.filter((row) => row.kind !== "comment").slice(0, 5).map((row, index) => (
                      <span className="order-bundle-row" key={index}>
                        <span className="rp-badge">{RX_BADGES[row.kind] || "薬"}</span>
                        {/* 数量は「2 本」で割れないよう 1 つにまとめる */}
                        <span className="order-bundle-name">{row.name}{row.quantity ? <span className="order-bundle-qty"> {row.quantity}{row.unit || ""}</span> : null}</span>
                      </span>
                    ))}
                    {bundle.rows.length > 5 ? <span className="order-bundle-more">+{bundle.rows.length - 5}</span> : null}
                    <span className="order-bundle-foot">{bundleLine(bundle)}<span className="order-bundle-count">{bundle.count}回</span></span>
                  </button>
                )) : <p className="muted small">確定したカルテが増えると、よく使う処方がここに並びます。</p>}
              </ResultGroup>
            ) : null}
            {DRUG_CATEGORIES.has(category) && drugPresets.length ? (
              <ResultGroup title="よく使う薬剤">
                {drugPresets.filter((preset) => preset.active !== false && (category !== "injection" || preset.kind === "injection")).map((preset) => (
                  <button className="order-item" disabled={!editable} key={preset.presetId} onClick={() => onAddDrug(preset)} type="button">
                    <span className="rp-badge">{RX_BADGES[preset.kind] || "薬"}</span>
                    <span className="order-item-name">{preset.name}</span>
                    {preset.defaultTimesPerDay ? <span className="muted small">1日{preset.defaultTimesPerDay}回</span> : null}
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {learnedOrders.length ? (
              <ResultGroup title="学習リスト（よく使う検査・処置）">
                {learnedOrders.slice(0, LEARNING_LIMIT).map((bundle) => (
                  <button className="order-bundle" disabled={!editable} key={bundle.key} onClick={() => onAddLearning("orders", bundle)} type="button">
                    {bundle.rows.filter((row) => row.kind !== "comment").slice(0, 5).map((row, index) => (
                      <span className="order-bundle-row" key={index}><span className="rp-badge is-order">{row.kind === "procedure" ? "処置" : "検査"}</span>{row.name}{row.eye ? `（${{ od: "右", os: "左", ou: "両" }[row.eye]}）` : ""}</span>
                    ))}
                    {bundle.rows.length > 5 ? <span className="order-bundle-more">+{bundle.rows.length - 5}</span> : null}
                    <span className="order-bundle-foot"><span className="order-bundle-count">{bundle.count}回</span></span>
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {catalogItems.length ? (
              <ResultGroup title="院内の検査・処置">
                {catalogItems.map((item) => (
                  <button className="order-item" disabled={!editable} key={item.code} onClick={() => onAddOrder(item)} type="button">
                    <span className="rp-badge is-order">{item.kind === "procedure" ? "処置" : "検査"}</span>{item.name}
                  </button>
                ))}
              </ResultGroup>
            ) : null}
            {!DRUG_CATEGORIES.has(category) && !learnedOrders.length && !catalogItems.length ? (
              <p className="muted small order-hint">キーワードを入れると、{current.label}の診療行為（公開マスター）から探せます。</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ResultGroup({ title, children }) {
  return (
    <section className="order-group">
      <h3 className="order-group-title">{title}</h3>
      <div className="order-group-items">{children}</div>
    </section>
  );
}

// セット: フォルダの木（親 → 子 → セット）。押すと中央に入る。「現在のカルテからセット」を作れる。
function SetTree({ orderSets, setFolders, editable, canManageSets, onApplySet, onCreateSet }) {
  const sets = orderSets.filter((item) => item.active !== false);
  const folders = setFolders.filter((item) => item.active !== false);
  const known = new Set(folders.map((item) => item.folderId));
  const setsIn = (folderId) => sets.filter((item) => (item.folderId && known.has(item.folderId) ? item.folderId : "") === folderId);
  const childrenOf = (parentId) => folders.filter((item) => (item.parentId && known.has(item.parentId) ? item.parentId : "") === parentId);
  const setButton = (item) => (
    <button className="order-item order-set" disabled={!editable} key={item.setId} onClick={() => onApplySet(item)} title={item.description || undefined} type="button">
      <span className="order-item-name">{item.name}</span>
      <span className="muted small">処方{(item.prescriptions || []).filter((row) => row.kind !== "comment").length}・検査{(item.orders || []).filter((row) => row.kind !== "comment").length}{item.diagnoses?.length ? `・病名${item.diagnoses.length}` : ""}</span>
    </button>
  );
  const folderNode = (folder, depth = 0) => (
    <details className="set-folder" key={folder.folderId} open={depth === 0}>
      <summary><span aria-hidden="true">📁</span> {folder.name}</summary>
      <div className="set-folder-body">
        {childrenOf(folder.folderId).map((child) => folderNode(child, depth + 1))}
        {setsIn(folder.folderId).map(setButton)}
        {!childrenOf(folder.folderId).length && !setsIn(folder.folderId).length ? <p className="muted small">空のフォルダ</p> : null}
      </div>
    </details>
  );
  return (
    <div className="set-tree">
      {canManageSets && editable ? (
        <button className="btn btn-chip set-create" onClick={onCreateSet} type="button">＋ 現在のカルテからセット</button>
      ) : null}
      {sets.length === 0 && folders.length === 0 ? <p className="muted small">セットはまだありません。{canManageSets ? "今のカルテの内容からセットを作れます。" : ""}</p> : null}
      {childrenOf("").map((folder) => folderNode(folder))}
      {setsIn("").map(setButton)}
    </div>
  );
}

function PhraseList({ phrases, editable, onInsertPhrase }) {
  const active = phrases.filter((item) => item.active !== false);
  const groups = Object.entries({ findingsText: "主訴・所見（自由記載）", ...PHRASE_TARGET_LABELS })
    .map(([target, label]) => [target, label, active.filter((item) => item.target === target)])
    .filter(([, , items]) => items.length);
  if (!groups.length) return <p className="muted small">設定画面で定型文を登録できます。</p>;
  return (
    <div className="phrase-list">
      <p className="muted small">主訴・所見の自由記載はカーソルの位置に入ります。</p>
      {groups.map(([target, label, items]) => (
        <section className="order-group" key={target}>
          <h3 className="order-group-title">{label}</h3>
          {items.map((item) => (
            <div className="phrase-row" key={item.phraseId}>
              <span className="phrase-text" title={item.text}>{item.label || item.text}</span>
              {PER_EYE_PHRASE_TARGETS.includes(target) ? (
                <span className="phrase-actions">
                  <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "od")} type="button">右</button>
                  <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "os")} type="button">左</button>
                  <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "both")} type="button">両</button>
                </span>
              ) : (
                <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item)} type="button">挿入</button>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
