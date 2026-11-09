"use client";

import { useState } from "react";
import { calculateEyeDropBottles, groupRps, planItemsFromPreset, setPlanItemsEye, mergePlanItems } from "@halunasu/eye-core";
import { NEXT_VISIT_PLAN_PRESETS, PLAN_ITEM_EYE_LABELS, RP_SHARED_FIELDS } from "@halunasu/eye-contracts";
import { AdherenceLine, showAdherence } from "./encounter-extras";
import { formatTime, OpticalSection, parseNumber } from "./encounter-sections";
import { closeMenu, COPY_DRAG_TYPE, newRpId, ORDER_BADGES, RX_BADGES, TOPICAL_KINDS } from "./chart-shared";
import { addDays, COMMON_USAGES, EYE_LABELS, formatShortDate } from "../lib/format";

const EYE_CHOICES = [["od", "R"], ["os", "L"], ["ou", "両"]];
const ORDER_STATUS_LABELS = { planned: "予定", performed: "実施済", cancelled: "取消" };
const PLAN_EYES = ["od", "os", "ou", "none"];

// 中央の右の列「処置・行為」。デジカルの区分バッジ付きの束（Rp）を並べる: 処方 → 検査・処置 → 眼鏡・CL → 次回予定。
// 束を押すと「選択中」になり、右のオーダー欄で選んだ薬・行為はその束に入る（選択していなければ新しい束）。
export function ActsColumn({
  content, update, editable, drugPresets, catalog, nextDays, selectedRp, onSelectRp, encounterId, encounterDate,
  suggestion, bookAction, onDropCopy, onClearAll
}) {
  const [dropping, setDropping] = useState(false);
  const rxGroups = groupRps(content.prescriptions || []);
  const orderGroups = groupRps(content.orders || []);
  const carried = (content.prescriptions || []).filter((row) => row.carriedOver && row.kind !== "comment").length;
  const empty = !rxGroups.length && !orderGroups.length && !content.optical?.type;

  function onDrop(event) {
    const raw = event.dataTransfer.getData(COPY_DRAG_TYPE);
    setDropping(false);
    if (!raw || !editable) return;
    event.preventDefault();
    try {
      onDropCopy(JSON.parse(raw), "right");
    } catch {
      // 形の違うデータは無視する
    }
  }

  return (
    <section
      aria-labelledby="acts-heading"
      className={`chart-col chart-col-acts${dropping ? " is-drop-target" : ""}`}
      id="sec-acts"
      onDragLeave={() => setDropping(false)}
      onDragOver={(event) => {
        if (!editable || !event.dataTransfer.types.includes(COPY_DRAG_TYPE)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDrop={onDrop}
    >
      <div className="chart-col-head">
        <h2 id="acts-heading">処置・行為</h2>
        {editable && !empty ? (
          <button aria-label="処置・行為をすべて消す" className="col-tool" onClick={onClearAll} title="処方・検査処置・眼鏡をすべて消す" type="button">🗑</button>
        ) : null}
      </div>
      <div className="chart-col-body">
        {carried ? (
          <p className="rx-carried">
            <span>前回からの引き継ぎ <strong>{carried}件</strong>（未確認）</span>
            {editable ? (
              <button className="btn btn-chip" onClick={() => update(["prescriptions"], content.prescriptions.map((row) => ({ ...row, carriedOver: false })))} title="引き継いだ処方を、今回の処方として確認します（次へ・確定のときにも確認できます）" type="button">このまま継続</button>
            ) : null}
          </p>
        ) : null}
        {empty ? <p className="acts-empty">{editable ? "右のオーダー欄から選ぶか、診療履歴の束を押す・ドラッグすると入ります。" : "処置・行為はありません。"}</p> : null}
        {rxGroups.map((group, index) => (
          <RxGroup
            content={content}
            drugPresets={drugPresets}
            editable={editable}
            group={group}
            key={group.rpId}
            nextDays={nextDays}
            number={index + 1}
            onSelect={() => onSelectRp(selectedRp?.field === "prescriptions" && selectedRp.rpId === group.rpId ? null : { field: "prescriptions", rpId: group.rpId })}
            selected={selectedRp?.field === "prescriptions" && selectedRp.rpId === group.rpId}
            update={update}
          />
        ))}
        {showAdherence(content) ? (
          <fieldset className="plain-fieldset" disabled={!editable}><AdherenceLine content={content} editable={editable} update={update} /></fieldset>
        ) : null}
        {orderGroups.map((group) => (
          <OrderGroup
            content={content}
            editable={editable}
            group={group}
            key={group.rpId}
            onSelect={() => onSelectRp(selectedRp?.field === "orders" && selectedRp.rpId === group.rpId ? null : { field: "orders", rpId: group.rpId })}
            selected={selectedRp?.field === "orders" && selectedRp.rpId === group.rpId}
            update={update}
          />
        ))}
        {content.optical?.type ? (
          <div className="rp-group is-optical" id="sec-optical">
            <div className="rp-optical-head">
              <span className="rp-badge is-optical">{content.optical.type === "contact" ? "CL" : "眼鏡"}</span>
              <strong>{content.optical.type === "contact" ? "コンタクトレンズ" : "眼鏡"}処方</strong>
            </div>
            <fieldset className="plain-fieldset" disabled={!editable}>
              <OpticalSection content={content} editable={editable} encounterId={encounterId} update={update} />
            </fieldset>
            {editable ? <button className="link-button" onClick={() => update(["optical"], { ...content.optical, type: "", issue: false })} type="button">眼鏡・CL の欄を外す</button> : null}
          </div>
        ) : null}
        <NextPlan
          bookAction={bookAction}
          catalog={catalog}
          content={content}
          editable={editable}
          encounterDate={encounterDate}
          suggestion={suggestion}
          update={update}
        />
      </div>
    </section>
  );
}

function setRows(rows, predicate, patch) {
  return rows.map((row, index) => (predicate(row, index) ? { ...row, ...patch } : row));
}

function RpBadgeMenu({ label, className = "", editable, children, title }) {
  if (!editable) return <span className={`rp-badge ${className}`} title={title}>{label}</span>;
  return (
    <details className={`more-menu rp-badge-menu`} onClick={(event) => event.stopPropagation()}>
      <summary aria-label={`${label}の操作`} className={`rp-badge ${className}`} title={title}>{label}▾</summary>
      <div className="more-menu-list">{children}</div>
    </details>
  );
}

function RxGroup({ group, number, content, update, editable, drugPresets, nextDays, selected, onSelect }) {
  const rows = content.prescriptions;
  const head = group.head || {};
  const indexes = new Set(group.rows.map((item) => item.index));
  const presetById = new Map(drugPresets.map((preset) => [preset.presetId, preset]));
  const carried = group.items.some(({ row }) => row.carriedOver);
  const notIssued = group.items.length > 0 && group.items.every(({ row }) => row.issued === false);

  // Rp の共有項目（院内外・用法・回数・日数・眼）は束の全部の薬剤行にそろえる。
  function setShared(patch) {
    const shared = Object.fromEntries(Object.entries(patch).filter(([key]) => RP_SHARED_FIELDS.includes(key)));
    update(["prescriptions"], setRows(rows, (row, index) => indexes.has(index) && row.kind !== "comment", { ...shared, carriedOver: false }));
  }
  function setRow(index, patch) {
    update(["prescriptions", index], { ...rows[index], carriedOver: false, ...patch });
  }
  function removeRow(index) {
    update(["prescriptions"], rows.filter((_, rowIndex) => rowIndex !== index));
  }
  function removeGroup() {
    update(["prescriptions"], rows.filter((_, rowIndex) => !indexes.has(rowIndex)));
  }
  // legacy（rpId の無い 1 行）にコメントを付けるときは、先に rpId を振る
  function addComment(scope) {
    const rpId = group.legacy ? newRpId() : group.rpId;
    const base = group.legacy ? setRows(rows, (_, index) => indexes.has(index), { rpId }) : rows;
    const last = Math.max(...indexes);
    const next = [...base.slice(0, last + 1), { kind: "comment", rpId, text: "", scope }, ...base.slice(last + 1)];
    update(["prescriptions"], next);
  }
  // 両眼の束を右眼・左眼の 2 つの束に分ける（片眼だけ変更・中止するとき）
  function splitEyes() {
    const leftRp = newRpId();
    const rightRp = group.legacy ? newRpId() : group.rpId;
    const items = group.rows.map(({ row }) => row);
    const right = items.map((row) => (row.kind === "comment" ? { ...row, rpId: rightRp } : { ...row, rpId: rightRp, eye: "od", quantity: null }));
    const left = items.filter((row) => row.kind !== "comment").map((row) => ({ ...row, rpId: leftRp, eye: "os", quantity: null }));
    const first = Math.min(...indexes);
    const kept = rows.filter((_, index) => !indexes.has(index));
    const position = rows.slice(0, first).filter((_, index) => !indexes.has(index)).length;
    update(["prescriptions"], [...kept.slice(0, position), ...right, ...left, ...kept.slice(position)]);
  }
  function setAllDays(days) {
    update(["prescriptions"], rows.map((row) => (row.kind !== "comment" && row.issued !== false ? { ...row, days } : row)));
  }

  const badge = RX_BADGES[head.kind] || "薬";
  return (
    <div
      aria-label={`処方 Rp${number}`}
      className={`rp-group is-rx${selected ? " is-selected" : ""}${carried ? " is-carried" : ""}${notIssued ? " is-not-issued" : ""}`}
      data-rp={group.rpId}
      onClick={(event) => { if (editable && !event.target.closest("input, select, button, summary, textarea, a, details")) onSelect(); }}
      role="group"
    >
      <ul className="rp-rows">
        {group.rows.map(({ row, index }) => {
          if (row.kind === "comment") {
            return (
              <li className="rp-row is-comment" key={index}>
                <span aria-hidden="true" className="rp-comment-mark">※</span>
                {editable ? (
                  <input aria-label="コメント" className="input rp-comment-input" maxLength={200} onChange={(event) => update(["prescriptions", index, "text"], event.target.value)} placeholder="コメント（例: 後発品変更不可）" value={row.text || ""} />
                ) : <span className="rp-comment-text">{row.text}</span>}
                <span className="rp-comment-scope">{row.scope === "chart" ? "カルテのみ" : "処方箋"}</span>
                {editable ? <button aria-label={`コメント「${row.text}」を削除`} className="rp-x" onClick={() => removeRow(index)} type="button">×</button> : null}
              </li>
            );
          }
          const preset = row.presetId ? presetById.get(row.presetId) : null;
          const days = row.days || nextDays;
          const bottles = row.kind === "eye_drop" && row.issued !== false
            ? calculateEyeDropBottles({ timesPerDay: row.timesPerDay, eye: row.eye, days, dropsPerBottle: preset?.dropsPerBottle })
            : null;
          return (
            <li className="rp-row" key={index}>
              <RpBadgeMenu editable={editable} label={RX_BADGES[row.kind] || badge}>
                <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); addComment("free"); }} type="button">コメントを追加（処方箋に載せる）</button>
                <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); addComment("chart"); }} type="button">コメントを追加（カルテのみ）</button>
                {head.eye === "ou" && TOPICAL_KINDS.has(head.kind) ? (
                  <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); splitEyes(); }} type="button">左右に分ける</button>
                ) : null}
                <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setRow(index, { issued: row.issued === false }); }} type="button">{row.issued === false ? "今回も出す" : "今回は出さない（継続中）"}</button>
                <button className="btn btn-ghost danger-text" onClick={(event) => { closeMenu(event); removeRow(index); }} type="button">この薬を削除</button>
              </RpBadgeMenu>
              {editable && !row.name ? (
                <input aria-label="薬剤名" autoFocus className="input rp-name-input" list="drug-presets" onChange={(event) => setRow(index, { name: event.target.value })} placeholder="薬剤名" value={row.name} />
              ) : (
                <span className={`rp-name${row.name ? "" : " is-missing"}`} title={row.drugCode ? `医薬品コード ${row.drugCode}` : undefined}>
                  {row.issued === false ? <span className="rx-off">（今回なし）</span> : null}
                  {row.name || "（薬剤名なし）"}
                </span>
              )}
              {row.carriedOver ? <span className="tag tag-warn rx-carried-tag" title="前回から引き継いだ処方です（未確認）">引継</span> : null}
              <span className="rp-qty">
                {editable ? (
                  <>
                    <input aria-label="数量" className="input input-num rp-qty-input" disabled={row.issued === false} min="0" onChange={(event) => setRow(index, { quantity: parseNumber(event.target.value) })} step="any" type="number" value={row.quantity ?? ""} />
                    <input aria-label="単位" className="input rp-unit-input" disabled={row.issued === false} maxLength={20} onChange={(event) => setRow(index, { unit: event.target.value })} placeholder="本" value={row.unit || ""} />
                  </>
                ) : <span>{row.issued !== false && row.quantity ? `${row.quantity}${row.unit || ""}` : ""}</span>}
              </span>
              {editable && bottles?.bottles && !(row.quantity === bottles.bottles && row.unit === "本") ? (
                <button
                  className="btn btn-chip rp-bottles"
                  onClick={() => setRow(index, { quantity: bottles.bottles, unit: "本" })}
                  title={`${days}日 × 1日${row.timesPerDay}回 × ${row.eye === "ou" ? 2 : 1}眼 = ${bottles.dropsNeeded}滴 ÷ 1本${bottles.dropsPerBottle}滴${row.days ? "" : "（次回まで）"}`}
                  type="button"
                >
                  目安{bottles.bottles}本 反映
                </button>
              ) : null}
              {editable ? <button aria-label={`${row.name || "薬剤"}を削除`} className="rp-x" onClick={() => removeRow(index)} type="button">×</button> : null}
            </li>
          );
        })}
      </ul>
      <div className="rp-foot">
        {editable ? (
          <select aria-label="院内・院外" className="input rp-route" onChange={(event) => setShared({ route: event.target.value })} value={head.route || "outside"}>
            <option value="outside">院外</option>
            <option value="inside">院内</option>
          </select>
        ) : <span className="rp-route-static">{head.route === "inside" ? "院内" : "院外"}</span>}
        {TOPICAL_KINDS.has(head.kind) || head.eye ? (
          <EyeSegment ariaLabel="処方の眼" editable={editable} missing={TOPICAL_KINDS.has(head.kind) && !head.eye} onChange={(eye) => setShared({ eye })} value={head.eye} />
        ) : null}
        <UsagePill editable={editable} onChange={setShared} row={head} />
        <label className="rp-days">
          {editable ? <input aria-label="日数" className="input input-num rp-days-input" min="0" onChange={(event) => setShared({ days: parseNumber(event.target.value) })} type="number" value={head.days ?? ""} /> : <span>{head.days ?? "—"}</span>}
          <span>日</span>
        </label>
        {editable && head.days && rows.filter((row) => row.kind !== "comment").length > group.items.length ? (
          <button className="btn btn-chip rp-days-all" onClick={() => setAllDays(head.days)} title="すべての処方の日数をこの日数にそろえる" type="button">一括反映</button>
        ) : null}
        {carried && editable ? (
          <button className="btn btn-chip" onClick={() => setShared({})} title="この束を今回の処方として確認します" type="button">継続</button>
        ) : null}
        {editable ? <button aria-label={`Rp${number}を削除`} className="col-tool rp-delete" onClick={removeGroup} title="この束を削除" type="button">🗑</button> : null}
      </div>
    </div>
  );
}

