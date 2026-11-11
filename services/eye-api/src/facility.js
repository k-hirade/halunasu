// 医療機関情報（眼科カルテの設定）。紙（紹介状・カルテの印刷・眼鏡処方箋・会計連絡票）に載せる値を医院が自分で直せるようにする。
// 基本の施設情報（platform の facilities）は書き換えず、ここで入れた値だけを上に重ねて返す。空の欄は基本の値のまま。

export const FACILITY_SETTINGS_FIELDS = Object.freeze({
  name: 100,
  medicalInstitutionCode: 20,
  postalCode: 10,
  address: 200,
  phone: 30,
  fax: 30,
  email: 200,
  founder: 100,
  administrator: 100,
  // デジカルの医療機関情報の編集に合わせて追加（どれも任意。空なら紙には出さない）
  nameKana: 100,
  representative: 100,
  representativeKana: 100,
  prescriptionRoute: 10,
  invoiceRegistrationNumber: 20
});

// 院内・院外処方（医院の既定。紙には出さない）
export const PRESCRIPTION_ROUTES = Object.freeze(["outside", "inside"]);
const INVOICE_NUMBER = /^T\d{13}$/u;
const KANA = /^[゠-ヿ぀-ゟ･-ﾟ ・ー－\-　]+$/u;

const POSTAL_CODE = /^\d{3}-?\d{4}$/u;
const PHONE = /^[0-9０-９()（）+＋\-－‐ー ]+$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INSTITUTION_CODE = /^[0-9０-９.\-]+$/u;

export function validateFacilitySettingsInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("body must be an object", "body");
  const expectedRevision = input.expectedRevision === undefined ? 0 : input.expectedRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw validationError("expectedRevision must be a non-negative integer", "expectedRevision");
  const values = {};
  for (const [field, max] of Object.entries(FACILITY_SETTINGS_FIELDS)) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      values[field] = "";
      continue;
    }
    if (typeof raw !== "string") throw validationError(`${field} must be a string`, field);
    const value = raw.replace(/\s+/gu, " ").trim();
    if (value.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
    values[field] = value;
  }
  if (values.postalCode && !POSTAL_CODE.test(values.postalCode.normalize("NFKC"))) throw validationError("郵便番号は 123-4567 の形で入れてください。", "postalCode");
  if (values.postalCode) values.postalCode = formatPostalCode(values.postalCode);
  for (const field of ["phone", "fax"]) {
    if (values[field] && !PHONE.test(values[field])) throw validationError("電話番号・FAX番号は数字とハイフンで入れてください。", field);
  }
  if (values.email && !EMAIL.test(values.email)) throw validationError("メールアドレスの形を確認してください。", "email");
  if (values.medicalInstitutionCode && !INSTITUTION_CODE.test(values.medicalInstitutionCode)) throw validationError("医療機関コードは数字で入れてください。", "medicalInstitutionCode");
  for (const field of ["nameKana", "representativeKana"]) {
    if (values[field] && !KANA.test(values[field])) throw validationError("フリガナはカタカナで入れてください。", field);
  }
  if (values.prescriptionRoute && !PRESCRIPTION_ROUTES.includes(values.prescriptionRoute)) throw validationError("院内・院外を選んでください。", "prescriptionRoute");
  if (values.invoiceRegistrationNumber) {
    values.invoiceRegistrationNumber = values.invoiceRegistrationNumber.normalize("NFKC").toUpperCase().replace(/[\s-]/gu, "");
    if (!INVOICE_NUMBER.test(values.invoiceRegistrationNumber)) throw validationError("適格請求書発行事業者の登録番号は T と13桁の数字で入れてください。", "invoiceRegistrationNumber");
  }
  return { expectedRevision, values };
}

export function buildFacilitySettings(current, values, { actor, now }) {
  return {
    ...values,
    revision: (current?.revision || 0) + 1,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    updatedBy: actor
  };
}

// 画面・紙に使う施設: 有効な施設（無ければ先頭）に、医療機関情報の入力を重ねる。
export function pickFacility(facilities = []) {
  return facilities.find((item) => item.status === "active") || facilities[0] || null;
}

export function effectiveFacility(facility, settings) {
  if (!hasSettings(settings)) return facility || null;
  const base = facility || { facilityId: "eye_facility", displayName: "", status: "active", address: {} };
  const address = { ...(base.address || {}) };
  const merged = { ...base };
  if (settings.name) {
    merged.displayName = settings.name;
    merged.legalName = settings.name;
  }
  if (settings.address) {
    // 住所は 1 行で入れるので、都道府県・市区町村に分けた基本の値は使わない（二重に印字しない）
    Object.assign(address, { prefecture: "", city: "", line1: settings.address, line2: "", street: "" });
    merged.prefecture = "";
  }
  if (settings.postalCode) address.postalCode = settings.postalCode;
  merged.address = address;
  for (const field of ["phone", "fax", "email", "founder", "administrator", "medicalInstitutionCode", "nameKana", "representative", "representativeKana", "prescriptionRoute", "invoiceRegistrationNumber"]) {
    if (settings[field]) merged[field] = settings[field];
  }
  return merged;
}

// 一覧（bootstrap の facilities）: 使う施設だけを重ねた値に置き換える。施設が無ければ入力から 1 件作る。
export function facilitiesWithSettings(facilities = [], settings) {
  if (!hasSettings(settings)) return facilities;
  const chosen = pickFacility(facilities);
  if (!chosen) return [effectiveFacility(null, settings)];
  return facilities.map((item) => (item === chosen ? effectiveFacility(item, settings) : item));
}

export function facilitySettingsView(settings) {
  const values = Object.fromEntries(Object.keys(FACILITY_SETTINGS_FIELDS).map((field) => [field, settings?.[field] || ""]));
  return { ...values, revision: settings?.revision || 0, updatedAt: settings?.updatedAt || "", updatedBy: settings?.updatedBy || null };
}

function hasSettings(settings) {
  return Boolean(settings) && Object.keys(FACILITY_SETTINGS_FIELDS).some((field) => settings[field]);
}

function formatPostalCode(value) {
  const digits = value.normalize("NFKC").replace(/\D/gu, "");
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
