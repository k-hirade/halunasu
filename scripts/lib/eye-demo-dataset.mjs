// 眼科カルテのデモ用データ。実在の人物・医療機関とは関係のない架空の患者。
// 日付はすべて「デモ当日」からの相対で作り、いつ投入しても経過がそれらしく見えるようにする。

export const EYE_DEMO_PATIENT_NUMBER_PREFIX = "D";

const LATANOPROST = { kind: "eye_drop", name: "ラタノプロスト点眼液0.005%", eye: "ou", timesPerDay: 1, unit: "本" };
const TIMOLOL = { kind: "eye_drop", name: "チモロールマレイン酸塩点眼液0.5%", eye: "ou", timesPerDay: 2, unit: "本" };
const HYALEIN = { kind: "eye_drop", name: "ヒアルロン酸ナトリウム点眼液0.1%", eye: "ou", timesPerDay: 4, unit: "本" };
const DIQUAS = { kind: "eye_drop", name: "ジクアホソルナトリウム点眼液3%", eye: "ou", timesPerDay: 6, unit: "本" };
const OLOPATADINE = { kind: "eye_drop", name: "オロパタジン点眼液0.1%", eye: "ou", timesPerDay: 4, unit: "本" };
const LEVOFLOXACIN = { kind: "eye_drop", name: "レボフロキサシン点眼液1.5%", eye: "od", timesPerDay: 4, unit: "本" };
const BETAMETHASONE = { kind: "eye_drop", name: "ベタメタゾンリン酸エステルNa点眼液0.1%", eye: "od", timesPerDay: 4, unit: "本" };
const BROMFENAC = { kind: "eye_drop", name: "ブロムフェナクNa点眼液0.1%", eye: "od", timesPerDay: 2, unit: "本" };
const LOW_ATROPINE = { kind: "eye_drop", name: "低濃度アトロピン点眼液0.01%", eye: "ou", timesPerDay: 1, unit: "本" };

export const EYE_DEMO_DRUG_PRESETS = Object.freeze([
  { name: LATANOPROST.name, kind: "eye_drop", defaultTimesPerDay: 1, bottleVolumeMl: 2.5, dropsPerBottle: 80 },
  { name: TIMOLOL.name, kind: "eye_drop", defaultTimesPerDay: 2, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: HYALEIN.name, kind: "eye_drop", defaultTimesPerDay: 4, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: DIQUAS.name, kind: "eye_drop", defaultTimesPerDay: 6, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: OLOPATADINE.name, kind: "eye_drop", defaultTimesPerDay: 4, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: LEVOFLOXACIN.name, kind: "eye_drop", defaultTimesPerDay: 4, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: BETAMETHASONE.name, kind: "eye_drop", defaultTimesPerDay: 4, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: BROMFENAC.name, kind: "eye_drop", defaultTimesPerDay: 2, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: LOW_ATROPINE.name, kind: "eye_drop", defaultTimesPerDay: 1, bottleVolumeMl: 5, dropsPerBottle: 120 },
  { name: "アフリベルセプト硝子体内注射", kind: "injection", defaultTimesPerDay: null, bottleVolumeMl: null, dropsPerBottle: null }
]);

export const EYE_DEMO_ORDER_SETS = Object.freeze([
  {
    name: "緑内障 定期（視野あり）",
    prescriptions: [{ ...LATANOPROST, usage: "就寝前" }],
    orders: [{ code: "vf_static", name: "静的視野検査", kind: "exam", eye: "ou" }, { code: "oct_disc", name: "OCT（視神経乳頭）", kind: "exam", eye: "ou" }],
    plan: "点眼継続。次回12週後。"
  },
  {
    name: "白内障術後1週",
    prescriptions: [{ ...LEVOFLOXACIN, usage: "毎食後・就寝前" }, { ...BETAMETHASONE, usage: "毎食後・就寝前" }, { ...BROMFENAC, usage: "朝・夕" }],
    orders: [],
    plan: "術後経過良好。点眼3剤継続。次回2週後。"
  },
  {
    name: "抗VEGF注射（右眼）",
    prescriptions: [{ kind: "injection", name: "アフリベルセプト硝子体内注射", eye: "od" }],
    orders: [{ code: "oct_retina", name: "OCT（網膜）", kind: "exam", eye: "od" }, { code: "ivi", name: "硝子体内注射", kind: "procedure", eye: "od" }],
    plan: "注射施行。"
  },
  {
    name: "アレルギー性結膜炎",
    prescriptions: [{ ...OLOPATADINE, usage: "かゆい時" }],
    orders: [],
    plan: "抗アレルギー点眼。症状時に再診。"
  }
]);

