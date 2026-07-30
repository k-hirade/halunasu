#!/usr/bin/env python3
"""Emit the training-side WX1/WX3 payload contract for parity checks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from scripts.whitebox_training_common import (
    canonicalize_training_case,
    context_classifier_item_for_span,
)


CONTEXT_FIELDS = (
    "text",
    "spanText",
    "charStart",
    "charEnd",
    "previousLine",
    "nextLine",
    "section",
    "encounterSetting",
    "specialty",
    "sourceType",
    "parentLineText",
    "clauseId",
    "clauseText",
    "clauseCharStart",
    "clauseCharEnd",
    "clauseSpanCharStart",
    "clauseSpanCharEnd",
    "inputSemantics",
)


def build_reference(
    dataset_path: str | Path,
    *,
    case_limit: int = 20,
) -> dict[str, Any]:
    payload = json.loads(Path(dataset_path).read_text(encoding="utf-8"))
    cases = [
        case
        for case in payload.get("cases", [])
        if str(case.get("split") or "") in {"train", "development"}
    ][:case_limit]
    contexts = []
    normalization = []
    for case in cases:
        case_id = str(case.get("caseId") or "")
        expected_spans = list(case.get("expectedSpans") or [])
        normalized_text, normalized_spans = canonicalize_training_case(
            str(case.get("clinicalText") or ""),
            expected_spans,
        )
        normalization.append({
            "caseId": case_id,
            "text": normalized_text,
            "spans": [
                {
                    "text": span["text"],
                    "charStart": span["charStart"],
                    "charEnd": span["charEnd"],
                    "category": str(span.get("category") or ""),
                }
                for span in normalized_spans
            ],
        })
        normalized_case = {
            **dict(case),
            "clinicalText": normalized_text,
            "expectedSpans": normalized_spans,
        }
        for span_index, span in enumerate(normalized_spans):
            item = context_classifier_item_for_span(normalized_case, span)
            contexts.append({
                "caseId": case_id,
                "spanIndex": span_index,
                "item": {
                    field: item.get(field)
                    for field in CONTEXT_FIELDS
                },
            })
    return {
        "schemaVersion": "fee-whitebox-input-contract-reference-v1",
        "caseCount": len(cases),
        "contextItemCount": len(contexts),
        "normalization": normalization,
        "contexts": contexts,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/tests/fee-specialty-matrix/training-view.json"),
    )
    parser.add_argument("--case-limit", type=int, default=20)
    args = parser.parse_args(argv)
    if args.case_limit < 1:
        parser.error("--case-limit must be at least 1")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    print(json.dumps(
        build_reference(args.dataset, case_limit=args.case_limit),
        ensure_ascii=False,
        sort_keys=True,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
