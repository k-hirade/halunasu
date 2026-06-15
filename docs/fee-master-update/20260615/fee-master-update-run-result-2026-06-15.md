# 令和8年度診療報酬マスター更新 P0 実施結果

作成日: 2026-06-15

## 実施範囲

- 支払基金SSK catalog discoveryを令和8年度現行ページへ更新。
- `configs/official-master/2026-06-15/ssk-master-catalog.json` を公式ページから生成。
- `configs/official-master/2026-06-15/standard-master-build.json` を生成。
- 現行ランタイムDBは上書きせず、作業用DBとして `data/work/fee-master-2026-06-15/standard-master.sqlite` を構築。
- `/readyz` でマスター証跡を返すための詳細readinessを実装。

## 生成物

| 種別 | パス |
| --- | --- |
| SSK catalog | `configs/official-master/2026-06-15/ssk-master-catalog.json` |
| build manifest | `configs/official-master/2026-06-15/standard-master-build.json` |
| download report | `docs/fee-master-update/20260615/fee-master-download-2026-06-15.md` |
| build report | `docs/fee-master-update/20260615/fee-master-build-2026-06-15.md` |
| 作業用SQLite | `data/work/fee-master-2026-06-15/standard-master.sqlite` |
| 作業用gzip | `data/work/fee-master-2026-06-15/standard-master.sqlite.gz` |

`data/work/fee-master-2026-06-15/` は大容量のためGit管理対象外。

## 主要行数

| source_type | source_version | published_at | row_count |
| --- | --- | --- | ---: |
| medical_procedure_master | 2026-06-15 | 2026-06-05 | 11,746 |
| drug_master | 2026-06-15 | 2026-06-11 | 18,495 |
| specific_material_master | 2026-06-15 | 2026-05-29 | 1,395 |
| comment_master | 2026-06-15 | 2026-06-05 | 4,593 |
| comment_related_table | 2026-06-15 | 2026-06-05 | 18,201 |
| medical_electronic_fee_table | 2026-06-15 | 2026-06-01 | 350,054 |

## DB checksum

| ファイル | sha256 |
| --- | --- |
| `data/work/fee-master-2026-06-15/standard-master.sqlite` | `ae2a52454f2d348b0a404b9e88b179afa35f937c40a21a7d161245f476afc337` |
| `data/work/fee-master-2026-06-15/standard-master.sqlite.gz` | `0451c6eca0554ec36c72a8368f86ab79bc6589ed994cb645e9ae919daf0b8839` |

## 検証

- `PYTHONPATH=python python3 -m unittest python.tests.legacy_medical_fee_calculation.test_ssk_download`
- `node --test services/fee-api/test/python-calculator.test.js`
- `node --test services/fee-api/test/server.test.js`
- `PYTHONPATH=python python3 -m medical_fee_calculation.master_browser` with `{"type":"sources"}` against the work DB

## 未反映

- `python/data/master/standard-master.sqlite` は未更新。
- `python/data/master/standard-master.sqlite.gz` は未更新。
- STG/PROD Cloud Runへの反映は未実施。
- DPCテーブルは未投入のため、DPCは引き続きreview-only。

## 次の判断点

1. 作業用DBを `python/data/master/standard-master.sqlite(.gz)` へ昇格する。
2. fee-api STGへdeployし、`/readyz` で `masterSources[]` とchecksumを確認する。
3. v2/v1 E2Eを再実行し、期待値再ベースラインの必要箇所を洗い出す。
