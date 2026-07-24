"""WX2 span-to-master linker with a versioned, immutable index."""

from __future__ import annotations

import json
import math
import os
import sqlite3
import struct
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import (
    WhiteboxArtifact,
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
)


LINKER_ARTIFACT_TYPE = "fee_master_linker"
LINKER_INDEX_FILE = "index"
DEFAULT_TOP_K = 5
MAX_TOP_K = 20
CATEGORY_MISMATCH_PENALTY = 0.9


@dataclass(frozen=True)
class LinkerIndex:
    entries: tuple[dict[str, Any], ...]
    matrix: Any | None
    norms: Any | None


def link_spans(
    payload: Mapping[str, Any],
    *,
    embedder: Callable[[Sequence[str]], Sequence[Sequence[float]]] | None = None,
) -> dict[str, Any]:
    manifest_path = (
        payload.get("manifest_path")
        or payload.get("manifestPath")
        or os.environ.get("FEE_LINKER_MANIFEST_PATH")
    )
    try:
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type=LINKER_ARTIFACT_TYPE,
            required_files=(LINKER_INDEX_FILE,),
        )
        index = _load_index(str(artifact.file_path(LINKER_INDEX_FILE)))
        spans = _normalize_spans(payload.get("spans"))
        kinds = _normalize_kinds(payload.get("kinds"))
        top_k = _bounded_int(payload.get("top_k", payload.get("topK")), DEFAULT_TOP_K, 1, MAX_TOP_K)
        service_date = str(payload.get("service_date") or payload.get("serviceDate") or "").strip()
        encoder = embedder or _load_embedder(artifact)
        vectors = encoder([span["text"] for span in spans]) if spans else []
        if len(vectors) != len(spans):
            raise WhiteboxArtifactError("linker embedder returned an unexpected vector count")
        results = [
            _link_one(span, vector, index, kinds, service_date, top_k)
            for span, vector in zip(spans, vectors, strict=True)
        ]
        return {
            "status": "complete",
            "modelVersion": artifact.model_version,
            "modelRevision": artifact.manifest["modelRevision"],
            "indexVersion": str(artifact.manifest.get("indexVersion") or artifact.artifact_version),
            "artifactVersion": artifact.artifact_version,
            "results": results,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {
            "status": "index_unavailable",
            "modelVersion": None,
            "indexVersion": None,
            "results": [],
            "reason": str(exc)[:500],
        }


def linker_readiness(manifest_path: str | Path | None = None) -> dict[str, Any]:
    configured_path = manifest_path or os.environ.get("FEE_LINKER_MANIFEST_PATH")
    base = artifact_readiness(
        configured_path,
        expected_type=LINKER_ARTIFACT_TYPE,
        required_files=(LINKER_INDEX_FILE,),
    )
    if not base["available"]:
        return base
    try:
        artifact = load_whitebox_artifact(
            configured_path,
            expected_type=LINKER_ARTIFACT_TYPE,
            required_files=(LINKER_INDEX_FILE,),
        )
        model_key, tokenizer_key = _onnx_file_keys(artifact)
        validate_artifact_files(artifact, [model_key, tokenizer_key])
        dependencies = runtime_dependency_status()
        if not dependencies["available"]:
            return {
                **base,
                "available": False,
                "reason": dependencies["reason"],
                "runtimeDependencies": dependencies,
            }
        index = _load_index(str(artifact.file_path(LINKER_INDEX_FILE)))
        encoder = _load_onnx_embedder(
            str(artifact.manifest_path),
            artifact.artifact_version,
        )
        probe_vectors = encoder.encode(["算定確認"])
        if len(probe_vectors) != 1:
            raise WhiteboxArtifactError(
                "linker readiness probe returned an unexpected vector count"
            )
        expected_dimension = len(index.entries[0]["vector"]) if index.entries else 0
        if expected_dimension <= 0 or len(probe_vectors[0]) != expected_dimension:
            raise WhiteboxArtifactError(
                "linker encoder dimension does not match the index"
            )
        return {
            **base,
            "runtimeDependencies": dependencies,
            "inferenceProbe": "passed",
            "indexEntryCount": len(index.entries),
            "dimension": expected_dimension,
        }
    except (WhiteboxArtifactError, ValueError, OSError, ImportError) as exc:
        return {**base, "available": False, "reason": str(exc)}


@lru_cache(maxsize=4)
def _load_index(path: str) -> LinkerIndex:
    with Path(path).open("rb") as handle:
        header = handle.read(16)
    if header.startswith(b"SQLite format 3"):
        return _load_sqlite_index(path)
    return _load_json_index(path)


def _load_json_index(path: str) -> LinkerIndex:
    parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = parsed.get("entries") if isinstance(parsed, dict) else None
    if not isinstance(entries, list):
        raise WhiteboxArtifactError("linker index entries must be an array")
    dimension = int(parsed.get("dimension") or 0)
    if dimension <= 0:
        raise WhiteboxArtifactError("linker index dimension must be positive")
    normalized: list[dict[str, Any]] = []
    for raw in entries:
        if not isinstance(raw, Mapping):
            raise WhiteboxArtifactError("linker index entry must be an object")
        vector = raw.get("vector")
        if (
            not isinstance(vector, list)
            or len(vector) != dimension
            or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in vector)
        ):
            raise WhiteboxArtifactError("linker index vector has an invalid dimension")
        code = str(raw.get("code") or "").strip()
        name = str(raw.get("name") or "").strip()
        kind = str(raw.get("kind") or "").strip()
        matched_doc = str(raw.get("matchedDoc") or raw.get("doc") or name).strip()
        if not code or not name or kind not in {"procedure", "drug", "disease"} or not matched_doc:
            raise WhiteboxArtifactError("linker index entry identity is invalid")
        normalized.append({
            "code": code,
            "name": name,
            "kind": kind,
            "matchedDoc": matched_doc,
            "category": str(raw.get("category") or "").strip(),
            "points": _optional_number(raw.get("points")),
            "effectiveFrom": str(raw.get("effectiveFrom") or "").strip(),
            "effectiveTo": str(raw.get("effectiveTo") or "").strip(),
            "vector": tuple(float(value) for value in vector),
        })
    return _as_linker_index(normalized)


