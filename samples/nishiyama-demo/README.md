# 導入前 売上改善診断ツールキット（デモ）

閉域網・断片データの病院向けに、**匿名化 → 断片データ取込 → 決定論点検 → 売上改善レポート**を
オフライン（外部送信なし・外部AI不使用）で回すツールキット。西山病院PoC用の匿名サンプル入り。

## ワンコマンドで通す（デモ／E2Eスモーク）

```bash
node scripts/run_clinic_demo.mjs --out /tmp/clinic-demo --keep
# /tmp/clinic-demo/report.html を開くと売上改善診断レポートが見られる
```

匿名サンプルに対し、判断料もれ・処方料もれ・適応なし・禁忌・併用禁忌 が検出されることを検証する。

## 個別ステップ（実データ運用の流れ）

```bash
# 1) 匿名化(院内・オフライン): 生CSV → 匿名化済みCSV（氏名等除去・患者ID擬似化・生年月日→年齢）
PYTHONPATH=python python3 -m medical_fee_calculation.deidentify \
    --config samples/nishiyama-demo/deid-config.json \
    --input  samples/nishiyama-demo/raw \
    --output /tmp/deid --salt-file /path/to/hospital-salt.txt

# 2) 断片データ取込: 匿名化済みCSV(患者/病名/処方/検体/処置/リハビリ) → 患者×月の正規化claim(JSONL)
PYTHONPATH=python python3 -m medical_fee_calculation.clinic_intake \
    --map samples/nishiyama-demo/intake-map.json --input /tmp/deid --output /tmp/claims.jsonl

# 3) 診断レポート: claim → 決定論点検 → HTML/CSV
#    (適応/禁忌/併用/判断料は point-check マスタDBを参照。実データ取込は docs の Runbook 参照)
node scripts/build_clinic_diagnosis_report.mjs \
    --claims /tmp/claims.jsonl --db master_data/master.sqlite \
    --out-html /tmp/report.html --out-csv /tmp/report.csv \
    --title "売上改善診断レポート" --subtitle "○○病院（匿名）"
```

## 設定ファイル（形式差はここで吸収＝コード改修不要）

- `deid-config.json`: ファイルごとの列ロール（`patient_key`/`drop`/`birthdate`/`service_date`/`keep`/`keep_scrub`）＋ encoding
- `intake-map.json`: 匿名化済みCSVの列 → 正規化claimの論理項目 のマッピング

当日サンプルが来たら、この2ファイルの値を先方の実列名に合わせて書き換えるだけで動く。

## 関連ドキュメント
- 計画: `docs/20260710-nishiyama-hospital/20260704-p1-p4-implementation-plan.md`
- 点検マスタ取込（実データ）: `docs/20260703-fable-fee-comparison/04-check-master-runbook.md`

## 安全設計（脱識別ツールとして）
- **fail-closed**: deid-config に無い列（未マッピング列）は既定で**エラー停止**（`unmapped_policy: "error"`）。住所/電話/保険記号番号 等の想定外列が匿名化済み出力へ漏れない。全列を明示分類するか、`unmapped_policy: "drop"`（未定義は削除）を設定する。
- **dry-run は非破壊**: `--dry-run` は列マッピングと件数のみ確認し、**出力ファイル・出力ディレクトリ・SALTファイルを一切作らない**。
- **デモDBガード**: `seed_clinic_demo_master.py` はパスに `demo` を含むDBのみシード（実マスタ破壊防止）。意図的な場合のみ `--force-demo-db`。

## 注意
- **本番のsaltを使わないこと**（このデモsaltは公開値）。実運用のsaltは先方がローカル生成・保持し、我々には渡さない。
- レポートの概算影響額は点数×10円・按分なしの概算。最終判断は告示・通知・審査取扱いに基づき医事課/診療部門で。
