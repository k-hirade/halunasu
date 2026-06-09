#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json");
const outputRoot = path.join(repoRoot, "data/tests/fee-soap-e2e");
const outputPath = path.join(outputRoot, "fee-soap-e2e-cases.json");
const datasetVersion = "2026-06-07.1";

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const curatedBySourceId = loadCuratedSeed30();

if ((source.cases || []).length !== 300) {
  throw new Error(`expected 300 source cases, found ${source.cases?.length}`);
}

const cases = source.cases.map((sourceCase) => buildCase(sourceCase));

const dataset = {
  schemaVersion: "fee-soap-e2e.case-set.v1",
  datasetId: "fee-soap-e2e-cases",
  version: datasetVersion,
  sourceDatasetId: source.datasetId,
  purpose: "fee-chart-gold-seed-300全300件に対応するSOAPカルテと期待点数の1:1マッチアップ正本。exact/review_required/safety/unsupported_expected/split_requiredを同じファイルで管理する。",
  difficultyAxes: {
    difficultyLevel: "SOAP本文から候補を拾う抽出難易度。元のfee-goldのcalculation difficultyとは別軸。",
    calculationDifficulty: "sourceDatasetId側の点数・算定難易度。"
  },
  evaluationPolicy: {
    requiredBillingSignals: "本文の逐語部分一致では判定しない。expectedExtraction.signalExpectationsを抽出器出力と照合し、表記ゆれ・単位・加算名を正規化して評価する。",
    positiveExpectation: "requiredProcedureCandidates / signalExpectations.literalInChart / signalExpectations.derivedFromContext が抽出器出力に含まれること。",
    negativeExpectation: "forbiddenCandidates が抽出器出力や確定候補に含まれないこと。",
    reviewExpectation: "requiredReviewTopics に対応する確認理由が出ること。",
    forbiddenCandidatePolicy: "forbiddenCandidates は抽出器/算定器が確定候補にしてはいけない正規化済みコードまたは候補ラベル。状態語は使わず、禁止理由は requiredReviewTopics に持たせる。"
  },
  cases: cases.map((item) => ({
    caseId: item.caseId,
    sourceCaseId: item.sourceCaseId,
    sourceTitle: item.sourceTitle,
    title: item.title,
    difficultyLevel: item.difficultyLevel,
    calculationDifficulty: item.calculationDifficulty,
    patient: item.patient,
    encounter: item.encounter,
    chart: {
      format: "soap",
      soap: item.soap,
      standard: standardNote(item.soap)
    },
    status: item.status,
    qualityLabel: item.qualityLabel,
    expectedExtraction: item.expectedExtraction,
    expectedClaimContext: item.expectedClaimContext,
    expectedCalculation: item.expectedCalculation,
    billingTargets: item.billingTargets,
    evidence: item.evidence,
    sourceReviewPolicy: item.sourceReviewPolicy,
    reviewPolicy: item.reviewPolicy
  }))
};

writeJson(outputPath, dataset);

console.log(JSON.stringify({
  cases: cases.length,
  curatedOverrides: curatedBySourceId.size,
  output: path.relative(repoRoot, outputPath)
}, null, 2));

function buildCase(sourceCase) {
  const curated = curatedBySourceId.get(sourceCase.caseId);
  const soap = sanitizeSoap(curated ? curated.chart.soap : enrichSoap(sourceCase));
  return {
    caseId: sourceCase.caseId,
    sourceCaseId: sourceCase.caseId,
    sourceTitle: sourceCase.title,
    title: sourceCase.title,
    difficultyLevel: curated?.difficultyLevel || extractionDifficultyForSource(sourceCase),
    calculationDifficulty: sourceCase.difficulty,
    patient: sourceCase.targetBillingFacts.patient,
    encounter: sourceCase.targetBillingFacts.encounter,
    soap,
    expectedExtraction: buildExpectedExtraction(sourceCase),
    expectedClaimContext: sourceCase.claimContextGold ?? null,
    expectedCalculation: sourceCase.expectedCalculation,
    billingTargets: sourceCase.targetBillingFacts.billingTargets || [],
    evidence: evidenceForSource(sourceCase),
    status: sourceCase.status,
    qualityLabel: sourceCase.qualityLabel,
    sourceReviewPolicy: sourceCase.reviewPolicy,
    reviewPolicy: {
      officeReviewed: false,
      officeReviewRequired: true,
      calculationAssertion: `soap_to_claim_context_then_${sourceCase.expectedCalculation?.assertionLevel ?? "unknown"}`,
      ciEligible: sourceCase.reviewPolicy?.ciEligible === true,
      productionGoldAllowed: false,
      notes: "SOAP本文からexpectedExtraction相当を抽出し、expectedClaimContext/expectedCalculationに接続するE2E用データ。医療事務レビュー前。"
    }
  };
}

