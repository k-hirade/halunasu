#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createTemporarySidecarEvaluatorAuth } from "./lib/sidecar-evaluator-auth.mjs";
import { createTotpCode } from "../services/platform-api/src/auth/mfa.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(repoRoot, "clients/homis-sidecar/extension");
const selectionArtifact = readJson(path.join(
  repoRoot,
  "services/fee-api/src/fee-rule-data/sidecar-selection-axes-2026.generated.json"
));
const managementCodes = new Set(selectionArtifact.options
  .filter((option) => ["在医総管", "施医総管"].includes(option.familyName))
  .map((option) => option.code));

const defaults = {
  mockRoot: "tmp/mock_homis",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  mfaSecretFile: "",
  mfaCode: process.env.FEE_E2E_MFA_CODE || "",
  extensionId: process.env.HOMIS_SIDECAR_EXTENSION_ID
    || "nhbmaniknlcaaelpaoogepmkhphmmjof",
  outputDir: "",
  timeoutMs: 180_000,
  maxRateLimitRetries: 4
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const mockRoot = resolveRepoPath(options.mockRoot);
const pages = renderFixturePages(mockRoot);
if (pages.length !== 13) {
  throw new Error(`expected 13 mock patients, got ${pages.length}`);
}

const ready = await requestJson(`${options.feeBaseUrl}/readyz`, {
  timeoutMs: options.timeoutMs
});
assertResponse(ready, "fee-api readyz");
if (ready.body?.env !== "stg") {
  throw new Error(`refusing non-STG Fee API: ${String(ready.body?.env || "unknown")}`);
}

const mfaCode = resolveMfaCode(options);
const sidecarAuth = await createTemporarySidecarEvaluatorAuth({
  platformBaseUrl: options.platformBaseUrl,
  extensionId: options.extensionId,
  organizationCode: options.organizationCode,
  loginId: options.loginId,
  password: readSecret(options.passwordFile),
  mfaCode,
  timeoutMs: options.timeoutMs
});
const facilityId = sidecarAuth.sidecarContext?.facilityId;
if (!facilityId) {
  await sidecarAuth.close();
  throw new Error("sidecar authorization did not resolve a facility");
}

const outputDir = path.resolve(
  repoRoot,
  options.outputDir || path.join(
    "/private/tmp/homis-management-exactness-stg",
    dateStamp(new Date()),
    path.basename(mockRoot)
  )
);
fs.mkdirSync(outputDir, { recursive: true });

const result = {
  schemaVersion: "homis-management-exactness-stg-v1",
  generatedAt: new Date().toISOString(),
  status: "running",
  methodology: {
    route: "/v1/integrations/sidecar/calculate",
    mockDomExtractionUsed: true,
    selectorContractVersion: "homis-mock-v7",
    actionListUsedAsCalculationInput: false,
    actionListReadAfterResponses: true,
    scoreRule: "selectionResolution=exact and remainingOptionCount=1 and remaining code=gold"
  },
  source: {
    mockRoot: path.relative(repoRoot, mockRoot),
    mockPatientsSha256: sha256File(path.join(mockRoot, "data/patients.py")),
    patientCount: pages.length
  },
  environment: {
    feeBaseUrl: options.feeBaseUrl,
    cloudRunRevision: ready.body?.runtime?.cloudRunRevision || null,
    clinicalExtractionStrategy: ready.body?.runtimeFeatures?.clinicalExtractionStrategy || null,
    extractionCoverageMode: ready.body?.runtimeFeatures?.extractionCoverage?.mode || null,
    facilityId,
    departmentId: sidecarAuth.sidecarContext?.departmentId || null,
    grantRevoked: null
  },
  runs: []
};
persist(outputDir, result);

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const homisClientScript = fs.readFileSync(path.join(mockRoot, "static/homis.js"), "utf8");
  const homisStyles = fs.readFileSync(path.join(mockRoot, "static/style.css"), "utf8");
  for (const [index, fixture] of pages.entries()) {
    process.stdout.write(`[${index + 1}/${pages.length}] ${fixture.patientId} ${fixture.serviceDate}\n`);
    const prepared = await extractPreparedCalculation({
      browser,
      fixture,
      homisClientScript,
      homisStyles
    });
    const body = calculationBody(prepared, {
      facilityId,
      departmentId: sidecarAuth.sidecarContext?.departmentId || null
    });
    assertNoGoldFields(body);
    const credentials = await sidecarAuth.credentials();
    const response = await requestWithRateLimitRetry(
      `${options.feeBaseUrl}/v1/integrations/sidecar/calculate`,
      {
        method: "POST",
        body,
        timeoutMs: options.timeoutMs,
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          origin: `chrome-extension://${options.extensionId}`,
          "x-sidecar-code-verifier": credentials.verifier
        }
      },
      options.maxRateLimitRetries
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      result.runs.push({
        patientId: fixture.patientId,
        serviceDate: fixture.serviceDate,
        requestSha256: sha256Text(JSON.stringify(body)),
        httpStatus: response.statusCode,
        error: safeError(response.body),
        rateLimitRetryCount: response.rateLimitRetryCount
      });
    } else {
      result.runs.push({
        patientId: fixture.patientId,
        serviceDate: fixture.serviceDate,
        requestSha256: sha256Text(JSON.stringify(body)),
        httpStatus: response.statusCode,
        rateLimitRetryCount: response.rateLimitRetryCount,
        sourceRevision: Number(response.body?.sidecarDraft?.sourceRevision || 0),
        candidates: managementCandidateViews(
          response.body?.sidecarDraft?.calculation?.candidates || []
        )
      });
    }
    persist(outputDir, result);
  }

  // Gold is intentionally loaded only after every Fee API response has been received.
  const goldByPatient = readManagementGold(mockRoot);
  result.runs = result.runs.map((run) => scoreRun(run, goldByPatient.get(run.patientId)));
  result.summary = summarize(result.runs);
  result.status = "complete";
  result.completedAt = new Date().toISOString();
} catch (error) {
  result.status = "failed";
  result.failedAt = new Date().toISOString();
  result.failure = { message: String(error?.message || error).slice(0, 500) };
  throw error;
} finally {
  await browser?.close();
  const closeResult = await sidecarAuth.close();
  result.environment.grantRevoked = closeResult.revoked === true;
  if (closeResult.error) {
    result.environment.grantRevokeError = String(closeResult.error).slice(0, 300);
  }
  persist(outputDir, result);
}

