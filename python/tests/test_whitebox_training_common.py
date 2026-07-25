from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.whitebox_training_common import (
    WhiteboxTrainingError,
    assert_no_counterexample_training_leakage,
    build_license_record,
    load_training_partitions,
    split_text_lines,
    spans_for_line,
    validate_model_revision,
)


def _case(case_id: str, split: str, text: str = "O）創傷処置を実施。") -> dict:
    start = text.index("創傷処置")
    return {
        "caseId": case_id,
        "specialty": "surgery",
        "encounterSetting": "outpatient",
        "split": split,
        "synthetic": True,
        "annotationStatus": "reviewed",
        "clinicalText": text,
        "expectedSpans": [{
            "text": "創傷処置",
            "charStart": start,
            "charEnd": start + 4,
            "category": "procedure",
            "actionStatus": "performed",
            "temporalRelation": "current_visit",
            "sourceOrigin": "own_clinic_record",
            "providerOwnership": "own_clinic",
            "standingStatus": "none",
        }],
    }


class WhiteboxTrainingCommonTest(unittest.TestCase):
    def test_training_partitions_do_not_return_holdout_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cases.json"
            path.write_text(json.dumps({
                "schemaVersion": "fee-whitebox-training-view-v1",
                "sourceDatasetSha256": "a" * 64,
                "withheldHoldoutCaseIds": ["holdout-1"],
                "cases": [
                    _case("train-1", "train"),
                    _case("development-1", "development"),
                ]
            }), encoding="utf-8")
            partitions = load_training_partitions(path)
            self.assertEqual([item["caseId"] for item in partitions.train], ["train-1"])
            self.assertEqual(
                [item["caseId"] for item in partitions.development],
                ["development-1"],
            )
            self.assertEqual(partitions.holdout_case_ids, ("holdout-1",))
            self.assertNotIn("SECRET", json.dumps(partitions.train))

    def test_builder_rejects_a_source_matrix_containing_holdout_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cases.json"
            path.write_text(json.dumps({
                "schemaVersion": "fee-specialty-matrix-cases-v1",
                "cases": [
                    _case("train-1", "train"),
                    _case("development-1", "development"),
                    _case("holdout-1", "holdout"),
                ],
            }), encoding="utf-8")
            with self.assertRaisesRegex(WhiteboxTrainingError, "training-view"):
                load_training_partitions(path)

    def test_training_view_requires_a_valid_withheld_holdout_ledger(self) -> None:
        base_payload = {
            "schemaVersion": "fee-whitebox-training-view-v1",
            "sourceDatasetSha256": "a" * 64,
            "withheldHoldoutCaseIds": ["holdout-1"],
            "cases": [
                _case("train-1", "train"),
                _case("development-1", "development"),
            ],
        }
        invalid_payloads = (
            ({**base_payload, "withheldHoldoutCaseIds": []}, "must not be empty"),
            (
                {
                    **base_payload,
                    "withheldHoldoutCaseIds": ["holdout-1", "holdout-1"],
                },
                "contains duplicates",
            ),
            (
                {**base_payload, "sourceDatasetSha256": "not-a-digest"},
                "SHA-256 digest",
            ),
            (
                {**base_payload, "withheldHoldoutCaseIds": ["train-1"]},
                "leaked into the training view",
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cases.json"
            for payload, message in invalid_payloads:
                with self.subTest(message=message):
                    path.write_text(json.dumps(payload), encoding="utf-8")
                    with self.assertRaisesRegex(WhiteboxTrainingError, message):
                        load_training_partitions(path)

    def test_counterexample_text_is_rejected_from_train(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "counterexamples.json"
            path.write_text(json.dumps({
                "cases": [{"clinicalText": "O）創傷処置を実施。"}]
            }), encoding="utf-8")
            with self.assertRaisesRegex(WhiteboxTrainingError, "leaked"):
                assert_no_counterexample_training_leakage(
                    [_case("train-1", "train")],
                    path,
                )

    def test_license_and_immutable_revision_are_required(self) -> None:
        with self.assertRaises(WhiteboxTrainingError):
            build_license_record(
                model_id="model",
                license_name="",
                verified_at="2026-07-25",
                source_url="https://example.com/license",
            )
        with self.assertRaisesRegex(WhiteboxTrainingError, "immutable"):
            validate_model_revision("main")
        self.assertEqual(validate_model_revision("abcdef1234567"), "abcdef1234567")

    def test_line_span_offsets_are_rebased(self) -> None:
        case = _case("train-1", "train", "S）安定。\nO）創傷処置を実施。")
        line = split_text_lines(case["clinicalText"])[1]
        [span] = spans_for_line(case, line)
        self.assertEqual(line.text[span["charStart"]:span["charEnd"]], "創傷処置")


if __name__ == "__main__":
    unittest.main()
