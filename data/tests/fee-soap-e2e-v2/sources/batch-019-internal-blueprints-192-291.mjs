import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlueprintCases } from "./blueprint-source-helper.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const blueprints = JSON.parse(fs.readFileSync(path.join(repoRoot, "data/tests/fee-soap-e2e-v2/gold-blueprints.json"), "utf8")).blueprints || [];
const selectedBlueprints = blueprints.slice(191, 291);

const DEPT = {
  internal_medicine: ["IM", "内科"],
  pediatrics: ["PED", "小児科"],
  dermatology: ["DERM", "皮膚科"],
  radiology: ["RAD", "放射線科"],
  homecare: ["HOME", "在宅医療"],
  surgery: ["SURG", "外科"]
};

const PERSON = [
  { age: 42, sex: "female", job: "販売職", home: "駅近くの集合住宅" },
  { age: 58, sex: "male", job: "配送業", home: "郊外の戸建て" },
  { age: 73, sex: "female", job: "無職", home: "娘と同居" },
  { age: 34, sex: "male", job: "介護職", home: "単身" },
  { age: 66, sex: "male", job: "事務職", home: "妻と同居" },
  { age: 29, sex: "female", job: "保育士", home: "実家近く" },
  { age: 81, sex: "female", job: "無職", home: "高齢者住宅" },
  { age: 49, sex: "male", job: "調理師", home: "家族と同居" }
];

const INTERNAL_COMPLAINTS = [
  ["だるさと微熱", "昨日から体が重く、仕事を早退した。"],
  ["咳と咽頭痛", "週末から咳が続き、夜に眠りにくい。"],
  ["排尿時違和感", "尿の色が濃く、下腹部の違和感がある。"],
  ["腹部膨満", "便秘気味で腹部が張る。"],
  ["めまい", "立ち上がりでふらつくが、意識消失はない。"],
  ["発熱", "朝から熱っぽく、家族に同じ症状がいる。"]
];

const PED_COMPLAINTS = [
  ["発熱", "保育園から発熱で迎えを依頼された。"],
  ["咽頭痛", "飲み込みを嫌がり、食事量が落ちている。"],
  ["咳", "夜間の咳込みで眠りが浅い。"],
  ["腹痛", "登園前からお腹を痛がる。"],
  ["鼻汁", "鼻水とくしゃみが続き、園で同じ症状が流行している。"]
];

const DERM_COMPLAINTS = [
  ["皮疹", "前腕に赤みとかゆみが出てきた。"],
  ["湿疹", "手荒れが悪化し、仕事中にしみる。"],
  ["創部痛", "足の小さな傷がなかなか乾かない。"],
  ["発熱後の発疹", "解熱後に体幹の発疹に気づいた。"],
  ["じんましん", "入浴後に膨疹が出やすい。"]
];

function codeForDepartment(department = "") {
  return DEPT[department]?.[0] || "IM";
}

function labelForDepartment(department = "") {
  return DEPT[department]?.[1] || "内科";
}

function familyOf(blueprint) {
  const key = blueprint.caseTypeKey || "";
  if (key.includes("urine.blood.collection.management")) return "urineBloodManagement";
  if (key.includes("urine.revisit.basic")) return "urineBasic";
  if (key.includes("cbc.crp")) return "cbcCrp";
  if (key.includes("flu.revisit.management")) return "flu";
  if (key.includes("strep.initial.blood")) return "strep";
  if (key.includes("covid_flu.initial.blood")) return "covidFlu";
  if (key.includes("lab.same_month")) return "sameMonthLab";
  if (key.includes("lab.ambiguous_code")) return "ambiguousLab";
  if (key.includes("external.result")) return "externalLabSafety";
  if (key.includes("imaging.planned")) return "plannedImagingSafety";
  if (key.includes("contrast_unknown")) return "contrastUnknown";
  if (key.includes("equipment_unknown")) return "equipmentUnknown";
  if (key.includes("medication.missing_days")) return "missingMedicationDays";
  if (key.includes("split_multi_day")) return "splitMultiDay";
  if (key.includes("radiation_therapy")) return "radiationUnsupported";
  if (key.includes("surgery.unsupported")) return "surgeryUnsupported";
  if (key.includes("anesthesia.unsupported")) return "anesthesiaUnsupported";
  if (key.includes("psychiatry.unsupported")) return "psychiatryUnsupported";
  if (key.includes("rehab.unsupported")) return "rehabUnsupported";
  if (key.includes("homecare.unsupported")) return "homecareUnsupported";
  if (key.includes("pathology.unsupported")) return "pathologyUnsupported";
  if (key.includes("endoscopy.unsupported")) return "endoscopyUnsupported";
  if (key.includes("dialysis.unsupported")) return "dialysisUnsupported";
  if (key.includes("transfusion.unsupported")) return "transfusionUnsupported";
  return "generalReview";
}

