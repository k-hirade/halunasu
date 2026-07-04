import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backfillClinicalFactsEvidenceFromLines,
  buildClinicalTextPreprocessing
} from "../src/clinical-calculation-input.js";

const CHART = [
  "S: 咳と発熱が3日続く。",
  "O: 末梢血液一般 WBC 9800。インフルエンザ迅速 陰性。",
  "A: 急性上気道炎。",
  "P: 次回CTを検討。"
].join("\n");

test("v12 backfill: line_idsからevidence本文とsectionを決定論復元する", () => {
  const preprocessing = buildClinicalTextPreprocessing(CHART);
  const oLine = preprocessing.lines.find((line) => String(line.section).toUpperCase() === "O");
  assert.ok(oLine, "O行が前処理で識別される");

  const facts = {
    clinical_events: [
      { name: "末梢血液一般", evidence_line_ids: [oLine.lineId] },       // v12形(evidence/section無し)
      { name: "根拠行なし", evidence_line_ids: [] },                      // 行不明 → そのまま
      { name: "既存evidence", evidence: "手書きの根拠", evidence_line_ids: [oLine.lineId] } // 旧形は上書きしない
    ],
    checklist_findings: [
      { menu_id: "m1", status: "performed_today", evidence_line_ids: [oLine.lineId], reason: "" },
      { menu_id: "m2", status: "not_in_text", evidence_line_ids: [], reason: "" }
    ]
  };

  backfillClinicalFactsEvidenceFromLines(facts, preprocessing);

  // evidence は行テキストの逐語(カルテ本文に必ず存在=下流の根拠検証が成立)
  assert.equal(facts.clinical_events[0].evidence, oLine.text.trim());
  assert.ok(CHART.includes(facts.clinical_events[0].evidence));
  assert.equal(String(facts.clinical_events[0].section).toUpperCase(), "O");
  // 行不明イベントは変更なし
  assert.equal(facts.clinical_events[1].evidence, undefined);
  // 既存evidenceは保持(旧schema/テスト互換)
  assert.equal(facts.clinical_events[2].evidence, "手書きの根拠");
  // checklist も復元、not_in_text(空line_ids)は空のまま
  assert.equal(facts.checklist_findings[0].evidence, oLine.text.trim());
  assert.equal(facts.checklist_findings[1].evidence, undefined);
});

test("v12 backfill: 前処理なし・空factsでも安全", () => {
  assert.deepEqual(backfillClinicalFactsEvidenceFromLines({}, null), {});
  const facts = { clinical_events: [{ name: "x", evidence_line_ids: ["L-001"] }] };
  backfillClinicalFactsEvidenceFromLines(facts, { lines: [] });
  assert.equal(facts.clinical_events[0].evidence, undefined);
});
