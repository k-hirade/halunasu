import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ARTIFACT_URL = new URL(
  "./fee-rule-data/proposal-governance-2026.generated.json",
  import.meta.url
);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
assertArtifactIntegrity(ARTIFACT);

const FACILITY_REQUIREMENT_BY_CODE = new Map(
  asArray(ARTIFACT.facilityStandardRequirements)
    .map((entry) => [String(entry.code || ""), entry])
);
const VARIANT_FAMILIES = asArray(ARTIFACT.variantFamilies);
const BUNDLING_RULES = asArray(ARTIFACT.bundlingRules);
const GROUPABLE_EXCLUSION_SCOPES = new Set(["same_day", "same_month"]);
const GROUPABLE_EXCLUSION_RESOLUTIONS = new Set([
  "auto_winner",
  "demote_lower_points",
  "choose_one",
  "manual_choose"
]);

export function proposalGovernanceArtifactMetadata() {
  return {
    schemaVersion: ARTIFACT.schemaVersion,
    revision: ARTIFACT.revision,
    effectiveFrom: ARTIFACT.effectiveFrom,
    artifactPayloadSha256: ARTIFACT.artifactPayloadSha256,
    sourceDefinitionSha256: ARTIFACT.sourceDefinitionSha256
  };
}

export function applyCandidateProposalGovernance({
  candidateProposals = [],
  facilityStandardsConfirmed = false,
  facilityStandardKeys = [],
  canonicalExclusionRules = [],
  confirmedProcedureCodes = []
} = {}) {
  const activeStandards = new Set(normalizedStrings(facilityStandardKeys));
  const reviewIssues = [];
  const retained = [];
  const facilityStatusCounts = {
    satisfied: 0,
    not_satisfied: 0,
    unknown: 0,
    not_applicable: 0
  };

  for (const proposal of asArray(candidateProposals)) {
    const governed = applyFacilityStandardGovernance(proposal, {
      activeStandards,
      facilityStandardsConfirmed: facilityStandardsConfirmed === true
    });
    facilityStatusCounts[governed.status] += 1;
    if (governed.reviewIssue) {
      reviewIssues.push(governed.reviewIssue);
    }
    if (governed.proposal) {
      retained.push(governed.proposal);
    }
  }

  const bundled = applyBundlingGovernance(retained, confirmedProcedureCodes);
  reviewIssues.push(...bundled.reviewIssues);
  const variantGrouped = applyVariantFamilyGroups(bundled.proposals);
  const canonicalGrouped = applyCanonicalExclusionGroups(
    variantGrouped.proposals,
    canonicalExclusionRules
  );

  return {
    candidateProposals: canonicalGrouped.proposals,
    reviewIssues: dedupeBy(reviewIssues, (issue) => issue.reviewIssueId),
    diagnostics: {
      artifact: proposalGovernanceArtifactMetadata(),
      facilityStatusCounts,
      bundlingSuppressedProposalCount: bundled.suppressedProposalCount,
      bundlingReviewProposalCount: bundled.reviewProposalCount,
      bundlingRuleMatchCount: bundled.ruleMatchCount,
      variantFamilyGroupCount: variantGrouped.groupCount,
      canonicalExclusionGroupCount: canonicalGrouped.groupCount,
      canonicalAmbiguousComponentCount: canonicalGrouped.ambiguousComponentCount,
      ignoredConditionalExclusionRuleCount: canonicalGrouped.ignoredConditionalRuleCount
    }
  };
}

