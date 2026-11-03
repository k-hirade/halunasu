"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useEyeApi, useEyeFileTransfer } from "./eye-api";
import { diffChips, diffItems, groupByCategory, itemSummary } from "../lib/billing-diff";
import { addDays, ageOn, DIAGNOSIS_STATUS_LABELS, formatDate, SEX_LABELS, todayIso, VISIT_TYPE_LABELS } from "../lib/format";

const EYE = { od: "右", os: "左", ou: "両" };
// 一覧のまとまり。人が見るべきもの（要再連携）を上に、済んだもの（連携済み）は畳む
const GROUPS = [
  { key: "changed", label: "要再連携" },
  { key: "pending", label: "未連携" },
  { key: "drafts", label: "修正中・未確定" },
  { key: "handed_off", label: "連携済み" }
];
const MAX_CHIPS = 3;

// 会計連携。確定済みカルテの実施内容を、レセコンに渡す CSV と会計連絡票にする。
// 品目はここでは直さない（カルテで直す）。CSV は患者ごとの全品目で、差分だけの CSV は作らない。
export function BillingWorkspace() {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  const [date, setDate] = useState(todayIso());
  const [day, setDay] = useState(null);
  const [facilityName, setFacilityName] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState(null);
  const [open, setOpen] = useState(new Set());
  const [showHandedOff, setShowHandedOff] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [printIds, setPrintIds] = useState(null);
  const requestRef = useRef(0);

  // reselect: 未連携の全員を選び直す（日付を開いたときと連携の後）。それ以外は、選んでいた人のうち未連携のままの人だけ残す
  const load = useCallback(async ({ reselect }) => {
    const ticket = ++requestRef.current;
    const payload = await api(`/v1/eye/billing/day?date=${date}`);
    if (ticket !== requestRef.current) return;
    setDay(payload);
    const pending = payload.encounters.filter((item) => item.handoff.state === "pending").map((item) => item.encounterId);
    setSelected((current) => new Set(reselect ? pending : pending.filter((id) => current.has(id))));
  }, [api, date]);

  useEffect(() => {
    load({ reselect: true }).catch((nextError) => setError(nextError.message));
  }, [load]);

  // 日付を変えたら、前の日の一覧・通知・エラーは同じ描画で消す（別の日の「連携済みにしました」を残さない）
  function changeDate(next) {
    if (next === date) return;
    setDate(next);
    setDay(null);
    setError("");
    setNotice(null);
    setLastRun(null);
    setOpen(new Set());
    setFilter(null);
    setSelected(new Set());
  }

  useEffect(() => {
    api("/v1/eye/bootstrap")
      .then((payload) => setFacilityName((payload.facilities || []).find((item) => item.status === "active")?.displayName || payload.facilities?.[0]?.displayName || ""))
      .catch(() => {});
  }, [api]);

  // 連絡票の印刷: 対象の人だけを描いてから印刷し、終わったら必ず元に戻す
  useEffect(() => {
    if (!printIds) return undefined;
    const reset = () => setPrintIds(null);
    window.addEventListener("afterprint", reset);
    const timer = setTimeout(() => {
      window.print();
      setTimeout(reset, 500);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", reset);
    };
  }, [printIds]);

  // data は文字列か、サーバーから受けたバイト列。バイト列は先頭の BOM（Excel が UTF-8 と判断する印）を保つためにそのまま使う
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handoff(encounterIds, { again }) {
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      const payload = await api("/v1/eye/billing/handoffs", { method: "POST", body: { date, encounterIds } });
      const name = `eye-billing-${date}-${payload.handoff.handoffId.slice(-6)}.csv`;
      download(payload.csv, name);
      setLastRun({ csv: payload.csv, name });
      const count = payload.handoff.encounters.length;
      setNotice({ text: again ? "再連携しました。レセコン側の前回分を直してから、この CSV を取り込んでください。" : `${count}人を連携済みにしました。`, file: name });
      if (again) setOpen(new Set());
      await load({ reselect: !again });
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadAll() {
    setConfirmAll(false);
    setBusy(true);
    setError("");
    try {
      const response = await transfer(`v1/eye/billing/day.csv?date=${date}`);
      download(await response.arrayBuffer(), `eye-billing-${date}-all.csv`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadRun(run) {
    setError("");
    try {
      const response = await transfer(`v1/eye/billing/handoffs/${run.handoffId}.csv`);
      download(await response.arrayBuffer(), `eye-billing-${run.date}-${run.handoffId.slice(-6)}.csv`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const toggleOpen = (id) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const toggleSelected = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const isToday = date === todayIso();
  const encounters = day?.encounters || [];
  const drafts = day?.drafts || [];
  const byFinalized = (left, right) => String(right.finalizedAt || "").localeCompare(String(left.finalizedAt || ""));
  const grouped = {
    changed: encounters.filter((item) => item.handoff.state === "changed").sort(byFinalized),
    pending: encounters.filter((item) => item.handoff.state === "pending").sort(byFinalized),
    // 修正中（連携済みのあとで医師が開いた）を先に、その後に新規の未確定
    drafts: [...drafts].sort((left, right) => Number(right.amending) - Number(left.amending) || String(left.updatedAt).localeCompare(String(right.updatedAt))),
    handed_off: encounters.filter((item) => item.handoff.state === "handed_off").sort(byFinalized)
  };
  const total = encounters.length + drafts.length;
  const selectedItems = grouped.pending.filter((item) => selected.has(item.encounterId));
  const latestRun = day?.handoffs?.[0];
  const printTargets = printIds ? encounters.filter((item) => printIds.includes(item.encounterId)) : [];
  const allPendingSelected = grouped.pending.length > 0 && selectedItems.length === grouped.pending.length;

  function renderPatient(patient) {
    return (
      <>
        <span className="bill-number mono">{patient?.primaryPatientNumber || "—"}</span>
        <span className="bill-name">
          <strong>{patient?.displayName}</strong>
          {patient?.displayNameKana ? <span className="flow-kana">{patient.displayNameKana}</span> : null}
        </span>
      </>
    );
  }

  // 年齢・性別、初再診、確定の時刻と医師
  function renderMeta(patient, encounterDate, visitType, finalized) {
    const age = ageOn(patient?.birthDate, encounterDate);
    const sex = patient?.sex && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] : "";
    return (
      <span className="bill-meta">
        <span className="bill-age">{age !== null ? `${age}${sex}` : sex}</span>
        <span className="bill-visit">
          {visitType === "initial" ? <span className="flow-new">初</span> : null}
          {VISIT_TYPE_LABELS[visitType] || ""}
        </span>
        {finalized?.at ? <span className="bill-final">{formatClock(finalized.at)}確定{finalized.by ? ` ${finalized.by}` : ""}</span> : null}
      </span>
    );
  }

  function renderRow(item, group) {
    const isOpen = open.has(item.encounterId);
    const summary = itemSummary(item.items) || "受診のみ";
    const rows = group === "changed" && item.handoff.previousItems ? diffItems(item.handoff.previousItems, item.items) : null;
    const chips = rows ? diffChips(rows) : [];
    const name = item.patient?.displayName || "";
    return (
      <li className={`bill-row-wrap${isOpen ? " is-open" : ""}`} key={item.encounterId}>
        <div className="bill-row">
          <button aria-expanded={isOpen} aria-label={`${name} の品目を${isOpen ? "閉じる" : "開く"}`} className="flow-row-open" onClick={() => toggleOpen(item.encounterId)} type="button" />
          <span className="bill-check">
            {group === "pending" ? (
              <label className="bill-check-hit">
                <input checked={selected.has(item.encounterId)} onChange={() => toggleSelected(item.encounterId)} type="checkbox" />
                <span className="sr-only">{name} を CSV 出力の対象にする</span>
              </label>
            ) : null}
          </span>
          {renderPatient(item.patient)}
          {renderMeta(item.patient, item.encounterDate, item.visitType, { at: item.finalizedAt, by: item.finalizedBy?.displayName })}
          <span className={`bill-summary${item.items.length ? "" : " is-empty"}`}>{summary}</span>
          <span className="bill-extra">
            {group === "changed" ? (
              item.handoff.previousItems ? (
                chips.length ? (
                  <>
                    {chips.slice(0, MAX_CHIPS).map((chip, index) => <span className={`bill-chip is-${chip.kind}`} key={index}>{chip.label}</span>)}
                    {chips.length > MAX_CHIPS ? <span className="bill-chip">ほか{chips.length - MAX_CHIPS}件</span> : null}
                  </>
                ) : <span className="muted">品目の並び・内容に違いなし</span>
              ) : <span className="bill-chip">前回の品目の記録なし</span>
            ) : item.diagnoses.length ? <span className="bill-dx-first">{diagnosisLabel(item.diagnoses[0])}{item.diagnoses.length > 1 ? ` ほか${item.diagnoses.length - 1}` : ""}</span> : null}
          </span>
          <span className="bill-version mono">{group === "changed" ? `v${item.handoff.version}→v${item.version}` : ""}</span>
          <span className="bill-actions">
            {group === "changed" ? (
              <button aria-expanded={isOpen} className={`btn btn-sm ${isOpen ? "btn-ghost" : "btn-primary"}`} onClick={() => toggleOpen(item.encounterId)} type="button">{isOpen ? "閉じる" : "差分を見る"}</button>
            ) : (
              <details className="more-menu">
                <summary aria-label={`${name} のその他の操作`} className="btn btn-chip">…</summary>
                <div className="more-menu-list">
                  <Link className="btn btn-ghost" href={`/encounters/${item.encounterId}`}>カルテを開く</Link>
                  <button className="btn btn-ghost" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPrintIds([item.encounterId]); }} type="button">この人の連絡票を印刷</button>
                </div>
              </details>
            )}
          </span>
        </div>
        {isOpen ? renderDetail(item, group, rows) : null}
      </li>
    );
  }

  function renderDetail(item, group, rows) {
    return (
      <div className="bill-detail">
        {item.diagnoses.length ? (
          <div className="bill-dx">
            <span className="bill-cat">病名</span>
            <span className="bill-dx-list">
              {item.diagnoses.map((dx, index) => <span key={index}>{diagnosisLabel(dx)}</span>)}
              <span className="muted small">（病名は CSV に入りません。レセコンで入力してください）</span>
            </span>
          </div>
        ) : null}
        {group === "changed" ? (
          <>
            <div className="bill-diff-head">
              <span>前回 v{item.handoff.version}（{formatDateTime(item.handoff.at)} {item.handoff.by?.displayName || ""} が連携）</span>
              <span>今回 v{item.version}（{item.finalizedAt ? `${formatDateTime(item.finalizedAt)} 確定` : ""}{item.finalizedBy?.displayName ? ` ${item.finalizedBy.displayName}` : ""}）{item.amendmentReason ? <> 修正理由: {item.amendmentReason}</> : null}</span>
            </div>
            {rows ? (
              <div className="bill-diff" role="table" aria-label="前回連携との差分">
                <div className="bill-diff-row bill-diff-labels" role="row">
                  <span role="columnheader">前回</span><span role="columnheader">今回</span><span role="columnheader">変更</span>
                </div>
                {rows.map((row, index) => (
                  <div className={`bill-diff-row is-${row.kind}`} key={index} role="row">
                    <span data-label="前回" role="cell">{row.previous ? <ItemLine item={row.previous} withCategory /> : null}</span>
                    <span data-label="今回" role="cell">{row.current ? <ItemLine item={row.current} withCategory /> : null}</span>
                    <span className="bill-diff-kind" role="cell">{{ same: "変更なし", changed: "~変更", added: "+追加", removed: "−削除" }[row.kind]}</span>
                  </div>
                ))}
                {rows.length === 0 ? <p className="muted small">前回も今回も品目はありません（受診のみ）。</p> : null}
              </div>
            ) : (
              <>
                <p className="bill-note">前回の品目は記録されていません（この機能の導入前の連携）。今回の品目だけを示します。</p>
                <ItemGroups items={item.items} />
              </>
            )}
            <p className="bill-warning">この CSV はこの患者の全品目を含みます。レセコン側で前回分（v{item.handoff.version}）を取り消すか直してから取り込んでください。</p>
            <div className="bill-detail-actions">
              <Link className="btn btn-ghost btn-sm" href={`/encounters/${item.encounterId}`}>カルテを開く</Link>
              <button className="btn btn-ghost btn-sm" onClick={() => setPrintIds([item.encounterId])} type="button">この人の連絡票を印刷</button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => handoff([item.encounterId], { again: true })} type="button">この人だけ CSV を出力して再連携</button>
            </div>
          </>
        ) : (
          <>
            <ItemGroups items={item.items} />
            <div className="bill-detail-actions">
              <span className="muted small">カルテ v{item.version}{group === "handed_off" && item.handoff.at ? ` ・ ${formatDateTime(item.handoff.at)} ${item.handoff.by?.displayName || ""} が連携` : ""}</span>
              <Link className="btn btn-ghost btn-sm" href={`/encounters/${item.encounterId}`}>カルテを開く</Link>
              <button className="btn btn-ghost btn-sm" onClick={() => setPrintIds([item.encounterId])} type="button">この人の連絡票を印刷</button>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderDraft(item) {
    const handed = item.handoff?.state === "handed_off";
    const name = item.patientSnapshot?.displayName || "";
    return (
      <li className="bill-row-wrap" key={item.encounterId}>
        <div className="bill-row is-draft">
          <span className="bill-check" />
          {renderPatient(item.patientSnapshot)}
          {renderMeta(item.patientSnapshot, item.encounterDate, item.visitType, null)}
          <span className="bill-draft-state">
            {item.amending ? (
              <>
                <strong>修正中</strong>
                {handed ? <span className="muted">（{formatClock(item.handoff.at)} 連携済み v{item.handoff.version}）</span> : null}
                {item.amendmentReason ? <span className="bill-reason" title={item.amendmentReason}>理由: {item.amendmentReason}</span> : null}
              </>
            ) : <span>未確定（診察中・確定待ち）</span>}
          </span>
          <span className="bill-actions">
            <Link aria-label={`${name} のカルテを開く`} className="btn btn-ghost btn-sm" href={`/encounters/${item.encounterId}`}>カルテを開く</Link>
          </span>
        </div>
      </li>
    );
  }

  const visibleGroups = filter ? [filter] : GROUPS.map((group) => group.key);

  return (
    <main className={`eye-page billing-page${selectedItems.length ? " has-selbar" : ""}`}>
      <div className="no-print">
        <header className="page-head bill-head">
          <div className="bill-title">
            <h1>会計連携</h1>
            <details className="bill-help">
              <summary aria-label="この画面について" className="btn btn-chip">?</summary>
              <p>確定済みカルテの「実施した検査・処置」「今回出した処方」「発行した文書」を、レセコンへ渡す CSV と会計連絡票にします。点数の計算はレセコンで行います。品目を直すときはカルテを修正してください。</p>
            </details>
          </div>
          <div className="head-actions">
            <div className="date-nav">
              <button aria-label="前日" className="btn btn-ghost" onClick={() => changeDate(addDays(date, -1))} type="button">‹</button>
              <input aria-label="日付" className="input input-date" onChange={(event) => changeDate(event.target.value || todayIso())} type="date" value={date} />
              <button aria-label="翌日" className="btn btn-ghost" onClick={() => changeDate(addDays(date, 1))} type="button">›</button>
              {!isToday ? <button className="btn btn-ghost" onClick={() => changeDate(todayIso())} type="button">今日</button> : null}
            </div>
            <details className="more-menu">
              <summary aria-label="会計連携のその他の操作" className="btn btn-ghost">…</summary>
              <div className="more-menu-list bill-menu">
                <button className="btn btn-ghost" disabled={!encounters.length} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPrintIds(encounters.map((item) => item.encounterId)); }} type="button">この日の全員の連絡票を印刷</button>
                <button className="btn btn-ghost" disabled={busy || !encounters.length} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConfirmAll(true); }} type="button">全件 CSV（確認用）…</button>
                <p className="bill-menu-note">全件 CSV は連携済みも含みます。レセコンへの取込には使わないでください。</p>
              </div>
            </details>
          </div>
        </header>
        {!isToday ? <p className="bill-date-note">{formatDate(date)} を表示しています（今日ではありません）。</p> : null}
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {notice ? (
          <p className="alert alert-ok bill-notice" role="status">
            {notice.text}
            {notice.file ? <span className="muted small"> CSV: {notice.file}</span> : null}
            {lastRun ? <button className="btn btn-ghost btn-sm" onClick={() => download(lastRun.csv, lastRun.name)} type="button">もう一度保存</button> : null}
            <button aria-label="通知を閉じる" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)} type="button">×</button>
          </p>
        ) : null}

        {!day ? <p className="loading">読み込み中…</p> : (
          <>
            <div className="bill-chips-row">
              <div aria-label="状態ごとの人数（押すとその状態だけを表示）" className="flow-chips" role="group">
                <button aria-pressed={filter === null} className="flow-chip flow-chip-all" onClick={() => setFilter(null)} type="button">
                  すべて<strong>{total}</strong>
                </button>
                {GROUPS.map((group) => (
                  <button aria-pressed={filter === group.key} className={`flow-chip bill-status-${group.key}`} key={group.key} onClick={() => setFilter(filter === group.key ? null : group.key)} type="button">
                    <span className="flow-dot" aria-hidden="true" />{group.label}<strong>{grouped[group.key].length}</strong>
                  </button>
                ))}
              </div>
              {latestRun ? <span className="muted small bill-last">最終連携 {formatClock(latestRun.createdAt)} {latestRun.createdBy?.displayName || ""}</span> : null}
            </div>

            {total === 0 ? (
              <div className="empty-state">
                <p><strong>この日のカルテはありません。</strong></p>
                <p className="muted small">医師がカルテを確定すると、実施した検査・処置、処方、文書がここに並び、レセコンへ渡す CSV と会計連絡票を作れます。</p>
              </div>
            ) : (
              <section aria-label="会計連携の一覧" className="panel flow-list bill-list">
                {visibleGroups.map((key) => {
                  const group = GROUPS.find((item) => item.key === key);
                  const items = grouped[key];
                  if (!items.length && !filter) return null;
                  const collapsed = key === "handed_off" && !showHandedOff && !filter;
                  return (
                    <section aria-label={group.label} className={`flow-group bill-group bill-status-${key}`} key={key}>
                      <h2 className="flow-group-head">
                        {key === "handed_off" ? (
                          <button aria-expanded={!collapsed} className="flow-group-toggle" onClick={() => setShowHandedOff(!showHandedOff)} type="button">{collapsed ? "▶" : "▼"} {group.label}</button>
                        ) : <span>{group.label}</span>}
                        <span className="count">{items.length}</span>
                        {key === "changed" && items.length ? <span className="bill-group-note">連携した後にカルテが修正されました。差分を見て、1人ずつ再連携してください。</span> : null}
                        {key === "pending" && items.length ? (
                          <label className="bill-select-all">
                            <input checked={allPendingSelected} onChange={() => setSelected(new Set(allPendingSelected ? [] : items.map((item) => item.encounterId)))} type="checkbox" />
                            {items.length}人すべて
                          </label>
                        ) : null}
                      </h2>
                      {collapsed ? null : items.length === 0 ? <p className="empty">該当する患者はいません。</p> : (
                        <ul className="flow-rows">{items.map((item) => (key === "drafts" ? renderDraft(item) : renderRow(item, key)))}</ul>
                      )}
                    </section>
                  );
                })}
              </section>
            )}

            {day.handoffs.length ? (
              <section className="panel bill-log">
                <h2>
                  <button aria-expanded={showLog} className="flow-group-toggle" onClick={() => setShowLog(!showLog)} type="button">{showLog ? "▼" : "▶"} 連携の記録</button>
                  <span className="count">{day.handoffs.length}回</span>
                </h2>
                {showLog ? (
                  <ul className="bill-log-list">
                    {day.handoffs.map((run) => (
                      <li key={run.handoffId}>
                        <span className="mono" title={`CSV の SHA-256: ${run.csvSha256}`}>{formatClock(run.createdAt)}</span>
                        <span>{run.createdBy?.displayName}</span>
                        <span className="bill-log-names">{run.encounters.map((entry) => entry.patient?.displayName || patientNameOf(day, entry.encounterId)).join("、")}（{run.encounters.length}人）</span>
                        {run.hasSnapshot ? <button className="btn btn-ghost btn-sm" onClick={() => downloadRun(run)} type="button">この回の CSV</button> : <span className="muted small">CSV の記録なし</span>}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}

        {selectedItems.length ? (
          <div className="bill-selbar" role="region" aria-label="選択した患者の操作">
            <span className="bill-selbar-count"><strong>{selectedItems.length}人</strong>を選択中<span className="muted">（{itemSummary(selectedItems.flatMap((item) => item.items)) || "受診のみ"}）</span></span>
            <button className="btn btn-ghost" onClick={() => setPrintIds(selectedItems.map((item) => item.encounterId))} type="button">連絡票を印刷</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => handoff(selectedItems.map((item) => item.encounterId), { again: false })} type="button">CSV を出力して連携済みにする</button>
          </div>
        ) : null}
      </div>

      {confirmAll ? (
        <div className="dialog-backdrop no-print" role="presentation">
          <div aria-labelledby="bill-all-heading" aria-modal="true" className="dialog" role="dialog">
            <h2 id="bill-all-heading">全件 CSV を保存しますか</h2>
            <p>{formatDate(date)} の確定済みカルテ {encounters.length}人分を、連携済みも含めて CSV にします。連携の状態は変わりません。</p>
            <p className="bill-warning">確認用です。レセコンへの取込には使わないでください（連携済みの患者が二重に登録されます）。</p>
            <div className="dialog-actions">
              <button autoFocus className="btn btn-ghost" onClick={() => setConfirmAll(false)} type="button">やめる</button>
              <button className="btn btn-primary" disabled={busy} onClick={downloadAll} type="button">確認用に保存する</button>
            </div>
          </div>
        </div>
      ) : null}

      {printTargets.length ? (
        <div className="print-only bill-slips">
          {printTargets.map((item) => <Slip date={date} facilityName={facilityName} item={item} key={item.encounterId} />)}
        </div>
      ) : null}
    </main>
  );
}

// 会計連絡票（1人1枚）
function Slip({ item, date, facilityName }) {
  const patient = item.patient || {};
  const age = ageOn(patient.birthDate, item.encounterDate);
  const chips = item.handoff.state === "changed" && item.handoff.previousItems ? diffChips(diffItems(item.handoff.previousItems, item.items)) : null;
  return (
    <article className="bill-slip">
      <header className="bill-slip-head">
        <div>
          <h2>会計連絡票</h2>
          {facilityName ? <p>{facilityName}</p> : null}
        </div>
        <div className="bill-slip-meta">
          <p>{formatDateJa(date)}</p>
          <p>{item.finalizedAt ? `確定 ${formatClock(item.finalizedAt)}` : ""}{item.finalizedBy?.displayName ? ` ${item.finalizedBy.displayName}` : ""}</p>
        </div>
      </header>
      <section className="bill-slip-patient">
        <p><span className="bill-slip-label">患者番号</span> <strong className="mono">{patient.primaryPatientNumber || "—"}</strong> <span>{patient.displayNameKana}</span></p>
        <p><strong className="bill-slip-name">{patient.displayName}</strong> {age !== null ? `${age}歳` : ""} {patient.sex && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] : ""} {VISIT_TYPE_LABELS[item.visitType] || ""} ・ カルテ v{item.version}</p>
      </section>
      <section className="bill-slip-body">
        <div className="bill-slip-line"><span className="bill-slip-label">病名</span><span>{item.diagnoses.length ? item.diagnoses.map(diagnosisLabel).join("、") : "なし"}</span></div>
        {item.items.length ? groupByCategory(item.items).map((group) => (
          <div className="bill-slip-line" key={group.category}>
            <span className="bill-slip-label">{group.category}</span>
            <span>{group.items.map((row, index) => <span className="bill-slip-item" key={index}><ItemLine item={row} /></span>)}</span>
          </div>
        )) : <div className="bill-slip-line"><span className="bill-slip-label">品目</span><span>なし（受診のみ）</span></div>}
      </section>
      <footer className="bill-slip-foot">
        {item.handoff.state === "changed" ? (
          <p><strong>前回連携（v{item.handoff.version}）からの変更:</strong> {chips ? (chips.length ? chips.map((chip) => chip.label).join(" ") : "品目の違いなし") : "前回の品目の記録なし"}</p>
        ) : null}
        <p>点数はレセコンで計算します。</p>
      </footer>
    </article>
  );
}

function ItemGroups({ items }) {
  if (!items.length) return <p className="bill-note">実施した検査・処置、処方、文書はありません（受診のみ）。</p>;
  return (
    <dl className="bill-items">
      {groupByCategory(items).map((group) => (
        <Fragment key={group.category}>
          <dt className="bill-cat">{group.category}</dt>
          <dd>
            <ul>{group.items.map((row, index) => <li key={index}><ItemLine item={row} /></li>)}</ul>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function ItemLine({ item, withCategory = false }) {
  const quantity = item.quantity !== null && item.quantity !== undefined && item.quantity !== "" ? `${item.quantity}${item.unit || ""}` : "";
  const details = [quantity, item.days ? `${item.days}日` : "", item.route, item.usage, item.note].filter(Boolean).join(" ");
  return (
    <span className="bill-item">
      {withCategory ? <span className="bill-item-cat">{item.category}</span> : null}
      <span className="bill-item-name">{item.name}</span>
      {EYE[item.eye] ? <span className={`bill-eye eye-${item.eye}`}>{EYE[item.eye]}</span> : null}
      {details ? <span className="bill-item-detail">{details}</span> : null}
    </span>
  );
}

function diagnosisLabel(dx) {
  const status = DIAGNOSIS_STATUS_LABELS[dx.status] ? `（${DIAGNOSIS_STATUS_LABELS[dx.status]}）` : "";
  return `${EYE[dx.eye] ? `${EYE[dx.eye]} ` : ""}${dx.name}${status}`;
}

function patientNameOf(day, encounterId) {
  const found = day.encounters.find((item) => item.encounterId === encounterId);
  if (found) return found.patient?.displayName || "";
  return day.drafts.find((item) => item.encounterId === encounterId)?.patientSnapshot?.displayName || "—";
}

function formatClock(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}

function formatDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateJa(iso) {
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${formatDate(iso)}（${weekday}）`;
}
