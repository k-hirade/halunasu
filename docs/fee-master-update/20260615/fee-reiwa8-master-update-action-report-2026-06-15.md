# 令和8年度診療報酬改定マスター更新 公式確認・実装アクションレポート

作成日: 2026-06-15  
対象: `fee-api` / Python算定エンジン / 公式マスターSQLite / E2E gold dataset

この文書は次の2本を統合し、一次情報とローカルDBの確認結果をもとに、次に必要な作業を実装可能な形に整理したもの。

- `docs/fee-reiwa8-official-master-audit-2026-06-15.md`
- `docs/fee-reiwa8-2026-master-gap-2026-06-15.md`

## 結論

令和8年度診療報酬改定は、診療報酬本体・材料については 2026-06-01 施行で正しい。薬価は 2026-04-01 施行で別扱いが必要。

現行のハルナス算定マスターは、令和8年6月施行後の公式マスターとしては古い。ローカルSQLiteの主要ソースは `2026-05-01` スナップショットで、支払基金の現行公開状態と一致していない。特に、医科診療行為マスター、コメントマスター、コメント関連テーブル、医科電子点数表の差分が大きい。

したがって、2026-06-01以降の診療日について、現在の算定結果を「令和8年度公式マスター準拠」と扱ってはいけない。

## 今回実施した確認

### 1. 公式ページ確認

一次情報として次を確認した。

- 厚生労働省: 令和8年度診療報酬改定ページ
- 厚生労働省: 令和8年4月制度変更ページ
- 支払基金: 医科診療行為マスター
- 支払基金: 医薬品マスター
- 支払基金: 特定器材マスター
- 支払基金: コメントマスター
- 支払基金: 医科及び歯科電子点数表

公式ページで確認できた現行公開状態は次の通り。

| 種別 | 公式ページ上の更新日 | 公式件数 / 状態 |
| --- | --- | ---: |
| 医科診療行為マスター | 2026-06-05 | 11,746件 |
| 医薬品マスター | 2026-06-11 | 18,495件 |
| 特定器材マスター | 2026-05-29 | 1,395件 |
| コメントマスター | 2026-06-05 | 4,593件 |
| コメント関連テーブル | 2026-06-05 | 18,201件 |
| 医科電子点数表 | 2026-06-01 | 令和8年度版ZIP公開 |
| DPC電子点数表 | 2026-03-18 / 2026-04-15 / 2026-05-19 | 正式版が複数回更新 |

### 2. ローカルSQLite確認

確認対象:

- `halunasu/python/data/master/standard-master.sqlite`

`master_sources` の主要ソースは次の状態。

| source_type | source_version | published_at | row_count | 判定 |
| --- | --- | --- | ---: | --- |
| medical_procedure_master | 2026-05-01 | 2026-05-01 | 10,192 | 古い。公式 11,746件と不一致 |
| drug_master | 2026-05-01 | 2026-03-17 | 19,337 | 古い。公式 18,495件と不一致 |
| specific_material_master | 2026-05-01 | 2026-02-27 | 1,380 | 古い。公式 1,395件と不一致 |
| comment_master | 2026-05-01 | 2025-07-15 | 3,759 | 古い。公式 4,593件と不一致 |
| comment_related_table | 2026-05-01 | 2025-09-01 | 14,719 | 古い。公式 18,201件と不一致 |
| medical_electronic_fee_table | 2026-05-01 | 2026-05-01 | 349,688 | 令和6年度版 2026-05-01。令和8年度版ではない |

DPC系テーブルはすべて0件。

| table | rows |
| --- | ---: |
| dpc_electronic_table_rows | 0 |
| dpc_hospital_coefficients | 0 |
| dpc_point_table | 0 |
| dpc_conversion_table | 0 |

### 3. 取得スクリプト確認

確認対象:

- `halunasu/python/medical_fee_calculation/ssk_download.py`
- `halunasu/scripts/build_fee_master_official.py`
- `halunasu/python/medical_fee_calculation/standard_build.py`
- `halunasu/configs/official-master/2026-05-01/ssk-master-catalog.json`
- `halunasu/configs/official-master/2026-05-01/standard-master-build.json`