function enrichSoap(sourceCase) {
  const base = structuredSoap(sourceCase.chartVariants?.soap);
  const profile = profileForSource(sourceCase);
  return {
    S: [...base.S, ...profile.S],
    O: [...base.O, ...profile.O],
    A: [...base.A, ...profile.A],
    P: [...base.P, ...profile.P]
  };
}

function profileForSource(sourceCase) {
  const targetNames = (sourceCase.targetBillingFacts?.billingTargets || []).map((item) => item.name || item.type || "").join("、");
  const diagnoses = (sourceCase.targetBillingFacts?.diagnoses || []).join("、") || "診断名未確定";
  const encounter = sourceCase.targetBillingFacts?.encounter || {};
  const patient = sourceCase.targetBillingFacts?.patient || {};
  const assertionLevel = sourceCase.expectedCalculation?.assertionLevel;
  const reviewTopics = (sourceCase.expectedExtraction?.requiredReviewTopics || []).join("、");
  const forbidden = normalizeForbiddenCandidates(sourceCase.expectedExtraction?.forbiddenCandidates || []).join("、");
  const text = `${sourceCase.title} ${targetNames} ${diagnoses} ${reviewTopics} ${forbidden}`;
  const visit = visitLabel(encounter.visitType);
  const setting = settingLabel(encounter.setting);
  const sex = sexLabel(patient.sex);
  const department = departmentLabel(encounter.department);

  const common = {
    S: [
      `${patient.age ?? "年齢不詳"}歳${sex}。${department}で${setting}の${visit}として診療。症状の始まり、経過、生活への影響、既往歴、薬剤アレルギー、患者または家族が心配している点を確認した。`,
      "食事量、水分摂取、睡眠、仕事や登園・通学への影響、前回受診からの変化を確認し、診療録に必要な背景情報を残した。",
      "患者が自分の言葉で説明した困りごと、家族や介助者からの補足、受診前に行ったセルフケア、治療への希望を確認した。"
    ],
    O: [
      "バイタル、意識状態、呼吸状態、関連する身体所見、陰性所見を確認。実施した診療行為、検体採取、処置、処方、画像検査の有無を当日の記録として整理した。",
      `当日確認した主な診療内容は「${targetNames || "要確認項目"}」。実施済みの内容と説明のみの内容を分けて記録した。`,
      "過去に行った検査、今後予定している検査、院外で説明を受けた内容、当日実施した内容が混ざらないように確認した。"
    ],
    A: [
      `${diagnoses}を中心に評価。鑑別疾患、重症度、外来または入院で管理できる理由を整理した。`,
      "診療内容の判断に関わる名称だけでなく、なぜその検査・処置・処方・管理が必要だったかを医学的文脈として記録した。",
      "病名、診療日、実施有無、部位、数量、日数、施設基準、同月履歴など、診療上の確認に必要な条件を分けて評価した。"
    ],
    P: [
      "検査結果や処置内容を説明し、治療方針、再診目安、悪化時の対応を具体的に伝えた。",
      "患者または家族が自宅で確認すべき症状、薬の使い方、受診すべきタイミングを説明した。",
      "診療録だけで確定できない確認条件は、追加記録、施設情報、同月履歴の確認へ回す方針とした。"
    ]
  };

  if (assertionLevel === "safety") {
    return mergeProfile(common, {
      S: [
        "患者の訴えに加えて、当日実施した内容、次回予定、前回結果説明、院外で行われた検査や処置を一つずつ確認した。",
        "患者は検査や処置を希望または相談しているが、診療録上は実施済みかどうかを明確に区別する必要がある。"
      ],
      O: [
        "身体所見とバイタルを確認し、当日実施した診療行為だけを記録した。予定、過去結果、未実施、院外情報は実施済み欄に混ぜない。",
        `当日実施と混同しやすい内容は「${forbidden || "該当なし"}」。未実施・過去・予定の文脈を明確に残した。`
      ],
      A: [
        "安全性確認用の記録。予定、過去歴、未実施、院外検査を当日の診療行為として扱わないことが重要。",
        `確認すべき論点は「${reviewTopics || "実施有無の確認"}」。診療内容を過大に扱わないよう評価する。`
      ],
      P: [
        "必要時の再診、次回検査や処置の予定、悪化時の対応を説明した。予定項目は当日実施項目と区別して次回方針に残した。",
        "患者にも、本日は実施していない検査や処置があること、必要なら次回以降に判断することを説明した。"
      ]
    });
  }
  if (assertionLevel === "unsupported_expected") {
    return mergeProfile(common, {
      S: [
        "患者背景、症状経過、生活上の支障、家族支援、既往歴を確認した。診療内容には専門的な確認が必要な領域が含まれる。",
        "患者または家族には、処置や管理の必要性だけでなく、専門的な確認が必要な内容であることも説明している。"
      ],
      O: [
        "当日の実施内容、部位、時間、手技、説明内容、在宅・リハビリ・精神科・手術・麻酔・病理などの該当領域を診療録に残した。",
        `慎重に扱うべき内容は「${forbidden || "該当なし"}」。追加確認が必要な領域として、実施内容を具体的に記録した。`
      ],
      A: [
        "専門的な判断を要する状態。診療録だけで結論を急がず、追加確認が必要。",
        `確認すべき論点は「${reviewTopics || "未対応領域の確認"}」。一般的な外来基本料や処置に安易に置き換えない。`
      ],
      P: [
        "患者説明、再診目安、専門科紹介、継続管理、家族への注意点を記録した。該当領域は追加確認へ回す。",
        "診療録だけで判断せず、必要な記録や施設基準、実施単位、時間、手技内容を追加確認する。"
      ]
    });
  }
  if (assertionLevel === "split_required") {
    return mergeProfile(common, {
      S: [
        "複数日の症状経過、受診日ごとの訴え、患者が混同して話した過去日と当日の内容を分けて確認した。",
        "患者の説明には数日分の経過が含まれるため、同じ診療日としてまとめず、日付ごとに整理する必要がある。"
      ],
      O: [
        "診療録には複数日の検査、処置、説明、経過観察が混在している。各日付で実施した内容を分けて確認した。",
        `誤って行ってはいけない処理は「${forbidden || "全日分を1日で合算"}」。日付ごとの診療単位を確認する。`
      ],
      A: [
        "複数日記録を1回の診療として混ぜないことが主な確認点。日付、実施行為、診療単位を分ける必要がある。",
        `確認すべき論点は「${reviewTopics || "複数日記録分割"}」。読み取り後に日別ケースへ分割する。`
      ],
      P: [
        "診療日ごとに記録を分け、必要に応じて各日の診療内容を別々に確認する。",
        "患者説明と次回方針も日付ごとに整理し、当日分だけを対象にする。"
      ]
    });
  }
  if (assertionLevel === "review_required" || assertionLevel === "candidate_presence") {
    const reviewProfile = reviewProfileForTopics(reviewTopics, forbidden);
    if (reviewProfile) {
      return mergeProfile(common, reviewProfile);
    }
  }
  if (/熱傷|創傷|処置|ゲーベン|外用/.test(text)) {
    return mergeProfile(common, {
      S: [
        "受傷時期、受傷機転、疼痛の程度、日常生活で困る動作、自宅で行った処置、創部が濡れる頻度を確認した。",
        "患者は感染や傷跡への不安があり、どの状態なら予定外受診が必要か具体的な説明を希望している。"
      ],
      O: [
        "創部の部位、縦横サイズ、面積、深さ、浸出液、発赤、腫脹、熱感、悪臭、壊死組織の有無を確認し、洗浄・外用・被覆の内容を記録した。",
        "外用薬がある場合は、院内で交付したか、使用量、塗布範囲、被覆材の種類を明記した。"
      ],
      A: [
        "創傷・熱傷は面積区分、部位、感染兆候、当日処置内容が判断に影響するため、単なる病名だけでは不十分。",
        "感染を示す所見が乏しい場合でも、処置継続の必要性と自宅管理の理解度を評価した。"
      ],
      P: [
        "洗浄、外用、被覆材交換、入浴時の注意、仕事や家事中の保護方法を説明した。",
        "発熱、発赤拡大、腫脹、膿性排液、悪臭、疼痛増強があれば予定日前でも受診するよう伝えた。"
      ]
    });
  }
  if (/CT|X線|撮影|画像|造影|MRI|超音波/.test(text)) {
    return mergeProfile(common, {
      S: [
        "検査を希望する理由、症状の変化、危険徴候、既往歴、検査への不安、造影剤使用時のアレルギー歴や腎機能情報を確認した。",
        "検査結果によって治療方針や紹介先が変わる可能性を説明し、実施内容について同意を得た。"
      ],
      O: [
        "検査部位、撮影方法、造影剤使用の有無、電子保存・管理の有無を診療録に残し、身体所見と照合した。",
        "画像所見は症状、身体所見、経過と合わせて判断し、撮影のみで終わらず診療方針に反映した。"
      ],
      A: [
        "画像検査は重篤疾患の除外または病変部位の確認を目的とする。臨床所見だけでは判断しづらい疾患を鑑別に残す。",
        "陰性所見であっても、症状が続く場合は追加検査や専門科紹介の必要性を再評価する。"
      ],
      P: [
        "画像結果を患者に説明し、見逃してはいけない症状、再受診の目安、必要時の紹介方針を伝えた。",
        "造影剤使用時は検査後の体調変化や遅発性反応についても説明した。"
      ]
    });
  }
  if (/尿|血液|CRP|検査|採血|検体|インフル|溶連菌|SARS|HbA1c|蛋白|判断料/.test(text)) {
    return mergeProfile(common, {
      S: [
        "発症時期、症状の推移、周囲の流行、前医治療、市販薬使用、水分摂取量、仕事や家庭での支障を確認した。",
        "患者は検査結果によって薬剤調整、追加検査、生活指導、再診間隔が変わるかを心配しており、結果説明を希望している。"
      ],
      O: [
        "検体採取の種類、採血の有無、検査目的を診療録に明記。バイタルと身体所見から緊急性の高い状態ではないことも確認した。",
        "検査値だけでなく、症状の経過、身体所見、既往歴、服薬状況、生活背景を合わせて判断する。"
      ],
      A: [
        "検査は感染症や炎症の程度、慢性疾患の管理状態を評価するために行い、結果だけでなく症状の経過と組み合わせて解釈する。",
        "病名候補が複数ある場合でも、どの検査がどの臨床疑問に対応しているかを診療録から追えるようにした。"
      ],
      P: [
        "検査結果の確認後に、薬剤調整、生活指導、経過観察、追加検査、紹介の要否を判断する。",
        "結果待ちの間の注意点、悪化時の受診目安、水分摂取や休養について説明した。"
      ]
    });
  }
  if (/処方|薬剤|一般名|内服|外用|頓服|日数|総量|調剤/.test(text)) {
    return mergeProfile(common, {
      S: [
        "服薬状況、飲み忘れ、副作用、残薬、希望する薬局、薬剤費への不安、生活習慣を確認した。",
        "薬の使い方を誤らないよう、1回量、1日回数、日数または総量について患者の理解を確認した。"
      ],
      O: [
        "処方内容、用量、回数、日数または総量、院内/院外、一般名処方の有無を診療録に残した。",
        "副作用や禁忌を確認し、継続処方か新規処方か、頓服か定期内服かを整理した。"
      ],
      A: [
        "薬剤は用量・日数・総量が不足すると確認が必要。院外処方と一般名処方は文脈から判断する。",
        "慢性疾患では治療継続の妥当性、急性疾患では症状に対する必要性を分けて評価した。"
      ],
      P: [
        "服薬方法、副作用、自己中断しないこと、次回受診時に確認する内容を説明した。",
        "症状改善が乏しい場合や副作用が疑われる場合は早めに相談するよう伝えた。"
      ]
    });
  }
  if (/入院|DPC|病棟|急性期一般/.test(text)) {
    return mergeProfile(common, {
      S: [
        "入院前後の症状、食事摂取、ADL、家族支援、退院希望、在宅で安全に過ごせるかを確認した。",
        "本人の訴えだけでなく、看護記録と家族からの情報も診療判断に反映した。"
      ],
      O: [
        "病棟でのバイタル、酸素化、食事量、尿量、投薬、看護記録、離床状況を確認した。",
        "急性期病棟で継続管理が必要な状態として、感染症治療、全身状態観察、退院調整を同日に行っている。"
      ],
      A: [
        "入院継続の医学的理由と生活背景を分けて評価し、病棟での継続管理が必要か判断する。",
        "病勢が改善傾向でも、年齢、併存症、生活背景により急な退院は再増悪や転倒リスクにつながる。"
      ],
      P: [
        "病棟スタッフと情報共有し、退院前に食事量、歩行、服薬理解、家族支援を再確認する。",
        "退院後の再診目安、発熱再燃、呼吸苦、食事摂取低下時の連絡先を説明する。"
      ]
    });
  }
  return common;
}

