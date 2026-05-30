# 診療報酬算定カバレッジ再監査レポート

作成日: 2026-05-30 JST  
対象: halunasu fee calculation runtime, standard master DB, fee API contract

## 結論

現在の実装は「公式マスターを参照した算定候補生成エンジン」ではあるが、「医科診療報酬点数表の全章を本番算定できるエンジン」ではない。

特に、以前の整理にあった「マスターデータ取り込みは100%カバー」「DPC実装済み」は本番観点では訂正が必要である。2026-05-30時点の公式最新マスターと実行DBを突合すると、医科診療行為、医薬品、特定器材、コメント、コメント関連テーブルのいずれも差分がある。DPC系テーブルはテーブル定義こそ存在するが、実行DB内は0件であり、コード上もDPCはレビュー扱いである。

本番で使うなら、短期的には「外来検体検査を中心にした算定支援」と明示するべきである。手術、麻酔、リハビリ、精神科専門療法、在宅、医学管理等まで含む「本番算定」には、マスター更新基盤と章別算定ロジックの両方が不足している。

## 公式最新マスターとの差分

公式ページは支払基金と厚労省の公開情報を2026-05-30に再確認した。コメントマスターはブラウザ取得では古いキャッシュが返る場合があったため、同日に `curl -sS -L` で本文も確認した。

| 種別 | 公式最新 | 実行DB | 公式にあるがDBにない | DBにあるが公式最新にない | 点数/金額差分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 医科診療行為マスター | 11,737件, 2026-05-22 | 10,192件 | 2,088件 | 543件 | 1,654件 |
| 医薬品マスター | 18,428件, 2026-05-22 | 19,337件 | 160件 | 1,069件 | 12,715件 |
| 特定器材マスター | 1,395件, 2026-05-29 | 1,380件 | 21件 | 6件 | 262件 |
| コメントマスター | 4,643件, 2026-05-29 | 3,759件 | 897件 | 13件 | 対象外 |
| コメント関連テーブル | 30,268件, 2026-05-15 | 14,719件 | 未精査 | 未精査 | 対象外 |
| 医科電子点数表 | 令和8年度版, 2026-05-01 | 349,688行 | 未精査 | 未精査 | 対象外 |

差分例:

| 種別 | コード | 公式最新 | 実行DB |
| --- | --- | ---: | ---: |
| 医科診療行為 | 112007410 | 76.0点 | 75.0点 |
| 医薬品 | 610406079 | 9.5円 | 15.1円 |
| 特定器材 | 710010001 | 18,100円 | 13,600円 |

現行の固定catalogは `configs/official-master/2026-05-01/ssk-master-catalog.json` であり、医科診療行為・医薬品・特定器材・コメント・コメント関連テーブルのURLが `/kihonmasta/r06/...` 配下を参照している。現在の公式ページは `/kihonmasta/kihonmasta_01.html` などの令和8年ページで更新されており、5月後半の更新を拾えていない。

## 実行DBの状態

対象DB: `halunasu/python/data/master/standard-master.sqlite`

| テーブル | 件数 |
| --- | ---: |
| medical_procedures | 10,192 |
| drugs | 19,337 |
| specific_materials | 1,380 |
| comments | 3,759 |
| comment_links | 14,719 |
| electronic_aux_master | 11,736 |
| electronic_bundles | 247,949 |
| electronic_exclusions | 77,334 |
| electronic_frequency_limits | 5,915 |
| electronic_inpatient_basic | 6,754 |
| hospital_registry | 88,338 |
| hospital_facility_standards | 1,238,320 |
| dpc_electronic_table_rows | 0 |
| dpc_point_table | 0 |
| dpc_conversion_table | 0 |
| dpc_icd_table | 0 |
| dpc_surgery_table | 0 |
| dpc_piecework_surgery_codes | 0 |
| dpc_hospital_coefficients | 0 |

DPCについては、厚労省が「診断群分類（DPC）電子点数表」を令和8年5月19日更新分まで公開しているが、実行DBには投入されていない。

## 算定ロジックの章別カバレッジ

| 公式区分 | 現状 | 評価 |
| --- | --- | --- |
| A000系 初・再診 | `outpatient_basic.py` で初診/再診/外来診療料など一部候補を生成 | 部分対応 |
| A100系 入院料等 | `inpatient_fees.py` で明示入力された入院基本料コードを候補化。DPCはレビュー扱い | 部分対応 |
| B000系 医学管理等 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| C000系 在宅医療 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| D000系 検査 | D026判断料、検体検査管理加算、採取料、外来迅速検体検査加算、頻度制限警告などあり | 最も厚い対応 |
| E000系 画像診断 | `imaging_fees.py` で一部モダリティと画像診断管理加算/遠隔画像診断を候補化 | 限定対応 |
| F000系 投薬 | 外来の院内/院外、処方せん料、後発名処方加算等の候補化。入院時投薬はブロック | 外来限定 |
| G000系 注射 | 一部経路と加算のみ候補化 | 限定対応 |
| H000系 リハビリ | 専用ロジックなし。単位数計算なし | 未対応 |
| I000系 精神科専門療法 | 専用ロジックなし。時間区分/回数判定なし | 未対応 |
| J000系 処置 | `treatment_fees.py` で一部処置のみ候補化 | 限定対応 |
| K000系 手術 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| L000系 麻酔 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| M000系 放射線治療 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| N000系 病理診断 | 専用ロジックなし。入力コードのマスターlookupのみ | 未対応 |
| 第3章 DPC | DPCテーブル0件。コード上もレビュー扱い | 未対応 |

