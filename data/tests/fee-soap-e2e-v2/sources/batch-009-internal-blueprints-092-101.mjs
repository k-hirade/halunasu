// v2 batch-009: blueprint V2BP-0092〜0101 を手書きSOAPへ落とす第5追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-092",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.dysuria_followup.v1",
    title: "内科 膀胱炎疑い再診 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 42, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-21" },
    realismAxes: ["negative_findings", "past_antibiotic", "no_blood_collection", "planned_culture"],
    distractors: [
      { type: "past_medication", name: "前回抗菌薬", note: "既処方薬" },
      { type: "planned_exam", name: "尿培養", note: "症状遷延時の予定" },
      { type: "negated_exam", name: "静脈採血", note: "本日は採血しない" }
    ],
    soap: {
      S: [
        "排尿時痛で前回受診し、短期抗菌薬内服後の再診。",
        "「痛みはかなり減ったが、まだ少し残る」。発熱なし、腰背部痛なし。",
        "前回抗菌薬は飲み切った。下痢や発疹はなかった。",
        "血尿の自覚なし。水分は意識して取っている。",
        "本人は尿培養が必要か気にしている。",
        "仕事中にトイレを我慢することが多く、再発を心配している。"
      ],
      O: [
        "KT 36.5、BP 108/66、P 72整。",
        "下腹部圧痛は軽度。CVA叩打痛なし。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(-)、潜血(-)、白血球反応(±)、亜硝酸塩(-)。",
        "本日は静脈採血を行っていない。尿培養は症状が続く場合に検討。",
        "全身状態は良好で、脱水所見なし。",
        "抗菌薬の副作用を疑う皮疹や腹部症状は診察時に認めない。"
      ],
      A: [
        "膀胱炎疑いは改善傾向。腎盂腎炎を示す所見は乏しい。",
        "尿検査は本日の症状確認として実施。"
      ],
      P: [
        "水分摂取を継続し、排尿痛増悪や発熱があれば早めに受診。",
        "本日は採血や尿培養は行わず、症状が続く場合に改めて検討する。",
        "前回抗菌薬は既に終了しており、今回処方とは分けて扱う。",
        "尿検査結果を説明し、経過観察とした。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["膀胱炎疑い"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ", "尿培養"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-21", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-093",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.point_of_care.v1",
    title: "内科 下痢後倦怠感 院内簡易検査コード確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 31, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-22" },
    realismAxes: ["ambiguous_test_name", "gastroenteritis_context", "external_result", "planned_lab"],
    distractors: [
      { type: "external_result", name: "職場検便", note: "外部検査" },
      { type: "planned_exam", name: "通常採血", note: "予定のみ" },
      { type: "diet_context", name: "生もの", note: "生活背景" }
    ],
    soap: {
      S: [
        "下痢後の倦怠感で再診。下痢は昨日から減っている。",
        "数日前に生ものを食べた後から腹部不快感があった。",
        "職場で検便を出すよう言われたが、まだ提出していない。",
        "発熱はなく、血便なし。水分は取れている。",
        "本人は脱水や感染が残っていないか心配している。",
        "家族内に同様の症状はなく、食事内容を思い出しながら相談している。"
      ],
      O: [
        "KT 36.8、BP 114/70、P 78整。",
        "腹部平坦・軟、圧痛軽度、反跳痛なし。",
        "院内で脱水や炎症の目安を見る簡易検査を実施したが、検査名と標準コードを確定できる記録が不足している。",
        "結果は軽度異常なしとして説明。職場検便は未提出で外部検査扱い。",
        "症状が続く場合は通常採血を次回検討する。",
        "本日の検査は問診上の職場検査とは別に院内で行ったもの。"
      ],
      A: [
        "急性胃腸炎後の回復期を疑う。脱水は目立たない。",
        "本日の簡易検査はコード確認が必要。"
      ],
      P: [
        "経口補水と消化のよい食事を指導。",
        "発熱、血便、腹痛増悪があれば受診。",
        "院内検査の名称を確認し、標準コード候補を確認する。",
        "職場検便は提出された場合も自院実施分とは分けて扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性胃腸炎疑い"],
      requiredBillingSignals: ["簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["職場検便", "通常採血"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-22", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-NEG-094",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.checkup_result.v1",
    title: "内科 健診脂質異常相談 当日検査なし",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 50, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-23" },
    realismAxes: ["external_result", "negated_action", "lifestyle_counseling", "planned_order"],
    distractors: [
      { type: "external_result", name: "健診", note: "外部健診結果" },
      { type: "planned_exam", name: "採血", note: "次回予定" },
      { type: "lifestyle_context", name: "夜食", note: "生活背景" }
    ],
    soap: {
      S: [
        "健診でLDL高値を指摘され初診。結果票を持参。",
        "夜食と外食が多く、運動はほとんどしていない。",
        "胸痛なし、息切れなし。家族歴として父に心筋梗塞あり。",
        "本人は薬をすぐ始めるべきか相談したい。",
        "健診採血は先月の会社健診で実施されたもの。",
        "食事内容を振り返ると、夕食後に菓子を食べる日が多いという。"
      ],
      O: [
        "BP 128/76、P 72整。BMI 27.2。",
        "健診結果票でLDL高値、TG軽度高値を確認。",
        "本日は採血を行っていない。心電図も本日は実施していない。",
        "持参結果は外部資料として確認し、当日自院実施の検査ではない。",
        "診察上、急性冠症候群を疑う所見なし。",
        "本人には、今日の相談は健診結果の確認と生活指導が中心であると説明した。"
      ],
      A: [
        "脂質異常症。まず生活習慣改善を開始し、再検時期を検討する。",
        "今回の記録では当日実施した検体検査はない。"
      ],
      P: [
        "食事内容、夜食、飲酒量を見直すよう説明。",
        "1〜2か月後に必要なら当院で採血を行う。",
        "本日は外部健診結果の確認のみで、自院検査は実施していない。",
        "胸痛や息切れが出た場合は早めに受診するよう説明。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["脂質異常症"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["検査実施料", "健診LDL", "心電図"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-23", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SURG-095",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.abscess_consult.v1",
    title: "内科 臀部膿瘍疑い 切開排膿相談",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 37, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-24" },
    realismAxes: ["surgery_context", "abscess_context", "negated_action", "referral_context"],
    distractors: [
      { type: "surgery_context", name: "切開排膿", note: "手術相談" },
      { type: "negated_treatment", name: "穿刺", note: "本日は実施なし" },
      { type: "referral_context", name: "外科紹介", note: "紹介検討" }
    ],
    soap: {
      S: [
        "臀部の腫れと痛みで初診。座ると痛い。",
        "数日前から赤く腫れてきたが、自然に膿は出ていない。",
        "発熱はない。糖尿病の既往なし。",
        "本人は切開して膿を出す必要があるか相談したいと希望。",
        "仕事で長時間座るため、早く痛みを取りたいと話す。",
        "市販の軟膏は使っておらず、自分で針を刺すような処置もしていない。"
      ],
      O: [
        "右臀部に2cm程度の発赤と硬結。中央に明らかな波動は触れない。",
        "排膿なし。周囲の発赤拡大は軽度。",
        "本日は切開、穿刺、排膿処置は行っていない。",
        "全身状態は良好で、緊急切開が必要な所見は乏しい。",
        "画像検査や採血は本日行っていない。",
        "座位で痛みはあるが歩行は可能で、広範囲の蜂窩織炎を示す所見はない。"
      ],
      A: [
        "臀部膿瘍または毛包炎を疑う。切開排膿の要否は経過で判断。",
        "手術・処置領域の判断が含まれるため、自動算定せず確認が必要。"
      ],
      P: [
        "発赤拡大、発熱、強い痛み、排膿があれば早めに受診。",
        "悪化時は外科紹介を検討する。",
        "本日は切開や穿刺を実施していないことを説明。",
        "必要時は手技内容、麻酔の有無、処置範囲を確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["臀部膿瘍疑い"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["切開排膿", "穿刺"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-24", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SPLIT-096",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.diabetes_infection.v1",
    title: "内科 糖尿病足感染 入院2日分混在",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 70, sex: "male" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-08-25" },
    realismAxes: ["multi_day", "inpatient_context", "diabetes_context", "wound_context"],
    distractors: [
      { type: "previous_day_lab", name: "8/24採血", note: "別日検査" },
      { type: "previous_day_procedure", name: "創洗浄", note: "別日処置" },
      { type: "home_medication", name: "持参インスリン", note: "持参薬" }
    ],
    soap: {
      S: [
        "8/24に右足趾の発赤と疼痛で入院。8/25朝は痛みが少し軽い。",
        "糖尿病で持参インスリンがあるが、入院時に内容確認中。",
        "8/24夜は家族へ感染の説明を行い、8/25朝は創部の状態を本人へ説明。",
        "本人は前日と本日の処置内容を混同している。",
        "発熱は夜間に一度あったが、朝は解熱傾向。食事は半量摂取。",
        "入院前の処置と本日の観察を家族が混同して質問している。"
      ],
      O: [
        "8/24入院時: 採血で炎症反応高値、右第2趾周囲に発赤。創洗浄を実施。",
        "8/25本日: KT 37.2、BP 132/78、P 84整。発赤範囲はマーキング内。",
        "右第2趾の滲出は少量。末梢冷感なし。",
        "8/24の創洗浄記録と8/25の創部観察が同じSOAP内に混在している。",
        "持参インスリンは薬剤部で確認中で、当院指示とは分けて整理している。",
        "8/24夜の家族説明と8/25朝の本人説明も同じ記録内に続けて記載されている。"
      ],
      A: [
        "糖尿病足感染で入院加療中。炎症は軽度改善傾向。",
        "8/24の入院時検査・処置と8/25の回診評価を日付で分ける必要がある。"
      ],
      P: [
        "8/25分として抗菌薬継続、血糖管理、創部観察を行う。",
        "持参インスリンの内容確認後、当院指示へ置き換える。",
        "8/24の採血・創洗浄と本日の観察・説明は分割確認する。",
        "明日以降の採血と処置要否は経過で判断する。",
        "複数日の検査・処置・投薬が混在するため、このSOAP単独で一括算定しない。",
        "日付ごとの実施記録に戻してから、検査・処置・薬剤の算定対象を整理する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["糖尿病足感染"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["8/24採血", "創洗浄", "持参インスリン"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-25", is_outpatient: false, ...ENCOUNTER_BASE }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: []
  },
  {
    caseId: "V2-IM-LAB-097",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.diabetes_followup.v1",
    title: "内科 糖尿病フォロー 同月内再検確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 60, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-26" },
    realismAxes: ["same_month_history", "past_value", "lifestyle_context", "planned_exam"],
    distractors: [
      { type: "same_month_history", name: "8/10採血", note: "同月内検査" },
      { type: "lifestyle_context", name: "間食", note: "生活背景" },
      { type: "planned_exam", name: "眼底検査", note: "次回予定" }
    ],
    soap: {
      S: [
        "2型糖尿病で再診。8/10にHbA1cと血糖を確認済み。",
        "間食が増え、本人は数値悪化を心配して本日再検を希望。",
        "低血糖症状なし。口渇・多尿なし。",
        "眼底検査は次回眼科で予約予定。",
        "内服は飲み忘れなく継続している。",
        "本人は旅行前に数値を確認したいと話すが、前回検査から日が浅い。"
      ],
      O: [
        "BP 126/74、P 72整。体重は前回比+0.5kg。",
        "8/10採血ではHbA1c 7.4%、空腹時血糖150台。",
        "本人希望があり、本日も血糖コントロール確認目的で採血した。",
        "同月内に類似検査があり、前回採血と今回採血の目的を分けて記録した。",
        "眼底検査は本日実施していない。",
        "低血糖を示す冷汗やふらつきは診察時に認めない。"
      ],
      A: [
        "2型糖尿病。生活習慣の乱れにより数値悪化を本人が懸念。",
        "同月内の前回検査と今回再検の目的を区別して記録する必要あり。"
      ],
      P: [
        "間食を減らし、食事記録をつけるよう説明。",
        "前回採血と本日採血の項目が重なるため、今回の再検理由を診療録に残す。",
        "眼底検査は予定であり、本日の自院実施検査ではない。",
        "検査結果は次回の治療方針相談に用いる。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["2型糖尿病"],
      requiredBillingSignals: ["血糖管理検査"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["眼底検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-26", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-098",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.diabetes_edema.v1",
    title: "内科 糖尿病腎症疑い 尿+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 66, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-27" },
    realismAxes: ["lab_raw_values", "diabetes_context", "normal_negative_result", "home_record"],
    distractors: [
      { type: "home_record", name: "血糖手帳", note: "患者記録" },
      { type: "planned_exam", name: "腎エコー", note: "本日は実施なし" },
      { type: "external_result", name: "健診尿酸値", note: "外部健診結果" }
    ],
    soap: {
      S: [
        "2型糖尿病で通院中。最近、朝に軽い足のむくみがある。",
        "血糖手帳では食後高値が時々ある。低血糖症状なし。",
        "健診で尿酸値が高めと言われたが、結果票は持参していない。",
        "尿量低下なし、息切れなし。",
        "本人は腎臓への影響を気にしている。",
        "最近は夕食後の間食が増え、塩分の多い惣菜も多いという。"
      ],
      O: [
        "BP 132/80、P 74整。下腿浮腫は軽度。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(±)、尿糖(+)、潜血(-)、白血球反応(-)。",
        "同日に静脈採血を行い、腎機能と電解質の検体を提出。",
        "腎エコーは本日行っていない。健診尿酸値は外部情報として扱った。",
        "採血は本日の腎機能評価として実施し、問題なく検体提出した。",
        "採尿は院内で行い、尿検査結果は本人にその場で説明した。"
      ],
      A: [
        "糖尿病腎症の初期変化を含めて評価。軽度浮腫あり。",
        "尿検査と採血は本日実施。"
      ],
      P: [
        "血糖管理と塩分制限を説明。血糖手帳を継続。",
        "採血結果は次回説明し、必要なら薬剤調整を検討。",
        "腎エコーは検査結果次第で後日検討する。",
        "健診結果は持参された場合に参考情報として扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["糖尿病腎症疑い"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["腎エコー", "健診尿酸値"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-27", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-099",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.fever_abdominal.v1",
    title: "内科 発熱腹痛 CT実施 造影・保存確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 59, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-28" },
    realismAxes: ["imaging_performed", "contrast_unknown", "fever_context", "planned_exam"],
    distractors: [
      { type: "planned_exam", name: "胆道精査", note: "後日検討" },
      { type: "external_result", name: "健診肝機能", note: "外部結果" },
      { type: "medication_context", name: "解熱薬", note: "処方未確定" }
    ],
    soap: {
      S: [
        "発熱と右季肋部痛で再診。昨夜38度台だった。",
        "健診で肝機能が高めと言われたが、結果票は持参なし。",
        "吐き気は軽度、黄疸の自覚なし。食欲は低下。",
        "本人は胆のう炎ではないか心配している。",
        "解熱薬は自宅にあるものを使うか相談したい。",
        "食事量は半分程度で、水分は少しずつ取れている。"
      ],
      O: [
        "KT 37.8、BP 118/72、P 88整。",
        "右季肋部に圧痛あり、反跳痛なし。眼球結膜黄染なし。",
        "本日、腹部CTを実施。明らかな胆嚢腫大や腹水は認めない。",
        "造影有無は診察本文だけでは読み取れず、必要時は撮影記録を参照する。",
        "胆道精査や腹部エコーは後日検討。本日は行っていない。",
        "健診肝機能は外部情報として問診に記録した。",
        "腹膜刺激症状はなく、外来で経過を見られる状態と判断した。"
      ],
      A: [
        "発熱と右季肋部痛。CT上、明らかな急性腹症所見は乏しい。",
        "画像撮影条件の確認が必要。"
      ],
      P: [
        "発熱持続、腹痛増悪、黄疸があれば早めに受診。",
        "解熱薬は用量を確認して必要時のみ使用するよう説明。",
        "胆道精査は症状経過で検討する。",
        "CTの撮影条件は検査記録を確認して算定へ反映する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["右季肋部痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認"],
      forbiddenCandidates: ["胆道精査", "健診肝機能"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-28", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-100",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.diverticulitis_followup.v1",
    title: "内科 憩室炎疑い再診 血算+CRP",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 56, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-29" },
    realismAxes: ["lab_raw_values", "past_value", "abdominal_findings", "planned_imaging"],
    distractors: [
      { type: "past_lab_values", name: "前回", note: "過去値" },
      { type: "planned_exam", name: "腹部CT", note: "本日は実施なし" },
      { type: "diet_context", name: "食物繊維", note: "生活指導" }
    ],
    soap: {
      S: [
        "左下腹部痛で前回受診し、憩室炎疑いとして経過観察中の再診。",
        "「痛みは半分くらいになった」。発熱はない。",
        "便通はやや硬め。食事量は戻ってきた。",
        "前回は炎症反応が高いと言われており、改善しているか気にしている。",
        "腹部CTは必要なら受けたいが、本日は症状が軽くなっている。",
        "仕事復帰を希望しており、再燃時の受診目安を確認したい。"
      ],
      O: [
        "KT 36.7、BP 122/74、P 76整。",
        "左下腹部圧痛は軽度、反跳痛なし。腸蠕動音正常。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 7600、CRP 1.2。",
        "前回はWBC 11800、CRP 4.8で、改善傾向。",
        "腹部CTは症状改善のため本日は行っていない。",
        "採血は当日の炎症評価として実施した。",
        "脱水所見はなく、腹部所見も前回より軽くなっている。"
      ],
      A: [
        "憩室炎疑いは改善傾向。急性腹症を示す所見なし。",
        "炎症反応は低下。"
      ],
      P: [
        "食物繊維と水分摂取を徐々に増やすよう説明。",
        "発熱、腹痛増悪、血便があれば早期受診。",
        "採血結果を説明し、前回値と本日値を分けて記録した。",
        "画像検査は症状再燃時に改めて検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["憩室炎疑い"],
      requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["腹部CT"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-29", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-101",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.transient_neuro.v1",
    title: "内科 一過性しびれ 頭部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 73, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-30" },
    realismAxes: ["imaging_performed", "equipment_unknown", "neurologic_transient", "external_history"],
    distractors: [
      { type: "external_history", name: "頸椎症", note: "過去診断" },
      { type: "planned_exam", name: "MRI", note: "後日検討" },
      { type: "home_record", name: "血圧手帳", note: "患者記録" }
    ],
    soap: {
      S: [
        "今朝、右手のしびれが数分あり初診。来院時にはほぼ消失。",
        "数年前に頸椎症と言われたことがあるが、今回は急に出たため心配。",
        "血圧手帳では朝の血圧が160台の日がある。",
        "ろれつ困難、顔面麻痺、歩行障害の自覚なし。",
        "家族が脳梗塞を心配して受診を勧めた。"
      ],
      O: [
        "BP 158/88、P 76整。意識清明。",
        "四肢麻痺なし、構音障害なし、顔面麻痺なし。右手の感覚低下は診察時明らかでない。",
        "本日、頭部CTを施行。明らかな出血や占拠性病変なし。",
        "撮影装置の詳細は診察本文には記載されておらず、必要時は検査記録を参照する。",
        "MRIは症状再燃時や神経内科紹介時に検討。本日は実施していない。",
        "頸椎症の既往は問診上の参考情報として扱った。"
      ],
      A: [
        "一過性右手しびれ。CTで急性出血を示す所見なし。",
        "頭部CTの撮影条件は検査記録で整理する。"
      ],
      P: [
        "しびれ再燃、麻痺、ろれつ困難があれば救急受診。",
        "血圧管理を継続し、家庭血圧を記録するよう説明。",
        "MRIは症状経過に応じて紹介先で検討する。",
        "撮影装置の詳細は検査記録を参照する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["一過性しびれ"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["MRI", "頸椎症"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-30", is_outpatient: true, ...ENCOUNTER_BASE },
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
