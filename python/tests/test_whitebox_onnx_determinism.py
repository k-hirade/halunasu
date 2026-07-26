from __future__ import annotations

import os
import unittest
from pathlib import Path

from medical_fee_calculation.clinical_axes import clinical_axis_values
from medical_fee_calculation.whitebox_artifacts import WhiteboxArtifactError
from medical_fee_calculation.whitebox_context import _OnnxContextRuntime
from medical_fee_calculation.whitebox_linker import _OnnxSentenceEncoder
from medical_fee_calculation.whitebox_onnx import (
    encode_batch,
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
    def test_encode_batch_preserves_fixed_padding_attention_mask(self) -> None:
        import numpy as np

        tokenizer = _FakeTokenizer(
            padding={"pad_id": 1, "pad_token": "<pad>"},
            encodings={
                "fixed": _FakeEncoding(
                    ids=[0, 42, 2, 1, 1],
                    attention_mask=[1, 1, 1, 0, 0],
                    type_ids=[0, 0, 0, 0, 0],
                ),
            },
            token_ids={"<pad>": 1, "[PAD]": 99},
        )

        inputs, _ = encode_batch(
            tokenizer=tokenizer,
            texts=["fixed"],
            np=np,
            max_length=5,
        )

        self.assertEqual(inputs["input_ids"].tolist(), [[0, 42, 2, 1, 1]])
        self.assertEqual(inputs["attention_mask"].tolist(), [[1, 1, 1, 0, 0]])

    def test_encode_batch_pads_variable_length_encodings(self) -> None:
        import numpy as np

        tokenizer = _FakeTokenizer(
            padding=None,
            encodings={
                "long": _FakeEncoding(
                    ids=[0, 42, 2],
                    attention_mask=[1, 1, 1],
                    type_ids=[0, 0, 0],
                ),
                "short": _FakeEncoding(
                    ids=[0, 2],
                    attention_mask=[1, 1],
                    type_ids=[0, 0],
                ),
            },
            token_ids={"<pad>": 7},
        )

        inputs, _ = encode_batch(
            tokenizer=tokenizer,
            texts=["long", "short"],
            np=np,
            max_length=5,
        )

        self.assertEqual(inputs["input_ids"].tolist(), [[0, 42, 2], [0, 2, 7]])
        self.assertEqual(inputs["attention_mask"].tolist(), [[1, 1, 1], [1, 1, 0]])

    def test_encode_batch_rejects_malformed_attention_mask(self) -> None:
        import numpy as np

        tokenizer = _FakeTokenizer(
            padding=None,
            encodings={
                "invalid": _FakeEncoding(
                    ids=[0, 42, 2],
                    attention_mask=[1, 1],
                    type_ids=[0, 0, 0],
                ),
            },
            token_ids={},
        )

        with self.assertRaisesRegex(
            WhiteboxArtifactError,
            "attention mask length",
        ):
            encode_batch(
                tokenizer=tokenizer,
                texts=["invalid"],
                np=np,
                max_length=5,
            )

    def test_encode_batch_rejects_malformed_offsets(self) -> None:
        import numpy as np

        tokenizer = _FakeTokenizer(
            padding=None,
            encodings={
                "invalid": _FakeEncoding(
                    ids=[0, 42, 2],
                    attention_mask=[1, 1, 1],
                    type_ids=[0, 0, 0],
                    offsets=[(0, 0), (0, 1)],
                ),
            },
            token_ids={},
        )

        with self.assertRaisesRegex(
            WhiteboxArtifactError,
            "offsets length",
        ):
            encode_batch(
                tokenizer=tokenizer,
                texts=["invalid"],
                np=np,
                max_length=5,
            )

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


class _FakeEncoding:
    def __init__(self, *, ids, attention_mask, type_ids, offsets=None):
        self.ids = ids
        self.attention_mask = attention_mask
        self.type_ids = type_ids
        self.offsets = offsets if offsets is not None else [(0, 0)] * len(ids)


class _FakeTokenizer:
    def __init__(self, *, padding, encodings, token_ids):
        self.padding = padding
        self.encodings = encodings
        self.token_ids = token_ids

    def encode(self, text):
        return self.encodings[text]

    def token_to_id(self, token):
        return self.token_ids.get(token)


if __name__ == "__main__":
    unittest.main()
