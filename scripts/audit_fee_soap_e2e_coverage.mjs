#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caseTypeAudit } from "./fee_soap_case_type_signature.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(repoRoot, args.dataset || "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const targetsPath = path.resolve(repoRoot, args.targets || "data/tests/fee-soap-e2e/coverage-targets.json");
const reportDir = path.resolve(repoRoot, args.reportDir || "data/tests/fee-soap-e2e/reports");

const dataset = readJson(datasetPath);
const targets = readJson(targetsPath);
const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
const domainDefinitions = (targets.billingDomains || []).map((domain) => ({
  ...domain,
  sourceSet: new Set(asArray(domain.sources).map(String)),
  regexes: asArray(domain.patterns).map((pattern) => new RegExp(pattern, "u"))
}));

const caseViews = cases.map((item) => {
  const domains = domainDefinitions
    .filter((domain) => caseMatchesDomain(item, domain))
    .map((domain) => domain.key);
  return {
    caseId: item.caseId,
    department: String(item.encounter?.department || "(missing)"),
    setting: String(item.encounter?.setting || "(missing)"),
    assertionLevel: assertionLevel(item),
    domains
  };
});

const report = buildReport({
  dataset,
  targets,
  cases,
  caseViews,
  datasetPath,
  targetsPath
});

if (!args.noWrite) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "coverage-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, "coverage-latest.md"), markdownReport(report));
}

if (args.json) {
  console.log(JSON.stringify(report.summary, null, 2));
} else {
  console.log(markdownSummary(report));
}

if (args.strict && report.summary.totalGapCount > 0) {
  process.exitCode = 1;
}

function buildReport({ dataset, targets, cases, caseViews, datasetPath, targetsPath }) {
  const typeAudit = caseTypeAudit(cases);
  const departmentRows = asArray(targets.departments).map((target) => {
    const matching = caseViews.filter((item) => item.department === target.key);
    const exact = matching.filter((item) => item.assertionLevel === "exact");
    const safety = matching.filter((item) => isSafetyOrUnsupported(item.assertionLevel));
    return {
      key: target.key,
      label: target.label,
      actual: matching.length,
      target: Number(target.minCases || 0),
      gap: positiveGap(target.minCases, matching.length),
      exact: exact.length,
      exactTarget: Number(target.minExact || 0),
      exactGap: positiveGap(target.minExact, exact.length),
      safetyOrUnsupported: safety.length,
      safetyOrUnsupportedTarget: Number(target.minSafetyOrUnsupported || 0),
      safetyOrUnsupportedGap: positiveGap(target.minSafetyOrUnsupported, safety.length)
    };
  });

  const domainRows = domainDefinitions.map((target) => {
    const matching = caseViews.filter((item) => item.domains.includes(target.key));
    const exact = matching.filter((item) => item.assertionLevel === "exact");
    const safety = matching.filter((item) => isSafetyOrUnsupported(item.assertionLevel));
    return {
      key: target.key,
      label: target.label,
      actual: matching.length,
      target: Number(target.minCases || 0),
      gap: positiveGap(target.minCases, matching.length),
      exact: exact.length,
      exactTarget: Number(target.minExact || 0),
      exactGap: positiveGap(target.minExact, exact.length),
      safetyOrUnsupported: safety.length,
      safetyOrUnsupportedTarget: Number(target.minSafetyOrUnsupported || 0),
      safetyOrUnsupportedGap: positiveGap(target.minSafetyOrUnsupported, safety.length)
    };
  });

  const departmentDomainRows = asArray(targets.departmentDomainTargets).map((target) => {
    const matching = caseViews.filter((item) => (
      item.department === target.department
      && item.domains.includes(target.domain)
    ));
    return {
      department: target.department,
      domain: target.domain,
      actual: matching.length,
      target: Number(target.minCases || 0),
      gap: positiveGap(target.minCases, matching.length),
      examples: matching.slice(0, 8).map((item) => item.caseId)
    };
  });

  const current = {
    totalCases: cases.length,
    exact: caseViews.filter((item) => item.assertionLevel === "exact").length,
    reviewRequired: caseViews.filter((item) => item.assertionLevel === "review_required").length,
    safetyOrUnsupported: caseViews.filter((item) => isSafetyOrUnsupported(item.assertionLevel)).length,
    departments: countBy(caseViews, (item) => item.department),
    settings: countBy(caseViews, (item) => item.setting),
    assertions: countBy(caseViews, (item) => item.assertionLevel),
    domains: countDomains(caseViews)
  };

  const scale = targets.expectedDatasetScale || {};
  const scaleRows = [
    scaleRow("minimumCases", cases.length, scale.minimumCases),
    scaleRow("recommendedCases", cases.length, scale.recommendedCases),
    scaleRow("exactMinimum", current.exact, scale.exactMinimum),
    scaleRow("reviewRequiredMinimum", current.reviewRequired, scale.reviewRequiredMinimum),
    scaleRow("safetyOrUnsupportedMinimum", current.safetyOrUnsupported, scale.safetyOrUnsupportedMinimum)
  ].filter(Boolean);

  const departmentGaps = departmentRows
    .filter((row) => row.gap || row.exactGap || row.safetyOrUnsupportedGap)
    .sort(gapSort);
  const domainGaps = domainRows
    .filter((row) => row.gap || row.exactGap || row.safetyOrUnsupportedGap)
    .sort(gapSort);
  const departmentDomainGaps = departmentDomainRows
    .filter((row) => row.gap)
    .sort((a, b) => b.gap - a.gap || a.department.localeCompare(b.department) || a.domain.localeCompare(b.domain));

  return {
    schemaVersion: "fee-soap-e2e.coverage-audit.v1",
    generatedAt: new Date().toISOString(),
    datasetId: dataset.datasetId || null,
    datasetVersion: dataset.version || null,
    targetId: targets.targetId || null,
    paths: {
      dataset: path.relative(repoRoot, datasetPath),
      targets: path.relative(repoRoot, targetsPath)
    },
    summary: {
      totalCases: cases.length,
      targetMinimumCases: Number(scale.minimumCases || 0),
      targetRecommendedCases: Number(scale.recommendedCases || 0),
      current,
      totalGapCount: scaleRows.filter((row) => row.gap > 0).length
        + departmentGaps.length
        + domainGaps.length
        + departmentDomainGaps.length,
      caseTypes: {
        totalCases: typeAudit.totalCases,
        uniqueCaseTypeSignatures: typeAudit.uniqueCaseTypeSignatures,
        duplicateCaseTypeSignatureGroups: typeAudit.duplicateCaseTypeSignatureGroups,
        uniqueBaseSignatures: typeAudit.uniqueBaseSignatures,
        duplicateBaseSignatureGroups: typeAudit.duplicateBaseSignatureGroups
      },
      topDepartmentGaps: departmentGaps.slice(0, 12),
      topDomainGaps: domainGaps.slice(0, 12),
      topDepartmentDomainGaps: departmentDomainGaps.slice(0, 20)
    },
    scaleRows,
    departmentRows,
    domainRows,
    departmentDomainRows,
    gaps: {
      departments: departmentGaps,
      domains: domainGaps,
      departmentDomains: departmentDomainGaps
    }
  };
}

