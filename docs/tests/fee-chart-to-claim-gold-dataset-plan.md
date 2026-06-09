# 診療報酬算定 1:1 Gold Dataset 計画

作成日: 2026-06-07

## 目的

カルテ本文と診療報酬算定結果を 1:1 で対応させたテストデータを作成し、診療報酬算定アプリの品質を自動テストで継続的に担保する。

このデータセットは、次の退行を検知するために使う。

- カルテ本文に明記された検査、処置、薬剤、管理料候補を落とす。
- 実施済みの検査を「未実施」や「予定」と誤解する。
- 否定文、過去歴、予定、説明だけの記載を誤って算定候補にする。
- 初診/再診、小児、時間外、施設基準、同月履歴などの確認が必要な項目を無視する。
- 未対応領域を確定算定のように扱う。
- 0点になった理由を出さずに、算定候補を黙って落とす。
- マスター更新や抽出ロジック変更で、以前拾えていた候補が落ちる。

## 最終イメージ

ユーザーの認識どおり、最終形は「1つのカルテ」と「1つの期待算定結果」を対応させる。

ただし、診療報酬算定はカルテ本文だけでは確定できない項目が多いため、1:1 の中に次の2種類の正解を分けて持つ。

1. `expectedExtraction`
   - カルテ本文から最低限抽出すべき病名、検査、処置、薬剤、確認事項。
   - LLMやルール抽出の品質を測る。
   - 合格条件は「必須候補を含む」「禁止候補を含まない」「要レビュー理由を出す」。

2. `expectedCalculation`
   - 明示的な `claimContextGold` を現行マスターに通したときの期待点数、期待コード、期待ステータス。
   - 算定エンジンの品質を測る。
   - 合格条件は点数、候補コード、ステータスの一致。

つまり、1:1 の単位は次の形にする。

```json
{
  "caseId": "pediatric-fever-rapid-tests-001",
  "chart": {
    "format": "soap",
    "text": "S/O/A/P のカルテ本文"
  },
  "expectedExtraction": {
    "diagnoses": ["急性上気道炎疑い"],
    "requiredProcedureCandidates": ["160169450", "160044110"],
    "requiredReviewTopics": ["初診/再診確認", "小児加算確認", "薬剤日数不足"],
    "forbiddenCandidates": ["抗菌薬処方"]
  },
  "claimContextGold": {
    "encounter": {
      "service_date": "2026-06-07",
      "is_outpatient": true
    },
    "procedure_codes": ["160169450", "160044110"],
    "outpatient_basic": {
      "fee_kind": "revisit"
    }
  },
  "expectedCalculation": {
    "engineStatus": "needs_review",
    "totalPoints": 472,
    "candidateCodes": ["160169450", "160044110", "112007410", "160062110"]
  },
  "evidence": [
    {
      "source": "standard-master.sqlite",
      "masterVersion": "2026-05-01",
      "code": "160169450",
      "name": "インフルエンザウイルス抗原定性",
      "points": 132
    }
  ]
}
```

## 1:1 に含める情報

各ケースは、少なくとも以下を持つ。

| 項目 | 内容 |
| --- | --- |
| `caseId` | 安定したID。領域、症例番号、バージョンを含める。 |
| `title` | 人間が読む短い症例名。 |
| `chart.format` | `soap`, `progress_note`, `free_text`, `mixed` など。 |
| `chart.text` | 合成カルテ本文。著作物や実患者情報をそのまま使わない。 |
| `patient` | 年齢、性別など算定に必要な非PHI属性。 |
| `encounter` | 外来/入院、診療日、受付時間、診療科、施設など。 |
| `expectedExtraction` | カルテから拾うべき候補と、拾ってはいけない候補。 |
| `claimContextGold` | 点数完全一致テスト用の明示入力。 |
| `expectedCalculation` | 現行マスターに基づく期待点数、コード、ステータス。 |
| `reviewPolicy` | 要レビューが正解か、確定候補まで期待するか。 |
| `evidence` | マスターコード、点数、根拠、確認者。 |
| `qualityLabel` | `verified`, `needs_office_review`, `unsupported_expected`, `regression_only`。 |

## 重要な設計判断

### LLMの出力を正解にしない

LLMが抽出した病名、検査名、点数は正解として保存しない。正解は次の順で決める。

1. 現行 `standard-master.sqlite` のコード、名称、点数。
2. 現行算定エンジンに明示 `claimContextGold` を入れた結果。
3. 医療事務または診療報酬に詳しい人によるレビュー。

### カルテE2Eは完全一致にしすぎない

自然文抽出は表現揺れが大きいため、カルテE2Eの合格条件は完全一致ではなく、次の形にする。

