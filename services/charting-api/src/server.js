import http from "node:http";
import {
  requirePlatformCsrf,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  validateCreateChartingEncounterInput,
  validateCreateChartingPatientInput
} from "../../../packages/charting-contracts/src/index.js";
import { patientSnapshot } from "../../../packages/platform-contracts/src/index.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import { createChartingStoreFromEnv } from "./store/create-store.js";

const PRODUCT_ID = "charting";

export function createChartingApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const platformStore = options.platformStore || createPlatformStoreFromEnv();
  const chartingStore = options.chartingStore || createChartingStoreFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handleChartingApiRequest({
        method: req.method,
        path: req.url,
        body,
        headers: req.headers,
        env,
        projectId,
        region,
        startedAt,
        platformStore,
        chartingStore,
        now: options.now,
        sessionSecret: options.sessionSecret
      });

      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export async function handleChartingApiRequest(input = {}) {
  try {
    return withCors(input, await routeChartingApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routeChartingApiRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const platformStore = input.platformStore || createPlatformStoreFromEnv();
  const chartingStore = input.chartingStore || createChartingStoreFromEnv();

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "charting-api" });
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return ok({
      status: "ok",
      service: "charting-api",
      env: input.env || "local",
      projectId: input.projectId || "medical-core-stg",
      region: input.region || "asia-northeast1",
      startedAt: input.startedAt instanceof Date
        ? input.startedAt.toISOString()
        : new Date().toISOString()
    });
  }

  if (method === "OPTIONS" && url.pathname.startsWith("/v1/charting/")) {
    return noContent();
  }

  if (!url.pathname.startsWith("/v1/charting/")) {
    return notFound("Route not found");
  }

  const context = await requireChartingContext(input, platformStore);

  if (method === "GET" && matches(parts, ["v1", "charting", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "charting", "patients"])) {
    return ok({ patients: await platformStore.listPatients(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "charting", "facilities"])) {
    return ok({ facilities: await platformStore.listFacilities(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "charting", "departments"])) {
    return ok({ departments: await platformStore.listDepartments(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "charting", "patients"])) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const patient = await platformStore.createPatient(
      context.session.orgId,
      validateCreateChartingPatientInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.patient_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patient.patientId,
      productId: PRODUCT_ID,
      safePayload: { patientId: patient.patientId }
    });
    return created({ patient });
  }

  if (method === "GET" && matches(parts, ["v1", "charting", "encounters"])) {
    return ok({ encounters: await chartingStore.listEncounters(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "charting", "encounters"])) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const normalized = validateCreateChartingEncounterInput(input.body || {});
    const patient = await resolveEncounterPatient(context, platformStore, normalized);
    const encounter = await chartingStore.createEncounter({
      ...normalized,
      patientId: patient.patientId,
      patientSnapshot: patientSnapshot(patient, input.now || new Date()),
      orgId: context.session.orgId,
      createdByMemberId: context.session.memberId,
      doctorMemberId: normalized.doctorMemberId || context.session.memberId
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.encounter_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_encounter",
      targetId: encounter.encounterId,
      productId: PRODUCT_ID,
      safePayload: {
        encounterId: encounter.encounterId,
        patientId: encounter.patientId,
        facilityId: encounter.facilityId,
        departmentId: encounter.departmentId
      }
    });

    return created({ encounter });
  }

  if (method === "GET" && isEncounterDocument(parts)) {
    const encounter = await chartingStore.getEncounter(context.session.orgId, parts[3]);
    if (!encounter) {
      return notFound("encounter not found");
    }

    return ok({ encounter });
  }

  if (method === "PATCH" && isEncounterDocument(parts)) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const encounter = await chartingStore.updateEncounter(context.session.orgId, parts[3], input.body || {});
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.encounter_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_encounter",
      targetId: encounter.encounterId,
      productId: PRODUCT_ID,
      safePayload: { encounterId: encounter.encounterId }
    });

    return ok({ encounter });
  }

  if (method === "POST" && parts.length === 6 && matches(parts.slice(0, 3), ["v1", "charting", "encounters"]) && parts[4] === "recording" && parts[5] === "start") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const encounter = await chartingStore.updateEncounter(context.session.orgId, parts[3], {
      status: "recording"
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.recording_started",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_encounter",
      targetId: encounter.encounterId,
      productId: PRODUCT_ID,
      safePayload: { encounterId: encounter.encounterId }
    });

    return ok({ encounter });
  }

  if (method === "POST" && parts.length === 6 && matches(parts.slice(0, 3), ["v1", "charting", "encounters"]) && parts[4] === "recording" && parts[5] === "stop") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const encounter = await chartingStore.updateEncounter(context.session.orgId, parts[3], {
      status: "stopped",
      transcript: input.body?.transcript,
      notes: input.body?.notes
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.recording_stopped",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_encounter",
      targetId: encounter.encounterId,
      productId: PRODUCT_ID,
      safePayload: { encounterId: encounter.encounterId }
    });

    return ok({ encounter });
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "charting", "encounters"]) && parts[4] === "mock-soap") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await chartingStore.createMockSoapDraft(context.session.orgId, parts[3], input.body || {});
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.soap_draft_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_encounter",
      targetId: result.encounter.encounterId,
      productId: PRODUCT_ID,
      safePayload: {
        encounterId: result.encounter.encounterId,
        soapDraftId: result.soapDraft.soapDraftId,
        provider: result.soapDraft.provider
      }
    });

    return created(result);
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "charting", "encounters"]) && parts[4] === "soap-drafts") {
    return ok({ soapDrafts: await chartingStore.listSoapDrafts(context.session.orgId, parts[3]) });
  }

  if (method === "PATCH" && isSoapDraftDocument(parts)) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await chartingStore.updateSoapDraft(context.session.orgId, parts[3], parts[5], input.body || {});
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.soap_draft_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_soap_draft",
      targetId: result.soapDraft.soapDraftId,
      productId: PRODUCT_ID,
      safePayload: {
        encounterId: result.encounter.encounterId,
        soapDraftId: result.soapDraft.soapDraftId,
        status: result.soapDraft.status
      }
    });

    return ok(result);
  }

  if (method === "POST" && parts.length === 7 && isSoapDraftDocument(parts.slice(0, 6)) && parts[6] === "approve") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await chartingStore.updateSoapDraft(context.session.orgId, parts[3], parts[5], {
      ...(input.body || {}),
      status: "approved"
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "charting.soap_draft_approved",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "charting_soap_draft",
      targetId: result.soapDraft.soapDraftId,
      productId: PRODUCT_ID,
      safePayload: {
        encounterId: result.encounter.encounterId,
        soapDraftId: result.soapDraft.soapDraftId
      }
    });

    return ok(result);
  }

  return notFound("Route not found");
}

