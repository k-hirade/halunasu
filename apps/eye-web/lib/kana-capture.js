// 氏名の入力から、日本語入力（IME）で変換する前の読みを拾ってフリガナにする（画面から切り離した純粋な関数）。
// - compositionupdate の data は、変換する前はひらがな（ローマ字入力の途中は「やまd」のように英字が混ざる）、
//   変換したあとは漢字になる。かなだけのときの data を「読み」として覚えておき、compositionend で確定した文字と組にする。
// - 氏名の今の値を、覚えた組（確定した文字 → 読み）で端から読み直す。消した文字の組は使われなくなる。
// - 組のない文字（貼り付けた漢字など）は読めないので飛ばす。読めた部分が 1 つもなければ "" （フリガナは埋めない）。
// - 氏名の空白（姓と名の区切り）はフリガナでも空白 1 つにする。
import { normalizeKanaName, toKatakana } from "@halunasu/eye-contracts";

const KANA_ONLY = /^[ぁ-ゖゝゞァ-ヺヽヾー・\s]+$/u;
const KANA_CHAR = /^[ぁ-ゖゝゞァ-ヺヽヾー]$/u;

export function createKanaCapture() {
  return { segments: [], composing: false, reading: "", fresh: false };
}

// event: { type: "start" } / { type: "update", data } / { type: "end", data }。新しい状態を返す（元は変えない）。
export function kanaCaptureStep(state, event) {
  if (event.type === "start") return { ...state, composing: true, reading: "", fresh: true };
  if (event.type === "update") {
    const data = String(event.data ?? "");
    if (!KANA_ONLY.test(data)) return { ...state, fresh: false };
    // 一部だけ確定して残りを続けて変換する（文節を区切って確定する）と、残りの読みが新しい変換の最初に丸ごと来る。
    // そのときは直前の組の読みの終わりから、その分を取り除く。
    let segments = state.segments;
    const last = segments.at(-1);
    if (state.fresh && data.length >= 2 && last && last.reading.length > data.length && last.reading.endsWith(data)) {
      segments = [...segments.slice(0, -1), { ...last, reading: last.reading.slice(0, -data.length) }];
    }
    return { ...state, segments, reading: data, fresh: false };
  }
  if (event.type === "end") {
    const text = String(event.data ?? "");
    const reading = KANA_ONLY.test(text) ? text : state.reading;
    const next = { ...state, composing: false, reading: "", fresh: false };
    if (!text.trim() || !reading.trim()) return next;
    return { ...next, segments: [...state.segments, { text, reading }] };
  }
  return state;
}

// 氏名の値をフリガナ（カタカナ、空白は 1 つ）にする。読めた部分がなければ ""。
export function readingOf(state, value) {
  const name = String(value ?? "");
  const used = new Set();
  let out = "";
  let known = false;
  let index = 0;
  while (index < name.length) {
    // 同じ文字を打ち直したとき（消して別の読みで変換し直したとき）は、新しい組を使う
    const found = state.segments.findLastIndex((segment, at) => !used.has(at) && segment.text && name.startsWith(segment.text, index));
    if (found >= 0) {
      used.add(found);
      out += state.segments[found].reading;
      index += state.segments[found].text.length;
      known = true;
      continue;
    }
    const char = name[index];
    if (/\s/u.test(char)) out += " ";
    else if (KANA_CHAR.test(char)) {
      out += char;
      known = true;
    }
    index += 1;
  }
  return known ? normalizeKanaName(toKatakana(out)) : "";
}

// フリガナを自動で入れるか。入れるのは、フリガナが空か、前に自動で入れた値のままのときだけ（手で直したら止める）。
// 返り値: { kana, auto }（auto は次に比べる「前に自動で入れた値」）。変えないときは null。
export function autoKana({ kana, auto, reading }) {
  const current = String(kana ?? "");
  const touchedByHand = current !== "" && current !== auto;
  if (touchedByHand) return null;
  if (reading === current) return reading === auto ? null : { kana: current, auto: reading };
  return { kana: reading, auto: reading };
}
