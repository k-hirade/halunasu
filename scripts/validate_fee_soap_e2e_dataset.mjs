#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { caseTypeAudit, caseTypeSignature } from "./fee_soap_case_type_signature.mjs";

const repoRoot = process.cwd();
const datasetPath = "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json";
const expectedCount = 800;
const minChartChars = 600;

const data = readJson(datasetPath);
const errors = [];
const assertionCounts = {};
const qualityCounts = {};
const statusCounts = {};
const difficultyCounts = {};
let caseTypeSummary = null;

if (data.datasetId !== "fee-soap-e2e-cases") {
  errors.push(`datasetId must be fee-soap-e2e-cases, found ${data.datasetId}`);
}
if (data.cases?.length !== expectedCount) {
  errors.push(`cases count ${data.cases?.length} != ${expectedCount}`);
}
if (!data.evaluationPolicy?.requiredBillingSignals) {
  errors.push("evaluationPolicy.requiredBillingSignals is missing");
}

const ids = new Set();
for (const item of data.cases || []) {
  const id = item.caseId;
  if (ids.has(id)) {
    errors.push(`${id}: duplicate caseId`);
  }
  ids.add(id);

  for (const key of [
    "sourceCaseId",
    "sourceTitle",
    "title",
    "difficultyLevel",
    "calculationDifficulty",
    "patient",
    "encounter",
    "chart",
    "caseTypeAxes",
    "caseTypeSignature",
    "status",
    "qualityLabel",
    "expectedExtraction",
    "expectedClaimContext",
    "expectedCalculation",
    "billingTargets",
    "evidence",
    "sourceReviewPolicy",
    "reviewPolicy"
  ]) {
    if (item[key] === undefined) {
      errors.push(`${id}: ${key} is missing`);
    }
  }

  if (!item.caseTypeAxes || typeof item.caseTypeAxes !== "object" || Array.isArray(item.caseTypeAxes)) {
    errors.push(`${id}: caseTypeAxes must be an object`);
  } else {
    const recomputedSignature = caseTypeSignature(item);
    if (item.caseTypeSignature !== recomputedSignature) {
      errors.push(`${id}: caseTypeSignature is stale or invalid`);
    }
  }

  for (const section of ["S", "O", "A", "P"]) {
    const rows = item.chart?.soap?.[section];
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push(`${id}: SOAP ${section} is missing`);
    }
  }

  const chartText = ["S", "O", "A", "P"].flatMap((section) => item.chart?.soap?.[section] || []).join("\n");
  if (chartText.length < minChartChars) {
    errors.push(`${id}: chart text is too short (${chartText.length} chars)`);
  }
  if (/E2E|テスト|抽出/.test(chartText)) {
    errors.push(`${id}: chart text contains test metadata`);
  }
  for (const message of exactClaimContextEvidenceErrors(item, chartText)) {
    errors.push(`${id}: ${message}`);
  }

  const extraction = item.expectedExtraction;
  if (!extraction) {
    errors.push(`${id}: expectedExtraction is missing`);
  } else {
    for (const key of ["requiredDiagnoses", "requiredReviewTopics", "forbiddenCandidates", "requiredBillingSignals"]) {
      if (!Array.isArray(extraction[key])) {
        errors.push(`${id}: expectedExtraction.${key} must be an array`);
      }
    }
    const forbiddenCandidates = extraction.forbiddenCandidates || [];
    const forbiddenWithConfirmed = forbiddenCandidates.filter((value) => /\bconfirmed\b/i.test(String(value)));
    if (forbiddenWithConfirmed.length) {
      errors.push(`${id}: forbiddenCandidates must not use raw confirmed status labels (${forbiddenWithConfirmed.join(", ")})`);
    }
    const signalExpectations = extraction.signalExpectations;
    if (!signalExpectations) {
      errors.push(`${id}: signalExpectations is missing`);
    } else {
      for (const key of ["literalInChart", "derivedFromContext"]) {
        if (!Array.isArray(signalExpectations[key])) {
          errors.push(`${id}: signalExpectations.${key} must be an array`);
        }
      }
      const literalImageSignals = (signalExpectations.literalInChart || [])
        .map((item) => item.label)
        .filter((label) => /ＣＴ撮影|CT撮影|単純撮影|写真診断|デジタル撮影/.test(label));
      if (literalImageSignals.length) {
        errors.push(`${id}: image-derived signals must not be literalInChart (${literalImageSignals.join(", ")})`);
      }
    }
  }

  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    errors.push(`${id}: evidence is missing`);
  }
  if (["review_required", "safety", "unsupported_expected", "split_required"].includes(item.expectedCalculation?.assertionLevel) && (item.billingTargets || []).length > 0) {
    if (!Array.isArray(item.expectedExtraction?.forbiddenCandidates) || item.expectedExtraction.forbiddenCandidates.length === 0) {
      errors.push(`${id}: ${item.expectedCalculation.assertionLevel} case with billingTargets must declare forbiddenCandidates`);
    }
  }
  if (!["master_verified", "draft", "office_reviewed", "ci_enabled"].includes(item.status)) {
    errors.push(`${id}: unsupported status ${item.status}`);
  }
  if (!["verified", "needs_office_review", "unsupported_expected", "regression_only"].includes(item.qualityLabel)) {
    errors.push(`${id}: unsupported qualityLabel ${item.qualityLabel}`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact" && item.status !== "master_verified") {
    errors.push(`${id}: exact case must use status=master_verified`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact" && item.qualityLabel !== "verified") {
    errors.push(`${id}: exact case must use qualityLabel=verified`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact") {
    if (/dpc/i.test(id) && item.expectedClaimContext?.inpatient_basic) {
      errors.push(`${id}: exact DPC-labeled case must not assert inpatient_basic fee-for-service billing`);
    }
    const collisions = forbiddenBillingCollisions(item);
    if (collisions.length) {
      errors.push(`${id}: exact case has forbiddenCandidates that collide with billed targets (${collisions.join(", ")})`);
    }
  }

  assertionCounts[item.expectedCalculation?.assertionLevel] = (assertionCounts[item.expectedCalculation?.assertionLevel] || 0) + 1;
  qualityCounts[item.qualityLabel] = (qualityCounts[item.qualityLabel] || 0) + 1;
  statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  difficultyCounts[item.difficultyLevel] = (difficultyCounts[item.difficultyLevel] || 0) + 1;
}

const charCounts = (data.cases || []).map((item) => ["S", "O", "A", "P"].flatMap((section) => item.chart?.soap?.[section] || []).join("\n").length);
caseTypeSummary = caseTypeAudit(data.cases || []);
const facilityFixtureAudit = auditFacilityFixtureAssumptions(data.cases || []);
for (const collision of facilityFixtureAudit.collisions) {
  errors.push(`facility fixture collision: ${collision}`);
}
if (caseTypeSummary.uniqueCaseTypeSignatures !== expectedCount) {
  errors.push(`caseTypeSignature unique count ${caseTypeSummary.uniqueCaseTypeSignatures} != ${expectedCount}`);
}
if (caseTypeSummary.duplicateCaseTypeSignatureGroups > 0) {
  errors.push(`caseTypeSignature duplicate groups ${caseTypeSummary.duplicateCaseTypeSignatureGroups}`);
}

const summary = {
  datasetId: data.datasetId,
  path: datasetPath,
  cases: data.cases?.length || 0,
  assertionCounts,
  qualityCounts,
  statusCounts,
  difficultyCounts,
  minChars: Math.min(...charCounts),
  avgChars: Math.round(charCounts.reduce((sum, value) => sum + value, 0) / charCounts.length),
  maxChars: Math.max(...charCounts),
  caseTypeSummary: {
    uniqueCaseTypeSignatures: caseTypeSummary.uniqueCaseTypeSignatures,
    duplicateCaseTypeSignatureGroups: caseTypeSummary.duplicateCaseTypeSignatureGroups,
    uniqueBaseSignatures: caseTypeSummary.uniqueBaseSignatures,
    duplicateBaseSignatureGroups: caseTypeSummary.duplicateBaseSignatureGroups
  },
  facilityFixtureAudit
};

const minimumAssertionCounts = {
  exact: 250,
  review_required: 300,
  safety: 50,
  unsupported_expected: 100,
  split_required: 10
};
for (const [level, minimum] of Object.entries(minimumAssertionCounts)) {
  if ((assertionCounts[level] || 0) < minimum) {
    errors.push(`assertionCounts.${level} ${assertionCounts[level] || 0} < ${minimum}`);
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors, summary }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, summary }, null, 2));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function forbiddenBillingCollisions(item) {
  const forbidden = item.expectedExtraction?.forbiddenCandidates || [];
  const targetCodes = new Set([
    ...(item.billingTargets || []).map((target) => String(target.code || "")).filter(Boolean),
    ...(item.expectedCalculation?.candidateCodes || []).map(String)
  ]);
  const targetNames = (item.billingTargets || [])
    .map((target) => normalizeLabel(target.name))
    .filter(Boolean);
  const collisions = [];
  for (const rawForbidden of forbidden) {
    const forbiddenText = normalizeLabel(rawForbidden);
    if (!forbiddenText) continue;
    const codeMatch = forbiddenText.match(/^コード(\d{6,})$/);
    if (targetCodes.has(String(rawForbidden)) || (codeMatch && targetCodes.has(codeMatch[1]))) {
      collisions.push(String(rawForbidden));
      continue;
    }
    const forbiddenLabel = forbiddenText
      .replace(/の自動確定$/u, "")
      .replace(/出来高確定$/u, "")
      .replace(/^条件未確認の/u, "")
      .replace(/の施設基準未確認$/u, "");
    if (forbiddenLabel.length >= 4 && targetNames.some((name) => name.includes(forbiddenLabel) || forbiddenLabel.includes(name))) {
      collisions.push(String(rawForbidden));
    }
  }
  return collisions;
}

