import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  forbiddenError,
  hasProductAccess,
  publicAuthErrorCode,
  requirePlatformCsrf,
  requireProductEnabled,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  validateCareFeeEpisodeDecisionInput,
  validateCareFeeEpisodeRowsInput,
  validateCareFeeEvidenceEventInput,
  validateCareFeeFacilitySettingsInput,
  validateMonthlyCareFeeRunInput
} from "../../../packages/care-fee-contracts/src/index.js";
import {
  CARE_EMERGENCY_RULE_VERSION,
  evaluateEmergencyTreatmentBatch,
  loadDefaultEmergencyTreatmentMaster,
  sha256Hex
} from "../../../packages/care-fee-core/src/index.js";
import { evaluateCareEmergencyCsv } from "../../../packages/care-fee-core/src/csv-pipeline.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import {
  buildCareFeeEpisodeDocuments,
  careFeeMonthlyRevisionHash,
  stableId
} from "./episode-documents.js";
import { createCareFeeStoreFromEnv } from "./store/create-store.js";

const PRODUCT_ID = "care_fee";
const READ_ROLES = ["admin", "doctor", "nurse", "medical_clerk", "viewer"];
const WRITE_ROLES = ["admin", "doctor", "nurse", "medical_clerk"];
const DECIDE_ROLES = ["admin", "doctor", "medical_clerk"];
const DEFAULT_MAX_CSV_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMPORT_RETENTION_DAYS = 30;

