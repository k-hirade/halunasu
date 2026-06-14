export const FEE_CONCEPT_REGISTRY_VERSION = "fee-concept-registry-v1";

export const LAB_CONCEPT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "urine_general",
    name: "尿一般",
    query: "尿一般",
    aliases: ["尿中一般物質定性半定量検査", "尿定性"],
    pattern: /尿一般|尿定性|尿中一般物質|尿検査/u
  }),
  Object.freeze({
    key: "urine_protein",
    name: "尿蛋白",
    query: "尿蛋白",
    aliases: ["蛋白尿"],
    pattern: /尿蛋白|蛋白尿|尿.*蛋白/u
  }),
  Object.freeze({
    key: "crp",
    name: "ＣＲＰ",
    query: "ＣＲＰ",
    aliases: ["C反応性蛋白", "Ｃ反応性蛋白"],
    pattern: /\bCRP\b|ＣＲＰ|C反応性蛋白|Ｃ反応性蛋白/u
  }),
  Object.freeze({
    key: "cbc",
    name: "末梢血液一般検査",
    query: "末梢血液一般検査",
    aliases: ["血算", "ＣＢＣ"],
    pattern: /CBC|ＣＢＣ|血算|末梢血液一般|血球計算|白血球|赤血球|血小板/u
  }),
  Object.freeze({
    key: "glucose",
    name: "グルコース",
    query: "グルコース",
    aliases: ["血糖"],
    pattern: /グルコース|血糖/u
  }),
  Object.freeze({
    key: "hba1c",
    name: "ＨｂＡ１ｃ",
    query: "ＨｂＡ１ｃ",
    aliases: ["HbA1c"],
    pattern: /HbA1c|ＨｂＡ１ｃ/u
  }),
  Object.freeze({
    key: "tcho",
    name: "Ｔｃｈｏ",
    query: "Ｔｃｈｏ",
    aliases: ["総コレステロール"],
    pattern: /Tcho|Ｔｃｈｏ|総コレステロール|総コレステ/u
  }),
  Object.freeze({
    key: "ldl",
    name: "ＬＤＬ－コレステロール",
    query: "ＬＤＬ－コレステロール",
    aliases: ["LDL"],
    pattern: /\bLDL\b|ＬＤＬ/u
  }),
  Object.freeze({
    key: "tg",
    name: "ＴＧ",
    query: "ＴＧ",
    aliases: ["中性脂肪"],
    pattern: /\bTG\b|ＴＧ|中性脂肪/u
  }),
  Object.freeze({
    key: "creatinine",
    name: "クレアチニン",
    query: "クレアチニン",
    aliases: ["Cr"],
    pattern: /クレアチニン|(?:^|[^\p{L}])Cr(?:$|[^\p{L}])/u
  })
]);

export const PROCEDURE_CHECKLIST_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "burn_treatment",
    label: "熱傷処置",
    query: "熱傷処置",
    aliases: ["熱傷処置（１００ｃｍ２未満）", "熱傷処置"],
    pattern: /熱傷|火傷|やけど|熱傷処置/u,
    matchTerms: ["熱傷", "火傷", "やけど"]
  }),
  Object.freeze({
    key: "wound_treatment",
    label: "創傷処置",
    query: "創傷処置",
    aliases: ["創傷処置（１００ｃｍ２未満）", "創傷処置"],
    pattern: /創傷|創部(?:洗浄|消毒|処置|保護)|創傷処置|縫合後処置/u,
    matchTerms: ["創傷", "創部", "切創", "裂創"]
  }),
  Object.freeze({
    key: "suture_or_wound_closure",
    label: "創傷処理・縫合",
    query: "創傷処理",
    aliases: ["創傷処理", "縫合処置"],
    pattern: /(?:創|裂創|切創|挫創).{0,16}(?:縫合|閉鎖)|縫合処置|創傷処理/u,
    matchTerms: ["縫合", "創傷処理", "裂創", "切創"]
  }),
  Object.freeze({
    key: "incision_drainage",
    label: "切開排膿処置",
    query: "切開排膿",
    aliases: ["皮膚切開術", "切開排膿"],
    pattern: /(?:膿瘍|感染粉瘤|化膿).{0,16}(?:切開|排膿)|切開排膿/u,
    matchTerms: ["膿瘍", "切開", "排膿"]
  }),
  Object.freeze({
    key: "cerumen_removal",
    label: "耳垢栓塞除去",
    query: "耳垢栓塞除去",
    aliases: ["耳垢栓塞除去", "耳処置"],
    pattern: /耳垢|耳垢栓塞|耳処置/u,
    matchTerms: ["耳垢", "耳処置"]
  }),
  Object.freeze({
    key: "nasal_treatment",
    label: "鼻処置",
    query: "鼻処置",
    aliases: ["鼻処置", "鼻腔処置"],
    pattern: /鼻処置|鼻腔処置|鼻洗浄/u,
    matchTerms: ["鼻処置", "鼻腔処置", "鼻洗浄"]
  })
]);

export const REVIEW_ONLY_DOMAIN_CHECKLIST_DEFINITIONS = Object.freeze([
  Object.freeze({ domain: "surgery", label: "手術", pattern: /手術|術式|切除術|縫合術|手術同意|手術説明|(?:腫瘤|粉瘤|脂肪腫|皮下腫瘤|病変|皮膚病変).{0,12}(?:切除|摘出)|(?:切除|摘出).{0,12}(?:施行|実施|予定|相談|希望|未実施|行っていない)/u }),
  Object.freeze({ domain: "anesthesia", label: "麻酔", pattern: /麻酔|術前診察|麻酔科|全身麻酔|局所麻酔/u }),
  Object.freeze({ domain: "pathology", label: "病理診断・細胞診", pattern: /病理|細胞診|組織診|標本|生検/u }),
  Object.freeze({ domain: "rehabilitation", label: "リハビリテーション", pattern: /リハビリ|運動器リハ|脳血管リハ|廃用症候群リハ|実施単位/u }),
  Object.freeze({ domain: "home_care", label: "在宅医療", pattern: /在宅医療|訪問診療|往診|在宅自己注射|在宅酸素/u }),
  Object.freeze({ domain: "psychiatry_special", label: "精神科専門療法", pattern: /精神科専門療法|通院精神療法|精神療法|認知行動療法/u }),
  Object.freeze({ domain: "endoscopy", label: "内視鏡", pattern: /内視鏡|胃カメラ|大腸カメラ|上部消化管内視鏡|下部消化管内視鏡/u }),
  Object.freeze({ domain: "dialysis", label: "透析", pattern: /透析|血液透析|腹膜透析/u }),
  Object.freeze({ domain: "transfusion", label: "輸血", pattern: /輸血|赤血球液|血小板製剤|血漿/u }),
  Object.freeze({ domain: "radiation_therapy", label: "放射線治療", pattern: /放射線治療|照射|線量/u }),
  Object.freeze({ domain: "injection_review_only", label: "注射", pattern: /注射|皮下注|筋注|静注|点滴|投与経路/u }),
  Object.freeze({ domain: "emergency_time_addon", label: "救急・時間外加算", pattern: /救急加算|時間外加算|休日加算|深夜加算|受付時刻/u })
]);
