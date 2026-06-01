# Fee Complete Migration Plan

作成日: 2026-06-01 JST

## 結論

診療報酬アプリの完全移行は、旧 `medical-fee-calculation` の Python engine を現行 monorepo に置くだけでは完了としない。完全移行の完了条件は次の3層で判定する。

1. Runtime: `fee-web` / `fee-api` から旧 engine の算定入力へ到達できる。
2. Operation: 旧 CLI のマスター更新、CSV変換、バッチ、gold評価を現行 repo の正式運用手順として実行できる。
3. Safety: 旧 engine が確定請求ではなく算定候補/レビュー支援であることを UI/API/tests が崩さない。

2026-06-01 の実装対象は Runtime の不足を埋める。Operation は旧 CLI をそのまま残し、Web化は別判断にする。旧アプリ自体も Python/CLI 資産であり、CSV/マスター更新/バッチを常時ユーザーUIとして提供していたわけではないため、完全移行のために必要なのは「現行 repo で再現可能な正式経路」を持つことである。

## 旧機能と現行到達経路

| 旧機能 | 現行到達経路 | 完了条件 |
| --- | --- | --- |
| 外来検査、D026、判断料、採取料 | `fee-web` -> `fee-api` -> Python worker | UIから算定できる |
| 投薬、注射、処置、画像、入院基本料、DPCレビュー | `claimContext` / `calculationOptions` を保存して Python bridge に渡す | session保存後の再計算で同じ入力を再利用できる |
| 特定器材 | `material` order type または `claimContext.material_inputs` | contract/UI/APIが `material` を拒否しない |
| Order CSV変換、契約生成、profile | `python -m medical_fee_calculation.cli ...` | docs/runbookと旧legacy testsで保護する |
| claim batch / gold評価 | `python -m medical_fee_calculation.cli ...` | docs/runbookと旧legacy testsで保護する |
| 公式/地方マスター更新 | `python -m medical_fee_calculation.cli ...` | master update runbookとauditで保護する |
| 本番runtime master | `fee-api /readyz` | master DB/gzipが設定済みであることを確認する |

## 実装手順

### Phase 1: Runtime入力の完全化

- `feeOrderTypes` に `material` を追加する。
- `feeSession` に `claimContext` と `calculationOptions` を保存する。
- `PATCH /v1/fee/sessions/{id}` で詳細入力を更新できるようにする。
- `/calculate` は request body が空でも、session に保存済みの `claimContext` / `calculationOptions` を Python worker へ渡す。
- Python bridge は direct payload でも `session.claimContext` / `session.calculationOptions` を認識する。

### Phase 2: UI到達経路

- `fee-web` に詳細算定入力を追加する。
- `claimContext` は旧 claim payload をそのままJSONで保存できる。
- `calculationOptions` は履歴、コメント、施設基準、投薬/注射/処置/画像/入院/DPCオプションをJSONで保存できる。
- 算定実行前の保存でJSON validationを行い、無効なJSONはAPIへ送らない。

### Phase 3: Operationの正式化

旧 CLI は以下を正式経路として維持する。Web UI化は対象外にする場合でも、完全移行としては docs と tests で到達性を保証する。

```bash
PYTHONPATH=python python3 -m medical_fee_calculation.cli --help
PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation -p '*.py'
```

代表領域:

- `discover-ssk-master-catalog`
- `download-ssk-master-catalog`
- `prepare-standard-master-build-manifest`
- `build-standard-master-db`
- `discover-regional-source-catalog`
- `download-regional-source-catalog`
- `convert-order-csv-to-claim-jsonl`
- `run-order-csv-claim-pipeline`
- `run-order-csv-claim-pipeline-batch`
- `run-outpatient-lab-claim-batch`

### Phase 4: Verification

最低限の確認:

```bash
npm run test --workspace @halunasu/fee-contracts
npm run test --workspace @halunasu/fee-core
npm run test --workspace @halunasu/fee-api
npm run test --workspace @halunasu/fee-web
PYTHONPATH=python python3 -m unittest discover -s python/tests -p '*.py'
PYTHONPATH=python python3 -m unittest discover -s python/tests/legacy_medical_fee_calculation -p '*.py'
```

## 今回の完了条件

- 簡易orderだけでなく、旧 claim payload 相当を `claimContext` として保存できる。
- 詳細optionを `calculationOptions` として保存できる。
- 保存済み詳細入力が空の `/calculate` request でも使われる。
- `material` orderがcontract/UI/API/Python bridgeを通る。
- 旧 CSV/バッチ/マスター機能は現行 CLI と legacy tests で継続保護される。

## 非対象

- DPC本実装の完成。
- 医科診療報酬全章の章別ロジック新規実装。
- CSV/マスター/バッチのWeb UI化。
- 公式サイトへのネットワーク取得を伴う最新マスター再ビルド。

これらは旧アプリからの移行ではなく、診療報酬 engine 自体のカバレッジ拡張として別計画にする。
