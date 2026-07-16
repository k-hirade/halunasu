import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dictionaryScanCandidateProposals,
  mergeDiseaseIndicationCandidateProposals
} from "../src/clinical-calculation-input.js";
import { PythonFeeCalculator } from "../src/python-calculator.js";

// 反例コーパス回帰: 実運用で見つかった「候補に出なかった/出てはいけない」ケースを、
// LLM抜きの決定論レーン(マスタ名称辞書スキャン・病名適応逆引き)で常時回帰する。
// 実マスタDBが無い環境(CI等)ではスキップする。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const masterDbPath = process.env.FEE_MASTER_DB_PATH
  || path.join(repoRoot, "python/data/master/standard-master.sqlite");
const casesPath = path.join(repoRoot, "data/tests/counterexamples/counterexample-cases.json");
const hasMasterDb = existsSync(masterDbPath);

const corpus = JSON.parse(readFileSync(casesPath, "utf8"));

test("反例コーパス: 決定論レーンで期待候補が出て、禁止候補が出ない", { skip: !hasMasterDb && "実マスタDBが無いためスキップ" }, async () => {
  const feeCalculator = new PythonFeeCalculator({
    masterDbPath,
    workerMode: false
  });
  for (const item of corpus.cases) {
    const dictionaryResult = await dictionaryScanCandidateProposals({
      feeCalculator,
      text: item.clinicalText,
      knownCodes: []
    });
    let proposals = dictionaryResult.proposals;
    if (Array.isArray(item.diagnoses) && item.diagnoses.length) {
      const diseaseLookup = await feeCalculator.diseaseActCandidates({
        diagnoses: item.diagnoses,
        setting: item.setting || "outpatient",
        patient_age: item.patientAge ?? null,
        patient_sex: item.patientSex || "",
        service_date: item.serviceDate || "2026-06-15",
        act_code_prefixes: ["113", "114"],
        limit: 12
      });
      proposals = mergeDiseaseIndicationCandidateProposals({
        existingProposals: proposals,
        lookupResult: diseaseLookup
      }).candidateProposals;
    }
    // 同一別名の複数コードは codeCandidates 付きの曖昧候補1件に統合されるため、
    // 「候補として見える」判定は code と codeCandidates の和で行う。
    const codes = proposals.flatMap((proposal) => [
      String(proposal.code || ""),
      ...(Array.isArray(proposal.codeCandidates) ? proposal.codeCandidates.map(String) : [])
    ]).filter(Boolean);
    for (const expected of item.expectedCandidateCodes || []) {
      assert.ok(
        codes.includes(String(expected)),
        `${item.caseId}: 期待候補 ${expected} が出ていない (actual: ${codes.join(",") || "(none)"})`
      );
    }
    for (const forbidden of item.forbiddenCandidateCodes || []) {
      assert.ok(
        !codes.includes(String(forbidden)),
        `${item.caseId}: 禁止候補 ${forbidden} が出ている`
      );
    }
  }
});
