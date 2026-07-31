import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDECAR_NOTICE_KINDS,
  buildSidecarNoticePresentation
} from "../src/sidecar-notice-view.js";

const VISIT_CODE = "114030310";

test("sidecar notices become candidate comments, badges, checklist rows, and sensor proposals", () => {
  const presentation = buildSidecarNoticePresentation({
    serviceDate: "2026-06-25",
    occurredAt: "2026-07-31T01:02:03.000Z",
    candidates: [
      {
        candidateId: VISIT_CODE,
        sourceType: "calculated_line",
        code: VISIT_CODE,
        name: "在宅患者訪問診療料（１）１（同一建物居住者）",
        estimatedTotalPoints: 215
      }
    ],
    calculation: {
      lineItems: [
        { code: VISIT_CODE, name: "在宅患者訪問診療料（１）１（同一建物居住者）" }
      ],
      clinicalEvents: [],
      metrics: {
        autoBillingRules: {
          applied: [{ ruleId: "visit", code: VISIT_CODE, action: "confirm" }],
          appliedCount: 1
        },
        sameHouseholdVisit: {
          status: "second_visit",
          replacementCandidateCount: 1,
          suppressedCodeCount: 1
        }
      }
    },
    warnings: [
      `レセプトコメントの確認: ${VISIT_CODE} 在宅患者訪問診療料 に必要なコメント: 850100094 必要性を認めた診療年月日（在宅患者訪問診療料（１））`,
      `レセプトコメントの確認: ${VISIT_CODE} 在宅患者訪問診療料 に必要なコメント: 850100095 訪問診療年月日（在宅患者訪問診療料（１））`,
      `レセプトコメントの確認: ${VISIT_CODE} 在宅患者訪問診療料 に必要なコメント: 830100088 頻回な在宅患者訪問診療を行った必要性（在宅患者訪問診療料（１））`,
      `施設恒常算定ルール: 在宅患者訪問診療料(${VISIT_CODE})を施設設定に基づき算定へ自動追加しました。`,
      "在宅区分の算定方針: 外来基本料は自動算定していません。",
      "施設基準確認: 検体検査管理加算の届出確認が必要です。"
    ],
    reviewIssues: [
      {
        reviewIssueId: "same_household_visit_second_visit",
        issueCode: "same_household_second_visit_review_required",
        severity: "warning",
        source: "same_household_visit_governance",
        messageForStaff: "同一患家を同日に訪問した2人目の可能性があります。"
      },
      {
        reviewIssueId: "continued",
        issueCode: "management_continuation_not_performed",
        severity: "info",
        messageForStaff: "カニューレ入れ替えは継続方針の記載です。"
      },
      {
        reviewIssueId: "coverage",
        issueCode: "auxiliary_extraction_unresolved",
        severity: "warning",
        messageForStaff: "カルテ内に抽出結果へ反映されていない可能性のある診療行為が2件あります。",
        sidecarDisplay: {
          fragments: ["創傷処置を実施", "胸部X線を撮影"],
          fragmentHashes: ["a".repeat(64), "b".repeat(64)]
        }
      }
    ]
  });

  assert.equal(
    presentation.notices.every((notice) => SIDECAR_NOTICE_KINDS.includes(notice.kind)),
    true
  );
  assert.equal(
    presentation.notices.every((notice) => (
      notice.shortText
      && notice.detailText
      && notice.audience
      && notice.occurredAt
      && ["required", "recommended", "reference"].includes(notice.attentionLevel)
    )),
    true
  );
  for (const candidate of presentation.candidates) {
    for (const badge of candidate.badges || []) {
      assert.equal(
        candidate.badgeDetails.some((detail) => (
          detail.badge === badge
          && ["required", "recommended", "reference"].includes(detail.attentionLevel)
        )),
        true
      );
      assert.equal(
        presentation.notices.some((notice) => (
          notice.badge === badge
          && (notice.candidateId === candidate.candidateId || notice.targetCode === candidate.code)
        )),
        true
      );
    }
  }

  const comments = presentation.candidates.find((candidate) => candidate.code === VISIT_CODE).comments;
  assert.deepEqual(
    comments
      .map((comment) => [comment.commentCode, comment.status, comment.text])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      [
        "830100088",
        "input_required",
        ""
      ],
      [
        "850100094",
        "generated",
        "必要性を認めた診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日"
      ],
      [
        "850100095",
        "generated",
        "訪問診療年月日（在宅患者訪問診療料（１））；令和 8年 6月25日"
      ]
    ]
  );
  assert.deepEqual(
    presentation.candidates.find((candidate) => candidate.code === VISIT_CODE).badges.sort(),
    ["facility_rule", "same_household_second"]
  );

  const checklist = presentation.notices.filter((notice) => notice.checklist);
  assert.deepEqual(
    checklist.map((notice) => notice.shortText).sort(),
    [
      "同一患家2人目の算定差替えを確認",
      "頻回訪問の必要性コメントを記入"
    ].sort()
  );
  const generated = presentation.notices.filter((notice) => (
    notice.kind === "attached_comment" && notice.comment.status === "generated"
  ));
  assert.equal(generated.length, 2);
  assert.equal(generated.every((notice) => notice.targetCode === VISIT_CODE), true);

  const sensorCandidates = presentation.candidates.filter((candidate) => (
    candidate.sourceSubtype === "sensor_candidate"
  ));
  assert.equal(sensorCandidates.length, 2);
  assert.equal(sensorCandidates.every((candidate) => (
    candidate.adoptionBlocked && candidate.estimatedTotalPoints === 0
  )), true);
  assert.equal(
    presentation.notices.find((notice) => notice.kind === "facility_config").checklist,
    false
  );
  assert.equal(
    presentation.notices.find((notice) => notice.kind === "suppressed_explanation").placement,
    "detail"
  );
});

test("facility configuration is actionable only when the visit has a related lab act", () => {
  const warning = "施設基準確認: 検体検査管理加算の届出確認が必要です。";
  const unrelated = buildSidecarNoticePresentation({
    warnings: [warning],
    calculation: { lineItems: [], candidateProposals: [], clinicalEvents: [] }
  });
  const related = buildSidecarNoticePresentation({
    warnings: [warning],
    calculation: {
      lineItems: [{ code: "160000000", name: "血液学的検査" }],
      candidateProposals: [],
      clinicalEvents: []
    }
  });

  assert.equal(unrelated.notices[0].kind, "facility_config");
  assert.equal(unrelated.notices[0].checklist, false);
  assert.equal(related.notices[0].kind, "facility_config");
  assert.equal(related.notices[0].checklist, true);
  assert.equal(related.notices[0].audience, "admin");
});

test("unknown notice sources remain audit-only and cannot enter the checklist", () => {
  const presentation = buildSidecarNoticePresentation({
    reviewIssues: [{
      reviewIssueId: "future_source",
      issueCode: "future_unclassified_source",
      severity: "warning",
      messageForStaff: "新しい確認情報です。"
    }]
  });
  assert.equal(presentation.notices[0].kind, "detail_log");
  assert.equal(presentation.notices[0].checklist, false);
  assert.equal(presentation.notices[0].placement, "detail");
});
