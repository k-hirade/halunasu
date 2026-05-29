# 全病院対応の調査結果と実装ロードマップ

## 調査日

2026-05-17

## 結論

全病院で診療報酬算定を実行するには、算定ルールエンジンだけでは足りない。中核になるのは、算定日時点の `hospital_profile` を作ることである。

`hospital_profile` は、次を統合した医療機関別の時点管理データである。

- 保険医療機関コード。
- 医療機関名、所在地、種別。
- 病院/診療所、病床種別、病床数。
- 施設基準の届出受理状況。
- 届出受理番号、算定開始年月日。
- DPC対象/準備/対象外。
- DPC医療機関別係数。
- 特定機能病院、地域医療支援病院、救急、周産期、がん拠点等の外部指定。

公開データだけでも、相当部分は構築できる。ただし、地方厚生局ごとに公開形式が異なるため、最初の大きな実装テーマは「全国の医療機関プロファイル正規化」である。

## 全病院対応のレベル定義

「全病院でおおまかな算定」といっても、精度段階を分ける必要がある。

### Level 1: マスター準拠の素点計算

入力された診療行為コード、薬剤コード、材料コードを点数化する。

必要データ。

- 医科診療行為マスター。
- 医薬品マスター。
- 特定器材マスター。
- コメントマスター。
- 算定日。

この段階では、施設基準、包括、同時算定不可、DPCは限定的にしか扱わない。

### Level 2: 外来出来高の施設基準対応

外来診療を対象に、施設基準・加算・コメント・回数制限を反映する。

必要データ。

- Level 1のデータ。
- 医科電子点数表。
- コメント関連テーブル。
- 医療機関別の施設基準届出。
- 同日・同月履歴。

### Level 3: 入院出来高

入院基本料、入院料加算、病棟単位の施設基準、包括範囲を扱う。

必要データ。

- Level 2のデータ。
- 病床種別、病棟、入院料区分。
- 施設基準の備考欄から取る病棟情報。
- 入院日、退院日、入院期間、転棟履歴。

### Level 4: DPC概算

DPC対象病院の入院を、診断群分類に基づいて概算する。

必要データ。

- DPC対象病院リスト。
- DPC電子点数表。
- 医療機関別係数。
- 主傷病、医療資源病名、副傷病。
- 手術・処置等1/2。
- 入院期間I/II/III。
- DPC包括範囲と出来高算定項目の分離。

### Level 5: 審査前レベルの算定支援

診療録、検査結果、医学的必要性、摘要欄記載まで踏み込む。完全自動ではなく `needs_review` を前提にする。

## 公式データソース

| 領域 | 主要ソース | 取得性 | 優先度 |
| --- | --- | --- | --- |
| 医科診療行為 | 支払基金 基本マスター | CSV/ZIP | 実装済み |
| 医薬品 | 支払基金 基本マスター | CSV/ZIP | 実装済み |
| 特定器材 | 支払基金 基本マスター | CSV/ZIP | 実装済み |
| コメント | 支払基金 基本マスター | CSV/ZIP | 高 |
| コメント関連 | 支払基金 コメント関連テーブル | CSV/ZIP | 高 |
| 傷病名・修飾語 | 支払基金 基本マスター | CSV/ZIP | 中 |
| 包括・背反・回数制限 | 支払基金 医科電子点数表 | CSV/ZIP | 高 |
| レセプト出力 | 支払基金 レセプト電算処理システム記録条件仕様 | PDF/仕様書 | 中 |
| 施設基準 | 各地方厚生局 届出受理医療機関名簿 | Excel/PDF/ZIP | 最高 |
| 保険医療機関コード | 各地方厚生局 コード内容別医療機関一覧表 | Excel/PDF | 最高 |
| 病床・診療科等 | 医療情報ネット（ナビイ）オープンデータ | オープンデータ | 中 |
| 病棟機能 | 病床機能報告 | オープンデータ | 中 |
| DPC分類 | 厚労省 DPC電子点数表 | Excel | 高 |
| DPC病院・係数 | 厚労省/DPC関連資料、地方厚生局届出 | Excel/PDF | 高 |
| 通知・疑義解釈 | 厚労省 令和8年度改定ページ | PDF | 高 |

## 医療機関別データの調査結果

### 保険医療機関コード

地方厚生局が「コード内容別医療機関一覧表」または「保険医療機関・保険薬局の指定一覧」を公開している。北海道厚生局では、令和8年4月1日時点の医科病院・医科診療所についてPDFとExcelが提供され、毎月上旬更新予定とされている。

このデータは `hospital_registry` の基礎にする。

必要な正規化項目。

- 地方厚生局。
- 都道府県。
- 医療機関コード。
- 医療機関名。
- 所在地。
- 病院/診療所。
- 現存/休止/廃止。
- 指定年月日。

### 施設基準届出

各地方厚生局が「届出受理医療機関名簿」を公開している。北海道厚生局では保険医療機関（医科）のPDFとExcelがあり、令和8年5月1日時点のファイルが公開されている。東北厚生局、近畿厚生局、東海北陸厚生局などもExcelまたはZIPを公開している。

このデータは `hospital_facility_standards` の基礎にする。

必要な正規化項目。

- 医療機関コード。
- 施設基準略称。
- 受理番号。
- 算定開始年月日。
- 備考。
- 病床数。
- 病棟名。
- 病棟種別。
- 入院料区分。
- 失効情報。

難所。

- 地方厚生局ごとにページ構成とファイル形式が違う。
- Excelでも表構造が統一されていない可能性がある。
- PDFしかない地域・過去月がある。
- 施設基準略称を正式な算定要件に対応付ける必要がある。
- 備考欄に重要な病棟情報が詰め込まれる。

### 医療情報ネット（ナビイ）

厚労省は、医療機能情報提供制度に基づく全国統一システムとして医療情報ネット（ナビイ）を運用している。医療情報ネットは、診療日、診療科目、対応可能な疾患・治療内容、提供サービスなどで全国の医療機関を検索できる。厚労省ページには医療情報ネットのオープンデータへのリンクがある。

医療情報ネットは、病床、診療科、対応可能な医療、設備などの補助情報に使う。ただし、診療報酬算定に直接使う施設基準の公式根拠は地方厚生局の届出受理情報を優先する。

### 病床機能報告

病棟単位の病床機能や医療内容の補助情報として使える。入院料・DPC・病棟単位算定の補助には有用だが、施設基準届出の代替にはしない。

## 最重要データモデル

### hospital_registry

```text
id
prefecture_code
regional_bureau
medical_institution_code
institution_name
institution_type
postal_code
address
phone
status
designated_from
source_id
effective_from
effective_to
```

### hospital_facility_standards

```text
hospital_id
standard_abbreviation
receipt_number
accepted_number
start_date
end_date
bed_count_text
ward_text
remarks
source_id
raw_row_json
```

### facility_standard_dictionary

施設基準略称を、算定ロジックの内部キーへ対応付ける辞書。

```text
abbreviation
official_name
fee_table_code
rule_key
standard_kind
source_document
effective_from
effective_to
```

### hospital_profile

算定エンジンが使う派生ビュー。

```text
hospital_id
service_date
institution_type
bed_counts
dpc_status
dpc_coefficients
facility_standard_keys[]
ward_profiles[]
source_versions[]
default_run_classification
default_run_recommended_action
included_in_default_medical_run
warnings[]
```

## 実装ロードマップ

### Phase 1: 公式マスター拡張

目的は、行為・薬剤・材料・コメントを同じ設計で取り込めるようにすること。

作るもの。

- 医薬品マスター importer。
- 特定器材マスター importer。
- コメントマスター importer。
- コメント関連テーブル importer。
- 医科電子点数表 importer。
- `master_sources` の共通化。

完了条件。

