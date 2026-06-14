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
const datasetArgIndex = process.argv.indexOf("--dataset");
const datasetPath = datasetArgIndex >= 0 && process.argv[datasetArgIndex + 1]
  ? path.resolve(repoRoot, process.argv[datasetArgIndex + 1])
  : path.join(repoRoot, "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const reportDirArgIndex = process.argv.indexOf("--report-dir");
const reportDir = reportDirArgIndex >= 0 && process.argv[reportDirArgIndex + 1]
  ? path.resolve(repoRoot, process.argv[reportDirArgIndex + 1])
  : path.join(repoRoot, "data/tests/fee-soap-e2e/reports");
const defaultNow = new Date("2026-06-07T00:00:00.000Z");
const localSessionSecret = "fee-soap-e2e-local-session-secret";
const DEFAULT_OPENAI_FEE_CLINICAL_TIMEOUT_MS = 60000;
const STABILITY_CASE_PASS_THRESHOLD = 0.9;
const args = parseArgs(process.argv.slice(2));
const DIAGNOSTIC_TRACE_STAGES = new Set([
  "lab_evidence_guard",
  "checklist_consistency",
  "checklist_recall",
  "visit_facts_consistency",
  "review_only_domain_gate",
  "management_review_gate",
  "case_level_lab_collection",
  "lab_rule_expansion",
  "non_billable_observation_skip",
  "clinical_fact_review_flag_suppressed"
]);

if (args.help) {
  printHelp();
  process.exit(0);
}

const dataset = readJson(datasetPath);
const datasetFacilityFixtures = readDatasetFacilityFixtures(datasetPath);
const selectedCases = selectCases(dataset.cases || [], args);
if (!selectedCases.length) {
  throw new Error("No cases matched the selected filters");
}

const startedAt = Date.now();
const facilityFixtureAudit = buildFacilityFixtureAudit(selectedCases);
const runner = args.mode === "stg"
  ? await createStgRunner(args, facilityFixtureAudit)
  : await createLocalRunner(args, facilityFixtureAudit);
if (args.warmup !== false) {
  await runner.warmUp?.();
}
const results = [];

for (const item of selectedCases) {
  for (let repeatIndex = 0; repeatIndex < args.repeat; repeatIndex += 1) {
    const result = await evaluateCase(item, runner, args);
    result.repeat = {
      index: repeatIndex + 1,
      count: args.repeat
    };
    results.push(result);
    if (args.verbose || result.status !== "passed") {
      const repeatLabel = args.repeat > 1 ? ` repeat=${repeatIndex + 1}/${args.repeat}` : "";
      console.log(`${result.status.toUpperCase()} ${result.caseId}${repeatLabel} stage=${result.failedStage || "-"} total=${result.actual.totalPoints ?? "-"}ms=${result.durationMs.total}`);
    }
  }
}

await runner.close?.();

const summary = buildSummary(results, {
  mode: args.mode,
  strict: args.strict,
  selected: selectedCases.length,
  repeat: args.repeat,
  totalRuns: results.length,
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
    limit: args.limit || null,
    repeat: args.repeat
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
    seededFacilityStandards: runner.facilityFixture?.seededFacilityStandards || [],
    seedStatus: runner.facilityFixture?.seedStatus || null,
    seedError: runner.facilityFixture?.seedError || ""
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
  try {
    const caseFacilityFixture = await runner.prepareCase?.(item);
    caseResult.facilityFixture = caseFacilityFixture || facilityFixtureForCase(item, runner) || runner.facilityFixture || caseResult.facilityFixture;
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
  const facilityFixture = facilityFixtureForCase(item, runner);
  const payload = {
    facilityId: facilityFixture?.facilityId || runner.facilityId || "fac_fee_e2e",
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
  const unknownRequired = new Set();
  const reviewFacilityCases = [];
  const fixtureMap = new Map();
  for (const item of cases) {
    const level = String(item.expectedCalculation?.assertionLevel || "").trim();
    const expectedKeys = facilityStandardKeysForCase(item);
    const caseKeys = expectedKeys;
    const fixtureKey = facilityFixtureKeyForCase(item);
    if (!fixtureMap.has(fixtureKey)) {
      fixtureMap.set(fixtureKey, {
        fixtureKey,
        seededFacilityStandardKeys: caseKeys.slice().sort(),
        caseIds: []
      });
    }
    fixtureMap.get(fixtureKey).caseIds.push(item.caseId);
    for (const key of expectedKeys) {
      if (level === "exact") {
        exactRequired.add(key);
      } else {
        unknownRequired.add(key);
      }
    }
    const chart = normalizeText(soapText(item));
    if (level !== "exact" && /(施設基準|届出|届け出|地方厚生局)/u.test(chart)) {
      reviewFacilityCases.push(item.caseId);
    }
  }
  const seededFacilityStandardKeys = [...exactRequired].sort();
  const collisions = seededFacilityStandardKeys.filter((key) => unknownRequired.has(key));
  return {
    fixtureKey: "default",
    seededFacilityStandardKeys,
    fixtures: [...fixtureMap.values()],
    exactRequiredFacilityStandardKeys: seededFacilityStandardKeys,
    facilityUnknownExpectedKeys: [...unknownRequired].sort(),
    facilityUnknownCaseIds: reviewFacilityCases,
    collisions,
    collisionPolicy: collisions.length ? "case_group_fixture_required" : "single_fixture_ok"
  };
}

function facilityStandardKeysForCase(item = {}) {
  return uniqueStrings([
    ...facilityFixtureStandardKeys(item.facilityFixtureKey),
    ...asStrings(item.expectedClaimContext?.facility_standard_keys)
  ]).sort();
}

function facilityFixtureKeyForCase(item = {}) {
  const explicit = String(item.facilityFixtureKey || "").trim();
  return explicit || facilityFixtureKeyForKeys(facilityStandardKeysForCase(item));
}

function facilityFixtureKeyForKeys(keys = []) {
  const normalized = uniqueStrings(keys).sort();
  if (!normalized.length) {
    return "default";
  }
  return `standards_${sha256(normalized.join("|")).slice(0, 10)}`;
}

function facilityFixtureForCase(item = {}, runner = {}) {
  const key = facilityFixtureKeyForCase(item);
  return runner.facilityFixturesByKey?.[key] || null;
}

function readDatasetFacilityFixtures(currentDatasetPath = "") {
  const fixturePath = path.join(path.dirname(currentDatasetPath), "facility-fixtures.json");
  if (!fs.existsSync(fixturePath)) {
    return {};
  }
  try {
    return readJson(fixturePath).fixtures || {};
  } catch {
    return {};
  }
}

function facilityFixtureStandardKeys(fixtureKey = "") {
  const fixture = datasetFacilityFixtures[String(fixtureKey || "").trim()] || null;
  if (!fixture) {
    return [];
  }
  const keys = [...asStrings(fixture.facilityStandardKeys)];
  if (fixture.electronicImageManagement === true) {
    keys.push("画像電子管理");
  }
  const ctKind = String(fixture.equipment?.ct || "").trim();
  if (ctKind) {
    keys.push(`CT機器区分:${ctKind}`);
  }
  const mriKind = String(fixture.equipment?.mri || "").trim();
  if (mriKind) {
    keys.push(`MRI機器区分:${mriKind}`);
  }
  return uniqueStrings(keys);
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
  const fixtureDefinitions = Array.isArray(facilityFixtureAudit.fixtures) && facilityFixtureAudit.fixtures.length
    ? facilityFixtureAudit.fixtures
    : [{ fixtureKey: "default", seededFacilityStandardKeys: [] }];
  const facilityFixturesByKey = {};
  for (const fixture of fixtureDefinitions) {
    const facility = platformStore.createFacility(organization.orgId, {
      displayName: fixture.fixtureKey === "default" ? "E2E検証クリニック" : `E2E検証クリニック ${fixture.fixtureKey}`,
      medicalInstitutionCode: fixture.fixtureKey === "default" ? "1312345" : `13${String(Object.keys(facilityFixturesByKey).length + 12345).slice(-5)}`,
      regionalBureau: "kanto-shinetsu",
      prefecture: "tokyo",
      facilityStandardKeys: fixture.seededFacilityStandardKeys || []
    });
    facilityFixturesByKey[fixture.fixtureKey] = {
      mode: "local_fixture",
      fixtureKey: fixture.fixtureKey,
      facilityId: facility.facilityId,
      seededFacilityStandards: fixture.seededFacilityStandardKeys || [],
      expectedFacilityStandards: fixture.seededFacilityStandardKeys || [],
      collisions: facilityFixtureAudit.collisions || [],
      seedStatus: "seeded",
      seedError: ""
    };
  }
  const defaultFixture = facilityFixturesByKey.default || Object.values(facilityFixturesByKey)[0];
  const facility = { facilityId: defaultFixture.facilityId };
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
    facilityFixturesByKey,
    facilityFixture: {
      mode: "local_fixture",
      fixtureKey: facilityFixtureAudit.fixtureKey || "default",
      seededFacilityStandards: defaultFixture.seededFacilityStandards || [],
      collisions: facilityFixtureAudit.collisions || [],
      seedStatus: "seeded",
      seedError: ""
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
        openAiFeeClinicalTimeoutMs: Number(process.env.OPENAI_FEE_CLINICAL_TIMEOUT_MS || DEFAULT_OPENAI_FEE_CLINICAL_TIMEOUT_MS)
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
  const baseFixture = {
    mode: "stg_existing_facility",
    fixtureKey: "default",
    facilityId,
    seededFacilityStandards: [],
    expectedFacilityStandards: [],
    collisions: facilityFixtureAudit.collisions || [],
    seedStatus: "pending",
    seedError: ""
  };

  return {
    facilityId,
    departmentIds,
    facilityFixturesByKey: { default: baseFixture },
    facilityFixture: baseFixture,
    async prepareCase(item = {}) {
      const expectedKeys = facilityStandardKeysForCase(item);
      const fixtureKey = facilityFixtureKeyForCase(item);
      const facilitySeed = await setStgFacilityStandards({
        platformBaseUrl,
        orgId,
        facilityId,
        jar,
        csrfToken,
        desiredKeys: expectedKeys
      });
      const fixture = {
        mode: "stg_existing_facility",
        fixtureKey,
        facilityId,
        seededFacilityStandards: facilitySeed.seededFacilityStandards,
        expectedFacilityStandards: expectedKeys,
        collisions: facilityFixtureAudit.collisions || [],
        seedStatus: facilitySeed.status,
        seedError: facilitySeed.error || ""
      };
      this.facilityFixturesByKey[fixtureKey] = fixture;
      this.facilityFixture = fixture;
      return fixture;
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
    async warmUp() {
      const started = Date.now();
      const checks = [];
      for (const apiPath of ["/healthz", "/readyz"]) {
        try {
          const response = await httpJson(`${feeBaseUrl}${apiPath}`, { method: "GET", jar });
          checks.push({ apiPath, statusCode: response.statusCode });
        } catch (error) {
          checks.push({ apiPath, statusCode: 0, error: safeExceptionMessage(error) });
        }
      }
      this.warmup = {
        durationMs: Date.now() - started,
        checks
      };
      return this.warmup;
    },
    close() {}
  };
}

async function setStgFacilityStandards({
  platformBaseUrl = "",
  orgId = "",
  facilityId = "",
  jar = null,
  csrfToken = "",
  desiredKeys = []
} = {}) {
  const desired = uniqueStrings(desiredKeys);
  const response = await httpJson(`${platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/facilities/${encodeURIComponent(facilityId)}`, {
    method: "PATCH",
    body: { facilityStandardKeys: desired },
    jar,
    headers: { "x-csrf-token": csrfToken }
  });
  if (response.statusCode >= 400) {
    return {
      status: "failed",
      seededFacilityStandards: [],
      error: safeErrorMessage(response.body)
    };
  }
  const updated = response.body?.facility || {};
  return {
    status: desired.length ? "seeded" : "cleared",
    seededFacilityStandards: uniqueStrings(updated.facilityStandardKeys || updated.facility_standard_keys || desired),
    error: ""
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
  const clinicalExtraction = calculationResult.clinicalExtraction || feeSession.calculationResult?.clinicalExtraction || null;
  const clinicalTrace = Array.isArray(clinicalExtraction?.trace) ? clinicalExtraction.trace : [];
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
    clinicalExtractionVersion: clinicalExtraction ? {
      source: clinicalExtraction.source || null,
      model: clinicalExtraction.model || null,
      reasoningEffort: clinicalExtraction.reasoningEffort || null,
      promptVersion: clinicalExtraction.promptVersion || null,
      ruleSetVersion: clinicalExtraction.ruleSetVersion || null,
      masterVersion: clinicalExtraction.masterVersion || null,
      runId: clinicalExtraction.runId || null,
      responseId: clinicalExtraction.responseId || null,
      clinicalEventCount: Number(clinicalExtraction.clinicalEventCount || 0),
      masterCandidateCount: Number(clinicalExtraction.masterCandidateCount || 0),
      billingCandidateCount: Number(clinicalExtraction.billingCandidateCount || 0),
      reviewIssueCount: Number(clinicalExtraction.reviewIssueCount || 0)
    } : null,
    visitFacts: clinicalExtraction?.visitFacts || null,
    checklistFindingStatusCounts: clinicalExtraction?.checklistFindingStatusCounts || null,
    clinicalTraceStageCounts: traceStageCounts(clinicalTrace),
    diagnosticTrace: clinicalTrace
      .filter((item) => DIAGNOSTIC_TRACE_STAGES.has(item.stage))
      .map(diagnosticTraceView)
      .slice(0, 80),
    masterSearchTrace: clinicalTrace
      .filter((item) => item.stage === "master_search")
      .map((item) => ({
        eventName: item.eventName || "",
        outcome: item.outcome || "",
        query: item.query || "",
        selected: item.selected ? {
          code: item.selected.masterCode || item.selected.code || "",
          name: item.selected.masterName || item.selected.name || ""
        } : null,
        searches: (item.searches || []).map((search) => ({
          query: search.query || "",
          outcome: search.outcome || "",
          selectedCode: search.selectedCode || "",
          filteredCandidates: search.filteredCandidates || [],
          ambiguousCandidates: search.ambiguousCandidates || [],
          ambiguityReason: search.ambiguityReason || ""
        }))
      })).slice(0, 20),
    clinicalEvents: (
      Array.isArray(feeSession.clinicalEvents) ? feeSession.clinicalEvents
        : Array.isArray(feeSession.calculationResult?.clinicalEvents) ? feeSession.calculationResult.clinicalEvents
          : []
    ).map((event) => ({
      id: event.clinicalEventId || event.clinical_event_id || "",
      name: event.name || event.event_name || event.eventName || "",
      type: event.type || event.event_type || event.eventType || "",
      actionStatus: event.action_status || event.actionStatus || event.status || "",
      temporalRelation: event.temporal_relation || event.temporalRelation || "",
      billingDomain: event.billing_domain || event.billingDomain || "",
      certainty: event.certainty || "",
      source: event.source || "",
      searchTerms: Array.isArray(event.searchTerms) ? event.searchTerms.slice(0, 12)
        : Array.isArray(event.search_terms) ? event.search_terms.slice(0, 12)
          : Array.isArray(event.search_queries) ? event.search_queries.slice(0, 12)
            : [],
      evidence: String(event.evidence || event.evidence_text || "").slice(0, 160)
    })),
    reviewText,
    progress: feeSession.calculationProgress || null
  };
}

function traceStageCounts(trace = []) {
  const counts = {};
  for (const item of trace) {
    const stage = item?.stage || "unknown";
    counts[stage] = Number(counts[stage] || 0) + 1;
  }
  return counts;
}

function diagnosticTraceView(item = {}) {
  return {
    stage: item.stage || "",
    outcome: item.outcome || "",
    eventName: item.eventName || "",
    eventType: item.eventType || "",
    clinicalEventId: item.clinicalEventId || "",
    categoryLabel: item.categoryLabel || "",
    topicCode: item.topicCode || "",
    query: item.query || "",
    message: item.message || "",
    selected: item.selected || null
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
    ...(actual.clinicalEvents || []).map((event) => `${event.name} ${event.type} ${event.billingDomain}`),
    ...actual.reviewText
  ].join(" ");
  const actualCodes = asStrings(actual.candidateCodes);
  return {
    diagnosisRecall: recall(expectedDiagnoses, (value) => normalizedIncludes(actualDiagnosisText, value)),
    billingSignalRecall: recall(expectedSignals, (value) => billingSignalSatisfied(actualSignalText, value)),
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
    ...(actual.clinicalEvents || []).map((event) => `${event.name} ${event.type} ${event.billingDomain}`),
    ...actual.reviewText
  ].join(" ");
  return {
    diagnoses: asStrings(expected.requiredDiagnoses).filter((value) => !normalizedIncludes(actual.diagnoses.join(" "), value)),
    billingSignals: asStrings(expected.requiredBillingSignals).filter((value) => !billingSignalSatisfied(actualText, value)),
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
  const knownProductGaps = asStrings(item.knownProductGaps);
  return {
    caseId: item.caseId,
    assertionLevel: item.expectedCalculation?.assertionLevel || null,
    difficultyLevel: item.difficultyLevel || null,
    knownProductGaps,
    hasKnownProductGap: knownProductGaps.length > 0,
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
      collisions: [],
      seedStatus: null,
      seedError: ""
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
  const knownGapResults = results.filter((item) => item.hasKnownProductGap);
  const failedKnownGapResults = failed.filter((item) => item.hasKnownProductGap);
  const failedWithoutKnownGaps = failed.filter((item) => !item.hasKnownProductGap);
  const passed = results.length - failed.length;
  const stability = buildStabilitySummary(results, meta.repeat || 1);
  const safety = buildSafetySummary(results);
  const clinicalStructuringSources = countBy(results, (item) => (
    item.durationMs?.clinicalStructuringSource
    || item.actual?.clinicalExtractionVersion?.source
    || "unknown"
  ));
  return {
    ...meta,
    headline: {
      passed,
      failed: failedWithoutKnownGaps.length,
      knownGap: failedKnownGapResults.length,
      stabilityEscalationThreshold: STABILITY_CASE_PASS_THRESHOLD,
      unstableCases: stability.unstableCases,
      p2EscalationRecommended: stability.shouldConsiderP2
    },
    passed,
    failed: failed.length,
    failedWithoutKnownProductGaps: failedWithoutKnownGaps.length,
    passRate: round(passed / Math.max(1, results.length)),
    effectivePassRateExcludingKnownProductGaps: round(passed / Math.max(1, results.length - failedKnownGapResults.length)),
    clinicalStructuringSources,
    clinicalStructuringFallbackRate: round(Number(clinicalStructuringSources.rules_fallback || 0) / Math.max(1, results.length)),
    safety,
    stability,
    knownProductGaps: {
      totalCases: knownGapResults.length,
      passed: knownGapResults.filter((item) => item.status === "passed").length,
      failed: failedKnownGapResults.length,
      failedCaseIds: failedKnownGapResults.map((item) => item.caseId),
      byGap: countGroups(
        knownGapResults.flatMap((item) => item.knownProductGaps.map((gap) => ({
          gap,
          status: item.status,
          caseId: item.caseId
        }))),
        (item) => item.gap,
        (items) => ({
          total: items.length,
          passed: items.filter((item) => item.status === "passed").length,
          failed: items.filter((item) => item.status !== "passed").length,
          failedCaseIds: items.filter((item) => item.status !== "passed").map((item) => item.caseId)
        })
      )
    },
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

function buildSafetySummary(results = []) {
  const total = results.length;
  const forbiddenCandidateCases = results.filter((item) => (item.unexpected?.forbiddenCandidateViolations || []).length > 0);
  const confirmedForbiddenCases = results.filter((item) => (item.unexpected?.confirmedForbiddenCandidates || []).length > 0);
  const unexpectedCodeCases = results.filter((item) => (item.unexpected?.unexpectedCandidateCodes || []).length > 0);
  const missingReviewTopicCases = results.filter((item) => (item.missing?.reviewTopics || []).length > 0);
  const missingCandidateCodeCases = results.filter((item) => (item.missing?.candidateCodes || []).length > 0);
  return {
    evaluatedCases: total,
    forbiddenCandidateViolationCases: forbiddenCandidateCases.length,
    forbiddenCandidateViolationCount: forbiddenCandidateCases.reduce((sum, item) => sum + (item.unexpected?.forbiddenCandidateViolations || []).length, 0),
    confirmedForbiddenCases: confirmedForbiddenCases.length,
    confirmedForbiddenCount: confirmedForbiddenCases.reduce((sum, item) => sum + (item.unexpected?.confirmedForbiddenCandidates || []).length, 0),
    unsafeAutoBillingRate: round(confirmedForbiddenCases.length / Math.max(1, total)),
    unexpectedCandidateCodeCases: unexpectedCodeCases.length,
    unexpectedCandidateCodeCount: unexpectedCodeCases.reduce((sum, item) => sum + (item.unexpected?.unexpectedCandidateCodes || []).length, 0),
    missingReviewTopicCases: missingReviewTopicCases.length,
    missingReviewTopicCount: missingReviewTopicCases.reduce((sum, item) => sum + (item.missing?.reviewTopics || []).length, 0),
    missingCandidateCodeCases: missingCandidateCodeCases.length,
    missingCandidateCodeCount: missingCandidateCodeCases.reduce((sum, item) => sum + (item.missing?.candidateCodes || []).length, 0),
    avgCandidateCodePrecision: averageMetric(results, (item) => item.accuracy?.candidateCodePrecision),
    avgCandidateCodeRecall: averageMetric(results, (item) => item.accuracy?.candidateCodeRecall),
    avgBillingSignalRecall: averageMetric(results, (item) => item.accuracy?.billingSignalRecall),
    avgReviewTopicRecall: averageMetric(results, (item) => item.accuracy?.reviewTopicRecall)
  };
}

function averageMetric(items = [], picker = () => null) {
  const values = items
    .map((item) => picker(item))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildStabilitySummary(results = [], repeat = 1) {
  const groups = new Map();
  for (const result of results) {
    if (!groups.has(result.caseId)) groups.set(result.caseId, []);
    groups.get(result.caseId).push(result);
  }
  const caseSummaries = [...groups.entries()]
    .filter(([, items]) => repeat > 1 || items.length > 1)
    .map(([caseId, items]) => {
      const signatureGroups = countGroups(
        items.map((item) => ({
          signature: stabilitySignature(item),
          result: item
        })),
        (item) => item.signature,
        (group) => ({
          count: group.length,
          repeatIndexes: group.map((item) => item.result.repeat?.index || null).filter(Boolean),
          status: group[0]?.result?.status || "unknown",
          failedStage: group[0]?.result?.failedStage || null,
          totalPoints: group[0]?.result?.actual?.totalPoints ?? null,
          candidateCodes: asStrings(group[0]?.result?.actual?.candidateCodes).sort(),
          missingReviewTopics: asStrings(group[0]?.result?.missing?.reviewTopics).sort()
        })
      );
      const signatures = Object.entries(signatureGroups)
        .map(([signature, value]) => ({ signature, ...value }))
        .sort((a, b) => b.count - a.count);
      return {
        caseId,
        runs: items.length,
        stable: signatures.length <= 1,
        signatures
      };
    });
  const unstable = caseSummaries.filter((item) => !item.stable);
  const caseStabilityRate = caseSummaries.length
    ? round((caseSummaries.length - unstable.length) / caseSummaries.length)
    : null;
  return {
    enabled: repeat > 1,
    repeat,
    threshold: STABILITY_CASE_PASS_THRESHOLD,
    evaluatedCases: caseSummaries.length,
    stableCases: caseSummaries.length - unstable.length,
    unstableCases: unstable.length,
    caseStabilityRate,
    shouldConsiderP2: Boolean(repeat > 1 && caseStabilityRate !== null && caseStabilityRate < STABILITY_CASE_PASS_THRESHOLD),
    unstableCaseDetails: unstable.slice(0, 20)
  };
}

function stabilitySignature(result = {}) {
  return JSON.stringify({
    status: result.status || "unknown",
    failedStage: result.failedStage || null,
    totalPoints: result.actual?.totalPoints ?? null,
    candidateCodes: asStrings(result.actual?.candidateCodes).sort(),
    missingCandidateCodes: asStrings(result.missing?.candidateCodes).sort(),
    missingBillingSignals: asStrings(result.missing?.billingSignals).sort(),
    missingReviewTopics: asStrings(result.missing?.reviewTopics).sort()
  });
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
  lines.push(`- Headline passed: ${report.summary.headline?.passed ?? report.summary.passed}`);
  lines.push(`- Headline failed: ${report.summary.headline?.failed ?? report.summary.failedWithoutKnownProductGaps}`);
  lines.push(`- Headline knownGap: ${report.summary.headline?.knownGap ?? 0}`);
  lines.push(`- Total: ${report.summary.selected}`);
  lines.push(`- Passed: ${report.summary.passed}`);
  lines.push(`- Failed: ${report.summary.failed}`);
  lines.push(`- Failed excluding known product gaps: ${report.summary.failedWithoutKnownProductGaps}`);
  lines.push(`- Pass rate: ${Math.round(report.summary.passRate * 100)}%`);
  lines.push(`- Effective pass rate excluding known gaps: ${Math.round((report.summary.effectivePassRateExcludingKnownProductGaps || 0) * 100)}%`);
  lines.push(`- Avg duration: ${report.summary.avgDurationMs}ms`);
  lines.push(`- Clinical structuring sources: ${Object.entries(report.summary.clinicalStructuringSources || {}).map(([source, count]) => `${source}=${count}`).join(", ") || "-"}`);
  lines.push(`- Rules fallback rate: ${Math.round((report.summary.clinicalStructuringFallbackRate || 0) * 100)}%`);
  lines.push(`- P2 verifier/self-consistency trigger: case stability < ${Math.round((report.summary.headline?.stabilityEscalationThreshold || STABILITY_CASE_PASS_THRESHOLD) * 100)}%`);
  if (report.summary.stability?.enabled) {
    lines.push(`- Case stability: ${Math.round((report.summary.stability.caseStabilityRate || 0) * 100)}% (${report.summary.stability.stableCases}/${report.summary.stability.evaluatedCases} stable, unstable=${report.summary.stability.unstableCases})`);
    lines.push(`- P2 escalation recommended: ${report.summary.stability.shouldConsiderP2 ? "yes" : "no"}`);
  } else {
    lines.push("- Case stability: not measured (use --repeat N)");
  }
  if (report.summary.knownProductGaps?.totalCases) {
    lines.push(`- Known product gap cases: ${report.summary.knownProductGaps.totalCases} (failed: ${report.summary.knownProductGaps.failed})`);
  }
  lines.push("");
  lines.push("## Safety Metrics");
  lines.push("");
  if (report.summary.safety) {
    const safety = report.summary.safety;
    lines.push(`- Unsafe auto-billing rate: ${Math.round((safety.unsafeAutoBillingRate || 0) * 100)}% (${safety.confirmedForbiddenCases}/${safety.evaluatedCases} cases)`);
    lines.push(`- Forbidden candidate violations: ${safety.forbiddenCandidateViolationCount} in ${safety.forbiddenCandidateViolationCases} cases`);
    lines.push(`- Unexpected candidate codes: ${safety.unexpectedCandidateCodeCount} in ${safety.unexpectedCandidateCodeCases} cases`);
    lines.push(`- Missing review topics: ${safety.missingReviewTopicCount} in ${safety.missingReviewTopicCases} cases`);
    lines.push(`- Missing candidate codes: ${safety.missingCandidateCodeCount} in ${safety.missingCandidateCodeCases} cases`);
    lines.push(`- Avg candidate code precision: ${safety.avgCandidateCodePrecision === null ? "-" : `${Math.round(safety.avgCandidateCodePrecision * 100)}%`}`);
    lines.push(`- Avg candidate code recall: ${safety.avgCandidateCodeRecall === null ? "-" : `${Math.round(safety.avgCandidateCodeRecall * 100)}%`}`);
    lines.push(`- Avg billing signal recall: ${safety.avgBillingSignalRecall === null ? "-" : `${Math.round(safety.avgBillingSignalRecall * 100)}%`}`);
    lines.push(`- Avg review topic recall: ${safety.avgReviewTopicRecall === null ? "-" : `${Math.round(safety.avgReviewTopicRecall * 100)}%`}`);
  } else {
    lines.push("- not available");
  }
  lines.push("");
  lines.push("## Known Product Gaps");
  lines.push("");
  if (report.summary.knownProductGaps?.totalCases) {
    lines.push("| gap | total | passed | failed | failed cases |");
    lines.push("| --- | ---: | ---: | ---: | --- |");
    for (const [gap, value] of Object.entries(report.summary.knownProductGaps.byGap || {})) {
      lines.push(`| ${gap} | ${value.total} | ${value.passed} | ${value.failed} | ${escapeTable(value.failedCaseIds.join(", ") || "-")} |`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");
  lines.push("## Stability");
  lines.push("");
  if (report.summary.stability?.enabled) {
    lines.push(`- Repeat: ${report.summary.stability.repeat}`);
    lines.push(`- Threshold: ${Math.round(report.summary.stability.threshold * 100)}%`);
    lines.push(`- Case stability: ${Math.round((report.summary.stability.caseStabilityRate || 0) * 100)}%`);
    if (report.summary.stability.unstableCaseDetails?.length) {
      lines.push("");
      lines.push("| case | runs | signatures |");
      lines.push("| --- | ---: | --- |");
      for (const item of report.summary.stability.unstableCaseDetails) {
        const signatureSummary = item.signatures
          .map((signature) => `${signature.count}x ${signature.status}/${signature.failedStage || "-"} ${signature.totalPoints ?? "-"}pt [${signature.candidateCodes.join(",") || "-"}]`)
          .join("<br>");
        lines.push(`| ${item.caseId} | ${item.runs} | ${escapeTable(signatureSummary)} |`);
      }
    } else {
      lines.push("- all repeated cases stable");
    }
  } else {
    lines.push("- not measured");
  }
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

function billingSignalSatisfied(haystack, signal) {
  if (normalizedIncludes(haystack, signal)) {
    return true;
  }
  for (const alias of billingSignalAliases(signal)) {
    if (normalizedIncludes(haystack, alias)) {
      return true;
    }
  }
  return false;
}

function billingSignalAliases(signal) {
  const key = normalizeText(signal);
  const aliases = {
    "インフルエンザ迅速": ["160169450", "インフルエンザウイルス抗原定性", "インフルエンザ抗原"],
    "インフル迅速": ["160169450", "インフルエンザウイルス抗原定性", "インフルエンザ抗原"],
    "コロナインフル同時抗原": ["160230050", "SARS-CoV-2インフルエンザウイルス抗原同時検出定性", "同時検出定性"],
    "電子画像管理": ["170000210", "170028810", "電子画像管理加算"],
    "単純X線": ["170000410", "170027910", "単純撮影", "X線"],
    "CT": ["170011810", "CT撮影", "ＣＴ撮影"],
    "CRP": ["160054710", "ＣＲＰ", "C反応性蛋白"],
    "Ｂ－Ｖ": ["160095710", "B-V", "静脈採血"]
  };
  return aliases[key] || [];
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
    repeat: 1,
    strict: false,
    verbose: false,
    openai: false,
    verboseApiLogs: false,
    useExpectedClaimContext: false,
    seedVisitHistory: true,
    spawnPython: false,
    warmup: true,
    caseTimeoutMs: 60000,
    slowMs: 30000,
    masterDbPath: "",
    reportDir: "",
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
    else if (arg === "--repeat") parsed.repeat = Number(next());
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--openai") parsed.openai = true;
    else if (arg === "--verbose-api-logs") parsed.verboseApiLogs = true;
    else if (arg === "--use-expected-claim-context") parsed.useExpectedClaimContext = true;
    else if (arg === "--no-seed-visit-history") parsed.seedVisitHistory = false;
    else if (arg === "--no-warmup") parsed.warmup = false;
    else if (arg === "--spawn-python") parsed.spawnPython = true;
    else if (arg === "--case-timeout-ms") parsed.caseTimeoutMs = Number(next());
    else if (arg === "--slow-ms") parsed.slowMs = Number(next());
    else if (arg === "--master-db-path") parsed.masterDbPath = next();
    else if (arg === "--dataset") next();
    else if (arg === "--report-dir") parsed.reportDir = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["local", "stg"].includes(parsed.mode)) {
    throw new Error(`Unsupported mode: ${parsed.mode}`);
  }
  if (parsed.limit !== null && (!Number.isInteger(parsed.limit) || parsed.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(parsed.repeat) || parsed.repeat <= 0) {
    throw new Error("--repeat must be a positive integer");
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
  --output-prefix NAME             Report prefix under the report directory
  --repeat N                       Run each selected case N times and report case stability. Default: 1
  --report-dir PATH                Report directory. Default: data/tests/fee-soap-e2e/reports
  --strict                         Exit non-zero when any case fails
  --verbose                        Print every case result
  --openai                         Local mode only: use OPENAI_API_KEY for clinical structuring
  --verbose-api-logs               Print fee-api internal stage logs to stdout
  --use-expected-claim-context     Debug mode: bypass SOAP extraction and calculate from expectedClaimContext
  --no-seed-visit-history          Do not create prior sessions for outpatient revisit cases
  --no-warmup                      Skip non-mutating health checks before evaluation
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
    headline: summary.headline,
    passed: summary.passed,
    failed: summary.failed,
    failedWithoutKnownProductGaps: summary.failedWithoutKnownProductGaps,
    knownProductGaps: summary.knownProductGaps,
    passRate: summary.passRate,
    effectivePassRateExcludingKnownProductGaps: summary.effectivePassRateExcludingKnownProductGaps,
    clinicalStructuringSources: summary.clinicalStructuringSources,
    clinicalStructuringFallbackRate: summary.clinicalStructuringFallbackRate,
    stability: summary.stability,
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