process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
for (const run of result.runs) {
  process.stdout.write([
    run.patientId,
    run.outcome,
    run.expectedCode || "-",
    run.actualCode || "-",
    run.selectionResolution || "-",
    run.remainingOptionCount ?? "-",
    (run.unresolvedAxes || []).join(",") || "-"
  ].join("\t") + "\n");
}
process.stdout.write(`result=${path.join(outputDir, "result.json")}\n`);

async function extractPreparedCalculation({ browser: browserRef, fixture, homisClientScript, homisStyles }) {
  const page = await browserRef.newPage();
  try {
    await page.route("http://fixture.local/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/static/homis.js")) {
        await route.fulfill({ contentType: "text/javascript", body: homisClientScript });
        return;
      }
      if (url.pathname.endsWith("/static/style.css")) {
        await route.fulfill({ contentType: "text/css", body: homisStyles });
        return;
      }
      const pageId = url.searchParams.get("pid") || "patient_detail";
      const html = pageId === "patient_problem"
        ? fixture.problemHtml
        : pageId === "docs_index"
          ? fixture.documentsHtml
          : pageId === "patient_plan0" ? fixture.planHtml : fixture.detailHtml;
      await route.fulfill({ contentType: "text/html", body: html });
    });
    const href = `http://fixture.local/homic/?pid=patient_detail&patient_id=${fixture.patientId}`;
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
    await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
    await page.evaluate(() => {
      globalThis.__sidecarContentListener = null;
      globalThis.chrome = {
        runtime: {
          onMessage: {
            addListener(listener) {
              globalThis.__sidecarContentListener = listener;
            }
          },
          async sendMessage() {
            return {};
          }
        }
      };
    });
    await page.addScriptTag({ path: path.join(extensionDir, "content.js") });
    const preview = await callContentScript(page, { type: "halunasu:extract" });
    assertContentResponse(preview, `${fixture.patientId} preview`);
    const prepared = await callContentScript(page, {
      type: "halunasu:prepare-calculation",
      previewFingerprint: preview.previewFingerprint
    });
    assertContentResponse(prepared, `${fixture.patientId} prepare`);
    return prepared;
  } finally {
    await page.close();
  }
}

