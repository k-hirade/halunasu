#!/usr/bin/env python3
"""Build the versioned C002/C002-2 special-disease resolver artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/fee-rules/source/c002-special-disease-2026.json"
DEFAULT_OUTPUT = ROOT / "services/fee-api/src/fee-rule-data/c002-special-disease-2026.generated.json"


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def build(source: dict) -> dict:
    if source.get("schemaVersion") != "fee-c002-special-disease-source-v1":
        raise SystemExit("unsupported C002 special-disease source schema")
    diseases = source.get("designatedDiseases")
    if not isinstance(diseases, list) or len(diseases) != 348:
        raise SystemExit("the complete R8 designated-disease list (348 entries) is required")
    numbers = [entry.get("noticeNumber") for entry in diseases]
    if numbers != list(range(1, 349)):
        raise SystemExit("designated-disease notice numbers must be contiguous from 1 through 348")
    if any(not str(entry.get("name") or "").strip() for entry in diseases):
        raise SystemExit("designated-disease names must not be empty")

    payload = {
        "schemaVersion": "fee-c002-special-disease-v1",
        "revision": source["revision"],
        "effectiveFrom": source["effectiveFrom"],
        "sources": source["sources"],
        "sourceDefinitionSha256": sha256(canonical_json(source)),
        "directDiseaseRules": source["directDiseaseRules"],
        "stateRules": source["stateRules"],
        "designatedDiseases": diseases,
    }
    return {**payload, "artifactPayloadSha256": sha256(canonical_json(payload))}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = json.loads(args.source.read_text())
    rendered = json.dumps(build(source), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text() != rendered:
            raise SystemExit(f"C002 special-disease artifact is stale: {args.output}")
        print("C002 special-disease artifact check passed")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
