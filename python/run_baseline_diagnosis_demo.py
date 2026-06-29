"""導入前 一括レセプト差分診断の エンドツーエンド・デモ。

実マスタDBで当社エンジンを回し(engineClaim)、サンプルの既存レセCSV(baselineClaim)と
突合して3分類レポート(HTML/CSV)を出力する。Phase A の動作確認用。

実行:
    PYTHONPATH=. python3 run_baseline_diagnosis_demo.py
出力:
    data/tests/baseline-diff/out/report.html, report.csv
"""

from __future__ import annotations

from pathlib import Path

from medical_fee_calculation.baseline_adapter import parse_receipt_csv
from medical_fee_calculation.baseline_engine import run_engine_claims
from medical_fee_calculation.baseline_pipeline import run_diagnosis
from medical_fee_calculation.baseline_report import to_csv, to_html
from medical_fee_calculation.db import connect

MASTER_DB = "data/master/standard-master.sqlite"
CLAIM_MONTH = "2026-06"
MEDICAL_INSTITUTION_CODE = "04,1000,1"

# 当社エンジンへ渡す受診payload(患者×月。patAは同月2受診)。
ENGINE_PAYLOADS = [
    {
        "patient": {"patient_id": "patA"},
        "encounter": {"service_date": "2026-06-03", "regional_bureau": "tohoku", "medical_institution_code": MEDICAL_INSTITUTION_CODE, "is_outpatient": True},
        "procedure_codes": ["160000410", "160000310"],
        "lab_options": {"collection_fee_inputs": ["blood_venous"]},
    },
    {
        "patient": {"patient_id": "patA"},
        "encounter": {"service_date": "2026-06-17", "regional_bureau": "tohoku", "medical_institution_code": MEDICAL_INSTITUTION_CODE, "is_outpatient": True},
        "procedure_codes": ["160000410"],
        "lab_options": {"collection_fee_inputs": ["blood_venous"]},
    },
    {
        "patient": {"patient_id": "patB"},
        "encounter": {"service_date": "2026-06-05", "regional_bureau": "tohoku", "medical_institution_code": MEDICAL_INSTITUTION_CODE, "is_outpatient": True},
        "procedure_codes": ["160000310"],
        "lab_options": {},
    },
]

# サンプルの既存レセCSV(レセコン出力想定)。
# - patA: 判断料(160061710)を意図的に欠落 -> 算定もれ候補として検出されることを狙う
# - patB: 当社未対応の架空コード(900000000) を含む -> known_unsupported_codes により「検討」へ
SAMPLE_BASELINE_CSV = """pid,month,mic,code,name,ten,kaisu
patA,2026-06,041000-1,160000410,尿蛋白,7,2
patA,2026-06,041000-1,160000310,尿一般,26,1
patB,2026-06,041000-1,160000310,尿一般,26,1
patB,2026-06,041000-1,900000000,架空の特殊算定,150,1
"""

CSV_COLUMN_MAP = {
    "patient_id": "pid",
    "claim_month": "month",
    "medical_institution_code": "mic",
    "code": "code",
    "name": "name",
    "points": "ten",
    "count": "kaisu",
}

KNOWN_UNSUPPORTED_CODES = frozenset({"900000000"})


def main() -> None:
    conn = connect(MASTER_DB)
    engine_claims = run_engine_claims(conn, ENGINE_PAYLOADS)
    baseline_claims = parse_receipt_csv(
        SAMPLE_BASELINE_CSV,
        column_map=CSV_COLUMN_MAP,
        only_claim_month=CLAIM_MONTH,
    )
    batch = run_diagnosis(baseline_claims, engine_claims, known_unsupported_codes=KNOWN_UNSUPPORTED_CODES)

    out_dir = Path("data/tests/baseline-diff/out")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.html").write_text(to_html(batch), encoding="utf-8")
    (out_dir / "report.csv").write_text(to_csv(batch), encoding="utf-8")

    summary = batch.summary()
    print("=== 差分診断サマリ ===")
    for key, value in summary.items():
        print(f"{key}: {value}")
    print()
    print("=== 所見 ===")
    for diagnosis, finding in batch.all_findings():
        print(f"[{finding.category_label}] {diagnosis.patient_id} {finding.code} {finding.name} "
              f"{finding.points:g}点 (約{finding.estimated_yen:,}円) - {finding.reason}")
    print()
    print(f"レポート出力: {out_dir/'report.html'} / {out_dir/'report.csv'}")


if __name__ == "__main__":
    main()