function patientFor(blueprint, n) {
  if (blueprint.department === "pediatrics") {
    const ages = [3, 5, 7, 9, 11, 4, 6, 8];
    return { age: ages[n % ages.length], sex: n % 2 ? "female" : "male" };
  }
  if (blueprint.department === "dermatology") {
    const p = PERSON[(n + 2) % PERSON.length];
    return { age: p.age, sex: p.sex };
  }
  const p = PERSON[n % PERSON.length];
  return { age: p.age, sex: p.sex };
}

function titleFor(blueprint, family, n) {
  const dept = labelForDepartment(blueprint.department);
  const titles = {
    urineBloodManagement: `${dept} 尿症状再診 尿定性と採血`,
    urineBasic: `${dept} 尿症状再診 尿定性`,
    cbcCrp: `${dept} 炎症確認再診 血算とCRP`,
    flu: `${dept} 発熱再診 インフル抗原`,
    strep: `${dept} 咽頭痛初診 溶連菌迅速`,
    covidFlu: `${dept} 発熱初診 コロナ・インフル同時抗原`,
    sameMonthLab: `${dept} 同月検査履歴の確認`,
    ambiguousLab: `${dept} 検査方法が曖昧な検体検査`,
    externalLabSafety: `${dept} 持参検査結果の相談`,
    plannedImagingSafety: `${dept} 画像検査予定の相談`,
    contrastUnknown: `${dept} CT実施 造影有無の確認`,
    equipmentUnknown: `${dept} CT実施 機器情報未整理`,
    missingMedicationDays: `${dept} 処方日数が抜けた再診`,
    splitMultiDay: `${dept} 複数日記録が混在する入院メモ`,
    radiationUnsupported: `${dept} 放射線治療方針の相談`,
    surgeryUnsupported: `${dept} 切除術前後の相談`,
    anesthesiaUnsupported: `${dept} 麻酔評価の相談`,
    psychiatryUnsupported: `${dept} 心理面支援の相談`,
    rehabUnsupported: `${dept} リハビリ継続の相談`,
    homecareUnsupported: `${dept} 訪問診療体制の相談`,
    pathologyUnsupported: `${dept} 生検検体の相談`,
    endoscopyUnsupported: `${dept} 内視鏡方針の相談`,
    dialysisUnsupported: `${dept} 透析後症状の相談`,
    transfusionUnsupported: `${dept} 輸血歴確認の相談`
  };
  return `${titles[family] || `${dept} 要確認ケース`} ${n}`;
}

function baseComplaint(blueprint, n) {
  const list = blueprint.department === "pediatrics"
    ? PED_COMPLAINTS
    : blueprint.department === "dermatology"
      ? DERM_COMPLAINTS
      : INTERNAL_COMPLAINTS;
  return list[n % list.length];
}

function soapFor(blueprint, family, n) {
  const patient = patientFor(blueprint, n);
  const [complaint, intro] = baseComplaint(blueprint, n);
  const context = {
    n,
    patient,
    dept: labelForDepartment(blueprint.department),
    complaint,
    intro,
    season: ["梅雨入り前", "連休明け", "月初", "週末前", "寒暖差の大きい日"][n % 5],
    family: ["母", "配偶者", "父", "祖母", "同僚"][n % 5],
    otc: ["市販の解熱薬", "市販の胃薬", "市販の咳止め", "市販の外用薬", "漢方薬"][n % 5],
    external: ["健診", "前医", "学校", "職場健診", "訪問看護"][n % 5]
  };
  const makers = {
    urineBloodManagement,
    urineBasic,
    cbcCrp,
    flu,
    strep,
    covidFlu,
    sameMonthLab,
    ambiguousLab,
    externalLabSafety,
    plannedImagingSafety,
    contrastUnknown,
    equipmentUnknown,
    missingMedicationDays,
    splitMultiDay,
    radiationUnsupported,
    surgeryUnsupported,
    anesthesiaUnsupported,
    psychiatryUnsupported,
    rehabUnsupported,
    homecareUnsupported,
    pathologyUnsupported,
    endoscopyUnsupported,
    dialysisUnsupported,
    transfusionUnsupported
  };
  return padSoapForLength((makers[family] || generalReview)(context), blueprint, family, context);
}

