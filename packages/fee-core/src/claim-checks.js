// レセ点検(算定もれ等)の決定論ルール。
// 入力は「正規化済みclaim」(当社算定の明細でも、既存レセの明細でも同じ形)にし、
// 出力は共通 Finding。Finding は findingToReviewIssue で halunasu の reviewIssue へ変換して
// 既存の月次点検/レビュー導線に載せる。ロジックは recept-checker(r10 算定もれ)を移植した決定論規則。

// 検査判断料のグループ番号 → 名称(基本マスター 検査等実施判断グループ)。
const KENSA_HANTEI_GROUP_NAMES = Object.freeze({
  "1": "尿・糞便等検査判断料",
  "2": "血液学的検査判断料",
  "3": "生化学的検査(I)判断料",
  "4": "生化学的検査(II)判断料",
  "5": "免疫学的検査判断料",
  "6": "微生物学的検査判断料",
  "17": "遺伝子関連・染色体検査判断料"
});

// 尿中一般物質定性半定量検査(D000)。これ「のみ」の場合は尿・糞便等検査判断料を算定できない。
const D000_URINE_CODE = "160000310";
const NON_DISEASE_CODES = new Set(["0000000", "0000001", "0000002", "0000003"]);
const ORAL_SHINRYO_SHIKIBETSU = new Set(["21", "22"]);
const INJECTION_SHINRYO_SHIKIBETSU = new Set(["31", "32", "33"]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumberOrNull(value) {
  const number = numericOrNull(value);
  return number != null && number > 0 ? number : null;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

function normalizeItems(claim = {}) {
  const items = Array.isArray(claim.items) ? claim.items : [];
  return items
    .map((item) => ({
      code: String(item.code || "").trim(),
      lineId: String(firstDefined(item.lineId, item.line_id, item.orderId, item.order_id) || "").trim(),
      name: String(item.name || "").trim(),
      orderType: String(item.orderType || "").trim(),
      recType: String(item.recType || "").trim(),
      judgementKind: String(item.judgementKind || "").trim(),
      judgementGroup: String(item.judgementGroup || "").trim().replace(/^0+/u, ""),
      quantity: numericOrNull(firstDefined(item.quantity, item.count, item.usageQuantity, item.usage_quantity)),
      quantityPerDay: numericOrNull(firstDefined(item.quantityPerDay, item.quantity_per_day, item.dailyQuantity, item.daily_quantity)),
      doseQuantity: numericOrNull(firstDefined(item.doseQuantity, item.dose_quantity)),
      dosesPerDay: numericOrNull(firstDefined(item.dosesPerDay, item.doses_per_day)),
      totalQuantity: numericOrNull(firstDefined(item.totalQuantity, item.total_quantity)),
      days: numericOrNull(firstDefined(item.days, item.daysSupply, item.days_supply, item.administrationDays, item.administration_days)),
      dispensingKind: normalizeString(firstDefined(item.dispensingKind, item.dispensing_kind)),
      shinryoShikibetsu: normalizeString(firstDefined(item.shinryoShikibetsu, item.shinryo_shikibetsu, item.billingCategory, item.billing_category)),
      unit: normalizeString(item.unit)
    }))
    .filter((item) => item.code || item.name);
}

// MI-002: 検体検査を実施しているのに、対応する検体検査判断料が算定されていない。
function checkKensaHanteiRyo(items) {
  const performedGroups = new Map(); // group -> [検査名]
  const billedGroups = new Set();
  const group1Codes = new Set();

  for (const item of items) {
    const group = item.judgementGroup;
    if (item.judgementKind === "1" && group) {
      if (!performedGroups.has(group)) {
        performedGroups.set(group, []);
      }
      performedGroups.get(group).push(item.name || item.code);
      if (group === "1") {
        group1Codes.add(item.code);
      }
    }
    // 判断料そのものの明細(検査等実施判断区分=2)、または名称が「判断料」を含む行は算定済みとみなす。
    if ((item.judgementKind === "2" && group) || /判断料/u.test(item.name)) {
      if (group) {
        billedGroups.add(group);
      }
      const named = Object.entries(KENSA_HANTEI_GROUP_NAMES).find(([, name]) => name === item.name);
      if (named) {
        billedGroups.add(named[0]);
      }
    }
  }

  const findings = [];
  for (const [group, names] of performedGroups.entries()) {
    if (billedGroups.has(group)) {
      continue;
    }
    const hanteiName = KENSA_HANTEI_GROUP_NAMES[group];
    if (!hanteiName) {
      continue;
    }
    // 例外: 尿一般(D000)のみの場合、尿・糞便等検査判断料は算定不可。
    if (group === "1" && group1Codes.size > 0 && [...group1Codes].every((code) => code === D000_URINE_CODE)) {
      continue;
    }
    findings.push({
      ruleId: "MI-002",
      ruleName: "検体検査判断料の算定もれ",
      category: "算定もれ",
      severity: "info",
      target: hanteiName,
      message: `${hanteiName}の算定もれの可能性があります`,
      detail: `実施済みの検査: ${names.slice(0, 5).join("、")}`,
      suggestion: "検体検査判断料は区分ごとに月1回算定できます。算定要件を満たしていれば算定してください（算定もれは収益の損失です）。※生活習慣病管理料(I)算定患者は検査が包括されるため算定不可。"
    });
  }
  return findings;
}

// MI-003: 外来レセに初診料・再診料・外来診療料のいずれもない。
// 訪問診療/往診(home_visit/house_call)は基本診療料が訪問診療料等に置き換わるため対象外。
function checkNoBaseVisitFee(claim, items) {
  if (claim.isInpatient || !items.length) {
    return [];
  }
  if (["home_visit", "house_call"].includes(String(claim.encounterSetting || ""))) {
    return [];
  }
  const hasBase = items.some((item) => item.orderType === "basic");
  if (hasBase) {
    return [];
  }
  return [{
    ruleId: "MI-003",
    ruleName: "基本診療料のないレセプト",
    category: "算定もれ",
    severity: "warning",
    target: "基本診療料",
    message: "初診料・再診料・外来診療料のいずれも算定されていません",
    detail: "",
    suggestion: "基本診療料の記録漏れがないか確認してください（電話再診等の算定漏れの可能性もあります）。"
  }];
}

// MI-004: 投薬があるのに処方料・処方箋料がない。
function checkNoPrescriptionFee(claim, items) {
  if (claim.isInpatient) {
    return []; // 入院は処方料の概念が異なる
  }
  const hasDrug = items.some((item) => item.orderType === "drug" || item.recType === "IY");
  if (!hasDrug) {
    return [];
  }
  const hasPrescriptionFee = items.some((item) => /処方料|処方箋料/u.test(item.name));
  if (hasPrescriptionFee) {
    return [];
  }
  return [{
    ruleId: "MI-004",
    ruleName: "処方料・処方箋料の算定もれ",
    category: "算定もれ",
    severity: "info",
    target: "処方料・処方箋料",
    message: "投薬があるのに処方料・処方箋料が算定されていません",
    detail: "",
    suggestion: "院内処方であれば処方料、院外処方であれば処方箋料の算定漏れがないか確認してください。"
  }];
}

// 算定もれ点検の本体。正規化claimを受け取り Finding[] を返す(純関数)。
export function buildMissingBillingFindings(claim = {}) {
  const items = normalizeItems(claim);
  return [
    ...checkKensaHanteiRyo(items),
    ...checkNoBaseVisitFee(claim, items),
    ...checkNoPrescriptionFee(claim, items)
  ];
}

// ---------------------------------------------------------------------------
// 適応/禁忌/併用点検(C)。判定に必要なマスタは lookup(checkLookupの戻り)で注入する。
// lookup = { drugIndications:{code:[{diseaseCode,sex,ageMin,ageMax}]},
//            drugContraDiseases:{code:[diseaseCode]}, drugInteractions:[[a,b]],
//            actIndications:{code:[{diseaseCode,sex,ageMin,ageMax,nyugai,utagai}]},
//            diseaseNames:{code:name} }
// ロジックは recept-checker(r04 医薬品適応 / r07 併用禁忌 / r05 診療行為適応)を移植。
// ---------------------------------------------------------------------------

function normalizeDiseases(claim = {}) {
  const diseases = Array.isArray(claim.diseases) ? claim.diseases : [];
  return diseases
    .map((d) => ({
      code: String(d.code || "").trim(),
      name: String(d.name || "").trim(),
      suspected: Boolean(d.suspected)
    }))
    .filter((d) => d.code || d.name);
}

function sexMatches(ruleSex, patientSex) {
  const rule = String(ruleSex || "").trim();
  if (!rule || rule === "0" || rule === "3") {
    return true; // 制限なし
  }
  return rule === String(patientSex || "").trim();
}

function ageMatches(ageMin, ageMax, ageYears) {
  if (ageYears == null) {
    return true; // 年齢不明なら制限で落とさない
  }
  const min = Number.isFinite(Number(ageMin)) ? Number(ageMin) : null;
  const max = Number.isFinite(Number(ageMax)) ? Number(ageMax) : null;
  if (min != null && min > 0 && ageYears < min) {
    return false;
  }
  if (max != null && max > 0 && max < 999 && ageYears > max) {
    return false;
  }
  return true;
}

function diseaseNameFor(lookup, code) {
  return (lookup?.diseaseNames || {})[code] || code;
}

// IY-001 医薬品の適応病名なし / 疑い病名のみ
function checkDrugIndication(claim, items, lookup) {
  const findings = [];
  const diseases = normalizeDiseases(claim);
  const diseaseCodes = new Set(diseases.map((d) => d.code).filter(Boolean));
  const suspectedCodes = new Set(diseases.filter((d) => d.suspected).map((d) => d.code).filter(Boolean));
  const drugs = items.filter((it) => it.orderType === "drug" || it.recType === "IY");
  const seen = new Set();
  for (const drug of drugs) {
    if (!drug.code || seen.has(drug.code)) {
      continue;
    }
    seen.add(drug.code);
    const rows = (lookup?.drugIndications || {})[drug.code];
    if (!Array.isArray(rows) || rows.length === 0) {
      continue; // 公的な適応データが無い薬は指摘しない(過剰検知の防止)
    }
    const applicable = rows.filter((r) => sexMatches(r.sex, claim.sex) && ageMatches(r.ageMin, r.ageMax, claim.ageYears));
    if (applicable.length === 0) {
      findings.push({
        ruleId: "IY-001", ruleName: "医薬品の適応(性別・年齢)", category: "医薬品適応",
        severity: "warning", target: drug.name || drug.code, code: drug.code,
        message: `医薬品「${drug.name || drug.code}」は患者の性別・年齢に該当する適応がありません`,
        detail: "支払基金チェックマスタ(添付文書ベース)。",
        suggestion: "投与対象(性別・年齢)を確認してください。"
      });
      continue;
    }
    const allowed = new Set(applicable.map((r) => r.diseaseCode).filter(Boolean));
    const hit = [...allowed].filter((code) => diseaseCodes.has(code));
    if (hit.length > 0) {
      // 適応病名はあるが「疑い」しかない場合はINFOで案内(検査は疑い可・治療は確定病名)
      if (hit.every((code) => suspectedCodes.has(code))) {
        findings.push({
          ruleId: "IY-001", ruleName: "医薬品の適応が疑い病名のみ", category: "医薬品適応",
          severity: "info", target: drug.name || drug.code, code: drug.code,
          message: `医薬品「${drug.name || drug.code}」の適応病名が「疑い」病名しかありません`,
          detail: "", suggestion: "疑い病名に対する治療薬の投与は査定対象になり得ます。確定病名の記録を検討してください（検査は疑い病名で可、治療は原則確定病名）。"
        });
      }
      continue;
    }
    const candidates = [...allowed].slice(0, 5).map((code) => diseaseNameFor(lookup, code)).filter(Boolean);
    findings.push({
      ruleId: "IY-001", ruleName: "医薬品の適応病名なし", category: "医薬品適応",
      severity: "warning", target: drug.name || drug.code, code: drug.code,
      message: `医薬品「${drug.name || drug.code}」に対応する適応傷病名が記録されていません`,
      detail: candidates.length ? `適応病名の候補例: ${candidates.join("、")}` : "支払基金チェックマスタに適応傷病名の定義があります。",
      suggestion: "診療実態に合う適応病名を記録するか、投与理由を摘要欄に記載してください。病名もれはA査定・突合点検の最多要因です。"
    });
  }
  return findings;
}

// IY-003 禁忌傷病名への投与
function checkDrugContraindication(claim, items, lookup) {
  const findings = [];
  const diseaseCodes = new Set(normalizeDiseases(claim).map((d) => d.code).filter(Boolean));
  if (diseaseCodes.size === 0) {
    return findings;
  }
  const drugs = items.filter((it) => it.orderType === "drug" || it.recType === "IY");
  const seen = new Set();
  for (const drug of drugs) {
    if (!drug.code || seen.has(drug.code)) {
      continue;
    }
    seen.add(drug.code);
    const contra = (lookup?.drugContraDiseases || {})[drug.code];
    if (!Array.isArray(contra) || contra.length === 0) {
      continue;
    }
    for (const code of contra) {
      if (diseaseCodes.has(code)) {
        findings.push({
          ruleId: "IY-003", ruleName: "禁忌傷病名への投与", category: "医薬品適応",
          severity: "error", target: drug.name || drug.code, code: drug.code,
          message: `医薬品「${drug.name || drug.code}」の禁忌傷病名「${diseaseNameFor(lookup, code)}」が記録されています`,
          detail: "支払基金チェックマスタ(添付文書ベース)の禁忌傷病名に該当します。",
          suggestion: "投与の可否を確認してください。医学的必要性がある場合は症状詳記での説明が必要です。"
        });
      }
    }
  }
  return findings;
}

// IY-004 併用禁忌
function checkDrugInteraction(claim, items, lookup) {
  const pairs = Array.isArray(lookup?.drugInteractions) ? lookup.drugInteractions : [];
  if (pairs.length === 0) {
    return [];
  }
  // lookup.drugInteractions は複数claim分をまとめて引いた全ペアを含みうるため、
  // 「両方の薬剤がこのclaimに存在する」ペアだけを指摘する。
  const drugCodes = new Set(
    items.filter((it) => it.orderType === "drug" || it.recType === "IY").map((it) => it.code).filter(Boolean)
  );
  const nameByCode = new Map(items.map((it) => [it.code, it.name || it.code]));
  return pairs.filter(([a, b]) => drugCodes.has(a) && drugCodes.has(b)).map(([a, b]) => ({
    ruleId: "IY-004", ruleName: "併用禁忌", category: "医薬品適応",
    severity: "error", target: `${nameByCode.get(a) || a} × ${nameByCode.get(b) || b}`,
    message: `併用禁忌の組み合わせが投与されています: 「${nameByCode.get(a) || a}」と「${nameByCode.get(b) || b}」`,
    detail: "支払基金チェックマスタ(併用禁忌)。",
    suggestion: "併用の可否を確認してください。医学的必要性がある場合は症状詳記での説明が必要です。"
  }));
}

// SI-001 診療行為の適応病名なし
function checkActIndication(claim, items, lookup) {
  const findings = [];
  const diseases = normalizeDiseases(claim);
  const diseaseCodes = new Set(diseases.map((d) => d.code).filter(Boolean));
  const nonSuspectedCodes = new Set(diseases.filter((d) => !d.suspected).map((d) => d.code).filter(Boolean));
  const acts = items.filter((it) => it.orderType === "procedure" || it.recType === "SI");
  const seen = new Set();
  for (const act of acts) {
    if (!act.code || seen.has(act.code)) {
      continue;
    }
    seen.add(act.code);
    const rows = (lookup?.actIndications || {})[act.code];
    if (!Array.isArray(rows) || rows.length === 0) {
      continue; // 適応データが無い診療行為は指摘しない
    }
    const applicable = rows.filter((r) => sexMatches(r.sex, claim.sex) && ageMatches(r.ageMin, r.ageMax, claim.ageYears));
    if (applicable.length === 0) {
      continue;
    }
    // utagai=1 の行は疑い病名でも可。utagai!=1 の行は確定病名が要る。
    const allowedWithSuspect = new Set(applicable.filter((r) => String(r.utagai) === "1").map((r) => r.diseaseCode));
    const allowedConfirmedOnly = new Set(applicable.filter((r) => String(r.utagai) !== "1").map((r) => r.diseaseCode));
    const suspectOk = [...allowedWithSuspect].some((code) => diseaseCodes.has(code));
    const confirmedOk = [...allowedConfirmedOnly].some((code) => nonSuspectedCodes.has(code));
    if (suspectOk || confirmedOk) {
      continue;
    }
    const candidates = [...new Set([...allowedWithSuspect, ...allowedConfirmedOnly])]
      .slice(0, 5).map((code) => diseaseNameFor(lookup, code)).filter(Boolean);
    findings.push({
      ruleId: "SI-001", ruleName: "診療行為の適応病名なし", category: "診療行為適応",
      severity: "warning", target: act.name || act.code, code: act.code,
      message: `「${act.name || act.code}」に対応する適応傷病名が記録されていません`,
      detail: candidates.length ? `適応病名の候補例: ${candidates.join("、")}` : "支払基金チェックマスタに適応傷病名の定義があります。",
      suggestion: "適応病名を記録するか、実施理由を摘要欄に記載してください。"
    });
  }
  return findings;
}

function drugItems(items) {
  return items.filter((it) => it.orderType === "drug" || it.recType === "IY");
}

function itemDailyQuantity(item = {}) {
  const perDay = positiveNumberOrNull(item.quantityPerDay);
  if (perDay != null) {
    return perDay;
  }
  const dose = positiveNumberOrNull(item.doseQuantity);
  const times = positiveNumberOrNull(item.dosesPerDay);
  if (dose != null && times != null) {
    return dose * times;
  }

  // レセ電由来で診療識別が明示されている場合のみ、使用量を1日量として扱う。
  // 通常のlineItems.quantityは「算定数量」のことがあるため、識別なしでは用量判定に使わない。
  const shikibetsu = String(item.shinryoShikibetsu || "").trim();
  if (ORAL_SHINRYO_SHIKIBETSU.has(shikibetsu) || INJECTION_SHINRYO_SHIKIBETSU.has(shikibetsu)) {
    return positiveNumberOrNull(item.quantity);
  }
  return null;
}

function itemPrescriptionDays(item = {}) {
  return positiveNumberOrNull(item.days);
}

function diseaseCodesForClaim(claim = {}) {
  return new Set(normalizeDiseases(claim).map((d) => d.code).filter(Boolean));
}

function rowDiseaseApplies(row = {}, diseaseCodes = new Set()) {
  const code = String(row.diseaseCode || "").trim();
  return !code || NON_DISEASE_CODES.has(code) || diseaseCodes.has(code);
}

function applicableDoseRules(rows = [], claim = {}, diseaseCodes = new Set()) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const kubun = String(row.checkKubun || "").trim();
    return (!kubun || kubun === "1" || kubun === "2")
      && sexMatches(row.sex, claim.sex)
      && ageMatches(row.ageMin, row.ageMax, claim.ageYears)
      && rowDiseaseApplies(row, diseaseCodes);
  });
}

