#!/usr/bin/env python3
"""Resolve fee master codes from JSON stdin without exposing SQL to callers."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


TABLES = (
    ("medical_procedures", "short_name"),
    ("drugs", "name"),
    ("specific_materials", "name"),
    ("comments", "comment_text"),
)


def lookup_codes(db_path: Path, codes: list[str]) -> dict[str, dict[str, Any]]:
    normalized = sorted({str(code).strip() for code in codes if str(code).strip()})
    found: dict[str, dict[str, Any]] = {}
    if not normalized:
        return found
    placeholders = ",".join("?" for _ in normalized)
    with sqlite3.connect(str(db_path)) as connection:
        for table, name_column in TABLES:
            rows = connection.execute(
                f"SELECT code, {name_column} FROM {table} "
                f"WHERE code IN ({placeholders})",  # noqa: S608 - fixed table and column names.
                normalized,
            ).fetchall()
            for code, name in rows:
                key = str(code)
                found.setdefault(
                    key,
                    {
                        "code": key,
                        "name": str(name or ""),
                        "table": table,
                    },
                )
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    args = parser.parse_args()
    if not args.db.is_file():
        raise FileNotFoundError(f"fee master database not found: {args.db}")
    payload = json.load(sys.stdin)
    codes = payload.get("codes") if isinstance(payload, dict) else None
    if not isinstance(codes, list):
        raise ValueError("stdin must be an object with a codes array")
    json.dump(
        {"records": lookup_codes(args.db, codes)},
        sys.stdout,
        ensure_ascii=False,
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