- 公式CSV/ZIPをraw保存できる。
- チェックサム、公開日、取得日、行数を記録できる。
- 医科診療行為、薬剤、材料、コメントを同一DBで引ける。

### Phase 2: 全国医療機関レジストリ

目的は、保険医療機関コードを全国で正規化すること。

作るもの。

- 地方厚生局ごとのコード内容別医療機関一覧ページ定義。
- Excel/PDF取得 downloader。
- Excel parser。
- PDF fallback parser。
- `hospital_registry`。

完了条件。

- 全国の医科病院を医療機関コードで一意に引ける。
- 都道府県、医療機関名、所在地、病院/診療所を持てる。
- 月次更新に耐えられる。

### Phase 3: 施設基準届出 importer

目的は、算定日ごとの医療機関別施設基準を作ること。

作るもの。

- 8地方厚生局の施設基準届出ページ定義。
- Excel/ZIP downloader。
- PDF fallback parser。
- 施設基準略称 parser。
- 算定開始年月日 parser。
- 失効情報 importer。
- `hospital_facility_standards`。
- `facility_standard_dictionary`。

完了条件。

- 任意の病院について、算定日時点で届出済みの施設基準を取得できる。
- 検体検査管理加算、画像診断管理加算、入院基本料など主要施設基準を判定できる。

### Phase 4: hospital_profile service

目的は、算定エンジンに渡す医療機関プロファイルを1つのAPIで作ること。

API案。

```text
get_hospital_profile(medical_institution_code, service_date)
```

返すもの。

- 医療機関基本情報。
- 病床数。
- 届出施設基準。
- DPC対象/対象外。
- 入院料・病棟情報。
- 全国既定実行に含めるかどうか。
- 不足情報 warnings。

完了条件。

- 算定ロジック側が地方厚生局ファイル形式を意識しない。

### Phase 5: 外来出来高エンジン

目的は、全病院で使える外来の概算算定を作ること。

優先順。

1. 初再診・外来診療料。
2. 検体検査。
3. 採取料。
4. 投薬。
5. 注射（一部実装済み）。
6. 処置（一部実装済み）。
7. 画像診断（一部実装済み）。

必要条件。

- 同日・同月履歴。
- 施設基準。
- コメント。
- 包括・背反・算定回数。

### Phase 6: 入院出来高エンジン

目的は、DPC対象外病院とDPC対象外患者の入院を扱うこと。

2026-05-18時点のStep6実装では、最初の安全な入口として、入院基本料を明示コード入力で候補化できる。DPC入力は同じbatchへ流せるが、診断群分類・期間別点数・医療機関別係数・包括/出来高分離を自動計算せず、`dpc_claim needs_review` としてレビューへ回す。

必要条件。

- 入院日、退院日。
- 病棟・入院料。
- 入院料加算。
- 食事・生活療養。
- 入院中包括。
- 病棟単位の施設基準。

### Phase 7: DPC概算エンジン

目的は、DPC対象病院の入院概算に対応すること。

必要条件。

- DPC電子点数表。
- DPC対象病院と医療機関別係数。
- 傷病名、手術、処置等1/2、副傷病。
- 入院期間区分。
- 包括範囲と出来高項目分離。

DPCは外来出来高と別エンジンにする。

### Phase 8: 評価と安全設計

目的は、全病院での誤算定を抑えること。

作るもの。

- 自院/協力医療機関の確定レセプトによるgold dataset。
- 施設基準別テスト。
- DPC/出来高の境界テスト。
- 過剰請求方向の安全指標。
- `needs_review` の運用。

## 最初に実装すべき順番

次に進むなら、以下の順がよい。

1. 医科電子点数表 importer。
   - 包括、背反、算定回数がないと、外来概算でも危険。
2. コメントマスター/コメント関連テーブル importer。
   - 摘要欄・必須コメントの警告が出せる。
3. 北海道または東海北陸の施設基準Excel importerを1局分だけ作る。
   - 全局対応前に、表構造の難しさを掴む。
4. `hospital_registry` と `hospital_facility_standards` のスキーマを追加する。
5. `get_hospital_profile()` を作る。
6. 検体検査MVPに施設基準を接続する。
   - 検体検査管理加算、外来迅速検体検査加算、D026判断料。
7. 全8地方厚生局へ横展開する。

## 現在の実装状況

北海道厚生局を対象に、医療機関コード一覧と施設基準届出名簿の取り込みを実装済み。さらに、北海道互換のExcelレイアウトであれば、任意の地方厚生局キーを指定して同じ正規化テーブルへ取り込める汎用 importer を追加済み。ZIPで県別Excelが複数公開される場合も、ZIP内の `.xlsx` をまとめて同一sourceとして取り込める。2026-05-17時点で、全8地方厚生局の公式ページからExcel/ZIP候補を取得し、全国manifestのsmoke importまで実行済み。

実装済み。

- `hospital_registry`
  - 北海道厚生局「コード内容別医療機関一覧表」の医科（病院）Excelを取り込む。
  - 保険医療機関コード、医療機関名、所在地、電話番号、開設者、管理者、指定年月日、病床テキスト、診療科テキスト、状態を保存する。
  - `import_regional_hospital_registry(..., regional_bureau=...)` で、同一レイアウトの他地方厚生局Excel/ZIPも `regional_bureau` を分けて保存できる。
- `hospital_facility_standards`
  - 北海道厚生局「施設基準等の届出事項（届出受理医療機関名簿）」の保険医療機関（医科）Excelを取り込む。
  - 医療機関コード、施設基準名、略称、受理番号、算定開始年月日、病床数テキスト、備考を保存する。
  - `import_regional_facility_standards(..., regional_bureau=...)` で、同一24列レイアウトの他地方厚生局Excel/ZIPも `regional_bureau` を分けて保存できる。