function calculationBody(prepared, context) {
  return {
    contractVersion: "v1",
    facilityId: context.facilityId,
    ...(context.departmentId ? { departmentId: context.departmentId } : {}),
    sourceSystem: "homis",
    externalPatientId: prepared.externalPatientId,
    sourceRecordId: prepared.sourceRecordId,
    ...(prepared.sourceRecordDisplayId
      ? { sourceRecordDisplayId: prepared.sourceRecordDisplayId }
      : {}),
    serviceDate: prepared.serviceDate,
    ...(prepared.receptionTime ? { receptionTime: prepared.receptionTime } : {}),
    setting: prepared.encounterType,
    encounterTypeSource: prepared.encounterTypeSource,
    ...(prepared.visitKind ? { visitKind: prepared.visitKind } : {}),
    ...(prepared.visitKindSource ? { visitKindSource: prepared.visitKindSource } : {}),
    sameBuilding: prepared.sameBuilding,
    sameBuildingSource: prepared.sameBuildingSource,
    singleBuildingPatientCount: prepared.singleBuildingPatientCount ?? null,
    residenceType: prepared.facilityResidence === true
      ? "facility"
      : prepared.privateResidence === true ? "private" : null,
    clinicalText: prepared.clinicalText,
    sourceSurfaces: prepared.sourceSurfaces,
    extractionProof: prepared.extractionProof
  };
}

function managementCandidateViews(candidates) {
  return candidates
    .filter((candidate) => candidateManagementCodes(candidate).length > 0)
    .map((candidate) => ({
      candidateId: candidate.candidateId || null,
      name: candidate.name || null,
      selectionGroupLabel: candidate.selectionGroupLabel || null,
      requiresSelection: candidate.requiresSelection === true,
      selectionResolution: candidate.selectionResolution || null,
      remainingOptionCount: Number(
        candidate.selectionNarrowing?.remainingOptionCount
        ?? candidate.selectionNarrowing?.remainingOptions?.length
        ?? 0
      ),
      remainingCodes: (candidate.selectionNarrowing?.remainingOptions || [])
        .map((option) => option.code)
        .filter(Boolean),
      unresolvedAxes: Array.isArray(candidate.selectionNarrowing?.unresolvedAxes)
        ? candidate.selectionNarrowing.unresolvedAxes
        : [],
      appliedFilters: (candidate.selectionNarrowing?.appliedFilters || []).map((filter) => ({
        axis: filter.axis || null,
        label: filter.label || null,
        evidenceLabel: filter.evidenceLabel || null,
        evidenceSource: filter.evidenceSource || null,
        evidenceStatus: filter.evidenceStatus || null,
        value: filter.value ?? null,
        completeness: filter.completeness || null,
        sourceRevision: filter.sourceRevision || null
      })),
      zone: candidate.zone || null
    }));
}

function candidateManagementCodes(candidate) {
  return [...new Set([
    candidate.code,
    ...(Array.isArray(candidate.codeCandidates) ? candidate.codeCandidates : []),
    ...(Array.isArray(candidate.selectionNarrowing?.remainingOptions)
      ? candidate.selectionNarrowing.remainingOptions.map((option) => option.code)
      : [])
  ].filter((code) => managementCodes.has(code)))];
}

function scoreRun(run, gold) {
  if (!gold) {
    return { ...run, outcome: "gold_missing" };
  }
  const familyCandidates = (run.candidates || []).filter((candidate) => {
    const label = `${candidate.selectionGroupLabel || ""} ${candidate.name || ""}`;
    return label.includes(gold.family)
      || candidate.remainingCodes.some((code) => optionFamily(code) === gold.family);
  });
  const candidate = familyCandidates[0] || null;
  const actualCode = candidate?.selectionResolution === "exact"
    && candidate.remainingOptionCount === 1
    ? candidate.remainingCodes[0] || null
    : null;
  const outcome = run.httpStatus < 200 || run.httpStatus >= 300
    ? "request_failed"
    : !candidate
      ? "candidate_missing"
      : candidate.selectionResolution === "exact"
        ? actualCode === gold.code ? "exact_match" : "wrong_exact"
        : candidate.selectionResolution === "ambiguous"
          ? "ambiguous"
          : "context_incomplete";
  return {
    ...run,
    expectedAction: gold.action,
    expectedCode: gold.code,
    family: gold.family,
    outcome,
    actualCode,
    selectionResolution: candidate?.selectionResolution || null,
    remainingOptionCount: candidate?.remainingOptionCount ?? null,
    remainingCodes: candidate?.remainingCodes || [],
    unresolvedAxes: candidate?.unresolvedAxes || [],
    appliedFilters: candidate?.appliedFilters || [],
    candidateZone: candidate?.zone || null
  };
}

