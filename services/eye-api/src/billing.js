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
    fingerprint: fingerprintOf(encounter, items),
    itemsFingerprint: itemsFingerprintOf(encounter, items),
    finalizedAt: encounter.finalizedAt || null,
    finalizedBy: encounter.finalizedBy ? { displayName: encounter.finalizedBy.displayName || "" } : null
  };
}

// 連携した回に何を渡したかの写し。差分の表示と、その回の CSV の取り直しに使う。
// Firestore に保存するため undefined は null にそろえ、配列の中に配列を入れない。
export function handoffSnapshotOf(encounter) {
  const patient = encounter.patient || {};
  return {
    encounterId: encounter.encounterId,
    version: encounter.version,
    fingerprint: encounter.fingerprint,
    itemsFingerprint: encounter.itemsFingerprint,
    encounterDate: encounter.encounterDate,
    visitType: encounter.visitType || "",
    patient: {
      primaryPatientNumber: patient.primaryPatientNumber || "",
      displayName: patient.displayName || "",
      displayNameKana: patient.displayNameKana || "",
      birthDate: patient.birthDate || "",
      sex: patient.sex || ""
    },
    items: normalizedItems(encounter.items),
    diagnoses: (encounter.diagnoses || []).map((item) => ({ name: item.name || "", eye: item.eye || "", status: item.status || "" }))
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
  // 品目だけの指紋を持つ記録はそれで比べる（所見だけの修正では再連携にしない）。持たない古い記録は版を含む指紋のまま比べる。
  const same = entry.itemsFingerprint
    ? entry.itemsFingerprint === encounter.itemsFingerprint
    : entry.fingerprint === encounter.fingerprint;
  const status = {
    state: same ? "handed_off" : "changed",
    handoffId: latest.handoffId,
    version: entry.version,
    at: latest.createdAt,
    by: latest.createdBy
  };
  if (!same) {
    // 前回の品目の写しがない（この機能より前の連携）ときは null。画面はその旨を出す。
    status.previousItems = Array.isArray(entry.items) ? entry.items : null;
    status.previousDiagnoses = Array.isArray(entry.diagnoses) ? entry.diagnoses : null;
  }
  return status;
}

// 連携の記録を一覧に返すときの形。品目の写しは重いので外し、誰の分かだけを残す。
export function handoffListItem(handoff) {
  return {
    ...handoff,
    encounters: handoff.encounters.map(({ items, diagnoses, ...entry }) => entry),
    hasSnapshot: handoff.encounters.every((entry) => Array.isArray(entry.items) && entry.patient)
  };
}

// 連携した内容の指紋。カルテが修正されて実施内容が変わったら「再連携が必要」と分かるようにする。
function fingerprintOf(encounter, items) {
  return createHash("sha256").update(JSON.stringify([encounter.encounterId, encounter.versionCount, encounter.visitType, items])).digest("hex").slice(0, 32);
}

// 実施内容だけの指紋（版は含めない）。品目の正規化は連携時の写しと同じにする。
function itemsFingerprintOf(encounter, items) {
  return createHash("sha256").update(JSON.stringify([encounter.encounterId, encounter.visitType || "", normalizedItems(items)])).digest("hex").slice(0, 32);
}

const ITEM_FIELDS = ["category", "code", "name", "eye", "quantity", "unit", "days", "route", "usage", "note"];

function normalizedItems(items = []) {
  return items.map((item) => Object.fromEntries(ITEM_FIELDS.map((key) => [key, item[key] ?? null])));
}

function csvCell(value) {
  const text = String(value ?? "");
  // 先頭が数式記号のセルは Excel で式として解釈されないよう、先頭に ' を付ける。
  const safe = /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}
