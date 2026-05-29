const DOMAIN_DEFINITIONS = [
  {
    id: "allergic_rhinitis",
    label: "アレルギー性鼻炎",
    patterns: [/花粉/i, /鼻水|鼻づまり|鼻閉|くしゃみ|点鼻|洗鼻/i, /アレルギー性鼻炎/i],
    glossary: [
      "花粉症",
      "アレルギー性鼻炎",
      "鼻汁",
      "鼻閉",
      "鼻づまり",
      "くしゃみ",
      "目のかゆみ",
      "点鼻薬",
      "点鼻ステロイド",
      "抗ヒスタミン薬",
      "眠気",
      "洗鼻"
    ]
  },
  {
    id: "upper_respiratory",
    label: "上気道炎・感冒",
    patterns: [/咳|発熱|のど|喉|感冒|風邪/i, /喀痰|鼻汁|咽頭痛/i],
    glossary: [
      "感冒",
      "急性上気道炎",
      "咽頭痛",
      "咳嗽",
      "喀痰",
      "発熱",
      "悪寒",
      "インフルエンザ",
      "肺炎"
    ]
  },
  {
    id: "urinary_tract",
    label: "尿路感染",
    patterns: [/排尿|尿|膀胱|残尿|頻尿|血尿/i, /膀胱炎|腎盂腎炎/i],
    glossary: [
      "膀胱炎",
      "急性膀胱炎",
      "腎盂腎炎",
      "排尿時痛",
      "頻尿",
      "残尿感",
      "血尿",
      "尿混濁",
      "下腹部痛",
      "背部痛",
      "側腹部痛",
      "尿検査",
      "抗菌薬"
    ]
  },
  {
    id: "hypertension",
    label: "高血圧",
    patterns: [/血圧|降圧/i, /家庭血圧|高血圧/i],
    glossary: [
      "高血圧",
      "家庭血圧",
      "収縮期血圧",
      "拡張期血圧",
      "降圧薬",
      "血圧手帳"
    ]
  },
  {
    id: "diabetes",
    label: "糖尿病",
    patterns: [/糖尿|血糖|HbA1c/i, /口渇|低血糖/i],
    glossary: [
      "糖尿病",
      "HbA1c",
      "血糖",
      "空腹時血糖",
      "食後血糖",
      "低血糖",
      "口渇",
      "頻尿",
      "内服"
    ]
  },
  {
    id: "dyslipidemia",
    label: "脂質異常症",
    patterns: [/コレステロール|脂質|LDL|中性脂肪/i, /スタチン/i],
    glossary: [
      "脂質異常症",
      "LDL",
      "HDL",
      "中性脂肪",
      "スタチン",
      "肝機能",
      "筋肉痛"
    ]
  },
  {
    id: "gerd",
    label: "逆流性食道炎",
    patterns: [/胸やけ|逆流|酸っぱい|喉の違和感|胃もたれ/i, /食道炎/i],
    glossary: [
      "逆流性食道炎",
      "胸やけ",
      "呑酸",
      "胃もたれ",
      "咽喉頭違和感",
      "PPI"
    ]
  },
  {
    id: "low_back_pain",
    label: "腰痛",
    patterns: [/腰痛|腰が痛|ぎっくり腰|前かがみ|腰を曲げ/i, /しびれ|排尿排便|湿布|痛み止め|鎮痛/i],
    glossary: [
      "腰痛",
      "急性腰痛",
      "慢性腰痛",
      "筋筋膜性腰痛",
      "機械性腰痛",
      "前かがみ",
      "朝のこわばり",
      "下肢しびれ",
      "下肢脱力",
      "放散痛",
      "神経症状",
      "排尿障害",
      "排便障害",
      "膀胱直腸障害",
      "保存的治療",
      "鎮痛薬",
      "痛み止め",
      "貼付薬",
      "湿布"
    ]
  },
  {
    id: "insomnia",
    label: "不眠",
    patterns: [/不眠|寝つき|中途覚醒|眠れ/i, /ストレス|飲酒|睡眠/i],
    glossary: [
      "不眠",
      "入眠困難",
      "中途覚醒",
      "早朝覚醒",
      "睡眠衛生",
      "ストレス",
      "飲酒",
      "抑うつ"
    ]
  }
];

const SHARED_MEDICAL_GLOSSARY = [
  "発熱",
  "悪寒",
  "内服",
  "処方",
  "検査",
  "再診",
  "再受診",
  "アレルギー",
  "副作用",
  "診察所見",
  "既往歴",
  "服薬歴",
  "生活指導"
];

function normalizeText(parts) {
  return parts.filter(Boolean).join(" ").trim();
}

export function detectEncounterDomains({ sessionContext = {}, transcript = "" } = {}) {
  const contextText = normalizeText([
    sessionContext.title,
    sessionContext.visitReason,
    sessionContext.patientDisplayName,
    transcript
  ]);

  if (!contextText) {
    return [];
  }

  return DOMAIN_DEFINITIONS.filter((domain) =>
    domain.patterns.some((pattern) => pattern.test(contextText))
  );
}

export function buildEncounterGlossary({ sessionContext = {}, transcript = "" } = {}) {
  const matchedDomains = detectEncounterDomains({ sessionContext, transcript });
  const glossary = new Set(SHARED_MEDICAL_GLOSSARY);

  for (const domain of matchedDomains) {
    for (const term of domain.glossary) {
      glossary.add(term);
    }
  }

  return {
    domains: matchedDomains.map((domain) => domain.id),
    domainLabels: matchedDomains.map((domain) => domain.label),
    glossary: Array.from(glossary)
  };
}

export function getEncounterDomainDefinitions() {
  return DOMAIN_DEFINITIONS.map((domain) => ({
    id: domain.id,
    label: domain.label,
    glossary: [...domain.glossary]
  }));
}
