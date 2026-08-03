import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { narrowSidecarCandidateSelection } from "../src/sidecar-selection-narrowing.js";
import { normalizeSidecarStructuredFacts } from "../src/sidecar-structured-facts.js";

const selectionArtifact = JSON.parse(readFileSync(new URL(
  "../src/fee-rule-data/sidecar-selection-axes-2026.generated.json",
  import.meta.url
), "utf8"));
const codesByFamily = new Map(["在医総管", "施医総管"].map((family) => [
  family,
  selectionArtifact.options.filter((option) => option.familyName === family).map((option) => option.code)
]));

const cases = [
  ["1001", "在医総管", 1, 2, ["高血圧症", "慢性心不全"], [], "114031010"],
  ["1002", "施医総管", 4, 3, ["筋萎縮性側索硬化症（ALS）"], ["ventilator"], "114035610"],
  ["1003", "在医総管", 1, 1, ["パーキンソン病（ヤール分類IV度）"], [], "114031310"],
  ["1004", "施医総管", 6, 4, ["気管切開状態"], ["tracheostomy_cannula"], "114035610"],
  ["1005", "在医総管", 1, 1, ["アルツハイマー型認知症", "2型糖尿病"], [], "114031310"],
  ["1006", "在医総管", 1, 4, ["膵臓癌 末期（多発肝転移）"], [], "114030710"],
  ["1007", "在医総管", 1, 2, ["慢性閉塞性肺疾患"], ["home_oxygen"], "114030710"],
  ["1008", "在医総管", 1, 2, ["高血圧症", "変形性膝関節症"], [], "114031010"],
  ["1009", "在医総管", 1, 2, ["骨粗鬆症", "腰部脊柱管狭窄症"], [], "114031010"],
  ["1010", "施医総管", 5, 4, ["脳血管性認知症"], ["urinary_indwelling_catheter"], "114035610"],
  ["1011", "施医総管", 6, 4, ["進行性核上性麻痺"], [], "114035610"],
  ["1012", "在医総管", 1, 2, ["慢性心不全", "心房細動"], [], "114031010"],
  ["1013", "在医総管", 1, 2, ["多発性硬化症"], [], "114030710"]
];

test("law-conformant structured context resolves all 13 mock management categories exactly", () => {
  for (const [caseId, family, patientCount, monthlyVisits, diagnosisNames, deviceTypes, expectedCode] of cases) {
    const visitDates = ["2026-07-04", "2026-07-11", "2026-07-18", "2026-07-25"]
      .slice(-monthlyVisits);
    const nonQualifyingEncounter = nonQualifyingEncounterFor(caseId);
    const historyRows = [
      ...visitDates.map((serviceDate) => ({
        serviceDate,
        encounterType: "home_visit",
        visitKind: null,
        status: "completed",
        sourceRecordId: `${caseId}-${serviceDate}`
      })),
      ...(nonQualifyingEncounter ? [nonQualifyingEncounter] : [])
    ].sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
    const calendarVisitDates = historyRows.map((row) => row.serviceDate);
    const structuredFacts = normalizeSidecarStructuredFacts({
      selectorContractVersion: "homis-mock-v6",
      serviceDate: "2026-07-25",
      privateResidence: patientCount === 1,
      sameBuilding: patientCount === 1 ? false : true,
      singleBuildingPatientCount: patientCount === 1 ? null : patientCount,
      sourceSurfaces: {
        currentChart: {
          status: "ok",
          surfaceHash: `sha256-current-${caseId}`,
          raw: {
            deviceManagementText: deviceText(deviceTypes),
            deviceManagementListCompleteness: "complete",
            calendarMonth: "2026-07",
            calendarVisitDates,
            calendarVisitListCompleteness: "complete"
          }
        },
        problems: {
          status: "ok",
          surfaceHash: `sha256-problems-${caseId}`,
          raw: {
            listCompleteness: "complete",
            rows: diagnosisNames.map((name) => ({
              name,
              startDate: "2020-01-01",
              outcome: "継続",
              suspected: false
            }))
          }
        },
        visitPlan: {
          status: "ok",
          surfaceHash: `sha256-plan-${caseId}`,
          raw: {
            calendarMonth: "2026-07",
            basis: "encounter_history",
            listCompleteness: "complete",
            rows: historyRows
          }
        }
      }
    });
    const result = narrowSidecarCandidateSelection({
      requiresSelection: true,
      codeCandidates: codesByFamily.get(family)
    }, {
      facilityStandardKeys: ["3055", "3057"],
      setting: "home_visit",
      selection: structuredFacts.selection
    });
    assert.equal(structuredFacts.selection.qualifyingMonthlyVisits.value, monthlyVisits, caseId);
    assert.equal(result.selectionResolution, "exact", caseId);
    assert.equal(result.remainingOptionCount, 1, caseId);
    assert.equal(result.remainingOptions[0].code, expectedCode, caseId);
  }
});

function deviceText(deviceTypes) {
  if (!deviceTypes.length) return "（在宅医療機器の登録なし）";
  const labels = {
    ventilator: "在宅人工呼吸器（TPPV）",
    tracheostomy_cannula: "気管切開カニューレ",
    urinary_indwelling_catheter: "膀胱留置カテーテル",
    home_oxygen: "在宅酸素療法（HOT）"
  };
  return deviceTypes.map((type) => labels[type]).join("\n");
}

function nonQualifyingEncounterFor(caseId) {
  if (caseId === "1002" || caseId === "1003") {
    return {
      serviceDate: "2026-07-02",
      encounterType: "outpatient",
      visitKind: "telephone_revisit",
      status: "completed",
      sourceRecordId: `${caseId}-telephone`
    };
  }
  if (caseId === "1012") {
    return {
      serviceDate: "2026-07-16",
      encounterType: "house_call",
      visitKind: null,
      status: "completed",
      sourceRecordId: `${caseId}-house-call`
    };
  }
  return null;
}
