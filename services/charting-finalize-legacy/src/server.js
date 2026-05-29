import crypto from "node:crypto";
import express from "express";
import { buildPreparedFinalTranscriptFromSession, createStore, downloadRawAudioFromGcs, finalizeSession, nowIso } from "@medical/core";
import { finalizeTaskPayloadSchema, parseJsonBody } from "@medical/contracts";

const app = express();
app.use(express.json({ limit: "1mb" }));

function normalizeHeaderSecret(value) {
  return String(value || "").replace(/[\r\n]+$/g, "");
}

const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
const finalizeInternalSecret = normalizeHeaderSecret(process.env.FINALIZE_INTERNAL_SECRET);
const FINALIZE_INTERNAL_SECRET_HEADER = "X-Finalize-Internal-Secret";

if (isProduction && !finalizeInternalSecret) {
  throw new Error("FINALIZE_INTERNAL_SECRET must be configured in production");
}

const store = createStore({
  backend: process.env.STORE_BACKEND
});
const SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS = Number(process.env.SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS || 1000);
const SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS = Number(process.env.SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS || 120);
const SOAP_GENERATION_PREVIEW_MAX_CHARS = Number(process.env.SOAP_GENERATION_PREVIEW_MAX_CHARS || 120_000);

function elapsedSince(isoString, nowMs = Date.now()) {
  const parsed = Date.parse(isoString || "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

function getRawAudioByteLength(rawAudio) {
  return rawAudio?.byteLength || rawAudio?.pcmBuffer?.length || 0;
}

function getRawAudioDurationMs(rawAudio) {
  const byteLength = getRawAudioByteLength(rawAudio);
  const bytesPerSecond = Math.max(1, (rawAudio?.sampleRateHz || 24_000) * (rawAudio?.channels || 1) * 2);
  return byteLength ? Math.round((byteLength / bytesPerSecond) * 1000) : null;
}

async function appendAuditEventSafe(sessionId, eventInput) {
  try {
    await store.appendAuditEvent(sessionId, eventInput);
  } catch (error) {
    console.warn("audit event append failed", safeErrorLogFields(error, {
      sessionId,
      type: eventInput?.type
    }));
  }
}

function normalizeSoapGenerationPreview(text) {
  const preview = String(text || "");
  if (preview.length <= SOAP_GENERATION_PREVIEW_MAX_CHARS) {
    return preview;
  }

  return preview.slice(preview.length - SOAP_GENERATION_PREVIEW_MAX_CHARS);
}

function createSoapGenerationPreviewPublisher(sessionId) {
  return {
    lastPersistedText: "",
    lastPersistedAtMs: 0,
    async publish(text) {
      const preview = normalizeSoapGenerationPreview(text);
      if (!preview) {
        return;
      }

      const nowMs = Date.now();
      const deltaChars = Math.abs(preview.length - this.lastPersistedText.length);
      const shouldPersist =
        !this.lastPersistedText ||
        nowMs - this.lastPersistedAtMs >= SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS ||
        deltaChars >= SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS;

      if (!shouldPersist) {
        return;
      }

      const updatedAt = nowIso();
      this.lastPersistedText = preview;
      this.lastPersistedAtMs = nowMs;
      await store.updateSession(sessionId, {
        soapGenerationPreview: preview,
        soapGenerationPreviewUpdatedAt: updatedAt,
        updatedAt
      });
    }
  };
}

function timingSafeStringEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function safeErrorLogFields(error, extra = {}) {
  const fields = {
    ...extra,
    errorName: error?.name || "Error",
    errorCode: error?.code || null,
    statusCode: error?.statusCode || null
  };

  if (!isProduction && error?.message) {
    fields.message = error.message;
  }

  return fields;
}

function requireInternalFinalizeAuth(req, res, next) {
  if (!finalizeInternalSecret) {
    res.status(503).json({
      ok: false,
      error: "Finalize worker is not configured."
    });
    return;
  }

  const providedSecret = req.get(FINALIZE_INTERNAL_SECRET_HEADER) || "";

  if (!timingSafeStringEqual(providedSecret, finalizeInternalSecret)) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  next();
}

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "medical-finalize",
    timestamp: nowIso(),
    storeBackend: process.env.STORE_BACKEND || "memory"
  });
});

