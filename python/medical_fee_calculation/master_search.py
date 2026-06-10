from __future__ import annotations

import json
import sqlite3
import sys
import unicodedata
from pathlib import Path
from typing import Any


MASTER_TYPES = frozenset({"procedure", "drug", "material", "comment", "all"})
_DB_CONNECTIONS: dict[str, sqlite3.Connection] = {}
_MAX_QUERY_VARIANTS = 8


def search_master(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = str(payload.get("db_path") or "").strip()
    if not db_path:
        raise ValueError("db_path is required")

    query = str(payload.get("query") or payload.get("q") or "").strip()
    if len(query) < 2:
        return {"query": query, "type": payload.get("type") or "all", "items": []}

    master_type = str(payload.get("type") or "all").strip().lower()
    if master_type not in MASTER_TYPES:
        raise ValueError("type must be one of procedure, drug, material, comment, all")

    limit = _bounded_limit(payload.get("limit"))
    per_type_limit = limit if master_type != "all" else max(3, min(8, limit))
    db = _master_db(db_path)
    items: list[dict[str, Any]] = []
    if master_type in {"procedure", "all"}:
        items.extend(_search_procedures(db, query, per_type_limit))
    if master_type in {"drug", "all"}:
        items.extend(_search_drugs(db, query, per_type_limit))
    if master_type in {"material", "all"}:
        items.extend(_search_materials(db, query, per_type_limit))
    if master_type in {"comment", "all"}:
        items.extend(_search_comments(db, query, per_type_limit))

    return {
        "query": query,
        "type": master_type,
        "items": items[:limit],
    }


def _master_db(db_path: str) -> sqlite3.Connection:
    resolved_path = str(Path(db_path).expanduser().resolve())
    db = _DB_CONNECTIONS.get(resolved_path)
    if db is None:
        db = sqlite3.connect(resolved_path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        _DB_CONNECTIONS[resolved_path] = db
    return db


def _search_procedures(db: sqlite3.Connection, query: str, limit: int) -> list[dict[str, Any]]:
    search_condition, search_params = _master_search_condition(
        "p.code",
        ("p.short_name", "COALESCE(p.base_name, '')"),
        query,
    )
    rows = db.execute(
        f"""
        SELECT
            p.code,
            p.short_name AS name,
            p.base_name,
            p.points,
            p.effective_from,
            p.effective_to,
            p.inout_applicability,
            p.outpatient_aggregate,
            p.inpatient_aggregate,
            p.bundle_lab_group,
            p.judgement_kind,
            p.judgement_group,
            p.specimen_comment_flag,
            p.facility_standard_codes,
            p.chapter,
            p.part,
            p.alpha_part,
            p.section,
            p.branch,
            p.item,
            s.source_version,
            s.published_at,
            s.imported_at
        FROM medical_procedures p
        JOIN master_sources s ON s.id = p.source_id
        WHERE p.source_id = (
            SELECT id
            FROM master_sources
            WHERE source_type = 'medical_procedure_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
          )
          AND ({search_condition})
        ORDER BY
            CASE
              WHEN p.code = ? THEN 0
              WHEN p.code LIKE ? THEN 1
              ELSE 2
            END,
            p.code
        LIMIT ?
        """,
        (*search_params, query, f"{query}%", limit),
    ).fetchall()
    return [
        _medical_procedure_item(row)
        for row in rows
    ]


def _medical_procedure_item(row: sqlite3.Row) -> dict[str, Any]:
    role = _medical_procedure_role(row)
    return _compact(
        {
            "kind": "procedure",
            "code": row["code"],
            "name": row["name"],
            "baseName": row["base_name"],
            "points": row["points"],
            "effectiveFrom": row["effective_from"],
            "effectiveTo": row["effective_to"],
            "inoutApplicability": row["inout_applicability"],
            "outpatientAggregate": row["outpatient_aggregate"],
            "inpatientAggregate": row["inpatient_aggregate"],
            "bundleLabGroup": row["bundle_lab_group"],
            "judgementKind": row["judgement_kind"],
            "judgementGroup": row["judgement_group"],
            "specimenCommentFlag": row["specimen_comment_flag"],
            "facilityStandardCodes": row["facility_standard_codes"],
            "chapter": row["chapter"],
            "part": row["part"],
            "alphaPart": row["alpha_part"],
            "section": row["section"],
            "branch": row["branch"],
            "item": row["item"],
            **role,
            "sourceVersion": row["source_version"],
            "publishedAt": row["published_at"],
            "importedAt": row["imported_at"],
        }
    )


def _medical_procedure_role(row: sqlite3.Row) -> dict[str, Any]:
    code = str(row["code"] or "")
    name = f"{row['name'] or ''} {row['base_name'] or ''}"
    chapter = str(row["chapter"] or "")
    part = str(row["part"] or "")
    section = str(row["section"] or "")
    judgement_kind = str(row["judgement_kind"] or "")

    fee_category = "procedure_basic"
    item_role = "base"
    if "減算" in name or "不適合" in name:
        fee_category = "reduction"
        item_role = "reduction"
    elif chapter == "2" and part == "03" and section == "026" and judgement_kind == "2":
        fee_category = "lab_judgment"
        item_role = "judgment"
    elif chapter == "2" and part == "03" and section == "027":
        fee_category = "lab_judgment"
        item_role = "judgment"
    elif chapter == "2" and part == "03" and _section_between(section, 400, 419):
        fee_category = "lab_collection"
        item_role = "collection"
    elif chapter == "2" and part == "03" and _section_between(section, 0, 24) and judgement_kind == "1":
        fee_category = "lab_test_basic"
        item_role = "base"
    elif "外来迅速検体検査加算" in name or "検体検査管理加算" in name:
        fee_category = "lab_addon"
        item_role = "addon"
    elif code.startswith("111") or code.startswith("112"):
        fee_category = "basic_fee"
        item_role = "base"
    elif code.startswith("113") or "管理料" in name or "指導料" in name:
        fee_category = "management_fee"
        item_role = "base"
    elif code.startswith("170") or any(token in name for token in ("ＣＴ", "CT", "ＭＲＩ", "MRI", "撮影", "画像")):
        fee_category = "imaging_basic"
        item_role = "base"

    derived_only = item_role in {"addon", "judgment", "collection", "reduction"}
    return {
        "feeCategory": fee_category,
        "itemRole": item_role,
        "derivedOnly": derived_only,
        "directRetrievalAllowed": not derived_only,
        "requiresParentCode": derived_only,
    }


def _section_between(value: str, minimum: int, maximum: int) -> bool:
    try:
        number = int(str(value or ""))
    except ValueError:
        return False
    return minimum <= number <= maximum


def _search_drugs(db: sqlite3.Connection, query: str, limit: int) -> list[dict[str, Any]]:
    search_condition, search_params = _master_search_condition(
        "d.code",
        ("d.name", "COALESCE(d.base_name, '')", "COALESCE(d.kana, '')"),
        query,
    )
    rows = db.execute(
        f"""
        SELECT
            d.code,
            d.name,
            d.base_name,
            d.kana,
            d.unit_name,
            d.unit_amount_yen,
            d.changed_at,
            d.discontinued_at,
            s.source_version,
            s.published_at,
            s.imported_at
        FROM drugs d
        JOIN master_sources s ON s.id = d.source_id
        WHERE d.source_id = (
            SELECT id
            FROM master_sources
            WHERE source_type = 'drug_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
          )
          AND ({search_condition})
        ORDER BY
            CASE
              WHEN d.code = ? THEN 0
              WHEN d.code LIKE ? THEN 1
              ELSE 2
            END,
            d.code
        LIMIT ?
        """,
        (*search_params, query, f"{query}%", limit),
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
                "effectiveFrom": row["changed_at"],
                "effectiveTo": row["discontinued_at"],
                "sourceVersion": row["source_version"],
                "publishedAt": row["published_at"],
                "importedAt": row["imported_at"],
            }
        )
        for row in rows
    ]


