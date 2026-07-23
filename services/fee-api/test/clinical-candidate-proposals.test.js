import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClinicalCalculationPreparation,
  convertClinicalCalculationEvents,
  detectEmptyExtractionContradiction,
  diagnosesForDiseaseIndicationScan,
  dictionaryScanCandidateProposals,
  mergeDiseaseIndicationCandidateProposals
} from "../src/clinical-calculation-input.js";
import { candidateProposalsFromClinicalBillingKnowledge } from "../src/clinical-billing-knowledge.js";

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

test("辞書スキャン: 同一別名の複数コードは code未確定の曖昧候補1件に統合される", async () => {
  const text = "P）在宅酸素を継続する。";
  const scanner = {
    async scanMasterNames() {
      return {
        matches: [{
          index: text.indexOf("在宅酸素"),
          matchedText: "在宅酸素",
          codeCount: 2,
          codes: [
            { code: "114003710", name: "在宅酸素療法指導管理料（その他）", points: 2400, role: "base" },
            { code: "114004110", name: "在宅酸素療法指導管理料（チアノーゼ型先天性心疾患）", points: 520, role: "base" }
          ]
        }]
      };
    }
  };
  const result = await dictionaryScanCandidateProposals({ feeCalculator: scanner, text, knownCodes: [] });
  assert.equal(result.proposals.length, 1, "独立した採用スイッチ2つではなく曖昧候補1件");
  const proposal = result.proposals[0];
  assert.equal(proposal.code, "", "コード未確定");
  assert.deepEqual(proposal.codeCandidates, ["114003710", "114004110"]);
  assert.equal(proposal.candidateLine, null, "コード決定前は採用(明細化)できない");
  assert.equal(proposal.potentialPoints, 0, "点数は区分確定まで表示しない(改定時の陳腐化防止)");
  assert.ok(proposal.title.includes("在宅酸素"));
});

test("管理シグナル候補は単一マスタ解決時だけ点数を表示する", async () => {
  const input = {
    diagnoses: [{ name: "睡眠時無呼吸症候群", status: "active" }],
    clinicalEvents: [{
      type: "management",
      name: "CPAP使用状況確認",
      action_status: "performed",
      temporal_relation: "current_visit",
      provider_ownership: "own_clinic",
      evidence: "CPAPの使用状況を確認し、継続について説明した。"
    }],
    candidateLineFromProcedureCandidate: ({ item }) => ({
      code: item.code,
      name: item.name,
      points: item.points,
      totalPoints: item.points,
      quantity: 1
    })
  };

  const resolved = await candidateProposalsFromClinicalBillingKnowledge({
    ...input,
    searchProcedureCandidateItem: async () => ({
      code: "114010810",
      name: "在宅持続陽圧呼吸療法指導管理料２",
      points: 250
    })
  });
  const resolvedProposal = resolved.find((proposal) => proposal.ruleId === "C107_2_home_cpap_signal");
  assert.ok(resolvedProposal);
  assert.equal(resolvedProposal.potentialPoints, 250);
  assert.equal(resolvedProposal.candidateLine?.code, "114010810");

  const ambiguous = await candidateProposalsFromClinicalBillingKnowledge({
    ...input,
    searchProcedureCandidateItem: async () => null,
    searchProcedureCandidateChoices: async () => [
      { code: "114010810", points: 250 },
      { code: "114011010", points: 290 }
    ]
  });
  const ambiguousProposal = ambiguous.find((proposal) => proposal.ruleId === "C107_2_home_cpap_signal");
  assert.ok(ambiguousProposal);
  assert.equal(ambiguousProposal.potentialPoints, 0);
  assert.equal(ambiguousProposal.candidateLine, null);
  assert.deepEqual(ambiguousProposal.codeCandidates, ["114010810", "114011010"]);

  const unresolved = await candidateProposalsFromClinicalBillingKnowledge({
    ...input,
    searchProcedureCandidateItem: async () => null,
    searchProcedureCandidateChoices: async () => []
  });
  const unresolvedProposal = unresolved.find((proposal) => proposal.ruleId === "C107_2_home_cpap_signal");
  assert.ok(unresolvedProposal);
  assert.equal(unresolvedProposal.potentialPoints, 0);
  assert.deepEqual(unresolvedProposal.codeCandidates, []);
});

test("病名駆動候補: session病名を基礎に疑い・除外状態を決定論的に正規化する", () => {
  const diagnoses = diagnosesForDiseaseIndicationScan([
    { name: "慢性閉塞性肺疾患", status: "suspected" },
    { name: "慢性閉塞性肺疾患", status: "confirmed" },
    { name: "気管支炎の疑い", status: "active" },
    { name: "陳旧性心筋梗塞", status: "history" },
    { name: "肺炎", status: "denied" }
  ]);

  assert.deepEqual(diagnoses, [
    { name: "気管支炎の疑い", suspected: true },
    { name: "慢性閉塞性肺疾患", suspected: false }
  ]);
});

