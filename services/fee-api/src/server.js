import crypto from "node:crypto";
import http from "node:http";
import { inflateRawSync } from "node:zlib";
import {
  forbiddenError,
  hasProductAccess,
  publicAuthErrorCode,
  requirePlatformCsrf,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  validateCreateFeeCalculationInput,
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateSidecarCalculationInput,
  defaultFeeSettings,
  validateUpdateFeeSettingsInput,
  validateUpdateFeeSessionInput
} from "../../../packages/fee-contracts/src/index.js";
import iconv from "iconv-lite";
import {
  buildCandidateWorkbench,
  buildClinicDiagnosisReport,
  buildMissingBillingReviewIssues,
  buildIndicationReviewIssues,
  claimCheckLookupCodes,
  buildReceiptCsv,
  buildReceiptDenshin,
  buildReceiptDraft,
  buildMonthlyReceiptDraft,
  buildMonthlyBaselineDiagnosis,
  buildReceiptExportValidation,
  buildReviewItems,
  lineInclusionStatus,
  serializeUke
} from "../../../packages/fee-core/src/index.js";
import {
  departmentSnapshot,
  facilitySnapshot,
  insuranceSnapshot,
  patientSnapshot,
  productIds,
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
const SIDECAR_PRODUCT_ID = productIds.homisSidecar;
const SIDECAR_TOKEN_SCOPE = "sidecar:calculate";
const SIDECAR_CONTRACT_VERSION = "v1";
const SIDECAR_PRODUCT_ROLES = ["admin", "doctor", "nurse", "medical_clerk"];
const FEE_PRODUCT_ROLES = ["admin", "doctor", "nurse", "medical_clerk", "viewer"];
const FEE_WRITE_ROLES = ["admin", "doctor", "nurse", "medical_clerk"];
const DEFAULT_OPENAI_FEE_CLINICAL_TIMEOUT_MS = 60000;
const DEFAULT_FACILITY_PROFILE_CACHE_TTL_MS = 60_000;
const DEFAULT_ORDER_ENRICH_CONCURRENCY = 4;
const DEFAULT_MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MONTHLY_VIEW_SESSION_LIMIT = 50_000;
const DEFAULT_BASELINE_DIAGNOSIS_SESSION_LIMIT = 5000;
const DEFAULT_BASELINE_DIAGNOSIS_CLAIM_LIMIT = 5000;
const DEFAULT_RECALCULATION_DIFF_PAYLOAD_LIMIT = 200;
const MEISAISHO_HAKKO_STANDARD_KEY = "meisaisho_hakko_taisei";
const MEISAISHO_HAKKO_CLINIC_FACILITY_TYPES = new Set([
  "clinic",
  "medical_clinic",
  "dental_clinic",
  "medical_office",
  "診療所",
  "歯科診療所",
  "クリニック"
]);
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
  assertFeeSidecarRuntimeConfiguration({
    env,
    processEnv: options.processEnv || process.env,
    sidecarEnabled: options.sidecarEnabled,
    sidecarAllowedExtensionIds: options.sidecarAllowedExtensionIds,
    sidecarAllowedSelectorContractVersions: options.sidecarAllowedSelectorContractVersions
  });

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
        sessionSecret: options.sessionSecret,
        processEnv: options.processEnv,
        sidecarEnabled: options.sidecarEnabled,
        sidecarAllowedExtensionIds: options.sidecarAllowedExtensionIds,
        sidecarAllowedSelectorContractVersions: options.sidecarAllowedSelectorContractVersions,
        sidecarRevokedDeviceIds: options.sidecarRevokedDeviceIds
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
    let feeReadiness;
    try {
      feeReadiness = await feeCalculatorReadiness(feeCalculator);
    } catch (error) {
      if (!error?.masterContent) {
        throw error;
      }
      logFeeApiError(error, { stage: "readyz", method, path: url.pathname });
      return {
        statusCode: 503,
        body: {
          status: "not_ready",
          service: "fee-api",
          feeCalculator: { masterContent: error.masterContent }
        }
      };
    }
    return ok({
      status: "ok",
      service: "fee-api",
      env: input.env || "local",
      projectId: input.projectId || "medical-core-stg",
      region: input.region || "asia-northeast1",
      feeCalculator: feeReadiness,
      startedAt: input.startedAt instanceof Date
        ? input.startedAt.toISOString()
        : new Date().toISOString()
    });
  }

  if (method === "OPTIONS" && (
    url.pathname.startsWith("/v1/fee/")
    || url.pathname.startsWith("/v1/integrations/sidecar/")
  )) {
    return noContent();
  }

  if (method === "POST" && matches(parts, ["v1", "integrations", "sidecar", "calculate"])) {
    requireSidecarFeature(input);
    const context = await requireSidecarContext(input, platformStore);
    await consumeSidecarCalculationRateLimit(input, platformStore, context);
    const normalized = validateSidecarCalculationInput(input.body || {});
    requireAllowedSidecarSelectorContract(input, normalized.extractionProof.selectorContractVersion);
    assertFreshSidecarExtraction(normalized.extractionProof, input.now || new Date());
    const facility = await requireFacility(context, platformStore, normalized.facilityId);
    const department = await resolveDepartment(context, platformStore, normalized.departmentId);
    const identity = sidecarSourceIdentity(context.session.orgId, normalized);
    const sourceRevisionHash = sidecarSourceRevisionHash(normalized);
    const encounterDetails = {
      sameBuilding: normalized.sameBuilding,
      sameBuildingSource: normalized.sameBuildingSource,
      singleBuildingPatientCount: normalized.singleBuildingPatientCount
    };
    const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const upserted = await feeStore.upsertSidecarCalculationDraft({
      ...normalized,
      orgId: context.session.orgId,
      sidecarDraftId: identity.sidecarDraftId,
      sidecarPatientKey: identity.sidecarPatientKey,
      externalSourceSystem: normalized.sourceSystem,
      idempotencyKeyHash: identity.idempotencyKeyHash,
      sourceRevisionHash,
      encounterDetails,
      facilitySnapshot: facilitySnapshot(facility, now),
      departmentSnapshot: department ? departmentSnapshot(department, now) : null,
      patientSnapshot: {
        patientId: identity.sidecarPatientKey,
        displayName: `HOMIS患者 ${normalized.externalPatientId}`,
        sex: "unknown",
        capturedAt: now.toISOString()
      },
      createdByMemberId: context.session.memberId,
      lastCalculatedByMemberId: context.session.memberId,
      expiresAt: sidecarDraftExpiry(now, input.processEnv || process.env)
    });
    const draftStore = sidecarDraftCalculationStore(feeStore);
    try {
      const calculation = await calculateFeeSessionNow({
        context,
        feeCalculator,
        feeStore: draftStore,
        platformStore,
        input,
        feeSessionId: upserted.sidecarDraft.sidecarDraftId,
        current: upserted.sidecarDraft,
        calculationInput: validateCreateFeeCalculationInput({})
      });
      return upserted.created
        ? created(sidecarCalculationResponse(calculation.feeSession))
        : ok(sidecarCalculationResponse(calculation.feeSession));
    } catch (error) {
      await markFeeCalculationFailed({
        context,
        feeStore: draftStore,
        feeSessionId: upserted.sidecarDraft.sidecarDraftId,
        error,
        now
      });
      throw error;
    }
  }

  if (!url.pathname.startsWith("/v1/fee/")) {
    return notFound("Route not found");
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "internal", "calculation-jobs", "run"])) {
    requireCalculationWorkerAuth(input);
    const payload = decodeCalculationJobWorkerPayload(input.body || {});
    const result = await runFeeCalculationJob({
      input,
      platformStore,
      feeStore,
      feeCalculator,
      payload
    });
    if (result.alreadyRunning) {
      return {
        statusCode: 409,
        headers: { "retry-after": "5" },
        body: result
      };
    }
    return ok(result);
  }

  const context = await requireFeeContext(input, platformStore);
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    requireFeeWriteAccess(context);
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "sidecar-drafts"])) {
    requireSidecarFeature(input);
    const result = await feeStore.listSidecarCalculationDrafts(
      context.session.orgId,
      sidecarDraftListOptionsFromUrl(url)
    );
    return ok({
      ...result,
      sidecarDrafts: (Array.isArray(result.sidecarDrafts) ? result.sidecarDrafts : [])
        .map(sidecarDraftListItemView)
    });
  }

  if (method === "GET" && isSidecarDraftDocument(parts)) {
    requireSidecarFeature(input);
    const sidecarDraft = await feeStore.getSidecarCalculationDraft(context.session.orgId, parts[3]);
    if (!sidecarDraft) {
      return notFound("sidecar calculation draft not found");
    }
    return ok({ sidecarDraft: sidecarDraftDetailView(sidecarDraft) });
  }

  if (method === "POST" && isSidecarDraftAdoptionRoute(parts)) {
    requireSidecarFeature(input);
    requireMutationCsrf(input, context.session);
    const sidecarDraft = await feeStore.getSidecarCalculationDraft(context.session.orgId, parts[3]);
    if (!sidecarDraft) {
      return notFound("sidecar calculation draft not found");
    }
    const patientId = String(input.body?.patientId || "").trim();
    if (!patientId) {
      throw requestValidationError("patientId is required to adopt a sidecar draft");
    }
    const patient = await resolveFeePatient(context, platformStore, { patientId });
    const patientMatch = sidecarPatientMatch(patient, sidecarDraft);
    if (!patientMatch.matched) {
      throw requestValidationError("selected patient does not match the HOMIS patient identifier");
    }
    const facility = await requireFacility(context, platformStore, sidecarDraft.facilityId);
    const department = await resolveDepartment(context, platformStore, sidecarDraft.departmentId);
    const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const adopted = await feeStore.adoptSidecarCalculationDraft(context.session.orgId, parts[3], {
      orgId: context.session.orgId,
      patientId: patient.patientId,
      patientRef: patient.patientId,
      patientSnapshot: patientSnapshot(patient, now),
      insuranceSnapshot: insuranceSnapshot(patient, sidecarDraft.serviceDate || null, now),
      facilityId: facility.facilityId,
      facilitySnapshot: facilitySnapshot(facility, now),
      departmentId: department?.departmentId || null,
      departmentSnapshot: department ? departmentSnapshot(department, now) : null,
      serviceDate: sidecarDraft.serviceDate,
      claimMonth: sidecarDraft.claimMonth,
      setting: sidecarDraft.setting,
      encounterDetails: sidecarDraft.encounterDetails,
      receptionTime: sidecarDraft.receptionTime,
      clinicalText: sidecarDraft.clinicalText,
      orders: sidecarDraft.orders,
      diagnoses: sidecarDraft.diagnoses,
      diagnosesSource: sidecarDraft.diagnosesSource,
      sourceSystem: "homis_sidecar_adopted",
      createdByMemberId: context.session.memberId
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.sidecar_draft_adopted",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_session",
      targetId: adopted.feeSession?.feeSessionId || parts[3],
      productId: PRODUCT_ID,
      safePayload: {
        sidecarDraftId: parts[3],
        feeSessionId: adopted.feeSession?.feeSessionId || null,
        patientId: adopted.feeSession?.patientId || patient.patientId,
        patientMatchBasis: patientMatch.basis,
        alreadyAdopted: adopted.alreadyAdopted === true
      }
    });
    return adopted.alreadyAdopted
      ? ok({ feeSession: adopted.feeSession, sidecarDraft: sidecarDraftSummaryView(adopted.sidecarDraft), alreadyAdopted: true })
      : created({ feeSession: adopted.feeSession, sidecarDraft: sidecarDraftSummaryView(adopted.sidecarDraft), alreadyAdopted: false });
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

  // 既存レセ(UKE/レセコンCSV由来のbaselineClaims)を外部請求履歴として一括取込する。
  // 取り込んだ履歴は historyPolicy.externalHistoryEnabled のとき初診/再診・同月回数判定に使われる。
  if (method === "POST" && parts.length === 6 && matches(parts.slice(0, 3), ["v1", "fee", "patients"]) && parts[4] === "billing-history" && parts[5] === "import-baseline") {
    requireFeeAdminContext(context);
    requireMutationCsrf(input, context.session);
    const patientId = decodeURIComponent(parts[3]);
    const body = input.body || {};
    // 履歴取込は複数月が本質のため、直接指定の baselineClaims は月フィルタなしで受ける。
    // UKE/CSVアップロード時のみ(パーサ都合で)claimMonth 必須の既存経路を使う。
    const directClaims = Array.isArray(body.baselineClaims ?? body.baseline_claims)
      ? (body.baselineClaims ?? body.baseline_claims)
      : [];
    let importClaims;
    if (directClaims.length) {
      importClaims = directClaims
        .filter((claim) => claim && typeof claim === "object")
        .map((claim) => ({
          patientId: String(claim.patientId ?? claim.patient_id ?? "").trim(),
          claimMonth: String(claim.claimMonth ?? claim.claim_month ?? "").trim().slice(0, 7),
          lines: Array.isArray(claim.lines) ? claim.lines : (Array.isArray(claim.lineItems) ? claim.lineItems : [])
        }))
        .filter((claim) => claim.patientId && /^\d{4}-\d{2}$/u.test(claim.claimMonth));
    } else {
      const baseline = await baselineClaimsFromDiagnosisBody({
        body,
        claimMonth: String(body.claimMonth ?? body.claim_month ?? "").trim(),
        feeCalculator,
        processEnv: input.processEnv || process.env
      });
      importClaims = baseline.baselineClaims;
    }
    const externalPatientId = String(body.externalPatientId ?? body.external_patient_id ?? "").trim();
    const claims = importClaims
      .filter((claim) => !externalPatientId || String(claim.patientId || "") === externalPatientId);
    if (!claims.length) {
      throw requestValidationError("既存レセを取り込めませんでした。baselineClaims、UKE/CSVファイル、externalPatientId を確認してください。");
    }
    // 複数患者のレセを単一患者の履歴へ混在させない: externalPatientId 省略時は
    // 入力内の外部患者IDが一種類であることを必須にする。
    const distinctExternalIds = uniqueStrings(claims.map((claim) => String(claim.patientId || "")));
    if (!externalPatientId && distinctExternalIds.length > 1) {
      throw requestValidationError(
        `入力に複数の外部患者ID(${distinctExternalIds.slice(0, 5).join(", ")}${distinctExternalIds.length > 5 ? " ほか" : ""})が含まれています。externalPatientId で対象患者を指定してください。`
      );
    }
    if (claims.length > 60) {
      throw requestValidationError("一括取込は60レセ(患者×月)までです。対象患者の月に絞ってください。");
    }
    const events = [];
    for (const claim of claims) {
      const claimMonth = String(claim.claimMonth || claim.claim_month || "").trim();
      const eventInput = normalizeBillingHistoryEventInput({
        patientId,
        // UKEは請求月粒度のため、暦上必ず存在する月初日を履歴イベント日とする。
        serviceDate: /^\d{4}-\d{2}$/u.test(claimMonth) ? `${claimMonth}-01` : claimMonth,
        source: "baseline_import",
        sourceLabel: `既存レセ取込 ${claimMonth}`,
        lineItems: (Array.isArray(claim.lines) ? claim.lines : []).map((line) => ({
          code: line.code,
          name: line.name,
          points: line.points,
          quantity: line.count ?? line.quantity ?? 1
        }))
      });
      const event = typeof feeStore.createBillingHistoryEvent === "function"
        ? await feeStore.createBillingHistoryEvent(context.session.orgId, eventInput)
        : eventInput;
      events.push(event);
    }
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.billing_history_imported",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patientId,
      productId: PRODUCT_ID,
      safePayload: {
        patientId,
        source: "baseline_import",
        importedClaimCount: events.length,
        lineItemCount: events.reduce((sum, event) => sum + (Array.isArray(event.lineItems) ? event.lineItems.length : 0), 0)
      }
    });
    return created({ billingHistoryEvents: events, importedClaimCount: events.length });
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
    const facilityValidation = await validateMeisaishoHakkoFacilitySettings({
      platformStore,
      orgId: context.session.orgId,
      facilityId,
      settings
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
        changedFields: Object.keys(input.body || {}).sort(),
        warningCodes: facilityValidation.warnings.map((warning) => warning.code),
        meisaishoHakkoFacilityTypeStatus: facilityValidation.facilityTypeStatus
      }
    });
    return ok({ settings: saved, warnings: facilityValidation.warnings });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "sessions"])) {
    return ok(await feeStore.listSessions(context.session.orgId, feeSessionListOptionsFromUrl(url)));
  }

  // #4段階A: 患者×月でセッションを名寄せした月次サマリ
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-summary"])) {
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const sessionList = await listSessionsForMonthlyView(feeStore, context.session.orgId, claimMonth, {
      processEnv: input.processEnv || process.env
    });
    return ok(buildMonthlyClaimSummary(sessionList, { claimMonth }));
  }

  // STG限定 再算定差分診断: 既存レセと、アップロードされたclaim payloadを当社エンジンで再算定した結果を突合
  if (method === "POST" && matches(parts, ["v1", "fee", "recalculation-diff-diagnosis"])) {
    if (!isStgEnvironment(input.env)) {
      return notFound("Route not found");
    }
    requireBaselineDiagnosisContext(context);
    requireMutationCsrf(input, context.session);
    const performanceStartedAt = Date.now();
    const stageTimings = [];
    const body = input.body || {};
    const dataset = await measureStage(stageTimings, "parseRecalculationDiffDataset", () => (
      parseRecalculationDiffDatasetFromBody(body)
    ));
    const claimMonth = resolveRecalculationDiffClaimMonth(body, dataset);
    if (!/^\d{4}-\d{2}$/u.test(claimMonth)) {
      throw requestValidationError("claimMonth must use YYYY-MM");
    }
    const diagnosisBody = mergeRecalculationDiffDatasetIntoBody({ ...body, claimMonth }, dataset);
    const baseline = await measureStage(stageTimings, "baselineClaimsFromDiagnosisBody", () => (
      baselineClaimsFromDiagnosisBody({
        body: diagnosisBody,
        claimMonth,
        feeCalculator,
        processEnv: input.processEnv || process.env
      })
    ));
    const calculationPayloadLimit = recalculationDiffPayloadLimit(input.processEnv || process.env);
    const preparedPayloads = await measureStage(stageTimings, "prepareCalculationPayloads", () => {
      let calculationPayloads = normalizeCalculationPayloadsForRecalculationDiff(diagnosisBody, {
        claimMonth,
        limit: calculationPayloadLimit
      });
      const generatedPayloads = calculationPayloads.length
        ? { payloads: [], warnings: [], stats: {} }
        : buildCalculationPayloadsFromRecalculationDiffDataset(dataset, { claimMonth });
      if (!calculationPayloads.length) {
        calculationPayloads = generatedPayloads.payloads;
      }
      if (calculationPayloads.length > calculationPayloadLimit) {
        throw requestValidationError(`recalculation diff diagnosis is limited to ${calculationPayloadLimit} calculation payloads`);
      }
      if (!calculationPayloads.length) {
        throw requestValidationError("再算定元データを取り込めませんでした。再算定用JSON/JSONL、または患者・カルテ・オーダー・病名ファイルの患者IDと診療日を確認してください。");
      }
      return { calculationPayloads, generatedPayloads };
    });
    const { calculationPayloads, generatedPayloads } = preparedPayloads;
    const sessions = await measureStage(stageTimings, "calculateRecalculationDiffSessions", () => (
      calculateRecalculationDiffSessions({
        feeCalculator,
        calculationPayloads,
        claimMonth
      })
    ));
    const diagnosis = await measureStage(stageTimings, "buildMonthlyBaselineDiagnosis", () => (
      buildMonthlyBaselineDiagnosis({
        sessions,
        baselineClaims: baseline.baselineClaims,
        claimMonth,
        knownUnsupportedCodes: Array.isArray(diagnosisBody.knownUnsupportedCodes ?? diagnosisBody.known_unsupported_codes) ? (diagnosisBody.knownUnsupportedCodes ?? diagnosisBody.known_unsupported_codes) : [],
        codeMap: isPlainObject(diagnosisBody.codeMap ?? diagnosisBody.code_map) ? (diagnosisBody.codeMap ?? diagnosisBody.code_map) : null
      })
    ));
    const diagnosisDetails = await measureStage(stageTimings, "buildRecalculationDiffDiagnostics", () => {
      const reproductionFailures = buildRecalculationReproductionFailures({
        calculationPayloads,
        sessions,
        dataset,
        claimMonth
      });
      const diagnostics = buildRecalculationDiffDiagnostics({
        baseline,
        calculationPayloads,
        sessions,
        dataset,
        claimMonth,
        reproductionFailures
      });
      const ingestion = recalculationDiffIngestionSummary({
        baseline,
        calculationPayloads,
        dataset,
        generatedPayloads
      });
      return { reproductionFailures, diagnostics, ingestion };
    });
    const { reproductionFailures, diagnostics, ingestion } = diagnosisDetails;
    diagnosis.summary = {
      ...(diagnosis.summary || {}),
      reproductionFailureCount: reproductionFailures.length
    };
    await measureStage(stageTimings, "audit", () => platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.recalculation_diff_diagnosis_run",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_recalculation_diff_diagnosis",
      targetId: claimMonth,
      productId: PRODUCT_ID,
      safePayload: {
        claimMonth,
        baselineFormat: baseline.baselineFormat || (baseline.baselineClaims.length ? "claims" : "none"),
        baselineClaimCount: baseline.baselineClaims.length,
        calculationPayloadCount: calculationPayloads.length,
        missingCandidateCount: diagnosis.summary?.missingCandidateCount || 0,
        needsReviewCount: diagnosis.summary?.needsReviewCount || 0,
        considerCount: diagnosis.summary?.considerCount || 0,
        reproductionFailureCount: reproductionFailures.length,
        homeCareUnsupportedCount: diagnostics.recalculationAccuracy?.homeCareUnsupportedCount || 0,
        datasetWarningCount: ingestion.warningCount || 0
      }
    }));
    const diagnosisMetrics = buildEndpointStageMetrics(stageTimings, performanceStartedAt, {
      sessionCount: sessions.length,
      baselineClaimCount: baseline.baselineClaims.length,
      calculationPayloadCount: calculationPayloads.length
    });
    logFeeEndpointPerformance("fee.recalculation_diff_diagnosis.performance", {
      orgId: context.session.orgId,
      claimMonth,
      metrics: diagnosisMetrics
    });
    return ok({ ...diagnosis, ingestion, reproductionFailures, diagnostics, diagnosisMetrics });
  }

  // 導入前 一括レセプト差分診断: 既存レセ(baselineClaims) と 当社算定(セッション) を患者×月で突合
  if (method === "POST" && matches(parts, ["v1", "fee", "baseline-diagnosis"])) {
    if (!isStgEnvironment(input.env)) {
      return notFound("Route not found");
    }
    requireBaselineDiagnosisContext(context);
    requireMutationCsrf(input, context.session);
    const performanceStartedAt = Date.now();
    const stageTimings = [];
    const body = input.body || {};
    const claimMonth = String(body.claimMonth ?? body.claim_month ?? "").trim();
    if (!/^\d{4}-\d{2}$/u.test(claimMonth)) {
      throw requestValidationError("claimMonth must use YYYY-MM");
    }
    const baseline = await measureStage(stageTimings, "baselineClaimsFromDiagnosisBody", () => (
      baselineClaimsFromDiagnosisBody({
        body,
        claimMonth,
        feeCalculator,
        processEnv: input.processEnv || process.env
      })
    ));
    const sessionList = await measureStage(stageTimings, "listSessionsForBaselineDiagnosis", () => (
      listSessionsForBaselineDiagnosis(feeStore, context.session.orgId, {
        claimMonth,
        limit: baselineDiagnosisSessionLimit(input.processEnv || process.env),
        patientIds: baselineInternalPatientIds(baseline)
      })
    ));
    const diagnosis = await measureStage(stageTimings, "buildMonthlyBaselineDiagnosis", () => (
      buildMonthlyBaselineDiagnosis({
        sessions: sessionList,
        baselineClaims: baseline.baselineClaims,
        claimMonth,
        knownUnsupportedCodes: Array.isArray(body.knownUnsupportedCodes ?? body.known_unsupported_codes) ? (body.knownUnsupportedCodes ?? body.known_unsupported_codes) : [],
        codeMap: isPlainObject(body.codeMap ?? body.code_map) ? (body.codeMap ?? body.code_map) : null
      })
    ));
    await measureStage(stageTimings, "audit", () => platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.baseline_diagnosis_run",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_baseline_diagnosis",
      targetId: claimMonth,
      productId: PRODUCT_ID,
      safePayload: {
        claimMonth,
        baselineFormat: baseline.baselineFormat || (baseline.baselineClaims.length ? "claims" : "none"),
        baselineClaimCount: baseline.baselineClaims.length,
        sessionCount: sessionList.length,
        missingCandidateCount: diagnosis.summary?.missingCandidateCount || 0,
        needsReviewCount: diagnosis.summary?.needsReviewCount || 0,
        considerCount: diagnosis.summary?.considerCount || 0
      }
    }));
    const diagnosisMetrics = buildEndpointStageMetrics(stageTimings, performanceStartedAt, {
      sessionCount: sessionList.length,
      baselineClaimCount: baseline.baselineClaims.length
    });
    logFeeEndpointPerformance("fee.baseline_diagnosis.performance", {
      orgId: context.session.orgId,
      claimMonth,
      metrics: diagnosisMetrics
    });
    return ok({ ...diagnosis, diagnosisMetrics });
  }

  // STG限定 売上改善診断(導入前コンサル): 既存レセ(UKE/CSV・匿名化済み)に決定論点検
  // (算定もれ/適応/禁忌/併用)を回し、コンサル成果物のレポートを返す。
  if (method === "POST" && matches(parts, ["v1", "fee", "clinic-diagnosis"])) {
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
    const baseline = await baselineClaimsFromDiagnosisBody({
      body,
      claimMonth,
      feeCalculator,
      processEnv: input.processEnv || process.env
    });
    const { claims, dpcSkippedCount, inpatientCount } = clinicCheckClaimsFromBaseline(baseline.baselineClaims, claimMonth);
    if (!claims.length) {
      throw requestValidationError(
        dpcSkippedCount
          ? `DPCレセプト${dpcSkippedCount}件は本診断の対象外です。医科出来高レセプトを取り込んでください。`
          : "診断対象のレセプトを取り込めませんでした。UKE/CSVの形式と請求月を確認してください。"
      );
    }
    const report = await buildClinicDiagnosisReportForClaims({ feeCalculator, claims });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "fee.clinic_diagnosis_run",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "fee_clinic_diagnosis",
      targetId: claimMonth,
      productId: PRODUCT_ID,
      safePayload: {
        claimMonth,
        baselineFormat: baseline.baselineFormat || (baseline.baselineClaims.length ? "claims" : "none"),
        claimCount: report.summary?.claimCount || 0,
        patientCount: report.summary?.patientCount || 0,
        billingMissCount: report.summary?.billingMissCount || 0,
        assessmentRiskCount: report.summary?.assessmentRiskCount || 0,
        errorCount: report.summary?.errorCount || 0
      }
    });
    return ok({
      claimMonth,
      report,
      ingestion: {
        baselineClaimCount: baseline.baselineClaims.length,
        analyzedClaimCount: claims.length,
        inpatientClaimCount: inpatientCount,
        dpcSkippedCount
      }
    });
  }

  // 患者×請求月で集計した月次レセプト案(プレビューのb=月次集計)
  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-receipt"])) {
    const performanceStartedAt = Date.now();
    const stageTimings = [];
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const patientId = url.searchParams.get("patientId") || "";
    const sessionList = await measureStage(stageTimings, "listSessionsForMonthlyView", () => (
      listSessionsForMonthlyView(feeStore, context.session.orgId, claimMonth, {
        processEnv: input.processEnv || process.env,
        patientId
      })
    ));
    const constraints = await measureStage(stageTimings, "monthlyCandidateConstraints", () => (
      monthlyCandidateConstraints(feeCalculator, sessionList, { patientId, claimMonth })
    ));
    const receiptDraft = await measureStage(stageTimings, "buildMonthlyReceiptDraft", () => (
      buildMonthlyReceiptDraft(sessionList, { patientId, claimMonth, ...constraints })
    ));
    const monthlyMetrics = buildEndpointStageMetrics(stageTimings, performanceStartedAt, {
      sessionCount: sessionList.length
    });
    logFeeEndpointPerformance("fee.monthly_receipt.performance", {
      orgId: context.session.orgId,
      claimMonth,
      metrics: monthlyMetrics
    });
    return ok({
      receiptDraft,
      monthlyMetrics
    });
  }

  if (method === "GET" && matches(parts, ["v1", "fee", "monthly-bulk-candidates"])) {
    const claimMonth = url.searchParams.get("claimMonth") || "";
    const sessionList = await listSessionsForMonthlyView(feeStore, context.session.orgId, claimMonth, {
      processEnv: input.processEnv || process.env
    });
    return ok(buildMonthlyBulkCandidatePlan(sessionList, { claimMonth }));
  }

  if (method === "POST" && matches(parts, ["v1", "fee", "monthly-bulk-jobs"])) {
    requireMutationCsrf(input, context.session);
    const claimMonth = String(input.body?.claimMonth ?? input.body?.claim_month ?? "").trim();
    const sessionList = await listSessionsForMonthlyView(feeStore, context.session.orgId, claimMonth, {
      processEnv: input.processEnv || process.env
    });
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
      now: input.now || new Date(),
      processEnv: input.processEnv || process.env
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
      now: input.now || new Date(),
      processEnv: input.processEnv || process.env
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
      if (!isFeeSessionCalculationConflict(error)) {
        await markFeeCalculationFailed({
          context,
          feeStore,
          feeSessionId: parts[3],
          error,
          now: input.now || new Date()
        });
      }
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

async function requireSidecarContext(input, platformStore) {
  const authorization = headerValue(input.headers || {}, "authorization");
  if (!authorization.startsWith("Bearer ")) {
    const error = new Error("Sidecar bearer token is required");
    error.name = "UnauthorizedError";
    error.statusCode = 401;
    throw error;
  }
  const context = await requireProductContext(input, {
    platformStore,
    productId: SIDECAR_PRODUCT_ID,
    productLabel: "HOMIS Sidecar",
    allowedProductRoles: SIDECAR_PRODUCT_ROLES,
    requireScopedToken: true,
    tokenType: "scoped_product_access",
    audience: "fee-api",
    requiredScope: SIDECAR_TOKEN_SCOPE
  });
  if (!sidecarAllowedExtensionIds(input).includes(String(context.session.extensionId || ""))) {
    throw forbiddenError("Sidecar extension is not allowed");
  }
  if (sidecarRevokedDeviceIds(input).includes(String(context.session.deviceId || ""))) {
    throw forbiddenError("Sidecar device is revoked");
  }
  const verifier = headerValue(input.headers || {}, "x-sidecar-code-verifier");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw forbiddenError("Sidecar proof key is required");
  }
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  if (!safeStringEqual(challenge, context.session.proofKeyChallenge)) {
    throw forbiddenError("Sidecar proof key mismatch");
  }
  const origin = headerValue(input.headers || {}, "origin");
  const expectedOrigin = `chrome-extension://${context.session.extensionId || ""}`;
  if (origin && origin !== expectedOrigin) {
    throw forbiddenError("Sidecar extension origin mismatch");
  }
  if (!origin && !isTestEnvironment(input.env)) {
    throw forbiddenError("Sidecar extension origin is required");
  }
  return context;
}

