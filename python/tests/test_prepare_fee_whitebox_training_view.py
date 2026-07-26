from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.prepare_fee_whitebox_training_view import build_training_view


def _case(case_id: str, split: str, *, secret: str = "") -> dict:
    return {
        "caseId": case_id,
        "split": split,
        "clinicalText": secret or f"{case_id}の合成カルテ",
        "expectedSpans": [{"text": secret}] if secret else [],
    }


class PrepareFeeWhiteboxTrainingViewTest(unittest.TestCase):
    def test_holdout_labels_are_physically_withheld(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "cases.json"
            source.write_text(
                json.dumps({
                    "cases": [
                        _case("train-1", "train"),
                        _case("development-1", "development"),
                        _case("holdout-1", "holdout", secret="HOLDOUT_SECRET"),
                    ],
                }),
                encoding="utf-8",
            )

            view = build_training_view(source)

            self.assertEqual(
                [item["caseId"] for item in view["cases"]],
                ["train-1", "development-1"],
            )
            self.assertEqual(view["withheldHoldoutCaseIds"], ["holdout-1"])
            self.assertNotIn("HOLDOUT_SECRET", json.dumps(view))

    def test_duplicate_case_id_across_splits_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "cases.json"
            source.write_text(
                json.dumps({
                    "cases": [
                        _case("duplicate-1", "train"),
                        _case("development-1", "development"),
                        _case("duplicate-1", "holdout"),
                    ],
                }),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "duplicated"):
                build_training_view(source)

    def test_training_only_augmentation_is_included_without_exposing_holdout(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "cases.json"
            source.write_text(
                json.dumps({
                    "cases": [
                        _case("train-1", "train"),
                        _case("holdout-1", "holdout", secret="HOLDOUT_SECRET"),
                    ],
                }),
                encoding="utf-8",
            )
            augmentation = root / "augmentation.json"
            augmentation.write_text(
                json.dumps({
                    "datasetId": "augmentation-v1",
                    "synthetic": True,
                    "notGold": True,
                    "trainingOnly": True,
                    "cases": [{
                        **_case("augmentation-1", "development"),
                        "synthetic": True,
                        "annotationStatus": "reviewed",
                        "generationProvenance": {
                            "source": "primary_generator",
                            "generatorFamily": "augmentation-v1",
                        },
                        "expectedSpans": [{"text": "augmentation"}],
                    }],
                }),
                encoding="utf-8",
            )

            view = build_training_view(source, [augmentation])

            self.assertEqual(
                [item["caseId"] for item in view["cases"]],
                ["train-1", "augmentation-1"],
            )
            self.assertEqual(view["withheldHoldoutCaseIds"], ["holdout-1"])
            self.assertNotIn("HOLDOUT_SECRET", json.dumps(view))
            self.assertEqual(
                view["augmentationSources"][0]["datasetId"],
                "augmentation-v1",
            )

    def test_augmentation_cannot_smuggle_holdout_or_unreviewed_cases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "cases.json"
            source.write_text(
                json.dumps({
                    "cases": [
                        _case("train-1", "train"),
                        _case("holdout-1", "holdout"),
                    ],
                }),
                encoding="utf-8",
            )
            augmentation = root / "augmentation.json"
            augmentation.write_text(
                json.dumps({
                    "synthetic": True,
                    "notGold": True,
                    "trainingOnly": True,
                    "cases": [{
                        **_case("augmentation-1", "holdout"),
                        "synthetic": True,
                        "annotationStatus": "pending_review",
                        "generationProvenance": {
                            "source": "primary_generator",
                        },
                    }],
                }),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "train/development"):
                build_training_view(source, [augmentation])


if __name__ == "__main__":
    unittest.main()