function applyBundlingGovernance(proposals, confirmedProcedureCodes) {
  const confirmedCodes = new Set(normalizedStrings(confirmedProcedureCodes));
  const proposalManagementCodes = new Set(
    asArray(proposals).flatMap((proposal) => proposalCodes(proposal))
  );
  const suppressedProposalIndexes = new Set();
  const reviewByIndex = new Map();
  const reviewIssues = [];
  let ruleMatchCount = 0;

  for (const rule of BUNDLING_RULES) {
    const managementCodes = new Set(normalizedStrings(rule.managementCodes));
    const includedCodes = new Set(normalizedStrings(rule.includedProcedureCodes));
    const managementConfirmed = [...managementCodes].some((code) => confirmedCodes.has(code));
    const managementCandidate = [...managementCodes].some((code) => (
      proposalManagementCodes.has(code)
    ));
    if (!managementConfirmed && !managementCandidate) {
      continue;
    }
    const matchingIndexes = asArray(proposals)
      .map((proposal, index) => (
        proposalCodes(proposal).some((code) => includedCodes.has(code)) ? index : -1
      ))
      .filter((index) => index >= 0);
    if (!matchingIndexes.length) {
      continue;
    }
    ruleMatchCount += 1;
    if (managementConfirmed) {
      matchingIndexes.forEach((index) => suppressedProposalIndexes.add(index));
      reviewIssues.push(bundlingReviewIssue(rule, {
        status: "suppressed",
        proposalCount: matchingIndexes.length
      }));
      continue;
    }
    for (const index of matchingIndexes) {
      const current = reviewByIndex.get(index) || [];
      current.push(rule);
      reviewByIndex.set(index, current);
    }
    reviewIssues.push(bundlingReviewIssue(rule, {
      status: "review_required",
      proposalCount: matchingIndexes.length
    }));
  }

  return {
    proposals: asArray(proposals).flatMap((proposal, index) => {
      if (suppressedProposalIndexes.has(index)) {
        return [];
      }
      const rules = reviewByIndex.get(index) || [];
      if (!rules.length) {
        return [proposal];
      }
      return [{
        ...proposal,
        actionType: "confirm_required",
        candidateOnly: true,
        bundlingReviewRequired: true,
        bundlingRuleIds: rules.map((rule) => rule.ruleId),
        conditionText: [
          String(proposal?.conditionText || "").trim(),
          "在宅療養指導管理料を当月算定する場合の包括関係を確認してください。"
        ].filter(Boolean).join(" ")
      }];
    }),
    reviewIssues,
    suppressedProposalCount: suppressedProposalIndexes.size,
    reviewProposalCount: reviewByIndex.size,
    ruleMatchCount
  };
}

function bundlingReviewIssue(rule, { status, proposalCount }) {
  const suppressed = status === "suppressed";
  return {
    reviewIssueId: `proposal_governance_bundling_${rule.ruleId}_${status}`,
    issueCode: suppressed
      ? "bundled_procedure_suppressed"
      : "bundled_procedure_review_required",
    severity: suppressed ? "info" : "warning",
    title: suppressed ? "指導管理料への包括" : "指導管理料との包括確認",
    topicCode: "billing_exclusion_check",
    topicLabel: "包括・併算定の確認",
    messageForStaff: suppressed
      ? `当月の指導管理料が確定しているため、包括対象の処置候補${proposalCount}件を表示対象から除外しました。`
      : `指導管理料が候補段階のため、関連する処置候補${proposalCount}件は削除せず包括確認付きで残しています。`,
    requiredInput: "当月の指導管理料の確定状況、処置実施日、包括規定",
    source: "candidate_proposal_governance",
    metadata: {
      ruleId: rule.ruleId,
      scope: rule.scope,
      sourceRef: rule.sourceRef
    }
  };
}