function reviewProfileForTopics(reviewTopics, forbidden) {
  if (/初診\/再診|受付時刻|休日|時間外|小児/.test(reviewTopics)) {
    return {
      S: [
        "前回受診歴、同一症状での受診有無、受付時刻、休日・夜間受診かどうか、保護者からの説明を確認した。",
        "初診か再診か、時間外や小児加算に関わる条件が診療録だけでは確定しきれないため、追加確認が必要。"
      ],
      O: [
        "年齢、診療科、受付時刻、診療日、前回受診歴、同一疾患の継続性を確認できる範囲で記録した。",
        `注意すべき内容は「${forbidden || "該当なし"}」。条件未確認のまま当日実施として扱わない。`
      ],
      A: [
        "診療内容自体は整理できるが、初診/再診や小児・時間外条件が不足しているため追加確認が必要。",
        `確認論点は「${reviewTopics}」。患者属性だけでなく運用情報も必要。`
      ],
      P: [
        "受付情報、診療履歴、診療区分の扱いを確認してから整理する。",
        "患者説明としては検査結果や治療方針を伝え、受付情報は事務確認へ回す。"
      ]
    };
  }
  if (/面積|創傷|熱傷|処置/.test(reviewTopics)) {
    return {
      S: [
        "受傷機転、受傷時刻、疼痛、創部の変化、自宅処置、仕事や日常生活での支障を確認した。",
        "患者の表現は「手掌大」「広め」「小さめ」など曖昧で、正確な面積や区分が診療録だけでは不足する。"
      ],
      O: [
        "創部の部位、深さ、発赤、腫脹、浸出液、感染兆候、洗浄・被覆の有無を確認した。",
        "面積が明確でないため、縦横サイズや写真、処置範囲の追記が必要。未確認のまま処置区分を確定しない。"
      ],
      A: [
        "創傷・熱傷処置を行った記録。ただし面積区分が不足しており、処置面積の確認が必要。",
        `確認論点は「${reviewTopics}」。`
      ],
      P: [
        "創部サイズを測定し、処置範囲を追記する。感染徴候と自宅処置方法を説明した。",
        "発熱、発赤拡大、膿性排液、疼痛増強があれば早期再診。"
      ]
    };
  }
  if (/薬剤|日数|総量|用量|頓服/.test(reviewTopics)) {
    return {
      S: [
        "症状の程度、薬の使用希望、既往薬、副作用歴、残薬、服薬できる剤形、生活上の制約を確認した。",
        "処方内容は記載されているが、日数、総量、1日回数、頓服の上限回数のいずれかが不足している。"
      ],
      O: [
        "診察所見と処方予定を確認。薬剤名や1回量は一部確認できるが、数量や日数が不足している箇所を診療録上で確認した。",
        `除外または注意すべき候補は「${forbidden || "該当なし"}」。薬剤料を過大に確定しない。`
      ],
      A: [
        "薬剤名は確認できるが、薬剤量の確認には用量・日数・総量が必要。現時点では追加確認が必要。",
        `確認論点は「${reviewTopics}」。`
      ],
      P: [
        "処方内容の1回量、1日回数、日数または総量を追記してから再計算する。",
        "服薬方法、副作用、再診目安を患者へ説明した。"
      ]
    };
  }
  if (/施設基準|検体検査管理|画像診断管理/.test(reviewTopics)) {
    return {
      S: [
        "症状経過と検査・画像検査を希望する理由を確認した。患者には検査目的と結果説明の流れを説明した。",
        "診療内容としては整理できるが、施設基準や届出状況が診療録本文だけでは確認できない。"
      ],
      O: [
        "当日実施した検査、画像、採血、検体管理、電子保存の有無を記録した。",
        "施設基準や届出の有無は施設情報で確認が必要。本文だけで判断しない。"
      ],
      A: [
        "検査・画像に関連する加算候補。ただし施設基準確認が不足しており、確定前に届出状況の確認が必要。",
        `確認論点は「${reviewTopics}」。`
      ],
      P: [
        "施設情報を確認し、条件を満たす場合のみ候補に反映する。",
        "患者には検査結果と今後の治療方針を説明した。"
      ]
    };
  }
  if (/管理料|生活習慣病|慢性疾患|同月/.test(reviewTopics)) {
    return {
      S: [
        "慢性疾患の経過、服薬状況、生活習慣、家庭での測定値、同月の受診歴や他院での管理状況を確認した。",
        "患者には療養指導を行っているが、管理料の条件や同月算定歴は診療録本文だけでは確定しきれない。"
      ],
      O: [
        "バイタル、検査値、服薬状況、指導内容、療養計画の有無を確認した。",
        "同月履歴、療養計画書、対象疾患、指導内容の条件を別途確認する必要がある。"
      ],
      A: [
        "慢性疾患管理または生活習慣病管理に関わる記録。ただし条件確認が不足しており追加確認が必要。",
        `確認論点は「${reviewTopics}」。`
      ],
      P: [
        "療養計画、同月の指導歴、施設運用を確認し、条件を満たすか確認する。",
        "患者には服薬、食事、運動、家庭測定、次回持参物を説明した。"
      ]
    };
  }
  if (/検査コード|コメント|超音波|投与経路|一般名処方|検査項目/.test(reviewTopics)) {
    return {
      S: [
        "症状、希望、前回からの変化、実施した検査や処方の目的を確認した。",
        "診療録には候補名があるが、コード、部位、コメント、投与経路、一般名処方の条件などが不足している。"
      ],
      O: [
        "当日の実施内容を確認し、名称だけでなく部位、経路、条件、コメントが必要な項目を洗い出した。",
        "必要項目は確認できるが、最終判断には追加情報が必要。"
      ],
      A: [
        "診療内容は確認できるが、コードや条件の確認が必要な状態。",
        `確認論点は「${reviewTopics}」。`
      ],
      P: [
        "不足情報を追記し、追加情報を確認する。",
        "患者には診療上の説明と再診目安を伝えた。"
      ]
    };
  }
  return null;
}

