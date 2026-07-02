# 導入前 一括レセプト差分診断 実行Runbook（Phase A / 西山PoC）

作成日: 2026-06-29
関連方針: `docs/fee-baseline-diff-diagnosis-2026-06-29.md`

既存レセ（baselineClaim）と当社再算定（engineClaim）を患者×暦月で突合し、
**算定もれ候補／要確認／検討** の3分類レポートを返すバッチ診断の手順。
当面は STG/手元で運用者が実行し、病院へレポートを返却する。

> 重要: 名前がSTGでも、実患者データを扱う限り**本番相当**として扱う（後述のPHI手順を必須）。

---

## 0. 対象範囲（Phase A）
- **外来×出来高に限定**。入院/DPCは「検討」へ縮退。
- 再算定は**構造化オーダー経路（決定論・外部LLM不使用）**を既定。自由文カルテのLLM抽出は使わない。
- 差分はすべて「要確認」。**「増収」表現は使わない**（確認対象点数／概算影響額）。

## 1. 受領するデータ（病院から）
1. 既存レセ: **レセ電(UKE)** または **レセコンCSV**（どちらでも可）
2. カルテ/オーダー/病名（再算定の入力。構造化オーダーが望ましい）
3. 施設基準スナップショット（届出済みキー・受理日・算定開始日・有効期限）
4. マスター世代（診療月に対応するもの）
5. 診療月（YYYY-MM）、医療機関コード、診療科、保険情報

受領形式・列名はベンダーで異なるため、**病院別マッピング（CSV column_map / UKE UkeLayout）を最初に確定**する。

### STG Web UI の取込形式
STG の「再算定差分診断」は、次のどちらかで取り込める。

1. **診断データセットZIP**
   - `manifest.json`
   - `receipt.csv` または `receipt.uke`
   - `patients.csv` / `patients.jsonl`
   - `charts.csv` / `charts.jsonl`
   - `orders.csv` / `orders.jsonl`
   - `diagnoses.csv` / `diagnoses.jsonl`
   - `facility.json`
2. **CSV/JSONの複数ファイル一括アップロード**
   - ZIPにまとめず、`receipt.csv`、`patients.csv`、`charts.jsonl`、`orders.csv`、`diagnoses.csv`、`facility.json` などを同時選択して取り込める。
   - ファイル名から役割を判定するため、標準名に寄せる。判定できないJSONはbundle JSON、判定できないテキストは再算定payloadとして扱う。
3. **個別アップロード**
   - 既存レセ、患者情報、カルテ、オーダー、病名、施設設定を画面上で個別に指定する。

最小必須は、既存レセと、患者ID・診療日・算定対象コードを含む再算定元データ。カルテ本文だけでは薬剤量・処置面積・施設基準・同月履歴などが不足しやすいため、初期運用では**構造化オーダーを主入力、カルテは根拠・補助情報**として扱う。

請求月は、`manifest.json` の `claimMonth` / `claim_month` を最優先し、次に既存レセ・オーダー・カルテ等の `claim_month` または `service_date` から推定する。画面上の「請求月」は、データ内に請求月を持たない場合だけ使うフォールバック。

標準CSV列例:
```csv
# patients.csv
patient_id,birth_date,sex,display_name
pat_001,1970-01-01,male,山田 太郎

# charts.csv
patient_id,service_date,clinical_text
pat_001,2026-06-10,A：高血圧症。P：管理を継続。

# orders.csv
patient_id,service_date,order_type,code,name,status
pat_001,2026-06-10,procedure,113001810,特定疾患療養管理料,performed

# diagnoses.csv
patient_id,service_date,diagnosis_name,is_primary
pat_001,2026-06-10,高血圧症,true
```

## 2. PHI / セキュリティ（必須）
- 受領〜削除まで**アクセス権限を限定**（担当者のみ）、保存先は**IP制限された隔離環境**。
- **ログ・標準出力にカルテ本文や患者氏名を出さない**（レポートも患者符牒運用を推奨）。
- **PHIをGit / docs / チケットに残さない**。サンプルは必ず匿名化合成データを使う。
- 構造化オーダー経路を使い、**外部LLMにカルテ本文を送らない**（SOAP-LLM経路は匿名化＋同意/BAA前提のオプション）。
- 保存期間を定め、**PoC終了後に削除**（削除手順と証跡を残す）。

## 3. 環境準備
```bash
cd python
# マスタDB(診療月に対応する世代)を配置: data/master/standard-master.sqlite
ls data/master/standard-master.sqlite
```
マスタが無い場合は標準マスタビルド（`standard_build` / official-master）で生成してから配置。

## 4. マッピングの確定
### 4-1. レセコンCSVの場合
`column_map` を実列名に合わせる（論理列→実列）:
`patient_id / claim_month / code / name / points / count / medical_institution_code`

