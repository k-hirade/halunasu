#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureFeeEvaluationSurface,
  evaluateLongitudinalEquivalence,
  evaluateMemoAcceptance,
  validateLongitudinalPreflight
} from "./lib/fee-longitudinal-evaluation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  patientDir: "tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/1001",
  platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
  feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
  organizationCode: "yamamoto-demo-stg",
  loginId: "yamamoto-admin",
  passwordFile: ".secrets/yamamoto-demo-stg-password.txt",
  controlRepeats: 3,
  timeoutMs: 180_000,
  setting: "home_visit"
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
assertStgTarget(args);

const fixture = loadFixture(args.patientDir);
const scenarios = buildScenarios(fixture.charts);
if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    source: path.relative(repoRoot, fixture.patientDir),
    scenarioCount: scenarios.length,
    scenarios: scenarios.map(scenarioAudit)
  }, null, 2)}\n`);
  process.exit(0);
}

const preflight = await readEvaluationPreflight(args);

const runId = `fee-longitudinal-${dateStamp(new Date())}-${crypto.randomBytes(3).toString("hex")}`;
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

const authSession = await requestJson(`${args.platformBaseUrl}/v1/auth/session`, { jar, timeoutMs: args.timeoutMs });
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

const scenarioResults = [];
for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index];
  process.stdout.write(`[${index + 1}/${scenarios.length}] ${scenario.id}: memo path\n`);
  const result = await runScenario({ api, runId, scenario, context, args, fixture });
  scenarioResults.push(result);
  process.stdout.write(`[${index + 1}/${scenarios.length}] ${scenario.id}: ${result.verdict}\n`);
}

const allRuns = scenarioResults.flatMap(scenarioRuns);
const revisions = uniqueStrings(allRuns.map((run) => run.runtime?.cloudRunRevision));
const historyUnavailableCount = allRuns.filter((run) => run.patientHistory?.completeness === "unavailable").length;
const preflightRevisionMatch = Boolean(
  preflight.cloudRunRevision
  && revisions.length === 1
  && revisions[0] === preflight.cloudRunRevision
);
const result = {
  schemaVersion: "fee-longitudinal-context-eval.v1",
  generatedAt: new Date().toISOString(),
  runId,
  mode: "stg",
  source: {
    patientDir: path.relative(repoRoot, fixture.patientDir),
    patientRef: fixture.externalPatientId,
    chartCount: fixture.charts.length,
    syntheticDataOnly: true
  },
  environment: {
    platformBaseUrl: args.platformBaseUrl,
    feeBaseUrl: args.feeBaseUrl,
    organizationCode: args.organizationCode,
    facilityRef: opaqueRef(context.facilityId),
    departmentRef: opaqueRef(context.departmentId),
    preflight,
    cloudRunRevisions: revisions,
    sameRevisionObserved: revisions.length === 1,
    preflightRevisionMatch
  },
  methodology: {
    controlRepeats: args.controlRepeats,
    fullExtractionControl: "fresh synthetic patient with a calculated, billing-equivalent prior visit whose line keys differ from the target",
    confirmedLineCriterion: "exact code/name/quantity/totalPoints equality against every stable full-extraction control",
    candidateCriterion: "set equality; only documented prescription-related visit_facts differences may be accepted and every difference is recorded",
    historyFailurePolicy: "no failure is injected into STG; unit tests cover fail-closed behavior and STG must report zero unavailable histories",
    copyForwardMetricMeaning: "controlled upper-bound mechanism performance, not an observed customer copy-forward rate"
  },
  summary: summarizeResults(scenarioResults, {
    historyUnavailableCount,
    revisions,
    controlRepeats: args.controlRepeats,
    preflight,
    preflightRevisionMatch
  }),
  scenarios: scenarioResults
};

const resultPath = path.join(outputDir, "result.json");
const readmePath = path.join(outputDir, "README.md");
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(readmePath, renderReadme(result));
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
process.stdout.write(`result=${resultPath}\nreadme=${readmePath}\n`);

async function runScenario({ api, runId, scenario, context, args: options, fixture: sourceFixture }) {
  const memoPatientKey = `${runId}:${scenario.id}:memo`;
  const baseSession = await createSession(api, {
    patient: patientInput(sourceFixture.patient, memoPatientKey),
    patientRef: `longitudinal-${sourceFixture.externalPatientId}`,
    facilityId: context.facilityId,
    departmentId: context.departmentId,
    serviceDate: scenario.baseDate,
    claimMonth: scenario.baseDate.slice(0, 7),
    setting: options.setting,
    clinicalText: scenario.baseText,
    sourceSystem: `fee_longitudinal_eval:${runId}:${scenario.id}`
  }, `${scenario.id}-base-create`);
  const base = await calculateAndRead(api, baseSession.feeSessionId, `${scenario.id}-base`);
  const targetSession = await createSession(api, {
    patientId: baseSession.patientId,
    patientRef: `longitudinal-${sourceFixture.externalPatientId}`,
    facilityId: context.facilityId,
    departmentId: context.departmentId,
    serviceDate: scenario.targetDate,
    claimMonth: scenario.targetDate.slice(0, 7),
    setting: options.setting,
    clinicalText: scenario.targetText,
    sourceSystem: `fee_longitudinal_eval:${runId}:${scenario.id}`
  }, `${scenario.id}-target-create`);
  const crossSession = await calculateAndRead(api, targetSession.feeSessionId, `${scenario.id}-cross`);
  const memoRuns = { crossSession };
  if (scenario.measureSameSession) {
    memoRuns.sameSession = await calculateAndRead(api, targetSession.feeSessionId, `${scenario.id}-same`);
  }

  const controls = [];
  for (let controlIndex = 1; controlIndex <= options.controlRepeats; controlIndex += 1) {
    process.stdout.write(`  ${scenario.id}: full control ${controlIndex}/${options.controlRepeats}\n`);
    controls.push(await runFullExtractionControl({
      api,
      runId,
      scenario,
      context,
      options,
      sourceFixture,
      controlIndex
    }));
  }

  const equivalence = evaluateLongitudinalEquivalence({
    memoRuns,
    controls,
    allowKnownVisitFactsCandidateDifferences: scenario.allowKnownVisitFactsCandidateDifferences,
    allowMemoUnusedLlmVariability: scenario.expectedMemo?.crossSession?.memoUsed === false
  });
  const memoAcceptance = Object.fromEntries(Object.entries(memoRuns).map(([name, run]) => [
    name,
    evaluateMemoAcceptance(run, scenario.expectedMemo[name] || scenario.expectedMemo.crossSession)
  ]));
  const scenarioChecks = scenarioSpecificChecks(scenario, { base, memoRuns, controls, equivalence });
  const acceptancePass = Object.values(memoAcceptance).every((item) => item.pass) && scenarioChecks.pass;
  const verdict = !acceptancePass || equivalence.overallVerdict === "fail"
    ? "fail"
    : equivalence.overallVerdict;
  return {
    id: scenario.id,
    description: scenario.description,
    mutation: scenario.mutation,
    inputAudit: scenarioAudit(scenario),
    verdict,
    base,
    memoRuns,
    controls,
    memoAcceptance,
    scenarioChecks,
    equivalence
  };
}

async function runFullExtractionControl({ api, runId, scenario, context, options, sourceFixture, controlIndex }) {
  const key = `${runId}:${scenario.id}:control:${controlIndex}`;
  const prior = await createSession(api, {
    patient: patientInput(sourceFixture.patient, key),
    patientRef: `longitudinal-control-${sourceFixture.externalPatientId}`,
    facilityId: context.facilityId,
    departmentId: context.departmentId,
    serviceDate: scenario.baseDate,
    claimMonth: scenario.baseDate.slice(0, 7),
    setting: options.setting,
    clinicalText: scenario.baseText,
    sourceSystem: `fee_longitudinal_control:${runId}:${scenario.id}:${controlIndex}`
  }, `${scenario.id}-c${controlIndex}-prior`);
  const controlPrior = await calculateAndRead(api, prior.feeSessionId, `${scenario.id}-control-${controlIndex}-prior`);
  const target = await createSession(api, {
    patientId: prior.patientId,
    patientRef: `longitudinal-control-${sourceFixture.externalPatientId}`,
    facilityId: context.facilityId,
    departmentId: context.departmentId,
    serviceDate: scenario.targetDate,
    claimMonth: scenario.targetDate.slice(0, 7),
    setting: options.setting,
    clinicalText: lineKeyDivergentEquivalentText(scenario.targetText),
    sourceSystem: `fee_longitudinal_control:${runId}:${scenario.id}:${controlIndex}`
  }, `${scenario.id}-c${controlIndex}-target`);
  const targetResult = await calculateAndRead(api, target.feeSessionId, `${scenario.id}-control-${controlIndex}`);
  return { ...targetResult, controlPrior };
}

async function createSession(api, payload, tag) {
  const response = await api.request("POST", "/v1/fee/sessions", payload, { csrf: true, tag });
  assertResponse(response, tag);
  const feeSession = response.body?.feeSession || {};
  const patientId = String(feeSession.patientId || "");
  const feeSessionId = String(feeSession.feeSessionId || "");
  if (!patientId || !feeSessionId) throw new Error(`${tag} did not return patientId and feeSessionId`);
  return { patientId, feeSessionId };
}

async function calculateAndRead(api, feeSessionId, tag) {
  const calculation = await api.request(
    "POST",
    `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/calculate`,
    {},
    { csrf: true, tag: `${tag}-calculate` }
  );
  assertResponse(calculation, `${tag} calculate`);
  const detail = await api.request(
    "GET",
    `/v1/fee/sessions/${encodeURIComponent(feeSessionId)}/detail`,
    undefined,
    { tag: `${tag}-detail` }
  );
  assertResponse(detail, `${tag} detail`);
  return {
    ...captureFeeEvaluationSurface(detail.body || {}),
    sessionRef: opaqueRef(feeSessionId),
    requestDurationMs: Number(calculation.durationMs || 0)
  };
}

function buildScenarios(charts) {
  const original = String(charts[0]?.clinical_text || "").trim();
  const distinct = String(charts[1]?.clinical_text || "").trim();
  const baseDate = fixtureServiceDate(charts[0]?.service_date, "first chart");
  const targetDate = fixtureServiceDate(charts[1]?.service_date, "second chart");
  if (!original || !distinct) throw new Error("fixture requires at least two charts for the all-new scenario");
  if (targetDate <= baseDate) throw new Error("fixture chart dates must be strictly increasing");
  const partial = replaceSoapLine(original, "P", "P）現行処方を継続。体重と血圧を毎日記録し、息切れ増悪時は連絡するよう再指導。次回は4週後の定期訪問予定。");
  const outsidePrescription = replaceSoapLine(
    original,
    "P",
    "P）院外処方箋を発行。アムロジピン錠5mgを1日1回朝食後30日分、院外処方とした。次回は4週後の定期訪問予定。"
  );
  const actLine = "O）右前腕擦過創30cm²に対し、洗浄・軟膏塗布・被覆による創傷処置を施行。";
  const withAct = insertBeforeSoapSection(original, "A", actLine);
  const lineCount = soapLineCount(original);
  return [
    {
      id: "exact_copy_forward",
      description: "同一本文を別セッションへ投入し、その同一セッションも再計算する",
      mutation: "none",
      baseText: original,
      targetText: original,
      baseDate,
      targetDate,
      measureSameSession: true,
      allowKnownVisitFactsCandidateDifferences: false,
      expectedMemo: {
        crossSession: memoExpectation({ ratio: 1, continued: lineCount, added: 0, removed: 0, noOpenAiCall: true }),
        sameSession: memoExpectation({ ratio: 1, continued: lineCount, added: 0, removed: 0, noOpenAiCall: true })
      }
    },
    {
      id: "partial_p_change",
      description: "S/O/Aをcopy-forwardしP段落だけ変更する",
      mutation: "replace P line",
      baseText: original,
      targetText: partial,
      baseDate,
      targetDate,
      measureSameSession: false,
      allowKnownVisitFactsCandidateDifferences: false,
      expectedMemo: {
        crossSession: memoExpectation({ ratio: (lineCount - 1) / lineCount, continued: lineCount - 1, added: 1, removed: 1 })
      }
    },
    {
      id: "visit_facts_new_outside_prescription",
      description: "新規P段落に院外処方箋発行を初めて記載し、全文抽出へ安全にフォールバックする",
      mutation: "replace P line with outside prescription",
      baseText: original,
      targetText: outsidePrescription,
      baseDate,
      targetDate,
      measureSameSession: false,
      allowKnownVisitFactsCandidateDifferences: true,
      expectedMemo: {
        crossSession: memoExpectation({ ratio: 0, continued: 0, added: lineCount, removed: 1, memoUsed: false })
      }
    },
    {
      id: "removed_performed_act",
      description: "前回だけに存在した創傷処置行を削除し、時間汚染が無いことを確認する",
      mutation: "remove performed wound-treatment line",
      removedActPattern: "創傷処置",
      baseText: withAct,
      targetText: original,
      baseDate,
      targetDate,
      measureSameSession: false,
      allowKnownVisitFactsCandidateDifferences: false,
      expectedMemo: {
        crossSession: memoExpectation({ ratio: 1, continued: lineCount, added: 0, removed: 1, noOpenAiCall: true })
      }
    },
    {
      id: "all_lines_new",
      description: "元mockの別受診本文へ全面変更し、全文抽出フォールバックを確認する",
      mutation: "replace all SOAP lines with the next mock visit",
      baseText: original,
      targetText: distinct,
      baseDate,
      targetDate,
      measureSameSession: false,
      allowKnownVisitFactsCandidateDifferences: false,
      expectedMemo: {
        crossSession: memoExpectation({ ratio: 0, continued: 0, added: soapLineCount(distinct), removed: lineCount, memoUsed: false })
      }
    }
  ];
}

function memoExpectation({ ratio, continued, added, removed, memoUsed = true, noOpenAiCall = false }) {
  return {
    memoUsed,
    memoHitLineRatio: ratio,
    continuedLineCount: continued,
    newLineCount: added,
    removedLineCount: removed,
    traceRecorded: true,
    noOpenAiCall,
    historyAvailable: true
  };
}

function scenarioSpecificChecks(scenario, { base, memoRuns, controls }) {
  const cross = memoRuns.crossSession;
  const controlPriors = controls.map((run) => run.controlPrior).filter(Boolean);
  const checks = {
    stgHistoryAvailable: [base, ...Object.values(memoRuns), ...controls, ...controlPriors]
      .every((run) => run.patientHistory?.completeness !== "unavailable"),
    controlsHaveCalculatedPrior: controlPriors.length === controls.length,
    controlsHaveEquivalentPriorBilling: controlPriors.every((run) => (
      billingSurfaceSignature(run) === billingSurfaceSignature(base)
    )),
    controlsUseFullExtraction: controls.every((run) => (
      run.extraction?.memo?.used === false && run.openAi?.callObserved === true
    )),
    controlsHaveEquivalentHistoryDepth: controls.every((run) => (
      run.patientHistory?.priorSessionCount === cross.patientHistory?.priorSessionCount
    ))
  };
  const observations = {};
  if (scenario.id === "removed_performed_act") {
    const baseHasRemovedAct = surfaceContains(base, scenario.removedActPattern);
    const targetHasRemovedAct = surfaceContains(cross, scenario.removedActPattern);
    checks.baseActWasObserved = baseHasRemovedAct;
    checks.removedActAbsentFromCurrentSurface = !targetHasRemovedAct;
    checks.removedLineRecorded = Number(cross.extraction?.memo?.removedLineCount || 0) >= 1;
    checks.removalTraceRecorded = cross.extraction?.memo?.traceRecorded === true;
  }
  if (scenario.id === "visit_facts_new_outside_prescription") {
    observations.memoVisitFacts = cross.visitFacts;
    observations.controlVisitFacts = controls.map((run) => run.visitFacts);
    observations.memoVisitFactsMatchesEveryControl = controls.every((run) => (
      JSON.stringify(run.visitFacts || null) === JSON.stringify(cross.visitFacts || null)
    ));
  }
  return { pass: Object.values(checks).every(Boolean), checks, observations };
}

function scenarioRuns(scenario = {}) {
  return [
    scenario.base,
    ...Object.values(scenario.memoRuns || {}),
    ...(scenario.controls || []).flatMap((run) => [run?.controlPrior, run])
  ].filter(Boolean);
}

function billingSurfaceSignature(run = {}) {
  return JSON.stringify({
    totalPoints: Number(run.totalPoints || 0),
    confirmedLines: run.confirmedLines || []
  });
}

function scenarioAudit(scenario) {
  return {
    id: scenario.id,
    baseDate: scenario.baseDate,
    targetDate: scenario.targetDate,
    baseHash: sha256(scenario.baseText),
    targetHash: sha256(scenario.targetText),
    baseLineCount: soapLineCount(scenario.baseText),
    targetLineCount: soapLineCount(scenario.targetText),
    sameText: scenario.baseText === scenario.targetText,
    mutation: scenario.mutation
  };
}

function summarizeResults(scenarios, {
  historyUnavailableCount,
  revisions,
  controlRepeats,
  preflight,
  preflightRevisionMatch
}) {
  const runs = scenarios.flatMap(scenarioRuns);
  const memoRuns = scenarios.flatMap((scenario) => Object.values(scenario.memoRuns));
  const controlTargets = scenarios.flatMap((scenario) => scenario.controls);
  const controlPriors = controlTargets.map((run) => run.controlPrior).filter(Boolean);
  const observedAcceptancePass = scenarios.every((scenario) => (
    Object.values(scenario.memoAcceptance).every((item) => item.pass) && scenario.scenarioChecks.pass
  ));
  const memoAcceptanceEligible = preflight.memoCheckSkipped !== true
    && preflight.runtimeFeatures?.extractionMemoEnabled === true;
  const guardRuns = runs.filter((run) => run.extraction?.emptyExtractionGuard?.triggered === true);
  return {
    scenarioCount: scenarios.length,
    verdictCounts: countBy(scenarios.map((scenario) => scenario.verdict)),
    memoAcceptanceEligible,
    observedAcceptanceChecksPassed: observedAcceptancePass,
    allAcceptanceChecksPassed: memoAcceptanceEligible ? observedAcceptancePass : null,
    allEquivalenceChecksPassed: scenarios.every((scenario) => (
      ["pass", "pass_with_known_limit"].includes(scenario.equivalence?.overallVerdict)
    )),
    controlRepeats,
    controlOpenAiCallCount: [...controlPriors, ...controlTargets].reduce((sum, run) => (
      sum + Number(run.openAi?.callCount || 0)
    ), 0),
    controlPriorOpenAiCallCount: controlPriors.reduce((sum, run) => sum + Number(run.openAi?.callCount || 0), 0),
    controlTargetOpenAiCallCount: controlTargets.reduce((sum, run) => sum + Number(run.openAi?.callCount || 0), 0),
    memoPathOpenAiCallCount: memoRuns.reduce((sum, run) => sum + Number(run.openAi?.callCount || 0), 0),
    memoUsedRunCount: memoRuns.filter((run) => run.extraction?.memo?.used).length,
    averageMemoHitLineRatio: round(mean(memoRuns.map((run) => run.extraction?.memo?.memoHitLineRatio || 0))),
    emptyExtractionGuard: {
      triggeredRunCount: guardRuns.length,
      retryAttemptedRunCount: guardRuns.filter((run) => run.extraction?.emptyExtractionGuard?.retryAttempted).length,
      recoveredRunCount: guardRuns.filter((run) => run.extraction?.emptyExtractionGuard?.recovered).length,
      unrecoveredRunCount: guardRuns.filter((run) => !run.extraction?.emptyExtractionGuard?.recovered).length
    },
    historyUnavailableCount,
    historyUnavailablePass: historyUnavailableCount === 0,
    cloudRunRevisions: revisions,
    sameRevisionObserved: revisions.length === 1,
    preflightRevisionMatch,
    phase1CloseoutMeasurementEligible: memoAcceptanceEligible
      && preflight.runtimeFeatures?.emptyExtractionRetryEnabled === true
      && preflightRevisionMatch,
    calculateRequestMs: distribution(runs.map((run) => run.requestDurationMs)),
    openAiInputTokens: runs.reduce((sum, run) => sum + Number(run.openAi?.usage?.inputTokens || 0), 0),
    openAiCachedInputTokens: runs.reduce((sum, run) => sum + Number(run.openAi?.usage?.cachedInputTokens || 0), 0),
    openAiOutputTokens: runs.reduce((sum, run) => sum + Number(run.openAi?.usage?.outputTokens || 0), 0),
    openAiByExtractionMode: summarizeOpenAiByExtractionMode(runs)
  };
}

function summarizeOpenAiByExtractionMode(runs = []) {
  const grouped = new Map();
  for (const run of runs) {
    const mode = String(run.extraction?.mode || inferExtractionMode(run));
    const current = grouped.get(mode) || {
      runCount: 0,
      openAiCallCount: 0,
      providerDurationMs: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      requestDurations: []
    };
    current.runCount += 1;
    current.openAiCallCount += Number(run.openAi?.callCount || 0);
    current.providerDurationMs += Number(run.openAi?.providerDurationMs || 0);
    current.inputTokens += Number(run.openAi?.usage?.inputTokens || 0);
    current.cachedInputTokens += Number(run.openAi?.usage?.cachedInputTokens || 0);
    current.outputTokens += Number(run.openAi?.usage?.outputTokens || 0);
    current.requestDurations.push(Number(run.requestDurationMs || 0));
    grouped.set(mode, current);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([mode, item]) => [
    mode,
    {
      runCount: item.runCount,
      openAiCallCount: item.openAiCallCount,
      providerDurationMs: round(item.providerDurationMs),
      inputTokens: item.inputTokens,
      cachedInputTokens: item.cachedInputTokens,
      uncachedInputTokens: Math.max(0, item.inputTokens - item.cachedInputTokens),
      cacheHitRatio: item.inputTokens > 0 ? round(item.cachedInputTokens / item.inputTokens, 4) : 0,
      outputTokens: item.outputTokens,
      calculateRequestMs: distribution(item.requestDurations)
    }
  ]));
}

function inferExtractionMode(run = {}) {
  if (run.extraction?.memo?.used === true && run.openAi?.callObserved === false) return "memo_only";
  if (run.extraction?.memo?.used === true) return "line_subset";
  if (run.openAi?.callObserved === true) return "full";
  return "no_openai";
}

function renderReadme(result) {
  const rows = result.scenarios.map((scenario) => {
    const cross = scenario.memoRuns.crossSession;
    return `| ${scenario.id} | ${scenario.verdict} | ${formatRatio(cross.extraction?.memo?.memoHitLineRatio)} | ${cross.extraction?.memo?.newLineCount ?? "-"} | ${cross.extraction?.memo?.removedLineCount ?? "-"} | ${cross.openAi?.callObserved ? "あり" : "なし"} |`;
  }).join("\n");
  const exact = result.scenarios.find((scenario) => scenario.id === "exact_copy_forward");
  const extractionModeRows = Object.entries(result.summary.openAiByExtractionMode || {}).map(([mode, metrics]) => (
    `| ${mode} | ${metrics.runCount} | ${metrics.openAiCallCount} | ${metrics.inputTokens} | ${metrics.cachedInputTokens} | ${formatRatio(metrics.cacheHitRatio)} | ${metrics.outputTokens} | ${metrics.calculateRequestMs?.median ?? "-"}ms |`
  )).join("\n") || "| - | 0 | 0 | 0 | 0 | 0% | 0 | - |";
  const exactPathRows = exact
    ? Object.entries(exact.memoRuns).map(([pathName, run]) => {
      const acceptance = exact.memoAcceptance[pathName];
      const equivalence = exact.equivalence.paths[pathName];
      return `| ${pathName} | ${acceptance?.pass ? "pass" : "fail"} | ${equivalence?.overallVerdict || "-"} | ${formatRatio(run.extraction?.memo?.memoHitLineRatio)} | ${run.openAi?.callCount ?? (run.openAi?.callObserved ? 1 : 0)} |`;
    }).join("\n")
    : "| - | - | - | - | - |";
  const differenceLines = result.scenarios.flatMap((scenario) => {
    const differences = scenario.equivalence?.paths?.crossSession?.candidates?.differences || [];
    const unique = new Map();
    for (const difference of differences) {
      for (const item of difference.items || []) {
        unique.set(`${item.side}:${item.key}`, item);
      }
    }
    if (!unique.size) return [];
    return [
      `### ${scenario.id}`,
      "",
      `判定: ${scenario.equivalence.paths.crossSession.candidates.verdict}`,
      "",
      ...[...unique.values()].map((difference) => (
        `- ${difference.side}: ${difference.item?.title || difference.item?.code || "名称なし"}`
        + `${difference.item?.code ? ` (${difference.item.code})` : ""}`
      )),
      ""
    ];
  });
  const confirmedDifferenceLines = result.scenarios.flatMap((scenario) => {
    const differences = scenario.equivalence?.paths?.crossSession?.confirmed?.differences || [];
    const unique = new Map();
    for (const difference of differences) {
      for (const item of difference.items || []) {
        unique.set(`${item.side}:${item.key}`, item);
      }
    }
    if (!unique.size) return [];
    return [
      `### ${scenario.id}`,
      "",
      ...[...unique.values()].map((difference) => (
        `- ${difference.side}: ${difference.item?.name || difference.item?.code || "名称なし"}`
        + `${difference.item?.code ? ` (${difference.item.code})` : ""}`
        + ` / ${difference.item?.quantity ?? "-"}回 / ${difference.item?.totalPoints ?? "-"}点`
      )),
      ""
    ];
  });
  const failedChecks = result.scenarios.flatMap((scenario) => {
    const failedMemoChecks = Object.entries(scenario.memoAcceptance || {}).flatMap(([pathName, acceptance]) => (
      Object.entries(acceptance.checks || {})
        .filter((entry) => entry[1] !== true)
        .map(([check]) => `${scenario.id}/${pathName}: ${check}`)
    ));
    const failedScenarioChecks = Object.entries(scenario.scenarioChecks?.checks || {})
      .filter((entry) => entry[1] !== true)
      .map(([check]) => `${scenario.id}: ${check}`);
    const failedEquivalenceChecks = Object.entries(scenario.equivalence?.paths || {}).flatMap(([pathName, pathResult]) => [
      ...(pathResult.overallVerdict === "fail" && pathResult.confirmed?.verdict === "fail"
        ? [`${scenario.id}/${pathName}: confirmed equivalence`]
        : []),
      ...(pathResult.overallVerdict === "fail" && pathResult.candidates?.verdict === "fail"
        ? [`${scenario.id}/${pathName}: candidate equivalence`]
        : [])
    ]);
    return [...failedMemoChecks, ...failedScenarioChecks, ...failedEquivalenceChecks];
  });
  const latency = result.summary.calculateRequestMs || {};
  return `# 縦断患者コンテキスト STG再計測\n\n` +
    `- 実行日時: ${result.generatedAt}\n` +
    `- Cloud Run revision: ${result.environment.cloudRunRevisions.join(", ") || "取得できず"}\n` +
    `- pre-flight revision: ${result.environment.preflight?.cloudRunRevision || "取得できず"}（計測と${result.environment.preflightRevisionMatch ? "一致" : "不一致"}）\n` +
    `- pre-flight flags: memo=${result.environment.preflight?.runtimeFeatures?.extractionMemoEnabled === true} / emptyRetry=${result.environment.preflight?.runtimeFeatures?.emptyExtractionRetryEnabled === true}\n` +
    `- 対照経路: 同じ請求履歴を持つ計算済み事前受診を作り、対象受診のみlineKeyを変えて全文抽出、各ケース${result.methodology.controlRepeats}回\n` +
    `- 履歴取得不能: ${result.summary.historyUnavailableCount}件\n\n` +
    `## 合格基準\n\n` +
    `- 確定明細はコード・名称・数量・点数が対照経路と完全一致すること。\n` +
    `- 候補集合の差分は全件記録し、既知のvisit_facts制約に由来する処方関連差分以外は許容しない。\n` +
    `- 対照3回自体が揺れた場合は、メモの不具合と断定せず「対照揺れのため判定不能」とする。\n` +
    `- 履歴障害はSTGへ故意に注入しない。fail-closedはユニットテスト、STGはunavailableが0件であることを確認する。\n\n` +
    `## 結果\n\n` +
    `- メモ受入判定: ${result.summary.memoAcceptanceEligible ? (result.summary.allAcceptanceChecksPassed ? "5ケースすべて合格" : "不合格あり") : "pre-flightをスキップしたため正式判定対象外"}\n` +
    `- 意味等価性: ${result.summary.allEquivalenceChecksPassed ? "全件合格" : "不一致または判定不能あり"}（メモ未使用のLLM揺れは合格へ読み替えず inconclusive とする）\n\n` +
    `| ケース | 判定 | memoHitLineRatio | 新規行 | 消失行 | OpenAI呼出し |\n` +
    `| --- | --- | ---: | ---: | ---: | --- |\n${rows}\n\n` +
    `## 完全一致再計算の2経路\n\n` +
    `| 経路 | メモ受入 | 全文対照との等価性 | memoHitLineRatio | OpenAI呼出し数 |\n` +
    `| --- | --- | --- | ---: | ---: |\n${exactPathRows}\n\n` +
    `## 対照経路と性能\n\n` +
    `- 全文対照の実行回数: ${result.summary.controlRepeats}回/ケース（事前受診 ${result.summary.controlPriorOpenAiCallCount}呼出し / 対象受診 ${result.summary.controlTargetOpenAiCallCount}呼出し）\n` +
    `- 対照内で確定明細または候補集合が揺れたケース: ${result.scenarios.filter((scenario) => !scenario.equivalence?.controlVariability?.confirmedStable || !scenario.equivalence?.controlVariability?.candidateStable).length}件\n` +
    `- メモ経路のOpenAI呼出し: ${result.summary.memoPathOpenAiCallCount}回\n` +
    `- 等価性判定: ${result.summary.allEquivalenceChecksPassed ? "全件合格" : "不合格あり"}\n` +
    `- calculate応答時間: median ${latency.median ?? "-"}ms / mean ${latency.mean ?? "-"}ms / max ${latency.max ?? "-"}ms\n` +
    `- OpenAI使用量（全経路）: input ${result.summary.openAiInputTokens} / cached ${result.summary.openAiCachedInputTokens} / output ${result.summary.openAiOutputTokens} tokens\n` +
    `- 空抽出ガード: 発火 ${result.summary.emptyExtractionGuard.triggeredRunCount} / 回復 ${result.summary.emptyExtractionGuard.recoveredRunCount} / 未回復 ${result.summary.emptyExtractionGuard.unrecoveredRunCount}\n` +
    `- 履歴取得不能: ${result.summary.historyUnavailableCount}件\n\n` +
    `### 抽出経路別OpenAI利用\n\n` +
    `| 抽出経路 | 実行 | API呼出し | 入力token | cache token | cache率 | 出力token | 応答中央値 |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${extractionModeRows}\n\n` +
    `## 候補集合の差分\n\n` +
    `${differenceLines.length ? differenceLines.join("\n") : "差分なし。\n"}\n` +
    `## 確定明細の差分\n\n` +
    `${confirmedDifferenceLines.length ? confirmedDifferenceLines.join("\n") : "差分なし。\n"}\n` +
    `## 不合格チェック\n\n` +
    `${failedChecks.length ? failedChecks.map((item) => `- ${item}`).join("\n") : "なし。"}\n\n` +
    `詳細な確定明細・候補差分・visit_facts・trace・使用量は [result.json](./result.json) に保存しています。\n\n` +
    `## 指標の注意\n\n` +
    `この制御データはlineKey一致率を意図的に作っています。ここで得られるLLM削減率は機構の上限性能であり、実運用の実効値ではありません。顧客カルテのcopy-forward率（Do記載率）は実データで再計測するまで不明です。UKE一致も既存請求の再現率であり、制度上の正解率とは分けて扱います。\n`;
}

