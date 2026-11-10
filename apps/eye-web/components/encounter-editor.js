"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { daysUntilNextVisit, diffEncounterContent, evaluateFinalizeReadiness, groupRps } from "@halunasu/eye-core";
import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_MENU, isActiveAppointmentStatus, PER_EYE_PHRASE_TARGETS } from "@halunasu/eye-contracts";
import { AppointmentDialog } from "./appointment-dialog";
import { ActsColumn } from "./chart-rp";
import { DiagnosisTab, useSaveDiagnoses, DEFAULT_DEPARTMENT } from "./chart-diagnoses";
import { ExamBand, ExamHistoryTab } from "./chart-exam-band";
import { FindingsColumn } from "./chart-findings";
import { ORDER_CATEGORIES, OrderPanel } from "./chart-order-panel";
import { insertAtCursor, isTypingTarget, newRpId, orderFromItem, prescriptionFromDrug, useLearningList, dateWithWeekday } from "./chart-shared";
import {
  AmendDialog, CloseResultDialog, ConfirmDialog, RESOLVED_IN_DIALOG, SaveIndicator, SendDialog, SetCreateDialog, ShortcutHelpDialog,
  StatusChoiceDialog, WarningsDialog
} from "./encounter-dialogs";
import { DrugHistoryTab, FilesTab, HistoryTab, LEFT_TABS, PatientInfoTab, VersionsPanel } from "./encounter-panels";
import { getIn, hasExamValues, setIn } from "./encounter-sections";
import { UploadDialog } from "./files-panel";
import { StatusTag } from "./home-workspace";
import { CommonDiagnosesList, PatientBanner, ProfileDialog } from "./patient-banner";
import { openPatientSearch, SHORTCUT_HELP_EVENT } from "./patient-search";
import { useEncounterDraft } from "./use-encounter-draft";
import { useMeasuredHeight } from "./use-measured-height";
import { useMediaQuery } from "./use-media-query";
import { addDays, formatDate, formatDateTime, phraseTargetPath, VISIT_TYPE_LABELS } from "../lib/format";
import { applyCopy, appendRpRows } from "../lib/chart-copy";

const SIDES = ["od", "os"];
// 次へ（→）で選ぶ受付の状態。再計待は表示用の派生、取消はカルテのある受付にはできないので出さない。
const NEXT_STATUS_MENU = APPOINTMENT_STATUS_MENU.filter((status) => status !== "rebill_waiting" && status !== "cancelled");
// 3 ペイン（右も常に表示）と、左を常に表示する条件。chart-editor.css の @media とそろえる。
const WIDE_QUERY = "(min-width: 1280px) and (min-height: 501px)";
const MEDIUM_QUERY = "(min-width: 768px) and (min-height: 501px)";

