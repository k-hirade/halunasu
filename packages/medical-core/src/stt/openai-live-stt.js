import { WebSocket } from "ws";
import { buildMedicalTranscriptionPrompt, sanitizeTranscriptionText } from "./medical-transcription.js";

const CONNECT_RETRY_DELAYS_MS = [0, 300, 1000];

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
}

function safeErrorLogFields(error, extra = {}) {
  const fields = {
    ...extra,
    errorName: error?.name || "Error",
    errorCode: error?.code || null,
    statusCode: error?.statusCode || null
  };

  if (!isProductionRuntime() && error?.message) {
    fields.message = error.message;
  }

  return fields;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function buildTranscriptionSessionConfig(config, metadata, sessionContext) {
  const include = [];

  if (config.includeLogprobs) {
    include.push("item.input_audio_transcription.logprobs");
  }

  const session = {
    type: "transcription",
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: config.sampleRateHz
        },
        transcription: {
          model: config.model
        },
        turn_detection:
          config.turnDetection === "none"
            ? null
            : {
                type: "server_vad",
                threshold: config.vadThreshold,
                prefix_padding_ms: config.vadPrefixPaddingMs,
                silence_duration_ms: config.vadSilenceDurationMs,
                ...(config.vadIdleTimeoutMs == null ? {} : { idle_timeout_ms: config.vadIdleTimeoutMs })
              },
        noise_reduction: config.noiseReduction ? { type: config.noiseReduction } : null
      }
    }
  };

  if (config.language) {
    session.audio.input.transcription.language = config.language;
  }

  session.audio.input.transcription.prompt = buildMedicalTranscriptionPrompt({
    basePrompt: config.prompt,
    sessionContext
  });

  if (include.length) {
    session.include = include;
  }

  return session;
}

function buildRealtimeUrl(config) {
  const url = new URL(config.wsUrl);

  if (url.searchParams.has("model")) {
    throw new Error(
      "OPENAI_REALTIME_WS_URL must not include a model query when using transcription client secrets"
    );
  }

  return url.toString();
}

