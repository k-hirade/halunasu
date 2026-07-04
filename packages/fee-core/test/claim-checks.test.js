import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMissingBillingFindings,
  buildMissingBillingReviewIssues,
  buildIndicationFindings,
  claimCheckLookupCodes,
  findingToReviewIssue
} from "../src/index.js";

test("MI-002 検査判断料もれ: 実施検査グループに判断料が無ければ指摘", () => {
  const findings = buildMissingBillingFindings({
    isInpatient: false,
    items: [
      { code: "160008010", name: "末梢血液一般", judgementKind: "1", judgementGroup: "2" },
      { code: "111000110", name: "初診料", orderType: "basic" }
    ]
  });
  const mi002 = findings.filter((f) => f.ruleId === "MI-002");
  assert.equal(mi002.length, 1);
  assert.equal(mi002[0].target, "血液学的検査判断料");
  assert.equal(mi002[0].severity, "info");
});

test("MI-002: 判断料が算定済み(区分2/名称)なら指摘しない", () => {
  const byKind = buildMissingBillingFindings({
    items: [
      { code: "160008010", name: "末梢血液一般", judgementKind: "1", judgementGroup: "2" },
      { code: "160018710", name: "血液学的検査判断料", judgementKind: "2", judgementGroup: "2" }
    ]
  });
  assert.equal(byKind.filter((f) => f.ruleId === "MI-002").length, 0);

  const byName = buildMissingBillingFindings({
    items: [
      { code: "160008010", name: "末梢血液一般", judgementKind: "1", judgementGroup: "2" },
      { code: "160018710", name: "血液学的検査判断料" }
    ]
  });
  assert.equal(byName.filter((f) => f.ruleId === "MI-002").length, 0);
});

test("MI-002: 尿一般(D000)のみは尿・糞便等検査判断料を指摘しない", () => {
  const only = buildMissingBillingFindings({
    items: [{ code: "160000310", name: "尿中一般物質定性半定量検査", judgementKind: "1", judgementGroup: "1" }]
  });
  assert.equal(only.filter((f) => f.ruleId === "MI-002").length, 0);

  const withOther = buildMissingBillingFindings({
    items: [
      { code: "160000310", name: "尿中一般", judgementKind: "1", judgementGroup: "1" },
      { code: "160000510", name: "尿沈渣", judgementKind: "1", judgementGroup: "1" }
    ]
  });
  assert.equal(withOther.filter((f) => f.ruleId === "MI-002").length, 1);
});

test("MI-003 基本診療料なし: 外来で基本料が無ければ警告、入院は対象外", () => {
  const outpatient = buildMissingBillingFindings({
    isInpatient: false,
    items: [{ code: "620000001", name: "アムロジピン", orderType: "drug" }]
  });
  assert.equal(outpatient.filter((f) => f.ruleId === "MI-003").length, 1);

  const withBase = buildMissingBillingFindings({
    isInpatient: false,
    items: [{ code: "111000110", name: "初診料", orderType: "basic" }]
  });
  assert.equal(withBase.filter((f) => f.ruleId === "MI-003").length, 0);

  const inpatient = buildMissingBillingFindings({
    isInpatient: true,
    items: [{ code: "620000001", name: "アムロジピン", orderType: "drug" }]
  });
  assert.equal(inpatient.filter((f) => f.ruleId === "MI-003").length, 0);
});

test("MI-004 処方料もれ: 投薬あり・処方料なしで指摘、処方料ありなら指摘しない", () => {
  const missing = buildMissingBillingFindings({
    isInpatient: false,
    items: [
      { code: "111000110", name: "初診料", orderType: "basic" },
      { code: "620000001", name: "アムロジピン", orderType: "drug" }
    ]
  });
  assert.equal(missing.filter((f) => f.ruleId === "MI-004").length, 1);

  const present = buildMissingBillingFindings({
    isInpatient: false,
    items: [
      { code: "620000001", name: "アムロジピン", orderType: "drug" },
      { code: "120002910", name: "処方料", orderType: "procedure" }
    ]
  });
  assert.equal(present.filter((f) => f.ruleId === "MI-004").length, 0);
});

