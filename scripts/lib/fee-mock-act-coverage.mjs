import crypto from "node:crypto";

const CLAIM_ATTRIBUTE_PATTERNS = Object.freeze([
  /^(?:訪問診療年月日|往診又は訪問診療年月日|初回算定年月日)/u,
  /^単一建物診療患者数/u
]);

const CLAIM_COMMENT_PATTERNS = Object.freeze([
  /^同一患家/u,
  /(?:必要性|理由|頻回).*(?:訪問診療|往診)/u
]);

const PATIENT_CHARGE_PATTERNS = Object.freeze([
  // 厚生労働省「診療報酬の算定方法」別表第一 第2章第2部
  // C000 往診料 注7: 往診に要した交通費は患家の負担とする。
  // https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0&pageNo=6
  /^往診交通費/u
]);

const BILLABLE_NAME_PATTERN = /(?:診療料|管理料|指導料|交付料|評価料|再診料|加算|採血|検査|往診|カテーテル|チューブ|人工鼻|酸素ボンベ|酸素濃縮装置)/u;

export const MOCK_ACT_CLASSES = Object.freeze([
  "billable_line",
  "claim_comment",
  "claim_attribute",
  "patient_charge",
  "unknown"
]);

export function normalizeMockActionName(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/令和\s*\d+\s*年\s*\d+\s*月\s*\d+\s*日/gu, "{date}")
    .replace(/単一建物診療患者数[（(]施医総管[）)][；;]\d+/gu, "単一建物診療患者数(施医総管);{count}")
    .replace(/同一患家\s*[\d日、,・\s]+/gu, "同一患家 {dates}")
    .replace(/\s+/gu, "");
}

export function classifyMockAction(actionName = "", mapping = null) {
  const normalized = normalizeMockActionName(actionName);
  if (!normalized) {
    return "unknown";
  }
  const mappedClass = String(mapping?.action_class || mapping?.actionClass || "").trim();
  if (MOCK_ACT_CLASSES.includes(mappedClass)) {
    return mappedClass;
  }
  if (PATIENT_CHARGE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "patient_charge";
  }
  if (CLAIM_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "claim_attribute";
  }
  if (CLAIM_COMMENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "claim_comment";
  }
  const status = String(mapping?.match_status || mapping?.matchStatus || "").trim();
  if (["exact_master_name", "ambiguous_exact_master_name", "manual_required"].includes(status)) {
    return "billable_line";
  }
  if (status === "comment_or_nonclaim") {
    return "unknown";
  }
  return BILLABLE_NAME_PATTERN.test(normalized) ? "billable_line" : "unknown";
}

export function buildMockActionMappingIndex(rows = []) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = [
      row?.action_key,
      row?.normalized_action_name,
      row?.sample_action_name
    ].map(normalizeMockActionName).filter(Boolean);
    for (const key of keys) {
      if (!index.has(key)) {
        index.set(key, row);
      }
    }
  }
  return index;
}

