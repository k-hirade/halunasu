import crypto from "node:crypto";
import { formatJapaneseReceiptDate } from "../../../packages/fee-core/src/index.js";

export const SIDECAR_NOTICE_KINDS = Object.freeze([
  "attached_comment",
  "line_provenance",
  "line_annotation",
  "suppressed_explanation",
  "policy_explanation",
  "facility_config",
  "sensor_candidate",
  "detail_log"
]);

const GENERATED_DATE_COMMENT_CODES = new Set([
  "850100094",
  "850100095"
]);

export function buildSidecarNoticePresentation({
  warnings = [],
  reviewIssues = [],
  calculation = {},
  candidates = [],
  serviceDate = "",
  occurredAt = null
} = {}) {
  const notices = buildSidecarCalculationNotices({
    warnings,
    reviewIssues,
    calculation,
    candidates,
    serviceDate,
    occurredAt
  });
  const decoratedCandidates = decorateSidecarCandidates(candidates, {
    calculation,
    notices
  });
  const sensorCandidates = buildSidecarSensorCandidates(notices, decoratedCandidates);
  const allCandidates = uniqueSidecarCandidates([...decoratedCandidates, ...sensorCandidates]);
  const detailNotices = candidateDetailNotices(allCandidates, notices, occurredAt);
  const allNotices = [...notices, ...detailNotices].map((notice, index) => ({
    ...notice,
    sequence: index + 1
  }));
  return {
    notices: allNotices,
    candidates: allCandidates
  };
}

export function buildSidecarCalculationNotices({
  warnings = [],
  reviewIssues = [],
  calculation = {},
  candidates = [],
  serviceDate = "",
  occurredAt = null
} = {}) {
  const notices = [];
  const seenKeys = new Set();
  const structuredMessageKeys = new Set();
  const context = { calculation, candidates, serviceDate, occurredAt };

  for (const issue of asArray(reviewIssues)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const detailText = sidecarNoticeMessage(issue);
    if (!detailText) {
      continue;
    }
    const messageKey = normalizeSidecarNoticeText(detailText);
    const deduplicationKey = reviewIssueDeduplicationKey(issue, messageKey);
    if (seenKeys.has(deduplicationKey)) {
      continue;
    }
    seenKeys.add(deduplicationKey);
    structuredMessageKeys.add(messageKey);
    notices.push(classifySidecarNotice({
      ...issue,
      noticeId: issue.reviewIssueId || sidecarNoticeId(deduplicationKey),
      sourceType: "review_issue",
      severity: normalizeSidecarNoticeSeverity(issue.severity, "warning"),
      messageForStaff: detailText,
      detailText
    }, context));
  }

  for (const warning of asArray(warnings)) {
    const detailText = sidecarNoticeMessage(warning);
    if (!detailText) {
      continue;
    }
    const messageKey = normalizeSidecarNoticeText(detailText);
    if (structuredMessageKeys.has(messageKey)) {
      continue;
    }
    const deduplicationKey = `warning|${messageKey}`;
    if (seenKeys.has(deduplicationKey)) {
      continue;
    }
    seenKeys.add(deduplicationKey);
    notices.push(classifySidecarNotice({
      noticeId: sidecarNoticeId(deduplicationKey),
      sourceType: "warning",
      issueCode: null,
      topicCode: null,
      relatedClinicalEventId: null,
      severity: "warning",
      messageForStaff: detailText,
      detailText
    }, context));
  }

  return notices
    .sort((left, right) => (
      noticeSeverityOrder(left.severity) - noticeSeverityOrder(right.severity)
      || String(left.topicCode || left.issueCode || "").localeCompare(
        String(right.topicCode || right.issueCode || ""),
        "ja"
      )
      || String(left.noticeId || "").localeCompare(String(right.noticeId || ""))
    ))
    .map((notice, index) => ({
    ...notice,
    occurredAt: notice.occurredAt || occurredAt || null,
    sequence: index + 1
    }));
}