async function consumeSidecarCalculationRateLimit(input, platformStore, context) {
  if (typeof platformStore.consumeRateLimit !== "function") {
    return;
  }
  await platformStore.consumeRateLimit(
    `sidecar-calculate:${context.session.orgId}:${context.session.memberId}:${context.session.deviceId || "unknown"}`,
    {
      limit: Number(input.sidecarRateLimit?.limit || 20),
      windowSeconds: Number(input.sidecarRateLimit?.windowSeconds || 60)
    }
  );
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sidecarSourceIdentity(orgId, input = {}) {
  const keyMaterial = [
    orgId,
    input.facilityId,
    input.sourceSystem,
    input.externalPatientId,
    input.sourceRecordId
  ].map((value) => String(value || "").trim()).join("\u001f");
  const idempotencyKeyHash = crypto.createHash("sha256").update(keyMaterial).digest("hex");
  const patientHash = crypto.createHash("sha256")
    .update([orgId, input.facilityId, input.sourceSystem, input.externalPatientId].join("\u001f"))
    .digest("hex");
  return {
    idempotencyKeyHash,
    sidecarDraftId: `sidecar_${idempotencyKeyHash.slice(0, 26)}`,
    sidecarPatientKey: `sidecar_patient_${patientHash.slice(0, 26)}`
  };
}

function sidecarSourceRevisionHash(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    contractVersion: input.contractVersion || SIDECAR_CONTRACT_VERSION,
    serviceDate: input.serviceDate,
    receptionTime: input.receptionTime || null,
    setting: input.setting,
    encounterTypeSource: input.encounterTypeSource,
    sameBuilding: input.sameBuilding ?? null,
    sameBuildingSource: input.sameBuildingSource || null,
    singleBuildingPatientCount: input.singleBuildingPatientCount ?? null,
    clinicalText: input.clinicalText,
    orders: input.orders || [],
    diagnoses: input.diagnoses || []
  })).digest("hex");
}

function assertFreshSidecarExtraction(proof = {}, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput || Date.now());
  const extractedAt = Date.parse(proof.extractedAt || "");
  const maxAgeMs = 15 * 60 * 1000;
  if (!Number.isFinite(extractedAt) || extractedAt > now.getTime() + 60_000 || now.getTime() - extractedAt > maxAgeMs) {
    throw requestValidationError("extractionProof is stale; extract the displayed chart again");
  }
}

