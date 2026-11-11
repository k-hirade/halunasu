// 施設管理の追加の設定（デジカルの施設管理の項目に合わせる）。医院ごとに、項目（section）ごとに 1 件を版つきで持つ。
//   docTemplates     文書雛形（紹介状などの本文のひな形。文書の画面で「雛形から作る」に使う）
//   labLists         検査会社と院内検査項目（院内検査項目はカルテのオーダーの候補に加わる）
//   receptionLabels  受付ラベル・患者マーク（受付の画面が読む。受付メモのラベル・氏名の横のマーク）
//   clinicHours      診療時間・予約枠（予約の画面が読む）
//   printSettings    帳票設定（紙の印字の選択）
//   otherSettings    その他設定（文書の既定の入力方法・操作記録の既定の期間）
// 読むのは眼科の役割を持つ全員、直すのは管理者。どれも追加の値で、保存していなければ既定の値を返す（従来の動きのまま）。

export const CLINIC_CONFIG_SECTIONS = Object.freeze(["docTemplates", "labLists", "receptionLabels", "clinicHours", "printSettings", "otherSettings"]);
export const DOC_TEMPLATE_TYPES = Object.freeze(["referral", "reply", "certificate", "other"]);
export const LABEL_TONES = Object.freeze(["teal", "blue", "amber", "red", "gray"]);
export const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"]);
export const SLOT_MINUTES = Object.freeze([10, 15, 20, 30, 60]);
export const HONORIFICS = Object.freeze(["御侍史", "御机下", "先生", "殿", "御中"]);
export const DOCUMENT_INPUT_MODES = Object.freeze(["fields", "text"]);
export const AUDIT_DEFAULT_RANGES = Object.freeze(["today", "7d", "30d"]);
export const LAB_ITEM_KINDS = Object.freeze(["exam", "procedure"]);
// 院内検査項目をオーダーの候補にするときの code の頭（既定の候補の code と重ならないように）
export const LAB_ITEM_CODE_PREFIX = "lab:";

const MAX_ITEMS = 200;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

export function defaultClinicConfig(section) {
  switch (section) {
    case "docTemplates": return { templates: [] };
    case "labLists": return { companies: [], items: [] };
    case "receptionLabels": return { labels: [], marks: [] };
    case "clinicHours": return { slotMinutes: 30, days: Object.fromEntries(WEEKDAYS.map((day) => [day, []])), note: "" };
    case "printSettings": return { defaultHonorific: "御侍史", letterSeal: true, billingSlipDiagnoses: true, footerNote: "" };
    case "otherSettings": return { documentInputMode: "text", auditDefaultRange: "7d" };
    default: throw validationError("unknown settings section", "section");
  }
}