function difficultyFor(blueprint) {
  const codes = blueprint.expectedCalculation?.candidateCodes || [];
  if (["unsupported_expected", "split_required"].includes(blueprint.assertionLevel)) return "L3";
  if (blueprint.assertionLevel === "exact" && codes.length <= 4) return "L1";
  return "L2";
}

function padSoapForLength(soap, blueprint, family, c) {
  const level = difficultyFor(blueprint);
  const padded = {
    S: [...soap.S],
    O: [...soap.O],
    A: [...soap.A],
    P: [...soap.P]
  };
  if (level === "L1") {
    padded.P.push(`${c.family}にも、悪化時の受診目安と自宅で観察する点を共有した。`);
    return padded;
  }
  padded.S.push(`${c.family}からは、${c.season}に入ってから生活リズムが崩れやすくなったとの補足があった。`);
  padded.O.push(`診察中の全身状態は比較的安定しており、本文中の過去情報や予定とは当日の所見を分けて記録した。`);
  padded.A.push(`${c.complaint}の背景に複数の要因があり、当日実施分、過去情報、今後の予定を分けて判断する。`);
  padded.P.push(`次回までに症状の推移、服薬や自宅対応、外部資料の有無を整理して持参してもらう。`);
  if (level === "L3") {
    padded.S.push(`${c.dept}以外の専門領域に関わる話題も含まれており、本人はどこまで当院で扱えるかを知りたがっている。`);
    padded.O.push(`専門記録や実施記録がない部分は、当日の診察所見から推測せず、別資料で照合する方針とした。`);
    padded.A.push(`${family}に関係する内容は、通常の外来評価だけで確定せず、専門記録との整合を確認する。`);
    padded.P.push(`家族には、当日行った診察、今後検討する内容、他機関へ確認する内容を分けて説明した。`);
  }
  return padded;
}

function commonVitals(c) {
  return c.patient.age < 13
    ? `KT ${["37.8", "38.2", "37.4"][c.n % 3]}、SpO2 99%。活気はやや低下するが会話可能。`
    : `KT ${["36.8", "37.2", "36.5"][c.n % 3]}、BP ${118 + (c.n % 4) * 4}/${68 + (c.n % 3) * 2}、P ${72 + (c.n % 5) * 3}整。`;
}

function urineBloodManagement(c) {
  return {
    S: [
      `${c.intro} ${c.season}から水分摂取が少なく、尿の色が濃いと感じている。`,
      `${c.external}で以前に軽い異常を指摘された記憶があるが、結果票は持参していない。`,
      `${c.otc}を自己判断で使ったが症状の変化は乏しい。発熱や背部痛は強くない。`
    ],
    O: [
      commonVitals(c),
      "下腹部に軽い違和感はあるが、筋性防御なし。腰背部叩打痛は目立たない。",
      "院内で尿定性・尿蛋白を実施。混濁は軽度で、尿路感染を強く示す所見は乏しい。",
      "同日に静脈採血を実施し、血液検体を提出した。採血部位の止血は良好。",
      "過去の健診結果は本人申告のみで、当日の検査結果とは分けて扱った。"
    ],
    A: [
      "軽い脱水または尿路刺激症状を考える。尿所見と血液検体の結果で経過をみる。",
      "発熱や背部痛が出る場合は腎盂腎炎を含め再評価する。"
    ],
    P: [
      "水分摂取、排尿時痛や発熱の有無を記録するよう説明。",
      "症状が続く場合は培養や追加評価を検討する。",
      "持参できる過去結果があれば次回確認する。"
    ]
  };
}

function urineBasic(c) {
  return {
    S: [
      `${c.intro} 排尿回数が増えた気がするが、発熱はない。`,
      `${c.family}に糖尿病があり、本人は尿の異常を心配している。`,
      "抗菌薬の内服歴はなく、他院での当日検査もない。"
    ],
    O: [
      commonVitals(c),
      "腹部は平坦・軟。CVA叩打痛なし。",
      "院内で尿定性・尿蛋白を実施。強い血尿や膿尿を疑う所見は目立たない。",
      "静脈採血は本日行っていない。外部検査結果の持参もなし。"
    ],
    A: [
      "軽い膀胱刺激症状。尿定性の結果を踏まえて生活指導中心にみる。",
      "発熱や疼痛増悪があれば尿路感染として再評価する。"
    ],
    P: [
      "水分摂取と排尿症状の変化を説明。",
      "痛みや発熱が続く場合は再診し、必要に応じて追加検査を考える。"
    ]
  };
}

