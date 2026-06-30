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
  defaultFeeSettings,
  validateUpdateFeeSettingsInput,
  validateUpdateFeeSessionInput
} from "../../../packages/fee-contracts/src/index.js";
import iconv from "iconv-lite";
import {
  buildCandidateWorkbench,
  buildReceiptCsv,
  buildReceiptDenshin,
  buildReceiptDraft,
  buildMonthlyReceiptDraft,
  buildMonthlyBaselineDiagnosis,
  buildReceiptExportValidation,
  buildReviewItems,
  serializeUke
} from "../../../packages/fee-core/src/index.js";
import {
  departmentSnapshot,
  facilitySnapshot,
  insuranceSnapshot,
  patientSnapshot,
  validatePatchFacilityInput
} from "../../../packages/platform-contracts/src/index.js";
import {
  buildClinicalCalculationPreparation,
  isAutoPlaceholderOrderName
} from "./clinical-calculation-input.js";
import { buildClaimRiskReviewIssues } from "./claim-risk-knowledge.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import { createFeeCalculatorFromEnv } from "./python-calculator.js";
import { createFeeStoreFromEnv } from "./store/create-store.js";

const PRODUCT_ID = "fee";
const FEE_PRODUCT_ROLES = ["admin", "doctor", "nurse", "medical_clerk", "viewer"];
const DEFAULT_OPENAI_FEE_CLINICAL_TIMEOUT_MS = 60000;
const DEFAULT_FACILITY_PROFILE_CACHE_TTL_MS = 60_000;
const DEFAULT_ORDER_ENRICH_CONCURRENCY = 4;
const DEFAULT_MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_BASELINE_DIAGNOSIS_SESSION_LIMIT = 5000;
const DEFAULT_BASELINE_DIAGNOSIS_CLAIM_LIMIT = 5000;
const facilityProfileCache = new Map();
const facilityProfileStoreIds = new WeakMap();
let facilityProfileStoreIdCounter = 0;

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

      writeResponse(res, response);
    } catch (error) {
      logFeeApiError(error, {
        stage: "http_server",
        method: req.method,
        path: req.url
      });
      const response = errorResponse(error);
      writeResponse(res, response);
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
      feeCalculator: await feeCalculatorReadiness(feeCalculator),
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

  if (method === "POST" && matches(parts, ["v1", "fee", "internal", "calculation-jobs", "run"])) {
    requireCalculationWorkerAuth(input);
    const payload = decodeCalculationJobWorkerPayload(input.body || {});
    return ok(await runFeeCalculationJob({
      input,
      platformStore,
      feeStore,
      feeCalculator,
      payload
    }));
  }

  const context = await requireFeeContext(input, platformStore);

  if (method === "GET" && matches(parts, ["v1", "fee", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "bootstrap"])) {
    const include = bootstrapIncludeOptionsFromUrl(url);
    const [patients, facilities, departments, sessionList] = await Promise.all([
      include.patients ? platformStore.listPatients(context.session.orgId) : Promise.resolve(null),
      include.facilities ? platformStore.listFacilities(context.session.orgId) : Promise.resolve(null),
      include.departments ? platformStore.listDepartments(context.session.orgId) : Promise.resolve(null),
      include.sessions ? feeStore.listSessions(context.session.orgId, feeSessionListOptionsFromUrl(url)) : Promise.resolve(null)
    ]);
    return ok({
      ...(include.patients ? { patients } : {}),
      ...(include.facilities ? { facilities } : {}),
      ...(include.departments ? { departments } : {}),
      ...(include.masterStatus ? { masterStatus: feeMasterStatus(feeCalculator) } : {}),
      ...(sessionList || {})
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
    const options = patientListOptionsFromUrl(url);
    const patients = await platformStore.listPatients(context.session.orgId, options);
    return ok({ patients: filterPatientsForFeeSearch(patients, options) });
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "patients"]) && parts[4] === "billing-history") {
    const patientId = decodeURIComponent(parts[3]);
    const events = typeof feeStore.listBillingHistoryEventsForPatient === "function"
      ? await feeStore.listBillingHistoryEventsForPatient(context.session.orgId, patientId, billingHistoryListOptionsFromUrl(url))
      : [];
    return ok({ billingHistoryEvents: events });
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "patients"]) && parts[4] === "billing-history") {
    requireFeeAdminContext(context);
    requireMutationCsrf(input, context.session);
    const patientId = decodeURIComponent(parts[3]);
    const eventInput = normalizeBillingHistoryEventInput({ ...(input.body || {}), patientId });
    const event = typeof feeStore.createBillingHistoryEvent === "function"
      ? await feeStore.createBillingHistoryEvent(context.session.orgId, eventInput)
      : eventInput;
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.billing_history_imported",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patientId,
      productId: PRODUCT_ID,
      safePayload: {
        patientId,
        serviceDate: event.serviceDate,
        lineItemCount: Array.isArray(event.lineItems) ? event.lineItems.length : 0,
        source: event.source || "manual"
      }
    });
    return created({ billingHistoryEvent: event });
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

  if (method === "PATCH" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "facilities"])) {
    requireFeeAdminContext(context);
    requireMutationCsrf(input, context.session);
    const facilityId = decodeURIComponent(parts[3]);
    const patch = validatePatchFacilityInput(input.body || {});
    const facility = await platformStore.updateFacility(context.session.orgId, facilityId, patch);
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.facility_settings_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "facility",
      targetId: facility.facilityId,
      productId: PRODUCT_ID,
      safePayload: {
        facilityId: facility.facilityId,
        changedFields: Object.keys(patch).sort()
      }
    });
    clearFacilityProfileCacheFor(context.session.orgId, facilityId);
    return ok({ facility });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "departments"])) {
    return ok({ departments: await platformStore.listDepartments(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "settings"])) {
    const facilities = await platformStore.listFacilities(context.session.orgId);
    const settings = await feeSettingsForFacilities(feeStore, context.session.orgId, facilities);
    return ok({ facilities, settings });
  }

  if (method === "PATCH" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "settings"])) {
    requireFeeAdminContext(context);
    requireMutationCsrf(input, context.session);
    const facilityId = decodeURIComponent(parts[3]) || "default";
    const current = typeof feeStore.getFeeSettings === "function"
      ? await feeStore.getFeeSettings(context.session.orgId, facilityId)
      : null;
    const settings = validateUpdateFeeSettingsInput({
      ...(input.body || {}),
      facilityId,
      current: current || {}
    });
    const saved = typeof feeStore.updateFeeSettings === "function"
      ? await feeStore.updateFeeSettings(context.session.orgId, facilityId, settings)
      : settings;
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.settings_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_settings",
      targetId: facilityId,
      productId: PRODUCT_ID,
      safePayload: {
        facilityId,
        changedFields: Object.keys(input.body || {}).sort()
      }
    });
    return ok({ settings: saved });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "sessions"])) {
    return ok(await feeStore.listSessions(context.session.orgId, feeSessionListOptionsFromUrl(url)));
  }

  // #4段階A: 患者×月でセッションを名寄せした月次サマリ
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-summary"])) {
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const sessions = await feeStore.listSessions(context.session.orgId);
    const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
    return ok(buildMonthlyClaimSummary(sessionList, { claimMonth }));
  }

  // 導入前 一括レセプト差分診断: 既存レセ(baselineClaims) と 当社算定(セッション) を患者×月で突合
  if (method === "POST" && matches(parts, ["v1", "fee", "baseline-diagnosis"])) {
    if (!isStgEnvironment(input.env)) {
      return notFound("Route not found");
    }
    requireBaselineDiagnosisContext(context);
    requireMutationCsrf(input, context.session);
    const body = input.body || {};
    const claimMonth = String(body.claimMonth ?? body.claim_month ?? "").trim();
    if (!/^\d{4}-\d{2}$/u.test(claimMonth)) {
      throw requestValidationError("claimMonth must use YYYY-MM");
    }
    let baselineClaims = Array.isArray(body.baselineClaims ?? body.baseline_claims) ? (body.baselineClaims ?? body.baseline_claims) : [];
    // 既存レセのテキスト(UKE/CSV)が渡された場合は Python adapter で baselineClaims に変換する。
    const baselineText = String(body.baselineText ?? body.baseline_text ?? "");
    const baselineContentBase64 = String(body.baselineContentBase64 ?? body.baseline_content_base64 ?? "").trim();
    const baselineContentProvided = Boolean(baselineText || baselineContentBase64);
    const baselineFormat = String(body.baselineFormat ?? body.baseline_format ?? "").trim().toLowerCase();
    if (baselineContentProvided && !["uke", "csv"].includes(baselineFormat)) {
      throw requestValidationError("baselineFormat must be csv or uke when baseline content is provided");
    }
    if (baselineContentProvided && (baselineFormat === "uke" || baselineFormat === "csv")) {
      if (typeof feeCalculator.parseBaseline !== "function") {
        return { statusCode: 501, body: { error: "baseline_parser_unavailable", message: "既存レセ取込(Python adapter)が利用できません。" } };
      }
      const parsed = await feeCalculator.parseBaseline({
        op: baselineFormat === "uke" ? "parse_uke" : "parse_csv",
        ...(baselineContentBase64 ? { content_base64: baselineContentBase64 } : { text: baselineText }),
        encoding: String(body.baselineEncoding ?? body.baseline_encoding ?? "auto").trim() || "auto",
        claim_month: claimMonth,
        only_claim_month: claimMonth,
        uke_layout: isPlainObject(body.ukeLayout ?? body.uke_layout) ? (body.ukeLayout ?? body.uke_layout) : undefined,
        column_map: isPlainObject(body.columnMap ?? body.column_map) ? (body.columnMap ?? body.column_map) : undefined,
        only_medical_institution_code: body.onlyMedicalInstitutionCode ?? body.only_medical_institution_code ?? undefined,
        code_map: isPlainObject(body.codeMap ?? body.code_map) ? (body.codeMap ?? body.code_map) : undefined
      });
      baselineClaims = Array.isArray(parsed?.baselineClaims) ? parsed.baselineClaims : [];
    }
    baselineClaims = normalizeBaselineClaimsForDiagnosis(baselineClaims, {
      claimMonth,
      limit: baselineDiagnosisClaimLimit(input.processEnv || process.env)
    });
    if (baselineContentProvided && baselineClaims.length === 0) {
      throw requestValidationError("既存レセを取り込めませんでした。CSV列マッピング、請求月、文字コードを確認してください。");
    }
    const sessionList = await listSessionsForBaselineDiagnosis(feeStore, context.session.orgId, {
      claimMonth,
      limit: baselineDiagnosisSessionLimit(input.processEnv || process.env)
    });
    const diagnosis = buildMonthlyBaselineDiagnosis({
      sessions: sessionList,
      baselineClaims,
      claimMonth,
      knownUnsupportedCodes: Array.isArray(body.knownUnsupportedCodes ?? body.known_unsupported_codes) ? (body.knownUnsupportedCodes ?? body.known_unsupported_codes) : [],
      codeMap: isPlainObject(body.codeMap ?? body.code_map) ? (body.codeMap ?? body.code_map) : null
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.baseline_diagnosis_run",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_baseline_diagnosis",
      targetId: claimMonth,
      productId: PRODUCT_ID,
      safePayload: {
        claimMonth,
        baselineFormat: baselineFormat || (baselineClaims.length ? "claims" : "none"),
        baselineClaimCount: baselineClaims.length,
        sessionCount: sessionList.length,
        missingCandidateCount: diagnosis.summary?.missingCandidateCount || 0,
        needsReviewCount: diagnosis.summary?.needsReviewCount || 0,
        considerCount: diagnosis.summary?.considerCount || 0
      }
    });
    return ok(diagnosis);
  }

  // 患者×請求月で集計した月次レセプト案(プレビューのb=月次集計)
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-receipt"])) {
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const patientId = url.searchParams.get("patientId") || "";
    const sessions = await feeStore.listSessions(context.session.orgId);
    const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
    return ok({ receiptDraft: buildMonthlyReceiptDraft(sessionList, { patientId, claimMonth }) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-bulk-candidates"])) {
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const sessions = await feeStore.listSessions(context.session.orgId);
    const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
    return ok(buildMonthlyBulkCandidatePlan(sessionList, { claimMonth }));
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "monthly-bulk-jobs"])) {
    requireMutationCsrf(input, context.session);
    const claimMonth = String(input.body?.claimMonth ?? input.body?.claim_month ?? "").trim();
    const sessions = await feeStore.listSessions(context.session.orgId);
    const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
    const plan = buildMonthlyBulkCandidatePlan(sessionList, { claimMonth });
    const createdBulkJob = await feeStore.createMonthlyBulkJob(context.session.orgId, {
      claimMonth: plan.claimMonth,
      status: "planned",
      phase: "planned",
      items: plan.targets.map((target, index) => ({
        itemId: `bulk_item_${index + 1}`,
        feeSessionId: target.feeSessionId,
        patientId: target.patientId || null,
        patientName: target.patientName || "",
        serviceDate: target.serviceDate || null,
        status: target.canRun ? "pending" : "skipped",
        reason: target.reason,
        reasonLabel: target.reasonLabel,
        canRun: target.canRun,
        blockedReason: target.blockedReason || null
      })),
      createdByMemberId: context.session.memberId
    });
    let monthlyBulkJob = createdBulkJob.monthlyBulkJob;
    if (input.body?.autoRun !== false) {
      monthlyBulkJob = (await runMonthlyBulkJob({
        context,
        input,
        feeStore,
        platformStore,
        feeCalculator,
        monthlyBulkJobId: monthlyBulkJob.monthlyBulkJobId,
        retryFailed: false
      })).monthlyBulkJob;
    }
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.monthly_bulk_job_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_monthly_bulk_job",
      targetId: monthlyBulkJob.monthlyBulkJobId,
      productId: PRODUCT_ID,
      safePayload: {
        claimMonth: monthlyBulkJob.claimMonth,
        totalCount: monthlyBulkJob.progress?.totalCount || 0
      }
    });
    return accepted({ monthlyBulkJob, plan });
  }

  if (method === "GET" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "monthly-bulk-jobs"])) {
    const monthlyBulkJob = typeof feeStore.getMonthlyBulkJob === "function"
      ? await feeStore.getMonthlyBulkJob(context.session.orgId, parts[3])
      : null;
    if (!monthlyBulkJob) {
      return notFound("monthly bulk job not found");
    }
    return ok({ monthlyBulkJob });
  }

  if (method === "PATCH" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "monthly-bulk-jobs"])) {
    requireMutationCsrf(input, context.session);
    const action = String(input.body?.action || "").trim();
    if (action === "cancel") {
      return ok(await cancelMonthlyBulkJob({ context, feeStore, monthlyBulkJobId: parts[3] }));
    }
    if (action === "retry_failed") {
      return ok(await runMonthlyBulkJob({ context, input, feeStore, platformStore, feeCalculator, monthlyBulkJobId: parts[3], retryFailed: true }));
    }
    if (action === "run") {
      return ok(await runMonthlyBulkJob({ context, input, feeStore, platformStore, feeCalculator, monthlyBulkJobId: parts[3], retryFailed: false }));
    }
    if (action === "confirm_safe") {
      return ok(await confirmSafeMonthlyBulkJobSessions({ context, feeStore, monthlyBulkJobId: parts[3], now: input.now || new Date() }));
    }
    const error = new Error("unsupported monthly bulk job action");
    error.name = "ValidationError";
    error.statusCode = 400;
    throw error;
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
      insuranceSnapshot: patient
        ? insuranceSnapshot(patient, normalized.serviceDate || null, input.now || new Date())
        : null,
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
    return ok(await buildFeeSessionDetail(feeStore, context.session.orgId, parts[3], input.now || new Date(), feeSessionDetailOptionsFromUrl(url)));
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "debug-detail") {
    return ok(await buildFeeSessionDetail(feeStore, context.session.orgId, parts[3], input.now || new Date(), {
      ...feeSessionDetailOptionsFromUrl(url),
      includeDebug: true
    }));
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "detail-lite") {
    const statusView = typeof feeStore.getSessionStatus === "function"
      ? await feeStore.getSessionStatus(context.session.orgId, parts[3])
      : null;
    if (statusView) {
      return ok({ feeSession: statusView });
    }
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }
    return ok({ feeSession: feeSessionStatusView(session) });
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

    return ok(await feeSessionMutationResponse(feeStore, context.session.orgId, result, input.now || new Date()));
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "receipt-draft") {
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session });
    const receiptDraft = withReceiptExportValidation(buildReceiptDraft(session, { now: input.now || new Date() }), session, feeSettings);
    return ok({ receiptDraft, receiptExportValidation: receiptDraft.exportValidation });
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "receipt-validation") {
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }
    const receiptDraft = buildReceiptDraft(session, { now: input.now || new Date() });
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session });
    return ok({ receiptExportValidation: buildReceiptExportValidation(receiptDraft, receiptExportContext(session, feeSettings)) });
  }

  // レセコン取込用CSV(段階A): セッションから最新の receiptDraft を生成してCSV化
  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "receipt.csv") {
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }
    const receiptDraft = buildReceiptDraft(session, { now: input.now || new Date() });
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session });
    const exportContext = receiptExportContext(session, feeSettings);
    const validation = buildReceiptExportValidation(receiptDraft, exportContext);
    if (shouldBlockReceiptExport(url, validation, exportContext)) {
      return receiptExportValidationFailed(validation);
    }
    const csv = buildReceiptCsv(receiptDraft, exportContext);
    return {
      statusCode: 200,
      raw: true,
      body: csv,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "x-halunasu-export-status": validation.exportStatus,
        "x-halunasu-connector-status": exportContext.connectorSpecVerified ? "spec-verified" : "spec-unverified",
        "content-disposition": `attachment; filename="receipt_${parts[3]}.csv"`
      }
    };
  }

  // レセプト電算(UKE)出力(段階B): encoding で文字コードを選択(既定 Shift_JIS)
  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "receipt.uke") {
    const session = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!session) {
      return notFound("fee session not found");
    }
    const receiptDraft = buildReceiptDraft(session, { now: input.now || new Date() });
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session });
    const exportContext = receiptExportContext(session, feeSettings);
    const validation = buildReceiptExportValidation(receiptDraft, exportContext);
    if (shouldBlockReceiptExport(url, validation, exportContext)) {
      return receiptExportValidationFailed(validation);
    }
    const uke = serializeUke(buildReceiptDenshin(receiptDraft, exportContext));
    const encoding = normalizeUkeEncoding(url.searchParams.get("encoding") || exportContext.receiptPolicy?.ukeEncoding);
    const body = encoding === "shift_jis" ? iconv.encode(uke, "Shift_JIS") : Buffer.from(uke, "utf-8");
    const charset = encoding === "shift_jis" ? "shift_jis" : "utf-8";
    return {
      statusCode: 200,
      raw: true,
      body,
      headers: {
        "content-type": `text/plain; charset=${charset}`,
        "x-halunasu-export-status": validation.exportStatus,
        "x-halunasu-connector-status": exportContext.connectorSpecVerified ? "spec-verified" : "spec-unverified",
        "content-disposition": `attachment; filename="receipt_${parts[3]}.UKE"`
      }
    };
  }

  // 月次集計レセプトのCSV出力(scope=monthly)
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-receipt.csv"])) {
    const exportData = await loadMonthlyReceiptForExport({
      feeStore,
      orgId: context.session.orgId,
      patientId: url.searchParams.get("patientId") || "",
      claimMonth: url.searchParams.get("claimMonth") || "",
      now: input.now || new Date()
    });
    if (!exportData.base) {
      return notFound("monthly receipt has no calculated sessions");
    }
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session: exportData.base });
    const exportContext = { ...receiptExportContext(exportData.receiptDraft, feeSettings), actualDays: exportData.receiptDraft.actualDays };
    const validation = buildReceiptExportValidation(exportData.receiptDraft, exportContext);
    if (shouldBlockReceiptExport(url, validation, exportContext)) {
      return receiptExportValidationFailed(validation);
    }
    return {
      statusCode: 200,
      raw: true,
      body: buildReceiptCsv(exportData.receiptDraft, exportContext),
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "x-halunasu-export-status": validation.exportStatus,
        "x-halunasu-connector-status": exportContext.connectorSpecVerified ? "spec-verified" : "spec-unverified",
        "content-disposition": `attachment; filename="${monthlyReceiptFileName(exportData.receiptDraft, "csv")}"`
      }
    };
  }

  // 月次集計レセプトのレセ電(UKE)出力(scope=monthly)
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-receipt.uke"])) {
    const exportData = await loadMonthlyReceiptForExport({
      feeStore,
      orgId: context.session.orgId,
      patientId: url.searchParams.get("patientId") || "",
      claimMonth: url.searchParams.get("claimMonth") || "",
      now: input.now || new Date()
    });
    if (!exportData.base) {
      return notFound("monthly receipt has no calculated sessions");
    }
    const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId: context.session.orgId, session: exportData.base });
    const exportContext = { ...receiptExportContext(exportData.receiptDraft, feeSettings), actualDays: exportData.receiptDraft.actualDays };
    const validation = buildReceiptExportValidation(exportData.receiptDraft, exportContext);
    if (shouldBlockReceiptExport(url, validation, exportContext)) {
      return receiptExportValidationFailed(validation);
    }
    const uke = serializeUke(buildReceiptDenshin(exportData.receiptDraft, exportContext));
    const encoding = normalizeUkeEncoding(url.searchParams.get("encoding") || exportContext.receiptPolicy?.ukeEncoding);
    const body = encoding === "shift_jis" ? iconv.encode(uke, "Shift_JIS") : Buffer.from(uke, "utf-8");
    return {
      statusCode: 200,
      raw: true,
      body,
      headers: {
        "content-type": `text/plain; charset=${encoding === "shift_jis" ? "shift_jis" : "utf-8"}`,
        "x-halunasu-export-status": validation.exportStatus,
        "x-halunasu-connector-status": exportContext.connectorSpecVerified ? "spec-verified" : "spec-unverified",
        "content-disposition": `attachment; filename="${monthlyReceiptFileName(exportData.receiptDraft, "UKE")}"`
      }
    };
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "review-items") {
    return ok({ reviewItems: await feeStore.listReviewItems(context.session.orgId, parts[3]) });
  }

  if (method === "PATCH" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "review-items") {
    requireMutationCsrf(input, context.session);
    const decisions = normalizeReviewDecisionBatchInput(input.body || {});
    const result = await feeStore.decideReviewItems(context.session.orgId, parts[3], decisions);
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.review_items_decided",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_session",
      targetId: parts[3],
      productId: PRODUCT_ID,
      safePayload: {
        feeSessionId: result.feeSession.feeSessionId,
        decisionCount: decisions.length,
        statuses: decisions.map((decision) => decision.status)
      }
    });

    return ok(await feeSessionMutationResponse(feeStore, context.session.orgId, result, input.now || new Date()));
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

    return ok(await feeSessionMutationResponse(feeStore, context.session.orgId, result, input.now || new Date()));
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "calculation-jobs") {
    requireMutationCsrf(input, context.session);
    const current = await feeStore.getSession(context.session.orgId, parts[3]);
    if (!current) {
      return notFound("fee session not found");
    }
    assertFeeSessionReadyForCalculation(current);
    const calculationInput = validateCreateFeeCalculationInput(input.body || {});
    const result = await createFeeCalculationJob({
      context,
      feeStore,
      platformStore,
      input,
      feeSessionId: parts[3],
      current,
      calculationInput
    });
    return accepted(result);
  }

  if (method === "GET" && parts.length === 6 && matches(parts.slice(0, 3), ["v1", "fee", "sessions"]) && parts[4] === "calculation-jobs") {
    const calculationJob = typeof feeStore.getCalculationJob === "function"
      ? await feeStore.getCalculationJob(context.session.orgId, parts[3], decodeURIComponent(parts[5]))
      : null;
    if (!calculationJob) {
      return notFound("fee calculation job not found");
    }
    return ok({ calculationJob });
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

function requireFeeAdminContext(context = {}) {
  const session = context.session || {};
  const feeRoles = Array.isArray(session.productRoles?.[PRODUCT_ID]) ? session.productRoles[PRODUCT_ID] : [];
  const globalRoles = Array.isArray(session.globalRoles) ? session.globalRoles : [];
  if (feeRoles.includes("admin") || globalRoles.some((role) => ["platform_admin", "org_owner", "org_admin"].includes(role))) {
    return;
  }
  const error = new Error("Fee admin access is required");
  error.name = "ForbiddenError";
  error.statusCode = 403;
  throw error;
}

function requireBaselineDiagnosisContext(context = {}) {
  const session = context.session || {};
  const feeRoles = Array.isArray(session.productRoles?.[PRODUCT_ID]) ? session.productRoles[PRODUCT_ID] : [];
  const globalRoles = Array.isArray(session.globalRoles) ? session.globalRoles : [];
  if (
    feeRoles.some((role) => ["admin", "medical_clerk"].includes(role))
    || globalRoles.some((role) => ["platform_admin", "org_owner", "org_admin"].includes(role))
  ) {
    return;
  }
  const error = new Error("Fee baseline diagnosis access is required");
  error.name = "ForbiddenError";
  error.statusCode = 403;
  throw error;
}

async function feeSettingsForFacilities(feeStore, orgId, facilities = []) {
  const facilityIds = Array.isArray(facilities) && facilities.length
    ? facilities.map((facility) => facility.facilityId).filter(Boolean)
    : ["default"];
  const entries = await Promise.all(facilityIds.map(async (facilityId) => {
    const current = typeof feeStore.getFeeSettings === "function"
      ? await feeStore.getFeeSettings(orgId, facilityId)
      : null;
    return [facilityId, current || defaultFeeSettings({ facilityId })];
  }));
  if (!entries.some(([facilityId]) => facilityId === "default")) {
    const current = typeof feeStore.getFeeSettings === "function"
      ? await feeStore.getFeeSettings(orgId, "default")
      : null;
    entries.push(["default", current || defaultFeeSettings({ facilityId: "default" })]);
  }
  return Object.fromEntries(entries);
}

function billingHistoryListOptionsFromUrl(url) {
  return {
    beforeServiceDate: url.searchParams.get("beforeServiceDate") || "",
    sinceServiceDate: url.searchParams.get("sinceServiceDate") || "",
    includeSameServiceDate: url.searchParams.get("includeSameServiceDate") === "true",
    limit: Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100
  };
}

function normalizeBillingHistoryEventInput(input = {}) {
  const patientId = String(input.patientId || input.patient_id || "").trim();
  const serviceDate = String(input.serviceDate || input.service_date || "").trim();
  if (!patientId) {
    throw requestValidationError("patientId is required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw requestValidationError("serviceDate must use YYYY-MM-DD");
  }
  const rawLineItems = Array.isArray(input.lineItems) ? input.lineItems : input.line_items;
  const lineItems = (Array.isArray(rawLineItems) ? rawLineItems : [])
    .map((line, index) => normalizeBillingHistoryLineItem(line, index));
  if (!lineItems.length) {
    throw requestValidationError("lineItems requires at least one code");
  }
  return {
    patientId,
    serviceDate,
    source: String(input.source || "manual").trim() || "manual",
    sourceLabel: String(input.sourceLabel || input.source_label || "").trim() || null,
    confidence: String(input.confidence || "external").trim() || "external",
    lineItems
  };
}

function normalizeBillingHistoryLineItem(line = {}, index = 0) {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    throw requestValidationError(`lineItems[${index}] must be an object`);
  }
  const code = String(line.code || line.procedureCode || line.procedure_code || "").trim();
  if (!code) {
    throw requestValidationError(`lineItems[${index}].code is required`);
  }
  return {
    code,
    name: String(line.name || line.procedureName || line.procedure_name || "").trim() || "",
    status: String(line.status || "confirmed").trim() || "confirmed",
    includedInTotal: line.includedInTotal === false ? false : true
  };
}

function normalizeReviewDecisionBatchInput(input = {}) {
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  if (!decisions.length) {
    throw requestValidationError("decisions requires at least one review decision");
  }
  return decisions.map((decision, index) => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw requestValidationError(`decisions[${index}] must be an object`);
    }
    const reviewItemId = String(decision.reviewItemId || decision.review_item_id || "").trim();
    if (!reviewItemId) {
      throw requestValidationError(`decisions[${index}].reviewItemId is required`);
    }
    return {
      ...decision,
      reviewItemId,
      status: String(decision.status || "approved").trim() || "approved"
    };
  });
}

