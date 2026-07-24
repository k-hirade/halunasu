#!/usr/bin/env python3
"""Generate reproducible tiny ONNX fixtures for WX1-WX3 determinism tests."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

import onnx
from onnx import TensorProto, helper
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace

from medical_fee_calculation.clinical_axes import clinical_axis_values


DEFAULT_OUTPUT_DIR = (
    Path(__file__).resolve().parents[1]
    / "python"
    / "tests"
    / "fixtures"
    / "whitebox_onnx"
)
MODEL_IR_VERSION = 8
MODEL_OPSET_VERSION = 13


def build_fixtures(output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    _build_tokenizer(output_dir / "tokenizer.json")
    _build_constant_model(
        output_dir / "linker.onnx",
        {"sentence_embedding": ([1, 2], [3.0, 4.0])},
    )
    axes = clinical_axis_values()
    _build_constant_model(
        output_dir / "context.onnx",
        {
            f"{axis}_logits": (
                [1, len(labels)],
                [4.0] + [0.0] * (len(labels) - 1),
            )
            for axis, labels in axes.items()
        },
    )
    _build_constant_model(
        output_dir / "span.onnx",
        {
            "token_logits": ([1, 1, 3], [0.0, 4.0, 0.0]),
            "relevance_logits": ([1, 3], [4.0, 0.0, 0.0]),
        },
    )
    manifest = {
        "schemaVersion": 1,
        "generator": Path(__file__).name,
        "onnxIrVersion": MODEL_IR_VERSION,
        "onnxOpsetVersion": MODEL_OPSET_VERSION,
        "files": {
            name: _sha256(output_dir / name)
            for name in (
                "tokenizer.json",
                "linker.onnx",
                "context.onnx",
                "span.onnx",
            )
        },
    }
    (output_dir / "fixture-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def check_fixtures(output_dir: Path) -> None:
    expected_manifest_path = output_dir / "fixture-manifest.json"
    if not expected_manifest_path.is_file():
        raise RuntimeError(f"fixture manifest is missing: {expected_manifest_path}")
    expected = json.loads(expected_manifest_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="whitebox-onnx-fixtures-") as temporary:
        generated_dir = Path(temporary)
        actual = build_fixtures(generated_dir)
        if actual != expected:
            raise RuntimeError("committed ONNX fixtures are stale")
        for name in actual["files"]:
            if (output_dir / name).read_bytes() != (generated_dir / name).read_bytes():
                raise RuntimeError(f"committed ONNX fixture differs: {name}")


def _build_tokenizer(path: Path) -> None:
    tokenizer = Tokenizer(WordLevel(
        vocab={
            "[UNK]": 0,
            "[PAD]": 1,
            "算定確認": 2,
            "創傷処置": 3,
        },
        unk_token="[UNK]",
    ))
    tokenizer.pre_tokenizer = Whitespace()
    tokenizer.save(str(path))


def _build_constant_model(
    path: Path,
    outputs: dict[str, tuple[list[int], list[float]]],
) -> None:
    inputs = [
        helper.make_tensor_value_info(
            "input_ids",
            TensorProto.INT64,
            ["batch", "sequence"],
        ),
        helper.make_tensor_value_info(
            "attention_mask",
            TensorProto.INT64,
            ["batch", "sequence"],
        ),
    ]
    nodes = []
    output_infos = []
    for output_name, (shape, values) in outputs.items():
        tensor = helper.make_tensor(
            name=f"{output_name}_value",
            data_type=TensorProto.FLOAT,
            dims=shape,
            vals=values,
        )
        nodes.append(helper.make_node(
            "Constant",
            inputs=[],
            outputs=[output_name],
            value=tensor,
        ))
        output_infos.append(helper.make_tensor_value_info(
            output_name,
            TensorProto.FLOAT,
            shape,
        ))
    graph = helper.make_graph(
        nodes,
        path.stem,
        inputs,
        output_infos,
    )
    model = helper.make_model(
        graph,
        producer_name="halunasu-whitebox-fixture-generator",
        opset_imports=[helper.make_operatorsetid("", MODEL_OPSET_VERSION)],
    )
    model.ir_version = MODEL_IR_VERSION
    onnx.checker.check_model(model)
    onnx.save_model(model, path)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    if args.check:
        check_fixtures(output_dir)
    else:
        build_fixtures(output_dir)
        print(output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
