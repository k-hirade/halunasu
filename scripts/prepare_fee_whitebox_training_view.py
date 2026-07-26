#!/usr/bin/env python3
"""Create a label-isolated train/development view for WX1/WX3 builders."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import sha256_file


DEFAULT_SOURCE = Path("data/tests/fee-specialty-matrix/cases.json")
DEFAULT_OUTPUT = Path("data/tests/fee-specialty-matrix/training-view.json")


def build_training_view(
    source_path: Path,
    augmentation_paths: Sequence[Path] = (),
) -> dict[str, Any]:
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping) or not isinstance(payload.get("cases"), list):
        raise ValueError("source specialty matrix must contain a cases array")
    selected = []
    withheld = []
    seen_case_ids: set[str] = set()
    for case in payload["cases"]:
        if not isinstance(case, Mapping):
            raise ValueError("source specialty matrix case must be an object")
        split = str(case.get("split") or "")
        case_id = str(case.get("caseId") or "").strip()
        if not case_id:
            raise ValueError("source caseId is required")
        if case_id in seen_case_ids:
            raise ValueError(f"source caseId is duplicated: {case_id}")
        seen_case_ids.add(case_id)
        if split in {"train", "development"}:
            selected.append(dict(case))
        elif split == "holdout":
            withheld.append(case_id)
        else:
            raise ValueError(f"unsupported source split: {split!r}")
    if not selected or not withheld:
        raise ValueError("source must contain train/development and withheld holdout cases")
    augmentation_sources = []
    for raw_path in augmentation_paths:
        augmentation_path = raw_path.expanduser().resolve()
        augmentation = json.loads(augmentation_path.read_text(encoding="utf-8"))
        if (
            not isinstance(augmentation, Mapping)
            or not isinstance(augmentation.get("cases"), list)
        ):
            raise ValueError(
                f"augmentation must contain a cases array: {augmentation_path}"
            )
        if (
            augmentation.get("synthetic") is not True
            or augmentation.get("notGold") is not True
            or augmentation.get("trainingOnly") is not True
        ):
            raise ValueError(
                "augmentation must declare synthetic=true, notGold=true, "
                f"and trainingOnly=true: {augmentation_path}"
            )
        for case in augmentation["cases"]:
            if not isinstance(case, Mapping):
                raise ValueError("augmentation case must be an object")
            case_id = str(case.get("caseId") or "").strip()
            if not case_id:
                raise ValueError("augmentation caseId is required")
            if case_id in seen_case_ids:
                raise ValueError(f"source caseId is duplicated: {case_id}")
            seen_case_ids.add(case_id)
            split = str(case.get("split") or "")
            if split not in {"train", "development"}:
                raise ValueError(
                    f"augmentation case {case_id} must use train/development split"
                )
            if (
                case.get("synthetic") is not True
                or case.get("annotationStatus") != "reviewed"
                or case.get("generationProvenance", {}).get("source")
                != "primary_generator"
            ):
                raise ValueError(
                    f"augmentation case {case_id} is not a reviewed synthetic "
                    "primary-generator case"
                )
            if not isinstance(case.get("expectedSpans"), list) or not case["expectedSpans"]:
                raise ValueError(
                    f"augmentation case {case_id} must contain expectedSpans"
                )
            selected.append(dict(case))
        augmentation_sources.append({
            "datasetId": str(augmentation.get("datasetId") or ""),
            "sha256": sha256_file(augmentation_path),
            "caseCount": len(augmentation["cases"]),
        })
    return {
        "schemaVersion": "fee-whitebox-training-view-v1",
        "sourceDatasetSha256": sha256_file(source_path),
        "augmentationSources": augmentation_sources,
        "withheldHoldoutCaseIds": sorted(withheld),
        "cases": selected,
    }


def serialized_training_view(
    source_path: Path,
    augmentation_paths: Sequence[Path] = (),
) -> str:
    return json.dumps(
        build_training_view(source_path, augmentation_paths),
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--augmentation",
        type=Path,
        action="append",
        default=[],
        help="training-only non-gold corpus; may be repeated",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    augmentations = [path.expanduser().resolve() for path in args.augmentation]
    content = serialized_training_view(source, augmentations)
    if args.check:
        if not output.is_file() or output.read_text(encoding="utf-8") != content:
            print(f"whitebox training view is missing or stale: {output}")
            return 1
        print(f"whitebox training view is current: {output}")
        return 0
    write_atomic(output, content)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
