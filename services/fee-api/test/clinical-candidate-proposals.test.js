import assert from "node:assert/strict";
import { test } from "node:test";
import {
  convertClinicalCalculationEvents,
  dictionaryScanCandidateProposals
} from "../src/clinical-calculation-input.js";

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

test("動作語尾つきイベント名(〜作成・交付)は名詞核クエリでマスタ照合される", async () => {
  // STG実測の再現: 抽出イベント名「傷病手当金意見書 作成・交付」はLIKE検索が外れるが、
  // 名詞核「傷病手当金意見書」への正規化バリアントで解決される。
  const strictCalculator = {
    async searchMaster({ query }) {
      if (query === "傷病手当金意見書" || query === "傷病手当金意見書交付料") {
        return { items: [{ code: "180000710", name: "傷病手当金意見書交付料", points: 100, kind: "procedure" }] };
      }
      return { items: [] };
    }
  };
  const result = await convertClinicalCalculationEvents({
    clinicalEvents: [managementEvent({
      name: "傷病手当金意見書 作成・交付",
      search_queries: []
    })],
    feeCalculator: strictCalculator
  });

  const proposal = result.candidateProposals.find((item) => item.code === "180000710");
  assert.ok(proposal, "名詞核バリアントで照合できる");
  assert.equal(proposal.potentialPoints, 100);
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

test("辞書スキャン: 本文中のマスタ名称を候補化し、否定文脈・既出コード・加算は除外する", async () => {
  const text = [
    "S）体調は安定。",
    // 1行に複数文: 「中止」「次回」を含む文があっても、意見書の文自体は肯定文なので候補化される
    "P）催眠薬を中止。残薬を次回評価。休業に伴う傷病手当金意見書を作成・交付。CT検査は行わず経過観察。",
    "既に算定済みの療養費同意書交付料も記載。"
  ].join("\n");
  const scanner = {
    async scanMasterNames() {
      return {
        matches: [
          { code: "180000710", name: "傷病手当金意見書交付料", points: 100, role: "base", index: text.indexOf("傷病手当金意見書"), matchedText: "傷病手当金意見書" },
          { code: "170000000", name: "CT検査", points: 1000, role: "base", index: text.indexOf("CT検査"), matchedText: "CT検査" },
          { code: "113004310", name: "療養費同意書交付料", points: 100, role: "base", index: text.indexOf("療養費同意書"), matchedText: "療養費同意書" },
          { code: "114057970", name: "在宅データ提出加算", points: 50, role: "addon", index: 0, matchedText: "在宅データ提出加算" }
        ]
      };
    }
  };

  const result = await dictionaryScanCandidateProposals({
    feeCalculator: scanner,
    text,
    knownCodes: ["113004310"]
  });
  const codes = result.proposals.map((proposal) => proposal.code);

  assert.ok(codes.includes("180000710"), "肯定文の文書料は候補化");
  assert.ok(!codes.includes("170000000"), "「行わず」の文にあるCTは候補化しない");
  assert.ok(!codes.includes("113004310"), "既出コードは重複候補化しない");
  assert.ok(!codes.includes("114057970"), "加算(親コード前提)は辞書スキャンから直接候補化しない");
  const doc = result.proposals.find((proposal) => proposal.code === "180000710");
  assert.equal(doc.basis, "dictionary_scan_candidate");
  assert.ok(doc.evidence.includes("傷病手当金意見書を作成・交付"));
  assert.ok(!doc.evidence.includes("催眠薬"), "根拠はヒット文のみ(行全体ではない)");
});

test("加算(親項目前提)はイベント照合レーンから単独候補にしない", async () => {
  const addonCalculator = {
    async searchMaster() {
      return {
        items: [{
          code: "114013570",
          name: "在宅患者連携指導加算（訪問看護・訪問看護（同一））",
          points: 300,
          kind: "procedure",
          itemRole: "addon",
          feeCategory: "procedure_addon",
          derivedOnly: true
        }]
      };
    }
  };
  const result = await convertClinicalCalculationEvents({
    clinicalEvents: [managementEvent({
      name: "訪問看護と連携した指導",
      search_queries: ["在宅患者連携指導加算"]
    })],
    feeCalculator: addonCalculator
  });
  assert.equal(
    result.candidateProposals.filter((item) => item.basis === "master_link_candidate").length,
    0,
    "加算は単独候補として提示しない"
  );
});

test("受付時刻の時間帯判定: 深夜・休日・時間外・時間内", async () => {
  const { receptionTimeContextWarning } = await import("../src/clinical-calculation-input.js");
  assert.match(receptionTimeContextWarning("23:30", "2026-06-10"), /深夜加算確認/u);
  assert.match(receptionTimeContextWarning("05:59", "2026-06-10"), /深夜加算確認/u);
  assert.match(receptionTimeContextWarning("10:00", "2026-06-14"), /休日加算確認/u); // 日曜
  assert.match(receptionTimeContextWarning("10:00", "2026-01-01"), /休日加算確認/u); // 祝日
  assert.match(receptionTimeContextWarning("19:30", "2026-06-10"), /時間外加算確認/u);
  assert.equal(receptionTimeContextWarning("10:00", "2026-06-10"), ""); // 平日日中
  assert.equal(receptionTimeContextWarning("", "2026-06-10"), ""); // 未入力
});

test("v14全行カバレッジ: 行為あり判定なのに未イベント化の行を確認事項として明示する", async () => {
  const { buildClinicalCalculationPreparation } = await import("../src/clinical-calculation-input.js");
  const extractor = async ({ preprocessedLines }) => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    // 全行に判定を返し、2行目を「行為あり」なのにイベント化しない
    line_review: (preprocessedLines || []).map((line, index) => ({
      line_id: line.lineId,
      has_billable_act: index === 1
    })),
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  });
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: "S）体調は安定している。\nP）超音波検査を実施した。"
    },
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: extractor
  });
  const coverage = (prep.reviewIssues || []).find((issue) => issue.issueCode === "line_coverage_gap");
  assert.ok(coverage, "カバレッジ欠落の確認事項が出る");
  assert.ok(coverage.messageForStaff.includes("超音波検査"), "該当行の本文が示される");
});

test("mergeClinicalFactsSamples: イベント・診断・line_reviewを和集合にする", async () => {
  const { mergeClinicalFactsSamples } = await import("../src/clinical-calculation-input.js");
  const merged = mergeClinicalFactsSamples([
    {
      clinical_events: [{ type: "lab", name: "末梢血液一般", evidence_line_ids: ["O-001"] }],
      diagnoses: [{ name: "高血圧症" }],
      line_review: [{ line_id: "O-001", has_billable_act: true }, { line_id: "P-001", has_billable_act: false }]
    },
    {
      clinical_events: [
        { type: "lab", name: "末梢血液一般", evidence_line_ids: ["O-001"] }, // 重複
        { type: "management", name: "療養指導", evidence_line_ids: ["P-001"] } // 追加
      ],
      diagnoses: [{ name: "高血圧症" }, { name: "糖尿病" }],
      line_review: [{ line_id: "O-001", has_billable_act: true }, { line_id: "P-001", has_billable_act: true }]
    }
  ]);
  assert.equal(merged.clinical_events.length, 2);
  assert.deepEqual(merged.diagnoses.map((d) => d.name), ["高血圧症", "糖尿病"]);
  const p1 = merged.line_review.find((entry) => entry.line_id === "P-001");
  assert.equal(p1.has_billable_act, true); // OR判定
});