function mergeProfile(base, extra) {
  return {
    S: [...base.S, ...extra.S],
    O: [...base.O, ...extra.O],
    A: [...base.A, ...extra.A],
    P: [...base.P, ...extra.P]
  };
}

function buildExpectedExtraction(sourceCase) {
  const expectedExtraction = sourceCase.expectedExtraction || {};
  const requiredBillingSignals = buildRequiredBillingSignals(sourceCase);
  return {
    requiredDiagnoses: expectedExtraction.requiredDiagnoses || sourceCase.targetBillingFacts?.diagnoses || [],
    requiredProcedureCandidates: expectedExtraction.requiredProcedureCandidates || [],
    requiredReviewTopics: expectedExtraction.requiredReviewTopics || sourceCase.targetBillingFacts?.reviewTargets || [],
    forbiddenCandidates: buildForbiddenCandidates(sourceCase),
    requiredBillingSignals,
    signalExpectations: buildSignalExpectations(requiredBillingSignals)
  };
}

function buildForbiddenCandidates(sourceCase) {
  const explicit = sourceCase.expectedExtraction?.forbiddenCandidates || [];
  const level = sourceCase.expectedCalculation?.assertionLevel;
  const shouldDenyConfirmation = ["review_required", "safety", "unsupported_expected", "split_required"].includes(level);
  if (!shouldDenyConfirmation) return normalizeForbiddenCandidates(explicit);
  const targetNames = (sourceCase.targetBillingFacts?.billingTargets || [])
    .map((target) => target.name || target.type)
    .filter(Boolean);
  return normalizeForbiddenCandidates([...explicit, ...targetNames]);
}

