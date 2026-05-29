# 外来入力Schema棚卸し

## 目的

検体検査MVPを外来全体へ広げる前に、`ClaimContext`、order CSV adapter、領域別calculatorが受けられる入力と、不足している入力を整理する。

この棚卸しは、実病院CSV contractを作るときの標準列候補と、次の実装対象を決めるための基準である。

## 現在の結論

`ClaimContext` は外来主要領域をすでに表現できる。

対応済みの大枠。

- 基本キー: 患者、診療日、地方厚生局、医療機関コード、入外区分。
- 明細: 診療行為、薬剤、特定器材、コメント。
- 構造化オーダー: 投薬、注射、処置、画像診断。
- 外来基本料、投薬、注射、検体検査のoption。
- 同日、同週、同月、日付つき診療行為履歴。
- gold評価用の点数、status、候補コード。

Step4で、JSON payloadだけでなく一般的な日本語CSV列名からも主要外来領域を取り込める状態にした。`japanese` presetは、初再診、投薬、注射、処置、画像診断、検体検査、履歴、gold列の一般aliasを持つ。病院固有列名は引き続き病院別 `column_map` / `contract` で固定する。

## 標準レコードキー

外来CSVでは、次のどちらかを必須にする。

| 方法 | 必須列 |
| --- | --- |
| 明示ID | `record_id` |
| 複合キー | `patient_id`, `service_date`, `regional_bureau`, `medical_institution_code` |

`record_id` は1患者1診療日1請求単位にする。複数患者・複数日が混ざるCSVでは、必ずこの単位で行をgroup化する。

## 共通CSV標準列

| 標準列 | 用途 | 状態 |
| --- | --- | --- |
| `record_id` | 請求/診療単位のgroup key | 対応済み |
| `patient_id` | 患者識別子 | 対応済み |
| `service_date` | 算定日 | 対応済み |
| `regional_bureau` | 地方厚生局キー | 対応済み |
| `medical_institution_code` | 保険医療機関コード | 対応済み |
| `is_outpatient` | 外来判定 | 対応済み |
| `item_kind` | 行の種別 | 対応済み |
| `code` / `procedure_code` / `drug_code` / `material_code` / `comment_code` | 明細コード | 対応済み |
| `quantity` | 薬剤/材料などの数量 | 対応済み |
| `facility_standard_keys` | 施設基準略称の明示上書き | 対応済み |
| `comment_text` | コメント本文 | 対応済み |
| `expected_total_points` | gold点数 | 対応済み |
| `expected_status` | gold status | 対応済み |
| `expected_candidate_codes` | gold候補コード | 対応済み |

`item_kind` の主な値。

| 値 | 変換先 |
| --- | --- |
| `procedure` | `procedure_codes` |
| `drug` | `drug_inputs` |
| `medication_order` | `medication_orders` |
| `injection_drug` | `injection_drug_inputs` |
| `injection_order` | `injection_orders` |
| `material` | `material_inputs` |
| `comment` | `comment_inputs` |
| `collection_fee` | `lab_options.collection_fee_inputs` |
| `same_day_history` / `same_week_history` / `same_month_history` | `history` |
| `facility_standard` | `facility_standard_keys` |
| `treatment` | `treatment_orders` |
| `imaging` | `imaging_orders` |
| `expected` | `expected` |
| `context` / `option` / `options` | 行内のscalar/list contextだけ反映 |

## 領域別棚卸し

### 1. 診療行為共通

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 診療行為コード | `procedure_codes` | `item_kind=procedure`, `code` | 対応済み |
| 既に請求に含まれるコードの重複抑止 | `procedure_codes` | 同上 | 対応済み |
| 日付つき履歴 | `history.procedure_history_events[]` | 未標準 | JSONのみ対応 |

不足。

- CSVから `procedure_history_events[]` を組み立てる標準列がない。
- 診療科、医師、実施部署、算定単位番号は未保持。外来MVPでは必須にしないが、将来の同日複数科や包括判定で必要になる。

### 2. 初再診・外来基本料

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 初診/再診/外来診療料 | `outpatient_basic.fee_kind` | `fee_kind` / `outpatient_basic_fee_kind` | 対応済み |
| 情報通信機器 | `information_communication_equipment` | 同名列 | 対応済み |
| 同日2科目 | `same_day_second_department` | 同名列 | 対応済み |
| 同日再診 | `same_day_revisit` | 同名列 | 対応済み |
| 大病院紹介なし | `large_hospital_no_referral` | 同名列 | 対応済み |

