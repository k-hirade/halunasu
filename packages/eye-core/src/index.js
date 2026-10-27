import { EYE_SIDES, validateEncounterContent } from "../../eye-contracts/src/index.js";

// 5mL 点眼瓶はおよそ 100〜150 滴。足りなくならないよう少ない側を既定にし、薬剤ごとに上書きできる。
export const DEFAULT_DROPS_PER_BOTTLE = 100;
export const DEFAULT_NEXT_VISIT_WEEKS = 4;

const NON_NUMERIC_VA = Object.freeze([
  [/^(指数弁|cf|n\.?d\.?)/iu, "指数弁"],
  [/^(手動弁|hm)/iu, "手動弁"],
  [/^(光覚弁|sl|lp)/iu, "光覚弁"],
  [/^(光覚なし|0|nlp)$/iu, "光覚なし"]
]);

export function emptyEncounterContent() {
  return validateEncounterContent({});
}

// 小数視力の表記（例: "1.2", "0.7p", "(1.0×S-1.00D)"）から数値を取り出す。指数弁などはグラフに載せない。
export function parseVisualAcuity(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { decimal: null, label: "" };
  const unwrapped = text.replace(/^[(（]/u, "").replace(/[)）]$/u, "").trim();
  for (const [pattern, label] of NON_NUMERIC_VA) {
    if (pattern.test(unwrapped)) return { decimal: null, label };
  }
  const match = unwrapped.match(/^(\d+(?:\.\d+)?)/u);
  if (!match) return { decimal: null, label: text };
  const decimal = Number(match[1]);
  if (!Number.isFinite(decimal) || decimal <= 0 || decimal > 2.5) return { decimal: null, label: text };
  return { decimal, label: text };
}

export function daysUntilNextVisit(encounterDate, nextVisit = {}) {
  if (nextVisit.date) {
    const days = Math.round((Date.parse(`${nextVisit.date}T00:00:00Z`) - Date.parse(`${encounterDate}T00:00:00Z`)) / 86400000);
    return days > 0 ? days : null;
  }
  const weeks = Number(nextVisit.intervalWeeks);
  return Number.isFinite(weeks) && weeks > 0 ? Math.round(weeks * 7) : null;
}

// 点眼本数 = ceil(日数 × 1日回数 × 眼の数 ÷ 1本あたりの滴数)。1回1滴として計算する。
export function calculateEyeDropBottles({ timesPerDay, eye, days, dropsPerBottle } = {}) {
  const perDay = Number(timesPerDay);
  const totalDays = Number(days);
  const eyes = eye === "ou" ? 2 : eye === "od" || eye === "os" ? 1 : null;
  const capacity = Number(dropsPerBottle) > 0 ? Number(dropsPerBottle) : DEFAULT_DROPS_PER_BOTTLE;
  if (!(perDay > 0) || !(totalDays > 0) || !eyes) {
    return { bottles: null, dropsNeeded: null, dropsPerBottle: capacity, reason: "insufficient_input" };
  }
  const dropsNeeded = perDay * totalDays * eyes;
  return {
    bottles: Math.max(1, Math.ceil(dropsNeeded / capacity)),
    dropsNeeded,
    dropsPerBottle: capacity,
    reason: "calculated"
  };
}

// 次回受診間隔の提案。決めるのは医師で、ここは前回の判断を引き継ぐ根拠付きの候補だけを返す。
export function suggestNextVisit(previousEncounters = [], encounterDate) {
  const finalized = sortByDate(previousEncounters.filter((encounter) => encounter.status === "finalized"))
    .filter((encounter) => !encounterDate || encounter.encounterDate < encounterDate);
  const latest = finalized.at(-1);
  if (latest?.content?.nextVisit?.intervalWeeks) {
    return {
      intervalWeeks: Number(latest.content.nextVisit.intervalWeeks),
      basis: "previous_plan",
      sourceEncounterId: latest.encounterId,
      explanation: `前回（${latest.encounterDate}）の指示「${latest.content.nextVisit.intervalWeeks}週後」を引き継いだ候補です。`
    };
  }
  if (latest && encounterDate) {
    const days = Math.round((Date.parse(`${encounterDate}T00:00:00Z`) - Date.parse(`${latest.encounterDate}T00:00:00Z`)) / 86400000);
    if (days >= 7) {
      const intervalWeeks = Math.max(1, Math.round(days / 7));
      return {
        intervalWeeks,
        basis: "previous_interval",
        sourceEncounterId: latest.encounterId,
        explanation: `前回受診（${latest.encounterDate}）から今回までの間隔（約${intervalWeeks}週）を候補にしました。`
      };
    }
  }
  return {
    intervalWeeks: DEFAULT_NEXT_VISIT_WEEKS,
    basis: "default",
    sourceEncounterId: "",
    explanation: `過去の指示がないため、既定の${DEFAULT_NEXT_VISIT_WEEKS}週を候補にしました。`
  };
}