function requestValidationError(message) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  return error;
}

async function listSessionsForBaselineDiagnosis(feeStore, orgId, options = {}) {
  const claimMonth = String(options.claimMonth || "").trim();
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_BASELINE_DIAGNOSIS_SESSION_LIMIT);
  if (typeof feeStore.listSessionsForClaimMonth === "function") {
    const sessions = await feeStore.listSessionsForClaimMonth(orgId, claimMonth, { limit: limit + 1 });
    if (sessions.length > limit) {
      throw requestValidationError(`baseline diagnosis is limited to ${limit} sessions per claimMonth`);
    }
    return sessions;
  }

  const sessions = await feeStore.listSessions(orgId);
  const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
  const filtered = sessionList.filter((session) => baselineSessionClaimMonth(session) === claimMonth);
  if (filtered.length > limit) {
    throw requestValidationError(`baseline diagnosis is limited to ${limit} sessions per claimMonth`);
  }
  return filtered;
}

function normalizeBaselineClaimsForDiagnosis(claims = [], options = {}) {
  const claimMonth = String(options.claimMonth || "").trim();
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_BASELINE_DIAGNOSIS_CLAIM_LIMIT);
  const normalized = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!claim || typeof claim !== "object") {
      continue;
    }
    const patientId = String(claim.patientId ?? claim.patient_id ?? "").trim();
    const month = baselineSessionClaimMonth(claim) || claimMonth;
    if (!patientId || month !== claimMonth) {
      continue;
    }
    normalized.push({
      ...claim,
      patientId,
      claimMonth: month,
      lines: Array.isArray(claim.lines)
        ? claim.lines
        : (Array.isArray(claim.lineItems) ? claim.lineItems : [])
    });
    if (normalized.length > limit) {
      throw requestValidationError(`baseline diagnosis is limited to ${limit} baseline claims per claimMonth`);
    }
  }
  return normalized;
}

function baselineSessionClaimMonth(value = {}) {
  const raw = String(value.claimMonth ?? value.claim_month ?? (value.serviceDate ? String(value.serviceDate).slice(0, 7) : "") ?? "").trim();
  return raw ? raw.slice(0, 7) : "";
}

function baselineDiagnosisSessionLimit(env = process.env) {
  return parsePositiveInteger(env.FEE_BASELINE_DIAGNOSIS_SESSION_LIMIT, DEFAULT_BASELINE_DIAGNOSIS_SESSION_LIMIT, 50_000);
}

function baselineDiagnosisClaimLimit(env = process.env) {
  return parsePositiveInteger(env.FEE_BASELINE_DIAGNOSIS_CLAIM_LIMIT, DEFAULT_BASELINE_DIAGNOSIS_CLAIM_LIMIT, 50_000);
}

