# 公式データと検体検査MVP調査

## 調査日と結論

調査日: 2026-05-17

次の実装ステップとしては、検体検査の外来出来高算定をMVPにするのが妥当である。公式マスターから、検査コード、点数、D区分、判断料グループ、施設基準コード、検体コメント、包括・背反・算定回数、必須コメントの多くを機械処理できる。

一方で、検査の医学的必要性、診療録記載、結果説明、文書提供、検査結果に応じた分岐、特殊な臨床条件はマスターだけでは確定できない。MVPでは、これらを入力ファクトとして受け取るか、`needs_review` に落とす。

## 確認した公式データ

### 基本マスター

支払基金の基本マスターは、診療報酬情報提供サービスと同一の全件ファイルを提供している。医科診療行為マスター、コメントマスター、傷病名マスター、修飾語マスターなどが公開されている。

実装検証に使ったファイル例。月次運用で使う最新URLと公開日は、後述の `discover-ssk-master-catalog` で公式ページから生成する。

| データ | 公開日 | 件数 | 実ファイル | 形式 |
| --- | ---: | ---: | --- | --- |
| 医科診療行為マスター | 2026-05-01 | 11,736 | `s_ALL20260501.csv` | ZIP内CSV, CP932, ヘッダなし, 150列 |
| コメントマスター | 2026-05-07 | 4,826 | `c_ALL20260507.csv` | ZIP内CSV, CP932, ヘッダなし, 30列 |
| コメント関連テーブル | 2026-05-15 | 30,268 | `ck_ALL_20260515.csv` | ZIP内CSV, CP932, ヘッダなし, 30列 |

### 医科電子点数表

支払基金は、医科診療報酬点数表に定められた算定ルールを機械可読にするための電子情報テーブルとして、医科電子点数表を提供している。

今回確認した令和8年度版ファイル。

| ファイル | 行数 | 列数 | 役割 |
| --- | ---: | ---: | --- |
| `01補助マスターテーブル.csv` | 11,736 | 27 | 各テーブルとの関連識別 |
| `02包括テーブル.csv` | 247,949 | 7 | 包括・被包括関係 |
| `03-1背反テーブル1.csv` | 39,666 | 10 | 背反関係 1 |
| `03-2背反テーブル2.csv` | 21,050 | 10 | 背反関係 2 |
| `03-3背反テーブル3.csv` | 16,268 | 10 | 背反関係 3 |
| `03-4背反テーブル4.csv` | 350 | 10 | 背反関係 4 |
| `04入院基本料テーブル.csv` | 6,754 | 8 | 入院基本料と加算可否 |
| `05算定回数テーブル.csv` | 5,915 | 14 | 算定単位ごとの回数制限 |

注意点として、ZIP内のファイル名はShift-JIS系で、macOSの標準 `unzip` では `Illegal byte sequence` になる場合がある。取り込み処理では、ZIPのメタデータエンコーディングをCP932として扱う必要がある。CSV本体もCP932として読み込む。

## 機械処理に使える主な項目

医科診療行為マスターで、検体検査MVPに特に使う項目は次の通り。

| 項目 | 用途 |
| --- | --- |
| 診療行為コード | レセプト電算コード、内部キー |
| 省略漢字名称、基本漢字名称 | 表示、院内オーダーとの対応 |
| 点数 | 実施料・判断料・加算の点数 |
| 入外適用区分 | 外来/入院で算定可能かの判定 |
| 点数集計先識別 | 検査、基本診療料、処置などの分類 |
| コード表用番号 章/部/区分番号/枝番/項番 | D000-D027, D400等の識別 |
| 包括対象検査 | 項目数包括の対象グループ |
| 検査等実施判断区分 | 検査実施料か判断料かの識別 |
| 検査等実施判断グループ区分 | D026判断料のグループ |
| 検体検査コメント | 検体コメントコードかどうか |
| 施設基準コード | 検体検査管理加算などの届出判定 |
| 変更年月日、廃止年月日 | 算定日ごとの有効性判定 |

実データで確認できた例。

