// v2 batch-001: パイロット10件(全難易度・ディストラクタ付き)。文体の品質基準。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-001",
    title: "内科 膀胱炎疑い再診 尿定性+採血(検体検査管理加算届出施設)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 38, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-06" },
    realismAxes: ["abbreviation", "negative_findings", "lab_raw_values", "otc_medication", "negated_exam"],
    distractors: [
      { type: "otc_medication", name: "ロキソニンS", note: "市販薬。薬剤料を算定しない" },
      { type: "pending_external_result", name: "尿培養", note: "前回提出済み・結果待ち。本日の検査ではない" },
      { type: "negated_exam", name: "腹部エコー", note: "今回は行わず、と明記。算定しない" },
      { type: "unrelated_complaint", name: "便秘", note: "診察内の相談。算定対象なし" }
    ],
    soap: {
      S: [
        "3日前からの排尿時痛で7/3に受診し、本日再診。",
        "排尿時痛は少し軽くなったが残尿感が続く。トイレが近く、夜間も2回起きる。",
        "発熱なし、悪寒なし。肉眼的血尿なし。腰や背中の痛みもなし。",
        "痛みが強いときは自宅にあったロキソニンSを1回だけ内服した。",
        "もともと便秘がちで、ここ数日は市販のオリゴ糖で様子を見ているとのこと。",
        "仕事はデスクワーク。水分はコーヒー中心であまり摂れていない。妊娠の可能性はなし。",
        "既往: 20代に扁桃炎で抗菌薬を使用、薬疹などのアレルギー歴はなし。膀胱炎は2年前にも1回。"
      ],
      O: [
        "KT 36.8、BP 118/72、P 68整。",
        "腹部平坦・軟。下腹部に軽度圧痛、反跳痛なし。CVA叩打痛なし。",
        "院内で尿定性・尿蛋白を実施。混濁(+)、白血球反応(2+)、亜硝酸塩(+)、蛋白(±)、潜血(-)。",
        "静脈採血も施行し、血液検体を外注へ提出。",
        "前回(7/3)提出の尿培養はまだ結果未着。",
        "腹部エコーは症状の経過から今回は行わず。"
      ],
      A: [
        "急性膀胱炎の遷延。亜硝酸塩陽性で細菌尿が示唆される。",
        "発熱・CVA叩打痛なく、腎盂腎炎を示唆する所見はない。便秘は機能性で経過観察可。"
      ],
      P: [
        "培養と外注結果を確認のうえ抗菌薬の選択・継続を判断する。結果は電話で連絡予定。",
        "水分摂取を増やすよう指導(コーヒー以外で1日1.5L目安)。",
        "発熱・腰背部痛・血尿が出たら早めに再診するよう説明した。",
        "排尿を我慢しないこと、カフェインの摂りすぎを控えることも併せて助言。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["膀胱炎"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["超音波検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-06", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160000310", "160000410"],
      outpatient_basic: { fee_kind: "revisit" },
      lab_options: { collection_fee_inputs: ["blood_venous"] },
      facility_standard_keys: ["検体検査管理加算2"]
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 282,
      candidateCodes: ["160000310", "160000410", "112007410", "160061710", "160182770", "160095710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "尿一般", points: 26 },
      { name: "尿蛋白", points: 7 },
      { name: "尿・糞便等検査判断料", points: 34 },
      { name: "Ｂ－Ｖ", points: 40 },
      { name: "検体検査管理加算（２）", points: 100 }
    ]
  },
  {
    caseId: "V2-PED-LAB-002",
    title: "小児科 発熱再診 インフル・溶連菌迅速",
    department: "pediatrics",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 4, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-13" },
    realismAxes: ["abbreviation", "family_context", "patient_words", "negated_treatment"],
    distractors: [
      { type: "family_history", name: "兄のインフルエンザ", note: "家族の罹患。患者の算定対象ではない" },
      { type: "negated_treatment", name: "点滴", note: "不要と判断、実施せず" },
      { type: "home_medication", name: "アンヒバ坐剤(自宅残り)", note: "処方なし。薬剤料を算定しない" },
      { type: "normal_exam_mention", name: "鼓膜所見", note: "診察の一部。中耳炎処置なし" }
    ],
    soap: {
      S: [
        "昨日(7/12)発熱で受診し、本日も39度台が続くため再診。",
        "母:「夜もぐったりしていて、水分はなんとか摂れている」。",
        "咽頭痛あり。咳は軽度、鼻汁あり。嘔吐・下痢なし。",
        "5日前に兄(小2)がインフルエンザAと診断され自宅療養中。保育園でも複数発生。",
        "昨夜は自宅に残っていたアンヒバ坐剤100mgを1回使用し、一時的に38度前半まで下がった。",
        "食欲は普段の半分程度。おしっこは出ている。",
        "今季のインフルエンザワクチンは未接種。熱性けいれんの既往なし。きょうだいは兄と本人の2人。"
      ],
      O: [
        "KT 38.9、P 128、SpO2 98%(室内気)。体重16.2kg。",
        "活気やや不良だが、あやすと笑顔あり。脱水所見なし。皮疹なし、項部硬直なし。",
        "咽頭発赤(+)、扁桃白苔(+)。頸部リンパ節は両側に小豆大を数個触知。",
        "鼓膜は両側とも発赤なし。呼吸音清、陥没呼吸なし。",
        "鼻咽頭ぬぐい液でインフル迅速と溶連菌迅速を施行。インフルA(+)、溶連菌(-)。",
        "経口摂取できており、点滴は不要と判断し行わず。"
      ],
      A: [
        "インフルエンザA型。兄からの家族内感染と考える。",
        "溶連菌は陰性。中耳炎・肺炎を示唆する所見なし。脱水なし。"
      ],
      P: [
        "自宅安静と水分摂取をこまめに摂るよう指導。",
        "解熱剤は自宅のアンヒバ坐剤を使用してよいと説明(体重から100mgで適量)。",
        "呼吸が苦しそう、ぐったりして水分が摂れない、けいれん等があればすぐ受診。",
        "登園は発症後5日かつ解熱後3日を経過してからと説明。母へ書面も渡した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["インフルエンザ"],
      requiredBillingSignals: ["インフルエンザウイルス抗原定性", "Ａ群β溶連菌迅速試験定性", "免疫学的検査判断料"],
      requiredReviewTopics: ["検体採取確認"],
      forbiddenCandidates: ["点滴注射"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-13", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160169450", "160044110"],
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 472,
      candidateCodes: ["160169450", "160044110", "112007410", "160062110"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "インフルエンザウイルス抗原定性", points: 132 },
      { name: "Ａ群β溶連菌迅速試験定性", points: 121 },
      { name: "免疫学的検査判断料", points: 144 }
    ]
  },
  {
    caseId: "V2-DERM-MED-003",
    title: "皮膚科 前腕熱傷再診 院内外用処方+熱傷処置",
    department: "dermatology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L1",
    patient: { age: 35, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-08" },
    realismAxes: ["numeric_anchor", "short_lines", "otc_medication"],
    distractors: [
      { type: "otc_medication", name: "市販の白色ワセリン", note: "受診前の自己処置。算定しない" },
      { type: "considered_only", name: "破傷風トキソイド", note: "初診時に不要と判断済みの経緯記載のみ" }
    ],
    soap: {
      S: [
        "7/3に調理中の熱湯で右前腕を受傷し、当日から当院で処置中。受傷5日目。",
        "痛みはだいぶ軽くなった。夜は眠れている。仕事(調理補助)は患部を覆って続けている。",
        "受診前の2日間は自己判断で市販の白色ワセリンを塗っていたとのこと(初診時聴取済み)。"
      ],
      O: [
        "右前腕伸側に約4×3cmのII度熱傷。水疱は破れ、浸出液は少量に減少。",
        "周囲発赤なし、悪臭なし、感染徴候なし。上皮化が辺縁から始まっている。",
        "周囲の健常皮膚に掻破痕なし。指の可動・知覚は問題なし。",
        "創部を生理食塩水で洗浄し、熱傷部の処置を施行。非固着性ガーゼで保護。"
      ],
      A: [
        "右前腕II度熱傷、経過良好。感染なし。",
        "破傷風トキソイドは初診時に創の性状から不要と判断しており、方針変更なし。"
      ],
      P: [
        "ゲーベンクリーム1% 10gを院内処方。1日1回、入浴後に塗布しガーゼ保護を継続。",
        "1週間後に再診。浸出液増加・発赤・痛みの再燃があれば早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["熱傷"],
      requiredBillingSignals: ["熱傷処置", "ゲーベンクリーム", "調剤料", "処方料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["処方箋料", "破傷風トキソイド"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-08", is_outpatient: true, ...ENCOUNTER_BASE },
      drug_inputs: [{ code: "620008991", quantity: "10" }],
      outpatient_basic: { fee_kind: "revisit" },
      medication: { delivery_kind: "in_house", prescription_category: "other", dispensing_kinds: ["external"] },
      treatment_orders: [{ kind: "burn", area_size: "lt_100_cm2" }]
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 273,
      candidateCodes: ["620008991", "112007410", "120001010", "120001210", "140032010"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "熱傷処置（１００ｃｍ２未満）", points: 135 },
      { name: "ゲーベンクリーム１％ 10g", points: 13 },
      { name: "調剤料（外用薬）", points: 8 },
      { name: "処方料（その他）", points: 42 }
    ]
  },
  {
    caseId: "V2-IM-MED-004",
    title: "内科 上気道炎初診 院外処方(一般名)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L1",
    patient: { age: 29, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-07-21" },
    realismAxes: ["abbreviation", "prescription_detail", "negated_exam", "social_history"],
    distractors: [
      { type: "negated_exam", name: "インフルエンザ迅速検査", note: "流行状況と経過から不要と判断し実施せず" },
      { type: "social_context", name: "喫煙歴", note: "問診情報。算定対象なし" }
    ],
    soap: {
      S: [
        "3日前から咽頭痛と鼻汁。当院は初めての受診。",
        "発熱は昨日まで37度台前半、今朝は36度台。咳は少し。痰は白色少量。",
        "周囲に同様の症状の同僚が1人。家族は無症状。",
        "喫煙10本/日×9年。飲酒は機会飲酒。アレルギー歴なし、常用薬なし。",
        "仕事は営業職で、声を使うため早く治したいとのこと。"
      ],
      O: [
        "KT 36.9、BP 124/76、P 72整、SpO2 98%。",
        "咽頭軽度発赤、扁桃白苔なし。頸部リンパ節腫脹なし。",
        "肺音清、ラ音なし。心音整。",
        "解熱傾向で経過も典型的な感冒であり、インフルエンザ迅速検査は流行状況からも不要と判断し実施せず。"
      ],
      A: ["急性上気道炎。細菌性二次感染を示唆する所見なし。"],
      P: [
        "対症療法で経過をみる方針を説明。",
        "院外処方箋を交付(一般名処方)。カルボシステイン錠500mg 3T 分3 毎食後 7日分、トラネキサム酸錠250mg 3T 分3 7日分。",
        "禁煙が回復にも有利と説明し、リーフレットを渡した。",
        "1週間で改善しない、高熱が出る、呼吸が苦しい場合は再診を指示。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性上気道炎"],
      requiredBillingSignals: ["処方箋料", "一般名処方加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["調剤料", "インフルエンザウイルス抗原定性"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-21", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-005",
    title: "内科 頭痛精査再診 頭部CT(機器・電子保存は施設属性)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_imaging",
    difficultyLevel: "L2",
    patient: { age: 52, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-09" },
    realismAxes: ["abbreviation", "negative_findings", "facility_attribute_not_in_chart", "other_provider_history", "otc_medication"],
    distractors: [
      { type: "other_provider_past_imaging", name: "頭部MRI(他院・半年前)", note: "他院の過去検査。算定しない" },
      { type: "otc_medication", name: "市販ロキソニン", note: "市販薬。算定しない" },
      { type: "home_record", name: "血圧手帳", note: "自宅測定値。算定対象なし" }
    ],
    soap: {
      S: [
        "高血圧で当院通院中(アムロジピン継続中)。3日前から後頭部の鈍痛が持続するため予約外で来院。",
        "痛みは締め付けられる感じで一日中続く。朝にやや強い。嘔気・嘔吐なし、視覚異常なし。",
        "痛みは肩こりが強い日に悪化し、休日はやや軽い。今朝は5/10程度。",
        "市販のロキソニンを2回内服し、数時間は楽になる。",
        "半年前に人間ドックのオプションで他院の頭部MRIを受けており、その際は異常なしと言われたとのこと(本人談、画像は未持参)。",
        "血圧手帳では自宅血圧は朝130〜140台。最近仕事のストレスが強い。"
      ],
      O: [
        "BP 142/88、P 76整。",
        "意識清明。瞳孔正円同大、対光反射迅速。眼振なし。",
        "項部硬直なし。四肢の麻痺・しびれなし、歩行正常。腱反射左右差なし。",
        "後頸部から肩にかけて筋緊張が強く、圧痛あり。",
        "年齢と高血圧、痛みの持続を考慮し頭部CTを施行。出血・占拠性病変・明らかな虚血性変化なし。"
      ],
      A: [
        "緊張型頭痛が最も疑わしい。頭部CTで器質的疾患は否定的。",
        "他院MRI(半年前・異常なし)の経過とも矛盾しない。血圧はやや高め。"
      ],
      P: [
        "肩頸部のストレッチと入浴を指導。鎮痛薬は市販薬の頓用継続で可と説明。",
        "血圧は家庭血圧の記録を継続し、次回定期受診時に降圧薬の調整を検討。",
        "突然の激しい頭痛、麻痺、ろれつ難があれば直ちに受診するよう説明。",
        "次回の定期受診(今月末予約済み)で頭痛の経過も合わせて確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["緊張型頭痛"],
      requiredBillingSignals: ["ＣＴ撮影", "コンピューター断層診断"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["ＭＲＩ撮影"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-09", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" },
      imaging_orders: [{ kind: "ct", ct_equipment_kind: "multislice_16_to_64", electronic_image_management: true }]
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 1095,
      candidateCodes: ["112007410", "170011810", "170028810"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "ＣＴ撮影（１６列以上６４列未満マルチスライス型機器）", points: 900 },
      { name: "電子画像管理加算（コンピューター断層診断料）", points: 120 }
    ]
  },
  {
    caseId: "V2-ORTH-IMG-006",
    title: "整形外科 膝外傷初診 膝XP2方向(DR・電子画像管理なし施設)",
    department: "orthopedics",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 44, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-07-15" },
    realismAxes: ["abbreviation", "numeric_anchor", "planned_exam", "past_history"],
    distractors: [
      { type: "planned_exam", name: "MRI", note: "2週間後に検討。本日は算定しない" },
      { type: "past_history", name: "腰椎椎間板ヘルニア", note: "既往。本日の算定対象ではない" },
      { type: "home_medication", name: "湿布(自宅残り)", note: "処方なし" }
    ],
    soap: {
      S: [
        "2日前、駅の階段を下りる際に荷物を持ったまま右膝を内側に捻った。当院初診。",
        "受傷直後から内側の痛み。荷重時痛があり、階段下りで増悪。膝崩れ感・ロッキングはなし。",
        "腫れは昨日がピークで今日は少し引いた印象。自宅にあった湿布を貼って様子をみていた。",
        "既往: 5年前に腰椎椎間板ヘルニア(保存的治療で軽快)。常用薬なし。アレルギーなし。",
        "学生時代はサッカー。膝のけがは今回が初めて。",
        "仕事は倉庫内作業で、しゃがみ動作が多い。早期復帰を希望。"
      ],
      O: [
        "歩行は軽度跛行。右膝に軽度腫脹、熱感は軽度。皮下出血なし。膝蓋跳動は明らかでない。",
        "左膝と比較し周径+1cm程度。内側関節裂隙に圧痛。外反ストレスで疼痛誘発、明らかな不安定性なし。",
        "前方引き出し・ラックマン陰性。マクマレー陰性。可動域 0-130度(左は0-140度)。",
        "右膝XP 2方向(DR)を施行。骨折線なし、関節裂隙狭小化なし、骨棘なし。"
      ],
      A: [
        "右膝内側側副靭帯損傷(grade I-II)疑い。骨傷なし。",
        "半月板損傷は理学所見上は否定的だが、経過で再評価する。"
      ],
      P: [
        "サポーター装着と、しゃがみ込み・捻り動作の回避を指導。",
        "アイシングを1日数回。仕事は重量物を避ければ継続可と説明。",
        "2週間後に再診。改善が乏しければMRIを検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["内側側副靭帯損傷"],
      requiredBillingSignals: ["単純撮影", "写真診断"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["電子画像管理加算", "ＭＲＩ撮影"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-15", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" },
      imaging_orders: [{ kind: "simple_radiography", acquisition_kind: "digital", radiography_diagnostic_kind: "simple_i" }]
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 444,
      candidateCodes: ["111000110", "170000410", "170027910"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "初診料", points: 291 },
      { name: "単純撮影（イ）の写真診断", points: 85 },
      { name: "単純撮影（デジタル撮影）", points: 68 }
    ]
  },
  {
    caseId: "V2-CARD-MGMT-007",
    title: "循環器内科 高血圧・脂質異常 定期再診(管理料はレビュー)",
    department: "cardiology",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 67, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-10" },
    realismAxes: ["abbreviation", "chronic_followup", "past_lab_values", "planned_exam"],
    distractors: [
      { type: "past_lab_values", name: "前回採血(LDL/HbA1c)", note: "過去結果の参照。本日の検査ではない" },
      { type: "past_exam", name: "心電図(前回実施)", note: "本日は施行せず、と明記。算定しない" },
      { type: "planned_exam", name: "次回採血", note: "来月予定。本日は算定しない" },
      { type: "home_record", name: "家庭血圧記録", note: "自宅測定。算定対象なし" }
    ],
    soap: {
      S: [
        "高血圧・脂質異常症で月1回通院中。体調変化なし。",
        "家庭血圧は朝126〜134/78前後で安定。怠薬なし。残薬もなし。",
        "胸痛・動悸・息切れなし。下肢のむくみなし。夜間の睡眠は良好。",
        "ウォーキングは週3回30分を継続。間食を減らし、体重は1kg減。",
        "喫煙は20年前にやめた。飲酒はビール350mlを週2回程度。",
        "家族歴: 父が脳梗塞(70代)。妻と同居。減塩は「味噌汁を1日1杯にした」とのこと。"
      ],
      O: [
        "BP 134/82、P 70整。心音整、雑音なし。呼吸音清。下腿浮腫なし。",
        "前回(6/12)採血: LDL 118、HDL 52、TG 140、HbA1c 5.8。",
        "心電図は前回受診時に実施済みで異常なし(本日は施行せず)。",
        "体重 68.4kg(前回比 -1.0kg)、腹囲 86cm。"
      ],
      A: [
        "血圧・脂質ともコントロール良好。生活習慣の改善が維持できている。"
      ],
      P: [
        "生活習慣病の療養計画に沿って、減塩と運動継続を指導した。本人の目標(体重-2kg)を再確認。",
        "処方は前回と同じ内容を院外で継続(アムロジピン5mg、ロスバスタチン2.5mg)。",
        "次回は来月、定期採血を予定(脂質・肝腎機能・HbA1c)。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["高血圧"],
      requiredBillingSignals: ["生活習慣病管理料"],
      requiredReviewTopics: ["管理料確認", "同月履歴確認"],
      forbiddenCandidates: ["生活習慣病管理料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-10", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-SURG-PATH-008",
    title: "外科 背部腫瘤切除 病理提出(病理・手術はレビュー)",
    department: "surgery",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 58, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-17" },
    realismAxes: ["procedure_detail", "specimen_flow", "past_exam", "materials_mention"],
    distractors: [
      { type: "past_exam", name: "エコー(前回)", note: "前回実施済みの参照。本日の算定ではない" },
      { type: "other_provider_history", name: "前医での抗菌薬治療(2ヶ月前)", note: "他院の過去治療。算定しない" },
      { type: "allergy_check", name: "キシロカインアレルギー", note: "安全確認。算定対象なし" },
      { type: "otc_medication", name: "市販鎮痛薬(術後)", note: "必要時は市販で可と説明。処方なし" }
    ],
    soap: {
      S: [
        "背部のしこりが半年で増大し、前回受診時に切除の方針とした。本日切除目的で来院。",
        "痛みはないが、椅子の背もたれに当たって気になる。仕事は介護職で背部が当たる場面が多い。",
        "2ヶ月前に一度赤く腫れて痛み、近医(前医)で抗菌薬を処方され軽快した経緯あり。",
        "局所麻酔薬(キシロカイン)のアレルギー歴なし。抗凝固薬・抗血小板薬の内服なし。",
        "朝食は普通に摂取。仕事は明日から可能か質問あり。"
      ],
      O: [
        "背部正中やや右に約2cmの皮下腫瘤。可動性良好、圧痛なし。皮膚面に開口部様の黒点あり。",
        "周囲皮膚に発赤・熱感なし(炎症は消退)。",
        "前回施行のエコーでは境界明瞭な嚢腫様病変で、深部への連続なし(既評価)。",
        "BP 128/76、P 72。同意書を確認のうえ、消毒・ドレープ後、1%キシロカイン5mLで局所麻酔し腫瘤切除を施行。",
        "被膜ごと摘出、内容はアテローム様。出血少量で電気凝固は不要。5-0ナイロンで4針縫合。",
        "摘出検体はホルマリン固定し、病理組織診断へ提出。創部はガーゼで被覆。",
        "術後の気分不良なし、止血確認して帰宅可。"
      ],
      A: [
        "粉瘤の臨床診断。過去の感染エピソードは前医治療で消退しており、本日は非炎症期の摘出。",
        "肉眼的に悪性を示唆する所見なし、病理結果待ち。"
      ],
      P: [
        "創部は明日から短時間のシャワー可。入浴(湯船)は抜糸まで控える。明日と1週間後(抜糸)に再診。",
        "本日の運転は問題ないが、背部の突っ張り感があれば無理をしないよう説明。",
        "痛みが出た場合は市販の鎮痛薬で対応可と説明(処方なし)。",
        "病理結果は次回以降に説明。発赤・腫脹・痛みの増強があれば早めに受診。",
        "介護業務での背部圧迫は数日避け、重労働は抜糸まで控えるよう説明。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["粉瘤"],
      requiredBillingSignals: ["病理"],
      requiredReviewTopics: ["病理未対応", "検体提出確認", "手術未対応"],
      forbiddenCandidates: ["病理組織標本作製"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-17", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-EMER-TIME-009",
    title: "内科 夜間受診 腹痛(時間外系加算はレビュー)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 31, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-07-22" },
    realismAxes: ["time_context", "negative_findings", "negated_exam", "social_history"],
    distractors: [
      { type: "negated_exam", name: "心電図", note: "不要と判断し実施せず" },
      { type: "negated_exam", name: "採血", note: "経過観察可と判断し本日は行わず" },
      { type: "social_context", name: "飲酒歴", note: "問診情報" }
    ],
    soap: {
      S: [
        "21:10受付。夕食(焼肉、ビール500ml)の後、20時頃から心窩部痛が出現し来院。当院初診。",
        "痛みは持続性のしくしくした痛みで、増悪傾向はない。放散痛なし。嘔気は軽度、嘔吐なし。下痢なし。",
        "胸痛・背部痛・冷汗なし。同様の痛みは過去にも飲酒後に時々あった。",
        "最終排便は今朝で普通便。黒色便なし。海外渡航歴なし。",
        "ピロリ菌は「調べたことがない」とのこと。健診は毎年受けているが胃カメラは未経験。",
        "既往特記なし。常用薬なし。飲酒は週3回、ビール500ml程度。喫煙なし。本日は夜勤明けで睡眠不足。"
      ],
      O: [
        "KT 36.7、BP 126/78、P 74整、SpO2 99%。",
        "眼瞼結膜に貧血なし、眼球結膜に黄疸なし。",
        "腹部平坦・軟。腸蠕動音正常。心窩部に軽度圧痛、反跳痛・筋性防御なし。",
        "マーフィー徴候陰性。背部叩打痛なし。右下腹部に圧痛なし。",
        "胸部聴診で異常なし。皮疹なし。",
        "院内で30分程度経過を観察したが、痛みの増悪なく歩行・会話も問題なし。",
        "年齢・症状の性状・随伴症状から心疾患は否定的と判断し、心電図は実施せず。",
        "腹膜刺激徴候がなく全身状態良好のため、採血も本日は行わず経過観察可と判断。"
      ],
      A: [
        "急性胃炎(アルコール・食事性)疑い。緊急性を示す所見なし。",
        "胆石症・膵炎は所見上否定的。虫垂炎初期は完全には否定できないが、圧痛部位と経過から可能性は低い。"
      ],
      P: [
        "本日は飲食を控えめにし、水分は少量ずつ摂るよう指導。明朝改善なければ午前中に再診を指示。",
        "痛みの増強、痛みの右下腹部への移動、嘔吐、黒色便、発熱があれば夜間でも救急受診するよう説明。",
        "常習的な飲酒後の心窩部痛については、改善しなければ後日の内視鏡検査を相談する。飲酒量の見直しも助言。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性胃炎"],
      requiredBillingSignals: [],
      requiredReviewTopics: ["救急加算確認", "受付時刻確認"],
      forbiddenCandidates: ["時間外加算", "心電図", "内視鏡"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-22", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-HOME-010",
    title: "在宅 定期訪問診療(在宅領域は未対応レビュー)",
    department: "homecare",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L3",
    patient: { age: 84, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-07-11" },
    realismAxes: ["homecare_context", "caregiver", "planned_care", "medication_management"],
    distractors: [
      { type: "planned_care", name: "インフルエンザワクチン", note: "秋に予定の話題。本日は算定しない" },
      { type: "planned_exam", name: "認知機能スクリーニング", note: "次回検討。本日は実施なし" },
      { type: "medication_management_context", name: "一包化・服薬管理", note: "状況記載。本日の調剤行為ではない" }
    ],
    soap: {
      S: [
        "月2回の定期訪問診療。独居・要介護2。娘が週3回訪問し、ヘルパーが週2回。",
        "食欲は安定し、3食摂れている。夜間の咳なし。息切れの自覚なし。睡眠は中途覚醒1回程度。",
        "服薬は一包化したものを娘がカレンダーにセットし、飲み忘れはほぼない。",
        "先月からデイサービスを週1回利用開始し、「行くのが楽しみ」とのこと。",
        "娘より「最近、同じ話を繰り返すことが少し気になる」との相談あり。",
        "「最近は朝の体操を再開した」とのこと。転倒なし。"
      ],
      O: [
        "BP 128/70、P 68整、SpO2 97%(室内気)、KT 36.4。体重は娘の計測で42.8kg(横ばい)。",
        "心音整、呼吸音清。下腿浮腫なし。頸静脈怒張なし。褥瘡なし。",
        "口腔内の乾燥なし、皮膚の張りも保たれ脱水所見なし。",
        "居室内の移動は伝い歩きで安定。室温・湿度は適切に管理されている(エアコン使用)。",
        "住環境に大きな段差なし、手すり設置済み。",
        "会話は成立し、日付の見当識も保たれている。診察中の応答に大きな低下は感じない。"
      ],
      A: [
        "慢性心不全・高血圧、在宅で安定。服薬アドヒアランス良好。",
        "ADLは維持。脱水・低栄養の徴候なし。",
        "もの忘れの訴えは現時点で生活に支障なし。次回以降に簡易的な評価を検討。"
      ],
      P: [
        "内服は現行どおり継続。残薬を確認し、次回処方分の数量を調整予定。次回訪問は2週間後。",
        "暑い時期のため、水分摂取と室温管理の継続を本人と娘に説明(熱中症予防)。",
        "体重が2kg以上増える、夜間の息苦しさが出る場合は臨時連絡するよう娘とケアマネに共有。",
        "もの忘れについては次回訪問時に簡易スクリーニングを検討すると娘に説明。",
        "秋のインフルエンザワクチンは10月頃に訪問時接種を予定として相談。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["慢性心不全"],
      requiredBillingSignals: [],
      requiredReviewTopics: ["在宅医療未対応", "訪問診療確認"],
      forbiddenCandidates: ["在宅患者訪問診療料", "インフルエンザワクチン"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-07-11", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "unsupported_expected",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "再診料", points: 75 }]
  }
];
