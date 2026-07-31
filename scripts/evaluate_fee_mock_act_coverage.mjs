#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  auditMockActCoverageCase,
  classifyMockAction,
  normalizeMockActionName,
  parseCsv,
  reconcileMockActCoverageRuns,
  resolveRateLimitRetryDelayMs,
  summarizeMockActCoverage,
  summarizeMockActCoverageRepetitions
} from "./lib/fee-mock-act-coverage.mjs";
import {
  createStaticSidecarEvaluatorAuth,
  createTemporarySidecarEvaluatorAuth
} from "./lib/sidecar-evaluator-auth.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  mockRoot: "tmp/mock_homis",
  actionMap: "tmp/dataset_recalculation_diff_diagnosis/20260702_185214_mock_homis/homis_action_master_map.csv",
  actionMapOverrides: "data/tests/fee-mock-act-coverage/manual-action-map-overrides.json",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  password: process.env.FEE_E2E_PASSWORD || "",
  mfaCode: process.env.FEE_E2E_MFA_CODE || "",
  facilityId: "fac_9fe275b29feebb03bfeb9410f7",
  departmentId: "dep_00d6c56dcd8b4d65acf0d8f2ab",
  selectorContractVersion: "homis-mock-v4",
  claimMonth: "",
  claimMonths: "2026-06,2026-07",
  expectedClinicalExtractionStrategy: "openai_primary",
  expectedExtractionCoverageMode: "verify",
  expectedStandingFacts: "true",
  repeat: 1,
  maxRateLimitRetries: 4,
  rateLimitBackoffMs: 5_000,
  rateLimitMaxBackoffMs: 60_000,
  timeoutMs: 180_000
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const dataset = exportCases(args);
const baseMappingRows = fs.existsSync(resolveRepoPath(args.actionMap))
  ? parseCsv(fs.readFileSync(resolveRepoPath(args.actionMap), "utf8"))
  : [];
