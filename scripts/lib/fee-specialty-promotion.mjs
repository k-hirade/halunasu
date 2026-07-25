import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  unicodeOffsetOf,
  validateFeeSpecialtyMatrix
} from "./fee-specialty-matrix.mjs";

const AXIS_FIELDS = Object.freeze([
  "actionStatus",
  "temporalRelation",
  "sourceOrigin",
  "providerOwnership",
  "standingStatus"
]);

const SPECIALTY_SLUGS = Object.freeze({
  internal_medicine: "im",
  dermatology: "derm",
  orthopedics: "orth",
  pediatrics: "ped",
  otolaryngology: "ent",
  ophthalmology: "oph",
  psychiatry: "psy",
  surgery: "surg"
});

const SETTING_SLUGS = Object.freeze({
  outpatient: "outp",
  home_visit: "home",
  house_call: "house",
  telephone: "tel"
});

export class SpecialtyPromotionError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "SpecialtyPromotionError";
    this.details = details;
  }
}

export function promoteReviewedAnnotations({
  queueDocument,
  dataset,
  matrix,
  clinicalAxesSchema,
  masterRecords,
  replace = false,
  strict = false,
  reviewedAt
}) {
  if (!queueDocument || !Array.isArray(queueDocument.queue)) {
    throw new SpecialtyPromotionError("annotation queue must contain a queue array");
  }
  if (!dataset || !Array.isArray(dataset.cases)) {
    throw new SpecialtyPromotionError("target dataset must contain a cases array");
  }
  const reviewDate = normalizeReviewDate(reviewedAt);
  const promoted = queueDocument.queue.map((entry, index) => (
    buildPromotedCase(entry, {
      index,
      sourceDatasetId: queueDocument.sourceDatasetId,
      masterRecords,
      reviewedAt: reviewDate
    })
  ));
  if (!promoted.length) {
    throw new SpecialtyPromotionError("annotation queue contains no reviewed entries");
  }

  const mergedCases = [...dataset.cases];
  for (const item of promoted) {
    const existingIndex = mergedCases.findIndex((entry) => entry.caseId === item.caseId);
    if (existingIndex < 0) {
      mergedCases.push(item);
      continue;
    }
    const existing = mergedCases[existingIndex];
    if (!replace) {
      throw new SpecialtyPromotionError(
        `caseId collision: ${item.caseId}; use --replace only for the same holdout source`
      );
    }
    if (
      existing.split !== "holdout"
      || existing.sourceCaseId !== item.sourceCaseId
      || !deepEqual(existing.generationProvenance, item.generationProvenance)
    ) {
      throw new SpecialtyPromotionError(
        `unsafe replacement rejected for ${item.caseId}`
      );
    }
    mergedCases[existingIndex] = item;
  }

  const mergedDataset = {
    ...dataset,
    cases: mergedCases
  };
  const validation = validateFeeSpecialtyMatrix({
    matrix,
    dataset: mergedDataset,
    clinicalAxesSchema,
    strict
  });
  if (!validation.ok) {
    throw new SpecialtyPromotionError(
      "merged specialty matrix failed validation",
      validation.errors
    );
  }
  return {
    dataset: mergedDataset,
    promoted,
    validation
  };
}

export function queryFeeMasterCodes({
  codes,
  masterDbPath,
  repoRoot,
  pythonBinary = process.env.PYTHON || "python3",
  runner = spawnSync
}) {
  const uniqueCodes = [...new Set(codes.map((code) => String(code || "").trim()).filter(Boolean))];
  const scriptPath = path.join(repoRoot, "scripts/query_fee_master_codes.py");
  const result = runner(
    pythonBinary,
    [scriptPath, "--db", masterDbPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ codes: uniqueCodes }),
      maxBuffer: 4 * 1024 * 1024
    }
  );
  if (result.error || result.status !== 0) {
    throw new SpecialtyPromotionError(
      `fee master lookup failed: ${String(result.stderr || result.error?.message || "").trim()}`
    );
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new SpecialtyPromotionError(`fee master lookup returned invalid JSON: ${error.message}`);
  }
  return payload.records || {};
}

