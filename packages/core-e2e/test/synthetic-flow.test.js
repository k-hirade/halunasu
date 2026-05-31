import assert from "node:assert/strict";
import { test } from "node:test";
import { handleChartingApiRequest } from "../../../services/charting-api/src/server.js";
import { MemoryChartingStore } from "../../../services/charting-api/src/store/memory-store.js";
import { handleFeeApiRequest } from "../../../services/fee-api/src/server.js";
import { MemoryFeeStore } from "../../../services/fee-api/src/store/memory-store.js";
import { handlePlatformApiRequest } from "../../../services/platform-api/src/server.js";
import { MemoryPlatformStore } from "../../../services/platform-api/src/store/memory-store.js";
import { handleReferralApiRequest } from "../../../services/referral-api/src/server.js";
import { MemoryReferralStore } from "../../../services/referral-api/src/store/memory-store.js";

const SESSION_SECRET = "synthetic-e2e-session-secret";
const NOW = new Date("2026-05-28T00:00:00.000Z");

test("runs signup to Core and product synthetic flow", async () => {
  const env = createSyntheticEnv();
  const account = await signupAndLogin(env, {
    organizationCode: "E2E Clinic",
    organizationDisplayName: "E2E Clinic",
    applicantName: "Admin User",
    applicantEmail: "admin@example.com",
    requestedProducts: ["charting"]
  });
  const orgId = account.session.orgId;

  await env.platform("POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "fee",
    status: "enabled"
  }, account.headers);
  await env.platform("POST", `/v1/organizations/${orgId}/product-entitlements`, {
    productId: "referral",
    status: "enabled"
  }, account.headers);

  const facility = await env.platform("POST", `/v1/organizations/${orgId}/facilities`, {
    displayName: "Main Clinic",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo"
  }, account.headers);
  const department = await env.platform("POST", `/v1/organizations/${orgId}/departments`, {
    facilityId: facility.body.facility.facilityId,
    displayName: "Internal Medicine",
    code: "01"
  }, account.headers);
  const patient = await env.platform("POST", `/v1/organizations/${orgId}/patients`, {
    displayName: "Synthetic Patient",
    primaryPatientNumber: "P-0001",
    patientIdentifiers: [{
      sourceSystem: "synthetic",
      facilityId: facility.body.facility.facilityId,
      patientNumber: "SYN-001"
    }],
    birthDate: "1970-01-01",
    sex: "female",
    contact: { phone: "03-0000-0000" },
    insurance: { insurerNumber: "06123456" },
    consent: { dataUse: true }
  }, account.headers);

  const encounter = await env.charting("POST", "/v1/charting/encounters", {
    patientId: patient.body.patient.patientId,
    facilityId: facility.body.facility.facilityId,
    departmentId: department.body.department.departmentId,
    title: "初診",
    visitReason: "咳",
    transcript: "咳が続く。発熱なし。"
  }, account.headers);
  const soap = await env.charting(
    "POST",
    `/v1/charting/encounters/${encounter.body.encounter.encounterId}/soap-drafts/generate`,
    { transcript: "咳が続く。発熱なし。" },
    account.headers
  );

  const feeSession = await env.fee("POST", "/v1/fee/sessions", {
    patientId: patient.body.patient.patientId,
    facilityId: facility.body.facility.facilityId,
    departmentId: department.body.department.departmentId,
    serviceDate: "2026-05-28",
    setting: "outpatient",
    clinicalText: "急性上気道炎疑い",
    orders: [{ orderType: "lab", content: "血液検査", quantity: 1 }]
  }, account.headers);
  const calculation = await env.fee(
    "POST",
    `/v1/fee/sessions/${feeSession.body.feeSession.feeSessionId}/calculate`,
    {},
    account.headers
  );

  const referral = await env.referral("POST", "/v1/referral/referrals", {
    patientId: patient.body.patient.patientId,
    facilityId: facility.body.facility.facilityId,
    departmentId: department.body.department.departmentId,
    recipientInstitution: {
      displayName: "Referral Hospital",
      departmentName: "Respiratory Medicine"
    },
    recipientDoctor: {
      displayName: "Referral Doctor"
    },
    purpose: "精査依頼",
    clinicalSummary: "咳嗽が続くため精査を依頼します。",
    diagnoses: ["咳嗽"],
    medications: ["鎮咳薬"]
  }, account.headers);
  const pdf = await env.referral(
    "POST",
    `/v1/referral/referrals/${referral.body.referral.referralId}/document`,
    {},
    account.headers
  );

  const dataRequest = await env.platform("POST", `/v1/organizations/${orgId}/data-requests`, {
    requestType: "export",
    subjectPatientId: patient.body.patient.patientId,
    productIds: ["charting", "fee", "referral"],
    safePayload: {
      patientId: patient.body.patient.patientId,
      displayName: "Synthetic Patient"
    }
  }, account.headers);
  const auditEvents = await env.platform("GET", `/v1/organizations/${orgId}/audit-events`, undefined, account.headers);
  const eventTypes = auditEvents.body.auditEvents.map((event) => event.eventType);

  assert.equal(patient.body.patient.primaryPatientNumber, "P-0001");
  assert.equal(patient.body.patient.patientIdentifiers[0].value, "SYN-001");
  assert.equal(encounter.body.encounter.patientId, patient.body.patient.patientId);
  assert.equal(soap.body.soapDraft.provider, "halunasu_rule_based");
  assert.equal(feeSession.body.feeSession.patientId, patient.body.patient.patientId);
  assert.equal(calculation.body.calculationResult.provider, "synthetic_fee_engine");
  assert.equal(referral.body.referral.patientId, patient.body.patient.patientId);
  assert.equal(pdf.body.documentArtifact.provider, "halunasu_html");
  assert.equal(dataRequest.body.dataRequest.safePayload.displayName, undefined);
  assert.ok(eventTypes.includes("charting.encounter_created"));
  assert.ok(eventTypes.includes("fee.session_created"));
  assert.ok(eventTypes.includes("referral.draft_created"));
  assert.ok(eventTypes.includes("data_request.created"));
});

