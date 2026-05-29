# Step6 入院/DPC入口

2026-05-18時点のStep6は、入院算定を外来batchへ無理に混ぜず、共通 `ClaimContext` に入院用の明示入力を追加する形で実装した。目的は、全病院batchで入院レコードを受け取ったときに、計算できる入院基本料は候補化し、DPCのようにまだ専用エンジンがないものは安全に `needs_review` へ送ることである。

## 実装済み

- `ClaimContext.inpatient_basic`
  - `basic_fee_code`
  - `basic_fee_days`
  - `facility_standard_key`
  - `ward_kind`
  - `inpatient_basic_code`
- `ClaimContext.dpc`
  - `dpc_claim`
  - `dpc_code`
  - `main_diagnosis`
  - `resource_diagnosis`
  - `surgery_code`
  - `procedure_code`
  - `comorbidity`
  - `hospital_coefficient`
- `EncounterContext.admission_date` / `discharge_date`
- `inpatient_fees.calculate_inpatient_fees()`
- CSV日本語presetの入院/DPC列mapping
- `run-inpatient-claim-batch`
- `run-order-csv-inpatient-claim-batch`
- `evaluate-gold-inpatient-claim-batch`
- 非PHIサンプルCSV、contract、manifest

## 算定ロジック

入院基本料は明示入力方式にする。上位システムまたは病院別CSV contractが `basic_fee_code` と `basic_fee_days` を渡し、算定エンジンは医科診療行為マスターから点数を引いて候補行を作る。

施設基準確認は `facility_standard_key` または `ward_kind` を施設基準辞書で内部rule keyへ正規化して行う。医療機関profileまたは入力 `facility_standard_keys` に該当rule keyがなければ、過剰請求を避けるため候補行を出さず `inpatient_basic_fee needs_review` にする。

`inpatient_basic_code` がある場合は、医科電子点数表の `electronic_inpatient_basic` テーブルに同コードと診療行為コードの対応があるか確認する。対応が見つからない場合はレビューmessageを付ける。

DPCは現時点で点数計算しない。`dpc_claim` または `dpc_code` があるレコードは、DPC grouping、期間別点数、医療機関別係数、包括/出来高分離を専用エンジンで扱う必要があるため `dpc_claim needs_review` にする。

## CSV列

日本語presetで追加した主な列。

| 標準フィールド | 日本語列 |
| --- | --- |
| `admission_date` | `入院日` |
| `discharge_date` | `退院日` |
| `basic_fee_code` | `入院基本料コード` |
| `basic_fee_days` | `入院基本料日数` |
| `inpatient_facility_standard_key` | `入院基本料施設基準` |
| `ward_kind` | `病棟区分` |
| `inpatient_basic_code` | `入院基本料テーブルコード` |
| `dpc_claim` | `DPC対象` / `ＤＰＣ対象` |
| `dpc_code` | `DPCコード` / `ＤＰＣコード` |
| `main_diagnosis` | `主傷病` |
| `resource_diagnosis` | `医療資源病名` |
| `surgery_code` | `手術コード` |
| `dpc_procedure_code` | `DPC処置コード` |
| `comorbidity` | `副傷病` |
| `hospital_coefficient` | `医療機関別係数` |

`item_kind` は `入院基本料` / `入院` を `inpatient_basic`、`DPC` / `ＤＰＣ` を `dpc` として扱う。

## サンプル実行

contract検証。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv data/work/example-orders/tohoku-0410001/inpatient-orders.csv \
  --contract contracts/order-csv/tohoku/0410001/inpatient-contract.json \
  --format markdown
```

単体CSV実行。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-inpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv data/work/example-orders/tohoku-0410001/inpatient-orders.csv \
  --column-map-preset japanese \
  --format markdown
```

manifest実行。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.inpatient.example.json \
  --output-root data/work/order-csv-inpatient-example \
  --output data/work/order-csv-inpatient-example/summary.md \
  --review-index-output data/work/order-csv-inpatient-example/review-index.md
```

サンプル結果は、入院基本料1件がOK、DPC1件が `needs_review` になる。これは意図した安全動作であり、DPCを自動計算できたという意味ではない。

## 未実装

- 病床テキストから病床種別・病棟を自動構造化する処理。
- 病棟・転棟履歴から入院料を自動選択する処理。
- 入退院日から入院基本料の日数を自動算出し、月跨ぎを分割する処理。
- 入院料加算、食事療養、生活療養。
- 入院中包括、出来高算定可能項目との分離。
- DPC電子点数表importer。
- DPC診断群分類、期間I/II/III、医療機関別係数適用。
- DPC包括/出来高分離。

## 次の実装候補

1. 実病院CSVから入院基本料コードと日数が安定して取れるかをcontractで確認する。
2. 入院gold labelを付け、`inpatient_input` と `dpc_input` の差分分類を回す。
3. `electronic_inpatient_basic` と医科診療行為マスターの結合テストを増やす。
4. DPC電子点数表とDPC係数の公式マスター取込を追加する。
5. 病棟・転棟履歴schemaを設計し、入院料自動選択を別ステップで実装する。