export function collectQueueMasterCodes(queueDocument) {
  const codes = [];
  for (const entry of queueDocument?.queue || []) {
    for (const span of entry.approvedSpans || []) {
      if (isApprovedSpan(span)) codes.push(span.code);
    }
    for (const target of entry.billingTargets || []) {
      codes.push(target.code);
    }
  }
  return [...new Set(codes.map((code) => String(code || "").trim()).filter(Boolean))];
}

export function writeJsonAtomic(filePath, value) {
  const outputPath = path.resolve(filePath);
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function buildPromotedCase(entry, {
  index,
  sourceDatasetId,
  masterRecords,
  reviewedAt
}) {
  const context = `queue[${index}]`;
  const sourceCaseId = requiredText(entry?.sourceCaseId, `${context}.sourceCaseId`);
  const specialty = requiredText(entry?.specialty, `${context}.specialty`);
  const encounterSetting = requiredText(
    entry?.encounterSetting,
    `${context}.encounterSetting`
  );
  if (entry?.split !== "holdout") {
    throw new SpecialtyPromotionError(`${context}.split must be holdout`);
  }
  const reviewedBy = requiredText(entry?.reviewedBy, `${context}.reviewedBy`);
  const clinicalText = requiredText(entry?.clinicalText, `${context}.clinicalText`);
  const approved = (entry?.approvedSpans || []).filter(isApprovedSpan);
  if (!approved.length) {
    throw new SpecialtyPromotionError(`${context}.approvedSpans has no accepted spans`);
  }
  const expectedSpans = approved.map((span, spanIndex) => normalizeApprovedSpan({
    span,
    clinicalText,
    masterRecords,
    context: `${context}.approvedSpans[${spanIndex}]`
  }));
  const generationProvenance = normalizeGenerationProvenance(
    entry?.generationProvenance,
    sourceDatasetId,
    context
  );
  const caseId = String(entry?.caseId || "").trim() || generatedCaseId({
    specialty,
    encounterSetting,
    sourceCaseId
  });
  const billingTargets = Array.isArray(entry?.billingTargets)
    ? entry.billingTargets
    : [];
  validateMasterCodes(
    [
      ...expectedSpans.map((span) => span.code),
      ...billingTargets.map((target) => target?.code)
    ],
    masterRecords,
    context
  );

  return {
    caseId,
    specialty,
    encounterSetting,
    split: "holdout",
    templateId: requiredText(
      entry?.sourceTemplateId || entry?.templateId,
      `${context}.sourceTemplateId`
    ),
    synthetic: true,
    annotationStatus: "reviewed",
    generationProvenance,
    holdoutProvenance: {
      source: "human_reviewed"
    },
    reviewPolicy: {
      expectedSpansReviewed: true,
      reviewedBy,
      reviewedAt
    },
    sourceCaseId,
    clinicalText,
    expectedSpans,
    expectedClaimContext: normalizeExpectedClaimContext(entry, billingTargets)
  };
}

function normalizeApprovedSpan({ span, clinicalText, masterRecords, context }) {
  const text = requiredText(span?.text, `${context}.text`);
  const offsets = locateSpan(clinicalText, text, span, context);
  const code = requiredText(span?.code, `${context}.code`);
  const record = masterRecords[code];
  if (!record) {
    throw new SpecialtyPromotionError(`${context}.code ${code} does not exist in the fee master`);
  }
  const normalized = {
    text,
    ...offsets,
    code,
    masterName: String(span?.masterName || record.name || ""),
    category: requiredText(span?.category, `${context}.category`)
  };
  for (const field of AXIS_FIELDS) {
    normalized[field] = requiredText(span?.[field], `${context}.${field}`);
  }
  return normalized;
}

function locateSpan(clinicalText, text, span, context) {
  const occurrences = [];
  let fromOffset = 0;
  while (true) {
    const offset = unicodeOffsetOf(clinicalText, text, fromOffset);
    if (offset < 0) break;
    occurrences.push(offset);
    fromOffset = offset + Math.max(1, Array.from(text).length);
  }
  if (!occurrences.length) {
    throw new SpecialtyPromotionError(`${context}.text was not found in clinicalText`);
  }
  let occurrence = Number(span?.occurrence);
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    const suppliedStart = Number(span?.charStart);
    const suppliedIndex = Number.isInteger(suppliedStart)
      ? occurrences.indexOf(suppliedStart)
      : -1;
    if (suppliedIndex >= 0) occurrence = suppliedIndex + 1;
    else if (occurrences.length === 1) occurrence = 1;
    else {
      throw new SpecialtyPromotionError(
        `${context}.occurrence is required because the text appears ${occurrences.length} times`
      );
    }
  }
  if (occurrence > occurrences.length) {
    throw new SpecialtyPromotionError(
      `${context}.occurrence ${occurrence} exceeds ${occurrences.length} matches`
    );
  }
  const charStart = occurrences[occurrence - 1];
  return {
    charStart,
    charEnd: charStart + Array.from(text).length
  };
}

