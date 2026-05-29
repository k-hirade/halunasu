# Order CSV Intake Checklist

実病院のオーダーCSVを受け入れるときの標準手順。目的は、病院別CSV仕様の差分を `contract` として固定し、変換前に列欠落や仕様変更を止め、`profile -> contract validation -> conversion -> claim batch -> audit -> gold evaluation` を再現可能にすること。

## 前提

- 実CSV、確定レセプト由来のgold列、病院名、地方厚生局、医療機関コード、対象診療日範囲を確認する。
- PHIを含むCSVはリポジトリに置かない。`data/work/` 配下など、運用で許可された作業領域に置く。
- gold評価を行う場合は、確定点数/請求点数と確定コード/請求コードの列を確認する。
- `data/work/standard-master.sqlite` と全国 `claim_context_template` JSONLが最新のマスター版で作られていることを確認する。

## 1. Profile

CSVを変換せず、まず列mappingを確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli profile-order-csv-columns \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --format markdown \
  --output <orders-column-profile.md>
```

確認する項目。

- `record_id` または `patient_id + service_date + regional_bureau + medical_institution_code` が揃っている。
- `item_kind` とコード列が揃っている。
- gold評価をする場合、`expected_total_points`、`expected_status`、`expected_candidate_codes` 相当の列がある。
- `unmapped_columns` に、算定に必要な列が残っていない。
- `item_kind` の値mapping例が、`procedure`、`medication_order`、`injection_order`、`treatment`、`imaging`、`inpatient_basic`、`dpc`、`comment`、`expected` など期待どおりになっている。

## 2. Generate Contract

profileが妥当なら、病院別contractの雛形を作る。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli generate-order-csv-contract-template \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --contract-id <regional_bureau>-<medical_institution_code>-orders-v1 \
  --hospital-name <hospital-name> \
  --regional-bureau <regional_bureau> \
  --medical-institution-code <medical_institution_code> \
  --output contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json
```

## 3. Review Contract

生成された `order-contract.json` を確定前にレビューする。

| 項目 | 確認内容 |
| --- | --- |
| `required_target_fields` | 変換後に必ず必要な標準列。外来実オーダーでは患者/診療日/医療機関キー、`item_kind`、コード列を固定する。 |
| `required_source_columns` | 病院CSVの元列名。レセコン/EHRの出力仕様変更を検知したい列だけを残す。 |
| `allowed_unmapped_columns` | 計算に使わない列だけを入れる。必要な列が入っていたらcolumn mapへ移す。 |
| `require_gold_labels` | 確定レセプト/gold評価用CSVなら `true`、概算算定だけなら `false`。 |
| `minimum_row_count` | サンプルは低め、本番定期処理は期待件数に合わせて高めにする。 |
| `column_map_preset` / `encoding` | 病院ごとに固定する。文字化けが出る場合は `encoding` を見直す。 |

## 4. Validate

レビュー済みcontractでCSVを検証する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv <orders.csv> \
  --contract contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json \
  --output <orders-contract-validation.md> \
  --fail-on-error
```

ここで失敗する場合は、変換へ進まない。contractかcolumn mapを修正して再実行する。

## 5. Single Pipeline

1病院分を単体で通す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --contract contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --profile-output <profile.md> \
  --contract-output <contract-validation.md> \
  --converted-output <converted.jsonl> \
  --conversion-report-output <conversion.md> \
  --output <claim-results.md> \
  --audit-output <claim-audit.csv> \
  --gold-output <gold-evaluation.md> \
  --gold-classification-output <gold-classification.md> \
  --gold-backlog-output <gold-backlog.md> \
  --gold-action-plan-output <gold-action-plan.md> \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch
```

CSV変換と外来batchだけを直接実行する場合は、Step4以降は外来全体名のaliasを使う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-outpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --converted-output <converted.jsonl> \
  --conversion-report-output <conversion.md> \
  --output <claim-results.md> \
  --audit-output <claim-audit.csv>
```

JSONL変換後に外来batchだけを実行する場合は `run-outpatient-claim-batch` を使う。旧 `run-outpatient-lab-claim-batch` / `run-order-csv-outpatient-lab-batch` は互換用aliasとして残す。

入院/DPCを直接実行する場合は、Step6用aliasを使う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-inpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --converted-output <converted.jsonl> \
  --conversion-report-output <conversion.md> \
  --output <claim-results.md> \
  --audit-output <claim-audit.csv>
```

