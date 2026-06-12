// v2 batch-010: blueprint V2BP-0102〜0111 を手書きSOAPへ落とす第6追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-102",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.nocturia.v1",
    title: "内科 夜間頻尿再診 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 68, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-31" },
    realismAxes: ["negative_findings", "urology_symptom", "no_blood_collection", "planned_referral"],
    distractors: [
      { type: "planned_referral", name: "泌尿器科", note: "後日紹介検討" },
      { type: "home_record", name: "排尿日誌", note: "患者記録" },
      { type: "negated_exam", name: "静脈採血", note: "本日は採血しない" }
    ],
    soap: {
      S: [
        "夜間頻尿で前回相談し、本日再診。夜間2〜3回の排尿が続く。",
        "排尿痛なし、血尿なし。日中の尿意切迫は軽度。",
        "排尿日誌をつけ始めたが、飲水量の記載は不十分。",
        "カフェインを夕方以降に飲む日があり、本人も影響を気にしている。",
        "泌尿器科受診が必要か相談したいと話す。",
        "睡眠不足が続いており、夜間頻尿で日中の眠気も出ている。"
      ],
      O: [
        "BP 126/72、P 70整。下腿浮腫なし。",
        "腹部平坦・軟、下腹部圧痛なし。発熱なし。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(-)、尿糖(-)、潜血(-)、白血球反応(-)。",
        "本日は静脈採血を行っていない。前立腺関連検査は次回以降に検討。",
        "尿検査結果は陰性項目を含め、その場で本人へ説明した。"
      ],
      A: [
        "夜間頻尿。感染や血尿を示す所見は乏しい。",
        "尿検査は本日の症状確認として実施した。"
      ],
      P: [
        "夕方以降のカフェインと就寝前飲水を控えるよう説明。",
        "排尿日誌を継続し、尿量と飲水量を合わせて記録する。",
        "泌尿器科紹介は症状持続時に検討するが、本日は紹介状作成なし。",
        "採血は本日実施しておらず、必要時に改めて相談する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["夜間頻尿"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ", "泌尿器科紹介"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-31", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160000310", "160000410"],
      outpatient_basic: { fee_kind: "revisit" }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 142,
      candidateCodes: ["160000310", "160000410", "112007410", "160061710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "尿一般", points: 26 },
      { name: "尿蛋白", points: 7 },
      { name: "尿・糞便等検査判断料", points: 34 }
    ]
  },
  {
    caseId: "V2-IM-LAB-103",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.office_cluster.v1",
    title: "内科 職場クラスター後の簡易検査 コード確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 27, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-01" },
    realismAxes: ["ambiguous_test_name", "exposure_context", "external_result", "planned_followup"],
    distractors: [
      { type: "external_result", name: "会社検査", note: "外部検査" },
      { type: "planned_exam", name: "再検査", note: "予定のみ" },
      { type: "otc_medication", name: "市販感冒薬", note: "自己使用" }
    ],
    soap: {
      S: [
        "職場で発熱者が複数出た後、咽頭違和感と倦怠感で再診。",
        "会社で検査を勧められたが、実施内容や結果票は手元にない。",
        "市販感冒薬を昨夜飲んだ。眠気があり今日は服用していない。",
        "咳は軽く、息苦しさはない。食事は取れている。",
        "同居家族に高齢者がいるため、早めに確認したいと希望。"
      ],
      O: [
        "KT 37.0、BP 106/64、P 80整、SpO2 99%。",
        "咽頭発赤軽度、扁桃腫大なし。胸部聴診で明らかなラ音なし。",
        "院内で感染確認目的の簡易検査を実施したが、検査キット名と標準コードを確定できる記載が残っていない。",
        "結果は陰性相当として説明。会社検査は外部情報であり、本日の自院検査とは別。",
        "症状が続く場合は再検査や通常採血を後日検討する。"
      ],
      A: [
        "軽い急性上気道炎を疑う。重症化を示す所見なし。",
        "当日実施した簡易検査は標準コード確認が必要。"
      ],
      P: [
        "休養、水分摂取、家庭内感染対策を説明。",
        "検査キット名と院内記録を確認し、標準コード候補を確認する。",
        "会社検査や後日の再検査予定は今回の自院実施分とは分ける。",
        "発熱持続や息苦しさがあれば再診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性上気道炎疑い"],
      requiredBillingSignals: ["感染確認簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["会社検査", "再検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-01", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-NEG-104",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.checkup_anemia.v1",
    title: "内科 健診貧血相談 当日採血なし",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 45, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-09-02" },
    realismAxes: ["external_result", "negated_action", "diet_context", "planned_lab"],
    distractors: [
      { type: "external_result", name: "健診", note: "外部健診結果" },
      { type: "planned_exam", name: "採血", note: "次回予定" },
      { type: "diet_context", name: "菜食中心", note: "生活背景" }
    ],
    soap: {
      S: [
        "健診で貧血気味と言われ初診。結果票を持参。",
        "最近は菜食中心で、肉類をあまり食べていない。",
        "立ちくらみは時々あるが、失神なし。黒色便なし。",
        "月経量は以前と大きく変わらない。",
        "本人は今日すぐ採血が必要か相談したい。",
        "仕事は立ち仕事で、夕方に疲れやすい日があるという。"
      ],
      O: [
        "BP 112/66、P 76整。眼瞼結膜は軽度蒼白。",
        "健診結果票でヘモグロビン軽度低値を確認。",
        "本日は採血を行っていない。便潜血検査も本日は実施していない。",
        "持参結果は外部資料として確認し、当日自院実施の検査ではない。",
        "腹部圧痛なし、体重減少なし。緊急性の高い出血を示す所見はない。",
        "結果票は確認したが、今日の検査として新たな検体提出はしていない。"
      ],
      A: [
        "軽度貧血疑い。食事内容や月経状況を含めて経過確認。",
        "今回の記録では当日実施した検体検査はない。"
      ],
      P: [
        "鉄を含む食品の摂取を説明。症状が強ければ早めに受診。",
        "必要時は次回、当院で採血を行い詳細確認する。",
        "本日は外部健診結果の確認と生活指導のみで、自院検査は実施していない。",
        "黒色便、動悸、息切れが出る場合は早期受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["貧血疑い"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["検査実施料", "健診ヘモグロビン", "便潜血検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-02", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SURG-105",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.ingrown_nail.v1",
    title: "内科 陥入爪疑い 爪処置相談のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 24, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-09-03" },
    realismAxes: ["surgery_context", "nail_context", "negated_action", "sports_context"],
    distractors: [
      { type: "surgery_context", name: "爪切除", note: "手術相談" },
      { type: "negated_treatment", name: "局所麻酔", note: "本日は実施なし" },
      { type: "sports_context", name: "サッカー", note: "生活背景" }
    ],
    soap: {
      S: [
        "右母趾の爪周囲が痛く初診。サッカー後に悪化した。",
        "爪の端が皮膚に食い込む感じがあり、歩くと痛い。",
        "膿は出ていない。発熱なし。",
        "本人は爪を切って処置する必要があるか相談したい。",
        "試合が近く、どの程度運動を控えるべきかも知りたい。",
        "自宅では入浴後に清潔にしていたが、テーピングはしていない。"
      ],
      O: [
        "右母趾外側爪郭に軽度発赤と圧痛。明らかな膿瘍なし。",
        "爪棘が軽度疑われるが、深い陥入ははっきりしない。",
        "本日は爪切除、切開、局所麻酔は行っていない。",
        "歩行は可能。周囲蜂窩織炎を示す広範な発赤なし。",
        "画像検査や採血は本日行っていない。",
        "靴の圧迫で痛みが増えるため、履物の調整が必要と判断した。"
      ],
      A: [
        "軽度陥入爪疑い。手術的処置の要否は経過で判断。",
        "爪処置・手術領域の判断が含まれるため、自動算定せず確認が必要。"
      ],
      P: [
        "爪を深く切りすぎないこと、圧迫の少ない靴を使うことを説明。",
        "発赤拡大、排膿、痛み増悪があれば早めに受診。",
        "必要時は皮膚科または外科で爪処置を相談する。",
        "本日は爪切除や局所麻酔を実施していない。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["陥入爪疑い"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["爪切除", "局所麻酔"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-03", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" }
    },
    expectedCalculation: {
      assertionLevel: "unsupported_expected",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "初診料", points: 291 }]
  },
  {
    caseId: "V2-IM-SPLIT-106",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.copd_exacerbation.v1",
    title: "内科 COPD増悪入院 2日分混在",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 76, sex: "male" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-09-04" },
    realismAxes: ["multi_day", "inpatient_context", "oxygen_context", "home_medication"],
    distractors: [
      { type: "previous_day_imaging", name: "胸部X線", note: "別日画像" },
      { type: "previous_day_lab", name: "採血", note: "別日検査" },
      { type: "home_medication", name: "持参吸入薬", note: "持参薬" }
    ],
    soap: {
      S: [
        "9/3に息切れ増悪で入院。9/4朝は「昨日より呼吸が楽」と話す。",
        "入院前から吸入薬を使っているが、最近は回数が増えていた。",
        "9/3夜は咳で眠れず、9/4朝は痰が少し切れやすい。",
        "持参吸入薬の残量と用法を薬剤部で確認中。",
        "本人と家族への説明が9/3分と9/4分で同じ記録に並んでいる。",
        "発熱はなく、食事は朝食を半分摂取できた。",
        "夜間は酸素チューブが気になり何度か目が覚めたと話す。"
      ],
      O: [
        "9/3入院時: 胸部X線で過膨張、採血でCO2貯留傾向。酸素1L開始。",
        "9/4本日: BP 132/74、P 88整、SpO2 94%(酸素1L)。呼吸数20/分。",
        "両側でwheeze軽度。努力呼吸は前日より軽減。",
        "9/3の胸部X線と採血、9/4の回診評価が同じSOAP内に混在している。",
        "持参吸入薬は確認中で、当院処方や吸入指示とは分けて整理している。",
        "本日の酸素継続評価と前日の酸素開始記録が続けて記載されている。",
        "看護記録上も9/3夜と9/4朝の観察が連続しており、日付整理が必要。"
      ],
      A: [
        "COPD増悪で入院加療中。呼吸状態は改善傾向。",
        "9/3の入院時検査・画像と9/4の回診・酸素評価を日付で分ける必要がある。"
      ],
      P: [
        "9/4分として酸素、吸入、呼吸状態の観察を継続。",
        "持参吸入薬の内容確認後、当院指示に整理する。",
        "9/3の胸部X線・採血と本日の回診内容は分割確認する。",
        "明日以降の採血や画像は症状経過で判断する。",
        "複数日の検査・投薬・酸素指示が混在するため、このSOAP単独で一括算定しない。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["COPD増悪"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["胸部X線", "9/3採血", "持参吸入薬"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-04", is_outpatient: false, ...ENCOUNTER_BASE }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: []
  },
  {
    caseId: "V2-IM-LAB-107",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.hypertension_followup.v1",
    title: "内科 高血圧フォロー 同月内採血確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 63, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-05" },
    realismAxes: ["same_month_history", "home_record", "medication_context", "planned_exam"],
    distractors: [
      { type: "same_month_history", name: "9/1採血", note: "同月内検査" },
      { type: "home_record", name: "家庭血圧", note: "患者記録" },
      { type: "planned_exam", name: "心電図", note: "予定のみ" }
    ],
    soap: {
      S: [
        "高血圧で再診。9/1に腎機能と電解質の採血を確認済み。",
        "家庭血圧は朝に150台の日があり、本人は薬が足りないのではと心配。",
        "頭痛なし、胸痛なし、息切れなし。内服忘れは週1回程度。",
        "本日は再度採血して安全性を確認したいと希望。",
        "心電図は次回の健診時に相談したいと話す。",
        "塩分を控えているつもりだが、外食時の味付けは濃いと自覚している。"
      ],
      O: [
        "BP 146/82、P 72整。下腿浮腫なし。",
        "9/1採血では腎機能と電解質に大きな異常なし。",
        "本人希望で本日も降圧薬調整前の確認として静脈採血を実施。",
        "同月内に類似検査があり、前回採血と今回採血の目的を分けて記録した。",
        "心電図は本日実施していない。家庭血圧は患者記録として確認した。",
        "胸部症状や浮腫はなく、緊急の循環器検査を要する所見は乏しい。"
      ],
      A: [
        "高血圧症。家庭血圧高値があり、内服状況と検査重複を確認する。",
        "同月内の前回検査と今回再検の目的を区別して記録する必要あり。"
      ],
      P: [
        "内服忘れを減らす方法を相談。家庭血圧記録を継続。",
        "前回採血と本日採血の重複項目を算定時に確認する。",
        "心電図は予定であり、本日の自院実施検査ではない。",
        "採血結果を見て必要なら薬剤調整を検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["高血圧症"],
      requiredBillingSignals: ["腎機能検査"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["心電図"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-05", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-108",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.renal_check.v1",
    title: "内科 尿蛋白フォロー 尿+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 57, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-06" },
    realismAxes: ["lab_raw_values", "renal_context", "external_result", "negative_findings"],
    distractors: [
      { type: "external_result", name: "健診尿蛋白", note: "外部健診結果" },
      { type: "planned_exam", name: "腎エコー", note: "後日検討" },
      { type: "home_record", name: "体重記録", note: "患者記録" }
    ],
    soap: {
      S: [
        "健診で尿蛋白を指摘され、前回から経過観察中の再診。",
        "体重記録では大きな変動なし。むくみの自覚なし。",
        "健診尿蛋白は外部検査で、詳細な検査票は持参していない。",
        "尿量低下なし、血尿自覚なし。塩分摂取は多め。",
        "本人は腎機能が悪くなっていないか気にしている。",
        "夜間の飲水量が多く、朝の尿が濃い日があると話す。"
      ],
      O: [
        "BP 134/78、P 70整。下腿浮腫なし。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(±)、潜血(-)、尿糖(-)、白血球反応(-)。",
        "同日に静脈採血を行い、腎機能と電解質の検体を提出。",
        "腎エコーは本日行っていない。健診尿蛋白は外部情報として扱った。",
        "採血と採尿はいずれも本日の腎機能評価として実施した。",
        "健診時の指摘は参考にするが、本日の結果と混同しないよう説明した。"
      ],
      A: [
        "尿蛋白指摘後のフォロー。腎機能評価を行う。",
        "尿検査と採血は本日実施。"
      ],
      P: [
        "塩分制限と体重記録を説明。結果は次回説明する。",
        "採血結果で悪化があれば腎エコーや専門紹介を検討。",
        "健診結果は参考情報として扱い、今回の自院検査とは分ける。",
        "浮腫、尿量低下、血尿があれば早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["尿蛋白"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["腎エコー", "健診尿蛋白"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-06", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-109",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.back_pain.v1",
    title: "内科 背部痛 CT実施 造影・保存確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 62, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-07" },
    realismAxes: ["imaging_performed", "contrast_unknown", "external_result", "planned_exam"],
    distractors: [
      { type: "external_result", name: "整形外科X線", note: "他院過去情報" },
      { type: "planned_exam", name: "MRI", note: "後日検討" },
      { type: "medication_context", name: "鎮痛薬", note: "処方未確定" }
    ],
    soap: {
      S: [
        "背部痛が続き再診。体位で変わるが、内臓疾患も心配している。",
        "数か月前に整形外科でX線は異常なしと言われたが、画像は持参なし。",
        "発熱なし、血尿なし。食欲は保たれている。",
        "鎮痛薬は必要なら使いたいが、胃が弱く不安がある。",
        "本人は詳しい画像で確認したいと希望。",
        "痛みで睡眠が浅く、仕事中に姿勢を変える回数が増えたという。"
      ],
      O: [
        "BP 126/76、P 72整。CVA叩打痛は明らかでない。",
        "腹部平坦・軟、圧痛なし。背部筋緊張あり。",
        "本日、腹部CTを実施。明らかな腎結石や腹部腫瘤は認めない。",
        "造影有無は診察本文だけでは読み取れず、必要時は撮影記録を参照する。",
        "MRIは症状が続く場合に後日検討。本日は行っていない。",
        "整形外科X線は他院の過去情報として扱った。",
        "撮影後、結果説明までバイタル変動なく経過した。"
      ],
      A: [
        "背部痛。CT上、急性腹部疾患を示す明らかな所見なし。",
        "画像撮影条件の確認が必要。"
      ],
      P: [
        "姿勢、ストレッチ、過度な負荷回避を説明。",
        "発熱、血尿、痛み増悪があれば早めに受診。",
        "鎮痛薬は胃症状を確認し、必要時のみ検討する。",
        "CTの撮影条件は検査記録を確認して算定へ反映する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["背部痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認"],
      forbiddenCandidates: ["整形外科X線", "MRI"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-07", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-110",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.sinusitis_followup.v1",
    title: "内科 副鼻腔炎疑い再診 血算+CRP",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 39, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-08" },
    realismAxes: ["lab_raw_values", "past_value", "upper_respiratory_context", "negated_imaging"],
    distractors: [
      { type: "past_lab_values", name: "前回", note: "過去値" },
      { type: "planned_exam", name: "副鼻腔CT", note: "本日は実施なし" },
      { type: "otc_medication", name: "市販点鼻薬", note: "自己使用" }
    ],
    soap: {
      S: [
        "鼻汁と頬部痛で前回受診し、副鼻腔炎疑いとして再診。",
        "「頬の痛みは少し軽いが、膿っぽい鼻汁が残る」。発熱はない。",
        "市販点鼻薬を使ったが、効果は一時的だった。",
        "前回は炎症反応が高いと言われ、改善しているか心配。",
        "仕事中に鼻閉が強く、集中しづらいと話す。",
        "夜間は口呼吸になり、朝に喉が乾くことがある。"
      ],
      O: [
        "KT 36.8、BP 110/68、P 74整。",
        "咽頭発赤軽度。両側上顎洞部に圧痛軽度。胸部聴診異常なし。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 7200、CRP 1.1。",
        "前回はWBC 10500、CRP 3.6で、改善傾向。",
        "副鼻腔CTは症状改善傾向のため本日は行っていない。",
        "採血は当日の炎症評価として実施した。",
        "前回より顔面痛は軽く、眼窩痛や視力障害は認めない。"
      ],
      A: [
        "副鼻腔炎疑いは改善傾向。炎症反応も低下。",
        "画像検査を急ぐ所見は乏しい。"
      ],
      P: [
        "鼻洗浄、加湿、休養を指導。症状再燃時は受診。",
        "採血結果を説明し、前回値と本日値を分けて記録した。",
        "市販点鼻薬の連用は避けるよう説明。",
        "画像検査は症状が長引く場合に改めて検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["副鼻腔炎疑い"],
      requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["副鼻腔CT"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-08", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160054710", "160008010"],
      outpatient_basic: { fee_kind: "revisit" },
      lab_options: { collection_fee_inputs: ["blood_venous"] }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 421,
      candidateCodes: ["160054710", "160008010", "112007410", "160061810", "160062110", "160095710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "CRP", points: 16 },
      { name: "末梢血液一般", points: 21 },
      { name: "血液学的検査判断料", points: 125 },
      { name: "免疫学的検査判断料", points: 144 },
      { name: "Ｂ－Ｖ", points: 40 }
    ]
  },
  {
    caseId: "V2-IM-IMG-111",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.fall_head.v1",
    title: "内科 転倒後頭部打撲 頭部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 80, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-09-09" },
    realismAxes: ["imaging_performed", "equipment_unknown", "fall_context", "anticoagulant_context"],
    distractors: [
      { type: "home_medication", name: "抗凝固薬", note: "内服背景" },
      { type: "planned_exam", name: "MRI", note: "後日検討" },
      { type: "home_context", name: "自宅転倒", note: "受傷背景" }
    ],
    soap: {
      S: [
        "自宅転倒後に後頭部を打ち初診。意識消失はなかった。",
        "抗凝固薬を内服中で、家族が心配して受診。",
        "頭痛は軽度、嘔吐なし。手足の麻痺やしびれなし。",
        "転倒時は段差につまずいたとのこと。めまいは否定。",
        "本人は普段より少し不安そうだが、会話は普段通り。",
        "家族は夜間に様子を見る予定で、観察ポイントを知りたいと話す。"
      ],
      O: [
        "BP 144/78、P 76整。意識清明。",
        "後頭部に軽度圧痛。皮下血腫は小さく、出血は止まっている。",
        "四肢麻痺なし、構音障害なし、瞳孔左右差なし。",
        "本日、頭部CTを施行。明らかな頭蓋内出血や骨折所見なし。",
        "撮影装置の詳細は診察本文には記載されておらず、必要時は検査記録を参照する。",
        "MRIは症状変化があれば後日検討。本日は実施していない。",
        "歩行は見守りで可能で、診察中に新たな神経症状は出ていない。"
      ],
      A: [
        "頭部打撲。抗凝固薬内服中だが、CT上明らかな出血なし。",
        "頭部CTの撮影条件は検査記録で整理する。"
      ],
      P: [
        "嘔吐、頭痛増悪、意識変容、麻痺があれば救急受診。",
        "家族へ今夜の観察ポイントを説明。",
        "抗凝固薬は主治医指示通り継続し、勝手に中止しないよう説明。",
        "撮影装置の詳細は検査記録を参照する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["頭部打撲"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["MRI", "抗凝固薬"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-09", is_outpatient: true, ...ENCOUNTER_BASE },
      outpatient_basic: { fee_kind: "initial" }
    },
    expectedCalculation: {
      assertionLevel: "review_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: [{ name: "初診料", points: 291 }]
  }
];