function sidecarDraftExpiry(now, env = process.env) {
  const days = sidecarDraftRetentionDays(env);
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function sidecarDraftRetentionDays(env = process.env) {
  const raw = String(env.HOMIS_SIDECAR_DRAFT_RETENTION_DAYS || "30").trim();
  if (!/^\d+$/.test(raw)) {
    throw sidecarConfigurationError("HOMIS_SIDECAR_DRAFT_RETENTION_DAYS must be an integer from 1 to 90");
  }
  const days = Number.parseInt(raw, 10);
  if (days < 1 || days > 90) {
    throw sidecarConfigurationError("HOMIS_SIDECAR_DRAFT_RETENTION_DAYS must be an integer from 1 to 90");
  }
  return days;
}

function sidecarConfigurationError(message) {
  const error = new Error(message);
  error.name = "ConfigurationError";
  error.statusCode = 500;
  return error;
}

function sidecarDraftCalculationStore(feeStore) {
  return {
    getFeeSettings: (...args) => feeStore.getFeeSettings(...args),
    updateSession: (orgId, sidecarDraftId, patch) => (
      feeStore.updateSidecarCalculationDraft(orgId, sidecarDraftId, patch)
    ),
    saveCalculation: (orgId, sidecarDraftId, calculationResult) => (
      feeStore.saveSidecarCalculation(orgId, sidecarDraftId, calculationResult)
    ),
    listPriorSessionsForPatient: (orgId, patientId, options) => (
      feeStore.listPriorSidecarDraftsForPatient(orgId, patientId, options)
    )
  };
}

function sidecarCalculationResponse(sidecarDraft = {}) {
  const calculation = sidecarDraft.calculationResult || {};
  const lineCandidates = (Array.isArray(calculation.lineItems) ? calculation.lineItems : []).map((line) => ({
    candidateId: line.lineId || line.code || null,
    sourceType: "calculated_line",
    code: line.code || null,
    name: line.name || null,
    orderType: line.orderType || null,
    points: Number(line.points || 0),
    quantity: Number(line.quantity || 1),
    estimatedTotalPoints: Number(line.totalPoints || 0),
    status: "needs_review",
    candidateOnly: true
  }));
  const proposalCandidates = (Array.isArray(calculation.candidateProposals) ? calculation.candidateProposals : []).map((proposal) => {
    const codeCandidates = [...new Set((Array.isArray(proposal.codeCandidates) ? proposal.codeCandidates : [])
      .map((code) => String(code || "").trim())
      .filter(Boolean))];
    return {
      candidateId: proposal.proposalId || proposal.candidateId || proposal.code || null,
      sourceType: "proposal",
      code: proposal.code || null,
      codeCandidates,
      requiresSelection: !proposal.code && codeCandidates.length > 0,
      name: proposal.name || proposal.title || null,
      orderType: proposal.orderType || null,
      points: Number(proposal.points || proposal.potentialPoints || 0),
      quantity: Number(proposal.quantity || 1),
      estimatedTotalPoints: Number(proposal.totalPoints || proposal.potentialPoints || proposal.points || 0),
      status: "needs_review",
      candidateOnly: true
    };
  });
  return {
    contractVersion: SIDECAR_CONTRACT_VERSION,
    sidecarDraft: {
      ...sidecarDraftSummaryView(sidecarDraft),
      serviceDate: sidecarDraft.serviceDate || null,
      setting: sidecarDraft.setting || null,
      encounterTypeSource: sidecarDraft.encounterTypeSource || null,
      encounterDetails: sidecarDraft.encounterDetails || null,
      sourceRecordDisplayId: sidecarDraft.sourceRecordDisplayId || null,
      sourceRevision: Number(sidecarDraft.sourceRevision || 1),
      calculation: {
        status: "needs_review",
        candidateOnly: true,
        estimatedTotalPoints: Number(calculation.totalPoints || 0),
        candidates: uniqueSidecarCandidates([...lineCandidates, ...proposalCandidates]),
        warnings: Array.isArray(calculation.warnings) ? calculation.warnings : [],
        reviewIssues: Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : []
      }
    }
  };
}

function uniqueSidecarCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = [candidate.sourceType, candidate.candidateId, candidate.code, candidate.name].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sidecarDraftSummaryView(sidecarDraft = {}) {
  return {
    sidecarDraftId: sidecarDraft.sidecarDraftId,
    lifecycleStatus: sidecarDraft.lifecycleStatus,
    candidateOnly: true,
    externalSourceSystem: sidecarDraft.externalSourceSystem,
    externalPatientId: sidecarDraft.externalPatientId,
    sourceRecordId: sidecarDraft.sourceRecordId,
    sourceRevision: Number(sidecarDraft.sourceRevision || 1),
    adoptedFeeSessionId: sidecarDraft.adoptedFeeSessionId || null,
    createdAt: sidecarDraft.createdAt || null,
    updatedAt: sidecarDraft.updatedAt || null,
    expiresAt: sidecarDraft.expiresAt || null
  };
}

function sidecarDraftListItemView(sidecarDraft = {}) {
  const calculation = sidecarCalculationResponse(sidecarDraft).sidecarDraft.calculation;
  return {
    ...sidecarDraftSummaryView(sidecarDraft),
    facilityId: sidecarDraft.facilityId || null,
    serviceDate: sidecarDraft.serviceDate || null,
    setting: sidecarDraft.setting || null,
    encounterTypeSource: sidecarDraft.encounterTypeSource || null,
    encounterDetails: sidecarDraft.encounterDetails || null,
    sourceRecordDisplayId: sidecarDraft.sourceRecordDisplayId || null,
    calculation: {
      status: calculation.status,
      candidateOnly: true,
      estimatedTotalPoints: calculation.estimatedTotalPoints,
      candidateCount: calculation.candidates.length,
      warningCount: calculation.warnings.length,
      reviewIssueCount: calculation.reviewIssues.length
    }
  };
}

function sidecarDraftDetailView(sidecarDraft = {}) {
  return {
    ...sidecarDraftSummaryView(sidecarDraft),
    facilityId: sidecarDraft.facilityId || null,
    departmentId: sidecarDraft.departmentId || null,
    serviceDate: sidecarDraft.serviceDate || null,
    setting: sidecarDraft.setting || null,
    receptionTime: sidecarDraft.receptionTime || null,
    encounterTypeSource: sidecarDraft.encounterTypeSource || null,
    encounterDetails: sidecarDraft.encounterDetails || null,
    clinicalText: sidecarDraft.clinicalText || "",
    orders: Array.isArray(sidecarDraft.orders) ? sidecarDraft.orders : [],
    diagnoses: Array.isArray(sidecarDraft.diagnoses) ? sidecarDraft.diagnoses : [],
    calculation: sidecarCalculationResponse(sidecarDraft).sidecarDraft.calculation
  };
}

function isSidecarDraftDocument(parts = []) {
  return parts.length === 4 && matches(parts.slice(0, 3), ["v1", "fee", "sidecar-drafts"]);
}

function isSidecarDraftAdoptionRoute(parts = []) {
  return parts.length === 5
    && matches(parts.slice(0, 3), ["v1", "fee", "sidecar-drafts"])
    && parts[4] === "adopt";
}

function requireSidecarFeature(input = {}) {
  if (sidecarFeatureEnabled(input)) {
    return;
  }
  const error = new Error("Route not found");
  error.name = "NotFoundError";
  error.statusCode = 404;
  throw error;
}

function sidecarFeatureEnabled(input = {}) {
  if (typeof input.sidecarEnabled === "boolean") {
    return input.sidecarEnabled;
  }
  const configured = input.processEnv?.HOMIS_SIDECAR_ENABLED
    ?? process.env.HOMIS_SIDECAR_ENABLED;
  return String(configured || "").trim().toLowerCase() === "true";
}

function sidecarAllowedExtensionIds(input = {}) {
  const configured = input.sidecarAllowedExtensionIds
    || input.processEnv?.HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS
    || process.env.HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS
    || "";
  return (Array.isArray(configured) ? configured : String(configured).split(/[;,\s]+/))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function sidecarAllowedSelectorContractVersions(input = {}) {
  const configured = input.sidecarAllowedSelectorContractVersions
    || input.processEnv?.HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS
    || process.env.HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS
    || "";
  return (Array.isArray(configured) ? configured : String(configured).split(/[;,\s]+/))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function requireAllowedSidecarSelectorContract(input, selectorContractVersion) {
  if (!sidecarAllowedSelectorContractVersions(input).includes(String(selectorContractVersion || ""))) {
    throw requestValidationError("selector contract version is not supported");
  }
}

function sidecarPatientMatch(patient = {}, sidecarDraft = {}) {
  const externalPatientId = String(sidecarDraft.externalPatientId || "").trim();
  const facilityId = String(sidecarDraft.facilityId || "").trim();
  const sourceSystem = String(sidecarDraft.externalSourceSystem || "homis").trim();
  const structuredMatch = (Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : []).some((identifier) => (
    String(identifier?.sourceSystem || "").trim() === sourceSystem
    && String(identifier?.facilityId || "").trim() === facilityId
    && String(identifier?.patientNumber || identifier?.value || "").trim() === externalPatientId
    && String(identifier?.status || "active") === "active"
  ));
  if (structuredMatch) {
    return { matched: true, basis: "patient_identifier" };
  }
  return { matched: false, basis: "none" };
}

function sidecarRevokedDeviceIds(input = {}) {
  const configured = input.sidecarRevokedDeviceIds
    || input.processEnv?.HOMIS_SIDECAR_REVOKED_DEVICE_IDS
    || process.env.HOMIS_SIDECAR_REVOKED_DEVICE_IDS
    || "";
  return (Array.isArray(configured) ? configured : String(configured).split(/[;,\s]+/))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function assertFeeSidecarRuntimeConfiguration(input = {}) {
  if (input.sidecarEnabled !== true && String(input.processEnv?.HOMIS_SIDECAR_ENABLED || "").toLowerCase() !== "true") {
    return;
  }
  const env = String(input.env || "local").toLowerCase();
  if (["local", "test", "development"].includes(env)) {
    return;
  }
  if (!sidecarAllowedExtensionIds(input).length) {
    throw new Error("HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS is required when HOMIS Sidecar is enabled");
  }
  if (sidecarAllowedExtensionIds(input).some((extensionId) => !/^[a-p]{32}$/.test(extensionId))) {
    throw new Error("HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS contains an invalid Chrome extension ID");
  }
  if (!sidecarAllowedSelectorContractVersions(input).length) {
    throw new Error("HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS is required when HOMIS Sidecar is enabled");
  }
  if (sidecarAllowedSelectorContractVersions(input).some((version) => !/^[A-Za-z0-9._-]{1,128}$/.test(version))) {
    throw new Error("HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS contains an invalid version");
  }
  sidecarDraftRetentionDays(input.processEnv || process.env);
}

function requireFeeWriteAccess(context) {
  const allowed = hasProductAccess(context.session, PRODUCT_ID, FEE_WRITE_ROLES);
  if (!allowed) {
    throw forbiddenError("Fee write access is required");
  }
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

async function validateMeisaishoHakkoFacilitySettings({
  platformStore,
  orgId,
  facilityId,
  settings = {}
} = {}) {
  const hasActiveStandard = (Array.isArray(settings.facilityStandards) ? settings.facilityStandards : [])
    .some((entry) => entry?.key === MEISAISHO_HAKKO_STANDARD_KEY && entry?.status === "active");
  if (!hasActiveStandard) {
    return { facilityTypeStatus: "not_applicable", warnings: [] };
  }

  const facility = typeof platformStore?.getFacility === "function"
    ? await platformStore.getFacility(orgId, facilityId)
    : null;
  if (!facility) {
    throw requestValidationError(
      "明細書発行体制等加算は実在する施設単位で設定してください。共通設定には登録できません。"
    );
  }
  const rawFacilityType = String(facility?.facilityType || facility?.facility_type || "").trim();
  const facilityType = normalizeFacilityType(rawFacilityType);

  if (isHospitalFacilityType(facilityType)) {
    throw requestValidationError(
      "明細書発行体制等加算は診療所のみ設定できます。施設種別が病院のため登録できません。"
    );
  }
  if (MEISAISHO_HAKKO_CLINIC_FACILITY_TYPES.has(facilityType)) {
    return { facilityTypeStatus: "clinic_confirmed", warnings: [] };
  }

  return {
    facilityTypeStatus: rawFacilityType ? "unrecognized" : "missing",
    warnings: [{
      code: "meisaisho_hakko_facility_type_unconfirmed",
      field: "facilityType",
      message: rawFacilityType
        ? "明細書発行体制等加算を設定しました。施設種別を診療所として確認できないため、登録内容を確認してください。"
        : "明細書発行体制等加算を設定しました。施設種別が未設定のため、診療所であることを確認してください。"
    }]
  };
}

function normalizeFacilityType(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

function isHospitalFacilityType(facilityType) {
  return facilityType === "hospital"
    || facilityType.startsWith("hospital_")
    || facilityType.endsWith("_hospital")
    || facilityType.includes("病院");
}

async function baselineClaimsFromDiagnosisBody({ body = {}, claimMonth = "", feeCalculator, processEnv = process.env } = {}) {
  let baselineClaims = Array.isArray(body.baselineClaims ?? body.baseline_claims) ? (body.baselineClaims ?? body.baseline_claims) : [];
  const baselineText = String(body.baselineText ?? body.baseline_text ?? "");
  const baselineContentBase64 = String(body.baselineContentBase64 ?? body.baseline_content_base64 ?? "").trim();
  const baselineContentProvided = Boolean(baselineText || baselineContentBase64);
  const baselineFormat = String(body.baselineFormat ?? body.baseline_format ?? "").trim().toLowerCase();
  if (baselineContentProvided && !["uke", "csv"].includes(baselineFormat)) {
    throw requestValidationError("baselineFormat must be csv or uke when baseline content is provided");
  }
  if (baselineContentProvided && (baselineFormat === "uke" || baselineFormat === "csv")) {
    if (typeof feeCalculator.parseBaseline !== "function") {
      const error = new Error("既存レセ取込(Python adapter)が利用できません。");
      error.name = "NotImplementedError";
      error.statusCode = 501;
      throw error;
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
    limit: baselineDiagnosisClaimLimit(processEnv)
  });
  if (baselineContentProvided && baselineClaims.length === 0) {
    throw requestValidationError("既存レセを取り込めませんでした。CSV列マッピング、請求月、文字コードを確認してください。");
  }
  return { baselineClaims, baselineFormat, baselineContentProvided };
}

function parseRecalculationDiffDatasetFromBody(body = {}) {
  const dataset = {
    manifest: {},
    sources: {},
    warnings: []
  };
  const datasetContentBase64 = String(body.datasetContentBase64 ?? body.dataset_content_base64 ?? "").trim();
  if (datasetContentBase64) {
    const datasetFileName = String(body.datasetFileName ?? body.dataset_file_name ?? "").trim();
    const datasetFormat = String(body.datasetFormat ?? body.dataset_format ?? inferUploadFormat(datasetFileName) ?? "json").trim().toLowerCase();
    if (datasetFormat === "zip" || /\.zip$/iu.test(datasetFileName)) {
      mergeZipDatasetSources(dataset, datasetContentBase64, datasetFileName);
    } else {
      mergeUploadedDatasetFile(dataset, {
        fileName: datasetFileName || "dataset.json",
        format: datasetFormat,
        contentBase64: datasetContentBase64,
        encoding: body.datasetEncoding ?? body.dataset_encoding
      });
    }
  }
  const datasetFiles = Array.isArray(body.datasetFiles ?? body.dataset_files)
    ? (body.datasetFiles ?? body.dataset_files)
    : [];
  for (const file of datasetFiles) {
    mergeUploadedDatasetFile(dataset, file);
  }

  addBodyTextSource(dataset, body, "patients", ["patients", "patient"]);
  addBodyTextSource(dataset, body, "charts", ["charts", "chart", "clinicalTexts", "clinical_texts"]);
  addBodyTextSource(dataset, body, "orders", ["orders", "order"]);
  addBodyTextSource(dataset, body, "diagnoses", ["diagnoses", "diagnosis"]);
  addBodyTextSource(dataset, body, "facility", ["facility", "facilitySettings", "facility_settings"]);
  addBodyTextSource(dataset, body, "calculationPayloads", ["calculationPayloads", "calculation_payloads", "claimPayloads", "claim_payloads", "payloads"]);
  return dataset;
}

function mergeRecalculationDiffDatasetIntoBody(body = {}, dataset = {}) {
  const next = { ...body };
  const baselineSource = firstDatasetSource(dataset, "baselineReceipt");
  if (
    baselineSource
    && !(next.baselineText || next.baseline_text || next.baselineContentBase64 || next.baseline_content_base64)
    && !Array.isArray(next.baselineClaims ?? next.baseline_claims)
  ) {
    if (String(baselineSource.format || "").toLowerCase() === "json") {
      next.baselineClaims = recordsFromTextSource(baselineSource, "baselineClaims");
    } else {
      next.baselineText = baselineSource.text;
      next.baselineFormat = inferBaselineUploadFormat(baselineSource.name || baselineSource.format || "") || "csv";
      next.baselineEncoding = "utf-8";
    }
  }
  const payloadSource = firstDatasetSource(dataset, "calculationPayloads");
  if (
    payloadSource
    && !(next.calculationPayloadText || next.calculation_payload_text || next.calculationPayloadContentBase64 || next.calculation_payload_content_base64)
    && !Array.isArray(next.calculationPayloads ?? next.calculation_payloads)
    && !Array.isArray(next.claimPayloads ?? next.claim_payloads)
  ) {
    next.calculationPayloadText = payloadSource.text;
  }
  if (!next.claimMonth && !next.claim_month && dataset.manifest?.claimMonth) {
    next.claimMonth = dataset.manifest.claimMonth;
  }
  return next;
}

function resolveRecalculationDiffClaimMonth(body = {}, dataset = {}) {
  const candidates = [
    stringValue(dataset.manifest || {}, ["claimMonth", "claim_month", "請求月"]),
    deriveClaimMonthFromDataset(dataset),
    String(body.claimMonth ?? body.claim_month ?? "").trim()
  ].filter(Boolean);
  return candidates[0] || "";
}

function deriveClaimMonthFromDataset(dataset = {}) {
  const baselineSources = Array.isArray(dataset.sources?.baselineReceipt) ? dataset.sources.baselineReceipt : [];
  for (const source of baselineSources) {
    const records = recordsFromTextSource(source, "baselineClaims");
    for (const record of records) {
      const month = stringValue(record, ["claim_month", "claimMonth", "請求月"]);
      if (/^\d{4}-\d{2}$/u.test(month)) {
        return month;
      }
      const serviceDate = dateValue(record, ["service_date", "serviceDate", "診療日", "受診日"]);
      if (/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)) {
        return serviceDate.slice(0, 7);
      }
    }
  }
  for (const role of ["orders", "charts", "diagnoses", "calculationPayloads"]) {
    for (const record of datasetRecords(dataset, role)) {
      const month = stringValue(record, ["claim_month", "claimMonth", "請求月"]);
      if (/^\d{4}-\d{2}$/u.test(month)) {
        return month;
      }
      const serviceDate = dateValue(record, ["service_date", "serviceDate", "date", "encounter_date", "診療日", "受診日"]);
      if (/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)) {
        return serviceDate.slice(0, 7);
      }
    }
  }
  return "";
}

function buildCalculationPayloadsFromRecalculationDiffDataset(dataset = {}, { claimMonth = "" } = {}) {
  const patientRecords = datasetRecords(dataset, "patients");
  const chartRecords = datasetRecords(dataset, "charts");
  const orderRecords = datasetRecords(dataset, "orders");
  const diagnosisRecords = datasetRecords(dataset, "diagnoses");
  const facility = datasetFacility(dataset);
  const patientMap = new Map();
  for (const record of patientRecords) {
    const normalized = normalizeDatasetPatient(record);
    if (normalized.patientId) {
      patientMap.set(normalized.patientId, normalized);
    }
  }

  const groups = new Map();
  const warnings = [...(Array.isArray(dataset.warnings) ? dataset.warnings : [])];
  const ensureGroup = (patientId, serviceDate) => {
    const key = `${patientId}\u0000${serviceDate}`;
    const group = groups.get(key) || {
      patientId,
      serviceDate,
      charts: [],
      orders: [],
      diagnoses: [],
      medicalInstitutionCode: "",
      regionalBureau: "",
      isOutpatient: true
    };
    groups.set(key, group);
    return group;
  };

  for (const record of chartRecords) {
    const normalized = normalizeDatasetChart(record);
    if (!normalized.patientId || !normalized.serviceDate) {
      warnings.push("カルテファイルに患者IDまたは診療日がない行があります。");
      continue;
    }
    if (claimMonth && normalized.serviceDate.slice(0, 7) !== claimMonth) {
      continue;
    }
    const group = ensureGroup(normalized.patientId, normalized.serviceDate);
    group.charts.push(normalized);
    group.medicalInstitutionCode ||= normalized.medicalInstitutionCode;
    group.regionalBureau ||= normalized.regionalBureau;
  }

  for (const record of orderRecords) {
    const normalized = normalizeDatasetOrder(record);
    if (!normalized.patientId || !normalized.serviceDate) {
      warnings.push("オーダーファイルに患者IDまたは診療日がない行があります。");
      continue;
    }
    if (claimMonth && normalized.serviceDate.slice(0, 7) !== claimMonth) {
      continue;
    }
    const group = ensureGroup(normalized.patientId, normalized.serviceDate);
    group.orders.push(normalized);
    group.medicalInstitutionCode ||= normalized.medicalInstitutionCode;
    group.regionalBureau ||= normalized.regionalBureau;
  }

  for (const record of diagnosisRecords) {
    const normalized = normalizeDatasetDiagnosis(record);
    if (!normalized.patientId || !normalized.serviceDate) {
      warnings.push("病名ファイルに患者IDまたは診療日がない行があります。");
      continue;
    }
    if (claimMonth && normalized.serviceDate.slice(0, 7) !== claimMonth) {
      continue;
    }
    const group = ensureGroup(normalized.patientId, normalized.serviceDate);
    group.diagnoses.push(normalized);
  }

  const payloads = [];
  for (const group of groups.values()) {
    const patient = patientMap.get(group.patientId) || {};
    const claimContext = claimContextFromDatasetGroup(group, {
      patient,
      facility,
      manifest: dataset.manifest || {}
    });
    if (!hasBillableClaimContextInput(claimContext)) {
      warnings.push(`患者 ${group.patientId} / ${group.serviceDate} は算定可能な構造化オーダーがないため再算定対象から除外しました。`);
      continue;
    }
    payloads.push(claimContext);
  }

  return {
    payloads,
    warnings: uniqueStrings(warnings),
    stats: {
      patientRecordCount: patientRecords.length,
      chartRecordCount: chartRecords.length,
      orderRecordCount: orderRecords.length,
      diagnosisRecordCount: diagnosisRecords.length,
      generatedPayloadCount: payloads.length
    }
  };
}

function recalculationDiffIngestionSummary({ baseline = {}, calculationPayloads = [], dataset = {}, generatedPayloads = {} } = {}) {
  const sourceCounts = {};
  for (const [role, sources] of Object.entries(dataset.sources || {})) {
    sourceCounts[role] = Array.isArray(sources) ? sources.length : 0;
  }
  const warnings = uniqueStrings([
    ...(Array.isArray(dataset.warnings) ? dataset.warnings : []),
    ...(Array.isArray(generatedPayloads.warnings) ? generatedPayloads.warnings : [])
  ]);
  return {
    baselineClaimCount: Array.isArray(baseline.baselineClaims) ? baseline.baselineClaims.length : 0,
    calculationPayloadCount: Array.isArray(calculationPayloads) ? calculationPayloads.length : 0,
    warningCount: warnings.length,
    warnings: warnings.slice(0, 20),
    sourceCounts,
    stats: generatedPayloads.stats || {}
  };
}

function mergeZipDatasetSources(dataset, contentBase64, fileName = "") {
  const entries = unzipTextEntries(Buffer.from(contentBase64, "base64"));
  const manifestEntry = entries.find((entry) => /(?:^|\/)manifest\.json$/iu.test(entry.path));
  if (manifestEntry) {
    try {
      dataset.manifest = { ...dataset.manifest, ...JSON.parse(manifestEntry.text) };
    } catch {
      dataset.warnings.push("manifest.jsonを読み込めませんでした。");
    }
  } else if (fileName) {
    dataset.manifest.datasetFileName = fileName;
  }
  for (const role of RECALCULATION_DATASET_ROLES) {
    const source = zipEntryForDatasetRole(entries, role, dataset.manifest);
    if (source) {
      addDatasetSource(dataset, role.role, source);
    }
  }
}

function mergeUploadedDatasetFile(dataset, file = {}) {
  if (!isPlainObject(file)) {
    return;
  }
  const fileName = String(file.fileName ?? file.file_name ?? file.name ?? "").trim();
  const format = String(file.format ?? inferUploadFormat(fileName) ?? "").trim().toLowerCase();
  const contentBase64 = String(file.contentBase64 ?? file.content_base64 ?? "").trim();
  if (format === "zip" || /\.zip$/iu.test(fileName)) {
    if (contentBase64) {
      mergeZipDatasetSources(dataset, contentBase64, fileName);
    }
    return;
  }
  const text = contentBase64
    ? decodeUploadedTextBase64(contentBase64, file.encoding)
    : String(file.text ?? "");
  if (!text && !contentBase64) {
    return;
  }
  const role = datasetRoleForFileName(fileName);
  if (role) {
    addDatasetSource(dataset, role, {
      name: fileName || `${role}.${format || "json"}`,
      format: format || inferUploadFormat(fileName) || "json",
      text
    });
    return;
  }
  if (format === "json" || /\.json$/iu.test(fileName)) {
    mergeJsonDatasetSources(dataset, text, fileName);
    return;
  }
  addDatasetSource(dataset, "calculationPayloads", {
    name: fileName || `dataset.${format || "txt"}`,
    format: format || "txt",
    text
  });
}

function mergeJsonDatasetSources(dataset, text = "", fileName = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    addDatasetSource(dataset, "calculationPayloads", { name: fileName || "dataset.jsonl", format: "jsonl", text: trimmed });
    return;
  }
  if (Array.isArray(parsed)) {
    addDatasetSource(dataset, "calculationPayloads", { name: fileName || "payloads.json", format: "json", text: JSON.stringify(parsed) });
    return;
  }
  if (!isPlainObject(parsed)) {
    return;
  }
  const manifest = isPlainObject(parsed.manifest) ? parsed.manifest : parsed;
  dataset.manifest = { ...dataset.manifest, ...manifest };
  for (const role of RECALCULATION_DATASET_ROLES) {
    const value = valueByAliases(parsed, role.bundleAliases || [role.role]);
    if (value === undefined || value === null) {
      continue;
    }
    addDatasetSource(dataset, role.role, {
      name: `${role.role}.json`,
      format: "json",
      text: JSON.stringify(value)
    });
  }
}

const RECALCULATION_DATASET_ROLES = [
  {
    role: "baselineReceipt",
    manifestAliases: ["baselineReceipt", "receipt", "existingReceipt", "baseline", "receipts"],
    bundleAliases: ["baselineClaims", "baseline_claims"],
    patterns: [/receipt\.(?:csv|uke|txt)$/iu, /receipts?\.(?:csv|uke|txt)$/iu, /baseline.*\.(?:csv|uke|txt)$/iu, /レセ/u]
  },
  {
    role: "patients",
    manifestAliases: ["patients", "patient"],
    bundleAliases: ["patients", "patientRecords", "patient_records"],
    patterns: [/patients?\.(?:csv|jsonl?|ndjson|tsv)$/iu, /患者/u]
  },
  {
    role: "charts",
    manifestAliases: ["charts", "chart", "chartNotes", "clinicalTexts", "clinical_texts"],
    bundleAliases: ["charts", "chartNotes", "chart_notes", "clinicalTexts", "clinical_texts"],
    patterns: [/charts?\.(?:csv|jsonl?|ndjson|tsv)$/iu, /chart[_-]?notes?\.(?:csv|jsonl?|ndjson|tsv)$/iu, /clinical.*\.(?:csv|jsonl?|ndjson|tsv)$/iu, /カルテ/u]
  },
  {
    role: "orders",
    manifestAliases: ["orders", "order"],
    bundleAliases: ["orders", "orderRecords", "order_records"],
    patterns: [/orders?\.(?:csv|jsonl?|ndjson|tsv)$/iu, /オーダ/u]
  },
  {
    role: "diagnoses",
    manifestAliases: ["diagnoses", "diagnosis", "diseases"],
    bundleAliases: ["diagnoses", "diagnosisRecords", "diagnosis_records", "diseases"],
    patterns: [/diagnos(?:is|es)\.(?:csv|jsonl?|ndjson|tsv)$/iu, /diseases?\.(?:csv|jsonl?|ndjson|tsv)$/iu, /病名/u]
  },
  {
    role: "facility",
    manifestAliases: ["facility", "facilitySettings", "facility_settings"],
    bundleAliases: ["facility", "facilitySettings", "facility_settings"],
    patterns: [/facility.*\.(?:json|csv|tsv)$/iu, /施設/u]
  },
  {
    role: "calculationPayloads",
    manifestAliases: ["calculationPayloads", "calculation_payloads", "claimPayloads", "claim_payloads", "payloads", "recalculation"],
    bundleAliases: ["calculationPayloads", "calculation_payloads", "claimPayloads", "claim_payloads", "payloads", "records"],
    patterns: [/(?:claim|calculation|recalculation).*payloads?\.(?:jsonl?|ndjson)$/iu, /recalculation\.(?:jsonl?|ndjson)$/iu, /再算定/u]
  }
];

function addBodyTextSource(dataset, body, role, aliases = []) {
  for (const alias of aliases) {
    const camel = alias.charAt(0).toLowerCase() + alias.slice(1);
    const snake = camel.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
    const contentBase64 = String(body[`${camel}ContentBase64`] ?? body[`${snake}_content_base64`] ?? "").trim();
    const text = String(body[`${camel}Text`] ?? body[`${snake}_text`] ?? "");
    if (!contentBase64 && !text) {
      continue;
    }
    const name = String(body[`${camel}FileName`] ?? body[`${snake}_file_name`] ?? `${role}.json`).trim();
    const format = String(body[`${camel}Format`] ?? body[`${snake}_format`] ?? inferUploadFormat(name) ?? "json").trim().toLowerCase();
    addDatasetSource(dataset, role, {
      name,
      format,
      text: contentBase64 ? decodeUploadedTextBase64(contentBase64, body[`${camel}Encoding`] ?? body[`${snake}_encoding`]) : text
    });
    return;
  }
}

function addDatasetSource(dataset, role, source = {}) {
  if (!source || !String(source.text || "").trim()) {
    return;
  }
  const normalizedRole = String(role || "").trim();
  if (!normalizedRole) {
    return;
  }
  const sources = Array.isArray(dataset.sources?.[normalizedRole]) ? dataset.sources[normalizedRole] : [];
  sources.push({
    name: String(source.name || `${normalizedRole}.json`).trim(),
    format: String(source.format || inferUploadFormat(source.name || "") || "json").trim().toLowerCase(),
    text: String(source.text || "")
  });
  dataset.sources[normalizedRole] = sources;
}

function firstDatasetSource(dataset = {}, role = "") {
  const sources = dataset.sources?.[role];
  return Array.isArray(sources) && sources.length ? sources[0] : null;
}

function datasetRecords(dataset = {}, role = "") {
  const sources = Array.isArray(dataset.sources?.[role]) ? dataset.sources[role] : [];
  return sources.flatMap((source) => recordsFromTextSource(source, role));
}

function recordsFromTextSource(source = {}, role = "") {
  const text = String(source.text || "").trim();
  if (!text) {
    return [];
  }
  const format = String(source.format || inferUploadFormat(source.name || "") || "").toLowerCase();
  if (format === "csv" || format === "tsv" || (/^[^\n]+\n/u.test(text) && !/^\s*[\[{]/u.test(text))) {
    return parseDelimitedRecords(text, format === "tsv" || /\.tsv$/iu.test(source.name || "") ? "\t" : null);
  }
  try {
    if (format === "jsonl" || format === "ndjson") {
      return parseJsonLineRecords(text);
    }
    if (text.startsWith("[") || text.startsWith("{")) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter(isPlainObject);
      }
      if (isPlainObject(parsed)) {
        const direct = valueByAliases(parsed, [role, "records", "items", "rows"]);
        if (Array.isArray(direct)) {
          return direct.filter(isPlainObject);
        }
        return [parsed];
      }
      return [];
    }
    return parseJsonLineRecords(text);
  } catch {
    return [];
  }
}

function parseJsonLineRecords(text = "") {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(isPlainObject);
}

function datasetFacility(dataset = {}) {
  const source = firstDatasetSource(dataset, "facility");
  let value = {};
  if (source) {
    const records = recordsFromTextSource(source, "facility");
    if (records.length === 1) {
      value = records[0];
    } else if (records.length > 1) {
      value = Object.fromEntries(records.map((record) => [
        stringValue(record, ["key", "name", "項目"]),
        stringValue(record, ["value", "値"])
      ]).filter(([key]) => key));
    }
  }
  return {
    medicalInstitutionCode: stringValue(value, ["medicalInstitutionCode", "medical_institution_code", "医療機関コード"]) || stringValue(dataset.manifest || {}, ["medicalInstitutionCode", "medical_institution_code"]),
    regionalBureau: stringValue(value, ["regionalBureau", "regional_bureau", "厚生局"]) || stringValue(dataset.manifest || {}, ["regionalBureau", "regional_bureau"]),
    facilityStandardKeys: uniqueStrings([
      ...listValue(valueByAliases(value, ["facilityStandardKeys", "facility_standard_keys", "施設基準"])),
      ...listValue(valueByAliases(dataset.manifest || {}, ["facilityStandardKeys", "facility_standard_keys"]))
    ])
  };
}

function claimContextFromDatasetGroup(group = {}, { patient = {}, facility = {}, manifest = {} } = {}) {
  const procedureCodes = [];
  const drugInputs = [];
  const medicationOrders = [];
  const injectionDrugInputs = [];
  const injectionOrders = [];
  const materialInputs = [];
  const treatmentOrders = [];
  const imagingOrders = [];
  const commentInputs = [];

  for (const order of group.orders || []) {
    if (!datasetOrderIsPerformed(order)) {
      continue;
    }
    const mapped = mapDatasetOrderToClaimInput(order);
    if (!mapped) {
      continue;
    }
    if (mapped.procedureCode) procedureCodes.push(mapped.procedureCode);
    if (mapped.drugInput) drugInputs.push(mapped.drugInput);
    if (mapped.medicationOrder) medicationOrders.push(mapped.medicationOrder);
    if (mapped.injectionDrugInput) injectionDrugInputs.push(mapped.injectionDrugInput);
    if (mapped.injectionOrder) injectionOrders.push(mapped.injectionOrder);
    if (mapped.materialInput) materialInputs.push(mapped.materialInput);
    if (mapped.treatmentOrder) treatmentOrders.push(mapped.treatmentOrder);
    if (mapped.imagingOrder) imagingOrders.push(mapped.imagingOrder);
    if (mapped.commentInput) commentInputs.push(mapped.commentInput);
  }

  const clinicalText = uniqueStrings((group.charts || []).map((chart) => chart.clinicalText).filter(Boolean)).join("\n\n");
  const diagnoses = (group.diagnoses || []).map((diagnosis) => ({
    name: diagnosis.name,
    icd10Code: diagnosis.icd10Code || "",
    isPrimary: diagnosis.isPrimary === true
  })).filter((diagnosis) => diagnosis.name);
  const payload = {
    record_id: `dataset_${group.patientId}_${group.serviceDate}`,
    patient: {
      patient_id: group.patientId,
      display_name: patient.displayName || group.patientId,
      birth_date: patient.birthDate || null,
      sex: patient.sex || null
    },
    encounter: {
      service_date: group.serviceDate,
      medical_institution_code: group.medicalInstitutionCode || facility.medicalInstitutionCode || stringValue(manifest, ["medicalInstitutionCode", "medical_institution_code"]) || null,
      regional_bureau: group.regionalBureau || facility.regionalBureau || stringValue(manifest, ["regionalBureau", "regional_bureau"]) || null,
      is_outpatient: group.isOutpatient !== false
    },
    procedure_codes: uniqueStrings(procedureCodes),
    drug_inputs: compactClaimInputArray(drugInputs),
    medication_orders: compactClaimInputArray(medicationOrders),
    injection_drug_inputs: compactClaimInputArray(injectionDrugInputs),
    injection_orders: compactClaimInputArray(injectionOrders),
    treatment_orders: compactClaimInputArray(treatmentOrders),
    imaging_orders: compactClaimInputArray(imagingOrders),
    material_inputs: compactClaimInputArray(materialInputs),
    comment_inputs: compactClaimInputArray(commentInputs),
    diagnoses,
    clinical_text: clinicalText
  };
  const facilityStandardKeys = uniqueStrings(facility.facilityStandardKeys || []);
  if (facilityStandardKeys.length) {
    payload.facility_standard_keys = facilityStandardKeys;
  }
  return payload;
}

function hasBillableClaimContextInput(payload = {}) {
  return [
    payload.procedure_codes,
    payload.drug_inputs,
    payload.medication_orders,
    payload.injection_drug_inputs,
    payload.injection_orders,
    payload.treatment_orders,
    payload.imaging_orders,
    payload.material_inputs
  ].some((value) => Array.isArray(value) && value.length > 0);
}

function normalizeDatasetPatient(record = {}) {
  return {
    patientId: stringValue(record, ["patient_id", "patientId", "patient", "patientCode", "患者ID", "患者番号"]),
    displayName: stringValue(record, ["display_name", "displayName", "name", "patient_name", "氏名", "患者名"]),
    birthDate: dateValue(record, ["birth_date", "birthDate", "生年月日"]),
    sex: normalizeSex(stringValue(record, ["sex", "gender", "性別"]))
  };
}

function normalizeDatasetChart(record = {}) {
  return {
    patientId: stringValue(record, ["patient_id", "patientId", "patient", "patientCode", "患者ID", "患者番号"]),
    serviceDate: dateValue(record, ["service_date", "serviceDate", "date", "encounter_date", "診療日", "受診日"]),
    clinicalText: stringValue(record, ["clinical_text", "clinicalText", "chart_text", "chartText", "note", "text", "カルテ", "カルテ本文", "診療録"]),
    medicalInstitutionCode: stringValue(record, ["medical_institution_code", "medicalInstitutionCode", "医療機関コード"]),
    regionalBureau: stringValue(record, ["regional_bureau", "regionalBureau", "厚生局"])
  };
}

function normalizeDatasetOrder(record = {}) {
  return {
    raw: record,
    patientId: stringValue(record, ["patient_id", "patientId", "patient", "patientCode", "患者ID", "患者番号"]),
    serviceDate: dateValue(record, ["service_date", "serviceDate", "date", "encounter_date", "診療日", "受診日"]),
    orderType: normalizeOrderType(stringValue(record, ["order_type", "orderType", "type", "category", "区分", "種別"])),
    name: stringValue(record, ["name", "order_name", "orderName", "drug_name", "material_name", "名称", "オーダー名"]),
    code: stringValue(record, ["code", "standard_code", "standardCode", "drug_code", "material_code", "procedure_code", "コード", "マスターコード"]),
    quantity: numberValue(record, ["quantity", "count", "回数", "数量"]),
    totalQuantity: numberValue(record, ["total_quantity", "totalQuantity", "総量"]),
    quantityPerDay: numberValue(record, ["quantity_per_day", "quantityPerDay", "1日量"]),
    days: integerValue(record, ["days", "日数"]),
    doseQuantity: numberValue(record, ["dose_quantity", "doseQuantity", "1回量"]),
    dosesPerDay: numberValue(record, ["doses_per_day", "dosesPerDay", "1日回数"]),
    status: stringValue(record, ["status", "状態", "実施状態"]),
    kind: stringValue(record, ["kind", "treatment_kind", "imaging_kind", "処置種別", "画像種別"]),
    areaSize: stringValue(record, ["area_size", "areaSize", "area", "面積", "範囲"]),
    medicalInstitutionCode: stringValue(record, ["medical_institution_code", "medicalInstitutionCode", "医療機関コード"]),
    regionalBureau: stringValue(record, ["regional_bureau", "regionalBureau", "厚生局"])
  };
}

function normalizeDatasetDiagnosis(record = {}) {
  const primaryRaw = stringValue(record, ["is_primary", "isPrimary", "primary", "主病名"]);
  return {
    patientId: stringValue(record, ["patient_id", "patientId", "patient", "patientCode", "患者ID", "患者番号"]),
    serviceDate: dateValue(record, ["service_date", "serviceDate", "date", "encounter_date", "診療日", "受診日"]),
    name: stringValue(record, ["diagnosis_name", "diagnosisName", "name", "disease_name", "病名"]),
    icd10Code: stringValue(record, ["icd10_code", "icd10Code", "icd10", "ICD10"]),
    isPrimary: /^(?:1|true|yes|主|主病名)$/iu.test(primaryRaw)
  };
}

function mapDatasetOrderToClaimInput(order = {}) {
  const code = String(order.code || "").trim();
  const type = order.orderType || inferOrderTypeFromName(order.name);
  if (type === "drug") {
    if (!code) return null;
    const medicationOrder = compactClaimObject({
      drug_code: code,
      total_quantity: finiteNumberOrNull(order.totalQuantity),
      quantity_per_day: finiteNumberOrNull(order.quantityPerDay),
      days: finiteIntegerOrNull(order.days),
      dose_quantity: finiteNumberOrNull(order.doseQuantity),
      doses_per_day: finiteNumberOrNull(order.dosesPerDay)
    });
    return Object.keys(medicationOrder).length > 1
      ? { medicationOrder }
      : { drugInput: { code, quantity: finiteNumberOrOne(order.quantity) } };
  }
  if (type === "injection") {
    if (!code) return null;
    const injectionOrder = compactClaimObject({
      drug_code: code,
      total_quantity: finiteNumberOrNull(order.totalQuantity),
      dose_quantity: finiteNumberOrNull(order.doseQuantity),
      administrations: finiteNumberOrOne(order.quantity)
    });
    return Object.keys(injectionOrder).length > 1
      ? { injectionOrder }
      : { injectionDrugInput: { code, quantity: finiteNumberOrOne(order.quantity) } };
  }
  if (type === "material") {
    return code ? { materialInput: { code, quantity: finiteNumberOrOne(order.quantity) } } : null;
  }
  if (type === "treatment") {
    const treatmentOrder = treatmentOrderFromDatasetOrder(order);
    if (treatmentOrder) {
      return { treatmentOrder };
    }
    return code ? { procedureCode: code } : null;
  }
  if (type === "imaging") {
    const imagingOrder = imagingOrderFromDatasetOrder(order);
    if (imagingOrder) {
      return { imagingOrder };
    }
    return code ? { procedureCode: code } : null;
  }
  if (type === "comment") {
    return code ? { commentInput: { code } } : { commentInput: { text: order.name } };
  }
  return code ? { procedureCode: code } : null;
}

function treatmentOrderFromDatasetOrder(order = {}) {
  const text = `${order.kind || ""} ${order.name || ""}`;
  const kind = /熱傷|burn/iu.test(text)
    ? "burn"
    : /創傷|擦過|創処置|wound/iu.test(text)
      ? "wound"
      : /軟膏|皮膚科軟膏|dermatology/iu.test(text)
        ? "dermatology_ointment"
        : "";
  if (!kind) {
    return null;
  }
  return compactClaimObject({
    kind,
    area_size: treatmentAreaSizeKind(order.areaSize || order.name)
  });
}

function imagingOrderFromDatasetOrder(order = {}) {
  const text = `${order.kind || ""} ${order.name || ""}`;
  const kind = /CT|ＣＴ/iu.test(text)
    ? "ct"
    : /MRI|ＭＲＩ/iu.test(text)
      ? "mri"
      : /単純|X線|Ｘ線|レントゲン|radiography/iu.test(text)
        ? "simple_radiography"
        : "";
  return kind ? { kind } : null;
}

function treatmentAreaSizeKind(value = "") {
  const text = String(value || "");
  const numeric = Number((text.match(/(\d+(?:\.\d+)?)/u) || [])[1]);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric < 100) return "lt_100_cm2";
  if (numeric < 500) return "ge_100_lt_500_cm2";
  if (numeric < 3000) return "ge_500_lt_3000_cm2";
  if (numeric < 6000) return "ge_3000_lt_6000_cm2";
  return "ge_6000_cm2";
}

function datasetOrderIsPerformed(order = {}) {
  const status = String(order.status || "").trim();
  if (!status) {
    return true;
  }
  return !/(?:予定|未実施|中止|キャンセル|施行せず|他院|過去|planned|cancel|not[_ -]?done|not[_ -]?performed)/iu.test(status);
}

function normalizeOrderType(value = "") {
  const text = String(value || "").trim();
  if (/^(?:drug|medication|medicine|投薬|薬剤|処方)$/iu.test(text)) return "drug";
  if (/^(?:injection|注射)$/iu.test(text)) return "injection";
  if (/^(?:material|device|特定器材|材料)$/iu.test(text)) return "material";
  if (/^(?:treatment|procedure|処置)$/iu.test(text)) return "treatment";
  if (/^(?:imaging|radiology|画像|画像診断|検査画像)$/iu.test(text)) return "imaging";
  if (/^(?:comment|コメント)$/iu.test(text)) return "comment";
  if (/^(?:procedure_code|手技|基本料|医学管理)$/iu.test(text)) return "procedure";
  return "";
}

function inferOrderTypeFromName(value = "") {
  const text = String(value || "");
  if (/注射/u.test(text)) return "injection";
  if (/材料|被覆材|フォーム|カテーテル/u.test(text)) return "material";
  if (/処置|熱傷|創傷|軟膏塗布/u.test(text)) return "treatment";
  if (/CT|MRI|X線|Ｘ線|レントゲン/u.test(text)) return "imaging";
  if (/錠|カプセル|散|液|軟膏|クリーム|薬/u.test(text)) return "drug";
  return "";
}

function parseDelimitedRecords(text = "", delimiter = null) {
  const rows = parseDelimitedRows(String(text || "").replace(/^\uFEFF/u, ""), delimiter);
  if (rows.length < 2) {
    return [];
  }
  const headers = rows[0].map((header) => String(header || "").trim());
  return rows.slice(1)
    .filter((row) => row.some((cell) => String(cell || "").trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header || `col_${index + 1}`, row[index] ?? ""])));
}