export function createCareFeeApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.CARE_FEE_GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "halunasu-care-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const platformStore = options.platformStore || createPlatformStoreFromEnv();
  const careFeeStore = options.careFeeStore || createCareFeeStoreFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req, maxJsonBytes(options));
      const response = await handleCareFeeApiRequest({
        method: req.method,
        path: req.url,
        body,
        headers: req.headers,
        env,
        projectId,
        region,
        startedAt,
        platformStore,
        careFeeStore,
        now: options.now,
        sessionSecret: options.sessionSecret,
        ingestToken: options.ingestToken,
        monthlyWorkerToken: options.monthlyWorkerToken,
        processEnv: options.processEnv,
        maxCsvBytes: options.maxCsvBytes,
        importRetentionDays: options.importRetentionDays
      });
      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export async function handleCareFeeApiRequest(input = {}) {
  try {
    return withCors(input, await routeCareFeeApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routeCareFeeApiRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const platformStore = input.platformStore || createPlatformStoreFromEnv();
  const careFeeStore = input.careFeeStore || createCareFeeStoreFromEnv();

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "care-fee-api" });
  }
  if (method === "GET" && url.pathname === "/readyz") {
    const master = loadDefaultEmergencyTreatmentMaster();
    return ok({
      status: "ok",
      service: "care-fee-api",
      env: input.env || "local",
      projectId: input.projectId || "halunasu-care-stg",
      region: input.region || "asia-northeast1",
      ruleVersion: CARE_EMERGENCY_RULE_VERSION,
      masterVersion: master.masterVersion,
      structuredCsvOpenAiCalls: 0,
      automation: monthlyAutomationReadiness(input),
      startedAt: input.startedAt instanceof Date ? input.startedAt.toISOString() : new Date().toISOString()
    });
  }
  if (method === "OPTIONS" && url.pathname.startsWith("/v1/care-fee/")) return noContent();
  if (!url.pathname.startsWith("/v1/care-fee/")) return notFound("Route not found");

  if (method === "POST" && matches(parts, ["v1", "care-fee", "internal", "evidence"])) {
    return ingestEvidence(input, platformStore, careFeeStore);
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "internal", "monthly-runs", "run"])) {
    requireMonthlyWorkerToken(input);
    const orgId = String(input.body?.orgId || input.body?.org_id || "").trim();
    if (!orgId) throw badRequest("orgId is required");
    const validated = validateMonthlyCareFeeRunInput(input.body || {});
    const organization = await platformStore.getOrganization(orgId);
    const facility = await platformStore.getFacility(orgId, validated.facilityId);
    if (!organization || organization.status === "closed" || !facility || facility.status !== "active") {
      throw forbiddenError("Care fee monthly review target is not active");
    }
    await requireProductEnabled(platformStore, orgId, PRODUCT_ID, {
      now: input.now,
      productLabel: "Care Fee"
    });
    return executeMonthlyReview({
      input,
      orgId,
      actorMemberId: "service",
      platformStore,
      careFeeStore,
      validated
    });
  }

  const context = await requireCareFeeContext(input, platformStore);
  if (method === "GET" && matches(parts, ["v1", "care-fee", "context"])) {
    return ok({ context: contextView(context) });
  }
  if (method === "GET" && matches(parts, ["v1", "care-fee", "bootstrap"])) {
    const facilityId = url.searchParams.get("facilityId") || "";
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const [facilities, settings, episodes, monthlyRuns, monthlyClaims, importJobs] = await Promise.all([
      platformStore.listFacilities(context.session.orgId),
      careFeeStore.listFacilitySettings(context.session.orgId),
      careFeeStore.listEpisodes(context.session.orgId, { facilityId, claimMonth }),
      careFeeStore.listMonthlyRuns(context.session.orgId, { facilityId, claimMonth }),
      careFeeStore.listMonthlyClaims(context.session.orgId, { facilityId, claimMonth }),
      careFeeStore.listImportJobs(context.session.orgId)
    ]);
    return ok({ facilities, settings, episodes, monthlyRuns, monthlyClaims, importJobs });
  }
  if (method === "GET" && matches(parts, ["v1", "care-fee", "facility-settings"])) {
    return ok({ settings: await careFeeStore.listFacilitySettings(context.session.orgId) });
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "facility-settings"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const settingsInput = validateCareFeeFacilitySettingsInput(input.body || {});
    await requireFacility(context, platformStore, settingsInput.facilityId);
    const settings = await careFeeStore.upsertFacilitySettings(context.session.orgId, settingsInput);
    await audit(careFeeStore, context.session.orgId, {
      eventType: "care_fee.facility_settings_upserted",
      actorMemberId: context.session.memberId,
      targetType: "care_fee_facility_settings",
      targetId: settings.facilityId,
      safePayload: { facilityId: settings.facilityId, facilityCode: settings.facilityCode }
    });
    return ok({ settings });
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "evaluations", "csv"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    return evaluateCsv(input, context, platformStore, careFeeStore);
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "imports", "csv"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    return importManagedCsv(input, context, platformStore, careFeeStore);
  }
  if (method === "GET" && matches(parts, ["v1", "care-fee", "episodes"])) {
    return ok({ episodes: await careFeeStore.listEpisodes(context.session.orgId, {
      facilityId: url.searchParams.get("facilityId") || "",
      claimMonth: url.searchParams.get("claimMonth") || ""
    }) });
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "episodes", "evaluate"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    return evaluateManagedRows(input, context, platformStore, careFeeStore);
  }
  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "care-fee", "episodes"]) && parts[4] === "decision") {
    requireDecisionAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const decision = validateCareFeeEpisodeDecisionInput(input.body || {});
    const result = await careFeeStore.decideEpisode(context.session.orgId, parts[3], {
      ...decision,
      memberId: context.session.memberId,
      loginId: context.session.loginId
    });
    await audit(careFeeStore, context.session.orgId, {
      eventType: `care_fee.episode_${decision.status}`,
      actorMemberId: context.session.memberId,
      targetType: "care_fee_episode",
      targetId: parts[3],
      safePayload: { status: decision.status, claimId: result.claim?.claimId || null }
    });
    return ok(result);
  }
  if (method === "POST" && matches(parts, ["v1", "care-fee", "monthly-runs"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    return runMonthlyReview(input, context, platformStore, careFeeStore);
  }
  if (method === "GET" && matches(parts, ["v1", "care-fee", "monthly-runs"])) {
    return ok({ runs: await careFeeStore.listMonthlyRuns(context.session.orgId, {
      facilityId: url.searchParams.get("facilityId") || "",
      claimMonth: url.searchParams.get("claimMonth") || ""
    }) });
  }
  return notFound("Route not found");
}

async function evaluateCsv(input, context, platformStore, careFeeStore) {
  const bytes = decodeBase64File(input.body?.fileBase64 ?? input.body?.file_base64, input.maxCsvBytes);
  const facilityId = String(input.body?.facilityId || input.body?.facility_id || "").trim();
  let settings = null;
  if (facilityId) {
    await requireFacility(context, platformStore, facilityId);
    settings = await careFeeStore.getFacilitySettings(context.session.orgId, facilityId);
  }
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const result = evaluateCareEmergencyCsv(bytes, {
    facilitySettings: settings || undefined,
    evaluatedAt: now
  });
  assertFacilityCodeMatches(result.rows, settings);
  const importJob = await careFeeStore.recordImportJob(context.session.orgId, {
    importJobId: `cij_${randomUUID().replaceAll("-", "")}`,
    mode: "spot_csv",
    facilityId: facilityId || null,
    fileName: safeFileName(input.body?.fileName ?? input.body?.file_name),
    sourceFileSha256: result.sourceFileSha256,
    outputFileSha256: sha256Hex(result.output),
    inputEncoding: result.inputEncoding,
    summary: result.summary,
    ruleVersion: result.ruleVersion,
    masterVersion: result.masterVersion,
    actorMemberId: context.session.memberId,
    purgeAt: new Date(now.getTime() + importRetentionDays(input) * 86_400_000)
  });
  await audit(careFeeStore, context.session.orgId, {
    eventType: "care_fee.spot_csv_evaluated",
    actorMemberId: context.session.memberId,
    targetType: "care_fee_import_job",
    targetId: importJob.importJobId,
    safePayload: {
      facilityId: facilityId || null,
      sourceFileSha256: result.sourceFileSha256,
      rowCount: result.summary.rowCount,
      statusCounts: result.summary.statusCounts
    }
  });
  return ok({
    importJob,
    result: csvResultView(result)
  });
}

async function importManagedCsv(input, context, platformStore, careFeeStore) {
  const bytes = decodeBase64File(input.body?.fileBase64 ?? input.body?.file_base64, input.maxCsvBytes);
  const facilityId = String(input.body?.facilityId || input.body?.facility_id || "").trim();
  if (!facilityId) throw badRequest("facilityId is required for managed CSV import");
  await requireFacility(context, platformStore, facilityId);
  const settings = await careFeeStore.getFacilitySettings(context.session.orgId, facilityId);
  if (!settings?.enabled || !settings.facilityCode) {
    throw badRequest("Enabled care fee facility settings with facilityCode are required for managed CSV import");
  }

  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const result = evaluateCareEmergencyCsv(bytes, {
    facilitySettings: settings,
    evaluatedAt: now
  });
  assertFacilityCodeMatches(result.normalizedRows, settings);
  const documents = buildCareFeeEpisodeDocuments({
    orgId: context.session.orgId,
    facilityId,
    rows: result.normalizedRows,
    evaluation: result.evaluation,
    source: {
      sourceProduct: "csv_upload",
      sourceRevisionHash: result.sourceFileSha256
    },
    now
  });
  const previous = await Promise.all(documents.map((document) => (
    careFeeStore.getEpisode(context.session.orgId, document.episodeId)
  )));
  const episodes = await careFeeStore.upsertEpisodes(context.session.orgId, documents);
  const importSummary = summarizeManagedImport(documents, previous, result);
  const importJob = await careFeeStore.recordImportJob(context.session.orgId, {
    importJobId: `cij_${randomUUID().replaceAll("-", "")}`,
    mode: "managed_csv",
    facilityId,
    fileName: safeFileName(input.body?.fileName ?? input.body?.file_name),
    sourceFileSha256: result.sourceFileSha256,
    outputFileSha256: sha256Hex(result.output),
    inputEncoding: result.inputEncoding,
    summary: { ...result.summary, managedImport: importSummary },
    ruleVersion: result.ruleVersion,
    masterVersion: result.masterVersion,
    actorMemberId: context.session.memberId,
    purgeAt: new Date(now.getTime() + importRetentionDays(input) * 86_400_000)
  });
  await audit(careFeeStore, context.session.orgId, {
    eventType: "care_fee.managed_csv_imported",
    actorMemberId: context.session.memberId,
    targetType: "care_fee_import_job",
    targetId: importJob.importJobId,
    safePayload: {
      facilityId,
      sourceFileSha256: result.sourceFileSha256,
      rowCount: result.summary.rowCount,
      statusCounts: result.summary.statusCounts,
      importSummary
    }
  });
  return ok({
    importJob,
    importSummary,
    episodeRefs: episodes.map((episode) => ({
      episodeId: episode.episodeId,
      claimMonth: episode.claimMonth,
      decisionStatus: episode.decisionStatus
    })),
    result: csvResultView(result)
  });
}

async function evaluateManagedRows(input, context, platformStore, careFeeStore) {
  const validated = validateCareFeeEpisodeRowsInput(input.body || {});
  await requireFacility(context, platformStore, validated.facilityId);
  const settings = await careFeeStore.getFacilitySettings(context.session.orgId, validated.facilityId);
  assertFacilityCodeMatches(validated.rows, settings);
  const evaluation = evaluateEmergencyTreatmentBatch(validated.rows, { facilitySettings: settings || undefined });
  const documents = buildCareFeeEpisodeDocuments({
    orgId: context.session.orgId,
    facilityId: validated.facilityId,
    rows: validated.rows,
    evaluation,
    source: {
      sourceProduct: String(input.body?.sourceProduct || "manual"),
      sourceRecordId: String(input.body?.sourceRecordId || "")
    },
    now: input.now
  });
  const episodes = await careFeeStore.upsertEpisodes(context.session.orgId, documents);
  await audit(careFeeStore, context.session.orgId, {
    eventType: "care_fee.episodes_evaluated",
    actorMemberId: context.session.memberId,
    targetType: "care_fee_episode_batch",
    targetId: stableId("ceb", ...episodes.map((episode) => episode.episodeId)),
    safePayload: { facilityId: validated.facilityId, episodeCount: episodes.length }
  });
  return ok({ episodes, evaluation });
}

async function runMonthlyReview(input, context, platformStore, careFeeStore) {
  const validated = validateMonthlyCareFeeRunInput(input.body || {});
  await requireFacility(context, platformStore, validated.facilityId);
  return executeMonthlyReview({
    input,
    orgId: context.session.orgId,
    actorMemberId: context.session.memberId,
    platformStore,
    careFeeStore,
    validated
  });
}

async function executeMonthlyReview({ input, orgId, actorMemberId, careFeeStore, validated }) {
  const [episodes, claims, settings] = await Promise.all([
    careFeeStore.listEpisodes(orgId, validated),
    careFeeStore.listMonthlyClaims(orgId, validated),
    careFeeStore.getFacilitySettings(orgId, validated.facilityId)
  ]);
  const master = loadDefaultEmergencyTreatmentMaster();
  const revisionHash = careFeeMonthlyRevisionHash({
    orgId,
    facilityId: validated.facilityId,
    claimMonth: validated.claimMonth,
    ruleVersion: CARE_EMERGENCY_RULE_VERSION,
    masterVersion: master.masterVersion,
    episodes,
    claims
  });
  const runId = stableId("cmr", orgId, validated.facilityId, validated.claimMonth, revisionHash);
  const existing = await careFeeStore.getMonthlyRun(orgId, runId);
  if (existing) return ok({ run: existing, reused: true });

  const evaluation = evaluateEmergencyTreatmentBatch(episodes.flatMap((episode) => episode.rows || []), {
    master,
    facilitySettings: settings || undefined,
    monthlyPriorEpisodes: claims.map((claim) => ({ ...claim, status: "confirmed" }))
  });
  const statusCounts = countBy(evaluation.episodes, "judgmentStatus");
  const run = await careFeeStore.recordMonthlyRun(orgId, {
    runId,
    facilityId: validated.facilityId,
    claimMonth: validated.claimMonth,
    timezone: validated.timezone,
    revisionHash,
    ruleVersion: evaluation.ruleVersion,
    masterVersion: evaluation.masterVersion,
    coverage: {
      sourceEpisodeCount: episodes.length,
      evaluatedEpisodeCount: evaluation.episodes.length,
      unavailableEpisodeCount: Math.max(0, episodes.length - evaluation.episodes.length),
      claimCount: claims.length
    },
    summary: {
      statusCounts,
      candidateCount: statusCounts.billing_candidate || 0,
      needsReviewCount: statusCounts.needs_review || 0,
      conflictCount: statusCounts.conflict || 0,
      notEligibleCount: statusCounts.not_eligible || 0,
      importErrorCount: statusCounts.import_error || 0
    },
    episodeResults: evaluation.episodes,
    actorMemberId
  });
  await audit(careFeeStore, orgId, {
    eventType: "care_fee.monthly_review_completed",
    actorMemberId,
    targetType: "care_fee_monthly_run",
    targetId: runId,
    safePayload: { facilityId: validated.facilityId, claimMonth: validated.claimMonth, coverage: run.coverage, summary: run.summary }
  });
  return ok({ run, reused: false });
}

async function ingestEvidence(input, platformStore, careFeeStore) {
  requireIngestToken(input);
  const event = validateCareFeeEvidenceEventInput(input.body || {});
  const organization = await platformStore.getOrganization(event.orgId);
  const facility = await platformStore.getFacility(event.orgId, event.facilityId);
  if (!organization || organization.status === "closed" || !facility || facility.status !== "active") {
    throw forbiddenError("Care fee evidence target is not active");
  }
  await requireProductEnabled(platformStore, event.orgId, PRODUCT_ID, {
    now: input.now,
    productLabel: "Care Fee"
  });
  if (event.rows.some((row) => row.facilityCode !== event.facilityCode || row.patientKey !== event.patientKey)) {
    throw badRequest("Evidence envelope does not match its rows");
  }
  const receiptId = stableId("cer", event.sourceProduct, event.sourceRecordId, event.sourceRevisionHash);
  const existing = await careFeeStore.getEvidenceReceipt(event.orgId, receiptId);
  if (existing) return ok({ receipt: existing, duplicate: true });

  const settings = await careFeeStore.getFacilitySettings(event.orgId, event.facilityId);
  assertFacilityCodeMatches(event.rows, settings);
  const evaluation = evaluateEmergencyTreatmentBatch(event.rows, { facilitySettings: settings || undefined });
  const episodeDocuments = buildCareFeeEpisodeDocuments({
    orgId: event.orgId,
    facilityId: event.facilityId,
    rows: event.rows,
    evaluation,
    source: event,
    now: input.now
  });
  const episodes = await careFeeStore.upsertEpisodes(event.orgId, episodeDocuments);
  const receipt = await careFeeStore.recordEvidenceReceipt(event.orgId, {
    receiptId,
    contractVersion: event.contractVersion,
    sourceProduct: event.sourceProduct,
    sourceRecordId: event.sourceRecordId,
    sourceRevisionHash: event.sourceRevisionHash,
    facilityId: event.facilityId,
    patientKey: event.patientKey,
    episodeIds: episodes.map((episode) => episode.episodeId),
    rowCount: event.rows.length
  });
  await audit(careFeeStore, event.orgId, {
    eventType: "care_fee.evidence_ingested",
    actorMemberId: "service",
    targetType: "care_fee_evidence_receipt",
    targetId: receiptId,
    safePayload: { sourceProduct: event.sourceProduct, facilityId: event.facilityId, episodeCount: episodes.length }
  });
  return created({ receipt, episodes, duplicate: false });
}

async function requireCareFeeContext(input, platformStore) {
  return requireProductContext(input, {
    platformStore,
    productId: PRODUCT_ID,
    productLabel: "Care Fee",
    allowedProductRoles: READ_ROLES
  });
}

function requireWriteAccess(context) {
  if (!hasProductAccess(context.session, PRODUCT_ID, WRITE_ROLES)) {
    throw forbiddenError("Care fee write access is required");
  }
}

function requireDecisionAccess(context) {
  if (!hasProductAccess(context.session, PRODUCT_ID, DECIDE_ROLES)) {
    throw forbiddenError("Care fee decision access is required");
  }
}

async function requireFacility(context, platformStore, facilityId) {
  const facility = await platformStore.getFacility(context.session.orgId, facilityId);
  if (!facility || facility.status !== "active") throw notFoundError("facility not found");
  return facility;
}

function requireIngestToken(input) {
  const configured = String(input.ingestToken ?? process.env.CARE_FEE_INGEST_TOKEN ?? "");
  if (!configured) {
    const error = new Error("Care fee evidence ingest is not configured");
    error.name = "ServiceUnavailableError";
    error.statusCode = 503;
    throw error;
  }
  const authorization = headerValue(input.headers || {}, "authorization");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!safeEqual(provided, configured)) {
    const error = new Error("Invalid care fee evidence token");
    error.name = "UnauthorizedError";
    error.statusCode = 401;
    throw error;
  }
}