function loadFixture(relativePath) {
  const patientDir = path.resolve(repoRoot, relativePath);
  const manifest = readJson(path.join(patientDir, "manifest.json"));
  const patients = parseCsv(fs.readFileSync(path.join(patientDir, "patients.csv"), "utf8"));
  const externalPatientId = String(manifest.patientId || patients[0]?.patient_id || "").trim();
  const patient = patients.find((item) => String(item.patient_id || "") === externalPatientId) || patients[0];
  const charts = fs.readFileSync(path.join(patientDir, "charts.jsonl"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => String(item.patient_id || "") === externalPatientId)
    .sort((left, right) => String(left.service_date || "").localeCompare(String(right.service_date || "")));
  if (!patient || charts.length < 2) throw new Error("mock fixture requires one patient and at least two charts");
  return { patientDir, patient, externalPatientId, charts };
}

function patientInput(patient, uniqueKey) {
  return {
    displayName: `縦断評価 ${opaqueRef(uniqueKey)}`,
    birthDate: normalizeBirthDate(patient.birth_date),
    sex: normalizeSex(patient.sex),
    externalPatientIds: [`fee-longitudinal-eval:${uniqueKey}`]
  };
}

function surfaceContains(surface, pattern) {
  const text = JSON.stringify({
    confirmedLines: surface.confirmedLines,
    candidateItems: surface.candidateItems,
    reviewIssues: surface.reviewIssues
  });
  return text.includes(pattern);
}

function fixtureServiceDate(value, label) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`${label} requires an ISO service_date`);
  }
  return date;
}

