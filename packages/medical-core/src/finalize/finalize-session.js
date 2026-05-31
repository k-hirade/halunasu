import { createHash } from "node:crypto";
import { buildMockSoapDraft } from "../lib/mock-soap.js";
import { nowIso } from "../lib/ids.js";
import { generateSoapDraftWithOpenAi } from "../soap/openai-soap.js";
import { transcribePcmAudioWithOpenAi } from "../stt/openai-final-transcribe.js";
import { sanitizeTranscriptionText } from "../stt/medical-transcription.js";

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function defaultAllowMockSoapFallback() {
  if (process.env.ALLOW_MOCK_SOAP_FALLBACK != null) {
    return parseBoolean(process.env.ALLOW_MOCK_SOAP_FALLBACK, false);
  }

  return process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "production";
}

function providerErrorSafePayload(error) {
  if (!error?.provider) {
    return {};
  }

  return {
    provider: error.provider,
    providerStatusCode: error.providerStatusCode ?? null,
    providerErrorType: error.providerErrorType ?? null,
    providerErrorCode: error.providerErrorCode ?? null,
    providerErrorParam: error.providerErrorParam ?? null,
    providerModel: error.providerModel ?? null,
    providerMessageSafe: error.safeProviderMessage || null
  };
}

function copyProviderErrorFields(target, source) {
  Object.assign(target, providerErrorSafePayload(source));
  if (source?.provider) {
    target.provider = source.provider;
    target.providerStatusCode = source.providerStatusCode ?? null;
    target.providerErrorType = source.providerErrorType ?? null;
    target.providerErrorCode = source.providerErrorCode ?? null;
    target.providerErrorParam = source.providerErrorParam ?? null;
    target.providerModel = source.providerModel ?? null;
    target.safeProviderMessage = source.safeProviderMessage || null;
  }
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function selectEffectiveTranscript({ finalTranscript = "", liveTranscript = "" } = {}) {
  const finalText = sanitizeTranscriptionText(finalTranscript);
  const liveText = sanitizeTranscriptionText(liveTranscript);

  if (!finalText) {
    return { text: liveText, source: liveText ? "live_stt" : "none", discardedFinalRepass: false };
  }

  if (!liveText) {
    return { text: finalText, source: "final_repass", discardedFinalRepass: false };
  }

  const minimumUsefulFinalLength = Math.max(40, Math.floor(liveText.length * 0.75));

  if (liveText.length >= 60 && finalText.length < minimumUsefulFinalLength) {
    return { text: liveText, source: "live_stt_fallback_short_final", discardedFinalRepass: true };
  }

  return { text: finalText, source: "final_repass", discardedFinalRepass: false };
}

export function buildPreparedFinalTranscriptFromSession(session = {}) {
  const rawText = String(session.finalTranscriptPrecomputeText || "").trim();
  const text = sanitizeTranscriptionText(rawText);
  const status = String(session.finalTranscriptPrecomputeStatus || "");
  const promptLeakStripped = rawText.length !== text.length;

  if (!text || status !== "ready") {
    return null;
  }

  return {
    text,
    source: session.finalTranscriptPrecomputeSource || "final_repass_segmented",
    discardedFinalRepass: false,
    finalTranscriptTextLength: text.length,
    liveTranscriptTextLength: Number(session.finalTranscriptPrecomputeLiveTranscriptTextLength || 0) || 0,
    textLength: text.length,
    textSha256: promptLeakStripped ? hashText(text) : session.finalTranscriptPrecomputeTextSha256 || hashText(text),
    provider: session.finalTranscriptPrecomputeProvider || null,
    finalTranscriptMeta: null,
    finalRepassAttempted: true,
    finalRepassSucceeded: true,
    finalRepassProviderDurationMs: Number(session.finalTranscriptPrecomputeProviderDurationMs || 0) || null,
    hadRawAudio: true,
    rawAudioByteLength: Number(session.finalTranscriptPrecomputeRawAudioByteLength || 0) || 0,
    rawAudioDurationMs: Number(session.finalTranscriptPrecomputeAudioDurationMs || 0) || null,
    startedAt: session.finalTranscriptPrecomputeStartedAt || null,
    completedAt: session.finalTranscriptPrecomputeCompletedAt || null,
    durationMs: Number(session.finalTranscriptPrecomputeDurationMs || 0) || 0,
    rawTextLength: rawText.length,
    promptLeakStripped
  };
}

function normalizePreparedTranscript(preparedTranscript = null) {
  const rawText = String(preparedTranscript?.text || "").trim();
  const text = sanitizeTranscriptionText(rawText);

  if (!text) {
    return null;
  }

  const promptLeakStripped = rawText.length !== text.length || Boolean(preparedTranscript.promptLeakStripped);

  return {
    ...preparedTranscript,
    source: preparedTranscript.source || "prepared_transcript",
    provider: preparedTranscript.provider || null,
    text,
    textLength: text.length,
    durationMs: Number(preparedTranscript.durationMs || 0) || 0,
    hadRawAudio: Boolean(preparedTranscript.hadRawAudio),
    rawAudioByteLength: Number(preparedTranscript.rawAudioByteLength || 0) || 0,
    rawAudioDurationMs:
      preparedTranscript.rawAudioDurationMs == null
        ? null
        : Number(preparedTranscript.rawAudioDurationMs || 0) || 0,
    liveTranscriptTextLength: Number(preparedTranscript.liveTranscriptTextLength || 0) || 0,
    finalTranscriptTextLength: text.length,
    textSha256: promptLeakStripped ? hashText(text) : preparedTranscript.textSha256 || hashText(text),
    finalRepassAttempted: Boolean(preparedTranscript.finalRepassAttempted),
    finalRepassSucceeded: Boolean(preparedTranscript.finalRepassSucceeded),
    finalRepassProviderDurationMs:
      preparedTranscript.finalRepassProviderDurationMs == null
        ? null
        : Number(preparedTranscript.finalRepassProviderDurationMs || 0) || 0,
    startedAt: preparedTranscript.startedAt || null,
    completedAt: preparedTranscript.completedAt || null,
    rawTextLength: preparedTranscript.rawTextLength ?? rawText.length,
    promptLeakStripped
  };
}

function getRawAudioByteLength(rawAudio) {
  return rawAudio?.byteLength || rawAudio?.pcmBuffer?.length || 0;
}

function getRawAudioDurationMs(rawAudio) {
  const byteLength = getRawAudioByteLength(rawAudio);
  const bytesPerSecond = Math.max(1, (rawAudio?.sampleRateHz || 24_000) * (rawAudio?.channels || 1) * 2);
  return byteLength ? Math.round((byteLength / bytesPerSecond) * 1000) : null;
}

function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return {
    inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || null,
    outputTokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || null,
    totalTokens: Number(usage.total_tokens ?? 0) || null
  };
}

