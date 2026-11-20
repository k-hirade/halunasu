// 検査値の数値入力の読み取り（画面部品から切り出して単体テストできるようにしたもの）。

// 入力値の正規化（全角数字・全角や長音のマイナス・全角の小数点を半角に）。
export function normalizeNumberText(text) {
  return String(text ?? "")
    .replace(/[０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[−ー－‐–—]/gu, "-")
    .replace(/＋/gu, "+")
    .replace(/[．。]/gu, ".")
    .trim();
}

// 文字列を数値に。空なら empty、入力途中（「-」「+」「.」「-1.」）は partial、数値として読めなければ invalid。
// 値の丸め・符号の反転はしない。
export function readNumber(text) {
  const value = normalizeNumberText(text);
  if (value === "") return { empty: true, value: null };
  if (/^[+-]?\.?$/u.test(value) || /^[+-]?\d*\.$/u.test(value)) return { partial: true, value: null };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/u.test(value)) return { invalid: true, value: null };
  const number = Number(value);
  return Number.isFinite(number) ? { value: number } : { invalid: true, value: null };
}

// 範囲・整数の条件を満たすか。
export function acceptNumber(parsed, { min, max, integer = false } = {}) {
  if (parsed.empty || parsed.partial || parsed.invalid) return false;
  return (min === undefined || parsed.value >= min)
    && (max === undefined || parsed.value <= max)
    && (!integer || Number.isInteger(parsed.value));
}

// 屈折値（S・C）の読み取り。小数点なしで 3 桁以上の数字は 1/100 D として読む（「-125」→ -1.25、「+075」→ +0.75、
// 「-1250」→ -12.50）。1〜2 桁（「-12」「-1」）はそのまま D。読み替えたときは converted を付ける。
export function readDiopter(text) {
  const match = normalizeNumberText(text).match(/^([+-]?)(\d{3,})$/u);
  if (match) return { value: Number(`${match[1]}${match[2]}`) / 100, converted: true };
  return readNumber(text);
}

// 入力の確認。ok なら保存してよい（value は空なら null）。message は画面に出す短い説明。
// final=false（入力の途中）は、続けて打てば直る誤り（正の下限未満・刻み・「-」「-1.」）を message なしで返す（赤くしない）。
// final=true（欄を離れるとき）は、どの誤りにも message を付ける。末尾の「.」は無いものとして読む。
export function checkNumber(text, { min, max, integer = false, step, read = readNumber, final = false } = {}) {
  const parsed = read(final ? normalizeNumberText(text).replace(/\.$/u, "") : text);
  if (parsed.empty) return { ok: true, value: null };
  if (parsed.partial) return { ok: false, message: final ? "数値で入力" : null };
  if (parsed.invalid) return { ok: false, message: "数値で入力" };
  const { value } = parsed;
  const range = `${min ?? ""}〜${max ?? ""}の範囲で入力`;
  // 上限超え・負の側の下限未満は、桁を足しても戻らないのですぐ知らせる
  if (max !== undefined && value > max) return { ok: false, message: range };
  if (min !== undefined && value < min) return { ok: false, message: final || min <= 0 ? range : null };
  if (integer && !Number.isInteger(value)) return { ok: false, message: "整数で入力" };
  if (step && Math.abs(value / step - Math.round(value / step)) > 1e-9) {
    return { ok: false, message: final ? `${step}刻みで入力` : null };
  }
  return { ok: true, value, converted: Boolean(parsed.converted) };
}
