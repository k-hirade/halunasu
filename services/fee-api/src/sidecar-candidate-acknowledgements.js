import crypto from "node:crypto";

const ACKNOWLEDGEABLE_ZONES = new Set(["review_required", "selection_required"]);

export function decorateSidecarCandidateAcknowledgements({
  candidates = [],
  notices = [],
  pricingBasis = null,
  sourceRevision = 1,
  candidateAcknowledgements = {}
} = {}) {
  const normalizedCandidates = Array.isArray(candidates) ? candidates : [];
  const candidateKeys = normalizedCandidates.map(sidecarCandidateKey);
  const keyCounts = candidateKeys.reduce((counts, key) => {
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  return normalizedCandidates.map((candidate, index) => {
    const candidateKey = candidateKeys[index];
    if (
      !candidateKey
      || keyCounts.get(candidateKey) !== 1
      || !ACKNOWLEDGEABLE_ZONES.has(String(candidate?.zone || ""))
    ) {
      return candidate;
    }
    const candidateFingerprint = sidecarCandidateFingerprint(candidate, {
      notices,
      pricingBasis
    });
    const stored = acknowledgementRecord(candidateAcknowledgements, candidateKey);
    return {
      ...candidate,
      candidateKey,
      candidateFingerprint,
      acknowledgement: acknowledgementView(stored, {
        candidateFingerprint,
        sourceRevision
      })
    };
  });
}

export function sidecarAcknowledgementTargets(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => (
      ACKNOWLEDGEABLE_ZONES.has(String(candidate?.zone || ""))
      && validCandidateKey(candidate?.candidateKey)
      && validFingerprint(candidate?.candidateFingerprint)
    ))
    .map((candidate) => ({
      candidateKey: candidate.candidateKey,
      candidateFingerprint: candidate.candidateFingerprint
    }));
}

export function findSidecarAcknowledgementCandidate(candidates = [], candidateKey = "") {
  const normalizedKey = String(candidateKey || "").trim();
  if (!validCandidateKey(normalizedKey)) return null;
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => (
    candidate?.candidateKey === normalizedKey
    && ACKNOWLEDGEABLE_ZONES.has(String(candidate?.zone || ""))
  )) || null;
}

export function sidecarCandidateKey(candidate = {}) {
  const sourceType = String(candidate?.sourceType || "").trim();
  const candidateId = String(candidate?.candidateId || "").trim();
  if (!sourceType || !candidateId) return null;
  return `sca_${digest(canonicalJson({ sourceType, candidateId })).slice(0, 26)}`;
}

export function sidecarCandidateFingerprint(candidate = {}, options = {}) {
  const candidateId = String(candidate?.candidateId || "").trim();
  const code = String(candidate?.code || "").trim();
  const relatedNotices = (Array.isArray(options.notices) ? options.notices : [])
    .filter((notice) => (
      (candidateId && String(notice?.candidateId || "").trim() === candidateId)
      || (code && String(notice?.targetCode || "").trim() === code)
    ))
    .map((notice) => ({
      noticeId: notice?.noticeId || null,
      badge: notice?.badge || null,
      attentionLevel: notice?.attentionLevel || null,
      checklist: notice?.checklist === true,
      shortText: notice?.shortText || null,
      detailText: notice?.detailText || null,
      targetCode: notice?.targetCode || null,
      sourceRefs: notice?.sourceRefs || null
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return digest(canonicalJson({
    schemaVersion: 1,
    sourceType: candidate?.sourceType || null,
    candidateId: candidate?.candidateId || null,
    zone: candidate?.zone || null,
    billingEligibility: candidate?.billingEligibility || null,
    code: candidate?.code || null,
    codeCandidates: [...new Set((Array.isArray(candidate?.codeCandidates) ? candidate.codeCandidates : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))].sort(),
    name: candidate?.name || null,
    display: candidate?.display || null,
    points: finiteNumberOrNull(candidate?.points),
    quantity: finiteNumberOrNull(candidate?.quantity),
    estimatedTotalPoints: finiteNumberOrNull(candidate?.estimatedTotalPoints),
    reason: candidate?.reason || null,
    basis: candidate?.basis || null,
    source: candidate?.source || null,
    evidence: candidate?.evidence || null,
    selectionResolution: candidate?.selectionResolution || null,
    selectionNarrowing: candidate?.selectionNarrowing || null,
    pricingBasis: options.pricingBasis || null,
    relatedNotices
  }));
}

function acknowledgementRecord(value, candidateKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value[candidateKey];
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

function acknowledgementView(record, expected = {}) {
  const version = Math.max(0, Number(record?.version || 0));
  if (!record) {
    return { status: "unacknowledged", version: 0, updatedAt: null };
  }
  const decisionIsCurrent = ["acknowledged", "excluded"].includes(record.status)
    && Number(record.sourceRevision || 0) === Number(expected.sourceRevision || 0)
    && record.candidateFingerprint === expected.candidateFingerprint;
  return {
    status: decisionIsCurrent
      ? record.status
      : ["acknowledged", "excluded", "stale"].includes(record.status)
        ? "stale"
        : "unacknowledged",
    version,
    updatedAt: record.updatedAt || null
  };
}

function validCandidateKey(value) {
  return /^sca_[a-f0-9]{26}$/u.test(String(value || ""));
}

function validFingerprint(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalValue(value[key])]]
    )));
  }
  return typeof value === "string" ? value.normalize("NFKC").trim() : value;
}