function requireMonthlyWorkerToken(input) {
  const processEnv = input.processEnv || process.env;
  const configured = String(
    input.monthlyWorkerToken
    ?? processEnv.CARE_FEE_MONTHLY_WORKER_TOKEN
    ?? ""
  ).trim();
  const authMode = String(processEnv.CARE_FEE_MONTHLY_WORKER_AUTH_MODE || "").trim().toLowerCase();
  if (!configured && input.env === "test") return;
  if (!configured && authMode === "iam") return;
  if (!configured) {
    const error = new Error("Care fee monthly worker is not configured");
    error.name = "ServiceUnavailableError";
    error.statusCode = 503;
    throw error;
  }
  const authorization = headerValue(input.headers || {}, "authorization");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!safeEqual(provided, configured)) {
    const error = new Error("Invalid care fee monthly worker token");
    error.name = "UnauthorizedError";
    error.statusCode = 401;
    throw error;
  }
}

function monthlyAutomationReadiness(input = {}) {
  const processEnv = input.processEnv || process.env;
  const configured = Boolean(String(
    input.monthlyWorkerToken
    ?? processEnv.CARE_FEE_MONTHLY_WORKER_TOKEN
    ?? ""
  ).trim());
  const authMode = String(processEnv.CARE_FEE_MONTHLY_WORKER_AUTH_MODE || "token").trim().toLowerCase();
  return {
    monthlyWorkerReady: configured || authMode === "iam",
    monthlyWorkerAuthMode: authMode
  };
}