const mappingRows = applyMappingOverrides(
  baseMappingRows,
  readJsonArrayIfPresent(resolveRepoPath(args.actionMapOverrides))
);
const classification = summarizeClassification(dataset.cases, mappingRows);
if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    syntheticDataOnly: dataset.syntheticDataOnly === true,
    claimMonths: dataset.claimMonths,
    caseCount: dataset.cases.length,
    classification
  }, null, 2)}\n`);
  process.exit(0);
}

const extensionId = String(args.extensionId || process.env.HOMIS_SIDECAR_EXTENSION_ID || "").trim();
if (!/^[a-p]{32}$/u.test(extensionId)) {
  throw new Error("live evaluation requires a 32-character --extension-id");
}

const outputDir = path.resolve(
  repoRoot,
  args.outputDir || `docs/20260729-mock-act-coverage-baseline/${dateStamp(new Date())}`
);
fs.mkdirSync(outputDir, { recursive: true });
const ready = await requestJson(`${args.feeBaseUrl}/readyz`, { timeoutMs: args.timeoutMs });
assertResponse(ready, "fee-api readyz");
if (String(ready.body?.env || "") !== "stg" && !args.allowNonStg) {
  throw new Error(`refusing non-STG target: ${String(ready.body?.env || "unknown")}`);
}
validateRuntimePreflight(ready.body, args);
const sidecarAuth = await createSidecarAuth(args, extensionId);
const sidecarOptions = {
  ...args,
  facilityId: sidecarAuth.sidecarContext?.facilityId || args.facilityId,
  departmentId: sidecarAuth.sidecarContext?.departmentId || args.departmentId
};
if (!sidecarOptions.facilityId) {
  await sidecarAuth.close();
  throw new Error("sidecar authorization did not resolve a facility");
}

const result = {
  schemaVersion: "fee-mock-act-coverage-run-v2",
  generatedAt: new Date().toISOString(),
  status: "running",
  source: {
    syntheticDataOnly: true,
    mockPatientsSha256: sha256File(path.join(resolveRepoPath(args.mockRoot), "data/patients.py")),
    actionMapSha256: fs.existsSync(resolveRepoPath(args.actionMap))
      ? sha256File(resolveRepoPath(args.actionMap))
      : null,
    actionMapOverridesSha256: fs.existsSync(resolveRepoPath(args.actionMapOverrides))
      ? sha256File(resolveRepoPath(args.actionMapOverrides))
      : null,
    claimMonths: dataset.claimMonths
  },
  environment: {
    feeBaseUrl: args.feeBaseUrl,
    platformBaseUrl: args.platformBaseUrl,
    organizationCode: args.organizationCode,
    facilityId: sidecarOptions.facilityId,
    departmentId: sidecarOptions.departmentId || null,
    cloudRunRevision: ready.body?.runtime?.cloudRunRevision || null,
    runtimeFeatures: {
      clinicalExtractionStrategy: ready.body?.runtimeFeatures?.clinicalExtractionStrategy || null,
      extractionCoverageMode: ready.body?.runtimeFeatures?.extractionCoverage?.mode || null,
      standingFactsEnabled: ready.body?.runtimeFeatures?.standingFactsEnabled === true
    },
    sidecarAuthorization: {
      ...sidecarAuth.metadata,
      grantRevoked: null
    }
  },
  methodology: {
    route: "/v1/integrations/sidecar/calculate",
    actionListUsedAsCalculationInput: false,
    persistedRawClinicalText: false,
    rateLimitRetry: {
      statusCode: 429,
      maxRetries: args.maxRateLimitRetries,
      baseDelayMs: args.rateLimitBackoffMs,
      maxDelayMs: args.rateLimitMaxBackoffMs,
      retryAfterPreferred: true
    },
    actionClasses: [
      "billable_line",
      "claim_comment",
      "claim_attribute",
      "patient_charge",
      "unknown"
    ]
  },
  classification,
  repeatCount: args.repeat,
  repetitions: [],
  runs: []
};
persist(outputDir, result);

try {
  for (let repeatIndex = 1; repeatIndex <= args.repeat; repeatIndex += 1) {
    const repetition = {
      repeatIndex,
      status: "running",
      runs: []
    };
    result.repetitions.push(repetition);
    for (let index = 0; index < dataset.cases.length; index += 1) {
      const item = dataset.cases[index];
      process.stdout.write(
        `[repeat ${repeatIndex}/${args.repeat}] [${index + 1}/${dataset.cases.length}] ${item.caseId}\n`
      );
      const body = sidecarBody(item, sidecarOptions);
      const credentials = await sidecarAuth.credentials();
      const response = await requestJsonWithRateLimitRetry(
        `${args.feeBaseUrl}/v1/integrations/sidecar/calculate`,
        {
          method: "POST",
          body,
          timeoutMs: args.timeoutMs,
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            origin: `chrome-extension://${extensionId}`,
            "x-sidecar-code-verifier": credentials.verifier
          }
        },
        {
          label: item.caseId,
          maxRetries: args.maxRateLimitRetries,
          baseDelayMs: args.rateLimitBackoffMs,
          maxDelayMs: args.rateLimitMaxBackoffMs
        }
      );
      assertResponse(response, item.caseId);
      repetition.runs.push({
        repeatIndex,
        rateLimitRetryCount: response.rateLimitRetryCount,
        ...auditMockActCoverageCase(item, response.body, mappingRows)
      });
      reconcileMockActCoverageRuns(repetition.runs, mappingRows);
      repetition.summary = summarizeMockActCoverage(repetition.runs);
      result.runs = result.repetitions.flatMap((entry) => entry.runs);
      result.summary = summarizeMockActCoverageRepetitions(result.repetitions);
      persist(outputDir, result);
    }
    repetition.status = "complete";
    reconcileMockActCoverageRuns(repetition.runs, mappingRows);
    repetition.summary = summarizeMockActCoverage(repetition.runs);
    repetition.outputSha256 = coverageOutputSha256(repetition.runs);
    result.runs = result.repetitions.flatMap((entry) => entry.runs);
    result.summary = summarizeMockActCoverageRepetitions(result.repetitions);
    persist(outputDir, result);
  }
  result.status = "complete";
  result.completedAt = new Date().toISOString();
  result.runs = result.repetitions.flatMap((entry) => entry.runs);
  result.summary = summarizeMockActCoverageRepetitions(result.repetitions);
} catch (error) {
  result.status = "failed";
  result.failedAt = new Date().toISOString();
  result.failure = { message: String(error?.message || error).slice(0, 500) };
  throw error;
} finally {
  const closeResult = await sidecarAuth.close();
  result.environment.sidecarAuthorization.grantRevoked = closeResult.revoked === true;
  if (closeResult.error) {
    result.environment.sidecarAuthorization.revokeError = closeResult.error.slice(0, 300);
  }
  persist(outputDir, result);
}
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`result=${path.join(outputDir, "result.json")}\n`);