// 対照患者には同じ臨床内容と請求履歴を持たせつつ、対象受診だけlineKeyを変えて
// 抽出メモを使わせない。SOAP記号直後の空白は意味を変えないがlineKeyには反映される。
function lineKeyDivergentEquivalentText(text) {
  const source = String(text || "");
  const transformed = source.split(/\r?\n/u).map((line) => (
    line.replace(/^([SOAP][）:：])\s*/u, "$1 ")
  )).join("\n");
  if (!transformed || transformed === source) {
    throw new Error("could not create a line-key-divergent equivalent control text");
  }
  return transformed;
}

function replaceSoapLine(text, section, replacement) {
  const pattern = new RegExp(`^${section}[）:：]`, "u");
  const lines = String(text || "").split(/\r?\n/u);
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  if (index < 0) throw new Error(`SOAP section ${section} was not found`);
  lines[index] = replacement;
  return lines.join("\n");
}

function insertBeforeSoapSection(text, section, line) {
  const pattern = new RegExp(`^${section}[）:：]`, "u");
  const lines = String(text || "").split(/\r?\n/u);
  const index = lines.findIndex((value) => pattern.test(value.trim()));
  if (index < 0) throw new Error(`SOAP section ${section} was not found`);
  lines.splice(index, 0, line);
  return lines.join("\n");
}

