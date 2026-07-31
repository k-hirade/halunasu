#!/usr/bin/env python3
"""Build the sidecar management-fee selection artifact from the fee master."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from medical_fee_calculation.checks_api import standing_fee_families


ROOT = Path(__file__).resolve().parents[1]


def canonical_json(value: Any) -> str:
    return json.dumps(canonical_value(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_value(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_value(item) for key, item in value.items()}
    return value


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(ROOT / "data/fee-rules/source/sidecar-selection-axes-2026.json"))
    parser.add_argument("--master-db", default=str(ROOT / "python/data/master/standard-master.sqlite"))
    parser.add_argument("--output", default=str(ROOT / "services/fee-api/src/fee-rule-data/sidecar-selection-axes-2026.generated.json"))
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).replace("〜", "~").replace("～", "~")


def parse_patient_range(name: str) -> dict[str, int | None]:
    for pattern, minimum, maximum in (
        (r"50人~", 50, None),
        (r"20~49人", 20, 49),
        (r"10~19人", 10, 19),
        (r"2~9人", 2, 9),
        (r"1人", 1, 1),
    ):
        if re.search(pattern, name):
            return {"min": minimum, "max": maximum}
    raise ValueError(f"patient count axis is missing: {name}")


def parse_variant(family: dict[str, Any], variant: dict[str, Any]) -> dict[str, Any]:
    name = normalized(variant.get("name", ""))
    if "機能強化在支診等" in name:
        facility_class = "enhanced_support"
    elif "在支診等以外" in name:
        facility_class = "outside_support"
    elif "在支診等" in name:
        facility_class = "support"
    else:
        raise ValueError(f"facility class axis is missing: {name}")
    bed = True if "床有" in name else False if "床無" in name else None
    visits = "one" if "月1回" in name else "two_or_more" if "月2回" in name else None
    if visits is None:
        raise ValueError(f"monthly visit axis is missing: {name}")
    axes = {
        "facilityClass": facility_class,
        "bed": bed,
        "patientCount": parse_patient_range(name),
        "monthlyVisits": visits,
        "telemedicine": "通信機" in name,
        "specialDisease": "難病等" in name,
        "reduced": "減" in name,
        "specialProvision": "注8注14" in name,
    }
    labels = {
        "enhanced_support": "機能強化型在支診等",
        "support": "在支診等",
        "outside_support": "在支診等以外",
    }
    count = axes["patientCount"]
    count_label = f"{count['min']}人" if count["min"] == count["max"] else (
        f"{count['min']}人以上" if count["max"] is None else f"{count['min']}〜{count['max']}人"
    )
    qualifier = [labels[facility_class]]
    if bed is not None:
        qualifier.append("病床あり" if bed else "病床なし")
    qualifier.extend([
        "月1回" if visits == "one" else "月2回以上",
        count_label,
        "情報通信機器" if axes["telemedicine"] else "対面",
        "難病等" if axes["specialDisease"] else "一般",
    ])
    if axes["reduced"]:
        qualifier.append("減算")
    if axes["specialProvision"]:
        qualifier.append("注8・注14")
    return {
        "code": str(variant.get("code") or ""),
        "familyId": str(family.get("familyId") or ""),
        "familyName": str(family.get("name") or ""),
        "points": float(variant.get("points") or 0),
        "qualifierLabel": "・".join(qualifier),
        "facilityStandardCodes": sorted(str(value) for value in variant.get("facilityStandardCodes") or []),
        "axes": axes,
    }


def build(source: dict[str, Any], master_db: str) -> dict[str, Any]:
    catalog = standing_fee_families({
        "db_path": master_db,
        "service_date": source["effectiveFrom"],
        "additional_family_selectors": source["familySelectors"],
    })
    names = {entry["name"] for entry in source["familySelectors"]}
    families = [family for family in catalog.get("families") or [] if family.get("name") in names]
    if len(families) != len(names):
        raise ValueError(f"expected {len(names)} families, got {len(families)}")
    options = sorted(
        (parse_variant(family, variant) for family in families for variant in family.get("variants") or []),
        key=lambda option: option["code"],
    )
    if len(options) != len({option["code"] for option in options}):
        raise ValueError("selection artifact contains duplicate procedure codes")
    payload = {
        "schemaVersion": "fee-sidecar-selection-axes-v1",
        "revision": source["revision"],
        "effectiveFrom": source["effectiveFrom"],
        "sources": source["sources"],
        "sourceDefinitionSha256": sha256_json(source),
        "masterSource": catalog.get("source"),
        "facilityClassRules": source["facilityClassRules"],
        "bedRules": source["bedRules"],
        "axisQuestions": source["axisQuestions"],
        "options": options,
    }
    payload["artifactPayloadSha256"] = sha256_json(payload)
    return payload


def main() -> int:
    args = parse_args()
    source = json.loads(Path(args.source).read_text(encoding="utf-8"))
    output = Path(args.output)
    generated = json.dumps(build(source, args.master_db), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not output.exists() or output.read_text(encoding="utf-8") != generated:
            raise SystemExit(f"generated artifact is stale: {output}")
        print(f"sidecar selection artifact is current: {output}")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(generated, encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
