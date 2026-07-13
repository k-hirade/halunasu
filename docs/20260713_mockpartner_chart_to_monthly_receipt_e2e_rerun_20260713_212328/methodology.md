# 測定方法

## 目的

患者1001、1006、1013について、確定コード付きordersを使わず、カルテ本文から通常のSTG算定経路を通して算定候補を作り、患者×月へ集計し、既存UKEと比較する。新規デプロイ後の精度、安定性、パフォーマンスを直前の再走と比較する。

## 入力

入力元:

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId>/`

| ファイル | 用途 |
| --- | --- |
| `patients.csv` | 患者ID、性別、生年月日 |
| `charts.jsonl` | 2026年6月のカルテ本文 |
| `RECEIPTC.UKE` | 算定処理が終わった後にだけ使用する比較対象 |
| `manifest.json` | 請求月とファイル対応 |

算定入力へ渡していないもの:

- `orders.csv`
- UKEのコード・回数・点数
- `expectedClaimContext`
- テスト専用の`calculationOptions`

各raw結果の`inputAudit.prohibitedCalculationInputs`と`calculationPayloadKeys`でも、これらを算定へ渡していないことを記録した。結果Docsには患者氏名とカルテ本文を保存せず、カルテ本文はSHA-256だけを保存した。

## 実行経路

1. STG組織`nishiyama-demo-stg`へログインする。
2. 反復ごとに新しい合成患者を作る。
3. カルテ1件につき1つの算定セッションを作る。
4. 空の算定body`{}`で通常のOpenAI抽出・算定処理を実行する。
5. セッション詳細から採用済み明細、レビュー候補、確認事項を取得する。
6. 患者×`2026-06`の月次レセプト案を取得する。
7. 算定終了後にUKEを解析する。
8. 月次明細とUKEを差分診断APIおよび評価スクリプトで比較する。
9. 同じ患者を独立した新規患者として3回反復する。

## 実行コマンド

患者IDを1001、1006、1013に置き換えて、それぞれ実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId> \
  --repeat 3 \
  --output-dir docs/20260713_mockpartner_chart_to_monthly_receipt_e2e_rerun_20260713_212328/<patientId>/raw
```

評価スクリプトはSTGホストと末尾が`-stg`の組織だけを許可する。PRODには接続できない。

## 評価指標

- 確定月次明細と既存UKEのコード一致
- コードごとの算定回数と点数
- 患者月合計点数
- 3反復の月次明細安定性
- 3反復のレビュー候補・確認事項安定性
- カルテ抽出イベント数
- 前回は拾えなかった期待コードがレビュー候補に現れたか

既存UKEは比較対象であり、医学的・請求上の絶対的な正解を保証するものではない。また、カルテにない施設基準や訪問区分を推測してUKEへ合わせることはしない。

## 一致の定義

`一致`は、自動採用済みの月次明細と既存UKEで、コードと算定回数が同じ場合だけを指す。レビュー候補は月次明細へ未採用のため、一致には含めない。

このため、患者1013の傷病手当金意見書交付料と療養費同意書交付料は「候補検知成功」だが「確定明細一致」ではない。今後は次の2指標を分ける必要がある。

1. 確定明細一致率: 採用済み月次明細と既存UKEの一致
2. 候補検知率: 採用済み明細またはレビュー候補として期待コードを検知できた割合

## 性能指標

- 算定API: Node.jsの`fetch`開始からレスポンス本文読込完了まで
- カルテ構造化: APIが保存した`clinicalStructuringMs`
- OpenAI provider: APIが保存した`openAiProviderMs`
- 月次集計APIと差分診断API: 各`fetch`の応答時間

STG revisionは実行後にCloud Runの`latestReadyRevisionName`とtrafficを取得した。今回のAPI revisionは`fee-api-stg-00154-788`で、確認時点のtrafficは100%だった。

## 制約

1. mock HOMIS由来の合成患者3人だけを対象としている。
2. 評価スクリプトは現状、セッションの診療区分を`outpatient`に固定している。訪問診療・往診の正しい精度試験にはなっていない。
3. 評価施設の施設基準キーは0件である。
4. 外部請求履歴や実際の患者履歴を入力していない。
5. レビュー候補は人が採用していないため、月次レセプト案には反映されない。
6. STGに作成した合成患者・セッションは削除していない。
7. レイテンシはCloud Run負荷、OpenAI応答、Firestore状態を個別に統制していない。
