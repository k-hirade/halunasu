from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from typing import Any

from medical_fee_calculation.clause_segmentation import (
    CLAUSE_SEGMENTATION_VERSION,
    split_clinical_evidence_clauses,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = (
    ROOT / "data" / "tests" / "fee-clause-segmentation" / "parity-cases.json"
)


class ClauseSegmentationParityTest(unittest.TestCase):
    def test_cross_language_contract_and_fingerprint(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            fixture["schemaVersion"],
            "fee-clause-segmentation-parity-v1",
        )
        self.assertEqual(
            fixture["clauseSegmentationVersion"],
            CLAUSE_SEGMENTATION_VERSION,
        )

        behavior: list[dict[str, Any]] = []
        for item in fixture["cases"]:
            clauses = [
                _project_clause(clause)
                for clause in split_clinical_evidence_clauses(
                    item["text"],
                    line_id=item["lineId"],
                )
            ]
            self.assertEqual(
                clauses,
                item["expectedClauses"],
                f"clause segmentation mismatch: {item['name']}",
            )
            behavior.append({
                "name": item["name"],
                "lineId": item["lineId"],
                "text": item["text"],
                "clauses": clauses,
            })

        serialized = json.dumps(
            behavior,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        self.assertEqual(
            hashlib.sha256(serialized).hexdigest(),
            fixture["behaviorSha256"],
        )


def _project_clause(clause: dict[str, Any]) -> dict[str, Any]:
    return {
        "clauseId": clause["clauseId"],
        "text": clause["text"],
        "charStart": clause["charStart"],
        "charEnd": clause["charEnd"],
        "sentenceIndex": clause["sentenceIndex"],
        "parentheticalDepth": clause["parentheticalDepth"],
        "separatorAfter": clause["separatorAfter"],
    }


if __name__ == "__main__":
    unittest.main()
