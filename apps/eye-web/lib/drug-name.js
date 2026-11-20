// 薬剤名の表示用の正規化。公的マスターの名前は全角の数字・英字（「０．００５％」）のまま保存し、
// 画面と印刷では半角（「0.005%」）にそろえて出す。かな・漢字・括弧などはそのまま。保存する名前は変えない。
const FULL_WIDTH = /[０-９Ａ-Ｚａ-ｚ．％]/gu;

export function displayDrugName(name) {
  if (name === null || name === undefined) return "";
  return String(name).replace(FULL_WIDTH, (char) => char.normalize("NFKC"));
}
