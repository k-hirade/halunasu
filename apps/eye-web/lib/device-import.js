// 機器データの取り込み（トプコン RegData の機器データ欄に倣う）。
// 機器との接続はしない。機器の印字・書き出し（テキスト/CSV）を貼り付けたものを読み、
// 検査記録の values.devices.{autoref,kerato,tonometer} の形（eye-contracts の validateDevices）にする。
// 読めない行は errors に入れて、読めた値だけを返す（推測で埋めない）。

export const DEVICE_IMPORT_KINDS = [
  ["auto", "自動判定"],
  ["autoref", "レフ（AR）"],
  ["kerato", "ケラト（KM）"],
  ["tonometer", "眼圧（NCT）"]
];
export const DEVICE_IMPORT_LABELS = { autoref: "レフ値", kerato: "ケラト値", tonometer: "眼圧値" };
export const DEVICE_IMPORT_NAME = "手入力取込";
const MAX_READINGS = 10;
const MAX_RAW = 4000;

// <R> ［右］ のような括弧つき、R / OD の後に区切り、右・左（数字が続いてもよい）
const EYE_PATTERNS = [
  /^[<＜(（[【]\s*(R|L|OD|OS|右眼|左眼|右|左)\s*[>＞)）\]】]/iu,
  /^(R|L|OD|OS)(?=$|[\s,，:：=;\t]|[-+])/iu,
  /^(右眼|左眼|右|左)/u
];
const EYE_OF = { r: "od", od: "od", l: "os", os: "os", 右: "od", 右眼: "od", 左: "os", 左眼: "os" };

function eyeFrom(token) {
  return EYE_OF[token.toLowerCase()] || "";
}

function normalizeLine(line) {
  return line.normalize("NFKC").replace(/[−–—]/gu, "-").trim();
}

// 行の頭の眼の印（R / L / <R> / 右 / OD など）を外す
export function splitEye(line) {
  const match = EYE_PATTERNS.map((pattern) => line.match(pattern)).find(Boolean);
  if (!match) return { eye: "", rest: line };
  return { eye: eyeFrom(match[1]), rest: line.slice(match[0].length).replace(/^[\s,，:：=;\t]+/u, "") };
}

// 数値を、ラベル付き（S-1.25 / K1 43.5 / A180）とラベルなしに分けて読む
export function readTokens(text) {
  const labeled = {};
  const plain = [];
  // ラベルの直後の数、または英数字に続かない数（「K1」の 1 や「14mmHg」の前の語は拾わない）
  const pattern = /(?:\b(SPH|CYL|AXIS|AX|K1|K2|R1|R2|CY|PD|S|C|A)\s*[:=]?\s*|(?<![A-Za-z0-9.]))([+-]?\d+(?:\.\d+)?)/giu;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1]) {
      const label = { SPH: "S", CYL: "C", CY: "C", AXIS: "A", AX: "A" }[match[1].toUpperCase()] || match[1].toUpperCase();
      labeled[label] = value;
    } else {
      plain.push(value);
    }
  }
  return { labeled, plain };
}

// 種類の自動判定（ラベルの語 → 数の形）
export function detectKind(text) {
  const source = String(text || "").normalize("NFKC");
  if (/\b(K1|K2|R1|R2|KM|KRT|KER)\b|ケラト|角膜曲率/iu.test(source)) return "kerato";
  if (/\b(NCT|IOP|mmHg|TONO)\b|眼圧/iu.test(source)) return "tonometer";
  if (/\b(AR|REF|SPH|CYL)\b|レフ|\bS\s*[+-]?\d|\bC\s*[+-]?\d/iu.test(source)) return "autoref";
  const numbers = [...source.matchAll(/[+-]?\d+(?:\.\d+)?/gu)].map((match) => match[0]);
  if (numbers.length && numbers.every((value) => /^\d+(\.\d)?$/u.test(value) && Number(value) <= 90) && !/\.\d\d/u.test(source)) return "tonometer";
  return "autoref";
}

const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const round2 = (value) => Math.round(value * 100) / 100;

function scaFrom({ labeled, plain }) {
  const values = [...plain];
  const sca = {};
  const sphere = labeled.S ?? values.shift();
  const cylinder = labeled.C ?? values.shift();
  const axis = labeled.A ?? values.shift();
  if (sphere !== undefined) sca.sphere = sphere;
  if (cylinder !== undefined) sca.cylinder = cylinder;
  if (axis !== undefined) sca.axis = axis;
  return sca;
}