function sidecarBody(item, options) {
  const extractedAt = new Date().toISOString();
  const sourceSurfaces = sealSourceSurfaces(item, extractedAt);
  return {
    contractVersion: "v1",
    facilityId: options.facilityId,
    departmentId: options.departmentId,
    sourceSystem: "homis",
    externalPatientId: item.patientId,
    sourceRecordId: item.sourceRecordId,
    sourceRecordDisplayId: item.caseId,
    serviceDate: item.serviceDate,
    ...(item.receptionTime ? { receptionTime: item.receptionTime } : {}),
    setting: item.setting,
    encounterTypeSource: "dom",
    sameBuilding: item.sameBuilding,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: item.singleBuildingPatientCount,
    residenceType: item.residenceType,
    ...(item.visitKind ? {
      visitKind: item.visitKind,
      visitKindSource: "dom"
    } : {}),
    clinicalText: item.clinicalText,
    orders: [],
    diagnoses: item.diagnoses,
    sourceSurfaces,
    extractionProof: {
      patientIdBefore: item.patientId,
      patientIdAfter: item.patientId,
      sourceRecordIdBefore: item.sourceRecordId,
      sourceRecordIdAfter: item.sourceRecordId,
      selectorContractVersion: options.selectorContractVersion,
      extractedAt,
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 5,
      matchedRequiredElementCount: 5,
      clinicalTextNodeCount: Math.max(1, String(item.clinicalText || "").split(/\n/u).length),
      surfaceProofs: Object.fromEntries(
        Object.entries(sourceSurfaces).map(([name, surface]) => [name, {
          status: surface.status,
          patientId: surface.patientId,
          observedAt: surface.observedAt,
          surfaceHash: surface.surfaceHash
        }])
      )
    }
  };
}

function sealSourceSurfaces(item, observedAt) {
  const patientId = String(item.patientId || "");
  const raw = item.sourceSurfaceRaw || {};
  return {
    currentChart: sealSourceSurface({
      status: "ok",
      patientId,
      raw: raw.currentChart || {}
    }, observedAt),
    documents: sealSourceSurface({
      status: "ok",
      patientId,
      raw: raw.documents || { rows: [] }
    }, observedAt)
  };
}

function sealSourceSurface(surface, observedAt) {
  const revisionPayload = {
    status: surface.status,
    patientId: surface.patientId,
    ...(surface.status === "ok" ? { raw: surface.raw || {} } : {}),
    ...(surface.status === "unavailable"
      ? { unavailableReason: surface.unavailableReason || "fetch_failed" }
      : {})
  };
  return {
    ...revisionPayload,
    observedAt,
    surfaceHash: `sha256-${crypto
      .createHash("sha256")
      .update(JSON.stringify(revisionPayload))
      .digest("base64url")}`
  };
}