function soapLineCount(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length;
}

function createFeeApiClient({ baseUrl, jar, csrfToken, timeoutMs, runId: id }) {
  return {
    request(method, apiPath, body, options = {}) {
      const tag = `${id}-${options.tag || "request"}`;
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

async function readEvaluationPreflight(options) {
  const response = await requestJson(`${options.feeBaseUrl}/readyz`, {
    timeoutMs: options.timeoutMs
  });
  assertResponse(response, "fee-api readyz preflight");
  const validated = validateLongitudinalPreflight(response.body, {
    skipMemoPreflight: options.skipMemoPreflight
  });
  return {
    ...validated,
    checkedAt: new Date().toISOString(),
    requestDurationMs: Number(response.durationMs || 0)
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
  return { statusCode: response.status, durationMs: round(performance.now() - startedAt, 2), body: parsed };
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
  return { facilityId: facility.facilityId, departmentId: department.departmentId };
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
  return resolveFacilityContext(bootstrap.body || {}, options);
}

function parseArgs(argv) {
  const parsed = {
    ...defaults,
    outputDir: "",
    facilityId: "",
    departmentId: "",
    password: process.env.FEE_E2E_PASSWORD || "",
    mfaCode: process.env.FEE_E2E_MFA_CODE || "",
    skipMemoPreflight: false,
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
    else if (arg === "--output-dir") parsed.outputDir = next(index++, arg);
    else if (arg === "--platform-base-url") parsed.platformBaseUrl = next(index++, arg);
    else if (arg === "--fee-base-url") parsed.feeBaseUrl = next(index++, arg);
    else if (arg === "--organization-code") parsed.organizationCode = next(index++, arg);
    else if (arg === "--login-id") parsed.loginId = next(index++, arg);
    else if (arg === "--password-file") parsed.passwordFile = next(index++, arg);
    else if (arg === "--mfa-code") parsed.mfaCode = next(index++, arg);
    else if (arg === "--control-repeats") parsed.controlRepeats = controlRepeatCount(next(index++, arg));
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInteger(next(index++, arg), arg);
    else if (arg === "--facility-id") parsed.facilityId = next(index++, arg);
    else if (arg === "--department-id") parsed.departmentId = next(index++, arg);
    else if (arg === "--setting") parsed.setting = next(index++, arg);
    else if (arg === "--skip-memo-preflight" || arg === "--allow-memo-disabled") parsed.skipMemoPreflight = true;
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

function assertStgTarget(options) {
  const hosts = [options.platformBaseUrl, options.feeBaseUrl].map((value) => new URL(value).hostname.toLowerCase());
  const isStgHost = (host) => host.includes("-stg-") || host.startsWith("stg.") || host.includes(".stg.");
  if (!hosts.every(isStgHost) || !String(options.organizationCode || "").toLowerCase().endsWith("-stg")) {
    throw new Error("this evaluator is restricted to STG API hosts and an organization code ending in -stg");
  }
}

function assertResponse(response, label) {
  if (response.statusCode < 400) return;
  const message = String(response.body?.error?.message || response.body?.message || response.body?.error || "request failed");
  throw new Error(`${label} failed (HTTP ${response.statusCode}): ${message.slice(0, 300)}`);
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
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function countBy(values) {
  return values.reduce((counts, value) => ({ ...counts, [value]: Number(counts[value] || 0) + 1 }), {});
}

function distribution(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, min: round(sorted[0]), median: round(median), mean: round(mean(sorted)), max: round(sorted.at(-1)) };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function controlRepeatCount(value) {
  const parsed = positiveInteger(value, "--control-repeats");
  if (parsed < 2 || parsed > 3) throw new Error("--control-repeats must be 2 or 3");
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
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

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatRatio(value) {
  return `${round(Number(value || 0) * 100, 1)}%`;
}

function printHelp() {
  process.stdout.write(`Fee longitudinal context evaluation (STG only)\n\nUsage:\n  npm run eval:fee-longitudinal-context -- [options]\n\nOptions:\n  --patient-dir PATH       Mock patient source directory (at least two charts)\n  --output-dir PATH        Output directory (result.json and README.md)\n  --control-repeats N      Full-extraction controls, 2 or 3. Default: 3\n  --organization-code ID   Default: yamamoto-demo-stg\n  --login-id ID            Default: yamamoto-admin\n  --password-file PATH     Default: .secrets/yamamoto-demo-stg-password.txt\n  --mfa-code CODE          Current 6-digit MFA code (or FEE_E2E_MFA_CODE)\n  --facility-id ID         Optional facility override\n  --department-id ID       Optional department override\n  --setting TYPE           Default: home_visit\n  --skip-memo-preflight    Permit a memo-disabled baseline; result is not acceptance-eligible\n  --dry-run                Validate fixtures without network calls\n  --help                   Show this help\n`);
}
