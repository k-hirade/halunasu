// レセプト関連の小さな純関数ユーティリティ。
// index.js と clinic-diagnosis.js の双方から参照される（循環依存を避けるため独立モジュール）。

// 点数 → 概算金額(円)。点数×10円・総医療費ベース（患者負担・公費按分なし）。
export function estimateReceiptYen(points) {
  return Math.round((Number(points) || 0) * 10);
}
