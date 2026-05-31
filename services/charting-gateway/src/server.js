import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import {
  buildHighlightsFromTurns,
  buildMockSoapDraft,
  buildTotpUri,
  createStore,
  createTotpSecret,
  createLiveSttConfigFromEnv,
  decryptField,
  DEFAULT_SOAP_FORMAT_PROFILE,
  encryptField,
  inferSoapFormatFromSampleNotes,
  finalizeSession,
  generateSoapDraftWithOpenAi,
  getOrganizationAccessState,
  isRawAudioStorageConfigured,
  LiveSttPipeline,
  addMinutes,
  nowIso,
  organizationAccessAllowsAuthenticatedLogin,
  organizationAccessAllowsClinicalUse,
  organizationAccessAllowsReadOnlyUse,
  organizationAccessDeniedMessage,
  prepareFinalTranscript,
  signOperatorAccessToken,
  signStreamToken,
  transcribePcmAudioWithOpenAi,
  uploadRawAudioToGcs,
  verifyTotpCode,
  validateSoapFormatDefinition,
  verifyOperatorAccessToken,
  verifyStreamToken
} from "@medical/core";
import {
  approveReviewedNoteRequestSchema,
  archiveSoapFormatRequestSchema,
  assignSoapFormatRequestSchema,
  assignTrustedRecorderRequestSchema,
  authHelloSchema,
  canAssignMemberRoles,
  canManageMembersRoles,
  canManageOrganizationSoapFormatsRoles,
  canManageOwnSoapFormatsRoles,
  canManagePlatformRoles,
  canOpenAdminConsoleRoles,
  canReadOrganizationSessionsRoles,
  claimAudioTestRequestSchema,
  completeAudioTestRequestSchema,
  createAudioTestRequestSchema,
  createSoapFormatRequestSchema,
  createMemberRequestSchema,
  createOrganizationRequestSchema,
  claimPairingRequestSchema,
  createSessionRequestSchema,
  discardRecordingRequestSchema,
  DEFAULT_RECORDING_MAX_DURATION_MINUTES,
  inferSoapFormatRequestSchema,
  memberRolesHavePermission,
  normalizeRecordingMaxDurationMinutes,
  operatorLoginRequestSchema,
  operatorMfaEnrollConfirmRequestSchema,
  operatorMfaVerifyRequestSchema,
  parseJsonBody,
  previewSoapFormatDraftRequestSchema,
  previewSoapFormatRequestSchema,
  publishSoapFormatRequestSchema,
  regenerateSoapRequestSchema,
  recordingAutoStopTaskPayloadSchema,
  registerTrustedRecorderRequestSchema,
  resetMemberPasswordRequestSchema,
  resetMemberMfaRequestSchema,
  revokeTrustedRecorderRequestSchema,
  revokeMemberSessionsRequestSchema,
  saveReviewedNoteRequestSchema,
  selectRecordingSourceRequestSchema,
  startRecordingRequestSchema,
  stopRecordingRequestSchema,
  updateAudioTestStateRequestSchema,
  updateMemberPreferencesRequestSchema,
  updateOrganizationRecordingPolicyRequestSchema,
  updateMemberRolesRequestSchema,
  updateMemberStatusRequestSchema,
  updateSoapFormatDraftRequestSchema,
  updateSessionMetadataRequestSchema,
  updateSessionPromptProfileRequestSchema
} from "@medical/contracts";
import { patientSnapshot as buildPlatformPatientSnapshot } from "../../../packages/platform-contracts/src/index.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import { verifyPassword as verifyPlatformPassword } from "../../platform-api/src/auth/password.js";

const app = express();
app.set("trust proxy", Number.parseInt(process.env.TRUST_PROXY_HOPS || "1", 10) || 1);
app.use(express.json({ limit: "1mb" }));

const API_CACHE_CONTROL_VALUE = "no-store, max-age=0";
const DEFAULT_RECORDING_SOURCE = "linked_mobile";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNonNegativeInteger(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }

  return Math.floor(parsed);
}

function isLocalOrigin(origin) {
  return origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000";
}

function parseAllowedOrigins(value, appBaseUrl, { includeLocalhost = false } = {}) {
  const origins = new Set();

  if (includeLocalhost) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  if (appBaseUrl && (includeLocalhost || !isLocalOrigin(appBaseUrl))) {
    origins.add(appBaseUrl);
  }

  for (const item of (value || "").split(",")) {
    const origin = item.trim();
    if (origin) {
      origins.add(origin);
    }
  }

  return origins;
}

function normalizeHeaderSecret(value) {
  return String(value || "").replace(/[\r\n]+$/g, "");
}

function constantTimeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
const defaultAppBaseUrl = isProduction ? "" : "http://localhost:3000";
const runtimeBootstrapRequested = parseBoolean(process.env.APP_ENABLE_RUNTIME_BOOTSTRAP, false);

const config = {
  isProduction,
  appBaseUrl: process.env.APP_BASE_URL || defaultAppBaseUrl,
  publicWsUrl: process.env.PUBLIC_WS_URL || "",
  pairingSigningSecret: process.env.PAIRING_SIGNING_SECRET || "replace-me",
  operatorAccessPassword: process.env.APP_ACCESS_PASSWORD || "",
  operatorSessionSigningSecret: process.env.APP_SESSION_SIGNING_SECRET || "replace-me",
  allowRuntimeBootstrap: runtimeBootstrapRequested && !isProduction,
  defaultOrgId: process.env.APP_DEFAULT_ORG_ID || process.env.APP_DEFAULT_CLINIC_ID || "org_default",
  defaultOrganizationCode: process.env.APP_DEFAULT_ORGANIZATION_CODE || process.env.APP_DEFAULT_CLINIC_ID || "clinic_tokyo_001",
  defaultLoginId: process.env.APP_DEFAULT_LOGIN_ID || "admin",
  defaultOperatorDisplayName: process.env.APP_DEFAULT_OPERATOR_NAME || "管理者",
  port: Number(process.env.PORT || process.env.GATEWAY_PORT || 8081),
  finalizeMode: process.env.FINALIZE_MODE || "inline",
  finalizeEndpoint: process.env.FINALIZE_ENDPOINT || "http://localhost:8082/internal/finalize",
  finalizeInternalSecret: normalizeHeaderSecret(process.env.FINALIZE_INTERNAL_SECRET),
  recordingAutoStopEndpoint: process.env.RECORDING_AUTO_STOP_ENDPOINT || "",
  finalizeTasksQueue: process.env.FINALIZE_TASKS_QUEUE || "",
  finalizeTasksLocation: process.env.FINALIZE_TASKS_LOCATION || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1",
  finalizeTasksProjectId: process.env.FINALIZE_TASKS_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "",
  finalizeTasksServiceAccountEmail: process.env.FINALIZE_TASKS_SERVICE_ACCOUNT_EMAIL || "",
  allowOperatorBearerAuth: parseBoolean(process.env.APP_ALLOW_OPERATOR_BEARER_AUTH, true),
  requireMfaForPrivilegedRoles: parseBoolean(process.env.APP_REQUIRE_PRIVILEGED_MFA, true),
  pendingFinalizeAudioTtlMs: Number(process.env.PENDING_FINALIZE_AUDIO_TTL_MS || 30 * 60 * 1000),
  finalizeStaleTimeoutMs: Number(process.env.FINALIZE_STALE_TIMEOUT_MS || 10 * 60 * 1000),
  finalTranscriptSegmentPrecomputeEnabled: parseBoolean(process.env.FINAL_TRANSCRIPT_SEGMENT_PRECOMPUTE_ENABLED, true),
  finalTranscriptSegmentSeconds: Number(process.env.FINAL_TRANSCRIPT_SEGMENT_SECONDS || 60),
  finalTranscriptSegmentWaitMs: Number(process.env.FINAL_TRANSCRIPT_SEGMENT_WAIT_MS || 5000),
  rawAudioGcsBucket: process.env.RAW_AUDIO_GCS_BUCKET || "",
  rawAudioGcsPrefix: process.env.RAW_AUDIO_GCS_PREFIX || "raw-audio",
  liveStt: createLiveSttConfigFromEnv(process.env),
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS, process.env.APP_BASE_URL || defaultAppBaseUrl, {
    includeLocalhost: !isProduction
  }),
  operatorContextCacheTtlMs: parseNonNegativeInteger(process.env.OPERATOR_CONTEXT_CACHE_TTL_MS, 3000),
  operatorContextCacheMaxEntries: parseNonNegativeInteger(process.env.OPERATOR_CONTEXT_CACHE_MAX_ENTRIES, 1000)
};
const platformAuthBridgeEnabled = parseBoolean(
  process.env.CHARTING_GATEWAY_PLATFORM_AUTH_BRIDGE,
  Boolean(process.env.PLATFORM_GOOGLE_CLOUD_PROJECT || process.env.CORE_GOOGLE_CLOUD_PROJECT)
);
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64 * 1024);
const WS_AUDIO_BYTES_PER_MINUTE_LIMIT = Number(process.env.WS_AUDIO_BYTES_PER_MINUTE_LIMIT || 6_000_000);
const WS_AUDIO_ACTIVITY_BROADCAST_INTERVAL_MS = Number(process.env.WS_AUDIO_ACTIVITY_BROADCAST_INTERVAL_MS || 750);
const OPERATOR_SESSION_COOKIE_NAME = "soaplane_operator_session";
const OPERATOR_CSRF_COOKIE_NAME = "soaplane_operator_csrf";
const COOKIE_OPERATOR_SESSION_TOKEN = "__cookie_operator_session__";
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MFA_REQUIRED_ROLES = new Set(["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin", "auditor"]);
const CHARTING_PRODUCT_ID = "charting";

function assertRequiredSecret(name, value) {
  if (!value || value === "replace-me") {
    throw new Error(`${name} must be configured with a non-default secret`);
  }
}

assertRequiredSecret("PAIRING_SIGNING_SECRET", config.pairingSigningSecret);
assertRequiredSecret("APP_SESSION_SIGNING_SECRET", config.operatorSessionSigningSecret);

if (isProduction && runtimeBootstrapRequested) {
  throw new Error("APP_ENABLE_RUNTIME_BOOTSTRAP must not be enabled in production");
}

if (config.allowRuntimeBootstrap) {
  assertRequiredSecret("APP_ACCESS_PASSWORD", config.operatorAccessPassword);
}

if (isProduction && config.requireMfaForPrivilegedRoles) {
  assertRequiredSecret("APP_FIELD_ENCRYPTION_KEY", process.env.APP_FIELD_ENCRYPTION_KEY || "");
}

if (config.finalizeMode !== "inline") {
  assertRequiredSecret("FINALIZE_INTERNAL_SECRET", config.finalizeInternalSecret);
  assertRequiredSecret("RAW_AUDIO_GCS_BUCKET", config.rawAudioGcsBucket);
}

if (config.finalizeTasksQueue) {
  assertRequiredSecret("FINALIZE_TASKS_PROJECT_ID or GOOGLE_CLOUD_PROJECT", config.finalizeTasksProjectId);
}

function safeErrorLogFields(error, extra = {}) {
  const fields = {
    ...extra,
    errorName: error?.name || "Error",
    errorCode: error?.code || null,
    statusCode: error?.statusCode || null
  };

  if (error?.provider) {
    fields.provider = error.provider;
    fields.providerStatusCode = error.providerStatusCode ?? null;
    fields.providerErrorType = error.providerErrorType ?? null;
    fields.providerErrorCode = error.providerErrorCode ?? null;
    fields.providerErrorParam = error.providerErrorParam ?? null;
    fields.providerModel = error.providerModel ?? null;
    fields.providerMessageSafe = error.safeProviderMessage || error.providerMessageSafe || null;
  }

  if (!config.isProduction && error?.message) {
    fields.message = error.message;
  }

  return fields;
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()");

  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  const origin = req.get("origin");

  if (origin && config.allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-CSRF-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    if (origin && !config.allowedOrigins.has(origin)) {
      res.status(403).end();
      return;
    }

    res.status(204).end();
    return;
  }

  if (origin && !config.allowedOrigins.has(origin)) {
    res.status(403).json({ error: "このアクセス元からは接続できません。" });
    return;
  }

  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", API_CACHE_CONTROL_VALUE);
    res.setHeader("Pragma", "no-cache");
  }

  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  if (
    req.path === "/api/v1/operator/login" ||
    req.path === "/api/v1/operator/logout" ||
    req.path.startsWith("/api/v1/operator/mfa/") ||
    req.path.startsWith("/api/v1/mobile/sessions/")
  ) {
    next();
    return;
  }

  const cookies = parseCookieHeader(req.get("cookie") || "");
  const sessionToken = cookies.get(OPERATOR_SESSION_COOKIE_NAME);

  if (!sessionToken) {
    next();
    return;
  }

  const csrfCookie = cookies.get(OPERATOR_CSRF_COOKIE_NAME);
  const csrfHeader = req.get("x-csrf-token") || "";

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    res.status(403).json({ error: "セキュリティ確認に失敗しました。画面を再読み込みしてからもう一度お試しください。" });
    return;
  }

  next();
});

const store = createStore({
  backend: process.env.STORE_BACKEND,
  allowRuntimeBootstrap: config.allowRuntimeBootstrap
});
const platformStore = platformAuthBridgeEnabled ? createPlatformStoreFromEnv() : null;
const socketIndex = new Map();
const rateLimitBuckets = new Map();
const trustedRecorderRegistry = new Map();
const trustedRecorderAssignments = new Map();
const pendingFinalizeAudio = new Map();
const pendingFinalTranscriptJobs = new Map();
const finalTranscriptSegmenters = new Map();
const recordingAutoStopTimers = new Map();
const soapGenerationPreviewPublishers = new Map();
const operatorContextCache = new Map();

const TRUSTED_RECORDER_STALE_MS = 45_000;
const TRUSTED_RECORDER_ASSIGNMENT_TTL_MS = 3 * 60_000;
const SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS = Number(process.env.SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS || 1000);
const SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS = Number(process.env.SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS || 120);
const SOAP_GENERATION_PREVIEW_MAX_CHARS = Number(process.env.SOAP_GENERATION_PREVIEW_MAX_CHARS || 120_000);

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getRawAudioByteLength(rawAudio) {
  return rawAudio?.byteLength || rawAudio?.pcmBuffer?.length || 0;
}

function getRawAudioDurationMs(rawAudio) {
  const byteLength = getRawAudioByteLength(rawAudio);
  const bytesPerSecond = Math.max(1, (rawAudio?.sampleRateHz || 24_000) * (rawAudio?.channels || 1) * 2);
  return byteLength ? Math.round((byteLength / bytesPerSecond) * 1000) : null;
}

function normalizeAudioMetadata(metadata = {}) {
  return {
    sampleRateHz: Number(metadata.sampleRateHz || 24_000) || 24_000,
    channels: Number(metadata.channels || 1) || 1
  };
}

function getAudioBytesPerSecond(metadata = {}) {
  const normalized = normalizeAudioMetadata(metadata);
  return Math.max(1, normalized.sampleRateHz * normalized.channels * 2);
}

function getFinalTranscriptSegmentTargetBytes(metadata = {}) {
  const segmentSeconds = Math.max(30, Number(config.finalTranscriptSegmentSeconds || 60));
  return Math.max(1, Math.round(getAudioBytesPerSecond(metadata) * segmentSeconds));
}

function resetFinalTranscriptSegmenter(sessionId, reason = "reset") {
  const deleted = finalTranscriptSegmenters.delete(sessionId);

  if (deleted) {
    void appendAuditEventSafe(sessionId, {
      type: "final_transcript.segment_precompute.reset",
      actorType: "system",
      actorId: "gateway",
      safePayload: { reason }
    });
  }
}

function getFinalTranscriptSegmenter(sessionId) {
  return finalTranscriptSegmenters.get(sessionId) || null;
}

function createFinalTranscriptSegmenter(sessionId, { sessionContext = {}, metadata = {} } = {}) {
  if (!config.finalTranscriptSegmentPrecomputeEnabled || !process.env.OPENAI_API_KEY) {
    return null;
  }

  const normalizedMetadata = normalizeAudioMetadata(metadata);
  const startedAt = nowIso();
  const segmenter = {
    sessionId,
    startedAt,
    metadata: normalizedMetadata,
    sessionContext: { ...sessionContext },
    currentChunks: [],
    currentBytes: 0,
    nextSegmentIndex: 0,
    jobs: [],
    completedSegments: new Map(),
    failedSegmentCount: 0,
    totalClosedRawAudioByteLength: 0,
    totalProviderDurationMs: 0,
    readyPromise: null,
    status: "recording"
  };

  finalTranscriptSegmenters.set(sessionId, segmenter);
  return segmenter;
}

function ensureFinalTranscriptSegmenter(sessionId, { sessionContext = {}, metadata = {} } = {}) {
  const existing = getFinalTranscriptSegmenter(sessionId);
  if (existing) {
    existing.sessionContext = {
      ...existing.sessionContext,
      ...sessionContext
    };
    existing.metadata = normalizeAudioMetadata({
      ...existing.metadata,
      ...metadata
    });
    return existing;
  }

  return createFinalTranscriptSegmenter(sessionId, { sessionContext, metadata });
}

function updateFinalTranscriptSegmentMetadata(sessionId, metadata = {}) {
  const segmenter = getFinalTranscriptSegmenter(sessionId);
  if (!segmenter) {
    return;
  }

  segmenter.metadata = normalizeAudioMetadata({
    ...segmenter.metadata,
    ...metadata
  });
}

function getFinalTranscriptSegmentJobStatus(segmenter) {
  if (!segmenter) {
    return "missing";
  }

  if (segmenter.status === "ready" || segmenter.status === "failed") {
    return segmenter.status;
  }

  if (segmenter.jobs.length) {
    return "running";
  }

  return segmenter.currentBytes ? "buffering" : segmenter.status;
}

function buildCompletedSegmentTranscript(segmenter) {
  return Array.from(segmenter.completedSegments.entries())
    .sort(([left], [right]) => left - right)
    .map(([, segment]) => String(segment.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function persistFinalTranscriptSegmentProgress(sessionId, segmenter, { status = "running" } = {}) {
  const text = buildCompletedSegmentTranscript(segmenter);
  const updatedAt = nowIso();
  const rawAudioDurationMs = Math.round((segmenter.totalClosedRawAudioByteLength / getAudioBytesPerSecond(segmenter.metadata)) * 1000);
  const state = await store.getSessionState(sessionId);
  const liveTranscriptTextLength = (state?.turns || [])
    .map((turn) => String(turn.text || "").trim())
    .filter(Boolean)
    .join("\n").length;

  await store.updateSession(sessionId, {
    finalTranscriptPrecomputeStatus: text ? status : "running",
    finalTranscriptPrecomputeSource: "final_repass_segmented",
    finalTranscriptPrecomputeProvider: process.env.OPENAI_FINAL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    finalTranscriptPrecomputeText: text || null,
    finalTranscriptPrecomputeTextLength: text.length,
    finalTranscriptPrecomputeTextSha256: text ? hashText(text) : null,
    finalTranscriptPrecomputeSegmentCount: segmenter.completedSegments.size,
    finalTranscriptPrecomputeFailedSegmentCount: segmenter.failedSegmentCount,
    finalTranscriptPrecomputeRawAudioByteLength: segmenter.totalClosedRawAudioByteLength,
    finalTranscriptPrecomputeAudioDurationMs: rawAudioDurationMs || null,
    finalTranscriptPrecomputeProviderDurationMs: segmenter.totalProviderDurationMs || null,
    finalTranscriptPrecomputeLiveTranscriptTextLength: liveTranscriptTextLength,
    finalTranscriptPrecomputeStartedAt: segmenter.startedAt,
    finalTranscriptPrecomputeCompletedAt: status === "ready" ? updatedAt : null,
    finalTranscriptPrecomputeDurationMs: Date.parse(updatedAt) - Date.parse(segmenter.startedAt),
    updatedAt
  });

  return text;
}

async function transcribeFinalTranscriptSegment(sessionId, segmenter, segment) {
  const startedAtMs = Date.now();

  await appendAuditEventSafe(sessionId, {
    type: "final_transcript.segment_precompute.started",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      segmentIndex: segment.index,
      rawAudioByteLength: segment.byteLength,
      rawAudioDurationMs: getRawAudioDurationMs(segment.rawAudio),
      sampleRateHz: segment.rawAudio.sampleRateHz,
      channels: segment.rawAudio.channels
    }
  });

  try {
    const state = await store.getSessionState(sessionId);
    const transcriptHint = (state?.turns || [])
      .map((turn) => String(turn.text || "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-8000);
    const retranscribed = await transcribePcmAudioWithOpenAi({
      apiKey: process.env.OPENAI_API_KEY || "",
      pcmBuffer: segment.rawAudio.pcmBuffer,
      sampleRateHz: segment.rawAudio.sampleRateHz,
      channels: segment.rawAudio.channels,
      model: process.env.OPENAI_FINAL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      language: process.env.OPENAI_FINAL_TRANSCRIBE_LANGUAGE || "ja",
      sessionContext: {
        ...(state?.session || {}),
        ...(segmenter.sessionContext || {})
      },
      transcriptHint
    });
    const providerDurationMs = Date.now() - startedAtMs;

    segmenter.completedSegments.set(segment.index, {
      text: retranscribed.text,
      provider: retranscribed.model,
      providerDurationMs,
      byteLength: segment.byteLength
    });
    segmenter.totalProviderDurationMs += providerDurationMs;

    try {
      await persistFinalTranscriptSegmentProgress(sessionId, segmenter, { status: "running" });
    } catch (error) {
      console.warn("final transcript segment progress persist failed", safeErrorLogFields(error, {
        sessionId,
        segmentIndex: segment.index,
        reason: "segment_progress_persist_failed"
      }));
    }

    await appendAuditEventSafe(sessionId, {
      type: "final_transcript.segment_precompute.completed",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        segmentIndex: segment.index,
        model: retranscribed.model,
        textLength: retranscribed.text.length,
        textSha256: hashText(retranscribed.text),
        rawTextLength: retranscribed.rawTextLength ?? null,
        promptLeakStripped: Boolean(retranscribed.promptLeakStripped),
        providerDurationMs,
        rawAudioByteLength: segment.byteLength,
        rawAudioDurationMs: getRawAudioDurationMs(segment.rawAudio)
      }
    });

    return retranscribed;
  } catch (error) {
    segmenter.failedSegmentCount += 1;
    await appendAuditEventSafe(sessionId, {
      type: "final_transcript.segment_precompute.failed",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        segmentIndex: segment.index,
        reason: "provider_error",
        durationMs: Date.now() - startedAtMs,
        rawAudioByteLength: segment.byteLength,
        rawAudioDurationMs: getRawAudioDurationMs(segment.rawAudio)
      }
    });
    console.warn("final transcript segment precompute failed", safeErrorLogFields(error, {
      sessionId,
      segmentIndex: segment.index,
      reason: "segment_precompute_failed"
    }));
    return null;
  }
}

function closeFinalTranscriptSegment(sessionId, segmenter, { tail = false } = {}) {
  if (!segmenter?.currentBytes) {
    return null;
  }

  const rawAudio = {
    pcmBuffer: Buffer.concat(segmenter.currentChunks),
    sampleRateHz: segmenter.metadata.sampleRateHz,
    channels: segmenter.metadata.channels,
    chunkCount: segmenter.currentChunks.length,
    byteLength: segmenter.currentBytes,
    context: { ...segmenter.sessionContext }
  };
  const segment = {
    index: segmenter.nextSegmentIndex,
    rawAudio,
    byteLength: segmenter.currentBytes,
    tail
  };

  segmenter.nextSegmentIndex += 1;
  segmenter.totalClosedRawAudioByteLength += segment.byteLength;
  segmenter.currentChunks = [];
  segmenter.currentBytes = 0;

  const job = transcribeFinalTranscriptSegment(sessionId, segmenter, segment);
  segmenter.jobs.push(job);
  return job;
}

function appendFinalTranscriptSegmentAudio(sessionId, chunk, { sessionContext = {}, metadata = {} } = {}) {
  const segmenter = ensureFinalTranscriptSegmenter(sessionId, { sessionContext, metadata });
  if (!segmenter) {
    return;
  }

  const buffer = Buffer.isBuffer(chunk)
    ? Buffer.from(chunk)
    : ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(chunk);
  segmenter.currentChunks.push(buffer);
  segmenter.currentBytes += buffer.length;

  if (segmenter.currentBytes >= getFinalTranscriptSegmentTargetBytes(segmenter.metadata)) {
    closeFinalTranscriptSegment(sessionId, segmenter);
  }
}

function finalizeFinalTranscriptSegmentPrecompute(sessionId) {
  const segmenter = getFinalTranscriptSegmenter(sessionId);

  if (!segmenter) {
    return null;
  }

  if (segmenter.readyPromise) {
    return segmenter.readyPromise;
  }

  segmenter.status = "finalizing";
  closeFinalTranscriptSegment(sessionId, segmenter, { tail: true });

  segmenter.readyPromise = Promise.allSettled(segmenter.jobs)
    .then(async () => {
      const text = buildCompletedSegmentTranscript(segmenter);
      if (!text || segmenter.failedSegmentCount > 0) {
        segmenter.status = "failed";
        await store.updateSession(sessionId, {
          finalTranscriptPrecomputeStatus: "failed",
          finalTranscriptPrecomputeCompletedAt: nowIso(),
          updatedAt: nowIso()
        });
        await appendAuditEventSafe(sessionId, {
          type: "final_transcript.segment_precompute.unavailable",
          actorType: "system",
          actorId: "gateway",
          safePayload: {
            reason: text ? "segment_failed" : "empty_transcript",
            segmentCount: segmenter.completedSegments.size,
            failedSegmentCount: segmenter.failedSegmentCount
          }
        });
        return null;
      }

      segmenter.status = "ready";
      await persistFinalTranscriptSegmentProgress(sessionId, segmenter, { status: "ready" });
      await appendAuditEventSafe(sessionId, {
        type: "final_transcript.segment_precompute.ready",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          segmentCount: segmenter.completedSegments.size,
          failedSegmentCount: segmenter.failedSegmentCount,
          textLength: text.length,
          textSha256: hashText(text),
          rawAudioByteLength: segmenter.totalClosedRawAudioByteLength,
          rawAudioDurationMs: Math.round((segmenter.totalClosedRawAudioByteLength / getAudioBytesPerSecond(segmenter.metadata)) * 1000)
        }
      });
      return text;
    })
    .catch(async (error) => {
      segmenter.status = "failed";
      console.warn("final transcript segment precompute unavailable", safeErrorLogFields(error, {
        sessionId,
        reason: "segment_precompute_unavailable"
      }));
      await store.updateSession(sessionId, {
        finalTranscriptPrecomputeStatus: "failed",
        finalTranscriptPrecomputeCompletedAt: nowIso(),
        updatedAt: nowIso()
      });
      return null;
    });

  return segmenter.readyPromise;
}

async function waitForFinalTranscriptSegmentPrecompute(sessionId, timeoutMs = config.finalTranscriptSegmentWaitMs) {
  const segmenter = getFinalTranscriptSegmenter(sessionId);
  const job = segmenter?.readyPromise || null;

  if (!job) {
    return null;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  return Promise.race([
    job,
    wait(timeoutMs).then(() => null)
  ]);
}

function setPendingFinalizeAudio(sessionId, rawAudio) {
  pendingFinalizeAudio.set(sessionId, {
    rawAudio,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingFinalizeAudioTtlMs,
    failedAt: null
  });
}

function getPendingFinalizeAudio(sessionId) {
  const entry = pendingFinalizeAudio.get(sessionId);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    pendingFinalizeAudio.delete(sessionId);
    void appendAuditEventSafe(sessionId, {
      type: "audio.pending_finalize.expired",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        ttlMs: config.pendingFinalizeAudioTtlMs
      }
    });
    return null;
  }

  return entry.rawAudio;
}