合格基準。

- contract validationがpass。
- conversion warningが0、または理由を説明できる。
- batch errorが0。
- `needs_review` はreview対象として許容できる範囲。
- gold評価をする場合、`gold_mismatch_count` が0、または差分理由を説明できる。
- gold差分がある場合、`gold-classification.md` の `feedback_target` と `recommended_action` に従って、算定ロジック、入力contract、施設基準/マスター、gold label確認へ戻す。
- 実装順は `gold-backlog.md` を優先して見る。`priority=high`、件数が多い項目、複数病院で出る項目の順に改善へ回す。
- 実装修正単位は `gold-action-plan.md` の `owner`、`implementation_step`、`acceptance_gate` を使ってissue化する。

## 6. Batch Manifest

複数病院分は `contracts/order-csv/manifest.example.json` と同じ形式でmanifestを作る。

```json
{
  "entries": [
    {
      "id": "tohoku-0410001",
      "csv": "../../data/work/example-orders/tohoku-0410001/orders.csv",
      "contract": "tohoku/0410001/order-contract.json",
      "template_jsonl": "../../data/work/nationwide-claim-contexts-2026-06-01.jsonl",
      "evaluate_gold": true
    }
  ]
}
```

manifestを作ったら、batch実行前に全entryのCSV、contract、template、gold label、contract validationを検証する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.example.json \
  --output data/work/order-csv-pipeline/manifest-validation.md \
  --fail-on-error
```

`Ready: yes` ならStep1の入力準備は完了している。`Ready: no` の場合は、CSV/contract/templateの欠落、contract不一致、gold label不足を直してからbatchへ進む。templateを必須にする運用では `--require-template-jsonl`、gold labelを必須にする運用では `--require-gold-labels` を付ける。

## 7. Batch Run

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.example.json \
  --output-root data/work/order-csv-pipeline \
  --output data/work/order-csv-pipeline/summary.md \
  --summary-format markdown \
  --review-index-output data/work/order-csv-pipeline/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch \
  --fail-on-batch-error
```

横断集計用にはCSV/TSV summaryも出す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.example.json \
  --output-root data/work/order-csv-pipeline \
  --summary-format csv \
  --output data/work/order-csv-pipeline/summary.csv \
  --review-index-output data/work/order-csv-pipeline/review-index.md
```

batch summaryは、entry別の `gold_classification_action_count`、`gold_high_priority_classification_count`、`gold_top_classification`、`gold_top_feedback_target` を出す。Markdown summaryでは全entry横断の `Gold Classification Counts` と `Gold Feedback Target Counts` を確認し、件数が多い分類からロジック改善へ戻す。

## 8. Review Index

`review-index.md` は `attention_reasons` 別に見るべき成果物を束ねる。

| 理由 | 最初に見る成果物 |
| --- | --- |
| `contract_failed` | `contract-validation.*`、`profile.*` |
| `conversion_warning` | `conversion.md`、`converted.jsonl` |
| `batch_error` | `claim-results.*`、`claim-audit.*`、`converted.jsonl` |
| `batch_review` | `claim-results.*`、`claim-audit.*` |
| `gold_error` | `gold-action-plan.*`、`gold-backlog.*`、`gold-classification.*`、`gold-evaluation.*`、`claim-results.*` |
| `gold_review` | `gold-action-plan.*`、`gold-backlog.*`、`gold-classification.*`、`gold-evaluation.*`、`claim-results.*` |
| `gold_mismatch` | `gold-action-plan.*`、`gold-backlog.*`、`gold-classification.*`、`gold-evaluation.*`、`claim-results.*`、`converted.jsonl` |

`gold-classification.*` は、`under_claim_missing_code`、`over_claim_extra_code`、`code_substitution_gap`、`required_comment_input`、`facility_standard_input`、`history_input`、`master_mapping_gap`、`gold_label_missing`、`batch_execution_error`、`outpatient_basic_input`、`medication_input`、`injection_input`、`treatment_input`、`imaging_input`、`inpatient_input`、`dpc_input` などに分類する。`feedback_target=calculation_logic_or_mapping` や `point_or_quantity_logic` は算定ロジック修正、`input_contract` は実CSV/履歴/コメント入力の追加、`input_contract_or_calculation_logic` は入力不足かルール不足の切り分け、`facility_standard_master` や `master_data_or_mapping_contract` は公式/病院別マスター補正、`gold_label` は確定レセプト側のラベル確認へ戻す。

`gold-backlog.*` は分類行を `priority`、`feedback_target`、`classification`、`recommended_action` で束ねる。件数、代表record、代表コード、message source、理由が入るため、個別record確認の前に改善単位を決められる。

`gold-action-plan.*` はbacklogを `owner`、`implementation_step`、`acceptance_gate` に展開する。実CSVと確定レセプトの差分を、入力contract修正、施設基準/マスター補正、算定ロジック修正、gold label確認へ戻す作業票として使う。

## 9. Step2 / Step4 Samples

実データなしでStep2を確認するため、非PHIの差分サンプルmanifestを用意している。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.backlog.example.json \
  --output data/work/order-csv-backlog-example/manifest-validation.md \
  --fail-on-error
```

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.backlog.example.json \
  --output-root data/work/order-csv-backlog-example \
  --output data/work/order-csv-backlog-example/summary.md \
  --review-index-output data/work/order-csv-backlog-example/review-index.md
