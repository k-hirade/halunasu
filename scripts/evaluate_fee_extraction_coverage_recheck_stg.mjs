#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditCoverageRecheckCase,
  buildCoverageRecheckSessionInput,
  compareCoverageRecheckControl,
  safeControlRuns,
  summarizeCoverageRecheckResult
} from "./lib/fee-extraction-coverage-recheck-evaluation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  dataset: "data/tests/fee-extraction-coverage-recheck/cases.json",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  facilityId: "fac_9fe275b29feebb03bfeb9410f7",
  departmentId: "dep_0a9c99c2dedcf0b6247294ef6a",
  expectedMode: "verify",
  timeoutMs: 180_000
};

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers = []) {
    for (const header of headers) {
      const first = String(header || "").split(";")[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
      }
    }
  }

  get(name) {
    return this.cookies.get(name) || "";
  }

  header() {
    return [...this.cookies.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
assertStgTarget(args);

const datasetPath = resolveRepoPath(args.dataset);
const dataset = readJson(datasetPath);
const cases = validateDataset(dataset);
const controlResult = args.controlResult
  ? readJson(resolveRepoPath(args.controlResult))
  : null;
const controlsByCase = safeControlRuns(controlResult);

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    dataset: path.relative(repoRoot, datasetPath),
    datasetSha256: sha256File(datasetPath),
    syntheticDataOnly: dataset.syntheticDataOnly === true,
    expectedMode: args.expectedMode,
    caseCount: cases.length,
    controlResult: args.controlResult || null,
    cases: cases.map((item) => ({
      caseId: item.id,
      safetyClass: item.safetyClass,
      serviceDate: item.serviceDate,
      setting: item.setting,
      clinicalTextSha256: sha256(String(item.clinicalText || "")),
      clinicalLineCount: clinicalLineCount(item.clinicalText)
    }))
  }, null, 2)}\n`);
  process.exit(0);
}

const runId = `fee-coverage-recheck-${dateStamp(new Date())}-${crypto.randomBytes(3).toString("hex")}`;
const outputDir = path.resolve(
  repoRoot,
  args.outputDir
    || path.join("docs/20260728-fee-extraction-coverage-recheck-stg", runId)
);
fs.mkdirSync(outputDir, { recursive: true });

const preflight = await requestJson(`${args.feeBaseUrl}/readyz`, {
  timeoutMs: args.timeoutMs
});
assertResponse(preflight, "fee-api readyz");
const preflightAudit = validatePreflight(preflight.body || {}, args.expectedMode);

const jar = new CookieJar();
const login = await requestJson(`${args.platformBaseUrl}/v1/auth/login`, {
  method: "POST",
  body: {
    organizationCode: args.organizationCode,
    loginId: args.loginId,
    password: resolvePassword(args),
    ...(args.mfaCode ? { mfaCode: args.mfaCode } : {})
  },
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(login, "login");
const csrfToken = String(
  login.body?.csrfToken
  || jar.get("halunasu_stg_csrf")
  || jar.get("halunasu_csrf")
  || ""
);
if (!csrfToken) {
  throw new Error("login did not return a CSRF token");
}

const authSession = await requestJson(`${args.platformBaseUrl}/v1/auth/session`, {
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(authSession, "auth session");
if (!String(authSession.body?.session?.orgId || "").trim()) {
  throw new Error("auth session did not include orgId");
}

const result = {
  schemaVersion: "fee-extraction-coverage-recheck-stg-run-v1",
  generatedAt: new Date().toISOString(),
  runId,
  status: "running",
  source: {
    dataset: path.relative(repoRoot, datasetPath),
    datasetSha256: sha256File(datasetPath),
    syntheticDataOnly: true,
    controlResult: args.controlResult || null
  },
  environment: {
    organizationCode: args.organizationCode,
    facilityId: args.facilityId,
    departmentId: args.departmentId,
    expectedCoverageMode: args.expectedMode,
    cloudRunRevision: preflightAudit.cloudRunRevision,
    clinicalExtractionStrategy: preflightAudit.clinicalExtractionStrategy,
    coverageMode: preflightAudit.coverageMode,
    whiteboxModes: preflightAudit.whiteboxModes,
    spanArtifactVersion: preflightAudit.spanArtifactVersion
  },
  methodology: {
    caseCount: cases.length,
    oneAdditionalOpenAiCallMaximum: true,
    openAiRemainsAuthoritative: true,
    auxiliaryCandidatesRequireHumanReview: true,
    noRawClinicalTextPersisted: true,
    controlComparisonRequested: Boolean(controlResult)
  },
  runs: []
};
persistResult(outputDir, result);

try {
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    process.stdout.write(
      `[${index + 1}/${cases.length}] ${item.id} (${item.safetyClass})\n`
    );
    const sessionInput = buildCoverageRecheckSessionInput(item, {
      facilityId: args.facilityId,
      departmentId: args.departmentId,
      runId
    });
    const create = await requestJson(`${args.feeBaseUrl}/v1/fee/sessions`, {
      method: "POST",
      body: sessionInput,
      headers: { "x-csrf-token": csrfToken },
      jar,
      timeoutMs: args.timeoutMs
    });
    assertResponse(create, `${item.id} create session`);
    const feeSessionId = String(create.body?.feeSession?.feeSessionId || "").trim();
    if (!feeSessionId) {
      throw new Error(`${item.id} create session did not return feeSessionId`);
    }

    const calculate = await requestJson(
      `${args.feeBaseUrl}/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/calculate`,
      {
        method: "POST",
        body: {},
        headers: { "x-csrf-token": csrfToken },
        jar,
        timeoutMs: args.timeoutMs
      }
    );
    assertResponse(calculate, `${item.id} calculate`);
    const detail = await requestJson(
      `${args.feeBaseUrl}/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail?includeDebug=true`,
      { jar, timeoutMs: args.timeoutMs }
    );
    assertResponse(detail, `${item.id} detail`);

    const audit = auditCoverageRecheckCase(item, detail.body || {}, {
      expectedRevision: preflightAudit.cloudRunRevision
    });
    const control = controlsByCase.get(item.id);
    result.runs.push({
      ...audit,
      ...(control ? {
        controlComparison: compareCoverageRecheckControl(audit, control)
      } : {})
    });
    result.summary = summarizeCoverageRecheckResult(result);
    persistResult(outputDir, result);
  }
  result.status = "complete";
  result.completedAt = new Date().toISOString();
  result.summary = summarizeCoverageRecheckResult(result);
  persistResult(outputDir, result);
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.stdout.write(`result=${path.join(outputDir, "result.json")}\n`);
  process.stdout.write(`readme=${path.join(outputDir, "README.md")}\n`);
  if (!result.summary.hardCheckPassed) {
    process.exitCode = 1;
  }
} catch (error) {
  result.status = "failed";
  result.failedAt = new Date().toISOString();
  result.failure = {
    name: String(error?.name || "Error"),
    message: safeFailureMessage(error)
  };
  result.summary = summarizeCoverageRecheckResult(result);
  persistResult(outputDir, result);
  throw error;
}

function validatePreflight(body, expectedMode) {
  if (String(body.env || "").trim() !== "stg") {
    throw new Error(`fee-api is not STG: ${String(body.env || "missing")}`);
  }
  const runtime = body.runtime || {};
  const features = body.runtimeFeatures || {};
  const strategy = String(features.clinicalExtractionStrategy || "").trim();
  const coverage = features.extractionCoverage || {};
  const modes = features.whiteboxExtraction || {};
  const span = body?.feeCalculator?.whitebox?.spanDetector || {};
  const revision = String(runtime.cloudRunRevision || "").trim();
  if (!revision) {
    throw new Error("readyz did not include a Cloud Run revision");
  }
  if (strategy !== "openai_primary") {
    throw new Error(`clinical extraction strategy must be openai_primary, got ${strategy || "missing"}`);
  }
  if (String(coverage.mode || "") !== expectedMode) {
    throw new Error(
      `extraction coverage mode must be ${expectedMode}, got ${String(coverage.mode || "missing")}`
    );
  }
  if (String(modes.linker || "") !== "off" || String(modes.context || "") !== "off") {
    throw new Error("Linker and context classifier must be off for the auxiliary recheck profile");
  }
  if (String(modes.span || "") !== "shadow") {
    throw new Error(
      "Span detector runtime mode must be shadow; coverage mode controls active recheck behavior"
    );
  }
  if (span.available !== true || coverage.spanDetectorAvailable !== true) {
    throw new Error(
      `Span detector is unavailable: ${String(span.reason || coverage.spanDetectorReason || "unknown")}`
    );
  }
  if (Number(coverage.allowlistCount || 0) < 1) {
    throw new Error("extraction coverage facility allowlist is empty");
  }
  return {
    cloudRunRevision: revision,
    clinicalExtractionStrategy: strategy,
    coverageMode: String(coverage.mode || ""),
    whiteboxModes: {
      linker: String(modes.linker || ""),
      context: String(modes.context || ""),
      span: String(modes.span || "")
    },
    spanArtifactVersion: String(
      span.artifactVersion || coverage.spanArtifactVersion || ""
    )
  };
}

function validateDataset(dataset) {
  if (dataset?.syntheticDataOnly !== true) {
    throw new Error("dataset must declare syntheticDataOnly=true");
  }
  const cases = Array.isArray(dataset?.cases) ? dataset.cases : [];
  if (!cases.length) {
    throw new Error("dataset has no cases");
  }
  const ids = new Set();
  for (const item of cases) {
    const id = String(item?.id || "").trim();
    if (!id || ids.has(id)) {
      throw new Error(`dataset case id is missing or duplicated: ${id || "missing"}`);
    }
    ids.add(id);
    if (!["current_own", "past", "external", "negated", "planned"].includes(
      String(item?.safetyClass || "")
    )) {
      throw new Error(`${id} has an unsupported safetyClass`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(item?.serviceDate || ""))) {
      throw new Error(`${id} serviceDate must use YYYY-MM-DD`);
    }
    if (!String(item?.clinicalText || "").trim()) {
      throw new Error(`${id} clinicalText is required`);
    }
  }
  return cases;
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    outputDir: "",
    controlResult: "",
    password: process.env.FEE_E2E_PASSWORD || "",
    mfaCode: process.env.FEE_E2E_MFA_CODE || "",
    dryRun: false,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) {
      throw new Error(`${option} requires a value`);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dataset") parsed.dataset = next(index++, arg);
    else if (arg === "--output-dir") parsed.outputDir = next(index++, arg);
    else if (arg === "--control-result") parsed.controlResult = next(index++, arg);
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next(index++, arg);
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next(index++, arg);
    else if (arg === "--organization-code") parsed.organizationCode = next(index++, arg);
    else if (arg === "--login-id") parsed.loginId = next(index++, arg);
    else if (arg === "--password-file") parsed.passwordFile = next(index++, arg);
    else if (arg === "--mfa-code") parsed.mfaCode = next(index++, arg);
    else if (arg === "--facility-id") parsed.facilityId = next(index++, arg);
    else if (arg === "--department-id") parsed.departmentId = next(index++, arg);
    else if (arg === "--expected-mode") parsed.expectedMode = next(index++, arg);
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInteger(next(index++, arg), arg);
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  parsed.platformBaseUrl = normalizeBaseUrl(parsed.platformBaseUrl);
  parsed.feeBaseUrl = normalizeBaseUrl(parsed.feeBaseUrl);
  if (!["off", "observe", "verify"].includes(parsed.expectedMode)) {
    throw new Error("--expected-mode must be off, observe, or verify");
  }
  return parsed;
}

function resolvePassword(options) {
  if (options.password) {
    return options.password;
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

function assertStgTarget(options) {
  const hosts = [options.platformBaseUrl, options.feeBaseUrl]
    .map((value) => new URL(value).hostname.toLowerCase());
  const isStgHost = (host) => host.includes("-stg-")
    || host.startsWith("stg.")
    || host.includes(".stg.");
  if (
    !hosts.every(isStgHost)
    || !String(options.organizationCode || "").toLowerCase().endsWith("-stg")
  ) {
    throw new Error(
      "this evaluator is restricted to STG API hosts and an organization code ending in -stg"
    );
  }
}

async function requestJson(url, {
  method = "GET",
  body = undefined,
  headers = {},
  jar = null,
  timeoutMs = defaults.timeoutMs
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(jar?.header() ? { cookie: jar.header() } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : splitSetCookie(response.headers.get("set-cookie"));
    jar?.store(setCookies);
    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    return { statusCode: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

function assertResponse(response, label) {
  if (response.statusCode < 400) {
    return;
  }
  const message = String(
    response.body?.error?.message
    || response.body?.message
    || response.body?.error
    || "request failed"
  );
  throw new Error(`${label} failed (HTTP ${response.statusCode}): ${message.slice(0, 300)}`);
}

function persistResult(outputDir, result) {
  fs.writeFileSync(
    path.join(outputDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  fs.writeFileSync(path.join(outputDir, "README.md"), renderReadme(result));
}

function renderReadme(result) {
  const summary = result.summary || summarizeCoverageRecheckResult(result);
  const lines = [
    "# OpenAI主経路 + 補助Span限定再確認 STG計測",
    "",
    `- status: ${result.status}`,
    `- generatedAt: ${result.generatedAt}`,
    `- Cloud Run revision: ${result.environment?.cloudRunRevision || "unknown"}`,
    `- strategy: ${result.environment?.clinicalExtractionStrategy || "unknown"}`,
    `- coverage mode: ${result.environment?.coverageMode || "unknown"}`,
    `- Span artifact: ${result.environment?.spanArtifactVersion || "unknown"}`,
    `- cases: ${summary.runCount || 0}`,
    `- hard checks: ${summary.hardCheckPassed ? "pass" : "fail"}`,
    `- recovery observed: ${summary.coverageRecoveryObserved ? "yes" : "no"}`,
    `- full acceptance: ${summary.allAcceptanceChecksPassed ? "pass" : "not yet"}`,
    "",
    "カルテ本文、Span文字列、患者氏名は保存していません。各入力はSHA-256と行数だけを記録します。",
    "",
    "## Cases",
    ""
  ];
  for (const run of Array.isArray(result.runs) ? result.runs : []) {
    lines.push(
      `- ${run.caseId}: points=${run.totalPoints}, spans=${run.auxiliaryCoverage?.detectedSpanCount ?? "n/a"}, `
      + `gaps=${run.auxiliaryCoverage?.gapSpanCount ?? "n/a"}, `
      + `extra_calls=${run.auxiliaryCoverage?.additionalOpenAiCallCount ?? "n/a"}, `
      + `hard_check=${run.hardCheckPassed ? "pass" : "fail"}`
    );
  }
  if (result.failure) {
    lines.push("", "## Failure", "", `- ${result.failure.message}`);
  }
  lines.push(
    "",
    "補助経路が候補を復元しなかった場合、hard checksが通っていてもfull acceptanceは未達です。",
    "OpenAI初回抽出が既に全行為を拾ったケースと、補助経路が動かなかったケースを区別してください。",
    ""
  );
  return lines.join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function clinicalLineCount(value) {
  return String(value || "").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function dateStamp(value) {
  return value.toISOString().replace(/[-:.TZ]/gu, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function splitSetCookie(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(/,(?=\s*[^;,=]+=[^;,]+)/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeFailureMessage(error) {
  return String(error?.message || error || "unknown failure")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 500);
}

function printHelp() {
  process.stdout.write(`OpenAI-primary extraction coverage recheck evaluation (STG only)

Usage:
  npm run eval:fee-extraction-coverage-recheck-stg -- [options]

Options:
  --dataset PATH
  --output-dir PATH
  --control-result PATH       Optional result.json from coverage mode off
  --platform-base-url URL
  --fee-base-url URL
  --organization-code CODE
  --login-id ID
  --password-file PATH
  --mfa-code CODE
  --facility-id ID
  --department-id ID
  --expected-mode MODE        off, observe, or verify (default: verify)
  --timeout-ms MS
  --dry-run
  --help
`);
}
