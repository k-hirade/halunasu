from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CORE_TABLES = {
    "medical_procedures": "medical procedure master",
    "drugs": "drug master",
    "specific_materials": "specific material master",
    "comments": "comment master",
    "comment_links": "comment related table",
    "electronic_aux_master": "medical electronic fee aux master",
    "electronic_bundles": "medical electronic fee bundles",
    "electronic_exclusions": "medical electronic fee exclusions",
    "electronic_frequency_limits": "medical electronic fee frequency limits",
    "hospital_registry": "hospital registry",
    "hospital_facility_standards": "hospital facility standards",
}

DPC_TABLES = {
    "dpc_electronic_table_rows": "DPC electronic fee table",
    "dpc_point_table": "DPC point table",
    "dpc_conversion_table": "DPC conversion table",
    "dpc_icd_table": "DPC ICD table",
    "dpc_surgery_table": "DPC surgery table",
    "dpc_piecework_surgery_codes": "DPC piecework surgery codes",
    "dpc_hospital_coefficients": "DPC hospital coefficients",
}

REQUIRED_CATALOG_KINDS = {
    "medical_procedure_master",
    "drug_master",
    "specific_material_master",
    "comment_master",
    "comment_related_table",
    "medical_electronic_fee_table",
}


def main() -> None:
    args = parse_args()
    report = build_report(args.db, args.catalog)
    rendered = render_report(report, args.format)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered)

    if args.fail_on_risk and report["risk_count"] > 0:
        raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit the active Fee master DB and fixed SSK catalog coverage."
    )
    parser.add_argument("--db", type=Path, default=Path("python/data/master/standard-master.sqlite"))
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("configs/official-master/2026-06-15/ssk-master-catalog.json"),
    )
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fail-on-risk", action="store_true")
    return parser.parse_args()


def build_report(db_path: Path, catalog_path: Path) -> dict[str, Any]:
    table_counts = inspect_tables(db_path)
    catalog = read_catalog(catalog_path)
    risks = detect_risks(table_counts, catalog)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "db_path": str(db_path),
        "db_exists": db_path.exists(),
        "catalog_path": str(catalog_path),
        "catalog_exists": catalog_path.exists(),
        "table_counts": table_counts,
        "catalog_entries": catalog,
        "risks": risks,
        "risk_count": len(risks),
    }


def inspect_tables(db_path: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not db_path.exists():
        return [
            {
                "table": table,
                "label": label,
                "exists": False,
                "count": None,
            }
            for table, label in {**CORE_TABLES, **DPC_TABLES}.items()
        ]

    conn = sqlite3.connect(db_path)
    try:
        existing = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            ).fetchall()
        }
        for table, label in {**CORE_TABLES, **DPC_TABLES}.items():
            count = None
            if table in existing:
                count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            result.append(
                {
                    "table": table,
                    "label": label,
                    "exists": table in existing,
                    "count": count,
                }
            )
    finally:
        conn.close()
    return result


def read_catalog(catalog_path: Path) -> list[dict[str, Any]]:
    if not catalog_path.exists():
        return []
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return []
    result: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        result.append(
            {
                "kind": entry.get("kind"),
                "filename": entry.get("filename"),
                "source_version": entry.get("source_version"),
                "published_at": entry.get("published_at"),
                "source_page_url": entry.get("source_page_url"),
                "url": entry.get("url"),
            }
        )
    return result


def detect_risks(table_counts: list[dict[str, Any]], catalog: list[dict[str, Any]]) -> list[dict[str, str]]:
    risks: list[dict[str, str]] = []
    by_table = {row["table"]: row for row in table_counts}
    for table in CORE_TABLES:
        row = by_table.get(table, {})
        if not row.get("exists") or not row.get("count"):
            risks.append(
                {
                    "severity": "high",
                    "code": f"missing_core_table:{table}",
                    "message": f"{table} has no active rows.",
                }
            )

    zero_dpc = [
        table
        for table in DPC_TABLES
        if not by_table.get(table, {}).get("count")
    ]
    if zero_dpc:
        risks.append(
            {
                "severity": "high",
                "code": "dpc_tables_empty",
                "message": "DPC tables are empty; DPC must remain review-only.",
            }
        )

    catalog_kinds = {str(entry.get("kind") or "") for entry in catalog}
    missing_kinds = sorted(REQUIRED_CATALOG_KINDS - catalog_kinds)
    if missing_kinds:
        risks.append(
            {
                "severity": "high",
                "code": "catalog_missing_kinds",
                "message": ", ".join(missing_kinds),
            }
        )

    stale_pages = [
        str(entry.get("kind"))
        for entry in catalog
        if "/r06/" in str(entry.get("source_page_url") or "")
    ]
    if stale_pages:
        risks.append(
            {
                "severity": "medium",
                "code": "catalog_uses_archived_r06_pages",
                "message": ", ".join(stale_pages),
            }
        )

    return risks


def render_report(report: dict[str, Any], output_format: str) -> str:
    if output_format == "json":
        return json.dumps(report, ensure_ascii=False, indent=2) + "\n"

    lines = [
        "# Fee Master Coverage Audit",
        "",
        f"- generated_at: `{report['generated_at']}`",
        f"- db: `{report['db_path']}`",
        f"- catalog: `{report['catalog_path']}`",
        f"- risks: `{report['risk_count']}`",
        "",
        "## Table Counts",
        "",
        "| table | label | exists | count |",
        "| --- | --- | ---: | ---: |",
    ]
    for row in report["table_counts"]:
        lines.append(
            f"| `{row['table']}` | {row['label']} | {str(row['exists']).lower()} | {row['count'] if row['count'] is not None else ''} |"
        )

    lines.extend([
        "",
        "## Catalog Entries",
        "",
        "| kind | source_version | published_at | filename | source_page |",
        "| --- | --- | --- | --- | --- |",
    ])
    for entry in report["catalog_entries"]:
        lines.append(
            f"| `{entry.get('kind')}` | {entry.get('source_version') or ''} | {entry.get('published_at') or ''} | `{entry.get('filename') or ''}` | {entry.get('source_page_url') or ''} |"
        )

    lines.extend([
        "",
        "## Risks",
        "",
    ])
    if report["risks"]:
        lines.extend([
            "| severity | code | message |",
            "| --- | --- | --- |",
        ])
        for risk in report["risks"]:
            lines.append(f"| {risk['severity']} | `{risk['code']}` | {risk['message']} |")
    else:
        lines.append("No risk detected.")

    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
