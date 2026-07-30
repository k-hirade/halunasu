import { encounterBasicFeeCoverage } from "./facility-service-schedule.js";

export function applyFeeRuleVersionCoverageToPreparation(prepared = {}, {
  serviceDate = ""
} = {}) {
  const coverage = encounterBasicFeeCoverage(serviceDate);
  const result = {
    ...prepared,
    metrics: {
      ...(prepared.metrics || {}),
      feeRuleVersionCoverage: coverage
    }
  };
  if (coverage.status !== "unavailable") {
    return result;
  }

  const message = [
    `診療日${coverage.serviceDate}に適用可能な点数表・ルール版がありません。`,
    `現在ロード済みの基本診療料ルールは${coverage.availableFrom}以降（revision ${coverage.revision}）です。`,
    "対象日の正式な点数表・マスターを登録してから再計算してください。"
  ].join("");
  const issue = {
    reviewIssueId: `fee_rule_version_unavailable_${coverage.serviceDate}`,
    issueCode: "fee_rule_version_unavailable",
    severity: "error",
    title: "点数表・ルール版の確認",
    topicCode: "fee_rule_version_check",
    topicLabel: "点数表版の確認",
    messageForStaff: message,
    requiredInput: "診療日に有効な点数表・診療行為マスター・算定ルール版",
    source: "fee_rule_version_coverage",
    metadata: coverage
  };
  return {
    ...result,
    reviewIssues: appendUniqueIssue(prepared.reviewIssues, issue),
    reviewWarnings: uniqueStrings([
      ...asArray(prepared.reviewWarnings),
      message
    ])
  };
}

function appendUniqueIssue(issues, issue) {
  const current = asArray(issues);
  return current.some((entry) => entry?.issueCode === issue.issueCode)
    ? current
    : [...current, issue];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