function buildRequiredBillingSignals(sourceCase) {
  const level = sourceCase.expectedCalculation?.assertionLevel;
  if (level === "safety" || level === "split_required") return [];
  return (sourceCase.targetBillingFacts?.billingTargets || [])
    .map((target) => target.name || target.type)
    .filter(Boolean);
}

function buildSignalExpectations(signals) {
  const literalInChart = [];
  const derivedFromContext = [];
  for (const signal of signals) {
    const expectation = {
      label: signal,
      matchPolicy: "normalized_candidate_match",
      normalizationHints: normalizationHintsForSignal(signal)
    };
    if (isDerivedSignal(signal)) {
      derivedFromContext.push({
        ...expectation,
        source: "derivedFromContext",
        reason: derivedReasonForSignal(signal)
      });
    } else {
      literalInChart.push({
        ...expectation,
        source: "literalInChart",
        reason: "SOAP本文中の実施・処方・処置記載を、表記ゆれを正規化して候補化する。"
      });
    }
  }
  return {
    literalInChart,
    derivedFromContext,
    matchPolicy: "本文の逐語出現ではなく、抽出器の正規化済み候補に対して照合する。"
  };
}

function evidenceForSource(sourceCase) {
  if (Array.isArray(sourceCase.evidence) && sourceCase.evidence.length) {
    return sourceCase.evidence;
  }
  const namedTargets = [
    ...(sourceCase.targetBillingFacts?.billingTargets || []),
    ...(sourceCase.targetBillingFacts?.reviewTargets || []),
    ...(sourceCase.expectedExtraction?.forbiddenCandidates || [])
  ]
    .map((item) => item?.name || item?.type || item)
    .filter(Boolean);
  const fallbackTargets = namedTargets.length ? namedTargets : [sourceCase.title || sourceCase.caseId];
  return fallbackTargets.map((name) => ({
    type: "review_policy",
    source: "halunasu fee calculation test policy",
    masterVersion: "2026-05-01",
    name,
    verifiedBy: "codex",
    verifiedAt: "2026-06-07",
    verificationMethod: "case intentionally represents extraction, review, safety, or unsupported-domain behavior before office review"
  }));
}

