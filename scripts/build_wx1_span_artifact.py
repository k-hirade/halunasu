#!/usr/bin/env python3
"""Train and export a runtime-compatible WX1 BIO span detector."""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import (
    load_whitebox_artifact,
    sha256_file,
)
from medical_fee_calculation.whitebox_onnx import verify_deterministic_inference
from medical_fee_calculation.whitebox_span import (
    _OnnxSpanRuntime,
    _validate_onnx_manifest,
)
from scripts.whitebox_training_common import (
    WhiteboxTrainingError,
    artifact_file_entry,
    atomic_artifact_directory,
    build_license_record,
    configure_determinism,
    dependency_modules,
    ensure_registry_output,
    load_training_partitions,
    spans_for_line,
    split_text_lines,
    stable_json_sha256,
    validate_artifact_version,
    validate_model_revision,
    write_json,
)


RELEVANCE_LABELS = ("relevant", "irrelevant", "abstain")
DEFAULT_DATASET = Path("data/tests/fee-specialty-matrix/training-view.json")
DEFAULT_ENTITY_TYPES = Path("data/tests/fee-specialty-matrix/entity-types.json")
DEFAULT_REPORT_ROOT = Path("docs/whitebox-artifact-builds")
DETERMINISM_REPEAT_COUNT = 100


@dataclass(frozen=True)
class SpanExample:
    case_id: str
    line_index: int
    text: str
    spans: tuple[dict[str, Any], ...]
    relevance_label: str


def build_span_examples(cases: Sequence[Mapping[str, Any]]) -> list[SpanExample]:
    examples = []
    for case in cases:
        for line in split_text_lines(str(case["clinicalText"])):
            if not line.text.strip():
                continue
            spans = tuple(spans_for_line(case, line))
            examples.append(SpanExample(
                case_id=str(case["caseId"]),
                line_index=line.index,
                text=line.text,
                spans=spans,
                relevance_label="relevant" if spans else "irrelevant",
            ))
    if not examples:
        raise WhiteboxTrainingError("span training examples are empty")
    return examples


def build_token_labels(entity_types: Sequence[str]) -> list[str]:
    categories = sorted({str(value).strip() for value in entity_types if str(value).strip()})
    if not categories:
        raise WhiteboxTrainingError("entity type categories are empty")
    return ["O", *(f"{prefix}-{category}" for category in categories for prefix in ("B", "I"))]


def labels_for_offsets(
    offsets: Sequence[Sequence[int]],
    spans: Sequence[Mapping[str, Any]],
    token_labels: Sequence[str],
) -> list[int]:
    label_index = {label: index for index, label in enumerate(token_labels)}
    labels = []
    active_span_indexes: set[int] = set()
    covered_offsets: dict[int, list[tuple[int, int]]] = {
        index: []
        for index in range(len(spans))
    }
    for raw_start, raw_end in offsets:
        start = int(raw_start)
        end = int(raw_end)
        if end <= start:
            labels.append(-100)
            continue
        overlapping = [
            index
            for index, span in enumerate(spans)
            if int(span["charStart"]) < end and int(span["charEnd"]) > start
        ]
        if len(overlapping) > 1:
            raise WhiteboxTrainingError("overlapping spans cannot be encoded as BIO labels")
        if not overlapping:
            labels.append(label_index["O"])
            continue
        span_index = overlapping[0]
        covered_offsets[span_index].append((start, end))
        category = str(spans[span_index]["category"])
        prefix = "I" if span_index in active_span_indexes else "B"
        active_span_indexes.add(span_index)
        key = f"{prefix}-{category}"
        if key not in label_index:
            raise WhiteboxTrainingError(f"unknown span category: {category}")
        labels.append(label_index[key])
    for span_index, span in enumerate(spans):
        offsets_for_span = covered_offsets[span_index]
        if (
            not offsets_for_span
            or min(start for start, _ in offsets_for_span) > int(span["charStart"])
            or max(end for _, end in offsets_for_span) < int(span["charEnd"])
        ):
            raise WhiteboxTrainingError(
                "labeled span is outside the tokenizer window; increase --max-length "
                "or split the source line"
            )
    return labels