test("病名駆動候補: 施設区分バリアントを0点の1候補にし既存レーンを置換する", () => {
  const existing = [
    {
      proposalId: "management_signal_specific_disease",
      code: "113001810",
      potentialPoints: 225,
      source: "clinical_billing_knowledge:specific_disease_management"
    },
    {
      proposalId: "unrelated",
      code: "180000710",
      potentialPoints: 100
    }
  ];
  const merged = mergeDiseaseIndicationCandidateProposals({
    existingProposals: existing,
    lookupResult: {
      candidates: [{
        familyName: "特定疾患療養管理料",
        codes: [
          { code: "113001810", name: "特定疾患療養管理料（診療所）", points: 225 },
          { code: "113001910", name: "特定疾患療養管理料（病院１００床未満）", points: 147 }
        ],
        matchedDiseases: ["慢性閉塞性肺疾患"]
      }]
    }
  });

  assert.equal(merged.addedProposals.length, 1);
  const proposal = merged.addedProposals[0];
  assert.equal(proposal.code, "");
  assert.equal(proposal.potentialPoints, 0);
  assert.equal(proposal.actionType, "confirm_required");
  assert.deepEqual(proposal.codeCandidates, ["113001810", "113001910"]);
  assert.equal(proposal.candidateLine, null);
  assert.deepEqual(merged.replacedProposalIds, ["management_signal_specific_disease"]);
  assert.deepEqual(merged.candidateProposals.map((item) => item.proposalId), [
    "unrelated",
    "disease_link_choice_特定疾患療養管理料"
  ]);
});

test("病名駆動候補: 実施イベント由来の強い既存候補を病名だけで置換しない", () => {
  const existing = [{
    proposalId: "master_link_113001810",
    code: "113001810",
    potentialPoints: 225,
    source: "clinical_billing_opportunity",
    basis: "master_link_candidate"
  }];
  const merged = mergeDiseaseIndicationCandidateProposals({
    existingProposals: existing,
    lookupResult: {
      candidates: [{
        familyName: "特定疾患療養管理料",
        codes: [
          { code: "113001810", name: "特定疾患療養管理料（診療所）", points: 225 },
          { code: "113001910", name: "特定疾患療養管理料（病院１００床未満）", points: 147 }
        ],
        matchedDiseases: ["慢性閉塞性肺疾患"]
      }]
    }
  });

  assert.deepEqual(merged.addedProposals, []);
  assert.deepEqual(merged.replacedProposalIds, []);
  assert.deepEqual(merged.candidateProposals, existing);
});

test("病名駆動候補: 単一コードは点数付き確認候補、確定済みコードは抑制する", () => {
  const lookupResult = {
    candidates: [{
      familyName: "がん性疼痛緩和指導管理料",
      codes: [{ code: "113012810", name: "がん性疼痛緩和指導管理料", points: 200 }],
      matchedDiseases: ["膵癌"]
    }]
  };
  const proposed = mergeDiseaseIndicationCandidateProposals({ lookupResult });
  assert.equal(proposed.addedProposals.length, 1);
  assert.equal(proposed.addedProposals[0].code, "113012810");
  assert.equal(proposed.addedProposals[0].potentialPoints, 200);
  assert.equal(proposed.addedProposals[0].actionType, "confirm_required");
  assert.equal(proposed.addedProposals[0].candidateLine?.code, "113012810");

  const suppressed = mergeDiseaseIndicationCandidateProposals({
    lookupResult,
    confirmedCodes: ["113012810"]
  });
  assert.deepEqual(suppressed.addedProposals, []);
});

