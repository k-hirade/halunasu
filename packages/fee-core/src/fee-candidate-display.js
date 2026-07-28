const PROPOSAL_CONFIRMATION_SUFFIX = /(?:の)?(?:算定区分|算定可否|算定|区分)?確認$/u;
const OUTER_JAPANESE_QUOTES = /^「(.+)」$/u;
const TRAILING_JAPANESE_QUALIFIER = /^(.*?)\s*「[^」]+」$/u;

export function buildFeeCandidateDisplay(value, options = {}) {
  let normalized = normalizeDisplayName(value);
  if (!normalized) {
    return { stem: "", qualifier: "" };
  }

  if (options.proposal === true) {
    normalized = normalized.replace(PROPOSAL_CONFIRMATION_SUFFIX, "").trim();
    const outerQuoteMatch = normalized.match(OUTER_JAPANESE_QUOTES);
    if (outerQuoteMatch) {
      normalized = outerQuoteMatch[1].trim();
    }
  }

  const trailingQualifierMatch = normalized.match(TRAILING_JAPANESE_QUALIFIER);
  if (trailingQualifierMatch?.[1]?.trim()) {
    normalized = trailingQualifierMatch[1].trim();
  }

  const qualifierStart = normalized.indexOf("(");
  if (qualifierStart <= 0) {
    return { stem: normalized, qualifier: "" };
  }

  return {
    stem: normalized.slice(0, qualifierStart).trim(),
    qualifier: normalized.slice(qualifierStart).trim()
  };
}

function normalizeDisplayName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}
