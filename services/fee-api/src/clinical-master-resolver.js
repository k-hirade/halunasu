const CLINICAL_PROCEDURE_HINTS = Object.freeze([
  {
    key: "ca125",
    code: "160038010",
    label: "CA125",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:CA\s*125|CA125|ＣＡ１２５|癌抗原\s*125)/iu]
  },
  {
    key: "hba1c",
    code: "160010010",
    label: "HbA1c",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:HbA1c|ＨｂＡ１ｃ|ヘモグロビンA1c|ヘモグロビンＡ１ｃ)/iu]
  },
  {
    key: "glucose",
    code: "160019410",
    label: "グルコース",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:空腹時血糖|随時血糖|血糖値|血糖|グルコース)/u]
  },
  {
    key: "total_cholesterol",
    code: "160022410",
    label: "総コレステロール",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:総コレステロール|Tcho|Ｔｃｈｏ|TC\b|ＴＣ)/iu]
  },
  {
    key: "ldl_cholesterol",
    code: "160167250",
    label: "LDLコレステロール",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:LDL|ＬＤＬ|LDL[-－]?コレステロール|ＬＤＬ－コレステロール)/iu]
  },
  {
    key: "triglyceride",
    code: "160020910",
    label: "中性脂肪",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:中性脂肪|TG|ＴＧ|トリグリセライド)/iu]
  },
  {
    key: "creatinine",
    code: "160019210",
    label: "クレアチニン",
    collectionFeeInput: "blood_venous",
    patterns: [/(?:クレアチニン|eGFR|ｅＧＦＲ)/iu]
  },
  {
    key: "urine_albumin",
    code: "160004810",
    label: "尿アルブミン",
    patterns: [/(?:尿アルブミン|微量アルブミン尿|アルブミン定量)/u]
  },
  {
    key: "diabetes_complication_management",
    code: "113010010",
    label: "糖尿病合併症管理料",
    reviewMessage: "糖尿病合併症管理料を候補化しました。対象疾患、療養指導、記録・計画書などの算定条件を確認してください。",
    patterns: [/(?:糖尿病合併症管理料|糖尿病.*合併症.*管理|合併症管理料)/u]
  },
  {
    key: "lifestyle_diabetes_management_1",
    code: "113041910",
    label: "生活習慣病管理料1（糖尿病）",
    reviewMessage: "生活習慣病管理料を候補化しました。主病、療養計画書、包括範囲、同月算定条件を確認してください。",
    patterns: [/(?:生活習慣病管理料|生活習慣病.*管理料)/u]
  },
  {
    key: "transvaginal_ultrasound",
    code: "160072210",
    label: "経腟超音波",
    commentInput: {
      code: "820100683",
      text: "超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域"
    },
    patterns: [/(?:経腟超音波|経膣超音波|経腟エコー|経膣エコー|子宮.*超音波|卵巣.*超音波)/u]
  }
]);

export function resolveClinicalProcedureHints(value = "") {
  const text = normalizeClinicalResolverText(value);
  const procedureCodes = [];
  const commentInputs = [];
  const collectionFeeInputs = [];
  const reviewWarnings = [];

  if (!text) {
    return {
      procedureCodes,
      commentInputs,
      collectionFeeInputs,
      reviewWarnings
    };
  }

  for (const hint of CLINICAL_PROCEDURE_HINTS) {
    if (!hint.patterns.some((pattern) => pattern.test(text))) {
      continue;
    }
    procedureCodes.push(hint.code);
    if (hint.commentInput) {
      commentInputs.push(hint.commentInput);
    }
    if (hint.collectionFeeInput) {
      collectionFeeInputs.push(hint.collectionFeeInput);
    }
    if (hint.reviewMessage) {
      reviewWarnings.push(hint.reviewMessage);
    }
  }

  return {
    procedureCodes: uniqueStrings(procedureCodes),
    commentInputs: uniqueObjects(commentInputs, (item) => item.code || item.text || JSON.stringify(item)),
    collectionFeeInputs: uniqueStrings(collectionFeeInputs),
    reviewWarnings: uniqueStrings(reviewWarnings)
  };
}

export function procedureHintQueries(value = "") {
  const text = normalizeClinicalResolverText(value);
  const queries = [];
  if (/尿アルブミン|微量アルブミン尿/u.test(text)) {
    queries.push("アルブミン定量");
  }
  if (/血糖|グルコース/u.test(text)) {
    queries.push("グルコース");
  }
  if (/HbA1c|ＨｂＡ１ｃ/iu.test(text)) {
    queries.push("ＨｂＡ１ｃ");
  }
  if (/(?:CRP|ＣＲＰ|C反応性蛋白)/iu.test(text)) {
    queries.push("ＣＲＰ", "C反応性蛋白");
  }
  if (/(?:WBC|白血球|末梢血液一般|血算)/iu.test(text)) {
    queries.push("末梢血液一般", "白血球");
  }
  if (/(?:Plt|血小板)/iu.test(text)) {
    queries.push("血小板");
  }
  if (/(?:PT[-－]?INR|プロトロンビン)/iu.test(text)) {
    queries.push("プロトロンビン時間");
  }
  if (/(?:AST|ＡＳＴ|GOT|ＧＯＴ)/iu.test(text)) {
    queries.push("ＡＳＴ");
  }
  if (/(?:ALT|ＡＬＴ|GPT|ＧＰＴ)/iu.test(text)) {
    queries.push("ＡＬＴ");
  }
  if (/(?:アルブミン|Alb|Ａｌｂ)/iu.test(text) && !/尿アルブミン|微量アルブミン尿/u.test(text)) {
    queries.push("アルブミン");
  }
  return uniqueStrings(queries);
}

function normalizeClinicalResolverText(value = "") {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .trim();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueObjects(values = [], keyFn = (item) => JSON.stringify(item)) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}
