import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlueprintCases } from "./blueprint-source-helper.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const blueprints = JSON.parse(fs.readFileSync(path.join(repoRoot, "data/tests/fee-soap-e2e-v2/gold-blueprints.json"), "utf8")).blueprints || [];
const selectedBlueprints = blueprints.slice(291, 391);

const DEPT = {
  dermatology: ["DERM", "皮膚科"],
  otolaryngology: ["ENT", "耳鼻咽喉科"],
  ophthalmology: ["OPH", "眼科"],
  internal_medicine: ["IM", "内科"]
};

const DERM_PATIENTS = [
  { age: 27, sex: "female", job: "美容師" },
  { age: 44, sex: "male", job: "食品工場勤務" },
  { age: 62, sex: "female", job: "事務職" },
  { age: 75, sex: "male", job: "無職" },
  { age: 38, sex: "female", job: "保育士" }
];

const ENT_PATIENTS = [
  { age: 31, sex: "female", job: "電話対応業務" },
  { age: 56, sex: "male", job: "営業職" },
  { age: 70, sex: "female", job: "地域ボランティア" },
  { age: 45, sex: "male", job: "教員" },
  { age: 82, sex: "female", job: "無職" }
];

const OPH_PATIENTS = [
  { age: 68, sex: "female", job: "無職" },
  { age: 52, sex: "male", job: "運転業務" },
  { age: 74, sex: "male", job: "農業" },
  { age: 39, sex: "female", job: "デザイナー" },
  { age: 83, sex: "female", job: "一人暮らし" }
];

function deptCode(department) {
  return DEPT[department]?.[0] || "IM";
}

function deptLabel(department) {
  return DEPT[department]?.[1] || "内科";
}

function patientFor(blueprint, n) {
  const pool = blueprint.department === "dermatology"
    ? DERM_PATIENTS
    : blueprint.department === "ophthalmology"
      ? OPH_PATIENTS
      : ENT_PATIENTS;
  const p = pool[n % pool.length];
  return { age: p.age, sex: p.sex };
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
  if (key.includes("imaging.simple_xray.revisit")) return "simpleXray";
  if (key.includes("simple_xray.e_management")) return "simpleXrayFacility";
  if (key.includes("imaging.ct.revisit")) return "ctRevisit";
  if (key.includes("imaging.ct.initial")) return "ctInitial";
  if (key.includes("contrast_unknown")) return "contrastUnknown";
  if (key.includes("equipment_unknown")) return "equipmentUnknown";
  if (key.includes("imaging.planned")) return "plannedImagingSafety";
  if (key.includes("split_multi_day")) return "splitMultiDay";
  if (key.includes("anesthesia")) return "anesthesiaUnsupported";
  if (key.includes("psychiatry")) return "psychiatryUnsupported";
  if (key.includes("rehab")) return "rehabUnsupported";
  if (key.includes("homecare")) return "homecareUnsupported";
  if (key.includes("pathology")) return "pathologyUnsupported";
  if (key.includes("endoscopy")) return "endoscopyUnsupported";
  if (key.includes("dialysis")) return "dialysisUnsupported";
  if (key.includes("transfusion")) return "transfusionUnsupported";
  if (key.includes("radiation_therapy")) return "radiationUnsupported";
  if (key.includes("surgery")) return "surgeryUnsupported";
  return "generalReview";
}

function difficultyFor(blueprint) {
  const codes = blueprint.expectedCalculation?.candidateCodes || [];
  if (["unsupported_expected", "split_required"].includes(blueprint.assertionLevel)) return "L3";
  if (blueprint.assertionLevel === "exact" && codes.length <= 4) return "L1";
  return "L2";
}