export const EYE_DEMO_PHRASES = Object.freeze([
  { target: "chiefComplaint", label: "定期検査", text: "定期検査。自覚症状の変化なし。" },
  { target: "findings.anterior", label: "前眼部 正常", text: "前房深い 清明" },
  { target: "findings.lens", label: "IOL 良好", text: "IOL 嚢内固定 良好" },
  { target: "findings.fundus", label: "眼底 異常なし", text: "異常なし" },
  { target: "plan", label: "点眼継続", text: "点眼継続。次回同様。" },
  { target: "plan", label: "アドヒアランス指導", text: "点眼の時間を決めるよう指導（歯みがきの後など）。" }
]);

export function buildEyeDemoDataset({ today }) {
  const day = (offset) => addDays(today, offset);

  const patients = [
    {
      key: "glaucoma",
      profile: { allergies: [{ category: "drug", substance: "ペニシリン系抗菌薬", reaction: "発疹", severity: "moderate" }], medicalHistory: "高血圧（内服中）" },
      patient: { displayName: "見本 花子", displayNameKana: "ミホン ハナコ", birthDate: "1953-04-12", sex: "female", primaryPatientNumber: "D001" },
      visits: glaucomaVisits(day),
      appointment: { time: "09:00", purpose: "revisit", note: "視野検査あり" }
    },
    {
      key: "dme",
      profile: { noKnownAllergies: true, medicalHistory: "2型糖尿病（内科通院中）・高血圧" },
      patient: { displayName: "試験 一郎", displayNameKana: "シケン イチロウ", birthDate: "1957-09-03", sex: "male", primaryPatientNumber: "D002" },
      visits: dmeVisits(day),
      appointment: { time: "09:30", purpose: "injection", note: "右眼 抗VEGF注射予定・OCT" }
    },
    {
      key: "postop",
      profile: { allergies: [{ category: "drug", substance: "ヨード", reaction: "じんましん", severity: "severe" }], ophthalmicHistory: "右眼 白内障手術（PEA+IOL）" },
      patient: { displayName: "模擬 和子", displayNameKana: "モギ カズコ", birthDate: "1950-01-21", sex: "female", primaryPatientNumber: "D003" },
      visits: cataractVisits(day),
      appointment: { time: "10:00", purpose: "postop", note: "右眼 白内障術後5週" }
    },
    {
      key: "amd",
      profile: { noKnownAllergies: true, medicalHistory: "喫煙歴あり（20本/日×30年、5年前に禁煙）" },
      patient: { displayName: "仮名 健太", displayNameKana: "カメイ ケンタ", birthDate: "1961-06-30", sex: "male", primaryPatientNumber: "D004" },
      visits: amdVisits(day),
      appointment: { time: "10:30", purpose: "injection", note: "左眼 注射（8週間隔）" }
    },
    {
      key: "allergy",
      profile: { allergies: [{ category: "other", substance: "スギ花粉", reaction: "結膜炎・鼻炎", severity: "mild" }], contactLensUser: true },
      patient: { displayName: "架空 美咲", displayNameKana: "カクウ ミサキ", birthDate: "1991-11-08", sex: "female", primaryPatientNumber: "D005" },
      visits: allergyVisits(day),
      appointment: { time: "11:00", purpose: "revisit", note: "かゆみ再燃" }
    },
    {
      key: "myopia",
      profile: { noKnownAllergies: true },
      patient: { displayName: "想定 翔太", displayNameKana: "ソウテイ ショウタ", birthDate: "2014-05-17", sex: "male", primaryPatientNumber: "D006" },
      visits: myopiaVisits(day),
      appointment: { time: "14:00", purpose: "exam", note: "学校健診で視力低下の指摘" }
    },
    {
      key: "dryeye",
      profile: { medicalHistory: "シェーグレン症候群の疑い（内科で精査中）" },
      patient: { displayName: "例示 節子", displayNameKana: "レイジ セツコ", birthDate: "1946-02-02", sex: "female", primaryPatientNumber: "D007" },
      visits: dryEyeVisits(day),
      appointment: { time: "14:30", purpose: "revisit", note: "" }
    }
  ];

  // 未登録の初診患者。受付で患者登録する流れのデモに使う。
  const unregisteredAppointments = [
    { patientName: "初診 太郎", time: "15:00", purpose: "initial", note: "電話予約・右眼の飛蚊症" }
  ];

  return { patients, unregisteredAppointments, drugPresets: EYE_DEMO_DRUG_PRESETS, orderSets: EYE_DEMO_ORDER_SETS, phrases: EYE_DEMO_PHRASES };
}

