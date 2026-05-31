"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { getGatewayBaseUrl, getGatewayWsUrl } from "../lib/runtime-config";
import { fetchWithOperatorAuth, getCurrentOperatorSession, useOperatorAccess } from "../lib/operator-access";
import { loadStoredPairing, storePairing } from "../lib/pairing-session";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";
import { createBrowserAudioSource, getOrCreateStoredDeviceId, TARGET_SAMPLE_RATE } from "../lib/browser-audio-source";
import { buildAudioInputConstraints, readAudioInputPreference } from "../lib/audio-input-preferences";
import { AdminSelect } from "./admin-select";
import { Icon } from "./icon";
import { OperatorLoginPanel } from "./operator-login-panel";

const LOCAL_RECORDER_DEVICE_ID_STORAGE_KEY = "soaplane.localRecorder.deviceId";

function buildPairingUrl(pairingId, token) {
  if (!pairingId || !token || typeof window === "undefined") return "";
  return `${window.location.origin}/mobile/join#pairingId=${encodeURIComponent(pairingId)}&token=${encodeURIComponent(token)}`;
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildFallbackHighlightsFromText(text) {
  const items = [];
  if (text.includes("咳")) items.push({ label: "咳" });
  if (text.includes("熱")) items.push({ label: "発熱" });
  if (text.includes("血圧")) items.push({ label: "血圧" });
  return items;
}

function buildFallbackHighlights(turns) {
  return buildFallbackHighlightsFromText(turns.map((t) => t.text).join(" "));
}

const EMPTY_REVIEW_DRAFT = {
  transcript: "",
  outputText: ""
};

const EMPTY_PATIENT_INFO_DRAFT = {
  patientId: "",
  facilityId: "",
  departmentId: "",
  patientDisplayName: "",
  visitReason: ""
};
const OPTIONAL_SELECT_NONE_VALUE = "__none__";

const FINALIZING_SESSION_POLL_INTERVAL_MS = 1000;
const AUDIO_ACTIVITY_HOLD_MS = 900;
const AUDIO_ACTIVITY_LEVEL_THRESHOLD = 6;

function buildReviewDraft(soap, liveTranscript = "") {
  return {
    transcript: soap?.structuredJson?.finalTranscript || liveTranscript,
    outputText: buildSoapOutputText(soap)
  };
}

function buildSoapOutputText(soap) {
  if (!soap) {
    return "";
  }

  if (soap.outputText || soap.output_text || soap.structuredJson?.outputText) {
    return soap.outputText || soap.output_text || soap.structuredJson.outputText;
  }

  return [
    soap.subjective ? `S\n${soap.subjective}` : "",
    soap.objective ? `O\n${soap.objective}` : "",
    soap.assessment ? `A\n${soap.assessment}` : "",
    soap.plan ? `P\n${soap.plan}` : ""
  ].filter(Boolean).join("\n\n").trim();
}

function buildAiTranscript(soap, liveTranscript = "") {
  return (
    soap?.structuredJson?.rawFinalTranscript ||
    soap?.structuredJson?.finalTranscript ||
    liveTranscript
  );
}

function buildLiveTranscript(turns) {
  return turns.map((turn) => turn.text.trim()).filter(Boolean).join("\n");
}

function reviewDraftEquals(left, right) {
  return (
    left.transcript === right.transcript &&
    left.outputText === right.outputText
  );
}

function optionalSelectValue(value) {
  return value || OPTIONAL_SELECT_NONE_VALUE;
}

function optionalSelectToDraftValue(value) {
  return value === OPTIONAL_SELECT_NONE_VALUE ? "" : value;
}

function compactPatientAliases(patient) {
  const aliases = [
    patient?.patientId,
    patient?.patientCode,
    patient?.patientRef,
    patient?.displayNameKana,
    patient?.kana,
    patient?.externalPatientId,
    ...(Array.isArray(patient?.externalPatientIds) ? patient.externalPatientIds : []),
    ...(Array.isArray(patient?.aliases) ? patient.aliases : [])
  ];

  return aliases.map((item) => String(item || "").trim()).filter(Boolean);
}

function patientOptionDescription(patient) {
  const aliases = compactPatientAliases(patient).filter((item) => item !== patient?.patientId);
  return [patient?.patientId, aliases[0]].filter(Boolean).join(" / ");
}

function PatientSearchSelect({ id, patients, value, disabled, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedPatient = patients.find((patient) => patient.patientId === value) || null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredPatients = normalizedQuery
    ? patients.filter((patient) => {
        const haystack = [
          patient.displayName,
          ...compactPatientAliases(patient)
        ].join(" ").toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : patients.slice(0, 12);
  const visiblePatients = filteredPatients.slice(0, 12);

  function selectPatient(patient) {
    onChange(patient?.patientId || "", patient || null);
    setQuery("");
    setIsOpen(false);
  }

  return (
    <div
      className={`patient-search-select ${disabled ? "patient-search-select--disabled" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setIsOpen(false);
          setQuery("");
        }
      }}
    >
      <div className={`patient-search-control admin-select-trigger ${isOpen ? "patient-search-control--open" : ""}`}>
        <input
          id={id}
          type="search"
          value={isOpen ? query : selectedPatient?.displayName || ""}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            setQuery("");
            setIsOpen(true);
          }}
          placeholder={selectedPatient ? "患者名・患者IDで検索" : "患者名・患者IDで検索"}
          disabled={disabled}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={isOpen}
        />
        {selectedPatient && !disabled ? (
          <button
            className="patient-search-clear"
            type="button"
            aria-label="患者選択を解除"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectPatient(null)}
          >
            <Icon name="x" size={14} />
          </button>
        ) : (
          <span className="admin-select-affordance" aria-hidden="true">
            <span className="admin-select-chevron" />
          </span>
        )}
      </div>
      {selectedPatient ? (
        <span className="patient-search-selected-meta">{patientOptionDescription(selectedPatient)}</span>
      ) : null}
      {isOpen && !disabled ? (
        <div className="patient-search-menu">
          <button
            className={`patient-search-item ${!value ? "patient-search-item--selected" : ""}`}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectPatient(null)}
          >
            <span>患者を選択しない</span>
            <small>患者名だけを手入力する場合はこちら</small>
          </button>
          {visiblePatients.map((patient) => (
            <button
              className={`patient-search-item ${patient.patientId === value ? "patient-search-item--selected" : ""}`}
              key={patient.patientId}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectPatient(patient)}
            >
              <span>{patient.displayName}</span>
              <small>{patientOptionDescription(patient)}</small>
            </button>
          ))}
          {patients.length === 0 ? (
            <div className="patient-search-empty">登録済み患者はまだ登録されていません。</div>
          ) : visiblePatients.length === 0 ? (
            <div className="patient-search-empty">該当する患者が見つかりません。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getTranscriptStateCard({ status, mobileConnectionState, audioSourceType, selectedRecordingMode, localRecorderState, hasTranscript, partial, error, isStalled, hasAudioActivity }) {
  if (error) {
    return {
      tone: "danger",
      title: "エラーが発生しました",
      body: error
    };
  }

  if (status === "degraded_recording") {
    return {
      tone: "warning",
      title: "録音が止まりました",
      body: audioSourceType === "local_browser"
        ? "このパソコンの録音接続が切れた可能性があります。再開できない場合は、録音を破棄して録り直してください。"
        : "スマホ接続が切れた可能性があります。スマホの画面を開いたまま再接続し、マイク準備完了を確認してから録音を再開してください。"
    };
  }

  if (status === "stopped") {
    return {
      tone: "neutral",
      title: "録音が終了しました",
      body: "患者名や症状を確認してから、SOAP下書きを作成できます。"
    };
  }

  if (hasTranscript || partial) {
    if (status === "recording" && isStalled) {
      return {
        tone: "warning",
        title: "音声入力がまだ届いていません",
        body: audioSourceType === "local_browser"
          ? "録音開始後しばらく書き起こしが増えていません。この端末のマイク許可と入力レベルを確認してください。"
          : "録音開始後しばらく書き起こしが増えていません。スマホの画面が開いたままか、マイクが有効かを確認してください。"
      };
    }

    return null;
  }

  if (audioSourceType === "local_browser" && localRecorderState === "ready") {
    return {
      tone: "success",
      title: "このパソコンのマイク準備完了",
      body: "このパソコンのマイクで録音を開始できます。"
    };
  }

  if (["ready", "paired"].includes(status) && selectedRecordingMode === "local") {
    return {
      tone: "neutral",
      title: "このパソコンで録音を選択中",
      body: "下部の「このパソコンで録音」を押すと録音を開始します。"
    };
  }

  if (["ready", "paired"].includes(status) && selectedRecordingMode === "mobile") {
    return {
      tone: mobileConnectionState === "disconnected" ? "neutral" : "success",
      title: mobileConnectionState === "disconnected" ? "スマホ接続待ち" : "スマホ録音を選択中",
      body: mobileConnectionState === "disconnected"
        ? "QRをスマホで読み取り、録音用スマホとして接続してください。"
        : "スマホのマイク準備ができたら、スマホまたはこの画面から録音を開始できます。"
    };
  }

  if (status === "ready") {
    return {
      tone: "neutral",
      title: "録音方法を選んでください",
      body: "スマホで録音するか、このパソコンで録音できます。"
    };
  }

  if (mobileConnectionState === "connected") {
    return {
      tone: "neutral",
      title: "マイクの準備待ち",
      body: "スマホでマイクを有効にすると、パソコンとスマホのどちらからでも録音を開始できます。"
    };
  }

  if (mobileConnectionState === "mic_ready" && ["paired", "ready", "degraded_recording"].includes(status)) {
    return {
      tone: "success",
      title: "録音開始待ち",
      body: "マイク準備ができています。パソコンかスマホから録音を開始してください。"
    };
  }

  if (status === "recording") {
    if (hasAudioActivity) {
      return {
        tone: "neutral",
        title: "書き起こし準備中",
        activity: "listening"
      };
    }

    return {
      tone: isStalled ? "warning" : "neutral",
      title: isStalled ? "音声入力がまだ届いていません" : "録音中",
      body: isStalled
        ? audioSourceType === "local_browser"
          ? "録音は始まっていますが、まだ書き起こしが表示されていません。この端末のマイク入力を確認してください。"
          : "録音は始まっていますが、まだ書き起こしが表示されていません。スマホのマイクと接続状態を確認してください。"
        : "話し始めると書き起こしが表示されます。"
    };
  }

  return {
    tone: "neutral",
    title: "書き起こし待ち",
    body: "録音を開始すると、ここに書き起こしが表示されます。"
  };
}

function getTranscriptMode(status) {
  if (status === "stopped") {
    return "stopped";
  }

  if (["finalizing", "soap_ready", "approved"].includes(status)) {
    return "review";
  }

  return "live";
}

function getTranscriptBadgeMeta({ status, mobileConnectionState, reviewDirty, reviewEdited }) {
  if (status === "recording") {
    return { tone: "live", label: "リアルタイム" };
  }

  if (status === "degraded_recording") {
    return { tone: "warning", label: "接続不安定" };
  }

  if (status === "stopped") {
    return { tone: "stopped", label: "録音完了" };
  }

  if (status === "finalizing") {
    return { tone: "processing", label: "処理中" };
  }

  if (status === "approved") {
    return { tone: "reviewed", label: "医師確認済み" };
  }

  if (status === "soap_ready") {
    if (reviewDirty) {
      return { tone: "editing", label: "確認中" };
    }

    if (reviewEdited) {
      return { tone: "reviewed", label: "医師確認済み" };
    }

    return { tone: "ai", label: "AIで整理済み" };
  }

  if (mobileConnectionState === "mic_ready") {
    return { tone: "neutral", label: "録音開始待ち" };
  }

  if (mobileConnectionState === "connected") {
    return { tone: "neutral", label: "マイク準備待ち" };
  }

  return { tone: "neutral", label: "準備中" };
}

function TranscriptModeBadge({ tone, label }) {
  const icon = tone === "processing"
    ? <span className="transcript-mode-badge__spinner" aria-hidden="true" />
    : tone === "reviewed"
      ? <Icon name="checkCircle" size={12} />
      : tone === "ai" || tone === "stopped"
        ? <Icon name="check" size={12} />
        : tone === "editing"
          ? <Icon name="edit" size={12} />
          : tone === "warning"
            ? <Icon name="alertCircle" size={12} />
            : <span className={`transcript-mode-badge__dot ${tone === "live" ? "transcript-mode-badge__dot--pulse" : ""}`} aria-hidden="true" />;

  return (
    <span className={`transcript-mode-badge transcript-mode-badge--${tone}`}>
      <span className="transcript-mode-badge__icon">{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function formatPromptScope(scope) {
  return {
    organization: "病院標準",
    facility: "施設別",
    department: "診療科別",
    member: "医師個人"
  }[scope] || "プロンプト";
}

function getPromptOptionId(option) {
  return option?.formatId || option?.profileId || "";
}

function getPromptLockReason(status, soap) {
  if (status === "recording") {
    return "録音中は変更できません。録音停止後、SOAP下書き作成前に変更できます。";
  }

  if (status === "finalizing") {
    return soap ? "SOAP下書きの再作成中です。" : "SOAP下書き作成中は変更できません。";
  }

  if (status === "approved" || soap?.status === "approved") {
    return "確定済みの記録では変更できません。";
  }

  return "";
}

export function EncounterWorkspace({ sessionId, initialPairingId, initialPairingToken }) {
  const { accessToken, isHydrated, setAccessToken, clearAccess } = useOperatorAccess();
  const [sessionState, setSessionState] = useState(null);
  const [operatorSession, setOperatorSession] = useState(null);
  const [partial, setPartial] = useState("");
  const [highlights, setHighlights] = useState([]);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [showApproved, setShowApproved] = useState(false);
  const [pairingQrUrl, setPairingQrUrl] = useState("");
  const [pairingMeta, setPairingMeta] = useState({
    pairingId: initialPairingId,
    token: initialPairingToken
  });
  const [reviewDraft, setReviewDraft] = useState(EMPTY_REVIEW_DRAFT);
  const [reviewBaseline, setReviewBaseline] = useState(EMPTY_REVIEW_DRAFT);
  const [reviewSaveState, setReviewSaveState] = useState("idle");
  const [toasts, setToasts] = useState([]);
  const [confirmApproval, setConfirmApproval] = useState(false);
  const [confirmReviewReset, setConfirmReviewReset] = useState(false);
  const [pairingOverlayManuallyOpen, setPairingOverlayManuallyOpen] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingStall, setRecordingStall] = useState(false);
  const [audioActivityActive, setAudioActivityActive] = useState(false);
  const [layoutMode, setLayoutMode] = useState("split"); // split | soap | stacked
  const [showPatientInfo, setShowPatientInfo] = useState(false);
  const [patientInfoDraft, setPatientInfoDraft] = useState(EMPTY_PATIENT_INFO_DRAFT);
  const [patientInfoBaseline, setPatientInfoBaseline] = useState(EMPTY_PATIENT_INFO_DRAFT);
  const [patientInfoSaveState, setPatientInfoSaveState] = useState("idle");
  const [patientInfoMessage, setPatientInfoMessage] = useState("");
  const [corePatients, setCorePatients] = useState([]);
  const [coreFacilities, setCoreFacilities] = useState([]);
  const [coreDepartments, setCoreDepartments] = useState([]);
  const [promptOptions, setPromptOptions] = useState([]);
  const [promptOptionsLoading, setPromptOptionsLoading] = useState(false);
  const [promptOptionsError, setPromptOptionsError] = useState("");
  const [promptSelectionSaving, setPromptSelectionSaving] = useState(false);
  const [confirmPromptChange, setConfirmPromptChange] = useState(false);
  const [pendingPromptChangeId, setPendingPromptChangeId] = useState("");
  const [postStopPromptId, setPostStopPromptId] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [confirmStopRecording, setConfirmStopRecording] = useState(false);
  const [confirmDiscardRecording, setConfirmDiscardRecording] = useState(false);
  const [discardRecordingReturnTarget, setDiscardRecordingReturnTarget] = useState(null);
  const [postStopModalMode, setPostStopModalMode] = useState(null);
  const [recordingChoiceDismissed, setRecordingChoiceDismissed] = useState(false);
  const [recordingChoiceManuallyOpen, setRecordingChoiceManuallyOpen] = useState(false);
  const [recordingSetupMode, setRecordingSetupMode] = useState(null); // null | local | mobile
  const [localRecorderDeviceId, setLocalRecorderDeviceId] = useState("");
  const [localRecorderState, setLocalRecorderState] = useState("idle"); // idle | preparing | ready | recording | interrupted | failed
  const [localRecorderLevel, setLocalRecorderLevel] = useState(0);
  const [localRecorderMessage, setLocalRecorderMessage] = useState("");
  const wsRef = useRef(null);
  const recorderWsRef = useRef(null);
  const transcriptScrollRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const soapOutputTextareaRef = useRef(null);
  const previousStreamingSoapPreviewRef = useRef(false);
  const postStopModalCardRef = useRef(null);
  const wsReconnectTimerRef = useRef(null);
  const wsReconnectAttemptsRef = useRef(0);
  const reviewDraftRef = useRef(EMPTY_REVIEW_DRAFT);
  const localAudioSourceRef = useRef(null);
  const localRecorderStreamingRef = useRef(false);
  const localRecorderConnectPromiseRef = useRef(null);
  const trustedAssignAttemptRef = useRef(false);
  const autoOpenedMobilePairingRef = useRef(false);
  const patientInfoVisibilityTouchedRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const reviewSaveStateRef = useRef("idle");
  const previousStatusRef = useRef(null);
  const finalizingPollInFlightRef = useRef(false);
  const audioActivityActiveRef = useRef(false);
  const audioActivityTimerRef = useRef(null);
  const patientInfoNameInputRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const toastExitTimersRef = useRef(new Map());

  function addToast(message, variant = "default") {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, variant }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(id);
      dismissToast(id);
    }, 2800);
    toastTimersRef.current.set(id, timer);
  }

  function dismissToast(id) {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }

    const exitTimer = toastExitTimersRef.current.get(id);
    if (exitTimer) {
      clearTimeout(exitTimer);
    }

    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    const nextExitTimer = setTimeout(() => {
      toastExitTimersRef.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 220);
    toastExitTimersRef.current.set(id, nextExitTimer);
  }

  function setReviewDraftState(nextValueOrUpdater) {
    setReviewDraft((current) => {
      const next = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;
      reviewDraftRef.current = next;
      return next;
    });
  }

  function dismissRecordingChoice() {
    setRecordingChoiceDismissed(true);
    setRecordingChoiceManuallyOpen(false);
  }

  function openRecordingChoice() {
    setRecordingChoiceManuallyOpen(true);
  }

  function clearAudioActivity() {
    if (audioActivityTimerRef.current) {
      clearTimeout(audioActivityTimerRef.current);
      audioActivityTimerRef.current = null;
    }
    audioActivityActiveRef.current = false;
    setAudioActivityActive(false);
  }

  function markAudioActivity(holdMs = AUDIO_ACTIVITY_HOLD_MS) {
    if (audioActivityTimerRef.current) {
      clearTimeout(audioActivityTimerRef.current);
    }

    if (!audioActivityActiveRef.current) {
      audioActivityActiveRef.current = true;
      setAudioActivityActive(true);
    }

    audioActivityTimerRef.current = setTimeout(() => {
      audioActivityTimerRef.current = null;
      audioActivityActiveRef.current = false;
      setAudioActivityActive(false);
    }, holdMs);
  }

  const status = sessionState?.session?.status || "loading";
  const sessionErrorMessage = sessionState?.session?.errorMessageSafe || "";
  const visibleError = error || sessionErrorMessage;
  const recordingExpiresAtMs = Date.parse(sessionState?.session?.recordingExpiresAt || "");
  const recordingRemainingMs = status === "recording" && Number.isFinite(recordingExpiresAtMs)
    ? Math.max(0, recordingExpiresAtMs - Date.now())
    : null;
  const showRecordingExpiryWarning = recordingRemainingMs !== null && recordingRemainingMs <= 5 * 60 * 1000;
  const mobileConnectionState = sessionState?.session?.mobileConnectionState || "disconnected";
  const audioSourceType = sessionState?.session?.audioSourceType || null;
  const audioConnectionState = sessionState?.session?.audioConnectionState || mobileConnectionState;
  const selectedRecordingMode =
    audioSourceType === "local_browser"
      ? "local"
      : audioSourceType === "linked_mobile"
        ? "mobile"
        : recordingSetupMode;
  const isLocalRecordingMode = selectedRecordingMode === "local";
  const isMobileRecordingMode = selectedRecordingMode === "mobile";
  const turns = sessionState?.turns || [];
  const liveTranscript = useMemo(() => buildLiveTranscript(turns), [turns]);
  const fallbackHighlights = useMemo(
    () => buildFallbackHighlightsFromText(liveTranscript.replaceAll("\n", " ")),
    [liveTranscript]
  );
  const effectiveHighlights = highlights.length ? highlights : fallbackHighlights;
  const pairingUrl = buildPairingUrl(pairingMeta.pairingId, pairingMeta.token);
  const soap = sessionState?.latestSoap;
  const soapGenerationPreview = String(sessionState?.session?.soapGenerationPreview || "");
  const isStreamingSoapPreview = status === "finalizing" && Boolean(soapGenerationPreview.trim());
  const reviewReady = Boolean(soap);
  const reviewDirty = reviewReady && !reviewDraftEquals(reviewDraft, reviewBaseline);
  const hasReviewDraftForCurrentSoap = Boolean(
    reviewBaseline.transcript ||
    reviewBaseline.outputText ||
    reviewDraft.transcript ||
    reviewDraft.outputText
  );
  const patientInfoDirty =
    patientInfoDraft.patientId !== patientInfoBaseline.patientId ||
    patientInfoDraft.facilityId !== patientInfoBaseline.facilityId ||
    patientInfoDraft.departmentId !== patientInfoBaseline.departmentId ||
    patientInfoDraft.patientDisplayName !== patientInfoBaseline.patientDisplayName ||
    patientInfoDraft.visitReason !== patientInfoBaseline.visitReason;
  const aiTranscript = useMemo(() => buildAiTranscript(soap, liveTranscript), [soap, liveTranscript]);
  const finalTranscript = reviewReady
    ? hasReviewDraftForCurrentSoap
      ? reviewDraft.transcript
      : aiTranscript
    : "";
  const hasFinalTranscript = Boolean(finalTranscript?.trim());
  const shouldShowFinalTranscript = reviewReady && (
    hasFinalTranscript ||
    hasReviewDraftForCurrentSoap ||
    Boolean(aiTranscript?.trim())
  );
  const transcriptMode = getTranscriptMode(status);
  const reviewEdited = Boolean(soap?.structuredJson?.manualReview?.editedAt || status === "approved");
  const transcriptVersionLabel = reviewReady
    ? reviewEdited
      ? "医師確認済みの書き起こし"
      : "AIで整理した書き起こし"
    : status === "recording"
      ? "リアルタイム書き起こし（速報）"
      : "書き起こし";
  const transcriptBadge = getTranscriptBadgeMeta({
    status,
    mobileConnectionState,
    reviewDirty,
    reviewEdited
  });
  const hasTranscript = Boolean(turns.length || partial || aiTranscript);
  const shouldShowPendingTurn =
    status === "recording" &&
    audioActivityActive &&
    turns.length > 0 &&
    !partial;
  const transcriptStateCard = getTranscriptStateCard({
    status,
    mobileConnectionState,
    audioSourceType,
    selectedRecordingMode,
    localRecorderState,
    hasTranscript,
    partial,
    error: visibleError,
    isStalled: recordingStall,
    hasAudioActivity: audioActivityActive
  });
  const canStartMobileRecording =
    ["ready", "paired", "degraded_recording", "stopped", "soap_ready", "approved"].includes(status) &&
    mobileConnectionState === "mic_ready" &&
    !isLocalRecordingMode;
  const canStartLocalRecording =
    ["ready", "paired", "degraded_recording", "stopped", "soap_ready", "approved"].includes(status) &&
    !isMobileRecordingMode;
  const canOpenMobileRecordingSetup =
    ["ready", "paired", "degraded_recording", "stopped", "soap_ready", "approved"].includes(status) &&
    !isLocalRecordingMode;
  const shouldPromptRecordingMethod =
    ["ready", "paired", "degraded_recording"].includes(status) &&
    !selectedRecordingMode &&
    !turns.length &&
    !soap &&
    !recordingChoiceDismissed;
  const canChangeRecordingSource =
    ["ready", "paired", "degraded_recording"].includes(status) &&
    !turns.length &&
    !soap;
  const shouldShowRecordingChoice = shouldPromptRecordingMethod || recordingChoiceManuallyOpen;
  const isLocalAudioSource = audioSourceType === "local_browser";
  const patientInfoLocked = status === "finalizing";
  const hasSavedPatientInfo = Boolean(
    sessionState?.session?.patientId ||
    sessionState?.session?.facilityId ||
    sessionState?.session?.departmentId ||
    sessionState?.session?.patientDisplayName ||
    sessionState?.session?.visitReason
  );
  const currentPromptProfile = sessionState?.promptProfile || null;
  const currentPromptId = sessionState?.session?.promptProfileId || currentPromptProfile?.profileId || "system-default";
  const currentPromptName = currentPromptProfile?.displayName || "標準SOAPフォーマット";
  const currentPromptScope = formatPromptScope(currentPromptProfile?.scope || "organization");
  const hasSoapDraft = Boolean(soap);
  const canAppendRecording =
    ["stopped", "soap_ready", "approved"].includes(status) &&
    !isBusy &&
    !reviewDirty &&
    reviewSaveState !== "saving";
  const promptLockReason = getPromptLockReason(status, soap);
  const isRegeneratingSoap = status === "finalizing" && Boolean(soap);
  const regeneratePromptLockReason =
    status === "approved"
      ? "確定済みの記録は再作成できません。"
      : status === "finalizing"
        ? "SOAP下書きの再作成中です。"
        : reviewDirty
          ? "未保存の変更を保存してから再作成してください。"
          : "";
  const canRegenerateSoap = Boolean(soap) && ["soap_ready", "stopped"].includes(status) && !regeneratePromptLockReason;
  const promptSelectionLocked = !soap && Boolean(promptLockReason);
  const promptToolbarSelectionId = pendingPromptChangeId || currentPromptId;
  const promptToolbarDisabled =
    promptSelectionSaving ||
    (hasSoapDraft
      ? status === "approved" || status === "finalizing"
      : promptSelectionLocked);
  const promptToolbarOptions = (
    promptOptions.length
      ? promptOptions
      : [{
          profileId: currentPromptId,
          displayName: currentPromptName,
          scope: currentPromptProfile?.scope || "organization",
          latestVersion: currentPromptProfile?.latestVersion || null
        }]
  ).map((option) => ({
    value: getPromptOptionId(option),
    label: option.displayName,
    description: `${formatPromptScope(option.scope)}${option.latestVersion?.version ? ` / v${option.latestVersion.version}` : ""}`
  }));
  const postStopPromptSelectionId = postStopPromptId || currentPromptId;
  const currentSoapOutputText = isStreamingSoapPreview
    ? soapGenerationPreview
    : reviewReady
      ? hasReviewDraftForCurrentSoap
      ? reviewDraft.outputText
      : buildSoapOutputText(soap)
      : buildSoapOutputText(soap);

  async function loadSession() {
    const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions/${sessionId}`, {
      cache: "no-store",
    }, accessToken);
    if (!response.ok) {
      if (response.status === 401) {
        clearAccess();
      }
      throw new Error("セッション情報を取得できませんでした。");
    }
    const data = await response.json();
    applySessionStateData(data);
    return data;
  }

  async function loadCoreMasterData() {
    const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/core/bootstrap`, {
      cache: "no-store"
    }, accessToken);

    if (response.status === 401) {
      clearAccess();
      return;
    }
    if (!response.ok) {
      throw new Error("登録済み患者・施設情報を取得できませんでした。");
    }

    applyCoreMasterData(await response.json());
  }

  async function loadSessionBootstrap() {
    const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions/${sessionId}/bootstrap`, {
      cache: "no-store"
    }, accessToken);

    if (!response.ok) {
      if (response.status === 401) {
        clearAccess();
      }
      throw new Error("セッション情報を取得できませんでした。");
    }

    const payload = await response.json();
    applySessionStateData(payload.sessionState);
    applyCoreMasterData(payload.core);
    applyPromptOptionsData(payload.promptOptions);
    return payload.sessionState;
  }

  function applySessionStateData(data = {}) {
    setSessionState(data);
    setPartial(data.session?.status === "recording" ? data.session.latestPartialPreview || "" : "");
    if (!highlights.length && data.turns?.length) {
      setHighlights(buildFallbackHighlights(data.turns));
    }
  }

  function applyCoreMasterData(data = {}) {
    setCorePatients(data.patients || []);
    setCoreFacilities(data.facilities || []);
    setCoreDepartments(data.departments || []);
  }

  function applyPromptOptionsData(payload = {}) {
    setPromptOptions(payload.options || []);
    if (payload.promptProfile) {
      setSessionState((current) => current
        ? {
            ...current,
            promptProfile: payload.promptProfile
          }
        : current);
    }
  }

  useEffect(() => {
    const storedPairing = loadStoredPairing(sessionId);

    if (storedPairing?.pairingId && storedPairing?.token) {
      setPairingMeta(storedPairing);
    }
  }, [sessionId]);

  useEffect(() => {
    setLocalRecorderDeviceId(getOrCreateStoredDeviceId(LOCAL_RECORDER_DEVICE_ID_STORAGE_KEY, "local"));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const saved = window.localStorage.getItem("medical.workspace.layoutMode");
    if (saved === "split" || saved === "soap" || saved === "stacked") {
      setLayoutMode(saved);
    } else {
      // migrate from old narrowMode flag
      const legacy = window.localStorage.getItem("medical.workspace.narrowMode");
      if (legacy === "1") setLayoutMode("stacked");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("medical.workspace.layoutMode", layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    trustedAssignAttemptRef.current = false;
    autoOpenedMobilePairingRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!accessToken) {
      setOperatorSession(null);
      return;
    }

    let cancelled = false;

    getCurrentOperatorSession(accessToken)
      .then((currentSession) => {
        if (!cancelled) {
          setOperatorSession(currentSession?.authenticated ? currentSession.session || null : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOperatorSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    loadSessionBootstrap().catch((e) => setError(toUserFacingErrorMessage(e, "診療画面の準備に失敗しました。しばらくしてからもう一度お試しください。")));
  }, [sessionId, accessToken]);

  useEffect(() => {
    if (coreFacilities.length !== 1) {
      return;
    }

    const onlyFacility = coreFacilities[0];
    if (!onlyFacility?.facilityId) {
      return;
    }

    setPatientInfoDraft((current) => {
      if (current.facilityId) {
        return current;
      }

      const nextDepartments = coreDepartments.filter((department) => !department.facilityId || department.facilityId === onlyFacility.facilityId);
      return {
        ...current,
        facilityId: onlyFacility.facilityId,
        departmentId: current.departmentId && nextDepartments.some((department) => department.departmentId === current.departmentId)
          ? current.departmentId
          : ""
      };
    });
  }, [coreFacilities, coreDepartments]);

  useEffect(() => {
    if (!accessToken || status !== "finalizing") {
      return undefined;
    }

    let cancelled = false;

    // Cloud Tasks finalization can complete on a different Cloud Run instance than the one
    // holding this page's WebSocket, so poll the Firestore-backed session while processing.
    const pollFinalizingSession = async () => {
      if (cancelled || finalizingPollInFlightRef.current) {
        return;
      }

      finalizingPollInFlightRef.current = true;
      try {
        const data = await loadSession();
        if (!cancelled && data?.session?.status !== "finalizing") {
          setError("");
        }
      } catch {
        // Keep the existing processing UI. A later poll or the stale-finalize recovery path can settle it.
      } finally {
        finalizingPollInFlightRef.current = false;
      }
    };

    const interval = window.setInterval(pollFinalizingSession, FINALIZING_SESSION_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [accessToken, sessionId, status]);

  useEffect(() => {
    const nextDraft = {
      patientId: sessionState?.session?.patientId || "",
      facilityId: sessionState?.session?.facilityId || "",
      departmentId: sessionState?.session?.departmentId || "",
      patientDisplayName: sessionState?.session?.patientDisplayName || "",
      visitReason: sessionState?.session?.visitReason || ""
    };

    setPatientInfoBaseline(nextDraft);
    setPatientInfoDraft((current) => (patientInfoDirty ? current : nextDraft));

    if (!patientInfoDirty) {
      setPatientInfoSaveState("saved");
      setPatientInfoMessage(hasSavedPatientInfo ? "保存済み" : "");
    }

  }, [
    sessionState?.session?.patientId,
    sessionState?.session?.facilityId,
    sessionState?.session?.departmentId,
    sessionState?.session?.patientDisplayName,
    sessionState?.session?.visitReason,
    hasSavedPatientInfo,
    patientInfoDirty
  ]);

  useEffect(() => {
    if (audioSourceType === "local_browser") {
      setRecordingSetupMode("local");
      setPairingOverlayManuallyOpen(false);
      return;
    }

    if (audioSourceType === "linked_mobile") {
      setRecordingSetupMode("mobile");
    }
  }, [audioSourceType]);

  useEffect(() => {
    if (autoOpenedMobilePairingRef.current || !sessionState) {
      return;
    }

    if (!["ready", "paired", "degraded_recording"].includes(status)) {
      return;
    }

    if (audioSourceType !== "linked_mobile") {
      return;
    }

    if (sessionState.session.mobileConnectionState !== "disconnected") {
      return;
    }

    if (turns.length > 0 || soap) {
      return;
    }

    autoOpenedMobilePairingRef.current = true;
    dismissRecordingChoice();
    setRecordingSetupMode("mobile");
    setPairingOverlayManuallyOpen(true);
  }, [sessionState, status, audioSourceType, turns.length, soap]);

  useEffect(() => {
    if (!accessToken || !sessionState || trustedAssignAttemptRef.current || !recordingChoiceDismissed || !pairingOverlayManuallyOpen) {
      return;
    }

    if (
      sessionState.session.status !== "ready" ||
      sessionState.session.mobileConnectionState !== "disconnected" ||
      turns.length > 0
    ) {
      return;
    }

    trustedAssignAttemptRef.current = true;

    postAction(`/api/v1/sessions/${sessionId}/assign-recorder`, {})
      .then(() => {
        addToast("待機中のスマホへ接続を送信しました", "success");
      })
      .catch((nextError) => {
        if (!/待機中のスマホ/.test(nextError.message) && !/複数/.test(nextError.message)) {
          setError(toUserFacingErrorMessage(nextError, "診療画面の準備に失敗しました。しばらくしてからもう一度お試しください。"));
        }
      });
  }, [accessToken, sessionState, sessionId, turns.length, recordingChoiceDismissed, pairingOverlayManuallyOpen]);

  useEffect(() => {
    if (!soap) {
      setReviewDraftState(EMPTY_REVIEW_DRAFT);
      setReviewBaseline(EMPTY_REVIEW_DRAFT);
      setReviewSaveState("idle");
      return;
    }

    const nextDraft = buildReviewDraft(soap, liveTranscript);

    setReviewBaseline(nextDraft);
    setReviewDraftState((current) => (reviewDirty ? current : nextDraft));

    if (!reviewDirty) {
      setReviewSaveState("saved");
    }

  }, [soap?.versionId, soap?.updatedAt, reviewDirty, liveTranscript]);

  useEffect(() => {
    if (status === "stopped" && previousStatusRef.current !== "stopped") {
      setPostStopModalMode("choice");
    }

    if (status !== "stopped") {
      setPostStopModalMode(null);
      setConfirmStopRecording(false);
      setDiscardRecordingReturnTarget(null);
      setPostStopPromptId("");
    }

    previousStatusRef.current = status;
  }, [status, soap]);

  useEffect(() => {
    if (postStopModalMode === "choice" && !promptOptions.length && !promptOptionsLoading) {
      void loadPromptOptions();
    }
  }, [postStopModalMode, promptOptions.length, promptOptionsLoading]);

  useEffect(() => {
    if (["recording", "finalizing"].includes(status)) {
      setPairingOverlayManuallyOpen(false);
    }
  }, [status]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    function connectWs() {
      const ws = new WebSocket(getGatewayWsUrl());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        wsReconnectAttemptsRef.current = 0;
        ws.send(JSON.stringify({ type: "auth.hello", role: "pc", sessionId, token: accessToken }));
      });

      ws.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "session.state.updated") {
          setSessionState((c) =>
            c
              ? {
                  ...c,
                  session: {
                    ...c.session,
                    status: data.status,
                    mobileConnectionState: data.mobileConnectionState,
                    audioSourceType: Object.prototype.hasOwnProperty.call(data, "audioSourceType") ? data.audioSourceType : c.session.audioSourceType ?? null,
                    audioConnectionState: Object.prototype.hasOwnProperty.call(data, "audioConnectionState") ? data.audioConnectionState : c.session.audioConnectionState ?? data.mobileConnectionState,
                    audioDeviceId: Object.prototype.hasOwnProperty.call(data, "audioDeviceId") ? data.audioDeviceId : c.session.audioDeviceId ?? null,
                    audioDeviceLabel: Object.prototype.hasOwnProperty.call(data, "audioDeviceLabel") ? data.audioDeviceLabel : c.session.audioDeviceLabel ?? null,
                    recordingMaxDurationMinutes: Object.prototype.hasOwnProperty.call(data, "recordingMaxDurationMinutes") ? data.recordingMaxDurationMinutes : c.session.recordingMaxDurationMinutes ?? null,
                    recordingExpiresAt: Object.prototype.hasOwnProperty.call(data, "recordingExpiresAt") ? data.recordingExpiresAt : c.session.recordingExpiresAt ?? null,
                    recordingStopReason: Object.prototype.hasOwnProperty.call(data, "recordingStopReason") ? data.recordingStopReason : c.session.recordingStopReason ?? null,
                    errorCode: Object.prototype.hasOwnProperty.call(data, "errorCode") ? data.errorCode : c.session.errorCode ?? null,
                    errorMessageSafe: Object.prototype.hasOwnProperty.call(data, "errorMessageSafe") ? data.errorMessageSafe : c.session.errorMessageSafe ?? null,
                    updatedAt: data.updatedAt
                  }
                }
              : c
          );
          if (data.status !== "recording") {
            setPartial("");
            stopLocalRecorderStreaming();
          }
          if (["recording", "finalizing", "soap_ready", "approved"].includes(data.status)) {
            setError("");
          }
          if (data.status === "degraded_recording") {
            setError(data.audioSourceType === "local_browser"
              ? "この端末の録音接続が切れました。必要なら録り直してください。"
              : "録音中にスマホとの接続が切れました。スマホのマイクを確認してから録音を再開してください。");
            addToast("録音が中断されました", "error");
          }
        }

        if (data.type === "recording.started") {
          setPartial("");
          clearAudioActivity();
          setRecordingStall(false);
        }

        if (data.type === "recording.discarded") {
          setPartial("");
          setHighlights([]);
          stopLocalRecorderStreaming();
          setPostStopModalMode(null);
          setConfirmDiscardRecording(false);
          setRecordingStall(false);
          clearAudioActivity();
          trustedAssignAttemptRef.current = false;
          setRecordingChoiceDismissed(false);
          setRecordingSetupMode(null);
          addToast("録音を破棄しました。録り直せます。", "success");
        }

        if (data.type === "recording.stopped") {
          stopLocalRecorderStreaming();
          if (data.autoStopped) {
            addToast("録音上限に達したため自動停止しました。", "error");
          }
        }

        if (data.type === "audio.first_frame_received" || data.type === "audio.activity") {
          if (data.audioSourceType !== "local_browser") {
            markAudioActivity(1200);
          }
        }

        if (data.type === "transcript.partial") {
          markAudioActivity();
          setPartial(data.text);
        }

        if (data.type === "transcript.final") {
          clearAudioActivity();
          setPartial("");
          setSessionState((c) => {
            if (!c) return c;
            return { ...c, turns: [...c.turns, { turnId: data.turnId, turnIndex: data.turnIndex, speaker: data.speaker, text: data.text, startMs: data.startMs, endMs: data.endMs, confidence: data.confidence }] };
          });
        }

        if (data.type === "highlights.updated") setHighlights(data.items || []);

        if (data.type === "soap.stream.updated") {
          setSessionState((c) =>
            c
              ? {
                  ...c,
                  session: {
                    ...c.session,
                    status: "finalizing",
                    soapGenerationPreview: data.outputText || "",
                    soapGenerationPreviewUpdatedAt: data.updatedAt || c.session.soapGenerationPreviewUpdatedAt || null
                  }
                }
              : c
          );
        }

        if (data.type === "soap.ready") {
          setSessionState((c) =>
            c
              ? {
                  ...c,
                  latestSoap: data.soap,
                  session: {
                    ...c.session,
                    status: data.soap?.status === "approved" ? "approved" : c.session.status === "approved" ? "approved" : "soap_ready",
                    soapGenerationPreview: "",
                    soapGenerationPreviewUpdatedAt: null
                  }
                }
              : c
          );
        }

        if (data.type === "transcript.corrected") {
          setSessionState((c) => {
            if (!c?.latestSoap) return c;

            return {
              ...c,
              latestSoap: {
                ...c.latestSoap,
                structuredJson: {
                  ...(c.latestSoap.structuredJson || {}),
                  finalTranscript: data.text
                },
                updatedAt: data.updatedAt || c.latestSoap.updatedAt
              }
            };
          });
        }

        if (data.type === "error") {
          if (data.code === "UNAUTHORIZED") {
            clearAccess();
          }
          setError(toUserFacingErrorMessage(data.message, "録音接続で問題が発生しました。もう一度お試しください。"));
          if (data.code === "SOAP_REGENERATION_FAILED") {
            loadSession().catch(() => {});
          }
        }
      });

      ws.addEventListener("close", (event) => {
        // Don't reconnect on intentional close or auth failure
        if (event.code === 1000 || event.code === 4001) return;
        const attempt = wsReconnectAttemptsRef.current;
        if (attempt >= 10) return;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        wsReconnectAttemptsRef.current = attempt + 1;
        wsReconnectTimerRef.current = setTimeout(connectWs, delay);
      });
    }

    connectWs();

    return () => {
      clearTimeout(wsReconnectTimerRef.current);
      if (wsRef.current) { wsRef.current.close(1000); wsRef.current = null; }
    };
  }, [sessionId, accessToken]);

  // Recording timer
  useEffect(() => {
    if (status === "recording") {
      if (!recordingStartedAt) setRecordingStartedAt(Date.now());
      const interval = setInterval(() => {
        setRecordingElapsed(Date.now() - (recordingStartedAt || Date.now()));
      }, 1000);
      return () => clearInterval(interval);
    }
    if (status !== "recording" && recordingStartedAt) {
      setRecordingStartedAt(null);
    }
  }, [status, recordingStartedAt]);

  useEffect(() => {
    if (status !== "recording" || turns.length > 0 || partial) {
      setRecordingStall(false);
      return undefined;
    }

    const timeout = setTimeout(() => {
      setRecordingStall(true);
    }, 8000);

    return () => clearTimeout(timeout);
  }, [status, turns.length, partial]);

  useEffect(() => {
    if (status !== "recording") {
      clearAudioActivity();
    }
  }, [status]);

  useEffect(() => () => {
    if (audioActivityTimerRef.current) {
      clearTimeout(audioActivityTimerRef.current);
      audioActivityTimerRef.current = null;
    }
  }, []);

  // Page leave prevention
  useEffect(() => {
    function handleBeforeUnload(e) {
      if (status === "recording" || reviewDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [status, reviewDirty]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      const isMeta = e.metaKey || e.ctrlKey;
      const target = e.target;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      // Cmd/Ctrl+S to save review
      if (isMeta && e.key === "s" && reviewDirty) {
        e.preventDefault();
        runAction(saveReviewNote);
        return;
      }
      // Escape closes overlays.
      if (e.key === "Escape") {
        if (shouldShowRecordingChoice) { dismissRecordingChoice(); return; }
        if (pairingOverlayManuallyOpen) { setPairingOverlayManuallyOpen(false); return; }
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (postStopModalMode) { setPostStopModalMode(null); return; }
        if (confirmStopRecording) { setConfirmStopRecording(false); return; }
        if (confirmDiscardRecording) { closeDiscardRecordingConfirm(); return; }
        if (confirmReviewReset) { setConfirmReviewReset(false); return; }
        if (confirmApproval) { setConfirmApproval(false); return; }
      }
      // ? opens shortcut help
      if (!isTyping && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      // L cycles the workspace layout without showing a persistent button.
      if (!isTyping && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setLayoutMode((current) => (current === "split" ? "soap" : current === "soap" ? "stacked" : "split"));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    reviewDirty,
    showShortcuts,
    confirmApproval,
    confirmReviewReset,
    confirmStopRecording,
    confirmDiscardRecording,
    postStopModalMode,
    discardRecordingReturnTarget,
    pairingOverlayManuallyOpen,
    shouldShowRecordingChoice,
    status,
    soap
  ]);

  // Cleanup autosave timer
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      for (const timer of toastExitTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
      toastExitTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    return () => {
      cleanupLocalRecorder({ updateState: false });
    };
  }, []);

  // Mirror reviewSaveState into a ref so the autosave callback can read it
  useEffect(() => {
    reviewSaveStateRef.current = reviewSaveState;
  }, [reviewSaveState]);

  useEffect(() => {
    const container = transcriptScrollRef.current;
    const end = transcriptEndRef.current;

    if (!container || !end) {
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

    if (transcriptMode === "live") {
      const frame = window.requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (distanceFromBottom < 96) {
      end.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [turns.length, partial, shouldShowPendingTurn, transcriptMode]);

  useEffect(() => {
    if (!isStreamingSoapPreview) {
      return;
    }

    const textarea = soapOutputTextareaRef.current;
    if (!textarea) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      textarea.scrollTop = textarea.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isStreamingSoapPreview, soapGenerationPreview]);

  useEffect(() => {
    const wasStreaming = previousStreamingSoapPreviewRef.current;
    previousStreamingSoapPreviewRef.current = isStreamingSoapPreview;

    if (!wasStreaming || isStreamingSoapPreview || !soap) {
      return;
    }

    const textarea = soapOutputTextareaRef.current;
    if (!textarea) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      textarea.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isStreamingSoapPreview, soap?.versionId]);

  useEffect(() => {
    let isCancelled = false;

    if (!pairingUrl) {
      setPairingQrUrl("");
      return;
    }

    QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240
    })
      .then((dataUrl) => {
        if (!isCancelled) {
          setPairingQrUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setPairingQrUrl("");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [pairingUrl]);

  async function postAction(path, body) {
    const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}${path}`, {
      method: "POST",
      body: JSON.stringify(body || {})
    }, accessToken);
    if (!response.ok) {
      if (response.status === 401) {
        clearAccess();
      }
      const err = await response.json().catch(() => ({ error: "処理に失敗しました。もう一度お試しください。" }));
      throw new Error(toUserFacingErrorMessage(err.error || "", "処理に失敗しました。もう一度お試しください。"));
    }
    return response.json();
  }

  async function loadPromptOptions() {
    setPromptOptionsLoading(true);
    setPromptOptionsError("");

    try {
      const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/sessions/${sessionId}/prompt-options`, {
        cache: "no-store",
      }, accessToken);

      if (!response.ok) {
        if (response.status === 401) {
          clearAccess();
        }
        const body = await response.json().catch(() => ({ error: "プロンプト一覧を取得できませんでした。" }));
        throw new Error(toUserFacingErrorMessage(body.error || "", "プロンプト一覧を取得できませんでした。"));
      }

      const payload = await response.json();
      applyPromptOptionsData(payload);
    } catch (nextError) {
      setPromptOptionsError(toUserFacingErrorMessage(nextError, "プロンプト一覧を取得できませんでした。"));
    } finally {
      setPromptOptionsLoading(false);
    }
  }

  function closePromptChangeConfirm() {
    setConfirmPromptChange(false);
    setPendingPromptChangeId("");
  }

  async function savePromptSelection(nextPromptProfileId) {
    if (!nextPromptProfileId) {
      setPromptOptionsError("使用するプロンプトを選択してください。");
      return;
    }

    setPromptSelectionSaving(true);
    setPromptOptionsError("");

    try {
      const payload = await postAction(`/api/v1/sessions/${sessionId}/prompt-profile`, {
        promptProfileId: nextPromptProfileId
      });

      setSessionState((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                ...(payload.session || {})
              },
              promptProfile: payload.promptProfile || current.promptProfile
            }
          : current
      );
      addToast("この診療で使うプロンプトを変更しました", "success");
    } catch (nextError) {
      setPromptOptionsError(toUserFacingErrorMessage(nextError, "プロンプトを変更できませんでした。"));
    } finally {
      setPromptSelectionSaving(false);
    }
  }

  async function regenerateSoapWithPrompt(nextPromptProfileId) {
    if (!nextPromptProfileId) {
      setPromptOptionsError("再作成に使うプロンプトを選択してください。");
      return;
    }

    setPromptSelectionSaving(true);
    setPromptOptionsError("");

    try {
      const payload = await postAction(`/api/v1/sessions/${sessionId}/regenerate-soap`, {
        promptProfileId: nextPromptProfileId
      });

      setSessionState((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                ...(payload.session || {})
              },
              promptProfile: payload.promptProfile || current.promptProfile
            }
          : current
      );
      closePromptChangeConfirm();
      setReviewSaveState("idle");
      addToast(
        nextPromptProfileId === currentPromptId
          ? "追加録音を反映してSOAP下書きを更新しています"
          : "別プロンプトでSOAP下書きを再作成しています",
        "success"
      );
    } catch (nextError) {
      setPromptOptionsError(toUserFacingErrorMessage(nextError, "SOAP下書きを再作成できませんでした。"));
    } finally {
      setPromptSelectionSaving(false);
    }
  }

  function handlePromptToolbarChange(nextPromptId) {
    if (!nextPromptId || nextPromptId === currentPromptId) {
      return;
    }

    if (hasSoapDraft) {
      setPendingPromptChangeId(nextPromptId);
      setConfirmPromptChange(true);
      return;
    }

    savePromptSelection(nextPromptId);
  }

  async function refreshPairing() {
    const refreshed = await postAction(`/api/v1/sessions/${sessionId}/pairings`, {});
    const nextPairing = {
      pairingId: refreshed.pairingId,
      token: refreshed.pairingToken || ""
    };
    setPairingMeta(nextPairing);
    storePairing(sessionId, nextPairing);
  }

  function closePairingOverlay() {
    setPairingOverlayManuallyOpen(false);
  }

  async function selectRecordingSource(source) {
    const payload = await postAction(`/api/v1/sessions/${sessionId}/recording/source`, { source });

    if (payload.session) {
      setSessionState((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                ...payload.session
              }
            }
          : current
      );
    }
  }

  function chooseMobileRecordingSetup() {
    setRecordingSetupMode("mobile");
    dismissRecordingChoice();
    setPairingOverlayManuallyOpen(true);
    runAction(() => selectRecordingSource("linked_mobile"));
  }

  function chooseLocalRecordingSetup() {
    setRecordingSetupMode("local");
    dismissRecordingChoice();
    setPairingOverlayManuallyOpen(false);
    setLocalRecorderMessage("下部の「このパソコンで録音」を押すと録音が始まります。");
    runAction(() => selectRecordingSource("local_browser"));
  }

  function getLocalAudioSource() {
    if (!localAudioSourceRef.current) {
      const audioInputPreference = readAudioInputPreference({
        orgId: operatorSession?.orgId || sessionState?.session?.orgId || sessionState?.session?.clinicId,
        memberId: operatorSession?.member?.memberId || sessionState?.session?.createdByMemberId
      });
      localAudioSourceRef.current = createBrowserAudioSource({
        onAudioFrame: (frame) => {
          if (!localRecorderStreamingRef.current) {
            return;
          }

          if (recorderWsRef.current?.readyState === WebSocket.OPEN) {
            recorderWsRef.current.send(frame);
          }
        },
        onLevel: (level) => {
          setLocalRecorderLevel(level);
          if (localRecorderStreamingRef.current && level >= AUDIO_ACTIVITY_LEVEL_THRESHOLD) {
            markAudioActivity();
          }
        },
        onInterrupted: () => {
          if (localRecorderStreamingRef.current) {
            setLocalRecorderState("interrupted");
            setLocalRecorderMessage("マイク入力が一時停止しました。画面を開き直して録音状態を確認してください。");
            addToast("この端末のマイク入力が一時停止しました", "error");
          }
        },
        onError: (nextError) => {
          setLocalRecorderState("failed");
          setLocalRecorderMessage(toUserFacingErrorMessage(nextError, "このパソコンで録音を開始できませんでした。"));
          setError(toUserFacingErrorMessage(nextError, "録音を開始できませんでした。もう一度お試しください。"));
        },
        gateAudio: false,
        audioConstraints: buildAudioInputConstraints(audioInputPreference?.deviceId)
      });
    }

    return localAudioSourceRef.current;
  }

  function sendLocalRecorderJson(payload) {
    if (recorderWsRef.current?.readyState === WebSocket.OPEN) {
      recorderWsRef.current.send(JSON.stringify(payload));
    }
  }

  async function connectLocalRecorderSocket() {
    if (recorderWsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    if (localRecorderConnectPromiseRef.current) {
      return localRecorderConnectPromiseRef.current;
    }

    const currentDeviceId = localRecorderDeviceId || getOrCreateStoredDeviceId(LOCAL_RECORDER_DEVICE_ID_STORAGE_KEY, "local");

    localRecorderConnectPromiseRef.current = new Promise((resolve, reject) => {
      const ws = new WebSocket(getGatewayWsUrl());
      recorderWsRef.current = ws;
      let settled = false;

      const fail = (nextError) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(nextError);
      };

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          type: "auth.hello",
          role: "recorder",
          sessionId,
          token: accessToken,
          deviceId: currentDeviceId
        }));
      });

      ws.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (data.type === "auth.ok") {
          ws.send(JSON.stringify({
            type: "audio.metadata",
            sampleRateHz: TARGET_SAMPLE_RATE,
            channels: 1,
            encoding: "pcm16",
            transport: "raw_pcm",
            mimeType: "audio/pcm"
          }));
          settled = true;
          resolve();
          return;
        }

        if (data.type === "error") {
          if (data.code === "UNAUTHORIZED") {
            clearAccess();
          }
          fail(new Error(data.message || "この端末の録音接続に失敗しました。"));
        }
      });

      ws.addEventListener("close", () => {
        recorderWsRef.current = null;
        if (!settled) {
          fail(new Error("この端末の録音接続を開始できませんでした。"));
          return;
        }

        if (localRecorderStreamingRef.current) {
          localRecorderStreamingRef.current = false;
          localAudioSourceRef.current?.stopStreaming();
          setLocalRecorderState("interrupted");
          setLocalRecorderMessage("録音接続が切れました。必要なら録り直してください。");
          addToast("この端末の録音接続が切れました", "error");
        }
      });
    }).finally(() => {
      localRecorderConnectPromiseRef.current = null;
    });

    return localRecorderConnectPromiseRef.current;
  }

  async function prepareLocalRecorder() {
    setLocalRecorderState("preparing");
    setLocalRecorderMessage("この端末のマイクを準備しています...");

    const audioSource = getLocalAudioSource();
    await audioSource.prepare();
    await connectLocalRecorderSocket();
    sendLocalRecorderJson({ type: "mic.ready" });
    setLocalRecorderState("ready");
    setLocalRecorderMessage("この端末のマイク準備ができています。");
  }

  function stopLocalRecorderStreaming() {
    localRecorderStreamingRef.current = false;
    localAudioSourceRef.current?.stopStreaming();
    if (localRecorderState === "recording" || localRecorderState === "interrupted") {
      setLocalRecorderState(localAudioSourceRef.current?.isPrepared() ? "ready" : "idle");
    }
  }

  function cleanupLocalRecorder({ updateState = true } = {}) {
    localRecorderStreamingRef.current = false;
    sendLocalRecorderJson({ type: "mic.disabled" });
    if (recorderWsRef.current) {
      recorderWsRef.current.close(1000);
      recorderWsRef.current = null;
    }
    localAudioSourceRef.current?.cleanup();
    localAudioSourceRef.current = null;
    if (updateState) {
      setLocalRecorderLevel(0);
      setLocalRecorderState("idle");
      setLocalRecorderMessage("");
    }
  }

  async function startLocalRecordingFromWorkspace() {
    await prepareLocalRecorder();
    await postAction(`/api/v1/sessions/${sessionId}/recording/start`, {
      deviceId: localRecorderDeviceId || getOrCreateStoredDeviceId(LOCAL_RECORDER_DEVICE_ID_STORAGE_KEY, "local"),
      deviceLabel: navigator.platform || "この端末",
      source: "local_browser"
    });
    localRecorderStreamingRef.current = true;
    await getLocalAudioSource().startStreaming();
    setLocalRecorderState("recording");
    setLocalRecorderMessage("この端末のマイクで録音しています。");
  }

  async function savePatientInfo() {
    setPatientInfoSaveState("saving");
    setPatientInfoMessage("保存中...");

    try {
      const response = await postAction(`/api/v1/sessions/${sessionId}/metadata`, patientInfoDraft);
      const nextSession = response.session;
      const nextDraft = {
        patientId: nextSession.patientId || "",
        facilityId: nextSession.facilityId || "",
        departmentId: nextSession.departmentId || "",
        patientDisplayName: nextSession.patientDisplayName || "",
        visitReason: nextSession.visitReason || ""
      };

      setSessionState((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                ...nextSession
              }
            }
          : current
      );
      setPatientInfoBaseline(nextDraft);
      setPatientInfoDraft(nextDraft);
      setPatientInfoSaveState("saved");
      setPatientInfoMessage("保存済み");
      addToast("患者情報を保存しました", "success");
    } catch (nextError) {
      setPatientInfoSaveState("dirty");
      setPatientInfoMessage("保存に失敗しました");
      throw nextError;
    }
  }

  function updateReviewField(field, value) {
    setReviewDraftState((current) => ({
      ...current,
      [field]: value
    }));
    setReviewSaveState("dirty");
    scheduleAutosave();
  }

  function scheduleAutosave() {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      if (reviewSaveStateRef.current === "saving") {
        // a save is already in flight; reschedule shortly
        scheduleAutosave();
        return;
      }
      saveReviewNote().catch(() => {
        // saveReviewNote already updates reviewSaveState
      });
    }, 1500);
  }

  function discardReviewChanges() {
    setReviewDraftState(reviewBaseline);
    setReviewSaveState("saved");
    setConfirmReviewReset(false);
  }

  function requestDiscardReviewChanges() {
    if (!reviewDirty) {
      return;
    }

    const editedLength = `${reviewDraft.transcript || ""}\n${reviewDraft.outputText || ""}`.trim().length;

    if (editedLength > 50) {
      setConfirmReviewReset(true);
      return;
    }

    discardReviewChanges();
  }

  async function saveReviewNote() {
    if (!soap) {
      return;
    }

    const submittedDraft = {
      transcript: reviewDraftRef.current.transcript,
      outputText: reviewDraftRef.current.outputText
    };
    setReviewSaveState("saving");

    try {
      const response = await postAction(`/api/v1/sessions/${sessionId}/review-note`, submittedDraft);
      const nextSoap = response.latestSoap;
      const nextDraft = buildReviewDraft(nextSoap, liveTranscript);
      const draftChangedSinceSubmit = !reviewDraftEquals(reviewDraftRef.current, submittedDraft);

      setSessionState((current) =>
        current
          ? {
              ...current,
              latestSoap: nextSoap,
              session: {
                ...current.session,
                ...(response.session || {}),
                status: response.session?.status || "soap_ready"
              }
            }
          : current
      );
      setReviewBaseline(nextDraft);
      if (!draftChangedSinceSubmit) {
        setReviewDraftState(nextDraft);
      }
      setReviewSaveState(draftChangedSinceSubmit ? "dirty" : "saved");
    } catch (error) {
      setReviewSaveState("dirty");
      throw error;
    }
  }

  async function approveReviewNote() {
    const response = await postAction(`/api/v1/sessions/${sessionId}/approve-note`, {
      versionId: sessionState?.latestSoap?.versionId
    });

    setSessionState((current) =>
      current
        ? {
            ...current,
            session: {
              ...current.session,
              ...response.session
            },
            latestSoap: response.latestSoap || current.latestSoap
          }
        : current
    );
    setShowApproved(true);
    setConfirmApproval(false);
    setReviewSaveState("saved");
    addToast("診療記録を確定しました", "success");
  }

  function openPatientInfoSection() {
    patientInfoVisibilityTouchedRef.current = true;
    setShowPatientInfo(true);
    setPostStopModalMode(null);
    setTimeout(() => {
      patientInfoNameInputRef.current?.focus();
      patientInfoNameInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 40);
  }

  async function generateSoapFromStopped() {
    if (patientInfoDirty) {
      await savePatientInfo();
    }

    await postAction(`/api/v1/sessions/${sessionId}/generate-soap`, {});
    setPostStopModalMode(null);
    setPostStopPromptId("");
    addToast("SOAP下書きの作成を開始しました", "success");
  }

  async function updateSoapFromStopped() {
    if (!postStopPromptSelectionId) {
      setPromptOptionsError("更新に使うプロンプトを選択してください。");
      return;
    }

    if (patientInfoDirty) {
      await savePatientInfo();
    }

    await regenerateSoapWithPrompt(postStopPromptSelectionId);
    setPostStopModalMode(null);
    setPostStopPromptId("");
  }

  function openDiscardRecordingConfirm(options = {}) {
    const returnTarget = options?.returnTo || null;
    setDiscardRecordingReturnTarget(returnTarget);

    if (returnTarget === "post-stop") {
      setPostStopModalMode(null);
    }

    setConfirmDiscardRecording(true);
  }

  function closeDiscardRecordingConfirm() {
    const shouldRestorePostStop = discardRecordingReturnTarget === "post-stop" && status === "stopped";
    setConfirmDiscardRecording(false);
    setDiscardRecordingReturnTarget(null);

    if (shouldRestorePostStop) {
      setPostStopModalMode("choice");
    }
  }

  async function discardRecordingAttempt() {
    await postAction(`/api/v1/sessions/${sessionId}/recording/discard`, {});
    await refreshPairing();
    setPostStopModalMode(null);
    setConfirmDiscardRecording(false);
    setDiscardRecordingReturnTarget(null);
    setPartial("");
    setHighlights([]);
    setRecordingStall(false);
    clearAudioActivity();
    trustedAssignAttemptRef.current = false;
    setRecordingChoiceDismissed(false);
    setRecordingSetupMode(null);
    await loadSession();
  }

  async function startAdditionalRecording() {
    if (reviewDirty || reviewSaveState === "saving") {
      setError("未保存のSOAP編集を保存してから録音を追加してください。");
      return;
    }

    if (audioSourceType === "local_browser" || isLocalRecordingMode) {
      await startLocalRecordingFromWorkspace();
      return;
    }

    if (canStartMobileRecording) {
      await postAction(`/api/v1/sessions/${sessionId}/recording/start`, {
        deviceId: sessionState?.session?.audioDeviceId || "mobile-browser",
        source: "linked_mobile"
      });
      return;
    }

    setRecordingSetupMode("mobile");
    setPairingOverlayManuallyOpen(true);
  }

  function runAction(callback) {
    setIsBusy(true);
    setError("");
    startTransition(async () => {
      try { await callback(); }
      catch (e) { setError(toUserFacingErrorMessage(e, "録音を再開できませんでした。もう一度お試しください。")); }
      finally { setIsBusy(false); }
    });
  }

  const showPairingOverlay = pairingOverlayManuallyOpen && !isLocalRecordingMode;

  function renderTranscriptTurns({ muted = false } = {}) {
    if (!turns.length && !partial) {
      return null;
    }

    return (
      <div className={`turns-list ${muted ? "turns-list--reference" : ""}`}>
        {turns.map((turn) => (
          <div className={`transcript-turn ${muted ? "transcript-turn--reference" : ""}`} key={turn.turnId || `${turn.turnIndex}-${turn.text}`}>
            <div className="transcript-turn-speaker">
              <span className={`speaker-dot speaker-dot--${turn.speaker === "doctor" ? "doctor" : turn.speaker === "patient" ? "patient" : ""}`} />
              {turn.speaker === "doctor" ? "医師" : turn.speaker === "patient" ? "患者" : `発話 ${turn.turnIndex}`}
            </div>
            <p className="transcript-turn-text">{turn.text}</p>
          </div>
        ))}
        {partial ? <div className={`transcript-partial transcript-partial--ghost ${muted ? "transcript-partial--reference" : ""}`}>{partial}</div> : null}
        {shouldShowPendingTurn && !muted ? (
          <div className="transcript-turn transcript-turn--pending" aria-label={`発話 ${turns.length + 1} の書き起こし準備中`}>
            <div className="transcript-turn-speaker">
              <span className="speaker-dot speaker-dot--pending" />
              {`発話 ${turns.length + 1}`}
            </div>
            <div className="listening-dots listening-dots--turn" aria-label="書き起こし準備中">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderTranscriptReference({ summaryLabel }) {
    if (!turns.length && !partial) {
      return null;
    }

    return (
      <details className="transcript-reference">
        <summary className="transcript-reference-summary">
          <div className="transcript-reference-summary-main">
            <span>{summaryLabel}</span>
            <TranscriptModeBadge tone="reference" label="参考" />
          </div>
          <span className="transcript-reference-summary-meta">
            {turns.length > 0 ? `${turns.length} ターン` : "入力途中あり"}
          </span>
        </summary>
        <div className="transcript-reference-body">
          {renderTranscriptTurns({ muted: true })}
        </div>
      </details>
    );
  }

  function renderTranscriptStateCard() {
    if (!transcriptStateCard) {
      return null;
    }

    return (
      <div className={`status-card status-card--${transcriptStateCard.tone}`}>
        <div className="status-card-title">{transcriptStateCard.title}</div>
        {transcriptStateCard.activity === "listening" ? (
          <div className="listening-dots" aria-label="書き起こし準備中">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <p>{transcriptStateCard.body}</p>
        )}
      </div>
    );
  }

  function renderTranscriptTextSurface({
    value,
    editable = false,
    ai = false,
    ariaLabel
  }) {
    const className = [
      "review-transcript-readonly",
      "transcript-text-surface",
      editable ? "transcript-text-surface--editable" : "transcript-text-surface--readonly",
      ai ? "review-transcript-readonly--ai" : ""
    ].filter(Boolean).join(" ");

    if (editable) {
      return (
        <textarea
          aria-label={ariaLabel}
          className={className}
          disabled={status === "finalizing"}
          onChange={(event) => updateReviewField("transcript", event.target.value)}
          spellCheck={false}
          value={value}
        />
      );
    }

    return (
      <div className={className} aria-label={ariaLabel}>
        {value ? <span>{value}</span> : null}
      </div>
    );
  }

  function renderTranscriptPanelBody() {
    if (transcriptMode === "review") {
      if (status === "finalizing") {
        return (
          <>
            <div className="transcript-processing-card">
              <div className="transcript-processing-title">
                <TranscriptModeBadge tone="processing" label="処理中" />
                <strong>書き起こしを整理しています</strong>
              </div>
              <div className="transcript-processing-steps">
                <div className="transcript-processing-step transcript-processing-step--done">
                  <span className="transcript-processing-step-icon"><Icon name="check" size={12} /></span>
                  <span>録音完了</span>
                </div>
                <div className="transcript-processing-step transcript-processing-step--active">
                  <span className="transcript-processing-step-icon"><span className="transcript-mode-badge__spinner" aria-hidden="true" /></span>
                  <span>書き起こしを整理中</span>
                </div>
                <div className="transcript-processing-step">
                  <span className="transcript-processing-step-icon"><Icon name="fileText" size={12} /></span>
                  <span>診療記録の下書きを準備中</span>
                </div>
              </div>
            </div>
            {renderTranscriptReference({
              summaryLabel: "リアルタイム書き起こし（速報）を確認"
            })}
          </>
        );
      }

      return (
        <>
          {shouldShowFinalTranscript ? (
            <div className="review-transcript-shell">
              <div className="review-transcript-meta">
                <span>{transcriptVersionLabel}</span>
              </div>
              {renderTranscriptTextSurface({
                value: finalTranscript,
                editable: status !== "approved",
                ai: !reviewEdited,
                ariaLabel: "診療記録に使う書き起こし"
              })}
            </div>
          ) : null}

          {renderTranscriptReference({
            summaryLabel: "リアルタイム書き起こし（速報）を参考表示"
          })}
        </>
      );
    }

    if (transcriptMode === "stopped") {
      return (
        <>
          {renderTranscriptStateCard()}
          {renderTranscriptReference({
            summaryLabel: "リアルタイム書き起こし（速報）を確認"
          })}
        </>
      );
    }

    return (
      <>
        {renderTranscriptStateCard()}

        {(turns.length > 0 || partial) ? (
          <div className="transcript-live-shell">
            <div className="review-transcript-meta">
              <span>リアルタイム書き起こし（速報）</span>
            </div>
            {renderTranscriptTurns()}
          </div>
        ) : null}
      </>
    );
  }

  function renderPatientInfoCard() {
    const patientInfoStatusText = patientInfoSaveState === "saving"
      ? "保存中..."
      : patientInfoDirty
        ? "未保存"
        : patientInfoMessage;
    const selectableDepartments = patientInfoDraft.facilityId
      ? coreDepartments.filter((department) => !department.facilityId || department.facilityId === patientInfoDraft.facilityId)
      : coreDepartments;
    const shouldShowFacilitySelect = coreFacilities.length > 1;
    const facilityOptions = [
      { value: OPTIONAL_SELECT_NONE_VALUE, label: "施設を指定しない", description: "施設を指定しません。" },
      ...coreFacilities.map((facility) => ({
        value: facility.facilityId,
        label: facility.displayName,
        description: facility.medicalInstitutionCode ? `医療機関コード ${facility.medicalInstitutionCode}` : "登録済み施設"
      }))
    ];
    const departmentOptions = [
      { value: OPTIONAL_SELECT_NONE_VALUE, label: "診療科を指定しない", description: "診療科を指定しません。" },
      ...selectableDepartments.map((department) => ({
        value: department.departmentId,
        label: department.displayName,
        description: department.facilityId ? "選択中の施設に紐づく診療科" : "全施設共通の診療科"
      }))
    ];

    return (
      <div className={`patient-info-card ${showPatientInfo ? "patient-info-card--expanded" : "patient-info-card--collapsed"}`}>
        <button
          className="patient-info-card-toggle"
          onClick={() => {
            patientInfoVisibilityTouchedRef.current = true;
            setShowPatientInfo((current) => !current);
          }}
          type="button"
          aria-expanded={showPatientInfo}
        >
          <span className="patient-info-card-head">
            <span className="patient-info-card-title">
              <span className="label">診療情報</span>
              <strong>患者・診療情報</strong>
            </span>
            <span className="patient-info-card-meta">
              {patientInfoStatusText ? (
                <span className={`patient-info-status patient-info-status--${patientInfoSaveState}`}>
                  {patientInfoStatusText}
                </span>
              ) : null}
              <span className={`patient-info-chevron ${showPatientInfo ? "patient-info-chevron--open" : ""}`} aria-hidden="true">
                <Icon name="chevronRight" size={16} />
              </span>
            </span>
          </span>
        </button>
        {showPatientInfo ? (
          <div className="patient-info-card-body">
            <p className="patient-info-copy">
              {soap
                ? "患者名や症状を変更できます。記録に反映する場合は、保存後に「SOAPを更新」を押してください。"
                : "患者名や症状を入力して保存すると、SOAP下書きに使われます。"}
            </p>
            <div className="patient-info-grid">
              <div className="field">
                <label htmlFor="workspaceCorePatientId">登録済み患者</label>
                <PatientSearchSelect
                  id="workspaceCorePatientId"
                  patients={corePatients}
                  value={patientInfoDraft.patientId}
                  onChange={(patientId, patient) => {
                    setPatientInfoDraft((current) => ({
                      ...current,
                      patientId,
                      patientDisplayName: patient?.displayName || current.patientDisplayName
                    }));
                    setPatientInfoSaveState("dirty");
                    setPatientInfoMessage("未保存");
                  }}
                  disabled={patientInfoLocked}
                />
              </div>
              {shouldShowFacilitySelect ? (
                <div className="field">
                  <span className="field-label">施設</span>
                  <AdminSelect
                    ariaLabel="施設"
                    disabled={patientInfoLocked}
                    onValueChange={(nextValue) => {
                      const facilityId = optionalSelectToDraftValue(nextValue);
                      const nextDepartments = facilityId
                        ? coreDepartments.filter((department) => !department.facilityId || department.facilityId === facilityId)
                        : coreDepartments;
                      setPatientInfoDraft((current) => ({
                        ...current,
                        facilityId,
                        departmentId: current.departmentId && nextDepartments.some((department) => department.departmentId === current.departmentId)
                          ? current.departmentId
                          : ""
                      }));
                      setPatientInfoSaveState("dirty");
                      setPatientInfoMessage("未保存");
                    }}
                    options={facilityOptions}
                    value={optionalSelectValue(patientInfoDraft.facilityId)}
                  />
                </div>
              ) : null}
              <div className="field">
                <span className="field-label">診療科</span>
                <AdminSelect
                  ariaLabel="診療科"
                  disabled={patientInfoLocked}
                  onValueChange={(nextValue) => {
                    setPatientInfoDraft((current) => ({ ...current, departmentId: optionalSelectToDraftValue(nextValue) }));
                    setPatientInfoSaveState("dirty");
                    setPatientInfoMessage("未保存");
                  }}
                  options={departmentOptions}
                  value={optionalSelectValue(patientInfoDraft.departmentId)}
                />
              </div>
              <div className="field">
                <label htmlFor="workspacePatientDisplayName">患者名</label>
                <input
                  id="workspacePatientDisplayName"
                  ref={patientInfoNameInputRef}
                  value={patientInfoDraft.patientDisplayName}
                  onChange={(event) => {
                    setPatientInfoDraft((current) => ({ ...current, patientDisplayName: event.target.value }));
                    setPatientInfoSaveState("dirty");
                    setPatientInfoMessage("未保存");
                  }}
                  placeholder="例: 山田 花子"
                  disabled={patientInfoLocked}
                />
              </div>
              <div className="field">
                <label htmlFor="workspaceVisitReason">症状・相談内容</label>
                <textarea
                  id="workspaceVisitReason"
                  value={patientInfoDraft.visitReason}
                  onChange={(event) => {
                    setPatientInfoDraft((current) => ({ ...current, visitReason: event.target.value }));
                    setPatientInfoSaveState("dirty");
                    setPatientInfoMessage("未保存");
                  }}
                  rows={3}
                  placeholder="例: 腰痛、咳、花粉症の相談"
                  disabled={patientInfoLocked}
                />
              </div>
            </div>
            <div className="patient-info-actions">
              <button
                className="btn btn--ghost"
                disabled={patientInfoLocked || !patientInfoDirty || patientInfoSaveState === "saving"}
                onClick={() => {
                  setPatientInfoDraft(patientInfoBaseline);
                  setPatientInfoSaveState("saved");
                  setPatientInfoMessage(hasSavedPatientInfo ? "保存済み" : "");
                }}
                type="button"
              >
                元に戻す
              </button>
              <button
                className={`btn btn--primary ${patientInfoSaveState === "saving" ? "btn--loading" : ""}`}
                disabled={patientInfoLocked || !patientInfoDirty || patientInfoSaveState === "saving"}
                onClick={() => runAction(savePatientInfo)}
                type="button"
              >
                保存
                {patientInfoSaveState === "saving" ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderPromptToolbarSelect() {
    return (
      <div className="soap-prompt-select">
        <span className="soap-prompt-select-label">プロンプト</span>
        <div
          className="soap-prompt-select-control"
          onMouseDown={() => {
            if (!promptOptions.length && !promptOptionsLoading) {
              void loadPromptOptions();
            }
          }}
          onFocus={() => {
            if (!promptOptions.length && !promptOptionsLoading) {
              void loadPromptOptions();
            }
          }}
        >
          <AdminSelect
            ariaLabel="SOAP作成に使うプロンプト"
            className="soap-prompt-select-trigger soap-prompt-trigger"
            disabled={promptToolbarDisabled}
            isSaving={promptSelectionSaving}
            onValueChange={handlePromptToolbarChange}
            options={promptToolbarOptions}
            value={promptToolbarSelectionId}
          />
        </div>
      </div>
    );
  }

  if (!isHydrated) {
    return (
      <div className="workspace-skeleton">
        <div className="workspace-skeleton-main">
          <div className="workspace-skeleton-panel">
            <div className="skeleton skeleton-heading" />
            <div className="skeleton skeleton-block" />
            <div className="skeleton skeleton-block" />
          </div>
          <div className="workspace-skeleton-panel">
            <div className="skeleton skeleton-heading" />
            <div className="skeleton skeleton-block" />
            <div className="skeleton skeleton-block" />
          </div>
        </div>
        <div className="workspace-skeleton-footer">
          <div className="skeleton" style={{ width: 120, height: 14 }} />
        </div>
      </div>
    );
  }

  if (!accessToken) {
    return (
      <OperatorLoginPanel
        onAuthenticated={setAccessToken}
        title="診療記録にログイン"
        description="録音や診療記録の確認にはログインが必要です。"
      />
    );
  }

  return (
    <div className={`workspace workspace--layout-${layoutMode}`}>
      {/* ===== Toast Notifications ===== */}
      <div className="toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.variant === "success" ? "toast--success" : t.variant === "error" ? "toast--error" : ""} ${t.leaving ? "toast--leaving" : ""}`} role="status">
            {t.variant === "success" && <Icon name="check" size={16} />}
            {t.variant === "error" && <Icon name="alertCircle" size={16} />}
            <span className="toast-message">{t.message}</span>
            <button className="toast-close-button" onClick={() => dismissToast(t.id)} type="button" aria-label="通知を閉じる">
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* ===== Main 2-Column ===== */}
      <div className="workspace-main">
        {/* Left: Transcript */}
        <div className={`transcript-panel transcript-panel--${transcriptMode}`}>
          <div className="panel-head">
            <div className="panel-title">
              <span className="label">会話記録</span>
              <h2>書き起こし</h2>
            </div>
            <div className="panel-head-right">
              <TranscriptModeBadge tone={transcriptBadge.tone} label={transcriptBadge.label} />
              {effectiveHighlights.length > 0 && (
                <div className="highlights-row">
                  {effectiveHighlights.map((h, i) => (
                    <span className="highlight-chip" key={`${h.label}-${i}`}>{h.label}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {renderPatientInfoCard()}
          <div className="transcript-scroll" ref={transcriptScrollRef}>
            {renderTranscriptPanelBody()}

            {transcriptMode === "live" && !hasFinalTranscript && turns.length === 0 && !partial && !aiTranscript && !transcriptStateCard ? (
              <div className="transcript-empty">
                録音を始めると、会話の文字起こしが<br />ここに表示されます。
              </div>
            ) : null}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Right: SOAP */}
        <div className="soap-panel">
          <div className="panel-head">
            <div className="panel-title">
              <span className="label">作成結果</span>
              <h2>診療記録</h2>
            </div>
            <div className="soap-panel-toolbar">
              <div className="soap-output-actions">
                {renderPromptToolbarSelect()}
                {reviewReady ? (
                  <button
                    className="btn btn--ghost btn--sm soap-output-copy-button"
                    onClick={() => {
                      const text = currentSoapOutputText.trim();
                      navigator.clipboard?.writeText(text).then(() => {
                        addToast("診療記録をコピーしました", "success");
                      });
                    }}
                    type="button"
                    aria-label="診療記録全文をコピー"
                  >
                    <Icon name="copy" size={14} />
                    コピー
                  </button>
                ) : null}
              </div>
              {reviewReady && status !== "approved" && status !== "finalizing" && reviewDirty ? (
                <button
                  className="btn btn--ghost"
                  disabled={reviewSaveState === "saving"}
                  onClick={requestDiscardReviewChanges}
                  type="button"
                  data-tooltip="変更を破棄"
                >
                  <Icon name="undo" size={14} /> 元に戻す
                </button>
              ) : null}
            </div>
          </div>

          <div className="soap-scroll">
            {status === "finalizing" && !soap ? (
              <div className="soap-output-card soap-output-card--streaming">
                <div className="soap-regenerating-banner" role="status">
                  <div className="spinner spinner--small" />
                  <div>
                    <strong>SOAP下書きを作成しています</strong>
                    <span>{isStreamingSoapPreview ? "作成途中の診療記録を表示しています。" : "会話内容を整理しています。少しお待ちください。"}</span>
                  </div>
                </div>
                <textarea
                  ref={soapOutputTextareaRef}
                  aria-label="作成途中の診療記録"
                  className="editor-textarea editor-textarea--soap-output"
                  readOnly
                  spellCheck={false}
                  value={soapGenerationPreview}
                />
              </div>
            ) : soap ? (
              <div className="soap-output-card">
                {isRegeneratingSoap ? (
                  <div className="soap-regenerating-banner" role="status">
                    <div className="spinner spinner--small" />
                    <div>
                      <strong>{isStreamingSoapPreview ? "新しいSOAP下書きを作成しています" : "別プロンプトでSOAP下書きを再作成しています"}</strong>
                      <span>{isStreamingSoapPreview ? "作成途中の診療記録を表示しています。完了後、編集できる状態に切り替わります。" : "現在表示中の下書きは保持されています。完了後、新しい下書きに切り替わります。"}</span>
                    </div>
                  </div>
                ) : null}
                <textarea
                  ref={soapOutputTextareaRef}
                  className="editor-textarea editor-textarea--soap-output"
                  readOnly={status === "finalizing"}
                  onChange={(event) => updateReviewField("outputText", event.target.value)}
                  spellCheck={false}
                  value={currentSoapOutputText || ""}
                />
              </div>
            ) : (
              <div className="soap-empty">
                <div className="soap-empty-icon" aria-hidden="true">
                  <Icon name="fileText" size={24} />
                </div>
                <p>録音終了後にパソコン画面からSOAP下書きの作成を始めると、ここに診療記録が表示されます。</p>
              </div>
            )}
          </div>

          {/* Sticky approval bar inside SOAP panel — appears when review is ready */}
          {status === "soap_ready" && (
            <div className="soap-panel-footer soap-panel-footer--approve">
              <div className="soap-panel-footer-text">
                <div className="soap-panel-footer-title">診療記録の内容を確認してください</div>
                <div className="soap-panel-footer-sub">
                  {reviewDirty
                    ? "未保存の変更があります。保存してから確定できます。"
                    : "内容を確認し、問題なければ「確定する」を押してください。"}
                </div>
              </div>
              <button
                className={`btn btn--success btn--lg ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy || reviewSaveState === "saving" || reviewDirty}
                onClick={() => setConfirmApproval(true)}
                type="button"
                title={reviewDirty ? "未保存の変更を保存してから確定してください" : ""}
              >
                <Icon name="checkCircle" size={18} /> 確定する
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          )}

          {status === "approved" && (
            <div className="soap-panel-footer">
              <div className="soap-panel-footer-text">
                <div className="soap-panel-footer-title" style={{ color: "var(--success-ink)" }}>
                  <Icon name="checkCircle" size={14} /> 確定済み
                </div>
                <div className="soap-panel-footer-sub">
                  {reviewDirty
                    ? "編集内容を保存すると未確定に戻ります。"
                    : "この記録は確定済みです。再編集すると未確定に戻ります。"}
                </div>
              </div>
              <a className="btn btn--ghost" href="/">
                <Icon name="chevronRight" size={14} /> 次の診療へ
              </a>
            </div>
          )}
        </div>
      </div>

      {/* ===== Footer Bar ===== */}
      <footer className={`workspace-footer ${status === "recording" ? "workspace-footer--recording" : ""}`}>
        <div className="workspace-footer-left">
          {status === "recording" ? (
            <div className="recording-bar" role="status" aria-label="録音中" aria-live="off">
              <span className="recording-bar-label">
                <span className="recording-dot" />
                {isLocalAudioSource ? "このパソコンで録音中" : "録音用スマホで録音中"}
              </span>
              <span className="recording-bar-timer">{formatElapsed(recordingElapsed)}</span>
              {showRecordingExpiryWarning ? (
                <span className={`recording-bar-limit ${showRecordingExpiryWarning ? "recording-bar-limit--warning" : ""}`}>
                  自動停止まで {formatRemaining(recordingRemainingMs)}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="connection-indicator" role="status" aria-label="接続状態">
              <span className={`connection-dot ${
                localRecorderState === "ready" || audioConnectionState === "mic_ready"
                  ? "connection-dot--ready"
                : status === "degraded_recording"
                  ? "connection-dot--warning"
                : sessionState?.session?.mobileConnectionState === "connected"
                  ? "connection-dot--connected"
                  : ""
              }`} />
              {localRecorderState === "ready" && audioSourceType === "local_browser"
                ? "この端末のマイク準備完了"
                : isLocalRecordingMode
                  ? "このパソコンで録音を選択中"
                : sessionState?.session?.mobileConnectionState === "mic_ready"
                  ? "録音用スマホ準備完了"
                : status === "degraded_recording"
                  ? "接続不安定"
                : sessionState?.session?.mobileConnectionState === "connected"
                  ? "スマホ接続中"
                : isMobileRecordingMode
                  ? "スマホ接続待ち"
                  : "スマホ未接続"}
            </div>
          )}
          {localRecorderMessage && ["ready", "paired", "degraded_recording"].includes(status) ? (
            <span className="workspace-footer-note">{localRecorderMessage}</span>
          ) : null}
          {(localRecorderState === "ready" || localRecorderState === "recording" || localRecorderState === "preparing") ? (
            <div className="local-level-meter" role="meter" aria-label="この端末のマイク入力レベル" aria-valuenow={localRecorderLevel} aria-valuemin={0} aria-valuemax={100}>
              <div className="local-level-meter-fill" style={{ width: `${localRecorderLevel}%` }} />
            </div>
          ) : null}
          {pairingUrl && ["ready", "paired", "degraded_recording", "stopped"].includes(status) && !isLocalRecordingMode && (
            <>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  if (["ready", "paired", "degraded_recording"].includes(status)) {
                    chooseMobileRecordingSetup();
                    return;
                  }

                  setPairingOverlayManuallyOpen(true);
                }}
                type="button"
                data-tooltip="QR コードを表示"
              >
                <Icon name="link" size={12} /> QR / 接続
              </button>
              <button
                className="btn btn--ghost btn--sm"
                disabled={isBusy}
                onClick={() => runAction(refreshPairing)}
                type="button"
                data-tooltip="接続リンクを作り直す"
              >
                <Icon name="refreshCw" size={12} /> 接続リンクを作り直す
              </button>
            </>
          )}
        </div>
        <div className="workspace-footer-right">
          {visibleError ? (
            <span className="workspace-footer-error">
              <Icon name="alertCircle" size={14} /> {visibleError}
            </span>
          ) : null}

          {["ready", "paired", "degraded_recording"].includes(status) && (
            <>
              {canChangeRecordingSource && selectedRecordingMode ? (
                <button
                  className="btn btn--ghost btn--lg"
                  disabled={isBusy}
                  onClick={openRecordingChoice}
                  type="button"
                  title={`現在: ${isLocalRecordingMode ? "このパソコンで録音" : "スマホで録音"}`}
                >
                  録音方法変更
                </button>
              ) : null}
              {!isMobileRecordingMode ? (
                <button
                  className={`btn btn--primary btn--lg ${isBusy || localRecorderState === "preparing" ? "btn--loading" : ""}`}
                  disabled={isBusy || localRecorderState === "preparing" || !canStartLocalRecording}
                  onClick={() => runAction(startLocalRecordingFromWorkspace)}
                  type="button"
                >
                  <Icon name="mic" size={16} /> このパソコンで録音
                  {isBusy || localRecorderState === "preparing" ? <span className="btn-spinner" aria-hidden="true" /> : null}
                </button>
              ) : null}
              {!isLocalRecordingMode ? (
                <button
                  className="btn btn--ghost btn--lg"
                  disabled={isBusy || !canOpenMobileRecordingSetup}
                  onClick={() => {
                    if (canStartMobileRecording) {
                      runAction(() => postAction(`/api/v1/sessions/${sessionId}/recording/start`, {
                        deviceId: sessionState?.session?.audioDeviceId || "mobile-browser",
                        source: "linked_mobile"
                      }));
                      return;
                    }

                    chooseMobileRecordingSetup();
                  }}
                  type="button"
                  title={!canOpenMobileRecordingSetup ? "このパソコンで録音する設定になっています" : ""}
                >
                  <Icon name="mic" size={16} /> {canStartMobileRecording ? "スマホで録音開始" : "スマホを接続"}
                </button>
              ) : null}
            </>
          )}

          {["soap_ready", "approved"].includes(status) && (
            <button
              className="btn btn--ghost btn--lg"
              disabled={!canAppendRecording}
              onClick={() => runAction(startAdditionalRecording)}
              type="button"
              title={reviewDirty ? "未保存のSOAP編集を保存してから録音を追加してください" : ""}
            >
              <Icon name="mic" size={16} /> 録音を追加
            </button>
          )}

          {status === "recording" && (
            <button
              className={`btn btn--danger btn--lg ${isBusy ? "btn--loading" : ""}`}
              disabled={isBusy}
              onClick={() => setConfirmStopRecording(true)}
              type="button"
            >
              <Icon name="square" size={14} /> 録音停止
              {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
            </button>
          )}

          {status === "stopped" && !soap && postStopModalMode !== "choice" && (
            <>
              <button
                className="btn btn--ghost btn--lg"
                disabled={isBusy}
                onClick={openPatientInfoSection}
                type="button"
              >
                患者情報を入力
              </button>
              <button
                className="btn btn--ghost btn--lg"
                disabled={!canAppendRecording}
                onClick={() => runAction(startAdditionalRecording)}
                type="button"
              >
                <Icon name="mic" size={16} /> 録音を追加
              </button>
              <button
                className="btn btn--ghost btn--lg"
                disabled={isBusy}
                onClick={() => openDiscardRecordingConfirm()}
                type="button"
              >
                <Icon name="undo" size={14} /> 録音を破棄して録り直す
              </button>
              <button
                className={`btn btn--primary btn--lg ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => runAction(generateSoapFromStopped)}
                type="button"
              >
                SOAP下書きを作成
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </>
          )}

          {status === "stopped" && soap && postStopModalMode !== "choice" && (
            <>
              <button
                className="btn btn--ghost btn--lg"
                disabled={isBusy}
                onClick={openPatientInfoSection}
                type="button"
              >
                患者情報を入力
              </button>
              <button
                className="btn btn--ghost btn--lg"
                disabled={!canAppendRecording}
                onClick={() => runAction(startAdditionalRecording)}
                type="button"
              >
                <Icon name="mic" size={16} /> 録音を追加
              </button>
              <button
                className="btn btn--ghost btn--lg"
                disabled={isBusy}
                onClick={() => openDiscardRecordingConfirm()}
                type="button"
              >
                <Icon name="undo" size={14} /> 録り直す
              </button>
              <button
                className={`btn btn--primary btn--lg ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => runAction(updateSoapFromStopped)}
                type="button"
              >
                SOAPを更新
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </>
          )}
        </div>
      </footer>

      {shouldShowRecordingChoice && (
        <div className="confirm-overlay" onClick={(event) => { if (event.target === event.currentTarget) dismissRecordingChoice(); }}>
          <div className="confirm-card recording-choice-card" role="dialog" aria-labelledby="recording-choice-title" aria-describedby="recording-choice-description">
            <button className="confirm-close-button" type="button" onClick={dismissRecordingChoice} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="recording-choice-title">{selectedRecordingMode ? "録音方法を変更" : "録音方法を選択してください"}</h3>
            <p id="recording-choice-description">この診療で使う録音方法を選びます。選んだあとに録音を開始できます。</p>
            <div className="recording-choice-grid">
              <button className="recording-choice-option" disabled={isBusy} onClick={chooseMobileRecordingSetup} type="button">
                <span className="recording-choice-option-title">スマホで録音</span>
                <span className="recording-choice-option-body">QRを表示してスマホを接続します。接続後、スマホ側で録音を開始できます。</span>
              </button>
              <button className="recording-choice-option" disabled={isBusy} onClick={chooseLocalRecordingSetup} type="button">
                <span className="recording-choice-option-title">このパソコンで録音</span>
                <span className="recording-choice-option-body">この画面の「このパソコンで録音」を押すと、このパソコンのマイクで録音を開始します。</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Pairing Overlay ===== */}
      {showPairingOverlay && (
        <div className="pairing-overlay" onClick={(e) => { if (e.target === e.currentTarget) closePairingOverlay(); }}>
          <div className="pairing-overlay-content" role="dialog" aria-labelledby="pairing-title">
            <button
              type="button"
              className="pairing-overlay-close"
              onClick={closePairingOverlay}
              aria-label="閉じる"
            >
              <Icon name="x" size={16} />
            </button>
            <h2 id="pairing-title">録音に使うスマホを接続してください</h2>
            <p>スマホのカメラでこのQRコードを読み取り、録音ページを開いてください。リンクをコピーして送ることもできます。</p>
            <div className="pairing-qr-card">
              {pairingQrUrl ? (
                <img alt="モバイル接続用QRコード" className="pairing-qr-image" src={pairingQrUrl} />
              ) : (
                <div className="pairing-qr-placeholder">
                  <div className="spinner" />
                </div>
              )}
            </div>
            <div className="pairing-overlay-actions">
              <button
                className="btn btn--ghost"
                disabled={!pairingUrl}
                onClick={() => {
                  navigator.clipboard?.writeText(pairingUrl).then(() => {
                    addToast("接続リンクをコピーしました", "success");
                  });
                }}
                type="button"
              >
                <Icon name="copy" size={14} /> リンクをコピー
              </button>
              <button
                className="btn btn--ghost"
                disabled={isBusy}
                onClick={() => runAction(refreshPairing)}
                type="button"
              >
                <Icon name="refreshCw" size={14} /> 接続リンクを作り直す
              </button>
            </div>
            <button
              className={`btn btn--primary btn--lg ${isBusy ? "btn--loading" : ""}`}
              disabled={isBusy || !canStartMobileRecording}
              onClick={() => runAction(() => postAction(`/api/v1/sessions/${sessionId}/recording/start`, {
                deviceId: sessionState?.session?.audioDeviceId || "mobile-browser",
                source: "linked_mobile"
              }))}
              type="button"
            >
              {canStartMobileRecording
                ? (<><Icon name="mic" size={18} /> スマホで録音開始</>)
                : sessionState?.session?.mobileConnectionState === "connected"
                  ? "スマホでマイクを有効にしてください"
                  : "スマホの接続を待っています..."}
              {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
            </button>
            <p className="pairing-hint">
              スマホでマイクを許可すると、録音を始められる状態になります。
            </p>
          </div>
        </div>
      )}

      {confirmStopRecording && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmStopRecording(false); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="confirm-stop-title">
            <button className="confirm-close-button" type="button" onClick={() => setConfirmStopRecording(false)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="confirm-stop-title">録音を停止しますか？</h3>
            <p>録音終了後は、患者情報を確認したうえでSOAP下書きを作成できます。</p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" onClick={() => setConfirmStopRecording(false)} type="button">
                キャンセル
              </button>
              <button
                className={`btn btn--danger ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => {
                  setConfirmStopRecording(false);
                  runAction(() => postAction(`/api/v1/sessions/${sessionId}/recording/stop`, { enqueueSoapGeneration: false }));
                }}
                type="button"
              >
                <Icon name="square" size={14} /> 録音を停止
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscardRecording && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeDiscardRecordingConfirm(); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="confirm-discard-title">
            <button className="confirm-close-button" type="button" onClick={closeDiscardRecordingConfirm} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="confirm-discard-title">{soap ? "この録音とSOAP下書きを破棄して録り直しますか？" : "この録音を破棄して録り直しますか？"}</h3>
            <p>{soap ? "現在の書き起こし、録音内容、SOAP下書きをこのセッションから外し、録音開始前の状態に戻します。" : "現在の書き起こしと録音内容をこのセッションから削除し、録音開始前の状態に戻します。SOAP下書きはまだ作成されません。"}</p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" onClick={closeDiscardRecordingConfirm} type="button">
                キャンセル
              </button>
              <button
                className={`btn btn--danger ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => runAction(discardRecordingAttempt)}
                type="button"
              >
                <Icon name="undo" size={14} /> 破棄して録り直す
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        </div>
      )}

      {postStopModalMode === "choice" && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPostStopModalMode(null); }}>
          <div className="confirm-card confirm-card--md" ref={postStopModalCardRef} role="dialog" aria-labelledby="post-stop-title">
            <button className="confirm-close-button" type="button" onClick={() => setPostStopModalMode(null)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="post-stop-title">録音を停止しました</h3>
            <p>{hasSoapDraft ? "追加録音を反映する操作を選んでください。" : "次の操作を選んでください。患者情報を入力したあとは、この画面からSOAP下書きを作成できます。"}</p>
            <div className="post-stop-summary-card">
              <span>使用するプロンプト</span>
              <AdminSelect
                ariaLabel="停止後に使用するプロンプト"
                className="soap-prompt-select-trigger"
                disabled={(hasSoapDraft ? false : promptSelectionLocked) || promptOptionsLoading}
                isSaving={promptSelectionSaving}
                onValueChange={(nextPromptId) => {
                  if (!nextPromptId) {
                    return;
                  }

                  if (hasSoapDraft) {
                    setPostStopPromptId(nextPromptId);
                    return;
                  }

                  if (nextPromptId !== currentPromptId) {
                    void savePromptSelection(nextPromptId);
                  }
                }}
                options={promptToolbarOptions}
                portalContainer={postStopModalCardRef.current}
                value={hasSoapDraft ? postStopPromptSelectionId : currentPromptId}
              />
            </div>
            {promptOptionsError ? (
              <div className="status-card status-card--danger">
                <div className="status-card-title">プロンプトを変更できません</div>
                <p>{promptOptionsError}</p>
              </div>
            ) : null}
            <div className="post-stop-actions">
              <button
                className={`btn btn--primary btn--lg ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => runAction(hasSoapDraft ? updateSoapFromStopped : generateSoapFromStopped)}
                type="button"
              >
                {hasSoapDraft ? "SOAPを更新" : "SOAP下書きを作成"}
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
              <div className="post-stop-secondary-actions">
                <button className="btn btn--ghost" onClick={openPatientInfoSection} type="button">
                  患者情報を入力
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={!canAppendRecording}
                  onClick={() => runAction(startAdditionalRecording)}
                  type="button"
                >
                  <Icon name="mic" size={14} /> 録音を追加
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => openDiscardRecordingConfirm({ returnTo: "post-stop" })}
                  type="button"
                  title={hasSoapDraft ? "現在の録音・書き起こし・SOAP下書きを破棄して、録音開始前の状態に戻します" : "現在の録音と書き起こしを破棄して、録音開始前の状態に戻します"}
                >
                  <Icon name="undo" size={14} /> 録り直す
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmPromptChange && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) closePromptChangeConfirm(); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="confirm-prompt-change-title">
            <button className="confirm-close-button" type="button" onClick={closePromptChangeConfirm} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="confirm-prompt-change-title">プロンプトを変更して SOAP を再作成しますか？</h3>
            <p>現在のSOAP下書きは、新しいプロンプトで作り直されます。</p>
            <div className="post-stop-summary-card">
              <div>
                <span>変更前</span>
                <strong>{currentPromptName}</strong>
                <small>{currentPromptScope}</small>
              </div>
              <div>
                <span>変更後</span>
                <strong>{promptToolbarOptions.find((option) => option.value === pendingPromptChangeId)?.label || "未選択"}</strong>
                <small>{promptToolbarOptions.find((option) => option.value === pendingPromptChangeId)?.description || ""}</small>
              </div>
            </div>
            {regeneratePromptLockReason ? (
              <div className="prompt-regenerate-note">
                {regeneratePromptLockReason}
              </div>
            ) : (
              <div className="prompt-regenerate-note">
                手入力で直した内容は引き継がれません。必要な内容は保存してから作り直してください。
              </div>
            )}
            <div className="confirm-actions">
              <button className="btn btn--ghost" onClick={closePromptChangeConfirm} type="button">
                キャンセル
              </button>
              <button
                className={`btn btn--primary ${promptSelectionSaving ? "btn--loading" : ""}`}
                disabled={promptSelectionSaving || !pendingPromptChangeId || !canRegenerateSoap}
                onClick={() => regenerateSoapWithPrompt(pendingPromptChangeId)}
                type="button"
              >
                変更して再作成
                {promptSelectionSaving ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmReviewReset && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmReviewReset(false); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="confirm-review-reset-title">
            <button className="confirm-close-button" type="button" onClick={() => setConfirmReviewReset(false)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="confirm-review-reset-title">編集内容を元に戻しますか？</h3>
            <p>この操作を行うと、保存前の診療記録と書き起こしの変更は破棄されます。</p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" onClick={() => setConfirmReviewReset(false)} type="button">
                キャンセル
              </button>
              <button className="btn btn--danger" onClick={discardReviewChanges} type="button">
                <Icon name="undo" size={14} /> 元に戻す
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Approval Confirmation Dialog ===== */}
      {confirmApproval && (
        <div className="confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmApproval(false); }}>
          <div className="confirm-card" role="dialog" aria-labelledby="confirm-title">
            <button className="confirm-close-button" type="button" onClick={() => setConfirmApproval(false)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <h3 id="confirm-title">診療記録を確定しますか？</h3>
            <p>確定後も再編集できますが、編集内容を保存すると未確定に戻ります。内容を確認してから進めてください。</p>
            <div className="confirm-actions">
              <button className="btn btn--ghost" onClick={() => setConfirmApproval(false)} type="button">
                キャンセル
              </button>
              <button
                className={`btn btn--success ${isBusy ? "btn--loading" : ""}`}
                disabled={isBusy}
                onClick={() => {
                  runAction(approveReviewNote);
                }}
                type="button"
              >
                <Icon name="checkCircle" size={16} /> 確定する
                {isBusy ? <span className="btn-spinner" aria-hidden="true" /> : null}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Shortcut Help Overlay ===== */}
      {showShortcuts && (
        <div className="shortcut-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowShortcuts(false); }}>
          <div className="shortcut-card" role="dialog" aria-labelledby="shortcut-title">
            <h3 id="shortcut-title">
              キーボードショートカット
              <button
                className="btn btn--ghost btn--icon"
                onClick={() => setShowShortcuts(false)}
                type="button"
                aria-label="閉じる"
              >
                <Icon name="x" size={14} />
              </button>
            </h3>
            <ul className="shortcut-list">
              <li>
                <span className="shortcut-list-label">診療記録の編集を保存</span>
                <span className="kbd"><kbd>⌘</kbd><kbd>S</kbd></span>
              </li>
              <li>
                <span className="shortcut-list-label">開いている画面を1段階閉じる</span>
                <span className="kbd"><kbd>Esc</kbd></span>
              </li>
              <li>
                <span className="shortcut-list-label">表示レイアウトを切り替える</span>
                <span className="kbd"><kbd>L</kbd></span>
              </li>
              <li>
                <span className="shortcut-list-label">このヘルプを開く</span>
                <span className="kbd"><kbd>?</kbd></span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* ===== Approved Overlay ===== */}
      {showApproved && (
        <div className="approved-overlay">
          <div className="approved-card">
            <button className="confirm-close-button" type="button" onClick={() => setShowApproved(false)} aria-label="閉じる"><Icon name="x" size={16} /></button>
            <Icon name="checkCircle" size={32} />
            <h2>診療記録を確定しました</h2>
            <p>記録は保存されました。電子カルテに転記してご利用ください。</p>
            <div className="approved-actions">
              <button className="btn btn--ghost" onClick={() => setShowApproved(false)} type="button">
                閉じる
              </button>
              <a href="/" className="btn btn--primary"><Icon name="chevronRight" size={16} /> 次の診療へ</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