重要なのは、`procedure_resolver.resolve_medical_procedure_lines` が入力された診療行為コードをマスターから引き、点数行を `CONFIRMED` として返している点である。これは「コードのface valueを返す」だけで、章固有の加算、減算、包括、回数制限、施設基準、年齢/時間帯/部位/単位数の判定ではない。

このため、手術K、麻酔L、リハH、精神I、在宅C、医学管理Bなどは、見かけ上はコード行が出ても、本番算定としては不足する。

## 施設基準の認識範囲

`facility_standard_dictionary.py` のルールは18件である。

| カテゴリ | 件数 | 内容 |
| --- | ---: | --- |
| 検体検査管理加算 | 4 | 検体検査管理加算1-4 |
| 画像診断管理/遠隔画像診断 | 5 | 画像診断管理加算1-4、遠隔画像診断 |
| 入院基本料系 | 9 | 一般、特定機能、専門、療養、精神、結核、障害者、有床診、有床診療養 |

地方厚生局データ自体は大規模に取り込まれているが、算定ロジックが解釈できる施設基準辞書は限定的である。手術、麻酔、リハビリ、精神科専門療法、在宅、医学管理等の施設基準は、現時点では自動判定の対象外である。

## UI/API契約

`packages/fee-contracts/src/index.js` の入力区分は次の8種である。

```js
["lab", "drug", "injection", "treatment", "imaging", "procedure", "other", "unknown"]
```

診療場所は次の2種である。

```js
["outpatient", "inpatient"]
```

この契約では、医学管理、在宅、リハビリ、精神科専門療法、手術、麻酔、放射線治療、病理診断を個別のorder typeとして表現できない。現状は `procedure` として標準コードを渡すしかない。

## テストの現状

fee関連として確認したテスト定義は144件である。このうち `python/tests/legacy_medical_fee_calculation/test_importer_and_d026.py` が113件を占める。

| 領域 | 確認結果 |
| --- | --- |
| Python legacy medical fee tests | 126件 |
| Python package/fee API bridge tests | 2件 |
| fee-api tests | 9件 |
| fee-contracts tests | 4件 |
| fee-core tests | 3件 |

`test_importer_and_d026.py` の113件には、検査、投薬、注射、処置、画像、入院基本料、DPCレビュー、Order CSV、Gold評価、マスター取り込み、地方厚生局取り込みが含まれる。ただし、手術、麻酔、リハビリ、精神科専門療法、放射線治療、病理診断、在宅、医学管理の専用算定ロジックを検証するテストはない。

## 提示メモからの訂正点

| 提示内容 | 再監査後の訂正 |
| --- | --- |
| マスターデータ取り込みは100%カバー | `2026-05-01` 固定catalogを取り込んでいるだけ。2026-05-30時点の公式最新とは差分あり |
| DPCマスタ取り込み済み | DPCテーブルは存在するが全て0件。DPC算定は未投入/未実装 |
| DPC包括算定は実装済み | `inpatient_fees.py` はDPCをレビュー扱いにする設計。グルーピングエンジンも未確認/未実装 |
| procedure passthroughで全コード対応 | コードlookupには対応するが、章固有ルールは計算しない。本番算定とは別物 |
| 施設基準辞書で幅広く対応 | 18ルールのみ。検査、画像、入院基本料系に限定 |
| 売上カバレッジ30-45% | 実装上の肌感としては近い可能性があるが、本監査ではNDB等で再計算していないため確定値として扱わない |

## 修正方針

### P0: 表示とステータスの是正

本番事故を防ぐため、まず「できること」を正確に表示する。

- プロダクト表現を「本番算定」ではなく「算定候補」「要レビュー付き算定支援」に変更する。
- 未対応章の `procedure` passthroughは `CONFIRMED` ではなく、`NEEDS_REVIEW` または `calculation_mode = master_lookup_only` として返す。
- 結果UIに「マスターlookupのみ」「章別算定ロジック未対応」「施設基準未判定」を明示する。
- APIレスポンスに `coverage.scope`, `coverage.chapter`, `coverage.support_level` を追加する。

2026-05-30 実装状況:

- Done: `procedure_resolver.resolve_medical_procedure_lines` の単純マスター一致を `CONFIRMED` から `NEEDS_REVIEW` に変更した。これにより、未対応章の procedure passthrough は確定算定として扱わない。
- Done: Python raw result、Fee API、`fee-core` 正規化結果に `coverage`, `supportLevel`, `reviewRequired` を追加した。
- Done: `fee-web` は「確定請求」ではなく「算定候補・レビュー支援」と表示し、行ごとに coverage / support level / review required を表示する。
- Done: `scripts/audit_fee_master_coverage.py` と `npm run audit:fee-master` を追加し、実行DBの主要テーブル件数、DPC空テーブル、固定catalogの `/r06/` 参照を機械的に検出できるようにした。
- Not done in this P0: 公式サイトから最新catalogを取得してDBを再ビルドする作業。これはネットワーク取得と大きなDB成果物更新を伴うため、P1として分離する。

