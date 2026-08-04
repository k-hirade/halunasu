const SELECTABLE_ZONES = new Set(["review_required", "selection_required"]);

// 区分が複数残る候補に、人が選べるドロップダウンの材料を付ける。
// 人の選択は事実ではないので、保存時の sourceRevision と選択肢集合の両方が
// いまの算定案と一致するときだけ有効にする(再計算されたら自動的に失効する)。
export function buildSidecarCandidateSelection({
  candidate = {},
  selectionNarrowing = null,
  stored = null,
  sourceRevision = 0
} = {}) {
  if (candidate?.requiresSelection !== true) {
    return null;
  }
  // 絞り込み artifact が使える族はその残り区分を、無い族は候補生成元が付けた
  // 区分名つき選択肢を使う。どちらも無い場合はコードだけになるので提示しない。
  const source = Array.isArray(selectionNarrowing?.remainingOptions)
    && selectionNarrowing.remainingOptions.length
    ? selectionNarrowing.remainingOptions
    : Array.isArray(candidate?.codeCandidateOptions)
      ? candidate.codeCandidateOptions
      : [];
  const options = source
    .map((option) => ({
      code: String(option?.code || "").trim(),
      qualifierLabel: String(option?.qualifierLabel || "").trim(),
      points: Number(option?.points || 0)
    }))
    .filter((option) => option.code);
  if (options.length < 2) {
    return null;
  }
  const storedCode = String(stored?.selectedCode || "").trim();
  const revisionMatches = Number(stored?.sourceRevision || 0) === Number(sourceRevision || 0);
  const selectedOption = storedCode && revisionMatches
    ? options.find((option) => option.code === storedCode) || null
    : null;
  const stale = Boolean(storedCode) && !selectedOption;
  return {
    status: selectedOption ? "selected" : stale ? "stale" : "unselected",
    question: String(selectionNarrowing?.remainingOptions?.[0]?.axisQuestion || "").trim()
      || "算定区分を選択してください",
    options,
    selectedCode: selectedOption ? selectedOption.code : "",
    selectedOption,
    version: Number(stored?.version || 0),
    updatedAt: stored?.updatedAt || null
  };
}

export function findSidecarSelectionCandidate(candidates = [], candidateKey = "") {
  const normalizedKey = String(candidateKey || "").trim();
  if (!normalizedKey) {
    return null;
  }
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => (
    candidate?.candidateKey === normalizedKey
    && SELECTABLE_ZONES.has(String(candidate?.zone || ""))
    && Array.isArray(candidate?.selection?.options)
    && candidate.selection.options.length >= 2
  )) || null;
}

export function sidecarSelectionAllowsCode(candidate = {}, selectedCode = "") {
  const normalized = String(selectedCode || "").trim();
  if (!normalized) {
    return true;
  }
  return (Array.isArray(candidate?.selection?.options) ? candidate.selection.options : [])
    .some((option) => option.code === normalized);
}
