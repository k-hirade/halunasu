#!/usr/bin/env python3
"""Prepare a dated HOMIS mock from the checksum-pinned fixture.

Only synthetic dates are shifted. The visible DOM remains identical to the
fixture, and hidden selector metadata is intentionally not injected.
"""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
from pathlib import Path
import re
import shutil
import tempfile


DEFAULT_FIXTURE = Path(__file__).resolve().parent / "fixture"
DEFAULT_OUTPUT = Path("tmp/mock_homis")
DEFAULT_TARGET_MONTH = "2026-07"
ORIGINAL_TARGET_MONTH = "2025-01"
ORIGINAL_EXTENSION_DATES = ("2025-06-19", "2025-07-05")
FORBIDDEN_SELECTOR_METADATA = (
    "data-record-id",
    "data-single-building-patient-count",
    "data-encounter-type",
    "data-visit-kind",
    "data-status",
    "data-source-record-id",
)

SHIFTED_PATIENT_DATE_PATTERNS = (
    re.compile(r'(?P<prefix>"start_date"\s*:\s*["\'])(?P<date>\d{4}-\d{2}-\d{2})(?P<suffix>["\'])'),
    re.compile(r'(?P<prefix>"since"\s*:\s*["\'])(?P<date>\d{4}-\d{2}-\d{2})(?P<suffix>["\'])'),
    re.compile(r'(?P<prefix>ikou_souki_comment\(\s*["\'])(?P<date>\d{4}-\d{2}-\d{2})(?P<suffix>["\']\s*\))'),
    re.compile(
        r'(?P<prefix>初回算定年月日（在宅移行早期加算）[^\n]*?wareki\(\s*["\'])'
        r'(?P<date>\d{4}-\d{2}-\d{2})(?P<suffix>["\']\s*\))'
    ),
)


def main(contract_label: str = "homis-mock-v5") -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--target-month", default=DEFAULT_TARGET_MONTH)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.apply == args.check:
        parser.error("choose exactly one of --apply or --check")

    verify_fixture(args.source)
    with tempfile.TemporaryDirectory(prefix=f"halunasu-{contract_label}-") as temporary:
        generated = Path(temporary) / "mock_homis"
        build_mock(args.source, generated, args.target_month)
        if args.check:
            differences = compare_trees(generated, args.output)
            if differences:
                raise SystemExit(f"{contract_label} output differs: " + ", ".join(differences))
            print(f"{contract_label} check passed")
            return 0

        args.output.parent.mkdir(parents=True, exist_ok=True)
        if args.output.exists():
            shutil.rmtree(args.output)
        shutil.copytree(generated, args.output)
        print(f"Prepared {contract_label} at {args.output}")
    return 0


def verify_fixture(root: Path) -> None:
    checksum_file = root / "SHA256SUMS"
    if not checksum_file.is_file():
        raise SystemExit(f"fixture checksum file not found: {checksum_file}")
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise SystemExit(f"invalid fixture checksum entry: {line}")
        expected, relative = match.groups()
        path = root / relative
        if not path.is_file():
            raise SystemExit(f"fixture file not found: {path}")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"fixture checksum mismatch: {relative}")


def build_mock(source: Path, output: Path, target_month: str) -> None:
    parse_claim_month(target_month)
    shutil.copytree(
        source,
        output,
        ignore=shutil.ignore_patterns("SHA256SUMS", "__pycache__", "*.pyc", ".venv", "venv"),
    )
    patients_path = output / "data" / "patients.py"
    readme_path = output / "README.md"
    render_path = output / "render.py"
    required = (patients_path, readme_path, render_path, output / "static" / "homis.js")
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise SystemExit("missing fixture files: " + ", ".join(missing))

    patients_path.write_text(
        prepare_patients(patients_path.read_text(encoding="utf-8"), target_month),
        encoding="utf-8",
    )
    readme_path.write_text(
        prepare_dates(readme_path.read_text(encoding="utf-8"), target_month),
        encoding="utf-8",
    )
    render_path.write_text(
        prepare_dates(render_path.read_text(encoding="utf-8"), target_month),
        encoding="utf-8",
    )
    validate_generated_tree(output, target_month)