function assertFacilityCodeMatches(rows, settings) {
  if (!settings?.facilityCode) return;
  const mismatched = rows.some((row) => (row.facilityCode ?? row.facility_code) !== settings.facilityCode);
  if (mismatched) throw badRequest("CSV facility_code does not match the selected facility settings");
}

function csvResultView(result) {
  return {
    runId: result.runId,
    evaluatedAt: result.evaluatedAt,
    ruleVersion: result.ruleVersion,
    masterVersion: result.masterVersion,
    sourceFileSha256: result.sourceFileSha256,
    inputEncoding: result.inputEncoding,
    summary: result.summary,
    rows: result.rows,
    outputBase64: result.output.toString("base64")
  };
}

function summarizeManagedImport(documents, previous, result) {
  const createdEpisodeCount = previous.filter((episode) => !episode).length;
  const unchangedEpisodeCount = previous.filter((episode, index) => (
    episode?.sourceRevisionHash === documents[index]?.sourceRevisionHash
  )).length;
  return Object.freeze({
    acceptedRowCount: result.normalizedRows.length,
    importErrorRowCount: result.summary.importErrorCount,
    persistedEpisodeCount: documents.length,
    createdEpisodeCount,
    updatedEpisodeCount: documents.length - createdEpisodeCount - unchangedEpisodeCount,
    unchangedEpisodeCount
  });
}

