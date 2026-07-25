# 診療報酬抽出安定性評価

- 実行日時: 2026-07-25T07:44:59.079Z
- Run ID: fee-stability-20260725074305-bf0f99
- 環境: stg
- Cloud Run revision: fee-api-stg-00180-jtv
- 基線: data/tests/fee-stability/baseline.json (created)
- 反復: 3回/ケース（毎回、新規の合成患者・新規セッション）

## 判定

- 全ケースの確定点数分散0: 合格
- 候補Jaccard基線: 合格
- 同一revisionでの計測: 合格
- 総合: pass

| ケース | 判定 | 確定点数 | 分散 | 候補Jaccard最小 | 基線 | イベント数 | 最大差 |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| management-heavy-continuation | pass | 293 / 293 / 293 | 0 | 100% | 100% | 6 / 7 / 7 | 1 |
| suction-management-continuation-home | pass | 969 / 969 / 969 | 0 | 100% | 100% | 1 / 2 / 3 | 2 |
| suction-management-continuation-plan | pass | 293 / 293 / 293 | 0 | 100% | 100% | 4 / 5 / 5 | 1 |

## 帰属

各反復は患者履歴と抽出メモを共有しません。候補集合・イベント数の差は全文抽出経路の非決定性として記録し、確定点数に波及しないことを必須条件とします。イベント数自体は正解を意味しないため、単独では合否に使いません。

## 不合格

なし。

確定明細、候補集合、レビュー事項、抽出メトリクスは [result.json](./result.json) に保存しています。
