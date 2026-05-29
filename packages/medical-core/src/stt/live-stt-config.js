function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return value === "true";
}

function parseNumber(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNullableNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["null", "none", "off", "false"].includes(normalized)) {
    return null;
  }

  return parseNumber(value, fallback);
}

function normalizeNoiseReduction(value, fallback = "far_field") {
  const normalized = (value || fallback).toLowerCase();

  if (["near_field", "far_field"].includes(normalized)) {
    return normalized;
  }

  if (["null", "none", "off", "false"].includes(normalized)) {
    return null;
  }

  return fallback;
}

export function normalizeLiveSttProvider(value, fallback = "openai") {
  const normalized = (value || fallback).toLowerCase();

  if (["openai", "deepgram", "mock", "none"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

export function createLiveSttConfigFromEnv(env = process.env) {
  const primaryProvider = normalizeLiveSttProvider(env.LIVE_STT_PROVIDER, "openai");
  const fallbackProvider = normalizeLiveSttProvider(env.LIVE_STT_FALLBACK_PROVIDER, "deepgram");
  const isProduction = env.NODE_ENV === "production" || env.APP_ENV === "production";

  return {
    mode: (env.LIVE_STT_MODE || "provider").toLowerCase(),
    primaryProvider,
    fallbackProvider: fallbackProvider === primaryProvider ? "none" : fallbackProvider,
    allowMockFallback: parseBoolean(env.LIVE_STT_ALLOW_MOCK_FALLBACK, !isProduction),
    replayBufferBytes: parseNumber(env.LIVE_STT_REPLAY_BUFFER_BYTES, 1_000_000),
    archiveMaxBytes: parseNumber(env.LIVE_STT_ARCHIVE_MAX_BYTES, 40_000_000),
    minFinalTextChars: parseNumber(env.LIVE_STT_MIN_FINAL_TEXT_CHARS, 2),
    minFinalConfidence: parseNumber(env.LIVE_STT_MIN_FINAL_CONFIDENCE, 0.35),
    lowConfidenceShortTextMaxChars: parseNumber(env.LIVE_STT_LOW_CONFIDENCE_SHORT_TEXT_MAX_CHARS, 12),
    openai: {
      apiKey: env.OPENAI_API_KEY || "",
      wsUrl: env.OPENAI_REALTIME_WS_URL || "wss://api.openai.com/v1/realtime",
      clientSecretsUrl:
        env.OPENAI_REALTIME_CLIENT_SECRETS_URL || "https://api.openai.com/v1/realtime/client_secrets",
      model: env.OPENAI_REALTIME_MODEL || "gpt-4o-mini-transcribe",
      language: env.OPENAI_REALTIME_LANGUAGE || "ja",
      prompt: env.OPENAI_REALTIME_PROMPT || "",
      sampleRateHz: parseNumber(env.OPENAI_REALTIME_SAMPLE_RATE_HZ, 24_000),
      channels: parseNumber(env.OPENAI_REALTIME_CHANNELS, 1),
      turnDetection: (env.OPENAI_REALTIME_TURN_DETECTION || "server_vad").toLowerCase(),
      vadThreshold: parseNumber(env.OPENAI_REALTIME_VAD_THRESHOLD, 0.65),
      vadPrefixPaddingMs: parseNumber(env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS, 300),
      vadSilenceDurationMs: parseNumber(env.OPENAI_REALTIME_VAD_SILENCE_DURATION_MS, 700),
      vadIdleTimeoutMs: parseNullableNumber(env.OPENAI_REALTIME_VAD_IDLE_TIMEOUT_MS, null),
      noiseReduction: normalizeNoiseReduction(env.OPENAI_REALTIME_NOISE_REDUCTION, "far_field"),
      includeLogprobs: parseBoolean(env.OPENAI_REALTIME_INCLUDE_LOGPROBS, true)
    },
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY || "",
      wsUrl: env.DEEPGRAM_WS_URL || "wss://api.deepgram.com/v1/listen",
      model: env.DEEPGRAM_MODEL || "nova-3",
      language: env.DEEPGRAM_LANGUAGE || "ja",
      interimResults: parseBoolean(env.DEEPGRAM_INTERIM_RESULTS, true),
      punctuate: parseBoolean(env.DEEPGRAM_PUNCTUATE, true),
      smartFormat: parseBoolean(env.DEEPGRAM_SMART_FORMAT, true),
      endpointingMs: parseNumber(env.DEEPGRAM_ENDPOINTING_MS, 300)
    }
  };
}
