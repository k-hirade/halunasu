"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadErrorPage } from "./load-error";
import { daysUntilNextVisit, diffEncounterContent, evaluateFinalizeReadiness, groupRps } from "@halunasu/eye-core";
import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_MENU, isActiveAppointmentStatus, PER_EYE_PHRASE_TARGETS } from "@halunasu/eye-contracts";
import { AppointmentDialog } from "./appointment-dialog";
import { ActsColumn } from "./chart-rp";
import { DiagnosisTab, useSaveDiagnoses, DEFAULT_DEPARTMENT } from "./chart-diagnoses";
import { ExamBand, ExamHistoryTab } from "./chart-exam-band";
import { FindingsColumn } from "./chart-findings";
import { ExamRequestIcon, MoreIcon, NextIcon, PrintIcon, SaveIcon, YenIcon } from "./chart-icons";
import { ORDER_CATEGORIES, OrderPanel, regularRepeatLabel } from "./chart-order-panel";
import { closeMenu, insertAtCursor, isTypingTarget, newOrderId, newRpId, orderFromItem, prescriptionFromDrug, useLearningList, dateWithWeekday } from "./chart-shared";
import {
  AmendDialog, CloseResultDialog, ConfirmDialog, ExamRequestDialog, RegularOrderDialog, RESOLVED_IN_DIALOG, SaveIndicator, SendDialog, SetCreateDialog,
  ShortcutHelpDialog, StatusChoiceDialog, warningKey, WarningsDialog
} from "./encounter-dialogs";
import { DrugHistoryTab, FilesTab, HistoryTab, LEFT_TABS, PatientInfoTab, VersionsPanel } from "./encounter-panels";
import { SideEffectsTab } from "./chart-left-allergy";
import { ExamResultsTab } from "./chart-left-exam";
import { InterviewTab, SummaryTab, VitalsTab } from "./chart-left-notes";
import { getIn, hasExamValues, setIn } from "./encounter-sections";
import { UploadDialog } from "./files-panel";
import { StatusTag } from "./home-workspace";
import { CommonDiagnosesList, PatientBanner, ProfileDialog } from "./patient-banner";
import { openPatientSearch, SHORTCUT_HELP_EVENT } from "./patient-search";
import { useEncounterDraft } from "./use-encounter-draft";
import { useDisplayPrefs } from "./use-display-prefs";
import { arrangeItems } from "../lib/display-prefs";
import { useMeasuredHeight } from "./use-measured-height";
import { useMediaQuery } from "./use-media-query";
import { isModalOpen, Modal } from "./modal";
import { addDays, formatDate, formatDateTime, phraseTargetPath, prescriptionText, todayIso, VISIT_TYPE_LABELS } from "../lib/format";
import { applyCopy, appendRpRows } from "../lib/chart-copy";
import { copyBaseContent, isUntouchedTemplate, orderChartTemplates } from "../lib/chart-soap";
import { chartGuide, GUIDE_STATE_LABELS } from "../lib/chart-guide";
import { approvalBriefOf, approvalGuideItem } from "../lib/approval";
import { displayDrugName } from "../lib/drug-name";
import { ApprovalBar, ApprovalTag } from "./chart-approval";

const SIDES = ["od", "os"];
// 次へ（→）で選ぶ受付の状態。再計待は表示用の派生、取消はカルテのある受付にはできないので出さない。
const NEXT_STATUS_MENU = APPOINTMENT_STATUS_MENU.filter((status) => status !== "rebill_waiting" && status !== "cancelled");
// 3 ペイン（右も常に表示）と、左を常に表示する条件。chart-editor.css の @media とそろえる。
const WIDE_QUERY = "(min-width: 1280px) and (min-height: 501px)";
const MEDIUM_QUERY = "(min-width: 768px) and (min-height: 501px)";
// 検査依頼で受付を移す状態（検査室の「検査中」の列に並ぶ）
const EXAM_REQUEST_STATUS = "in_exam";

