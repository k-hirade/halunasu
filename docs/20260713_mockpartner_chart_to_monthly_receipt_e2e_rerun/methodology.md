# 測定方法

## 目的

患者1001、1006、1013について、確定コード付きordersを使わず、カルテ本文から通常のSTG算定経路を通して算定候補を作り、患者×月へ集計し、既存UKEと比較する。

## 入力

入力元:

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId>/`

| ファイル | 用途 |
| --- | --- |
| `patients.csv` | 患者ID、性別、生年月日 |
| `charts.jsonl` | 2026年6月のカルテ本文 |
| `RECEIPTC.UKE` | 算定後にだけ使用する比較対象 |
| `manifest.json` | 請求月とファイル対応 |

算定入力へ渡していないもの:

- `orders.csv`
- UKEのコード・回数・点数
- `expectedClaimContext`
- テスト専用の`calculationOptions`

結果Docsには患者氏名とカルテ本文を保存せず、カルテ本文はSHA-256だけをraw結果に記録した。

## 実行経路

1. STG組織`nishiyama-demo-stg`へログインする。
2. 反復ごとに新しい合成患者を作る。
3. カルテ1件につき1つの算定セッションを作る。
4. 空の算定body`{}`で通常のOpenAI抽出・算定処理を実行する。
5. セッション詳細から算定明細、確認候補、確認事項を取得する。
6. 患者×`2026-06`の月次レセプト案を取得する。
7. 算定終了後にUKEを解析する。
8. 月次明細とUKEを差分診断APIおよび評価スクリプトで比較する。
9. 同じ患者を独立した新規患者として3回反復する。

## 実行コマンド

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId> \
  --repeat 3 \
  --output-dir docs/20260713_mockpartner_chart_to_monthly_receipt_e2e_rerun/<patientId>/raw
```

評価スクリプトはSTGホストと末尾が`-stg`の組織だけを許可する。PRODには接続できない。

## 品質指標

- コードの一致
- コードごとの算定回数と点数
- 患者月合計点数
- 3反復の月次明細安定性
- 3反復の確認候補・確認事項安定性
- カルテ抽出イベント数

既存UKEは比較対象であり、医学的・請求上の絶対的な正解を保証するものではない。また、カルテにない施設基準や訪問区分を推測してUKEへ合わせることはしない。

## 性能指標

- 算定API: Node.jsの`fetch`開始からレスポンス本文読込完了まで
- カルテ構造化: APIが保存した`clinicalStructuringMs`
- OpenAI provider: APIが保存した`openAiProviderMs`
- 月次集計APIと差分診断API: 各`fetch`の応答時間

STG revisionは実行後にCloud Runの`latestReadyRevisionName`から取得した。今回のAPI revisionは`fee-api-stg-00152-nsc`である。

## 制約

1. mock HOMIS由来の合成患者3人だけを対象としている。
2. セッションの診療区分は現行契約の`outpatient`を使用しており、訪問診療・往診を表現できない。
3. 評価施設の施設基準キーは0件である。
4. 外部請求履歴や実際の患者履歴を入力していない。
5. STGに作成した合成患者・セッションは削除していない。
6. レイテンシはCloud Run負荷、OpenAI応答、Firestore状態を個別に統制していない。

