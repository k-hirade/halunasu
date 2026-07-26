#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPhase2ContextContrastCorpus,
  auditPhase2HoldoutSupplement,
  buildPhase2ContextContrastCorpus,
  buildPhase2HoldoutSupplement
} from "./lib/fee-whitebox-phase2-corpus.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(repoRoot, args.output);
const document = args.kind === "context"
  ? buildPhase2ContextContrastCorpus({ casesPerCell: args.casesPerCell })
  : buildPhase2HoldoutSupplement();
const audit = args.kind === "context"
  ? auditPhase2ContextContrastCorpus(document)
  : auditPhase2HoldoutSupplement(document);
const content = `${JSON.stringify(document, null, 2)}\n`;

if (args.check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) {
    console.error(`phase2 ${args.kind} corpus is missing or stale: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log(`phase2 ${args.kind} corpus is current: ${outputPath}`);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
  console.log(JSON.stringify({
    output: path.relative(repoRoot, outputPath),
    kind: args.kind,
    caseCount: audit.caseCount,
    completeCellCount: audit.completeCellCount,
    cellCount: audit.cellCount,
    notGold: document.notGold === true
  }, null, 2));
}

function parseArgs(argv) {
  const parsed = {
    kind: "",
    output: "",
    casesPerCell: 3,
    check: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--kind") parsed.kind = String(argv[++index] || "");
    else if (arg === "--output") parsed.output = String(argv[++index] || "");
    else if (arg === "--cases-per-cell") {
      parsed.casesPerCell = Number.parseInt(argv[++index] || "", 10);
    } else if (arg === "--check") parsed.check = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["context", "holdout"].includes(parsed.kind)) {
    throw new Error("--kind must be context or holdout");
  }
  if (!parsed.output) throw new Error("--output is required");
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/generate_fee_whitebox_phase2_corpus.mjs \\
    --kind context|holdout \\
    --output PATH \\
    [--cases-per-cell 3] [--check]

context creates training-only, non-gold contrast cases.
holdout creates pending-review supplemental cases and never promotes them.`);
}
