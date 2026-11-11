// 傷病名編集の右の「修飾語の候補」（検索語が空のときに出す一覧）。眼科でよく使う修飾語を、公開の修飾語マスターのコードで並べる。
// 名称・前後（接頭・接尾）はマスターから引く（マスターに無いコードは出さない）。並びは 左右 → 時期・経過 → 程度 → 原因 → 部位。
export const COMMON_MODIFIER_CODES = Object.freeze([
  "2056", "2049", "2057", "2058",
  "4012", "4043", "4025", "5124", "3088",
  "7009", "7011", "7017",
  "6023", "3101", "3028", "3122", "3105", "3005", "3064", "3013", "5107", "5118", "4038", "5194",
  "2016", "2003", "2045", "2006"
]);

export function commonModifiers(index, limit = COMMON_MODIFIER_CODES.length) {
  if (!index?.lookup) return [];
  return COMMON_MODIFIER_CODES.map((code) => index.lookupOne("modifier", code)).filter(Boolean).slice(0, limit).map((record) => ({ ...record, match: "common" }));
}
