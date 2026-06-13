#!/usr/bin/env node
// v2ゴールド契約バリデータ。
// 1) スキーマ/参照整合 2) 文体リント(メタ文・正式名称・施設属性の禁止) 3) exactコードの臨床アンカー
// 4) 難易度別の長さバンド 5) ディストラクタとforbiddenの整合 6) 一意性
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json");
const fixturesPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/facility-fixtures.json");

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8")).fixtures || {};
const errors = [];
const warnings = [];

const META_SENTENCE_PATTERN = /(当日確認した主な診療内容|確認すべき論点|確認論点は|点数に直結する名称|会計前に当日実施した内容|当日実施と混同しやすい内容)/u;
const SYSTEM_BILLING_VOCAB_PATTERN = /(自動確定|算定上|算定候補|請求候補|会計前に確認|会計上|算定時|算定へ反映|算定に反映)/u;
// 全角括弧つきの点数表正式名称(例: ＣＴ撮影（１６列…）、処方箋料（リフィル…))をカルテに書かない
const OFFICIAL_NAME_PATTERN = /(ＣＴ撮影（|ＭＲＩ撮影（|処方箋料（|電子画像管理加算|検体検査管理加算|外来迅速検体検査加算|単純撮影（イ）|一般名処方加算|入院料１|入院料２)/u;
// 施設属性(機器列数・電子保存体制・届出)はfixtureが持つ
const FACILITY_ATTRIBUTE_PATTERN = /(\d{1,3}\s*列|マルチスライス型|電子画像管理|電子的に保存|施設基準|届出|地方厚生局)/u;

const LENGTH_BANDS = { L1: [350, 650], L2: [500, 950], L3: [650, 1200] };

const PERFORMED = "(?:を)?(?:実施|施行|行い|行った)";
const EXACT_CODE_ANCHOR_RULES = {
  "160000310": { label: "尿一般", pattern: new RegExp(`(?:尿一般|尿定性|尿検査)[^。\n]{0,40}${PERFORMED}|${PERFORMED.replace("(?:を)?", "")}`, "u"), custom: (text) => /(?:尿定性|尿一般|尿検査)[^。\n]*(?:実施|施行)/u.test(text) },
  "160000410": { label: "尿蛋白", custom: (text) => /尿蛋白[^。\n]*(?:実施|施行)|(?:尿定性・尿蛋白|尿一般、尿蛋白)[^。\n]*(?:実施|施行)/u.test(text) },
  "160054710": { label: "ＣＲＰ", custom: (text) => /(?:CRP|ＣＲＰ)[^。\n]*(?:実施|施行|測定)/u.test(text) },
  "160008010": { label: "末梢血液一般", custom: (text) => /(?:血算|CBC|末梢血液一般)[^。\n]*(?:実施|施行|測定)/u.test(text) },
  "160169450": { label: "インフルエンザ抗原", custom: (text) => /インフル[^。\n]*(?:迅速|抗原)[^。\n]*(?:実施|施行)/u.test(text) },
  "160044110": { label: "溶連菌迅速", custom: (text) => /溶連菌[^。\n]*(?:迅速|抗原)?[^。\n]*(?:実施|施行)/u.test(text) },
  "160230050": { label: "コロナ・インフル同時抗原", custom: (text) => /(?:コロナ|COVID)[^。\n]*インフル[^。\n]*(?:同時)?[^。\n]*(?:抗原|迅速)[^。\n]*(?:実施|施行)/u.test(text) },
  "160095710": { label: "Ｂ－Ｖ(採血実施)", custom: (text) => /(?:静脈採血|採血)[^。\n]{0,30}(?:実施|施行|行い|行った)/u.test(text) },
  "170011810": { label: "CT実施", custom: (text) => /(?:CT|ＣＴ)[^。\n]{0,30}(?:実施|施行)/u.test(text) },
  "170000410": { label: "単純撮影実施", custom: (text) => /(?:XP|X線|Ｘ線|レントゲン|撮影)[^。\n]{0,30}(?:実施|施行)/u.test(text) },
  "140032010": { label: "熱傷処置", custom: (text) => /熱傷[^。\n]{0,30}処置[^。\n]{0,20}(?:実施|施行)/u.test(text) },
  "620008991": { label: "ゲーベンクリーム院内処方", custom: (text) => /ゲーベンクリーム[^。\n]{0,30}(?:院内)?処方/u.test(text) },
  "120002910": { label: "院外処方箋交付", custom: (text) => /院外処方箋[^。\n]{0,15}(?:交付|発行)/u.test(text) },
  "120004270": { label: "一般名処方", custom: (text) => /一般名処方/u.test(text) }
};

