import {
  DEFAULT_ORDER_CATALOG,
  EXAM_FIELD_PATHS,
  EYE_SIDES,
  NEXT_VISIT_PLAN_PRESETS,
  PLAN_ITEM_EYES,
  validateEncounterContent,
  validateExamRecordValues,
  validatePlanItems
} from "../../eye-contracts/src/index.js";

// 検査記録（content.examRecords[]）と、そこから作る「最新値」（content.exam）の対応。
//
// 決まり
// - 記録は時刻（at）の順に並べ、同じ時刻は配列の順。exam の各項目は「その項目を持つ最後の記録の値」。
// - 記録の cleared に載った項目は、その記録の時点で空にする（カルテ画面で消した値。前の記録の値は消さない）。
// - exam に載らない値（近見の矯正・S/C/A、RG、IOL/CL、B 行、眼圧の各回、屈折の機器、機器の値、コメント）は記録にだけある。
//
// 項目の対応（記録の値 → exam）
//   vision.far.{od,os}.uncorrected     → {od,os}.vaUncorrected
//   vision.far.{od,os}.corrected       → {od,os}.vaCorrected
//   vision.far.{od,os}.correctionType  → {od,os}.vaCorrectionType
//   vision.far.{od,os}.sphere/cylinder/axis → {od,os}.correction
//   vision.near.{od,os}.uncorrected    → {od,os}.vaNear
//   refraction.{od,os}                 → {od,os}.refraction
//   iop.{od,os}.average / method / at  → {od,os}.iop / iopMethod / measuredAt
//   pupil.{od,os} / keratometry.{od,os} → {od,os}.pupil / keratometry
//   binocular.*                        → binocular.*

export function sortExamRecords(records = []) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => String(left.record.at).localeCompare(String(right.record.at)) || left.index - right.index)
    .map((item) => item.record);
}

// いまの記録（その日の最後の記録）。カルテ画面での直接編集はこの記録に書き込む。
export function currentExamRecord(records = []) {
  return sortExamRecords(records).at(-1) || null;
}

export function hasExamRecords(content = {}) {
  return Array.isArray(content?.examRecords) && content.examRecords.length > 0;
}

// 記録 1 件の値を exam の項目へ写したもの（値のある項目だけ）。
export function projectExamRecord(values = {}) {
  const out = {};
  const put = (path, value) => {
    if (isPresent(value)) out[path] = clone(value);
  };
  for (const side of EYE_SIDES) {
    const far = values.vision?.far?.[side] || {};
    const iop = values.iop?.[side] || {};
    put(`${side}.vaUncorrected`, far.uncorrected);
    put(`${side}.vaCorrected`, far.corrected);
    put(`${side}.vaCorrectionType`, far.correctionType);
    put(`${side}.correction`, scaOf(far));
    put(`${side}.refraction`, scaOf(values.refraction?.[side]));
    put(`${side}.iop`, iop.average);
    put(`${side}.iopMethod`, iop.method);
    put(`${side}.measuredAt`, iop.at);
    put(`${side}.vaNear`, values.vision?.near?.[side]?.uncorrected);
    put(`${side}.pupil`, values.pupil?.[side]);
    put(`${side}.keratometry`, values.keratometry?.[side]);
  }
  for (const key of ["rapd", "alignment", "alignmentNote", "motility", "motilityNote"]) {
    put(`binocular.${key}`, values.binocular?.[key]);
  }
  return out;
}

// 記録から exam（最新値）を作る。記録がなければ空の exam。
export function deriveExamFromRecords(records = []) {
  const exam = { od: {}, os: {}, binocular: {} };
  for (const record of sortExamRecords(records)) {
    for (const [path, value] of Object.entries(projectExamRecord(record.values))) setPath(exam, path, value);
    for (const path of record.cleared || []) setPath(exam, path, undefined);
  }
  return validateEncounterContent({ exam }).exam;
}

// 記録のないカルテ（古いカルテ）の exam を、最初の記録 1 件にする。値がなければ null。
export function seedExamRecordFromExam(exam = {}, { recordId, at, actor = null, now = "" } = {}) {
  let values = {};
  for (const path of EXAM_FIELD_PATHS) {
    const value = getPath(exam, path);
    if (isPresent(value)) values = writeExamPath(values, path, value);
  }
  values = validateExamRecordValues(values);
  if (!Object.keys(values).length) return null;
  return compact({
    recordId,
    at,
    source: "chart",
    examinerMemberId: "",
    examinerName: "",
    values,
    note: "記録の導入前に入力された検査値",
    recordedBy: actorRef(actor),
    recordedAt: now
  });
}