test("enforces Core admin roles and organization scope in synthetic flow", async () => {
  const env = createSyntheticEnv();
  const first = await signupAndLogin(env, {
    organizationCode: "Scope One",
    organizationDisplayName: "Scope One",
    applicantName: "Admin One",
    applicantEmail: "one@example.com",
    requestedProducts: ["charting"]
  });
  const second = await signupAndLogin(env, {
    organizationCode: "Scope Two",
    organizationDisplayName: "Scope Two",
    applicantName: "Admin Two",
    applicantEmail: "two@example.com",
    requestedProducts: ["charting"]
  });

  await env.platform("POST", `/v1/organizations/${first.session.orgId}/members`, {
    loginId: "viewer",
    displayName: "Viewer",
    globalRoles: ["viewer"],
    productRoles: { charting: ["viewer"] },
    password: "correct horse battery staple"
  }, first.headers);
  const viewerLogin = await env.platform("POST", "/v1/auth/login", {
    organizationCode: first.session.organizationCode,
    loginId: "viewer",
    password: "correct horse battery staple"
  });
  const viewerHeaders = authHeaders(viewerLogin);

  const viewerRead = await env.platform("GET", `/v1/organizations/${first.session.orgId}/patients`, undefined, viewerHeaders);
  const viewerWrite = await env.platform("POST", `/v1/organizations/${first.session.orgId}/patients`, {
    displayName: "Blocked"
  }, viewerHeaders);
  const crossOrg = await env.platform("GET", `/v1/organizations/${first.session.orgId}/patients`, undefined, second.headers);

  const platformAdmin = createDirectMember(env, {
    organizationCode: "Platform Admin Org",
    displayName: "Platform Admin Org",
    loginId: "platform-admin",
    globalRoles: ["platform_admin"]
  });
  const platformAdminLogin = await env.platform("POST", "/v1/auth/login", {
    organizationCode: platformAdmin.organization.organizationCode,
    loginId: platformAdmin.member.loginId,
    password: "correct horse battery staple"
  });
  const organizationList = await env.platform("GET", "/v1/organizations", undefined, authHeaders(platformAdminLogin));

  assert.equal(viewerRead.statusCode, 200);
  assert.equal(viewerWrite.statusCode, 403);
  assert.equal(crossOrg.statusCode, 403);
  assert.equal(organizationList.statusCode, 200);
  assert.ok(organizationList.body.organizations.length >= 3);
});

