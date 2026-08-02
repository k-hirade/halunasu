import { createHash } from "node:crypto";
import { stableJson } from "../../../packages/care-fee-core/src/index.js";

export function buildCareFeeEpisodeDocuments(input = {}) {
  const now = isoTime(input.now);
  const evaluation = input.evaluation || { episodes: [], rows: [] };
  const episodeEvaluationByKey = new Map(evaluation.episodes.map((episode) => [
    episodeKey(episode),
    episode
  ]));
  const evaluationRowsByKey = groupBy(evaluation.rows, episodeKey);
  const normalizedRowsByKey = groupBy(input.rows || [], episodeKey);
  const documents = [];

  for (const [key, rows] of normalizedRowsByKey) {
    const first = rows[0];
    const episodeEvaluation = episodeEvaluationByKey.get(key);
    if (!episodeEvaluation) continue;
    const sourceRevisionHash = sha256(stableJson({
      rows: rows.map(withoutRowNumber),
      upstream: input.source?.sourceRevisionHash || ""
    }));
    documents.push(Object.freeze({
      episodeId: stableId("cep", input.orgId, input.facilityId, first.patientKey, first.episodeKey),
      orgId: input.orgId,
      facilityId: input.facilityId,
      facilityCode: first.facilityCode,
      patientKey: first.patientKey,
      patientDisplayName: first.patientDisplayName || "",
      episodeKey: first.episodeKey,
      claimMonth: first.claimMonth,
      facilityClaimMonthKey: `${input.facilityId}|${first.claimMonth}`,
      onsetAt: first.onsetAt,
      treatmentDates: Object.freeze(rows.map((row) => row.treatmentDate).sort()),
      source: Object.freeze({
        inputOrigin: first.inputOrigin,
        sourceProduct: input.source?.sourceProduct || first.inputOrigin,
        sourceRecordId: input.source?.sourceRecordId || first.sourceRecordId || "",
        sourceRevisionHash: input.source?.sourceRevisionHash || sourceRevisionHash,
        receivedAt: now
      }),
      sourceRevisionHash,
      rows: Object.freeze(rows),
      evaluation: Object.freeze({
        ...episodeEvaluation,
        rows: Object.freeze(evaluationRowsByKey.get(key) || [])
      }),
      decisionStatus: "pending",
      decision: null,
      decisionHistory: Object.freeze([]),
      claimReconciliationRequired: false,
      createdAt: now,
      updatedAt: now
    }));
  }
  return Object.freeze(documents);
}

export function careFeeMonthlyRevisionHash(input = {}) {
  return sha256(stableJson({
    orgId: input.orgId,
    facilityId: input.facilityId,
    claimMonth: input.claimMonth,
    ruleVersion: input.ruleVersion,
    masterVersion: input.masterVersion,
    episodes: (input.episodes || []).map((episode) => ({
      episodeId: episode.episodeId,
      sourceRevisionHash: episode.sourceRevisionHash,
      decisionStatus: episode.decisionStatus,
      updatedAt: episode.updatedAt
    })).sort((left, right) => left.episodeId.localeCompare(right.episodeId)),
    claims: (input.claims || []).map((claim) => ({
      claimId: claim.claimId,
      episodeId: claim.episodeId,
      updatedAt: claim.updatedAt
    })).sort((left, right) => left.claimId.localeCompare(right.claimId))
  }));
}

export function stableId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.map((part) => String(part || "")).join("\u001f")).slice(0, 32)}`;
}

function episodeKey(value) {
  return [value.facilityCode, value.patientKey, value.episodeKey].join("|");
}

function groupBy(values, keyFunction) {
  const groups = new Map();
  for (const value of values || []) {
    const key = keyFunction(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function withoutRowNumber(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "rowNumber"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}
