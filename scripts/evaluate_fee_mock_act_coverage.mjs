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
  summarizeMockActCoverage
} from "./lib/fee-mock-act-coverage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  mockRoot: "tmp/mock_homis",
  actionMap: "tmp/dataset_recalculation_diff_diagnosis/20260702_185214_mock_homis/homis_action_master_map.csv",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  facilityId: "fac_9fe275b29feebb03bfeb9410f7",
  departmentId: "dep_00d6c56dcd8b4d65acf0d8f2ab",
  selectorContractVersion: "homis-mock-v3",
  claimMonth: "",
  claimMonths: "2026-05,2026-06",
  timeoutMs: 180_000
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const dataset = exportCases(args);
const mappingRows = fs.existsSync(resolveRepoPath(args.actionMap))
  ? parseCsv(fs.readFileSync(resolveRepoPath(args.actionMap), "utf8"))
  : [];
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

const accessToken = secretValue(args.accessToken, args.accessTokenFile, "HOMIS_SIDECAR_ACCESS_TOKEN");
const verifier = secretValue(args.verifier, args.verifierFile, "HOMIS_SIDECAR_CODE_VERIFIER");
const extensionId = String(args.extensionId || process.env.HOMIS_SIDECAR_EXTENSION_ID || "").trim();
if (!accessToken || !verifier || !/^[a-p]{32}$/u.test(extensionId)) {
  throw new Error(
    "live evaluation requires --access-token/--access-token-file, "
    + "--verifier/--verifier-file, and a 32-character --extension-id"
  );
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

const result = {
  schemaVersion: "fee-mock-act-coverage-run-v1",
  generatedAt: new Date().toISOString(),
  status: "running",
  source: {
    syntheticDataOnly: true,
    mockPatientsSha256: sha256File(path.join(resolveRepoPath(args.mockRoot), "data/patients.py")),
    actionMapSha256: fs.existsSync(resolveRepoPath(args.actionMap))
      ? sha256File(resolveRepoPath(args.actionMap))
      : null,
    claimMonths: dataset.claimMonths
  },
  environment: {
    feeBaseUrl: args.feeBaseUrl,
    facilityId: args.facilityId,
    departmentId: args.departmentId,
    cloudRunRevision: ready.body?.runtime?.cloudRunRevision || null
  },
  methodology: {
    route: "/v1/integrations/sidecar/calculate",
    actionListUsedAsCalculationInput: false,
    persistedRawClinicalText: false,
    actionClasses: [
      "billable_line",
      "claim_comment",
      "claim_attribute",
      "patient_charge",
      "unknown"
    ]
  },
  classification,
  runs: []
};
persist(outputDir, result);

for (let index = 0; index < dataset.cases.length; index += 1) {
  const item = dataset.cases[index];
  process.stdout.write(`[${index + 1}/${dataset.cases.length}] ${item.caseId}\n`);
  const body = sidecarBody(item, args);
  const response = await requestJson(`${args.feeBaseUrl}/v1/integrations/sidecar/calculate`, {
    method: "POST",
    body,
    timeoutMs: args.timeoutMs,
    headers: {
      authorization: `Bearer ${accessToken}`,
      origin: `chrome-extension://${extensionId}`,
      "x-sidecar-code-verifier": verifier
    }
  });
  assertResponse(response, item.caseId);
  result.runs.push(auditMockActCoverageCase(item, response.body, mappingRows));
  reconcileMockActCoverageRuns(result.runs, mappingRows);
  result.summary = summarizeMockActCoverage(result.runs);
  persist(outputDir, result);
}

result.status = "complete";
result.completedAt = new Date().toISOString();
reconcileMockActCoverageRuns(result.runs, mappingRows);
result.summary = summarizeMockActCoverage(result.runs);
persist(outputDir, result);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`result=${path.join(outputDir, "result.json")}\n`);

function sidecarBody(item, options) {
  const extractedAt = new Date().toISOString();
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
      requiredElementCount: 4,
      matchedRequiredElementCount: 4,
      clinicalTextNodeCount: Math.max(1, String(item.clinicalText || "").split(/\n/u).length)
    }
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
      `- billableMatchRate: ${formatPercent(payload.summary?.billableMatchRate)}`,
      `- confirmedBillableRate: ${formatPercent(payload.summary?.confirmedBillableRate)}`,
      `- commentDetectionRate: ${formatPercent(payload.summary?.commentDetectionRate)}`,
      `- falseProposalCount: ${payload.summary?.falseProposalCount ?? 0}`,
      "",
      "行為欄は評価専用であり、算定APIへの入力には使用していません。",
      "患者名とカルテ本文は保存せず、本文はSHA-256のみを記録しています。",
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
      body: text ? JSON.parse(text) : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertResponse(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed (HTTP ${response.statusCode}): ${JSON.stringify(response.body).slice(0, 400)}`);
  }
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
  return parsed;
}

function printHelp() {
  process.stdout.write(
    "Usage: npm run eval:fee-mock-act-coverage -- [options]\n"
    + "  --dry-run                     classify all mock actions without calling STG\n"
    + "  --access-token-file PATH      scoped sidecar token file\n"
    + "  --verifier-file PATH          sidecar PKCE verifier file\n"
    + "  --extension-id ID             approved Chrome extension ID\n"
    + "  --claim-month YYYY-MM         evaluate one target month\n"
    + "  --claim-months LIST           comma-separated months (default 2026-05,2026-06)\n"
    + "  --output-dir PATH             report directory\n"
  );
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

function dateStamp(value) {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "n/a";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
