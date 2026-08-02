import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../../packages/auth-client/src/index.js";
import { CARE_EMERGENCY_INPUT_COLUMNS } from "../../../packages/care-fee-contracts/src/index.js";
import {
  parseCareEmergencyCsv,
  serializeCareEmergencyCsv
} from "../../../packages/care-fee-core/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { handleCareFeeApiRequest } from "../src/server.js";
import { MemoryCareFeeStore } from "../src/store/memory-store.js";

const sampleBytes = readFileSync(new URL("../../../samples/care-fee/emergency-treatment-template.csv", import.meta.url));
const sampleRow = parseCareEmergencyCsv(sampleBytes).rows[0].values;

test("requires Platform care_fee access", async () => {
  const response = await request(createStores(), "GET", "/v1/care-fee/context");
  assert.equal(response.statusCode, 401);
});

test("evaluates a spot CSV and stores metadata without input or result rows", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings());
  const response = await request(stores, "POST", "/v1/care-fee/evaluations/csv", {
    facilityId: "fac_001",
    fileName: "emergency.csv",
    fileBase64: sampleBytes.toString("base64")
  }, headers);
  const jobs = stores.careFeeStore.listImportJobs("org_001");
  const stored = JSON.stringify(jobs[0]);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.result.summary.statusCounts.billing_candidate, 1);
  assert.equal(response.body.result.summary.candidateUnits, 518);
  assert.equal(jobs.length, 1);
  assert.equal(stored.includes("source_excerpt"), false);
  assert.equal(stored.includes("fileBase64"), false);
  assert.equal(stored.includes("outputBase64"), false);
  assert.equal(Buffer.from(response.body.result.outputBase64, "base64").subarray(0, 3).toString("hex"), "efbbbf");
});

test("rejects a selected facility whose configured code differs from the CSV", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings({ facilityCode: "different" }));
  const response = await request(stores, "POST", "/v1/care-fee/evaluations/csv", {
    facilityId: "fac_001",
    fileName: "emergency.csv",
    fileBase64: sampleBytes.toString("base64")
  }, headers);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /facility_code/u);
  assert.equal(stores.careFeeStore.listImportJobs("org_001").length, 0);
});

test("imports valid CSV rows into monthly management idempotently while preserving row errors", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings());
  const invalidRow = {
    ...sampleRow,
    patient_key: "patient-invalid",
    episode_key: "episode-invalid",
    source_record_id: "record-invalid",
    emergency_care_required: "invalid"
  };
  const bytes = serializeCareEmergencyCsv(CARE_EMERGENCY_INPUT_COLUMNS, [sampleRow, invalidRow]);
  const body = {
    facilityId: "fac_001",
    fileName: "managed.csv",
    fileBase64: bytes.toString("base64")
  };
  const first = await request(stores, "POST", "/v1/care-fee/imports/csv", body, headers);
  const second = await request(stores, "POST", "/v1/care-fee/imports/csv", body, headers);
  const episodes = stores.careFeeStore.listEpisodes("org_001");
  const claims = stores.careFeeStore.listMonthlyClaims("org_001");
  const jobs = stores.careFeeStore.listImportJobs("org_001");

  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body.importSummary, {
    acceptedRowCount: 1,
    importErrorRowCount: 1,
    persistedEpisodeCount: 1,
    createdEpisodeCount: 1,
    updatedEpisodeCount: 0,
    unchangedEpisodeCount: 0
  });
  assert.equal(first.body.result.rows[1].judgment_status, "import_error");
  assert.equal(second.body.importSummary.createdEpisodeCount, 0);
  assert.equal(second.body.importSummary.unchangedEpisodeCount, 1);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].decisionStatus, "pending");
  assert.equal(episodes[0].source.sourceProduct, "csv_upload");
  assert.equal(episodes[0].source.sourceRecordId, sampleRow.source_record_id);
  assert.equal(claims.length, 0);
  assert.equal(jobs.length, 2);
  assert.equal(JSON.stringify(jobs).includes("source_excerpt"), false);
});