| コード | 名称 | 点数 | D区分 | 判断グループ |
| --- | --- | ---: | --- | ---: |
| `160000310` | 尿一般 | 26 | D000 | 0 |
| `160000410` | 尿蛋白 | 7 | D001 | 1 |
| `160008010` | 末梢血液一般検査 | 21 | D005 | 2 |
| `160043310` | 麻疹ウイルス抗体価 | 79 | D012 | 5 |
| `160061710` | 尿・糞便等検査判断料 | 34 | D026 | 1 |
| `160061810` | 血液学的検査判断料 | 125 | D026 | 2 |
| `160061910` | 生化学的検査（1）判断料 | 144 | D026 | 3 |
| `160062010` | 生化学的検査（2）判断料 | 144 | D026 | 4 |
| `160062110` | 免疫学的検査判断料 | 144 | D026 | 5 |
| `160062210` | 微生物学的検査判断料 | 150 | D026 | 6 |
| `160218110` | 遺伝子関連・染色体検査判断料 | 100 | D026 | 17 |
| `160149110` | 基本的検体検査判断料 | 604 | D027 | 8 |

## 検体検査MVPの対象範囲

初期MVPは次の範囲に限定する。

- 医科、外来、出来高。
- D000-D027の検体検査。
- D400の血液採取など、単純な採取料。
- D026の検体検査判断料。
- 施設基準が明確に入力されている場合の検体検査管理加算。
- 電子点数表で判定できる包括、背反、算定回数。
- コメント関連テーブルで判定できる必須コメント。

初期MVPで除外または `needs_review` にするもの。

- DPC入院。
- 特定機能病院の基本的検体検査実施料 D025 / 判断料 D027。
- 慢性維持透析患者外来医学管理料など、検査判断料を包括する管理料。
- 遺伝子検査、がんゲノム、腫瘍関連検査など医学的条件が重いもの。
- 検査結果の陽性/陰性や症状に応じて算定可否が分岐するもの。
- 診療録や摘要欄への医学的根拠記載が必要なもの。
- 同日複数科、入院外来混在、同月複数受診の複雑ケース。

## 全病院対応に必要な医療機関プロファイル

全病院で概算算定を回すには、公式マスターだけでなく、算定日時点の医療機関プロファイルが必要になる。最小構成は、地方厚生局が公開する医療機関コード一覧と施設基準届出名簿を正規化し、医療機関コードから届出済み施設基準を引けるようにすることである。

現在の実装では、北海道互換レイアウトのExcelと、ZIP内の複数Excelを地方厚生局キーごとに取り込める。全国投入は、`list-regional-source-pages` で公式ページを確認し、`download-regional-catalog` または `download-regional-source-files` で公式ページHTMLと推奨Excel/ZIPをraw配下へ保存し、生成されたmanifestを `smoke-regional-manifest` で検証してから `import-regional-manifest` で順に投入する方針にしている。ネットワーク取得前の検証では、保存済みHTMLを `discover-regional-source-files --recommended-only --format manifest` で解析する。

2026-05-18時点では、全8地方厚生局の医療機関コード一覧・施設基準届出ページ、合計16ページから公式Excel/ZIPを `data/raw/kouseikyoku` 配下へ保存し、`configs/regional-master/2026-05-01/regional_manifest.json` として固定済みである。同manifestのsmoke結果は35 entriesすべて `ok`、医療機関コード一覧88,338行、施設基準届出1,231,146行である。関東信越は届出項目別1（入院基本料等）`koumokubetsu1_r0805.zip` と届出項目別2（特定入院料）`koumokubetsu2_r0805.zip`、近畿は入院基本料 `2026.5_nyuuin.xlsx` と特定入院料 `2026.5_tokutei.xlsx` も補助ファイルとして取り込む。

医療機関コード一覧のparserは、カンマ区切り、ハイフン区切り、中点区切り、区切りなしの7桁コード表記を正規化する。九州のように医科・歯科・薬局ファイルが同一ZIPに入る場合は、医科ワークブックだけを病院台帳として取り込む。

病院だけに絞る初期基準は `institution_type = 病院` かつ `status = 現存` である。この基準では現存病院7,103件となり、そのうち7,096件は施設基準届出と突合できる。残り7件は `summarize-hospital-registry` と `list-unmatched-active-hospitals` の品質サマリで検出する。全国既定実行は、施設基準と突合できる医科病院7,090件に、施設基準未突合だが病床情報がある4件を `facility_standards_not_found` warning付きで加えた7,094件である。施設基準と突合できていても、名称上明確に歯科系病院、または病床情報がないクリニック名のものは、`summarize-hospital-run-targets` と `list-hospital-run-targets --include-excluded` で監査し、既定の医科概算算定から除外する。`get_hospital_profile()` も同じ分類を返し、除外候補には `default_medical_run_excluded: <classification>` warningを付けるため、`ClaimContext` から算定した場合もprofile warningとしてレビュー対象に流せる。

