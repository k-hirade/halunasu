#!/usr/bin/env python3
"""診療行為マスターの年齢コードから、算定可能年齢の artifact を生成する。

診療行為マスターは各コードに age_min_code / age_max_code を持つ。数値コードは
「歳」を表し、最小は以上、最大は未満として扱う。数値以外(月齢・日齢・週数等の
特殊コード)は本 artifact では扱わず、判定不能として除外する。判定不能を
「制約なし」と誤って扱わないため、生成物には数値で確定できたものだけを収める。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MASTER = ROOT / "python/data/master/standard-master.sqlite"
OUTPUT_PATH = ROOT / "services/fee-api/src/fee-rule-data/fee-age-constraints-2026.generated.json"
SCHEMA_VERSION = "fee-age-constraint-artifact-v1"
REVISION = "2026-06-01"
EFFECTIVE_FROM = "2026-06-01"
SOURCE_DOCUMENTS = [
    {
        "sourceId": "mhlw-2026-shinryo-master",
        "title": "診療行為マスター（令和8年6月1日適用）",
        "url": "https://shinryohoshu.mhlw.go.jp/shinryohoshu/downloadMenu/",
        "reference": "基本マスター 診療行為 レコード 年齢最小・年齢最大",
    }
]


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def numeric_age(code: str) -> int | None:
    text = str(code or "").strip()
    if not text or not text.isdigit():
        return None
    value = int(text)
    return value if 0 < value <= 120 else None


def build(master_path: Path) -> dict:
    con = sqlite3.connect(master_path)
    rows = con.execute(
        """
        SELECT code, short_name, age_min_code, age_max_code, effective_from, effective_to
        FROM medical_procedures
        WHERE (age_min_code IS NOT NULL AND age_min_code NOT IN ('', '00'))
           OR (age_max_code IS NOT NULL AND age_max_code NOT IN ('', '00'))
        ORDER BY code
        """
    ).fetchall()
    constraints = []
    skipped = 0
    for code, name, min_code, max_code, effective_from, effective_to in rows:
        min_years = numeric_age(min_code)
        max_years = numeric_age(max_code)
        if min_years is None and max_years is None:
            skipped += 1
            continue
        constraints.append(
            {
                "code": str(code),
                "name": str(name or ""),
                # 最小は「以上」、最大は「未満」。
                "minAgeYearsInclusive": min_years,
                "maxAgeYearsExclusive": max_years,
                "effectiveFrom": str(effective_from or ""),
                "effectiveTo": str(effective_to or ""),
            }
        )
    con.close()
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "revision": REVISION,
        "effectiveFrom": EFFECTIVE_FROM,
        "sourceDocuments": SOURCE_DOCUMENTS,
        "constraintCount": len(constraints),
        "unsupportedCodeCount": skipped,
        "constraints": constraints,
    }
    payload["artifactPayloadSha256"] = sha256(canonical_json(payload))
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--master", type=Path, default=DEFAULT_MASTER)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.master.exists():
        print(f"master not found: {args.master}", file=sys.stderr)
        return 2
    artifact = build(args.master)
    rendered = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        current = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.exists() else ""
        if current != rendered:
            print(f"fee age constraint artifact is stale: {OUTPUT_PATH}", file=sys.stderr)
            return 1
        print(f"fee age constraint artifact is current: {OUTPUT_PATH}")
        return 0
    OUTPUT_PATH.write_text(rendered, encoding="utf-8")
    print(f"{OUTPUT_PATH} ({artifact['constraintCount']} constraints, {artifact['unsupportedCodeCount']} unsupported)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
