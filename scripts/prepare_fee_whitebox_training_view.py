#!/usr/bin/env python3
"""Create a label-isolated train/development view for WX1/WX3 builders."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

from medical_fee_calculation.whitebox_artifacts import sha256_file


DEFAULT_SOURCE = Path("data/tests/fee-specialty-matrix/cases.json")
DEFAULT_OUTPUT = Path("data/tests/fee-specialty-matrix/training-view.json")


def build_training_view(source_path: Path) -> dict[str, Any]:
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
    return {
        "schemaVersion": "fee-whitebox-training-view-v1",
        "sourceDatasetSha256": sha256_file(source_path),
        "withheldHoldoutCaseIds": sorted(withheld),
        "cases": selected,
    }


def serialized_training_view(source_path: Path) -> str:
    return json.dumps(
        build_training_view(source_path),
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
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    content = serialized_training_view(source)
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
