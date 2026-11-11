"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { APPOINTMENT_STATUS_MENU } from "@halunasu/eye-contracts";
import { AppointmentDialog } from "./appointment-dialog";
import { CancelReceptionDialog, DayHistoryDialog, MarkBadges, MarksDialog, ReceptionHistoryDialog, ReceptionMemoDialog, StatusMenu, useReceptionSettings } from "./reception-dialogs";
import { useEyeApi } from "./eye-api";
import { DateNav } from "./mini-calendar";
import { linkAppointmentToPatient, PatientRegisterDialog, RECEPTION_CHANGED_EVENT } from "./patient-register-dialog";
import { doctorName, useDoctors } from "./use-doctors";
import {
  ageOn,
  APPOINTMENT_PURPOSE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  minutesSince,
  SEX_LABELS,
  todayIso
} from "../lib/format";
import {
  birthWithEra,
  COLUMNS_STORAGE_KEY,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  defaultSortValue,
  displayStatusOf,
  filterAppointments,
  isFiltered,
  kanaOf,
  defaultHiddenColumns,
  queueLabel,
  readStored,
  RECEPTION_COLUMNS,
  sanitizeHiddenColumns,
  sanitizeSort,
  SORT_STORAGE_KEY,
  sortAppointments,
  UNSET,
  writeStored
} from "../lib/reception-table";
import { countByLocation, filterByLocation, LOCATION_LABELS, locationOf, marksOf, RECEPTION_LOCATIONS, receptionPrintHref } from "../lib/reception-extras";

const REFRESH_MS = 15000;
const IN_CLINIC = ["checked_in", "in_exam", "in_treatment", "waiting_doctor", "in_consult", "checkout"];
// 散瞳の点眼から診察できるまでの目安（分）
const DILATION_READY_MINUTES = 20;
// 状態ごとの待ち時間の目安（分）。超えたら数字だけを黄 → 赤にする
const WAIT_THRESHOLDS = { checked_in: [15, 30], in_exam: [20, 40], in_treatment: [20, 40], waiting_doctor: [30, 60], checkout: [10, 20] };
// フィルタのステータスの並び（再計待・不在を含む。取消は最後）
const FILTER_STATUSES = APPOINTMENT_STATUS_MENU;