function auditFacilityFixtureAssumptions(cases = []) {
  const exactRequiredKeys = new Set();
  const nonExactExplicitKeys = new Map();
  const unknownFacilityCases = [];
  for (const item of cases) {
    const level = String(item.expectedCalculation?.assertionLevel || "");
    const keys = (Array.isArray(item.expectedClaimContext?.facility_standard_keys) ? item.expectedClaimContext.facility_standard_keys : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (level === "exact") {
      for (const key of keys) exactRequiredKeys.add(key);
    } else {
      for (const key of keys) {
        if (!nonExactExplicitKeys.has(key)) nonExactExplicitKeys.set(key, []);
        nonExactExplicitKeys.get(key).push(item.caseId);
      }
      const chartText = ["S", "O", "A", "P"].flatMap((section) => item.chart?.soap?.[section] || []).join("\n");
      const reviewTopics = item.expectedExtraction?.requiredReviewTopics || [];
      if (/(施設基準|届出|届け出|地方厚生局)/u.test(chartText) || reviewTopics.some((topic) => /施設基準|届出/u.test(String(topic || "")))) {
        unknownFacilityCases.push(item.caseId);
      }
    }
  }
  const collisions = [];
  for (const key of exactRequiredKeys) {
    if (nonExactExplicitKeys.has(key)) {
      collisions.push(`${key} required by exact fixture but explicitly configured by non-exact cases ${nonExactExplicitKeys.get(key).slice(0, 8).join(",")}`);
    }
  }
  return {
    exactRequiredFacilityStandardKeys: [...exactRequiredKeys].sort(),
    facilityUnknownCaseCount: unknownFacilityCases.length,
    facilityUnknownCaseIdsSample: unknownFacilityCases.slice(0, 20),
    collisions
  };
}

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

function exactClaimContextEvidenceErrors(item, chartText) {
  if (item.expectedCalculation?.assertionLevel !== "exact") return [];
  const messages = [];
  const normalizedText = normalizeEvidenceText(chartText);
  for (const [index, order] of (item.expectedClaimContext?.imaging_orders || []).entries()) {
    const kind = normalizeLabel(order?.kind).toLowerCase();
    if (!kind) continue;
    if (!hasImagingModalityEvidence(normalizedText, kind)) {
      messages.push(`expectedClaimContext.imaging_orders[${index}].kind=${kind} is not supported by performed imaging wording in chart`);
    }
    if (order.electronic_image_management && !hasElectronicImageManagementEvidence(normalizedText)) {
      messages.push(`expectedClaimContext.imaging_orders[${index}].electronic_image_management=true lacks electronic image management wording in chart`);
    }
    if (kind === "ct" && order.ct_equipment_kind && !hasCtEquipmentEvidence(normalizedText, order.ct_equipment_kind)) {
      messages.push(`expectedClaimContext.imaging_orders[${index}].ct_equipment_kind=${order.ct_equipment_kind} lacks CT equipment-kind wording in chart`);
    }
  }

  const expectedCodes = new Set((item.expectedCalculation?.candidateCodes || []).map(String));
  if (expectedCodes.has("120002910") && !hasOutsidePrescriptionEvidence(normalizedText)) {
    messages.push("candidate code 120002910 requires outside-prescription wording in chart");
  }
  messages.push(...exactCandidateCodeEvidenceErrors(item, normalizedText, expectedCodes));
  return messages;
}

function exactCandidateCodeEvidenceErrors(item, normalizedText, expectedCodes) {
  const messages = [];
  for (const code of expectedCodes) {
    const rule = exactCodeEvidenceRule(code);
    if (!rule) continue;
    const result = rule({ item, text: normalizedText, expectedCodes });
    if (result) messages.push(`candidate code ${code} ${result}`);
  }
  return messages;
}

function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    // Review topics can contain billing labels used only as expected review language.
    // They are not evidence that the clinical service was performed.
    .replace(/当日確認した主な診療内容は「[^」]*」/gu, "")
    .replace(/当日実施と混同しやすい内容は「[^」]*」/gu, "")
    .replace(/確認すべき論点は「[^」]*」/gu, "")
    .replace(/確認論点は「[^」]*」/gu, "")
    .replace(/\s+/g, "");
}

