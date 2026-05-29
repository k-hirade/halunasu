import { createLiveSttConfigFromEnv, normalizeLiveSttProvider } from "./live-stt-config.js";
import { DeepgramLiveSttProvider } from "./deepgram-live-stt.js";
import { MockLiveStt } from "./mock-live-stt.js";
import { OpenAiLiveSttProvider } from "./openai-live-stt.js";

class MockLiveSttProvider {
  constructor({ sessionId, handlers }) {
    this.sessionId = sessionId;
    this.handlers = handlers;
    this.engine = new MockLiveStt();
  }

  static canHandle() {
    return true;
  }

  async connect() {}

  async sendAudio() {
    const emitted = this.engine.consumeFrame(this.sessionId);

    if (emitted.partial) {
      this.handlers.onPartial?.({
        text: emitted.partial,
        provider: "mock"
      });
    }

    if (emitted.final) {
      this.handlers.onFinal?.({
        text: emitted.final,
        provider: "mock",
        confidence: 0.92
      });
    }
  }

  async flush() {}

  async close() {
    this.engine.reset(this.sessionId);
  }
}

function normalizeMetadata(metadata = {}) {
  return {
    encoding: metadata.encoding || "pcm16",
    sampleRateHz: Number(metadata.sampleRateHz || 24_000),
    channels: Number(metadata.channels || 1),
    transport: metadata.transport || "raw_pcm",
    mimeType: metadata.mimeType || null
  };
}

function copyChunk(chunk) {
  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }

  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  return Buffer.from(chunk);
}

export class LiveSttPipeline {
  constructor({ config = createLiveSttConfigFromEnv(), onPartial, onFinal, onProviderChanged, onError } = {}) {
    this.config = config;
    this.sessions = new Map();
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onProviderChanged = onProviderChanged;
    this.onError = onError;
  }

  async setSessionMetadata(sessionId, metadata) {
    const state = this.#ensureSession(sessionId);
    state.metadata = normalizeMetadata(metadata);
  }

  async setSessionContext(sessionId, context = {}) {
    const state = this.#ensureSession(sessionId);
    state.context = {
      ...state.context,
      ...context
    };
  }

  async consumeAudioFrame(sessionId, chunk) {
    const state = this.#ensureSession(sessionId);
    const buffer = copyChunk(chunk);
    this.#appendBacklog(state, buffer);
    this.#appendArchive(state, buffer);

    if (this.config.mode === "mock") {
      await this.#ensureProvider(state, "mock");
      await state.provider.sendAudio(buffer);
      return;
    }

    let startedFresh = false;

    try {
      startedFresh = await this.#ensureProvider(state);
    } catch (error) {
      await this.onError?.({
        sessionId: state.sessionId,
        error,
        provider: Array.from(state.failedProviders).at(-1) || this.config.primaryProvider
      });
      return;
    }

    if (startedFresh && state.providerName !== "mock") {
      return;
    }

    try {
      await state.provider.sendAudio(buffer);
    } catch (error) {
      await this.#failover(state, error);

      if (state.providerName === "mock") {
        await state.provider.sendAudio(buffer);
      }
    }
  }

  async flush(sessionId) {
    const state = this.sessions.get(sessionId);

    if (!state?.provider) {
      return;
    }

    await state.provider.flush?.();
  }

  exportArchivedAudio(sessionId) {
    const state = this.sessions.get(sessionId);

    if (!state || !state.rawAudioChunks.length) {
      return null;
    }

    return {
      pcmBuffer: Buffer.concat(state.rawAudioChunks),
      sampleRateHz: state.metadata.sampleRateHz,
      channels: state.metadata.channels,
      chunkCount: state.rawAudioChunks.length,
      byteLength: state.rawAudioBytes,
      context: { ...state.context }
    };
  }

  async preconnect(sessionId) {
    const state = this.#ensureSession(sessionId);

    if (this.config.mode === "mock") {
      await this.#ensureProvider(state, "mock");
      return;
    }

    try {
      await this.#ensureProvider(state);
    } catch (error) {
      await this.onError?.({
        sessionId: state.sessionId,
        error,
        provider: Array.from(state.failedProviders).at(-1) || this.config.primaryProvider
      });
      throw error;
    }
  }

  async reset(sessionId, { preserveMetadata = false } = {}) {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    if (state.provider) {
      await state.provider.close?.();
    }

    if (preserveMetadata) {
      this.sessions.set(sessionId, {
        sessionId,
        metadata: normalizeMetadata(state.metadata),
        context: { ...state.context },
        providerName: null,
        provider: null,
        providerInitPromise: null,
        backlog: [],
        backlogBytes: 0,
        rawAudioChunks: [],
        rawAudioBytes: 0,
        failedProviders: new Set(),
        failoverInProgress: false
      });
      return;
    }

    this.sessions.delete(sessionId);
  }