function parseDelimitedRows(text = "", delimiter = null) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const resolvedDelimiter = delimiter || inferDelimiter(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === resolvedDelimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.replace(/\r$/u, ""));
  rows.push(row);
  return rows;
}

function inferDelimiter(text = "") {
  const firstLine = String(text || "").split(/\r?\n/u)[0] || "";
  const tabs = (firstLine.match(/\t/gu) || []).length;
  const commas = (firstLine.match(/,/gu) || []).length;
  return tabs > commas ? "\t" : ",";
}

function unzipTextEntries(buffer) {
  const entries = [];
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) {
    throw requestValidationError("ZIPファイルを読み込めませんでした。");
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount && index < 128; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + fileNameLength);
    const entryPath = (flags & 0x0800 ? nameBytes.toString("utf8") : nameBytes.toString("utf8")).replace(/^\/+/u, "");
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (!entryPath || entryPath.endsWith("/") || /(?:^|\/)\.\.(?:\/|$)/u.test(entryPath)) {
      continue;
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const raw = method === 0
      ? compressed
      : method === 8
        ? inflateRawSync(compressed)
        : null;
    if (!raw) {
      continue;
    }
    entries.push({
      path: entryPath,
      text: decodeUploadedText(raw)
    });
  }
  return entries;
}

