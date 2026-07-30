#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "data/fee-rules/source/document-billing-families-2026.json"
MASTER_DB_PATH = ROOT / "python/data/master/standard-master.sqlite"
OUTPUT_PATH = (
    ROOT
    / "services/fee-api/src/fee-rule-data/document-billing-families-2026.generated.json"
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
            raise SystemExit(f"fee document billing artifact is stale: {args.output}")
        print(f"fee document billing artifact is current: {args.output}")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(args.output)
    return 0


def build_artifact(source: dict[str, Any], master_db: Path) -> dict[str, Any]:
    source_document = next(
        (
            item
            for item in source["sourceDocuments"]
            if item["sourceId"] == "ssk-medical-procedure-master-2026-06-15"
        ),
        None,
    )
    if source_document is None:
        raise ValueError("medical procedure source document is missing")

    connection = sqlite3.connect(master_db)
    connection.row_factory = sqlite3.Row
    try:
        master_source = connection.execute(
            """
            SELECT id, source_version, published_at, url, checksum_sha256
            FROM master_sources
            WHERE source_type = 'medical_procedure_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        if master_source is None:
            raise ValueError("medical procedure master source is missing")
        if master_source["source_version"] != source_document["sourceVersion"]:
            raise ValueError(
                "medical procedure master version mismatch: "
                f"{master_source['source_version']} != {source_document['sourceVersion']}"
            )
        if master_source["checksum_sha256"] != source_document["sha256"]:
            raise ValueError("medical procedure master checksum mismatch")

        families = []
        for family in source["families"]:
            procedures = []
            for procedure_name in family["procedureNames"]:
                rows = connection.execute(
                    """
                    SELECT code, short_name, base_name, points, effective_from, effective_to
                    FROM medical_procedures
                    WHERE source_id = ?
                      AND short_name = ?
                    ORDER BY code
                    """,
                    (master_source["id"], procedure_name),
                ).fetchall()
                if len(rows) != 1:
                    raise ValueError(
                        f"procedure name must resolve uniquely: {procedure_name} ({len(rows)})"
                    )
                row = rows[0]
                procedures.append(
                    {
                        "code": row["code"],
                        "name": row["short_name"],
                        "baseName": row["base_name"],
                        "points": json_number(row["points"]),
                        "effectiveFrom": row["effective_from"],
                        "effectiveTo": row["effective_to"],
                        "sourceVersion": master_source["source_version"],
                    }
                )
            families.append(
                {
                    "familyId": family["familyId"],
                    "displayName": family["displayName"],
                    "inputPatterns": family["inputPatterns"],
                    "excludePatterns": family.get("excludePatterns", []),
                    "procedures": procedures,
                }
            )
    finally:
        connection.close()

    payload = {
        "schemaVersion": "fee-document-billing-artifact-v1",
        "revision": source["revision"],
        "effectiveFrom": source["effectiveFrom"],
        "verifiedAt": source["verifiedAt"],
        "sourceDefinitionSha256": sha256(canonical_json(source)),
        "sourceDocuments": sorted(source["sourceDocuments"], key=lambda item: item["sourceId"]),
        "candidateActionStatuses": sorted(source["candidateActionStatuses"]),
        "families": sorted(families, key=lambda item: item["familyId"]),
    }
    return {
        **payload,
        "artifactPayloadSha256": sha256(canonical_json(payload)),
    }


def validate_source(source: dict[str, Any]) -> None:
    if source.get("schemaVersion") != "fee-document-billing-source-v1":
        raise ValueError("unsupported fee document billing source schema")
    if set(source.get("candidateActionStatuses", [])) != {"created", "issued"}:
        raise ValueError("candidate action statuses must be exactly created and issued")
    if not source.get("families"):
        raise ValueError("document billing families are missing")

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

    family_ids: set[str] = set()
    procedure_names: set[str] = set()
    for family in source["families"]:
        family_id = required(family.get("familyId"), "families.familyId")
        if family_id in family_ids:
            raise ValueError(f"duplicate document family: {family_id}")
        family_ids.add(family_id)
        if not family.get("inputPatterns"):
            raise ValueError(f"{family_id}.inputPatterns is empty")
        if not family.get("procedureNames"):
            raise ValueError(f"{family_id}.procedureNames is empty")
        for procedure_name in family["procedureNames"]:
            name = required(procedure_name, f"{family_id}.procedureNames")
            if name in procedure_names:
                raise ValueError(f"procedure is assigned to multiple families: {name}")
            procedure_names.add(name)


def required(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} is required")
    return text


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
