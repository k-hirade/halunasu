const CLAIM_RISK_KNOWLEDGE = Object.freeze([{
  riskCategory: "body_laterality",
  denialType: "A/B査定",
  reason: "疾患部位と画像・処置部位、または左右が一致しない可能性があります。",
  checkPoints: ["病名の部位", "画像・処置の部位", "左右", "カルテ根拠"]
}, {
  riskCategory: "indication",
  denialType: "A/B/C査定",
  reason: "算定要件や保険適応をレセプトから読み取れない可能性があります。",
  checkPoints: ["適応病名", "実施理由", "必要コメント", "カルテ根拠"]
}]);

const BODY_SITE_GROUPS = [
  ["head", ["頭", "頭部", "顔", "顔面"]],
  ["neck", ["頸", "頚", "首"]],
  ["chest", ["胸", "胸部", "肺", "肋骨"]],
  ["abdomen", ["腹", "腹部", "胃", "腸", "肝", "胆", "膵"]],
  ["back", ["背", "腰", "腰部", "脊椎"]],
  ["shoulder", ["肩", "肩関節"]],
  ["arm", ["上腕", "前腕", "肘", "手", "手指", "指"]],
  ["leg", ["股", "膝", "下腿", "足", "足趾", "趾"]],
  ["eye", ["眼", "目", "角膜"]],
  ["ear", ["耳"]],
  ["nose", ["鼻"]],
  ["throat", ["咽頭", "喉", "扁桃"]]
];

const LATERALITY_TERMS = [
  ["bilateral", ["両側", "両"]],
  ["right", ["右"]],
  ["left", ["左"]]
];

export function assessmentRiskKnowledge() {
  return CLAIM_RISK_KNOWLEDGE;
}

export function buildClaimRiskReviewIssues(session = {}, calculation = {}) {
  const diagnoses = Array.isArray(session.diagnoses) ? session.diagnoses : [];
  const diagnosisProfile = extractClinicalLocationProfile(diagnoses.map((diagnosis) => diagnosis?.name || diagnosis).join(" "));
  if (!diagnosisProfile.bodySites.length && !diagnosisProfile.laterality.length) {
    return [];
  }

  const clinicalEvents = Array.isArray(calculation.clinicalEvents) ? calculation.clinicalEvents : [];
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const targets = [
    ...clinicalEvents.map((event) => ({
      id: event.clinicalEventId || event.clinical_event_id || event.eventId || "",
      name: clinicalEventName(event),
      text: [
        clinicalEventName(event),
        event.bodySite,
        event.body_site,
        event.laterality,
        event.evidence,
        event.text
      ].filter(Boolean).join(" "),
      type: event.eventType || event.event_type || event.category || ""
    })),
    ...lineItems.map((line) => ({
      id: line.lineId || line.code || line.name || "",
      name: line.name || line.code || "算定候補",
      text: [line.name, line.orderType, line.source, line.note].filter(Boolean).join(" "),
      type: line.orderType || ""
    }))
  ].filter((target) => isClaimRiskCheckTarget(target));

  return dedupeByKey(targets.flatMap((target) => {
    const targetProfile = extractClinicalLocationProfile(target.text);
    const issues = [];
    const lateralityMismatch = mismatchedLaterality(diagnosisProfile.laterality, targetProfile.laterality);
    if (lateralityMismatch) {
      issues.push(claimRiskReviewIssue({
        target,
        mismatchType: "laterality",
        issueCode: "claim_risk_laterality_mismatch",
        topicLabel: "部位・左右確認",
        messageForStaff: `${target.name} は ${lateralityLabel(targetProfile.laterality)} の内容ですが、病名は ${lateralityLabel(diagnosisProfile.laterality)} を示しています。左右不一致による査定リスクを確認してください。`,
        diagnosisProfile,
        targetProfile
      }));
    }
    const bodyMismatch = mismatchedBodySite(diagnosisProfile.bodySites, targetProfile.bodySites);
    if (bodyMismatch) {
      issues.push(claimRiskReviewIssue({
        target,
        mismatchType: "body_site",
        issueCode: "claim_risk_body_site_mismatch",
        topicLabel: "部位確認",
        messageForStaff: `${target.name} の部位と病名部位が一致しない可能性があります。疾患部位と画像・処置部位の相違による査定リスクを確認してください。`,
        diagnosisProfile,
        targetProfile
      }));
    }
    return issues;
  }), (issue) => issue.reviewIssueId);
}