test("病名駆動候補: preparationから患者属性を渡しトレースを残す", async () => {
  let received = null;
  const feeCalculator = {
    async diseaseActCandidates(payload) {
      received = payload;
      return {
        candidates: [{
          familyName: "特定疾患療養管理料",
          codes: [{ code: "113001810", name: "特定疾患療養管理料（診療所）", points: 225 }],
          matchedDiseases: ["慢性閉塞性肺疾患"]
        }],
        resolvedNames: ["慢性閉塞性肺疾患"],
        unresolvedNames: []
      };
    },
    readiness() {
      return { masterSourceVersion: "test" };
    }
  };

  const result = await buildClinicalCalculationPreparation({
    session: {
      serviceDate: "2026-06-15",
      setting: "outpatient",
      diagnoses: [{ name: "慢性閉塞性肺疾患", status: "confirmed" }],
      patientSnapshot: { birthDate: "1950-01-01", sex: "female" }
    },
    feeCalculator
  });

  assert.deepEqual(received.diagnoses, [{ name: "慢性閉塞性肺疾患", suspected: false }]);
  assert.equal(received.patient_age, 76);
  assert.equal(received.patient_sex, "female");
  assert.equal(received.setting, "outpatient");
  assert.equal(result.candidateProposals.some((proposal) => proposal.code === "113001810"), true);
  const trace = result.clinicalExtraction.trace.find((item) => item.stage === "disease_indication_scan");
  assert.ok(trace);
  assert.equal(trace.candidateCount, 1);
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

test("v15全行カバレッジ: performed判定なのに未イベント化の行を確認事項として明示する", async () => {
  const { buildClinicalCalculationPreparation } = await import("../src/clinical-calculation-input.js");
  const extractor = async ({ preprocessedLines }) => ({
    visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
    diagnoses: [],
    // 全行に判定を返し、2行目を「行為あり」なのにイベント化しない
    line_review: (preprocessedLines || []).map((line, index) => ({
      line_id: line.lineId,
      line_role: index === 1 ? "performed" : "none"
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

test("v15管理継続行: イベントなしでも再抽出対象にせずstanding mentionを保存する", async () => {
  let extractorCalls = 0;
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "fee_management_continuation",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-13",
      setting: "outpatient",
      clinicalText: "P）在宅人工呼吸器管理を継続する。"
    },
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: async ({ preprocessedLines }) => {
      extractorCalls += 1;
      return {
        visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
        diagnoses: [],
        line_review: preprocessedLines.map((line) => ({
          line_id: line.lineId,
          line_role: "management_continuation"
        })),
        standing_mentions: preprocessedLines.map((line) => ({
          line_id: line.lineId,
          target: "在宅人工呼吸器管理",
          status: "continued"
        })),
        clinical_events: [],
        excluded_events: [],
        missing_information: [],
        review_flags: []
      };
    }
  });

  assert.equal(extractorCalls, 1, "正しい管理継続を契約違反として再抽出しない");
  assert.equal(
    prep.reviewIssues.some((issue) => ["line_coverage_gap", "line_review_incomplete"].includes(issue.issueCode)),
    false
  );
  assert.equal(prep.extractionSnapshot.lines[0].lineRole, "management_continuation");
  assert.equal(prep.extractionSnapshot.lines[0].requiresReextract, false);
  assert.deepEqual(prep.extractionSnapshot.lines[0].standingMentions, [
    { target: "在宅人工呼吸器管理", status: "continued" }
  ]);
});

test("v15決定論降格: 管理継続だけを根拠にした当日イベントを候補から除外する", async () => {
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "fee_management_downgrade",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-13",
      setting: "outpatient",
      clinicalText: "P）人工呼吸器管理を引き続き継続する。"
    },
    calculationInput: {},
    feeCalculator: {
      async searchMaster() {
        return {
          items: [{ code: "140009310", name: "人工呼吸", points: 302, kind: "procedure" }]
        };
      }
    },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({
        line_id: line.lineId,
        line_role: "management_continuation"
      })),
      standing_mentions: preprocessedLines.map((line) => ({
        line_id: line.lineId,
        target: "人工呼吸器管理",
        status: "continued"
      })),
      clinical_events: [{
        clinical_event_id: "ev_wrong_ventilation",
        type: "procedure",
        name: "人工呼吸",
        action_status: "performed",
        temporal_relation: "current",
        provider_ownership: "own",
        evidence: "人工呼吸器管理を引き続き継続する。",
        evidence_line_ids: [preprocessedLines[0].lineId],
        search_queries: ["人工呼吸"]
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });

  assert.ok(prep.reviewIssues.some((issue) => (
    issue.issueCode === "management_continuation_not_performed"
  )));
  assert.equal(
    prep.candidateProposals.some((proposal) => proposal.code === "140009310"),
    false,
    "継続方針から処置コードを候補化しない"
  );
});

test("v15決定論降格: LLMがperformedと誤分類しても継続記載だけなら除外する", async () => {
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "fee_management_misclassified_performed",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-13",
      setting: "outpatient",
      clinicalText: "P）在宅酸素療法は変更なく継続中。"
    },
    calculationInput: {},
    feeCalculator: {
      async searchMaster() {
        return {
          items: [{ code: "140005610", name: "酸素吸入", points: 65, kind: "procedure" }]
        };
      }
    },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({
        line_id: line.lineId,
        line_role: "performed"
      })),
      standing_mentions: [],
      clinical_events: [{
        clinical_event_id: "ev_wrong_oxygen",
        type: "procedure",
        name: "酸素吸入",
        action_status: "performed",
        temporal_relation: "current",
        provider_ownership: "own",
        evidence: "在宅酸素療法は変更なく継続中。",
        evidence_line_ids: [preprocessedLines[0].lineId],
        search_queries: ["酸素吸入"]
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });

  assert.ok(prep.reviewIssues.some((issue) => (
    issue.issueCode === "management_continuation_not_performed"
  )));
  assert.equal(
    prep.candidateProposals.some((proposal) => proposal.code === "140005610"),
    false
  );
});

test("v15決定論降格の反例: 当日実施と管理継続が同じ行にあればイベントを維持する", async () => {
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "fee_management_performed",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-13",
      setting: "outpatient",
      clinicalText: "O）喀痰吸引を実施し、呼吸管理を継続した。"
    },
    calculationInput: {},
    feeCalculator: {
      async searchMaster() {
        return {
          items: [{ code: "140009310", name: "人工呼吸", points: 302, kind: "procedure" }]
        };
      }
    },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({
        line_id: line.lineId,
        line_role: "performed"
      })),
      standing_mentions: [],
      clinical_events: [{
        clinical_event_id: "ev_suction",
        type: "procedure",
        name: "喀痰吸引",
        action_status: "performed",
        temporal_relation: "current",
        provider_ownership: "own",
        evidence: "喀痰吸引を実施し、呼吸管理を継続した。",
        evidence_line_ids: [preprocessedLines[0].lineId],
        search_queries: ["人工呼吸"]
      }],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });

  assert.equal(
    prep.reviewIssues.some((issue) => issue.issueCode === "management_continuation_not_performed"),
    false
  );
  assert.ok(prep.clinicalEvents.some((event) => event.name === "喀痰吸引"));
});

