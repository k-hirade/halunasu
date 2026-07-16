from __future__ import annotations

import json
import re
import sqlite3
import sys
from typing import Any

from medical_fee_calculation.db import connect, initialize_schema


_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def inspect_master_content(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = str(payload.get("db_path") or "").strip()
    if not db_path:
        raise ValueError("db_path is required")

    requested_tables = payload.get("tables")
    if not isinstance(requested_tables, list) or not requested_tables:
        raise ValueError("tables must be a non-empty array")
    tables = []
    for raw_table in requested_tables:
        table = str(raw_table or "").strip()
        if not _TABLE_NAME.fullmatch(table):
            raise ValueError(f"invalid table name: {table}")
        if table not in tables:
            tables.append(table)

    conn = connect(db_path)
    try:
        # Missing legacy tables must become observable as zero rows, rather than
        # surfacing as a table-existence error.
        initialize_schema(conn)
        counts: dict[str, int] = {}
        for table in tables:
            try:
                row = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()
                counts[table] = int(row[0] if row else 0)
            except sqlite3.OperationalError as exc:
                if "no such table" not in str(exc).lower():
                    raise
                counts[table] = 0
        return {"tables": counts}
    finally:
        conn.close()


def main() -> None:
    payload = json.load(sys.stdin)
    result = inspect_master_content(payload)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