不足。

- 日本語presetに `初再診区分`、`情報通信機器`、`同日2科目` などのaliasがない。
- 時間外、休日、深夜、乳幼児などの初再診加算は未実装。

### 3. 投薬

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 薬剤コード+数量 | `drug_inputs[]` | `item_kind=drug`, `drug_code/code`, `quantity` | 対応済み |
| 構造化投薬 | `medication_orders[]` | `item_kind=medication_order` | 対応済み |
| 1日量、日数、1回量、回数 | `quantity_per_day`, `days`, `dose_quantity`, `doses_per_day` | 同名列 | 対応済み |
| 内服/外用調剤種別 | `dispensing_kind` / `dispensing_kinds` | 同名列 | 対応済み |
| 院内/院外 | `medication.delivery_kind` | `delivery_kind` / `medication_delivery_kind` | 対応済み |
| 処方区分 | `prescription_category` | 同名列 | 対応済み |
| リフィル、特定保険薬局関係 | `refill_prescription`, `special_pharmacy_relationship` | 同名列 | 対応済み |
| 特定疾患/抗悪性腫瘍/一般名処方加算 | `medication.*` | 同名列 | 対応済み |

不足。

- 日本語presetに投薬optionのaliasがない。
- 薬剤単位、用法、服用タイミング、剤グループ、外用/頓服の詳細は未保持。
- 特定疾患処方管理加算などの同月履歴は専用boolのみで、汎用履歴イベントとはまだ統合していない。

### 4. 注射

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 注射薬コード+数量 | `injection_drug_inputs[]` | `item_kind=injection_drug`, `drug_code/code`, `quantity` | 対応済み |
| 構造化注射薬 | `injection_orders[]` | `item_kind=injection_order` | 対応済み |
| 投与量、回数 | `total_quantity`, `dose_quantity`, `administrations` | 同名列 | 対応済み |
| 注射手技区分 | `injection.route_kind` | `route_kind` / `injection_route_kind` | 対応済み |
| 乳幼児、入院外点滴その他 | `infant`, `drip_infusion_outpatient_other` | 同名列 | 対応済み |
| 生物学的製剤/麻薬/精密持続点滴加算 | `biologic_add_on`, `narcotic_add_on`, `precision_continuous_infusion_add_on` | 同名列 | 対応済み |

不足。

- `route_kind` はclaim単位のoptionであり、1請求内に複数の注射経路が混在する場合は表現が弱い。
- 日本語presetに注射optionのaliasがない。
- 点滴時間、年齢区分の自動判定、同一日複数手技の扱いは未実装。

### 5. 処置

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 処置種別 | `treatment_orders[].kind` | `item_kind=treatment`, `kind/code` | 対応済み |
| 面積区分 | `area_size` | 同名列 | 対応済み |

不足。

- CSVでは `item_kind` と処置の `kind` を別列にする必要がある。`種別` を `item_kind` に使う場合、処置種別用の別列をcolumn mapで `kind` へ割り当てる。
- 部位、左右、個数、回数、創傷処置の複数部位集約は未保持。
- 日本語presetに `処置種別`、`面積区分` のaliasがない。

### 6. 画像診断

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 画像種別 | `imaging_orders[].kind` | `item_kind=imaging`, `kind/code` | 対応済み |
| アナログ/デジタル | `acquisition_kind` | 同名列 | 対応済み |
| 写真診断区分 | `radiography_diagnostic_kind` | 同名列 | 対応済み |
| CT/MRI機器区分 | `ct_equipment_kind`, `mri_equipment_kind` | 同名列 | 対応済み |
| 頭部、共同利用、造影、電子画像管理 | `head`, `joint_use`, `contrast`, `electronic_image_management` | 同名列 | 対応済み |
| 画像診断管理加算 | `diagnostic_management_add_on` | `画像診断管理加算` / `画像診断管理` | 対応済み |
| 遠隔画像診断管理加算 | `remote_diagnostic_management_add_on` | `遠隔画像診断管理加算` / `遠隔画像診断` | 対応済み |

不足。