export async function prepareFinalTranscript({
  store,
  sessionId,
  openAiApiKey = process.env.OPENAI_API_KEY || "",
  finalTranscriptModel = process.env.OPENAI_FINAL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
  finalTranscriptLanguage = process.env.OPENAI_FINAL_TRANSCRIBE_LANGUAGE || "ja",
  rawAudio = null
}) {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const state = await store.getSessionState(sessionId);
  const stateLoadDurationMs = Date.now() - startedAtMs;

  if (!state) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const turns = state.turns ?? [];
  const liveTranscript = turns.map((turn) => turn.text.trim()).filter(Boolean).join("\n");
  const transcriptHint = liveTranscript;
  let transcriptOverride = "";
  let finalTranscriptMeta = null;
  let finalRepassAttempted = false;
  let finalRepassSucceeded = false;
  let finalRepassProviderDurationMs = null;

  if (openAiApiKey && rawAudio?.pcmBuffer?.length) {
    finalRepassAttempted = true;
    const providerStartedAtMs = Date.now();

    await store.appendAuditEvent(sessionId, {
      type: "transcript.final_repass.started",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        model: finalTranscriptModel,
        language: finalTranscriptLanguage,
        stateLoadDurationMs,
        liveTranscriptTextLength: liveTranscript.length,
        transcriptHintTextLength: transcriptHint.length,
        rawAudioByteLength: getRawAudioByteLength(rawAudio),
        rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
        sampleRateHz: rawAudio.sampleRateHz || null,
        channels: rawAudio.channels || null
      }
    });

    try {
      const retranscribed = await transcribePcmAudioWithOpenAi({
        apiKey: openAiApiKey,
        pcmBuffer: rawAudio.pcmBuffer,
        sampleRateHz: rawAudio.sampleRateHz,
        channels: rawAudio.channels,
        model: finalTranscriptModel,
        language: finalTranscriptLanguage,
        sessionContext: rawAudio.context || state.session,
        transcriptHint
      });
      finalRepassProviderDurationMs = Date.now() - providerStartedAtMs;

      transcriptOverride = retranscribed.text;
      finalTranscriptMeta = retranscribed;
      finalRepassSucceeded = true;

      await store.appendAuditEvent(sessionId, {
        type: "transcript.final_repass.completed",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          model: retranscribed.model,
          textLength: retranscribed.text.length,
          textSha256: hashText(retranscribed.text),
          rawTextLength: retranscribed.rawTextLength ?? null,
          promptLeakStripped: Boolean(retranscribed.promptLeakStripped),
          providerDurationMs: finalRepassProviderDurationMs,
          stateLoadDurationMs,
          liveTranscriptTextLength: liveTranscript.length,
          rawAudioByteLength: getRawAudioByteLength(rawAudio),
          rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
          durationMs: Date.now() - startedAtMs
        }
      });
    } catch (error) {
      finalRepassProviderDurationMs = Date.now() - providerStartedAtMs;
      await store.appendAuditEvent(sessionId, {
        type: "transcript.final_repass.failed",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          reason: "provider_error",
          model: finalTranscriptModel,
          providerDurationMs: finalRepassProviderDurationMs,
          stateLoadDurationMs,
          liveTranscriptTextLength: liveTranscript.length,
          rawAudioByteLength: getRawAudioByteLength(rawAudio),
          rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
          durationMs: Date.now() - startedAtMs
        }
      });
    }
  } else {
    await store.appendAuditEvent(sessionId, {
      type: "transcript.final_repass.skipped",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        reason: openAiApiKey ? "missing_raw_audio" : "missing_api_key",
        stateLoadDurationMs,
        liveTranscriptTextLength: liveTranscript.length,
        rawAudioByteLength: getRawAudioByteLength(rawAudio),
        rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
        durationMs: Date.now() - startedAtMs
      }
    });
  }

  const transcriptSelection = selectEffectiveTranscript({
    finalTranscript: transcriptOverride,
    liveTranscript
  });
  const effectiveTranscript = transcriptSelection.text;

  if (transcriptSelection.discardedFinalRepass) {
    await store.appendAuditEvent(sessionId, {
      type: "transcript.final_repass.discarded",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        reason: "shorter_than_live_transcript",
        finalTextLength: transcriptOverride.trim().length,
        finalTextSha256: hashText(transcriptOverride),
        liveTextLength: liveTranscript.length,
        selectedSource: transcriptSelection.source
      }
    });
  }

  return {
    text: effectiveTranscript,
    source: transcriptSelection.source,
    discardedFinalRepass: transcriptSelection.discardedFinalRepass,
    finalTranscriptTextLength: transcriptOverride.trim().length,
    liveTranscriptTextLength: liveTranscript.length,
    textLength: effectiveTranscript.length,
    textSha256: hashText(effectiveTranscript),
    provider:
      transcriptSelection.source === "final_repass"
        ? finalTranscriptMeta?.model || null
        : state.session.liveSttProvider || null,
    finalTranscriptMeta,
    finalRepassAttempted,
    finalRepassSucceeded,
    finalRepassProviderDurationMs,
    rawTextLength: finalTranscriptMeta?.rawTextLength ?? transcriptOverride.trim().length,
    promptLeakStripped: Boolean(finalTranscriptMeta?.promptLeakStripped),
    hadRawAudio: Boolean(rawAudio?.pcmBuffer?.length),
    rawAudioByteLength: getRawAudioByteLength(rawAudio),
    rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
    startedAt,
    completedAt: nowIso(),
    durationMs: Date.now() - startedAtMs
  };
}