function zipEntryForDatasetRole(entries = [], role, manifest = {}) {
  const files = isPlainObject(manifest.files) ? manifest.files : {};
  for (const alias of role.manifestAliases || []) {
    const manifestPath = String(files[alias] || files[alias.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`)] || "").trim();
    if (!manifestPath) {
      continue;
    }
    const found = entries.find((entry) => normalizeDatasetPath(entry.path) === normalizeDatasetPath(manifestPath));
    if (found) {
      return { name: found.path, format: inferUploadFormat(found.path), text: found.text };
    }
  }
  const found = entries.find((entry) => (role.patterns || []).some((pattern) => pattern.test(entry.path)));
  return found ? { name: found.path, format: inferUploadFormat(found.path), text: found.text } : null;
}

function datasetRoleForFileName(name = "") {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return "";
  }
  const matched = RECALCULATION_DATASET_ROLES.find((role) => (
    role.role !== "calculationPayloads"
    && (role.patterns || []).some((pattern) => pattern.test(normalized))
  ));
  if (matched) {
    return matched.role;
  }
  const payloadMatched = RECALCULATION_DATASET_ROLES.find((role) => (
    role.role === "calculationPayloads"
    && (role.patterns || []).some((pattern) => pattern.test(normalized))
  ));
  return payloadMatched?.role || "";
}

function decodeUploadedTextBase64(value = "", encoding = "auto") {
  return decodeUploadedText(Buffer.from(String(value || ""), "base64"), encoding);
}

function decodeUploadedText(buffer, encoding = "auto") {
  const normalized = String(encoding || "auto").trim().toLowerCase().replace("_", "-");
  if (normalized && normalized !== "auto") {
    return iconv.decode(buffer, normalized === "shift-jis" ? "shift_jis" : normalized);
  }
  const utf8 = iconv.decode(buffer, "utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }
  return iconv.decode(buffer, "cp932");
}

function inferUploadFormat(name = "") {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".uke")) return "uke";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".txt")) return "txt";
  return "";
}

function inferBaselineUploadFormat(name = "") {
  const format = inferUploadFormat(name);
  return format === "uke" ? "uke" : "csv";
}

function normalizeDatasetPath(value = "") {
  return String(value || "").trim().replace(/\\/gu, "/").replace(/^\.?\//u, "").toLowerCase();
}

function valueByAliases(record = {}, aliases = []) {
  if (!isPlainObject(record)) {
    return undefined;
  }
  const normalizedMap = new Map();
  for (const [key, value] of Object.entries(record)) {
    normalizedMap.set(normalizeRecordKey(key), value);
  }
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      return record[alias];
    }
    const normalized = normalizeRecordKey(alias);
    if (normalizedMap.has(normalized)) {
      return normalizedMap.get(normalized);
    }
  }
  return undefined;
}

function normalizeRecordKey(key = "") {
  return String(key || "").trim().replace(/[\s_\-・／/]/gu, "").toLowerCase();
}

function stringValue(record = {}, aliases = []) {
  const value = valueByAliases(record, aliases);
  return value == null ? "" : String(value).trim();
}

function dateValue(record = {}, aliases = []) {
  const raw = stringValue(record, aliases);
  if (!raw) {
    return "";
  }
  const match = raw.match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/u);
  if (!match) {
    return /^\d{8}$/u.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw.slice(0, 10);
  }
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizeSex(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (/^(?:m|male|男|男性)$/u.test(text)) return "male";
  if (/^(?:f|female|女|女性)$/u.test(text)) return "female";
  return text || null;
}

function numberValue(record = {}, aliases = []) {
  const raw = stringValue(record, aliases);
  if (!raw) {
    return null;
  }
  const numeric = Number(String(raw).replace(/,/gu, "").match(/-?\d+(?:\.\d+)?/u)?.[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerValue(record = {}, aliases = []) {
  const numeric = numberValue(record, aliases);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function finiteNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function finiteIntegerOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function finiteNumberOrOne(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

function compactClaimObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && entryValue !== ""));
}

function compactClaimInputArray(values = []) {
  return (Array.isArray(values) ? values : []).map(compactClaimObject).filter((value) => Object.keys(value).length > 0);
}

function listValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "").split(/[\s,、\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function normalizeCalculationPayloadsForRecalculationDiff(body = {}, options = {}) {
  const claimMonth = String(options.claimMonth || "").trim();
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_RECALCULATION_DIFF_PAYLOAD_LIMIT);
  const rawPayloads = [
    ...arrayValue(body.calculationPayloads ?? body.calculation_payloads),
    ...arrayValue(body.claimPayloads ?? body.claim_payloads)
  ];
  const contentText = String(body.calculationPayloadText ?? body.calculation_payload_text ?? "").trim();
  const contentBase64 = String(body.calculationPayloadContentBase64 ?? body.calculation_payload_content_base64 ?? "").trim();
  if (contentText || contentBase64) {
    rawPayloads.push(...parseCalculationPayloadContent(contentBase64 ? decodeBase64Utf8(contentBase64) : contentText));
  }
  const normalized = [];
  for (const entry of rawPayloads) {
    const payload = normalizeCalculationPayloadEntry(entry);
    if (!payload) {
      continue;
    }
    const patientId = claimPayloadPatientId(payload);
    const serviceDate = claimPayloadServiceDate(payload);
    const payloadMonth = String(serviceDate || "").slice(0, 7);
    if (!patientId || !/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)) {
      continue;
    }
    if (claimMonth && payloadMonth !== claimMonth) {
      continue;
    }
    normalized.push(payload);
    if (normalized.length > limit) {
      throw requestValidationError(`recalculation diff diagnosis is limited to ${limit} calculation payloads`);
    }
  }
  return normalized;
}

function parseCalculationPayloadContent(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }
  try {
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return extractCalculationPayloadArray(parsed);
    }
    return trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => extractCalculationPayloadArray(JSON.parse(line)));
  } catch {
    throw requestValidationError("再算定元データを読み込めませんでした。再算定用JSON/JSONLの形式を確認してください。");
  }
}

function extractCalculationPayloadArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!isPlainObject(parsed)) {
    return [];
  }
  for (const key of ["calculationPayloads", "calculation_payloads", "claimPayloads", "claim_payloads", "payloads", "records"]) {
    if (Array.isArray(parsed[key])) {
      return parsed[key];
    }
  }
  return [parsed];
}

function normalizeCalculationPayloadEntry(entry) {
  if (!isPlainObject(entry)) {
    return null;
  }
  for (const key of ["claimContext", "claim_context", "payload", "claimPayload", "claim_payload"]) {
    if (isPlainObject(entry[key])) {
      return entry[key];
    }
  }
  return entry;
}

function decodeBase64Utf8(value = "") {
  try {
    return Buffer.from(String(value || ""), "base64").toString("utf8");
  } catch {
    throw requestValidationError("再算定元データを読み込めませんでした。JSON/JSONLファイルを確認してください。");
  }
}

function arrayValue(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (isPlainObject(value)) {
    return [value];
  }
  return [];
}

async function calculateRecalculationDiffSessions({ feeCalculator, calculationPayloads = [], claimMonth = "" } = {}) {
  if (typeof feeCalculator.calculate !== "function") {
    const error = new Error("再算定エンジンが利用できません。");
    error.name = "NotImplementedError";
    error.statusCode = 501;
    throw error;
  }
  const sessions = [];
  let index = 0;
  for (const payload of calculationPayloads) {
    index += 1;
    const session = feeSessionFromClaimPayload(payload, { index, claimMonth });
    const output = await feeCalculator.calculate(session, { claimContext: payload });
    const calculationResult = output?.calculationResult || output?.calculation_result || output || {};
    sessions.push({
      ...session,
      calculationResult
    });
  }
  return sessions;
}

function buildRecalculationReproductionFailures({ calculationPayloads = [], sessions = [], dataset = {}, claimMonth = "" } = {}) {
  const sourceRows = recalculationSourceCodeRows({ calculationPayloads, dataset, claimMonth });
  const engineRows = aggregateRecalculationEngineCodeRows(sessions);
  const failures = [];
  for (const [key, source] of sourceRows.entries()) {
    const engine = engineRows.get(key);
    const engineCount = Number(engine?.count || 0) || 0;
    if (engineCount >= source.count) {
      continue;
    }
    const domain = classifyRecalculationFailureDomain(source, engine);
    failures.push({
      patientId: source.patientId,
      claimMonth: source.claimMonth,
      code: source.code,
      name: source.name || engine?.name || "",
      domain: domain.domain,
      domainLabel: domain.domainLabel,
      supportStatus: domain.supportStatus,
      supportStatusLabel: domain.supportStatusLabel,
      sourceCount: source.count,
      engineCount,
      missingCount: Math.max(0, source.count - engineCount),
      reason: reproductionFailureReason({ domain, engineCount })
    });
  }
  failures.sort((a, b) => (
    String(a.patientId).localeCompare(String(b.patientId))
    || String(a.code).localeCompare(String(b.code))
  ));
  return failures;
}

function buildRecalculationDiffDiagnostics({ baseline = {}, calculationPayloads = [], sessions = [], dataset = {}, claimMonth = "", reproductionFailures = [] } = {}) {
  const baselineClaims = Array.isArray(baseline.baselineClaims) ? baseline.baselineClaims : [];
  const sourceRows = recalculationSourceCodeRows({ calculationPayloads, dataset, claimMonth });
  const engineRows = aggregateRecalculationEngineCodeRows(sessions);
  const homeCareUnsupportedCount = reproductionFailures.filter((row) => row.domain === "home_care").length;
  // 診療月がマスタ適用期間外だと全コード未解決で「再現失敗」に見えるため、原因として明示する。
  const masterCoverageWarnings = (Array.isArray(sessions) ? sessions : [])
    .flatMap((session) => (Array.isArray(session?.calculationResult?.warnings) ? session.calculationResult.warnings : []))
    .filter((warning) => String(warning || "").includes("マスタ適用期間外"));
  return {
    masterCoverage: masterCoverageWarnings.length
      ? {
        status: "out_of_range",
        affectedSessionWarningCount: masterCoverageWarnings.length,
        message: masterCoverageWarnings[0]
      }
      : { status: "ok" },
    receiptParse: {
      status: baselineClaims.length ? "parsed" : "empty",
      format: baseline.baselineFormat || (baselineClaims.length ? "claims" : "none"),
      formatLabel: baselineFormatLabel(baseline.baselineFormat || (baselineClaims.length ? "claims" : "none")),
      claimCount: baselineClaims.length,
      lineCount: baselineClaimLineCount(baselineClaims),
      message: baselineClaims.length
        ? "既存レセを患者×月の明細として取り込めています。"
        : "既存レセ明細は取り込まれていません。"
    },
    recalculationAccuracy: {
      status: reproductionFailures.length ? "needs_engine_work" : "ready",
      sourcePayloadCount: Array.isArray(calculationPayloads) ? calculationPayloads.length : 0,
      sourceCodeCount: sourceRows.size,
      engineCodeCount: engineRows.size,
      reproductionFailureCount: reproductionFailures.length,
      homeCareUnsupportedCount,
      message: reproductionFailures.length
        ? "UKE解析とは別に、当社エンジンで再現できていない明細があります。"
        : "再算定元データと当社エンジン出力の再現失敗はありません。"
    },
    engineCoverageDecision: {
      homeCare: {
        status: "not_enabled",
        label: "在宅系は当社未対応として表示",
        reason: "在宅患者訪問診療料・在宅系加算は要件が多いため、現時点では自動再現対象に広げず、再現失敗として可視化します。"
      }
    }
  };
}

function recalculationSourceCodeRows({ calculationPayloads = [], dataset = {}, claimMonth = "" } = {}) {
  const datasetRows = datasetOrderCodeRows(dataset, claimMonth);
  const payloadRows = calculationPayloads.flatMap((payload) => claimPayloadInputCodeRows(payload, { claimMonth }));
  return aggregateRecalculationInputCodeRows(
    datasetRows.length ? datasetRows : payloadRows,
    datasetOrderNameMap(dataset, claimMonth)
  );
}

function baselineClaimLineCount(baselineClaims = []) {
  return (Array.isArray(baselineClaims) ? baselineClaims : []).reduce((sum, claim) => {
    const lines = Array.isArray(claim?.lines) ? claim.lines : (Array.isArray(claim?.lineItems) ? claim.lineItems : []);
    return sum + lines.length;
  }, 0);
}

function baselineFormatLabel(format = "") {
  const normalized = String(format || "").toLowerCase();
  if (normalized === "uke") return "UKE";
  if (normalized === "csv") return "CSV";
  if (normalized === "claims") return "構造化データ";
  if (normalized === "none") return "未取込";
  return normalized || "取込済み";
}

function classifyRecalculationFailureDomain(source = {}, engine = {}) {
  const code = String(source?.code || engine?.code || "").trim();
  const name = String(source?.name || engine?.name || "").trim();
  if (isHomeCareClaimCode(code, name)) {
    return {
      domain: "home_care",
      domainLabel: "在宅系",
      supportStatus: "unsupported_home_care",
      supportStatusLabel: "当社未対応（在宅）"
    };
  }
  return {
    domain: "general",
    domainLabel: "一般",
    supportStatus: "engine_gap",
    supportStatusLabel: "再現失敗"
  };
}

function isHomeCareClaimCode(code = "", name = "") {
  return /^114/u.test(String(code || ""))
    || /在宅|訪問診療|往診|在医総管|施医総管|在宅医療|訪問看護|施設入居/u.test(String(name || ""));
}

function reproductionFailureReason({ domain = {}, engineCount = 0 } = {}) {
  if (Number(engineCount || 0) > 0) {
    return "再算定元データにある回数より、当社エンジン結果の回数が少ないため確認が必要です。";
  }
  if (domain.domain === "home_care") {
    return "再算定元データにはありますが、在宅系コードは当社エンジンの再現対象として未整備です。UKE解析は成功しています。";
  }
  return "再算定元データにはありますが、当社エンジン結果に出ませんでした。算定ロジックまたは入力変換の確認が必要です。";
}

function datasetOrderCodeRows(dataset = {}, claimMonth = "") {
  const rows = [];
  for (const record of datasetRecords(dataset, "orders")) {
    const order = normalizeDatasetOrder(record);
    if (!datasetOrderIsPerformed(order) || !order.patientId || !order.code) {
      continue;
    }
    const month = String(order.serviceDate || "").slice(0, 7) || claimMonth;
    if (!month || (claimMonth && month !== claimMonth)) {
      continue;
    }
    rows.push({
      patientId: order.patientId,
      claimMonth: month,
      code: order.code,
      name: order.name,
      count: finiteNumberOrOne(order.quantity)
    });
  }
  return rows;
}

function aggregateRecalculationInputCodeRows(rows = [], nameMap = new Map()) {
  const aggregated = new Map();
  for (const row of rows) {
    const key = recalculationCodeKey(row.patientId, row.claimMonth, row.code);
    const current = aggregated.get(key) || {
      patientId: row.patientId,
      claimMonth: row.claimMonth,
      code: row.code,
      name: "",
      count: 0
    };
    current.name ||= row.name || nameMap.get(key) || "";
    current.count += Number(row.count || 1) || 1;
    aggregated.set(key, current);
  }
  return aggregated;
}

function aggregateRecalculationEngineCodeRows(sessions = []) {
  const aggregated = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const patientId = String(session?.patientId || "").trim();
    const claimMonth = baselineSessionClaimMonth(session);
    const lineItems = Array.isArray(session?.calculationResult?.lineItems) ? session.calculationResult.lineItems : [];
    for (const line of lineItems) {
      const status = String(line?.status || "candidate");
      if (!["confirmed", "candidate", "needs_review"].includes(status)) {
        continue;
      }
      const code = String(line?.code || "").trim();
      if (!patientId || !claimMonth || !code) {
        continue;
      }
      const key = recalculationCodeKey(patientId, claimMonth, code);
      const current = aggregated.get(key) || { patientId, claimMonth, code, name: "", count: 0 };
      current.name ||= String(line?.name || "").trim();
      current.count += Number(line?.quantity || line?.count || 1) || 1;
      aggregated.set(key, current);
    }
  }
  return aggregated;
}

function claimPayloadInputCodeRows(payload = {}, { claimMonth = "" } = {}) {
  const patientId = claimPayloadPatientId(payload);
  const serviceDate = claimPayloadServiceDate(payload);
  const month = String(serviceDate || "").slice(0, 7) || claimMonth;
  if (!patientId || !month) {
    return [];
  }
  const rows = [];
  const push = (code, count = 1, name = "") => {
    const normalized = String(code || "").trim();
    if (!normalized) {
      return;
    }
    rows.push({
      patientId,
      claimMonth: month,
      code: normalized,
      name: String(name || "").trim(),
      count: Number(count || 1) || 1
    });
  };
  for (const code of listValue(payload.procedure_codes)) {
    push(code);
  }
  for (const item of [
    ...arrayValue(payload.drug_inputs),
    ...arrayValue(payload.material_inputs),
    ...arrayValue(payload.injection_drug_inputs)
  ]) {
    push(item.code || item.drug_code || item.material_code, item.quantity);
  }
  for (const item of [
    ...arrayValue(payload.medication_orders),
    ...arrayValue(payload.injection_orders)
  ]) {
    push(item.code || item.drug_code, item.total_quantity || item.quantity || item.administrations || 1);
  }
  for (const item of arrayValue(payload.comment_inputs)) {
    push(item.code);
  }
  return rows;
}

function datasetOrderNameMap(dataset = {}, claimMonth = "") {
  const map = new Map();
  for (const record of datasetRecords(dataset, "orders")) {
    const order = normalizeDatasetOrder(record);
    if (!datasetOrderIsPerformed(order) || !order.patientId || !order.code) {
      continue;
    }
    const month = String(order.serviceDate || "").slice(0, 7) || claimMonth;
    if (claimMonth && month !== claimMonth) {
      continue;
    }
    map.set(recalculationCodeKey(order.patientId, month, order.code), order.name);
  }
  return map;
}

function recalculationCodeKey(patientId, claimMonth, code) {
  return `${String(patientId || "").trim()}\u0000${String(claimMonth || "").trim()}\u0000${String(code || "").trim()}`;
}

function feeSessionFromClaimPayload(payload = {}, { index = 1, claimMonth = "" } = {}) {
  const encounter = isPlainObject(payload.encounter) ? payload.encounter : {};
  const patient = isPlainObject(payload.patient) ? payload.patient : {};
  const serviceDate = claimPayloadServiceDate(payload);
  const patientId = claimPayloadPatientId(payload);
  return {
    feeSessionId: `recalc_${claimMonth || "month"}_${String(index).padStart(5, "0")}`,
    patientId,
    patientRef: patientId,
    serviceDate,
    claimMonth: String(serviceDate || "").slice(0, 7) || claimMonth,
    setting: encounter.is_outpatient === false ? "inpatient" : "outpatient",
    patientSnapshot: {
      patientId,
      displayName: patient.display_name || patient.displayName || patient.name || patientId,
      birthDate: patient.birth_date || patient.birthDate || null,
      sex: patient.sex || null
    },
    facilitySnapshot: {
      medicalInstitutionCode: encounter.medical_institution_code || encounter.medicalInstitutionCode || null,
      regionalBureau: encounter.regional_bureau || encounter.regionalBureau || null
    },
    clinicalText: payload.clinical_text || payload.clinicalText || "",
    diagnoses: Array.isArray(payload.diagnoses) ? payload.diagnoses : [],
    claimContext: payload
  };
}

function claimPayloadPatientId(payload = {}) {
  const patient = isPlainObject(payload.patient) ? payload.patient : {};
  return String(
    patient.patient_id
    || patient.patientId
    || payload.patient_id
    || payload.patientId
    || payload.record_id
    || payload.recordId
    || ""
  ).trim();
}

function claimPayloadServiceDate(payload = {}) {
  const encounter = isPlainObject(payload.encounter) ? payload.encounter : {};
  return String(
    encounter.service_date
    || encounter.serviceDate
    || payload.service_date
    || payload.serviceDate
    || ""
  ).trim();
}

// 月次候補の重複排除(回数上限)と背反注釈に使う電子点数表制約を引く。
// 補助情報のため、マスタ未整備や参照失敗では空を返して月次集計自体は継続する。
async function monthlyCandidateConstraints(feeCalculator, sessions = [], { patientId = "", claimMonth = "" } = {}) {
  if (typeof feeCalculator?.checkLookup !== "function") {
    return {};
  }
  const codes = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (patientId && String(session?.patientId || "") !== String(patientId)) {
      continue;
    }
    const month = String(session?.claimMonth || String(session?.serviceDate || "").slice(0, 7));
    if (claimMonth && month !== claimMonth) {
      continue;
    }
    for (const line of asArrayValue(session?.calculationResult?.lineItems)) {
      const code = String(line?.code || "").trim();
      if (code) codes.add(code);
    }
    for (const proposal of asArrayValue(session?.calculationResult?.candidateProposals)) {
      const code = String(proposal?.code || proposal?.candidateLine?.code || "").trim();
      if (code) codes.add(code);
    }
  }
  if (!codes.size) {
    return {};
  }
  try {
    const lookup = await feeCalculator.checkLookup({ act_codes: [...codes], drug_codes: [], disease_codes: [] });
    return {
      actFrequencyLimits: isPlainObject(lookup?.actFrequencyLimits) ? lookup.actFrequencyLimits : {},
      actExclusions: Array.isArray(lookup?.actExclusions) ? lookup.actExclusions : []
    };
  } catch {
    return {};
  }
}

function asArrayValue(value) {
  return Array.isArray(value) ? value : [];
}

// 月次点検系(サマリ/一括候補/レセプト)は請求月で絞り、全件フルスキャンを避ける。
// store 側は claimMonth 欠損の既存データを serviceDate 月範囲で補完し、ここでは上限超過を
// 明示的にエラー化する。請求系で静かに切り捨てる挙動は避ける。
async function listSessionsForMonthlyView(feeStore, orgId, claimMonth, options = {}) {
  const month = String(claimMonth || "").trim();
  const limit = monthlyViewSessionLimit(options.processEnv || process.env);
  const patientId = String(options.patientId || "").trim();
  const patientIds = patientId ? [] : uniqueStrings(options.patientIds || []);
  if (month && typeof feeStore.listSessionsForClaimMonth === "function") {
    const sessions = await feeStore.listSessionsForClaimMonth(orgId, month, {
      limit: limit + 1,
      ...(patientId ? { patientId } : {}),
      ...(!patientId && patientIds.length ? { patientIds } : {})
    });
    const sessionList = Array.isArray(sessions) ? sessions : [];
    if (sessionList.length > limit) {
      throw requestValidationError(`monthly view is limited to ${limit} sessions per claimMonth`);
    }
    return sessionList;
  }
  const sessions = await feeStore.listSessions(orgId);
  let sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
  if (patientId) {
    sessionList = sessionList.filter((session) => String(session.patientId || "").trim() === patientId);
  } else if (patientIds.length && patientIds.length <= 100) {
    const patientIdSet = new Set(patientIds);
    sessionList = sessionList.filter((session) => patientIdSet.has(String(session.patientId || "").trim()));
  }
  if (month) {
    return sessionList.filter((session) => baselineSessionClaimMonth(session) === month);
  }
  return sessionList;
}

async function listSessionsForBaselineDiagnosis(feeStore, orgId, options = {}) {
  const claimMonth = String(options.claimMonth || "").trim();
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_BASELINE_DIAGNOSIS_SESSION_LIMIT);
  const patientIds = uniqueStrings(options.patientIds || []);
  if (typeof feeStore.listSessionsForClaimMonth === "function") {
    const sessions = await feeStore.listSessionsForClaimMonth(orgId, claimMonth, {
      limit: limit + 1,
      ...(patientIds.length ? { patientIds } : {})
    });
    if (sessions.length > limit) {
      throw requestValidationError(`baseline diagnosis is limited to ${limit} sessions per claimMonth`);
    }
    return sessions;
  }

  const sessions = await feeStore.listSessions(orgId);
  const sessionList = Array.isArray(sessions) ? sessions : (sessions.feeSessions || []);
  const patientIdSet = patientIds.length && patientIds.length <= 100 ? new Set(patientIds) : null;
  const filtered = sessionList
    .filter((session) => baselineSessionClaimMonth(session) === claimMonth)
    .filter((session) => !patientIdSet || patientIdSet.has(String(session.patientId || "").trim()));
  if (filtered.length > limit) {
    throw requestValidationError(`baseline diagnosis is limited to ${limit} sessions per claimMonth`);
  }
  return filtered;
}

function baselineInternalPatientIds(baseline = {}) {
  const claims = Array.isArray(baseline.baselineClaims) ? baseline.baselineClaims : [];
  if (!claims.length) {
    return [];
  }
  const patientIds = claims.map((claim) => {
    const explicitInternalId = String(claim.internalPatientId ?? claim.internal_patient_id ?? "").trim();
    if (explicitInternalId) {
      return explicitInternalId;
    }
    // UKE/CSVのpatientIdはレセコン側の外部IDであり、FeeのpatientIdとは限らない。
    return baseline.baselineContentProvided
      ? ""
      : String(claim.patientId ?? claim.patient_id ?? "").trim();
  });
  if (patientIds.some((patientId) => !patientId)) {
    return [];
  }
  return uniqueStrings(patientIds);
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

function monthlyViewSessionLimit(env = process.env) {
  return parsePositiveInteger(env.FEE_MONTHLY_VIEW_SESSION_LIMIT, DEFAULT_MONTHLY_VIEW_SESSION_LIMIT, 100_000);
}

function baselineDiagnosisClaimLimit(env = process.env) {
  return parsePositiveInteger(env.FEE_BASELINE_DIAGNOSIS_CLAIM_LIMIT, DEFAULT_BASELINE_DIAGNOSIS_CLAIM_LIMIT, 50_000);
}

function recalculationDiffPayloadLimit(env = process.env) {
  return parsePositiveInteger(env.FEE_RECALCULATION_DIFF_PAYLOAD_LIMIT, DEFAULT_RECALCULATION_DIFF_PAYLOAD_LIMIT, 5_000);
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
  if (
    typeof feeStore.createCalculationJob !== "function"
    || typeof feeStore.updateCalculationJob !== "function"
    || typeof feeStore.getCalculationJob !== "function"
  ) {
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
  const queuedProgress = feeCalculationProgress({
    phase: "queued",
    percent: 1,
    message: "算定ジョブを受け付けました。",
    session: current,
    now: input.now || new Date()
  });
  const createdJob = await feeStore.createCalculationJob(context.session.orgId, feeSessionId, {
    status: "queued",
    phase: "queued",
    calculationInput,
    inputSnapshot,
    calculationProgress: queuedProgress,
    createdByMemberId: context.session.memberId
  });
  const calculationJobId = createdJob.calculationJob.calculationJobId;
  const enqueue = await enqueueFeeCalculationJob({
    input,
    context,
    calculationJob: createdJob.calculationJob
  });
  const jobWasQueued = enqueue.status === "queued";
  const failedProgress = feeCalculationProgress({
    phase: "failed",
    percent: 0,
    message: "算定ジョブをキューに投入できませんでした。Cloud Tasks または Pub/Sub の設定を確認してください。",
    session: current,
    now: input.now || new Date()
  });
  let enqueueFailureTransitioned = false;
  let updatedJob;
  try {
    updatedJob = await feeStore.updateCalculationJob(context.session.orgId, feeSessionId, calculationJobId, {
      ...(jobWasQueued ? {} : {
        status: enqueue.status || "enqueue_failed",
        phase: enqueue.phase || "enqueue",
        progress: failedProgress
      }),
      enqueueStatus: enqueue.enqueueStatus,
      enqueueProvider: enqueue.enqueueProvider,
      enqueueMessage: enqueue.enqueueMessage
    }, {
      expectedEnqueueStatus: "pending",
      ...(jobWasQueued ? {} : { expectedStatus: "queued" })
    });
    enqueueFailureTransitioned = !jobWasQueued;
  } catch (error) {
    if (!isCalculationJobStateConflict(error)) {
      throw error;
    }
    const calculationJob = await feeStore.getCalculationJob(
      context.session.orgId,
      feeSessionId,
      calculationJobId
    );
    if (!calculationJob) {
      throw error;
    }
    updatedJob = { calculationJob };
  }
  if (enqueueFailureTransitioned) {
    try {
      await feeStore.updateSession(context.session.orgId, feeSessionId, {
        status: current.status,
        activeCalculationJobId: null,
        calculationProgress: updatedJob.calculationJob.progress || failedProgress
      }, {
        expectedActiveCalculationJobId: calculationJobId,
        calculationJobId,
        expectedCalculationJobStatus: updatedJob.calculationJob.status
      });
    } catch (error) {
      if (!isFeeCalculationStateConflict(error)) {
        throw error;
      }
      const calculationJob = await feeStore.getCalculationJob(
        context.session.orgId,
        feeSessionId,
        calculationJobId
      );
      if (calculationJob) {
        updatedJob = { calculationJob };
      }
    }
  }
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
        errorMessage: safeClientErrorMessage(error, "算定ジョブを投入できませんでした。")
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
  const now = input.now || new Date();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = timestampForSnapshot(new Date(
    new Date(now).getTime() + calculationJobLeaseDurationMs(input.processEnv || process.env)
  ));
  if (typeof feeStore.claimCalculationJob !== "function") {
    const error = new Error("atomic fee calculation job claims are required");
    error.name = "ConfigurationError";
    error.statusCode = 500;
    throw error;
  }
  const claim = await feeStore.claimCalculationJob(orgId, feeSessionId, calculationJobId, {
    leaseToken,
    leaseExpiresAt,
    now,
    phase: "extract"
  });
  if (!claim.claimed) {
    return {
      calculationJob: claim.calculationJob,
      ...(claim.alreadyCompleted ? { alreadyCompleted: true } : {}),
      ...(claim.alreadyRunning ? { alreadyRunning: true } : {})
    };
  }
  const runningJob = claim.calculationJob;
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
      calculationJobId,
      calculationJobLeaseToken: leaseToken
    });
    const completedJob = typeof feeStore.updateCalculationJob === "function"
      ? (await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
        status: "succeeded",
        phase: "complete",
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: timestampForSnapshot(input.now || new Date()),
        progress: result.feeSession?.calculationProgress || null,
        resultSummary: {
          calculationId: result.calculationResult?.calculationId || null,
          totalPoints: Number(result.calculationResult?.totalPoints || 0),
          feeSessionStatus: result.feeSession?.status || null
        }
      }, calculationJobLeaseUpdateOptions(leaseToken))).calculationJob
      : runningJob;
    return {
      calculationJob: completedJob,
      feeSession: result.feeSession,
      receiptDraft: result.receiptDraft,
      candidateWorkbench: result.candidateWorkbench
    };
  } catch (error) {
    await markFeeCalculationFailed({
      context,
      feeStore,
      feeSessionId,
      error,
      now: input.now || new Date(),
      calculationJobId,
      calculationJobLeaseToken: leaseToken
    });
    if (typeof feeStore.updateCalculationJob === "function") {
      try {
        await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
          status: "failed",
          phase: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: timestampForSnapshot(input.now || new Date()),
          error: {
            name: error.name || "Error",
            message: safeLogError(error)
          }
        }, calculationJobLeaseUpdateOptions(leaseToken));
      } catch (updateError) {
        if (!isCalculationJobLeaseConflict(updateError)) {
          logFeeApiError(updateError, {
            stage: "calculation_job_failure_update",
            orgId,
            feeSessionId,
            calculationJobId
          });
        }
      }
    }
    throw error;
  }
}

function calculationJobLeaseDurationMs(env = {}) {
  const requestedSeconds = Number.parseInt(env.FEE_CALCULATION_JOB_LEASE_SECONDS || "1800", 10);
  const seconds = Number.isFinite(requestedSeconds)
    ? Math.min(7200, Math.max(300, requestedSeconds))
    : 1800;
  return seconds * 1000;
}

function calculationJobLeaseUpdateOptions(leaseToken) {
  return leaseToken ? { expectedLeaseToken: leaseToken } : {};
}

function calculationSessionLeaseUpdateOptions(calculationJobId, leaseToken, options = {}) {
  if (calculationJobId && leaseToken) {
    return {
      calculationJobId,
      expectedLeaseToken: leaseToken,
      ...(options.allowClearedActiveCalculationJob === true
        ? { allowClearedActiveCalculationJob: true }
        : {})
    };
  }
  return options.allowCalculatingSessionMutation === true
    ? { allowCalculatingSessionMutation: true }
    : {};
}

function isCalculationJobLeaseConflict(error) {
  return error?.code === "FEE_CALCULATION_JOB_LEASE_CONFLICT"
    || (error?.name === "ConflictError" && error?.statusCode === 409);
}

function isCalculationJobStateConflict(error) {
  return error?.code === "FEE_CALCULATION_JOB_STATE_CONFLICT";
}

function isFeeCalculationStateConflict(error) {
  return isCalculationJobStateConflict(error)
    || isFeeSessionCalculationConflict(error);
}

function isFeeSessionCalculationConflict(error) {
  return error?.code === "FEE_SESSION_CALCULATION_CONFLICT";
}

async function updateFeeCalculationProgress({
  feeStore,
  orgId,
  feeSessionId,
  calculationJobId = null,
  calculationJobLeaseToken = null,
  session = {},
  sessionPatch = null,
  allowCalculatingSessionMutation = false,
  progress
}) {
  if (calculationJobId && typeof feeStore.updateCalculationJob === "function") {
    await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
      phase: progress?.phase || "running",
      progress
    }, calculationJobLeaseUpdateOptions(calculationJobLeaseToken));
    if (sessionPatch && Object.keys(sessionPatch).length) {
      const result = await feeStore.updateSession(
        orgId,
        feeSessionId,
        sessionPatch,
        calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken)
      );
      return { feeSession: result.feeSession };
    }
    return { feeSession: session };
  }

  return feeStore.updateSession(orgId, feeSessionId, {
    ...(sessionPatch || {}),
    calculationProgress: progress
  }, calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken, {
    allowCalculatingSessionMutation
  }));
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
  calculationJobId = null,
  calculationJobLeaseToken = null
}) {
  const overallStartedAt = Date.now();
  const stageTimings = [];
  const previousCalculationResult = isPlainObject(current.calculationResult) ? current.calculationResult : null;
  const calculating = await updateFeeCalculationProgress({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    calculationJobLeaseToken,
    session: current,
    sessionPatch: {
      status: "calculating",
      ...(calculationJobId ? {} : { latestCalculationJobId: null })
    },
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
    stageTimings,
    calculationJobId,
    calculationJobLeaseToken
  });
  const progressed = await updateFeeCalculationProgress({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    calculationJobLeaseToken,
    session: calculationSession,
    allowCalculatingSessionMutation: true,
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
    calculationJobId,
    calculationJobLeaseToken
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
  status = null,
  calculationJobId = null,
  calculationJobLeaseToken = null
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
      fn: () => feeStore.updateSession(
        context.session.orgId,
        feeSessionId,
        patch,
        calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken, {
          allowCalculatingSessionMutation: true
        })
      ),
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
  calculationJobId = null,
  calculationJobLeaseToken = null
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
    calculationJobLeaseToken,
    session: calculationSession,
    allowCalculatingSessionMutation: true,
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
  const indicationReviewIssues = await resolveIndicationReviewIssues({
    feeCalculator,
    session: calculationSession,
    calculation: calculationResult,
    calculationInput: calculationInputForSession
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
          }),
          ...buildMissingBillingReviewIssues(claimCheckInput(calculationSession, calculationResult, calculationInputForSession)),
          ...indicationReviewIssues
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
      }, prepared.reviewWarnings),
      calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken, {
        allowCalculatingSessionMutation: true
      })
    )
  });
  await timedCalculationStage({
    stage: "audit",
    orgId: context.session.orgId,
    feeSessionId,
    stageTimings,
    fn: () => platformStore.createAuditEvent(context.session.orgId, {
      eventType: calculationSession.recordType === "sidecar_calculation_draft"
        ? "fee.sidecar_draft_calculated"
        : "fee.calculated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: calculationSession.recordType === "sidecar_calculation_draft"
        ? "sidecar_calculation_draft"
        : "fee_session",
      targetId: result.feeSession.feeSessionId,
      productId: context.productId || PRODUCT_ID,
      safePayload: {
        feeSessionId: result.feeSession.feeSessionId,
        calculationId: result.calculationResult.calculationId,
        provider: result.calculationResult.provider,
        totalPoints: result.calculationResult.totalPoints,
        encounterDetails: calculationSession.encounterDetails || null
      }
    })
  });
  const performance = buildFeeCalculationPerformanceSnapshot({
    env: input.processEnv || process.env,
    orgId: context.session.orgId,
    feeSessionId,
    feeSession: result.feeSession,
    calculationResult: result.calculationResult,
    prepared,
    stageTimings,
    totalDurationMs: Date.now() - overallStartedAt,
    completedAt: new Date().toISOString()
  });
  const performancePersist = await persistFeeCalculationPerformance({
    feeStore,
    orgId: context.session.orgId,
    feeSessionId,
    calculationJobId,
    calculationJobLeaseToken,
    feeSession: result.feeSession,
    performance
  });
  if (performancePersist?.feeSession) {
    result.feeSession = performancePersist.feeSession;
  } else if (performancePersist?.progress) {
    result.feeSession = {
      ...result.feeSession,
      calculationProgress: performancePersist.progress
    };
  }
  console.info(JSON.stringify({
    event: "fee.calculate.performance",
    orgId: context.session.orgId,
    feeSessionId,
    calculationId: result.calculationResult.calculationId,
    status: result.feeSession.status,
    ...performance
  }));
  console.info(JSON.stringify({
    event: "fee.calculate.completed",
    orgId: context.session.orgId,
    feeSessionId,
    status: result.feeSession.status,
    totalPoints: result.calculationResult.totalPoints,
    totalDurationMs: performance.totalDurationMs,
    calculatorDurationMs: stageDuration(stageTimings, "pythonCalculator"),
    bottleneckStage: performance.bottleneckStage,
    cache: performance.openAiCache || null,
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
  now,
  calculationJobId = null,
  calculationJobLeaseToken = null
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
    }, calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken, {
      allowClearedActiveCalculationJob: true,
      allowCalculatingSessionMutation: true
    }));
    return true;
  } catch (updateError) {
    if (isCalculationJobLeaseConflict(updateError)) {
      return false;
    }
    // Preserve the original calculation error.
    return true;
  }
}

// 算定もれ/適応点検(fee-core claim-checks)へ渡す正規化claimを、
// 当社算定の明細(judgement区分はB1でengineが付与済み)とセッションから組み立てる。
function claimCheckInput(session = {}, calculation = {}, calculationInput = {}) {
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const patient = session.patientSnapshot || {};
  const doseByCode = claimCheckDoseContextByDrugCode(calculationInput, calculation);
  return {
    isInpatient: String(session.setting || "") === "inpatient",
    encounterSetting: String(session.setting || "outpatient"),
    serviceDate: session.serviceDate || "",
    sex: normalizeCheckSex(patient.sex),
    ageYears: patientAgeYears(patient.birthDate || patient.birth_date, session.serviceDate),
    items: lineItems.map((line) => {
      const dose = doseByCode.get(String(line.code || "").trim()) || {};
      return {
        lineId: line.lineId || line.line_id || "",
        code: line.code || "",
        name: line.name || "",
        orderType: line.orderType || "",
        recType: line.recType || line.rec_type || "",
        judgementKind: line.judgementKind || "",
        judgementGroup: line.judgementGroup || "",
        quantity: finiteNumberOrNull(line.quantity),
        quantityPerDay: finiteNumberOrNull(line.quantityPerDay ?? line.quantity_per_day ?? dose.quantityPerDay),
        doseQuantity: finiteNumberOrNull(line.doseQuantity ?? line.dose_quantity ?? dose.doseQuantity),
        dosesPerDay: finiteNumberOrNull(line.dosesPerDay ?? line.doses_per_day ?? dose.dosesPerDay),
        totalQuantity: finiteNumberOrNull(line.totalQuantity ?? line.total_quantity ?? dose.totalQuantity),
        days: finiteIntegerOrNull(line.days ?? dose.days),
        dispensingKind: line.dispensingKind || line.dispensing_kind || dose.dispensingKind || "",
        shinryoShikibetsu: line.shinryoShikibetsu || line.shinryo_shikibetsu || dose.shinryoShikibetsu || "",
        unit: line.unit || dose.unit || ""
      };
    }),
    diseases: (Array.isArray(session.diagnoses) ? session.diagnoses : []).map((d) => ({
      code: String(d?.code || d?.diseaseCode || d?.disease_code || "").trim(),
      name: String(d?.name || d?.displayName || d?.display_name || "").trim(),
      suspected: Boolean(d?.suspected) || /疑い/u.test(String(d?.name || d?.displayName || ""))
    }))
  };
}

function claimCheckDoseContextByDrugCode(calculationInput = {}, calculation = {}) {
  const byCode = new Map();
  const add = (code, patch = {}) => {
    const normalized = String(code || patch.drug_code || patch.drugCode || patch.code || "").trim();
    if (!normalized) {
      return;
    }
    const current = byCode.get(normalized) || {};
    byCode.set(normalized, mergeClaimCheckDoseContext(current, patch));
  };

  const options = isPlainObject(calculationInput.calculationOptions || calculationInput.calculation_options)
    ? calculationInput.calculationOptions || calculationInput.calculation_options
    : {};
  const claimContext = isPlainObject(calculationInput.claimContext || calculationInput.claim_context)
    ? calculationInput.claimContext || calculationInput.claim_context
    : {};

  for (const source of [options, claimContext]) {
    for (const order of arrayValue(source.medication_orders || source.medicationOrders)) {
      add(order.drug_code || order.drugCode || order.code, {
        quantityPerDay: order.quantity_per_day ?? order.quantityPerDay,
        doseQuantity: order.dose_quantity ?? order.doseQuantity,
        dosesPerDay: order.doses_per_day ?? order.dosesPerDay,
        totalQuantity: order.total_quantity ?? order.totalQuantity,
        days: order.days,
        dispensingKind: order.dispensing_kind ?? order.dispensingKind,
        shinryoShikibetsu: "21"
      });
    }
    for (const order of arrayValue(source.injection_orders || source.injectionOrders)) {
      add(order.drug_code || order.drugCode || order.code, {
        quantityPerDay: order.dose_quantity ?? order.doseQuantity ?? order.total_quantity ?? order.totalQuantity,
        doseQuantity: order.dose_quantity ?? order.doseQuantity,
        totalQuantity: order.total_quantity ?? order.totalQuantity,
        shinryoShikibetsu: "31"
      });
    }
  }

  for (const order of arrayValue(calculationInput.orders)) {
    const orderType = String(order.orderType || order.order_type || "").trim();
    if (orderType !== "drug" && orderType !== "injection") {
      continue;
    }
    add(order.code || order.drug_code || order.drugCode, {
      quantityPerDay: order.quantityPerDay ?? order.quantity_per_day,
      doseQuantity: order.doseQuantity ?? order.dose_quantity,
      dosesPerDay: order.dosesPerDay ?? order.doses_per_day,
      totalQuantity: order.totalQuantity ?? order.total_quantity,
      days: order.days,
      shinryoShikibetsu: orderType === "injection" ? "31" : "21"
    });
  }

  for (const line of arrayValue(calculation.lineItems || calculation.line_items)) {
    add(line.code, {
      quantityPerDay: line.quantityPerDay ?? line.quantity_per_day,
      doseQuantity: line.doseQuantity ?? line.dose_quantity,
      dosesPerDay: line.dosesPerDay ?? line.doses_per_day,
      totalQuantity: line.totalQuantity ?? line.total_quantity,
      days: line.days,
      dispensingKind: line.dispensingKind ?? line.dispensing_kind,
      shinryoShikibetsu: line.shinryoShikibetsu ?? line.shinryo_shikibetsu,
      unit: line.unit
    });
  }

  return byCode;
}

function mergeClaimCheckDoseContext(current = {}, patch = {}) {
  const next = { ...current };
  const maxNumber = (key, value) => {
    const incoming = finiteNumberOrNull(value);
    if (incoming == null) {
      return;
    }
    const existing = finiteNumberOrNull(next[key]);
    next[key] = existing == null ? incoming : Math.max(existing, incoming);
  };
  maxNumber("quantityPerDay", patch.quantityPerDay ?? patch.quantity_per_day);
  maxNumber("doseQuantity", patch.doseQuantity ?? patch.dose_quantity);
  maxNumber("dosesPerDay", patch.dosesPerDay ?? patch.doses_per_day);
  maxNumber("totalQuantity", patch.totalQuantity ?? patch.total_quantity);
  maxNumber("days", patch.days);
  for (const key of ["dispensingKind", "shinryoShikibetsu", "unit"]) {
    if (!next[key] && patch[key]) {
      next[key] = String(patch[key]);
    }
  }
  return next;
}

// レセ電の男女区分に合わせる(1:男 2:女)。
function normalizeCheckSex(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "male" || raw === "m" || raw === "1" || raw === "男") return "1";
  if (raw === "female" || raw === "f" || raw === "2" || raw === "女") return "2";
  return "";
}

function patientAgeYears(birthDate, serviceDate) {
  const birth = new Date(String(birthDate || ""));
  const service = new Date(String(serviceDate || "") || Date.now());
  if (Number.isNaN(birth.getTime()) || Number.isNaN(service.getTime())) {
    return null;
  }
  let age = service.getFullYear() - birth.getFullYear();
  const beforeBirthday = service.getMonth() < birth.getMonth()
    || (service.getMonth() === birth.getMonth() && service.getDate() < birth.getDate());
  if (beforeBirthday) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// 適応/禁忌/併用点検(C)。checkLookup で必要マスタを引き reviewIssue[] を返す。
// マスタ未取込・コード無し・lookup失敗のいずれでも算定本体は止めない(点検は補助)。
async function resolveIndicationReviewIssues({ feeCalculator, session, calculation, calculationInput = {} }) {
  try {
    if (!feeCalculator || typeof feeCalculator.checkLookup !== "function") {
      return [];
    }
    const claim = claimCheckInput(session, calculation, calculationInput);
    const codes = claimCheckLookupCodes(claim);
    if (codes.drug_codes.length === 0 && codes.act_codes.length === 0) {
      return [];
    }
    // カルテ由来の病名は名称主体でコードが薄い。適応/禁忌照合のため名称→傷病名コードを解決する。
    await enrichClaimDiseaseCodes(feeCalculator, claim);
    const lookupCodes = claimCheckLookupCodes(claim);
    const lookup = await feeCalculator.checkLookup(lookupCodes);
    return buildIndicationReviewIssues(claim, lookup);
  } catch (error) {
    logFeeApiError(error, { stage: "claim_check_indication" });
    return [];
  }
}

// claim.diseases のうちコード未解決のものを、名称から傷病名コードへ寄せる(病名コード化)。
async function enrichClaimDiseaseCodes(feeCalculator, claim) {
  if (typeof feeCalculator.resolveDiseases !== "function") {
    return;
  }
  const diseases = Array.isArray(claim.diseases) ? claim.diseases : [];
  const names = [...new Set(diseases.filter((d) => !d.code && d.name).map((d) => d.name))];
  if (names.length === 0) {
    return;
  }
  const response = await feeCalculator.resolveDiseases({ names });
  const resolved = response?.resolved || {};
  for (const disease of diseases) {
    if (disease.code || !disease.name) {
      continue;
    }
    const hit = resolved[disease.name];
    // exact/partial で得たコードのみ採用(none は未解決のまま=無指摘で安全側)。
    if (hit && hit.code && (hit.matchType === "exact" || hit.matchType === "partial")) {
      disease.code = hit.code;
      disease.suspected = Boolean(disease.suspected) || Boolean(hit.suspected);
    }
  }
}

// ---------------------------------------------------------------------------
// STG限定 売上改善診断(clinic-diagnosis): 既存レセ(UKE/CSV)→点検入力claim→決定論点検レポート
// ---------------------------------------------------------------------------

// レセ電コードの先頭桁で明細種別を判定(6=医薬品IY, 7=特定器材TO, その他=診療行為SI)。
function clinicRecTypeFromCode(code) {
  const head = String(code || "").trim().charAt(0);
  if (head === "6") return { recType: "IY", orderType: "drug" };
  if (head === "7") return { recType: "TO", orderType: "material" };
  return { recType: "SI", orderType: "procedure" };
}

const CLINIC_WAREKI_BASE_YEARS = Object.freeze({ 1: 1867, 2: 1911, 3: 1925, 4: 1988, 5: 2018 });

// 生年月日(和暦GYYMMDD or 西暦YYYYMMDD、空白区切り許容)→請求月1日時点の満年齢。
function clinicAgeYearsFromBirth(birth, claimMonth) {
  const digits = String(birth || "").replace(/\D+/gu, "");
  let year;
  let month;
  let day;
  if (digits.length === 7) {
    const base = CLINIC_WAREKI_BASE_YEARS[Number(digits[0])];
    if (!base) return null;
    year = base + Number(digits.slice(1, 3));
    month = Number(digits.slice(3, 5));
    day = Number(digits.slice(5, 7));
  } else if (digits.length === 8) {
    year = Number(digits.slice(0, 4));
    month = Number(digits.slice(4, 6));
    day = Number(digits.slice(6, 8));
  } else {
    return null;
  }
  const [cy, cm] = String(claimMonth || "").split("-").map(Number);
  if (!cy || !cm || !year || !month || !day) return null;
  // 請求月1日時点で誕生日未到来なら-1
  let age = cy - year;
  if (cm < month || (cm === month && day > 1)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// baselineClaims(UKE/CSV取込結果)を fee-core claim-checks の入力claimへ変換する。
// レセプト種別(4桁)で入院/外来を判定し、DPC(点数表コード3)は点検スコープ外としてスキップ
// (外来出来高前提のルールで誤検知しないため。スキップ数は結果に明示する)。
function clinicCheckClaimsFromBaseline(baselineClaims = [], claimMonth = "") {
  const claims = [];
  let dpcSkippedCount = 0;
  let inpatientCount = 0;
  for (const claim of Array.isArray(baselineClaims) ? baselineClaims : []) {
    const month = String(claim?.claimMonth ?? claim?.claim_month ?? claimMonth ?? "").trim();
    if (claimMonth && month !== claimMonth) {
      continue; // 他月の混入は診断対象外
    }
    const receiptType = String(claim?.receiptType ?? claim?.receipt_type ?? "").trim();
    if (receiptType.charAt(0) === "3") {
      dpcSkippedCount += 1; // DPCは対象外(包括/出来高境界は本診断のスコープ外)
      continue;
    }
    const isInpatient = receiptType.length === 4 && receiptType.charAt(3) === "1";
    if (isInpatient) {
      inpatientCount += 1;
    }
    const rawLines = Array.isArray(claim?.lines) ? claim.lines : [];
    const items = rawLines
      .filter((line) => String(line?.code || "").trim())
      .map((line) => ({
        code: String(line.code).trim(),
        name: String(line.name || "").trim(),
        ...clinicRecTypeFromCode(line.code)
      }));
    const diseases = (Array.isArray(claim?.diseases) ? claim.diseases : []).map((d) => ({
      code: String(d?.code || "").trim(),
      name: String(d?.name || "").trim(),
      suspected: Boolean(d?.suspected)
    }));
    claims.push({
      patientKey: String(claim?.patientId ?? claim?.patient_id ?? "").trim() || "(不明)",
      claimMonth: month,
      sex: String(claim?.sex || "").trim(),
      ageYears: clinicAgeYearsFromBirth(claim?.birthDate ?? claim?.birth_date, month),
      isInpatient,
      items,
      diseases
    });
  }
  return { claims, dpcSkippedCount, inpatientCount };
}

// 点検入力claim群に、病名コード化→点検マスタlookup→決定論点検を回してレポートを作る。
async function buildClinicDiagnosisReportForClaims({ feeCalculator, claims = [] }) {
  for (const claim of claims) {
    try {
      await enrichClaimDiseaseCodes(feeCalculator, claim);
    } catch (error) {
      logFeeApiError(error, { stage: "clinic_diagnosis_resolve_diseases" });
    }
  }
  let lookup = {};
  try {
    if (feeCalculator && typeof feeCalculator.checkLookup === "function") {
      const drugCodes = new Set();
      const actCodes = new Set();
      const diseaseCodes = new Set();
      for (const claim of claims) {
        const codes = claimCheckLookupCodes(claim);
        codes.drug_codes.forEach((code) => drugCodes.add(code));
        codes.act_codes.forEach((code) => actCodes.add(code));
        codes.disease_codes.forEach((code) => diseaseCodes.add(code));
      }
      lookup = await feeCalculator.checkLookup({
        drug_codes: [...drugCodes],
        act_codes: [...actCodes],
        disease_codes: [...diseaseCodes]
      }) || {};
    }
  } catch (error) {
    logFeeApiError(error, { stage: "clinic_diagnosis_check_lookup" });
    lookup = {};
  }
  return buildClinicDiagnosisReport(claims, {
    lookup,
    procedureMeta: lookup.procedureMeta || {}
  });
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
    ...(error ? { error: safeClientErrorSummary(error) } : {}),
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

function buildEndpointStageMetrics(stageTimings = [], startedAt = Date.now(), counts = {}) {
  const stageDurationsMs = {};
  for (const entry of safeStageTimings(stageTimings)) {
    stageDurationsMs[entry.stage] = (stageDurationsMs[entry.stage] || 0) + entry.durationMs;
  }
  return {
    schemaVersion: 1,
    stageDurationsMs,
    totalDurationMs: Math.max(0, Date.now() - startedAt),
    ...Object.fromEntries(
      Object.entries(counts).filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)])
    )
  };
}

function logFeeEndpointPerformance(event, { orgId = "", claimMonth = "", metrics = {} } = {}) {
  console.info(JSON.stringify({
    event,
    orgId,
    claimMonth,
    ...metrics
  }));
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
  const eventsByCodeAndDate = new Map();
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
      if (!code || !isHistoryCountableLine(line, prior?.reviewDecisions)) {
        continue;
      }
      const eventKey = `${code}|${priorDate}`;
      const event = eventsByCodeAndDate.get(eventKey) || {
        procedure_code: code,
        service_date: priorDate,
        quantity: 0
      };
      event.quantity += historyLineQuantity(line);
      eventsByCodeAndDate.set(eventKey, event);
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
      if (serviceDate && isSameBillingWeek(priorDate, serviceDate)) {
        sameWeekCodes.add(code);
      }
    }
  }

  const events = [...eventsByCodeAndDate.values()];
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
function isHistoryCountableLine(line = {}, reviewDecisions = {}) {
  return lineInclusionStatus(line, reviewDecisions) === "included";
}

function historyLineQuantity(line = {}) {
  const quantity = Number(line?.quantity ?? line?.count ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
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

function buildFeeCalculationPerformanceSnapshot({
  env = process.env,
  orgId = "",
  feeSessionId = "",
  feeSession = {},
  calculationResult = {},
  prepared = {},
  stageTimings = [],
  totalDurationMs = 0,
  completedAt = new Date().toISOString()
} = {}) {
  const safeStages = safeStageTimings(stageTimings);
  const prepareStageTimings = safeStageTimings(prepared?.metrics?.stageTimings || []);
  const clinical = prepared?.metrics?.clinicalStructuring || {};
  const ruleBased = prepared?.metrics?.ruleBasedClinicalInference || {};
  const usage = openAiUsageSummary(clinical.usage);
  const shadow = shadowCalculationPerformanceSummary(prepared.shadowCalculations || []);
  const bottleneckStage = bottleneckStageName(safeStages);
  const lineItems = Array.isArray(calculationResult.lineItems) ? calculationResult.lineItems : [];
  const reviewIssues = Array.isArray(calculationResult.reviewIssues) ? calculationResult.reviewIssues : [];
  const warnings = Array.isArray(calculationResult.warnings) ? calculationResult.warnings : [];
  const claimCheckIssueCount = reviewIssues.filter((issue) => issue?.source === "claim_check").length;

  return compactObject({
    schemaVersion: 1,
    source: "fee-api",
    completedAt,
    runtime: compactObject({
      environment: env.HALUNASU_ENV || env.NODE_ENV || null,
      cloudRunService: env.K_SERVICE || null,
      cloudRunRevision: env.K_REVISION || null,
      projectId: env.GOOGLE_CLOUD_PROJECT || null
    }),
    orgId,
    feeSessionId,
    calculationId: calculationResult.calculationId || null,
    status: feeSession.status || null,
    totalPoints: Number(calculationResult.totalPoints || 0),
    totalDurationMs: Number(totalDurationMs || 0),
    bottleneckStage,
    durations: compactObject({
      prepareMs: stageDuration(safeStages, "prepare"),
      savePreparedSessionMs: stageDuration(safeStages, "savePreparedSession"),
      pythonCalculatorMs: stageDuration(safeStages, "pythonCalculator"),
      saveCalculationMs: stageDuration(safeStages, "saveCalculation"),
      auditMs: stageDuration(safeStages, "audit"),
      clinicalCalculationPreparationMs: stageDuration(prepareStageTimings, "clinicalCalculationPreparation"),
      openAiProviderMs: numberOrNull(clinical.openAiProviderDurationMs),
      clinicalFactsConvertMs: numberOrNull(clinical.clinicalFactsConvertDurationMs),
      masterLookupMs: numberOrNull(clinical.masterLookupDurationMs),
      ruleBasedClinicalInferenceMs: numberOrNull(ruleBased.durationMs),
      shadowCalculationPreparationMs: stageDuration(prepareStageTimings, "shadowCalculationPreparation")
    }),
    clinical: compactObject({
      source: clinical.source || null,
      model: clinical.model || null,
      reasoningEffort: clinical.reasoningEffort || null,
      promptVersion: clinical.promptVersion || null,
      ruleSetVersion: clinical.ruleSetVersion || null,
      registryVersion: clinical.registryVersion || null,
      masterVersion: clinical.masterVersion || null,
      checklistVerificationMode: clinical.checklistVerificationMode || null,
      timeoutMs: numberOrNull(clinical.timeoutMs),
      fallbackReasonCode: clinical.fallbackReason ? clinicalFallbackReasonCode(clinical.fallbackReason) : null,
      reusedFromCalculationId: clinical.reusedFromCalculationId || null
    }),
    openAiUsage: usage,
    openAiCache: openAiCacheSummary(usage),
    counts: compactObject({
      lineItemCount: lineItems.length,
      warningCount: warnings.length,
      reviewIssueCount: reviewIssues.length,
      claimCheckIssueCount,
      candidateProposalCount: Array.isArray(calculationResult.candidateProposals) ? calculationResult.candidateProposals.length : null,
      clinicalEventCount: Array.isArray(prepared.clinicalEvents) ? prepared.clinicalEvents.length : null,
      canonicalClinicalFactCount: Array.isArray(prepared.canonicalClinicalFacts) ? prepared.canonicalClinicalFacts.length : null,
      masterCandidateCount: Array.isArray(prepared.masterCandidates) ? prepared.masterCandidates.length : null,
      billingCandidateCount: Array.isArray(prepared.billingCandidates) ? prepared.billingCandidates.length : null,
      prepareReviewWarningCount: Array.isArray(prepared.reviewWarnings) ? prepared.reviewWarnings.length : null
    }),
    stageTimings: safeStages,
    prepareStageTimings,
    shadowCalculations: shadow
  });
}

async function persistFeeCalculationPerformance({
  feeStore,
  orgId,
  feeSessionId,
  calculationJobId = null,
  calculationJobLeaseToken = null,
  feeSession = {},
  performance = {}
} = {}) {
  if (!feeStore || !orgId || !feeSessionId || !isPlainObject(performance)) {
    return null;
  }
  const currentProgress = isPlainObject(feeSession.calculationProgress) ? feeSession.calculationProgress : {};
  const progress = {
    ...currentProgress,
    updatedAt: performance.completedAt || currentProgress.updatedAt || new Date().toISOString(),
    metrics: {
      ...(isPlainObject(currentProgress.metrics) ? currentProgress.metrics : {}),
      performance
    },
    performance
  };
  try {
    if (calculationJobId && typeof feeStore.updateCalculationJob === "function") {
      await feeStore.updateCalculationJob(orgId, feeSessionId, calculationJobId, {
        phase: "complete",
        progress
      }, calculationJobLeaseUpdateOptions(calculationJobLeaseToken));
    }
    let updatedSession = null;
    if (typeof feeStore.updateSession === "function") {
      const result = await feeStore.updateSession(
        orgId,
        feeSessionId,
        { calculationProgress: progress },
        calculationSessionLeaseUpdateOptions(calculationJobId, calculationJobLeaseToken, {
          allowClearedActiveCalculationJob: true
        })
      );
      updatedSession = result?.feeSession || null;
    }
    return { progress, feeSession: updatedSession };
  } catch (error) {
    console.warn(JSON.stringify({
      event: "fee.calculate.performance_persist_failed",
      orgId,
      feeSessionId,
      error: safeLogError(error)
    }));
    return { progress };
  }
}

function safeStageTimings(stageTimings = []) {
  return (Array.isArray(stageTimings) ? stageTimings : [])
    .map((entry) => compactObject({
      stage: String(entry?.stage || "").trim(),
      durationMs: numberOrNull(entry?.durationMs),
      failed: entry?.failed === true ? true : undefined
    }))
    .filter((entry) => entry.stage && entry.durationMs != null);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bottleneckStageName(stageTimings = []) {
  const stages = safeStageTimings(stageTimings);
  if (!stages.length) {
    return null;
  }
  return stages.reduce((max, entry) => (
    Number(entry.durationMs || 0) > Number(max.durationMs || 0) ? entry : max
  ), stages[0]).stage;
}

function openAiUsageSummary(usage = null) {
  if (!isPlainObject(usage)) {
    return null;
  }
  const inputTokens = numberOrNull(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberOrNull(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = numberOrNull(usage.total_tokens);
  const cachedInputTokens = numberOrNull(
    usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
  );
  const reasoningTokens = numberOrNull(
    usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_tokens_details?.reasoning_tokens
  );
  return compactObject({
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cachedInputTokenRatio: inputTokens && cachedInputTokens != null
      ? Number((cachedInputTokens / inputTokens).toFixed(4))
      : null,
    reasoningTokens
  });
}

function openAiCacheSummary(usage = null) {
  if (!isPlainObject(usage)) {
    return null;
  }
  const inputTokens = numberOrNull(usage.inputTokens);
  const cachedInputTokens = numberOrNull(usage.cachedInputTokens);
  return compactObject({
    inputTokens,
    cachedInputTokens,
    cachedInputTokenRatio: usage.cachedInputTokenRatio ?? (
      inputTokens && cachedInputTokens != null ? Number((cachedInputTokens / inputTokens).toFixed(4)) : null
    ),
    cacheHit: Number(cachedInputTokens || 0) > 0
  });
}

function shadowCalculationPerformanceSummary(shadowCalculations = []) {
  return (Array.isArray(shadowCalculations) ? shadowCalculations : []).map((shadow) => compactObject({
    mode: shadow?.mode || null,
    pipeline: shadow?.pipeline || null,
    source: shadow?.source || null,
    status: shadow?.status || null,
    durationMs: numberOrNull(shadow?.durationMs),
    optionDiff: isPlainObject(shadow?.optionDiff)
      ? compactObject({
        primaryCount: numberOrNull(shadow.optionDiff.primaryCount),
        shadowCount: numberOrNull(shadow.optionDiff.shadowCount),
        sharedCount: numberOrNull(shadow.optionDiff.sharedCount),
        onlyInPrimaryCount: Array.isArray(shadow.optionDiff.onlyInPrimary) ? shadow.optionDiff.onlyInPrimary.length : null,
        onlyInShadowCount: Array.isArray(shadow.optionDiff.onlyInShadow) ? shadow.optionDiff.onlyInShadow.length : null
      })
      : null
  }));
}

function clinicalFallbackReasonCode(reason = "") {
  const value = String(reason || "").toLowerCase();
  if (value.includes("quota")) return "openai_quota";
  if (value.includes("timeout")) return "openai_timeout";
  if (value.includes("rate limit") || value.includes("rate_limit")) return "openai_rate_limit";
  if (value.includes("json")) return "openai_json";
  if (value.includes("stream")) return "openai_stream";
  return "openai_other";
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

async function loadMonthlyReceiptForExport({ feeStore, orgId, patientId, claimMonth, now, processEnv = process.env }) {
  const sessionList = await listSessionsForMonthlyView(feeStore, orgId, claimMonth, { processEnv, patientId });
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

function shouldBlockReceiptExport(_url, validation = {}, _exportContext = {}) {
  return Number(validation.blockingIssueCount || 0) > 0;
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
  // 施設基準は有効期間付きの fee設定(facilityStandards)を唯一の算定根拠とする。
  // platform施設のキーは日付を持たない平坦なリストのため、設定が未登録の施設の
  // 移行用フォールバックに限定する(和集合にすると失効済み届出が算定へ混入する)。
  const hasDatedFacilityStandards = Array.isArray(feeSettings?.facilityStandards)
    && feeSettings.facilityStandards.length > 0;
  const effectiveFacilityProfile = {
    ...facilityProfile,
    facilityStandardKeysSource: hasDatedFacilityStandards ? "fee_settings_effective_dated" : facilityProfile.source,
    facilityStandardKeys: hasDatedFacilityStandards
      ? activeFacilityStandardKeysFromFeeSettings(feeSettings, baseSession.serviceDate)
      : uniqueStrings(Array.isArray(facilityProfile.facilityStandardKeys) ? facilityProfile.facilityStandardKeys : [])
  };
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
  const primaryPrepared = applyAutoBillingRulesToPreparation(
    applyFacilityProfileToPreparation(legacy, effectiveFacilityProfile, {
      clinicalText: baseSession.clinicalText || calculationInput.clinicalText || ""
    }),
    {
      feeSettings,
      session: baseSession,
      facilityStandardKeys: effectiveFacilityProfile.facilityStandardKeys,
      hasExplicitClaimContext: isPlainObject(baseSession.claimContext) || isPlainObject(calculationInput.claimContext)
    }
  );
  const shadowCalculations = await measureStage(stageTimings, "shadowCalculationPreparation", () => buildFeeCalculationShadowCalculations({
    input,
    primaryPrepared,
    session: baseSession,
    calculationInput,
    feeCalculator,
    facilityProfile: effectiveFacilityProfile,
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

// fee設定の施設基準届出のうち、算定日に有効なもののキーを返す。
function activeFacilityStandardKeysFromFeeSettings(feeSettings = {}, serviceDate = "") {
  const standards = Array.isArray(feeSettings?.facilityStandards) ? feeSettings.facilityStandards : [];
  const date = String(serviceDate || "").slice(0, 10);
  return standards
    .filter((entry) => {
      if (!entry || String(entry.status || "active") !== "active" || !entry.key) {
        return false;
      }
      const from = String(entry.claimStartDate || "");
      const to = String(entry.effectiveTo || "");
      if (date && from && from > date) {
        return false;
      }
      if (date && to && to < date) {
        return false;
      }
      return true;
    })
    .map((entry) => String(entry.key));
}

// 施設の恒常算定ルール(「この施設では条件を満たす受診に必ずXを算定/候補提示」)を適用する。
// confirm: 算定入力の procedure_codes へ追加 → エンジンがマスタ照合し、背反・回数等の
// 電子点数表チェックも通常どおり適用される。candidate: 承認待ち候補として提示。
// claimContext指定(リプレイ/契約)の算定には適用しない。
function applyAutoBillingRulesToPreparation(prepared = {}, {
  feeSettings = {},
  session = {},
  facilityStandardKeys = [],
  hasExplicitClaimContext = false
} = {}) {
  const rules = Array.isArray(feeSettings?.autoBillingRules) ? feeSettings.autoBillingRules : [];
  if (!rules.length || hasExplicitClaimContext) {
    return prepared;
  }
  const setting = String(session.setting || "outpatient");
  const keys = new Set((facilityStandardKeys || []).map((key) => String(key || "")).filter(Boolean));
  const applied = [];
  const unresolvedVariants = [];
  const confirmCodes = [];
  const confirmWarnings = [];
  const candidateProposals = [];
  for (const rule of rules) {
    if (!rule?.code || String(rule.status || "active") !== "active") {
      continue;
    }
    if (Array.isArray(rule.settings) && rule.settings.length && !rule.settings.includes(setting)) {
      continue;
    }
    if (rule.requiredFacilityStandardKey && !keys.has(rule.requiredFacilityStandardKey)) {
      continue;
    }
    const hasSameBuildingVariant = Boolean(String(rule.sameBuildingCode || "").trim());
    const sameBuilding = typeof session.encounterDetails?.sameBuilding === "boolean"
      ? session.encounterDetails.sameBuilding
      : null;
    if (hasSameBuildingVariant && sameBuilding === null) {
      unresolvedVariants.push({
        ruleId: rule.ruleId,
        outsideCode: String(rule.code),
        sameBuildingCode: String(rule.sameBuildingCode),
        action: rule.action
      });
      continue;
    }
    const selectedCode = hasSameBuildingVariant && sameBuilding === true
      ? String(rule.sameBuildingCode)
      : String(rule.code);
    const selectedTitle = hasSameBuildingVariant && sameBuilding === true
      ? String(rule.sameBuildingTitle || rule.title || selectedCode)
      : String(rule.title || selectedCode);
    applied.push({
      ruleId: rule.ruleId,
      code: selectedCode,
      action: rule.action,
      sameBuilding,
      variant: hasSameBuildingVariant ? (sameBuilding ? "same_building" : "outside_same_building") : "default"
    });
    if (rule.action === "confirm") {
      confirmCodes.push(selectedCode);
      confirmWarnings.push(
        `施設恒常算定ルール: ${selectedTitle}(${selectedCode})を施設設定に基づき算定へ自動追加しました。今回の受診での実施事実と算定要件を確認してください。`
      );
    } else {
      candidateProposals.push({
        proposalId: `facility_rule_${rule.ruleId}_${selectedCode}`,
        ruleId: `facility_rule_${rule.ruleId}`,
        title: selectedTitle ? `${selectedTitle}の算定確認` : `施設ルール候補 ${selectedCode}`,
        reason: rule.note || "施設の恒常算定ルールにより候補提示しています。実施事実と算定要件を確認してください。",
        conditionText: "施設設定に基づく候補です。今回の受診で要件を満たす場合に採用してください。",
        basis: "facility_auto_billing_rule",
        code: selectedCode,
        potentialPoints: Number(rule.potentialPoints || 0),
        orderType: "procedure",
        source: "facility_auto_billing_rule"
      });
    }
  }
  if (!applied.length && !unresolvedVariants.length) {
    return prepared;
  }
  const unresolvedWarnings = unresolvedVariants.length
    ? [
      "同一建物区分が未確定です。同一日に同一建物で複数患者を診療した場合は同一建物居住者の区分になります。区分を選択して再計算してください。同一建物区分に依存する明細は合計に含めていません。"
    ]
    : [];
  const currentOptions = isPlainObject(prepared.calculationOptions) ? prepared.calculationOptions : {};
  const calculationOptions = confirmCodes.length
    ? {
      ...currentOptions,
      procedure_codes: uniqueStrings([
        ...(Array.isArray(currentOptions.procedure_codes) ? currentOptions.procedure_codes : []),
        ...confirmCodes
      ])
    }
    : currentOptions;
  return {
    ...prepared,
    calculationOptions,
    calculationOptionsAutoKeys: uniqueStrings([
      ...(Array.isArray(prepared.calculationOptionsAutoKeys) ? prepared.calculationOptionsAutoKeys : []),
      ...(confirmCodes.length ? ["procedure_codes"] : [])
    ]),
    candidateProposals: [
      ...(Array.isArray(prepared.candidateProposals) ? prepared.candidateProposals : []),
      ...candidateProposals
    ],
    // confirmで自動追加した明細は、確認画面で出所が分かるよう警告として明示する。
    reviewWarnings: [
      ...(Array.isArray(prepared.reviewWarnings) ? prepared.reviewWarnings : []),
      ...confirmWarnings,
      ...unresolvedWarnings
    ],
    clinicalExtraction: appendClinicalExtractionTrace(
      prepared.clinicalExtraction,
      autoBillingRuleTraceEvents(applied, unresolvedVariants, session.encounterDetails)
    ),
    metrics: {
      ...(prepared.metrics || {}),
      autoBillingRules: {
        appliedCount: applied.length,
        applied,
        unresolvedVariantCount: unresolvedVariants.length,
        unresolvedVariants,
        encounterDetails: session.encounterDetails || null
      }
    }
  };
}

function autoBillingRuleTraceEvents(applied = [], unresolvedVariants = [], encounterDetails = null) {
  return [
    ...applied.map((entry) => ({
      traceId: `trace_auto_billing_rule_${entry.ruleId}_${entry.code}`,
      stage: "facility_auto_billing_rule",
      outcome: "applied",
      ruleId: entry.ruleId,
      selectedCode: entry.code,
      action: entry.action,
      variant: entry.variant,
      encounterDetails: encounterDetails || null
    })),
    ...unresolvedVariants.map((entry) => ({
      traceId: `trace_auto_billing_rule_${entry.ruleId}_same_building_unresolved`,
      stage: "facility_auto_billing_rule",
      outcome: "needs_review",
      ruleId: entry.ruleId,
      candidateCodes: [entry.outsideCode, entry.sameBuildingCode],
      reason: "same_building_unknown",
      encounterDetails: encounterDetails || null
    }))
  ];
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
    encounterDetails: session.encounterDetails || null,
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

export function selectMasterItemForOrder(items = [], type, query) {
  if (!Array.isArray(items)) {
    return null;
  }
  const expectedKind = type === "drug" ? "drug" : type === "material" ? "material" : "procedure";
  // 不変条件: 確定オーダーへの自動採用にフォールバック(近似召回)由来は使わない。
  // includes等の部分一致より先に、入口で除外する(正規化完全一致も例外にしない)。
  const candidates = items.filter((item) => item && item.kind === expectedKind && item.code && !item.matchOrigin);
  if (!candidates.length) {
    return null;
  }
  const normalizedQuery = normalizeMasterMatchText(query);
  const matched = candidates.find((item) => normalizeMasterMatchText(item.name) === normalizedQuery)
    || candidates.find((item) => normalizeMasterMatchText(item.baseName) === normalizedQuery)
    || candidates.find((item) => normalizeMasterMatchText(item.name).includes(normalizedQuery))
    || candidates.find((item) => normalizeMasterMatchText(item.baseName).includes(normalizedQuery));
  if (matched) {
    return matched;
  }
  return candidates[0];
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
  // 抽出契約系の警告はカルテ行本文を引用するため、引用内の「初診」「再診」等が
  // visit系キーに誤マッチして他の警告を飲み込む。先頭で専用キーにする。
  if (/^(抽出契約違反|抽出漏れの可能性)/u.test(text)) {
    return `extraction_contract:${text.replace(/\s+/gu, "").slice(0, 120)}`;
  }
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

function isSameBillingWeek(left = "", right = "") {
  const leftDate = parseIsoDate(left);
  const rightDate = parseIsoDate(right);
  if (!leftDate || !rightDate) {
    return false;
  }
  const leftSunday = billingWeekSunday(leftDate);
  const rightSunday = billingWeekSunday(rightDate);
  return leftSunday.getTime() === rightSunday.getTime();
}

// 厚労省の診療報酬上の「週」は日曜日から土曜日までを単位とする。
// https://www.mhlw.go.jp/web/t_doc?dataId=00tc4894&dataType=1&pageNo=1
function billingWeekSunday(date) {
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  normalized.setUTCDate(normalized.getUTCDate() - normalized.getUTCDay());
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

// 5xx はサーバ内部/下流(Python算定エンジン等)の失敗であり、error.message には
// スタックトレース・内部パス・入力データ片(PHI)が混入しうる。クライアントには固定文言だけを返し、
// 詳細は logFeeApiError 経由でサーバログにのみ残す。4xx は意図的な検証/権限メッセージなので保持する。
const SERVER_ERROR_MESSAGES = Object.freeze({
  502: "算定処理でエラーが発生しました。時間をおいて再度お試しください。",
  503: "現在この機能を利用できません。時間をおいて再度お試しください。",
  504: "算定処理がタイムアウトしました。時間をおいて再度お試しください。"
});

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const isServerError = statusCode >= 500;
  return {
    statusCode,
    body: {
      error: isServerError
        ? serverErrorCode(statusCode)
        : (publicAuthErrorCode(error) || toErrorCode(error.name)),
      message: isServerError
        ? (SERVER_ERROR_MESSAGES[statusCode] || "サーバでエラーが発生しました。時間をおいて再度お試しください。")
        : error.message,
      field: isServerError ? undefined : error.field
    }
  };
}

function serverErrorCode(statusCode) {
  if (statusCode === 502) return "upstream_error";
  if (statusCode === 503) return "service_unavailable";
  if (statusCode === 504) return "upstream_timeout";
  return "internal_error";
}

// クライアント/永続データに載せてよい安全なメッセージだけを返す。
// 4xx(意図的な検証/権限メッセージ)は保持し、5xx相当(内部/下流失敗)は固定文言に置換する。
function safeClientErrorMessage(error = {}, fallback = "処理でエラーが発生しました。") {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    return SERVER_ERROR_MESSAGES[statusCode] || fallback;
  }
  return error.message || fallback;
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
  if (!origin || !isAllowedOrigin(origin, input.env, input)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-csrf-token, x-sidecar-code-verifier",
    "vary": "Origin"
  };
}

function isAllowedOrigin(origin, env, input = {}) {
  const pathname = new URL(input.path || "/", "http://localhost").pathname;
  if (pathname.startsWith("/v1/integrations/sidecar/")) {
    const extensionId = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1] || "";
    if (extensionId && sidecarAllowedExtensionIds(input).includes(extensionId)) {
      return true;
    }
  }
  if (defaultAllowedWebOrigins().includes(origin) || configuredAllowedWebOrigins().includes(origin)) {
    return true;
  }
  // Netlify のデプロイプレビュー(ブランチ/PRごとの一時URL)と localhost は保護が緩いため、
  // 本番(prod)では正当オリジンとして受け入れない。非本番(stg/local/test 等)でのみ許可する。
  if (!allowsPreviewAndLocalOrigins(env)) {
    return false;
  }
  return /^https:\/\/[a-z0-9-]+--halunasu-[a-z0-9-]+\.netlify\.app$/.test(origin)
    || /^http:\/\/localhost(:\d+)?$/.test(origin)
    || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
}

function allowsPreviewAndLocalOrigins(env) {
  const value = String(env || "").trim().toLowerCase();
  return value !== "prod" && value !== "production";
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

// サーバログ専用。生の error.message(スタックトレース/内部パス/入力データ片を含みうる)まで残す。
function safeLogError(error) {
  return [
    error?.name || "Error",
    error?.safeProviderMessage || error?.code || error?.message || ""
  ].map((value) => String(value || "").trim()).filter(Boolean).join(": ").slice(0, 240);
}

// クライアントに返す calculationProgress.error 用。5xx相当では生の message を出さず、
// name とプロバイダ安全メッセージ/コードのみに絞る(PHI・内部情報の露出防止)。
function safeClientErrorSummary(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const detail = statusCode >= 500
    ? (error?.safeProviderMessage || error?.code || "")
    : (error?.safeProviderMessage || error?.code || error?.message || "");
  return [error?.name || "Error", detail]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(": ")
    .slice(0, 240);
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

function sidecarDraftListOptionsFromUrl(url) {
  const lifecycleStatus = String(url.searchParams.get("status") || "draft").trim().toLowerCase();
  if (!["draft", "adopted", "all"].includes(lifecycleStatus)) {
    throw requestValidationError("status must be draft, adopted, or all");
  }
  return {
    page: parsePositiveInteger(url.searchParams.get("page"), 1),
    pageSize: parsePositiveInteger(url.searchParams.get("pageSize"), 20, 50),
    lifecycleStatus
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
    activeCalculationJobId: session.activeCalculationJobId || null,
    latestCalculationJobId: session.latestCalculationJobId || null,
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
