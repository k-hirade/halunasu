// 術前検査ビューワー（トプコンの「術前検査ビューワー」に倣う）の値をそろえる小道具。描画から切り離してテストする。
// 眼ごとに、いちばん新しい値（今日のカルテ → 前回の確定カルテの順）を拾う:
//   視力・他覚屈折・角膜曲率（K1/K2/軸、平均K・角膜乱視）・眼圧、
//   IOL の記録（予定があれば予定、なければ最新）の 眼軸長・前房深度・A定数・目標屈折・度数。
// 計算（度数の算出）はしない。

const SIDES = ["od", "os"];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// 角膜屈折力（D）→ 曲率半径（mm）。ケラトメーターの換算（屈折率 1.3375）。
export function radiusFromPower(power) {
  return isNumber(power) && power > 0 ? Math.round((337.5 / power) * 100) / 100 : null;
}

export function keratoSummary(kerato = {}) {
  const k1 = isNumber(kerato.k1) ? kerato.k1 : null;
  const k2 = isNumber(kerato.k2) ? kerato.k2 : null;
  if (k1 === null && k2 === null) return null;
  const average = k1 !== null && k2 !== null ? Math.round(((k1 + k2) / 2) * 100) / 100 : null;
  const cylinder = k1 !== null && k2 !== null ? Math.round(Math.abs(k2 - k1) * 100) / 100 : null;
  return { k1, k2, axis: isNumber(kerato.axis) ? kerato.axis : null, average, cylinder, r1: radiusFromPower(k1), r2: radiusFromPower(k2) };
}

function hasRefraction(value = {}) {
  return isNumber(value.sphere) || isNumber(value.cylinder);
}

// encounters: 新しい順（今日のカルテ、前回の確定カルテ…）。空や null は飛ばす。
export function preopSummary({ encounters = [], iolRecords = [] } = {}) {
  const sources = encounters.filter((item) => item?.content?.exam);
  const result = {};
  for (const side of SIDES) {
    const pick = (read) => {
      for (const encounter of sources) {
        const value = read(encounter.content.exam[side] || {}, encounter);
        if (value !== null && value !== undefined) return { value, date: encounter.encounterDate };
      }
      return null;
    };
    const iols = iolRecords.filter((item) => item.eye === side);
    const iol = iols.find((item) => item.status === "planned") || iols.find((item) => item.status === "implanted") || iols[0] || null;
    result[side] = {
      va: pick((exam) => (exam.vaUncorrected || exam.vaCorrected ? { uncorrected: exam.vaUncorrected || "", corrected: exam.vaCorrected || "", correction: exam.correction || {} } : null)),
      refraction: pick((exam) => (hasRefraction(exam.refraction) ? exam.refraction : null)),
      kerato: pick((exam) => keratoSummary(exam.keratometry)),
      iop: pick((exam) => (isNumber(exam.iop) ? exam.iop : null)),
      iol
    };
  }
  return result;
}

export function hasPreopValues(summary) {
  return SIDES.some((side) => {
    const eye = summary?.[side] || {};
    return Boolean(eye.va || eye.refraction || eye.kerato || eye.iop || eye.iol);
  });
}