- CLI
  - `import-regional-hospital-registry --regional-bureau <key> --xlsx <xlsx-or-zip>`。
  - `import-regional-facility-standards --regional-bureau <key> --xlsx <xlsx-or-zip>`。
  - `import-regional-manifest --manifest <json>` で、ローカルに取得済みの全国ファイルをmanifestから順に取り込める。
  - `smoke-regional-manifest --manifest <json> --format markdown` で、manifest各entryの取込成否、件数、失敗理由を途中停止せずにレポートできる。
  - `list-regional-source-pages` で、確認済みの地方厚生局公式ページ一覧を出力できる。
  - `discover-regional-source-files --html <saved-html> --regional-bureau <key> --kind <kind>` で、保存済み公式ページHTMLからExcel/ZIP/PDFリンクを抽出できる。
  - `discover-regional-source-files --format manifest --source-version <version>` で、import可能なExcel/ZIPリンクだけをローカル保存先つきmanifest雛形として出力できる。
  - `discover-regional-source-files --recommended-only` で、医科・全体版・施設基準/コード一覧らしさを加点し、歯科・薬局・訪問看護・直近分・項目別ファイルなどを減点した推奨候補だけに絞れる。
  - `download-regional-source-files --regional-bureau <key> --kind <kind> --source-version <version>` で、公式ページHTMLを取得・保存し、推奨Excel/ZIPをraw配下へ保存し、manifestを出力できる。
  - `download-regional-catalog --source-version <version>` で、catalog全体を走査し、成功分のmanifestを結合し、失敗ページをレポートできる。関東信越と近畿の入院基本料・特定入院料補助ファイルも推奨候補に含める。
  - `--manifest-output <path>` で、取得レポートを表示しながら結合manifestをファイル保存できる。
  - `validate-regional-manifest --manifest <regional_manifest.json>` で、全国8地方厚生局×2種別のcoverage、対応kind、対応地方厚生局キー、`source_version`、raw path存在をDB投入前にdry-run検証できる。
  - `summarize-hospital-registry --db <sqlite> --format markdown` で、医科全体名簿から病院候補を数え、施設基準届出との突合漏れを地方厚生局別に確認できる。
  - `list-unmatched-active-hospitals --db <sqlite> --format markdown` で、現存病院だが施設基準届出と突合できない医療機関を一覧化できる。
  - `summarize-hospital-run-targets --db <sqlite> --format markdown` で、全国既定実行に含める/除外する現存病院数を分類別に確認できる。
  - `list-hospital-run-targets --db <sqlite> --format markdown` で、既定実行対象の医療機関コードを列挙できる。`--include-excluded` を付けると除外候補も監査できる。
  - `smoke-hospital-run-targets --db <sqlite> --service-date <YYYY-MM-DD> --format markdown` で、既定実行対象の全医療機関について `get_hospital_profile()` を解決し、対象分類との不整合を検出できる。`--include-excluded` を付けると除外候補も含めて検証する。
  - `export-hospital-claim-contexts --db <sqlite> --service-date <YYYY-MM-DD> --format jsonl` で、全国既定実行対象を `ClaimContext` テンプレートとしてJSONL/JSON/TSV/Markdownに出力できる。
  - `convert-order-csv-to-claim-jsonl --csv <orders.csv> --column-map-preset orca --template-jsonl <templates.jsonl> --output <orders.jsonl>` で、EHR/ORCA/レセコン等から抽出したCSV明細を `ClaimContext` JSONLへ変換できる。
  - `run-outpatient-claim-batch --db <sqlite> --input <orders.jsonl> --format <jsonl|json|tsv|markdown>` で、実オーダーJSONLを `ClaimContext` に変換し、外来算定batchを一括実行できる。`export-hospital-claim-contexts` の `claim_context_template` を土台にして、患者ID、診療行為、薬剤、注射、処置、画像診断、履歴、検体検査オプションをトップレベルで上書きできる。
  - `run-order-csv-outpatient-claim-batch --db <sqlite> --csv <orders.csv> --template-jsonl <templates.jsonl>` で、CSV変換と算定batchを1コマンドで実行できる。`--converted-output` で中間JSONL、`--conversion-report-output` で変換warningレポートを保存できる。旧 `*-outpatient-lab-*` 名は互換用aliasとして残す。
  - `run-nationwide-outpatient-lab-smoke --db <sqlite> --service-date <YYYY-MM-DD>` で、全国既定実行対象の各病院に代表的な外来検体検査ケースを流し、標準マスター、病院profile、算定入口の横断smokeを実行できる。既定では `160000410`、`160000310` を入力し、外来迅速検体検査加算の成立事実をtrueにした合成ケースを使う。`--comment-code` / `--comment-text` で入力済みコメントも注入できる。検体検査管理加算の施設基準なしは既定で `ignore` とし、監査時は `--lab-management-facility-missing-policy review` を使う。
  - `discover-ssk-master-catalog --source-version <version> --output <ssk-master-catalog.json>` で、支払基金の公式ページから医科診療行為、医薬品、特定器材、コメント、コメント関連、医科電子点数表のdownload URL catalogを生成できる。公式ページの公開日は `published_at`、月次スナップショット版は `source_version` として分けて持つ。
  - `diff-ssk-master-catalog --old <prev.json> --new <current.json> --format markdown` で、前月catalogと当月catalogの追加・削除・URL/ファイル名/公開日変更を確認できる。CIで変更検知を止めたい場合は `--fail-on-change` を使う。
  - `download-ssk-master-catalog --catalog <ssk-master-catalog.json> --raw-root data/raw/ssk --standard-manifest-output <standard-build.json>` で、支払基金URL catalogからraw ZIP/CSVを取得し、ZIP展開と標準DBビルドmanifest生成まで一括実行できる。
  - `prepare-standard-master-build-manifest --raw-root data/raw/ssk --source-version <version> --output <standard-build.json>` で、支払基金raw ZIP/CSVを展開・走査し、標準DBビルドmanifestを生成できる。
  - `validate-standard-master-build-manifest --manifest <standard-build.json>` で、標準DBビルド前に必須kind、未対応kind、`source_version`、raw path存在をdry-run検証できる。
  - `build-standard-master-db --db <sqlite> --manifest <standard-build.json>` で、医科診療行為、医薬品、特定器材、コメント関連、医科電子点数表、全国hospital profileを同一DBへmanifest順に投入できる。
  - 対応キーは `hokkaido`、`tohoku`、`kanto_shinetsu`、`tokai_hokuriku`、`kinki`、`chugoku_shikoku`、`shikoku`、`kyushu`。
  - `smoke-regional-manifest` は取込0件を `empty` として非OKに分類する。
- `get_hospital_profile(medical_institution_code, service_date, regional_bureau=None)`
  - 医療機関コードと算定日から、病院基本情報と算定日までに開始済みの施設基準を返す。
  - 医療機関コードは地方厚生局をまたぐと重複し得るため、全国バッチや `ClaimContext` では `regional_bureau` も渡す。
  - 施設基準略称は `facility_standard_keys` として参照できる。
  - `default_run_classification`、`default_run_recommended_action`、`included_in_default_medical_run` を返し、全国既定実行対象かどうかを算定入口でも判断できる。
  - 施設基準未突合だが病床情報がある病院は `facility_standards_not_found` warning付きで含める。歯科系病院や病床情報がないクリニック名は `default_medical_run_excluded: <classification>` warningを返す。
- 検体検査管理加算との接続
  - `facility_standard_keys` の `検Ⅰ/検Ⅱ/検Ⅲ/検Ⅳ` から、検体検査管理加算（1）から（4）の候補を返せる。
  - D026/D027判断料が請求内にない場合や、同月既算定の場合は加算しない。
