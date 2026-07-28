from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.whitebox_training_common import (
    WhiteboxTrainingError,
    assert_no_counterexample_training_leakage,
    build_license_record,
    canonicalize_training_case,
    context_classifier_item_for_span,
    load_training_partitions,
    split_context_clauses,
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

    def test_training_text_uses_runtime_normalization_and_remaps_offsets(self) -> None:
        text = " \r\nＯ）ＣＴ撮影を実施。 \r\n"
        start = text.index("ＣＴ")
        normalized_text, [span] = canonicalize_training_case(
            text,
            [{
                "text": "ＣＴ",
                "charStart": start,
                "charEnd": start + 2,
                "category": "imaging",
            }],
        )

        self.assertEqual(normalized_text, "O）CT撮影を実施。")
        self.assertEqual(span["text"], "CT")
        self.assertEqual(
            normalized_text[span["charStart"]:span["charEnd"]],
            "CT",
        )

    def test_context_item_keeps_line_scope_and_governing_clause(self) -> None:
        text = "S）発熱は軽快。\nO）前回CTを確認し、本日は採血を実施。次回MRIを予定。"
        start = text.index("採血")
        item = context_classifier_item_for_span({
            "caseId": "context-contract",
            "specialty": "internal_medicine",
            "encounterSetting": "outpatient",
            "clinicalText": text,
        }, {
            "text": "採血",
            "charStart": start,
            "charEnd": start + 2,
        })

        self.assertEqual(
            item["text"],
            "O）前回CTを確認し、本日は採血を実施。次回MRIを予定。",
        )
        self.assertEqual(item["text"][item["charStart"]:item["charEnd"]], "採血")
        self.assertEqual(item["clauseText"], "本日は採血を実施。")
        self.assertEqual(
            item["clauseText"][
                item["clauseSpanCharStart"]:item["clauseSpanCharEnd"]
            ],
            "採血",
        )
        self.assertEqual(item["previousLine"], "S）発熱は軽快。")
        self.assertEqual(item["inputSemantics"]["offsetUnit"], "unicode_code_point")

    def test_context_clause_split_matches_mixed_temporal_sentence(self) -> None:
        self.assertEqual(
            [item["text"] for item in split_context_clauses(
                "前回CTを確認し、本日は採血を実施。次回MRIを予定。"
            )],
            ["前回CTを確認し、", "本日は採血を実施。", "次回MRIを予定。"],
        )

    def test_context_input_regressions_freeze_safe_semantic_outcomes(self) -> None:
        root = Path(__file__).resolve().parents[2]
        matrix = json.loads(
            (root / "data/tests/fee-specialty-matrix/cases.json").read_text(
                encoding="utf-8"
            )
        )
        regressions = json.loads(
            (
                root
                / "data/tests/fee-specialty-matrix/context-input-regressions.json"
            ).read_text(encoding="utf-8")
        )
        by_case = {item["caseId"]: item for item in matrix["cases"]}
        counts = {
            "billable_inclusion": 0,
            "safe_exclusion": 0,
            "must_not_safe_exclude": 0,
        }
        for regression in regressions["cases"]:
            span = by_case[regression["caseId"]]["expectedSpans"][
                regression["spanIndex"]
            ]
            disposition = regression["expectedDisposition"]
            counts[disposition] += 1
            self.assertEqual(span["text"], regression["expectedText"])
            current_own = (
                span["temporalRelation"] == "current_visit"
                and span["sourceOrigin"] == "own_clinic_record"
                and span["providerOwnership"] == "own_clinic"
            )
            if disposition == "billable_inclusion":
                self.assertTrue(current_own)
                self.assertEqual(span["actionStatus"], "performed")
            elif disposition == "safe_exclusion":
                self.assertTrue(
                    span["actionStatus"] in {"not_performed", "planned", "considered"}
                    or span["temporalRelation"] != "current_visit"
                )
            else:
                self.assertTrue(current_own)
                self.assertIn(
                    span["actionStatus"],
                    {"performed", "prescribed", "instruction_only", "administered"},
                )
        self.assertEqual(counts, {
            "billable_inclusion": 3,
            "safe_exclusion": 1,
            "must_not_safe_exclude": 6,
        })


if __name__ == "__main__":
    unittest.main()