### 4-2. レセ電(UKE)の場合
`UkeLayout` のフィールド位置を、先方のレセ電バージョンの実データで検証して上書き（既定は当社出力レイアウト）。
- `line_records`（既定 SI/IY/TO）, `line_code_index`, `line_points_index`, `line_count_index`
- `re_record` / `re_name_index`（患者境界・氏名）, `ho_points_index`（請求点数）, `ho_days_index`（診療実日数）

## 5. 取込 → 再算定 → 診断 → レポート
最小コードで一連を実行できる（demo を雛形に病院データへ差し替える）。

```python
from medical_fee_calculation.db import connect
from medical_fee_calculation.baseline_adapter import parse_receipt_csv, parse_uke
from medical_fee_calculation.baseline_engine import run_engine_claims
from medical_fee_calculation.baseline_pipeline import run_diagnosis
from medical_fee_calculation.baseline_report import to_html, to_csv

conn = connect("data/master/standard-master.sqlite")

# (a) 既存レセ -> baselineClaim
baselines = parse_receipt_csv(csv_text, column_map=COLUMN_MAP, only_claim_month="2026-06",
                              only_medical_institution_code=MIC)
# UKEの場合:
# baselines = parse_uke(uke_text, claim_month="2026-06", layout=UkeLayout(...))

# (b) カルテ/オーダー -> 受診payload -> engineClaim（決定論）
engines = run_engine_claims(conn, ENGINE_PAYLOADS)

# (c) 突合 -> 3分類。当社未対応コードは known_unsupported_codes で「検討」へ。
#     コード体系が違う場合は code_map={旧:正規} で正規化してから突合。
batch = run_diagnosis(baselines, engines,
                      known_unsupported_codes=KNOWN_UNSUPPORTED_CODES,
                      code_map=CODE_MAP)

# (d) レポート出力（HTML=印刷/PDF用, CSV=点検用）
open("out/report.html","w",encoding="utf-8").write(to_html(batch))
open("out/report.csv","w",encoding="utf-8").write(to_csv(batch))
```

動作確認用のエンドツーエンド・デモ（合成サンプル）:
```bash
cd python && PYTHONPATH=. python3 run_baseline_diagnosis_demo.py
# -> data/tests/baseline-diff/out/report.html, report.csv
```

## 6. レポートの読み方（病院へ説明）
- **算定もれ候補**: 当社再算定で出たが既存レセに無い（要件充足後に算定可能）。confirmedな差分のみ断定的に出し、低確信は「検討」へ。
- **要確認**: 既存にあるが当社で再現せず／回数・点数差（当社未対応の可能性 or 既存の過剰）。両方向に確認。
- **検討**: 当社未対応領域・低確信・データ/列不足・DPC/入院など判定保留。
- **概算影響額**: 点数×10円・総医療費ベースの概算（負担割合・保険者按分は含まない）。
- すべて「**実施事実・算定要件・施設基準・病名を確認のうえ判断**」が前提。

## 7. 改善ループ
1. 頻出差分を分類別に集計（特に「検討」の偽差分＝コード正規化不足、未対応領域）。
2. `code_map`（対応表）・`UkeLayout`/`column_map`・`known_unsupported_codes` を更新。
3. 算定ロジックの取りこぼし（under偽陰性）・過剰（over偽陽性）を是正。
4. 安定した修正のみ PROD コードへ反映。

## 8. テスト（回帰確認）
```bash
cd python
for t in diagnosis report adapter engine_pipeline; do PYTHONPATH=. python3 tests/test_baseline_$t.py; done
```

## 9. PROD化判断（Phase D の入口）
2〜3施設でadapter安定／文言が医療事務に通じる／PHI運用・削除手順確立／「増収」表現排除／得意・縮退範囲明記が揃ったら、fee-web月次点検への「既存レセとの差分」モード（Phase B）→ PROD化（Phase D）へ。

---

## 実装済みモジュール（Phase A）
- `medical_fee_calculation/baseline_diagnosis.py` — モデル＋比較器（3分類・over二義性・低確信・code_map）
- `medical_fee_calculation/baseline_adapter.py` — UKE / レセコンCSV 取込＋スコープ前処理
- `medical_fee_calculation/baseline_engine.py` — 当社算定結果→engineClaim 写像（患者×月集約・低確信判定）
- `medical_fee_calculation/baseline_pipeline.py` — 患者×月の突合オーケストレーション
- `medical_fee_calculation/baseline_report.py` — 集計＋CSV/TSV/Markdown/HTML（安全文言内蔵）
- `run_baseline_diagnosis_demo.py` — 実マスタでのエンドツーエンド・デモ