- 検体検査MVPの統合入口
  - `calculate_lab_claim()` で、入力された検査コードからD026判断料、検体検査管理加算、電子点数表advisory、必須コメント候補をまとめて返す。
  - `ClaimContext` で患者、診療日、入外区分、地方厚生局キー、医療機関コード、患者履歴、公式マスターsource、検体検査オプションをまとめて渡せる。
  - `ClaimContext` に医薬品入力 `drug_inputs`、構造化投薬オーダー `medication_orders`、注射薬入力 `injection_drug_inputs`、構造化注射オーダー `injection_orders`、処置オーダー `treatment_orders`、画像診断オーダー `imaging_orders`、特定器材入力 `material_inputs` を渡せる。
  - `ClaimContext.outpatient_basic` に、初診料・再診料・外来診療料の区分と、情報通信機器、同日2科目、同日再診、大病院紹介なし受診のフラグを渡せる。
  - `ClaimContext.medication` に、院内投薬/院外処方、内服/外用の調剤料対象、リフィル処方箋、特定保険薬局関係、7種類以上内服薬、特定疾患処方管理加算、抗悪性腫瘍剤処方管理加算、一般名処方加算などの区分を渡せる。
  - `ClaimContext.injection` に、注射経路、乳幼児区分、入院外点滴その他区分、生物学的製剤注射加算、麻薬注射加算、精密持続点滴注射加算のフラグを渡せる。
  - `calculate_outpatient_basic_fee()` で、初診料 `111000110`、再診料 `112007410`、外来診療料 `112011310` などの基本診療料候補を返せる。
  - `calculate_medication_fees()` で、F000調剤料、F100処方料、F400処方箋料、特定疾患処方管理加算、抗悪性腫瘍剤処方管理加算、一般名処方加算の候補を返せる。うがい薬のみの投薬では候補化しない。
  - `calculate_injection_fees()` で、皮内・皮下・筋肉内注射、静脈内注射、点滴注射、中心静脈注射、関節腔内注射、硝子体内注射と、一部注射加算の候補を返せる。
  - `calculate_treatment_fees()` で、創傷処置、熱傷処置、皮膚科軟膏処置、消炎鎮痛等処置、鼻腔栄養、留置カテーテル設置、爪甲除去など一部のJ区分処置料候補を返せる。
  - `calculate_imaging_fees()` で、単純撮影、造影剤使用撮影、乳房撮影、CT、MRIと、電子画像管理加算・造影剤使用加算の一部候補を返せる。
  - `calculate_lab_claim_for_context()` で `ClaimContext` から検体検査MVPを実行できる。
  - `calculate_lab_claim_standardized()` で、検体検査MVPの詳細結果を領域横断の `CalculationResult` に変換できる。
  - `resolve_medical_procedure_lines()` で、入力済み診療行為コードを医科診療行為マスターから名称・点数つきの `confirmed` 行に変換できる。
  - `resolve_drug_lines()` で、入力済み医薬品コードを医薬品マスターから名称・薬価つきの `confirmed` 行に変換できる。総薬価15円以下は0点、15円超は1点未満切上げの薬剤料式で丸める。
  - `resolve_medication_order_inputs()` で、`total_quantity`、`quantity_per_day x days`、`dose_quantity x doses_per_day x days` から薬剤総量を計算できる。
  - `resolve_injection_order_inputs()` で、`total_quantity`、`dose_quantity x administrations` から注射薬の総量を計算できる。
  - `resolve_specific_material_lines()` で、入力済み特定器材コードを特定器材マスターから名称・材料価格つきの `confirmed` 行に変換できる。総材料価格を10円で除し、点数端数を四捨五入する。
  - 標準結果では、入力済み診療行為・医薬品・注射薬・特定器材を `confirmed`、初再診・外来診療料、投薬基本料、注射手技料、処置料、画像診断料、検体検査系の自動追加候補を `candidate`、コメント・包括・背反・履歴不足を `needs_review` メッセージとして分けて返す。
  - 請求内にすでにD026判断料や検体検査管理加算がある場合は二重追加しない。
  - 採取料は検査コードから推測せず、`collection_fee_inputs` に明示された場合だけD400-D419の候補として追加する。
  - 外来迅速検体検査加算は、別表第九の二の対象検査を診療行為コードから自動判定し、外来、当日説明、文書提供、結果に基づく診療が明示された場合だけ、1日5項目上限で追加する。
  - 外来迅速検体検査加算の検査名コメントを対象検査名から生成する。
  - 医科電子点数表の算定回数テーブルから、`日`、`週`、`月` の同一コード履歴一致を抵触候補としてwarningに出す。
  - 包括・背反・算定回数は自動削除せず、レビュー対象として返す。

公式Excelでの確認結果。

| データ | 取込件数 |
| --- | ---: |
| 北海道 医科（病院）コード一覧 | 519 |
| 北海道 保険医療機関（医科）施設基準 | 37,727 |
| 汎用地方厚生局 importer fixture | 東北キーで registry/facility 各1件 |
| 汎用地方厚生局 ZIP importer fixture | 東北キーで registry/facility 各2件 |
| 地方厚生局 manifest importer fixture | 東北キーで registry/facility 各1件 |
| 地方厚生局 manifest smoke fixture | 成功1件/失敗1件をMarkdown report化 |
| 地方厚生局 HTML discovery fixture | 四国施設基準ページ相当HTMLからZIP/PDFリンクを抽出し、ZIPのみmanifest雛形化 |
| 地方厚生局 discovery selector fixture | 医科全体版を歯科/薬局/直近分より優先 |
| 地方厚生局 downloader fixture | 疑似HTML/ZIP fetcherでHTML保存、推奨ZIP保存、manifest生成を確認 |
| 地方厚生局 catalog downloader fixture | 近畿の成功1ページ/失敗1ページをbatch report化し、成功分manifestを結合 |
| 地方厚生局 manifest validation fixture | coverage不足、path欠落、full coverageをCLI含めて検証 |
| 全国catalog実取得 | 全16ページ取得成功、manifest 35 entries |
| 全国manifest dry-run検証 | 8地方厚生局×2種別coverage OK、35 entries、path欠落0 |
| 全国manifest smoke実行 | OK 35 entries / empty 0 entries / failed 0 entries |

全国manifest smokeの実データ結果。

| 地方厚生局キー | 医療機関コード一覧 | 施設基準届出 |
| --- | ---: | ---: |
| `hokkaido` | 519 | 37,727 |
| `tohoku` | 712 | 11,430 |
| `kanto_shinetsu` | 34,854 | 327,553 |
| `tokai_hokuriku` | 11,805 | 170,459 |
| `kinki` | 19,842 | 192,268 |
| `chugoku_shikoku` | 5,912 | 122,952 |
| `shikoku` | 3,004 | 53,636 |
| `kyushu` | 11,690 | 315,121 |
| **合計** | **88,338** | **1,231,146** |

解釈。

- 全8地方厚生局の公式ページ取得とExcel/ZIP保存は成功。
- 施設基準届出は全8地方厚生局で取込成功。
- 医療機関コード一覧は全8地方厚生局で取込成功。
- 医療機関コード一覧のparserは、カンマ区切り、ハイフン区切り、中点区切り、区切りなしの7桁コード表記に対応する。
- 九州のように医科・歯科・薬局ファイルが同一ZIPに入る場合は、医科ワークブックだけを病院台帳として取り込む。
- 関東信越の施設基準は全体ファイルに加え、届出項目別1（入院基本料等）`koumokubetsu1_r0805.zip` と届出項目別2（特定入院料）`koumokubetsu2_r0805.zip` も補助ファイルとして取り込む。
- 近畿の施設基準は全体ファイルに加え、入院基本料 `2026.5_nyuuin.xlsx` と特定入院料 `2026.5_tokutei.xlsx` も補助ファイルとして取り込む。
- 関東信越の医療機関コードZIPはsource内の重複コードを先勝ちでdeduplicateして取り込む。

病院候補と施設基準突合の品質サマリ。

| 地方厚生局キー | 医療機関コード一覧 | 病院 | 現存病院 | 施設基準届出あり医療機関 | 現存病院かつ施設基準あり | 現存病院だが施設基準なし |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `hokkaido` | 519 | 516 | 511 | 2,989 | 511 | 0 |
| `tohoku` | 712 | 86 | 86 | 667 | 86 | 0 |
| `kanto_shinetsu` | 34,854 | 2,115 | 2,109 | 31,219 | 2,106 | 3 |
| `tokai_hokuriku` | 11,805 | 769 | 769 | 11,159 | 769 | 0 |
| `kinki` | 19,842 | 1,201 | 1,199 | 18,039 | 1,195 | 4 |
| `chugoku_shikoku` | 5,912 | 595 | 595 | 12,664 | 595 | 0 |
| `shikoku` | 3,004 | 414 | 412 | 2,814 | 412 | 0 |
| `kyushu` | 11,690 | 1,425 | 1,422 | 25,668 | 1,422 | 0 |
| **合計** | **88,338** | **7,121** | **7,103** | **105,219** | **7,096** | **7** |

このサマリは `summarize-hospital-registry --db <sqlite> --format markdown` で出力できる。全病院で算定ロジックを走らせる入口は、まず `institution_type = 病院` かつ `status = 現存` の7,103件である。施設基準との突合がない7件は、`list-unmatched-active-hospitals --db <sqlite> --format markdown` で一覧化する。

未突合の現存病院。

