import assert from "node:assert/strict";
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

  const created = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic A",
    displayName: "Clinic A"
  });
  const listed = await request(store, "GET", "/v1/organizations");

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.organization.orgId, "org_001");
  assert.equal(created.body.organization.organizationCode, "clinic-a");
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.organizations.length, 1);
  assert.equal(listed.body.organizations[0].displayName, "Clinic A");
});

test("creates organization members and patients", async () => {
  const store = createTestStore();
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic B",
    displayName: "Clinic B"
  });
  const orgId = createdOrg.body.organization.orgId;

  const createdMember = await request(store, "POST", `/v1/organizations/${orgId}/members`, {
    loginId: "doctor",
    displayName: "Doctor",
    globalRoles: ["doctor"],
    productRoles: {
      charting: ["doctor"]
    }
  });
  const createdPatient = await request(store, "POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Yamada Taro",
    birthDate: "1970-01-01",
    sex: "male"
  });

  assert.equal(createdMember.statusCode, 201);
  assert.match(createdMember.body.member.memberId, /^mem_/);
  assert.equal(createdMember.body.member.orgId, orgId);
  assert.equal(createdPatient.statusCode, 201);
  assert.match(createdPatient.body.patient.patientId, /^pat_/);
  assert.equal(createdPatient.body.patient.orgId, orgId);

  const listedMembers = await request(store, "GET", `/v1/organizations/${orgId}/members`);
  const listedPatients = await request(store, "GET", `/v1/organizations/${orgId}/patients`);

  assert.equal(listedMembers.body.members.length, 1);
  assert.equal(listedPatients.body.patients.length, 1);
});

test("creates shared master data resources", async () => {
  const store = createTestStore();
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic Master",
    displayName: "Clinic Master"
  });
  const orgId = createdOrg.body.organization.orgId;

  const facility = await request(store, "POST", `/v1/organizations/${orgId}/facilities`, {
    displayName: "Main Clinic",
    medicalInstitutionCode: "1234567",
    facilityStandardKeys: ["basic"]
  });
  const department = await request(store, "POST", `/v1/organizations/${orgId}/departments`, {
    facilityId: facility.body.facility.facilityId,
    displayName: "Internal Medicine"
  });
  const entitlement = await request(store, "POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "fee",
    status: "enabled",
    features: { receiptDraft: true }
  });
  const auditEvent = await request(store, "POST", `/v1/organizations/${orgId}/audit-events`, {
    eventType: "facility.created",
    targetType: "facility",
    targetId: facility.body.facility.facilityId,
    safePayload: { displayName: "Main Clinic" }
  });

  assert.equal(facility.statusCode, 201);
  assert.match(facility.body.facility.facilityId, /^fac_/);
  assert.match(department.body.department.departmentId, /^dep_/);
  assert.equal(entitlement.body.productEntitlement.productId, "fee");
  assert.match(auditEvent.body.auditEvent.eventId, /^aud_/);
  assert.equal((await request(store, "GET", `/v1/organizations/${orgId}/facilities`)).body.facilities.length, 1);
  assert.equal((await request(store, "GET", `/v1/organizations/${orgId}/departments`)).body.departments.length, 1);
  assert.equal(
    (await request(store, "GET", `/v1/organizations/${orgId}/product-entitlements/fee`))
      .body.productEntitlement.status,
    "enabled"
  );
});