async function parseJson(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractRealtimeError(payload) {
  if (payload?.error?.message) {
    return payload.error.message;
  }

  if (payload?.message) {
    return payload.message;
  }

  return "OpenAI realtime transcription failed";
}

function extractHttpError(prefix, status, payload) {
  const detail = payload?.error?.message || payload?.message || payload?.raw || "unknown error";
  return `${prefix} (${status}): ${detail}`;
}

function isHarmlessEmptyCommitError(message) {
  return message.includes("Error committing input audio buffer: buffer too small");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableConnectError(error) {
  const message = error?.message || "";

  return (
    message.includes("Unexpected server response: 502") ||
    message.includes("Unexpected server response: 503") ||
    message.includes("Unexpected server response: 504") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("socket hang up") ||
    message.includes("network timeout") ||
    message.includes("fetch failed") ||
    message.includes("client secret creation failed (500") ||
    message.includes("client secret creation failed (502") ||
    message.includes("client secret creation failed (503") ||
    message.includes("client secret creation failed (504")
  );
}

function readLogprobValue(item) {
  if (typeof item === "number") {
    return item;
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  for (const key of ["logprob", "token_logprob", "average_logprob"]) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function collectLogprobValues(logprobs, values = []) {
  if (!logprobs) {
    return values;
  }

  if (Array.isArray(logprobs)) {
    for (const item of logprobs) {
      collectLogprobValues(item, values);
    }
    return values;
  }

  const directValue = readLogprobValue(logprobs);
  if (directValue != null) {
    values.push(directValue);
  }

  if (typeof logprobs === "object") {
    for (const key of ["content", "tokens", "items"]) {
      if (Array.isArray(logprobs[key])) {
        collectLogprobValues(logprobs[key], values);
      }
    }
  }

  return values;
}

function calculateConfidenceFromLogprobs(logprobs) {
  const values = collectLogprobValues(logprobs).filter((value) => Number.isFinite(value));

  if (!values.length) {
    return null;
  }

  const averageLogprob = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(0, Math.min(1, Math.exp(averageLogprob)));
}

async function createClientSecret(config, metadata, sessionContext) {
  const response = await fetch(config.clientSecretsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      session: buildTranscriptionSessionConfig(config, metadata, sessionContext)
    })
  });

  const payload = await parseJson(response);

  if (!response.ok) {
    throw new Error(
      extractHttpError("OpenAI realtime client secret creation failed", response.status, payload)
    );
  }

  const secret = payload?.value || payload?.client_secret?.value;

  if (!secret) {
    throw new Error("OpenAI realtime client secret response did not include a secret value");
  }

  return {
    secret,
    session: payload?.session || null
  };
}

export class OpenAiLiveSttProvider {
  constructor({ config, sessionId, metadata, sessionContext = {}, handlers }) {
    this.config = config;
    this.sessionId = sessionId;
    this.metadata = metadata;
    this.sessionContext = sessionContext;
    this.handlers = handlers;
    this.ws = null;
    this.openDeferred = createDeferred();
    this.itemPartials = new Map();
    this.promptLeakItemIds = new Set();
    this.isOpen = false;
    this.isSessionConfigured = false;
    this.ignoreEmptyCommitError = false;
  }

  static canHandle(metadata, config) {
    const encoding = (metadata.encoding || "").toLowerCase();

    return (
      ["pcm16", "pcm16le", "audio/pcm"].includes(encoding) &&
      Number(metadata.sampleRateHz) === Number(config.sampleRateHz) &&
      Number(metadata.channels || 1) === Number(config.channels)
    );
  }

  async connect() {
    if (!this.config.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    if (!OpenAiLiveSttProvider.canHandle(this.metadata, this.config)) {
      throw new Error(
        `OpenAI realtime requires pcm16/${this.config.sampleRateHz}Hz/${this.config.channels}ch input`
      );
    }

    const realtimeUrl = buildRealtimeUrl(this.config);
    let lastError = null;

    for (let attempt = 0; attempt < CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = CONNECT_RETRY_DELAYS_MS[attempt];

      if (delayMs > 0) {
        await wait(delayMs);
      }

      this.openDeferred = createDeferred();
      this.isSessionConfigured = false;

      try {
        const { secret } = await createClientSecret(this.config, this.metadata, this.sessionContext);
        await this.#openSocket(realtimeUrl, secret);
        console.info("openai live stt connected", {
          sessionId: this.sessionId,
          attempt: attempt + 1
        });
        return;
      } catch (error) {
        lastError = error;
        this.#disposeSocket();

        if (attempt === CONNECT_RETRY_DELAYS_MS.length - 1 || !isRetryableConnectError(error)) {
          throw error;
        }

        console.warn("openai live stt connect retry", safeErrorLogFields(error, {
          sessionId: this.sessionId,
          attempt: attempt + 1,
          nextDelayMs: CONNECT_RETRY_DELAYS_MS[attempt + 1],
          reason: "connect_retry"
        }));
      }
    }

    throw lastError || new Error("OpenAI realtime transcription connection failed");
  }

  async sendAudio(chunk) {
    await this.openDeferred.promise;

    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(chunk).toString("base64")
      })
    );
  }

  async flush() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ignoreEmptyCommitError = true;
    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.commit"
      })
    );
  }

  async close() {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      return;
    }

    this.ws.close(1000);
  }

  async #openSocket(realtimeUrl, secret) {
    this.ws = new WebSocket(realtimeUrl, {
      headers: {
        Authorization: `Bearer ${secret}`
      }
    });

    this.ws.on("open", () => {
      this.isOpen = true;
    });

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        this.#handleMessage(payload);
      } catch (error) {
        if (!this.isSessionConfigured) {
          this.openDeferred.reject(error);
          return;
        }
        this.handlers.onError?.(error);
      }
    });

    this.ws.on("error", (error) => {
      if (!this.isSessionConfigured) {
        this.openDeferred.reject(error);
        return;
      }
      this.handlers.onError?.(error);
    });

    this.ws.on("close", (code, reason) => {
      if (!this.isSessionConfigured) {
        this.openDeferred.reject(
          new Error(`OpenAI realtime socket closed before transcription session was ready (${code})`)
        );
        return;
      }

      if (code !== 1000) {
        this.handlers.onError?.(
          new Error(
            `OpenAI realtime socket closed (${code}): ${reason.toString("utf8") || "unknown"}`
          )
        );
      }
    });

    await this.openDeferred.promise;
  }

  #disposeSocket() {
    if (!this.ws) {
      return;
    }

    try {
      this.ws.removeAllListeners();
      if (this.ws.readyState < WebSocket.CLOSING) {
        this.ws.close(1000);
      }
    } catch {
      // ignore cleanup errors during retry
    }

    this.ws = null;
    this.isOpen = false;
  }

  #handleMessage(payload) {
    switch (payload.type) {
      case "session.created":
      case "session.updated": {
        if (payload.session?.type === "transcription") {
          this.isSessionConfigured = true;
          this.openDeferred.resolve();
        }
        return;
      }
      case "transcription_session.created":
      case "transcription_session.updated": {
        this.isSessionConfigured = true;
        this.openDeferred.resolve();
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = payload.item_id || "default";
        if (this.promptLeakItemIds.has(itemId)) {
          return;
        }
        const nextText = `${this.itemPartials.get(itemId) || ""}${payload.delta || ""}`;
        const text = sanitizeTranscriptionText(nextText);
        if (text.length !== nextText.trim().length) {
          this.promptLeakItemIds.add(itemId);
        }
        this.itemPartials.set(itemId, text);
        this.handlers.onPartial?.({
          text,
          provider: "openai",
          itemId
        });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = payload.item_id || "default";
        const text = sanitizeTranscriptionText(payload.transcript || this.itemPartials.get(itemId) || "");
        const confidence = calculateConfidenceFromLogprobs(payload.logprobs);
        this.itemPartials.delete(itemId);
        this.promptLeakItemIds.delete(itemId);

        if (text.trim()) {
          this.handlers.onFinal?.({
            text,
            provider: "openai",
            itemId,
            confidence
          });
        }
        return;
      }
      case "error": {
        const message = extractRealtimeError(payload);

        if (this.ignoreEmptyCommitError && isHarmlessEmptyCommitError(message)) {
          this.ignoreEmptyCommitError = false;
          console.info("openai live stt ignored empty commit", {
            sessionId: this.sessionId
          });
          return;
        }

        this.ignoreEmptyCommitError = false;
        throw new Error(message);
      }
      default:
        return;
    }
  }
}
