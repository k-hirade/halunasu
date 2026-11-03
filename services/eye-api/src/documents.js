import { createHash } from "node:crypto";
import {
  documentAllergyText,
  documentDiagnoses,
  documentDiagnosisText,
  documentFindingLines,
  documentHistoryText,
  documentIopLine,
  documentVaLine,
  prescriptionLabel
} from "../../../packages/eye-core/src/index.js";
import { japanDate } from "./dates.js";

// 紹介状・返書・診断書。下書きはカルテ・患者プロファイルから差し込んで作り、医師が確定すると変更できなくなる。

export const DOCUMENT_TITLES = Object.freeze({
  referral: "診療情報提供書",
  reply: "返書（診療情報提供書）",
  certificate: "診断書",
  other: "文書"
});

export function buildDocumentDraft({ documentId, orgId, patientSnapshot, encounter, profile, facility, type, actor, senderName, now }) {
  return {
    documentId,
    orgId,
    patientId: patientSnapshot.patientId,
    patientSnapshot,
    encounterId: encounter?.encounterId || "",
    encounterDate: encounter?.encounterDate || "",
    type,
    title: DOCUMENT_TITLES[type],
    recipient: { institution: "", department: "", doctor: "" },
    sender: senderFromFacility(facility, actor, senderName),
    body: renderTemplate(type, { encounter, profile }),
    issueDate: japanDate(now),
    status: "draft",
    revision: 1,
    contentHash: "",
    sourceDocumentId: "",
    createdBy: actor,
    updatedBy: actor,
    finalizedBy: null,
    finalizedAt: "",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

export function applyDocumentUpdate(current, input, { actor, now }) {
  if (current.status === "discarded") throw conflict("この下書きは破棄されています。");
  if (current.status !== "draft") throw conflict("確定済みの文書は変更できません。複製して新しい文書を作ってください。");
  return {
    ...current,
    title: input.title || current.title,
    recipient: input.recipient,
    body: input.body,
    issueDate: input.issueDate || current.issueDate,
    revision: current.revision + 1,
    updatedBy: actor,
    updatedAt: now
  };
}

export function finalizeDocument(current, { actor, now }) {
  if (current.status === "discarded") throw conflict("この下書きは破棄されています。");
  if (current.status !== "draft") throw conflict("この文書はすでに確定しています。");
  if (!current.body.trim()) {
    const error = new Error("本文が空のため確定できません。");
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = "body";
    throw error;
  }
  return {
    ...current,
    status: "finalized",
    contentHash: createHash("sha256").update(JSON.stringify([current.title, current.recipient, current.body, current.issueDate])).digest("hex"),
    revision: current.revision + 1,
    finalizedBy: actor,
    finalizedAt: now,
    updatedBy: actor,
    updatedAt: now
  };
}

// 下書きの破棄。一度も確定していない下書きだけを対象にし、記録は消さずに status を "discarded" にする
// （一覧には出さない。会計連携は確定文書しか見ないので影響しない）。
export function discardDocument(current, { actor, now }) {
  if (current.status === "discarded") throw conflict("この下書きはすでに破棄されています。");
  if (current.status !== "draft" || current.finalizedAt || current.contentHash) throw conflict("確定済みの文書は破棄できません。");
  return {
    ...current,
    status: "discarded",
    revision: current.revision + 1,
    discardedBy: actor,
    discardedAt: now,
    updatedBy: actor,
    updatedAt: now
  };
}

export function duplicateDocument(source, { documentId, actor, now }) {
  if (source.status === "discarded") throw conflict("破棄した下書きは複製できません。");
  return {
    ...source,
    documentId,
    status: "draft",
    revision: 1,
    contentHash: "",
    sourceDocumentId: source.documentId,
    issueDate: japanDate(now),
    createdBy: actor,
    updatedBy: actor,
    finalizedBy: null,
    finalizedAt: "",
    createdAt: now,
    updatedAt: now
  };
}

export function documentSummary(document) {
  return {
    documentId: document.documentId,
    patientId: document.patientId,
    encounterId: document.encounterId,
    type: document.type,
    title: document.title,
    recipient: document.recipient,
    issueDate: document.issueDate,
    status: document.status,
    finalizedAt: document.finalizedAt,
    updatedAt: document.updatedAt
  };
}

// 院内でよく使う紹介先。確定済みの文書の宛先を集計する（新しい順・同じ宛先は1件にまとめる）。
export function summarizeRecipients(documents, { limit = 30 } = {}) {
  const byKey = new Map();
  for (const document of documents) {
    if (document.status !== "finalized") continue;
    const recipient = document.recipient || {};
    const institution = String(recipient.institution || "").trim();
    if (!institution) continue;
    const department = String(recipient.department || "").trim();
    const doctor = String(recipient.doctor || "").trim();
    const key = [institution, department, doctor].join("\u0000");
    const current = byKey.get(key);
    const lastIssueDate = document.issueDate || "";
    if (current) {
      current.count += 1;
      if (lastIssueDate > current.lastIssueDate) current.lastIssueDate = lastIssueDate;
    } else {
      byKey.set(key, { institution, department, doctor, count: 1, lastIssueDate });
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.lastIssueDate.localeCompare(left.lastIssueDate) || right.count - left.count)
    .slice(0, limit);
}

function senderFromFacility(facility, actor, senderName) {
  const address = facility?.address || {};
  return {
    facilityName: facility?.legalName || facility?.displayName || "",
    address: [address.postalCode ? `〒${address.postalCode}` : "", address.prefecture || facility?.prefecture || "", address.city || "", address.line1 || address.street || "", address.line2 || ""]
      .filter(Boolean)
      .join(" "),
    phone: facility?.phone || "",
    // 紙の署名に使う氏名（印刷用の氏名、なければ表示名から役割の括弧を除いたもの）。memberId は後で印刷用の氏名を引き直すため。
    doctorName: senderName || actor.displayName || "",
    memberId: actor.memberId || ""
  };
}

function renderTemplate(type, { encounter, profile }) {
  const content = encounter?.content || {};
  const diagnoses = documentDiagnoses(profile, content).map(documentDiagnosisText);
  const allergies = documentAllergyText(profile);
  const exam = content.exam || {};
  const findings = documentFindingLines(content.findings).map((item) => item.text);
  const prescriptions = (content.prescriptions || []).filter((item) => item.name).map(prescriptionLabel);
  const examBlock = encounter
    ? [
      `【検査所見】（${encounter.encounterDate}）`,
      documentVaLine(exam),
      documentIopLine(exam),
      ...findings
    ].join("\n")
    : "【検査所見】\n";
  const list = (items) => (items.length ? items.map((item) => `・${item}`).join("\n") : "・なし");

  if (type === "certificate") {
    return [
      "【傷病名】",
      list(diagnoses),
      "",
      "【付記】",
      "上記の通り診断いたします。",
      "",
      examBlock
    ].join("\n");
  }
  if (type === "reply") {
    return [
      "このたびは患者様をご紹介いただき、誠にありがとうございました。",
      "当院での診察結果を下記の通りご報告いたします。",
      "",
      "【診断】",
      list(diagnoses),
      "",
      examBlock,
      "",
      "【当院での方針】",
      content.plan || "",
      "",
      "今後ともよろしくお願い申し上げます。"
    ].join("\n");
  }
  if (type === "other") return "";
  return [
    "平素より大変お世話になっております。",
    "下記の患者様をご紹介申し上げます。ご高診のほど、よろしくお願い申し上げます。",
    "",
    "【傷病名】",
    list(diagnoses),
    "",
    "【紹介目的】",
    "",
    "",
    "【現病歴・経過】",
    [content.chiefComplaint, content.history].filter(Boolean).join("\n"),
    "",
    examBlock,
    "",
    "【現在の処方】",
    list(prescriptions),
    "",
    "【アレルギー・副作用歴】",
    allergies,
    "",
    "【既往歴】",
    documentHistoryText(profile) || "特記事項なし"
  ].join("\n");
}

function conflict(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}
