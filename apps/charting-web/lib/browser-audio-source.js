"use client";

export const TARGET_SAMPLE_RATE = 24_000;

const AUDIO_GATE_INITIAL_NOISE_FLOOR = 0.004;
const AUDIO_GATE_MIN_RMS = 0.008;
const AUDIO_GATE_NOISE_MULTIPLIER = 2.6;
const AUDIO_GATE_HANGOVER_MS = 650;

function createBrowserDeviceId(prefix) {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return `${prefix}_${window.crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }

  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

export function getOrCreateStoredDeviceId(storageKey, prefix = "rec") {
  if (typeof window === "undefined") {
    return createBrowserDeviceId(prefix);
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      return stored;
    }

    const next = createBrowserDeviceId(prefix);
    window.localStorage.setItem(storageKey, next);
    return next;
  } catch {
    return createBrowserDeviceId(prefix);
  }
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

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createBrowserAudioSource({
  onAudioFrame,
  onLevel,
  onInterrupted,
  onError,
  gateAudio = false,
  audioConstraints = null
} = {}) {
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let analyserNode = null;
  let muteNode = null;
  let animationFrame = null;
  let isStreaming = false;
  let resampleTail = new Float32Array(0);
  let noiseFloor = AUDIO_GATE_INITIAL_NOISE_FLOOR;
  let audioGateOpenUntil = 0;

  function resetGate() {
    resampleTail = new Float32Array(0);
    noiseFloor = AUDIO_GATE_INITIAL_NOISE_FLOOR;
    audioGateOpenUntil = 0;
  }

  function shouldSendAudioFrame(rms) {
    if (!gateAudio) {
      return true;
    }

    const currentFloor = Math.max(noiseFloor || AUDIO_GATE_INITIAL_NOISE_FLOOR, AUDIO_GATE_INITIAL_NOISE_FLOOR);
    const threshold = Math.max(AUDIO_GATE_MIN_RMS, currentFloor * AUDIO_GATE_NOISE_MULTIPLIER);
    const currentTime = nowMs();

    if (rms >= threshold) {
      audioGateOpenUntil = currentTime + AUDIO_GATE_HANGOVER_MS;
      return true;
    }

    noiseFloor = currentFloor * 0.98 + rms * 0.02;
    return currentTime <= audioGateOpenUntil;
  }

  function stopLevelMeter() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  function startLevelMeter() {
    if (!analyserNode || typeof requestAnimationFrame === "undefined") {
      return;
    }

    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    const tick = () => {
      analyserNode.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      onLevel?.(Math.min(100, Math.round((average / 255) * 100)));
      animationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  async function prepare() {
    if (stream && audioContext) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザではマイクを使用できません。SafariまたはChromeで開き直してください。");
    }

    const preferredAudioConstraints = audioConstraints || {
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: preferredAudioConstraints });
    } catch (error) {
      if (!["OverconstrainedError", "ConstraintNotSatisfiedError", "TypeError"].includes(error?.name)) {
        throw error;
      }

      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
      throw new Error("このブラウザでは音声処理を開始できません。SafariまたはChromeで開き直してください。");
    }

    audioContext = new AudioContextClass();
    audioContext.onstatechange = () => {
      if (audioContext?.state === "interrupted" || audioContext?.state === "suspended") {
        onInterrupted?.(audioContext.state);
      }
    };

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;

    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyserNode);

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      try {
        const input = event.inputBuffer.getChannelData(0);
        const rms = calculateRms(input);

        if (!isStreaming) {
          noiseFloor = noiseFloor * 0.95 + rms * 0.05;
          resampleTail = new Float32Array(0);
          return;
        }

        if (!shouldSendAudioFrame(rms)) {
          resampleTail = new Float32Array(0);
          return;
        }

        const { samples, carry } = downsampleToRate(input, audioContext.sampleRate, TARGET_SAMPLE_RATE, resampleTail);
        resampleTail = carry;
        if (!samples.length) return;
        onAudioFrame?.(pcm16BytesFromFloat32(samples));
      } catch (error) {
        onError?.(error);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);
    startLevelMeter();
  }

  async function resume() {
    if (audioContext?.state === "suspended" || audioContext?.state === "interrupted") {
      await audioContext.resume?.();
    }
  }

  async function startStreaming() {
    await resume();
    isStreaming = true;
  }

  function stopStreaming() {
    isStreaming = false;
    resampleTail = new Float32Array(0);
  }

  function cleanup() {
    stopStreaming();
    stopLevelMeter();
    processorNode?.disconnect();
    sourceNode?.disconnect();
    analyserNode?.disconnect();
    muteNode?.disconnect();
    audioContext?.close().catch(() => {});
    processorNode = null;
    sourceNode = null;
    analyserNode = null;
    muteNode = null;
    audioContext = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    stream = null;
    resetGate();
    onLevel?.(0);
  }

  return {
    prepare,
    resume,
    startStreaming,
    stopStreaming,
    cleanup,
    isPrepared: () => Boolean(stream && audioContext),
    isStreaming: () => isStreaming,
    getAudioContextState: () => audioContext?.state || "closed"
  };
}