function glaucomaVisits(day) {
  const base = (iopOd, iopOs, vaOd, vaOs, prescriptions, plan, extra = {}) => ({
    chiefComplaint: "緑内障の定期検査",
    exam: {
      od: { vaUncorrected: "0.4", vaCorrected: vaOd, correction: { sphere: -1.25, cylinder: -0.5, axis: 90 }, iop: iopOd, iopMethod: "nct" },
      os: { vaUncorrected: "0.3", vaCorrected: vaOs, correction: { sphere: -1.5, cylinder: -0.75, axis: 85 }, iop: iopOs, iopMethod: "nct" }
    },
    findings: {
      od: { anterior: "前房深い 清明", lens: "軽度核白内障", fundus: "C/D 0.7 下方リムの菲薄化" },
      os: { anterior: "前房深い 清明", lens: "軽度核白内障", fundus: "C/D 0.6" }
    },
    diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }],
    prescriptions,
    plan,
    nextVisit: { intervalWeeks: 12, note: extra.nextNote || "" },
    sketches: extra.sketches || []
  });
  return [
    { date: day(-728), visitType: "initial", content: { ...base(23, 21, "1.0", "1.0", [{ ...LATANOPROST, quantity: 2 }], "眼圧高値。ラタノプロスト開始。", { sketches: [discSketch("od", 0.7)] }), chiefComplaint: "健診で緑内障の疑いを指摘された", history: "人間ドックで視神経乳頭陥凹拡大を指摘。自覚症状なし。" } },
    { date: day(-644), visitType: "revisit", content: base(17, 16, "1.0", "1.0", [{ ...LATANOPROST, quantity: 2 }], "点眼で眼圧下降良好。継続。") },
    { date: day(-560), visitType: "revisit", content: base(16, 16, "1.0", "0.9", [{ ...LATANOPROST, quantity: 2 }], "継続。次回視野検査。") },
    { date: day(-476), visitType: "revisit", content: base(18, 17, "1.0", "0.9", [{ ...LATANOPROST, quantity: 2 }], "視野 MD 右-4.2dB 左-2.1dB。継続。") },
    { date: day(-392), visitType: "revisit", content: base(20, 18, "0.9", "0.9", [{ ...LATANOPROST, quantity: 2 }], "眼圧やや上昇。点眼アドヒアランス確認。") },
    { date: day(-308), visitType: "revisit", content: base(21, 19, "0.9", "0.9", [{ ...LATANOPROST, quantity: 2 }, { ...TIMOLOL, quantity: 2 }], "目標眼圧未達。チモロール追加。") },
    { date: day(-224), visitType: "revisit", content: base(16, 15, "0.9", "0.9", [{ ...LATANOPROST, quantity: 2 }, { ...TIMOLOL, quantity: 2 }], "2剤で眼圧良好。継続。") },
    { date: day(-140), visitType: "revisit", content: base(15, 15, "0.9", "0.8", [{ ...LATANOPROST, quantity: 2 }, { ...TIMOLOL, quantity: 2 }], "継続。視野 MD 右-4.8dB 左-2.4dB。") },
    { date: day(-84), visitType: "revisit", content: base(17, 16, "0.9", "0.8", [{ ...LATANOPROST, quantity: 2 }, { ...TIMOLOL, quantity: 2 }], "継続。次回視野検査。", { nextNote: "視野検査" }) }
  ];
}

