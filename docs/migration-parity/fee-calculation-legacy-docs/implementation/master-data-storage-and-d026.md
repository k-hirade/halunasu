# 公式マスター保存設計とD026判断料実装方針

## 方針

公式CSVは、算定ロジックが直接読むデータではなく、次の4層に分けて扱う。

1. raw層
   - 支払基金・厚労省から取得したZIP/CSVをそのまま保存する。
   - 監査、再取込、差分確認、チェックサム照合に使う。
2. normalized master層
   - ヘッダなしCP932 CSVを、型と意味のあるカラムに正規化してDBに格納する。
   - 公式マスターの項目をなるべく落とさず、必要な主要項目を列として持つ。
3. derived domain層
   - 検体検査MVPで使いやすいビューや派生テーブルを作る。
   - 例: `lab_procedure_catalog`, `lab_judgement_fee_map`。
4. curated rule層
   - 公式マスターだけでは表現できない通知、疑義解釈、例外、運用ルールを手で管理する。

## 時点管理

算定では、少なくとも2つの時点を分ける。

- `service_date`
  - 実際の診療日。
  - `effective_from <= service_date <= effective_to` で有効な点数・ルールを選ぶ。
- `source_version` / `published_at`
  - どの公式データ版を取り込んだか。
  - 後から「どの版のマスターで計算したか」を説明するために必要。

## rawファイル配置案

```text
data/raw/ssk/
  medical_procedure_master/2026-05-01/s_ALL20260501.zip
  comment_master/2026-05-01/c_ALL20250715.zip
  comment_related_table/2026-05-01/ck_ALL_20250901.zip
  medical_electronic_fee_table/2026-05-01/tensuhyo_02.zip
```

MVP実装ではrawファイルの保存までは強制しない。importerは `--raw-path` に渡されたCSVを取り込み、チェックサムと行数を `master_sources` に記録する。

## SQLiteスキーマ

MVPではSQLiteを採用する。PostgreSQLへ移行しやすいように、DB固有機能には依存しない。

### master_sources

公式データの版と取り込み履歴。

```text
id INTEGER PRIMARY KEY
source_type TEXT NOT NULL
source_version TEXT NOT NULL
published_at TEXT
url TEXT
raw_path TEXT NOT NULL
checksum_sha256 TEXT NOT NULL
encoding TEXT NOT NULL
row_count INTEGER NOT NULL
retrieved_at TEXT
imported_at TEXT NOT NULL
```

### medical_procedures

医科診療行為マスターの正規化テーブル。

```text
source_id INTEGER NOT NULL
code TEXT NOT NULL
short_name TEXT NOT NULL
base_name TEXT
points REAL NOT NULL
inout_applicability TEXT
outpatient_aggregate TEXT
inpatient_aggregate TEXT
bundle_lab_group TEXT
judgement_kind TEXT
judgement_group TEXT
specimen_comment_flag TEXT
facility_standard_codes TEXT
chapter TEXT
part TEXT
alpha_part TEXT
section TEXT
branch TEXT
item TEXT
notice_chapter TEXT
notice_part TEXT
notice_alpha_part TEXT
notice_section TEXT
notice_branch TEXT
notice_item TEXT
effective_from TEXT
effective_to TEXT
raw_row_json TEXT NOT NULL
```

### drugs

医薬品マスターの正規化テーブル。支払基金ファイルレイアウトの医薬品マスター42項目を取り込み、算定概算に必要な主要項目を列化する。

```text
source_id INTEGER NOT NULL
code TEXT NOT NULL
name TEXT NOT NULL
kana TEXT
unit_code TEXT
unit_name TEXT
amount_kind TEXT
unit_amount_yen REAL NOT NULL
generic_flag TEXT
contrast_agent_flag TEXT
injection_volume TEXT
dosage_form TEXT
changed_at TEXT
discontinued_at TEXT
reimbursement_code TEXT
transitional_date TEXT
base_name TEXT
listed_at TEXT
generic_name_code TEXT
generic_prescription_text TEXT
generic_prescription_add_on_flag TEXT
anti_hiv_flag TEXT
long_listed_related_code TEXT
selective_treatment_flag TEXT
raw_row_json TEXT NOT NULL
```

### specific_materials

特定器材マスターの正規化テーブル。支払基金ファイルレイアウトの特定器材マスター38項目を取り込み、算定概算に必要な主要項目を列化する。

```text
source_id INTEGER NOT NULL
code TEXT NOT NULL
name TEXT NOT NULL
kana TEXT
unit_code TEXT
unit_name TEXT
amount_kind TEXT
unit_amount_yen REAL NOT NULL
age_addition_kind TEXT
min_age TEXT
max_age TEXT
oxygen_kind TEXT
material_kind TEXT
upper_price_flag TEXT
upper_points REAL
changed_at TEXT
transitional_date TEXT
discontinued_at TEXT
notification_table_no TEXT
notification_section_no TEXT
dpc_applicability TEXT
base_name TEXT
reprocessed_single_use_device_flag TEXT
raw_row_json TEXT NOT NULL
```

### lab_procedure_catalog

`medical_procedures` から作るビュー。検体検査MVPが参照する。

主な分類。

- `is_lab_test`
  - D000-D024の検体検査実施料。
- `is_judgement_fee`
  - D026判断料。
- `is_basic_lab_judgement_fee`
  - D027基本的検体検査判断料。
- `is_collection_fee`
  - D400-D419の採取料。

### lab_judgement_fee_map

`medical_procedures` から作るビュー。D026判断グループから判断料コードを引く。

| judgement_group | D026判断料 |
| ---: | --- |
| 1 | 尿・糞便等検査判断料 |
| 2 | 血液学的検査判断料 |
| 3 | 生化学的検査（1）判断料 |
| 4 | 生化学的検査（2）判断料 |
| 5 | 免疫学的検査判断料 |
| 6 | 微生物学的検査判断料 |
| 17 | 遺伝子関連・染色体検査判断料 |

## importerの責務

importerは、公式CSVを正規化DBに入れるだけにする。

importerが行うこと。

- CP932 CSVを読み込む。
- ヘッダなし150列の医科診療行為マスターを検証する。
- ヘッダなし42列の医薬品マスターを検証する。
- ヘッダなし38列の特定器材マスターを検証する。
- 必要な列を正規化する。
- 全行を `raw_row_json` として保存する。
- `master_sources` に出典、版、チェックサム、行数を記録する。
- `lab_procedure_catalog` と `lab_judgement_fee_map` はビューとして作成する。
- コメントマスター、コメント関連テーブルを取り込む。
- 医科電子点数表の補助マスター、包括、背反、入院基本料、算定回数テーブルを取り込む。

importerが行わないこと。

- 算定可否の最終判断。
- D026判断料の追加。
- 包括や背反の解決。
- 医学的必要性の判断。

## D026判断料ロジックの責務

D026判断料は、派生ビューと実行時コンテキストを組み合わせて追加する。

入力。

- 算定日。
- 当日または対象請求内の検体検査コード。
- 同一患者・同一月に既算定の判断料グループ。
- D025/D027や管理料などにより包括される判断料グループ。
- 使用する `source_id`。

処理。

1. 検体検査コードから `judgement_group` を集計する。
2. `judgement_kind = 1` の検査実施料だけを対象にする。
3. D000など、判断料グループがない検査は除外する。
4. 既算定グループを除外する。
5. 包括されるグループを除外する。
6. `lab_judgement_fee_map` からD026判断料コードを引く。
7. 判断料を `confirmed` として返す。
8. 情報不足がある場合は `warnings` または `needs_review` として返す。

ロジックが直接マスターを書き換えることはしない。

## 検体検査管理加算ロジックの責務

`lab_rules.add_lab_management_fee()` は、病院プロファイルの施設基準キーを使って、検体検査管理加算の候補を返す。施設基準略称は [施設基準辞書](./facility-standard-dictionary.md) で内部rule keyへ正規化してから判定する。

入力。

```text
procedure_codes
service_date
medical_procedure_master source_id
facility_standard_keys
already_billed_same_month
judgement_fee_present
history_complete
```

施設基準略称と診療行為コードの対応。

| 施設基準略称 | 診療行為コード | 名称 |
| --- | --- | --- |
| 検Ⅰ | 160170170 | 検体検査管理加算（1） |
| 検Ⅱ | 160182770 | 検体検査管理加算（2） |
| 検Ⅲ | 160161610 | 検体検査管理加算（3） |
| 検Ⅳ | 160185770 | 検体検査管理加算（4） |

処理。

