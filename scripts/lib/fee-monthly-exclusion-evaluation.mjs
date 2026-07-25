import crypto from "node:crypto";

const supportedResolutionActions = Object.freeze({
  auto_winner: ["acknowledge_auto", "reject_both"],
  demote_lower_points: ["choose_a", "choose_b", "reject_both"],
  conditional_review: ["choose_a", "choose_b", "allow_both_with_basis", "reject_both"],
  unsupported_rule_kind: []
});

export function sanitizeMonthlyExclusion(receipt = {}) {
  const conflicts = asArray(receipt.exclusionConflicts).map((conflict) => ({
    conflictId: stringOrNull(conflict.conflictId),
    componentId: stringOrNull(conflict.componentId),
    componentSize: numberOrZero(conflict.componentSize),
    complex: conflict.complex === true,
    scope: stringOrNull(conflict.scope),
    scopeKey: stringOrNull(conflict.scopeKey),
    pairKey: stringOrNull(conflict.pairKey),
    ruleFingerprint: stringOrNull(conflict.ruleFingerprint),
    codeA: stringOrNull(conflict.codeA),
    codeB: stringOrNull(conflict.codeB),
    resolution: stringOrNull(conflict.resolution),
    defaultAction: stringOrNull(conflict.defaultAction),
    action: stringOrNull(conflict.action),
    allowedActions: strings(conflict.allowedActions),
    status: stringOrNull(conflict.status),
    blockingExport: conflict.blockingExport === true,
    blockedOccurrenceCount: asArray(conflict.blockedOccurrenceIds).length,
    candidateOccurrenceCount: asArray(conflict.candidateOccurrenceIds).length
  }));
  return {
    mode: String(receipt.exclusionMode || "off"),
    constraintsStatus: String(receipt.exclusionConstraintsStatus || "not_requested"),
    conflictCount: conflicts.length,
    unresolvedConflictCount: numberOrZero(receipt.unresolvedExclusionCount),
    complexComponentCount: numberOrZero(receipt.complexExclusionComponentCount),
    blockedLineCount: asArray(receipt.blockedLines).length,
    previewBlockedLineCount: asArray(receipt.blockedLinesPreview).length,
    blockedCodes: uniqueCodes(receipt.blockedLines),
    previewBlockedCodes: uniqueCodes(receipt.blockedLinesPreview),
    conflicts
  };
}

export function buildMonthlyExclusionResolutionPlan(exclusion = {}, {
  action = "default",
  basisNote = "STG月次背反E2Eによる検証用解決"
} = {}) {
  const requestedAction = String(action || "default").trim();
  const plan = [];
  let alreadyResolvedCount = 0;
  let complexSkippedCount = 0;
  let unsupportedSkippedCount = 0;
  for (const conflict of asArray(exclusion.conflicts)) {
    if (conflict.complex === true) {
      complexSkippedCount += 1;
      continue;
    }
    if (String(conflict.status || "") === "resolved" || conflict.action) {
      alreadyResolvedCount += 1;
      continue;
    }
    const allowedActions = strings(conflict.allowedActions).length
      ? strings(conflict.allowedActions)
      : (supportedResolutionActions[String(conflict.resolution || "")] || []);
    const selectedAction = requestedAction === "default"
      ? String(conflict.defaultAction || "")
      : requestedAction;
    if (!selectedAction || !allowedActions.includes(selectedAction)) {
      unsupportedSkippedCount += 1;
      continue;
    }
    plan.push({
      pairKey: required(conflict.pairKey, "pairKey"),
      scopeKey: required(conflict.scopeKey, "scopeKey"),
      ruleFingerprint: required(conflict.ruleFingerprint, "ruleFingerprint"),
      resolution: required(conflict.resolution, "resolution"),
      action: selectedAction,
      ...(selectedAction === "allow_both_with_basis" ? { basisNote } : {})
    });
  }
  return {
    requestedAction,
    plannedCount: plan.length,
    alreadyResolvedCount,
    complexSkippedCount,
    unsupportedSkippedCount,
    plan
  };
}

export function sanitizeMonthlyExportResponse(response = {}, {
  forbiddenCodes = []
} = {}) {
  const contentType = String(response.responseHeaders?.["content-type"] || "");
  const body = String(response.rawBody || "");
  const forbiddenCodeChecks = [...new Set(
    forbiddenCodes.map((code) => String(code || "").trim()).filter(Boolean)
  )].sort().map((code) => ({
    code,
    present: body.includes(code)
  }));
  return {
    statusCode: Number(response.statusCode || 0),
    durationMs: Number(response.durationMs || 0),
    contentType: contentType || null,
    byteLength: Buffer.byteLength(body),
    sha256: body ? crypto.createHash("sha256").update(body).digest("hex") : null,
    validationIssueCount: asArray(response.body?.receiptExportValidation?.issues).length,
    forbiddenCodeChecks,
    allForbiddenCodesAbsent: forbiddenCodeChecks.every((item) => !item.present)
  };
}

export function summarizeMonthlyExclusionRuns(repeats = []) {
  const rows = repeats
    .map((item) => item?.monthlyExclusionResolution)
    .filter(Boolean);
  if (!rows.length) {
    return null;
  }
  return {
    enabled: true,
    requestedActions: [...new Set(rows.map((row) => row.requestedAction).filter(Boolean))].sort(),
    initialConflictCounts: rows.map((row) => numberOrZero(row.before?.conflictCount)),
    initialUnresolvedCounts: rows.map((row) => numberOrZero(row.before?.unresolvedConflictCount)),
    plannedCounts: rows.map((row) => numberOrZero(row.plan?.plannedCount)),
    resolvedCounts: rows.map((row) => numberOrZero(row.resolvedCount)),
    failedCounts: rows.map((row) => numberOrZero(row.failedCount)),
    skippedComplexCounts: rows.map((row) => numberOrZero(row.plan?.complexSkippedCount)),
    skippedUnsupportedCounts: rows.map((row) => (
      numberOrZero(row.plan?.unsupportedSkippedCount) + numberOrZero(row.skippedUnsupportedCount)
    )),
    finalUnresolvedCounts: rows.map((row) => numberOrZero(row.after?.unresolvedConflictCount)),
    csvStatusBefore: rows.map((row) => numberOrZero(row.exports?.before?.csv?.statusCode)),
    csvStatusAfter: rows.map((row) => numberOrZero(row.exports?.after?.csv?.statusCode)),
    ukeStatusBefore: rows.map((row) => numberOrZero(row.exports?.before?.uke?.statusCode)),
    ukeStatusAfter: rows.map((row) => numberOrZero(row.exports?.after?.uke?.statusCode)),
    allAfterExportsExcludeBlockedCodes: rows.every((row) => (
      row.exports?.after?.csv?.statusCode < 400
      && row.exports?.after?.uke?.statusCode < 400
      && row.exports?.after?.csv?.allForbiddenCodesAbsent === true
      && row.exports?.after?.uke?.allForbiddenCodesAbsent === true
    )),
    allPlannedResolutionsSucceeded: rows.every((row) => (
      numberOrZero(row.failedCount) === 0
      && numberOrZero(row.resolvedCount) === numberOrZero(row.plan?.plannedCount)
    ))
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function strings(value) {
  return asArray(value).map((item) => String(item || "").trim()).filter(Boolean);
}

function uniqueCodes(lines) {
  return [...new Set(
    asArray(lines)
      .map((line) => String(line?.code || line?.feeCode || "").trim())
      .filter(Boolean)
  )].sort();
}

function stringOrNull(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function required(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`monthly exclusion conflict is missing ${field}`);
  }
  return normalized;
}
