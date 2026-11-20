"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isVisualAcuityText } from "@halunasu/eye-contracts";
import { usePopoverPlacement } from "./popover-placement";
import { checkNumber, normalizeNumberText, readDiopter, readNumber } from "../lib/exam-number";
import { formatDiopter } from "../lib/format";

// 検査値の入力部品。
// - 数値は type="text" で受け、入力途中（「-」「-1.」など）を消さない。完全な数値になった時点で保存値（数値）に反映する。
// - 範囲外・読めない入力は赤枠と短い説明を出したまま欄に残し、保存しない（打っている途中の桁で保存した値も
//   編集前の値に戻す。「200」→「20」のように、途中の値を受け付けたように見せない）。
// - タッチ端末では OS のキーボードの代わりにテンキー（符号・0.25 刻み・前回値）を開く。iPhone の小数キーボードには
//   マイナスがないため。「キーボード」で OS のキーボードに切り替えられる。
// - 符号を自動で反転したり、値を丸めたりはしない。

export const VA_VALUES = [
  "2.0", "1.5", "1.2", "1.0", "0.9", "0.8", "0.7", "0.6", "0.5", "0.4", "0.3", "0.2", "0.15", "0.1",
  "0.09", "0.08", "0.07", "0.06", "0.05", "0.04", "0.03", "0.02", "0.01", "n.d.", "m.m.", "s.l.(+)", "s.l.(-)", "n.c."
];
const VA_SPECIAL_LABELS = { "n.d.": "指数弁", "m.m.": "手動弁", "s.l.(+)": "光覚+", "s.l.(-)": "光覚−", "n.c.": "矯正不能" };

// Enter・「次へ」で次の入力欄へ。対象は data-enter-root の中の、data-enter-skip の付いていない入力欄。
// includeSkipped はテンキーの「次へ」用（屈折の S → C → Ax も順にたどる）。
export function focusNextField(from, { includeSkipped = false } = {}) {
  const root = from?.closest?.("[data-enter-root]");
  if (!root) return false;
  const selector = includeSkipped
    ? "input:not([type=checkbox]):not([type=time]):not(:disabled)"
    : "input:not([type=checkbox]):not([data-enter-skip]):not(:disabled)";
  const fields = [...root.querySelectorAll(selector)];
  // 自分が対象外の欄でも、文書の順で自分より後ろにある最初の欄へ進む。
  const next = fields.find((field) => from.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (!next) {
    from.blur();
    return false;
  }
  next.focus();
  next.select?.();
  return true;
}

export function moveToNextOnEnter(event) {
  const target = event.target;
  if (event.key !== "Enter" || event.isComposing || target.tagName !== "INPUT" || target.type === "checkbox") return;
  if (target.hasAttribute("data-enter-skip")) return;
  event.preventDefault();
  focusNextField(target);
}

// テンキー・視力の選択を画面下のシートにする条件（スマホ・タッチ端末・高さの低い画面）。
// exam.css の同じ条件の @media とそろえる。それ以外は欄の下（入らなければ上）に開くポップオーバー
// （シートのときは CSS で fixed になるので、usePopoverPlacement は何もしない）。
export const KEYPAD_SHEET_QUERY = "(max-width: 639px), (pointer: coarse), (max-height: 600px)";

// シートのときは入力欄が隠れないよう、欄をヘッダーとシートの間の中ほどへ送る。
// シートが描かれてから（2 フレーム後）上端を測る。横にスクロールする表の中の欄は、横も見える位置へ送る。
function revealAboveSheet(input) {
  if (!input || typeof window === "undefined" || !window.matchMedia(KEYPAD_SHEET_QUERY).matches) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const sheet = input.closest(".num-field")?.querySelector(".num-pad, .va-picker");
    const navHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-h")) || 0;
    const top = navHeight + 8;
    const bottom = (sheet ? sheet.getBoundingClientRect().top : window.innerHeight) - 8;
    const scroller = input.closest(".rd-grid-scroll");
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      // 左に固定した見出しの列（遠見/近見・R/L）の分だけ、左端をずらして見る
      const sticky = scroller.querySelector(".rd-eye");
      const stickyRight = sticky ? sticky.getBoundingClientRect().right : scroller.getBoundingClientRect().left;
      const box = input.getBoundingClientRect();
      const viewRight = scroller.getBoundingClientRect().right;
      if (box.left < stickyRight) scroller.scrollLeft -= stickyRight - box.left + 4;
      else if (box.right > viewRight) scroller.scrollLeft += box.right - viewRight + 4;
    }
    const rect = input.getBoundingClientRect();
    if (rect.top >= top && rect.bottom <= bottom) return;
    const target = top + Math.max(0, (bottom - top - rect.height) / 2);
    window.scrollBy({ top: rect.top - target, behavior: "smooth" });
  }));
}

