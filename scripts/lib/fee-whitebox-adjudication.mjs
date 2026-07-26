import crypto from "node:crypto";

import { requiredWhiteboxCells } from "./fee-whitebox-shadow-matrix.mjs";

const REVIEWED_STATUS = "human_reviewed";

export function prepareWhiteboxAdjudicationQueue({
  runManifest,
  dataset,
  policy,
  bindings,
  additionalPerCell = 1
}) {
  const evaluationPurpose = assertRunManifest(runManifest);
  const additionalCount = nonnegativeInteger(
    additionalPerCell,
    "additionalPerCell"
  );
  const datasetCases = new Map(
    (Array.isArray(dataset?.cases) ? dataset.cases : [])
      .map((item) => [String(item?.caseId || "").trim(), item])
      .filter(([caseId]) => caseId)
  );
  const measurements = (runManifest.runs || [])
    .filter((run) => String(run?.runKind || "measurement") !== "determinism_control")
    .map((run) => {
      const caseId = String(run?.caseId || "").trim();
      const sourceCase = datasetCases.get(caseId);
      if (!sourceCase) {
        throw new Error(`run manifest case is missing from dataset: ${caseId}`);
      }
      const precheck = objectValue(run.machinePrecheck);
      const encoderCodes = uniqueStrings(precheck.encoderCodes);
      const llmCodes = uniqueStrings(precheck.llmCodes);
      return {
        run,
        sourceCase,
        caseId,
        cell: String(run?.measurementCell || "").trim(),
        encoderCodes,
        llmCodes,
        hasDisagreement: !sameStringSet(encoderCodes, llmCodes)
      };
    });
  const requiredCells = requiredWhiteboxCells(policy).map((item) => item.cell);
  const selected = [];
  const holdoutUsed = runManifest.source.holdoutUsed;
  for (const cell of requiredCells) {
    const candidates = measurements.filter((item) => item.cell === cell);
    if (!candidates.length) {
      continue;
    }
    if (holdoutUsed) {
      selected.push(...candidates.map((item) => ({
        ...item,
        selectionReasons: [
          ...(item.hasDisagreement ? ["encoder_llm_disagreement"] : []),
          "promotion_coverage"
        ]
      })));
      continue;
    }
    const disagreements = candidates.filter((item) => item.hasDisagreement);
    const agreementPool = candidates
      .filter((item) => !item.hasDisagreement)
      .sort((left, right) => deterministicRank(
        runManifest.runId,
        left.caseId
      ).localeCompare(deterministicRank(runManifest.runId, right.caseId)));
    const additions = agreementPool.slice(0, additionalCount);
    selected.push(
      ...disagreements.map((item) => ({
        ...item,
        selectionReasons: ["encoder_llm_disagreement"]
      })),
      ...additions.map((item) => ({
        ...item,
        selectionReasons: ["deterministic_cell_sample"]
      }))
    );
  }
  const items = selected
    .sort((left, right) => (
      left.cell.localeCompare(right.cell)
      || left.caseId.localeCompare(right.caseId)
    ))
    .map((item) => reviewItem(item, runManifest.runId));
  const coverage = summarizeQueueCoverage(items, policy);
  const queue = {
    schemaVersion: "fee-whitebox-adjudication-queue-v1",
    generatedAt: new Date().toISOString(),
    status: "pending_independent_review",
    purpose: evaluationPurpose,
    promotionEligibleSource: evaluationPurpose === "promotion",
    source: {
      runId: String(runManifest.runId || ""),
      runManifestSha256: String(bindings?.runManifestSha256 || ""),
      dataset: String(runManifest.source?.dataset || ""),
      datasetSha256: String(bindings?.datasetSha256 || ""),
      policy: String(runManifest.source?.policy || ""),
      policySha256: String(bindings?.policySha256 || ""),
      cloudRunRevision: String(runManifest.environment?.cloudRunRevision || ""),
      extractorVersions: objectValue(runManifest.environment?.artifactVersions),
      determinism: objectValue(runManifest.determinism)
    },
    selection: {
      measurementRunCount: measurements.length,
      disagreementItemCount: items.filter((item) => (
        item.selectionReasons.includes("encoder_llm_disagreement")
      )).length,
      additionalPerCell: additionalCount,
      selectedItemCount: items.length,
      method: "all disagreements plus deterministic per-cell agreement sample"
    },
    coverage,
    instructions: [
      "Review the clinical text independently; encoder/LLM agreement is not gold truth.",
      "Enter every correct current-visit own-provider code in humanReview.truthCodes, including codes missed by both systems.",
      "Set truthSpanCount to the number of reviewed billable spans, not the number of unique codes.",
      "dangerousFalsePositiveCodes must be encoder false positives and dangerousNegativeOpportunityCount must be explicitly reviewed.",
      "Do not change source, selection, machineComparison, or reviewItemId."
    ],
    items
  };
  queue.immutableSha256 = sha256(stableJson(immutableQueuePayload(queue)));
  return queue;
}