function dmeVisits(day) {
  const visit = (date, vaOd, iopOd, fundusOd, plan, injection, intervalWeeks) => ({
    date: day(date),
    visitType: date === -280 ? "initial" : "revisit",
    content: {
      chiefComplaint: date === -280 ? "右眼が見えにくい" : "注射の経過観察",
      history: date === -280 ? "2型糖尿病 HbA1c 7.8%。内科通院中。" : "",
      exam: {
        od: { vaUncorrected: "0.2", vaCorrected: vaOd, iop: iopOd, iopMethod: "nct" },
        os: { vaUncorrected: "0.5", vaCorrected: "1.0", iop: 15, iopMethod: "nct" }
      },
      findings: {
        od: { anterior: "清明", lens: "軽度白内障", fundus: fundusOd },
        os: { anterior: "清明", lens: "軽度白内障", fundus: "単純糖尿病網膜症 点状出血少数" }
      },
      diagnoses: [{ name: "糖尿病黄斑浮腫", eye: "od" }, { name: "糖尿病網膜症", eye: "ou" }],
      prescriptions: injection ? [{ kind: "injection", name: "アフリベルセプト硝子体内注射", eye: "od" }] : [],
      plan,
      nextVisit: { intervalWeeks },
      sketches: date === -280 ? [maculaSketch("od")] : []
    }
  });
  return [
    visit(-280, "0.4", 15, "黄斑浮腫あり CST 452μm 硬性白斑", "右眼 DME。抗VEGF 導入（月1回×3）。", true, 4),
    visit(-252, "0.5", 15, "浮腫軽減 CST 380μm", "2回目注射。", true, 4),
    visit(-224, "0.7", 14, "浮腫軽減 CST 310μm", "3回目注射。以後 treat and extend。", true, 6),
    visit(-182, "0.7", 15, "浮腫なし CST 290μm", "注射。8週へ延長。", true, 8),
    visit(-126, "0.6", 16, "軽度再燃 CST 335μm", "再燃のため注射。6週へ短縮。", true, 6),
    visit(-84, "0.7", 15, "浮腫なし CST 298μm", "注射。6週で継続。", true, 6),
    visit(-42, "0.7", 15, "浮腫なし CST 292μm", "注射。次回8週へ延長を検討。", true, 6)
  ];
}

function cataractVisits(day) {
  const odPostop = (va, iop, fundus, prescriptions, plan, weeks) => ({
    exam: {
      od: { vaUncorrected: va, vaCorrected: va === "1.0" ? "1.2" : "1.0", iop, iopMethod: "nct" },
      os: { vaUncorrected: "0.4", vaCorrected: "0.7", iop: 14, iopMethod: "nct" }
    },
    findings: {
      od: { anterior: "前房清明 創部閉鎖良好", lens: "IOL 嚢内固定", fundus },
      os: { anterior: "清明", lens: "核白内障 NS2", fundus: "異常なし" }
    },
    diagnoses: [{ name: "白内障術後", eye: "od" }, { name: "加齢性白内障", eye: "os" }],
    prescriptions,
    plan,
    nextVisit: { intervalWeeks: weeks }
  });
  return [
    { date: day(-120), visitType: "initial", content: {
      chiefComplaint: "右眼がかすむ・まぶしい",
      exam: { od: { vaUncorrected: "0.2", vaCorrected: "0.3", iop: 14, iopMethod: "nct" }, os: { vaUncorrected: "0.4", vaCorrected: "0.7", iop: 14, iopMethod: "nct" } },
      findings: { od: { anterior: "清明", lens: "核白内障 NS3 皮質混濁", fundus: "透見不良だが大きな異常なし" }, os: { anterior: "清明", lens: "核白内障 NS2", fundus: "異常なし" } },
      diagnoses: [{ name: "加齢性白内障", eye: "ou" }],
      plan: "右眼の手術を希望。術前検査予約。",
      nextVisit: { intervalWeeks: 4 }
    } },
    { date: day(-42), visitType: "revisit", content: odPostop("0.7", 16, "異常なし", [{ ...LEVOFLOXACIN, quantity: 1 }, { ...BETAMETHASONE, quantity: 1 }, { ...BROMFENAC, quantity: 1 }], "右眼 白内障手術翌日。点眼3剤開始。", 1) },
    { date: day(-35), visitType: "revisit", content: odPostop("1.0", 14, "異常なし", [{ ...LEVOFLOXACIN, quantity: 1 }, { ...BETAMETHASONE, quantity: 1 }, { ...BROMFENAC, quantity: 1 }], "術後1週。経過良好。", 2) },
    { date: day(-21), visitType: "revisit", content: odPostop("1.0", 13, "黄斑浮腫なし", [{ ...BETAMETHASONE, quantity: 1 }, { ...BROMFENAC, quantity: 1 }], "術後3週。抗菌薬終了。", 2) }
  ];
}

