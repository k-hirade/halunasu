from medical_fee_calculation.baseline_diagnosis import (
    CATEGORY_CONSIDER,
    CATEGORY_MISSING,
    CATEGORY_REVIEW,
    BaselineClaim,
    ClaimLine,
    EngineClaim,
    diagnose_claim,
    estimate_yen,
)


def _diag():
    baseline = BaselineClaim(
        patient_id="pat_1",
        claim_month="2026-06",
        lines=(
            ClaimLine(code="112007410", name="再診料", points=73, count=1),
            ClaimLine(code="999999999", name="当社未対応の特殊算定", points=200, count=1),
            ClaimLine(code="160000000", name="末梢血液一般", points=60, count=2),
        ),
    )
    engine = EngineClaim(
        patient_id="pat_1",
        claim_month="2026-06",
        lines=(
            ClaimLine(code="112007410", name="再診料", points=73, count=1),
            ClaimLine(code="113001810", name="特定疾患療養管理料", points=225, count=1),
            ClaimLine(code="160000000", name="末梢血液一般", points=60, count=1),
            ClaimLine(code="220000000", name="低確信の候補", points=50, count=1),
        ),
        low_confidence_codes=frozenset({"220000000"}),
    )
    return diagnose_claim(
        baseline,
        engine,
        known_unsupported_codes=frozenset({"999999999"}),
    )


def test_missing_candidate_for_engine_only_code():
    diag = _diag()
    missing = {f.code for f in diag.findings_in(CATEGORY_MISSING)}
    # 特定疾患療養管理料(engine only) と 末梢血液一般の回数差(engine 1 vs baseline 2 -> baseline多い=要確認側)
    assert "113001810" in missing


def test_over_unsupported_goes_to_consider_not_review():
    diag = _diag()
    consider = {f.code for f in diag.findings_in(CATEGORY_CONSIDER)}
    # 当社未対応コードは「過剰」と短絡せず検討へ
    assert "999999999" in consider
    review = {f.code for f in diag.findings_in(CATEGORY_REVIEW)}
    assert "999999999" not in review


def test_low_confidence_engine_only_goes_to_consider():
    diag = _diag()
    consider = {f.code for f in diag.findings_in(CATEGORY_CONSIDER)}
    assert "220000000" in consider
    missing = {f.code for f in diag.findings_in(CATEGORY_MISSING)}
    assert "220000000" not in missing


def test_quantity_diff_baseline_more_is_review():
    diag = _diag()
    # 末梢血液一般: baseline 2回(120点) vs engine 1回(60点) -> 既存が多い=要確認
    review = {f.code for f in diag.findings_in(CATEGORY_REVIEW)}
    assert "160000000" in review


def test_matching_line_produces_no_finding():
    diag = _diag()
    # 再診料は両者一致 -> 所見なし
    assert all(f.code != "112007410" for f in diag.findings)


def test_code_map_normalizes_before_compare():
    baseline = BaselineClaim(patient_id="p", claim_month="2026-06", lines=(ClaimLine(code="OLD_A", name="再診料", points=73, count=1),))
    engine = EngineClaim(patient_id="p", claim_month="2026-06", lines=(ClaimLine(code="112007410", name="再診料", points=73, count=1),))
    diag = diagnose_claim(baseline, engine, code_map={"OLD_A": "112007410"})
    # 正規化で同一コードに揃うため差分なし
    assert diag.findings == ()


def test_summary_and_yen():
    diag = _diag()
    summary = diag.summary()
    assert summary["missing_candidate_count"] >= 1
    assert summary["missing_candidate_estimated_yen"] == estimate_yen(summary["missing_candidate_points"])
    assert estimate_yen(225) == 2250


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok: {name}")
    print("all baseline_diagnosis tests passed")
