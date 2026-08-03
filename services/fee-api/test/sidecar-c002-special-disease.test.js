import assert from "node:assert/strict";
import { test } from "node:test";

import {
  c002SpecialDiseaseArtifactMetadata,
  resolveC002SpecialDiseaseStatus
} from "../src/sidecar-c002-special-disease.js";

const COMPLETE = {
  problemsCompleteness: "complete",
  stateCompleteness: "complete",
  serviceDate: "2026-07-25"
};

test("R8 artifact contains the complete 348-disease notice list", () => {
  const metadata = c002SpecialDiseaseArtifactMetadata();
  assert.equal(metadata.schemaVersion, "fee-c002-special-disease-v1");
  assert.equal(metadata.designatedDiseaseCount, 348);
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.match(metadata.sourceDefinitionSha256, /^[a-f0-9]{64}$/u);
});

test("resolves direct, designated-disease, and managed-state positive evidence", () => {
  const cases = [
    { problems: [activeProblem("膵臓癌 末期（多発肝転移）")], expected: "terminal_malignant_neoplasm" },
    { problems: [activeProblem("筋萎縮性側索硬化症（ALS）")], expected: "designated_disease_2" },
    { problems: [activeProblem("進行性核上性麻痺")], expected: "designated_disease_5" },
    { problems: [activeProblem("パーキンソン病（ヤール分類IV度）")], expected: "designated_disease_6" },
    { problems: [activeProblem("多発性硬化症")], expected: "designated_disease_13" },
    { devices: [{ type: "oxygen_concentrator" }], expected: "home_oxygen" },
    { devices: [{ type: "urinary_indwelling_catheter" }], expected: "drain_or_indwelling_catheter" },
    { devices: [{ type: "tracheostomy_cannula" }], expected: "tracheostomy" }
  ];
  for (const input of cases) {
    const result = resolveC002SpecialDiseaseStatus({ ...COMPLETE, ...input });
    assert.equal(result.value, "eligible");
    assert.equal(result.status, "known");
    assert.equal(result.evidence.some((entry) => entry.ruleId === input.expected), true);
  }
});

test("does not match a designated-disease term embedded in a different diagnosis", () => {
  const result = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problems: [activeProblem("薬剤性パーキンソン病")]
  });
  assert.equal(result.value, "not_eligible");
  assert.equal(result.evidence.length, 0);
});

test("does not use clearly non-current state text as positive evidence", () => {
  for (const stateText of [
    "在宅酸素療法を中止",
    "在宅血液透析は終了",
    "留置カテーテル抜去",
    "在宅人工呼吸から離脱",
    "CAPD導入を検討",
    "気管切開を予定",
    "在宅自己導尿は未実施",
    "人工肛門なし"
  ]) {
    const result = resolveC002SpecialDiseaseStatus({ ...COMPLETE, stateTexts: [stateText] });
    assert.equal(result.value, "not_eligible", stateText);
    assert.equal(result.evidence.length, 0, stateText);
  }
});

test("keeps current-state evidence when non-current words describe an attribute or replacement", () => {
  for (const stateText of [
    "気管カニューレ（カフなし）を使用中",
    "留置カテーテル交換予定"
  ]) {
    const result = resolveC002SpecialDiseaseStatus({ ...COMPLETE, stateTexts: [stateText] });
    assert.equal(result.value, "eligible", stateText);
  }
});

test("matches compound managed-state conditions across separate problem and state rows", () => {
  const result = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problems: [activeProblem("肺高血圧症")],
    stateTexts: ["PGI2製剤を持続投与中"]
  });
  assert.equal(result.value, "eligible");
  assert.equal(
    result.evidence.some((entry) => entry.ruleId === "pulmonary_hypertension_pgi2"),
    true
  );
});

test("returns not eligible only when both disease and state sources are complete", () => {
  const complete = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problems: [activeProblem("高血圧症"), activeProblem("慢性心不全")],
    devices: []
  });
  assert.equal(complete.value, "not_eligible");
  assert.equal(complete.status, "known");

  const incomplete = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problemsCompleteness: "incomplete",
    problems: [activeProblem("高血圧症")],
    devices: []
  });
  assert.equal(incomplete.value, "unknown");
  assert.equal(incomplete.status, "unknown");
});

test("does not use suspected or inactive diagnoses as positive evidence or a negative proof", () => {
  const result = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problems: [
      { ...activeProblem("多発性硬化症疑い"), suspected: true },
      { ...activeProblem("筋萎縮性側索硬化症"), activeStatus: "inactive" }
    ]
  });
  assert.equal(result.value, "unknown");
  assert.equal(result.completeness.problems, "incomplete");
});

test("does not use a diagnosis that starts after the service date", () => {
  const result = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    problems: [
      activeProblem("高血圧症"),
      { ...activeProblem("筋萎縮性側索硬化症"), startDate: "2026-08-01" }
    ]
  });
  assert.equal(result.value, "unknown");
  assert.equal(result.status, "unknown");
  assert.equal(result.completeness.problems, "incomplete");
  assert.equal(result.evidence.length, 0);
});

test("fails closed outside the C002 artifact effective period", () => {
  const result = resolveC002SpecialDiseaseStatus({
    ...COMPLETE,
    serviceDate: "2025-01-25",
    problems: [activeProblem("筋萎縮性側索硬化症")]
  });
  assert.equal(result.value, "unknown");
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "c002_artifact_not_effective_on_service_date");
  assert.equal(result.evidence.length, 0);
});

function activeProblem(name) {
  return {
    name,
    activeStatus: "active",
    suspected: false,
    startDate: "2020-01-01"
  };
}
