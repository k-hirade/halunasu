import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  narrowSidecarCandidateSelection,
  sidecarSelectionArtifactMetadata
} from "../src/sidecar-selection-narrowing.js";

const artifact = JSON.parse(readFileSync(new URL(
  "../src/fee-rule-data/sidecar-selection-axes-2026.generated.json",
  import.meta.url
), "utf8"));
const facilityManagementCodes = artifact.options
  .filter((option) => option.familyName === "施医総管")
  .map((option) => option.code);
const yamamotoContext = {
  facilityStandardKeys: ["3055", "3057"],
  singleBuildingPatientCount: 6,
  currentMonthEncounterCount: 4,
  setting: "home_visit",
  specialDiseaseStatus: "unknown"
};

test("selection artifact narrows 175 facility-management variants to two disease choices", () => {
  const result = narrowSidecarCandidateSelection({
    requiresSelection: true,
    codeCandidates: facilityManagementCodes
  }, yamamotoContext);

  assert.equal(facilityManagementCodes.length, 175);
  assert.equal(result.selectionResolution, "ambiguous");
  assert.deepEqual(
    result.appliedFilters.map((filter) => [filter.label, filter.evidenceLabel]),
    [
      ["施設類型", "機能強化型在支診等・病床あり"],
      ["単一建物人数", "単一建物6名"],
      ["当月訪問回数", "当月4回訪問"],
      ["診療方法", "対面診療"]
    ]
  );
  assert.equal(result.remainingOptionCount, 2);
  assert.deepEqual(result.unresolvedAxes, ["specialDisease"]);
  assert.deepEqual(result.pointRange, { min: 1685, max: 3225 });
  assert.deepEqual(
    result.remainingOptions.map((option) => [option.code, option.points]),
    [["114035610", 3225], ["114035910", 1685]]
  );
  assert.match(result.remainingOptions[0].axisQuestion, /疾病/u);
});

test("an exact disease axis resolves one code without declaring billing eligibility", () => {
  const result = narrowSidecarCandidateSelection({
    requiresSelection: true,
    codeCandidates: facilityManagementCodes
  }, {
    ...yamamotoContext,
    specialDiseaseStatus: "eligible"
  });

  assert.equal(result.selectionResolution, "exact");
  assert.equal(result.remainingOptionCount, 1);
  assert.equal(result.remainingOptions[0].code, "114035610");
  assert.equal(Object.hasOwn(result, "billingEligibility"), false);
});

test("incomplete artifact coverage fails closed", () => {
  const result = narrowSidecarCandidateSelection({
    requiresSelection: true,
    codeCandidates: [facilityManagementCodes[0], "999999999"]
  }, yamamotoContext);

  assert.equal(result.selectionResolution, "insufficient");
  assert.equal(result.reason, "selection_artifact_incomplete");
  assert.deepEqual(result.remainingOptions, []);
});

test("structured evidence conflicting with the candidate set fails closed", () => {
  const result = narrowSidecarCandidateSelection({
    requiresSelection: true,
    codeCandidates: ["114035510"]
  }, yamamotoContext);

  assert.equal(result.selectionResolution, "insufficient");
  assert.equal(result.reason, "selection_context_conflict");
  assert.equal(result.conflict.axis, "patientCount");
  assert.deepEqual(result.remainingOptions, []);
});

test("selection artifact exposes version and source checksums", () => {
  const metadata = sidecarSelectionArtifactMetadata();
  assert.equal(metadata.schemaVersion, "fee-sidecar-selection-axes-v1");
  for (const field of [
    "artifactPayloadSha256", "sourceDefinitionSha256", "procedureChecksum", "frequencyChecksum"
  ]) {
    assert.match(metadata[field], /^[a-f0-9]{64}$/u);
  }
});
