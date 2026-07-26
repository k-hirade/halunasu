#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WHITEBOX_SPECIALTY_LABELS,
  buildWhiteboxShadowSessionInput,
  requiredWhiteboxCells,
  resolveWhiteboxDepartments,
  selectWhiteboxShadowCases,
  summarizeWhiteboxCaseAudits,
  whiteboxDepartmentInput,
  whiteboxShadowCaseAudit
} from "./lib/fee-whitebox-shadow-matrix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  dataset: "data/tests/fee-specialty-matrix/cases.json",
  policy: "configs/fee-whitebox-promotion-gate.json",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  serviceDate: "2026-07-25",
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
const policyPath = resolveRepoPath(args.policy);
const dataset = readJson(datasetPath);
const policy = readJson(policyPath);
const selectedCases = selectWhiteboxShadowCases(dataset, policy);
const requiredCells = requiredWhiteboxCells(policy);
const datasetSha256 = sha256File(datasetPath);
const policySha256 = sha256File(policyPath);

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    dataset: path.relative(repoRoot, datasetPath),
    policy: path.relative(repoRoot, policyPath),
    requiredCellCount: requiredCells.length,
    selectedCaseCount: selectedCases.length,
    holdoutCaseCount: selectedCases.filter((item) => item.split === "holdout").length,
    selectedCases: selectedCases.map((item) => ({
      caseId: item.caseId,
      cell: item.measurementCell,
      split: item.split
    }))
  }, null, 2)}\n`);
  process.exit(0);
}

const runId = `fee-whitebox-shadow-${dateStamp(new Date())}-${crypto.randomBytes(3).toString("hex")}`;
const outputDir = path.resolve(
  repoRoot,
  args.outputDir || path.join("docs/20260725-whitebox-three-lane-shadow", runId)
);
fs.mkdirSync(outputDir, { recursive: true });

const preflight = await requestJson(`${args.feeBaseUrl}/readyz`, {
  timeoutMs: args.timeoutMs
});
assertResponse(preflight, "fee-api readyz");
const preflightAudit = validateWhiteboxPreflight(preflight.body || {});

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
const orgId = String(authSession.body?.session?.orgId || "").trim();
if (!orgId) {
  throw new Error("auth session did not include orgId");
}

const bootstrap = await requestJson(
  `${args.platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/admin-bootstrap?section=departments`,
  { jar, timeoutMs: args.timeoutMs }
);
assertResponse(bootstrap, "organization bootstrap");
const facilityId = resolveFacilityId(bootstrap.body || {}, args.facilityId);
const departmentResolution = await ensureWhiteboxDepartments({
  args,
  orgId,
  facilityId,
  departments: bootstrap.body?.departments || [],
  requiredSpecialties: policy.requiredSpecialties,
  jar,
  csrfToken
});

const result = {
  schemaVersion: "fee-whitebox-shadow-stg-run-v1",
  generatedAt: new Date().toISOString(),
  runId,
  status: "running",
  source: {
    dataset: path.relative(repoRoot, datasetPath),
    datasetSha256,
    policy: path.relative(repoRoot, policyPath),
    policySha256,
    syntheticDataOnly: true,
    holdoutUsed: false
  },
  environment: {
    organizationCode: args.organizationCode,
    facilityId,
    cloudRunRevision: preflightAudit.cloudRunRevision,
    whiteboxModes: preflightAudit.whiteboxModes,
    artifactVersions: preflightAudit.artifactVersions
  },
  methodology: {
    requiredCellCount: requiredCells.length,
    minimumRunsPerCell: policy.telemetry.minimumRunsPerCell,
    selectedCaseCount: selectedCases.length,
    caseSelection: "development first, then train; reviewed synthetic cases only",
    holdoutPolicy: "holdout cases are excluded",
    departmentPolicy: "dedicated or existing active department with exact specialty metadata",
    telephoneRepresentation: "setting=outpatient + encounterDetails.visitKind=telephone_revisit",
    machinePrecheckOnly: true
  },
  departmentProvisioning: {
    explicitlyRequested: args.provisionDepartments,
    created: departmentResolution.created,
    specialtyDepartmentIds: departmentResolution.bySpecialty
  },
  runs: [],
  machinePrecheck: {
    status: "pending",
    warning: "This is not independent human adjudication and cannot satisfy the promotion gate.",
    cells: {}
  }
};
persistResult(outputDir, result);

try {
  for (let index = 0; index < selectedCases.length; index += 1) {
    const item = selectedCases[index];
    process.stdout.write(
      `[${index + 1}/${selectedCases.length}] ${item.measurementCell} ${item.caseId}\n`
    );
    const departmentId = departmentResolution.bySpecialty[item.specialty];
    const sessionInput = buildWhiteboxShadowSessionInput(item, {
      facilityId,
      departmentId,
      runId,
      serviceDate: args.serviceDate
    });
    const create = await requestJson(`${args.feeBaseUrl}/v1/fee/sessions`, {
      method: "POST",
      body: sessionInput,
      headers: { "x-csrf-token": csrfToken },
      jar,
      timeoutMs: args.timeoutMs
    });
    assertResponse(create, `${item.caseId} create session`);
    const feeSessionId = String(create.body?.feeSession?.feeSessionId || "").trim();
    if (!feeSessionId) {
      throw new Error(`${item.caseId} create session did not return feeSessionId`);
    }
    const calculateStartedAt = Date.now();
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
    assertResponse(calculate, `${item.caseId} calculate`);
    const detail = await requestJson(
      `${args.feeBaseUrl}/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail`,
      { jar, timeoutMs: args.timeoutMs }
    );
    assertResponse(detail, `${item.caseId} detail`);
    const performance = calculationPerformance(detail.body || {});
    const actualRevision = String(performance?.runtime?.cloudRunRevision || "").trim();
    if (!actualRevision || actualRevision !== preflightAudit.cloudRunRevision) {
      throw new Error(
        `${item.caseId} revision mismatch: readyz=${preflightAudit.cloudRunRevision}, calculation=${actualRevision || "missing"}`
      );
    }
    const audit = whiteboxShadowCaseAudit(item, detail.body || {});
    result.runs.push({
      caseId: item.caseId,
      specialty: item.specialty,
      encounterSetting: item.encounterSetting,
      measurementCell: item.measurementCell,
      split: item.split,
      feeSessionId,
      departmentId,
      serviceDate: args.serviceDate,
      cloudRunRevision: actualRevision,
      extractorVersion: String(performance?.whiteboxExtraction?.extractorVersion || ""),
      whiteboxDegraded: performance?.whiteboxExtraction?.degraded === true,
      calculateRequestMs: Date.now() - calculateStartedAt,
      machinePrecheck: audit
    });
    result.machinePrecheck.cells = summarizeWhiteboxCaseAudits(
      result.runs.map((run) => run.machinePrecheck)
    );
    persistResult(outputDir, result);
  }
  result.status = "complete";
  result.completedAt = new Date().toISOString();
  result.summary = summarizeRun(result);
  result.machinePrecheck.status = "complete";
  persistResult(outputDir, result);
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.stdout.write(`result=${path.join(outputDir, "result.json")}\n`);
} catch (error) {
  result.status = "failed";
  result.failedAt = new Date().toISOString();
  result.failure = {
    name: error?.name || "Error",
    message: String(error?.message || error).slice(0, 500)
  };
  result.summary = summarizeRun(result);
  persistResult(outputDir, result);
  throw error;
}

async function ensureWhiteboxDepartments({
  args: options,
  orgId,
  facilityId,
  departments,
  requiredSpecialties,
  jar,
  csrfToken
}) {
  const first = resolveWhiteboxDepartments(departments, {
    facilityId,
    specialties: requiredSpecialties
  });
  const created = [];
  if (first.missing.length && !options.provisionDepartments) {
    throw new Error(
      `missing specialty departments: ${first.missing.join(", ")}; `
      + "rerun with --provision-departments to create dedicated WX Shadow departments"
    );
  }
  const allDepartments = [...departments];
  for (const specialty of first.missing) {
    const response = await requestJson(
      `${options.platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/departments`,
      {
        method: "POST",
        body: whiteboxDepartmentInput(specialty, facilityId),
        headers: { "x-csrf-token": csrfToken },
        jar,
        timeoutMs: options.timeoutMs
      }
    );
    assertResponse(response, `create ${specialty} shadow department`);
    const department = response.body?.department;
    if (!department?.departmentId) {
      throw new Error(`create ${specialty} shadow department did not return departmentId`);
    }
    created.push(department.departmentId);
    allDepartments.push(department);
  }
  const resolved = resolveWhiteboxDepartments(allDepartments, {
    facilityId,
    specialties: requiredSpecialties
  });
  if (resolved.missing.length) {
    throw new Error(`specialty department resolution remained incomplete: ${resolved.missing.join(", ")}`);
  }
  return { ...resolved, created };
}

function validateWhiteboxPreflight(body = {}) {
  if (String(body.env || "").trim().toLowerCase() !== "stg") {
    throw new Error(`fee-api readyz must report env=stg; received ${body.env || "missing"}`);
  }
  const revision = String(body.runtime?.cloudRunRevision || "").trim();
  if (!revision) {
    throw new Error("fee-api readyz did not expose cloudRunRevision");
  }
  const modes = body.runtimeFeatures?.whiteboxExtraction || {};
  for (const [layer, expected] of Object.entries({
    span: "shadow",
    linker: "shadow",
    context: "shadow"
  })) {
    if (modes[layer] !== expected) {
      throw new Error(`whitebox ${layer} mode must be ${expected}; received ${modes[layer] || "missing"}`);
    }
  }
  const whitebox = body.feeCalculator?.whitebox || {};
  const artifactVersions = {};
  for (const layer of ["spanDetector", "linker", "contextClassifier"]) {
    if (whitebox[layer]?.available !== true) {
      throw new Error(
        `whitebox ${layer} is unavailable: ${whitebox[layer]?.reason || "unknown reason"}`
      );
    }
    artifactVersions[layer] = String(whitebox[layer]?.artifactVersion || "");
  }
  return {
    cloudRunRevision: revision,
    whiteboxModes: modes,
    artifactVersions
  };
}

function resolveFacilityId(bootstrap = {}, override = "") {
  const facilities = Array.isArray(bootstrap.facilities) ? bootstrap.facilities : [];
  const facilityId = String(
    override
    || facilities.find((facility) => facility?.status === "active")?.facilityId
    || facilities[0]?.facilityId
    || ""
  ).trim();
  if (!facilityId) {
    throw new Error("STG organization has no facility");
  }
  if (override && !facilities.some((facility) => facility?.facilityId === facilityId)) {
    throw new Error(`facility does not belong to the organization: ${facilityId}`);
  }
  return facilityId;
}

function calculationPerformance(detail = {}) {
  const feeSession = detail.feeSession || {};
  const metrics = feeSession.calculationProgress?.metrics || {};
  return metrics.performance || feeSession.calculationProgress?.performance || {};
}

function summarizeRun(result) {
  const runs = Array.isArray(result.runs) ? result.runs : [];
  const cells = {};
  for (const run of runs) {
    cells[run.measurementCell] = Number(cells[run.measurementCell] || 0) + 1;
  }
  return {
    status: result.status,
    runCount: runs.length,
    requiredCellCount: result.methodology.requiredCellCount,
    observedCellCount: Object.keys(cells).length,
    degradedRunCount: runs.filter((run) => run.whiteboxDegraded).length,
    uniqueCloudRunRevisions: uniqueStrings(runs.map((run) => run.cloudRunRevision)),
    uniqueExtractorVersions: uniqueStrings(runs.map((run) => run.extractorVersion)),
    cells: Object.fromEntries(Object.entries(cells).sort(([left], [right]) => (
      left.localeCompare(right)
    )))
  };
}

function persistResult(outputDir, result) {
  fs.writeFileSync(
    path.join(outputDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  fs.writeFileSync(path.join(outputDir, "README.md"), renderReadme(result));
}

function renderReadme(result) {
  const summary = result.summary || summarizeRun(result);
  const lines = [
    "# Fee White-box Three-lane STG Run",
    "",
    `- run: \`${result.runId}\``,
    `- status: **${result.status}**`,
    `- revision: \`${result.environment.cloudRunRevision}\``,
    `- cases: ${summary.runCount} / ${result.methodology.selectedCaseCount}`,
    `- cells: ${summary.observedCellCount} / ${result.methodology.requiredCellCount}`,
    `- degraded runs: ${summary.degradedRunCount}`,
    "- holdout used: no",
    "",
    "The machine precheck compares runtime encoder code sets with the reviewed synthetic "
      + "dataset. It is not independent human adjudication and must not be supplied to the "
      + "promotion gate as `fee-whitebox-adjudication-v1`.",
    "",
    "Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` "
      + "with `scripts/report_fee_whitebox_shadow.py`.",
    ""
  ];
  if (result.failure) {
    lines.push("## Failure", "", `- ${result.failure.message}`, "");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    outputDir: "",
    facilityId: "",
    password: process.env.FEE_E2E_PASSWORD || "",
    mfaCode: process.env.FEE_E2E_MFA_CODE || "",
    provisionDepartments: false,
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
    else if (arg === "--policy") parsed.policy = next(index++, arg);
    else if (arg === "--output-dir") parsed.outputDir = next(index++, arg);
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next(index++, arg);
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next(index++, arg);
    else if (arg === "--organization-code") parsed.organizationCode = next(index++, arg);
    else if (arg === "--login-id") parsed.loginId = next(index++, arg);
    else if (arg === "--password-file") parsed.passwordFile = next(index++, arg);
    else if (arg === "--mfa-code") parsed.mfaCode = next(index++, arg);
    else if (arg === "--facility-id") parsed.facilityId = next(index++, arg);
    else if (arg === "--service-date") parsed.serviceDate = next(index++, arg);
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInteger(next(index++, arg), arg);
    else if (arg === "--provision-departments") parsed.provisionDepartments = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  parsed.platformBaseUrl = normalizeBaseUrl(parsed.platformBaseUrl);
  parsed.feeBaseUrl = normalizeBaseUrl(parsed.feeBaseUrl);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed.serviceDate)) {
    throw new Error("--service-date must use YYYY-MM-DD");
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
}

function printHelp() {
  process.stdout.write(`Fee white-box three-lane shadow evaluation (STG only)

Usage:
  npm run eval:fee-whitebox-shadow-stg -- [options]

Options:
  --dataset PATH              Default: data/tests/fee-specialty-matrix/cases.json
  --policy PATH               Default: configs/fee-whitebox-promotion-gate.json
  --output-dir PATH           Output directory
  --organization-code ID      Default: yamamoto-demo-stg
  --login-id ID               Default: yamamoto-admin
  --password-file PATH        Default: .secrets/yamamoto-demo-stg-password.txt
  --mfa-code CODE             Current 6-digit MFA code (or FEE_E2E_MFA_CODE)
  --facility-id ID            Optional facility override
  --service-date YYYY-MM-DD   Default: 2026-07-25
  --provision-departments     Create missing dedicated WX Shadow departments
  --dry-run                   Validate matrix selection without network calls
  --help                      Show this help
`);
}