test("persists managed episodes, confirms once per patient-month, and reruns monthly idempotently", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings());
  const evaluated = await request(stores, "POST", "/v1/care-fee/episodes/evaluate", {
    facilityId: "fac_001",
    rows: [sampleRow],
    sourceProduct: "manual",
    sourceRecordId: "manual-001"
  }, headers);
  const episodeId = evaluated.body.episodes[0].episodeId;
  const confirmed = await request(stores, "POST", `/v1/care-fee/episodes/${episodeId}/decision`, {
    status: "confirmed"
  }, headers);
  const firstRun = await request(stores, "POST", "/v1/care-fee/monthly-runs", {
    facilityId: "fac_001",
    claimMonth: "2026-08",
    timezone: "Asia/Tokyo"
  }, headers);
  const secondRun = await request(stores, "POST", "/v1/care-fee/monthly-runs", {
    facilityId: "fac_001",
    claimMonth: "2026-08",
    timezone: "Asia/Tokyo"
  }, headers);

  assert.equal(evaluated.statusCode, 200);
  assert.equal(evaluated.body.episodes[0].decisionStatus, "pending");
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.body.episode.decisionStatus, "confirmed");
  assert.equal(confirmed.body.claim.totalUnits, 518);
  assert.equal(firstRun.statusCode, 200);
  assert.equal(firstRun.body.reused, false);
  assert.equal(firstRun.body.run.coverage.sourceEpisodeCount, 1);
  assert.equal(secondRun.body.reused, true);
  assert.equal(firstRun.body.run.runId, secondRun.body.run.runId);
});

test("ingests Fee evidence idempotently through a dedicated service token", async () => {
  const stores = createStores();
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings());
  const body = {
    contractVersion: "care-fee-evidence-v1",
    orgId: "org_001",
    sourceProduct: "fee",
    sourceRecordId: "fee-session-001",
    sourceRevisionHash: "a".repeat(64),
    organizationCode: "clinic",
    facilityId: "fac_001",
    facilityCode: "facility-001",
    patientKey: "patient-001",
    observedAt: "2026-08-01T10:00:00+09:00",
    rows: [{ ...sampleRow, input_origin: "fee_app" }]
  };
  const first = await request(stores, "POST", "/v1/care-fee/internal/evidence", body, {
    authorization: "Bearer ingest-test-token"
  });
  const second = await request(stores, "POST", "/v1/care-fee/internal/evidence", body, {
    authorization: "Bearer ingest-test-token"
  });
  const denied = await request(stores, "POST", "/v1/care-fee/internal/evidence", body, {
    authorization: "Bearer wrong"
  });

  assert.equal(first.statusCode, 201);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(first.body.receipt.receiptId, second.body.receipt.receiptId);
  assert.equal(stores.careFeeStore.listEpisodes("org_001").length, 1);
  assert.equal(denied.statusCode, 401);
});

test("runs the internal monthly review idempotently without confirming candidates", async () => {
  const stores = createStores();
  const headers = await signedHeaders(stores.platformStore);
  stores.careFeeStore.upsertFacilitySettings("org_001", facilitySettings());
  const evaluated = await request(stores, "POST", "/v1/care-fee/episodes/evaluate", {
    facilityId: "fac_001",
    rows: [sampleRow],
    sourceProduct: "fee",
    sourceRecordId: "fee-session-monthly-001"
  }, headers);
  const body = {
    orgId: "org_001",
    facilityId: "fac_001",
    claimMonth: "2026-08",
    timezone: "Asia/Tokyo"
  };
  const denied = await request(stores, "POST", "/v1/care-fee/internal/monthly-runs/run", body);
  const first = await request(stores, "POST", "/v1/care-fee/internal/monthly-runs/run", body, {
    authorization: "Bearer monthly-test-token"
  });
  const second = await request(stores, "POST", "/v1/care-fee/internal/monthly-runs/run", body, {
    authorization: "Bearer monthly-test-token"
  });
  const episode = stores.careFeeStore.getEpisode("org_001", evaluated.body.episodes[0].episodeId);
  const monthlyAudits = stores.careFeeStore.listAuditLogs("org_001")
    .filter((entry) => entry.eventType === "care_fee.monthly_review_completed");

  assert.equal(denied.statusCode, 401);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.reused, false);
  assert.equal(first.body.run.actorMemberId, "service");
  assert.equal(first.body.run.coverage.sourceEpisodeCount, 1);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.run.runId, first.body.run.runId);
  assert.equal(episode.decisionStatus, "pending");
  assert.equal(stores.careFeeStore.listMonthlyClaims("org_001").length, 0);
  assert.equal(monthlyAudits.length, 1);
  assert.equal(monthlyAudits[0].actorMemberId, "service");
});

