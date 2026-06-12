#!/usr/bin/env node
// v2統合生成器。sources/ 配下の全バッチを結合してデータセットJSONを出力する。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcesDir = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/sources");
const outPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json");

const batchFiles = fs.readdirSync(sourcesDir).filter((name) => name.endsWith(".mjs")).sort();
const allCases = [];
const includedBatchFiles = [];
for (const file of batchFiles) {
  const module = await import(pathToFileURL(path.join(sourcesDir, file)).href);
  if (module.includeInDataset === false) {
    continue;
  }
  if (!Array.isArray(module.cases)) {
    throw new Error(`${file} does not export cases[]`);
  }
  includedBatchFiles.push(file);
  allCases.push(...module.cases);
}

// 文体バリアント: variantOf で基底ケースの請求側(検証済み)を継承し、カルテ・文体軸・ディストラクタのみ差し替える。
const baseById = new Map(allCases.filter((c) => !c.variantOf).map((c) => [c.caseId, c]));
for (const item of allCases) {
  if (!item.variantOf) continue;
  const base = baseById.get(item.variantOf);
  if (!base) throw new Error(`variantOf not found: ${item.variantOf} (${item.caseId})`);
  for (const key of ["department", "facilityFixtureKey", "patient", "encounter", "expectedExtraction", "expectedClaimContext", "expectedCalculation", "billingTargets"]) {
    if (item[key] === undefined) item[key] = base[key];
  }
  item.title = item.title || `${base.title} [variant:${item.styleProfile || "alt"}]`;
  item.difficultyLevel = item.difficultyLevel || base.difficultyLevel;
}

function chartStandard(soap) {
  const sections = [
    ["S（Subjective：主観的情報）", soap.S],
    ["O（Objective：客観的情報）", soap.O],
    ["A（Assessment：評価）", soap.A],
    ["P（Plan：計画）", soap.P]
  ];
  return sections.map(([head, lines]) => `${head}\n${lines.join("\n")}`).join("\n\n");
}

function caseTypeSignature(item) {
  const basis = JSON.stringify({
    ...(item.caseTypeKey ? { caseTypeKey: item.caseTypeKey } : {}),
    department: item.department,
    assertion: item.expectedCalculation.assertionLevel,
    codes: item.expectedCalculation.candidateCodes,
    topics: item.expectedExtraction.requiredReviewTopics,
    fixture: item.facilityFixtureKey,
    realism: item.realismAxes,
    distractors: (item.distractors || []).map((d) => d.type),
    variantOf: item.variantOf || null,
    styleProfile: item.styleProfile || null
  });
  return `fee-soap-e2e-v2.case-type.v1:${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

const dataset = {
  schemaVersion: "fee-soap-e2e-cases.v2",
  datasetId: "fee-soap-e2e-v2",
  version: `2026-06-12.batches.${includedBatchFiles.length}`,
  purpose: "実カルテに近い文体での診療報酬算定E2Eゴールド第2世代。",
  goldContract: {
    templateMetaSentencesForbidden: true,
    officialMasterNamesInChartForbidden: true,
    facilityAttributesInChartForbidden: true,
    performedPredicate: "実施|施行|行った(「確認した」単独は実施根拠にしない)",
    distractorPolicy: "distractorsは本文に存在するが算定してはならない情報。否定・過去・他院・市販・予定のいずれかの文脈で明示する。"
  },
  sourceBatches: includedBatchFiles,
  cases: allCases.map((item) => ({
    caseId: item.caseId,
    title: item.title,
    difficultyLevel: item.difficultyLevel,
    calculationDifficulty: 1,
    patient: item.patient,
    encounter: { ...item.encounter, department: item.department },
    facilityFixtureKey: item.facilityFixtureKey,
    ...(item.caseTypeKey ? { caseTypeKey: item.caseTypeKey } : {}),
    realismAxes: item.realismAxes,
    ...(item.variantOf ? { variantOf: item.variantOf } : {}),
    ...(item.styleProfile ? { styleProfile: item.styleProfile } : {}),
    distractors: item.distractors || [],
    chart: { soap: item.soap, standard: chartStandard(item.soap) },
    status: "draft_pending_medical_review",
    qualityLabel: "synthetic_v2",
    expectedExtraction: item.expectedExtraction,
    expectedClaimContext: item.expectedClaimContext,
    expectedCalculation: item.expectedCalculation,
    billingTargets: item.billingTargets,
    evidence: [{ source: "engine_replay", note: "exactのexpectedCalculationはclaim-context再生検証で確定。医療事務レビュー前。" }],
    reviewPolicy: { productionGoldAllowed: false, medicalOfficeReviewed: false },
    caseTypeAxes: {
      department: item.department,
      assertionLevel: item.expectedCalculation.assertionLevel,
      ...(item.caseTypeKey ? { caseTypeKey: item.caseTypeKey } : {}),
      facilityFixtureKey: item.facilityFixtureKey,
      realismAxes: item.realismAxes,
      distractorTypes: (item.distractors || []).map((d) => d.type)
    },
    caseTypeSignature: caseTypeSignature(item)
  }))
};

fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2) + "\n");
const lengths = dataset.cases.map((c) => c.chart.standard.length);
const byAssertion = {};
for (const c of dataset.cases) {
  byAssertion[c.expectedCalculation.assertionLevel] = (byAssertion[c.expectedCalculation.assertionLevel] || 0) + 1;
}
console.log(`wrote ${dataset.cases.length} cases (${includedBatchFiles.join(", ")})`);
console.log(`assertions: ${JSON.stringify(byAssertion)}`);
console.log(`chart length: min ${Math.min(...lengths)} / avg ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)} / max ${Math.max(...lengths)}`);
