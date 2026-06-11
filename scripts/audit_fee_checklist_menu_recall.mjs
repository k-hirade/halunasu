#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildClinicalChecklistMenu, normalizeClinicalText } from "../services/fee-api/src/clinical-calculation-input.js";

const repoRoot = process.cwd();
const DEFAULT_DATASET = "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json";

const CODE_EXPECTATIONS = Object.freeze({
  "160000310": expectation("lab", ["lab:urine_general"], "尿一般"),
  "160000410": expectation("lab", ["lab:urine_protein"], "尿蛋白"),
  "160054710": expectation("lab", ["lab:crp"], "CRP"),
  "160054610": expectation("lab", ["lab:crp"], "CRP"),
  "160008010": expectation("lab", ["lab:cbc"], "末梢血液一般"),
  "160010010": expectation("lab", ["lab:hba1c"], "HbA1c"),
  "160019410": expectation("lab", ["lab:glucose"], "グルコース"),
  "160022410": expectation("lab", ["lab:tcho"], "Tcho"),
  "160167250": expectation("lab", ["lab:ldl"], "LDL"),
  "160020910": expectation("lab", ["lab:tg"], "TG"),
  "160019210": expectation("lab", ["lab:creatinine"], "クレアチニン"),
  "160169450": expectation("lab", ["lab:influenza_antigen", "lab:covid_flu_antigen"], "インフル抗原"),
  "160044110": expectation("lab", ["lab:group_a_strep_rapid"], "A群β溶連菌迅速"),
  "160230050": expectation("lab", ["lab:covid_flu_antigen"], "新型コロナ・インフル同時"),
  "170011810": expectation("imaging", ["imaging:ct"], "CT"),
  "170011710": expectation("imaging", ["imaging:ct"], "CT"),
  "170015210": expectation("imaging", ["imaging:mri"], "MRI"),
  "170000410": expectation("imaging", ["imaging:simple_radiography"], "単純X線"),
  "170027910": expectation("imaging", ["imaging:simple_radiography"], "単純X線"),
  "170012070": expectation("imaging", ["imaging:ct"], "造影CT"),
  "120002910": expectation("medication_prescription", [], "処方箋料", { reportOnly: true }),
  "120004270": expectation("medication_prescription", [], "一般名処方加算", { reportOnly: true })
});

const TOPIC_EXPECTATIONS = Object.freeze([
  topicExpectation("手術未対応", "unsupported_domains", ["domain:surgery"]),
  topicExpectation("手技内容確認", "unsupported_domains", ["domain:surgery", "domain:anesthesia"]),
  topicExpectation("麻酔未対応", "unsupported_domains", ["domain:anesthesia"]),
  topicExpectation("面接時間確認", "unsupported_domains", ["domain:anesthesia"]),
  topicExpectation("病理未対応", "unsupported_domains", ["domain:pathology"]),
  topicExpectation("検体提出確認", "unsupported_domains", ["domain:pathology"]),
  topicExpectation("リハビリ未対応", "unsupported_domains", ["domain:rehabilitation"]),
  topicExpectation("実施単位確認", "unsupported_domains", ["domain:rehabilitation"]),
  topicExpectation("在宅医療未対応", "unsupported_domains", ["domain:home_care"]),
  topicExpectation("訪問診療確認", "unsupported_domains", ["domain:home_care"]),
  topicExpectation("精神科専門療法未対応", "unsupported_domains", ["domain:psychiatry_special"]),
  topicExpectation("内視鏡未対応", "unsupported_domains", ["domain:endoscopy"]),
  topicExpectation("生検有無確認", "unsupported_domains", ["domain:endoscopy", "domain:pathology"]),
  topicExpectation("透析未対応", "unsupported_domains", ["domain:dialysis"]),
  topicExpectation("輸血未対応", "unsupported_domains", ["domain:transfusion"]),
  topicExpectation("放射線治療未対応", "unsupported_domains", ["domain:radiation_therapy"]),
  topicExpectation("照射条件確認", "unsupported_domains", ["domain:radiation_therapy"]),
  topicExpectation("救急加算確認", "review_topics", ["domain:emergency_time_addon"]),
  topicExpectation("受付時刻確認", "review_topics", ["domain:emergency_time_addon"]),
  topicExpectation("材料確認", "review_topics", ["material:medical_material"]),
  topicExpectation("数量確認", "review_topics", ["material:medical_material"], { reportOnly: true }),
  topicExpectation("造影確認", "review_topics", ["imaging:ct", "imaging:mri"], { reportOnly: true }),
  topicExpectation("電子保存確認", "review_topics", ["imaging:ct", "imaging:mri", "imaging:simple_radiography"], { reportOnly: true }),
  topicExpectation("検査コード確認", "review_topics", [
    "lab:urine_general",
    "lab:urine_protein",
    "lab:crp",
    "lab:cbc",
    "lab:hba1c",
    "lab:glucose",
    "lab:covid_flu_antigen",
    "lab:influenza_antigen",
    "lab:covid_antigen",
    "lab:group_a_strep_rapid"
  ], { reportOnly: true })
]);

const CATEGORY_DEFAULTS = Object.freeze({
  lab: { gate: true, threshold: 0.95 },
  imaging: { gate: true, threshold: 0.95 },
  unsupported_domains: { gate: true, threshold: 0.95 },
  review_topics: { gate: false, threshold: 0.8 },
  medication_prescription: { gate: false, threshold: 0.8 }
});