function doseUnitFor(item = {}, rows = []) {
  const unit = String(item.unit || "").trim();
  if (unit) {
    return unit;
  }
  const ref = rows.map((row) => String(row.refRange || "").trim()).find(Boolean);
  return ref || "";
}

function checkDrugDailyDose(claim, items, lookup) {
  const findings = [];
  const diseaseCodes = diseaseCodesForClaim(claim);
  const byCode = new Map();
  for (const drug of drugItems(items)) {
    if (!drug.code) {
      continue;
    }
    const daily = itemDailyQuantity(drug);
    if (daily == null) {
      continue;
    }
    const entry = byCode.get(drug.code) || {
      code: drug.code,
      name: drug.name || drug.code,
      totalDaily: 0,
      items: []
    };
    entry.totalDaily += daily;
    if (drug.name && !entry.name) {
      entry.name = drug.name;
    }
    entry.items.push(drug);
    byCode.set(drug.code, entry);
  }

  for (const entry of byCode.values()) {
    const applicable = applicableDoseRules((lookup?.drugDoseRules || {})[entry.code], claim, diseaseCodes)
      .filter((row) => positiveNumberOrNull(row.maxDose) != null && positiveNumberOrNull(row.maxDose) < 99999);
    if (applicable.length === 0) {
      continue;
    }
    // 複数条件が該当する場合は最も緩い上限を採用し、過剰検知を避ける。
    const limit = Math.max(...applicable.map((row) => positiveNumberOrNull(row.maxDose)).filter((value) => value != null));
    if (!Number.isFinite(limit) || entry.totalDaily <= limit) {
      continue;
    }
    const tekigi = applicable.some((row) => String(row.tekigi || "") === "01");
    const unit = doseUnitFor(entry.items[0], applicable);
    const suffix = unit ? unit : "";
    findings.push({
      ruleId: "IY-002",
      ruleName: "薬剤用量の確認",
      category: "用量・日数",
      severity: tekigi ? "info" : "warning",
      target: entry.name || entry.code,
      code: entry.code,
      message: `医薬品「${entry.name || entry.code}」の1日量 ${formatQuantity(entry.totalDaily)}${suffix} が公式チェック上限 ${formatQuantity(limit)}${suffix} を超えています`,
      detail: tekigi
        ? "支払基金チェックマスタの最大投与量を超えています。添付文書上「適宜増減」の記載があるため、投与理由を確認してください。"
        : "支払基金チェックマスタの最大投与量を超えています。",
      suggestion: "投与量・体重・腎機能・増量理由を確認してください。医学的必要性がある場合は症状詳記またはコメントで説明してください。"
    });
  }
  return findings;
}

