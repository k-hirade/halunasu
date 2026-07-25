"""Run the licensed GLiNER candidates against the reviewed WX0 corpus."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import random
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from experiments.wx0_metrics import (
    aggregate_count_metrics,
    grouped_metrics,
    latency_summary,
    match_spans,
)


LICENSED_MODELS = {
    "urchade/gliner_multi-v2.1": "Apache-2.0",
    "Ihor/gliner-biomed-small-v1.0": "Apache-2.0",
    "Ihor/gliner-biomed-base-v1.0": "Apache-2.0",
}


def load_evaluation_cases(
    dataset_path: Path,
    split: str,
    *,
    allow_machine_labels: bool = False,
) -> list[dict[str, Any]]:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    return [
        item
        for item in dataset.get("cases", [])
        if (
            item.get("annotationStatus") == "reviewed"
            or (
                allow_machine_labels
                and item.get("annotationStatus") == "pending_review"
                and item.get("experimentalLabelStatus") == "machine_derived"
            )
        )
        and (split == "all" or item.get("split") == split)
    ]


def normalize_predictions(
    predictions: Sequence[Mapping[str, Any]],
    entity_types: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    by_label = {}
    for entity_type in entity_types:
        by_label[str(entity_type["modelLabel"])] = entity_type
        by_label[str(entity_type["label"])] = entity_type
        by_label[str(entity_type["id"])] = entity_type

    normalized = []
    for item in predictions:
        label = str(item.get("label", ""))
        entity_type = by_label.get(label)
        if entity_type is None:
            continue
        start = int(item["start"])
        end = int(item["end"])
        normalized.append(
            {
                "charStart": start,
                "charEnd": end,
                "text": str(item.get("text", "")),
                "category": entity_type["category"],
                "entityTypeId": entity_type["id"],
                "confidence": float(item.get("score", 0)),
            }
        )
    return sorted(
        normalized,
        key=lambda item: (
            item["charStart"],
            item["charEnd"],
            item["category"],
            -item["confidence"],
        ),
    )


def prediction_fingerprint(predictions: Sequence[Mapping[str, Any]]) -> str:
    stable = [
        {
            "charStart": item["charStart"],
            "charEnd": item["charEnd"],
            "category": item["category"],
            "confidence": round(float(item.get("confidence", 0)), 8),
        }
        for item in predictions
    ]
    return hashlib.sha256(
        json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def evaluate_model(
    *,
    cases: Sequence[Mapping[str, Any]],
    entity_types: Sequence[Mapping[str, Any]],
    predict: Callable[[str, list[str], float], Sequence[Mapping[str, Any]]],
    threshold: float,
    repeats: int,
    model_manifest: Mapping[str, Any],
) -> dict[str, Any]:
    labels = [str(item["modelLabel"]) for item in entity_types]
    rows = []
    latencies = []
    determinism_matches = 0
    determinism_total = 0

    for case_item in cases:
        run_predictions = []
        run_fingerprints = []
        for _repeat in range(repeats):
            started = time.perf_counter()
            raw_predictions = predict(
                str(case_item["clinicalText"]),
                labels,
                threshold,
            )
            latencies.append((time.perf_counter() - started) * 1000)
            normalized = normalize_predictions(raw_predictions, entity_types)
            run_predictions.append(normalized)
            run_fingerprints.append(prediction_fingerprint(normalized))

        first_fingerprint = run_fingerprints[0]
        determinism_matches += sum(
            1 for fingerprint in run_fingerprints if fingerprint == first_fingerprint
        )
        determinism_total += len(run_fingerprints)
        metrics = match_spans(
            case_item.get("expectedSpans", []),
            run_predictions[0],
            overlap_threshold=0.5,
            match_fields=("category",),
        )
        rows.append(
            {
                "caseId": case_item["caseId"],
                "specialty": case_item["specialty"],
                "encounterSetting": case_item["encounterSetting"],
                "split": case_item["split"],
                "metrics": metrics,
                "predictionCount": len(run_predictions[0]),
                "deterministic": len(set(run_fingerprints)) == 1,
                "predictions": run_predictions[0],
            }
        )

    label_source_counts: dict[str, int] = {}
    for case_item in cases:
        label_source = (
            "machine_derived"
            if case_item.get("experimentalLabelStatus") == "machine_derived"
            else "human_reviewed"
        )
        label_source_counts[label_source] = label_source_counts.get(label_source, 0) + 1

    return {
        "schemaVersion": "fee-wx0-span-result-v1",
        "notGold": bool(label_source_counts.get("machine_derived")),
        "labelSourceCounts": label_source_counts,
        "model": dict(model_manifest),
        "threshold": threshold,
        "repeatCount": repeats,
        "caseCount": len(cases),
        "overall": aggregate_count_metrics(row["metrics"] for row in rows),
        "byCell": grouped_metrics(
            rows,
            group_fields=("specialty", "encounterSetting"),
        ),
        "determinism": {
            "matchingRuns": determinism_matches,
            "totalRuns": determinism_total,
            "exactMatchRate": (
                determinism_matches / determinism_total
                if determinism_total
                else 0
            ),
            "allCasesDeterministic": all(row["deterministic"] for row in rows),
        },
        "latencyMs": latency_summary(latencies),
        "rows": rows,
    }


def _load_gliner(model_id: str, revision: str):
    try:
        from gliner import GLiNER
    except ImportError as exc:
        raise RuntimeError(
            "GLiNER is not installed. Install python/experiments/requirements-wx0.txt "
            "in an isolated experiment environment."
        ) from exc

    try:
        import torch

        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        torch.use_deterministic_algorithms(True)
        torch.manual_seed(0)
    except (ImportError, RuntimeError):
        pass
    random.seed(0)
    return GLiNER.from_pretrained(model_id, revision=revision)


def _write_report(result: Mapping[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "result.json"
    result_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# WX0 Span Zeroshot Result",
        "",
        f"- model: `{result['model']['id']}@{result['model']['revision']}`",
        f"- license: `{result['model']['license']}`",
        f"- cases: {result['caseCount']}",
        f"- label sources: `{json.dumps(result['labelSourceCounts'], ensure_ascii=False, sort_keys=True)}`",
        f"- gold evaluation: `{'no' if result['notGold'] else 'yes'}`",
        f"- span precision: {result['overall']['precision']:.4f}",
        f"- span recall: {result['overall']['recall']:.4f}",
        f"- span F1: {result['overall']['f1']:.4f}",
        f"- deterministic exact-match rate: {result['determinism']['exactMatchRate']:.4f}",
        f"- latency p50/p95: {result['latencyMs']['p50']:.1f} / {result['latencyMs']['p95']:.1f} ms",
        "",
    ]
    if result["notGold"]:
        lines.extend([
            "> WARNING: This result includes machine-derived labels that were not",
            "> human-reviewed. It is experimental evidence only and must not be used",
            "> to promote a production model or claim gold accuracy.",
            "",
        ])
    lines.extend([
        "## Cell Metrics",
        "",
        "| specialty / setting | precision | recall | F1 |",
        "| --- | ---: | ---: | ---: |",
    ])
    for key, metrics in result["byCell"].items():
        lines.append(
            f"| {key} | {metrics['precision']:.4f} | {metrics['recall']:.4f} | {metrics['f1']:.4f} |"
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
        "--entity-types",
        type=Path,
        default=Path("data/tests/fee-specialty-matrix/entity-types.json"),
    )
    parser.add_argument("--split", choices=["train", "development", "holdout", "all"], default="holdout")
    parser.add_argument("--model", required=True, choices=sorted(LICENSED_MODELS))
    parser.add_argument(
        "--revision",
        required=True,
        help="Immutable model commit SHA; branch names such as main are rejected.",
    )
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--repeats", type=int, default=20)
    parser.add_argument("--max-cases", type=int)
    parser.add_argument(
        "--allow-machine-labels",
        action="store_true",
        help=(
            "Include pending_review cases explicitly marked "
            "experimentalLabelStatus=machine_derived. Results are not gold."
        ),
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    if args.revision in {"main", "master", "latest"} or len(args.revision) < 7:
        parser.error("--revision must be an immutable model commit SHA")
    if not 0 < args.threshold <= 1:
        parser.error("--threshold must be greater than 0 and at most 1")
    if args.repeats < 1:
        parser.error("--repeats must be positive")

    cases = load_evaluation_cases(
        args.dataset,
        args.split,
        allow_machine_labels=args.allow_machine_labels,
    )
    if args.max_cases:
        cases = cases[: args.max_cases]
    if not cases:
        parser.error(
            "no eligible cases are available for the selected split; complete E2 or "
            "explicitly use --allow-machine-labels with a non-gold experimental dataset"
        )
    entity_types_artifact = json.loads(args.entity_types.read_text(encoding="utf-8"))
    entity_types = entity_types_artifact.get("types", [])
    if not entity_types:
        parser.error("entity type artifact contains no types")

    model = _load_gliner(args.model, args.revision)
    result = evaluate_model(
        cases=cases,
        entity_types=entity_types,
        predict=lambda text, labels, threshold: model.predict_entities(
            text,
            labels,
            threshold=threshold,
        ),
        threshold=args.threshold,
        repeats=args.repeats,
        model_manifest={
            "id": args.model,
            "revision": args.revision,
            "license": LICENSED_MODELS[args.model],
            "glinerVersion": importlib.metadata.version("gliner"),
            "entityTypesSource": entity_types_artifact.get("source", {}),
        },
    )
    _write_report(result, args.output_dir)
    print(json.dumps({key: result[key] for key in ("caseCount", "overall", "determinism", "latencyMs")}, indent=2))
    print(f"result={args.output_dir.resolve() / 'result.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