// 数値の入力欄。value は保存値（数値または null）、onCommit で保存値を更新する。
// step: 刻み（屈折は 0.25）。read: 文字列の読み方（屈折は 3 桁以上を 1/100 D として読む readDiopter）。
export function NumberField({
  value, onCommit, min, max, integer = false, step, read = readNumber, format = (number) => String(number), pad = null, touch = false,
  className = "input input-num", inputMode = "decimal", ...rest
}) {
  const [text, setText] = useState(null);
  const [message, setMessage] = useState(null);
  const [hint, setHint] = useState(null);
  const [keyboard, setKeyboard] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  // フォーカス直後は「全選択」と同じ扱いにし、テンキーの数字・符号は新しい入力として始める。
  const [fresh, setFresh] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const keepRef = useRef(false);
  const padRef = useRef(null);
  const messageId = useId();
  const committed = Number.isFinite(value) ? value : null;
  // 編集を始めたときの保存値（読めない入力のときはこの値に戻す）と、最後に自分で送った保存値
  const startRef = useRef(committed);
  const sentRef = useRef(committed);
  // この編集で打ったか（打たずに通り過ぎた欄は、保存済みの値が今の条件に合わなくても赤くしない）
  const editedRef = useRef(false);
  const shown = text ?? (committed === null ? "" : format(committed));
  const usePad = Boolean(pad && touch && !keyboard);
  const limits = { min, max, integer, step, read };
  usePopoverPlacement(padRef, padOpen && usePad);

  // ほかの操作（前回値の写し・記録の切り替えなど）で保存値が変わったら、残っている入力と説明を消す
  useEffect(() => {
    if (committed === sentRef.current) return;
    sentRef.current = committed;
    startRef.current = committed;
    if (document.activeElement !== inputRef.current) {
      setText(null);
      setMessage(null);
      setHint(null);
    }
  }, [committed]);

  function commit(next) {
    if (next === committed) return;
    sentRef.current = next;
    onCommit(next);
  }

  function close() {
    keepRef.current = false;
    setText(null);
    setMessage(null);
    setHint(null);
    setPadOpen(false);
  }

  // 欄を離れるとき。読めない入力は欄に残して赤のまま（保存値は編集前のまま）。
  function finish() {
    if (text !== null && editedRef.current) {
      const result = checkNumber(text, { ...limits, final: true });
      if (!result.ok) {
        keepRef.current = false;
        setMessage(result.message);
        setHint(null);
        setPadOpen(false);
        commit(startRef.current);
        return;
      }
      commit(result.value);
    }
    close();
  }

  function accept(next) {
    editedRef.current = true;
    setFresh(false);
    setText(next);
    const result = checkNumber(next, limits);
    if (result.ok) {
      setMessage(null);
      setHint(result.converted ? format(result.value) : null);
      commit(result.value);
      return;
    }
    setMessage(result.message);
    setHint(null);
    commit(startRef.current);
  }

  return (
    <span
      className={`num-field${padOpen ? " is-pad-open" : ""}`}
      onBlur={(event) => {
        // テンキーを押してフォーカスが移った場合は入力中のまま。欄の外へ出たら確かめる。
        if (wrapRef.current?.contains(event.relatedTarget)) return;
        finish();
      }}
      ref={wrapRef}
    >
      <input
        {...rest}
        aria-describedby={message || hint ? messageId : undefined}
        aria-invalid={message ? true : undefined}
        autoComplete="off"
        className={`${className}${message ? " is-invalid" : ""}`}
        inputMode={usePad ? "none" : keyboard ? "text" : inputMode}
        onBlur={(event) => {
          if (wrapRef.current?.contains(event.relatedTarget)) keepRef.current = true;
        }}
        onChange={(event) => accept(event.target.value)}
        onFocus={(event) => {
          if (keepRef.current) {
            keepRef.current = false;
            return;
          }
          // 赤のまま残した入力は、そのまま直せるようにする（編集前の値は保ったまま）
          if (text === null) {
            startRef.current = committed;
            editedRef.current = false;
          }
          setText(event.target.value);
          setFresh(true);
          event.target.select();
          if (usePad) {
            setPadOpen(true);
            revealAboveSheet(event.target);
          }
        }}
        ref={inputRef}
        title={message || rest.title}
        type="text"
        value={shown}
      />
      {message || hint ? (
        <span className={`num-msg${message ? " is-error" : " is-hint"}`} id={messageId} role={message ? "alert" : "status"}>
          {message || `→ ${hint}`}
        </span>
      ) : null}
      {padOpen && usePad ? (
        <NumberPad
          committed={committed}
          fresh={fresh}
          kind={pad.kind}
          onKey={(next) => {
            accept(next);
            if (document.activeElement !== inputRef.current) inputRef.current?.focus({ preventScroll: true });
          }}
          onKeyboard={() => {
            close();
            setKeyboard(true);
            const input = inputRef.current;
            input?.blur();
            setTimeout(() => input?.focus(), 0);
          }}
          onClose={() => {
            finish();
            inputRef.current?.blur();
          }}
          onNext={() => {
            finish();
            focusNextField(inputRef.current, { includeSkipped: true });
          }}
          panelRef={padRef}
          previous={pad.previous}
          text={normalizeNumberText(shown)}
        />
      ) : null}
    </span>
  );
}

