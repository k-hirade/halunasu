import crypto from "node:crypto";
import {
  validateDraftAiInput,
  validateFeeLinkageInput,
  validateReferralAttachmentInput,
  validateReferralImportInput,
  validateReplyLetterInput,
  validateRenderReferralDocumentInput,
  validatePatchReferralDraftInput,
  validateUpsertRecipientDirectoryInput,
  validateUpsertReferralTemplateInput
} from "../../referral-contracts/src/index.js";

export function buildReferralDraft(input = {}, options = {}) {
  const now = timestamp(options.now);
  const referralId = options.referralId || createId("ref");

  return compactObject({
    referralId,
    orgId: requiredString(input.orgId, "orgId"),
    patientId: requiredString(input.patientId, "patientId"),
    patientSnapshot: input.patientSnapshot || null,
    facilityId: requiredString(input.facilityId, "facilityId"),
    facilitySnapshot: input.facilitySnapshot || null,
    departmentId: requiredString(input.departmentId, "departmentId"),
    departmentSnapshot: input.departmentSnapshot || null,
    authorMemberId: requiredString(input.authorMemberId, "authorMemberId"),
    authorMemberSnapshot: input.authorMemberSnapshot || null,
    recipientInstitutionSnapshot: snapshotRecipientInstitution(input.recipientInstitution, now),
    recipientDoctorSnapshot: snapshotRecipientDoctor(input.recipientDoctor, now),
    status: input.status || "draft",
    documentType: input.documentType || "clinical_information",
    urgency: input.urgency || "routine",
    title: input.title || "診療情報提供書",
    purpose: input.purpose || "",
    clinicalSummary: input.clinicalSummary || "",
    diagnoses: Array.isArray(input.diagnoses) ? input.diagnoses : [],
    medications: Array.isArray(input.medications) ? input.medications : [],
    allergies: Array.isArray(input.allergies) ? input.allergies : [],
    requestedAction: input.requestedAction || "",
    notes: input.notes || "",
    sourceImports: Array.isArray(input.sourceImports) ? input.sourceImports : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    replies: Array.isArray(input.replies) ? input.replies : [],
    reviewChecklist: buildReferralReviewChecklist(input),
    feeLinkage: input.feeLinkage || buildDefaultFeeLinkage(),
    finalizedAt: input.finalizedAt || null,
    sentAt: input.sentAt || null,
    sentMethod: input.sentMethod || "",
    replyStatus: input.replyStatus || "none",
    documentArtifact: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function patchReferralDraft(current = {}, input = {}, options = {}) {
  const patch = validatePatchReferralDraftInput(input);
  const now = timestamp(options.now);

  return compactObject({
    ...current,
    facilityId: hasOwn(patch, "facilityId") ? patch.facilityId || current.facilityId : current.facilityId,
    facilitySnapshot: hasOwn(input, "facilitySnapshot") ? input.facilitySnapshot || current.facilitySnapshot : current.facilitySnapshot,
    departmentId: hasOwn(patch, "departmentId") ? patch.departmentId || current.departmentId : current.departmentId,
    departmentSnapshot: hasOwn(input, "departmentSnapshot") ? input.departmentSnapshot || current.departmentSnapshot : current.departmentSnapshot,
    authorMemberId: hasOwn(patch, "authorMemberId") ? patch.authorMemberId || current.authorMemberId : current.authorMemberId,
    authorMemberSnapshot: hasOwn(input, "authorMemberSnapshot") ? input.authorMemberSnapshot || current.authorMemberSnapshot : current.authorMemberSnapshot,
    recipientInstitutionSnapshot: hasOwn(patch, "recipientInstitution")
      ? snapshotRecipientInstitution(patch.recipientInstitution, now)
      : current.recipientInstitutionSnapshot,
    recipientDoctorSnapshot: hasOwn(patch, "recipientDoctor")
      ? snapshotRecipientDoctor(patch.recipientDoctor, now)
      : current.recipientDoctorSnapshot,
    documentType: hasOwn(patch, "documentType") ? patch.documentType || current.documentType : current.documentType,
    urgency: hasOwn(patch, "urgency") ? patch.urgency || current.urgency : current.urgency,
    title: hasOwn(patch, "title") ? patch.title || current.title : current.title,
    purpose: hasOwn(patch, "purpose") ? patch.purpose || "" : current.purpose,
    clinicalSummary: hasOwn(patch, "clinicalSummary") ? patch.clinicalSummary || "" : current.clinicalSummary,
    diagnoses: hasOwn(patch, "diagnoses") ? patch.diagnoses : current.diagnoses,
    medications: hasOwn(patch, "medications") ? patch.medications : current.medications,
    allergies: hasOwn(patch, "allergies") ? patch.allergies : current.allergies,
    requestedAction: hasOwn(patch, "requestedAction") ? patch.requestedAction || "" : current.requestedAction,
    notes: hasOwn(patch, "notes") ? patch.notes || "" : current.notes,
    attachments: hasOwn(patch, "attachments") ? patch.attachments : current.attachments || [],
    sourceImports: hasOwn(patch, "sourceImports") ? patch.sourceImports : current.sourceImports || [],
    reviewChecklist: hasOwn(patch, "reviewChecklist") ? patch.reviewChecklist : buildReferralReviewChecklist({ ...current, ...patch }),
    feeLinkage: hasOwn(patch, "feeLinkage") ? patch.feeLinkage : current.feeLinkage || buildDefaultFeeLinkage(),
    status: hasOwn(patch, "status") ? patch.status || current.status : current.status,
    updatedAt: now
  });
}

export function attachReferralDocument(current = {}, input = {}, options = {}) {
  const documentArtifact = buildReferralDocument(current, input, options);
  const now = timestamp(options.now);

  return {
    ...current,
    status: "document_ready",
    reviewChecklist: buildReferralReviewChecklist(current),
    documentArtifact,
    updatedAt: now
  };
}

export function buildReferralDocument(referral = {}, input = {}, options = {}) {
  const normalized = validateRenderReferralDocumentInput(input);
  const now = normalized.requestedAt || timestamp(options.now);
  const fileName = normalized.fileName || `${referral.referralId || "referral"}-referral.html`;
  const renderedText = renderReferralText(referral);
  const renderedHtml = renderReferralHtml(referral, renderedText);

  return {
    documentArtifactId: options.documentArtifactId || createId("doc"),
    referralId: requiredString(referral.referralId, "referralId"),
    orgId: requiredString(referral.orgId, "orgId"),
    provider: "halunasu_html",
    status: "ready",
    fileName,
    contentType: "text/html; charset=utf-8",
    storage: "inline",
    renderedText,
    renderedHtml,
    createdAt: now,
    schemaVersion: 1
  };
}

export function buildRecipientDirectoryEntry(input = {}, options = {}) {
  const normalized = validateUpsertRecipientDirectoryInput(input);
  const now = timestamp(options.now);
  const recipientId = normalized.recipientId || options.recipientId || createId("rcp");

  return {
    recipientId,
    ...normalized,
    recipientId,
    createdAt: options.createdAt || now,
    updatedAt: now,
    schemaVersion: 1
  };
}

export function patchRecipientDirectoryEntry(current = {}, input = {}, options = {}) {
  const normalized = validateUpsertRecipientDirectoryInput({ ...current, ...input });
  const now = timestamp(options.now);

  return {
    ...current,
    ...normalized,
    recipientId: current.recipientId || normalized.recipientId || options.recipientId || createId("rcp"),
    createdAt: current.createdAt || now,
    updatedAt: now,
    schemaVersion: current.schemaVersion || 1
  };
}

export function buildReferralTemplate(input = {}, options = {}) {
  const normalized = validateUpsertReferralTemplateInput(input);
  const now = timestamp(options.now);
  const templateId = normalized.templateId || options.templateId || createId("tpl");

  return {
    templateId,
    ...normalized,
    templateId,
    createdAt: options.createdAt || now,
    updatedAt: now,
    schemaVersion: 1
  };
}

export function patchReferralTemplate(current = {}, input = {}, options = {}) {
  const normalized = validateUpsertReferralTemplateInput({ ...current, ...input });
  const now = timestamp(options.now);

  return {
    ...current,
    ...normalized,
    templateId: current.templateId || normalized.templateId || options.templateId || createId("tpl"),
    createdAt: current.createdAt || now,
    updatedAt: now,
    schemaVersion: current.schemaVersion || 1
  };
}

export function addReferralImport(current = {}, input = {}, options = {}) {
  const normalized = validateReferralImportInput(input);
  const now = timestamp(options.now);
  const importId = options.importId || createId("imp");
  const sourceImport = {
    importId,
    ...normalized,
    importedAt: now,
    importedBy: normalized.importedBy || options.memberId || ""
  };

  return {
    ...current,
    sourceImports: dedupeImports([...(current.sourceImports || []), sourceImport]),
    purpose: current.purpose || draftTextFromSource(normalized).purpose,
    clinicalSummary: current.clinicalSummary || draftTextFromSource(normalized).clinicalSummary,
    diagnoses: current.diagnoses?.length ? current.diagnoses : draftTextFromSource(normalized).diagnoses,
    medications: current.medications?.length ? current.medications : draftTextFromSource(normalized).medications,
    reviewChecklist: buildReferralReviewChecklist({
      ...current,
      sourceImports: [...(current.sourceImports || []), sourceImport]
    }),
    updatedAt: now
  };
}

export function addReferralAttachment(current = {}, input = {}, options = {}) {
  const normalized = validateReferralAttachmentInput(input);
  const now = timestamp(options.now);
  const attachment = {
    attachmentId: normalized.attachmentId || options.attachmentId || createId("att"),
    ...normalized,
    attachedAt: now,
    attachedBy: options.memberId || ""
  };

  return {
    ...current,
    attachments: [...(current.attachments || []), attachment],
    reviewChecklist: buildReferralReviewChecklist({
      ...current,
      attachments: [...(current.attachments || []), attachment]
    }),
    updatedAt: now
  };
}

export function addReplyLetter(current = {}, input = {}, options = {}) {
  const normalized = validateReplyLetterInput(input);
  const now = timestamp(options.now);
  const reply = {
    replyId: normalized.replyId || options.replyId || createId("rpl"),
    ...normalized,
    receivedAt: normalized.receivedAt || now,
    createdAt: now,
    createdBy: options.memberId || ""
  };

  return {
    ...current,
    replies: [...(current.replies || []), reply],
    replyStatus: "received",
    updatedAt: now
  };
}

export function updateFeeLinkage(current = {}, input = {}, options = {}) {
  const normalized = validateFeeLinkageInput(input);
  const now = timestamp(options.now);

  return {
    ...current,
    feeLinkage: {
      ...buildDefaultFeeLinkage(),
      ...(current.feeLinkage || {}),
      ...normalized,
      linkedAt: normalized.status === "linked" ? now : current.feeLinkage?.linkedAt || null,
      linkedByMemberId: normalized.status === "linked" ? options.memberId || "" : current.feeLinkage?.linkedByMemberId || ""
    },
    updatedAt: now
  };
}

export function finalizeReferral(current = {}, input = {}, options = {}) {
  const now = timestamp(options.now);
  const status = input.status || "ready";

  return {
    ...current,
    status,
    finalizedAt: status === "ready" || status === "document_ready" || status === "sent" ? current.finalizedAt || now : current.finalizedAt || null,
    sentAt: status === "sent" ? input.sentAt || now : current.sentAt || null,
    sentMethod: status === "sent" ? input.sentMethod || current.sentMethod || "manual" : current.sentMethod || "",
    reviewChecklist: buildReferralReviewChecklist(current),
    updatedAt: now
  };
}

export function buildDraftSuggestion(input = {}) {
  const normalized = validateDraftAiInput(input);
  const source = sourceTextFromDraftInput(normalized);
  const sections = splitClinicalSections(source);
  const diagnoses = extractLineItems(sections.a || source, ["診断", "病名", "A", "Assessment"]).slice(0, 8);
  const medications = extractMedicationLines(source).slice(0, 20);
  const purpose = normalized.documentType === "reply"
    ? "診療経過のご報告"
    : inferPurpose(source);
  const clinicalSummary = [
    sections.s ? `主訴・症状: ${sections.s}` : "",
    sections.o ? `所見・検査: ${sections.o}` : "",
    sections.a ? `評価: ${sections.a}` : "",
    sections.p ? `方針: ${sections.p}` : ""
  ].filter(Boolean).join("\n");
  const requestedAction = inferRequestedAction(source, normalized.documentType);

  return {
    provider: "halunasu_draft_assistant",
    generatedAt: new Date().toISOString(),
    purpose,
    clinicalSummary: clinicalSummary || source.slice(0, 2000),
    diagnoses,
    medications,
    allergies: extractAllergyLines(source),
    requestedAction,
    warnings: [
      "下書きはカルテ本文からの整形候補です。医師が内容を確認してから発行してください。",
      "本文にない検査結果・処方・依頼事項は補完していません。"
    ]
  };
}

export function buildReferralReviewChecklist(referral = {}) {
  const recipientInstitution = referral.recipientInstitutionSnapshot || referral.recipientInstitution || {};
  const recipientDoctor = referral.recipientDoctorSnapshot || referral.recipientDoctor || {};
  const items = [
    checklistItem("patient", "患者", Boolean(referral.patientId || referral.patientSnapshot?.displayName), "患者が選択されていません。"),
    checklistItem("recipient_institution", "宛先医療機関", Boolean(recipientInstitution.displayName), "宛先医療機関が未入力です。"),
    checklistItem("recipient_person", "宛先診療科・医師", Boolean(recipientDoctor.displayName || recipientInstitution.departmentName), "宛先医師または診療科が未入力です。"),
    checklistItem("purpose", "紹介目的", Boolean(String(referral.purpose || "").trim()), "紹介目的が未入力です。"),
    checklistItem("clinical_summary", "経過", Boolean(String(referral.clinicalSummary || "").trim()), "診療経過が未入力です。"),
    checklistItem("diagnoses", "傷病名", Array.isArray(referral.diagnoses) && referral.diagnoses.length > 0, "傷病名が未入力です。"),
    checklistItem("requested_action", "依頼事項", Boolean(String(referral.requestedAction || "").trim()), "依頼事項が未入力です。"),
    checklistItem("author", "作成医師", Boolean(referral.authorMemberId || referral.authorMemberSnapshot?.displayName), "作成者が確認できません。")
  ];

  return items;
}

export function buildDefaultFeeLinkage() {
  return {
    suggestedBillingConcept: "診療情報提供料",
    status: "not_linked",
    notes: ""
  };
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function renderReferralText(referral) {
  return [
    referral.title || "診療情報提供書",
    "",
    `患者: ${referral.patientSnapshot?.displayName || referral.patientId}`,
    `紹介先: ${referral.recipientInstitutionSnapshot?.displayName || ""} ${referral.recipientDoctorSnapshot?.displayName || ""}`,
    `目的: ${referral.purpose || ""}`,
    referral.urgency && referral.urgency !== "routine" ? `緊急度: ${referral.urgency}` : "",
    referral.diagnoses?.length ? `傷病名: ${referral.diagnoses.join("、")}` : "",
    "",
    referral.clinicalSummary || "",
    referral.medications?.length ? `\n処方:\n${referral.medications.join("\n")}` : "",
    referral.allergies?.length ? `\nアレルギー:\n${referral.allergies.join("\n")}` : "",
    "",
    referral.requestedAction || "",
    referral.notes ? `\n備考:\n${referral.notes}` : ""
  ].join("\n").trim();
}

function renderReferralHtml(referral, renderedText) {
  const lines = String(renderedText || "")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
  return [
    "<!doctype html>",
    "<html lang=\"ja\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(referral.title || "診療情報提供書")}</title>`,
    "<style>",
    "body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;margin:32px;color:#111;line-height:1.8}",
    "main{max-width:800px;margin:0 auto}",
    "h1{text-align:center;font-size:22px;margin:0 0 28px}",
    "p{margin:0 0 6px;white-space:pre-wrap}",
    "@media print{body{margin:18mm}}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(referral.title || "診療情報提供書")}</h1>`,
    lines,
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function checklistItem(key, label, passed, missingMessage) {
  return {
    key,
    label,
    status: passed ? "passed" : "missing",
    message: passed ? "" : missingMessage,
    required: true
  };
}

function dedupeImports(imports) {
  const seen = new Set();
  return imports.filter((sourceImport) => {
    const key = sourceImport.idempotencyKey || `${sourceImport.sourceProduct}:${sourceImport.sourceType}:${sourceImport.sourceId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function draftTextFromSource(sourceImport) {
  const suggestion = buildDraftSuggestion({
    sourceSnapshot: sourceImport.sourceSnapshot,
    sourceText: sourceImport.sourceSnapshot?.soapDraft || sourceImport.sourceSnapshot?.clinicalText || sourceImport.sourceSnapshot?.text || ""
  });

  return {
    purpose: suggestion.purpose,
    clinicalSummary: suggestion.clinicalSummary,
    diagnoses: suggestion.diagnoses,
    medications: suggestion.medications
  };
}

function sourceTextFromDraftInput(input) {
  if (input.sourceText) {
    return input.sourceText;
  }
  const snapshot = input.sourceSnapshot || {};
  return [
    snapshot.soapDraft,
    snapshot.clinicalText,
    snapshot.text,
    snapshot.summary,
    Array.isArray(snapshot.diagnoses) ? snapshot.diagnoses.join("\n") : ""
  ].filter(Boolean).join("\n").trim();
}

function splitClinicalSections(text) {
  const sections = { s: "", o: "", a: "", p: "" };
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let current = "";

  for (const line of lines) {
    const match = line.match(/^([SOAP])\s*[:：]\s*(.*)$/iu);
    if (match) {
      current = match[1].toLowerCase();
      sections[current] = [sections[current], match[2]].filter(Boolean).join("\n");
      continue;
    }
    if (current) {
      sections[current] = [sections[current], line].filter(Boolean).join("\n");
    }
  }

  return sections;
}

function extractLineItems(text, labels) {
  const source = String(text || "");
  const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const withoutLabel = line.replace(new RegExp(`^(${labels.join("|")})\\s*[:：]?\\s*`, "iu"), "").trim();
    for (const item of withoutLabel.split(/[、,]/u)) {
      const normalized = item.trim();
      if (normalized && normalized.length <= 80 && !items.includes(normalized)) {
        items.push(normalized);
      }
    }
  }
  return items;
}

function extractMedicationLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /(処方|内服|外用|点眼|吸入|mg|錠|日分|回)/u.test(line))
    .slice(0, 20);
}

function extractAllergyLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /(アレルギー|副作用)/u.test(line))
    .slice(0, 10);
}

function inferPurpose(text) {
  if (/(入院|救急|至急|緊急)/u.test(text)) return "入院・緊急対応のご相談";
  if (/(CT|MRI|内視鏡|検査|精査)/iu.test(text)) return "精査依頼";
  if (/(逆紹介|継続加療|経過報告)/u.test(text)) return "診療経過のご報告";
  return "専門的なご評価・加療のお願い";
}

function inferRequestedAction(text, documentType) {
  if (documentType === "reply") return "今後の診療方針についてご確認ください。";
  if (/(検査|精査|CT|MRI|内視鏡)/iu.test(text)) return "精査および今後の治療方針についてご高診をお願いいたします。";
  if (/(入院|救急|緊急)/u.test(text)) return "入院適応を含めたご評価をお願いいたします。";
  return "ご高診のほどよろしくお願いいたします。";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snapshotRecipientInstitution(input = {}, snapshotAt) {
  return {
    ...input,
    snapshotAt
  };
}

function snapshotRecipientDoctor(input = {}, snapshotAt) {
  return {
    ...input,
    snapshotAt
  };
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required`);
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = field;
    throw error;
  }

  return value.trim();
}

function timestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value || new Date().toISOString();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}
