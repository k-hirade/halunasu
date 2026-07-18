import http from "node:http";
import {
  forbiddenError,
  hasProductAccess,
  publicAuthErrorCode,
  requirePlatformCsrf,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  validateDraftAiInput,
  validateFeeLinkageInput,
  validateReferralAttachmentInput,
  validateCreateReferralDraftInput,
  validateCreateReferralPatientInput,
  validateReferralImportInput,
  validateReplyLetterInput,
  validateUpsertRecipientDirectoryInput,
  validateUpsertReferralTemplateInput
} from "../../../packages/referral-contracts/src/index.js";
import {
  departmentSnapshot,
  facilitySnapshot,
  memberSnapshot,
  patientSnapshot
} from "../../../packages/platform-contracts/src/index.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import { createReferralStoreFromEnv } from "./store/create-store.js";

const PRODUCT_ID = "referral";
const READ_ROLES = ["admin", "doctor", "nurse", "medical_clerk", "viewer"];
const WRITE_ROLES = ["admin", "doctor", "nurse", "medical_clerk"];
const FINALIZE_ROLES = ["admin", "doctor"];
const FINAL_REFERRAL_STATUSES = new Set(["ready", "document_ready", "sent"]);

export function createReferralApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const platformStore = options.platformStore || createPlatformStoreFromEnv();
  const referralStore = options.referralStore || createReferralStoreFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handleReferralApiRequest({
        method: req.method,
        path: req.url,
        body,
        headers: req.headers,
        env,
        projectId,
        region,
        startedAt,
        platformStore,
        referralStore,
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

export async function handleReferralApiRequest(input = {}) {
  try {
    return withCors(input, await routeReferralApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routeReferralApiRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const platformStore = input.platformStore || createPlatformStoreFromEnv();
  const referralStore = input.referralStore || createReferralStoreFromEnv();

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "referral-api" });
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return ok({
      status: "ok",
      service: "referral-api",
      env: input.env || "local",
      projectId: input.projectId || "medical-core-stg",
      region: input.region || "asia-northeast1",
      startedAt: input.startedAt instanceof Date
        ? input.startedAt.toISOString()
        : new Date().toISOString()
    });
  }

  if (method === "OPTIONS" && url.pathname.startsWith("/v1/referral/")) {
    return noContent();
  }

  if (!url.pathname.startsWith("/v1/referral/")) {
    return notFound("Route not found");
  }

  const context = await requireReferralContext(input, platformStore);

  if (method === "GET" && matches(parts, ["v1", "referral", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "bootstrap"])) {
    const [patients, facilities, departments, referrals, recipients, templates] = await Promise.all([
      platformStore.listPatients(context.session.orgId),
      platformStore.listFacilities(context.session.orgId),
      platformStore.listDepartments(context.session.orgId),
      referralStore.listReferrals(context.session.orgId),
      referralStore.listRecipientDirectory(context.session.orgId),
      referralStore.listReferralTemplates(context.session.orgId)
    ]);
    return ok({
      patients,
      facilities,
      departments,
      referrals,
      recipients,
      templates
    });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "patients"])) {
    return ok({ patients: await platformStore.listPatients(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "referral", "patients"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const patient = await platformStore.createPatient(
      context.session.orgId,
      validateCreateReferralPatientInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.patient_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patient.patientId,
      productId: PRODUCT_ID,
      safePayload: { patientId: patient.patientId }
    });
    return created({ patient });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "facilities"])) {
    return ok({ facilities: await platformStore.listFacilities(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "departments"])) {
    return ok({ departments: await platformStore.listDepartments(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "referrals"])) {
    return ok({ referrals: await referralStore.listReferrals(context.session.orgId) });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "recipient-directory"])) {
    return ok({ recipients: await referralStore.listRecipientDirectory(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "referral", "recipient-directory"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const recipient = await referralStore.upsertRecipientDirectory(
      context.session.orgId,
      validateUpsertRecipientDirectoryInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.recipient_upserted",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "recipient",
      targetId: recipient.recipientId,
      productId: PRODUCT_ID,
      safePayload: { recipientId: recipient.recipientId }
    });
    return created({ recipient });
  }

  if (method === "PATCH" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "referral", "recipient-directory"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const recipient = await referralStore.upsertRecipientDirectory(
      context.session.orgId,
      validateUpsertRecipientDirectoryInput({
        ...(input.body || {}),
        recipientId: parts[3]
      })
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.recipient_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "recipient",
      targetId: recipient.recipientId,
      productId: PRODUCT_ID,
      safePayload: { recipientId: recipient.recipientId }
    });
    return ok({ recipient });
  }

  if (method === "GET" && matches(parts, ["v1", "referral", "templates"])) {
    return ok({ templates: await referralStore.listReferralTemplates(context.session.orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "referral", "templates"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const template = await referralStore.upsertReferralTemplate(
      context.session.orgId,
      validateUpsertReferralTemplateInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.template_upserted",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral_template",
      targetId: template.templateId,
      productId: PRODUCT_ID,
      safePayload: { templateId: template.templateId }
    });
    return created({ template });
  }

  if (method === "PATCH" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "referral", "templates"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const template = await referralStore.upsertReferralTemplate(
      context.session.orgId,
      validateUpsertReferralTemplateInput({
        ...(input.body || {}),
        templateId: parts[3]
      })
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.template_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral_template",
      targetId: template.templateId,
      productId: PRODUCT_ID,
      safePayload: { templateId: template.templateId }
    });
    return ok({ template });
  }

  if (method === "POST" && matches(parts, ["v1", "referral", "referrals"])) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const normalized = validateCreateReferralDraftInput(input.body || {});
    const resolved = await resolveReferralReferences(context, platformStore, normalized, input.now);
    const referral = await referralStore.createReferral({
      ...normalized,
      ...resolved,
      orgId: context.session.orgId
    });
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.draft_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: {
        referralId: referral.referralId,
        patientId: referral.patientId,
        facilityId: referral.facilityId,
        departmentId: referral.departmentId,
        authorMemberId: referral.authorMemberId
      }
    });

    return created({ referral });
  }

  if (method === "POST" && isReferralAction(parts, "imports")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const referral = await referralStore.createReferralImport(
      context.session.orgId,
      parts[3],
      validateReferralImportInput(input.body || {}),
      { memberId: context.session.memberId }
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.import_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: {
        referralId: referral.referralId,
        sourceProduct: input.body?.sourceProduct || input.body?.source_product,
        sourceType: input.body?.sourceType || input.body?.source_type,
        sourceId: input.body?.sourceId || input.body?.source_id
      }
    });
    return created({ referral });
  }

  if (method === "POST" && isReferralAction(parts, "draft-ai")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await referralStore.draftReferralWithAssistant(
      context.session.orgId,
      parts[3],
      validateDraftAiInput(input.body || {})
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.draft_assistant_applied",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: result.referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: result.referral.referralId, provider: result.suggestion.provider }
    });
    return ok(result);
  }

  if (method === "POST" && isReferralAction(parts, "validate")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const referral = await referralStore.validateReferral(context.session.orgId, parts[3]);
    return ok({ referral, reviewChecklist: referral.reviewChecklist || [] });
  }

  if (method === "POST" && isReferralAction(parts, "attachments")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const referral = await referralStore.addReferralAttachment(
      context.session.orgId,
      parts[3],
      validateReferralAttachmentInput(input.body || {}),
      { memberId: context.session.memberId }
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.attachment_added",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: referral.referralId }
    });
    return created({ referral });
  }

  if (method === "POST" && isReferralAction(parts, "replies")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const referral = await referralStore.addReplyLetter(
      context.session.orgId,
      parts[3],
      validateReplyLetterInput(input.body || {}),
      { memberId: context.session.memberId }
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.reply_added",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: referral.referralId }
    });
    return created({ referral });
  }

  if (method === "POST" && isReferralAction(parts, "fee-linkage")) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const referral = await referralStore.updateFeeLinkage(
      context.session.orgId,
      parts[3],
      validateFeeLinkageInput(input.body || {}),
      { memberId: context.session.memberId }
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.fee_linkage_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: referral.referralId, status: referral.feeLinkage?.status }
    });
    return ok({ referral });
  }

  if (method === "POST" && isReferralAction(parts, "finalize")) {
    requireFinalizeAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const authorMember = await requireMember(context, platformStore, context.session.memberId);
    const referral = await referralStore.finalizeReferral(
      context.session.orgId,
      parts[3],
      input.body || {},
      {
        memberId: context.session.memberId,
        memberSnapshot: memberSnapshot(authorMember, input.now || new Date())
      }
    );
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.finalized",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: referral.referralId, status: referral.status }
    });
    return ok({ referral });
  }

  if (method === "GET" && isReferralDocument(parts)) {
    const referral = await referralStore.getReferral(context.session.orgId, parts[3]);
    if (!referral) {
      return notFound("referral not found");
    }

    return ok({ referral });
  }

  if (method === "PATCH" && isReferralDocument(parts)) {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    assertNonFinalStatusPatch(input.body || {});
    const patch = await resolvePatchReferences(context, platformStore, input.body || {}, input.now);
    const referral = await referralStore.updateReferral(context.session.orgId, parts[3], patch);
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.draft_updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: referral.referralId,
      productId: PRODUCT_ID,
      safePayload: { referralId: referral.referralId }
    });

    return ok({ referral });
  }

  if (method === "POST" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "referral", "referrals"]) && parts[4] === "document") {
    requireWriteAccess(context);
    requirePlatformCsrf(input.headers || {}, context.session);
    const result = await referralStore.createReferralDocument(context.session.orgId, parts[3], input.body || {});
    await platformStore.createAuditEvent(context.session.orgId, {
      eventType: "referral.document_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "referral",
      targetId: result.referral.referralId,
      productId: PRODUCT_ID,
      safePayload: {
        referralId: result.referral.referralId,
        documentArtifactId: result.documentArtifact.documentArtifactId,
        provider: result.documentArtifact.provider
      }
    });

    return created(result);
  }

  return notFound("Route not found");
}

