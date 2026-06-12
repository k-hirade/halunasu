// v2 batch-005: blueprint V2BP-0052〜0061 を手書きSOAPへ落とす最初の追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-052",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.past_value.v1",
    title: "内科 膀胱炎再診 尿定性のみ(管理加算なし施設)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 46, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-01" },
    realismAxes: ["past_value", "negative_findings", "patient_words", "no_blood_collection"],
    distractors: [
      { type: "past_lab_values", name: "前回尿培養", note: "前回提出分の参照。本日の検査ではない" },
      { type: "planned_exam", name: "次回採血", note: "腎機能確認は次回予定。本日は採血なし" },
      { type: "otc_medication", name: "市販鎮痛薬", note: "自己判断で内服。今回処方ではない" }
    ],
    soap: {
      S: [
        "8/1再診。3日前からの排尿時痛で前回受診し、水分摂取と経過観察を指示していた。",
        "「痛みは少し楽だが、まだ残尿感がある」。発熱なし、腰背部痛なし。",
        "昨夜だけ市販の鎮痛薬を1回内服。吐き気や下痢なし。",
        "前回提出した尿培養の結果はまだ説明を受けていないと本人は話す。"
      ],
      O: [
        "KT 36.6、BP 112/70、P 72整。",
        "腹部平坦・軟。下腹部に軽度圧痛、CVA叩打痛なし。",
        "院内で尿定性・尿蛋白を実施。白血球反応(2+)、亜硝酸塩(+)、尿蛋白(±)、尿糖(-)、潜血(-)。",
        "本日は採血なし。腎機能確認は症状遷延時に次回検討とした。",
        "前回の尿培養は外注結果待ちで、まだ確定報告なし。"
      ],
      A: [
        "急性膀胱炎の再診。発熱や腰背部痛はなく腎盂腎炎を疑う所見は乏しい。",
        "前回培養結果は未着であり、本日の判断材料にはしない。"
      ],
      P: [
        "水分摂取を増やし、排尿を我慢しないよう再指導。",
        "症状増悪や発熱時は早めに受診。培養結果が戻り次第、必要に応じて電話で説明する。",
        "市販薬の連用は避けるよう説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["膀胱炎"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["Ｂ－Ｖ", "検体検査管理加算"]
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
    caseId: "V2-IM-LAB-053",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.external_result.v1",
    title: "内科 腹部症状 検査名はあるがコード確定不可",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 52, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-02" },
    realismAxes: ["external_result", "ambiguous_test_name", "numeric_result", "planned_exam"],
    distractors: [
      { type: "external_result", name: "健診便潜血", note: "健診結果。自院実施ではない" },
      { type: "planned_exam", name: "腹部エコー", note: "次回予約。今回実施なし" },
      { type: "past_lab_values", name: "前医CRP", note: "前医結果の参照" }
    ],
    soap: {
      S: [
        "2週間ほど軟便が続き、腹部の張りが気になる。血便は本人自覚なし。",
        "会社健診で便潜血が1回陽性だったと結果票を持参。健診は外部機関で実施。",
        "前医で先月CRPは低いと言われたが、数値は本人記憶あいまい。",
        "発熱なし、体重減少なし。食欲は保たれている。",
        "乳製品を摂ると腹部膨満が強くなる気がすると話すが、明らかな食物アレルギー歴はない。",
        "仕事は営業職で外食が多い。市販の整腸剤を数日使ったが、今回は処方希望なし。"
      ],
      O: [
        "KT 36.5、BP 124/78、P 70整。",
        "腹部平坦・軟、圧痛なし。腸蠕動音やや亢進。",
        "本日、便中炎症マーカー検査を院内で実施したが、検査キットの詳細名は記録上未確定。",
        "結果は弱陽性相当と判定された。便潜血の健診結果票は確認のみ。",
        "腹部エコーは本日行わず、症状が続く場合に次回予約とした。"
      ],
      A: [
        "過敏性腸症候群または軽度腸炎を疑う。健診便潜血陽性については外部検査結果として扱う。",
        "本日の便検査は標準コード確定に追加確認が必要。"
      ],
      P: [
        "食事内容と排便回数のメモを依頼。血便・発熱・強い腹痛があれば早期受診。",
        "検査キット名を確認し、必要なら内視鏡紹介を検討する。",
        "健診結果票はコピーして保存。外部結果と本日院内で行った検査を分けて確認する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["腸炎疑い"],
      requiredBillingSignals: ["便中炎症マーカー検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["健診便潜血", "腹部エコー"]
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
    caseId: "V2-IM-NEG-054",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.planned_order.v1",
    title: "内科 糖尿病相談 採血見送り安全ケース",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 61, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-03" },
    realismAxes: ["negated_action", "past_value", "home_record", "patient_words"],
    distractors: [
      { type: "past_lab_values", name: "HbA1c", note: "前回結果。本日測定なし" },
      { type: "home_record", name: "家庭血糖", note: "患者持参メモ。自院検査ではない" },
      { type: "planned_exam", name: "次回採血", note: "次回予定" }
    ],
    soap: {
      S: [
        "2型糖尿病で再診。本人は「最近外食が多く、数値が悪くなっていないか心配」と話す。",
        "低血糖症状なし。内服は飲み忘れなし。",
        "自宅で測った食後血糖メモを持参。150〜190台が多いとのこと。",
        "前回6月のHbA1cは7.1%だったと説明済み。",
        "今週は出張が続き、夕食が遅くなった。体重増加は自覚なし。",
        "のどの渇き、多飲、多尿はない。足のしびれも前回と変わらない。"
      ],
      O: [
        "BP 132/78、P 72整。体重 72.1kg、前回比 +0.4kg。",
        "足背動脈触知良好。明らかな浮腫なし。",
        "本日は患者の予定が合わず、HbA1cを含む採血は行わなかった。",
        "持参の家庭血糖メモのみ確認。次回午前中に採血予定とした。"
      ],
      A: [
        "糖尿病、自己血糖のばらつきあり。今回のカルテ内に当日検体検査の実施はない。",
        "食事内容の影響が大きい可能性。"
      ],
      P: [
        "外食時の主食量と甘い飲料を控えるよう指導。",
        "次回、HbA1c・腎機能・尿検査を予定。採血当日は朝食を軽めにするよう説明。",
        "家庭血糖メモは参考情報として扱い、次回検査結果と合わせて薬剤調整を検討する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["糖尿病"],
      requiredBillingSignals: ["採血見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["HbA1c", "Ｂ－Ｖ"]
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
    caseId: "V2-IM-SURG-055",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.negated_action.v1",
    title: "内科 皮下腫瘤 手術相談のみ(未対応レビュー)",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 68, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-04" },
    realismAxes: ["surgery_context", "planned_referral", "negated_action", "external_history"],
    distractors: [
      { type: "external_result", name: "前医エコー", note: "他院結果の参照" },
      { type: "planned_action", name: "外科紹介", note: "本日は手術実施なし" },
      { type: "negated_treatment", name: "切開排膿", note: "不要と判断" }
    ],
    soap: {
      S: [
        "左肩背部のしこりが数年前からあり、最近服に擦れると気になるため相談。",
        "2年前に前医でエコーを受け、脂肪腫らしいと言われた。記録は持参なし。",
        "痛み・発赤・発熱なし。本人は「切った方がよいか知りたい」と希望。",
        "抗凝固薬なし。糖尿病なし。",
        "同居家族からは大きくなったように見えると言われた。日常生活では着替え時に少し引っかかる。",
        "過去に粉瘤を切開した経験があり、今回も同じような処置が必要か不安がある。"
      ],
      O: [
        "左肩甲部外側に約3cmの柔らかい皮下腫瘤。可動性あり、圧痛なし。",
        "皮膚発赤なし、熱感なし。波動なし。リンパ節腫大なし。",
        "本日は切開、摘出、排膿のいずれも実施せず。感染徴候がないため緊急処置は不要と判断。",
        "写真を診療記録に保存し、サイズを計測。"
      ],
      A: [
        "脂肪腫疑い。良性を示唆する所見だが、増大傾向の確認と摘出適応は外科で相談が必要。",
        "本日は手術ではなく説明と紹介方針の決定。"
      ],
      P: [
        "希望が強いため外科へ紹介状を作成予定。摘出術の必要性、創部、費用、病理確認の流れを概略説明。",
        "急な発赤・疼痛・発熱があれば早めに受診。",
        "本日は皮膚切開や摘出は行っていないことを本人にも説明し、外科受診時に過去エコーの情報を持参するよう伝えた。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["脂肪腫疑い"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["皮膚切開", "摘出術"]
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
    caseId: "V2-IM-SPLIT-056",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.otc_or_home_med.v1",
    title: "内科 入院経過 2日分混在メモ(分割レビュー)",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 74, sex: "male" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-08-05" },
    realismAxes: ["multi_day", "inpatient_context", "past_value", "medication_change"],
    distractors: [
      { type: "previous_day_action", name: "8/4の胸部X線", note: "別日実施" },
      { type: "previous_day_lab", name: "8/4のCRP", note: "別日検査" },
      { type: "home_medication", name: "持参薬", note: "入院前からの内服" }
    ],
    soap: {
      S: [
        "肺炎で8/4入院。本人は本日「息苦しさは昨日より少し楽」と話す。",
        "8/4夜は咳込みで眠りが浅かった。8/5朝は食事を半量摂取。",
        "入院前からの降圧薬は持参している。",
        "家族からは、入院前日に自宅で38度台の発熱があり、市販の解熱薬を1回飲んだと聞いた。",
        "喀痰は黄色で量は少し減った。胸痛なし、血痰なし。"
      ],
      O: [
        "8/4: 入院時に胸部X線を施行し、右下肺野に浸潤影。採血ではWBC 13200、CRP 8.2。",
        "8/5本日: KT 37.4、SpO2 95%(鼻カニュラ1L)。呼吸音は右下肺でcoarse crackles残存。",
        "8/5朝の採血はまだ結果待ち。尿量は保たれている。",
        "8/4からセフトリアキソン点滴開始、8/5も継続予定。",
        "食事摂取量は朝食5割、昼食6割。水分摂取は看護記録上おおむね保たれている。",
        "持参薬は看護師が預かり、薬剤確認中。重複投与は行っていない。"
      ],
      A: [
        "市中肺炎で入院加療中。昨日と本日の記載が同一SOAP内に混在している。",
        "酸素需要は軽度改善。"
      ],
      P: [
        "8/5分の診療内容と8/4入院時検査を分けて会計確認する必要あり。",
        "抗菌薬継続、酸素はSpO2を見ながら漸減。解熱後に食上げを検討。",
        "持参薬は薬剤部確認後に継続可否を判断する。",
        "家族には、昨日の入院時検査と本日の回診・治療継続を分けて説明。退院時期は解熱と酸素離脱を見て判断する。",
        "記録上も日付を分けて整理する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肺炎"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["8/4胸部X線", "8/4採血"]
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
    caseId: "V2-IM-LAB-057",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.family_history.v2",
    title: "内科 貧血フォロー 同月内検査確認レビュー",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 55, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-06" },
    realismAxes: ["same_month_history", "family_history", "numeric_result", "planned_exam"],
    distractors: [
      { type: "same_month_history", name: "8/1採血", note: "同月内の類似検査" },
      { type: "family_history", name: "母の胃がん", note: "背景情報。算定対象ではない" },
      { type: "planned_exam", name: "上部内視鏡", note: "紹介予定。本日実施なし" }
    ],
    soap: {
      S: [
        "鉄欠乏性貧血で通院中。8/1に採血済みだが、だるさが続くため本日も相談。",
        "息切れは階段で少しある。黒色便なし、月経量は以前より多い。",
        "母が胃がんで手術歴あり、本人は内視鏡が必要か心配している。",
        "鉄剤は飲むと胃がむかむかするため、自己判断で隔日にしていた。",
        "仕事は立ち仕事で、夕方にふらつくことがあるが失神はない。"
      ],
      O: [
        "眼瞼結膜やや蒼白。BP 118/70、P 84整。",
        "8/1の採血: Hb 9.8、MCV 72、Fe低値。結果は本人へ説明済み。",
        "本日も血算とフェリチンの再検を希望。採血は行い、8/1の検査結果と今回の再検理由を分けて記録した。",
        "便潜血は本日行わず。上部内視鏡は紹介先で調整予定。"
      ],
      A: [
        "鉄欠乏性貧血。月経過多が主因の可能性が高いが、消化管評価も検討。",
        "同月内の前回検査と今回再検の目的を区別して記録する必要あり。"
      ],
      P: [
        "鉄剤内服は継続。便秘がつらければ隔日内服も相談可。",
        "婦人科受診を勧める。消化器内科紹介は本人希望も踏まえて調整。",
        "同月内の前回採血と本日の採血目的を分けて、本人へ説明できるよう記録する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["鉄欠乏性貧血"],
      requiredBillingSignals: ["血算", "フェリチン"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["上部内視鏡", "便潜血"]
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
    caseId: "V2-IM-LAB-058",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.normal_negative_result.v2",
    title: "内科 発熱後尿路症状 尿定性+静脈採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 63, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-07" },
    realismAxes: ["normal_negative_result", "lab_raw_values", "past_value", "abbreviation"],
    distractors: [
      { type: "past_lab_values", name: "前回eGFR", note: "過去値。今回の検査ではない" },
      { type: "negated_exam", name: "腹部CT", note: "不要と判断、実施なし" },
      { type: "normal_result", name: "尿糖陰性", note: "陰性でも検査実施の結果" }
    ],
    soap: {
      S: [
        "膀胱炎後の再診。抗菌薬開始後、発熱はなくなった。",
        "排尿時痛は改善したが、まだ尿が濁る気がする。腰背部痛なし。",
        "前回eGFRは本人説明済みで大きな問題なし。",
        "夜間頻尿は前回より減った。水分摂取は増やしている。",
        "薬は飲み切る予定で、下痢や発疹などの副作用はない。"
      ],
      O: [
        "KT 36.7、BP 126/74、P 76整。",
        "腹部平坦・軟。CVA叩打痛なし。脱水所見なし。",
        "院内で尿定性・尿蛋白を実施。白血球反応(+)、亜硝酸塩(-)、尿蛋白(±)、尿糖(-)、潜血(-)。",
        "同日に静脈採血を施行。外注へ血算・腎機能を提出した。",
        "重症感なく、腹部CTは不要と判断し行わず。"
      ],
      A: [
        "尿路感染症の改善過程。尿所見は残るが全身状態良好。",
        "腎盂腎炎を示唆する所見なし。"
      ],
      P: [
        "内服完遂を指示。水分摂取と排尿を我慢しないことを説明。",
        "採血結果は異常があれば連絡。発熱・腰背部痛があれば早期受診。",
        "尿糖陰性などの結果も含め、今回の尿検査は本日の経過確認として説明した。"
        ,"抗菌薬の副作用が出た場合は中止せず連絡するよう伝えた。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["尿路感染症"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["腹部CT"]
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
    caseId: "V2-IM-IMG-059",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.quantity_missing.v3",
    title: "内科 腹痛 CT実施 造影・保存条件確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 49, sex: "male" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-08" },
    realismAxes: ["imaging_performed", "contrast_unknown", "external_history", "normal_negative_result"],
    distractors: [
      { type: "external_result", name: "前医腹部エコー", note: "他院実施。今回算定なし" },
      { type: "planned_exam", name: "大腸内視鏡", note: "後日紹介予定" },
      { type: "negative_findings", name: "虫垂炎否定的", note: "画像所見の陰性結果" }
    ],
    soap: {
      S: [
        "昨夜から右下腹部痛。発熱は自覚なし。嘔吐なし。",
        "3か月前に前医で腹部エコーを受け、胆石なしと言われた。",
        "便通は昨日あり。血便なし。仕事中に痛みが増して受診。",
        "尿の痛みはない。食欲は少し落ちているが水分は摂れている。",
        "過去に尿管結石を疑われたことがあり、本人は再発を心配している。"
      ],
      O: [
        "KT 37.1、BP 132/82、P 88整。",
        "右下腹部に軽度圧痛、反跳痛ははっきりしない。",
        "本日、腹部CTを施行。虫垂腫大は明らかでなく、遊離ガスなし。尿管結石を疑う高吸収域もなし。",
        "画像記録からは造影の有無と保存・管理条件が読み取れず、撮影条件の確認が必要。",
        "前医エコー画像は持参なし。大腸内視鏡は本日行っていない。"
      ],
      A: [
        "急性虫垂炎は否定的。軽症腸炎または便秘関連痛の可能性。",
        "CTの撮影条件は画像部門の実施記録を参照して整理する。"
      ],
      P: [
        "腹痛増悪、発熱、嘔吐があれば救急受診。水分摂取と消化の良い食事を指導。",
        "症状が続く場合は消化器内科で大腸内視鏡を検討。",
        "撮影条件は画像記録を確認し、必要であれば放射線部門へ問い合わせる。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["腹痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認"],
      forbiddenCandidates: ["腹部エコー", "大腸内視鏡"]
    },
    expectedClaimContext: {
      encounter: { service_date: "2026-08-08", is_outpatient: true, ...ENCOUNTER_BASE },
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
    caseId: "V2-IM-LAB-060",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.past_value.v3",
    title: "内科 気管支炎再診 血算+CRP+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 44, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-09" },
    realismAxes: ["lab_raw_values", "past_value", "negative_findings", "abbreviation"],
    distractors: [
      { type: "past_lab_values", name: "前回CRP", note: "過去値も記載されるが、本日のCRPとは別" },
      { type: "negated_exam", name: "胸部X線", note: "不要と判断し本日は撮影なし" },
      { type: "otc_medication", name: "市販咳止め", note: "患者自己使用。今回処方ではない" }
    ],
    soap: {
      S: [
        "咳嗽と微熱で3日前に受診し、本日再診。痰は少し減ったが、夜間咳が残る。",
        "市販の咳止めを1回飲んだが眠気が強かったとのこと。",
        "息苦しさなし、胸痛なし。喫煙なし。",
        "家族に同様の咳症状あり。食欲は戻ってきており、水分摂取も問題ない。",
        "前回処方薬は飲み切り予定で、発疹や下痢はない。"
      ],
      O: [
        "KT 36.9、BP 120/76、P 78整、SpO2 98%(室内気)。",
        "咽頭軽度発赤。呼吸音は両側清、wheezeなし、crackleなし。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 7600、CRP 1.2。",
        "前回CRPは2.8で、改善傾向。",
        "肺炎を疑う聴診所見なく、胸部X線は本日行わず。"
      ],
      A: [
        "急性気管支炎の改善傾向。炎症反応は低下。",
        "肺炎を示唆する所見なし。"
      ],
      P: [
        "咳が残るため去痰薬を継続。眠気の出る市販薬は避けるよう説明。",
        "発熱再燃、息切れ、胸痛があれば早めに受診。",
        "前回のCRP値と本日の値を比較して、炎症が下がっていることを説明した。",
        "仕事中は水分をこまめに摂るよう助言。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性気管支炎"],
      requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["胸部X線"]
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
    caseId: "V2-IM-IMG-061",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.external_result.v4",
    title: "内科 咳嗽 胸部CT実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 59, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-10" },
    realismAxes: ["imaging_performed", "equipment_unknown", "external_result", "negative_findings"],
    distractors: [
      { type: "external_result", name: "健診胸部X線", note: "外部検査結果の参照" },
      { type: "planned_exam", name: "呼吸機能検査", note: "後日予定" },
      { type: "normal_negative_result", name: "結核所見なし", note: "画像の陰性所見" }
    ],
    soap: {
      S: [
        "1か月続く乾いた咳で初診。発熱なし、体重減少なし。",
        "健診の胸部X線で右上肺野に淡い影を指摘され、精査目的で受診。",
        "喫煙歴なし。ペットなし。職場は事務職。",
        "夜間に咳で目が覚めることが週2回ほどある。喘鳴の自覚はない。",
        "健診結果票は持参したが、画像そのものは持ってきていない。"
      ],
      O: [
        "KT 36.4、BP 118/72、P 74整、SpO2 99%。",
        "呼吸音清、明らかなwheezeなし。頸部リンパ節腫大なし。",
        "本日、胸部CTを施行。右上葉に陳旧性変化を疑う索状影、明らかな腫瘤影なし。結核を疑う空洞性病変なし。",
        "胸部CTの撮影装置に関する詳細は診察本文には記載されていない。",
        "呼吸機能検査は本日行わず、咳が続く場合に後日予定。"
      ],
      A: [
        "慢性咳嗽。CT上は悪性腫瘍や活動性結核を強く疑う所見なし。",
        "撮影装置の詳細は画像部門記録で整理する。"
      ],
      P: [
        "咳喘息の可能性も説明し、吸入薬の適応は経過で判断。",
        "健診画像との比較を依頼。咳が続けば呼吸機能検査を予約する。",
        "撮影装置の詳細は必要時に撮影部門の記録を参照する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["慢性咳嗽"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["健診胸部X線", "呼吸機能検査"]
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
