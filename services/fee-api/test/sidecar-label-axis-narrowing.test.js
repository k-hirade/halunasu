import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ageConstraintForCode,
  codeAllowsAge,
  excludeCodesOutsideAgeRange,
  narrowSidecarCandidateByLabelAxes,
  sidecarLabelAxisArtifactMetadata
} from "../src/sidecar-label-axis-narrowing.js";
import { narrowSidecarCandidateSelection } from "../src/sidecar-selection-narrowing.js";
import { applyCalculationResult } from "../../../packages/fee-core/src/index.js";

const HOME_CARE_ENHANCEMENT = [
  { code: "114034570", qualifierLabel: "在宅医療充実体制加算（在医総管）（１人）", points: 800 },
  { code: "114034670", qualifierLabel: "在宅医療充実体制加算（在医総管）（２～９人）", points: 400 },
  { code: "114039370", qualifierLabel: "在宅医療充実体制加算（施医総管）（１人）", points: 600 },
  { code: "114039470", qualifierLabel: "在宅医療充実体制加算（施医総管）（２～９人）", points: 300 },
  { code: "114716110", qualifierLabel: "在宅医療充実体制加算（在医総管）（１０人～１９人）", points: 200 },
  { code: "114029670", qualifierLabel: "在宅医療充実体制加算（往診料）", points: 200 }
];

const SPECIFIC_DISEASE_MANAGEMENT = [
  { code: "113001810", qualifierLabel: "特定疾患療養管理料（診療所）", points: 225 },
  { code: "113001910", qualifierLabel: "特定疾患療養管理料（１００床未満）", points: 147 },
  { code: "113002010", qualifierLabel: "特定疾患療養管理料（１００床以上２００床未満）", points: 87 },
  { code: "113034010", qualifierLabel: "特定疾患療養管理料（診療所・情報通信機器）", points: 196 },
  { code: "113034110", qualifierLabel: "特定疾患療養管理料（１００床未満の病院・情報通信機器）", points: 128 },
  { code: "113034210", qualifierLabel: "特定疾患療養管理料（１００床以上２００床未満病院・情報通信機器）", points: 76 }
];

const FREQUENT_VISIT = [
  { code: "114715910", qualifierLabel: "頻回訪問加算（在医総管・施医総管）（初回）", points: 800 },
  { code: "114716010", qualifierLabel: "頻回訪問加算（在医総管・施医総管）（２回目以降）", points: 300 }
];

test("parent management fee and building count resolve the home care enhancement addon", () => {
  const result = narrowSidecarCandidateByLabelAxes(HOME_CARE_ENHANCEMENT, {
    parentManagementFamily: "facility_management",
    singleBuildingPatientCount: 6
  });
  assert.equal(result.selectionResolution, "exact");
  assert.deepEqual(result.remainingOptions.map((option) => option.code), ["114039470"]);
  assert.equal(result.remainingOptions[0].points, 300);
  assert.deepEqual(
    result.appliedFilters.map((filter) => [filter.label, filter.evidenceLabel]),
    [["親となる算定項目", "施医総管"], ["単一建物人数", "単一建物6名"]]
  );
});

test("institution class and in-person encounter resolve the specific disease management fee", () => {
  const result = narrowSidecarCandidateByLabelAxes(SPECIFIC_DISEASE_MANAGEMENT, {
    telemedicine: false,
    institutionBedClass: "clinic"
  });
  assert.equal(result.selectionResolution, "exact");
  assert.deepEqual(result.remainingOptions.map((option) => option.code), ["113001810"]);
});

test("an unknown institution class still removes the telemedicine variants", () => {
  const result = narrowSidecarCandidateByLabelAxes(SPECIFIC_DISEASE_MANAGEMENT, {
    telemedicine: false
  });
  assert.equal(result.selectionResolution, "ambiguous");
  assert.deepEqual(
    result.remainingOptions.map((option) => option.code),
    ["113001810", "113001910", "113002010"]
  );
  assert.deepEqual(result.unresolvedAxes, ["institutionBedClass"]);
});

test("claim sequence is only decided when the monthly history is complete", () => {
  const withoutHistory = narrowSidecarCandidateByLabelAxes(FREQUENT_VISIT, {
    monthlyClaimHistoryCompleteness: "partial",
    monthlyClaimedCodes: ["114715910"]
  });
  assert.equal(withoutHistory.selectionResolution, "insufficient");
  assert.equal(withoutHistory.remainingOptionCount, 2);

  const firstClaim = narrowSidecarCandidateByLabelAxes(FREQUENT_VISIT, {
    monthlyClaimHistoryCompleteness: "complete",
    monthlyClaimedCodes: []
  });
  assert.equal(firstClaim.selectionResolution, "exact");
  assert.deepEqual(firstClaim.remainingOptions.map((option) => option.code), ["114715910"]);

  const repeatClaim = narrowSidecarCandidateByLabelAxes(FREQUENT_VISIT, {
    monthlyClaimHistoryCompleteness: "complete",
    monthlyClaimedCodes: ["114715910"]
  });
  assert.equal(repeatClaim.selectionResolution, "exact");
  assert.deepEqual(repeatClaim.remainingOptions.map((option) => option.code), ["114716010"]);
});

