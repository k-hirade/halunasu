// 過去カルテから今日のカルテへの複写（デジカルの「列の[複写]」「束を押す」、トプコンのドラッグ＆ドロップ）。
// 決まり（眼科で変えたところ）
// - 主訴・所見の自由記載・眼別の所見・方針は「今回が空の欄にだけ」入れる（書きかけの文に足すと矛盾した文が並ぶため）。
// - 処方は同じ薬（薬剤名＋眼）を重ねない。写した処方は「前回からの引き継ぎ」（確認前）として入る。
// - オーダーは新しい予定として入れる（実施の記録は写さない）。同じ項目・同じ眼が今日すでにあれば重ねない。
// - Rp は今日のカルテの中で新しい rpId に振り直す（同じ Rp を 2 回入れても混ざらないように）。
// - シェーマは最大 8 枚。

const SIDES = ["od", "os"];
const COPYABLE_FINDING_KEYS = ["anterior", "lens", "fundus", "other"];
const MAX_SKETCHES = 8;

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function setFinding(content, side, key, value) {
  return { ...content, findings: { ...content.findings, [side]: { ...content.findings[side], [key]: value } } };
}

function rekeyer() {
  const base = stamp();
  const ids = new Map();
  return (row) => {
    if (!row.rpId) return { ...row };
    if (!ids.has(row.rpId)) ids.set(row.rpId, `rp_${base}_${ids.size}`);
    return { ...row, rpId: ids.get(row.rpId) };
  };
}

const rxKey = (row) => `${row.name}|${row.eye || ""}`;
const orderKey = (row) => `${row.procedureCode || row.code || row.name}|${row.eye || ""}`;

// 処方の行（コメント行を含む）を足す。legacy（rpId の無い行）は 1 行 1 Rp のまま。
function addPrescriptions(current, sourceRows, notes) {
  const existing = new Set((current.prescriptions || []).filter((row) => row.kind !== "comment").map(rxKey));
  const items = sourceRows.filter((row) => row.kind !== "comment");
  const added = items.filter((row) => !existing.has(rxKey(row)));
  const rps = new Set(added.map((row) => row.rpId).filter(Boolean));
  const rows = sourceRows.filter((row) => added.includes(row) || (row.kind === "comment" && rps.has(row.rpId)));
  const rekey = rekeyer();
  if (added.length < items.length) notes.push("同じ処方はすでにあるため重ねていません。");
  return {
    content: {
      ...current,
      prescriptions: [...(current.prescriptions || []), ...rows.map((row) => (row.kind === "comment" ? rekey(row) : { ...rekey(row), carriedOver: true }))]
    },
    count: added.length
  };
}

function addOrders(current, sourceRows, notes) {
  const existing = new Set((current.orders || []).filter((row) => row.kind !== "comment" && row.status !== "cancelled").map(orderKey));
  const items = sourceRows.filter((row) => row.kind !== "comment" && row.status !== "cancelled");
  const added = items.filter((row) => !existing.has(orderKey(row)));
  const rps = new Set(added.map((row) => row.rpId).filter(Boolean));
  const rows = sourceRows.filter((row) => added.includes(row) || (row.kind === "comment" && rps.has(row.rpId)));
  const rekey = rekeyer();
  const base = stamp();
  if (added.length < items.length) notes.push("同じ検査・処置はすでにあるため重ねていません。");
  return {
    content: {
      ...current,
      orders: [...(current.orders || []), ...rows.map((row, index) => {
        const { statusChangedAt, statusChangedBy, sourceEncounterId, ...rest } = rekey(row);
        return row.kind === "comment"
          ? { ...rest, orderId: `ord_${base}${index}` }
          : { ...rest, orderId: `ord_${base}${index}`, status: "planned", statusChangedAt: "", statusChangedBy: null };
      })]
    },
    count: added.length
  };
}

function addSketches(current, sketches, { strokes = true } = {}) {
  const existing = new Set((current.sketches || []).map((sketch) => sketch.sketchId));
  const room = Math.max(0, MAX_SKETCHES - (current.sketches || []).length);
  const added = sketches
    .filter((sketch) => strokes ? !existing.has(sketch.sketchId) : true)
    .slice(0, room)
    .map((sketch, index) => (strokes ? { ...sketch } : { ...sketch, sketchId: `sk_${stamp()}${index}`, strokes: [] }));
  return { content: { ...current, sketches: [...(current.sketches || []), ...added] }, count: added.length, full: sketches.length > room };
}

