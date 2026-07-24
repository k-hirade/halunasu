from __future__ import annotations

import os
import unittest
from pathlib import Path

from medical_fee_calculation.clinical_axes import clinical_axis_values
from medical_fee_calculation.whitebox_context import _OnnxContextRuntime
from medical_fee_calculation.whitebox_linker import _OnnxSentenceEncoder
from medical_fee_calculation.whitebox_onnx import (
    runtime_dependency_status,
    verify_deterministic_inference,
)
from medical_fee_calculation.whitebox_span import _OnnxSpanRuntime


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "whitebox_onnx"
DEPENDENCIES = runtime_dependency_status()
REQUIRE_RUNTIME = os.environ.get("FEE_REQUIRE_ONNX_TEST_RUNTIME") == "true"

if REQUIRE_RUNTIME and not DEPENDENCIES["available"]:
    raise RuntimeError(str(DEPENDENCIES["reason"]))


@unittest.skipUnless(
    DEPENDENCIES["available"],
    str(DEPENDENCIES["reason"]),
)
class WhiteboxOnnxDeterminismTest(unittest.TestCase):
    def test_linker_output_is_byte_equal_across_twenty_runs(self) -> None:
        runtime = _OnnxSentenceEncoder(
            FIXTURE_DIR / "linker.onnx",
            FIXTURE_DIR / "tokenizer.json",
            {
                "maxLength": 32,
                "embeddingOutputName": "sentence_embedding",
                "pooling": "sentence_embedding",
                "dimension": 2,
            },
        )
        result, probe = verify_deterministic_inference(
            lambda: runtime.encode(["算定確認"]),
            label="linker fixture",
            repeat_count=20,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(probe["repeatCount"], 20)

    def test_context_output_is_byte_equal_across_twenty_runs(self) -> None:
        axes = clinical_axis_values()
        runtime = _OnnxContextRuntime(
            FIXTURE_DIR / "context.onnx",
            FIXTURE_DIR / "tokenizer.json",
            {
                "maxLength": 32,
                "axisLabels": {
                    axis: list(labels)
                    for axis, labels in axes.items()
                },
                "outputNames": {
                    axis: f"{axis}_logits"
                    for axis in axes
                },
                "abstainThresholds": {
                    axis: 0.0
                    for axis in axes
                },
            },
        )
        item = {
            "lineId": "O-001",
            "spanId": "span-1",
            "text": "算定確認",
            "spanText": "算定確認",
            "charStart": 0,
            "charEnd": 4,
            "previousLine": "",
            "nextLine": "",
        }
        result, probe = verify_deterministic_inference(
            lambda: runtime.classify([item]),
            label="context fixture",
            repeat_count=20,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(probe["repeatCount"], 20)

    def test_span_output_is_byte_equal_across_twenty_runs(self) -> None:
        runtime = _OnnxSpanRuntime(
            FIXTURE_DIR / "span.onnx",
            FIXTURE_DIR / "tokenizer.json",
            {
                "maxLength": 32,
                "tokenLabels": ["O", "B-procedure", "I-procedure"],
                "entityTypes": ["procedure"],
                "tokenLogitsOutputName": "token_logits",
                "relevanceLogitsOutputName": "relevance_logits",
                "relevanceLabels": ["relevant", "irrelevant", "abstain"],
                "defaultThreshold": 0.5,
            },
        )
        line = {
            "lineId": "O-001",
            "text": "創傷処置",
            "section": "O",
        }
        result, probe = verify_deterministic_inference(
            lambda: runtime.detect([line]),
            label="span fixture",
            repeat_count=20,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(probe["repeatCount"], 20)


if __name__ == "__main__":
    unittest.main()