function contextFor(blueprint, index) {
  const n = index + 292;
  const department = blueprint.department;
  const person = patientFor(blueprint, n);
  const chiefByDept = {
    dermatology: ["前腕の皮疹", "下腿のかゆみ", "手湿疹", "小さな創部", "体幹の発疹"],
    otolaryngology: ["咽頭痛", "鼻閉", "耳閉感", "咳込み", "頸部違和感"],
    ophthalmology: ["見えにくさ", "眼痛", "飛蚊感", "まぶしさ", "視界のかすみ"]
  };
  return {
    n,
    department,
    dept: deptLabel(department),
    person,
    chief: chiefByDept[department]?.[n % 5] || "体調不良",
    intro: (chiefByDept[department]?.[n % 5] || "体調不良") + "で受診",
    family: ["母", "配偶者", "娘", "父", "同僚"][n % 5],
    season: ["花粉の時期", "梅雨入り前", "連休明け", "寒暖差が強い週", "仕事が忙しい時期"][n % 5],
    otc: ["市販のかゆみ止め", "市販の風邪薬", "市販の点眼薬", "市販の胃薬", "家にあった軟膏"][n % 5],
    external: ["健診", "前医", "学校", "職場健診", "近医"][n % 5]
  };
}

function vitals(c) {
  if (c.department === "ophthalmology") {
    return `BP ${118 + (c.n % 4) * 4}/${68 + (c.n % 3) * 2}、意識清明。眼脂は少量で、強い眼痛は訴えない。`;
  }
  return `KT ${["36.6", "37.1", "36.8"][c.n % 3]}、BP ${116 + (c.n % 5) * 3}/${68 + (c.n % 4) * 2}、P ${70 + (c.n % 6) * 2}整。`;
}

function soapFor(blueprint, family, index) {
  const c = contextFor(blueprint, index);
  const map = {
    urineBloodManagement,
    urineBasic,
    cbcCrp,
    flu,
    strep,
    covidFlu,
    sameMonthLab,
    ambiguousLab,
    externalLabSafety,
    simpleXray,
    simpleXrayFacility,
    ctRevisit,
    ctInitial,
    contrastUnknown,
    equipmentUnknown,
    plannedImagingSafety,
    splitMultiDay,
    anesthesiaUnsupported,
    psychiatryUnsupported,
    rehabUnsupported,
    homecareUnsupported,
    pathologyUnsupported,
    endoscopyUnsupported,
    dialysisUnsupported,
    transfusionUnsupported,
    radiationUnsupported,
    surgeryUnsupported
  };
  return padSoap((map[family] || generalReview)(c), blueprint, family, c);
}

function padSoap(soap, blueprint, family, c) {
  const level = difficultyFor(blueprint);
  const out = { S: [...soap.S], O: [...soap.O], A: [...soap.A], P: [...soap.P] };
  if (level === "L1") {
    out.P.push(`${c.family}にも、当日行った内容と今後見守る症状を分けて説明した。`);
    return out;
  }
  out.S.push(`${c.season}に入ってから症状の出方が少し変わり、本人は過去の検査や他院の説明と混同している。`);
  out.O.push(`当日の診察所見、持参情報、今後検討する内容を分けて記録し、急性悪化を示す所見がないか確認した。`);
  out.A.push(`${c.chief}の評価では、本文中の外部情報や予定を当日実施分と分離して判断する必要がある。`);
  out.P.push(`次回までに症状の時刻、使用した市販薬、外部資料の有無を整理して持参してもらう。`);
  if (level === "L3") {
    out.S.push(`${c.dept}の通常診療だけでは整理しきれない専門領域の話題が含まれ、本人は扱いの範囲を確認したがっている。`);
    out.O.push(`専門記録がない内容は診察本文から推測せず、実施記録や紹介状と照合する方針にした。`);
    out.A.push(`${family}に関わる内容は高リスクまたは未対応領域として、当日の診療内容だけで確定せず確認する。`);
    out.P.push(`家族には、当日行った診察、今後検討する内容、他機関へ確認する内容を分けて説明した。`);
  }
  return out;
}

