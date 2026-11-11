import { COMMENT_KIND, EYE_SET_ROLES, EYE_WRITE_ROLES, validateOrderSetInput } from "../../../packages/eye-contracts/src/index.js";

// 定期（デジカルの「定期登録」にあたる）: 患者ごとのセット。決まった処方・検査を、次回・毎回・Nか月ごとにカルテの右下へ出す。
// 保存先はセットと同じ（orderSets）。patientId を持つものが定期で、セットの一覧（bootstrap・/order-sets）には出さない。

export const REGULAR_REPEATS = Object.freeze(["next", "every", "months"]);
export const REGULAR_REPEAT_LABELS = Object.freeze({ next: "次回", every: "毎回", months: "か月ごと" });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_NAME = 200;

export function isRegularOrder(item) {
  return Boolean(item && item.patientId);
}

// セットの一覧から定期を除く（セットの木・設定画面に患者ごとのものを混ぜない）。
export function withoutRegularOrders(list = []) {
  return list.filter((item) => !isRegularOrder(item));
}

function fail(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function text(value, field, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw fail(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(`${field} must be ${max} characters or fewer`, field);
  return trimmed;
}

function date(value, field) {
  const result = text(value, field, 10);
  if (result && !DATE_PATTERN.test(result)) throw fail(`${field} must be YYYY-MM-DD`, field);
  return result;
}

// 繰り返し: next（次回だけ）・every（毎回）・months（N か月ごと。1〜24）。
export function validateRegularRepeat(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.repeat !== undefined) {
    const repeat = input.repeat === undefined || input.repeat === "" ? "next" : input.repeat;
    if (!REGULAR_REPEATS.includes(repeat)) throw fail(`repeat must be one of: ${REGULAR_REPEATS.join(", ")}`, "repeat");
    out.repeat = repeat;
  }
  if (out.repeat === "months" || (partial && input.repeatMonths !== undefined)) {
    const months = Number(input.repeatMonths);
    if (!Number.isInteger(months) || months < 1 || months > 24) throw fail("repeatMonths must be 1-24", "repeatMonths");
    out.repeatMonths = months;
  } else if (out.repeat) {
    out.repeatMonths = null;
  }
  return out;
}

export function validateRegularCreateInput(input = {}) {
  const encounterId = text(input.encounterId, "encounterId", 120);
  if (!encounterId) throw fail("encounterId is required", "encounterId");
  const name = text(input.name, "name", MAX_NAME);
  if (!name) throw fail("name is required", "name");
  return { encounterId, name, ...validateRegularRepeat(input) };
}

export function validateRegularUpdateInput(input = {}) {
  const out = { ...validateRegularRepeat(input, { partial: true }) };
  if (input.name !== undefined) {
    out.name = text(input.name, "name", MAX_NAME);
    if (!out.name) throw fail("name is required", "name");
  }
  if (input.active !== undefined) out.active = Boolean(input.active);
  if (input.appliedDate !== undefined) {
    out.appliedDate = date(input.appliedDate, "appliedDate");
    if (!out.appliedDate) throw fail("appliedDate is required", "appliedDate");
  }
  if (out.repeat === "months" && out.repeatMonths === undefined) throw fail("repeatMonths must be 1-24", "repeatMonths");
  return out;
}

function addMonths(iso, months) {
  const [year, month, day] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

// その日のカルテで「今回の対象」か。登録した日（registeredDate）の当日は出さない。
export function regularOrderDue(item, encounterDate) {
  if (!item || item.active === false || !encounterDate) return false;
  const registered = item.registeredDate || "";
  if (registered && encounterDate <= registered) return false;
  const applied = item.lastAppliedDate || "";
  if (applied === encounterDate) return false;
  if (item.repeat === "every") return true;
  if (item.repeat === "months") return encounterDate >= addMonths(applied > registered ? applied : registered || encounterDate, item.repeatMonths || 1);
  return !(applied && applied > registered);
}

export function regularOrderView(item, encounterDate = "") {
  return {
    setId: item.setId,
    patientId: item.patientId,
    name: item.name,
    repeat: item.repeat || "next",
    repeatMonths: item.repeatMonths ?? null,
    registeredDate: item.registeredDate || "",
    lastAppliedDate: item.lastAppliedDate || "",
    sourceEncounterId: item.sourceEncounterId || "",
    prescriptions: item.prescriptions || [],
    orders: item.orders || [],
    active: item.active !== false,
    due: regularOrderDue(item, encounterDate),
    updatedAt: item.updatedAt || ""
  };
}

// カルテの処方・オーダーを定期の中身にする（オーダーは予定、引き継ぎの印は外す）。
function regularContentFromEncounter(content = {}) {
  return {
    prescriptions: (content.prescriptions || []).filter((row) => row.kind === COMMENT_KIND || String(row.name || "").trim()).map(({ carriedOver, ...row }) => row),
    orders: (content.orders || []).filter((row) => row.kind === COMMENT_KIND || row.status !== "cancelled").map(({ status, statusChangedAt, statusChangedBy, sourceEncounterId, ...row }) => row)
  };
}

// ルート: GET/POST /v1/eye/patients/:patientId/regular-orders、PATCH /v1/eye/regular-orders/:setId。
// 当たらなければ null を返す（server.js の次のルートへ）。
export async function handleRegularOrderRoute({ method, parts, url, input, context, eyeStore, platformStore, orgId, actor, audit, helpers }) {
  const { requireAccess, requireCsrf, requirePatient, requireEncounter, ok, created, notFound } = helpers;
  const patientRoute = parts.length === 5 && parts[0] === "v1" && parts[1] === "eye" && parts[2] === "patients" && parts[4] === "regular-orders";
  if (patientRoute && method === "GET") {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    const date = String(url.searchParams.get("date") || "");
    if (date && !DATE_PATTERN.test(date)) throw fail("date must be YYYY-MM-DD", "date");
    const items = (await eyeStore.listOrderSets(orgId)).filter((item) => item.patientId === patient.patientId && item.active !== false);
    items.sort((left, right) => String(right.registeredDate || "").localeCompare(String(left.registeredDate || "")) || String(left.name).localeCompare(String(right.name), "ja"));
    return ok({ patientId: patient.patientId, regularOrders: items.map((item) => regularOrderView(item, date)) });
  }
  if (patientRoute && method === "POST") {
    requireAccess(context, EYE_SET_ROLES, "Regular orders are registered by a doctor or administrator");
    requireCsrf(input.headers || {}, context.session);
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    const validated = validateRegularCreateInput(input.body || {});
    const encounter = await requireEncounter(eyeStore, orgId, validated.encounterId);
    if (encounter.patientId !== patient.patientId) throw fail("the encounter belongs to another patient", "encounterId");
    const contents = regularContentFromEncounter(encounter.content || {});
    if (!contents.prescriptions.some((row) => row.kind !== COMMENT_KIND) && !contents.orders.some((row) => row.kind !== COMMENT_KIND)) {
      throw fail("処方か検査・処置を入れてから定期にしてください。", "encounterId");
    }
    const base = validateOrderSetInput({ name: validated.name, ...contents });
    const setId = helpers.createId("ereg");
    const saved = await eyeStore.upsertOrderSet(orgId, {
      ...base,
      setId,
      patientId: patient.patientId,
      kind: "regular",
      repeat: validated.repeat,
      repeatMonths: validated.repeatMonths ?? null,
      registeredDate: encounter.encounterDate,
      lastAppliedDate: "",
      sourceEncounterId: encounter.encounterId,
      createdBy: actor
    });
    await audit({ eventType: "eye.regular_order_saved", targetType: "order_set", targetId: setId, patientId: patient.patientId, safePayload: { repeat: validated.repeat, fromEncounterId: encounter.encounterId } });
    return created({ regularOrder: regularOrderView(saved, encounter.encounterDate) });
  }
  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "eye" && parts[2] === "regular-orders" && method === "PATCH") {
    const validated = validateRegularUpdateInput(input.body || {});
    const onlyApplied = Object.keys(validated).every((key) => key === "appliedDate");
    // 「今回入れた」の記録はカルテを書く人なら付けられる。名前・繰り返し・削除は医師と管理者。
    requireAccess(context, onlyApplied ? EYE_WRITE_ROLES : EYE_SET_ROLES, "Regular orders are changed by a doctor or administrator");
    requireCsrf(input.headers || {}, context.session);
    const current = (await eyeStore.listOrderSets(orgId)).find((item) => item.setId === parts[3] && isRegularOrder(item));
    if (!current) throw notFound("regular order not found");
    const { appliedDate, ...rest } = validated;
    const patch = { ...rest, setId: current.setId, ...(appliedDate ? { lastAppliedDate: appliedDate } : {}) };
    if (patch.repeat && patch.repeat !== "months") patch.repeatMonths = null;
    const saved = await eyeStore.upsertOrderSet(orgId, patch);
    await audit({
      eventType: validated.active === false ? "eye.regular_order_deleted" : "eye.regular_order_saved",
      targetType: "order_set",
      targetId: current.setId,
      patientId: current.patientId,
      safePayload: { applied: Boolean(appliedDate) }
    });
    return ok({ regularOrder: regularOrderView(saved, appliedDate || "") });
  }
  return null;
}
