// ダイアログ（components/modal.js）の決まりごと。DOM を使わない部分だけをここに置き、テストする。

export const DIRTY_CONFIRM_TEXT = "入力中の内容を破棄して閉じますか？";

// 日本語入力の変換中のキー（Enter・Esc は変換の確定・取り消しに使うので、閉じる・送るに使わない）
export function isImeKey(event) {
  return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229);
}

// ほかの部品が先に使ったキーか（React の合成イベントは isDefaultPrevented() で見る）
export function isPrevented(event) {
  return Boolean(event?.defaultPrevented || event?.nativeEvent?.defaultPrevented || (typeof event?.isDefaultPrevented === "function" && event.isDefaultPrevented()));
}

// Tab で次に移る先。count 個の移り先のうち current 番目（-1 は外）にいるとき、端で反対の端へ回す。
// 回す必要がないとき（中ほどにいる）は -1（ブラウザに任せる）。
export function trapTarget(count, current, shift) {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return -1;
}

// 開いているダイアログの重なり（後から開いたものが上）。Esc・背景のクリックは一番上だけが受ける。
export function createModalStack() {
  const entries = [];
  return {
    push(entry) {
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    top: () => entries[entries.length - 1] || null,
    isTop: (entry) => entries.length > 0 && entries[entries.length - 1] === entry,
    size: () => entries.length,
    find: (predicate) => [...entries].reverse().find(predicate) || null
  };
}

// 閉じてよいか。dirty（入力途中）のときだけ確かめる。× とキャンセルはこれを通さない（各ダイアログのまま）。
export function confirmClose({ dirty = false, text = DIRTY_CONFIRM_TEXT, confirm }) {
  if (!dirty) return true;
  return Boolean(confirm(text));
}
