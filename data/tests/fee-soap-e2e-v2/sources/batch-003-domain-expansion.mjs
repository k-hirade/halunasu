// v2 batch-003: ドメイン展開20件。exact5(検証済みビルディングブロックの新組合せ)+review11+safety3+split1。
// 管理料3種・画像レビュー(機器区分/造影/エコー曖昧)・検査コード確認・手技確認・否定カルテ・休日受診・複数日。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-DERM-MED-031",
    title: "皮膚科 湿疹再診 院外処方(先発品名・一般名なし)",
    department: "dermatology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L1",
    patient: { age: 31, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-22" },
    realismAxes: ["short_lines", "prescription_detail"],
    distractors: [
      { type: "otc_medication", name: "市販保湿剤", note: "市販品。算定しない" }
    ],
    soap: {
      S: [
        "手湿疹で通院中。前回処方の外用でかゆみは半分程度に改善。",
        "食器洗いの際の悪化は続く。市販の保湿剤を併用している。",
        "睡眠への影響はなくなった。新しい部位への拡大なし。",
        "仕事は飲食店勤務で、手袋は着けられる作業と着けられない作業がある。"
      ],
      O: [
        "両手指・手掌に紅斑と軽度の鱗屑。亀裂は治癒傾向。",
        "水疱・膿疱なし。掻破痕は減少。爪周囲に異常なし。",
        "前回と比べ紅斑の範囲は2割ほど縮小。"
      ],
      A: ["手湿疹、改善傾向。接触要因(洗剤)の関与が続いている。"],
      P: [
        "院外処方箋を交付。リンデロンVG軟膏0.12% 10g 1日2回 患部に塗布。",
        "綿手袋+ゴム手袋の二重着用を継続するよう指導。",
        "2週間後に再診。悪化時は早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["手湿疹"],
      requiredBillingSignals: ["処方箋料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["一般名処方加算", "調剤料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-22", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" },
      medication: { delivery_kind: "outside_prescription", prescription_category: "other" }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 135,
      candidateCodes: ["112007410", "120002910"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "処方箋料（リフィル以外・その他）", points: 60 }
    ]
  },
  {
    caseId: "V2-ORTH-IMG-032",
    title: "整形外科 腰痛再診 腰椎XP(電子画像管理なし施設)",
    department: "orthopedics",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 58, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-23" },
    realismAxes: ["abbreviation", "negative_findings", "planned_exam"],
    distractors: [
      { type: "planned_exam", name: "MRI", note: "神経症状出現時に検討。本日は実施なし" },
      { type: "other_provider_history", name: "骨密度検査(健診)", note: "健診での過去検査。算定しない" }
    ],
    soap: {
      S: [
        "慢性腰痛で通院中。1週間前に庭仕事の後から痛みが増悪し再診。",
        "痛みは腰部中央からやや右寄り。下肢への放散なし、しびれなし。",
        "排尿・排便障害なし。夜間痛で目が覚めることはない。",
        "昨年の健診で骨密度がやや低めと言われたとのこと(結果は未持参)。",
        "鎮痛は前回処方の残りの湿布で対応している。",
        "仕事(事務)は継続できているが、長時間の座位で重だるさが出る。"
      ],
      O: [
        "腰部右傍脊柱筋に圧痛と筋緊張。棘突起の叩打痛なし。",
        "SLR両側陰性。下肢筋力・知覚に左右差なし。膝・アキレス腱反射正常。",
        "増悪後の骨傷評価のため腰椎XP 2方向(DR)を施行。",
        "椎体の圧迫骨折なし。椎間板腔の狭小化は軽度(経年変化相当)。すべりなし。"
      ],
      A: [
        "筋筋膜性腰痛の増悪。圧迫骨折は否定的。神経根症状なし。"
      ],
      P: [
        "湿布は残りを継続使用。体幹ストレッチの再開と、庭仕事の中腰姿勢を避ける工夫を指導。",
        "下肢のしびれ・筋力低下が出た場合はMRIを検討すると説明。",
        "骨密度は健診結果を次回持参してもらい、必要なら精査を相談。",
        "2週間後に再診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["腰痛"],
      requiredBillingSignals: ["単純撮影", "写真診断"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["ＭＲＩ撮影", "電子画像管理加算"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-23", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" },
      imaging_orders: [{ kind: "simple_radiography", acquisition_kind: "digital", radiography_diagnostic_kind: "simple_i" }]
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 228,
      candidateCodes: ["112007410", "170000410", "170027910"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "単純撮影（イ）の写真診断", points: 85 },
      { name: "単純撮影（デジタル撮影）", points: 68 }
    ]
  },
  {
    caseId: "V2-PED-LAB-033",
    title: "小児科 咽頭痛初診 溶連菌迅速+採血",
    department: "pediatrics",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 7, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-07-24" },
    realismAxes: ["abbreviation", "family_context", "negated_exam"],
    distractors: [
      { type: "negated_exam", name: "インフルエンザ迅速検査", note: "季節外・接触歴なしで実施せず" },
      { type: "family_context", name: "クラスメイトの溶連菌", note: "接触歴情報" }
    ],
    soap: {
      S: [
        "昨日からの高熱と強い咽頭痛。引っ越してきたばかりで当院は初診。",
        "クラスで溶連菌と診断された子が複数いるとのこと。",
        "咳・鼻汁はほとんどない。嘔気が朝に1回。発疹に母が気づいた(体幹)。",
        "食欲は低下しているが水分は摂れている。アレルギー歴なし。"
      ],
      O: [
        "KT 38.6、P 110。咽頭発赤強く、軟口蓋に点状出血。扁桃白苔(+)。",
        "頸部前方リンパ節に圧痛を伴う腫脹。体幹に細かい紅斑が散在。",
        "咽頭ぬぐい液で溶連菌迅速を施行。陽性。",
        "全身状態の評価のため静脈採血も実施し、血算・生化学を外注へ提出。",
        "咳がなく夏季で周囲の流行もないため、インフルエンザ迅速は実施せず。"
      ],
      A: [
        "Ａ群溶連菌性咽頭炎。猩紅熱様の発疹を伴う。",
        "川崎病を示唆する他の所見は現時点でなし(眼球結膜充血なし、口唇発赤なし)。"
      ],
      P: [
        "抗菌薬を院外で処方予定(本日は外注結果を待たず開始)。",
        "解熱後24時間まで登校を控えるよう説明。",
        "尿の色が濃い・浮腫など腎炎を疑う症状が出たら受診するよう母に説明。",
        "2日後に再診し、解熱と発疹の経過を確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["溶連菌性咽頭炎"],
      requiredBillingSignals: ["Ａ群β溶連菌迅速試験定性", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: ["検体採取確認"],
      forbiddenCandidates: ["インフルエンザウイルス抗原定性"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-24", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160044110"],
      outpatient_basic: { fee_kind: "initial" },
      lab_options: { collection_fee_inputs: ["blood_venous"] }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 596,
      candidateCodes: ["160044110", "111000110", "160062110", "160095710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "初診料", points: 291 },
      { name: "Ａ群β溶連菌迅速試験定性", points: 121 },
      { name: "免疫学的検査判断料", points: 144 },
      { name: "Ｂ－Ｖ", points: 40 }
    ]
  },
  {
    caseId: "V2-RESP-LAB-034",
    title: "呼吸器内科 発熱再診 コロナ・インフル同時抗原+採血",
    department: "respiratory",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 47, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-25" },
    realismAxes: ["abbreviation", "lab_raw_values", "negated_exam"],
    distractors: [
      { type: "negated_exam", name: "胸部X線", note: "下気道所見なく本日も撮影せず" },
      { type: "past_lab_values", name: "昨日の体温記録", note: "自宅記録。算定対象なし" }
    ],
    soap: {
      S: [
        "一昨日からの発熱で昨日受診し、解熱せず本日再診。",
        "自宅の記録では昨夜38.9、今朝38.2。咽頭痛と関節痛が継続。",
        "咳は乾性で軽度のまま。呼吸苦なし。職場でコロナとインフルの両方が出ている。",
        "昨日は様子見の方針だったが、症状が続くため本日検査を希望。",
        "同居の高校生の子は今のところ無症状。基礎疾患なし、常用薬なし。"
      ],
      O: [
        "KT 38.1、SpO2 98%、P 92。咽頭発赤(+)、扁桃白苔なし。",
        "肺音清、ラ音なし。呼吸数16。",
        "鼻咽頭ぬぐい液でコロナ・インフルの同時抗原検査を施行。",
        "脱水と炎症の評価のため静脈採血も実施し、外注へ提出。",
        "下気道感染を示唆する所見がなく、胸部X線は本日も撮影せず。"
      ],
      A: [
        "発熱が遷延するウイルス性上気道炎。コロナ・インフルの鑑別中。",
        "肺炎を示唆する所見なし。"
      ],
      P: [
        "結果は本日中に電話連絡。陽性の場合の自宅療養の流れを説明済み。",
        "水分摂取と休養を指導。解熱剤は手持ちのカロナールを継続使用で可。",
        "呼吸苦・SpO2低下を疑う症状(息切れ)が出たら即受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["上気道炎"],
      requiredBillingSignals: ["ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: ["検体採取確認"],
      forbiddenCandidates: ["単純撮影"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-25", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160230050"],
      outpatient_basic: { fee_kind: "revisit" },
      lab_options: { collection_fee_inputs: ["blood_venous"] }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 484,
      candidateCodes: ["160230050", "112007410", "160062110", "160095710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性", points: 225 },
      { name: "免疫学的検査判断料", points: 144 },
      { name: "Ｂ－Ｖ", points: 40 }
    ]
  },
  {
    caseId: "V2-PSY-MED-035",
    title: "精神科 不眠症初診 院外処方(一般名)",
    department: "psychiatry",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 38, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-07-27" },
    realismAxes: ["interview_detail", "prescription_detail", "negative_findings"],
    distractors: [
      { type: "otc_medication", name: "市販睡眠改善薬", note: "市販品。算定しない" },
      { type: "considered_only", name: "心理検査", note: "経過で検討。本日は実施なし" }
    ],
    soap: {
      S: [
        "3ヶ月前の部署異動後から入眠に1〜2時間かかる。当院初診。",
        "中途覚醒は週3回。朝のだるさで仕事の能率が落ちている。",
        "市販の睡眠改善薬を試したが効果は一晩のみだった。",
        "気分の落ち込みは「少しある」が、食欲低下・興味喪失は明らかでない。",
        "飲酒は寝酒として缶チューハイ1本がほぼ毎日。カフェインは夕方まで。",
        "希死念慮なし。既往なし。家族構成は妻と2人暮らし。",
        "休日は眠れることもあるが、平日との差が大きい。"
      ],
      O: [
        "表情は疲労感があるが、会話は整い疎通良好。",
        "思考の制止・焦燥なし。妄想・幻覚を示唆する言動なし。",
        "抑うつは軽度で、不眠が主体と評価。"
      ],
      A: [
        "不眠症(入眠障害+中途覚醒)。適応上のストレスが背景。",
        "うつ病の診断基準は現時点で満たさない。経過で再評価する。"
      ],
      P: [
        "睡眠衛生指導: 寝酒の中止、就床時刻を遅らせる、起床時刻の固定。",
        "院外処方箋を交付(一般名処方)。レンボレキサント錠5mg 1T 就寝前 14日分。",
        "心理検査は経過をみて必要なら検討。2週間後に再診。",
        "日中の強い眠気が出た場合は運転を控え、連絡するよう説明。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["不眠症"],
      requiredBillingSignals: ["処方箋料", "一般名処方加算"],
      requiredReviewTopics: ["精神科専門療法未対応"],
      forbiddenCandidates: ["通院・在宅精神療法", "調剤料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-27", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" },
      medication: {
        delivery_kind: "outside_prescription",
        prescription_category: "other",
        generic_name_prescription_add_on: "generic_name_add_on_1"
      }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 361,
      candidateCodes: ["111000110", "120002910", "120004270"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "初診料", points: 291 },
      { name: "処方箋料（リフィル以外・その他）", points: 60 },
      { name: "一般名処方加算１（処方箋料）", points: 10 }
    ]
  },
  {
    caseId: "V2-IM-MGMT-036",
    title: "内科 糖尿病定期再診(管理料はレビュー)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 63, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-28" },
    realismAxes: ["chronic_followup", "past_lab_values", "planned_exam"],
    distractors: [
      { type: "past_lab_values", name: "前回HbA1c", note: "過去結果の参照" },
      { type: "planned_exam", name: "眼科紹介", note: "年1回の眼底評価は他院眼科へ。本日の算定なし" }
    ],
    soap: {
      S: [
        "2型糖尿病で月1回通院中。低血糖症状なし。",
        "食事は妻と一緒に野菜を増やしている。間食は週2回まで減った。",
        "歩数は1日6000歩前後。足のしびれ・見えにくさの自覚なし。",
        "内服の飲み忘れは月に1〜2回ある。",
        "口渇・多飲・多尿の自覚なし。視力の変化なし。",
        "仕事は自営業(配達)で、昼食が外食になりがちとのこと。"
      ],
      O: [
        "BP 128/78、体重 70.2kg(前回-0.4kg)。",
        "前回(6月)HbA1c 7.1(その前7.4)。足背動脈触知良好、足趾の創なし。",
        "本日の診察では神経学的異常なし。",
        "アキレス腱反射正常、振動覚の低下なし。皮膚の乾燥は軽度。"
      ],
      A: [
        "2型糖尿病、改善傾向。血糖コントロールは目標(7.0未満)にあと一歩。"
      ],
      P: [
        "療養計画に基づいて食事・運動・服薬の指導を実施した。",
        "処方は前回どおり院外で継続。",
        "年1回の眼底評価はかかりつけ眼科で受けるよう案内(紹介状は次回までに準備)。",
        "次回は来月、HbA1cを含む採血を予定。",
        "シックデイの対応(食事が摂れない時の内服中止基準)を再確認した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["糖尿病"],
      requiredBillingSignals: ["生活習慣病管理料"],
      requiredReviewTopics: ["管理料確認", "同月履歴確認"],
      forbiddenCandidates: ["生活習慣病管理料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-28", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-DERM-MGMT-037",
    title: "皮膚科 アトピー性皮膚炎再診(皮膚科管理料はレビュー)",
    department: "dermatology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 19, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-29" },
    realismAxes: ["chronic_followup", "patient_words"],
    distractors: [
      { type: "otc_medication", name: "市販保湿ローション", note: "市販品。算定しない" }
    ],
    soap: {
      S: [
        "アトピー性皮膚炎で通院中。「夏になって汗で首と肘がかゆい」。",
        "外用は朝晩継続できている。保湿は市販ローションを使用。",
        "睡眠中の掻破で朝にシーツに血が付くことが週1回ある。",
        "受験勉強のストレスが強い時期とのこと。",
        "食物アレルギーなし。喘息の既往は小児期にあり、現在は症状なし。",
        "入浴は毎日シャワーで、湯船は週1回程度。"
      ],
      O: [
        "頸部・両肘窩に紅斑と苔癬化。新規の滲出性病変なし。",
        "体幹は乾燥が主体。感染を示唆する膿痂疹なし。",
        "重症度は中等症相当で前回から横ばい。",
        "顔面・眼囲には病変なし。リンパ節腫脹なし。"
      ],
      A: [
        "アトピー性皮膚炎、夏季増悪。発汗と掻破のサイクルが要因。"
      ],
      P: [
        "汗をかいたら早めにシャワーで流すこと、外用の塗布量(FTU)を再指導。",
        "受験期のストレスと睡眠について短時間の相談に応じた。",
        "スキンケアと生活指導を含む長期管理方針を本人と確認した。",
        "外用処方は前回どおり院外で継続。",
        "2週間後に再診し、夜間掻破の頻度を再評価。",
        "爪を短く保つこと、就寝時の室温を下げることも併せて助言した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["アトピー性皮膚炎"],
      requiredBillingSignals: ["皮膚科特定疾患指導管理料"],
      requiredReviewTopics: ["対象疾患確認", "管理料確認"],
      forbiddenCandidates: ["皮膚科特定疾患指導管理料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-29", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-RESP-MGMT-038",
    title: "呼吸器内科 喘息定期再診(療養計画はレビュー)",
    department: "respiratory",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 35, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-30" },
    realismAxes: ["chronic_followup", "device_technique"],
    distractors: [
      { type: "negated_exam", name: "呼吸機能検査", note: "安定しており本日は実施せず" }
    ],
    soap: {
      S: [
        "気管支喘息で通院中。吸入は朝晩継続。",
        "夜間症状は月1回未満、発作治療薬の使用は先月ゼロ。",
        "今月は台風前に胸の重さを感じた日が1日あったが自然軽快。",
        "猫カフェに行くと症状が出るため避けている。",
        "仕事はデスクワークで、職場の空調による症状の変動はない。",
        "ピークフローの自己測定は朝のみ継続しており、自己ベストの90%前後で安定。"
      ],
      O: [
        "SpO2 99%、呼吸音清、wheezeなし。",
        "吸入手技を確認し、吸気のタイミングのずれを修正した。残薬カウンタも確認。",
        "KT 36.5、P 72。",
        "症状が安定しているため、呼吸機能検査は本日は実施せず。",
        "咽頭発赤なし。鼻炎症状もなし。"
      ],
      A: [
        "気管支喘息、良好なコントロール。現行ステップ維持で可。"
      ],
      P: [
        "喘息の療養計画に沿って、増悪時の対応(発作治療薬の使い方と受診の目安)を再確認した。",
        "吸入薬は院外で継続処方。",
        "次回は2ヶ月後。台風シーズンの自己管理メモを渡した。",
        "インフルエンザワクチンは秋に接種予定として案内した。妊娠の予定があれば申し出るよう説明。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["気管支喘息"],
      requiredBillingSignals: ["喘息"],
      requiredReviewTopics: ["管理料確認", "療養計画確認"],
      forbiddenCandidates: ["特定疾患療養管理料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-30", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-CARD-IMG-039",
    title: "循環器内科 心エコー実施(検査区分はレビュー)",
    department: "cardiology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 71, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-31" },
    realismAxes: ["abbreviation", "exam_detail"],
    distractors: [
      { type: "past_exam", name: "心電図(前回)", note: "前回実施の参照。本日は未実施" }
    ],
    soap: {
      S: [
        "高血圧で通院中。最近、階段で軽い息切れを自覚するようになった。",
        "胸痛なし。動悸は時々で数分で消失。夜間の呼吸困難なし。下腿のむくみが夕方にわずか。",
        "趣味のゲートボールは続けられている。階段は2階まで休まず上がれる。",
        "塩分は妻の管理で控えめ。飲酒なし。"
      ],
      O: [
        "BP 138/84、P 76整。心尖部にII/VIの収縮期雑音を聴取(新規ではなく前回も記載あり)。",
        "前回の心電図では洞調律で明らかなST変化なし(本日は未実施)。",
        "心機能評価のため心臓超音波検査を施行。",
        "左室駆出率は保たれ、壁運動異常なし。僧帽弁に軽度の逆流。左房径やや拡大。",
        "心嚢液貯留なし。下大静脈の拡張なし。大動脈弁・三尖弁に有意な異常なし。"
      ],
      A: [
        "軽度の僧帽弁逆流。息切れとの関連は軽度で、経過観察可能。"
      ],
      P: [
        "半年後に心エコーで再評価する方針(予約取得)。",
        "歯科治療時の感染性心内膜炎予防は現時点で不要と説明。",
        "体重増加・息切れの増悪・夜間呼吸困難があれば早めに受診。",
        "血圧管理を継続(処方は前回どおり院外)。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["僧帽弁逆流"],
      requiredBillingSignals: ["超音波検査"],
      requiredReviewTopics: ["マスター候補確認"],
      forbiddenCandidates: ["心電図"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-31", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-GI-MED-040",
    title: "消化器内科 院内処方の日数未記載(薬剤はレビュー)",
    department: "gastroenterology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 54, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-01" },
    realismAxes: ["incomplete_documentation", "abbreviation"],
    distractors: [
      { type: "other_provider_history", name: "前医の処方歴", note: "他院処方の経緯。算定しない" }
    ],
    soap: {
      S: [
        "胃部不快感で通院中。前医ではランソプラゾールを処方されていたが転居で当院へ移った経緯。",
        "症状は食後のもたれが中心。黒色便なし、体重減少なし。",
        "飲酒は晩酌で日本酒1合。コーヒーは1日3杯。",
        "睡眠・体重は安定。ストレスは仕事の繁忙期で強めとのこと。",
        "前医の内視鏡(半年前)では萎縮性胃炎の指摘のみで、ピロリは除菌済みとのこと。"
      ],
      O: [
        "腹部平坦・軟。心窩部に圧痛なし。",
        "眼瞼結膜に貧血なし。KT 36.5、BP 122/78。",
        "体重 64.8kg(前回比横ばい)。"
      ],
      A: [
        "機能性ディスペプシア疑い。器質的疾患の精査は前医の内視鏡(半年前・異常なし)を踏まえ経過観察。"
      ],
      P: [
        "レバミピド錠100mg 3T 分3を院内で処方した。",
        "(処方日数の記載が漏れており、会計時に要確認)",
        "食事はゆっくり摂る、就寝前2時間は食べないこと、繁忙期の夜食を控えることを指導。",
        "4週間後に再診。症状増悪・黒色便があれば早めに受診。",
        "コーヒーは1日2杯までに減らすことを提案した。症状日誌の記録も依頼した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["機能性ディスペプシア"],
      requiredBillingSignals: ["レバミピド"],
      requiredReviewTopics: ["薬剤日数不足"],
      forbiddenCandidates: ["処方箋料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-01", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-NEUR-IMG-041",
    title: "脳神経内科 MRI実施・造影有無の記載なし(レビュー)",
    department: "neurology",
    facilityFixtureKey: "clinic_imaging",
    difficultyLevel: "L3",
    patient: { age: 45, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-02" },
    realismAxes: ["incomplete_documentation", "negative_findings"],
    distractors: [
      { type: "other_provider_history", name: "他院での脳ドック", note: "5年前の他院検査。算定しない" }
    ],
    soap: {
      S: [
        "反復する片頭痛で通院中。前回、頻度増加のため精査の方針とした。",
        "前兆(閃輝暗点)は従来どおり。麻痺・しびれの新規出現なし。",
        "5年前に他院の脳ドックでMRIを受け異常なしだったとのこと。",
        "鎮痛薬の使用は月8日程度に増えている(市販イブプロフェン)。",
        "頭痛は拍動性で右側優位、持続は半日。悪心を伴う日もある。",
        "仕事はシフト制で、夜勤明けに発作が多い印象とのこと。"
      ],
      O: [
        "神経学的診察で局在所見なし。脳神経系も含め異常なし。眼底に乳頭浮腫なし。",
        "頭頸部の筋緊張は軽度。聴診で頸部血管雑音なし。",
        "頭部MRIを本日施行。撮像プロトコルの詳細は画像システムを参照。",
        "白質に非特異的な小高信号が数個。占拠性病変・血管奇形を疑う所見なし。",
        "(造影の有無がこの記録からは読み取れない)",
        "BP 118/72。頸部血管雑音なし。眼振なし。"
      ],
      A: [
        "前兆のある片頭痛。MRIで二次性頭痛は否定的。",
        "白質病変は年齢相応の非特異的変化と判断。",
        "薬剤の使用過多による頭痛への移行リスクに注意。"
      ],
      P: [
        "急性期治療薬の使用を月10日未満に保つよう指導。",
        "頭痛ダイアリーを継続し、次回の受診時に予防薬(月10日以上が続く場合)の導入を検討。",
        "4週間後に再診。",
        "発作時の早期服薬(発症30分以内)を徹底するよう説明。",
        "睡眠時間の確保とカフェインの均一化も併せて指導した。シフト調整の相談は職場の産業保健窓口と行うよう案内。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["片頭痛"],
      requiredBillingSignals: ["ＭＲＩ"],
      requiredReviewTopics: ["造影確認"],
      forbiddenCandidates: ["ＣＴ撮影"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-02", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-OBGYN-LAB-042",
    title: "産婦人科 帯下異常 検体提出(検査コードはレビュー)",
    department: "obgyn",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 24, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-03" },
    realismAxes: ["specimen_flow", "negative_findings"],
    distractors: [
      { type: "unrelated_topic", name: "ピル相談", note: "次回相談の話題。本日の算定なし" }
    ],
    soap: {
      S: [
        "1週間前から帯下の増加とにおいが気になる。当院初診。",
        "外陰部のかゆみは軽度。排尿時痛なし。発熱なし。",
        "性交渉歴あり、パートナーは1人。避妊はコンドーム。",
        "最終月経は10日前から5日間、量・周期に変化なし。",
        "既往なし。薬剤アレルギーなし。",
        "低用量ピルについても今度相談したいとのこと。"
      ],
      O: [
        "外陰部に発赤・潰瘍なし。",
        "腟鏡診で灰白色の均一な帯下が中等量。子宮頸部に明らかなびらん・出血なし。",
        "腟分泌物を採取し、顕微鏡検査と培養を外注で提出。",
        "双合診で子宮・付属器に圧痛なし。可動時痛なし。",
        "KT 36.7。下腹部の自発痛・圧痛なし。"
      ],
      A: [
        "細菌性腟症が最も疑わしい。カンジダ・トリコモナスとの鑑別は検査結果で確定する。"
      ],
      P: [
        "結果は1週間後に説明(電話可)。それまで腟洗浄のしすぎを避け、通気性の良い下着を勧めた。",
        "パートナーの症状の有無も確認してくるよう伝えた。",
        "市販の腟洗浄剤の使用は中止してもらう。",
        "ピルの相談は次回の結果説明時に時間を取って行う。",
        "発熱・下腹部痛が出たら早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["細菌性腟症"],
      requiredBillingSignals: ["培養"],
      requiredReviewTopics: ["検査コード確認", "検体採取確認"],
      forbiddenCandidates: []
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-03", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "初診料", points: 291 }]
  },
  {
    caseId: "V2-URO-PROC-043",
    title: "泌尿器科 導尿実施(手技はレビュー)",
    department: "urology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 78, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-04" },
    realismAxes: ["procedure_detail", "elderly_context"],
    distractors: [
      { type: "planned_exam", name: "前立腺精査", note: "後日予定。本日は実施なし" }
    ],
    soap: {
      S: [
        "前立腺肥大で通院中。今朝から尿が出にくく、下腹部の張りが強くなり受診。",
        "昨夜から尿は数滴ずつしか出ていない。腹痛は膀胱部の張りによるもの。",
        "市販の風邪薬を3日前から内服していた(鼻炎症状のため)。",
        "夜間頻尿はもともと2回程度。尿勢の低下はここ1年で徐々に進んでいた。",
        "飲酒は付き合い程度。前立腺の内服薬は自己判断で先月からやめていた。"
      ],
      O: [
        "下腹部正中に膨隆、叩打で濁音。圧痛は膀胱部に一致。",
        "尿道カテーテルで導尿を実施し、700mLの排尿を得た。尿の性状は淡黄色で清明。",
        "導尿後、下腹部の張りは消失し、表情も和らいだ。",
        "KT 36.6、BP 142/80。下肢浮腫なし。"
      ],
      A: [
        "急性尿閉。風邪薬(抗ヒスタミン)の影響が誘因と考える。",
        "前立腺の精査(エコー・採血)は症状安定後に予定する。"
      ],
      P: [
        "風邪薬の中止を指示。水分は通常量で可。アルコールは数日控える。",
        "明日再診し、自尿の回復を確認する。自尿が出なければカテーテル留置を検討。",
        "前立腺の精査は来週の予約枠で実施する予定とした。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["尿閉"],
      requiredBillingSignals: ["導尿"],
      requiredReviewTopics: ["手技内容確認"],
      forbiddenCandidates: ["超音波検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-04", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-ENT-LAB-044",
    title: "耳鼻咽喉科 聴力低下 聴力検査実施(検査区分はレビュー)",
    department: "otolaryngology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 66, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-05" },
    realismAxes: ["exam_detail", "negative_findings"],
    distractors: [
      { type: "family_context", name: "夫の補聴器", note: "家族の話題。算定対象なし" }
    ],
    soap: {
      S: [
        "半年前からテレビの音が大きいと家族に言われる。当院初診。",
        "耳鳴は両側で「シーン」という音が時々。めまいなし。耳漏なし。",
        "夫が補聴器を使っており、自分も必要か知りたいとのこと。",
        "騒音職場の経験なし。耳毒性のある薬剤の使用歴なし。",
        "特に電話の聞き取りに困っているとのこと。"
      ],
      O: [
        "両外耳道に耳垢栓塞なし。鼓膜両側とも正常、可動性良好。",
        "音叉試験でウェーバー正中、リンネ両側陽性。",
        "防音室で聴力検査を施行。両側とも高音域中心の感音難聴パターン。",
        "左右差は軽度で、平均聴力は中等度域。",
        "語音の聞き取りは静かな環境では保たれている。"
      ],
      A: [
        "加齢性難聴(両側感音難聴)。突発性難聴を示唆する急激な変化はない。"
      ],
      P: [
        "聴力の結果をオージオグラムの図で説明。補聴器の適応について次回詳しく相談する。",
        "騒がしい場所での会話の工夫(正面・ゆっくり)も説明した。",
        "急な聴力低下・強いめまいが出た場合は早急に受診するよう説明。",
        "家族との会話では正面から話してもらう工夫を提案した。次回は2週間後に予約。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["感音難聴"],
      requiredBillingSignals: ["聴力検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: []
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-05", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "初診料", points: 291 }]
  },
  {
    caseId: "V2-HOME-VISIT-045",
    title: "在宅 臨時往診(在宅領域はレビュー)",
    department: "homecare",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 88, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-06" },
    realismAxes: ["homecare_context", "caregiver", "acute_on_chronic"],
    distractors: [
      { type: "planned_care", name: "定期訪問(次回)", note: "予定の記載。本日の算定とは別" },
      { type: "negated_treatment", name: "救急搬送", note: "家族と相談のうえ見送り" }
    ],
    soap: {
      S: [
        "誤嚥性肺炎の既往がある寝たきりの方。定期訪問診療中。",
        "本日昼から微熱と痰がらみがあると施設職員から連絡があり、臨時で往診。",
        "食事は昼を半分残した。水分はトロミ付きで摂れている。",
        "家族(長男)は「できる限り施設で」と以前から希望しており、本日も電話で意向を再確認した。",
        "昨日までは平熱で、食事も普段どおり摂れていたとの申し送り。"
      ],
      O: [
        "KT 37.6、SpO2 94%(室内気)、P 88、呼吸数 22。",
        "右下背部で呼吸音減弱とcoarse cracklesを聴取。",
        "意識レベルは普段どおり(呼びかけに開眼・発語)。",
        "喀痰は黄色粘稠で吸引で中等量引ける。皮膚の乾燥は軽度。",
        "下腿浮腫なし。褥瘡部(仙骨部・治癒済み)の再発なし。"
      ],
      A: [
        "誤嚥性肺炎の再燃疑い。現時点では酸素化は許容範囲。",
        "本人・家族の意向を踏まえ、施設内での治療を選択。救急搬送は本日は見送り。"
      ],
      P: [
        "抗菌薬の開始を施設の協力薬局へ依頼(処方は別途指示書)。経口摂取できる間は内服で開始。",
        "発熱時の頓用解熱薬の使用条件も指示書に記載。",
        "職員へ吸引の頻度を増やすこと、食事はゼリー食へ変更を指示。",
        "明日、定期訪問とは別に状態確認の連絡を入れる。SpO2が92%を切る場合は再往診。",
        "次回の定期訪問は来週火曜の予定。",
        "急変時の対応方針(施設看取りの意向確認済み)をカルテに再記載し、職員と共有した。長男にも電話で本日の状態を報告。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["誤嚥性肺炎"],
      requiredBillingSignals: ["往診"],
      requiredReviewTopics: ["在宅医療未対応", "訪問診療確認"],
      forbiddenCandidates: ["往診料", "在宅患者訪問診療料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-06", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-RAD-IMG-046",
    title: "放射線科 CT実施・機器情報なし施設(機器区分はレビュー)",
    department: "radiology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 56, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-07" },
    realismAxes: ["abbreviation", "facility_attribute_missing"],
    distractors: [
      { type: "other_provider_history", name: "健診の胸部X線", note: "健診での指摘。本日の算定なし" }
    ],
    soap: {
      S: [
        "健診の胸部X線で右肺に小結節疑いを指摘され、精査目的で前回受診。本日CT予約日。",
        "咳・血痰なし。体重減少なし。",
        "喫煙は5年前まで20本/日×25年。職業は事務職で粉じん曝露歴なし。",
        "結核の既往・家族歴なし。ペット飼育なし。",
        "本人は「がんではないか」と強い不安を口にしている。"
      ],
      O: [
        "胸部CTを施行。",
        "右S6に8mmの結節。辺縁は平滑で、石灰化を一部に伴う。",
        "縦隔リンパ節の腫大なし。その他の肺野に異常なし。",
        "胸膜の肥厚・胸水なし。比較のため健診の画像借用を依頼予定。"
      ],
      A: [
        "右肺結節。性状からは陳旧性変化(肉芽腫など)が第一に考えられるが、サイズから経過観察が必要。"
      ],
      P: [
        "3ヶ月後にCTで再評価する方針(予約取得)。サイズ・性状の変化を比較する。",
        "本日の結果は紹介元の健診機関にも文書で報告する。",
        "増大があれば呼吸器専門施設へ紹介する。",
        "血痰・体重減少が出た場合は早めに受診。",
        "不安に対しては、石灰化を伴う良性パターンであることを図を用いて丁寧に説明し、不明点の質問にも回答した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肺結節"],
      requiredBillingSignals: ["ＣＴ撮影"],
      requiredReviewTopics: ["CT機器区分確認"],
      forbiddenCandidates: ["単純撮影"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-07", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-REH-DOC-047",
    title: "リハビリテーション科 実施単位の記載が不完全(レビュー)",
    department: "rehabilitation",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 74, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-08" },
    realismAxes: ["incomplete_documentation", "adl_context"],
    distractors: [
      { type: "other_provider_history", name: "脳梗塞の急性期入院(他院)", note: "他院の既往。本日の算定なし" }
    ],
    soap: {
      S: [
        "3ヶ月前の脳梗塞(他院で急性期治療)後の右片麻痺に対し外来リハ中。",
        "屋内は杖歩行が安定してきた。右手の細かい動作はまだ難しい。",
        "意欲は保たれ、自主トレも継続している。",
        "妻と二人暮らしで、屋外は妻の付き添いで週2回散歩している。",
        "嚥下の問題なし。言語面の障害もなし。"
      ],
      O: [
        "右上肢 Brunnstrom stage IV、右下肢 V。",
        "理学療法と作業療法を実施(開始・終了時刻の記載が訓練記録に漏れている)。",
        "内容: 歩行訓練、右上肢の巧緻動作訓練、ADL動作練習。",
        "訓練中のバイタル安定。疲労の訴えは訓練後に軽度。"
      ],
      A: [
        "脳梗塞後右片麻痺、回復期から生活期への移行段階。改善は継続している。"
      ],
      P: [
        "外来リハを週2回継続。実施時間の記録整備(開始・終了時刻)を担当療法士へ依頼した。",
        "目標は「杖なしで近所のコンビニまで」とし、本人・妻と共有。",
        "転倒予防のため浴室の手すり設置をケアマネに相談するよう勧めた。装具の不具合は現時点でなし。",
        "自宅での自主トレメニューを更新。",
        "次回診察で装具の適合を確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["脳梗塞"],
      requiredBillingSignals: ["リハビリテーション"],
      requiredReviewTopics: ["リハビリ未対応", "実施単位確認"],
      forbiddenCandidates: ["脳血管疾患等リハビリテーション料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-08", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-IM-NEG-048",
    title: "内科 検査・処方をすべて見送った再診(安全系)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 44, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-09" },
    realismAxes: ["negated_exam", "negative_findings", "counseling_only"],
    distractors: [
      { type: "negated_exam", name: "胸部CT", note: "適応なしと判断し実施せず" },
      { type: "negated_exam", name: "採血", note: "前回結果が正常で本日は行わず" },
      { type: "negated_treatment", name: "処方", note: "本日は処方なし" }
    ],
    soap: {
      S: [
        "咳が長引くとの主訴で前回受診し、本日経過確認の再診。",
        "咳はこの1週間でほぼ消失。痰なし。発熱なし。",
        "「念のためCTを撮ってほしい」という希望が前回あったが、今日は症状がないので迷っているとのこと。",
        "喫煙歴なし。職場の健診は毎年受けており、昨年の胸部写真は異常なし。",
        "周囲に長引く咳の人はいない。ペットなし。逆流症状(胸やけ)もなし。",
        "本人は「もう大丈夫そうなら検査はしなくていい」との意向。"
      ],
      O: [
        "KT 36.4、SpO2 99%。咽頭発赤なし。",
        "肺音清、ラ音なし。頸部リンパ節腫脹なし。",
        "前回の採血は炎症反応を含めすべて正常範囲(結果説明済み)。",
        "症状消失と前回結果から、胸部CTは適応なしと判断し実施せず。",
        "採血の再検も本日は行わず。"
      ],
      A: [
        "感染後咳嗽、軽快と判断。器質的疾患を疑う所見なし。"
      ],
      P: [
        "本日は処方なし。経過観察をいったん終了する。",
        "本人の「検査をしなくて大丈夫か」という不安には、症状消失・正常な前回結果・聴診所見から不要と判断した根拠を説明し、納得を得た。",
        "咳の再燃が2週間以上続く場合は再診し、画像評価を検討する。",
        "夜間の咳・喘鳴が出る場合は喘息の評価(呼気NO・呼吸機能)も行うと説明。",
        "禁煙環境の維持と手洗いを続けるよう説明した。",
        "次回の健診結果(秋)に異常があれば結果票を持参して相談するよう案内した。",
        "本日の説明内容は本人の同意のもと診療録に記録した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["感染後咳嗽"],
      requiredBillingSignals: [],
      requiredReviewTopics: [],
      forbiddenCandidates: ["ＣＴ撮影", "Ｂ－Ｖ", "処方箋料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-09", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "safety",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-EMER-TIME-049",
    title: "救急 日曜日の受診(休日系加算はレビュー)",
    department: "emergency",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 28, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-10" },
    realismAxes: ["time_context", "negative_findings", "negated_exam"],
    distractors: [
      { type: "negated_exam", name: "採血・画像", note: "本日は実施せず" },
      { type: "social_context", name: "旅行帰り", note: "問診情報" }
    ],
    soap: {
      S: [
        "日曜の午前に受診。昨夜から右耳の痛みが強く、休日だが我慢できず来院。当院初診。",
        "3日間の沖縄旅行から昨日帰宅。帰りの飛行機の着陸時から右耳の閉塞感があり、昨夜から痛みに変わった。",
        "旅行中に海で潜る遊びもしたが、その時点では症状なし。",
        "発熱なし。耳漏なし。聴こえにくさは右で軽度。",
        "鎮痛は手持ちのロキソプロフェンを昨夜1回内服し、数時間は眠れた。",
        "耳をいじる習慣なし。過去に中耳炎の既往なし。",
        "明日から仕事(コールセンター)で、ヘッドセットを使うため心配とのこと。"
      ],
      O: [
        "KT 36.8。右鼓膜に発赤と軽度の内陥。穿孔なし、耳漏なし。",
        "左鼓膜正常。外耳道に異常なし。乳様突起部の圧痛なし。",
        "簡易的な会話レベルの聞き取りでは大きな低下なし。",
        "頸部リンパ節腫脹なし。咽頭に膿性付着なし。",
        "鼻咽腔に発赤軽度。",
        "全身状態良好で、本日は採血・画像は実施せず。",
        "聴力の精密な評価は平日の耳鼻科でと判断。"
      ],
      A: [
        "航空性中耳炎(軽症)。細菌性中耳炎への進展は現時点でなし。"
      ],
      P: [
        "鎮痛薬は手持ちのロキソプロフェン継続で可(1日2回まで)。耳抜きの方法(バルサルバ)を優しく行うよう指導。",
        "鼻を強くかまないこと、当面の潜水・飛行機は避けることを説明。",
        "痛みの増悪・耳漏・発熱があれば平日に耳鼻科を受診するよう説明。",
        "次の搭乗時の予防(嚥下を促すあめ、気圧調整機能つき耳栓)について説明した。",
        "本日の処置は実施しておらず、診察と説明のみ。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["航空性中耳炎"],
      requiredBillingSignals: [],
      requiredReviewTopics: ["救急加算確認", "受付時刻確認"],
      forbiddenCandidates: ["休日加算", "時間外加算"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-10", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" }
    },
    expectedCalculation: {
      assertionLevel: "safety",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "初診料", points: 291 }]
  },
  {
    caseId: "V2-SURG-SAFE-050",
    title: "外科 手術の説明・同意のみ(実施なし・安全系)",
    department: "surgery",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 49, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-11" },
    realismAxes: ["consent_context", "planned_procedure"],
    distractors: [
      { type: "planned_procedure", name: "鼠径ヘルニア手術", note: "来月予定。本日は説明のみ" },
      { type: "planned_exam", name: "術前検査", note: "来週予定。本日は実施なし" }
    ],
    soap: {
      S: [
        "右鼠径部の膨隆で通院中。立ち仕事の夕方に出やすく、横になると戻る。",
        "嵌頓を疑うエピソードなし。痛みは違和感程度で、仕事に支障はない。",
        "既往は高血圧(内服中・院外)。抗凝固薬なし。喫煙なし。",
        "仕事は配送業で重量物を持つ場面が多い。",
        "前回提案した手術について、家族と相談して受ける決心がついたとのこと。",
        "症状自体は前回から変化なく、膨隆の出る頻度も同程度。",
        "手術への不安として麻酔と痛みについて質問が複数あった。",
        "睡眠・食欲は普段どおりで、体重の変化もなし。"
      ],
      O: [
        "立位で右鼠径部に還納可能な膨隆。咳嗽で増大。",
        "圧痛なし。皮膚に発赤なし。",
        "本日は診察と説明のみで、処置・検査は実施していない。",
        "BP 134/82。腹部全体に他の異常所見なし。"
      ],
      A: [
        "右鼠径ヘルニア。待機的手術の適応。"
      ],
      P: [
        "来月の手術日を仮押さえし、術式(メッシュ法)について図を使って説明した。",
        "合併症(出血・感染・再発・慢性疼痛)と麻酔方法、当日の流れを文書で説明し、同意書を受領。",
        "質問には「仕事復帰の時期」「入浴の可否」があり、それぞれ回答した。",
        "術前検査(採血・心電図・胸部X線)は来週の予約で実施予定。",
        "それまでに嵌頓症状(強い痛み・戻らない膨隆・嘔吐)が出たら直ちに受診するよう説明。",
        "手術前後の仕事の調整(重量物制限2週間)についても説明した。",
        "術前検査の結果は手術前の外来でまとめて説明する予定とした。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["鼠径ヘルニア"],
      requiredBillingSignals: [],
      requiredReviewTopics: ["手術未対応"],
      forbiddenCandidates: ["ヘルニア手術", "心電図", "Ｂ－Ｖ"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-11", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "safety",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  },
  {
    caseId: "V2-GI-SPLIT-051",
    title: "消化器内科 検査日と説明日の記録が混在(分割が必要)",
    department: "gastroenterology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 60, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-12" },
    realismAxes: ["multi_day_record", "specimen_flow"],
    distractors: [
      { type: "previous_day_acts", name: "8/10の内視鏡", note: "別日の行為。本日(8/12)分と分けて扱う" }
    ],
    soap: {
      S: [
        "【8/10】便潜血陽性の精査目的で大腸内視鏡を施行した日の記録。前処置は問題なく完了。",
        "【8/12 本日】結果説明のため再診。腹部症状なし。検査後の出血・腹痛なし。",
        "8/10の検査後は当日から普通食に戻し、問題なく経過した。排便も普段どおり。",
        "検査時の鎮静の影響も当日中に消失したとのこと。",
        "便潜血は健診の2回法のうち1回が陽性だった経緯。",
        "家族歴: 父が大腸がん(70代)。本人は結果を心配している。"
      ],
      O: [
        "8/10: 大腸内視鏡を施行。前処置良好、回盲部まで挿入。S状結腸に6mmの隆起性ポリープを認め、生検鉗子で検体を採取し病理へ提出。観察中の偶発症なし。",
        "本日8/12: 腹部平坦・軟、圧痛なし。検査後の合併症を示唆する所見なし。",
        "本日のバイタル: KT 36.3、BP 126/78。"
      ],
      A: [
        "S状結腸ポリープ(病理結果待ち)。その他の大腸に異常なし。"
      ],
      P: [
        "病理結果は1週間後に判明予定。次回外来で説明し、腺腫であれば内視鏡的切除の方針を相談する。",
        "切除を行う場合の前処置・休薬・費用の概要も先に説明した。",
        "本日は食事制限を解除。腹痛・血便があれば早めに受診。",
        "家族歴を踏まえ、今後の定期的な内視鏡フォロー(結果により1〜3年間隔)の必要性を説明した。",
        "次回外来は8/19で予約済み。家族の同席を希望されればそれも可と伝えた。",
        "本日の会計は本日分の診療のみである旨を受付に申し送り。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["大腸ポリープ"],
      requiredBillingSignals: ["複数日診療", "内視鏡"],
      requiredReviewTopics: ["複数日記録分割", "内視鏡未対応", "生検有無確認"],
      forbiddenCandidates: []
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-12", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料(本日分のみ)", points: 75 }]
  }
];
