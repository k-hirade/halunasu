import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { createTotpCode } from "../src/auth/mfa.js";
import { handlePlatformApiRequest, resolvePlatformApiResponse } from "../src/server.js";
import { MemoryPlatformStore } from "../src/store/memory-store.js";

test("GET /healthz returns ok", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/healthz"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "platform-api");
});

test("GET /readyz includes environment metadata", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/readyz",
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z")
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.env, "test");
  assert.equal(response.body.projectId, "medical-core-stg");
  assert.equal(response.body.region, "asia-northeast1");
  assert.equal(response.body.startedAt, "2026-05-27T00:00:00.000Z");
});

test("unknown route returns 404", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/missing"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "not_found");
});

test("creates and lists organizations", async () => {
  const store = createTestStore();
  const { headers } = await createAuthenticatedMember(store, {
    organizationCode: "Platform Admin",
    displayName: "Platform Admin",
    globalRoles: ["platform_admin"]
  });

  const created = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic A",
    displayName: "Clinic A"
  }, headers);
  const listed = await request(store, "GET", "/v1/organizations", undefined, headers);

  assert.equal(created.statusCode, 201);
  assert.match(created.body.organization.orgId, /^org_/);
  assert.equal(created.body.organization.organizationCode, "clinic-a");
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.body.organizations.some((organization) => organization.displayName === "Clinic A"));
});

test("creates organization members and patients", async () => {
  const store = createTestStore();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Clinic B",
    displayName: "Clinic B",
    globalRoles: ["org_admin"]
  });
  const orgId = organization.orgId;

  const createdMember = await request(store, "POST", `/v1/organizations/${orgId}/members`, {
    loginId: "doctor",
    displayName: "Doctor",
    globalRoles: ["doctor"],
    productRoles: {
      charting: ["doctor"]
    }
  }, headers);
  const createdPatient = await request(store, "POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Yamada Taro",
    primaryPatientNumber: "000123",
    birthDate: "1970-01-01",
    sex: "male"
  }, headers);

  assert.equal(createdMember.statusCode, 201);
  assert.match(createdMember.body.member.memberId, /^mem_/);
  assert.equal(createdMember.body.member.orgId, orgId);
  assert.equal(createdPatient.statusCode, 201);
  assert.match(createdPatient.body.patient.patientId, /^pat_/);
  assert.equal(createdPatient.body.patient.orgId, orgId);
  assert.equal(createdPatient.body.patient.primaryPatientNumber, "000123");

  const listedMembers = await request(store, "GET", `/v1/organizations/${orgId}/members`, undefined, headers);
  const listedPatients = await request(store, "GET", `/v1/organizations/${orgId}/patients`, undefined, headers);

  assert.equal(listedMembers.body.members.length, 2);
  assert.equal(listedPatients.body.patients.length, 1);
});

test("creates shared master data resources", async () => {
  const store = createTestStore();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Clinic Master",
    displayName: "Clinic Master",
    globalRoles: ["org_admin"]
  });
  const orgId = organization.orgId;

  const facility = await request(store, "POST", `/v1/organizations/${orgId}/facilities`, {
    displayName: "Main Clinic",
    medicalInstitutionCode: "1234567",
    facilityStandardKeys: ["basic"]
  }, headers);
  const department = await request(store, "POST", `/v1/organizations/${orgId}/departments`, {
    facilityId: facility.body.facility.facilityId,
    displayName: "Internal Medicine"
  }, headers);
  const entitlement = await request(store, "POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "fee",
    status: "enabled",
    features: { receiptDraft: true }
  }, headers);
  const auditEvent = await request(store, "POST", `/v1/organizations/${orgId}/audit-events`, {
    eventType: "facility.created",
    targetType: "facility",
    targetId: facility.body.facility.facilityId,
    safePayload: { displayName: "Main Clinic" }
  }, headers);

  assert.equal(facility.statusCode, 201);
  assert.match(facility.body.facility.facilityId, /^fac_/);
  assert.match(department.body.department.departmentId, /^dep_/);
  assert.equal(entitlement.body.productEntitlement.productId, "fee");
  assert.match(auditEvent.body.auditEvent.eventId, /^aud_/);
  assert.equal(auditEvent.body.auditEvent.safePayload.displayName, undefined);
  assert.equal((await request(store, "GET", `/v1/organizations/${orgId}/facilities`, undefined, headers)).body.facilities.length, 1);
  assert.equal((await request(store, "GET", `/v1/organizations/${orgId}/departments`, undefined, headers)).body.departments.length, 1);
  const departmentBootstrap = await request(store, "GET", `/v1/organizations/${orgId}/admin-bootstrap?section=departments`, undefined, headers);
  const entitlementBootstrap = await request(store, "GET", `/v1/organizations/${orgId}/admin-bootstrap?section=entitlements`, undefined, headers);
  assert.equal(departmentBootstrap.body.organizations.length, 1);
  assert.equal(departmentBootstrap.body.facilities.length, 1);
  assert.equal(departmentBootstrap.body.departments.length, 1);
  assert.equal(entitlementBootstrap.body.productEntitlements.length, 1);
  assert.equal(
    (await request(store, "GET", `/v1/organizations/${orgId}/product-entitlements/fee`, undefined, headers))
      .body.productEntitlement.status,
    "enabled"
  );
});

