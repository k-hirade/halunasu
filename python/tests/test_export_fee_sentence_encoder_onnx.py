from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.export_fee_sentence_encoder_onnx import (
    require_empty_output,
    require_pinned_snapshot,
)
from scripts.whitebox_training_common import WhiteboxTrainingError


class ExportFeeSentenceEncoderOnnxTest(unittest.TestCase):
    def test_snapshot_revision_must_match_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            snapshot = Path(temporary) / "snapshots" / "abc123"
            snapshot.mkdir(parents=True)
            for filename in ("config.json", "tokenizer.json", "model.safetensors"):
                (snapshot / filename).write_text("fixture", encoding="utf-8")

            self.assertEqual(
                require_pinned_snapshot(snapshot, "abc123"),
                snapshot.resolve(),
            )
            with self.assertRaisesRegex(WhiteboxTrainingError, "does not match"):
                require_pinned_snapshot(snapshot, "different")

    def test_arbitrary_model_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model = Path(temporary) / "model"
            model.mkdir()
            with self.assertRaisesRegex(WhiteboxTrainingError, "snapshots"):
                require_pinned_snapshot(model, "abc123")

    def test_output_directory_must_be_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            output.mkdir()
            (output / "existing").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(WhiteboxTrainingError, "must be empty"):
                require_empty_output(output)


if __name__ == "__main__":
    unittest.main()