export function compileWhiteboxAdjudication(queue, policy) {
  if (queue?.schemaVersion !== "fee-whitebox-adjudication-queue-v1") {
    throw new Error("queue must use fee-whitebox-adjudication-queue-v1");
  }
  if (!["diagnostic", "promotion"].includes(queue.purpose)) {
    throw new Error("queue purpose must be diagnostic or promotion");
  }
  if (
    (queue.purpose === "promotion")
    !== (queue.promotionEligibleSource === true)
  ) {
    throw new Error("queue purpose and promotionEligibleSource are inconsistent");
  }
  if (
    sha256(stableJson(immutableQueuePayload(queue)))
    !== String(queue.immutableSha256 || "")
  ) {
    throw new Error("adjudication queue immutable payload hash mismatch");
  }
  const items = Array.isArray(queue.items) ? queue.items : [];
  if (!items.length) {
    throw new Error("adjudication queue has no items");
  }
  const expectedCells = requiredWhiteboxCells(policy);
  const byCell = new Map(expectedCells.map((item) => [item.cell, emptyCell(item)]));
  const feedbackEvents = [];
  for (const item of items) {
    validateReviewItemIdentity(item, queue.source?.runId);
    const review = objectValue(item.humanReview);
    if (review.status !== REVIEWED_STATUS) {
      throw new Error(`${item.reviewItemId} is not ${REVIEWED_STATUS}`);
    }
    const reviewerId = String(review.reviewerId || "").trim();
    const reviewedAt = String(review.reviewedAt || "").trim();
    if (!reviewerId || !isIsoDate(reviewedAt)) {
      throw new Error(`${item.reviewItemId} requires reviewerId and ISO reviewedAt`);
    }
    const truthCodes = uniqueStrings(review.truthCodes);
    const truthSpanCount = nonnegativeInteger(
      review.truthSpanCount,
      `${item.reviewItemId}.humanReview.truthSpanCount`
    );
    if (truthSpanCount < truthCodes.length) {
      throw new Error(
        `${item.reviewItemId} truthSpanCount cannot be smaller than unique truthCodes`
      );
    }
    const encoderCodes = uniqueStrings(item.machineComparison?.encoderCodes);
    const llmCodes = uniqueStrings(item.machineComparison?.llmCodes);
    const encoderFalsePositiveCodes = encoderCodes.filter(
      (code) => !truthCodes.includes(code)
    );
    const dangerousFalsePositiveCodes = uniqueStrings(
      review.dangerousFalsePositiveCodes
    );
    if (dangerousFalsePositiveCodes.some(
      (code) => !encoderFalsePositiveCodes.includes(code)
    )) {
      throw new Error(
        `${item.reviewItemId} dangerousFalsePositiveCodes must be encoder false positives`
      );
    }
    const dangerousNegativeOpportunityCount = nonnegativeInteger(
      review.dangerousNegativeOpportunityCount,
      `${item.reviewItemId}.humanReview.dangerousNegativeOpportunityCount`
    );
    if (dangerousNegativeOpportunityCount < dangerousFalsePositiveCodes.length) {
      throw new Error(
        `${item.reviewItemId} dangerous opportunities cannot be smaller than dangerous false positives`
      );
    }
    const cellName = String(item.measurementCell || "");
    const cell = byCell.get(cellName);
    if (!cell) {
      throw new Error(`${item.reviewItemId} has unexpected cell ${cellName}`);
    }
    cell.reviewedItemCount += 1;
    cell.reviewedLineCount += nonnegativeInteger(
      item.reviewedLineCount,
      `${item.reviewItemId}.reviewedLineCount`
    );
    cell.reviewedSpanCount += truthSpanCount;
    cell.truePositiveCodeCount += intersectionCount(encoderCodes, truthCodes);
    cell.falsePositiveCodeCount += encoderFalsePositiveCodes.length;
    cell.falseNegativeCodeCount += differenceCount(truthCodes, encoderCodes);
    cell.llmTruePositiveCodeCount += intersectionCount(llmCodes, truthCodes);
    cell.llmFalseNegativeCodeCount += differenceCount(truthCodes, llmCodes);
    cell.dangerousFalsePositiveCount += dangerousFalsePositiveCodes.length;
    cell.dangerousNegativeOpportunityCount += dangerousNegativeOpportunityCount;
    feedbackEvents.push(
      ...feedbackForItem({
        item,
        review,
        encoderCodes,
        llmCodes,
        truthCodes,
        dangerousFalsePositiveCodes
      })
    );
  }
  const cells = [...byCell.values()];
  const determinism = objectValue(queue.source?.determinism);
  const minimumReviewedItemsPerCell = nonnegativeInteger(
    policy.telemetry?.minimumRunsPerCell,
    "telemetry.minimumRunsPerCell"
  );
  const promotionEligible = queue.purpose === "promotion"
    && queue.promotionEligibleSource === true
    && expectedCells.every(({ cell }) => {
      const compiled = byCell.get(cell);
      return compiled.reviewedItemCount >= minimumReviewedItemsPerCell
        && compiled.reviewedLineCount
        >= Number(policy.adjudication?.minimumReviewedLinesPerCell || 0)
        && compiled.reviewedSpanCount
        >= Number(policy.adjudication?.minimumReviewedSpansPerCell || 0);
    });
  return {
    schemaVersion: "fee-whitebox-adjudication-v1",
    generatedAt: new Date().toISOString(),
    purpose: String(queue.purpose || "diagnostic"),
    promotionEligible,
    source: {
      ...objectValue(queue.source),
      queueSha256: sha256(stableJson(queue))
    },
    controlRepeats: nonnegativeInteger(
      determinism.minimumObservedRepeats,
      "source.determinism.minimumObservedRepeats"
    ),
    deterministicExactMatchRate: ratioOrNull(determinism.exactMatchRate),
    cells,
    feedbackEvents
  };
}

