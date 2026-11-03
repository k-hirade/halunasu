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