def _load_sqlite_index(path: str) -> LinkerIndex:
    connection = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        metadata = {
            str(row["key"]): str(row["value"])
            for row in connection.execute("SELECT key, value FROM linker_metadata")
        }
        dimension = int(metadata.get("dimension") or 0)
        if dimension <= 0:
            raise WhiteboxArtifactError("linker sqlite index dimension must be positive")
        rows = connection.execute(
            """
            SELECT code, name, kind, doc, category, points,
                   effective_from, effective_to, vector
            FROM linker_embeddings
            ORDER BY kind, code, doc
            """
        )
        normalized = []
        for row in rows:
            vector_blob = row["vector"]
            if not isinstance(vector_blob, bytes) or len(vector_blob) != dimension * 4:
                raise WhiteboxArtifactError("linker sqlite vector has an invalid dimension")
            vector = struct.unpack(f"<{dimension}f", vector_blob)
            normalized.append({
                "code": str(row["code"] or "").strip(),
                "name": str(row["name"] or "").strip(),
                "kind": str(row["kind"] or "").strip(),
                "matchedDoc": str(row["doc"] or "").strip(),
                "category": str(row["category"] or "").strip(),
                "points": _optional_number(row["points"]),
                "effectiveFrom": str(row["effective_from"] or "").strip(),
                "effectiveTo": str(row["effective_to"] or "").strip(),
                "vector": vector,
            })
        if not normalized:
            raise WhiteboxArtifactError("linker sqlite index has no embeddings")
        for entry in normalized:
            if (
                not entry["code"]
                or not entry["name"]
                or entry["kind"] not in {"procedure", "drug", "disease"}
                or not entry["matchedDoc"]
            ):
                raise WhiteboxArtifactError("linker sqlite entry identity is invalid")
        return _as_linker_index(normalized)
    except sqlite3.Error as exc:
        raise WhiteboxArtifactError(f"linker sqlite index is invalid: {exc}") from exc
    finally:
        connection.close()