function exportCases(options) {
  const command = spawnSync("python3", [
    path.join(repoRoot, "scripts/export_mock_homis_evaluation_cases.py"),
    "--mock-root",
    resolveRepoPath(options.mockRoot)
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (command.status !== 0) {
    throw new Error(`mock case export failed: ${String(command.stderr || command.stdout || "").trim()}`);
  }
  const payload = JSON.parse(command.stdout);
  const requestedMonths = requestedClaimMonths(options);
  const cases = payload.cases.filter((item) => requestedMonths.includes(String(item.serviceDate || "").slice(0, 7)));
  return {
    ...payload,
    claimMonth: requestedMonths.length === 1 ? requestedMonths[0] : null,
    claimMonths: requestedMonths,
    caseCount: cases.length,
    cases
  };
}

function requestedClaimMonths(options) {
  const direct = String(options.claimMonth || "").trim();
  const values = direct
    ? [direct]
    : String(options.claimMonths || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length || unique.some((value) => !/^\d{4}-\d{2}$/u.test(value))) {
    throw new Error("--claim-month/--claim-months must contain YYYY-MM values");
  }
  return unique.sort();
}

function summarizeClassification(cases, mappingRows) {
  const mapping = new Map();
  for (const row of mappingRows) {
    for (const value of [row.action_key, row.normalized_action_name, row.sample_action_name]) {
      const key = normalizeMockActionName(value);
      if (key && !mapping.has(key)) mapping.set(key, row);
    }
  }
  const counts = Object.fromEntries([
    "billable_line",
    "claim_comment",
    "claim_attribute",
    "patient_charge",
    "unknown"
  ].map((key) => [key, 0]));
  for (const item of cases) {
    for (const action of item.actionList) {
      counts[classifyMockAction(action, mapping.get(normalizeMockActionName(action)))] += 1;
    }
  }
  return counts;
}

function persist(outputDir, payload) {
  fs.writeFileSync(path.join(outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    [
      "# mock HOMIS 行為欄カバレッジ",
      "",
      `- status: ${payload.status}`,
      `- generatedAt: ${payload.generatedAt}`,
      `- claimMonths: ${asArray(payload.source.claimMonths).join(", ")}`,
      `- caseCount: ${payload.summary?.caseCount || payload.runs.length}`,
      `- repeatCount: ${payload.summary?.repeatCount || payload.repeatCount || 1}`,
      `- actCoverageRecall: ${formatPercent(payload.summary?.actCoverageRecall)}`,
      `- billableReadyMatchRate: ${formatPercent(payload.summary?.billableReadyMatchRate)}`,
      `- confirmedBillableRate: ${formatPercent(payload.summary?.confirmedBillableRate)}`,
      `- commentDetectionRate: ${formatPercent(payload.summary?.commentDetectionRate)}`,
      `- commentGeneratedCount: ${payload.summary?.commentGeneratedCount ?? 0}`,
      `- commentInputRequiredCount: ${payload.summary?.commentInputRequiredCount ?? 0}`,
      `- falseProposalCount: ${payload.summary?.falseProposalCount ?? 0}`,
      `- dangerousFalsePositiveCount: ${payload.summary?.dangerousFalsePositiveCount ?? 0}`,
      `- candidatePrecision: ${formatPercent(payload.summary?.candidatePrecision)}`,
      `- mappedReferencePointTotal: ${payload.summary?.expectedPointTotal ?? 0}`,
      `- billableReadyExpectedPointTotal: ${payload.summary?.billableReadyExpectedPointTotal ?? 0}`,
      `- detectedBillableReadyPointTotal: ${payload.summary?.detectedBillableReadyPointTotal ?? 0}`,
      `- pointTotalsMatch: ${payload.summary?.pointTotalsMatch === true}`,
      `- completedRepeatCount: ${payload.summary?.completedRepeatCount ?? 0}/${payload.summary?.repeatCount ?? payload.repeatCount ?? 1}`,
      `- repeatCoverageComplete: ${payload.summary?.repeatCoverageComplete === true}`,
      `- deterministicOutputs: ${payload.summary?.deterministicOutputs === true}`,
      `- rateLimitRetryCount: ${payload.summary?.rateLimitRetryCount ?? 0}`,
      `- standingLaneObservedRuns: ${payload.summary?.standingLane?.observedRunCount ?? 0}`,
      `- standingLaneDisabledReasons: ${formatCountMap(payload.summary?.standingLane?.disabledReasonCounts)}`,
      `- standingLaneTopReasons: ${formatCountMap(payload.summary?.standingLane?.reasonCounts)}`,
      `- standingLaneTopMissingFacts: ${formatCountMap(payload.summary?.standingLane?.missingFactCounts)}`,
      "",
      "行為欄は評価専用であり、算定APIへの入力には使用していません。",
      "患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。",
      "採用不可・区分未確定の候補はactCoverageRecallには含めますが、billableReadyMatchRateと点数合計には含めません。",
      "コメント検知は構造化comments/noticesのtargetCode・commentCode・statusを優先します。generatedとinput_requiredはいずれも義務検知として数え、状態別件数を別記します。",
      ""
    ].join("\n")
  );
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || defaults.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal
    });
    const text = await response.text();
    return {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      body: text ? JSON.parse(text) : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJsonWithRateLimitRetry(url, options = {}, retryOptions = {}) {
  const maxRetries = Number(retryOptions.maxRetries) || 0;
  let retryCount = 0;
  while (true) {
    const response = await requestJson(url, options);
    if (response.statusCode !== 429 || retryCount >= maxRetries) {
      return {
        ...response,
        rateLimitRetryCount: retryCount
      };
    }
    const delayMs = resolveRateLimitRetryDelayMs(response.retryAfter, {
      attempt: retryCount,
      baseDelayMs: retryOptions.baseDelayMs,
      maxDelayMs: retryOptions.maxDelayMs
    });
    retryCount += 1;
    process.stdout.write(
      `[rate-limit] ${retryOptions.label || "request"}: retry ${retryCount}/${maxRetries} in ${delayMs}ms\n`
    );
    await sleep(delayMs);
  }
}

function assertResponse(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed (HTTP ${response.statusCode}): ${JSON.stringify(response.body).slice(0, 400)}`);
  }
}

function validateRuntimePreflight(ready, options) {
  const features = ready?.runtimeFeatures || {};
  const actualStrategy = String(features.clinicalExtractionStrategy || "");
  const actualCoverageMode = String(features.extractionCoverage?.mode || "");
  const actualStandingFacts = features.standingFactsEnabled === true;
  if (actualStrategy !== options.expectedClinicalExtractionStrategy) {
    throw new Error(
      `clinical extraction strategy must be ${options.expectedClinicalExtractionStrategy}, got ${actualStrategy || "missing"}`
    );
  }
  if (actualCoverageMode !== options.expectedExtractionCoverageMode) {
    throw new Error(
      `extraction coverage mode must be ${options.expectedExtractionCoverageMode}, got ${actualCoverageMode || "missing"}`
    );
  }
  const expectedStandingFacts = String(options.expectedStandingFacts).toLowerCase() === "true";
  if (actualStandingFacts !== expectedStandingFacts) {
    throw new Error(
      `standing facts must be ${expectedStandingFacts}, got ${actualStandingFacts}`
    );
  }
}

function coverageOutputSha256(runs) {
  const output = runs.map((run) => ({
    caseId: run.caseId,
    gold: run.gold.map((item) => ({
      actionIndex: item.actionIndex,
      matchStatus: item.matchStatus,
      matchedCode: item.matchedCode,
      matchedSourceType: item.matchedSourceType,
      matchedAdoptionBlocked: item.matchedAdoptionBlocked,
      matchedRequiresSelection: item.matchedRequiresSelection,
      matchedPoints: item.matchedPoints,
      pointMatchStatus: item.pointMatchStatus
    })),
    falseProposals: run.actual.falseProposals
  }));
  return sha256Text(JSON.stringify(output));
}

function readJsonArrayIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error(`action map overrides must be an array: ${filePath}`);
  }
  validateMappingOverrides(value, filePath);
  return value;
}

function validateMappingOverrides(overrides, filePath) {
  const seen = new Set();
  for (const [index, row] of overrides.entries()) {
    const label = String(
      row?.sample_action_name || row?.normalized_action_name || row?.action_key || ""
    ).trim();
    const normalized = normalizeMockActionName(label);
    if (!normalized) {
      throw new Error(`action map override ${index + 1} has no action name: ${filePath}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`duplicate action map override "${label}": ${filePath}`);
    }
    seen.add(normalized);
    if (String(row?.match_status || "") !== "manual_reviewed_mapping") {
      throw new Error(`action map override "${label}" is not human reviewed: ${filePath}`);
    }
    if (!["per_visit", "per_month"].includes(String(row?.billing_scope || ""))) {
      throw new Error(`action map override "${label}" has invalid billing_scope: ${filePath}`);
    }
    if (!String(row?.code || "").trim() && !String(row?.candidate_codes || "").trim()) {
      throw new Error(`action map override "${label}" has no code or candidate_codes: ${filePath}`);
    }
    if (!String(row?.source_version || "").trim()) {
      throw new Error(`action map override "${label}" has no source_version: ${filePath}`);
    }
    if (!/^https:\/\/[^\s]+$/u.test(String(row?.source_url || "").trim())) {
      throw new Error(`action map override "${label}" has invalid source_url: ${filePath}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(row?.source_sha256 || "").trim())) {
      throw new Error(`action map override "${label}" has invalid source_sha256: ${filePath}`);
    }
    if (!String(row?.note || "").trim()) {
      throw new Error(`action map override "${label}" has no review note: ${filePath}`);
    }
  }
}

function applyMappingOverrides(rows, overrides) {
  const byName = new Map(
    overrides.map((row) => [normalizeMockActionName(
      row.sample_action_name || row.normalized_action_name || row.action_key
    ), row])
  );
  const applied = new Set();
  const merged = rows.map((row) => {
    const key = normalizeMockActionName(
      row.sample_action_name || row.normalized_action_name || row.action_key
    );
    const override = byName.get(key);
    if (!override) {
      return row;
    }
    applied.add(key);
    return { ...row, ...override };
  });
  for (const [key, override] of byName.entries()) {
    if (!applied.has(key)) {
      merged.push(override);
    }
  }
  return merged;
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    outputDir: "",
    accessToken: "",
    accessTokenFile: "",
    verifier: "",
    verifierFile: "",
    extensionId: "",
    dryRun: false,
    allowNonStg: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") parsed.dryRun = true;
    else if (key === "--allow-non-stg") parsed.allowNonStg = true;
    else if (key === "--help" || key === "-h") parsed.help = true;
    else if (key.startsWith("--")) {
      const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      if (!(name in parsed) || index + 1 >= argv.length) throw new Error(`unknown or incomplete option: ${key}`);
      parsed[name] = argv[++index];
    }
  }
  parsed.timeoutMs = Number(parsed.timeoutMs || defaults.timeoutMs);
  parsed.repeat = Number(parsed.repeat || defaults.repeat);
  parsed.maxRateLimitRetries = Number(
    parsed.maxRateLimitRetries ?? defaults.maxRateLimitRetries
  );
  parsed.rateLimitBackoffMs = Number(
    parsed.rateLimitBackoffMs ?? defaults.rateLimitBackoffMs
  );
  parsed.rateLimitMaxBackoffMs = Number(
    parsed.rateLimitMaxBackoffMs ?? defaults.rateLimitMaxBackoffMs
  );
  if (!Number.isInteger(parsed.repeat) || parsed.repeat < 1 || parsed.repeat > 10) {
    throw new Error("--repeat must be an integer from 1 to 10");
  }
  if (
    !Number.isInteger(parsed.maxRateLimitRetries)
    || parsed.maxRateLimitRetries < 0
    || parsed.maxRateLimitRetries > 10
  ) {
    throw new Error("--max-rate-limit-retries must be an integer from 0 to 10");
  }
  if (
    !Number.isFinite(parsed.rateLimitBackoffMs)
    || parsed.rateLimitBackoffMs < 0
    || !Number.isFinite(parsed.rateLimitMaxBackoffMs)
    || parsed.rateLimitMaxBackoffMs < parsed.rateLimitBackoffMs
  ) {
    throw new Error("--rate-limit backoff values must be non-negative and max must be >= base");
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(
    "Usage: npm run eval:fee-mock-act-coverage -- [options]\n"
    + "  --dry-run                     classify all mock actions without calling STG\n"
    + "  --organization-code ID         STG organization (default yamamoto-demo-stg)\n"
    + "  --login-id ID                  STG approver login (default yamamoto-admin)\n"
    + "  --password-file PATH           STG approver password file\n"
    + "  --mfa-code CODE                Current 6-digit MFA code (or FEE_E2E_MFA_CODE)\n"
    + "  --platform-base-url URL        Platform API used for temporary sidecar authorization\n"
    + "  --access-token-file PATH      scoped sidecar token file\n"
    + "  --verifier-file PATH          sidecar PKCE verifier file\n"
    + "  --extension-id ID             approved Chrome extension ID\n"
    + "  --claim-month YYYY-MM         evaluate one target month\n"
    + "  --claim-months LIST           comma-separated months (default 2026-06,2026-07)\n"
    + "  --action-map-overrides PATH   reviewed manual mapping overrides\n"
    + "  --repeat N                    repeat the full matrix for stability (default 1)\n"
    + "  --max-rate-limit-retries N    bounded HTTP 429 retries (default 4)\n"
    + "  --rate-limit-backoff-ms N     fallback retry delay (default 5000)\n"
    + "  --rate-limit-max-backoff-ms N maximum fallback delay (default 60000)\n"
    + "  --output-dir PATH             report directory\n"
  );
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function createSidecarAuth(options, extensionId) {
  const accessToken = secretValue(
    options.accessToken,
    options.accessTokenFile,
    "HOMIS_SIDECAR_ACCESS_TOKEN"
  );
  const verifier = secretValue(
    options.verifier,
    options.verifierFile,
    "HOMIS_SIDECAR_CODE_VERIFIER"
  );
  if (accessToken || verifier) {
    if (!accessToken || !verifier) {
      throw new Error("static sidecar authentication requires both access token and verifier");
    }
    return createStaticSidecarEvaluatorAuth({ accessToken, verifier });
  }
  assertTemporaryAuthStg(options);
  return createTemporarySidecarEvaluatorAuth({
    platformBaseUrl: options.platformBaseUrl,
    organizationCode: options.organizationCode,
    loginId: options.loginId,
    password: resolvePassword(options),
    mfaCode: options.mfaCode,
    extensionId,
    timeoutMs: options.timeoutMs
  });
}

function resolvePassword(options) {
  if (String(options.password || "").trim()) {
    return String(options.password).trim();
  }
  const filePath = resolveRepoPath(options.passwordFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`password file not found: ${options.passwordFile}`);
  }
  const password = fs.readFileSync(filePath, "utf8").trim();
  if (!password) {
    throw new Error("password file is empty");
  }
  return password;
}

function assertTemporaryAuthStg(options) {
  const platformHost = new URL(options.platformBaseUrl).hostname.toLowerCase();
  const feeHost = new URL(options.feeBaseUrl).hostname.toLowerCase();
  const isStgHost = (host) => host.includes("-stg-")
    || host.startsWith("stg.")
    || host.includes(".stg.");
  if (
    !isStgHost(platformHost)
    || !isStgHost(feeHost)
    || !String(options.organizationCode || "").toLowerCase().endsWith("-stg")
  ) {
    throw new Error("automatic sidecar evaluator authorization is restricted to STG");
  }
}

function secretValue(direct, file, envName) {
  if (String(direct || "").trim()) return String(direct).trim();
  if (String(file || "").trim()) return fs.readFileSync(resolveRepoPath(file), "utf8").trim();
  return String(process.env[envName] || "").trim();
}

function resolveRepoPath(value) {
  return path.isAbsolute(String(value || "")) ? String(value) : path.resolve(repoRoot, String(value || ""));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function dateStamp(value) {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "n/a";
}

function formatCountMap(value) {
  const entries = Object.entries(value && typeof value === "object" ? value : {})
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0)
      || String(left[0]).localeCompare(String(right[0])))
    .slice(0, 8);
  return entries.length
    ? entries.map(([key, count]) => `${key}=${count}`).join(", ")
    : "none";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