export function auditMockActCoverageCase(testCase = {}, calculation = {}, mappingRows = []) {
  const mappingIndex = buildMockActionMappingIndex(mappingRows);
  const candidates = expandCalculationCandidateUnits(
    normalizeCalculationCandidates(calculation),
    mappingRows,
    String(testCase.caseId || "")
  );
  const notices = normalizeCalculationNotices(calculation);
  const gold = (Array.isArray(testCase.actionList) ? testCase.actionList : []).map((actionName, index) => {
    const normalizedName = normalizeMockActionName(actionName);
    const mapping = mappingIndex.get(normalizedName) || null;
    const actionClass = classifyMockAction(actionName, mapping);
    const match = actionClass === "claim_comment"
        ? matchClaimComment(actionName, notices)
        : null;
    return {
      actionIndex: index + 1,
      actionClass,
      normalizedName,
      expectedCode: String(mapping?.code || "").trim() || null,
      candidateCodes: mappingCandidateCodes(mapping),
      billingScope: mappingBillingScope(mapping),
      billingScopeSource: String(mapping?.billing_scope_source || "").trim()
        || "conservative_default:missing_scope_metadata",
      expectedQuantity: positiveInteger(mapping?.expected_quantity) || 1,
      matchStatus: match?.status || (
        actionClass === "patient_charge" ? "excluded_from_billable_denominator"
          : actionClass === "claim_attribute" ? "attribute_only"
            : actionClass === "unknown" ? "unknown"
              : actionClass === "billable_line" && mappingBillingScope(mapping) === "per_month"
                ? "pending_monthly"
                : "missing"
      ),
      matchedCode: match?.candidate?.code || null,
      matchedSourceType: match?.candidate?.sourceType || null,
      matchedCandidateKey: null,
      matchedServiceDate: null
    };
  });
  const consumedCandidateKeys = new Set();
  for (const item of gold) {
    if (item.actionClass !== "billable_line" || item.billingScope !== "per_visit") {
      continue;
    }
    const mapping = mappingIndex.get(item.normalizedName) || null;
    const candidate = candidates.find((entry) => (
      entry.billingScope === "per_visit"
      && !consumedCandidateKeys.has(entry.candidateKey)
      && candidateMatchesGold(entry, item, mapping)
    ));
    if (!candidate) {
      continue;
    }
    applyCandidateMatch(item, candidate, String(testCase.serviceDate || ""));
    consumedCandidateKeys.add(candidate.candidateKey);
  }
  const falseProposals = candidates
    .filter((candidate) => (
      candidate.billingScope === "per_visit"
      && !consumedCandidateKeys.has(candidate.candidateKey)
    ))
    .map(safeCandidate);

  return {
    caseId: String(testCase.caseId || ""),
    patientId: String(testCase.patientId || ""),
    serviceDate: String(testCase.serviceDate || ""),
    setting: String(testCase.setting || ""),
    clinicalTextSha256: sha256(String(testCase.clinicalText || "")),
    gold,
    actual: {
      candidateCount: candidates.length,
      falseProposalCount: falseProposals.length,
      falseProposals,
      candidateInventory: candidates.map(safeCandidate),
      consumedCandidateKeys: [...consumedCandidateKeys],
      matchedCandidateKeyCount: consumedCandidateKeys.size,
      duplicateMonthlyCandidateCount: 0
    },
    metrics: summarizeCaseGold(gold)
  };
}

export function reconcileMockActCoverageRuns(runs = [], mappingRows = []) {
  const values = Array.isArray(runs) ? runs : [];
  const mappingIndex = buildMockActionMappingIndex(mappingRows);
  const groups = new Map();
  for (const run of values) {
    const claimMonth = String(run?.serviceDate || "").slice(0, 7);
    const key = `${String(run?.patientId || "")}:${claimMonth}`;
    if (!groups.has(key)) {
      groups.set(key, {
        patientId: String(run?.patientId || ""),
        claimMonth,
        runs: []
      });
    }
    groups.get(key).runs.push(run);
  }

  for (const group of groups.values()) {
    reconcilePatientMonthGroup(group, mappingIndex);
  }
  for (const run of values) {
    run.metrics = summarizeCaseGold(run.gold);
    run.actual.falseProposalCount = asArray(run.actual.falseProposals).length;
    run.actual.matchedCandidateKeyCount = run.gold.filter((item) => item.matchedCandidateKey).length;
  }
  return values;
}