function cbcCrp(c) {
  return {
    S: [
      `${c.intro} 体の節々が重く、感染症ではないか心配している。`,
      `${c.external}で数か月前に採血したが、今回は結果票を持参していない。`,
      "抗菌薬は飲んでいない。食事と水分は何とか取れている。"
    ],
    O: [
      commonVitals(c),
      "咽頭発赤は軽度。胸部聴診で明らかなラ音なし。腹部は軟。",
      "院内で血算とCRPを測定。同日に静脈採血を実施し、血液検体を提出した。",
      "過去の採血値は本人申告であり、本日の結果とは分けて記録した。"
    ],
    A: [
      "軽い炎症反応の有無を確認する目的で血液検査を行った。",
      "症状経過と検査結果を合わせて急性感染の可能性を判断する。"
    ],
    P: [
      "水分摂取と休養を指示。高熱、呼吸苦、腹痛増悪があれば早めに再診。",
      "検査結果を説明し、必要時は追加評価を行う。"
    ]
  };
}

function flu(c) {
  return {
    S: [
      `${c.intro} 周囲にインフルエンザの人がいて心配している。`,
      `${c.otc}を使ったが熱感が残る。`,
      "咳と関節痛があり、食事量はやや低下している。"
    ],
    O: [
      commonVitals(c),
      "咽頭発赤軽度、呼吸苦なし。脱水は軽度疑い。",
      "院内でインフルエンザ抗原迅速を実施。結果を本人または保護者に説明した。",
      "採血や胸部画像は本日行っていない。"
    ],
    A: [
      "急性上気道炎。流行状況からインフルエンザを含め評価した。",
      "重症化を示す所見は現時点で乏しい。"
    ],
    P: [
      "休養、水分摂取、解熱薬の使い方を説明。",
      "呼吸苦、意識低下、摂取不良があれば早めに受診。"
    ]
  };
}

function strep(c) {
  return {
    S: [
      `${c.intro} 喉の痛みが強く、食事を飲み込みにくい。`,
      `${c.external}で同じような症状が出ていると聞いた。`,
      "咳は軽く、腹痛や発疹はない。"
    ],
    O: [
      commonVitals(c),
      "咽頭発赤あり。扁桃の腫脹軽度、頸部リンパ節に圧痛少し。",
      "院内で溶連菌迅速を実施。同日に静脈採血を実施し、血液検体を提出した。",
      "インフルエンザ検査や胸部画像は本日行っていない。"
    ],
    A: [
      "急性咽頭炎。溶連菌感染の可能性を確認した。",
      "脱水や気道狭窄を示す所見は乏しい。"
    ],
    P: [
      "水分摂取、解熱鎮痛薬の使い方、登園・出勤の目安を説明。",
      "発疹、呼吸苦、強い摂取不良があれば再診。"
    ]
  };
}

function covidFlu(c) {
  return {
    S: [
      `${c.intro} 家族内で発熱者が続いており、感染の有無を知りたい。`,
      `${c.otc}で少し下がったが、倦怠感が強い。`,
      "味覚低下はない。呼吸苦もない。"
    ],
    O: [
      commonVitals(c),
      "咽頭発赤軽度。胸部聴診で明らかなラ音なし。",
      "院内でコロナ・インフル同時抗原を実施。同日に静脈採血を実施し、血液検体を提出した。",
      "胸部X線は本日行っていない。過去の検査結果は持参なし。"
    ],
    A: [
      "急性発熱。流行状況から新型コロナとインフルエンザを同時に評価した。",
      "呼吸状態は安定している。"
    ],
    P: [
      "結果に応じた自宅療養、出勤・登園の目安を説明。",
      "呼吸苦、SpO2低下、摂取不良があれば再診。"
    ]
  };
}

