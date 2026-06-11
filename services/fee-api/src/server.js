import crypto from "node:crypto";
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
  buildCandidateWorkbench,
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
      logFeeApiError(error, {
        stage: "http_server",
        method: req.method,
        path: req.url
      });
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export async function handleFeeApiRequest(input = {}) {
  try {
    return withCors(input, await routeFeeApiRequest(input));
  } catch (error) {
    logFeeApiError(error, {
      stage: "route",
      method: input.method,
      path: input.path
    });
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
      ...diagnosesProvenanceForClientInput(normalized),
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
    const patch = await resolveFeeSessionPatch(context, platformStore, normalized, input.now || new Date(), current);
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

    return ok({
      ...result,
      receiptDraft: buildReceiptDraft(result.feeSession, { now: input.now || new Date() }),
      candidateWorkbench: buildCandidateWorkbench(result.feeSession, { now: input.now || new Date() })
    });
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

    return ok({
      ...result,
      receiptDraft: buildReceiptDraft(result.feeSession, { now: input.now || new Date() }),
      candidateWorkbench: buildCandidateWorkbench(result.feeSession, { now: input.now || new Date() })
    });
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "calculate") {
    requireMutationCsrf(input, context.session);
    const current = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!current) {
      return notFound("fee session not found");
    }
    assertFeeSessionReadyForCalculation(current);
    const calculationInput = validateCreateFeeCalculationInput(input.body || {});
    try {
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
    } catch (error) {
      await markFeeCalculationFailed({
        context,
        feeStore,
        feeSessionId: parts[3],
        error,
        now: input.now || new Date()
      });
      throw error;
    }
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
    reviewItems: buildReviewItems(feeSession),
    candidateWorkbench: buildCandidateWorkbench(feeSession, { now })
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
  const calculating = await feeStore.updateSession(context.session.orgId, feeSessionId, {
    status: "calculating",
    calculationProgress: feeCalculationProgress({
      phase: "extract",
      percent: 10,
      message: "カルテ本文から算定に必要な情報を抽出しています。",
      session: current,
      now: input.now || new Date()
    })
  });
  const { prepared, calculationSession } = await prepareFeeSessionForCalculation({
    context,
    feeCalculator,
    feeStore,
    platformStore,
    input,
    feeSessionId,
    session: calculating.feeSession,
    calculationInput,
    stageTimings
  });
  const progressed = await feeStore.updateSession(context.session.orgId, feeSessionId, {
    calculationProgress: feeCalculationProgress({
      phase: "calculate",
      percent: 55,
      message: "抽出した内容をマスターと照合し、算定候補を作成しています。",
      session: calculationSession,
      prepared,
      now: input.now || new Date()
    })
  });

  return calculatePreparedFeeSessionNow({
    context,
    feeCalculator,
    feeStore,
    platformStore,
    input,
    feeSessionId,
    calculationSession: progressed.feeSession,
    calculationInput,
    prepared,
    initialStageTimings: stageTimings,
    overallStartedAt
  });
}

async function prepareFeeSessionForCalculation({
  context,
  feeCalculator,
  feeStore,
  platformStore,
  input,
  feeSessionId,
  session,
  calculationInput,
  stageTimings,
  status = null
}) {
  const prepared = await timedCalculationStage({
    stage: "prepare",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => prepareSessionForCalculation(session, calculationInput, feeCalculator, {
      ...input,
      feeStore,
      platformStore,
      orgId: context.session.orgId,
      feeSessionId
    }),
    detail: (result) => ({
      clinicalStructuring: result?.metrics?.clinicalStructuring || null,
      ruleBasedClinicalInference: result?.metrics?.ruleBasedClinicalInference || null,
      prepareStageTimings: result?.metrics?.stageTimings || [],
      calculationOptionsKeys: Object.keys(result?.calculationOptions || {}),
      reviewWarningCount: Array.isArray(result?.reviewWarnings) ? result.reviewWarnings.length : 0
    })
  });
  const preparedPatch = prepared.patch || null;
  const patch = status ? { ...(preparedPatch || {}), status } : preparedPatch;
  const calculationSession = patch
    ? (await timedCalculationStage({
      stage: "savePreparedSession",
      orgId: context.session.orgId,
      feeSessionId,
      stageTimings,
      fn: () => feeStore.updateSession(context.session.orgId, feeSessionId, patch),
      detail: () => ({
        patchKeys: Object.keys(patch || {})
      })
    })).feeSession
    : session;

  return { prepared, calculationSession };
}