function hasImagingModalityEvidence(text, kind) {
  switch (kind) {
    case "ct":
      return /CT撮影|CTを実施|CTで撮影|CT検査|コンピューター?断層|マルチスライスCT/u.test(text);
    case "mri":
      return /MRI撮影|MRIを実施|MRI検査|磁気共鳴/u.test(text);
    case "simple_radiography":
    case "xray":
      return /単純X線撮影|X線撮影|X線を実施|レントゲン|単純撮影/u.test(text);
    case "ultrasound":
      return /超音波検査|超音波を実施|エコー/u.test(text);
    default:
      return true;
  }
}

function hasElectronicImageManagementEvidence(text) {
  return /電子画像管理|電子的?に?保存|電子保存|電子.*管理/u.test(text);
}

function hasCtEquipmentEvidence(text, equipmentKind) {
  const kind = normalizeLabel(equipmentKind).toLowerCase();
  if (kind === "multislice_16_to_64") {
    return /16列以上64列未満|16列.*64列未満|マルチスライス型機器|マルチスライスCT/u.test(text);
  }
  if (kind === "multislice_64_or_more") {
    return /64列以上|64列.*マルチスライス/u.test(text);
  }
  return /機器区分|マルチスライス|CT撮影/u.test(text);
}

function hasOutsidePrescriptionEvidence(text) {
  return /院外処方箋|院外処方|処方箋.*交付|院外薬局/u.test(text);
}