function applyFacilityStandardGovernance(proposal, {
  activeStandards,
  facilityStandardsConfirmed
}) {
  const requirements = proposalCodes(proposal)
    .map((code) => FACILITY_REQUIREMENT_BY_CODE.get(code))
    .filter(Boolean);
  if (!requirements.length) {
    return {
      status: "not_applicable",
      proposal,
      reviewIssue: null
    };
  }

  const satisfiedRequirement = requirements.find((requirement) => (
    normalizedStrings(requirement.requiredAllOf)
      .every((key) => activeStandards.has(key))
  ));
  const requiredKeys = normalizedStrings(
    requirements.flatMap((requirement) => requirement.requiredAllOf)
  );
  if (satisfiedRequirement) {
    return {
      status: "satisfied",
      proposal: {
        ...proposal,
        facilityStandardStatus: "satisfied",
        requiredFacilityStandardKeys: requiredKeys,
        facilityStandardGovernanceRevision: ARTIFACT.revision
      },
      reviewIssue: null
    };
  }

  const target = proposalTarget(proposal);
  if (facilityStandardsConfirmed) {
    return {
      status: "not_satisfied",
      proposal: null,
      reviewIssue: facilityReviewIssue({
        proposal,
        target,
        issueCode: "facility_standard_not_satisfied",
        severity: "info",
        title: `${target}は提案対象外です`,
        messageForStaff: `${target}は必要な施設基準に該当しないため、算定候補へ追加していません。`,
        requiredKeys
      })
    };
  }

  return {
    status: "unknown",
    proposal: {
      ...proposal,
      actionType: "confirm_required",
      candidateOnly: true,
      adoptionBlocked: true,
      adoptionBlockReason: "facility_standard_unconfirmed",
      facilityStandardStatus: "unknown",
      requiredFacilityStandardKeys: requiredKeys,
      facilityStandardGovernanceRevision: ARTIFACT.revision
    },
    reviewIssue: facilityReviewIssue({
      proposal,
      target,
      issueCode: "facility_standard_unconfirmed",
      severity: "warning",
      title: `${target}の施設基準確認`,
      messageForStaff: `${target}に必要な施設基準の確認が完了していないため、採用不可の確認候補として表示しています。`,
      requiredKeys
    })
  };
}

function applyVariantFamilyGroups(proposals) {
  let groupCount = 0;
  const byId = new Map(proposals.map((proposal, index) => [index, proposal]));
  for (const family of VARIANT_FAMILIES) {
    const familyCodes = new Set(normalizedStrings(family.codes));
    const matchingIndexes = [...byId.entries()]
      .filter(([, proposal]) => proposalCodes(proposal).some((code) => familyCodes.has(code)))
      .map(([index]) => index);
    const distinctMatchingCodes = new Set(
      matchingIndexes.flatMap((index) => proposalCodes(byId.get(index)))
        .filter((code) => familyCodes.has(code))
    );
    if (matchingIndexes.length < 2 && distinctMatchingCodes.size < 2) {
      continue;
    }
    groupCount += 1;
    const selectionGroupId = `variant:${family.familyId}`;
    for (const index of matchingIndexes) {
      byId.set(index, {
        ...byId.get(index),
        selectionGroupId,
        selectionGroupSource: "official_variant_family",
        selectionGroupLabel: family.name,
        selectionMode: family.selectionMode,
        mutuallyExclusive: true
      });
    }
  }
  return {
    proposals: [...byId.values()],
    groupCount
  };
}

function applyCanonicalExclusionGroups(proposals, rules) {
  let groupCount = 0;
  let ignoredConditionalRuleCount = 0;
  let ambiguousComponentCount = 0;
  const byId = new Map(proposals.map((proposal, index) => [index, proposal]));
  const pairRules = new Map();
  for (const rule of asArray(rules)) {
    const specialCondition = String(rule?.specialCondition ?? "0").trim() || "0";
    if (specialCondition !== "0") {
      ignoredConditionalRuleCount += 1;
      continue;
    }
    if (
      !GROUPABLE_EXCLUSION_SCOPES.has(String(rule?.scope || ""))
      || !GROUPABLE_EXCLUSION_RESOLUTIONS.has(String(rule?.resolution || ""))
    ) {
      continue;
    }
    const codeA = String(rule?.codeA || "").trim();
    const codeB = String(rule?.codeB || "").trim();
    if (!codeA || !codeB || codeA === codeB) {
      continue;
    }
    const leftIndexes = proposalIndexesForCode(byId, codeA);
    const rightIndexes = proposalIndexesForCode(byId, codeB);
    for (const leftIndex of leftIndexes) {
      for (const rightIndex of rightIndexes) {
        if (leftIndex === rightIndex) {
          continue;
        }
        const pairKey = [Math.min(leftIndex, rightIndex), Math.max(leftIndex, rightIndex)].join(":");
        if (
          byId.get(leftIndex)?.selectionGroupId
          || byId.get(rightIndex)?.selectionGroupId
        ) {
          continue;
        }
        if (!pairRules.has(pairKey)) {
          pairRules.set(pairKey, rule);
        }
      }
    }
  }
  const adjacency = new Map();
  for (const pairKey of pairRules.keys()) {
    const [leftIndex, rightIndex] = pairKey.split(":").map(Number);
    addNeighbor(adjacency, leftIndex, rightIndex);
    addNeighbor(adjacency, rightIndex, leftIndex);
  }
  const visited = new Set();
  for (const startIndex of [...adjacency.keys()].sort((left, right) => left - right)) {
    if (visited.has(startIndex)) {
      continue;
    }
    const component = connectedIndexes(adjacency, startIndex, visited);
    if (component.length !== 2) {
      ambiguousComponentCount += 1;
      continue;
    }
    const pairKey = [...component].sort((left, right) => left - right).join(":");
    const rule = pairRules.get(pairKey);
    if (!rule) {
      ambiguousComponentCount += 1;
      continue;
    }
    groupCount += 1;
    const fingerprint = String(rule.ruleFingerprint || sha256(canonicalJson({
      codeA: rule.codeA,
      codeB: rule.codeB,
      scope: rule.scope,
      resolution: rule.resolution,
      specialCondition: String(rule.specialCondition ?? "0")
    })));
    const selectionGroupId = `exclusion:${fingerprint.slice(0, 24)}`;
    for (const index of component) {
      byId.set(index, {
        ...byId.get(index),
        selectionGroupId,
        selectionGroupSource: "canonical_exclusion_rule",
        selectionGroupLabel: "同時算定不可項目",
        selectionMode: canonicalSelectionMode(rule.resolution),
        mutuallyExclusive: true,
        exclusionRuleFingerprint: fingerprint,
        exclusionScope: rule.scope
      });
    }
  }
  return {
    proposals: [...byId.values()],
    groupCount,
    ambiguousComponentCount,
    ignoredConditionalRuleCount
  };
}