### P1: 公式マスター更新基盤の修正

今のままでは本番データ差し替えの前に公式最新との差分を見落とす。

1. `configs/official-master/<date>/ssk-master-catalog.json` を令和8年公式ページから再生成する。
2. `/kihonmasta/r06/...` ではなく、現在の `/kihonmasta/kihonmasta_01.html` などをsource pageにする。
3. 公式ページの表示件数、ZIPファイル名、CSV行数、コード集合、点数/金額差分を検証するauditコマンドを追加する。
4. `standard-master.sqlite` と `standard-master.sqlite.gz` を再ビルドする。
5. CIで「公式最新との差分」「DPCテーブル0件」「コメント関連テーブル半減」のような状態を失敗扱いにする。

### P2: DPCを未対応として分離

DPCは通常のA入院料とは別製品レベルで扱う。

- DPC電子点数表、点数表、変換表、ICD、手術、出来高、医療機関係数を個別にimportする。
- DB件数が0でないことをCIで保証する。
- グルーピング、入院期間、医療機関別係数、包括/出来高分岐のgold testを作る。
- これが完了するまでDPCは「レビュー対象」で固定する。

### P3: 章別ロードマップを製品ターゲットから決める

全章を一気に実装するより、PMFに直結する診療科から順に実装する。

クリニック向けであれば優先度は次が現実的である。

1. B 医学管理等: 特定疾患療養管理料、生活習慣病管理料、診療情報提供料、外来栄養食事指導料。
2. C 在宅医療: 在宅患者訪問診療料、在医総管/施医総管、訪問看護指示料、看取り加算。
3. H リハビリ: 疾患別リハ、施設基準、単位数、日数上限。
4. I 精神科専門療法: 通院精神療法の時間区分、月内回数、施設基準。
5. E/J/F/Gの拡張: 超音波、核医学、主要処置、入院投薬、注射加算。

病院向けであれば優先度は次に変わる。

1. A 入院料 + DPC基盤。
2. K 手術 + L 麻酔。
3. N 病理診断。
4. M 放射線治療。
5. B/C/H/Iの病院版。

### P4: テスト/goldの拡張

- 公式章別に最低1件のgold caseを作る。
- `procedure` passthroughが未対応章を `CONFIRMED` にしないことをテストする。
- 施設基準辞書は、追加する算定ロジックごとに届出略称、正式名称、地方厚生局表記ゆれをfixture化する。
- 電子点数表は「検出するだけ」から、適用可能な範囲だけでも「削除/包括/回数超過ブロック」へ段階的に進める。

## 本番用マスター差し替え手順

既存Runbookは `official-master-update-runbook.md` にあるが、現状は2026-05-01固定前提なので、次の順で更新する。

1. 公式SSKページから最新catalogを発見し、`configs/official-master/<source-version>/ssk-master-catalog.json` として固定する。
2. `download-ssk-master-catalog` でraw ZIP/CSVを保存する。
3. `prepare-standard-master-build-manifest` またはdownload時のmanifest生成で `standard-master-build.json` を作る。
4. `validate-standard-master-build-manifest` で必須kind、ファイル存在、source_version、未対応kindを検証する。
5. `build-standard-master-db` で `standard-master.sqlite` を再生成する。
6. 公式最新ZIPと新DBを突合し、コード欠落と点数/金額差分が意図した差分だけであることを確認する。
7. `standard-master.sqlite.gz` を生成し、`python/data/master/standard-master.sqlite.gz` を更新する。
8. fee-apiのruntimeでは `FEE_MASTER_DB_GZIP_PATH=/app/python/data/master/standard-master.sqlite.gz` を使い、起動時に `/tmp/halunasu-fee-master/standard-master.sqlite` へ展開させる。
9. `readyz` と外来検体検査smoke、章別gold testを通してからdeployする。

## 参照した主なファイル

- `configs/official-master/2026-05-01/ssk-master-catalog.json`
- `python/data/master/standard-master.sqlite`
- `python/medical_fee_calculation/lab_calculator.py`
- `python/medical_fee_calculation/procedure_resolver.py`
- `python/medical_fee_calculation/inpatient_fees.py`
- `python/medical_fee_calculation/electronic_rules.py`
- `python/medical_fee_calculation/facility_standard_dictionary.py`
- `packages/fee-contracts/src/index.js`
- `python/tests/legacy_medical_fee_calculation/test_importer_and_d026.py`

## 公式参照URL

- 支払基金 医科診療行為マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html
- 支払基金 医薬品マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html
- 支払基金 特定器材マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html
- 支払基金 コメントマスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html
- 支払基金 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
- 厚労省 令和8年度診療報酬改定について: https://www.mhlw.go.jp/stf/newpage_67729.html
- 厚労省 診断群分類（DPC）電子点数表について: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198757_00008.html
