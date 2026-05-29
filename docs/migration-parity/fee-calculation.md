# Fee Calculation Migration Parity

## Verdict

部分完了。Pythonの算定エンジンは旧126テストが現行コードに対して通り、`fee-api` は `/v1/fee/sessions/{id}/calculate` から `python/medical_fee_calculation` を呼べる構造へ変更済み。Netlify静的配信はSTG/PRODへ反映済み。ただしSTG/PRODで使う公式マスターSQLiteの配置、Cloud Run環境変数、代表データでの実環境検証は未完了。

## 旧実装

旧 `medical-fee-calculation` はWebアプリではなく、診療報酬算定エンジンとマスタ/契約/テスト資産だった。

主要領域:

- `src/medical_fee_calculation`
- `configs/official-master`
- `configs/regional-master`
- `contracts/order-csv`
- `docs/core`
- `docs/implementation`
- `tests`

旧テスト:

- `test_importer_and_d026.py`
- `test_regional_discovery.py`
- `test_regional_download.py`
- `test_ssk_download.py`

旧テスト範囲:

- SSK公式マスタ取得/差分
- 地方厚生局ページ探索/ダウンロード
- D026等の検査判断料
- 初診/再診
- 投薬、注射、処置、画像、入院、DPC
- オーダーCSV契約
- 病院台帳、施設基準、病院プロファイル
- regional manifest validation/smoke

## 現行実装

現行 `python/medical_fee_calculation` は旧モジュールの多くを持ち、追加で以下もある。

- `dpc_electronic_table.py`
- `dpc_hospital_coefficients.py`
- `official_sources.py`

現行 `apps/fee-web` と `services/fee-api` は、以下を実装済み。

- UI: `算定実行`
- API: `/v1/fee/sessions/{id}/calculate`
- API bridge: `services/fee-api/src/python-calculator.js`
- Python entrypoint: `python/medical_fee_calculation/api.py`
- Docker: `services/node-service.Dockerfile` で `python3` と `python/` をCloud Run imageへ同梱

## 移植済み

以下を現行repoに取り込んだ。

- `python/tests/legacy_medical_fee_calculation`
- `config/migration-parity/fee-calculation-configs`
- `config/migration-parity/fee-calculation-contracts`
- `docs/migration-parity/fee-calculation-legacy-docs`
- `python/medical_fee_calculation/api.py`
- `python/tests/test_fee_api_bridge.py`

確認:

```bash
PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation
```

2026-05-30時点で126テストOK。

追加確認:

```bash
npm run test --workspace @halunasu/fee-contracts
npm run test --workspace @halunasu/fee-core
npm run test --workspace @halunasu/fee-api
npm run test --workspace @halunasu/fee-web
PYTHONPATH=python python3 -m unittest python/tests/test_fee_api_bridge.py
```

上記はいずれも2026-05-30時点でOK。

## 差分

| 領域 | 状態 | 修正方針 |
| --- | --- | --- |
| Python engine | ほぼ移植済み | 旧テストを継続実行対象にする |
| configs/contracts/docs | 移植開始 | 正式な配置場所を `config/fee-calculation` / `docs/fee-calculation` に整理 |
| `fee-api` | calculate endpoint実装済み | STG/PRODへ `FEE_MASTER_DB_PATH` を設定 |
| `fee-web` | calculate UIへ変更済み | 旧契約に沿ったオーダーCSV/診療情報入力は追加実装が必要 |
| master data | 未運用 | Fee product projectの低費用GCSまたはCloud Run image artifactで公式SQLiteを配置 |
| STG/PROD | 静的配信は反映済み | 公式master付き実算定APIに切替後、代表ケースで検証 |

## TO-BE

- Core Platform: org, facility, department, patient, entitlement, audit
- Fee product: fee session, order intake, calculation result, review decision, receipt draft, master source metadata
- Master files: まずrepo/configで再現性を担保し、運用時は低費用のGCS/Firestore metadataに切替可能にする

## 完了条件

- `mock算定` 表示を削除または内部用に限定する。Done.
- `/v1/fee/sessions/{id}/calculate` がPython engineを呼ぶ。Done.
- 旧126テストがrepo内で通る。
- Fee API/Python bridgeテストで代表オーダーが実コード/点数を返す。
- STG/PRODでログイン、患者選択、算定、レビュー、保存まで確認する。
