#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureFeeEvaluationSurface } from "./lib/fee-longitudinal-evaluation.mjs";
import {
  buildStabilityBaseline,
  candidateKey,
  summarizeStabilitySuite,
  validateStabilityBaseline
} from "./lib/fee-extraction-stability.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  casesFile: "data/tests/fee-stability/cases.json",
  baselineFile: "data/tests/fee-stability/baseline.json",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  repeat: 3,
  timeoutMs: 180_000
};

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers = []) {
    for (const header of headers) {
      const pair = String(header || "").split(";")[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  get(name) {
    return this.cookies.get(name) || "";
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
assertEvaluationTarget(args);

const fixture = loadCases(args.casesFile);
if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    source: path.relative(repoRoot, fixture.filePath),
    syntheticDataOnly: fixture.syntheticDataOnly,
    repeat: args.repeat,
    cases: fixture.cases.map(caseAudit)
  }, null, 2)}\n`);
  process.exit(0);
}

const baselinePath = path.resolve(repoRoot, args.baselineFile);
const baselineExists = fs.existsSync(baselinePath);
if (!args.writeBaseline && !baselineExists) {
  throw new Error(
    `stability baseline not found: ${args.baselineFile}; run once with --write-baseline and review the generated result`
  );
}
if (args.writeBaseline && baselineExists && !args.replaceBaseline) {
  throw new Error(
    `stability baseline already exists: ${args.baselineFile}; use --replace-baseline only after reviewing the regression`
  );
}
const loadedBaseline = !args.writeBaseline && baselineExists
  ? validateStabilityBaseline(readJson(baselinePath), fixture.cases.map((item) => item.id))
  : null;

const preflight = await readPreflight(args);
const runId = `fee-stability-${dateStamp(new Date())}-${crypto.randomBytes(3).toString("hex")}`;
const outputDir = path.resolve(repoRoot, args.outputDir || path.join("/private/tmp", runId));
fs.mkdirSync(outputDir, { recursive: true });

const password = resolvePassword(args);
const jar = new CookieJar();
const login = await requestJson(`${args.platformBaseUrl}/v1/auth/login`, {
  method: "POST",
  body: {
    organizationCode: args.organizationCode,
    loginId: args.loginId,
    password,
    ...(args.mfaCode ? { mfaCode: args.mfaCode } : {})
  },
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(login, "login");
const csrfToken = String(login.body?.csrfToken || jar.get("halunasu_csrf") || jar.get("halunasu_stg_csrf") || "");
if (!csrfToken) throw new Error("login did not return a CSRF token");

const authSession = await requestJson(`${args.platformBaseUrl}/v1/auth/session`, {
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(authSession, "auth session");
const orgId = String(authSession.body?.session?.orgId || "");
if (!orgId) throw new Error("auth session did not include orgId");

const context = await resolveEvaluationContext({ args, jar, orgId });
const api = createFeeApiClient({
  baseUrl: args.feeBaseUrl,
  jar,
  csrfToken,
  timeoutMs: args.timeoutMs,
  runId
});

const measuredCases = [];
for (let caseIndex = 0; caseIndex < fixture.cases.length; caseIndex += 1) {
  const fixtureCase = fixture.cases[caseIndex];
  const runs = [];
  for (let repeatIndex = 1; repeatIndex <= args.repeat; repeatIndex += 1) {
    process.stdout.write(
      `[${caseIndex + 1}/${fixture.cases.length}] ${fixtureCase.id}: ${repeatIndex}/${args.repeat}\n`
    );
    runs.push(await runOnce({
      api,
      context,
      fixtureCase,
      repeatIndex,
      runId
    }));
  }
  measuredCases.push({ id: fixtureCase.id, runs });
}

const allRuns = measuredCases.flatMap((item) => item.runs);
const revisions = uniqueStrings(allRuns.map((run) => run.runtime?.cloudRunRevision));
const revisionStable = revisions.length <= 1;
const preflightRevisionMatch = (
  isLocalUrl(args.feeBaseUrl)
  || !preflight.cloudRunRevision
  || (revisions.length === 1 && revisions[0] === preflight.cloudRunRevision)
);
let baseline = loadedBaseline;
let summary = summarizeStabilitySuite({ cases: measuredCases, baseline });
let baselineAction = "used";
if (args.writeBaseline) {
  if (!revisionStable || !preflightRevisionMatch) {
    throw new Error("refusing to write a stability baseline across different Cloud Run revisions");
  }
  baseline = buildStabilityBaseline(summary, {
    sourceRunId: runId,
    generatedAt: new Date().toISOString()
  });
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  summary = summarizeStabilitySuite({ cases: measuredCases, baseline });
  baselineAction = baselineExists ? "replaced" : "created";
}

summary = {
  ...summary,
  environmentStable: revisionStable && preflightRevisionMatch,
  preflightRevisionMatch,
  verdict: revisionStable && preflightRevisionMatch ? summary.verdict : "fail"
};
const result = {
  schemaVersion: "fee-extraction-stability-eval.v1",
  generatedAt: new Date().toISOString(),
  runId,
  mode: isLocalUrl(args.feeBaseUrl) ? "local" : "stg",
  source: {
    casesFile: path.relative(repoRoot, fixture.filePath),
    syntheticDataOnly: fixture.syntheticDataOnly,
    caseCount: fixture.cases.length,
    clinicalTextHashes: Object.fromEntries(fixture.cases.map((item) => [item.id, sha256(item.clinicalText)]))
  },
  environment: {
    platformBaseUrl: args.platformBaseUrl,
    feeBaseUrl: args.feeBaseUrl,
    organizationCode: args.organizationCode,
    facilityRef: opaqueRef(context.facilityId),
    departmentRef: opaqueRef(context.departmentId),
    preflight,
    cloudRunRevisions: revisions,
    sameRevisionObserved: revisionStable,
    preflightRevisionMatch
  },
  methodology: {
    repeat: args.repeat,
    isolation: "fresh synthetic patient and fresh fee session for every repetition",
    confirmedPoints: "feeSession.calculationResult.totalPoints",
    candidateSet: "candidate workbench pending lines and proposals keyed by code, code candidates, and normalized title",
    attribution: "memo and prior-patient history are excluded; remaining candidate/event variability belongs to full extraction",
    eventCount: "clinicalExtraction.clinicalEventCount; recorded but not used as a pass/fail gate"
  },
  baseline: {
    file: path.relative(repoRoot, baselinePath),
    action: baselineAction,
    sourceRunId: baseline?.sourceRunId || null
  },
  summary,
  cases: fixture.cases.map((fixtureCase) => {
    const measured = measuredCases.find((item) => item.id === fixtureCase.id);
    const caseSummary = summary.cases.find((item) => item.caseId === fixtureCase.id);
    return {
      id: fixtureCase.id,
      title: fixtureCase.title,
      sourcePattern: fixtureCase.sourcePattern,
      inputAudit: caseAudit(fixtureCase),
      summary: caseSummary,
      runs: measured.runs
    };
  })
};

const resultPath = path.join(outputDir, "result.json");
const readmePath = path.join(outputDir, "README.md");
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(readmePath, renderReadme(result));
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`result=${resultPath}\nreadme=${readmePath}\n`);
if (result.summary.verdict !== "pass") process.exitCode = 1;

async function runOnce({ api, context, fixtureCase, repeatIndex, runId: id }) {
  const uniqueKey = `${id}:${fixtureCase.id}:${repeatIndex}`;
  const payload = {
    patient: {
      displayName: `抽出安定性評価 ${opaqueRef(uniqueKey)}`,
      birthDate: fixtureCase.patient.birthDate,
      sex: fixtureCase.patient.sex,
      externalPatientIds: [`fee-stability:${uniqueKey}`]
    },
    patientRef: `fee-stability-${fixtureCase.id}`,
    facilityId: context.facilityId,
    departmentId: context.departmentId,
    serviceDate: fixtureCase.serviceDate,
    claimMonth: fixtureCase.serviceDate.slice(0, 7),
    setting: fixtureCase.setting,
    ...(fixtureCase.encounterDetails ? { encounterDetails: fixtureCase.encounterDetails } : {}),
    clinicalText: fixtureCase.clinicalText,
    diagnoses: fixtureCase.diagnoses.map((name) => ({ name, status: "confirmed" })),
    diagnosesSource: "manual",
    sourceSystem: `fee_extraction_stability:${id}:${fixtureCase.id}:r${repeatIndex}`
  };
  const created = await api.request("POST", "/v1/fee/sessions", payload, {
    csrf: true,
    tag: `${fixtureCase.id}-r${repeatIndex}-create`
  });
  assertResponse(created, `${fixtureCase.id} run ${repeatIndex} create`);
  const feeSessionId = String(created.body?.feeSession?.feeSessionId || "");
  if (!feeSessionId) throw new Error(`${fixtureCase.id} run ${repeatIndex} did not return feeSessionId`);

  const calculated = await api.request(
    "POST",
    `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/calculate`,
    {},
    { csrf: true, tag: `${fixtureCase.id}-r${repeatIndex}-calculate` }
  );
  assertResponse(calculated, `${fixtureCase.id} run ${repeatIndex} calculate`);

  const detail = await api.request(
    "GET",
    `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail`,
    undefined,
    { tag: `${fixtureCase.id}-r${repeatIndex}-detail` }
  );
  assertResponse(detail, `${fixtureCase.id} run ${repeatIndex} detail`);
  const surface = captureFeeEvaluationSurface(detail.body || {});
  return {
    run: repeatIndex,
    sessionRef: opaqueRef(feeSessionId),
    totalPoints: surface.totalPoints,
    confirmedLines: surface.confirmedLines,
    candidateItems: surface.candidateItems,
    candidateKeys: surface.candidateItems.map(candidateKey),
    reviewIssues: surface.reviewIssues,
    extraction: surface.extraction,
    patientHistory: surface.patientHistory,
    openAi: surface.openAi,
    runtime: surface.runtime,
    requestDurationMs: Number(calculated.durationMs || 0)
  };
}

function loadCases(relativePath) {
  const filePath = path.resolve(repoRoot, relativePath);
  const value = readJson(filePath);
  if (value.schemaVersion !== "fee-extraction-stability-cases.v1") {
    throw new Error(`unsupported stability case schema: ${value.schemaVersion || "missing"}`);
  }
  if (value.syntheticDataOnly !== true) {
    throw new Error("stability cases must explicitly declare syntheticDataOnly=true");
  }
  if (!Array.isArray(value.cases) || value.cases.length < 3) {
    throw new Error("stability corpus requires at least three cases");
  }
  const ids = new Set();
  const cases = value.cases.map((item, index) => {
    const id = requiredString(item.id, `cases[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate stability case id: ${id}`);
    ids.add(id);
    const serviceDate = requiredString(item.serviceDate, `cases[${index}].serviceDate`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)) {
      throw new Error(`${id} serviceDate must use YYYY-MM-DD`);
    }
    const clinicalText = requiredString(item.clinicalText, `${id}.clinicalText`);
    const diagnoses = uniqueStrings(item.diagnoses);
    if (!diagnoses.length) throw new Error(`${id} requires at least one diagnosis`);
    const patient = item.patient || {};
    const birthDate = requiredString(patient.birthDate, `${id}.patient.birthDate`);
    const sex = requiredString(patient.sex, `${id}.patient.sex`);
    if (!["male", "female", "other", "unknown"].includes(sex)) {
      throw new Error(`${id} patient sex is invalid`);
    }
    return {
      id,
      title: requiredString(item.title, `${id}.title`),
      sourcePattern: requiredString(item.sourcePattern, `${id}.sourcePattern`),
      serviceDate,
      setting: requiredString(item.setting, `${id}.setting`),
      encounterDetails: item.encounterDetails || null,
      patient: { birthDate, sex },
      diagnoses,
      clinicalText
    };
  });
  return { filePath, syntheticDataOnly: true, cases };
}

function caseAudit(item) {
  return {
    id: item.id,
    title: item.title,
    sourcePattern: item.sourcePattern,
    serviceDate: item.serviceDate,
    setting: item.setting,
    diagnosisCount: item.diagnoses.length,
    clinicalTextHash: sha256(item.clinicalText),
    clinicalTextLineCount: item.clinicalText.split(/\r?\n/u).filter((line) => line.trim()).length
  };
}

async function readPreflight(options) {
  const response = await requestJson(`${options.feeBaseUrl}/readyz`, {
    timeoutMs: options.timeoutMs
  });
  assertResponse(response, "fee-api readyz preflight");
  const environment = String(response.body?.env || "").trim().toLowerCase();
  if (!isLocalUrl(options.feeBaseUrl) && environment !== "stg") {
    throw new Error(`fee-api readyz expected env=stg but received ${environment || "unknown"}`);
  }
  return {
    checkedAt: new Date().toISOString(),
    environment: environment || null,
    cloudRunService: String(response.body?.runtime?.cloudRunService || "") || null,
    cloudRunRevision: String(response.body?.runtime?.cloudRunRevision || "") || null,
    promptVersion: String(response.body?.runtimeFeatures?.feeClinicalPromptVersion || "") || null,
    requestDurationMs: Number(response.durationMs || 0)
  };
}

function createFeeApiClient({ baseUrl, jar, csrfToken, timeoutMs, runId }) {
  return {
    request(method, apiPath, body, options = {}) {
      const tag = `${runId}-${options.tag || "request"}`;
      const separator = apiPath.includes("?") ? "&" : "?";
      return requestJson(`${baseUrl}${apiPath}${separator}evalRunId=${encodeURIComponent(tag)}`, {
        method,
        body,
        jar,
        timeoutMs,
        headers: {
          "x-eval-run-id": tag,
          ...(options.csrf ? { "x-csrf-token": csrfToken } : {})
        }
      });
    }
  };
}

async function requestJson(url, { method = "GET", body, headers = {}, jar, timeoutMs = defaults.timeoutMs } = {}) {
  const requestHeaders = { accept: "application/json", ...headers };
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  if (jar?.header()) requestHeaders.cookie = jar.header();
  const startedAt = performance.now();
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const responseText = await response.text();
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get("set-cookie"));
  jar?.store(setCookies);
  let parsed = {};
  try {
    parsed = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsed = { error: "non_json_response", message: responseText.slice(0, 200) };
  }
  return {
    statusCode: response.status,
    durationMs: round(performance.now() - startedAt, 2),
    body: parsed
  };
}

async function resolveEvaluationContext({ args: options, jar, orgId }) {
  const hasFacilityId = Boolean(String(options.facilityId || "").trim());
  const hasDepartmentId = Boolean(String(options.departmentId || "").trim());
  if (hasFacilityId !== hasDepartmentId) {
    throw new Error("--facility-id and --department-id must be specified together");
  }
  if (hasFacilityId) {
    return {
      facilityId: String(options.facilityId).trim(),
      departmentId: String(options.departmentId).trim()
    };
  }

  const bootstrap = await requestJson(
    `${options.platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/admin-bootstrap?section=departments`,
    { jar, timeoutMs: options.timeoutMs }
  );
  assertResponse(bootstrap, "organization bootstrap");
  const facilities = Array.isArray(bootstrap.body?.facilities) ? bootstrap.body.facilities : [];
  const departments = Array.isArray(bootstrap.body?.departments) ? bootstrap.body.departments : [];
  const facility = facilities.find((item) => item.status === "active") || facilities[0];
  if (!facility?.facilityId) throw new Error("evaluation organization has no facility");
  const department = departments.find((item) => (
    item.status === "active" && (!item.facilityId || item.facilityId === facility.facilityId)
  )) || departments[0];
  if (!department?.departmentId) throw new Error("evaluation organization has no department");
  return { facilityId: facility.facilityId, departmentId: department.departmentId };
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    outputDir: "",
    facilityId: "",
    departmentId: "",
    password: process.env.FEE_E2E_PASSWORD || "",
    mfaCode: process.env.FEE_E2E_MFA_CODE || "",
    writeBaseline: false,
    replaceBaseline: false,
    dryRun: false,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases-file") parsed.casesFile = next(index++, arg);
    else if (arg === "--baseline-file") parsed.baselineFile = next(index++, arg);
    else if (arg === "--output-dir") parsed.outputDir = next(index++, arg);
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next(index++, arg);
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next(index++, arg);
    else if (arg === "--organization-code") parsed.organizationCode = next(index++, arg);
    else if (arg === "--login-id") parsed.loginId = next(index++, arg);
    else if (arg === "--password-file") parsed.passwordFile = next(index++, arg);
    else if (arg === "--mfa-code") parsed.mfaCode = next(index++, arg);
    else if (arg === "--repeat") parsed.repeat = integerInRange(next(index++, arg), arg, 3, 10);
    else if (arg === "--timeout-ms") parsed.timeoutMs = integerInRange(next(index++, arg), arg, 1, 600_000);
    else if (arg === "--facility-id") parsed.facilityId = next(index++, arg);
    else if (arg === "--department-id") parsed.departmentId = next(index++, arg);
    else if (arg === "--write-baseline") parsed.writeBaseline = true;
    else if (arg === "--replace-baseline") {
      parsed.writeBaseline = true;
      parsed.replaceBaseline = true;
    } else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  parsed.platformBaseUrl = normalizeBaseUrl(parsed.platformBaseUrl);
  parsed.feeBaseUrl = normalizeBaseUrl(parsed.feeBaseUrl);
  return parsed;
}

function resolvePassword(options) {
  if (options.password) return options.password;
  const filePath = path.resolve(repoRoot, options.passwordFile);
  if (!fs.existsSync(filePath)) throw new Error(`password file not found: ${options.passwordFile}`);
  const password = fs.readFileSync(filePath, "utf8").trim();
  if (!password) throw new Error("password file is empty");
  return password;
}

function assertEvaluationTarget(options) {
  const urls = [options.platformBaseUrl, options.feeBaseUrl];
  const local = urls.every(isLocalUrl);
  if (local) return;
  const hosts = urls.map((value) => new URL(value).hostname.toLowerCase());
  const isStgHost = (host) => host.includes("-stg-") || host.startsWith("stg.") || host.includes(".stg.");
  if (!hosts.every(isStgHost) || !String(options.organizationCode || "").toLowerCase().endsWith("-stg")) {
    throw new Error("this evaluator is restricted to local APIs or STG hosts with an organization code ending in -stg");
  }
}

function renderReadme(result) {
  const rows = result.cases.map((item) => (
    `| ${item.id} | ${item.summary.verdict} | ${item.summary.confirmedPoints.values.join(" / ")} | `
    + `${item.summary.confirmedPoints.variance} | ${formatRatio(item.summary.candidates.minimumJaccard)} | `
    + `${formatRatio(item.summary.candidates.gate.minimum)} | ${item.summary.clinicalEvents.counts.join(" / ")} | `
    + `${item.summary.clinicalEvents.spread} |`
  )).join("\n");
  const failed = result.cases.filter((item) => item.summary.verdict === "fail");
  return `# 診療報酬抽出安定性評価\n\n`
    + `- 実行日時: ${result.generatedAt}\n`
    + `- Run ID: ${result.runId}\n`
    + `- 環境: ${result.mode}\n`
    + `- Cloud Run revision: ${result.environment.cloudRunRevisions.join(", ") || "取得できず"}\n`
    + `- 基線: ${result.baseline.file} (${result.baseline.action})\n`
    + `- 反復: ${result.methodology.repeat}回/ケース（毎回、新規の合成患者・新規セッション）\n\n`
    + `## 判定\n\n`
    + `- 全ケースの確定点数分散0: ${result.summary.allConfirmedPointVarianceZero ? "合格" : "不合格"}\n`
    + `- 候補Jaccard基線: ${result.summary.allCandidateJaccardChecksPassed === null ? "未基線" : result.summary.allCandidateJaccardChecksPassed ? "合格" : "不合格"}\n`
    + `- 同一revisionでの計測: ${result.summary.environmentStable ? "合格" : "不合格"}\n`
    + `- 総合: ${result.summary.verdict}\n\n`
    + `| ケース | 判定 | 確定点数 | 分散 | 候補Jaccard最小 | 基線 | イベント数 | 最大差 |\n`
    + `| --- | --- | --- | ---: | ---: | ---: | --- | ---: |\n`
    + `${rows}\n\n`
    + `## 帰属\n\n`
    + `各反復は患者履歴と抽出メモを共有しません。候補集合・イベント数の差は全文抽出経路の`
    + `非決定性として記録し、確定点数に波及しないことを必須条件とします。イベント数自体は`
    + `正解を意味しないため、単独では合否に使いません。\n\n`
    + `## 不合格\n\n`
    + `${failed.length ? failed.map((item) => `- ${item.id}: ${item.summary.confirmedPoints.pass ? "候補Jaccard低下" : "確定点数が変動"}`).join("\n") : "なし。"}\n\n`
    + `確定明細、候補集合、レビュー事項、抽出メトリクスは [result.json](./result.json) に保存しています。\n`;
}

function printHelp() {
  process.stdout.write(`Fee extraction stability evaluation (STG or local only)\n\nUsage:\n  npm run eval:fee-extraction-stability -- [options]\n\nOptions:\n  --cases-file PATH       Default: data/tests/fee-stability/cases.json\n  --baseline-file PATH    Default: data/tests/fee-stability/baseline.json\n  --repeat N              Repetitions per case, 3-10. Default: 3\n  --output-dir PATH       Default: /private/tmp/<run-id>\n  --organization-code ID  Default: yamamoto-demo-stg\n  --login-id ID           Default: yamamoto-admin\n  --password-file PATH    Default: .secrets/yamamoto-demo-stg-password.txt\n  --mfa-code CODE         Current 6-digit MFA code (or FEE_E2E_MFA_CODE)\n  --facility-id ID        Optional facility override\n  --department-id ID      Optional department override\n  --write-baseline        Create the initial reviewed candidate-Jaccard baseline\n  --replace-baseline      Replace an existing baseline intentionally\n  --dry-run               Validate fixtures without network calls\n  --help                  Show this help\n`);
}

function assertResponse(response, label) {
  if (response.statusCode < 400) return;
  const message = String(response.body?.error?.message || response.body?.message || response.body?.error || "request failed");
  throw new Error(`${label} failed (HTTP ${response.statusCode}): ${message.slice(0, 300)}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function splitSetCookie(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/u);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function isLocalUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname);
}

function integerInRange(value, label, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return numeric;
}

function opaqueRef(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function dateStamp(value) {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function formatRatio(value) {
  if (value === null || value === undefined) return "-";
  return `${round(Number(value) * 100, 1)}%`;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}
