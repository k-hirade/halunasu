from __future__ import annotations

import unittest

from medical_fee_calculation.clinical_axes import clinical_axis_values
from scripts.build_wx3_context_artifact import (
    DETERMINISM_REPEAT_COUNT,
    build_context_examples,
    select_abstain_threshold,
)


class BuildWx3ContextArtifactTest(unittest.TestCase):
    def test_artifact_gate_requires_one_hundred_identical_runs(self) -> None:
        self.assertEqual(DETERMINISM_REPEAT_COUNT, 100)

    def test_context_examples_preserve_all_axis_labels(self) -> None:
        text = "O）創傷処置を実施した。"
        start = text.index("創傷処置")
        examples = build_context_examples([{
            "caseId": "case-1",
            "clinicalText": text,
            "expectedSpans": [{
                "text": "創傷処置",
                "charStart": start,
                "charEnd": start + 4,
                "actionStatus": "performed",
                "temporalRelation": "current_visit",
                "sourceOrigin": "own_clinic_record",
                "providerOwnership": "own_clinic",
                "standingStatus": "none",
            }],
        }], clinical_axis_values())
        self.assertEqual(examples[0].labels["actionStatus"], "performed")
        self.assertIn("[SPAN]創傷処置[/SPAN]", examples[0].text)

    def test_threshold_abstains_until_risk_is_acceptable(self) -> None:
        threshold = select_abstain_threshold(
            axis="actionStatus",
            truths=["not_performed", "performed"],
            predictions=["performed", "performed"],
            confidences=[0.95, 0.99],
            max_risk=0.0,
            max_dangerous_false_positive_rate=0.0,
        )
        self.assertGreater(threshold, 0.95)


if __name__ == "__main__":
    unittest.main()
