"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { Modal } from "./modal";
import { isImeKey } from "../lib/modal";

// 薬剤・セット・定型文・利用者に共通の「一覧 + 編集ダイアログ」（デジカルの施設管理と同じく、行の［編集］でモーダルを開く）。
// 保存はダイアログの[保存]の1か所だけ。表の中で直接は直さない（途中の値が保存される不具合を避ける）。

export function useMasterEditor({ idKey, toDraft, toBody, save, validate, fieldLabels = {}, onDirtyChange }) {
  const [selection, setSelection] = useState(null); // { id: 既存の ID または null(新規), original, draft }
  const [pending, setPending] = useState(null); // 破棄の確認待ちの操作
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dirty = Boolean(selection) && JSON.stringify(selection.draft) !== JSON.stringify(selection.original);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 2500);
    return () => clearTimeout(timer);
  }, [flash]);

  function guarded(action) {
    if (dirty) setPending(() => action);
    else action();
  }

  function show(item) {
    const draft = toDraft(item);
    setSelection({ id: item ? item[idKey] : null, original: draft, draft });
    setPending(null);
    setError("");
    setFlash("");
  }

  async function run(body, after) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      after(await save(body));
    } catch (nextError) {
      const label = fieldLabels[String(nextError.field || "").replace(/^(content\.)?/u, "")];
      setError(label ? `「${label}」の値を確認してください。（${nextError.message}）` : nextError.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    selection,
    dirty,
    pending,
    flash,
    error,
    busy,
    open: (item) => guarded(() => show(item)),
    openNew: () => guarded(() => show(null)),
    close: () => guarded(() => {
      setSelection(null);
      setError("");
    }),
    discardPending: () => {
      const action = pending;
      setPending(null);
      action?.();
    },
    keepEditing: () => setPending(null),
    setDraft: (update) => setSelection((current) => (current ? { ...current, draft: typeof update === "function" ? update(current.draft) : update } : current)),
    submit: async (event) => {
      event?.preventDefault();
      if (!selection) return;
      const problem = validate?.(selection.draft);
      if (problem) {
        setError(problem);
        return;
      }
      await run(toBody(selection.draft), (item) => {
        const draft = toDraft(item);
        setSelection({ id: item[idKey], original: draft, draft });
        setFlash("保存しました");
      });
    },
    // 停止・再開はその場で保存する（いつでも戻せるので確認は出さない）。編集途中の他の項目はそのまま残す。
    toggleActive: async () => {
      if (!selection?.id) return;
      const nextActive = selection.original.active === false;
      await run({ ...toBody(selection.original), active: nextActive }, (item) => {
        setSelection((current) => ({ id: item[idKey], original: toDraft(item), draft: { ...current.draft, active: item.active } }));
        setFlash(item.active === false ? "停止しました。一覧の末尾「停止中」に移ります。" : "再開しました");
      });
    }
  };
}

export function MasterToolbar({ query, onQuery, searchLabel, placeholder, addLabel, onAdd }) {
  return (
    <div className="master-toolbar">
      <input aria-label={searchLabel} className="input master-search" onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} type="search" value={query} />
      {onAdd ? <button className="btn btn-primary" onClick={onAdd} type="button">＋ {addLabel}</button> : null}
    </div>
  );
}

export function FilterChips({ label, options, value, onChange }) {
  return (
    <div aria-label={label} className="flow-chips master-chips" role="group">
      {options.map((option) => (
        <button aria-pressed={value === option.value} className="flow-chip" key={option.value ?? "all"} onClick={() => onChange(option.value)} type="button">
          {option.label} <strong>{option.count}</strong>
        </button>
      ))}
    </div>
  );
}