1. `facility_standard_keys` から `lab_management_1` - `lab_management_4` に解決できる施設基準を探す。
2. 複数ある場合は `lab_management_4 > lab_management_3 > lab_management_2 > lab_management_1` の優先順で選ぶ。
3. 同月既算定なら加算しない。
4. D026またはD027の判断料が請求内にない場合は加算しない。
5. 履歴が不完全な場合は `warnings` を返す。
6. 条件を満たす場合、対応する診療行為コードを `ClaimItem` として返す。

このロジックも、マスターや病院プロファイルを直接書き換えない。加算候補の追加可否を返すだけにする。

## 実オーダーJSONLと外来検体検査batch

2026-05-17時点で、`ClaimContext` 互換の実オーダーJSONLを読み込み、`calculate_lab_claim_standardized()` を一括実行する入口を追加した。

CLI。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-outpatient-claim-batch \
  --db <sqlite> \
  --input <orders.jsonl> \
  --format jsonl \
  --output <results.jsonl>
```

入力は1行1請求/1診療単位のJSONLである。`export-hospital-claim-contexts` が出す `claim_context_template` をそのまま土台にし、トップレベルの実オーダー項目で上書きできる。

最小例。

```json
{
  "record_id": "case-1",
  "claim_context_template": {
    "patient": {"patient_id": null},
    "encounter": {
      "service_date": "2026-06-03",
      "regional_bureau": "tohoku",
      "medical_institution_code": "04,1000,1",
      "is_outpatient": true
    },
    "procedure_codes": [],
    "facility_standard_keys": ["検Ⅱ"]
  },
  "patient": {"patient_id": "patient-1"},
  "procedure_codes": ["160000410", "160000310"],
  "lab_options": {
    "collection_fee_inputs": ["blood_venous"],
    "outpatient_rapid_lab_same_day_result_explained": true,
    "outpatient_rapid_lab_written_information_provided": true,
    "outpatient_rapid_lab_result_based_care_provided": true
  }
}
```

対応済み入力。

- `patient`: `patient_id`, `birth_date`, `sex`。
- `encounter`: `service_date`, `medical_institution_code`, `regional_bureau`, `is_outpatient`, `admission_date`, `discharge_date`。
- `procedure_codes`: 診療行為コード配列またはカンマ区切り文字列。
- `drug_inputs`, `injection_drug_inputs`, `material_inputs`: `{code, quantity}`。
- `comment_inputs`: `{code, text}`。必須コメント候補は、入力済みコメントコードが一致する場合、または入力済みコメント本文が公式コメント本文で始まる場合に充足済みとする。
- `medication_orders`: `drug_code`, `total_quantity`, `quantity_per_day`, `days`, `dose_quantity`, `doses_per_day`, `dispensing_kind`。
- `injection_orders`: `drug_code`, `total_quantity`, `dose_quantity`, `administrations`。
- `treatment_orders`: `kind`, `area_size`。
- `imaging_orders`: `kind`, `acquisition_kind`, `radiography_diagnostic_kind`, `ct_equipment_kind`, `mri_equipment_kind`, `head`, `joint_use`, `contrast`, `electronic_image_management`。
- `history`, `lab_options`, `outpatient_basic`, `medication`, `injection`, `data_completeness`。
- `facility_standard_keys`。
- `master_sources`: 各種 `source_id`。

`master_sources` が省略された場合、CLIは既定でDB内の `master_sources` から算定日以前に公開された最新sourceを自動選択する。医療機関台帳と施設基準は `regional_bureau` がある場合に、`<regional_bureau>_hospital_registry` と `<regional_bureau>_facility_standards_medical` の最新sourceを使う。自動選択を止めたい場合は `--no-auto-master-sources` を指定する。

出力は `jsonl`、`json`、`tsv`、`markdown` に対応する。JSON系では、`input_codes`、`candidate_codes`、`lines`、`messages`、`total_confirmed_points`、`total_candidate_points`、`total_points`、行単位の `status` を返す。入力不備などの例外はbatch全体を止めず、その行だけ `status = error` として返す。

汎用CSVからJSONLへ変換するadapterも追加した。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-outpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --column-map-preset orca \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --converted-output <orders.jsonl> \
  --conversion-report-output <orders-conversion.md> \
  --format markdown \
  --output <results.md> \
  --audit-output <audit.csv> \
  --audit-format csv \
  --fail-on-error
```

変換と算定を分けて確認する場合は、次のようにJSONLを先に作る。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli convert-order-csv-to-claim-jsonl \
  --csv <orders.csv> \
  --column-map-preset orca \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --output <orders.jsonl>
```

CSVは1行1明細で、`record_id` 単位にグルーピングする。`record_id` がない場合は `patient_id + service_date + regional_bureau + medical_institution_code` をキーにする。`--template-jsonl` を渡すと、`regional_bureau + medical_institution_code + service_date` が合う `claim_context_template` を土台にする。

実データ受入時は、変換前に列profileを出す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli profile-order-csv-columns \
  --csv <orders.csv> \
  --column-map-preset orca \
  --format markdown \
  --output <orders-column-profile.md> \
  --fail-on-warning
```

profileは、入力行数、列数、標準列へのmapping、未対応列、`record_id` または複合キー、`item_kind`、コード列、gold label列の有無、値mapping例を返す。`--format json` も使えるため、病院別の受入チェックをCIや取り込みジョブに組み込める。

profile確認後は、病院別のmapping contractで受入条件を固定する。

最初のcontractは、実CSVから雛形生成する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli generate-order-csv-contract-template \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --contract-id <hospital-order-contract-v1> \
  --hospital-name <hospital-name> \
  --regional-bureau <regional-bureau> \
  --medical-institution-code <medical-institution-code> \
  --output <hospital-order-contract.json>
```

生成結果はそのまま確定せず、病院別の運用要件に合わせてレビューする。標準では、観測された `record_id`、患者ID、診療日、地方厚生局、医療機関コード、`item_kind`、コード列、gold label列を必須候補にし、未対応列を `allowed_unmapped_columns` に入れる。未対応列を許容しないcontractにしたい場合は `--strict-unmapped`、gold labelを必須にしたい場合は `--require-gold-labels` を付ける。

```json
{
  "contract_id": "hospital-001-orders-v1",
  "hospital_name": "Example Hospital",
  "regional_bureau": "tohoku",
  "medical_institution_code": "0410001",
  "column_map_preset": "japanese",
  "required_target_fields": [
    "record_id",
    "patient_id",
    "service_date",
    "regional_bureau",
    "medical_institution_code",
    "item_kind",
    "code",
    "expected_total_points",
    "expected_candidate_codes"
  ],
  "required_source_columns": ["レコードID", "診療行為コード"],
  "allowed_unmapped_columns": ["院内メモ"],
  "require_gold_labels": true,
  "minimum_row_count": 1
}
```

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv <orders.csv> \
  --contract <hospital-order-contract.json> \
  --format markdown \
  --output <orders-contract-validation.md> \
  --fail-on-error
```

contract検証は、base必須列、contract上の必須target field、必須source column、gold label有無、未対応列が許容リスト内か、最小行数を確認する。通過したCSVだけをJSONL変換、batch、gold評価へ進める。

profile、contract検証、変換、batch、audit、gold評価はpipelineでまとめて実行できる。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --contract <hospital-order-contract.json> \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --profile-output <orders-column-profile.md> \
  --contract-output <orders-contract-validation.md> \
  --converted-output <orders.jsonl> \
  --conversion-report-output <orders-conversion.md> \
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

`--gold-output`、`--gold-classification-output`、`--gold-backlog-output`、`--gold-action-plan-output`、または `--evaluate-gold` を付けると、変換済みJSONLの `expected` を使ってgold評価も同時に走る。`gold-classification` は差分を `calculation_logic_or_mapping`、`point_or_quantity_logic`、`facility_standard_master`、`master_data_or_mapping_contract`、`input_contract`、`gold_label`、`parser_or_engine` などの戻し先へ分類する。`gold-backlog` は分類を改善単位へ束ね、priority、件数、代表record/code/message sourceを出す。`gold-action-plan` はbacklogを `owner`、`implementation_step`、`acceptance_gate` へ展開する。contract不一致は `--fail-on-contract-error`、変換warningは `--fail-on-warning`、算定errorは `--fail-on-error`、レビュー対象は `--fail-on-review`、gold差分は `--fail-on-mismatch` でexit codeへ反映する。

複数病院分は `contracts/order-csv/` にcontractとmanifestを置く。

実CSVの受入作業は [実オーダーCSV受入チェックリスト](./order-csv-intake-checklist.md) に沿って進める。

```text
contracts/order-csv/
  manifest.example.json
  <regional_bureau>/
    <medical_institution_code>/
      order-contract.json
```

書式例として `contracts/order-csv/tohoku/0410001/order-contract.json` を配置している。これはサンプルなので、実病院では `generate-order-csv-contract-template` の出力をレビューし、病院ごとのCSV仕様に合わせて保存する。