test("patches platform resources and records audit events", async () => {
  const store = createTestStore();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Clinic Patch",
    displayName: "Clinic Patch",
    globalRoles: ["org_admin"]
  });
  const orgId = organization.orgId;
  const member = await request(store, "POST", `/v1/organizations/${orgId}/members`, {
    loginId: "doctor",
    displayName: "Doctor",
    password: "correct horse battery staple"
  }, headers);
  const facility = await request(store, "POST", `/v1/organizations/${orgId}/facilities`, {
    displayName: "Main Clinic"
  }, headers);
  const department = await request(store, "POST", `/v1/organizations/${orgId}/departments`, {
    displayName: "Internal Medicine"
  }, headers);
  const patient = await request(store, "POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Yamada Taro"
  }, headers);
  await request(store, "POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "charting",
    status: "trialing"
  }, headers);

  const patchedOrg = await request(store, "PATCH", `/v1/organizations/${orgId}`, {
    displayName: "Clinic Patch Updated",
    defaultFacilityId: facility.body.facility.facilityId
  }, headers);
  const patchedMember = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/members/${member.body.member.memberId}`,
    { displayName: "Doctor Updated", password: "new correct horse battery" },
    headers
  );
  const patchedFacility = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/facilities/${facility.body.facility.facilityId}`,
    { medicalInstitutionCode: "7654321" },
    headers
  );
  const patchedDepartment = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/departments/${department.body.department.departmentId}`,
    { facilityId: facility.body.facility.facilityId },
    headers
  );
  const patchedPatient = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/patients/${patient.body.patient.patientId}`,
    { displayNameKana: "YAMADA TARO" },
    headers
  );
  const patchedEntitlement = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/product-entitlements/charting`,
    { status: "enabled", features: { soap: true } },
    headers
  );
  const auditEvents = await request(store, "GET", `/v1/organizations/${orgId}/audit-events`, undefined, headers);

  assert.equal(patchedOrg.body.organization.displayName, "Clinic Patch Updated");
  assert.equal(patchedMember.body.member.displayName, "Doctor Updated");
  assert.equal(patchedFacility.body.facility.medicalInstitutionCode, "7654321");
  assert.equal(patchedDepartment.body.department.facilityId, facility.body.facility.facilityId);
  assert.equal(patchedPatient.body.patient.displayNameKana, "YAMADA TARO");
  assert.equal(patchedEntitlement.body.productEntitlement.status, "enabled");
  assert.ok(auditEvents.body.auditEvents.some((event) => event.eventType === "member.updated"));
  assert.ok(auditEvents.body.auditEvents.some((event) => event.eventType === "patient.updated"));
});

test("creates signup applications and rate limits signup attempts", async () => {
  const store = createTestStore();
  const { headers: platformHeaders } = await createAuthenticatedMember(store, {
    organizationCode: "Signup Reviewer",
    displayName: "Signup Reviewer",
    globalRoles: ["platform_admin"]
  });
  const first = await request(
    store,
    "POST",
    "/v1/signup/applications",
    {
      organizationCode: "Signup Clinic",
      organizationDisplayName: "Signup Clinic",
      applicantName: "Applicant",
      applicantEmail: "Applicant@example.com",
      requestedProducts: ["charting", "unknown"]
    },
    { "x-forwarded-for": "203.0.113.10" },
    { signupRateLimit: { limit: 1, windowSeconds: 60 } }
  );
  const second = await request(
    store,
    "POST",
    "/v1/signup/applications",
    {
      organizationCode: "Signup Clinic",
      organizationDisplayName: "Signup Clinic",
      applicantName: "Applicant",
      applicantEmail: "Applicant@example.com"
    },
    { "x-forwarded-for": "203.0.113.10" },
    { signupRateLimit: { limit: 1, windowSeconds: 60 } }
  );
  const fetched = await request(
    store,
    "GET",
    `/v1/signup/applications/${first.body.signupApplication.applicationId}`,
    undefined,
    platformHeaders
  );

  assert.equal(first.statusCode, 201);
  assert.equal(first.body.signupApplication.applicantEmail, "applicant@example.com");
  assert.deepEqual(first.body.signupApplication.requestedProducts, ["charting"]);
  assert.match(first.body.emailVerification.token, /^emv_/);
  assert.equal(second.statusCode, 429);
  assert.equal(fetched.body.signupApplication.applicationId, first.body.signupApplication.applicationId);
});

test("sends signup verification and password setup mail through signup mailer", async () => {
  const store = createTestStore();
  const deliveries = [];
  const signupMailer = {
    async sendVerificationMail(payload) {
      deliveries.push({ type: "verification", payload });
      return { mode: "resend", delivered: true, providerMessageId: "email_001" };
    },
    async sendPasswordSetupMail(payload) {
      deliveries.push({ type: "password_setup", payload });
      return { mode: "resend", delivered: true, providerMessageId: "email_002" };
    }
  };
  const created = await request(store, "POST", "/v1/signup/applications", {
    organizationCode: "Mail Clinic",
    organizationDisplayName: "Mail Clinic",
    applicantName: "Mail Admin",
    applicantEmail: "mail-admin@example.com",
    requestedProducts: ["charting"]
  }, {}, {
    signupMailer,
    publicLpBaseUrl: "https://stg.halunasu.com"
  });
  const provisioned = await request(store, "POST", "/v1/signup/verify-email", {
    token: created.body.emailVerification.token
  }, {}, {
    signupMailer,
    publicLpBaseUrl: "https://stg.halunasu.com",
    env: "stg"
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.emailDelivery.delivered, true);
  assert.equal(deliveries[0].type, "verification");
  assert.equal(deliveries[0].payload.signupApplication.applicantEmail, "mail-admin@example.com");
  assert.match(deliveries[0].payload.verificationUrl, /^https:\/\/stg\.halunasu\.com\/signup\?token=emv_/);
  assert.equal(provisioned.statusCode, 200);
  assert.equal(provisioned.body.passwordSetupEmailDelivery.delivered, true);
  assert.equal(deliveries[1].type, "password_setup");
  assert.match(deliveries[1].payload.passwordSetupUrl, /^https:\/\/stg\.halunasu\.com\/signup\?setup=setup_/);
});

test("hides signup verification token in production-like environments", async () => {
  const store = createTestStore();
  const signupMailer = {
    async sendVerificationMail() {
      return { mode: "resend", delivered: true };
    }
  };
  const created = await request(store, "POST", "/v1/signup/applications", {
    organizationCode: "Prod Mail Clinic",
    organizationDisplayName: "Prod Mail Clinic",
    applicantName: "Mail Admin",
    applicantEmail: "mail-admin@example.com"
  }, {}, {
    env: "prod",
    signupMailer
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.emailVerification.token, undefined);
  assert.equal(created.body.emailVerification.verificationUrl, undefined);
  assert.equal(created.body.emailVerification.expiresAt, "2026-05-28T00:00:00.000Z");
});

test("allows CORS preflight for signup routes from known LP origins", async () => {
  const store = createTestStore();
  const response = await request(store, "OPTIONS", "/v1/signup/applications", undefined, {
    origin: "http://localhost:8080"
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:8080");
  assert.equal(response.headers["access-control-allow-methods"], "GET, POST, PATCH, OPTIONS");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
});

test("allows CORS preflight for authenticated app routes from planned app origins", async () => {
  const store = createTestStore();
  const response = await request(store, "OPTIONS", "/v1/auth/login", undefined, {
    origin: "https://charting.stg.halunasu.com"
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "https://charting.stg.halunasu.com");
  assert.equal(response.headers["access-control-allow-headers"], "content-type, x-csrf-token");
});

test("verifies signup email, provisions admin, and sets initial password", async () => {
  const store = createTestStore();
  const created = await request(store, "POST", "/v1/signup/applications", {
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Admin User",
    applicantEmail: "Admin@example.com",
    requestedProducts: ["charting", "fee"]
  });
  const provisioned = await request(store, "POST", "/v1/signup/verify-email", {
    token: created.body.emailVerification.token
  });
  const setup = await request(store, "POST", "/v1/signup/setup-admin-password", {
    token: provisioned.body.passwordSetup.token,
    password: "correct horse battery staple"
  });
  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "signup-clinic",
    loginId: "admin@example.com",
    password: "correct horse battery staple"
  });

  assert.equal(created.statusCode, 201);
  assert.equal(provisioned.statusCode, 200);
  assert.equal(provisioned.body.signupApplication.status, "provisioned");
  assert.equal(provisioned.body.organization.organizationCode, "signup-clinic");
  assert.equal(provisioned.body.adminMember.loginId, "admin@example.com");
  assert.equal(setup.statusCode, 200);
  assert.equal(setup.body.login.organizationCode, "signup-clinic");
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.session.organizationCode, "signup-clinic");
});

test("logs in, checks session, enrolls MFA, and logs out", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Clinic Auth",
    displayName: "Clinic Auth"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });

  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "clinic-auth",
    loginId: "admin",
    password: "correct horse battery staple"
  });
  const loginCookie = cookieHeaderFromSetCookie(login.headers["set-cookie"]);
  const csrfToken = login.body.csrfToken;
  const session = await request(store, "GET", "/v1/auth/session", undefined, {
    cookie: loginCookie
  });
  const mfaEnroll = await request(store, "POST", "/v1/auth/mfa/enroll", {}, {
    cookie: loginCookie,
    "x-csrf-token": csrfToken
  });
  const mfaCode = createTotpCode(mfaEnroll.body.mfa.secret, {
    now: new Date("2026-05-27T00:00:00.000Z")
  });
  const mfaVerify = await request(store, "POST", "/v1/auth/mfa/verify", { code: mfaCode }, {
    cookie: loginCookie,
    "x-csrf-token": csrfToken
  });
  const verifiedCookie = cookieHeaderFromSetCookie(mfaVerify.headers["set-cookie"]);
  const logout = await request(store, "POST", "/v1/auth/logout", {}, {
    cookie: verifiedCookie,
    "x-csrf-token": mfaVerify.body.csrfToken
  });
  const afterLogout = await request(store, "GET", "/v1/auth/session", undefined, {
    cookie: verifiedCookie
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.body.session.loginId, "admin");
  assert.equal(session.statusCode, 200);
  assert.match(session.body.session.memberId, /^mem_/);
  assert.equal(mfaEnroll.statusCode, 201);
  assert.match(mfaEnroll.body.mfa.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.match(mfaEnroll.body.mfa.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(mfaVerify.statusCode, 200);
  assert.equal(mfaVerify.body.mfa.enrolled, true);
  assert.equal(logout.statusCode, 200);
  assert.equal(afterLogout.statusCode, 401);
});

test("organization admin can reset member MFA enrollment", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Clinic MFA Reset",
    displayName: "Clinic MFA Reset"
  });
  const orgId = organization.orgId;
  const member = store.createMember(orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });
  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "clinic-mfa-reset",
    loginId: "admin",
    password: "correct horse battery staple"
  });
  const loginCookie = cookieHeaderFromSetCookie(login.headers["set-cookie"]);
  const enroll = await request(store, "POST", "/v1/auth/mfa/enroll", {}, {
    cookie: loginCookie,
    "x-csrf-token": login.body.csrfToken
  });
  const code = createTotpCode(enroll.body.mfa.secret, {
    now: new Date("2026-05-27T00:00:00.000Z")
  });
  const verify = await request(store, "POST", "/v1/auth/mfa/verify", { code }, {
    cookie: loginCookie,
    "x-csrf-token": login.body.csrfToken
  });
  const verifiedCookie = cookieHeaderFromSetCookie(verify.headers["set-cookie"]);
  const reset = await request(store, "POST", `/v1/organizations/${orgId}/members/${member.memberId}/mfa-reset`, {}, {
    cookie: verifiedCookie,
    "x-csrf-token": verify.body.csrfToken
  });
  const identity = store.getLoginIdentity("clinic-mfa-reset", "admin");

  assert.equal(reset.statusCode, 200);
  assert.equal(reset.body.mfa.enrolled, false);
  assert.equal(identity.mfaEnrolled, false);
  assert.equal(identity.mfaSecret, undefined);
  assert.equal(identity.mfaPendingSecret, undefined);
  assert.equal(identity.tokenVersion, 3);
});

test("starts app trial from LP signup password setup without Stripe checkout", async () => {
  const store = createTestStore();
  const stripeClient = createMockStripeClient();
  const created = await request(store, "POST", "/v1/signup/applications", {
    organizationCode: "Stripe Signup Clinic",
    organizationDisplayName: "Stripe Signup Clinic",
    applicantName: "Admin User",
    applicantEmail: "Admin@example.com",
    requestedProducts: ["charting", "fee"]
  }, {}, { stripeClient });
  const provisioned = await request(store, "POST", "/v1/signup/verify-email", {
    token: created.body.emailVerification.token
  }, {}, { stripeClient });
  const setup = await request(store, "POST", "/v1/signup/setup-admin-password", {
    token: provisioned.body.passwordSetup.token,
    password: "correct horse battery staple"
  }, {}, { stripeClient, billingReturnBaseUrl: "https://charting.example.test" });
  const organization = store.getOrganization(setup.body.organization.orgId);
  const entitlement = store.getProductEntitlement(organization.orgId, "charting");

  assert.equal(setup.statusCode, 200);
  assert.equal(setup.body.billingCheckout, undefined);
  assert.equal(organization.billing.provider, "stripe");
  assert.equal(organization.billing.stripeCustomerId, null);
  assert.equal(organization.billing.stripeSubscriptionId, null);
  assert.equal(entitlement.status, "trialing");
  assert.equal(entitlement.monthlyAmountJpy, 30000);
  assert.equal(entitlement.trialEndsAt, "2026-06-10T00:00:00.000Z");
});

test("creates authenticated billing Checkout and exposes billing status", async () => {
  const store = createTestStore();
  const stripeClient = createMockStripeClient();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Billing Clinic",
    displayName: "Billing Clinic",
    globalRoles: ["org_admin"]
  });
  store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "trialing",
    plan: "trial",
    stripePriceLookupKey: "halunasu_charting_flat_monthly_jpy_v1"
  });
  const checkout = await request(
    store,
    "POST",
    "/v1/billing/products/charting/checkout-session",
    {},
    headers,
    { stripeClient, billingReturnBaseUrl: "https://charting.example.test" }
  );
  const status = await request(store, "GET", "/v1/billing/status", undefined, headers, { stripeClient });

  assert.equal(checkout.statusCode, 200);
  assert.equal(checkout.body.billingCheckout.checkoutSessionId, "cs_test_001");
  assert.equal(checkout.body.billingCheckout.productId, "charting");
  assert.deepEqual(checkout.body.billingCheckout.lineItems, [{
    kind: "flat",
    productId: "charting",
    priceId: "price_test_001",
    priceLookupKey: "halunasu_charting_flat_monthly_jpy_v1",
    quantity: 1
  }]);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.billing.stripeCheckoutSessionId, "cs_test_001");
  assert.equal(status.body.billingCatalog.charting.monthlyAmountJpy, 30000);
  assert.equal(status.body.productEntitlements[0].status, "checkout_pending");
  assert.equal(status.body.stripe.configured, true);
  assert.equal(store.getOrganization(organization.orgId).billing.stripePriceId, "price_test_001");
});

test("adds paid app to an existing Stripe subscription as an item", async () => {
  const store = createTestStore();
  const stripeClient = createMockStripeClient();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Billing Item Clinic",
    displayName: "Billing Item Clinic",
    globalRoles: ["org_admin"]
  });
  store.updateOrganization(organization.orgId, {
    billing: {
      provider: "stripe",
      billingModel: "app_addon",
      status: "active",
      stripeCustomerId: "cus_existing_001",
      stripeSubscriptionId: "sub_existing_001"
    }
  });
  store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "trialing",
    plan: "trial",
    stripePriceLookupKey: "halunasu_charting_flat_monthly_jpy_v1"
  });

  const checkout = await request(
    store,
    "POST",
    "/v1/billing/products/charting/checkout-session",
    {},
    headers,
    { stripeClient, billingReturnBaseUrl: "https://charting.example.test" }
  );
  const entitlement = store.getProductEntitlement(organization.orgId, "charting");

  assert.equal(checkout.statusCode, 200);
  assert.equal(checkout.body.billingCheckout.checkoutRequired, false);
  assert.equal(checkout.body.billingCheckout.checkoutUrl, null);
  assert.equal(entitlement.status, "enabled");
  assert.equal(entitlement.stripeSubscriptionItemId, "si_test_added_001");
});

test("runs trial reminder and expiry maintenance", async () => {
  const store = createTestStore();
  const sentMail = [];
  const signupMailer = {
    async sendTrialReminderMail(input) {
      sentMail.push(input);
      return { delivered: true, mode: "test" };
    }
  };
  const reminderOrg = store.createOrganization({
    organizationCode: "Reminder Clinic",
    displayName: "Reminder Clinic"
  });
  store.createMember(reminderOrg.orgId, {
    loginId: "billing@example.com",
    displayName: "Billing Admin",
    email: "billing@example.com",
    globalRoles: ["billing_admin"],
    productRoles: { charting: ["admin"] },
    password: "correct horse battery staple"
  });
  store.upsertProductEntitlement(reminderOrg.orgId, {
    productId: "charting",
    status: "trialing",
    trialEndsAt: "2026-05-30T00:00:00.000Z",
    reminderStartsAt: "2026-05-27T00:00:00.000Z",
    reminderCount: 0
  });
  const expiredOrg = store.createOrganization({
    organizationCode: "Expired Clinic",
    displayName: "Expired Clinic"
  });
  store.upsertProductEntitlement(expiredOrg.orgId, {
    productId: "charting",
    status: "trialing",
    trialEndsAt: "2026-05-26T00:00:00.000Z",
    reminderStartsAt: "2026-05-23T00:00:00.000Z"
  });

  const response = await request(
    store,
    "POST",
    "/v1/internal/billing/maintenance",
    {},
    { "x-halunasu-maintenance-secret": "maintenance-secret" },
    {
      signupMailer,
      maintenanceSecret: "maintenance-secret",
      billingReturnBaseUrl: "https://charting.example.test",
      now: new Date("2026-05-28T00:00:00.000Z")
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.billingMaintenance.remindersSent, 1);
  assert.equal(response.body.billingMaintenance.trialsExpired, 1);
  assert.equal(sentMail.length, 1);
  assert.equal(store.getProductEntitlement(expiredOrg.orgId, "charting").status, "payment_required");
  assert.equal(store.getProductEntitlement(reminderOrg.orgId, "charting").reminderCount, 1);
});

test("processes signed Stripe webhook and updates Core billing state", async () => {
  const store = createTestStore();
  const { organization } = await createAuthenticatedMember(store, {
    organizationCode: "Webhook Clinic",
    displayName: "Webhook Clinic",
    globalRoles: ["org_admin"]
  });
  await store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "trialing"
  });
  const event = {
    id: "evt_subscription_updated_001",
    type: "customer.subscription.updated",
    livemode: false,
    api_version: "2026-03-25.dahlia",
    data: {
      object: {
        id: "sub_test_webhook_001",
        status: "active",
        customer: "cus_test_webhook_001",
        current_period_end: 1780000000,
        metadata: {
          orgId: organization.orgId,
          organizationCode: organization.organizationCode,
          productIds: "charting"
        },
        items: {
          data: [{
            id: "si_test_charting_001",
            quantity: 1,
            price: {
              id: "price_test_001",
              lookup_key: "halunasu_charting_flat_monthly_jpy_v1"
            }
          }]
        }
      }
    }
  };
  const rawBody = JSON.stringify(event);
  const secret = "whsec_test_secret";
  const webhook = await request(
    store,
    "POST",
    "/v1/stripe/webhook",
    event,
    { "stripe-signature": stripeSignature(rawBody, secret, 1779840000) },
    {
      rawBody,
      stripeWebhookSecret: secret,
      now: new Date("2026-05-27T00:00:00.000Z")
    }
  );
  const updated = store.getOrganization(organization.orgId);
  const entitlement = store.getProductEntitlement(organization.orgId, "charting");
  const receipt = store.getStripeEventReceipt(event.id);

  assert.equal(webhook.statusCode, 200);
  assert.equal(webhook.body.received, true);
  assert.equal(webhook.body.receipt.status, "processed");
  assert.deepEqual(webhook.body.outcome.productIds, ["charting"]);
  assert.equal(updated.billing.status, "active");
  assert.equal(updated.billing.stripeCustomerId, "cus_test_webhook_001");
  assert.equal(updated.billing.stripeSubscriptionId, "sub_test_webhook_001");
  assert.equal(updated.access.status, "active");
  assert.equal(entitlement.status, "enabled");
  assert.equal(entitlement.stripePriceId, "price_test_001");
  assert.equal(entitlement.stripeSubscriptionItemId, "si_test_charting_001");
  assert.equal(entitlement.currentPeriodEnd, "2026-05-28T20:26:40.000Z");
  assert.equal(receipt.status, "processed");
});

test("rejects Stripe webhook with invalid signature", async () => {
  const store = createTestStore();
  const event = {
    id: "evt_bad_signature",
    type: "checkout.session.completed",
    data: {
      object: {}
    }
  };
  const rawBody = JSON.stringify(event);
  const webhook = await request(
    store,
    "POST",
    "/v1/stripe/webhook",
    event,
    { "stripe-signature": stripeSignature(rawBody, "wrong_secret", 1779840000) },
    {
      rawBody,
      stripeWebhookSecret: "whsec_test_secret",
      now: new Date("2026-05-27T00:00:00.000Z")
    }
  );

  assert.equal(webhook.statusCode, 400);
  assert.equal(webhook.body.error, "bad_request");
});

test("uses secure session cookies outside local and test environments", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Secure Clinic",
    displayName: "Secure Clinic"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });

  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "secure-clinic",
    loginId: "admin",
    password: "correct horse battery staple"
  }, {}, { env: "production" });

  assert.equal(login.statusCode, 200);
  assert.ok(login.headers["set-cookie"].every((header) => header.includes("Secure")));
  assert.ok(login.headers["set-cookie"].every((header) => header.includes("SameSite=Lax")));
});

test("supports environment-specific cookie names and domains", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Staging Cookie Clinic",
    displayName: "Staging Cookie Clinic"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });

  const cookieOptions = {
    env: "production",
    cookieDomain: ".stg.halunasu.com",
    sessionCookieName: "halunasu_stg_session",
    csrfCookieName: "halunasu_stg_csrf"
  };
  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "staging-cookie-clinic",
    loginId: "admin",
    password: "correct horse battery staple"
  }, {}, cookieOptions);
  const session = await request(store, "GET", "/v1/auth/session", undefined, {
    cookie: cookieHeaderFromSetCookie(login.headers["set-cookie"])
  }, cookieOptions);

  assert.equal(login.statusCode, 200);
  assert.ok(login.headers["set-cookie"].some((header) => header.startsWith("halunasu_stg_session=")));
  assert.ok(login.headers["set-cookie"].some((header) => header.startsWith("halunasu_stg_csrf=")));
  assert.ok(login.headers["set-cookie"].every((header) => header.includes("Domain=.stg.halunasu.com")));
  assert.equal(session.statusCode, 200);
});

test("allows explicit local insecure cookie override for local development", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Local Cookie Clinic",
    displayName: "Local Cookie Clinic"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });

  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "local-cookie-clinic",
    loginId: "admin",
    password: "correct horse battery staple"
  }, {}, { env: "production", secureCookies: false });

  assert.equal(login.statusCode, 200);
  assert.ok(login.headers["set-cookie"].every((header) => !header.includes("Secure")));
});

test("requires MFA code after enrollment", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Clinic MFA",
    displayName: "Clinic MFA"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });
  const firstLogin = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "clinic-mfa",
    loginId: "admin",
    password: "correct horse battery staple"
  });
  const firstCookie = cookieHeaderFromSetCookie(firstLogin.headers["set-cookie"]);
  const enroll = await request(store, "POST", "/v1/auth/mfa/enroll", {}, {
    cookie: firstCookie,
    "x-csrf-token": firstLogin.body.csrfToken
  });
  const code = createTotpCode(enroll.body.mfa.secret, {
    now: new Date("2026-05-27T00:00:00.000Z")
  });
  await request(store, "POST", "/v1/auth/mfa/verify", { code }, {
    cookie: firstCookie,
    "x-csrf-token": firstLogin.body.csrfToken
  });

  const missingMfa = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "clinic-mfa",
    loginId: "admin",
    password: "correct horse battery staple"
  });
  const withMfa = await request(store, "POST", "/v1/auth/login", {
    organizationCode: "clinic-mfa",
    loginId: "admin",
    password: "correct horse battery staple",
    mfaCode: code
  });

  assert.equal(missingMfa.statusCode, 401);
  assert.equal(missingMfa.body.error, "mfa_required");
  assert.equal(withMfa.statusCode, 200);
});

test("rate limits login attempts", async () => {
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Clinic Rate",
    displayName: "Clinic Rate"
  });
  const orgId = organization.orgId;

  store.createMember(orgId, {
    loginId: "admin",
    displayName: "Admin",
    password: "correct horse battery staple"
  });

  const first = await request(
    store,
    "POST",
    "/v1/auth/login",
    {
      organizationCode: "clinic-rate",
      loginId: "admin",
      password: "wrong horse battery staple"
    },
    { "x-forwarded-for": "203.0.113.20" },
    { loginRateLimit: { limit: 1, windowSeconds: 60 } }
  );
  const second = await request(
    store,
    "POST",
    "/v1/auth/login",
    {
      organizationCode: "clinic-rate",
      loginId: "admin",
      password: "wrong horse battery staple"
    },
    { "x-forwarded-for": "203.0.113.20" },
    { loginRateLimit: { limit: 1, windowSeconds: 60 } }
  );

  assert.equal(first.statusCode, 401);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, "rate_limit");
});

test("requires Platform session and org admin role for Core resources", async () => {
  const store = createTestStore();
  const { organization, headers: adminHeaders } = await createAuthenticatedMember(store, {
    organizationCode: "Protected Clinic",
    displayName: "Protected Clinic",
    globalRoles: ["org_admin"]
  });
  const viewer = await createAuthenticatedMember(store, {
    organizationCode: "Viewer Clinic",
    displayName: "Viewer Clinic",
    globalRoles: ["viewer"]
  });

  const unauthenticated = await request(store, "GET", `/v1/organizations/${organization.orgId}/patients`);
  const wrongOrg = await request(
    store,
    "GET",
    `/v1/organizations/${organization.orgId}/patients`,
    undefined,
    viewer.headers
  );
  const viewerWrite = await request(
    store,
    "POST",
    `/v1/organizations/${viewer.organization.orgId}/patients`,
    { displayName: "Patient" },
    viewer.headers
  );
  const missingCsrf = await request(
    store,
    "POST",
    `/v1/organizations/${organization.orgId}/patients`,
    { displayName: "Patient" },
    { cookie: adminHeaders.cookie }
  );

  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(wrongOrg.statusCode, 403);
  assert.equal(viewerWrite.statusCode, 403);
  assert.equal(missingCsrf.statusCode, 403);
});

test("creates and updates data requests through Core API", async () => {
  const store = createTestStore();
  const { organization, headers } = await createAuthenticatedMember(store, {
    organizationCode: "Data Request Clinic",
    displayName: "Data Request Clinic",
    globalRoles: ["org_admin"]
  });
  const patient = store.createPatient(organization.orgId, {
    displayName: "Yamada Taro"
  });
  const created = await request(store, "POST", `/v1/organizations/${organization.orgId}/data-requests`, {
    requestType: "deletion",
    subjectPatientId: patient.patientId,
    productIds: ["charting", "fee", "unknown"],
    safePayload: {
      patientId: patient.patientId,
      displayName: "Yamada Taro"
    }
  }, headers);
  const patched = await request(
    store,
    "PATCH",
    `/v1/organizations/${organization.orgId}/data-requests/${created.body.dataRequest.requestId}`,
    {
      status: "completed",
      completedAt: "2026-05-28T00:00:00.000Z"
    },
    headers
  );
  const listed = await request(store, "GET", `/v1/organizations/${organization.orgId}/data-requests`, undefined, headers);
  const auditEvents = await request(store, "GET", `/v1/organizations/${organization.orgId}/audit-events`, undefined, headers);

  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.dataRequest.productIds, ["charting", "fee"]);
  assert.equal(created.body.dataRequest.safePayload.displayName, undefined);
  assert.equal(patched.body.dataRequest.status, "completed");
  assert.equal(listed.body.dataRequests.length, 1);
  assert.ok(auditEvents.body.auditEvents.some((event) => event.eventType === "data_request.created"));
  assert.ok(auditEvents.body.auditEvents.some((event) => event.eventType === "data_request.updated"));
});

test("requires configured session secret outside local and test environments", async () => {
  const previousSecret = process.env.APP_SESSION_SIGNING_SECRET;
  delete process.env.APP_SESSION_SIGNING_SECRET;
  const store = createTestStore();
  const organization = store.createOrganization({
    organizationCode: "Secret Clinic",
    displayName: "Secret Clinic"
  });
  store.createMember(organization.orgId, {
    loginId: "admin",
    displayName: "Admin",
    password: "correct horse battery staple"
  });

  try {
    const response = await request(store, "POST", "/v1/auth/login", {
      organizationCode: "secret-clinic",
      loginId: "admin",
      password: "correct horse battery staple"
    }, {}, { env: "production", noSessionSecret: true });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error, "internal_error");
  } finally {
    if (previousSecret === undefined) {
      delete process.env.APP_SESSION_SIGNING_SECRET;
    } else {
      process.env.APP_SESSION_SIGNING_SECRET = previousSecret;
    }
  }
});

test("returns validation and conflict errors as responses", async () => {
  const store = createTestStore();
  const { headers } = await createAuthenticatedMember(store, {
    organizationCode: "Conflict Admin",
    displayName: "Conflict Admin",
    globalRoles: ["platform_admin"]
  });

  const invalid = await request(store, "POST", "/v1/organizations", {
    organizationCode: "",
    displayName: ""
  }, headers);
  const first = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C"
  }, headers);
  const duplicate = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C Duplicate"
  }, headers);

  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "validation");
  assert.equal(first.statusCode, 201);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.error, "conflict");
});

function createTestStore() {
  let counter = 0;
  let tokenCounter = 0;
  return new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`,
    tokenFactory: (prefix) => `${prefix}_${String(++tokenCounter).padStart(3, "0")}`
  });
}