function checkSca(sca) {
  if (sca.sphere !== undefined && !inRange(sca.sphere, -40, 40)) return "S は -40〜+40 の値です";
  if (sca.cylinder !== undefined && !inRange(sca.cylinder, -20, 20)) return "C は -20〜+20 の値です";
  if (sca.axis !== undefined && !(Number.isInteger(sca.axis) && inRange(sca.axis, 0, 180))) return "軸は 0〜180 の整数です";
  return "";
}

function keratoFrom({ labeled, plain }) {
  const eye = {};
  const values = [...plain];
  // ラベルなし: 5〜12 は曲率半径（mm）、30〜70 は屈折力（D）、残りの 0〜180 の整数は軸
  const radii = [];
  const powers = [];
  for (const value of values) {
    if (inRange(value, 5, 12) && !Number.isInteger(value)) radii.push(value);
    else if (inRange(value, 30, 70) && !Number.isInteger(value)) powers.push(value);
    else if (Number.isInteger(value) && inRange(value, 0, 180) && eye.axis === undefined) eye.axis = value;
  }
  const r1 = labeled.R1 ?? radii[0];
  const r2 = labeled.R2 ?? radii[1];
  if (r1 !== undefined) eye.r1 = r1;
  if (r2 !== undefined) eye.r2 = r2;
  const k1 = labeled.K1 ?? powers[0] ?? (inRange(r1, 5, 12) ? round2(337.5 / r1) : undefined);
  const k2 = labeled.K2 ?? powers[1] ?? (inRange(r2, 5, 12) ? round2(337.5 / r2) : undefined);
  if (k1 !== undefined) eye.k1 = k1;
  if (k2 !== undefined) eye.k2 = k2;
  if (labeled.A !== undefined) eye.axis = labeled.A;
  if (labeled.C !== undefined) eye.cylinder = labeled.C;
  return eye;
}

function checkKerato(eye) {
  if (eye.k1 !== undefined && !inRange(eye.k1, 30, 70)) return "K1 は 30〜70 D の値です";
  if (eye.k2 !== undefined && !inRange(eye.k2, 30, 70)) return "K2 は 30〜70 D の値です";
  if (eye.r1 !== undefined && !inRange(eye.r1, 5, 12)) return "R1 は 5〜12 mm の値です";
  if (eye.r2 !== undefined && !inRange(eye.r2, 5, 12)) return "R2 は 5〜12 mm の値です";
  if (eye.axis !== undefined && !(Number.isInteger(eye.axis) && inRange(eye.axis, 0, 180))) return "軸は 0〜180 の整数です";
  if (eye.cylinder !== undefined && !inRange(eye.cylinder, -20, 20)) return "CYL は -20〜+20 の値です";
  return "";
}

