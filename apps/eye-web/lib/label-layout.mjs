// 狭い枠に文字を並べるときの小さな計算（画面の部品から使う。DOM には触らない）。

// グラフの値のラベルの置き場所を決める（重なって読めなくならないように）。
// items: [{ key, x, y, up, text, order }]。x, y は点の位置、up は点の上を第一候補にするか、order は小さいほど先に置く。
// obstacles: 先に置いてある四角（{ x1, x2, y1, y2 }。点・目盛り・日付など）。bounds: { left, right, top, bottom }。
// 第一候補（上なら点の 7px 上、下なら 14px 下のベースライン）、だめなら反対側に置く。どちらも掛かるラベルは省く。
// 左右は枠の中に寄せる。返り値は key → { x, y }（y は文字のベースライン、文字は x を中心に置く）。
export const LABEL_HEIGHT = 11;
export const LABEL_CHAR_WIDTH = 6.4;

export function placeLabels(items, { obstacles = [], bounds, charWidth = LABEL_CHAR_WIDTH, height = LABEL_HEIGHT } = {}) {
  const boxes = [...obstacles];
  const overlaps = (box) => boxes.some((other) => box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2);
  const placed = new Map();
  for (const item of [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const half = (String(item.text).length * charWidth) / 2 + 1;
    const x = Math.min(Math.max(item.x, bounds.left + half), bounds.right - half);
    const above = item.y - 7;
    const below = item.y + 14;
    for (const baseline of item.up ? [above, below] : [below, above]) {
      const box = { x1: x - half, x2: x + half, y1: baseline - height + 2, y2: baseline + 2 };
      if (box.y1 < bounds.top || box.y2 > bounds.bottom || overlaps(box)) continue;
      boxes.push(box);
      placed.set(item.key, { x, y: baseline });
      break;
    }
  }
  return placed;
}

// 値の文字（「0.9 (1.2×S−1.00D=C−0.50D Ax180°)」など）を、折り返してよい所で区切る。
// 空白・「×」「=」の後と、括弧の前で区切る。区切りの中では折り返さない前提で使う（nowrap の span）。
export function splitAtBreaks(text) {
  return String(text ?? "").split(/(?<=[\s×=])|(?=[(（])/u).filter(Boolean);
}
