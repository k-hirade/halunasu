"""Shared deterministic ONNX helpers for WX1-WX3 runtime inference."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import WhiteboxArtifactError


RUNTIME_MODULES = ("numpy", "onnxruntime", "tokenizers")


def runtime_dependency_status() -> dict[str, Any]:
    missing = [
        module
        for module in RUNTIME_MODULES
        if importlib.util.find_spec(module) is None
    ]
    return {
        "available": not missing,
        "missingModules": missing,
        "reason": (
            None
            if not missing
            else f"white-box ONNX runtime modules are missing: {', '.join(missing)}"
        ),
    }


def require_runtime_modules():
    status = runtime_dependency_status()
    if not status["available"]:
        raise WhiteboxArtifactError(str(status["reason"]))
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    return np, ort, Tokenizer


def deterministic_session_options(ort):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    options.enable_mem_pattern = False
    return options


def load_tokenizer(tokenizer_class, path: str | Path):
    try:
        return tokenizer_class.from_file(str(path))
    except Exception as exc:  # noqa: BLE001 - normalized at artifact boundary.
        raise WhiteboxArtifactError(f"tokenizer artifact is invalid: {exc}") from exc


def encode_batch(
    *,
    tokenizer,
    texts: Sequence[str],
    np,
    max_length: int,
) -> tuple[dict[str, Any], list[Any]]:
    encoded = [tokenizer.encode(str(text)) for text in texts]
    lengths = [min(max_length, len(item.ids)) for item in encoded]
    width = max(1, max(lengths, default=1))
    pad_token_id = tokenizer.token_to_id("[PAD]")
    if pad_token_id is None:
        pad_token_id = 0
    input_ids = np.full(
        (len(encoded), width),
        int(pad_token_id),
        dtype=np.int64,
    )
    attention_mask = np.zeros((len(encoded), width), dtype=np.int64)
    token_type_ids = np.zeros((len(encoded), width), dtype=np.int64)
    for row, (item, length) in enumerate(zip(encoded, lengths, strict=True)):
        input_ids[row, :length] = item.ids[:length]
        attention_mask[row, :length] = 1
        if item.type_ids:
            token_type_ids[row, :length] = item.type_ids[:length]
    return {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "token_type_ids": token_type_ids,
    }, encoded


def session_feeds(session, encoded_inputs: Mapping[str, Any]) -> dict[str, Any]:
    feeds = {
        model_input.name: encoded_inputs[model_input.name]
        for model_input in session.get_inputs()
        if model_input.name in encoded_inputs
    }
    if "input_ids" not in feeds or "attention_mask" not in feeds:
        raise WhiteboxArtifactError(
            "ONNX inputs must include input_ids and attention_mask"
        )
    return feeds


def softmax(values, np, *, axis: int = -1):
    shifted = values - np.max(values, axis=axis, keepdims=True)
    exponentials = np.exp(shifted)
    denominator = np.sum(exponentials, axis=axis, keepdims=True)
    if np.any(denominator == 0):
        raise WhiteboxArtifactError("ONNX logits produced an invalid softmax")
    return exponentials / denominator

