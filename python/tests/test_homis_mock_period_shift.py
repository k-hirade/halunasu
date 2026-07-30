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


def load_module():
    spec = importlib.util.spec_from_file_location("prepare_homis_mock_v2_test", MODULE_PATH)
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