def load_entity_categories(path: Path) -> tuple[list[str], str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    types = payload.get("types") if isinstance(payload, Mapping) else None
    if not isinstance(types, list):
        raise WhiteboxTrainingError("entity type artifact must contain a types array")
    categories = sorted({
        str(item.get("category") or "").strip()
        for item in types
        if isinstance(item, Mapping) and str(item.get("category") or "").strip()
    })
    if not categories:
        raise WhiteboxTrainingError("entity type artifact contains no categories")
    return categories, stable_json_sha256(payload)


def create_model(torch, transformers, *, model_id: str, revision: str, token_label_count: int):
    encoder = transformers.AutoModel.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=False,
    )
    hidden_size = int(encoder.config.hidden_size)

    class SpanDetector(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = encoder
            self.token_classifier = torch.nn.Linear(hidden_size, token_label_count)
            self.relevance_classifier = torch.nn.Linear(hidden_size, len(RELEVANCE_LABELS))

        def forward(self, input_ids, attention_mask):
            hidden = self.encoder(
                input_ids=input_ids,
                attention_mask=attention_mask,
            ).last_hidden_state
            return (
                self.token_classifier(hidden),
                self.relevance_classifier(hidden[:, 0, :]),
            )

    return SpanDetector()


def encode_examples(
    tokenizer,
    examples: Sequence[SpanExample],
    *,
    token_labels: Sequence[str],
    max_length: int,
    torch,
) -> dict[str, Any]:
    texts = [example.text for example in examples]
    encoded = tokenizer(
        texts,
        max_length=max_length,
        padding="max_length",
        truncation=True,
        return_offsets_mapping=True,
        return_tensors="pt",
    )
    if "offset_mapping" not in encoded:
        raise WhiteboxTrainingError("WX1 requires a fast tokenizer with offset mappings")
    label_rows = [
        labels_for_offsets(offsets.tolist(), example.spans, token_labels)
        for offsets, example in zip(encoded["offset_mapping"], examples, strict=True)
    ]
    relevance_index = {label: index for index, label in enumerate(RELEVANCE_LABELS)}
    return {
        "input_ids": encoded["input_ids"],
        "attention_mask": encoded["attention_mask"],
        "token_labels": torch.tensor(label_rows, dtype=torch.long),
        "relevance_labels": torch.tensor(
            [relevance_index[example.relevance_label] for example in examples],
            dtype=torch.long,
        ),
    }


def train_model(
    model,
    train_encoded: Mapping[str, Any],
    development_encoded: Mapping[str, Any],
    *,
    torch,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    seed: int,
) -> list[float]:
    model.train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
    token_loss = torch.nn.CrossEntropyLoss(ignore_index=-100)
    relevance_loss = torch.nn.CrossEntropyLoss()
    sample_count = int(train_encoded["input_ids"].shape[0])
    best_state = None
    best_development_loss = math.inf
    history = []
    for epoch in range(epochs):
        generator = torch.Generator().manual_seed(seed + epoch)
        order = torch.randperm(sample_count, generator=generator)
        epoch_loss = 0.0
        batch_count = 0
        for start in range(0, sample_count, batch_size):
            indexes = order[start:start + batch_size]
            optimizer.zero_grad(set_to_none=True)
            token_logits, relevance_logits = model(
                train_encoded["input_ids"][indexes],
                train_encoded["attention_mask"][indexes],
            )
            loss = token_loss(
                token_logits.reshape(-1, token_logits.shape[-1]),
                train_encoded["token_labels"][indexes].reshape(-1),
            ) + 0.25 * relevance_loss(
                relevance_logits,
                train_encoded["relevance_labels"][indexes],
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_loss += float(loss.detach())
            batch_count += 1
        development_loss = span_loss(
            model,
            development_encoded,
            torch=torch,
        )
        history.append({
            "epoch": epoch + 1,
            "trainLoss": epoch_loss / max(1, batch_count),
            "developmentLoss": development_loss,
        })
        if development_loss < best_development_loss:
            best_development_loss = development_loss
            best_state = copy.deepcopy(model.state_dict())
    if best_state is None:
        raise WhiteboxTrainingError("WX1 did not produce a model checkpoint")
    model.load_state_dict(best_state)
    return {
        "history": history,
        "selectedEpoch": min(history, key=lambda item: item["developmentLoss"])["epoch"],
        "selectedDevelopmentLoss": best_development_loss,
    }


def span_loss(model, encoded: Mapping[str, Any], *, torch) -> float:
    model.eval()
    token_loss = torch.nn.CrossEntropyLoss(ignore_index=-100)
    relevance_loss = torch.nn.CrossEntropyLoss()
    with torch.no_grad():
        token_logits, relevance_logits = model(
            encoded["input_ids"],
            encoded["attention_mask"],
        )
        loss = token_loss(
            token_logits.reshape(-1, token_logits.shape[-1]),
            encoded["token_labels"].reshape(-1),
        ) + 0.25 * relevance_loss(
            relevance_logits,
            encoded["relevance_labels"],
        )
    return float(loss)


def calibrate_span_model(
    model,
    encoded: Mapping[str, Any],
    *,
    token_labels: Sequence[str],
    entity_types: Sequence[str],
    torch,
) -> dict[str, Any]:
    model.eval()
    with torch.no_grad():
        token_logits, relevance_logits = model(
            encoded["input_ids"],
            encoded["attention_mask"],
        )
    token_probabilities = torch.softmax(token_logits, dim=-1).cpu()
    relevance_logits = relevance_logits.cpu()
    truth = encoded["token_labels"].cpu()
    winning_confidences, winning_label_indexes = token_probabilities.max(dim=-1)
    flattened_winners = winning_label_indexes.reshape(-1).tolist()
    flattened_confidences = winning_confidences.reshape(-1).tolist()
    flattened_truth = truth.reshape(-1).tolist()
    entity_thresholds = {}
    entity_metrics = {}
    for category in entity_types:
        category_indexes = [
            index
            for index, label in enumerate(token_labels)
            if label in {f"B-{category}", f"I-{category}"}
        ]
        if not category_indexes:
            continue
        best = {"threshold": 0.5, "f1": -1.0, "precision": 0.0, "recall": 0.0}
        for threshold in (0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90):
            metrics = category_token_metrics(
                predicted_label_indexes=flattened_winners,
                predicted_confidences=flattened_confidences,
                truth_label_indexes=flattened_truth,
                category_indexes=category_indexes,
                threshold=threshold,
            )
            f1 = metrics["f1"]
            if (f1, threshold) > (best["f1"], best["threshold"]):
                best = {
                    "threshold": threshold,
                    **metrics,
                }
        entity_thresholds[category] = best["threshold"]
        entity_metrics[category] = best

    relevance_temperature = select_temperature(
        relevance_logits,
        encoded["relevance_labels"].cpu(),
        torch=torch,
    )
    relevance_prediction = relevance_logits.argmax(dim=-1)
    relevance_accuracy = float(
        (relevance_prediction == encoded["relevance_labels"].cpu()).float().mean()
    )
    return {
        "entityThresholds": entity_thresholds,
        "entityMetrics": entity_metrics,
        "relevanceTemperature": relevance_temperature,
        "relevanceAccuracy": relevance_accuracy,
    }


def category_token_metrics(
    *,
    predicted_label_indexes: Sequence[int],
    predicted_confidences: Sequence[float],
    truth_label_indexes: Sequence[int],
    category_indexes: Sequence[int],
    threshold: float,
    ignored_label_index: int = -100,
) -> dict[str, float | int]:
    if not (
        len(predicted_label_indexes)
        == len(predicted_confidences)
        == len(truth_label_indexes)
    ):
        raise WhiteboxTrainingError("token metric inputs must have equal lengths")
    category_index_set = set(category_indexes)
    tp = fp = fn = 0
    for winner, confidence, truth in zip(
        predicted_label_indexes,
        predicted_confidences,
        truth_label_indexes,
        strict=True,
    ):
        if truth == ignored_label_index:
            continue
        predicted = winner in category_index_set and confidence >= threshold
        expected = truth in category_index_set
        tp += int(predicted and expected)
        fp += int(predicted and not expected)
        fn += int(not predicted and expected)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "f1": f1,
        "precision": precision,
        "recall": recall,
        "truePositiveCount": tp,
        "falsePositiveCount": fp,
        "falseNegativeCount": fn,
    }


def select_temperature(logits, labels, *, torch) -> float:
    best_temperature = 1.0
    best_loss = math.inf
    for raw in range(5, 31):
        temperature = raw / 10
        loss = float(torch.nn.functional.cross_entropy(logits / temperature, labels))
        if loss < best_loss:
            best_loss = loss
            best_temperature = temperature
    return best_temperature


def export_onnx(model, encoded: Mapping[str, Any], model_path: Path, *, torch, opset: int) -> None:
    model.eval()
    torch.onnx.export(
        model,
        (
            encoded["input_ids"][:1],
            encoded["attention_mask"][:1],
        ),
        str(model_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["token_logits", "relevance_logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "token_logits": {0: "batch", 1: "sequence"},
            "relevance_logits": {0: "batch"},
        },
        opset_version=opset,
        do_constant_folding=True,
    )


def build_artifact(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[1]
    dataset_path = (repo_root / args.dataset).resolve()
    entity_types_path = (repo_root / args.entity_types).resolve()
    artifact_version = validate_artifact_version(args.artifact_version)
    model_revision = validate_model_revision(args.model_revision)
    license_record = build_license_record(
        model_id=args.base_model,
        license_name=args.license,
        verified_at=args.license_verified_at,
        source_url=args.license_source_url,
    )
    output_dir = ensure_registry_output(
        args.output_dir or repo_root / "python" / "data" / "whitebox" / f"span-{artifact_version}",
        repo_root=repo_root,
    )
    partitions = load_training_partitions(dataset_path)
    entity_types, entity_types_sha = load_entity_categories(entity_types_path)
    token_labels = build_token_labels(entity_types)
    train_examples = build_span_examples(partitions.train)
    development_examples = build_span_examples(partitions.development)
    plan = {
        "artifactType": "fee_span_detector",
        "backend": "onnx_token_classifier",
        "artifactVersion": artifact_version,
        "baseModel": args.base_model,
        "modelRevision": model_revision,
        "mode": "ft",
        "outputDir": str(output_dir),
        "trainCaseCount": len(partitions.train),
        "developmentCaseCount": len(partitions.development),
        "withheldHoldoutCaseCount": len(partitions.holdout_case_ids),
        "trainLineCount": len(train_examples),
        "developmentLineCount": len(development_examples),
        "entityTypes": entity_types,
        "tokenLabels": token_labels,
        "license": license_record,
    }
    if args.dry_run:
        return {"status": "planned", **plan}

    _, onnx, _, torch, transformers = dependency_modules()
    configure_determinism(args.seed)
    tokenizer = transformers.AutoTokenizer.from_pretrained(
        args.base_model,
        revision=model_revision,
        use_fast=True,
        trust_remote_code=False,
    )
    if not getattr(tokenizer, "is_fast", False):
        raise WhiteboxTrainingError("WX1 requires a fast tokenizer")
    model = create_model(
        torch,
        transformers,
        model_id=args.base_model,
        revision=model_revision,
        token_label_count=len(token_labels),
    )
    train_encoded = encode_examples(
        tokenizer,
        train_examples,
        token_labels=token_labels,
        max_length=args.max_length,
        torch=torch,
    )
    development_encoded = encode_examples(
        tokenizer,
        development_examples,
        token_labels=token_labels,
        max_length=args.max_length,
        torch=torch,
    )
    selection = train_model(
        model,
        train_encoded,
        development_encoded,
        torch=torch,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        seed=args.seed,
    )
    calibration = calibrate_span_model(
        model,
        development_encoded,
        token_labels=token_labels,
        entity_types=entity_types,
        torch=torch,
    )

    with atomic_artifact_directory(output_dir) as temporary:
        model_path = temporary / "model.onnx"
        tokenizer_path = temporary / "tokenizer.json"
        export_onnx(
            model,
            development_encoded,
            model_path,
            torch=torch,
            opset=args.opset,
        )
        onnx.checker.check_model(onnx.load(str(model_path)))
        tokenizer.backend_tokenizer.save(str(tokenizer_path))
        manifest = {
            "schemaVersion": 1,
            "artifactType": "fee_span_detector",
            "artifactVersion": artifact_version,
            "modelVersion": args.base_model,
            "modelRevision": model_revision,
            "backend": "onnx_token_classifier",
            "license": license_record,
            "modelFileKey": "model",
            "tokenizerFileKey": "tokenizer",
            "maxLength": args.max_length,
            "entityTypes": entity_types,
            "tokenLabels": token_labels,
            "tokenLogitsOutputName": "token_logits",
            "relevanceLogitsOutputName": "relevance_logits",
            "relevanceLabels": list(RELEVANCE_LABELS),
            "defaultThreshold": 0.5,
            "entityThresholds": calibration["entityThresholds"],
            "relevanceTemperature": calibration["relevanceTemperature"],
            "training": {
                "syntheticOnly": True,
                "trainCaseCount": len(partitions.train),
                "developmentCaseCount": len(partitions.development),
                "withheldHoldoutCaseCount": len(partitions.holdout_case_ids),
                "datasetSha256": partitions.source_sha256,
                "trainingViewSha256": partitions.training_view_sha256,
                "entityTypesSha256": entity_types_sha,
                "epochs": args.epochs,
                "batchSize": args.batch_size,
                "learningRate": args.learning_rate,
                "seed": args.seed,
            },
            "files": {
                "model": artifact_file_entry(model_path, temporary),
                "tokenizer": artifact_file_entry(tokenizer_path, temporary),
            },
        }
        manifest_path = temporary / "manifest.json"
        write_json(manifest_path, manifest)
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type="fee_span_detector",
        )
        _validate_onnx_manifest(artifact)
        runtime = _OnnxSpanRuntime(model_path, tokenizer_path, manifest)
        _, determinism = verify_deterministic_inference(
            lambda: runtime.detect([{
                "lineId": "artifact-probe",
                "text": development_examples[0].text,
                "section": "unknown",
            }]),
            label="WX1 artifact build probe",
            repeat_count=DETERMINISM_REPEAT_COUNT,
        )
        build_report = {
            "schemaVersion": "fee-wx1-build-report-v1",
            "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            **plan,
            "status": "complete",
            "modelSelection": selection,
            "development": calibration,
            "determinism": determinism,
            "manifestSha256": sha256_file(manifest_path),
        }
        write_json(temporary / "build-report.json", build_report)

    report_dir = (repo_root / args.report_dir / artifact_version).resolve()
    write_json(report_dir / "result.json", build_report)
    (report_dir / "README.md").write_text(
        _markdown_report(build_report),
        encoding="utf-8",
    )
    return build_report


def _markdown_report(report: Mapping[str, Any]) -> str:
    return "\n".join([
        "# WX1 Span Artifact Build",
        "",
        f"- artifact: `{report['artifactVersion']}`",
        f"- model: `{report['baseModel']}@{report['modelRevision']}`",
        f"- selected epoch: {report['modelSelection']['selectedEpoch']}",
        f"- train/development: {report['trainCaseCount']} / {report['developmentCaseCount']} cases",
        f"- holdout withheld: {report['withheldHoldoutCaseCount']} cases",
        f"- relevance accuracy: {report['development']['relevanceAccuracy']:.4f}",
        f"- deterministic runs: {report['determinism']['repeatCount']}",
        "",
        "This report does not evaluate or expose holdout labels. Promotion remains a separate human decision.",
        "",
    ])


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--entity-types", type=Path, default=DEFAULT_ENTITY_TYPES)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--mode", choices=["ft"], default="ft")
    parser.add_argument("--license", required=True)
    parser.add_argument("--license-source-url", required=True)
    parser.add_argument("--license-verified-at", required=True)
    parser.add_argument("--artifact-version", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_ROOT / "wx1")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 32 <= args.max_length <= 512:
        parser.error("--max-length must be from 32 to 512")
    if args.epochs < 1 or args.batch_size < 1 or args.learning_rate <= 0:
        parser.error("training hyperparameters must be positive")
    if args.opset < 13:
        parser.error("--opset must be at least 13")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        result = build_artifact(parse_args(argv))
    except WhiteboxTrainingError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
