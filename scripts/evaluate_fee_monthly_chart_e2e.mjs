#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  patientDir: "tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "nishiyama-demo-stg",
  loginId: "nishiyama-admin",
  passwordFile: ".secrets/nishiyama-demo-password.txt",
  repeat: 3,
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
      if (separator > 0) this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
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

assertStgTarget(args);

const patientDir = path.resolve(repoRoot, args.patientDir);
const manifest = readJson(path.join(patientDir, "manifest.json"));
const claimMonth = args.claimMonth || String(manifest.claimMonth || "").slice(0, 7);
if (!/^\d{4}-\d{2}$/u.test(claimMonth)) {
  throw new Error("claim month must use YYYY-MM");
}

const patients = parseCsv(fs.readFileSync(path.join(patientDir, "patients.csv"), "utf8"));
const patient = patients.find((item) => String(item.patient_id || "") === String(manifest.patientId || "")) || patients[0];
if (!patient) {
  throw new Error("patients.csv did not contain a patient");
}
const externalPatientId = String(patient.patient_id || manifest.patientId || "").trim();
const charts = fs.readFileSync(path.join(patientDir, "charts.jsonl"), "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((item) => String(item.patient_id || "") === externalPatientId)
  .filter((item) => String(item.claim_month || "").slice(0, 7) === claimMonth)
  .sort((a, b) => String(a.service_date || "").localeCompare(String(b.service_date || "")));
if (!charts.length) {
  throw new Error(`charts.jsonl did not contain ${externalPatientId} / ${claimMonth}`);
}

const ukePath = path.join(patientDir, manifest.files?.baselineReceipt || "RECEIPTC.UKE");
const baselineClaims = parseUke(ukePath, claimMonth);
const baselineClaim = baselineClaims.find((claim) => String(claim.patientId || "") === externalPatientId) || baselineClaims[0];
if (!baselineClaim) {
  throw new Error("UKE parser returned no baseline claim");
}

const inputAudit = {
  patientRef: externalPatientId,
  claimMonth,
  chartCount: charts.length,
  chartHashes: charts.map((item) => sha256(String(item.clinical_text || ""))),
  baselineCodeCount: aggregateLines(baselineClaim.lines).length,
  baselineOccurrenceCount: aggregateLines(baselineClaim.lines).reduce((sum, line) => sum + line.count, 0),
  baselineTotalPoints: baselineTotalPoints(baselineClaim),
  prohibitedCalculationInputs: ["orders.csv", "receipt/UKE codes", "expectedClaimContext"],
  calculationPayloadKeys: []
};

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({ mode: "dry-run", patientDir: path.relative(repoRoot, patientDir), inputAudit }, null, 2)}\n`);
  process.exit(0);
}

const password = resolvePassword(args);
const runId = `monthly-chart-e2e-${dateStamp(new Date())}-${crypto.randomBytes(3).toString("hex")}`;
const outputDir = path.resolve(repoRoot, args.outputDir || path.join("/private/tmp", runId));
fs.mkdirSync(outputDir, { recursive: true });

const jar = new CookieJar();
const login = await requestJson(`${args.platformBaseUrl}/v1/auth/login`, {
  method: "POST",
  body: { organizationCode: args.organizationCode, loginId: args.loginId, password },
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(login, "login");
const csrfToken = String(login.body?.csrfToken || jar.get("halunasu_csrf") || jar.get("halunasu_stg_csrf") || "");
if (!csrfToken) {
  throw new Error("login did not return a CSRF token");
}

const authSession = await requestJson(`${args.platformBaseUrl}/v1/auth/session`, {
  jar,
  timeoutMs: args.timeoutMs
});
assertResponse(authSession, "auth session");
const orgId = String(authSession.body?.session?.orgId || "");
if (!orgId) {
  throw new Error("auth session did not include orgId");
}
const bootstrap = await requestJson(
  `${args.platformBaseUrl}/v1/organizations/${encodeURIComponent(orgId)}/admin-bootstrap?section=departments`,
  { jar, timeoutMs: args.timeoutMs }
);
assertResponse(bootstrap, "organization bootstrap");
const context = resolveFacilityContext(bootstrap.body || {}, args);
const api = createFeeApiClient({
  baseUrl: args.feeBaseUrl,
  jar,
  csrfToken,
  timeoutMs: args.timeoutMs,
  runId
});

const repeats = [];
for (let repeatIndex = 1; repeatIndex <= args.repeat; repeatIndex += 1) {
  process.stdout.write(`repeat ${repeatIndex}/${args.repeat}: creating ${charts.length} chart sessions\n`);
  const repetition = await runRepetition({
    api,
    runId,
    repeatIndex,
    patient,
    externalPatientId,
    charts,
    claimMonth,
    baselineClaim,
    context,
    seedKnownPriorHistory: args.seedKnownPriorHistory,
    encounterSetting: args.encounterSetting
  });
  repeats.push(repetition);
  process.stdout.write(
    `repeat ${repeatIndex}/${args.repeat}: monthly=${repetition.monthly.totalPoints} baseline=${repetition.baseline.totalPoints} matched=${repetition.comparison.matchedCodeCount}/${repetition.comparison.baselineCodeCount}\n`
  );
}

const result = {
  schemaVersion: "fee-monthly-chart-e2e.v1",
  generatedAt: new Date().toISOString(),
  runId,
  mode: "stg",
  source: {
    patientDir: path.relative(repoRoot, patientDir),
    manifestSchemaVersion: manifest.schemaVersion || null,
    syntheticDataOnly: true
  },
  environment: {
    platformBaseUrl: args.platformBaseUrl,
    feeBaseUrl: args.feeBaseUrl,
    organizationCode: args.organizationCode,
    facilityRef: opaqueRef(context.facilityId),
    departmentRef: opaqueRef(context.departmentId),
    facilityStandardKeys: context.facilityStandardKeys
  },
  security: {
    chartTextIncluded: false,
    patientNameIncluded: false,
    credentialsIncluded: false,
    expectedReceiptWithheldUntilComparison: true,
    structuredOrdersSentToCalculation: false,
    expectedClaimContextSentToCalculation: false
  },
  inputAudit,
  evaluationOptions: {
    repeat: args.repeat,
    seedKnownPriorHistory: args.seedKnownPriorHistory,
    encounterSetting: args.encounterSetting
  },
  summary: summarizeRepeats(repeats),
  repeats
};

const resultPath = path.join(outputDir, "result.json");
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`result=${resultPath}\n`);

async function runRepetition({
  api,
  runId,
  repeatIndex,
  patient,
  externalPatientId,
  charts,
  claimMonth,
  baselineClaim,
  context,
  seedKnownPriorHistory,
  encounterSetting = "outpatient"
}) {
  const requestTimings = [];
  const sessions = [];
  let internalPatientId = "";
  let priorHistorySeed = null;

  const patientInput = {
    displayName: `月次E2E ${runId.slice(-10)} R${repeatIndex}`,
    birthDate: normalizeBirthDate(patient.birth_date),
    sex: normalizeSex(patient.sex),
    externalPatientIds: [`monthly-e2e:${runId}:${repeatIndex}:${externalPatientId}`]
  };

  if (seedKnownPriorHistory) {
    const priorServiceDate = normalizeBirthDate(patient.start_date);
    if (!priorServiceDate || priorServiceDate >= `${claimMonth}-01`) {
      throw new Error("--seed-known-prior-history requires patients.csv start_date before the claim month");
    }
    const seedPayload = {
      patient: patientInput,
      patientRef: `mock-homis-${externalPatientId}`,
      facilityId: context.facilityId,
      departmentId: context.departmentId,
      serviceDate: priorServiceDate,
      claimMonth: priorServiceDate.slice(0, 7),
      setting: "outpatient",
      sourceSystem: `fee_monthly_chart_e2e_known_history:${runId}:r${repeatIndex}`
    };
    assertNoLeakedInputs(seedPayload);
    const seed = await api.request("POST", "/v1/fee/sessions", seedPayload, {
      csrf: true,
      tag: `r${repeatIndex}-prior-history`
    });
    requestTimings.push(timingRecord("seed_prior_history", 0, seed));
    assertResponse(seed, "seed known prior history");
    internalPatientId = String(seed.body?.feeSession?.patientId || "");
    const seedSessionId = String(seed.body?.feeSession?.feeSessionId || "");
    if (!internalPatientId || !seedSessionId) {
      throw new Error("prior history response did not include patientId and feeSessionId");
    }
    priorHistorySeed = {
      source: "patients.csv.start_date",
      serviceDate: priorServiceDate,
      sessionRef: opaqueRef(seedSessionId)
    };
  }

  for (let chartIndex = 0; chartIndex < charts.length; chartIndex += 1) {
    const chart = charts[chartIndex];
    const createPayload = compactObject({
      ...(internalPatientId ? { patientId: internalPatientId } : { patient: patientInput }),
      patientRef: `mock-homis-${externalPatientId}`,
      facilityId: context.facilityId,
      departmentId: context.departmentId,
      serviceDate: String(chart.service_date || ""),
      claimMonth,
      setting: encounterSetting,
      clinicalText: String(chart.clinical_text || ""),
      sourceSystem: `fee_monthly_chart_e2e:${runId}:r${repeatIndex}`
    });
    assertNoLeakedInputs(createPayload);
    const create = await api.request("POST", "/v1/fee/sessions", createPayload, {
      csrf: true,
      tag: `r${repeatIndex}-v${chartIndex + 1}-create`
    });
    requestTimings.push(timingRecord("create_session", chartIndex + 1, create));
    assertResponse(create, `create session ${chartIndex + 1}`);
    const feeSession = create.body?.feeSession || {};
    internalPatientId = internalPatientId || String(feeSession.patientId || "");
    const feeSessionId = String(feeSession.feeSessionId || "");
    if (!internalPatientId || !feeSessionId) {
      throw new Error("create session response did not include patientId and feeSessionId");
    }

    const calculatePayload = {};
    assertNoLeakedInputs(calculatePayload);
    const calculate = await api.request(
      "POST",
      `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/calculate`,
      calculatePayload,
      { csrf: true, tag: `r${repeatIndex}-v${chartIndex + 1}-calculate` }
    );
    requestTimings.push(timingRecord("calculate", chartIndex + 1, calculate));
    assertResponse(calculate, `calculate session ${chartIndex + 1}`);

    const detail = await api.request(
      "GET",
      `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail`,
      undefined,
      { tag: `r${repeatIndex}-v${chartIndex + 1}-detail` }
    );
    requestTimings.push(timingRecord("detail", chartIndex + 1, detail));
    assertResponse(detail, `session detail ${chartIndex + 1}`);
    sessions.push(sanitizeSessionDetail(detail.body || {}, chart, feeSessionId));
  }

  const monthlyResponse = await api.request(
    "GET",
    `/v1/fee/monthly-receipt?patientId=${encodeURIComponent(internalPatientId)}&claimMonth=${encodeURIComponent(claimMonth)}`,
    undefined,
    { tag: `r${repeatIndex}-monthly` }
  );
  requestTimings.push(timingRecord("monthly_receipt", 0, monthlyResponse));
  assertResponse(monthlyResponse, "monthly receipt");
  const monthly = sanitizeMonthlyReceipt(monthlyResponse.body?.receiptDraft || {});

  const mappedBaseline = {
    ...baselineClaim,
    patientId: internalPatientId,
    claimMonth
  };
  const diagnosisResponse = await api.request(
    "POST",
    "/v1/fee/baseline-diagnosis",
    { claimMonth, baselineClaims: [mappedBaseline] },
    { csrf: true, tag: `r${repeatIndex}-baseline` }
  );
  requestTimings.push(timingRecord("baseline_diagnosis", 0, diagnosisResponse));
  assertResponse(diagnosisResponse, "baseline diagnosis");
  const targetDiagnosis = (diagnosisResponse.body?.diagnoses || [])
    .find((item) => String(item.patientId || "") === internalPatientId);
  if (!targetDiagnosis) {
    throw new Error("baseline diagnosis did not include the newly created patient");
  }

  const baselineLines = aggregateLines(baselineClaim.lines);
  const monthlyLines = aggregateLines(monthly.lines);
  const comparison = compareAggregates(baselineLines, monthlyLines);
  // 2段評価: 確定明細のみの一致(comparison)と、承認待ち候補まで含めた検知(detection)を分ける。
  // 候補は自動採用しない設計のため、検知率は「確認すれば到達できる上限」を示す。
  // コード未確定(1/2区分の同点タイ等)の候補は codeCandidates を検知一致の分子として展開する。
  const expandedCandidateLines = monthly.candidateLines.flatMap((line) => {
    if (line.code) return [line];
    return (line.codeCandidates || []).map((code) => ({ ...line, code }));
  });
  const detectionLines = aggregateLines([
    ...monthly.lines,
    ...expandedCandidateLines.filter((line) => line.code)
  ]);
  const detection = compareAggregates(baselineLines, detectionLines);
  const candidateSurface = aggregateLines(sessions.flatMap((session) => session.candidateSurface.lines));

  return {
    repeat: repeatIndex,
    patientRef: opaqueRef(internalPatientId),
    priorHistorySeed,
    sessionRefs: sessions.map((item) => item.sessionRef),
    baseline: {
      codeCount: baselineLines.length,
      occurrenceCount: baselineLines.reduce((sum, line) => sum + line.count, 0),
      totalPoints: baselineTotalPoints(baselineClaim),
      lines: baselineLines
    },
    visits: sessions,
    candidateSurface: {
      codeCount: candidateSurface.length,
      lines: candidateSurface,
      proposalCount: sessions.reduce((sum, item) => sum + item.candidateSurface.proposalCount, 0),
      issueCount: sessions.reduce((sum, item) => sum + item.candidateSurface.issueCount, 0)
    },
    monthly,
    comparison,
    detection: {
      matchedCodeCount: detection.matchedCodeCount,
      baselineOnlyCount: detection.baselineOnlyCount,
      codeRecall: detection.codeRecall,
      rows: detection.rows.filter((row) => row.status !== "engine_only")
    },
    endpointComparison: sanitizeEndpointDiagnosis(targetDiagnosis),
    performance: summarizePerformance(requestTimings, sessions),
    requestTimings
  };
}

function sanitizeSessionDetail(body, chart, feeSessionId) {
  const feeSession = body.feeSession || {};
  const calculation = feeSession.calculationResult || {};
  const workbench = body.candidateWorkbench || {};
  const extraction = calculation.clinicalExtraction || {};
  const lineSource = Array.isArray(workbench.lines) && workbench.lines.length
    ? workbench.lines.map((line) => line.lineItem || line)
    : calculation.lineItems || [];
  const metrics = feeSession.calculationProgress?.metrics || {};
  return {
    sessionRef: opaqueRef(feeSessionId),
    serviceDate: String(chart.service_date || feeSession.serviceDate || ""),
    chartHash: sha256(String(chart.clinical_text || "")),
    totalPoints: Number(calculation.totalPoints || 0),
    diagnoses: (feeSession.diagnoses || []).map((item) => String(item.name || item)).filter(Boolean),
    candidateSurface: {
      lines: aggregateLines(lineSource),
      proposals: (workbench.proposals || []).map(sanitizeActionItem),
      issues: (workbench.issues || []).map(sanitizeActionItem),
      proposalCount: Number(workbench.counts?.proposals || workbench.proposals?.length || 0),
      issueCount: Number(workbench.counts?.issues || workbench.issues?.length || 0)
    },
    extraction: {
      source: extraction.source || metrics.clinicalStructuring?.source || null,
      model: extraction.model || metrics.clinicalStructuring?.model || null,
      reasoningEffort: extraction.reasoningEffort || metrics.clinicalStructuring?.reasoningEffort || null,
      promptVersion: extraction.promptVersion || null,
      ruleSetVersion: extraction.ruleSetVersion || null,
      masterVersion: extraction.masterVersion || null,
      runRef: extraction.runId ? opaqueRef(extraction.runId) : null,
      clinicalEventCount: Number(extraction.clinicalEventCount || 0),
      billingCandidateCount: Number(extraction.billingCandidateCount || 0),
      reviewIssueCount: Number(extraction.reviewIssueCount || 0)
    },
    calculationMetrics: sanitizeCalculationMetrics(metrics)
  };
}

function sanitizeMonthlyReceipt(receipt) {
  const lines = aggregateLines(receipt.lines || []);
  const candidateLines = (Array.isArray(receipt.candidateLines) ? receipt.candidateLines : []).map((line) => ({
    code: line.code || null,
    codeCandidates: Array.isArray(line.codeCandidates) ? line.codeCandidates : [],
    name: String(line.name || ""),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || 0),
    occurrenceCount: Number(line.occurrenceCount || 1),
    suppressedOccurrenceCount: Number(line.suppressedOccurrenceCount || 0),
    conflicts: Array.isArray(line.conflicts) ? line.conflicts.map((item) => item.withCode) : []
  }));
  return {
    status: receipt.status || null,
    claimMonth: receipt.claimMonth || null,
    sessionCount: Number(receipt.sessionCount || 0),
    actualDays: Number(receipt.actualDays || 0),
    totalPoints: Number(receipt.totalPoints || 0),
    codeCount: lines.length,
    lines,
    // 2段表示の下段(承認待ち候補)。確定一致とは別に「候補まで含む検知率」を評価する。
    candidateLines,
    candidateTotalPoints: Number(receipt.candidateTotalPoints || 0)
  };
}

function sanitizeEndpointDiagnosis(diagnosis) {
  const rows = (diagnosis.comparisonRows || []).map((row) => ({
    status: row.comparisonStatus || "",
    code: String(row.code || ""),
    name: String(row.name || ""),
    baselineCount: Number(row.baselineCount || 0),
    engineCount: Number(row.engineCount || 0),
    baselinePoints: Number(row.baselinePoints || 0),
    enginePoints: Number(row.enginePoints || 0),
    deltaPoints: Number(row.deltaPoints || 0),
    reason: String(row.reason || "")
  }));
  return {
    baselineTotalPoints: Number(diagnosis.baselineTotalPoints || 0),
    engineTotalPoints: Number(diagnosis.engineTotalPoints || 0),
    matchedCount: rows.filter((row) => row.status === "matched").length,
    baselineOnlyCount: rows.filter((row) => row.status === "baseline_only").length,
    engineOnlyCount: rows.filter((row) => row.status === "engine_only").length,
    bothDeltaCount: rows.filter((row) => row.status === "both_delta").length,
    rows
  };
}

function sanitizeActionItem(item) {
  return compactObject({
    code: item.code || item.masterCode || item.lineItem?.code || undefined,
    title: item.displayTitle || item.title || item.name || undefined,
    potentialPoints: Number(item.potentialPoints || item.totalPoints || item.points || 0),
    canAdopt: item.canAdopt === true,
    actionType: item.actionType || undefined
  });
}

function sanitizeCalculationMetrics(metrics) {
  const clinical = metrics.clinicalStructuring || {};
  const ruleBased = metrics.ruleBasedClinicalInference || {};
  return {
    stageTimings: (metrics.stageTimings || []).map((item) => ({
      stage: item.stage || item.name || "",
      durationMs: Number(item.durationMs || item.ms || 0)
    })),
    clinicalStructuringMs: Number(clinical.durationMs || 0),
    openAiProviderMs: Number(clinical.openAiProviderDurationMs || 0),
    firstOutputTextMs: clinical.firstOutputTextMs ?? null,
    ruleBasedInferenceMs: Number(ruleBased.durationMs || 0),
    masterLookupMs: Number((clinical.masterLookupDurationMs || 0) + (ruleBased.masterLookupDurationMs || 0)),
    masterLookupCount: Number((clinical.masterLookupCount || 0) + (ruleBased.masterLookupCount || 0))
  };
}

function compareAggregates(baselineLines, engineLines) {
  const baseline = new Map(baselineLines.map((line) => [line.code, line]));
  const engine = new Map(engineLines.map((line) => [line.code, line]));
  const rows = [...new Set([...baseline.keys(), ...engine.keys()])].sort().map((code) => {
    const left = baseline.get(code) || null;
    const right = engine.get(code) || null;
    let status = "matched";
    if (left && !right) status = "baseline_only";
    else if (!left && right) status = "engine_only";
    else if (left.count !== right.count || left.totalPoints !== right.totalPoints) status = "both_delta";
    return {
      status,
      code,
      name: right?.name || left?.name || "",
      baselineCount: left?.count || 0,
      engineCount: right?.count || 0,
      baselinePoints: left?.totalPoints || 0,
      enginePoints: right?.totalPoints || 0,
      deltaPoints: (right?.totalPoints || 0) - (left?.totalPoints || 0)
    };
  });
  const matchedCodeCount = rows.filter((row) => row.status === "matched").length;
  const baselineCodeCount = baselineLines.length;
  const engineCodeCount = engineLines.length;
  return {
    baselineCodeCount,
    engineCodeCount,
    matchedCodeCount,
    baselineOnlyCount: rows.filter((row) => row.status === "baseline_only").length,
    engineOnlyCount: rows.filter((row) => row.status === "engine_only").length,
    bothDeltaCount: rows.filter((row) => row.status === "both_delta").length,
    codeRecall: baselineCodeCount ? round(matchedCodeCount / baselineCodeCount) : null,
    codePrecision: engineCodeCount ? round(matchedCodeCount / engineCodeCount) : null,
    exactMatch: rows.every((row) => row.status === "matched"),
    rows
  };
}

function aggregateLines(lines = []) {
  const map = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const code = String(line.code || line.masterCode || "").trim();
    if (!code) continue;
    const count = Number(line.count ?? line.quantity ?? 1) || 0;
    const pointsPerUnit = Number(line.points || 0) || 0;
    const totalPoints = line.totalPoints != null
      ? Number(line.totalPoints) || 0
      : pointsPerUnit * count;
    const current = map.get(code) || { code, name: "", count: 0, totalPoints: 0 };
    current.name ||= String(line.name || line.displayTitle || "");
    current.count += count;
    current.totalPoints += totalPoints;
    map.set(code, current);
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function summarizeRepeats(repeats) {
  const monthlySignatures = repeats.map((item) => sha256(JSON.stringify(item.monthly.lines)));
  const candidateSignatures = repeats.map((item) => sha256(JSON.stringify(item.candidateSurface.lines)));
  const issueSignatures = repeats.map((item) => sha256(JSON.stringify(
    item.visits.map((visit) => visit.candidateSurface.issues)
  )));
  const calculateTimings = repeats.flatMap((item) => item.requestTimings)
    .filter((item) => item.operation === "calculate")
    .map((item) => item.durationMs);
  const allOpenAi = repeats.flatMap((item) => item.visits.map((visit) => visit.extraction.source === "openai"));
  return {
    repeatCount: repeats.length,
    visitCountPerRepeat: repeats[0]?.visits.length || 0,
    allCalculationsUsedOpenAi: allOpenAi.length > 0 && allOpenAi.every(Boolean),
    candidateResultStable: new Set(candidateSignatures).size === 1,
    monthlyResultStable: new Set(monthlySignatures).size === 1,
    reviewIssueResultStable: new Set(issueSignatures).size === 1,
    reviewIssueCounts: repeats.map((item) => item.candidateSurface.issueCount),
    clinicalEventCounts: repeats.map((item) => item.visits.map((visit) => visit.extraction.clinicalEventCount)),
    // 抽出安定性: 同一カルテの反復間でイベント数がどれだけ揺れたか(受診ごとの min/max/spread)。
    // spread が大きい受診は抽出揺れが確定点数へ波及するリスクの監視対象。
    extractionStability: summarizeExtractionStability(repeats),
    exactMatchRuns: repeats.filter((item) => item.comparison.exactMatch).length,
    baselineCodeCount: repeats[0]?.comparison.baselineCodeCount || 0,
    matchedCodeCounts: repeats.map((item) => item.comparison.matchedCodeCount),
    detectionMatchedCodeCounts: repeats.map((item) => item.detection?.matchedCodeCount ?? null),
    monthlyCandidateTotalPoints: repeats.map((item) => item.monthly.candidateTotalPoints ?? null),
    baselineOnlyCounts: repeats.map((item) => item.comparison.baselineOnlyCount),
    engineOnlyCounts: repeats.map((item) => item.comparison.engineOnlyCount),
    bothDeltaCounts: repeats.map((item) => item.comparison.bothDeltaCount),
    baselineTotalPoints: repeats[0]?.baseline.totalPoints || 0,
    monthlyTotalPoints: repeats.map((item) => item.monthly.totalPoints),
    calculateRequestMs: distribution(calculateTimings)
  };
}

function summarizeExtractionStability(repeats) {
  const visitCount = repeats[0]?.visits.length || 0;
  const perVisit = [];
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const counts = repeats
      .map((item) => Number(item.visits[visitIndex]?.extraction.clinicalEventCount || 0));
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    perVisit.push({
      visit: visitIndex + 1,
      serviceDate: repeats[0]?.visits[visitIndex]?.serviceDate || null,
      eventCounts: counts,
      min,
      max,
      spread: max - min
    });
  }
  return {
    perVisit,
    maxSpread: perVisit.length ? Math.max(...perVisit.map((item) => item.spread)) : 0,
    stableVisitCount: perVisit.filter((item) => item.spread === 0).length
  };
}

function summarizePerformance(requestTimings, sessions) {
  const calculations = requestTimings.filter((item) => item.operation === "calculate").map((item) => item.durationMs);
  const clinical = sessions.map((item) => item.calculationMetrics.clinicalStructuringMs);
  const provider = sessions.map((item) => item.calculationMetrics.openAiProviderMs);
  return {
    totalClientMs: round(requestTimings.reduce((sum, item) => sum + item.durationMs, 0), 2),
    calculateRequestMs: distribution(calculations),
    clinicalStructuringMs: distribution(clinical),
    openAiProviderMs: distribution(provider)
  };
}

function distribution(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: sorted.length,
    min: round(sorted[0], 2),
    median: round(median, 2),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 2),
    max: round(sorted[sorted.length - 1], 2)
  };
}

function parseUke(filePath, claimMonth) {
  const input = JSON.stringify({
    op: "parse_uke",
    content_base64: fs.readFileSync(filePath).toString("base64"),
    encoding: "auto",
    claim_month: claimMonth
  });
  const result = spawnSync("python3", ["-m", "medical_fee_calculation.baseline_api"], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(repoRoot, "python") },
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`UKE parser failed: ${String(result.stderr || "").trim().slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout || "{}");
  return Array.isArray(parsed.baselineClaims) ? parsed.baselineClaims : [];
}