function urineBloodManagement(c) {
  return {
    S: [
      `${c.intro}。水分摂取が少なく、尿の色が濃いと感じている。`,
      `${c.external}で以前に軽い異常を言われたが、結果票は持参していない。`,
      `${c.otc}を使ったが今回の症状とは関係がはっきりしない。`
    ],
    O: [
      vitals(c),
      "腹部は平坦・軟。腰背部叩打痛ははっきりしない。",
      "院内で尿定性・尿蛋白を実施。強い血尿や膿尿を疑う所見は目立たない。",
      "同日に静脈採血を実施し、血液検体を提出した。採血部位の止血は良好。",
      "持参情報は外部の過去情報として扱い、本日の検査結果とは分けた。"
    ],
    A: [
      "軽い脱水または尿路刺激症状を考える。",
      "尿所見と血液検体の結果を合わせて経過をみる。"
    ],
    P: [
      "水分摂取と排尿症状の記録を説明。",
      "発熱、背部痛、排尿痛増悪があれば早めに再診。"
    ]
  };
}

function urineBasic(c) {
  return {
    S: [
      `${c.intro}。排尿回数が増えた気がするが、発熱はない。`,
      `${c.family}に糖尿病があり、本人は尿の異常を心配している。`,
      "他院で当日検査を受けたわけではない。"
    ],
    O: [
      vitals(c),
      "腹部は軟、CVA叩打痛なし。",
      "院内で尿定性・尿蛋白を実施。明らかな強い感染所見はない。",
      "静脈採血や画像検査は本日行っていない。"
    ],
    A: [
      "軽い膀胱刺激症状。尿定性の結果を踏まえて経過を見る。",
      "発熱があれば尿路感染として再評価する。"
    ],
    P: [
      "水分摂取と排尿時痛の変化を説明。",
      "症状が続く場合は再診し、必要に応じて追加評価。"
    ]
  };
}

function cbcCrp(c) {
  return {
    S: [
      `${c.intro}。微熱とだるさがあり、炎症の有無を知りたい。`,
      `${c.external}の採血結果は古く、今回は手元にない。`,
      "抗菌薬は飲んでいない。食事は少量なら取れている。"
    ],
    O: [
      vitals(c),
      "咽頭発赤は軽度。胸部聴診で明らかな湿性ラ音なし。",
      "院内で血算とCRPを測定。同日に静脈採血を実施し、血液検体を提出した。",
      "持参情報は過去情報であり、当日検査とは分けて記録した。"
    ],
    A: [
      "感染または炎症反応の有無を確認する目的で血液検査を行った。",
      "重症感染を示す所見は現時点で乏しい。"
    ],
    P: [
      "休養、水分摂取、悪化時の再診目安を説明。",
      "検査結果を確認し、必要に応じて追加評価する。"
    ]
  };
}

function flu(c) {
  return {
    S: [
      `${c.intro}。周囲でインフルエンザが流行している。`,
      `${c.otc}を使ったが熱感が残る。`,
      "咳と関節痛があり、食事量はやや低下。"
    ],
    O: [
      vitals(c),
      "咽頭発赤軽度、呼吸苦なし。",
      "院内でインフルエンザ抗原迅速を実施。結果を説明した。",
      "胸部画像や採血は本日行っていない。"
    ],
    A: [
      "急性上気道炎。流行状況からインフルエンザを含め評価した。",
      "脱水や呼吸不全を示す所見はない。"
    ],
    P: [
      "自宅療養、水分摂取、解熱薬の使い方を説明。",
      "呼吸苦や摂取不良があれば早めに受診。"
    ]
  };
}

function strep(c) {
  return {
    S: [
      `${c.intro}。喉の痛みが強く、食事を飲み込みにくい。`,
      `${c.external}で似た症状が出ていると聞いた。`,
      "咳は軽く、腹痛や発疹はない。"
    ],
    O: [
      vitals(c),
      "咽頭発赤あり。扁桃腫脹軽度、頸部リンパ節圧痛少し。",
      "院内で溶連菌迅速を実施。同日に静脈採血を実施し、血液検体を提出した。",
      "インフルエンザ検査や胸部画像は本日行っていない。"
    ],
    A: [
      "急性咽頭炎。溶連菌感染の可能性を確認した。",
      "脱水や気道狭窄の所見は乏しい。"
    ],
    P: [
      "水分摂取、解熱鎮痛薬、登園・出勤の目安を説明。",
      "発疹、呼吸苦、強い摂取不良があれば再診。"
    ]
  };
}

