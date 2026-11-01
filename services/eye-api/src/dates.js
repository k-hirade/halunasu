// 診療日・発行日などの「日付」は日本時間で決める（UTC のままだと朝 9 時前が前日になる）。
export function japanDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