function caseMatchesDomain(item, domain) {
  const sources = asArray(item.billingTargets).map((target) => String(target.source || target.type || "").trim()).filter(Boolean);
  if (sources.some((source) => domain.sourceSet.has(source))) {
    return true;
  }
  const text = structuredCaseText(item);
  return domain.regexes.some((regex) => regex.test(text));
}

function structuredCaseText(item) {
  const extraction = item.expectedExtraction || {};
  const targets = asArray(item.billingTargets);
  const evidence = asArray(item.evidence);
  return [
    item.title,
    item.sourceTitle,
    item.encounter?.department,
    item.encounter?.setting,
    item.encounter?.visitType,
    ...asArray(extraction.requiredDiagnoses),
    ...asArray(extraction.requiredProcedureCandidates),
    ...asArray(extraction.requiredReviewTopics),
    ...asArray(extraction.forbiddenCandidates),
    ...asArray(extraction.requiredBillingSignals),
    ...targets.flatMap((target) => [
      target.code,
      target.name,
      target.source,
      target.type,
      target.reason
    ]),
    ...evidence.flatMap((entry) => [
      entry.code,
      entry.name,
      entry.source,
      entry.masterVersion
    ])
  ].map((value) => String(value || "").normalize("NFKC")).join(" ");
}

function countDomains(caseViews) {
  const counts = new Map();
  for (const item of caseViews) {
    for (const domain of item.domains) {
      counts.set(domain, (counts.get(domain) || 0) + 1);
    }
  }
  return sortObject(counts);
}

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = String(fn(item) || "(missing)");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return sortObject(counts);
}

function sortObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function assertionLevel(item) {
  return String(item.expectedCalculation?.assertionLevel || item.assertionLevel || "(missing)");
}

function isSafetyOrUnsupported(level) {
  return ["safety", "unsupported_expected", "split_required"].includes(String(level || ""));
}

function positiveGap(target, actual) {
  return Math.max(0, Number(target || 0) - Number(actual || 0));
}

function scaleRow(key, actual, target) {
  if (!Number(target || 0)) return null;
  return {
    key,
    actual: Number(actual || 0),
    target: Number(target || 0),
    gap: positiveGap(target, actual)
  };
}