function checkDrugDaysLimit(claim, items, lookup) {
  const findings = [];
  const diseaseCodes = diseaseCodesForClaim(claim);
  for (const drug of drugItems(items)) {
    if (!drug.code) {
      continue;
    }
    const days = itemPrescriptionDays(drug);
    if (days == null) {
      continue;
    }
    const applicable = applicableDoseRules((lookup?.drugDoseRules || {})[drug.code], claim, diseaseCodes)
      .filter((row) => positiveNumberOrNull(row.maxDays) != null && positiveNumberOrNull(row.maxDays) < 999);
    if (applicable.length === 0) {
      continue;
    }
    const limit = Math.max(...applicable.map((row) => positiveNumberOrNull(row.maxDays)).filter((value) => value != null));
    if (!Number.isFinite(limit) || days <= limit) {
      continue;
    }
    findings.push({
      ruleId: "IY-002",
      ruleName: "投与日数の確認",
      category: "用量・日数",
      severity: "warning",
      target: drug.name || drug.code,
      code: drug.code,
      message: `医薬品「${drug.name || drug.code}」が${formatQuantity(days)}日分処方されています。公式チェック上限は${formatQuantity(limit)}日です`,
      detail: "支払基金チェックマスタの最長投与日数を超えています。",
      suggestion: "投与日数制限を確認してください。長期投与が妥当な場合は理由を摘要欄・症状詳記で説明してください。"
    });
  }
  return findings;
}