function addNeighbor(adjacency, source, target) {
  if (!adjacency.has(source)) {
    adjacency.set(source, new Set());
  }
  adjacency.get(source).add(target);
}

function connectedIndexes(adjacency, startIndex, visited) {
  const pending = [startIndex];
  const component = [];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    component.push(current);
    for (const neighbor of adjacency.get(current) || []) {
      if (!visited.has(neighbor)) {
        pending.push(neighbor);
      }
    }
  }
  return component.sort((left, right) => left - right);
}

function canonicalSelectionMode(resolution) {
  if (resolution === "auto_winner") {
    return "auto_winner";
  }
  return "choose_one";
}

function proposalIndexesForCode(byId, code) {
  return [...byId.entries()]
    .filter(([, proposal]) => proposalCodes(proposal).includes(code))
    .map(([index]) => index);
}

function proposalCodes(proposal) {
  return normalizedStrings([
    proposal?.code,
    proposal?.candidateLine?.code,
    ...asArray(proposal?.codeCandidates)
  ]);
}

function proposalTarget(proposal) {
  return String(
    proposal?.candidateLine?.name
    || proposal?.name
    || proposal?.title
    || proposal?.code
    || "算定項目"
  ).trim();
}

function facilityReviewIssue({
  proposal,
  target,
  issueCode,
  severity,
  title,
  messageForStaff,
  requiredKeys
}) {
  const proposalId = String(proposal?.proposalId || proposal?.code || target);
  return {
    reviewIssueId: `proposal_governance_${issueCode}_${sha256(proposalId).slice(0, 16)}`,
    issueCode,
    severity,
    title,
    topicCode: "facility_standard_check",
    topicLabel: "施設基準の確認",
    messageForStaff,
    requiredInput: `施設基準設定: ${requiredKeys.join(", ")}`,
    relatedCandidateId: proposal?.proposalId || null,
    source: "candidate_proposal_governance"
  };
}

function assertArtifactIntegrity(artifact) {
  if (artifact?.schemaVersion !== "fee-proposal-governance-artifact-v2") {
    throw new TypeError("unsupported fee proposal governance artifact");
  }
  const {
    artifactPayloadSha256,
    ...payload
  } = artifact;
  if (
    !/^[a-f0-9]{64}$/u.test(String(artifactPayloadSha256 || ""))
    || sha256(canonicalJson(payload)) !== artifactPayloadSha256
  ) {
    throw new TypeError("fee proposal governance artifact checksum mismatch");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizedStrings(values) {
  return [...new Set(asArray(values)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function dedupeBy(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
