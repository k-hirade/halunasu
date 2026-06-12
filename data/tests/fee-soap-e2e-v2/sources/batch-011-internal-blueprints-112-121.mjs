// v2 batch-011: blueprint V2BP-0112〜0121 を手書きSOAPへ落とす第7追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-112",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.flank_discomfort.v1",
    title: "内科 側腹部違和感再診 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 46, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-10" },
    realismAxes: ["negative_findings", "past_stone_history", "no_blood_collection", "planned_imaging"],
    distractors: [
      { type: "past_history", name: "尿路結石", note: "既往歴" },
      { type: "planned_exam", name: "腹部エコー", note: "症状遷延時の予定" },
      { type: "negated_exam", name: "静脈採血", note: "本日は採血しない" }
    ],
    soap: {
      S: [
        "左側腹部の違和感で前回相談し、本日再診。",
        "以前に尿路結石と言われたことがあり、似た症状ではないか心配。",
        "強い疝痛はなく、発熱なし。排尿痛なし、血尿の自覚なし。",
        "水分摂取は増やしている。痛み止めは使っていない。",
        "仕事中に座りっぱなしで違和感が強くなる日がある。"
      ],
      O: [
        "KT 36.4、BP 118/70、P 68整。",
        "腹部平坦・軟。CVA叩打痛は明らかでない。",
        "院内で尿一般と尿蛋白を実施。尿蛋白(-)、潜血(-)、尿糖(-)、白血球反応(-)。",
        "本日は静脈採血を行っていない。腹部エコーは症状が続く場合に検討。",
        "既往の尿路結石は問診上の参考情報として扱い、本日の検査とは分けて記録した。"
      ],
      A: [
        "側腹部違和感。尿路感染や血尿を示す所見は乏しい。",
        "尿検査は本日の症状確認として実施。"
      ],
      P: [
        "水分摂取を継続し、強い痛み、発熱、血尿があれば早めに受診。",
        "本日は採血や画像検査を行わず、経過で腹部エコーを検討する。",
        "姿勢や長時間座位で悪化する可能性も説明し、ストレッチを勧めた。",
        "尿検査結果を本人へ説明し、経過観察とした。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["側腹部違和感"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ", "腹部エコー"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-10", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-113",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.nausea_screen.v1",
    title: "内科 嘔気後の院内検査 コード確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 52, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-11" },
    realismAxes: ["ambiguous_test_name", "external_result", "planned_lab", "food_context"],
    distractors: [
      { type: "external_result", name: "薬局測定", note: "外部測定" },
      { type: "planned_exam", name: "通常採血", note: "予定のみ" },
      { type: "food_context", name: "外食", note: "生活背景" }
    ],
    soap: {
      S: [
        "数日前から嘔気があり再診。嘔吐は一度だけで、今日は落ち着いている。",
        "外食後から胃が重い感じが続いたと話す。",
        "薬局で血圧を測ったら高めだったが、記録紙は持参していない。",
        "発熱なし、下痢なし。水分摂取は可能。",
        "本人は脱水や炎症がないか簡単に確認したいと希望。"
      ],
      O: [
        "KT 36.6、BP 136/82、P 76整。",
        "腹部平坦・軟、心窩部圧痛軽度、反跳痛なし。",
        "院内で状態確認の簡易検査を実施したが、検査名と標準コードを確定できる記録が不足している。",
        "結果は大きな異常なしとして説明。薬局測定は外部情報として扱う。",
        "症状が続く場合は通常採血を後日検討する。",
        "食事内容や服薬状況も確認し、急性腹症を疑う所見は乏しいと判断した。"
      ],
      A: [
        "軽い胃腸炎または食事関連の胃部不快を疑う。",
        "本日の簡易検査はコード確認が必要。"
      ],
      P: [
        "消化のよい食事と水分摂取を指導。",
        "発熱、腹痛増悪、黒色便があれば受診。",
        "院内検査の名称と記録を確認し、標準コード候補を確認する。",
        "通常採血は本日実施していないため、予定として分けて扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["嘔気"],
      requiredBillingSignals: ["状態確認簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["薬局測定", "通常採血"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-11", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-NEG-114",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.home_glucose.v1",
    title: "内科 自己血糖高値相談 当日検査なし",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 61, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-12" },
    realismAxes: ["home_record", "negated_action", "diabetes_context", "planned_lab"],
    distractors: [
      { type: "home_record", name: "自己血糖", note: "患者記録" },
      { type: "planned_exam", name: "採血", note: "次回予定" },
      { type: "diet_context", name: "夜食", note: "生活背景" }
    ],
    soap: {
      S: [
        "自己血糖が高めで不安になり再診。朝食後に200台が数回あった。",
        "夜食が続いており、夕食後の間食も増えている。",
        "口渇・多尿は目立たない。低血糖症状なし。",
        "本人は今日採血した方がよいか相談したい。",
        "内服は飲み忘れなく継続している。"
      ],
      O: [
        "BP 126/72、P 72整。体重は前回比+0.4kg。",
        "自己血糖記録を確認。測定条件は食後時間が一定でない。",
        "本日は採血を行っていない。尿検査も本日は実施していない。",
        "自己測定値は患者記録であり、当日自院検査ではない。",
        "脱水所見なく、意識清明。急性代謝異常を示す所見は乏しい。",
        "持参したメモは生活指導の参考にし、院内検査結果とは分けて扱った。"
      ],
      A: [
        "2型糖尿病。自己血糖高値は食事内容と測定条件の影響を考える。",
        "今回の記録では当日実施した検査はない。"
      ],
      P: [
        "夜食を減らし、食後何時間の値か分かるよう記録する。",
        "必要時は次回、当院で採血を行いHbA1cや血糖を確認する。",
        "本日は自己血糖記録の確認と生活指導のみで、自院検査は実施していない。",
        "口渇、多尿、強い倦怠感があれば早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["2型糖尿病"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["検査実施料", "自己血糖", "尿検査"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-12", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SURG-115",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.subcutaneous_mass.v1",
    title: "内科 前腕皮下腫瘤 切除相談のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 39, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-09-13" },
    realismAxes: ["surgery_context", "skin_mass", "negated_procedure", "cosmetic_concern"],
    distractors: [
      { type: "surgery_context", name: "皮下腫瘤切除", note: "相談のみ" },
      { type: "negated_treatment", name: "局所麻酔", note: "本日は実施なし" },
      { type: "cosmetic_concern", name: "傷あと", note: "患者の心配" }
    ],
    soap: {
      S: [
        "左前腕の小さなしこりに気づき初診。半年ほど大きさはほぼ変わらない。",
        "痛みはないが、袖に当たると気になる。傷あとが残るかも心配している。",
        "発赤や熱感はない。発熱なし。",
        "本人は切除した方がよいか、今日処置できるのかを相談したい。",
        "家族に悪性腫瘍の既往があり、不安が強い。"
      ],
      O: [
        "左前腕伸側に約8mmの皮下結節を触知。可動性あり、圧痛なし。",
        "皮膚表面の発赤、びらん、排膿なし。",
        "本日は切開、摘出、縫合、局所麻酔を行っていない。",
        "ダーモスコピーや画像検査は本日実施していない。",
        "急速増大や感染を疑う所見は乏しい。",
        "本人は傷あとを気にしており、切除する場合の紹介先や時期について相談した。"
      ],
      A: [
        "良性皮下腫瘤疑い。切除の要否は経過、増大傾向、本人希望で判断。",
        "手術・処置領域の相談を含むため、自動算定せず確認が必要。"
      ],
      P: [
        "急速に大きくなる、痛む、赤くなる場合は早めに受診。",
        "切除希望が強ければ皮膚科または形成外科で相談する。",
        "本日は腫瘤切除や局所麻酔は実施せず、経過観察とした。",
        "傷あとや病理提出の可能性について概略を説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["皮下腫瘤疑い"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["皮下腫瘤切除", "局所麻酔"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-13", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-SPLIT-116",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.pyelonephritis.v1",
    title: "内科 腎盂腎炎入院 2日分混在",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 58, sex: "female" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-09-14" },
    realismAxes: ["multi_day_note", "inpatient_context", "antibiotic_course", "lab_trend"],
    distractors: [
      { type: "past_result", name: "前日CRP", note: "前日の推移" },
      { type: "medication", name: "セフトリアキソン", note: "入院中投与" },
      { type: "planned_exam", name: "尿培養再検", note: "翌日予定" }
    ],
    soap: {
      S: [
        "9/13夜に悪寒と発熱で入院。右腰背部痛が強かった。",
        "9/14朝は解熱傾向で、腰背部痛も少し軽くなった。",
        "食事は半量程度。嘔気は改善している。",
        "入院中の点滴抗菌薬について、あと何日必要か質問あり。",
        "家族には昨日の入院経過も一緒に説明した。",
        "排尿時痛は残るが、寒気は前夜より軽くなったと話す。"
      ],
      O: [
        "9/13入院時: KT 39.1、右CVA叩打痛あり、尿沈渣で白血球多数。採血で炎症反応高値。",
        "9/14本日: KT 37.4、BP 118/70、P 86。右CVA叩打痛は軽減。",
        "セフトリアキソン点滴を入院後から継続。尿培養は結果待ち。",
        "前日CRPと本日CRPの推移を同じ記録内で説明している。",
        "明日、尿培養結果と解熱状況をみて抗菌薬継続期間を再評価予定。",
        "尿培養再検は解熱不十分または症状再燃時に検討する。",
        "入院時からの尿量は保たれており、補液量は病棟記録で調整している。"
      ],
      A: [
        "急性腎盂腎炎。入院後の治療で改善傾向。",
        "同一SOAP内に9/13入院時情報と9/14当日情報が混在しており、日ごとの算定を分ける必要がある。"
      ],
      P: [
        "本日は点滴抗菌薬を継続し、飲水と尿量を確認する。",
        "尿培養結果を確認して抗菌薬を調整する。",
        "9/13入院時の検査・処置と9/14当日の管理内容は日付ごとに分けて記録する。",
        "退院時期は解熱と食事摂取、培養結果で判断する。",
        "前日分の検査値は経過比較に使い、本日新たに行った処置とは分けて説明する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性腎盂腎炎"],
      requiredBillingSignals: ["複数日記録"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["前日CRP", "尿培養再検"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-14", is_outpatient: false, ...ENCOUNTER_BASE }
    },
    expectedCalculation: {
      assertionLevel: "split_required",
      candidateCodes: [],
      engineStatus: "needs_review"
    },
    billingTargets: []
  },
  {
    caseId: "V2-IM-LAB-117",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month_duplicate.clinic_lab.anemia_followup.v1",
    title: "内科 貧血フォロー 同月内再検確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 43, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-15" },
    realismAxes: ["same_month_context", "lab_followup", "external_supplement", "menstrual_history"],
    distractors: [
      { type: "same_month_history", name: "同月上旬の採血", note: "同月内履歴" },
      { type: "supplement", name: "市販鉄剤", note: "自己購入" },
      { type: "symptom_history", name: "月経量", note: "問診情報" }
    ],
    soap: {
      S: [
        "貧血フォローで再診。同月上旬にも当院で採血を受けた。",
        "市販鉄剤を自己判断で数日飲んだが、胃もたれがあり中止。",
        "立ちくらみは少し改善。黒色便なし。",
        "月経量は多めだが、今回は普段と大きく変わらない。",
        "前回結果を踏まえて、今日も採血が必要か確認したい。",
        "同月上旬の採血で貧血を指摘され、改善しているか本人が気にしている。"
      ],
      O: [
        "BP 108/64、P 78整。眼瞼結膜軽度蒼白。",
        "本日、貧血の推移確認のため院内で採血を実施。",
        "前回同月内の採血結果も参照して説明した。",
        "同月上旬の採血と本日の採血目的が重なるため、再検理由を診療録に残した。",
        "腹部圧痛なし、体重減少なし。緊急出血を疑う所見なし。"
      ],
      A: [
        "鉄欠乏性貧血疑い。改善傾向の確認目的。",
        "同月内に類似目的の検査歴があり、今回再検の必要性を診療録に残す。"
      ],
      P: [
        "検査結果を確認し、鉄剤再開の可否を検討する。",
        "黒色便、強い動悸、息切れがあれば早めに受診。",
        "同月内の検査履歴と今回採血の臨床目的を分けて整理する。",
        "市販鉄剤は自己購入薬として記録し、今回処方とは分ける。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["貧血疑い"],
      requiredBillingSignals: ["当日採血"],
      requiredReviewTopics: ["同月内検査確認", "採血料確認"],
      forbiddenCandidates: ["市販鉄剤"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-15", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-118",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine_blood.revisit.clinic_lab.hypertension_adjustment.v1",
    title: "内科 降圧薬調整前 尿+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 64, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-16" },
    realismAxes: ["urine_and_blood", "facility_standard", "medication_context", "negative_findings"],
    distractors: [
      { type: "medication", name: "降圧薬", note: "既存処方" },
      { type: "past_result", name: "前回eGFR", note: "過去値" },
      { type: "lifestyle", name: "減塩", note: "生活指導" }
    ],
    soap: {
      S: [
        "高血圧で再診。家庭血圧は朝がやや高めで、薬を増やすか相談したい。",
        "めまい、動悸、胸痛なし。むくみは自覚しない。",
        "前回eGFRが少し低めと言われ、腎機能も気にしている。",
        "減塩は意識しているが、外食が続く週があった。",
        "降圧薬は飲み忘れなく内服している。",
        "家庭血圧手帳を持参しており、朝の高値が続く週がある。"
      ],
      O: [
        "BP 148/86、P 72整。下腿浮腫なし。",
        "院内で尿一般、尿蛋白を実施。尿蛋白(±)、潜血(-)、尿糖(-)。",
        "同日に静脈採血を実施し、血液検体を提出した。",
        "前回eGFRは過去値として参照し、本日の検査結果とは区別して説明。",
        "尿検査と採血は同じ外来診療内で実施し、検体提出まで院内で行った。"
      ],
      A: [
        "高血圧。腎機能と尿所見を確認しながら薬剤調整を検討。",
        "尿検査と採血は本日自院で実施し、結果説明も行う。"
      ],
      P: [
        "本日の検査結果を確認し、降圧薬調整を検討する。",
        "減塩と家庭血圧記録を継続する。",
        "胸痛、息切れ、強いめまいがあれば早めに受診。",
        "過去値と当日検査を分けて本人に説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["高血圧"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "静脈採血", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["前回eGFR"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-16", is_outpatient: true, ...ENCOUNTER_BASE },
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
      { name: "検体検査管理加算（２）", points: 100 },
      { name: "Ｂ－Ｖ", points: 40 }
    ]
  },
  {
    caseId: "V2-IM-IMG-119",
    caseTypeKey: "review_required.internal_medicine.imaging.ct.review.contrast_and_storage.clinic_basic.weight_loss.v1",
    title: "内科 食欲低下 CT実施 造影・保存確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 70, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-17" },
    realismAxes: ["imaging_review", "contrast_unknown", "storage_unknown", "external_ultrasound"],
    distractors: [
      { type: "external_result", name: "腹部エコー", note: "他院実施" },
      { type: "planned_exam", name: "内視鏡", note: "後日予定" },
      { type: "symptom", name: "食欲低下", note: "主訴" }
    ],
    soap: {
      S: [
        "食欲低下と体重減少で再診。ここ2か月で3kg減った。",
        "腹痛は強くないが、食後に胃が重い。",
        "他院で腹部エコーを受けたと聞いているが、結果票は持参していない。",
        "造影剤アレルギー歴は本人の記憶ではない。",
        "内視鏡は後日予約を相談中。",
        "便通はやや不規則だが、黒色便や血便の自覚はない。"
      ],
      O: [
        "BP 122/70、P 76整。腹部平坦・軟、圧痛軽度。",
        "本日、腹部CTを院内で撮影した。撮影部位は腹部。",
        "造影の有無や撮影装置の詳細は診察本文だけでは読み取れず、必要時は画像部門の記録を参照する。",
        "他院腹部エコーは外部情報であり、本日の自院算定には含めない。",
        "内視鏡は本日実施していない。"
      ],
      A: [
        "体重減少と食欲低下。腹部疾患の精査目的でCTを実施。",
        "画像条件が未確定のため、算定前に確認が必要。"
      ],
      P: [
        "CT画像を確認し、必要に応じて消化器内科へ紹介。",
        "造影有無や撮影装置の詳細は画像部門の記録を参照して整理する。",
        "内視鏡は後日予定であり、本日は算定対象に含めない。",
        "発熱、腹痛増悪、食事摂取不能があれば早めに受診。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["体重減少", "食欲低下"],
      requiredBillingSignals: ["腹部CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認", "機器区分確認"],
      forbiddenCandidates: ["他院腹部エコー", "内視鏡"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-17", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-120",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc_crp.revisit.blood.clinic_basic.pharyngitis.v1",
    title: "内科 咽頭炎再診 血算+CRP",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 35, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-09-18" },
    realismAxes: ["lab_panel", "negative_rapid_test", "blood_collection", "otc_medication"],
    distractors: [
      { type: "otc_medication", name: "市販解熱薬", note: "自己使用" },
      { type: "negated_test", name: "インフル迅速", note: "本日は実施なし" },
      { type: "symptom", name: "咽頭痛", note: "主訴" }
    ],
    soap: {
      S: [
        "咽頭痛と微熱で再診。昨日より飲み込みにくい。",
        "市販解熱薬を一度飲んだ。眠気などの副作用はない。",
        "咳は少なく、息苦しさなし。周囲にインフルエンザの人はいない。",
        "水分は取れている。食事は柔らかいもの中心。",
        "本人は炎症の程度を確認したいと希望。",
        "仕事を休むべきか迷っており、結果を見て相談したいと話す。"
      ],
      O: [
        "KT 37.5、BP 118/72、P 82整、SpO2 98%。",
        "咽頭発赤あり、扁桃白苔なし。頸部リンパ節腫大は軽度。",
        "本日、院内で末梢血液一般検査とCRPを実施。同日に静脈採血を行い、血液検体を提出した。",
        "インフル迅速検査は本日は実施していない。",
        "胸部聴診でラ音なし。脱水所見なし。"
      ],
      A: [
        "急性咽頭炎。炎症反応確認目的で血算とCRPを実施。",
        "重症細菌感染を示す所見は乏しいが、検査結果を踏まえて説明。"
      ],
      P: [
        "水分摂取と休養を指導。必要時に解熱鎮痛薬を使用。",
        "悪寒戦慄、呼吸苦、嚥下困難が強くなる場合は早めに受診。",
        "検査結果を本人へ説明し、抗菌薬は現時点では見送る。",
        "市販薬の使用は問診情報として扱い、今回処方には含めない。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性咽頭炎"],
      requiredBillingSignals: ["末梢血液一般検査", "CRP", "静脈採血"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["インフル迅速", "市販解熱薬"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-18", is_outpatient: true, ...ENCOUNTER_BASE },
      procedure_codes: ["160008010", "160054710"],
      outpatient_basic: { fee_kind: "revisit" },
      lab_options: { collection_fee_inputs: ["blood_venous"] }
    },
    expectedCalculation: {
      assertionLevel: "exact",
      totalPoints: 421,
      candidateCodes: ["160008010", "160054710", "112007410", "160061810", "160062110", "160095710"],
      engineStatus: "completed"
    },
    billingTargets: [
      { name: "再診料", points: 75 },
      { name: "末梢血液一般検査", points: 21 },
      { name: "ＣＲＰ", points: 16 },
      { name: "血液学的検査判断料", points: 125 },
      { name: "免疫学的検査判断料", points: 144 },
      { name: "Ｂ－Ｖ", points: 40 }
    ]
  },
  {
    caseId: "V2-IM-IMG-121",
    caseTypeKey: "review_required.internal_medicine.imaging.ct.review.equipment_kind.clinic_basic.syncope.v1",
    title: "内科 失神後 頭部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 67, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-09-19" },
    realismAxes: ["imaging_review", "equipment_unknown", "normal_result", "external_ecg"],
    distractors: [
      { type: "external_result", name: "職場心電図", note: "外部記録" },
      { type: "normal_result", name: "頭部CT", note: "正常所見" },
      { type: "planned_exam", name: "循環器評価", note: "後日予定" }
    ],
    soap: {
      S: [
        "職場で一瞬意識が遠のき初診。転倒はしていない。",
        "数分で回復し、現在は頭痛や麻痺はない。",
        "職場の心電図で異常なしと言われたが、記録紙は持参していない。",
        "脱水気味だったかもしれないと話す。",
        "本人と家族は脳の異常がないか心配している。",
        "当日は朝食を抜いており、立ち上がった直後に気分不快があった。"
      ],
      O: [
        "BP 110/68、P 70整、SpO2 99%。意識清明。",
        "神経学的に明らかな麻痺なし、構音障害なし。",
        "本日、頭部CTを院内で撮影。明らかな出血や占拠性病変なし。",
        "撮影装置の詳細は診察本文には記載されておらず、必要時は画像部門の実施記録を参照する。",
        "職場心電図は外部情報であり、本日の自院検査ではない。"
      ],
      A: [
        "一過性意識消失。神経学的重篤所見は乏しいが、頭部CTで緊急病変を確認。",
        "CT撮影は本日実施。撮影条件は画像部門の記録で整理する。"
      ],
      P: [
        "水分摂取を指導し、再発時は救急受診。",
        "動悸や胸痛がある場合は循環器評価を検討する。",
        "撮影装置の詳細と画像記録を参照して、実施内容を整理する。",
        "職場心電図の結果は持参資料があれば次回確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["一過性意識消失"],
      requiredBillingSignals: ["頭部CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["職場心電図"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-09-19", is_outpatient: true, ...ENCOUNTER_BASE },
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
