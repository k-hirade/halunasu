"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useEyeApi, useEyeFileTransfer } from "./eye-api";
import { BILLING_TABS, billingRows, countByState, diffChips, diffItems, groupByCategory, itemSummary } from "../lib/billing-diff";
import { addDays, ageOn, APPOINTMENT_STATUS_LABELS, DIAGNOSIS_STATUS_LABELS, formatDate, SEX_LABELS, todayIso, VISIT_TYPE_LABELS } from "../lib/format";

const EYE = { od: "右", os: "左", ou: "両" };
const MAX_CHIPS = 3;

// 会計連携（デジカルの ORCA 連動版の会計と同じ流れ）。
// 確定したカルテを 1 人ずつ［連携］→ 確認 → レセコンへ渡す（今はレセコンが取り込む CSV を保存する）→ 受付が会計待なら会計済。
// 連携のあとでカルテを直すと「再計待」になり、前回との差分を見てからもう一度連携する。
// まとめての連携（選んだ人の CSV）・全件 CSV・連携の記録は補助として残す。品目はここでは直さない（カルテで直す）。
export function BillingWorkspace() {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  const [date, setDate] = useState(todayIso());
  const [day, setDay] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [facilityName, setFacilityName] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [tab, setTab] = useState(null);
  const [open, setOpen] = useState(new Set());
  const [showLog, setShowLog] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [sending, setSending] = useState(null); // 確認ダイアログを開いている行
  const [failures, setFailures] = useState({}); // encounterId → 連携に失敗した理由
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [printIds, setPrintIds] = useState(null);
  const requestRef = useRef(0);

  // 選んでいた人のうち、未連携のままの人だけを残す
  const load = useCallback(async () => {
    const ticket = ++requestRef.current;
    const [payload, reception] = await Promise.all([
      api(`/v1/eye/billing/day?date=${date}`),
      // 受付の状態・受付番号は一覧の補助。読めなくても会計連携はできる
      api(`/v1/eye/appointments?date=${date}`).catch(() => ({ appointments: [] }))
    ]);
    if (ticket !== requestRef.current) return;
    setDay(payload);
    setAppointments(reception.appointments || []);
    const pending = new Set(payload.encounters.filter((item) => item.handoff.state === "pending").map((item) => item.encounterId));
    setSelected((current) => new Set([...current].filter((id) => pending.has(id))));
  }, [api, date]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  // 日付を変えたら、前の日の一覧・通知・エラーは同じ描画で消す（別の日の「連携しました」を残さない）
  function changeDate(next) {
    if (next === date) return;
    setDate(next);
    setDay(null);
    setAppointments([]);
    setError("");
    setNotice(null);
    setLastRun(null);
    setOpen(new Set());
    setTab(null);
    setSelected(new Set());
    setFailures({});
    setSending(null);
  }

  useEffect(() => {
    api("/v1/eye/bootstrap")
      .then((payload) => {
        const facility = (payload.facilities || []).find((item) => item.status === "active") || payload.facilities?.[0];
        setFacilityName(facility?.legalName || facility?.displayName || "");
      })
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

  // 1 人分の連携（主な流れ）。受付が会計待なら API が会計済にする。
  async function send(row) {
    setBusy(true);
    setError("");
    setNotice(null);
    const name = row.patient?.displayName || "";
    const again = row.state === "changed";
    try {
      const payload = await api("/v1/eye/billing/send", {
        method: "POST",
        body: { date, encounterId: row.key, ...(row.appointment?.appointmentId ? { appointmentId: row.appointment.appointmentId } : {}) }
      });
      const file = `eye-billing-${date}-${payload.handoff.handoffId.slice(-6)}.csv`;
      download(payload.csv, file);
      setLastRun({ csv: payload.csv, name: file });
      const reception = payload.appointmentMoved
        ? "受付を会計済にしました。"
        : payload.appointmentError
          ? `受付の状態は変えていません（${payload.appointmentError.message}）。`
          : "";
      setNotice({
        text: `${name}さんを${again ? "再連携" : "連携"}しました。${reception}${again ? "レセコン側の前回分を取り消してから取り込んでください。" : ""}`,
        file
      });
      setFailures(({ [row.key]: _removed, ...rest }) => rest);
      setSending(null);
      setOpen((current) => {
        const next = new Set(current);
        next.delete(row.key);
        return next;
      });
      await load();
    } catch (nextError) {
      setFailures((current) => ({ ...current, [row.key]: nextError.message }));
      setError(`${name}さんの連携に失敗しました: ${nextError.message}`);
      setSending(null);
    } finally {
      setBusy(false);
    }
  }

  // 選んだ人をまとめて連携（補助）。受付の状態は変えない。
  async function handoffSelected(encounterIds) {
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      const payload = await api("/v1/eye/billing/handoffs", { method: "POST", body: { date, encounterIds } });
      const name = `eye-billing-${date}-${payload.handoff.handoffId.slice(-6)}.csv`;
      download(payload.csv, name);
      setLastRun({ csv: payload.csv, name });
      setNotice({ text: `${payload.handoff.encounters.length}人をまとめて連携しました。受付の状態は変えていません。`, file: name });
      setSelected(new Set());
      await load();
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

  const toggle = (setter) => (id) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleOpen = toggle(setOpen);
  const toggleSelected = toggle(setSelected);

  const isToday = date === todayIso();
  const rows = billingRows(day, appointments);
  const counts = countByState(rows);
  const shown = tab ? rows.filter((row) => row.state === tab) : rows;
  const encounters = day?.encounters || [];
  const pendingRows = rows.filter((row) => row.state === "pending");
  const selectedRows = pendingRows.filter((row) => selected.has(row.key));
  const allPendingSelected = pendingRows.length > 0 && selectedRows.length === pendingRows.length;
  const latestRun = day?.handoffs?.[0];
  const printTargets = printIds ? encounters.filter((item) => printIds.includes(item.encounterId)) : [];
  const closeMenu = (event) => event.currentTarget.closest("details")?.removeAttribute("open");

  function renderAction(row) {
    const name = row.patient?.displayName || "";
    if (row.state === "draft") {
      return <Link aria-label={`${name} のカルテを開く`} className="btn btn-ghost btn-sm" href={`/encounters/${row.key}`}>カルテ</Link>;
    }
    if (failures[row.key]) {
      return <button aria-label={`${name} の連携をやり直す`} className="btn btn-primary btn-sm" disabled={busy} onClick={() => setSending(row)} type="button">再試行</button>;
    }
    if (row.state === "pending") {
      return <button aria-label={`${name} を連携`} className="btn btn-primary btn-sm" disabled={busy} onClick={() => setSending(row)} type="button">連携</button>;
    }
    if (row.state === "changed") {
      return <button aria-label={`${name} を再連携`} className="btn btn-primary btn-sm" disabled={busy} onClick={() => setSending(row)} type="button">再連携</button>;
    }
    return (
      <details className="more-menu">
        <summary aria-label={`${name} のその他の操作`} className="btn btn-chip">…</summary>
        <div className="more-menu-list">
          <Link className="btn btn-ghost" href={`/encounters/${row.key}`}>カルテを開く</Link>
          <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setPrintIds([row.key]); }} type="button">この人の連絡票を印刷</button>
        </div>
      </details>
    );
  }

  function renderState(row) {
    if (failures[row.key]) return <span className="bill-state is-failed" title={failures[row.key]}>失敗</span>;
    if (row.state === "draft") return <span className="bill-state is-draft">{row.item.amending ? "修正中" : "未確定"}</span>;
    if (row.state === "handed_off") return <span className="bill-state is-handed_off">連携済<span className="bill-state-time">{formatClock(row.item.handoff.at)}</span></span>;
    if (row.state === "changed") return <span className="bill-state is-changed">再計待</span>;
    return <span className="bill-state is-pending">未連携</span>;
  }

  function renderExtra(row) {
    const { item } = row;
    if (row.state === "draft") {
      return (
        <span className="bill-extra-text">
          {item.amending ? (
            <>
              {item.handoff?.state === "handed_off" ? <span className="muted">{formatClock(item.handoff.at)} 連携済 v{item.handoff.version} のあと修正中</span> : <span>修正中</span>}
              {item.amendmentReason ? <span className="bill-reason" title={item.amendmentReason}>理由: {item.amendmentReason}</span> : null}
            </>
          ) : <span className="muted">診察中・確定待ち</span>}
        </span>
      );
    }
    if (row.state === "changed") {
      if (!item.handoff.previousItems) return <span className="bill-chip">前回の品目の記録なし</span>;
      const chips = diffChips(diffItems(item.handoff.previousItems, item.items));
      if (!chips.length) return <span className="muted">品目の違いなし</span>;
      return (
        <>
          {chips.slice(0, MAX_CHIPS).map((chip, index) => <span className={`bill-chip is-${chip.kind}`} key={index}>{chip.label}</span>)}
          {chips.length > MAX_CHIPS ? <span className="bill-chip">ほか{chips.length - MAX_CHIPS}件</span> : null}
        </>
      );
    }
    return <span className={`bill-summary${item.items.length ? "" : " is-empty"}`}>{itemSummary(item.items) || "受診のみ"}</span>;
  }

  function renderRow(row) {
    const { item, patient, appointment } = row;
    const isOpen = open.has(row.key);
    const name = patient?.displayName || "";
    const age = ageOn(patient?.birthDate, item.encounterDate);
    const sex = patient?.sex && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] : "";
    const reception = appointment ? APPOINTMENT_STATUS_LABELS[appointment.displayStatus || appointment.status] || "" : "";
    return (
      <li className={`bill-row-wrap${isOpen ? " is-open" : ""}`} data-state={failures[row.key] ? "failed" : row.state} key={row.key}>
        <div className={`bill-row is-${row.state}`}>
          {row.state !== "draft" ? (
            <button aria-expanded={isOpen} aria-label={`${name} の品目を${isOpen ? "閉じる" : "開く"}`} className="flow-row-open" onClick={() => toggleOpen(row.key)} type="button" />
          ) : null}
          <span className="bill-check">
            {row.state === "pending" ? (
              <label className="bill-check-hit">
                <input checked={selected.has(row.key)} onChange={() => toggleSelected(row.key)} type="checkbox" />
                <span className="sr-only">{name} をまとめて連携する対象にする</span>
              </label>
            ) : null}
          </span>
          <span className="bill-queue mono">
            {appointment?.queueNumber ? <strong>{appointment.queueNumber}</strong> : <span className="muted">—</span>}
            {appointment?.checkedInAt ? <span className="bill-queue-time">{formatClock(appointment.checkedInAt)}</span> : null}
          </span>
          <span className="bill-number mono">{patient?.primaryPatientNumber || "—"}</span>
          <span className="bill-name">
            <strong>{name}</strong>
            {patient?.displayNameKana ? <span className="flow-kana">{patient.displayNameKana}</span> : null}
          </span>
          <span className="bill-meta" data-number={patient?.primaryPatientNumber ? `No.${patient.primaryPatientNumber}` : ""}>
            <span className="bill-age">{age !== null ? `${age}${sex}` : sex}</span>
            <span className="bill-visit">{item.visitType === "initial" ? <span className="flow-new">初</span> : null}{VISIT_TYPE_LABELS[item.visitType] || ""}</span>
          </span>
          <span className="bill-reception">{reception ? <span className={`bill-reception-tag status-${appointment.displayStatus || appointment.status}`}>{reception}</span> : <span className="muted">受付なし</span>}</span>
          <span className="bill-final">
            {item.finalizedAt ? <>{formatClock(item.finalizedAt)}<span className="muted"> {item.finalizedBy?.displayName || ""}</span></> : <span className="muted">—</span>}
            {row.state === "changed" ? <span className="bill-version mono">v{item.handoff.version}→v{item.version}</span> : null}
          </span>
          <span className="bill-extra">{renderExtra(row)}</span>
          <span className="bill-state-cell">{renderState(row)}</span>
          <span className="bill-actions">{renderAction(row)}</span>
        </div>
        {isOpen && row.state !== "draft" ? renderDetail(row) : null}
      </li>
    );
  }

  function renderDetail(row) {
    const { item } = row;
    const diff = row.state === "changed" && item.handoff.previousItems ? diffItems(item.handoff.previousItems, item.items) : null;
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
        {row.state === "changed" ? (
          <>
            <div className="bill-diff-head">
              <span>前回 v{item.handoff.version}（{formatDateTime(item.handoff.at)} {item.handoff.by?.displayName || ""} が連携）</span>
              <span>今回 v{item.version}（{item.finalizedAt ? `${formatDateTime(item.finalizedAt)} 確定` : ""}{item.finalizedBy?.displayName ? ` ${item.finalizedBy.displayName}` : ""}）{item.amendmentReason ? <> 修正理由: {item.amendmentReason}</> : null}</span>
            </div>
            {diff ? <DiffTable rows={diff} /> : (
              <>
                <p className="bill-note">前回の品目は記録されていません（この機能の導入前の連携）。今回の品目だけを示します。</p>
                <ItemGroups items={item.items} />
              </>
            )}
            <p className="bill-warning">連携する CSV はこの患者の全品目を含みます。レセコン側で前回分（v{item.handoff.version}）を取り消すか直してから取り込んでください。</p>
          </>
        ) : <ItemGroups items={item.items} />}
        {failures[row.key] ? <p className="alert alert-danger" role="alert">連携に失敗しました: {failures[row.key]}</p> : null}
        <div className="bill-detail-actions">
          <span className="muted small">カルテ v{item.version}{row.state === "handed_off" && item.handoff.at ? ` ・ ${formatDateTime(item.handoff.at)} ${item.handoff.by?.displayName || ""} が連携` : ""}</span>
          <Link className="btn btn-ghost btn-sm" href={`/encounters/${row.key}`}>カルテを開く</Link>
          <button className="btn btn-ghost btn-sm" onClick={() => setPrintIds([row.key])} type="button">この人の連絡票を印刷</button>
          {row.state === "pending" || row.state === "changed" ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setSending(row)} type="button">{row.state === "changed" ? "この人を再連携" : "この人を連携"}</button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <main className={`eye-page billing-page${selectedRows.length ? " has-selbar" : ""}`}>
      <div className="no-print">
        <header className="page-head bill-head">
          <div className="bill-title">
            <h1>会計連携</h1>
            <details className="bill-help">
              <summary aria-label="この画面について" className="btn btn-chip">?</summary>
              <p>確定したカルテの「実施した検査・処置」「今回出した処方」「発行した文書」を、1 人ずつレセコンへ渡します（今はレセコンが取り込む CSV を保存します）。受付が会計待なら会計済にします。連携のあとでカルテを直すと「再計待」になるので、差分を見てからもう一度連携してください。点数の計算はレセコンで行います。</p>
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
                <button className="btn btn-ghost" disabled={!encounters.length} onClick={(event) => { closeMenu(event); setPrintIds(encounters.map((item) => item.encounterId)); }} type="button">この日の全員の連絡票を印刷</button>
                <button className="btn btn-ghost" disabled={!pendingRows.length} onClick={(event) => { closeMenu(event); setTab("pending"); setSelected(new Set(pendingRows.map((row) => row.key))); }} type="button">未連携の全員を選んでまとめて連携…</button>
                <button className="btn btn-ghost" disabled={busy || !encounters.length} onClick={(event) => { closeMenu(event); setConfirmAll(true); }} type="button">全件 CSV（確認用）…</button>
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
              <div aria-label="会計の状態で絞り込む" className="flow-chips" role="group">
                <button aria-pressed={tab === null} className="flow-chip flow-chip-all" onClick={() => setTab(null)} type="button">すべて<strong>{counts.all}</strong></button>
                {BILLING_TABS.map((item) => (
                  <button aria-pressed={tab === item.key} className={`flow-chip bill-tab-${item.key}`} key={item.key} onClick={() => setTab(tab === item.key ? null : item.key)} type="button">
                    {item.label}<strong>{counts[item.key]}</strong>
                  </button>
                ))}
              </div>
              <span className="muted small bill-last">
                連携先: レセコン（CSV 取込）{latestRun ? ` ・ 最終連携 ${formatClock(latestRun.createdAt)} ${latestRun.createdBy?.displayName || ""}` : ""}
              </span>
            </div>
            {counts.changed ? <p className="bill-rebill-note" role="note">再計待 {counts.changed}人: 連携のあとでカルテが修正されました。行を開いて差分を確かめ、［再連携］してください。</p> : null}

            {rows.length === 0 ? (
              <div className="empty-state">
                <p><strong>この日のカルテはありません。</strong></p>
                <p className="muted small">医師がカルテを確定すると、ここに 1 人ずつ並び、［連携］でレセコンへ渡せます。</p>
              </div>
            ) : (
              <section aria-label="会計連携の一覧" className="panel bill-list">
                <div className="bill-row bill-head-row">
                  <span className="bill-check">
                    {pendingRows.length && (tab === null || tab === "pending") ? (
                      <label className="bill-check-hit" title="未連携の全員を選ぶ">
                        <input aria-label="未連携の全員を選ぶ" checked={allPendingSelected} onChange={() => setSelected(new Set(allPendingSelected ? [] : pendingRows.map((row) => row.key)))} type="checkbox" />
                      </label>
                    ) : null}
                  </span>
                  <span aria-hidden="true" className="bill-queue">受付</span>
                  <span aria-hidden="true" className="bill-number">患者番号</span>
                  <span aria-hidden="true" className="bill-name">氏名</span>
                  <span aria-hidden="true" className="bill-meta">年齢・初再</span>
                  <span aria-hidden="true" className="bill-reception">受付状態</span>
                  <span aria-hidden="true" className="bill-final">確定</span>
                  <span aria-hidden="true" className="bill-extra">品目・変更</span>
                  <span aria-hidden="true" className="bill-state-cell">会計</span>
                  <span aria-hidden="true" className="bill-actions">操作</span>
                </div>
                {shown.length ? <ul className="flow-rows bill-rows">{shown.map(renderRow)}</ul> : <p className="empty">該当する患者はいません。</p>}
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

        {selectedRows.length ? (
          <div className="bill-selbar" role="region" aria-label="選択した患者の操作">
            <span className="bill-selbar-count"><strong>{selectedRows.length}人</strong>を選択中<span className="muted">（{itemSummary(selectedRows.flatMap((row) => row.item.items)) || "受診のみ"}）</span></span>
            <button className="btn btn-ghost" onClick={() => setSelected(new Set())} type="button">選択を解除</button>
            <button className="btn btn-ghost" onClick={() => setPrintIds(selectedRows.map((row) => row.key))} type="button">連絡票を印刷</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => handoffSelected(selectedRows.map((row) => row.key))} type="button">まとめて連携（CSV）</button>
          </div>
        ) : null}
      </div>

      {sending ? <SendDialog busy={busy} onCancel={() => setSending(null)} onConfirm={() => send(sending)} row={sending} /> : null}

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

// 連携の確認（デジカルの「送信しますか？」にあたる 2 択）。誰の・何を渡すかと、受付がどうなるかを見せる。
function SendDialog({ row, busy, onCancel, onConfirm }) {
  const { item, patient, appointment } = row;
  const again = row.state === "changed";
  const chips = again && item.handoff.previousItems ? diffChips(diffItems(item.handoff.previousItems, item.items)) : null;
  const toDone = appointment?.status === "checkout";
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);
  return (
    <div className="dialog-backdrop no-print" role="presentation">
      <div aria-describedby="bill-send-who" aria-labelledby="bill-send-heading" aria-modal="true" className="dialog bill-send-dialog" role="dialog">
        <h2 id="bill-send-heading">{again ? "会計情報をもう一度レセコンへ渡しますか？" : "会計情報をレセコンへ渡しますか？"}</h2>
        <p className="bill-send-who" id="bill-send-who">
          <strong>{patient?.displayName}</strong>
          <span className="mono">{patient?.primaryPatientNumber || ""}</span>
          <span>{VISIT_TYPE_LABELS[item.visitType] || ""}</span>
          <span className="muted">カルテ v{item.version}</span>
        </p>
        <div className="bill-send-items">
          <ItemGroups items={item.items} />
        </div>
        {again ? (
          <p className="bill-warning">
            前回（v{item.handoff.version}）からの変更: {chips ? (chips.length ? chips.map((chip) => chip.label).join(" ") : "品目の違いなし") : "前回の品目の記録なし"}。
            レセコン側で前回分を取り消してから取り込んでください。
          </p>
        ) : null}
        <p className="muted small">
          レセコンが取り込む CSV を保存します。
          {toDone ? "受付を「会計済」にします。" : appointment ? `受付の状態（${APPOINTMENT_STATUS_LABELS[appointment.displayStatus || appointment.status] || ""}）は変えません。` : "この日の受付はありません。"}
        </p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">やめる</button>
          <button autoFocus className="btn btn-primary" disabled={busy} onClick={onConfirm} type="button">{busy ? "連携中…" : again ? "再連携する" : "連携する"}</button>
        </div>
      </div>
    </div>
  );
}

function DiffTable({ rows }) {
  return (
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
  const status = dx.suspected ? "（疑い）" : DIAGNOSIS_STATUS_LABELS[dx.status] ? `（${DIAGNOSIS_STATUS_LABELS[dx.status]}）` : "";
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
