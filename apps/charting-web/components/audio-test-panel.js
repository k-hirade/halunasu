"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  BROWSER_DEFAULT_AUDIO_INPUT,
  buildAudioInputConstraints,
  readAudioInputPreference,
  saveAudioInputPreference
} from "../lib/audio-input-preferences";
import { getGatewayBaseUrl } from "../lib/runtime-config";
import { fetchWithOperatorAuth } from "../lib/operator-access";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";
import { AdminSelect } from "./admin-select";
import { Icon } from "./icon";

const MOBILE_AUDIO_TEST_POLL_INTERVAL_MS = 1000;
const MOBILE_AUDIO_TEST_STALE_MS = 5000;

function formatSavedAt(value) {
  if (!value) {
    return "";
  }

  try {
    return new Date(value).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
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

function deviceLabel(device, index) {
  if (device.label) {
    return device.label;
  }

  return `マイク ${index + 1}`;
}

function isMobileAudioTestStale(audioTest) {
  if (!audioTest?.lastSeenAt) {
    return false;
  }

  const lastSeenAt = Date.parse(audioTest.lastSeenAt);
  if (!Number.isFinite(lastSeenAt)) {
    return false;
  }

  return Date.now() - lastSeenAt > MOBILE_AUDIO_TEST_STALE_MS;
}

function formatMobileAudioTestStatus(audioTest) {
  if (!audioTest) {
    return "未発行";
  }

  if (audioTest.status === "expired") {
    return "期限切れ";
  }

  if (audioTest.status === "completed") {
    return "終了";
  }

  if (isMobileAudioTestStale(audioTest) && ["connected", "monitoring"].includes(audioTest.deviceState)) {
    return "応答待ち";
  }

  switch (audioTest.deviceState) {
    case "monitoring":
      return "入力確認中";
    case "connected":
      return "接続済み";
    case "blocked":
      return "マイク拒否";
    case "idle":
      return "待機中";
    default:
      return "QR待ち";
  }
}

function formatMobilePermissionState(state) {
  switch (state) {
    case "granted":
      return "許可済み";
    case "prompt":
      return "許可待ち";
    case "denied":
      return "拒否";
    case "unsupported":
      return "未対応";
    default:
      return "未確認";
  }
}

export function AudioTestPanel({
  orgId,
  memberId,
  accessToken = null,
  onAuthExpired = null
}) {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(BROWSER_DEFAULT_AUDIO_INPUT);
  const [isPreferenceReady, setIsPreferenceReady] = useState(false);
  const [permissionState, setPermissionState] = useState("idle"); // idle | requesting | ready | error
  const [monitoring, setMonitoring] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedPreference, setSavedPreference] = useState(null);
  const [mobileTest, setMobileTest] = useState(null);
  const [mobileTestJoinUrl, setMobileTestJoinUrl] = useState("");
  const [mobileTestQrUrl, setMobileTestQrUrl] = useState("");
  const [mobileTestError, setMobileTestError] = useState("");
  const [mobileTestNotice, setMobileTestNotice] = useState("");
  const [isCreatingMobileTest, setIsCreatingMobileTest] = useState(false);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isCompletingMobileTest, setIsCompletingMobileTest] = useState(false);
  const graphRef = useRef(null);
  const levelRef = useRef(0);
  const autoStartAttemptedRef = useRef(false);
  const scope = useMemo(() => ({ orgId, memberId }), [orgId, memberId]);

  const inputOptions = useMemo(() => {
    const seen = new Set();
    const audioInputs = devices
      .filter((device) => device.kind === "audioinput")
      .filter((device) => {
        if (!device.deviceId || seen.has(device.deviceId)) {
          return false;
        }
        seen.add(device.deviceId);
        return true;
      });

    const options = [
      {
        value: BROWSER_DEFAULT_AUDIO_INPUT,
        label: "ブラウザ既定",
        description: "OSとブラウザの既定マイクを使います。"
      },
      ...audioInputs.map((device, index) => ({
        value: device.deviceId,
        label: deviceLabel(device, index),
        description: device.groupId ? "この端末で検出された入力です。" : "マイク許可後に名称が表示されます。"
      }))
    ];

    if (savedPreference?.deviceId && !seen.has(savedPreference.deviceId)) {
      options.push({
        value: savedPreference.deviceId,
        label: savedPreference.label || "保存済みのマイク",
        description: "前回このパソコンで保存した入力です。"
      });
    }

    return options;
  }, [devices, savedPreference]);

  const selectedOption = inputOptions.find((option) => option.value === selectedDeviceId) || inputOptions[0];
  const savedAtText = formatSavedAt(savedPreference?.savedAt);
  const canUseMediaDevices = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const canSaveMicrophone = monitoring || permissionState === "ready";
  const shouldShowRefreshDevices = permissionState === "error" || (permissionState === "ready" && inputOptions.length <= 1);
  const mobileLevel = Math.max(0, Math.min(100, Number(mobileTest?.level || 0)));
  const mobileStatusText = formatMobileAudioTestStatus(mobileTest);
  const mobilePermissionText = formatMobilePermissionState(mobileTest?.permissionState);
  const hasActiveMobileTest = Boolean(mobileTest && !["expired", "completed"].includes(mobileTest.status));
  const isMobileConnected = Boolean(mobileTest && ["connected", "monitoring", "blocked", "idle"].includes(mobileTest.deviceState) && mobileTest.claimedAt);

  useEffect(() => {
    autoStartAttemptedRef.current = false;
    setIsPreferenceReady(false);
    const stored = readAudioInputPreference(scope);
    setSavedPreference(stored);
    setSelectedDeviceId(stored?.deviceId || BROWSER_DEFAULT_AUDIO_INPUT);
    setIsPreferenceReady(true);
  }, [scope]);

  useEffect(() => {
    setMobileTest(null);
    setMobileTestJoinUrl("");
    setMobileTestQrUrl("");
    setMobileTestError("");
    setMobileTestNotice("");
    setIsQrModalOpen(false);
  }, [orgId]);

  useEffect(() => {
    refreshDevices();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) {
      return undefined;
    }

    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, []);

  useEffect(() => () => {
    cleanupGraph();
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!mobileTestJoinUrl) {
      setMobileTestQrUrl("");
      return undefined;
    }

    QRCode.toDataURL(mobileTestJoinUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setMobileTestQrUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMobileTestQrUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mobileTestJoinUrl]);

  useEffect(() => {
    if (!mobileTest?.testId || ["expired", "completed"].includes(mobileTest.status)) {
      return undefined;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetchWithOperatorAuth(
          `${getGatewayBaseUrl()}/api/v1/admin/audio-tests/${encodeURIComponent(mobileTest.testId)}`,
          {
            cache: "no-store"
          },
          accessToken
        );

        if (response.status === 401) {
          onAuthExpired?.();
          return;
        }

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "スマホのマイクテスト状態を取得できませんでした。");
        }

        if (!cancelled) {
          setMobileTest(payload.audioTest || null);
          setMobileTestError("");
        }
      } catch (nextError) {
        if (!cancelled) {
          setMobileTestError(toUserFacingErrorMessage(nextError, "スマホのマイクテスト状態を取得できませんでした。"));
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, MOBILE_AUDIO_TEST_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, mobileTest?.status, mobileTest?.testId, onAuthExpired]);

  useEffect(() => {
    if (isQrModalOpen && (isMobileConnected || ["expired", "completed"].includes(mobileTest?.status || ""))) {
      setIsQrModalOpen(false);
    }
  }, [isMobileConnected, isQrModalOpen, mobileTest?.status]);

  async function refreshDevices() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const nextDevices = await navigator.mediaDevices.enumerateDevices();
      setDevices(nextDevices);
    } catch {
      // Device labels are refreshed after microphone permission is granted.
    }
  }

  function cleanupGraph() {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }

    if (graph.animationFrame) {
      cancelAnimationFrame(graph.animationFrame);
    }

    graph.processorNode?.disconnect();
    graph.sourceNode?.disconnect();
    graph.analyserNode?.disconnect();
    graph.muteNode?.disconnect();
    graph.audioContext?.close?.().catch(() => {});
    for (const track of graph.stream?.getTracks?.() || []) {
      track.stop();
    }

    graphRef.current = null;
    levelRef.current = 0;
    setLevel(0);
    setMonitoring(false);
  }

  async function startMonitor(deviceId = selectedDeviceId) {
    setError("");
    setNotice("");

    if (!canUseMediaDevices) {
      setPermissionState("error");
      setError("このブラウザではマイクテストを利用できません。ChromeまたはSafariで開き直してください。");
      return;
    }

    cleanupGraph();
    setPermissionState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioInputConstraints(deviceId)
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        throw new Error("このブラウザでは音声処理を開始できません。");
      }

      const audioContext = new AudioContextClass();
      await audioContext.resume?.();

      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 1024;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(2048, 1, 1);
      const muteNode = audioContext.createGain();
      muteNode.gain.value = 0;

      sourceNode.connect(analyserNode);
      sourceNode.connect(processorNode);
      processorNode.connect(muteNode);
      muteNode.connect(audioContext.destination);

      processorNode.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const metrics = calculateSignal(input);
        levelRef.current = Math.min(100, Math.round(metrics.rms * 420));
      };

      const tick = () => {
        const graph = graphRef.current;
        if (!graph) {
          return;
        }

        setLevel((current) => Math.round(current * 0.62 + levelRef.current * 0.38));
        graph.animationFrame = requestAnimationFrame(tick);
      };

      graphRef.current = {
        stream,
        audioContext,
        sourceNode,
        analyserNode,
        processorNode,
        muteNode,
        animationFrame: requestAnimationFrame(tick)
      };

      setPermissionState("ready");
      setMonitoring(true);
      await refreshDevices();
    } catch (nextError) {
      cleanupGraph();
      setPermissionState("error");
      setError(nextError?.name === "NotAllowedError"
        ? "マイクが許可されていません。ブラウザの権限設定を確認してください。"
        : nextError?.message || "マイクを開始できませんでした。");
    }
  }

  function stopMonitor() {
    cleanupGraph();
    setPermissionState("idle");
    setNotice("");
  }

  function saveSelectedMicrophone() {
    const success = saveAudioInputPreference(scope, {
      deviceId: selectedDeviceId === BROWSER_DEFAULT_AUDIO_INPUT ? "" : selectedDeviceId,
      label: selectedOption?.label || "ブラウザ既定",
      lastStatus: monitoring || permissionState === "ready" ? "確認済み" : ""
    });

    if (!success) {
      setError("このブラウザにマイク設定を保存できませんでした。");
      return;
    }

    const stored = readAudioInputPreference(scope);
    setSavedPreference(stored);
    setNotice("このパソコンの既定マイクとして保存しました。");
  }

  function handleDeviceChange(nextDeviceId) {
    setSelectedDeviceId(nextDeviceId);

    if (monitoring) {
      void startMonitor(nextDeviceId);
    }
  }

  async function createMobileAudioTest() {
    setIsCreatingMobileTest(true);
    setMobileTestError("");
    setMobileTestNotice("");
    setIsQrModalOpen(true);

    try {
      const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/admin/audio-tests`, {
        method: "POST",
        body: JSON.stringify({
          orgId
        })
      }, accessToken);

      if (response.status === 401) {
        setIsQrModalOpen(false);
        onAuthExpired?.();
        return;
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "スマホのマイクテスト用QRを発行できませんでした。");
      }

      setMobileTest(payload.audioTest || null);
      setMobileTestJoinUrl(payload.joinUrl || "");
      setMobileTestNotice("QRを発行しました。スマホで読み取ってください。");
    } catch (nextError) {
      setMobileTestError(toUserFacingErrorMessage(nextError, "スマホのマイクテスト用QRを発行できませんでした。"));
      setIsQrModalOpen(false);
    } finally {
      setIsCreatingMobileTest(false);
    }
  }

  async function completeMobileAudioTest() {
    if (!mobileTest?.testId) {
      return;
    }

    setIsCompletingMobileTest(true);
    setMobileTestError("");
    setMobileTestNotice("");

    try {
      const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/admin/audio-tests/${encodeURIComponent(mobileTest.testId)}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, accessToken);

      if (response.status === 401) {
        onAuthExpired?.();
        return;
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "スマホのマイクテストを終了できませんでした。");
      }

      setMobileTest(payload.audioTest || null);
      setMobileTestJoinUrl("");
      setMobileTestQrUrl("");
      setIsQrModalOpen(false);
      setMobileTestNotice("スマホのマイクテストを終了しました。");
    } catch (nextError) {
      setMobileTestError(toUserFacingErrorMessage(nextError, "スマホのマイクテストを終了できませんでした。"));
    } finally {
      setIsCompletingMobileTest(false);
    }
  }

  async function copyMobileAudioTestLink() {
    if (!mobileTestJoinUrl) {
      return;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(mobileTestJoinUrl);
        setMobileTestNotice("スマホ用リンクをコピーしました。");
        setMobileTestError("");
        return;
      }
    } catch {
      // Fall back to prompt below.
    }

    if (typeof window !== "undefined") {
      window.prompt("このリンクをコピーしてください。", mobileTestJoinUrl);
      setMobileTestNotice("スマホ用リンクを表示しました。");
      setMobileTestError("");
    }
  }

  useEffect(() => {
    if (!isPreferenceReady || autoStartAttemptedRef.current) {
      return undefined;
    }

    autoStartAttemptedRef.current = true;
    let cancelled = false;

    async function requestMicrophoneOnOpen() {
      if (!canUseMediaDevices) {
        setPermissionState("error");
        setError("このブラウザではマイクテストを利用できません。ChromeまたはSafariで開き直してください。");
        return;
      }

      try {
        if (typeof navigator !== "undefined" && navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: "microphone" });

          if (cancelled) {
            return;
          }

          if (status.state === "denied") {
            setPermissionState("error");
            setError("マイクがブロックされています。Chrome の URL 左側のサイト設定からマイクを許可してください。");
            return;
          }
        }
      } catch {
        // Continue to getUserMedia; unsupported Permissions API should not block the prompt.
      }

      if (!cancelled) {
        await startMonitor(selectedDeviceId);
      }
    }

    void requestMicrophoneOnOpen();

    return () => {
      cancelled = true;
    };
  }, [canUseMediaDevices, isPreferenceReady, selectedDeviceId]);

  return (
    <div className="admin-stack">
      <section className="audio-test-card">
        <div className="audio-test-section-grid">
          <section className="audio-test-panel audio-test-main-panel">
            <h2>マイク入力テスト</h2>
            <div className="audio-test-field">
              <span>このパソコン</span>
              <AdminSelect
                value={selectedDeviceId}
                onValueChange={handleDeviceChange}
                options={inputOptions}
                ariaLabel="入力マイクを選択"
                disabled={permissionState === "requesting"}
              />
            </div>

            <div className="audio-test-level">
              <div className="audio-meter" aria-label={`マイク入力レベル ${level}%`}>
                <span style={{ width: `${level}%` }} />
              </div>
              <p>テスト開始後、普段の声で話し、メーターが安定して動くことを確認してください。</p>
              <div className="audio-test-meter-labels">
                <span>小さい</span>
                <span>適正</span>
                <span>大きい</span>
              </div>
            </div>

            <div className="audio-test-actions audio-test-primary-actions">
              {monitoring ? (
                <button className="btn btn--ghost" type="button" onClick={stopMonitor}>テスト停止</button>
              ) : (
                <button className="btn btn--primary" type="button" onClick={() => startMonitor()} disabled={permissionState === "requesting"}>
                  {permissionState === "requesting" ? "確認中..." : "テスト開始"}
                </button>
              )}
              <button className="btn btn--primary" type="button" onClick={saveSelectedMicrophone} disabled={!canSaveMicrophone}>
                既定に保存
              </button>
            </div>

            <p className="audio-test-current-default">
              既定: <strong>{savedPreference?.label || "未設定"}</strong>
              {savedAtText ? <span>（{savedAtText}に保存）</span> : null}
            </p>
            {shouldShowRefreshDevices ? (
              <button className="audio-test-refresh-button" type="button" onClick={refreshDevices}>
                マイク一覧を更新
              </button>
            ) : null}

            {(error || notice) ? (
              <div className={`audio-test-message ${error ? "audio-test-message--error" : ""}`} role="status">
                {error || notice}
              </div>
            ) : null}
          </section>

          <section className="audio-test-panel audio-test-mobile-panel">
            <div className="audio-test-field">
              <span>スマホ</span>
              <p className="audio-test-note">QR を読み取ると、その場でマイク許可を求めて入力レベルを返します。</p>
            </div>

            <div className="audio-test-actions">
              {!hasActiveMobileTest ? (
                <button className={`btn btn--primary ${isCreatingMobileTest ? "btn--loading" : ""}`} type="button" onClick={createMobileAudioTest} disabled={isCreatingMobileTest}>
                  {isCreatingMobileTest ? <span className="btn-spinner" aria-hidden="true" /> : null}
                  <span>{isCreatingMobileTest ? "発行中..." : "QRを発行"}</span>
                </button>
              ) : (
                <>
                  {!isMobileConnected ? (
                    <button className="btn btn--ghost" type="button" onClick={() => setIsQrModalOpen(true)} disabled={!mobileTestQrUrl}>
                      QRを表示
                    </button>
                  ) : null}
                  <button className={`btn btn--ghost ${isCompletingMobileTest ? "btn--loading" : ""}`} type="button" onClick={completeMobileAudioTest} disabled={isCompletingMobileTest}>
                    {isCompletingMobileTest ? <span className="btn-spinner" aria-hidden="true" /> : null}
                    <span>{isCompletingMobileTest ? "終了中..." : "スマホテスト終了"}</span>
                  </button>
                </>
              )}
            </div>

            <div className="audio-test-mobile-meta">
              <div>
                <span>状態</span>
                <strong>{mobileStatusText}</strong>
              </div>
              <div>
                <span>マイク権限</span>
                <strong>{mobilePermissionText}</strong>
              </div>
              <div>
                <span>入力名</span>
                <strong>{mobileTest?.inputLabel || mobileTest?.deviceLabel || "未接続"}</strong>
              </div>
            </div>

            <div className="audio-test-level">
              <div className="audio-meter" aria-label={`スマホ入力レベル ${mobileLevel}%`}>
                <span style={{ width: `${mobileLevel}%` }} />
              </div>
              <div className="audio-test-meter-labels">
                <span>小さい</span>
                <span>適正</span>
                <span>大きい</span>
              </div>
            </div>

            {(mobileTestError || mobileTestNotice) ? (
              <div className={`audio-test-message ${mobileTestError ? "audio-test-message--error" : ""}`} role="status">
                {mobileTestError || mobileTestNotice}
              </div>
            ) : null}
          </section>
        </div>

        {isQrModalOpen ? (
          <div className="admin-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setIsQrModalOpen(false); }}>
            <div className="admin-modal-card audio-test-qr-modal" role="dialog" aria-modal="true" aria-labelledby="audio-test-qr-title">
              <div className="admin-modal-head">
                <h2 id="audio-test-qr-title">スマホで読み取り</h2>
                <button className="btn btn--ghost audio-test-qr-close" type="button" onClick={() => setIsQrModalOpen(false)} aria-label="閉じる">
                  <Icon name="x" size={18} />
                </button>
              </div>
              <div className="audio-test-qr-card">
                {isCreatingMobileTest || !mobileTestQrUrl ? (
                  <div className="audio-test-qr-loading">
                    <div className="spinner" aria-hidden="true" />
                    <p>QR を生成しています...</p>
                  </div>
                ) : (
                  <>
                    <img className="audio-test-qr-image" src={mobileTestQrUrl} alt="スマホのマイクテスト用QRコード" />
                    <button className="btn btn--ghost" type="button" onClick={copyMobileAudioTestLink}>
                      リンクをコピー
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