// renderBefore: 行の左に置く別の操作（並び替えの ▲▼ など。行のボタンの中には入れられないため外に置く）
export function MasterRows({ items, idKey, selectedId, onOpen, renderRow, renderBefore = null, className = "" }) {
  return (
    <ul className={`master-rows ${className}`.trim()}>
      {items.map((item, index) => {
        const selected = item[idKey] === selectedId;
        return (
          <li className={`master-row${selected ? " is-selected" : ""}${item.active === false ? " is-inactive" : ""}`} key={item[idKey]}>
            {renderBefore ? renderBefore(item, index) : null}
            <button aria-current={selected ? "true" : undefined} className="master-row-open" onClick={() => onOpen(item)} type="button">
              {renderRow(item)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function EmptyList({ total, canEdit, addLabel, noun }) {
  if (total === 0) return <p className="empty master-empty">まだ登録されていません。{canEdit ? `「＋ ${addLabel}」から登録します。` : ""}</p>;
  return <p className="empty master-empty">該当する{noun}はありません。</p>;
}

// 停止中は末尾に畳んで置く（検索中は開く）
export function InactiveGroup({ items, forceOpen, children }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const expanded = open || forceOpen;
  return (
    <div className="master-group master-inactive">
      <h3 className="master-group-head">
        <button aria-expanded={expanded} className="flow-group-toggle" onClick={() => setOpen(!open)} type="button">
          {expanded ? "▼" : "▶"} 停止中 <span className="master-count">{items.length}</span>
        </button>
        <span className="muted small">カルテの候補には出ません</span>
      </h3>
      {expanded ? children : null}
    </div>
  );
}

// allowToggle=false で「停止する／再開する」を出さない（停止の概念がない一覧で使う）
export function MasterEditorPanel({ editor, title, canEdit, children, extraActions = null, label, allowToggle = true }) {
  const panelRef = useRef(null);
  const { selection } = editor;
  const selectionKey = selection ? selection.id ?? "new" : null;

  useEffect(() => {
    if (!selectionKey || !panelRef.current) return;
    // 新規は最初の入力欄、既存は見出しに移る（狭い画面では一覧から重なって開くため）
    const target = selectionKey === "new" && canEdit
      ? panelRef.current.querySelector("input:not([type=hidden]), select, textarea")
      : panelRef.current.querySelector(".master-panel-title");
    target?.focus({ preventScroll: true });
  }, [selectionKey, canEdit]);

  if (!selection) return null;
  const inactive = selection.original.active === false;
  // Esc・背景のクリックは「閉じる」と同じ（保存していない変更があれば、パネルの中で確かめる）
  return (
    <Modal backdrop="sibling" className="master-panel" dialogRef={panelRef} label={label} onClose={editor.close}>
      <form
        className="master-panel-form"
        onKeyDown={(event) => {
          if (event.key === "Enter" && isImeKey(event)) event.preventDefault();
        }}
        onSubmit={editor.submit}
      >
        <header className="master-panel-head">
          <button aria-label="一覧に戻る" className="btn btn-ghost master-panel-back" onClick={editor.close} type="button">‹ 戻る</button>
          <h2 className="master-panel-title" tabIndex={-1}>{title}</h2>
          {inactive ? <span className="tag">停止中</span> : null}
          <button aria-label="編集を閉じる" className="master-panel-close" onClick={editor.close} type="button">×</button>
        </header>
        {editor.pending ? (
          <div className="master-guard" role="alert">
            <span>保存していない変更があります。</span>
            <button className="btn btn-chip danger-text" onClick={editor.discardPending} type="button">変更を破棄</button>
            <button className="btn btn-chip" onClick={editor.keepEditing} type="button">編集を続ける</button>
          </div>
        ) : null}
        {editor.error ? <p className="alert alert-danger" role="alert">{editor.error}</p> : null}
        <fieldset className="master-panel-body" disabled={!canEdit || editor.busy}>
          {children}
        </fieldset>
        <footer className="master-panel-actions">
          {canEdit ? (
            <>
              {selection.id && allowToggle ? (
                <button className="btn btn-ghost" disabled={editor.busy} onClick={editor.toggleActive} type="button">{inactive ? "再開する" : "停止する"}</button>
              ) : null}
              {extraActions}
              <span aria-live="polite" className="master-flash" role="status">{editor.flash}</span>
              <button className="btn btn-ghost" disabled={editor.busy} onClick={editor.close} type="button">閉じる</button>
              <button className="btn btn-primary" disabled={editor.busy || (!editor.dirty && Boolean(selection.id))} type="submit">{editor.busy ? "保存中…" : "保存"}</button>
            </>
          ) : (
            <>
              <span className="muted small master-flash">変更は管理者が行います。</span>
              <button className="btn btn-ghost" onClick={editor.close} type="button">閉じる</button>
            </>
          )}
        </footer>
      </form>
    </Modal>
  );
}

// 見出しの右に置く操作（デジカルの「見出しの行の右上に［編集］［＋新規登録］」）
export function SectionHead({ title, count, action = null, children }) {
  return (
    <header className="settings-section-head">
      <div className="settings-section-title">
        <h2>{title}{count !== undefined ? <span className="settings-head-count">{count}</span> : null}</h2>
        {action ? <div className="settings-section-action">{action}</div> : null}
      </div>
      {children ? <p className="muted">{children}</p> : null}
    </header>
  );
}

// 小さな編集ダイアログ（医療機関情報・フォルダ）。Esc・背景で閉じる（入力を変えていれば確かめる）。日本語入力の確定の Enter では送らない。
export function SettingsDialog({ title, busy = false, error = "", onClose, onSubmit, submitLabel = "保存", children, wide = false }) {
  const titleId = useId();
  // 入力を 1 度でも変えたら dirty（Esc・背景で閉じる前に確かめる）
  const [touched, setTouched] = useState(false);
  return (
    <Modal
      backdrop="sibling"
      busy={busy}
      className={`master-panel settings-dialog${wide ? " is-wide" : ""}`}
      dirty={touched}
      initialFocus="input:not([type=hidden]), select, textarea"
      labelledBy={titleId}
      onClose={onClose}
    >
      <form
        className="master-panel-form"
        onChange={() => setTouched(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isImeKey(event)) event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        <header className="master-panel-head">
          <button aria-label="閉じて一覧に戻る" className="btn btn-ghost master-panel-back" disabled={busy} onClick={onClose} type="button">‹ 戻る</button>
          <h2 className="master-panel-title" id={titleId}>{title}</h2>
          <button aria-label="閉じる" className="master-panel-close" disabled={busy} onClick={onClose} type="button">×</button>
        </header>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <fieldset className="master-panel-body" disabled={busy}>{children}</fieldset>
        <footer className="master-panel-actions">
          <span className="master-flash" />
          <button className="btn btn-ghost" disabled={busy} onClick={onClose} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy} type="submit">{busy ? "保存中…" : submitLabel}</button>
        </footer>
      </form>
    </Modal>
  );
}

const MASTER_TYPE_NOTES = { drug: "公開マスター（医薬品）", disease: "公開マスター（傷病名）" };

// 公開マスター（支払基金の基本マスター）を引きながら名前を入れる欄。選ばなくても自由に書ける。
// eyeOnly で眼科のものから探す（「眼科以外も」で外せる）。
export function MasterSearchInput({ type, value, onChange, onPick, label, placeholder = "", required = false, maxLength = 200 }) {
  const api = useEyeApi();
  const listId = useId();
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [eyeOnly, setEyeOnly] = useState(true);
  const [status, setStatus] = useState("");
  const ticketRef = useRef(0);
  const typedRef = useRef(false);
  const query = String(value || "").trim();

  useEffect(() => {
    if (!typedRef.current || query.length < 2) {
      setResults([]);
      setStatus("");
      return undefined;
    }
    const ticket = ++ticketRef.current;
    const timer = setTimeout(() => {
      setStatus("検索中…");
      api(`/v1/eye/masters/search?type=${type}&q=${encodeURIComponent(query)}&limit=8${eyeOnly ? "&eye=1" : ""}`)
        .then((payload) => {
          if (ticket !== ticketRef.current) return;
          setResults(payload.results || []);
          setActive(-1);
          setStatus(payload.available === false ? "マスターが読み込まれていません" : (payload.results || []).length ? "" : "マスターに見つかりません（このまま登録できます）");
        })
        .catch(() => { if (ticket === ticketRef.current) { setResults([]); setStatus("マスターを検索できませんでした"); } });
    }, 250);
    return () => clearTimeout(timer);
  }, [api, type, query, eyeOnly]);

  function pick(result) {
    typedRef.current = false;
    setOpen(false);
    setResults([]);
    setStatus("");
    onPick(result);
  }

  const showList = open && (results.length > 0 || status);
  return (
    <div className="master-search-field">
      <input
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={showList}
        aria-label={label}
        autoComplete="off"
        className="input"
        maxLength={maxLength}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => { typedRef.current = true; setOpen(true); onChange(event.target.value); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" && results.length) { event.preventDefault(); setOpen(true); setActive((current) => Math.min(results.length - 1, current + 1)); }
          if (event.key === "ArrowUp" && results.length) { event.preventDefault(); setActive((current) => Math.max(0, current - 1)); }
          if (event.key === "Enter" && open && active >= 0 && results[active]) { event.preventDefault(); pick(results[active]); }
          if (event.key === "Escape" && showList) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        }}
        placeholder={placeholder}
        required={required}
        role="combobox"
        value={value}
      />
      {showList ? (
        <div className="master-search-pop">
          <div className="master-search-pop-head">
            <span>{MASTER_TYPE_NOTES[type] || "公開マスター"}</span>
            <label><input checked={!eyeOnly} onChange={(event) => setEyeOnly(!event.target.checked)} onMouseDown={(event) => event.preventDefault()} type="checkbox" /> 眼科以外も</label>
          </div>
          <ul className="master-search-list" id={listId} role="listbox">
            {results.map((result, index) => (
              <li aria-selected={index === active} className="master-search-option" id={`${listId}-${index}`} key={result.code || index} onMouseDown={(event) => { event.preventDefault(); pick(result); }} role="option">
                <span className="master-search-name">{result.name}</span>
                <span className="master-search-meta">{masterMeta(type, result)}</span>
              </li>
            ))}
          </ul>
          {status ? <p className="master-search-status" role="status">{status}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const DRUG_KIND_SHORT = { eye_drop: "点眼", eye_ointment: "眼軟膏", oral: "内服", injection: "注射", other: "その他" };

function masterMeta(type, result) {
  if (type === "drug") return [DRUG_KIND_SHORT[result.kind] || "", result.unit ? `/${result.unit}` : "", result.generic && result.generic !== result.name ? result.generic : ""].filter(Boolean).join(" ");
  if (type === "disease") return [result.icd10 || result.icd || "", result.code].filter(Boolean).join(" ");
  return result.code || "";
}
