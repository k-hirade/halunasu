import crypto from "node:crypto";

const CLAIM_MONTH_PATTERN = /^\d{4}-\d{2}$/u;
const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CLAIM_CODE_PATTERN = /^\d{9}$/u;

export function normalizeStandingMonthlyFixture(value = {}, {
  claimMonth = "",
  patientId = "",
  charts = []
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("standing timeline fixture must be an object");
  }
  if (String(value.schemaVersion || "") !== "fee-standing-monthly-e2e.v1") {
    throw new Error("standing timeline fixture schemaVersion must be fee-standing-monthly-e2e.v1");
  }

  const normalizedPatientId = requiredString(value.patientId, "standing timeline patientId");
  if (patientId && normalizedPatientId !== String(patientId)) {
    throw new Error(`standing timeline patientId ${normalizedPatientId} does not match dataset patient ${patientId}`);
  }

  const normalizedClaimMonth = normalizeClaimMonth(claimMonth, "dataset claim month");
  const prior = value.priorMonth && typeof value.priorMonth === "object" ? value.priorMonth : {};
  const current = value.currentMonth && typeof value.currentMonth === "object" ? value.currentMonth : {};
  const priorClaimMonth = normalizeClaimMonth(prior.claimMonth, "standing timeline priorMonth.claimMonth");
  if (priorClaimMonth !== previousClaimMonth(normalizedClaimMonth)) {
    throw new Error(
      `standing timeline prior month must be ${previousClaimMonth(normalizedClaimMonth)} for ${normalizedClaimMonth}`
    );
  }
  const currentClaimMonth = normalizeClaimMonth(
    current.claimMonth || normalizedClaimMonth,
    "standing timeline currentMonth.claimMonth"
  );
  if (currentClaimMonth !== normalizedClaimMonth) {
    throw new Error("standing timeline currentMonth.claimMonth must match the dataset claim month");
  }

  const priorServiceDate = normalizeServiceDate(
    prior.serviceDate,
    priorClaimMonth,
    "standing timeline priorMonth.serviceDate"
  );
  const clinicalText = requiredString(prior.clinicalText, "standing timeline priorMonth.clinicalText");
  const expectedPriorCodes = normalizeClaimCodes(
    prior.expectedStandingCodes,
    "standing timeline priorMonth.expectedStandingCodes"
  );
  const expectedCurrentCodes = normalizeClaimCodes(
    current.expectedStandingCodes || expectedPriorCodes,
    "standing timeline currentMonth.expectedStandingCodes"
  );
  const copyForwardServiceDate = normalizeServiceDate(
    current.copyForwardServiceDate,
    currentClaimMonth,
    "standing timeline currentMonth.copyForwardServiceDate"
  );
  const currentChart = (Array.isArray(charts) ? charts : []).find((chart) => (
    String(chart?.service_date || "") === copyForwardServiceDate
  ));
  if (!currentChart) {
    throw new Error(
      `standing timeline copy-forward chart ${copyForwardServiceDate} was not found in charts.jsonl`
    );
  }
  if (String(currentChart.clinical_text || "") !== clinicalText) {
    throw new Error(
      "standing timeline prior clinicalText must exactly match the configured current copy-forward chart"
    );
  }

  return {
    schemaVersion: "fee-standing-monthly-e2e.v1",
    patientId: normalizedPatientId,
    priorMonth: {
      claimMonth: priorClaimMonth,
      serviceDate: priorServiceDate,
      visitType: requiredString(prior.visitType || prior.status, "standing timeline priorMonth.visitType"),
      status: requiredString(prior.status || prior.visitType, "standing timeline priorMonth.status"),
      clinicalText,
      expectedStandingCodes: expectedPriorCodes,
      expectedCandidateBasis: String(
        prior.expectedCandidateBasis || "standing_mention_first_month_candidate"
      )
    },
    currentMonth: {
      claimMonth: currentClaimMonth,
      copyForwardServiceDate,
      expectedStandingCodes: expectedCurrentCodes,
      expectedCandidateBasis: String(
        current.expectedCandidateBasis || "standing_confirmed_history_candidate"
      )
    },
    acceptance: {
      requireMemoHit: value.acceptance?.requireMemoHit !== false,
      requireCurrentStandingApproval: value.acceptance?.requireCurrentStandingApproval !== false
    }
  };
}

