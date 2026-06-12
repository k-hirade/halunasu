#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const datasetPath = path.resolve(repoRoot, args.dataset);
const reportDir = path.resolve(repoRoot, args.reportDir);
const dataset = readJson(datasetPath);
const cases = Array.isArray(dataset.cases) ? dataset.cases : [];

if (!cases.length) {
  throw new Error(`No cases found in dataset: ${path.relative(repoRoot, datasetPath)}`);
}

fs.mkdirSync(reportDir, { recursive: true });

const usedCaseIds = args.excludePrevious ? readUsedCaseIds(reportDir) : new Set();
let pool = cases.filter((item) => !usedCaseIds.has(item.caseId));
if (args.assertionLevel) {
  const levels = new Set(csv(args.assertionLevel));
  pool = pool.filter((item) => levels.has(item.expectedCalculation?.assertionLevel));
}
if (args.caseIds.length) {
  const requested = new Set(args.caseIds);
  pool = cases.filter((item) => requested.has(item.caseId));
}

const selected = selectRandom(pool, args.count, args.seed);
if (!selected.length) {
  throw new Error("No v2 cases matched the requested filters");
}

const password = resolvePassword(args);
const runners = csv(args.loginIds);
if (!runners.length) {
  throw new Error("--login-ids must include at least one runner login ID");
}

console.log("Fee SOAP E2E v2 STG random run");
console.log(JSON.stringify({
  dataset: path.relative(repoRoot, datasetPath),
  reportDir: path.relative(repoRoot, reportDir),
  seed: args.seed,
  requestedCount: args.count,
  selectedCount: selected.length,
  excludePrevious: args.excludePrevious,
  usedCaseCount: usedCaseIds.size,
  assertionLevel: args.assertionLevel || null,
  organizationCode: args.organizationCode,
  loginIds: runners,
  dryRun: args.dryRun,
  useExpectedClaimContext: args.useExpectedClaimContext,
  cases: selected.map((item, index) => ({
    n: index + 1,
    caseId: item.caseId,
    assertionLevel: item.expectedCalculation?.assertionLevel || null,
    difficultyLevel: item.difficultyLevel || null,
    title: item.title || ""
  }))
}, null, 2));

if (args.dryRun) {
  process.exit(0);
}

const completedReports = [];
let commandFailures = 0;

for (let index = 0; index < selected.length; index += 1) {
  const item = selected[index];
  const runner = runners[index % runners.length];
  const outputPrefix = `${args.outputPrefix}-${String(index + 1).padStart(2, "0")}-${safeName(item.caseId)}`;
  const evaluatorArgs = [
    "scripts/evaluate_fee_soap_e2e_dataset.mjs",
    "--mode", "stg",
    "--dataset", path.relative(repoRoot, datasetPath),
    "--report-dir", path.relative(repoRoot, reportDir),
    "--case", item.caseId,
    "--output-prefix", outputPrefix,
    "--verbose"
  ];
  if (args.useExpectedClaimContext) evaluatorArgs.push("--use-expected-claim-context");
  if (args.noSeedVisitHistory) evaluatorArgs.push("--no-seed-visit-history");
  if (args.verboseApiLogs) evaluatorArgs.push("--verbose-api-logs");
  if (args.strict) evaluatorArgs.push("--strict");

  console.log(`\n== ${index + 1}/${selected.length} ${item.caseId} via ${runner} ==`);
  const result = spawnSync(process.execPath, evaluatorArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      FEE_E2E_PLATFORM_BASE_URL: args.platformBaseUrl,
      FEE_E2E_FEE_BASE_URL: args.feeBaseUrl,
      FEE_E2E_ORGANIZATION_CODE: args.organizationCode,
      FEE_E2E_LOGIN_ID: runner,
      FEE_E2E_PASSWORD: password
    }
  });

  const reportPath = path.join(reportDir, `${outputPrefix}.json`);
  if (fs.existsSync(reportPath)) {
    completedReports.push(reportPath);
  }
  if (result.error) {
    console.error(result.error);
    commandFailures += 1;
  } else if (result.status !== 0) {
    console.error(`case ${item.caseId} exited with status ${result.status}`);
    commandFailures += 1;
  }
}

const results = completedReports.flatMap((reportPath) => {
  const report = readJson(reportPath);
  return Array.isArray(report.results) ? report.results : [];
});
const passed = results.filter((item) => item.status === "passed").length;
const failed = results.length - passed;
const failureByStage = {};
for (const item of results.filter((result) => result.status !== "passed")) {
  const stage = item.failedStage || "unknown";
  failureByStage[stage] = (failureByStage[stage] || 0) + 1;
}
const avgDurationMs = results.length
  ? Math.round(results.reduce((sum, item) => sum + Number(item.durationMs?.total || 0), 0) / results.length)
  : 0;

console.log("\nFee SOAP E2E v2 STG random summary");
console.log(JSON.stringify({
  selected: selected.length,
  completed: results.length,
  passed,
  failed,
  passRate: results.length ? passed / results.length : 0,
  failureByStage,
  avgDurationMs,
  commandFailures,
  reportDir: path.relative(repoRoot, reportDir)
}, null, 2));