test("reports monthly automation readiness from the injected environment", async () => {
  const stores = createStores();
  const response = await handleCareFeeApiRequest({
    method: "GET",
    path: "/readyz",
    platformStore: stores.platformStore,
    careFeeStore: stores.careFeeStore,
    env: "test",
    processEnv: { CARE_FEE_MONTHLY_WORKER_AUTH_MODE: "iam" }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.automation, {
    monthlyWorkerReady: true,
    monthlyWorkerAuthMode: "iam"
  });
});

test("care-fee-api has no sibling product store dependency", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.equal(source.includes("../../fee-api/"), false);
  assert.equal(source.includes("feeSessions"), false);
  assert.equal(source.includes("OPENAI"), false);
});

function createStores(options = {}) {
  const counters = new Map();
  const idFactory = (prefix) => {
    const next = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(3, "0")}`;
  };
  const now = () => new Date("2026-08-02T00:00:00.000Z");
  const platformStore = new MemoryPlatformStore({ now, idFactory, tokenFactory: idFactory });
  const careFeeStore = new MemoryCareFeeStore({ now, idFactory });
  const organization = platformStore.createOrganization({ organizationCode: "Clinic", displayName: "Clinic" });
  platformStore.createMember(organization.orgId, {
    loginId: "care-admin",
    displayName: "Care Admin",
    globalRoles: options.globalRoles ?? ["org_admin"],
    productRoles: options.productRoles ?? { care_fee: ["admin"] },
    password: "correct horse battery staple"
  });
  platformStore.createFacility(organization.orgId, {
    displayName: "西山介護医療院",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo"
  });
  if (options.entitlement !== false) {
    platformStore.upsertProductEntitlement(organization.orgId, { productId: "care_fee", status: "trialing" });
  }
  return { platformStore, careFeeStore };
}

async function signedHeaders(platformStore) {
  const initial = platformStore.getLoginIdentity("clinic", "care-admin");
  const identity = initial.mfaRequired && !initial.mfaEnrolled
    ? platformStore.completeMfaEnrollment(platformStore.beginMfaEnrollment(initial, "MZXW6YTBOI======"))
    : initial;
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: ["org_admin"],
    productRoles: { care_fee: ["admin"] },
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true,
    csrfToken: "csrf_care_test"
  }, {
    now: new Date("2026-08-02T00:00:00.000Z"),
    sessionSecret: "test-session-secret"
  });
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

function request(stores, method, path, body, headers = {}) {
  return handleCareFeeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    careFeeStore: stores.careFeeStore,
    env: "test",
    projectId: "halunasu-care-stg",
    region: "asia-northeast1",
    now: new Date("2026-08-02T00:00:00.000Z"),
    startedAt: new Date("2026-08-02T00:00:00.000Z"),
    sessionSecret: "test-session-secret",
    ingestToken: "ingest-test-token",
    monthlyWorkerToken: "monthly-test-token",
    processEnv: {}
  });
}

function facilitySettings(overrides = {}) {
  return {
    facilityId: "fac_001",
    facilityCode: "facility-001",
    careOfficeNumber: "1234567890",
    timezone: "Asia/Tokyo",
    emergencyServiceCodes: { care_medical_institution: "556000" },
    facilityVariants: {},
    enabled: true,
    ...overrides
  };
}
