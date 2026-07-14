# 測定方法

## 目的

患者1001、1006、1013について、確定コード付きordersを使わず、カルテ本文から通常のSTG算定経路を通して算定候補を作り、患者 x 月へ集計し、既存UKEと比較する。新revisionの確定明細精度、候補検知、安定性、パフォーマンスを直前の再走と比較する。

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

各raw結果の`inputAudit`と`security`にもこの条件を記録した。結果Docsには患者氏名とカルテ本文を保存せず、カルテ本文はSHA-256だけを保存した。

## 実行経路

1. STG組織`nishiyama-demo-stg`へログインする。
2. 反復ごとに新しい合成患者を作る。
3. カルテ1件につき1つの算定セッションを作る。
4. 空の算定body`{}`で通常のOpenAI抽出・算定処理を実行する。
5. セッション詳細から確定明細、レビュー候補、確認事項を取得する。
6. 患者 x `2026-06`の月次レセプト案を取得する。
7. 月次レスポンスの`candidateLines`から月内集約済みレビュー候補を取得する。
8. 算定終了後にUKEを解析する。
9. 確定月次明細とUKEを比較する。
10. コード付き候補およびコード候補集合をUKEへ一対一で照合し、候補検知率を算出する。
11. 同じ患者を独立した新規患者として3回反復する。

## 実行コマンド

患者IDを1001、1006、1013に置き換えて、それぞれ逐次実行した。

```bash
npm run eval:fee-monthly-chart-e2e -- \
  --patient-dir tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff/patient_sources/<patientId> \
  --repeat 3 \
  --output-dir docs/20260714_mockpartner_chart_to_monthly_receipt_e2e_rerun_20260714_204059/<patientId>/raw
```

評価スクリプトはSTGホストと末尾が`-stg`の組織だけを許可し、PRODには接続できない。性能比較の干渉を避けるため、3患者は並列実行していない。

実行前後にCloud Runを確認し、どちらも`fee-api-stg-00157-mw2`がReadyかつ100% trafficだった。実行途中のrevision切替はない。

## 指標

- **確定一致**: 自動採用済み月次明細と既存UKEで、コード・回数・点数が一致するもの。
- **候補検知一致**: 月次レビュー候補と既存UKEが一致するもの。曖昧な`codeCandidates`は1候補を最大1コードへだけ割り当てる。
- **月次候補点数**: 確認後に採用できる可能性がある候補の合計。確定点数や逸失収益ではない。
- **抽出安定性**: 同じカルテを3回処理した際の臨床イベント数、候補集合、確認事項数の変動。

## 性能指標

- 算定API: Node.jsの`fetch`開始からレスポンス本文読込完了まで。
- カルテ構造化・OpenAI provider: APIが保存したステージ計測値。
- 月次集計API・差分診断API: 各`fetch`の応答時間。

直前比較は`docs/20260713_mockpartner_chart_to_monthly_receipt_e2e_rerun_20260713_220800/`のraw結果を同じ集計方法で再集計した。

## 制約

1. mock HOMIS由来の合成患者3人だけを対象としている。
2. 前回との比較条件を維持するため、全セッションの診療区分は`outpatient`である。
3. 施設基準キーは0件である。
4. 外部請求履歴や実際の患者履歴を入力していない。
5. レビュー候補は人が採用していないため、確定月次点数には反映されない。
6. STGに作成した合成患者・セッションは削除していない。
7. レイテンシはCloud Run負荷、OpenAI応答、Firestore状態を個別に統制していない。
8. UKEはmock HOMISから安全に確定できた行だけであり、現実の完全な月次レセプトを保証するものではない。