function claimRiskReviewIssue({
  diagnosisProfile,
  issueCode,
  messageForStaff,
  mismatchType,
  target,
  targetProfile,
  topicLabel
}) {
  const knowledge = CLAIM_RISK_KNOWLEDGE[0];
  return {
    reviewIssueId: `claim_risk_${mismatchType}_${stableIssuePart([target.id, target.name, messageForStaff].join("_"))}`,
    issueCode,
    topicCode: mismatchType === "laterality" ? "laterality_mismatch" : "body_site_mismatch",
    topicLabel,
    severity: "warning",
    title: "査定リスク確認",
    messageForStaff,
    requiredInput: "病名部位、画像・処置部位、左右、カルテ根拠",
    source: "claim_risk_knowledge",
    assessmentRisk: {
      riskCategory: knowledge.riskCategory,
      denialType: knowledge.denialType,
      reason: knowledge.reason,
      checkPoints: knowledge.checkPoints
    },
    bodyLateralityCheck: {
      mismatchType,
      diagnosisBodySites: diagnosisProfile.bodySites,
      targetBodySites: targetProfile.bodySites,
      diagnosisLaterality: diagnosisProfile.laterality,
      targetLaterality: targetProfile.laterality
    },
    resolutionOptions: [
      { value: "diagnosis_fixed", label: "病名を修正" },
      { value: "comment_needed", label: "コメント・詳記が必要" },
      { value: "chart_supports", label: "カルテ根拠あり" }
    ]
  };
}

function clinicalEventName(event = {}) {
  return event.name || event.eventName || event.event_name || event.label || event.procedureName || event.procedure_name || "";
}

function isClaimRiskCheckTarget(target = {}) {
  const text = `${target.type || ""} ${target.name || ""} ${target.text || ""}`;
  return /(imaging|画像|CT|ＣＴ|MRI|ＭＲＩ|X線|Ｘ線|レントゲン|撮影|procedure|treatment|処置|手技|創傷|熱傷|縫合)/iu.test(text);
}

function extractClinicalLocationProfile(text = "") {
  const value = String(text || "");
  return {
    bodySites: BODY_SITE_GROUPS
      .filter(([, terms]) => terms.some((term) => value.includes(term)))
      .map(([group]) => group),
    laterality: LATERALITY_TERMS
      .filter(([, terms]) => terms.some((term) => value.includes(term)))
      .map(([key]) => key)
  };
}

function mismatchedLaterality(left = [], right = []) {
  const diagnosis = normalizedLaterality(left);
  const target = normalizedLaterality(right);
  if (!diagnosis || !target || diagnosis === "bilateral" || target === "bilateral") {
    return false;
  }
  return diagnosis !== target;
}

function normalizedLaterality(values = []) {
  const set = new Set(values);
  if (set.has("bilateral") || (set.has("right") && set.has("left"))) return "bilateral";
  if (set.has("right")) return "right";
  if (set.has("left")) return "left";
  return "";
}

function mismatchedBodySite(left = [], right = []) {
  if (!left.length || !right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return !left.some((site) => rightSet.has(site));
}

function lateralityLabel(values = []) {
  const normalized = normalizedLaterality(values);
  return { right: "右", left: "左", bilateral: "両側" }[normalized] || "左右不明";
}

function dedupeByKey(items = [], keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableIssuePart(value = "") {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}