function createSyntheticEnv() {
  const platformStore = new MemoryPlatformStore({
    now: () => NOW,
    idFactory: sequenceIdFactory(),
    tokenFactory: sequenceTokenFactory()
  });
  const chartingStore = new MemoryChartingStore({
    now: () => NOW,
    idFactory: sequenceIdFactory()
  });
  const feeStore = new MemoryFeeStore({
    now: () => NOW,
    idFactory: sequenceIdFactory()
  });
  const feeCalculator = {
    async calculate() {
      return {
        provider: "synthetic_fee_engine",
        source: "core-e2e",
        status: "completed",
        totalPoints: 88,
        lineItems: [{
          lineId: "line_1",
          code: "160000410",
          name: "血液検査",
          orderType: "lab",
          points: 88,
          quantity: 1,
          totalPoints: 88,
          status: "candidate",
          source: "core-e2e"
        }]
      };
    }
  };
  const referralStore = new MemoryReferralStore({
    now: () => NOW,
    idFactory: sequenceIdFactory()
  });

  return {
    platformStore,
    chartingStore,
    feeStore,
    referralStore,
    platform: (method, path, body, headers = {}) => handlePlatformApiRequest({
      method,
      path,
      body,
      headers,
      store: platformStore,
      env: "test",
      now: NOW,
      sessionSecret: SESSION_SECRET,
      projectId: "medical-core-stg",
      region: "asia-northeast1"
    }),
    charting: (method, path, body, headers = {}) => handleChartingApiRequest({
      method,
      path,
      body,
      headers,
      platformStore,
      chartingStore,
      env: "test",
      now: NOW,
      sessionSecret: SESSION_SECRET
    }),
    fee: (method, path, body, headers = {}) => handleFeeApiRequest({
      method,
      path,
      body,
      headers,
      platformStore,
      feeStore,
      feeCalculator,
      env: "test",
      now: NOW,
      sessionSecret: SESSION_SECRET
    }),
    referral: (method, path, body, headers = {}) => handleReferralApiRequest({
      method,
      path,
      body,
      headers,
      platformStore,
      referralStore,
      env: "test",
      now: NOW,
      sessionSecret: SESSION_SECRET
    })
  };
}

async function signupAndLogin(env, input) {
  const created = await env.platform("POST", "/v1/signup/applications", input);
  const provisioned = await env.platform("POST", "/v1/signup/verify-email", {
    token: created.body.emailVerification.token
  });
  await env.platform("POST", "/v1/signup/setup-admin-password", {
    token: provisioned.body.passwordSetup.token,
    password: "correct horse battery staple"
  });
  const login = await env.platform("POST", "/v1/auth/login", {
    organizationCode: provisioned.body.organization.organizationCode,
    loginId: provisioned.body.adminMember.loginId,
    password: "correct horse battery staple"
  });

  return {
    session: login.body.session,
    headers: authHeaders(login)
  };
}

function createDirectMember(env, input) {
  const organization = env.platformStore.createOrganization({
    organizationCode: input.organizationCode,
    displayName: input.displayName
  });
  const member = env.platformStore.createMember(organization.orgId, {
    loginId: input.loginId,
    displayName: input.loginId,
    globalRoles: input.globalRoles,
    password: "correct horse battery staple"
  });

  return { organization, member };
}

function authHeaders(loginResponse) {
  return {
    cookie: cookieHeaderFromSetCookie(loginResponse.headers["set-cookie"]),
    "x-csrf-token": loginResponse.body.csrfToken
  };
}

function cookieHeaderFromSetCookie(setCookieHeaders = []) {
  return setCookieHeaders.map((header) => header.split(";")[0]).join("; ");
}

function sequenceIdFactory() {
  let counter = 0;
  return (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`;
}

function sequenceTokenFactory() {
  let counter = 0;
  return (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`;
}