test("mergeClinicalFactsSamples: イベント・診断・line_reviewを和集合にする", async () => {
  const { mergeClinicalFactsSamples } = await import("../src/clinical-calculation-input.js");
  const merged = mergeClinicalFactsSamples([
    {
      clinical_events: [{ type: "lab", name: "末梢血液一般", evidence_line_ids: ["O-001"] }],
      diagnoses: [{ name: "高血圧症" }],
      line_review: [
        { line_id: "O-001", line_role: "performed" },
        { line_id: "P-001", line_role: "management_continuation" }
      ],
      standing_mentions: [
        { line_id: "P-001", target: "高血圧管理", status: "continued" }
      ]
    },
    {
      clinical_events: [
        { type: "lab", name: "末梢血液一般", evidence_line_ids: ["O-001"] }, // 重複
        { type: "management", name: "療養指導", evidence_line_ids: ["P-001"] } // 追加
      ],
      diagnoses: [{ name: "高血圧症" }, { name: "糖尿病" }],
      line_review: [
        { line_id: "O-001", line_role: "performed" },
        { line_id: "P-001", line_role: "plan" }
      ],
      standing_mentions: [
        { line_id: "P-001", target: "高血圧管理", status: "stopped" }
      ]
    }
  ]);
  assert.equal(merged.clinical_events.length, 2);
  assert.deepEqual(merged.diagnoses.map((d) => d.name), ["高血圧症", "糖尿病"]);
  const p1 = merged.line_review.find((entry) => entry.line_id === "P-001");
  assert.equal(p1.line_role, "management_continuation");
  assert.deepEqual(merged.standing_mentions, [
    { line_id: "P-001", target: "高血圧管理", status: "stopped" }
  ]);
});

// 不変条件: フォールバック(近似召回)由来の検索結果は確定算定へ入れない。
test("directRetrievalFilterReason: matchOrigin付き項目は確定レーンで除外され、候補レーンだけ許可できる", async () => {
  const { directRetrievalFilterReason } = await import("../src/clinical-calculation-input.js");
  const fuzzyItem = { code: "160072110", name: "ＨｂＡ１ｃ", kind: "procedure", matchOrigin: "ngram_fallback" };
  assert.equal(directRetrievalFilterReason(fuzzyItem), "fuzzy_recall:ngram_fallback");
  assert.equal(
    directRetrievalFilterReason({ ...fuzzyItem, matchOrigin: "token_fallback" }),
    "fuzzy_recall:token_fallback"
  );
  // 候補レーン(人が承認するまで合計に入らない)は明示オプトインで通せる
  assert.equal(directRetrievalFilterReason(fuzzyItem, { allowFuzzyRecall: true }), "");
});

test("selectMasterItemForOrder: フォールバック由来は正規化一致・部分一致でも採用しない", async () => {
  const { selectMasterItemForOrder } = await import("../src/server.js");
  const query = "ＨｂＡ１ｃ";
  const fuzzy = { code: "160072110", name: "ＨｂＡ１ｃ", kind: "procedure", matchOrigin: "ngram_fallback" };
  // 完全一致でもフォールバック由来なら不採用(不変条件に例外を作らない)
  assert.equal(selectMasterItemForOrder([fuzzy], "procedure", query), null);
  // 同じ項目が全文一致検索(matchOriginなし)で来た場合は従来どおり採用
  const exact = { code: "160072110", name: "ＨｂＡ１ｃ", kind: "procedure" };
  assert.equal(selectMasterItemForOrder([fuzzy, exact], "procedure", query)?.code, "160072110");
  assert.equal(selectMasterItemForOrder([fuzzy, exact], "procedure", query)?.matchOrigin, undefined);
});

