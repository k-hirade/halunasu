from __future__ import annotations

import unittest

from scripts.build_wx1_span_artifact import (
    DETERMINISM_REPEAT_COUNT,
    SpanExample,
    build_token_labels,
    category_token_metrics,
    labels_for_offsets,
)
from scripts.whitebox_training_common import WhiteboxTrainingError


class BuildWx1SpanArtifactTest(unittest.TestCase):
    def test_artifact_gate_requires_one_hundred_identical_runs(self) -> None:
        self.assertEqual(DETERMINISM_REPEAT_COUNT, 100)

    def test_bio_labels_follow_runtime_contract(self) -> None:
        token_labels = build_token_labels(["procedure"])
        labels = labels_for_offsets(
            [(0, 0), (0, 2), (2, 4), (5, 6)],
            [{"charStart": 0, "charEnd": 4, "category": "procedure"}],
            token_labels,
        )
        self.assertEqual(labels, [
            -100,
            token_labels.index("B-procedure"),
            token_labels.index("I-procedure"),
            token_labels.index("O"),
        ])

    def test_overlapping_spans_are_rejected(self) -> None:
        with self.assertRaisesRegex(WhiteboxTrainingError, "overlapping"):
            labels_for_offsets(
                [(0, 3)],
                [
                    {"charStart": 0, "charEnd": 3, "category": "procedure"},
                    {"charStart": 1, "charEnd": 3, "category": "lab"},
                ],
                build_token_labels(["procedure", "lab"]),
            )

    def test_truncated_labeled_span_is_rejected(self) -> None:
        with self.assertRaisesRegex(WhiteboxTrainingError, "tokenizer window"):
            labels_for_offsets(
                [(0, 0), (0, 2)],
                [{"charStart": 4, "charEnd": 8, "category": "procedure"}],
                build_token_labels(["procedure"]),
            )

    def test_span_example_has_explicit_relevance(self) -> None:
        example = SpanExample(
            case_id="case",
            line_index=0,
            text="診察のみ",
            spans=(),
            relevance_label="irrelevant",
        )
        self.assertEqual(example.relevance_label, "irrelevant")

    def test_threshold_metrics_match_runtime_argmax_decoding(self) -> None:
        metrics = category_token_metrics(
            predicted_label_indexes=[0, 1, 2, 1],
            predicted_confidences=[0.70, 0.80, 0.40, 0.90],
            truth_label_indexes=[1, 1, 2, -100],
            category_indexes=[1, 2],
            threshold=0.50,
        )
        self.assertEqual(metrics["truePositiveCount"], 1)
        self.assertEqual(metrics["falsePositiveCount"], 0)
        self.assertEqual(metrics["falseNegativeCount"], 2)
        self.assertAlmostEqual(metrics["recall"], 1 / 3)


if __name__ == "__main__":
    unittest.main()
