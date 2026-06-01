# Fee Calculation Migration Parity

## Verdict

完了。Pythonの算定エンジンは旧126テストが現行コードに対して通り、`fee-api` は `/v1/fee/sessions/{id}/calculate` から `python/medical_fee_calculation` を呼ぶ。公式マスターSQLiteはgzipとしてCloud Run imageへ同梱し、runtimeで `/tmp/halunasu-fee-master/standard-master.sqlite` に展開する。STG/PRODとも `/readyz` で `masterDbConfigured=true`、`masterDbPathExists=true`、`masterDbGzipPathExists=true` を確認済み。

2026-05-30のpost-deploy検証では、STG/PRODでCore患者/施設/診療科を選択してfee sessionを作成し、`standardCode=160000410` を `medical_fee_calculation` providerで実算定した。結果はSTG/PRODとも `totalPoints=41`、`lineItems=2`。

2026-06-01追記: 「完全移行」の判定は [Fee Complete Migration Plan](./2026-06-01-fee-complete-migration-plan.md) を正とする。`claimContext` / `calculationOptions` / `material` order type を `feeSession` に保存し、旧 claim payload 相当の詳細入力を `fee-web` / `fee-api` から Python engine へ渡せるようにした。Order CSV、claim batch、gold評価、マスター更新は現行 Python CLI と legacy tests を正式な到達経路として維持する。

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
| `fee-api` | calculate endpoint / master readiness / 公式master gzip展開をSTG/PRODへ反映済み | master更新時はgzip再生成後にFee APIを再deploy |
| `fee-web` | calculate UIへ変更済み。`claimContext` / `calculationOptions` / `material` 入力を保持できる | CSV/マスター/バッチのWeb UI化は別判断 |
| master data | 運用開始 | Git管理せず、`python/data/master/standard-master.sqlite.gz` をFee API build contextだけへ含める |
| STG/PROD | 実算定まで確認済み | 代表ケースを増やす場合はpost-deploy scriptへ追加 |

## TO-BE

- Core Platform: org, facility, department, patient, entitlement, audit
- Fee product: fee session, order intake, calculation result, review decision, receipt draft, master source metadata
- Master files: まずrepo/configで再現性を担保し、運用時は低費用のGCS/Firestore metadataに切替可能にする

## 完了条件

- `mock算定` 表示を削除または内部用に限定する。Done.
- `/v1/fee/sessions/{id}/calculate` がPython engineを呼ぶ。Done.
- 旧126テストがrepo内で通る。
- Fee API/Python bridgeテストで代表オーダーが実コード/点数を返す。
- STG/PROD `/readyz` で `feeCalculator.masterDbConfigured=true`、`masterDbPathExists=true` を返す。Done.
- STG/PRODでログイン、患者選択、施設/診療科選択、算定、保存まで確認する。Done.