- 必須候補が含まれる。
- 禁止候補が含まれない。
- 要レビューが必要な項目にレビュー理由が出る。
- 未対応領域を確定扱いしない。

### 点数完全一致は `claimContextGold` で行う

点数を完全一致させるテストは、カルテ本文から直接ではなく、明示的な `claimContextGold` から行う。

カルテ本文から点数まで完全一致させると、初診/再診、施設基準、同月履歴、処方日数など、本文にない情報でテストが不安定になるため。

## 300件データセットの構成

300件はすべて同じ強さのテストにしない。以下の比率で作る。

| 種別 | 件数 | 目的 |
| --- | ---: | --- |
| 算定Gold | 150 | `claimContextGold -> expectedCalculation` の点数・コード完全一致。 |
| カルテE2E | 100 | `chart.text -> expectedExtraction` の抽出品質確認。 |
| 安全/未対応/境界 | 50 | 未対応領域、否定文、過去歴、予定、施設基準不足を安全に要レビューへ落とす。 |

領域別の目安は以下とする。

| 領域 | 件数 | 主な確認 |
| --- | ---: | --- |
| 初診・再診・外来診療料 | 25 | 初診/再診、外来診療料、乳幼児加算、時間外/休日/夜間。 |
| 小児外来 | 25 | 小児科外来診療料、小児抗菌薬適正使用、保護者説明、体重用量。 |
| 検体検査 | 45 | インフル、溶連菌、尿検査、血液、CRP、判断料、採血料、迅速検査加算。 |
| 薬剤・処方 | 35 | 内服、外用、頓服、院外処方、一般名処方、日数/総量不足。 |
| 処置 | 30 | 創傷、熱傷、耳鼻科処置、面積あり/なし、重複。 |
| 画像 | 25 | X線、CT、MRI、電子画像管理、造影、施設基準。 |
| 慢性疾患管理 | 25 | 糖尿病、高血圧、脂質異常、喘息、管理料候補。 |
| 入院・DPC | 25 | 入院基本料、DPCレビュー、入院中の処置混在。 |
| 未対応領域 | 35 | 在宅、リハ、精神科、手術、麻酔、病理。 |
| 異常系・否定文 | 30 | 検査陰性、抗菌薬不要、予定のみ、過去実施、家族説明のみ。 |

## 作成順序

### Phase 1: スキーマ固定と代表ケース作成

まず100件を作成し、データ形式とテスト方法を固める。最初の30件でスキーマを確定し、その後70件を追加して、難易度と領域の幅を広げる。

優先ケース:

1. 小児発熱 + インフル/溶連菌迅速検査。
2. 小児発熱 + 抗菌薬不要 + 小児加算確認。
3. 熱傷処置 + 面積あり + 外用薬。
4. 創傷処置 + 面積不明。
5. 尿検査 + 採血料 + 判断料。
6. 高血圧/糖尿病 + 生活習慣病管理料確認。
7. 院外処方 + 一般名処方加算。
8. CT + 電子画像管理加算。
9. 入院基本料。
10. DPC/手術/在宅/リハなど未対応領域。

この100件で、以下を確認する。

- JSON schemaが実装しやすい。
- マスター根拠を機械的に検証できる。
- 点数GoldとカルテE2Eを分けて評価できる。
- 失敗時に「抽出問題」「算定ロジック問題」「マスター/施設基準問題」「gold label問題」に分類できる。
- exactケースの `totalPoints` と `billingTargets` の合計が一致する。
- exactケースの `claimContextGold` を現行Python算定エンジンに通した結果が `expectedCalculation` と一致する。

### Phase 2: 算定Gold 150件

現行マスターに存在するコードから、明示入力のgoldを増やす。

目的は算定エンジンの退行防止であり、カルテ本文の自然さよりも、点数・コードの根拠を優先する。

### Phase 3: カルテE2E 100件

実際の利用に近いカルテ本文を作り、抽出品質を測る。

この段階では医療事務レビューを入れ、必要ならカルテ本文をより現実的にする。

### Phase 4: 安全/未対応/境界 50件

プロダクト上もっとも危険な過剰算定、誤確定、黙って0点を防ぐ。

## 保存場所

実データは次の配置を想定する。

```text
data/tests/fee-gold/
  README.md
  schema/
    fee-chart-gold.schema.json
  cases/
    seed-300/
      fee-chart-gold-seed-300.json
  generated/
    master-evidence-index.json
    case-index.json
```

`docs/tests` には、目的、設計、作成手順、レビュー基準を置く。  
実際のテストデータは `data/tests` 配下に置き、CIやローカルテストから読み込む。

## 自動テストでの使い方

### 算定Goldテスト

入力:

- `claimContextGold`
- `expectedCalculation`

