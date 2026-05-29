# 地方厚生局データ更新Runbook

## 目的

全病院向けの `hospital_profile` を月次で再構築できるように、各地方厚生局の医療機関コード一覧と施設基準届出名簿を取得し、全国manifestとして固定・検証・smoke importする。

2026-05-18時点の固定入力は次である。

| 種別 | パス |
| --- | --- |
| 地方厚生局manifest | `configs/regional-master/2026-05-01/regional_manifest.json` |
| raw保存先 | `data/raw/kouseikyoku` |
| manifest検証report | `data/work/regional-manifest-validation.md` |
| smoke report | `data/work/regional-manifest-smoke.md` |

## 月次更新手順

### 1. 全国catalogからrawとmanifestを作る

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli download-regional-catalog \
  --source-version 2026-05-01 \
  --raw-root data/raw/kouseikyoku \
  --format markdown \
  --output data/work/regional-catalog-download.md \
  --manifest-output data/raw/kouseikyoku/regional_manifest_2026-05-01.json
```

新しい月次版を作る場合は、`--source-version` と `regional_manifest_<source-version>.json` の日付を更新する。

### 2. manifestを固定する

取得したmanifestに問題がなければ、月次スナップショットとして `configs/regional-master/<source-version>/regional_manifest.json` に固定する。公開ページやファイル名が変わっても、過去月の再現性を壊さないため、既存ディレクトリは上書きしない。

### 3. DB投入前にmanifestをdry-run検証する

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-regional-manifest \
  --manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --format markdown \
  --output data/work/regional-manifest-validation.md \
  --fail-on-error
```

検証では次を確認する。

- 全8地方厚生局に `hospital_registry` と `facility_standards` が少なくとも1件ずつ存在すること。
- `regional_bureau` が対応キーに含まれること。
- `kind` が `hospital_registry` または `facility_standards` であること。
- `source_version` があること。
- `path` のrawファイルが存在すること。

### 4. smoke importで中身を検証する

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli smoke-regional-manifest \
  --db data/work/regional-manifest-smoke.sqlite \
  --manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --format markdown \
  --fail-on-error > data/work/regional-manifest-smoke.md
```

`validate-regional-manifest` はファイル存在までを見て、`smoke-regional-manifest` はExcel/ZIPの読込・行数・0件取込を確認する。月次更新では両方を通す。

### 5. 標準DB build manifestへ接続する

地方厚生局manifestが通ったら、支払基金側の標準DB buildに同じmanifestを渡す。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli prepare-standard-master-build-manifest \
  --raw-root data/raw/ssk \
  --source-version 2026-05-01 \
  --regional-manifest configs/regional-master/2026-05-01/regional_manifest.json \
  --output data/work/standard-master-build.json \
  --fail-on-missing

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-standard-master-build-manifest \
  --manifest data/work/standard-master-build.json \
  --output data/work/standard-master-build-validation.md \
  --fail-on-error
```

## 完了条件

| 条件 | 判定 |
| --- | --- |
| raw取得が成功 | `regional-catalog-download.md` に失敗ページがない |
| manifestが固定済み | `configs/regional-master/<source-version>/regional_manifest.json` がある |
| manifest dry-runが成功 | `regional-manifest-validation.md` が `Ready: yes` |
| smoke importが成功 | `regional-manifest-smoke.md` が Non-OK 0 |
| 標準DB manifestに接続済み | `standard-master-build-validation.md` が `Ready: yes` |

## 残る課題

- 地方厚生局公式ページのHTML差分を、前月manifestとの差分として分類する専用diffは未実装。
- PDFしか候補がない場合のOCR/手動補正フローは未実装。
- 入院基本料・特定入院料の補助ファイルは施設基準の一部として取り込んでいるが、病棟単位の構造化には追加ロジックが必要。