async function audit(store, orgId, input) {
  return store.recordAudit(orgId, {
    ...input,
    auditLogId: `cau_${randomUUID().replaceAll("-", "")}`,
    productId: PRODUCT_ID
  });
}

function contextView(context) {
  return {
    orgId: context.session.orgId,
    memberId: context.session.memberId,
    organizationCode: context.session.organizationCode,
    loginId: context.session.loginId,
    globalRoles: context.session.globalRoles || [],
    productRoles: context.session.productRoles || {},
    careFeeEntitlement: context.entitlement
  };
}

function decodeBase64File(value, configuredMax) {
  const text = String(value || "");
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) {
    throw badRequest("fileBase64 must be valid base64");
  }
  const bytes = Buffer.from(text, "base64");
  const maxBytes = positiveInteger(configuredMax ?? process.env.CARE_FEE_MAX_CSV_BYTES, DEFAULT_MAX_CSV_BYTES);
  if (bytes.length === 0) throw badRequest("CSV file is empty");
  if (bytes.length > maxBytes) {
    const error = badRequest(`CSV file exceeds ${maxBytes} bytes`);
    error.statusCode = 413;
    throw error;
  }
  return bytes;
}

function countBy(values, property) {
  const counts = {};
  for (const value of values || []) counts[value[property]] = (counts[value[property]] || 0) + 1;
  return counts;
}