function normalizeGenerationProvenance(value, sourceDatasetId, context) {
  if (value && typeof value === "object") {
    const source = requiredText(value.source, `${context}.generationProvenance.source`);
    const generatorFamily = requiredText(
      value.generatorFamily,
      `${context}.generationProvenance.generatorFamily`
    );
    return {
      ...value,
      source,
      generatorFamily
    };
  }
  if (String(sourceDatasetId || "").startsWith("fee-soap-e2e-v2")) {
    return {
      source: "separate_generator",
      generatorFamily: "fee-soap-e2e-v2"
    };
  }
  throw new SpecialtyPromotionError(
    `${context}.generationProvenance is required for this queue source`
  );
}

function normalizeExpectedClaimContext(entry, billingTargets) {
  const source = entry?.expectedClaimContext || {};
  if (source?.sourceClaimContext && Array.isArray(source?.expectedCodes)) {
    return source;
  }
  return {
    sourceClaimContext: source,
    expectedCodes: billingTargets
      .filter((target) => String(target?.code || "").trim())
      .map((target) => ({
        code: String(target.code),
        name: String(target.name || "")
      })),
    notes: String(entry?.reviewNotes || "")
  };
}

function validateMasterCodes(codes, masterRecords, context) {
  const missing = [...new Set(codes
    .map((code) => String(code || "").trim())
    .filter(Boolean))]
    .filter((code) => !masterRecords[code]);
  if (missing.length) {
    throw new SpecialtyPromotionError(
      `${context} contains fee master codes that do not exist: ${missing.join(", ")}`
    );
  }
}

function generatedCaseId({ specialty, encounterSetting, sourceCaseId }) {
  const specialtySlug = SPECIALTY_SLUGS[specialty] || safeSlug(specialty);
  const settingSlug = SETTING_SLUGS[encounterSetting] || safeSlug(encounterSetting);
  const digest = crypto.createHash("sha256").update(sourceCaseId).digest("hex").slice(0, 10);
  return `wx0-${specialtySlug}-${settingSlug}-h-${digest}`;
}

function normalizeReviewDate(value) {
  const reviewDate = String(value || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(reviewDate)) {
    throw new SpecialtyPromotionError("reviewedAt must use YYYY-MM-DD");
  }
  return reviewDate;
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new SpecialtyPromotionError(`${field} is required`);
  return text;
}

function isApprovedSpan(span) {
  return Boolean(span)
    && span.approved !== false
    && !["rejected", "excluded"].includes(String(span.status || "").toLowerCase());
}

function safeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 24) || "case";
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