export function summarizeQueueCoverage(items, policy) {
  const byCell = Object.fromEntries(
    requiredWhiteboxCells(policy).map(({ cell }) => [
      cell,
      { itemCount: 0, reviewedLineCount: 0, machineSpanCount: 0 }
    ])
  );
  for (const item of items) {
    if (!byCell[item.measurementCell]) {
      continue;
    }
    byCell[item.measurementCell].itemCount += 1;
    byCell[item.measurementCell].reviewedLineCount += Number(
      item.reviewedLineCount || 0
    );
    byCell[item.measurementCell].machineSpanCount += Number(
      item.machineSpanCount || 0
    );
  }
  return {
    cells: byCell,
    minimumObservedLinesPerCell: minimumCellValue(byCell, "reviewedLineCount"),
    minimumObservedMachineSpansPerCell: minimumCellValue(
      byCell,
      "machineSpanCount"
    ),
    warning: (
      "Machine span counts are planning data only. Promotion coverage is "
      + "computed from humanReview.truthSpanCount during compilation."
    )
  };
}

function reviewItem(item, runId) {
  const precheck = objectValue(item.run.machinePrecheck);
  const clinicalText = String(item.sourceCase.clinicalText || "");
  const reviewItemId = `wb_review_${sha256(
    `${runId}|${item.run.feeSessionId}|${item.caseId}`
  ).slice(0, 20)}`;
  const result = {
    reviewItemId,
    caseId: item.caseId,
    feeSessionId: String(item.run.feeSessionId || ""),
    specialty: String(item.run.specialty || item.sourceCase.specialty || ""),
    encounterSetting: String(
      item.run.encounterSetting || item.sourceCase.encounterSetting || ""
    ),
    measurementCell: item.cell,
    selectionReasons: item.selectionReasons,
    clinicalText,
    clinicalTextSha256: sha256(clinicalText),
    reviewedLineCount: nonemptyLineCount(clinicalText),
    machineSpanCount: Number(precheck.reviewedSpanCount || 0),
    machineComparison: {
      encoderCodes: item.encoderCodes,
      llmCodes: item.llmCodes,
      matchedCodes: item.encoderCodes.filter((code) => item.llmCodes.includes(code)),
      encoderOnlyCodes: item.encoderCodes.filter(
        (code) => !item.llmCodes.includes(code)
      ),
      llmOnlyCodes: item.llmCodes.filter(
        (code) => !item.encoderCodes.includes(code)
      )
    },
    humanReview: {
      status: "pending",
      reviewerId: "",
      reviewedAt: "",
      truthCodes: [],
      truthSpanCount: null,
      dangerousFalsePositiveCodes: [],
      dangerousNegativeOpportunityCount: null,
      notes: ""
    }
  };
  result.immutableSha256 = sha256(stableJson(immutableReviewPayload(result)));
  return result;
}