// カルテ画面（デジカルの 3 ペイン）。左「患者の情報」・中央「本日のカルテ（主訴・所見｜処置・行為）」・右「オーダー」と、
// 右下の操作（保存・印刷・→次へ）。眼科の検査値と次回予定の作法はトプコンに合わせる。
export function EncounterEditor({ encounterId }) {
  const router = useRouter();
  const draft = useEncounterDraft(encounterId, { allowFinalizedEdit: true });
  const {
    api, detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, errorField, setError, conflict,
    load, save, update, replaceContent, saveWith, updateMeta, runAction, confirmExam
  } = draft;
  // 成功・案内のお知らせは小さなトースト（数秒で消える）。同じ文でも出し直せるよう id を持つ。誤りは上の赤い帯に残す
  const [toast, setToast] = useState(null);
  const setNotice = useCallback((text) => setToast(text ? { text, id: `${Date.now()}-${Math.random()}` } : null), []);
  const notice = toast?.text || "";
  // オーダー欄から足した束（rpId）。処置・行為の列でしばらく目立たせる
  const [justAdded, setJustAdded] = useState("");
  const [leftTab, setLeftTab] = useState("history");
  // 表示の設定（左のタブの出す・隠す・並び、カルテガイド）。利用者メニューの「表示の設定」で変える
  const display = useDisplayPrefs(context);
  const displayReady = display.ready;
  const hiddenTabs = display.prefs.leftTabs.hidden;
  // 既定の診療履歴を隠しているときは、最初に開くタブを並びの先頭にする（読み込んだときの 1 回だけ）
  const firstTabChecked = useRef(false);
  useEffect(() => {
    if (!displayReady || firstTabChecked.current) return;
    firstTabChecked.current = true;
    if (hiddenTabs.includes("history")) setLeftTab((current) => (current === "history" ? arrangeItems(LEFT_TABS, display.prefs.leftTabs)[0]?.id || current : current));
  }, [displayReady, hiddenTabs, display.prefs.leftTabs]);
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
  // 警告一覧で［今回は確認しない］にした確認（このカルテを開いている間だけ覚える）
  const [dismissed, setDismissed] = useState(() => new Set());
  // 定期（この患者の定期。右下の「定期」）と、その登録・編集のダイアログ
  const [regular, setRegular] = useState({ items: [], loading: true, error: "" });
  const [regularDialog, setRegularDialog] = useState(null);
  // 検査依頼（受付を探してから選ぶ）
  const [examRequest, setExamRequest] = useState(null);
  // 高さ 500px 以下（スマホ横）は幅があっても 3 ペインにせず、スマホと同じ「ページ全体のスクロール＋左右は引き出し」にする
  const wide = useMediaQuery(WIDE_QUERY, true);
  const medium = useMediaQuery(MEDIUM_QUERY, true);
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
  // 患者のアレルギー（あり・なしの確認）も見る。処方・注射があるのに未確認なら確認を促す
  const allergyProfile = detail?.profile || null;
  const readiness = useMemo(() => {
    if (!content) return { blockers: [], warnings: [] };
    try {
      return evaluateFinalizeReadiness(content, { examConfirmations: encounter?.examConfirmations || null, allergyProfile });
    } catch {
      return { blockers: [], warnings: [] };
    }
  }, [content, encounter?.examConfirmations, allergyProfile]);
  // 「今回は確認しない」にした確認を除いた確認事項（次へのバッジと警告一覧に使う）
  const activeWarnings = useMemo(() => readiness.warnings.filter((item) => !dismissed.has(warningKey(item))), [readiness.warnings, dismissed]);

  // トーストは 4 秒で消す（新しいお知らせが来たら数え直す）
  useEffect(() => {
    if (!toast) return undefined;
    const handle = setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 4000);
    return () => clearTimeout(handle);
  }, [toast]);

  // 足した束を処置・行為の列で見える位置へ送る（引き出しの下に隠れるときは送らず、トーストで知らせる）
  useEffect(() => {
    if (!justAdded) return undefined;
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector(`.chart-col-acts [data-rp="${CSS.escape(justAdded)}"]`);
      if (!element) return;
      const drawerPane = document.querySelector(".chart-page.is-drawer-right .chart-right");
      const box = element.getBoundingClientRect();
      const covered = drawerPane ? box.left + box.width / 2 > drawerPane.getBoundingClientRect().left : false;
      if (!covered) element.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    const handle = setTimeout(() => setJustAdded(""), 2200);
    return () => { cancelAnimationFrame(frame); clearTimeout(handle); };
  }, [justAdded]);
  // この患者の定期（受診日を渡すと「今回の対象」が付く）
  const regularPatientId = detail?.encounter?.patientId || "";
  const regularDate = meta?.encounterDate || "";
  const loadRegular = useCallback(async () => {
    if (!regularPatientId) return;
    try {
      const payload = await api(`/v1/eye/patients/${regularPatientId}/regular-orders?date=${encodeURIComponent(regularDate)}`);
      setRegular({ items: payload.regularOrders || [], loading: false, error: "" });
    } catch (nextError) {
      setRegular((current) => ({ ...current, loading: false, error: nextError.message }));
    }
  }, [api, regularPatientId, regularDate]);
  useEffect(() => { loadRegular(); }, [loadRegular]);

  const openLeft = useCallback((tab) => {
    setLeftTab(tab);
    if (!medium) setDrawer("left");
  }, [medium]);
  const openCategory = useCallback((id) => {
    setCategory(id);
    if (!wide) setDrawer("right");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [wide]);

  // ---- 次へ（→）: 警告一覧（警告があるときだけ） → 受付の状態 → 診察終了 → 次の診察待ちの患者 ----
  // 警告が無いときはデジカルと同じく一覧を出さずに受付の状態へ進む（検査値・引き継ぎ処方の確認は proceedWarnings が済ませる）
  const proceedRef = useRef(null);
  const hasWarnings = readiness.blockers.length + activeWarnings.length > 0;
  const startNext = useCallback(async () => {
    if (!detail?.encounter || !context?.canFinalize) {
      setNotice("確定（次へ）は医師が行います。");
      return;
    }
    const saved = await save();
    if (!saved) return;
    if (detail.encounter.status === "finalized" && !detail.encounter.amendment) setFlow({ step: "status", loading: true });
    else if (!hasWarnings && proceedRef.current) await proceedRef.current();
    else setFlow({ step: "warnings" });
  }, [context?.canFinalize, detail?.encounter, hasWarnings, save, setNotice]);

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
    examRequest: () => openExamRequest(),
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
      // ダイアログが開いているときは、Esc はダイアログが受ける（引き出しは閉じない）
      if (isModalOpen() || document.querySelector(".dialog-backdrop")) return;
      if (event.key === "Escape") {
        if (!event.defaultPrevented) setDrawer(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
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
      const single = { s: actions.save, q: actions.next, k: actions.send, r: actions.examRequest, a: actions.attach, b: actions.diagnosis, e: () => openLeft("exam") }[key];
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

  if (error && !detail) return <LoadErrorPage message={error} />;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const patient = encounter.patientSnapshot;
  const profile = detail.profile;
  const nextDays = daysUntilNextVisit(meta.encounterDate, content.nextVisit);
  const orderSets = sets?.orderSets || bootstrap.orderSets;
  const setFolders = sets?.setFolders || bootstrap.setFolders || [];
  const finalizedView = encounter.status === "finalized";
  const dirtyMark = saveState === "dirty" || saveState === "saving" ? "*" : "";

  // 受診日より前に作った下書き（デジカルの予約済みの下書きカルテ）。会計送信・検査依頼はできない。
  const futureDraft = meta.encounterDate > todayIso();
  const sendable = Boolean(context?.canReceive) && finalizedView && !encounter.amendment && !futureDraft;
  const examRequestable = Boolean(context?.canWrite) && editable && !futureDraft;
  // 承認（指導医）の状態。承認の流れに入ったカルテだけ、ガイドの最後に「承認」を足す
  const approval = approvalBriefOf(encounter);
  const approvalGuide = approvalGuideItem(approval);
  const guide = [...chartGuide(content, { profile, confirmations: encounter.examConfirmations || null }), ...(approvalGuide ? [approvalGuide] : [])];
  // 次へのバッジとツールチップは同じ分け方: 要確認（直す行・level high）を数えてバッジに、注意（low）はツールチップの別の段に出す
  const attentionItems = [...readiness.blockers, ...activeWarnings.filter((item) => item.level === "high")];
  const noteItems = activeWarnings.filter((item) => item.level !== "high");
  const highWarnings = attentionItems.length;
  const nextTitle = [
    attentionItems.length ? `要確認 ${attentionItems.length}件\n${attentionItems.map((item) => `・${item.message}`).join("\n")}` : "",
    noteItems.length ? `注意 ${noteItems.length}件\n${noteItems.map((item) => `・${item.message}`).join("\n")}` : "",
    "次へ（Q・⌘/Ctrl+Enter）"
  ].filter(Boolean).join("\n");

  function openSend() {
    if (!context?.canReceive) return;
    if (futureDraft) {
      setNotice("受診日より前の下書きカルテは会計へ送れません。");
      return;
    }
    if (encounter.status !== "finalized" || encounter.amendment) {
      setNotice("会計へ送れるのは確定済みのカルテです（→ 次へ で確定します）。");
      return;
    }
    setDialog("send");
  }

  function downloadCsv(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 検査依頼: 受付を探してからダイアログを出す（同じ患者・同じ日の有効な受付。診察中を優先）
  async function openExamRequest() {
    if (!examRequestable) {
      if (futureDraft) setNotice("検査依頼は受診日の当日にできます。");
      return;
    }
    setExamRequest({ loading: true, appointment: null, error: "" });
    try {
      const payload = await api(`/v1/eye/appointments?date=${encodeURIComponent(meta.encounterDate)}`);
      const mine = (payload.appointments || []).filter((item) => item.patientId === encounter.patientId && isActiveAppointmentStatus(item.status));
      const rank = (item) => ["in_consult", "waiting_doctor", "in_exam", "in_treatment", "checked_in"].indexOf(item.status);
      const appointment = [...mine].sort((left, right) => (rank(left) < 0 ? 99 : rank(left)) - (rank(right) < 0 ? 99 : rank(right)))[0] || null;
      setExamRequest({ loading: false, appointment, error: "" });
    } catch (nextError) {
      setExamRequest({ loading: false, appointment: null, error: nextError.message });
    }
  }

  async function submitExamRequest({ items, eye }) {
    const planned = new Set((content.orders || []).filter((row) => row.kind !== "comment" && row.status === "planned").map((row) => row.code).filter(Boolean));
    const rpId = newRpId();
    const rows = items.filter((item) => !planned.has(item.code)).map((item) => ({ ...orderFromItem(item, rpId), orderId: newOrderId(), eye: item.requiresEye === false ? "" : eye }));
    if (!rows.length) {
      setExamRequest(null);
      return;
    }
    const saved = await saveWith((current) => ({ ...current, orders: [...(current.orders || []), ...rows] }));
    if (!saved) {
      setExamRequest((current) => (current ? { ...current, error: "カルテを保存できませんでした。" } : current));
      return;
    }
    const appointment = examRequest?.appointment;
    let moved = "";
    if (appointment && context?.canReceive && appointment.status !== EXAM_REQUEST_STATUS) {
      try {
        await api(`/v1/eye/appointments/${appointment.appointmentId}/status`, { method: "POST", body: { status: EXAM_REQUEST_STATUS, expectedRevision: appointment.revision } });
        moved = ` 受付を「${APPOINTMENT_STATUS_LABELS[EXAM_REQUEST_STATUS]}」にしました。`;
      } catch (nextError) {
        moved = ` 受付の状態は変えられませんでした（${nextError.message}）。`;
      }
    }
    setExamRequest(null);
    setNotice(`検査依頼: ${rows.map((row) => row.name).join("・")}を予定に入れました。${moved}`);
  }

  // 定期: 今のカルテから登録・名前と繰り返しの変更・削除・カルテへ入れる
  function regularSummary() {
    return [
      ...content.prescriptions.filter((row) => row.kind !== "comment" && row.name).map((row) => `処方 ${prescriptionText(row)}`),
      ...(content.orders || []).filter((row) => row.kind !== "comment" && row.status !== "cancelled").map((row) => `検査・処置 ${row.name}`)
    ];
  }

  async function submitRegular(values) {
    try {
      if (regularDialog.mode === "create") {
        if (!(await save())) throw new Error("カルテを保存できませんでした。");
        await api(`/v1/eye/patients/${encounter.patientId}/regular-orders`, { method: "POST", body: { encounterId, ...values } });
        setNotice(`定期「${values.name}」を登録しました（${regularRepeatLabel(values)}）。`);
      } else {
        await api(`/v1/eye/regular-orders/${regularDialog.item.setId}`, { method: "PATCH", body: values });
        setNotice(`定期「${values.name}」を更新しました。`);
      }
      setRegularDialog(null);
      await loadRegular();
    } catch (nextError) {
      setRegularDialog((current) => (current ? { ...current, error: nextError.message } : current));
    }
  }

  async function deleteRegular() {
    try {
      await api(`/v1/eye/regular-orders/${regularDialog.item.setId}`, { method: "PATCH", body: { active: false } });
      setNotice(`定期「${regularDialog.item.name}」を削除しました。`);
      setRegularDialog(null);
      await loadRegular();
    } catch (nextError) {
      setRegularDialog((current) => (current ? { ...current, error: nextError.message } : current));
    }
  }

  async function applyRegular(item) {
    await applySet({ name: item.name, prescriptions: item.prescriptions, orders: item.orders, plan: "", diagnoses: [] });
    setNotice(`定期「${item.name}」を入れました。`);
    try {
      await api(`/v1/eye/regular-orders/${item.setId}`, { method: "PATCH", body: { appliedDate: meta.encounterDate } });
      await loadRegular();
    } catch {
      // 「入れた」の記録が残せなくても、カルテへの追加はそのまま
    }
  }

  function jumpTo(item) {
    if (item.id === "approval") {
      setDialog("versions");
      return;
    }
    if (item.id === "diagnosis") {
      openLeft("diagnoses");
      return;
    }
    const element = document.getElementById(item.target);
    if (!element) return;
    if (element.tagName === "DETAILS") element.open = true;
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function copyFrom(kind, source, payload = {}) {
    const result = applyCopy(copyBaseContent(content, source.content, kind, bootstrap.chartTemplates), source.content, kind, payload);
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
    if (["text", "left", "right", "finding", "plan"].includes(data.kind)) copyFrom(data.kind, source, data);
  }

  // 選択中の束（無ければ新しい束）に行を入れる。legacy の 1 行の束は、入れる前に rpId を振る。
  // 入れた束の rpId を返す（処置・行為の列で目立たせるのに使う）
  function addToRp(field, buildRow) {
    const rows = content[field] || [];
    const group = selectedRp?.field === field ? groupRps(rows).find((item) => item.rpId === selectedRp.rpId) : null;
    if (!group) {
      const rpId = newRpId();
      update([field], [...rows, buildRow(rpId, null)]);
      return rpId;
    }
    const rpId = group.legacy ? newRpId() : group.rpId;
    const indexes = new Set(group.rows.map((item) => item.index));
    const base = group.legacy ? rows.map((row, index) => (indexes.has(index) ? { ...row, rpId } : row)) : rows;
    const last = Math.max(...indexes);
    update([field], [...base.slice(0, last + 1), buildRow(rpId, group.head), ...base.slice(last + 1)]);
    if (group.legacy) setSelectedRp({ field, rpId });
    return rpId;
  }

  function addDrug(drug) {
    const rpId = addToRp("prescriptions", (rpId, head) => {
      const row = prescriptionFromDrug(drug, rpId);
      // 同じ Rp に入れるときは、用法・日数などを Rp の先頭にそろえる
      return head ? { ...row, route: head.route, usage: head.usage, timesPerDay: head.timesPerDay, days: head.days, eye: head.eye } : row;
    });
    setJustAdded(rpId);
    setNotice(`処方に「${displayDrugName(drug.name)}」を追加しました。${selectedRp?.field === "prescriptions" ? "（選択中の Rp）" : ""}`);
  }

  function addOrder(item) {
    setJustAdded(addToRp("orders", (rpId) => orderFromItem(item, rpId)));
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
    const findingsText = (orderSet.findingsText && isUntouchedTemplate(content.findingsText, bootstrap.chartTemplates) ? "" : content.findingsText) || orderSet.findingsText || "";
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
    // ［今回は確認しない］にした確認は、ここでまとめて済ませずにそのまま残す（確定の記録に警告として残る）
    const skipped = new Set(readiness.warnings.filter((item) => dismissed.has(warningKey(item))).map((item) => `${item.code}|${item.field || ""}`));
    if (content.prescriptions.some((item) => item.carriedOver) && !skipped.has("prescription_carried_over|content.prescriptions")) {
      const saved = await saveWith((current) => ({ ...current, prescriptions: current.prescriptions.map((item) => ({ ...item, carriedOver: false })) }));
      if (!saved) return;
    }
    const confirmations = encounter.examConfirmations || {};
    for (const side of SIDES) {
      if (skipped.has(`exam_unconfirmed|content.exam.${side}`)) continue;
      if (!confirmations[side] && hasExamValues(content.exam[side])) {
        if (!(await confirmExam(side, true))) return;
      }
    }
    setFlow({ step: "status", loading: true });
  }
  proceedRef.current = proceedWarnings;

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
    // 先にダイアログを閉じる（ダイアログの間は後ろが inert。読み直しの間もすぐ打ち始められるように）
    setFlow(null);
    // 版の一覧などを読み直す（確定の直後に打ち始めた入力は消さない）
    await load();
    setNotice(`確定しました（v${payload.version?.version || ""}）。${payload.warnings?.length ? `確認事項 ${payload.warnings.length}件のまま確定しました。` : ""}${payload.approval?.status === "pending" && payload.approval.current ? "指導医の承認待ちになりました。" : ""}`);
  }

  // 承認・差し戻し（承認者だけ）。見ている版を送り、版履歴などを読み直す
  async function decideApproval(decision, comment = "") {
    const payload = await runAction(`/v1/eye/encounters/${encounterId}/${decision}`, { version: encounter.versionCount, ...(comment ? { comment } : {}) });
    if (!payload) return false;
    await load();
    setNotice(decision === "approve" ? `v${encounter.versionCount} を承認しました。` : `v${encounter.versionCount} を差し戻しました。`);
    return true;
  }

  function goToPatient(next) {
    router.push(next.encounterId ? `/encounters/${next.encounterId}` : `/patients/${next.patientId}`);
  }

  const profileSaved = (saved) => setDetail((current) => ({ ...current, profile: saved }));
  const leftContent = {
    info: <PatientInfoTab context={context} onEditProfile={() => setDialog("profile")} onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))} patient={patient} profile={profile} />,
    interview: <InterviewTab context={context} encounterDate={meta.encounterDate} onInsert={editable ? insertText : null} onSaved={profileSaved} patientId={encounter.patientId} profile={profile} />,
    allergy: <SideEffectsTab context={context} onSaved={profileSaved} patientId={encounter.patientId} profile={profile} />,
    vitals: <VitalsTab context={context} encounterDate={meta.encounterDate} onInsert={editable ? insertText : null} onSaved={profileSaved} patientId={encounter.patientId} profile={profile} ranges={bootstrap.referenceRanges} />,
    exam: <ExamResultsTab current={content} currentDate={meta.encounterDate} history={detail.history} onInsert={editable ? insertText : null} ranges={bootstrap.referenceRanges} />,
    summary: <SummaryTab context={context} onSaved={profileSaved} patientId={encounter.patientId} profile={profile} />,
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
        onSend={context?.canReceive ? openSend : null}
        sendState={finalizedView ? "finalized" : "draft"}
        patientId={encounter.patientId}
        profile={profile}
        setAddOpen={setDxAddOpen}
      />
    )
  };
  const primaryDx = (profile?.diagnoses || []).filter((item) => item.status !== "resolved" && item.primary);
  // 左のタブ: 表示の設定の並びで出す。隠したタブをキー（Shift+数字など）や他のボタンから開いたときは、開いている間だけ最後に出す
  const visibleTabs = arrangeItems(LEFT_TABS, display.prefs.leftTabs);
  const shownTabs = visibleTabs.some((tab) => tab.id === leftTab) ? visibleTabs : [...visibleTabs, LEFT_TABS.find((tab) => tab.id === leftTab)].filter(Boolean);
  const showGuide = display.prefs.guide;

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
      {/* 成功・案内は画面下の小さなトースト（4 秒で消える・レイアウトを動かさない）。誤りは上の赤い帯に残す */}
      <div aria-live="polite" className="chart-toast-slot" role="status">
        {notice ? <p className="chart-toast" key={toast.id}>{notice} <button aria-label="このお知らせを消す" className="chart-toast-close" onClick={() => setNotice("")} type="button">×</button></p> : null}
      </div>

      <div className="chart-shell">
        <aside aria-label="患者の情報" className="chart-left">
          {/* 引き出しの見出しとタブは 1 つのかたまりで上に残す */}
          <div className="pane-sticky">
            <div className="pane-head drawer-only">
              <h2 className="pane-title">患者の情報</h2>
              <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
            </div>
            <div className="pane-tabs" role="tablist">
              {shownTabs.map((tab) => (
                <button aria-selected={leftTab === tab.id} className={`pane-tab${visibleTabs.includes(tab) ? "" : " is-hidden-tab"}`} key={tab.id} onClick={() => setLeftTab(tab.id)} role="tab" title={`${tab.label}（${tab.keyLabel}）`} type="button">
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
              {futureDraft ? <span className="chart-tab is-draft-label" title="受診日より前に作った下書きのカルテです。会計送信・検査依頼は受診日にできます。">下書き</span> : null}
              <span className="chart-tab" title={dirtyMark ? "保存していない変更があります" : undefined}>{dirtyMark}外来 {VISIT_TYPE_LABELS[meta.visitType] || ""}</span>
              <span className="chart-head-spacer" />
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              {detail.versions.length ? <span className="chart-head-version muted small" title="版履歴は「…」から開けます">v{detail.versions.length}</span> : null}
              {/* その他の操作（版履歴・定期登録・セット登録・カルテガイド・下書きの破棄・修正）。右下の操作帯はデジカルと同じ 5 つの大きいボタンだけにする。
                  閉じたあとは「…」へフォーカスを戻す（ダイアログを閉じたときもそこへ戻る） */}
              <details className="more-menu actionbar-more">
                <summary aria-label="その他の操作" className="btn btn-chip"><MoreIcon /></summary>
                <div className="more-menu-list">
                  <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setDialog("versions"); }} type="button">版履歴{detail.versions.length ? ` v${detail.versions.length}` : ""}</button>
                  {context?.canManageSets && editable ? <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setRegularDialog({ mode: "create", error: "" }); }} title="この患者の定期にする（次回・毎回・Nか月ごとに右下へ出す）" type="button">定期登録</button> : null}
                  {context?.canManageSets && editable ? <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setDialog("set-create"); }} type="button">セット登録</button> : null}
                  <button aria-pressed={showGuide} className="btn btn-ghost" disabled={!displayReady} onClick={(event) => { closeMenu(event); display.save({ ...display.prefs, guide: !showGuide }); }} type="button">{showGuide ? "カルテガイドを隠す" : "カルテガイドを出す"}</button>
                  {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
                    <button className="btn btn-ghost danger-text" onClick={(event) => { closeMenu(event); setDialog("discard"); }} type="button">下書きを破棄</button>
                  ) : null}
                  {finalizedView && context?.canFinalize && !editable ? (
                    <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); setDialog("amend"); }} type="button">修正する（理由を残す）</button>
                  ) : null}
                </div>
              </details>
            </div>
            <div className="chart-head-line is-sub">
              <span>眼科</span>
              <span>医師 {encounter.finalizedBy?.displayName || (context?.canFinalize ? context.displayName : "—")}</span>
              <span>{VISIT_TYPE_LABELS[meta.visitType] || ""}</span>
              {finalizedView || encounter.amendment ? <StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} /> : <span className="tag tag-draft">未確定</span>}
              <ApprovalTag approval={approval} />
              {primaryDx.length ? <span className="chart-head-dx">主病 {primaryDx.map((item) => item.name).join("、")}</span> : null}
              <span className="muted small chart-head-editors">記載 {encounter.updatedBy?.displayName || encounter.createdBy?.displayName || ""}{encounter.updatedAt ? ` ${formatDateTime(encounter.updatedAt).slice(11)}` : ""}</span>
              {editable && !finalizedView ? <button aria-label={`診療日・区分を変える（${formatDate(meta.encounterDate)} ${VISIT_TYPE_LABELS[meta.visitType]}）`} className="btn btn-chip" onClick={() => setDialog("visit")} type="button">✎</button> : null}
            </div>
            {/* カルテガイド（トプコン）: 項目ごとの記入状況をボタンの色で出す。押すとその欄へ移る。表示の設定・「…」で隠せる */}
            {showGuide ? <nav aria-label="カルテガイド" className="chart-guide">
              {guide.map((item) => (
                <button
                  aria-label={`${item.label}（${GUIDE_STATE_LABELS[item.state]}${item.hint ? `・${item.hint}` : ""}）`}
                  className={`chart-guide-item is-${item.state}`}
                  key={item.id}
                  onClick={() => jumpTo(item)}
                  title={`${GUIDE_STATE_LABELS[item.state]}${item.hint ? `（${item.hint}）` : ""}`}
                  type="button"
                >
                  <span aria-hidden="true" className="chart-guide-mark">{item.state === "done" ? "✓" : item.state === "warn" ? "!" : ""}</span>
                  {item.label}
                </button>
              ))}
            </nav> : null}
          </div>
          {encounter.amendment ? (
            <p className="alert alert-warn chart-alert">確定済み v{encounter.versionCount} を修正中です（理由: {encounter.amendment.reason}）。→ 次へ で確定すると v{encounter.versionCount + 1} になり、前の版も残ります。</p>
          ) : null}
          {finalizedView && editable ? (
            <p className="alert alert-info chart-alert">確定済み（v{encounter.versionCount}）。このまま直すと修正になり、→ 次へ で確定すると新しい版として残ります。</p>
          ) : null}
          {encounter.status === "draft" && !context?.canFinalize ? <p className="alert alert-info chart-alert">下書きとして保存されます。確定は医師が行います。</p> : null}
          <ApprovalBar
            approval={approval}
            approvalContext={approval?.current ? detail.approvalContext : { ...detail.approvalContext, canDecide: false }}
            onApprove={() => decideApproval("approve")}
            onReturn={(comment) => decideApproval("return", comment)}
            versionCount={encounter.versionCount}
          />
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
              templates={orderChartTemplates(bootstrap.chartTemplates, { encounterMemberId: encounter.templateMemberId, selfMemberId: context?.memberId, names: bootstrap.printNames })}
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
              invalid={errorField}
              justAdded={justAdded}
              onClearAll={() => setDialog("clear-acts")}
              onDropCopy={dropCopy}
              onSelectRp={setSelectedRp}
              selectedRp={selectedRp}
              suggestion={detail.nextVisitSuggestion}
              update={update}
            />
          </div>
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
            onApplyRegular={applyRegular}
            onEditRegular={context?.canManageSets ? (item) => setRegularDialog({ mode: "edit", item, error: "" }) : null}
            phrases={bootstrap.phrases}
            regular={regular}
            searchRef={searchRef}
            selectedRp={selectedRp}
            setCategory={setCategory}
            setFolders={setFolders}
          />
        </aside>

        {/* 右下の操作帯（デジカル: 左に送信¥・検査依頼、右に保存・印刷・次へ。大きい絵＋文字のボタン） */}
        <div aria-label="カルテの操作" className="chart-actionbar is-iconbar" data-fixed-bar="bottom" ref={actionbarRef} role="toolbar">
          <span className="actionbar-group is-start">
            {context?.canReceive ? (
              <button
                aria-label="送信"
                className={`action-tile is-send${sendable ? " is-ready" : ""}`}
                disabled={!sendable}
                onClick={openSend}
                title={sendable ? "会計へ送信（K）" : futureDraft ? "受診日より前の下書きは送れません" : "確定後に送信できます"}
                type="button"
              >
                <YenIcon /><span className="action-tile-label">送信</span>
              </button>
            ) : null}
            {context?.canWrite ? (
              <button
                aria-label="検査依頼"
                className="action-tile"
                disabled={!examRequestable}
                onClick={openExamRequest}
                title={examRequestable ? "検査室へ検査を依頼（R）" : futureDraft ? "検査依頼は受診日にできます" : "編集できるカルテで依頼できます"}
                type="button"
              >
                <ExamRequestIcon /><span className="action-tile-label">検査依頼</span>
              </button>
            ) : null}
          </span>
          <span className="actionbar-group is-end">
            {editable ? (
              <button aria-label="保存" className="action-tile" onClick={() => keyActions.current.save()} title="保存（S）" type="button">
                <SaveIcon /><span className="action-tile-label">保存</span>
              </button>
            ) : null}
            <details className="more-menu actionbar-print">
              <summary aria-label="印刷" className="action-tile"><PrintIcon /><span className="action-tile-label">印刷</span></summary>
              {/* 印刷できる帳票（実際に作れるものだけ）。条件がそろわないものは理由を添えて押せなくする */}
              <div className="more-menu-list print-menu-list">
                <a className="btn btn-ghost" href={`/encounters/${encounterId}/print`} onClick={closeMenu} rel="noreferrer" target="_blank">カルテ（2 号紙）</a>
                {detail.versions.length ? (
                  <a className="btn btn-ghost" href={`/encounters/${encounterId}/print?version=${detail.versions.length}`} onClick={closeMenu} rel="noreferrer" target="_blank">カルテ（2 号紙・確定 v{detail.versions.length}）</a>
                ) : null}
                {content.optical?.issue && content.optical.type ? (
                  <a className="btn btn-ghost" href={`/encounters/${encounterId}/optical`} onClick={closeMenu} rel="noreferrer" target="_blank">{content.optical.type === "contact" ? "CL 指示書" : "眼鏡処方箋"}</a>
                ) : (
                  <button className="btn btn-ghost" disabled title="処置・行為の眼鏡・CL 欄で「発行する」にすると印刷できます" type="button">眼鏡処方箋・CL 指示書（未発行）</button>
                )}
                {context?.canWriteDocuments ? (
                  <button className="btn btn-ghost" onClick={(event) => { closeMenu(event); openLeft("files"); }} type="button">紹介状・診断書などの文書…</button>
                ) : null}
                {context?.canReceive ? (
                  finalizedView ? <Link className="btn btn-ghost" href={`/billing?date=${meta.encounterDate}`} onClick={closeMenu}>会計連絡票（会計連携で印刷）</Link>
                    : <button className="btn btn-ghost" disabled title="確定すると会計連携の画面で印刷できます" type="button">会計連絡票（確定後）</button>
                ) : null}
              </div>
            </details>
            {context?.canFinalize ? (
              <button
                aria-label={`次へ${highWarnings ? `（要確認 ${highWarnings}）` : ""}`}
                className="action-tile is-next next-button"
                onClick={startNext}
                title={nextTitle}
                type="button"
              >
                <NextIcon /><span className="action-tile-label">次へ</span>
                {highWarnings ? <span className={`finalize-count action-tile-badge${readiness.blockers.length ? " is-alert" : ""}`}>{highWarnings}</span> : null}
              </button>
            ) : null}
          </span>
        </div>
        {/* 中くらいの幅のオーダー引き出しはページを暗くしない（引き出しを開いたまま、足したものを見ながら続けられる） */}
        {drawer && !(drawer === "right" && medium) ? <button aria-label="閉じる" className="drawer-backdrop" onClick={() => setDrawer(null)} type="button" /> : null}
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
        <Modal className="dialog" labelledBy="versions-heading" onClose={() => setDialog(null)}>
          <h2 id="versions-heading">版履歴</h2>
          <p className="muted small">確定のたびに版が残ります。版を押すと、その版の印刷用の表示を開きます。</p>
          <VersionsPanel encounterId={encounterId} versions={detail.versions} />
          <div className="dialog-actions"><button autoFocus className="btn btn-primary" onClick={() => setDialog(null)} type="button">閉じる</button></div>
        </Modal>
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
          encounterDate={meta.encounterDate}
          encounterId={encounterId}
          error={error}
          onCancel={() => setDialog(null)}
          onSend={async () => {
            try {
              const payload = await api("/v1/eye/billing/send", { method: "POST", body: { date: meta.encounterDate, encounterId } });
              // 会計連携の画面と同じく、レセコンが取り込む CSV をその場で保存する
              if (payload.csv) downloadCsv(payload.csv, `eye-billing-${meta.encounterDate}-${String(payload.handoff?.handoffId || "").slice(-6)}.csv`);
              setDialog(null);
              setNotice(`会計へ送信しました（CSV を保存）。${payload.appointmentMoved ? "受付を「会計済」にしました。" : ""}${payload.appointmentError ? payload.appointmentError.message : ""}`);
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
          dismissed={dismissed}
          onDismiss={(key) => setDismissed((current) => new Set([...current, key]))}
          onFix={fixWarning}
          onProceed={proceedWarnings}
          onRestore={() => setDismissed(new Set())}
          proceedLabel={activeWarnings.some((item) => RESOLVED_IN_DIALOG.has(item.code)) ? "確認して次へ" : "次へ"}
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
          onSaved={(appointment) => { setBooking({ open: false, saved: appointment }); setNotice(`予約しました: ${formatDate(appointment.date)}${appointment.time ? ` ${appointment.time}` : ""}`); }}
          title="次回予約"
        />
      ) : null}
      {examRequest ? (
        <ExamRequestDialog
          appointment={examRequest.appointment ? { ...examRequest.appointment, label: APPOINTMENT_STATUS_LABELS[examRequest.appointment.displayStatus || examRequest.appointment.status] || "" } : null}
          appointmentLoading={examRequest.loading}
          catalog={bootstrap.orderCatalog}
          error={examRequest.error}
          onCancel={() => setExamRequest(null)}
          onSubmit={submitExamRequest}
          plannedCodes={new Set((content.orders || []).filter((row) => row.kind !== "comment" && row.status === "planned").map((row) => row.code).filter(Boolean))}
          statusLabel={APPOINTMENT_STATUS_LABELS[EXAM_REQUEST_STATUS]}
        />
      ) : null}
      {regularDialog ? (
        <RegularOrderDialog
          error={regularDialog.error}
          initial={regularDialog.item || {}}
          mode={regularDialog.mode}
          onCancel={() => setRegularDialog(null)}
          onDelete={regularDialog.mode === "edit" ? deleteRegular : null}
          onSubmit={submitRegular}
          summary={regularDialog.mode === "create" ? regularSummary() : [
            ...regularDialog.item.prescriptions.filter((row) => row.kind !== "comment").map((row) => `処方 ${prescriptionText(row)}`),
            ...regularDialog.item.orders.filter((row) => row.kind !== "comment").map((row) => `検査・処置 ${row.name}`)
          ]}
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
    <Modal className="dialog" labelledBy="visit-heading" onClose={onClose}>
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
    </Modal>
  );
}