def _load_embedder(artifact: WhiteboxArtifact) -> Callable[[Sequence[str]], Sequence[Sequence[float]]]:
    backend = str(artifact.manifest.get("backend") or "")
    if backend != "onnx_sentence_encoder":
        raise WhiteboxArtifactError(f"unsupported linker backend: {backend}")
    return _load_onnx_embedder(
        str(artifact.manifest_path),
        artifact.artifact_version,
    ).encode


def create_onnx_sentence_encoder(
    model_path: Path,
    tokenizer_path: Path,
    manifest: Mapping[str, Any],
):
    """Create the deterministic encoder used by the runtime linker."""
    return _OnnxSentenceEncoder(model_path, tokenizer_path, manifest)


@lru_cache(maxsize=2)
def _load_onnx_embedder(manifest_path: str, artifact_version: str):
    artifact = load_whitebox_artifact(
        manifest_path,
        expected_type=LINKER_ARTIFACT_TYPE,
        required_files=(LINKER_INDEX_FILE,),
    )
    if artifact.artifact_version != artifact_version:
        raise WhiteboxArtifactError("linker artifact changed while loading")
    model_key, tokenizer_key = _onnx_file_keys(artifact)
    validate_artifact_files(artifact, [model_key, tokenizer_key])
    return create_onnx_sentence_encoder(
        artifact.file_path(model_key),
        artifact.file_path(tokenizer_key),
        artifact.manifest,
    )


class _OnnxSentenceEncoder:
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
            raise WhiteboxArtifactError(f"linker ONNX model is invalid: {exc}") from exc
        self.max_length = min(512, max(16, int(manifest.get("maxLength") or 256)))
        self.output_name = str(manifest.get("embeddingOutputName") or "").strip()
        if not self.output_name:
            outputs = self.session.get_outputs()
            if not outputs:
                raise WhiteboxArtifactError("linker ONNX model has no outputs")
            self.output_name = outputs[0].name
        output_names = {output.name for output in self.session.get_outputs()}
        if self.output_name not in output_names:
            raise WhiteboxArtifactError(
                "linker embeddingOutputName is not present in the ONNX model"
            )
        self.pooling = str(manifest.get("pooling") or "mean").strip().lower()
        if self.pooling not in {"mean", "cls", "sentence_embedding"}:
            raise WhiteboxArtifactError("linker pooling must be mean, cls, or sentence_embedding")
        self.dimension = int(manifest.get("dimension") or 0)
        if self.dimension <= 0:
            raise WhiteboxArtifactError("linker manifest dimension must be positive")

    def encode(self, texts: Sequence[str]) -> Sequence[Sequence[float]]:
        if not texts:
            return []
        inputs, _ = encode_batch(
            tokenizer=self.tokenizer,
            texts=texts,
            np=self.np,
            max_length=self.max_length,
        )
        try:
            values = self.session.run(
                [self.output_name],
                session_feeds(self.session, inputs),
            )[0]
        except Exception as exc:  # noqa: BLE001 - external model boundary.
            raise WhiteboxArtifactError(
                f"linker ONNX inference failed: {exc}"
            ) from exc
        embeddings = self.np.asarray(values, dtype=self.np.float32)
        if embeddings.ndim == 3:
            if self.pooling == "cls":
                embeddings = embeddings[:, 0, :]
            elif self.pooling == "mean":
                mask = inputs["attention_mask"].astype(self.np.float32)[..., None]
                denominator = self.np.maximum(mask.sum(axis=1), 1.0)
                embeddings = (embeddings * mask).sum(axis=1) / denominator
            else:
                raise WhiteboxArtifactError(
                    "sentence_embedding pooling requires a rank-2 ONNX output"
                )
        elif embeddings.ndim != 2:
            raise WhiteboxArtifactError("linker ONNX output must have rank 2 or 3")
        if embeddings.shape != (len(texts), self.dimension):
            raise WhiteboxArtifactError(
                "linker ONNX output dimension does not match the manifest"
            )
        norms = self.np.linalg.norm(embeddings, axis=1, keepdims=True)
        if self.np.any(norms == 0):
            raise WhiteboxArtifactError("linker ONNX model returned a zero vector")
        return (embeddings / norms).tolist()


