# 測定方法

## 対象と目的

- 対象患者: 1001、1004、1006、1007、1012
- 反復数: 各患者3回
- 受診数: 1反復あたり合計15受診
- 算定回数: 45
- 請求月: 2026-06
- 目的: 改革1〜3適用後の確定点数、候補検知、抽出安定性、レイテンシを直前測定と比較する

対象は、確定点数の揺れ、イベント抽出の揺れ、医学管理候補、在宅酸素のコード曖昧性を確認できる患者から選定した。

## 入力

入力元:

`tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId>/`

算定に使用したファイル:

- `patients.csv`: 性別・生年月日
- `charts.jsonl`: 2026年6月のカルテ本文

算定終了後の比較だけに使用したファイル:

- `RECEIPTC.UKE`: 既存レセプト
- `manifest.json`: 請求月とファイル対応

`orders.csv`、UKE内のコード、`expectedClaimContext`、テスト専用`calculationOptions`は算定APIへ渡していない。

## 実行経路

1. STG組織`nishiyama-demo-stg`へログインする。
2. 反復ごとに新しい合成患者を作成する。
3. カルテ1件につき1算定セッションを作成する。
4. 空body`{}`で通常のOpenAI抽出・算定処理を実行する。
5. セッション詳細から確定明細、候補、確認事項、処理時間を取得する。
6. 患者 x `2026-06`の月次レセプト案を取得する。
7. 算定終了後にUKEを解析し、確定明細と候補を比較する。
8. 同じ患者を独立した新規患者として3回反復する。

## 実行コマンド

患者IDを対象5患者へ置き換え、性能干渉を避けるため逐次実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId> \
  --repeat 3 \
  --output-dir docs/20260715_mockpartner_reforms123_stg_remeasurement_20260715_194856/<patientId>/raw
```

## 実行条件

| 項目 | 値 |
| --- | --- |
| 実行日時 | 2026-07-15 19:50〜20:02 JST |
| fee-api | `https://fee-api-stg-wmfrwcpzkq-an.a.run.app` |
| 組織 | `nishiyama-demo-stg` |
| prompt | `fee-clinical-events-v14` |
| rules | `fee-clinical-rules-v10` |
| model | `gpt-5.4-nano` |
| master | `runtime-master-current` / source version `2026-06-15` |
| main commit | `9879656`（改革実装`fd4f13a`を含む） |
| 施設基準キー | 0件 |
| 既知受診歴seed | なし |
| 診療区分 | `outpatient`固定 |

実行前に`/readyz`がHTTP 200で、環境`stg`、project`halunasu-fee-stg`、マスタDB readyであることを確認した。`gcloud`のローカル認証期限切れによりCloud Run revision名は取得できなかったため、revision名による実行中の切替確認は行っていない。

## 指標

- **確定一致**: 月次確定明細と既存UKEでコード・回数・点数が一致するもの。
- **候補込み検知**: 確定一致に加え、候補コードまたは`codeCandidates`に既存UKEコードを含むもの。
- **確定安定性**: 3反復の月次確定明細が同一であること。
- **候補安定性**: 3反復の`candidateLines`および候補点数が同一であること。
- **抽出安定性**: 同じカルテの臨床イベント数と確認事項集合が3反復で一致すること。

## セキュリティ

- 結果Docsに患者氏名とカルテ本文を保存しない。
- カルテ本文はSHA-256のみをrawへ保存する。
- 認証情報、Cookie、CSRF tokenは保存しない。
- UKEは算定終了後にのみ比較処理へ渡す。
