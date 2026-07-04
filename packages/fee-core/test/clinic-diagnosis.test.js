import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClinicDiagnosisReport,
  clinicDiagnosisReportToHtml,
  clinicDiagnosisReportToCsv
} from "../src/index.js";

const claims = [
  {
    patientKey: "AB",
    claimMonth: "2026-09",
    sex: "1",
    ageYears: 68,
    isInpatient: false,
    items: [
      { code: "111000110", name: "初診料", orderType: "basic" },
      { code: "160008010", name: "末梢血液一般", recType: "SI" }, // 判断料もれ対象(metaで判断区分付与)
      { code: "620000600", name: "アムロジピン", recType: "IY" }  // 適応なし対象
    ],
    diseases: [{ code: "9999999", name: "無関係病名", suspected: false }]
  }
];

const lookup = {
  drugIndications: { "620000600": [{ diseaseCode: "8830592", sex: "1", ageMin: 0, ageMax: 999 }] },
  drugContraDiseases: {},
  drugInteractions: [],
  actIndications: {},
  diseaseNames: { "8830592": "高血圧症" }
};
const procedureMeta = { "160008010": { judgementKind: "1", judgementGroup: "2", name: "末梢血液一般" } };

test("buildClinicDiagnosisReport: 算定もれ(判断料)＋査定リスク(適応なし)を集約", () => {
  const report = buildClinicDiagnosisReport(claims, { lookup, procedureMeta });

  assert.equal(report.summary.claimCount, 1);
  assert.equal(report.summary.patientCount, 1);
  assert.deepEqual(report.summary.months, ["2026-09"]);
  // 判断料もれ(MI-002) が算定もれとして出る
  assert.ok(report.summary.billingMissCount >= 1);
  assert.ok(report.findings.some((f) => f.ruleId === "MI-002"));
  // 適応なし(IY-001) が査定リスクとして出る
  assert.ok(report.summary.assessmentRiskCount >= 1);
  const iy = report.findings.find((f) => f.ruleId === "IY-001");
  assert.ok(iy);
  assert.ok(iy.detail.includes("高血圧症")); // 候補病名が名称化されている
  // byRule 集計
  assert.ok(report.byRule.some((r) => r.ruleId === "MI-002"));
});

test("HTML/CSV 出力に指摘とサマリが含まれる", () => {
  const report = buildClinicDiagnosisReport(claims, { lookup, procedureMeta });
  const html = clinicDiagnosisReportToHtml(report, { title: "売上改善診断レポート", subtitle: "西山病院(匿名)" });
  assert.ok(html.includes("売上改善診断レポート"));
  assert.ok(html.includes("算定もれ候補"));
  assert.ok(html.includes("査定・返戻リスク"));
  assert.ok(html.includes("按分なし")); // 誠実表現の注記

  const csv = clinicDiagnosisReportToCsv(report);
  assert.ok(csv.split("\n")[0].includes("患者"));
  assert.ok(csv.includes("MI-002") || csv.includes("検体検査判断料"));
});

test("空claimでも安全に空レポートを返す", () => {
  const report = buildClinicDiagnosisReport([], {});
  assert.equal(report.summary.claimCount, 0);
  assert.equal(report.findings.length, 0);
  assert.ok(clinicDiagnosisReportToHtml(report).includes("指摘はありません"));
});
