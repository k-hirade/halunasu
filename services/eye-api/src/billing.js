import { createHash } from "node:crypto";

// 会計連携。確定済みカルテから「実施したこと・出したもの」だけを拾い、レセコンへ渡す CSV と連絡票を作る。
// 点数の計算や算定の判断はしない（レセコン側で行う）。

const VISIT_TYPE = { initial: "初診", revisit: "再診" };
const EYE = { od: "右", os: "左", ou: "両" };
const SEX = { male: "男", female: "女", other: "他", unknown: "" };
const OPTICAL = { glasses: "眼鏡処方箋", contact: "コンタクトレンズ指示書" };
const DOCUMENT = { referral: "診療情報提供書", reply: "返書", certificate: "診断書", other: "文書" };

export const BILLING_CSV_COLUMNS = Object.freeze([
  "診療日", "患者番号", "氏名", "フリガナ", "生年月日", "性別", "初再診", "区分", "コード", "名称", "眼",
  "数量", "単位", "日数", "院内外", "用法", "備考", "カルテID", "カルテ版"
]);

export function buildBillingEncounter(encounter, documents = []) {
  const content = encounter.content || {};
  const items = [];
  for (const order of content.orders || []) {
    if (order.status !== "performed") continue;
    items.push({ category: order.kind === "procedure" ? "処置" : "検査", code: order.code, name: order.name, eye: order.eye, quantity: 1, unit: "回", days: null, route: "", usage: "", note: order.note || "" });
  }
  for (const item of content.prescriptions || []) {
    if (!item.name || item.issued === false) continue;
    const category = item.kind === "injection" ? "注射" : "処方";
    items.push({ category, code: item.presetId || "", name: item.name, eye: item.eye, quantity: item.quantity, unit: item.unit || "", days: item.days, route: item.kind === "injection" ? "" : item.route === "inside" ? "院内" : "院外", usage: [item.timesPerDay ? `1日${item.timesPerDay}回` : "", item.usage].filter(Boolean).join(" "), note: item.note || "" });
  }
  if (content.optical?.issue && content.optical.type) {
    items.push({ category: "文書", code: `optical_${content.optical.type}`, name: OPTICAL[content.optical.type], eye: "ou", quantity: 1, unit: "通", days: null, route: "", usage: "", note: "" });
  }
  for (const document of documents) {
    items.push({ category: "文書", code: `document_${document.type}`, name: DOCUMENT[document.type] || document.title, eye: "", quantity: 1, unit: "通", days: null, route: "", usage: "", note: document.recipient?.institution ? `宛先 ${document.recipient.institution}` : "" });
  }
  return {
    encounterId: encounter.encounterId,
    encounterDate: encounter.encounterDate,
    visitType: encounter.visitType,
    version: encounter.versionCount,
    patient: encounter.patientSnapshot,
    diagnoses: content.diagnoses || [],
    items,
    fingerprint: fingerprintOf(encounter, items)
  };
}

export function billingCsv(encounters) {
  const rows = [BILLING_CSV_COLUMNS];
  for (const encounter of encounters) {
    const patient = encounter.patient || {};
    const base = [encounter.encounterDate, patient.primaryPatientNumber || "", patient.displayName || "", patient.displayNameKana || "", patient.birthDate || "", SEX[patient.sex] || "", VISIT_TYPE[encounter.visitType] || ""];
    const items = encounter.items.length ? encounter.items : [{ category: "受診", code: "", name: VISIT_TYPE[encounter.visitType] || "受診", eye: "", quantity: null, unit: "", days: null, route: "", usage: "", note: "" }];
    for (const item of items) {
      rows.push([...base, item.category, item.code, item.name, EYE[item.eye] || "", item.quantity ?? "", item.unit, item.days ?? "", item.route, item.usage, item.note, encounter.encounterId, `v${encounter.version}`]);
    }
  }
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function handoffStatus(encounter, handoffs) {
  const latest = handoffs
    .filter((handoff) => handoff.encounters.some((item) => item.encounterId === encounter.encounterId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (!latest) return { state: "pending" };
  const entry = latest.encounters.find((item) => item.encounterId === encounter.encounterId);
  return {
    state: entry.fingerprint === encounter.fingerprint ? "handed_off" : "changed",
    handoffId: latest.handoffId,
    version: entry.version,
    at: latest.createdAt,
    by: latest.createdBy
  };
}

// 連携した内容の指紋。カルテが修正されて実施内容が変わったら「再連携が必要」と分かるようにする。
function fingerprintOf(encounter, items) {
  return createHash("sha256").update(JSON.stringify([encounter.encounterId, encounter.versionCount, encounter.visitType, items])).digest("hex").slice(0, 32);
}

function csvCell(value) {
  const text = String(value ?? "");
  // 先頭が数式記号のセルは Excel で式として解釈されないよう、先頭に ' を付ける。
  const safe = /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}