export function decorateSidecarCandidates(candidates = [], {
  calculation = {},
  notices = []
} = {}) {
  const facilityRuleCodes = new Set(
    asArray(calculation?.metrics?.autoBillingRules?.applied)
      .map((entry) => String(entry?.code || "").trim())
      .filter(Boolean)
  );
  const commentsByCode = new Map();
  for (const notice of notices) {
    if (notice.kind !== "attached_comment" || !notice.targetCode || !notice.comment) {
      continue;
    }
    const values = commentsByCode.get(notice.targetCode) || [];
    values.push(notice.comment);
    commentsByCode.set(notice.targetCode, values);
  }

  return asArray(candidates).map((candidate) => {
    const code = String(candidate?.code || "").trim();
    const badges = new Set(asArray(candidate?.badges).map(String).filter(Boolean));
    if (
      facilityRuleCodes.has(code)
      || candidate?.basis === "facility_auto_billing_rule"
      || candidate?.source === "facility_auto_billing_rule"
    ) {
      badges.add("facility_rule");
    }
    if (candidate?.requiresSelection) {
      badges.add("requires_selection");
    }
    if (candidate?.adoptionBlocked) {
      badges.add("adoption_blocked");
    }
    for (const notice of notices) {
      if (notice.kind !== "line_annotation") {
        continue;
      }
      const isTarget = notice.targetCode
        ? notice.targetCode === code
        : isVisitFeeCandidate(candidate);
      if (isTarget && notice.badge) {
        badges.add(notice.badge);
      }
    }
    return {
      ...candidate,
      badges: [...badges],
      badgeDetails: [...badges].map((badge) => ({
        badge,
        attentionLevel: badgeAttentionLevel(badge)
      })),
      comments: uniqueComments([
        ...asArray(candidate?.comments),
        ...(commentsByCode.get(code) || [])
      ])
    };
  });
}

function candidateDetailNotices(candidates = [], notices = [], occurredAt = null) {
  const result = [];
  const existing = new Set(asArray(notices).map((notice) => [
    notice?.targetCode || "",
    notice?.candidateId || "",
    notice?.badge || "",
    notice?.comment?.commentCode || "",
    notice?.comment?.status || ""
  ].join("|")));
  for (const candidate of asArray(candidates)) {
    const targetCode = String(candidate?.code || "").trim() || null;
    const candidateId = candidate?.candidateId || null;
    for (const badge of asArray(candidate?.badges)) {
      const key = [targetCode || "", candidateId || "", badge, "", ""].join("|");
      const codeFallbackKey = [targetCode || "", "", badge, "", ""].join("|");
      if (existing.has(key) || existing.has(codeFallbackKey)) continue;
      result.push({
        noticeId: sidecarNoticeId(`candidate-badge|${candidateId || targetCode}|${badge}`),
        sourceType: "candidate_metadata",
        kind: badge === "facility_rule" ? "line_provenance" : "line_annotation",
        targetCode,
        candidateId,
        severity: badgeAttentionLevel(badge) === "required" ? "error" : badgeAttentionLevel(badge) === "recommended" ? "warning" : "info",
        attentionLevel: badgeAttentionLevel(badge),
        shortText: badgeDetailText(badge),
        detailText: badgeDetailText(badge),
        audience: "clinician",
        placement: "detail",
        checklist: false,
        badge,
        occurredAt
      });
    }
    for (const comment of asArray(candidate?.comments)) {
      const key = [
        targetCode || "",
        candidateId || "",
        "",
        comment?.commentCode || "",
        comment?.status || ""
      ].join("|");
      const hasNotice = existing.has(key) || asArray(notices).some((notice) => (
        notice?.kind === "attached_comment"
        && notice?.targetCode === targetCode
        && notice?.comment?.commentCode === comment?.commentCode
        && notice?.comment?.status === comment?.status
      ));
      if (hasNotice) continue;
      const required = comment?.status === "input_required";
      result.push({
        noticeId: sidecarNoticeId(`candidate-comment|${candidateId || targetCode}|${comment?.commentCode}|${comment?.status}`),
        sourceType: "candidate_metadata",
        kind: "attached_comment",
        targetCode,
        candidateId,
        severity: required ? "warning" : "info",
        attentionLevel: required ? "recommended" : "reference",
        shortText: required ? `${comment?.name || "レセプトコメント"}を記入` : `${comment?.name || "レセプトコメント"}を作成済み`,
        detailText: comment?.text || comment?.name || "レセプトコメントを確認してください。",
        audience: "clinician",
        placement: required ? "candidate_checklist" : "detail",
        checklist: required,
        comment,
        occurredAt
      });
    }
  }
  return result;
}

function badgeAttentionLevel(badge) {
  if (["adoption_blocked", "sensor_candidate"].includes(String(badge))) return "required";
  if (["requires_selection", "same_household_second", "same_household_unresolved"].includes(String(badge))) return "recommended";
  return "reference";
}