export function summarizeMockActCoverage(runs = []) {
  const totals = {
    caseCount: 0,
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0,
    commentCount: 0,
    commentDetectedCount: 0,
    claimAttributeCount: 0,
    patientChargeCount: 0,
    unknownCount: 0,
    falseProposalCount: 0
  };
  const byScope = {
    per_visit: emptyBillableTotals(),
    per_month: emptyBillableTotals()
  };
  const byClaimMonth = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    totals.caseCount += 1;
    for (const key of Object.keys(totals)) {
      if (key === "caseCount") {
        continue;
      }
      totals[key] += Number(run?.metrics?.[key] ?? run?.actual?.[key] ?? 0);
    }
    for (const item of asArray(run?.gold)) {
      if (item.actionClass !== "billable_line") {
        continue;
      }
      const scope = item.billingScope === "per_month" ? "per_month" : "per_visit";
      addBillableOutcome(byScope[scope], item);
      const month = String(run?.serviceDate || "").slice(0, 7) || "unknown";
      if (!byClaimMonth[month]) {
        byClaimMonth[month] = emptyBillableTotals();
      }
      addBillableOutcome(byClaimMonth[month], item);
    }
  }
  const matchedBillableCount = totals.confirmedCount + totals.candidateCount;
  return {
    ...totals,
    matchedBillableCount,
    billableMatchRate: ratio(matchedBillableCount, totals.billableCount),
    confirmedBillableRate: ratio(totals.confirmedCount, totals.billableCount),
    commentDetectionRate: ratio(totals.commentDetectedCount, totals.commentCount),
    byScope: Object.fromEntries(
      Object.entries(byScope).map(([key, value]) => [key, finalizeBillableTotals(value)])
    ),
    byClaimMonth: Object.fromEntries(
      Object.entries(byClaimMonth).map(([key, value]) => [key, finalizeBillableTotals(value)])
    )
  };
}

export function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(text || "");
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === "\"" && value[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  const [headers = [], ...data] = rows.filter((entry) => entry.some((cell) => cell !== ""));
  return data.map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] || ""])));
}

function normalizeCalculationCandidates(calculation = {}) {
  const source = calculation?.sidecarDraft?.calculation || calculation?.calculation || calculation;
  return (Array.isArray(source?.candidates) ? source.candidates : []).map((candidate, index) => ({
    sourceIndex: index,
    sourceType: String(candidate?.sourceType || ""),
    code: String(candidate?.code || candidate?.candidateLine?.code || "").trim(),
    codeCandidates: uniqueStrings(candidate?.codeCandidates || candidate?.candidateLine?.codeCandidates),
    name: String(
      candidate?.name
      || candidate?.candidateLine?.name
      || candidate?.display?.stem
      || ""
    ).trim(),
    adoptionBlocked: candidate?.adoptionBlocked === true,
    quantity: positiveInteger(
      candidate?.quantity
      ?? candidate?.candidateLine?.quantity
      ?? candidate?.count
    ) || 1
  }));
}

function normalizeCalculationNotices(calculation = {}) {
  const source = calculation?.sidecarDraft?.calculation || calculation?.calculation || calculation;
  const values = Array.isArray(source?.notices)
    ? source.notices
    : [
      ...(Array.isArray(source?.warnings) ? source.warnings : []),
      ...(Array.isArray(source?.reviewIssues) ? source.reviewIssues : [])
    ];
  return values.map((notice) => (
    typeof notice === "string"
      ? notice
      : [notice?.title, notice?.messageForStaff, notice?.message].filter(Boolean).join(" ")
  )).map(normalizeMockActionName).filter(Boolean);
}

function expandCalculationCandidateUnits(candidates, mappingRows, caseId) {
  const units = [];
  for (const candidate of asArray(candidates)) {
    const quantity = Math.min(1000, positiveInteger(candidate.quantity) || 1);
    const billingScope = candidateBillingScope(candidate, mappingRows);
    for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
      units.push({
        ...candidate,
        quantity: 1,
        originalQuantity: quantity,
        unitIndex,
        billingScope,
        candidateKey: [
          caseId,
          candidate.sourceIndex,
          unitIndex
        ].join(":")
      });
    }
  }
  return units;
}

