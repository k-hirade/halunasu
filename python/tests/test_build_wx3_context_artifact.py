from __future__ import annotations

import unittest

from medical_fee_calculation.clinical_axes import clinical_axis_values
from medical_fee_calculation.whitebox_context import (
    CLAUSE_AWARE_INPUT_CONTRACT_VERSION,
    LEGACY_INPUT_CONTRACT_VERSION,
    STRUCTURED_INPUT_CONTRACT_VERSION,
)
from scripts.whitebox_training_common import WhiteboxTrainingError
from scripts.build_wx3_context_artifact import (
    DETERMINISM_REPEAT_COUNT,
    build_context_examples,
    class_weight_values,
    parse_args,
    select_abstain_threshold,
)


class BuildWx3ContextArtifactTest(unittest.TestCase):
    def test_artifact_gate_requires_one_hundred_identical_runs(self) -> None:
        self.assertEqual(DETERMINISM_REPEAT_COUNT, 100)

    def test_context_examples_default_to_safety_calibrated_legacy_contract(self) -> None:
        text = "O）創傷処置を実施した。"
        start = text.index("創傷処置")
        examples = build_context_examples([{
            "caseId": "case-1",
            "specialty": "surgery",
            "encounterSetting": "outpatient",
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
        self.assertNotIn("[SETTING]", examples[0].text)
        self.assertNotIn("[SPECIALTY]", examples[0].text)

    def test_context_examples_support_explicit_structured_contract(self) -> None:
        text = "O）創傷処置を実施した。"
        start = text.index("創傷処置")
        examples = build_context_examples([{
            "caseId": "case-1",
            "specialty": "surgery",
            "encounterSetting": "outpatient",
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
        }], clinical_axis_values(), input_contract_version=STRUCTURED_INPUT_CONTRACT_VERSION)
        self.assertEqual(examples[0].labels["actionStatus"], "performed")
        self.assertIn("[SETTING]outpatient[/SETTING]", examples[0].text)
        self.assertIn("[SPECIALTY]surgery[/SPECIALTY]", examples[0].text)
        self.assertIn("[SECTION]O[/SECTION]", examples[0].text)

    def test_context_examples_support_clause_aware_contract(self) -> None:
        text = "O）前回CTを確認し、本日は採血を実施。次回MRIを予定。"
        start = text.index("採血")
        examples = build_context_examples([{
            "caseId": "case-clause",
            "specialty": "internal_medicine",
            "encounterSetting": "outpatient",
            "clinicalText": text,
            "expectedSpans": [{
                "text": "採血",
                "charStart": start,
                "charEnd": start + 2,
                "actionStatus": "performed",
                "temporalRelation": "current_visit",
                "sourceOrigin": "own_clinic_record",
                "providerOwnership": "own_clinic",
                "standingStatus": "none",
            }],
        }], clinical_axis_values(), input_contract_version=CLAUSE_AWARE_INPUT_CONTRACT_VERSION)
        self.assertIn(f"[LINE]{text}[/LINE]", examples[0].text)
        self.assertIn(
            "[CLAUSE]本日は[SPAN]採血[/SPAN]を実施。[/CLAUSE]",
            examples[0].text,
        )

    def test_cli_defaults_to_legacy_contract_and_allows_explicit_versions(self) -> None:
        required = [
            "--base-model", "model",
            "--model-revision", "a" * 40,
            "--license", "Apache-2.0",
            "--license-source-url", "https://example.com/license",
            "--license-verified-at", "2026-07-25",
            "--artifact-version", "wx3-test",
        ]
        self.assertEqual(
            parse_args(required).input_contract_version,
            LEGACY_INPUT_CONTRACT_VERSION,
        )
        self.assertEqual(
            parse_args([*required, "--input-contract-version", "2"]).input_contract_version,
            STRUCTURED_INPUT_CONTRACT_VERSION,
        )
        self.assertEqual(
            parse_args([*required, "--input-contract-version", "3"]).input_contract_version,
            CLAUSE_AWARE_INPUT_CONTRACT_VERSION,
        )

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
        self.assertLess(threshold, 1.0)

    def test_threshold_uses_exact_confidence_boundary(self) -> None:
        threshold = select_abstain_threshold(
            axis="actionStatus",
            truths=["not_performed", "performed", "performed"],
            predictions=["performed", "performed", "performed"],
            confidences=[0.991, 0.992, 0.999],
            max_risk=0.0,
            max_dangerous_false_positive_rate=0.0,
            minimum_covered_count=2,
        )
        self.assertGreater(threshold, 0.991)
        self.assertLessEqual(threshold, 0.992)

    def test_threshold_rejects_zero_coverage_solution(self) -> None:
        with self.assertRaises(WhiteboxTrainingError):
            select_abstain_threshold(
                axis="actionStatus",
                truths=["not_performed", "performed"],
                predictions=["performed", "not_performed"],
                confidences=[0.99, 0.98],
                max_risk=0.0,
                max_dangerous_false_positive_rate=0.0,
                minimum_covered_count=1,
            )

    def test_sqrt_inverse_weights_raise_minority_class_weight(self) -> None:
        weights = class_weight_values(
            [0, 0, 0, 0, 1],
            class_count=2,
            strategy="sqrt_inverse",
        )
        self.assertGreater(weights[1], weights[0])
        self.assertAlmostEqual(sum(weights), 2.0)


if __name__ == "__main__":
    unittest.main()