// v15契約検証: 期待行ID(Nodeが確定)との完全照合と、欠落行のみの再抽出。
test("reconcileLineReview: 欠落・重複・未知IDを検出し正規形に畳む", async () => {
  const { reconcileLineReview } = await import("../src/clinical-calculation-input.js");
  const result = reconcileLineReview({
    line_review: [
      { line_id: "L-001", line_role: "plan" },
      { line_id: "L-001", line_role: "performed" },  // 重複(優先順位で畳む)
      { line_id: "X-999", line_role: "performed" }   // 未知ID(幻覚行)
    ]
  }, ["L-001", "L-002", "L-003"]);
  assert.deepEqual(result.missingIds, ["L-002", "L-003"]);
  assert.deepEqual(result.unknownIds, ["X-999"]);
  assert.deepEqual(result.duplicateIds, ["L-001"]);
  assert.deepEqual(result.normalizedLineReview, [{ line_id: "L-001", line_role: "performed" }]);
});

test("line_review欠落: 欠落行だけを再抽出し、埋まれば確認事項を出さない", async () => {
  const { buildClinicalCalculationPreparation } = await import("../src/clinical-calculation-input.js");
  const calls = [];
  const extractor = async ({ preprocessedLines, clinicalText, scope }) => {
    calls.push({
      lineIds: (preprocessedLines || []).map((line) => line.lineId),
      clinicalText,
      scope
    });
    if (calls.length === 1) {
      // 1回目: 先頭行しか判定を返さない(2行目を丸ごと省略)
      return {
        visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
        diagnoses: [], clinical_events: [], excluded_events: [], missing_information: [], review_flags: [],
        line_review: [{ line_id: (preprocessedLines || [])[0]?.lineId, line_role: "none" }]
      };
    }
    // 2回目(検証駆動リトライ): 渡された行(=欠落行のみ)を全て判定する
    return {
      diagnoses: [], clinical_events: [], excluded_events: [], missing_information: [], review_flags: [],
      line_review: (preprocessedLines || []).map((line) => ({ line_id: line.lineId, line_role: "none" }))
    };
  };
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: "S）体調は安定している。\nP）経過観察を継続する。"
    },
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: extractor
  });
  assert.equal(calls.length, 2, "欠落検出で1回だけ再抽出する");
  assert.equal(calls[1].lineIds.length, 1, "再抽出は欠落行のみに絞る");
  assert.equal(calls[1].scope, "line_subset");
  assert.equal(calls[1].clinicalText, "P）経過観察を継続する。");
  assert.equal(calls[1].clinicalText.includes("体調は安定"), false, "再抽出へ全文を送らない");
  assert.ok(!calls[0].lineIds.includes(calls[1].lineIds[0]) || calls[0].lineIds.length > calls[1].lineIds.length);
  const incomplete = (prep.reviewIssues || []).find((issue) => issue.issueCode === "line_review_incomplete");
  assert.equal(incomplete, undefined, "再抽出で埋まれば契約違反issueは出ない");
});

test("抽出メモ: 継続行を再利用し、新規行だけをline_subsetで抽出する", async () => {
  const calls = [];
  const extractor = async ({ preprocessedLines, clinicalText, scope }) => {
    calls.push({
      lineIds: (preprocessedLines || []).map((line) => line.lineId),
      clinicalText,
      scope
    });
    return {
      ...(scope === "full" ? {
        visit_type: { kind: "revisit", evidence: "継続受診", confidence: "medium" },
        visit_facts: {
          outside_prescription_issued: "unknown",
          generic_name_prescription: "unknown",
          prescription_evidence: ""
        }
      } : {}),
      diagnoses: [],
      line_review: (preprocessedLines || []).map((line) => ({
        line_id: line.lineId,
        line_role: "none"
      })),
      clinical_events: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    };
  };
  const common = {
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: extractor
  };
  const first = await buildClinicalCalculationPreparation({
    ...common,
    session: {
      feeSessionId: "fee_1",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-01",
      setting: "outpatient",
      clinicalText: "S）状態は安定。\nP）経過観察を継続。"
    }
  });
  const second = await buildClinicalCalculationPreparation({
    ...common,
    extractionSnapshot: first.extractionSnapshot,
    session: {
      feeSessionId: "fee_2",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-15",
      setting: "outpatient",
      clinicalText: "S）状態は安定。\nO）胸部X線を実施。\nP）経過観察を継続。"
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].scope, "full");
  assert.equal(calls[1].scope, "line_subset");
  assert.deepEqual(calls[1].lineIds, ["O-001"]);
  assert.equal(calls[1].clinicalText, "O）胸部X線を実施。");
  assert.equal(second.metrics.extractionMemo.used, true);
  assert.equal(second.metrics.extractionMemo.continuedLineCount, 2);
  assert.equal(second.metrics.extractionMemo.newLineCount, 1);
  assert.equal(second.metrics.extractionMemo.memoHitLineRatio, 2 / 3);
  assert.equal(second.metrics.clinicalStructuring.openAiCallCount, 1);
  assert.ok(second.clinicalExtraction.trace.some((item) => (
    item.stage === "extraction_memo" && item.outcome === "reused"
  )));
});

test("抽出メモ: 同一カルテ再実行では抽出器を呼ばず同じスナップショットを作る", async () => {
  const session = {
    feeSessionId: "fee_1",
    orgId: "org_1",
    patientId: "pat_1",
    serviceDate: "2026-06-01",
    setting: "outpatient",
    clinicalText: "S）状態は安定。\nP）経過観察を継続。"
  };
  const feeCalculator = { async searchMaster() { return { items: [] }; } };
  const first = await buildClinicalCalculationPreparation({
    session,
    calculationInput: {},
    feeCalculator,
    openAiApiKey: "dummy",
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "継続受診", confidence: "medium" },
      visit_facts: {
        outside_prescription_issued: "unknown",
        generic_name_prescription: "unknown",
        prescription_evidence: ""
      },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({ line_id: line.lineId, line_role: "none" })),
      clinical_events: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });
  let extractorCalls = 0;
  const repeated = await buildClinicalCalculationPreparation({
    session: { ...session, feeSessionId: "fee_2", serviceDate: "2026-06-15" },
    calculationInput: {},
    feeCalculator,
    extractionSnapshot: first.extractionSnapshot,
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: async () => {
      extractorCalls += 1;
      throw new Error("same-note memo should not call the extractor");
    }
  });

  assert.equal(extractorCalls, 0);
  assert.equal(repeated.metrics.extractionMemo.memoHitLineRatio, 1);
  assert.equal(repeated.metrics.extractionMemo.newLineCount, 0);
  assert.equal(repeated.metrics.clinicalStructuring.openAiCallCount, 0);
  assert.equal(repeated.metrics.clinicalStructuring.openAiProviderDurationMs, 0);
  assert.deepEqual(repeated.extractionSnapshot.lines, first.extractionSnapshot.lines);
});

