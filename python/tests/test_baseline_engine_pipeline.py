from medical_fee_calculation.baseline_diagnosis import (
    CATEGORY_CONSIDER,
    CATEGORY_MISSING,
    BaselineClaim,
    ClaimLine,
)
from medical_fee_calculation.baseline_engine import engine_claim_from_results, run_engine_claims
from medical_fee_calculation.baseline_pipeline import build_pairs, run_diagnosis


class _FakeStatus:
    def __init__(self, value):
        self.value = value


class _FakeLine:
    def __init__(self, code, name, points, quantity, status):
        self.code = code
        self.name = name
        self.points = points
        self.quantity = quantity
        self.status = _FakeStatus(status)


class _FakeResult:
    def __init__(self, lines):
        self.lines = lines


class _FakeBatchResult:
    def __init__(self, patient_id, service_date, result):
        self.patient_id = patient_id
        self.service_date = service_date
        self.result = result


def test_engine_claim_aggregates_and_marks_low_confidence():
    results = [
        _FakeResult([
            _FakeLine("112007410", "再診料", 73, 1, "confirmed"),
            _FakeLine("160061710", "判断料", 34, 1, "candidate"),
            _FakeLine("999", "却下", 10, 1, "blocked"),  # 除外
        ]),
        _FakeResult([
            _FakeLine("112007410", "再診料", 73, 1, "confirmed"),  # 別受診 -> 回数合算
        ]),
    ]
    engine = engine_claim_from_results(results, patient_id="patA", claim_month="2026-06")
    codes = {line.code: line for line in engine.lines}
    assert "999" not in codes  # blocked は含めない
    assert codes["112007410"].count == 2  # 2受診で合算
    assert "160061710" in engine.low_confidence_codes  # candidate は低確信
    assert "112007410" not in engine.low_confidence_codes  # confirmed は低確信でない


def test_run_engine_claims_groups_by_patient_month_with_injected_runner():
    payloads = [
        {"patient": {"patient_id": "patA"}, "encounter": {"service_date": "2026-06-03"}},
        {"patient": {"patient_id": "patA"}, "encounter": {"service_date": "2026-06-17"}},
        {"patient": {"patient_id": "patB"}, "encounter": {"service_date": "2026-06-05"}},
    ]
    fake_results = [
        _FakeBatchResult("patA", "2026-06-03", _FakeResult([_FakeLine("112007410", "再診料", 73, 1, "confirmed")])),
        _FakeBatchResult("patA", "2026-06-17", _FakeResult([_FakeLine("112007410", "再診料", 73, 1, "confirmed")])),
        _FakeBatchResult("patB", "2026-06-05", _FakeResult([_FakeLine("112007410", "再診料", 73, 1, "confirmed")])),
    ]

    def runner(conn, payloads):
        return fake_results

    claims = run_engine_claims(None, payloads, runner=runner)
    by_patient = {c.patient_id: c for c in claims}
    assert set(by_patient) == {"patA", "patB"}
    assert by_patient["patA"].lines[0].count == 2  # 同月2受診を合算


def test_pipeline_pairs_and_diagnoses():
    baselines = [
        BaselineClaim(patient_id="patA", claim_month="2026-06", lines=(
            ClaimLine(code="112007410", name="再診料", points=73, count=2),
        )),
    ]
    engines = [
        engine_claim_from_results([
            _FakeResult([
                _FakeLine("112007410", "再診料", 73, 2, "confirmed"),
                _FakeLine("113001810", "特定疾患療養管理料", 225, 1, "confirmed"),
            ]),
        ], patient_id="patA", claim_month="2026-06"),
    ]
    batch = run_diagnosis(baselines, engines)
    missing = {f.code for d in batch.diagnoses for f in d.findings_in(CATEGORY_MISSING)}
    assert "113001810" in missing


def test_build_pairs_handles_one_sided_claims():
    baselines = [BaselineClaim(patient_id="only_base", claim_month="2026-06", lines=())]
    engines = [engine_claim_from_results([], patient_id="only_engine", claim_month="2026-06")]
    pairs = build_pairs(baselines, engines)
    keys = {(b.patient_id, e.patient_id) for b, e in pairs}
    assert ("only_base", "only_base") in keys
    assert ("only_engine", "only_engine") in keys


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok: {name}")
    print("all baseline engine/pipeline tests passed")