def _onnx_file_keys(artifact: WhiteboxArtifact) -> tuple[str, str]:
    if str(artifact.manifest.get("backend") or "") != "onnx_sentence_encoder":
        raise WhiteboxArtifactError(
            f"unsupported linker backend: {artifact.manifest.get('backend')}"
        )
    model_key = str(artifact.manifest.get("modelFileKey") or "model")
    tokenizer_key = str(artifact.manifest.get("tokenizerFileKey") or "tokenizer")
    try:
        dimension = int(artifact.manifest.get("dimension") or 0)
    except (TypeError, ValueError) as exc:
        raise WhiteboxArtifactError(
            "linker manifest dimension must be positive"
        ) from exc
    if dimension <= 0:
        raise WhiteboxArtifactError("linker manifest dimension must be positive")
    if str(artifact.manifest.get("pooling") or "mean") not in {
        "mean",
        "cls",
        "sentence_embedding",
    }:
        raise WhiteboxArtifactError(
            "linker pooling must be mean, cls, or sentence_embedding"
        )
    return model_key, tokenizer_key


def _link_one(
    span: dict[str, str],
    query_vector: Sequence[float],
    index: LinkerIndex,
    kinds: set[str],
    service_date: str,
    top_k: int,
) -> dict[str, Any]:
    if index.matrix is not None:
        return _link_one_vectorized(span, query_vector, index, kinds, service_date, top_k)
    return _link_one_iterative(span, query_vector, index.entries, kinds, service_date, top_k)


def _link_one_iterative(
    span: dict[str, str],
    query_vector: Sequence[float],
    index: Iterable[dict[str, Any]],
    kinds: set[str],
    service_date: str,
    top_k: int,
) -> dict[str, Any]:
    best_by_code: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in index:
        if kinds and entry["kind"] not in kinds:
            continue
        if not _effective_on(entry, service_date):
            continue
        category_matched = _category_matches(span["category"], entry)
        score = _cosine(query_vector, entry["vector"])
        adjusted_score = score if category_matched else score * CATEGORY_MISMATCH_PENALTY
        candidate = {
            "code": entry["code"],
            "name": entry["name"],
            "kind": entry["kind"],
            "score": round(adjusted_score, 6),
            "rawScore": round(score, 6),
            "matchedDoc": entry["matchedDoc"],
            "categoryMatched": category_matched,
            **({"points": entry["points"]} if entry["points"] is not None else {}),
        }
        key = (entry["kind"], entry["code"])
        current = best_by_code.get(key)
        if current is None or candidate["score"] > current["score"]:
            best_by_code[key] = candidate
    candidates = sorted(
        best_by_code.values(),
        key=lambda item: (-item["score"], item["kind"], item["code"]),
    )[:top_k]
    margin = (
        candidates[0]["score"] - candidates[1]["score"]
        if len(candidates) >= 2
        else candidates[0]["score"] if candidates
        else 0.0
    )
    return {
        "text": span["text"],
        "category": span["category"] or None,
        "margin": round(max(0.0, margin), 6),
        "candidates": candidates,
    }