function applicableDoseGroups(rows = [], claim = {}, diseaseCodes = new Set()) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const flag = String(row.targetFlag || "").trim();
    return (flag === "2" || flag === "3")
      && sexMatches(row.sex, claim.sex)
      && ageMatches(row.ageMin, row.ageMax, claim.ageYears)
      && rowDiseaseApplies(row, diseaseCodes)
      && String(row.groupName || "").trim()
      && positiveNumberOrNull(row.ingredientAmount) != null
      && positiveNumberOrNull(row.maxDose) != null
      && positiveNumberOrNull(row.maxDose) < 99999999;
  });
}

function checkDrugDoseGroups(claim, items, lookup) {
  const diseaseCodes = diseaseCodesForClaim(claim);
  const groups = new Map();
  for (const drug of drugItems(items)) {
    if (!drug.code) {
      continue;
    }
    const daily = itemDailyQuantity(drug);
    if (daily == null) {
      continue;
    }
    const rows = applicableDoseGroups((lookup?.drugDoseGroups || {})[drug.code], claim, diseaseCodes);
    for (const row of rows) {
      const groupName = String(row.groupName || "").trim();
      const unit = String(row.unit || "").trim();
      const key = `${groupName}\u0000${unit}`;
      const ingredientAmount = positiveNumberOrNull(row.ingredientAmount);
      const maxDose = positiveNumberOrNull(row.maxDose);
      const entry = groups.get(key) || {
        groupName,
        unit,
        total: 0,
        limit: maxDose,
        drugs: new Set(),
        counted: new Set()
      };
      const countKey = drug.lineId || `${drug.code}\u0000${drug.name}\u0000${daily}\u0000${entry.counted.size}`;
      if (entry.counted.has(countKey)) {
        groups.set(key, entry);
        continue;
      }
      entry.counted.add(countKey);
      entry.total += daily * ingredientAmount;
      entry.limit = Math.max(entry.limit, maxDose);
      entry.drugs.add(drug.name || drug.code);
      groups.set(key, entry);
    }
  }
  const findings = [];
  for (const group of groups.values()) {
    if (group.total <= group.limit) {
      continue;
    }
    const suffix = group.unit || "";
    findings.push({
      ruleId: "IY-002",
      ruleName: "同一成分用量の確認",
      category: "用量・日数",
      severity: "warning",
      target: [...group.drugs].sort().join("、"),
      message: `${group.groupName}の1日合算量 ${formatQuantity(group.total)}${suffix} が公式チェック上限 ${formatQuantity(group.limit)}${suffix} を超えています`,
      detail: "支払基金チェックマスタの投与量グループに基づき、同一成分・同一薬効グループを合算して確認しています。",
      suggestion: "重複処方・同一成分の合算過量がないか確認してください。医学的必要性がある場合は理由を記録してください。"
    });
  }
  return findings;
}