function covidFlu(c) {
  return {
    S: [
      `${c.intro}。家族内で発熱者が続いており、感染の有無を知りたい。`,
      `${c.otc}で少し下がったが、倦怠感が強い。`,
      "味覚低下はなく、息苦しさもない。"
    ],
    O: [
      vitals(c),
      "咽頭発赤軽度。胸部聴診で明らかなラ音なし。",
      "院内でコロナ・インフル同時抗原を実施。同日に静脈採血を実施し、血液検体を提出した。",
      "胸部X線は本日行っていない。過去検査結果の持参なし。"
    ],
    A: [
      "急性発熱。流行状況から新型コロナとインフルエンザを同時に評価した。",
      "呼吸状態は安定している。"
    ],
    P: [
      "結果に応じた療養、出勤・登校の目安を説明。",
      "呼吸苦、SpO2低下、摂取不良があれば再診。"
    ]
  };
}

function sameMonthLab(c) {
  return {
    S: [
      `${c.intro}。同じ月に似た検査をした記憶があるが、日付は曖昧。`,
      `${c.external}の結果も一部持参しているが、当院分と混ざっている。`,
      "症状は軽度で、急激な悪化はない。"
    ],
    O: [
      vitals(c),
      "診察では緊急性の高い所見は乏しい。",
      "検査を検討したが、同じ月に当院で行った検査があるか院内履歴の照合が必要。",
      "持参結果は外部資料として扱い、当日実施分とは分けた。"
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
      `${c.intro}。${test}を調べた方がよいか相談したい。`,
      `${c.external}で関連する数値を見た記憶があるが、検査票はない。`,
      "本人は結果の意味を知りたいが、測定条件は本文だけでは分からない。"
    ],
    O: [
      vitals(c),
      `${test}について確認する方針を立てたが、検査方法や区分は本文だけでは追えない。`,
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
      `${c.intro}。本日は検査を増やす希望はない。`,
      `${c.otc}を使ったが、現在は落ち着いている。`
    ],
    O: [
      vitals(c),
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
      `${c.intro}。画像検査を受けた方がよいか相談。`,
      `${c.family}が大きな病気を心配している。`,
      "本日は時間がなく、長い検査は希望しない。"
    ],
    O: [
      vitals(c),
      "診察では急性悪化を示す所見は乏しい。",
      "CTやX線は次回以降の選択肢として説明したが、本日は画像検査を実施していない。",
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

function simpleXray(c) {
  return {
    S: [
      `${c.intro}。咳や痛みが続き、写真で確認したいと希望。`,
      `${c.external}で以前に異常なしと言われたが、結果票はない。`,
      `${c.otc}で症状は少し楽になった。`
    ],
    O: [
      vitals(c),
      "聴診または局所診察で緊急性の高い所見は乏しい。",
      "当院で単純X線撮影を実施。明らかな急性所見は認めない。",
      "CT、MRIは本日行っていない。過去画像は本人申告のみ。"
    ],
    A: [
      "症状の確認目的で単純写真を行った。",
      "急性疾患を強く示す所見は乏しい。"
    ],
    P: [
      "画像所見を説明し、悪化時の再診目安を伝えた。",
      "症状が続く場合は追加評価を検討する。"
    ]
  };
}

function simpleXrayFacility(c) {
  return simpleXray({
    ...c,
    intro: `${c.intro}。院内で画像を確認して説明してほしいと希望`
  });
}

function ctRevisit(c) {
  return ctSoap(c, false);
}

function ctInitial(c) {
  return ctSoap(c, true);
}

function ctSoap(c, initial) {
  return {
    S: [
      `${c.intro}。${initial ? "今回が当院で初めての相談" : "前回から症状が続き再診"}。`,
      "腹部や頭部の症状があり、本人は大きな病気ではないか心配している。",
      `${c.external}で以前検査を受けたが、結果票は持参していない。`
    ],
    O: [
      vitals(c),
      "診察ではただちに搬送を要する所見は乏しい。",
      "当院でCTを施行。緊急対応を要する明らかな所見は認めない。",
      "単純X線やMRIは本日行っていない。外部画像の読影も行っていない。"
    ],
    A: [
      "症状の原因確認としてCTを行った。",
      "画像上、急性重症疾患を強く示す所見は乏しい。"
    ],
    P: [
      "画像所見を説明し、症状が続く場合の再診目安を伝えた。",
      "悪化時は救急受診も含めて説明した。"
    ]
  };
}

function contrastUnknown(c) {
  return {
    S: [
      `${c.intro}。CTで確認したいが、造影剤を使う検査だったか本人は分からない。`,
      "アレルギー歴はないが、過去の画像検査の詳細は覚えていない。",
      `${c.family}も説明に同席した。`
    ],
    O: [
      vitals(c),
      "当院でCTを実施。急性所見は乏しい。",
      "造影剤を使ったかどうかは検査記録との照合が必要で、診察本文だけでは読み取れない。",
      "単純X線やMRIは本日行っていない。"
    ],
    A: [
      "症状評価としてCTを行った。",
      "造影の有無は画像実施記録で整理する。"
    ],
    P: [
      "画像所見を説明し、検査記録を確認して必要があれば補足する。",
      "症状増悪時は早めに受診。"
    ]
  };
}

function equipmentUnknown(c) {
  return {
    S: [
      `${c.intro}。CTでの確認を希望。`,
      "本人は検査の細かな条件までは説明を覚えていない。",
      `${c.otc}で症状は少し軽くなった。`
    ],
    O: [
      vitals(c),
      "当院でCTを実施。明らかな緊急所見は認めない。",
      "使用した装置の種類は診察本文には残っておらず、検査実施記録との照合が必要。",
      "MRIや単純X線は本日行っていない。"
    ],
    A: [
      "症状評価としてCTを行った。",
      "画像の実施条件は本文とは別の記録で確認する。"
    ],
    P: [
      "画像所見と再診目安を説明。",
      "検査記録を整理して必要時に補足説明する。"
    ]
  };
}

function splitMultiDay(c) {
  return {
    S: [
      "入院中または経過観察中のメモが1つの欄にまとまっている。",
      "6/10は発熱、6/11は解熱傾向、6/12は食事再開と記載がある。",
      "本人や家族も日ごとの変化を混同している。"
    ],
    O: [
      "6/10: KT 38.0、食欲低下。6/11: KT 37.1、歩行可。6/12: KT 36.8、食事半量。",
      "同じ記録内に複数日のバイタル、説明、予定が並んでいる。",
      "どの日の実施内容か本文だけでは一部追いにくい。"
    ],
    A: [
      "複数日の経過が混在。日別の内容確認が必要。",
      "一括した記載のままでは当日分の判断が難しい。"
    ],
    P: [
      "日付ごとに実施内容、予定、説明を分けて記録を整理する。",
      "看護記録やオーダー履歴と照合する。"
    ]
  };
}

function unsupportedSoap(c, theme, line, assessment) {
  return {
    S: [
      `${c.intro}。${theme}に関係する説明を以前受けたことがあり、不安が残っている。`,
      `${c.external}の情報や家族の説明も混ざっている。`,
      `${c.otc}を使ったが大きな変化はない。`
    ],
    O: [
      vitals(c),
      "診察上、ただちに救急搬送を要する所見は乏しい。",
      line,
      "本日当院で実施した内容と、今後検討する内容を分けて記録した。"
    ],
    A: [
      `${theme}に関連する相談。`,
      assessment
    ],
    P: [
      "専門記録、紹介状、実施記録を確認してから扱いを整理する。",
      "症状が悪化する場合は早めに受診。"
    ]
  };
}

function anesthesiaUnsupported(c) { return unsupportedSoap(c, "麻酔前評価", "麻酔方法、面接時間、薬剤使用の有無は術前記録で確認する必要がある。", "麻酔領域として扱う場合は専門記録との照合が必要。"); }
function psychiatryUnsupported(c) { return unsupportedSoap(c, "心理面の支援", "不眠や不安に対して話を聞いたが、専門療法の時間や形式は本文だけでは判断できない。", "精神科専門領域として扱う場合は記録形式の確認が必要。"); }
function rehabUnsupported(c) { return unsupportedSoap(c, "運動訓練", "関節可動域と歩行練習について話したが、実施単位や療法士記録は本文にない。", "リハビリ領域として扱うには実施単位と職種記録の確認が必要。"); }
function homecareUnsupported(c) { return unsupportedSoap(c, "訪問診療の相談", "家族から訪問診療の希望が出たが、本日は外来で相談したのみ。", "在宅医療として扱うかは訪問日、訪問先、実施内容の確認が必要。"); }
function pathologyUnsupported(c) { return unsupportedSoap(c, "生検検体の提出", "皮膚や粘膜病変の標本を出す可能性を説明したが、提出先や標本種類は整理が必要。", "病理領域として扱う場合は標本種類と提出記録の確認が必要。"); }
function endoscopyUnsupported(c) { return unsupportedSoap(c, "内視鏡検査の方針", "内視鏡を行う可能性を説明したが、本日実施か予約か、生検有無は本文から分けにくい。", "内視鏡領域として扱う場合は実施日と生検有無の確認が必要。"); }
function dialysisUnsupported(c) { return unsupportedSoap(c, "透析後症状", "透析は他院で受けており、時間や除水量は記録持参がない。", "透析領域として扱うには実施施設と透析時間の確認が必要。"); }
function transfusionUnsupported(c) { return unsupportedSoap(c, "輸血歴と貧血相談", "以前の輸血歴を本人が話したが、本日輸血を行った記録はない。", "輸血領域として扱う場合は製剤、量、実施時刻の確認が必要。"); }
function radiationUnsupported(c) { return unsupportedSoap(c, "放射線治療", "照射部位や回数、線量の記録は専門科の計画書で確認する必要がある。", "放射線治療の対象病変と照射条件は本文だけでは判断しにくい。"); }
function surgeryUnsupported(c) { return unsupportedSoap(c, "腫瘤切除または創部の手術", "体表のしこりを切除する可能性について説明したが、術式や実施範囲は専門記録で確認する。", "切除・摘出の扱いは高リスク領域として人手確認が必要。"); }

function generalReview(c) {
  return {
    S: [`${c.intro}。本人は当日行った内容と今後の予定を整理したい。`, `${c.external}の情報と当院の記録が混ざっている。`],
    O: [vitals(c), "診察上、急性悪化を示す所見は乏しい。", "当日実施、予定、過去情報を分けて記録した。"],
    A: ["診療内容の確認が必要。"],
    P: ["院内記録と持参資料を照合し、必要な項目を整理する。"]
  };
}

function familyCode(family) {
  return {
    urineBloodManagement: "LABB", urineBasic: "LABU", cbcCrp: "LABC", flu: "LABF", strep: "LABS", covidFlu: "LABCF",
    sameMonthLab: "LABSM", ambiguousLab: "LABQ", externalLabSafety: "LABEXT", simpleXray: "XR", simpleXrayFacility: "XRF",
    ctRevisit: "CT", ctInitial: "CTI", contrastUnknown: "IMGCON", equipmentUnknown: "IMGEQ", plannedImagingSafety: "IMGPL",
    splitMultiDay: "SPLIT", anesthesiaUnsupported: "ANES", psychiatryUnsupported: "PSY", rehabUnsupported: "REH",
    homecareUnsupported: "HOME", pathologyUnsupported: "PATH", endoscopyUnsupported: "ENDO", dialysisUnsupported: "DIAL",
    transfusionUnsupported: "TRANS", radiationUnsupported: "RADTX", surgeryUnsupported: "SURG"
  }[family] || "REV";
}

function titleFor(blueprint, family, n) {
  const base = {
    simpleXray: "単純写真",
    simpleXrayFacility: "単純写真と院内画像確認",
    ctRevisit: "再診CT",
    ctInitial: "初診CT",
    contrastUnknown: "造影有無確認",
    equipmentUnknown: "CT実施条件確認",
    plannedImagingSafety: "画像予定のみ",
    urineBloodManagement: "尿定性と採血",
    urineBasic: "尿定性",
    cbcCrp: "血算とCRP",
    flu: "インフル抗原",
    strep: "溶連菌迅速",
    covidFlu: "コロナ・インフル同時抗原",
    sameMonthLab: "同月検査履歴",
    ambiguousLab: "検査方法確認",
    externalLabSafety: "外部検査結果相談"
  }[family] || "要確認";
  return `${deptLabel(blueprint.department)} ${base} ${n}`;
}

function distractorsFor(family, c) {
  const extras = {
    simpleXray: [{ type: "negated_exam", name: "CT", note: "本日なし" }],
    simpleXrayFacility: [{ type: "external_result", name: "過去画像", note: "過去情報" }],
    ctRevisit: [{ type: "negated_exam", name: "単純X線", note: "本日なし" }],
    ctInitial: [{ type: "external_result", name: "過去検査", note: "外部情報" }],
    contrastUnknown: [{ type: "missing_attribute", name: "造影有無", note: "検査記録確認" }],
    equipmentUnknown: [{ type: "missing_attribute", name: "装置の種類", note: "検査記録確認" }],
    plannedImagingSafety: [{ type: "planned_exam", name: "画像検査", note: "予定のみ" }],
    sameMonthLab: [{ type: "same_month_history", name: "同月検査", note: "履歴確認" }],
    ambiguousLab: [{ type: "missing_method", name: "測定方法", note: "方法不明" }],
    externalLabSafety: [{ type: "external_result", name: "結果票", note: "持参結果" }]
  };
  return [
    ...(extras[family] || []),
    { type: "external_result", name: c.external, note: "当日自院実施ではない情報" },
    { type: "otc_or_home_med", name: c.otc, note: "自己判断で使用" }
  ].slice(0, 3);
}

function realismAxesFor(blueprint, family) {
  const parts = String(blueprint.caseTypeKey || "").split(".");
  return Array.from(new Set([
    family,
    ...parts.filter((part) => ["normal_negative_result", "planned_order", "past_value", "external_result", "quantity_missing", "otc_or_home_med", "family_history", "negated_action"].includes(part))
  ]));
}

function authoredFor(blueprint, index) {
  const n = index + 292;
  const family = familyOf(blueprint);
  const c = contextFor(blueprint, index);
  return {
    blueprintId: blueprint.blueprintId,
    caseId: `V2-${deptCode(blueprint.department)}-${familyCode(family)}-${String(n).padStart(3, "0")}`,
    title: titleFor(blueprint, family, n),
    patient: patientFor(blueprint, n),
    realismAxes: realismAxesFor(blueprint, family),
    distractors: distractorsFor(family, c),
    soap: soapFor(blueprint, family, index)
  };
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
      const suffix = neutralSuffix(seed++);
      entry.item.soap[entry.section] = entry.item.soap[entry.section].map((line) => (line === entry.line ? `${line} ${suffix}` : line));
    }
  }
  return authoredCases;
}

function neutralSuffix(seed) {
  const times = ["朝", "午前", "昼過ぎ", "夕方", "就寝前", "外出後", "食後", "安静時"];
  const subjects = ["症状の強さ", "生活への影響", "家族の見守り", "市販薬の使用", "水分摂取", "睡眠", "仕事への支障", "前日との違い"];
  const predicates = ["も合わせて聴取した", "は本文内で別に整理した", "について次回も確認する", "は大きな変化なし", "は本人の説明を確認した"];
  return `${times[seed % times.length]}の${subjects[Math.floor(seed / times.length) % subjects.length]}${predicates[Math.floor(seed / (times.length * subjects.length)) % predicates.length]}。`;
}

const authoredCases = dedupeRepeatedChartLines(selectedBlueprints.map((blueprint, index) => authoredFor(blueprint, index)));

export const cases = buildBlueprintCases(authoredCases);