function deletePendingFinalizeAudio(sessionId, reason = "deleted") {
  const deleted = pendingFinalizeAudio.delete(sessionId);

  if (deleted) {
    void appendAuditEventSafe(sessionId, {
      type: "audio.pending_finalize.deleted",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        reason
      }
    });
  }

  return deleted;
}

function markPendingFinalizeAudioFailed(sessionId) {
  const entry = pendingFinalizeAudio.get(sessionId);

  if (entry) {
    entry.failedAt = Date.now();
  }
}

async function persistRawAudioIfConfigured(sessionId, rawAudio) {
  if (!rawAudio?.pcmBuffer?.length || !isRawAudioStorageConfigured({ bucketName: config.rawAudioGcsBucket })) {
    return null;
  }

  const stored = await uploadRawAudioToGcs({
    sessionId,
    rawAudio,
    bucketName: config.rawAudioGcsBucket,
    prefix: config.rawAudioGcsPrefix
  });

  await store.updateSession(sessionId, {
    rawAudioPath: stored.rawAudioPath,
    updatedAt: nowIso()
  });
  await appendAuditEventSafe(sessionId, {
    type: "audio.raw_audio.stored",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      rawAudioPathSet: true,
      metadataPathSet: Boolean(stored.metadataPath),
      byteLength: stored.byteLength,
      durationMs: stored.durationMs,
      sampleRateHz: stored.sampleRateHz,
      channels: stored.channels,
      sha256: stored.sha256
    }
  });

  return stored;
}

function getFinalTranscriptJobStatus(job) {
  return job?.status || "missing";
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

function beginSoapGenerationPreview(sessionId) {
  const token = crypto.randomUUID();
  soapGenerationPreviewPublishers.set(sessionId, {
    token,
    lastBroadcastText: "",
    lastPersistedText: "",
    lastPersistedAtMs: 0,
    persistChain: Promise.resolve()
  });

  return token;
}

function finishSoapGenerationPreview(sessionId) {
  soapGenerationPreviewPublishers.delete(sessionId);
}

function publishSoapGenerationPreview(sessionId, token, text) {
  const publisher = soapGenerationPreviewPublishers.get(sessionId);

  if (!publisher || publisher.token !== token) {
    return Promise.resolve();
  }

  const preview = normalizeSoapGenerationPreview(text);
  if (!preview) {
    return Promise.resolve();
  }

  const updatedAt = nowIso();
  if (publisher.lastBroadcastText !== preview) {
    publisher.lastBroadcastText = preview;
    broadcast(
      sessionId,
      {
        type: "soap.stream.updated",
        sessionId,
        outputText: preview,
        updatedAt
      },
      ["pc"]
    );
  }

  const nowMs = Date.now();
  const deltaChars = Math.abs(preview.length - publisher.lastPersistedText.length);
  const shouldPersist =
    !publisher.lastPersistedText ||
    nowMs - publisher.lastPersistedAtMs >= SOAP_GENERATION_PREVIEW_PERSIST_INTERVAL_MS ||
    deltaChars >= SOAP_GENERATION_PREVIEW_PERSIST_MIN_DELTA_CHARS;

  if (!shouldPersist) {
    return Promise.resolve();
  }

  publisher.lastPersistedText = preview;
  publisher.lastPersistedAtMs = nowMs;
  publisher.persistChain = publisher.persistChain
    .catch(() => {})
    .then(async () => {
      const current = soapGenerationPreviewPublishers.get(sessionId);
      if (!current || current.token !== token) {
        return;
      }

      await store.updateSession(sessionId, {
        soapGenerationPreview: preview,
        soapGenerationPreviewUpdatedAt: updatedAt,
        updatedAt
      });
    })
    .catch((error) => {
      console.warn("soap generation preview persist failed", safeErrorLogFields(error, {
        sessionId,
        reason: "preview_persist_failed"
      }));
    });

  return publisher.persistChain;
}

async function appendMfaFailureAuditSafe({ orgId, memberId, reason, purpose }) {
  if (!orgId) {
    return;
  }

  try {
    if (platformAuthBridgeEnabled) {
      await platformStore.createAuditEvent(orgId, {
        eventType: "auth.mfa_failed",
        actorMemberId: memberId || null,
        safePayload: {
          memberId: memberId || null,
          reason,
          purpose
        }
      });
      return;
    }

    await store.appendOrganizationAuditEvent(orgId, {
      type: "auth.mfa_failed",
      actorType: "user",
      actorId: memberId || "unknown-member",
      safePayload: {
        memberId: memberId || null,
        reason,
        purpose
      }
    });
  } catch (error) {
    console.warn("mfa failure audit append failed", safeErrorLogFields(error, {
      orgId,
      reason,
      purpose
    }));
  }
}

async function appendOrganizationAuditEventSafe(orgId, eventInput = {}) {
  if (!orgId) {
    return;
  }

  try {
    if (platformAuthBridgeEnabled && typeof platformStore?.createAuditEvent === "function") {
      await platformStore.createAuditEvent(orgId, {
        eventType: eventInput.type || eventInput.eventType || "organization.event",
        actorMemberId: eventInput.actorId || eventInput.actorMemberId || null,
        safePayload: eventInput.safePayload || {}
      });
      return;
    }

    await store.appendOrganizationAuditEvent?.(orgId, eventInput);
  } catch (error) {
    console.warn("organization audit event append failed", safeErrorLogFields(error, {
      orgId,
      type: eventInput?.type || eventInput?.eventType
    }));
  }
}

function createPairingUrl(pairingId, plainToken) {
  return `${config.appBaseUrl}/mobile/join#pairingId=${encodeURIComponent(pairingId)}&token=${encodeURIComponent(plainToken)}`;
}

function createAudioTestJoinUrl(testId, plainToken) {
  return `${config.appBaseUrl}/mobile/audio-test#testId=${encodeURIComponent(testId)}&token=${encodeURIComponent(plainToken)}`;
}

function getOrgIdForOperator(operatorPayload) {
  return operatorPayload?.orgId || operatorPayload?.clinicId || config.defaultOrgId;
}

function getAdminTargetOrgId(req) {
  const currentOrgId = getOrgIdForOperator(req.operator);
  const requestedOrgId = String(req.query.orgId || "").trim();

  if (!requestedOrgId) {
    return currentOrgId;
  }

  if (canManagePlatformSettings(req.operator)) {
    return requestedOrgId;
  }

  if (requestedOrgId !== currentOrgId) {
    throw createPublicError("別の病院の設定を操作する権限がありません。", 403);
  }

  return currentOrgId;
}

function getMemberIdForOperator(operatorPayload) {
  return operatorPayload?.memberId || operatorPayload?.sub || "unknown-member";
}

function getRolesForOperator(operatorPayload) {
  return Array.isArray(operatorPayload?.roles) ? operatorPayload.roles : ["doctor"];
}

function normalizeRecordingSource(value) {
  return value === "local_browser" ? "local_browser" : DEFAULT_RECORDING_SOURCE;
}

function hasOperatorPermission(operatorPayload, permission) {
  return memberRolesHavePermission(getRolesForOperator(operatorPayload), permission);
}

function hasAnyOperatorPermission(operatorPayload, permissions = []) {
  return permissions.some((permission) => hasOperatorPermission(operatorPayload, permission));
}

function canOpenAdminConsole(operatorPayload) {
  return canOpenAdminConsoleRoles(getRolesForOperator(operatorPayload));
}

function canOpenSettingsConsole(operatorPayload) {
  return hasOperatorPermission(operatorPayload, "settings:open");
}

function canManageOrganizationSoapFormats(operatorPayload) {
  return canManageOrganizationSoapFormatsRoles(getRolesForOperator(operatorPayload));
}

function canManageOwnSoapFormats(operatorPayload) {
  return canManageOwnSoapFormatsRoles(getRolesForOperator(operatorPayload));
}

function canManageMembers(operatorPayload) {
  return canManageMembersRoles(getRolesForOperator(operatorPayload));
}

function canManagePlatformSettings(operatorPayload) {
  return canManagePlatformRoles(getRolesForOperator(operatorPayload));
}

function canManageOrganizationSettings(operatorPayload) {
  return hasOperatorPermission(operatorPayload, "settings:manage_org");
}

function operatorBillingRoles(operatorPayloadOrRoles) {
  return Array.isArray(operatorPayloadOrRoles)
    ? operatorPayloadOrRoles
    : getRolesForOperator(operatorPayloadOrRoles);
}

function operatorAccessSource(operatorPayload = null) {
  return operatorPayload?.organizationAccess || operatorPayload?.organization || null;
}

function operatorCanAuthenticateForAccess(operatorPayload = null) {
  if (!operatorPayload) {
    return false;
  }

  return organizationAccessAllowsAuthenticatedLogin(operatorAccessSource(operatorPayload), {
    roles: operatorBillingRoles(operatorPayload)
  });
}

function operatorCanReadWithAccess(operatorPayload = null) {
  if (!operatorPayload) {
    return false;
  }

  return organizationAccessAllowsReadOnlyUse(operatorAccessSource(operatorPayload), {
    roles: operatorBillingRoles(operatorPayload)
  });
}

function operatorCanUseClinicalFeatures(operatorPayload = null) {
  if (!operatorPayload) {
    return false;
  }

  return organizationAccessAllowsClinicalUse(operatorAccessSource(operatorPayload), {
    roles: operatorBillingRoles(operatorPayload)
  });
}

function organizationCanUseClinicalFeatures(organization = null, { roles = [] } = {}) {
  if (!organization) {
    return false;
  }

  return organizationAccessAllowsClinicalUse(organization, {
    roles
  });
}

function operatorAccessDeniedMessage(operatorPayload = null, mode = "clinical") {
  return organizationAccessDeniedMessage(operatorAccessSource(operatorPayload), {
    roles: operatorBillingRoles(operatorPayload),
    mode
  }) || "この操作は現在利用できません。";
}

function isOwnSoapFormat(operatorPayload, formatOrInput = {}) {
  return formatOrInput?.scope === "member" && formatOrInput?.ownerMemberId === getMemberIdForOperator(operatorPayload);
}

function canReadSoapFormats(operatorPayload) {
  return canManageOrganizationSoapFormats(operatorPayload) || canManageOwnSoapFormats(operatorPayload);
}

function canEditSoapFormat(operatorPayload, formatOrInput = {}) {
  return canManageOrganizationSoapFormats(operatorPayload) ||
    (canManageOwnSoapFormats(operatorPayload) && isOwnSoapFormat(operatorPayload, formatOrInput));
}

function canPublishSoapFormat(operatorPayload, formatOrInput = {}) {
  return canEditSoapFormat(operatorPayload, formatOrInput);
}

function getClinicIdForRecorder(operatorPayload) {
  return getOrgIdForOperator(operatorPayload);
}

function trustedRecorderKey(clinicId, deviceId) {
  return `${clinicId}:${deviceId}`;
}

async function findTrustedRecorderByDeviceId(deviceId) {
  if (typeof store.findTrustedRecorderByDeviceId === "function") {
    return store.findTrustedRecorderByDeviceId(deviceId);
  }

  for (const recorder of trustedRecorderRegistry.values()) {
    if (recorder.deviceId === deviceId && recorder.status !== "revoked") {
      return recorder;
    }
  }

  return null;
}

function operatorIsAssignedToSession(operatorPayload, session) {
  const memberId = getMemberIdForOperator(operatorPayload);

  return Boolean(
    (session.accessMemberIds || []).includes(memberId) ||
    session.createdByMemberId === memberId ||
    session.createdByUserId === memberId ||
    session.doctorMemberId === memberId ||
    session.assignedDoctorUserId === memberId
  );
}

function operatorCanReadSession(operatorPayload, session) {
  const orgId = getOrgIdForOperator(operatorPayload);
  const roles = getRolesForOperator(operatorPayload);
  const sessionOrgId = session?.orgId || session?.clinicId;

  if (!sessionOrgId || sessionOrgId !== orgId) {
    return false;
  }

  if (canReadOrganizationSessionsRoles(roles)) {
    return true;
  }

  if (!operatorIsAssignedToSession(operatorPayload, session)) {
    return false;
  }

  if (hasAnyOperatorPermission(operatorPayload, [
    "sessions:read_assigned",
    "transcript:read_assigned",
    "soap:read_assigned"
  ])) {
    return true;
  }

  return session?.status === "approved" && hasAnyOperatorPermission(operatorPayload, [
    "sessions:read_approved_assigned",
    "soap:export_approved"
  ]);
}

const SESSION_ACTION_PERMISSIONS = {
  create: ["sessions:create"],
  hide: [
    "sessions:read_assigned",
    "sessions:read_approved_assigned",
    "transcript:read_assigned",
    "soap:read_assigned",
    "soap:export_approved"
  ],
  updateMetadata: [
    "sessions:update_assigned",
    "sessions:update_metadata_assigned"
  ],
  selectPrompt: ["sessions:update_assigned", "soap:generate_assigned"],
  controlRecording: ["recording:control_assigned"],
  generateSoap: ["soap:generate_assigned"],
  editSoap: ["soap:edit_assigned", "soap:edit_draft_assigned"],
  approveSoap: ["soap:approve_assigned"]
};

function operatorCanPerformSessionAction(operatorPayload, session, action) {
  if (action === "read") {
    return operatorCanReadSession(operatorPayload, session);
  }

  const orgId = getOrgIdForOperator(operatorPayload);
  const sessionOrgId = session?.orgId || session?.clinicId;

  if (!sessionOrgId || sessionOrgId !== orgId) {
    return false;
  }

  if (!operatorIsAssignedToSession(operatorPayload, session)) {
    return false;
  }

  return hasAnyOperatorPermission(operatorPayload, SESSION_ACTION_PERMISSIONS[action] || []);
}

function operatorCanCreateSession(operatorPayload) {
  return hasAnyOperatorPermission(operatorPayload, SESSION_ACTION_PERMISSIONS.create);
}

function forbiddenSessionActionMessage(action) {
  return {
    create: "診療を作成する権限がありません。",
    hide: "この診療を非表示にする権限がありません。",
    updateMetadata: "患者情報を編集する権限がありません。",
    selectPrompt: "この診療のプロンプトを変更する権限がありません。",
    controlRecording: "録音を操作する権限がありません。",
    generateSoap: "SOAP下書きを作成する権限がありません。",
    editSoap: "SOAP下書きを編集する権限がありません。",
    approveSoap: "SOAPを確定する権限がありません。",
    read: "この診療を閲覧する権限がありません。"
  }[action] || "この操作を行う権限がありません。";
}

function warnSessionActionForbidden(action, operatorPayload, session, extra = {}) {
  console.warn(`${action} forbidden`, {
    ...extra,
    action,
    sessionId: session?.sessionId || null,
    sessionStatus: session?.status || null,
    actorId: getMemberIdForOperator(operatorPayload),
    operatorOrgId: getOrgIdForOperator(operatorPayload),
    sessionOrgId: session?.orgId || session?.clinicId || null,
    isAssigned: operatorIsAssignedToSession(operatorPayload, session),
    hasRequiredPermission: hasAnyOperatorPermission(operatorPayload, SESSION_ACTION_PERMISSIONS[action] || [])
  });
}

async function listActiveTrustedRecorders({ clinicId }) {
  const now = Date.now();
  const source = typeof store.listTrustedRecorders === "function"
    ? await store.listTrustedRecorders({ orgId: clinicId })
    : Array.from(trustedRecorderRegistry.values());
  const items = [];

  for (const recorder of source) {
    if (clinicId && recorder.clinicId !== clinicId && recorder.orgId !== clinicId) {
      continue;
    }

    if (recorder.status === "revoked") {
      continue;
    }

    if (now - recorder.lastSeenAt > TRUSTED_RECORDER_STALE_MS) {
      continue;
    }

    items.push(recorder);
  }

  return items.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

function getTrustedRecorderAssignment({ clinicId, deviceId }) {
  const key = trustedRecorderKey(clinicId, deviceId);
  const assignment = trustedRecorderAssignments.get(key);

  if (!assignment) {
    return null;
  }

  if (Date.parse(assignment.expiresAt) < Date.now()) {
    trustedRecorderAssignments.delete(key);
    return null;
  }

  return assignment;
}

function deleteTrustedRecorderAssignmentsForDevice(deviceId, clinicId = null) {
  for (const [key, assignment] of trustedRecorderAssignments.entries()) {
    if (assignment.deviceId !== deviceId) {
      continue;
    }

    if (clinicId && assignment.clinicId !== clinicId && assignment.orgId !== clinicId) {
      continue;
    }

    trustedRecorderAssignments.delete(key);
  }
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

async function checkRateLimit(bucket, identifier, { limit, windowMs }) {
  if (typeof store.checkRateLimit === "function") {
    try {
      const result = await store.checkRateLimit({ bucket, identifier, limit, windowMs });
      return Boolean(result?.limited);
    } catch (error) {
      console.warn("shared rate limit failed; falling back to process memory", safeErrorLogFields(error, { bucket }));
    }
  }

  const key = `${bucket}:${identifier}`;
  const now = Date.now();
  const entry = rateLimitBuckets.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + windowMs
    });
    return false;
  }

  entry.count += 1;
  if (entry.count > limit) {
    return true;
  }

  return false;
}

function rateLimit(bucket, options) {
  return async (req, res, next) => {
    if (await checkRateLimit(bucket, getClientIp(req), options)) {
      res.status(429).json({
        error: "アクセスが集中しています。少し待ってからもう一度お試しください。"
      });
      return;
    }

    next();
  };
}

function extractBearerToken(req) {
  const header = req.get("authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length).trim() || null;
}

function parseCookieHeader(cookieHeader = "") {
  const cookies = new Map();

  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
    } catch {
      cookies.set(rawName, rawValue.join("=") || "");
    }
  }

  return cookies;
}

function extractOperatorCookieTokenFromHeader(cookieHeader = "") {
  return parseCookieHeader(cookieHeader).get(OPERATOR_SESSION_COOKIE_NAME) || null;
}

function extractOperatorCookieToken(req) {
  return extractOperatorCookieTokenFromHeader(req.get("cookie") || "");
}

function verifyOperatorToken(token) {
  return token ? verifyOperatorAccessToken(token, config.operatorSessionSigningSecret) : null;
}

function resolveOperatorPayload(req) {
  return verifyOperatorToken(extractOperatorCookieToken(req)) ||
    (config.allowOperatorBearerAuth ? verifyOperatorToken(extractBearerToken(req)) : null);
}