const args = parseArgs(process.argv.slice(2));
const dataset = readJson(args.dataset);
const caseFilter = new Set(args.caseIds);
const expectations = [];

for (const item of dataset.cases || []) {
  if (caseFilter.size && !caseFilter.has(item.caseId)) {
    continue;
  }
  const chartText = chartTextForCase(item);
  const menu = buildClinicalChecklistMenu(chartText);
  const menuIds = new Set(menu.map((entry) => entry.menuId));
  const expectedCodes = (item.expectedCalculation?.candidateCodes || []).map(String);
  for (const code of expectedCodes) {
    const expected = CODE_EXPECTATIONS[code];
    if (!expected) continue;
    expectations.push(expectationResult({
      caseId: item.caseId,
      kind: "code",
      expectedKey: code,
      label: expected.label,
      category: expected.category,
      expectedMenuIds: expected.menuIds,
      menuIds,
      reportOnly: expected.reportOnly,
      chartText
    }));
  }
  for (const topic of item.expectedExtraction?.requiredReviewTopics || []) {
    const topicText = String(topic || "");
    const expected = TOPIC_EXPECTATIONS.find((entry) => normalizeKey(topicText).includes(normalizeKey(entry.topic)));
    if (!expected) continue;
    expectations.push(expectationResult({
      caseId: item.caseId,
      kind: "review_topic",
      expectedKey: expected.topic,
      label: expected.topic,
      category: expected.category,
      expectedMenuIds: expected.menuIds,
      menuIds,
      reportOnly: expected.reportOnly,
      chartText
    }));
  }
}

const byCategory = summarizeByCategory(expectations);
const failedGates = Object.entries(byCategory)
  .filter(([category, summary]) => {
    const config = CATEGORY_DEFAULTS[category] || { gate: false, threshold: 0 };
    return args.strict && config.gate && summary.total > 0 && summary.recall < config.threshold;
  })
  .map(([category, summary]) => ({
    category,
    recall: summary.recall,
    threshold: (CATEGORY_DEFAULTS[category] || {}).threshold
  }));

const report = {
  ok: failedGates.length === 0,
  dataset: args.dataset,
  cases: caseFilter.size || dataset.cases?.length || 0,
  expectations: expectations.length,
  strict: args.strict,
  summary: byCategory,
  failedGates,
  misses: expectations
    .filter((item) => !item.hit)
    .slice(0, args.maxMisses)
};

console.log(JSON.stringify(report, null, 2));
if (failedGates.length) {
  process.exit(1);
}

function expectation(category, menuIds, label, options = {}) {
  return {
    category,
    menuIds,
    label,
    reportOnly: Boolean(options.reportOnly)
  };
}

function topicExpectation(topic, category, menuIds, options = {}) {
  return {
    topic,
    category,
    menuIds,
    reportOnly: Boolean(options.reportOnly)
  };
}

function expectationResult({ caseId, kind, expectedKey, label, category, expectedMenuIds, menuIds, reportOnly, chartText }) {
  const hit = expectedMenuIds.some((menuId) => menuIds.has(menuId));
  const supported = expectedMenuIds.length > 0;
  return {
    caseId,
    kind,
    expectedKey,
    label,
    category,
    supported,
    reportOnly: Boolean(reportOnly || !supported),
    hit,
    expectedMenuIds,
    actualMenuIds: [...menuIds],
    chartHint: hit ? "" : shortChartHint(chartText, label)
  };
}

function summarizeByCategory(items) {
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.category]) {
      grouped[item.category] = {
        total: 0,
        supported: 0,
        reportOnly: 0,
        hits: 0,
        misses: 0,
        recall: 0,
        gate: Boolean(CATEGORY_DEFAULTS[item.category]?.gate),
        threshold: CATEGORY_DEFAULTS[item.category]?.threshold || null
      };
    }
    const summary = grouped[item.category];
    summary.total += 1;
    if (item.supported) summary.supported += 1;
    if (item.reportOnly) summary.reportOnly += 1;
    if (item.hit) summary.hits += 1;
    else summary.misses += 1;
  }
  for (const summary of Object.values(grouped)) {
    summary.recall = summary.total ? Number((summary.hits / summary.total).toFixed(4)) : 0;
  }
  return grouped;
}

function chartTextForCase(item) {
  return ["S", "O", "A", "P"]
    .flatMap((section) => item.chart?.soap?.[section] || [])
    .join("\n");
}

function shortChartHint(chartText, label) {
  const normalizedLabel = normalizeClinicalText(label);
  const lines = String(chartText || "").split(/\n/u).map((line) => line.trim()).filter(Boolean);
  const matched = lines.find((line) => normalizeClinicalText(line).includes(normalizedLabel.slice(0, Math.min(4, normalizedLabel.length))));
  return matched ? matched.slice(0, 160) : "";
}

function normalizeKey(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8"));
}

function parseArgs(argv) {
  const parsed = {
    dataset: DEFAULT_DATASET,
    strict: false,
    maxMisses: 40,
    caseIds: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--dataset") parsed.dataset = next();
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--max-misses") parsed.maxMisses = Number(next());
    else if (arg === "--case") parsed.caseIds.push(next());
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/audit_fee_checklist_menu_recall.mjs [options]

Options:
  --dataset PATH        Dataset JSON path. Default: ${DEFAULT_DATASET}
  --case CASE_ID        Restrict to one case. Can be repeated.
  --max-misses N        Number of misses to include in report. Default: 40
  --strict              Exit non-zero when gate-enabled categories miss threshold.
`);
}
