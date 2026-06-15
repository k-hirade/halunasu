# 令和8年度診療報酬改定 公式マスター鮮度監査

作成日: 2026-06-15  
対象: ハルナス診療報酬算定サービスの公式マスター、標準SQLite、STG/PROD配布物、テストデータ

この文書は `docs/fee-reiwa8-2026-master-gap-2026-06-15.md` を上書きせず、別ファイルとして作成した監査レポートである。

## 結論

現在の診療報酬算定マスターは、令和8年度改定の本番運用前提として古い。

確実に古いと判断できる理由は次の通り。

- 厚生労働省は、令和8年度診療報酬改定について「診療報酬本体及び材料は令和8年6月1日施行、薬価は令和8年4月1日施行」と公式に示している。
- 支払基金の現行ページでは、令和8年基本マスターとして医科診療行為、医薬品、特定器材、コメント、コメント関連テーブル、医科電子点数表の新しい版が公開されている。
- 一方、リポジトリと標準SQLiteは `2026-05-01` スナップショットを基準にしており、医科電子点数表も令和6年度版の `2026-05-01` を使っている。
- DPC系テーブルはSQLite上で0件であり、厚労省が令和8年度DPC電子点数表の正式版を複数回更新している状態と一致していない。
- STG/PRODの `/readyz` はマスターgzipの存在とサイズしか返しておらず、どの公式マスター版が入っているかを外部から証明できない。さらにSTGとPRODでgzipサイズが異なる。

したがって、令和8年6月1日以降の診療日について、現状の算定結果を「令和8年度マスター準拠」と扱ってはいけない。

## 調査範囲

確認したもの:

- 厚生労働省 令和8年度診療報酬改定ページ
- 厚生労働省 令和8年4月制度変更ページ
- 支払基金 令和8年基本マスターの現行公開ページ
- 支払基金 医科及び歯科電子点数表ページ
- ローカル `configs/official-master/2026-05-01`
- ローカル `configs/regional-master/2026-05-01`
- ローカル `python/data/master/standard-master.sqlite`
- `master_sources` テーブル
- STG/PROD `fee-api` readyz
- 関連するRunbook、テストデータ生成スクリプト、算定APIのコード

今回まだ実施していないもの:

- 令和8年6月公開ZIP/CSVをダウンロードして、コード単位の点数diffを出すこと。
- 厚労省PDF本文をすべて展開し、個別点数・施設基準・疑義解釈をロジックに落とすこと。

このため、本レポートでは公式ページ上で確認できる公開日・件数・データ種別のずれを確定事実として扱う。個別コードの点数差分は、次工程の公式ZIP/告示PDF diffで確定させる。

## 公式情報で確認できた事実

### 1. 施行日

厚生労働省の「厚生労働省関係の主な制度変更（令和8年4月）」では、令和8年度診療報酬改定について次が示されている。

- 診療報酬本体及び材料: 令和8年6月1日施行
- 薬価: 令和8年4月1日施行

出典: https://www.mhlw.go.jp/stf/newpage_71570.html

### 2. 厚労省の令和8年度改定ページ

厚生労働省の令和8年度診療報酬改定ページには、少なくとも次の領域が掲載されている。

- 算定方法、医科点数表、歯科点数表、調剤点数表
- 実施上の留意事項
- 基本診療料の施設基準
- 特掲診療料の施設基準
- 施設基準届出チェックリスト
- 疑義解釈その1からその7
- 2026-04-02、2026-05-01、2026-05-29の訂正通知
- 特定保険医療材料、特定診療報酬算定医療機器
- DPC電子点数表
- DPC退院患者調査、外来・在宅・リハビリテーション医療の影響評価調査
- 手術基幹コード STEM7

出典: https://www.mhlw.go.jp/stf/newpage_67729.html

### 3. 支払基金の現行基本マスター

支払基金の現行ページでは、令和8年基本マスターとして次が公開されている。

| 種別 | 公式の現行公開状態 | 公式件数 | 現ローカルDB | ずれ |
| --- | --- | ---: | --- | --- |
| 医科診療行為マスター | 2026-06-05 | 11,746 | 2026-05-01 / 10,192 | 1,554件差。現行DBが古い |
| 医薬品マスター | 2026-06-11 | 18,495 | 2026-03-17 / 19,337 | 公開日・件数とも差。現行DBが古い |
| 特定器材マスター | 2026-05-29 | 1,395 | 2026-02-27 / 1,380 | 15件差。現行DBが古い |
| コメントマスター | 2026-06-05 | 4,593 | 2025-07-15 / 3,759 | 834件差。現行DBが古い |
| コメント関連テーブル | 2026-06-05 | 18,201 | 2025-09-01 / 14,719 | 3,482件差。現行DBが古い |
| 医科電子点数表 | 令和8年度版 2026-06-01 | ZIP公開 | 令和6年度版 2026-05-01 | 年度版が違う |