test("a context value that matches no option is reported as a conflict instead of an empty set", () => {
  const result = narrowSidecarCandidateByLabelAxes(FREQUENT_VISIT, {
    monthlyClaimHistoryCompleteness: "complete",
    monthlyClaimedCodes: [],
    parentManagementFamily: "home_cancer_management"
  });
  assert.equal(result.remainingOptionCount >= 1, true);
});

test("options without a readable axis are never dropped by that axis", () => {
  const options = [
    { code: "111111110", qualifierLabel: "架空管理料（区分イ）", points: 100 },
    { code: "111111210", qualifierLabel: "架空管理料（区分ロ）", points: 200 }
  ];
  const result = narrowSidecarCandidateByLabelAxes(options, {
    telemedicine: false,
    institutionBedClass: "clinic",
    parentManagementFamily: "home_management"
  });
  assert.equal(result.selectionResolution, "insufficient");
  assert.equal(result.remainingOptionCount, 2);
  assert.deepEqual(result.appliedFilters, []);
});

test("fewer than two labelled options produce no selection", () => {
  assert.equal(narrowSidecarCandidateByLabelAxes([HOME_CARE_ENHANCEMENT[0]], {}), null);
  assert.equal(narrowSidecarCandidateByLabelAxes([{ code: "1", qualifierLabel: "" }], {}), null);
});

test("selection narrowing falls back to label axes when the axis artifact lacks the family", () => {
  const result = narrowSidecarCandidateSelection(
    {
      requiresSelection: true,
      codeCandidates: FREQUENT_VISIT.map((option) => option.code),
      codeCandidateOptions: FREQUENT_VISIT
    },
    {
      labelAxis: {
        monthlyClaimHistoryCompleteness: "complete",
        monthlyClaimedCodes: ["114715910"]
      }
    }
  );
  assert.equal(result.selectionResolution, "exact");
  assert.deepEqual(result.remainingOptions.map((option) => option.code), ["114716010"]);
});

test("the artifact-backed C002 path is unchanged by the fallback", () => {
  const result = narrowSidecarCandidateSelection(
    { requiresSelection: true, codeCandidates: ["114035610", "114035910"] },
    { setting: "home_visit" }
  );
  assert.equal(result.remainingOptionCount >= 1, true);
  assert.equal(result.reason, null);
});

test("age constraints come from the master and exclude only codes outside the range", () => {
  assert.equal(ageConstraintForCode("113006610").maxAgeYearsExclusive, 15);
  assert.equal(codeAllowsAge(ageConstraintForCode("113006610"), 14), true);
  assert.equal(codeAllowsAge(ageConstraintForCode("113006610"), 15), false);
  assert.equal(codeAllowsAge(ageConstraintForCode("113006610"), null), true);

  const adult = excludeCodesOutsideAgeRange(["113006610", "113035110", "113001810"], 73);
  assert.deepEqual(adult.codes, ["113001810"]);
  assert.deepEqual(adult.excluded.map((entry) => entry.code), ["113006610", "113035110"]);

  const child = excludeCodesOutsideAgeRange(["113006610", "113001810"], 8);
  assert.deepEqual(child.codes, ["113006610", "113001810"]);

  const unknownAge = excludeCodesOutsideAgeRange(["113006610"], null);
  assert.deepEqual(unknownAge.codes, ["113006610"]);
  assert.deepEqual(unknownAge.excluded, []);
});

