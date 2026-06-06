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
import {
  buildClinicalCalculationPreparation,
  isAutoPlaceholderOrderName
} from "./clinical-calculation-input.js";
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
      masterStatus: feeMasterStatus(feeCalculator),
      ...sessionList
    });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "master", "search"])) {
    if (typeof feeCalculator.searchMaster !== "function") {
      return ok({ query: "", type: "all", items: [], masterStatus: feeMasterStatus(feeCalculator) });
    }
    const searchResult = await feeCalculator.searchMaster(masterSearchOptionsFromUrl(url));
    return ok({
      ...searchResult,
      masterStatus: feeMasterStatus(feeCalculator)
    });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "master", "browse"])) {
    if (!isStgEnvironment(input.env)) {
      return notFound("Route not found");
    }
    if (typeof feeCalculator.browseMaster !== "function") {
      return ok({
        type: "procedure",
        query: "",
        page: 1,
        pageSize: 50,
        totalCount: 0,
        totalPages: 1,
        items: [],
        sources: [],
        masterStatus: feeMasterStatus(feeCalculator)
      });
    }
    const browseResult = await feeCalculator.browseMaster(masterBrowseOptionsFromUrl(url));
    return ok({
      ...browseResult,
      masterStatus: feeMasterStatus(feeCalculator)
    });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "patients"])) {
    return ok({ patients: await platformStore.listPatients(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "patients"])) {
    requireMutationCsrf(input, context.session);
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
    requireMutationCsrf(input, context.session);
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
      ...calculationOptionsProvenanceForClientInput(normalized),
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
    requireMutationCsrf(input, context.session);
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
    requireMutationCsrf(input, context.session);
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
    requireMutationCsrf(input, context.session);
    const current = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!current) {
      return notFound("fee session not found");
    }
    assertFeeSessionReadyForCalculation(current);
    const calculationInput = validateCreateFeeCalculationInput(input.body || {});
    if (shouldRunCalculationInline(input)) {
      return created(await calculateFeeSessionNow({
        context,
        feeCalculator,
        feeStore,
        platformStore,
        input,
        feeSessionId: parts[3],
        current,
        calculationInput
      }));
    }

    const queued = await feeStore.updateSession(context.session.orgId, parts[3], { status: "calculating" });
    setImmediate(() => {
      calculateFeeSessionNow({
        context,
        feeCalculator,
        feeStore,
        platformStore,
        input,
        feeSessionId: parts[3],
        current,
        calculationInput
      }).catch(async (error) => {
        console.error(JSON.stringify({
          event: "fee.calculate.failed",
          orgId: context.session.orgId,
          feeSessionId: parts[3],
          failedStage: error?.calculateStage || null,
          failedStageDurationMs: error?.calculateStageDurationMs || null,
          stageTimings: Array.isArray(error?.calculateStageTimings) ? error.calculateStageTimings : null,
          error: safeLogError(error)
        }));
        await markCalculationFailed(feeStore, context.session.orgId, parts[3]).catch(() => null);
      });
    });

    return accepted({
      ...buildFeeSessionDetailFromSession(queued.feeSession, input.now || new Date()),
      calculation: { status: "queued" }
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

function buildFeeSessionDetailFromSession(feeSession, now) {
  return {
    feeSession,
    receiptDraft: buildReceiptDraft(feeSession, { now }),
    reviewItems: buildReviewItems(feeSession)
  };
}

async function calculateFeeSessionNow({
  context,
  feeCalculator,
  feeStore,
  platformStore,
  input,
  feeSessionId,
  current,
  calculationInput
}) {
  const overallStartedAt = Date.now();
  const stageTimings = [];
  const latest = await timedCalculationStage({
    stage: "loadSession",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => feeStore.getSession(context.session.orgId, feeSessionId)
  });
  const session = latest || current;
  const prepared = await timedCalculationStage({
    stage: "prepare",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => prepareSessionForCalculation(session, calculationInput, feeCalculator, input),
    detail: (result) => ({
      clinicalStructuring: result?.metrics?.clinicalStructuring || null,
      prepareStageTimings: result?.metrics?.stageTimings || [],
      calculationOptionsKeys: Object.keys(result?.calculationOptions || {}),
      reviewWarningCount: Array.isArray(result?.reviewWarnings) ? result.reviewWarnings.length : 0
    })
  });
  const calculationSession = prepared.patch
    ? (await timedCalculationStage({
      stage: "savePreparedSession",
      orgId: context.session.orgId,
      feeSessionId,
      stageTimings,
      fn: () => feeStore.updateSession(context.session.orgId, feeSessionId, prepared.patch),
      detail: () => ({
        patchKeys: Object.keys(prepared.patch || {})
      })
    })).feeSession
    : session;
  const calculationInputForSession = buildCalculationInputForSession(calculationSession, calculationInput, prepared);
  const calculationResult = await timedCalculationStage({
    stage: "pythonCalculator",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => feeCalculator.calculate(
      calculationSession,
      calculationInputForSession
    ),
    detail: (result) => ({
      provider: result?.provider || null,
      status: result?.status || null,
      totalPoints: Number(result?.totalPoints || 0),
      lineItemCount: Array.isArray(result?.lineItems) ? result.lineItems.length : 0,
      warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0
    })
  });
  const result = await timedCalculationStage({
    stage: "saveCalculation",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => feeStore.saveCalculation(
      context.session.orgId,
      feeSessionId,
      addSessionReviewWarnings(calculationSession, calculationResult, prepared.reviewWarnings)
    )
  });
  await timedCalculationStage({
    stage: "audit",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => platformStore.createAuditEvent(context.session.orgId, {
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
    })
  });
  console.info(JSON.stringify({
    event: "fee.calculate.completed",
    orgId: context.session.orgId,
    feeSessionId,
    status: result.feeSession.status,
    totalPoints: result.calculationResult.totalPoints,
    totalDurationMs: Date.now() - overallStartedAt,
    calculatorDurationMs: stageDuration(stageTimings, "pythonCalculator"),
    stageTimings,
    clinicalStructuring: prepared.metrics?.clinicalStructuring || null
  }));

  return {
    ...result,
    receiptDraft: buildReceiptDraft(result.feeSession, { now: input.now || new Date() }),
    reviewItems: buildReviewItems(result.feeSession)
  };
}

async function markCalculationFailed(feeStore, orgId, feeSessionId) {
  await feeStore.updateSession(orgId, feeSessionId, { status: "failed" });
}

function shouldRunCalculationInline(input = {}) {
  return input.env === "test"
    || input.body?.wait === true
    || String(process.env.FEE_CALCULATION_INLINE || "").toLowerCase() === "true";
}

async function timedCalculationStage({
  stage,
  orgId,
  feeSessionId,
  stageTimings,
  fn,
  detail = null
}) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    const entry = { stage, durationMs };
    stageTimings.push(entry);
    console.info(JSON.stringify({
      event: "fee.calculate.stage.completed",
      orgId,
      feeSessionId,
      stage,
      durationMs,
      ...(typeof detail === "function" ? safeStageDetail(detail(result)) : {})
    }));
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const entry = { stage, durationMs, failed: true };
    stageTimings.push(entry);
    error.calculateStage = error.calculateStage || stage;
    error.calculateStageDurationMs = error.calculateStageDurationMs || durationMs;
    error.calculateStageTimings = error.calculateStageTimings || [...stageTimings];
    console.error(JSON.stringify({
      event: "fee.calculate.stage.failed",
      orgId,
      feeSessionId,
      stage,
      durationMs,
      error: safeLogError(error)
    }));
    throw error;
  }
}

async function measureStage(stageTimings, stage, fn) {
  const startedAt = Date.now();
  let failed = false;
  try {
    return await fn();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    stageTimings.push({
      stage,
      durationMs: Date.now() - startedAt,
      ...(failed ? { failed: true } : {})
    });
  }
}

function stageDuration(stageTimings, stage) {
  const entry = stageTimings.find((candidate) => candidate.stage === stage);
  return entry ? entry.durationMs : null;
}

function safeStageDetail(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
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
  const patch = {
    ...normalized,
    ...calculationOptionsProvenanceForClientInput(normalized)
  };
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

function calculationOptionsProvenanceForClientInput(input = {}) {
  if (!hasOwn(input, "calculationOptions")) {
    return {};
  }
  return {
    calculationOptionsSource: isPlainObject(input.calculationOptions) ? "manual" : null,
    calculationOptionsAutoKeys: []
  };
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

async function prepareSessionForCalculation(session = {}, calculationInput = {}, feeCalculator, input = {}) {
  const stageTimings = [];
  const enriched = await measureStage(stageTimings, "enrichOrders", () => enrichSessionOrdersForCalculation(session, feeCalculator));
  const baseSession = enriched.changed ? { ...session, orders: enriched.orders } : session;
  const legacy = await measureStage(stageTimings, "clinicalCalculationPreparation", () => buildClinicalCalculationPreparation({
    session: baseSession,
    calculationInput,
    feeCalculator,
    openAiApiKey: input.openAiApiKey || process.env.OPENAI_API_KEY || "",
    openAiModel: (
      input.openAiFeeClinicalModel
      || process.env.OPENAI_FEE_CLINICAL_MODEL
      || process.env.OPENAI_FACT_MODEL
      || process.env.OPENAI_SOAP_MODEL
      || "gpt-5.4-nano"
    ),
    openAiReasoningEffort: (
      input.openAiFeeClinicalReasoningEffort
      || process.env.OPENAI_FEE_CLINICAL_REASONING_EFFORT
      || process.env.OPENAI_FACT_REASONING_EFFORT
      || process.env.OPENAI_SOAP_REASONING_EFFORT
      || "low"
    ),
    openAiTimeoutMs: Number(
      input.openAiFeeClinicalTimeoutMs
      || process.env.OPENAI_FEE_CLINICAL_TIMEOUT_MS
      || 12000
    ),
    clinicalFactsExtractor: input.clinicalFactsExtractor
  }));
  const patch = {};

  if (enriched.changed) {
    patch.orders = enriched.orders;
  }
  if (!hasEquivalentJson(session.calculationOptions || null, legacy.calculationOptions || null)) {
    patch.calculationOptions = legacy.calculationOptions || null;
  }
  if (!hasEquivalentJson(session.calculationOptionsAutoKeys || [], legacy.calculationOptionsAutoKeys || [])) {
    patch.calculationOptionsAutoKeys = legacy.calculationOptionsAutoKeys || [];
  }
  if (String(session.calculationOptionsSource || "") !== String(legacy.calculationOptionsSource || "")) {
    patch.calculationOptionsSource = legacy.calculationOptionsSource || null;
  }

  return {
    patch: Object.keys(patch).length ? patch : null,
    calculationOptions: legacy.calculationOptions,
    metrics: {
      ...(legacy.metrics || {}),
      stageTimings
    },
    reviewWarnings: uniqueStrings([
      ...(Array.isArray(legacy.reviewWarnings) ? legacy.reviewWarnings : []),
      ...unresolvedOrderWarnings(enriched.orders || baseSession.orders || [], legacy.calculationOptions || {})
    ])
  };
}

function buildCalculationInputForSession(session = {}, input = {}, prepared = {}) {
  const calculationInput = { ...input };
  if (!hasOwn(calculationInput, "claimContext") && isPlainObject(session.claimContext)) {
    calculationInput.claimContext = session.claimContext;
  }
  const preparedOptions = isPlainObject(prepared.calculationOptions) ? prepared.calculationOptions : null;
  const sessionOptions = preparedOptions || (isPlainObject(session.calculationOptions) ? session.calculationOptions : null);
  if (!hasOwn(calculationInput, "calculationOptions") && isPlainObject(sessionOptions)) {
    calculationInput.calculationOptions = sessionOptions;
  } else if (
    isPlainObject(sessionOptions)
    && isPlainObject(calculationInput.calculationOptions)
  ) {
    calculationInput.calculationOptions = {
      ...sessionOptions,
      ...calculationInput.calculationOptions
    };
  }

  return calculationInput;
}

async function enrichSessionOrdersForCalculation(session = {}, feeCalculator) {
  const orders = Array.isArray(session.orders) ? session.orders : [];
  if (!orders.length || typeof feeCalculator?.searchMaster !== "function") {
    const sanitizedOrders = orders.map(sanitizeOrderForCalculation);
    const changed = sanitizedOrders.some((order, index) => order !== orders[index]);
    return { changed, orders: sanitizedOrders };
  }

  let changed = false;
  const enrichedOrders = [];
  for (const order of orders) {
    const sanitized = sanitizeOrderForCalculation(order);
    const enriched = await enrichOrderForCalculation(sanitized, feeCalculator);
    if (enriched !== order) {
      changed = true;
    }
    enrichedOrders.push(enriched);
  }
  return { changed, orders: enrichedOrders };
}

async function enrichOrderForCalculation(order = {}, feeCalculator) {
  if (!shouldResolveOrderAgainstMaster(order)) {
    return order;
  }
  const query = orderMasterQuery(order);
  const type = masterTypeForOrder(order);
  try {
    const result = await feeCalculator.searchMaster({
      type,
      query,
      limit: 5
    });
    const item = selectMasterItemForOrder(result?.items, type, query);
    if (!item?.code) {
      return order;
    }
    return {
      ...order,
      localName: order.localName || item.name || query,
      standardCode: String(item.code),
      standardName: item.name || order.standardName || order.standard_name || ""
    };
  } catch {
    return order;
  }
}

function sanitizeOrderForCalculation(order = {}) {
  if (!order || typeof order !== "object") {
    return order;
  }
  const localName = String(order.localName || order.local_name || "").trim();
  if (!isAutoPlaceholderOrderName(localName) || !orderHasCode(order)) {
    return order;
  }
  const sanitized = { ...order };
  delete sanitized.standardCode;
  delete sanitized.standard_code;
  delete sanitized.standardName;
  delete sanitized.standard_name;
  delete sanitized.localCode;
  delete sanitized.local_code;
  return sanitized;
}

function shouldResolveOrderAgainstMaster(order = {}) {
  if (!order || typeof order !== "object" || orderHasCode(order)) {
    return false;
  }
  const query = orderMasterQuery(order);
  if (query.length < 2 || isAutoPlaceholderOrderName(query)) {
    return false;
  }
  const sourceSystem = String(order.sourceSystem || order.source_system || "").trim();
  const status = String(order.status || "").trim();
  if (["clinical_auto_placeholder", "clinical_auto_suggestion"].includes(sourceSystem)) {
    return false;
  }
  if (["suggested", "planned", "historical"].includes(status)) {
    return false;
  }
  return true;
}

function unresolvedOrderWarnings(orders = [], calculationOptions = {}) {
  return orders
    .filter((order) => order && typeof order === "object" && !orderHasCode(order))
    .filter((order) => {
      const name = orderMasterQuery(order);
      return name
        && !isPlaceholderResolvedByLegacyInput(name, calculationOptions)
        && (isAutoPlaceholderOrderName(name) || order.orderType === "unknown" || order.orderType === "other");
    })
    .map((order) => `オーダー「${orderMasterQuery(order)}」を標準コードまたは旧入力契約の構造化条件へ解決できませんでした。算定候補に反映するにはマスター検索で具体的な項目を選択してください。`);
}

function isPlaceholderResolvedByLegacyInput(name, calculationOptions = {}) {
  if (!isPlainObject(calculationOptions)) {
    return false;
  }
  if (name === "画像診断") {
    return Array.isArray(calculationOptions.imaging_orders) && calculationOptions.imaging_orders.length > 0;
  }
  if (name === "処置・手技") {
    return Array.isArray(calculationOptions.treatment_orders) && calculationOptions.treatment_orders.length > 0;
  }
  if (name === "薬剤処方") {
    return Array.isArray(calculationOptions.medication_orders) && calculationOptions.medication_orders.length > 0;
  }
  if (name === "特定器材・材料") {
    return Array.isArray(calculationOptions.material_inputs) && calculationOptions.material_inputs.length > 0;
  }
  return false;
}

function hasEquivalentJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function orderHasCode(order = {}) {
  return ["standardCode", "standard_code", "localCode", "local_code", "code"].some((key) => {
    const value = order[key];
    return typeof value === "string" && value.trim();
  });
}

function orderMasterQuery(order = {}) {
  return String(order.standardName || order.standard_name || order.localName || order.local_name || order.content || "").trim();
}

function masterTypeForOrder(order = {}) {
  const orderType = String(order.orderType || order.order_type || "").trim();
  if (orderType === "drug" || orderType === "injection") {
    return "drug";
  }
  if (orderType === "material") {
    return "material";
  }
  return "procedure";
}

function selectMasterItemForOrder(items = [], type, query) {
  if (!Array.isArray(items)) {
    return null;
  }
  const expectedKind = type === "drug" ? "drug" : type === "material" ? "material" : "procedure";
  const candidates = items.filter((item) => item && item.kind === expectedKind && item.code);
  if (!candidates.length) {
    return null;
  }
  const normalizedQuery = normalizeMasterMatchText(query);
  return candidates.find((item) => normalizeMasterMatchText(item.name) === normalizedQuery)
    || candidates.find((item) => normalizeMasterMatchText(item.baseName) === normalizedQuery)
    || candidates.find((item) => normalizeMasterMatchText(item.name).includes(normalizedQuery))
    || candidates[0];
}

function normalizeMasterMatchText(value) {
  return String(value || "").trim().replace(/\s+/gu, "").toLowerCase();
}

function addSessionReviewWarnings(session = {}, calculationResult = {}, extraWarnings = []) {
  const warnings = uniqueStrings([
    ...(Array.isArray(calculationResult.warnings) ? calculationResult.warnings : []),
    ...(Array.isArray(extraWarnings) ? extraWarnings : []),
    ...sessionLevelReviewWarnings(session)
  ]);
  if (
    warnings.length === 0
    && Number(calculationResult.totalPoints || 0) === 0
    && (!Array.isArray(calculationResult.lineItems) || calculationResult.lineItems.length === 0)
    && hasAnyCalculationInput(session)
  ) {
    warnings.push("算定可能な明細を作成できませんでした。カルテ本文の記載は検出されていますが、標準コードまたは旧入力契約の構造化条件へ変換できていません。");
  }
  return {
    ...calculationResult,
    warnings
  };
}

function hasAnyCalculationInput(session = {}) {
  return Boolean(String(session.clinicalText || "").trim())
    || (Array.isArray(session.orders) && session.orders.length > 0)
    || isPlainObject(session.claimContext)
    || isPlainObject(session.calculationOptions);
}

function sessionLevelReviewWarnings(session = {}) {
  const warnings = [];
  if (!hasDiagnosisInput(session)) {
    warnings.push("病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。");
  }
  if (session.setting === "inpatient") {
    warnings.push("入院/DPCは限定対応です。入院基本料候補とDPCレビューに留まり、確定算定として扱わないでください。");
  }
  return warnings;
}

function hasDiagnosisInput(session = {}) {
  if (Array.isArray(session.diagnoses) && session.diagnoses.some((diagnosis) => {
    if (!diagnosis || typeof diagnosis !== "object") return false;
    return Boolean(String(diagnosis.name || diagnosis.icd10Code || diagnosis.icd10_code || "").trim());
  })) {
    return true;
  }
  const claimContext = isPlainObject(session.claimContext) ? session.claimContext : {};
  return [
    claimContext.main_diagnosis,
    claimContext.resource_diagnosis,
    claimContext.diagnosis,
    claimContext.diagnosis_name
  ].some((value) => String(value || "").trim());
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function feeMasterStatus(feeCalculator) {
  return typeof feeCalculator.readiness === "function"
    ? feeCalculator.readiness()
    : { provider: "custom", masterDbConfigured: null, masterDbPathExists: null };
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

function accepted(body, headers = {}) {
  return { statusCode: 202, body, headers };
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
    "access-control-allow-headers": "authorization, content-type, x-csrf-token",
    "vary": "Origin"
  };
}

function isAllowedOrigin(origin) {
  return defaultAllowedWebOrigins().includes(origin)
    || configuredAllowedWebOrigins().includes(origin)
    || /^https:\/\/[a-z0-9-]+--halunasu-[a-z0-9-]+\.netlify\.app$/.test(origin)
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

function requireMutationCsrf(input, session) {
  if (hasBearerAuth(input.headers || {})) {
    return;
  }
  requirePlatformCsrf(input.headers || {}, session);
}

function hasBearerAuth(headers = {}) {
  return /^Bearer\s+\S+/iu.test(String(headerValue(headers, "authorization") || ""));
}

function safeLogError(error) {
  return [
    error?.name || "Error",
    error?.safeProviderMessage || error?.code || error?.message || ""
  ].map((value) => String(value || "").trim()).filter(Boolean).join(": ").slice(0, 240);
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

function masterSearchOptionsFromUrl(url) {
  const type = String(url.searchParams.get("type") || "all").trim().toLowerCase();
  const allowedTypes = new Set(["procedure", "drug", "material", "comment", "all"]);
  return {
    type: allowedTypes.has(type) ? type : "all",
    query: String(url.searchParams.get("q") || "").trim(),
    limit: Math.max(1, Math.min(Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10, 25))
  };
}

function masterBrowseOptionsFromUrl(url) {
  const type = String(url.searchParams.get("type") || "procedure").trim().toLowerCase();
  const allowedTypes = new Set(["procedure", "drug", "material", "comment"]);
  return {
    type: allowedTypes.has(type) ? type : "procedure",
    query: String(url.searchParams.get("q") || "").trim(),
    page: parsePositiveInteger(url.searchParams.get("page"), 1, 10_000),
    pageSize: parsePositiveInteger(url.searchParams.get("pageSize"), 50, 100)
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

function isStgEnvironment(env) {
  return String(env || "").trim().toLowerCase() === "stg";
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