function isDerivedSignal(signal) {
  return /加算|判断料|小児科外来診療料|電子画像管理|検体検査管理|急性期一般入院料|熱傷処置|創傷処置|初診料|再診料|処方箋料|処方料|調剤料|Ｂ－Ｖ|ＣＴ撮影|CT撮影|単純撮影|写真診断|デジタル撮影/.test(signal);
}

function derivedReasonForSignal(signal) {
  if (/初診料|再診料/.test(signal)) return "診療履歴、初診/再診表現、encounter.visitTypeから導出する。";
  if (/乳幼児加算/.test(signal)) return "年齢、初診/再診、診療科などの文脈から導出する。";
  if (/一般名処方加算/.test(signal)) return "院外処方箋と一般名処方の記載から導出する。";
  if (/電子画像管理/.test(signal)) return "画像の電子保存・管理の記載から導出する。";
  if (/検体検査管理/.test(signal)) return "施設基準と検体検査実施の文脈から導出する。";
  if (/急性期一般入院料/.test(signal)) return "入院日数、病棟、施設基準、管理内容から導出する。";
  if (/熱傷処置|創傷処置/.test(signal)) return "部位、面積、創部状態、当日処置内容から処置区分を導出する。";
  if (/判断料/.test(signal)) return "実施検査の分類から導出する。";
  if (/処方箋料|処方料|調剤料/.test(signal)) return "処方の院内/院外、薬剤種別、処方文脈から導出する。";
  if (/小児科外来診療料/.test(signal)) return "年齢、診療科、再診、処方箋交付の文脈から導出する。";
  return "本文と患者・診療文脈の組み合わせから導出する。";
}