// 屈折値（S・C）の入力欄。表示は符号付き・小数2桁。0.25 刻み。小数点なしの 3 桁以上は 1/100 D（「-125」→ -1.25）。
export function DiopterField({ value, onCommit, limit = 40, previous = null, touch = false, ...rest }) {
  return (
    <NumberField
      {...rest}
      format={formatDiopter}
      read={readDiopter}
      step={0.25}
      max={limit}
      min={-limit}
      onCommit={onCommit}
      pad={{ kind: "diopter", previous }}
      touch={touch}
      value={value}
    />
  );
}

// 軸（0〜180 の整数）。
export function AxisField({ value, onCommit, previous = null, touch = false, ...rest }) {
  return (
    <NumberField
      {...rest}
      inputMode="numeric"
      integer
      max={180}
      min={0}
      onCommit={onCommit}
      pad={{ kind: "axis", previous }}
      touch={touch}
      value={value}
    />
  );
}

function PadHead({ title, onClose, press, closeLabel = "テンキーを閉じる" }) {
  return (
    <div className="num-pad-head">
      <span>{title}</span>
      <button aria-label={closeLabel} className="num-pad-close" {...press(onClose)}>×</button>
    </div>
  );
}

function NumberPad({ kind, text: current, fresh, committed, previous, onKey, onNext, onKeyboard, onClose, panelRef }) {
  const keep = (event) => event.preventDefault();
  const press = (handler) => ({ onClick: handler, onMouseDown: keep, onPointerDown: keep, type: "button" });
  // 数字と符号は、フォーカス直後なら新しい入力として始める。小数部のキー・⌫ は今の値に効かせる。
  const base = fresh ? "" : current;
  const unsigned = current.replace(/^[+-]/u, "");
  const sign = current.startsWith("-") ? "-" : current.startsWith("+") ? "+" : "";
  const digit = (value) => {
    if (/\.\d{2}$/u.test(base)) return base; // 小数2桁より細かくはしない
    return `${base}${value}`;
  };
  const withFraction = (fraction) => {
    const whole = unsigned.replace(/\..*$/u, "") || "0";
    return `${sign}${whole}${fraction}`;
  };
  const step = (delta) => formatDiopter(Math.round(((committed ?? 0) + delta) * 100) / 100);
  const digitKeys = ["7", "8", "9", "4", "5", "6", "1", "2", "3"];
  if (kind === "axis") {
    return (
      <div aria-label="軸のテンキー" className="num-pad is-axis" ref={panelRef} role="group">
        <PadHead onClose={onClose} press={press} title="軸（0〜180）" />
        {["180", "90", "0"].map((value) => <button className="num-key is-quick" key={value} {...press(() => { onKey(value); onNext(); })}>{value}</button>)}
        {digitKeys.map((value) => <button className="num-key" key={value} {...press(() => onKey(`${base}${value}`))}>{value}</button>)}
        <button className="num-key" {...press(() => onKey(`${base}0`))}>0</button>
        <button aria-label="1文字消す" className="num-key" {...press(() => onKey(current.slice(0, -1)))}>⌫</button>
        <button className="num-key is-text" {...press(() => onKey(""))}>クリア</button>
        <button className="num-key is-wide" disabled={!Number.isFinite(previous)} {...press(() => onKey(String(previous)))}>前回 {Number.isFinite(previous) ? previous : "—"}</button>
        <button className="num-key is-text" title="端末のキーボードで入力" {...press(onKeyboard)}>キー入力</button>
        <button className="num-key is-next" {...press(onNext)}>次へ</button>
      </div>
    );
  }
  return (
    <div aria-label="度数のテンキー" className="num-pad" ref={panelRef} role="group">
      <PadHead onClose={onClose} press={press} title="度数（D）" />
      <button aria-pressed={!fresh && sign === "-"} className="num-key is-sign" {...press(() => onKey(fresh ? "-" : `-${unsigned}`))}>−</button>
      <button aria-pressed={!fresh && sign === "+"} className="num-key is-sign" {...press(() => onKey(fresh ? "+" : `+${unsigned}`))}>+</button>
      <button className="num-key" {...press(() => onKey(step(-0.25)))}>−0.25</button>
      <button className="num-key" {...press(() => onKey(step(0.25)))}>+0.25</button>
      {digitKeys.slice(0, 3).map((value) => <button className="num-key" key={value} {...press(() => onKey(digit(value)))}>{value}</button>)}
      <button className="num-key is-fraction" {...press(() => onKey(withFraction(".00")))}>.00</button>
      {digitKeys.slice(3, 6).map((value) => <button className="num-key" key={value} {...press(() => onKey(digit(value)))}>{value}</button>)}
      <button className="num-key is-fraction" {...press(() => onKey(withFraction(".25")))}>.25</button>
      {digitKeys.slice(6, 9).map((value) => <button className="num-key" key={value} {...press(() => onKey(digit(value)))}>{value}</button>)}
      <button className="num-key is-fraction" {...press(() => onKey(withFraction(".50")))}>.50</button>
      <button className="num-key" {...press(() => onKey(digit("0")))}>0</button>
      <button aria-label="1文字消す" className="num-key" {...press(() => onKey(current.slice(0, -1)))}>⌫</button>
      <button className="num-key is-text" {...press(() => onKey(""))}>クリア</button>
      <button className="num-key is-fraction" {...press(() => onKey(withFraction(".75")))}>.75</button>
      <button className="num-key is-wide" disabled={!Number.isFinite(previous)} {...press(() => onKey(formatDiopter(previous)))}>前回 {Number.isFinite(previous) ? formatDiopter(previous) : "—"}</button>
      <button className="num-key is-text" title="端末のキーボードで入力" {...press(onKeyboard)}>キー入力</button>
      <button className="num-key is-next" {...press(onNext)}>次へ</button>
    </div>
  );
}