export function standingProposalSelection(reviewItems = [], {
  expectedCodes = [],
  expectedBasis = ""
} = {}) {
  const expected = new Set(normalizeClaimCodes(expectedCodes, "expected standing codes"));
  const matches = (Array.isArray(reviewItems) ? reviewItems : [])
    .filter((item) => item?.sourceType === "candidate_proposal")
    .map((item) => ({
      reviewItemId: String(item.reviewItemId || ""),
      status: String(item.status || ""),
      proposalId: String(item.candidateProposal?.proposalId || ""),
      code: String(item.candidateProposal?.code || item.candidateProposal?.candidateLine?.code || ""),
      name: String(item.candidateProposal?.candidateLine?.name || item.title || ""),
      basis: String(item.candidateProposal?.basis || ""),
      source: String(item.candidateProposal?.source || item.candidateProposal?.candidateLine?.source || "")
    }))
    .filter((item) => item.reviewItemId)
    .filter((item) => item.source === "standing_fact_lane")
    .filter((item) => !expectedBasis || item.basis === expectedBasis)
    .filter((item) => expected.has(item.code));
  const matchedCodes = uniqueStrings(matches.map((item) => item.code)).sort();
  const missingCodes = [...expected].filter((code) => !matchedCodes.includes(code)).sort();
  return {
    matches,
    matchedCodes,
    missingCodes,
    decisions: matches.map((item) => ({
      reviewItemId: item.reviewItemId,
      status: "approved"
    }))
  };
}

export function standingProfileAudit(profiles = [], expectedCodes = [], claimMonth = "") {
  const expected = new Set(normalizeClaimCodes(expectedCodes, "expected standing profile codes"));
  const normalizedMonth = normalizeClaimMonth(claimMonth, "standing profile claim month");
  const matchedProfiles = (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => String(profile?.status || "") === "active")
    .map((profile) => {
      const occurrences = Array.isArray(profile?.confirmedOccurrences)
        ? profile.confirmedOccurrences
        : [];
      const confirmedCodes = uniqueStrings(occurrences
        .filter((entry) => String(entry?.claimMonth || "") === normalizedMonth)
        .flatMap((entry) => Array.isArray(entry?.codes) ? entry.codes : []))
        .sort();
      return {
        standingFactId: String(profile?.standingFactId || ""),
        feeFamily: String(profile?.feeFamily || ""),
        status: String(profile?.status || ""),
        claimMonth: normalizedMonth,
        confirmedCodes
      };
    })
    .filter((profile) => profile.confirmedCodes.some((code) => expected.has(code)));
  const matchedCodes = uniqueStrings(matchedProfiles.flatMap((profile) => profile.confirmedCodes))
    .filter((code) => expected.has(code))
    .sort();
  return {
    profileCount: matchedProfiles.length,
    matchedCodes,
    missingCodes: [...expected].filter((code) => !matchedCodes.includes(code)).sort(),
    profiles: matchedProfiles.map((profile) => ({
      profileRef: opaqueRef(profile.standingFactId),
      feeFamily: profile.feeFamily,
      status: profile.status,
      claimMonth: profile.claimMonth,
      confirmedCodes: profile.confirmedCodes
    }))
  };
}

export function summarizeStandingMonthlyRepeats(repeats = []) {
  const values = Array.isArray(repeats) ? repeats : [];
  const acceptance = values.map((item) => item?.standingTimeline?.acceptance || {});
  return {
    enabled: values.length > 0 && values.every((item) => Boolean(item?.standingTimeline)),
    repeatCount: values.length,
    priorCandidateObservedCount: acceptance.filter((item) => item.priorCandidateObserved === true).length,
    priorConfirmationRecordedCount: acceptance.filter((item) => item.priorConfirmationRecorded === true).length,
    currentCandidateObservedCount: acceptance.filter((item) => item.currentCandidateObserved === true).length,
    currentConfirmationRecordedCount: acceptance.filter((item) => item.currentConfirmationRecorded === true).length,
    currentMonthlyLineIncludedCount: acceptance.filter((item) => item.currentMonthlyLineIncluded === true).length,
    memoHitCount: acceptance.filter((item) => item.memoHit === true).length,
    allAcceptanceChecksPassed: values.length > 0 && acceptance.every((item) => item.passed === true)
  };
}

export function previousClaimMonth(value) {
  const normalized = normalizeClaimMonth(value, "claim month");
  const [year, month] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeClaimMonth(value, label) {
  const normalized = String(value || "").trim();
  if (!CLAIM_MONTH_PATTERN.test(normalized)) {
    throw new Error(`${label} must use YYYY-MM`);
  }
  const month = Number(normalized.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new Error(`${label} must use a calendar month from 01 to 12`);
  }
  return normalized;
}

function normalizeServiceDate(value, claimMonth, label) {
  const normalized = String(value || "").trim();
  if (!SERVICE_DATE_PATTERN.test(normalized) || normalized.slice(0, 7) !== claimMonth) {
    throw new Error(`${label} must be a valid date in ${claimMonth}`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label} must be a valid calendar date`);
  }
  return normalized;
}

function normalizeClaimCodes(value, label) {
  const codes = uniqueStrings(Array.isArray(value) ? value : []);
  if (!codes.length) {
    throw new Error(`${label} requires at least one code`);
  }
  const invalid = codes.filter((code) => !CLAIM_CODE_PATTERN.test(code));
  if (invalid.length) {
    throw new Error(`${label} contains invalid 9-digit codes: ${invalid.join(", ")}`);
  }
  return codes.sort();
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function opaqueRef(value) {
  return sha256(value).slice(0, 12);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
