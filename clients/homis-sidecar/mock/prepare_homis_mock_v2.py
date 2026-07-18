#!/usr/bin/env python3
"""Prepare the external mock_homis tree for the homis-mock-v2 selector contract."""

from __future__ import annotations

import argparse
from pathlib import Path


DATE_REPLACEMENTS = (
    ("2025年1月", "2026年6月"),
    ("2024年12月", "2026年5月"),
    ("2025-01", "2026-06"),
    ("2024-12", "2026-05"),
    # These instruction periods extend beyond the target month and need the same 17-month shift.
    ("2025-06-19", "2026-11-19"),
    ("2025-07-05", "2026-12-05"),
)

RENDER_DATE_ANCHOR = '    karte_dates = [iso for (iso, y, m, v) in vdesc]\n'
RENDER_RECORD_BLOCK = '''    date_occurrences = {}
    karte_record_ids = []
    for iso in karte_dates:
        date_occurrences[iso] = date_occurrences.get(iso, 0) + 1
        karte_record_ids.append(
            f'{patient["id"]}-{iso.replace("-", "")}-{date_occurrences[iso]:02d}'
        )
'''
RENDER_CONTAINER_OLD = '        f\'<div id="pdetail_karte" class="pdetail-karte">{karte0}</div>\'\n'
RENDER_CONTAINER_NEW = '''        f'<div id="pdetail_karte" class="pdetail-karte" '
        f'data-record-id="{E(karte_record_ids[0])}">{karte0}</div>'
'''
RENDER_SCRIPT_ANCHOR = "        f'window.KARTE_DATES = {json.dumps(karte_dates, ensure_ascii=False)};'\n"
RENDER_SCRIPT_RECORD_IDS = "        f'window.KARTE_RECORD_IDS = {json.dumps(karte_record_ids, ensure_ascii=False)};'\n"
JS_RENDER_ANCHOR = "    el.innerHTML = window.KARTE_HTML[idx];\n"
JS_RECORD_BLOCK = '''    if (window.KARTE_RECORD_IDS && window.KARTE_RECORD_IDS[idx]) {
      el.setAttribute("data-record-id", window.KARTE_RECORD_IDS[idx]);
    } else {
      el.removeAttribute("data-record-id");
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
    validate_prepared_sources(transformed)

    changed = [path for path, value in transformed.items() if path.read_text(encoding="utf-8") != value]
    if args.check:
        if changed:
            raise SystemExit("mock_homis is not prepared: " + ", ".join(str(path) for path in changed))
        print("homis-mock-v2 check passed")
        return 0
    if not args.apply:
        print("Would update " + (", ".join(str(path) for path in changed) if changed else "no files"))
        return 0
    for path in changed:
        path.write_text(transformed[path], encoding="utf-8")
    print(f"Prepared homis-mock-v2 ({len(changed)} files updated)")
    return 0


def required_files(root: Path) -> dict[str, Path]:
    files = {
        "patients": root / "data" / "patients.py",
        "readme": root / "README.md",
        "render": root / "render.py",
        "javascript": root / "static" / "homis.js",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise SystemExit("missing mock_homis files: " + ", ".join(missing))
    return files


def prepare_dates(source: str) -> str:
    result = source
    for old, new in DATE_REPLACEMENTS:
        result = result.replace(old, new)
    return result


def prepare_patients(source: str) -> str:
    result = prepare_dates(source)
    constants = (
        ("TARGET_YEAR = 2025", "TARGET_YEAR = 2026"),
        ("TARGET_MONTH = 1", "TARGET_MONTH = 6"),
        ("PREV_YEAR = 2024", "PREV_YEAR = 2026"),
        ("PREV_MONTH = 12", "PREV_MONTH = 5"),
    )
    for old, new in constants:
        result = result.replace(old, new)
    return result


def prepare_render(source: str) -> str:
    result = prepare_dates(source)
    if "karte_record_ids = []" not in result:
        result = replace_once(result, RENDER_DATE_ANCHOR, RENDER_DATE_ANCHOR + RENDER_RECORD_BLOCK)
    if 'data-record-id="{E(karte_record_ids[0])}"' not in result:
        result = replace_once(result, RENDER_CONTAINER_OLD, RENDER_CONTAINER_NEW)
    if "window.KARTE_RECORD_IDS" not in result:
        result = replace_once(result, RENDER_SCRIPT_ANCHOR, RENDER_SCRIPT_ANCHOR + RENDER_SCRIPT_RECORD_IDS)
    return result


def prepare_javascript(source: str) -> str:
    if 'el.setAttribute("data-record-id"' in source:
        return source
    return replace_once(source, JS_RENDER_ANCHOR, JS_RENDER_ANCHOR + JS_RECORD_BLOCK)


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"expected exactly one mock contract anchor, found {source.count(old)}: {old.strip()}")
    return source.replace(old, new, 1)


def validate_prepared_sources(sources: dict[Path, str]) -> None:
    combined = "\n".join(sources.values())
    for stale in ("2025年1月", "2024年12月", '"2025-01"', '"2024-12"'):
        if stale in combined:
            raise SystemExit(f"stale target period remains: {stale}")
    patients = next(value for path, value in sources.items() if path.name == "patients.py")
    for expected in ("TARGET_YEAR = 2026", "TARGET_MONTH = 6", "PREV_YEAR = 2026", "PREV_MONTH = 5"):
        if expected not in patients:
            raise SystemExit(f"missing prepared date constant: {expected}")
    render = next(value for path, value in sources.items() if path.name == "render.py")
    javascript = next(value for path, value in sources.items() if path.name == "homis.js")
    if 'data-record-id="{E(karte_record_ids[0])}"' not in render or "window.KARTE_RECORD_IDS" not in render:
        raise SystemExit("render.py does not expose immutable chart record IDs")
    if 'el.setAttribute("data-record-id"' not in javascript:
        raise SystemExit("homis.js does not update immutable chart record IDs")


if __name__ == "__main__":
    raise SystemExit(main())