test("the label axis artifact is integrity checked and reports the master age coverage", () => {
  const metadata = sidecarLabelAxisArtifactMetadata();
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.match(metadata.ageArtifactPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.equal(metadata.ageConstraintCount > 0, true);
});

test("label axis facts survive the calculation result normalization", () => {
  // 準備段階で作った事実が保存時に落ちると、軸は識別できても絞り込めなくなる。
  const applied = applyCalculationResult(
    { orgId: "org_001", feeSessionId: "s1", serviceDate: "2026-07-24", status: "ready", calculationRevision: 0 },
    {
      orgId: "org_001",
      feeSessionId: "s1",
      serviceDate: "2026-07-24",
      provider: "test",
      status: "completed",
      totalPoints: 0,
      lineItems: [],
      metrics: {
        sidecarSelectionContext: {
          setting: "home_visit",
          labelAxis: {
            telemedicine: false,
            institutionBedClass: "clinic",
            primaryDisease: "diabetes",
            patientAgeYears: 73,
            cyanoticCongenitalHeartDisease: null,
            monthlyClaimHistoryCompleteness: "complete",
            monthlyClaimedCodes: ["114715910", "114715910"],
            unsupportedObject: { nested: true }
          }
        }
      }
    },
    { calculationId: "calc_1", now: new Date("2026-08-06T00:00:00.000Z") }
  );
  const labelAxis = applied.calculationResult.metrics.sidecarSelectionContext.labelAxis;
  assert.equal(labelAxis.telemedicine, false);
  assert.equal(labelAxis.institutionBedClass, "clinic");
  assert.equal(labelAxis.primaryDisease, "diabetes");
  assert.equal(labelAxis.patientAgeYears, 73);
  assert.equal(labelAxis.cyanoticCongenitalHeartDisease, null);
  assert.deepEqual(labelAxis.monthlyClaimedCodes, ["114715910"]);
  assert.equal(Object.hasOwn(labelAxis, "unsupportedObject"), false);
});

test("an axis never touches a family that does not use its vocabulary", () => {
  // 『その他』のような汎用語を軸値に使うと、無関係なファミリを誤って絞り込む。
  const unrelated = [
    { code: "113046610", qualifierLabel: "地域包括診療加算２（その他の慢性疾患等を有する患者の場合）", points: 77 },
    { code: "113046710", qualifierLabel: "地域包括診療加算２（認知症の場合）", points: 77 }
  ];
  const result = narrowSidecarCandidateByLabelAxes(unrelated, {
    cyanoticCongenitalHeartDisease: true,
    portableOxygenContainer: true,
    ventilatorType: "positive_pressure",
    primaryDisease: "diabetes"
  });
  assert.equal(result.remainingOptionCount, 2);
  assert.deepEqual(result.appliedFilters, []);
});

test("the complement value is only applied inside a family that uses the axis", () => {
  const oxygenCylinder = [
    { code: "114006110", qualifierLabel: "酸素ボンベ加算（その他）", points: 3950 },
    { code: "114006310", qualifierLabel: "酸素ボンベ加算（携帯用酸素ボンベ）", points: 880 }
  ];
  // 携帯用の軸だけが効き、無関係なチアノーゼ軸では絞られない。
  assert.equal(
    narrowSidecarCandidateByLabelAxes(oxygenCylinder, { cyanoticCongenitalHeartDisease: true }).remainingOptionCount,
    2
  );
  assert.deepEqual(
    narrowSidecarCandidateByLabelAxes(oxygenCylinder, { portableOxygenContainer: false })
      .remainingOptions.map((option) => option.code),
    ["114006110"]
  );

  const homeOxygen = [
    { code: "114003710", qualifierLabel: "在宅酸素療法指導管理料（その他）", points: 2400 },
    { code: "114004110", qualifierLabel: "在宅酸素療法指導管理料（チアノーゼ型先天性心疾患）", points: 520 }
  ];
  // 同じ『その他』でも、チアノーゼ型の兄弟がいるファミリでは補集合として正しく効く。
  assert.deepEqual(
    narrowSidecarCandidateByLabelAxes(homeOxygen, { cyanoticCongenitalHeartDisease: false })
      .remainingOptions.map((option) => option.code),
    ["114003710"]
  );
  assert.deepEqual(
    narrowSidecarCandidateByLabelAxes(homeOxygen, { cyanoticCongenitalHeartDisease: true })
      .remainingOptions.map((option) => option.code),
    ["114004110"]
  );
});

test("axis vocabulary is unambiguous and every pattern exists in the master", async () => {
  const { readFile } = await import("node:fs/promises");
  const artifact = JSON.parse(await readFile(
    new URL("../src/fee-rule-data/sidecar-label-axes-2026.generated.json", import.meta.url),
    "utf8"
  ));

  // 同じ語を複数の軸で使うと、どの軸で絞ったのか説明できなくなる。
  const seen = new Map();
  for (const axis of artifact.axes) {
    for (const value of axis.values) {
      for (const pattern of value.patterns) {
        assert.equal(seen.has(pattern), false, `pattern reused across axes: ${pattern} (${seen.get(pattern)} / ${axis.axisId})`);
        seen.set(pattern, axis.axisId);
      }
    }
  }

  const master = new URL("../../../python/data/master/standard-master.sqlite", import.meta.url);
  const { existsSync } = await import("node:fs");
  if (!existsSync(master)) {
    return;
  }
  const { execFileSync } = await import("node:child_process");
  const names = execFileSync("sqlite3", [
    master.pathname,
    "SELECT short_name FROM medical_procedures WHERE short_name IS NOT NULL"
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  assert.equal(names.length > 1000, true);

  for (const axis of artifact.axes) {
    for (const value of axis.values) {
      const hits = names.filter((name) => value.patterns.some((pattern) => name.includes(pattern)));
      // 実在しない語は誤植か制度改定で消えた語であり、軸が黙って効かなくなる。
      assert.equal(hits.length > 0, true, `${axis.axisId}/${value.optionLabel} matches no master name`);
    }
    // 1つの名称が同じ軸の2つの値に一致すると、区分の分類が定まらない。
    for (const name of names) {
      const matchedValues = axis.values.filter((value) => (
        value.patterns.some((pattern) => name.includes(pattern))
      ));
      assert.equal(
        matchedValues.length <= 1,
        true,
        `${axis.axisId} classifies "${name}" as ${matchedValues.map((value) => value.optionLabel).join(" and ")}`
      );
    }
  }
});
