#!/usr/bin/env python3
"""Shift the claim month of a mock HOMIS recalculation-diff dataset in place.

Why: the mock dataset was generated with claim month 2025-01, but the fee
master DB only contains the 2026-06 edition (medical_procedures.effective_from
= 2026-06-01). The engine correctly resolves zero procedure codes for service
dates before that, so the dataset must live in a month the master covers.

What it rewrites (explicit month mapping only; historical dates such as
problem-list onset years stay untouched):

- ISO months/dates: 2025-01[-DD] -> 2026-06[-DD], 2024-12 -> 2026-05
- Wareki text: 令和7年1月 -> 令和8年6月 (spacing/full-width digits preserved)
- UKE billing month field (GYYMM): 50701 -> 50806 (cp932 and the _utf8 copy)
- Rebuilds patient_zips/*.zip and the all_patients ZIP from the source dirs

Usage:
  python3 scripts/mock_homis_shift_recalculation_diff_dates.py \
      --dataset tmp/dataset_recalculation_diff_diagnosis/20260705_102303_mock_homis_uke_recalculation_diff

Take a copy of the dataset directory before running; this edits files in place.
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

ISO_MONTH_MAP = {
    "2025-01": "2026-06",
    "2024-12": "2026-05",
}
# (era-digit, year, month) -> replacement (era-digit, year, month)
WAREKI_MONTH_MAP = {
    ("7", "1"): ("8", "6"),
    ("6", "12"): ("8", "5"),
}
# UKE IR record 請求年月 (GYYMM: 5=令和)
UKE_MONTH_MAP = {
    "50701": "50806",
    "50612": "50805",
}

TEXT_SUFFIXES = {".csv", ".json", ".jsonl", ".md"}
_FW_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")


def shift_iso(text: str) -> tuple[str, int]:
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        replaced = ISO_MONTH_MAP.get(match.group(1))
        if replaced is None:
            return match.group(0)
        count += 1
        return replaced + match.group(2)

    pattern = re.compile(r"(\d{4}-\d{2})((?:-\d{2})?)(?!\d)")
    return pattern.sub(repl, text), count


def shift_wareki(text: str) -> tuple[str, int]:
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        era_year = str(int(match.group(2).translate(_FW_DIGITS)))
        month = str(int(match.group(4).translate(_FW_DIGITS)))
        mapped = WAREKI_MONTH_MAP.get((era_year, month))
        if mapped is None:
            return match.group(0)
        count += 1
        new_year, new_month = mapped
        return f"令和{match.group(1)}{new_year}年{match.group(3)}{new_month}月"

    pattern = re.compile(
        r"令和([ 　]*)([0-9０-９]{1,2})[ 　]*年([ 　]*)([0-9０-９]{1,2})[ 　]*月"
    )
    return pattern.sub(repl, text), count


def shift_uke(path: Path, encoding: str) -> int:
    text = path.read_text(encoding=encoding)
    count = 0
    lines = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        tail = line[len(body):]
        fields = body.split(",")
        for index, field in enumerate(fields):
            replaced = UKE_MONTH_MAP.get(field)
            if replaced is not None:
                fields[index] = replaced
                count += 1
        lines.append(",".join(fields) + tail)
    if count:
        path.write_text("".join(lines), encoding=encoding)
    return count


def shift_text_file(path: Path) -> int:
    original = path.read_text(encoding="utf-8")
    text, iso_count = shift_iso(original)
    text, wareki_count = shift_wareki(text)
    if text != original:
        path.write_text(text, encoding="utf-8")
    return iso_count + wareki_count


def rebuild_zip(zip_path: Path, source_dir: Path) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        arcnames = archive.namelist()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for arcname in arcnames:
            member = source_dir / arcname
            if not member.is_file():
                raise SystemExit(f"zip member missing in source dir: {member}")
            archive.write(member, arcname)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    args = parser.parse_args()
    dataset: Path = args.dataset
    if not dataset.is_dir():
        raise SystemExit(f"dataset directory not found: {dataset}")

    text_replacements = 0
    uke_replacements = 0
    for path in sorted(dataset.rglob("*")):
        if not path.is_file() or "backup" in path.name:
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            text_replacements += shift_text_file(path)
        elif path.name == "RECEIPTC.UKE":
            uke_replacements += shift_uke(path, "cp932")
        elif path.name == "RECEIPTC_utf8.UKE":
            uke_replacements += shift_uke(path, "utf-8")

    zip_count = 0
    for zip_path in sorted((dataset / "patient_zips").glob("*.zip")):
        patient_id = zip_path.name.split("_", 1)[0]
        rebuild_zip(zip_path, dataset / "patient_sources" / patient_id)
        zip_count += 1
    for zip_path in sorted((dataset / "all_patients").glob("*.zip")):
        rebuild_zip(zip_path, dataset / "all_patients" / "source")
        zip_count += 1

    leftovers = []
    for path in sorted(dataset.rglob("*")):
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            text = path.read_text(encoding="utf-8")
            for month in ISO_MONTH_MAP:
                if month in text:
                    leftovers.append(f"{path}: {month}")
    if leftovers:
        print("WARNING: unshifted months remain:", file=sys.stderr)
        for line in leftovers:
            print(f"  {line}", file=sys.stderr)
        raise SystemExit(1)

    print(f"text replacements: {text_replacements}")
    print(f"uke replacements: {uke_replacements}")
    print(f"zips rebuilt: {zip_count}")


if __name__ == "__main__":
    main()