function summarize(runs) {
  const total = runs.length;
  const count = (outcome) => runs.filter((run) => run.outcome === outcome).length;
  const exactMatchCount = count("exact_match");
  return {
    patientCount: total,
    selectionExactMatchCount: exactMatchCount,
    selectionExactMatchRate: total ? exactMatchCount / total : 0,
    wrongExactCount: count("wrong_exact"),
    ambiguousCount: count("ambiguous"),
    contextIncompleteCount: runs.filter((run) => (
      run.outcome !== "request_failed"
      && run.outcome !== "candidate_missing"
      && Array.isArray(run.unresolvedAxes)
      && run.unresolvedAxes.length > 0
    )).length,
    candidateMissingCount: count("candidate_missing"),
    requestFailedCount: count("request_failed"),
    rateLimitRetryCount: runs.reduce((sum, run) => sum + Number(run.rateLimitRetryCount || 0), 0)
  };
}

function readManagementGold(mockRootPath) {
  const script = [
    "import json",
    "from data.patients import PATIENTS, TARGET_MONTH, TARGET_YEAR",
    "month = f'{TARGET_YEAR}-{TARGET_MONTH:02d}'",
    "payload = []",
    "for patient in PATIENTS:",
    "    visits = sorted(patient['visits'][month], key=lambda visit: visit['day'], reverse=True)",
    "    actions = [str(action) for action in visits[0]['action_list'] if str(action).startswith(('在医総管', '施医総管'))]",
    "    payload.append({'patientId': str(patient['id']), 'actions': actions})",
    "print(json.dumps(payload, ensure_ascii=False))"
  ].join("\n");
  const rows = runPython(mockRootPath, script);
  return new Map(rows.map((row) => {
    if (row.actions.length !== 1) {
      throw new Error(`${row.patientId}: expected exactly one management gold action`);
    }
    const action = row.actions[0];
    const option = expectedOption(action);
    return [row.patientId, { action, code: option.code, family: option.familyName }];
  }));
}

function expectedOption(action) {
  const normalized = String(action).normalize("NFKC").replace(/\s+/gu, "");
  const familyName = normalized.startsWith("在医総管")
    ? "在医総管"
    : normalized.startsWith("施医総管") ? "施医総管" : "";
  const patientCount = /2[~〜～]9人/u.test(normalized) ? { min: 2, max: 9 } : { min: 1, max: 1 };
  const monthlyVisits = normalized.includes("月1回") ? "one" : "two_or_more";
  const specialDisease = normalized.includes("難病等");
  const matches = selectionArtifact.options.filter((option) => (
    option.familyName === familyName
    && option.axes?.facilityClass === "enhanced_support"
    && option.axes?.bed === true
    && option.axes?.patientCount?.min === patientCount.min
    && option.axes?.patientCount?.max === patientCount.max
    && option.axes?.monthlyVisits === monthlyVisits
    && option.axes?.telemedicine === false
    && option.axes?.specialDisease === specialDisease
    && option.axes?.reduced === false
    && option.axes?.specialProvision === false
  ));
  if (matches.length !== 1) {
    throw new Error(`cannot resolve management gold action: ${action}`);
  }
  return matches[0];
}

function optionFamily(code) {
  return selectionArtifact.options.find((option) => option.code === code)?.familyName || null;
}