async function createAuthenticatedMember(store, options = {}) {
  const organization = store.createOrganization({
    organizationCode: options.organizationCode || "Clinic",
    displayName: options.displayName || options.organizationCode || "Clinic"
  });
  const member = store.createMember(organization.orgId, {
    loginId: options.loginId || "admin",
    displayName: options.memberName || "Admin",
    globalRoles: options.globalRoles || ["org_admin"],
    productRoles: options.productRoles || {},
    password: options.password || "correct horse battery staple"
  });
  const login = await request(store, "POST", "/v1/auth/login", {
    organizationCode: organization.organizationCode,
    loginId: member.loginId,
    password: options.password || "correct horse battery staple"
  });
  const cookie = cookieHeaderFromSetCookie(login.headers["set-cookie"]);

  return {
    organization,
    member,
    login,
    headers: {
      cookie,
      "x-csrf-token": login.body.csrfToken
    }
  };
}

function request(store, method, path, body, headers = {}, options = {}) {
  return handlePlatformApiRequest({
    method,
    path,
    body,
    rawBody: options.rawBody,
    headers,
    store,
    env: options.env || "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z"),
    now: options.now || new Date("2026-05-27T00:00:00.000Z"),
    sessionSecret: options.noSessionSecret ? undefined : "test-session-secret",
    secureCookies: options.secureCookies,
    cookieDomain: options.cookieDomain,
    sessionCookieName: options.sessionCookieName,
    csrfCookieName: options.csrfCookieName,
    loginRateLimit: options.loginRateLimit,
    signupRateLimit: options.signupRateLimit,
    stripeClient: options.stripeClient,
    stripeWebhookSecret: options.stripeWebhookSecret,
    maintenanceSecret: options.maintenanceSecret,
    billingReturnBaseUrl: options.billingReturnBaseUrl,
    signupMailer: options.signupMailer,
    publicLpBaseUrl: options.publicLpBaseUrl,
    signupTokenPreview: options.signupTokenPreview
  });
}

