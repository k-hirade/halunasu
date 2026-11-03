// 経過グラフの軸と日付ラベルの計算（描画から切り離してテストする）。
const VA_STEPS = [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];
const VA_LABEL_TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0];
const VA_MAX = 2.0;
export const MIN_LABEL_GAP = 48;

// 視力: データの最小値より 1 段下の目盛りから 2.0 まで（対数）。点が 1 つでも幅は 1 段以上ある。
export function vaAxis(values, band) {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);
  const minValue = Math.min(VA_MAX, Math.max(0.01, finite.length ? Math.min(...finite) : 0.1));
  const below = VA_STEPS.filter((step) => step < minValue - 1e-9);
  const lower = below.length ? below.at(-1) : 0.01;
  const upper = VA_MAX;
  const min = Math.log10(lower);
  const max = Math.log10(upper);
  const y = (value) => {
    const clamped = Math.max(lower, Math.min(upper, value));
    return band.bottom - ((Math.log10(clamped) - min) / (max - min)) * (band.bottom - band.top);
  };
  // 下端と上端（2.0）は必ず出し、間の目盛りは 14px 未満に詰まるものを省く
  const ticks = [lower];
  for (const tick of VA_LABEL_TICKS.filter((value) => value > lower && value < upper)) {
    if (Math.abs(y(ticks.at(-1)) - y(tick)) >= 14 && Math.abs(y(tick) - y(upper)) >= 14) ticks.push(tick);
  }
  ticks.push(upper);
  return { y, ticks, lower, upper };
}

// 眼圧: max(0, 最小−5) 〜 max(25, 最大+5)。幅は 10mmHg 以上を保つ。
export function iopAxis(values, band) {
  const finite = values.filter((value) => Number.isFinite(value));
  const minValue = finite.length ? Math.min(...finite) : 15;
  const maxValue = finite.length ? Math.max(...finite) : 15;
  let lower = Math.max(0, minValue - 5);
  let upper = Math.max(25, maxValue + 5);
  if (upper - lower < 10) lower = Math.max(0, upper - 10);
  const step = upper - lower > 30 ? 10 : 5;
  lower = Math.floor(lower / step) * step;
  upper = Math.ceil(upper / step) * step;
  const y = (value) => band.bottom - ((Math.max(lower, Math.min(upper, value)) - lower) / (upper - lower)) * (band.bottom - band.top);
  const ticks = [];
  for (let tick = lower; tick <= upper; tick += step) ticks.push(tick);
  return { y, ticks, lower, upper };
}

// 日付ラベルは、前のラベルから gap 以上離れたものだけを出す。最新（最後）は必ず残す。
export function thinLabels(items, gap = MIN_LABEL_GAP) {
  if (items.length <= 1) return items;
  const kept = [items[0]];
  for (const item of items.slice(1, -1)) {
    if (item.x - kept.at(-1).x >= gap) kept.push(item);
  }
  const last = items.at(-1);
  while (kept.length && last.x - kept.at(-1).x < gap) kept.pop();
  kept.push(last);
  return kept;
}