async function requireReferralContext(input, platformStore) {
  return requireProductContext(input, {
    platformStore,
    productId: PRODUCT_ID,
    productLabel: "Referral",
    allowedProductRoles: READ_ROLES
  });
}

function requireWriteAccess(context) {
  const allowed = hasProductAccess(context.session, PRODUCT_ID, WRITE_ROLES);
  if (!allowed) {
    throw forbiddenError("Referral write access is required");
  }
}

function requireFinalizeAccess(context) {
  const allowed = hasProductAccess(context.session, PRODUCT_ID, FINALIZE_ROLES);
  if (!allowed) {
    throw forbiddenError("Referral doctor finalize access is required");
  }
}

function assertNonFinalStatusPatch(input = {}) {
  if (FINAL_REFERRAL_STATUSES.has(input.status)) {
    const error = new Error("Use the finalize endpoint to set a final referral status");
    error.name = "BadRequestError";
    error.statusCode = 400;
    error.field = "status";
    throw error;
  }
}

async function resolveReferralReferences(context, platformStore, input, now) {
  const [patient, facility, department, authorMember] = await Promise.all([
    requirePatient(context, platformStore, input.patientId),
    requireFacility(context, platformStore, input.facilityId),
    requireDepartment(context, platformStore, input.departmentId),
    requireMember(context, platformStore, input.authorMemberId || context.session.memberId)
  ]);
  const snapshotAt = now || new Date();

  return {
    patientId: patient.patientId,
    patientSnapshot: patientSnapshot(patient, snapshotAt),
    facilityId: facility.facilityId,
    facilitySnapshot: facilitySnapshot(facility, snapshotAt),
    departmentId: department.departmentId,
    departmentSnapshot: departmentSnapshot(department, snapshotAt),
    authorMemberId: authorMember.memberId,
    authorMemberSnapshot: memberSnapshot(authorMember, snapshotAt)
  };
}

