import assert from "node:assert/strict";
import { test } from "node:test";
import { convertClinicalCalculationEvents } from "../src/clinical-calculation-input.js";

// 原則候補化(emit-as-candidate-by-default)の検証:
// 医学管理・文書料や review-only 領域(在宅等)のイベントも、マスタ照合できたものは
// 点数付きの candidateProposal として提示される。確定明細(procedure_codes)には入らない。

const MASTER_ITEMS = [
  { code: "180000710", name: "傷病手当金意見書交付料", points: 100, kind: "procedure" },
  { code: "113004310", name: "療養費同意書交付料", points: 100, kind: "procedure" },
  { code: "114001110", name: "在宅患者訪問診療料（１）１（同一建物居住者以外）", points: 890, kind: "procedure" }
];

function mockFeeCalculator() {
  return {
    async searchMaster({ query }) {
      const items = MASTER_ITEMS.filter((item) => item.name.includes(String(query || "").slice(0, 6)));
      return { items };
    }
  };
}

function managementEvent(overrides = {}) {
  return {
    clinicalEventId: "ev_doc_1",
    type: "management",
    name: "傷病手当金意見書の交付",
    action_status: "performed",
    temporal_relation: "current",
    provider_ownership: "own",
    evidence: "傷病手当金意見書を作成・交付。",
    search_queries: ["傷病手当金意見書交付料"],
    // L1(事実認定)を通過した検証済みイベントだけが候補化の対象になる
    canonical_fact_status: "eligible_for_master_search",
    evidenceVerificationStatus: "verified",
    ...overrides
  };
}

test("医学管理・文書系イベントはマスタ照合され点数付き候補になる(確定には入らない)", async () => {
  const result = await convertClinicalCalculationEvents({
    clinicalEvents: [managementEvent()],
    feeCalculator: mockFeeCalculator()
  });

  const proposal = result.candidateProposals.find((item) => item.code === "180000710");
  assert.ok(proposal, "傷病手当金意見書交付料が候補として提示される");
  assert.equal(proposal.potentialPoints, 100);
  assert.equal(proposal.basis, "master_link_candidate");
  assert.ok(proposal.evidence.includes("傷病手当金意見書"));
  assert.deepEqual(result.procedureCodes, [], "確定明細のprocedure_codesには入れない");
});

test("review-only領域(在宅)のイベントも候補生成される(自動確定の禁止に格下げ)", async () => {
  const result = await convertClinicalCalculationEvents({
    clinicalEvents: [{
      clinicalEventId: "ev_home_1",
      type: "procedure",
      billing_domain: "home_care",
      name: "訪問診療",
      action_status: "performed",
      temporal_relation: "current",
      provider_ownership: "own",
      evidence: "定期訪問診療を実施。",
      search_queries: ["在宅患者訪問診療料"]
    }],
    feeCalculator: mockFeeCalculator()
  });

  const proposal = result.candidateProposals.find((item) => item.code === "114001110");
  assert.ok(proposal, "在宅患者訪問診療料が候補として提示される");
  assert.equal(proposal.potentialPoints, 890);
  assert.ok(result.reviewIssues.length >= 1, "review-only領域の確認事項も残る");
  assert.deepEqual(result.procedureCodes, [], "在宅は自動確定しない");
});

test("同一コードへ解決された複数イベントは1候補に畳まれる", async () => {
  const result = await convertClinicalCalculationEvents({
    clinicalEvents: [
      managementEvent({ clinicalEventId: "ev_doc_1" }),
      managementEvent({ clinicalEventId: "ev_doc_2", name: "傷病手当金の意見書を交付した" })
    ],
    feeCalculator: mockFeeCalculator()
  });

  const proposals = result.candidateProposals.filter((item) => item.code === "180000710");
  assert.equal(proposals.length, 1);
});

test("実施済みでないイベント(予定・過去・他院)は候補化しない", async () => {
  const planned = await convertClinicalCalculationEvents({
    clinicalEvents: [managementEvent({ action_status: "planned" })],
    feeCalculator: mockFeeCalculator()
  });
  assert.equal(planned.candidateProposals.filter((item) => item.basis === "master_link_candidate").length, 0);

  const past = await convertClinicalCalculationEvents({
    clinicalEvents: [managementEvent({ temporal_relation: "past" })],
    feeCalculator: mockFeeCalculator()
  });
  assert.equal(past.candidateProposals.filter((item) => item.basis === "master_link_candidate").length, 0);
});