function emptyCell({ specialty, encounterSetting }) {
  return {
    specialty,
    encounterSetting,
    reviewedItemCount: 0,
    reviewedLineCount: 0,
    reviewedSpanCount: 0,
    truePositiveCodeCount: 0,
    falsePositiveCodeCount: 0,
    falseNegativeCodeCount: 0,
    llmTruePositiveCodeCount: 0,
    llmFalseNegativeCodeCount: 0,
    dangerousFalsePositiveCount: 0,
    dangerousNegativeOpportunityCount: 0
  };
}

function feedbackForItem({
  item,
  review,
  encoderCodes,
  llmCodes,
  truthCodes,
  dangerousFalsePositiveCodes
}) {
  const universe = uniqueStrings([...encoderCodes, ...llmCodes, ...truthCodes]);
  return universe.map((code) => {
    const encoderProposed = encoderCodes.includes(code);
    const llmProposed = llmCodes.includes(code);
    const accepted = truthCodes.includes(code);
    let rejectReason = null;
    if (!accepted && encoderProposed && llmProposed) rejectReason = "both_false_positive";
    else if (!accepted && encoderProposed) rejectReason = "encoder_false_positive";
    else if (!accepted && llmProposed) rejectReason = "llm_false_positive";
    else if (accepted && !encoderProposed && !llmProposed) rejectReason = "both_false_negative";
    else if (accepted && !encoderProposed) rejectReason = "encoder_false_negative";
    else if (accepted && !llmProposed) rejectReason = "llm_false_negative";
    return {
      schemaVersion: "fee-whitebox-feedback-event-v1",
      reviewItemId: item.reviewItemId,
      caseId: item.caseId,
      measurementCell: item.measurementCell,
      code,
      accepted,
      encoderProposed,
      llmProposed,
      dangerous: dangerousFalsePositiveCodes.includes(code),
      rejectReason,
      reviewerId: String(review.reviewerId),
      reviewedAt: String(review.reviewedAt)
    };
  });
}