// 視力の入力を保存する形に（全角を半角に・前後の空白を除く）。
export function normalizeVaText(text) {
  return String(text ?? "").normalize("NFKC").trim();
}

// 視力の入力欄。PC では候補付きの文字入力、タッチ端末では値のタイルを開く（選ぶと次の欄へ進む）。
// 視力として読める値（小数視力の段階・(1.2)・n.d. など。eye-contracts の isVisualAcuityText）だけを保存する。
// 読めない入力は欄を離れたときに赤枠と説明を出して残し、保存値は編集前のままにする。
export function VaField({ value, onChange, previous = "", touch = false, className = "input input-va", ...rest }) {
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [text, setText] = useState(null);
  const [message, setMessage] = useState(null);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const keepRef = useRef(false);
  const pickerRef = useRef(null);
  const messageId = useId();
  const saved = value || "";
  const startRef = useRef(saved);
  const sentRef = useRef(saved);
  const editedRef = useRef(false);
  const usePicker = touch && !keyboard;
  usePopoverPlacement(pickerRef, open && usePicker);
  const keep = (event) => event.preventDefault();
  const press = (handler) => ({ onClick: handler, onMouseDown: keep, onPointerDown: keep, type: "button" });

  // ほかの操作で保存値が変わったら、残っている入力と説明を消す
  useEffect(() => {
    if (saved === sentRef.current) return;
    sentRef.current = saved;
    startRef.current = saved;
    if (document.activeElement !== inputRef.current) {
      setText(null);
      setMessage(null);
    }
  }, [saved]);

  const commit = (next) => {
    if (next === saved) return;
    sentRef.current = next;
    onChange(next);
  };
  const close = () => {
    keepRef.current = false;
    setOpen(false);
  };
  const finish = () => {
    close();
    if (text === null || !editedRef.current) {
      setText(null);
      return;
    }
    const next = normalizeVaText(text);
    if (isVisualAcuityText(next)) {
      commit(next);
      setText(null);
      setMessage(null);
      return;
    }
    commit(startRef.current);
    setMessage("視力の書き方で入力（例: 1.2・0.5p・(1.0)・n.d.）");
  };
  const accept = (raw) => {
    editedRef.current = true;
    setText(raw);
    const next = normalizeVaText(raw);
    if (isVisualAcuityText(next)) {
      setMessage(null);
      commit(next);
    } else {
      // 入力の途中（「0.」など）は赤くしない。保存値は編集前のまま
      if (message && !next) setMessage(null);
      commit(startRef.current);
    }
  };
  const choose = (next) => {
    setText(null);
    setMessage(null);
    commit(next);
    close();
    focusNextField(inputRef.current);
  };
  return (
    <span
      className={`num-field${open ? " is-pad-open" : ""}`}
      onBlur={(event) => {
        if (wrapRef.current?.contains(event.relatedTarget)) return;
        finish();
      }}
      ref={wrapRef}
    >
      <input
        {...rest}
        aria-describedby={message ? messageId : undefined}
        aria-invalid={message ? true : undefined}
        autoComplete="off"
        className={`${className}${message ? " is-invalid" : ""}`}
        inputMode={usePicker ? "none" : "decimal"}
        list="va-values"
        onBlur={(event) => {
          if (wrapRef.current?.contains(event.relatedTarget)) keepRef.current = true;
        }}
        onChange={(event) => accept(event.target.value)}
        onFocus={(event) => {
          if (keepRef.current) {
            keepRef.current = false;
            return;
          }
          if (text === null) {
            startRef.current = saved;
            editedRef.current = false;
            setText(event.target.value);
          }
          if (usePicker) {
            setOpen(true);
            revealAboveSheet(inputRef.current);
          }
        }}
        ref={inputRef}
        title={message || rest.title}
        value={text ?? saved}
      />
      {message ? <span className="num-msg is-error" id={messageId} role="alert">{message}</span> : null}
      {open && usePicker ? (
        <div aria-label="視力を選ぶ" className="va-picker" ref={pickerRef} role="group">
          <PadHead closeLabel="視力の選択を閉じる" onClose={() => { close(); inputRef.current?.blur(); }} press={press} title="視力" />
          {VA_VALUES.map((item) => (
            <button
              aria-pressed={item === value}
              className={`num-key${VA_SPECIAL_LABELS[item] ? " is-special" : ""}${item === previous ? " is-previous" : ""}`}
              key={item}
              title={`${item}${item === previous ? "（前回の値）" : ""}`}
              {...press(() => choose(item))}
            >
              {VA_SPECIAL_LABELS[item] || item}
            </button>
          ))}
          <button
            className="num-key is-action"
            {...press(() => {
              setText("");
              setMessage(null);
              commit("");
              if (document.activeElement !== inputRef.current) inputRef.current?.focus({ preventScroll: true });
            })}
          >
            クリア
          </button>
          <button
            className="num-key is-action"
            {...press(() => {
              close();
              setKeyboard(true);
              const input = inputRef.current;
              input?.blur();
              setTimeout(() => input?.focus(), 0);
            })}
          >
            キーボードで入力
          </button>
        </div>
      ) : null}
    </span>
  );
}

export function VaDatalist() {
  return (
    <datalist id="va-values">
      {VA_VALUES.map((value) => <option key={value} value={value} />)}
    </datalist>
  );
}
