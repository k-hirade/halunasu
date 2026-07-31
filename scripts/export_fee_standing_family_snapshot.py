#!/usr/bin/env python3
"""Export the real-master families referenced by standing structured triggers."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from medical_fee_calculation.checks_api import standing_fee_families


REPO_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--master-db",
        default=str(REPO_ROOT / "python/data/master/standard-master.sqlite"),
    )
    parser.add_argument(
        "--trigger-artifact",
        default=str(
            REPO_ROOT
            / "services/fee-api/src/fee-rule-data/"
            "standing-structured-triggers-2026.generated.json"
        ),
    )
    parser.add_argument("--service-date", default="2026-06-01")
    parser.add_argument(
        "--output",
        default=str(
            REPO_ROOT
            / "data/tests/fee-standing-family-catalog-snapshot-2026-06.json"
        ),
    )
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def selectors_from_artifact(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for trigger in artifact.get("triggers", []):
        values = [
            trigger.get("familySelector"),
            *(trigger.get("parentFamilySelectors") or []),
        ]
        for selector in values:
            if not isinstance(selector, dict):
                continue
            key = canonical_json(selector)
            if key not in seen:
                seen.add(key)
                result.append(selector)
    return result


def family_matches_selector(family: dict[str, Any], selector: dict[str, Any]) -> bool:
    if str(family.get("name") or "") != str(selector.get("name") or ""):
        return False
    hierarchy = family.get("hierarchy") or {}
    expected = selector.get("hierarchy") or {}
    return all(
        str(hierarchy.get(field) or "") == str(expected.get(field) or "")
        for field in ("chapter", "part", "alphaPart", "section", "branch")
    )


def snapshot(args: argparse.Namespace) -> dict[str, Any]:
    artifact = json.loads(Path(args.trigger_artifact).read_text(encoding="utf-8"))
    selectors = selectors_from_artifact(artifact)
    catalog = standing_fee_families(
        {
            "db_path": args.master_db,
            "service_date": args.service_date,
            "additional_family_selectors": selectors,
        }
    )
    families = catalog.get("families") or []
    selected: dict[str, dict[str, Any]] = {}
    selector_results: list[dict[str, Any]] = []
    for selector in selectors:
        matches = [
            family
            for family in families
            if family_matches_selector(family, selector)
        ]
        selector_results.append(
            {
                "selector": selector,
                "matchCount": len(matches),
                "familyIds": sorted(
                    str(family.get("familyId") or "") for family in matches
                ),
            }
        )
        for family in matches:
            family_id = str(family.get("familyId") or "")
            selected[family_id] = {
                "familyId": family_id,
                "name": str(family.get("name") or ""),
                "hierarchy": family.get("hierarchy") or {},
                "aliases": sorted(
                    str(alias)
                    for alias in family.get("aliases") or []
                    if str(alias).strip()
                ),
            }
    source = catalog.get("source") or {}
    return {
        "schemaVersion": "fee-standing-family-catalog-snapshot-v1",
        "serviceDate": args.service_date,
        "triggerArtifactSha256": artifact.get("artifactPayloadSha256"),
        "source": {
            "procedureVersion": source.get("procedureVersion"),
            "procedureChecksum": source.get("procedureChecksum"),
            "frequencyVersion": source.get("frequencyVersion"),
            "frequencyChecksum": source.get("frequencyChecksum"),
        },
        "catalogFamilyCount": len(families),
        "selectorCount": len(selectors),
        "resolvedSelectorCount": sum(
            1 for result in selector_results if result["matchCount"] == 1
        ),
        "selectorResults": selector_results,
        "families": sorted(
            selected.values(),
            key=lambda family: (
                family["hierarchy"].get("alphaPart", ""),
                family["hierarchy"].get("section", ""),
                family["hierarchy"].get("branch", ""),
                family["name"],
            ),
        ),
    }


def main() -> int:
    args = parse_args()
    payload = snapshot(args)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.stdout:
        print(text, end="")
    else:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