function cookieHeaderFromSetCookie(setCookieHeaders) {
  return setCookieHeaders
    .map((header) => header.split(";")[0])
    .join("; ");
}

function createMockStripeClient() {
  return {
    isConfigured: () => true,
    configurationView: () => ({
      configured: true,
      apiVersion: "2026-03-25.dahlia",
      priceConfiguredBy: "price_id",
      trialDays: 0
    }),
    async createCustomer() {
      return { id: "cus_test_001" };
    },
    async createSubscriptionCheckoutSession(input) {
      const lineItems = (input.lineItems || []).map((item, index) => ({
        ...item,
        price: { id: index === 0 ? "price_test_001" : `price_test_${String(index + 1).padStart(3, "0")}` },
        quantity: item.quantity || 1
      }));
      return {
        price: lineItems[0]?.price || { id: "price_test_001" },
        lineItems,
        session: {
          id: "cs_test_001",
          url: "https://checkout.stripe.test/session/cs_test_001",
          expires_at: 1780000000,
          input
        }
      };
    },
    async createSubscriptionItem() {
      return {
        price: { id: "price_test_001" },
        subscriptionItem: { id: "si_test_added_001" }
      };
    },
    async createBillingPortalSession() {
      return { url: "https://billing.stripe.test/session/bps_test_001" };
    }
  };
}

function stripeSignature(payload, secret, timestamp) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
