# 測定方法

## 対象

- リポジトリcommit: `f636754`
- Cloud Run: `halunasu-fee-stg / fee-api-stg`
- 修正前リビジョン: `fee-api-stg-00150-6rp`
- 修正後リビジョン: `fee-api-stg-00151-mm6`
- 修正前Run: `mockpartner-20260713020527479`
- 修正後Run: `mockpartner-20260713023517795`
- API: `POST /v1/fee/recalculation-diff-diagnosis`
- 組織: `nishiyama-demo-stg`
- 請求月: `2025-01`
- 実行方式: Cloud Run URLへ直接、逐次実行

認証情報、Cookie、CSRFトークンは保存していない。入力はmock HOMIS由来の合成データである。

## データ

各患者について次の患者別ZIPを使用した。

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_zips/`

ZIPには `manifest.json`、`RECEIPTC.UKE`、`patients.csv`、`charts.jsonl`、`orders.csv`、`diagnoses.csv`、`facility.json`、`receipt.csv`、`unknowns.csv` が含まれる。

## 実行回数

患者ごとに以下を実行した。

1. ウォームアップ1回
2. 計測3回

同じ条件で修正前後に各12リクエスト、合計24リクエストを実行した。全リクエストに一意な `evalRunId` を付け、Cloud Run request logと対応付けた。各Runの最初の1001は初回初期化として集計から除外した。修正前はCloud Run起動ログを確認できたが、修正後の13秒は起動ログがなく内訳を分離できない。1006と1013のウォームアップ時はサービスが処理可能な状態だった。

## 品質指標

- UKE取込レセ件数・明細コード数
- 再算定payload数
- 当社エンジン出力コード数
- 一致、既存のみ、当社のみ、数量・点数差、再現失敗
- 在宅未対応と一般エンジンギャップ
- `unknowns.csv`の理由別件数
- 同一入力3回のレスポンス一致性

既存レセを正解とは断定しないため、precision/recallや正解率とは表現せず、一致度・再現性として扱う。

## 時間指標

- クライアント時間: Node.jsの `fetch` 開始からレスポンス本文の読込完了まで
- Cloud Run時間: request logの `httpRequest.latency`
- ウォーム後の最小、中央値、平均、p95、最大
- 初回リクエスト時間

内部ステージ別時間は対象ルートでログ出力されていなかったため、今回は測定不能。

## 重要な制約

1. 修正前は `chartRecordCount=0`、修正後はファイル内の全8件を取り込めた。
2. `diagnoses.csv`は生成方針上ヘッダーのみで、診療日単位の病名はない。
3. 薬剤は標準コードと構造化数量がなく、ordersへ変換されていない。
4. 再算定差分診断APIは通常セッションのOpenAI抽出を通らない。
5. 3患者・9計測の逐次試験であり、負荷試験ではない。