function amdVisits(day) {
  const visit = (offset, vaOs, fundus, plan, weeks, initial = false) => ({
    date: day(offset),
    visitType: initial ? "initial" : "revisit",
    content: {
      chiefComplaint: initial ? "左眼で物がゆがんで見える" : "注射の経過観察",
      exam: { od: { vaUncorrected: "0.8", vaCorrected: "1.0", iop: 14, iopMethod: "nct" }, os: { vaUncorrected: "0.2", vaCorrected: vaOs, iop: 15, iopMethod: "nct" } },
      findings: { od: { anterior: "清明", lens: "軽度白内障", fundus: "ドルーゼン少数" }, os: { anterior: "清明", lens: "軽度白内障", fundus } },
      diagnoses: [{ name: "滲出型加齢黄斑変性", eye: "os" }],
      prescriptions: [{ kind: "injection", name: "アフリベルセプト硝子体内注射", eye: "os" }],
      plan,
      nextVisit: { intervalWeeks: weeks },
      sketches: initial ? [maculaSketch("os")] : []
    }
  });
  return [
    visit(-200, "0.2", "黄斑部出血 網膜下液 CNV", "左眼 nAMD。導入期注射開始。", 4, true),
    visit(-172, "0.3", "網膜下液減少", "2回目注射。", 4),
    visit(-144, "0.3", "網膜下液消失", "3回目注射。", 8),
    visit(-88, "0.3", "網膜下液なし", "注射。8週継続。", 8),
    visit(-32, "0.3", "網膜下液なし", "注射。8週継続。", 8)
  ];
}

function allergyVisits(day) {
  return [{
    date: day(-210),
    visitType: "initial",
    content: {
      chiefComplaint: "両眼のかゆみ・充血",
      history: "毎年春に症状。花粉症あり。",
      exam: { od: { vaUncorrected: "1.2", iop: 13, iopMethod: "nct" }, os: { vaUncorrected: "1.2", iop: 13, iopMethod: "nct" } },
      findings: { od: { anterior: "結膜充血 乳頭増殖軽度", lens: "", fundus: "" }, os: { anterior: "結膜充血 乳頭増殖軽度", lens: "", fundus: "" } },
      diagnoses: [{ name: "アレルギー性結膜炎", eye: "ou" }],
      prescriptions: [{ ...OLOPATADINE, quantity: 2 }],
      plan: "抗アレルギー点眼。症状時に再診。",
      nextVisit: {}
    }
  }];
}

