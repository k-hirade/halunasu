import { WebSocket } from "ws";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function buildDeepgramUrl(config, metadata) {
  const url = new URL(config.wsUrl);
  url.searchParams.set("model", config.model);
  url.searchParams.set("interim_results", String(config.interimResults));
  url.searchParams.set("punctuate", String(config.punctuate));
  url.searchParams.set("smart_format", String(config.smartFormat));
  url.searchParams.set("endpointing", String(config.endpointingMs));

  if (config.language) {
    url.searchParams.set("language", config.language);
  }

  const encoding = (metadata.encoding || "").toLowerCase();

  if (["pcm16", "pcm16le", "audio/pcm"].includes(encoding)) {
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(metadata.sampleRateHz || 24_000));
    url.searchParams.set("channels", String(metadata.channels || 1));
  }

  return url.toString();
}

export class DeepgramLiveSttProvider {
  constructor({ config, sessionId, metadata, handlers }) {
    this.config = config;
    this.sessionId = sessionId;
    this.metadata = metadata;
    this.handlers = handlers;
    this.ws = null;
    this.openDeferred = createDeferred();
    this.isOpen = false;
  }

  static canHandle(_metadata) {
    return true;
  }

  async connect() {
    if (!this.config.apiKey) {
      throw new Error("DEEPGRAM_API_KEY is not configured");
    }

    this.ws = new WebSocket(buildDeepgramUrl(this.config, this.metadata), {
      headers: {
        Authorization: `Token ${this.config.apiKey}`
      }
    });

    this.ws.on("open", () => {
      this.isOpen = true;
      this.openDeferred.resolve();
    });

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        this.#handleMessage(payload);
      } catch (error) {
        this.handlers.onError?.(error);
      }
    });

    this.ws.on("error", (error) => {
      this.openDeferred.reject(error);
      this.handlers.onError?.(error);
    });

    this.ws.on("close", (code, reason) => {
      if (!this.isOpen) {
        this.openDeferred.reject(
          new Error(`Deepgram socket closed before ready (${code})`)
        );
      }

      if (code !== 1000) {
        this.handlers.onError?.(
          new Error(`Deepgram socket closed (${code}): ${reason.toString("utf8") || "unknown"}`)
        );
      }
    });

    await this.openDeferred.promise;
  }

  async sendAudio(chunk) {
    await this.openDeferred.promise;
    this.ws.send(chunk);
  }

  async flush() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ type: "Finalize" }));
  }

  async close() {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      return;
    }

    this.ws.close(1000);
  }

  #handleMessage(payload) {
    if (payload.type === "Results") {
      const alternative = payload.channel?.alternatives?.[0];
      const text = alternative?.transcript || "";

      if (!text.trim()) {
        return;
      }

      if (payload.is_final) {
        this.handlers.onFinal?.({
          text,
          provider: "deepgram",
          confidence: alternative?.confidence ?? null
        });
        return;
      }

      this.handlers.onPartial?.({
        text,
        provider: "deepgram"
      });
      return;
    }

    if (payload.type === "Error") {
      throw new Error(payload.description || payload.message || "Deepgram streaming failed");
    }
  }
}
