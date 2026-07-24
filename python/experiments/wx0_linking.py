"""Evaluate deterministic name matching and Ruri master linking for WX0."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import sqlite3
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from experiments.wx0_metrics import linking_metrics
from medical_fee_calculation.name_scan import _scan_aliases


LICENSED_EMBEDDING_MODELS = {
    "cl-nagoya/ruri-v3-30m": "Apache-2.0",
    "cl-nagoya/ruri-v3-130m": "Apache-2.0",
    "cl-nagoya/ruri-v3-310m": "Apache-2.0",
}

LICENSED_RERANKER_MODELS = {
    "cl-nagoya/ruri-reranker-base": "Apache-2.0",
    "cl-nagoya/ruri-v3-reranker-310m": "Apache-2.0",
}


def normalize_alias(value: str) -> str:
    return (
        unicodedata.normalize("NFKC", str(value or ""))
        .casefold()
        .replace(" ", "")
        .replace("　", "")
    )


def _latest_source_id(conn: sqlite3.Connection, source_type: str) -> int | None:
    row = conn.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
        """,
        (source_type,),
    ).fetchone()
    return int(row["id"]) if row else None


def load_master_documents(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    documents: dict[tuple[str, str], dict[str, Any]] = {}
    try:
        procedure_source = _latest_source_id(conn, "medical_procedure_master")
        if procedure_source is None:
            raise ValueError("medical_procedure_master source is missing")
        for row in conn.execute(
            """
            SELECT code, short_name, base_name, alpha_part
            FROM medical_procedures
            WHERE source_id = ?
            """,
            (procedure_source,),
        ):
            names = []
            for source_name in (row["short_name"], row["base_name"]):
                if not source_name:
                    continue
                names.extend(_scan_aliases(str(source_name)))
            _merge_document(
                documents,
                kind="procedure",
                code=str(row["code"]),
                canonical_name=str(row["short_name"]),
                aliases=names,
                metadata={"alphaPart": str(row["alpha_part"] or "")},
            )

        drug_source = _latest_source_id(conn, "drug_master")
        if drug_source is not None:
            for row in conn.execute(
                """
                SELECT code, name, kana, base_name, generic_prescription_text
                FROM drugs
                WHERE source_id = ?
                """,
                (drug_source,),
            ):
                aliases = [
                    str(value)
                    for value in (
                        row["name"],
                        row["kana"],
                        row["base_name"],
                        row["generic_prescription_text"],
                    )
                    if value
                ]
                _merge_document(
                    documents,
                    kind="drug",
                    code=str(row["code"]),
                    canonical_name=str(row["name"]),
                    aliases=aliases,
                )

        disease_source = conn.execute(
            """
            SELECT source_id, COUNT(*) AS row_count
            FROM diseases
            GROUP BY source_id
            ORDER BY row_count DESC, source_id DESC
            LIMIT 1
            """
        ).fetchone()
        if disease_source is not None:
            for row in conn.execute(
                """
                SELECT code, name, name_kana, icd10
                FROM diseases
                WHERE source_id = ?
                """,
                (disease_source["source_id"],),
            ):
                if not row["name"]:
                    continue
                aliases = [
                    str(value)
                    for value in (row["name"], row["name_kana"], row["icd10"])
                    if value
                ]
                _merge_document(
                    documents,
                    kind="disease",
                    code=str(row["code"]),
                    canonical_name=str(row["name"]),
                    aliases=aliases,
                )
    finally:
        conn.close()

    return sorted(documents.values(), key=lambda item: (item["kind"], item["code"]))


def _merge_document(
    documents: dict[tuple[str, str], dict[str, Any]],
    *,
    kind: str,
    code: str,
    canonical_name: str,
    aliases: Iterable[str],
    metadata: Mapping[str, Any] | None = None,
) -> None:
    key = (kind, code)
    document = documents.setdefault(
        key,
        {
            "kind": kind,
            "code": code,
            "canonicalName": canonical_name,
            "aliases": [],
            "metadata": dict(metadata or {}),
        },
    )
    seen = {normalize_alias(value) for value in document["aliases"]}
    for alias in aliases:
        text = str(alias).strip()
        normalized = normalize_alias(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        document["aliases"].append(text)
    document["embeddingText"] = " / ".join(
        [document["canonicalName"], *document["aliases"]]
    )


def build_exact_alias_index(
    documents: Sequence[Mapping[str, Any]],
) -> dict[str, list[dict[str, str]]]:
    index: dict[str, list[dict[str, str]]] = defaultdict(list)
    for document in documents:
        aliases = [document["canonicalName"], *document.get("aliases", [])]
        for alias in aliases:
            normalized = normalize_alias(str(alias))
            if not normalized:
                continue
            candidate = {
                "code": str(document["code"]),
                "kind": str(document["kind"]),
            }
            if candidate not in index[normalized]:
                index[normalized].append(candidate)
    for candidates in index.values():
        candidates.sort(key=lambda item: (item["kind"], item["code"]))
    return dict(index)


def exact_alias_candidates(
    query: str,
    alias_index: Mapping[str, Sequence[Mapping[str, str]]],
) -> list[dict[str, Any]]:
    return [
        {**candidate, "score": 1.0, "source": "exact_alias"}
        for candidate in alias_index.get(normalize_alias(query), [])
    ]


def load_linking_queries(dataset_path: Path, split: str) -> list[dict[str, Any]]:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    queries = []
    for case_item in dataset.get("cases", []):
        if case_item.get("annotationStatus") != "reviewed":
            continue
        if split != "all" and case_item.get("split") != split:
            continue
        for span in case_item.get("expectedSpans", []):
            queries.append(
                {
                    "caseId": case_item["caseId"],
                    "specialty": case_item["specialty"],
                    "encounterSetting": case_item["encounterSetting"],
                    "text": span["text"],
                    "category": span["category"],
                    "expectedCodes": [str(span["code"])],
                }
            )
    return queries


def evaluate_candidate_rows(
    queries: Sequence[Mapping[str, Any]],
    candidate_rows: Sequence[Sequence[Mapping[str, Any]]],
) -> dict[str, Any]:
    if len(queries) != len(candidate_rows):
        raise ValueError("queries and candidate_rows must have equal length")
    rows = [
        {
            **query,
            "candidates": [dict(candidate) for candidate in candidates],
        }
        for query, candidates in zip(queries, candidate_rows)
    ]
    overall = linking_metrics(rows)
    grouped: dict[str, Any] = {}
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[f"{row['specialty']}|{row['encounterSetting']}"].append(row)
    for key, group in sorted(groups.items()):
        grouped[key] = linking_metrics(group)
    return {"overall": overall, "byCell": grouped, "rows": rows}


def _semantic_candidates(
    *,
    documents: Sequence[Mapping[str, Any]],
    queries: Sequence[Mapping[str, Any]],
    model_id: str,
    revision: str,
    top_k: int,
    query_prefix: str,
    document_prefix: str,
) -> tuple[list[list[dict[str, Any]]], dict[str, Any]]:
    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError(
            "sentence-transformers is not installed. Install "
            "python/experiments/requirements-wx0.txt in an isolated environment."
        ) from exc

    model = SentenceTransformer(model_id, revision=revision, device="cpu")
    document_texts = [
        f"{document_prefix}{document['embeddingText']}" for document in documents
    ]
    query_texts = [f"{query_prefix}{query['text']}" for query in queries]
    document_vectors = model.encode(
        document_texts,
        batch_size=128,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )
    query_vectors = model.encode(
        query_texts,
        batch_size=128,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )

    results = []
    resolved_k = min(top_k, len(documents))
    for vector in query_vectors:
        scores = document_vectors @ vector
        indexes = np.argpartition(scores, -resolved_k)[-resolved_k:]
        indexes = indexes[np.argsort(scores[indexes])[::-1]]
        results.append(
            [
                {
                    "code": documents[int(index)]["code"],
                    "kind": documents[int(index)]["kind"],
                    "name": documents[int(index)]["canonicalName"],
                    "documentText": documents[int(index)]["embeddingText"],
                    "score": float(scores[int(index)]),
                    "source": "embedding",
                }
                for index in indexes
            ]
        )
    return results, {
        "sentenceTransformersVersion": importlib.metadata.version(
            "sentence-transformers"
        ),
        "documentCount": len(documents),
        "embeddingDimensions": int(document_vectors.shape[1]),
    }


def _rerank_candidates(
    *,
    queries: Sequence[Mapping[str, Any]],
    candidate_rows: Sequence[Sequence[Mapping[str, Any]]],
    model_id: str,
    revision: str,
    query_prefix: str,
    document_prefix: str,
) -> tuple[list[list[dict[str, Any]]], dict[str, Any]]:
    try:
        from sentence_transformers import CrossEncoder
    except ImportError as exc:
        raise RuntimeError(
            "sentence-transformers is not installed. Install "
            "python/experiments/requirements-wx0.txt in an isolated environment."
        ) from exc

    model = CrossEncoder(model_id, revision=revision, device="cpu")
    flattened_pairs = []
    row_lengths = []
    for query, candidates in zip(queries, candidate_rows):
        row_lengths.append(len(candidates))
        flattened_pairs.extend(
            [
                (
                    f"{query_prefix}{query['text']}",
                    f"{document_prefix}{candidate['documentText']}",
                )
                for candidate in candidates
            ]
        )
    scores = model.predict(flattened_pairs, batch_size=64, show_progress_bar=True)
    reranked = []
    offset = 0
    for candidates, row_length in zip(candidate_rows, row_lengths):
        row_scores = scores[offset : offset + row_length]
        offset += row_length
        row = []
        for candidate, score in zip(candidates, row_scores):
            cleaned = {
                key: value
                for key, value in candidate.items()
                if key != "documentText"
            }
            row.append(
                {
                    **cleaned,
                    "embeddingScore": cleaned["score"],
                    "score": float(score),
                    "source": "reranker",
                }
            )
        reranked.append(
            sorted(row, key=lambda item: (-item["score"], item["code"]))
        )
    return reranked, {
        "sentenceTransformersVersion": importlib.metadata.version(
            "sentence-transformers"
        ),
        "pairCount": len(flattened_pairs),
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_report(result: Mapping[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# WX0 Master Linking Result",
        "",
        f"- queries: {result['queryCount']}",
        f"- master documents: {result['master']['documentCount']}",
        "",
        "| backend | recall@1 | recall@5 | MRR | unresolved |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for key in ("exactAlias", "embedding", "reranked"):
        block = result.get(key)
        if not block:
            continue
        metrics = block["overall"]
        lines.append(
            f"| {key} | {metrics['recallAt']['1']:.4f} | "
            f"{metrics['recallAt']['5']:.4f} | {metrics['mrr']:.4f} | "
            f"{metrics['unresolved']} |"
        )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/tests/fee-specialty-matrix/cases.json"),
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("python/data/master/standard-master.sqlite"),
    )
    parser.add_argument("--split", choices=["train", "development", "holdout", "all"], default="holdout")
    parser.add_argument(
        "--backend",
        choices=["exact_alias", "embedding", "both"],
        default="both",
    )
    parser.add_argument(
        "--model",
        choices=sorted(LICENSED_EMBEDDING_MODELS),
        default="cl-nagoya/ruri-v3-30m",
    )
    parser.add_argument("--revision")
    parser.add_argument(
        "--reranker-model",
        choices=sorted(LICENSED_RERANKER_MODELS),
    )
    parser.add_argument("--reranker-revision")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--query-prefix", default="検索クエリ: ")
    parser.add_argument("--document-prefix", default="検索文書: ")
    parser.add_argument("--max-queries", type=int)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    if args.backend in {"embedding", "both"}:
        if (
            not args.revision
            or args.revision in {"main", "master", "latest"}
            or len(args.revision) < 7
        ):
            parser.error("embedding backend requires an immutable --revision commit SHA")
    if args.reranker_model:
        if args.backend == "exact_alias":
            parser.error("--reranker-model requires embedding or both backend")
        if (
            not args.reranker_revision
            or args.reranker_revision in {"main", "master", "latest"}
            or len(args.reranker_revision) < 7
        ):
            parser.error(
                "--reranker-model requires an immutable --reranker-revision commit SHA"
            )
    if args.top_k < 5:
        parser.error("--top-k must be at least 5 to measure recall@5")

    queries = load_linking_queries(args.dataset, args.split)
    if args.max_queries:
        queries = queries[: args.max_queries]
    if not queries:
        parser.error(
            "no reviewed expected spans are available; complete E2 before linking measurement"
        )

    db_path = args.db.expanduser().resolve()
    documents = load_master_documents(db_path)
    result: dict[str, Any] = {
        "schemaVersion": "fee-wx0-linking-result-v1",
        "queryCount": len(queries),
        "master": {
            "path": str(db_path),
            "sha256": _file_sha256(db_path),
            "documentCount": len(documents),
        },
    }

    if args.backend in {"exact_alias", "both"}:
        alias_index = build_exact_alias_index(documents)
        exact_rows = [
            exact_alias_candidates(query["text"], alias_index)
            for query in queries
        ]
        result["exactAlias"] = evaluate_candidate_rows(queries, exact_rows)

    if args.backend in {"embedding", "both"}:
        embedding_rows, runtime = _semantic_candidates(
            documents=documents,
            queries=queries,
            model_id=args.model,
            revision=args.revision,
            top_k=args.top_k,
            query_prefix=args.query_prefix,
            document_prefix=args.document_prefix,
        )
        result["embedding"] = {
            **evaluate_candidate_rows(
                queries,
                [
                    [
                        {
                            key: value
                            for key, value in candidate.items()
                            if key != "documentText"
                        }
                        for candidate in row
                    ]
                    for row in embedding_rows
                ],
            ),
            "model": {
                "id": args.model,
                "revision": args.revision,
                "license": LICENSED_EMBEDDING_MODELS[args.model],
            },
            "runtime": runtime,
        }
        if args.reranker_model:
            reranked_rows, reranker_runtime = _rerank_candidates(
                queries=queries,
                candidate_rows=embedding_rows,
                model_id=args.reranker_model,
                revision=args.reranker_revision,
                query_prefix=args.query_prefix,
                document_prefix=args.document_prefix,
            )
            result["reranked"] = {
                **evaluate_candidate_rows(queries, reranked_rows),
                "model": {
                    "id": args.reranker_model,
                    "revision": args.reranker_revision,
                    "license": LICENSED_RERANKER_MODELS[args.reranker_model],
                },
                "runtime": reranker_runtime,
            }

    _write_report(result, args.output_dir)
    summary = {
        key: value["overall"]
        for key, value in result.items()
        if key in {"exactAlias", "embedding", "reranked"}
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"result={args.output_dir.resolve() / 'result.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
