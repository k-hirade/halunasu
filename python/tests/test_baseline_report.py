from medical_fee_calculation.baseline_diagnosis import BaselineClaim, ClaimLine, EngineClaim
from medical_fee_calculation.baseline_report import (
    BatchDiagnosis,
    diagnose_batch,
    report_rows,
    to_csv,
    to_html,
    to_markdown,
    to_tsv,
)


def _batch() -> BatchDiagnosis:
    pairs = [
        (
            BaselineClaim(patient_id="patA", claim_month="2026-06", lines=(
                ClaimLine(code="112007410", name="再診料", points=73, count=2),
            )),
            EngineClaim(patient_id="patA", claim_month="2026-06", lines=(
                ClaimLine(code="112007410", name="再診料", points=73, count=2),
                ClaimLine(code="113001810", name="特定疾患療養管理料", points=225, count=1),
            )),
        ),
        (
            BaselineClaim(patient_id="patB", claim_month="2026-06", lines=(
                ClaimLine(code="999999999", name="未対応算定", points=100, count=1),
            )),
            EngineClaim(patient_id="patB", claim_month="2026-06", lines=()),
        ),
    ]
    return diagnose_batch(pairs, known_unsupported_codes=frozenset({"999999999"}))


def test_batch_summary_aggregates_across_patients():
    summary = _batch().summary()
    assert summary["patient_month_count"] == 2
    assert summary["missing_candidate_count"] == 1  # 特定疾患療養管理料
    assert summary["missing_candidate_points"] == 225
    assert summary["missing_candidate_estimated_yen"] == 2250
    assert summary["consider_count"] == 1  # 未対応コード


def test_rows_sorted_by_category_then_points():
    rows = report_rows(_batch())
    # 先頭は算定もれ候補
    assert rows[0]["category"] == "算定もれ候補"


def test_csv_tsv_markdown_html_render():
    batch = _batch()
    csv_text = to_csv(batch)
    assert "請求月" in csv_text and "特定疾患療養管理料" in csv_text
    tsv_text = to_tsv(batch)
    assert "\t" in tsv_text
    md = to_markdown(batch)
    assert "レセプト差分診断レポート" in md and "約2,250円" in md
    html = to_html(batch)
    assert "<table" in html and "特定疾患療養管理料" in html
    # 「増収」表現を使わない
    assert "増収" not in html and "増収" not in md


def test_html_escapes_content():
    pairs = [(
        BaselineClaim(patient_id="p", claim_month="2026-06", lines=()),
        EngineClaim(patient_id="p", claim_month="2026-06", lines=(
            ClaimLine(code="X", name="<script>", points=10, count=1),
        )),
    )]
    html = to_html(diagnose_batch(pairs))
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok: {name}")
    print("all baseline_report tests passed")
