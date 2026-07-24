from __future__ import annotations

import unittest

from experiments.wx0_span_zeroshot import (
    evaluate_model,
    normalize_predictions,
    prediction_fingerprint,
)


ENTITY_TYPES = [
    {
        "id": "medical_procedure_d",
        "category": "lab",
        "label": "検査",
        "modelLabel": "検査: 検体検査",
    }
]


class Wx0SpanZeroshotTest(unittest.TestCase):
    def test_normalizes_known_labels_and_ignores_unknown_labels(self) -> None:
        result = normalize_predictions(
            [
                {
                    "start": 2,
                    "end": 4,
                    "text": "採血",
                    "label": "検査: 検体検査",
                    "score": 0.9,
                },
                {
                    "start": 0,
                    "end": 1,
                    "text": "X",
                    "label": "unknown",
                    "score": 1,
                },
            ],
            ENTITY_TYPES,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["category"], "lab")

    def test_evaluation_reports_determinism_and_span_metrics(self) -> None:
        case = {
            "caseId": "case-1",
            "specialty": "internal_medicine",
            "encounterSetting": "outpatient",
            "split": "holdout",
            "clinicalText": "採血を実施",
            "expectedSpans": [
                {
                    "charStart": 0,
                    "charEnd": 2,
                    "category": "lab",
                }
            ],
        }

        def predict(_text, _labels, _threshold):
            return [
                {
                    "start": 0,
                    "end": 2,
                    "text": "採血",
                    "label": "検査: 検体検査",
                    "score": 0.9,
                }
            ]

        result = evaluate_model(
            cases=[case],
            entity_types=ENTITY_TYPES,
            predict=predict,
            threshold=0.5,
            repeats=3,
            model_manifest={"id": "test", "revision": "abcdef0"},
        )
        self.assertEqual(result["overall"]["f1"], 1)
        self.assertTrue(result["determinism"]["allCasesDeterministic"])
        self.assertEqual(result["determinism"]["exactMatchRate"], 1)

    def test_fingerprint_is_stable_for_equivalent_predictions(self) -> None:
        first = [
            {
                "charStart": 0,
                "charEnd": 2,
                "category": "lab",
                "confidence": 0.900000001,
            }
        ]
        second = [
            {
                "category": "lab",
                "charEnd": 2,
                "charStart": 0,
                "confidence": 0.900000001,
            }
        ]
        self.assertEqual(
            prediction_fingerprint(first),
            prediction_fingerprint(second),
        )


if __name__ == "__main__":
    unittest.main()