async function buildFeeSessionDetail(feeStore, orgId, feeSessionId, now, options = {}) {
  const feeSession = await feeStore.getSession(orgId, feeSessionId);
  if (!feeSession) {
    const error = new Error("fee session not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId, session: feeSession });
  const receiptDraft = withReceiptExportValidation(buildReceiptDraft(feeSession, { now }), feeSession, feeSettings);
  const reviewItems = buildReviewItems(feeSession);
  const candidateWorkbench = buildCandidateWorkbench(feeSession, { now, receiptDraft, reviewItems });
  return {
    feeSession: shouldIncludeFeeSessionDebug(options) ? feeSession : compactFeeSessionForWorkbench(feeSession),
    receiptDraft,
    receiptExportValidation: receiptDraft.exportValidation,
    ...(options.includeReviewItems === false ? {} : { reviewItems }),
    candidateWorkbench
  };
}

async function feeSessionMutationResponse(feeStore, orgId, result = {}, now = new Date()) {
  const feeSettings = await loadFeeSettingsForCalculation({ feeStore, orgId, session: result.feeSession });
  const receiptDraft = withReceiptExportValidation(buildReceiptDraft(result.feeSession, { now }), result.feeSession, feeSettings);
  const reviewItems = buildReviewItems(result.feeSession);
  return {
    ...result,
    receiptDraft,
    receiptExportValidation: receiptDraft.exportValidation,
    candidateWorkbench: buildCandidateWorkbench(result.feeSession, {
      now,
      receiptDraft,
      reviewItems
    })
  };
}

async function createFeeCalculationJob({
  context,
  feeStore,
  platformStore,
  input,
  feeSessionId,
  current,
  calculationInput
}) {
  if (typeof feeStore.createCalculationJob !== "function") {
    const error = new Error("fee calculation jobs are not supported by this store");
    error.name = "NotImplementedError";
    error.statusCode = 501;
    throw error;
  }
  const inputSnapshot = buildFeeCalculationInputSnapshot({
    session: current,
    calculationInput,
    calculationInputForSession: buildCalculationInputForSession(current, calculationInput, {}),
    prepared: {},
    capturedAt: input.now || new Date()
  });
  const createdJob = await feeStore.createCalculationJob(context.session.orgId, feeSessionId, {
    status: "queued",
    phase: "queued",
    calculationInput,
    inputSnapshot,
    createdByMemberId: context.session.memberId
  });
  const enqueue = await enqueueFeeCalculationJob({
    input,
    context,
    calculationJob: createdJob.calculationJob
  });
  const updatedJob = typeof feeStore.updateCalculationJob === "function"
    ? await feeStore.updateCalculationJob(context.session.orgId, feeSessionId, createdJob.calculationJob.calculationJobId, {
      status: enqueue.status || createdJob.calculationJob.status,
      phase: enqueue.phase || createdJob.calculationJob.phase,
      enqueueStatus: enqueue.enqueueStatus,
      enqueueProvider: enqueue.enqueueProvider,
      enqueueMessage: enqueue.enqueueMessage,
      progress: feeCalculationProgress({
        phase: ["queued", "waiting_for_worker"].includes(enqueue.status || createdJob.calculationJob.status) ? "queued" : "failed",
        percent: ["queued", "waiting_for_worker"].includes(enqueue.status || createdJob.calculationJob.status) ? 1 : 0,
        message: ["queued", "waiting_for_worker"].includes(enqueue.status || createdJob.calculationJob.status)
          ? "算定ジョブを受け付けました。"
          : "算定ジョブをキューに投入できませんでした。Cloud Tasks または Pub/Sub の設定を確認してください。",
        session: current,
        now: input.now || new Date()
      })
    })
    : createdJob;
  const jobWasQueued = ["queued", "waiting_for_worker"].includes(updatedJob.calculationJob.status);
  await feeStore.updateSession(context.session.orgId, feeSessionId, {
    ...(jobWasQueued ? { status: "calculating" } : {}),
    activeCalculationJobId: jobWasQueued ? updatedJob.calculationJob.calculationJobId : null,
    ...(jobWasQueued ? {} : {
      calculationProgress: updatedJob.calculationJob.progress || feeCalculationProgress({
        phase: "failed",
        percent: 0,
        message: "算定ジョブをキューに投入できませんでした。Cloud Tasks または Pub/Sub の設定を確認してください。",
        session: current,
        now: input.now || new Date()
      })
    })
  });
  await platformStore.createAuditEvent(context.session.orgId, {
    eventType: "fee.calculation_job_created",
    actorMemberId: context.session.memberId,
    actorLoginId: context.session.loginId,
    targetType: "fee_calculation_job",
    targetId: updatedJob.calculationJob.calculationJobId,
    productId: PRODUCT_ID,
    safePayload: {
      feeSessionId,
      calculationJobId: updatedJob.calculationJob.calculationJobId,
      enqueueStatus: updatedJob.calculationJob.enqueueStatus || null
    }
  });
  return {
    calculationJob: updatedJob.calculationJob
  };
}

async function runMonthlyBulkJob({
  context,
  input,
  feeStore,
  platformStore,
  monthlyBulkJobId,
  retryFailed = false
}) {
  if (typeof feeStore.getMonthlyBulkJob !== "function" || typeof feeStore.updateMonthlyBulkJob !== "function") {
    const error = new Error("monthly bulk jobs are not supported by this store");
    error.name = "NotImplementedError";
    error.statusCode = 501;
    throw error;
  }
  const currentJob = await feeStore.getMonthlyBulkJob(context.session.orgId, monthlyBulkJobId);
  if (!currentJob) {
    const error = new Error("monthly bulk job not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  if (currentJob.status === "canceled") {
    return { monthlyBulkJob: currentJob };
  }
  let job = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, {
    status: "running",
    phase: retryFailed ? "retry_failed" : "running",
    items: (currentJob.items || []).map((item) => (
      retryFailed && item.status === "failed" ? { ...item, status: "pending", errorMessage: null } : item
    ))
  })).monthlyBulkJob;
  const items = [...(job.items || [])];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.status !== "pending") {
      continue;
    }
    const latest = await feeStore.getMonthlyBulkJob(context.session.orgId, monthlyBulkJobId);
    if (latest?.status === "canceled") {
      items[index] = { ...item, status: "canceled", errorMessage: "ジョブがキャンセルされました。" };
      continue;
    }
    if (item.canRun === false) {
      items[index] = { ...item, status: "skipped", errorMessage: item.blockedReason || "算定に必要な入力が不足しています。" };
      job = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, { items, progress: monthlyBulkProgress(items) })).monthlyBulkJob;
      continue;
    }
    try {
      const session = await feeStore.getSession(context.session.orgId, item.feeSessionId);
      if (!session) {
        throw bulkJobError("fee session not found", "NotFoundError", 404);
      }
      assertFeeSessionReadyForCalculation(session);
      const result = await createFeeCalculationJob({
        context,
        feeStore,
        platformStore,
        input,
        feeSessionId: item.feeSessionId,
        current: session,
        calculationInput: validateCreateFeeCalculationInput({})
      });
      const queued = ["queued", "waiting_for_worker", "running"].includes(result.calculationJob?.status);
      items[index] = {
        ...item,
        status: queued ? "queued" : "failed",
        calculationJobId: result.calculationJob?.calculationJobId || null,
        enqueueStatus: result.calculationJob?.enqueueStatus || null,
        errorMessage: queued ? null : (result.calculationJob?.enqueueMessage || result.calculationJob?.enqueueStatus || "算定ジョブを投入できませんでした。")
      };
    } catch (error) {
      items[index] = {
        ...item,
        status: "failed",
        errorMessage: error.message || "算定ジョブを投入できませんでした。"
      };
    }
    job = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, { items, progress: monthlyBulkProgress(items) })).monthlyBulkJob;
  }

  const progress = monthlyBulkProgress(items);
  job = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, {
    status: progress.failedCount > 0 ? "completed_with_errors" : "completed",
    phase: "complete",
    items,
    progress,
    resultSummary: {
      queuedCount: progress.queuedCount,
      failedCount: progress.failedCount,
      skippedCount: progress.skippedCount,
      canceledCount: progress.canceledCount
    }
  })).monthlyBulkJob;
  return { monthlyBulkJob: job };
}

async function cancelMonthlyBulkJob({ context, feeStore, monthlyBulkJobId }) {
  const currentJob = await feeStore.getMonthlyBulkJob(context.session.orgId, monthlyBulkJobId);
  if (!currentJob) {
    const error = new Error("monthly bulk job not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  const items = (currentJob.items || []).map((item) => (
    item.status === "pending" ? { ...item, status: "canceled", errorMessage: "ジョブがキャンセルされました。" } : item
  ));
  const monthlyBulkJob = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, {
    status: "canceled",
    phase: "canceled",
    items,
    progress: monthlyBulkProgress(items)
  })).monthlyBulkJob;
  return { monthlyBulkJob };
}

async function confirmSafeMonthlyBulkJobSessions({ context, feeStore, monthlyBulkJobId, now }) {
  const currentJob = await feeStore.getMonthlyBulkJob(context.session.orgId, monthlyBulkJobId);
  if (!currentJob) {
    const error = new Error("monthly bulk job not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  let confirmedCount = 0;
  const items = [];
  for (const item of currentJob.items || []) {
    const session = await feeStore.getSession(context.session.orgId, item.feeSessionId);
    if (!session) {
      items.push({ ...item, safeConfirmStatus: "failed", safeConfirmMessage: "fee session not found" });
      continue;
    }
    const readiness = feeMonthlySessionReadiness(session);
    if (!readiness.readyForClaim) {
      items.push({ ...item, safeConfirmStatus: "blocked", safeConfirmMessage: "要確認、病名不足、詳記未対応、未算定のいずれかがあります。" });
      continue;
    }
    await feeStore.updateSession(context.session.orgId, item.feeSessionId, {
      monthlyClaimWork: monthlyClaimWorkPatch({
        ...(session.monthlyClaimWork || {}),
        status: "ready_for_claim",
        note: session.monthlyClaimWork?.note || "一括候補化でリスクなしとして確認"
      }, {
        memberId: context.session.memberId,
        now
      })
    });
    confirmedCount += 1;
    items.push({ ...item, safeConfirmStatus: "confirmed", safeConfirmMessage: null });
  }
  const monthlyBulkJob = (await feeStore.updateMonthlyBulkJob(context.session.orgId, monthlyBulkJobId, {
    items,
    resultSummary: {
      ...(currentJob.resultSummary || {}),
      safeConfirmedCount: confirmedCount
    }
  })).monthlyBulkJob;
  return { monthlyBulkJob, confirmedCount };
}

function monthlyBulkProgress(items = []) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item.status || "pending");
    counts[status] = Number(counts[status] || 0) + 1;
  }
  const totalCount = Array.isArray(items) ? items.length : 0;
  const processedCount = ["queued", "succeeded", "failed", "skipped", "canceled"].reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  return {
    totalCount,
    processedCount,
    pendingCount: Number(counts.pending || 0),
    queuedCount: Number(counts.queued || 0),
    succeededCount: Number(counts.succeeded || 0),
    failedCount: Number(counts.failed || 0),
    skippedCount: Number(counts.skipped || 0),
    canceledCount: Number(counts.canceled || 0),
    percent: totalCount ? Math.round((processedCount / totalCount) * 100) : 100
  };
}

function bulkJobError(message, name = "Error", statusCode = 500) {
  const error = new Error(message);
  error.name = name;
  error.statusCode = statusCode;
  return error;
}

async function enqueueFeeCalculationJob({ input = {}, calculationJob = {} } = {}) {
  const env = input.processEnv || process.env;
  const cloudTasksQueue = String(env.FEE_CALCULATION_CLOUD_TASKS_QUEUE || env.FEE_CALCULATION_TASK_QUEUE || "").trim();
  const pubsubTopic = String(env.FEE_CALCULATION_PUBSUB_TOPIC || "").trim();
  const workerUrl = String(env.FEE_CALCULATION_WORKER_URL || "").trim();
  const workerToken = String(env.FEE_CALCULATION_WORKER_TOKEN || "").trim();
  const oidcServiceAccountEmail = String(env.FEE_CALCULATION_WORKER_OIDC_SERVICE_ACCOUNT_EMAIL || "").trim();
  const oidcAudience = String(env.FEE_CALCULATION_WORKER_OIDC_AUDIENCE || workerUrl || "").trim();
  const workerAuthMode = String(env.FEE_CALCULATION_WORKER_AUTH_MODE || "").trim().toLowerCase();
  const payload = calculationJobWorkerPayload(calculationJob);
  if (!cloudTasksQueue && !pubsubTopic) {
    return {
      status: "enqueue_failed",
      phase: "enqueue",
      enqueueStatus: "not_configured",
      enqueueProvider: null,
      enqueueMessage: "Set FEE_CALCULATION_CLOUD_TASKS_QUEUE or FEE_CALCULATION_PUBSUB_TOPIC to enqueue asynchronous fee calculations."
    };
  }
  try {
    if (cloudTasksQueue) {
      if (!workerUrl) {
        return enqueueFailure("cloud_tasks", "missing_worker_url", "Set FEE_CALCULATION_WORKER_URL when using Cloud Tasks.");
      }
      if (!workerToken && !oidcServiceAccountEmail && !isTestEnvironment(input.env)) {
        return enqueueFailure(
          "cloud_tasks",
          "missing_worker_auth",
          "Set FEE_CALCULATION_WORKER_TOKEN or FEE_CALCULATION_WORKER_OIDC_SERVICE_ACCOUNT_EMAIL for Cloud Tasks worker authentication."
        );
      }
      if (!workerToken && oidcServiceAccountEmail && workerAuthMode !== "iam" && !isTestEnvironment(input.env)) {
        return enqueueFailure(
          "cloud_tasks",
          "missing_worker_auth_mode",
          "Set FEE_CALCULATION_WORKER_AUTH_MODE=iam when Cloud Tasks uses OIDC authentication."
        );
      }
      const queuePath = cloudTasksQueuePath(cloudTasksQueue, input.projectId, input.region);
      const task = {
        httpRequest: {
          httpMethod: "POST",
          url: workerUrl,
          headers: {
            "content-type": "application/json",
            ...(workerToken ? { "x-fee-worker-token": workerToken } : {})
          },
          body: base64Json(payload),
          ...(oidcServiceAccountEmail ? {
            oidcToken: {
              serviceAccountEmail: oidcServiceAccountEmail,
              ...(oidcAudience ? { audience: oidcAudience } : {})
            }
          } : {})
        }
      };
      const response = typeof input.cloudTasksClient?.createTask === "function"
        ? await input.cloudTasksClient.createTask({ parent: queuePath, task })
        : await createCloudTaskViaRest({
          env,
          queuePath,
          task
        });
      return enqueueSuccess("cloud_tasks", response?.name || response?.taskName || null);
    }
    const topicPath = pubsubTopicPath(pubsubTopic, input.projectId);
    const message = {
      data: base64Json(payload),
      attributes: {
        type: "fee_calculation_job",
        orgId: String(payload.orgId || ""),
        feeSessionId: String(payload.feeSessionId || ""),
        calculationJobId: String(payload.calculationJobId || "")
      }
    };
    const response = typeof input.pubSubClient?.publishMessage === "function"
      ? await input.pubSubClient.publishMessage({ topic: topicPath, message })
      : await publishPubSubMessageViaRest({
        env,
        topicPath,
        message
      });
    return enqueueSuccess("pubsub", response?.messageId || response?.messageIds?.[0] || null);
  } catch (error) {
    return enqueueFailure(
      cloudTasksQueue ? "cloud_tasks" : "pubsub",
      "enqueue_error",
      safeLogError(error)
    );
  }
}

function calculationJobWorkerPayload(calculationJob = {}) {
  return {
    type: "fee_calculation_job",
    orgId: calculationJob.orgId || "",
    feeSessionId: calculationJob.feeSessionId || "",
    calculationJobId: calculationJob.calculationJobId || calculationJob.jobId || ""
  };
}

function enqueueSuccess(provider, providerMessageId = null) {
  return {
    status: "queued",
    phase: "queued",
    enqueueStatus: "queued",
    enqueueProvider: provider,
    enqueueMessage: providerMessageId ? `queued:${providerMessageId}` : "queued"
  };
}

function enqueueFailure(provider, status, message) {
  return {
    status: "enqueue_failed",
    phase: "enqueue",
    enqueueStatus: status,
    enqueueProvider: provider,
    enqueueMessage: message
  };
}

function cloudTasksQueuePath(queue, projectId, region) {
  if (/^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/u.test(queue)) {
    return queue;
  }
  return `projects/${encodeURIComponent(projectId || "medical-core-stg")}/locations/${encodeURIComponent(region || "asia-northeast1")}/queues/${encodeURIComponent(queue)}`;
}

function pubsubTopicPath(topic, projectId) {
  if (/^projects\/[^/]+\/topics\/[^/]+$/u.test(topic)) {
    return topic;
  }
  return `projects/${encodeURIComponent(projectId || "medical-core-stg")}/topics/${encodeURIComponent(topic)}`;
}

async function createCloudTaskViaRest({ env, queuePath, task }) {
  const accessToken = await googleAccessToken(env);
  const response = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ task })
  });
  return parseGoogleApiJsonResponse(response, "Cloud Tasks enqueue failed");
}