// kind:
//   "left"   主訴・所見の列（自由記載・眼別所見・方針・シェーマ）
//   "right"  処置・行為の列（処方・オーダー）。Do はこれと同じ。
//   "all"    両方
//   "rx"     処方の Rp 1 つ（rows を渡す）
//   "orders" オーダーの Rp 1 つ（rows を渡す）
//   "sketch" シェーマ 1 枚（sketch を渡す。strokes=false で下絵だけ）
//   "text"   主訴・所見の自由記載だけ
export function applyCopy(current, source = {}, kind, payload = {}) {
  let next = current;
  const notes = [];
  let label = "";
  const left = () => {
    let skipped = 0;
    if (source.findingsText) {
      if (next.findingsText) skipped += 1;
      else next = { ...next, findingsText: source.findingsText };
    }
    for (const side of SIDES) {
      for (const key of COPYABLE_FINDING_KEYS) {
        const value = source.findings?.[side]?.[key];
        if (!value) continue;
        if (next.findings?.[side]?.[key]) {
          skipped += 1;
          continue;
        }
        next = setFinding(next, side, key, value);
      }
    }
    if (source.findings?.general) {
      if (next.findings?.general) skipped += 1;
      else next = { ...next, findings: { ...next.findings, general: source.findings.general } };
    }
    if (source.plan || source.assessment) {
      if (next.plan && source.plan) skipped += 1;
      next = { ...next, assessment: next.assessment || source.assessment || "", plan: next.plan || source.plan || "" };
    }
    if (skipped) notes.push(`入力済みの${skipped}項目はそのままにしました。`);
    const sketches = addSketches(next, source.sketches || []);
    next = sketches.content;
    if (sketches.full) notes.push("シェーマは 8 枚までです。");
  };
  const right = () => {
    next = addPrescriptions(next, source.prescriptions || [], notes).content;
    next = addOrders(next, source.orders || [], notes).content;
  };
  if (kind === "left") {
    left();
    label = "主訴・所見";
  } else if (kind === "right") {
    right();
    label = "処置・行為";
  } else if (kind === "all") {
    left();
    right();
    label = "主訴・所見と処置・行為";
  } else if (kind === "rx") {
    next = addPrescriptions(next, payload.rows || [], notes).content;
    label = "処方";
  } else if (kind === "orders") {
    next = addOrders(next, payload.rows || [], notes).content;
    label = "検査・処置";
  } else if (kind === "sketch") {
    const result = addSketches(next, payload.sketch ? [payload.sketch] : [], { strokes: payload.strokes !== false });
    next = result.content;
    if (!result.count) notes.push("シェーマは 8 枚までです。");
    label = payload.strokes === false ? "シェーマ（下絵）" : "シェーマ";
  } else if (kind === "text") {
    if (!source.findingsText) return { content: current, label: "主訴・所見", note: "" };
    if (next.findingsText) next = { ...next, findingsText: `${next.findingsText}${next.findingsText.endsWith("\n") ? "" : "\n"}${source.findingsText}` };
    else next = { ...next, findingsText: source.findingsText };
    label = "主訴・所見の自由記載";
  }
  return { content: next, label, note: notes.join("") };
}

// 処方・オーダーの Rp をそのまま今日のカルテへ入れる（学習リスト・セットから）。rpId は新しく振る。
export function appendRpRows(current, field, rows) {
  const rekey = rekeyer();
  const base = stamp();
  const mapped = rows.map((row, index) => {
    const keyed = rekey(row.rpId ? row : { ...row, rpId: "learn" });
    if (field === "orders") {
      const { statusChangedAt, statusChangedBy, sourceEncounterId, ...rest } = keyed;
      return row.kind === "comment" ? { ...rest, orderId: `ord_${base}${index}` } : { ...rest, orderId: `ord_${base}${index}`, status: "planned", note: rest.note || "" };
    }
    return keyed;
  });
  return { ...current, [field]: [...(current[field] || []), ...mapped] };
}
