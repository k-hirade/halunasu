"use client";

import { useState } from "react";
import { useEyeApi } from "./eye-api";
import { EmptyList, InactiveGroup, MasterEditorPanel, MasterRows, MasterSearchInput, MasterToolbar, SectionHead, SettingsDialog, useMasterEditor } from "./settings-master";
import { COMMON_USAGES, PRESCRIPTION_KIND_LABELS } from "../lib/format";
import {
  buildFolderTree,
  descendantFolderIds,
  flattenFolderTree,
  folderPathText,
  matchesSearch,
  moveSet,
  normalizeSearch,
  setContentText,
  setSearchValues,
  setsInFolder
} from "../lib/settings";

const ALL = "__all__";
const UNFILED = "";
const numberText = (value) => (value === null || value === undefined ? "" : String(value));
const textNumber = (value) => (String(value).trim() === "" ? null : Number(value));

// セット（デジカルのセット管理: 入れ子のフォルダ・並び替え・セット名/フォルダ/傷病名の編集）。
// 左にフォルダの木、右にそのフォルダのセット。［▲］［▼］で並び順を変える（新しいセットはフォルダの先頭）。
// カルテから作ったセット（「現在のカルテからセットを作成」）もここで直せる。作る・直すのは医師と管理者。
export function OrderSetsSection({ orderSets, setFolders, presets, catalog, canEdit, onSaved, onFolderSaved, onDirtyChange }) {
  const api = useEyeApi();
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState(ALL);
  const [collapsed, setCollapsed] = useState(new Set());
  const [folderEdit, setFolderEdit] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");
  const tree = buildFolderTree(setFolders, orderSets);
  const flat = flattenFolderTree(tree.roots);
  const folderKnown = folderId === ALL || folderId === UNFILED || setFolders.some((item) => item.folderId === folderId && item.active !== false);
  const current = folderKnown ? folderId : ALL;

  const editor = useMasterEditor({
    idKey: "setId",
    toDraft: setToDraft,
    toBody: setBody,
    validate: validateSet,
    fieldLabels: { name: "セット名", description: "説明", plan: "方針に追加する文", findingsText: "主訴・所見", folderId: "フォルダ" },
    onDirtyChange,
    save: async (body) => {
      const isNew = !body.setId;
      // 新しいセットはフォルダの先頭に入れる（デジカルと同じ）
      const siblings = setsInFolder(orderSets, setFolders, body.folderId || UNFILED);
      const sortOrder = isNew ? (siblings.length ? Math.min(...siblings.map((item) => item.sortOrder ?? 0)) - 1 : 0) : undefined;
      const { orderSet } = await api("/v1/eye/order-sets", { method: "POST", body: sortOrder === undefined ? body : { ...body, sortOrder } });
      onSaved(orderSet);
      return orderSet;
    }
  });

  const searching = Boolean(normalizeSearch(query));
  const inFolder = current === ALL ? orderSets : setsInFolder(orderSets, setFolders, current);
  const shown = (current === ALL ? [...inFolder].sort(byFolderThenOrder(setFolders)) : inFolder).filter((item) => matchesSearch(query, setSearchValues(item)));
  const active = shown.filter((item) => item.active !== false);
  const inactive = shown.filter((item) => item.active === false);
  const canReorder = canEdit && current !== ALL && !searching;

  async function move(set, delta) {
    const changes = moveSet(active, set.setId, delta);
    if (!changes.length) return;
    setMoving(true);
    setMoveError("");
    try {
      for (const { set: item, sortOrder } of changes) {
        const { orderSet } = await api("/v1/eye/order-sets", { method: "POST", body: { ...setBody(setToDraft(item)), sortOrder } });
        onSaved(orderSet);
      }
    } catch (nextError) {
      setMoveError(`並び順を保存できませんでした: ${nextError.message}`);
    } finally {
      setMoving(false);
    }
  }

  async function saveFolder() {
    const name = folderEdit.name.trim();
    if (!name) {
      setFolderError("フォルダ名を入れてください。");
      return;
    }
    setFolderBusy(true);
    setFolderError("");
    try {
      const siblings = setFolders.filter((item) => (item.parentId || "") === folderEdit.parentId && item.folderId !== folderEdit.folderId);
      const sortOrder = folderEdit.folderId ? folderEdit.sortOrder ?? 0 : siblings.reduce((max, item) => Math.max(max, (item.sortOrder ?? 0) + 1), 0);
      const { setFolder } = await api("/v1/eye/set-folders", {
        method: "POST",
        body: { ...(folderEdit.folderId ? { folderId: folderEdit.folderId } : {}), name, parentId: folderEdit.parentId, sortOrder, active: folderEdit.active }
      });
      onFolderSaved(setFolder);
      if (!folderEdit.folderId) setFolderId(setFolder.folderId);
      else if (setFolder.active === false && current === setFolder.folderId) setFolderId(ALL);
      setFolderEdit(null);
    } catch (nextError) {
      setFolderError(nextError.message);
    } finally {
      setFolderBusy(false);
    }
  }

  const folderName = (id) => (id && setFolders.some((item) => item.folderId === id && item.active !== false) ? folderPathText(setFolders, id) : "");
  const renderRow = (item) => (
    <>
      <span className="master-name">
        <strong title={item.name}>{item.name}</strong>
        {item.description ? <span className="master-desc" title={item.description}>{item.description}</span> : null}
      </span>
      <span className="master-default" title={setContentText(item) || undefined}>{setContentText(item) || <span className="muted">空</span>}</span>
      <span className="master-kind">{current === ALL ? folderName(item.folderId) || <span className="muted">フォルダなし</span> : ""}</span>
    </>
  );
  const renderOrder = (item, index) => (canReorder ? (
    <span className="set-order">
      <button aria-label={`${item.name} を上へ`} className="btn btn-chip" disabled={moving || index === 0} onClick={() => move(item, -1)} type="button">▲</button>
      <button aria-label={`${item.name} を下へ`} className="btn btn-chip" disabled={moving || index === active.length - 1} onClick={() => move(item, 1)} type="button">▼</button>
    </span>
  ) : null);
  const title = current === ALL ? "すべてのセット" : current === UNFILED ? "フォルダなし" : folderPathText(setFolders, current);

  return (
    <section aria-label="セット" className="settings-section">
      <SectionHead
        action={canEdit ? <button className="btn btn-primary" onClick={editor.openNew} type="button">＋ セットを追加</button> : null}
        count={orderSets.filter((item) => item.active !== false).length}
        title="セット"
      >
        処方・検査・病名・主訴所見・方針の組み合わせ。カルテのセットから一括で入ります。カルテの「現在のカルテからセットを作成」で作ったものもここに並びます。{canEdit ? "" : "登録・変更は医師・管理者が行います。"}
      </SectionHead>
      <div className="set-browser">
        <nav aria-label="セットのフォルダ" className="panel set-tree">
          <div className="set-tree-head">
            <span>フォルダ</span>
            {canEdit ? <button className="btn btn-chip" onClick={() => { setFolderError(""); setFolderEdit({ folderId: "", name: "", parentId: current !== ALL && current !== UNFILED ? current : "", active: true }); }} type="button">＋ フォルダ</button> : null}
          </div>
          <ul className="set-tree-list">
            <li><FolderButton count={orderSets.filter((item) => item.active !== false).length} current={current === ALL} label="すべて" onClick={() => setFolderId(ALL)} /></li>
            {flattenFolderTree(tree.roots, collapsed).map((node) => (
              <li key={node.folder.folderId} style={{ "--depth": node.depth }}>
                <span className="set-tree-row">
                  {node.children.length ? (
                    <button
                      aria-expanded={!collapsed.has(node.folder.folderId)}
                      aria-label={`${node.folder.name} を${collapsed.has(node.folder.folderId) ? "開く" : "閉じる"}`}
                      className="set-tree-toggle"
                      onClick={() => setCollapsed((currentSet) => {
                        const next = new Set(currentSet);
                        if (next.has(node.folder.folderId)) next.delete(node.folder.folderId);
                        else next.add(node.folder.folderId);
                        return next;
                      })}
                      type="button"
                    >
                      {collapsed.has(node.folder.folderId) ? "▸" : "▾"}
                    </button>
                  ) : <span className="set-tree-toggle" />}
                  <FolderButton count={node.totalCount} current={current === node.folder.folderId} label={node.folder.name} onClick={() => setFolderId(node.folder.folderId)} />
                  {canEdit ? (
                    <button aria-label={`フォルダ「${node.folder.name}」を編集`} className="set-tree-edit" onClick={() => { setFolderError(""); setFolderEdit({ ...node.folder, parentId: node.folder.parentId || "", active: node.folder.active !== false }); }} type="button">✎</button>
                  ) : null}
                </span>
              </li>
            ))}
            <li><FolderButton count={tree.unfiled} current={current === UNFILED} label="フォルダなし" muted onClick={() => setFolderId(UNFILED)} /></li>
          </ul>
        </nav>

        <div className="master-list set-list">
          <div className="set-list-head">
            <h3>{title}</h3>
            {canReorder && active.length > 1 ? <span className="muted small">▲▼ で並び順を変えます（カルテのセットも同じ順）</span> : null}
            {canEdit && current === ALL && !searching ? <span className="muted small">並び替えはフォルダを選んでから</span> : null}
          </div>
          <MasterToolbar onQuery={setQuery} placeholder="セット名・薬剤・検査で検索" query={query} searchLabel="セットを検索" />
          {moveError ? <p className="alert alert-danger" role="alert">{moveError}</p> : null}
          {active.length ? (
            <div className="master-table">
              <div aria-hidden="true" className={`master-head set-cols${canReorder ? " has-order" : ""}`}><span>セット名</span><span>中身</span><span>{current === ALL ? "フォルダ" : ""}</span></div>
              <MasterRows className={`set-cols${canReorder ? " has-order" : ""}`} idKey="setId" items={active} onOpen={editor.open} renderBefore={renderOrder} renderRow={renderRow} selectedId={editor.selection?.id} />
            </div>
          ) : <EmptyList addLabel="セットを追加" canEdit={canEdit} noun="セット" total={inFolder.length} />}
          <InactiveGroup forceOpen={searching} items={inactive}>
            <MasterRows className="set-cols" idKey="setId" items={inactive} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
          </InactiveGroup>
        </div>
      </div>

      <MasterEditorPanel canEdit={canEdit} editor={editor} label="セットの編集" title={editor.selection?.id ? editor.selection.original.name : "セットを追加"}>
        {editor.selection ? <OrderSetForm catalog={catalog} draft={editor.selection.draft} flat={flat} presets={presets} setDraft={editor.setDraft} /> : null}
      </MasterEditorPanel>

      {folderEdit ? (
        <SettingsDialog busy={folderBusy} error={folderError} onClose={() => setFolderEdit(null)} onSubmit={saveFolder} title={folderEdit.folderId ? "フォルダの編集" : "フォルダを追加"}>
          <label className="field">
            <span>フォルダ名<em>必須</em></span>
            <input aria-label="フォルダ名" autoComplete="off" className="input" maxLength={200} onChange={(event) => setFolderEdit((currentEdit) => ({ ...currentEdit, name: event.target.value }))} value={folderEdit.name} />
          </label>
          <label className="field">
            <span>親フォルダ</span>
            <select aria-label="親フォルダ" className="input" onChange={(event) => setFolderEdit((currentEdit) => ({ ...currentEdit, parentId: event.target.value }))} value={folderEdit.parentId}>
              <option value="">（最上位）</option>
              {flat
                .filter((node) => !folderEdit.folderId || !descendantFolderIds(setFolders, folderEdit.folderId).has(node.folder.folderId))
                .map((node) => <option key={node.folder.folderId} value={node.folder.folderId}>{`${"　".repeat(node.depth)}${node.folder.name}`}</option>)}
            </select>
          </label>
          {folderEdit.folderId ? (
            <label className="field-check">
              <input checked={!folderEdit.active} onChange={(event) => setFolderEdit((currentEdit) => ({ ...currentEdit, active: !event.target.checked }))} type="checkbox" />
              このフォルダを停止する（中のセットは「フォルダなし」に出ます。セットは消えません）
            </label>
          ) : null}
        </SettingsDialog>
      ) : null}
    </section>
  );

  function setToDraft(item) {
    return {
      setId: item?.setId || "",
      name: item?.name || "",
      description: item?.description || "",
      plan: item?.plan || "",
      folderId: item ? item.folderId || "" : current !== ALL ? current : "",
      findingsText: item?.findingsText || "",
      diagnoses: (item?.diagnoses || []).map((row) => ({ ...row })),
      // Rp のコメント行（カルテから作ったセットにある）はこの画面では編集せず、保存のときにそのまま戻す。
      prescriptions: (item?.prescriptions || []).filter((row) => row.kind !== "comment").map((row) => ({ ...row })),
      orders: (item?.orders || []).filter((row) => row.kind !== "comment").map((row) => ({ ...row })),
      comments: {
        prescriptions: (item?.prescriptions || []).filter((row) => row.kind === "comment"),
        orders: (item?.orders || []).filter((row) => row.kind === "comment")
      },
      active: item ? item.active !== false : true
    };
  }
}