def _search_materials(db: sqlite3.Connection, query: str, limit: int) -> list[dict[str, Any]]:
    search_condition, search_params = _master_search_condition(
        "m.code",
        ("m.name", "COALESCE(m.base_name, '')", "COALESCE(m.kana, '')"),
        query,
    )
    rows = db.execute(
        f"""
        SELECT
            m.code,
            m.name,
            m.base_name,
            m.kana,
            m.unit_name,
            m.unit_amount_yen,
            m.changed_at,
            m.discontinued_at,
            s.source_version,
            s.published_at,
            s.imported_at
        FROM specific_materials m
        JOIN master_sources s ON s.id = m.source_id
        WHERE m.source_id = (
            SELECT id
            FROM master_sources
            WHERE source_type = 'specific_material_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
          )
          AND ({search_condition})
        ORDER BY
            CASE
              WHEN m.code = ? THEN 0
              WHEN m.code LIKE ? THEN 1
              ELSE 2
            END,
            m.code
        LIMIT ?
        """,
        (*search_params, query, f"{query}%", limit),
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
                "effectiveFrom": row["changed_at"],
                "effectiveTo": row["discontinued_at"],
                "sourceVersion": row["source_version"],
                "publishedAt": row["published_at"],
                "importedAt": row["imported_at"],
            }
        )
        for row in rows
    ]