export function EyeSegment({ value, onChange, editable, ariaLabel, missing = false, choices = EYE_CHOICES }) {
  if (!editable) return <span className={`rp-eye-static${missing ? " is-missing" : ""}`}>{value ? EYE_LABELS[value] || PLAN_ITEM_EYE_LABELS[value] : "眼 未指定"}</span>;
  return (
    <span aria-label={ariaLabel} className={`segmented rp-eye${missing ? " is-missing" : ""}`} role="group">
      {choices.map(([key, label]) => (
        <button aria-pressed={value === key} key={key} onClick={() => onChange(value === key ? "" : key)} type="button">{label}</button>
      ))}
    </span>
  );
}

// 用法のピル（デジカルの「用法を選択してください」）。押すと 1 日の回数と用法の候補、自由入力。
function UsagePill({ row, onChange, editable }) {
  const text = [row.timesPerDay ? `1日${row.timesPerDay}回` : "", row.usage || ""].filter(Boolean).join(" ");
  if (!editable) return <span className="usage-pill is-static">{text || "用法なし"}</span>;
  return (
    <details className="more-menu usage-menu">
      <summary aria-label="用法" className={`usage-pill${text ? "" : " is-empty"}`}>{text || "用法を選択"}</summary>
      <div className="more-menu-list usage-list">
        <div aria-label="1日の回数" className="usage-times" role="group">
          {[1, 2, 3, 4, 5, 6].map((times) => (
            <button aria-pressed={row.timesPerDay === times} className="btn btn-chip" key={times} onClick={() => onChange({ timesPerDay: row.timesPerDay === times ? null : times })} type="button">{times}回</button>
          ))}
        </div>
        <div className="usage-choices">
          {COMMON_USAGES.map((usage) => (
            <button aria-pressed={row.usage === usage} className="btn btn-chip" key={usage} onClick={(event) => { closeMenu(event); onChange({ usage }); }} type="button">{usage}</button>
          ))}
        </div>
        <input aria-label="用法（自由入力）" className="input" maxLength={120} onChange={(event) => onChange({ usage: event.target.value })} placeholder="自由入力" value={row.usage || ""} />
      </div>
    </details>
  );
}

