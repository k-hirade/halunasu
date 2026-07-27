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
    verify_deterministic_inference,
)


CONTEXT_ARTIFACT_TYPE = "fee_context_classifier"
LEGACY_INPUT_CONTRACT_VERSION = 1
STRUCTURED_INPUT_CONTRACT_VERSION = 2
CONTEXT_SEMANTIC_PROBE_ITEM = {
    "lineId": "semantic-probe",
    "spanId": "semantic-probe",
    "text": "本日はＣＲＰのみ再検とし、採血を実施。",
    "spanText": "採血",
    "charStart": 13,
    "charEnd": 15,
    "previousLine": "",
    "nextLine": "",
    "section": "O",
    "encounterSetting": "outpatient",
    "specialty": "internal_medicine",
    "sourceType": "clinical_note",
}


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
        probe_input = [{
            **CONTEXT_SEMANTIC_PROBE_ITEM,
            "lineId": "readiness-probe",
            "spanId": "readiness-probe",
        }]
        probe, determinism_probe = verify_deterministic_inference(
            lambda: runtime.classify(probe_input),
            label="context classifier readiness probe",
        )
        _validate_context_semantic_probe(probe)
        return {
            **base,
            "runtimeDependencies": dependencies,
            "inferenceProbe": "passed",
            "semanticProbe": "passed",
            "determinismProbe": determinism_probe,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {**base, "available": False, "reason": str(exc)}


def _validate_context_semantic_probe(
    probe: Sequence[Mapping[str, Any]],
) -> None:
    if len(probe) != 1:
        raise WhiteboxArtifactError(
            "context classifier readiness probe returned an unexpected result count"
        )
    axes = probe[0].get("axes") if isinstance(probe[0], Mapping) else None
    expected_axes = {
        "actionStatus": "performed",
        "sourceOrigin": "own_clinic_record",
        "standingStatus": "none",
    }
    if not isinstance(axes, Mapping) or any(
        not isinstance(axes.get(axis), Mapping)
        or axes[axis].get("value") != expected
        or axes[axis].get("abstained") is True
        for axis, expected in expected_axes.items()
    ):
        raise WhiteboxArtifactError(
            "context classifier readiness semantic probe did not preserve "
            "current performed own-clinic context"
        )


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
            "section": str(item.get("section") or "").strip()[:32],
            "encounterSetting": str(
                item.get("encounterSetting") or item.get("encounter_setting") or ""
            ).strip()[:64],
            "specialty": str(item.get("specialty") or "").strip()[:64],
            "sourceType": str(
                item.get("sourceType") or item.get("source_type") or "clinical_note"
            ).strip()[:64],
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
        self.input_contract_version = _context_input_contract_version(manifest)
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
        return self.classify_preformatted_texts(
            [
                _classifier_text(
                    item,
                    input_contract_version=self.input_contract_version,
                )
                for item in items
            ]
        )

    def classify_preformatted_texts(
        self,
        texts: Sequence[str],
    ) -> Sequence[Mapping[str, Any]]:
        """Classify already marked WX3 inputs for build-time ONNX calibration."""
        if not texts:
            return []
        output_by_name = self._predict_output_values(texts)
        results = []
        for row in range(len(texts)):
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

    def predict_logits_preformatted_texts(
        self,
        texts: Sequence[str],
    ) -> Mapping[str, Any]:
        """Return final ONNX logits so the artifact builder calibrates what ships."""
        if not texts:
            return {
                axis: self.np.empty((0, len(labels)), dtype=self.np.float32)
                for axis, labels in self.labels.items()
            }
        output_by_name = self._predict_output_values(texts)
        return {
            axis: self.np.asarray(output_by_name[self.output_names[axis]])
            for axis in self.labels
        }

    def _predict_output_values(self, texts: Sequence[str]) -> Mapping[str, Any]:
        encoded_inputs, _ = encode_batch(
            tokenizer=self.tokenizer,
            texts=[str(text) for text in texts],
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
        return dict(zip(requested_outputs, output_values, strict=True))


def _classifier_text(
    item: Mapping[str, Any],
    *,
    input_contract_version: int = LEGACY_INPUT_CONTRACT_VERSION,
) -> str:
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
    context_parts = [
        str(item.get("previousLine") or "").strip(),
        marked.strip(),
        str(item.get("nextLine") or "").strip(),
    ]
    if input_contract_version == LEGACY_INPUT_CONTRACT_VERSION:
        return "\n".join(part for part in context_parts if part)
    if input_contract_version != STRUCTURED_INPUT_CONTRACT_VERSION:
        raise ValueError(
            f"unsupported context input contract version: {input_contract_version}"
        )
    metadata = [
        ("SETTING", item.get("encounterSetting")),
        ("SPECIALTY", item.get("specialty")),
        ("SECTION", item.get("section")),
        ("SOURCE", item.get("sourceType") or "clinical_note"),
    ]
    metadata_parts = [
        f"[{tag}]{str(value).strip()}[/{tag}]"
        for tag, value in metadata
        if str(value or "").strip()
    ]
    return "\n".join([
        *metadata_parts,
        *(part for part in context_parts if part),
    ])


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
    _context_input_contract_version(manifest)
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


def _context_input_contract_version(manifest: Mapping[str, Any]) -> int:
    value = manifest.get(
        "inputContractVersion",
        LEGACY_INPUT_CONTRACT_VERSION,
    )
    if isinstance(value, bool):
        raise WhiteboxArtifactError(
            "context inputContractVersion must be 1 or 2"
        )
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise WhiteboxArtifactError(
            "context inputContractVersion must be 1 or 2"
        ) from exc
    if parsed not in {
        LEGACY_INPUT_CONTRACT_VERSION,
        STRUCTURED_INPUT_CONTRACT_VERSION,
    }:
        raise WhiteboxArtifactError(
            "context inputContractVersion must be 1 or 2"
        )
    return parsed
