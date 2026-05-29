# Step7 評価データセット

2026-05-18時点のStep7は、実CSVと確定レセプト由来の正解ラベルを同じpipelineで評価し、差分を分類して改善backlog/action planへ戻す入口として完了した。PHIを含む実CSVはリポジトリ外で管理するため、リポジトリ内には非PHIのgoldサンプルだけを置く。

## 実装済み

- CSVのgold列mapping
  - `expected_total_points`
  - `expected_status`
  - `expected_candidate_codes`
- 日本語presetのgold列
  - `正解点数` / `期待点数` / `確定点数` / `請求点数` / `合計点数`
  - `正解ステータス` / `期待ステータス` / `確定ステータス`
  - `正解コード` / `期待コード` / `確定コード` / `請求コード`
- gold評価CLI
  - `evaluate-gold-claim-batch`
  - `evaluate-gold-inpatient-claim-batch`
  - 互換alias `evaluate-gold-outpatient-lab-claim-batch`
- gold差分分類
  - `gold-classification`
  - `gold-backlog`
  - `gold-action-plan`
- batch summaryの横断集計
  - `gold_mismatch_count`
  - `gold_classification_action_count`
  - `gold_high_priority_classification_count`
  - `gold_top_classification`
  - `gold_top_feedback_target`
- `review-index` の `gold_mismatch` 成果物リンク
- `expected.status=needs_review` の扱い
  - DPCのように「現時点ではレビューが正解」のレコードを `match` として評価できる。

## 非PHIサンプル

| manifest | 目的 | 期待結果 |
| --- | --- | --- |
| `contracts/order-csv/manifest.example.json` | 外来gold happy path | gold mismatch 0 |
| `contracts/order-csv/manifest.backlog.example.json` | 必須コメント不足の改善backlog | `required_comment_input` |
| `contracts/order-csv/manifest.step7.example.json` | 外来gold + 入院gold + DPC期待review | gold mismatch 0 |
| `contracts/order-csv/manifest.step7-backlog.example.json` | 外来コメント不足 + 入院施設基準不足 | `required_comment_input` と `inpatient_input` |

追加した入院goldサンプル。

| CSV | 内容 |
| --- | --- |
| `data/work/example-orders/tohoku-0410001/inpatient-gold-orders.csv` | 入院基本料OK 1件、DPC期待review 1件 |
| `data/work/example-orders/tohoku-0410001/inpatient-gold-backlog-orders.csv` | 入院基本料の施設基準入力不足 1件 |

入院gold用contract。

```text
contracts/order-csv/tohoku/0410001/inpatient-gold-contract.json
```

## 実行例

通常のStep7サンプル。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.step7.example.json \
  --format markdown
```

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.step7.example.json \
  --output-root data/work/order-csv-step7-example \
  --output data/work/order-csv-step7-example/summary.md \
  --review-index-output data/work/order-csv-step7-example/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch
```

確認済み結果。

```text
Entries: 2
Gold mismatches: 0
Gold classification actions: 0
Gold Classification Counts: match 3
```

DPC期待reviewが1件あるため、batch上は `batch_review` が残る。これはDPCを自動算定しないStep6/Step7の意図した動作であり、gold評価上は `expected.status=needs_review` によりmatchになる。

改善backlogサンプル。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.step7-backlog.example.json \
  --output-root data/work/order-csv-step7-backlog-example \
  --output data/work/order-csv-step7-backlog-example/summary.md \
  --review-index-output data/work/order-csv-step7-backlog-example/review-index.md
```

確認済み結果。

```text
Gold mismatches: 2
Gold classification actions: 2
Gold high priority classifications: 2
Classification: required_comment_input 1, inpatient_input 1
```

`gold-action-plan.md` は、必須コメント不足を `hospital_contract`、入院施設基準不足を `triage_input_vs_logic` へ割り当てる。

## 実病院データでの手順

1. 実CSVに正解列を追加する。
   - 確定レセプトの合計点数は `正解点数`。
   - 確定請求コードは `正解コード`。
   - 正常確定なら `正解ステータス=ok`。
   - DPCなど現時点でレビューに止めるべきものは `正解ステータス=needs_review`。
2. `profile-order-csv-columns` でgold列が認識されるか確認する。
3. gold必須の病院別contractを作る。
4. `validate-order-csv-pipeline-manifest` で全entryを事前検証する。
5. `run-order-csv-claim-pipeline-batch` を実行する。
6. `summary.md` で分類件数を見て、`review-index.md` から該当成果物へ進む。
7. `gold-action-plan.md` を入力contract、施設基準/マスター、算定ロジック、gold label確認の作業票へ戻す。

## 完了条件

- 非PHIの通常Step7 manifestが `Ready: yes`。
- 通常Step7 manifestで `Gold mismatches: 0`。
- 非PHIのbacklog manifestが `Ready: yes`。
- backlog manifestで複数分類の `gold-action-plan` が生成される。
- 外来、入院基本料、DPC期待reviewが同じ評価入口で扱える。