function renderFixturePages(mockRootPath) {
  const script = [
    "import json",
    "from data.patients import PATIENTS",
    "from render import docs_page, patient_detail_page, plan_page, problem_page, _visits_desc",
    "payload = []",
    "for patient in PATIENTS:",
    "    latest = _visits_desc(patient)[0]",
    "    payload.append({",
    "        'patientId': str(patient['id']),",
    "        'serviceDate': latest[0],",
    "        'detailHtml': patient_detail_page(patient),",
    "        'problemHtml': problem_page(patient),",
    "        'documentsHtml': docs_page(patient),",
    "        'planHtml': plan_page(patient),",
    "    })",
    "print(json.dumps(payload, ensure_ascii=False))"
  ].join("\n");
  return runPython(mockRootPath, script);
}

function runPython(cwd, script) {
  const command = spawnSync("python3", ["-c", script], {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  if (command.status !== 0) {
    throw new Error(String(command.stderr || command.stdout || "python fixture export failed").trim());
  }
  return JSON.parse(command.stdout);
}

function callContentScript(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    globalThis.__sidecarContentListener(payload, {}, resolve);
  }), message);
}

function assertContentResponse(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed: ${String(response?.error || "unknown extraction error")}`);
  }
}

function assertNoGoldFields(body) {
  const serialized = JSON.stringify(body);
  for (const forbidden of ["actionList", "action_list", "expectedCode", "expectedAction"]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`runtime request contains forbidden gold field: ${forbidden}`);
    }
  }
}

async function requestWithRateLimitRetry(url, requestOptions, maxRetries) {
  let retryCount = 0;
  while (true) {
    const response = await requestJson(url, requestOptions);
    if (response.statusCode !== 429 || retryCount >= maxRetries) {
      return { ...response, rateLimitRetryCount: retryCount };
    }
    const retryAfterSeconds = Number(response.retryAfter || 0);
    const delayMs = retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(60_000, 5_000 * (2 ** retryCount));
    retryCount += 1;
    process.stdout.write(`[rate-limit] retry ${retryCount}/${maxRetries} in ${delayMs}ms\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function requestJson(url, {
  method = "GET",
  body = undefined,
  headers = {},
  timeoutMs = defaults.timeoutMs
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      body: parsed
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertResponse(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed (HTTP ${response.statusCode}): ${safeError(response.body)}`);
  }
}

function safeError(body) {
  return String(body?.message || body?.error?.message || body?.error || body?.raw || "request failed")
    .slice(0, 300);
}

function resolveMfaCode(input) {
  if (/^\d{6}$/u.test(String(input.mfaCode || "").trim())) {
    return String(input.mfaCode).trim();
  }
  if (input.mfaSecretFile) {
    return createTotpCode(readSecret(input.mfaSecretFile));
  }
  throw new Error("--mfa-code or --mfa-secret-file is required");
}

function readSecret(filename) {
  const resolved = resolveRepoPath(filename);
  const value = fs.readFileSync(resolved, "utf8").trim();
  if (!value) {
    throw new Error(`secret file is empty: ${filename}`);
  }
  return value;
}

function persist(outputDirPath, payload) {
  fs.writeFileSync(
    path.join(outputDirPath, "result.json"),
    `${JSON.stringify(payload, null, 2)}\n`
  );
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function sha256File(filename) {
  return sha256Text(fs.readFileSync(filename));
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function dateStamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function parseArgs(argv) {
  const parsed = { ...defaults, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      parsed.help = true;
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`unknown or incomplete option: ${key}`);
    }
    const name = key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (!(name in parsed)) {
      throw new Error(`unknown option: ${key}`);
    }
    parsed[name] = argv[++index];
  }
  parsed.timeoutMs = Number(parsed.timeoutMs);
  parsed.maxRateLimitRetries = Number(parsed.maxRateLimitRetries);
  if (!Number.isInteger(parsed.maxRateLimitRetries) || parsed.maxRateLimitRetries < 0) {
    throw new Error("--max-rate-limit-retries must be a non-negative integer");
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/evaluate_homis_management_exactness_stg.mjs [options]\n"
    + "  --mock-root PATH          mock root (default tmp/mock_homis)\n"
    + "  --output-dir PATH         result directory\n"
    + "  --login-id ID             STG approver login\n"
    + "  --password-file PATH      STG password file\n"
    + "  --mfa-code CODE           current six-digit TOTP\n"
    + "  --mfa-secret-file PATH    local TOTP secret used without printing the code\n"
    + "  --extension-id ID         approved Chrome extension ID\n"
  );
}
