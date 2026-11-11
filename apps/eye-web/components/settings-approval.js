"use client";

import { useEffect, useState } from "react";
import { DEFAULT_REFERENCE_RANGES, EXAM_RANGE_ITEMS, VITAL_RANGE_ITEMS } from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { useClinicConfig } from "./settings-config";
import { SectionHead, SettingsDialog } from "./settings-master";
import { formatDateTime } from "../lib/format";

// 設定 › カルテの承認（指導医の承認）と、設定 › 基準値（バイタル・検査）。
// どちらも /v1/eye/clinic-config/<項目> を読み書きする。古い API（項目が無い）では「まだ使えません」と出す。

function Frame({ title, description, config, action = null, children }) {
  let body = children;
  if (config.unsupported) body = <p className="alert alert-info">この環境の API はまだこの項目に対応していません。更新後に使えます。</p>;
  else if (config.error) body = <p className="alert alert-danger" role="alert">{config.error}</p>;
  else if (!config.data) body = <p className="loading">読み込み中…</p>;
  return (
    <section aria-label={title} className="settings-section admin-section">
      <SectionHead action={config.data ? action : null} title={title}>{description}</SectionHead>
      {body}
      {config.data?.revision ? <p className="muted small admin-updated">最終更新 {formatDateTime(config.data.updatedAt)} {config.data.updatedBy?.displayName || ""}</p> : null}
    </section>
  );
}

function useFlash() {
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 3000);
    return () => clearTimeout(timer);
  }, [flash]);
  return [flash, setFlash];
}

// ---- カルテの承認 ----