問題点:

- `SSK_MASTER_SOURCE_PAGES` の基本マスター探索元が `/kihonmasta/r06/...` に固定されている。
- 現在の支払基金ページは `/kihonmasta/kihonmasta_01.html` などの令和8年ページで更新されている。
- そのため、既存スクリプトのままでは令和8年6月時点の全件マスターを安定して発見できない。
- `build_fee_master_official.py` の既定値も `2026-05-01` に固定されている。
- `standard-master-build.json` も `2026-05-01` のrawファイルを前提にしている。

つまり、公式ZIPを取ってSQLiteを再ビルドする前に、catalog discoveryの更新が必要。

## 既存2レポートの評価

### `fee-reiwa8-official-master-audit-2026-06-15.md`

評価: 信頼度が高い。

正しい点:

- 公式マスターの現行公開状態とローカルDBのズレを一次情報ベースで整理している。
- 「現行DBを令和8年度マスター準拠として扱ってはいけない」という結論は正しい。
- DPCテーブル0件、readyzで版証明できない、STG/PRODのgzip差分を問題視している点も妥当。

補強すべき点:

- 実際の公式ZIP再取得・SQLite再ビルド・checksum照合はまだ未完了。
- readyzの版情報出力は実装作業として別途必要。

### `fee-reiwa8-2026-master-gap-2026-06-15.md`

評価: 方向性は有用だが、個別点数の確定資料としては扱わない。

有用な点:

- 再診料、物価対応料、一般名処方加算、医療DX系、入院基本料など、影響が大きい候補を列挙している。
- v2 gold dataset の再ベースラインが必要という指摘は正しい。

注意点:

- 個別点数の一部は二次情報ベースで書かれている。
- 公式告示PDFまたは支払基金マスターZIP diffで確認するまでは、個別コードの点数変更を「確定」として実装してはいけない。
- この文書は「公式diff前のギャップ仮説」として扱うべき。

## 実装アクション

### P0-1. 支払基金catalog discoveryを令和8ページへ更新

対象:

- `halunasu/python/medical_fee_calculation/ssk_download.py`

必要な変更:

- 医科診療行為、医薬品、特定器材、コメント、コメント関連テーブルのsource pageを `/kihonmasta/r06/...` から現行ページへ変更する。
- 現行ページ:
  - `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html`
  - `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html`
  - `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html`
  - `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html`
  - `https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html`
- source pageの見出しとリンク文言で全件ファイルを発見する。
- `source_page_url`、`published_at`、`retrieved_at`、`checksum_sha256` をcatalogに残す。

完了条件:

- 新catalogに6種の必須kindがすべて入る。
- 各entryが令和8年現行ページ由来になる。

### P0-2. `2026-06-15` スナップショットを新規作成

追加予定:

- `halunasu/configs/official-master/2026-06-15/ssk-master-catalog.json`
- `halunasu/configs/official-master/2026-06-15/standard-master-build.json`

方針:

- `source_version` は取得スナップショット日として `2026-06-15`。
- `published_at` はファイルごとの公式更新日を保持する。
- 施行日 `2026-06-01` と公開日 `2026-06-05` / `2026-06-11` は混同しない。

### P0-3. 公式ZIP取得・SQLite再ビルド

実行対象:

- 医科診療行為マスター
- 医薬品マスター
- 特定器材マスター
- コメントマスター
- コメント関連テーブル
- 医科電子点数表 令和8年度版

再ビルド後の必須検証:

| 種別 | 期待 |
| --- | ---: |
| medical_procedure_master | 11,746件 |
| drug_master | 18,495件 |
| specific_material_master | 1,395件 |
| comment_master | 4,593件 |
| comment_related_table | 18,201件 |
| medical_electronic_fee_table | 令和8年度版 2026-06-01由来 |

成果物:

- `halunasu/python/data/master/standard-master.sqlite`
- `halunasu/python/data/master/standard-master.sqlite.gz`
- `halunasu/docs/migration-parity/fee-master-build-2026-06-15.md`

### P0-4. readyzで版証明できるようにする

現状:

- gzipの存在とサイズは分かる。
- 中身がどの公式マスター版かは分からない。

必要な出力:

- `masterDbChecksumSha256`
- `masterDbGzipChecksumSha256`
- `masterSources[]`
  - `source_type`
  - `source_version`
  - `published_at`
  - `retrieved_at`
  - `row_count`
  - `checksum_sha256`
  - `source_url`
- `medicalElectronicFeeTableVersion`
- `dpcStatus`

完了条件:

- STG/PRODのreadyzだけで「令和8年6月公式マスターが入っているか」を説明できる。

### P0-5. 重要コードdiffを公式マスターで確定する

対象コード群:

- 初診料
- 再診料
- 外来・在宅物価対応料
- 処方箋料
- 一般名処方加算
- 特定疾患療養管理料
- 特定疾患処方管理加算
- 検体検査管理加算
- CRP、尿一般、尿蛋白、末梢血液一般、判断料、採血料
- 単純撮影、電子画像管理加算、CT撮影
- 入院基本料

注意:

- `fee-reiwa8-2026-master-gap-2026-06-15.md` の個別点数は、このdiffが完了するまで実装根拠にしない。

### P0-6. v2 / v1 E2E gold datasetの再ベースライン

マスター更新後、古い点数の期待値は壊れる。

対象:

- `data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json`
- `data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json`
- v1 coverage / random E2E

対応:

- `masterVersion` を `2026-06-15` に更新。
- claim-context再生で新点数を算出。
- exactの期待点数を再生成。
- review/safety系は forbidden / review topic を再検証。

### P1-1. DPC方針の固定

現状:

- DPCテーブルは0件。
- 公式DPC電子点数表は令和8年度正式版が公開済み。

方針はどちらかに固定する。

1. DPCは未対応としてreview-onlyに固定する。
2. DPC電子点数表、係数、分類、包括/出来高分離を正式に取り込む。

短期は1が安全。DPCを自動算定可能に見せないこと。

### P1-2. 入院基本料ロジックの令和8対応

現状:

- `ACUTE_GENERAL_INPATIENT_BASIC_CODES` のような旧体系ハードコードが残っている。

対応:

- 新マスター・電子点数表から入院基本料候補を引く。
- 急性期病院A/B等の新体系は施設基準と紐付けてreviewに出す。
- ハードコード表は縮小または廃止する。

## 実行順

1. `ssk_download.py` のsource pageを令和8現行ページへ更新。
2. `2026-06-15` catalog discoveryを実行。
3. 公式ZIPを保存。
4. `standard-master-build.json` を生成。
5. SQLiteを再ビルド。
6. row_count / checksum / source_url を検証。
7. readyzの版証明を実装。
8. STGにdeploy。
9. readyzでSTGの版を確認。
10. 重要コードdiffを作成。
11. v2 / v1 gold datasetを再ベースライン。
12. E2Eを再実行。
13. PRODへ反映。

## 今回まだ実行していないこと

この文書作成時点では、公式ZIPのダウンロード、SQLite再ビルド、STG/PRODへの反映はまだ行っていない。

理由:

- 既存のcatalog discoveryが旧 `/r06/` ページに固定されており、先にスクリプト更新が必要。
- 個別点数diffは、公式ZIP取り込み後に行うべき作業。
- 大容量SQLite/gzipの更新は、専用ブランチまたは明示的な作業単位で実施する方が安全。

## 公式ソース

- 厚生労働省 令和8年度診療報酬改定: https://www.mhlw.go.jp/stf/newpage_67729.html
- 厚生労働省 制度変更（令和8年4月）: https://www.mhlw.go.jp/stf/newpage_71570.html
- 支払基金 医科診療行為マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html
- 支払基金 医薬品マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html
- 支払基金 特定器材マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html
- 支払基金 コメントマスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html
- 支払基金 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