function OrderGroup({ group, content, update, editable, selected, onSelect }) {
  const rows = content.orders || [];
  const indexes = new Set(group.rows.map((item) => item.index));
  const setRow = (index, patch) => update(["orders", index], { ...rows[index], ...patch });
  const removeRow = (index) => update(["orders"], rows.filter((_, rowIndex) => rowIndex !== index));
  function addComment(scope) {
    const rpId = group.legacy ? newRpId() : group.rpId;
    const base = group.legacy ? setRows(rows, (_, index) => indexes.has(index), { rpId }) : rows;
    const last = Math.max(...indexes);
    const orderId = `ord_${Date.now().toString(36)}c`;
    update(["orders"], [...base.slice(0, last + 1), { orderId, kind: "comment", rpId, text: "", scope }, ...base.slice(last + 1)]);
  }
  return (
    <div
      aria-label="検査・処置"
      className={`rp-group is-order${selected ? " is-selected" : ""}`}
      data-rp={group.rpId}
      onClick={(event) => { if (editable && !event.target.closest("input, select, button, summary, textarea, a, details")) onSelect(); }}
      role="group"
    >
      <ul className="rp-rows">
        {group.rows.map(({ row, index }) => {
          if (row.kind === "comment") {
            return (
              <li className="rp-row is-comment" key={row.orderId}>
                <span aria-hidden="true" className="rp-comment-mark">※</span>
                {editable ? (
                  <input aria-label="コメント" className="input rp-comment-input" maxLength={200} onChange={(event) => setRow(index, { text: event.target.value })} placeholder="コメント（例: 両側）" value={row.text || ""} />
                ) : <span className="rp-comment-text">{row.text}</span>}
                <span className="rp-comment-scope">{row.scope === "chart" ? "カルテのみ" : "レセプト"}</span>
                {editable ? <button aria-label={`コメント「${row.text}」を削除`} className="rp-x" onClick={() => removeRow(index)} type="button">×</button> : null}
              </li>
            );
          }
          const status = row.status || "planned";
          return (
            <li className={`rp-row order-row is-${status}`} key={row.orderId}>
              <RpBadgeMenu className="is-order" editable={editable} label={ORDER_BADGES[row.kind] || "検査"}>
                <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); addComment("free"); }} type="button">コメントを追加（レセプトに載せる）</button>
                <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); addComment("chart"); }} type="button">コメントを追加（カルテのみ）</button>
                {status === "planned" && !row.statusChangedBy ? (
                  <button className="btn btn-ghost danger-text" onClick={(event) => { closeMenu(event); removeRow(index); }} type="button">削除</button>
                ) : null}
              </RpBadgeMenu>
              <span className="rp-name" title={row.procedureCode ? `診療行為コード ${row.procedureCode}` : undefined}>{row.name || row.code}</span>
              {row.sourceEncounterId ? <span className="tag rp-plan-tag" title="前回の診療予定から入った項目です">前回予定</span> : null}
              {row.eye || editable ? <EyeSegment ariaLabel={`${row.name}の眼`} editable={editable} onChange={(eye) => setRow(index, { eye })} value={row.eye} /> : null}
              <span className="rp-status">
                <span className={`tag order-status-${status}`}>{ORDER_STATUS_LABELS[status]}</span>
                {row.statusChangedBy ? <span className="muted small">{row.statusChangedBy.displayName} {formatTime(row.statusChangedAt)}</span> : null}
              </span>
              {editable ? (
                <span className="rp-status-actions">
                  {status !== "performed" ? <button className="btn btn-chip" onClick={() => setRow(index, { status: "performed" })} type="button">実施</button> : null}
                  {status === "planned" ? <button className="btn btn-chip" onClick={() => setRow(index, { status: "cancelled" })} type="button">取消</button> : null}
                  {status !== "planned" ? <button className="btn btn-chip" onClick={() => setRow(index, { status: "planned" })} type="button">予定に戻す</button> : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// 次回予定（トプコンの診療予定: 項目 × 部位）と次回の受診時期。次回のカルテで「前回予定」の検査として入る。
export function NextPlan({ content, update, editable, catalog, encounterDate, suggestion, bookAction }) {
  const nextVisit = content.nextVisit || {};
  const items = nextVisit.planItems || [];
  const weeks = nextVisit.intervalWeeks;
  const nextDate = weeks ? addDays(encounterDate, Math.round(weeks * 7)) : "";
  const [code, setCode] = useState("");
  const setItems = (next) => update(["nextVisit", "planItems"], next);
  const addPreset = (presetId) => setItems(mergePlanItems(items, planItemsFromPreset(presetId, { catalog })));
  const addItem = () => {
    const item = catalog.find((entry) => entry.code === code);
    if (!item) return;
    setItems(mergePlanItems(items, [{ code: item.code, name: item.name, eye: item.requiresEye === false ? "none" : "ou" }]));
    setCode("");
  };
  return (
    <div className="rp-group is-plan" id="sec-next-visit">
      <div className="rp-plan-head">
        <span className="rp-badge is-plan">予定</span>
        <strong>次回</strong>
        <label className="inline-field">
          {editable ? <input aria-label="次回まで（週）" className="input input-num input-short" inputMode="decimal" min="0" onChange={(event) => update(["nextVisit", "intervalWeeks"], parseNumber(event.target.value))} type="number" value={weeks ?? ""} /> : <span>{weeks ?? "—"}</span>}
          <span>週後</span>
        </label>
        {nextDate ? <span className="muted small">{formatShortDate(nextDate)}</span> : null}
        {bookAction}
      </div>
      {editable ? (
        <input aria-label="次回のメモ" className="input rp-plan-note" maxLength={200} onChange={(event) => update(["nextVisit", "note"], event.target.value)} placeholder="メモ（例: 視野検査予定）" value={nextVisit.note || ""} />
      ) : nextVisit.note ? <p className="small">{nextVisit.note}</p> : null}
      {editable && suggestion && suggestion.intervalWeeks !== weeks && !(suggestion.basis === "default" && weeks) ? (
        <div className="suggestion">
          <span>候補 <strong>{suggestion.intervalWeeks}週後</strong> <span className="muted small">{suggestion.explanation}</span></span>
          <button className="btn btn-chip" onClick={() => update(["nextVisit", "intervalWeeks"], suggestion.intervalWeeks)} type="button">採用</button>
        </div>
      ) : null}
      <div className="plan-items" aria-label="次回の診療予定">
        {items.length ? (
          <table className="plan-table">
            <thead>
              <tr><th scope="col">診療項目</th><th scope="col">部位</th>{editable ? <th aria-label="削除" scope="col" /> : null}</tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.code || item.name}-${index}`}>
                  <td>{item.name || item.code}</td>
                  <td>
                    <EyeSegment
                      ariaLabel={`${item.name || item.code}の部位`}
                      choices={PLAN_EYES.map((eye) => [eye, PLAN_ITEM_EYE_LABELS[eye]])}
                      editable={editable}
                      onChange={(eye) => setItems(items.map((entry, entryIndex) => (entryIndex === index ? { ...entry, eye: eye || "none" } : entry)))}
                      value={item.eye || "none"}
                    />
                  </td>
                  {editable ? <td><button aria-label={`${item.name || item.code}を予定から削除`} className="rp-x" onClick={() => setItems(items.filter((_, entryIndex) => entryIndex !== index))} type="button">×</button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">次回の検査予定はありません。</p>}
        {editable ? (
          <>
            {items.length ? (
              <div aria-label="部位を一括で変える" className="plan-all" role="group">
                {PLAN_EYES.map((eye) => (
                  <button className="btn btn-chip" key={eye} onClick={() => setItems(setPlanItemsEye(items, eye))} type="button">全て{PLAN_ITEM_EYE_LABELS[eye]}</button>
                ))}
              </div>
            ) : null}
            <div aria-label="予定のプリセット" className="plan-presets" role="group">
              {NEXT_VISIT_PLAN_PRESETS.filter((preset) => preset.codes.length).map((preset) => (
                <button className="btn btn-chip" key={preset.presetId} onClick={() => addPreset(preset.presetId)} type="button">{preset.label}</button>
              ))}
            </div>
            <div className="add-row plan-add">
              <select aria-label="予定に足す検査" className="input grow" onChange={(event) => setCode(event.target.value)} value={code}>
                <option value="">検査・処置を選ぶ</option>
                {catalog.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
              <button className="btn btn-ghost" disabled={!code} onClick={addItem} type="button">予定に追加</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