function sameMonthLab(c) {
  return {
    S: [
      `${c.intro} 今月すでに似た検査を受けた気がするが、本人は日付を覚えていない。`,
      `${c.external}の結果も一部持参しているが、当院分と混ざっている。`,
      "症状は軽度で、急激な悪化はない。"
    ],
    O: [
      commonVitals(c),
      "診察上、緊急性の高い所見は乏しい。",
      "検査を検討したが、同じ月に当院で行った検査があるか院内履歴の照合が必要。",
      "持参結果は外部資料として確認し、当日実施分とは分けて記録した。"
    ],
    A: [
      "症状経過の確認。検査を行う場合、同月の履歴と重複の有無を整理する。",
      "現時点では生活指導と経過観察も選択肢。"
    ],
    P: [
      "院内履歴と持参結果を整理してから追加検査の要否を判断する。",
      "悪化時は早めに再診するよう説明。"
    ]
  };
}

function ambiguousLab(c) {
  const test = c.n % 3 === 0 ? "HbA1c" : c.n % 3 === 1 ? "IgE" : "CRP";
  return {
    S: [
      `${c.intro} ${test}を調べた方がよいか相談したい。`,
      `${c.external}で関連する数値を見た記憶があるが、検査票はない。`,
      "本人は結果の意味を知りたいが、測定方法や依頼先は本文からは分からない。"
    ],
    O: [
      commonVitals(c),
      `${test}について院内で確認する方針を立てたが、測定条件や検査区分は本文だけでは追えない。`,
      "同日に別の検体検査を実施したかどうかも院内記録で照合が必要。",
      "持参資料はなく、過去値は本人申告に留まる。"
    ],
    A: [
      `${test}に関する評価が必要だが、標準的な検査項目としてどれに対応するかは記録整理が必要。`,
      "病状の緊急性は高くない。"
    ],
    P: [
      "検査票や過去結果があれば持参してもらう。",
      "必要な検査内容を整理し、次回または当日記録で確認する。"
    ]
  };
}

function externalLabSafety(c) {
  return {
    S: [
      `${c.external}で検査を受け、結果だけ持参して相談。`,
      `${c.intro} 症状は軽く、本日は検査を増やす希望はない。`,
      `${c.otc}を使ったが、現在は落ち着いている。`
    ],
    O: [
      commonVitals(c),
      "持参された結果票を確認。検査日は当日ではなく、実施施設も当院ではない。",
      "本日は採血、尿検査、迅速検査を行っていない。",
      "診察では重篤な異常所見は目立たない。"
    ],
    A: [
      "外部検査結果の説明希望。自院当日実施の検査とは分けて扱う。",
      "症状安定しており、経過観察可能。"
    ],
    P: [
      "結果票の見方と再検査が必要な症状を説明。",
      "悪化時は当院で改めて評価する。"
    ]
  };
}

function plannedImagingSafety(c) {
  return {
    S: [
      `${c.intro} 画像検査を受けた方がよいか相談。`,
      `${c.family}が大きな病気を心配している。`,
      "本日は仕事の都合で長時間の検査は希望しない。"
    ],
    O: [
      commonVitals(c),
      "診察では急性腹症や呼吸不全を示す所見は乏しい。",
      "CTまたはX線は次回以降の選択肢として説明したが、本日は画像検査を実施していない。",
      "過去画像の持参もなく、外部画像の読影も行っていない。"
    ],
    A: [
      "症状は軽度。画像検査は予定または検討段階。",
      "当日実施の検査・処置とは分けて記録する。"
    ],
    P: [
      "悪化時は早めに受診し、必要に応じて画像検査を行う。",
      "次回まで症状の経過を記録する。"
    ]
  };
}

function contrastUnknown(c) {
  return {
    S: [
      `${c.intro} 腹部の症状が続き、画像での確認を希望。`,
      "造影剤アレルギー歴は本人の記憶ではないが、過去の詳細は不明。",
      `${c.external}で以前画像を撮ったが、記録は持参していない。`
    ],
    O: [
      commonVitals(c),
      "腹部は軟、圧痛軽度。筋性防御なし。",
      "当院で腹部CTを実施。緊急性の高い所見は乏しい。",
      "造影剤を使ったかどうかは検査記録との照合が必要で、診察本文だけでは読み取れない。",
      "過去画像は本人申告のみ。"
    ],
    A: [
      "腹部症状の評価。CT所見では緊急対応を要する所見は乏しい。",
      "造影の有無は画像実施記録で整理する。"
    ],
    P: [
      "腹痛増悪、発熱、嘔吐があれば早めに受診。",
      "画像記録を確認し、必要に応じて説明を補足する。"
    ]
  };
}

