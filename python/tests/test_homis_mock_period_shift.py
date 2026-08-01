from __future__ import annotations

import importlib.util
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "clients"
    / "homis-sidecar"
    / "mock"
    / "prepare_homis_mock_v2.py"
)
V5_MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "clients"
    / "homis-sidecar"
    / "mock"
    / "prepare_homis_mock_v5.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("prepare_homis_mock_v2_test", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_v5_module():
    spec = importlib.util.spec_from_file_location("prepare_homis_mock_v5_test", V5_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_shifts_only_mock_target_period_to_july_2026() -> None:
    module = load_module()
    source = "\n".join(
        [
            "TARGET_YEAR = 2026",
            "TARGET_MONTH = 6",
            "PREV_YEAR = 2026",
            "PREV_MONTH = 5",
            'visit = "2026-06-25"',
            'previous = "2026-05-20"',
            'instruction_end = "2026-11-19"',
            'history = "2024-03-10"',
            "label = '対象月＝2026年6月、前月＝2026年5月'",
        ]
    )

    shifted = module.prepare_patients(source, "2026-07")

    assert "TARGET_YEAR = 2026" in shifted
    assert "TARGET_MONTH = 7" in shifted
    assert "PREV_YEAR = 2026" in shifted
    assert "PREV_MONTH = 6" in shifted
    assert '"2026-07-25"' in shifted
    assert '"2026-06-20"' in shifted
    assert '"2026-12-19"' in shifted
    assert '"2024-03-10"' in shifted
    assert "対象月＝2026年7月、前月＝2026年6月" in shifted


def test_period_shift_is_idempotent_for_the_selected_target() -> None:
    module = load_module()
    source = "\n".join(
        [
            "TARGET_YEAR = 2026",
            "TARGET_MONTH = 7",
            "PREV_YEAR = 2026",
            "PREV_MONTH = 6",
            'visit = "2026-07-25"',
            'previous = "2026-06-20"',
        ]
    )

    assert module.prepare_patients(source, "2026-07") == source


def test_v5_shifts_patient_timeline_without_injecting_dom_metadata(tmp_path: Path) -> None:
    module = load_v5_module()
    fixture = V5_MODULE_PATH.parent / "fixture"
    output = tmp_path / "mock_homis"

    module.verify_fixture(fixture)
    module.build_mock(fixture, output, "2026-07")

    patients = (output / "data" / "patients.py").read_text(encoding="utf-8")
    render = (output / "render.py").read_text(encoding="utf-8")
    javascript = (output / "static" / "homis.js").read_text(encoding="utf-8")
    assert '"start_date": "2026-05-22"' in patients
    assert 'ikou_souki_comment("2026-05-22")' in patients
    assert 'wareki(\'2026-05-22\')' in patients
    assert '"since": "2026-05-10"' in patients
    assert '"2026-07-25"' in patients
    assert '"2026-06-20"' in patients
    assert "data-record-id" not in render + javascript
    assert "data-single-building-patient-count" not in render + javascript


def test_v5_fixture_checksum_detects_mutation(tmp_path: Path) -> None:
    module = load_v5_module()
    source = V5_MODULE_PATH.parent / "fixture"
    fixture = tmp_path / "fixture"
    import shutil

    shutil.copytree(source, fixture)
    (fixture / "README.md").write_text("changed", encoding="utf-8")

    try:
        module.verify_fixture(fixture)
    except SystemExit as error:
        assert "checksum mismatch" in str(error)
    else:
        raise AssertionError("mutated fixture unexpectedly passed checksum verification")