function validateReviewItemIdentity(item, runId) {
  const expected = `wb_review_${sha256(
    `${runId}|${item.feeSessionId}|${item.caseId}`
  ).slice(0, 20)}`;
  if (item.reviewItemId !== expected) {
    throw new Error(`review item identity mismatch: ${item.reviewItemId}`);
  }
  if (sha256(String(item.clinicalText || "")) !== item.clinicalTextSha256) {
    throw new Error(`${item.reviewItemId} clinicalText hash mismatch`);
  }
  const immutableSha256 = sha256(stableJson(immutableReviewPayload(item)));
  if (immutableSha256 !== item.immutableSha256) {
    throw new Error(`${item.reviewItemId} immutable review payload hash mismatch`);
  }
}

function immutableReviewPayload(item) {
  return {
    reviewItemId: item.reviewItemId,
    caseId: item.caseId,
    feeSessionId: item.feeSessionId,
    specialty: item.specialty,
    encounterSetting: item.encounterSetting,
    measurementCell: item.measurementCell,
    selectionReasons: item.selectionReasons,
    clinicalTextSha256: item.clinicalTextSha256,
    reviewedLineCount: item.reviewedLineCount,
    machineSpanCount: item.machineSpanCount,
    machineComparison: item.machineComparison
  };
}

function immutableQueuePayload(queue) {
  return {
    schemaVersion: queue.schemaVersion,
    purpose: queue.purpose,
    promotionEligibleSource: queue.promotionEligibleSource,
    source: queue.source,
    selection: queue.selection,
    coverage: queue.coverage,
    itemBindings: (Array.isArray(queue.items) ? queue.items : []).map((item) => ({
      reviewItemId: item.reviewItemId,
      immutableSha256: item.immutableSha256
    }))
  };
}

function assertRunManifest(runManifest) {
  if (runManifest?.schemaVersion !== "fee-whitebox-shadow-stg-run-v1") {
    throw new Error("run manifest must use fee-whitebox-shadow-stg-run-v1");
  }
  if (runManifest.status !== "complete") {
    throw new Error("run manifest must be complete");
  }
  if (!Array.isArray(runManifest.runs) || !runManifest.runs.length) {
    throw new Error("run manifest has no runs");
  }
  const evaluationPurpose = String(
    runManifest.methodology?.evaluationPurpose || ""
  ).trim();
  if (!["diagnostic", "promotion"].includes(evaluationPurpose)) {
    throw new Error(
      "run manifest methodology.evaluationPurpose must be diagnostic or promotion"
    );
  }
  if (typeof runManifest.source?.holdoutUsed !== "boolean") {
    throw new Error("run manifest source.holdoutUsed must be boolean");
  }
  if (
    (evaluationPurpose === "promotion")
    !== runManifest.source.holdoutUsed
  ) {
    throw new Error(
      "run manifest evaluationPurpose and source.holdoutUsed are inconsistent"
    );
  }
  return evaluationPurpose;
}

function minimumCellValue(byCell, field) {
  const values = Object.values(byCell).map((item) => Number(item[field] || 0));
  return values.length ? Math.min(...values) : 0;
}

function intersectionCount(left, right) {
  return left.filter((item) => right.includes(item)).length;
}

function differenceCount(left, right) {
  return left.filter((item) => !right.includes(item)).length;
}

function deterministicRank(runId, caseId) {
  return sha256(`${runId}|${caseId}`);
}

function sameStringSet(left, right) {
  return JSON.stringify(uniqueStrings(left)) === JSON.stringify(uniqueStrings(right));
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))].sort();
}

function nonemptyLineCount(value) {
  return String(value || "").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonnegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function ratioOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function isIsoDate(value) {
  return Boolean(value) && !Number.isNaN(Date.parse(value));
}

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortDeep(item)])
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