manifestは `entries` 配列で、各entryに `id`、`csv`、`contract`、任意の `template_jsonl`、`evaluate_gold` を持たせる。相対パスはmanifestファイルからの相対で解決する。

batch前にmanifest全体を検証する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.example.json \
  --output data/work/order-csv-pipeline/manifest-validation.md \
  --fail-on-error
```

`Ready: yes` なら、CSV/contract/templateが存在し、contract validationが通り、gold評価対象entryにgold labelがある。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.example.json \
  --output-root data/work/order-csv-pipeline \
  --output data/work/order-csv-pipeline/summary.md \
  --review-index-output data/work/order-csv-pipeline/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch \
  --fail-on-batch-error
```

各entryは `--output-root/<entry id>/` にprofile、contract検証、converted JSONL、変換report、claim結果、audit、gold評価、gold差分分類、改善バックログを保存する。summaryは全entryのpass/fail、注意理由、変換warning、record数、batch error/review、gold error/review/mismatch、gold差分分類action数、high priority分類数、最多分類、最多戻し先、成果物ディレクトリを集計する。Markdown summaryには全entry横断の `Gold Classification Counts` と `Gold Feedback Target Counts` も出る。`--summary-format` は `markdown`、`json`、`csv`、`tsv` に対応する。

`--review-index-output` を付けると、`attention_reasons` を理由別に束ねたレビュー用indexを出す。contract不一致なら `contract-validation` とprofile、変換warningなら変換report、batch review/errorならclaim結果とaudit、gold差分なら改善バックログ、gold差分分類、gold評価reportを優先表示する。

`run-order-csv-outpatient-claim-batch` は、CSV変換、任意の中間JSONL保存、任意の変換warningレポート保存、算定batch実行を1コマンドで行う。`--audit-output` を付けると、`scope`、`regional_bureau`、`medical_institution_code`、`facility_standard_key`、`status`、`message_source`、`message_status`、`count` を持つ監査サマリも保存する。`--audit-format` は `csv`、`json`、`tsv` に対応する。実データ受入時は、まず `--conversion-report-output` で列mappingとグルーピングwarningを確認し、次に `--fail-on-error`、最後に `--fail-on-review` を使って自動確定範囲を広げる。旧 `run-order-csv-outpatient-lab-batch` は互換用aliasである。

正解点数つきのgold JSONLは、同じ入力に `expected` を足して評価する。検体検査だけでなく、共通 `ClaimContext` で扱う初再診、投薬、注射、処置、画像診断も同じ入口で評価する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli evaluate-gold-claim-batch \
  --db data/work/standard-master.sqlite \
  --input <gold.jsonl> \
  --format markdown \
  --output <gold-evaluation.md> \
  --classification-output <gold-classification.md> \
  --backlog-output <gold-backlog.md> \
  --action-plan-output <gold-action-plan.md> \
  --fail-on-error \
  --fail-on-mismatch
```

`evaluate-gold-outpatient-lab-claim-batch` は互換用aliasとして残す。

`expected` は `total_points`、`status`、`candidate_codes` を受け付ける。出力は `overall_verdict`、`point_verdict`、`code_verdict`、期待点数、実点数、差分、期待コード不足、余剰コードを返す。`expected.status=needs_review` を明示したレコードは、実際の算定結果も `needs_review` で、点数/コード差分がなければ `match` とする。`--classification-output` は差分ごとに `classification`、`feedback_target`、`priority`、`recommended_action` を出すため、確定レセプトとの差を算定ロジック、入力contract、施設基準/マスター、gold label確認へ戻せる。`--backlog-output` は分類行を改善単位へ集約し、実装順決定に使う。`--action-plan-output` はbacklogを `owner`、`implementation_step`、`acceptance_gate` つきの修正単位へ変換し、実データ差分を実装issueへ戻す入口にする。

実オーダーCSVからgold JSONLを作る場合は、同じCSVに `expected_total_points`、`expected_status`、`expected_candidate_codes` を入れる。`japanese` / `orca` presetでは、`正解点数`、`期待点数`、`確定点数`、`請求点数`、`合計点数`、`正解ステータス`、`期待ステータス`、`確定ステータス`、`正解コード`、`期待コード`、`確定コード`、`請求コード` をこれらの標準列へmappingする。`明細種別` / `剤種` が `正解`、`期待`、`確定`、`請求`、`請求済` の行は、算定対象の `procedure_codes` には入れず、`expected.candidate_codes` へだけ追加する。

Step7の非PHIサンプルは [Step7 評価データセット](./gold-dataset-step7.md) にまとめた。`contracts/order-csv/manifest.step7.example.json` は外来gold、入院基本料gold、DPC期待reviewを含み、`Gold mismatches: 0` まで確認済みである。`contracts/order-csv/manifest.step7-backlog.example.json` は必須コメント不足と入院施設基準不足を `required_comment_input` / `inpatient_input` としてAction Planへ戻す。

代表列。

| 列 | 役割 |
| --- | --- |
| `record_id` | 請求/診療単位のグループキー |
| `patient_id` | 患者ID |
| `service_date` | 算定日 |
| `regional_bureau` | 地方厚生局キー |
| `medical_institution_code` | 保険医療機関コード |
| `item_kind` | `procedure`, `drug`, `medication_order`, `injection_order`, `material`, `collection_fee`, `same_day_history`, `facility_standard` など |
| `code` | item_kindに対応するコードまたは内部キー |
| `quantity` | 薬剤・材料などの数量 |
| `collection_fee_inputs` | `blood_venous` などの採取料入力 |
| `facility_standard_keys` | `検Ⅱ` などの施設基準略称 |
| `comment_code`, `comment_text` | 入力済み摘要コメント |
| `outpatient_rapid_lab_*` | 外来迅速検体検査加算の成立事実 |

batchのMarkdownレポートは、全体statusだけでなく、`Line Status`、`Message Source x Status`、地方厚生局別status、地方厚生局別message source、病院別message source上位、頻出message、行別のmessage source内訳を出す。CSV/JSON/TSVのaudit summaryでは、同じ監査軸を `scope` 列で区別して機械処理できる。これにより、`needs_review`、`blocked`、必須コメント、包括・背反、施設基準warningを、ルール別・地域別・病院別・施設基準別に監査できる。

列名mappingは `--column-map-preset japanese`、`--column-map-preset orca` の組み込みpreset、または `--column-map <json>` で指定する。独自JSONは次の形にする。

```json
{
  "columns": {
    "患者番号": "patient_id",
    "診療日": "service_date",
    "診療行為コード": "code",
    "剤種": "item_kind"
  },
  "constants": {
    "regional_bureau": "tohoku"
  },
  "values": {
    "item_kind": {
      "検査": "procedure",
      "薬剤": "drug"
    },
    "is_outpatient": {
      "1": "true",
      "2": "false"
    }
  }
}
```

## 標準DBビルドmanifest

公式マスター一式と全国hospital profileを1つのSQLiteへ再現可能に投入するため、`build-standard-master-db` を追加した。

月次運用の手順は [公式マスター更新Runbook](./official-master-update-runbook.md) に集約する。2026-05-01版の固定入力は `configs/official-master/2026-05-01/ssk-master-catalog.json` と `configs/official-master/2026-05-01/standard-master-build.json` である。

raw配下に支払基金ZIP/CSVを置いた後、次のコマンドでZIP展開と `standard-master-build.json` 生成を行う。

支払基金の公式ページからURL catalogを生成する場合は次を使う。`--source-version` は月次スナップショットの版として統一し、各ファイルの公式公開日はcatalog内の `published_at` に残す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli discover-ssk-master-catalog \
  --source-version 2026-05-01 \
  --format catalog \
  --output data/work/ssk-master-catalog.json

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli discover-ssk-master-catalog \
  --source-version 2026-05-01 \
  --format markdown \
  --output data/work/ssk-master-catalog-discovery.md
```

月次更新では、前回保存したcatalogと新しいcatalogの差分を先に確認する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli diff-ssk-master-catalog \
  --old data/work/ssk-master-catalog.prev.json \
  --new data/work/ssk-master-catalog.json \
  --format markdown \
  --output data/work/ssk-master-catalog-diff.md
```

差分でURL、ファイル名、`source_version`、`published_at`、取得元ページに変更があれば、対象ファイルを再取得して標準DBを再ビルドする。CIで変更検知を失敗扱いにする場合は `--fail-on-change` を付ける。

公式URL catalogからraw保存、ZIP展開、標準manifest生成までをまとめて行う場合は次を使う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-ssk-master-catalog \
  --catalog data/work/ssk-master-catalog.json \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --published-at 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --standard-manifest-output data/work/standard-master-build.json \
  --format markdown
```

