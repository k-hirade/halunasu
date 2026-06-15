#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonFeeCalculator } from "../services/fee-api/src/python-calculator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(repoRoot, args.dataset || "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json");
const blueprintPath = path.resolve(repoRoot, args.blueprints || "data/tests/fee-soap-e2e-v2/gold-blueprints.json");
const masterDbPath = path.resolve(repoRoot, args.masterDb || "python/data/master/standard-master.sqlite");
const apply = Boolean(args.apply);

const calculator = new PythonFeeCalculator({
  pythonPath: path.join(repoRoot, "python"),
  masterDbPath,
  timeoutMs: Number(args.timeoutMs || 60000),
  workerMode: args.spawnPython ? false : true
});

try {
  const datasetSummary = await rebaselineFile({
    filePath: datasetPath,
    collectionKey: "cases",
    itemId: (item) => item.caseId || "",
    updateBillingTargets: true
  });
  const blueprintSummary = fs.existsSync(blueprintPath)
    ? await rebaselineFile({
      filePath: blueprintPath,
      collectionKey: "blueprints",
      itemId: (item) => item.blueprintId || item.caseId || "",
      updateBillingTargets: false
    })
    : null;

  console.log(JSON.stringify({
    ok: true,
    apply,
    masterDbPath: path.relative(repoRoot, masterDbPath),
    dataset: datasetSummary,
    blueprints: blueprintSummary
  }, null, 2));
} finally {
  calculator.stopWorker?.();
}

async function rebaselineFile({ filePath, collectionKey, itemId, updateBillingTargets }) {
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const items = Array.isArray(document[collectionKey]) ? document[collectionKey] : [];
  const changes = [];
  const errors = [];

  for (const item of items) {
    const expected = item.expectedCalculation || {};
    if (expected.assertionLevel !== "exact") continue;
    if (!item.expectedClaimContext) continue;

    const id = itemId(item);
    try {
      const result = await calculateExpectedContext(id, item.expectedClaimContext);
      const lineItems = Array.isArray(result.lineItems) ? result.lineItems : [];
      const actualTotal = Number(result.totalPoints || 0);
      const actualCodes = uniqueStrings([
        ...(Array.isArray(result.candidateCodes) ? result.candidateCodes : []),
        ...lineItems.map((line) => line.code)
      ]);
      const previousTotal = expected.totalPoints;
      const previousCodes = Array.isArray(expected.candidateCodes) ? expected.candidateCodes : [];
      const nextExpected = {
        ...expected,
        totalPoints: actualTotal,
        candidateCodes: actualCodes
      };

      item.expectedCalculation = nextExpected;
      if (updateBillingTargets) {
        item.billingTargets = lineItems
          .filter((line) => String(line.code || line.name || "").trim())
          .map((line) => normalizeBillingTarget(line));
      }

      if (
        Number(previousTotal) !== actualTotal
        || JSON.stringify(previousCodes) !== JSON.stringify(actualCodes)
      ) {
        changes.push({
          id,
          previousTotal,
          nextTotal: actualTotal,
          previousCodes,
          nextCodes: actualCodes
        });
      }
    } catch (error) {
      errors.push({
        id,
        message: error?.message || String(error)
      });
    }
  }

  if (apply && errors.length === 0) {
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);
  }

  return {
    path: path.relative(repoRoot, filePath),
    itemCount: items.length,
    exactCount: items.filter((item) => item.expectedCalculation?.assertionLevel === "exact").length,
    changedCount: changes.length,
    changes: changes.slice(0, Number(args.changeLimit || 40)),
    errorCount: errors.length,
    errors: errors.slice(0, 20),
    written: apply && errors.length === 0
  };
}

async function calculateExpectedContext(id, expectedClaimContext) {
  return calculator.calculate({
    feeSessionId: id,
    serviceDate: expectedClaimContext?.encounter?.service_date || "2026-07-10",
    setting: expectedClaimContext?.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
    claimContext: expectedClaimContext
  }, {});
}

function normalizeBillingTarget(line) {
  const quantity = Number(line.quantity ?? 1);
  const totalPoints = Number(line.totalPoints ?? line.points ?? 0);
  const points = Number(line.points ?? totalPoints);
  return {
    code: String(line.code || ""),
    name: String(line.name || ""),
    points,
    ...(quantity !== 1 ? { quantity } : {}),
    ...(totalPoints !== points || quantity !== 1 ? { totalPoints } : {}),
    ...(line.source ? { source: String(line.source) } : {})
  };
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--spawn-python") parsed.spawnPython = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}