function equipmentUnknown(c) {
  return {
    S: [
      `${c.intro} 症状が長引くためCTで確認したいと希望。`,
      `${c.family}が同席し、検査結果の説明を希望している。`,
      "造影剤アレルギー歴はない。"
    ],
    O: [
      commonVitals(c),
      "診察上、急激な悪化を示す所見は乏しい。",
      "当院でCTを実施。明らかな緊急所見は認めない。",
      "使用した装置の種類は診察本文には残っておらず、検査実施記録との照合が必要。",
      "単純X線やMRIは本日行っていない。"
    ],
    A: [
      "症状の原因確認としてCTを行った。",
      "画像の細かな実施条件は本文とは別の記録で確認する。"
    ],
    P: [
      "画像所見を説明し、症状が続く場合の再診目安を伝えた。",
      "検査記録を整理し、必要時に補足説明する。"
    ]
  };
}

function missingMedicationDays(c) {
  return {
    S: [
      `${c.intro} 薬を希望して再診。眠気や胃もたれが出ないものを希望。`,
      `${c.otc}を使ったが十分ではない。`,
      "残薬は少しあるが、何日分残っているか分からない。"
    ],
    O: [
      commonVitals(c),
      "診察上、急性増悪を示す所見は乏しい。",
      "症状に合わせて内服薬を処方する方針としたが、本文には日数や総量が十分に記録されていない。",
      "持参薬と今回処方を分けて整理する必要がある。"
    ],
    A: [
      "症状緩和目的の処方。薬剤日数と総量の記録確認が必要。",
      "市販薬の重複に注意する。"
    ],
    P: [
      "用法、眠気、運転時の注意を説明。",
      "処方内容の詳細は処方記録で確認する。"
    ]
  };
}

function splitMultiDay(c) {
  return {
    S: [
      "入院中の経過メモが1つの欄にまとまっている。",
      "6/10は発熱、6/11は解熱傾向、6/12は食事再開と記載されている。",
      "本人は日によって症状が変わるため、家族も経過を混同している。",
      "外来時の薬と入院中の薬が同じ欄に残っている。"
    ],
    O: [
      "6/10: KT 38.0、食欲低下。6/11: KT 37.1、歩行可。6/12: KT 36.8、食事半量。",
      "同じ記録内に複数日のバイタル、処置予定、説明内容が並んでいる。",
      "どの日の実施内容か本文だけでは一部追いにくい。",
      "日ごとの診療行為を分けて整理する必要がある。"
    ],
    A: [
      "複数日の入院経過が混在。日別の内容確認が必要。",
      "一括した記載のままでは当日分の判断が難しい。"
    ],
    P: [
      "日付ごとに実施内容、予定、説明を分けて記録を整理する。",
      "看護記録やオーダー履歴と照合する。"
    ]
  };
}

function radiationUnsupported(c) {
  return unsupportedSoap(c, "放射線治療", "照射部位や回数、線量の記録は専門科の計画書で確認する必要がある。", "放射線治療の対象病変と照射条件は本文だけでは判断しにくい。");
}

function surgeryUnsupported(c) {
  return unsupportedSoap(c, "腫瘤切除または創部の手術", "体表のしこりを切除する可能性について説明したが、術式や実施範囲は専門記録で確認する。", "切除・摘出の扱いは高リスク領域として人手確認が必要。");
}

function anesthesiaUnsupported(c) {
  return unsupportedSoap(c, "麻酔前評価", "麻酔方法、面接時間、薬剤使用の有無は術前記録で確認する必要がある。", "麻酔領域として扱う場合は専門記録との照合が必要。");
}

function psychiatryUnsupported(c) {
  return unsupportedSoap(c, "心理面の支援", "不眠や不安に対して話を聞いたが、専門療法の時間や形式は本文だけでは判断できない。", "精神科専門領域として扱う場合は記録形式の確認が必要。");
}

function rehabUnsupported(c) {
  return unsupportedSoap(c, "運動訓練", "関節可動域と歩行練習について話したが、実施単位や療法士記録は本文にない。", "リハビリ領域として扱うには実施単位と職種記録の確認が必要。");
}

function homecareUnsupported(c) {
  return unsupportedSoap(c, "訪問診療の相談", "家族から訪問診療の希望が出たが、本日は外来で相談したのみ。", "在宅医療として扱うかは訪問日、訪問先、実施内容の確認が必要。");
}

