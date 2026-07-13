# 測定方法

## 目的

日付補正済みmock HOMIS患者ZIPをSTGへ投入し、前回の再現失敗15件が入力日付とマスタ有効期間の不整合に起因していたかを確認する。

## 入力

使用した患者別ZIPは次のディレクトリにある。

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_zips/`

| 患者 | ZIP SHA-256 |
| --- | --- |
| 1001 | `12f7db688ef322257ef822881ee51aa8735d2e14104e8bed0aea3581108c546c` |
| 1006 | `7cde114d595775e8ea7d534ef08e4f9f3832087abe392b3dbcb45bb741bb316e` |
| 1013 | `5c5826b2061fdf6e5a901a2901209f0ab3e2c14f201574b47608474e8006b274` |

各ZIPの `manifest.json` は `claimMonth: 2026-06`、`previousMonth: 2026-05`。APIリクエストのフォールバック請求月も `2026-06` とした。認証情報、Cookie、CSRFトークンは保存していない。入力はmock HOMIS由来の合成データである。

## 実行条件

- Run ID: `mockpartner-20260713042657201`
- STG revision: `fee-api-stg-00151-mm6`
- API: `POST /v1/fee/recalculation-diff-diagnosis`
- 実行方式: Cloud Run URLへ直接、患者順に逐次実行
- 反復: 患者ごとにウォームアップ1回、計測3回
- タイムアウト: 180秒
- 全リクエストに一意な `evalRunId` を付与

HTTP応答時間はNode.jsの `fetch` 開始からレスポンス本文の読込完了までを計測した。Cloud Run時間は同じ `evalRunId` を持つrequest logの `httpRequest.latency` と突合した。

## 品質判定

患者・請求月・診療行為コード単位で次を比較した。

1. 既存レセと当社再算定のコード
2. コードごとの算定回数
3. コードごとの月合計点数
4. 患者ごとの月合計点数
5. 既存のみ、当社のみ、双方の数量・点数差、再現失敗

3回の計測応答について同じ比較結果が返ることも確認した。

## 性能集計

初回の1001ウォームアップはCloud Runのインスタンス起動を含むため、定常統計から除外した。1006と1013のウォームアップも統計から除外し、各患者の計測3回、合計9件を対象に最小、中央値、平均、p95、最大を算出した。p95はnearest-rank方式のため、9件では最大値と同じになる。

## 制約

1. 合成データ3患者の試験であり、負荷試験ではない。
2. ordersには確定済み診療行為コードと点数が含まれる。
3. このAPIは通常セッションのOpenAI臨床抽出を通らない。
4. `diagnoses.csv`はヘッダーのみで、病名適応の精度試験ではない。
5. 一致は既存レセの再現性を示し、医学的妥当性や最終請求の正当性を保証しない。
6. 応答内の `engineCoverageDecision.homeCare` は静的に `not_enabled` を返すが、今回の在宅コードはすべて一致した。この診断文は品質判定には使用していない。