医療機関コード7桁は地方厚生局をまたぐと重複し得るため、全国バッチでは `regional_bureau + medical_institution_code` でprofileを解決する。`ClaimContext.encounter.regional_bureau` も追加し、算定入口から `get_hospital_profile()` を呼ぶ場合も地域込みで解決できる。`smoke-hospital-run-targets --service-date 2026-06-01` の実データ結果は、既定実行対象7,094件でOK 7,094 / Non-OK 0 / warnings 4、除外候補込み7,103件でOK 7,103 / Non-OK 0 / warnings 13である。

`export-hospital-claim-contexts --service-date 2026-06-01 --format jsonl` で、既定実行対象7,094件を `ClaimContext` テンプレートとして出力できる。出力済みファイルは `data/work/nationwide-claim-contexts-2026-06-01.jsonl` で、各行は病院単位の `regional_bureau`、`medical_institution_code`、施設基準略称、profile warning、空の `procedure_codes` を持つ。実患者ID、診療行為、薬剤、注射、処置、画像診断などは、後続の患者・オーダー取込バッチでこのテンプレートへ流し込む。

manifestで扱う最小項目。

```json
{
  "kind": "facility_standards",
  "regional_bureau": "tohoku",
  "path": "data/raw/kouseikyoku/tohoku/2026-05/facility.zip",
  "source_version": "2026-05-01",
  "published_at": "2026-05-10",
  "url": "https://kouseikyoku.mhlw.go.jp/tohoku/..."
}
```

未完了の主要論点は、施設基準届出と突合できない現存病院7件の原因確認、PDFのみ公開ファイルへの対応、毎月更新時の差分検知である。

## MVP算定ロジック

### 1. オーダーを標準コード候補に変換する

入力は院内オーダー名ではなく、算定ファクトに正規化する。

```json
{
  "performed_at": "2026-06-03",
  "setting": "outpatient",
  "order_name": "HbA1c",
  "specimen": "blood",
  "collection_method": "venous",
  "result_explained_same_day": true,
  "written_information_provided": true,
  "in_house_test": true
}
```

変換順は次の通り。

1. 院内マスター対応表で完全一致。
2. 医科診療行為マスターの基本漢字名称・省略漢字名称で一致。
3. 同義語・略語辞書で一致。
4. LLMまたは検索モデルで候補提示。
5. 人間レビュー。

### 2. 有効な検体検査コードに絞る

算定日に有効なコードだけを使う。

```text
変更年月日 <= 算定日 <= 廃止年月日
```

検体検査実施料は、医科診療行為マスターのコード表用番号で抽出する。

```text
章 = 2
部 = 03
区分番号 = 000-027
```

ただし、D026は判断料、D027は特定機能病院入院の基本的検体検査判断料なので、外来MVPではD000-D024を主な実施料、D026を自動追加候補、D027を対象外にする。

### 3. 項目数包括を処理する

医科診療行為マスターの `包括対象検査` を使い、同一採取・同一区分内で項目数包括の対象になる検査をグルーピングする。

例として、D007血液化学検査では、患者から1回に採取した血液を用いてD007の1から8までの検査を5項目以上行った場合、項目数に応じた包括点数で算定する。

MVPでは、次の2層で実装する。

1. マスターの `包括対象検査` で対象グループを抽出する。
2. 告示・通知に基づく閾値ルールをルールDSLとして手で持つ。

理由は、マスターから「どの検査が包括対象か」は取れるが、「5項目以上7項目以下なら93点」のような閾値・点数ロジックは告示・通知側の文章ルールとして実装する必要があるため。

### 4. D026判断料を追加する

D026判断料は、検査の種類・回数にかかわらず、該当区分ごとに月1回に限り算定する。

実装ロジック。

1. 検査実施料の `検査等実施判断区分 = 1` を対象にする。
2. `検査等実施判断グループ区分` を集計する。
3. 同じグループのD026判断料コードを追加する。
4. 同一患者・同一月ですでに同一区分の判断料を算定済みなら追加しない。
5. 初回検査の実施日に算定する。
6. D000尿中一般物質定性半定量検査のみの場合は判断料を算定しない。
7. D025、D027、慢性維持透析患者外来医学管理料などで包括される場合は別算定しない。

判断グループの対応。