function operatorSessionCookieOptions({ maxAgeMs = OPERATOR_SESSION_TTL_MS } = {}) {
  return [
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    config.isProduction ? "Secure" : "",
    config.isProduction ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
}

function operatorCsrfCookieOptions({ maxAgeMs = OPERATOR_SESSION_TTL_MS } = {}) {
  return [
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    config.isProduction ? "Secure" : "",
    config.isProduction ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");

  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  res.setHeader("Set-Cookie", Array.isArray(current) ? [...current, cookieValue] : [current, cookieValue]);
}

function setOperatorSessionCookie(res, token) {
  appendSetCookie(res, `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${operatorSessionCookieOptions().join("; ")}`);
}

function clearOperatorSessionCookie(res) {
  appendSetCookie(res, `${OPERATOR_SESSION_COOKIE_NAME}=; ${operatorSessionCookieOptions({ maxAgeMs: 0 }).join("; ")}`);
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function setOperatorCsrfCookie(res, token = createCsrfToken()) {
  appendSetCookie(res, `${OPERATOR_CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; ${operatorCsrfCookieOptions().join("; ")}`);
  return token;
}

function clearOperatorCsrfCookie(res) {
  appendSetCookie(res, `${OPERATOR_CSRF_COOKIE_NAME}=; ${operatorCsrfCookieOptions({ maxAgeMs: 0 }).join("; ")}`);
}

function operatorRequiresMfa(payloadOrContext = {}) {
  if (!config.requireMfaForPrivilegedRoles) {
    return false;
  }

  return getRolesForOperator(payloadOrContext).some((role) => MFA_REQUIRED_ROLES.has(role));
}

function operatorPayloadHasMfa(payload = {}) {
  return Array.isArray(payload.amr) && payload.amr.includes("otp");
}

async function authenticateOperator(input) {
  if (platformAuthBridgeEnabled) {
    return authenticatePlatformOperator(input);
  }

  return store.authenticateMember?.({
    ...input,
    bootstrapPassword: config.allowRuntimeBootstrap ? config.operatorAccessPassword : "",
    defaultOrganizationCode: config.defaultOrganizationCode,
    defaultLoginId: config.defaultLoginId,
    defaultOrgId: config.defaultOrgId,
    defaultDisplayName: config.defaultOperatorDisplayName
  });
}

async function authenticatePlatformOperator({ organizationCode, loginId, password }) {
  const identity = await platformStore.getLoginIdentity(organizationCode, loginId);
  if (!identity || identity.status !== "active") {
    return null;
  }

  let passwordMatches = false;
  try {
    passwordMatches = verifyPlatformPassword(password, identity.passwordHash);
  } catch (_error) {
    passwordMatches = false;
  }

  if (!passwordMatches) {
    await platformStore.recordLoginFailure(identity).catch(() => {});
    return null;
  }

  const [organization, member, entitlement] = await Promise.all([
    platformStore.getOrganization(identity.orgId),
    platformStore.getMember(identity.orgId, identity.memberId),
    platformStore.getProductEntitlement(identity.orgId, CHARTING_PRODUCT_ID)
  ]);

  if (!platformOrganizationAllowsLogin(organization) || !member || member.status !== "active") {
    return null;
  }

  if (!platformEntitlementAllowsChartingUse(entitlement)) {
    return null;
  }

  const refreshedIdentity = await platformStore.recordLoginSuccess(identity).catch(() => identity);
  const normalizedMember = normalizePlatformMemberForGateway(member);
  const mfaRequired = Boolean(refreshedIdentity.mfaRequired) || operatorRequiresMfa(normalizedMember);

  return {
    organization: normalizePlatformOrganizationForGateway(organization),
    member: normalizedMember,
    identity: {
      organizationCode: refreshedIdentity.organizationCode || organization.organizationCode || organizationCode,
      loginId: refreshedIdentity.loginId || loginId,
      orgId: refreshedIdentity.orgId,
      memberId: refreshedIdentity.memberId,
      tokenVersion: Number(refreshedIdentity.tokenVersion || 0),
      mfaRequired,
      mfaEnrolledAt: platformMfaEnrolledAt(refreshedIdentity),
      mfaSecret: refreshedIdentity.mfaSecret || null,
      mfaSecretEncrypted: null
    }
  };
}

function operatorContextCacheIsEnabled() {
  return platformAuthBridgeEnabled && config.operatorContextCacheTtlMs > 0 && config.operatorContextCacheMaxEntries > 0;
}

function operatorContextCacheKey(payload = {}) {
  return [
    payload.organizationCode || "",
    payload.loginId || "",
    payload.memberId || payload.sub || "",
    Number(payload.tokenVersion ?? -1),
    payload.exp || "",
    Array.isArray(payload.amr) ? payload.amr.join(",") : "",
    payload.mfaAt || ""
  ].join("\x1f");
}

function cloneHydratedOperatorPayload(payload = {}) {
  return {
    ...payload,
    roles: Array.isArray(payload.roles) ? [...payload.roles] : [],
    organizationBilling: payload.organizationBilling ? { ...payload.organizationBilling } : payload.organizationBilling,
    organizationAccess: payload.organizationAccess ? { ...payload.organizationAccess } : payload.organizationAccess
  };
}

function pruneOperatorContextCache(now = Date.now()) {
  for (const [key, entry] of operatorContextCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      operatorContextCache.delete(key);
    }
  }

  while (operatorContextCache.size >= config.operatorContextCacheMaxEntries) {
    const oldestKey = operatorContextCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    operatorContextCache.delete(oldestKey);
  }
}

function getCachedOperatorContext(payload) {
  if (!operatorContextCacheIsEnabled()) {
    return null;
  }

  const key = operatorContextCacheKey(payload);
  const entry = operatorContextCache.get(key);
  const now = Date.now();

  if (!entry || entry.expiresAt <= now) {
    operatorContextCache.delete(key);
    return null;
  }

  operatorContextCache.delete(key);
  operatorContextCache.set(key, entry);
  return cloneHydratedOperatorPayload(entry.payload);
}

function setCachedOperatorContext(sourcePayload, hydratedPayload) {
  if (!operatorContextCacheIsEnabled() || !hydratedPayload) {
    return;
  }

  const now = Date.now();
  const tokenExpiresAt = Number(sourcePayload?.exp || 0);
  const cacheExpiresAt = now + config.operatorContextCacheTtlMs;
  const expiresAt = Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0
    ? Math.min(cacheExpiresAt, tokenExpiresAt)
    : cacheExpiresAt;

  if (expiresAt <= now) {
    return;
  }

  pruneOperatorContextCache(now);
  operatorContextCache.set(operatorContextCacheKey(sourcePayload), {
    expiresAt,
    payload: cloneHydratedOperatorPayload(hydratedPayload)
  });
}

function clearOperatorContextCache() {
  operatorContextCache.clear();
}

function clearOperatorContextCacheForMember(orgId, memberId) {
  if (!orgId || !memberId) {
    return;
  }

  for (const [key, entry] of operatorContextCache.entries()) {
    if (entry?.payload?.orgId === orgId && entry?.payload?.memberId === memberId) {
      operatorContextCache.delete(key);
    }
  }
}

function clearOperatorContextCacheForOrganization(orgId) {
  if (!orgId) {
    return;
  }

  for (const [key, entry] of operatorContextCache.entries()) {
    if (entry?.payload?.orgId === orgId) {
      operatorContextCache.delete(key);
    }
  }
}

async function hydratePlatformOperatorPayload(payload) {
  if (!payload?.organizationCode || !payload?.loginId) {
    return null;
  }

  const cached = getCachedOperatorContext(payload);
  if (cached) {
    return cached;
  }

  const identity = await platformStore.getLoginIdentity(payload.organizationCode, payload.loginId);
  if (!identity || identity.status !== "active") {
    return null;
  }

  if (Number(payload.tokenVersion ?? -1) !== Number(identity.tokenVersion || 0)) {
    return null;
  }

  const [organization, member, entitlement] = await Promise.all([
    platformStore.getOrganization(identity.orgId),
    platformStore.getMember(identity.orgId, identity.memberId),
    platformStore.getProductEntitlement(identity.orgId, CHARTING_PRODUCT_ID)
  ]);

  if (!platformOrganizationAllowsLogin(organization) || !member || member.status !== "active") {
    return null;
  }

  if (!platformEntitlementAllowsChartingUse(entitlement)) {
    return null;
  }

  const normalizedOrganization = normalizePlatformOrganizationForGateway(organization);
  const normalizedMember = normalizePlatformMemberForGateway(member);

  const mfaRequired = Boolean(identity.mfaRequired) || operatorRequiresMfa(normalizedMember);

  const hydrated = {
    ...payload,
    orgId: normalizedOrganization.orgId,
    clinicId: normalizedOrganization.clinicId,
    organizationCode: normalizedOrganization.organizationCode,
    organizationDisplayName: normalizedOrganization.displayName,
    organizationStatus: normalizedOrganization.status,
    organizationBilling: normalizedOrganization.billing || null,
    organizationAccess: getOrganizationAccessState(normalizedOrganization),
    memberId: normalizedMember.memberId,
    sub: normalizedMember.memberId,
    displayName: normalizedMember.displayName,
    roles: normalizedMember.roles,
    defaultRecordingSource: normalizeRecordingSource(normalizedMember.defaultRecordingSource),
    defaultPromptProfileId: normalizedMember.defaultPromptProfileId || null,
    tokenVersion: Number(identity.tokenVersion || 0),
    mfaRequired,
    mfaEnrolledAt: platformMfaEnrolledAt(identity)
  };
  setCachedOperatorContext(payload, hydrated);
  return hydrated;
}

function platformMfaEnrolledAt(identity = {}) {
  if (!identity.mfaEnrolled) {
    return null;
  }

  return identity.mfaEnrolledAt || identity.updatedAt || identity.createdAt || new Date(0).toISOString();
}

function platformEntitlementAllowsChartingUse(entitlement = {}, now = new Date()) {
  const status = entitlement?.status || "";
  if (status === "enabled" || status === "trialing") {
    return true;
  }
  if (status !== "cancel_scheduled") {
    return false;
  }

  const currentPeriodEndMs = entitlement.currentPeriodEnd ? Date.parse(entitlement.currentPeriodEnd) : NaN;
  return Number.isFinite(currentPeriodEndMs) && currentPeriodEndMs > now.getTime();
}

function platformOrganizationAllowsLogin(organization = null) {
  return Boolean(organization && ["active", "trialing"].includes(organization.status || "active"));
}

async function getMfaAuthContext(challenge) {
  if (platformAuthBridgeEnabled) {
    const [organization, member] = await Promise.all([
      platformStore.getOrganization(challenge.orgId),
      platformStore.getMember(challenge.orgId, challenge.memberId)
    ]);
    if (!platformOrganizationAllowsLogin(organization) || !member) {
      return null;
    }
    const identity = await platformStore.getLoginIdentity(organization.organizationCode, member.loginId);
    if (!identity || identity.status !== "active") {
      return null;
    }

    return {
      organization: normalizePlatformOrganizationForGateway(organization),
      member: normalizePlatformMemberForGateway(member),
      identity: {
        ...identity,
        mfaEnrolledAt: platformMfaEnrolledAt(identity),
        mfaSecretEncrypted: null
      }
    };
  }

  return store.getMemberAuthContext({
    orgId: challenge.orgId,
    memberId: challenge.memberId
  });
}

function identityHasMfaSecret(identity = {}) {
  return Boolean(identity.mfaSecretEncrypted || identity.mfaSecret);
}

function verifyIdentityTotpCode(identity = {}, code) {
  if (identity.mfaSecret) {
    return verifyTotpCode(code, identity.mfaSecret);
  }

  if (!identity.mfaSecretEncrypted) {
    return false;
  }

  return verifyTotpCode(code, decryptField(identity.mfaSecretEncrypted));
}

function normalizePlatformOrganizationForGateway(organization) {
  const access = organization.access || {};
  return {
    orgId: organization.orgId,
    clinicId: organization.orgId,
    organizationCode: organization.organizationCode,
    displayName: organization.displayName || organization.organizationCode || "医療機関",
    status: organization.status || "active",
    billing: organization.billing || null,
    defaultPromptProfileId: organization.defaultPromptProfileId || DEFAULT_SOAP_FORMAT_PROFILE.profileId,
    recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(organization.recordingMaxDurationMinutes),
    access: {
      ...access,
      status: access.status || "active"
    },
    createdAt: organization.createdAt || null,
    updatedAt: organization.updatedAt || null
  };
}

function normalizePlatformMemberForGateway(member) {
  return {
    memberId: member.memberId,
    orgId: member.orgId || null,
    clinicId: member.orgId || null,
    displayName: member.displayName || member.loginId || "メンバー",
    loginId: member.loginId || null,
    roles: mapPlatformRolesToGatewayRoles(member),
    facilityIds: member.facilityIds || [],
    departmentIds: member.departmentIds || [],
    status: member.status || "active",
    defaultPromptProfileId: member.defaultPromptProfileId || DEFAULT_SOAP_FORMAT_PROFILE.profileId,
    defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource),
    mfaRequired: Boolean(member.mfaRequired) || operatorRequiresMfa({ roles: mapPlatformRolesToGatewayRoles(member) }),
    mfaEnrolledAt: member.mfaEnrolledAt || (member.mfaEnrolled ? member.updatedAt || member.createdAt || new Date(0).toISOString() : null)
  };
}

async function safePlatformRead(callback) {
  try {
    return await callback();
  } catch {
    return null;
  }
}

async function resolvePlatformSessionDefaults(orgId, memberId) {
  if (!platformAuthBridgeEnabled || !platformStore) {
    return {
      organization: null,
      member: null
    };
  }

  const [organization, member] = await Promise.all([
    safePlatformRead(() => platformStore.getOrganization(orgId)),
    memberId ? safePlatformRead(() => platformStore.getMember(orgId, memberId)) : null
  ]);

  return {
    organization,
    member
  };
}

async function resolveSessionOrganizationForClinicalUse(session = {}) {
  const orgId = session.orgId || session.clinicId;
  if (!orgId) {
    return null;
  }

  if (platformAuthBridgeEnabled && platformStore) {
    const organization = await safePlatformRead(() => platformStore.getOrganization(orgId));
    return organization ? normalizePlatformOrganizationForGateway(organization) : null;
  }

  return store.getOrganization ? store.getOrganization(orgId) : null;
}

function mapPlatformRolesToGatewayRoles(member) {
  const roles = new Set();
  const globalRoles = new Set(member.globalRoles || []);
  const chartingRoles = new Set(member.productRoles?.charting || []);

  if (globalRoles.has("platform_admin")) {
    roles.add("platform_admin");
  }
  if (globalRoles.has("org_owner")) {
    roles.add("org_owner");
  }
  if (globalRoles.has("org_admin") || globalRoles.has("billing_admin")) {
    roles.add("org_admin");
  }
  if (globalRoles.has("it_admin")) {
    roles.add("it_admin");
  }
  if (globalRoles.has("auditor")) {
    roles.add("auditor");
  }
  if (chartingRoles.has("admin")) {
    roles.add("clinical_admin");
  }
  if (chartingRoles.has("viewer")) {
    roles.add("readonly_clinical");
  }
  if (chartingRoles.has("editor") || chartingRoles.has("admin") || roles.size === 0) {
    roles.add("doctor");
  }

  return Array.from(roles);
}

function mapGatewayRolesToPlatformPatch(roles = [], currentMember = {}) {
  const roleSet = new Set(Array.isArray(roles) && roles.length ? roles : ["doctor"]);
  const globalRoles = new Set(currentMember.globalRoles || []);
  const productRoles = {
    ...(currentMember.productRoles || {})
  };
  const chartingRoles = new Set();

  for (const role of ["platform_admin", "org_owner", "org_admin", "billing_admin", "it_admin", "auditor"]) {
    globalRoles.delete(role);
  }
  if (roleSet.has("platform_admin")) globalRoles.add("platform_admin");
  if (roleSet.has("org_owner")) globalRoles.add("org_owner");
  if (roleSet.has("org_admin")) globalRoles.add("org_admin");
  if (roleSet.has("it_admin")) globalRoles.add("it_admin");
  if (roleSet.has("auditor")) globalRoles.add("auditor");

  if (roleSet.has("clinical_admin")) chartingRoles.add("admin");
  if (
    roleSet.has("doctor")
    || roleSet.has("nurse")
    || roleSet.has("medical_scribe")
  ) {
    chartingRoles.add("editor");
  }
  if (
    roleSet.has("readonly_clinical")
    || roleSet.has("billing_staff")
    || roleSet.has("reception")
    || roleSet.has("auditor")
  ) {
    chartingRoles.add("viewer");
  }
  if (chartingRoles.size === 0 && !globalRoles.has("platform_admin") && !globalRoles.has("org_admin") && !globalRoles.has("org_owner")) {
    chartingRoles.add("editor");
  }

  productRoles[CHARTING_PRODUCT_ID] = Array.from(chartingRoles);

  return {
    globalRoles: Array.from(globalRoles),
    productRoles
  };
}

async function getPlatformMemberWithGatewayView(orgId, memberId) {
  const [organization, member] = await Promise.all([
    platformStore.getOrganization(orgId),
    platformStore.getMember(orgId, memberId)
  ]);
  if (!organization || !member) {
    return null;
  }
  let identity = null;
  try {
    identity = await platformStore.getLoginIdentity(organization.organizationCode, member.loginId);
  } catch {
    identity = null;
  }
  return normalizePlatformMemberForGateway({
    ...member,
    mfaRequired: identity?.mfaRequired,
    mfaEnrolled: identity?.mfaEnrolled,
    mfaEnrolledAt: platformMfaEnrolledAt(identity || {})
  });
}

async function listAdminOrganizations() {
  if (!platformAuthBridgeEnabled) {
    return (await store.listOrganizations?.()) || [];
  }

  const organizations = (await platformStore.listOrganizations?.()) || [];
  return organizations.map(normalizePlatformOrganizationForGateway);
}

async function listAdminMembers(orgId) {
  if (!platformAuthBridgeEnabled) {
    return (await store.listMembers?.({ orgId })) || [];
  }

  const members = (await platformStore.listMembers(orgId)) || [];
  return members.map(normalizePlatformMemberForGateway);
}

function normalizeAdminBootstrapSection(value) {
  const section = String(value || "all").trim();
  if (["home", "members", "formats", "audio-test", "audit", "account", "all"].includes(section)) {
    return section;
  }

  if (section === "prompts" || section === "formats-infer" || section === "prompts-infer") {
    return "formats";
  }

  return "all";
}

async function listAdminSoapFormats(req, { summary = false } = {}) {
  const orgId = getAdminTargetOrgId(req);
  const listFormats = summary && typeof store.listSoapFormatProfileSummaries === "function"
    ? store.listSoapFormatProfileSummaries.bind(store)
    : store.listSoapFormatProfiles?.bind(store);
  const storedFormats = ((await listFormats?.({
    orgId,
    memberId: getMemberIdForOperator(req.operator),
    roles: getRolesForOperator(req.operator)
  })) || []).filter((format) => canManageOrganizationSoapFormats(req.operator) || isOwnSoapFormat(req.operator, format));

  return includeSystemDefaultSoapFormat(storedFormats);
}

async function buildAdminBootstrapPayload(req) {
  if (!canOpenSettingsConsole(req.operator)) {
    throw createPublicError("設定を開く権限がありません。", 403);
  }

  const section = normalizeAdminBootstrapSection(req.query.section);
  const currentOrgId = getOrgIdForOperator(req.operator);
  const organizations = await listAdminOrganizations();
  const canManagePlatform = canManagePlatformSettings(req.operator);
  const visibleOrganizations = canManagePlatform
    ? organizations
    : organizations.filter((organization) => (organization.orgId || organization.clinicId) === currentOrgId);
  const requestedOrgId = String(req.query.orgId || "").trim();
  const selectedOrgId = requestedOrgId
    ? getAdminTargetOrgId(req)
    : currentOrgId || visibleOrganizations[0]?.orgId || visibleOrganizations[0]?.clinicId || "";
  const shouldLoadRoles = canOpenAdminConsole(req.operator) && ["all", "members"].includes(section);
  const shouldLoadMembers = (canManageMembers(req.operator) || canManagePlatform) && ["all", "members", "formats", "audit"].includes(section);
  const shouldLoadFormats = canReadSoapFormats(req.operator) && ["all", "members", "formats"].includes(section);
  const shouldLoadAuditEvents = canOpenAdminConsole(req.operator) && ["all", "audit"].includes(section);

  const [roles, formatsRaw, members, events] = await Promise.all([
    shouldLoadRoles ? (store.listRoleDefinitions?.() || []) : [],
    shouldLoadFormats ? listAdminSoapFormats(req, { summary: true }) : [],
    shouldLoadMembers && selectedOrgId ? listAdminMembers(selectedOrgId) : [],
    shouldLoadAuditEvents
      ? (store.listOrganizationAuditEvents?.({
          orgId: currentOrgId,
          limit: 120
        }) || [])
      : []
  ]);

  return {
    session: serializeOperatorPayload(req.operator, null),
    organizations: visibleOrganizations.map(serializeOrganizationForClient),
    selectedOrgId,
    canManagePlatform,
    section,
    roles: roles.map(serializeRoleDefinitionForClient),
    formats: formatsRaw.map(serializeSoapFormatSummaryForClient),
    members: members.map(serializeMemberForClient),
    events
  };
}

async function updateAdminOrganizationRecordingPolicy({ orgId, recordingMaxDurationMinutes, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.updateOrganizationRecordingPolicy?.({
      orgId,
      recordingMaxDurationMinutes,
      actorId
    });
  }

  const organization = await platformStore.updateOrganization(orgId, {
    recordingMaxDurationMinutes
  });
  clearOperatorContextCacheForOrganization(orgId);
  return organization;
}

async function createAdminOrganizationWithMember({ input, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.createOrganizationWithAdminMember?.({
      ...input,
      actorId
    });
  }

  const organization = await platformStore.createOrganization({
    organizationCode: input.organizationCode,
    displayName: input.displayName,
    status: "active",
    access: {
      status: "active",
      enabledProducts: [CHARTING_PRODUCT_ID]
    }
  });
  const member = await platformStore.createMember(organization.orgId, {
    loginId: input.adminLoginId,
    displayName: input.adminDisplayName,
    password: input.adminPassword,
    globalRoles: ["org_admin", "billing_admin"],
    productRoles: {
      [CHARTING_PRODUCT_ID]: ["admin"]
    }
  });
  await platformStore.upsertProductEntitlement(organization.orgId, {
    productId: CHARTING_PRODUCT_ID,
    status: "enabled",
    plan: "manual_admin_created"
  });

  return {
    organization: normalizePlatformOrganizationForGateway(organization),
    member: await getPlatformMemberWithGatewayView(organization.orgId, member.memberId)
  };
}

async function createAdminMember({ orgId, input, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.createMember?.({
      orgId,
      loginId: input.loginId,
      displayName: input.displayName,
      password: input.password,
      roles: input.roles,
      defaultRecordingSource: input.defaultRecordingSource,
      actorId
    });
  }

  const rolePatch = mapGatewayRolesToPlatformPatch(input.roles);
  const created = await platformStore.createMember(orgId, {
    loginId: input.loginId,
    displayName: input.displayName,
    password: input.password,
    defaultRecordingSource: input.defaultRecordingSource,
    ...rolePatch
  });
  return getPlatformMemberWithGatewayView(orgId, created.memberId);
}

async function updateAdminMemberPreferences({ orgId, memberId, defaultRecordingSource, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.updateMemberPreferences?.({
      orgId,
      memberId,
      defaultRecordingSource,
      actorId
    });
  }

  await platformStore.updateMember(orgId, memberId, {
    defaultRecordingSource
  });
  clearOperatorContextCacheForMember(orgId, memberId);
  return getPlatformMemberWithGatewayView(orgId, memberId);
}

async function getAssignableSoapFormat({ orgId, profileId }) {
  const resolvedProfileId = profileId || DEFAULT_SOAP_FORMAT_PROFILE.profileId;
  if (resolvedProfileId === DEFAULT_SOAP_FORMAT_PROFILE.profileId) {
    return DEFAULT_SOAP_FORMAT_PROFILE;
  }

  const profile = await store.getSoapFormatProfile?.({
    orgId,
    profileId: resolvedProfileId
  });

  if (!profile || profile.status !== "active" || profile.approved !== true) {
    return null;
  }

  return profile;
}

async function assignAdminSoapFormatToOrganization({ orgId, profileId, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.assignSoapFormatToOrganization?.({
      orgId,
      profileId,
      actorId
    });
  }

  const profile = await getAssignableSoapFormat({ orgId, profileId });
  if (!profile) {
    return null;
  }

  const defaultPromptProfileId = profile.profileId || profile.formatId || DEFAULT_SOAP_FORMAT_PROFILE.profileId;
  const organization = await platformStore.updateOrganization(orgId, {
    defaultPromptProfileId
  });
  clearOperatorContextCacheForOrganization(orgId);
  await appendOrganizationAuditEventSafe(orgId, {
    type: "soap_format.assigned",
    actorId,
    safePayload: {
      targetType: "organization",
      profileId: defaultPromptProfileId
    }
  });

  return normalizePlatformOrganizationForGateway(organization);
}

async function assignAdminSoapFormatToMember({ orgId, memberId, profileId, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.assignSoapFormatToMember?.({
      orgId,
      memberId,
      profileId,
      actorId
    });
  }

  const [member, profile] = await Promise.all([
    platformStore.getMember(orgId, memberId),
    getAssignableSoapFormat({ orgId, profileId })
  ]);
  if (!member || !profile) {
    return null;
  }

  const defaultPromptProfileId = profile.profileId || profile.formatId || DEFAULT_SOAP_FORMAT_PROFILE.profileId;
  await platformStore.updateMember(orgId, memberId, {
    defaultPromptProfileId
  });
  clearOperatorContextCacheForMember(orgId, memberId);
  await appendOrganizationAuditEventSafe(orgId, {
    type: "soap_format.assigned",
    actorId,
    safePayload: {
      memberId,
      profileId: defaultPromptProfileId
    }
  });

  return getPlatformMemberWithGatewayView(orgId, memberId);
}

async function resetAdminMemberPassword({ orgId, memberId, password, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.resetMemberPassword?.({
      orgId,
      memberId,
      password,
      actorId
    });
  }

  await platformStore.updateMember(orgId, memberId, { password });
  clearOperatorContextCacheForMember(orgId, memberId);
  return getPlatformMemberWithGatewayView(orgId, memberId);
}

async function updateAdminMemberRoles({ orgId, memberId, roles, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.updateMemberRoles?.({
      orgId,
      memberId,
      roles,
      actorId
    });
  }

  const currentMember = await platformStore.getMember(orgId, memberId);
  if (!currentMember) {
    return null;
  }
  await platformStore.updateMember(orgId, memberId, mapGatewayRolesToPlatformPatch(roles, currentMember));
  clearOperatorContextCacheForMember(orgId, memberId);
  return getPlatformMemberWithGatewayView(orgId, memberId);
}

async function updateAdminMemberStatus({ orgId, memberId, status, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.updateMemberStatus?.({
      orgId,
      memberId,
      status,
      actorId
    });
  }

  await platformStore.updateMember(orgId, memberId, { status });
  clearOperatorContextCacheForMember(orgId, memberId);
  return getPlatformMemberWithGatewayView(orgId, memberId);
}

async function revokeAdminMemberSessions({ orgId, memberId, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.revokeMemberSessions?.({
      orgId,
      memberId,
      actorId
    });
  }

  const [organization, member] = await Promise.all([
    platformStore.getOrganization(orgId),
    platformStore.getMember(orgId, memberId)
  ]);
  if (!organization || !member) {
    return null;
  }
  const identity = await platformStore.getLoginIdentity(organization.organizationCode, member.loginId);
  if (!identity) {
    return null;
  }
  const updated = await platformStore.revokeMemberSessions(identity);
  clearOperatorContextCacheForMember(orgId, memberId);
  return {
    memberId,
    tokenVersion: Number(updated.tokenVersion || 0)
  };
}

async function resetAdminMemberMfa({ orgId, memberId, actorId }) {
  if (!platformAuthBridgeEnabled) {
    return store.resetMemberMfa?.({
      orgId,
      memberId,
      actorId
    });
  }

  await platformStore.resetMemberMfa(orgId, memberId);
  clearOperatorContextCacheForMember(orgId, memberId);
  return getPlatformMemberWithGatewayView(orgId, memberId);
}

function buildOperatorSessionToken(authenticated, { amr = ["pwd"] } = {}) {
  return signOperatorAccessToken(
    {
      sub: authenticated.member.memberId,
      memberId: authenticated.member.memberId,
      orgId: authenticated.organization.orgId,
      clinicId: authenticated.organization.clinicId || authenticated.organization.orgId,
      organizationCode: authenticated.identity.organizationCode,
      loginId: authenticated.identity.loginId,
      displayName: authenticated.member.displayName,
      roles: authenticated.member.roles,
      defaultRecordingSource: normalizeRecordingSource(authenticated.member.defaultRecordingSource),
      defaultPromptProfileId: authenticated.member.defaultPromptProfileId || null,
      tokenVersion: Number(authenticated.identity.tokenVersion || 0),
      amr,
      mfaAt: amr.includes("otp") ? Date.now() : null,
      exp: Date.now() + OPERATOR_SESSION_TTL_MS
    },
    config.operatorSessionSigningSecret
  );
}

function issueOperatorSession(res, authenticated, { amr = ["pwd"] } = {}) {
  const token = buildOperatorSessionToken(authenticated, { amr });
  const csrfToken = setOperatorCsrfCookie(res);
  setOperatorSessionCookie(res, token);
  return { token, csrfToken };
}

function buildOperatorSessionTokenFromPayload(payload, memberOverride = null) {
  const member = memberOverride || {};
  const roles = Array.isArray(member.roles) ? member.roles : getRolesForOperator(payload);
  const amr = Array.isArray(payload?.amr) && payload.amr.length ? payload.amr : ["pwd"];

  return signOperatorAccessToken(
    {
      sub: payload.memberId || payload.sub,
      memberId: payload.memberId || payload.sub,
      orgId: payload.orgId,
      clinicId: payload.clinicId || payload.orgId,
      organizationCode: payload.organizationCode || null,
      loginId: payload.loginId || null,
      displayName: member.displayName || payload.displayName || "",
      roles,
      defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource || payload.defaultRecordingSource),
      defaultPromptProfileId: member.defaultPromptProfileId || payload.defaultPromptProfileId || null,
      tokenVersion: Number(payload.tokenVersion || 0),
      amr,
      mfaAt: amr.includes("otp") ? payload.mfaAt || Date.now() : null,
      exp: Date.now() + OPERATOR_SESSION_TTL_MS
    },
    config.operatorSessionSigningSecret
  );
}

function createMfaChallengeId(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", config.operatorSessionSigningSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function mfaChallengeExpiresAt() {
  return Date.now() + MFA_CHALLENGE_TTL_MS;
}

function verifyMfaChallengeId(challengeId, purpose) {
  if (typeof challengeId !== "string" || challengeId.length > 4096) {
    return null;
  }

  const [body, signature, extra] = challengeId.split(".");

  if (!body || !signature || extra) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", config.operatorSessionSigningSecret).update(body).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    if (!parsed || parsed.purpose !== purpose || !parsed.exp || parsed.exp <= Date.now()) {
      return null;
    }

    return parsed;
  } catch (_error) {
    return null;
  }
}

function serializeMfaChallengeResponse(authenticated, challengeId, expiresAt, extra = {}) {
  return {
    challengeId,
    expiresAt: new Date(expiresAt).toISOString(),
    organization: {
      orgId: authenticated.organization.orgId,
      displayName: authenticated.organization.displayName,
      organizationCode: authenticated.identity.organizationCode
    },
    member: {
      memberId: authenticated.member.memberId,
      displayName: authenticated.member.displayName,
      roles: authenticated.member.roles || ["doctor"]
    },
    ...extra
  };
}

function serializeOperatorLoginSuccess(authenticated, issued) {
  const expiresAt = Date.now() + OPERATOR_SESSION_TTL_MS;
  const orgId = authenticated.organization.orgId;
  const memberId = authenticated.member.memberId;
  const roles = authenticated.member.roles || ["doctor"];

  return {
    accessToken: issued.token,
    cookieSession: true,
    csrfToken: issued.csrfToken,
    orgId,
    clinicId: authenticated.organization.clinicId || orgId,
    organization: serializeOrganizationForClient({
      ...authenticated.organization,
      organizationCode: authenticated.identity.organizationCode || authenticated.organization.organizationCode || null
    }),
    member: {
      memberId,
      displayName: authenticated.member.displayName,
      roles,
      defaultRecordingSource: normalizeRecordingSource(authenticated.member.defaultRecordingSource),
      defaultPromptProfileId: authenticated.member.defaultPromptProfileId || null
    },
    expiresAt: new Date(expiresAt).toISOString()
  };
}

async function hydrateOperatorPayload(payload) {
  if (!payload) {
    return null;
  }

  if (platformAuthBridgeEnabled) {
    return hydratePlatformOperatorPayload(payload);
  }

  const context = await store.getMemberAuthContext({
    orgId: getOrgIdForOperator(payload),
    memberId: getMemberIdForOperator(payload)
  });

  if (!context || context.organization.status !== "active" || context.member.status !== "active" || context.identity.status !== "active") {
    return null;
  }

  if (Number(payload.tokenVersion ?? -1) !== Number(context.identity.tokenVersion || 0)) {
    return null;
  }

  const hydrated = {
    ...payload,
    orgId: context.organization.orgId,
    clinicId: context.organization.clinicId || context.organization.orgId,
    organizationCode: context.organization.organizationCode,
    organizationDisplayName: context.organization.displayName || context.organization.organizationCode || "医療機関",
    organizationStatus: context.organization.status || "active",
    organizationBilling: context.organization.billing || null,
    organizationAccess: getOrganizationAccessState(context.organization),
    memberId: context.member.memberId,
    sub: context.member.memberId,
    displayName: context.member.displayName,
    roles: context.member.roles,
    defaultRecordingSource: normalizeRecordingSource(context.member.defaultRecordingSource),
    tokenVersion: Number(context.identity.tokenVersion || 0),
    mfaRequired: Boolean(context.identity.mfaRequired) || operatorRequiresMfa(context.member),
    mfaEnrolledAt: context.identity.mfaEnrolledAt || null
  };

  if (hydrated.mfaRequired && hydrated.mfaEnrolledAt && !operatorPayloadHasMfa(hydrated)) {
    return null;
  }

  return hydrated;
}

function serializeOperatorPayload(payload, memberOverride = null) {
  const member = memberOverride || {};
  return {
    orgId: payload.orgId,
    clinicId: payload.clinicId || payload.orgId,
    organization: serializeOrganizationForClient({
      orgId: payload.orgId,
      clinicId: payload.clinicId || payload.orgId,
      organizationCode: payload.organizationCode || null,
      displayName: payload.organizationDisplayName || payload.organizationCode || "医療機関",
      status: payload.organizationStatus || "active",
      billing: payload.organizationBilling || null,
      access: payload.organizationAccess || null
    }),
    member: {
      memberId: payload.memberId || payload.sub,
      displayName: member.displayName || payload.displayName || "",
      roles: Array.isArray(member.roles) ? member.roles : getRolesForOperator(payload),
      defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource || payload.defaultRecordingSource),
      defaultPromptProfileId: member.defaultPromptProfileId || payload.defaultPromptProfileId || null,
      mfaRequired: Boolean(payload.mfaRequired),
      mfaEnrolledAt: payload.mfaEnrolledAt || member.mfaEnrolledAt || null
    },
    expiresAt: payload.exp ? new Date(payload.exp).toISOString() : null
  };
}

async function requireOperatorAuth(req, res, next) {
  try {
    const payload = await hydrateOperatorPayload(resolveOperatorPayload(req));

    if (!payload) {
      clearOperatorSessionCookie(res);
      clearOperatorCsrfCookie(res);
      res.status(401).json({
        error: "ログインの有効期限が切れました。もう一度ログインしてください。"
      });
      return;
    }

    if (!operatorCanAuthenticateForAccess(payload)) {
      clearOperatorSessionCookie(res);
      clearOperatorCsrfCookie(res);
      res.status(403).json({
        error: operatorAccessDeniedMessage(payload, "login")
      });
      return;
    }

    req.operator = payload;
    next();
  } catch (error) {
    next(error);
  }
}

function requireOperatorReadAccess(req, res, next) {
  if (!operatorCanReadWithAccess(req.operator)) {
    res.status(403).json({
      error: operatorAccessDeniedMessage(req.operator, "read")
    });
    return;
  }

  next();
}

function requireOperatorClinicalAccess(req, res, next) {
  if (!operatorCanUseClinicalFeatures(req.operator)) {
    res.status(403).json({
      error: operatorAccessDeniedMessage(req.operator, "clinical")
    });
    return;
  }

  next();
}

function requireMobileStreamAuth(req, res, next) {
  const token = extractBearerToken(req);
  const payload = token ? verifyStreamToken(token, config.pairingSigningSecret) : null;

  if (!payload || payload.sessionId !== req.params.sessionId) {
    res.status(401).json({
      error: "スマホの接続情報が無効です。パソコンから接続し直してください。"
    });
    return;
  }

  req.mobile = payload;
  next();
}