test("IY-001 医薬品適応: 適応病名なしを検出、公的データ無い薬は指摘しない", () => {
  const claim = {
    sex: "1", ageYears: 60,
    items: [{ code: "600", name: "アムロジピン", orderType: "drug" }, { code: "999", name: "適応データ無い薬", orderType: "drug" }],
    diseases: [{ code: "X", name: "無関係病名" }]
  };
  const lookup = { drugIndications: { "600": [{ diseaseCode: "A", sex: "1", ageMin: 0, ageMax: 999 }] }, diseaseNames: { A: "高血圧症" } };
  const findings = buildIndicationFindings(claim, lookup);
  const iy001 = findings.filter((f) => f.ruleId === "IY-001");
  assert.equal(iy001.length, 1);
  assert.equal(iy001[0].code, "600"); // 999は公的データ無し→指摘しない
  assert.ok(iy001[0].detail.includes("高血圧症"));
});

test("IY-001: 適応病名が疑いのみならINFO、確定病名ありなら指摘しない", () => {
  const lookup = { drugIndications: { "600": [{ diseaseCode: "A", sex: "", ageMin: 0, ageMax: 999 }] } };
  const suspectedOnly = buildIndicationFindings(
    { items: [{ code: "600", name: "薬", orderType: "drug" }], diseases: [{ code: "A", name: "高血圧の疑い", suspected: true }] },
    lookup
  );
  const info = suspectedOnly.filter((f) => f.ruleId === "IY-001");
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, "info");

  const confirmed = buildIndicationFindings(
    { items: [{ code: "600", name: "薬", orderType: "drug" }], diseases: [{ code: "A", name: "高血圧症", suspected: false }] },
    lookup
  );
  assert.equal(confirmed.filter((f) => f.ruleId === "IY-001").length, 0);
});

test("IY-003 禁忌傷病名 / IY-004 併用禁忌を検出", () => {
  const contra = buildIndicationFindings(
    { items: [{ code: "600", name: "薬", orderType: "drug" }], diseases: [{ code: "Z", name: "妊娠" }] },
    { drugContraDiseases: { "600": ["Z"] }, diseaseNames: { Z: "妊娠" } }
  );
  const iy003 = contra.filter((f) => f.ruleId === "IY-003");
  assert.equal(iy003.length, 1);
  assert.equal(iy003[0].severity, "error");

  const inter = buildIndicationFindings(
    { items: [{ code: "600", name: "薬A", orderType: "drug" }, { code: "601", name: "薬B", orderType: "drug" }] },
    { drugInteractions: [["600", "601"]] }
  );
  const iy004 = inter.filter((f) => f.ruleId === "IY-004");
  assert.equal(iy004.length, 1);
  assert.ok(iy004[0].message.includes("薬A"));

  // 片方の薬しか無いclaimでは、全体lookupに載っていても指摘しない(回帰)
  const onlyOne = buildIndicationFindings(
    { items: [{ code: "600", name: "薬A", orderType: "drug" }] },
    { drugInteractions: [["600", "601"]] }
  );
  assert.equal(onlyOne.filter((f) => f.ruleId === "IY-004").length, 0);
});

test("claimCheckLookupCodes: 薬剤/診療行為/病名コードを抽出", () => {
  const codes = claimCheckLookupCodes({
    items: [{ code: "600", orderType: "drug" }, { code: "700", orderType: "procedure" }],
    diseases: [{ code: "A" }]
  });
  assert.deepEqual(codes.drug_codes, ["600"]);
  assert.deepEqual(codes.act_codes, ["700"]);
  assert.deepEqual(codes.disease_codes, ["A"]);
});

test("findingToReviewIssue: reviewIssue形へ変換され、severity/source/idを持つ", () => {
  const issues = buildMissingBillingReviewIssues({
    items: [
      { code: "111000110", name: "初診料", orderType: "basic" },
      { code: "160008010", name: "末梢血液一般", judgementKind: "1", judgementGroup: "2" }
    ]
  });
  assert.equal(issues.length, 1);
  const issue = issues[0];
  assert.ok(issue.reviewIssueId.startsWith("claim_check_MI-002"));
  assert.equal(issue.severity, "info");
  assert.equal(issue.source, "claim_check");
  assert.equal(issue.ruleId, "MI-002");
  assert.ok(issue.messageForStaff.includes("血液学的検査判断料"));

  // 単体変換も安定
  const direct = findingToReviewIssue({ ruleId: "MI-003", ruleName: "x", category: "算定もれ", severity: "warning", message: "m" });
  assert.equal(direct.severity, "warning");
});
