import http from "node:http";
import {
  requirePlatformCsrf,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  validateCreateFeeCalculationInput,
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateUpdateFeeSessionInput
} from "../../../packages/fee-contracts/src/index.js";
import {
  buildReceiptDraft,
  buildReviewItems
} from "../../../packages/fee-core/src/index.js";
import {
  departmentSnapshot,
  facilitySnapshot,
  patientSnapshot
} from "../../../packages/platform-contracts/src/index.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import { createFeeCalculatorFromEnv } from "./python-calculator.js";
import { createFeeStoreFromEnv } from "./store/create-store.js";

const PRODUCT_ID = "fee";
const FEE_PRODUCT_ROLES = ["admin", "doctor", "nurse", "medical_clerk", "viewer"];

export function createFeeApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const platformStore = options.platformStore || createPlatformStoreFromEnv();
  const feeStore = options.feeStore || createFeeStoreFromEnv();
  const feeCalculator = options.feeCalculator || createFeeCalculatorFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handleFeeApiRequest({
        method: req.method,
        path: req.url,
        body,
        headers: req.headers,
        env,
        projectId,
        region,
        startedAt,
        platformStore,
        feeStore,
        feeCalculator,
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

export async function handleFeeApiRequest(input = {}) {
  try {
    return withCors(input, await routeFeeApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routeFeeApiRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const platformStore = input.platformStore || createPlatformStoreFromEnv();
  const feeStore = input.feeStore || createFeeStoreFromEnv();
  const feeCalculator = input.feeCalculator || createFeeCalculatorFromEnv();

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "fee-api" });
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return ok({
      status: "ok",
      service: "fee-api",
      env: input.env || "local",
      projectId: input.projectId || "medical-core-stg",
      region: input.region || "asia-northeast1",
      feeCalculator: typeof feeCalculator.readiness === "function"
        ? feeCalculator.readiness()
        : { provider: "custom", masterDbConfigured: null, masterDbPathExists: null },
      startedAt: input.startedAt instanceof Date
        ? input.startedAt.toISOString()
        : new Date().toISOString()
    });
  }

  if (method === "OPTIONS" && url.pathname.startsWith("/v1/fee/")) {
    return noContent();
  }

  if (!url.pathname.startsWith("/v1/fee/")) {
    return notFound("Route not found");
  }

  const context = await requireFeeContext(input, platformStore);

  if (method === "GET" && matches(parts, ["v1", "fee", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "bootstrap"])) {
    const [patients, facilities, departments, sessionList] = await Promise.all([
      platformStore.listPatients(context.session.orgId),
      platformStore.listFacilities(context.session.orgId),
      platformStore.listDepartments(context.session.orgId),
      feeStore.listSessions(context.session.orgId, feeSessionListOptionsFromUrl(url))
    ]);
    return ok({
      patients,
      facilities,
      departments,
      ...sessionList
    });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "patients"])) {
    return ok({ patients: await platformStore.listPatients(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "patients"])) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const patient = await platformStore.createPatient(
      context.session.orgId,
      validateCreateFeePatientInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.patient_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patient.patientId,
      productId: PRODUCT_ID,
      safePayload: { patientId: patient.patientId }
    });
    return created({ patient });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "facilities"])) {
    return ok({ facilities: await platformStore.listFacilities(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "departments"])) {
    return ok({ departments: await platformStore.listDepartments(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "sessions"])) {
    return ok(await feeStore.listSessions(context.session.orgId, feeSessionListOptionsFromUrl(url)));
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "sessions"])) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const normalized = validateCreateFeeSessionInput(input.body || {});
    const patient = normalized.patientId || normalized.patient
      ? await resolveFeePatient(context, platformStore, normalized)
      : null;
    const facility = normalized.facilityId
      ? await requireFacility(context, platformStore, normalized.facilityId)
      : null;
    const department = await resolveDepartment(context, platformStore, normalized.departmentId);
    const session = await feeStore.createSession({
      ...normalized,
      orgId: context.session.orgId,
      patientId: patient?.patientId,
      patientSnapshot: patient ? patientSnapshot(patient, input.now || new Date()) : null,
      facilitySnapshot: facility ? facilitySnapshot(facility, input.now || new Date()) : null,
      departmentSnapshot: department ? departmentSnapshot(department, input.now || new Date()) : null,
      createdByMemberId: context.session.memberId
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.session_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_session",
      targetId: session.feeSessionId,
      productId: PRODUCT_ID,
      safePayload: {
        feeSessionId: session.feeSessionId,
        patientId: session.patientId,
        facilityId: session.facilityId,
        departmentId: session.departmentId,
        claimMonth: session.claimMonth
      }
    });

    return created({ feeSession: session });
  }

  if (method === "GET" && isFeeSessionDocument(parts)) {
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }

    return ok({ feeSession: session });
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "detail") {
    return ok(await buildFeeSessionDetail(feeStore, context.session.orgId, parts[3], input.now || new Date()));
  }

  if (method === "PATCH" && isFeeSessionDocument(parts)) {
    requirePlatformCsrf(input.headers || {}, context.session);
    const current = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!current) {
      return notFound("fee session not found");
    }
    const normalized = validateUpdateFeeSessionInput(input.body || {});
    const patch = await resolveFeeSessionPatch(context, platformStore, normalized, input.now || new Date());
    const result = await feeStore.updateSession(context.session.orgId, parts[3], patch);
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.session_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_session",
      targetId: result.feeSession.feeSessionId,
      productId: PRODUCT_ID,
      safePayload: {
        feeSessionId: result.feeSession.feeSessionId,
        patientId: result.feeSession.patientId || null,
        facilityId: result.feeSession.facilityId || null,
        departmentId: result.feeSession.departmentId || null,
        claimMonth: result.feeSession.claimMonth || null
      }
    });

    return ok(result);
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "receipt-draft") {
    return ok({ receiptDraft: await feeStore.getReceiptDraft(context.session.orgId, parts[3]) });
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "review-items") {
    return ok({ reviewItems: await feeStore.listReviewItems(context.session.orgId, parts[3]) });
  }

  if (method === "PATCH" && parts.length === 6 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "review-items") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await feeStore.decideReviewItem(context.session.orgId, parts[3], decodeURIComponent(parts[5]), input.body || {});
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.review_item_decided",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_review_item",
      targetId: decodeURIComponent(parts[5]),
      productId: PRODUCT_ID,
      safePayload: {
        feeSessionId: result.feeSession.feeSessionId,
        reviewItemId: decodeURIComponent(parts[5]),
        status: result.feeSession.reviewDecisions?.[decodeURIComponent(parts[5])]?.status
      }
    });

    return ok(result);
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "calculate") {
    requirePlatformCsrf(input.headers || {}, context.session);
    const current = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!current) {
      return notFound("fee session not found");
    }
    assertFeeSessionReadyForCalculation(current);
    const calculationInput = validateCreateFeeCalculationInput(input.body || {});
    const calculationResult = await feeCalculator.calculate(current, buildCalculationInputForSession(current, calculationInput));
    const result = await feeStore.saveCalculation(context.session.orgId, parts[3], calculationResult);
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.calculated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_session",
      targetId: result.feeSession.feeSessionId,
      productId: PRODUCT_ID,
      safePayload: {
        feeSessionId: result.feeSession.feeSessionId,
        calculationId: result.calculationResult.calculationId,
        provider: result.calculationResult.provider,
        totalPoints: result.calculationResult.totalPoints
      }
    });

    return created({
      ...result,
      receiptDraft: buildReceiptDraft(result.feeSession, { now: input.now || new Date() }),
      reviewItems: buildReviewItems(result.feeSession)
    });
  }

  return notFound("Route not found");
}