```

このサンプルはcontract validationは通るが、必須コメント行を意図的に抜いているため、`gold-backlog.md` と `gold-action-plan.md` に `required_comment_input` が出る。通常サンプル `contracts/order-csv/manifest.example.json` は同じ症例にコメント行を追加した修正版で、`gold mismatch 0`、`No improvement backlog items.` になる。実病院データでもこの差分を、入力contractやCSV mappingへ戻して再実行する。

Step7の評価データセットは、次のmanifestで確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.step7.example.json \
  --output data/work/order-csv-step7-example/manifest-validation.md \
  --fail-on-error
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

このmanifestは外来gold、入院基本料gold、DPC期待reviewを含み、`Gold mismatches: 0` になる。DPCはclaim batch上では `needs_review` だが、`正解ステータス=needs_review` を付けているためgold評価ではmatchになる。

Step7の改善backlogは、次のmanifestで確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.step7-backlog.example.json \
  --output-root data/work/order-csv-step7-backlog-example \
  --output data/work/order-csv-step7-backlog-example/summary.md \
  --review-index-output data/work/order-csv-step7-backlog-example/review-index.md
```

このmanifestは、必須コメント不足を `required_comment_input`、入院施設基準不足を `inpatient_input` として `gold-action-plan.md` へ戻す。

Step4の外来混在入力は、次のmanifestで確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.outpatient-mixed.example.json \
  --output data/work/order-csv-outpatient-mixed/manifest-validation.md \
  --fail-on-error
```

対象CSV `data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv` は、初再診、投薬、注射、処置、画像診断、検体検査を1請求に混在させた非PHI合成データである。対応contractは `contracts/order-csv/tohoku/0410001/outpatient-mixed-contract.json`。

Step6の入院/DPC入力は、次のmanifestで確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.inpatient.example.json \
  --output data/work/order-csv-inpatient-example/manifest-validation.md \
  --fail-on-error
```

対象CSV `data/work/example-orders/tohoku-0410001/inpatient-orders.csv` は、入院基本料を明示コードと日数で候補化するレコードと、DPCを `needs_review` に止めるレコードを含む非PHI合成データである。対応contractは `contracts/order-csv/tohoku/0410001/inpatient-contract.json`。

## 10. 保存する成果物

- `contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json`
- `contracts/order-csv/<manifest>.json`
- `summary.md` または `summary.csv`
- `review-index.md`
- 必要に応じて `profile.md`、`contract-validation.md`、`conversion.md`、`claim-results.md`、`claim-audit.csv`、`gold-evaluation.md`、`gold-classification.md`、`gold-backlog.md`、`gold-action-plan.md`

PHIを含む可能性がある `orders.csv`、`converted.jsonl`、患者単位のclaim結果は、運用ルールで許可された保管場所に置き、公開リポジトリには含めない。
