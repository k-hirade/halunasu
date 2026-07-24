"""WX3 multi-axis context classifier runtime boundary."""

from __future__ import annotations

import os
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from medical_fee_calculation.clinical_axes import (
    clinical_axis_values,
    validate_classifier_result,
)
from medical_fee_calculation.whitebox_artifacts import (
    WhiteboxArtifactError,
    artifact_readiness,
    load_whitebox_artifact,
    validate_artifact_files,
)
from medical_fee_calculation.whitebox_onnx import (
    deterministic_session_options,
    encode_batch,
    load_tokenizer,
    require_runtime_modules,
    runtime_dependency_status,
    session_feeds,
    softmax,
)


CONTEXT_ARTIFACT_TYPE = "fee_context_classifier"


def classify_context(
    payload: Mapping[str, Any],
    *,
    classifier: Callable[[Sequence[Mapping[str, Any]]], Sequence[Mapping[str, Any]]] | None = None,
) -> dict[str, Any]:
    manifest_path = (
        payload.get("manifest_path")
        or payload.get("manifestPath")
        or os.environ.get("FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH")
    )
    try:
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type=CONTEXT_ARTIFACT_TYPE,
        )
        items = _normalize_items(payload.get("items") or payload.get("spans"))
        inference = classifier or _load_classifier(artifact)
        raw_results = inference(items)
        if len(raw_results) != len(items):
            raise WhiteboxArtifactError(
                "context classifier returned an unexpected result count"
            )
        results = []
        for item, raw in zip(items, raw_results, strict=True):
            axes = validate_classifier_result(raw.get("axes") if isinstance(raw, Mapping) else raw)
            results.append({
                "lineId": item["lineId"],
                "spanId": item["spanId"],
                "text": item["text"],
                "axes": axes,
            })
        return {
            "status": "complete",
            "modelVersion": artifact.model_version,
            "modelRevision": artifact.manifest["modelRevision"],
            "artifactVersion": artifact.artifact_version,
            "results": results,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {
            "status": "model_unavailable",
            "modelVersion": None,
            "results": [],
            "reason": str(exc)[:500],
        }


def context_classifier_readiness(
    manifest_path: str | Path | None = None,
) -> dict[str, Any]:
    configured_path = manifest_path or os.environ.get("FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH")
    base = artifact_readiness(
        configured_path,
        expected_type=CONTEXT_ARTIFACT_TYPE,
    )
    if not base["available"]:
        return base
    try:
        artifact = load_whitebox_artifact(
            configured_path,
            expected_type=CONTEXT_ARTIFACT_TYPE,
        )
        model_key, tokenizer_key = _validate_context_manifest(artifact.manifest)
        validate_artifact_files(artifact, [model_key, tokenizer_key])
        dependencies = runtime_dependency_status()
        if not dependencies["available"]:
            return {
                **base,
                "available": False,
                "reason": dependencies["reason"],
                "runtimeDependencies": dependencies,
            }
        runtime = _load_onnx_context_runtime(
            str(artifact.manifest_path),
            artifact.artifact_version,
        )
        probe = runtime.classify([{
            "lineId": "readiness-probe",
            "spanId": "readiness-probe",
            "text": "算定確認",
            "spanText": "算定確認",
            "previousLine": "",
            "nextLine": "",
        }])
        if len(probe) != 1:
            raise WhiteboxArtifactError(
                "context classifier readiness probe returned an unexpected result count"
            )
        return {
            **base,
            "runtimeDependencies": dependencies,
            "inferenceProbe": "passed",
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {**base, "available": False, "reason": str(exc)}


def _normalize_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("context items must be an array")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(value[:500]):
        if not isinstance(item, Mapping):
            raise ValueError("context item must be an object")
        text = str(item.get("text") or "")[:2000]
        if not text.strip():
            raise ValueError("context item text is required")
        span_text = str(item.get("spanText") or item.get("span_text") or text)[:500]
        start = _optional_offset(item.get("charStart", item.get("char_start")))
        end = _optional_offset(item.get("charEnd", item.get("char_end")))
        if (start is not None or end is not None):
            if start is None or end is None or start < 0 or end <= start or end > len(text):
                raise ValueError("context span offsets are outside the source line")
            if text[start:end] != span_text:
                raise ValueError("context span text does not match source offsets")
        normalized.append({
            "lineId": str(item.get("lineId") or item.get("line_id") or f"L-{index + 1:03d}"),
            "spanId": str(item.get("spanId") or item.get("span_id") or f"span-{index + 1}"),
            "text": text,
            "spanText": span_text,
            "charStart": start,
            "charEnd": end,
            "previousLine": str(item.get("previousLine") or item.get("previous_line") or "")[:2000],
            "nextLine": str(item.get("nextLine") or item.get("next_line") or "")[:2000],
        })
    return normalized


def _load_classifier(artifact):
    _validate_context_manifest(artifact.manifest)
    runtime = _load_onnx_context_runtime(
        str(artifact.manifest_path),
        artifact.artifact_version,
    )
    return runtime.classify


@lru_cache(maxsize=2)
def _load_onnx_context_runtime(manifest_path: str, artifact_version: str):
    artifact = load_whitebox_artifact(
        manifest_path,
        expected_type=CONTEXT_ARTIFACT_TYPE,
    )
    if artifact.artifact_version != artifact_version:
        raise WhiteboxArtifactError("context artifact changed while loading")
    model_key, tokenizer_key = _validate_context_manifest(artifact.manifest)
    validate_artifact_files(artifact, [model_key, tokenizer_key])
    return _OnnxContextRuntime(
        artifact.file_path(model_key),
        artifact.file_path(tokenizer_key),
        artifact.manifest,
    )


class _OnnxContextRuntime:
    def __init__(self, model_path: Path, tokenizer_path: Path, manifest: Mapping[str, Any]):
        np, ort, tokenizer_class = require_runtime_modules()
        self.np = np
        self.tokenizer = load_tokenizer(tokenizer_class, tokenizer_path)
        try:
            self.session = ort.InferenceSession(
                str(model_path),
                providers=["CPUExecutionProvider"],
                sess_options=deterministic_session_options(ort),
            )
        except Exception as exc:  # noqa: BLE001 - artifact boundary.
            raise WhiteboxArtifactError(
                f"context classifier ONNX model is invalid: {exc}"
            ) from exc
        self.max_length = min(512, max(32, int(manifest.get("maxLength") or 256)))
        expected_values = clinical_axis_values()
        labels = manifest.get("axisLabels")
        output_names = manifest.get("outputNames")
        temperatures = manifest.get("temperatures") or {}
        thresholds = manifest.get("abstainThresholds") or {}
        if not isinstance(labels, Mapping) or not isinstance(output_names, Mapping):
            raise WhiteboxArtifactError("context axisLabels and outputNames are required")
        self.labels: dict[str, tuple[str, ...]] = {}
        self.output_names: dict[str, str] = {}
        self.temperatures: dict[str, float] = {}
        self.thresholds: dict[str, float] = {}
        for axis, allowed in expected_values.items():
            configured = labels.get(axis)
            if not isinstance(configured, list) or tuple(configured) != tuple(allowed):
                raise WhiteboxArtifactError(
                    f"context axisLabels.{axis} must match the generated contract"
                )
            output_name = str(output_names.get(axis) or "").strip()
            if not output_name:
                raise WhiteboxArtifactError(f"context outputNames.{axis} is missing")
            temperature = float(temperatures.get(axis, 1.0))
            threshold = float(thresholds.get(axis, 0.9))
            if not math.isfinite(temperature) or temperature <= 0:
                raise WhiteboxArtifactError(f"context temperature for {axis} is invalid")
            if not math.isfinite(threshold) or not 0 <= threshold <= 1:
                raise WhiteboxArtifactError(f"context abstain threshold for {axis} is invalid")
            self.labels[axis] = tuple(configured)
            self.output_names[axis] = output_name
            self.temperatures[axis] = temperature
            self.thresholds[axis] = threshold
        available_outputs = {output.name for output in self.session.get_outputs()}
        missing_outputs = set(self.output_names.values()) - available_outputs
        if missing_outputs:
            raise WhiteboxArtifactError(
                "context ONNX outputs are missing: "
                + ", ".join(sorted(missing_outputs))
            )

    def classify(self, items: Sequence[Mapping[str, Any]]) -> Sequence[Mapping[str, Any]]:
        if not items:
            return []
        encoded_inputs, _ = encode_batch(
            tokenizer=self.tokenizer,
            texts=[_classifier_text(item) for item in items],
            np=self.np,
            max_length=self.max_length,
        )
        requested_outputs = [self.output_names[axis] for axis in self.labels]
        try:
            output_values = self.session.run(
                requested_outputs,
                session_feeds(self.session, encoded_inputs),
            )
        except Exception as exc:  # noqa: BLE001 - external model boundary.
            raise WhiteboxArtifactError(
                f"context classifier ONNX inference failed: {exc}"
            ) from exc
        output_by_name = dict(zip(requested_outputs, output_values, strict=True))
        results = []
        for row in range(len(items)):
            axes = {}
            for axis, axis_labels in self.labels.items():
                logits = self.np.asarray(output_by_name[self.output_names[axis]][row], dtype=self.np.float64)
                if logits.ndim != 1 or logits.shape[0] != len(axis_labels):
                    raise WhiteboxArtifactError(f"context ONNX output dimension is invalid for {axis}")
                probabilities = softmax(logits / self.temperatures[axis], self.np)
                winner = int(self.np.argmax(probabilities))
                confidence = float(probabilities[winner])
                axes[axis] = {
                    "value": axis_labels[winner],
                    "confidence": confidence,
                    "abstained": confidence < self.thresholds[axis],
                }
            results.append({"axes": axes})
        return results


def _classifier_text(item: Mapping[str, Any]) -> str:
    span = str(item.get("spanText") or item.get("text") or "")
    current = str(item.get("text") or "")
    start = item.get("charStart")
    end = item.get("charEnd")
    if (
        isinstance(start, int)
        and isinstance(end, int)
        and 0 <= start < end <= len(current)
        and current[start:end] == span
    ):
        marked = (
            current[:start]
            + f"[SPAN]{current[start:end]}[/SPAN]"
            + current[end:]
        )
    else:
        marked = current.replace(span, f"[SPAN]{span}[/SPAN]", 1) if span else current
    parts = [
        str(item.get("previousLine") or "").strip(),
        marked.strip(),
        str(item.get("nextLine") or "").strip(),
    ]
    return "\n".join(part for part in parts if part)


def _optional_offset(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("context span offset must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("context span offset must be an integer") from exc


def _validate_context_manifest(
    manifest: Mapping[str, Any],
) -> tuple[str, str]:
    backend = str(manifest.get("backend") or "")
    if backend != "onnx_multi_axis":
        raise WhiteboxArtifactError(
            f"unsupported context classifier backend: {backend}"
        )
    model_key = str(manifest.get("modelFileKey") or "model")
    tokenizer_key = str(manifest.get("tokenizerFileKey") or "tokenizer")
    labels = manifest.get("axisLabels")
    output_names = manifest.get("outputNames")
    temperatures = manifest.get("temperatures") or {}
    thresholds = manifest.get("abstainThresholds") or {}
    if not isinstance(labels, Mapping) or not isinstance(output_names, Mapping):
        raise WhiteboxArtifactError(
            "context axisLabels and outputNames are required"
        )
    for axis, allowed in clinical_axis_values().items():
        configured = labels.get(axis)
        if not isinstance(configured, list) or tuple(configured) != tuple(allowed):
            raise WhiteboxArtifactError(
                f"context axisLabels.{axis} must match the generated contract"
            )
        if not str(output_names.get(axis) or "").strip():
            raise WhiteboxArtifactError(f"context outputNames.{axis} is missing")
        try:
            temperature = float(temperatures.get(axis, 1.0))
            threshold = float(thresholds.get(axis, 0.9))
        except (TypeError, ValueError) as exc:
            raise WhiteboxArtifactError(
                f"context calibration for {axis} is invalid"
            ) from exc
        if not math.isfinite(temperature) or temperature <= 0:
            raise WhiteboxArtifactError(
                f"context temperature for {axis} is invalid"
            )
        if not math.isfinite(threshold) or not 0 <= threshold <= 1:
            raise WhiteboxArtifactError(
                f"context abstain threshold for {axis} is invalid"
            )
    return model_key, tokenizer_key
