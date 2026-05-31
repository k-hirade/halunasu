import http from "node:http";
import QRCode from "qrcode";
import {
  normalizeOrganizationCode,
  validateLoginInput
} from "../../../packages/platform-contracts/src/index.js";
import { createOtpAuthUrl, generateMfaSecret, verifyTotpCode } from "./auth/mfa.js";
import { verifyPassword } from "./auth/password.js";
import {
  buildCheckoutLineItemsForEntitlement,
  getBillingCatalog,
  getBillingProduct
} from "./billing/catalog.js";
import { createStripeBillingClientFromEnv } from "./billing/stripe-client.js";
import { processStripeWebhookEvent, verifyStripeWebhookSignature } from "./billing/stripe-webhook.js";
import {
  buildPasswordSetupUrl,
  buildSignupVerificationUrl,
  createSignupMailer
} from "./signup-mailer.js";
import {
  clearSessionCookieHeaders,
  createCsrfToken,
  csrfCookieHeader,
  csrfCookieName,
  csrfTokenFromHeaders,
  parseCookies,
  sessionCookieHeader,
  sessionTokenFromHeaders,
  createSignedSession,
  unauthorizedError,
  verifySignedSession
} from "./auth/session.js";
import { createPlatformStoreFromEnv } from "./store/create-store.js";

export function createPlatformApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const store = options.store || createPlatformStoreFromEnv();
  const stripeClient = options.stripeClient || createStripeBillingClientFromEnv();
  const signupMailer = options.signupMailer || createSignupMailer();

  return http.createServer(async (req, res) => {
    try {
      const { body, rawBody } = await readRequestBody(req);
      const response = await handlePlatformApiRequest({
        method: req.method,
        path: req.url,
        body,
        rawBody,
        env,
        projectId,
        region,
        startedAt,
        store,
        stripeClient,
        signupMailer,
        headers: req.headers
      });

      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export function resolvePlatformApiResponse(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/healthz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api"
      }
    };
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api",
        env: input.env || "local",
        projectId: input.projectId || "medical-core-stg",
        region: input.region || "asia-northeast1",
        startedAt: input.startedAt instanceof Date
          ? input.startedAt.toISOString()
          : new Date().toISOString()
      }
    };
  }

  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message: "Route not found"
    }
  };
}