合格条件:

- `totalPoints` が一致する。
- `candidateCodes` が一致する。
- `engineStatus` が一致する。
- expectedが `needs_review` の場合、実結果も `needs_review` である。

### カルテE2Eテスト

入力:

- `chart.text`
- 患者属性
- encounter情報

合格条件:

- `expectedExtraction.requiredProcedureCandidates` を含む。
- `expectedExtraction.diagnoses` に相当する病名候補を含む。
- `expectedExtraction.requiredReviewTopics` を含む。
- `expectedExtraction.forbiddenCandidates` を含まない。
- 未対応領域を `confirmed` 扱いしない。

### UI/API回帰テスト

代表ケースだけを使い、以下を見る。

- UIで算定候補が表示される。
- 要確認の理由が日本語で表示される。
- 0点のときに理由が表示される。
- レセプト案に候補化済み点数が反映される。

## レビュー基準

各ケースは、次のどれかの状態を持つ。

| 状態 | 意味 |
| --- | --- |
| `draft` | 作成途中。自動テストには使わない。 |
| `master_verified` | マスター根拠は確認済み。医療事務レビュー前。 |
| `office_reviewed` | 医療事務レビュー済み。 |
| `ci_enabled` | CIで常時実行する。 |
| `deprecated` | マスター改定や仕様変更で使わない。 |

## 非ゴール

- 書籍や実患者カルテをそのまま転載しない。
- LLMの出力を正解として固定しない。
- 300件すべてをカルテ本文から点数完全一致させない。
- 未対応領域を無理に点数化しない。
- 医療事務レビュー前のデータを本番品質の正解として扱わない。

## 次の具体ステップ

1. カルテE2Eの必須候補/禁止候補を評価するスクリプトを作成する。
2. Seed 300でpass/failが出る状態にする。
3. 医療事務レビューの観点を追加する。
4. 医療事務レビュー後に `office_reviewed` / `ci_enabled` へ昇格する。

## 初期Seed 300

2026-06-07時点で、初期300ケースを作成した。

- `data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json`
- `data/tests/fee-gold/schema/fee-chart-gold.schema.json`
- 算定Gold: 150件。マスター根拠と明示 `claimContextGold` による点数・候補コード確認向け。
- 抽出/要レビュー: 100件。カルテ本文から候補・確認事項を拾う確認向け。
- 安全/未対応/境界: 50件。未対応領域、否定文、複数日記録などの安全確認向け。

Seed 300は全ケースに `status`、`qualityLabel`、`reviewPolicy`、`evidence` を持たせる。  
`expectedCalculation.assertionLevel = "exact"` のケースは `status = "master_verified"` とし、現行マスターと現行Python算定エンジンで `totalPoints`、`candidateCodes`、`engineStatus` の再現を確認済みとする。  
ただし医療事務レビュー前のため、全ケースで `reviewPolicy.officeReviewed = false`、`reviewPolicy.productionGoldAllowed = false` とし、本番正解データとしては扱わない。

## Seed 300の検証ゲート

同じミスを繰り返さないため、データ追加後は必ず次を通す。

```bash
node scripts/validate_fee_gold_dataset.mjs
node scripts/validate_fee_gold_dataset.mjs --engine
```

検証スクリプトは以下を落とす。

- 300件ちょうどでない。
- 算定Gold 150件、抽出/要レビュー 100件、安全/未対応/境界 50件の構成から外れている。
- `status`、`qualityLabel`、`reviewPolicy`、`evidence` が欠落している。
- `reviewPolicy.calculationAssertion` と `expectedCalculation.assertionLevel` が不一致。
- 医療事務レビュー前なのに `productionGoldAllowed = true` になっている。
- `billingTargets` に対する根拠がない。
- `claimContextGold.encounter.is_outpatient` と `targetBillingFacts.encounter.setting` が不一致。
- `outpatient_basic.fee_kind = initial/revisit` なのに、初診料/再診料/外来診療料の候補がない。
- 小児/乳幼児と書かれたケースの患者年齢が成人になっている。
- 乳幼児加算、小児科外来診療料、小児抗菌薬適正使用支援加算の候補があるのに患者年齢が6歳以上になっている。
- exactケースの `billingTargets` 合計と `expectedCalculation.totalPoints` が不一致。
- 数量行や薬剤行で、`points` を丸め後の行合計として入れている。`points` は単位点数、`totalPoints` は数量・丸め後の行合計とする。
- 薬剤行で `unitAmountYen`、`totalDrugPriceYen`、`rounding` が欠落している。
- exactケースの `candidateCodes` が `billingTargets` と不一致。
- exactケースの現行エンジン再実行結果が `expectedCalculation` と不一致。