function matches(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function readJsonBody(req, maxBytes) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = badRequest("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

function maxJsonBytes(options) {
  return positiveInteger(options.maxJsonBytes ?? process.env.CARE_FEE_MAX_JSON_BYTES, 15 * 1024 * 1024);
}

function importRetentionDays(input) {
  return positiveInteger(input.importRetentionDays ?? process.env.CARE_FEE_IMPORT_RETENTION_DAYS, DEFAULT_IMPORT_RETENTION_DAYS);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFileName(value) {
  return String(value || "input.csv").split(/[\\/]/u).pop().slice(0, 180) || "input.csv";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(payload);
}

function ok(body, headers = {}) { return { statusCode: 200, body, headers }; }
function created(body, headers = {}) { return { statusCode: 201, body, headers }; }
function noContent(headers = {}) { return { statusCode: 204, body: {}, headers }; }
function notFound(message) { return { statusCode: 404, body: { error: "not_found", message } }; }

function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.name = "BadRequestError";
  error.statusCode = 400;
  return error;
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  return {
    statusCode,
    body: {
      error: statusCode === 500 ? "internal_error" : (publicAuthErrorCode(error) || toErrorCode(error.name)),
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field,
      issues: error.issues
    }
  };
}

function toErrorCode(name = "") {
  return String(name || "error").replace(/Error$/u, "").replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
}

function withCors(input, response) {
  return { ...response, headers: { ...corsHeaders(input), ...response.headers } };
}

function corsHeaders(input) {
  const origin = headerValue(input.headers || {}, "origin");
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-csrf-token, authorization",
    "vary": "Origin"
  };
}

function isAllowedOrigin(origin) {
  return [
    "https://care.halunasu.com",
    "https://care.stg.halunasu.com"
  ].includes(origin)
    || /^https:\/\/[a-z0-9-]+--halunasu\.netlify\.app$/u.test(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  createCareFeeApiServer().listen(port, () => {
    process.stdout.write(`care-fee-api listening on ${port}\n`);
  });
}