function baselineTotalPoints(claim) {
  if (claim.totalPoints != null) return Number(claim.totalPoints) || 0;
  return aggregateLines(claim.lines).reduce((sum, line) => sum + line.totalPoints, 0);
}

function createFeeApiClient({ baseUrl, jar, csrfToken, timeoutMs, runId }) {
  return {
    async request(method, apiPath, body, options = {}) {
      const tag = `${runId}-${options.tag || "request"}`;
      const separator = apiPath.includes("?") ? "&" : "?";
      return requestJson(`${baseUrl}${apiPath}${separator}evalRunId=${encodeURIComponent(tag)}`, {
        method,
        body,
        jar,
        timeoutMs,
        headers: compactObject({
          "x-eval-run-id": tag,
          ...(options.csrf ? { "x-csrf-token": csrfToken } : {})
        })
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
  const durationMs = performance.now() - startedAt;
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
  return { statusCode: response.status, durationMs: round(durationMs, 2), body: parsed };
}

function resolveFacilityContext(bootstrap, options) {
  const facilities = Array.isArray(bootstrap.facilities) ? bootstrap.facilities : [];
  const departments = Array.isArray(bootstrap.departments) ? bootstrap.departments : [];
  const facility = facilities.find((item) => item.facilityId === options.facilityId)
    || facilities.find((item) => item.status === "active")
    || facilities[0];
  if (!facility?.facilityId) throw new Error("STG organization has no facility");
  const department = departments.find((item) => item.departmentId === options.departmentId)
    || departments.find((item) => item.status === "active" && (!item.facilityId || item.facilityId === facility.facilityId))
    || departments[0];
  if (!department?.departmentId) throw new Error("STG organization has no department");
  return {
    facilityId: facility.facilityId,
    departmentId: department.departmentId,
    facilityStandardKeys: uniqueStrings(facility.facilityStandardKeys || facility.facility_standard_keys || []).sort()
  };
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  const headers = rows.shift() || [];
  return rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/u, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    claimMonth: "",
    outputDir: "",
    facilityId: "",
    departmentId: "",
    password: process.env.FEE_E2E_PASSWORD || "",
    seedKnownPriorHistory: false,
    encounterSetting: "outpatient",
    dryRun: false,
    help: false
  };
  const next = (index, option) => {
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--patient-dir") parsed.patientDir = next(index++, arg);
    else if (arg === "--claim-month") parsed.claimMonth = next(index++, arg);
    else if (arg === "--output-dir") parsed.outputDir = next(index++, arg);
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next(index++, arg);
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next(index++, arg);
    else if (arg === "--organization-code") parsed.organizationCode = next(index++, arg);
    else if (arg === "--login-id") parsed.loginId = next(index++, arg);
    else if (arg === "--password-file") parsed.passwordFile = next(index++, arg);
    else if (arg === "--repeat") parsed.repeat = positiveInteger(next(index++, arg), arg);
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInteger(next(index++, arg), arg);
    else if (arg === "--facility-id") parsed.facilityId = next(index++, arg);
    else if (arg === "--department-id") parsed.departmentId = next(index++, arg);
    else if (arg === "--seed-known-prior-history") parsed.seedKnownPriorHistory = true;
    else if (arg === "--encounter-setting") parsed.encounterSetting = next(index++, arg);
    else if (arg === "--dry-run") parsed.dryRun = true;
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

function assertNoLeakedInputs(payload) {
  const forbidden = ["orders", "claimContext", "claim_context", "calculationOptions", "calculation_options"];
  const found = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (found.length) throw new Error(`calculation input leakage detected: ${found.join(", ")}`);
}

function assertResponse(response, label) {
  if (response.statusCode < 400) return;
  const message = String(response.body?.error?.message || response.body?.message || response.body?.error || "request failed");
  throw new Error(`${label} failed (HTTP ${response.statusCode}): ${message.slice(0, 300)}`);
}

function timingRecord(operation, visit, response) {
  return { operation, visit: visit || null, statusCode: response.statusCode, durationMs: Number(response.durationMs || 0) };
}

function normalizeBirthDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : undefined;
}

function normalizeSex(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["female", "女", "f"].includes(text)) return "female";
  if (["male", "男", "m"].includes(text)) return "male";
  return "unknown";
}

function splitSetCookie(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,=]+=[^;,]+)/u).map((item) => item.trim()).filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function opaqueRef(value) {
  return sha256(value).slice(0, 12);
}

function dateStamp(value) {
  return value.toISOString().replace(/[-:.TZ]/gu, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function assertStgTarget(options) {
  const hosts = [options.platformBaseUrl, options.feeBaseUrl].map((value) => new URL(value).hostname.toLowerCase());
  const isStgHost = (host) => host.includes("-stg-") || host.startsWith("stg.") || host.includes(".stg.");
  if (!hosts.every(isStgHost) || !String(options.organizationCode || "").toLowerCase().endsWith("-stg")) {
    throw new Error("this evaluator is restricted to STG API hosts and an organization code ending in -stg");
  }
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function printHelp() {
  process.stdout.write(`Fee monthly chart-to-receipt E2E (STG only)\n\nUsage:\n  npm run eval:fee-monthly-chart-e2e -- [options]\n\nOptions:\n  --patient-dir PATH       Patient dataset directory\n  --claim-month YYYY-MM    Defaults to manifest claimMonth\n  --repeat N               Independent patient runs. Default: 3\n  --output-dir PATH        Default: /private/tmp/<run-id>\n  --organization-code ID   Default: nishiyama-demo-stg\n  --login-id ID            Default: nishiyama-admin\n  --password-file PATH     Default: .secrets/nishiyama-demo-password.txt\n  --facility-id ID         Optional facility override\n  --department-id ID       Optional department override\n  --seed-known-prior-history\n                            Seed patients.csv start_date as prior visit history\n  --dry-run                Validate and summarize inputs without network calls\n  --help                   Show this help\n`);
}
