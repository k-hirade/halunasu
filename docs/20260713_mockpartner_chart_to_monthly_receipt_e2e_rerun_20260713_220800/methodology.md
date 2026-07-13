# 測定方法

## 目的

患者1001、1006、1013について、確定コード付きordersを使わず、カルテ本文から通常のSTG算定経路を通して算定候補を作り、患者×月へ集計し、既存UKEと比較する。新revisionの確定明細精度、候補検知、安定性、パフォーマンスを直前の再走と比較する。

## 入力

入力元:

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId>/`

| ファイル | 用途 |
| --- | --- |
| `patients.csv` | 患者ID、性別、生年月日 |
| `charts.jsonl` | 2026年6月のカルテ本文 |
| `RECEIPTC.UKE` | 算定処理後にだけ使用する比較対象 |
| `manifest.json` | 請求月とファイル対応 |

算定入力へ渡していないもの:

- `orders.csv`
- UKEのコード・回数・点数
- `expectedClaimContext`
- テスト専用の`calculationOptions`

各raw結果の`inputAudit.prohibitedCalculationInputs`と`calculationPayloadKeys`でも、この条件を記録した。結果Docsには患者氏名とカルテ本文を保存せず、カルテ本文はSHA-256だけを保存した。

## 実行経路

1. STG組織`nishiyama-demo-stg`へログインする。
2. 反復ごとに新しい合成患者を作る。
3. カルテ1件につき1つの算定セッションを作る。
4. 空の算定body`{}`で通常のOpenAI抽出・算定処理を実行する。
5. セッション詳細から確定明細、レビュー候補、確認事項を取得する。
6. 患者×`2026-06`の月次レセプト案を取得する。
7. 月次レスポンスの`candidateLines`から、月内集約済みレビュー候補を取得する。
8. 算定終了後にUKEを解析する。
9. 確定月次明細とUKEを比較する。
10. コード付き月次候補とUKEを別に比較し、候補検知率を算出する。
11. 同じ患者を独立した新規患者として3回反復する。

## 実行コマンド

患者IDを1001、1006、1013に置き換えて、それぞれ実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId> \
  --repeat 3 \
  --output-dir docs/20260713_mockpartner_chart_to_monthly_receipt_e2e_rerun_20260713_220800/<patientId>/raw
```

評価スクリプトはSTGホストと末尾が`-stg`の組織だけを許可する。PRODには接続できない。

## 指標の定義

### 確定明細一致

自動採用済みの月次明細と既存UKEで、コードと算定回数が同じ場合だけを一致とする。レビュー候補は含めない。

### 候補検知一致

月次`candidateLines`のうちコードが確定している候補と既存UKEを比較する。コードが`null`の候補は、名称や点数が似ていても一致に数えない。

今回、1013の文書料2件は候補検知一致である。1006のがん性疼痛緩和指導管理料は名称と200点が得られたがコードが`null`のため、候補検知一致ではない。

### 月次候補点数

レビュー候補の`totalPoints`合計である。算定要件と実施事実の確認前であり、確定点数、増収額、逸失収益として扱わない。

### 月内重複抑制

`occurrenceCount`は受診単位で発生した候補数、`suppressedOccurrenceCount`は患者×月で1件へ集約する際に抑制した件数である。

## 性能指標

- 算定API: Node.jsの`fetch`開始からレスポンス本文読込完了まで
- カルテ構造化: APIが保存した`clinicalStructuringMs`
- OpenAI provider: APIが保存した`openAiProviderMs`
- 月次集計APIと差分診断API: 各`fetch`の応答時間

STG revisionは実行前後にCloud Runの`latestReadyRevisionName`とtrafficを取得した。今回のAPI revisionは`fee-api-stg-00155-kf4`で、両時点ともtrafficは100%だった。

## フォールバック調査

1006の反復1・受診1はraw結果で`source=rules_fallback`だった。該当時刻のCloud Run構造化ログを確認し、`clinicalStructuring.fallbackReason`からOpenAI構造化JSONのパース失敗と特定した。HTTPリクエストは201で完了しており、API障害ではなく精度を落として継続したフォールバックである。

## 制約

1. mock HOMIS由来の合成患者3人だけを対象としている。
2. 評価スクリプトはセッションの診療区分を`outpatient`に固定しており、訪問診療・往診の正しい精度試験ではない。
3. 評価施設の施設基準キーは0件である。
4. 外部請求履歴や実際の患者履歴を入力していない。
5. レビュー候補は人が採用していないため、確定月次点数には反映されない。
6. STGに作成した合成患者・セッションは削除していない。
7. レイテンシはCloud Run負荷、OpenAI応答、Firestore状態を個別に統制していない。
