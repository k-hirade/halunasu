#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  parseCookies
} from "../packages/auth-client/src/index.js";
import { createSignedSession } from "../services/platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../services/platform-api/src/store/memory-store.js";
import { MemoryFeeStore } from "../services/fee-api/src/store/memory-store.js";
import { handleFeeApiRequest } from "../services/fee-api/src/server.js";
import { createFeeCalculatorFromEnv } from "../services/fee-api/src/python-calculator.js";

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers = []) {
    for (const header of headers) {
      const first = String(header || "").split(";")[0];
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
    }
  }

  get(name) {
    return this.cookies.get(name) || "";
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  parsed() {
    return parseCookies(this.header());
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(repoRoot, "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const reportDir = path.join(repoRoot, "data/tests/fee-soap-e2e/reports");
const defaultNow = new Date("2026-06-07T00:00:00.000Z");
const localSessionSecret = "fee-soap-e2e-local-session-secret";
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const dataset = readJson(datasetPath);
const selectedCases = selectCases(dataset.cases || [], args);
if (!selectedCases.length) {
  throw new Error("No cases matched the selected filters");
}

const startedAt = Date.now();
const facilityFixtureAudit = buildFacilityFixtureAudit(selectedCases);
const runner = args.mode === "stg"
  ? await createStgRunner(args, facilityFixtureAudit)
  : await createLocalRunner(args, facilityFixtureAudit);
const results = [];

for (const item of selectedCases) {
  const result = await evaluateCase(item, runner, args);
  results.push(result);
  if (args.verbose || result.status !== "passed") {
    console.log(`${result.status.toUpperCase()} ${result.caseId} stage=${result.failedStage || "-"} total=${result.actual.totalPoints ?? "-"}ms=${result.durationMs.total}`);
  }
}

await runner.close?.();

const summary = buildSummary(results, {
  mode: args.mode,
  strict: args.strict,
  selected: selectedCases.length,
  totalDatasetCases: dataset.cases?.length || 0,
  durationMs: Date.now() - startedAt
});
const report = {
  schemaVersion: "fee-soap-e2e-evaluation.v1",
  generatedAt: new Date().toISOString(),
  datasetId: dataset.datasetId,
  datasetVersion: dataset.version || null,
  datasetPath: path.relative(repoRoot, datasetPath),
  mode: args.mode,
  filters: {
    caseId: args.caseId || null,
    assertionLevel: args.assertionLevel || null,
    limit: args.limit || null
  },
  security: {
    syntheticDataOnly: true,
    soapTextIncluded: false,
    credentialsIncluded: false,
    reportContainsSecrets: false
  },
  summary,
  facilityFixtureAudit: {
    ...facilityFixtureAudit,
    runnerMode: runner.facilityFixture?.mode || args.mode,
    seededFacilityStandards: runner.facilityFixture?.seededFacilityStandards || []
  },
  results
};

writeReports(report, args);
printSummary(summary);

if (args.strict && summary.failed > 0) {
  process.exitCode = 1;
}

async function evaluateCase(item, runner, options) {
  const caseStartedAt = Date.now();
  const caseResult = emptyCaseResult(item);
  caseResult.facilityFixture = runner.facilityFixture || caseResult.facilityFixture;
  try {
    const historySeed = await seedVisitHistoryIfNeeded(item, runner, options, caseResult);
    if (historySeed?.failed) {
      return failCase(caseResult, "api_contract", historySeed.message, caseStartedAt);
    }

    const createPayload = buildCreateSessionPayload(item, runner, {
      patientId: historySeed?.patientId || "",
      sourceSystem: "fee_soap_e2e_dataset"
    });
    const createStartedAt = Date.now();
    const createResponse = await runner.request("POST", "/v1/fee/sessions", createPayload, { csrf: true });
    caseResult.durationMs.createSession = Date.now() - createStartedAt;
    caseResult.http.createSession = responseView(createResponse);
    if (createResponse.statusCode >= 400) {
      return failCase(caseResult, "api_contract", `create session failed: ${safeErrorMessage(createResponse.body)}`, caseStartedAt);
    }

    const feeSessionId = createResponse.body?.feeSession?.feeSessionId;
    if (!feeSessionId) {
      return failCase(caseResult, "api_contract", "create session response did not include feeSessionId");
    }
    caseResult.feeSessionId = feeSessionId;

    const calculateStartedAt = Date.now();
    const calculateResponse = await runner.request("POST", `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/calculate`, {}, {
      csrf: true,
      body: buildCalculatePayload(item, options)
    });
    caseResult.durationMs.calculateRequest = Date.now() - calculateStartedAt;
    caseResult.http.calculate = responseView(calculateResponse);
    if (calculateResponse.statusCode >= 400) {
      return failCase(caseResult, "api_contract", `calculate failed: ${safeErrorMessage(calculateResponse.body)}`, caseStartedAt);
    }

    const detailStartedAt = Date.now();
    const detailResponse = await runner.request("GET", `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail`);
    caseResult.durationMs.detail = Date.now() - detailStartedAt;
    caseResult.http.detail = responseView(detailResponse);
    if (detailResponse.statusCode >= 400) {
      return failCase(caseResult, "api_contract", `detail failed: ${safeErrorMessage(detailResponse.body)}`, caseStartedAt);
    }

    const detail = detailResponse.body || {};
    const feeSession = detail.feeSession || calculateResponse.body?.feeSession || {};
    const calculationResult = feeSession.calculationResult || calculateResponse.body?.calculationResult || {};
    const reviewItems = Array.isArray(detail.reviewItems) ? detail.reviewItems : (calculateResponse.body?.reviewItems || []);
    const candidateWorkbench = detail.candidateWorkbench || calculateResponse.body?.candidateWorkbench || {};
    Object.assign(caseResult.actual, actualView({ feeSession, calculationResult, reviewItems, candidateWorkbench }));
    Object.assign(caseResult.durationMs, durationView({ feeSession, calculationResponse: calculateResponse, caseStartedAt }));
    caseResult.accuracy = accuracyView(item, caseResult.actual);
    caseResult.missing = missingView(item, caseResult.actual);
    caseResult.unexpected = unexpectedView(item, caseResult.actual);
    caseResult.status = casePassed(item, caseResult) ? "passed" : "failed";
    caseResult.failedStage = caseResult.status === "passed" ? null : failedStage(item, caseResult);
    caseResult.failureMessages = caseResult.status === "passed" ? [] : failureMessages(item, caseResult);
    caseResult.durationMs.total = Date.now() - caseStartedAt;
    return caseResult;
  } catch (error) {
    caseResult.durationMs.total = Date.now() - caseStartedAt;
    return failCase(caseResult, "api_contract", safeExceptionMessage(error));
  }
}

async function seedVisitHistoryIfNeeded(item, runner, options, caseResult) {
  const required = shouldSeedPriorVisitHistory(item, options);
  caseResult.historySeed.required = required;
  caseResult.historySeed.reason = required ? visitHistorySeedReason(item) : "none";
  if (!required) {
    return null;
  }

  const seedPayload = buildPriorVisitHistoryPayload(item, runner);
  const seedStartedAt = Date.now();
  const seedResponse = await runner.request("POST", "/v1/fee/sessions", seedPayload, { csrf: true });
  caseResult.durationMs.seedVisitHistory = Date.now() - seedStartedAt;
  caseResult.http.seedVisitHistory = responseView(seedResponse);
  if (seedResponse.statusCode >= 400) {
    const message = `seed prior visit history failed: ${safeErrorMessage(seedResponse.body)}`;
    caseResult.historySeed = {
      ...caseResult.historySeed,
      created: false,
      failed: true,
      message
    };
    return caseResult.historySeed;
  }

  const feeSession = seedResponse.body?.feeSession || {};
  const patientId = feeSession.patientId || "";
  if (!patientId) {
    const message = "seed prior visit history response did not include patientId";
    caseResult.historySeed = {
      ...caseResult.historySeed,
      created: false,
      failed: true,
      message
    };
    return caseResult.historySeed;
  }

  caseResult.historySeed = {
    ...caseResult.historySeed,
    created: true,
    failed: false,
    feeSessionId: feeSession.feeSessionId || null,
    patientId,
    serviceDate: seedPayload.serviceDate || null
  };
  return caseResult.historySeed;
}

function shouldSeedPriorVisitHistory(item, options = {}) {
  if (options.seedVisitHistory === false) {
    return false;
  }
  const encounter = item.encounter || {};
  const setting = encounter.setting === "inpatient" ? "inpatient" : "outpatient";
  if (setting !== "outpatient") {
    return false;
  }
  const visitType = String(encounter.visitType || encounter.visit_type || "").trim().toLowerCase();
  const expectedFeeKind = String(item.expectedClaimContext?.outpatient_basic?.fee_kind || "").trim().toLowerCase();
  return visitType === "revisit" || expectedFeeKind === "revisit";
}

function visitHistorySeedReason(item) {
  const encounter = item.encounter || {};
  const visitType = String(encounter.visitType || encounter.visit_type || "").trim().toLowerCase();
  const expectedFeeKind = String(item.expectedClaimContext?.outpatient_basic?.fee_kind || "").trim().toLowerCase();
  if (visitType === "revisit") return "encounter.visitType=revisit";
  if (expectedFeeKind === "revisit") return "expectedClaimContext.outpatient_basic.fee_kind=revisit";
  return "none";
}

function buildPriorVisitHistoryPayload(item, runner = {}) {
  const payload = buildCreateSessionPayload(item, runner, {
    serviceDate: priorServiceDate(serviceDateForCase(item)),
    clinicalText: priorVisitHistoryClinicalText(item),
    sourceSystem: "fee_soap_e2e_dataset_prior_history"
  });
  payload.claimMonth = payload.serviceDate ? payload.serviceDate.slice(0, 7) : undefined;
  return payload;
}

function buildCreateSessionPayload(item, runner = {}, overrides = {}) {
  const patient = item.patient || {};
  const encounter = item.encounter || {};
  const expectedEncounter = item.expectedClaimContext?.encounter || {};
  const patientId = String(overrides.patientId || "").trim();
  const payload = {
    facilityId: runner.facilityId || "fac_fee_e2e",
    departmentId: departmentIdForEncounter(encounter, runner.departmentIds),
    serviceDate: overrides.serviceDate || serviceDateForCase(item),
    setting: encounter.setting === "inpatient" ? "inpatient" : "outpatient",
    clinicalText: overrides.clinicalText || item.chart?.standard || soapText(item),
    sourceSystem: overrides.sourceSystem || "fee_soap_e2e_dataset"
  };
  if (patientId) {
    payload.patientId = patientId;
  } else {
    payload.patient = {
      displayName: `E2E ${item.caseId}`,
      sex: ["male", "female", "other", "unknown"].includes(patient.sex) ? patient.sex : "unknown",
      externalPatientIds: [item.caseId]
    };
  }
  if (expectedEncounter.admission_date || encounter.admissionDate || encounter.admission_date) {
    payload.admissionDate = expectedEncounter.admission_date || encounter.admissionDate || encounter.admission_date;
  }
  return payload;
}

function serviceDateForCase(item) {
  const encounter = item.encounter || {};
  return encounter.serviceDate || encounter.service_date || "2026-06-07";
}

function priorServiceDate(serviceDate) {
  const date = new Date(`${serviceDate || "2026-06-07"}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return "2026-06-06";
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function priorVisitHistoryClinicalText(item) {
  return [
    "S: E2Eの再診判定用に作成する過去受診記録。",
    "O: 過去に同一患者として外来診療を受けた記録。",
    "A: 継続診療の履歴。",
    "P: 経過観察。"
  ].join("\n");
}

function buildCalculatePayload(item, options) {
  if (options.useExpectedClaimContext && item.expectedClaimContext) {
    return { claimContext: item.expectedClaimContext };
  }
  return {};
}

function buildFacilityFixtureAudit(cases = []) {
  const exactRequired = new Set();
  const reviewFacilityCases = [];
  for (const item of cases) {
    const level = String(item.expectedCalculation?.assertionLevel || "").trim();
    for (const key of asStrings(item.expectedClaimContext?.facility_standard_keys)) {
      if (level === "exact") {
        exactRequired.add(key);
      }
    }
    const chart = normalizeText(soapText(item));
    if (level !== "exact" && /(施設基準|届出|届け出|地方厚生局)/u.test(chart)) {
      reviewFacilityCases.push(item.caseId);
    }
  }
  const seededFacilityStandardKeys = [...exactRequired].sort();
  const collisions = [];
  return {
    fixtureKey: "default",
    seededFacilityStandardKeys,
    exactRequiredFacilityStandardKeys: seededFacilityStandardKeys,
    facilityUnknownCaseIds: reviewFacilityCases,
    collisions,
    collisionPolicy: collisions.length ? "case_group_fixture_required" : "single_fixture_ok"
  };
}

async function createLocalRunner(options, facilityFixtureAudit = {}) {
  let idCounter = 0;
  const idFactory = (prefix) => {
    idCounter += 1;
    if (prefix === "fac") return "fac_fee_e2e";
    if (prefix === "dep") return `dep_fee_e2e_${idCounter}`;
    return `${prefix}_fee_e2e_${String(idCounter).padStart(4, "0")}`;
  };
  const platformStore = new MemoryPlatformStore({
    now: () => defaultNow,
    idFactory,
    tokenFactory: (prefix) => `${prefix}_fee_e2e_${String(++idCounter).padStart(4, "0")}`
  });
  const feeStore = new MemoryFeeStore({
    now: () => defaultNow,
    idFactory
  });
  const organization = platformStore.createOrganization({
    organizationCode: "fee-e2e",
    displayName: "診療報酬算定E2E専用",
    status: "trialing"
  });
  const member = platformStore.createMember(organization.orgId, {
    loginId: "fee-e2e-runner",
    displayName: "Fee E2E Runner",
    globalRoles: [],
    productRoles: { fee: ["medical_clerk"] },
    password: "local only fee e2e runner password"
  });
  const facility = platformStore.createFacility(organization.orgId, {
    displayName: "E2E検証クリニック",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo",
    facilityStandardKeys: facilityFixtureAudit.seededFacilityStandardKeys || []
  });
  const departments = [
    ["internal_medicine", "内科", "01"],
    ["pediatrics", "小児科", "10"],
    ["dermatology", "皮膚科", "12"],
    ["surgery", "外科", "03"],
    ["orthopedics", "整形外科", "11"],
    ["psychiatry", "精神科", "20"],
    ["general", "General", "00"]
  ];
  const departmentIds = {};
  for (const [key, displayName, code] of departments) {
    const department = platformStore.createDepartment(organization.orgId, {
      facilityId: facility.facilityId,
      displayName,
      code
    });
    departmentIds[key] = department.departmentId;
  }
  platformStore.upsertProductEntitlement(organization.orgId, {
    productId: "fee",
    status: "trialing",
    source: "e2e"
  });
  const { token, session } = createSignedSession({
    orgId: organization.orgId,
    memberId: member.memberId,
    organizationCode: organization.organizationCode,
    loginId: member.loginId,
    tokenVersion: 1,
    globalRoles: [],
    productRoles: { fee: ["medical_clerk"] },
    csrfToken: "csrf_fee_e2e",
    mfaVerified: false
  }, {
    now: defaultNow,
    sessionSecret: localSessionSecret
  });
  const headers = {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
  const feeCalculator = createFeeCalculatorFromEnv({
    ...process.env,
    FEE_MASTER_DB_PATH: options.masterDbPath || process.env.FEE_MASTER_DB_PATH || path.join(repoRoot, "python/data/master/standard-master.sqlite"),
    FEE_PYTHONPATH: process.env.FEE_PYTHONPATH || path.join(repoRoot, "python"),
    FEE_CALCULATOR_TIMEOUT_MS: String(options.caseTimeoutMs || process.env.FEE_CALCULATOR_TIMEOUT_MS || 60000),
    FEE_PYTHON_WORKER: options.spawnPython ? "0" : (process.env.FEE_PYTHON_WORKER || "1")
  });

  return {
    facilityId: facility.facilityId,
    departmentIds,
    facilityFixture: {
      mode: "local_fixture",
      fixtureKey: facilityFixtureAudit.fixtureKey || "default",
      seededFacilityStandards: facilityFixtureAudit.seededFacilityStandardKeys || [],
      collisions: facilityFixtureAudit.collisions || []
    },
    async request(method, apiPath, body = undefined, requestOptions = {}) {
      const requestBody = requestOptions.body !== undefined ? requestOptions.body : body;
      const requestHeaders = requestOptions.csrf ? headers : { cookie: headers.cookie };
      const execute = () => handleFeeApiRequest({
        method,
        path: apiPath,
        body: requestBody,
        headers: requestHeaders,
        platformStore,
        feeStore,
        feeCalculator,
        env: "local",
        projectId: "medical-core-stg",
        region: "asia-northeast1",
        startedAt: defaultNow,
        now: defaultNow,
        sessionSecret: localSessionSecret,
        openAiApiKey: options.openai ? process.env.OPENAI_API_KEY : "",
        openAiFeeClinicalModel: options.openai ? (process.env.OPENAI_FEE_CLINICAL_MODEL || process.env.OPENAI_FACT_MODEL) : "",
        openAiFeeClinicalReasoningEffort: options.openai ? (process.env.OPENAI_FEE_CLINICAL_REASONING_EFFORT || "minimal") : "minimal",
        openAiFeeClinicalTimeoutMs: Number(process.env.OPENAI_FEE_CLINICAL_TIMEOUT_MS || 0)
      });
      return options.verboseApiLogs ? execute() : withSuppressedConsoleInfo(execute);
    },
    close() {
      feeCalculator.stopWorker?.();
    }
  };
}

async function createStgRunner(options, facilityFixtureAudit = {}) {
  const platformBaseUrl = normalizedBaseUrl(process.env.FEE_E2E_PLATFORM_BASE_URL || process.env.PLATFORM_API_BASE_URL);
  const feeBaseUrl = normalizedBaseUrl(process.env.FEE_E2E_FEE_BASE_URL || process.env.FEE_API_BASE_URL);
  const organizationCode = process.env.FEE_E2E_ORGANIZATION_CODE;
  const loginId = process.env.FEE_E2E_LOGIN_ID;
  const password = process.env.FEE_E2E_PASSWORD;
  const mfaCode = process.env.FEE_E2E_MFA_CODE || "";
  if (!platformBaseUrl || !feeBaseUrl || !organizationCode || !loginId || !password) {
    throw new Error("STG mode requires FEE_E2E_PLATFORM_BASE_URL, FEE_E2E_FEE_BASE_URL, FEE_E2E_ORGANIZATION_CODE, FEE_E2E_LOGIN_ID, and FEE_E2E_PASSWORD");
  }

  const jar = new CookieJar();
  const loginBody = { organizationCode, loginId, password };
  if (mfaCode) loginBody.mfaCode = mfaCode;
  const login = await httpJson(`${platformBaseUrl}/v1/auth/login`, {
    method: "POST",
    body: loginBody,
    jar
  });
  if (login.statusCode >= 400) {
    throw new Error(`STG login failed: ${safeErrorMessage(login.body)}`);
  }
  const csrfToken = login.body?.csrfToken || jar.get(CSRF_COOKIE_NAME) || jar.get("halunasu_stg_csrf");
  if (!csrfToken) {
    throw new Error("STG login did not return a CSRF token");
  }
  const sessionResponse = await httpJson(`${platformBaseUrl}/v1/auth/session`, {
    method: "GET",
    jar
  });
  if (sessionResponse.statusCode >= 400 || !sessionResponse.body?.session?.orgId) {
    throw new Error(`STG session lookup failed: ${safeErrorMessage(sessionResponse.body)}`);
  }
  const orgId = sessionResponse.body.session.orgId;
  const bootstrap = await httpJson(`${platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/admin-bootstrap?section=departments`, {
    method: "GET",
    jar,
    headers: { "x-csrf-token": csrfToken }
  });
  if (bootstrap.statusCode >= 400) {
    throw new Error(`STG organization bootstrap failed: ${safeErrorMessage(bootstrap.body)}`);
  }
  const { facilityId, departmentIds } = stgFacilityContext(bootstrap.body || {});

  return {
    facilityId,
    departmentIds,
    facilityFixture: {
      mode: "stg_existing_facility",
      fixtureKey: facilityFixtureAudit.fixtureKey || "stg-existing",
      seededFacilityStandards: [],
      expectedFacilityStandards: facilityFixtureAudit.seededFacilityStandardKeys || [],
      collisions: facilityFixtureAudit.collisions || []
    },
    async request(method, apiPath, body = undefined, requestOptions = {}) {
      const requestBody = requestOptions.body !== undefined ? requestOptions.body : body;
      return httpJson(`${feeBaseUrl}${apiPath}`, {
        method,
        body: requestBody,
        jar,
        headers: requestOptions.csrf ? { "x-csrf-token": csrfToken } : {}
      });
    },
    close() {}
  };
}

function stgFacilityContext(bootstrap) {
  const facilities = Array.isArray(bootstrap.facilities) ? bootstrap.facilities : [];
  const departments = Array.isArray(bootstrap.departments) ? bootstrap.departments : [];
  const facilityId = process.env.FEE_E2E_FACILITY_ID
    || facilities.find((facility) => facility.status === "active")?.facilityId
    || facilities[0]?.facilityId
    || "";
  const departmentId = process.env.FEE_E2E_DEPARTMENT_ID
    || departments.find((department) => (
      department.status === "active"
      && (!facilityId || !department.facilityId || department.facilityId === facilityId)
    ))?.departmentId
    || departments[0]?.departmentId
    || "";
  if (!facilityId) {
    throw new Error("STG organization does not have an active facility for fee E2E");
  }
  if (!departmentId) {
    throw new Error("STG organization does not have an active department for fee E2E");
  }
  return {
    facilityId,
    departmentIds: {
      internal_medicine: departmentId,
      pediatrics: departmentId,
      dermatology: departmentId,
      surgery: departmentId,
      orthopedics: departmentId,
      psychiatry: departmentId,
      general: departmentId
    }
  };
}

function actualView({ feeSession, calculationResult, reviewItems, candidateWorkbench }) {
  const lineItems = Array.isArray(calculationResult.lineItems) ? calculationResult.lineItems : [];
  const candidateProposals = Array.isArray(candidateWorkbench?.proposals) ? candidateWorkbench.proposals : [];
  const reviewText = [
    ...(Array.isArray(calculationResult.warnings) ? calculationResult.warnings : []),
    ...reviewItems.flatMap((item) => [item.title, item.message, item.reason]),
    ...candidateProposals.flatMap((item) => [item.title, item.reason, item.name])
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return {
    status: feeSession.status || null,
    engineStatus: calculationResult.engineStatus || calculationResult.status || null,
    totalPoints: Number(calculationResult.totalPoints || 0),
    candidateCodes: uniqueStrings([
      ...(Array.isArray(calculationResult.candidateCodes) ? calculationResult.candidateCodes : []),
      ...lineItems.map((line) => line.code)
    ]),
    lineItems: lineItems.map((line) => ({
      code: String(line.code || ""),
      name: String(line.name || ""),
      status: String(line.status || ""),
      supportLevel: line.supportLevel || line.coverage?.supportLevel || null,
      reviewRequired: Boolean(line.reviewRequired || line.coverage?.reviewRequired),
      totalPoints: Number(line.totalPoints || line.points || 0)
    })),
    diagnoses: (feeSession.diagnoses || []).map((diagnosis) => diagnosis.name || diagnosis).filter(Boolean),
    calculationOptionsSource: feeSession.calculationOptionsSource || null,
    calculationOptionsAutoKeys: feeSession.calculationOptionsAutoKeys || [],
    reviewItems: reviewItems.map((item) => ({
      title: item.title || item.name || "確認事項",
      message: item.message || item.reason || "",
      status: item.status || "",
      severity: item.severity || ""
    })),
    candidateProposals: candidateProposals.map((item) => ({
      title: item.title || item.name || "",
      name: item.name || "",
      reason: item.reason || "",
      points: Number(item.points || item.totalPoints || 0)
    })),
    reviewText,
    progress: feeSession.calculationProgress || null
  };
}

function durationView({ feeSession, calculationResponse, caseStartedAt }) {
  const progressMetrics = feeSession.calculationProgress?.metrics || {};
  const timings = Array.isArray(progressMetrics.stageTimings)
    ? progressMetrics.stageTimings
    : Array.isArray(calculationResponse.body?.feeSession?.calculationProgress?.metrics?.stageTimings)
      ? calculationResponse.body.feeSession.calculationProgress.metrics.stageTimings
      : [];
  const byStage = {};
  for (const item of timings) {
    const stage = item.stage || item.name;
    if (stage) byStage[stage] = Number(item.durationMs || item.ms || 0);
  }
  const clinicalStructuring = progressMetrics.clinicalStructuring || {};
  const ruleBased = progressMetrics.ruleBasedClinicalInference || {};
  return {
    total: Date.now() - caseStartedAt,
    prepare: byStage.prepare || 0,
    savePreparedSession: byStage.savePreparedSession || 0,
    pythonCalculator: byStage.pythonCalculator || 0,
    saveCalculation: byStage.saveCalculation || 0,
    audit: byStage.audit || 0,
    clinicalStructuring: Number(clinicalStructuring.durationMs || 0),
    openAiProvider: Number(clinicalStructuring.openAiProviderDurationMs || 0),
    firstOutputText: clinicalStructuring.firstOutputTextMs ?? null,
    ruleBasedInference: Number(ruleBased.durationMs || 0),
    masterLookup: Number((clinicalStructuring.masterLookupDurationMs || 0) + (ruleBased.masterLookupDurationMs || 0)),
    masterLookupCount: Number((clinicalStructuring.masterLookupCount || 0) + (ruleBased.masterLookupCount || 0)),
    model: clinicalStructuring.model || null,
    reasoningEffort: clinicalStructuring.reasoningEffort || null,
    clinicalStructuringSource: clinicalStructuring.source || null
  };
}

function accuracyView(item, actual) {
  const expected = item.expectedExtraction || {};
  const expectedDiagnoses = asStrings(expected.requiredDiagnoses);
  const expectedSignals = asStrings(expected.requiredBillingSignals);
  const expectedCodes = asStrings(item.expectedCalculation?.candidateCodes);
  const expectedReviewTopics = asStrings(expected.requiredReviewTopics);
  const actualDiagnosisText = actual.diagnoses.join(" ");
  const actualSignalText = [
    ...actual.lineItems.map((line) => `${line.code} ${line.name}`),
    ...actual.candidateProposals.map((item) => `${item.name} ${item.title} ${item.reason}`),
    ...actual.reviewText
  ].join(" ");
  const actualCodes = asStrings(actual.candidateCodes);
  return {
    diagnosisRecall: recall(expectedDiagnoses, (value) => normalizedIncludes(actualDiagnosisText, value)),
    billingSignalRecall: recall(expectedSignals, (value) => normalizedIncludes(actualSignalText, value)),
    candidateCodeRecall: recall(expectedCodes, (value) => actualCodes.includes(String(value))),
    candidateCodePrecision: actualCodes.length && expectedCodes.length
      ? round(actualCodes.filter((code) => expectedCodes.includes(code)).length / actualCodes.length)
      : null,
    reviewTopicRecall: recall(expectedReviewTopics, (value) => normalizedIncludes(actual.reviewText.join(" "), value)),
    forbiddenViolationCount: forbiddenCandidateViolations(item, actual).length,
    totalPointDelta: typeof item.expectedCalculation?.totalPoints === "number"
      ? Number(actual.totalPoints || 0) - Number(item.expectedCalculation.totalPoints)
      : null
  };
}

function missingView(item, actual) {
  const expected = item.expectedExtraction || {};
  const expectedCodes = asStrings(item.expectedCalculation?.candidateCodes);
  const actualCodes = asStrings(actual.candidateCodes);
  const actualText = [
    ...actual.diagnoses,
    ...actual.lineItems.map((line) => `${line.code} ${line.name}`),
    ...actual.candidateProposals.map((proposal) => `${proposal.name} ${proposal.title} ${proposal.reason}`),
    ...actual.reviewText
  ].join(" ");
  return {
    diagnoses: asStrings(expected.requiredDiagnoses).filter((value) => !normalizedIncludes(actual.diagnoses.join(" "), value)),
    billingSignals: asStrings(expected.requiredBillingSignals).filter((value) => !normalizedIncludes(actualText, value)),
    candidateCodes: expectedCodes.filter((code) => !actualCodes.includes(code)),
    reviewTopics: asStrings(expected.requiredReviewTopics).filter((value) => !normalizedIncludes(actual.reviewText.join(" "), value))
  };
}

function unexpectedView(item, actual) {
  return {
    forbiddenCandidateViolations: forbiddenCandidateViolations(item, actual),
    confirmedForbiddenCandidates: confirmedForbiddenCandidates(item, actual),
    unexpectedCandidateCodes: unexpectedCandidateCodes(item, actual)
  };
}

function casePassed(item, result) {
  const level = item.expectedCalculation?.assertionLevel;
  if (result.http.createSession?.statusCode >= 400 || result.http.calculate?.statusCode >= 400 || result.http.detail?.statusCode >= 400) {
    return false;
  }
  if (result.accuracy.forbiddenViolationCount > 0) {
    return false;
  }
  if (level === "exact") {
    return result.actual.totalPoints === item.expectedCalculation.totalPoints
      && result.missing.candidateCodes.length === 0;
  }
  if (level === "candidate_presence") {
    return result.missing.reviewTopics.length === 0
      && result.accuracy.forbiddenViolationCount === 0;
  }
  if (level === "review_required") {
    return isNeedsReview(result.actual)
      && result.missing.reviewTopics.length === 0;
  }
  if (level === "safety") {
    return isNeedsReview(result.actual)
      && result.accuracy.forbiddenViolationCount === 0;
  }
  if (level === "unsupported_expected") {
    return isNeedsReview(result.actual)
      && result.accuracy.forbiddenViolationCount === 0;
  }
  if (level === "split_required") {
    return isNeedsReview(result.actual)
      && result.accuracy.forbiddenViolationCount === 0;
  }
  return false;
}

function failedStage(item, result) {
  if (result.http.createSession?.statusCode >= 400 || result.http.calculate?.statusCode >= 400 || result.http.detail?.statusCode >= 400) {
    return "api_contract";
  }
  if (result.accuracy.forbiddenViolationCount > 0) {
    return "safety";
  }
  if (item.expectedCalculation?.assertionLevel === "exact") {
    if (result.missing.candidateCodes.length > 0 || result.missing.billingSignals.length > 0) return "extraction";
    if (result.actual.totalPoints !== item.expectedCalculation.totalPoints) return "calculation";
  }
  if (["review_required", "unsupported_expected", "split_required"].includes(item.expectedCalculation?.assertionLevel)) {
    if (!isNeedsReview(result.actual) || result.missing.reviewTopics.length > 0) return "review_policy";
  }
  if (result.durationMs.total > Number(args.slowMs || 30000)) return "performance";
  return "assertion";
}

function failureMessages(item, result) {
  const messages = [];
  if (result.http.createSession?.statusCode >= 400) messages.push(`createSession HTTP ${result.http.createSession.statusCode}`);
  if (result.http.calculate?.statusCode >= 400) messages.push(`calculate HTTP ${result.http.calculate.statusCode}`);
  if (result.http.detail?.statusCode >= 400) messages.push(`detail HTTP ${result.http.detail.statusCode}`);
  if (result.accuracy.forbiddenViolationCount > 0) messages.push(`forbidden candidates: ${result.unexpected.forbiddenCandidateViolations.join(", ")}`);
  if (item.expectedCalculation?.assertionLevel === "exact" && result.actual.totalPoints !== item.expectedCalculation.totalPoints) {
    messages.push(`totalPoints ${result.actual.totalPoints} != expected ${item.expectedCalculation.totalPoints}`);
  }
  if (result.missing.candidateCodes.length) messages.push(`missing candidate codes: ${result.missing.candidateCodes.join(", ")}`);
  if (result.missing.billingSignals.length) messages.push(`missing billing signals: ${result.missing.billingSignals.slice(0, 8).join(", ")}`);
  if (result.missing.reviewTopics.length) messages.push(`missing review topics: ${result.missing.reviewTopics.slice(0, 8).join(", ")}`);
  return messages;
}

function confirmedForbiddenCandidates(item, actual) {
  const forbidden = asStrings(item.expectedExtraction?.forbiddenCandidates);
  if (!forbidden.length) return [];
  const confirmedLines = actual.lineItems.filter((line) => {
    const status = String(line.status || "").toLowerCase();
    return !line.reviewRequired && ["confirmed", "approved", "calculated", "completed", "ready", "candidate"].includes(status);
  });
  const confirmedText = confirmedLines.map((line) => `${line.code} ${line.name}`).join(" ");
  return forbidden.filter((value) => normalizedIncludes(confirmedText, value));
}

function forbiddenCandidateViolations(item, actual) {
  const forbidden = asStrings(item.expectedExtraction?.forbiddenCandidates);
  if (!forbidden.length) return [];
  const candidateText = [
    ...actual.lineItems.map((line) => `${line.code} ${line.name}`),
    ...actual.candidateProposals.map((proposal) => `${proposal.name} ${proposal.title} ${proposal.reason}`)
  ].join(" ");
  return forbidden.filter((value) => normalizedIncludes(candidateText, value));
}

function unexpectedCandidateCodes(item, actual) {
  const expected = new Set(asStrings(item.expectedCalculation?.candidateCodes));
  if (!expected.size) return [];
  return asStrings(actual.candidateCodes).filter((code) => !expected.has(code));
}

function emptyCaseResult(item) {
  return {
    caseId: item.caseId,
    assertionLevel: item.expectedCalculation?.assertionLevel || null,
    difficultyLevel: item.difficultyLevel || null,
    status: "failed",
    failedStage: null,
    failureMessages: [],
    chartHash: sha256(soapText(item)),
    feeSessionId: null,
    historySeed: {
      required: false,
      reason: "none",
      created: false,
      failed: false,
      feeSessionId: null,
      patientId: null,
      serviceDate: null
    },
    facilityFixture: {
      mode: null,
      fixtureKey: null,
      seededFacilityStandards: [],
      expectedFacilityStandards: [],
      collisions: []
    },
    http: {},
    durationMs: {
      total: 0,
      seedVisitHistory: 0,
      createSession: 0,
      calculateRequest: 0,
      detail: 0
    },
    accuracy: {},
    expected: {
      totalPoints: item.expectedCalculation?.totalPoints ?? null,
      candidateCodes: item.expectedCalculation?.candidateCodes || [],
      engineStatus: item.expectedCalculation?.engineStatus || null
    },
    actual: {
      totalPoints: null,
      candidateCodes: [],
      engineStatus: null,
      status: null,
      lineItems: [],
      reviewItems: [],
      candidateProposals: []
    },
    missing: {},
    unexpected: {}
  };
}

function failCase(caseResult, stage, message, caseStartedAt = null) {
  caseResult.status = "failed";
  caseResult.failedStage = stage;
  caseResult.failureMessages = [message];
  if (caseStartedAt) {
    caseResult.durationMs.total = Date.now() - caseStartedAt;
  }
  return caseResult;
}

function buildSummary(results, meta) {
  const failed = results.filter((item) => item.status !== "passed");
  const passed = results.length - failed.length;
  return {
    ...meta,
    passed,
    failed: failed.length,
    passRate: round(passed / Math.max(1, results.length)),
    byAssertion: countGroups(results, (item) => item.assertionLevel, (items) => ({
      total: items.length,
      passed: items.filter((item) => item.status === "passed").length,
      failed: items.filter((item) => item.status !== "passed").length
    })),
    failureByStage: countBy(failed, (item) => item.failedStage || "unknown"),
    avgDurationMs: Math.round(results.reduce((sum, item) => sum + Number(item.durationMs.total || 0), 0) / Math.max(1, results.length)),
    slowest: [...results]
      .sort((a, b) => Number(b.durationMs.total || 0) - Number(a.durationMs.total || 0))
      .slice(0, 10)
      .map((item) => ({
        caseId: item.caseId,
        assertionLevel: item.assertionLevel,
        durationMs: item.durationMs.total,
        failedStage: item.failedStage
      })),
    worstBillingSignalRecall: [...results]
      .filter((item) => typeof item.accuracy.billingSignalRecall === "number")
      .sort((a, b) => Number(a.accuracy.billingSignalRecall) - Number(b.accuracy.billingSignalRecall))
      .slice(0, 10)
      .map((item) => ({
        caseId: item.caseId,
        assertionLevel: item.assertionLevel,
        billingSignalRecall: item.accuracy.billingSignalRecall,
        missingBillingSignals: item.missing.billingSignals || []
      }))
  };
}

function writeReports(report, options) {
  fs.mkdirSync(reportDir, { recursive: true });
  const prefix = options.outputPrefix || "latest";
  const jsonPath = path.join(reportDir, `${prefix}.json`);
  const jsonlPath = path.join(reportDir, `${prefix}.jsonl`);
  const mdPath = path.join(reportDir, `${prefix}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(jsonlPath, report.results.map((item) => JSON.stringify(item)).join("\n") + "\n");
  fs.writeFileSync(mdPath, markdownReport(report));
}

function markdownReport(report) {
  const lines = [];
  lines.push("# Fee SOAP E2E Evaluation");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: \`${report.mode}\``);
  lines.push(`Dataset: \`${report.datasetPath}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total: ${report.summary.selected}`);
  lines.push(`- Passed: ${report.summary.passed}`);
  lines.push(`- Failed: ${report.summary.failed}`);
  lines.push(`- Pass rate: ${Math.round(report.summary.passRate * 100)}%`);
  lines.push(`- Avg duration: ${report.summary.avgDurationMs}ms`);
  lines.push("");
  lines.push("## Failure By Stage");
  lines.push("");
  for (const [stage, count] of Object.entries(report.summary.failureByStage || {})) {
    lines.push(`- ${stage}: ${count}`);
  }
  if (!Object.keys(report.summary.failureByStage || {}).length) lines.push("- none");
  lines.push("");
  lines.push("## By Assertion");
  lines.push("");
  lines.push("| assertion | total | passed | failed |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [assertion, value] of Object.entries(report.summary.byAssertion || {})) {
    lines.push(`| ${assertion} | ${value.total} | ${value.passed} | ${value.failed} |`);
  }
  lines.push("");
  lines.push("## Slowest Cases");
  lines.push("");
  lines.push("| caseId | assertion | durationMs | failedStage |");
  lines.push("| --- | --- | ---: | --- |");
  for (const item of report.summary.slowest || []) {
    lines.push(`| ${item.caseId} | ${item.assertionLevel} | ${item.durationMs} | ${item.failedStage || "-"} |`);
  }
  lines.push("");
  lines.push("## Failed Cases");
  lines.push("");
  lines.push("| caseId | assertion | stage | total | expected | missing | messages |");
  lines.push("| --- | --- | --- | ---: | ---: | --- | --- |");
  for (const item of report.results.filter((result) => result.status !== "passed").slice(0, 100)) {
    lines.push([
      item.caseId,
      item.assertionLevel,
      item.failedStage || "-",
      item.actual.totalPoints ?? "-",
      item.expected.totalPoints ?? "-",
      escapeTable(compactStrings([
        ...(item.missing?.candidateCodes || []),
        ...(item.missing?.billingSignals || []),
        ...(item.missing?.reviewTopics || [])
      ]).slice(0, 6).join(" / ") || "-"),
      escapeTable((item.failureMessages || []).join(" / ") || "-")
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("## Security");
  lines.push("");
  lines.push("- SOAP full text is not written to this report.");
  lines.push("- Credentials, cookies, CSRF tokens, and access tokens are not written to this report.");
  lines.push("- The dataset is synthetic test data.");
  return `${lines.join("\n")}\n`;
}

function selectCases(cases, options) {
  let selected = [...cases];
  if (options.caseId) selected = selected.filter((item) => item.caseId === options.caseId);
  if (options.assertionLevel) selected = selected.filter((item) => item.expectedCalculation?.assertionLevel === options.assertionLevel);
  if (options.limit) selected = selected.slice(0, options.limit);
  return selected;
}

function departmentIdForEncounter(encounter = {}, departmentIds = {}) {
  const key = encounter.department || "general";
  const known = new Set(["internal_medicine", "pediatrics", "dermatology", "surgery", "orthopedics", "psychiatry"]);
  return departmentIds[known.has(key) ? key : "general"] || departmentIds.general || "";
}

function soapText(item) {
  if (item.chart?.standard) return item.chart.standard;
  const soap = item.chart?.soap || {};
  return ["S", "O", "A", "P"].map((section) => `${section}: ${(soap[section] || []).join("\n")}`).join("\n");
}

function isNeedsReview(actual) {
  return actual.status === "needs_review"
    || actual.engineStatus === "needs_review"
    || actual.reviewItems.length > 0
    || actual.lineItems.some((line) => line.reviewRequired);
}

function responseView(response) {
  return {
    statusCode: response.statusCode,
    error: response.statusCode >= 400 ? safeErrorMessage(response.body) : null
  };
}

function safeErrorMessage(body) {
  return [
    body?.error,
    body?.code,
    body?.message
  ].map((value) => String(value || "").trim()).filter(Boolean).join(": ").slice(0, 240);
}

function safeExceptionMessage(error) {
  return [
    error?.name || "Error",
    error?.message || ""
  ].map((value) => String(value || "").trim()).filter(Boolean).join(": ").slice(0, 240);
}

function recall(expected, predicate) {
  if (!expected.length) return null;
  return round(expected.filter(predicate).length / expected.length);
}

function normalizedIncludes(haystack, needle) {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return true;
  if (normalizedHaystack.includes(normalizedNeedle)) return true;
  const compactNeedle = normalizedNeedle
    .replace(/（.*?）/gu, "")
    .replace(/\(.*?\)/gu, "")
    .trim();
  return Boolean(compactNeedle && normalizedHaystack.includes(compactNeedle));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[、。，．・]/gu, "")
    .trim();
}

function asStrings(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(asStrings(values))];
}

function compactStrings(values) {
  return uniqueStrings(values);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function countBy(values, keyFn) {
  const result = {};
  for (const value of values) {
    const key = keyFn(value) || "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function countGroups(values, keyFn, mapper) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, mapper(group)]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function escapeTable(value) {
  return String(value || "").replace(/\|/gu, "\\|").replace(/\n/gu, "<br>");
}

function parseArgs(argv) {
  const parsed = {
    mode: "local",
    limit: null,
    caseId: "",
    assertionLevel: "",
    outputPrefix: "latest",
    strict: false,
    verbose: false,
    openai: false,
    verboseApiLogs: false,
    useExpectedClaimContext: false,
    seedVisitHistory: true,
    spawnPython: false,
    caseTimeoutMs: 60000,
    slowMs: 30000,
    masterDbPath: "",
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--mode") parsed.mode = next();
    else if (arg === "--limit") parsed.limit = Number(next());
    else if (arg === "--case") parsed.caseId = next();
    else if (arg === "--assertion") parsed.assertionLevel = next();
    else if (arg === "--output-prefix") parsed.outputPrefix = next();
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--openai") parsed.openai = true;
    else if (arg === "--verbose-api-logs") parsed.verboseApiLogs = true;
    else if (arg === "--use-expected-claim-context") parsed.useExpectedClaimContext = true;
    else if (arg === "--no-seed-visit-history") parsed.seedVisitHistory = false;
    else if (arg === "--spawn-python") parsed.spawnPython = true;
    else if (arg === "--case-timeout-ms") parsed.caseTimeoutMs = Number(next());
    else if (arg === "--slow-ms") parsed.slowMs = Number(next());
    else if (arg === "--master-db-path") parsed.masterDbPath = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["local", "stg"].includes(parsed.mode)) {
    throw new Error(`Unsupported mode: ${parsed.mode}`);
  }
  if (parsed.limit !== null && (!Number.isInteger(parsed.limit) || parsed.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run eval:fee-soap-e2e -- [options]

Options:
  --mode local|stg                 Evaluation target. Default: local
  --limit N                        Run the first N matching cases
  --case CASE_ID                   Run one case
  --assertion LEVEL                Filter by assertionLevel
  --output-prefix NAME             Report prefix under data/tests/fee-soap-e2e/reports
  --strict                         Exit non-zero when any case fails
  --verbose                        Print every case result
  --openai                         Local mode only: use OPENAI_API_KEY for clinical structuring
  --verbose-api-logs               Print fee-api internal stage logs to stdout
  --use-expected-claim-context     Debug mode: bypass SOAP extraction and calculate from expectedClaimContext
  --no-seed-visit-history          Do not create prior sessions for outpatient revisit cases
  --master-db-path PATH            Local mode master sqlite path

STG env:
  FEE_E2E_PLATFORM_BASE_URL
  FEE_E2E_FEE_BASE_URL
  FEE_E2E_ORGANIZATION_CODE
  FEE_E2E_LOGIN_ID
  FEE_E2E_PASSWORD
  FEE_E2E_MFA_CODE                Optional when the runner account has MFA enrolled
  FEE_E2E_FACILITY_ID             Optional STG facility override
  FEE_E2E_DEPARTMENT_ID           Optional STG department override
`);
}

function printSummary(summary) {
  console.log(JSON.stringify({
    selected: summary.selected,
    passed: summary.passed,
    failed: summary.failed,
    passRate: summary.passRate,
    failureByStage: summary.failureByStage,
    avgDurationMs: summary.avgDurationMs,
    reportDir: path.relative(repoRoot, reportDir)
  }, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizedBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/u, "");
  return raw || "";
}

async function httpJson(url, { method = "GET", body = undefined, headers = {}, jar = null } = {}) {
  const requestHeaders = {
    accept: "application/json",
    ...headers
  };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }
  if (jar) {
    const cookie = jar.header();
    if (cookie) requestHeaders.cookie = cookie;
  }
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : splitSetCookie(response.headers.get("set-cookie"));
  jar?.store(setCookie);
  const text = await response.text();
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  return {
    statusCode: response.status,
    body: parsed,
    headers: Object.fromEntries(response.headers.entries())
  };
}

function splitSetCookie(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,=]+=[^;,]+)/u).map((item) => item.trim()).filter(Boolean);
}

async function withSuppressedConsoleInfo(fn) {
  const originalInfo = console.info;
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.info = originalInfo;
  }
}