| 地方厚生局キー | 医療機関コード | 名称 | 病床テキスト | 分類 | 既定アクション |
| --- | --- | --- | --- | --- | --- |
| `kanto_shinetsu` | `0812445` | 医療法人社団愛康会 杉村病院 | 一般 41 | `facility_standards_missing` | `include_with_facility_warning` |
| `kanto_shinetsu` | `1970102` | 医療法人社団 慈誠会 慈誠会若木原病院 | 療養 41 | `facility_standards_missing` | `include_with_facility_warning` |
| `kanto_shinetsu` | `5770029` | 一般社団法人 ＩＣＲ 附属 クリニカルリサーチ東京病院 | 一般 / 一般 50 / 内 臨床検査科 循環器内科 神経精神科 呼内 | `facility_standards_missing` | `include_with_facility_warning` |
| `kinki` | `5015158` | 医療法人徳洲会 恵生会病院 | 一般 96 / 療養 88 | `facility_standards_missing` | `include_with_facility_warning` |
| `kinki` | `6100702` | ふかいクリニック |  | `clinic_named_registry_review` | `exclude_from_default_medical_run` |
| `kinki` | `9400105` | 大阪歯科大学附属病院 | 一般 35 | `dental_hospital_scope_review` | `exclude_from_default_medical_run` |
| `kinki` | `9900021` | 大阪大学歯学部附属病院 | 一般 40 | `dental_hospital_scope_review` | `exclude_from_default_medical_run` |

全国既定実行対象。

| 既定実行 | 分類 | 既定アクション | 件数 |
| --- | --- | --- | ---: |
| yes | `facility_standards_matched` | `include` | 7,090 |
| yes | `facility_standards_missing` | `include_with_facility_warning` | 4 |
| no | `clinic_named_registry_review` | `exclude_from_default_medical_run` | 2 |
| no | `dental_hospital_scope_review` | `exclude_from_default_medical_run` | 7 |
| **合計** |  | 既定実行対象 7,094 / 現存病院 7,103 |  |

この集計は `summarize-hospital-run-targets --db <sqlite> --format markdown` で出力できる。既定実行では、施設基準と突合できる医科病院7,090件に、施設基準未突合だが病床情報がある4件を `facility_standards_not_found` warning付きで加える。施設基準と突合できていても、名称上明確に歯科系病院、または病床情報がないクリニック名のものは医科の既定実行から除外する。

全国profile batch smoke。

| 対象 | OK | Non-OK | warnings |
| --- | ---: | ---: | ---: |
| 既定実行対象のみ | 7,094 | 0 | 4 |
| 除外候補込み | 7,103 | 0 | 13 |

この検証は `smoke-hospital-run-targets --db data/work/nationwide-smoke-classified.sqlite --service-date 2026-06-01 --format markdown` で出力できる。地方厚生局をまたぐ医療機関コード重複があるため、profile batchは `regional_bureau + medical_institution_code` で `get_hospital_profile()` を解決する。これに合わせて `ClaimContext.encounter.regional_bureau` も追加し、算定入口でも地域込みでprofileを引けるようにした。

全国ClaimContextテンプレート出力。

| 対象 | 出力件数 | warnings |
| --- | ---: | ---: |
| 既定実行対象のみ | 7,094 | 4 |
| 除外候補込み | 7,103 | 13 |

既定実行対象のみのJSONLは `data/work/nationwide-claim-contexts-2026-06-01.jsonl` に出力済みで、7,094行である。各行は `service_date`、`regional_bureau`、`medical_institution_code`、`institution_name`、`default_run_classification`、`facility_standard_keys`、`warnings`、空の `procedure_codes` を持つ `claim_context_template` を含む。患者ID、診療行為コード、薬剤、注射、処置、画像診断などの実オーダーは、後続バッチがこのテンプレートへ流し込む。

実オーダーbatch入口。

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

変換結果を確認してから別コマンドで算定する場合は、次の2段階で実行する。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli convert-order-csv-to-claim-jsonl \
  --csv <orders.csv> \
  --column-map-preset orca \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --output <orders.jsonl>

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-outpatient-claim-batch \
  --db <sqlite> \
  --input <orders.jsonl> \
  --format markdown \
  --audit-output <audit.json> \
  --audit-format json
```

`run-order-csv-outpatient-claim-batch` は、CSV変換、任意の中間JSONL保存、任意の変換レポート保存、算定batch実行を1コマンドで行う。`--audit-output` を付けると、`scope`、`regional_bureau`、`medical_institution_code`、`facility_standard_key`、`status`、`message_source`、`message_status`、`count` を持つ集計ファイルも保存する。`--audit-format` は `csv`、`json`、`tsv` に対応する。旧 `run-order-csv-outpatient-lab-batch` は互換用aliasである。

`orders.jsonl` は1行1請求/1診療単位で、`claim_context_template` または `claim_context` を含められる。テンプレートがある場合、トップレベルの `patient`、`procedure_codes`、`drug_inputs`、`medication_orders`、`injection_orders`、`treatment_orders`、`imaging_orders`、`material_inputs`、`history`、`lab_options`、`outpatient_basic`、`medication`、`injection`、`facility_standard_keys` がテンプレートを上書きする。`master_sources` が省略されていれば、DBの `master_sources` から算定日以前の最新マスターを自動選択する。固定したい場合は各 `--*-source-id` を指定し、自動選択を止める場合は `--no-auto-master-sources` を使う。実データ受入時のCIでは、変換warningで止める `--fail-on-warning`、算定errorで止める `--fail-on-error`、レビュー残で止める `--fail-on-review` を段階的に使う。

`orders.csv` は1行1明細でよい。`record_id` がある場合はその値でグルーピングし、ない場合は `patient_id + service_date + regional_bureau + medical_institution_code` でグルーピングする。明細種別は `item_kind` に入れ、代表値は `procedure`、`drug`、`medication_order`、`injection_order`、`material`、`collection_fee`、`same_day_history`、`same_month_history`、`facility_standard` である。

列名が汎用schemaと合わない場合は、`--column-map-preset japanese`、`--column-map-preset orca`、または `--column-map <json>` を使う。独自mapping JSONでは、`columns` で列名変換、`constants` で固定値付与、`values` で `item_kind` や `is_outpatient` の値変換を行う。

batchのMarkdown出力は、件数だけでなく、`Message Source x Status`、地方厚生局別status、地方厚生局別message source、病院別message source上位、頻出message、行別のmessage source内訳を出す。CSV/JSON/TSVのaudit summaryは、同じ集計を外部BIやスプレッドシートへ流すための機械処理用出力である。たとえば `comment needs_review` は必須コメント候補、`electronic_bundle needs_review` は包括候補、`electronic_exclusion needs_review` は背反候補、`lab_warning needs_review` は施設基準や履歴不足、`lab_management blocked` は検体検査管理加算の除外理由として集計できる。全国実データでは、まず地方厚生局別に偏りを見て、次に病院別message source上位から列mapping・履歴・コメント不足を潰す。

現在のbatchは外来検体検査MVPを入口にしているため、全国7,094病院に対して「空テンプレートだけ」を実行するのではなく、各病院・患者・診療日の実オーダーを結合してから実行する。`data/work/nationwide-smoke-classified.sqlite` は病院profile検証用DBであり、実算定には医科診療行為・医薬品・特定器材・電子点数表・コメント関連テーブルを同じDBへ投入する必要がある。

標準DBビルド入口。月次運用の詳細手順は [公式マスター更新Runbook](./official-master-update-runbook.md) に集約する。2026-05-01版の固定入力は `configs/official-master/2026-05-01/ssk-master-catalog.json` と `configs/official-master/2026-05-01/standard-master-build.json` である。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-ssk-master-catalog \
  --catalog data/work/ssk-master-catalog.json \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --published-at 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --standard-manifest-output data/work/standard-master-build.json \
  --format markdown

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli prepare-standard-master-build-manifest \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --published-at 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --output data/work/standard-master-build.json

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

`standard-master-build.json` は、`medical_procedure_master`、`drug_master`、`specific_material_master`、`comment_master`、`comment_related_table`、`medical_electronic_fee_table`、`regional_manifest` のentryを持つ。医科電子点数表は `csv_paths` に `aux_master`、`bundles`、`exclusions_day`、`exclusions_month`、`exclusions_simultaneous`、`exclusions_week`、`inpatient_basic`、`frequency_limits` を必要な分だけ指定する。

`validate-standard-master-build-manifest` はDB投入前のdry-run検証である。必須kind、未対応kind、`source_version`、`path` / `csv_paths` の存在確認を行い、`--fail-on-error` でCIや月次更新を止められる。

`prepare-standard-master-build-manifest` は、ZIP展開時にCP932のファイル名メタデータを扱い、macOS標準 `unzip` で失敗しやすい日本語ファイル名もPython側で展開する。抽出済みファイルがある場合は既定では上書きせず、`--overwrite-extracted` で再展開する。必須候補が見つからないことをCIで失敗扱いにする場合は `--fail-on-missing` を使う。

`download-ssk-master-catalog` のcatalogは、`kind` と `url` を持つentry配列である。対応kindは `medical_procedure_master`、`drug_master`、`specific_material_master`、`comment_master`、`comment_related_table`、`medical_electronic_fee_table`。ファイルは `data/raw/ssk/<kind>/<source_version>/<filename>` に保存される。支払基金ページ側のURL変更に備え、URL自体は公式ページから `discover-ssk-master-catalog` で生成し、月次で `diff-ssk-master-catalog` により変更点を確認する。

## 残りの実装ステップ

2026-05-17時点で、支払基金公式catalog生成、公式ZIP raw保存、標準manifest生成、標準DBビルドまで完了した。

完了済み。

| 成果物 | 結果 |
| --- | --- |
| `data/work/ssk-master-catalog.json` | 支払基金公式ページ5ページから6 entriesを生成、warnings 0 |
| `data/raw/ssk` | 医科診療行為、医薬品、特定器材、コメント、コメント関連、医科電子点数表の公式ZIP 6件を保存 |
| `data/work/standard-master-build.json` | 支払基金6 entries + 地方厚生局manifest 1 entry、missing kinds 0 |
| `data/work/standard-master-build-validation.md` | build manifest dry-run検証、Ready yes |
| `data/work/standard-master.sqlite` | 標準マスターと全国hospital profileを同一DBへ投入、build 41 entries OK / error 0 |
| 全国profile smoke | 既定実行対象7,094件、OK 7,094 / Non-OK 0 / warnings 4 |
| 全国外来検体検査smoke | 既定実行対象7,094件、計算error 0、全件 `needs_review` |
| 全国外来検体検査smoke コメント充足版 | 既定実行対象7,094件、OK 3,562 / needs_review 3,532 / error 0 |
| 全国外来検体検査smoke 概算既定ポリシー版 | 既定実行対象7,094件、OK 7,094 / needs_review 0 / error 0 |

全国外来検体検査smokeの実行コマンド。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-nationwide-outpatient-lab-smoke \
  --db data/work/standard-master.sqlite \
  --service-date 2026-06-01 \
  --collection-fee-input blood_venous \
  --format markdown \
  --output data/work/nationwide-outpatient-lab-smoke-2026-06-01.md \
  --fail-on-error
```