async function calculatePreparedFeeSessionNow({
  context,
  feeCalculator,
  feeStore,
  platformStore,
  input,
  feeSessionId,
  calculationSession,
  calculationInput,
  prepared,
  initialStageTimings = [],
  overallStartedAt = Date.now()
}) {
  const stageTimings = [...initialStageTimings];
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
  await feeStore.updateSession(context.session.orgId, feeSessionId, {
    calculationProgress: feeCalculationProgress({
      phase: "aggregate",
      percent: 85,
      message: "算定結果を集計し、レビュー項目を準備しています。",
      session: calculationSession,
      prepared,
      calculationResult,
      now: input.now || new Date()
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
      addSessionReviewWarnings(calculationSession, {
        ...calculationResult,
        candidateProposals: uniqueCandidateProposals([
          ...(Array.isArray(calculationResult.candidateProposals) ? calculationResult.candidateProposals : []),
          ...(Array.isArray(prepared.candidateProposals) ? prepared.candidateProposals : [])
        ]),
        clinicalEvents: Array.isArray(prepared.clinicalEvents) ? prepared.clinicalEvents : [],
        masterCandidates: Array.isArray(prepared.masterCandidates) ? prepared.masterCandidates : [],
        billingCandidates: Array.isArray(prepared.billingCandidates) ? prepared.billingCandidates : [],
        reviewIssues: Array.isArray(prepared.reviewIssues) ? prepared.reviewIssues : [],
        clinicalExtraction: prepared.clinicalExtraction || null,
        calculationProgress: feeCalculationProgress({
          phase: "complete",
          percent: 100,
          message: "算定候補の作成が完了しました。",
          session: calculationSession,
          prepared,
          calculationResult,
          now: input.now || new Date()
        })
      }, prepared.reviewWarnings)
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
    clinicalStructuring: prepared.metrics?.clinicalStructuring || null,
    ruleBasedClinicalInference: prepared.metrics?.ruleBasedClinicalInference || null
  }));

  return {
    ...result,
    receiptDraft: buildReceiptDraft(result.feeSession, { now: input.now || new Date() }),
    reviewItems: buildReviewItems(result.feeSession),
    candidateWorkbench: buildCandidateWorkbench(result.feeSession, { now: input.now || new Date() })
  };
}

async function markFeeCalculationFailed({
  context,
  feeStore,
  feeSessionId,
  error,
  now
}) {
  try {
    await feeStore.updateSession(context.session.orgId, feeSessionId, {
      status: "failed",
      calculationProgress: feeCalculationProgress({
        phase: "failed",
        percent: 100,
        message: "算定候補の作成に失敗しました。入力内容を確認してもう一度お試しください。",
        error,
        now
      })
    });
  } catch {
    // Preserve the original calculation error.
  }
}

function feeCalculationProgress({
  phase = "extract",
  percent = 0,
  message = "",
  session = {},
  prepared = null,
  calculationResult = null,
  error = null,
  now = new Date()
} = {}) {
  const normalizedPhase = String(phase || "extract");
  return {
    phase: normalizedPhase,
    label: feeCalculationPhaseLabel(normalizedPhase),
    message,
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    updatedAt: timestampForProgress(now),
    ...(prepared?.metrics ? { metrics: prepared.metrics } : {}),
    ...(error ? { error: safeLogError(error) } : {}),
    ...feeCalculationProgressPreview({ session, prepared, calculationResult })
  };
}

function feeCalculationPhaseLabel(phase) {
  return {
    extract: "抽出",
    calculate: "算定",
    aggregate: "集計",
    complete: "完了",
    failed: "失敗"
  }[phase] || "算定中";
}

function feeCalculationProgressPreview({ session = {}, prepared = null, calculationResult = null } = {}) {
  const calculationOptions = prepared?.calculationOptions || session.calculationOptions || {};
  const diagnoses = Array.isArray(session.diagnoses)
    ? session.diagnoses.map((item) => String(item?.name || item || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const extractedOrders = extractedOrderLabels(calculationOptions).slice(0, 8);
  const lineItems = Array.isArray(calculationResult?.lineItems)
    ? calculationResult.lineItems.map((line) => line?.name || line?.code || "").filter(Boolean).slice(0, 8)
    : [];

  return {
    diagnoses,
    extractedOrders,
    lineItems,
    totalPoints: calculationResult ? Number(calculationResult.totalPoints || 0) : null,
    lineItemCount: Array.isArray(calculationResult?.lineItems) ? calculationResult.lineItems.length : null,
    warningCount: Array.isArray(calculationResult?.warnings) ? calculationResult.warnings.length : null
  };
}

function extractedOrderLabels(options = {}) {
  if (!isPlainObject(options)) {
    return [];
  }
  const labels = [];
  if (options.outpatient_basic?.fee_kind) {
    labels.push(options.outpatient_basic.fee_kind === "initial" ? "初診料候補" : "再診料候補");
  }
  if (options.inpatient_basic?.basic_fee_code) {
    const days = Number(options.inpatient_basic.basic_fee_days || 1);
    labels.push(`入院基本料候補${days > 1 ? ` ${days}日分` : ""}`);
  }
  for (const order of Array.isArray(options.imaging_orders) ? options.imaging_orders : []) {
    labels.push(imagingProgressLabel(order));
  }
  for (const order of Array.isArray(options.treatment_orders) ? options.treatment_orders : []) {
    labels.push(treatmentProgressLabel(order));
  }
  const procedureCodeCount = Array.isArray(options.procedure_codes) ? options.procedure_codes.length : 0;
  if (procedureCodeCount) {
    labels.push(`診療行為候補 ${procedureCodeCount}件`);
  }
  const medicationCount = Array.isArray(options.medication_orders) ? options.medication_orders.length : 0;
  if (medicationCount) {
    labels.push(`薬剤候補 ${medicationCount}件`);
  }
  const materialCount = Array.isArray(options.material_inputs) ? options.material_inputs.length : 0;
  if (materialCount) {
    labels.push(`特定器材候補 ${materialCount}件`);
  }
  return labels.filter(Boolean);
}

function imagingProgressLabel(order = {}) {
  const kind = String(order.kind || "").trim();
  if (kind === "simple_radiography") return "単純X線候補";
  if (kind === "ct") return "CT候補";
  if (kind === "mri") return "MRI候補";
  if (kind === "ultrasound") return "超音波候補";
  return "画像診断候補";
}

function treatmentProgressLabel(order = {}) {
  return "処置候補";
}

function timestampForProgress(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value ? String(value) : new Date().toISOString();
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

async function loadPriorFeeSessionsForPatient({
  feeStore,
  orgId,
  session = {},
  feeSessionId = ""
} = {}) {
  if (
    !feeStore
    || typeof feeStore.listPriorSessionsForPatient !== "function"
    || !orgId
    || !session.patientId
  ) {
    return [];
  }
  try {
    return await feeStore.listPriorSessionsForPatient(orgId, session.patientId, {
      beforeServiceDate: session.serviceDate,
      includeSameServiceDate: true,
      excludeFeeSessionId: feeSessionId || session.feeSessionId,
      limit: 10
    });
  } catch {
    return [];
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

async function resolveFeeSessionPatch(context, platformStore, normalized, now, current = {}) {
  const patch = {
    ...normalized,
    ...calculationOptionsProvenanceForClientInput(normalized),
    ...diagnosesProvenanceForClientInput(normalized)
  };
  applyClinicalTextChangeGuards(patch, normalized, current);
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

function applyClinicalTextChangeGuards(patch, normalized, current = {}) {
  if (!hasOwn(normalized, "clinicalText")) {
    return;
  }
  const nextHash = clinicalTextHash(normalized.clinicalText || "");
  const currentHash = clinicalTextHash(current.clinicalText || "");
  if (nextHash === currentHash) {
    return;
  }

  const currentDiagnosisSource = String(current.diagnosesSource || "").trim();
  const nextDiagnosisSource = hasOwn(normalized, "diagnosesSource")
    ? String(normalized.diagnosesSource || "").trim()
    : currentDiagnosisSource;
  const carriesOverPreviousManualDiagnoses = nextDiagnosisSource === "manual"
    && currentDiagnosisSource === "manual"
    && hasOwn(normalized, "diagnoses")
    && sameDiagnosisNames(normalized.diagnoses, current.diagnoses || []);
  if (nextDiagnosisSource === "clinical_auto" || currentDiagnosisSource === "clinical_auto") {
    patch.diagnoses = [];
    patch.diagnosesSource = "clinical_auto";
    patch.diagnosesClinicalTextHash = nextHash;
  } else if (carriesOverPreviousManualDiagnoses) {
    patch.diagnoses = [];
    patch.diagnosesSource = "clinical_auto";
    patch.diagnosesClinicalTextHash = nextHash;
  }

  if (
    String(current.calculationOptionsSource || "").trim() === "clinical_auto"
    && !hasOwn(normalized, "calculationOptions")
  ) {
    patch.calculationOptions = null;
    patch.calculationOptionsSource = null;
    patch.calculationOptionsAutoKeys = [];
  }
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

function diagnosesProvenanceForClientInput(input = {}) {
  if (!hasOwn(input, "diagnoses")) {
    return {};
  }
  const source = String(input.diagnosesSource || "").trim();
  return {
    diagnosesSource: source || "manual",
    diagnosesClinicalTextHash: clinicalTextHash(input.clinicalText || "")
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
  const facilityProfile = await measureStage(stageTimings, "facilityProfile", () => loadFacilityProfileForCalculation({
    platformStore: input.platformStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession
  }));
  const priorSessions = await measureStage(stageTimings, "patientHistory", () => loadPriorFeeSessionsForPatient({
    feeStore: input.feeStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession,
    feeSessionId: input.feeSessionId || baseSession.feeSessionId
  }));
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
      || 0
    ),
    priorSessions,
    clinicalFactsExtractor: input.clinicalFactsExtractor
  }));
  const prepared = applyFacilityProfileToPreparation(legacy, facilityProfile);
  const patch = {};

  if (enriched.changed) {
    patch.orders = enriched.orders;
  }
  if (!hasEquivalentJson(session.calculationOptions || null, prepared.calculationOptions || null)) {
    patch.calculationOptions = prepared.calculationOptions || null;
  }
  if (!hasEquivalentJson(session.calculationOptionsAutoKeys || [], prepared.calculationOptionsAutoKeys || [])) {
    patch.calculationOptionsAutoKeys = prepared.calculationOptionsAutoKeys || [];
  }
  if (String(session.calculationOptionsSource || "") !== String(prepared.calculationOptionsSource || "")) {
    patch.calculationOptionsSource = prepared.calculationOptionsSource || null;
  }
  if (shouldApplyClinicalDiagnoses(baseSession, prepared.diagnoses, calculationInput)) {
    patch.diagnoses = prepared.diagnoses;
    patch.diagnosesSource = "clinical_auto";
    patch.diagnosesClinicalTextHash = clinicalTextHash(calculationInput.clinicalText || baseSession.clinicalText || "");
  } else if (shouldClearClinicalAutoDiagnoses(baseSession, prepared.diagnoses, calculationInput)) {
    patch.diagnoses = [];
    patch.diagnosesSource = "clinical_auto";
    patch.diagnosesClinicalTextHash = clinicalTextHash(calculationInput.clinicalText || baseSession.clinicalText || "");
  }

  return {
    patch: Object.keys(patch).length ? patch : null,
    calculationOptions: prepared.calculationOptions,
    candidateProposals: Array.isArray(prepared.candidateProposals) ? prepared.candidateProposals : [],
    clinicalEvents: Array.isArray(prepared.clinicalEvents) ? prepared.clinicalEvents : [],
    masterCandidates: Array.isArray(prepared.masterCandidates) ? prepared.masterCandidates : [],
    billingCandidates: Array.isArray(prepared.billingCandidates) ? prepared.billingCandidates : [],
    reviewIssues: Array.isArray(prepared.reviewIssues) ? prepared.reviewIssues : [],
    clinicalExtraction: prepared.clinicalExtraction || null,
    metrics: {
      ...(prepared.metrics || {}),
      patientHistory: {
        priorSessionCount: Array.isArray(priorSessions) ? priorSessions.length : 0
      },
      stageTimings
    },
    reviewWarnings: uniqueStrings([
      ...(Array.isArray(prepared.reviewWarnings) ? prepared.reviewWarnings : []),
      ...unresolvedOrderWarnings(enriched.orders || baseSession.orders || [], prepared.calculationOptions || {})
    ])
  };
}

async function loadFacilityProfileForCalculation({ platformStore, orgId, session = {} } = {}) {
  const facilityId = String(session.facilityId || session.facilitySnapshot?.facilityId || "").trim();
  if (!facilityId) {
    return {
      source: "missing_facility",
      facilityId: "",
      facilityStandardKeys: []
    };
  }
  const fromStore = platformStore?.getFacility
    ? await platformStore.getFacility(orgId, facilityId)
    : null;
  const facility = fromStore || session.facilitySnapshot || {};
  return {
    source: fromStore ? "platform_facility" : "session_snapshot",
    facilityId,
    facilityStandardKeys: uniqueStrings(facility.facilityStandardKeys || facility.facility_standard_keys || [])
  };
}

function applyFacilityProfileToPreparation(prepared = {}, facilityProfile = {}) {
  const facilityKeys = uniqueStrings(facilityProfile.facilityStandardKeys || []);
  const metrics = {
    ...(prepared.metrics || {}),
    facilityProfile: {
      source: facilityProfile.source || "none",
      facilityId: facilityProfile.facilityId || "",
      facilityStandardKeyCount: facilityKeys.length
    }
  };
  if (!facilityKeys.length) {
    return {
      ...prepared,
      metrics
    };
  }

  const currentOptions = isPlainObject(prepared.calculationOptions) ? prepared.calculationOptions : {};
  const mergedKeys = uniqueStrings([
    ...(Array.isArray(currentOptions.facility_standard_keys) ? currentOptions.facility_standard_keys : []),
    ...facilityKeys
  ]);
  return {
    ...prepared,
    calculationOptions: {
      ...currentOptions,
      facility_standard_keys: mergedKeys
    },
    calculationOptionsAutoKeys: uniqueStrings([
      ...(Array.isArray(prepared.calculationOptionsAutoKeys) ? prepared.calculationOptionsAutoKeys : []),
      "facility_standard_keys"
    ]),
    calculationOptionsSource: mergedCalculationOptionsSource(prepared.calculationOptionsSource),
    metrics
  };
}

function mergedCalculationOptionsSource(source = "") {
  const normalized = String(source || "").trim();
  if (!normalized) {
    return "clinical_auto";
  }
  if (normalized === "manual") {
    return "manual_with_clinical_auto";
  }
  return normalized;
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
  const warnings = normalizeCalculationWarnings([
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

function uniqueCandidateProposals(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const key = [
      value.proposalId,
      value.proposal_id,
      value.code,
      value.candidateLine?.code,
      value.candidate_line?.code,
      value.title
    ].map((part) => String(part || "").trim()).filter(Boolean).join("|");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeCalculationWarnings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const warning = normalizeCalculationWarning(value);
    if (!warning) {
      continue;
    }
    const key = calculationWarningKey(warning);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function normalizeCalculationWarning(value = "") {
  let warning = String(value || "").trim().replace(/\s+/gu, " ");
  if (!warning) {
    return "";
  }
  if (/Lab management fee skipped: facility_standard_not_found|facility_standard_not_found/u.test(warning)) {
    return "施設基準確認: 検体検査管理加算の届出確認が必要です。施設基準が登録されていないため、検体検査管理加算は自動追加していません。";
  }
  if (/hospital_profile_missing/u.test(warning)) {
    return warning.replace(/^hospital_profile_missing\s*[:：]\s*/u, "") || "施設基準を確認してください。";
  }
  if (/Outpatient rapid lab add-on skipped: same_day_result_explanation_and_document_required/i.test(warning)) {
    return "外来迅速検体検査加算は、当日説明・文書要件を確認できないため自動追加していません。";
  }
  if (/Required comment candidate:/i.test(warning)) {
    return warning
      .replace(/^Required comment candidate:\s*/iu, "レセプトコメントの確認: ")
      .replace(/\s+needs\s+/iu, " に必要なコメント: ");
  }
  if (/D026 judgement fee for group/i.test(warning)) {
    return "検査判断料の候補です。実施検査と同月算定条件を確認してください。";
  }
  if (/Collection fee requested by blood_venous/i.test(warning)) {
    return "静脈採血料の候補です。採血実施と算定条件を確認してください。";
  }
  if (/Imaging fee candidate for ct/i.test(warning)) {
    return "CT撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Imaging fee candidate for mri/i.test(warning)) {
    return "MRI撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Imaging fee candidate for simple_radiography/i.test(warning)) {
    return "単純X線に関する画像診断料候補です。撮影方式と写真診断区分を確認してください。";
  }
  if (/Medication fee candidate for in_house/i.test(warning)) {
    return "院内処方に関する投薬料候補です。処方内容と算定条件を確認してください。";
  }
  if (/Outpatient basic fee candidate for initial/i.test(warning)) {
    return "初診料の候補です。受診履歴と初診の条件を確認してください。";
  }
  if (/Outpatient basic fee candidate for revisit/i.test(warning)) {
    return "再診料の候補です。受診履歴と再診の条件を確認してください。";
  }
  if (/Input medical procedure code matched master only/i.test(warning)) {
    return "標準マスターには一致しましたが、章ごとの算定条件は未確認です。";
  }
  return warning.replace(/^[a-z][a-z0-9_]*\s*[:：]\s*/iu, "");
}

function calculationWarningKey(warning = "") {
  const text = String(warning || "").trim();
  const medication = text.match(/薬剤「([^」]+)」/u)?.[1];
  if (medication) {
    return `medication:${medication.replace(/\d+(?:\.\d+)?\s*(?:mg|g|μg|mL).*$/iu, "").trim()}:${warningReasonKey(text)}`;
  }
  if (/施設基準/u.test(text)) return `facility:${warningReasonKey(text)}`;
  if (/初診|再診|受診履歴|過去算定記録/u.test(text)) return `visit:${warningReasonKey(text)}`;
  const procedureCode = text.match(/\b(\d{6,})\b/u)?.[1];
  if (procedureCode) return `procedure:${procedureCode}:${warningReasonKey(text)}`;
  return text.replace(/\s+/gu, "").slice(0, 120);
}

function warningReasonKey(warning = "") {
  if (/(数量|日数|回数|総量).*(不足|不明|明記なし)/u.test(warning)) return "quantity";
  if (/(予定|依頼|次回|今後|検討)/u.test(warning)) return "planned";
  if (/(マスター|標準コード|未対応|自動確定|直接候補化できない)/u.test(warning)) return "unresolved";
  if (/施設基準/u.test(warning)) return "facility";
  if (/初診|再診|受診履歴|過去算定記録/u.test(warning)) return "visit";
  return warning.replace(/\s+/gu, "").slice(0, 80);
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

function shouldApplyClinicalDiagnoses(session = {}, inferredDiagnoses = [], calculationInput = {}) {
  if (!Array.isArray(inferredDiagnoses) || inferredDiagnoses.length === 0) {
    return false;
  }
  if (!hasDiagnosisInput(session)) {
    return true;
  }

  const source = String(session.diagnosesSource || "").trim();
  if (source === "manual") {
    return false;
  }

  const currentHash = clinicalTextHash(calculationInput.clinicalText || session.clinicalText || "");
  if (!source) {
    return Boolean(currentHash);
  }
  return source === "clinical_auto"
    && (
      String(session.diagnosesClinicalTextHash || "") !== currentHash
      || !sameDiagnosisNames(session.diagnoses, inferredDiagnoses)
    );
}

function shouldClearClinicalAutoDiagnoses(session = {}, inferredDiagnoses = [], calculationInput = {}) {
  if (Array.isArray(inferredDiagnoses) && inferredDiagnoses.length > 0) {
    return false;
  }
  if (String(session.diagnosesSource || "").trim() !== "clinical_auto") {
    return false;
  }
  if (!hasDiagnosisInput(session)) {
    return false;
  }
  return Boolean(clinicalTextHash(calculationInput.clinicalText || session.clinicalText || ""));
}

function sameDiagnosisNames(left = [], right = []) {
  const normalize = (values = []) => uniqueStrings((Array.isArray(values) ? values : [])
    .map((diagnosis) => diagnosis?.name || diagnosis?.displayName || diagnosis)
    .map((value) => String(value || "").replace(/\s+/gu, "").trim()))
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function clinicalTextHash(value) {
  const text = String(value || "")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (!text) {
    return "";
  }
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
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

function logFeeApiError(error, context = {}) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode < 500) {
    return;
  }

  console.error(JSON.stringify({
    event: "fee_api_error",
    statusCode,
    name: error.name || "Error",
    message: error.message || "Internal server error",
    stack: error.stack,
    stage: context.stage || "unknown",
    method: context.method || null,
    path: safeLogPath(context.path)
  }));
}

function safeLogPath(path) {
  try {
    return new URL(path || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
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