// カルテ画面（exam を直接編集する今の画面）からの保存を記録へ写す。
// - 変わった項目だけを、いまの記録（最後の記録）に書く。他の記録・記録だけにある値には触れない。
// - 空にした項目は、いまの記録の値を消し、前の記録の値がまだ最新値に出るなら cleared に載せる。
// - 眼圧の値を書き換えたときは、いまの記録のその眼の測定を「入力した 1 回」に置き換える。
// 戻り値の記録から作る exam は、送られてきた exam（検証後）と同じになる。
export function applyChartExamEdit(records = [], submittedExam = {}, { actor = null, now = "" } = {}) {
  const target = currentExamRecord(records);
  if (!target) return { records, changedPaths: [] };
  const submitted = validateEncounterContent({ exam: submittedExam }).exam;
  const derived = deriveExamFromRecords(records);
  const changedPaths = EXAM_FIELD_PATHS.filter((path) => !sameValue(getPath(submitted, path), getPath(derived, path)));
  if (!changedPaths.length) return { records, changedPaths };

  let values = clone(target.values || {});
  let cleared = (target.cleared || []).filter((path) => !changedPaths.includes(path));
  for (const path of changedPaths) values = writeExamPath(values, path, getPath(submitted, path));
  values = validateExamRecordValues(values);
  const build = () => records.map((record) => (record === target ? compact({
    ...record,
    values,
    cleared,
    updatedBy: actorRef(actor),
    updatedAt: now
  }) : record));
  let next = build();
  const after = deriveExamFromRecords(next);
  const stillShown = changedPaths.filter((path) => !isPresent(getPath(submitted, path)) && isPresent(getPath(after, path)));
  if (stillShown.length) {
    cleared = [...cleared, ...stillShown];
    next = build();
  }
  return { records: next, changedPaths };
}

// exam の項目 1 つを記録の値に書く（値が空なら消す）。戻り値は新しい値（検証前）。
export function writeExamPath(values = {}, path, value) {
  const next = clone(values);
  const [head, key] = path.split(".");
  const present = isPresent(value);
  const ensure = (object, name) => {
    if (!object[name] || typeof object[name] !== "object") object[name] = {};
    return object[name];
  };
  if (head === "binocular") {
    const binocular = ensure(next, "binocular");
    if (present) binocular[key] = value; else delete binocular[key];
    return next;
  }
  const side = head;
  const row = (distance) => ensure(ensure(ensure(next, "vision"), distance), side);
  const iopEye = () => ensure(ensure(next, "iop"), side);
  switch (key) {
    case "vaUncorrected": assign(row("far"), "uncorrected", value); break;
    case "vaCorrected": assign(row("far"), "corrected", value); break;
    case "vaCorrectionType": assign(row("far"), "correctionType", value); break;
    case "correction": {
      const target = row("far");
      for (const part of ["sphere", "cylinder", "axis"]) assign(target, part, value?.[part]);
      break;
    }
    case "refraction": assign(ensure(next, "refraction"), side, present ? scaOf(value) : null); break;
    case "iop": {
      const eye = iopEye();
      if (present) eye.readings = [{ value }]; else delete eye.readings;
      delete eye.average;
      break;
    }
    case "iopMethod": assign(iopEye(), "method", value); break;
    case "measuredAt": assign(iopEye(), "at", value); break;
    case "vaNear": assign(row("near"), "uncorrected", value); break;
    case "pupil": assign(ensure(next, "pupil"), side, present ? value : null); break;
    case "keratometry": assign(ensure(next, "keratometry"), side, present ? value : null); break;
    default: throw new Error(`unknown exam path: ${path}`);
  }
  return next;
}

// ---- 経過（トレンド）用 ----

