# 公式マスター更新Runbook

## 目的

全病院向けの概算算定を同じ前提で再実行できるように、支払基金公式マスター、医科電子点数表、地方厚生局manifestを1つの標準SQLiteへ更新する。

2026-05-18時点の固定入力は次である。

| 種別 | パス |
| --- | --- |
| 支払基金URL catalog | `configs/official-master/2026-05-01/ssk-master-catalog.json` |
| 標準DB build manifest | `configs/official-master/2026-05-01/standard-master-build.json` |
| raw保存先 | `data/raw/ssk` |
| 地方厚生局manifest | `configs/regional-master/2026-05-01/regional_manifest.json` |
| 標準SQLite | `data/work/standard-master.sqlite` |

## 月次更新手順

### 1. 公式URL catalogを再発見する

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli discover-ssk-master-catalog \
  --source-version 2026-05-01 \
  --format catalog \
  --output data/work/ssk-master-catalog.discovery.json
```

新しい月次版を作る場合は、`--source-version` と出力先の日付ディレクトリを更新する。

### 2. 前回catalogとの差分を見る

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli diff-ssk-master-catalog \
  --old configs/official-master/2026-05-01/ssk-master-catalog.json \
  --new data/work/ssk-master-catalog.discovery.json \
  --format markdown \
  --output data/work/ssk-master-catalog-diff.md
```

差分がなければ、既存rawとmanifestでDB再ビルドできる。URL、ファイル名、公開日に差分がある場合は、新しい `configs/official-master/<source-version>/ssk-master-catalog.json` として固定してから次へ進む。

CIで公式URL変更を検知して止める場合は `--fail-on-change` を付ける。

### 3. raw保存とbuild manifest生成を行う

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-ssk-master-catalog \
  --catalog configs/official-master/2026-05-01/ssk-master-catalog.json \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --standard-manifest-output data/work/standard-master-build.json \
  --format markdown \
  --output data/work/ssk-master-catalog-download.md \
  --fail-on-error \
  --fail-on-missing
```

rawを再取得する場合は `--overwrite` を付ける。ネットワークを使わず、既存rawだけからmanifestを作る場合は `prepare-standard-master-build-manifest` を使う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli prepare-standard-master-build-manifest \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --output data/work/standard-master-build.json \
  --fail-on-missing
```

### 4. DB投入前にmanifestをdry-run検証する

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-standard-master-build-manifest \
  --manifest data/work/standard-master-build.json \
  --format markdown \
  --output data/work/standard-master-build-validation.md \
  --fail-on-error
```

検証では次を確認する。

- 必須kindが揃っていること。
- `path` または `csv_paths` が存在すること。
- DB投入時に必要な `source_version` があること。
- 未対応kindが混入していないこと。

固定manifestを直接検証する場合は次を使う。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-standard-master-build-manifest \
  --manifest configs/official-master/2026-05-01/standard-master-build.json \
  --format markdown \
  --output data/work/standard-master-build-validation.md \
  --fail-on-error
```

### 5. 標準SQLiteを再ビルドする

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli build-standard-master-db \
  --db data/work/standard-master.sqlite \
  --manifest data/work/standard-master-build.json \
  --format markdown \
  --output data/work/standard-master-build-report.md \
  --fail-on-error
```

2026-05-17の実績では、支払基金6種と地方厚生局manifest 35 entriesを投入し、build 41 entries OK / error 0だった。

### 6. 更新後smokeを実行する

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli smoke-hospital-run-targets \
  --db data/work/standard-master.sqlite \
  --service-date 2026-06-01 \
  --format markdown \
  --fail-on-error

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

ここまで通れば、実オーダーCSV pipelineとgold差分分類を同じDB前提で再実行できる。

## 完了条件

| 条件 | 判定 |
| --- | --- |
| catalog差分が確認済み | `data/work/ssk-master-catalog-diff.md` がある |
| build manifestが検証済み | `standard-master-build-validation.md` が `Ready: yes` |
| 標準DB buildが成功 | `standard-master-build-report.md` が error 0 |
| hospital profile smokeが成功 | `smoke-hospital-run-targets` が error 0 |
| 全国外来検体検査smokeが成功 | `run-nationwide-outpatient-lab-smoke` が error 0 |

## 残る課題

- 地方厚生局manifest自体の月次更新は [地方厚生局データ更新Runbook](./regional-master-update-runbook.md) で扱う。
- 支払基金以外の傷病名、修飾語、DPC電子点数表、DPC係数は未投入。
- 実CSV/gold差分で見つかった不足は、order CSV contract、コメント入力、算定ロジック、マスター更新のどれに返すかを分類して改善する。