function candidateMatchesGold(candidate, gold, mapping) {
  const expectedCodes = new Set([
    String(mapping?.code || "").trim(),
    ...mappingCandidateCodes(mapping)
  ].filter(Boolean));
  if (
    candidate.code && expectedCodes.has(candidate.code)
    || candidate.codeCandidates.some((code) => expectedCodes.has(code))
  ) {
    return true;
  }
  const candidateName = normalizeMockActionName(candidate.name);
  return Boolean(candidateName && candidateName === gold.normalizedName);
}

function candidateBillingScope(candidate, mappingRows) {
  const matching = asArray(mappingRows).filter((mapping) => (
    candidateMatchesGold(candidate, {
      normalizedName: normalizeMockActionName(
        mapping?.normalized_action_name
        || mapping?.sample_action_name
        || mapping?.action_key
      )
    }, mapping)
  ));
  if (
    matching.length
    && matching.every((mapping) => mappingBillingScope(mapping) === "per_month")
  ) {
    return "per_month";
  }
  return "per_visit";
}

function mappingBillingScope(mapping = {}) {
  return String(mapping?.billing_scope || mapping?.billingScope || "") === "per_month"
    ? "per_month"
    : "per_visit";
}

function applyCandidateMatch(gold, candidate, serviceDate) {
  gold.matchStatus = candidate.sourceType === "calculated_line" ? "confirmed" : "candidate";
  gold.matchedCode = candidate.code || null;
  gold.matchedSourceType = candidate.sourceType || null;
  gold.matchedCandidateKey = candidate.candidateKey;
  gold.matchedServiceDate = serviceDate || null;
}

function reconcilePatientMonthGroup(group, mappingIndex) {
  const monthlyGold = [];
  const perVisitConsumed = new Set();
  for (const run of group.runs) {
    for (const key of asArray(run?.actual?.consumedCandidateKeys)) {
      perVisitConsumed.add(key);
    }
    for (const item of asArray(run?.gold)) {
      if (item.actionClass !== "billable_line" || item.billingScope !== "per_month") {
        continue;
      }
      item.matchStatus = "missing";
      item.matchedCode = null;
      item.matchedSourceType = null;
      item.matchedCandidateKey = null;
      item.matchedServiceDate = null;
      monthlyGold.push({ run, item });
    }
  }

  const monthlyUnits = group.runs.flatMap((run) => (
    asArray(run?.actual?.candidateInventory)
      .filter((candidate) => candidate.billingScope === "per_month")
      .map((candidate) => ({ run, candidate }))
  ));
  const deduplicated = dedupeMonthlyCandidateUnits(monthlyUnits);
  const consumedMonthlyKeys = new Set();
  for (const entry of monthlyGold) {
    const mapping = mappingIndex.get(entry.item.normalizedName) || null;
    const match = deduplicated.units.find(({ candidate }) => (
      !consumedMonthlyKeys.has(candidate.monthlyCandidateKey)
      && candidateMatchesGold(candidate, entry.item, mapping)
    ));
    if (!match) {
      continue;
    }
    applyCandidateMatch(entry.item, match.candidate, match.run.serviceDate);
    entry.item.matchedCandidateKey = match.candidate.monthlyCandidateKey;
    consumedMonthlyKeys.add(match.candidate.monthlyCandidateKey);
  }

  for (const run of group.runs) {
    const perVisitFalse = asArray(run?.actual?.candidateInventory)
      .filter((candidate) => (
        candidate.billingScope === "per_visit"
        && !perVisitConsumed.has(candidate.candidateKey)
      ))
      .map(safeCandidate);
    run.actual.falseProposals = perVisitFalse;
    run.actual.duplicateMonthlyCandidateCount = 0;
  }
  for (const duplicate of deduplicated.duplicates) {
    duplicate.run.actual.duplicateMonthlyCandidateCount += 1;
  }
  for (const entry of deduplicated.units) {
    if (consumedMonthlyKeys.has(entry.candidate.monthlyCandidateKey)) {
      continue;
    }
    entry.run.actual.falseProposals.push(safeCandidate(entry.candidate));
  }
}