function checkDrugDosage(claim, items, lookup) {
  return [
    ...checkDrugDailyDose(claim, items, lookup),
    ...checkDrugDaysLimit(claim, items, lookup),
    ...checkDrugDoseGroups(claim, items, lookup)
  ];
}

// 適応/禁忌/併用点検の本体。lookup(checkLookupの戻り)を注入して Finding[] を返す。
export function buildIndicationFindings(claim = {}, lookup = {}) {
  const items = normalizeItems(claim);
  return [
    ...checkDrugIndication(claim, items, lookup),
    ...checkDrugDosage(claim, items, lookup),
    ...checkDrugContraindication(claim, items, lookup),
    ...checkDrugInteraction(claim, items, lookup),
    ...checkActIndication(claim, items, lookup)
  ];
}

export function buildIndicationReviewIssues(claim = {}, lookup = {}) {
  return buildIndicationFindings(claim, lookup).map(findingToReviewIssue);
}

// 点検で参照が要るコード(薬剤/診療行為/病名)を claim から抽出。fee-api が checkLookup へ渡す。
export function claimCheckLookupCodes(claim = {}) {
  const items = normalizeItems(claim);
  return {
    drug_codes: [...new Set(items.filter((it) => it.orderType === "drug" || it.recType === "IY").map((it) => it.code).filter(Boolean))],
    act_codes: [...new Set(items.filter((it) => it.orderType === "procedure" || it.recType === "SI").map((it) => it.code).filter(Boolean))],
    disease_codes: [...new Set(normalizeDiseases(claim).map((d) => d.code).filter(Boolean))]
  };
}