test("抽出メモ: 院内外処方を変える新規行は全文抽出へフォールバックする", async () => {
  const feeCalculator = { async searchMaster() { return { items: [] }; } };
  const stableSession = {
    feeSessionId: "fee_1",
    orgId: "org_1",
    patientId: "pat_1",
    serviceDate: "2026-06-01",
    setting: "outpatient",
    clinicalText: "S）状態は安定。\nP）現行処方を継続。"
  };
  const first = await buildClinicalCalculationPreparation({
    session: stableSession,
    calculationInput: {},
    feeCalculator,
    openAiApiKey: "dummy",
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "継続受診", confidence: "medium" },
      visit_facts: {
        outside_prescription_issued: "unknown",
        generic_name_prescription: "unknown",
        prescription_evidence: ""
      },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({ line_id: line.lineId, line_role: "none" })),
      clinical_events: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });
  const calls = [];
  const changed = await buildClinicalCalculationPreparation({
    session: {
      ...stableSession,
      feeSessionId: "fee_2",
      serviceDate: "2026-06-15",
      clinicalText: "S）状態は安定。\nP）院外処方箋を発行。"
    },
    calculationInput: {},
    feeCalculator,
    extractionSnapshot: first.extractionSnapshot,
    extractionMemoEnabled: true,
    historyCompleteness: "complete",
    feeSettings: { historyPolicy: { historyCompleteness: "complete" } },
    clinicalFactsExtractor: async ({ preprocessedLines, clinicalText, scope }) => {
      calls.push({ clinicalText, scope });
      return {
        visit_type: { kind: "revisit", evidence: "継続受診", confidence: "medium" },
        visit_facts: {
          outside_prescription_issued: "yes",
          generic_name_prescription: "unknown",
          prescription_evidence: "院外処方箋を発行"
        },
        diagnoses: [],
        line_review: preprocessedLines.map((line) => ({ line_id: line.lineId, line_role: "none" })),
        clinical_events: [],
        excluded_events: [],
        missing_information: [],
        review_flags: []
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "full");
  assert.match(calls[0].clinicalText, /院外処方箋/u);
  assert.equal(changed.metrics.extractionMemo.used, false);
  assert.equal(changed.metrics.extractionMemo.reason, "visit_facts_sensitive_change");
  assert.equal(changed.metrics.clinicalStructuring.openAiCallCount, 1);
  assert.equal(changed.clinicalExtraction.visitFacts.outside_prescription_issued, "yes");
});

test("履歴取得不能時は抽出された初再診を確定入力へ入れない", async () => {
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "fee_1",
      orgId: "org_1",
      patientId: "pat_1",
      serviceDate: "2026-06-01",
      setting: "outpatient",
      clinicalText: "再診。経過観察を継続。"
    },
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    historyCompleteness: "unavailable",
    clinicalFactsExtractor: async ({ preprocessedLines }) => ({
      visit_type: { kind: "revisit", evidence: "再診", confidence: "high" },
      diagnoses: [],
      line_review: preprocessedLines.map((line) => ({ line_id: line.lineId, line_role: "none" })),
      clinical_events: [],
      excluded_events: [],
      missing_information: [],
      review_flags: []
    })
  });

  assert.equal(prep.calculationOptions?.outpatient_basic, undefined);
  assert.ok(prep.reviewWarnings.includes("受診履歴を取得できなかったため、履歴に依存する判定は未確定です。"));
});

