#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPhase2ContextContrastCorpus,
  auditPhase2HoldoutSupplement,
  auditPhase2PromotionPreparation
} from "./lib/fee-whitebox-phase2-corpus.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const context = readJson(args.context);
const supplement = readJson(args.supplement);
const promotion = auditPhase2PromotionPreparation({
  canonicalDataset: readJson(args.canonical),
  generatedHoldoutDataset: readJson(args.generatedHoldout),
  supplementDataset: supplement,
  reviewQueue: readJson(args.reviewQueue)
});
const report = {
  schemaVersion: "fee-whitebox-phase2-data-audit-v1",
  context: auditPhase2ContextContrastCorpus(context),
  supplement: auditPhase2HoldoutSupplement(supplement),
  promotionPreparation: promotion,
  boundaries: {
    contextIsTrainingOnlyNotGold: context.trainingOnly === true && context.notGold === true,
    supplementIsPendingNotGold:
      supplement.notGold === true
      && supplement.cases?.every((item) => item.annotationStatus === "pending_review"),
    promotionStillRequiresHumanReview: true
  }
};
console.log(JSON.stringify(args.verbose ? report : summarize(report), null, 2));
if (
  args.strictPrepared
  && (
    !report.context.ok
    || !report.supplement.ok
    || !report.promotionPreparation.ok
  )
) {
  process.exitCode = 1;
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8")
  );
}

function parseArgs(argv) {
  const parsed = {
    canonical: "data/tests/fee-specialty-matrix/cases.json",
    context: "data/tests/fee-specialty-matrix/context-contrast-cases.json",
    generatedHoldout:
      "data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json",
    supplement:
      "data/tests/fee-specialty-matrix/phase2-holdout-supplement.json",
    reviewQueue:
      "data/tests/fee-specialty-matrix/phase2-holdout-review-queue.json",
    strictPrepared: false,
    verbose: false
  };
  const mappings = {
    "--canonical": "canonical",
    "--context": "context",
    "--generated-holdout": "generatedHoldout",
    "--supplement": "supplement",
    "--review-queue": "reviewQueue"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (mappings[arg]) parsed[mappings[arg]] = String(argv[++index] || "");
    else if (arg === "--strict-prepared") parsed.strictPrepared = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node scripts/audit_fee_whitebox_phase2_data.mjs [--strict-prepared]

This verifies training-only context data and pending holdout preparation.
It never treats pending suggestions as reviewed promotion gold.`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function summarize(report) {
  const prepared = report.promotionPreparation.coverage || [];
  return {
    schemaVersion: report.schemaVersion,
    context: {
      ok: report.context.ok,
      caseCount: report.context.caseCount,
      completeCellCount: report.context.completeCellCount,
      cellCount: report.context.cellCount,
      errors: report.context.errors
    },
    supplement: {
      ok: report.supplement.ok,
      caseCount: report.supplement.caseCount,
      completeCellCount: report.supplement.completeCellCount,
      cellCount: report.supplement.cellCount,
      errors: report.supplement.errors
    },
    promotionPreparation: {
      ok: report.promotionPreparation.ok,
      reviewedCompleteCellCount:
        report.promotionPreparation.reviewedCompleteCellCount,
      preparedCompleteCellCount:
        report.promotionPreparation.preparedCompleteCellCount,
      cellCount: report.promotionPreparation.cellCount,
      queueCount: report.promotionPreparation.queueCount,
      requirements: report.promotionPreparation.requirements,
      preparedRanges: {
        runs: range(prepared.map((cell) => cell.caseCount)),
        lines: range(prepared.map((cell) => cell.preparedLineCount)),
        spans: range(prepared.map((cell) => cell.preparedSpanCount))
      },
      errors: report.promotionPreparation.errors
    },
    boundaries: report.boundaries
  };
}

function range(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length
    ? { min: Math.min(...numbers), max: Math.max(...numbers) }
    : { min: null, max: null };
}