if (args.strict && (failed > 0 || commandFailures > 0)) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {
    count: 10,
    seed: Date.now(),
    dataset: "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json",
    reportDir: "data/tests/fee-soap-e2e-v2/reports",
    outputPrefix: `stg-v2-random-${dateStamp(new Date())}`,
    platformBaseUrl: process.env.FEE_E2E_PLATFORM_BASE_URL || "https://platform-api-stg-lp2t3inhza-an.a.run.app",
    feeBaseUrl: process.env.FEE_E2E_FEE_BASE_URL || "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
    organizationCode: process.env.FEE_E2E_ORGANIZATION_CODE || "fee-e2e",
    loginIds: process.env.FEE_E2E_LOGIN_IDS || "fee-e2e-runner,fee-e2e-runner-2,fee-e2e-runner-3,fee-e2e-runner-4,fee-e2e-runner-5",
    passwordFile: process.env.FEE_E2E_PASSWORD_FILE || "/private/tmp/halunasu-fee-e2e-stg-password.txt",
    password: process.env.FEE_E2E_PASSWORD || "",
    assertionLevel: "",
    caseIds: [],
    excludePrevious: true,
    useExpectedClaimContext: false,
    noSeedVisitHistory: false,
    verboseApiLogs: false,
    strict: false,
    dryRun: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--count") parsed.count = Number(next());
    else if (arg === "--seed") parsed.seed = Number(next());
    else if (arg === "--dataset") parsed.dataset = next();
    else if (arg === "--report-dir") parsed.reportDir = next();
    else if (arg === "--output-prefix") parsed.outputPrefix = next();
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next();
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next();
    else if (arg === "--organization-code") parsed.organizationCode = next();
    else if (arg === "--login-ids") parsed.loginIds = next();
    else if (arg === "--password-file") parsed.passwordFile = next();
    else if (arg === "--password") parsed.password = next();
    else if (arg === "--assertion") parsed.assertionLevel = next();
    else if (arg === "--case") parsed.caseIds.push(next());
    else if (arg === "--include-previous") parsed.excludePrevious = false;
    else if (arg === "--use-expected-claim-context") parsed.useExpectedClaimContext = true;
    else if (arg === "--no-seed-visit-history") parsed.noSeedVisitHistory = true;
    else if (arg === "--verbose-api-logs") parsed.verboseApiLogs = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(parsed.count) || parsed.count <= 0) {
    throw new Error("--count must be a positive integer");
  }
  if (!Number.isFinite(parsed.seed)) {
    throw new Error("--seed must be a number");
  }
  return parsed;
}

function readUsedCaseIds(dir) {
  if (!fs.existsSync(dir)) return new Set();
  const used = new Set();
  for (const fileName of fs.readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const report = readJson(path.join(dir, fileName));
      for (const result of Array.isArray(report.results) ? report.results : []) {
        if (result.caseId) used.add(result.caseId);
      }
      if (report.caseId) used.add(report.caseId);
    } catch {
      // Ignore partial or unrelated report files.
    }
  }
  return used;
}

function selectRandom(items, count, seed) {
  const pool = [...items];
  let state = Math.trunc(seed) % 2147483647;
  if (state <= 0) state += 2147483646;
  const selected = [];
  while (selected.length < count && pool.length) {
    state = (state * 48271) % 2147483647;
    const index = Math.floor((state / 2147483647) * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

function resolvePassword(options) {
  if (options.password) return options.password;
  const passwordPath = path.resolve(repoRoot, options.passwordFile);
  if (!fs.existsSync(passwordPath)) {
    throw new Error([
      `Password file not found: ${passwordPath}`,
      "Create/reset the STG E2E runner password with:",
      "npm run seed:core-account -- --env stg --organization-code fee-e2e --organization-name \"Fee E2E\" --login-ids fee-e2e-runner,fee-e2e-runner-2,fee-e2e-runner-3,fee-e2e-runner-4,fee-e2e-runner-5 --products fee --generate-password-file /private/tmp/halunasu-fee-e2e-stg-password.txt --reset-password --apply"
    ].join("\n"));
  }
  const password = fs.readFileSync(passwordPath, "utf8").trim();
  if (!password) {
    throw new Error(`Password file is empty: ${passwordPath}`);
  }
  return password;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeName(value) {
  return String(value || "case").replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

function dateStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function printHelp() {
  console.log(`Usage:
  node scripts/run_fee_soap_e2e_v2_stg_random.mjs [options]

Options:
  --count N                        Number of random v2 cases. Default: 10
  --seed N                         Deterministic random seed. Default: current timestamp
  --dataset PATH                   v2 dataset path
  --report-dir PATH                Report directory. Default: data/tests/fee-soap-e2e-v2/reports
  --output-prefix NAME             Prefix for per-case reports
  --assertion LEVEL[,LEVEL]        Filter assertion levels
  --case CASE_ID                   Run explicit case ID. Repeatable
  --include-previous               Do not exclude cases already present in the v2 report directory
  --use-expected-claim-context     Debug/gold replay mode; bypass SOAP extraction
  --no-seed-visit-history          Do not seed prior visit history for revisit cases
  --verbose-api-logs               Pass through verbose API logs to evaluator
  --strict                         Exit non-zero when any selected case fails
  --dry-run                        Print selected cases without running STG

STG/auth options:
  --platform-base-url URL
  --fee-base-url URL
  --organization-code CODE
  --login-ids ID1,ID2
  --password-file PATH
  --password VALUE
`);
}
