// v2 batch-008: blueprint V2BP-0082〜0091 を手書きSOAPへ落とす第4追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-082",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.exercise_context.v1",
    title: "内科 運動後褐色尿疑い 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 34, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-11" },
    realismAxes: ["exercise_context", "past_value", "negative_findings", "no_blood_collection"],
    distractors: [
      { type: "past_external_test", name: "会社健診", note: "外部健診結果" },
      { type: "planned_exam", name: "採血", note: "予定のみ" },
      { type: "sports_context", name: "長距離走", note: "生活背景" }
    ],
    soap: {
      S: [
        "前回、運動後に尿が濃く見えたことで受診し、本日再診。",
        "週末に長距離走をした翌朝だけ褐色っぽく見えたが、その後は戻った。",
        "腰背部痛なし、発熱なし、排尿痛なし。水分摂取は少なかったと話す。",
        "会社健診では尿異常を指摘されたことはないが、結果票は持参していない。",
        "筋肉痛はあるが歩行に支障なし。本人は腎臓の病気を心配している。"
      ],
      O: [
        "KT 36.3、BP 116/68、P 64整。",
        "腹部平坦・軟、CVA叩打痛なし。下腿浮腫なし。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(-)、潜血(-)、尿糖(-)、白血球反応(-)、尿比重やや高め。",
        "本日は静脈採血を行っていない。筋原性酵素などの採血は症状再燃時に検討。",
        "会社健診の結果は外部情報であり、本日の自院検査とは分けて扱う。"
      ],
      A: [
        "脱水傾向に伴う一過性濃縮尿を疑う。血尿や感染を示す所見は乏しい。",
        "尿検査は本日の症状確認として実施。"
      ],
      P: [
        "運動前後の水分摂取を増やすよう説明。",
        "褐色尿が持続する、筋痛が強い、尿量低下があれば早期受診。",
        "採血は本日行わず、症状再燃時に改めて検討する。",
        "外部健診結果は持参された時点で参考資料として確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["褐色尿疑い"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ", "次回採血"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-11", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-083",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.workplace_exposure.v1",
    title: "内科 職場曝露後の簡易検査 コード確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 44, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-12" },
    realismAxes: ["ambiguous_test_name", "workplace_exposure", "planned_exam", "external_result"],
    distractors: [
      { type: "workplace_exposure", name: "職場", note: "背景情報" },
      { type: "planned_exam", name: "通常採血", note: "予定のみ" },
      { type: "external_result", name: "職場検査", note: "外部結果" }
    ],
    soap: {
      S: [
        "職場で感染者対応があり、微熱とだるさで再診。",
        "職場の簡易検査では陰性だったと聞いているが、検査名や結果票は不明。",
        "咳は軽く、息苦しさはない。食欲は保たれている。",
        "本人は高齢の家族と同居しており、感染性の有無を早く知りたいと話す。",
        "市販薬は飲んでいない。"
      ],
      O: [
        "KT 37.2、BP 110/66、P 82整、SpO2 98%。",
        "咽頭発赤軽度。胸部聴診で明らかなラ音なし。",
        "院内で感染確認目的の簡易検査を実施したが、カルテ上は検査キット名と標準コードを確定できる名称が残っていない。",
        "結果は陰性相当として本人へ説明。職場検査の内容は外部情報として扱う。",
        "症状が続く場合は通常採血を次回検討する。"
      ],
      A: [
        "軽い急性上気道炎を疑う。重症化を示す所見は乏しい。",
        "当日実施した簡易検査はコード確認が必要。"
      ],
      P: [
        "発熱持続や息苦しさがあれば再診。家族内感染予防を説明。",
        "院内検査の名称と検査キットを確認し、標準コード候補を確認する。",
        "職場検査は今回の自院実施分ではないため、算定対象とは分けて記録する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性上気道炎疑い"],
      requiredBillingSignals: ["感染確認簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["職場検査", "通常採血"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-12", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-NEG-084",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.external_result.v1",
    title: "内科 動悸相談 採血・心電図見送り",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 55, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-13" },
    realismAxes: ["negated_action", "external_result", "home_record", "planned_order"],
    distractors: [
      { type: "home_record", name: "スマートウォッチ", note: "患者記録" },
      { type: "external_result", name: "健診心電図", note: "外部健診結果" },
      { type: "planned_exam", name: "採血", note: "予定のみ" }
    ],
    soap: {
      S: [
        "数分で治まる動悸について相談。前回から頻度は増えていない。",
        "スマートウォッチの記録では脈拍が一時的に100台になることがある。",
        "健診心電図では異常なしと言われたが、結果票は持参していない。",
        "胸痛、失神、息切れなし。カフェイン摂取が多い。",
        "本人は検査が必要か確認したいと話す。"
      ],
      O: [
        "BP 122/74、P 72整、SpO2 99%。診察中の脈は整。",
        "心音整、雑音なし。下腿浮腫なし。",
        "症状が軽く本日は採血を行っていない。心電図も本日は実施していない。",
        "スマートウォッチ記録は参考情報として確認したのみ。",
        "健診心電図は外部結果であり、本日の自院検査ではない。"
      ],
      A: [
        "一過性動悸。緊急性は低いが、頻度増加時は検査を検討する。",
        "今回の記録では当日実施した検査はない。"
      ],
      P: [
        "カフェイン摂取を控え、症状時の脈拍と持続時間を記録するよう説明。",
        "失神、胸痛、息切れ、動悸持続があれば早めに受診。",
        "症状が続く場合は次回、採血や心電図を改めて検討する。",
        "本日は検査を実施していないことを本人へ説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["動悸"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["検査実施料", "心電図", "採血"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-13", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SURG-085",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.procedure_consult.v1",
    title: "内科 皮下腫瘤 切除相談のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 63, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-14" },
    realismAxes: ["surgery_context", "subcutaneous_mass", "negated_action", "referral_context"],
    distractors: [
      { type: "surgery_context", name: "切除", note: "手術相談" },
      { type: "negated_treatment", name: "切開", note: "本日は実施なし" },
      { type: "referral_context", name: "形成外科", note: "紹介検討" }
    ],
    soap: {
      S: [
        "背部のしこりが大きくなってきた気がして初診。",
        "痛みはないが、椅子にもたれると違和感がある。",
        "以前から同じ部位に小さなしこりがあり、最近家族に指摘された。",
        "本人は「取るならどこで取ればよいか」を相談したいと希望。",
        "発熱なし、排膿なし、皮膚の赤みは自覚していない。",
        "衣服に擦れる時だけ気になり、仕事中は大きな支障はない。"
      ],
      O: [
        "背部正中やや右に2cm程度の柔らかい皮下腫瘤。圧痛なし、発赤なし。",
        "可動性あり、皮膚潰瘍なし。感染徴候なし。",
        "本日は切開、穿刺、摘出は行っていない。",
        "悪性を強く疑う所見は乏しいが、増大傾向については経過確認が必要。",
        "画像検査は本日行っていない。"
      ],
      A: [
        "粉瘤または脂肪腫を疑う皮下腫瘤。",
        "切除の要否は外科・形成外科での確認が必要。手術領域のため自動算定せず確認する。"
      ],
      P: [
        "増大、疼痛、発赤、排膿があれば早めに受診。",
        "切除希望が強ければ形成外科紹介を検討する。",
        "本日は手術手技を実施していないことを説明。",
        "紹介時は腫瘤部位、サイズ、感染の有無、切除範囲を確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["皮下腫瘤"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["皮膚切開", "腫瘤摘出", "穿刺"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-14", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SPLIT-086",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.medication_mix.v1",
    title: "内科 肺炎入院 2日分の検査治療混在",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 82, sex: "female" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-08-15" },
    realismAxes: ["multi_day", "inpatient_context", "antibiotic_context", "oxygen_context"],
    distractors: [
      { type: "previous_day_lab", name: "8/14採血", note: "別日検査" },
      { type: "previous_day_imaging", name: "胸部X線", note: "別日画像" },
      { type: "medication_mix", name: "抗菌薬", note: "日付混在" }
    ],
    soap: {
      S: [
        "8/14に発熱と咳で入院。8/15朝は「少し息が楽」と話す。",
        "8/14夜は痰が多く眠りにくかった。8/15朝は食事を半分摂取。",
        "入院前の抗菌薬内服歴は不明で、家族が薬袋を確認中。",
        "本人は日付ごとの検査内容を覚えておらず、説明が混ざっている。",
        "独居で、退院後の服薬管理にも不安がある。",
        "家族への病状説明は8/14夜と8/15朝の内容が続けて記録されている。"
      ],
      O: [
        "8/14入院時: 胸部X線で右下肺野に浸潤影、採血で炎症反応高値。酸素2L開始。",
        "8/15本日: KT 37.4、SpO2 95%(酸素1L)、呼吸数20/分。",
        "8/15朝は湿性咳嗽あり。右下肺野でcoarse cracklesを聴取。",
        "抗菌薬は8/14入院時の初回投与記録と、8/15の継続指示が同じSOAPに混在している。",
        "8/14の採血結果説明と8/15の回診評価が同じ記録内に並んでいる。"
      ],
      A: [
        "肺炎で入院加療中。呼吸状態は軽度改善。",
        "8/14の入院時検査・画像と8/15の治療評価を日付で分ける必要がある。"
      ],
      P: [
        "8/15分として酸素を1Lで継続し、呼吸状態に応じて調整する。",
        "抗菌薬は本日の指示と入院時投与を分けて確認する。",
        "入院時胸部X線と採血は8/14分、本日の回診内容は8/15分として記録を分割確認する。",
        "次回採血や画像は明日以降の経過で判断する。",
        "複数日の検査・投薬・説明が混在するため、このSOAP単独で一括算定しない。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肺炎"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["8/14採血", "胸部X線", "抗菌薬初回投与"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-15", is_outpatient: false, ...ENCOUNTER_BASE }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: []
  },
  {
    caseId: "V2-IM-LAB-087",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.renal_followup.v1",
    title: "内科 腎機能フォロー 同月内検査確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 67, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-16" },
    realismAxes: ["same_month_history", "past_value", "medication_context", "external_result"],
    distractors: [
      { type: "same_month_history", name: "8/5", note: "同月内検査" },
      { type: "medication_context", name: "NSAIDs", note: "薬剤背景" },
      { type: "planned_exam", name: "腎エコー", note: "予定のみ" }
    ],
    soap: {
      S: [
        "腎機能低下で再診。8/5に採血済みで、本日は再検希望。",
        "腰痛で市販NSAIDsを数日使っていたと話す。",
        "尿量低下の自覚なし、浮腫なし。食欲は保たれている。",
        "本人は腎機能が悪くなっていないか不安。",
        "健診結果は持参しておらず、前回当院結果だけで説明を受けている。"
      ],
      O: [
        "BP 132/78、P 72整。下腿浮腫なし。CVA叩打痛なし。",
        "8/5の採血ではCr軽度高値、eGFR軽度低下。結果を本日説明。",
        "本人希望があり、本日も腎機能再検目的で静脈採血を実施。",
        "同月内の前回採血と今回採血で項目が重複する可能性があり、確認が必要。",
        "腎エコーは本日行わず、腎機能悪化時に検討する。"
      ],
      A: [
        "軽度腎機能低下。脱水、NSAIDs使用、年齢の影響を考える。",
        "同月内の前回検査と今回再検の目的を区別して記録する必要あり。"
      ],
      P: [
        "NSAIDsの連用を避けるよう説明。水分摂取を維持する。",
        "前回採血と本日採血の項目が重なるため、今回の再検理由を診療録に残す。",
        "腎エコーは予定段階であり、本日実施分ではない。",
        "検査結果は異常があれば電話連絡し、必要時に腎臓内科紹介を検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["腎機能低下"],
      requiredBillingSignals: ["腎機能検査"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["腎エコー"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-16", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-088",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.hypertension.v1",
    title: "内科 高血圧内服中 浮腫評価 尿+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 61, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-17" },
    realismAxes: ["lab_raw_values", "hypertension_context", "normal_negative_result", "home_record"],
    distractors: [
      { type: "home_record", name: "家庭血圧", note: "患者記録" },
      { type: "planned_exam", name: "心電図", note: "本日は実施なし" },
      { type: "external_result", name: "薬局血圧", note: "外部測定" }
    ],
    soap: {
      S: [
        "高血圧で通院中。夕方の足のむくみが気になり再診。",
        "家庭血圧は130〜140台。薬局で測った時は150台だったと話す。",
        "息切れなし、胸痛なし。塩分の多い食事が続いた。",
        "尿量低下はない。体重は1か月で1kg増。",
        "内服は飲み忘れなく継続している。",
        "本人は薬の副作用でむくみが出ていないかも気にしている。"
      ],
      O: [
        "BP 138/82、P 74整。下腿に軽度圧痕性浮腫。",
        "呼吸音清、心雑音なし。腹部膨満なし。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(±)、尿糖(-)、潜血(-)、白血球反応(-)。",
        "同日に静脈採血を行い、腎機能と電解質を確認する検体を提出。",
        "心電図は症状がないため本日は行っていない。",
        "薬局血圧は参考情報であり、本日の検査とは分けて記録した。"
      ],
      A: [
        "軽度浮腫。高血圧治療中で腎機能・塩分摂取の影響を確認する。",
        "尿検査と採血は本日実施した。"
      ],
      P: [
        "塩分制限、体重測定、家庭血圧記録を継続。",
        "採血結果は異常があれば連絡する。",
        "息切れや急な体重増加があれば早めに受診。",
        "薬局血圧は参考値として扱い、当院測定と検査結果で評価する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["下腿浮腫", "高血圧症"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["心電図", "薬局血圧"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-17", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-089",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.abdominal_pain.v1",
    title: "内科 右下腹部痛 CT実施 造影・保存確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 46, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-18" },
    realismAxes: ["imaging_performed", "contrast_unknown", "abdominal_pain", "planned_exam"],
    distractors: [
      { type: "planned_exam", name: "大腸内視鏡", note: "後日検討" },
      { type: "external_result", name: "健診腹部エコー", note: "外部検査" },
      { type: "medication_context", name: "鎮痛薬", note: "処方未確定" }
    ],
    soap: {
      S: [
        "右下腹部痛が数日続き再診。食欲はやや低下。",
        "健診腹部エコーでは脂肪肝と言われたが、画像は持参していない。",
        "発熱はない。下痢なし、血便なし。",
        "本人は虫垂炎ではないか心配している。",
        "鎮痛薬を希望するが、痛みは我慢できる程度。",
        "昨夜は食事を控えたが、水分は取れている。"
      ],
      O: [
        "KT 36.8、BP 124/76、P 78整。",
        "右下腹部に軽度圧痛。反跳痛なし。腸蠕動音正常。",
        "本日、腹部CTを実施。明らかな虫垂腫大や腹水は認めない。",
        "造影有無は診察本文だけでは読み取れず、必要時は撮影記録を参照する。",
        "大腸内視鏡は症状が続く場合に後日検討。本日は行っていない。",
        "健診腹部エコーは外部の過去情報として扱った。"
      ],
      A: [
        "右下腹部痛。CT上、急性虫垂炎を強く示す所見は乏しい。",
        "画像撮影条件の確認が必要。"
      ],
      P: [
        "発熱、痛み増悪、嘔吐があれば早めに受診。",
        "食事は消化のよいものから再開。鎮痛薬は症状推移をみて必要時に検討。",
        "大腸内視鏡は症状持続時に予約を調整する。",
        "画像所見は放射線部門の読影記録と合わせて確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["右下腹部痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認"],
      forbiddenCandidates: ["大腸内視鏡", "健診腹部エコー"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-18", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-090",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.pneumonia_followup.v1",
    title: "内科 肺炎治療後 血算+CRP再診",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 47, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-19" },
    realismAxes: ["lab_raw_values", "past_value", "respiratory_context", "negated_imaging"],
    distractors: [
      { type: "past_lab_values", name: "前回", note: "過去値" },
      { type: "negated_exam", name: "胸部X線", note: "本日は実施なし" },
      { type: "home_care", name: "市販咳止め", note: "自己対応" }
    ],
    soap: {
      S: [
        "肺炎治療後の再診。咳は残るが発熱はない。",
        "「だいぶ楽になったが、まだ階段で少し息が切れる」。",
        "市販咳止めを一度使ったが、眠気があり中止した。",
        "前回は炎症反応が高いと言われており、改善しているか心配。",
        "抗菌薬は処方通り飲み切った。",
        "夜間の咳で睡眠が浅い日があり、仕事復帰時期を相談したい。"
      ],
      O: [
        "KT 36.6、BP 118/72、P 76整、SpO2 98%。",
        "右下肺野の湿性ラ音は前回より軽減。努力呼吸なし。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 6900、CRP 0.9。",
        "前回はWBC 11200、CRP 5.4で、改善傾向。",
        "胸部X線は症状改善のため本日は行っていない。",
        "採血は当日の肺炎経過評価として実施した。"
      ],
      A: [
        "肺炎は改善傾向。炎症反応も低下。",
        "咳は残るが重症化所見なし。"
      ],
      P: [
        "発熱再燃、息切れ増悪、血痰があれば早期受診。",
        "水分摂取と休養を指導。市販咳止めは眠気が強ければ使用しない。",
        "採血結果を説明し、前回値と本日値を分けて記録した。",
        "胸部画像は症状が再燃した場合に改めて検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肺炎"],
      requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["胸部X線"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-19", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-IMG-091",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.headache.v1",
    title: "内科 頭痛 頭部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 58, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-20" },
    realismAxes: ["imaging_performed", "equipment_unknown", "neurologic_negative", "external_history"],
    distractors: [
      { type: "external_history", name: "片頭痛", note: "過去診断" },
      { type: "planned_exam", name: "MRI", note: "後日検討" },
      { type: "home_medication", name: "市販鎮痛薬", note: "自己使用" }
    ],
    soap: {
      S: [
        "今朝から普段より強い頭痛があり初診。",
        "若い頃に片頭痛と言われたことがあるが、今回は痛み方が違うと話す。",
        "市販鎮痛薬を朝1回使ったが、十分には効いていない。",
        "嘔吐なし、けいれんなし。手足の脱力やしびれの自覚なし。",
        "本人は脳出血を心配している。",
        "家族に脳卒中既往があり、いつもの頭痛との違いを強く不安に感じている。"
      ],
      O: [
        "BP 148/84、P 78整。意識清明。",
        "瞳孔左右差なし。四肢麻痺なし、構音障害なし。項部硬直なし。",
        "本日、頭部CTを施行。明らかな出血や占拠性病変なし。",
        "撮影装置の詳細は診察本文には記載されておらず、必要時は検査記録を参照する。",
        "MRIは症状が続く場合に後日検討。本日は実施なし。",
        "過去の片頭痛診断は問診上の参考情報として扱った。"
      ],
      A: [
        "急性頭痛。CT上、明らかな頭蓋内出血を示す所見なし。",
        "頭部CTの撮影条件は検査記録で整理する。"
      ],
      P: [
        "強い頭痛の再燃、嘔吐、麻痺、意識障害があれば救急受診。",
        "本日は安静と水分摂取を指導し、症状経過を確認する。",
        "MRIは症状が続く場合に紹介先で検討する。",
        "撮影装置の詳細は検査記録を参照する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性頭痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["MRI", "市販鎮痛薬"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-20", is_outpatient: true, ...ENCOUNTER_BASE },
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