| グループ | D026判断料 |
| ---: | --- |
| 1 | 尿・糞便等検査判断料 |
| 2 | 血液学的検査判断料 |
| 3 | 生化学的検査（1）判断料 |
| 4 | 生化学的検査（2）判断料 |
| 5 | 免疫学的検査判断料 |
| 6 | 微生物学的検査判断料 |
| 17 | 遺伝子関連・染色体検査判断料 |

### 5. 採取料を追加する

血液採取などの採取料は、D400以降の採取料コードから追加候補を作る。

実データ例。

| コード | 名称 | 点数 | D区分 |
| --- | --- | ---: | --- |
| `160095710` | B-V / 血液採取（静脈） | 40 | D400 |
| `160095810` | B-C / 血液採取（その他） | 6 | D400 |
| `160095970` | 乳幼児加算（血液採取） | 35 | D400 |
| `160101210` | B-A / 動脈血採取 | 60 | D419 |

採取料はオーダー名だけでは確定できないことが多い。MVPでは、採取方法が構造化入力されている場合のみ自動追加し、不明なら `needs_review` にする。

### 6. 加算を処理する

初期に扱う加算。

- 外来迅速検体検査加算
  - 入院中以外。
  - 結果を検査実施日に説明。
  - 文書で情報提供。
  - 結果に基づく診療を実施。
  - 5項目を限度。
  - 1項目につき10点。
- 時間外緊急院内検査加算
  - 入院中以外。
  - 緊急。
  - 時間外、休日、深夜。
  - 当該保険医療機関内で検体検査を実施。
  - 1日につき200点。
- 検体検査管理加算
  - 施設基準届出が必要。
  - 月1回。
  - 検体検査判断料を算定しない場合は算定できない。

コメント関連テーブルで確認できる例。

- 外来迅速検体検査加算には、検体検査名コメント `830100111` が関連する。
- 同加算には、引き続き入院コメント `820100129` も関連する。

### 7. 包括、背反、回数制限を解決する

電子点数表を使って、次を解決する。

- 包括・被包括。
- 1日単位の背反。
- 同月単位の背反。
- 同時算定不可。
- 週単位の背反。
- 算定回数上限。

ただし、電子点数表はチェックを容易にするためのテーブルであり、臨床条件や診療録記載の有無までは持たない。詳細通知の文章ルールと組み合わせる。

## 機械処理できる範囲

自動化しやすいもの。

- 算定日によるマスター有効性判定。
- 診療行為コード、名称、点数の取得。
- D区分、枝番、項番の識別。
- D026判断料グループの自動追加。
- 同一月1回などの算定回数チェック。
- 電子点数表に載る包括・背反チェック。
- コメント関連テーブルに載る必須コメント候補の提示と、入力済みコメントコード/コメント文による充足判定。
- 施設基準コードと医療機関の届出データ照合。

手作業ルール化が必要なもの。

- 項目数包括の閾値と包括点数。
- 外来迅速検体検査加算の対象検査と成立条件。
- D000、D025、D027、慢性維持透析患者外来医学管理料などによる判断料除外。
- 採取料の推定ロジック。
- 詳細通知にある個別検査ごとの条件、併算定不可、摘要欄記載。

自動確定しないもの。

- 医学的必要性。
- 診療録記載の有無。
- 検査結果に基づく条件分岐。
- 院内での説明・文書提供の事実。
- 検体採取方法が構造化されていない場合の採取料。
- 施設基準の届出受理日が不明な場合の加算。

## 実装データモデル案

### master_procedures

```text
code
short_name
base_name
points
inout_applicability
chapter
part
section
branch
item
bundle_lab_group
judgement_kind
judgement_group
specimen_comment_flag
facility_standard_codes
effective_from
effective_to
source_version
```

### lab_order_facts

```text
patient_id
encounter_id
performed_at
setting
department
order_name
mapped_procedure_code
specimen
collection_method
in_house_test
urgent
time_category
result_explained_same_day
written_information_provided
based_care_performed
```

### calculation_result

```text
patient_id
encounter_id
claim_items[]
excluded_items[]
warnings[]
needs_review[]
sources[]
```

## MVP実装順

1. 公式CSV取り込み。
2. 医科診療行為マスターの正規化。
3. D000-D027の検査コード抽出。
4. 院内オーダー名と標準コードの対応表。
5. D026判断料の自動追加。
6. D400血液採取の自動追加。
7. D007血液化学検査の項目数包括。
8. 電子点数表による包括・背反・回数制限。
9. コメント関連テーブルによる必須コメント候補。
10. `needs_review` キュー。