結果サマリ。

| 項目 | 件数 |
| --- | ---: |
| 入力病院 | 7,094 |
| error | 0 |
| needs_review | 7,094 |
| confirmed lines | 14,188 |
| candidate lines | 24,844 |
| comment needs_review | 14,188 |
| lab_management blocked | 3,532 |

必須コメントを入力済みとして渡す場合。

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

コメント充足版の結果。

| 項目 | 件数 |
| --- | ---: |
| 入力病院 | 7,094 |
| ok | 3,562 |
| needs_review | 3,532 |
| error | 0 |
| comment needs_review | 0 |
| lab_management blocked | 3,532 |

全国概算の既定ポリシーとして、検体検査管理加算の施設基準がない病院は「加算候補なし」として正常終了させる。監査時だけ `--lab-management-facility-missing-policy review` を指定し、従来どおり `lab_management blocked` を集計する。

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

概算既定ポリシー版の結果。

| 項目 | 件数 |
| --- | ---: |
| 入力病院 | 7,094 |
| ok | 7,094 |
| needs_review | 0 |
| error | 0 |
| message | 0 |

解釈。

- 標準DB、全国hospital profile、代表検体検査ケースの横断実行は全病院で落ちない。
- 外来迅速検体検査加算 `160177770` に必須コメント `820100129` と `830100111` が関連する。`ClaimContext.comment_inputs` に入力済みコメントコード/本文を渡すと、コメント候補は充足済みとして扱い、`comment needs_review` は出さない。
- `lab_management blocked` 3,532件は、代表ケースで検体検査管理加算を試みたが、該当病院profileに `検Ⅰ/検Ⅱ/検Ⅲ/検Ⅳ` がないため候補化しなかった件数である。これは施設基準がない病院では期待される挙動で、概算既定ポリシーではmessageに出さない。監査ポリシー `review` の場合だけblockedとして集計する。

残り。

1. 全国7,094病院の `ClaimContext` テンプレートに、実オーダーCSV/JSONLを結合して `run-outpatient-claim-batch` を実行する。
2. batchの `needs_review`、包括、背反、必須コメント、施設基準warningを集計し、算定ロジック側で自動確定してよい領域とレビュー必須領域を分ける。
3. 実オーダーの施設基準・履歴・コメント不足を埋めるため、レセコン/EHRの列mappingを病院ごとに固定し、gold datasetで点数差分を評価する。
4. 代表検体検査以外の外来基本料、投薬、注射、処置、画像診断の全国smokeを同じ標準DBで広げる。

公式ページcatalog。

| 地方厚生局キー | 医療機関コード一覧 | 施設基準届出 |
| --- | --- | --- |
| `hokkaido` | https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/code_ichiran.html | https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/todokede_juri_ichiran.html |
| `tohoku` | https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/itiran.html | https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/documents/201805koushin.html |
| `kanto_shinetsu` | https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/shitei.html | https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/kijyun.html |
| `tokai_hokuriku` | https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00287.html | https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00349.html |
| `kinki` | https://kouseikyoku.mhlw.go.jp/kinki/tyousa/shinkishitei.html | https://kouseikyoku.mhlw.go.jp/kinki/gyomu/gyomu/hoken_kikan/shitei_jokyo_00004.html |
| `chugoku_shikoku` | https://kouseikyoku.mhlw.go.jp/chugokushikoku/chousaka/iryoukikanshitei.html | https://kouseikyoku.mhlw.go.jp/chugokushikoku/chousaka/shisetsukijunjuri.html |
| `shikoku` | https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/index.html | https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/index.html |
| `kyushu` | https://kouseikyoku.mhlw.go.jp/kyushu/gyomu/gyomu/hoken_kikan/index_00006.html | https://kouseikyoku.mhlw.go.jp/kyushu/gyomu/gyomu/hoken_kikan/index_00007.html |

manifest例。

```json
{
  "entries": [
    {
      "kind": "hospital_registry",
      "regional_bureau": "tohoku",
      "path": "data/raw/kouseikyoku/tohoku/2026-05/registry.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-05-10",
      "url": "https://kouseikyoku.mhlw.go.jp/tohoku/..."
    },
    {
      "kind": "facility_standards",
      "regional_bureau": "tohoku",
      "path": "data/raw/kouseikyoku/tohoku/2026-05/facility.zip",
      "source_version": "2026-05-01",
      "published_at": "2026-05-10",
      "url": "https://kouseikyoku.mhlw.go.jp/tohoku/..."
    }
  ]
}
```

全国smokeの実行例。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli smoke-regional-manifest \
  --db data/work/nationwide-smoke.sqlite \
  --manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --format markdown
```

CIや自動更新時に失敗をexit codeへ反映したい場合は `--fail-on-error` を付ける。通常の調査では、失敗entryを含めて全体の状況を把握するため、まず `--fail-on-error` なしで実行する。

公式ページからの取得例。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-regional-source-files \
  --regional-bureau kinki \
  --kind facility_standards \
  --source-version 2026-05-01 \
  --raw-root data/raw/kouseikyoku \
  --format manifest
```

