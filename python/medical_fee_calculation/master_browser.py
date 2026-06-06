from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


MASTER_TYPES = frozenset({"procedure", "drug", "material", "comment"})

SOURCE_TYPES = {
    "procedure": "medical_procedure_master",
    "drug": "drug_master",
    "material": "specific_material_master",
    "comment": "comment_master",
}

SOURCE_LABELS = {
    "medical_procedure_master": "medical procedure",
    "drug_master": "drug",
    "specific_material_master": "specific material",
    "comment_master": "comment",
    "medical_electronic_fee_table": "electronic fee table",
}


def browse_master(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = str(payload.get("db_path") or "").strip()
    if not db_path:
        raise ValueError("db_path is required")

    master_type = str(payload.get("type") or "procedure").strip().lower()
    if master_type not in MASTER_TYPES:
        raise ValueError("type must be one of procedure, drug, material, comment")

    query = str(payload.get("query") or payload.get("q") or "").strip()
    page = _positive_int(payload.get("page"), 1, 10_000)
    page_size = _positive_int(payload.get("page_size") or payload.get("pageSize"), 50, 100)
    offset = (page - 1) * page_size

    db = sqlite3.connect(Path(db_path))
    db.row_factory = sqlite3.Row
    try:
        source_id = _latest_source_id(db, SOURCE_TYPES[master_type])
        total_count = _count_items(db, master_type, source_id, query)
        items = _browse_items(db, master_type, source_id, query, page_size, offset)
        sources = _source_summaries(db)
    finally:
        db.close()

    return {
        "type": master_type,
        "query": query,
        "page": page,
        "pageSize": page_size,
        "totalCount": total_count,
        "totalPages": max(1, (total_count + page_size - 1) // page_size),
        "items": items,
        "sources": sources,
    }


def _latest_source_id(db: sqlite3.Connection, source_type: str) -> int:
    row = db.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
        """,
        (source_type,),
    ).fetchone()
    if row is None:
        raise ValueError(f"source not found: {source_type}")
    return int(row["id"])


def _source_summaries(db: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = db.execute(
        """
        SELECT source_type, source_version, published_at, raw_path, checksum_sha256,
               encoding, row_count, retrieved_at, imported_at
        FROM master_sources
        WHERE id IN (
          SELECT MAX(id)
          FROM master_sources
          WHERE source_type IN (
            'medical_procedure_master',
            'drug_master',
            'specific_material_master',
            'comment_master',
            'medical_electronic_fee_table'
          )
          GROUP BY source_type
        )
        ORDER BY source_type
        """
    ).fetchall()
    return [
        _compact(
            {
                "sourceType": row["source_type"],
                "label": SOURCE_LABELS.get(row["source_type"], row["source_type"]),
                "sourceVersion": row["source_version"],
                "publishedAt": row["published_at"],
                "rawPath": row["raw_path"],
                "checksumSha256": row["checksum_sha256"],
                "encoding": row["encoding"],
                "rowCount": row["row_count"],
                "retrievedAt": row["retrieved_at"],
                "importedAt": row["imported_at"],
            }
        )
        for row in rows
    ]


def _count_items(db: sqlite3.Connection, master_type: str, source_id: int, query: str) -> int:
    table, where_sql, params = _query_spec(master_type, source_id, query)
    row = db.execute(f"SELECT COUNT(*) AS count FROM {table} WHERE {where_sql}", params).fetchone()
    return int(row["count"] if row is not None else 0)


def _browse_items(
    db: sqlite3.Connection,
    master_type: str,
    source_id: int,
    query: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    if master_type == "procedure":
        return _browse_procedures(db, source_id, query, limit, offset)
    if master_type == "drug":
        return _browse_drugs(db, source_id, query, limit, offset)
    if master_type == "material":
        return _browse_materials(db, source_id, query, limit, offset)
    return _browse_comments(db, source_id, query, limit, offset)


def _browse_procedures(
    db: sqlite3.Connection,
    source_id: int,
    query: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    where_sql, params = _procedure_where(source_id, query)
    rows = db.execute(
        f"""
        SELECT code, short_name, base_name, points, inout_applicability,
               chapter, part, section, effective_from, effective_to
        FROM medical_procedures
        WHERE {where_sql}
        ORDER BY {_order_sql("code")}
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    return [
        _compact(
            {
                "kind": "procedure",
                "code": row["code"],
                "name": row["short_name"],
                "baseName": row["base_name"],
                "points": row["points"],
                "inoutApplicability": row["inout_applicability"],
                "chapter": row["chapter"],
                "part": row["part"],
                "section": row["section"],
                "effectiveFrom": row["effective_from"],
                "effectiveTo": row["effective_to"],
            }
        )
        for row in rows
    ]


def _browse_drugs(
    db: sqlite3.Connection,
    source_id: int,
    query: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    where_sql, params = _drug_where(source_id, query)
    rows = db.execute(
        f"""
        SELECT code, name, base_name, kana, unit_name, unit_amount_yen,
               amount_kind, dosage_form, reimbursement_code, changed_at, discontinued_at
        FROM drugs
        WHERE {where_sql}
        ORDER BY {_order_sql("code")}
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    return [
        _compact(
            {
                "kind": "drug",
                "code": row["code"],
                "name": row["name"],
                "baseName": row["base_name"],
                "kana": row["kana"],
                "unitName": row["unit_name"],
                "unitAmountYen": row["unit_amount_yen"],
                "amountKind": row["amount_kind"],
                "dosageForm": row["dosage_form"],
                "reimbursementCode": row["reimbursement_code"],
                "effectiveFrom": row["changed_at"],
                "effectiveTo": row["discontinued_at"],
            }
        )
        for row in rows
    ]


def _browse_materials(
    db: sqlite3.Connection,
    source_id: int,
    query: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    where_sql, params = _drug_where(source_id, query)
    rows = db.execute(
        f"""
        SELECT code, name, base_name, kana, unit_name, unit_amount_yen,
               amount_kind, material_kind, upper_points, changed_at, discontinued_at
        FROM specific_materials
        WHERE {where_sql}
        ORDER BY {_order_sql("code")}
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    return [
        _compact(
            {
                "kind": "material",
                "code": row["code"],
                "name": row["name"],
                "baseName": row["base_name"],
                "kana": row["kana"],
                "unitName": row["unit_name"],
                "unitAmountYen": row["unit_amount_yen"],
                "amountKind": row["amount_kind"],
                "materialKind": row["material_kind"],
                "upperPoints": row["upper_points"],
                "effectiveFrom": row["changed_at"],
                "effectiveTo": row["discontinued_at"],
            }
        )
        for row in rows
    ]


def _browse_comments(
    db: sqlite3.Connection,
    source_id: int,
    query: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    where_sql, params = _comment_where(source_id, query)
    rows = db.execute(
        f"""
        SELECT code, comment_text, kana, effective_from, effective_to
        FROM comments
        WHERE {where_sql}
        ORDER BY {_order_sql("code")}
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    return [
        _compact(
            {
                "kind": "comment",
                "code": row["code"],
                "name": row["comment_text"],
                "kana": row["kana"],
                "effectiveFrom": row["effective_from"],
                "effectiveTo": row["effective_to"],
            }
        )
        for row in rows
    ]


def _query_spec(master_type: str, source_id: int, query: str) -> tuple[str, str, tuple[Any, ...]]:
    if master_type == "procedure":
        where_sql, params = _procedure_where(source_id, query)
        return "medical_procedures", where_sql, params
    if master_type == "drug":
        where_sql, params = _drug_where(source_id, query)
        return "drugs", where_sql, params
    if master_type == "material":
        where_sql, params = _drug_where(source_id, query)
        return "specific_materials", where_sql, params
    where_sql, params = _comment_where(source_id, query)
    return "comments", where_sql, params


def _procedure_where(source_id: int, query: str) -> tuple[str, tuple[Any, ...]]:
    if not query:
        return "source_id = ?", (source_id,)
    return (
        """
        source_id = ?
        AND (
          code LIKE ?
          OR short_name LIKE ?
          OR COALESCE(base_name, '') LIKE ?
        )
        """,
        (source_id, *_like_params(query, 3)),
    )


def _drug_where(source_id: int, query: str) -> tuple[str, tuple[Any, ...]]:
    if not query:
        return "source_id = ?", (source_id,)
    return (
        """
        source_id = ?
        AND (
          code LIKE ?
          OR name LIKE ?
          OR COALESCE(base_name, '') LIKE ?
          OR COALESCE(kana, '') LIKE ?
        )
        """,
        (source_id, *_like_params(query, 4)),
    )


def _comment_where(source_id: int, query: str) -> tuple[str, tuple[Any, ...]]:
    if not query:
        return "source_id = ?", (source_id,)
    return (
        """
        source_id = ?
        AND (
          code LIKE ?
          OR comment_text LIKE ?
          OR COALESCE(kana, '') LIKE ?
        )
        """,
        (source_id, *_like_params(query, 3)),
    )


def _order_sql(code_column: str) -> str:
    return code_column


def _like_params(query: str, count: int) -> tuple[str, ...]:
    like = f"%{query}%"
    return tuple(like for _ in range(count))


def _positive_int(value: object, fallback: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(1, min(parsed, maximum))


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item not in (None, "")}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = browse_master(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
