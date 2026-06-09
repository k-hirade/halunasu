# Fee Gold Test Data

診療報酬算定アプリの品質評価に使う、カルテ本文と期待算定結果の 1:1 テストデータです。

## Seed 300

- [cases/seed-300/fee-chart-gold-seed-300.json](./cases/seed-300/fee-chart-gold-seed-300.json)
- [schema/fee-chart-gold.schema.json](./schema/fee-chart-gold.schema.json)

初期データとして300ケースを作成しています。

| 種別 | 件数 | 目的 |
| --- | ---: | --- |
| 算定Gold | 150 | 現行マスターと明示 `claimContextGold` から点数・候補コードを固定するケース。 |
| 抽出/要レビュー | 100 | 候補は拾うべきだが、初再診、施設基準、薬剤日数、面積、履歴などの確認が必要なケース。 |
| 安全/未対応/境界 | 50 | 在宅、リハ、精神科、手術、病理、DPC混在、否定文、複数日など、過剰算定を避けるケース。 |

## テストでの使い分け

- `expectedCalculation.assertionLevel = "exact"`:
  - 算定エンジンの点数・候補コードの完全一致テストに使う。
  - `status = "master_verified"`、`qualityLabel = "verified"` を付ける。
  - 現行マスターと現行Python算定エンジンで再現確認済み。ただし医療事務レビュー前なので `productionGoldAllowed = false` のままにする。
- `candidate_presence` / `review_required`:
  - カルテから拾うべき候補と要レビュー表示のテストに使う。
  - 医療事務レビュー前のため `status = "draft"`、`qualityLabel = "needs_office_review"` とする。
- `unsupported_expected` / `safety` / `split_required`:
  - 未対応領域を確定扱いしないこと、否定文を誤算定しないこと、複数日記録を混ぜないことを確認する。
  - 確定算定の正解ではなく、安全性・退行検知のためのケースとして扱う。

## メタデータ

各ケースには以下を必ず付けます。

- `status`: `draft`, `master_verified`, `office_reviewed`, `ci_enabled`, `deprecated`
- `qualityLabel`: `verified`, `needs_office_review`, `unsupported_expected`, `regression_only`
- `reviewPolicy`: 医療事務レビューの有無、CI利用可否、本番gold利用可否
- `evidence`: コードごとのマスター根拠、確認日、確認方法

Seed 300は医療事務レビュー前のため、全ケースで `reviewPolicy.officeReviewed = false`、`reviewPolicy.productionGoldAllowed = false` です。

## 検証

データ追加時は、以下を必ず通します。

```bash
node scripts/validate_fee_gold_dataset.mjs
node scripts/validate_fee_gold_dataset.mjs --engine
```

前者は必須メタデータ、件数、点数合計、根拠メタデータを検証します。後者は `assertionLevel = "exact"` のケースについて、現行Python算定エンジンに `claimContextGold` を通し、`totalPoints`、`candidateCodes`、`engineStatus` が再現することを確認します。

Seed 300を再生成する場合は、以下を使います。

```bash
node scripts/generate_fee_gold_seed_300.mjs
```

## 点数フィールドの規約

`billingTargets[].points` は単位点数または基礎点数です。数量反映後、または薬剤丸め後の行合計は `billingTargets[].totalPoints` に入れます。

薬剤行では、たとえばゲーベンクリーム1% 5gなら `points = 1.28`、`quantity = 5`、`totalPoints = 6` とします。`points * quantity` は 6.4 になりますが、算定上の行合計は丸め後の `totalPoints = 6` です。exactケースの合計検証では `totalPoints` を優先します。

## 関連ドキュメント

- [診療報酬算定 1:1 Gold Dataset 計画](../../../docs/tests/fee-chart-to-claim-gold-dataset-plan.md)