// 再診の「前回コピー」。視力・眼圧などの測定値は毎回測り直すためコピーしない。
export function copyContentForRevisit(previousContent = {}) {
  const source = validateEncounterContent(previousContent);
  return {
    ...emptyEncounterContent(),
    findings: source.findings,
    sketches: source.sketches,
    assessment: source.assessment,
    plan: source.plan,
    prescriptions: source.prescriptions,
    nextVisit: { intervalWeeks: source.nextVisit.intervalWeeks, date: "", note: "" }
  };
}

const FIELD_LABELS = Object.freeze({
  chiefComplaint: "主訴",
  history: "現病歴・経過",
  assessment: "評価",
  plan: "方針",
  staffNote: "スタッフメモ",
  vaUncorrected: "裸眼視力",
  vaCorrected: "矯正視力",
  iop: "眼圧",
  iopMethod: "眼圧の測定法",
  anterior: "前眼部",
  lens: "中間透光体",
  fundus: "眼底",
  intervalWeeks: "次回（週後）",
  date: "次回日付"
});
const SIDE_LABELS = Object.freeze({ od: "右眼", os: "左眼" });

// 前回と今回の差分。再診で「変わった所」を一目で見せるための一覧を返す。
export function diffEncounterContent(previousContent = {}, currentContent = {}) {
  const before = validateEncounterContent(previousContent);
  const after = validateEncounterContent(currentContent);
  const changes = [];
  // 主訴や測定値は毎回入力し直す項目なので、今回まだ空欄なら「変更」には数えない。
  const push = (path, label, oldValue, newValue, { perVisit = false } = {}) => {
    if (perVisit && (newValue === "" || newValue === null || newValue === undefined || (Array.isArray(newValue) && newValue.length === 0))) return;
    if (stableJson(oldValue) !== stableJson(newValue)) {
      changes.push({ path, label, before: displayValue(oldValue), after: displayValue(newValue) });
    }
  };

  for (const key of ["chiefComplaint", "history"]) {
    push(key, FIELD_LABELS[key], before[key], after[key], { perVisit: true });
  }
  for (const key of ["assessment", "plan"]) {
    push(key, FIELD_LABELS[key], before[key], after[key]);
  }
  for (const side of EYE_SIDES) {
    for (const key of ["vaUncorrected", "vaCorrected", "iop"]) {
      push(`exam.${side}.${key}`, `${SIDE_LABELS[side]} ${FIELD_LABELS[key]}`, before.exam[side][key], after.exam[side][key], { perVisit: true });
    }
    for (const key of ["anterior", "lens", "fundus"]) {
      push(`findings.${side}.${key}`, `${SIDE_LABELS[side]} ${FIELD_LABELS[key]}`, before.findings[side][key], after.findings[side][key]);
    }
  }
  push("diagnoses", "病名", before.diagnoses.map(diagnosisLabel), after.diagnoses.map(diagnosisLabel), { perVisit: after.diagnoses.length === 0 });
  push("prescriptions", "処方", before.prescriptions.map(prescriptionLabel), after.prescriptions.map(prescriptionLabel));
  push("nextVisit.intervalWeeks", FIELD_LABELS.intervalWeeks, before.nextVisit.intervalWeeks, after.nextVisit.intervalWeeks);
  push("sketches", "シェーマ", before.sketches.map((sketch) => sketch.strokes.length), after.sketches.map((sketch) => sketch.strokes.length));
  return changes;
}