function averageOf(values) {
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

// text: 貼り付けた文字。kind: "auto" | "autoref" | "kerato" | "tonometer"。now: Date（測定時刻の既定）。
// 戻り値: { kind, data, errors: [{ line, text, message }], count }
export function parseDeviceText(text, kind = "auto", now = new Date()) {
  const raw = String(text || "").replace(/\r\n?/gu, "\n");
  const resolved = kind === "auto" ? detectKind(raw) : kind;
  const errors = [];
  const eyes = { od: { readings: [] }, os: { readings: [] } };
  let pd = null;
  let current = "";
  let count = 0;
  raw.split("\n").forEach((original, index) => {
    const line = normalizeLine(original);
    if (!line) return;
    const lineNo = index + 1;
    const pdMatch = line.match(/\bPD\s*[:=]?\s*(\d+(?:\.\d+)?)/iu);
    if (pdMatch && resolved === "autoref") {
      const value = Number(pdMatch[1]);
      if (inRange(value, 40, 85)) pd = value;
      else errors.push({ line: lineNo, text: original.trim(), message: "PD は 40〜85 mm の値です" });
      if (!splitEye(line).eye) return;
    }
    const { eye, rest } = splitEye(line);
    if (eye) current = eye;
    const tokens = readTokens(rest.replace(/\bPD\s*[:=]?\s*\d+(?:\.\d+)?/iu, ""));
    if (!tokens.plain.length && !Object.keys(tokens.labeled).length) return; // 見出し・眼の印だけの行
    if (!current) {
      if (/\d[/:]\d/u.test(rest)) return; // 眼の印より前の日付・時刻の行
      errors.push({ line: lineNo, text: original.trim(), message: "右眼（R）・左眼（L）が分かりません" });
      return;
    }
    const representative = /\b(AVG|AVE|REP)\b|^\*|平均|代表/iu.test(rest);
    if (resolved === "autoref") {
      const sca = scaFrom(tokens);
      const problem = checkSca(sca);
      if (problem) { errors.push({ line: lineNo, text: original.trim(), message: problem }); return; }
      if (representative) eyes[current].representative = sca;
      else eyes[current].readings.push(sca);
      count += 1;
    } else if (resolved === "kerato") {
      const value = keratoFrom(tokens);
      const problem = checkKerato(value);
      if (problem || !Object.keys(value).length) { errors.push({ line: lineNo, text: original.trim(), message: problem || "数値が読めません" }); return; }
      eyes[current] = { ...eyes[current], ...value };
      count += 1;
    } else {
      // 平均は読んだ値から計算し直すため、AVG・平均より後ろは読まない
      const measured = readTokens(rest.split(/\b(?:AVG|AVE)\b|平均/iu)[0].replace(/mmHg/giu, " "));
      for (const value of [...measured.plain, ...Object.values(measured.labeled)]) {
        if (!inRange(value, 0, 90)) { errors.push({ line: lineNo, text: original.trim(), message: "眼圧は 0〜90 mmHg の値です" }); continue; }
        eyes[current].readings.push({ value });
        count += 1;
      }
    }
  });

  const data = { device: DEVICE_IMPORT_NAME, measuredAt: now.toISOString(), raw: raw.trim().slice(0, MAX_RAW) };
  for (const side of ["od", "os"]) {
    const eye = eyes[side];
    if (eye.readings.length > MAX_READINGS) {
      errors.push({ line: 0, text: "", message: `${side === "od" ? "右眼" : "左眼"}の測定は新しい ${MAX_READINGS} 回だけを取り込みます` });
      eye.readings = eye.readings.slice(-MAX_READINGS);
    }
    if (resolved === "autoref") {
      const readings = eye.readings.filter((item) => Object.keys(item).length);
      if (readings.length || eye.representative) data[side] = { readings, ...(eye.representative ? { representative: eye.representative } : {}) };
    } else if (resolved === "kerato") {
      const { readings, ...values } = eye;
      if (Object.keys(values).length) data[side] = values;
    } else if (eye.readings.length) {
      data[side] = { readings: eye.readings, average: averageOf(eye.readings.map((item) => item.value)) };
    }
  }
  if (resolved === "autoref" && pd !== null) data.pd = pd;
  if (resolved === "tonometer") data.method = "nct";
  return { kind: resolved, data, errors, count: data.od || data.os ? count : 0 };
}

// 取り込んだ値を検査記録の values に入れる（同じ種類の前の取り込みは置き換える）
export function withImportedDevice(values = {}, kind, data) {
  return { ...values, devices: { ...(values.devices || {}), [kind]: data } };
}

// 画面の確認用の短い文（眼ごと）
export function previewLines(kind, data = {}) {
  const lines = [];
  const fmt = (value) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}` : "—");
  for (const [side, label] of [["od", "R"], ["os", "L"]]) {
    const eye = data[side];
    if (!eye) continue;
    if (kind === "autoref") {
      for (const reading of eye.readings || []) lines.push(`${label}  S${fmt(reading.sphere)} C${fmt(reading.cylinder)} A${reading.axis ?? "—"}`);
      if (eye.representative) lines.push(`${label}* S${fmt(eye.representative.sphere)} C${fmt(eye.representative.cylinder)} A${eye.representative.axis ?? "—"}（代表値）`);
    } else if (kind === "kerato") {
      lines.push(`${label}  ${[eye.k1 !== undefined ? `K1 ${eye.k1.toFixed(2)}` : "", eye.k2 !== undefined ? `K2 ${eye.k2.toFixed(2)}` : "", eye.axis !== undefined ? `A ${eye.axis}` : "", eye.r1 !== undefined ? `R1 ${eye.r1}mm` : "", eye.r2 !== undefined ? `R2 ${eye.r2}mm` : "", eye.cylinder !== undefined ? `CYL ${fmt(eye.cylinder)}` : ""].filter(Boolean).join(" ")}`);
    } else {
      lines.push(`${label}  ${(eye.readings || []).map((item) => item.value).join(" ")}  平均 ${eye.average ?? "—"}`);
    }
  }
  if (kind === "autoref" && Number.isFinite(data.pd)) lines.push(`PD ${data.pd}`);
  return lines;
}