自動生成されるURL catalog例。

```json
{
  "entries": [
    {
      "kind": "medical_procedure_master",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_01.files/s_ALL20260501.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_01.html",
      "filename": "s_ALL20260501.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01"
    },
    {
      "kind": "drug_master",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_04.files/y_r07_ALL20260317.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_04.html",
      "filename": "y_r07_ALL20260317.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-03-17"
    },
    {
      "kind": "specific_material_master",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_05.files/t_ALL20260227.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_05.html",
      "filename": "t_ALL20260227.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-02-27"
    },
    {
      "kind": "comment_master",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.files/c_ALL20250715.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.html",
      "filename": "c_ALL20250715.zip",
      "source_version": "2026-05-01",
      "published_at": "2025-07-15"
    },
    {
      "kind": "comment_related_table",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.files/ck_ALL_20250901.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.html",
      "filename": "ck_ALL_20250901.zip",
      "source_version": "2026-05-01",
      "published_at": "2025-09-01"
    },
    {
      "kind": "medical_electronic_fee_table",
      "url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.files/tensuhyo_02.zip",
      "source_page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html",
      "filename": "tensuhyo_02.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01"
    }
  ]
}
```

`download-ssk-master-catalog` は、各entryを `data/raw/ssk/<kind>/<source_version>/<filename>` へ保存する。既に保存済みのファイルは既定では再取得せず、再取得する場合は `--overwrite` を使う。保存後は `prepare-standard-master-build-manifest` と同じ処理でZIP展開と標準manifest生成を行う。

2026-05-17時点の実行結果。

| 成果物 | 結果 |
| --- | --- |
| `data/work/ssk-master-catalog.json` | 支払基金公式ページ5ページから6 entriesを生成、warnings 0 |
| `data/work/ssk-master-catalog-diff.md` | 同一catalog比較で added 0 / removed 0 / changed 0 / unchanged 6 |
| `data/raw/ssk` | 公式ZIP 6ファイルを保存 |
| `data/work/standard-master-build.json` | 7 entries、missing kinds 0 |
| `data/work/standard-master-build-validation.md` | build manifest dry-run検証、Ready yes |
| `data/work/standard-master.sqlite` | 1.2GB、標準マスターと全国hospital profileを同一DBへ投入 |

標準DBビルドの実績。

| Kind | Rows |
| --- | ---: |
| `medical_procedure_master` | 10,192 |
| `drug_master` | 19,337 |
| `specific_material_master` | 1,380 |
| `comment_master` | 3,759 |
| `comment_related_table` | 14,719 |
| `medical_electronic_fee_table` | 349,688 |
| 地方厚生局manifest | 35 entries、全entry OK |

同DBで `summarize-hospital-run-targets` を実行すると、全国既定実行対象は7,094件である。`smoke-hospital-run-targets --service-date 2026-06-01 --fail-on-error` では OK 7,094 / Non-OK 0 / warnings 4 だった。

全国既定実行対象に代表的な外来検体検査ケースを流すsmokeも追加した。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-nationwide-outpatient-lab-smoke \
  --db data/work/standard-master.sqlite \
  --service-date 2026-06-01 \
  --collection-fee-input blood_venous \
  --format markdown \
  --output data/work/nationwide-outpatient-lab-smoke-2026-06-01.md \
  --fail-on-error
```

既定の代表ケースは、`160000410`、`160000310` を入力し、外来迅速検体検査加算の成立事実をtrueにした合成ケースである。2026-05-17時点の実行では、7,094件すべて計算error 0で完走した。一方、全件が `needs_review` になった。内訳は、外来迅速検体検査加算の必須コメント候補が14,188件、検体検査管理加算の施設基準なしblockedが3,532件である。

入力済みコメントコード/コメント文字列による必須コメント充足判定も追加した。コメントコード `820100129` と `830100111` を入力済みとして渡したsmokeでは、comment `needs_review` は0件になり、OK 3,562 / needs_review 3,532 / error 0 となった。残りの `needs_review` は、すべて検体検査管理加算の施設基準なしblockedである。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-nationwide-outpatient-lab-smoke \
  --db data/work/standard-master.sqlite \
  --service-date 2026-06-01 \
  --collection-fee-input blood_venous \
  --comment-code 820100129 \
  --comment-code 830100111 \
  --format markdown \
  --output data/work/nationwide-outpatient-lab-smoke-comments-fulfilled-2026-06-01.md \
  --fail-on-error
```

検体検査管理加算の施設基準なしは、`lab_options.lab_management_facility_missing_policy` で `ignore` / `review` を切り替える。全国概算の既定は `ignore` で、施設基準がなければ加算候補なしとして正常終了する。監査時は `review` を指定し、従来どおり `lab_management blocked` として集計する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-nationwide-outpatient-lab-smoke \
  --db data/work/standard-master.sqlite \
  --service-date 2026-06-01 \
  --collection-fee-input blood_venous \
  --comment-code 820100129 \
  --comment-code 830100111 \
  --format markdown \
  --output data/work/nationwide-outpatient-lab-smoke-policy-ignore-2026-06-01.md \
  --fail-on-error \
  --fail-on-review
```

この概算既定ポリシー版では、全国既定実行対象7,094件が OK 7,094 / needs_review 0 / error 0 となった。次の実装優先度は、実オーダーCSV/JSONLを全国病院テンプレートに結合し、同じbatch入口で実明細の `needs_review` を集計することである。

手元rawを直接使う場合は次のコマンドでZIP展開と `standard-master-build.json` 生成を行う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli prepare-standard-master-build-manifest \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --published-at 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --output data/work/standard-master-build.json
```

`prepare-standard-master-build-manifest` は、`raw-root` 配下の `.zip` を同名ディレクトリへ展開し、`s_ALL*.csv`、`y_ALL*.csv` または `y_r*_ALL*.csv`、`t_ALL*.csv`、`c_ALL*.csv`、`ck_ALL*.csv`、医科電子点数表の `01補助`、`02包括`、`03-*背反`、`04入院基本料`、`05算定回数` CSVを走査して標準manifest entryへ変換する。ZIP内ファイル名は既定でCP932として扱う。既存展開ファイルを上書きする場合は `--overwrite-extracted`、展開せずCSV走査だけにする場合は `--no-extract-archives` を使う。

生成したmanifestを使ってDBを作る。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-standard-master-build-manifest \
  --manifest data/work/standard-master-build.json \
  --format markdown \
  --output data/work/standard-master-build-validation.md \
  --fail-on-error

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli build-standard-master-db \
  --db data/work/standard-master.sqlite \
  --manifest data/work/standard-master-build.json \
  --format markdown