app.post("/internal/finalize", requireInternalFinalizeAuth, async (req, res) => {
  const workerReceivedAtMs = Date.now();
  let sessionId = null;
  let workerContext = null;

  try {
    const payload = parseJsonBody(finalizeTaskPayloadSchema, req.body);
    sessionId = payload.sessionId;
    const state = await store.getSessionState(payload.sessionId);

    if (!state) {
      res.status(404).json({
        ok: false,
        error: "Session not found"
      });
      return;
    }

    if ((state.session.orgId || state.session.clinicId) !== payload.clinicId) {
      res.status(403).json({
        ok: false,
        error: "Session clinic mismatch"
      });
      return;
    }

    const finalizeRequestedAt = payload.finalizeRequestedAt || state.session.finalizeRequestedAt || null;
    const gatewayEnqueuedAt = payload.gatewayEnqueuedAt || null;
    const cloudTaskName = req.get("x-cloudtasks-taskname") || null;
    const cloudTaskQueueName = req.get("x-cloudtasks-queuename") || null;
    workerContext = {
      finalizeRequestedAt,
      gatewayStartedAt: payload.gatewayStartedAt || null,
      gatewayEnqueuedAt,
      workerStartedAfterRequestMs: elapsedSince(finalizeRequestedAt, workerReceivedAtMs),
      cloudTaskQueueDelayMs: elapsedSince(gatewayEnqueuedAt, workerReceivedAtMs),
      cloudTaskName,
      cloudTaskQueueName,
      cloudTaskExecutionCount: Number(req.get("x-cloudtasks-taskexecutioncount") || 0) || null,
      cloudTaskRetryCount: Number(req.get("x-cloudtasks-taskretrycount") || 0) || null
    };
    await appendAuditEventSafe(payload.sessionId, {
      type: "soap.finalize.worker_started",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        ...workerContext,
        rawAudioPathSet: Boolean(payload.rawAudioPath || state.session.rawAudioPath)
      }
    });

    const preparedTranscript = buildPreparedFinalTranscriptFromSession(state.session);
    const rawAudioPath = preparedTranscript ? null : payload.rawAudioPath || state.session.rawAudioPath || null;
    let rawAudio = null;
    let rawAudioDownloadDurationMs = null;

    if (rawAudioPath) {
      const downloadStartedAtMs = Date.now();
      await appendAuditEventSafe(payload.sessionId, {
        type: "audio.raw_audio.download.started",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          rawAudioPathSet: true
        }
      });

      try {
        rawAudio = await downloadRawAudioFromGcs({ rawAudioPath });
        rawAudioDownloadDurationMs = Date.now() - downloadStartedAtMs;
        await appendAuditEventSafe(payload.sessionId, {
          type: "audio.raw_audio.download.completed",
          actorType: "system",
          actorId: "finalize-worker",
          safePayload: {
            durationMs: rawAudioDownloadDurationMs,
            byteLength: getRawAudioByteLength(rawAudio),
            rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
            sampleRateHz: rawAudio.sampleRateHz || null,
            channels: rawAudio.channels || null,
            chunkCount: rawAudio.chunkCount || null
          }
        });
      } catch (error) {
        rawAudioDownloadDurationMs = Date.now() - downloadStartedAtMs;
        await appendAuditEventSafe(payload.sessionId, {
          type: "audio.raw_audio.download.failed",
          actorType: "system",
          actorId: "finalize-worker",
          safePayload: {
            durationMs: rawAudioDownloadDurationMs,
            reason: "storage_error"
          }
        });
        throw error;
      }
    } else {
      await appendAuditEventSafe(payload.sessionId, {
        type: "audio.raw_audio.download.skipped",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          reason: preparedTranscript ? "prepared_transcript_available" : "missing_raw_audio_path"
        }
      });
    }

    const previewPublisher = createSoapGenerationPreviewPublisher(payload.sessionId);
    const result = await finalizeSession({
      store,
      sessionId: payload.sessionId,
      model: process.env.OPENAI_SOAP_MODEL || "gpt-5.4-nano",
      rawAudio,
      preparedTranscript,
      onSoapOutputTextSnapshot: async (outputText) => {
        try {
          await previewPublisher.publish(outputText);
        } catch (error) {
          console.warn("soap generation preview persist failed", safeErrorLogFields(error, {
            sessionId: payload.sessionId,
            reason: "preview_persist_failed"
          }));
        }
      }
    });
    const performance = result.latestSoap?.structuredJson?.performance || {};
    const transcriptPreparation = result.latestSoap?.structuredJson?.finalTranscriptPreparation || {};
    await appendAuditEventSafe(payload.sessionId, {
      type: "soap.finalize.worker_completed",
      actorType: "system",
      actorId: "finalize-worker",
      safePayload: {
        ...workerContext,
        durationMs: Date.now() - workerReceivedAtMs,
        totalSinceRequestedMs: elapsedSince(finalizeRequestedAt),
        rawAudioDownloadDurationMs,
        rawAudioByteLength: getRawAudioByteLength(rawAudio),
        rawAudioDurationMs: getRawAudioDurationMs(rawAudio),
        transcriptPreparationDurationMs: transcriptPreparation.durationMs ?? null,
        finalRepassProviderDurationMs: transcriptPreparation.providerDurationMs ?? null,
        soapGenerationDurationMs: performance.soapGenerationDurationMs ?? null,
        soapOutputTextLength: performance.soapOutputTextLength ?? null,
        usage: performance.usage || null,
        soapVersionId: result.latestSoap.versionId,
        status: result.session.status
      }
    });

    res.json({
      ok: true,
      sessionId: payload.sessionId,
      status: result.session.status,
      soapVersionId: result.latestSoap.versionId
    });
  } catch (error) {
    if (sessionId) {
      await appendAuditEventSafe(sessionId, {
        type: "soap.finalize.worker_failed",
        actorType: "system",
        actorId: "finalize-worker",
        safePayload: {
          ...(workerContext || {}),
          durationMs: Date.now() - workerReceivedAtMs,
          reason: "finalize_task_failed"
        }
      });
    }

    console.error("finalize task failed", safeErrorLogFields(error, {
      reason: "finalize_task_failed"
    }));
    res.status(400).json({
      ok: false,
      error: error.publicMessage || "SOAP下書き作成に失敗しました。時間を置いてもう一度お試しください。"
    });
  }
});

const port = Number(process.env.FINALIZE_PORT || 8082);
app.listen(port, () => {
  console.log(`medical-finalize listening on :${port}`);
});