export async function handlePlatformApiRequest(input = {}) {
  try {
    return withCors(input, await routePlatformApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routePlatformApiRequest(input = {}) {
  const healthResponse = resolvePlatformApiResponse(input);
  if (healthResponse.statusCode !== 404 || !String(input.path || "").startsWith("/v1/")) {
    return healthResponse;
  }

  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const store = input.store || createPlatformStoreFromEnv();
  const stripeClient = input.stripeClient || createStripeBillingClientFromEnv();
  const signupMailer = input.signupMailer || createSignupMailer();

  if (method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
    return noContent();
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "login"])) {
    return login(input, store);
  }

  if (method === "GET" && matches(parts, ["v1", "signup", "applications"])) {
    await requirePlatformAdmin(input, store);
    return ok({ signupApplications: await store.listSignupApplications() });
  }

  if (method === "POST" && matches(parts, ["v1", "signup", "applications"])) {
    await consumeSignupRateLimit(input, store);
    const result = await store.createSignupApplicationWithEmailToken(input.body || {});
    const verificationUrl = buildSignupVerificationUrl(input, result.emailVerification?.token);
    const emailDelivery = await signupMailer.sendVerificationMail({
      signupApplication: result.signupApplication,
      verificationUrl,
      expiresAt: result.emailVerification?.expiresAt || null
    });
    return created(signupApplicationCreatedResponse(input, result, emailDelivery, verificationUrl));
  }

  if (method === "GET" && parts.length === 4 && matches(parts.slice(0, 3), ["v1", "signup", "applications"])) {
    await requirePlatformAdmin(input, store);
    const signupApplication = await store.getSignupApplication(parts[3]);
    if (!signupApplication) {
      return notFound("signup application not found");
    }
    return ok({ signupApplication });
  }

  if (method === "POST" && matches(parts, ["v1", "signup", "verify-email"])) {
    const result = await store.verifySignupEmail(input.body || {});
    const passwordSetupUrl = buildPasswordSetupUrl(input, result.passwordSetup?.token);
    const passwordSetupEmailDelivery = await maybeSendPasswordSetupMail({
      signupMailer,
      input,
      result,
      passwordSetupUrl
    });
    return ok({
      ...result,
      passwordSetupEmailDelivery,
      passwordSetupUrl
    });
  }

  if (method === "POST" && matches(parts, ["v1", "signup", "setup-admin-password"])) {
    const result = await store.setupAdminPassword(input.body || {});
    return ok(result);
  }

  if (method === "POST" && matches(parts, ["v1", "stripe", "webhook"])) {
    return handleStripeWebhook(input, store);
  }

  if (method === "GET" && matches(parts, ["v1", "auth", "session"])) {
    const context = await requireSession(input, store);
    return ok({ authenticated: true, session: sessionView(context) });
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "logout"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    await store.revokeMemberSessions(context.identity);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.logout",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    return ok(
      { authenticated: false },
      { "set-cookie": clearSessionCookieHeaders(cookieOptions(input)) }
    );
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "mfa", "enroll"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    requirePrivilegedMember(context.member);

    const secret = generateMfaSecret();
    const otpauthUrl = createOtpAuthUrl({
      accountName: `${context.session.organizationCode}:${context.session.loginId}`,
      secret
    });
    await store.beginMfaEnrollment(context.identity, secret);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.mfa_enrollment_started",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    return created({
      mfa: {
        status: "pending",
        secret,
        otpauthUrl,
        qrCodeDataUrl: await createMfaQrCodeDataUrl(otpauthUrl)
      }
    });
  }

  if (method === "GET" && matches(parts, ["v1", "billing", "status"])) {
    const context = await requireSession(input, store);
    const organization = await store.getOrganization(context.session.orgId);
    if (!organization) {
      return notFound("organization not found");
    }

    return ok({
      billing: organization.billing || null,
      access: organization.access || null,
      stripe: stripeClient.configurationView?.() || { configured: false },
      billingCatalog: publicBillingCatalog(input.env),
      productEntitlements: await safeListProductEntitlements(store, context.session.orgId)
    });
  }

  if (
    method === "POST"
    && parts.length === 5
    && matches(parts.slice(0, 3), ["v1", "billing", "products"])
    && parts[4] === "checkout-session"
  ) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    requireBillingManagementMember(context.member);
    const checkout = await createBillingCheckout({
      input,
      store,
      stripeClient,
      context,
      productId: parts[3],
      source: "core_billing"
    });
    return ok({ billingCheckout: checkout });
  }

  if (method === "POST" && matches(parts, ["v1", "billing", "checkout-session"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    requireBillingManagementMember(context.member);
    const checkout = await createBillingCheckout({
      input,
      store,
      stripeClient,
      context,
      productId: requestedCheckoutProductId(input),
      source: "core_billing"
    });
    return ok({ billingCheckout: checkout });
  }

  if (method === "POST" && matches(parts, ["v1", "billing", "portal-session"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);
    requireBillingManagementMember(context.member);
    const organization = await store.getOrganization(context.session.orgId);
    if (!organization) {
      return notFound("organization not found");
    }
    const customerId = organization.billing?.stripeCustomerId || null;
    if (!customerId) {
      const error = new Error("Stripe customer is not linked to this organization");
      error.name = "ConflictError";
      error.statusCode = 409;
      throw error;
    }
    const returnUrl = billingReturnUrl(input, "portal");
    const session = await stripeClient.createBillingPortalSession({ customerId, returnUrl });
    return ok({ billingPortal: { url: session.url } });
  }

  if (method === "POST" && matches(parts, ["v1", "auth", "mfa", "verify"])) {
    const context = await requireSession(input, store);
    requireCsrf(input, context.session);

    const code = requiredBodyString(input.body, "code");
    const secret = context.identity.mfaPendingSecret || context.identity.mfaSecret;
    if (!secret || !verifyTotpCode(secret, code, { now: input.now })) {
      throw unauthorizedError("Invalid MFA code");
    }

    const updatedIdentity = await store.completeMfaEnrollment(context.identity);
    await store.createAuditEvent(context.session.orgId, {
      eventType: "auth.mfa_verified",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      safePayload: {}
    });

    const sessionResponse = createSessionResponse({
      input,
      identity: updatedIdentity,
      member: context.member,
      organizationCode: context.session.organizationCode,
      mfaVerified: true
    });

    return ok({
      mfa: {
        enrolled: true
      },
      session: sessionResponse.sessionView,
      csrfToken: sessionResponse.csrfToken
    }, sessionResponse.headers);
  }

  if (method === "GET" && matches(parts, ["v1", "organizations"])) {
    await requirePlatformAdmin(input, store);
    return ok({ organizations: await store.listOrganizations() });
  }

  if (method === "POST" && matches(parts, ["v1", "organizations"])) {
    const context = await requirePlatformAdmin(input, store);
    requireCsrf(input, context.session);
    const organization = await store.createOrganization(input.body || {});
    await writeAuditEvent(input, store, organization.orgId, {
      eventType: "organization.created",
      targetType: "organization",
      targetId: organization.orgId,
      safePayload: { orgId: organization.orgId }
    });
    return created({ organization });
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "organizations") {
    await requireOrgRead(input, store, parts[2]);
    const organization = await store.getOrganization(parts[2]);
    if (!organization) {
      return notFound("organization not found");
    }
    return ok({ organization });
  }

  if (method === "PATCH" && parts.length === 3 && parts[0] === "v1" && parts[1] === "organizations") {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const organization = await store.updateOrganization(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "organization.updated",
      targetType: "organization",
      targetId: parts[2],
      safePayload: { changedFields: safeChangedFields(input.body) }
    });
    return ok({ organization });
  }

  if (method === "GET" && isOrgChildCollection(parts, "members")) {
    await requireOrgAdmin(input, store, parts[2]);
    return ok({ members: await store.listMembers(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "members")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const member = await store.createMember(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "member.created",
      targetType: "member",
      targetId: member.memberId,
      safePayload: {
        memberId: member.memberId,
        loginIdentityCreated: input.body?.password !== undefined
      }
    });
    return created({ member });
  }

  if (method === "GET" && isOrgChildDocument(parts, "members")) {
    await requireOrgAdmin(input, store, parts[2]);
    const member = await store.getMember(parts[2], parts[4]);
    if (!member) {
      return notFound("member not found");
    }
    return ok({ member });
  }

  if (method === "POST" && parts.length === 6 && matches(parts.slice(0, 5), ["v1", "organizations", parts[2], "members", parts[4]]) && parts[5] === "mfa-reset") {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const identity = await store.resetMemberMfa(parts[2], parts[4]);
    await writeAuditEvent(input, store, parts[2], {
      eventType: "member.mfa_reset",
      targetType: "member",
      targetId: parts[4],
      safePayload: {
        memberId: parts[4],
        tokenVersion: identity.tokenVersion
      }
    });
    return ok({
      mfa: {
        enrolled: Boolean(identity.mfaEnrolled),
        required: Boolean(identity.mfaRequired)
      }
    });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "members")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const member = await store.updateMember(parts[2], parts[4], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "member.updated",
      targetType: "member",
      targetId: member.memberId,
      safePayload: {
        memberId: member.memberId,
        changedFields: safeChangedFields(input.body, ["password"])
      }
    });
    return ok({ member });
  }

  if (method === "GET" && isOrgChildCollection(parts, "facilities")) {
    await requireOrgRead(input, store, parts[2]);
    return ok({ facilities: await store.listFacilities(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "facilities")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const facility = await store.createFacility(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "facility.created",
      targetType: "facility",
      targetId: facility.facilityId,
      safePayload: { facilityId: facility.facilityId }
    });
    return created({ facility });
  }

  if (method === "GET" && isOrgChildDocument(parts, "facilities")) {
    await requireOrgRead(input, store, parts[2]);
    const facility = await store.getFacility(parts[2], parts[4]);
    if (!facility) {
      return notFound("facility not found");
    }
    return ok({ facility });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "facilities")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const facility = await store.updateFacility(parts[2], parts[4], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "facility.updated",
      targetType: "facility",
      targetId: facility.facilityId,
      safePayload: {
        facilityId: facility.facilityId,
        changedFields: safeChangedFields(input.body)
      }
    });
    return ok({ facility });
  }

  if (method === "GET" && isOrgChildCollection(parts, "departments")) {
    await requireOrgRead(input, store, parts[2]);
    return ok({ departments: await store.listDepartments(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "departments")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const department = await store.createDepartment(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "department.created",
      targetType: "department",
      targetId: department.departmentId,
      safePayload: { departmentId: department.departmentId }
    });
    return created({ department });
  }

  if (method === "GET" && isOrgChildDocument(parts, "departments")) {
    await requireOrgRead(input, store, parts[2]);
    const department = await store.getDepartment(parts[2], parts[4]);
    if (!department) {
      return notFound("department not found");
    }
    return ok({ department });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "departments")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const department = await store.updateDepartment(parts[2], parts[4], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "department.updated",
      targetType: "department",
      targetId: department.departmentId,
      safePayload: {
        departmentId: department.departmentId,
        changedFields: safeChangedFields(input.body)
      }
    });
    return ok({ department });
  }

  if (method === "GET" && isOrgChildCollection(parts, "patients")) {
    await requireOrgRead(input, store, parts[2]);
    return ok({ patients: await store.listPatients(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "patients")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const patient = await store.createPatient(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "patient.created",
      targetType: "patient",
      targetId: patient.patientId,
      safePayload: { patientId: patient.patientId }
    });
    return created({ patient });
  }

  if (method === "GET" && isOrgChildDocument(parts, "patients")) {
    await requireOrgRead(input, store, parts[2]);
    const patient = await store.getPatient(parts[2], parts[4]);
    if (!patient) {
      return notFound("patient not found");
    }
    return ok({ patient });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "patients")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const patient = await store.updatePatient(parts[2], parts[4], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "patient.updated",
      targetType: "patient",
      targetId: patient.patientId,
      safePayload: {
        patientId: patient.patientId,
        changedFields: safeChangedFields(input.body)
      }
    });
    return ok({ patient });
  }

  if (method === "GET" && isOrgChildCollection(parts, "product-entitlements")) {
    await requireBillingAdmin(input, store, parts[2]);
    return ok({ productEntitlements: await store.listProductEntitlements(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "product-entitlements")) {
    const context = await requireBillingAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const productEntitlement = await store.upsertProductEntitlement(parts[2], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "product_entitlement.upserted",
      targetType: "product_entitlement",
      targetId: productEntitlement.productId,
      safePayload: { productId: productEntitlement.productId }
    });
    return created({ productEntitlement });
  }

  if (method === "GET" && isOrgChildDocument(parts, "product-entitlements")) {
    await requireBillingAdmin(input, store, parts[2]);
    const productEntitlement = await store.getProductEntitlement(parts[2], parts[4]);
    if (!productEntitlement) {
      return notFound("product entitlement not found");
    }
    return ok({ productEntitlement });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "product-entitlements")) {
    const context = await requireBillingAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const productEntitlement = await store.updateProductEntitlement(parts[2], parts[4], input.body || {});
    await writeAuditEvent(input, store, parts[2], {
      eventType: "product_entitlement.updated",
      targetType: "product_entitlement",
      targetId: productEntitlement.productId,
      safePayload: {
        productId: productEntitlement.productId,
        changedFields: safeChangedFields(input.body)
      }
    });
    return ok({ productEntitlement });
  }

  if (method === "GET" && isOrgChildCollection(parts, "audit-events")) {
    await requireOrgAdmin(input, store, parts[2]);
    return ok({ auditEvents: await store.listAuditEvents(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "audit-events")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    return created({ auditEvent: await store.createAuditEvent(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "audit-events")) {
    await requireOrgAdmin(input, store, parts[2]);
    const auditEvent = await store.getAuditEvent(parts[2], parts[4]);
    if (!auditEvent) {
      return notFound("audit event not found");
    }
    return ok({ auditEvent });
  }

  if (method === "GET" && isOrgChildCollection(parts, "data-requests")) {
    await requireOrgAdmin(input, store, parts[2]);
    return ok({ dataRequests: await store.listDataRequests(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "data-requests")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const dataRequest = await store.createDataRequest(parts[2], {
      ...input.body,
      requesterMemberId: context.session.memberId
    });
    await store.createAuditEvent(parts[2], {
      eventType: "data_request.created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "data_request",
      targetId: dataRequest.requestId,
      safePayload: {
        dataRequestId: dataRequest.requestId,
        requestType: dataRequest.requestType,
        patientId: dataRequest.subjectPatientId,
        productIds: dataRequest.productIds
      }
    });
    return created({ dataRequest });
  }

  if (method === "GET" && isOrgChildDocument(parts, "data-requests")) {
    await requireOrgAdmin(input, store, parts[2]);
    const dataRequest = await store.getDataRequest(parts[2], parts[4]);
    if (!dataRequest) {
      return notFound("data request not found");
    }
    return ok({ dataRequest });
  }

  if (method === "PATCH" && isOrgChildDocument(parts, "data-requests")) {
    const context = await requireOrgAdmin(input, store, parts[2]);
    requireCsrf(input, context.session);
    const dataRequest = await store.updateDataRequest(parts[2], parts[4], input.body || {});
    await store.createAuditEvent(parts[2], {
      eventType: "data_request.updated",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "data_request",
      targetId: dataRequest.requestId,
      safePayload: {
        dataRequestId: dataRequest.requestId,
        status: dataRequest.status,
        changedFields: safeChangedFields(input.body)
      }
    });
    return ok({ dataRequest });
  }

  return notFound("Route not found");
}

async function login(input, store) {
  const credentials = validateLoginInput(input.body || {});
  await consumeLoginRateLimit(input, store, credentials);
  const identity = await store.getLoginIdentity(credentials.organizationCode, credentials.loginId);
  if (!identity || identity.status !== "active") {
    throw unauthorizedError("Invalid credentials");
  }

  const member = await store.getMember(identity.orgId, identity.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid credentials");
  }

  if (!verifyPassword(credentials.password, identity.passwordHash)) {
    await store.recordLoginFailure(identity);
    await store.createAuditEvent(identity.orgId, {
      eventType: "auth.login_failed",
      actorMemberId: identity.memberId,
      actorLoginId: identity.loginId,
      safePayload: { status: "invalid_password" }
    });
    throw unauthorizedError("Invalid credentials");
  }

  if (identity.mfaRequired && identity.mfaEnrolled) {
    if (!credentials.mfaCode) {
      const error = unauthorizedError("MFA code is required");
      error.code = "mfa_required";
      throw error;
    }

    if (!verifyTotpCode(identity.mfaSecret, credentials.mfaCode, { now: input.now })) {
      await store.recordLoginFailure(identity);
      throw unauthorizedError("Invalid MFA code");
    }
  }

  const refreshedIdentity = await store.recordLoginSuccess(identity);
  await store.createAuditEvent(identity.orgId, {
    eventType: "auth.login_succeeded",
    actorMemberId: identity.memberId,
    actorLoginId: identity.loginId,
    safePayload: { mfaVerified: Boolean(identity.mfaRequired && identity.mfaEnrolled) }
  });

  const sessionResponse = createSessionResponse({
    input,
    identity: refreshedIdentity,
    member,
    organizationCode: credentials.organizationCode,
    mfaVerified: Boolean(identity.mfaRequired && identity.mfaEnrolled)
  });

  return ok({
    session: sessionResponse.sessionView,
    csrfToken: sessionResponse.csrfToken
  }, sessionResponse.headers);
}

async function consumeLoginRateLimit(input, store, credentials) {
  await store.consumeRateLimit(
    rateLimitKey("login", input, credentials.organizationCode, credentials.loginId),
    {
      limit: input.loginRateLimit?.limit || 10,
      windowSeconds: input.loginRateLimit?.windowSeconds || 5 * 60
    }
  );
}

async function consumeSignupRateLimit(input, store) {
  const organizationCode = (() => {
    try {
      return normalizeOrganizationCode(input.body?.organizationCode || "unknown");
    } catch {
      return "unknown";
    }
  })();

  await store.consumeRateLimit(
    rateLimitKey("signup", input, organizationCode),
    {
      limit: input.signupRateLimit?.limit || 3,
      windowSeconds: input.signupRateLimit?.windowSeconds || 60 * 60
    }
  );
}

async function requireSession(input, store) {
  const token = sessionTokenFromHeaders(input.headers || {}, cookieOptions(input));
  const session = verifySignedSession(token, sessionOptions(input));
  const identity = await store.getLoginIdentity(session.organizationCode, session.loginId);

  if (!identity || identity.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  if (Number(identity.tokenVersion) !== Number(session.tokenVersion)) {
    throw unauthorizedError("Session revoked");
  }

  const member = await store.getMember(session.orgId, session.memberId);
  if (!member || member.status !== "active") {
    throw unauthorizedError("Invalid session");
  }

  return { session, identity, member };
}

async function optionalSession(input, store) {
  try {
    return await requireSession(input, store);
  } catch {
    return null;
  }
}

async function requirePlatformAdmin(input, store) {
  const context = await requireSession(input, store);
  if (!hasGlobalRole(context.member, "platform_admin")) {
    throw forbiddenError("Platform admin role is required");
  }

  return context;
}

async function requireOrgRead(input, store, orgId) {
  const context = await requireSession(input, store);
  if (hasGlobalRole(context.member, "platform_admin")) {
    return context;
  }
  if (context.session.orgId !== orgId) {
    throw forbiddenError("Organization access is required");
  }

  return context;
}

async function requireOrgAdmin(input, store, orgId) {
  const context = await requireOrgRead(input, store, orgId);
  if (hasGlobalRole(context.member, "platform_admin") || hasGlobalRole(context.member, "org_admin")) {
    return context;
  }

  throw forbiddenError("Organization admin role is required");
}

async function requireBillingAdmin(input, store, orgId) {
  const context = await requireOrgRead(input, store, orgId);
  if (
    hasGlobalRole(context.member, "platform_admin")
    || hasGlobalRole(context.member, "org_admin")
    || hasGlobalRole(context.member, "billing_admin")
  ) {
    return context;
  }

  throw forbiddenError("Billing admin role is required");
}

async function writeAuditEvent(input, store, orgId, event) {
  const context = await optionalSession(input, store);

  return store.createAuditEvent(orgId, {
    ...event,
    actorMemberId: event.actorMemberId || context?.session.memberId,
    actorLoginId: event.actorLoginId || context?.session.loginId
  });
}

function requireCsrf(input, session) {
  const headerToken = csrfTokenFromHeaders(input.headers || {});
  const cookieToken = parseCookies(headerValue(input.headers || {}, "cookie"))[csrfCookieName(cookieOptions(input))];

  if (!headerToken || !cookieToken || headerToken !== session.csrfToken || cookieToken !== session.csrfToken) {
    const error = new Error("CSRF token mismatch");
    error.name = "ForbiddenError";
    error.statusCode = 403;
    throw error;
  }
}

function requirePrivilegedMember(member) {
  if (
    member.globalRoles.includes("org_admin")
    || member.globalRoles.includes("billing_admin")
    || member.globalRoles.includes("platform_admin")
  ) {
    return;
  }

  const error = new Error("Privileged member role is required");
  error.name = "ForbiddenError";
  error.statusCode = 403;
  throw error;
}

function requireBillingManagementMember(member) {
  if (
    member.globalRoles.includes("platform_admin")
    || member.globalRoles.includes("org_admin")
    || member.globalRoles.includes("billing_admin")
  ) {
    return;
  }

  const error = new Error("Billing management role is required");
  error.name = "ForbiddenError";
  error.statusCode = 403;
  throw error;
}

function hasGlobalRole(member, role) {
  return (member.globalRoles || []).includes(role);
}

function forbiddenError(message = "Forbidden") {
  const error = new Error(message);
  error.name = "ForbiddenError";
  error.statusCode = 403;
  return error;
}

function createSessionResponse({ input, identity, member, organizationCode, mfaVerified }) {
  const csrfToken = createCsrfToken();
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: member.globalRoles,
    productRoles: member.productRoles,
    mfaVerified,
    csrfToken
  }, sessionOptions(input));

  return {
    csrfToken,
    sessionView: publicSessionView(session),
    headers: {
      "set-cookie": [
        sessionCookieHeader(token, cookieOptions(input)),
        csrfCookieHeader(csrfToken, cookieOptions(input))
      ]
    }
  };
}

function sessionView(context) {
  return publicSessionView(context.session);
}

function publicSessionView(session) {
  return {
    orgId: session.orgId,
    memberId: session.memberId,
    organizationCode: session.organizationCode,
    loginId: session.loginId,
    globalRoles: session.globalRoles || [],
    productRoles: session.productRoles || {},
    mfaVerified: Boolean(session.mfaVerified),
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt
  };
}

async function createMfaQrCodeDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240
  });
}

async function createBillingCheckout({ input, store, stripeClient, context, productId = "charting", source }) {
  if (!stripeClient?.isConfigured?.()) {
    const error = new Error("Stripe checkout is not configured");
    error.name = "StripeConfigurationError";
    error.statusCode = 503;
    throw error;
  }

  const organization = await store.getOrganization(context.session.orgId);
  if (!organization) {
    const error = new Error("organization not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  const product = getBillingProduct(productId, input.env);
  if (!product || product.status !== "sellable") {
    const error = new Error("Product is not available for billing");
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = "productId";
    throw error;
  }
  const entitlement = await store.getProductEntitlement(context.session.orgId, productId);
  if (!entitlement) {
    const error = new Error("Product entitlement is not linked to this organization");
    error.name = "ConflictError";
    error.statusCode = 409;
    throw error;
  }

  const customer = organization.billing?.stripeCustomerId
    ? { id: organization.billing.stripeCustomerId }
    : await stripeClient.createCustomer({
      email: context.member.email || context.identity.loginId,
      name: organization.displayName,
      metadata: {
        orgId: organization.orgId,
        organizationCode: organization.organizationCode,
        source
      }
    });
  const checkout = await stripeClient.createSubscriptionCheckoutSession({
    customerId: customer.id,
    lineItems: buildCheckoutLineItemsForEntitlement(product, entitlement),
    successUrl: billingReturnUrl(input, "success", productId),
    cancelUrl: billingReturnUrl(input, "cancel", productId),
    clientReferenceId: organization.orgId,
    metadata: {
      orgId: organization.orgId,
      organizationCode: organization.organizationCode,
      productIds: productId,
      source
    }
  });
  const now = new Date().toISOString();
  const flatLineItem = checkout.lineItems?.find((item) => item.kind === "flat") || checkout.lineItems?.[0] || null;
  await store.updateOrganization(organization.orgId, {
    billing: {
      ...(organization.billing || {}),
      provider: "stripe",
      billingModel: "app_addon",
      status: "checkout_pending",
      stripeCustomerId: customer.id,
      stripeCheckoutSessionId: checkout.session.id,
      stripePriceId: flatLineItem?.price?.id || checkout.price?.id || null,
      updatedAt: now
    }
  });
  const productEntitlement = await store.updateProductEntitlement(organization.orgId, productId, {
    status: "checkout_pending",
    stripePriceLookupKey: flatLineItem?.priceLookupKey || entitlement.stripePriceLookupKey,
    stripePriceId: flatLineItem?.price?.id || checkout.price?.id || null
  });
  await store.createAuditEvent(organization.orgId, {
    eventType: "billing.checkout_session_created",
    actorMemberId: context.session.memberId,
    actorLoginId: context.session.loginId,
    targetType: "organization",
    targetId: organization.orgId,
    safePayload: {
      source,
      productId,
      checkoutSessionId: checkout.session.id,
      stripePriceId: flatLineItem?.price?.id || checkout.price?.id || null
    }
  });

  return {
    checkoutSessionId: checkout.session.id,
    checkoutUrl: checkout.session.url,
    productId,
    productEntitlement,
    lineItems: (checkout.lineItems || []).map((item) => ({
      kind: item.kind || "flat",
      productId: item.productId || productId,
      priceId: item.price?.id || null,
      priceLookupKey: item.priceLookupKey || null,
      quantity: item.quantity
    })),
    expiresAt: checkout.session.expires_at
      ? new Date(Number(checkout.session.expires_at) * 1000).toISOString()
      : null
  };
}

function billingReturnUrl(input, status, productId = null) {
  const baseUrl = String(
    input.billingReturnBaseUrl
    || process.env.PLATFORM_PUBLIC_APP_BASE_URL
    || process.env.PUBLIC_APP_BASE_URL
    || defaultAppBaseUrl(input.env)
  ).replace(/\/$/u, "");

  const url = new URL(`${baseUrl}/billing`);
  url.searchParams.set("checkout", status);
  if (productId) {
    url.searchParams.set("product", productId);
  }
  return url.toString();
}

async function maybeSendPasswordSetupMail({ signupMailer, input, result, passwordSetupUrl }) {
  if (!result?.passwordSetup?.token) {
    return null;
  }

  try {
    return await signupMailer.sendPasswordSetupMail({
      signupApplication: result.signupApplication,
      organization: result.organization,
      adminMember: result.adminMember,
      loginUrl: defaultAppBaseUrl(input.env),
      passwordSetupUrl
    });
  } catch (_error) {
    return {
      mode: "error",
      delivered: false
    };
  }
}

function signupApplicationCreatedResponse(input, result, emailDelivery, verificationUrl) {
  const tokenPreviewAllowed = signupTokenPreviewAllowed(input);
  const emailVerification = {
    expiresAt: result.emailVerification?.expiresAt || null,
    token: tokenPreviewAllowed ? result.emailVerification?.token || null : undefined,
    verificationUrl: tokenPreviewAllowed ? verificationUrl : undefined
  };

  return {
    signupApplication: result.signupApplication,
    emailVerification,
    emailDelivery
  };
}

function signupTokenPreviewAllowed(input = {}) {
  const explicit = input.signupTokenPreview;
  if (typeof explicit === "boolean") {
    return explicit;
  }

  const envValue = process.env.HALUNASU_SIGNUP_TOKEN_PREVIEW;
  if (envValue !== undefined) {
    return ["1", "true", "yes", "on"].includes(String(envValue).toLowerCase());
  }

  return !["stg", "prod", "production"].includes(String(input.env || process.env.HALUNASU_ENV || "").toLowerCase());
}

function defaultAppBaseUrl(env) {
  return String(env || "").toLowerCase() === "stg"
    ? "https://charting.stg.halunasu.com"
    : "https://charting.halunasu.com";
}

async function safeListProductEntitlements(store, orgId) {
  try {
    return await store.listProductEntitlements(orgId);
  } catch {
    return [];
  }
}

function requestedCheckoutProductId(input = {}) {
  const requested = input.body?.productId;
  return typeof requested === "string" && requested.trim() ? requested.trim() : "charting";
}

function publicBillingCatalog(env) {
  return Object.fromEntries(
    Object.entries(getBillingCatalog({ ...process.env, HALUNASU_ENV: env })).map(([productId, product]) => [
      productId,
      {
        productId,
        displayName: product.displayName,
        status: product.status,
        signupSelectable: Boolean(product.signupSelectable),
        pricingModel: product.pricingModel || null,
        monthlyAmountJpy: product.monthlyAmountJpy || null,
        currency: product.currency || "jpy",
        seatBilling: product.seatBilling
          ? {
            enabled: Boolean(product.seatBilling.enabled),
            billableProductRoles: product.seatBilling.billableProductRoles || [],
            includedBillableSeats: product.seatBilling.includedBillableSeats || 1,
            extraSeatAmountJpy: product.seatBilling.extraSeatAmountJpy || null,
            prorationBehavior: product.seatBilling.prorationBehavior || "none"
          }
          : null
      }
    ])
  );
}

async function handleStripeWebhook(input, store) {
  const rawPayload = input.rawBody || JSON.stringify(input.body || {});
  verifyStripeWebhookSignature({
    payload: rawPayload,
    signatureHeader: headerValue(input.headers || {}, "stripe-signature"),
    endpointSecret: input.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET,
    toleranceSeconds: input.stripeWebhookToleranceSeconds || Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300),
    now: input.now ? input.now.getTime() : Date.now()
  });

  const event = input.body || JSON.parse(rawPayload);
  const result = await processStripeWebhookEvent({
    store,
    event,
    now: input.now || new Date()
  });

  return ok({
    received: true,
    outcome: result.outcome,
    receipt: {
      eventId: result.receipt?.eventId || event.id,
      status: result.receipt?.status || "processed"
    }
  });
}

function sessionOptions(input) {
  return {
    sessionSecret: input.sessionSecret || process.env.APP_SESSION_SIGNING_SECRET,
    env: input.env,
    now: input.now,
    ttlSeconds: input.sessionTtlSeconds
  };
}

function cookieOptions(input) {
  return {
    secure: input.secureCookies === undefined
      ? secureCookiesDefault(input.env)
      : Boolean(input.secureCookies),
    ttlSeconds: input.sessionTtlSeconds,
    domain: input.cookieDomain || process.env.APP_COOKIE_DOMAIN,
    sessionCookieName: input.sessionCookieName || process.env.APP_SESSION_COOKIE_NAME,
    csrfCookieName: input.csrfCookieName || process.env.APP_CSRF_COOKIE_NAME
  };
}

function secureCookiesDefault(env) {
  return !["local", "test", "development"].includes(String(env || "local").toLowerCase());
}

function requiredBodyString(body = {}, field) {
  if (typeof body[field] !== "string" || !body[field].trim()) {
    const error = new Error(`${field} is required`);
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = field;
    throw error;
  }

  return body[field].trim();
}

function safeChangedFields(body = {}, redactedFields = []) {
  const redacted = new Set(redactedFields);
  return Object.keys(body || {})
    .filter((field) => !redacted.has(field))
    .sort();
}

function rateLimitKey(kind, input, ...parts) {
  return [
    kind,
    clientKey(input),
    ...parts.map((part) => String(part || "unknown").trim() || "unknown")
  ].join(":");
}

function clientKey(input) {
  const forwardedFor = headerValue(input.headers || {}, "x-forwarded-for");
  const realIp = headerValue(input.headers || {}, "x-real-ip");
  const raw = forwardedFor ? forwardedFor.split(",")[0] : realIp;

  return String(raw || "local")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]/g, "_") || "local";
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

async function readRequestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return { body: undefined, rawBody: "" };
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return { body: {}, rawBody: "" };
  }

  try {
    return { body: JSON.parse(rawBody), rawBody };
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }
}