上記は、catalogの公式ページHTMLを `source_page.html` としてraw配下へ保存し、推奨候補のExcel/ZIPを同じraw配下へ保存したうえでmanifest JSONを出力する。ページ文字コードがUTF-8でない場合は `--page-encoding` を指定する。

## 直近の残りステップ

2026-05-18時点の残りは次の順で進める。

1. 実オーダー結合処理
   - 完了。汎用CSV adapter、列名mapping、contract雛形生成、contract検証、manifest事前検証、single/batch pipeline、audit、gold評価、gold差分分類、改善backlogまで実装済み。`contracts/order-csv/manifest.example.json` は非PHI合成CSV `data/work/example-orders/tohoku-0410001/orders.csv` を参照し、`validate-order-csv-pipeline-manifest` で `Ready: yes`、`run-order-csv-claim-pipeline-batch` でOK 1 / gold mismatch 0まで確認済み。実病院データでは、同じ手順で病院別contractを保存し、PHIを含むCSVは公開リポジトリ外で管理する。
2. batch結果レポート拡張
   - 完了。Markdownのルール別、地方厚生局別、病院別message source集計と、CSV/JSON/TSVの施設基準別audit summaryは実装済み。gold labelつきCSVは `gold-classification` で `under_claim_missing_code`、`over_claim_extra_code`、`code_substitution_gap`、`required_comment_input`、`facility_standard_input`、`history_input`、`master_mapping_gap`、`gold_label_missing`、`batch_execution_error` などに分類できる。各分類には `feedback_target`、`priority`、`recommended_action` が付くため、差分を算定ロジック、入力contract、施設基準/マスター、gold label確認へ戻せる。`gold-backlog` は分類行を改善単位へ集約し、件数、代表record/code/message source、理由を出す。`gold-action-plan` はbacklogを `owner`、`implementation_step`、`acceptance_gate` つきの実装修正単位へ変換する。batch summaryはentry別の分類action数、high priority数、最多分類、最多戻し先と、全entry横断の分類/戻し先件数を出せる。非PHIの `contracts/order-csv/manifest.backlog.example.json` は、contract validationは通るが必須コメント不足により `required_comment_input` を返すStep2回帰サンプルである。通常の `manifest.example.json` は同症例の修正版で、gold mismatch 0に戻る。実病院データの投入と頻出分類の件数収集は外部データ依存だが、コード上の差分分類から改善Action Planへ戻すループは完了している。
3. 公式マスター投入DBの標準ビルド
   - 完了。支払基金URL catalog、標準DB build manifest、全国地方厚生局manifestを `configs/` に固定し、`validate-standard-master-build-manifest` と `validate-regional-manifest` でDB投入前dry-run検証できる。月次手順は [公式マスター更新Runbook](./official-master-update-runbook.md) と [地方厚生局データ更新Runbook](./regional-master-update-runbook.md) に分離した。次はこの標準DBを使って外来領域の実オーダーbatchを拡張する。
4. 外来領域の拡張
   - 完了。入力schema棚卸しを [外来入力Schema棚卸し](./outpatient-input-schema-inventory.md) にまとめ、`japanese` CSV presetに初再診、投薬、注射、処置、画像診断、検体検査、履歴、gold列の一般aliasを追加した。非PHI混在CSV `data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv`、contract `contracts/order-csv/tohoku/0410001/outpatient-mixed-contract.json`、manifest `contracts/order-csv/manifest.outpatient-mixed.example.json` を追加し、contract validationがpassする。外来全体向けCLI alias `run-outpatient-claim-batch` / `run-order-csv-outpatient-claim-batch` を追加し、旧 `*-outpatient-lab-*` 名は互換用aliasとして残す。gold差分分類は、`outpatient_basic_input`、`medication_input`、`injection_input`、`treatment_input`、`imaging_input` を返し、入力contractまたは算定ロジック改善へ戻せる。
5. 施設基準辞書
   - 完了。施設基準略称を内部rule keyへ対応付ける [施設基準辞書](./facility-standard-dictionary.md) を追加した。`検Ⅰ/Ⅱ/Ⅲ/Ⅳ` は検体検査管理加算、`画１/２/３/４` と `遠画` は画像診断管理加算/遠隔画像診断管理加算へ接続済み。`一般入院`、`特定入院`、`専門入院`、`療養入院`、`精神入院`、`結核入院`、`障害入院`、`診入院`、`診療養入院` はStep6の入院基本料候補rule keyとして棚卸し済み。
6. 入院/DPC
   - 完了。Step6入口として、`ClaimContext.inpatient_basic` / `ClaimContext.dpc`、入院日/退院日のCSV mapping、入院用CLI alias、入院サンプルCSV/contract/manifestを追加した。入院基本料は `basic_fee_code` と `basic_fee_days` を明示し、`一般入院` などの施設基準略称を施設基準辞書で確認して候補行を返す。DPCは `dpc_claim` / `dpc_code` / `hospital_coefficient` を取り込むが、DPC grouping、期間別点数、医療機関別係数適用、包括/出来高分離が未実装のため `needs_review` に止める。非PHIサンプル `contracts/order-csv/manifest.inpatient.example.json` は、入院基本料1件OK、DPC1件reviewとしてpipeline出力を作れる。
7. 評価データセット
   - 完了。詳細は [Step7 評価データセット](./gold-dataset-step7.md)。`evaluate-gold-claim-batch` / `evaluate-gold-inpatient-claim-batch` で、確定レセプトまたは手作業確認済みgold labelを `expected.total_points`、`expected.status`、`expected.candidate_codes` として評価できる。order CSV adapterは正解列を `expected` に取り込み、`gold-classification`、`gold-backlog`、`gold-action-plan` で差分を算定ロジック、入力contract、施設基準/マスター、gold label確認へ戻す。非PHIの `contracts/order-csv/manifest.step7.example.json` は外来gold、入院基本料gold、DPC期待reviewをまとめて `Gold mismatches: 0` まで確認済み。`contracts/order-csv/manifest.step7-backlog.example.json` は必須コメント不足と入院施設基準不足を `required_comment_input` / `inpatient_input` としてAction Planへ戻せる。`evaluate-gold-outpatient-lab-claim-batch` は互換用aliasとして残す。

catalog全体からの取得例。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-regional-catalog \
  --source-version 2026-05-01 \
  --raw-root data/raw/kouseikyoku \
  --format markdown \
  --manifest-output data/raw/kouseikyoku/regional_manifest_2026-05-01.json

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-regional-manifest \
  --manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --format markdown \
  --output data/work/regional-manifest-validation.md \
  --fail-on-error