test("line_review欠落が再抽出でも埋まらなければ line_review_incomplete を明示する", async () => {
  const { buildClinicalCalculationPreparation } = await import("../src/clinical-calculation-input.js");
  let callCount = 0;
  const extractor = async ({ preprocessedLines }) => {
    callCount += 1;
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [], clinical_events: [], excluded_events: [], missing_information: [], review_flags: [],
      // 常に先頭行だけ判定(リトライでも省略が続く)
      line_review: callCount === 1
        ? [{ line_id: (preprocessedLines || [])[0]?.lineId, line_role: "none" }]
        : []
    };
  };
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
  const incomplete = (prep.reviewIssues || []).find((issue) => issue.issueCode === "line_review_incomplete");
  assert.ok(incomplete, "未解消の欠落は不完全結果として明示する");
  assert.ok(incomplete.messageForStaff.includes("超音波検査"), "欠落行の本文が示される");
});

test("空抽出ガード: 肯定的な辞書シグナルがあれば全文を1回再抽出して回復する", async () => {
  const text = "P）休業に伴う傷病手当金意見書を作成・交付した。";
  let callCount = 0;
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: text
    },
    calculationInput: {},
    feeCalculator: {
      async scanMasterNames() {
        return {
          matches: [{
            code: "180000710",
            name: "傷病手当金意見書交付料",
            points: 100,
            role: "base",
            matchedText: "傷病手当金意見書"
          }]
        };
      },
      async searchMaster() { return { items: [] }; }
    },
    openAiApiKey: "dummy",
    emptyExtractionRetryEnabled: true,
    clinicalFactsExtractor: async ({ preprocessedLines, scope }) => {
      callCount += 1;
      return {
        visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
        diagnoses: [],
        line_review: preprocessedLines.map((line) => ({
          line_id: line.lineId,
          line_role: callCount === 2 ? "performed" : "none"
        })),
        clinical_events: callCount === 2
          ? [{
            clinical_event_id: "ev_document_1",
            type: "management",
            name: "傷病手当金意見書の作成・交付",
            action_status: "performed",
            temporal_relation: "current",
            provider_ownership: "own",
            evidence: text,
            evidence_line_ids: [preprocessedLines[0].lineId],
            search_queries: ["傷病手当金意見書交付料"]
          }]
          : [],
        excluded_events: [],
        missing_information: [],
        review_flags: [],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: callCount === 2 ? 20 : 0 }
        },
        scope
      };
    }
  });

  assert.equal(callCount, 2, "空抽出時の追加呼出しは1回だけ");
  assert.equal(prep.metrics.clinicalStructuring.semanticRetryCount, 1);
  assert.equal(prep.metrics.clinicalStructuring.emptyExtractionGuard.triggered, true);
  assert.equal(prep.metrics.clinicalStructuring.emptyExtractionGuard.recovered, true);
  assert.equal(prep.metrics.clinicalStructuring.emptyExtractionGuard.finalEventCount, 1);
  assert.equal(prep.metrics.clinicalStructuring.extractionMode, "full_with_retry");
  assert.equal(prep.metrics.clinicalStructuring.usage.input_tokens, 200);
  assert.equal(prep.metrics.clinicalStructuring.usage.input_tokens_details.cached_tokens, 20);
  assert.ok(prep.clinicalExtraction.trace.some((entry) => (
    entry.stage === "empty_extraction_guard" && entry.outcome === "recovered"
  )));
  assert.equal(
    prep.reviewIssues.some((issue) => issue.issueCode === "empty_clinical_extraction"),
    false
  );
});

test("空抽出ガード: 否定文脈の辞書一致では再抽出しない", async () => {
  const text = "O）CT検査は行わず、経過観察とした。";
  let callCount = 0;
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: text
    },
    calculationInput: {},
    feeCalculator: {
      async scanMasterNames() {
        return {
          matches: [{
            code: "170000000",
            name: "CT検査",
            points: 1000,
            role: "base",
            matchedText: "CT検査"
          }]
        };
      },
      async searchMaster() { return { items: [] }; }
    },
    openAiApiKey: "dummy",
    emptyExtractionRetryEnabled: true,
    clinicalFactsExtractor: async ({ preprocessedLines }) => {
      callCount += 1;
      return {
        diagnoses: [],
        line_review: preprocessedLines.map((line) => ({ line_id: line.lineId, line_role: "none" })),
        clinical_events: [], excluded_events: [], missing_information: [], review_flags: []
      };
    }
  });

  assert.equal(callCount, 1);
  assert.equal(prep.metrics.clinicalStructuring.emptyExtractionGuard.triggered, false);
  assert.equal(prep.metrics.clinicalStructuring.semanticRetryCount, 0);
});