function dedupeMonthlyCandidateUnits(entries) {
  const byKey = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const baseKey = [
      entry.candidate.code || "",
      asArray(entry.candidate.codeCandidates).slice().sort().join(","),
      normalizeMockActionName(entry.candidate.name),
      entry.candidate.unitIndex || 1
    ].join(":");
    const candidate = {
      ...entry.candidate,
      monthlyCandidateKey: baseKey
    };
    const current = byKey.get(baseKey);
    if (!current) {
      byKey.set(baseKey, { ...entry, candidate });
      continue;
    }
    if (candidateSourceRank(candidate.sourceType) > candidateSourceRank(current.candidate.sourceType)) {
      duplicates.push(current);
      byKey.set(baseKey, { ...entry, candidate });
    } else {
      duplicates.push({ ...entry, candidate });
    }
  }
  return {
    units: [...byKey.values()],
    duplicates
  };
}

function candidateSourceRank(sourceType) {
  return sourceType === "calculated_line" ? 2 : 1;
}

function matchClaimComment(actionName, notices) {
  const normalized = normalizeMockActionName(actionName);
  const stem = normalized.replace(/\{date\}|\{count\}|\{dates\}/gu, "");
  const found = notices.some((notice) => notice.includes(stem) || stem.includes(notice));
  return found ? { status: "comment_detected", candidate: null } : null;
}

function mappingCandidateCodes(mapping = {}) {
  return uniqueStrings(
    String(mapping?.candidate_codes || mapping?.candidateCodes || "")
      .split(";")
      .map((entry) => entry.split(":")[1] || "")
  );
}

function summarizeCaseGold(gold = []) {
  const metrics = {
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0,
    commentCount: 0,
    commentDetectedCount: 0,
    claimAttributeCount: 0,
    patientChargeCount: 0,
    unknownCount: 0
  };
  for (const item of gold) {
    if (item.actionClass === "billable_line") {
      metrics.billableCount += 1;
      if (item.matchStatus === "confirmed") metrics.confirmedCount += 1;
      else if (item.matchStatus === "candidate") metrics.candidateCount += 1;
      else metrics.missingCount += 1;
    } else if (item.actionClass === "claim_comment") {
      metrics.commentCount += 1;
      if (item.matchStatus === "comment_detected") metrics.commentDetectedCount += 1;
    } else if (item.actionClass === "claim_attribute") {
      metrics.claimAttributeCount += 1;
    } else if (item.actionClass === "patient_charge") {
      metrics.patientChargeCount += 1;
    } else {
      metrics.unknownCount += 1;
    }
  }
  return metrics;
}

function safeCandidate(candidate = {}) {
  return {
    candidateKey: candidate.candidateKey || null,
    monthlyCandidateKey: candidate.monthlyCandidateKey || null,
    sourceType: candidate.sourceType,
    code: candidate.code || null,
    codeCandidates: candidate.codeCandidates,
    normalizedName: normalizeMockActionName(candidate.name),
    adoptionBlocked: candidate.adoptionBlocked,
    billingScope: candidate.billingScope === "per_month" ? "per_month" : "per_visit",
    unitIndex: positiveInteger(candidate.unitIndex) || 1,
    originalQuantity: positiveInteger(candidate.originalQuantity) || 1
  };
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function emptyBillableTotals() {
  return {
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0
  };
}

function addBillableOutcome(target, item) {
  target.billableCount += 1;
  if (item.matchStatus === "confirmed") target.confirmedCount += 1;
  else if (item.matchStatus === "candidate") target.candidateCount += 1;
  else target.missingCount += 1;
}

function finalizeBillableTotals(value) {
  const matchedBillableCount = value.confirmedCount + value.candidateCount;
  return {
    ...value,
    matchedBillableCount,
    billableMatchRate: ratio(matchedBillableCount, value.billableCount),
    confirmedBillableRate: ratio(value.confirmedCount, value.billableCount)
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}