function normalizationHintsForSignal(signal) {
  const hints = ["全角半角", "括弧", "スペース", "単位表記"];
  if (/ゲーベン|g|%|薬|錠|散|細粒|シロップ/.test(signal)) hints.push("薬剤名", "濃度", "使用量");
  if (/CT|X線|撮影|画像|MRI|超音波|造影/.test(signal)) hints.push("画像部位", "撮影方式", "電子保存・管理");
  if (/インフル|SARS|溶連菌|CRP|尿|血液|HbA1c/.test(signal)) hints.push("検査名同義語", "検体採取部位");
  if (/処方|一般名|調剤/.test(signal)) hints.push("院外処方", "一般名処方", "リフィル除外");
  if (/熱傷|創傷/.test(signal)) hints.push("部位", "面積", "cm2", "平方センチメートル");
  if (/入院/.test(signal)) hints.push("日数", "病棟", "施設基準");
  return [...new Set(hints)];
}

function extractionDifficultyForSource(sourceCase) {
  if (Number(sourceCase.difficulty) >= 3) return "L3";
  if (Number(sourceCase.difficulty) >= 2) return "L2";
  return "L1";
}

function loadCuratedSeed30() {
  const result = new Map();
  if (fs.existsSync(outputPath)) {
    const current = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    for (const item of current.cases || []) {
      if (item.expectedCalculation?.assertionLevel === "exact" && item.chart?.soap) {
        result.set(item.sourceCaseId, item);
      }
    }
    return result;
  }
  return result;
}

function structuredSoap(soap) {
  return {
    S: asRows(soap?.S),
    O: asRows(soap?.O),
    A: asRows(soap?.A),
    P: asRows(soap?.P)
  };
}

