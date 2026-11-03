"use client";

import { useRef, useState } from "react";
import { acceptNumber, normalizeNumberText, readNumber } from "../lib/exam-number";
import { formatDiopter } from "../lib/format";

// 検査値の入力部品。
// - 数値は type="text" で受け、入力途中（「-」「-1.」など）を消さない。完全な数値になった時点で保存値（数値）に反映する。
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

// スマホではテンキーが画面下のシートになるため、入力欄を画面の上の方へ送る。
function revealAboveSheet(input) {
  if (!input || typeof window === "undefined" || !window.matchMedia("(max-width: 639px)").matches) return;
  requestAnimationFrame(() => input.scrollIntoView({ block: "start", behavior: "smooth" }));
}

// 数値の入力欄。value は保存値（数値または null）、onCommit で保存値を更新する。
export function NumberField({
  value, onCommit, min, max, integer = false, format = (number) => String(number), pad = null, touch = false,
  className = "input input-num", inputMode = "decimal", ...rest
}) {
  const [text, setText] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  // フォーカス直後は「全選択」と同じ扱いにし、テンキーの数字・符号は新しい入力として始める。
  const [fresh, setFresh] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const keepRef = useRef(false);
  const committed = Number.isFinite(value) ? value : null;
  const shown = text ?? (committed === null ? "" : format(committed));
  const usePad = Boolean(pad && touch && !keyboard);

  function close() {
    keepRef.current = false;
    setText(null);
    setInvalid(false);
    setPadOpen(false);
  }

  function accept(next) {
    setFresh(false);
    setText(next);
    const parsed = readNumber(next);
    if (parsed.empty) {
      setInvalid(false);
      if (committed !== null) onCommit(null);
      return;
    }
    if (parsed.partial) {
      setInvalid(false);
      return;
    }
    const ok = acceptNumber(parsed, { min, max, integer });
    setInvalid(!ok);
    if (ok && parsed.value !== committed) onCommit(parsed.value);
  }

  return (
    <span
      className={`num-field${padOpen ? " is-pad-open" : ""}`}
      onBlur={(event) => {
        // テンキーを押してフォーカスが移った場合は入力中のまま。欄の外へ出たら、
        // 数値として読めない入力は確定済みの値の表示に戻す（途中の入力を保存値にしない）。
        if (wrapRef.current?.contains(event.relatedTarget)) return;
        close();
      }}
      ref={wrapRef}
    >
      <input
        {...rest}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        className={`${className}${invalid ? " is-invalid" : ""}`}
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
          setText(event.target.value);
          setFresh(true);
          event.target.select();
          if (usePad) {
            setPadOpen(true);
            revealAboveSheet(event.target);
          }
        }}
        ref={inputRef}
        type="text"
        value={shown}
      />
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
            close();
            inputRef.current?.blur();
          }}
          onNext={() => {
            close();
            focusNextField(inputRef.current, { includeSkipped: true });
          }}
          previous={pad.previous}
          text={normalizeNumberText(shown)}
        />
      ) : null}
    </span>
  );
}

// 屈折値（S・C）の入力欄。表示は符号付き・小数2桁。
export function DiopterField({ value, onCommit, limit = 40, previous = null, touch = false, ...rest }) {
  return (
    <NumberField
      {...rest}
      format={formatDiopter}
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

function NumberPad({ kind, text: current, fresh, committed, previous, onKey, onNext, onKeyboard, onClose }) {
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
      <div aria-label="軸のテンキー" className="num-pad is-axis" role="group">
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
    <div aria-label="度数のテンキー" className="num-pad" role="group">
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

// 視力の入力欄。PC では候補付きの文字入力、タッチ端末では値のタイルを開く（選ぶと次の欄へ進む）。
export function VaField({ value, onChange, previous = "", touch = false, className = "input input-va", ...rest }) {
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const keepRef = useRef(false);
  const usePicker = touch && !keyboard;
  const keep = (event) => event.preventDefault();
  const press = (handler) => ({ onClick: handler, onMouseDown: keep, onPointerDown: keep, type: "button" });
  const close = () => {
    keepRef.current = false;
    setOpen(false);
  };
  const choose = (next) => {
    onChange(next);
    close();
    focusNextField(inputRef.current);
  };
  return (
    <span
      className={`num-field${open ? " is-pad-open" : ""}`}
      onBlur={(event) => {
        if (wrapRef.current?.contains(event.relatedTarget)) return;
        close();
      }}
      ref={wrapRef}
    >
      <input
        {...rest}
        autoComplete="off"
        className={className}
        inputMode={usePicker ? "none" : "decimal"}
        list="va-values"
        onBlur={(event) => {
          if (wrapRef.current?.contains(event.relatedTarget)) keepRef.current = true;
        }}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => {
          if (keepRef.current) {
            keepRef.current = false;
            return;
          }
          if (usePicker) {
            setOpen(true);
            revealAboveSheet(inputRef.current);
          }
        }}
        ref={inputRef}
        value={value || ""}
      />
      {open && usePicker ? (
        <div aria-label="視力を選ぶ" className="va-picker" role="group">
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
              onChange("");
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