def prepare_patients(source: str, target_month: str = DEFAULT_TARGET_MONTH) -> str:
    target_year, target_number = parse_claim_month(target_month)
    previous_year, previous_number = add_months(target_year, target_number, -1)
    target_delta = month_index(target_year, target_number) - month_index(2025, 1)
    protected, replacements = protect_shifted_patient_dates(source, target_delta)
    result = prepare_dates(protected, target_month)
    for placeholder, shifted in replacements:
        result = result.replace(placeholder, shifted)
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


def protect_shifted_patient_dates(source: str, delta_months: int) -> tuple[str, list[tuple[str, str]]]:
    result = source
    replacements: list[tuple[str, str]] = []
    sequence = 0
    for pattern in SHIFTED_PATIENT_DATE_PATTERNS:
        def replace(match: re.Match[str]) -> str:
            nonlocal sequence
            placeholder = f"__HALUNASU_PATIENT_DATE_{sequence}__"
            sequence += 1
            shifted = shifted_iso_date(match.group("date"), delta_months)
            replacements.append((placeholder, shifted))
            return f'{match.group("prefix")}{placeholder}{match.group("suffix")}'

        result = pattern.sub(replace, result)
    return result, replacements


def prepare_dates(source: str, target_month: str = DEFAULT_TARGET_MONTH) -> str:
    target_year, target_number = parse_claim_month(target_month)
    previous_year, previous_number = add_months(target_year, target_number, -1)
    target_delta = month_index(target_year, target_number) - month_index(2025, 1)
    replacements = [
        *month_replacements(2025, 1, target_year, target_number),
        *month_replacements(2024, 12, previous_year, previous_number),
    ]
    for source_date in ORIGINAL_EXTENSION_DATES:
        replacements.append((source_date, shifted_iso_date(source_date, target_delta)))
    return atomic_token_replace(source, replacements)


def validate_generated_tree(root: Path, target_month: str) -> None:
    all_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.suffix in {".py", ".js", ".md", ".txt"}
    )
    for forbidden in FORBIDDEN_SELECTOR_METADATA:
        if forbidden in all_text:
            raise SystemExit(f"generated mock contains forbidden selector metadata: {forbidden}")
    target_year, target_number = parse_claim_month(target_month)
    previous_year, previous_number = add_months(target_year, target_number, -1)
    patients = (root / "data" / "patients.py").read_text(encoding="utf-8")
    for expected in (
        f"TARGET_YEAR = {target_year}",
        f"TARGET_MONTH = {target_number}",
        f"PREV_YEAR = {previous_year}",
        f"PREV_MONTH = {previous_number}",
    ):
        if expected not in patients:
            raise SystemExit(f"missing prepared date constant: {expected}")
    if ORIGINAL_TARGET_MONTH in patients:
        raise SystemExit(f"stale target month remains: {ORIGINAL_TARGET_MONTH}")


def compare_trees(expected: Path, actual: Path) -> list[str]:
    if not actual.is_dir():
        return [f"missing output directory {actual}"]
    expected_files = {
        path.relative_to(expected)
        for path in expected.rglob("*")
        if path.is_file()
    }
    actual_files = {
        path.relative_to(actual)
        for path in actual.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }
    differences = [f"file set: expected={len(expected_files)} actual={len(actual_files)}"] \
        if expected_files != actual_files else []
    for relative in sorted(expected_files & actual_files):
        if (expected / relative).read_bytes() != (actual / relative).read_bytes():
            differences.append(str(relative))
    return differences


def parse_claim_month(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d{4})-(\d{2})", str(value or ""))
    if not match:
        raise SystemExit("target month must use YYYY-MM")
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
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
    # Synthetic fixtures use days <= 28 for shifted historical dates. Keep a
    # strict failure here so a future invalid transformation is not hidden.
    return date(year, month, source.day).isoformat()


def month_replacements(
    source_year: int,
    source_month: int,
    target_year: int,
    target_month: int,
) -> list[tuple[str, str]]:
    result = [
        (f"{source_year:04d}-{source_month:02d}", f"{target_year:04d}-{target_month:02d}"),
        (f"{source_year}年{source_month}月", f"{target_year}年{target_month}月"),
    ]
    if source_year >= 2019 and target_year >= 2019:
        result.append(
            (
                f"令和{source_year - 2018}年{source_month}月",
                f"令和{target_year - 2018}年{target_month}月",
            )
        )
    return result


def atomic_token_replace(source: str, replacements: list[tuple[str, str]]) -> str:
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
