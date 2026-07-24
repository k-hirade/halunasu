from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.clinical_axes import (
    AXIS_NAMES,
    ClinicalAxesContractError,
    clinical_axis_values,
    load_clinical_axes_schema,
    validate_axis_values,
    validate_classifier_result,
)


class ClinicalAxesTest(unittest.TestCase):
    def test_loads_generated_runtime_contract(self) -> None:
        schema = load_clinical_axes_schema()
        values = clinical_axis_values()

        self.assertEqual(tuple(schema["required"]), AXIS_NAMES)
        self.assertIn("performed", values["actionStatus"])
        self.assertIn("same_day_but_unknown", values["temporalRelation"])
        self.assertIn("none", values["standingStatus"])

        schema["properties"]["actionStatus"]["enum"].append("mutated")
        self.assertNotIn(
            "mutated",
            load_clinical_axes_schema()["properties"]["actionStatus"]["enum"],
        )

    def test_validates_complete_axis_values(self) -> None:
        payload = {
            "actionStatus": "performed",
            "temporalRelation": "current_visit",
            "sourceOrigin": "own_clinic_record",
            "providerOwnership": "own_clinic",
            "standingStatus": "none",
        }
        self.assertEqual(validate_axis_values(payload), payload)

    def test_rejects_missing_or_unknown_axis_values(self) -> None:
        with self.assertRaisesRegex(ClinicalAxesContractError, "missing standingStatus"):
            validate_axis_values(
                {
                    "actionStatus": "performed",
                    "temporalRelation": "current_visit",
                    "sourceOrigin": "own_clinic_record",
                    "providerOwnership": "own_clinic",
                }
            )
        with self.assertRaisesRegex(ClinicalAxesContractError, "actionStatus must be"):
            validate_axis_values(
                {
                    "actionStatus": "invented",
                    "temporalRelation": "current_visit",
                    "sourceOrigin": "own_clinic_record",
                    "providerOwnership": "own_clinic",
                    "standingStatus": "none",
                }
            )

    def test_validates_classifier_triplets(self) -> None:
        payload = {
            axis: {
                "value": values[0],
                "confidence": 0.75,
                "abstained": False,
            }
            for axis, values in clinical_axis_values().items()
        }
        self.assertEqual(validate_classifier_result(payload), payload)

        payload["actionStatus"]["confidence"] = float("nan")
        with self.assertRaisesRegex(ClinicalAxesContractError, "finite number"):
            validate_classifier_result(payload)

    def test_rejects_malformed_generated_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            schema_path = Path(tmp) / "axes.json"
            schema_path.write_text(json.dumps({"properties": {}}), encoding="utf-8")
            with self.assertRaisesRegex(ClinicalAxesContractError, "invalid enum"):
                load_clinical_axes_schema(schema_path)


if __name__ == "__main__":
    unittest.main()