// 受付（デジカルの受付一覧）。画面幅いっぱいのフラットな表で、列の見出しで並べ替え、▼ の絞り込みで状態・医師・診療科・表示する列を選ぶ。
// ステータスは行のプルダウンでどこへでも移せる。行を押すとカルテを開く。
export function ReceptionWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const doctors = useDoctors();
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState({ appointments: [], encountersByPatient: {}, loaded: false });
  const [details, setDetails] = useState({});
  const [context, setContext] = useState(null);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [hiddenColumns, setHiddenColumns] = useState([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [memo, setMemo] = useState(null);
  const [billing, setBilling] = useState({ confirm: null, busy: false, errors: {} });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  // 患者マーク（患者 ID → { marks, revision }）、場所のタブ、取消の確認、マーク・履歴のダイアログ
  const [patientMarks, setPatientMarks] = useState({});
  const [place, setPlace] = useState("");
  const [cancelling, setCancelling] = useState({ target: null, busy: false });
  const [marking, setMarking] = useState(null);
  const [historyOf, setHistoryOf] = useState(null);
  const [dayHistoryOpen, setDayHistoryOpen] = useState(false);
  const receptionSettings = useReceptionSettings(api);
  const tableWrapRef = useRef(null);

  // 端末ごとに覚えた列と並べ替え、URL の ?date=
  useEffect(() => {
    setHiddenColumns(sanitizeHiddenColumns(readStored(COLUMNS_STORAGE_KEY, defaultHiddenColumns(window.innerWidth))));
    setSort(sanitizeSort(readStored(SORT_STORAGE_KEY, DEFAULT_SORT)));
    const requested = new URLSearchParams(window.location.search).get("date");
    if (requested && /^\d{4}-\d{2}-\d{2}$/u.test(requested)) setDate(requested);
  }, []);

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/appointments?date=${date}`);
    setData({ ...payload, loaded: true });
    setNow(Date.now());
  }, [api, date]);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch((nextError) => setError(nextError.message));
  }, [api]);

  useEffect(() => {
    setData((current) => (current.date === date ? current : { appointments: [], encountersByPatient: {}, loaded: false }));
    load().catch((nextError) => setError(nextError.message));
    const handle = setInterval(() => { load().catch(() => {}); }, REFRESH_MS);
    const onChanged = () => { load().catch(() => {}); };
    window.addEventListener(RECEPTION_CHANGED_EVENT, onChanged);
    return () => { clearInterval(handle); window.removeEventListener(RECEPTION_CHANGED_EVENT, onChanged); };
  }, [load, date]);

  // 患者メモ・前回受付日は、日付を変えたときと患者が増えたときだけ引く（15 秒ごとの更新では引かない）
  const patientKey = useMemo(() => [...new Set(data.appointments.map((item) => item.patientId).filter(Boolean))].sort().join(","), [data.appointments]);
  const loadDetails = useCallback(async () => {
    if (!patientKey) {
      setDetails({});
      setPatientMarks({});
      return;
    }
    const [payload, marks] = await Promise.all([
      api(`/v1/eye/appointments/patient-details?date=${date}`),
      api(`/v1/eye/appointments/patient-marks?date=${date}`).catch(() => ({ patients: {} }))
    ]);
    setDetails(payload.patients || {});
    setPatientMarks(marks.patients || {});
  }, [api, date, patientKey]);
  useEffect(() => { loadDetails().catch(() => {}); }, [loadDetails]);

  const canReceive = Boolean(context?.canReceive);
  const canWrite = Boolean(context?.canWrite);
  const isToday = date === todayIso();
  const appointments = data.appointments;

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await Promise.all([load(), loadDetails()]);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function move(appointment, status) {
    setError("");
    setNotice("");
    try {
      await api(`/v1/eye/appointments/${appointment.appointmentId}/status`, {
        method: "POST",
        body: { expectedRevision: appointment.revision, status }
      });
      await load();
      return true;
    } catch (nextError) {
      setError(nextError.status === 409 && status === "cancelled" ? `${appointment.patientName}: ${nextError.message}` : nextError.message);
      await load().catch(() => {});
      return false;
    }
  }

  async function openChart(appointment, view = "") {
    const suffix = view ? `/${view}` : "";
    const existing = data.encountersByPatient[appointment.patientId];
    if (existing) {
      router.push(`/encounters/${existing.encounterId}${suffix}`);
      return;
    }
    try {
      const chart = await api(`/v1/eye/patients/${appointment.patientId}/chart`);
      const payload = await api("/v1/eye/encounters", {
        method: "POST",
        body: {
          patientId: appointment.patientId,
          encounterDate: appointment.date,
          visitType: chart.latestFinalized ? "revisit" : "initial"
        }
      });
      router.push(`/encounters/${payload.encounter.encounterId}${suffix}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  // 行を押したとき: カルテがあれば開く。来院済み（受付中〜会計待）でカルテの記載ができる人なら作って開く。
  // 予約済・取消・不在の行や、カルテを書けない役割は患者のページへ（予約だけでは下書きカルテを作らない）。
  function openRow(appointment) {
    if (!appointment.patientId) {
      if (canReceive) setRegistering(appointment);
      return;
    }
    const existing = data.encountersByPatient[appointment.patientId];
    if (existing) {
      router.push(`/encounters/${existing.encounterId}`);
      return;
    }
    if (canWrite && IN_CLINIC.includes(appointment.status)) {
      openChart(appointment);
      return;
    }
    router.push(`/patients/${appointment.patientId}`);
  }

  function onRowClick(event, appointment) {
    if (event.target.closest("button, select, a, input, textarea, summary, details, label, [data-cell-action], [role='menu']")) return;
    openRow(appointment);
  }

  // 登録した（または選んだ）患者を受付に紐づける。再試行でも最新の版を使う
  async function linkRegistering(patient) {
    const current = data.appointments.find((item) => item.appointmentId === registering.appointmentId) || registering;
    await linkAppointmentToPatient(api, current, patient);
    setRegistering(null);
    await load();
  }

  // 受付メモ（ラベルと本文）。ラベルを先に保存し、返った版で本文を保存する
  async function saveReceptionMemo({ labels, text, labelsChanged, textChanged }) {
    const target = data.appointments.find((item) => item.appointmentId === memo.appointment.appointmentId) || memo.appointment;
    let revision = target.revision;
    if (labelsChanged) {
      const payload = await api(`/v1/eye/appointments/${target.appointmentId}/reception`, { method: "PATCH", body: { expectedRevision: revision, receptionLabels: labels } });
      revision = payload.appointment.revision;
    }
    if (textChanged) {
      await api(`/v1/eye/appointments/${target.appointmentId}`, { method: "PATCH", body: { expectedRevision: revision, receptionMemo: text } });
    }
    await load();
    setMemo(null);
  }

  async function saveMarks(keys) {
    const patientId = marking.patientId;
    await api(`/v1/eye/patients/${patientId}/marks`, { method: "PUT", body: { expectedRevision: patientMarks[patientId]?.revision || 0, marks: keys } });
    setMarking(null);
    await loadDetails();
  }

  async function changeLocation(appointment, location) {
    setError("");
    try {
      await api(`/v1/eye/appointments/${appointment.appointmentId}/reception`, { method: "PATCH", body: { expectedRevision: appointment.revision, location } });
      await load();
    } catch (nextError) {
      setError(nextError.message);
      await load().catch(() => {});
    }
  }

  async function confirmCancel() {
    const target = cancelling.target;
    setCancelling({ target, busy: true });
    const done = await move(target, "cancelled");
    setCancelling({ target: null, busy: false });
    if (done) setNotice(`${target.patientName} の受付を取り消しました（絞り込みで「取消」を選ぶと表示できます）。`);
  }

  function openPrint(appointment, kind) {
    window.open(receptionPrintHref(appointment.appointmentId, kind, { memo: kind === "booking" }), "_blank", "noopener");
  }

  async function saveMemo(text) {
    const target = memo.appointment;
    if (memo.kind === "patient") {
      await api(`/v1/eye/patients/${target.patientId}/memo`, {
        method: "PUT",
        body: { expectedRevision: details[target.patientId]?.patientMemoRevision ?? 0, patientMemo: text }
      });
      await loadDetails();
    } else {
      await api(`/v1/eye/appointments/${target.appointmentId}`, {
        method: "PATCH",
        body: { expectedRevision: target.revision, receptionMemo: text }
      });
      await load();
    }
    setMemo(null);
  }

  // 1 人分の会計連携（レセコンへ渡す）。CSV を保存し、会計待なら会計済にする。
  async function sendBilling(appointment) {
    const encounter = data.encountersByPatient[appointment.patientId];
    setBilling((current) => ({ ...current, busy: true }));
    setError("");
    try {
      const payload = await api("/v1/eye/billing/send", {
        method: "POST",
        body: { date: appointment.date, encounterId: encounter.encounterId, appointmentId: appointment.appointmentId }
      });
      downloadCsv(payload.csv, `eye-billing-${appointment.date}-${String(payload.handoff?.handoffId || "").slice(-6)}.csv`);
      const { [appointment.appointmentId]: _removed, ...rest } = billing.errors;
      setBilling({ confirm: null, busy: false, errors: rest });
      setNotice(payload.appointmentError ? `${appointment.patientName}: 会計情報を渡しました。${payload.appointmentError.message}` : `${appointment.patientName}: 会計情報を渡しました（会計済）。`);
      await load();
    } catch (nextError) {
      setBilling((current) => ({ confirm: null, busy: false, errors: { ...current.errors, [appointment.appointmentId]: nextError.message } }));
      setError(`${appointment.patientName}: 会計情報を渡せませんでした。${nextError.message}`);
    }
  }

  function toggleSort(key) {
    const next = sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    setSort(next);
    writeStored(SORT_STORAGE_KEY, next);
  }

  function setColumnHidden(key, hidden) {
    const next = hidden ? [...new Set([...hiddenColumns, key])] : hiddenColumns.filter((item) => item !== key);
    setHiddenColumns(next);
    writeStored(COLUMNS_STORAGE_KEY, next);
  }

  const waitOf = (item) => (IN_CLINIC.includes(item.status) ? minutesSince(item.statusHistory?.at(-1)?.at, now) : null);
  const dilationOf = (item) => {
    const encounter = data.encountersByPatient[item.patientId];
    return IN_CLINIC.includes(item.status) && encounter?.dilationStartedAt ? minutesSince(encounter.dilationStartedAt, now) : null;
  };
  const sortValue = (row, key) => {
    switch (key) {
      case "doctor": return doctorName(doctors, row.doctorMemberId);
      case "number": return (row.patientId ? details[row.patientId]?.primaryPatientNumber : "") || row.patientSnapshot?.primaryPatientNumber || "";
      case "purpose": return APPOINTMENT_PURPOSE_LABELS[row.purpose] || "";
      case "previous": return row.patientId ? details[row.patientId]?.previousVisitDate || "" : "";
      case "patientMemo": return row.patientId ? details[row.patientId]?.patientMemo || "" : "";
      case "receptionMemo": return [...(row.receptionLabels || []), row.receptionMemo ?? row.note ?? ""].join(" ").trim();
      case "marks": return row.patientId ? (patientMarks[row.patientId]?.marks || []).length || null : null;
      case "location": { const key = locationOf(row); return key ? RECEPTION_LOCATIONS.findIndex((item) => item.key === key) : null; }
      case "progress": {
        const encounter = data.encountersByPatient[row.patientId];
        if (!encounter || !IN_CLINIC.includes(row.status)) return null;
        const chips = progressChips(encounter);
        return chips.filter(([, state]) => state === "done").length / Math.max(chips.length, 1);
      }
      case "dilation": return dilationOf(row);
      case "wait": return waitOf(row);
      default: return undefined;
    }
  };
  const valueOf = (row, key) => {
    const custom = sortValue(row, key);
    return custom === undefined ? defaultSortValue(row, key) : custom;
  };

  const baseRows = appointments;
  const filtered = filterAppointments(baseRows, filters, details);
  const placeCounts = countByLocation(filtered);
  const rows = sortAppointments(filterByLocation(filtered, place), sort, valueOf);
  const filteredOn = isFiltered(filters);
  const totalShown = filterAppointments(baseRows, DEFAULT_FILTERS, details).length;
  const columns = RECEPTION_COLUMNS.filter((column) => !hiddenColumns.includes(column.key));
  useScrollEdges(tableWrapRef, [columns.length, rows.length]);

  function renderCell(column, item) {
    const snapshot = item.patientSnapshot || {};
    const encounter = data.encountersByPatient[item.patientId];
    const display = displayStatusOf(item);
    const extra = item.patientId ? details[item.patientId] : null;
    const editable = canReceive && !["cancelled"].includes(item.status);
    const editCell = (content, label) => (editable ? (
      <button aria-label={`${item.patientName} の${label}を編集`} className="rc-cell-edit" onClick={() => setDialog({ appointment: item })} type="button">
        <span>{content || <span className="muted">-</span>}</span><span aria-hidden="true" className="rc-pencil">✎</span>
      </button>
    ) : content);
    switch (column.key) {
      case "marks": return item.patientId ? (
        <MarkBadges
          definitions={receptionSettings.settings.marks}
          keys={patientMarks[item.patientId]?.marks || []}
          name={item.patientName}
          onOpen={canReceive ? () => setMarking({ patientId: item.patientId, patientName: item.patientName }) : null}
        />
      ) : null;
      case "location": {
        const current = locationOf(item);
        if (!current) return <span className="muted">-</span>;
        if (!canReceive) return LOCATION_LABELS[current];
        return (
          <select aria-label={`${item.patientName} の場所`} className="rc-location" onChange={(event) => changeLocation(item, event.target.value)} value={current}>
            {RECEPTION_LOCATIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        );
      }
      case "no": return <span className="mono">{queueLabel(item)}</span>;
      case "time": return editCell(<span className="mono">{item.time || "-"}</span>, "予約時間");
      case "checkin": return <span className="mono">{formatClock(item.checkedInAt) || "-"}</span>;
      case "status": return (
        <StatusMenu appointment={item} disabled={!canReceive} display={display} onChange={(status) => move(item, status)} onRequestCancel={() => setCancelling({ target: item, busy: false })} />
      );
      case "number": return <span className="mono">{extra?.primaryPatientNumber || snapshot.primaryPatientNumber || ""}</span>;
      case "name": return (
        <button className="rc-name" onClick={() => openRow(item)} type="button">
          <span className="rc-kana">{kanaOf(item) || " "}</span>
          <strong>{item.patientName}</strong>
          {!item.patientId ? <span className="tag tag-warn">未登録</span> : null}
        </button>
      );
      case "birth": return <span className="mono">{birthWithEra(snapshot.birthDate)}</span>;
      case "age": {
        const age = ageOn(snapshot.birthDate, item.date);
        return age === null ? "" : `${age}歳${snapshot.sex && snapshot.sex !== "unknown" ? ` ${SEX_LABELS[snapshot.sex] || ""}` : ""}`;
      }
      case "purpose": return editCell(<>{item.purpose === "initial" ? <span className="flow-new">新</span> : null}{APPOINTMENT_PURPOSE_LABELS[item.purpose]}</>, "目的");
      case "department": return editCell(item.department, "診療科");
      case "doctor": return editCell(doctorName(doctors, item.doctorMemberId), "医師");
      case "previous": return item.patientId ? <span className="mono">{extra ? (extra.previousVisitDate ? extra.previousVisitDate.replaceAll("-", "/") : "初") : ""}</span> : "";
      case "patientMemo": return item.patientId ? (
        <MemoCell disabled={!canReceive} label="患者メモ" name={item.patientName} onOpen={() => setMemo({ kind: "patient", appointment: item, text: extra?.patientMemo || "" })} text={extra?.patientMemo || ""} />
      ) : "";
      case "receptionMemo": return (
        <MemoCell disabled={!canReceive} label="受付メモ" labels={item.receptionLabels || []} name={item.patientName} onOpen={() => setMemo({ kind: "reception", appointment: item, text: item.receptionMemo ?? item.note ?? "" })} text={item.receptionMemo ?? item.note ?? ""} />
      );
      case "billing": return (
        <BillingCell
          appointment={item}
          canSend={canReceive}
          display={display}
          encounter={encounter}
          error={billing.errors[item.appointmentId]}
          onSend={() => setBilling((current) => ({ ...current, confirm: item }))}
        />
      );
      // 表では 1 行に収めて幅を切るので、全部の項目は title で見られるようにする
      case "progress": {
        const chips = IN_CLINIC.includes(item.status) && encounter ? progressChips(encounter) : [];
        const titleOf = ([label, state]) => `${label}: ${state === "done" ? "済" : "未"}`;
        return (
          <span className="rc-progress" title={chips.length ? chips.map(titleOf).join(" / ") : undefined}>
            {chips.map((chip, index) => <span className={`flow-step is-${chip[1]}`} key={`${chip[0]}${index}`} title={titleOf(chip)}>{chip[0]}{chip[1] === "done" ? "✓" : "・"}</span>)}
          </span>
        );
      }
      case "dilation": return <DilationChip minutes={dilationOf(item)} />;
      case "wait": {
        const wait = waitOf(item);
        if (wait === null) return "";
        const [warnAt, alertAt] = WAIT_THRESHOLDS[item.status] || [];
        const level = !warnAt ? "" : wait >= alertAt ? " is-alert" : wait >= warnAt ? " is-warn" : "";
        return <span className={`flow-wait${level}`}>{wait}分</span>;
      }
      default: return "";
    }
  }

  function rowMenu(item) {
    const entries = [];
    if (item.patientId) entries.push(["患者のページ", () => router.push(`/patients/${item.patientId}`)]);
    if (item.patientId && canWrite && IN_CLINIC.includes(item.status)) entries.push(["検査入力", () => openChart(item, "exam")]);
    if (!item.patientId && canReceive) entries.push(["患者登録", () => setRegistering(item)]);
    if (canReceive && item.status !== "cancelled") entries.push([item.status === "booked" ? "予約を編集" : "受付を編集", () => setDialog({ appointment: item })]);
    if (canReceive) entries.push(["受付メモ", () => setMemo({ kind: "reception", appointment: item, text: item.receptionMemo ?? item.note ?? "" })]);
    if (canReceive && item.patientId) entries.push(["患者メモ", () => setMemo({ kind: "patient", appointment: item, text: details[item.patientId]?.patientMemo || "" })]);
    if (canReceive && item.patientId) entries.push(["患者マーク", () => setMarking({ patientId: item.patientId, patientName: item.patientName })]);
    if (item.status === "booked") entries.push(["予約票を印刷", () => openPrint(item, "booking")]);
    if (item.queueNumber && item.status !== "cancelled") entries.push(["受付票を印刷", () => openPrint(item, "visit")]);
    entries.push(["受付編集履歴", () => setHistoryOf(item)]);
    if (canReceive && item.status !== "cancelled") entries.push(["受付取消", () => setCancelling({ target: item, busy: false })]);
    return entries;
  }

  return (
    <main className="eye-page rc-page">
      <div className="rc-toolbar">
        <h1 className="rc-title">受付</h1>
        <DateNav date={date} onChange={(value) => { setDate(value || todayIso()); setNotice(""); }} />
        {!isToday ? <button className="btn btn-ghost btn-sm" onClick={() => setDate(todayIso())} type="button">今日</button> : null}
        <span className="rc-count" aria-live="polite">{filteredOn ? `${rows.length} / ${totalShown}件` : `全 ${rows.length}件`}</span>
        <div className="rc-filter-wrap">
          <button aria-expanded={filterOpen} aria-haspopup="dialog" className={`btn btn-ghost btn-sm rc-filter-button${filteredOn ? " is-active" : ""}`} onClick={() => setFilterOpen(!filterOpen)} type="button">▼ 絞り込み</button>
          {filteredOn ? <button aria-label="絞り込みを解除" className="btn btn-ghost btn-sm" onClick={() => setFilters(DEFAULT_FILTERS)} type="button">×</button> : null}
          {filterOpen ? (
            <FilterPopover
              appointments={baseRows}
              doctors={doctors}
              filters={filters}
              hiddenColumns={hiddenColumns}
              onClose={() => setFilterOpen(false)}
              onColumn={setColumnHidden}
              onFilters={setFilters}
            />
          ) : null}
        </div>
        <div className="rc-toolbar-actions">
          <Link className="btn btn-ghost btn-sm" href={`/reception/schedule?date=${date}`}>予約状況</Link>
          <button className="btn btn-ghost btn-sm" onClick={() => setDayHistoryOpen(true)} type="button">編集履歴</button>
          <a className="btn btn-ghost btn-sm" href="/reception/display" rel="noopener" target="_blank" title="待合室の画面に出す受付番号（別のタブで開きます）">院内掲示</a>
          {canReceive ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ walkIn: false })} type="button">予約を追加</button>
              {isToday ? <button className="btn btn-primary btn-sm" onClick={() => setDialog({ walkIn: true })} type="button">当日受付</button> : null}
            </>
          ) : null}
          <button aria-label="受付一覧を更新" className="btn btn-ghost btn-sm" disabled={refreshing} onClick={refresh} title="更新" type="button">↻</button>
        </div>
        {/* 900px 以下は表をカードにして列の見出しを出さないので、並べ替えはここで選ぶ */}
        <div className="rc-mobile-sort">
          <label className="rc-mobile-sort-label" htmlFor="rc-mobile-sort">並べ替え</label>
          <select className="input" id="rc-mobile-sort" onChange={(event) => { const next = { key: event.target.value, dir: "asc" }; setSort(next); writeStored(SORT_STORAGE_KEY, next); }} value={sort.key}>
            {RECEPTION_COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}
          </select>
          <button aria-label={sort.dir === "asc" ? "降順にする" : "昇順にする"} className="btn btn-ghost btn-sm" onClick={() => toggleSort(sort.key)} type="button">{sort.dir === "asc" ? "▲" : "▼"}</button>
        </div>
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {notice ? <p className="alert alert-ok" role="status">{notice}</p> : null}
      {/* 場所（トプコンの場所一覧）: 院内の患者を場所で分ける。場所は行の「場所」で変える（無ければステータスから決まる） */}
      <div aria-label="場所" className="rc-places" role="tablist">
        <button aria-selected={!place} className="rc-place-tab" onClick={() => setPlace("")} role="tab" type="button">すべて<span className="rc-place-count">{filtered.length}</span></button>
        {RECEPTION_LOCATIONS.map((item) => (
          <button aria-selected={place === item.key} className="rc-place-tab" key={item.key} onClick={() => setPlace(item.key)} role="tab" type="button">
            {item.label}<span className="rc-place-count">{placeCounts[item.key]}</span>
          </button>
        ))}
      </div>

      <div className="rc-table-wrap" ref={tableWrapRef}>
        <table aria-label="受付一覧" className="rc-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th aria-sort={sort.key === column.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={`rc-col-${column.key}`} key={column.key} scope="col">
                  <button className="rc-sort" onClick={() => toggleSort(column.key)} type="button">
                    {column.label}
                    <span aria-hidden="true" className="rc-sort-mark">{sort.key === column.key ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
              ))}
              <th className="rc-col-actions" scope="col"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const menu = rowMenu(item);
              return (
                <tr className={`rc-row status-${displayStatusOf(item)}`} key={item.appointmentId} onClick={(event) => onRowClick(event, item)}>
                  {columns.map((column) => <td className={`rc-col-${column.key}`} data-label={column.label} key={column.key}>{renderCell(column, item)}</td>)}
                  <td className="rc-col-actions">
                    {canReceive ? (
                      <button
                        aria-label={`${item.patientName} の次回予約`}
                        className="btn btn-ghost btn-sm"
                        onClick={() => setDialog({ walkIn: false, patient: item.patientId ? patientOf(item) : null, patientName: item.patientId ? "" : item.patientName })}
                        type="button"
                      >予約</button>
                    ) : null}
                    {menu.length ? (
                      <details className="more-menu">
                        <summary aria-label={`${item.patientName} のその他の操作`} className="btn btn-chip">…</summary>
                        <div className="more-menu-list">
                          {menu.map(([label, action]) => (
                            <button className="btn btn-ghost" key={label} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); action(); }} type="button">{label}</button>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data.loaded && rows.length === 0 ? <p className="rc-empty muted">{place && filtered.length ? `${LOCATION_LABELS[place]}にいる患者はいません。` : appointments.length ? "絞り込みに当てはまる受付はありません。" : "この日の予約・受付はありません。"}</p> : null}
        {!data.loaded && !error ? <p className="rc-empty muted">読み込み中…</p> : null}
      </div>

      {dialog ? (
        <AppointmentDialog
          appointment={dialog.appointment || null}
          fixedPatient={dialog.patient || null}
          initial={{ date: dialog.walkIn ? todayIso() : date, walkIn: Boolean(dialog.walkIn), purpose: "revisit", time: "", patientName: dialog.patientName || "" }}
          onCancel={() => setDialog(null)}
          onSaved={async () => { setDialog(null); await Promise.all([load(), loadDetails()]).catch(() => {}); }}
          title={dialog.appointment ? (dialog.appointment.status === "booked" ? "予約の編集" : "受付の編集") : dialog.walkIn ? "当日受付" : "予約登録"}
        />
      ) : null}
      {registering ? (
        <PatientRegisterDialog
          initial={{ displayName: registering.patientName }}
          onCancel={() => setRegistering(null)}
          onCreated={linkRegistering}
          onPickExisting={linkRegistering}
          pickExistingLabel="この患者で受付"
          submitLabel="登録して受付に紐づける"
          title={`患者登録（受付 ${queueLabel(registering)}）`}
        />
      ) : null}
      {memo?.kind === "reception" ? (
        <ReceptionMemoDialog
          appointment={memo.appointment}
          labels={receptionSettings.settings.labels}
          onAddLabel={receptionSettings.addLabel}
          onCancel={() => setMemo(null)}
          onSave={saveReceptionMemo}
        />
      ) : null}
      {memo?.kind === "patient" ? (
        <MemoDialog
          label={memo.kind === "patient" ? "患者メモ" : "受付メモ"}
          note={memo.kind === "patient" ? "患者に固定のメモです。毎回の受付に出ます。" : "この日の受付だけのメモです。"}
          onCancel={() => setMemo(null)}
          onSave={saveMemo}
          patientName={memo.appointment.patientName}
          text={memo.text}
        />
      ) : null}
      {cancelling.target ? (
        <CancelReceptionDialog appointment={cancelling.target} busy={cancelling.busy} onCancel={() => setCancelling({ target: null, busy: false })} onConfirm={confirmCancel} />
      ) : null}
      {marking ? (
        <MarksDialog
          definitions={receptionSettings.settings.marks}
          onCancel={() => setMarking(null)}
          onSave={saveMarks}
          patientName={marking.patientName}
          selected={marksOf(patientMarks[marking.patientId]?.marks || [], receptionSettings.settings.marks).map((mark) => mark.key)}
        />
      ) : null}
      {historyOf ? <ReceptionHistoryDialog api={api} appointment={historyOf} doctorName={(id) => doctorName(doctors, id)} onClose={() => setHistoryOf(null)} /> : null}
      {dayHistoryOpen ? <DayHistoryDialog api={api} appointments={appointments} date={date} doctorName={(id) => doctorName(doctors, id)} onClose={() => setDayHistoryOpen(false)} /> : null}
      {billing.confirm ? (
        <div className="dialog-backdrop" role="presentation">
          <div aria-labelledby="rc-billing-heading" aria-modal="true" className="dialog" role="alertdialog">
            <h2 id="rc-billing-heading">レセコンへ会計情報を渡しますか？</h2>
            <p>{billing.confirm.patientName}（{queueLabel(billing.confirm)}）の確定済みカルテの会計情報を CSV にして渡し、{billing.confirm.status === "checkout" ? "会計済にします。" : "連携済みにします。"}</p>
            <div className="dialog-actions">
              <button className="btn btn-ghost" disabled={billing.busy} onClick={() => setBilling((current) => ({ ...current, confirm: null }))} type="button">キャンセル</button>
              <button autoFocus className="btn btn-primary" disabled={billing.busy} onClick={() => sendBilling(billing.confirm)} type="button">{billing.busy ? "渡しています…" : "渡す"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// 表の枠が横にスクロールできるとき、左右のどちらに続きがあるかを data-more-left / data-more-right で示す（固定した列の影に使う）
function useScrollEdges(ref, deps) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      element.toggleAttribute("data-more-left", element.scrollLeft > 1);
      element.toggleAttribute("data-more-right", max - element.scrollLeft > 1);
      // 固定した列（左の氏名・右の操作・上の見出し）の幅だけスクロールの余白を取る。
      // Tab の移動や scrollIntoView で出てくる欄が、固定した列の下に隠れたままにならないようにする（カード表示では見出しが無いので 0）
      const width = (selector) => Math.ceil(element.querySelector(selector)?.getBoundingClientRect().width || 0);
      element.style.scrollPaddingLeft = `${width("thead th.rc-col-name")}px`;
      element.style.scrollPaddingRight = `${width("thead th.rc-col-actions")}px`;
      element.style.scrollPaddingTop = `${Math.ceil(element.querySelector("thead")?.getBoundingClientRect().height || 0)}px`;
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => { element.removeEventListener("scroll", update); observer?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
}

function patientOf(item) {
  return { patientId: item.patientId, displayName: item.patientName, ...(item.patientSnapshot || {}) };
}

function MemoCell({ text, label, name, disabled, onOpen, labels = [] }) {
  const chips = labels.length ? <span className="rc-memo-labels">{labels.map((item) => <span className="rc-label-chip is-small" key={item}>{item}</span>)}</span> : null;
  const summary = [...labels, text].filter(Boolean).join(" ・ ");
  if (disabled) return <span className="rc-memo" title={summary || undefined}>{chips}{text}</span>;
  return (
    <button aria-label={`${name} の${label}${summary ? `: ${summary}` : "（なし）"}`} className="rc-cell-edit rc-memo" onClick={onOpen} title={summary || undefined} type="button">
      <span>{chips}{text || (chips ? null : <span className="muted">-</span>)}</span><span aria-hidden="true" className="rc-pencil">✎</span>
    </button>
  );
}

// 会計の列: 会計待で確定済みなら［会計］、再計待なら［再送］、送れなかったら「失敗」と再試行。
function BillingCell({ appointment, display, encounter, error, canSend, onSend }) {
  const finalized = encounter?.status === "finalized";
  if (error && canSend && finalized) {
    return <span className="rc-billing"><span className="tag tag-danger" title={error}>失敗</span><button className="btn btn-ghost btn-sm" onClick={onSend} type="button">再試行</button></span>;
  }
  if (display === "rebill_waiting") {
    return canSend && finalized ? <button className="btn btn-ghost btn-sm rc-billing-send" onClick={onSend} type="button">再送</button> : <span className="muted small">再計待</span>;
  }
  if (appointment.status === "checkout") {
    if (!encounter) return <span className="muted small">カルテなし</span>;
    if (!finalized) return <span className="muted small" title="カルテを確定すると渡せます">未確定</span>;
    return canSend ? <button className="btn btn-primary btn-sm rc-billing-send" onClick={onSend} type="button">会計</button> : null;
  }
  if (appointment.status === "done" || appointment.billingState === "handed_off") return <span className="muted small">連携済</span>;
  return null;
}

function DilationChip({ minutes }) {
  if (minutes === null) return null;
  if (minutes >= DILATION_READY_MINUTES) return <span className="flow-dilation is-ready">散瞳OK</span>;
  return (
    <span className="flow-dilation" title={`散瞳から ${minutes}分`}>
      {minutes}/{DILATION_READY_MINUTES}分
      <span className="flow-dilation-bar" aria-hidden="true"><span style={{ width: `${Math.round((minutes / DILATION_READY_MINUTES) * 100)}%` }} /></span>
    </span>
  );
}

// 絞り込み（デジカルの ▼ フィルタ）: ステータス・医師・診療科・表示する列の 4 列と、下段に患者メモ・受付メモの文字列。選ぶとすぐ反映する。
function FilterPopover({ appointments, doctors, filters, hiddenColumns, onFilters, onColumn, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (event) => {
      if (ref.current?.contains(event.target) || event.target.closest?.(".rc-filter-button")) return;
      onClose();
    };
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const counts = {};
  for (const item of appointments) counts[displayStatusOf(item)] = (counts[displayStatusOf(item)] || 0) + 1;
  const doctorIds = [...new Set([...doctors.map((doctor) => doctor.memberId), ...appointments.map((item) => item.doctorMemberId || UNSET)])];
  const departments = [...new Set(appointments.map((item) => item.department || UNSET))];
  if (!departments.includes(UNSET)) departments.push(UNSET);
  if (!doctorIds.includes(UNSET)) doctorIds.push(UNSET);

  const toggle = (field, value) => {
    const list = filters[field];
    onFilters({ ...filters, [field]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] });
  };
  const all = (field) => onFilters({ ...filters, [field]: [] });
  const none = (field, values) => onFilters({ ...filters, [field]: values });

  return (
    <>
    {/* 1100px 以下は画面に固定して出すので、背景を暗くして範囲を分かるようにする（外を押すと閉じるのは上の mousedown） */}
    <div aria-hidden="true" className="rc-filter-backdrop" />
    <div className="rc-popover rc-filter" ref={ref} role="dialog" aria-label="絞り込み">
      <div className="rc-filter-head">
        <strong>絞り込み</strong>
        <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">閉じる</button>
      </div>
      <div className="rc-filter-columns">
        <fieldset className="rc-filter-group">
          <legend>ステータス</legend>
          <div className="rc-filter-bulk">
            <button className="btn btn-ghost btn-sm" onClick={() => all("hiddenStatuses")} type="button">すべて選択</button>
            <button className="btn btn-ghost btn-sm" onClick={() => none("hiddenStatuses", [...FILTER_STATUSES])} type="button">クリア</button>
          </div>
          {FILTER_STATUSES.map((status) => (
            <label className="rc-check" key={status}>
              <input checked={!filters.hiddenStatuses.includes(status)} onChange={() => toggle("hiddenStatuses", status)} type="checkbox" />
              <span aria-hidden="true" className={`rc-dot is-${status}`} />{APPOINTMENT_STATUS_LABELS[status]}<span className="muted small">{counts[status] || 0}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="rc-filter-group">
          <legend>医師</legend>
          <div className="rc-filter-bulk">
            <button className="btn btn-ghost btn-sm" onClick={() => all("hiddenDoctors")} type="button">すべて選択</button>
            <button className="btn btn-ghost btn-sm" onClick={() => none("hiddenDoctors", doctorIds)} type="button">クリア</button>
          </div>
          {doctorIds.map((memberId) => (
            <label className="rc-check" key={memberId}>
              <input checked={!filters.hiddenDoctors.includes(memberId)} onChange={() => toggle("hiddenDoctors", memberId)} type="checkbox" />
              {memberId === UNSET ? "指定なし" : doctorName(doctors, memberId)}
            </label>
          ))}
        </fieldset>
        <fieldset className="rc-filter-group">
          <legend>診療科</legend>
          <div className="rc-filter-bulk">
            <button className="btn btn-ghost btn-sm" onClick={() => all("hiddenDepartments")} type="button">すべて選択</button>
            <button className="btn btn-ghost btn-sm" onClick={() => none("hiddenDepartments", departments)} type="button">クリア</button>
          </div>
          {departments.map((name) => (
            <label className="rc-check" key={name}>
              <input checked={!filters.hiddenDepartments.includes(name)} onChange={() => toggle("hiddenDepartments", name)} type="checkbox" />
              {name === UNSET ? "指定なし" : name}
            </label>
          ))}
        </fieldset>
        <fieldset className="rc-filter-group rc-filter-columns-list">
          <legend>表示する列</legend>
          <p className="muted small">この端末に記憶します</p>
          {RECEPTION_COLUMNS.filter((column) => !column.fixed).map((column) => (
            <label className="rc-check" key={column.key}>
              <input checked={!hiddenColumns.includes(column.key)} onChange={(event) => onColumn(column.key, !event.target.checked)} type="checkbox" />
              {column.label}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="rc-filter-text">
        <label>
          <span>患者メモ</span>
          <input className="input" onChange={(event) => onFilters({ ...filters, patientMemo: event.target.value })} placeholder="含む文字" value={filters.patientMemo} />
        </label>
        <label>
          <span>受付メモ</span>
          <input className="input" onChange={(event) => onFilters({ ...filters, receptionMemo: event.target.value })} placeholder="含む文字" value={filters.receptionMemo} />
        </label>
      </div>
    </div>
    </>
  );
}

// 患者メモ・受付メモの小さなダイアログ（テキストエリア＋［キャンセル］［登録］）
function MemoDialog({ label, note, patientName, text, onCancel, onSave }) {
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(value.trim());
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="rc-memo-heading" aria-modal="true" className="dialog rc-memo-dialog" onSubmit={submit} role="dialog">
        <h2 id="rc-memo-heading">{label}（{patientName}）</h2>
        <p className="muted small">{note}</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <textarea aria-label={label} autoFocus className="input" maxLength={1000} onChange={(event) => setValue(event.target.value)} rows={5} value={value} />
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || value.trim() === text.trim()} type="submit">登録</button>
        </div>
      </form>
    </div>
  );
}

function progressChips(encounter) {
  return [
    ["視", encounter.exam?.va ? "done" : "todo"],
    ["圧", encounter.exam?.iop ? "done" : "todo"],
    ...(encounter.orders || []).map((order) => [order.name, order.status === "performed" ? "done" : "todo"])
  ];
}

function downloadCsv(data, name) {
  const url = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 検査の進み具合（視力・眼圧・オーダー）と散瞳。値そのものは出さず、済んだかどうかだけを出す（診察の一覧でも使う）
export function progressOf(appointment, encounter, now) {
  if (!IN_CLINIC.includes(appointment.status) || !encounter) return null;
  const chips = progressChips(encounter);
  const dilation = encounter.dilationStartedAt ? minutesSince(encounter.dilationStartedAt, now) : null;
  return (
    <>
      {chips.map(([label, state], index) => (
        <span className={`flow-step is-${state}`} key={`${label}${index}`} title={`${label}: ${state === "done" ? "済" : "未"}`}>{label}{state === "done" ? "✓" : "・"}</span>
      ))}
      {dilation !== null ? (
        dilation >= DILATION_READY_MINUTES
          ? <span className="flow-dilation is-ready">散瞳OK</span>
          : (
            <span className="flow-dilation" title={`散瞳から ${dilation}分`}>
              散瞳 {dilation}/{DILATION_READY_MINUTES}分
              <span className="flow-dilation-bar" aria-hidden="true"><span style={{ width: `${Math.round((dilation / DILATION_READY_MINUTES) * 100)}%` }} /></span>
            </span>
          )
      ) : null}
    </>
  );
}

export function formatClock(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" });
}
