import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const includeInDataset = false;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const blueprintsPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/gold-blueprints.json");
const blueprints = JSON.parse(fs.readFileSync(blueprintsPath, "utf8")).blueprints || [];
const blueprintsById = new Map(blueprints.map((item) => [item.blueprintId, item]));

const BILLING_TARGETS = new Map([
  ["111000110", ["初診料", 291]],
  ["112007410", ["再診料", 75]],
  ["120001010", ["調剤料(外用薬)", 8]],
  ["120001210", ["処方料", 42]],
  ["120002910", ["処方箋料", 60]],
  ["120004270", ["一般名処方加算", 10]],
  ["140032010", ["熱傷処置", 135]],
  ["160000310", ["尿一般", 26]],
  ["160000410", ["尿蛋白", 7]],
  ["160008010", ["血算", 21]],
  ["160044110", ["溶連菌迅速", 121]],
  ["160054710", ["CRP", 16]],
  ["160061710", ["尿・糞便等検査判断料", 34]],
  ["160061810", ["血液学的検査判断料", 125]],
  ["160062110", ["免疫学的検査判断料", 144]],
  ["160095710", ["静脈採血", 40]],
  ["160169450", ["インフル迅速", 132]],
  ["160182770", ["検体検査管理加算", 100]],
  ["160230050", ["コロナ・インフル同時抗原", 225]],
  ["170000210", ["電子画像管理加算", 57]],
  ["170000410", ["単純X線撮影", 68]],
  ["170011810", ["CT撮影", 900]],
  ["170027910", ["写真診断", 85]],
  ["170028810", ["CT電子画像管理", 120]],
  ["620008991", ["ゲーベンクリーム", 13]]
]);

function deriveDifficulty(blueprint, authored) {
  if (authored.difficultyLevel) return authored.difficultyLevel;
  if (["unsupported_expected", "split_required"].includes(blueprint.assertionLevel)) return "L3";
  if (blueprint.assertionLevel === "exact" && (blueprint.expectedCalculation?.candidateCodes || []).length <= 4) return "L1";
  return "L2";
}

function billingTargetsFromCodes(codes = []) {
  return codes
    .map((code) => {
      const mapped = BILLING_TARGETS.get(code);
      if (!mapped) return null;
      return { name: mapped[0], points: mapped[1] };
    })
    .filter(Boolean);
}

export function buildBlueprintCases(authoredCases) {
  return authoredCases.map((authored) => {
    const blueprint = blueprintsById.get(authored.blueprintId);
    if (!blueprint) {
      throw new Error(`blueprint not found: ${authored.blueprintId}`);
    }
    return {
      caseId: authored.caseId,
      caseTypeKey: blueprint.caseTypeKey,
      title: authored.title || blueprint.title,
      department: blueprint.department,
      facilityFixtureKey: blueprint.facilityFixtureKey,
      difficultyLevel: deriveDifficulty(blueprint, authored),
      patient: authored.patient || blueprint.patientProfile,
      encounter: blueprint.encounter,
      realismAxes: authored.realismAxes || [],
      distractors: authored.distractors || [],
      soap: authored.soap,
      expectedExtraction: blueprint.expectedExtraction,
      expectedClaimContext: blueprint.expectedClaimContext,
      expectedCalculation: blueprint.expectedCalculation,
      billingTargets: authored.billingTargets || billingTargetsFromCodes(blueprint.expectedCalculation?.candidateCodes)
    };
  });
}