function hasPerformedBloodCollectionEvidence(text) {
  if (/(?:静脈採血|採血)(?:を|も|は|で)?(?:実施|行(?:った|い|う)|した|あり|確認)|血液検体を採取|血清|血漿|末梢血|静脈血/u.test(text)) {
    return true;
  }
  if (/(?:採血|血液検査|血液検体).{0,12}(?:必要性|必要|検討|判断|予定|未実施|実施なし)|(?:必要性|必要|検討|判断|予定).{0,12}(?:採血|血液検査|血液検体)/u.test(text)) {
    return false;
  }
  return false;
}

function exactCodeEvidenceRule(code) {
  switch (code) {
    case "111000110":
      return ({ item }) => {
        const feeKind = item.expectedClaimContext?.outpatient_basic?.fee_kind || item.encounter?.visitType;
        return feeKind === "initial" ? "" : "requires initial-visit context";
      };
    case "112007410":
      return ({ item }) => {
        const feeKind = item.expectedClaimContext?.outpatient_basic?.fee_kind || item.encounter?.visitType;
        return feeKind === "revisit" ? "" : "requires revisit context";
      };
    case "111000370":
    case "112000970":
      return ({ item }) => (Number(item.patient?.age) < 6 ? "" : "requires infant age context");
    case "190117710":
      return ({ item, text }) => {
        if (!item.expectedClaimContext?.inpatient_basic) return "requires expectedClaimContext.inpatient_basic";
        if (!/急性期一般入院料\s*1|急性期一般入院料1|急性期一般入院料１/u.test(text)) {
          return "requires acute general inpatient fee wording in chart";
        }
        if (!/入院初日から\s*\d+日分|入院初日から\s*[０-９]+日分|\d+日分|[０-９]+日分|入院\d+日目|入院[０-９]+日目|入院日数/u.test(text)) {
          return "requires inpatient day-count wording in chart";
        }
        if (/DPC対象|診断群分類|包括評価/u.test(text) && !/DPC対象ではない|DPC対象外|出来高入院料|DPCレビューとは分け/u.test(text)) {
          return "must not assert fee-for-service inpatient basic fee in positive DPC context";
        }
        return "";
      };
    case "160169450":
      return ({ text }) => (/インフルエンザ.*抗原|インフル.*迅速|インフル.*検査/u.test(text) ? "" : "requires influenza rapid antigen evidence");
    case "160044110":
      return ({ text }) => (/(A群|Ａ群)?.*溶連菌.*迅速|溶連菌.*検査/u.test(text) ? "" : "requires group A strep rapid test evidence");
    case "160230050":
      return ({ text }) => (/(SARS|COVID|コロナ|CoV|ＣｏＶ).*(インフル|Influenza).*同時|同時.*(SARS|COVID|コロナ|CoV|ＣｏＶ).*(インフル|Influenza)/iu.test(text) ? "" : "requires SARS-CoV-2 and influenza simultaneous antigen evidence");
    case "160054710":
      return ({ text }) => (/CRP|ＣＲＰ|C反応性蛋白|Ｃ反応性蛋白/u.test(text) ? "" : "requires CRP evidence");
    case "160008010":
      return ({ text }) => (/末梢血液一般|血算|CBC|白血球|赤血球|血小板/u.test(text) ? "" : "requires peripheral blood/CBC evidence");
    case "160000310":
      return ({ text }) => (/尿一般|尿検査|尿定性/u.test(text) ? "" : "requires urinalysis evidence");
    case "160000410":
      return ({ text }) => (/尿蛋白|蛋白尿|尿.*蛋白/u.test(text) ? "" : "requires urine protein evidence");
    case "160095710":
      return ({ text }) => (hasPerformedBloodCollectionEvidence(text) ? "" : "requires performed blood collection evidence, not only blood-collection consideration");
    case "170011810":
      return ({ text }) => {
        if (!hasImagingModalityEvidence(text, "ct")) return "requires performed CT wording in chart";
        if (!hasCtEquipmentEvidence(text, "multislice_16_to_64")) return "requires 16-to-64 multislice CT equipment wording";
        return "";
      };
    case "170028810":
      return ({ text }) => (hasElectronicImageManagementEvidence(text) ? "" : "requires electronic image management wording");
    case "170012070":
      return ({ text }) => (/造影剤|造影CT|造影ＣＴ|造影.*使用/u.test(text) ? "" : "requires contrast-use evidence");
    case "170000410":
      return ({ text }) => (/写真診断|単純撮影.*診断|画像診断/u.test(text) ? "" : "requires simple radiography diagnosis wording");
    case "170027910":
      return ({ text }) => (/デジタル撮影|デジタル.*X線|デジタル.*Ｘ線/u.test(text) ? "" : "requires digital radiography wording");
    case "140032010":
      return ({ text }) => {
        if (!/熱傷|やけど|火傷/u.test(text)) return "requires burn-treatment evidence";
        if (!/100cm2未満|100cm²未満|１００cm2未満|１００cm²未満|100平方センチ未満|4×6cm|4x6cm|4×5cm|4x5cm/u.test(text)) {
          return "requires burn area wording supporting under 100cm2";
        }
        return "";
      };
    case "140032110":
      return ({ text }) => {
        if (!/熱傷|やけど|火傷/u.test(text)) return "requires burn-treatment evidence";
        if (!/100cm2以上|100cm²以上|１００cm2以上|１００cm²以上|100平方センチ以上|150cm2|150cm²|１５０cm2|１５０cm²/u.test(text)) {
          return "requires burn area wording supporting 100cm2 or more";
        }
        return "";
      };
    case "140000610":
      return ({ text }) => {
        if (!/創傷|創部|傷|切創|擦過創/u.test(text)) return "requires wound-treatment evidence";
        if (!/100cm2未満|100cm²未満|１００cm2未満|１００cm²未満|100平方センチ未満|小範囲/u.test(text)) {
          return "requires wound area wording supporting under 100cm2";
        }
        return "";
      };
    case "140000710":
      return ({ text }) => {
        if (!/創傷|創部|傷|切創|擦過創/u.test(text)) return "requires wound-treatment evidence";
        if (!/100cm2以上|100cm²以上|１００cm2以上|１００cm²以上|100平方センチ以上/u.test(text)) {
          return "requires wound area wording supporting 100cm2 or more";
        }
        return "";
      };
    case "620008991":
      return ({ text }) => (/ゲーベン|スルファジアジン銀/u.test(text) ? "" : "requires Geben cream/drug evidence");
    case "120001010":
      return ({ text }) => (/外用薬|外用|塗布|軟膏|クリーム/u.test(text) ? "" : "requires topical medication dispensing evidence");
    case "120001210":
      return ({ text }) => (/処方|院内.*処方|投薬/u.test(text) ? "" : "requires prescription fee evidence");
    case "120004270":
      return ({ text }) => (/一般名処方|一般名で処方/u.test(text) ? "" : "requires generic-name prescription evidence");
    default:
      return null;
  }
}