出典:

- 医科診療行為マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html
- 医薬品マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html
- 特定器材マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html
- コメントマスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html
- 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html

## ローカル実装で確認した現状

### 1. 固定されているマスターmanifest

現在の固定manifest:

- `configs/official-master/2026-05-01/ssk-master-catalog.json`
- `configs/official-master/2026-05-01/standard-master-build.json`
- `configs/regional-master/2026-05-01/regional_manifest.json`

`ssk-master-catalog.json` は、旧パス `.../kihonmasta/r06/...` を参照している。支払基金の現行ページは `.../kihonmasta/kihonmasta_01.html` のような令和8年ページへ移っており、catalog discovery自体の更新が必要。

### 2. 標準SQLite

ローカルDB:

- `python/data/master/standard-master.sqlite`
- `python/data/master/standard-master.sqlite.gz`

`master_sources` の主要6種:

| source_type | source_version | published_at | rows | raw_path |
| --- | --- | --- | ---: | --- |
| medical_procedure_master | 2026-05-01 | 2026-05-01 | 10,192 | `s_ALL20260501.csv` |
| drug_master | 2026-05-01 | 2026-03-17 | 19,337 | `y_r07_ALL20260317.csv` |
| specific_material_master | 2026-05-01 | 2026-02-27 | 1,380 | `t_ALL20260227.csv` |
| comment_master | 2026-05-01 | 2025-07-15 | 3,759 | `c_ALL20250715.csv` |
| comment_related_table | 2026-05-01 | 2025-09-01 | 14,719 | `ck_ALL_20250901.csv` |
| medical_electronic_fee_table | 2026-05-01 | 2026-05-01 | 349,688 | `tensuhyo_02` |

この状態は、令和8年6月1日以降の算定に対して古い。

### 3. DPC

SQLite上のDPC関連テーブル:

- `dpc_electronic_table_rows`: 0件
- `dpc_hospital_coefficients`: 0件
- `dpc_point_table`: 0件
- `dpc_conversion_table`: 0件

一方、厚労省は令和8年度DPC電子点数表の正式版を2026-03-18、2026-04-15、2026-05-19に更新している。

現状のサービスはDPCをreview-onlyに寄せる設計なら安全側だが、「DPCを算定できる」扱いにしてはいけない。DPC候補、DPCレビュー、入院基本料の分離は引き続き必須。

### 4. 地方厚生局・施設基準

ローカルの地方厚生局manifestは `2026-05-01`。九州厚生局の保存済み公式HTMLには、令和8年度診療報酬改定に伴い次回更新は令和8年7月予定との記載がある。

つまり、施設基準データは5月1日時点の届出状況として有用だが、令和8年度改定後の施設基準名、略称、届出反映、加算要件としては追跡更新が必要。

### 5. STG/PROD配布物

2026-06-15時点で公開readyzを確認した。

| 環境 | URL | master gzip | 問題 |
| --- | --- | ---: | --- |
| STG | `https://fee.stg.halunasu.com/api/fee/readyz` | 191,827,317 bytes | 版情報が出ない。PRODとサイズが違う |
| PROD | `https://fee.halunasu.com/api/fee/readyz` | 141,582,636 bytes | 版情報が出ない。STGとサイズが違う |

`/readyz` は `master_sources` のsource_type、source_version、published_at、row_count、checksumを返していない。したがって、外部から「令和8年マスターが正しく入っている」と証明できない。

## 洗い出しが必要な点

### P0: 公式マスター取り込み

次をすべて取り直す必要がある。

- 医科診療行為マスター
- 医薬品マスター
- 特定器材マスター
- コメントマスター
- コメント関連テーブル
- 医科電子点数表 令和8年度版

新しいmanifestは `2026-06-15` のような取得スナップショット日で切り、各entryには公式公開日を個別に保持するのがよい。公式ファイルの公開日は揃っていないため、`source_version = 2026-06-01` のように施行日だけで固定すると追跡性が落ちる。

### P0: catalog discoveryの更新

現行 `ssk-master-catalog.json` は令和6年パスを参照している。令和8年の現行ページに合わせて、少なくとも次のURLを探索対象にする必要がある。

- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html`
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html`
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html`
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html`
- `https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html`

既存CLIが旧 `r06` ページしか見ないなら、令和8年版の最新全件ファイルを発見できない。

### P0: 標準SQLite再ビルド

新manifestでDBを再ビルドし、少なくとも次を確認する。

- `medical_procedures` が公式11,746件になること。
- `drugs` が公式18,495件になること。
- `specific_materials` が公式1,395件になること。
- `comments` が公式4,593件になること。
- `comment_links` が公式18,201件になること。
- 医科電子点数表が令和8年度版 2026-06-01由来になること。
- `master_sources.url` が空ではなく、公式URLを保持すること。
- checksumとrow_countがbuild reportに残ること。

### P0: STG/PROD配布物の版証明

`/readyz` または管理APIで、次を返す必要がある。

- master DB checksum
- gzip checksum
- source_type別のsource_version
- published_at
- row_count
- imported_at
- 医科電子点数表の年度版

STG/PRODでgzipサイズが異なる状態は、意図している差分か、デプロイ漏れか、ビルド時点違いかが判別できない。令和8年マスター更新時は、STGとPRODの版情報が一致していることを確認してから本番扱いにする。

### P0: テストデータの再ベースライン

現在のテストデータ生成スクリプトには `masterVersion: "2026-05-01"` が残っている。

- `scripts/generate_fee_soap_e2e_cases.mjs`
- `scripts/generate_fee_soap_e2e_coverage_800.mjs`
- `docs/tests/fee-chart-to-claim-gold-dataset-plan.md`
- `data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json`
- `data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json`

マスター更新後は、既存のexpected total、expected code、review topic、forbidden candidateを再検証する必要がある。古い点数を正解ラベルにしたまま新マスターでE2Eを回すと、アプリが正しくなってもテストが落ちる。

### P1: DPC取り扱い

厚労省のDPC電子点数表が令和8年度版として更新済みである一方、現行SQLiteのDPCテーブルは0件。

選択肢は2つ。

1. DPCは引き続きreview-onlyに固定し、UI/API/テストで「確定算定しない」と明示する。
2. DPC電子点数表、DPC係数、DPC分類、包括・出来高分離ロジックを正式に取り込む。

どちらを選ぶ場合でも、現状のようにテーブル0件のままDPCに関する候補だけを出す場合は、DPC確定算定ではないことをUIとログで明確にする必要がある。

### P1: 入院基本料・施設基準辞書

`services/fee-api/src/clinical-calculation-input.js` には `ACUTE_GENERAL_INPATIENT_BASIC_CODES` がある。これはコード固定の推論であり、令和8年度改定で入院基本料の体系、施設基準名、略称、届出要件が変わる場合に壊れやすい。

対応方針:

- 入院基本料候補は、ハードコードよりも新マスターと電子点数表から引く。
- 施設基準辞書は令和8年度の略称・届出名で更新する。
- 地方厚生局の7月更新予定を踏まえ、6月時点の施設基準データは暫定扱いにする。

### P1: コメント・コメント関連テーブル

コメントマスターは3,759件から4,593件、コメント関連テーブルは14,719件から18,201件へ増えている。

影響:

- 必須コメント判定
- 検査、処置、画像、薬剤、材料のレビュー理由
- レセプト記載候補
- `comment_links` を使うfrequency/exclusion周辺

旧コメント体系で「コメント不足なし」と判定すると、令和8年度ではコメント不足を見逃す可能性がある。

### P1: 医科電子点数表

現行ローカルは令和6年度版 2026-05-01の医科電子点数表を使っている。公式には令和8年度版 2026-06-01が公開されている。

影響:

- 包括
- 背反
- 同日、週、月の算定不可
- 算定回数
- 入院基本料テーブル
- 補助マスター

この領域は点数そのものよりも過剰算定防止に直結する。令和8年度版への更新はP0/P1相当。

### P1: 医薬品と選定療養

医薬品マスターは2026-06-11版が公式公開されている。ローカルは2026-03-17版。

影響:

- 薬剤料
- 経過措置医薬品
- 廃止・新設薬剤
- 長期収載品の選定療養対象
- 商品名、一般名、単位、薬価

現状はSOAPから薬剤候補を抽出しても、薬剤料を正しく確定できないケースが増える。

### P1: 特定器材

特定器材マスターは2026-05-29版が公式公開されている。ローカルは2026-02-27版。

影響:

- 処置、手術、在宅、材料を伴う算定
- 特定保険医療材料価格
- 材料コード廃止・新設