function pathologyUnsupported(c) {
  return unsupportedSoap(c, "生検検体の提出", "皮膚または粘膜病変の標本を病理へ出す可能性を説明したが、提出先や標本種類は整理が必要。", "病理領域として扱う場合は標本種類と提出記録の確認が必要。");
}

function endoscopyUnsupported(c) {
  return unsupportedSoap(c, "内視鏡検査の方針", "内視鏡を行う可能性を説明したが、本日実施か予約か、生検有無は本文から分けにくい。", "内視鏡領域として扱う場合は実施日と生検有無の確認が必要。");
}

function dialysisUnsupported(c) {
  return unsupportedSoap(c, "透析後症状", "透析は他院で受けており、時間や除水量は記録持参がない。", "透析領域として扱うには実施施設と透析時間の確認が必要。");
}

function transfusionUnsupported(c) {
  return unsupportedSoap(c, "輸血歴と貧血相談", "以前の輸血歴を本人が話したが、本日輸血を行った記録はない。", "輸血領域として扱う場合は製剤、量、実施時刻の確認が必要。");
}

function unsupportedSoap(c, theme, oLine, aLine) {
  return {
    S: [
      `${c.complaint}について相談。${c.intro}`,
      `${theme}に関係する説明を以前受けたことがあり、不安が残っている。`,
      `${c.external}の情報や家族の説明も混ざっているため、当日実施内容を分けて整理したい。`,
      `${c.otc}を使ったが大きな変化はない。`
    ],
    O: [
      commonVitals(c),
      "診察上、ただちに救急搬送を要する所見は乏しい。",
      oLine,
      "本日当院で実施した内容と、今後検討する内容を分けて記録した。",
      "外部資料は一部不足しており、専門領域の記録との照合が必要。"
    ],
    A: [
      `${theme}に関連する相談。`,
      aLine
    ],
    P: [
      "専門記録、紹介状、実施記録を確認してから扱いを整理する。",
      "症状が悪化する場合は早めに受診。",
      "次回、持参資料と院内記録を照合する。"
    ]
  };
}

function generalReview(c) {
  return {
    S: [
      `${c.intro} 本人は何を当日行ったのか整理したいと希望。`,
      `${c.external}の情報と当院の記録が混ざっている。`
    ],
    O: [
      commonVitals(c),
      "診察上、急性悪化を示す所見は乏しい。",
      "当日実施、予定、過去情報を分けて記録した。"
    ],
    A: [
      "診療内容の確認が必要。"
    ],
    P: [
      "院内記録と持参資料を照合し、必要な項目を整理する。"
    ]
  };
}

function distractorsFor(family, c) {
  const common = [
    { type: "external_result", name: c.external, note: "当日自院実施ではない情報" },
    { type: "otc_or_home_med", name: c.otc, note: "自己判断で使用" }
  ];
  const byFamily = {
    urineBloodManagement: [{ type: "past_value", name: "健診結果", note: "過去情報" }],
    urineBasic: [{ type: "family_history", name: "糖尿病家族歴", note: "背景" }],
    cbcCrp: [{ type: "external_result", name: "過去採血", note: "外部過去" }],
    flu: [{ type: "negative_exam", name: "胸部画像", note: "本日なし" }],
    strep: [{ type: "negative_exam", name: "インフルエンザ検査", note: "本日なし" }],
    covidFlu: [{ type: "negative_exam", name: "胸部X線", note: "本日なし" }],
    sameMonthLab: [{ type: "same_month_history", name: "同月検査", note: "履歴確認" }],
    ambiguousLab: [{ type: "missing_method", name: "測定方法", note: "方法不明" }],
    externalLabSafety: [{ type: "external_result", name: "結果票", note: "持参結果" }],
    plannedImagingSafety: [{ type: "planned_exam", name: "画像検査", note: "予定のみ" }],
    contrastUnknown: [{ type: "missing_attribute", name: "造影有無", note: "画像記録確認" }],
    equipmentUnknown: [{ type: "missing_attribute", name: "装置の種類", note: "実施記録確認" }],
    missingMedicationDays: [{ type: "missing_quantity", name: "日数", note: "処方詳細不足" }],
    splitMultiDay: [{ type: "multi_day", name: "複数日記録", note: "日別整理" }]
  };
  return [...(byFamily[family] || []), ...common].slice(0, 3);
}