export function ApprovalSettingsSection({ canEdit }) {
  const api = useEyeApi();
  const config = useClinicConfig("approval");
  const [flash, setFlash] = useFlash();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [staff, setStaff] = useState(null);
  const enabled = config.data?.value?.enabled === true;

  useEffect(() => {
    if (!canEdit) return undefined;
    let cancelled = false;
    api("/v1/eye/staff-profiles")
      .then((payload) => { if (!cancelled) setStaff(payload.staff || []); })
      .catch((nextError) => { if (!cancelled) setError(nextError.message); });
    return () => { cancelled = true; };
  }, [api, canEdit]);

  async function toggleEnabled(next) {
    setBusy("enabled");
    setError("");
    try {
      await config.save({ enabled: next });
      setFlash(next ? "カルテの承認を使う設定にしました。" : "カルテの承認を使わない設定にしました。");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy("");
    }
  }

  async function toggleFlag(member, key, value) {
    setBusy(`${member.memberId}-${key}`);
    setError("");
    try {
      const payload = await api(`/v1/eye/staff-profiles/${encodeURIComponent(member.memberId)}`, { method: "PUT", body: { [key]: value } });
      setStaff((current) => current.map((item) => (item.memberId === member.memberId ? { ...item, ...payload.staffProfile } : item)));
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy("");
    }
  }

  const doctors = (staff || []).filter((item) => item.eyeRoles.some((role) => role === "doctor" || role === "admin") && (!item.status || item.status === "active"));
  return (
    <Frame
      config={config}
      description="研修医などが確定したカルテを、指導医が承認する流れです。承認待ち・差し戻しでも会計へは送れます（一覧と紙に「未承認」と出ます）。"
      title="カルテの承認"
    >
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {config.data ? (
        <div className="panel facility-panel">
          <dl className="kv-table">
            <div className="kv-row">
              <dt>承認を使う</dt>
              <dd>
                {canEdit ? (
                  <label className="field-check">
                    <input checked={enabled} data-approval-setting="enabled" disabled={busy !== ""} onChange={(event) => toggleEnabled(event.target.checked)} type="checkbox" />
                    使う（「承認が必要」の職員が確定したカルテを承認待ちにする）
                  </label>
                ) : enabled ? "使う" : "使わない"}
              </dd>
            </div>
          </dl>
          <ul className="muted small approval-settings-note">
            <li>承認者（指導医）は［承認］か理由をつけて［差し戻し］をします。自分が確定したカルテは承認できません。</li>
            <li>承認したあとに直すと新しい版になり、もう一度承認を受けます。前の版と承認の記録は残ります。</li>
            <li>承認者が直して確定した版は、そのまま承認済みになります。</li>
          </ul>
        </div>
      ) : null}
      {canEdit ? (
        <div className="admin-list">
          <div className="admin-list-head"><h3>医師ごとの設定<span className="settings-head-count">{doctors.length}</span></h3></div>
          {!staff ? <p className="loading">読み込み中…</p> : doctors.length ? (
            <div className="admin-table-wrap">
              <table aria-label="承認者と承認が必要な医師" className="data-table admin-table">
                <thead><tr><th scope="col">利用者名</th><th scope="col">ログイン ID</th><th scope="col">承認者（指導医）</th><th scope="col">承認が必要（研修医など）</th></tr></thead>
                <tbody>
                  {doctors.map((member) => (
                    <tr key={member.memberId}>
                      <td><strong>{member.displayName}</strong></td>
                      <td className="mono">{member.loginId}</td>
                      <td>
                        <label className="field-check">
                          <input aria-label={`${member.displayName}を承認者にする`} checked={member.approver === true} data-staff-flag="approver" disabled={busy !== ""} onChange={(event) => toggleFlag(member, "approver", event.target.checked)} type="checkbox" />
                          承認者
                        </label>
                      </td>
                      <td>
                        <label className="field-check">
                          <input aria-label={`${member.displayName}のカルテに承認を必要にする`} checked={member.requiresApproval === true} data-staff-flag="requiresApproval" disabled={busy !== ""} onChange={(event) => toggleFlag(member, "requiresApproval", event.target.checked)} type="checkbox" />
                          承認が必要
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="empty master-empty">医師の役割を持つ職員がいません。</p>}
          {!enabled && doctors.some((item) => item.requiresApproval) ? <p className="muted small">「承認を使う」を入れるまで、承認待ちにはなりません。</p> : null}
        </div>
      ) : null}
    </Frame>
  );
}

// ---- 基準値（バイタル・検査） ----

const GROUPS = [
  ["vitals", "バイタル", VITAL_RANGE_ITEMS],
  ["exam", "検査（眼科）", EXAM_RANGE_ITEMS]
];

export function rangeText(entry, item = null) {
  if (!entry) return "—";
  // 小数視力は 1.0 の形で出す
  const show = (value) => (item?.unit === "小数" ? value.toFixed(1) : value);
  const low = Number.isFinite(entry.low) ? show(entry.low) : null;
  const high = Number.isFinite(entry.high) ? show(entry.high) : null;
  if (low !== null && high !== null) return `${low}〜${high}`;
  if (low !== null) return `${low} 以上`;
  if (high !== null) return `${high} 以下`;
  return "なし";
}

const sameRange = (left, right) => (left?.low ?? null) === (right?.low ?? null) && (left?.high ?? null) === (right?.high ?? null);

export function ReferenceRangesSection({ canEdit }) {
  const config = useClinicConfig("referenceRanges");
  const [flash, setFlash] = useFlash();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = config.data?.value;

  function startEdit() {
    setError("");
    setEditing(Object.fromEntries(GROUPS.map(([group, , items]) => [group, Object.fromEntries(items.map((item) => {
      const entry = value?.[group]?.[item.key] || {};
      return [item.key, { low: Number.isFinite(entry.low) ? String(entry.low) : "", high: Number.isFinite(entry.high) ? String(entry.high) : "" }];
    }))])));
  }

  function setBound(group, key, side, text) {
    setEditing((current) => ({ ...current, [group]: { ...current[group], [key]: { ...current[group][key], [side]: text } } }));
  }

  function resetRow(group, key) {
    const fallback = DEFAULT_REFERENCE_RANGES[group][key];
    setEditing((current) => ({ ...current, [group]: { ...current[group], [key]: { low: fallback.low === null ? "" : String(fallback.low), high: fallback.high === null ? "" : String(fallback.high) } } }));
  }

  async function submit() {
    const next = {};
    for (const [group, , items] of GROUPS) {
      next[group] = {};
      for (const item of items) {
        const entry = editing[group][item.key];
        const parse = (text) => (String(text).trim() === "" ? null : Number(String(text).trim().replace(/[０-９．－]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))));
        const low = parse(entry.low);
        const high = parse(entry.high);
        if ((low !== null && !Number.isFinite(low)) || (high !== null && !Number.isFinite(high))) { setError(`${item.label}は数字で入れてください。`); return; }
        if (low !== null && high !== null && low > high) { setError(`${item.label}の下限は上限以下にしてください。`); return; }
        next[group][item.key] = { low, high };
      }
    }
    setBusy(true);
    setError("");
    try {
      await config.save(next);
      setEditing(null);
      setFlash("基準値を保存しました。カルテ左の「バイタル」「検査」の色分けとグラフの線に使います。");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      action={canEdit ? <button className="btn btn-ghost" onClick={startEdit} type="button">✎ 編集</button> : null}
      config={config}
      description="カルテ左の「バイタル」「検査」で、基準値を外れた値の色分けとグラフの破線に使います（目安で、診断の基準ではありません）。空欄の側は線を引きません。"
      title="基準値（バイタル・検査）"
    >
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      {value ? GROUPS.map(([group, label, items]) => (
        <div className="admin-list ranges-group" key={group}>
          <div className="admin-list-head"><h3>{label}</h3></div>
          <div className="admin-table-wrap">
            <table aria-label={`${label}の基準値`} className="data-table admin-table ranges-table">
              <thead><tr><th scope="col">項目</th><th scope="col">単位</th><th className="ranges-num" scope="col">基準値</th><th className="ranges-num" scope="col">既定</th></tr></thead>
              <tbody>
                {items.map((item) => {
                  const entry = value[group]?.[item.key];
                  const changed = !sameRange(entry, DEFAULT_REFERENCE_RANGES[group][item.key]);
                  return (
                    <tr data-range-row={`${group}.${item.key}`} key={item.key}>
                      <th scope="row">{item.label}</th>
                      <td className="muted">{item.unit || "—"}</td>
                      <td className={`ranges-num${changed ? " ranges-changed" : ""}`}>{rangeText(entry, item)}{changed ? <span className="sr-only">（既定から変更）</span> : null}</td>
                      <td className="ranges-num ranges-default">{rangeText(DEFAULT_REFERENCE_RANGES[group][item.key], item)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )) : null}
      {editing ? (
        <SettingsDialog busy={busy} error={error} onClose={() => setEditing(null)} onSubmit={submit} title="基準値の編集" wide>
          {GROUPS.map(([group, label, items]) => (
            <div className="ranges-group" key={group}>
              <h3>{label}</h3>
              <div className="admin-table-wrap">
                <table className="data-table admin-table ranges-table">
                  <thead><tr><th scope="col">項目</th><th className="ranges-num" scope="col">下限</th><th className="ranges-num" scope="col">上限</th><th scope="col"><span className="sr-only">既定に戻す</span></th></tr></thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.key}>
                        <th scope="row">{item.label}{item.unit ? <span className="muted small">（{item.unit}）</span> : null}</th>
                        {["low", "high"].map((side) => (
                          <td className="ranges-num" key={side}>
                            <input
                              aria-label={`${item.label}の${side === "low" ? "下限" : "上限"}`}
                              className="input ranges-input"
                              data-range-input={`${group}.${item.key}.${side}`}
                              inputMode="decimal"
                              onChange={(event) => setBound(group, item.key, side, event.target.value)}
                              placeholder="なし"
                              value={editing[group][item.key][side]}
                            />
                          </td>
                        ))}
                        <td><button className="btn btn-ghost btn-sm" onClick={() => resetRow(group, item.key)} title={`既定（${rangeText(DEFAULT_REFERENCE_RANGES[group][item.key], item)}）に戻す`} type="button">既定</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </SettingsDialog>
      ) : null}
    </Frame>
  );
}