test("空抽出ガード: session入力だけでは発火せず今回本文への肯定記載を要求する", async () => {
  const session = {
    orders: [{ localName: "アムロジピン錠5mg" }],
    diagnoses: [{ name: "高血圧症" }]
  };
  const feeCalculator = { async scanMasterNames() { return { matches: [] }; } };
  const absent = await detectEmptyExtractionContradiction({
    text: "S）体調について家族から相談を受けた。",
    session,
    facts: { diagnoses: [], clinical_events: [] },
    feeCalculator
  });
  assert.equal(absent.triggered, false, "別入力に値があるだけでは無駄な再抽出をしない");

  const current = await detectEmptyExtractionContradiction({
    text: "A）高血圧症。P）アムロジピン錠5mgを継続処方した。",
    session,
    facts: { diagnoses: [], clinical_events: [] },
    feeCalculator
  });
  assert.equal(current.triggered, true);
  assert.deepEqual(current.reasonCodes, ["current_order_mentioned", "current_diagnosis_mentioned"]);
});

test("空抽出ガード: 再抽出も空なら確認事項を出し、line_review再試行を追加しない", async () => {
  const text = "P）傷病手当金意見書を作成・交付した。";
  let callCount = 0;
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: text
    },
    calculationInput: {},
    feeCalculator: {
      async scanMasterNames() {
        return {
          matches: [{
            code: "180000710",
            name: "傷病手当金意見書交付料",
            points: 100,
            role: "base",
            matchedText: "傷病手当金意見書"
          }]
        };
      },
      async searchMaster() { return { items: [] }; }
    },
    openAiApiKey: "dummy",
    emptyExtractionRetryEnabled: true,
    clinicalFactsExtractor: async () => {
      callCount += 1;
      return {
        diagnoses: [], line_review: [], clinical_events: [], excluded_events: [], missing_information: [], review_flags: []
      };
    }
  });

  assert.equal(callCount, 2, "空抽出とline_review欠落が重なっても追加呼出しは1回だけ");
  assert.equal(prep.metrics.clinicalStructuring.semanticRetryCount, 1);
  assert.equal(prep.metrics.clinicalStructuring.lineReviewRetryCount, 0);
  assert.equal(prep.metrics.clinicalStructuring.emptyExtractionGuard.recovered, false);
  assert.ok(prep.reviewIssues.some((issue) => issue.issueCode === "empty_clinical_extraction"));
  assert.ok(prep.reviewIssues.some((issue) => issue.issueCode === "line_review_incomplete"));
});

test("mergeOpenAiUsage: 複数サンプルの数値usageを合算する", async () => {
  const { mergeOpenAiUsage } = await import("../src/clinical-calculation-input.js");
  assert.equal(mergeOpenAiUsage(), null);
  const merged = mergeOpenAiUsage(
    { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } },
    { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } }
  );
  assert.equal(merged.input_tokens, 17);
  assert.equal(merged.output_tokens, 7);
  assert.deepEqual(merged.input_tokens_details, { cached_tokens: 7 });
});

test("複数サンプル抽出: 1件失敗しても成功サンプルで継続し縮退しない", async (t) => {
  const previous = process.env.FEE_CLINICAL_EXTRACTION_SAMPLES;
  process.env.FEE_CLINICAL_EXTRACTION_SAMPLES = "2";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FEE_CLINICAL_EXTRACTION_SAMPLES;
    } else {
      process.env.FEE_CLINICAL_EXTRACTION_SAMPLES = previous;
    }
  });
  const { buildClinicalCalculationPreparation } = await import("../src/clinical-calculation-input.js");
  let callCount = 0;
  const extractor = async ({ preprocessedLines }) => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("sample 1 failed");
    }
    return {
      visit_type: { kind: "revisit", evidence: "再診", confidence: "medium" },
      diagnoses: [], clinical_events: [], excluded_events: [], missing_information: [], review_flags: [],
      line_review: (preprocessedLines || []).map((line) => ({ line_id: line.lineId, line_role: "none" })),
      usage: { input_tokens: 11, output_tokens: 4 }
    };
  };
  const prep = await buildClinicalCalculationPreparation({
    session: {
      feeSessionId: "f", orgId: "o", patientId: "p", serviceDate: "2026-06-13", setting: "outpatient",
      clinicalText: "S）体調は安定している。\nP）経過観察を継続する。"
    },
    calculationInput: {},
    feeCalculator: { async searchMaster() { return { items: [] }; } },
    openAiApiKey: "dummy",
    clinicalFactsExtractor: extractor
  });
  const degraded = (prep.reviewWarnings || []).some((warning) => String(warning).startsWith("抽出縮退"));
  assert.equal(degraded, false, "成功サンプルがあればルール縮退しない");
});