// 経過ビュー用の時系列。確定済みのカルテだけを使う。
export function buildTrend(encounters = []) {
  const finalized = sortByDate(encounters.filter((encounter) => encounter.status === "finalized"));
  const points = finalized.map((encounter) => {
    const exam = encounter.content?.exam || {};
    return {
      encounterId: encounter.encounterId,
      encounterDate: encounter.encounterDate,
      ...Object.fromEntries(EYE_SIDES.map((side) => {
        const corrected = parseVisualAcuity(exam[side]?.vaCorrected);
        const uncorrected = parseVisualAcuity(exam[side]?.vaUncorrected);
        const best = corrected.decimal ?? uncorrected.decimal;
        return [side, {
          va: best,
          vaLabel: corrected.label || uncorrected.label,
          iop: Number.isFinite(exam[side]?.iop) ? exam[side].iop : null
        }];
      }))
    };
  });

  const medicationEvents = [];
  let previous = new Map();
  for (const encounter of finalized) {
    const current = new Map((encounter.content?.prescriptions || [])
      .filter((item) => item.kind === "eye_drop" || item.kind === "eye_ointment")
      .map((item) => [medicationKey(item), item]));
    for (const [key, item] of current) {
      if (!previous.has(key)) medicationEvents.push({ encounterDate: encounter.encounterDate, type: "started", label: prescriptionLabel(item) });
    }
    for (const [key, item] of previous) {
      if (!current.has(key)) medicationEvents.push({ encounterDate: encounter.encounterDate, type: "stopped", label: prescriptionLabel(item) });
    }
    previous = current;
  }

  const injections = finalized.flatMap((encounter) => (encounter.content?.prescriptions || [])
    .filter((item) => item.kind === "injection")
    .map((item) => ({ encounterDate: encounter.encounterDate, label: prescriptionLabel(item) })));

  return { points, medicationEvents, injections };
}

export function prescriptionLabel(item = {}) {
  const details = [
    item.eye ? `${{ od: "右", os: "左", ou: "両" }[item.eye]}眼` : "",
    item.timesPerDay ? `1日${item.timesPerDay}回` : "",
    item.quantity ? `${item.quantity}${item.unit || ""}` : ""
  ].filter(Boolean);
  return details.length > 0 ? `${item.name}（${details.join(" ")}）` : String(item.name || "");
}

function diagnosisLabel(diagnosis = {}) {
  const eye = { od: "右眼", os: "左眼", ou: "両眼" }[diagnosis.eye] || "";
  const suffix = diagnosis.status === "suspected" ? "（疑い）" : diagnosis.status === "resolved" ? "（治癒）" : "";
  return `${eye ? `${eye} ` : ""}${diagnosis.name}${suffix}`;
}

function medicationKey(item) {
  return `${item.name}|${item.eye || ""}|${item.timesPerDay || ""}`;
}

export function sortByDate(encounters) {
  return [...encounters].sort((left, right) => (
    String(left.encounterDate).localeCompare(String(right.encounterDate))
    || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
  ));
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join("、");
  if (value === null || value === undefined) return "";
  return String(value);
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

// 確定前のチェック。blockers があると確定できない。warnings は確認を促すだけ。
// 画面の事前表示とサーバーの判定で同じ関数を使う。
export function evaluateFinalizeReadiness(content = {}) {
  const blockers = [];
  const warnings = [];
  (content.diagnoses || []).forEach((item, index) => {
    if (!String(item.name || "").trim()) blockers.push({ code: "diagnosis_name_missing", field: `content.diagnoses.${index}.name`, message: "病名が空の行があります。" });
  });
  (content.prescriptions || []).forEach((item, index) => {
    if (!String(item.name || "").trim()) blockers.push({ code: "prescription_name_missing", field: `content.prescriptions.${index}.name`, message: "薬剤名が空の処方があります。" });
    else if ((item.kind === "eye_drop" || item.kind === "eye_ointment") && !item.eye) blockers.push({ code: "prescription_eye_missing", field: `content.prescriptions.${index}.eye`, message: `「${item.name}」の眼（右・左・両）が未指定です。` });
  });
  if (!String(content.chiefComplaint || "").trim()) warnings.push({ code: "chief_complaint_empty", message: "主訴が空です。" });
  if (!String(content.plan || "").trim()) warnings.push({ code: "plan_empty", message: "方針が空です。" });
  if ((content.prescriptions || []).length > 0 && !content.nextVisit?.intervalWeeks && !content.nextVisit?.date) {
    warnings.push({ code: "next_visit_missing", message: "処方がありますが、次回受診が未設定です。" });
  }
  return { blockers, warnings };
}
