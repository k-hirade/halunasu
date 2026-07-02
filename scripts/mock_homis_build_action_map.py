#!/usr/bin/env python3
"""Build a non-inferential mapping table for mock HOMIS gold action names.

The mock HOMIS `action_list` is a gold action list by display name. This script
maps exact master-name matches to codes/points and leaves everything else as
manual_required or comment_only. It intentionally does not guess codes.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path


DEFAULT_INPUT = Path("tmp/dataset_recalculation_diff_diagnosis/20260702_185214_mock_homis/direct_export/standard_files/gold_actions.csv")
DEFAULT_MASTER = Path("python/data/master/standard-master.sqlite")
DEFAULT_OUTPUT = Path("tmp/dataset_recalculation_diff_diagnosis/20260702_185214_mock_homis/homis_action_master_map.csv")


DATE_RE = re.compile(r"令和\s*[0-9０-９]+\s*年\s*[0-9０-９]+\s*月\s*[0-9０-９]+\s*日")


FIELDS = [
    "action_key",
    "sample_action_name",
    "normalized_action_name",
    "occurrence_count",
    "match_status",
    "master_kind",
    "code",
    "master_name",
    "points",
    "unit_amount_yen",
    "candidate_codes",
    "note",
]


def normalize_action_name(value: str) -> str:
    text = str(value or "").strip()
    text = DATE_RE.sub("{date}", text)
    text = re.sub(r"単一建物診療患者数（施医総管）；\d+", "単一建物診療患者数（施医総管）；{count}", text)
    text = re.sub(r"同一患家\s*[0-9０-９日、,・\\s]+", "同一患家 {dates}", text)
    return text


def action_key(value: str) -> str:
    return re.sub(r"\s+", "", normalize_action_name(value))


def is_comment_only(normalized: str) -> bool:
    return (
        "{date}" in normalized
        or "{count}" in normalized
        or "{dates}" in normalized
        or normalized.startswith("往診交通費")
    )


def exact_master_matches(conn: sqlite3.Connection, name: str) -> list[dict]:
    queries = [
        ("procedure", "medical_procedures", "short_name", "points"),
        ("procedure", "medical_procedures", "base_name", "points"),
        ("material", "specific_materials", "name", "unit_amount_yen"),
        ("material", "specific_materials", "base_name", "unit_amount_yen"),
        ("drug", "drugs", "name", "unit_amount_yen"),
        ("drug", "drugs", "base_name", "unit_amount_yen"),
        ("comment", "comments", "comment_text", None),
    ]
    matches = []
    seen = set()
    for kind, table, column, value_column in queries:
        select_value = f", {value_column} AS value_amount" if value_column else ""
        for row in conn.execute(
            f"SELECT code, {column} AS master_name{select_value} FROM {table} WHERE {column} = ?",
            (name,),
        ):
            key = (kind, row["code"], row["master_name"])
            if key in seen:
                continue
            seen.add(key)
            matches.append({
                "master_kind": kind,
                "code": str(row["code"] or ""),
                "master_name": str(row["master_name"] or ""),
                "points": str(row["value_amount"]) if kind == "procedure" and value_column else "",
                "unit_amount_yen": str(row["value_amount"]) if kind in {"material", "drug"} and value_column else "",
            })
    return matches


def build_rows(input_path: Path, master_path: Path) -> tuple[list[dict], dict]:
    with input_path.open(encoding="utf-8", newline="") as f:
        actions = [row["action_name"] for row in csv.DictReader(f) if row.get("action_name")]

    samples = {}
    counts = Counter()
    for action in actions:
        key = action_key(action)
        counts[key] += 1
        samples.setdefault(key, action)

    conn = sqlite3.connect(master_path)
    conn.row_factory = sqlite3.Row
    rows = []
    try:
        for key in sorted(counts):
            sample = samples[key]
            normalized = normalize_action_name(sample)
            row = {
                "action_key": key,
                "sample_action_name": sample,
                "normalized_action_name": normalized,
                "occurrence_count": counts[key],
                "match_status": "",
                "master_kind": "",
                "code": "",
                "master_name": "",
                "points": "",
                "unit_amount_yen": "",
                "candidate_codes": "",
                "note": "",
            }
            if is_comment_only(normalized):
                row.update({
                    "match_status": "comment_or_nonclaim",
                    "note": "Display-only comment/free-text/non-claim item. No code or points are present in mock HOMIS source.",
                })
                rows.append(row)
                continue

            matches = exact_master_matches(conn, normalized)
            if len(matches) == 1:
                row.update({
                    **matches[0],
                    "match_status": "exact_master_name",
                    "note": "Exact name match against current local master. No semantic inference used.",
                })
            elif len(matches) > 1:
                row.update({
                    "match_status": "ambiguous_exact_master_name",
                    "candidate_codes": ";".join(f"{m['master_kind']}:{m['code']}:{m['master_name']}" for m in matches),
                    "note": "Multiple exact master-name matches. Manual selection required.",
                })
            else:
                row.update({
                    "match_status": "manual_required",
                    "note": "No exact current-master name match. Code was not inferred.",
                })
            rows.append(row)
    finally:
        conn.close()

    summary = {
        "input": str(input_path),
        "master": str(master_path),
        "actionRowCount": len(actions),
        "uniqueActionKeyCount": len(rows),
        "statusCounts": dict(Counter(row["match_status"] for row in rows)),
    }
    return rows, summary


def main() -> None:
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_INPUT
    master_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MASTER
    output_path = Path(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_OUTPUT
    rows, summary = build_rows(input_path, master_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    summary_path = output_path.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