- CSVでは `item_kind` と画像の `kind` を別列にする必要がある。
- 部位はCT/MRIの `head` と `joint_use` 以外は未保持。
- 撮影回数、フィルム枚数、左右、同一日複数撮影の集約は未実装。
- 画像診断管理加算は施設基準辞書の `画１` - `画４` と `遠画` に依存する。核医学/PET、共同利用施設の厳密判定は未実装。

### 7. 検体検査

| 入力 | JSON | CSV | 状態 |
| --- | --- | --- | --- |
| 検査コード | `procedure_codes` | `item_kind=procedure`, `code` | 対応済み |
| 採取料 | `lab_options.collection_fee_inputs` | `collection_fee_inputs` / `item_kind=collection_fee` | 対応済み |
| 外来迅速検体検査加算の要件 | `outpatient_rapid_lab_*` | 同名列 | 対応済み |
| 検体検査管理加算の施設基準なしpolicy | `lab_management_facility_missing_policy` | 同名列 | 対応済み |
| 必須コメント入力 | `comment_inputs` | `item_kind=comment` | 対応済み |

不足。

- 検査結果値、検査材料、院内/外注、実施部署などは未保持。
- コメントはコード/本文で充足判定できるが、コメント生成に必要な可変値の構造化は未実装。

## CSV preset拡張状況

`japanese` presetは、基本キー、明細種別、コード、数量、コメント、施設基準、gold列に加え、外来全体の主要aliasを扱う。

| 領域 | 対応alias例 | target |
| --- | --- | --- |
| 初再診 | `初再診区分`, `基本料区分` | `fee_kind` |
| 初再診 | `情報通信機器`, `同日二科目`, `同日再診`, `紹介状なし` | 各bool |
| 投薬 | `院内院外`, `処方区分`, `調剤種別`, `リフィル`, `一般名処方加算` | `medication.*` |
| 投薬 | `1日量`, `日数`, `1回量`, `1日回数` | `quantity_per_day`, `days`, `dose_quantity`, `doses_per_day` |
| 注射 | `注射経路`, `乳幼児`, `点滴その他`, `生物学的製剤加算`, `麻薬加算` | `injection.*` |
| 処置 | `処置種別`, `面積区分` | `kind`, `area_size` |
| 画像 | `画像種別`, `撮影方式`, `写真診断区分`, `CT機器`, `MRI機器`, `造影`, `電子画像管理` | `imaging_orders.*` |
| 履歴 | `同日履歴`, `同週履歴`, `同月履歴` | `history.*` |

病院CSVでは日本語列名の揺れが大きいため、presetへ入れるaliasは一般名だけにし、病院固有名は `column_map` に分離する。

## Step4実装結果

1. `japanese` presetへ外来主要optionの一般aliasを追加済み。
2. 非PHIの外来混在CSVサンプルを追加済み。
   - `data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv`
   - `contracts/order-csv/tohoku/0410001/outpatient-mixed-contract.json`
   - `contracts/order-csv/manifest.outpatient-mixed.example.json`
3. サンプルCSVから `ClaimContext` JSONLへ変換し、初再診、投薬、注射、処置、画像診断、検体検査の各フィールドへ入ることを回帰テスト化済み。
4. 外来全体向けCLI aliasを追加済み。
   - `run-outpatient-claim-batch`
   - `run-order-csv-outpatient-claim-batch`
   - 旧 `run-outpatient-lab-claim-batch` / `run-order-csv-outpatient-lab-batch` は互換用aliasとして残す。
5. gold差分分類で、`outpatient_basic_fee`、`medication_fee` / `medication_order`、`injection_fee` / `injection_order`、`treatment_fee`、`imaging_fee` のmessage sourceを外来領域別に分類済み。

## Step4確認コマンド

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv \
  --contract contracts/order-csv/tohoku/0410001/outpatient-mixed-contract.json \
  --format markdown
```

## 完了条件

- 完了。外来混在CSVのprofileで、算定に必要な列が `unmapped_columns` に残らない。
- 完了。contract validationがpassする。
- 完了。変換後JSONLに、各領域の `ClaimContext` フィールドが入る。
- 完了。batch結果のmessage sourceに、外来領域別の候補/警告が出る。
- 完了。gold差分が、入力contract、算定ロジック、マスター/施設基準、gold labelのいずれかへ戻せる。