```

`validate-standard-master-build-manifest` はDB投入前のdry-runで、必須kind、未対応kind、`source_version`、`path` / `csv_paths` の存在確認を行う。`--fail-on-error` を付けると、raw配置漏れやmanifest欠落をDB投入前に止められる。

manifest例。

```json
{
  "entries": [
    {
      "kind": "medical_procedure_master",
      "path": "data/raw/ssk/medical_procedure_master/2026-05-01/s_ALL20260501.csv",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01",
      "encoding": "cp932"
    },
    {
      "kind": "drug_master",
      "path": "data/raw/ssk/drug_master/2026-05-01/y_ALL20260501.csv",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01",
      "encoding": "cp932"
    },
    {
      "kind": "specific_material_master",
      "path": "data/raw/ssk/specific_material_master/2026-05-01/t_ALL20260501.csv",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01",
      "encoding": "cp932"
    },
    {
      "kind": "comment_related_table",
      "path": "data/raw/ssk/comment_related_table/2026-05-15/ck_ALL_20260515.csv",
      "source_version": "2026-05-15",
      "published_at": "2026-05-15",
      "encoding": "cp932"
    },
    {
      "kind": "medical_electronic_fee_table",
      "source_version": "2026-05-01",
      "published_at": "2026-05-01",
      "encoding": "cp932",
      "csv_paths": {
        "aux_master": "data/raw/ssk/medical_electronic_fee_table/2026-05-01/01補助マスターテーブル.csv",
        "bundles": "data/raw/ssk/medical_electronic_fee_table/2026-05-01/02包括テーブル.csv",
        "exclusions_day": "data/raw/ssk/medical_electronic_fee_table/2026-05-01/03-1背反テーブル1.csv",
        "frequency_limits": "data/raw/ssk/medical_electronic_fee_table/2026-05-01/05算定回数テーブル.csv"
      }
    },
    {
      "kind": "regional_manifest",
      "path": "configs/regional-master/2026-05-01/regional_manifest.json"
    }
  ]
}
```

対応する `kind` は、`medical_procedure_master`、`drug_master`、`specific_material_master`、`comment_master`、`comment_related_table`、`medical_electronic_fee_table`、`regional_manifest` である。通常はエラーを行単位でreportし、CIで失敗扱いにする場合は `--fail-on-error` を使う。途中停止したい場合は `--stop-on-error` を使う。

## 採取料ロジックの責務

`lab_rules.add_collection_fees()` は、D400-D419の診断穿刺・検体採取料の候補を返す。

重要な方針として、採取料は検査コードだけから自動推定しない。尿蛋白、血算、感染症検査などの検査実施料だけでは、実際の採取方法、採取日、院内/持参、既算定の有無を確定できないためである。

入力。

```text
procedure_codes
service_date
medical_procedure_master source_id
collection_fee_inputs
already_billed_same_day_codes
history_complete
```

`collection_fee_inputs` は、公式診療行為コードまたは内部キーで指定する。

現在対応している主な内部キー。

| 入力キー | 診療行為コード | 名称 |
| --- | --- | --- |
| `blood_venous` | 160095710 | B-V |
| `blood_capillary` | 160095810 | B-C |
| `nasopharyngeal_swab` | 160208510 | 鼻腔・咽頭拭い液採取 |
| `gastric_duodenal_fluid` | 160101010 | 胃液・十二指腸液採取 |
| `thoracic_fluid` | 160101110 | 胸水採取 |
| `abdominal_fluid` | 160145010 | 腹水採取 |
| `arterial_blood` | 160101210 | B-A |

処理。

1. `collection_fee_inputs` を診療行為コードに変換する。
2. D400-D419の有効な診療行為かを `lab_procedure_catalog.is_collection_fee` で確認する。
3. 請求内に既にあるコードは二重追加しない。
4. 同日既算定コードは追加しない。
5. 履歴が不完全な場合は `warnings` を返す。

採取料は、EHR/オーダー/検体受付などから「実際に行った採取」の入力を受けて候補化するのが安全である。

## 外来迅速検体検査加算ロジックの責務

`lab_rules.add_outpatient_rapid_lab_fee()` は、外来迅速検体検査加算 `160177770` の候補を返す。

公式マスター上の点数は1項目につき10点である。医科診療行為マスターには外来迅速対象検査の専用フラグがないため、厚労省告示「特掲診療料の施設基準等」別表第九の二に列挙された対象検査を、区分番号と検査名の辞書として持つ。

対象検査数は、入力された診療行為コードから自動判定する。算定そのものは検査コードだけでは確定できないため、次の診療事実を実行時コンテキストで明示する。

入力。

```text
procedure_codes
service_date
medical_procedure_master source_id
is_outpatient
eligible_test_item_count optional override
same_day_result_explained
written_information_provided
result_based_care_provided
already_billed_same_day_count
history_complete
```

処理。

1. 外来でなければ追加しない。
2. `procedure_codes` から別表第九の二の対象検査を抽出し、対象検査項目数を推定する。
3. `eligible_test_item_count` が明示された場合は、その値を優先する。
4. 対象検査項目数が0なら追加しない。
5. 当日中の結果説明、文書による情報提供、結果に基づく診療がすべて確認されていなければ追加しない。
6. 1日5項目を上限に、既算定項目数を差し引いて数量を決める。
7. 請求内に既に `160177770` がある場合は二重追加しない。
8. 対象検査名からコメント文字列 `検体検査名（外来迅速検体検査加算）；...` を生成する。
9. 履歴が不完全な場合は `warnings` を返す。

自動判定対象。

- D000 尿中一般物質定性半定量検査。
- D002 尿沈渣（鏡検法）。
- D003 糞便中ヘモグロビン。
- D005 赤血球沈降速度、末梢血液一般検査、HbA1c。
- D006 PT、FDP、Dダイマー。
- D007 別表第九の二に列挙された血液化学検査。
- D008 TSH、FT4、FT3。
- D009 CEA、AFP、PSA、CA19-9。
- D015 CRP。
- D017 細菌顕微鏡検査（その他のもの）。

なお、当日説明・文書提供・結果に基づく診療の有無は、EHR/検査結果説明/文書発行の実績から渡す必要がある。

## 医科電子点数表チェックロジック

`electronic_rules.check_electronic_rules()` は、医科電子点数表とコメント関連テーブルを使って、入力された診療行為コードに関連するチェック候補を返す。

現時点では、算定項目を自動削除しない。出力はあくまで advisory な検出結果であり、上位の算定エンジンが、入外区分、履歴、施設基準、DPC/出来高、診療録根拠と合わせて最終判断する。

入力。

```text
procedure_codes
service_date
medical_electronic_fee_table source_id
comment_related_table source_id
same_day_history_codes
same_week_history_codes
same_month_history_codes
procedure_history_events
```

出力。

- `bundles`
  - 包括元コード、包括対象コード、包括グループ。
- `exclusions`
  - 背反テーブル種別、対象スコープ、元コード、背反対象コード、当日/週/月履歴との一致状況。
- `frequency_limits`
  - 算定回数制限コード、制限名称。
- `frequency_limit_breaches`
  - 算定回数制限について、履歴に同一コードがある場合の抵触候補。
  - `日`、`週`、`月` は既存のコード集合履歴でも判定する。
  - `２週`、`２月`、`３月`、`４月`、`６月`、`１２月`、`５年` は日付つき履歴 `procedure_history_events` で判定する。
- `required_comments`
  - 診療行為コードに紐づくコメントコード、コメント文言。

現時点の注意点。

- 電子点数表の背反関係は方向を持つため、相互に登録されている場合は2件検出される。
- 算定回数テーブルは、同一コードの履歴一致を `frequency_limit_breaches` として返す。これは自動削除ではなくレビュー候補である。
- `一連`、`初回`、`入院中`、`退院時` などは、患者状態や入退院イベントの入力が必要なため、現時点では制限定義のadvisoryにとどめる。
- コメント関連テーブルの `requirement_kind` の詳細意味づけは今後辞書化する。
- 包括検出は、補助マスターのグループコードと包括テーブルを使う。実際に除外するかは、診療区分と通知ルールで判断する。

## 検体検査MVPの統合入口

`lab_calculator.calculate_lab_claim()` は、検体検査MVPで上位アプリケーションが呼ぶ入口である。

入力。

```text
procedure_codes
service_date
medical_procedure_source_id
electronic_fee_source_id
comment_source_id
hospital_profile または facility_standard_keys
same_day_history_codes
same_week_history_codes
same_month_history_codes
procedure_history_events
already_billed_judgement_groups
already_billed_lab_management_same_month
collection_fee_inputs
already_billed_collection_fee_codes_same_day
is_outpatient
outpatient_rapid_lab_eligible_test_item_count
outpatient_rapid_lab_same_day_result_explained
outpatient_rapid_lab_written_information_provided
outpatient_rapid_lab_result_based_care_provided
already_billed_outpatient_rapid_lab_items_same_day
```

処理順。

1. 入力コードの重複と空文字を除く。
2. 請求内にすでにD026判断料がある場合、そのグループは二重追加しない。
3. D000-D024の検体検査実施料からD026判断料候補を追加する。
4. D026追加後のコード群を使い、施設基準 `検Ⅰ/検Ⅱ/検Ⅲ/検Ⅳ` に応じて検体検査管理加算候補を追加する。
5. 明示された採取料入力からD400-D419の採取料候補を追加する。
6. 外来迅速検体検査加算の要件が明示されていれば、1日5項目上限で候補を追加する。
7. D026・検体検査管理加算・採取料・外来迅速検体検査加算を含めた候補コード群に対して、医科電子点数表とコメント関連テーブルのadvisoryを取得する。

出力。

- `claim_items`
  - 新たに追加すべき候補。現時点ではD026判断料、検体検査管理加算、明示入力された採取料、外来迅速検体検査加算。
- `candidate_procedure_codes`
  - 入力コードと追加候補を合わせた診療行為コード。
- `d026`
  - D026追加結果、除外グループ、警告。
- `lab_management`
  - 検体検査管理加算の候補または除外理由。
- `collection_fees`
  - 採取料候補、除外入力、警告。
- `outpatient_rapid_lab`
  - 外来迅速検体検査加算候補、対象検査、対象項目数、算定項目数、検査名コメント、除外理由、警告。
- `electronic_rules`
  - 包括、背反、算定回数、必須コメント候補。
- `warnings`
  - hospital profile不足、履歴不足、算定回数制限抵触候補など、人手確認が必要な警告。

## 共通ClaimContext/CalculationResult

領域別エンジンを増やす前提で、検体検査MVPにも共通の入力・出力モデルを追加した。

`claim_models.ClaimContext` は、患者、診療日、入外区分、入院日/退院日、医療機関コード、入力済み診療行為コード、医薬品・注射薬・特定器材、処置オーダー、画像診断オーダー、公式マスターsource、患者履歴、検体検査・外来基本料・投薬・注射・入院基本料・DPCの固有オプション、データ完全性をまとめて保持する。

主な構造。

```text
ClaimContext
  patient
  encounter
    regional_bureau optional
    medical_institution_code optional
  procedure_codes
  drug_inputs
  medication_orders
  injection_drug_inputs
  injection_orders
  treatment_orders
  imaging_orders
  material_inputs
  master_sources
  history
  lab_options
  outpatient_basic
  medication
  injection
  inpatient_basic
  dpc
  data_completeness
  hospital_profile optional
  facility_standard_keys optional