function myopiaVisits(day) {
  const visit = (offset, vaOd, vaOs, sphereOd, sphereOs, plan, initial = false) => ({
    date: day(offset),
    visitType: initial ? "initial" : "revisit",
    content: {
      chiefComplaint: initial ? "黒板が見えにくい" : "近視の経過観察",
      exam: {
        od: { vaUncorrected: vaOd, vaCorrected: "1.2", refraction: { sphere: sphereOd, cylinder: -0.25, axis: 180 }, iop: 12, iopMethod: "nct" },
        os: { vaUncorrected: vaOs, vaCorrected: "1.2", refraction: { sphere: sphereOs, cylinder: -0.5, axis: 175 }, iop: 12, iopMethod: "nct" }
      },
      findings: { od: { anterior: "清明", lens: "透明", fundus: "異常なし" }, os: { anterior: "清明", lens: "透明", fundus: "異常なし" } },
      diagnoses: [{ name: "近視", eye: "ou" }],
      prescriptions: [{ ...LOW_ATROPINE, quantity: 1 }],
      plan,
      nextVisit: { intervalWeeks: 24 }
    }
  });
  return [
    visit(-380, "0.5", "0.6", -1.0, -0.75, "調節麻痺下屈折。低濃度アトロピン開始。眼鏡処方。", true),
    visit(-200, "0.4", "0.4", -1.5, -1.25, "近視進行あり。継続。")
  ];
}

function dryEyeVisits(day) {
  const visit = (offset, plan, prescriptions, initial = false) => ({
    date: day(offset),
    visitType: initial ? "initial" : "revisit",
    content: {
      chiefComplaint: initial ? "目がしょぼしょぼする・乾く" : "ドライアイの経過",
      exam: { od: { vaUncorrected: "0.5", vaCorrected: "0.8", iop: 12, iopMethod: "nct" }, os: { vaUncorrected: "0.5", vaCorrected: "0.8", iop: 12, iopMethod: "nct" } },
      findings: { od: { anterior: "角膜下方 点状表層角膜症 BUT 3秒", lens: "核白内障 NS2", fundus: "異常なし" }, os: { anterior: "角膜下方 SPK BUT 3秒", lens: "核白内障 NS2", fundus: "異常なし" } },
      diagnoses: [{ name: "ドライアイ", eye: "ou" }, { name: "加齢性白内障", eye: "ou" }],
      prescriptions,
      plan,
      nextVisit: { intervalWeeks: 8 }
    }
  });
  return [
    visit(-150, "ヒアルロン酸点眼開始。", [{ ...HYALEIN, quantity: 3 }], true),
    visit(-94, "改善乏しい。ジクアホソル追加。", [{ ...HYALEIN, quantity: 3 }, { ...DIQUAS, quantity: 4 }]),
    visit(-38, "自覚症状改善。継続。", [{ ...HYALEIN, quantity: 3 }, { ...DIQUAS, quantity: 4 }])
  ];
}

// シェーマ: 視神経乳頭の陥凹（緑内障）。座標は 0〜1000 の正規化。
function discSketch(eye, cupRatio) {
  const discX = eye === "os" ? 330 : 670;
  return {
    sketchId: `demo-disc-${eye}`,
    template: "fundus",
    eye,
    caption: `C/D ${cupRatio} 下方リム菲薄化`,
    strokes: [
      { color: "#dc2626", width: 3, points: circlePoints(discX, 500, Math.round(55 * cupRatio)) },
      { color: "#1f2937", width: 3, points: [[discX - 20, 560], [discX - 5, 600], [discX + 15, 620]] }
    ]
  };
}

// シェーマ: 黄斑部の浮腫・出血。
function maculaSketch(eye) {
  return {
    sketchId: `demo-macula-${eye}`,
    template: "fundus",
    eye,
    caption: "黄斑浮腫・出血",
    strokes: [
      { color: "#dc2626", width: 8, points: circlePoints(500, 500, 60) },
      { color: "#dc2626", width: 3, points: [[470, 430], [480, 440]] },
      { color: "#dc2626", width: 3, points: [[540, 560], [552, 566]] },
      { color: "#1f2937", width: 3, points: circlePoints(500, 500, 110) }
    ]
  };
}

function circlePoints(cx, cy, radius) {
  return Array.from({ length: 25 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return [Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius)];
  });
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayInJapan(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