def _search_comments(db: sqlite3.Connection, query: str, limit: int) -> list[dict[str, Any]]:
    search_condition, search_params = _master_search_condition(
        "c.code",
        ("c.comment_text", "COALESCE(c.kana, '')"),
        query,
    )
    rows = db.execute(
        f"""
        SELECT
            c.code,
            c.comment_text,
            c.kana,
            c.effective_from,
            c.effective_to,
            s.source_version,
            s.published_at,
            s.imported_at
        FROM comments c
        JOIN master_sources s ON s.id = c.source_id
        WHERE c.source_id = (
            SELECT id
            FROM master_sources
            WHERE source_type = 'comment_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
          )
          AND ({search_condition})
        ORDER BY
            CASE
              WHEN c.code = ? THEN 0
              WHEN c.code LIKE ? THEN 1
              ELSE 2
            END,
            c.code
        LIMIT ?
        """,
        (*search_params, query, f"{query}%", limit),
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
                "sourceVersion": row["source_version"],
                "publishedAt": row["published_at"],
                "importedAt": row["imported_at"],
            }
        )
        for row in rows
    ]


def _master_search_condition(code_field: str, text_fields: tuple[str, ...], query: str) -> tuple[str, tuple[str, ...]]:
    text_condition, text_params = _text_search_condition(text_fields, query)
    return f"{code_field} LIKE ? OR {text_condition}", (f"%{query}%", *text_params)


def _text_search_condition(fields: tuple[str, ...], query: str) -> tuple[str, tuple[str, ...]]:
    variants = _query_variants(query)
    clauses: list[str] = []
    params: list[str] = []
    for field in fields:
        for variant in variants:
            clauses.append(f"{field} LIKE ?")
            params.append(f"%{variant}%")
    return " OR ".join(clauses), tuple(params)


def _query_variants(query: str) -> tuple[str, ...]:
    raw = str(query or "").strip()
    if not raw:
        return ("",)

    nfkc = unicodedata.normalize("NFKC", raw)
    candidates = [
        raw,
        nfkc,
        _ascii_alnum_to_fullwidth(nfkc),
        _ascii_alnum_to_fullwidth(nfkc.upper()),
        _ascii_alnum_to_fullwidth(nfkc.lower()),
    ]
    for value in list(candidates):
        candidates.extend(_hyphen_variants(value))

    seen: set[str] = set()
    variants: list[str] = []
    for value in candidates:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        variants.append(normalized)
        if len(variants) >= _MAX_QUERY_VARIANTS:
            break
    return tuple(variants)


def _ascii_alnum_to_fullwidth(value: str) -> str:
    converted: list[str] = []
    for char in str(value or ""):
        code = ord(char)
        if 0x30 <= code <= 0x39 or 0x41 <= code <= 0x5A or 0x61 <= code <= 0x7A:
            converted.append(chr(code + 0xFEE0))
        elif char == "-":
            converted.append("－")
        else:
            converted.append(char)
    return "".join(converted)


def _hyphen_variants(value: str) -> list[str]:
    text = str(value or "")
    if not any(char in text for char in ("-", "－", "−")):
        return []
    variants = []
    for hyphen in ("-", "－", "−"):
        variants.append(text.replace("-", hyphen).replace("－", hyphen).replace("−", hyphen))
    return variants


def _bounded_limit(value: object) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 10
    return max(1, min(parsed, 25))


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item not in (None, "")}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = search_master(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