```

`lab_calculator.calculate_lab_claim_for_context()` は `ClaimContext` から既存の `LabCalculationContext` を作り、検体検査MVPを実行する。`hospital_profile` が明示されておらず、`encounter.medical_institution_code` がある場合は、`get_hospital_profile()` で医療機関プロファイルを解決する。医療機関コードは地方厚生局をまたぐと重複し得るため、`encounter.regional_bureau` があれば地域込みで解決する。

解決した `hospital_profile` は、`default_run_classification`、`default_run_recommended_action`、`included_in_default_medical_run` を持つ。全国既定実行から除外すべき医療機関では `default_medical_run_excluded: <classification>`、施設基準未突合だが警告付きで含める医療機関では `facility_standards_not_found` を `warnings` に入れる。検体検査MVPではこれらを `hospital_profile_warning` として `ReviewWarning` に流し、自動確定ではなくレビュー対象にできる。

`lab_calculator.calculate_lab_claim_standardized()` は、詳細な `LabCalculationResult` を、領域横断で扱いやすい `CalculationResult` に変換する。

標準出力。

- `input_codes`
  - 入力された診療行為コード、医薬品コード、注射薬コード、特定器材コード。
- `lines`
  - 入力済み診療行為コードの素点行と、自動追加候補。
  - 入力済み診療行為・医薬品・注射薬・特定器材は `confirmed`、初診料・再診料・外来診療料、調剤料・処方料・処方箋料、注射手技料、処置料、画像診断料、入院基本料、D026判断料・検体検査管理加算・採取料・外来迅速検体検査加算は `candidate` として返す。
- `messages`
  - 包括、背反、必須コメント、履歴不足、施設基準不足、スキップ理由などのレビュー候補。
- `total_candidate_points`
  - `candidate` 行の合計点数。
- `total_confirmed_points`
  - `confirmed` 行の合計点数。
- `total_points`
  - `lines` 全体の合計点数。
- `candidate_codes`
  - 入力コードと追加候補を重複排除したコード列。

`procedure_resolver.resolve_medical_procedure_lines()` は、医科診療行為マスターから入力済み診療行為コードの名称・点数を解決する。

`procedure_resolver.resolve_drug_lines()` は、医薬品マスターから入力済み医薬品コードの名称・薬価を解決し、医科診療報酬点数表の薬剤料の式に寄せて `confirmed` 行を返す。具体的には、数量集約後の総薬価が15円以下なら0点、15円を超える場合は `(総薬価 - 15円) / 10円` の1点未満を切り上げ、さらに1点を加える。投薬薬剤と注射薬剤はどちらも薬剤料として解決するが、投薬基本料の判定には `drug_inputs` と `medication_orders` だけを使い、`injection_drug_inputs` と `injection_orders` は注射側の入力として扱う。

`medication_orders.resolve_medication_order_inputs()` は、構造化した `MedicationOrder` から薬剤の総使用量を計算し、`ChargeInput` に変換する。次の優先順で総量を作る。

1. `total_quantity`
2. `quantity_per_day x days`
3. `dose_quantity x doses_per_day x days`

`dispensing_kind` が指定されている場合は、F000調剤料候補の入力にも使う。総量を計算できないオーダーは `needs_review` メッセージを返し、薬剤料には渡さない。

`injection_orders.resolve_injection_order_inputs()` は、構造化した `InjectionOrder` から注射薬の総使用量を計算し、`ChargeInput` に変換する。次の優先順で総量を作る。

1. `total_quantity`
2. `dose_quantity x administrations`

同じ薬剤コードは数量集約する。総量を計算できないオーダー、または薬剤コードが空のオーダーは `needs_review` メッセージを返し、薬剤料には渡さない。

`procedure_resolver.resolve_specific_material_lines()` は、特定器材マスターから入力済み特定器材コードの名称・材料価格を解決し、数量集約後の総材料価格を10円で除した点数を四捨五入して `confirmed` 行を返す。上限価格、材料単位、酸素等区分、年齢加算などの最終適用は今後の材料エンジンで行う。

`outpatient_basic.calculate_outpatient_basic_fee()` は、`ClaimContext.outpatient_basic` の明示入力に基づいて、初診料・再診料・外来診療料の候補を返す。現時点では、患者履歴や傷病の継続性から初診/再診を自動推定しない。上位システムが `initial`、`revisit`、`outpatient_clinic` を指定し、必要に応じて情報通信機器、同日2科目、同日再診、大病院紹介なし受診のフラグを渡す。

代表コード。

| 区分 | 通常 | 情報通信機器 |
| --- | --- | --- |
| 初診料 | `111000110` | `111014210` |
| 再診料 | `112007410` | `112024210` |
| 外来診療料 | `112011310` | `112024710` |

`medication_fees.calculate_medication_fees()` は、`ClaimContext.medication` の明示入力に基づいて、外来投薬のF000調剤料、F100処方料、F400処方箋料の候補を返す。薬剤コードだけでは、院内投薬か院外処方か、内服/外用の調剤料対象か、リフィル処方箋かを確定できないため、明示入力を前提にする。

主な対応。

| 入力 | 代表コード | 名称 |
| --- | --- | --- |
| 院内投薬 + 内服/屯服等 | `120000710` | 調剤料（内服薬・浸煎薬・屯服薬） |
| 院内投薬 + 外用 | `120001010` | 調剤料（外用薬） |
| 院内投薬 + その他処方 | `120001210` | 処方料（その他） |
| 院外処方 + その他 | `120002910` | 処方箋料（リフィル以外・その他） |
| 院外処方 + リフィル + 特定保険薬局関係 | `120006510` | 処方箋料（リフィル処方箋・その他・特定保険薬局） |

うがい薬のみの投薬は、F000/F100/F400を候補化せず `blocked` メッセージを返す。7種類以上内服薬、向精神薬多剤投与、向精神薬長期処方の区分は `MedicationPrescriptionCategory` で明示する。

投薬加算も明示入力で候補化する。

| 入力 | 院内投薬 | 院外処方 |
| --- | --- | --- |
| 特定疾患処方管理加算 | `120005610` | `120005710` |
| 抗悪性腫瘍剤処方管理加算 | `120003370` | `120003470` |
| 一般名処方加算1 | - | `120004270` |
| 一般名処方加算2 | - | `120003570` |

特定疾患処方管理加算と抗悪性腫瘍剤処方管理加算は月1回制限があるため、同月既算定フラグがある場合は候補化せず `blocked` メッセージを返す。一般名処方加算はF400処方箋料側だけで扱い、院内投薬に指定された場合は `needs_review` とする。

この入口でも、包括・背反・算定回数に基づく自動削除は行わない。過剰請求方向の誤りを避けるため、電子点数表の結果はレビュー候補として返し、上位の外来出来高エンジンで最終適用する。

`injection_fees.calculate_injection_fees()` は、`ClaimContext.injection` の明示入力に基づいて、注射手技料と一部加算の候補を返す。薬剤コードだけでは、注射経路、点滴の年齢区分、入外区分別の点滴区分、生物学的製剤・麻薬・精密持続点滴の加算対象を確定できないため、明示入力を前提にする。

主な対応。

| 入力 | 代表コード | 名称 |
| --- | --- | --- |
| 皮内・皮下・筋肉内注射 | `130000510` | 皮内、皮下及び筋肉内注射 |
| 静脈内注射 | `130003510` | 静脈内注射 |
| 点滴注射 + 乳幼児 | `130003710` | 点滴注射（乳幼児） |
| 点滴注射 + 標準 | `130003810` | 点滴注射 |
| 点滴注射 + 入院外その他 | `130009310` | 点滴注射（その他）（入院外） |
| 中心静脈注射 | `130004410` | 中心静脈注射 |
| 関節腔内注射 | `130005310` | 関節腔内注射 |
| 硝子体内注射 | `130012010` | 硝子体内注射 |

注射加算も明示入力で候補化する。

| 入力 | 代表コード | 名称 |
| --- | --- | --- |
| 生物学的製剤注射加算 | `130000110` | 生物学的製剤注射加算 |
| 麻薬注射加算 | `130000310` | 麻薬注射加算 |
| 精密持続点滴注射加算 | `130000210` | 精密持続点滴注射加算 |

請求内に同じ注射手技料・加算コードがすでにある場合は、二重追加せず `blocked` メッセージを返す。皮内・皮下・筋肉内注射と静脈内注射は、入院中患者では手技料候補を返さず薬剤料側だけにする。現時点では、輸液量、投与時間、同日複数注射のまとめ、薬剤別の加算対象判定、その他の入院中包括関係は自動判定しない。

`treatment_fees.calculate_treatment_fees()` は、`ClaimContext.treatment_orders` の明示入力に基づいて、外来で頻出する一部のJ区分処置料候補を返す。処置名の自然文から自動推定せず、面積が必要な処置では `TreatmentAreaSizeKind` を必須にする。請求内に同じ処置コードがすでにある場合、または同じコードになる処置オーダーが重複した場合は、二重追加せず `blocked` メッセージを返す。

主な対応。

| 入力 | 代表コード | 名称 |
| --- | --- | --- |
| 創傷処置 100cm2未満 | `140000610` | 創傷処置（100cm2未満） |
| 創傷処置 100cm2以上500cm2未満 | `140000710` | 創傷処置（100cm2以上500cm2未満） |
| 熱傷処置 100cm2以上500cm2未満 | `140032110` | 熱傷処置（100cm2以上500cm2未満） |
| 皮膚科軟膏処置 100cm2以上500cm2未満 | `140011610` | 皮膚科軟膏処置（100cm2以上500cm2未満） |
| 消炎鎮痛等処置 手技 | `140029610` | 消炎鎮痛等処置（マッサージ等の手技による療法） |
| 消炎鎮痛等処置 器具 | `140040310` | 消炎鎮痛等処置（器具等による療法） |
| 消炎鎮痛等処置 湿布 | `140002210` | 消炎鎮痛等処置（湿布処置） |
| 鼻腔栄養 | `140023210` | 鼻腔栄養 |
| 留置カテーテル設置 | `140013810` | 留置カテーテル設置 |
| 爪甲除去 | `140032750` | 爪甲除去 |

創傷処置、熱傷処置、皮膚科軟膏処置は面積区分ごとにコードを選ぶ。現時点では、複数部位の面積合算、在宅指導管理料などによる包括、処置薬剤・材料、乳幼児加算、時間外・休日・深夜加算、診療録記載要件の充足は自動判定しない。

`imaging_fees.calculate_imaging_fees()` は、`ClaimContext.imaging_orders` の明示入力に基づいて、E区分の一部画像診断料候補を返す。画像オーダー名や撮影部位の自然文から自動確定せず、単純撮影では写真診断区分と撮影方式、CTでは機器区分、MRIではテスラ区分を明示する。必須入力が不足している場合は候補を返さず `needs_review` にする。請求内に同じ画像診断コードがすでにある場合、または同じコードになる画像オーダーが重複した場合は、二重追加せず `blocked` メッセージを返す。

主な対応。

| 入力 | 代表コード | 名称 |
| --- | --- | --- |
| 単純撮影（イ）の写真診断 | `170000410` | 単純撮影（イ）の写真診断 |
| 単純撮影 デジタル撮影 | `170027910` | 単純撮影（デジタル撮影） |
| 電子画像管理加算 単純撮影 | `170000210` | 電子画像管理加算（単純撮影） |
| 造影剤使用撮影の写真診断 | `170000810` | 造影剤使用撮影の写真診断 |
| 造影剤使用撮影 デジタル撮影 | `170028110` | 造影剤使用撮影（デジタル撮影） |
| 乳房撮影の写真診断 | `170026910` | 乳房撮影の写真診断 |
| 乳房撮影 デジタル撮影 | `170028210` | 乳房撮影（デジタル撮影） |
| CT その他 | `170011710` | CT撮影（イからニまで以外） |
| CT 造影剤使用加算 | `170012070` | 造影剤使用加算（CT） |
| MRI 3テスラ以上 その他 | `170033510` | MRI撮影（3テスラ以上の機器）（その他） |
| MRI 造影剤使用加算 | `170020470` | 造影剤使用加算（MRI） |
| 電子画像管理加算 CT/MRI | `170028810` | 電子画像管理加算（コンピューター断層診断料） |
| 画像診断管理加算1 写真診断 | `170025210` | 画像診断管理加算1（写真診断） |
| 画像診断管理加算1 CT/MRI | `170025510` | 画像診断管理加算1（コンピューター断層診断） |
| 画像診断管理加算2 CT/MRI | `170025710` | 画像診断管理加算2（コンピューター断層診断） |
| 画像診断管理加算3 CT/MRI | `170702410` | 画像診断管理加算3（コンピューター断層診断） |
| 画像診断管理加算4 CT/MRI | `170035810` | 画像診断管理加算4（コンピューター断層診断） |
| 遠隔画像診断管理加算2 CT/MRI | `170026310` | 遠隔画像診断管理加算2（コンピューター断層診断） |

現時点では、単純撮影の複数方向・複数部位の逓減、他医撮影の写真診断、共同利用施設の施設基準判定、CT/MRIの詳細な部位別加算、造影剤薬剤料・材料、核医学/PET、同月複数回ルールの最終適用は自動判定しない。画像診断管理加算と遠隔画像診断管理加算は、`diagnostic_management_add_on` / `remote_diagnostic_management_add_on` が明示された場合に、施設基準辞書の `画１` - `画４` / `遠画` から候補化する。

`inpatient_fees.calculate_inpatient_fees()` は、`ClaimContext.inpatient_basic` の明示入力に基づいて入院基本料候補を返し、`ClaimContext.dpc` の入力がある場合はDPCレビューmessageを返す。入院基本料は、`basic_fee_code` と `basic_fee_days` を必須の事実として扱い、医科診療行為マスターから点数を解決する。`facility_standard_key` または `ward_kind` が指定された場合は、施設基準辞書で内部rule keyへ正規化し、claim/hospital profileの `facility_standard_keys` に該当届出がなければ候補化せず `needs_review` にする。

主な対応。

| 入力 | 挙動 |
| --- | --- |
| `basic_fee_code` + `basic_fee_days` | 入院基本料を候補化 |
| `facility_standard_key` / `ward_kind` | 施設基準辞書と `facility_standard_keys` で届出確認 |
| `inpatient_basic_code` | `electronic_inpatient_basic` との対応確認 |
| `dpc_claim` / `dpc_code` | 自動計算せず `dpc_claim needs_review` |

DPCは、診断群分類、期間I/II/III、医療機関別係数、包括/出来高分離を専用エンジンで扱う必要があるため、この入口では点数を確定しない。現時点では、病棟・転棟履歴からの入院料自動選択、入退院日からの日数自動算出、入院料加算、食事・生活療養、入院中包括も自動判定しない。

## 実装済みスコープ

現時点では、次を実装済み。

- SQLite schema。
- 医科診療行為マスター importer。
- 医薬品マスター importer。
- 特定器材マスター importer。
- コメントマスター importer。
- コメント関連テーブル importer。
- 医科電子点数表 importer。
- `lab_procedure_catalog` view。
- `lab_judgement_fee_map` view。
- D026判断料追加ロジック。
- 検体検査管理加算候補追加ロジック。
- 採取料候補追加ロジック。
- 外来迅速検体検査加算候補追加ロジック。
- 初診料・再診料・外来診療料の候補追加ロジック。
- F000調剤料・F100処方料・F400処方箋料の候補追加ロジック。
- 特定疾患処方管理加算、抗悪性腫瘍剤処方管理加算、一般名処方加算の候補追加ロジック。
- 検体検査MVPの統合入口 `calculate_lab_claim()`。
- 医科電子点数表に基づく包括・背反・算定回数候補の検出ロジック。
- 医科電子点数表に基づく同一コードの算定回数制限抵触候補の検出ロジック。
- コメント関連テーブルに基づく必須コメント候補の検出ロジック。
- 地方厚生局の医療機関コード一覧 importer。
  - 北海道互換レイアウトのExcel、またはZIP内の複数Excelを `import_regional_hospital_registry()` で取り込める。
  - カンマ区切り、ハイフン区切り、中点区切り、区切りなしの7桁コード表記を同じ医療機関コードとして正規化する。
  - ZIPの場合は、内部の `.xlsx` を地方厚生局キーごとにまとめて同一sourceとして取り込む。医科・歯科・薬局が同一ZIPに入る場合は医科ワークブックだけを対象にする。
  - 互換維持のため `import_hokkaido_hospital_registry()` も残している。
- 地方厚生局の施設基準届出 importer。
  - 24列の施設基準届出Excel、またはZIP内の複数Excelを `import_regional_facility_standards()` で取り込める。
  - ZIPの場合は、内部の `.xlsx` を地方厚生局キーごとにまとめて同一sourceとして取り込む。
  - 互換維持のため `import_hokkaido_facility_standards()` も残している。
- 地方厚生局ファイルの一括投入 manifest。
  - `import_regional_manifest()` で、ローカルに取得済みの医療機関コード一覧と施設基準届出ファイルをJSON manifestから順に取り込める。
  - CLIは `import-regional-manifest --manifest <json>`。
- 地方厚生局manifest smoke report。
  - `run_regional_manifest_smoke()` で、manifest各entryを1件ずつ取り込み、成功/失敗、件数、source_id、checksum、失敗理由を返せる。
  - 途中のentryが失敗しても全体の検証を継続する。
  - CLIは `smoke-regional-manifest --manifest <json> --format markdown|json|tsv`。
- 地方厚生局の病院台帳品質サマリ。
  - `summarize_hospital_registry_quality()` で、医科全体名簿から病院数、現存病院数、施設基準届出との突合有無を地方厚生局別に集計できる。
  - CLIは `summarize-hospital-registry --db <sqlite> --format markdown|json|tsv`。
  - `list_unmatched_active_hospitals()` で、現存病院だが施設基準届出と突合できない医療機関を一覧化できる。
  - 未突合現存病院は `facility_standards_missing`、`clinic_named_registry_review`、`dental_hospital_scope_review` に分類し、既定実行に含めるか除外するかを示す。
  - CLIは `list-unmatched-active-hospitals --db <sqlite> --format markdown|json|tsv`。
  - `summarize_hospital_run_targets()` と `list_hospital_run_targets()` で、全国既定実行に含める医科病院と除外候補を分類できる。
  - 既定実行では `facility_standards_matched` を含め、`facility_standards_missing` は `facility_standards_not_found` warning付きで含める。`clinic_named_registry_review` と `dental_hospital_scope_review` は除外する。
  - CLIは `summarize-hospital-run-targets --db <sqlite> --format markdown|json|tsv` と `list-hospital-run-targets --db <sqlite> --format markdown|json|tsv`。除外候補も出す場合は `list-hospital-run-targets --include-excluded`。
- 全国既定実行対象のprofile batch smoke。
  - `smoke_hospital_run_targets()` で、既定実行対象または除外候補込みの全医療機関について `get_hospital_profile()` を解決し、対象分類との不整合を検出できる。
  - 2026-06-01時点の実データでは、既定実行対象7,094件はOK 7,094 / Non-OK 0 / warnings 4。除外候補込み7,103件はOK 7,103 / Non-OK 0 / warnings 13。
  - CLIは `smoke-hospital-run-targets --db <sqlite> --service-date <YYYY-MM-DD> --format markdown|json|tsv`。CIで不整合を失敗扱いにする場合は `--fail-on-error`。
- 全国既定実行対象のClaimContextテンプレート出力。
  - `build_hospital_claim_run_contexts()` で、病院別に `service_date`、`regional_bureau`、`medical_institution_code`、`facility_standard_keys`、profile warningを持つ `ClaimContext` テンプレートを作れる。
  - `HospitalClaimRunContext.to_claim_context()` で、実患者ID・診療行為コード・master sourceを注入した `ClaimContext` に変換できる。
  - 2026-06-01時点の実データでは、既定実行対象7,094件をJSONLとして出力済み。出力先は `data/work/nationwide-claim-contexts-2026-06-01.jsonl`。
  - CLIは `export-hospital-claim-contexts --db <sqlite> --service-date <YYYY-MM-DD> --format jsonl|json|tsv|markdown`。除外候補も出す場合は `--include-excluded`。
- 地方厚生局公式ページcatalog。
  - `list_regional_source_pages()` で、8地方厚生局/支局の医療機関コード一覧・施設基準届出ページを参照できる。
  - CLIは `list-regional-source-pages`。
- 地方厚生局公式ページHTML discovery。
  - `discover_regional_source_files()` で、保存済みHTMLから `.xlsx`、`.xls`、`.zip`、`.pdf` リンクを抽出できる。
  - `.xlsx`、`.xls`、`.zip` はimport可能候補、`.pdf` はPDF fallback候補として区別する。
  - `select_regional_source_file_candidates()` で、医科・全体版・施設基準/コード一覧を優先し、歯科・薬局・訪問看護・保険外併用・直近分などを下げるスコア順に並べられる。
  - 関東信越・近畿のような入院基本料・特定入院料の補助Excel/ZIPは施設基準として推奨候補に含める。
  - `build_manifest_template()` で、import可能候補だけを `data/raw/kouseikyoku/<regional_bureau>/<source_version>/<kind>/<filename>` 形式のローカル保存先つきmanifest雛形へ変換できる。
  - CLIは `discover-regional-source-files --html <saved-html> --regional-bureau <key> --kind <kind>`。推奨候補に絞る場合は `--recommended-only`。
- 地方厚生局公式ページdownloader。
  - `download_regional_source_files_from_page()` で、公式ページHTMLを取得・raw保存し、推奨候補Excel/ZIPをraw配下へ保存し、manifest JSONを生成できる。
  - `download_regional_source_catalog()` で、catalog全体または指定した地方厚生局/種別だけをbatch取得し、成功分のmanifestを結合し、失敗ページをレポートできる。
  - HTML取得とファイル取得は差し替え可能なfetcher経由にしており、テストでは外部通信を使わない。
  - CLIは `download-regional-source-files --regional-bureau <key> --kind <kind> --source-version <version>`。
  - catalog全体のCLIは `download-regional-catalog --source-version <version>`。
- `get_hospital_profile()`。
  - 算定日時点の施設基準に加え、全国既定実行対象かどうかを `default_run_classification`、`default_run_recommended_action`、`included_in_default_medical_run` として返す。
  - `regional_bureau` を指定できる。全国バッチでは `regional_bureau + medical_institution_code` で解決し、地方厚生局をまたぐ同一7桁コードの誤突合を避ける。
  - 歯科系病院、病床情報がないクリニック名、現存病院以外は `default_medical_run_excluded` warningを返す。
- 共通入力モデル `ClaimContext`。
- 共通出力モデル `CalculationResult`。
- 医科診療行為マスターから入力コードの素点行を作る `resolve_medical_procedure_lines()`。
- `MedicationOrder` から総薬剤数量を作る `resolve_medication_order_inputs()`。
- `InjectionOrder` から注射薬の総薬剤数量を作る `resolve_injection_order_inputs()`。
- 医薬品マスターから入力コードの素点行を作る `resolve_drug_lines()`。
- 特定器材マスターから入力コードの素点行を作る `resolve_specific_material_lines()`。
- 初診料・再診料・外来診療料候補を作る `calculate_outpatient_basic_fee()`。
- 調剤料・処方料・処方箋料候補を作る `calculate_medication_fees()`。
- 注射手技料・注射加算候補を作る `calculate_injection_fees()`。
- 一部J区分処置料候補を作る `calculate_treatment_fees()`。
- 一部E区分画像診断料候補を作る `calculate_imaging_fees()`。
- 入院基本料候補とDPCレビュー入口を作る `calculate_inpatient_fees()`。
- `ClaimContext` から検体検査MVPを実行する `calculate_lab_claim_for_context()`。
- 検体検査MVP結果を共通出力へ変換する `calculate_lab_claim_standardized()`。
- 小さなunittest。

未実装の主要範囲。

- 傷病名・修飾語マスター importer。
- 施設基準届出と突合できない現存病院の原因確認と補正。
- 地方厚生局ごとのPDFのみ公開ファイルへの対応。
- 電子点数表を使った包括・背反チェック結果の最終適用ロジック。
- `一連`、`初回`、`入院中`、`退院時` など、患者状態や入退院イベントが必要な算定回数制限。
- 外来迅速検体検査加算の対象検査辞書の継続更新と、外注/院内実施の判定。
- 注射の輸液量、投与時間、同日複数注射、薬剤別加算対象、入院中包括の厳密判定。
- 処置の複数部位合算、在宅指導管理料などによる包括、処置薬剤・材料、乳幼児加算、時間外・休日・深夜加算、診療録記載要件の厳密判定。
- 画像診断の複数方向・複数部位逓減、共同利用施設の施設基準、核医学/PET、造影剤薬剤料・材料の厳密判定。
- 病棟・転棟履歴からの入院料自動選択、入院料加算、食事・生活療養、入院中包括。
- DPC電子点数表、DPC係数、診断群分類、期間I/II/III、包括/出来高分離を扱うDPC概算エンジン。