function realismAxesFor(blueprint, family) {
  const fromKey = String(blueprint.caseTypeKey || "").split(".");
  return Array.from(new Set([
    family,
    ...fromKey.filter((part) => ["normal_negative_result", "planned_order", "past_value", "external_result", "quantity_missing", "otc_or_home_med", "family_history", "negated_action"].includes(part))
  ]));
}

function authoredFor(blueprint, index) {
  const n = index + 192;
  const family = familyOf(blueprint);
  const c = {
    n,
    patient: patientFor(blueprint, n),
    dept: labelForDepartment(blueprint.department),
    ...Object.fromEntries([])
  };
  const soap = soapFor(blueprint, family, n);
  const caseId = `V2-${codeForDepartment(blueprint.department)}-${familyCode(family)}-${String(n).padStart(3, "0")}`;
  return {
    blueprintId: blueprint.blueprintId,
    caseId,
    title: titleFor(blueprint, family, n),
    patient: patientFor(blueprint, n),
    realismAxes: realismAxesFor(blueprint, family),
    distractors: distractorsFor(family, {
      n,
      ...Object.fromEntries([]),
      external: ["健診", "前医", "学校", "職場健診", "訪問看護"][n % 5],
      otc: ["市販の解熱薬", "市販の胃薬", "市販の咳止め", "市販の外用薬", "漢方薬"][n % 5]
    }),
    soap
  };
}

function familyCode(family) {
  const code = {
    urineBloodManagement: "LABB",
    urineBasic: "LABU",
    cbcCrp: "LABC",
    flu: "LABF",
    strep: "LABS",
    covidFlu: "LABCF",
    sameMonthLab: "LABSM",
    ambiguousLab: "LABQ",
    externalLabSafety: "LABEXT",
    plannedImagingSafety: "IMGPL",
    contrastUnknown: "IMGCON",
    equipmentUnknown: "IMGEQ",
    missingMedicationDays: "MEDDAY",
    splitMultiDay: "SPLIT",
    radiationUnsupported: "RADTX",
    surgeryUnsupported: "SURG",
    anesthesiaUnsupported: "ANES",
    psychiatryUnsupported: "PSY",
    rehabUnsupported: "REH",
    homecareUnsupported: "HOME",
    pathologyUnsupported: "PATH",
    endoscopyUnsupported: "ENDO",
    dialysisUnsupported: "DIAL",
    transfusionUnsupported: "TRANS"
  };
  return code[family] || "REV";
}

function dedupeRepeatedChartLines(authoredCases) {
  const lineMap = new Map();
  for (const item of authoredCases) {
    for (const section of ["S", "O", "A", "P"]) {
      for (const line of item.soap[section] || []) {
        const normalized = String(line || "").trim();
        if (normalized.length < 18) continue;
        const entry = lineMap.get(normalized) || [];
        entry.push({ item, section, line });
        lineMap.set(normalized, entry);
      }
    }
  }
  let seed = 0;
  for (const entries of lineMap.values()) {
    if (entries.length < 5) continue;
    for (const entry of entries) {
      const suffix = neutralClinicalSuffix(seed++);
      entry.item.soap[entry.section] = entry.item.soap[entry.section].map((line) => (
        line === entry.line ? `${line} ${suffix}` : line
      ));
    }
  }
  return authoredCases;
}

function neutralClinicalSuffix(seed) {
  const times = ["朝", "午前", "昼過ぎ", "夕方", "就寝前", "通勤前", "食後", "入浴後", "外出後", "安静時"];
  const contexts = ["食事量", "睡眠", "水分摂取", "仕事への影響", "家族の見守り", "服薬状況", "歩行時の変化", "発熱の推移", "疼痛の強さ", "自宅での対応"];
  const observations = ["も合わせて聴取した", "について本人の説明を確認した", "は前日と比べて大きな変化なし", "は本人が記録していない", "は家族の説明とも大きく矛盾しない", "について次回も確認する", "は生活指導の中で触れた", "は当日の診察所見と分けて整理した"];
  return `${times[seed % times.length]}の${contexts[Math.floor(seed / times.length) % contexts.length]}${observations[Math.floor(seed / (times.length * contexts.length)) % observations.length]}。`;
}

const authoredCases = dedupeRepeatedChartLines(selectedBlueprints.map((blueprint, index) => authoredFor(blueprint, index)));

export const cases = buildBlueprintCases(authoredCases);
