#!/usr/bin/env python3
"""Build the immutable WX2 master-linker artifact.

The command intentionally requires a local embedding model directory. It does
not download a model or call an external API, so an artifact can be reproduced
and audited from the recorded master/model revisions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sqlite3
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from medical_fee_calculation.name_scan import _scan_aliases
from medical_fee_calculation.whitebox_artifacts import (
    sha256_file,
    validate_artifact_license,
)
from medical_fee_calculation.whitebox_linker import create_onnx_sentence_encoder


INDEX_SCHEMA_VERSION = 2
ARTIFACT_TYPE = "fee_master_linker"

PROCEDURE_CATEGORY_BY_ALPHA_PART = {
    "A": "outpatient_basic",
    "B": "management",
    "C": "management",
    "D": "lab",
    "E": "imaging",
    "F": "medication",
    "G": "injection",
    "H": "treatment",
    "I": "counseling",
    "J": "procedure",
    "K": "procedure",
    "L": "procedure",
    "M": "treatment",
    "N": "pathology",
    "O": "other",
}


def collect_master_documents(master_db: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    connection = sqlite3.connect(f"file:{master_db.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    documents: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    try:
        procedure_source = _latest_source(connection, "medical_procedure_master")
        if procedure_source is None:
            raise ValueError("medical_procedure_master source is missing")
        sources.append(dict(procedure_source))
        rows = connection.execute(
            """
            SELECT code, short_name, base_name, alpha_part, points,
                   effective_from, effective_to
            FROM medical_procedures
            WHERE source_id = ?
            ORDER BY code
            """,
            (procedure_source["id"],),
        )
        for row in rows:
            aliases = (
                alias
                for value in (row["short_name"], row["base_name"])
                if value
                for alias in _scan_aliases(str(value))
            )
            documents.extend(_document_rows(
                code=row["code"],
                name=row["short_name"],
                kind="procedure",
                docs=[_embedding_document(row["short_name"], aliases)],
                category=PROCEDURE_CATEGORY_BY_ALPHA_PART.get(
                    str(row["alpha_part"] or "").strip().upper(),
                    "procedure",
                ),
                points=row["points"],
                effective_from=row["effective_from"],
                effective_to=row["effective_to"],
            ))

        drug_source = _latest_source(connection, "drug_master")
        if drug_source is not None:
            sources.append(dict(drug_source))
            rows = connection.execute(
                """
                SELECT code, name, kana, base_name, generic_prescription_text,
                       changed_at, discontinued_at
                FROM drugs
                WHERE source_id = ?
                ORDER BY code
                """,
                (drug_source["id"],),
            )
            for row in rows:
                aliases = (
                    str(value)
                    for value in (
                        row["name"],
                        row["kana"],
                        row["base_name"],
                        row["generic_prescription_text"],
                    )
                    if value
                )
                documents.extend(_document_rows(
                    code=row["code"],
                    name=row["name"],
                    kind="drug",
                    docs=[_embedding_document(row["name"], aliases)],
                    category="medication",
                    effective_from=row["changed_at"],
                    effective_to=row["discontinued_at"],
                ))

        disease_source = connection.execute(
            """
            SELECT source_id AS id, COUNT(*) AS row_count
            FROM diseases
            GROUP BY source_id
            ORDER BY row_count DESC, source_id DESC
            LIMIT 1
            """
        ).fetchone()
        if disease_source is not None:
            source = connection.execute(
                """
                SELECT id, source_type, source_version, checksum_sha256, imported_at
                FROM master_sources
                WHERE id = ?
                """,
                (disease_source["id"],),
            ).fetchone()
            if source is not None:
                sources.append(dict(source))
            rows = connection.execute(
                """
                SELECT code, name, name_kana, icd10, effective_from, effective_to
                FROM diseases
                WHERE source_id = ?
                ORDER BY code
                """,
                (disease_source["id"],),
            )
            for row in rows:
                if not row["name"]:
                    continue
                aliases = (
                    str(value)
                    for value in (row["name"], row["name_kana"], row["icd10"])
                    if value
                )
                documents.extend(_document_rows(
                    code=row["code"],
                    name=row["name"],
                    kind="disease",
                    docs=[_embedding_document(row["name"], aliases)],
                    category="diagnosis",
                    effective_from=row["effective_from"],
                    effective_to=row["effective_to"],
                ))
    finally:
        connection.close()
    documents.sort(key=lambda item: (item["kind"], item["code"], item["doc"]))
    return documents, sources


def build_linker_artifact(
    *,
    master_db: Path,
    model_dir: Path,
    onnx_model: Path | None,
    tokenizer: Path | None,
    output_dir: Path,
    model_version: str,
    model_revision: str,
    license_model_id: str,
    license_name: str,
    license_verified_at: str,
    license_source_url: str,
    embedder: Callable[[Sequence[str]], Sequence[Sequence[float]]] | None = None,
    batch_size: int = 256,
    embedding_output_name: str = "",
    pooling: str = "mean",
    max_length: int = 256,
    query_prefix: str = "",
    document_prefix: str = "",
) -> Path:
    license_record = validate_artifact_license({
        "license": {
            "modelId": license_model_id,
            "license": license_name,
            "verifiedAt": license_verified_at,
            "sourceUrl": license_source_url,
        }
    })
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError(f"output directory must be empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    if not master_db.is_file():
        raise ValueError(f"master database is missing: {master_db}")
    if not model_dir.is_dir():
        raise ValueError(f"embedding model directory is missing: {model_dir}")
    onnx_model_path = _resolve_runtime_file(
        onnx_model,
        model_dir,
        "model.onnx",
        "ONNX model",
    )
    tokenizer_path = _resolve_runtime_file(
        tokenizer,
        model_dir,
        "tokenizer.json",
        "tokenizer",
    )
    if pooling not in {"mean", "cls", "sentence_embedding"}:
        raise ValueError("pooling must be mean, cls, or sentence_embedding")
    if not 16 <= max_length <= 512:
        raise ValueError("max_length must be from 16 to 512")
    documents, sources = collect_master_documents(master_db)
    if not documents:
        raise ValueError("master produced no linker documents")

    encoder = embedder or _sentence_transformer_embedder(model_dir)
    document_encoder = _prefixed_embedder(encoder, document_prefix)
    index_path = output_dir / "linker-index.sqlite"
    dimension = _write_index(index_path, documents, document_encoder, batch_size)

    runtime_dir = output_dir / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    runtime_model_path = runtime_dir / "model.onnx"
    runtime_tokenizer_path = runtime_dir / "tokenizer.json"
    shutil.copy2(onnx_model_path, runtime_model_path)
    shutil.copy2(tokenizer_path, runtime_tokenizer_path)

    index_sha = sha256_file(index_path)
    model_sha = sha256_file(runtime_model_path)
    tokenizer_sha = sha256_file(runtime_tokenizer_path)
    runtime_encoder = create_onnx_sentence_encoder(
        runtime_model_path,
        runtime_tokenizer_path,
        {
            "maxLength": max_length,
            "embeddingOutputName": embedding_output_name,
            "pooling": pooling,
            "dimension": dimension,
        },
    )
    probe_texts = [item["doc"] for item in documents[: min(8, len(documents))]]
    runtime_parity = _validate_runtime_embedding_parity(
        encoder([f"{query_prefix}{text}" for text in probe_texts]),
        runtime_encoder.encode([f"{query_prefix}{text}" for text in probe_texts]),
    )
    source_fingerprint = hashlib.sha256(
        json.dumps(sources, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    license_fingerprint = json.dumps(
        license_record,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    artifact_version = hashlib.sha256(
        (
            f"{INDEX_SCHEMA_VERSION}:{model_revision}:{index_sha}:{model_sha}:"
            f"{tokenizer_sha}:{source_fingerprint}:{license_fingerprint}"
        ).encode("utf-8")
    ).hexdigest()[:24]
    manifest = {
        "schemaVersion": 1,
        "artifactType": ARTIFACT_TYPE,
        "artifactVersion": artifact_version,
        "indexVersion": artifact_version,
        "indexSchemaVersion": INDEX_SCHEMA_VERSION,
        "modelVersion": model_version,
        "modelRevision": model_revision,
        "license": license_record,
        "backend": "onnx_sentence_encoder",
        "modelFileKey": "model",
        "tokenizerFileKey": "tokenizer",
        "embeddingOutputName": embedding_output_name,
        "pooling": pooling,
        "maxLength": max_length,
        "queryPrefix": query_prefix,
        "documentPrefix": document_prefix,
        "dimension": dimension,
        "documentCount": len(documents),
        "runtimeParity": runtime_parity,
        "sourceMasterSha256": sha256_file(master_db),
        "sourceFingerprint": source_fingerprint,
        "sources": sources,
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "files": {
            "index": {
                "path": index_path.name,
                "sha256": index_sha,
            },
            "model": {
                "path": runtime_model_path.relative_to(output_dir).as_posix(),
                "sha256": model_sha,
            },
            "tokenizer": {
                "path": runtime_tokenizer_path.relative_to(output_dir).as_posix(),
                "sha256": tokenizer_sha,
            },
        },
    }
    manifest_path = output_dir / "linker_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def _write_index(
    index_path: Path,
    documents: Sequence[dict[str, Any]],
    embedder: Callable[[Sequence[str]], Sequence[Sequence[float]]],
    batch_size: int,
) -> int:
    try:
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("numpy is required to build the linker index") from exc
    connection = sqlite3.connect(str(index_path))
    dimension = 0
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL;
            CREATE TABLE linker_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE linker_embeddings (
                code TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                doc TEXT NOT NULL,
                category TEXT NOT NULL,
                points REAL,
                effective_from TEXT NOT NULL,
                effective_to TEXT NOT NULL,
                vector BLOB NOT NULL,
                PRIMARY KEY(kind, code, doc)
            ) WITHOUT ROWID;
            """
        )
        for start in range(0, len(documents), max(1, batch_size)):
            batch = documents[start:start + max(1, batch_size)]
            vectors = np.asarray(embedder([item["doc"] for item in batch]), dtype=np.float32)
            if vectors.ndim != 2 or vectors.shape[0] != len(batch) or vectors.shape[1] <= 0:
                raise ValueError("embedder returned an invalid matrix")
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            if np.any(norms == 0):
                raise ValueError("embedder returned a zero vector")
            vectors = vectors / norms
            if dimension and vectors.shape[1] != dimension:
                raise ValueError("embedder dimension changed between batches")
            dimension = int(vectors.shape[1])
            connection.executemany(
                """
                INSERT INTO linker_embeddings(
                    code, name, kind, doc, category, points,
                    effective_from, effective_to, vector
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item["code"],
                        item["name"],
                        item["kind"],
                        item["doc"],
                        item["category"],
                        item["points"],
                        item["effectiveFrom"],
                        item["effectiveTo"],
                        vector.astype("<f4", copy=False).tobytes(),
                    )
                    for item, vector in zip(batch, vectors, strict=True)
                ],
            )
        connection.executemany(
            "INSERT INTO linker_metadata(key, value) VALUES (?, ?)",
            [
                ("schema_version", str(INDEX_SCHEMA_VERSION)),
                ("dimension", str(dimension)),
                ("document_count", str(len(documents))),
            ],
        )
        connection.commit()
    finally:
        connection.close()
    return dimension


def _validate_runtime_embedding_parity(
    reference_vectors: Sequence[Sequence[float]],
    runtime_vectors: Sequence[Sequence[float]],
    *,
    minimum_cosine: float = 0.999,
) -> dict[str, Any]:
    reference = [tuple(float(value) for value in vector) for vector in reference_vectors]
    runtime = [tuple(float(value) for value in vector) for vector in runtime_vectors]
    if not reference or len(reference) != len(runtime):
        raise ValueError(
            "linker build/runtime embedding matrices have incompatible shapes"
        )
    dimension = len(reference[0])
    if (
        dimension <= 0
        or any(len(vector) != dimension for vector in reference)
        or any(len(vector) != dimension for vector in runtime)
    ):
        raise ValueError(
            "linker build/runtime embedding matrices have incompatible shapes"
        )
    similarities = []
    for reference_vector, runtime_vector in zip(reference, runtime, strict=True):
        reference_norm = math.sqrt(sum(value * value for value in reference_vector))
        runtime_norm = math.sqrt(sum(value * value for value in runtime_vector))
        if reference_norm == 0 or runtime_norm == 0:
            raise ValueError("linker build/runtime parity probe returned a zero vector")
        similarity = sum(
            left * right
            for left, right in zip(reference_vector, runtime_vector, strict=True)
        ) / (reference_norm * runtime_norm)
        if not math.isfinite(similarity):
            raise ValueError("linker build/runtime parity probe returned a non-finite value")
        similarities.append(similarity)
    minimum_observed = min(similarities)
    if minimum_observed < minimum_cosine:
        raise ValueError(
            "linker build/runtime embedding spaces do not match "
            f"(minimum cosine={minimum_observed:.6f}, required={minimum_cosine:.6f})"
        )
    return {
        "probeCount": len(reference),
        "minimumCosine": round(minimum_observed, 6),
        "requiredMinimumCosine": minimum_cosine,
    }


def _sentence_transformer_embedder(model_dir: Path):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError("sentence-transformers is required to build the linker index") from exc
    model = SentenceTransformer(str(model_dir), local_files_only=True, device="cpu")

    def encode(texts: Sequence[str]):
        return model.encode(
            list(texts),
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )

    return encode


def _prefixed_embedder(
    embedder: Callable[[Sequence[str]], Sequence[Sequence[float]]],
    prefix: str,
):
    def encode(texts: Sequence[str]):
        return embedder([f"{prefix}{text}" for text in texts])

    return encode


def _resolve_runtime_file(
    configured: Path | None,
    model_dir: Path,
    filename: str,
    label: str,
) -> Path:
    if configured is not None:
        candidate = configured.expanduser().resolve()
        if not candidate.is_file():
            raise ValueError(f"{label} is missing: {candidate}")
        return candidate
    candidates = sorted(path for path in model_dir.rglob(filename) if path.is_file())
    if len(candidates) != 1:
        raise ValueError(
            f"{label} must be specified explicitly; found {len(candidates)} {filename} files"
        )
    return candidates[0]


def _latest_source(connection: sqlite3.Connection, source_type: str):
    return connection.execute(
        """
        SELECT id, source_type, source_version, checksum_sha256, imported_at
        FROM master_sources
        WHERE source_type = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
        """,
        (source_type,),
    ).fetchone()


def _document_rows(
    *,
    code: Any,
    name: Any,
    kind: str,
    docs: Iterable[str],
    category: str = "",
    points: Any = None,
    effective_from: Any = None,
    effective_to: Any = None,
) -> list[dict[str, Any]]:
    normalized_code = str(code or "").strip()
    normalized_name = str(name or "").strip()
    if not normalized_code or not normalized_name:
        return []
    return [
        {
            "code": normalized_code,
            "name": normalized_name,
            "kind": kind,
            "doc": doc,
            "category": str(category or "").strip(),
            "points": float(points) if isinstance(points, (int, float)) else None,
            "effectiveFrom": str(effective_from or "").strip(),
            "effectiveTo": str(effective_to or "").strip(),
        }
        for doc in docs
    ]


def _unique_embedding_aliases(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        text = str(value or "").strip()
        normalized = (
            unicodedata.normalize("NFKC", text)
            .casefold()
            .replace(" ", "")
            .replace("　", "")
        )
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(text)
    return output


def _embedding_document(canonical_name: Any, aliases: Iterable[str]) -> str:
    canonical = str(canonical_name or "").strip()
    values = [canonical, *_unique_embedding_aliases(aliases)]
    return " / ".join(value for value in values if value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-db", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--onnx-model", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--license-model-id", required=True)
    parser.add_argument("--license-name", required=True)
    parser.add_argument("--license-verified-at", required=True)
    parser.add_argument("--license-source-url", required=True)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--embedding-output-name", default="")
    parser.add_argument(
        "--pooling",
        choices=("mean", "cls", "sentence_embedding"),
        default="mean",
    )
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--query-prefix", required=True)
    parser.add_argument("--document-prefix", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = build_linker_artifact(
        master_db=args.master_db,
        model_dir=args.model_dir,
        onnx_model=args.onnx_model,
        tokenizer=args.tokenizer,
        output_dir=args.output_dir,
        model_version=args.model_version,
        model_revision=args.model_revision,
        license_model_id=args.license_model_id,
        license_name=args.license_name,
        license_verified_at=args.license_verified_at,
        license_source_url=args.license_source_url,
        batch_size=args.batch_size,
        embedding_output_name=args.embedding_output_name,
        pooling=args.pooling,
        max_length=args.max_length,
        query_prefix=args.query_prefix,
        document_prefix=args.document_prefix,
    )
    print(manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
