"""Shared deterministic ONNX helpers for WX1-WX3 runtime inference."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

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
    # Determinism is part of the billing-extraction contract. The runtimes use
    # CPUExecutionProvider with one thread and sequential execution. Any future
    # execution-provider, threading, or graph-optimization change must retain
    # the byte-equality CI test and the readiness probe.
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    options.enable_mem_pattern = False
    return options


def verify_deterministic_inference(
    inference: Callable[[], Any],
    *,
    label: str,
    repeat_count: int = 2,
) -> tuple[Any, dict[str, Any]]:
    if repeat_count < 2:
        raise ValueError("determinism probe repeat_count must be at least 2")
    first_result = inference()
    first_bytes = canonical_inference_bytes(first_result)
    for _ in range(1, repeat_count):
        current_bytes = canonical_inference_bytes(inference())
        if current_bytes != first_bytes:
            raise WhiteboxArtifactError(
                f"{label} output is not deterministic"
            )
    return first_result, {
        "status": "passed",
        "repeatCount": repeat_count,
        "outputSha256": hashlib.sha256(first_bytes).hexdigest(),
    }


def canonical_inference_bytes(value: Any) -> bytes:
    return json.dumps(
        _json_safe_inference_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _json_safe_inference_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe_inference_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_json_safe_inference_value(item) for item in value]
    if hasattr(value, "tolist"):
        return _json_safe_inference_value(value.tolist())
    if hasattr(value, "item"):
        return _json_safe_inference_value(value.item())
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise WhiteboxArtifactError(
                "ONNX inference output contains a non-finite value"
            )
        return value
    raise WhiteboxArtifactError(
        f"ONNX inference output contains an unsupported value: {type(value).__name__}"
    )


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