const ids = new Set();
const signatures = new Set();
const chartLineOccurrences = new Map();

for (const item of dataset.cases || []) {
  const cid = item.caseId || "(no id)";
  const chart = String(item.chart?.standard || "");
  const fail = (msg) => errors.push({ caseId: cid, error: msg });
  const warn = (msg) => warnings.push({ caseId: cid, warning: msg });

  // 1) スキーマ・参照
  for (const key of ["caseId", "patient", "encounter", "chart", "expectedExtraction", "expectedClaimContext", "expectedCalculation", "facilityFixtureKey", "difficultyLevel"]) {
    if (item[key] === undefined) fail(`missing field: ${key}`);
  }
  if (item.facilityFixtureKey && !fixtures[item.facilityFixtureKey]) {
    fail(`unknown facilityFixtureKey: ${item.facilityFixtureKey}`);
  }
  if (ids.has(cid)) fail("duplicate caseId");
  ids.add(cid);
  if (signatures.has(item.caseTypeSignature)) fail("duplicate caseTypeSignature");
  signatures.add(item.caseTypeSignature);

  // fixtureとclaim contextの施設基準整合
  const fixtureKeys = (fixtures[item.facilityFixtureKey]?.facilityStandardKeys || []).slice().sort().join("|");
  const contextKeys = (item.expectedClaimContext?.facility_standard_keys || []).slice().sort().join("|");
  if (contextKeys && !fixtureKeys.includes(contextKeys.split("|")[0]) && contextKeys !== fixtureKeys) {
    fail(`claim context facility_standard_keys (${contextKeys}) not provided by fixture ${item.facilityFixtureKey}`);
  }

  // 2) 文体リント
  if (META_SENTENCE_PATTERN.test(chart)) fail("chart contains forbidden template/meta sentence");
  if (SYSTEM_BILLING_VOCAB_PATTERN.test(chart)) fail("chart contains billing-system vocabulary");
  if (OFFICIAL_NAME_PATTERN.test(chart)) fail("chart contains official master/billing name");
  if (FACILITY_ATTRIBUTE_PATTERN.test(chart)) fail("chart contains facility attribute (equipment/e-management/notification)");
  if (/[A-Za-z]{6,}\s/u.test(chart.replace(/SpO2|GCS|MMT|CRP|WBC|LDL|HDL|TG|HbA1c|COPD|TKA|XP|DR|CVA|KT|BT|BP|ESA|HE|IgE/gu, ""))) {
    warn("chart may contain unintended English words");
  }
  for (const rawLine of chart.split(/\n+/u)) {
    const line = rawLine.trim();
    if (line.length < 18) continue;
    if (/^(S|O|A|P)（|^(S|O|A|P):/u.test(line)) continue;
    if (/^(BP|KT|BT|SpO2|HR|P)\b/u.test(line)) continue;
    const entry = chartLineOccurrences.get(line) || { count: 0, caseIds: new Set() };
    entry.count += 1;
    entry.caseIds.add(cid);
    chartLineOccurrences.set(line, entry);
  }

  // 3) exactアンカー
  if (item.expectedCalculation?.assertionLevel === "exact") {
    if (typeof item.expectedCalculation.totalPoints !== "number") fail("exact case missing totalPoints");
    const expectedCodes = new Set((item.expectedCalculation.candidateCodes || []).map(String));
    const visitType = String(item.encounter?.visitType || "").trim();
    const expectedFeeKind = String(item.expectedClaimContext?.outpatient_basic?.fee_kind || "").trim();
    if (expectedCodes.has("111000110") && visitType && visitType !== "initial") {
      fail(`initial fee code 111000110 conflicts with encounter.visitType=${visitType}`);
    }
    if (expectedCodes.has("112007410") && visitType && visitType !== "revisit") {
      fail(`revisit fee code 112007410 conflicts with encounter.visitType=${visitType}`);
    }
    if (expectedCodes.has("111000110") && expectedFeeKind && expectedFeeKind !== "initial") {
      fail(`initial fee code 111000110 conflicts with expectedClaimContext.outpatient_basic.fee_kind=${expectedFeeKind}`);
    }
    if (expectedCodes.has("112007410") && expectedFeeKind && expectedFeeKind !== "revisit") {
      fail(`revisit fee code 112007410 conflicts with expectedClaimContext.outpatient_basic.fee_kind=${expectedFeeKind}`);
    }
    const billingTargetTotal = (item.billingTargets || []).reduce((sum, target) => sum + Number(target?.totalPoints ?? target?.points ?? 0), 0);
    if (item.billingTargets?.length && Number(billingTargetTotal) !== Number(item.expectedCalculation.totalPoints)) {
      fail(`billingTargets total ${billingTargetTotal} != expectedCalculation.totalPoints ${item.expectedCalculation.totalPoints}`);
    }
    const fixture = fixtures[item.facilityFixtureKey] || {};
    if ((expectedCodes.has("170000210") || expectedCodes.has("170028810")) && fixture.electronicImageManagement !== true) {
      fail(`electronic image management code expected but fixture ${item.facilityFixtureKey} has electronicImageManagement=false`);
    }
    if (expectedCodes.has("170011810") && !fixture.equipment?.ct) {
      fail(`CT code 170011810 expected but fixture ${item.facilityFixtureKey} has no CT equipment kind`);
    }
    for (const code of item.expectedCalculation.candidateCodes || []) {
      const rule = EXACT_CODE_ANCHOR_RULES[code];
      if (!rule) continue; // 基本料・判断料・派生コードはアンカー不要(導出される)
      if (!rule.custom(chart)) fail(`missing clinical anchor for ${code} (${rule.label})`);
    }
  }

  // review/safety/unsupportedはneeds_reviewが期待
  if (["review_required", "safety", "unsupported_expected", "split_required"].includes(item.expectedCalculation?.assertionLevel)) {
    if (item.expectedCalculation.engineStatus !== "needs_review") fail("non-exact case should expect engineStatus=needs_review");
  }

  // 4) 長さバンド
  const band = LENGTH_BANDS[item.difficultyLevel];
  if (band) {
    if (chart.length < band[0]) fail(`chart too short for ${item.difficultyLevel}: ${chart.length} < ${band[0]}`);
    if (chart.length > band[1]) warn(`chart longer than ${item.difficultyLevel} band: ${chart.length} > ${band[1]}`);
  }

  // 5) ディストラクタ整合: 否定/予定/他院系のbillableなディストラクタは本文に対応語があること
  for (const distractor of item.distractors || []) {
    const name = String(distractor.name || "").split("(")[0].trim();
    if (name && !chart.includes(name.slice(0, Math.min(4, name.length)))) {
      warn(`distractor "${distractor.name}" not clearly present in chart`);
    }
  }
}

for (const [line, entry] of chartLineOccurrences.entries()) {
  if (entry.caseIds.size >= 5) {
    warnings.push({
      caseId: "cross-case",
      warning: `same chart line appears in ${entry.caseIds.size} cases: ${line.slice(0, 80)}`
    });
  }
}

const ok = errors.length === 0;
console.log(JSON.stringify({
  ok,
  datasetPath: path.relative(repoRoot, datasetPath),
  cases: (dataset.cases || []).length,
  errors: errors.slice(0, 50),
  errorCount: errors.length,
  warnings: warnings.slice(0, 20),
  warningCount: warnings.length
}, null, 2));
if (!ok) process.exitCode = 1;