export async function finalizeSession({
  store,
  sessionId,
  model = process.env.OPENAI_SOAP_MODEL || "gpt-5.4-nano",
  openAiApiKey = process.env.OPENAI_API_KEY || "",
  finalTranscriptModel = process.env.OPENAI_FINAL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
  finalTranscriptLanguage = process.env.OPENAI_FINAL_TRANSCRIBE_LANGUAGE || "ja",
  soapReasoningEffort = process.env.OPENAI_SOAP_REASONING_EFFORT || "low",
  rawAudio = null,
  preparedTranscript = null,
  onSoapOutputTextSnapshot = null,
  allowMockSoapFallback = defaultAllowMockSoapFallback()
}) {
  const finalizeSessionStartedAtMs = Date.now();
  const state = await store.getSessionState(sessionId);

  if (!state) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const turns = state.turns ?? [];
  let sourceSummary = null;
  let soap = null;
  let soapGeneratedWithOpenAi = false;
  let soapGenerationDurationMs = null;
  let soapSaveDurationMs = null;
  let sessionUpdateDurationMs = null;
  let soapProviderError = null;
  const reusablePreparedTranscript =
    normalizePreparedTranscript(preparedTranscript) || buildPreparedFinalTranscriptFromSession(state.session);
  const transcriptPreparation = reusablePreparedTranscript || await prepareFinalTranscript({
    store,
    sessionId,
    openAiApiKey,
    finalTranscriptModel,
    finalTranscriptLanguage,
    rawAudio
  });
  const effectiveTranscript = transcriptPreparation.text || "";

  const promptProfile = await store.resolvePromptProfile?.({
    orgId: state.session.orgId || state.session.clinicId,
    memberId: state.session.doctorMemberId || state.session.assignedDoctorUserId || state.session.createdByMemberId || state.session.createdByUserId,
    promptProfileId: state.session.promptProfileId
  }) || null;

  if (openAiApiKey && effectiveTranscript) {
    const soapGenerationStartedAt = Date.now();
    await store.appendAuditEvent(sessionId, {
      type: "soap.generation.started",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        model,
        reasoningEffort: soapReasoningEffort,
        transcriptSource: transcriptPreparation.source,
        transcriptTextLength: effectiveTranscript.length,
        turnCount: turns.length,
        rawAudioDurationMs: transcriptPreparation.rawAudioDurationMs,
        preparedTranscriptReused: Boolean(reusablePreparedTranscript)
      }
    });

    try {
      soap = await generateSoapDraftWithOpenAi({
        apiKey: openAiApiKey,
        transcript: effectiveTranscript,
        sessionContext: state.session,
        promptProfile,
        model,
        reasoningEffort: soapReasoningEffort,
        onOutputTextSnapshot: onSoapOutputTextSnapshot
      });
      sourceSummary = soap.source_summary || null;
      soapGeneratedWithOpenAi = true;
      soapGenerationDurationMs = Date.now() - soapGenerationStartedAt;
    } catch (error) {
      soapProviderError = error;
      soapGenerationDurationMs = Date.now() - soapGenerationStartedAt;
      await store.appendAuditEvent(sessionId, {
        type: "soap.generation.failed",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          model,
          reason: "provider_error",
          durationMs: soapGenerationDurationMs,
          ...providerErrorSafePayload(error)
        }
      });
    }
  }

  if (!soap) {
    if (!allowMockSoapFallback) {
      const error = new Error("SOAP下書き作成に失敗しました。時間を置いてもう一度お試しください。");
      error.statusCode = 502;
      copyProviderErrorFields(error, soapProviderError);
      throw error;
    }

    soap = buildMockSoapDraft({
      session: state.session,
      turns,
      transcriptOverride: effectiveTranscript
    });
  }

  const soapUsage = normalizeOpenAiUsage(soap.usage);
  const soapOutputTextLength = String(soap.outputText || soap.output_text || "").length;
  const soapSaveStartedAtMs = Date.now();
  const savedSoap = await store.saveSoapVersion(sessionId, {
    ...soap,
    structuredJson: {
      ...(soap.structuredJson || {}),
      sourceSummary,
      clinicalFacts: null,
      finalTranscript: effectiveTranscript || null,
      rawFinalTranscript: effectiveTranscript || null,
      finalTranscriptSource: transcriptPreparation.source,
      finalTranscriptProvider: String(transcriptPreparation.source || "").startsWith("final_repass")
        ? transcriptPreparation.provider || state.session.liveSttProvider || null
        : state.session.liveSttProvider || null,
      finalTranscriptPreparation: {
        durationMs: Number(transcriptPreparation.durationMs || 0) || 0,
        providerDurationMs: transcriptPreparation.finalRepassProviderDurationMs ?? null,
        hadRawAudio: Boolean(transcriptPreparation.hadRawAudio),
        rawAudioByteLength: Number(transcriptPreparation.rawAudioByteLength || 0) || 0,
        rawAudioDurationMs: transcriptPreparation.rawAudioDurationMs ?? null,
        liveTranscriptTextLength: Number(transcriptPreparation.liveTranscriptTextLength || 0) || 0,
        finalTranscriptTextLength:
          Number(transcriptPreparation.finalTranscriptTextLength || 0) || effectiveTranscript.length,
        finalTranscriptTurnCount: turns.length,
        rawTextLength: transcriptPreparation.rawTextLength ?? null,
        promptLeakStripped: Boolean(transcriptPreparation.promptLeakStripped),
        finalRepassAttempted: transcriptPreparation.finalRepassAttempted,
        finalRepassSucceeded: transcriptPreparation.finalRepassSucceeded,
        preparedTranscriptReused: Boolean(reusablePreparedTranscript)
      },
      performance: {
        transcriptPreparationDurationMs: transcriptPreparation.durationMs,
        finalRepassProviderDurationMs: transcriptPreparation.finalRepassProviderDurationMs,
        soapGenerationDurationMs,
        soapOutputTextLength,
        usage: soapUsage
      },
      promptProfileSnapshot: promptProfile,
      soapFormatSnapshot: promptProfile,
      soapReviewFlags: soap.clinician_review_flags || []
    },
    status: "ready",
    model,
    promptVersion: promptProfile?.promptVersion || "soap-v4-direct",
    templateKey: promptProfile?.templateKey || "outpatient_soap_note",
    promptProfileId: promptProfile?.profileId || null,
    promptProfileVersionId: promptProfile?.profileVersionId || null,
    resolvedPromptHash: promptProfile?.resolvedPromptHash || null,
    inputTranscriptRevision: `${turns.length}-${nowIso()}`,
    createdBy: "system",
    approvedByUserId: null
  });
  soapSaveDurationMs = Date.now() - soapSaveStartedAtMs;

  const sessionUpdateStartedAtMs = Date.now();
  await store.updateSession(sessionId, {
    status: "soap_ready",
    finalSttProvider:
      String(transcriptPreparation.source || "").startsWith("final_repass")
        ? transcriptPreparation.provider || state.session.liveSttProvider || state.session.finalSttProvider
        : state.session.liveSttProvider || state.session.finalSttProvider,
    soapProvider: soapGeneratedWithOpenAi ? "openai" : "mock",
    soapGenerationPreview: null,
    soapGenerationPreviewUpdatedAt: null,
    finalizedAt: nowIso(),
    updatedAt: nowIso()
  });
  sessionUpdateDurationMs = Date.now() - sessionUpdateStartedAtMs;

  await store.appendAuditEvent(sessionId, {
    type: "soap.generation.completed",
    actorType: "system",
    actorId: "finalize-worker",
    safePayload: {
      versionId: savedSoap.versionId,
      sourceSummaryPresent: Boolean(sourceSummary),
      transcriptSource: transcriptPreparation.source,
      transcriptTextLength: effectiveTranscript.length,
      finalTranscriptPreparationDurationMs: transcriptPreparation.durationMs,
      finalRepassProviderDurationMs: transcriptPreparation.finalRepassProviderDurationMs,
      durationMs: soapGenerationDurationMs,
      soapOutputTextLength,
      usage: soapUsage,
      soapSaveDurationMs,
      sessionUpdateDurationMs,
      finalizeSessionDurationMs: Date.now() - finalizeSessionStartedAtMs,
      preparedTranscriptReused: Boolean(reusablePreparedTranscript)
    }
  });

  return {
    session: {
      ...state.session,
      status: "soap_ready",
      finalizedAt: nowIso()
    },
    latestSoap: savedSoap,
    turns
  };
}