function badgeDetailText(badge) {
  return {
    facility_rule: "施設の恒常算定ルールに基づく候補です。",
    requires_selection: "算定区分の選択が必要です。",
    adoption_blocked: "算定要件が未確定のため採用できません。",
    same_household_first: "同一患家の1人目として扱われています。",
    same_household_second: "同一患家の2人目として算定差替えの確認が必要です。",
    same_household_unresolved: "同一患家の訪問順を確認できません。",
    sensor_candidate: "抽出補助が未確認の行為を検出しました。"
  }[String(badge)] || "候補の算定根拠を確認してください。";
}

export function buildSidecarSensorCandidates(notices = [], existingCandidates = []) {
  const existingText = asArray(existingCandidates)
    .flatMap((candidate) => [candidate?.name, candidate?.reason, candidate?.evidence])
    .map(normalizeSidecarNoticeText)
    .filter(Boolean);
  const result = [];
  for (const notice of notices) {
    if (notice.kind !== "sensor_candidate") {
      continue;
    }
    const requestedCount = Math.max(1, Number(notice?.sensor?.count || 1));
    const fragments = uniqueStrings(notice?.sensor?.fragments);
    for (let index = 0; index < requestedCount; index += 1) {
      const fragment = fragments[index] || `未確認の診療行為 ${index + 1}`;
      const normalizedFragment = normalizeSidecarNoticeText(fragment);
      if (
        fragments[index]
        && existingText.some((text) => text.includes(normalizedFragment) || normalizedFragment.includes(text))
      ) {
        continue;
      }
      result.push({
        candidateId: `${notice.noticeId}_sensor_${index + 1}`,
        sourceType: "proposal",
        sourceSubtype: "sensor_candidate",
        code: null,
        codeCandidates: [],
        requiresSelection: false,
        adoptionBlocked: true,
        adoptionBlockReason: "master_code_unresolved",
        name: `未確認の行為: ${fragment}`,
        display: {
          stem: `未確認の行為: ${fragment}`,
          qualifier: "マスター検索で確認"
        },
        orderType: "procedure",
        points: 0,
        quantity: 1,
        estimatedTotalPoints: 0,
        status: "needs_review",
        candidateOnly: true,
        badges: ["sensor_candidate"],
        badgeDetails: [{ badge: "sensor_candidate", attentionLevel: "required" }],
        comments: []
      });
    }
  }
  return result;
}

function classifySidecarNotice(notice, context) {
  const detailText = String(notice.detailText || "");
  const targetCode = sidecarNoticeTargetCode(notice, detailText);
  const requiredComment = parseRequiredComment(detailText, context.serviceDate);
  if (requiredComment) {
    return classified(notice, {
      kind: "attached_comment",
      targetCode: requiredComment.targetCode,
      shortText: requiredComment.status === "generated"
        ? `${requiredComment.shortName}を作成済み`
        : `${requiredComment.shortName}を記入`,
      audience: "clinician",
      placement: requiredComment.status === "generated" ? "candidate" : "candidate_checklist",
      checklist: requiredComment.status === "input_required",
      attentionLevel: requiredComment.status === "generated" ? "reference" : "recommended",
      comment: requiredComment
    });
  }

  if (/施設恒常算定ルール/u.test(detailText)) {
    return classified(notice, {
      kind: "line_provenance",
      targetCode,
      shortText: "施設ルールを確認",
      audience: "clinician",
      placement: "candidate",
      checklist: false,
      badge: "facility_rule"
    });
  }

  if (
    notice.source === "same_household_visit_governance"
    || /^same_household_/u.test(String(notice.issueCode || ""))
    || /同一患家/u.test(detailText)
  ) {
    const status = String(notice?.metadata?.status || context?.calculation?.metrics?.sameHouseholdVisit?.status || "");
    const second = status === "second_visit" || /2人目|二人目/u.test(detailText);
    const first = status === "first_visit" || /1人目|一人目/u.test(detailText);
    return classified(notice, {
      kind: "line_annotation",
      targetCode: targetCode || sameHouseholdTargetCode(context.candidates),
      shortText: second
        ? "同一患家2人目の算定差替えを確認"
        : first
          ? "同一患家1人目の訪問順を確認"
          : "同一患家の訪問順を確認",
      audience: "clinician",
      placement: second ? "candidate_checklist" : "candidate",
      checklist: second,
      badge: second
        ? "same_household_second"
        : first
          ? "same_household_first"
          : "same_household_unresolved"
    });
  }

  if (
    notice.issueCode === "management_continuation_not_performed"
    || notice.source === "management_continuation_gate"
    || /継続方針の記載です/u.test(detailText)
  ) {
    return classified(notice, {
      kind: "suppressed_explanation",
      targetCode,
      shortText: "不算定理由を確認",
      audience: "clinician",
      placement: "detail",
      checklist: false
    });
  }

  if (/在宅区分の算定方針/u.test(detailText)) {
    return classified(notice, {
      kind: "policy_explanation",
      targetCode,
      shortText: "基本料の算定方針を確認",
      audience: "clinician",
      placement: "detail",
      checklist: false
    });
  }

  if (isFacilityConfigNotice(notice, detailText)) {
    const applicable = facilityConfigNoticeApplies(detailText, context.calculation);
    return classified(notice, {
      kind: "facility_config",
      targetCode,
      shortText: facilityConfigShortText(detailText),
      audience: "admin",
      placement: applicable ? "checklist" : "detail",
      checklist: applicable,
      applicabilityMatched: applicable
    });
  }

  if (isSensorNotice(notice, detailText)) {
    return classified(notice, {
      kind: "sensor_candidate",
      targetCode,
      shortText: "未確認の行為をマスター検索で確認",
      audience: "clinician",
      placement: "proposal",
      checklist: false,
      sensor: sensorNoticeDetails(notice, detailText)
    });
  }

  return classified(notice, {
    kind: "detail_log",
    targetCode,
    shortText: shortReviewText(notice),
    audience: "clinician",
    placement: "detail",
    checklist: false
  });
}

