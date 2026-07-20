#!/usr/bin/env python3
"""Prepare mock_homis for the homis-mock-v3 selector contract."""

from __future__ import annotations

import argparse
from pathlib import Path

from prepare_homis_mock_v2 import (
    prepare_dates,
    prepare_javascript as prepare_v2_javascript,
    prepare_patients,
    prepare_render as prepare_v2_render,
    required_files,
)


RENDER_DATE_ANCHOR = '    karte_dates = [iso for (iso, y, m, v) in vdesc]\n'
RENDER_COUNTS = (
    '    single_building_patient_counts = '
    '[int(v.get("tatemono") or 0) or None for (iso, y, m, v) in vdesc]\n'
)
RENDER_CONTAINER_OLD = (
    '        f\'data-record-id="{E(karte_record_ids[0])}">{karte0}</div>\'\n'
)
RENDER_CONTAINER_NEW = (
    '        f\'data-record-id="{E(karte_record_ids[0])}" \'\n'
    '        f\'data-single-building-patient-count="'
    '{single_building_patient_counts[0] or ""}">{karte0}</div>\'\n'
)
RENDER_SCRIPT_ANCHOR = (
    "        f'window.KARTE_RECORD_IDS = "
    "{json.dumps(karte_record_ids, ensure_ascii=False)};'\n"
)
RENDER_SCRIPT_COUNTS = (
    "        f'window.KARTE_SINGLE_BUILDING_PATIENT_COUNTS = "
    "{json.dumps(single_building_patient_counts, ensure_ascii=False)};'\n"
)
JS_ANCHOR = '    var cur = document.getElementById("flip-cur");\n'
JS_COUNT_BLOCK = '''    var sameBuildingCount = window.KARTE_SINGLE_BUILDING_PATIENT_COUNTS
      ? window.KARTE_SINGLE_BUILDING_PATIENT_COUNTS[idx]
      : null;
    if (sameBuildingCount) {
      el.setAttribute("data-single-building-patient-count", String(sameBuildingCount));
    } else {
      el.removeAttribute("data-single-building-patient-count");
    }
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mock_root", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.apply and args.check:
        parser.error("choose either --apply or --check")

    files = required_files(args.mock_root)
    transformed = {
        files["patients"]: prepare_patients(files["patients"].read_text(encoding="utf-8")),
        files["readme"]: prepare_dates(files["readme"].read_text(encoding="utf-8")),
        files["render"]: prepare_render(files["render"].read_text(encoding="utf-8")),
        files["javascript"]: prepare_javascript(files["javascript"].read_text(encoding="utf-8")),
    }
    validate_v3_sources(transformed)
    changed = [path for path, value in transformed.items() if path.read_text(encoding="utf-8") != value]
    if args.check:
        if changed:
            raise SystemExit("mock_homis is not prepared: " + ", ".join(str(path) for path in changed))
        print("homis-mock-v3 check passed")
        return 0
    if not args.apply:
        print("Would update " + (", ".join(str(path) for path in changed) if changed else "no files"))
        return 0
    for path in changed:
        path.write_text(transformed[path], encoding="utf-8")
    print(f"Prepared homis-mock-v3 ({len(changed)} files updated)")
    return 0


def prepare_render(source: str) -> str:
    result = prepare_v2_render(source)
    if "single_building_patient_counts =" not in result:
        result = replace_once(result, RENDER_DATE_ANCHOR, RENDER_DATE_ANCHOR + RENDER_COUNTS)
    if "data-single-building-patient-count" not in result:
        result = replace_once(result, RENDER_CONTAINER_OLD, RENDER_CONTAINER_NEW)
    if "window.KARTE_SINGLE_BUILDING_PATIENT_COUNTS" not in result:
        result = replace_once(result, RENDER_SCRIPT_ANCHOR, RENDER_SCRIPT_ANCHOR + RENDER_SCRIPT_COUNTS)
    return result


def prepare_javascript(source: str) -> str:
    result = prepare_v2_javascript(source)
    if "KARTE_SINGLE_BUILDING_PATIENT_COUNTS" in result:
        return result
    return replace_once(result, JS_ANCHOR, JS_COUNT_BLOCK + JS_ANCHOR)


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"expected exactly one mock contract anchor, found {source.count(old)}: {old.strip()}")
    return source.replace(old, new, 1)


def validate_v3_sources(sources: dict[Path, str]) -> None:
    render = next(value for path, value in sources.items() if path.name == "render.py")
    javascript = next(value for path, value in sources.items() if path.name == "homis.js")
    for expected in (
        "single_building_patient_counts =",
        "data-single-building-patient-count",
        "window.KARTE_SINGLE_BUILDING_PATIENT_COUNTS",
    ):
        if expected not in render:
            raise SystemExit(f"render.py is missing v3 determinant metadata: {expected}")
    if "KARTE_SINGLE_BUILDING_PATIENT_COUNTS" not in javascript:
        raise SystemExit("homis.js does not update same-building determinant metadata")


if __name__ == "__main__":
    raise SystemExit(main())
