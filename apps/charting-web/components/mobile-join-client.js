"use client";

import { useEffect, useRef, useState } from "react";
import { getGatewayBaseUrl } from "../lib/runtime-config";
import { fetchWithOperatorAuth, useOperatorAccess } from "../lib/operator-access";
import { OperatorLoginPanel } from "./operator-login-panel";

const TARGET_SAMPLE_RATE = 24_000;
const DEVICE_ID_STORAGE_KEY = "soaplane.mobileRecorder.deviceId";
const MIC_ACCESS_STORAGE_KEY = "soaplane.mobileRecorder.micAccessReady";
const AUDIO_GATE_INITIAL_NOISE_FLOOR = 0.004;
const AUDIO_GATE_MIN_RMS = 0.008;
const AUDIO_GATE_NOISE_MULTIPLIER = 2.6;
const AUDIO_GATE_HANGOVER_MS = 650;

function createMobileDeviceId() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return `mob_${window.crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }

  return `mob_${Math.random().toString(36).slice(2, 12)}`;
}

function getOrCreateMobileDeviceId() {
  if (typeof window === "undefined") {
    return createMobileDeviceId();
  }

  try {
    const stored = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored) {
      return stored;
    }

    const next = createMobileDeviceId();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return createMobileDeviceId();
  }
}

function hasStoredMicAccess() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(MIC_ACCESS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function storeMicAccessReady() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(MIC_ACCESS_STORAGE_KEY, "true");
  } catch {
    // Ignore storage failures. Browser permission remains the source of truth.
  }
}

function clearStoredMicAccess() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(MIC_ACCESS_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function isLikelyInAppBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /Line|FBAN|FBAV|Instagram|Twitter|XAN|GSA|MicroMessenger/i.test(navigator.userAgent);
}

function getMicPermissionCopy(permissionState) {
  if (permissionState === "granted") {
    return {
      label: "録音スマホとして待機中",
      text: "PCで診療を開始すると、このスマホに自動接続します。画面を閉じずに置いてください。"
    };
  }

  if (permissionState === "prompt") {
    return {
      label: "初回のみマイク許可が必要",
      text: "マイクを有効化し、ブラウザの確認で「許可」を選ぶと次回以降の確認が減ります。"
    };
  }

  if (permissionState === "denied") {
    return {
      label: "マイクがブロックされています",
      text: "ブラウザのサイト設定でマイクを許可してから、この画面を再読み込みしてください。"
    };
  }

  if (permissionState === "unsupported") {
    return {
      label: "マイク許可状態を確認できません",
      text: "SafariまたはChromeのサイト設定で、マイクが許可されているか確認してください。"
    };
  }

  return {
    label: "マイク許可を確認中",
    text: "録音開始前に、この端末でマイクを使える状態か確認しています。"
  };
}

function mergeFloat32(left, right) {
  const merged = new Float32Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function downsampleToRate(input, inputSampleRate, outputSampleRate, carry) {
  const source = carry.length ? mergeFloat32(carry, input) : input;

  if (inputSampleRate === outputSampleRate) {
    return { samples: source, carry: new Float32Array(0) };
  }

  if (inputSampleRate < outputSampleRate) {
    throw new Error("この端末のマイク設定には対応していません。別の端末かブラウザをお試しください。");
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(source.length / ratio);

  if (outputLength <= 0) {
    return { samples: new Float32Array(0), carry: source };
  }

  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(source.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += source[cursor];
    }
    output[index] = sum / Math.max(1, end - start);
  }

  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: source.slice(consumed) };
}

function calculateRms(input) {
  if (!input.length) {
    return 0;
  }

  let sumSquares = 0;
  for (let index = 0; index < input.length; index += 1) {
    sumSquares += input[index] * input[index];
  }

  return Math.sqrt(sumSquares / input.length);
}

function pcm16BytesFromFloat32(input) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

const STATUS_MAP = {
  disconnected: "未接続",
  connected: "診療画面に接続済み",
  mic_ready: "マイク準備完了",
  recording: "録音中",
  remote_standby: "PC録音が選択されています",
  remote_recording: "PC側で録音中",
  stopped: "録音終了"
};

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const MIC_ICON = (
  <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const PLAY_ICON = (
  <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" stroke="none" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const STOP_ICON = (
  <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" stroke="none" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function readPairingFromLocation() {
  if (typeof window === "undefined") {
    return {
      pairingId: "",
      token: ""
    };
  }

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  return {
    pairingId: hashParams.get("pairingId") || searchParams.get("pairingId") || "",
    token: hashParams.get("token") || searchParams.get("token") || ""
  };
}

function clearPairingSecretFromLocation() {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("pairingId");
  url.searchParams.delete("token");
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  hashParams.delete("pairingId");
  hashParams.delete("token");
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function parsePairingFromText(value) {
  const text = String(value || "").trim();

  if (!text) {
    return {
      pairingId: "",
      token: ""
    };
  }

  try {
    const parsedUrl = new URL(text, typeof window === "undefined" ? "https://app.halunasu.com" : window.location.origin);
    const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
    const pairingId = hashParams.get("pairingId") || parsedUrl.searchParams.get("pairingId") || "";
    const token = hashParams.get("token") || parsedUrl.searchParams.get("token") || "";

    if (pairingId || token) {
      return {
        pairingId,
        token
      };
    }

    const looseParams = new URLSearchParams(text.replace(/^[?#]/, ""));
    return {
      pairingId: looseParams.get("pairingId") || "",
      token: looseParams.get("token") || ""
    };
  } catch {
    const hashParams = new URLSearchParams(text.replace(/^#/, ""));
    return {
      pairingId: hashParams.get("pairingId") || "",
      token: hashParams.get("token") || ""
    };
  }
}

export function MobileJoinClient({ initialPairingId, initialToken }) {
  const { accessToken, isHydrated, setAccessToken, clearAccess } = useOperatorAccess();
  const [pairingId, setPairingId] = useState(initialPairingId || "");
  const [token, setToken] = useState(initialToken || "");
  const [sessionInfo, setSessionInfo] = useState(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("disconnected"); // disconnected | standby | connected | mic_ready | recording | remote_standby | remote_recording | stopped
  const [trustedRecorder, setTrustedRecorder] = useState(null);
  const [level, setLevel] = useState(0);
  const [recordingStartedAt, setRecordingStartedAt] = useState(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [isActionPending, setIsActionPending] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [micPermissionState, setMicPermissionState] = useState("unknown");
  const [embeddedBrowserWarning, setEmbeddedBrowserWarning] = useState(false);
  const [scannerMode, setScannerMode] = useState("idle"); // idle | camera
  const [scannerMessage, setScannerMessage] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [showManualConnect, setShowManualConnect] = useState(false);
  const [autoMicState, setAutoMicState] = useState("idle"); // idle | checking | ready | action_required | failed
  const [knownMicAccess, setKnownMicAccess] = useState(false);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const scannerVideoRef = useRef(null);
  const scannerStreamRef = useRef(null);
  const scannerActiveRef = useRef(false);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorNodeRef = useRef(null);
  const muteNodeRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const isStreamingRef = useRef(false);
  const resampleTailRef = useRef(new Float32Array(0));
  const noiseFloorRef = useRef(AUDIO_GATE_INITIAL_NOISE_FLOOR);
  const audioGateOpenUntilRef = useRef(0);
  const deviceIdRef = useRef("");
  const pairingClaimInFlightRef = useRef(null);
  const trustedRecorderRef = useRef(null);
  const autoMicAttemptedRef = useRef(false);
  const assignmentPollRef = useRef(null);

  useEffect(() => {
    const locationPairing = readPairingFromLocation();

    if (locationPairing.pairingId && locationPairing.token) {
      setPairingId(locationPairing.pairingId);
      setToken(locationPairing.token);
    }
  }, []);

  useEffect(() => {
    const nextDeviceId = getOrCreateMobileDeviceId();
    deviceIdRef.current = nextDeviceId;
    setDeviceId(nextDeviceId);
    setEmbeddedBrowserWarning(isLikelyInAppBrowser());
    setKnownMicAccess(hasStoredMicAccess());
    refreshMicPermissionState();
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(assignmentPollRef.current);
      cleanupScanner({ resetMode: false });
      cleanupAudio();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  async function refreshMicPermissionState() {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) {
      setMicPermissionState("unsupported");
      return;
    }

    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      const applyPermissionState = (nextState) => {
        setMicPermissionState(nextState);
        if (nextState === "denied") {
          clearStoredMicAccess();
          setKnownMicAccess(false);
        }
      };
      applyPermissionState(status.state);
      status.onchange = () => applyPermissionState(status.state);
    } catch {
      setMicPermissionState("unsupported");
    }
  }

  function requireDeviceId() {
    if (!deviceIdRef.current) {
      throw new Error("録音用スマホの端末IDを準備しています。数秒後にもう一度お試しください。");
    }

    return deviceIdRef.current;
  }

  function cleanupScanner({ resetMode = true } = {}) {
    scannerActiveRef.current = false;
    if (scannerStreamRef.current) {
      for (const track of scannerStreamRef.current.getTracks()) track.stop();
    }
    scannerStreamRef.current = null;
    if (scannerVideoRef.current) {
      scannerVideoRef.current.srcObject = null;
    }
    if (resetMode) {
      setScannerMode("idle");
    }
  }

  function cleanupAudio() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "mic.disabled" }));
    }
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    isStreamingRef.current = false;
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    muteNodeRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => {});
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    analyserRef.current = null;
    muteNodeRef.current = null;
    audioContextRef.current = null;
    resampleTailRef.current = new Float32Array(0);
    noiseFloorRef.current = AUDIO_GATE_INITIAL_NOISE_FLOOR;
    audioGateOpenUntilRef.current = 0;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
    }
    streamRef.current = null;
  }

  function notifyMicReady() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "mic.ready"
      }));
    }
  }

  function shouldSendAudioFrame(rms) {
    const currentFloor = Math.max(noiseFloorRef.current || AUDIO_GATE_INITIAL_NOISE_FLOOR, AUDIO_GATE_INITIAL_NOISE_FLOOR);
    const threshold = Math.max(AUDIO_GATE_MIN_RMS, currentFloor * AUDIO_GATE_NOISE_MULTIPLIER);
    const now = performance.now();

    if (rms >= threshold) {
      audioGateOpenUntilRef.current = now + AUDIO_GATE_HANGOVER_MS;
      return true;
    }

    // Adapt only on quiet frames so sustained room noise does not become speech.
    noiseFloorRef.current = currentFloor * 0.98 + rms * 0.02;
    return now <= audioGateOpenUntilRef.current;
  }

  async function claimPairing(nextPairing = {}) {
    setError("");
    const currentPairingId = (nextPairing.pairingId || pairingId).trim();
    const currentToken = (nextPairing.token || token).trim();
    const shouldSendOperatorAuth = Boolean(nextPairing.useOperatorAuth && accessToken);
    const currentDeviceId = requireDeviceId();

    if (!currentPairingId || !currentToken) {
      throw new Error("接続IDと接続キーが必要です。");
    }

    const claimKey = `${currentPairingId}:${currentToken}`;
    if (pairingClaimInFlightRef.current === claimKey) {
      return;
    }

    pairingClaimInFlightRef.current = claimKey;

    try {
      const claimOptions = {
        method: "POST",
        body: JSON.stringify({
          token: currentToken,
          deviceId: currentDeviceId,
          deviceInfo: { platform: navigator.platform, browser: navigator.userAgent }
        })
      };
      const response = shouldSendOperatorAuth
        ? await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/pairings/${currentPairingId}/claim`, claimOptions, accessToken)
        : await fetch(`${getGatewayBaseUrl()}/api/v1/pairings/${currentPairingId}/claim`, {
            ...claimOptions,
            credentials: "omit",
            headers: { "Content-Type": "application/json" }
          });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "接続に失敗しました。パソコンから接続し直してください。" }));
        throw new Error(payload.error || "接続に失敗しました。パソコンから接続し直してください。");
      }
      const data = await response.json();
      setPairingId(currentPairingId);
      setToken("");
      setSessionInfo(data);
      setPhase("connected");
      clearPairingSecretFromLocation();
      await connectWebSocket(data, currentPairingId);

      if (!streamRef.current && micPermissionState === "granted") {
        await enableMicrophone();
      }
    } finally {
      pairingClaimInFlightRef.current = null;
    }
  }

  async function connectFromPairingText(value) {
    const parsed = parsePairingFromText(value);

    if (!parsed.pairingId || !parsed.token) {
      throw new Error("QRコードまたは接続リンクから接続情報を読み取れませんでした。");
    }

    cleanupScanner();
    await claimPairing({
      ...parsed,
      useOperatorAuth: Boolean(accessToken)
    });
  }

  async function connectWebSocket(data, claimedPairingId = pairingId) {
    const ws = new WebSocket(data.wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "auth.hello",
        role: "mobile",
        sessionId: data.sessionId,
        token: data.streamToken,
        deviceId: deviceIdRef.current || deviceId,
        pairingId: claimedPairingId
      }));
      ws.send(JSON.stringify({
        type: "audio.metadata",
        sampleRateHz: TARGET_SAMPLE_RATE,
        channels: 1,
        encoding: "pcm16",
        transport: "raw_pcm",
        mimeType: "audio/pcm"
      }));
      if (streamRef.current) {
        notifyMicReady();
      }
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "session.state.updated") {
        if (message.status === "recording") {
          if (message.audioSourceType === "local_browser") {
            setPhase("remote_recording");
            isStreamingRef.current = false;
          } else {
            audioContextRef.current?.resume?.().catch(() => {});
            setPhase("recording");
            isStreamingRef.current = true;
          }
          setIsActionPending(false);
        }
        if (["finalizing", "soap_ready", "approved", "stopped"].includes(message.status)) {
          setPhase("stopped");
          isStreamingRef.current = false;
          setIsActionPending(false);
          if (trustedRecorderRef.current && ["finalizing", "soap_ready", "approved"].includes(message.status)) {
            setTimeout(() => {
              if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
              }
              setSessionInfo(null);
              setError("");
              setPhase(streamRef.current ? "standby" : "standby");
            }, 1200);
          }
        }
        if (message.status === "degraded_recording") {
          setPhase("mic_ready");
          isStreamingRef.current = false;
          setIsActionPending(false);
          setError("録音中に接続が不安定になりました。必要ならスマホから録音を開始し直してください。");
        }
        if (["ready", "paired"].includes(message.status)) {
          if (message.audioSourceType === "local_browser") {
            setPhase("remote_standby");
          } else if (message.mobileConnectionState === "mic_ready") {
            setPhase("mic_ready");
          } else if (message.mobileConnectionState === "connected") {
            setPhase(streamRef.current ? "mic_ready" : "connected");
          }
          isStreamingRef.current = false;
        }
      }

      if (message.type === "recording.stopped") {
        setPhase("stopped");
        setIsActionPending(false);
      }
      if (message.type === "recording.discarded") {
        isStreamingRef.current = false;
        setIsActionPending(false);
        setError("");
        setPhase(streamRef.current ? "mic_ready" : "connected");
        notifyMicReady();
      }
      if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (message.type === "error") setError(message.message);
    });
  }

  async function enableMicrophone() {
    setError("");
    setAutoMicState("checking");
    if (streamRef.current) {
      setMicPermissionState("granted");
      setAutoMicState("ready");
      setPhase((current) => (current === "standby" || current === "remote_standby" ? current : "mic_ready"));
      notifyMicReady();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermissionState("unsupported");
      setAutoMicState("failed");
      throw new Error("このブラウザではマイクを使用できません。SafariまたはChromeで開き直してください。");
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (nextError) {
      if (nextError?.name === "NotAllowedError" || nextError?.name === "PermissionDeniedError") {
        setMicPermissionState("denied");
        setAutoMicState("action_required");
        clearStoredMicAccess();
        setKnownMicAccess(false);
      } else {
        refreshMicPermissionState();
        setAutoMicState("failed");
      }
      throw nextError;
    }

    streamRef.current = stream;
    setMicPermissionState("granted");
    setAutoMicState("ready");
    refreshMicPermissionState();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
      setAutoMicState("failed");
      clearStoredMicAccess();
      setKnownMicAccess(false);
      throw new Error("このブラウザでは音声処理を開始できません。SafariまたはChromeで開き直してください。");
    }

    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    const source = audioContext.createMediaStreamSource(stream);
    sourceNodeRef.current = source;
    source.connect(analyser);

    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorNodeRef.current = processor;

    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    muteNodeRef.current = muteNode;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const rms = calculateRms(input);

      if (!isStreamingRef.current) {
        noiseFloorRef.current = noiseFloorRef.current * 0.95 + rms * 0.05;
        resampleTailRef.current = new Float32Array(0);
        return;
      }

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (!shouldSendAudioFrame(rms)) {
        resampleTailRef.current = new Float32Array(0);
        return;
      }

      const { samples, carry } = downsampleToRate(input, audioContext.sampleRate, TARGET_SAMPLE_RATE, resampleTailRef.current);
      resampleTailRef.current = carry;
      if (!samples.length) return;
      wsRef.current.send(pcm16BytesFromFloat32(samples));
    };

    source.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      setLevel(Math.min(100, Math.round((average / 255) * 100)));
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();

    storeMicAccessReady();
    setKnownMicAccess(true);
    setPhase((current) => (current === "standby" || current === "remote_standby" ? current : "mic_ready"));
    notifyMicReady();
  }

  async function startQrScanner() {
    setError("");
    setScannerMessage("");

    if (typeof window === "undefined" || !window.BarcodeDetector) {
      setScannerMessage("このブラウザではQR読み取りに対応していません。PC画面の接続リンクをコピーして下の欄に貼り付けてください。");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setScannerMessage("このブラウザではカメラを使用できません。接続リンクを貼り付けて接続してください。");
      return;
    }

    cleanupScanner();
    setScannerMode("camera");

    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const video = scannerVideoRef.current;

      if (!video) {
        throw new Error("QR読み取り画面を準備できませんでした。もう一度お試しください。");
      }

      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" }
        },
        audio: false
      });

      scannerStreamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      scannerActiveRef.current = true;
      setScannerMessage("PC画面の接続QRをカメラに映してください。");

      const scan = async () => {
        if (!scannerActiveRef.current) {
          return;
        }

        try {
          const codes = await detector.detect(video);
          const rawValue = codes.find((code) => code.rawValue)?.rawValue || "";

          if (rawValue) {
            scannerActiveRef.current = false;
            setScannerMessage("接続情報を読み取りました。診療画面へ接続しています。");
            connectFromPairingText(rawValue).catch((nextError) => {
              setError(nextError.message);
              setScannerMessage(nextError.message);
              cleanupScanner();
            });
            return;
          }
        } catch {
          // Ignore single-frame scan failures and continue scanning.
        }

        requestAnimationFrame(scan);
      };

      requestAnimationFrame(scan);
    } catch (nextError) {
      cleanupScanner();
      setScannerMessage(nextError.message || "QR読み取りを開始できませんでした。");
    }
  }

  async function connectFromManualInput() {
    setError("");
    setScannerMessage("");
    await connectFromPairingText(pairingInput);
    setPairingInput("");
  }

  async function registerTrustedRecorder() {
    const currentDeviceId = requireDeviceId();
    const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/mobile/recorders/register`, {
      method: "POST",
      body: JSON.stringify({
        deviceId: currentDeviceId,
        label: navigator.platform || "mobile-browser"
      })
    }, accessToken);

    if (!response.ok) {
      if (response.status === 401) {
        clearAccess();
      }
      const payload = await response.json().catch(() => ({ error: "待機端末の登録に失敗しました。" }));
      throw new Error(payload.error || "待機端末の登録に失敗しました。");
    }

    const data = await response.json();
    setTrustedRecorder(data);
    trustedRecorderRef.current = data;
    setPhase("standby");

    if (data.assignment && !sessionInfo) {
      setSessionInfo(data.assignment);
      await connectWebSocket(data.assignment, data.assignment.pairingId);
      setPhase(streamRef.current ? "mic_ready" : "connected");
    }
  }

  async function pollTrustedRecorderAssignment() {
    if (!accessToken || pairingId || token || sessionInfo) {
      return;
    }

    const currentDeviceId = requireDeviceId();
    const response = await fetchWithOperatorAuth(
      `${getGatewayBaseUrl()}/api/v1/mobile/recorders/assignment?deviceId=${encodeURIComponent(currentDeviceId)}`,
      {
        cache: "no-store"
      },
      accessToken
    );

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (data.assignment && !sessionInfo) {
      setSessionInfo(data.assignment);
      setError("");
      await connectWebSocket(data.assignment, data.assignment.pairingId);
      setPhase(streamRef.current ? "mic_ready" : "connected");
    }
  }

  async function startRecordingFromMobile() {
    if (!sessionInfo?.streamToken) {
      throw new Error("録音開始に必要な接続情報がありません。パソコンから接続し直してください。");
    }

    notifyMicReady();
    audioContextRef.current?.resume?.().catch(() => {});
    setIsActionPending(true);

    try {
      const currentDeviceId = requireDeviceId();
      const response = await fetch(`${getGatewayBaseUrl()}/api/v1/mobile/sessions/${sessionInfo.sessionId}/recording/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionInfo.streamToken}`
        },
        body: JSON.stringify({
          deviceId: currentDeviceId
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "録音を開始できませんでした。" }));
        throw new Error(payload.error || "録音を開始できませんでした。");
      }

      setPhase("recording");
      isStreamingRef.current = true;
      setIsActionPending(false);
    } catch (nextError) {
      setIsActionPending(false);
      throw nextError;
    }
  }

  async function stopRecordingFromMobile() {
    if (!sessionInfo?.streamToken) {
      throw new Error("録音停止に必要な接続情報がありません。パソコンから接続し直してください。");
    }

    setIsActionPending(true);

    try {
      const response = await fetch(`${getGatewayBaseUrl()}/api/v1/mobile/sessions/${sessionInfo.sessionId}/recording/stop`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionInfo.streamToken}`
        },
        body: JSON.stringify({
          deviceId,
          enqueueSoapGeneration: false
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "録音を停止できませんでした。" }));
        throw new Error(payload.error || "録音を停止できませんでした。");
      }

      setPhase("stopped");
      isStreamingRef.current = false;
      setIsActionPending(false);
    } catch (nextError) {
      setIsActionPending(false);
      throw nextError;
    }
  }

  // Recording timer
  useEffect(() => {
    if (phase === "recording") {
      if (!recordingStartedAt) setRecordingStartedAt(Date.now());
      const interval = setInterval(() => {
        setRecordingElapsed(Date.now() - (recordingStartedAt || Date.now()));
      }, 1000);
      return () => clearInterval(interval);
    }
    if (phase !== "recording" && recordingStartedAt) {
      setRecordingStartedAt(null);
    }
  }, [phase, recordingStartedAt]);

  useEffect(() => {
    if (pairingId && token && !sessionInfo && deviceId) {
      claimPairing({ pairingId, token }).catch((e) => setError(e.message));
    }
  }, [pairingId, token, sessionInfo, deviceId]);

  useEffect(() => {
    if (!isHydrated || !accessToken || pairingId || token || sessionInfo || !deviceId) {
      clearInterval(assignmentPollRef.current);
      return undefined;
    }

    registerTrustedRecorder().catch((e) => setError(e.message));
    assignmentPollRef.current = setInterval(() => {
      pollTrustedRecorderAssignment().catch(() => {});
    }, 2500);

    return () => clearInterval(assignmentPollRef.current);
  }, [isHydrated, accessToken, pairingId, token, sessionInfo, deviceId]);

  useEffect(() => {
    if (
      !isHydrated ||
      !deviceId ||
      streamRef.current ||
      (micPermissionState !== "granted" && !knownMicAccess) ||
      autoMicAttemptedRef.current ||
      scannerMode === "camera"
    ) {
      return;
    }

    if (!accessToken && !sessionInfo) {
      return;
    }

    autoMicAttemptedRef.current = true;
    setAutoMicState("checking");
    enableMicrophone().catch(() => {
      setAutoMicState("action_required");
      // If the browser requires a user gesture, keep the manual mic button visible.
    });
  }, [isHydrated, deviceId, accessToken, sessionInfo, micPermissionState, knownMicAccess, scannerMode]);

  const isRecording = phase === "recording";
  const hasPreparedMic = Boolean(streamRef.current);
  const canAutoPrepareMic = micPermissionState === "granted" || (knownMicAccess && micPermissionState !== "denied");
  const displayMicPermissionState = canAutoPrepareMic ? "granted" : micPermissionState;
  const micPermissionCopy = getMicPermissionCopy(displayMicPermissionState);
  const shouldShowMicSetup = !hasPreparedMic && (!canAutoPrepareMic || autoMicState === "action_required" || autoMicState === "failed");

  function activateMicrophone() {
    enableMicrophone().catch((e) => setError(e.message));
  }

  function renderMicPermissionStatus({ compact = false } = {}) {
    return (
      <>
        <div className={`mobile-permission-status mobile-permission-status--${displayMicPermissionState}`}>
          <span className="mobile-permission-status-label">{micPermissionCopy.label}</span>
          {!compact ? <span className="mobile-permission-status-text">{micPermissionCopy.text}</span> : null}
        </div>
        {embeddedBrowserWarning ? (
          <p className="mobile-notice mobile-notice--warning">
            アプリ内ブラウザではマイク許可が保存されにくいことがあります。SafariまたはChrome、可能ならホーム画面に追加した画面から開いてください。
          </p>
        ) : null}
      </>
    );
  }

  function renderMicSetupButton({ label = "マイクを許可する" } = {}) {
    return (
      <div className="record-button-area">
        <button
          className="record-button record-button--ready"
          disabled={autoMicState === "checking"}
          onClick={activateMicrophone}
          type="button"
          aria-label={hasPreparedMic ? "マイク準備完了" : "マイクを許可する"}
        >
          {MIC_ICON}
        </button>
        <span className="record-label">
          {autoMicState === "checking"
            ? "マイクを準備しています..."
            : hasPreparedMic
              ? "マイクの準備ができています。このまま待機します。"
              : label}
        </span>
      </div>
    );
  }

  if (!isHydrated) {
    return null;
  }

  if (!pairingId && !token && !accessToken) {
    return (
      <OperatorLoginPanel
        onAuthenticated={setAccessToken}
        title="録音用スマホにログイン"
        description="このスマホを録音用に設定すると、次回以降はパソコンの診療画面へ自動接続できます。"
      />
    );
  }

  return (
    <main className="mobile-page">
      <section className="mobile-shell card">
        {!pairingId && !token && accessToken && !sessionInfo && (
          <>
            <h1>録音用スマホ</h1>
            <p className="mobile-status-text">
              {hasPreparedMic
                ? "この画面を開いたまま置いてください。パソコンで診療を始めると自動でつながります。"
                : canAutoPrepareMic
                  ? "保存済みのマイク許可を使って、自動で録音待機を準備しています。"
                : autoMicState === "checking"
                  ? "マイクを準備しています。このままお待ちください。"
                  : "初回だけマイクを許可してください。次回以降はこの画面を開くだけで待機できます。"}
            </p>

            {hasPreparedMic ? renderMicPermissionStatus({ compact: true }) : renderMicPermissionStatus()}
            {shouldShowMicSetup ? renderMicSetupButton({ label: "タップしてマイクを許可してください。" }) : null}

            <div className="mobile-session-info">
              <span className="mobile-session-info-label">状態</span>
              <span className="mobile-session-info-value">
                {trustedRecorder ? "PCからの接続を待っています" : "待機を準備しています"}
              </span>
            </div>

            <button className="btn btn--ghost" onClick={() => setShowManualConnect((current) => !current)} type="button">
              {showManualConnect ? "手動接続を閉じる" : "手動で接続する"}
            </button>
            {showManualConnect ? (
              <div className="mobile-recorder-connect">
                <div className="mobile-recorder-connect-copy">
                  <span className="mobile-session-info-label">手動接続</span>
                  <p>自動接続できない場合だけ、PC画面のQRまたは接続リンクを使ってください。</p>
                </div>
                <div className="mobile-recorder-connect-actions">
                  <button className="btn btn--primary" onClick={() => startQrScanner()} type="button">
                    QRを読み取る
                  </button>
                  {scannerMode === "camera" ? (
                    <button className="btn btn--ghost" onClick={cleanupScanner} type="button">
                      読み取りを閉じる
                    </button>
                  ) : null}
                </div>
                {scannerMode === "camera" ? (
                  <div className="mobile-qr-scanner">
                    <video
                      className="mobile-qr-scanner-video"
                      muted
                      playsInline
                      ref={scannerVideoRef}
                    />
                  </div>
                ) : null}
                <div className="mobile-link-input">
                  <input
                    aria-label="接続リンク"
                    onChange={(event) => setPairingInput(event.target.value)}
                    placeholder="接続リンクを貼り付け"
                    value={pairingInput}
                  />
                  <button
                    className="btn btn--ghost"
                    disabled={!pairingInput.trim()}
                    onClick={() => connectFromManualInput().catch((e) => setError(e.message))}
                    type="button"
                  >
                    接続
                  </button>
                </div>
                {scannerMessage ? <p className="mobile-notice">{scannerMessage}</p> : null}
              </div>
            ) : null}

            <button className="btn btn--ghost" onClick={clearAccess} type="button">
              このスマホの待機を解除
            </button>
          </>
        )}

        {/* Phase: Not yet connected - show join form */}
        {phase === "disconnected" && (pairingId || token) && (
          <>
            <h1>診療画面に接続</h1>
            <div className="mobile-join-form">
              <div className="field">
                <label htmlFor="pairingId">接続ID</label>
                <input id="pairingId" value={pairingId} onChange={(e) => setPairingId(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="pairingToken">接続キー</label>
                <input id="pairingToken" value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
              <button
                className="btn btn--primary btn--lg"
                onClick={() => claimPairing({ pairingId, token }).catch((e) => setError(e.message))}
                type="button"
              >
                接続する
              </button>
            </div>
          </>
        )}

        {/* Phase: Connected but no mic yet */}
        {phase === "connected" && sessionInfo && (
          <>
            <h1>{hasPreparedMic || autoMicState === "checking" ? "録音準備中" : "マイクを許可してください"}</h1>
            {sessionInfo && (
              <div className="mobile-session-info">
                {sessionInfo.patientDisplayName && (
                  <>
                    <span className="mobile-session-info-label">患者名</span>
                    <span className="mobile-session-info-value">{sessionInfo.patientDisplayName}</span>
                  </>
                )}
                {sessionInfo.visitReason && (
                  <>
                    <span className="mobile-session-info-label">受診理由</span>
                    <span className="mobile-session-info-value">{sessionInfo.visitReason}</span>
                  </>
                )}
              </div>
            )}
            <p className="mobile-status-text">
              {hasPreparedMic
                ? "マイクの準備ができています。PCまたはスマホから録音を開始できます。"
                : canAutoPrepareMic
                  ? "保存済みのマイク許可を使って準備しています。"
                : autoMicState === "checking"
                  ? "保存済みのマイク許可を使って準備しています。"
                  : "初回だけマイクを許可してください。"}
            </p>
            {shouldShowMicSetup ? renderMicPermissionStatus() : renderMicPermissionStatus({ compact: true })}
            {shouldShowMicSetup ? renderMicSetupButton({ label: "タップしてマイクを許可してください。" }) : null}
          </>
        )}

        {/* Phase: Mic ready or recording or stopped */}
        {["mic_ready", "recording", "remote_standby", "remote_recording", "stopped"].includes(phase) && sessionInfo && (
          <>
            <h1>{isRecording ? "録音中" : phase === "remote_recording" ? "PC側で録音中" : phase === "remote_standby" ? "PC録音が選択されています" : phase === "stopped" ? "録音終了" : "録音開始待ち"}</h1>

            {isRecording && (
              <span className="record-timer">{formatElapsed(recordingElapsed)}</span>
            )}

            <div className="record-button-area">
              <button
                className={`record-button ${isRecording ? "record-button--active" : phase === "mic_ready" ? "record-button--ready" : ""}`}
                disabled={isActionPending || (!isRecording && phase !== "mic_ready")}
                onClick={() => {
                  if (phase === "mic_ready") {
                    startRecordingFromMobile().catch((e) => setError(e.message));
                    return;
                  }

                  if (phase === "recording") {
                    stopRecordingFromMobile().catch((e) => setError(e.message));
                  }
                }}
                type="button"
                aria-label={isActionPending ? "処理中" : isRecording ? "録音停止" : phase === "stopped" ? "録音終了" : phase === "mic_ready" ? "録音開始" : "待機中"}
              >
              {isActionPending ? <span className="record-button-spinner" aria-hidden="true" /> : isRecording ? STOP_ICON : phase === "stopped" ? CHECK_ICON : phase === "mic_ready" ? PLAY_ICON : MIC_ICON}
              </button>

              {isRecording && !isActionPending && <span className="record-label">タップで録音を停止します。パソコン画面にもすぐ反映されます。</span>}
              {isRecording && isActionPending && <span className="record-label">録音を停止しています...</span>}
              {phase === "remote_standby" && <span className="record-label">このスマホでは録音を開始しません。PC画面で録音を開始してください。</span>}
              {phase === "remote_recording" && <span className="record-label">このスマホは待機中です。PCのマイクで録音しています。</span>}
              {phase === "mic_ready" && <span className="record-label">タップで録音開始</span>}
              {phase === "stopped" && <span className="record-label">録音が終わりました。パソコン画面で患者情報を確認し、SOAP下書きを作成してください。</span>}
            </div>

            <div className="level-meter" role="meter" aria-label="マイク入力レベル" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}>
              <div className="level-meter-fill" style={{ width: `${level}%` }} />
            </div>

            <span className="mobile-status-text">{STATUS_MAP[phase]}</span>
          </>
        )}

        {error ? <div className="inline-error">{error}</div> : null}

        <p className="mobile-notice">
          音声は診療画面へリアルタイムで送信されます。画面を閉じず、できれば同じブラウザから続けてお使いください。
        </p>
      </section>
    </main>
  );
}