```

特定の地方厚生局や種別だけを先に検証する場合は、`--regional-bureau kinki --kind facility_standards` のように絞り込む。失敗や `empty` をexit codeへ反映したい場合は `--fail-on-error` を付ける。

サンプルとして、医療機関コード `0112489` は `医療法人 愛全病院` として取得でき、病床テキスト `療養 206 / 一般 231`、施設基準 `検Ⅱ`、`療養入院`、`データ提` などを参照できる。

同サンプルでは、尿蛋白 `160000410`、尿中一般物質定性半定量検査 `160000310`、末梢血液一般検査 `160008010`、採取入力 `blood_venous`、外来迅速検体検査加算の明示要件を入力すると、D026 `160061710 尿・糞便等検査判断料 34点`、D026 `160061810 血液学的検査判断料 125点`、`検Ⅱ` に基づく `160182770 検体検査管理加算（2） 100点`、採取料 `160095710 B-V 40点`、外来迅速検体検査加算 `160177770 10点 x 2項目` を候補として返せる。

また、同月履歴に `160061710` や `160182770` がある場合は月単位の算定回数制限抵触候補、当日履歴に `160095710` がある場合は日単位の算定回数制限抵触候補としてwarningを返せる。日付つき履歴 `procedure_history_events` を渡すと、`２週`、`２月`、`３月`、`４月`、`６月`、`１２月`、`５年` の履歴期間にも対応できる。

制約。

- 全8地方厚生局の最新公式ページからExcel/ZIPを取得し、全国manifest smokeまで実行済み。35 entriesすべて取込OK。
- 医療機関コード一覧は地域により「医科（病院）」のみ、「医科全体」、「医科併設」など粒度が異なる。全病院用途では `institution_type` や病床情報で病院に絞る後処理が必要。
- 現存病院7,103件のうち、既定の医科概算算定対象は7,094件である。施設基準届出と突合できない4件は `hospital_profile` に `facility_standards_not_found` warningを返して含める。歯科系病院7件と病床情報がないクリニック名2件は、医科の既定実行から除外する。
- `smoke-hospital-run-targets` により、2026-06-01時点の既定実行対象7,094件はprofile解決OK、Non-OK 0件である。除外候補込み7,103件でもNon-OK 0件。
- `export-hospital-claim-contexts` により、既定実行対象7,094件を `ClaimContext` テンプレートJSONLとして出力できる。出力済みファイルは `data/work/nationwide-claim-contexts-2026-06-01.jsonl`。
- 保存済みHTMLからExcel/ZIP/PDFリンクを抽出する discovery、Excel/ZIPリンクのmanifest雛形生成、セクション見出し・最新日付・ラベル/URL/周辺テキストに基づく推奨候補スコアリング、公式ページHTML/推奨Excel/ZIPの1ページdownloader、catalog全体batch downloader、manifest単位のsmoke reportは実装済み。
- PDFのみ公開、地方厚生局ごとの列名・シート構造差分への対応は未完了。
- 施設基準名・略称を算定ルール内部キーへ対応付ける辞書は実装済み。検体検査管理加算、画像診断管理加算、遠隔画像診断、主要入院基本料系の略称を内部rule keyへ正規化できる。
- 施設基準辞書は主要略称から開始しているため、全加算の届出略称を網羅したものではない。新しい加算ロジックを追加するたびに辞書へrule keyを追加する。
- 検体検査MVPは候補追加とadvisory返却までで、レセプト出力・請求確定までは未実装。
- 初診料・再診料・外来診療料は明示入力方式。患者履歴、傷病の継続性、紹介状有無、同一日複数科の詳細から自動判定するロジックは未実装。
- 投薬は明示入力方式。院内投薬/院外処方、内服/外用、リフィル処方箋などからF000/F100/F400候補を出せる。投薬日数・用量から薬剤総量は計算でき、特定疾患処方管理加算、抗悪性腫瘍剤処方管理加算、一般名処方加算も明示入力で候補化できる。剤単位の厳密なまとめ、対象疾患・主病名、文書説明、一般名処方マスターとの突合は未実装。
- 注射は明示入力方式。注射経路と一部加算フラグから注射手技料・注射加算候補を出せる。皮内・皮下・筋肉内注射と静脈内注射は、入院中患者では手技料候補を返さず薬剤料側だけにする。輸液量、投与時間、同日複数注射のまとめ、薬剤別の加算対象判定、その他の入院中包括関係は未実装。
- 処置は明示入力方式。創傷処置、熱傷処置、皮膚科軟膏処置は面積区分からコードを選べる。消炎鎮痛等処置、鼻腔栄養、留置カテーテル設置、爪甲除去などの一部単純処置も候補化できる。複数部位の面積合算、在宅指導管理料などによる包括、処置薬剤・材料、乳幼児加算、時間外・休日・深夜加算、診療録記載要件は未実装。
- 画像診断は明示入力方式。単純撮影、造影剤使用撮影、乳房撮影、CT、MRIから、写真診断、撮影料、電子画像管理加算、CT/MRI造影剤使用加算、画像診断管理加算、遠隔画像診断管理加算の一部候補を出せる。複数方向・複数部位の逓減、他医撮影の写真診断、共同利用施設の施設基準、核医学/PET、造影剤薬剤料・材料は未実装。
- 入院基本料は明示入力方式。CSVまたはJSONLで `basic_fee_code`、`basic_fee_days`、必要に応じて `facility_standard_key` / `ward_kind` / `inpatient_basic_code` を渡すと、医科診療行為マスターと入院基本料テーブルを参照して候補化できる。病棟、転棟履歴、入退院日の期間按分、入院料加算、食事・生活療養、入院中包括は未実装。
- DPC入力はCSV/JSONLで受け取れるが、自動計算せず `needs_review` として返す。DPC電子点数表、診断群分類、期間I/II/III、医療機関別係数、包括/出来高分離は今後のDPC概算エンジンで扱う。
- 医薬品・特定器材はマスター薬価/材料価格から基本的な薬剤料・材料料の丸めまで。材料の上限価格・年齢加算などの最終適用は未実装。
- 採取料は明示入力方式であり、検査オーダーから採取方法を自動推定する辞書は未実装。
- 外来迅速検体検査加算は対象検査判定と検査名コメント生成に対応したが、説明文書の有無、外注/院内実施、対象検査すべてが同日説明されたかの判定は外部入力に依存している。
- 算定回数制限は同一コードの履歴一致が中心。`一連`、`初回`、`入院中`、`退院時` などは追加の患者状態・入退院イベントモデルが必要。
- 失効済み施設基準の履歴管理は未実装。現時点の公開名簿を算定日時点のスナップショットとして扱う。
- 病床テキストは正規化せず保存している。入院料コードを自動選択するには、病床種別・病棟単位への分解が必要。

## まだ足りない情報

全病院で安全に実行するには、次の入力が必要である。

- 患者単位の同月履歴。
- 診療日、入外区分、初再診。
- 実施した診療行為、薬剤、材料。
- 注射の経路、投与回数、輸液量、投与時間、加算対象フラグ。
- 処置の種類、部位、面積、在宅指導管理料等の包括関係、処置薬剤・材料、診療録記載。
- 画像診断の種別、撮影方式、写真診断区分、撮影部位、CT/MRI機器区分、造影有無、電子画像管理、読影・管理加算の施設基準。
- 検体種別、採取方法、検査結果説明、文書提供。
- 医療機関コード。
- 施設基準届出の時点情報。
- 入院基本料を明示算定する場合は入院料コード、算定日数、施設基準略称。自動選択まで行う場合は病棟、入院料、転棟履歴、食事・生活療養、入院中包括。
- DPCの場合は医療資源病名、手術、処置、副傷病、入院期間、医療機関別係数、DPC包括範囲と出来高算定項目の分離。
- 診療録記載や医学的必要性の根拠。

このうち、公開データで埋められるのは医療機関プロファイル側であり、患者・診療・診療録の情報は医療機関側のシステム連携が必要になる。

## 参照

- 厚生労働省 令和8年度診療報酬改定: https://www.mhlw.go.jp/stf/newpage_67729.html
- 支払基金 基本マスター: https://www.ssk.or.jp/smph/seikyushiharai/tensuhyo/kihonmasta/index.html
- 支払基金 レセプト電算処理システム: https://www.ssk.or.jp/seikyushiharai/rezept/index.html
- 北海道厚生局 施設基準等の届出事項: https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/todokede_juri_ichiran.html
- 北海道厚生局 コード内容別医療機関一覧表: https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/code_ichiran.html
- 東北厚生局 施設基準の届出等受理医療機関名簿: https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/documents/201805koushin.html
- 東海北陸厚生局 施設基準の届出受理状況: https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00349.html
- 医療機能情報提供制度/医療情報ネット: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iryou/teikyouseido/index.html
- 病床機能報告: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000055891.html
- DPC準備病院の募集: https://www.mhlw.go.jp/seisakunitsuite/bunya/kenkou_iryou/iryouhoken/r08_dpc.html
- DPC電子点数表: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198757.html