## 現在の実装入口

2026-05-17時点で、公式CSV importer、D026判断料、検体検査管理加算、採取料、外来迅速検体検査加算、医科電子点数表advisory、全国hospital profile、`ClaimContext` テンプレート出力、実オーダーJSONL batch入口まで実装した。

外来検体検査batchは次のCLIで実行する。

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

変換結果を確認してから実行する場合は、次の2段階に分ける。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli convert-order-csv-to-claim-jsonl \
  --csv <orders.csv> \
  --column-map-preset orca \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --output <orders.jsonl>

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-outpatient-claim-batch \
  --db <sqlite> \
  --input <orders.jsonl> \
  --format jsonl \
  --output <results.jsonl>
```

`run-order-csv-outpatient-claim-batch` は、CSV変換、任意の中間JSONL保存、任意の変換レポート保存、算定batch実行を1コマンドで行う。`--audit-output` を付けると、`scope`、`regional_bureau`、`medical_institution_code`、`facility_standard_key`、`status`、`message_source`、`message_status`、`count` を持つ監査サマリも保存する。入力JSONLは、1行1請求/1診療単位である。全国病院用には、先に `export-hospital-claim-contexts` で出した `claim_context_template` を入れ、実オーダーでトップレベル上書きする。旧 `run-order-csv-outpatient-lab-batch` は互換用aliasである。

```json
{
  "record_id": "case-1",
  "claim_context_template": {
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
    "outpatient_rapid_lab_result_based_care_provided": true,
    "lab_management_facility_missing_policy": "ignore"
  },
  "comment_inputs": [
    {"code": "820100129"},
    {
      "code": "830100111",
      "text": "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査"
    }
  ]
}
```

結果は `CalculationResult` 準拠で、入力済み診療行為・薬剤・特定器材を `confirmed`、D026判断料・検体検査管理加算・採取料・外来迅速検体検査加算などの追加候補を `candidate`、包括・背反・履歴不足・コメント不足などを `messages` に分けて返す。必須コメントは、コメント関連テーブルの要求に対して、入力済み `comment_inputs` のコード完全一致、または公式コメント文に対する入力コメント文の一致/接頭辞一致で充足済みにできる。検体検査管理加算の施設基準なしは、`lab_options.lab_management_facility_missing_policy` で `ignore` / `review` を切り替える。全国概算では `ignore` を既定とし、施設基準がなければ加算候補なしとして正常終了する。監査時だけ `review` を指定してblockedとして集計する。入力不備はbatch全体を止めず、該当行を `error` にする。

この入口で「全病院に対して同じロジックを実行する」準備はできた。ただし、実算定には空テンプレートではなく、各病院・患者・診療日の実オーダー、同日/同月履歴、公式マスター一式を投入したDBが必要である。

汎用CSV adapterの代表列は、`record_id`、`patient_id`、`service_date`、`regional_bureau`、`medical_institution_code`、`item_kind`、`code`、`quantity`、`comment_code`、`comment_text`、`collection_fee_inputs`、`facility_standard_keys`、`lab_management_facility_missing_policy`、外来迅速検体検査加算の各成立フラグである。`item_kind` は `procedure`、`drug`、`medication_order`、`injection_order`、`material`、`comment`、`collection_fee`、`same_day_history`、`same_month_history`、`facility_standard` などを指定する。

列名が汎用schemaと異なる場合は、`--column-map-preset japanese`、`--column-map-preset orca`、または独自の `--column-map <json>` を使う。mapping JSONは `columns`、`constants`、`values` を持ち、列名変換、固定値付与、値変換を行う。

batchのMarkdown reportでは、`Message Source x Status`、地方厚生局別status、地方厚生局別message source、病院別message source上位、頻出messageを出す。CSV/JSON/TSVのaudit summaryでは、同じ監査軸を `scope` 列で区別して機械処理できる。これにより、必須コメント、包括、背反、施設基準不足、履歴不足、各加算の除外理由を、患者明細単位だけでなく、地域・病院・施設基準・ルールの集計単位で確認できる。

公式マスター一式を1つのSQLiteへ投入する入口は次の通り。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli discover-ssk-master-catalog \
  --source-version 2026-05-01 \
  --format catalog \
  --output data/work/ssk-master-catalog.json

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli diff-ssk-master-catalog \
  --old data/work/ssk-master-catalog.prev.json \
  --new data/work/ssk-master-catalog.json \
  --format markdown \
  --output data/work/ssk-master-catalog-diff.md

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

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli build-standard-master-db \
  --db data/work/standard-master.sqlite \
  --manifest data/work/standard-master-build.json \
  --format markdown
```

