"use client";

import { useEffect, useRef, useState } from "react";
import { getGatewayBaseUrl } from "../lib/runtime-config";

const AUDIO_TEST_DEVICE_ID_STORAGE_KEY = "soaplane.mobileAudioTest.deviceId";
const AUDIO_TEST_UPDATE_INTERVAL_MS = 1000;

function createAudioTestDeviceId() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return `atest_${window.crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }

  return `atest_${Math.random().toString(36).slice(2, 12)}`;
}

function getOrCreateAudioTestDeviceId() {
  if (typeof window === "undefined") {
    return createAudioTestDeviceId();
  }

  try {
    const stored = window.localStorage.getItem(AUDIO_TEST_DEVICE_ID_STORAGE_KEY);
    if (stored) {
      return stored;
    }

    const next = createAudioTestDeviceId();
    window.localStorage.setItem(AUDIO_TEST_DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return createAudioTestDeviceId();
  }
}

function readAudioTestFromLocation(initialTestId = null, initialToken = null) {
  if (typeof window === "undefined") {
    return {
      testId: initialTestId || "",
      token: initialToken || ""
    };
  }

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  return {
    testId: hashParams.get("testId") || searchParams.get("testId") || initialTestId || "",
    token: hashParams.get("token") || searchParams.get("token") || initialToken || ""
  };
}

function clearAudioTestSecretFromLocation() {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("testId");
  url.searchParams.delete("token");
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  hashParams.delete("testId");
  hashParams.delete("token");
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function calculateSignal(input) {
  if (!input.length) {
    return { rms: 0 };
  }

  let sumSquares = 0;

  for (let index = 0; index < input.length; index += 1) {
    sumSquares += input[index] * input[index];
  }

  return {
    rms: Math.sqrt(sumSquares / input.length)
  };
}

function getPermissionCopy(permissionState) {
  if (permissionState === "granted") {
    return {
      label: "マイクは許可済みです",
      text: "このままスマホで声を出すと、パソコン側の音声テスト画面に入力レベルを返します。"
    };
  }

  if (permissionState === "prompt") {
    return {
      label: "マイク許可を待っています",
      text: "スマホの確認ダイアログでマイクを許可してください。"
    };
  }

  if (permissionState === "denied") {
    return {
      label: "マイクが拒否されています",
      text: "Safari または Chrome のサイト設定からマイクを許可して、もう一度開き直してください。"
    };
  }

  if (permissionState === "unsupported") {
    return {
      label: "このブラウザでは確認できません",
      text: "Safari または Chrome で開いてください。"
    };
  }

  return {
    label: "接続準備中です",
    text: "パソコン側が発行したQRで開くと、このページでスマホマイクの確認を行います。"
  };
}

function buildDeviceLabel() {
  if (typeof navigator === "undefined") {
    return "モバイル端末";
  }

  if (/iPhone/i.test(navigator.userAgent)) {
    return "iPhone";
  }

  if (/iPad/i.test(navigator.userAgent)) {
    return "iPad";
  }

  return "モバイル端末";
}

function buildPhaseCopy(phase) {
  switch (phase) {
    case "claiming":
      return "パソコンと接続しています。";
    case "prompting":
      return "スマホのマイク許可を待っています。";
    case "ready":
      return "パソコン側へ入力レベルを送信中です。";
    case "blocked":
      return "マイクが拒否されているため、パソコン側へ入力を返せません。";
    case "expired":
      return "このQRは期限切れです。パソコン側で新しいQRを発行してください。";
    case "completed":
      return "スマホのマイクテストを終了しました。";
    case "error":
      return "スマホのマイクテストを開始できませんでした。";
    default:
      return "接続情報を確認しています。";
  }
}

async function postAudioTestJson(path, body, { keepalive = false } = {}) {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    keepalive
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "音声テストの更新に失敗しました。");
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

export function MobileAudioTestClient({
  initialTestId = null,
  initialToken = null
}) {
  const [testId, setTestId] = useState("");
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState("booting");
  const [permissionState, setPermissionState] = useState("unknown");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [inputLabel, setInputLabel] = useState("");
  const [isCompleting, setIsCompleting] = useState(false);
  const deviceIdRef = useRef("");
  const levelRef = useRef(0);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(0);
  const intervalRef = useRef(0);
  const permissionStateRef = useRef("unknown");
  const inputLabelRef = useRef("");
  const sampleRateRef = useRef(null);

  useEffect(() => {
    const next = readAudioTestFromLocation(initialTestId, initialToken);
    setTestId(next.testId);
    setToken(next.token);
    clearAudioTestSecretFromLocation();
  }, [initialTestId, initialToken]);

  useEffect(() => {
    permissionStateRef.current = permissionState;
  }, [permissionState]);

  useEffect(() => {
    inputLabelRef.current = inputLabel;
  }, [inputLabel]);

  useEffect(() => {
    if (!testId || !token) {
      setPhase("error");
      setPermissionState("unknown");
      setError("接続情報が見つかりません。パソコン側でQRを再発行してください。");
      return undefined;
    }

    let cancelled = false;

    async function syncState(nextPatch, options = {}) {
      if (!testId || !token || !deviceIdRef.current) {
        return;
      }

      try {
        await postAudioTestJson(`/api/v1/audio-tests/${encodeURIComponent(testId)}/state`, {
          token,
          deviceId: deviceIdRef.current,
          ...nextPatch
        }, options);
      } catch (nextError) {
        if (!cancelled && nextError.statusCode === 410) {
          if (intervalRef.current) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = 0;
          }
          if (animationFrameRef.current) {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = 0;
          }
          setPhase("expired");
          setError(nextError.message);
        }
      }
    }

    async function boot() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setPhase("error");
        setPermissionState("unsupported");
        setError("このブラウザではスマホのマイクテストを利用できません。Safari または Chrome で開き直してください。");
        return;
      }

      const deviceId = getOrCreateAudioTestDeviceId();
      deviceIdRef.current = deviceId;
      setPhase("claiming");
      setError("");

      try {
        await postAudioTestJson(`/api/v1/audio-tests/${encodeURIComponent(testId)}/claim`, {
          token,
          deviceId,
          deviceLabel: buildDeviceLabel()
        });
      } catch (nextError) {
        if (nextError.statusCode === 410) {
          setPhase("expired");
        } else {
          setPhase("error");
        }
        setError(nextError.message || "パソコンとの接続に失敗しました。");
        return;
      }

      let nextPermissionState = "unknown";
      try {
        if (navigator.permissions?.query) {
          const permission = await navigator.permissions.query({ name: "microphone" });
          nextPermissionState = permission.state || "unknown";
        }
      } catch {
        nextPermissionState = "unknown";
      }

      if (cancelled) {
        return;
      }

      if (nextPermissionState === "denied") {
        setPermissionState("denied");
        setPhase("blocked");
        await syncState({
          permissionState: "denied",
          deviceState: "blocked",
          level: 0,
          deviceLabel: buildDeviceLabel()
        });
        return;
      }

      setPermissionState(nextPermissionState);
      setPhase("prompting");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          throw new Error("このブラウザではスマホのマイクテストを開始できません。");
        }

        const audioContext = new AudioContextClass();
        await audioContext.resume?.().catch(() => {});

        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        const sourceNode = audioContext.createMediaStreamSource(stream);
        const muteNode = audioContext.createGain();
        muteNode.gain.value = 0;
        sourceNode.connect(analyser);
        analyser.connect(muteNode);
        muteNode.connect(audioContext.destination);

        streamRef.current = stream;
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        const track = stream.getAudioTracks?.()[0] || null;
        const nextInputLabel = track?.label || "";
        const nextSampleRate = Number(audioContext.sampleRate || track?.getSettings?.().sampleRate || 0) || null;
        setInputLabel(nextInputLabel);
        sampleRateRef.current = nextSampleRate;
        setPermissionState("granted");
        setPhase("ready");

        const buffer = new Float32Array(analyser.fftSize);
        const tick = () => {
          const activeAnalyser = analyserRef.current;
          if (!activeAnalyser) {
            return;
          }

          activeAnalyser.getFloatTimeDomainData(buffer);
          const metrics = calculateSignal(buffer);
          levelRef.current = Math.min(100, Math.round(metrics.rms * 420));
          setLevel((current) => Math.round(current * 0.58 + levelRef.current * 0.42));
          animationFrameRef.current = window.requestAnimationFrame(tick);
        };
        animationFrameRef.current = window.requestAnimationFrame(tick);

        await syncState({
          permissionState: "granted",
          deviceState: "monitoring",
          level: 0,
          deviceLabel: nextInputLabel || buildDeviceLabel(),
          inputLabel: nextInputLabel || undefined,
          sampleRate: nextSampleRate || undefined
        });

        intervalRef.current = window.setInterval(() => {
          void syncState({
            permissionState: "granted",
            deviceState: "monitoring",
            level: levelRef.current,
            deviceLabel: nextInputLabel || buildDeviceLabel(),
            inputLabel: nextInputLabel || undefined,
            sampleRate: nextSampleRate || undefined
          });
        }, AUDIO_TEST_UPDATE_INTERVAL_MS);
      } catch (nextError) {
        const denied = nextError?.name === "NotAllowedError";
        setPermissionState(denied ? "denied" : nextPermissionState);
        setPhase(denied ? "blocked" : "error");
        setError(denied
          ? "スマホのマイクが許可されていません。サイト設定からマイクを許可してください。"
          : nextError?.message || "スマホのマイクテストを開始できませんでした。");

        await syncState({
          permissionState: denied ? "denied" : (nextPermissionState || "unknown"),
          deviceState: denied ? "blocked" : "idle",
          level: 0,
          deviceLabel: buildDeviceLabel()
        });
      }
    }

    void boot();

    return () => {
      cancelled = true;

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }

      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = 0;
      }

      if (deviceIdRef.current && testId && token) {
        void postAudioTestJson(`/api/v1/audio-tests/${encodeURIComponent(testId)}/state`, {
          token,
          deviceId: deviceIdRef.current,
          permissionState: permissionStateRef.current,
          deviceState: "idle",
          level: 0,
          deviceLabel: inputLabelRef.current || buildDeviceLabel(),
          inputLabel: inputLabelRef.current || undefined,
          sampleRate: sampleRateRef.current || undefined
        }, { keepalive: true }).catch(() => {});
      }

      for (const track of streamRef.current?.getTracks?.() || []) {
        track.stop();
      }
      streamRef.current = null;
      analyserRef.current = null;
      audioContextRef.current?.close?.().catch(() => {});
      audioContextRef.current = null;
    };
  }, [testId, token]);

  const permissionCopy = getPermissionCopy(permissionState);
  const levelWidth = `${Math.max(0, Math.min(100, level))}%`;
  const isProcessingPhase = !["ready", "completed", "expired", "blocked", "error"].includes(phase);

  async function completeAudioTest() {
    if (!testId || !token || !deviceIdRef.current) {
      return;
    }

    setIsCompleting(true);
    try {
      await postAudioTestJson(`/api/v1/audio-tests/${encodeURIComponent(testId)}/complete`, {
        token,
        deviceId: deviceIdRef.current
      });
      setPhase("completed");
      setLevel(0);
    } catch (nextError) {
      setError(nextError.message || "スマホのマイクテストを終了できませんでした。");
    } finally {
      setIsCompleting(false);
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = 0;
      }
      for (const track of streamRef.current?.getTracks?.() || []) {
        track.stop();
      }
      streamRef.current = null;
      analyserRef.current = null;
      audioContextRef.current?.close?.().catch(() => {});
      audioContextRef.current = null;
    }
  }

  return (
    <main className="mobile-page">
      <section className="mobile-shell card mobile-audio-test-shell">
        <div className="mobile-audio-test-hero">
          <h1>スマホのマイクテスト</h1>
          <p className="mobile-status-text">{buildPhaseCopy(phase)}</p>
          {isProcessingPhase ? (
            <div className="mobile-audio-test-loading">
              <div className="spinner spinner--small" aria-hidden="true" />
              <span>接続と権限を確認しています</span>
            </div>
          ) : null}
        </div>

        <div className={`mobile-permission-status mobile-permission-status--${permissionState}`}>
          <span className="mobile-permission-status-label">{permissionCopy.label}</span>
          <span className="mobile-permission-status-text">{permissionCopy.text}</span>
        </div>

        <div className="record-button-area">
          <div className={`record-button ${phase === "ready" ? "record-button--active" : "record-button--ready"}`} aria-hidden="true">
            <span className="record-label">{phase === "ready" ? "ON" : "MIC"}</span>
          </div>
          <span className="record-label">{phase === "ready" ? "入力を送信中" : "接続準備"}</span>
        </div>

        <div className="audio-test-level audio-test-mobile-level">
          <div className="audio-meter" aria-label={`スマホのマイク入力レベル ${Math.round(level)}%`}>
            <span style={{ width: levelWidth }} />
          </div>
          <div className="audio-test-meter-labels">
            <span>小さい</span>
            <span>適正</span>
            <span>大きい</span>
          </div>
        </div>

        <div className="mobile-audio-test-meta">
          <div>
            <span>入力名</span>
            <strong>{inputLabel || "マイク許可後に表示されます"}</strong>
          </div>
        </div>

        {!["completed", "expired"].includes(phase) ? (
          <div className="audio-test-actions audio-test-mobile-actions">
            <button className={`btn btn--ghost ${isCompleting ? "btn--loading" : ""}`} type="button" onClick={completeAudioTest} disabled={isCompleting}>
              {isCompleting ? <span className="btn-spinner" aria-hidden="true" /> : null}
              <span>{isCompleting ? "終了中..." : "テストを終了"}</span>
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="mobile-notice mobile-notice--warning">{error}</p>
        ) : (
          <p className="mobile-notice">音声そのものは保存しません。パソコン側へ返すのは許可状態と入力レベルだけです。</p>
        )}
      </section>
    </main>
  );
}