// カルテ画面（デジカルの 3 ペイン）。左「患者の情報」・中央「本日のカルテ（主訴・所見｜処置・行為）」・右「オーダー」と、
// 右下の操作（保存・印刷・→次へ）。眼科の検査値と次回予定の作法はトプコンに合わせる。
export function EncounterEditor({ encounterId }) {
  const router = useRouter();
  const draft = useEncounterDraft(encounterId, { allowFinalizedEdit: true });
  const {
    api, detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, setError, conflict,
    load, save, update, replaceContent, saveWith, updateMeta, runAction, confirmExam
  } = draft;
  const [notice, setNotice] = useState("");
  const [leftTab, setLeftTab] = useState("history");
  const [category, setCategory] = useState("drug");
  const [selectedRp, setSelectedRp] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [flow, setFlow] = useState(null);
  const [booking, setBooking] = useState({ open: false, saved: null });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [filesReload, setFilesReload] = useState(0);
  const [dxAddOpen, setDxAddOpen] = useState(false);
  const [sets, setSets] = useState(null);
  const [highlight, setHighlight] = useState("");
  const [now, setNow] = useState(Date.now());
  // 高さ 500px 以下（スマホ横）は幅があっても 3 ペインにせず、スマホと同じ「ページ全体のスクロール＋左右は引き出し」にする
  const wide = useMediaQuery(WIDE_QUERY, true);
  const medium = useMediaQuery(MEDIUM_QUERY, true);
  // スマホ縦（767px 以下）は操作帯を 1 段にするため、送信を「…」の中へ移す
  const phone = useMediaQuery("(max-width: 767px)", false);
  // 下の操作帯の高さ（スマホでは 1〜2 段）を本文の下の余白に使う
  const actionbarRef = useMeasuredHeight("--actionbar-h");
  const findingsRef = useRef(null);
  const searchRef = useRef(null);
  const learning = useLearningList(Boolean(context?.canWrite));
  const saveDiagnoses = useSaveDiagnoses(encounter?.patientId, detail?.profile, (profile) => setDetail((current) => ({ ...current, profile })));

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  const previous = detail?.previous || null;
  const changes = useMemo(() => {
    if (!previous || !content) return [];
    try {
      return diffEncounterContent(previous.content, content);
    } catch {
      return [];
    }
  }, [previous, content]);
  const readiness = useMemo(() => {
    if (!content) return { blockers: [], warnings: [] };
    try {
      return evaluateFinalizeReadiness(content, { examConfirmations: encounter?.examConfirmations || null });
    } catch {
      return { blockers: [], warnings: [] };
    }
  }, [content, encounter?.examConfirmations]);

  const openLeft = useCallback((tab) => {
    setLeftTab(tab);
    if (!medium) setDrawer("left");
  }, [medium]);
  const openCategory = useCallback((id) => {
    setCategory(id);
    if (!wide) setDrawer("right");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [wide]);

  // ---- 次へ（→）: 警告一覧 → 受付の状態 → 診察終了 → 次の診察待ちの患者 ----
  const startNext = useCallback(async () => {
    if (!detail?.encounter || !context?.canFinalize) {
      setNotice("確定（次へ）は医師が行います。");
      return;
    }
    const saved = await save();
    if (!saved) return;
    if (detail.encounter.status === "finalized" && !detail.encounter.amendment) setFlow({ step: "status", loading: true });
    else setFlow({ step: "warnings" });
  }, [context?.canFinalize, detail?.encounter, save]);

  // 受付を探す（同じ患者・同じ日の有効な受付。複数なら診察中・診察待を優先）
  const patientId = encounter?.patientId || "";
  useEffect(() => {
    if (flow?.step !== "status" || !flow.loading || !patientId) return undefined;
    let alive = true;
    api(`/v1/eye/appointments?date=${encodeURIComponent(meta.encounterDate)}`)
      .then((payload) => {
        const mine = (payload.appointments || []).filter((item) => item.patientId === patientId && isActiveAppointmentStatus(item.status));
        const rank = (item) => ["in_consult", "waiting_doctor", "in_exam", "in_treatment", "checked_in"].indexOf(item.status);
        const appointment = [...mine].sort((left, right) => (rank(left) < 0 ? 99 : rank(left)) - (rank(right) < 0 ? 99 : rank(right)))[0] || null;
        if (alive) setFlow((current) => (current?.step === "status" ? { ...current, loading: false, appointment } : current));
      })
      .catch((nextError) => { if (alive) setFlow((current) => (current?.step === "status" ? { ...current, loading: false, appointment: null, error: nextError.message } : current)); });
    return () => { alive = false; };
  }, [api, patientId, flow?.step, flow?.loading, meta.encounterDate]);

  // ---- ショートカット（デジカルの割り当て。入力中は 1 文字のキーを効かせない） ----
  const keyActions = useRef({});
  keyActions.current = {
    save: () => { save().then((ok) => ok && setNotice("保存しました。")); },
    next: startNext,
    send: () => openSend(),
    attach: () => { if (context?.canWriteDocuments) { openLeft("files"); setUploadOpen(true); } },
    diagnosis: () => { if (context?.canEditDiagnoses) { openLeft("diagnoses"); setDxAddOpen(true); } },
    help: () => setDialog("shortcuts")
  };
  useEffect(() => {
    function onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229) return;
      const actions = keyActions.current;
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        actions.next();
        return;
      }
      if (event.key === "Escape") {
        setDrawer(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector(".dialog-backdrop")) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        actions.help();
        return;
      }
      if (event.shiftKey) {
        const tab = LEFT_TABS.find((item) => item.codes.includes(event.code));
        if (tab) {
          event.preventDefault();
          openLeft(tab.id);
        }
        return;
      }
      const key = event.key.toLowerCase();
      const single = { s: actions.save, q: actions.next, k: actions.send, a: actions.attach, b: actions.diagnosis, e: () => openLeft("exam") }[key];
      if (single) {
        event.preventDefault();
        single();
        return;
      }
      if (key === "f") {
        // ヘッダーの患者検索（モーダル）を開く
        event.preventDefault();
        openPatientSearch();
        return;
      }
      if (key === "l" || key === "u") {
        event.preventDefault();
        router.push(key === "l" ? "/" : "/reception");
        return;
      }
      const categoryItem = ORDER_CATEGORIES.find((item) => item.key === event.key)
        || (["\\", "^", "-", "¥"].includes(event.key) || event.code === "IntlYen" ? ORDER_CATEGORIES.find((item) => item.id === "all") : null);
      if (categoryItem) {
        event.preventDefault();
        openCategory(categoryItem.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCategory, openLeft, router]);
  // ヘッダーの［ヘルプ］はこの画面のショートカット一覧を出す
  useEffect(() => {
    function onHelp(event) {
      event.preventDefault();
      keyActions.current.help();
    }
    window.addEventListener(SHORTCUT_HELP_EVENT, onHelp);
    return () => window.removeEventListener(SHORTCUT_HELP_EVENT, onHelp);
  }, []);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const patient = encounter.patientSnapshot;
  const profile = detail.profile;
  const nextDays = daysUntilNextVisit(meta.encounterDate, content.nextVisit);
  const orderSets = sets?.orderSets || bootstrap.orderSets;
  const setFolders = sets?.setFolders || bootstrap.setFolders || [];
  const finalizedView = encounter.status === "finalized";
  const dirtyMark = saveState === "dirty" || saveState === "saving" ? "*" : "";

  function openSend() {
    if (!context?.canReceive) return;
    if (encounter.status !== "finalized") {
      setNotice("会計へ送れるのは確定済みのカルテです（→ 次へ で確定します）。");
      return;
    }
    setDialog("send");
  }

  function copyFrom(kind, source, payload = {}) {
    const result = applyCopy(content, source.content, kind, payload);
    replaceContent(result.content);
    setNotice(`${formatDate(source.encounterDate)} のカルテから${result.label}を複写しました。${result.note}`);
    if (!wide && drawer === "left") setDrawer(null);
  }

  // 診療履歴からのドラッグ＆ドロップ（束・自由記載・シェーマ）
  function dropCopy(data) {
    const source = detail.history.find((item) => item.encounterId === data.encounterId);
    if (!source) return;
    if (data.kind === "rx" || data.kind === "orders") {
      const field = data.kind === "rx" ? "prescriptions" : "orders";
      const group = groupRps(source.content[field] || []).find((item) => item.rpId === data.rpId);
      if (group) copyFrom(data.kind, source, { rows: group.rows.map(({ row }) => row) });
      return;
    }
    if (data.kind === "sketch") {
      const sketch = (source.content.sketches || []).find((item) => item.sketchId === data.sketchId);
      if (sketch) copyFrom("sketch", source, { sketch, strokes: data.strokes !== false });
      return;
    }
    if (["text", "left", "right"].includes(data.kind)) copyFrom(data.kind, source);
  }

  // 選択中の束（無ければ新しい束）に行を入れる。legacy の 1 行の束は、入れる前に rpId を振る。
  function addToRp(field, buildRow) {
    const rows = content[field] || [];
    const group = selectedRp?.field === field ? groupRps(rows).find((item) => item.rpId === selectedRp.rpId) : null;
    if (!group) {
      const rpId = newRpId();
      update([field], [...rows, buildRow(rpId, null)]);
      return;
    }
    const rpId = group.legacy ? newRpId() : group.rpId;
    const indexes = new Set(group.rows.map((item) => item.index));
    const base = group.legacy ? rows.map((row, index) => (indexes.has(index) ? { ...row, rpId } : row)) : rows;
    const last = Math.max(...indexes);
    update([field], [...base.slice(0, last + 1), buildRow(rpId, group.head), ...base.slice(last + 1)]);
    if (group.legacy) setSelectedRp({ field, rpId });
  }

  function addDrug(drug) {
    addToRp("prescriptions", (rpId, head) => {
      const row = prescriptionFromDrug(drug, rpId);
      // 同じ Rp に入れるときは、用法・日数などを Rp の先頭にそろえる
      return head ? { ...row, route: head.route, usage: head.usage, timesPerDay: head.timesPerDay, days: head.days, eye: head.eye } : row;
    });
    setNotice(`処方に「${drug.name}」を追加しました。${selectedRp?.field === "prescriptions" ? "（選択中の Rp）" : ""}`);
  }

  function addOrder(item) {
    addToRp("orders", (rpId) => orderFromItem(item, rpId));
    setNotice(`「${item.name}」を検査・処置に追加しました（予定）。`);
  }

  function addLearning(field, bundle) {
    const rows = (bundle.rows || []).map((row) => (field === "prescriptions" && row.kind !== "comment" ? { ...row, ...(bundle.rp || {}), issued: true, note: "" } : row));
    replaceContent(appendRpRows(content, field, rows));
    setNotice(`学習リストから「${bundle.label}」を追加しました。`);
  }

  // セット: 処方は同じ薬を重ねず、オーダーは予定として追加、方針は末尾に足す。自由記載は今回が空のときだけ。病名は患者の病名へ。
  async function applySet(orderSet) {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rpIds = new Map();
    const rekey = (row) => {
      if (!row.rpId) return { ...row };
      if (!rpIds.has(row.rpId)) rpIds.set(row.rpId, `rp_${stamp}_${rpIds.size}`);
      return { ...row, rpId: rpIds.get(row.rpId) };
    };
    const keyOf = (row) => `${row.name}|${row.eye || ""}`;
    const existing = new Set(content.prescriptions.filter((row) => row.kind !== "comment").map(keyOf));
    const addedRx = (orderSet.prescriptions || []).filter((row) => row.kind !== "comment" && !existing.has(keyOf(row)));
    const rxRps = new Set(addedRx.map((row) => row.rpId).filter(Boolean));
    const prescriptions = [...content.prescriptions, ...(orderSet.prescriptions || [])
      .filter((row) => addedRx.includes(row) || (row.kind === "comment" && rxRps.has(row.rpId)))
      .map(rekey)];
    const orders = [...(content.orders || []), ...(orderSet.orders || []).map((order, index) => (order.kind === "comment" ? { ...rekey(order), orderId: `ord_${stamp}${index}` } : {
      ...rekey(order), orderId: `ord_${stamp}${index}`, status: "planned", statusChangedAt: "", statusChangedBy: null
    }))];
    const plan = orderSet.plan && !content.plan.includes(orderSet.plan) ? [content.plan, orderSet.plan].filter(Boolean).join("\n") : content.plan;
    const findingsText = content.findingsText || orderSet.findingsText || "";
    replaceContent({ ...content, prescriptions, orders, plan, ...(findingsText ? { findingsText } : {}) });
    let dxNote = "";
    if (orderSet.diagnoses?.length && context?.canEditDiagnoses) {
      const have = new Set((profile?.diagnoses || []).filter((item) => item.status !== "resolved").map((item) => `${item.name}|${item.eye}`));
      const fresh = orderSet.diagnoses.filter((item) => !have.has(`${item.name}|${item.eye || "ou"}`)).map((item) => ({
        ...item, eye: item.eye || "ou", status: item.status === "resolved" ? "active" : item.status || "active", startDate: meta.encounterDate, endDate: "", outcome: "", primary: Boolean(item.primary), note: item.note || "", department: item.department || DEFAULT_DEPARTMENT
      }));
      if (fresh.length) {
        try {
          await saveDiagnoses([...(profile?.diagnoses || []), ...fresh]);
          dxNote = ` 病名 ${fresh.length}件を登録しました。`;
        } catch (nextError) {
          dxNote = ` 病名は登録できませんでした（${nextError.message}）。`;
        }
      }
    }
    setNotice(`セット「${orderSet.name}」を追加しました。${dxNote}`);
  }

  function insertPhrase(phrase, side) {
    const append = (current) => (current ? `${current}${current.endsWith("\n") ? "" : "\n"}${phrase.text}` : phrase.text);
    if (PER_EYE_PHRASE_TARGETS.includes(phrase.target)) {
      const key = phrase.target.split(".")[1];
      let next = content;
      for (const target of side === "both" ? SIDES : [side]) next = setIn(next, ["findings", target, key], append(next.findings[target][key] || ""));
      replaceContent(next);
    } else if (phrase.target === "findingsText") {
      update(["findingsText"], insertAtCursor(findingsRef.current, content.findingsText, phrase.text));
    } else {
      const path = phraseTargetPath(phrase.target);
      update(path, append(getIn(content, path) || ""));
    }
    setNotice(`定型文「${phrase.label || phrase.text.slice(0, 12)}」を挿入しました。`);
  }

  function insertText(text) {
    update(["findingsText"], insertAtCursor(findingsRef.current, content.findingsText, text));
    setNotice(`主訴・所見に「${text}」を書き込みました。`);
  }

  function addOptical(type) {
    update(["optical"], { ...(content.optical || { purpose: "far", od: {}, os: {}, issue: false }), type });
    requestAnimationFrame(() => document.getElementById("sec-optical")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  // 次へ: 警告を見たうえで進む。検査値の確認・引き継ぎ処方の確認をここで済ませてから、受付の状態を選ぶ。
  async function proceedWarnings() {
    if (content.prescriptions.some((item) => item.carriedOver)) {
      const saved = await saveWith((current) => ({ ...current, prescriptions: current.prescriptions.map((item) => ({ ...item, carriedOver: false })) }));
      if (!saved) return;
    }
    const confirmations = encounter.examConfirmations || {};
    for (const side of SIDES) {
      if (!confirmations[side] && hasExamValues(content.exam[side])) {
        if (!(await confirmExam(side, true))) return;
      }
    }
    setFlow({ step: "status", loading: true });
  }

  function fixWarning(item) {
    if (item.code === "order_planned_all") {
      update(["orders"], (content.orders || []).map((order) => (order.kind !== "comment" && order.status === "planned" ? { ...order, status: "performed" } : order)));
      return;
    }
    const index = Number(String(item.field || "").split(".").at(-1));
    if (Number.isInteger(index)) update(["orders", index, "status"], "performed");
  }

  async function closeVisit(nextStatus) {
    const payload = await runAction(`/v1/eye/encounters/${encounterId}/close`, { nextStatus, ...(flow?.appointment ? { appointmentId: flow.appointment.appointmentId } : {}) });
    if (!payload) return;
    const result = { ...payload, statusLabel: APPOINTMENT_STATUS_LABELS[nextStatus] };
    // 版の一覧などを読み直す（確定の直後に打ち始めた入力は消さない）
    await load();
    if (payload.nextPatient && !payload.appointmentError) {
      setFlow(null);
      goToPatient(payload.nextPatient);
      return;
    }
    setFlow({ step: "result", result });
  }

  async function finalizeOnly() {
    if (encounter.status === "finalized" && !encounter.amendment) {
      setFlow(null);
      return;
    }
    const payload = await runAction(`/v1/eye/encounters/${encounterId}/finalize`, {});
    if (!payload) return;
    // 版の一覧などを読み直す（確定の直後に打ち始めた入力は消さない）
    await load();
    setFlow(null);
    setNotice(`確定しました（v${payload.version?.version || ""}）。${payload.warnings?.length ? `確認事項 ${payload.warnings.length}件のまま確定しました。` : ""}`);
  }

  function goToPatient(next) {
    router.push(next.encounterId ? `/encounters/${next.encounterId}` : `/patients/${next.patientId}`);
  }

  const leftContent = {
    info: <PatientInfoTab context={context} onEditProfile={() => setDialog("profile")} onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))} patient={patient} profile={profile} />,
    exam: <ExamHistoryTab current={content} currentDate={meta.encounterDate} editable={editable} history={detail.history} onInsert={insertText} />,
    history: <HistoryTab changes={changes} editable={editable} highlightId={highlight} history={detail.history} onCopy={copyFrom} previous={previous} />,
    drugs: <DrugHistoryTab history={detail.history} onJump={(id) => { setLeftTab("history"); setHighlight(id); requestAnimationFrame(() => document.getElementById(`hist-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })); }} />,
    files: <FilesTab context={context} encounterId={finalizedView ? encounterId : ""} onUpload={() => setUploadOpen(true)} patientId={encounter.patientId} reloadKey={filesReload} />,
    diagnoses: (
      <DiagnosisTab
        addOpen={dxAddOpen}
        canEdit={Boolean(context?.canEditDiagnoses)}
        encounterDate={meta.encounterDate}
        learning={learning.items.diagnosis}
        onSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
        patientId={encounter.patientId}
        profile={profile}
        setAddOpen={setDxAddOpen}
      />
    )
  };
  const primaryDx = (profile?.diagnoses || []).filter((item) => item.status !== "resolved" && item.primary);

  return (
    <main className={`chart-page${drawer ? ` is-drawer-${drawer}` : ""}`}>
      <header className="encounter-bar chart-topbar">
        <PatientBanner
          actions={(
            <div className="encounter-actions">
              {!medium ? <button aria-expanded={drawer === "left"} className="btn btn-chip" onClick={() => setDrawer(drawer === "left" ? null : "left")} type="button">患者の情報</button> : null}
              {!wide ? <button aria-expanded={drawer === "right"} className="btn btn-chip" onClick={() => setDrawer(drawer === "right" ? null : "right")} type="button">オーダー</button> : null}
              <button aria-label="ショートカット一覧" className="btn btn-chip" onClick={() => setDialog("shortcuts")} title="ショートカット（?）" type="button">?</button>
            </div>
          )}
          compact
          context={context}
          leading={<Link aria-label="患者のカルテ一覧へ" className="back-link" href={`/patients/${encounter.patientId}`}>←</Link>}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={patient}
          profile={profile}
        />
      </header>

      {error ? (
        <p className="alert alert-danger chart-alert" role="alert">
          {error}
          {conflict ? <> （{conflict.sections.join("・")}） <button className="btn btn-chip" onClick={() => load({ force: true })} type="button">最新の内容を読み込む（この端末の未保存の変更は破棄）</button></> : null}
        </p>
      ) : null}
      {notice ? <p className="alert alert-ok chart-alert" role="status">{notice} <button className="btn btn-chip" onClick={() => setNotice("")} type="button">閉じる</button></p> : null}

      <div className="chart-shell">
        <aside aria-label="患者の情報" className="chart-left">
          {/* 引き出しの見出しとタブは 1 つのかたまりで上に残す */}
          <div className="pane-sticky">
            <div className="pane-head drawer-only">
              <h2 className="pane-title">患者の情報</h2>
              <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
            </div>
            <div className="pane-tabs" role="tablist">
              {LEFT_TABS.map((tab) => (
                <button aria-selected={leftTab === tab.id} className="pane-tab" key={tab.id} onClick={() => setLeftTab(tab.id)} role="tab" title={`${tab.label}（${tab.keyLabel}）`} type="button">
                  {tab.label}{tab.id === "history" && detail.history.length ? <span className="pane-tab-count">{detail.history.length}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="pane-body" role="tabpanel">{leftContent[leftTab]}</div>
        </aside>

        <div className="chart-center">
          <div className="chart-head">
            <div className="chart-head-line">
              <strong className="chart-date">{dateWithWeekday(meta.encounterDate)}</strong>
              <span className="chart-tab" title={dirtyMark ? "保存していない変更があります" : undefined}>{dirtyMark}外来 {VISIT_TYPE_LABELS[meta.visitType] || ""}</span>
              <span className="chart-head-spacer" />
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              <button className="btn btn-chip" onClick={() => setDialog("versions")} type="button">版履歴{detail.versions.length ? ` v${detail.versions.length}` : ""}</button>
              {context?.canManageSets && editable ? <button className="btn btn-chip" onClick={() => setDialog("set-create")} type="button">セット登録</button> : null}
            </div>
            <div className="chart-head-line is-sub">
              <span>眼科</span>
              <span>医師 {encounter.finalizedBy?.displayName || (context?.canFinalize ? context.displayName : "—")}</span>
              <span>{VISIT_TYPE_LABELS[meta.visitType] || ""}</span>
              {finalizedView || encounter.amendment ? <StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} /> : <span className="tag tag-draft">未確定</span>}
              {primaryDx.length ? <span className="chart-head-dx">主病 {primaryDx.map((item) => item.name).join("、")}</span> : null}
              <span className="muted small chart-head-editors">記載 {encounter.updatedBy?.displayName || encounter.createdBy?.displayName || ""}{encounter.updatedAt ? ` ${formatDateTime(encounter.updatedAt).slice(11)}` : ""}</span>
              {editable && !finalizedView ? <button aria-label={`診療日・区分を変える（${formatDate(meta.encounterDate)} ${VISIT_TYPE_LABELS[meta.visitType]}）`} className="btn btn-chip" onClick={() => setDialog("visit")} type="button">✎</button> : null}
            </div>
          </div>
          {encounter.amendment ? (
            <p className="alert alert-warn chart-alert">確定済み v{encounter.versionCount} を修正中です（理由: {encounter.amendment.reason}）。→ 次へ で確定すると v{encounter.versionCount + 1} になり、前の版も残ります。</p>
          ) : null}
          {finalizedView && editable ? (
            <p className="alert alert-info chart-alert">確定済み（v{encounter.versionCount}）。このまま直すと修正になり、→ 次へ で確定すると新しい版として残ります。</p>
          ) : null}
          {encounter.status === "draft" && !context?.canFinalize ? <p className="alert alert-info chart-alert">下書きとして保存されます。確定は医師が行います。</p> : null}
          <CommonDiagnosesList />
          <datalist id="drug-presets">{bootstrap.drugPresets.map((preset) => <option key={preset.presetId} value={preset.name} />)}</datalist>
          <ExamBand
            canConfirm={editable}
            confirmations={encounter.examConfirmations || { od: null, os: null }}
            content={content}
            editable={editable}
            encounterId={encounterId}
            now={now}
            onConfirm={(side, confirmed) => confirmExam(side, confirmed)}
            previous={previous?.content}
            previousDate={previous?.encounterDate || ""}
            update={update}
          />
          <div className="chart-columns">
            <FindingsColumn
              content={content}
              editable={editable}
              onClearText={() => setDialog("clear-text")}
              onDropCopy={dropCopy}
              onEditHistory={context?.canEditProfile ? () => setDialog("profile") : null}
              previous={previous}
              profile={profile}
              replaceContent={replaceContent}
              textareaRef={findingsRef}
              update={update}
            />
            <ActsColumn
              bookAction={context?.canReceive ? <button className="btn btn-chip" onClick={() => setBooking({ open: true, saved: null })} type="button">予約を取る</button> : null}
              catalog={bootstrap.orderCatalog}
              content={content}
              drugPresets={bootstrap.drugPresets}
              editable={editable}
              encounterDate={meta.encounterDate}
              encounterId={encounterId}
              nextDays={nextDays}
              onClearAll={() => setDialog("clear-acts")}
              onDropCopy={dropCopy}
              onSelectRp={setSelectedRp}
              selectedRp={selectedRp}
              suggestion={detail.nextVisitSuggestion}
              update={update}
            />
          </div>
          {booking.saved ? <p className="alert alert-ok small chart-alert">予約しました: {formatDate(booking.saved.date)}{booking.saved.time ? ` ${booking.saved.time}` : ""}</p> : null}
        </div>

        <aside aria-label="オーダー" className="chart-right">
          <div className="pane-head drawer-only">
            <h2 className="pane-title">オーダー</h2>
            <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
          </div>
          <OrderPanel
            canManageSets={Boolean(context?.canManageSets)}
            catalog={bootstrap.orderCatalog}
            category={category}
            drugPresets={bootstrap.drugPresets}
            editable={editable}
            learning={learning.items}
            onAddDrug={addDrug}
            onAddLearning={addLearning}
            onAddOptical={addOptical}
            onAddOrder={addOrder}
            onApplySet={applySet}
            onCreateSet={() => setDialog("set-create")}
            onInsertPhrase={insertPhrase}
            orderSets={orderSets}
            phrases={bootstrap.phrases}
            searchRef={searchRef}
            selectedRp={selectedRp}
            setCategory={setCategory}
            setFolders={setFolders}
          />
        </aside>

        <div aria-label="カルテの操作" className="chart-actionbar" data-fixed-bar="bottom" ref={actionbarRef} role="toolbar">
          <span className="actionbar-group">
            {context?.canReceive && !phone ? (
              <button className="btn btn-ghost" disabled={!finalizedView} onClick={openSend} title={finalizedView ? "会計へ送信（K）" : "確定後に送信できます"} type="button">送信</button>
            ) : null}
            <details className="more-menu actionbar-more">
              <summary aria-label="その他の操作" className="btn btn-ghost">…</summary>
              <div className="more-menu-list">
                {context?.canReceive && phone ? (
                  <button className="btn btn-ghost" disabled={!finalizedView} onClick={(event) => { event.currentTarget.closest("details").open = false; openSend(); }} title={finalizedView ? "会計へ送信（K）" : "確定後に送信できます"} type="button">{finalizedView ? "会計へ送信" : "会計へ送信（確定後）"}</button>
                ) : null}
                <button className="btn btn-ghost" onClick={(event) => { event.currentTarget.closest("details").open = false; setDialog("versions"); }} type="button">版履歴</button>
                {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
                  <button className="btn btn-ghost danger-text" onClick={(event) => { event.currentTarget.closest("details").open = false; setDialog("discard"); }} type="button">下書きを破棄</button>
                ) : null}
                {finalizedView && context?.canFinalize && !editable ? (
                  <button className="btn btn-ghost" onClick={(event) => { event.currentTarget.closest("details").open = false; setDialog("amend"); }} type="button">修正する（理由を残す）</button>
                ) : null}
              </div>
            </details>
          </span>
          <span className="actionbar-group">
            {editable ? <button className="btn btn-ghost" onClick={() => keyActions.current.save()} title="保存（S）" type="button">保存</button> : null}
            <details className="more-menu actionbar-print">
              <summary className="btn btn-ghost">印刷</summary>
              <div className="more-menu-list">
                <a className="btn btn-ghost" href={`/encounters/${encounterId}/print`} rel="noreferrer" target="_blank">カルテ（2 号紙）</a>
                {content.optical?.issue ? <a className="btn btn-ghost" href={`/encounters/${encounterId}/optical`} rel="noreferrer" target="_blank">{content.optical.type === "contact" ? "CL 指示書" : "眼鏡処方箋"}</a> : null}
              </div>
            </details>
            {context?.canFinalize ? (
              <button
                className="btn btn-primary next-button"
                onClick={startNext}
                title={`${[...readiness.blockers, ...readiness.warnings].map((item) => item.message).join("\n")}${readiness.blockers.length + readiness.warnings.length ? "\n" : ""}次へ（Q・⌘/Ctrl+Enter）`}
                type="button"
              >
                → 次へ
                {readiness.blockers.length + readiness.warnings.filter((item) => item.level === "high").length ? (
                  <span className={`finalize-count${readiness.blockers.length ? " is-alert" : ""}`}>要確認 {readiness.blockers.length + readiness.warnings.filter((item) => item.level === "high").length}</span>
                ) : null}
              </button>
            ) : null}
          </span>
        </div>
        {drawer ? <button aria-label="閉じる" className="drawer-backdrop" onClick={() => setDrawer(null)} type="button" /> : null}
      </div>

      {dialog === "profile" ? (
        <ProfileDialog
          canEditDiagnoses={Boolean(context?.canEditDiagnoses)}
          onCancel={() => setDialog(null)}
          onSaved={(saved) => { setDialog(null); setDetail((current) => ({ ...current, profile: saved })); }}
          patientId={encounter.patientId}
          profile={profile}
        />
      ) : null}
      {dialog === "visit" ? <VisitMetaDialog meta={meta} onClose={() => setDialog(null)} updateMeta={updateMeta} /> : null}
      {dialog === "versions" ? (
        <div className="dialog-backdrop" role="presentation">
          <div aria-labelledby="versions-heading" className="dialog" role="dialog">
            <h2 id="versions-heading">版履歴</h2>
            <p className="muted small">確定のたびに版が残ります。版を押すと、その版の印刷用の表示を開きます。</p>
            <VersionsPanel encounterId={encounterId} versions={detail.versions} />
            <div className="dialog-actions"><button autoFocus className="btn btn-primary" onClick={() => setDialog(null)} type="button">閉じる</button></div>
          </div>
        </div>
      ) : null}
      {dialog === "shortcuts" ? <ShortcutHelpDialog categories={ORDER_CATEGORIES} leftTabs={LEFT_TABS} onClose={() => setDialog(null)} /> : null}
      {dialog === "set-create" ? (
        <SetCreateDialog
          api={api}
          beforeSave={save}
          encounterId={encounterId}
          onCancel={() => setDialog(null)}
          onCreated={async (orderSet, folders) => {
            setDialog(null);
            try {
              const payload = await api("/v1/eye/order-sets");
              setSets({ orderSets: payload.orderSets, setFolders: payload.setFolders });
            } catch {
              setSets({ orderSets: [orderSet, ...orderSets.filter((item) => item.setId !== orderSet.setId)], setFolders: folders });
            }
            setCategory("set");
            setNotice(`セット「${orderSet.name}」を保存しました。`);
          }}
          orderSets={orderSets}
          setFolders={setFolders}
        />
      ) : null}
      {dialog === "send" ? (
        <SendDialog
          encounterDate={formatDate(meta.encounterDate)}
          error={error}
          onCancel={() => setDialog(null)}
          onSend={async () => {
            try {
              const payload = await api("/v1/eye/billing/send", { method: "POST", body: { date: meta.encounterDate, encounterId } });
              setDialog(null);
              setNotice(`会計へ送信しました。${payload.appointmentMoved ? "受付を「会計済」にしました。" : ""}${payload.appointmentError ? payload.appointmentError.message : ""}`);
            } catch (nextError) {
              setError(nextError.message);
            }
          }}
          patient={patient}
        />
      ) : null}
      {dialog === "clear-text" ? (
        <ConfirmDialog confirmLabel="消す" danger onCancel={() => setDialog(null)} onConfirm={() => { update(["findingsText"], ""); setDialog(null); }} title="主訴・所見の自由記載を消しますか？">
          <p>保存すると元に戻せません（確定済みの版は残ります）。</p>
        </ConfirmDialog>
      ) : null}
      {dialog === "clear-acts" ? (
        <ConfirmDialog
          confirmLabel="すべて消す"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            replaceContent({ ...content, prescriptions: [], orders: (content.orders || []).filter((order) => order.statusChangedBy && order.status === "performed"), optical: { ...(content.optical || {}), type: "", issue: false } });
            setSelectedRp(null);
            setDialog(null);
          }}
          title="処置・行為をすべて消しますか？"
        >
          <p>処方・予定の検査処置・眼鏡の欄を消します。実施済みの記録のある検査・処置は残します。</p>
        </ConfirmDialog>
      ) : null}
      {dialog === "amend" ? (
        <AmendDialog onCancel={() => setDialog(null)} onConfirm={async (reason) => { const payload = await runAction(`/v1/eye/encounters/${encounterId}/amend`, { reason }); setDialog(null); if (payload) await load(); }} />
      ) : null}
      {dialog === "discard" ? (
        <ConfirmDialog
          confirmLabel="破棄する"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => { const payload = await runAction(`/v1/eye/encounters/${encounterId}/discard`, {}); setDialog(null); if (payload) router.push(`/patients/${encounter.patientId}`); }}
          title="この下書きを破棄しますか？"
        >
          <p>一度も確定していない下書きのため、記録は残りません。</p>
        </ConfirmDialog>
      ) : null}
      {flow?.step === "warnings" ? (
        <WarningsDialog
          content={content}
          error={error}
          onCancel={() => setFlow(null)}
          onFix={fixWarning}
          onProceed={proceedWarnings}
          proceedLabel={readiness.warnings.some((item) => RESOLVED_IN_DIALOG.has(item.code)) ? "確認して次へ" : "次へ"}
          readiness={readiness}
          version={encounter.versionCount + 1}
        />
      ) : null}
      {flow?.step === "status" ? (
        <StatusChoiceDialog
          appointment={flow.appointment}
          error={flow.error || error}
          labels={APPOINTMENT_STATUS_LABELS}
          loading={flow.loading}
          onCancel={() => setFlow(null)}
          onConfirm={closeVisit}
          onFinalizeOnly={finalizeOnly}
          statusMenu={NEXT_STATUS_MENU}
        />
      ) : null}
      {flow?.step === "result" ? (
        <CloseResultDialog
          onNext={() => { const next = flow.result.nextPatient; setFlow(null); goToPatient(next); }}
          onReception={() => router.push("/reception")}
          onStay={() => setFlow(null)}
          result={flow.result}
        />
      ) : null}
      {booking.open ? (
        <AppointmentDialog
          fixedPatient={patient}
          initial={{
            date: content.nextVisit.date || (content.nextVisit.intervalWeeks ? addDays(meta.encounterDate, Math.round(content.nextVisit.intervalWeeks * 7)) : meta.encounterDate),
            time: "",
            purpose: "revisit",
            note: content.nextVisit.note,
            walkIn: false,
            sourceEncounterId: encounterId
          }}
          onCancel={() => setBooking({ open: false, saved: null })}
          onSaved={(appointment) => setBooking({ open: false, saved: appointment })}
          title="次回予約"
        />
      ) : null}
      {uploadOpen ? (
        <UploadDialog
          encounterId={encounterId}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { setUploadOpen(false); setFilesReload((value) => value + 1); setNotice("ファイルを取り込みました。"); }}
          patientId={encounter.patientId}
        />
      ) : null}
    </main>
  );
}

// 診療日・区分（見出しの［✎］から）。
function VisitMetaDialog({ meta, updateMeta, onClose }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="visit-heading" className="dialog" role="dialog">
        <h2 id="visit-heading">カルテ更新</h2>
        <label className="field">
          <span>診療日</span>
          <input className="input input-date" onChange={(event) => updateMeta({ encounterDate: event.target.value })} type="date" value={meta.encounterDate} />
        </label>
        <label className="field">
          <span>区分</span>
          <select className="input" onChange={(event) => updateMeta({ visitType: event.target.value })} value={meta.visitType}>
            <option value="initial">初診</option>
            <option value="revisit">再診</option>
          </select>
        </label>
        <div className="dialog-actions"><button autoFocus className="btn btn-primary" onClick={onClose} type="button">閉じる</button></div>
      </div>
    </div>
  );
}
