// v2 batch-007: blueprint V2BP-0072〜0081 を手書きSOAPへ落とす第3追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-072",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.past_value.v1",
    title: "内科 尿道違和感再診 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 29, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-01" },
    realismAxes: ["past_value", "negative_findings", "sexual_history_context", "no_blood_collection"],
    distractors: [
      { type: "past_external_test", name: "外部検査", note: "過去の外部検査" },
      { type: "planned_exam", name: "クラミジア等の検査", note: "症状遷延時の予定" },
      { type: "negated_exam", name: "静脈採血", note: "本日は採血しない" },
      { type: "self_care_before_visit", name: "水分", note: "本人の生活対応" }
    ],
    soap: {
      S: [
        "排尿時の違和感で前回受診し、本日再診。",
        "「痛みというほどではないが、朝だけむずむずする」。発熱なし、下腹部痛なし。",
        "半年前に外部検査で性感染症は陰性と言われたが、結果票は持参していない。",
        "前回以降は水分を増やしており、日中の症状は軽くなっている。",
        "血尿の自覚なし。性器分泌物なし。本人は検査を増やすべきか気にしている。"
      ],
      O: [
        "KT 36.4、BP 118/70、P 70整。",
        "下腹部圧痛なし。外陰部診察は本人希望なく本日は行っていない。",
        "院内で尿定性と尿蛋白を実施。白血球反応(±)、亜硝酸塩(-)、尿蛋白(-)、尿糖(-)、潜血(-)。",
        "本日は静脈採血を行っていない。クラミジア等の検査は症状が続く場合に次回検討。",
        "外部検査の過去結果は参考情報として問診に記録した。"
      ],
      A: [
        "軽度尿道炎または一過性刺激症状を疑う。全身症状や明らかな感染徴候は乏しい。",
        "本日の尿検査は当日の症状評価として実施したもの。"
      ],
      P: [
        "水分摂取を継続し、刺激物と飲酒を控えるよう説明。",
        "排尿痛増悪、分泌物、発熱があれば早めに受診。",
        "過去の外部検査は今回の自院検査として扱わず、必要時に次回改めて検査を検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["尿道炎疑い"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ", "クラミジア検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-01", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-073",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.external_result.v1",
    title: "内科 微熱 倦怠感 検査コード確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 36, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-02" },
    realismAxes: ["external_result", "ambiguous_test_name", "occupational_context", "planned_exam"],
    distractors: [
      { type: "external_result", name: "職場健診の白血球値", note: "外部健診結果" },
      { type: "otc_medication", name: "市販解熱薬", note: "自己使用" },
      { type: "planned_exam", name: "通常採血", note: "予定のみ" }
    ],
    soap: {
      S: [
        "微熱と倦怠感で再診。仕事が忙しく、睡眠不足が続いている。",
        "職場健診で白血球が少し高いと言われたが、結果票はまだ手元にない。",
        "市販解熱薬を一度使ったが、今日は内服していない。",
        "咳は軽度、咽頭痛なし。体重減少なし。本人は感染症が長引いていないか心配。"
      ],
      O: [
        "KT 37.1、BP 112/68、P 84整、SpO2 99%。",
        "咽頭発赤軽度、胸部聴診で明らかなラ音なし。腹部平坦・軟。",
        "本日、院内で炎症反応をみる簡易検査を実施したが、記録上は検査方法と標準コードを確定できる名称が残っていない。",
        "結果は軽度陽性相当として本人へ説明。職場健診の白血球値は外部情報として扱う。",
        "次回、症状が続く場合は通常採血で血算・CRPを検討する。"
      ],
      A: [
        "軽い上気道炎後の倦怠感を疑う。重篤な感染症を示す所見は乏しい。",
        "本日の簡易検査は標準コード確認が必要。"
      ],
      P: [
        "休養と水分摂取を指導。発熱持続、息切れ、強い咳があれば再診。",
        "検査キット名または院内記録を確認し、標準コードの候補を確認する。",
        "職場健診結果は届いたら持参してもらい、自院実施分とは分けて判断する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["微熱"],
      requiredBillingSignals: ["炎症反応簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["職場健診白血球", "次回通常採血"]
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
    caseId: "V2-IM-NEG-074",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.planned_order.v1",
    title: "内科 胃部不快 採血・便検査見送り",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 48, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-03" },
    realismAxes: ["negated_action", "planned_order", "external_result", "diet_context"],
    distractors: [
      { type: "external_result", name: "健診便潜血陰性", note: "外部健診結果" },
      { type: "planned_exam", name: "次回採血", note: "予定のみ" },
      { type: "diet_context", name: "飲酒", note: "生活背景" }
    ],
    soap: {
      S: [
        "胃部不快感で再診。食後にもたれるが、痛みは強くない。",
        "健診では便潜血陰性と言われた。結果票はスマートフォン写真で確認。",
        "週末の飲酒と外食が続いた後から症状が出たと本人は話す。",
        "黒色便なし、嘔吐なし、体重減少なし。",
        "前回同様の胃もたれで受診した時は生活指導のみで改善したと話す。"
      ],
      O: [
        "KT 36.5、BP 126/78、P 76整。",
        "腹部平坦・軟、心窩部に軽度圧痛。反跳痛なし。",
        "本日は本人希望もあったが、症状が軽く、採血と便検査は行わなかった。",
        "健診便潜血陰性は外部結果の確認のみ。症状が続けば次回採血と便検査を検討する。",
        "腹部エコーや内視鏡は本日実施していない。"
      ],
      A: [
        "機能性ディスペプシアまたは軽い胃炎を疑う。",
        "今回の記録内に当日実施した検体検査はない。"
      ],
      P: [
        "飲酒・脂っこい食事を控え、少量ずつ食べるよう指導。",
        "黒色便、吐血、体重減少があれば早期受診。",
        "次回検査を行う場合は、当日実施分として改めて記録する。",
        "本人には、今日の健診結果確認は外部資料の参照であり、自院検査ではないことを説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["胃炎疑い"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["採血", "便検査", "検査実施料"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-03", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SURG-075",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.negated_action.v1",
    title: "内科 皮膚異物疑い 摘出相談のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 41, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-04" },
    realismAxes: ["surgery_context", "foreign_body_context", "negated_action", "normal_negative_result"],
    distractors: [
      { type: "external_history", name: "刺し傷", note: "受傷状況" },
      { type: "negated_treatment", name: "異物摘出", note: "本日は実施なし" },
      { type: "normal_negative_result", name: "感染徴候", note: "陰性所見" }
    ],
    soap: {
      S: [
        "右手掌に小さな刺し傷があり、木片が残っていないか心配で初診。",
        "2日前、職場で段ボールを片付けている際に木片が刺さった。",
        "自分で抜いたつもりだが、押すと違和感がある。発熱なし。",
        "本人は「切って取る必要があるか」を相談したいと希望。",
        "利き手のため、仕事で手を使う時に違和感が続くことを心配している。"
      ],
      O: [
        "右手掌に1mm程度の刺入痕。周囲発赤はごく軽度、排膿なし。",
        "触診で明らかな異物硬結は触れない。指の運動障害なし、知覚低下なし。",
        "本日は皮膚切開や異物摘出を行っていない。洗浄し、創部を観察した。",
        "感染徴候が乏しく、緊急処置は不要と判断。",
        "明らかな異物が触れず、画像検査も本日は行っていない。"
      ],
      A: [
        "皮膚異物残存の可能性は低いが、違和感が続く場合は外科的確認が必要。",
        "手術・摘出領域の相談であり、現行自動算定では人手確認が必要。"
      ],
      P: [
        "発赤拡大、排膿、強い痛みがあれば早めに受診。",
        "違和感が続く場合は外科紹介を検討し、必要なら画像や摘出手技の要否を確認する。",
        "本日は切開や摘出をしていないことを本人へ説明した。",
        "手術的な対応が必要な場合は、処置内容と麻酔の有無を紹介先で確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["皮膚異物疑い"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["異物摘出", "皮膚切開"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-04", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SPLIT-076",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.otc_or_home_med.v1",
    title: "内科 心不全入院 2日分混在メモ",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 78, sex: "male" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-08-05" },
    realismAxes: ["multi_day", "inpatient_context", "home_medication", "dose_unclear"],
    distractors: [
      { type: "previous_day_imaging", name: "胸部X線", note: "入院時の別日検査" },
      { type: "previous_day_lab", name: "BNP", note: "別日採血" },
      { type: "home_medication", name: "持参薬", note: "入院前からの薬" },
      { type: "dose_unclear", name: "利尿薬調整", note: "用量整理が必要" }
    ],
    soap: {
      S: [
        "8/4に息切れと下腿浮腫で入院。8/5朝は「昨日より横になるのが楽」と話す。",
        "入院前から利尿薬を内服していたが、最近飲み忘れがあった。",
        "8/4夜はトイレ回数が多く眠りが浅かった。8/5朝は食事を7割摂取。",
        "家族は持参薬の量を正確に把握しておらず、薬袋確認中。",
        "本人は「昨日と今日で何をしたのか、家族への説明が混ざってしまった」と話す。"
      ],
      O: [
        "8/4入院時: 胸部X線でうっ血像、採血でBNP高値。酸素1L開始。",
        "8/5本日: BP 136/82、P 88整、SpO2 96%(鼻カニュラ1L)。下腿浮腫は軽度残存。",
        "8/5朝の尿量は前日より増加。体重は入院時から0.8kg減。",
        "利尿薬の追加指示は出ているが、8/4入院時の指示と8/5分の実施記録が同じSOAP内に混在している。",
        "持参薬は薬剤部確認中で、重複投与は避けている。",
        "8/4夜の酸素開始と8/5朝の酸素継続評価が同じ記録内に並んでいる。"
      ],
      A: [
        "心不全増悪で入院加療中。うっ血は改善傾向。",
        "8/4の入院時検査・画像と8/5の回診・治療評価を日付で分ける必要がある。"
      ],
      P: [
        "8/5分として酸素と利尿薬調整を継続。尿量、体重、腎機能を確認する。",
        "持参薬の内容確認後、内服再開・中止を整理する。",
        "会計・記録上、入院時の胸部X線と採血は8/4分、本日の回診内容は8/5分として分割確認する。",
        "8/5時点では退院日は未定で、明日以降の採血や画像の要否は経過で判断する。",
        "日付をまたいだ検査・投薬・回診が混在するため、このSOAP単独で一括算定しない。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["心不全"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["8/4胸部X線", "8/4BNP", "持参利尿薬"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-05", is_outpatient: false, ...ENCOUNTER_BASE }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: []
  },
  {
    caseId: "V2-IM-LAB-077",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.family_history.v2",
    title: "内科 肝機能フォロー 同月内検査確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 39, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-06" },
    realismAxes: ["same_month_history", "family_history", "alcohol_history", "past_value"],
    distractors: [
      { type: "same_month_history", name: "8/2の採血", note: "同月内検査" },
      { type: "family_history", name: "父が肝硬変", note: "家族歴" },
      { type: "alcohol_history", name: "飲酒量", note: "生活背景" }
    ],
    soap: {
      S: [
        "肝機能異常で再診。8/2に採血済みで、本日は結果説明と再検希望。",
        "本人は「父が肝硬変だったので心配」と話す。",
        "飲酒は週3回、缶ビール2本程度。最近外食が多い。",
        "黄疸自覚なし、腹痛なし、発熱なし。",
        "サプリメントを数種類飲んでいるが、商品名は覚えていない。"
      ],
      O: [
        "BP 116/72、P 72整。眼球結膜黄染なし。腹部平坦・軟。",
        "8/2の採血ではAST/ALT軽度高値、γ-GTP高値。結果は本日説明。",
        "本人希望で本日も肝機能の再検目的に採血し、同月内の前回検査とは再検理由を分けて記録した。",
        "腹部エコーは本日行わず、改善不良時に検討。",
        "採血は本日実施したが、前回と同じ項目が含まれる可能性がある。"
      ],
      A: [
        "脂肪肝または飲酒関連の肝機能異常を疑う。",
        "同月内の前回検査と今回再検の目的を区別して記録する必要あり。"
      ],
      P: [
        "飲酒量を半分以下に減らし、体重と食事内容を記録するよう指導。",
        "前回採血と本日採血の項目重複を診療録上で整理する。",
        "家族歴は参考情報であり、本人の検査結果と画像の必要性を分けて判断する。",
        "同月内の前回結果と今回の再検理由を並べて本人に説明する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肝機能異常"],
      requiredBillingSignals: ["肝機能検査"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["腹部エコー"]
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
    caseId: "V2-IM-LAB-078",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.normal_negative_result.v2",
    title: "内科 浮腫評価 尿定性+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 58, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-07" },
    realismAxes: ["normal_negative_result", "lab_raw_values", "home_record", "negative_findings"],
    distractors: [
      { type: "home_record", name: "家庭血圧", note: "患者記録" },
      { type: "external_result", name: "健診で腎機能", note: "外部健診結果" },
      { type: "negated_exam", name: "心電図", note: "本日は実施なし" }
    ],
    soap: {
      S: [
        "夕方の足のむくみで再診。朝は軽く、仕事後に靴下跡が目立つ。",
        "家庭血圧は130台/80台が多い。息切れなし、胸痛なし。",
        "健診で腎機能は境界と言われたが、結果票は持参していない。",
        "塩分の多い外食が続いている。尿量低下の自覚なし。",
        "夕方だけ靴がきつくなるが、朝には戻ることが多い。"
      ],
      O: [
        "BP 134/82、P 76整。下腿に軽度圧痕性浮腫。",
        "呼吸音清。頸静脈怒張なし。腹部膨満なし。",
        "院内で尿定性・尿蛋白を実施。尿蛋白(±)、尿糖(-)、潜血(-)、白血球反応(-)。",
        "同日に静脈採血を施行し、腎機能と電解質を外注へ提出。",
        "不整脈症状なく、心電図は本日行っていない。",
        "採血は座位で問題なく実施でき、検体は外注へ提出した。"
      ],
      A: [
        "軽度下腿浮腫。腎機能・塩分摂取・静脈うっ滞の影響を確認する。",
        "尿検査は陰性項目を含め本日実施した結果。"
      ],
      P: [
        "塩分制限と体重測定を指導。急な息切れや体重増加があれば受診。",
        "採血結果は異常があれば連絡。健診結果票は次回持参してもらう。",
        "家庭血圧は参考情報として継続記録してもらう。",
        "健診の腎機能値は持参されていないため、今回の自院採血結果とは分けて扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["下腿浮腫"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["心電図", "健診クレアチニン"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-07", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-079",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.quantity_missing.v3",
    title: "内科 体重減少 CT実施 造影・保存確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 64, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-08" },
    realismAxes: ["imaging_performed", "contrast_unknown", "weight_loss_context", "planned_exam"],
    distractors: [
      { type: "planned_exam", name: "上部内視鏡", note: "後日予定" },
      { type: "external_result", name: "腹部エコー", note: "外部検査" },
      { type: "quantity_missing_medication", name: "食欲不振への薬", note: "処方量未定" }
    ],
    soap: {
      S: [
        "3か月で体重が3kg減ったと再診。食欲低下が続く。",
        "健診の腹部エコーで脂肪肝と言われたが、画像は持参なし。",
        "腹痛は強くないが、食後にもたれる。黒色便なし。",
        "本人は悪性疾患を心配しており、詳しい検査を希望。",
        "市販の胃薬を数日飲んだが、食欲低下はあまり変わらなかった。"
      ],
      O: [
        "KT 36.5、BP 122/74、P 78整。",
        "腹部平坦・軟、圧痛なし。眼球結膜黄染なし。",
        "本日、腹部CTを施行。明らかな腫瘤性病変や腹水は認めず。",
        "造影有無は診察本文だけでは読み取れず、必要時は撮影記録を参照する。",
        "上部内視鏡は後日予約を検討。本日は行っていない。",
        "健診エコーは外部の過去情報であり、今回の画像実施とは別に記録した。"
      ],
      A: [
        "体重減少の精査中。CTで明らかな進行悪性腫瘍を示す所見なし。",
        "画像撮影条件の確認が必要。"
      ],
      P: [
        "食事量の記録を依頼。発熱、黒色便、体重減少進行があれば早めに受診。",
        "内視鏡検査は本人と相談し次回以降に予約調整。",
        "食欲不振への薬は希望を聞いたが、量と日数を決めていないため本日は処方しない。",
        "CTの条件は放射線部門の記録確認後に算定へ反映する方針。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["体重減少"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認"],
      forbiddenCandidates: ["上部内視鏡", "健診腹部エコー"]
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
    caseId: "V2-IM-LAB-080",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.past_value.v3",
    title: "内科 蜂窩織炎再診 血算+CRP",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 52, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-09" },
    realismAxes: ["lab_raw_values", "past_value", "skin_findings", "negated_imaging"],
    distractors: [
      { type: "past_lab_values", name: "前回", note: "過去値" },
      { type: "negated_exam", name: "下肢エコー", note: "本日は実施なし" },
      { type: "home_care", name: "自宅冷却", note: "患者対応" }
    ],
    soap: {
      S: [
        "左下腿蜂窩織炎で抗菌薬開始後の再診。",
        "「赤みは少し小さくなったが、歩くとまだ痛い」。発熱は昨夜からなし。",
        "自宅では冷却していた。内服は飲み忘れなし。",
        "前回は炎症反応が高いと言われ、改善しているか気にしている。",
        "仕事復帰の目安を知りたいが、長時間歩くと下腿が張るという。"
      ],
      O: [
        "KT 36.7、BP 128/76、P 78整。",
        "左下腿前面の発赤は前回マーキングより縮小。圧痛軽度、膿瘍形成なし。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 8200、CRP 1.8。",
        "前回はWBC 12400、CRP 6.1で、改善傾向。",
        "深部静脈血栓症を疑う腫脹差はなく、下肢エコーは本日行っていない。",
        "採血は本日の炎症評価として実施し、前回値とは別に記録した。"
      ],
      A: [
        "蜂窩織炎は改善傾向。膿瘍形成やDVTを示唆する所見なし。",
        "炎症反応の低下を確認。"
      ],
      P: [
        "抗菌薬は飲み切り。発熱再燃、発赤拡大、強い疼痛があれば受診。",
        "患部挙上と清潔保持を説明。冷却は痛みが強い時のみ短時間とする。",
        "採血結果を説明し、前回値と本日値を分けて記録した。",
        "自宅冷却は皮膚障害が出ない範囲で短時間にするよう伝えた。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["蜂窩織炎"],
      requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["下肢エコー"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-09", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-081",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.external_result.v4",
    title: "内科 めまい 頭部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 69, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-10" },
    realismAxes: ["imaging_performed", "equipment_unknown", "external_result", "neurologic_negative"],
    distractors: [
      { type: "external_result", name: "耳鼻科", note: "他院過去情報" },
      { type: "planned_exam", name: "MRI", note: "後日検討" },
      { type: "home_record", name: "血圧手帳", note: "患者記録" }
    ],
    soap: {
      S: [
        "今朝からふらつきがあり初診。回転性というより足元が不安定な感じ。",
        "数年前に耳鼻科で良性発作性頭位めまいと言われたことがある。",
        "血圧手帳では朝の血圧が150台の日がある。頭痛は軽い。",
        "麻痺、ろれつ困難、視野欠損の自覚なし。",
        "耳鼻科受診時の詳しい検査名は覚えておらず、記録も持参していない。"
      ],
      O: [
        "BP 154/86、P 76整。意識清明。",
        "眼振は明らかでない。四肢麻痺なし、構音障害なし。歩行はやや不安定。",
        "本日、頭部CTを施行。明らかな出血や占拠性病変なし。",
        "撮影装置の詳細は診察本文には記載されておらず、必要時は検査記録を参照する。",
        "MRIは症状が続く場合に紹介先で検討。本日は実施なし。",
        "頭部CTの結果は本人に説明し、過去の耳鼻科検査とは別の評価として扱った。"
      ],
      A: [
        "めまい。中枢性病変はCT上明らかでないが、症状経過を確認する。",
        "CTの撮影条件は検査記録で整理する。"
      ],
      P: [
        "ふらつきが強い間は運転を避けるよう説明。",
        "麻痺、ろれつ困難、強い頭痛、嘔吐があれば救急受診。",
        "耳鼻科での過去診断は参考情報として扱い、本日のCTとは分けて記録した。",
        "撮影装置の詳細は検査記録を参照する。",
        "血圧手帳は参考にするが、本日の画像検査とは分けて扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["めまい"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["耳鼻科めまい検査", "MRI紹介"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-10", is_outpatient: true, ...ENCOUNTER_BASE },
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