test("patches platform resources and records audit events", async () => {
  const store = createTestStore();
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic Patch",
    displayName: "Clinic Patch"
  });
  const orgId = createdOrg.body.organization.orgId;
  const member = await request(store, "POST", `/v1/organizations/${orgId}/members`, {
    loginId: "doctor",
    displayName: "Doctor",
    password: "correct horse battery staple"
  });
  const facility = await request(store, "POST", `/v1/organizations/${orgId}/facilities`, {
    displayName: "Main Clinic"
  });
  const department = await request(store, "POST", `/v1/organizations/${orgId}/departments`, {
    displayName: "Internal Medicine"
  });
  const patient = await request(store, "POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Yamada Taro"
  });
  await request(store, "POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "charting",
    status: "trialing"
  });

  const patchedOrg = await request(store, "PATCH", `/v1/organizations/${orgId}`, {
    displayName: "Clinic Patch Updated",
    defaultFacilityId: facility.body.facility.facilityId
  });
  const patchedMember = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/members/${member.body.member.memberId}`,
    { displayName: "Doctor Updated", password: "new correct horse battery" }
  );
  const patchedFacility = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/facilities/${facility.body.facility.facilityId}`,
    { medicalInstitutionCode: "7654321" }
  );
  const patchedDepartment = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/departments/${department.body.department.departmentId}`,
    { facilityId: facility.body.facility.facilityId }
  );
  const patchedPatient = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/patients/${patient.body.patient.patientId}`,
    { displayNameKana: "YAMADA TARO" }
  );
  const patchedEntitlement = await request(
    store,
    "PATCH",
    `/v1/organizations/${orgId}/product-entitlements/charting`,
    { status: "enabled", features: { soap: true } }
  );
  const auditEvents = await request(store, "GET", `/v1/organizations/${orgId}/audit-events`);

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
  const fetched = await request(store, "GET", `/v1/signup/applications/${first.body.signupApplication.applicationId}`);

  assert.equal(first.statusCode, 201);
  assert.equal(first.body.signupApplication.applicantEmail, "applicant@example.com");
  assert.deepEqual(first.body.signupApplication.requestedProducts, ["charting"]);
  assert.match(first.body.emailVerification.token, /^emv_/);
  assert.equal(second.statusCode, 429);
  assert.equal(fetched.body.signupApplication.applicationId, first.body.signupApplication.applicationId);
});

test("allows CORS preflight for signup routes from known LP origins", async () => {
  const store = createTestStore();
  const response = await request(store, "OPTIONS", "/v1/signup/applications", undefined, {
    origin: "http://localhost:8080"
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:8080");
  assert.equal(response.headers["access-control-allow-methods"], "POST, OPTIONS");
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
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic Auth",
    displayName: "Clinic Auth"
  });
  const orgId = createdOrg.body.organization.orgId;

  await request(store, "POST", `/v1/organizations/${orgId}/members`, {
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
  assert.equal(mfaVerify.statusCode, 200);
  assert.equal(mfaVerify.body.mfa.enrolled, true);
  assert.equal(logout.statusCode, 200);
  assert.equal(afterLogout.statusCode, 401);
});

test("requires MFA code after enrollment", async () => {
  const store = createTestStore();
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic MFA",
    displayName: "Clinic MFA"
  });
  const orgId = createdOrg.body.organization.orgId;

  await request(store, "POST", `/v1/organizations/${orgId}/members`, {
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
  const createdOrg = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic Rate",
    displayName: "Clinic Rate"
  });
  const orgId = createdOrg.body.organization.orgId;

  await request(store, "POST", `/v1/organizations/${orgId}/members`, {
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

test("returns validation and conflict errors as responses", async () => {
  const store = createTestStore();

  const invalid = await request(store, "POST", "/v1/organizations", {
    organizationCode: "",
    displayName: ""
  });
  const first = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C"
  });
  const duplicate = await request(store, "POST", "/v1/organizations", {
    organizationCode: "Clinic C",
    displayName: "Clinic C Duplicate"
  });

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

function request(store, method, path, body, headers = {}, options = {}) {
  return handlePlatformApiRequest({
    method,
    path,
    body,
    headers,
    store,
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z"),
    now: new Date("2026-05-27T00:00:00.000Z"),
    sessionSecret: "test-session-secret",
    loginRateLimit: options.loginRateLimit,
    signupRateLimit: options.signupRateLimit
  });
}

function cookieHeaderFromSetCookie(setCookieHeaders) {
  return setCookieHeaders
    .map((header) => header.split(";")[0])
    .join("; ");
}
