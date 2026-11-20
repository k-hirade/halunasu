"use client";

import { useState } from "react";
import { DEFAULT_DISPLAY_PREFS, moveItem, normalizeDisplayPrefs, setItemHidden, TEXT_SIZES } from "../lib/display-prefs";
import { LEFT_TABS } from "./encounter-panels";
import { Modal, useChangedSince } from "./modal";

// 表示の設定（利用者メニューから開く）。この端末・この利用者だけに効く。
// navItems は権限で出せるヘッダーの項目だけ（{ id, label }）。保存するまで画面は変わらない。
export function DisplaySettingsDialog({ navItems, prefs, onClose, onSave }) {
  const [draft, setDraft] = useState(() => normalizeDisplayPrefs(prefs));
  const dirty = useChangedSince(draft);

  function save(event) {
    event.preventDefault();
    onSave(draft);
    onClose();
  }

  return (
    <Modal as="form" className="dialog dialog-wide display-settings" dirty={dirty} labelledBy="display-settings-heading" onClose={onClose} onSubmit={save}>
      <h2 id="display-settings-heading">表示の設定</h2>
      <p className="muted small">この端末で、ご自分の表示だけが変わります。</p>
      <div className="display-settings-lists">
        <OrderList
          hint="検索・ヘルプ・利用者メニューはいつも出ます。"
          items={navItems}
          list={draft.nav}
          onChange={(nav) => setDraft({ ...draft, nav })}
          title="上のアイコン"
        />
        <OrderList
          hint="1 つは出してください。Shift+数字のキーは並べ替えても同じタブを開きます（隠したタブも開けます）。"
          items={LEFT_TABS}
          keepOne
          list={draft.leftTabs}
          onChange={(leftTabs) => setDraft({ ...draft, leftTabs })}
          title="カルテ左のタブ"
        />
      </div>
      <div className="display-settings-more">
        <label className="check-line">
          <input checked={draft.guide} onChange={(event) => setDraft({ ...draft, guide: event.target.checked })} type="checkbox" />
          カルテガイド（記入状況のボタン）を出す
        </label>
        <fieldset className="plain-fieldset display-settings-size">
          <legend>文字の大きさ</legend>
          {Object.entries(TEXT_SIZES).map(([value, label]) => (
            <label className="check-line" key={value}>
              <input checked={draft.textSize === value} name="textSize" onChange={() => setDraft({ ...draft, textSize: value })} type="radio" value={value} />
              {label}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-ghost display-settings-reset" onClick={() => setDraft(normalizeDisplayPrefs(DEFAULT_DISPLAY_PREFS))} type="button">既定に戻す</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">キャンセル</button>
        <button className="btn btn-primary" type="submit">保存</button>
      </div>
    </Modal>
  );
}

// チェック（出す・隠す）と ↑↓（並び順）の一覧。並びは list.order、表示するのは items にあるものだけ
function OrderList({ title, hint, items, list, onChange, keepOne = false }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = [...list.order.filter((id) => byId.has(id)), ...items.map((item) => item.id).filter((id) => !list.order.includes(id))];
  const visibleCount = ids.filter((id) => !list.hidden.includes(id)).length;
  const headingId = `display-list-${title}`;
  return (
    <section aria-labelledby={headingId} className="display-list">
      <h3 id={headingId}>{title}</h3>
      <p className="muted small">{hint}</p>
      <ol className="display-list-items">
        {ids.map((id, index) => {
          const item = byId.get(id);
          const shown = !list.hidden.includes(id);
          const lastShown = keepOne && shown && visibleCount <= 1;
          return (
            <li className="display-list-item" data-item={id} key={id}>
              <label className="display-list-check">
                <input
                  checked={shown}
                  disabled={lastShown}
                  onChange={(event) => onChange(setItemHidden(list, id, !event.target.checked))}
                  title={lastShown ? "1 つは出してください" : undefined}
                  type="checkbox"
                />
                <span>{item.label}</span>
              </label>
              <span className="display-list-move">
                {/* 端まで来てもフォーカスが外れないよう disabled にはしない（押しても動かない） */}
                <button aria-disabled={index === 0} aria-label={`${item.label}を上へ`} className="btn btn-chip" onClick={() => onChange(moveItem(list, id, -1, ids))} type="button">↑</button>
                <button aria-disabled={index === ids.length - 1} aria-label={`${item.label}を下へ`} className="btn btn-chip" onClick={() => onChange(moveItem(list, id, 1, ids))} type="button">↓</button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