function stableFindingKey(finding = {}) {
  return [finding.ruleId, finding.target, finding.message]
    .map((part) => String(part || "").trim().replace(/\s+/gu, "_"))
    .join("__")
    .slice(0, 120);
}

const FINDING_SEVERITY_TO_REVIEW = Object.freeze({ error: "warning", warning: "warning", info: "info" });

// 共通 Finding を halunasu の reviewIssue 形へ変換する。
export function findingToReviewIssue(finding = {}) {
  const severity = FINDING_SEVERITY_TO_REVIEW[finding.severity] || "warning";
  return {
    reviewIssueId: `claim_check_${finding.ruleId || "rule"}_${stableFindingKey(finding)}`,
    issueCode: `claim_check_${String(finding.ruleId || "").toLowerCase().replace(/[^0-9a-z]+/gu, "_")}`,
    topicCode: finding.category === "算定もれ" ? "billing_miss" : "claim_check",
    topicLabel: finding.category || "点検",
    severity,
    title: finding.ruleName || "点検指摘",
    messageForStaff: finding.message || "",
    detail: finding.detail || "",
    suggestion: finding.suggestion || "",
    requiredInput: "算定要件、カルテ根拠",
    source: "claim_check", // 決定論点検(recept-checker移植ルール)由来
    ruleId: finding.ruleId || "",
    ruleName: finding.ruleName || "",
    target: finding.target || "",
    resolutionOptions: [
      { value: "will_add", label: "算定を追加する" },
      { value: "not_applicable", label: "算定要件を満たさない" },
      { value: "chart_supports", label: "カルテ根拠を確認済み" }
    ]
  };
}

// claim → reviewIssue[] のワンショット。fee-api/月次点検/baseline-diff から共通利用する。
export function buildMissingBillingReviewIssues(claim = {}) {
  return buildMissingBillingFindings(claim).map(findingToReviewIssue);
}
