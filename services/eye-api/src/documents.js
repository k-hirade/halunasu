import { createHash } from "node:crypto";
import { prescriptionLabel } from "../../../packages/eye-core/src/index.js";

// 紹介状・返書・診断書。下書きはカルテ・患者プロファイルから差し込んで作り、医師が確定すると変更できなくなる。

export const DOCUMENT_TITLES = Object.freeze({
  referral: "診療情報提供書",
  reply: "返書（診療情報提供書）",
  certificate: "診断書",
  other: "文書"
});

const EYE_NAMES = { od: "右眼", os: "左眼", ou: "両眼" };
const ALLERGY_SEVERITY = { unknown: "", mild: "軽度", moderate: "中等度", severe: "重篤" };

export function buildDocumentDraft({ documentId, orgId, patientSnapshot, encounter, profile, facility, type, actor, now }) {
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
    sender: senderFromFacility(facility, actor),
    body: renderTemplate(type, { encounter, profile }),
    issueDate: now.slice(0, 10),
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

export function duplicateDocument(source, { documentId, actor, now }) {
  return {
    ...source,
    documentId,
    status: "draft",
    revision: 1,
    contentHash: "",
    sourceDocumentId: source.documentId,
    issueDate: now.slice(0, 10),
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

function senderFromFacility(facility, actor) {
  const address = facility?.address || {};
  return {
    facilityName: facility?.legalName || facility?.displayName || "",
    address: [address.postalCode ? `〒${address.postalCode}` : "", address.prefecture || facility?.prefecture || "", address.city || "", address.line1 || address.street || "", address.line2 || ""]
      .filter(Boolean)
      .join(" "),
    phone: facility?.phone || "",
    doctorName: actor.displayName || ""
  };
}

function renderTemplate(type, { encounter, profile }) {
  const content = encounter?.content || {};
  const diagnoses = (profile?.diagnoses || content.diagnoses || [])
    .filter((item) => item.status !== "resolved")
    .map((item) => `${EYE_NAMES[item.eye] || ""} ${item.name}${item.status === "suspected" ? "（疑い）" : ""}`.trim());
  const allergies = profile?.allergies?.length
    ? profile.allergies.map((item) => `${item.substance}${item.reaction ? `（${item.reaction}${ALLERGY_SEVERITY[item.severity] ? `・${ALLERGY_SEVERITY[item.severity]}` : ""}）` : ""}`).join("、")
    : profile?.noKnownAllergies ? "なし" : "未確認";
  const exam = content.exam || {};
  const va = (side) => {
    const value = exam[side] || {};
    const corrected = value.vaCorrected ? `（${value.vaCorrected}）` : "";
    return value.vaUncorrected || corrected ? `${value.vaUncorrected || "—"}${corrected}` : "—";
  };
  const iop = (side) => (Number.isFinite(exam[side]?.iop) ? `${exam[side].iop} mmHg` : "—");
  const findings = ["od", "os"].flatMap((side) => (
    [["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]]
      .filter(([key]) => content.findings?.[side]?.[key])
      .map(([key, label]) => `${EYE_NAMES[side]} ${label}: ${content.findings[side][key]}`)
  ));
  const prescriptions = (content.prescriptions || []).filter((item) => item.name).map(prescriptionLabel);
  const examBlock = encounter
    ? [
      `【検査所見】（${encounter.encounterDate}）`,
      `視力 右 ${va("od")}　左 ${va("os")}`,
      `眼圧 右 ${iop("od")}　左 ${iop("os")}`,
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
    [profile?.ophthalmicHistory, profile?.medicalHistory].filter(Boolean).join("\n") || "特記事項なし"
  ].join("\n");
}

function conflict(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}