async function requireChartingContext(input, platformStore) {
  return requireProductContext(input, {
    platformStore,
    productId: PRODUCT_ID,
    productLabel: "Charting",
    allowedProductRoles: ["admin", "doctor", "nurse", "scribe"]
  });
}

async function resolveEncounterPatient(context, platformStore, input) {
  if (input.patientId) {
    const patient = await platformStore.getPatient(context.session.orgId, input.patientId);
    if (!patient) {
      const error = new Error("patient not found");
      error.name = "NotFoundError";
      error.statusCode = 404;
      throw error;
    }

    return patient;
  }

  return platformStore.createPatient(context.session.orgId, input.patient);
}

function contextView(context) {
  return {
    orgId: context.session.orgId,
    memberId: context.session.memberId,
    organizationCode: context.session.organizationCode,
    loginId: context.session.loginId,
    globalRoles: context.session.globalRoles || [],
    productRoles: context.session.productRoles || {},
    chartingEntitlement: context.entitlement
  };
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }
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

function ok(body, headers = {}) {
  return { statusCode: 200, body, headers };
}

function created(body, headers = {}) {
  return { statusCode: 201, body, headers };
}

function noContent(headers = {}) {
  return { statusCode: 204, body: {}, headers };
}

function notFound(message) {
  return {
    statusCode: 404,
    body: { error: "not_found", message }
  };
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  return {
    statusCode,
    body: {
      error: statusCode === 500 ? "internal_error" : toErrorCode(error.name),
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field
    }
  };
}

function withCors(input, response) {
  return {
    ...response,
    headers: {
      ...corsHeaders(input),
      ...response.headers
    }
  };
}

function corsHeaders(input) {
  const origin = headerValue(input.headers || {}, "origin");
  if (!origin || !isAllowedOrigin(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, x-csrf-token",
    "vary": "Origin"
  };
}

function isAllowedOrigin(origin) {
  return defaultAllowedWebOrigins().includes(origin)
    || configuredAllowedWebOrigins().includes(origin)
    || /^https:\/\/[a-z0-9-]+--halunasu\.netlify\.app$/.test(origin)
    || /^http:\/\/localhost(:\d+)?$/.test(origin)
    || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
}

function defaultAllowedWebOrigins() {
  return [
    "https://halunasu.com",
    "https://www.halunasu.com",
    "https://admin.halunasu.com",
    "https://charting.halunasu.com",
    "https://fee.halunasu.com",
    "https://referral.halunasu.com",
    "https://stg.halunasu.com",
    "https://www.stg.halunasu.com",
    "https://admin.stg.halunasu.com",
    "https://charting.stg.halunasu.com",
    "https://fee.stg.halunasu.com",
    "https://referral.stg.halunasu.com",
    "https://halunasu-lp-stg.netlify.app",
    "https://halunasu-admin-stg.netlify.app",
    "https://halunasu-charting-stg.netlify.app",
    "https://halunasu-fee-stg.netlify.app",
    "https://halunasu-referral-stg.netlify.app",
    "https://halunasu-lp-prod.netlify.app",
    "https://halunasu-admin-prod.netlify.app",
    "https://halunasu-charting-prod.netlify.app",
    "https://halunasu-fee-prod.netlify.app",
    "https://halunasu-referral-prod.netlify.app"
  ];
}

function configuredAllowedWebOrigins() {
  return String(process.env.HALUNASU_ALLOWED_WEB_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function headerValue(headers, name) {
  const direct = headers[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct.join("; ") : direct;
  }

  const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = foundKey ? headers[foundKey] : undefined;
  return Array.isArray(value) ? value.join("; ") : value;
}

function isEncounterDocument(parts) {
  return parts.length === 4 && matches(parts.slice(0, 3), ["v1", "charting", "encounters"]);
}

function isSoapDraftDocument(parts) {
  return parts.length === 6
    && matches(parts.slice(0, 3), ["v1", "charting", "encounters"])
    && parts[4] === "soap-drafts";
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => part === parts[index]);
}

function toErrorCode(name) {
  return String(name || "Error")
    .replace(/Error$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase() || "error";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CHARTING_API_PORT || process.env.PORT || 8083);
  createChartingApiServer().listen(port, () => {
    console.log(`charting-api listening on :${port}`);
  });
}