function FolderButton({ label, count, current, onClick, muted = false }) {
  return (
    <button aria-current={current ? "true" : undefined} className={`set-tree-item${muted ? " is-muted" : ""}`} onClick={onClick} type="button">
      <span className="set-tree-name">{label}</span>
      <span className="set-tree-count">{count}</span>
    </button>
  );
}

function byFolderThenOrder(folders) {
  const order = new Map(flattenFolderTree(buildFolderTree(folders).roots).map((node, index) => [node.folder.folderId, index]));
  return (left, right) => (order.get(left.folderId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.folderId) ?? Number.MAX_SAFE_INTEGER)
    || (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
    || String(left.name).localeCompare(String(right.name), "ja");
}

// 送る項目: フォルダ・病名・主訴所見は送るので、空にすれば空になる（API が空へ戻す）。並び順は送らない（元の位置のまま）。
function setBody(draft) {
  return {
    ...(draft.setId ? { setId: draft.setId } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    plan: draft.plan,
    folderId: draft.folderId || "",
    findingsText: draft.findingsText,
    diagnoses: draft.diagnoses.filter((row) => String(row.name || "").trim()).map((row) => ({ ...row, name: row.name.trim() })),
    prescriptions: [...draft.prescriptions.map((row) => ({ ...row, name: String(row.name || "").trim() })), ...(draft.comments?.prescriptions || [])],
    orders: [...draft.orders, ...(draft.comments?.orders || [])],
    active: draft.active
  };
}

function validateSet(draft) {
  if (!draft.name.trim()) return "セット名を入れてください。";
  if (draft.prescriptions.some((row) => !String(row.name || "").trim())) return "薬剤名が空の処方があります。入れるか、行を削除してください。";
  if (draft.orders.some((row) => !row.code)) return "検査が選ばれていない行があります。選ぶか、行を削除してください。";
  return "";
}

// 眼の並びはどの画面も 右 → 左 → 両
const EYE_OPTIONS = [["od", "右眼"], ["os", "左眼"], ["ou", "両眼"]];

function EyeSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} className="input set-eye" onChange={(event) => onChange(event.target.value)} value={value || ""}>
      {!value ? <option disabled value="">（未設定）</option> : null}
      {EYE_OPTIONS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
}

// セットの編集（デジカルの「セット編集」: セット名 / フォルダ / 傷病名 に、主訴所見・処置行為（処方・検査）・方針を足したもの）
function OrderSetForm({ draft, setDraft, presets, catalog, flat }) {
  const activePresets = presets.filter((item) => item.active !== false);
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  const updateRow = (listKey, index, patch) => setDraft((current) => ({
    ...current,
    [listKey]: current[listKey].map((row, i) => (i === index ? { ...row, ...patch } : row))
  }));
  const removeRow = (listKey, index) => setDraft((current) => ({ ...current, [listKey]: current[listKey].filter((_, i) => i !== index) }));
  const commentCount = (draft.comments?.prescriptions?.length || 0) + (draft.comments?.orders?.length || 0);
  return (
    <>
      <label className="field">
        <span>セット名<em>必須</em></span>
        <input autoComplete="off" className="input" maxLength={200} onChange={set("name")} required value={draft.name} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>フォルダ</span>
          <select aria-label="フォルダ" className="input" onChange={set("folderId")} value={draft.folderId}>
            <option value="">（フォルダなし）</option>
            {draft.folderId && !flat.some((node) => node.folder.folderId === draft.folderId) ? <option value={draft.folderId}>（停止したフォルダ）</option> : null}
            {flat.map((node) => <option key={node.folder.folderId} value={node.folder.folderId}>{`${"　".repeat(node.depth)}${node.folder.name}`}</option>)}
          </select>
        </label>
        <label className="field">
          <span>説明</span>
          <input className="input" maxLength={200} onChange={set("description")} placeholder="例: 眼圧安定例。3か月ごと" value={draft.description} />
        </label>
      </div>

      <div className="master-subsection">
        <div className="master-subhead">
          <h3>傷病名 <span className="master-count">{draft.diagnoses.length}</span></h3>
          <button className="btn btn-chip" onClick={() => setDraft((current) => ({ ...current, diagnoses: [...current.diagnoses, { name: "", eye: "ou", suspected: false }] }))} type="button">＋ 傷病名</button>
        </div>
        {draft.diagnoses.map((row, index) => (
          <div className="set-line set-line-dx" key={index}>
            <MasterSearchInput
              label={`傷病名${index + 1}`}
              onChange={(name) => updateRow("diagnoses", index, { name, code: undefined })}
              onPick={(result) => updateRow("diagnoses", index, { name: result.name, code: result.code })}
              placeholder="傷病名（公開マスターから選べます）"
              type="disease"
              value={row.name || ""}
            />
            <EyeSelect label={`傷病名${index + 1} 眼`} onChange={(eye) => updateRow("diagnoses", index, { eye })} value={row.eye} />
            <label className="field-check set-dx-suspected">
              <input checked={row.suspected === true || row.status === "suspected"} onChange={(event) => updateRow("diagnoses", index, { suspected: event.target.checked, ...(row.status === "suspected" ? { status: "active" } : {}) })} type="checkbox" />疑い
            </label>
            <button aria-label={`傷病名${index + 1}を削除`} className="btn btn-chip danger-text" onClick={() => removeRow("diagnoses", index)} type="button">削除</button>
          </div>
        ))}
        {draft.diagnoses.length ? <p className="muted small">セットを入れると、この傷病名も患者の病名に入ります（カルテ側で確認）。</p> : null}
      </div>

      <label className="field">
        <span>主訴・所見</span>
        <textarea aria-label="主訴・所見" className="input" maxLength={10000} onChange={set("findingsText")} placeholder="カルテの主訴・所見が空のときに入ります" rows={3} value={draft.findingsText} />
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
        {commentCount ? <p className="muted small">Rp のコメント {commentCount}件（カルテで付けたもの）はそのまま残ります。</p> : null}
      </div>

      <label className="field">
        <span>方針に追加する文</span>
        <textarea className="input" maxLength={4000} onChange={set("plan")} rows={3} value={draft.plan} />
      </label>
    </>
  );
}