export function assertClinicConfigSection(section) {
  if (!CLINIC_CONFIG_SECTIONS.includes(section)) {
    const error = new Error("Route not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
}

// PUT の本文 { expectedRevision, value }。value は項目ごとに形を確かめ、余分な値は落とす。
export function validateClinicConfigInput(section, input = {}, { createId } = {}) {
  assertClinicConfigSection(section);
  if (!isObject(input)) throw validationError("body must be an object", "body");
  const expectedRevision = input.expectedRevision === undefined ? 0 : input.expectedRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw validationError("expectedRevision must be a non-negative integer", "expectedRevision");
  const value = isObject(input.value) ? input.value : {};
  const id = (prefix) => (createId ? createId(prefix) : `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  return { expectedRevision, value: VALIDATORS[section](value, id) };
}

const VALIDATORS = {
  docTemplates(value, id) {
    const templates = list(value.templates, "templates").map((item, index) => {
      const field = `templates.${index}`;
      return {
        templateId: optionalId(item.templateId, `${field}.templateId`) || id("etpl"),
        name: requiredText(item.name, `${field}.name`, 60),
        type: enumOf(item.type, DOC_TEMPLATE_TYPES, `${field}.type`, "other"),
        title: text(item.title, `${field}.title`, 60),
        body: text(item.body, `${field}.body`, 10000, { multiline: true }),
        active: item.active !== false
      };
    });
    return { templates: uniqueBy(templates, "templateId") };
  },
  labLists(value, id) {
    const companies = list(value.companies, "companies").map((item, index) => {
      const field = `companies.${index}`;
      return {
        companyId: optionalId(item.companyId, `${field}.companyId`) || id("elab"),
        name: requiredText(item.name, `${field}.name`, 60),
        phone: phoneText(item.phone, `${field}.phone`),
        note: text(item.note, `${field}.note`, 200),
        active: item.active !== false
      };
    });
    const companyIds = new Set(companies.map((item) => item.companyId));
    const items = list(value.items, "items").map((item, index) => {
      const field = `items.${index}`;
      const companyId = optionalId(item.companyId, `${field}.companyId`);
      if (companyId && !companyIds.has(companyId)) throw validationError("検査会社が見つかりません。", `${field}.companyId`);
      return {
        itemId: optionalId(item.itemId, `${field}.itemId`) || id("elit"),
        name: requiredText(item.name, `${field}.name`, 60),
        kind: enumOf(item.kind, LAB_ITEM_KINDS, `${field}.kind`, "exam"),
        requiresEye: item.requiresEye !== false,
        companyId,
        active: item.active !== false
      };
    });
    return { companies: uniqueBy(companies, "companyId"), items: uniqueBy(items, "itemId") };
  },
  receptionLabels(value, id) {
    const labels = list(value.labels, "labels").map((item, index) => {
      const field = `labels.${index}`;
      return {
        labelId: optionalId(item.labelId, `${field}.labelId`) || id("erlb"),
        name: requiredText(item.name, `${field}.name`, 20),
        tone: enumOf(item.tone, LABEL_TONES, `${field}.tone`, "gray"),
        active: item.active !== false
      };
    });
    const marks = list(value.marks, "marks").map((item, index) => {
      const field = `marks.${index}`;
      const symbol = requiredText(item.symbol, `${field}.symbol`, 2);
      return {
        markId: optionalId(item.markId, `${field}.markId`) || id("epmk"),
        name: requiredText(item.name, `${field}.name`, 20),
        symbol,
        tone: enumOf(item.tone, LABEL_TONES, `${field}.tone`, "gray"),
        active: item.active !== false
      };
    });
    return { labels: uniqueBy(labels, "labelId"), marks: uniqueBy(marks, "markId") };
  },
  clinicHours(value) {
    const slotMinutes = value.slotMinutes === undefined ? 30 : value.slotMinutes;
    if (!SLOT_MINUTES.includes(slotMinutes)) throw validationError(`slotMinutes must be one of ${SLOT_MINUTES.join(", ")}`, "slotMinutes");
    const daysInput = isObject(value.days) ? value.days : {};
    const days = {};
    for (const day of WEEKDAYS) {
      const ranges = daysInput[day] === undefined ? [] : daysInput[day];
      if (!Array.isArray(ranges) || ranges.length > 3) throw validationError("1日の診療時間は3つまでです。", `days.${day}`);
      days[day] = ranges.map((range, index) => {
        const field = `days.${day}.${index}`;
        if (!isObject(range) || !TIME.test(String(range.from || "")) || !TIME.test(String(range.to || ""))) throw validationError("時刻は 09:00 の形で入れてください。", field);
        if (range.to <= range.from) throw validationError("終わりの時刻は始まりより後にしてください。", field);
        return { from: range.from, to: range.to };
      }).sort((left, right) => left.from.localeCompare(right.from));
      for (let index = 1; index < days[day].length; index += 1) {
        if (days[day][index].from < days[day][index - 1].to) throw validationError("診療時間が重なっています。", `days.${day}.${index}`);
      }
    }
    return { slotMinutes, days, note: text(value.note, "note", 200) };
  },
  printSettings(value) {
    return {
      defaultHonorific: enumOf(value.defaultHonorific, HONORIFICS, "defaultHonorific", "御侍史"),
      letterSeal: value.letterSeal !== false,
      billingSlipDiagnoses: value.billingSlipDiagnoses !== false,
      footerNote: text(value.footerNote, "footerNote", 200)
    };
  },
  otherSettings(value) {
    return {
      documentInputMode: enumOf(value.documentInputMode, DOCUMENT_INPUT_MODES, "documentInputMode", "text"),
      auditDefaultRange: enumOf(value.auditDefaultRange, AUDIT_DEFAULT_RANGES, "auditDefaultRange", "7d")
    };
  }
};

export function buildClinicConfig(current, section, value, { actor, now }) {
  return {
    section,
    value,
    revision: (current?.revision || 0) + 1,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    updatedBy: actor
  };
}

// 返す形: { value, revision, updatedAt, updatedBy }。保存が無ければ既定の値と revision 0。
export function clinicConfigView(section, stored) {
  return {
    value: stored?.value ? { ...defaultClinicConfig(section), ...stored.value } : defaultClinicConfig(section),
    revision: stored?.revision || 0,
    updatedAt: stored?.updatedAt || "",
    updatedBy: stored?.updatedBy || null
  };
}

// 保存前後で変わった項目の数（操作記録に残す。名前や本文は残さない）
export function clinicConfigChangeSummary(section, before, after) {
  const counts = (value) => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => Array.isArray(item)).map(([key, item]) => [key, item.length]));
  const changedKeys = Object.keys(after || {}).filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
  return { section, changedKeys, counts: counts(after) };
}

// カルテのオーダーの候補に加える院内検査項目（有効なものだけ）。既定の候補のあとに並ぶ。
export function labCatalogItems(labLists) {
  const companies = new Map((labLists?.companies || []).map((item) => [item.companyId, item]));
  return (labLists?.items || [])
    .filter((item) => item.active !== false)
    .map((item) => {
      const company = item.companyId ? companies.get(item.companyId) : null;
      return {
        code: `${LAB_ITEM_CODE_PREFIX}${item.itemId}`,
        name: item.name,
        kind: item.kind || "exam",
        requiresEye: item.requiresEye !== false,
        source: "clinic",
        ...(company && company.active !== false ? { labCompany: company.name } : {})
      };
    });
}

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} must be an array`, field);
  if (value.length > MAX_ITEMS) throw validationError(`${field} must have at most ${MAX_ITEMS} items`, field);
  return value.map((item, index) => {
    if (!isObject(item)) throw validationError(`${field}.${index} must be an object`, `${field}.${index}`);
    return item;
  });
}

function text(value, field, max, { multiline = false } = {}) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw validationError(`${field} must be a string`, field);
  const normalized = multiline ? value.replace(/\r\n?/gu, "\n").replace(/\s+$/u, "") : value.replace(/\s+/gu, " ").trim();
  if (normalized.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
  return normalized;
}

function requiredText(value, field, max) {
  const result = text(value, field, max);
  if (!result) throw validationError("名前を入れてください。", field);
  return result;
}

function phoneText(value, field) {
  const result = text(value, field, 30);
  if (result && !/^[0-9０-９()（）+＋\-－‐ー ]+$/u.test(result)) throw validationError("電話番号は数字とハイフンで入れてください。", field);
  return result;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,60}$/u.test(value)) throw validationError(`${field} is invalid`, field);
  return value;
}

function enumOf(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(value)) throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  return value;
}

function uniqueBy(items, key) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw validationError(`duplicate ${key}`, key);
    seen.add(item[key]);
  }
  return items;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
