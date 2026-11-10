"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COVER_DIRECTION_LABELS,
  COVER_KIND_LABELS,
  IOL_CL_LABELS,
  NINE_GAZE_DIRECTION_LABELS,
  TEST_DISTANCE_LABELS,
  WORTH_PATTERN_LABELS
} from "@halunasu/eye-contracts";
import { SaveIndicator } from "./encounter-dialogs";
import { DilationFlags, hasExamValues, Orders } from "./encounter-sections";
import { VaDatalist } from "./exam-inputs";
import { copyDeviceValues, DevicePanels, EXAM_TABS, ExamTabBody, tabHasValues, useScrollEdge, writeValue } from "./exam-regdata";
import { PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";
import { useMeasuredHeight } from "./use-measured-height";
import { useMediaQuery } from "./use-media-query";
import { ensureEncounterFor, nextExamPatient } from "../lib/consult-flow";
import {
  collectDeviceReadings,
  hasAnyValue,
  isoFromClock,
  nowClock,
  recordClock,
  recordLabel,
  sameValues,
  sortRecords
} from "../lib/exam-record";
import { EYE_LABELS, EYE_SHORT, formatDate, IOP_METHOD_LABELS, VA_CORRECTION_TYPE_LABELS } from "../lib/format";

const SIDES = ["od", "os"];
const HANDOFF_CHIPS = ["眼鏡持参なし", "CL装用中", "固視不良", "測定困難", "再検希望"];
// 検査員がこの画面から「診察待ち」に進めてよい受付の状態。
const FINISHABLE = new Set(["in_exam", "checked_in"]);

// 検査入力（トプコン IMAGEnet eカルテの検査入力 RegData に倣う）。
// 上から 患者 / 検査日・時刻・検者・[登録]（記録の切り替え）/ 大タブ / 小タブ / 本文。下に「確定系 … キャンセル … 保存して戻る … 保存して次へ」。
// 値は「時刻つきの検査記録」1 件ごとに登録する（1 日に何回でも）。カルテの検査値（最新値）は記録から自動で作られる。
export function ExamWorkbench({ encounterId }) {
  const router = useRouter();
  const {
    api, detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, conflict,
    load, save, update, confirmExam, revisionRef, applyServerEncounter
  } = useEncounterDraft(encounterId);
  const coarse = useMediaQuery("(pointer: coarse)", false);
  // 下の固定バーの高さ（段数で変わる）を本文の下の余白に使う
  const examBarRef = useMeasuredHeight("--exam-bar-h");
  // スマホでは大タブが 1 行の横スクロールになる。続きがあることを右端の影で知らせる
  const tabsRef = useScrollEdge();
  const [now, setNow] = useState(Date.now());
  const [matches, setMatches] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [tab, setTab] = useState("vision");
  const [subtabs, setSubtabs] = useState({});
  // 選んでいる記録（"" は新しい記録、undefined はまだ決めていない）と、入力中の内容・登録済みの内容
  const [selectedId, setSelectedId] = useState(undefined);
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [showData, setShowData] = useState(false);

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  const patientId = encounter?.patientId;
  const encounterDate = meta.encounterDate;
  const canReceive = Boolean(context?.canReceive);
  const records = useMemo(() => sortRecords(content?.examRecords || []), [content?.examRecords]);
  const serverRecord = selectedId ? records.find((record) => record.recordId === selectedId) || null : null;
  const dirty = Boolean(form && baseline && !sameForm(form, baseline));

  const newForm = useCallback(() => ({ values: {}, clock: nowClock(), examinerName: context?.displayName || "", note: "" }), [context?.displayName]);

  // 最初に開いたときは最後の記録を選ぶ（なければ新しい記録）
  useEffect(() => {
    if (!content || !context || selectedId !== undefined) return;
    const last = records.at(-1);
    const next = last ? formFromRecord(last) : newForm();
    setSelectedId(last ? last.recordId : "");
    setForm(next);
    setBaseline(next);
  }, [content, context, newForm, records, selectedId]);

  // ほかの端末で同じ記録が変わったら、入力中でなければ取り込む
  useEffect(() => {
    if (!serverRecord || dirty) return;
    const next = formFromRecord(serverRecord);
    if (!baseline || !sameForm(next, baseline)) {
      setForm(next);
      setBaseline(next);
    }
  }, [serverRecord]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // 同じ日・同じ患者で「受付中」「検査中」の受付を探す。ちょうど 1 件のときだけ状態を進める（誤った受付を動かさない）。
  const findMatches = useCallback(async () => {
    const payload = await api(`/v1/eye/appointments?date=${encounterDate}`);
    return (payload.appointments || []).filter((item) => item.patientId === patientId && FINISHABLE.has(item.status));
  }, [api, encounterDate, patientId]);

  useEffect(() => {
    if (!patientId || !encounterDate || !canReceive || encounter?.status !== "draft") return;
    let cancelled = false;
    findMatches().then((list) => { if (!cancelled) setMatches(list); }).catch(() => { if (!cancelled) setMatches([]); });
    return () => { cancelled = true; };
  }, [canReceive, encounter?.status, encounterDate, findMatches, patientId]);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content || !form) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const previous = detail.previous;
  const confirmations = encounter.examConfirmations || { od: null, os: null };
  const flags = content.flags || {};
  const missing = SIDES.filter((side) => !hasExamValues(content.exam[side]));
  const willMove = canReceive && matches?.length === 1;
  const dilationMinutes = flags.dilationStartedAt ? Math.max(0, Math.floor((now - Date.parse(flags.dilationStartedAt)) / 60000)) : null;
  const touch = coarse;
  const activeTab = EXAM_TABS.find((item) => item.key === tab) || EXAM_TABS[0];
  const activeSubtab = activeTab.subtabs ? subtabs[activeTab.key] || activeTab.subtabs[0][0] : "";
  const canRegister = editable && dirty && (selectedId || hasAnyValue(form.values));
  const oldExamOnly = !records.length && SIDES.some((side) => hasExamValues(content.exam[side]));

  const set = (path, value) => setForm((current) => ({ ...current, values: path.length ? writeValue(current.values, path, value) : value || {} }));

  // 入力中の記録を登録する（新しい記録は追加、選んだ記録は変更）。変更がなければ何もしない。
  // 戻り値: 失敗は false。登録したときはサーバーの最新のカルテ、何もしなかったときは true。
  async function register() {
    if (!editable || !dirty) return true;
    if (!selectedId && !hasAnyValue(form.values)) return true;
    const at = isoFromClock(encounterDate, form.clock);
    if (!at) {
      setMessage({ kind: "danger", text: "検査時刻を「時:分」で入れてください。" });
      return false;
    }
    setBusy("register");
    try {
      const self = form.examinerName && form.examinerName === context?.displayName;
      const body = {
        expectedRevision: revisionRef.current,
        at,
        examinerName: form.examinerName,
        ...(self ? { examinerMemberId: context.memberId } : {}),
        note: form.note,
        values: form.values
      };
      const payload = selectedId
        ? await api(`/v1/eye/encounters/${encounterId}/exam-records/${selectedId}`, { method: "PATCH", body })
        : await api(`/v1/eye/encounters/${encounterId}/exam-records`, { method: "POST", body });
      applyServerEncounter(payload.encounter);
      const saved = formFromRecord(payload.record);
      setSelectedId(payload.record.recordId);
      setForm(saved);
      setBaseline(saved);
      setMessage({ kind: "ok", text: `${recordLabel(payload.record)} の検査記録を登録しました。` });
      return payload.encounter;
    } catch (nextError) {
      setMessage({
        kind: "danger",
        text: nextError.status === 409 ? "ほかの端末で検査値が更新されました。「最新を読み込む」で読み直してから、もう一度入力してください。" : nextError.message,
        reload: nextError.status === 409
      });
      return false;
    } finally {
      setBusy("");
    }
  }

  function chooseRecord(recordId) {
    if (recordId === selectedId) return;
    if (dirty && !window.confirm("登録していない入力があります。破棄して切り替えますか？")) return;
    const record = records.find((item) => item.recordId === recordId);
    const next = record ? formFromRecord(record) : newForm();
    setSelectedId(record ? record.recordId : "");
    setForm(next);
    setBaseline(next);
    setMessage(null);
  }

  function cancelEdit() {
    if (!dirty) return;
    setForm(baseline);
    setMessage({ kind: "ok", text: "入力を登録前の内容に戻しました。" });
  }

  // 記録とカルテの未保存分（本日の検査・散瞳・申し送り）をまとめて保存する
  // 戻り値: 失敗は null、成功は最新のカルテ（記録を登録しなかったときは今のカルテ）
  async function saveAll() {
    const registered = await register();
    if (!registered) return null;
    if (!(await save())) return null;
    return registered === true ? encounter : registered;
  }

  async function finish() {
    setBusy("finish");
    setMessage(null);
    try {
      const latest = await saveAll();
      if (!latest) return;
      // 登録したばかりの値で判断する（画面の content はまだ前の値のことがある）
      const latestConfirmations = latest.examConfirmations || { od: null, os: null };
      const pending = SIDES.filter((side) => hasExamValues(latest.content.exam[side]) && !latestConfirmations[side]);
      if (pending.length === 2) {
        if (!(await confirmExam("both", true))) return;
      } else {
        for (const side of pending) {
          if (!(await confirmExam(side, true))) return;
        }
      }
      if (!canReceive) {
        setMessage({ kind: "ok", text: "検査値を確認済みにしました。受付の状態は受付で進めてください。" });
        return;
      }
      let list;
      try {
        list = await findMatches();
      } catch (nextError) {
        setMessage({ kind: "warn", text: `検査値を確認済みにしました。受付の状態は変えていません（${nextError.message}）。` });
        return;
      }
      setMatches(list);
      if (list.length !== 1) {
        setMessage({
          kind: "warn",
          text: list.length
            ? "検査値を確認済みにしました。この患者の本日の受付が2件以上あるため、受付の状態は変えていません。受付画面で進めてください。"
            : "検査値を確認済みにしました。検査中の受付が見つからないため、受付の状態は変えていません。"
        });
        return;
      }
      await api(`/v1/eye/appointments/${list[0].appointmentId}/status`, {
        method: "POST",
        body: { expectedRevision: list[0].revision, status: "waiting_doctor" }
      });
      router.push("/reception");
    } catch (nextError) {
      setMessage({ kind: "danger", text: nextError.message });
    } finally {
      setBusy("");
    }
  }

  async function saveAndBack() {
    setBusy("back");
    try {
      if (!(await saveAll())) return;
      if (window.history.length > 1) router.back();
      else router.push("/");
    } finally {
      setBusy("");
    }
  }

  // 保存して、次に検査する患者（受付中・検査中で早い順）の検査入力へ
  async function saveAndNext() {
    setBusy("next");
    try {
      if (!(await saveAll())) return;
      const payload = await api(`/v1/eye/appointments?date=${encounterDate}`);
      const next = nextExamPatient(payload.appointments || [], patientId);
      if (!next) {
        setMessage({ kind: "ok", text: "保存しました。次に検査する患者はいません。" });
        return;
      }
      const nextEncounterId = await ensureEncounterFor(api, next, payload.encountersByPatient || {});
      router.push(`/encounters/${nextEncounterId}/exam`);
    } catch (nextError) {
      setMessage({ kind: "danger", text: nextError.message });
    } finally {
      setBusy("");
    }
  }

  function appendHandoff(text) {
    const current = content.staffNote || "";
    update(["staffNote"], current ? `${current}${current.endsWith("\n") ? "" : "\n"}${text}` : text);
  }

  const closeMenu = (event) => { event.currentTarget.closest("details")?.removeAttribute("open"); };
  const phrases = (bootstrap.phrases || []).filter((item) => item.active !== false && item.target === "staffNote");
  const eyeState = (side) => (confirmations[side] ? "確認済" : hasExamValues(content.exam[side]) ? "未確認" : "未入力");
  const devicePanels = (
    <DevicePanels
      disabled={!editable}
      onCopy={(kind, data) => setForm((current) => ({ ...current, values: copyDeviceValues(current.values, kind, data) }))}
      readings={collectDeviceReadings(records)}
    />
  );

  return (
    <main className="eye-page exam-workbench exam-page rd-page">
      <VaDatalist />
      <div className="encounter-bar is-static exam-banner">
        <PatientBanner
          actions={<Link className="btn btn-ghost btn-sm" href={`/encounters/${encounterId}`}>カルテ全体</Link>}
          compact
          context={context}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={encounter.patientSnapshot}
          profile={detail.profile}
        />
      </div>
      {error ? (
        <p className="alert alert-danger" role="alert">
          {error}
          {conflict ? <> <button className="btn btn-chip" onClick={() => load({ force: true })} type="button">最新の内容を読み込む</button></> : null}
        </p>
      ) : null}
      {encounter.status !== "draft" ? <p className="alert alert-info">このカルテは確定済みのため、検査値は変更できません。</p> : null}

      <h1 className="sr-only">検査入力</h1>
      <fieldset className="rd-record-row" disabled={!editable}>
        <legend className="sr-only">検査日・時刻・検者</legend>
        <span className="rd-record-field">
          <span className="rd-record-label">検査日</span>
          <strong className="mono">{formatDate(encounterDate)}</strong>
        </span>
        <label className="rd-record-field">
          <span className="rd-record-label">検査時刻</span>
          <input aria-label="検査時刻" className="input input-time" onChange={(event) => setForm({ ...form, clock: event.target.value })} type="time" value={form.clock} />
        </label>
        <label className="rd-record-field">
          <span className="rd-record-label">検者</span>
          <input aria-label="検者" className="input rd-examiner" maxLength={100} onChange={(event) => setForm({ ...form, examinerName: event.target.value })} title={form.examinerName || undefined} value={form.examinerName} />
        </label>
        <button className="btn btn-primary rd-register" disabled={!canRegister || busy !== ""} onClick={register} title={selectedId ? "選んでいる記録を更新します" : "この時刻の記録を1件追加します"} type="button">
          {busy === "register" ? "登録中…" : "登録"}
        </button>
        {dirty ? <span className="rd-dirty" role="status">未登録の入力があります</span> : null}
      </fieldset>
      <div className="rd-records" role="group" aria-label="本日の検査記録">
        <span className="rd-records-label">本日の記録 {records.length}件</span>
        {records.map((record) => (
          <button aria-pressed={record.recordId === selectedId} className="btn btn-chip btn-sm rd-record-chip" key={record.recordId} onClick={() => chooseRecord(record.recordId)} type="button">
            {recordLabel(record) || "時刻なし"}
          </button>
        ))}
        {editable ? (
          <button aria-pressed={selectedId === ""} className="btn btn-chip btn-sm rd-record-chip is-new" onClick={() => chooseRecord("")} type="button">＋ 新しい記録</button>
        ) : null}
        <span className="rd-records-spacer" />
        <button className="btn btn-ghost btn-sm" disabled={!records.length} onClick={() => setShowData(true)} type="button">データ表示</button>
        <Link className="btn btn-ghost btn-sm" href={`/patients/${patientId}?tab=va-iop`}>過去履歴</Link>
      </div>
      {oldExamOnly ? <p className="rd-notice">カルテ画面で入力された検査値があります。最初に登録するとき、その値は別の記録として残ります。</p> : null}
      {message ? (
        <p className={`exam-bar-message rd-message is-${message.kind}`} role="status">
          {message.text}
          {message.reload ? <> <button className="btn btn-chip btn-sm" onClick={() => load({ force: true }).then(() => { setSelectedId(undefined); setForm(null); setBaseline(null); setMessage(null); })} type="button">最新を読み込む</button></> : null}
        </p>
      ) : null}

      <div className="rd-layout">
        <section className="rd-main" aria-label="検査">
          <div className="rd-tabs-frame">
            <div aria-label="検査の種類" className="rd-tabs" ref={tabsRef} role="tablist">
              {EXAM_TABS.map((item) => (
                <button
                  aria-controls="rd-panel"
                  aria-selected={item.key === activeTab.key}
                  className={`rd-tab${tabHasValues(item.key, form.values) ? " has-values" : ""}`}
                  id={`rd-tab-${item.key}`}
                  key={item.key}
                  onClick={(event) => { setTab(item.key); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
                  role="tab"
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {activeTab.subtabs ? (
            <div aria-label={`${activeTab.label}の検査`} className="rd-subtabs" role="tablist">
              {activeTab.subtabs.map(([key, label]) => (
                <button aria-selected={key === activeSubtab} className="rd-subtab" key={key} onClick={() => setSubtabs({ ...subtabs, [activeTab.key]: key })} role="tab" type="button">{label}</button>
              ))}
            </div>
          ) : null}
          <fieldset aria-labelledby={`rd-tab-${activeTab.key}`} className="rd-panel" disabled={!editable} id="rd-panel" role="tabpanel">
            <h2 className="rd-panel-title">
              {activeTab.subtabs ? activeTab.subtabs.find(([key]) => key === activeSubtab)?.[1] : activeTab.label}
              {activeTab.provisional ? <span className="tag tag-warn rd-provisional-tag">仮</span> : null}
            </h2>
            <ExamTabBody
              devicePanels={devicePanels}
              previous={previous?.content?.exam}
              set={set}
              subtab={activeSubtab}
              tab={activeTab.key}
              touch={touch}
              values={form.values}
            />
            <label className="rd-wide-field rd-record-note">
              <span>記録のメモ</span>
              <input aria-label="記録のメモ" className="input" maxLength={200} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="例: 散瞳後、CL装用のまま" value={form.note} />
            </label>
          </fieldset>
        </section>
        <fieldset className="rd-side" disabled={!editable}>
          <section className="exam-block" id="sec-orders">
            <Orders catalog={bootstrap.orderCatalog} content={content} editable={editable} update={update} variant="checklist" />
          </section>
          <section className="exam-block" id="sec-dilation">
            <DilationFlags content={content} editable={editable} now={now} update={update} variant="panel" />
          </section>
          <section className="exam-block" id="sec-staff-note">
            <div className="mini-head"><h2>医師への申し送り</h2></div>
            <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={3} value={content.staffNote} />
            {editable ? (
              <div className="handoff-chips">
                {HANDOFF_CHIPS.map((text) => (
                  <button className="btn btn-chip" key={text} onClick={() => appendHandoff(text)} title="末尾に追記します" type="button">{text}</button>
                ))}
                {phrases.map((item) => (
                  <button className="btn btn-chip" key={item.phraseId} onClick={() => appendHandoff(item.text)} title={item.text} type="button">{item.label || item.text.slice(0, 12)}</button>
                ))}
              </div>
            ) : null}
          </section>
        </fieldset>
      </div>

      <div aria-label="検査の操作" className="exam-bar rd-bar" data-fixed-bar="bottom" ref={examBarRef} role="region">
        <div className="exam-bar-row">
          {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
          <span className="exam-bar-eyes">
            {SIDES.map((side) => (
              <span className={`exam-bar-eye is-${eyeState(side) === "確認済" ? "done" : eyeState(side) === "未確認" ? "pending" : "empty"}`} key={side}>
                <span className={`eye-${side}`}>{EYE_SHORT[side]}</span> {eyeState(side)}
              </span>
            ))}
          </span>
          {dilationMinutes !== null ? (
            <span className={`exam-bar-dilation${dilationMinutes >= 20 ? " is-ready" : ""}`}>散瞳 {dilationMinutes}分</span>
          ) : null}
          <span className="exam-bar-spacer" />
          {editable ? (
            <details className="more-menu is-up">
              <summary aria-label="その他の操作" className="btn btn-ghost">…</summary>
              <div className="more-menu-list">
                {SIDES.map((side) => (confirmations[side] ? (
                  <button className="btn btn-ghost" key={side} onClick={(event) => { closeMenu(event); confirmExam(side, false); }} type="button">{EYE_LABELS[side]}の確認を取り消す</button>
                ) : hasExamValues(content.exam[side]) ? (
                  <button className="btn btn-ghost" key={side} onClick={(event) => { closeMenu(event); confirmExam(side, true); }} type="button">{EYE_LABELS[side]}だけ確認する</button>
                ) : null))}
                <button aria-pressed={Boolean(flags.myopiaTreatment)} className="btn btn-ghost" onClick={(event) => { closeMenu(event); update(["flags"], { ...flags, myopiaTreatment: !flags.myopiaTreatment }); }} type="button">
                  近視治療中{flags.myopiaTreatment ? " ✓" : ""}
                </button>
              </div>
            </details>
          ) : null}
        </div>
        {editable ? (
          <div className="rd-bar-buttons">
            {missing.length && !dirty ? <span className="exam-bar-hint">{missing.length === 2 ? "検査値が未入力です" : `${EYE_LABELS[missing[0]]}は未入力です`}</span> : null}
            <button className="btn btn-primary rd-finish" disabled={busy !== ""} onClick={finish} title={willMove ? "登録・保存して値のある眼を確認済みにし、受付を「診察待ち」にします" : "登録・保存して値のある眼を確認済みにします（受付の状態は変えません）"} type="button">
              {busy === "finish" ? "処理中…" : willMove ? "検査終了 → 診察待ちへ" : "検査値を確認する"}
            </button>
            <span className="rd-bar-gap" />
            <button className="btn btn-ghost" disabled={!dirty || busy !== ""} onClick={cancelEdit} type="button">キャンセル</button>
            <button className="btn btn-ghost" disabled={busy !== ""} onClick={saveAndBack} type="button">{busy === "back" ? "保存中…" : "保存して戻る"}</button>
            <button className="btn btn-ghost rd-next" disabled={busy !== ""} onClick={saveAndNext} title="保存して、次に検査する患者（受付中・検査中で早い順）を開きます" type="button">{busy === "next" ? "保存中…" : "保存して次へ"}</button>
          </div>
        ) : (
          <div className="rd-bar-buttons">
            <Link className="btn btn-ghost" href={`/encounters/${encounterId}`}>カルテ全体を開く</Link>
          </div>
        )}
      </div>
      {showData ? <RecordsDialog onClose={() => setShowData(false)} records={records} /> : null}
    </main>
  );
}

function formFromRecord(record) {
  return { values: record.values || {}, clock: recordClock(record.at), examinerName: record.examinerName || "", note: record.note || "" };
}

function sameForm(left, right) {
  return left.clock === right.clock && left.examinerName === right.examinerName && left.note === right.note && sameValues(left.values, right.values);
}

// 本日の記録を検査ごとの見出しで並べた読み取り専用の表示（トプコンの「データ表示」）
function RecordsDialog({ records, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <section aria-label="本日の検査記録" aria-modal="true" className="dialog rd-data-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="dialog-head">
          <h2>本日の検査記録</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">閉じる</button>
        </div>
        <div className="rd-data-body">
          {records.map((record) => (
            <article className="rd-data-record" key={record.recordId}>
              <h3>{recordLabel(record) || "時刻なし"}{record.note ? <span className="muted small"> {record.note}</span> : null}</h3>
              {recordSummary(record.values).map(([heading, lines]) => (
                <div className="rd-data-block" key={heading}>
                  <h4>{heading}</h4>
                  {lines.map((line, index) => <p key={index}>{line}</p>)}
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

const SIDE_TEXT = { od: "R", os: "L", ou: "B" };

// 記録の値を検査ごとの行にする（データ表示・印刷向けの文）
export function recordSummary(values = {}) {
  const blocks = [];
  const vision = values.vision || {};
  const visionLines = [];
  for (const [distance, label] of [["far", "遠見"], ["near", "近見"]]) {
    for (const side of ["od", "os", "ou"]) {
      const row = vision[distance]?.[side];
      if (!hasAnyValue(row)) continue;
      const lens = [fmt(row.sphere, "S"), fmt(row.cylinder, "C"), Number.isFinite(row.axis) ? `A${row.axis}` : ""].filter(Boolean).join(" ");
      const corrected = row.corrected || lens ? `（${row.corrected || "—"}${lens ? ` × ${lens}` : ""}）` : "";
      const extras = [row.iolCl ? IOL_CL_LABELS[row.iolCl] : "", row.correctionType ? VA_CORRECTION_TYPE_LABELS[row.correctionType] : "", row.rg ? `RG ${row.rg}` : ""].filter(Boolean).join(" ");
      visionLines.push(`<${label}> ${SIDE_TEXT[side]}V=${row.uncorrected || "—"}${corrected}${extras ? ` ${extras}` : ""}`);
    }
  }
  if (vision.condition) visionLines.push(`条件: ${vision.condition}`);
  if (vision.comment) visionLines.push(vision.comment);
  if (Number.isFinite(values.pd?.far) || Number.isFinite(values.pd?.near)) visionLines.push(`PD 遠見 ${values.pd?.far ?? "—"} / 近見 ${values.pd?.near ?? "—"}`);
  if (visionLines.length) blocks.push(["視力", visionLines]);
  const iopLines = ["od", "os"].filter((side) => values.iop?.[side]?.readings?.length).map((side) => {
    const eye = values.iop[side];
    return `<${SIDE_TEXT[side]}> ${eye.readings.map((item) => item.value).join(" ")}  平均 ${eye.average ?? "—"}${eye.method ? ` ${IOP_METHOD_LABELS[eye.method]}` : ""}${eye.at ? ` ${eye.at}` : ""}`;
  });
  if (values.iop?.comment) iopLines.push(values.iop.comment);
  if (iopLines.length) blocks.push(["眼圧", iopLines]);
  const refraction = ["od", "os"].filter((side) => hasAnyValue(values.refraction?.[side])).map((side) => {
    const eye = values.refraction[side];
    return `<${SIDE_TEXT[side]}> ${[fmt(eye.sphere, "S"), fmt(eye.cylinder, "C"), Number.isFinite(eye.axis) ? `A${eye.axis}` : ""].filter(Boolean).join(" ")}`;
  });
  if (refraction.length) blocks.push(["屈折", refraction]);
  const kerato = ["od", "os"].filter((side) => hasAnyValue(values.keratometry?.[side])).map((side) => {
    const eye = values.keratometry[side];
    return `<${SIDE_TEXT[side]}> K1 ${eye.k1 ?? "—"} K2 ${eye.k2 ?? "—"} A ${eye.axis ?? "—"}`;
  });
  if (kerato.length) blocks.push(["角膜曲率", kerato]);
  const tests = values.tests || {};
  const gazeCells = Object.entries(tests.nineGaze?.cells || {}).filter(([, cell]) => hasAnyValue(cell));
  if (gazeCells.length) {
    const abnormal = gazeCells.filter(([, cell]) => cell.od !== "normal" || cell.os !== "normal");
    blocks.push(["9方向眼位", [
      abnormal.length ? abnormal.map(([direction, cell]) => `${NINE_GAZE_DIRECTION_LABELS[direction]} R ${gaze(cell.od)} L ${gaze(cell.os)}`).join(" / ") : `${gazeCells.length}方向 正常`,
      ...(tests.nineGaze.condition ? [`条件: ${tests.nineGaze.condition}`] : [])
    ]]);
  }
  if (hasAnyValue(tests.worth)) {
    blocks.push(["Worth 4灯", [[tests.worth.pattern ? WORTH_PATTERN_LABELS[tests.worth.pattern] : "", tests.worth.distance ? TEST_DISTANCE_LABELS[tests.worth.distance] : "", tests.worth.fixingEye ? `固視 ${EYE_LABELS[tests.worth.fixingEye]}` : ""].filter(Boolean).join(" ")]]);
  }
  const cover = Object.entries(tests.cover || {}).filter(([, row]) => hasAnyValue(row));
  if (cover.length) {
    blocks.push(["遮閉試験", cover.map(([distance, row]) => `${TEST_DISTANCE_LABELS[distance]} ${[row.kind ? COVER_KIND_LABELS[row.kind] : "", row.direction ? COVER_DIRECTION_LABELS[row.direction] : "", row.amount ? `${row.amount}Δ` : "", row.fixingEye ? `固視 ${EYE_LABELS[row.fixingEye]}` : ""].filter(Boolean).join(" ")}`)]);
  }
  for (const [key, label] of [["color", "色覚"], ["stereo", "立体視"], ["accommodation", "調節"], ["anterior", "前眼部"], ["other", "その他"]]) {
    if (hasAnyValue(tests[key])) blocks.push([label, [Object.values(tests[key]).filter(Boolean).join(" / ")]]);
  }
  return blocks;
}

function fmt(value, prefix) {
  if (!Number.isFinite(value)) return "";
  return `${prefix}${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function gaze(value) {
  return value === "normal" ? "正常" : value || "—";
}