function parseRequiredComment(detailText, serviceDate) {
  const japanese = String(detailText || "").match(
    /レセプトコメントの確認\s*[:：]\s*(\d{6,})\s+(.+?)\s+に必要なコメント\s*[:：]\s*(\d{6,})\s+(.+)$/u
  );
  const english = String(detailText || "").match(
    /Required comment candidate:\s*(\d{6,})\s+(.+?)\s+needs\s+(\d{6,})\s+(.+)$/iu
  );
  const match = japanese || english;
  if (!match) {
    return null;
  }
  const targetCode = match[1];
  const commentCode = match[3];
  const name = String(match[4] || "").trim().replace(/[；;]\s*$/u, "");
  const formattedDate = formatJapaneseReceiptDate(serviceDate);
  const generated = GENERATED_DATE_COMMENT_CODES.has(commentCode) && Boolean(formattedDate);
  return {
    commentCode,
    name,
    shortName: requiredCommentShortName(commentCode, name),
    status: generated ? "generated" : "input_required",
    text: generated ? `${name}；${formattedDate}` : "",
    targetCode
  };
}

function requiredCommentShortName(commentCode, name) {
  if (commentCode === "830100088") {
    return "頻回訪問の必要性コメント";
  }
  if (commentCode === "850100094") {
    return "必要性を認めた診療年月日";
  }
  if (commentCode === "850100095") {
    return "訪問診療年月日";
  }
  return String(name || "レセプトコメント")
    .replace(/[（(].*$/u, "")
    .trim() || "レセプトコメント";
}

function sidecarNoticeTargetCode(notice, detailText) {
  const explicit = String(notice?.targetCode || notice?.code || "").trim();
  if (/^\d{6,}$/u.test(explicit)) {
    return explicit;
  }
  return String(detailText || "").match(/(?:^|[:：\s(（])(\d{6,})(?=$|[\s)）])/u)?.[1] || null;
}

function sameHouseholdTargetCode(candidates = []) {
  const replacement = asArray(candidates).find((candidate) => (
    candidate?.basis === "same_household_second_visit_review_candidate"
  ));
  if (replacement?.code) {
    return String(replacement.code);
  }
  const visitFee = asArray(candidates).find(isVisitFeeCandidate);
  return visitFee?.code ? String(visitFee.code) : null;
}

function isVisitFeeCandidate(candidate = {}) {
  return /(?:在宅患者訪問診療料|往診料|再診料)/u.test(String(candidate?.name || candidate?.display?.stem || ""));
}

function isFacilityConfigNotice(notice, detailText) {
  return (
    /^施設基準確認\s*[:：]/u.test(detailText)
    || notice.issueCode === "facility_unknown"
    || notice.issueCode === "facility_notification_unknown"
  );
}

function facilityConfigNoticeApplies(detailText, calculation = {}) {
  if (!/検体検査管理加算/u.test(detailText)) {
    return true;
  }
  const relevantText = [
    ...asArray(calculation?.lineItems),
    ...asArray(calculation?.candidateProposals)
  ].flatMap((entry) => [
    entry?.name,
    entry?.title,
    entry?.candidateLine?.name,
    entry?.orderType
  ]).join(" ");
  if (/(?:検体検査|検査判断料|採血|血液|尿|便|微生物|免疫|生化学|\blab\b)/iu.test(relevantText)) {
    return true;
  }
  return asArray(calculation?.clinicalEvents).some((event) => (
    ["lab", "pathology"].includes(String(event?.event_type || event?.eventType || event?.category || "").toLowerCase())
  ));
}

function facilityConfigShortText(detailText) {
  if (/検体検査管理加算/u.test(detailText)) {
    return "検体検査管理加算の届出を確認";
  }
  return "施設基準の届出を確認";
}

function isSensorNotice(notice, detailText) {
  return [
    "auxiliary_extraction_unresolved",
    "line_coverage_gap",
    "line_review_incomplete",
    "empty_clinical_extraction"
  ].includes(String(notice.issueCode || ""))
    || /(?:未反映|抽出漏れの可能性)/u.test(detailText);
}

function sensorNoticeDetails(notice, detailText) {
  const fragments = uniqueStrings([
    ...asArray(notice?.sidecarDisplay?.fragments),
    ...asArray(notice?.metadata?.sidecarDisplayFragments),
    ...evidenceFragments(notice?.evidence)
  ]).map((value) => String(value).slice(0, 80));
  const count = Number(
    String(detailText || "").match(/(\d+)件/u)?.[1]
    || fragments.length
    || 1
  );
  return {
    count: Math.max(1, count),
    fragments
  };
}

function evidenceFragments(value) {
  return String(value || "")
    .split(/\s*\/\s*|\n+/u)
    .map((entry) => entry.replace(/^[A-Z]\d+「|」$/gu, "").trim())
    .filter(Boolean);
}

function classified(notice, fields) {
  if (!SIDECAR_NOTICE_KINDS.includes(fields.kind)) {
    throw new Error(`unsupported sidecar notice kind: ${fields.kind}`);
  }
  return {
    ...notice,
    ...fields,
    attentionLevel: normalizeAttentionLevel(
      fields.attentionLevel || notice.attentionLevel,
      notice.severity
    ),
    targetCode: fields.targetCode || null,
    shortText: String(fields.shortText || "内容を確認").trim(),
    detailText: String(notice.detailText || notice.messageForStaff || "").trim(),
    audience: fields.audience === "admin" ? "admin" : "clinician",
    occurredAt: notice.occurredAt || null
  };
}

function normalizeAttentionLevel(value, severity = "info") {
  const explicit = String(value || "").trim();
  if (["required", "recommended", "reference"].includes(explicit)) return explicit;
  const normalizedSeverity = normalizeSidecarNoticeSeverity(severity);
  if (["critical", "error"].includes(normalizedSeverity)) return "required";
  return normalizedSeverity === "warning" ? "recommended" : "reference";
}

function shortReviewText(notice) {
  const title = String(notice?.title || notice?.topicLabel || "").trim();
  return title ? `${title}を確認` : "詳細内容を確認";
}

function reviewIssueDeduplicationKey(issue = {}, normalizedMessage = "") {
  const topic = String(issue.topicCode || issue.reviewTopic || "").trim();
  const issueCode = String(issue.issueCode || "").trim();
  const target = String(
    issue.relatedClinicalEventId
    || issue.clinicalEventId
    || issue.sourceFactId
    || issue.targetId
    || issue.candidateId
    || ""
  ).trim();
  if (topic) {
    return `topic|${topic}|${target || normalizedMessage}`;
  }
  return `issue|${issueCode || "unclassified"}|${target}|${normalizedMessage}`;
}

function sidecarNoticeMessage(notice) {
  if (typeof notice === "string") {
    return notice.trim();
  }
  return String(
    notice?.messageForStaff
    || notice?.message
    || notice?.reason
    || notice?.title
    || ""
  ).trim();
}

function normalizeSidecarNoticeText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeSidecarNoticeSeverity(value, fallback = "info") {
  const severity = String(value || "").trim().toLowerCase();
  return ["critical", "error", "warning", "info"].includes(severity) ? severity : fallback;
}

function noticeSeverityOrder(value) {
  return {
    critical: 0,
    error: 1,
    warning: 2,
    info: 3
  }[normalizeSidecarNoticeSeverity(value)] ?? 4;
}

function sidecarNoticeId(value = "") {
  return `notice_${crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20)}`;
}

function uniqueSidecarCandidates(candidates = []) {
  const seen = new Set();
  return asArray(candidates).filter((candidate) => {
    const key = [
      candidate?.sourceType,
      candidate?.candidateId,
      candidate?.code,
      candidate?.name
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueComments(comments = []) {
  const seen = new Set();
  return asArray(comments).filter((comment) => {
    const key = [
      comment?.targetCode,
      comment?.commentCode,
      comment?.status,
      comment?.text
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
