"use client";

import { useEffect, useRef, useState } from "react";

// 薬剤・セット・定型文に共通の「一覧 + 右の編集パネル」。
// 保存はパネルの[保存]の1か所だけ。表の中で直接は直さない（途中の値が保存される不具合を避ける）。

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

export function MasterRows({ items, idKey, selectedId, onOpen, renderRow, className = "" }) {
  return (
    <ul className={`master-rows ${className}`.trim()}>
      {items.map((item) => {
        const selected = item[idKey] === selectedId;
        return (
          <li className={`master-row${selected ? " is-selected" : ""}${item.active === false ? " is-inactive" : ""}`} key={item[idKey]}>
            <button aria-current={selected ? "true" : undefined} className="master-row-open" onClick={() => onOpen(item)} type="button">
              {renderRow(item)}
            </button>
          </li>
        );
      })}
    </ul>
  );
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

export function MasterEditorPanel({ editor, title, canEdit, children, extraActions = null, label }) {
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
  return (
    <>
      <div aria-hidden="true" className="master-backdrop" onClick={editor.close} />
      <aside aria-label={label} className="master-panel" ref={panelRef}>
        <form
          className="master-panel-form"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            if (event.key === "Escape") {
              event.preventDefault();
              editor.close();
            }
          }}
          onSubmit={editor.submit}
        >
          <header className="master-panel-head">
            <button aria-label="一覧に戻る" className="btn btn-ghost master-panel-back" onClick={editor.close} type="button">‹ 戻る</button>
            <h2 className="master-panel-title" tabIndex={-1}>{title}</h2>
            {inactive ? <span className="tag">停止中</span> : null}
            <button aria-label="編集パネルを閉じる" className="master-panel-close" onClick={editor.close} type="button">×</button>
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
                {selection.id ? (
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
      </aside>
    </>
  );
}
