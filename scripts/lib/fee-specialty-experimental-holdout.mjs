import { createHash } from "node:crypto";

const TARGET_SPAN_RULES = Object.freeze({
  "111000110": {
    phrase: "当院初診",
    category: "outpatient_basic"
  },
  "112007410": {
    phrase: "当院再診",
    category: "outpatient_basic"
  },
  "112007950": {
    phrase: "電話等再診として治療上必要な指示",
    category: "outpatient_basic"
  },
  "114000110": {
    phrase: "患者側から臨時の求めがあり往診を実施",
    category: "management"
  },
  "114001110": {
    phrase: "定期訪問診療を実施",
    category: "management"
  },
  "114030310": {
    phrase: "定期訪問診療を実施",
    category: "management"
  },
  "120002910": {
    phrase: "院外処方箋を発行",
    category: "medication"
  }
});

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function codePoints(value) {
  return Array.from(String(value ?? ""));
}

function allUnicodeOffsets(text, phrase) {
  const source = codePoints(text);
  const target = codePoints(phrase);
  const offsets = [];
  for (let index = 0; index <= source.length - target.length; index += 1) {
    if (target.every((character, offset) => source[index + offset] === character)) {
      offsets.push(index);
    }
  }
  return offsets;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function buildMachineSpans(generatedCase) {
  const clinicalText = String(generatedCase?.chart?.standard ?? "");
  if (!clinicalText.trim()) {
    throw new Error(`${generatedCase?.caseId ?? "case"}: chart.standard is required`);
  }

  const spans = [];
  for (const target of generatedCase.billingTargets ?? []) {
    const code = String(target?.code ?? "").trim();
    const rule = TARGET_SPAN_RULES[code];
    if (!rule) {
      throw new Error(`${generatedCase.caseId}: no experimental span rule for ${code}`);
    }
    const offsets = allUnicodeOffsets(clinicalText, rule.phrase);
    if (offsets.length === 0) {
      throw new Error(
        `${generatedCase.caseId}: required span phrase ${JSON.stringify(rule.phrase)} is missing`
      );
    }
    for (const charStart of offsets) {
      spans.push({
        text: rule.phrase,
        charStart,
        charEnd: charStart + codePoints(rule.phrase).length,
        code,
        masterName: String(target.name ?? "").trim(),
        category: rule.category,
        actionStatus: "performed",
        temporalRelation: "current_visit",
        sourceOrigin: "own_clinic_record",
        providerOwnership: "own_clinic",
        standingStatus: "none"
      });
    }
  }

  return spans.sort((left, right) => (
    left.charStart - right.charStart
    || left.charEnd - right.charEnd
    || left.code.localeCompare(right.code)
  ));
}

function buildMachineCase(generatedCase, blueprint) {
  const generatorFamily = String(
    generatedCase?.generationProvenance?.generatorFamily ?? ""
  ).trim();
  if (!generatorFamily) {
    throw new Error(`${generatedCase.caseId}: generatorFamily is required`);
  }
  return {
    caseId: generatedCase.caseId,
    specialty: generatedCase.specialty,
    encounterSetting: generatedCase.encounterSetting,
    split: "holdout",
    templateId: generatedCase.caseTypeKey,
    synthetic: true,
    annotationStatus: "pending_review",
    generationProvenance: generatedCase.generationProvenance,
    holdoutProvenance: {
      source: "separate_generator",
      generatorFamily
    },
    reviewPolicy: {
      expectedSpansReviewed: false
    },
    experimentalLabelStatus: "machine_derived",
    experimentalLabelPolicy: {
      notGold: true,
      source: "billing_target_required_phrase",
      blueprintId: blueprint.blueprintId,
      blueprintSha256: generatedCase.generationProvenance?.blueprintSha256,
      ruleSetVersion: "fee-specialty-experimental-span-rules-v1"
    },
    clinicalText: generatedCase.chart.standard,
    expectedSpans: buildMachineSpans(generatedCase),
    expectedClaimContext: {
      sourceClaimContext: generatedCase.expectedClaimContext,
      expectedCodes: (generatedCase.billingTargets ?? []).map((target) => ({
        code: target.code,
        name: target.name
      })),
      notes: "機械生成blueprintの必須語句から作成した実験用ラベル。人手レビュー未実施のためgoldではない。"
    }
  };
}

export function buildExperimentalHoldoutDataset({
  canonicalDataset,
  generatedDataset,
  blueprintDataset
}) {
  assertObject(canonicalDataset, "canonicalDataset");
  assertObject(generatedDataset, "generatedDataset");
  assertObject(blueprintDataset, "blueprintDataset");

  const generatedCases = generatedDataset.cases ?? [];
  const blueprintById = new Map(
    (blueprintDataset.blueprints ?? []).map(
      (blueprint) => [blueprint.blueprintId, blueprint]
    )
  );
  const canonicalIds = new Set(
    (canonicalDataset.cases ?? []).map((caseItem) => caseItem.caseId)
  );
  const machineCases = generatedCases.map((generatedCase) => {
    if (canonicalIds.has(generatedCase.caseId)) {
      throw new Error(`duplicate caseId ${generatedCase.caseId}`);
    }
    const blueprint = blueprintById.get(generatedCase.caseId);
    if (!blueprint) {
      throw new Error(`${generatedCase.caseId}: blueprint is missing`);
    }
    if (
      generatedCase.specialty !== blueprint.specialty
      || generatedCase.encounterSetting !== blueprint.encounterSetting
    ) {
      throw new Error(`${generatedCase.caseId}: generated case does not match blueprint cell`);
    }
    return buildMachineCase(generatedCase, blueprint);
  });

  const canonicalCases = canonicalDataset.cases ?? [];
  const holdoutCases = [
    ...canonicalCases.filter(
      (caseItem) => caseItem.split === "holdout"
      && caseItem.annotationStatus === "reviewed"
    ),
    ...machineCases
  ];
  const cellCounts = new Map();
  for (const caseItem of holdoutCases) {
    const key = `${caseItem.specialty}|${caseItem.encounterSetting}`;
    cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
  }

  return {
    schemaVersion: "fee-specialty-experimental-machine-holdout-v1",
    datasetId: "fee-specialty-experimental-machine-holdout",
    status: "experimental_not_gold",
    synthetic: true,
    notGold: true,
    humanReviewSkipped: true,
    source: {
      canonicalDatasetSha256: sha256(canonicalDataset),
      generatedDatasetSha256: sha256(generatedDataset),
      blueprintDatasetSha256: sha256(blueprintDataset)
    },
    coverage: {
      totalCaseCount: canonicalCases.length + machineCases.length,
      caseCount: holdoutCases.length,
      humanReviewedCaseCount: holdoutCases.filter(
        (caseItem) => caseItem.annotationStatus === "reviewed"
      ).length,
      machineLabeledCaseCount: machineCases.length,
      cellCount: cellCounts.size,
      completeCellCount: [...cellCounts.values()].filter((count) => count >= 2).length,
      minimumCasesPerCell: 2
    },
    cases: [...canonicalCases, ...machineCases]
  };
}
