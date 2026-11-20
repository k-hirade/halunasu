// 検査記録（content.examRecords[]）を画面で扱うための小道具。描画から切り離してテストする。
import { ALIGNMENT_LABELS, MOTILITY_LABELS, RAPD_LABELS } from "@halunasu/eye-contracts";

export const ALIGNMENT_OPTIONS = Object.entries(ALIGNMENT_LABELS);
export const MOTILITY_OPTIONS = Object.entries(MOTILITY_LABELS);
export const RAPD_OPTIONS = Object.entries(RAPD_LABELS);

const JST_MS = 9 * 3600000;

export function getPath(object, path) {
  return path.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

export function emptyIfBlank(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

export function hasAnyValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasAnyValue);
  if (typeof value === "object") return Object.values(value).some(hasAnyValue);
  return true;
}

// 記録の値のうち、片眼（od / os）に関わる部分。PD は両眼の値なので左右どちらにも入れる。
export function eyeRecordValues(values = {}, side) {
  return {
    far: values.vision?.far?.[side],
    near: values.vision?.near?.[side],
    refraction: values.refraction?.[side],
    keratometry: values.keratometry?.[side],
    iop: values.iop?.[side]?.readings,
    pupil: values.pupil?.[side],
    pd: values.pd
  };
}

export function recordHasEyeValues(values, side) {
  return hasAnyValue(eyeRecordValues(values, side));
}

// カルテの検査値（content.exam の片眼）に値があるか。近見視力・角膜曲率・瞳孔も数える。
export function hasExamValues(values = {}) {
  return Boolean(values.vaUncorrected || values.vaCorrected || values.vaNear || Number.isFinite(values.iop)
    || [values.correction, values.refraction, values.keratometry, values.pupil].some(hasAnyValue));
}

// 検査終了・確認の対象になる眼（カルテの検査値か、登録済みの記録に値のある眼）
export function eyesWithValues(content = {}) {
  return ["od", "os"].filter((side) => hasExamValues(content.exam?.[side] || {})
    || (content.examRecords || []).some((record) => recordHasEyeValues(record.values, side)));
}

// 記録の時刻（ISO）→ 日本時間の「HH:MM」
export function recordClock(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time + JST_MS).toISOString().slice(11, 16);
}

// 日本時間の現在時刻「HH:MM」
export function nowClock(now = Date.now()) {
  return new Date(now + JST_MS).toISOString().slice(11, 16);
}

// 診療日（YYYY-MM-DD）と日本時間の「HH:MM」→ ISO。読めなければ空文字。
export function isoFromClock(date, clock) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(clock || "")) return "";
  return new Date(`${date}T${clock}:00+09:00`).toISOString();
}

// 時刻の順（同じ時刻は保存の順）。
export function sortRecords(records = []) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => String(left.record.at).localeCompare(String(right.record.at)) || left.index - right.index)
    .map((item) => item.record);
}

// 記録の見出し（時刻・検者）
export function recordLabel(record) {
  return [recordClock(record.at), record.examinerName || record.recordedBy?.displayName || ""].filter(Boolean).join(" ");
}

// 機器の値（参照パネル用）を種類ごとに集める。古い → 新しい。
export function collectDeviceReadings(records = []) {
  const result = { kerato: [], autoref: [], tonometer: [] };
  for (const record of sortRecords(records)) {
    for (const kind of Object.keys(result)) {
      const data = record.values?.devices?.[kind];
      if (hasAnyValue(data)) result[kind].push({ recordId: record.recordId, time: recordClock(data.measuredAt || record.at), data });
    }
  }
  return result;
}

// 2 つの値が同じか（空の項目は無いものとして比べる）
export function sameValues(left, right) {
  return stable(left) === stable(right);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => hasAnyValue(value[key])).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(hasAnyValue(value) ? value : null);
}

// 機器の値をいまの記録へ写す（空でない値だけ。上書きする）。
export function copyDeviceValues(values, kind, data = {}) {
  let next = values;
  for (const side of ["od", "os"]) {
    const eye = data[side] || {};
    if (kind === "kerato") {
      for (const key of ["k1", "k2", "axis"]) if (Number.isFinite(eye[key])) next = writeValue(next, ["keratometry", side, key], eye[key]);
    } else if (kind === "autoref") {
      const representative = eye.representative || eye.readings?.at(-1) || {};
      for (const key of ["sphere", "cylinder", "axis"]) if (Number.isFinite(representative[key])) next = writeValue(next, ["vision", "far", side, key], representative[key]);
    } else if (eye.readings?.length) {
      next = writeValue(next, ["iop", side, "readings"], eye.readings.slice(0, 3).map((reading) => ({ value: reading.value })));
      if (data.method) next = writeValue(next, ["iop", side, "method"], data.method);
    }
  }
  if (kind === "autoref" && Number.isFinite(data.pd)) next = writeValue(next, ["pd", "far"], data.pd);
  return next;
}

// 値を書く。空（"" / null / undefined / 空の配列）なら消し、空になった親も消す。
export function writeValue(values, path, value) {
  if (!path.length) return value ?? {};
  const [head, ...rest] = path;
  const current = values && typeof values === "object" ? values : {};
  const child = rest.length ? writeValue(current[head], rest, value) : emptyIfBlank(value);
  const next = { ...current };
  if (child === undefined || (child && typeof child === "object" && !Array.isArray(child) && !Object.keys(child).length)) delete next[head];
  else next[head] = child;
  return next;
}