現在のプロダクトが外来検査中心なら直撃頻度は低いが、材料を含むテストや将来の手術・処置拡張では必須。

### P2: 通知・疑義解釈・訂正通知の反映

支払基金マスターを入れ替えるだけでは足りない。

厚労省ページには、疑義解釈その1からその7、4/2・5/1・5/29の訂正通知、施設基準届出チェックリスト訂正が掲載されている。これらは次に影響する。

- レビュー理由
- 自動確定してよいかどうか
- 施設基準が必要な加算の扱い
- コメントや記載要件
- 医療事務向け説明文
- 未対応領域を候補化するか、review-onlyにするか

通知/PDFの読解結果を、ルールエンジンとレビュー文言へ反映する作業が別途必要。

### P2: UI上のマスター鮮度表示

fee-webには、ユーザーが現在の算定マスター版を判断できる表示が必要。

最低限:

- 算定画面に「適用中マスター: 2026-06-xx snapshot」の表示
- 診療日がマスターの適用範囲より後の場合の警告
- STG/PRODで異なるマスターが入っている場合の管理者警告
- 算定結果のmetadataに source_type別source_version を保存

## 具体的な更新手順案

1. 既存DBとgzipを退避する。
2. `configs/official-master/2026-06-15/ssk-master-catalog.json` を作る。
3. 令和8年の現行支払基金ページから全件ZIPを取得する。
4. `configs/regional-master` はまず `2026-05-01` を継続利用し、7月更新で再取得する。6月中は「施設基準は5月1日現在」と明示する。
5. `standard-master-build.json` を生成する。
6. `validate-standard-master-build-manifest` を通す。
7. `build-standard-master-db` で新SQLiteを作る。
8. `master_sources` と公式ページの件数を照合する。
9. DPCテーブルが0件のままなら、DPCは明示的にreview-onlyに固定する。
10. `python/data/master/standard-master.sqlite.gz` を差し替える。
11. local fee APIで代表ケースを実行する。
12. v2 datasetのexpectedを新マスターで再ベースラインする。
13. STGへCloud Run deployする。
14. STG readyzでsource summaryを確認する。
15. STG E2Eを少数、次に広範囲で実行する。
16. 問題がなければPRODへdeployする。
17. PROD readyzでSTGと同じsource summary/checksumであることを確認する。

## 直ちに修正すべき実装

### 1. readyzの情報不足

現状:

- gzip pathとサイズしか見えない。

TOBE:

- source_type別に `source_version`, `published_at`, `row_count`, `checksum_sha256`, `raw_path`, `url` を返す。

### 2. Runbookのsource-version固定

現状:

- `official-master-update-runbook.md` は `2026-05-01` を前提にしている。

TOBE:

- 令和8年の現行ページに対応した探索URLと、snapshot日ベースのsource_version運用へ更新する。

### 3. master_sources.urlの欠落

現状:

- SSK主要6種の `url` が空。

TOBE:

- 公式URLをDBに保存し、算定結果metadataにも残す。

### 4. DPCテーブル0件の扱い

現状:

- DPC関連テーブルが空でもコード上はDPCレビュー候補が存在する。

TOBE:

- DPC確定算定は不可と明示する。
- DPC正式対応をするなら、厚労省DPC電子点数表と係数を取り込む。

### 5. テストデータの旧masterVersion

現状:

- テスト生成・評価データに `2026-05-01` が残る。

TOBE:

- master snapshotをデータセットmetadataに持たせ、E2Eログにも出す。
- 新マスターへ更新後にexpectedを再生成する。

## 実装前に断定しないこと

次は、公式ZIP/告示PDFの行単位確認前に断定しない。

- 再診料など個別コードの点数差分
- 処方箋料、特定疾患処方管理加算、検査判断料、画像診断料の変更有無
- 物価対応料など新設項目のコード、算定条件、既存候補への自動付与条件
- 旧コード廃止と新コード置換の正確な対応表

これらは、公式マスターZIP、厚労省告示、実施上の留意事項、疑義解釈、訂正通知の行単位diffで確定する。

## 参照URL

- 厚生労働省 令和8年度診療報酬改定: https://www.mhlw.go.jp/stf/newpage_67729.html
- 厚生労働省 令和8年4月制度変更: https://www.mhlw.go.jp/stf/newpage_71570.html
- 支払基金 基本マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/index.html
- 支払基金 医科診療行為マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html
- 支払基金 医薬品マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html
- 支払基金 特定器材マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html
- 支払基金 コメントマスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html
- 支払基金 医科及び歯科電子点数表: https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
