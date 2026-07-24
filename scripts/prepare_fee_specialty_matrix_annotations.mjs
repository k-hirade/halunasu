#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unicodeOffsetOf } from "./lib/fee-specialty-matrix.mjs";

export const DEPARTMENT_TO_SPECIALTY = Object.freeze({
  internal_medicine: "internal_medicine",
  dermatology: "dermatology",
  orthopedics: "orthopedics",
  pediatrics: "pediatrics",
  otolaryngology: "otolaryngology",
  ophthalmology: "ophthalmology",
  psychiatry: "psychiatry",
  surgery: "surgery"
});

const SUPPORTED_SETTINGS = new Set([
  "outpatient",
  "home_visit",
  "house_call",
  "telephone"
]);

function normalized(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, "");
}

function coreName(value) {
  return String(value ?? "")
    .replace(/[（(][^）)]*[）)]/gu, "")
    .replace(/(?:料|加算)$/u, "")
    .trim();
}

export function buildAnchorSuggestions(caseItem) {
  const clinicalText = String(caseItem?.chart?.standard ?? "");
  const targets = Array.isArray(caseItem?.billingTargets)
    ? caseItem.billingTargets
    : [];
  const terms = new Set([
    ...(caseItem?.expectedExtraction?.requiredBillingSignals ?? []),
    ...targets.map((target) => coreName(target?.name))
  ]);
  const suggestions = [];
  const seen = new Set();

  for (const rawTerm of terms) {
    const term = String(rawTerm ?? "").trim();
    if (Array.from(term).length < 2) continue;
    let fromOffset = 0;
    while (true) {
      const charStart = unicodeOffsetOf(clinicalText, term, fromOffset);
      if (charStart < 0) break;
      const charEnd = charStart + Array.from(term).length;
      const identity = `${charStart}|${charEnd}|${term}`;
      if (!seen.has(identity)) {
        const termNormalized = normalized(term);
        const codeCandidates = targets
          .filter((target) => {
            const targetName = normalized(coreName(target?.name));
            return (
              targetName.includes(termNormalized)
              || termNormalized.includes(targetName)
            );
          })
          .map((target) => String(target.code));
        suggestions.push({
          text: term,
          charStart,
          charEnd,
          codeCandidates: [...new Set(codeCandidates)],
          status: "suggestion_only"
        });
        seen.add(identity);
      }
      fromOffset = charEnd;
    }
  }
  return suggestions.sort(
    (left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd
  );
}

export function prepareAnnotationQueue(sourceDataset) {
  const queue = [];
  const skipped = [];
  for (const caseItem of sourceDataset?.cases ?? []) {
    const department = caseItem?.encounter?.department;
    const specialty = DEPARTMENT_TO_SPECIALTY[department];
    const encounterSetting = caseItem?.encounter?.setting;
    if (!specialty || !SUPPORTED_SETTINGS.has(encounterSetting)) {
      skipped.push({
        caseId: caseItem?.caseId,
        reason: !specialty ? "unsupported_specialty" : "unsupported_setting"
      });
      continue;
    }
    queue.push({
      sourceCaseId: caseItem.caseId,
      specialty,
      encounterSetting,
      sourceTemplateId:
        caseItem.caseTypeKey
        ?? caseItem.caseTypeSignature
        ?? caseItem.variantOf
        ?? caseItem.caseId,
      clinicalText: caseItem?.chart?.standard ?? "",
      expectedClaimContext: caseItem.expectedClaimContext ?? {},
      billingTargets: caseItem.billingTargets ?? [],
      anchorSuggestions: buildAnchorSuggestions(caseItem),
      annotationStatus: "pending_manual_annotation",
      synthetic: true,
      notGold: true,
      instructions: [
        "Confirm every billable span in the chart; suggestions are not exhaustive.",
        "Assign one code, category, and all five context axes to each accepted span.",
        "Do not promote this item to cases.json until offsets and labels pass review."
      ]
    });
  }
  return {
    schemaVersion: "fee-specialty-matrix-annotation-queue-v1",
    sourceDatasetId: sourceDataset?.datasetId ?? null,
    status: "suggestions_require_manual_review",
    queue,
    skipped
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const sourceIndex = args.indexOf("--source");
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    console.error("--output is required; annotation queues are never written into cases.json automatically");
    process.exitCode = 2;
  } else {
    const sourcePath = path.resolve(
      repoRoot,
      sourceIndex >= 0 && args[sourceIndex + 1]
        ? args[sourceIndex + 1]
        : "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json"
    );
    const outputPath = path.resolve(repoRoot, args[outputIndex + 1]);
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const result = prepareAnnotationQueue(source);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(result, null, 2)}\n`
    );
    console.log(JSON.stringify({
      output: path.relative(repoRoot, outputPath),
      queued: result.queue.length,
      skipped: result.skipped.length,
      noAutomaticGoldPromotion: true
    }, null, 2));
  }
}
