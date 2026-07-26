"""WX1 span detector runtime boundary.

The model dependency is optional. Without a verified local artifact the worker
returns ``model_unavailable`` and Node routes every non-trivial line to the
existing LLM path.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

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


SPAN_ARTIFACT_TYPE = "fee_span_detector"
ALLOWED_RELEVANCE = {"relevant", "irrelevant", "abstain"}
SPAN_SEMANTIC_PROBE_LINE = {
    "lineId": "semantic-probe",
    "text": "本日はＣＲＰのみ再検とし、採血を実施。",
    "section": "O",
}


def detect_spans(
    payload: Mapping[str, Any],
    *,
    detector: Callable[[Sequence[Mapping[str, Any]]], Sequence[Mapping[str, Any]]] | None = None,
) -> dict[str, Any]:
    manifest_path = (
        payload.get("manifest_path")
        or payload.get("manifestPath")
        or os.environ.get("FEE_SPAN_DETECTOR_MANIFEST_PATH")
    )
    try:
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type=SPAN_ARTIFACT_TYPE,
        )
        lines = _normalize_lines(payload.get("lines"))
        inference = detector or _load_detector(artifact)
        raw_results = inference(lines)
        if len(raw_results) != len(lines):
            raise WhiteboxArtifactError(
                "span detector returned an unexpected result count"
            )
        results = [
            _normalize_line_result(line, raw)
            for line, raw in zip(lines, raw_results, strict=True)
        ]
        return {
            "status": "complete",
            "modelVersion": artifact.model_version,
            "modelRevision": artifact.manifest["modelRevision"],
            "artifactVersion": artifact.artifact_version,
            "extractorVersion": str(
                artifact.manifest.get("extractorVersion")
                or artifact.artifact_version
            ),
            "results": results,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {
            "status": "model_unavailable",
            "modelVersion": None,
            "extractorVersion": None,
            "results": [],
            "reason": str(exc)[:500],
        }


def span_detector_readiness(manifest_path: str | Path | None = None) -> dict[str, Any]:
    configured_path = manifest_path or os.environ.get("FEE_SPAN_DETECTOR_MANIFEST_PATH")
    base = artifact_readiness(
        configured_path,
        expected_type=SPAN_ARTIFACT_TYPE,
    )
    if not base["available"]:
        return base
    try:
        artifact = load_whitebox_artifact(
            configured_path,
            expected_type=SPAN_ARTIFACT_TYPE,
        )
        _validate_onnx_manifest(artifact)
        dependencies = runtime_dependency_status()
        if not dependencies["available"]:
            return {
                **base,
                "available": False,
                "reason": dependencies["reason"],
                "runtimeDependencies": dependencies,
            }
        runtime = _load_onnx_span_runtime(
            str(artifact.manifest_path),
            artifact.artifact_version,
        )
        probe_input = [{**SPAN_SEMANTIC_PROBE_LINE, "lineId": "readiness-probe"}]
        probe, determinism_probe = verify_deterministic_inference(
            lambda: runtime.detect(probe_input),
            label="span detector readiness probe",
        )
        _validate_span_semantic_probe(probe)
        return {
            **base,
            "runtimeDependencies": dependencies,
            "inferenceProbe": "passed",
            "semanticProbe": "passed",
            "determinismProbe": determinism_probe,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {**base, "available": False, "reason": str(exc)}


def _validate_span_semantic_probe(probe: Sequence[Mapping[str, Any]]) -> None:
    if len(probe) != 1:
        raise WhiteboxArtifactError(
            "span detector readiness probe returned an unexpected result count"
        )
    spans = probe[0].get("spans") if isinstance(probe[0], Mapping) else None
    if (
        probe[0].get("relevance") != "relevant"
        or not isinstance(spans, list)
        or not any(
            span.get("text") == "採血" and span.get("category") == "lab"
            for span in spans
            if isinstance(span, Mapping)
        )
    ):
        raise WhiteboxArtifactError(
            "span detector readiness semantic probe did not detect the expected lab span"
        )


def _normalize_lines(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("lines must be an array")
    normalized: list[dict[str, Any]] = []
    for index, line in enumerate(value[:1000]):
        if not isinstance(line, Mapping):
            raise ValueError("line must be an object")
        text = str(line.get("text") or "")
        normalized.append({
            "lineId": str(line.get("lineId") or line.get("line_id") or f"L-{index + 1:03d}"),
            "text": text[:5000],
            "section": str(line.get("section") or "unknown"),
        })
    return normalized


def _normalize_line_result(line: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ValueError("span detector line result must be an object")
    relevance = str(raw.get("relevance") or "abstain")
    if relevance not in ALLOWED_RELEVANCE:
        raise ValueError("span detector relevance is invalid")
    spans = []
    for span in raw.get("spans") or []:
        if not isinstance(span, Mapping):
            raise ValueError("span detector span must be an object")
        start = int(span.get("charStart", span.get("char_start", -1)))
        end = int(span.get("charEnd", span.get("char_end", -1)))
        text = str(line["text"])
        if start < 0 or end <= start or end > len(text):
            raise ValueError("span offsets are outside the source line")
        span_text = text[start:end]
        supplied_text = str(span.get("text") or span_text)
        if supplied_text != span_text:
            raise ValueError("span text does not match source offsets")
        confidence = float(span.get("confidence", 0))
        if not 0 <= confidence <= 1:
            raise ValueError("span confidence must be between 0 and 1")
        category = str(span.get("category") or "").strip()
        if not category:
            raise ValueError("span category is required")
        spans.append({
            "spanId": str(span.get("spanId") or span.get("span_id") or f"{line['lineId']}:{start}:{end}"),
            "lineId": line["lineId"],
            "charStart": start,
            "charEnd": end,
            "text": span_text,
            "category": category,
            "confidence": confidence,
        })
    relevance_confidence = float(
        raw.get("relevanceConfidence", raw.get("relevance_confidence", 0))
    )
    if not 0 <= relevance_confidence <= 1:
        raise ValueError("span detector relevance confidence must be between 0 and 1")
    return {
        "lineId": line["lineId"],
        "relevance": relevance,
        "relevanceConfidence": relevance_confidence,
        "spans": spans,
    }


def _load_detector(artifact):
    backend = str(artifact.manifest.get("backend") or "")
    if backend != "onnx_token_classifier":
        raise WhiteboxArtifactError(f"unsupported span detector backend: {backend}")
    return _load_onnx_span_runtime(
        str(artifact.manifest_path),
        artifact.artifact_version,
    ).detect


@lru_cache(maxsize=2)
def _load_onnx_span_runtime(manifest_path: str, artifact_version: str):
    artifact = load_whitebox_artifact(
        manifest_path,
        expected_type=SPAN_ARTIFACT_TYPE,
    )
    if artifact.artifact_version != artifact_version:
        raise WhiteboxArtifactError("span detector artifact changed while loading")
    model_key, tokenizer_key = _validate_onnx_manifest(artifact)
    return _OnnxSpanRuntime(
        artifact.file_path(model_key),
        artifact.file_path(tokenizer_key),
        artifact.manifest,
    )


class _OnnxSpanRuntime:
    def __init__(
        self,
        model_path: Path,
        tokenizer_path: Path,
        manifest: Mapping[str, Any],
    ):
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
            raise WhiteboxArtifactError(f"span detector ONNX model is invalid: {exc}") from exc
        self.max_length = min(512, max(16, int(manifest.get("maxLength") or 256)))
        self.token_labels = tuple(str(value) for value in manifest["tokenLabels"])
        self.entity_types = set(str(value) for value in manifest["entityTypes"])
        self.token_output_name = str(manifest["tokenLogitsOutputName"])
        self.relevance_output_name = str(manifest["relevanceLogitsOutputName"])
        self.relevance_labels = tuple(str(value) for value in manifest["relevanceLabels"])
        self.default_threshold = _probability(
            manifest.get("defaultThreshold", 0.5),
            "defaultThreshold",
        )
        raw_thresholds = manifest.get("entityThresholds") or {}
        if not isinstance(raw_thresholds, Mapping):
            raise WhiteboxArtifactError("span detector entityThresholds must be an object")
        self.entity_thresholds = {
            str(category): _probability(value, f"entityThresholds.{category}")
            for category, value in raw_thresholds.items()
        }
        unknown_thresholds = set(self.entity_thresholds) - self.entity_types
        if unknown_thresholds:
            raise WhiteboxArtifactError(
                "span detector entityThresholds contains an unknown entity type"
            )
        self.relevance_temperature = _positive_number(
            manifest.get("relevanceTemperature", 1.0),
            "relevanceTemperature",
        )
        output_names = {output.name for output in self.session.get_outputs()}
        for output_name in (self.token_output_name, self.relevance_output_name):
            if output_name not in output_names:
                raise WhiteboxArtifactError(
                    f"span detector ONNX output is missing: {output_name}"
                )

    def detect(
        self,
        lines: Sequence[Mapping[str, Any]],
    ) -> Sequence[Mapping[str, Any]]:
        if not lines:
            return []
        inputs, encoded = encode_batch(
            tokenizer=self.tokenizer,
            texts=[str(line["text"]) for line in lines],
            np=self.np,
            max_length=self.max_length,
        )
        try:
            token_logits, relevance_logits = self.session.run(
                [self.token_output_name, self.relevance_output_name],
                session_feeds(self.session, inputs),
            )
        except Exception as exc:  # noqa: BLE001 - external model boundary.
            raise WhiteboxArtifactError(
                f"span detector ONNX inference failed: {exc}"
            ) from exc
        token_probabilities = softmax(
            self.np.asarray(token_logits, dtype=self.np.float64),
            self.np,
        )
        relevance_probabilities = softmax(
            self.np.asarray(relevance_logits, dtype=self.np.float64)
            / self.relevance_temperature,
            self.np,
        )
        if (
            token_probabilities.ndim != 3
            or token_probabilities.shape[0] != len(lines)
            or token_probabilities.shape[2] != len(self.token_labels)
        ):
            raise WhiteboxArtifactError("span detector token logits have an invalid shape")
        if (
            relevance_probabilities.ndim != 2
            or relevance_probabilities.shape
            != (len(lines), len(self.relevance_labels))
        ):
            raise WhiteboxArtifactError("span detector relevance logits have an invalid shape")
        results = []
        for row, line in enumerate(lines):
            relevance_index = int(self.np.argmax(relevance_probabilities[row]))
            relevance = self.relevance_labels[relevance_index]
            relevance_confidence = float(
                relevance_probabilities[row, relevance_index]
            )
            results.append({
                "relevance": relevance,
                "relevanceConfidence": relevance_confidence,
                "spans": self._decode_spans(
                    str(line["text"]),
                    encoded[row],
                    token_probabilities[row],
                ),
            })
        return results

    def _decode_spans(self, text: str, encoded, probabilities) -> list[dict[str, Any]]:
        limit = min(
            self.max_length,
            len(encoded.ids),
            probabilities.shape[0],
        )
        active: dict[str, Any] | None = None
        spans: list[dict[str, Any]] = []

        def finish() -> None:
            nonlocal active
            if active is not None and active["charEnd"] > active["charStart"]:
                start = active["charStart"]
                end = active["charEnd"]
                spans.append({
                    "charStart": start,
                    "charEnd": end,
                    "text": text[start:end],
                    "category": active["category"],
                    "confidence": min(active["tokenConfidences"]),
                })
            active = None

        for token_index in range(limit):
            start, end = encoded.offsets[token_index]
            if end <= start or start < 0 or end > len(text):
                continue
            label_index = int(self.np.argmax(probabilities[token_index]))
            confidence = float(probabilities[token_index, label_index])
            prefix, category = _parse_token_label(self.token_labels[label_index])
            threshold = self.entity_thresholds.get(category, self.default_threshold)
            if prefix == "O" or confidence < threshold:
                finish()
                continue
            if prefix == "B" or active is None or active["category"] != category:
                finish()
                active = {
                    "category": category,
                    "charStart": int(start),
                    "charEnd": int(end),
                    "tokenConfidences": [confidence],
                }
                continue
            active["charEnd"] = int(end)
            active["tokenConfidences"].append(confidence)
        finish()
        return spans


def _validate_onnx_manifest(artifact) -> tuple[str, str]:
    if str(artifact.manifest.get("backend") or "") != "onnx_token_classifier":
        raise WhiteboxArtifactError(
            f"unsupported span detector backend: {artifact.manifest.get('backend')}"
        )
    model_key = str(artifact.manifest.get("modelFileKey") or "model")
    tokenizer_key = str(artifact.manifest.get("tokenizerFileKey") or "tokenizer")
    validate_artifact_files(artifact, [model_key, tokenizer_key])
    entity_types = artifact.manifest.get("entityTypes")
    token_labels = artifact.manifest.get("tokenLabels")
    relevance_labels = artifact.manifest.get("relevanceLabels")
    if (
        not isinstance(entity_types, list)
        or not entity_types
        or any(not isinstance(value, str) or not value for value in entity_types)
    ):
        raise WhiteboxArtifactError("span detector entityTypes are missing")
    if (
        not isinstance(token_labels, list)
        or not token_labels
        or any(not isinstance(value, str) or not value for value in token_labels)
    ):
        raise WhiteboxArtifactError("span detector tokenLabels are missing")
    allowed_types = set(entity_types)
    for label in token_labels:
        prefix, category = _parse_token_label(label)
        if prefix != "O" and category not in allowed_types:
            raise WhiteboxArtifactError(
                "span detector tokenLabels contains an unknown entity type"
            )
    if (
        not isinstance(relevance_labels, list)
        or set(relevance_labels) != ALLOWED_RELEVANCE
        or len(relevance_labels) != len(ALLOWED_RELEVANCE)
    ):
        raise WhiteboxArtifactError(
            "span detector relevanceLabels must contain relevant, irrelevant, and abstain"
        )
    for field in ("tokenLogitsOutputName", "relevanceLogitsOutputName"):
        if not isinstance(artifact.manifest.get(field), str) or not artifact.manifest[field]:
            raise WhiteboxArtifactError(f"span detector {field} is missing")
    return model_key, tokenizer_key


def _parse_token_label(value: str) -> tuple[str, str]:
    normalized = str(value or "").strip()
    if normalized == "O":
        return "O", ""
    for separator in ("-", ":"):
        if separator in normalized:
            prefix, category = normalized.split(separator, 1)
            if prefix in {"B", "I"} and category:
                return prefix, category
    raise WhiteboxArtifactError(f"invalid span detector token label: {normalized}")


def _probability(value: Any, field: str) -> float:
    number = float(value)
    if not 0 <= number <= 1:
        raise WhiteboxArtifactError(f"{field} must be between 0 and 1")
    return number


def _positive_number(value: Any, field: str) -> float:
    number = float(value)
    if number <= 0:
        raise WhiteboxArtifactError(f"{field} must be positive")
    return number
