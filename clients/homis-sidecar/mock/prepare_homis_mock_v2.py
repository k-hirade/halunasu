#!/usr/bin/env python3
"""Prepare the external mock_homis tree for the homis-mock-v2 selector contract."""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
import re


DEFAULT_TARGET_MONTH = "2026-06"
ORIGINAL_TARGET_MONTH = "2025-01"
BASELINE_PREPARED_TARGET_MONTH = "2026-06"
ORIGINAL_EXTENSION_DATES = ("2025-06-19", "2025-07-05")

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


def prepare_dates(source: str, target_month: str = DEFAULT_TARGET_MONTH) -> str:
    target_year, target_number = parse_claim_month(target_month)
    if target_month != BASELINE_PREPARED_TARGET_MONTH and any(
        marker in source
        for marker in (
            f"{target_year:04d}-{target_number:02d}",
            f"{target_year}年{target_number}月",
        )
    ):
        return source
    previous_year, previous_number = add_months(target_year, target_number, -1)
    target_delta = month_index(target_year, target_number) - month_index(2025, 1)
    replacements = [
        *month_replacements(2025, 1, target_year, target_number),
        *month_replacements(2026, 6, target_year, target_number),
        *month_replacements(2024, 12, previous_year, previous_number),
        *month_replacements(2026, 5, previous_year, previous_number),
    ]
    for source_date in ORIGINAL_EXTENSION_DATES:
        target_date = shifted_iso_date(source_date, target_delta)
        replacements.extend((
            (source_date, target_date),
            (shifted_iso_date(source_date, 17), target_date),
        ))
    return atomic_token_replace(source, replacements)


def prepare_patients(source: str, target_month: str = DEFAULT_TARGET_MONTH) -> str:
    target_year, target_number = parse_claim_month(target_month)
    previous_year, previous_number = add_months(target_year, target_number, -1)
    result = prepare_dates(source, target_month)
    constants = {
        "TARGET_YEAR": target_year,
        "TARGET_MONTH": target_number,
        "PREV_YEAR": previous_year,
        "PREV_MONTH": previous_number,
    }
    for name, value in constants.items():
        result, count = re.subn(
            rf"(?m)^{name}\s*=\s*\d+\s*$",
            f"{name} = {value}",
            result,
            count=1,
        )
        if count != 1:
            raise SystemExit(f"missing mock date constant: {name}")
    return result


def prepare_render(source: str, target_month: str = DEFAULT_TARGET_MONTH) -> str:
    result = prepare_dates(source, target_month)
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


def validate_prepared_sources(
    sources: dict[Path, str],
    target_month: str = DEFAULT_TARGET_MONTH,
) -> None:
    combined = "\n".join(sources.values())
    for stale in ("2025年1月", "2024年12月", '"2025-01"', '"2024-12"'):
        if stale in combined:
            raise SystemExit(f"stale target period remains: {stale}")
    target_year, target_number = parse_claim_month(target_month)
    previous_year, previous_number = add_months(target_year, target_number, -1)
    patients = next(value for path, value in sources.items() if path.name == "patients.py")
    for expected in (
        f"TARGET_YEAR = {target_year}",
        f"TARGET_MONTH = {target_number}",
        f"PREV_YEAR = {previous_year}",
        f"PREV_MONTH = {previous_number}",
    ):
        if expected not in patients:
            raise SystemExit(f"missing prepared date constant: {expected}")
    render = next(value for path, value in sources.items() if path.name == "render.py")
    javascript = next(value for path, value in sources.items() if path.name == "homis.js")
    if 'data-record-id="{E(karte_record_ids[0])}"' not in render or "window.KARTE_RECORD_IDS" not in render:
        raise SystemExit("render.py does not expose immutable chart record IDs")
    if 'el.setAttribute("data-record-id"' not in javascript:
        raise SystemExit("homis.js does not update immutable chart record IDs")


def parse_claim_month(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d{4})-(\d{2})", str(value or ""))
    if not match:
        raise SystemExit("target month must use YYYY-MM")
    year, month = int(match.group(1)), int(match.group(2))
    if month < 1 or month > 12:
        raise SystemExit("target month is invalid")
    return year, month


def month_index(year: int, month: int) -> int:
    return year * 12 + month - 1


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    value = month_index(year, month) + delta
    return value // 12, value % 12 + 1


def shifted_iso_date(value: str, delta_months: int) -> str:
    source = date.fromisoformat(value)
    year, month = add_months(source.year, source.month, delta_months)
    return date(year, month, source.day).isoformat()


def month_replacements(
    source_year: int,
    source_month: int,
    target_year: int,
    target_month: int,
) -> list[tuple[str, str]]:
    result = [
        (
            f"{source_year:04d}-{source_month:02d}",
            f"{target_year:04d}-{target_month:02d}",
        ),
        (
            f"{source_year}年{source_month}月",
            f"{target_year}年{target_month}月",
        ),
    ]
    if source_year >= 2019 and target_year >= 2019:
        result.append(
            (
                f"令和{source_year - 2018}年{source_month}月",
                f"令和{target_year - 2018}年{target_month}月",
            )
        )
    return result


def atomic_token_replace(
    source: str,
    replacements: list[tuple[str, str]],
) -> str:
    result = source
    placeholders: list[tuple[str, str]] = []
    for index, (old_value, new_value) in enumerate(replacements):
        placeholder = f"__HALUNASU_PERIOD_{index}__"
        if old_value in result:
            result = result.replace(old_value, placeholder)
            placeholders.append((placeholder, new_value))
    for placeholder, new_value in placeholders:
        result = result.replace(placeholder, new_value)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
