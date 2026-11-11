// 基準値（バイタル・眼科の検査）。カルテ左の「バイタル」「検査」の表の色分けとグラフの破線に使う。
// 医院ごとに設定で変えられる（clinic-config の referenceRanges）。保存が無い項目は既定の値を使う。
// どれも「目安」で、診断の基準ではない。low / high のどちらかが null ならその側の線は引かない。
// 既定の値の根拠は docs/eye-ux/rep2-approval-20261111.md にまとめた。

// limits は設定で入れられる範囲（入力の誤りを止めるため）。
export const VITAL_RANGE_ITEMS = Object.freeze([
  { key: "systolic", label: "血圧（上）", unit: "mmHg", limits: [40, 300] },
  { key: "diastolic", label: "血圧（下）", unit: "mmHg", limits: [20, 200] },
  { key: "pulse", label: "脈拍", unit: "回/分", limits: [20, 250] },
  { key: "temperature", label: "体温", unit: "℃", limits: [30, 45] },
  { key: "spo2", label: "SpO2", unit: "%", limits: [50, 100] },
  { key: "glucose", label: "血糖", unit: "mg/dL", limits: [20, 800] },
  { key: "height", label: "身長", unit: "cm", limits: [30, 250] },
  { key: "weight", label: "体重", unit: "kg", limits: [1, 300] },
  { key: "bmi", label: "BMI", unit: "", limits: [10, 60] }
]);

export const EXAM_RANGE_ITEMS = Object.freeze([
  { key: "vau", label: "裸眼視力", unit: "小数", limits: [0, 2.5] },
  { key: "vac", label: "矯正視力", unit: "小数", limits: [0, 2.5] },
  { key: "near", label: "近見視力", unit: "小数", limits: [0, 2.5] },
  { key: "iop", label: "眼圧", unit: "mmHg", limits: [0, 80] },
  { key: "s", label: "屈折 S（球面）", unit: "D", limits: [-40, 40] },
  { key: "c", label: "屈折 C（円柱）", unit: "D", limits: [-20, 20] },
  { key: "k1", label: "角膜曲率 K1", unit: "D", limits: [30, 70] },
  { key: "k2", label: "角膜曲率 K2", unit: "D", limits: [30, 70] },
  { key: "pupil", label: "瞳孔径", unit: "mm", limits: [0.5, 12] },
  { key: "cd", label: "C/D 比", unit: "", limits: [0, 1] }
]);

const range = (low, high) => Object.freeze({ low, high });

export const DEFAULT_REFERENCE_RANGES = Object.freeze({
  // 成人の一般的な目安（これまでカルテ左に固定で入れていた値と同じ）
  vitals: Object.freeze({
    systolic: range(90, 139),
    diastolic: range(null, 89),
    pulse: range(60, 100),
    temperature: range(35.5, 37.4),
    spo2: range(96, null),
    glucose: range(70, 139),
    height: range(null, null),
    weight: range(null, null),
    bmi: range(18.5, 24.9)
  }),
  exam: Object.freeze({
    vau: range(null, null), // 裸眼は近視の人がほぼ外れるので既定では付けない（医院で設定できる）
    vac: range(1.0, null),
    near: range(0.7, null),
    iop: range(10, 21),
    s: range(-0.5, 0.5),
    c: range(-1.0, 1.0),
    k1: range(41, 47),
    k2: range(41, 47),
    pupil: range(2, 5),
    cd: range(null, 0.6)
  })
});

// 保存した値（一部だけでもよい）に既定の値を重ねて、全項目そろった形にする。
export function resolveReferenceRanges(stored = null) {
  const result = {};
  for (const [group, items] of [["vitals", VITAL_RANGE_ITEMS], ["exam", EXAM_RANGE_ITEMS]]) {
    const saved = stored && typeof stored[group] === "object" && stored[group] ? stored[group] : {};
    result[group] = Object.fromEntries(items.map((item) => {
      const value = saved[item.key];
      const fallback = DEFAULT_REFERENCE_RANGES[group][item.key];
      if (!value || typeof value !== "object") return [item.key, { low: fallback.low, high: fallback.high }];
      return [item.key, { low: finiteOrNull(value.low), high: finiteOrNull(value.high) }];
    }));
  }
  return result;
}

// 設定の保存の検証。数値か null（空欄）だけ。下限は上限以下。入れられる範囲の外は止める。
export function validateReferenceRanges(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("value must be an object", "value");
  const result = {};
  for (const [group, items] of [["vitals", VITAL_RANGE_ITEMS], ["exam", EXAM_RANGE_ITEMS]]) {
    const input = value[group] === undefined ? {} : value[group];
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${group} must be an object`, group);
    result[group] = {};
    for (const item of items) {
      const field = `${group}.${item.key}`;
      const entry = input[item.key];
      if (entry === undefined) {
        const fallback = DEFAULT_REFERENCE_RANGES[group][item.key];
        result[group][item.key] = { low: fallback.low, high: fallback.high };
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(`${field} must be an object`, field);
      const low = boundOf(entry.low, `${field}.low`, item);
      const high = boundOf(entry.high, `${field}.high`, item);
      if (low !== null && high !== null && low > high) throw invalid(`${item.label}の下限は上限以下にしてください。`, `${field}.low`);
      result[group][item.key] = { low, high };
    }
  }
  return result;
}

// 値が基準値の外か（"high" / "low" / ""）。
export function referenceLevel(value, ref) {
  if (!ref || !Number.isFinite(value)) return "";
  if (Number.isFinite(ref.high) && value > ref.high) return "high";
  if (Number.isFinite(ref.low) && value < ref.low) return "low";
  return "";
}

function boundOf(value, field, item) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) throw invalid(`${item.label}は数字で入れてください。`, field);
  const [min, max] = item.limits;
  if (number < min || number > max) throw invalid(`${item.label}は ${min}〜${max} の範囲で入れてください。`, field);
  return Math.round(number * 100) / 100;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function invalid(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
