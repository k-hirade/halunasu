import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNonOutpatientHoldoutBlueprints,
  generateHoldoutTexts,
  requiredFeeMasterCodesForHoldoutGeneration,
  validateNonOutpatientBlueprintDataset
} from "./fee-specialty-holdout-generation.mjs";

const masterRecords = Object.fromEntries(
  requiredFeeMasterCodesForHoldoutGeneration().map((code) => [
    code,
    { code, name: `master-${code}`, table: "medical_procedures" }
  ])
);

test("blueprint generator produces 8 specialties x 3 settings x 2 cases", () => {
  const document = buildNonOutpatientHoldoutBlueprints({
    masterRecords,
    casesPerCell: 2
  });
  assert.equal(document.blueprints.length, 48);
  const validation = validateNonOutpatientBlueprintDataset({
    document,
    masterRecords
  });
  assert.equal(validation.ok, true);
});

test("home visit same-building code and count are contract-bound", () => {
  const document = buildNonOutpatientHoldoutBlueprints({ masterRecords });
  const sameBuilding = document.blueprints.find((item) => (
    item.encounterSetting === "home_visit"
    && item.expectedClaimContext.encounterDetails.sameBuilding
  ));
  assert.deepEqual(
    sameBuilding.billingTargets.map((item) => item.code),
    ["114030310"]
  );
  assert.equal(
    sameBuilding.expectedClaimContext.encounterDetails.singleBuildingPatientCount,
    4
  );
});

test("house call includes one outpatient base fee and the house-call fee", () => {
  const document = buildNonOutpatientHoldoutBlueprints({ masterRecords });
  for (const item of document.blueprints.filter((entry) => entry.encounterSetting === "house_call")) {
    const codes = item.billingTargets.map((target) => target.code);
    assert.equal(codes.includes("114000110"), true);
    assert.equal(codes.filter((code) => ["111000110", "112007410"].includes(code)).length, 1);
  }
});

test("telephone blueprint rejects physical procedures and allows a prescription fee", () => {
  const document = buildNonOutpatientHoldoutBlueprints({ masterRecords });
  const telephone = structuredClone(
    document.blueprints.find((item) => item.encounterSetting === "telephone")
  );
  telephone.billingTargets.push({ code: "160095710", name: "採血" });
  const result = validateNonOutpatientBlueprintDataset({
    document: { blueprints: [telephone] },
    masterRecords: {
      ...masterRecords,
      "160095710": { code: "160095710", name: "採血", table: "medical_procedures" }
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /physical\/test/u);
});

test("generated source is prepare-compatible and retries an invalid first response", async () => {
  const blueprints = buildNonOutpatientHoldoutBlueprints({
    masterRecords,
    casesPerCell: 1
  });
  let calls = 0;
  const document = await generateHoldoutTexts({
    blueprintDocument: {
      ...blueprints,
      blueprints: [blueprints.blueprints[0]]
    },
    model: "test-model",
    modelRevision: "immutable-test-revision",
    generator: async ({ blueprint }) => {
      calls += 1;
      if (calls === 1) return { clinicalText: "too short" };
      return {
        clinicalText: [
          "S）定期診療のため患者宅へ訪問。体調変化はない。",
          "O）本日、患者宅へ訪問し定期訪問診療を実施。全身状態は安定している。",
          `A）${blueprint.specialtyLabel}領域の慢性疾患は安定している。`,
          "P）現在の療養方針を継続し、変化時の連絡方法を本人と家族へ説明した。次回も定期訪問予定。"
        ].join("\n"),
        responseId: "resp_test"
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].encounter.setting, "home_visit");
  assert.equal(document.cases[0].generationProvenance.modelRevision, "immutable-test-revision");
});

test("generated source accepts full-width SOAP colons at section starts", async () => {
  const blueprints = buildNonOutpatientHoldoutBlueprints({
    masterRecords,
    casesPerCell: 1
  });
  const document = await generateHoldoutTexts({
    blueprintDocument: {
      ...blueprints,
      blueprints: [blueprints.blueprints[0]]
    },
    model: "test-model",
    modelRevision: "immutable-test-revision",
    generator: async ({ blueprint }) => ({
      clinicalText: [
        "S：定期診療のため患者宅へ訪問。本人から体調変化はないと聴取した。",
        "O：本日、患者宅へ訪問し定期訪問診療を実施。全身状態は安定している。",
        `A：${blueprint.specialtyLabel}領域の慢性疾患は安定している。`,
        "P：現在の療養方針を継続し、変化時の連絡方法を本人と家族へ説明した。次回も定期訪問予定。"
      ].join("\n")
    })
  });

  assert.equal(document.cases.length, 1);
});

test("text generation refuses mutable provenance without modelRevision", async () => {
  const blueprints = buildNonOutpatientHoldoutBlueprints({
    masterRecords,
    casesPerCell: 1
  });
  await assert.rejects(() => generateHoldoutTexts({
    blueprintDocument: blueprints,
    model: "test-model",
    modelRevision: "",
    generator: async () => ({ clinicalText: "" })
  }), /modelRevision/u);
});