function gapSort(a, b) {
  const totalA = Number(a.gap || 0) + Number(a.exactGap || 0) + Number(a.safetyOrUnsupportedGap || 0);
  const totalB = Number(b.gap || 0) + Number(b.exactGap || 0) + Number(b.safetyOrUnsupportedGap || 0);
  return totalB - totalA || String(a.key).localeCompare(String(b.key));
}

function markdownSummary(report) {
  const lines = [
    `Coverage audit: ${report.datasetId || "(unknown dataset)"}`,
    `Cases: ${report.summary.totalCases} / minimum ${report.summary.targetMinimumCases} / recommended ${report.summary.targetRecommendedCases}`,
    `Case types: ${report.summary.caseTypes.uniqueCaseTypeSignatures}/${report.summary.caseTypes.totalCases} unique signatures, ${report.summary.caseTypes.duplicateCaseTypeSignatureGroups} duplicate type groups`,
    `Gaps: ${report.summary.totalGapCount}`,
    "",
    "Top department gaps:",
    ...report.summary.topDepartmentGaps.slice(0, 8).map((row) => `- ${row.key}: cases ${row.actual}/${row.target}, exact ${row.exact}/${row.exactTarget}, safety ${row.safetyOrUnsupported}/${row.safetyOrUnsupportedTarget}`),
    "",
    "Top domain gaps:",
    ...report.summary.topDomainGaps.slice(0, 8).map((row) => `- ${row.key}: cases ${row.actual}/${row.target}, exact ${row.exact}/${row.exactTarget}, safety ${row.safetyOrUnsupported}/${row.safetyOrUnsupportedTarget}`),
    "",
    "Top department-domain gaps:",
    ...report.summary.topDepartmentDomainGaps.slice(0, 10).map((row) => `- ${row.department} x ${row.domain}: ${row.actual}/${row.target}`)
  ];
  return `${lines.join("\n")}\n`;
}

function markdownReport(report) {
  return [
    `# Fee SOAP E2E Coverage Audit`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Dataset: \`${report.paths.dataset}\``,
    `Targets: \`${report.paths.targets}\``,
    "",
    "## Summary",
    "",
    table(["Metric", "Actual", "Target", "Gap"], report.scaleRows.map((row) => [row.key, row.actual, row.target, row.gap])),
    "",
    "## Case Type Uniqueness",
    "",
    table(
      ["Metric", "Value"],
      [
        ["totalCases", report.summary.caseTypes.totalCases],
        ["uniqueCaseTypeSignatures", report.summary.caseTypes.uniqueCaseTypeSignatures],
        ["duplicateCaseTypeSignatureGroups", report.summary.caseTypes.duplicateCaseTypeSignatureGroups],
        ["uniqueBaseSignatures", report.summary.caseTypes.uniqueBaseSignatures],
        ["duplicateBaseSignatureGroups", report.summary.caseTypes.duplicateBaseSignatureGroups]
      ]
    ),
    "",
    "## Department Targets",
    "",
    table(
      ["Department", "Cases", "Target", "Gap", "Exact", "Exact Target", "Safety/Unsupported", "Safety Target"],
      report.departmentRows.map((row) => [
        row.key,
        row.actual,
        row.target,
        row.gap,
        row.exact,
        row.exactTarget,
        row.safetyOrUnsupported,
        row.safetyOrUnsupportedTarget
      ])
    ),
    "",
    "## Billing Domain Targets",
    "",
    table(
      ["Domain", "Cases", "Target", "Gap", "Exact", "Exact Target", "Safety/Unsupported", "Safety Target"],
      report.domainRows.map((row) => [
        row.key,
        row.actual,
        row.target,
        row.gap,
        row.exact,
        row.exactTarget,
        row.safetyOrUnsupported,
        row.safetyOrUnsupportedTarget
      ])
    ),
    "",
    "## Department x Domain Gaps",
    "",
    table(
      ["Department", "Domain", "Cases", "Target", "Gap", "Examples"],
      report.gaps.departmentDomains.map((row) => [
        row.department,
        row.domain,
        row.actual,
        row.target,
        row.gap,
        row.examples.join(", ")
      ])
    )
  ].join("\n");
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? "").replace(/\n/g, " ")).join(" | ")} |`)
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(argv) {
  const parsed = {
    json: false,
    strict: false,
    noWrite: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--strict") {
      parsed.strict = true;
    } else if (arg === "--no-write") {
      parsed.noWrite = true;
    } else if (arg === "--dataset") {
      parsed.dataset = argv[index + 1];
      index += 1;
    } else if (arg === "--targets") {
      parsed.targets = argv[index + 1];
      index += 1;
    } else if (arg === "--report-dir") {
      parsed.reportDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