async function publishPubSubMessageViaRest({ env, topicPath, message }) {
  const accessToken = await googleAccessToken(env);
  const response = await fetch(`https://pubsub.googleapis.com/v1/${topicPath}:publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ messages: [message] })
  });
  return parseGoogleApiJsonResponse(response, "Pub/Sub publish failed");
}

async function googleAccessToken(env = {}) {
  const configured = String(env.GOOGLE_OAUTH_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || "").trim();
  if (configured) {
    return configured;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "metadata-flavor": "Google" },
      signal: controller.signal
    });
    const body = await parseGoogleApiJsonResponse(response, "Metadata token request failed");
    if (!body?.access_token) {
      throw new Error("Metadata token response did not include access_token");
    }
    return body.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseGoogleApiJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || fallbackMessage);
    error.statusCode = response.status;
    error.safeProviderMessage = body?.error?.status || body?.error?.message || fallbackMessage;
    throw error;
  }
  return body;
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

async function runFeeCalculationJob({
  input = {},
  platformStore,
  feeStore,
  feeCalculator,
  payload = {}
}) {
  const orgId = String(payload.orgId || "").trim();
  const feeSessionId = String(payload.feeSessionId || "").trim();
  const calculationJobId = String(payload.calculationJobId || payload.jobId || "").trim();
  if (!orgId || !feeSessionId || !calculationJobId) {
    const error = new Error("calculation job payload requires orgId, feeSessionId, and calculationJobId");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }
  const job = typeof feeStore.getCalculationJob === "function"
    ? await feeStore.getCalculationJob(orgId, feeSessionId, calculationJobId)
    : null;
  if (!job) {
    const error = new Error("fee calculation job not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  if (job.status === "succeeded") {
    return { calculationJob: job, alreadyCompleted: true };
  }
  const now = input.now || new Date();
  const runningJob = typeof feeStore.updateCalculationJob === "function"
    ? (await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
      status: "running",
      phase: "extract",
      attemptCount: Number(job.attemptCount || 0) + 1,
      startedAt: job.startedAt || timestampForSnapshot(now),
      lastAttemptAt: timestampForSnapshot(now)
    })).calculationJob
    : job;
  const current = await feeStore.getSession(orgId, feeSessionId);
  if (!current) {
    const error = new Error("fee session not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  const context = {
    session: {
      orgId,
      memberId: runningJob.createdByMemberId || "fee-worker",
      loginId: "fee-worker"
    }
  };
  try {
    const result = await calculateFeeSessionNow({
      context,
      feeCalculator,
      feeStore,
      platformStore,
      input,
      feeSessionId,
      current,
      calculationInput: isPlainObject(runningJob.calculationInput) ? runningJob.calculationInput : {},
      calculationJobId
    });
    const completedJob = typeof feeStore.updateCalculationJob === "function"
      ? (await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
        status: "succeeded",
        phase: "complete",
        completedAt: timestampForSnapshot(input.now || new Date()),
        progress: result.feeSession?.calculationProgress || null,
        resultSummary: {
          calculationId: result.calculationResult?.calculationId || null,
          totalPoints: Number(result.calculationResult?.totalPoints || 0),
          feeSessionStatus: result.feeSession?.status || null
        }
      })).calculationJob
      : runningJob;
    return {
      calculationJob: completedJob,
      feeSession: result.feeSession,
      receiptDraft: result.receiptDraft,
      candidateWorkbench: result.candidateWorkbench
    };
  } catch (error) {
    if (typeof feeStore.updateCalculationJob === "function") {
      await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
        status: "failed",
        phase: "failed",
        completedAt: timestampForSnapshot(input.now || new Date()),
        error: {
          name: error.name || "Error",
          message: safeLogError(error)
        }
      });
    }
    await markFeeCalculationFailed({
      context,
      feeStore,
      feeSessionId,
      error,
      now: input.now || new Date()
    });
    throw error;
  }
}

async function updateFeeCalculationProgress({
  feeStore,
  orgId,
  feeSessionId,
  calculationJobId = null,
  session = {},
  sessionPatch = null,
  progress
}) {
  if (calculationJobId && typeof feeStore.updateCalculationJob === "function") {
    await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
      phase: progress?.phase || "running",
      progress
    });
    if (sessionPatch && Object.keys(sessionPatch).length) {
      const result = await feeStore.updateSession(orgId, feeSessionId, sessionPatch);
      return { feeSession: result.feeSession };
    }
    return { feeSession: session };
  }

  return feeStore.updateSession(orgId, feeSessionId, {
    ...(sessionPatch || {}),
    calculationProgress: progress
  });
}

async function calculateFeeSessionNow({
  context,
  feeCalculator,
  feeStore,
  platformStore,
  input,
  feeSessionId,
  current,
  calculationInput,
  calculationJobId = null
}) {
  const overallStartedAt = Date.now();
  const stageTimings = [];
  const previousCalculationResult = isPlainObject(current.calculationResult) ? current.calculationResult : null;
  const calculating = await updateFeeCalculationProgress({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    session: current,
    sessionPatch: { status: "calculating" },
    progress: feeCalculationProgress({
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
    previousCalculationResult,
    stageTimings
  });
  const progressed = await updateFeeCalculationProgress({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    session: calculationSession,
    progress: feeCalculationProgress({
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
    overallStartedAt,
    calculationJobId
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
  previousCalculationResult = null,
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
      feeSessionId,
      previousCalculationResult
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
  overallStartedAt = Date.now(),
  calculationJobId = null
}) {
  const stageTimings = [...initialStageTimings];
  const calculationInputForSession = buildCalculationInputForSession(calculationSession, calculationInput, prepared);
  const inputSnapshot = buildFeeCalculationInputSnapshot({
    session: calculationSession,
    calculationInput,
    calculationInputForSession,
    prepared,
    capturedAt: input.now || new Date()
  });
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
  await updateFeeCalculationProgress({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    session: calculationSession,
    progress: feeCalculationProgress({
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
        canonicalClinicalFacts: Array.isArray(prepared.canonicalClinicalFacts) ? prepared.canonicalClinicalFacts : [],
        masterCandidates: Array.isArray(prepared.masterCandidates) ? prepared.masterCandidates : [],
        billingCandidates: Array.isArray(prepared.billingCandidates) ? prepared.billingCandidates : [],
        reviewIssues: [
          ...(Array.isArray(prepared.reviewIssues) ? prepared.reviewIssues : []),
          ...buildClaimRiskReviewIssues(calculationSession, {
            ...calculationResult,
            clinicalEvents: Array.isArray(prepared.clinicalEvents) ? prepared.clinicalEvents : []
          })
        ],
        clinicalExtraction: prepared.clinicalExtraction || null,
        shadowCalculations: Array.isArray(prepared.shadowCalculations) ? prepared.shadowCalculations : [],
        inputSnapshot,
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
    ruleBasedClinicalInference: prepared.metrics?.ruleBasedClinicalInference || null,
    shadowCalculations: shadowCalculationLogSummary(prepared.shadowCalculations || [])
  }));

  const receiptDraft = buildReceiptDraft(result.feeSession, { now: input.now || new Date() });
  const reviewItems = buildReviewItems(result.feeSession);
  return {
    ...result,
    receiptDraft,
    reviewItems,
    candidateWorkbench: buildCandidateWorkbench(result.feeSession, {
      now: input.now || new Date(),
      receiptDraft,
      reviewItems
    })
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
      activeCalculationJobId: null,
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
  feeSessionId = "",
  feeSettings = null
} = {}) {
  if (
    !feeStore
    || typeof feeStore.listPriorSessionsForPatient !== "function"
    || !orgId
    || !session.patientId
  ) {
    return [];
  }
  const lookbackMonths = historyLookbackMonths(feeSettings);
  const sinceServiceDate = subtractMonthsDate(session.serviceDate, lookbackMonths);
  try {
    return await feeStore.listPriorSessionsForPatient(orgId, session.patientId, {
      beforeServiceDate: session.serviceDate,
      includeSameServiceDate: true,
      excludeFeeSessionId: feeSessionId || session.feeSessionId,
      sinceServiceDate,
      limit: historyLookbackLimit(lookbackMonths)
    });
  } catch {
    return [];
  }
}

async function loadPriorBillingHistoryForPatient({
  feeStore,
  orgId,
  session = {},
  feeSettings = null
} = {}) {
  if (
    !feeSettings?.historyPolicy?.externalHistoryEnabled
    || !feeStore
    || typeof feeStore.listBillingHistoryEventsForPatient !== "function"
    || !orgId
    || !session.patientId
  ) {
    return [];
  }
  const lookbackMonths = historyLookbackMonths(feeSettings);
  const sinceServiceDate = subtractMonthsDate(session.serviceDate, lookbackMonths);
  try {
    return await feeStore.listBillingHistoryEventsForPatient(orgId, session.patientId, {
      beforeServiceDate: session.serviceDate,
      includeSameServiceDate: true,
      sinceServiceDate,
      limit: historyLookbackLimit(lookbackMonths)
    });
  } catch {
    return [];
  }
}

function billingHistoryEventsAsPriorSessions(events = []) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    feeSessionId: `external:${event.historyEventId || event.serviceDate || ""}`,
    serviceDate: event.serviceDate || "",
    sourceSystem: event.source || "external",
    calculationResult: {
      lineItems: Array.isArray(event.lineItems) ? event.lineItems : []
    },
    diagnoses: []
  }));
}

function historyLookbackMonths(feeSettings = null) {
  const configured = Number.parseInt(feeSettings?.historyPolicy?.defaultLookbackMonths, 10);
  if (!Number.isFinite(configured)) {
    return 12;
  }
  return Math.min(12, Math.max(1, configured));
}

function historyLookbackLimit(lookbackMonths = 12) {
  return Math.min(500, Math.max(50, Number(lookbackMonths || 12) * 20));
}

function subtractMonthsDate(serviceDate = "", months = 12) {
  const date = parseIsoDate(serviceDate);
  if (!date) {
    return "";
  }
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  result.setUTCMonth(result.getUTCMonth() - Math.min(12, Math.max(1, Number(months || 12))));
  return result.toISOString().slice(0, 10);
}

// #4段階A: セッションを患者×月で名寄せし、月次サマリ(患者別の受診一覧・合計点数)を作る。
export function buildMonthlyClaimSummary(sessions = [], { claimMonth = "" } = {}) {
  const month = String(claimMonth || "").trim();
  const sessionMonthOf = (session) => String(session.claimMonth || String(session.serviceDate || "").slice(0, 7));
  const groups = new Map();
  const totals = {
    calculatedCount: 0,
    needsReviewCount: 0,
    missingDiagnosisCount: 0,
    symptomDetailCandidateCount: 0,
    pendingReceiptAnnotationCount: 0,
    confirmedReceiptAnnotationCount: 0,
    readyForClaimCount: 0,
    blockedCount: 0,
    uncalculatedCount: 0,
    diagnosisRequestCandidateCount: 0,
    doctorConfirmationCandidateCount: 0,
    workStatusCounts: emptyMonthlyWorkStatusCounts()
  };

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (month && sessionMonthOf(session) !== month) {
      continue;
    }
    const patientKey = String(session.patientId || "").trim() || "__unassigned__";
    if (!groups.has(patientKey)) {
      groups.set(patientKey, {
        patientId: patientKey === "__unassigned__" ? null : patientKey,
        patientName: null,
        sessionCount: 0,
        totalPoints: 0,
        workStatusCounts: emptyMonthlyWorkStatusCounts(),
        sessions: []
      });
    }
    const group = groups.get(patientKey);
    const readiness = feeMonthlySessionReadiness(session);
    const work = monthlyClaimWorkView(session.monthlyClaimWork);
    const points = Number(session.calculationSummary?.totalPoints || 0) || 0;
    group.sessionCount += 1;
    group.totalPoints += points;
    group.calculatedCount = Number(group.calculatedCount || 0) + (readiness.isCalculated ? 1 : 0);
    group.needsReviewCount = Number(group.needsReviewCount || 0) + readiness.needsReviewCount;
    group.missingDiagnosisCount = Number(group.missingDiagnosisCount || 0) + (readiness.missingDiagnosis ? 1 : 0);
    group.symptomDetailCandidateCount = Number(group.symptomDetailCandidateCount || 0) + readiness.symptomDetailCandidateCount;
    group.pendingReceiptAnnotationCount = Number(group.pendingReceiptAnnotationCount || 0) + readiness.pendingReceiptAnnotationCount;
    group.confirmedReceiptAnnotationCount = Number(group.confirmedReceiptAnnotationCount || 0) + readiness.confirmedReceiptAnnotationCount;
    group.readyForClaimCount = Number(group.readyForClaimCount || 0) + (readiness.readyForClaim ? 1 : 0);
    group.blockedCount = Number(group.blockedCount || 0) + (readiness.blocked ? 1 : 0);
    group.uncalculatedCount = Number(group.uncalculatedCount || 0) + (readiness.uncalculated ? 1 : 0);
    group.diagnosisRequestCandidateCount = Number(group.diagnosisRequestCandidateCount || 0) + (readiness.diagnosisRequestCandidate ? 1 : 0);
    group.doctorConfirmationCandidateCount = Number(group.doctorConfirmationCandidateCount || 0) + (readiness.doctorConfirmationCandidate ? 1 : 0);
    group.workStatusCounts[work.status] = Number(group.workStatusCounts[work.status] || 0) + 1;
    if (!group.patientName && session.patientSnapshot?.displayName) {
      group.patientName = session.patientSnapshot.displayName;
    }
    const pointsBreakdown = monthlyPointsBreakdown(session);
    group.pointsBreakdown = mergeMonthlyPointsBreakdown(group.pointsBreakdown, pointsBreakdown);
    group.sessions.push({
      feeSessionId: session.feeSessionId,
      serviceDate: session.serviceDate || null,
      claimMonth: sessionMonthOf(session) || null,
      status: session.status || null,
      totalPoints: points,
      pointsBreakdown,
      monthlyClaimWork: work,
      receiptAnnotations: receiptAnnotationView(session.receiptAnnotations),
      readiness
    });
    totals.calculatedCount += readiness.isCalculated ? 1 : 0;
    totals.needsReviewCount += readiness.needsReviewCount;
    totals.missingDiagnosisCount += readiness.missingDiagnosis ? 1 : 0;
    totals.symptomDetailCandidateCount += readiness.symptomDetailCandidateCount;
    totals.pendingReceiptAnnotationCount += readiness.pendingReceiptAnnotationCount;
    totals.confirmedReceiptAnnotationCount += readiness.confirmedReceiptAnnotationCount;
    totals.readyForClaimCount += readiness.readyForClaim ? 1 : 0;
    totals.blockedCount += readiness.blocked ? 1 : 0;
    totals.uncalculatedCount += readiness.uncalculated ? 1 : 0;
    totals.diagnosisRequestCandidateCount += readiness.diagnosisRequestCandidate ? 1 : 0;
    totals.doctorConfirmationCandidateCount += readiness.doctorConfirmationCandidate ? 1 : 0;
    totals.workStatusCounts[work.status] = Number(totals.workStatusCounts[work.status] || 0) + 1;
  }

  const patients = [...groups.values()]
    .map((group) => ({
      ...group,
      readyForClaim: Number(group.readyForClaimCount || 0) === Number(group.sessionCount || 0) && Number(group.sessionCount || 0) > 0,
      blocked: Number(group.blockedCount || 0) > 0,
      diagnosisRequestCandidate: Number(group.diagnosisRequestCandidateCount || 0) > 0,
      doctorConfirmationCandidate: Number(group.doctorConfirmationCandidateCount || 0) > 0,
      primaryWorkStatus: primaryMonthlyWorkStatus(group.workStatusCounts),
      sessions: group.sessions.sort((a, b) => String(a.serviceDate || "").localeCompare(String(b.serviceDate || "")))
    }))
    .sort((a, b) => (
      Number(b.blockedCount || 0) - Number(a.blockedCount || 0)
      || Number(b.needsReviewCount || 0) - Number(a.needsReviewCount || 0)
      || Number(b.missingDiagnosisCount || 0) - Number(a.missingDiagnosisCount || 0)
      || b.totalPoints - a.totalPoints
    ));

  return {
    claimMonth: month || null,
    patientCount: patients.length,
    sessionCount: patients.reduce((sum, patient) => sum + patient.sessionCount, 0),
    totalPoints: patients.reduce((sum, patient) => sum + patient.totalPoints, 0),
    ...totals,
    patients
  };
}

export function buildMonthlyBulkCandidatePlan(sessions = [], { claimMonth = "" } = {}) {
  const month = String(claimMonth || "").trim();
  const sessionMonthOf = (session) => String(session.claimMonth || String(session.serviceDate || "").slice(0, 7));
  const targets = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (month && sessionMonthOf(session) !== month) {
      continue;
    }
    const target = monthlyBulkCandidateTarget(session);
    if (!target) {
      continue;
    }
    targets.push(target);
  }
  const runnableCount = targets.filter((target) => target.canRun).length;
  const blockedCount = targets.length - runnableCount;
  return {
    claimMonth: month || null,
    targetCount: targets.length,
    runnableCount,
    blockedCount,
    reasonCounts: targets.reduce((counts, target) => {
      counts[target.reason] = Number(counts[target.reason] || 0) + 1;
      return counts;
    }, {}),
    targets: targets.sort((left, right) => (
      Number(left.canRun === true ? 1 : 0) - Number(right.canRun === true ? 1 : 0)
      || String(left.serviceDate || "").localeCompare(String(right.serviceDate || ""))
    ))
  };
}

function monthlyBulkCandidateTarget(session = {}) {
  const status = String(session.status || "").trim();
  const calculated = Boolean(session.calculationResult || session.calculationSummary?.calculationId || ["calculated", "needs_review"].includes(status));
  const inputSnapshot = session.calculationResult?.inputSnapshot || {};
  const clinicalTextChanged = calculated
    && typeof inputSnapshot.clinicalText === "string"
    && clinicalTextHash(inputSnapshot.clinicalText || "") !== clinicalTextHash(session.clinicalText || "");
  let reason = "";
  let reasonLabel = "";
  if (status === "failed") {
    reason = "failed";
    reasonLabel = "算定失敗";
  } else if (!calculated || ["draft", "ready"].includes(status)) {
    reason = "uncalculated";
    reasonLabel = "未算定";
  } else if (clinicalTextChanged) {
    reason = "clinical_text_changed";
    reasonLabel = "カルテ変更";
  }
  if (!reason || status === "calculating") {
    return null;
  }
  const missing = [];
  if (!session.patientId) missing.push("患者");
  if (!session.facilityId) missing.push("医療機関");
  if (!String(session.clinicalText || "").trim() && !(Array.isArray(session.orders) && session.orders.length)) missing.push("カルテまたはオーダー");
  return {
    feeSessionId: session.feeSessionId || session.sessionId || "",
    patientId: session.patientId || null,
    patientName: session.patientSnapshot?.displayName || "",
    serviceDate: session.serviceDate || null,
    status: status || null,
    reason,
    reasonLabel,
    canRun: missing.length === 0,
    blockedReason: missing.length ? `${missing.join("、")}が不足しています。` : null
  };
}

function feeMonthlySessionReadiness(session = {}) {
  const status = String(session.status || "").trim();
  const calculationSummary = session.calculationSummary || {};
  const isCalculated = Boolean(session.calculationResult || calculationSummary.calculationId || ["calculated", "needs_review"].includes(status));
  const reviewItems = isCalculated ? buildReviewItems(session) : [];
  const openReviewItems = reviewItems.filter((item) => item.status === "needs_review");
  const fallbackReviewCount = status === "needs_review"
    ? Math.max(1, Number(calculationSummary.reviewLineCount || 0) || 0)
    : Number(calculationSummary.reviewLineCount || 0) || 0;
  const warnings = Array.isArray(session.calculationResult?.warnings) ? session.calculationResult.warnings : [];
  const missingDiagnosis = !hasDiagnosisInput(session);
  const symptomDetailCandidateCount = countSymptomDetailCandidates({ reviewItems, warnings });
  const receiptAnnotationStats = receiptAnnotationStatsForSession(session.receiptAnnotations);
  const pendingReceiptAnnotationCount = Math.max(symptomDetailCandidateCount, receiptAnnotationStats.draftCount);
  const uncalculated = !isCalculated || ["draft", "ready", "failed", "calculating"].includes(status);
  const needsReviewCount = openReviewItems.length || fallbackReviewCount;
  const blocked = status === "failed" || uncalculated || missingDiagnosis || needsReviewCount > 0 || pendingReceiptAnnotationCount > 0;
  const readyForClaim = isCalculated && !blocked && symptomDetailCandidateCount === 0 && pendingReceiptAnnotationCount === 0;
  const diagnosisRequestCandidate = missingDiagnosis;
  const doctorConfirmationCandidate = needsReviewCount > 0 || symptomDetailCandidateCount > 0 || uncalculated || status === "failed";

  return {
    isCalculated,
    uncalculated,
    missingDiagnosis,
    needsReviewCount,
    symptomDetailCandidateCount,
    pendingReceiptAnnotationCount,
    confirmedReceiptAnnotationCount: receiptAnnotationStats.confirmedCount,
    diagnosisRequestCandidate,
    doctorConfirmationCandidate,
    readyForClaim,
    blocked,
    issues: monthlyReadinessIssues({
      missingDiagnosis,
      needsReviewCount,
      openReviewItems,
      fallbackReviewCount,
      symptomDetailCandidateCount,
      pendingReceiptAnnotationCount,
      uncalculated,
      status
    }),
    status
  };
}

// 何が点数として加算されているかの区分別内訳(コンパクト表示用)。
const MONTHLY_BREAKDOWN_LABELS = {
  basic: "基本料",
  management: "医学管理",
  home: "在宅",
  drug: "投薬",
  injection: "注射",
  treatment: "処置",
  procedure: "手術",
  surgery: "手術",
  anesthesia: "麻酔",
  lab: "検査",
  pathology: "病理",
  imaging: "画像",
  material: "特定器材",
  other: "その他",
  unknown: "その他"
};

function monthlyPointsBreakdown(session = {}) {
  const lines = Array.isArray(session?.calculationResult?.lineItems) ? session.calculationResult.lineItems : [];
  const map = new Map();
  for (const line of lines) {
    const status = String(line?.status || "");
    if (line?.includedInTotal === false || status === "blocked" || status === "rejected") {
      continue;
    }
    const points = Number(line?.totalPoints || 0) || 0;
    if (points <= 0) {
      continue;
    }
    const label = MONTHLY_BREAKDOWN_LABELS[String(line?.orderType || "unknown")] || "その他";
    const entry = map.get(label) || { label, points: 0 };
    entry.points += points;
    map.set(label, entry);
  }
  return [...map.values()].sort((a, b) => b.points - a.points);
}

function mergeMonthlyPointsBreakdown(base = [], add = []) {
  const map = new Map((Array.isArray(base) ? base : []).map((entry) => [entry.label, { ...entry }]));
  for (const entry of Array.isArray(add) ? add : []) {
    const existing = map.get(entry.label) || { label: entry.label, points: 0 };
    existing.points += Number(entry.points || 0);
    map.set(entry.label, existing);
  }
  return [...map.values()].sort((a, b) => b.points - a.points);
}

function monthlyReadinessIssues({
  missingDiagnosis = false,
  needsReviewCount = 0,
  openReviewItems = [],
  fallbackReviewCount = 0,
  symptomDetailCandidateCount = 0,
  pendingReceiptAnnotationCount = 0,
  uncalculated = false,
  status = ""
} = {}) {
  const issues = [];
  if (missingDiagnosis) {
    issues.push({
      type: "missing_diagnosis",
      label: "病名不足",
      detail: "算定根拠として使う病名が未入力です。"
    });
  }
  if (uncalculated) {
    issues.push({
      type: "uncalculated",
      label: "未算定",
      detail: status === "failed" ? "算定処理が失敗しています。" : "算定結果がまだ作成されていません。"
    });
  }
  const reviewDetails = openReviewItems.slice(0, 5).map((item) => ({
    type: "review",
    label: item.title || "要確認",
    detail: item.reason || item.reviewIssue?.messageForStaff || item.candidateProposal?.reason || ""
  }));
  issues.push(...reviewDetails);
  const remainingReviewCount = Math.max(0, Number(needsReviewCount || 0) - reviewDetails.length);
  if (remainingReviewCount > 0 || (!reviewDetails.length && Number(fallbackReviewCount || 0) > 0)) {
    issues.push({
      type: "review",
      label: "要確認",
      detail: `${Number(remainingReviewCount || fallbackReviewCount || needsReviewCount).toLocaleString()}件の確認事項があります。`
    });
  }
  if (symptomDetailCandidateCount > 0) {
    issues.push({
      type: "symptom_detail",
      label: "詳記候補",
      detail: "詳記、コメント、照会、返戻、査定に関連する確認候補があります。"
    });
  }
  if (pendingReceiptAnnotationCount > 0) {
    issues.push({
      type: "receipt_annotation",
      label: "詳記未対応",
      detail: "コメントまたは症状詳記の下書き確認、確定が必要です。"
    });
  }
  return issues;
}

function emptyMonthlyWorkStatusCounts() {
  return {
    not_started: 0,
    diagnosis_requested: 0,
    doctor_confirming: 0,
    collected: 0,
    ready_for_claim: 0,
    excluded: 0
  };
}

function monthlyClaimWorkView(value = null) {
  const status = String(value?.status || "not_started").trim();
  const allowed = new Set(Object.keys(emptyMonthlyWorkStatusCounts()));
  return {
    status: allowed.has(status) ? status : "not_started",
    note: String(value?.note || ""),
    diagnosisCandidates: Array.isArray(value?.diagnosisCandidates) ? value.diagnosisCandidates : [],
    diagnosisRequestReason: String(value?.diagnosisRequestReason || ""),
    doctorName: String(value?.doctorName || ""),
    requestedAt: value?.requestedAt || null,
    collectedAt: value?.collectedAt || null,
    collectedResult: String(value?.collectedResult || ""),
    appliedDiagnosisNames: Array.isArray(value?.appliedDiagnosisNames) ? value.appliedDiagnosisNames : [],
    updatedByMemberId: value?.updatedByMemberId || null,
    updatedAt: value?.updatedAt || null
  };
}

function receiptAnnotationView(value = null) {
  return {
    comments: Array.isArray(value?.comments) ? value.comments : [],
    symptomDetails: Array.isArray(value?.symptomDetails) ? value.symptomDetails : [],
    updatedByMemberId: value?.updatedByMemberId || null,
    updatedAt: value?.updatedAt || null
  };
}

function receiptAnnotationStatsForSession(value = null) {
  const annotations = [
    ...(Array.isArray(value?.comments) ? value.comments : []),
    ...(Array.isArray(value?.symptomDetails) ? value.symptomDetails : [])
  ];
  return annotations.reduce((stats, annotation) => {
    const status = String(annotation?.status || "draft").trim();
    if (status === "confirmed") {
      stats.confirmedCount += 1;
    } else if (status !== "rejected") {
      stats.draftCount += 1;
    }
    return stats;
  }, { draftCount: 0, confirmedCount: 0 });
}

function primaryMonthlyWorkStatus(counts = {}) {
  const priority = ["diagnosis_requested", "doctor_confirming", "collected", "ready_for_claim", "excluded"];
  return priority.find((status) => Number(counts[status] || 0) > 0) || "not_started";
}

function countSymptomDetailCandidates({ reviewItems = [], warnings = [] } = {}) {
  const texts = [
    ...reviewItems.flatMap((item) => [
      item.title,
      item.reason,
      item.reviewIssue?.messageForStaff,
      item.candidateProposal?.reason,
      item.candidateProposal?.conditionText
    ]),
    ...warnings
  ].map((value) => String(value || "")).filter(Boolean);

  return texts.filter((text) => /詳記|症状詳記|コメント|照会|返戻|査定/u.test(text)).length;
}

// #8: 受診履歴(priorSessions)から、算定エンジンが同月制限・回数制限の判定に使う
// history(same_month_history_codes / procedure_history_events 等)を組み立てる。
export function buildPriorHistoryOptions(priorSessions = [], { serviceDate = "", feeSettings = null } = {}) {
  if (!Array.isArray(priorSessions) || !priorSessions.length) {
    return null;
  }
  const currentMonth = String(serviceDate || "").slice(0, 7);
  const sameMonthCodes = new Set();
  const sameDayCodes = new Set();
  const sameWeekCodes = new Set();
  const judgementGroups = new Set();
  const events = [];
  const seenEvents = new Set();
  let labManagementSameMonth = false;
  let medicationManagementSameMonth = false;
  let chronicDiseaseManagementSameMonth = false;
  let bloodCollectionSameDay = false;
  let rapidLabSameDay = false;

  for (const prior of priorSessions) {
    const priorDate = String(prior?.serviceDate || "");
    if (!priorDate) {
      continue;
    }
    const lineItems = Array.isArray(prior?.calculationResult?.lineItems)
      ? prior.calculationResult.lineItems
      : [];
    for (const line of lineItems) {
      const code = String(line?.code || "").trim();
      if (!code || !isHistoryCountableLine(line)) {
        continue;
      }
      const eventKey = `${code}|${priorDate}`;
      if (!seenEvents.has(eventKey)) {
        seenEvents.add(eventKey);
        events.push({ procedure_code: code, service_date: priorDate });
      }
      if (currentMonth && priorDate.slice(0, 7) === currentMonth) {
        sameMonthCodes.add(code);
        const classification = classifyHistoryLine(line);
        if (classification.judgementGroup) {
          judgementGroups.add(classification.judgementGroup);
        }
        if (classification.labManagement) {
          labManagementSameMonth = true;
        }
        if (classification.medicationManagement) {
          medicationManagementSameMonth = true;
        }
        if (classification.chronicDiseaseManagement) {
          chronicDiseaseManagementSameMonth = true;
        }
      }
      if (serviceDate && priorDate === serviceDate) {
        sameDayCodes.add(code);
        const classification = classifyHistoryLine(line);
        if (classification.bloodCollection) {
          bloodCollectionSameDay = true;
        }
        if (classification.rapidLab) {
          rapidLabSameDay = true;
        }
      }
      if (serviceDate && isSameIsoWeek(priorDate, serviceDate)) {
        sameWeekCodes.add(code);
      }
    }
  }

  if (!events.length && !sameMonthCodes.size && !sameDayCodes.size && !sameWeekCodes.size) {
    return null;
  }
  return compactObject({
    same_month_history_codes: [...sameMonthCodes],
    same_day_history_codes: [...sameDayCodes],
    same_week_history_codes: [...sameWeekCodes],
    already_billed_judgement_groups: [...judgementGroups],
    already_billed_lab_management_same_month: labManagementSameMonth || undefined,
    medication_already_billed_same_month: medicationManagementSameMonth || undefined,
    chronic_disease_management_already_billed_same_month: chronicDiseaseManagementSameMonth || undefined,
    blood_collection_already_billed_same_day: bloodCollectionSameDay || undefined,
    outpatient_rapid_lab_already_billed_same_day: rapidLabSameDay || undefined,
    history_completeness: feeSettings?.historyPolicy?.historyCompleteness || undefined,
    history_lookback_months: feeSettings?.historyPolicy?.defaultLookbackMonths || undefined,
    procedure_history_events: events
  });
}

function classifyHistoryLine(line = {}) {
  const text = [
    line.name,
    line.label,
    line.displayName,
    line.masterName,
    line.source,
    line.category,
    line.orderType
  ].map((value) => String(value || "")).join(" ");
  const code = String(line.code || "").trim();
  const judgementGroup = judgementGroupForText(text);
  return {
    judgementGroup,
    labManagement: /検体検査管理加算/u.test(text),
    bloodCollection: /血液採取|静脈採血|採血/u.test(text),
    rapidLab: /外来迅速検体検査加算/u.test(text),
    medicationManagement: /特定疾患処方管理|処方管理/u.test(text),
    chronicDiseaseManagement: /特定疾患療養管理|生活習慣病管理|管理料/u.test(text) && !/検体検査管理/u.test(text),
    code
  };
}

function judgementGroupForText(text = "") {
  if (/尿・糞便等検査判断料/u.test(text)) return "urine_feces";
  if (/血液学的検査判断料/u.test(text)) return "hematology";
  if (/生化学的検査判断料/u.test(text)) return "biochemistry";
  if (/免疫学的検査判断料/u.test(text)) return "immunology";
  if (/微生物学的検査判断料/u.test(text)) return "microbiology";
  return "";
}

// 明確に算定しないと判断された行は履歴に含めない(過大な制限検知を避ける)
function isHistoryCountableLine(line = {}) {
  const status = String(line?.status || "").toLowerCase();
  if (status === "rejected" || status === "blocked") {
    return false;
  }
  if (line?.includedInTotal === false) {
    return false;
  }
  return true;
}

// 履歴を calculationOptions.history へマージする。明示指定(gold等)があればそれを優先。
export function mergePriorHistoryIntoOptions(options = {}, priorHistory = {}) {
  const existing = isPlainObject(options.history) ? options.history : {};
  const merged = { ...existing };
  for (const key of ["same_month_history_codes", "same_day_history_codes", "same_week_history_codes", "already_billed_judgement_groups"]) {
    if ((!Array.isArray(existing[key]) || !existing[key].length) && Array.isArray(priorHistory[key]) && priorHistory[key].length) {
      merged[key] = priorHistory[key];
    }
  }
  for (const key of [
    "already_billed_lab_management_same_month",
    "medication_already_billed_same_month",
    "chronic_disease_management_already_billed_same_month",
    "blood_collection_already_billed_same_day",
    "outpatient_rapid_lab_already_billed_same_day",
    "history_completeness",
    "history_lookback_months"
  ]) {
    if (existing[key] === undefined && priorHistory[key] !== undefined) {
      merged[key] = priorHistory[key];
    }
  }
  if (
    (!Array.isArray(existing.procedure_history_events) || !existing.procedure_history_events.length)
    && Array.isArray(priorHistory.procedure_history_events)
    && priorHistory.procedure_history_events.length
  ) {
    merged.procedure_history_events = priorHistory.procedure_history_events;
  }
  return { ...options, history: merged };
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
  if (hasOwn(normalized, "monthlyClaimWork")) {
    patch.monthlyClaimWork = monthlyClaimWorkPatch(normalized.monthlyClaimWork, {
      memberId: context.session.memberId,
      now
    });
  }
  if (hasOwn(normalized, "receiptAnnotations")) {
    patch.receiptAnnotations = receiptAnnotationsPatch(normalized.receiptAnnotations, {
      memberId: context.session.memberId,
      now
    });
  }
  applyClinicalTextChangeGuards(patch, normalized, current);
  if (normalized.patientId || normalized.patient) {
    const patient = await resolveFeePatient(context, platformStore, normalized);
    patch.patientId = patient.patientId;
    patch.patientSnapshot = patientSnapshot(patient, now);
    // 受診日時点の保険・公費を固定(会計・負担金計算の前提)
    const serviceDateForSnapshot = normalized.serviceDate || current.serviceDate || null;
    patch.insuranceSnapshot = insuranceSnapshot(patient, serviceDateForSnapshot, now);
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

function monthlyClaimWorkPatch(value, { memberId = "", now = new Date() } = {}) {
  if (!value) {
    return null;
  }
  const timestamp = now.toISOString();
  const status = String(value.status || "").trim();
  return {
    ...value,
    requestedAt: status === "diagnosis_requested" && !value.requestedAt ? timestamp : value.requestedAt,
    collectedAt: status === "collected" && !value.collectedAt ? timestamp : value.collectedAt,
    updatedByMemberId: memberId || value.updatedByMemberId || null,
    updatedAt: timestamp
  };
}

function receiptAnnotationsPatch(value, { memberId = "", now = new Date() } = {}) {
  if (!value) {
    return null;
  }
  const timestamp = now.toISOString();
  return {
    ...value,
    comments: stampReceiptAnnotationList(value.comments, { memberId, timestamp }),
    symptomDetails: stampReceiptAnnotationList(value.symptomDetails, { memberId, timestamp }),
    updatedByMemberId: memberId || value.updatedByMemberId || null,
    updatedAt: timestamp
  };
}

function stampReceiptAnnotationList(items = [], { memberId = "", timestamp = "" } = {}) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    ...item,
    annotationId: item.annotationId || `receipt_annotation_${index + 1}`,
    createdAt: item.createdAt || timestamp,
    createdByMemberId: item.createdByMemberId || memberId || null,
    updatedAt: timestamp,
    updatedByMemberId: memberId || item.updatedByMemberId || null
  }));
}

export function receiptAnnotationContext(session = {}, receiptPolicy = {}) {
  const annotations = session.receiptAnnotations || {};
  const annotationDefaults = receiptPolicy?.annotationDefaults || {};
  const comments = (Array.isArray(annotations.comments) ? annotations.comments : [])
    .filter((comment) => comment?.status === "confirmed" && String(comment.text || "").trim())
    .map((comment) => ({
      shinryoIdentification: comment.shinryoIdentification || annotationDefaults.commentShinryoIdentification || "",
      code: comment.code || "",
      text: comment.text || ""
    }));
  const symptomDetails = (Array.isArray(annotations.symptomDetails) ? annotations.symptomDetails : [])
    .filter((detail) => detail?.status === "confirmed" && String(detail.text || "").trim())
    .map((detail) => ({
      kubun: detail.kubun || annotationDefaults.symptomDetailKubun || "",
      text: detail.text || ""
    }));
  return { comments, symptomDetails };
}

async function loadMonthlyReceiptForExport({ feeStore, orgId, patientId, claimMonth, now }) {
  const sessions = await feeStore.listSessions(orgId);
  const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
  const month = String(claimMonth || "").slice(0, 7);
  const monthOf = (session) => String(session.claimMonth || String(session.serviceDate || "").slice(0, 7));
  const base = sessionList.find((session) => session
    && session.patientId === patientId
    && (!month || monthOf(session) === month)
    && session.calculationResult
    && session.calculationResult.status) || null;
  const receiptDraft = buildMonthlyReceiptDraft(sessionList, { patientId, claimMonth, now });
  return { sessionList, base, receiptDraft };
}

function monthlyReceiptFileName(receiptDraft = {}, extension = "csv") {
  const patient = String(receiptDraft.patientId || "patient").replace(/[^\w-]+/gu, "");
  const month = String(receiptDraft.claimMonth || "month").replace(/[^\w-]+/gu, "");
  return `receipt_monthly_${patient}_${month}.${extension}`;
}

function receiptExportContext(session = {}, feeSettings = {}) {
  const receiptPolicy = feeSettings?.receiptPolicy || {};
  return {
    insuranceSnapshot: session.insuranceSnapshot || null,
    receiptPolicy,
    connectorSpecVerified: receiptPolicy.connectorSpecVerified === true,
    ...receiptAnnotationContext(session, receiptPolicy)
  };
}

function withReceiptExportValidation(receiptDraft = {}, session = {}, feeSettings = {}) {
  const exportValidation = buildReceiptExportValidation(receiptDraft, receiptExportContext(session, feeSettings));
  return {
    ...receiptDraft,
    exportStatus: exportValidation.exportStatus,
    exportValidation
  };
}

function shouldBlockReceiptExport(url, validation = {}, exportContext = {}) {
  if (Number(validation.blockingIssueCount || 0) <= 0) {
    return false;
  }
  return url.searchParams.get("validate") === "true" || exportContext.receiptPolicy?.blockExportOnErrors === true;
}

function receiptExportValidationFailed(validation = {}) {
  return {
    statusCode: 409,
    body: {
      error: "receipt_validation_failed",
      message: "レセプト出力前の必須項目が不足しています。",
      receiptExportValidation: validation
    }
  };
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
  const inputSession = sessionWithCalculationInputOverrides(session, calculationInput);
  const enriched = await measureStage(stageTimings, "enrichOrders", () => enrichSessionOrdersForCalculation(inputSession, feeCalculator));
  const baseSession = enriched.changed ? { ...inputSession, orders: enriched.orders } : inputSession;
  const facilityProfile = await measureStage(stageTimings, "facilityProfile", () => loadFacilityProfileForCalculation({
    platformStore: input.platformStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession
  }));
  const feeSettings = await measureStage(stageTimings, "feeSettings", () => loadFeeSettingsForCalculation({
    feeStore: input.feeStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession
  }));
  const priorSessions = await measureStage(stageTimings, "patientHistory", () => loadPriorFeeSessionsForPatient({
    feeStore: input.feeStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession,
    feeSessionId: input.feeSessionId || baseSession.feeSessionId,
    feeSettings
  }));
  const priorBillingHistory = await measureStage(stageTimings, "externalBillingHistory", () => loadPriorBillingHistoryForPatient({
    feeStore: input.feeStore,
    orgId: input.orgId || baseSession.orgId,
    session: baseSession,
    feeSettings
  }));
  const combinedPriorSessions = [
    ...priorSessions,
    ...billingHistoryEventsAsPriorSessions(priorBillingHistory)
  ];
  const reusableClinicalPreparation = reusableClinicalCalculationPreparation({
    session: baseSession,
    calculationInput,
    previousCalculationResult: input.previousCalculationResult || null
  });
  const legacy = reusableClinicalPreparation
    ? await measureStage(stageTimings, "clinicalCalculationPreparation", () => reusableClinicalPreparation)
    : await measureStage(stageTimings, "clinicalCalculationPreparation", () => buildClinicalCalculationPreparation({
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
        || DEFAULT_OPENAI_FEE_CLINICAL_TIMEOUT_MS
      ),
      priorSessions: combinedPriorSessions,
      feeSettings,
      clinicalFactsExtractor: input.clinicalFactsExtractor
    }));
  const primaryPrepared = applyFacilityProfileToPreparation(legacy, facilityProfile, {
    clinicalText: baseSession.clinicalText || calculationInput.clinicalText || ""
  });
  const shadowCalculations = await measureStage(stageTimings, "shadowCalculationPreparation", () => buildFeeCalculationShadowCalculations({
    input,
    primaryPrepared,
    session: baseSession,
    calculationInput,
    feeCalculator,
    facilityProfile,
    priorSessions: combinedPriorSessions,
    clinicalText: baseSession.clinicalText || calculationInput.clinicalText || ""
  }));
  const prepared = attachShadowCalculationsToPreparation(primaryPrepared, shadowCalculations);

  // #8: claimContext(リプレイ/契約)指定が無い通常算定では、受診履歴から
  // 同月・回数制限の判定材料を calculationOptions.history へ自動注入する。
  const hasExplicitClaimContext = isPlainObject(session.claimContext) || isPlainObject(calculationInput.claimContext);
  if (!hasExplicitClaimContext && isPlainObject(prepared.calculationOptions)) {
    const priorHistory = buildPriorHistoryOptions(combinedPriorSessions, { serviceDate: baseSession.serviceDate, feeSettings });
    if (priorHistory) {
      prepared.calculationOptions = mergePriorHistoryIntoOptions(prepared.calculationOptions, priorHistory);
    }
  }

  const patch = {};

  if (
    enriched.changed
    || (
      hasOwn(calculationInput, "orders")
      && !hasEquivalentJson(session.orders || [], baseSession.orders || [])
    )
  ) {
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
    canonicalClinicalFacts: Array.isArray(prepared.canonicalClinicalFacts) ? prepared.canonicalClinicalFacts : [],
    masterCandidates: Array.isArray(prepared.masterCandidates) ? prepared.masterCandidates : [],
    billingCandidates: Array.isArray(prepared.billingCandidates) ? prepared.billingCandidates : [],
    reviewIssues: Array.isArray(prepared.reviewIssues) ? prepared.reviewIssues : [],
    clinicalExtraction: prepared.clinicalExtraction || null,
    shadowCalculations: Array.isArray(prepared.shadowCalculations) ? prepared.shadowCalculations : [],
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

function sessionWithCalculationInputOverrides(session = {}, calculationInput = {}) {
  const next = { ...session };
  if (hasOwn(calculationInput, "orders")) {
    next.orders = Array.isArray(calculationInput.orders) ? calculationInput.orders : [];
  }
  if (hasOwn(calculationInput, "clinicalText")) {
    next.clinicalText = String(calculationInput.clinicalText || "");
  }
  return next;
}

function reusableClinicalCalculationPreparation({
  session = {},
  calculationInput = {},
  previousCalculationResult = null
} = {}) {
  if (String(calculationInput.calculationMode || "") !== "reuse_clinical") {
    return null;
  }
  if (!isPlainObject(previousCalculationResult)) {
    return null;
  }

  const currentClinicalText = String(calculationInput.clinicalText || session.clinicalText || "");
  const previousClinicalTextHash = String(previousCalculationResult.inputSnapshot?.clinicalTextHash || "");
  if (!previousClinicalTextHash || previousClinicalTextHash !== clinicalTextHash(currentClinicalText)) {
    return null;
  }

  const calculationOptions = isPlainObject(calculationInput.calculationOptions)
    ? calculationInput.calculationOptions
    : isPlainObject(session.calculationOptions)
      ? session.calculationOptions
      : isPlainObject(previousCalculationResult.inputSnapshot?.calculationOptions)
        ? previousCalculationResult.inputSnapshot.calculationOptions
        : null;
  if (!isPlainObject(calculationOptions)) {
    return null;
  }

  const previousExtraction = isPlainObject(previousCalculationResult.clinicalExtraction)
    ? previousCalculationResult.clinicalExtraction
    : {};
  const inputSnapshot = isPlainObject(previousCalculationResult.inputSnapshot)
    ? previousCalculationResult.inputSnapshot
    : {};
  const previousVersions = isPlainObject(inputSnapshot.versions) ? inputSnapshot.versions : {};
  const clinicalExtraction = {
    ...previousExtraction,
    source: "reuse_clinical",
    reusedFromCalculationId: previousCalculationResult.calculationId || null
  };
  const calculationOptionsAutoKeys = Array.isArray(session.calculationOptionsAutoKeys)
    ? session.calculationOptionsAutoKeys
    : Array.isArray(inputSnapshot.calculationOptionsAutoKeys)
      ? inputSnapshot.calculationOptionsAutoKeys
      : [];

  return {
    calculationOptions,
    calculationOptionsAutoKeys,
    calculationOptionsSource: session.calculationOptionsSource || inputSnapshot.calculationOptionsSource || "reuse_clinical",
    diagnoses: [],
    candidateProposals: Array.isArray(previousCalculationResult.candidateProposals) ? previousCalculationResult.candidateProposals : [],
    reviewWarnings: [],
    clinicalEvents: Array.isArray(previousCalculationResult.clinicalEvents) ? previousCalculationResult.clinicalEvents : [],
    canonicalClinicalFacts: Array.isArray(previousCalculationResult.canonicalClinicalFacts) ? previousCalculationResult.canonicalClinicalFacts : [],
    masterCandidates: Array.isArray(previousCalculationResult.masterCandidates) ? previousCalculationResult.masterCandidates : [],
    billingCandidates: Array.isArray(previousCalculationResult.billingCandidates) ? previousCalculationResult.billingCandidates : [],
    reviewIssues: Array.isArray(previousCalculationResult.reviewIssues) ? previousCalculationResult.reviewIssues : [],
    shadowCalculations: Array.isArray(previousCalculationResult.shadowCalculations) ? previousCalculationResult.shadowCalculations : [],
    clinicalExtraction,
    metrics: {
      clinicalStructuring: {
        source: "reuse_clinical",
        durationMs: 0,
        model: clinicalExtraction.model || null,
        reasoningEffort: clinicalExtraction.reasoningEffort || null,
        promptVersion: clinicalExtraction.promptVersion || previousVersions.promptVersion || null,
        ruleSetVersion: clinicalExtraction.ruleSetVersion || previousVersions.ruleSetVersion || null,
        registryVersion: clinicalExtraction.registryVersion || previousVersions.registryVersion || null,
        masterVersion: clinicalExtraction.masterVersion || previousVersions.masterVersion || null,
        timeoutMs: Number(clinicalExtraction.timeoutMs || 0),
        reusedFromCalculationId: previousCalculationResult.calculationId || null
      },
      ruleBasedClinicalInference: {
        source: "reuse_clinical",
        durationMs: 0,
        masterLookupCount: 0,
        masterLookupDurationMs: 0
      }
    }
  };
}

function feeCalculationShadowModeEnabled(input = {}) {
  const env = input.processEnv || process.env;
  const raw = String(
    input.feeCalculationShadowMode
    || env.FEE_CALCULATION_SHADOW_MODE
    || "on"
  ).trim().toLowerCase();
  return !["0", "false", "off", "disabled", "none", "no"].includes(raw);
}

async function buildFeeCalculationShadowCalculations({
  input = {},
  primaryPrepared = {},
  session = {},
  calculationInput = {},
  feeCalculator,
  facilityProfile = {},
  priorSessions = [],
  clinicalText = ""
} = {}) {
  if (!feeCalculationShadowModeEnabled(input)) {
    return [];
  }
  const startedAt = Date.now();
  try {
    const shadowBase = await buildClinicalCalculationPreparation({
      session,
      calculationInput,
      feeCalculator,
      openAiApiKey: "",
      openAiModel: "deterministic-rules",
      openAiReasoningEffort: "none",
      openAiTimeoutMs: 0,
      priorSessions,
      clinicalFactsExtractor: null
    });
    const shadowPrepared = applyFacilityProfileToPreparation(shadowBase, facilityProfile, { clinicalText });
    return [buildFeeCalculationShadowRecord({
      primaryPrepared,
      shadowPrepared,
      durationMs: Date.now() - startedAt
    })];
  } catch (error) {
    return [{
      mode: "shadow",
      pipeline: "deterministic_rules",
      enabled: true,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: safeLogError(error),
      createdAt: new Date().toISOString()
    }];
  }
}

function attachShadowCalculationsToPreparation(prepared = {}, shadowCalculations = []) {
  const shadows = Array.isArray(shadowCalculations) ? shadowCalculations.filter(Boolean) : [];
  if (!shadows.length) {
    return prepared;
  }
  return {
    ...prepared,
    shadowCalculations: shadows,
    clinicalExtraction: appendClinicalExtractionTrace(prepared.clinicalExtraction, shadowTraceEvents(shadows)),
    metrics: {
      ...(prepared.metrics || {}),
      shadowCalculations: shadowCalculationLogSummary(shadows)
    }
  };
}

function buildFeeCalculationShadowRecord({ primaryPrepared = {}, shadowPrepared = {}, durationMs = 0 } = {}) {
  return {
    mode: "shadow",
    pipeline: "deterministic_rules",
    enabled: true,
    status: "completed",
    durationMs,
    createdAt: new Date().toISOString(),
    source: shadowPrepared.metrics?.clinicalStructuring?.source
      || shadowPrepared.clinicalExtraction?.source
      || "rules_no_openai",
    versions: {
      promptVersion: shadowPrepared.clinicalExtraction?.promptVersion || null,
      ruleSetVersion: shadowPrepared.clinicalExtraction?.ruleSetVersion || null,
      registryVersion: shadowPrepared.clinicalExtraction?.registryVersion || null
    },
    result: compactShadowPreparation(shadowPrepared),
    diff: diffShadowPreparation(primaryPrepared, shadowPrepared)
  };
}

function compactShadowPreparation(prepared = {}) {
  return {
    calculationOptions: isPlainObject(prepared.calculationOptions) ? prepared.calculationOptions : {},
    calculationOptionsAutoKeys: Array.isArray(prepared.calculationOptionsAutoKeys)
      ? prepared.calculationOptionsAutoKeys.slice(0, 80)
      : [],
    calculationOptionsSource: prepared.calculationOptionsSource || null,
    reviewWarnings: Array.isArray(prepared.reviewWarnings) ? prepared.reviewWarnings.slice(0, 40) : [],
    clinicalEvents: compactClinicalEventsForShadow(prepared.clinicalEvents),
    canonicalClinicalFacts: compactCanonicalFactsForShadow(prepared.canonicalClinicalFacts),
    masterCandidates: compactMasterCandidatesForShadow(prepared.masterCandidates),
    billingCandidates: compactBillingCandidatesForShadow(prepared.billingCandidates),
    reviewIssues: compactReviewIssuesForShadow(prepared.reviewIssues),
    metrics: {
      clinicalStructuring: prepared.metrics?.clinicalStructuring || null,
      ruleBasedClinicalInference: prepared.metrics?.ruleBasedClinicalInference || null,
      facilityProfile: prepared.metrics?.facilityProfile || null
    }
  };
}

function compactClinicalEventsForShadow(events = []) {
  return (Array.isArray(events) ? events : []).slice(0, 80).map((event) => ({
    type: event?.type || event?.eventType || null,
    billingDomain: event?.billingDomain || event?.billing_domain || null,
    name: event?.name || event?.clinicalName || null,
    actionStatus: event?.actionStatus || event?.action_status || null,
    temporalRelation: event?.temporalRelation || event?.temporal_relation || null,
    source: event?.source || null
  }));
}

function compactCanonicalFactsForShadow(facts = []) {
  return (Array.isArray(facts) ? facts : []).slice(0, 80).map((fact) => ({
    factId: fact?.factId || fact?.fact_id || null,
    conceptId: fact?.conceptId || fact?.concept_id || null,
    eventType: fact?.eventType || fact?.event_type || null,
    clinicalName: fact?.clinicalName || fact?.clinical_name || null,
    status: fact?.status || null,
    verificationStatus: fact?.verification?.status || null,
    reasonCode: fact?.reasonCode || fact?.reason_code || null
  }));
}

function compactMasterCandidatesForShadow(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 80).map((candidate) => ({
    eventName: candidate?.eventName || candidate?.clinicalName || null,
    eventType: candidate?.eventType || null,
    masterCode: candidate?.masterCode || candidate?.code || null,
    masterName: candidate?.masterName || candidate?.name || null,
    status: candidate?.status || candidate?.outcome || null,
    reason: candidate?.reason || candidate?.filterReason || null
  }));
}

function compactBillingCandidatesForShadow(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 80).map((candidate) => ({
    code: candidate?.code || candidate?.masterCode || null,
    name: candidate?.name || candidate?.masterName || null,
    eventName: candidate?.eventName || candidate?.clinicalName || null,
    status: candidate?.status || null,
    source: candidate?.source || null
  }));
}

function compactReviewIssuesForShadow(issues = []) {
  return (Array.isArray(issues) ? issues : []).slice(0, 80).map((issue) => ({
    issueCode: issue?.issueCode || issue?.code || null,
    topicCode: issue?.topicCode || null,
    topicLabel: issue?.topicLabel || null,
    category: issue?.category || null,
    title: issue?.title || null,
    requiredInput: issue?.requiredInput || null
  }));
}

function diffShadowPreparation(primaryPrepared = {}, shadowPrepared = {}) {
  return {
    calculationOptionKeys: diffStringSets(
      Object.keys(isPlainObject(primaryPrepared.calculationOptions) ? primaryPrepared.calculationOptions : {}),
      Object.keys(isPlainObject(shadowPrepared.calculationOptions) ? shadowPrepared.calculationOptions : {})
    ),
    optionSummary: {
      primary: calculationOptionSummaryForShadow(primaryPrepared.calculationOptions),
      shadow: calculationOptionSummaryForShadow(shadowPrepared.calculationOptions)
    },
    reviewWarnings: diffStringSets(primaryPrepared.reviewWarnings, shadowPrepared.reviewWarnings, 20),
    canonicalConceptIds: diffStringSets(
      canonicalFactDiffKeys(primaryPrepared.canonicalClinicalFacts),
      canonicalFactDiffKeys(shadowPrepared.canonicalClinicalFacts),
      40
    ),
    billingCandidateCodes: diffStringSets(
      billingCandidateDiffKeys(primaryPrepared.billingCandidates),
      billingCandidateDiffKeys(shadowPrepared.billingCandidates),
      40
    )
  };
}

function calculationOptionSummaryForShadow(options = {}) {
  const value = isPlainObject(options) ? options : {};
  return {
    keys: Object.keys(value).sort(),
    labOptionCount: Array.isArray(value.lab_options) ? value.lab_options.length : 0,
    medicationOrderCount: Array.isArray(value.medication_orders) ? value.medication_orders.length : 0,
    imagingOrderCount: Array.isArray(value.imaging_orders) ? value.imaging_orders.length : 0,
    treatmentOrderCount: Array.isArray(value.treatment_orders) ? value.treatment_orders.length : 0,
    materialInputCount: Array.isArray(value.material_inputs) ? value.material_inputs.length : 0,
    facilityStandardKeyCount: Array.isArray(value.facility_standard_keys) ? value.facility_standard_keys.length : 0
  };
}

function canonicalFactDiffKeys(facts = []) {
  return uniqueStrings((Array.isArray(facts) ? facts : []).map((fact) => [
    fact?.conceptId || fact?.concept_id || "",
    fact?.eventType || fact?.event_type || "",
    fact?.clinicalName || fact?.clinical_name || "",
    fact?.status || ""
  ].filter(Boolean).join(":")));
}

function billingCandidateDiffKeys(candidates = []) {
  return uniqueStrings((Array.isArray(candidates) ? candidates : []).map((candidate) => [
    candidate?.code || candidate?.masterCode || "",
    candidate?.name || candidate?.masterName || ""
  ].filter(Boolean).join(":")));
}

function diffStringSets(primaryValues = [], shadowValues = [], limit = 50) {
  const primary = uniqueStrings(Array.isArray(primaryValues) ? primaryValues : []).sort();
  const shadow = uniqueStrings(Array.isArray(shadowValues) ? shadowValues : []).sort();
  const primarySet = new Set(primary);
  const shadowSet = new Set(shadow);
  return {
    onlyInPrimary: primary.filter((value) => !shadowSet.has(value)).slice(0, limit),
    onlyInShadow: shadow.filter((value) => !primarySet.has(value)).slice(0, limit),
    sharedCount: primary.filter((value) => shadowSet.has(value)).length,
    primaryCount: primary.length,
    shadowCount: shadow.length
  };
}

function shadowTraceEvents(shadowCalculations = []) {
  return (Array.isArray(shadowCalculations) ? shadowCalculations : []).map((shadow, index) => ({
    traceId: `trace_shadow_calculation_${index + 1}`,
    stage: "shadow_calculation",
    outcome: shadow.status || "unknown",
    selected: {
      mode: shadow.mode || "shadow",
      pipeline: shadow.pipeline || "unknown",
      source: shadow.source || null,
      durationMs: Number(shadow.durationMs || 0),
      calculationOptionDiff: shadow.diff?.calculationOptionKeys || null
    },
    message: shadow.status === "failed"
      ? `shadow calculation failed: ${shadow.error || "unknown error"}`
      : "deterministic shadow calculation recorded without affecting the primary result"
  }));
}

function shadowCalculationLogSummary(shadowCalculations = []) {
  return (Array.isArray(shadowCalculations) ? shadowCalculations : []).map((shadow) => ({
    mode: shadow.mode || "shadow",
    pipeline: shadow.pipeline || "unknown",
    status: shadow.status || "unknown",
    durationMs: Number(shadow.durationMs || 0),
    source: shadow.source || null,
    optionDiff: shadow.diff?.calculationOptionKeys || null
  }));
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
  const cacheKey = `${facilityProfileStoreCacheId(platformStore)}:${orgId || ""}:${facilityId}`;
  const cacheTtlMs = parsePositiveInteger(process.env.FEE_FACILITY_PROFILE_CACHE_TTL_MS, DEFAULT_FACILITY_PROFILE_CACHE_TTL_MS, 86_400_000);
  if (cacheTtlMs > 0) {
    const cached = facilityProfileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }
  }
  const fromStore = platformStore?.getFacility
    ? await platformStore.getFacility(orgId, facilityId)
    : null;
  const facility = fromStore || session.facilitySnapshot || {};
  const profile = {
    source: fromStore ? "platform_facility" : "session_snapshot",
    facilityId,
    facilityStandardKeys: uniqueStrings(facility.facilityStandardKeys || facility.facility_standard_keys || [])
  };
  if (cacheTtlMs > 0) {
    facilityProfileCache.set(cacheKey, {
      profile,
      expiresAt: Date.now() + cacheTtlMs
    });
    pruneFacilityProfileCache();
  }
  return profile;
}

async function loadFeeSettingsForCalculation({ feeStore, orgId, session = {} } = {}) {
  const facilityId = String(session.facilityId || session.facilitySnapshot?.facilityId || "default").trim() || "default";
  const facilitySettings = typeof feeStore?.getFeeSettings === "function"
    ? await feeStore.getFeeSettings(orgId, facilityId)
    : null;
  if (facilitySettings) {
    return facilitySettings;
  }
  const defaultSettings = facilityId !== "default" && typeof feeStore?.getFeeSettings === "function"
    ? await feeStore.getFeeSettings(orgId, "default")
    : null;
  return defaultSettings || defaultFeeSettings({ facilityId });
}

function applyFacilityProfileToPreparation(prepared = {}, facilityProfile = {}, context = {}) {
  const facilityKeys = uniqueStrings(facilityProfile.facilityStandardKeys || []);
  const imagingProfile = facilityImagingProfileFromKeys(facilityKeys);
  const metrics = {
    ...(prepared.metrics || {}),
    facilityProfile: {
      source: facilityProfile.source || "none",
      facilityId: facilityProfile.facilityId || "",
      facilityStandardKeyCount: facilityKeys.length,
      imagingProfile
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
  const optionsWithFacilityKeys = {
    ...currentOptions,
    facility_standard_keys: mergedKeys
  };
  const calculationOptions = applyFacilityImagingProfileToOptions(optionsWithFacilityKeys, imagingProfile, context);
  const imagingProfileApplied = calculationOptions !== optionsWithFacilityKeys;
  const facilityTraceEvents = facilityImagingProfileTraceEvents(calculationOptions, imagingProfile, facilityProfile);
  return {
    ...prepared,
    calculationOptions,
    calculationOptionsAutoKeys: uniqueStrings([
      ...(Array.isArray(prepared.calculationOptionsAutoKeys) ? prepared.calculationOptionsAutoKeys : []),
      "facility_standard_keys",
      ...(imagingProfileApplied ? ["imaging_orders"] : [])
    ]),
    calculationOptionsSource: mergedCalculationOptionsSource(prepared.calculationOptionsSource),
    clinicalExtraction: appendClinicalExtractionTrace(prepared.clinicalExtraction, facilityTraceEvents),
    metrics
  };
}

function facilityImagingProfileFromKeys(keys = []) {
  const normalized = uniqueStrings(keys);
  const profile = {
    electronicImageManagement: normalized.some((key) => /^(画像電子管理|電子画像管理|imaging_electronic_management)$/iu.test(String(key || "").trim())),
    ctEquipmentKind: "",
    mriEquipmentKind: ""
  };
  for (const key of normalized) {
    const text = String(key || "").trim();
    const ctMatch = text.match(/^(?:CT機器区分|ct_equipment_kind)[:：](.+)$/iu);
    if (ctMatch?.[1]) {
      profile.ctEquipmentKind = ctMatch[1].trim();
    }
    const mriMatch = text.match(/^(?:MRI機器区分|mri_equipment_kind)[:：](.+)$/iu);
    if (mriMatch?.[1]) {
      profile.mriEquipmentKind = mriMatch[1].trim();
    }
  }
  return profile;
}

function applyFacilityImagingProfileToOptions(options = {}, imagingProfile = {}, context = {}) {
  const orders = Array.isArray(options.imaging_orders) ? options.imaging_orders : [];
  if (!orders.length) {
    return options;
  }
  let changed = false;
  const enrichedOrders = orders.map((order) => {
    if (!order || typeof order !== "object") {
      return order;
    }
    const kind = String(order.kind || "").trim();
    const enriched = { ...order };
    if (
      imagingProfile.electronicImageManagement
      && ["simple_radiography", "ct", "mri"].includes(kind)
      && !hasOwn(enriched, "electronic_image_management")
      && !hasOwn(enriched, "electronicImageManagement")
      && !hasExplicitElectronicImageManagementAbsence(context.clinicalText, kind)
    ) {
      enriched.electronic_image_management = true;
      changed = true;
    }
    if (kind === "ct" && imagingProfile.ctEquipmentKind && !enriched.ct_equipment_kind && !enriched.ctEquipmentKind) {
      enriched.ct_equipment_kind = imagingProfile.ctEquipmentKind;
      changed = true;
    }
    if (kind === "mri" && imagingProfile.mriEquipmentKind && !enriched.mri_equipment_kind && !enriched.mriEquipmentKind) {
      enriched.mri_equipment_kind = imagingProfile.mriEquipmentKind;
      changed = true;
    }
    return enriched;
  });
  return changed ? { ...options, imaging_orders: enrichedOrders } : options;
}

function appendClinicalExtractionTrace(clinicalExtraction = null, traceEvents = []) {
  const events = Array.isArray(traceEvents) ? traceEvents.filter(Boolean) : [];
  if (!events.length) {
    return clinicalExtraction || null;
  }
  const base = clinicalExtraction && typeof clinicalExtraction === "object" ? clinicalExtraction : {};
  return {
    ...base,
    trace: [
      ...(Array.isArray(base.trace) ? base.trace : []),
      ...events
    ]
  };
}

function facilityImagingProfileTraceEvents(options = {}, imagingProfile = {}, facilityProfile = {}) {
  const orders = Array.isArray(options.imaging_orders) ? options.imaging_orders : [];
  if (!orders.length) {
    return [];
  }
  return orders.map((order, index) => ({
    traceId: `trace_facility_imaging_${index + 1}`,
    stage: "facility_imaging_profile",
    outcome: imagingProfile?.electronicImageManagement || imagingProfile?.ctEquipmentKind || imagingProfile?.mriEquipmentKind
      ? "applied"
      : "not_configured",
    selected: {
      facilityId: facilityProfile.facilityId || "",
      source: facilityProfile.source || "none",
      facilityElectronicImageManagement: imagingProfile?.electronicImageManagement === true,
      facilityCtEquipmentKind: imagingProfile?.ctEquipmentKind || null,
      facilityMriEquipmentKind: imagingProfile?.mriEquipmentKind || null,
      orderKind: order?.kind || null,
      orderElectronicImageManagement: order?.electronic_image_management === true,
      orderCtEquipmentKind: order?.ct_equipment_kind || order?.ctEquipmentKind || null,
      orderMriEquipmentKind: order?.mri_equipment_kind || order?.mriEquipmentKind || null,
      orderProjectionCount: positiveIntegerOrOne(order?.projection_count || order?.view_count)
    },
    message: "facility_imaging_attributes_prepared"
  }));
}

function positiveIntegerOrOne(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 1;
  }
  return Math.max(1, Math.trunc(numeric));
}

function hasExplicitElectronicImageManagementAbsence(text = "", imagingKind = "") {
  const raw = String(text || "");
  if (!raw || !imagingKind) {
    return false;
  }
  const modality = imagingKind === "ct"
    ? /(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u
    : imagingKind === "mri"
      ? /(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u
      : /(X線|Ｘ線|レントゲン|単純撮影)/u;
  return raw.split(/[。\n]/u).some((sentence) => (
    modality.test(sentence)
    && /(?:電子画像管理|電子保存|電子的保存|電子.*管理|フィルム|紙焼き)/u.test(sentence)
    && /(?:なし|無し|行わず|未実施|フィルム|紙焼き)/u.test(sentence)
  ));
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
  if (hasOwn(input, "orders")) {
    calculationInput.orders = Array.isArray(input.orders) ? input.orders : [];
  }
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

function buildFeeCalculationInputSnapshot({
  session = {},
  calculationInput = {},
  calculationInputForSession = {},
  prepared = {},
  capturedAt = new Date()
} = {}) {
  const clinicalText = String(calculationInput.clinicalText || session.clinicalText || "");
  const options = isPlainObject(calculationInputForSession.calculationOptions)
    ? calculationInputForSession.calculationOptions
    : {};
  const clinicalExtraction = prepared.clinicalExtraction || {};
  const clinicalStructuring = prepared.metrics?.clinicalStructuring || {};
  return compactSnapshotObject({
    snapshotVersion: 1,
    capturedAt: timestampForSnapshot(capturedAt),
    feeSessionId: session.feeSessionId || "",
    orgId: session.orgId || "",
    patientId: session.patientId || null,
    patientSnapshot: session.patientSnapshot || null,
    facilityId: session.facilityId || null,
    facilitySnapshot: session.facilitySnapshot || null,
    departmentId: session.departmentId || null,
    departmentSnapshot: session.departmentSnapshot || null,
    serviceDate: session.serviceDate || "",
    claimMonth: session.claimMonth || "",
    setting: session.setting || "outpatient",
    admissionDate: session.admissionDate || null,
    inpatientBasicDays: session.inpatientBasicDays || null,
    clinicalText,
    clinicalTextHash: clinicalTextHash(clinicalText),
    orders: Array.isArray(calculationInputForSession.orders)
      ? calculationInputForSession.orders
      : Array.isArray(session.orders) ? session.orders : [],
    diagnoses: Array.isArray(session.diagnoses) ? session.diagnoses : [],
    insurance: session.insurance || null,
    insuranceSnapshot: session.insuranceSnapshot || null,
    claimContext: isPlainObject(calculationInputForSession.claimContext) ? calculationInputForSession.claimContext : null,
    calculationOptions: options,
    calculationOptionsSource: session.calculationOptionsSource || prepared.calculationOptionsSource || null,
    calculationOptionsAutoKeys: Array.isArray(session.calculationOptionsAutoKeys)
      ? session.calculationOptionsAutoKeys
      : Array.isArray(prepared.calculationOptionsAutoKeys) ? prepared.calculationOptionsAutoKeys : [],
    facilityStandardKeys: uniqueStrings(options.facility_standard_keys || []),
    versions: {
      promptVersion: clinicalExtraction.promptVersion || clinicalStructuring.promptVersion || null,
      ruleSetVersion: clinicalExtraction.ruleSetVersion || clinicalStructuring.ruleSetVersion || null,
      registryVersion: clinicalExtraction.registryVersion || clinicalStructuring.registryVersion || null,
      masterVersion: clinicalExtraction.masterVersion || clinicalStructuring.masterVersion || null
    },
    clinicalExtraction: {
      runId: clinicalExtraction.runId || null,
      source: clinicalExtraction.source || clinicalStructuring.source || null,
      inputHash: clinicalExtraction.inputHash || null,
      model: clinicalExtraction.model || clinicalStructuring.model || null,
      reasoningEffort: clinicalExtraction.reasoningEffort || clinicalStructuring.reasoningEffort || null,
      timeoutMs: Number(clinicalExtraction.timeoutMs || clinicalStructuring.timeoutMs || 0)
    }
  });
}

function compactSnapshotObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compactSnapshotObject(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactSnapshotObject(item)])
  );
}

function timestampForSnapshot(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function enrichSessionOrdersForCalculation(session = {}, feeCalculator) {
  const orders = Array.isArray(session.orders) ? session.orders : [];
  if (!orders.length || typeof feeCalculator?.searchMaster !== "function") {
    const sanitizedOrders = orders.map(sanitizeOrderForCalculation);
    const changed = sanitizedOrders.some((order, index) => order !== orders[index]);
    return { changed, orders: sanitizedOrders };
  }

  let changed = false;
  const concurrency = parsePositiveInteger(process.env.FEE_ORDER_ENRICH_CONCURRENCY, DEFAULT_ORDER_ENRICH_CONCURRENCY, 16);
  const enrichedOrders = await mapWithConcurrency(orders, concurrency, async (order) => {
    const sanitized = sanitizeOrderForCalculation(order);
    const enriched = await enrichOrderForCalculation(sanitized, feeCalculator);
    if (enriched !== order) {
      changed = true;
    }
    return enriched;
  });
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
  const exclusion = parseElectronicExclusionWarning(warning);
  if (exclusion) {
    return `同日複数処置の確認: ${exclusion.baseName}と${exclusion.excludedName}を同日に算定しています。別部位・別創傷として処置した根拠を確認してください。`;
  }
  if (/In-house medication fee requires drug inputs/i.test(warning)) {
    return "院内処方の薬剤情報確認: 薬剤料を計算するには、薬剤名、用量、日数または総量が必要です。";
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
    return "判断料確認: 検査判断料の候補です。実施検査と同月算定条件を確認してください。";
  }
  if (/Collection fee requested by blood_venous/i.test(warning)) {
    return "採血料確認: 静脈採血料の候補です。採血実施と算定条件を確認してください。";
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
  const exclusion = parseElectronicExclusionWarning(text);
  if (exclusion) {
    return `electronic_exclusion:${[exclusion.baseCode, exclusion.excludedCode].sort().join(":")}`;
  }
  const normalizedExclusion = text.match(/^同日複数処置の確認\s*[:：]\s*(.+?)と(.+?)を同日に算定/u);
  if (normalizedExclusion) {
    return `electronic_exclusion:${[normalizeWarningLabel(normalizedExclusion[1]), normalizeWarningLabel(normalizedExclusion[2])].sort().join(":")}`;
  }
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

function parseElectronicExclusionWarning(value = "") {
  const match = String(value || "").match(/^Exclusion candidate:\s*(\d{6,})\s+(.+?)\s+and\s+(\d{6,})\s+(.+?)\s+matched from\s+(.+)$/iu);
  if (!match) {
    return null;
  }
  return {
    baseCode: match[1],
    baseName: String(match[2] || "").trim(),
    excludedCode: match[3],
    excludedName: String(match[4] || "").trim(),
    matchedFrom: String(match[5] || "").trim()
  };
}

function normalizeWarningLabel(value = "") {
  return String(value || "").replace(/\s+/gu, "").trim();
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

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isSameIsoWeek(left = "", right = "") {
  const leftDate = parseIsoDate(left);
  const rightDate = parseIsoDate(right);
  if (!leftDate || !rightDate) {
    return false;
  }
  const leftMonday = isoWeekMonday(leftDate);
  const rightMonday = isoWeekMonday(rightDate);
  return leftMonday.getTime() === rightMonday.getTime();
}

function isoWeekMonday(date) {
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() - day + 1);
  return normalized;
}

function parseIsoDate(value = "") {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pruneFacilityProfileCache() {
  const now = Date.now();
  for (const [cacheKey, entry] of facilityProfileCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      facilityProfileCache.delete(cacheKey);
    }
  }
  while (facilityProfileCache.size > 500) {
    const oldestKey = facilityProfileCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    facilityProfileCache.delete(oldestKey);
  }
}

function clearFacilityProfileCacheFor(orgId = "", facilityId = "") {
  const orgPart = `:${orgId || ""}:${facilityId || ""}`;
  for (const cacheKey of facilityProfileCache.keys()) {
    if (cacheKey.endsWith(orgPart)) {
      facilityProfileCache.delete(cacheKey);
    }
  }
}

function facilityProfileStoreCacheId(store) {
  if (!store || (typeof store !== "object" && typeof store !== "function")) {
    return "default";
  }
  const existing = facilityProfileStoreIds.get(store);
  if (existing) {
    return existing;
  }
  facilityProfileStoreIdCounter += 1;
  const storeId = `store_${facilityProfileStoreIdCounter}`;
  facilityProfileStoreIds.set(store, storeId);
  return storeId;
}

async function mapWithConcurrency(items = [], concurrency = 4, mapper = async (item) => item) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, 32));
  const results = new Array(list.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));
  return results;
}

function feeMasterStatus(feeCalculator) {
  return typeof feeCalculator.readiness === "function"
    ? feeCalculator.readiness()
    : { provider: "custom", masterDbConfigured: null, masterDbPathExists: null };
}

async function feeCalculatorReadiness(feeCalculator) {
  if (typeof feeCalculator.readinessDetailed === "function") {
    return feeCalculator.readinessDetailed();
  }
  return feeMasterStatus(feeCalculator);
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
  const maxBytes = parsePositiveInteger(process.env.FEE_API_MAX_JSON_BODY_BYTES, DEFAULT_MAX_JSON_BODY_BYTES, 50 * 1024 * 1024);
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.name = "PayloadTooLargeError";
      error.statusCode = 413;
      throw error;
    }
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

// レセ電の文字コード指定を正規化。既定は Shift_JIS(レセ電の標準)。
function normalizeUkeEncoding(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[-_]/g, "");
  if (normalized === "utf8" || normalized === "utf") {
    return "utf-8";
  }
  return "shift_jis";
}

function writeResponse(res, response) {
  // raw応答(CSV等)はそのまま、それ以外はJSONとして返す
  if (response && response.raw) {
    res.writeHead(response.statusCode, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...response.headers
    });
    res.end(response.body);
    return;
  }
  sendJson(res, response.statusCode, response.body, response.headers);
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

function requireCalculationWorkerAuth(input = {}) {
  const env = input.processEnv || process.env;
  const expected = String(env.FEE_CALCULATION_WORKER_TOKEN || "").trim();
  const authMode = String(env.FEE_CALCULATION_WORKER_AUTH_MODE || "").trim().toLowerCase();
  if (!expected && isTestEnvironment(input.env)) {
    return;
  }
  if (!expected && authMode === "iam") {
    return;
  }
  if (!expected) {
    const error = new Error("fee calculation worker token is not configured");
    error.name = "ServiceUnavailableError";
    error.statusCode = 503;
    throw error;
  }
  const provided = workerTokenFromHeaders(input.headers || {});
  if (!provided || !timingSafeEqualString(provided, expected)) {
    const error = new Error("invalid fee calculation worker token");
    error.name = "UnauthorizedError";
    error.statusCode = 401;
    throw error;
  }
}

function workerTokenFromHeaders(headers = {}) {
  const direct = String(headerValue(headers, "x-fee-worker-token") || "").trim();
  if (direct) {
    return direct;
  }
  const authorization = String(headerValue(headers, "authorization") || "").trim();
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match ? match[1].trim() : "";
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function decodeCalculationJobWorkerPayload(body = {}) {
  const pubsubData = body?.message?.data;
  if (pubsubData) {
    try {
      return JSON.parse(Buffer.from(String(pubsubData), "base64").toString("utf8"));
    } catch {
      const error = new Error("Pub/Sub message data must be base64 encoded JSON");
      error.name = "BadRequestError";
      error.statusCode = 400;
      throw error;
    }
  }
  if (isPlainObject(body?.payload)) {
    return body.payload;
  }
  return body;
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

function bootstrapIncludeOptionsFromUrl(url) {
  const raw = String(url.searchParams.get("include") || "").trim();
  if (!raw) {
    return {
      patients: true,
      facilities: true,
      departments: true,
      masterStatus: true,
      sessions: true
    };
  }
  const include = new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  return {
    patients: include.has("patients"),
    facilities: include.has("facilities"),
    departments: include.has("departments"),
    masterStatus: include.has("masterStatus") || include.has("master_status"),
    sessions: include.has("sessions")
  };
}

function patientListOptionsFromUrl(url) {
  return {
    search: String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim(),
    limit: parsePositiveInteger(url.searchParams.get("limit"), 50, 200)
  };
}

function filterPatientsForFeeSearch(patients = [], options = {}) {
  const list = Array.isArray(patients) ? patients : [];
  const keyword = normalizeFeeSearchText(options.search || "");
  const filtered = keyword
    ? list.filter((patient) => normalizeFeeSearchText([
      patient.displayName,
      patient.patientId,
      patient.patientCode,
      patient.primaryPatientNumber,
      ...(Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds : [])
    ].join(" ")).includes(keyword))
    : list;
  return filtered
    .slice()
    .sort(comparePatientsByRecentUpdate)
    .slice(0, parsePositiveInteger(options.limit, 50, 200));
}

function comparePatientsByRecentUpdate(a = {}, b = {}) {
  const timestampA = patientSortTimestamp(a);
  const timestampB = patientSortTimestamp(b);
  if (timestampA !== timestampB) {
    return timestampB - timestampA;
  }
  return String(a.displayName || a.patientId || "").localeCompare(String(b.displayName || b.patientId || ""), "ja");
}

function patientSortTimestamp(patient = {}) {
  const raw = patient.updatedAt || patient.createdAt || "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeFeeSearchText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

function feeSessionDetailOptionsFromUrl(url) {
  return {
    includeReviewItems: String(url.searchParams.get("includeReviewItems") || "true").trim().toLowerCase() !== "false",
    includeDebug: ["true", "1", "yes"].includes(String(
      url.searchParams.get("includeDebug") || url.searchParams.get("debug") || ""
    ).trim().toLowerCase())
  };
}

function shouldIncludeFeeSessionDebug(options = {}) {
  return options.includeDebug === true || options.includeReviewItems !== false;
}

function compactFeeSessionForWorkbench(session = {}) {
  if (!session.calculationResult || typeof session.calculationResult !== "object") {
    return session;
  }
  const {
    clinicalEvents,
    canonicalClinicalFacts,
    masterCandidates,
    billingCandidates,
    reviewIssues,
    clinicalExtraction,
    shadowCalculations,
    inputSnapshot,
    rawResult,
    ...calculationResult
  } = session.calculationResult;
  void clinicalEvents;
  void canonicalClinicalFacts;
  void masterCandidates;
  void billingCandidates;
  void reviewIssues;
  void clinicalExtraction;
  void shadowCalculations;
  void inputSnapshot;
  void rawResult;
  return {
    ...session,
    calculationResult
  };
}

function feeSessionStatusView(session = {}) {
  return {
    feeSessionId: session.feeSessionId || session.sessionId || "",
    sessionId: session.sessionId || session.feeSessionId || "",
    status: session.status || "draft",
    calculationProgress: session.calculationProgress || null,
    calculationSummary: session.calculationSummary || null,
    latestCalculationId: session.latestCalculationId || null,
    updatedAt: session.updatedAt || null
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

function isTestEnvironment(env) {
  return String(env || "").trim().toLowerCase() === "test";
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