`standard-master-build.json` には、医科診療行為、医薬品、特定器材、コメント関連、医科電子点数表、地方厚生局manifestを並べる。これにより、算定batchで使うマスターsourceとhospital profileを同じDBに揃えられる。

`prepare-standard-master-build-manifest` は、支払基金raw配下のZIPをCP932ファイル名として展開し、既知のCSV名から標準manifestを生成する。見つからないマスター種別は `missing_kinds` としてreportされるため、取り込み前にraw配置漏れを確認できる。

`discover-ssk-master-catalog` は、支払基金の公式ページからURL catalogを生成する。`--source-version` は月次スナップショット版として統一し、各公式ページで見つかった公開日は `published_at` に保存する。`download-ssk-master-catalog` は、そのcatalogを入力にしてraw ZIP/CSVを保存し、その後に同じmanifest生成処理を呼ぶ。URLは支払基金ページ側で変わり得るため、コードには固定せず、月次更新では `diff-ssk-master-catalog` で前回catalogとの差分を確認してからraw保存とDB再ビルドを行う。

2026-05-17時点では、`data/work/ssk-master-catalog.json` 生成、公式ZIP 6件のraw保存、`data/work/standard-master-build.json` 生成、`data/work/standard-master.sqlite` のビルドまで完了した。標準DBビルドは41 entries OK / error 0で、支払基金標準マスター6種と全国地方厚生局manifest 35 entriesを同一SQLiteに投入済みである。同DBでの全国profile smokeは既定実行対象7,094件すべてOK、warnings 4件である。

同DBに対して `run-nationwide-outpatient-lab-smoke --service-date 2026-06-01 --collection-fee-input blood_venous --fail-on-error` を実行し、全国既定実行対象7,094件の代表外来検体検査ケースが計算error 0で完走することを確認した。コメント未入力版は全件 `needs_review` で、主因は外来迅速検体検査加算の必須コメント候補14,188件と、検体検査管理加算の施設基準なしblocked 3,532件であった。

入力済みコメントによる充足判定を追加した後、同DBに対して `run-nationwide-outpatient-lab-smoke --service-date 2026-06-01 --collection-fee-input blood_venous --comment-code 820100129 --comment-code 830100111 --fail-on-error` を実行し、OK 3,562 / `needs_review` 3,532 / error 0となることを確認した。必須コメント由来の `needs_review` は0件になり、残件は検体検査管理加算の施設基準なしblocked 3,532件である。次は、この加算を「届出なしなら候補から除外して正常終了」にするか、「算定候補は残すがblockedとしてレビュー」にするかのポリシーを実装する。

検体検査管理加算の施設基準なしポリシーを追加した後、同DBに対して `run-nationwide-outpatient-lab-smoke --service-date 2026-06-01 --collection-fee-input blood_venous --comment-code 820100129 --comment-code 830100111 --fail-on-error --fail-on-review` を実行し、OK 7,094 / `needs_review` 0 / error 0となることを確認した。出力は `data/work/nationwide-outpatient-lab-smoke-policy-ignore-2026-06-01.md` で、messagesは0件である。監査が必要な場合は `--lab-management-facility-missing-policy review` を指定する。

## 参照

- 支払基金 基本マスター: https://www.ssk.or.jp/smph/seikyushiharai/tensuhyo/kihonmasta/index.html
- 支払基金 医科診療行為マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_01.html
- 支払基金 医薬品マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_04.html
- 支払基金 特定器材マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_05.html
- 支払基金 コメントマスター・コメント関連テーブル: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.html
- 支払基金 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
- 支払基金 医科電子点数表の活用手引き: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.files/tensuhyo_01.pdf
- 厚生労働省 令和8年度診療報酬改定: https://www.mhlw.go.jp/stf/newpage_67729.html
- 厚生労働省 医科診療報酬点数表: https://www.mhlw.go.jp/content/10808000/001662535.pdf
- 厚生労働省 診療報酬の算定方法の一部改正に伴う実施上の留意事項: https://www.mhlw.go.jp/content/12400000/001697752.pdf