// 記録のあるカルテから、眼ごとの近見視力（最後に入った裸眼・矯正）と最後の眼圧の測定（各回と平均）を取り出す。
export function examRecordHighlights(records = []) {
  const result = Object.fromEntries(EYE_SIDES.map((side) => [side, { nearUncorrected: "", nearCorrected: "", iopReadings: [], iopAverage: null }]));
  for (const record of sortExamRecords(records)) {
    for (const side of EYE_SIDES) {
      const near = record.values?.vision?.near?.[side] || {};
      if (near.uncorrected) result[side].nearUncorrected = near.uncorrected;
      if (near.corrected) result[side].nearCorrected = near.corrected;
      const iop = record.values?.iop?.[side];
      if (iop?.readings?.length) {
        result[side].iopReadings = iop.readings.map((item) => item.value);
        result[side].iopAverage = Number.isFinite(iop.average) ? iop.average : null;
      }
    }
  }
  return result;
}

// ---- 次回の診療予定（項目 × 部位） ----

// 全行の部位を一括で変える（トプコンの「全て右 / 全て左 / 全て両 / 全てなし」）。
export function setPlanItemsEye(items = [], eye) {
  if (!PLAN_ITEM_EYES.includes(eye)) throw new Error(`unknown plan eye: ${eye}`);
  return items.map((item) => ({ ...item, eye }));
}

// 項目を足す。同じ項目（code、なければ名前）と同じ部位の行は重ねない。
export function mergePlanItems(items = [], additions = []) {
  const seen = new Set(items.map(planItemKey));
  const merged = [...items];
  for (const item of validatePlanItems(additions)) {
    const key = planItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// プリセット（視・圧 など）から予定の行を作る。部位は全行同じ（既定は両眼）。
export function planItemsFromPreset(presetId, { eye = "ou", catalog = DEFAULT_ORDER_CATALOG } = {}) {
  const preset = NEXT_VISIT_PLAN_PRESETS.find((item) => item.presetId === presetId);
  if (!preset) throw new Error(`unknown plan preset: ${presetId}`);
  const byCode = new Map(catalog.map((item) => [item.code, item]));
  return preset.codes.map((code) => ({
    code,
    name: byCode.get(code)?.name || code,
    eye: byCode.get(code)?.requiresEye === false ? "none" : eye
  }));
}

// 前回立てた予定を、今回のカルテのオーダー（予定）にする。すでに同じ項目・同じ眼のオーダーがあれば作らない。
export function plannedOrdersFromPlan(planItems = [], existingOrders = [], { sourceEncounterId = "", createOrderId, catalog = DEFAULT_ORDER_CATALOG } = {}) {
  const byCode = new Map(catalog.map((item) => [item.code, item]));
  const seen = new Set(existingOrders.map((order) => orderKey(order.code || order.name, order.eye || "")));
  const orders = [];
  for (const item of planItems) {
    const eye = item.eye === "none" ? "" : item.eye || "";
    const key = orderKey(item.code || item.name, eye);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = item.code ? byCode.get(item.code) : null;
    orders.push(compact({
      orderId: createOrderId(),
      code: item.code || "",
      name: item.name || entry?.name || item.code,
      kind: entry?.kind || "exam",
      eye,
      status: "planned",
      note: item.comment || "",
      statusChangedAt: "",
      statusChangedBy: null,
      sourceEncounterId
    }, { keep: ["code", "eye", "note", "statusChangedAt", "statusChangedBy"] }));
  }
  return orders;
}

function planItemKey(item) {
  return `${item.code || item.name}|${item.eye || "none"}`;
}

function orderKey(codeOrName, eye) {
  return `${codeOrName}|${eye}`;
}

// ---- 小道具 ----

function scaOf(value) {
  if (!value || typeof value !== "object") return null;
  return { sphere: value.sphere ?? null, cylinder: value.cylinder ?? null, axis: value.axis ?? null };
}

function assign(object, key, value) {
  if (isPresent(value)) object[key] = value; else delete object[key];
}

export function isPresent(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(isPresent);
  return true;
}

function sameValue(left, right) {
  return stable(isPresent(left) ? left : null) === stable(isPresent(right) ? right : null);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => isPresent(value[key])).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function getPath(object, path) {
  return path.split(".").reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  let current = object;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  if (value === undefined) delete current[keys.at(-1)];
  else current[keys.at(-1)] = value;
}

function actorRef(actor) {
  if (!actor) return {};
  return compact({ memberId: actor.memberId || "", loginId: actor.loginId || "", displayName: actor.displayName || "" });
}

function compact(object, { keep = [] } = {}) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => keep.includes(key) || isPresent(value)));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