async function resolvePatchReferences(context, platformStore, input, now) {
  const snapshotAt = now || new Date();
  const patch = { ...input };

  if (input.facilityId || input.facility_id) {
    const facility = await requireFacility(context, platformStore, input.facilityId || input.facility_id);
    patch.facilityId = facility.facilityId;
    patch.facilitySnapshot = facilitySnapshot(facility, snapshotAt);
  }
  if (input.departmentId || input.department_id) {
    const department = await requireDepartment(context, platformStore, input.departmentId || input.department_id);
    patch.departmentId = department.departmentId;
    patch.departmentSnapshot = departmentSnapshot(department, snapshotAt);
  }
  if (input.authorMemberId || input.author_member_id) {
    const authorMember = await requireMember(context, platformStore, input.authorMemberId || input.author_member_id);
    patch.authorMemberId = authorMember.memberId;
    patch.authorMemberSnapshot = memberSnapshot(authorMember, snapshotAt);
  }

  return patch;
}

async function requirePatient(context, platformStore, patientId) {
  const patient = await platformStore.getPatient(context.session.orgId, patientId);
  if (!patient || patient.status !== "active") {
    throw notFoundError("patient not found");
  }

  return patient;
}

async function requireFacility(context, platformStore, facilityId) {
  const facility = await platformStore.getFacility(context.session.orgId, facilityId);
  if (!facility || facility.status !== "active") {
    throw notFoundError("facility not found");
  }

  return facility;
}

async function requireDepartment(context, platformStore, departmentId) {
  const department = await platformStore.getDepartment(context.session.orgId, departmentId);
  if (!department || department.status !== "active") {
    throw notFoundError("department not found");
  }

  return department;
}

async function requireMember(context, platformStore, memberId) {
  const member = await platformStore.getMember(context.session.orgId, memberId);
  if (!member || member.status !== "active") {
    throw notFoundError("member not found");
  }

  return member;
}

function contextView(context) {
  return {
    orgId: context.session.orgId,
    memberId: context.session.memberId,
    organizationCode: context.session.organizationCode,
    loginId: context.session.loginId,
    globalRoles: context.session.globalRoles || [],
    productRoles: context.session.productRoles || {},
    referralEntitlement: context.entitlement
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

function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  return {
    statusCode,
    body: {
      error: statusCode === 500
        ? "internal_error"
        : (publicAuthErrorCode(error) || toErrorCode(error.name)),
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field,
      reviewChecklist: error.reviewChecklist
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

function isReferralDocument(parts) {
  return parts.length === 4 && matches(parts.slice(0, 3), ["v1", "referral", "referrals"]);
}

function isReferralAction(parts, action) {
  return parts.length === 5 && matches(parts.slice(0, 3), ["v1", "referral", "referrals"]) && parts[4] === action;
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
  const port = Number(process.env.REFERRAL_API_PORT || process.env.PORT || 8085);
  createReferralApiServer().listen(port, () => {
    console.log(`referral-api listening on :${port}`);
  });
}