def _link_one_vectorized(
    span: dict[str, str],
    query_vector: Sequence[float],
    index: LinkerIndex,
    kinds: set[str],
    service_date: str,
    top_k: int,
) -> dict[str, Any]:
    import numpy as np

    query = np.asarray(query_vector, dtype=np.float32)
    if query.ndim != 1 or query.shape[0] != index.matrix.shape[1]:
        raise WhiteboxArtifactError("query vector dimension does not match linker index")
    query_norm = float(np.linalg.norm(query))
    if not query_norm:
        return {
            "text": span["text"],
            "category": span["category"] or None,
            "margin": 0.0,
            "candidates": [],
        }
    raw_scores = (index.matrix @ query) / (index.norms * query_norm)
    valid = np.fromiter(
        (
            (not kinds or entry["kind"] in kinds)
            and _effective_on(entry, service_date)
            for entry in index.entries
        ),
        dtype=np.bool_,
        count=len(index.entries),
    )
    category_matches = np.fromiter(
        (_category_matches(span["category"], entry) for entry in index.entries),
        dtype=np.bool_,
        count=len(index.entries),
    )
    adjusted = np.where(category_matches, raw_scores, raw_scores * CATEGORY_MISMATCH_PENALTY)
    adjusted = np.where(valid, adjusted, -np.inf)
    order = np.argsort(-adjusted, kind="stable")
    best_by_code: dict[tuple[str, str], dict[str, Any]] = {}
    for raw_index in order:
        score = float(adjusted[raw_index])
        if not math.isfinite(score):
            break
        entry = index.entries[int(raw_index)]
        key = (entry["kind"], entry["code"])
        if key in best_by_code:
            continue
        raw_score = float(raw_scores[raw_index])
        best_by_code[key] = {
            "code": entry["code"],
            "name": entry["name"],
            "kind": entry["kind"],
            "score": round(score, 6),
            "rawScore": round(raw_score, 6),
            "matchedDoc": entry["matchedDoc"],
            "categoryMatched": bool(category_matches[raw_index]),
            **({"points": entry["points"]} if entry["points"] is not None else {}),
        }
        if len(best_by_code) >= top_k:
            break
    candidates = list(best_by_code.values())
    margin = (
        candidates[0]["score"] - candidates[1]["score"]
        if len(candidates) >= 2
        else candidates[0]["score"] if candidates
        else 0.0
    )
    return {
        "text": span["text"],
        "category": span["category"] or None,
        "margin": round(max(0.0, margin), 6),
        "candidates": candidates,
    }


def _as_linker_index(entries: Sequence[dict[str, Any]]) -> LinkerIndex:
    normalized = tuple(entries)
    try:
        import numpy as np
    except ImportError:
        return LinkerIndex(entries=normalized, matrix=None, norms=None)
    matrix = np.asarray([entry["vector"] for entry in normalized], dtype=np.float32)
    if matrix.ndim != 2 or not matrix.shape[0] or not matrix.shape[1]:
        raise WhiteboxArtifactError("linker index matrix is invalid")
    norms = np.linalg.norm(matrix, axis=1)
    if np.any(norms == 0):
        raise WhiteboxArtifactError("linker index contains a zero vector")
    return LinkerIndex(entries=normalized, matrix=matrix, norms=norms)


def _normalize_spans(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ValueError("spans must be an array")
    spans: list[dict[str, str]] = []
    for entry in value[:200]:
        if not isinstance(entry, Mapping):
            raise ValueError("span must be an object")
        text = str(entry.get("text") or "").strip()
        if not text:
            raise ValueError("span text is required")
        spans.append({
            "text": text[:500],
            "category": str(entry.get("category") or "").strip(),
        })
    return spans


def _normalize_kinds(value: Any) -> set[str]:
    if value is None:
        return set()
    if not isinstance(value, list):
        raise ValueError("kinds must be an array")
    kinds = {str(item or "").strip() for item in value}
    if not kinds.issubset({"procedure", "drug", "disease"}):
        raise ValueError("kinds contains an unsupported kind")
    return kinds


def _category_matches(span_category: str, entry: Mapping[str, Any]) -> bool:
    if not span_category:
        return True
    entry_category = str(entry.get("category") or "").strip()
    if entry_category:
        return span_category == entry_category
    expected_kind = {
        "medication": "drug",
        "drug": "drug",
        "diagnosis": "disease",
        "disease": "disease",
    }.get(span_category, "procedure")
    return entry.get("kind") == expected_kind


def _effective_on(entry: Mapping[str, Any], service_date: str) -> bool:
    if not service_date:
        return True
    effective_from = str(entry.get("effectiveFrom") or "")
    effective_to = str(entry.get("effectiveTo") or "")
    return (not effective_from or effective_from <= service_date) and (
        not effective_to or service_date <= effective_to
    )


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        raise WhiteboxArtifactError("query vector dimension does not match linker index")
    dot = sum(float(a) * float(b) for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(float(value) ** 2 for value in left))
    right_norm = math.sqrt(sum(float(value) ** 2 for value in right))
    if not left_norm or not right_norm:
        return 0.0
    return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


def _optional_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _bounded_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(maximum, max(minimum, parsed))
