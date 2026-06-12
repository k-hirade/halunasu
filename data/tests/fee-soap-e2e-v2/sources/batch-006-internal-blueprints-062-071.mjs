// v2 batch-006: blueprint V2BP-0062〜0071 を手書きSOAPへ落とす第2追加バッチ。
const ENCOUNTER_BASE = {
  regional_bureau: "kanto-shinetsu",
  medical_institution_code: "1312345"
};

export const cases = [
  {
    caseId: "V2-IM-LAB-062",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.revisit.basic.clinic_basic.past_value.v1",
    title: "内科 尿路症状再診 尿定性のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 38, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-01" },
    realismAxes: ["past_value", "negative_findings", "patient_words", "self_care_before_visit"],
    distractors: [
      { type: "past_lab_values", name: "前回尿沈渣", note: "過去検査の参照。本日検査ではない" },
      { type: "planned_exam", name: "次回腎機能採血", note: "次回予定。本日は採血なし" },
      { type: "self_care_before_visit", name: "市販漢方", note: "患者自己使用。今回処方ではない" }
    ],
    soap: {
      S: [
        "排尿時の違和感で3日前に受診し、本日再診。",
        "「しみる感じはだいぶ減ったが、朝だけ尿が濁る」。発熱なし、腰背部痛なし。",
        "前回の尿沈渣で白血球が多いと言われた記憶があるが、詳細は覚えていない。",
        "市販の漢方を1回飲んだが、その後は使用していない。",
        "仕事中に水分を控えがちで、夕方に症状を強く感じることがある。"
      ],
      O: [
        "KT 36.5、BP 116/72、P 68整。",
        "腹部平坦・軟。下腹部圧痛ごく軽度。CVA叩打痛なし。",
        "本日、院内で尿定性と尿蛋白を実施。白血球反応(+)、亜硝酸塩(-)、尿蛋白(±)、尿糖(-)、潜血(-)。",
        "脱水所見なし。本日は静脈採血を行っていない。",
        "腎機能は症状が続く場合に次回採血で確認する方針。"
      ],
      A: [
        "軽症尿路感染症の改善傾向。発熱や腰背部痛はなく上部尿路感染は考えにくい。",
        "前回尿沈渣は参考情報であり、本日の算定対象は本日行った尿検査に限る。"
      ],
      P: [
        "水分摂取と排尿を我慢しないことを再指導。",
        "発熱・腰背部痛・肉眼的血尿があれば早めに受診。",
        "市販漢方は自己判断で増やさず、症状が戻る場合は連絡するよう説明。",
        "前回結果と本日の尿所見を分けて説明し、今日の検査は尿の経過確認として扱った。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["尿路感染症"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["検体検査管理加算", "Ｂ－Ｖ"]
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
    caseId: "V2-IM-LAB-063",
    caseTypeKey: "review_required.internal_medicine.lab.lab.ambiguous_code.clinic_basic.external_result.v1",
    title: "内科 倦怠感 検査方法未確定レビュー",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 42, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-02" },
    realismAxes: ["external_result", "ambiguous_test_name", "patient_words", "planned_exam"],
    distractors: [
      { type: "external_result", name: "健診甲状腺値", note: "外部健診結果。自院検査ではない" },
      { type: "home_medication", name: "市販鉄剤", note: "自己購入。今回処方ではない" },
      { type: "planned_exam", name: "次回血液検査", note: "次回予定" }
    ],
    soap: {
      S: [
        "倦怠感で再診。本人は「朝から体が重く、仕事中に集中しづらい」と話す。",
        "健診で甲状腺の数値が少し高めと言われたが、結果票はスマートフォン写真のみ。",
        "市販鉄剤を数日飲んだが胃もたれがあり中止。発熱なし、体重減少なし。",
        "月経量は以前から多いが、今回急に増えた印象はない。",
        "仕事中に立ちくらみがあり、水分摂取が少ない日ほどつらいと話す。"
      ],
      O: [
        "KT 36.4、BP 110/66、P 82整。",
        "眼瞼結膜は軽度蒼白。甲状腺腫大は明らかでない。浮腫なし。",
        "本日、院内で貧血関連の簡易検査を行ったが、検査方法と標準コードに必要な詳細が記録から特定できない。",
        "結果は軽度低値相当として説明。健診の甲状腺結果は外部資料として確認のみ。",
        "次回、必要に応じて通常採血で血算・甲状腺機能を確認する。"
      ],
      A: [
        "倦怠感。軽度貧血の可能性があるが、今回の検査は方法確認が必要。",
        "健診結果は外部情報であり、本日の自院検査とは分けて扱う。"
      ],
      P: [
        "食事内容と月経量の記録を依頼。息切れや動悸が強ければ早めに受診。",
        "簡易検査のキット名と記録を確認し、標準コードの候補を医事で確認する。",
        "市販鉄剤は胃症状があるため自己判断で再開しないよう説明。",
        "健診写真だけで自院検査として扱わないこと、必要なら正式な結果票を持参することを伝えた。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["貧血疑い"],
      requiredBillingSignals: ["貧血関連簡易検査"],
      requiredReviewTopics: ["検査コード確認"],
      forbiddenCandidates: ["健診甲状腺値", "次回血液検査"]
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
    caseId: "V2-IM-NEG-064",
    caseTypeKey: "safety.internal_medicine.safety_negation.negated.lab.clinic_basic.planned_order.v1",
    title: "内科 発熱初日 迅速検査見送り",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 31, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-03" },
    realismAxes: ["negated_action", "planned_order", "family_context", "occupational_context"],
    distractors: [
      { type: "family_context", name: "同居家族の発熱", note: "家族情報。患者本人の検査ではない" },
      { type: "planned_exam", name: "翌日の迅速検査", note: "予定のみ" },
      { type: "work_context", name: "職場での流行", note: "背景情報" }
    ],
    soap: {
      S: [
        "発熱初日で再診外来へ。朝から37度台後半、咽頭痛と鼻汁あり。",
        "同居の子どもが昨日から発熱し、園でインフルエンザが流行していると聞いている。",
        "本人は「今日検査した方がよいか」と相談。解熱薬はまだ使っていない。",
        "仕事は接客業で、明日の勤務可否を気にしている。"
      ],
      O: [
        "KT 37.8、SpO2 98%、呼吸音清。",
        "咽頭軽度発赤、扁桃白苔なし。頸部リンパ節腫大なし。",
        "発症からの時間が短く、本日はインフルエンザ迅速検査もコロナ抗原検査も実施しなかった。",
        "症状が続く場合は翌日以降に検査を検討する方針。",
        "現時点で脱水所見なし。肺音清で、胸部画像検査も行っていない。"
      ],
      A: [
        "急性上気道炎疑い。家族内感染の可能性はあるが、本日は検査実施なし。",
        "現時点では重症感なし。"
      ],
      P: [
        "水分摂取、休養、解熱薬の頓用を説明。",
        "高熱持続、息苦しさ、強い咽頭痛があれば再診。",
        "検査は明日以降の症状経過で判断すると説明し、本日の検査料には含めない。",
        "職場への説明は、症状経過を見て翌朝の状態で判断するよう助言した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["急性上気道炎疑い"],
      requiredBillingSignals: ["検査見送り"],
      requiredReviewTopics: ["実施確認"],
      forbiddenCandidates: ["インフルエンザ迅速", "コロナ抗原", "検査実施料"]
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
    caseId: "V2-IM-SURG-065",
    caseTypeKey: "unsupported_expected.internal_medicine.surgery.surgery.unsupported.clinic_basic.negated_action.v1",
    title: "内科 陥入爪 手術適応相談のみ",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 57, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-04" },
    realismAxes: ["surgery_context", "negated_action", "normal_negative_result"],
    distractors: [
      { type: "negated_treatment", name: "爪の部分切除", note: "本日は未実施" },
      { type: "home_care", name: "自己爪切り", note: "受診前の自己処置" }
    ],
    soap: {
      S: [
        "右母趾の爪周囲痛で初診。数週間前から靴に当たると痛む。",
        "本人は自分で爪を深く切った後から悪化したと話す。",
        "膿が出たことはない。発熱なし。糖尿病なし。",
        "「爪を切る処置が必要か知りたい」と希望。",
        "立ち仕事で夕方に痛みが増えるが、安静時痛はない。"
      ],
      O: [
        "右母趾外側爪郭に軽度発赤と圧痛。膿瘍形成なし、波動なし。",
        "爪棘が皮膚に接しているが、強い感染徴候はない。",
        "本日は爪の部分切除、切開排膿、焼灼処置はいずれも行っていない。",
        "洗浄後、保護のためガーゼを軽く当てた。",
        "歩行は可能で、靴を脱ぐと痛みは軽くなる。"
      ],
      A: [
        "軽度陥入爪。現時点では保存的対応で経過を見る。",
        "手術的処置の適応は症状遷延時に外科または皮膚科で相談。"
      ],
      P: [
        "爪を深く切らないこと、幅の広い靴を選ぶことを指導。",
        "発赤拡大・排膿・疼痛増悪時は早めに受診。",
        "爪の処置方法、局所麻酔が必要になる可能性、紹介先での対応を説明した。",
        "本人には、本日は説明と保存的処置に留め、手術的な爪処置は実施していないことを確認した。",
        "感染徴候が出た場合は抗菌薬や外科的処置の要否を再評価する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["陥入爪"],
      requiredBillingSignals: ["手術相談"],
      requiredReviewTopics: ["手術未対応", "手技内容確認"],
      forbiddenCandidates: ["爪甲部分切除", "切開排膿"]
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
    caseId: "V2-IM-SPLIT-066",
    caseTypeKey: "split_required.internal_medicine.split_multi_day.split.multi_day.single_note.hospital_acute.otc_or_home_med.v1",
    title: "内科 入院糖尿病悪化 2日分混在記録",
    department: "internal_medicine",
    facilityFixtureKey: "hospital_acute",
    difficultyLevel: "L3",
    patient: { age: 66, sex: "male" },
    encounter: { setting: "mixed_or_inpatient", visitType: "revisit", serviceDate: "2026-08-05" },
    realismAxes: ["multi_day", "inpatient_context", "home_medication", "quantity_missing"],
    distractors: [
      { type: "previous_day_lab", name: "8/4入院時採血", note: "別日検査" },
      { type: "home_medication", name: "持参メトホルミン", note: "入院前からの薬" },
      { type: "quantity_missing_medication", name: "補正インスリン", note: "投与量の整理が必要" }
    ],
    soap: {
      S: [
        "8/4に高血糖と倦怠感で入院。8/5朝の回診時、本人は「昨日より口渇は少ない」と話す。",
        "入院前からメトホルミンを内服していたが、食事量低下のため自己判断で中断していた。",
        "8/4夜は眠りが浅く、病棟で水分を多めに摂取した。",
        "8/5は朝食を半量摂取。嘔吐なし、腹痛なし。",
        "家族からは、入院前日の内服状況と病棟での指示が混ざって分かりにくいとの相談があった。"
      ],
      O: [
        "8/4入院時: 血糖 398、尿ケトン(±)、Na 136、Cr 0.92。補液を開始。",
        "8/5本日: BP 128/76、P 84整、意識清明。口腔内乾燥は軽度改善。",
        "8/5朝の血糖は病棟測定で212。補正インスリンは病棟指示で対応中だが、投与量の記録整理が必要。",
        "8/4の採血結果と8/5の回診所見が同じSOAP内に混在している。"
      ],
      A: [
        "2型糖尿病の高血糖入院。脱水は改善傾向。",
        "昨日の入院時検査と本日の診療内容を分けて確認する必要がある。",
        "病棟指示と外来時の持参薬情報が同じ記録内に並んでおり、そのままでは日ごとの請求範囲が曖昧。"
      ],
      P: [
        "8/5分として補液継続、食事摂取量に応じて血糖測定を継続。",
        "持参メトホルミンは再開時期を主治医判断とし、自己判断で再開しないよう説明。",
        "会計・記録上、8/4入院時検査と8/5回診内容を日付ごとに分けて整理する。",
        "補正インスリンの実施量は看護記録と照合し、当日分として扱う内容を別途確認する。",
        "退院時の内服再開計画は、8/5時点では未確定として扱う。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["2型糖尿病", "高血糖"],
      requiredBillingSignals: ["複数日診療"],
      requiredReviewTopics: ["複数日記録分割"],
      forbiddenCandidates: ["8/4入院時採血", "持参メトホルミン"]
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
    caseId: "V2-IM-LAB-067",
    caseTypeKey: "review_required.internal_medicine.lab.lab.same_month.clinic_basic.family_history.v2",
    title: "内科 甲状腺機能 同月再検確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 34, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-06" },
    realismAxes: ["same_month_history", "family_history", "past_value", "patient_words"],
    distractors: [
      { type: "same_month_history", name: "8/1甲状腺採血", note: "同月内検査" },
      { type: "family_history", name: "母の橋本病", note: "背景情報" },
      { type: "planned_exam", name: "甲状腺エコー", note: "次回予約候補" }
    ],
    soap: {
      S: [
        "動悸と手の震えで通院中。8/1に甲状腺関連の採血を行い、本日結果説明で再診。",
        "本人は「まだ夕方に動悸が出るので、もう一度数値を見たい」と希望。",
        "母が橋本病で通院中。本人は遺伝を心配している。",
        "体重は1か月で1kg減少。発熱なし、下痢なし。",
        "市販のカフェイン飲料を多く飲む日があり、動悸との関係も気にしている。"
      ],
      O: [
        "BP 122/68、P 96整。手指振戦軽度あり。",
        "8/1の採血ではTSH低値、FT4軽度高値。結果は本日説明。",
        "本日も甲状腺機能の再検を目的に採血し、同月内の前回検査とは再検理由を分けて記録した。",
        "甲状腺腫大は触診上軽度。エコーは本日行わず、次回予約を検討。"
      ],
      A: [
        "甲状腺機能亢進症疑い。症状持続あり。",
        "同月内の甲状腺関連検査の扱いを確認する。"
      ],
      P: [
        "強い動悸、胸痛、息切れがあれば早期受診。",
        "採血項目と前回同月検査の重複を確認し、必要なら医事へ相談する。",
        "母の病歴は参考情報として扱い、本人の検査結果で判断する。",
        "前回結果の説明と本日の採血希望が同じ記録内にあるため、同月内の扱いを確認してから会計へ回す。",
        "同月内検査の必要性は症状変化と前回結果の推移を踏まえて判断する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["甲状腺機能亢進症疑い"],
      requiredBillingSignals: ["甲状腺機能検査"],
      requiredReviewTopics: ["同月内検査確認"],
      forbiddenCandidates: ["甲状腺エコー"]
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
    caseId: "V2-IM-LAB-068",
    caseTypeKey: "exact.internal_medicine.lab_facility_standards.lab.urine.blood.collection.management.clinic_lab.normal_negative_result.v2",
    title: "内科 側腹部痛 尿定性+採血",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_lab",
    difficultyLevel: "L2",
    patient: { age: 47, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-07" },
    realismAxes: ["normal_negative_result", "lab_raw_values", "external_result", "negative_findings"],
    distractors: [
      { type: "external_result", name: "健診尿酸値", note: "外部健診結果" },
      { type: "negated_exam", name: "腹部エコー", note: "本日は実施なし" },
      { type: "normal_negative_result", name: "尿糖陰性", note: "陰性でも本日の尿検査結果" },
      { type: "home_medication", name: "市販鎮痛薬", note: "患者自己使用" }
    ],
    soap: {
      S: [
        "左側腹部痛で前回受診し、本日再診。痛みは波があり、昨夜は市販鎮痛薬で軽快。",
        "肉眼的血尿なし。発熱なし。吐き気なし。",
        "健診で尿酸が高めと言われたが、結果票は持参していない。",
        "水分摂取は少なめで、仕事中にトイレを我慢することが多い。"
      ],
      O: [
        "KT 36.6、BP 130/78、P 72整。",
        "腹部平坦・軟。左側腹部に軽度圧痛、CVA叩打痛は明らかでない。",
        "本日、院内で尿定性・尿蛋白を実施。潜血(-)、尿蛋白(±)、尿糖(-)、白血球反応(-)。",
        "同日に静脈採血を行い、血算と腎機能を外注へ提出。",
        "重症感なく、腹部エコーは本日行わなかった。"
      ],
      A: [
        "尿路結石疑いは低いが、側腹部痛の経過確認が必要。",
        "尿検査では強い異常なし。腎機能は採血結果待ち。"
      ],
      P: [
        "水分摂取を増やすよう指導。強い疝痛、血尿、発熱時は早期受診。",
        "採血結果は異常があれば連絡。市販鎮痛薬の連用は避けるよう説明。",
        "健診尿酸値は次回結果票があれば確認する。",
        "今回の尿検査と採血は本日の側腹部痛評価として実施したことを本人へ説明した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["側腹部痛"],
      requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料", "Ｂ－Ｖ", "検体検査管理加算"],
      requiredReviewTopics: [],
      forbiddenCandidates: ["腹部エコー", "健診尿酸値"]
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
    caseId: "V2-IM-IMG-069",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.contrast_unknown.clinic_basic.quantity_missing.v3",
    title: "内科 背部痛 CT実施 造影・保存条件未確定",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 62, sex: "female" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-08" },
    realismAxes: ["imaging_performed", "contrast_unknown", "quantity_missing", "external_result"],
    distractors: [
      { type: "external_result", name: "他院腹部エコー", note: "他院実施の過去検査" },
      { type: "quantity_missing_medication", name: "鎮痛薬処方", note: "日数または総量が不足" },
      { type: "planned_exam", name: "整形外科紹介", note: "後日予定" }
    ],
    soap: {
      S: [
        "右背部痛で再診。深呼吸で少し響くが、息切れはない。",
        "先月、他院で腹部エコーを受け胆石なしと言われた。画像は持参なし。",
        "昨夜は痛みで眠りが浅かった。発熱なし、排尿時痛なし。",
        "手持ちの鎮痛薬を飲んだが、薬剤名は覚えていない。",
        "過去に肋間神経痛と言われたことがあり、今回も同じか心配している。"
      ],
      O: [
        "KT 36.8、BP 128/76、P 78整、SpO2 98%。",
        "右背部に叩打痛様の訴えあり。腹膜刺激症状なし。",
        "本日、腹部から胸部下部を含めてCTを施行。明らかな尿管結石や肺炎像は認めず。",
        "記録上、造影の有無と画像の保管条件が確定できないため確認が必要。",
        "整形外科紹介は痛みが続く場合に検討。本日は紹介状作成なし。"
      ],
      A: [
        "背部痛。急性腹症や肺炎を強く疑う所見は乏しい。",
        "CT撮影条件の確認が必要。"
      ],
      P: [
        "痛み止めは手持ち薬の詳細を確認してから判断。薬剤名が不明のため本日は処方内容を保留。",
        "発熱、息切れ、痛み増悪があれば早期受診。",
        "CTの撮影条件は画像記録で確認する。",
        "前医エコーは参考情報にとどめ、今回のCTとは別の検査として扱う。",
        "鎮痛薬を追加する場合は薬剤名と残薬を確認してから判断する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["背部痛"],
      requiredBillingSignals: ["CT"],
      requiredReviewTopics: ["造影確認", "電子保存確認"],
      forbiddenCandidates: ["他院腹部エコー", "整形外科紹介"]
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
    caseId: "V2-IM-LAB-070",
    caseTypeKey: "exact.internal_medicine.lab.lab.cbc.crp.revisit.blood.clinic_basic.past_value.v3",
    title: "内科 肺炎後フォロー 血算+CRP",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 53, sex: "male" },
    encounter: { setting: "outpatient", visitType: "revisit", serviceDate: "2026-08-09" },
    realismAxes: ["lab_raw_values", "past_value", "negative_findings"],
    distractors: [
      { type: "past_lab_values", name: "前回WBC/CRP", note: "過去値と本日値を分ける" },
      { type: "negated_exam", name: "胸部X線", note: "本日は実施なし" },
      { type: "otc_medication", name: "市販のど飴", note: "算定対象外" }
    ],
    soap: {
      S: [
        "肺炎疑いで抗菌薬開始後の再診。咳と痰はかなり減った。",
        "「まだ少しだるいが、熱は下がった」。胸痛なし、息切れなし。",
        "市販のど飴を使っている。内服は飲み切る予定。",
        "前回は炎症反応が高いと説明され、本人は改善しているか気にしている。"
      ],
      O: [
        "KT 36.6、BP 122/74、P 72整、SpO2 98%。",
        "呼吸音は右下肺でわずかにcoarseだが、前回より改善。wheezeなし。",
        "本日、静脈採血を施行し、血算とCRPを測定。WBC 6800、CRP 0.9 mg/dL。",
        "前回はWBC 11200、CRP 5.4。改善傾向。",
        "呼吸状態が安定しており、胸部X線は本日行わなかった。"
      ],
      A: [
        "肺炎または気管支炎の改善過程。炎症反応低下。",
        "重症化所見なし。"
      ],
      P: [
        "抗菌薬は予定通り内服完了。発熱再燃、息切れ、血痰があれば受診。",
        "採血結果を説明し、改善傾向であることを共有。",
        "咳が長引く場合は再度診察し、画像検査の要否を判断する。",
        "市販品は症状緩和目的であり、今回の処方としては扱わないことも確認した。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["肺炎疑い"],
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
    caseId: "V2-IM-IMG-071",
    caseTypeKey: "review_required.internal_medicine.imaging.imaging.equipment_unknown.clinic_basic.external_result.v4",
    title: "内科 頭痛 MRI実施 機器区分確認",
    department: "internal_medicine",
    facilityFixtureKey: "clinic_basic",
    difficultyLevel: "L2",
    patient: { age: 45, sex: "female" },
    encounter: { setting: "outpatient", visitType: "initial", serviceDate: "2026-08-10" },
    realismAxes: ["imaging_performed", "equipment_unknown", "external_result", "home_record"],
    distractors: [
      { type: "external_result", name: "健診頭部MRI", note: "数年前の外部検査" },
      { type: "home_record", name: "頭痛日誌", note: "患者記録" },
      { type: "planned_exam", name: "神経内科紹介", note: "後日検討" }
    ],
    soap: {
      S: [
        "1か月前から片側性の拍動性頭痛が増え、初診。",
        "本人は頭痛日誌を持参。月に6回ほど、光がつらくなる発作がある。",
        "3年前の健診オプションで頭部MRIを受け異常なしと言われたが、画像は持参していない。",
        "嘔吐なし、麻痺なし、ろれつ困難なし。",
        "市販鎮痛薬を月に数回使うが、連日使用はしていない。"
      ],
      O: [
        "BP 118/70、P 70整。意識清明。",
        "神経学的に明らかな麻痺なし。項部硬直なし。",
        "本日、頭部MRIを施行。急性梗塞や占拠性病変を疑う所見なし。",
        "撮像条件の詳細は診察本文には記載されておらず、必要時は検査記録を参照する。",
        "神経内科紹介は予防薬調整が必要な場合に検討。本日は紹介状作成なし。"
      ],
      A: [
        "片頭痛疑い。危険な二次性頭痛を示唆する所見は乏しい。",
        "MRIの撮像条件は検査記録で整理する。"
      ],
      P: [
        "頭痛日誌を継続。鎮痛薬の使用回数を記録するよう説明。",
        "突然の最強頭痛、神経症状、発熱を伴う場合は救急受診。",
        "撮像条件は検査記録を確認し、必要に応じて放射線部門へ照会する。",
        "数年前の健診MRIは他施設の過去検査であり、本日の検査とは分けて扱う。",
        "予防薬は生活への影響を見て次回以降に相談する。"
      ]
    },
    expectedExtraction: {
      requiredDiagnoses: ["片頭痛疑い"],
      requiredBillingSignals: ["MRI"],
      requiredReviewTopics: ["機器区分確認"],
      forbiddenCandidates: ["健診頭部MRI", "神経内科紹介"]
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
