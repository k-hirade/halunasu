from __future__ import annotations

import unittest

from experiments.wx0_metrics import (
    classification_metrics,
    coverage_risk_curve,
    expected_calibration_error,
    latency_summary,
    linking_metrics,
    match_spans,
    span_overlap_score,
)


class Wx0MetricsTest(unittest.TestCase):
    def test_span_overlap_and_maximum_matching(self) -> None:
        expected = [
            {"charStart": 0, "charEnd": 4, "category": "lab"},
            {"charStart": 5, "charEnd": 9, "category": "lab"},
        ]
        predicted = [
            {"charStart": 0, "charEnd": 4, "category": "lab"},
            {"charStart": 6, "charEnd": 9, "category": "lab"},
            {"charStart": 12, "charEnd": 15, "category": "lab"},
        ]
        self.assertEqual(span_overlap_score(expected[0], predicted[0]), 1)
        result = match_spans(expected, predicted, overlap_threshold=0.5)
        self.assertEqual(result["truePositive"], 2)
        self.assertEqual(result["falsePositive"], 1)
        self.assertEqual(result["falseNegative"], 0)
        self.assertAlmostEqual(result["recall"], 1)

    def test_span_matching_respects_category(self) -> None:
        result = match_spans(
            [{"charStart": 0, "charEnd": 4, "category": "lab"}],
            [{"charStart": 0, "charEnd": 4, "category": "imaging"}],
        )
        self.assertEqual(result["truePositive"], 0)

    def test_linking_metrics_report_recall_and_mrr(self) -> None:
        result = linking_metrics(
            [
                {
                    "expectedCodes": ["A"],
                    "candidates": [{"code": "A"}, {"code": "B"}],
                },
                {
                    "expectedCodes": ["C"],
                    "candidates": ["B", "C"],
                },
                {
                    "expectedCodes": ["D"],
                    "candidates": ["A", "B"],
                },
            ]
        )
        self.assertAlmostEqual(result["recallAt"]["1"], 1 / 3)
        self.assertAlmostEqual(result["recallAt"]["5"], 2 / 3)
        self.assertAlmostEqual(result["mrr"], 0.5)
        self.assertEqual(result["unresolved"], 1)

    def test_classification_counts_abstain_as_uncovered(self) -> None:
        result = classification_metrics(
            ["performed", "past", "past"],
            ["performed", None, "performed"],
            labels=["performed", "past"],
        )
        self.assertAlmostEqual(result["coverage"], 2 / 3)
        self.assertAlmostEqual(result["risk"], 0.5)
        self.assertEqual(result["confusion"]["past"]["__abstain__"], 1)
        self.assertAlmostEqual(result["perClass"]["past"]["recall"], 0)

    def test_calibration_and_coverage_risk(self) -> None:
        self.assertAlmostEqual(
            expected_calibration_error([True, False], [0.8, 0.2], bin_count=2),
            0.2,
        )
        curve = coverage_risk_curve(
            ["yes", "no"],
            ["yes", "yes"],
            [0.9, 0.4],
            thresholds=[0.0, 0.5],
        )
        self.assertEqual(curve[0]["coverage"], 1)
        self.assertEqual(curve[0]["risk"], 0.5)
        self.assertEqual(curve[1]["coverage"], 0.5)
        self.assertEqual(curve[1]["risk"], 0)

        # A prediction class absent from the truth sample remains valid.
        extra_class_curve = coverage_risk_curve(
            ["yes"],
            ["no"],
            [0.8],
            thresholds=[0.5],
        )
        self.assertEqual(extra_class_curve[0]["risk"], 1)

    def test_latency_summary_uses_interpolated_percentiles(self) -> None:
        summary = latency_summary([10, 20, 30, 40])
        self.assertEqual(summary["count"], 4)
        self.assertEqual(summary["p50"], 25)
        self.assertAlmostEqual(summary["p95"], 38.5)


if __name__ == "__main__":
    unittest.main()