function asRows(value) {
  if (Array.isArray(value) && value.length) return value.map((item) => sanitizeClinicalText(String(item)));
  if (typeof value === "string" && value.trim()) return [sanitizeClinicalText(value.trim())];
  return ["記載なし。"];
}

function sanitizeSoap(soap) {
  return {
    S: (soap?.S || []).map((row) => sanitizeClinicalText(String(row))),
    O: (soap?.O || []).map((row) => sanitizeClinicalText(String(row))),
    A: (soap?.A || []).map((row) => sanitizeClinicalText(String(row))),
    P: (soap?.P || []).map((row) => sanitizeClinicalText(String(row)))
  };
}

function sanitizeClinicalText(value) {
  return normalizeForbiddenText(value)
    .replace(/コード確定はマスター検索で確認。/g, "検査項目とコードは記録で確認。")
    .replace(/診察所見と実施内容は本文に記載。必要な算定条件は確認する。/g, "診察所見と実施内容を記載し、必要な確認条件を整理する。")
    .replace(/算定候補は確定請求ではなく、条件を確認してから採用する。/g, "診療内容は条件を確認してから記録する。")
    .replace(/日付ごとに算定を分ける必要あり。/g, "日付ごとに診療記録を分ける必要あり。")
    .replace(/E2E/g, "一連の診療")
    .replace(/テスト/g, "検査")
    .replace(/抽出/g, "読み取り")
    .replace(/算定候補/g, "診療内容")
    .replace(/算定条件/g, "確認条件")
    .replace(/算定単位/g, "診療単位")
    .replace(/確定請求/g, "最終確認")
    .replace(/マスター検索/g, "記録確認")
    .replace(/コード確定/g, "コード確認")
    .replace(/要レビュー/g, "追加確認")
    .replace(/人手レビュー/g, "追加確認")
    .replace(/人手確認/g, "追加確認")
    .replace(/候補抽出/g, "候補整理")
    .replace(/候補名/g, "項目名")
    .replace(/算定/g, "確認")
    .replace(/確認確認/g, "確認");
}

function normalizeForbiddenCandidates(values) {
  return [...new Set((values || []).map((value) => normalizeForbiddenCandidate(value)).filter(Boolean))];
}

function normalizeForbiddenCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutFacility = raw.match(/^(.+?)\s+confirmed without facility context$/i);
  if (withoutFacility) {
    return `${normalizeForbiddenLabel(withoutFacility[1])}の施設基準未確認`;
  }
  const confirmed = raw.match(/^(.+?)\s+confirmed$/i);
  if (confirmed) {
    const label = normalizeForbiddenLabel(confirmed[1]);
    const specific = {
      処置: "条件未確認の処置",
      管理料: "条件未確認の管理料",
      再診料: "在宅または入院文脈での再診料自動確定",
      急性期一般入院料: "DPC文脈での急性期一般入院料出来高確定",
      DPC: "DPC本算定の自動確定"
    }[label];
    return specific || `${label}の自動確定`;
  }
  return raw;
}

function normalizeForbiddenLabel(value) {
  const label = String(value || "").trim();
  if (/^\d{6,}$/.test(label)) return `コード${label}`;
  return label;
}

function normalizeForbiddenText(value) {
  return String(value || "")
    .replace(/([^\s、。]+)\s+confirmed without facility context/gi, (_, label) => `${normalizeForbiddenLabel(label)}の施設基準未確認`)
    .replace(/([^\s、。]+)\s+confirmed/gi, (_, label) => normalizeForbiddenCandidate(`${label} confirmed`));
}

function visitLabel(value) {
  return {
    initial: "初診",
    revisit: "再診",
    unknown: "初診/再診確認が必要",
    scheduled_home_visit: "訪問診療"
  }[value] || "診療区分確認が必要";
}

function settingLabel(value) {
  return {
    outpatient: "外来",
    inpatient: "入院",
    home_visit: "在宅"
  }[value] || "診療";
}

function sexLabel(value) {
  return {
    male: "男性",
    female: "女性"
  }[value] || "性別未指定";
}

function departmentLabel(value) {
  return {
    pediatrics: "小児科",
    internal_medicine: "内科",
    dermatology: "皮膚科",
    surgery: "外科",
    orthopedics: "整形外科",
    psychiatry: "精神科"
  }[value] || "診療科未指定";
}

function standardNote(soap) {
  return [
    `S: ${soap.S.join(" ")}`,
    `O: ${soap.O.join(" ")}`,
    `A: ${soap.A.join(" ")}`,
    `P: ${soap.P.join(" ")}`
  ].join("\n");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}