function getSocketBucket(sessionId) {
  if (!socketIndex.has(sessionId)) {
    socketIndex.set(sessionId, {
      pc: new Set(),
      mobile: new Set(),
      recorder: new Set()
    });
  }

  return socketIndex.get(sessionId);
}

function sendJson(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function hasOpenMobileSocket(sessionId) {
  const bucket = getSocketBucket(sessionId);
  return Array.from(bucket.mobile || []).some((ws) => ws?.readyState === 1);
}

function trackAudioBytes(ws, byteLength) {
  const now = Date.now();
  const current = ws.meta.audioRateWindow || {
    startedAt: now,
    bytes: 0
  };

  if (now - current.startedAt >= 60_000) {
    current.startedAt = now;
    current.bytes = 0;
  }

  current.bytes += byteLength;
  ws.meta.audioRateWindow = current;

  return current.bytes <= WS_AUDIO_BYTES_PER_MINUTE_LIMIT;
}

function broadcast(sessionId, payload, roles = ["pc"]) {
  const bucket = socketIndex.get(sessionId);

  if (!bucket) {
    return;
  }

  for (const role of roles) {
    for (const ws of bucket[role] || []) {
      sendJson(ws, payload);
    }
  }
}

function isAudioRole(role) {
  return role === "mobile" || role === "recorder";
}

function audioSourceTypeForRole(role) {
  return role === "recorder" ? "local_browser" : "linked_mobile";
}

function maybeBroadcastAudioActivity(ws, receivedAtMs) {
  if (!ws.meta || !isAudioRole(ws.meta.role)) {
    return;
  }

  const lastBroadcastAt = ws.meta.lastAudioActivityBroadcastAt || 0;
  if (receivedAtMs - lastBroadcastAt < WS_AUDIO_ACTIVITY_BROADCAST_INTERVAL_MS) {
    return;
  }

  ws.meta.lastAudioActivityBroadcastAt = receivedAtMs;
  broadcast(
    ws.meta.sessionId,
    {
      type: "audio.activity",
      sessionId: ws.meta.sessionId,
      audioSourceType: audioSourceTypeForRole(ws.meta.role),
      receivedAt: new Date(receivedAtMs).toISOString()
    },
    ["pc"]
  );
}

function getPublicWsUrl(req) {
  if (config.publicWsUrl) {
    const url = new URL(config.publicWsUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto === "https" ? "wss" : "ws";
  return `${protocol}://${req.get("host")}/ws`;
}

function getPublicHttpBaseUrl(req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto === "https" ? "https" : "http";
  return `${protocol}://${forwardedHost}`;
}

function getRecordingAutoStopEndpoint(req) {
  if (config.recordingAutoStopEndpoint) {
    return config.recordingAutoStopEndpoint;
  }

  return `${getPublicHttpBaseUrl(req)}/internal/recording/auto-stop`;
}

async function getMetadataAccessToken() {
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: {
      "Metadata-Flavor": "Google"
    }
  });

  if (!response.ok) {
    const error = new Error(`Metadata token request failed with status ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  const payload = await response.json();
  return payload.access_token;
}

function getFinalizeQueuePath() {
  if (config.finalizeTasksQueue.startsWith("projects/")) {
    return config.finalizeTasksQueue;
  }

  return `projects/${config.finalizeTasksProjectId}/locations/${config.finalizeTasksLocation}/queues/${config.finalizeTasksQueue}`;
}

async function enqueueFinalizeTask(payload) {
  const queuePath = getFinalizeQueuePath();
  const accessToken = await getMetadataAccessToken();
  const endpointUrl = new URL(config.finalizeEndpoint);
  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: config.finalizeEndpoint,
      headers: {
        "Content-Type": "application/json",
        "X-Finalize-Internal-Secret": config.finalizeInternalSecret
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64")
    }
  };

  if (config.finalizeTasksServiceAccountEmail) {
    task.httpRequest.oidcToken = {
      serviceAccountEmail: config.finalizeTasksServiceAccountEmail,
      audience: `${endpointUrl.protocol}//${endpointUrl.host}`
    };
  }

  const response = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ task })
  });

  if (!response.ok) {
    const error = new Error(`Cloud Tasks enqueue failed with status ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  return response.json();
}

async function enqueueRecordingAutoStopTask({ payload, endpoint, scheduleTime }) {
  if (!config.finalizeTasksQueue) {
    return null;
  }

  const queuePath = getFinalizeQueuePath();
  const accessToken = await getMetadataAccessToken();
  const endpointUrl = new URL(endpoint);
  const task = {
    scheduleTime,
    httpRequest: {
      httpMethod: "POST",
      url: endpoint,
      headers: {
        "Content-Type": "application/json",
        "X-Finalize-Internal-Secret": config.finalizeInternalSecret
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64")
    }
  };

  if (config.finalizeTasksServiceAccountEmail) {
    task.httpRequest.oidcToken = {
      serviceAccountEmail: config.finalizeTasksServiceAccountEmail,
      audience: `${endpointUrl.protocol}//${endpointUrl.host}`
    };
  }

  const response = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ task })
  });

  if (!response.ok) {
    const error = new Error(`Recording auto-stop task enqueue failed with status ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  return response.json();
}

function publicErrorMessage(error, fallback = "内部エラーが発生しました。時間を置いてもう一度お試しください。") {
  return error?.publicMessage || error?.safeMessage || fallback;
}

function createPublicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function sendError(res, error, fallbackStatus = 400) {
  const statusCode = error?.statusCode || fallbackStatus;
  res.status(statusCode).json({
    error: publicErrorMessage(error)
  });
}

function startFinalTranscriptPrecompute(sessionId, { rawAudio = null } = {}) {
  if (config.finalizeMode !== "inline") {
    return null;
  }

  const existing = pendingFinalTranscriptJobs.get(sessionId);
  if (existing && ["running", "ready"].includes(existing.status)) {
    return existing;
  }

  const startedAtMs = Date.now();
  const job = {
    status: "running",
    startedAt: nowIso(),
    result: null,
    error: null,
    promise: null
  };

  pendingFinalTranscriptJobs.set(sessionId, job);

  void appendAuditEventSafe(sessionId, {
    type: "final_transcript.precompute.started",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      hadRawAudio: Boolean(rawAudio?.pcmBuffer?.length),
      rawAudioByteLength: getRawAudioByteLength(rawAudio),
      rawAudioDurationMs: getRawAudioDurationMs(rawAudio)
    }
  });

  job.promise = prepareFinalTranscript({
    store,
    sessionId,
    rawAudio
  })
    .then(async (result) => {
      job.status = "ready";
      job.result = result;

      await appendAuditEventSafe(sessionId, {
        type: "final_transcript.precompute.completed",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          durationMs: Date.now() - startedAtMs,
          transcriptSource: result?.source || "none",
          transcriptTextLength: result?.textLength || 0,
          transcriptTextSha256: result?.textSha256 || null,
          finalRepassAttempted: Boolean(result?.finalRepassAttempted),
          finalRepassSucceeded: Boolean(result?.finalRepassSucceeded),
          hadRawAudio: Boolean(result?.hadRawAudio),
          rawAudioByteLength: result?.rawAudioByteLength || 0,
          rawAudioDurationMs: result?.rawAudioDurationMs || null
        }
      });

      return result;
    })
    .catch(async (error) => {
      job.status = "failed";
      job.error = error;

      console.warn("final transcript precompute failed", safeErrorLogFields(error, {
        sessionId,
        reason: "internal_error"
      }));

      await appendAuditEventSafe(sessionId, {
        type: "final_transcript.precompute.failed",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          durationMs: Date.now() - startedAtMs,
          reason: "internal_error"
        }
      });

      return null;
    });

  return job;
}

async function resolveFinalTranscriptPrecompute(sessionId, job) {
  if (!job) {
    return null;
  }

  if (job.status === "ready") {
    return job.result;
  }

  if (job.status === "failed") {
    return null;
  }

  const result = await job.promise;
  if (!result) {
    console.warn("final transcript precompute unavailable", safeErrorLogFields(job.error, {
      sessionId,
      status: job.status,
      reason: "precompute_unavailable"
    }));
  }

  return result;
}

function buildLegacySoapOutputText(soap = {}) {
  return [
    soap.subjective ? `S\n${soap.subjective}` : "",
    soap.objective ? `O\n${soap.objective}` : "",
    soap.assessment ? `A\n${soap.assessment}` : "",
    soap.plan ? `P\n${soap.plan}` : ""
  ].filter(Boolean).join("\n\n").trim();
}

function getTranscriptForSoapRegeneration(state = {}) {
  const structuredJson = state.latestSoap?.structuredJson || {};
  const turnsTranscript = (state.turns || [])
    .map((turn) => String(turn.text || "").trim())
    .filter(Boolean)
    .join("\n");
  const savedTurnCount = Number(
    structuredJson.finalTranscriptPreparation?.finalTranscriptTurnCount ||
    structuredJson.finalTranscriptTurnCount ||
    0
  ) || 0;
  const soapUpdatedAtMs = Date.parse(state.latestSoap?.updatedAt || state.latestSoap?.createdAt || "");
  const sessionStoppedAtMs = Date.parse(state.session?.stoppedAt || "");
  const hasNewRecordingAfterSoap =
    Boolean(turnsTranscript) &&
    (
      (savedTurnCount > 0 && (state.turns || []).length > savedTurnCount) ||
      (Number.isFinite(sessionStoppedAtMs) && Number.isFinite(soapUpdatedAtMs) && sessionStoppedAtMs > soapUpdatedAtMs)
    );

  if (hasNewRecordingAfterSoap) {
    return {
      text: turnsTranscript,
      source: "live_turns_appended"
    };
  }

  const savedTranscript = [
    structuredJson.finalTranscript,
    structuredJson.rawFinalTranscript
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);

  if (savedTranscript) {
    return {
      text: savedTranscript,
      source: "saved_final_transcript"
    };
  }

  return turnsTranscript
    ? {
        text: turnsTranscript,
        source: "live_turns"
      }
    : null;
}

function serializeSoapForClient(soap) {
  if (!soap) {
    return null;
  }

  return {
    versionId: soap.versionId,
    version: soap.version,
    status: soap.status,
    outputText: soap.outputText || soap.output_text || soap.structuredJson?.outputText || buildLegacySoapOutputText(soap),
    structuredJson: soap.structuredJson || {},
    model: soap.model,
    promptVersion: soap.promptVersion,
    templateKey: soap.templateKey || null,
    promptProfileId: soap.promptProfileId || null,
    promptProfileVersionId: soap.promptProfileVersionId || null,
    resolvedPromptHash: soap.resolvedPromptHash || null,
    createdAt: soap.createdAt,
    updatedAt: soap.updatedAt
  };
}

function serializeSoapFormatForClient(format) {
  if (!format) {
    return null;
  }

  return {
    profileId: format.profileId || format.formatId,
    formatId: format.formatId || format.profileId,
    displayName: format.displayName || "SOAPフォーマット",
    scope: format.scope || "organization",
    ownerMemberId: format.ownerMemberId || null,
    facilityId: format.facilityId || null,
    departmentId: format.departmentId || null,
    status: format.status || "draft",
    approved: format.approved === true,
    currentVersionId: format.currentVersionId || null,
    currentDraftVersionId: format.currentDraftVersionId || null,
    templateKey: format.templateKey || "outpatient_soap_note",
    outputTemplate: format.outputTemplate || "",
    customization: format.customization || {},
    sections: format.sections || [],
    latestVersion: format.latestVersion || null,
    createdAt: format.createdAt || null,
    updatedAt: format.updatedAt || null
  };
}

function serializeSoapFormatSummaryForClient(format) {
  if (!format) {
    return null;
  }

  return {
    profileId: format.profileId || format.formatId,
    formatId: format.formatId || format.profileId,
    displayName: format.displayName || "SOAPフォーマット",
    scope: format.scope || "organization",
    ownerMemberId: format.ownerMemberId || null,
    facilityId: format.facilityId || null,
    departmentId: format.departmentId || null,
    status: format.status || "draft",
    approved: format.approved === true,
    currentVersionId: format.currentVersionId || null,
    currentDraftVersionId: format.currentDraftVersionId || null,
    templateKey: format.templateKey || "outpatient_soap_note",
    latestVersion: format.latestVersion || null,
    createdAt: format.createdAt || null,
    updatedAt: format.updatedAt || null
  };
}

function soapFormatId(format) {
  return format?.formatId || format?.profileId || null;
}

function includeSystemDefaultSoapFormat(formats = []) {
  const formatsById = new Map();
  for (const format of formats) {
    const id = soapFormatId(format);
    if (id) {
      formatsById.set(id, format);
    }
  }
  if (!formatsById.has(DEFAULT_SOAP_FORMAT_PROFILE.profileId)) {
    formatsById.set(DEFAULT_SOAP_FORMAT_PROFILE.profileId, DEFAULT_SOAP_FORMAT_PROFILE);
  }

  return Array.from(formatsById.values()).sort((left, right) => {
    const leftId = soapFormatId(left);
    const rightId = soapFormatId(right);
    if (leftId === DEFAULT_SOAP_FORMAT_PROFILE.profileId) return -1;
    if (rightId === DEFAULT_SOAP_FORMAT_PROFILE.profileId) return 1;
    return String(left.displayName || "").localeCompare(String(right.displayName || ""), "ja");
  });
}

function normalizePreviewSoapFormatInput(operatorPayload, input = {}) {
  const memberId = getMemberIdForOperator(operatorPayload);

  if (canManageOrganizationSoapFormats(operatorPayload)) {
    return {
      ...input,
      ownerMemberId: input.scope === "member" ? input.ownerMemberId || memberId : input.ownerMemberId || null
    };
  }

  return {
    ...input,
    scope: "member",
    ownerMemberId: memberId
  };
}

function buildPreviewPromptProfile(formatInput = {}, {
  profileId = "preview",
  profileVersionId = null,
  promptVersion = null,
  source = "preview"
} = {}) {
  const resolvedProfileId = String(formatInput.profileId || formatInput.formatId || profileId || "preview");

  return {
    profileId: resolvedProfileId,
    profileVersionId,
    promptVersion: promptVersion || `${resolvedProfileId}-preview`,
    templateKey: formatInput.templateKey || "outpatient_soap_note",
    displayName: formatInput.displayName || "プレビュー",
    outputTemplate: formatInput.outputTemplate || "",
    customization: formatInput.customization || {},
    sections: formatInput.sections || [],
    scope: formatInput.scope || "member",
    ownerMemberId: formatInput.ownerMemberId || null,
    facilityId: formatInput.facilityId || null,
    departmentId: formatInput.departmentId || null,
    source
  };
}

async function generateSoapFormatPreview({
  input,
  orgId,
  promptProfile,
  onOutputTextSnapshot = null
}) {
  const sessionContext = {
    ...input.sessionContext,
    orgId
  };
  let soap;
  let provider = "openai";

  if (process.env.OPENAI_API_KEY) {
    soap = await generateSoapDraftWithOpenAi({
      apiKey: process.env.OPENAI_API_KEY,
      transcript: input.transcript,
      sessionContext,
      promptProfile,
      model: process.env.OPENAI_SOAP_MODEL || "gpt-5.4-nano",
      reasoningEffort: process.env.OPENAI_SOAP_REASONING_EFFORT || "low",
      onOutputTextSnapshot
    });
  } else {
    provider = "local_preview";
    const mock = buildMockSoapDraft({
      session: sessionContext,
      turns: [],
      transcriptOverride: input.transcript
    });
    soap = {
      ...mock,
      clinician_review_flags: ["OPENAI_API_KEY未設定のためローカルプレビューです。"]
    };
    if (typeof onOutputTextSnapshot === "function") {
      await onOutputTextSnapshot(soap.outputText || soap.output_text || "");
    }
  }

  return {
    provider,
    sessionContext,
    soap
  };
}

function writeJsonEventStreamChunk(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function serializePromptProfileForSession(promptProfile) {
  if (!promptProfile) {
    return null;
  }

  return {
    profileId: promptProfile.profileId,
    formatId: promptProfile.profileId,
    displayName: promptProfile.displayName || "SOAPフォーマット",
    scope: promptProfile.scope || "organization",
    ownerMemberId: promptProfile.ownerMemberId || null,
    templateKey: promptProfile.templateKey || "outpatient_soap_note",
    promptVersion: promptProfile.promptVersion || null,
    profileVersionId: promptProfile.profileVersionId || null,
    outputTemplate: promptProfile.outputTemplate || null
  };
}

function isPublishedPromptOption(format) {
  const formatId = format?.formatId || format?.profileId;
  return Boolean(formatId && format.status === "active" && format.approved === true);
}

function serializePromptOptionForSession(format) {
  const serialized = serializeSoapFormatForClient(format);
  const latestVersion = serialized?.latestVersion
    ? {
        profileVersionId: serialized.latestVersion.profileVersionId || serialized.latestVersion.versionId || null,
        version: serialized.latestVersion.version || null,
        promptVersion: serialized.latestVersion.promptVersion || null,
        updatedAt: serialized.latestVersion.updatedAt || null
      }
    : null;

  return serialized
    ? {
        profileId: serialized.profileId,
        formatId: serialized.formatId,
        displayName: serialized.displayName,
        scope: serialized.scope,
        ownerMemberId: serialized.ownerMemberId,
        status: serialized.status,
        approved: serialized.approved,
        latestVersion,
        updatedAt: serialized.updatedAt
      }
    : null;
}

async function listSelectablePromptOptions(operatorPayload) {
  const formats = (await store.listSoapFormatProfiles?.({
    orgId: getOrgIdForOperator(operatorPayload),
    memberId: getMemberIdForOperator(operatorPayload),
    roles: getRolesForOperator(operatorPayload)
  })) || [];
  const optionsById = new Map();

  for (const format of formats) {
    if (isPublishedPromptOption(format)) {
      optionsById.set(format.formatId || format.profileId, serializePromptOptionForSession(format));
    }
  }

  if (!optionsById.has(DEFAULT_SOAP_FORMAT_PROFILE.profileId)) {
    optionsById.set(DEFAULT_SOAP_FORMAT_PROFILE.profileId, serializePromptOptionForSession(DEFAULT_SOAP_FORMAT_PROFILE));
  }

  return Array.from(optionsById.values()).sort((left, right) => {
    if (left.formatId === DEFAULT_SOAP_FORMAT_PROFILE.profileId) return -1;
    if (right.formatId === DEFAULT_SOAP_FORMAT_PROFILE.profileId) return 1;
    return String(left.displayName || "").localeCompare(String(right.displayName || ""), "ja");
  });
}

async function findSelectablePromptOption(operatorPayload, promptProfileId) {
  const options = await listSelectablePromptOptions(operatorPayload);
  return options.find((option) => option.formatId === promptProfileId || option.profileId === promptProfileId) || null;
}

function serializeMemberForClient(member) {
  return {
    memberId: member.memberId || member.userId,
    orgId: member.orgId || member.clinicId || null,
    displayName: member.displayName || member.loginId || "メンバー",
    loginId: member.loginId || null,
    roles: Array.isArray(member.roles) ? member.roles : [],
    facilityIds: member.facilityIds || [],
    departmentIds: member.departmentIds || [],
    defaultPromptProfileId: member.defaultPromptProfileId || null,
    defaultRecordingSource: normalizeRecordingSource(member.defaultRecordingSource),
    status: member.status || "active",
    mfaRequired: Boolean(member.mfaRequired) || operatorRequiresMfa(member),
    mfaEnrolledAt: member.mfaEnrolledAt || null
  };
}

function serializeTrustedRecorderForClient(recorder) {
  return {
    recorderId: recorder.recorderId || null,
    orgId: recorder.orgId || recorder.clinicId || null,
    clinicId: recorder.clinicId || recorder.orgId || null,
    deviceId: recorder.deviceId,
    label: recorder.label || "trusted-recorder",
    status: recorder.status || "active",
    registeredByMemberId: recorder.registeredByMemberId || null,
    lastSeenAt: recorder.lastSeenAt ? new Date(Number(recorder.lastSeenAt)).toISOString() : null,
    createdAt: recorder.createdAt || null,
    updatedAt: recorder.updatedAt || null,
    revokedAt: recorder.revokedAt || null,
    revokedByMemberId: recorder.revokedByMemberId || null
  };
}

function serializeRoleDefinitionForClient(role) {
  return {
    roleId: role.roleId,
    label: role.label || role.roleId,
    description: role.description || "",
    category: role.category || "custom",
    sortOrder: Number(role.sortOrder || 0),
    assignableBy: Array.isArray(role.assignableBy) ? role.assignableBy : [],
    permissions: Array.isArray(role.permissions) ? role.permissions : []
  };
}

function serializeAudioTestForClient(audioTest) {
  if (!audioTest) {
    return null;
  }

  return {
    testId: audioTest.testId,
    orgId: audioTest.orgId || null,
    createdByMemberId: audioTest.createdByMemberId || null,
    status: audioTest.status || "active",
    deviceId: audioTest.deviceId || null,
    deviceLabel: audioTest.deviceLabel || null,
    permissionState: audioTest.permissionState || "unknown",
    deviceState: audioTest.deviceState || "waiting",
    level: Number(audioTest.level || 0),
    inputLabel: audioTest.inputLabel || null,
    sampleRate: audioTest.sampleRate || null,
    claimedAt: audioTest.claimedAt || null,
    lastSeenAt: audioTest.lastSeenAt || null,
    expiresAt: audioTest.expiresAt || null,
    createdAt: audioTest.createdAt || null,
    updatedAt: audioTest.updatedAt || null
  };
}

function serializeOrganizationForClient(organization) {
  const access = getOrganizationAccessState(organization);

  return {
    orgId: organization.orgId || organization.clinicId,
    clinicId: organization.clinicId || organization.orgId,
    organizationCode: organization.organizationCode || null,
    displayName: organization.displayName || organization.organizationCode || "医療機関",
    status: organization.status || "active",
    timezone: organization.timezone || "Asia/Tokyo",
    defaultPromptProfileId: organization.defaultPromptProfileId || null,
    recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(organization.recordingMaxDurationMinutes),
    billing: organization.billing || null,
    access: organization.access || access || null,
    createdAt: organization.createdAt || null,
    updatedAt: organization.updatedAt || null
  };
}

function serializeSessionSummary(session) {
  return {
    sessionId: session.sessionId,
    orgId: session.orgId || session.clinicId,
    clinicId: session.clinicId || session.orgId,
    facilityId: session.facilityId || null,
    departmentId: session.departmentId || null,
    createdByMemberId: session.createdByMemberId || session.createdByUserId,
    doctorMemberId: session.doctorMemberId || session.assignedDoctorUserId || null,
    status: session.status,
    title: session.title,
    patientId: session.patientId || null,
    patientDisplayName: session.patientDisplayName,
    visitReason: session.visitReason,
    promptProfileId: session.promptProfileId || null,
    promptProfileSelectedAt: session.promptProfileSelectedAt || null,
    promptProfileSelectedByMemberId: session.promptProfileSelectedByMemberId || null,
    promptProfileSelectionSource: session.promptProfileSelectionSource || "default",
    latestSoapVersionId: session.latestSoapVersionId || null,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(session.recordingMaxDurationMinutes),
    recordingExpiresAt: session.recordingExpiresAt || null,
    recordingAutoStopTaskName: session.recordingAutoStopTaskName || null,
    recordingStopReason: session.recordingStopReason || null,
    finalizedAt: session.finalizedAt,
    approvedAt: session.approvedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function resolveCoreSessionMetadata(orgId, input = {}, currentSession = {}) {
  const hasPatientId = Object.prototype.hasOwnProperty.call(input, "patientId");
  const hasFacilityId = Object.prototype.hasOwnProperty.call(input, "facilityId");
  const hasDepartmentId = Object.prototype.hasOwnProperty.call(input, "departmentId");
  const patientId = hasPatientId ? input.patientId || null : currentSession.patientId || null;
  const facilityId = hasFacilityId ? input.facilityId || null : currentSession.facilityId || null;
  const departmentId = hasDepartmentId ? input.departmentId || null : currentSession.departmentId || null;
  const visitReason = Object.prototype.hasOwnProperty.call(input, "visitReason")
    ? (input.visitReason || "").trim() || null
    : currentSession.visitReason || null;
  let patient = null;

  if (!platformStore) {
    const patientDisplayName = Object.prototype.hasOwnProperty.call(input, "patientDisplayName")
      ? (input.patientDisplayName || "").trim() || null
      : currentSession.patientDisplayName || null;
    return {
      patientId,
      facilityId,
      departmentId,
      patientDisplayName,
      visitReason,
      patientSnapshot: patientDisplayName || visitReason
        ? {
            displayName: patientDisplayName,
            visitReason
          }
        : null
    };
  }

  if (patientId) {
    patient = await platformStore.getPatient(orgId, patientId);
    if (!patient) {
      throw createPublicError("Core患者が見つかりません。", 404);
    }
  }

  if (facilityId) {
    const facility = await platformStore.getFacility(orgId, facilityId);
    if (!facility) {
      throw createPublicError("Core施設が見つかりません。", 404);
    }
  }

  if (departmentId) {
    const department = await platformStore.getDepartment(orgId, departmentId);
    if (!department) {
      throw createPublicError("Core診療科が見つかりません。", 404);
    }
    if (department.facilityId && facilityId && department.facilityId !== facilityId) {
      throw createPublicError("診療科が選択した施設に紐づいていません。", 400);
    }
  }

  const patientDisplayName = patient
    ? patient.displayName
    : Object.prototype.hasOwnProperty.call(input, "patientDisplayName")
      ? (input.patientDisplayName || "").trim() || null
      : currentSession.patientDisplayName || null;
  const snapshot = patient
    ? {
        ...buildPlatformPatientSnapshot(patient),
        visitReason
      }
    : patientDisplayName || visitReason
      ? {
          displayName: patientDisplayName,
          visitReason
        }
      : null;

  return {
    patientId: patient?.patientId || null,
    facilityId,
    departmentId,
    patientDisplayName,
    visitReason,
    patientSnapshot: snapshot
  };
}

const SESSION_LIST_STATUS_FILTERS = Object.freeze({
  all: [],
  active: ["ready", "paired", "recording", "degraded_recording", "stopped", "finalizing"],
  review: ["soap_ready"],
  approved: ["approved"],
  failed: ["failed", "degraded_recording"]
});

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeSessionListSearch(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function resolveSessionListStatuses(value) {
  if (!value) {
    return SESSION_LIST_STATUS_FILTERS.all;
  }

  const key = String(value).trim();
  return Object.prototype.hasOwnProperty.call(SESSION_LIST_STATUS_FILTERS, key)
    ? SESSION_LIST_STATUS_FILTERS[key]
    : null;
}

function clearRecordingAutoStopTimer(sessionId) {
  const timer = recordingAutoStopTimers.get(sessionId);

  if (timer) {
    clearTimeout(timer);
    recordingAutoStopTimers.delete(sessionId);
  }
}

function scheduleRecordingAutoStopFallback(sessionId, recordingExpiresAt) {
  clearRecordingAutoStopTimer(sessionId);

  const expiresAtMs = Date.parse(recordingExpiresAt || "");

  if (!Number.isFinite(expiresAtMs)) {
    return;
  }

  const delayMs = Math.max(0, Math.min(expiresAtMs - Date.now(), 2_147_483_647));
  const timer = setTimeout(() => {
    recordingAutoStopTimers.delete(sessionId);
    void autoStopRecordingSession(sessionId, {
      expectedRecordingExpiresAt: recordingExpiresAt,
      trigger: "local_timer"
    });
  }, delayMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  recordingAutoStopTimers.set(sessionId, timer);
}

function isRecordingPastExpiry(session, toleranceMs = 0) {
  const expiresAtMs = Date.parse(session?.recordingExpiresAt || "");
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + toleranceMs;
}

async function resolveRecordingMaxDurationMinutesForSession(session) {
  const orgId = session?.orgId || session?.clinicId;
  const organization = orgId && store.getOrganization ? await store.getOrganization(orgId) : null;
  return normalizeRecordingMaxDurationMinutes(organization?.recordingMaxDurationMinutes);
}

async function startRecordingSession(sessionId, {
  deviceId,
  deviceLabel = null,
  source = "linked_mobile",
  assumeMicReady = false,
  request = null
}) {
  const stateBeforeStart = await store.getSessionState(sessionId);

  if (!stateBeforeStart) {
    throw createPublicError("診療画面が見つかりません。", 404);
  }

  if (!["ready", "paired", "degraded_recording", "stopped", "soap_ready", "approved"].includes(stateBeforeStart.session.status)) {
    throw createPublicError("このセッションは録音開始できる状態ではありません。", 409);
  }

  if (stateBeforeStart.session.audioSourceType && stateBeforeStart.session.audioSourceType !== source) {
    throw createPublicError(
      stateBeforeStart.session.audioSourceType === "local_browser"
        ? "この診療はPC録音に設定されています。iPhone録音に切り替える場合は録音をやり直してください。"
        : "この診療はiPhone録音に設定されています。PC録音に切り替える場合は録音をやり直してください。",
      409
    );
  }

  if (
    !assumeMicReady &&
    source === "linked_mobile" &&
    stateBeforeStart.session.mobileConnectionState !== "mic_ready"
  ) {
    throw createPublicError("スマホでマイクを有効化してから録音を開始してください。", 409);
  }

  deletePendingFinalizeAudio(sessionId, "recording_restarted");
  pendingFinalTranscriptJobs.delete(sessionId);
  resetFinalTranscriptSegmenter(sessionId, "recording_restarted");

  const preparedAudioState = assumeMicReady
    ? {
        audioSourceType: source,
        audioConnectionState: "mic_ready",
        audioDeviceId: deviceId,
        audioDeviceLabel: deviceLabel || (source === "local_browser" ? "この端末のマイク" : "録音用スマホ"),
        ...(source === "linked_mobile" ? { mobileConnectionState: "mic_ready" } : {})
      }
    : null;

  if (preparedAudioState) {
    await store.updateSession(sessionId, {
      ...preparedAudioState
    });
  }

  await liveStt.reset(sessionId, { preserveMetadata: true });
  await store.updateSession(sessionId, {
    errorCode: null,
    errorMessageSafe: null,
    latestPartialPreview: null,
    liveSttProvider: null,
    finalTranscriptPrecomputeStatus: null,
    finalTranscriptPrecomputeText: null,
    finalTranscriptPrecomputeTextLength: null,
    finalTranscriptPrecomputeTextSha256: null,
    finalTranscriptPrecomputeSegmentCount: null,
    finalTranscriptPrecomputeFailedSegmentCount: null,
    finalTranscriptPrecomputeRawAudioByteLength: null,
    finalTranscriptPrecomputeAudioDurationMs: null,
    finalTranscriptPrecomputeProviderDurationMs: null,
    finalTranscriptPrecomputeStartedAt: null,
    finalTranscriptPrecomputeCompletedAt: null,
    finalTranscriptPrecomputeDurationMs: null
  });
  await liveStt.setSessionContext(sessionId, {
    ...(stateBeforeStart.session || {}),
    ...(preparedAudioState || {})
  });
  createFinalTranscriptSegmenter(sessionId, {
    sessionContext: {
      ...(stateBeforeStart.session || {}),
      ...(preparedAudioState || {}),
      audioSourceType: source
    }
  });

  try {
    await liveStt.preconnect(sessionId);
  } catch (error) {
    console.error("live STT preconnect failed", safeErrorLogFields(error, {
      sessionId,
      reason: "provider_connect_failed"
    }));
    throw createPublicError("音声認識プロバイダへの接続に失敗しました。時間を置いて再試行してください。", 502);
  }

  const bucket = getSocketBucket(sessionId);
  const activeAudioSockets = source === "local_browser" ? bucket.recorder : bucket.mobile;
  for (const ws of activeAudioSockets || []) {
    if (ws?.meta) {
      ws.meta.firstAudioFrameReceivedAt = null;
    }
  }

  const recordingMaxDurationMinutes = await resolveRecordingMaxDurationMinutesForSession(stateBeforeStart.session);
  const recordingStartedAt = nowIso();
  const recordingExpiresAt = addMinutes(
    recordingStartedAt,
    recordingMaxDurationMinutes
  );

  if (Date.parse(recordingExpiresAt) <= Date.now()) {
    throw createPublicError("録音上限に達しているため再開できません。録音を停止して内容を確認してください。", 409);
  }

  let recordingAutoStopTaskName = null;

  if (config.finalizeTasksQueue && request) {
    const payload = {
      sessionId,
      clinicId: stateBeforeStart.session.clinicId || stateBeforeStart.session.orgId,
      recordingExpiresAt
    };
    const taskResult = await enqueueRecordingAutoStopTask({
      payload,
      endpoint: getRecordingAutoStopEndpoint(request),
      scheduleTime: recordingExpiresAt
    });
    recordingAutoStopTaskName = taskResult?.name || null;
  }

  const session = await store.startRecording(sessionId, {
    deviceId,
    audioSourceType: source,
    deviceLabel,
    recordingMaxDurationMinutes,
    recordingExpiresAt,
    recordingAutoStopTaskName
  });

  if (!recordingAutoStopTaskName) {
    scheduleRecordingAutoStopFallback(sessionId, recordingExpiresAt);
  }

  broadcast(
    sessionId,
    {
      type: "recording.started",
      sessionId,
      audioSourceType: source,
      audioDeviceId: deviceId,
      recordingMaxDurationMinutes,
      recordingExpiresAt
    },
    ["pc", "mobile"]
  );
  await emitSessionState(sessionId);

  return session;
}

async function stopRecordingSession(sessionId, {
  actorType = "user",
  actorId = null,
  stopReason = "manual"
} = {}) {
  const stateBeforeStop = await store.getSessionState(sessionId);

  if (!stateBeforeStop) {
    throw createPublicError("診療画面が見つかりません。", 404);
  }

  if (stateBeforeStop.session.status !== "recording") {
    if (["stopped", "finalizing", "soap_ready", "approved", "failed"].includes(stateBeforeStop.session.status)) {
      clearRecordingAutoStopTimer(sessionId);
      return stateBeforeStop.session;
    }

    throw createPublicError("このセッションは録音停止できる状態ではありません。", 409);
  }

  clearRecordingAutoStopTimer(sessionId);

  let session = await store.stopRecording(sessionId, {
    actorType,
    actorId,
    stopReason
  });

  if (stateBeforeStop.session.audioSourceType === "linked_mobile" && hasOpenMobileSocket(sessionId)) {
    session = await store.updateSession(sessionId, {
      mobileConnectionState: "mic_ready",
      audioConnectionState: "mic_ready",
      audioDeviceId: stateBeforeStop.session.audioDeviceId || session.audioDeviceId || null,
      audioDeviceLabel: stateBeforeStop.session.audioDeviceLabel || session.audioDeviceLabel || "録音用スマホ",
      updatedAt: nowIso()
    });
  }

  if (stopReason === "auto_timeout") {
    await appendAuditEventSafe(sessionId, {
      type: "recording.auto_stopped",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        recordingMaxDurationMinutes: stateBeforeStop.session.recordingMaxDurationMinutes || null,
        recordingExpiresAt: stateBeforeStop.session.recordingExpiresAt || null
      }
    });
  }

  const rawAudio = liveStt.exportArchivedAudio(sessionId);
  if (rawAudio) {
    setPendingFinalizeAudio(sessionId, rawAudio);
    const bytesPerSecond = Math.max(1, (rawAudio.sampleRateHz || 24_000) * (rawAudio.channels || 1) * 2);
    await store.appendAuditEvent(sessionId, {
      type: "audio.capture.summary",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        byteLength: rawAudio.byteLength || rawAudio.pcmBuffer.length,
        chunkCount: rawAudio.chunkCount || null,
        estimatedDurationMs: Math.round(((rawAudio.byteLength || rawAudio.pcmBuffer.length) / bytesPerSecond) * 1000),
        sampleRateHz: rawAudio.sampleRateHz || null,
        channels: rawAudio.channels || null,
        audioSourceType: stateBeforeStop.session.audioSourceType || null
      }
    });

    try {
      await persistRawAudioIfConfigured(sessionId, rawAudio);
    } catch (error) {
      console.error("raw audio storage failed", safeErrorLogFields(error, {
        sessionId,
        reason: "raw_audio_storage_failed"
      }));
      await appendAuditEventSafe(sessionId, {
        type: "audio.raw_audio.store_failed",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          reason: "storage_error"
        }
      });

      if (config.finalizeMode !== "inline") {
        throw createPublicError("録音データの保存に失敗しました。時間を置いて再試行してください。", 502);
      }
    }
  }
  await liveStt.flush(sessionId);
  await wait(250);
  const segmentPrecomputeJob = finalizeFinalTranscriptSegmentPrecompute(sessionId);
  if (!segmentPrecomputeJob) {
    startFinalTranscriptPrecompute(sessionId, { rawAudio });
  }
  await liveStt.reset(sessionId, { preserveMetadata: true });

  broadcast(
    sessionId,
    {
      type: "recording.stopped",
      sessionId,
      stopReason,
      autoStopped: stopReason === "auto_timeout"
    },
    ["pc", "mobile"]
  );
  await emitSessionState(sessionId);

  return session;
}

async function autoStopRecordingSession(sessionId, {
  expectedRecordingExpiresAt = null,
  trigger = "unknown"
} = {}) {
  const state = await store.getSessionState(sessionId);

  if (!state) {
    return { stopped: false, reason: "missing_session" };
  }

  if (state.session.status !== "recording") {
    return { stopped: false, reason: "not_recording", session: state.session };
  }

  const recordingExpiresAt = state.session.recordingExpiresAt || null;

  if (!recordingExpiresAt || !isRecordingPastExpiry(state.session)) {
    return { stopped: false, reason: "not_expired", session: state.session };
  }

  if (expectedRecordingExpiresAt && recordingExpiresAt !== expectedRecordingExpiresAt) {
    return { stopped: false, reason: "stale_task", session: state.session };
  }

  await appendAuditEventSafe(sessionId, {
    type: "recording.auto_stop.triggered",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      trigger,
      recordingExpiresAt,
      recordingMaxDurationMinutes: state.session.recordingMaxDurationMinutes || null
    }
  });

  const session = await stopRecordingSession(sessionId, {
    actorType: "system",
    actorId: "gateway",
    stopReason: "auto_timeout"
  });

  return { stopped: true, reason: "auto_timeout", session };
}

async function discardRecordingSession(sessionId, { actorId }) {
  const stateBeforeDiscard = await store.getSessionState(sessionId);

  if (!stateBeforeDiscard) {
    throw createPublicError("診療画面が見つかりません。", 404);
  }

  if (!["stopped", "degraded_recording"].includes(stateBeforeDiscard.session.status)) {
    throw createPublicError("録音終了後に録り直しできます。録音中の場合は先に停止してください。", 409);
  }

  clearRecordingAutoStopTimer(sessionId);
  deletePendingFinalizeAudio(sessionId, "recording_discarded");
  pendingFinalTranscriptJobs.delete(sessionId);
  resetFinalTranscriptSegmenter(sessionId, "recording_discarded");
  await liveStt.reset(sessionId, { preserveMetadata: true });
  const session = await store.discardRecordingAttempt(sessionId, { actorId });

  broadcast(
    sessionId,
    {
      type: "recording.discarded",
      sessionId
    },
    ["pc", "mobile"]
  );
  await emitSessionState(sessionId);

  return session;
}

async function startSoapGeneration(sessionId, { actorId = "unknown-member" } = {}) {
  let state = await store.getSessionState(sessionId);

  if (!state) {
    throw createPublicError("診療画面が見つかりません。", 404);
  }

  state = await recoverStaleFinalizingSession(sessionId, state, {
    reason: "generate_request"
  });

  if (state.session.status === "finalizing") {
    return state.session;
  }

  if (["soap_ready", "approved"].includes(state.session.status)) {
    return state.session;
  }

  if (state.session.status !== "stopped") {
    throw createPublicError("録音終了後にSOAP下書きを作成できます。", 409);
  }

  const requestedAt = nowIso();
  const session = await store.updateSession(sessionId, {
    status: "finalizing",
    errorCode: null,
    errorMessageSafe: null,
    soapGenerationPreview: null,
    soapGenerationPreviewUpdatedAt: null,
    finalizeRequestedAt: requestedAt,
    finalizeTaskName: null,
    finalizeTimedOutAt: null,
    updatedAt: requestedAt
  });
  await emitSessionState(sessionId);

  const rawAudio = getPendingFinalizeAudio(sessionId);
  await waitForFinalTranscriptSegmentPrecompute(sessionId);
  const segmentPrecomputeStatus = getFinalTranscriptSegmentJobStatus(getFinalTranscriptSegmenter(sessionId));
  const transcriptJob =
    pendingFinalTranscriptJobs.get(sessionId) ||
    (segmentPrecomputeStatus === "missing" ? startFinalTranscriptPrecompute(sessionId, { rawAudio }) : null);
  await appendAuditEventSafe(sessionId, {
    type: "soap.generation.requested",
    actorType: "user",
    actorId,
    safePayload: {
      precomputeStatus: getFinalTranscriptJobStatus(transcriptJob),
      segmentPrecomputeStatus,
      hadRawAudio: Boolean(rawAudio?.pcmBuffer?.length),
      rawAudioByteLength: getRawAudioByteLength(rawAudio),
      rawAudioDurationMs: getRawAudioDurationMs(rawAudio)
    }
  });

  void runFinalize(sessionId, { rawAudio, transcriptJob })
    .then(() => {
      deletePendingFinalizeAudio(sessionId, "finalize_completed");
      pendingFinalTranscriptJobs.delete(sessionId);
    })
    .catch(async (error) => {
      markPendingFinalizeAudioFailed(sessionId);
      console.error("finalize failed", safeErrorLogFields(error, {
        sessionId,
        reason: "finalize_error"
      }));
      const message = publicErrorMessage(error, "SOAP下書き作成に失敗しました。時間を置いてもう一度お試しください。");
      await appendAuditEventSafe(sessionId, {
        type: "soap.finalize.failed",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          precomputeStatus: getFinalTranscriptJobStatus(transcriptJob),
          reason: "finalize_error"
        }
      });
      await store.updateSession(sessionId, {
        status: "stopped",
        errorCode: "FINALIZE_FAILED",
        errorMessageSafe: message,
        soapGenerationPreview: null,
        soapGenerationPreviewUpdatedAt: null,
        updatedAt: nowIso()
      });
      await emitSessionState(sessionId);
      broadcast(
        sessionId,
        {
          type: "error",
          code: "FINALIZE_FAILED",
          message
        },
        ["pc"]
      );
    });

  return session;
}

async function startSoapRegeneration(sessionId, { actorId = "unknown-member", promptProfileId } = {}) {
  let state = await store.getSessionState(sessionId);

  if (!state) {
    throw createPublicError("診療画面が見つかりません。", 404);
  }

  state = await recoverStaleFinalizingSession(sessionId, state, {
    reason: "regenerate_request"
  });

  if (!state.latestSoap) {
    throw createPublicError("再作成するSOAP下書きがありません。", 409);
  }

  if (state.session.status === "finalizing") {
    throw createPublicError("SOAP下書きの作成中です。完了してからもう一度お試しください。", 409);
  }

  const transcript = getTranscriptForSoapRegeneration(state);
  const isRegeneratingAfterAdditionalRecording = transcript?.source === "live_turns_appended";

  if ((state.session.status === "approved" || state.latestSoap.status === "approved") && !isRegeneratingAfterAdditionalRecording) {
    throw createPublicError("確定した記録は再作成できません。", 409);
  }

  if (!["soap_ready", "stopped"].includes(state.session.status)) {
    throw createPublicError("SOAP下書きの確認中または追加録音の停止後だけ、再作成できます。", 409);
  }

  if (!transcript?.text) {
    throw createPublicError("再作成に使える書き起こしがありません。", 409);
  }

  const previousSoap = state.latestSoap;
  const previousPromptProfileId = state.session.promptProfileId || previousSoap.promptProfileId || null;
  const previousPromptProfileSelectedAt = state.session.promptProfileSelectedAt || null;
  const previousPromptProfileSelectedByMemberId = state.session.promptProfileSelectedByMemberId || null;
  const previousPromptProfileSelectionSource = state.session.promptProfileSelectionSource || "default";
  const updatedAt = nowIso();
  const session = await store.updateSession(sessionId, {
    status: "finalizing",
    promptProfileId,
    promptProfileSelectedAt: updatedAt,
    promptProfileSelectedByMemberId: actorId || null,
    promptProfileSelectionSource: "manual",
    errorCode: null,
    errorMessageSafe: null,
    soapGenerationPreview: null,
    soapGenerationPreviewUpdatedAt: null,
    finalizeRequestedAt: updatedAt,
    finalizeTaskName: null,
    finalizeTimedOutAt: null,
    updatedAt
  });

  broadcastSessionState(sessionId, session);
  broadcast(
    sessionId,
    {
      type: "soap.status",
      sessionId,
      status: "regenerating"
    },
    ["pc"]
  );

  await appendAuditEventSafe(sessionId, {
    type: "soap.regeneration.requested",
    actorType: "user",
    actorId,
    safePayload: {
      previousSoapVersionId: previousSoap.versionId,
      previousPromptProfileId,
      promptProfileId,
      transcriptSource: transcript.source,
      transcriptTextLength: transcript.text.length
    }
  });

  void runSoapRegeneration(sessionId, {
    actorId,
    previousSoapVersionId: previousSoap.versionId,
    previousPromptProfileId,
    promptProfileId,
    transcript
  }).catch(async (error) => {
    console.error("soap regeneration failed", safeErrorLogFields(error, {
      sessionId,
      reason: "regeneration_error"
    }));
    const message = publicErrorMessage(error, "SOAP下書きの再作成に失敗しました。時間を置いてもう一度お試しください。");
    await appendAuditEventSafe(sessionId, {
      type: "soap.regeneration.failed",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        previousSoapVersionId: previousSoap.versionId,
        promptProfileId,
        reason: "regeneration_error"
      }
    });
    await store.updateSession(sessionId, {
      status: "soap_ready",
      promptProfileId: previousPromptProfileId,
      promptProfileSelectedAt: previousPromptProfileSelectedAt,
      promptProfileSelectedByMemberId: previousPromptProfileSelectedByMemberId,
      promptProfileSelectionSource: previousPromptProfileSelectionSource,
      errorCode: "SOAP_REGENERATION_FAILED",
      errorMessageSafe: message,
      soapGenerationPreview: null,
      soapGenerationPreviewUpdatedAt: null,
      updatedAt: nowIso()
    });
    await emitSessionState(sessionId);
    broadcast(
      sessionId,
      {
        type: "error",
        code: "SOAP_REGENERATION_FAILED",
        message
      },
      ["pc"]
    );
  });

  return session;
}

async function runSoapRegeneration(sessionId, {
  previousSoapVersionId,
  previousPromptProfileId,
  promptProfileId,
  transcript
} = {}) {
  const startedAt = Date.now();
  const previewToken = beginSoapGenerationPreview(sessionId);
  await appendAuditEventSafe(sessionId, {
    type: "soap.regeneration.transcript_reused",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      previousSoapVersionId,
      previousPromptProfileId,
      promptProfileId,
      transcriptSource: transcript.source,
      transcriptTextLength: transcript.text.length,
      finalRepassAttempted: false
    }
  });
  let result;

  try {
    result = await finalizeSession({
      store,
      sessionId,
      rawAudio: null,
      preparedTranscript: {
        text: transcript.text,
        source: transcript.source,
        durationMs: 0,
        hadRawAudio: false,
        rawAudioByteLength: 0,
        rawAudioDurationMs: 0,
        finalRepassAttempted: false,
        finalRepassSucceeded: false
      },
      onSoapOutputTextSnapshot: (outputText) => {
        return publishSoapGenerationPreview(sessionId, previewToken, outputText);
      }
    });
  } finally {
    finishSoapGenerationPreview(sessionId);
  }

  const serializedSoap = serializeSoapForClient(result.latestSoap);

  broadcast(
    sessionId,
    {
      type: "soap.ready",
      sessionId,
      versionId: result.latestSoap.versionId,
      soap: serializedSoap
    },
    ["pc"]
  );

  if (serializedSoap?.structuredJson?.finalTranscript) {
    broadcast(
      sessionId,
      {
        type: "transcript.corrected",
        sessionId,
        text: serializedSoap.structuredJson.finalTranscript,
        versionId: result.latestSoap.versionId,
        updatedAt: serializedSoap.updatedAt
      },
      ["pc"]
    );
  }

  await emitSessionState(sessionId);
  await appendAuditEventSafe(sessionId, {
    type: "soap.regeneration.completed",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      previousSoapVersionId,
      previousPromptProfileId,
      promptProfileId,
      versionId: result.latestSoap.versionId,
      durationMs: Date.now() - startedAt,
      transcriptSource: transcript.source,
      transcriptTextLength: transcript.text.length
    }
  });
}

function broadcastSessionState(sessionId, session) {
  broadcast(
    sessionId,
    {
      type: "session.state.updated",
      sessionId,
      status: session.status,
      mobileConnectionState: session.mobileConnectionState,
      audioSourceType: session.audioSourceType || null,
      audioConnectionState: session.audioConnectionState || session.mobileConnectionState,
      audioDeviceId: session.audioDeviceId || null,
      audioDeviceLabel: session.audioDeviceLabel || null,
      recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(session.recordingMaxDurationMinutes),
      recordingExpiresAt: session.recordingExpiresAt || null,
      recordingStopReason: session.recordingStopReason || null,
      errorCode: session.errorCode || null,
      errorMessageSafe: session.errorMessageSafe || null,
      updatedAt: session.updatedAt
    },
    ["pc", "mobile", "recorder"]
  );
}

function getFinalizingStartedAt(session = {}) {
  const candidates = [
    session.finalizeRequestedAt,
    session.stoppedAt,
    session.promptProfileSelectedAt,
    session.updatedAt
  ];

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate || "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function shouldRecoverStaleFinalizingSession(state) {
  if (
    !state?.session ||
    state.session.status !== "finalizing" ||
    !Number.isFinite(config.finalizeStaleTimeoutMs) ||
    config.finalizeStaleTimeoutMs <= 0
  ) {
    return false;
  }

  const startedAt = getFinalizingStartedAt(state.session);
  if (!startedAt) {
    return false;
  }

  return Date.now() - startedAt >= config.finalizeStaleTimeoutMs;
}

async function recoverStaleFinalizingSession(sessionId, state, { reason = "stale_finalizing" } = {}) {
  if (!shouldRecoverStaleFinalizingSession(state)) {
    return state;
  }

  const hasExistingSoap = Boolean(state.latestSoap);
  const errorCode = hasExistingSoap ? "SOAP_REGENERATION_TIMEOUT" : "FINALIZE_TIMEOUT";
  const message = hasExistingSoap
    ? "SOAP下書きの再作成が時間内に完了しませんでした。元の下書きを確認し、必要であればもう一度お試しください。"
    : "SOAP下書き作成が時間内に完了しませんでした。もう一度お試しください。";
  const updatedAt = nowIso();
  const session = await store.updateSession(sessionId, {
    status: hasExistingSoap ? "soap_ready" : "stopped",
    errorCode,
    errorMessageSafe: message,
    finalizeTimedOutAt: updatedAt,
    updatedAt
  });

  await appendAuditEventSafe(sessionId, {
    type: hasExistingSoap ? "soap.regeneration.timed_out" : "soap.finalize.timed_out",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      reason,
      finalizeTaskName: state.session.finalizeTaskName || null,
      finalizeRequestedAt: state.session.finalizeRequestedAt || null,
      timeoutMs: config.finalizeStaleTimeoutMs
    }
  });

  broadcastSessionState(sessionId, session);
  broadcast(
    sessionId,
    {
      type: "error",
      code: errorCode,
      message
    },
    ["pc"]
  );

  return {
    ...state,
    session
  };
}

async function emitSessionState(sessionId) {
  const state = await store.getSessionState(sessionId);

  if (!state) {
    return;
  }

  broadcastSessionState(sessionId, state.session);

  if (state.latestSoap) {
    const serializedSoap = serializeSoapForClient(state.latestSoap);

    broadcast(
      sessionId,
      {
        type: "soap.ready",
        sessionId,
        versionId: state.latestSoap.versionId,
        soap: serializedSoap
      },
      ["pc"]
    );

    if (serializedSoap?.structuredJson?.finalTranscript) {
      broadcast(
        sessionId,
        {
          type: "transcript.corrected",
          sessionId,
          text: serializedSoap.structuredJson.finalTranscript,
          versionId: state.latestSoap.versionId,
          updatedAt: serializedSoap.updatedAt
        },
        ["pc"]
      );
    }
  }
}

function estimateTurnWindow(turnCount) {
  const startMs = turnCount * 4000;
  return {
    startMs,
    endMs: startMs + 2500
  };
}

function getLiveTranscriptDropReason({ text, confidence }) {
  const normalizedText = String(text || "").trim();
  const compactText = normalizedText.replace(/\s+/g, "");

  if (compactText.length < config.liveStt.minFinalTextChars) {
    return "too_short";
  }

  if (
    confidence != null &&
    confidence < config.liveStt.minFinalConfidence &&
    compactText.length <= config.liveStt.lowConfidenceShortTextMaxChars
  ) {
    return "low_confidence_short_turn";
  }

  return null;
}

const liveStt = new LiveSttPipeline({
  config: config.liveStt,
  onPartial: async ({ sessionId, text, provider }) => {
    const state = await store.getSessionState(sessionId);

    if (!state) {
      return;
    }

    const window = estimateTurnWindow(state.turns.length);
    await store.updateSession(sessionId, {
      latestPartialPreview: text,
      liveSttProvider: provider
    });

    broadcast(
      sessionId,
      {
        type: "transcript.partial",
        sessionId,
        sequenceNo: state.session.lastSequenceNo + 1,
        text,
        startMs: window.startMs,
        endMs: window.endMs,
        provider
      },
      ["pc"]
    );
  },
  onFinal: async ({ sessionId, text, provider, confidence }) => {
    const state = await store.getSessionState(sessionId);

    if (!state || !text.trim()) {
      return;
    }

    const dropReason = getLiveTranscriptDropReason({ text, confidence });
    if (dropReason) {
      await store.updateSession(sessionId, {
        latestPartialPreview: null,
        liveSttProvider: provider
      });
      await store.appendAuditEvent(sessionId, {
        type: "transcript.live_stt.dropped",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          reason: dropReason,
          provider,
          confidence: confidence ?? null,
          textLength: text.trim().length
        }
      });
      broadcast(
        sessionId,
        {
          type: "transcript.partial",
          sessionId,
          sequenceNo: state.session.lastSequenceNo + 1,
          text: "",
          startMs: 0,
          endMs: 0,
          provider
        },
        ["pc"]
      );
      return;
    }

    const window = estimateTurnWindow(state.turns.length);
    const turn = await store.appendTurn(sessionId, {
      source: "live_stt",
      speaker: "unknown",
      text,
      startMs: window.startMs,
      endMs: window.endMs,
      confidence: confidence ?? null,
      provider
    });
    const turns = await store.listTurns(sessionId);

    await store.updateSession(sessionId, {
      latestPartialPreview: null,
      liveSttProvider: provider
    });

    broadcast(
      sessionId,
      {
        type: "transcript.final",
        sessionId,
        turnId: turn.turnId,
        turnIndex: turn.turnIndex,
        speaker: turn.speaker,
        text: turn.text,
        startMs: turn.startMs,
        endMs: turn.endMs,
        confidence: turn.confidence,
        provider
      },
      ["pc"]
    );

    broadcast(
      sessionId,
      {
        type: "highlights.updated",
        sessionId,
        items: buildHighlightsFromTurns(turns)
      },
      ["pc"]
    );
  },
  onProviderChanged: async ({ sessionId, provider }) => {
    await store.updateSession(sessionId, {
      liveSttProvider: provider
    });
    await emitSessionState(sessionId);
  },
  onError: async ({ sessionId, error, provider }) => {
    const message = "音声認識プロバイダでエラーが発生しました。時間を置いてもう一度お試しください。";
    console.error("live STT provider error", safeErrorLogFields(error, {
      sessionId,
      provider,
      reason: "provider_error"
    }));

    await store.updateSession(sessionId, {
      errorCode: "LIVE_STT_PROVIDER_ERROR",
      errorMessageSafe: message
    });

    broadcast(
      sessionId,
      {
        type: "error",
        code: "LIVE_STT_PROVIDER_ERROR",
        message
      },
      ["pc"]
    );
  }
});

async function runFinalize(sessionId, { rawAudio = null, transcriptJob = null } = {}) {
  const stateBefore = await store.getSessionState(sessionId);

  if (!stateBefore) {
    throw new Error(`診療画面が見つかりません: ${sessionId}`);
  }

  const finalizeStartedAt = Date.now();
  const finalizeStartedAtIso = nowIso();
  const precomputeStatusAtStart = getFinalTranscriptJobStatus(transcriptJob);
  const segmentPrecomputeStatusAtStart = getFinalTranscriptSegmentJobStatus(getFinalTranscriptSegmenter(sessionId));
  const finalizeRequestedAt = stateBefore.session.finalizeRequestedAt || null;
  const gatewayStartedAfterRequestMs = finalizeRequestedAt
    ? Math.max(0, finalizeStartedAt - Date.parse(finalizeRequestedAt))
    : null;

  broadcast(
    sessionId,
    {
      type: "soap.status",
      sessionId,
      status: "generating"
    },
    ["pc"]
  );

  await appendAuditEventSafe(sessionId, {
    type: "soap.finalize.started",
    actorType: "system",
    actorId: "gateway",
    safePayload: {
      precomputeStatus: precomputeStatusAtStart,
      segmentPrecomputeStatus: segmentPrecomputeStatusAtStart,
      finalizeRequestedAt,
      gatewayStartedAfterRequestMs,
      hadRawAudio: Boolean(rawAudio?.pcmBuffer?.length),
      rawAudioByteLength: getRawAudioByteLength(rawAudio),
      rawAudioDurationMs: getRawAudioDurationMs(rawAudio)
    }
  });

  if (config.finalizeMode === "inline") {
    const preparedTranscript = await resolveFinalTranscriptPrecompute(sessionId, transcriptJob);
    const reusablePreparedTranscript = String(preparedTranscript?.text || "").trim()
      ? preparedTranscript
      : null;
    const previewToken = beginSoapGenerationPreview(sessionId);
    let result;

    try {
      result = await finalizeSession({
        store,
        sessionId,
        rawAudio: reusablePreparedTranscript ? null : rawAudio,
        preparedTranscript: reusablePreparedTranscript,
        onSoapOutputTextSnapshot: (outputText) => {
          return publishSoapGenerationPreview(sessionId, previewToken, outputText);
        }
      });
    } finally {
      finishSoapGenerationPreview(sessionId);
    }

    const serializedSoap = serializeSoapForClient(result.latestSoap);

    broadcast(
      sessionId,
      {
        type: "soap.ready",
        sessionId,
        versionId: result.latestSoap.versionId,
        soap: serializedSoap
      },
      ["pc"]
    );

    if (serializedSoap?.structuredJson?.finalTranscript) {
      broadcast(
        sessionId,
        {
          type: "transcript.corrected",
          sessionId,
          text: serializedSoap.structuredJson.finalTranscript,
          versionId: result.latestSoap.versionId,
          updatedAt: serializedSoap.updatedAt
        },
        ["pc"]
      );
    }
    await emitSessionState(sessionId);
    await appendAuditEventSafe(sessionId, {
      type: "soap.finalize.completed",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        durationMs: Date.now() - finalizeStartedAt,
        precomputeStatusAtStart,
        precomputeStatusAtUse: getFinalTranscriptJobStatus(transcriptJob),
        segmentPrecomputeStatusAtStart,
        segmentPrecomputeStatusAtUse: getFinalTranscriptSegmentJobStatus(getFinalTranscriptSegmenter(sessionId)),
        preparedTranscriptReused: Boolean(reusablePreparedTranscript),
        transcriptSource: reusablePreparedTranscript?.source || serializedSoap?.structuredJson?.finalTranscriptSource || null
      }
    });
    return;
  }

  const finalizePayload = {
    sessionId,
    clinicId: stateBefore.session.orgId || stateBefore.session.clinicId,
    rawAudioPath: stateBefore.session.rawAudioPath,
    enqueueSoapGeneration: true,
    finalizeRequestedAt,
    gatewayStartedAt: finalizeStartedAtIso,
    gatewayEnqueuedAt: nowIso()
  };

  if (config.finalizeTasksQueue) {
    const enqueueStartedAt = Date.now();
    const taskResult = await enqueueFinalizeTask(finalizePayload);
    const enqueueDurationMs = Date.now() - enqueueStartedAt;
    await store.updateSession(sessionId, {
      finalizeTaskName: taskResult.name || null,
      updatedAt: nowIso()
    });
    await appendAuditEventSafe(sessionId, {
      type: "soap.finalize.enqueued",
      actorType: "system",
      actorId: "gateway",
      safePayload: {
        queue: config.finalizeTasksQueue,
        taskName: taskResult.name || null,
        enqueueDurationMs,
        enqueuedAfterRequestMs: finalizeRequestedAt
          ? Math.max(0, Date.parse(finalizePayload.gatewayEnqueuedAt) - Date.parse(finalizeRequestedAt))
          : null,
        gatewayStartedAfterRequestMs,
        rawAudioPathSet: Boolean(finalizePayload.rawAudioPath)
      }
    });
    return;
  }

  const finalizeResponse = await fetch(config.finalizeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Finalize-Internal-Secret": config.finalizeInternalSecret
    },
    body: JSON.stringify(finalizePayload)
  });

  if (!finalizeResponse.ok) {
    const error = new Error(`Finalize worker request failed with status ${finalizeResponse.status}`);
    error.statusCode = 502;
    throw error;
  }
}

function gatewayReadinessPayload() {
  return {
    ok: true,
    service: "medical-gateway",
    timestamp: nowIso(),
    finalizeMode: config.finalizeMode,
    storeBackend: process.env.STORE_BACKEND || "memory",
    liveSttMode: config.liveStt.mode,
    liveSttProvider: config.liveStt.primaryProvider,
    liveSttFallbackProvider: config.liveStt.fallbackProvider,
    liveSttAllowMockFallback: config.liveStt.allowMockFallback,
    liveSttMinFinalConfidence: config.liveStt.minFinalConfidence,
    openAiRealtimeNoiseReduction: config.liveStt.openai.noiseReduction,
    openAiRealtimeVadThreshold: config.liveStt.openai.vadThreshold,
    openAiRealtimeVadSilenceDurationMs: config.liveStt.openai.vadSilenceDurationMs,
    finalTranscriptSegmentSeconds: config.finalTranscriptSegmentSeconds
  };
}

app.get("/healthz", async (_req, res) => {
  res.json(gatewayReadinessPayload());
});

app.get("/readyz", async (_req, res) => {
  res.json(gatewayReadinessPayload());
});

app.post("/api/v1/operator/login", rateLimit("operator-login", { limit: 10, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(operatorLoginRequestSchema, req.body);
    const accountRateLimitKey = `${input.organizationCode}:${input.loginId}`.toLowerCase();
    if (await checkRateLimit("operator-login-account", accountRateLimitKey, { limit: 10, windowMs: 10 * 60_000 })) {
      res.status(429).json({
        error: "ログイン試行が続いています。少し待ってからもう一度お試しください。"
      });
      return;
    }

    const authenticated = await authenticateOperator({
      organizationCode: input.organizationCode,
      loginId: input.loginId,
      password: input.password
    });

    if (!authenticated) {
      res.status(401).json({
        error: "病院コード、個人ID、またはパスワードが違います。"
      });
      return;
    }

    if (!organizationAccessAllowsAuthenticatedLogin(authenticated.organization, {
      roles: authenticated.member.roles || []
    })) {
      res.status(403).json({
        error: organizationAccessDeniedMessage(authenticated.organization, {
          roles: authenticated.member.roles || [],
          mode: "login"
        }) || "このアカウントではログインできません。"
      });
      return;
    }

    const mfaRequired = Boolean(authenticated.identity.mfaRequired) || operatorRequiresMfa(authenticated.member);

    if (mfaRequired && authenticated.identity.mfaEnrolledAt && identityHasMfaSecret(authenticated.identity)) {
      const expiresAt = mfaChallengeExpiresAt();
      const challengeId = createMfaChallengeId({
        purpose: "mfa_verify",
        orgId: authenticated.organization.orgId,
        memberId: authenticated.member.memberId,
        exp: expiresAt
      });
      res.json({
        requiresMfa: true,
        ...serializeMfaChallengeResponse(authenticated, challengeId, expiresAt)
      });
      return;
    }

    if (mfaRequired) {
      const expiresAt = mfaChallengeExpiresAt();
      const secret = createTotpSecret();
      const accountName = `${authenticated.identity.organizationCode}:${authenticated.identity.loginId}`;
      const challengeId = createMfaChallengeId({
        purpose: "mfa_enroll",
        orgId: authenticated.organization.orgId,
        memberId: authenticated.member.memberId,
        secret,
        exp: expiresAt
      });
      res.json({
        requiresMfaEnrollment: true,
        ...serializeMfaChallengeResponse(authenticated, challengeId, expiresAt, {
          secret,
          totpUri: buildTotpUri({
            issuer: "Halunasu",
            accountName,
            secret
          })
        })
      });
      return;
    }

    const issued = issueOperatorSession(res, authenticated, { amr: ["pwd"] });
    res.json(serializeOperatorLoginSuccess(authenticated, issued));
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/operator/mfa/verify", rateLimit("operator-mfa-verify", { limit: 10, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(operatorMfaVerifyRequestSchema, req.body);
    const challenge = verifyMfaChallengeId(input.challengeId, "mfa_verify");

    if (!challenge) {
      res.status(401).json({ error: "確認コードの有効期限が切れました。もう一度ログインしてください。" });
      return;
    }

    const context = await getMfaAuthContext(challenge);

    if (!context?.identity || !identityHasMfaSecret(context.identity)) {
      await appendMfaFailureAuditSafe({
        orgId: challenge.orgId,
        memberId: challenge.memberId,
        purpose: "mfa_verify",
        reason: "missing_secret"
      });
      res.status(401).json({ error: "認証アプリが登録されていません。もう一度ログインしてください。" });
      return;
    }

    if (!organizationAccessAllowsAuthenticatedLogin(context.organization, {
      roles: context.member.roles || []
    })) {
      res.status(403).json({
        error: organizationAccessDeniedMessage(context.organization, {
          roles: context.member.roles || [],
          mode: "login"
        }) || "このアカウントではログインできません。"
      });
      return;
    }

    try {
      if (!verifyIdentityTotpCode(context.identity, input.code)) {
        await appendMfaFailureAuditSafe({
          orgId: challenge.orgId,
          memberId: challenge.memberId,
          purpose: "mfa_verify",
          reason: "invalid_code"
        });
        res.status(401).json({ error: "確認コードが違います。" });
        return;
      }
    } catch (decryptError) {
      await appendMfaFailureAuditSafe({
        orgId: challenge.orgId,
        memberId: challenge.memberId,
        purpose: "mfa_verify",
        reason: "secret_decrypt_failed"
      });
      console.error("mfa secret decrypt failed", safeErrorLogFields(decryptError, {
        orgId: challenge.orgId,
        memberId: challenge.memberId
      }));
      res.status(401).json({ error: "認証アプリの確認に失敗しました。管理者にMFAリセットを依頼してください。" });
      return;
    }

    const authenticated = {
      organization: context.organization,
      member: context.member,
      identity: context.identity
    };
    const issued = issueOperatorSession(res, authenticated, { amr: ["pwd", "otp"] });
    res.json(serializeOperatorLoginSuccess(authenticated, issued));
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/operator/mfa/enroll/confirm", rateLimit("operator-mfa-enroll", { limit: 10, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(operatorMfaEnrollConfirmRequestSchema, req.body);
    const challenge = verifyMfaChallengeId(input.challengeId, "mfa_enroll");

    if (!challenge) {
      res.status(401).json({ error: "確認コードの有効期限が切れました。もう一度ログインしてください。" });
      return;
    }

    if (!verifyTotpCode(input.code, challenge.secret)) {
      await appendMfaFailureAuditSafe({
        orgId: challenge.orgId,
        memberId: challenge.memberId,
        purpose: "mfa_enroll",
        reason: "invalid_code"
      });
      res.status(401).json({ error: "確認コードが違います。" });
      return;
    }

    if (platformAuthBridgeEnabled) {
      const enrollmentContext = await getMfaAuthContext(challenge);
      if (!enrollmentContext?.identity) {
        res.status(401).json({ error: "ログイン情報を確認できません。もう一度ログインしてください。" });
        return;
      }
      await platformStore.beginMfaEnrollment(enrollmentContext.identity, challenge.secret);
      await platformStore.completeMfaEnrollment(enrollmentContext.identity);
    } else {
      await store.enableMemberMfa({
        orgId: challenge.orgId,
        memberId: challenge.memberId,
        mfaSecretEncrypted: encryptField(challenge.secret),
        actorId: challenge.memberId
      });
    }
    const context = await getMfaAuthContext(challenge);

    if (!context) {
      res.status(401).json({ error: "ログイン情報を確認できません。もう一度ログインしてください。" });
      return;
    }

    if (!organizationAccessAllowsAuthenticatedLogin(context.organization, {
      roles: context.member.roles || []
    })) {
      res.status(403).json({
        error: organizationAccessDeniedMessage(context.organization, {
          roles: context.member.roles || [],
          mode: "login"
        }) || "このアカウントではログインできません。"
      });
      return;
    }

    const authenticated = {
      organization: context.organization,
      member: context.member,
      identity: context.identity
    };
    const issued = issueOperatorSession(res, authenticated, { amr: ["pwd", "otp"] });
    res.json(serializeOperatorLoginSuccess(authenticated, issued));
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/operator/me", requireOperatorAuth, requireOperatorReadAccess, async (req, res) => {
  try {
    const member = platformAuthBridgeEnabled
      ? null
      : await store.getMember?.({
        orgId: getOrgIdForOperator(req.operator),
        memberId: getMemberIdForOperator(req.operator)
      });

    res.json({
      authenticated: true,
      accessToken: buildOperatorSessionTokenFromPayload(req.operator, member),
      session: serializeOperatorPayload(req.operator, member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/operator/logout", (_req, res) => {
  clearOperatorSessionCookie(res);
  clearOperatorCsrfCookie(res);
  res.json({ ok: true });
});

app.get("/api/v1/operator/csrf", requireOperatorAuth, (_req, res) => {
  const csrfToken = setOperatorCsrfCookie(res);
  res.json({ csrfToken });
});

app.get("/api/v1/admin/bootstrap", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-bootstrap", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    res.json(await buildAdminBootstrapPayload(req));
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/internal/recording/auto-stop", async (req, res) => {
  try {
    const providedSecret = normalizeHeaderSecret(req.get("x-finalize-internal-secret"));

    if (!config.finalizeInternalSecret || !constantTimeStringEqual(providedSecret, config.finalizeInternalSecret)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const input = parseJsonBody(recordingAutoStopTaskPayloadSchema, req.body);
    const result = await autoStopRecordingSession(input.sessionId, {
      expectedRecordingExpiresAt: input.recordingExpiresAt,
      trigger: "cloud_task"
    });

    res.json({
      ok: true,
      stopped: Boolean(result.stopped),
      reason: result.reason
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/organizations", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-organizations", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenSettingsConsole(req.operator)) {
      res.status(403).json({ error: "設定を開く権限がありません。" });
      return;
    }

    const currentOrgId = getOrgIdForOperator(req.operator);
    const organizations = await listAdminOrganizations();
    const visibleOrganizations = canManagePlatformSettings(req.operator)
      ? organizations
      : organizations.filter((organization) => (organization.orgId || organization.clinicId) === currentOrgId);

    res.json({
      organizations: visibleOrganizations.map(serializeOrganizationForClient),
      canManagePlatform: canManagePlatformSettings(req.operator)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/organizations", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-organization-create", { limit: 20, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "病院を追加する権限がありません。" });
      return;
    }

    const input = parseJsonBody(createOrganizationRequestSchema, req.body);
    const result = await createAdminOrganizationWithMember({
      input,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!result) {
      throw createPublicError("病院を追加できませんでした。", 400);
    }

    res.status(201).json({
      organization: serializeOrganizationForClient(result.organization),
      member: serializeMemberForClient(result.member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.patch("/api/v1/admin/organizations/:orgId/recording-policy", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-organization-recording-policy", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageOrganizationSettings(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "病院設定を変更する権限がありません。" });
      return;
    }

    const input = parseJsonBody(updateOrganizationRecordingPolicyRequestSchema, req.body);
    const currentOrgId = getOrgIdForOperator(req.operator);
    const requestedOrgId = req.params.orgId || input.orgId || currentOrgId;
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : currentOrgId;

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== currentOrgId) {
      res.status(403).json({ error: "別の病院の設定を操作する権限がありません。" });
      return;
    }

    const organization = await updateAdminOrganizationRecordingPolicy({
      orgId,
      recordingMaxDurationMinutes: input.recordingMaxDurationMinutes,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!organization) {
      res.status(404).json({ error: "病院が見つかりません。" });
      return;
    }

    res.json({
      organization: serializeOrganizationForClient(organization)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/role-definitions", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-role-definitions", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenAdminConsole(req.operator)) {
      res.status(403).json({ error: "権限定義を閲覧する権限がありません。" });
      return;
    }

    const roles = (await store.listRoleDefinitions?.()) || [];
    res.json({
      roles: roles.map(serializeRoleDefinitionForClient)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/members", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-members", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "メンバー一覧を閲覧する権限がありません。" });
      return;
    }

    const requestedOrgId = req.query.orgId ? String(req.query.orgId) : null;
    const orgId = canManagePlatformSettings(req.operator) && requestedOrgId ? requestedOrgId : getOrgIdForOperator(req.operator);
    const members = await listAdminMembers(orgId);

    res.json({
      members: members.map(serializeMemberForClient)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/members", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-create", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "メンバーを追加する権限がありません。" });
      return;
    }

    const input = parseJsonBody(createMemberRequestSchema, req.body);
    if (!canAssignMemberRoles(getRolesForOperator(req.operator), input.roles)) {
      res.status(403).json({ error: "指定された権限を付与する権限がありません。" });
      return;
    }

    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院にメンバーを追加する権限がありません。" });
      return;
    }

    const member = await createAdminMember({
      orgId,
      input,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      throw createPublicError("医師を追加できませんでした。", 400);
    }

    res.status(201).json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.patch("/api/v1/admin/members/:memberId/preferences", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-preferences", { limit: 90, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(updateMemberPreferencesRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);
    const operatorOrgId = getOrgIdForOperator(req.operator);
    const targetMemberId = req.params.memberId;
    const isSelf = orgId === operatorOrgId && targetMemberId === getMemberIdForOperator(req.operator);

    if (!isSelf && !canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "メンバー設定を変更する権限がありません。" });
      return;
    }

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院のメンバー設定を変更する権限がありません。" });
      return;
    }

    const member = await updateAdminMemberPreferences({
      orgId,
      memberId: targetMemberId,
      defaultRecordingSource: input.defaultRecordingSource,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      res.status(404).json({ error: "メンバーが見つかりません。" });
      return;
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/members/:memberId/password", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-password", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "パスワードを再設定する権限がありません。" });
      return;
    }

    const input = parseJsonBody(resetMemberPasswordRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院のパスワードを再設定する権限がありません。" });
      return;
    }

    const member = await resetAdminMemberPassword({
      orgId,
      memberId: req.params.memberId,
      password: input.password,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      throw createPublicError("パスワードを再設定できませんでした。", 400);
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.patch("/api/v1/admin/members/:memberId/roles", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-roles", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "権限を変更する権限がありません。" });
      return;
    }

    const input = parseJsonBody(updateMemberRolesRequestSchema, req.body);
    if (!canAssignMemberRoles(getRolesForOperator(req.operator), input.roles)) {
      res.status(403).json({ error: "指定された権限を付与する権限がありません。" });
      return;
    }

    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院の権限を変更する権限がありません。" });
      return;
    }

    const member = await updateAdminMemberRoles({
      orgId,
      memberId: req.params.memberId,
      roles: input.roles,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      res.status(404).json({ error: "メンバーが見つかりません。" });
      return;
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.patch("/api/v1/admin/members/:memberId/status", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-status", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "メンバーを停止・再開する権限がありません。" });
      return;
    }

    const input = parseJsonBody(updateMemberStatusRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院のメンバーを停止・再開する権限がありません。" });
      return;
    }

    if (orgId === getOrgIdForOperator(req.operator) && req.params.memberId === getMemberIdForOperator(req.operator) && input.status !== "active") {
      res.status(400).json({ error: "自分自身のアカウントは停止できません。" });
      return;
    }

    const member = await updateAdminMemberStatus({
      orgId,
      memberId: req.params.memberId,
      status: input.status,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      res.status(404).json({ error: "メンバーが見つかりません。" });
      return;
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/members/:memberId/revoke-sessions", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-revoke-sessions", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "セッションを失効する権限がありません。" });
      return;
    }

    const input = parseJsonBody(revokeMemberSessionsRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院のセッションを失効する権限がありません。" });
      return;
    }

    const result = await revokeAdminMemberSessions({
      orgId,
      memberId: req.params.memberId,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!result) {
      res.status(404).json({ error: "メンバーが見つかりません。" });
      return;
    }

    res.json({ ok: true, revoked: result });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/members/:memberId/mfa-reset", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-member-mfa-reset", { limit: 20, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "MFAをリセットする権限がありません。" });
      return;
    }

    const input = parseJsonBody(resetMemberMfaRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院のMFAをリセットする権限がありません。" });
      return;
    }

    const member = await resetAdminMemberMfa({
      orgId,
      memberId: req.params.memberId,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!member) {
      res.status(404).json({ error: "メンバーが見つかりません。" });
      return;
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/trusted-recorders", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-trusted-recorders", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "録音端末を閲覧する権限がありません。" });
      return;
    }

    const orgId = getAdminTargetOrgId(req);
    const recorders = await store.listTrustedRecorders?.({ orgId, includeRevoked: true }) || [];

    res.json({
      recorders: recorders.map(serializeTrustedRecorderForClient)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/trusted-recorders/:deviceId/revoke", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-trusted-recorder-revoke", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageMembers(req.operator) && !canManagePlatformSettings(req.operator)) {
      res.status(403).json({ error: "録音端末を失効する権限がありません。" });
      return;
    }

    const input = parseJsonBody(revokeTrustedRecorderRequestSchema, req.body);
    const requestedOrgId = input.orgId || getOrgIdForOperator(req.operator);
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : getOrgIdForOperator(req.operator);

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== orgId) {
      res.status(403).json({ error: "別の病院の録音端末を失効する権限がありません。" });
      return;
    }

    const deviceId = String(req.params.deviceId || "").trim();
    const recorder = await store.revokeTrustedRecorder?.({
      orgId,
      deviceId,
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!recorder) {
      res.status(404).json({ error: "録音端末が見つかりません。" });
      return;
    }

    deleteTrustedRecorderAssignmentsForDevice(deviceId, orgId);
    trustedRecorderRegistry.set(trustedRecorderKey(orgId, deviceId), recorder);

    res.json({
      recorder: serializeTrustedRecorderForClient(recorder)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/audio-tests", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-audio-test-create", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenSettingsConsole(req.operator)) {
      res.status(403).json({ error: "音声テストを開く権限がありません。" });
      return;
    }

    const input = parseJsonBody(createAudioTestRequestSchema, req.body);
    const currentOrgId = getOrgIdForOperator(req.operator);
    const requestedOrgId = input.orgId || currentOrgId;
    const orgId = canManagePlatformSettings(req.operator) ? requestedOrgId : currentOrgId;

    if (!canManagePlatformSettings(req.operator) && requestedOrgId !== currentOrgId) {
      res.status(403).json({ error: "別の病院の音声テストを発行する権限がありません。" });
      return;
    }

    const created = await store.createAudioTest?.({
      orgId,
      createdByMemberId: getMemberIdForOperator(req.operator)
    });

    if (!created?.audioTest || !created?.plainToken) {
      throw createPublicError("音声テストの発行に失敗しました。", 400);
    }

    res.status(201).json({
      audioTest: serializeAudioTestForClient(created.audioTest),
      joinUrl: createAudioTestJoinUrl(created.audioTest.testId, created.plainToken)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/audio-tests/:testId", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-audio-test-get", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenSettingsConsole(req.operator)) {
      res.status(403).json({ error: "音声テストを開く権限がありません。" });
      return;
    }

    const audioTest = await store.getAudioTest?.(req.params.testId);

    if (!audioTest) {
      res.status(404).json({ error: "音声テストが見つかりません。" });
      return;
    }

    if (!canManagePlatformSettings(req.operator) && audioTest.orgId !== getOrgIdForOperator(req.operator)) {
      res.status(403).json({ error: "別の病院の音声テストを閲覧する権限がありません。" });
      return;
    }

    res.json({
      audioTest: serializeAudioTestForClient(audioTest)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/audio-tests/:testId/complete", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-audio-test-complete", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenSettingsConsole(req.operator)) {
      res.status(403).json({ error: "音声テストを操作する権限がありません。" });
      return;
    }

    const audioTest = await store.getAudioTest?.(req.params.testId);

    if (!audioTest) {
      res.status(404).json({ error: "音声テストが見つかりません。" });
      return;
    }

    if (!canManagePlatformSettings(req.operator) && audioTest.orgId !== getOrgIdForOperator(req.operator)) {
      res.status(403).json({ error: "別の病院の音声テストを終了する権限がありません。" });
      return;
    }

    const completed = await store.completeAudioTest?.(req.params.testId, {
      actorId: getMemberIdForOperator(req.operator)
    });

    if (!completed) {
      res.status(410).json({ error: "音声テストはすでに終了しています。" });
      return;
    }

    res.json({
      audioTest: serializeAudioTestForClient(completed)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/soap-formats", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-soap-formats", { limit: 180, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを閲覧する権限がありません。" });
      return;
    }

    const summary = ["1", "true", "yes"].includes(String(req.query.summary || "").toLowerCase());
    const formats = await listAdminSoapFormats(req, { summary });

    res.json({
      formats: formats.map(summary ? serializeSoapFormatSummaryForClient : serializeSoapFormatForClient)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-create", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを作成する権限がありません。" });
      return;
    }

    const input = parseJsonBody(createSoapFormatRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const memberId = getMemberIdForOperator(req.operator);
    const normalizedInput = canManageOrganizationSoapFormats(req.operator)
      ? {
          ...input,
          ownerMemberId: input.scope === "member" ? input.ownerMemberId || memberId : input.ownerMemberId || null
        }
      : {
          ...input,
          scope: "member",
          ownerMemberId: memberId
        };

    if (!canEditSoapFormat(req.operator, normalizedInput)) {
      res.status(403).json({ error: "SOAPフォーマットを作成する権限がありません。" });
      return;
    }

    const format = await store.createSoapFormatProfile({
      orgId,
      input: normalizedInput,
      actorId: memberId
    });

    res.status(201).json({
      format: serializeSoapFormatForClient(format)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/soap-formats/:formatId", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-soap-format-get", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを閲覧する権限がありません。" });
      return;
    }

    const orgId = getAdminTargetOrgId(req);
    const format = req.params.formatId === DEFAULT_SOAP_FORMAT_PROFILE.profileId
      ? DEFAULT_SOAP_FORMAT_PROFILE
      : await store.getSoapFormatProfile?.({
          orgId,
          profileId: req.params.formatId
        });

    if (!format) {
      res.status(404).json({ error: "SOAPフォーマットが見つかりません。" });
      return;
    }

    if (req.params.formatId !== DEFAULT_SOAP_FORMAT_PROFILE.profileId && !canEditSoapFormat(req.operator, format)) {
      res.status(403).json({ error: "このSOAPフォーマットを閲覧できません。" });
      return;
    }

    res.json({
      format: serializeSoapFormatForClient(format)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/:formatId/draft", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-draft", { limit: 90, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを編集する権限がありません。" });
      return;
    }

    const input = parseJsonBody(updateSoapFormatDraftRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const memberId = getMemberIdForOperator(req.operator);
    const existing = await store.getSoapFormatProfile?.({ orgId, profileId: req.params.formatId });

    if (!existing) {
      res.status(404).json({ error: "SOAPフォーマットが見つかりません。" });
      return;
    }

    if (!canEditSoapFormat(req.operator, existing)) {
      res.status(403).json({ error: "このSOAPフォーマットを編集する権限がありません。" });
      return;
    }

    const nextInput = canManageOrganizationSoapFormats(req.operator)
      ? input
      : {
          ...input,
          scope: "member",
          ownerMemberId: memberId
        };
    const format = await store.updateSoapFormatDraft({
      orgId,
      profileId: req.params.formatId,
      input: nextInput,
      actorId: memberId
    });

    res.json({
      format: serializeSoapFormatForClient(format)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/:formatId/publish", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-publish", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを公開する権限がありません。" });
      return;
    }

    const input = parseJsonBody(publishSoapFormatRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const memberId = getMemberIdForOperator(req.operator);
    const existing = await store.getSoapFormatProfile?.({ orgId, profileId: req.params.formatId });

    if (!existing) {
      res.status(404).json({ error: "SOAPフォーマットが見つかりません。" });
      return;
    }

    if (!canPublishSoapFormat(req.operator, existing)) {
      res.status(403).json({ error: "このSOAPフォーマットを公開する権限がありません。" });
      return;
    }

    const validation = validateSoapFormatDefinition({
      customization: existing.customization,
      outputTemplate: existing.outputTemplate,
      sections: existing.sections
    });

    if (validation.status !== "passed") {
      res.status(422).json({
        error: "安全性チェックに通過していないため公開できません。",
        validation
      });
      return;
    }

    const format = await store.publishSoapFormatProfile({
      orgId,
      profileId: req.params.formatId,
      versionId: input.versionId || undefined,
      actorId: memberId
    });

    res.json({
      format: serializeSoapFormatForClient(format)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/:formatId/archive", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-archive", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを公開停止する権限がありません。" });
      return;
    }

    parseJsonBody(archiveSoapFormatRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const memberId = getMemberIdForOperator(req.operator);
    const existing = await store.getSoapFormatProfile?.({ orgId, profileId: req.params.formatId });

    if (!existing) {
      res.status(404).json({ error: "SOAPフォーマットが見つかりません。" });
      return;
    }

    if (!canPublishSoapFormat(req.operator, existing)) {
      res.status(403).json({ error: "このSOAPフォーマットを公開停止する権限がありません。" });
      return;
    }

    const format = await store.archiveSoapFormatProfile?.({
      orgId,
      profileId: req.params.formatId,
      actorId: memberId
    });

    res.json({
      format: serializeSoapFormatForClient(format)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/preview", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-preview-draft", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットをプレビューする権限がありません。" });
      return;
    }

    const input = parseJsonBody(previewSoapFormatDraftRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const normalizedFormatInput = normalizePreviewSoapFormatInput(req.operator, input.format);

    if (!canEditSoapFormat(req.operator, normalizedFormatInput)) {
      res.status(403).json({ error: "このSOAPフォーマットをプレビューできません。" });
      return;
    }

    const validation = validateSoapFormatDefinition({
      customization: normalizedFormatInput.customization,
      outputTemplate: normalizedFormatInput.outputTemplate,
      sections: normalizedFormatInput.sections
    });
    const previewFormat = {
      profileId: `preview-${getMemberIdForOperator(req.operator) || "operator"}`,
      formatId: `preview-${getMemberIdForOperator(req.operator) || "operator"}`,
      ...normalizedFormatInput,
      status: "draft",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: null,
      latestVersion: null
    };
    const promptProfile = buildPreviewPromptProfile(previewFormat, {
      profileId: previewFormat.profileId,
      promptVersion: `${previewFormat.profileId}-preview-${Date.now()}`,
      source: "preview_draft"
    });
    const { provider, soap } = await generateSoapFormatPreview({
      input,
      orgId,
      promptProfile
    });

    res.json({
      provider,
      validation,
      format: serializeSoapFormatForClient(previewFormat),
      soap
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/infer", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-infer", { limit: 20, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットを推定する権限がありません。" });
      return;
    }

    const input = parseJsonBody(inferSoapFormatRequestSchema, req.body);
    const memberId = getMemberIdForOperator(req.operator);
    const inference = await inferSoapFormatFromSampleNotes({
      apiKey: process.env.OPENAI_API_KEY,
      samples: input.samples,
      preferredDisplayName: input.preferredDisplayName || "",
      ownerMemberId: memberId,
      model: process.env.OPENAI_SOAP_MODEL || "gpt-5.4-nano",
      reasoningEffort: process.env.OPENAI_SOAP_REASONING_EFFORT || "low"
    });
    const previewFormat = {
      profileId: `inferred-${memberId || "operator"}`,
      formatId: `inferred-${memberId || "operator"}`,
      ...inference.format,
      status: "draft",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: null,
      latestVersion: null
    };
    const validation = validateSoapFormatDefinition({
      customization: previewFormat.customization,
      outputTemplate: previewFormat.outputTemplate,
      sections: previewFormat.sections
    });

    res.json({
      provider: inference.provider,
      responseId: inference.responseId,
      usage: inference.usage,
      inference: inference.inferred,
      validation,
      format: serializeSoapFormatForClient(previewFormat)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-formats/preview-stream", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-preview-stream", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  let streamClosed = false;

  req.on("close", () => {
    streamClosed = true;
  });

  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットをプレビューする権限がありません。" });
      return;
    }

    const input = parseJsonBody(previewSoapFormatDraftRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const normalizedFormatInput = normalizePreviewSoapFormatInput(req.operator, input.format);

    if (!canEditSoapFormat(req.operator, normalizedFormatInput)) {
      res.status(403).json({ error: "このSOAPフォーマットをプレビューできません。" });
      return;
    }

    const validation = validateSoapFormatDefinition({
      customization: normalizedFormatInput.customization,
      outputTemplate: normalizedFormatInput.outputTemplate,
      sections: normalizedFormatInput.sections
    });
    const previewFormat = {
      profileId: `preview-${getMemberIdForOperator(req.operator) || "operator"}`,
      formatId: `preview-${getMemberIdForOperator(req.operator) || "operator"}`,
      ...normalizedFormatInput,
      status: "draft",
      approved: false,
      currentVersionId: null,
      currentDraftVersionId: null,
      latestVersion: null
    };
    const promptProfile = buildPreviewPromptProfile(previewFormat, {
      profileId: previewFormat.profileId,
      promptVersion: `${previewFormat.profileId}-preview-${Date.now()}`,
      source: "preview_draft_stream"
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    writeJsonEventStreamChunk(res, "preview.started", {
      provider: process.env.OPENAI_API_KEY ? "openai" : "local_preview",
      validation,
      format: serializeSoapFormatForClient(previewFormat),
      updatedAt: nowIso()
    });

    const { provider, soap } = await generateSoapFormatPreview({
      input,
      orgId,
      promptProfile,
      onOutputTextSnapshot: async (outputText) => {
        if (streamClosed) {
          return;
        }

        writeJsonEventStreamChunk(res, "preview.updated", {
          provider: process.env.OPENAI_API_KEY ? "openai" : "local_preview",
          outputText,
          updatedAt: nowIso()
        });
      }
    });

    if (streamClosed) {
      return;
    }

    writeJsonEventStreamChunk(res, "preview.completed", {
      provider,
      validation,
      format: serializeSoapFormatForClient(previewFormat),
      soap
    });
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, error, 400);
      return;
    }

    if (!streamClosed) {
      writeJsonEventStreamChunk(res, "preview.error", {
        error: publicErrorMessage(error, "出力例を作成できませんでした。時間を置いてもう一度お試しください。")
      });
      res.end();
    }
  }
});

app.post("/api/v1/admin/soap-formats/:formatId/preview", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-preview", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canReadSoapFormats(req.operator)) {
      res.status(403).json({ error: "SOAPフォーマットをプレビューする権限がありません。" });
      return;
    }

    const input = parseJsonBody(previewSoapFormatRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const format = await store.getSoapFormatProfile?.({ orgId, profileId: req.params.formatId });

    if (!format) {
      res.status(404).json({ error: "SOAPフォーマットが見つかりません。" });
      return;
    }

    if (!canEditSoapFormat(req.operator, format)) {
      res.status(403).json({ error: "このSOAPフォーマットをプレビューできません。" });
      return;
    }

    const promptProfile = {
      ...buildPreviewPromptProfile(format, {
        profileId: format.profileId,
        profileVersionId: format.currentDraftVersionId || format.currentVersionId || null,
        promptVersion: format.latestVersion?.version ? `${format.profileId}-preview-v${format.latestVersion.version}` : `${format.profileId}-preview`,
        source: "preview"
      })
    };
    const validation = validateSoapFormatDefinition({
      customization: format.customization,
      outputTemplate: format.outputTemplate,
      sections: format.sections
    });
    const { provider, soap } = await generateSoapFormatPreview({
      input,
      orgId,
      promptProfile
    });

    res.json({
      provider,
      validation,
      format: serializeSoapFormatForClient(format),
      soap
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/admin/soap-format-assignments", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("admin-soap-format-assign", { limit: 90, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canManageOrganizationSoapFormats(req.operator) && !canManageOwnSoapFormats(req.operator)) {
      res.status(403).json({ error: "プロンプト割当を変更する権限がありません。" });
      return;
    }

    const input = parseJsonBody(assignSoapFormatRequestSchema, req.body);
    const orgId = getAdminTargetOrgId(req);
    const memberId = getMemberIdForOperator(req.operator);

    if (input.targetType === "organization") {
      if (!canManageOrganizationSoapFormats(req.operator)) {
        res.status(403).json({ error: "病院標準プロンプトを変更する権限がありません。" });
        return;
      }

      const organization = await assignAdminSoapFormatToOrganization({
        orgId,
        profileId: input.formatId || null,
        actorId: memberId
      });

      if (!organization) {
        res.status(404).json({ error: "病院またはプロンプトが見つかりません。" });
        return;
      }

      res.json({
        organization: serializeOrganizationForClient(organization)
      });
      return;
    }

    if (!input.memberId) {
      res.status(400).json({ error: "メンバーを選択してください。" });
      return;
    }

    if (!canManageOrganizationSoapFormats(req.operator) && input.memberId !== memberId) {
      res.status(403).json({ error: "他のメンバーのプロンプトを変更する権限がありません。" });
      return;
    }

    if (!canManageOrganizationSoapFormats(req.operator) && input.formatId && input.formatId !== DEFAULT_SOAP_FORMAT_PROFILE.profileId) {
      const format = await store.getSoapFormatProfile?.({
        orgId,
        profileId: input.formatId
      });

      if (!format || !canEditSoapFormat(req.operator, format)) {
        res.status(403).json({ error: "このプロンプトを割り当てる権限がありません。" });
        return;
      }
    }

    if (!canManageOrganizationSoapFormats(req.operator) && !canManageOwnSoapFormats(req.operator)) {
      res.status(403).json({ error: "メンバーのプロンプトを変更する権限がありません。" });
      return;
    }

    const member = await assignAdminSoapFormatToMember({
      orgId,
      memberId: input.memberId,
      profileId: input.formatId || null,
      actorId: memberId
    });

    if (!member) {
      res.status(404).json({ error: "メンバーまたはプロンプトが見つかりません。" });
      return;
    }

    res.json({
      member: serializeMemberForClient(member)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/admin/audit-events", requireOperatorAuth, requireOperatorReadAccess, rateLimit("admin-audit-events", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!canOpenAdminConsole(req.operator)) {
      res.status(403).json({ error: "監査ログを閲覧する権限がありません。" });
      return;
    }

    const events = (await store.listOrganizationAuditEvents?.({
      orgId: getOrgIdForOperator(req.operator),
      limit: 120
    })) || [];

    res.json({ events });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/core/patients", requireOperatorAuth, requireOperatorReadAccess, rateLimit("core-patients", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!platformStore) {
      res.json({ patients: [] });
      return;
    }
    res.json({ patients: await platformStore.listPatients(getOrgIdForOperator(req.operator)) });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/core/facilities", requireOperatorAuth, requireOperatorReadAccess, rateLimit("core-facilities", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!platformStore) {
      res.json({ facilities: [] });
      return;
    }
    res.json({ facilities: await platformStore.listFacilities(getOrgIdForOperator(req.operator)) });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/core/departments", requireOperatorAuth, requireOperatorReadAccess, rateLimit("core-departments", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!platformStore) {
      res.json({ departments: [] });
      return;
    }
    res.json({ departments: await platformStore.listDepartments(getOrgIdForOperator(req.operator)) });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("create-session", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!operatorCanCreateSession(req.operator)) {
      res.status(403).json({ error: forbiddenSessionActionMessage("create") });
      return;
    }

    const input = parseJsonBody(createSessionRequestSchema, req.body);
    const orgId = getOrgIdForOperator(req.operator);
    const memberId = getMemberIdForOperator(req.operator);
    const doctorMemberId = input.doctorMemberId || memberId;
    const [doctorMember, platformDefaults] = await Promise.all([
      store.getMember?.({ orgId, memberId: doctorMemberId }) || null,
      resolvePlatformSessionDefaults(orgId, doctorMemberId)
    ]);
    const coreMetadata = await resolveCoreSessionMetadata(orgId, input);
    if (input.promptProfileId) {
      const selectedPrompt = await findSelectablePromptOption(req.operator, input.promptProfileId);
      if (!selectedPrompt) {
        res.status(403).json({ error: "この診療で利用できる公開済みプロンプトではありません。" });
        return;
      }
    }
    const defaultPromptProfileId =
      input.promptProfileId ||
      platformDefaults.member?.defaultPromptProfileId ||
      platformDefaults.organization?.defaultPromptProfileId ||
      (doctorMemberId === memberId ? req.operator?.defaultPromptProfileId : null) ||
      null;
    const defaultRecordingSource =
      platformDefaults.member?.defaultRecordingSource ||
      doctorMember?.defaultRecordingSource ||
      (doctorMemberId === memberId ? req.operator?.defaultRecordingSource : null);
    const resolvedPromptProfile = await store.resolvePromptProfile?.({
      orgId,
      memberId: doctorMemberId,
      promptProfileId: defaultPromptProfileId
    });
    const created = await store.createSession({
      ...input,
      ...coreMetadata,
      orgId,
      clinicId: orgId,
      createdByMemberId: memberId,
      createdByUserId: memberId,
      doctorMemberId,
      assignedDoctorUserId: doctorMemberId,
      audioSourceType: normalizeRecordingSource(defaultRecordingSource),
      promptProfileId: input.promptProfileId || resolvedPromptProfile?.profileId || null,
      promptProfileSelectedAt: input.promptProfileId ? nowIso() : null,
      promptProfileSelectedByMemberId: input.promptProfileId ? memberId : null,
      promptProfileSelectionSource: input.promptProfileId ? "manual" : "default"
    });
    const pairingUrl = createPairingUrl(created.pairing.pairingId, created.plainToken);

    res.status(201).json({
      sessionId: created.session.sessionId,
      status: created.session.status,
      pairingId: created.pairing.pairingId,
      pairingToken: created.plainToken,
      pairingCode: created.pairing.shortCode,
      pairingUrl,
      expiresAt: created.pairing.expiresAt
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/sessions", requireOperatorAuth, requireOperatorReadAccess, rateLimit("list-sessions", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, 1, { min: 1, max: 9999 });
    const pageSize = parsePositiveInteger(req.query.pageSize, 20, { min: 1, max: 100 });
    const search = normalizeSessionListSearch(req.query.q);
    const statuses = resolveSessionListStatuses(req.query.status);

    if (statuses === null) {
      res.status(400).json({ error: "診療履歴の絞り込み条件が不正です。" });
      return;
    }

    const result = (await store.listSessions?.({
      orgId: getOrgIdForOperator(req.operator),
      memberId: getMemberIdForOperator(req.operator),
      roles: getRolesForOperator(req.operator),
      statuses,
      search,
      page,
      pageSize
    })) || {
      sessions: [],
      page,
      pageSize,
      totalCount: 0,
      totalPages: 0
    };
    const sessions = (result.sessions || []).filter((session) => operatorCanReadSession(req.operator, session));

    res.json({
      sessions: sessions.map(serializeSessionSummary),
      page: result.page || page,
      pageSize: result.pageSize || pageSize,
      totalCount: result.totalCount || 0,
      totalPages: result.totalPages || 0
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.delete("/api/v1/sessions/:sessionId", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("hide-session", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "hide")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("hide") });
      return;
    }

    const hidden = await store.hideSessionForMember(req.params.sessionId, {
      memberId: getMemberIdForOperator(req.operator),
      actorId: getMemberIdForOperator(req.operator)
    });

    res.json({
      ok: true,
      session: serializeSessionSummary(hidden)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/mobile/recorders/register", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("trusted-recorder-register", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    if (!hasOperatorPermission(req.operator, "recording:control_assigned")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const input = parseJsonBody(registerTrustedRecorderRequestSchema, req.body);
    const clinicId = getClinicIdForRecorder(req.operator);
    if (await checkRateLimit("trusted-recorder-register-device", `${clinicId}:${input.deviceId}`, { limit: 30, windowMs: 10 * 60_000 })) {
      res.status(429).json({ error: "録音端末の登録試行が続いています。少し待ってからもう一度お試しください。" });
      return;
    }

    const existingRecorder = await findTrustedRecorderByDeviceId(input.deviceId);

    if (existingRecorder && existingRecorder.clinicId !== clinicId) {
      res.status(409).json({ error: "この録音端末は別の医療機関に登録されています。" });
      return;
    }

    const existingAssignment = getTrustedRecorderAssignment({ clinicId, deviceId: input.deviceId });
    const recorder = await store.registerTrustedRecorder?.({
      orgId: clinicId,
      deviceId: input.deviceId,
      label: input.label || "trusted-recorder",
      actorId: getMemberIdForOperator(req.operator)
    }) || {
      deviceId: input.deviceId,
      clinicId,
      orgId: clinicId,
      label: input.label || "trusted-recorder",
      status: "active",
      lastSeenAt: Date.now()
    };

    trustedRecorderRegistry.set(trustedRecorderKey(clinicId, input.deviceId), recorder);

    res.json({
      deviceId: recorder.deviceId,
      clinicId: recorder.clinicId || recorder.orgId,
      label: recorder.label,
      status: recorder.status || "active",
      assignment: existingAssignment
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get("/api/v1/mobile/recorders/assignment", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("trusted-recorder-assignment", { limit: 240, windowMs: 10 * 60_000 }), async (req, res) => {
  if (!hasOperatorPermission(req.operator, "recording:control_assigned")) {
    res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
    return;
  }

  const deviceId = String(req.query.deviceId || "").trim();

  if (!deviceId) {
    res.status(400).json({ error: "端末IDが必要です。" });
    return;
  }

  const clinicId = getClinicIdForRecorder(req.operator);
  if (await checkRateLimit("trusted-recorder-assignment-device", `${clinicId}:${deviceId}`, { limit: 60, windowMs: 10 * 60_000 })) {
    res.status(429).json({ error: "録音端末の確認が続いています。少し待ってからもう一度お試しください。" });
    return;
  }

  const recorder = await store.touchTrustedRecorder?.({ orgId: clinicId, deviceId }) ||
    trustedRecorderRegistry.get(trustedRecorderKey(clinicId, deviceId));

  if (recorder) {
    recorder.lastSeenAt = Date.now();
    trustedRecorderRegistry.set(trustedRecorderKey(clinicId, deviceId), recorder);
  }

  res.json({
    assignment: recorder ? getTrustedRecorderAssignment({ clinicId, deviceId }) : null
  });
});

app.get("/api/v1/sessions/:sessionId", requireOperatorAuth, requireOperatorReadAccess, async (req, res) => {
  let state = await store.getSessionState(req.params.sessionId);

  if (!state) {
    res.status(404).json({ error: "診療画面が見つかりません。" });
    return;
  }

  if (!operatorCanReadSession(req.operator, state.session)) {
    res.status(403).json({ error: forbiddenSessionActionMessage("read") });
    return;
  }

  state = await recoverStaleFinalizingSession(req.params.sessionId, state, {
    reason: "session_read"
  });

  const promptProfile = await store.resolvePromptProfile?.({
    orgId: state.session.orgId || state.session.clinicId,
    memberId: state.session.doctorMemberId || state.session.assignedDoctorUserId || state.session.createdByMemberId || state.session.createdByUserId,
    promptProfileId: state.session.promptProfileId
  });

  res.json({
    ...state,
    promptProfile: serializePromptProfileForSession(promptProfile)
  });
});

app.get("/api/v1/sessions/:sessionId/prompt-options", requireOperatorAuth, requireOperatorReadAccess, rateLimit("session-prompt-options", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanReadSession(req.operator, state.session)) {
      res.status(403).json({ error: forbiddenSessionActionMessage("read") });
      return;
    }

    const promptProfile = await store.resolvePromptProfile?.({
      orgId: state.session.orgId || state.session.clinicId,
      memberId: state.session.doctorMemberId || state.session.assignedDoctorUserId || state.session.createdByMemberId || state.session.createdByUserId,
      promptProfileId: state.session.promptProfileId
    });
    const options = await listSelectablePromptOptions(req.operator);

    res.json({
      selectedPromptProfileId: promptProfile?.profileId || state.session.promptProfileId || DEFAULT_SOAP_FORMAT_PROFILE.profileId,
      promptProfile: serializePromptProfileForSession(promptProfile),
      options
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/prompt-profile", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("session-prompt-profile", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(updateSessionPromptProfileRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "selectPrompt")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("selectPrompt") });
      return;
    }

    if (!["ready", "paired", "degraded_recording", "stopped"].includes(state.session.status) || state.latestSoap || state.session.latestSoapVersionId) {
      res.status(409).json({ error: "録音中またはSOAP下書き作成後はプロンプトを変更できません。" });
      return;
    }

    const selectedPrompt = await findSelectablePromptOption(req.operator, input.promptProfileId);
    if (!selectedPrompt) {
      res.status(403).json({ error: "この診療で利用できる公開済みプロンプトではありません。" });
      return;
    }

    const updatedSession = await store.updateSessionPromptProfile(req.params.sessionId, {
      promptProfileId: selectedPrompt.profileId || selectedPrompt.formatId,
      actorId: getMemberIdForOperator(req.operator)
    });
    const promptProfile = await store.resolvePromptProfile?.({
      orgId: updatedSession.orgId || updatedSession.clinicId,
      memberId: updatedSession.doctorMemberId || updatedSession.assignedDoctorUserId || updatedSession.createdByMemberId || updatedSession.createdByUserId,
      promptProfileId: updatedSession.promptProfileId
    });

    await emitSessionState(req.params.sessionId);

    res.json({
      session: updatedSession,
      promptProfile: serializePromptProfileForSession(promptProfile)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/metadata", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("session-metadata", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(updateSessionMetadataRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "updateMetadata")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("updateMetadata") });
      return;
    }

    if (state.session.status === "finalizing") {
      res.status(409).json({ error: "SOAP下書き作成中は患者情報を編集できません。" });
      return;
    }

    const coreMetadata = await resolveCoreSessionMetadata(
      state.session.orgId || state.session.clinicId || getOrgIdForOperator(req.operator),
      input,
      state.session
    );
    const updatedSession = await store.updateSession(req.params.sessionId, {
      ...coreMetadata
    });

    await store.appendAuditEvent(req.params.sessionId, {
      type: "session.metadata.updated",
      actorType: "user",
      actorId: getMemberIdForOperator(req.operator),
      safePayload: {
        patientIdSet: Boolean(coreMetadata.patientId),
        facilityIdSet: Boolean(coreMetadata.facilityId),
        departmentIdSet: Boolean(coreMetadata.departmentId),
        patientDisplayNameSet: Boolean(coreMetadata.patientDisplayName),
        visitReasonSet: Boolean(coreMetadata.visitReason)
      }
    });

    res.json({
      session: updatedSession
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/pairings", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("refresh-pairing", { limit: 20, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const refreshed = await store.refreshPairing(req.params.sessionId);
    const pairingUrl = createPairingUrl(refreshed.pairing.pairingId, refreshed.plainToken);

    res.json({
      pairingId: refreshed.pairing.pairingId,
      pairingToken: refreshed.plainToken,
      pairingCode: refreshed.pairing.shortCode,
      pairingUrl,
      expiresAt: refreshed.pairing.expiresAt
    });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post("/api/v1/sessions/:sessionId/assign-recorder", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("assign-recorder", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(assignTrustedRecorderRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const clinicId = state.session.orgId || state.session.clinicId;
    const candidates = input.deviceId
      ? (await listActiveTrustedRecorders({ clinicId })).filter((recorder) => recorder.deviceId === input.deviceId)
      : await listActiveTrustedRecorders({ clinicId });

    if (candidates.length === 0) {
      res.status(404).json({ error: "待機中のスマホが見つかりません。" });
      return;
    }

    if (!input.deviceId && candidates.length > 1) {
      res.status(409).json({ error: "待機中のスマホが複数あります。対象の端末を選んでください。" });
      return;
    }

    const recorder = candidates[0];
    const refreshed = await store.refreshPairing(req.params.sessionId);
    const streamToken = signStreamToken(
      {
        sessionId: req.params.sessionId,
        deviceId: recorder.deviceId,
        orgId: clinicId,
        clinicId,
        pairingId: refreshed.pairing.pairingId,
        exp: Date.now() + 15 * 60 * 1000
      },
      config.pairingSigningSecret
    );
    const assignment = {
      sessionId: req.params.sessionId,
      orgId: clinicId,
      clinicId,
      deviceId: recorder.deviceId,
      pairingId: refreshed.pairing.pairingId,
      pairingToken: refreshed.plainToken,
      pairingUrl: createPairingUrl(refreshed.pairing.pairingId, refreshed.plainToken),
      wsUrl: getPublicWsUrl(req),
      streamToken,
      assignedAt: nowIso(),
      expiresAt: new Date(Date.now() + TRUSTED_RECORDER_ASSIGNMENT_TTL_MS).toISOString()
    };

    trustedRecorderAssignments.set(trustedRecorderKey(clinicId, recorder.deviceId), assignment);

    await store.updateSession(req.params.sessionId, {
      status: state.session.status === "ready" ? "paired" : state.session.status
    });
    await store.appendAuditEvent(req.params.sessionId, {
      type: "trusted_recorder.assigned",
      actorType: "user",
      actorId: getMemberIdForOperator(req.operator),
      safePayload: {
        deviceId: recorder.deviceId
      }
    });
    await emitSessionState(req.params.sessionId);

    res.json({
      deviceId: recorder.deviceId,
      assignment
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/recording/source", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("recording-source", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(selectRecordingSourceRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    if (!["ready", "paired", "degraded_recording"].includes(state.session.status)) {
      res.status(409).json({ error: "録音方法を変更できる状態ではありません。" });
      return;
    }

    if ((state.turns || []).length > 0 || state.latestSoap) {
      res.status(409).json({ error: "録音済みの内容があるため、録音方法を変更できません。録り直す場合は録音を破棄してください。" });
      return;
    }

    const now = nowIso();
    const patch = input.source === "local_browser"
      ? {
          audioSourceType: "local_browser",
          audioConnectionState: "disconnected",
          audioDeviceId: null,
          audioDeviceLabel: null,
          updatedAt: now
        }
      : {
          audioSourceType: "linked_mobile",
          audioConnectionState: state.session.mobileConnectionState === "mic_ready"
            ? "mic_ready"
            : state.session.mobileConnectionState === "connected"
              ? "connected"
              : "disconnected",
          audioDeviceId: state.session.mobileConnectionState === "disconnected" ? null : state.session.audioDeviceId || null,
          audioDeviceLabel: state.session.mobileConnectionState === "disconnected" ? null : state.session.audioDeviceLabel || "録音用スマホ",
          updatedAt: now
        };

    const session = await store.updateSession(req.params.sessionId, patch);
    await store.appendAuditEvent(req.params.sessionId, {
      type: "recording.source_selected",
      actorType: "user",
      actorId: getMemberIdForOperator(req.operator),
      safePayload: {
        source: input.source
      }
    });
    await emitSessionState(req.params.sessionId);

    res.json({ session });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/recording/start", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("recording-start", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(startRecordingRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const session = await startRecordingSession(req.params.sessionId, {
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel,
      source: input.source,
      assumeMicReady: input.source === "local_browser",
      request: req
    });
    res.json(session);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/mobile/sessions/:sessionId/recording/start", requireMobileStreamAuth, rateLimit("recording-start-mobile", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(startRecordingRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (input.deviceId !== req.mobile.deviceId) {
      res.status(403).json({ error: "このスマホでは操作できません。接続し直してください。" });
      return;
    }

    const organization = await resolveSessionOrganizationForClinicalUse(state.session);

    if (!organizationCanUseClinicalFeatures(organization)) {
      res.status(403).json({
        error: organizationAccessDeniedMessage(organization, {
          mode: "clinical"
        }) || "この操作は現在利用できません。"
      });
      return;
    }

    const session = await startRecordingSession(req.params.sessionId, {
      deviceId: req.mobile.deviceId,
      source: "linked_mobile",
      assumeMicReady: true,
      request: req
    });

    res.json(session);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/mobile/sessions/:sessionId/recording/stop", requireMobileStreamAuth, rateLimit("recording-stop-mobile", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(stopRecordingRequestSchema, req.body);
    if (!input.deviceId || input.deviceId !== req.mobile.deviceId) {
      res.status(403).json({ error: "このスマホでは操作できません。接続し直してください。" });
      return;
    }

    const state = await store.getSessionState(req.params.sessionId);
    if (state?.session?.audioDeviceId && state.session.audioDeviceId !== req.mobile.deviceId) {
      res.status(403).json({ error: "このスマホでは操作できません。接続し直してください。" });
      return;
    }

    const session = await stopRecordingSession(req.params.sessionId, {
      actorType: "device",
      actorId: req.mobile.deviceId,
      stopReason: "manual"
    });
    res.json(session);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/recording/stop", requireOperatorAuth, rateLimit("recording-stop", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    parseJsonBody(stopRecordingRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const session = await stopRecordingSession(req.params.sessionId, {
      actorType: "user",
      actorId: getMemberIdForOperator(req.operator),
      stopReason: "manual"
    });
    res.json(session);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/recording/discard", requireOperatorAuth, rateLimit("recording-discard", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    parseJsonBody(discardRecordingRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "controlRecording")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("controlRecording") });
      return;
    }

    const session = await discardRecordingSession(req.params.sessionId, {
      actorId: getMemberIdForOperator(req.operator)
    });

    res.json({ session });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/generate-soap", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("generate-soap", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "generateSoap")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("generateSoap") });
      return;
    }

    const session = await startSoapGeneration(req.params.sessionId, {
      actorId: getMemberIdForOperator(req.operator)
    });
    res.json(session);
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/regenerate-soap", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("regenerate-soap", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(regenerateSoapRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "generateSoap")) {
      warnSessionActionForbidden("generateSoap", req.operator, state.session, {
        reason: "regenerate_session_action_forbidden"
      });
      res.status(403).json({ error: forbiddenSessionActionMessage("generateSoap") });
      return;
    }

    const selectedPrompt = await findSelectablePromptOption(req.operator, input.promptProfileId);
    if (!selectedPrompt) {
      console.warn("generateSoap forbidden", {
        reason: "regenerate_prompt_not_selectable",
        sessionId: state.session.sessionId || req.params.sessionId,
        sessionStatus: state.session.status || null,
        actorId: getMemberIdForOperator(req.operator),
        operatorOrgId: getOrgIdForOperator(req.operator),
        promptProfileId: input.promptProfileId
      });
      res.status(403).json({ error: "この診療で利用できる公開済みプロンプトではありません。" });
      return;
    }

    const session = await startSoapRegeneration(req.params.sessionId, {
      actorId: getMemberIdForOperator(req.operator),
      promptProfileId: selectedPrompt.profileId || selectedPrompt.formatId
    });
    const promptProfile = await store.resolvePromptProfile?.({
      orgId: session.orgId || session.clinicId,
      memberId: session.doctorMemberId || session.assignedDoctorUserId || session.createdByMemberId || session.createdByUserId,
      promptProfileId: session.promptProfileId
    });
    res.json({
      session,
      promptProfile: serializePromptProfileForSession(promptProfile)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/review-note", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("review-note", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(saveReviewedNoteRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "editSoap")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("editSoap") });
      return;
    }

    if (!state.latestSoap) {
      res.status(409).json({ error: "診療記録の下書きがまだありません。" });
      return;
    }

    if (state.session.status === "finalizing") {
      res.status(409).json({ error: "SOAP下書き作成中は編集できません。" });
      return;
    }

    const now = nowIso();
    const previousSoap = state.latestSoap;
    const previousStructuredJson = previousSoap.structuredJson || {};
    const memberId = getMemberIdForOperator(req.operator);
    const wasApproved = state.session.status === "approved" || state.latestSoap.status === "approved";
    const previousOutputText = previousSoap.outputText || previousSoap.output_text || previousStructuredJson.outputText || buildLegacySoapOutputText(previousSoap);
    const savedSoap = await store.saveSoapVersion(req.params.sessionId, {
      outputText: input.outputText,
      structuredJson: {
        ...previousStructuredJson,
        provenance: "manual_review",
        outputText: input.outputText,
        finalTranscript: input.transcript,
        rawFinalTranscript:
          previousStructuredJson.rawFinalTranscript ||
          previousStructuredJson.finalTranscript ||
          input.transcript,
        manualReview: {
          editedBy: memberId,
          editedAt: now,
          transcriptEdited: input.transcript !== (previousStructuredJson.finalTranscript || ""),
          soapEdited: input.outputText !== previousOutputText
        }
      },
      status: "ready",
      model: "manual-review",
      promptVersion: `${previousSoap.promptVersion || "soap-v3"}+manual-review`,
      templateKey: previousSoap.templateKey || null,
      promptProfileId: previousSoap.promptProfileId || null,
      promptProfileVersionId: previousSoap.promptProfileVersionId || null,
      resolvedPromptHash: previousSoap.resolvedPromptHash || null,
      inputTranscriptRevision: `manual-${now}`,
      createdBy: memberId,
      approvedByUserId: null
    });

    await store.updateSession(req.params.sessionId, {
      status: "soap_ready",
      soapProvider: "manual_review",
      approvedAt: null,
      updatedAt: now
    });

    if (wasApproved) {
      await store.appendAuditEvent(req.params.sessionId, {
        type: "review_note.reopened",
        actorType: "user",
        actorId: memberId,
        safePayload: {
          previousVersionId: previousSoap.versionId,
          versionId: savedSoap.versionId
        }
      });

      await emitSessionState(req.params.sessionId);
    }

    await store.appendAuditEvent(req.params.sessionId, {
      type: "review_note.saved",
      actorType: "user",
      actorId: memberId,
      safePayload: {
        versionId: savedSoap.versionId
      }
    });

    const serializedSoap = serializeSoapForClient(savedSoap);

    broadcast(
      req.params.sessionId,
      {
        type: "transcript.corrected",
        sessionId: req.params.sessionId,
        text: serializedSoap.structuredJson.finalTranscript,
        versionId: savedSoap.versionId,
        updatedAt: serializedSoap.updatedAt
      },
      ["pc"]
    );

    broadcast(
      req.params.sessionId,
      {
        type: "soap.ready",
        sessionId: req.params.sessionId,
        versionId: savedSoap.versionId,
        soap: serializedSoap
      },
      ["pc"]
    );

    res.json({
      session: {
        ...state.session,
        status: "soap_ready",
        approvedAt: null,
        updatedAt: now
      },
      latestSoap: serializedSoap
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/sessions/:sessionId/approve-note", requireOperatorAuth, requireOperatorClinicalAccess, rateLimit("approve-note", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const input = parseJsonBody(approveReviewedNoteRequestSchema, req.body);
    const state = await store.getSessionState(req.params.sessionId);

    if (!state) {
      res.status(404).json({ error: "診療画面が見つかりません。" });
      return;
    }

    if (!operatorCanPerformSessionAction(req.operator, state.session, "approveSoap")) {
      res.status(403).json({ error: forbiddenSessionActionMessage("approveSoap") });
      return;
    }

    if (!state.latestSoap) {
      res.status(409).json({ error: "診療記録の下書きがまだありません。" });
      return;
    }

    if (state.session.status === "finalizing") {
      res.status(409).json({ error: "SOAP下書き作成中は確定できません。" });
      return;
    }

    if (state.session.soapProvider === "mock" || state.latestSoap.structuredJson?.provenance === "mock") {
      res.status(409).json({ error: "確認用の仮SOAP下書きは確定できません。SOAP下書きを作成し直してください。" });
      return;
    }

    const approved = await store.approveSoapVersion(req.params.sessionId, {
      versionId: input.versionId || state.latestSoap.versionId,
      approvedByUserId: getMemberIdForOperator(req.operator)
    });

    await store.appendAuditEvent(req.params.sessionId, {
      type: "review_note.approved",
      actorType: "user",
      actorId: getMemberIdForOperator(req.operator),
      safePayload: {
        versionId: approved.soap.versionId
      }
    });

    await emitSessionState(req.params.sessionId);

    res.json({
      session: approved.session,
      latestSoap: serializeSoapForClient(approved.soap)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/audio-tests/:testId/claim", rateLimit("audio-test-claim", { limit: 60, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const origin = req.get("origin");
    if (config.isProduction && (!origin || !config.allowedOrigins.has(origin))) {
      res.status(403).json({ error: "このアクセス元からは接続できません。" });
      return;
    }

    const input = parseJsonBody(claimAudioTestRequestSchema, req.body);
    const audioTest = await store.claimAudioTest?.(req.params.testId, input);

    if (!audioTest) {
      res.status(410).json({ error: "音声テストが無効か、有効期限切れです。PC で QR を再発行してください。" });
      return;
    }

    res.json({
      audioTest: serializeAudioTestForClient(audioTest)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/audio-tests/:testId/state", rateLimit("audio-test-state", { limit: 900, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const origin = req.get("origin");
    if (config.isProduction && (!origin || !config.allowedOrigins.has(origin))) {
      res.status(403).json({ error: "このアクセス元からは接続できません。" });
      return;
    }

    const input = parseJsonBody(updateAudioTestStateRequestSchema, req.body);
    const audioTest = await store.updateAudioTestState?.(req.params.testId, input);

    if (!audioTest) {
      res.status(410).json({ error: "音声テストが無効か、有効期限切れです。PC で QR を再発行してください。" });
      return;
    }

    res.json({
      audioTest: serializeAudioTestForClient(audioTest)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/audio-tests/:testId/complete", rateLimit("audio-test-complete", { limit: 120, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const origin = req.get("origin");
    if (config.isProduction && (!origin || !config.allowedOrigins.has(origin))) {
      res.status(403).json({ error: "このアクセス元からは接続できません。" });
      return;
    }

    const input = parseJsonBody(completeAudioTestRequestSchema, req.body);
    const audioTest = await store.completeAudioTest?.(req.params.testId, input);

    if (!audioTest) {
      res.status(410).json({ error: "音声テストが無効か、すでに終了しています。" });
      return;
    }

    res.json({
      audioTest: serializeAudioTestForClient(audioTest)
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post("/api/v1/pairings/:pairingId/claim", rateLimit("pairing-claim", { limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  try {
    const origin = req.get("origin");
    if (config.isProduction && (!origin || !config.allowedOrigins.has(origin))) {
      res.status(403).json({ error: "このアクセス元からは接続できません。" });
      return;
    }

    const input = parseJsonBody(claimPairingRequestSchema, req.body);
    const hasOperatorSession = Boolean(extractOperatorCookieToken(req)) || (config.allowOperatorBearerAuth && Boolean(extractBearerToken(req)));
    const operatorPayload = await hydrateOperatorPayload(resolveOperatorPayload(req));

    if (hasOperatorSession && !operatorPayload) {
      res.status(401).json({
        error: "ログインの有効期限が切れました。もう一度ログインしてください。"
      });
      return;
    }

    if (operatorPayload && !operatorCanAuthenticateForAccess(operatorPayload)) {
      res.status(403).json({
        error: operatorAccessDeniedMessage(operatorPayload, "login")
      });
      return;
    }

    const claimed = await store.claimPairing(req.params.pairingId, {
      ...input,
      orgId: operatorPayload ? getOrgIdForOperator(operatorPayload) : null
    });

    if (!claimed) {
      res.status(410).json({ error: "接続情報が無効か、有効期限が切れています。パソコンから接続し直してください。" });
      return;
    }

    const streamToken = signStreamToken(
      {
        sessionId: claimed.session.sessionId,
        deviceId: input.deviceId,
        orgId: claimed.session.orgId || claimed.session.clinicId,
        clinicId: claimed.session.clinicId || claimed.session.orgId,
        pairingId: req.params.pairingId,
        exp: Date.now() + 15 * 60 * 1000
      },
      config.pairingSigningSecret
    );

    await emitSessionState(claimed.session.sessionId);

    res.json({
      sessionId: claimed.session.sessionId,
      orgId: claimed.session.orgId || claimed.session.clinicId,
      clinicId: claimed.session.clinicId || claimed.session.orgId,
      status: claimed.session.status,
      patientDisplayName: claimed.session.patientDisplayName,
      visitReason: claimed.session.visitReason,
      wsUrl: getPublicWsUrl(req),
      streamToken
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  const origin = request.headers.origin;
  if ((config.isProduction && !origin) || (origin && !config.allowedOrigins.has(origin))) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  ws.meta = null;
  ws.operatorCookiePayload = verifyOperatorToken(extractOperatorCookieTokenFromHeader(request.headers.cookie || ""));

  ws.on("message", async (raw, isBinary) => {
    try {
      if (isBinary) {
        if (!ws.meta || !isAudioRole(ws.meta.role)) {
          return;
        }

        const state = await store.getSessionState(ws.meta.sessionId);

        if (!state || state.session.status !== "recording") {
          return;
        }

        if (isRecordingPastExpiry(state.session)) {
          await autoStopRecordingSession(ws.meta.sessionId, {
            expectedRecordingExpiresAt: state.session.recordingExpiresAt || null,
            trigger: "audio_frame"
          });
          return;
        }

        if (state.session.audioSourceType && state.session.audioSourceType !== audioSourceTypeForRole(ws.meta.role)) {
          return;
        }

        if (!trackAudioBytes(ws, raw.length || raw.byteLength || 0)) {
          sendJson(ws, {
            type: "error",
            code: "AUDIO_RATE_LIMITED",
            message: "音声データの送信量が上限を超えました。録音をやり直してください。"
          });
          ws.close();
          return;
        }

        const audioFrameReceivedAt = Date.now();

        if (!ws.meta.firstAudioFrameReceivedAt) {
          ws.meta.firstAudioFrameReceivedAt = audioFrameReceivedAt;
          ws.meta.lastAudioActivityBroadcastAt = audioFrameReceivedAt;
          const receivedAt = new Date(ws.meta.firstAudioFrameReceivedAt).toISOString();
          await store.appendAuditEvent(ws.meta.sessionId, {
            type: "audio.first_frame_received",
            actorType: "device",
            actorId: ws.meta.deviceId,
            safePayload: {
              pairingId: ws.meta.pairingId
            }
          });
          broadcast(
            ws.meta.sessionId,
            {
              type: "audio.first_frame_received",
              sessionId: ws.meta.sessionId,
              audioSourceType: audioSourceTypeForRole(ws.meta.role),
              receivedAt
            },
            ["pc"]
          );
        }

        maybeBroadcastAudioActivity(ws, audioFrameReceivedAt);

        await liveStt.consumeAudioFrame(ws.meta.sessionId, raw);
        appendFinalTranscriptSegmentAudio(ws.meta.sessionId, raw, {
          sessionContext: state.session
        });

        return;
      }

      const message = JSON.parse(raw.toString("utf8"));

      if (message.type === "pong") {
        return;
      }

      if (message.type === "audio.metadata") {
        if (isAudioRole(ws.meta?.role)) {
          await liveStt.setSessionMetadata(ws.meta.sessionId, message);
          updateFinalTranscriptSegmentMetadata(ws.meta.sessionId, message);
        }
        return;
      }

      if (message.type === "mic.ready") {
        if (isAudioRole(ws.meta?.role)) {
          const state = await store.getSessionState(ws.meta.sessionId);
          const sourceType = audioSourceTypeForRole(ws.meta.role);

          if (state) {
            if (
              state.session.audioSourceType &&
              state.session.audioSourceType !== sourceType
            ) {
              await emitSessionState(ws.meta.sessionId);
              return;
            }

            const isRecording = state.session.status === "recording";
            const patch = {
              audioSourceType: state.session.audioSourceType || sourceType,
              audioConnectionState: isRecording ? "recording" : "mic_ready",
              audioDeviceId: ws.meta.deviceId,
              audioDeviceLabel: sourceType === "local_browser" ? "この端末のマイク" : "録音用スマホ"
            };

            if (sourceType === "linked_mobile") {
              patch.mobileConnectionState = isRecording ? "recording" : "mic_ready";
            }

            await store.updateSession(ws.meta.sessionId, {
              ...patch
            });
            await store.appendAuditEvent(ws.meta.sessionId, {
              type: "audio.mic_ready",
              actorType: "device",
              actorId: ws.meta.deviceId,
              safePayload: {
                pairingId: ws.meta.pairingId
              }
            });
            await emitSessionState(ws.meta.sessionId);
          }
        }
        return;
      }

      if (message.type === "mic.disabled") {
        if (isAudioRole(ws.meta?.role)) {
          const state = await store.getSessionState(ws.meta.sessionId);

          if (state && state.session.status !== "recording") {
            await store.updateSession(ws.meta.sessionId, {
              mobileConnectionState: "connected",
              audioConnectionState: "connected"
            });
            await emitSessionState(ws.meta.sessionId);
          }
        }
        return;
      }

      const hello = authHelloSchema.parse(message);
      const bucket = getSocketBucket(hello.sessionId);
      let operatorPayload = null;
      let streamPayload = null;

      if (hello.role === "pc" || hello.role === "recorder") {
        const rawOperatorPayload = hello.token === COOKIE_OPERATOR_SESSION_TOKEN
          ? ws.operatorCookiePayload
          : (config.allowOperatorBearerAuth ? verifyOperatorToken(hello.token) : null);
        operatorPayload = await hydrateOperatorPayload(rawOperatorPayload);

        if (!operatorPayload) {
          sendJson(ws, {
            type: "error",
            code: "UNAUTHORIZED",
            message: "ログインの有効期限が切れました。もう一度ログインしてください。"
          });
          ws.close();
          return;
        }

        if (!operatorCanAuthenticateForAccess(operatorPayload)) {
          sendJson(ws, {
            type: "error",
            code: "ACCESS_DENIED",
            message: operatorAccessDeniedMessage(operatorPayload, "login")
          });
          ws.close();
          return;
        }

        if (hello.role === "recorder" && !operatorCanUseClinicalFeatures(operatorPayload)) {
          sendJson(ws, {
            type: "error",
            code: "CLINICAL_ACCESS_REQUIRED",
            message: operatorAccessDeniedMessage(operatorPayload, "clinical")
          });
          ws.close();
          return;
        }
      }

      if (hello.role === "recorder" && !hello.deviceId) {
        sendJson(ws, {
          type: "error",
          code: "RECORDER_DEVICE_REQUIRED",
          message: "録音端末IDが必要です。"
        });
        ws.close();
        return;
      }

      if (hello.role === "mobile") {
        streamPayload = verifyStreamToken(hello.token, config.pairingSigningSecret);

        if (
          !streamPayload ||
          streamPayload.sessionId !== hello.sessionId ||
          streamPayload.deviceId !== hello.deviceId ||
          streamPayload.pairingId !== hello.pairingId
        ) {
          sendJson(ws, {
            type: "error",
            code: "INVALID_STREAM_TOKEN",
            message: "スマホの接続情報が無効です。パソコンから接続し直してください。"
          });
          ws.close();
          return;
        }
      }

      const stateBeforeAuth = await store.getSessionState(hello.sessionId);

      if (!stateBeforeAuth) {
        sendJson(ws, {
          type: "error",
          code: "SESSION_NOT_FOUND",
          message: "診療画面が見つかりません。"
        });
        ws.close();
        return;
      }

      const canOpenSocket = hello.role === "pc"
        ? operatorCanReadSession(operatorPayload, stateBeforeAuth.session)
        : hello.role === "recorder"
          ? operatorCanPerformSessionAction(operatorPayload, stateBeforeAuth.session, "controlRecording")
          : true;

      if (!canOpenSocket) {
        sendJson(ws, {
          type: "error",
          code: "FORBIDDEN",
          message: hello.role === "recorder" ? forbiddenSessionActionMessage("controlRecording") : forbiddenSessionActionMessage("read")
        });
        ws.close();
        return;
      }

      if (
        hello.role === "mobile" &&
        streamPayload?.orgId &&
        stateBeforeAuth.session.orgId !== streamPayload.orgId &&
        stateBeforeAuth.session.clinicId !== streamPayload.orgId
      ) {
        sendJson(ws, {
          type: "error",
          code: "FORBIDDEN",
          message: "この医療機関の診療画面ではありません。"
        });
        ws.close();
        return;
      }

      ws.meta = {
        role: hello.role,
        sessionId: hello.sessionId,
        deviceId: hello.deviceId || null,
        pairingId: hello.pairingId || null,
        orgId: streamPayload?.orgId || streamPayload?.clinicId || operatorPayload?.orgId || null,
        firstAudioFrameReceivedAt: null,
        lastAudioActivityBroadcastAt: 0,
        audioRateWindow: null
      };

      bucket[hello.role].add(ws);

      if (hello.role === "mobile" && hello.deviceId) {
        deleteTrustedRecorderAssignmentsForDevice(hello.deviceId, streamPayload?.orgId || streamPayload?.clinicId || null);
      }

      const state = await store.getSessionState(hello.sessionId);
      if (state) {
        if (hello.role === "pc") {
          await store.updateSession(hello.sessionId, {
            pcConnectionCount: state.session.pcConnectionCount + 1
          });
        }

        sendJson(ws, {
          type: "auth.ok",
          sessionId: hello.sessionId,
          connectionId: `${hello.role}-${Date.now()}`
        });

        sendJson(ws, {
          type: "session.state.updated",
          sessionId: hello.sessionId,
          status: state.session.status,
          mobileConnectionState: state.session.mobileConnectionState,
          audioSourceType: state.session.audioSourceType || null,
          audioConnectionState: state.session.audioConnectionState || state.session.mobileConnectionState,
          audioDeviceId: state.session.audioDeviceId || null,
          audioDeviceLabel: state.session.audioDeviceLabel || null,
          recordingMaxDurationMinutes: normalizeRecordingMaxDurationMinutes(state.session.recordingMaxDurationMinutes),
          recordingExpiresAt: state.session.recordingExpiresAt || null,
          recordingStopReason: state.session.recordingStopReason || null,
          updatedAt: state.session.updatedAt
        });
      }
    } catch (error) {
      console.warn("bad websocket message", safeErrorLogFields(error, {
        reason: "bad_ws_message"
      }));
      sendJson(ws, {
        type: "error",
        code: "BAD_WS_MESSAGE",
        message: "接続メッセージを処理できませんでした。画面を更新して接続し直してください。"
      });
    }
  });

  ws.on("close", async () => {
    if (!ws.meta) {
      return;
    }

    const bucket = getSocketBucket(ws.meta.sessionId);
    bucket[ws.meta.role].delete(ws);

    if (ws.meta.role === "pc") {
      const state = await store.getSessionState(ws.meta.sessionId);
      if (state) {
        await store.updateSession(ws.meta.sessionId, {
          pcConnectionCount: Math.max(0, state.session.pcConnectionCount - 1)
        });
      }
      return;
    }

    const state = await store.getSessionState(ws.meta.sessionId);
    if (state) {
      const sourceType = audioSourceTypeForRole(ws.meta.role);
      const isActiveAudioSource = !state.session.audioSourceType || state.session.audioSourceType === sourceType;

      if (!isActiveAudioSource) {
        return;
      }

      if (state.session.status === "recording") {
        await store.appendAuditEvent(ws.meta.sessionId, {
          type: "recording.degraded",
          actorType: "system",
          actorId: "gateway",
          safePayload: {
            reason: ws.meta.firstAudioFrameReceivedAt ? "mobile_disconnected_mid_recording" : "mobile_disconnected_before_audio"
          }
        });
      }

      await liveStt.reset(ws.meta.sessionId);
      await store.updateSession(ws.meta.sessionId, {
        mobileConnectionState: "disconnected",
        audioConnectionState: "disconnected",
        status: state.session.status === "recording" ? "degraded_recording" : state.session.status
      });
      await emitSessionState(ws.meta.sessionId);
    }
  });
});

setInterval(() => {
  for (const bucket of socketIndex.values()) {
    for (const role of ["pc", "mobile", "recorder"]) {
      for (const ws of bucket[role]) {
        sendJson(ws, {
          type: "ping",
          at: nowIso()
        });
      }
    }
  }
}, 25_000).unref();

setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of rateLimitBuckets.entries()) {
    if (now >= entry.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }

  for (const [key, recorder] of trustedRecorderRegistry.entries()) {
    if (now - recorder.lastSeenAt > TRUSTED_RECORDER_STALE_MS) {
      trustedRecorderRegistry.delete(key);
      trustedRecorderAssignments.delete(key);
    }
  }

  for (const [sessionId, entry] of pendingFinalizeAudio.entries()) {
    if (entry.expiresAt <= now) {
      pendingFinalizeAudio.delete(sessionId);
      void appendAuditEventSafe(sessionId, {
        type: "audio.pending_finalize.expired",
        actorType: "system",
        actorId: "gateway",
        safePayload: {
          ttlMs: config.pendingFinalizeAudioTtlMs,
          failedAt: entry.failedAt ? new Date(entry.failedAt).toISOString() : null
        }
      });
    }
  }

}, 60_000).unref();

if (process.env.CHARTING_GATEWAY_AUTOSTART !== "false") {
  server.listen(config.port, () => {
    console.log(`medical-gateway listening on :${config.port}`);
  });
}

export {
  app,
  server
};

export const __testHooks = {
  store,
  platformStore,
  buildOperatorSessionTokenFromPayload,
  clearOperatorContextCache,
  getOperatorContextCacheSize: () => operatorContextCache.size
};
