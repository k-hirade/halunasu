#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "data/fee-rules/source/specific-material-classification-2026.json"
MASTER_DB_PATH = ROOT / "python/data/master/standard-master.sqlite"
OUTPUT_PATH = (
    ROOT
    / "services/fee-api/src/fee-rule-data/specific-material-classification-2026.generated.json"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--source", type=Path, default=SOURCE_PATH)
    parser.add_argument("--master-db", type=Path, default=MASTER_DB_PATH)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()

    source = json.loads(args.source.read_text(encoding="utf-8"))
    validate_source(source)
    artifact = build_artifact(source, args.master_db)
    rendered = json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.check:
        current = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if current != rendered:
            raise SystemExit(f"fee specific material artifact is stale: {args.output}")
        print(f"fee specific material artifact is current: {args.output}")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(args.output)
    return 0


def build_artifact(source: dict[str, Any], master_db: Path) -> dict[str, Any]:
    connection = sqlite3.connect(master_db)
    connection.row_factory = sqlite3.Row
    try:
        master_source = connection.execute(
            """
            SELECT source_version, published_at, url, checksum_sha256
            FROM master_sources
            WHERE source_type = 'specific_material_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        if master_source is None:
            raise ValueError("specific material master source is missing")
        expected_source = next(
            (
                item
                for item in source["sourceDocuments"]
                if item["sourceId"] == "ssk-specific-material-master-2026-06-15"
            ),
            None,
        )
        if expected_source is None:
            raise ValueError("specific material master source document is missing")
        if master_source["source_version"] != expected_source["sourceVersion"]:
            raise ValueError(
                "specific material master version mismatch: "
                f"{master_source['source_version']} != {expected_source['sourceVersion']}"
            )
        if master_source["checksum_sha256"] != expected_source["sha256"]:
            raise ValueError("specific material master checksum mismatch")

        categories = []
        allowed_tables = tuple(str(item) for item in source["medicalNotificationTables"])
        for category in source["categories"]:
            rows = connection.execute(
                f"""
                SELECT
                    m.code,
                    m.name,
                    m.unit_name,
                    m.unit_amount_yen,
                    m.changed_at,
                    m.discontinued_at,
                    m.notification_table_no,
                    m.notification_section_no
                FROM specific_materials m
                JOIN master_sources s ON s.id = m.source_id
                WHERE s.source_type = 'specific_material_master'
                  AND s.source_version = ?
                  AND m.name LIKE ?
                  AND m.notification_table_no IN ({",".join("?" for _ in allowed_tables)})
                ORDER BY m.notification_table_no, m.name, m.code
                """,
                (
                    expected_source["sourceVersion"],
                    f"{category['masterNamePrefix']}%",
                    *allowed_tables,
                ),
            ).fetchall()
            if not rows:
                raise ValueError(f"no material master rows for {category['categoryId']}")
            candidates = [
                {
                    "code": row["code"],
                    "name": row["name"],
                    "unitName": row["unit_name"],
                    "unitAmountYen": json_number(row["unit_amount_yen"]),
                    "effectiveFrom": row["changed_at"],
                    "effectiveTo": row["discontinued_at"],
                    "sourceVersion": master_source["source_version"],
                    "notificationTableNumber": row["notification_table_no"],
                    "notificationSectionNumber": row["notification_section_no"],
                    "attributes": candidate_attributes(row["name"], category["attributeAxes"]),
                }
                for row in rows
            ]
            categories.append(
                {
                    "categoryId": category["categoryId"],
                    "displayName": category["displayName"],
                    "masterNamePrefix": category["masterNamePrefix"],
                    "inputCategoryPatterns": category["inputCategoryPatterns"],
                    "deviceFactTypes": category["deviceFactTypes"],
                    "attributeAxes": category["attributeAxes"],
                    "candidates": candidates,
                }
            )
    finally:
        connection.close()

    payload = {
        "schemaVersion": "fee-specific-material-classification-artifact-v1",
        "revision": source["revision"],
        "effectiveFrom": source["effectiveFrom"],
        "verifiedAt": source["verifiedAt"],
        "sourceDefinitionSha256": sha256(canonical_json(source)),
        "sourceDocuments": sorted(source["sourceDocuments"], key=lambda item: item["sourceId"]),
        "medicalNotificationTables": list(source["medicalNotificationTables"]),
        "categories": sorted(categories, key=lambda item: item["categoryId"]),
    }
    return {
        **payload,
        "artifactPayloadSha256": sha256(canonical_json(payload)),
    }


def candidate_attributes(name: str, axes: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    normalized_name = normalize_text(name)
    for axis in axes:
        matches = [
            value["value"]
            for value in axis["values"]
            if any(
                normalize_text(token) in normalized_name
                for token in value["candidateNameContains"]
            )
        ]
        unique_matches = list(dict.fromkeys(json.dumps(item, ensure_ascii=False) for item in matches))
        if len(unique_matches) > 1:
            raise ValueError(
                f"candidate attribute is not unique: {name} / {axis['key']} / {matches}"
            )
        if matches:
            result[axis["key"]] = matches[0]
    return result


def validate_source(source: dict[str, Any]) -> None:
    if source.get("schemaVersion") != "fee-specific-material-classification-source-v1":
        raise ValueError("unsupported specific material source schema")
    if not source.get("categories"):
        raise ValueError("specific material categories are missing")
    if set(source.get("medicalNotificationTables", [])) != {"1", "2"}:
        raise ValueError("medical notification tables must be exactly table 1 and table 2")
    source_ids: set[str] = set()
    for document in source.get("sourceDocuments", []):
        source_id = required(document.get("sourceId"), "sourceDocuments.sourceId")
        if source_id in source_ids:
            raise ValueError(f"duplicate source document: {source_id}")
        source_ids.add(source_id)
        if not str(document.get("url", "")).startswith("https://"):
            raise ValueError(f"source URL must use HTTPS: {source_id}")
        checksum = str(document.get("sha256", ""))
        if len(checksum) != 64 or any(char not in "0123456789abcdef" for char in checksum):
            raise ValueError(f"source sha256 is invalid: {source_id}")

    category_ids: set[str] = set()
    for category in source["categories"]:
        category_id = required(category.get("categoryId"), "categories.categoryId")
        if category_id in category_ids:
            raise ValueError(f"duplicate material category: {category_id}")
        category_ids.add(category_id)
        required(category.get("masterNamePrefix"), f"{category_id}.masterNamePrefix")
        if not category.get("inputCategoryPatterns"):
            raise ValueError(f"{category_id}.inputCategoryPatterns is empty")
        axis_keys: set[str] = set()
        for axis in category.get("attributeAxes", []):
            axis_key = required(axis.get("key"), f"{category_id}.attributeAxes.key")
            if axis_key in axis_keys:
                raise ValueError(f"duplicate attribute axis: {category_id}.{axis_key}")
            axis_keys.add(axis_key)
            if not axis.get("values"):
                raise ValueError(f"{category_id}.{axis_key}.values is empty")
            for value in axis["values"]:
                if "value" not in value:
                    raise ValueError(f"{category_id}.{axis_key}.value is missing")
                if not value.get("candidateNameContains") or not value.get("inputPatterns"):
                    raise ValueError(
                        f"{category_id}.{axis_key} requires candidate and input patterns"
                    )


def required(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} is required")
    return text


def normalize_text(value: Any) -> str:
    return (
        str(value or "")
        .replace(" ", "")
        .replace("　", "")
        .replace("(", "（")
        .replace(")", "）")
        .upper()
    )


def json_number(value: Any) -> int | float:
    number = float(value)
    return int(number) if number.is_integer() else number


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