async function requireFeeContext(input, platformStore) {
  return requireProductContext(input, {
    platformStore,
    productId: PRODUCT_ID,
    productLabel: "Fee",
    allowedProductRoles: FEE_PRODUCT_ROLES
  });
}

async function buildFeeSessionDetail(feeStore, orgId, feeSessionId, now) {
  const feeSession = await feeStore.getSession(orgId, feeSessionId);
  if (!feeSession) {
    const error = new Error("fee session not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  return {
    feeSession,
    receiptDraft: buildReceiptDraft(feeSession, { now }),
    reviewItems: buildReviewItems(feeSession)
  };
}

async function resolveFeePatient(context, platformStore, input) {
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

async function requireFacility(context, platformStore, facilityId) {
  const facility = await platformStore.getFacility(context.session.orgId, facilityId);
  if (!facility || facility.status !== "active") {
    const error = new Error("facility not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  return facility;
}

async function resolveDepartment(context, platformStore, departmentId) {
  if (!departmentId) {
    return null;
  }

  const department = await platformStore.getDepartment(context.session.orgId, departmentId);
  if (!department || department.status !== "active") {
    const error = new Error("department not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  return department;
}

async function resolveFeeSessionPatch(context, platformStore, normalized, now) {
  const patch = { ...normalized };
  if (normalized.patientId || normalized.patient) {
    const patient = await resolveFeePatient(context, platformStore, normalized);
    patch.patientId = patient.patientId;
    patch.patientSnapshot = patientSnapshot(patient, now);
  }

  if (hasOwn(normalized, "facilityId")) {
    const facility = normalized.facilityId
      ? await requireFacility(context, platformStore, normalized.facilityId)
      : null;
    patch.facilitySnapshot = facility ? facilitySnapshot(facility, now) : null;
  }

  if (hasOwn(normalized, "departmentId")) {
    const department = normalized.departmentId
      ? await resolveDepartment(context, platformStore, normalized.departmentId)
      : null;
    patch.departmentSnapshot = department ? departmentSnapshot(department, now) : null;
  }

  delete patch.patient;
  return patch;
}

function assertFeeSessionReadyForCalculation(session = {}) {
  const missing = [];
  if (!session.patientId) missing.push("患者");
  if (!session.facilityId) missing.push("施設");
  if (!session.serviceDate) missing.push("診療日");
  if (missing.length) {
    const error = new Error(`${missing.join("、")}を入力してから算定してください。`);
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = "feeSession";
    throw error;
  }
}

function buildCalculationInputForSession(session = {}, input = {}) {
  const calculationInput = { ...input };
  if (!hasOwn(calculationInput, "claimContext") && isPlainObject(session.claimContext)) {
    calculationInput.claimContext = session.claimContext;
  }
  if (!hasOwn(calculationInput, "calculationOptions") && isPlainObject(session.calculationOptions)) {
    calculationInput.calculationOptions = session.calculationOptions;
  } else if (
    isPlainObject(session.calculationOptions)
    && isPlainObject(calculationInput.calculationOptions)
  ) {
    calculationInput.calculationOptions = {
      ...session.calculationOptions,
      ...calculationInput.calculationOptions
    };
  }

  return calculationInput;
}

function contextView(context) {
  return {
    orgId: context.session.orgId,
    memberId: context.session.memberId,
    organizationCode: context.session.organizationCode,
    loginId: context.session.loginId,
    globalRoles: context.session.globalRoles || [],
    productRoles: context.session.productRoles || {},
    feeEntitlement: context.entitlement
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

function isFeeSessionDocument(parts) {
  return parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]);
}

function feeSessionListOptionsFromUrl(url) {
  return {
    page: parsePositiveInteger(url.searchParams.get("page"), 1),
    pageSize: parsePositiveInteger(url.searchParams.get("pageSize"), 20, 50),
    search: String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim(),
    statuses: feeStatusesFromQuery(url.searchParams)
  };
}

function feeStatusesFromQuery(searchParams) {
  const status = String(searchParams.get("status") || "all").trim();
  if (!status || status === "all") {
    return [];
  }
  const mapped = {
    active: ["draft", "ready"],
    review: ["needs_review"],
    calculated: ["calculated"],
    failed: ["failed"]
  }[status];
  if (mapped) {
    return mapped;
  }

  return status
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => part === parts[index]);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toErrorCode(name) {
  return String(name || "Error")
    .replace(/Error$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase() || "error";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FEE_API_PORT || process.env.PORT || 8084);
  createFeeApiServer().listen(port, () => {
    console.log(`fee-api listening on :${port}`);
  });
}