function ok(body, headers = {}) {
  return {
    statusCode: 200,
    body,
    headers
  };
}

function created(body, headers = {}) {
  return {
    statusCode: 201,
    body,
    headers
  };
}

function noContent(headers = {}) {
  return {
    statusCode: 204,
    body: {},
    headers
  };
}

function notFound(message) {
  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message
    }
  };
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const errorCode = statusCode === 500 ? "internal_error" : error.code || toErrorCode(error.name);

  return {
    statusCode,
    body: {
      error: errorCode,
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field,
      resetAt: error.resetAt
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
  if (!new URL(input.path || "/", "http://localhost").pathname.startsWith("/v1/")) {
    return {};
  }

  const origin = headerValue(input.headers || {}, "origin");
  if (!origin || !isAllowedWebOrigin(origin)) {
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

function isAllowedWebOrigin(origin) {
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

function toErrorCode(name) {
  return String(name || "error")
    .replace(/Error$/, "")
    .replace(/[A-Z]/g, (letter, index) => `${index === 0 ? "" : "_"}${letter.toLowerCase()}`) || "error";
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}

function isOrgChildCollection(parts, collectionName) {
  return parts.length === 4
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
}

function isOrgChildDocument(parts, collectionName) {
  return parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PLATFORM_API_PORT || "8080", 10);
  const server = createPlatformApiServer();

  server.listen(port, () => {
    console.log(`platform-api listening on :${port}`);
  });
}