  #ensureSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        metadata: normalizeMetadata(),
        context: {},
        providerName: null,
        provider: null,
        providerInitPromise: null,
        backlog: [],
        backlogBytes: 0,
        rawAudioChunks: [],
        rawAudioBytes: 0,
        failedProviders: new Set(),
        failoverInProgress: false
      });
    }

    return this.sessions.get(sessionId);
  }

  #appendBacklog(state, chunk) {
    state.backlog.push(chunk);
    state.backlogBytes += chunk.length;

    while (state.backlogBytes > this.config.replayBufferBytes && state.backlog.length > 1) {
      const removed = state.backlog.shift();
      state.backlogBytes -= removed.length;
    }
  }

  #appendArchive(state, chunk) {
    state.rawAudioChunks.push(chunk);
    state.rawAudioBytes += chunk.length;

    while (state.rawAudioBytes > this.config.archiveMaxBytes && state.rawAudioChunks.length > 1) {
      const removed = state.rawAudioChunks.shift();
      state.rawAudioBytes -= removed.length;
    }
  }

  async #ensureProvider(state, forcedProvider) {
    if (state.provider) {
      return false;
    }

    if (state.providerInitPromise) {
      return state.providerInitPromise;
    }

    const candidates = [
      forcedProvider || this.config.primaryProvider,
      this.config.fallbackProvider,
      this.config.allowMockFallback ? "mock" : "none"
    ]
      .filter(Boolean)
      .filter((provider, index, values) => values.indexOf(provider) === index)
      .filter((provider) => provider !== "none");

    const initPromise = (async () => {
      let lastError = null;

      for (const providerName of candidates) {
        try {
          await this.#startProvider(state, providerName);
          return true;
        } catch (error) {
          lastError = error;
          state.failedProviders.add(providerName);
        }
      }

      throw lastError || new Error("No live STT provider could be initialized");
    })();

    state.providerInitPromise = initPromise;

    try {
      return await initPromise;
    } finally {
      if (state.providerInitPromise === initPromise) {
        state.providerInitPromise = null;
      }
    }
  }

  async #startProvider(state, providerName) {
    const provider = this.#createProvider(state, providerName);
    await provider.connect();
    state.provider = provider;
    state.providerName = providerName;

    if (state.backlog.length && providerName !== "mock") {
      for (const chunk of state.backlog) {
        await provider.sendAudio(chunk);
      }
    }

    await this.onProviderChanged?.({
      sessionId: state.sessionId,
      provider: providerName,
      metadata: state.metadata
    });
  }

  async #failover(state, error) {
    if (state.failoverInProgress) {
      throw error;
    }

    state.failoverInProgress = true;
    state.failedProviders.add(state.providerName);

    try {
      await state.provider?.close?.();
    } catch {
      // ignore provider close failures while failing over
    }

    state.provider = null;
    state.providerName = null;

    await this.onError?.({
      sessionId: state.sessionId,
      error,
      provider: Array.from(state.failedProviders).at(-1) || "unknown"
    });

    const nextProviders = [
      this.config.fallbackProvider,
      this.config.allowMockFallback ? "mock" : "none"
    ]
      .filter(Boolean)
      .filter((provider) => provider !== "none")
      .filter((provider) => !state.failedProviders.has(provider));

    try {
      let lastError = error;

      for (const providerName of nextProviders) {
        try {
          await this.#startProvider(state, providerName);
          return true;
        } catch (nextError) {
          lastError = nextError;
          state.failedProviders.add(providerName);
        }
      }

      throw lastError;
    } finally {
      state.failoverInProgress = false;
    }
  }

  #createProvider(state, providerName) {
    const handlers = {
      onPartial: (payload) =>
        this.onPartial?.({
          sessionId: state.sessionId,
          provider: providerName,
          ...payload
        }),
      onFinal: (payload) =>
        this.onFinal?.({
          sessionId: state.sessionId,
          provider: providerName,
          ...payload
        }),
      onError: (error) => this.#failover(state, error).catch(() => {})
    };

    switch (normalizeLiveSttProvider(providerName, "mock")) {
      case "openai":
        return new OpenAiLiveSttProvider({
          config: this.config.openai,
          sessionId: state.sessionId,
          metadata: state.metadata,
          sessionContext: state.context,
          handlers
        });
      case "deepgram":
        return new DeepgramLiveSttProvider({
          config: this.config.deepgram,
          sessionId: state.sessionId,
          metadata: state.metadata,
          handlers
        });
      case "mock":
        return new MockLiveSttProvider({
          sessionId: state.sessionId,
          handlers
        });
      default:
        throw new Error(`Unsupported live STT provider: ${providerName}`);
    }
  }
}
