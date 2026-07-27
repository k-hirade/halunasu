#!/usr/bin/env python3
"""Train and export a runtime-compatible WX3 five-axis context classifier."""

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

from experiments.wx0_context_baseline import (
    dangerous_false_positive,
    dangerous_negative_truth,
)
from experiments.wx0_metrics import (
    classification_metrics,
    expected_calibration_error,
)
from medical_fee_calculation.clinical_axes import AXIS_NAMES, clinical_axis_values
from medical_fee_calculation.whitebox_artifacts import (
    load_whitebox_artifact,
    sha256_file,
)
from medical_fee_calculation.whitebox_context import (
    CONTEXT_SEMANTIC_PROBE_ITEM,
    LEGACY_INPUT_CONTRACT_VERSION,
    STRUCTURED_INPUT_CONTRACT_VERSION,
    _OnnxContextRuntime,
    _validate_context_semantic_probe,
    _validate_context_manifest,
)
from medical_fee_calculation.whitebox_onnx import verify_deterministic_inference
from scripts.whitebox_training_common import (
    WhiteboxTrainingError,
    artifact_file_entry,
    assert_no_counterexample_training_leakage,
    atomic_artifact_directory,
    build_license_record,
    configure_determinism,
    context_text_for_span,
    dependency_modules,
    ensure_registry_output,
    load_training_partitions,
    validate_artifact_version,
    validate_model_revision,
    write_json,
)


DEFAULT_DATASET = Path("data/tests/fee-specialty-matrix/training-view.json")
DEFAULT_COUNTEREXAMPLES = Path("data/tests/counterexamples/counterexample-cases.json")
DEFAULT_REPORT_ROOT = Path("docs/whitebox-artifact-builds")
DETERMINISM_REPEAT_COUNT = 100


@dataclass(frozen=True)
class ContextExample:
    case_id: str
    span_index: int
    text: str
    labels: dict[str, str]


def build_context_examples(
    cases: Sequence[Mapping[str, Any]],
    axis_labels: Mapping[str, Sequence[str]],
    *,
    input_contract_version: int = LEGACY_INPUT_CONTRACT_VERSION,
) -> list[ContextExample]:
    examples = []
    for case in cases:
        for span_index, span in enumerate(case.get("expectedSpans", [])):
            labels = {}
            for axis in AXIS_NAMES:
                value = str(span.get(axis) or "")
                if value not in axis_labels[axis]:
                    raise WhiteboxTrainingError(
                        f"{case.get('caseId')}: unsupported {axis} label {value!r}"
                    )
                labels[axis] = value
            examples.append(ContextExample(
                case_id=str(case["caseId"]),
                span_index=span_index,
                text=context_text_for_span(
                    case,
                    span,
                    input_contract_version=input_contract_version,
                ),
                labels=labels,
            ))
    if not examples:
        raise WhiteboxTrainingError("context training examples are empty")
    return examples


def create_model(
    torch,
    transformers,
    *,
    model_id: str,
    revision: str,
    axis_labels,
    pooling: str,
):
    encoder = transformers.AutoModel.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=False,
    )
    hidden_size = int(encoder.config.hidden_size)

    class ContextClassifier(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = encoder
            self.heads = torch.nn.ModuleDict({
                axis: torch.nn.Linear(hidden_size, len(axis_labels[axis]))
                for axis in AXIS_NAMES
            })

        def forward(self, input_ids, attention_mask):
            hidden = self.encoder(
                input_ids=input_ids,
                attention_mask=attention_mask,
            ).last_hidden_state
            if pooling == "mean":
                mask = attention_mask.unsqueeze(-1).to(dtype=hidden.dtype)
                pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp_min(1.0)
            else:
                pooled = hidden[:, 0, :]
            return tuple(self.heads[axis](pooled) for axis in AXIS_NAMES)

    return ContextClassifier()


def class_weight_values(
    label_indexes: Sequence[int],
    *,
    class_count: int,
    strategy: str,
) -> list[float]:
    counts = [0] * class_count
    for index in label_indexes:
        if index < 0 or index >= class_count:
            raise WhiteboxTrainingError("class weight label index is outside the axis")
        counts[index] += 1
    if strategy == "none":
        return [1.0] * class_count
    if strategy != "sqrt_inverse":
        raise WhiteboxTrainingError(f"unsupported class weighting strategy: {strategy}")
    raw = [
        1.0 / math.sqrt(count) if count else 0.0
        for count in counts
    ]
    nonzero = [weight for weight in raw if weight > 0]
    if not nonzero:
        raise WhiteboxTrainingError("class weighting requires at least one label")
    scale = len(nonzero) / sum(nonzero)
    return [weight * scale for weight in raw]


def build_loss_functions(
    train_encoded: Mapping[str, Any],
    *,
    axis_labels: Mapping[str, Sequence[str]],
    strategy: str,
    torch,
) -> tuple[dict[str, Any], dict[str, list[float]]]:
    weights = {
        axis: class_weight_values(
            [int(value) for value in train_encoded["labels"][axis].tolist()],
            class_count=len(axis_labels[axis]),
            strategy=strategy,
        )
        for axis in AXIS_NAMES
    }
    return (
        {
            axis: torch.nn.CrossEntropyLoss(
                weight=torch.tensor(weights[axis], dtype=torch.float32)
            )
            for axis in AXIS_NAMES
        },
        weights,
    )


def encode_examples(
    tokenizer,
    examples: Sequence[ContextExample],
    *,
    axis_labels: Mapping[str, Sequence[str]],
    max_length: int,
    torch,
) -> dict[str, Any]:
    encoded = tokenizer(
        [example.text for example in examples],
        max_length=max_length,
        padding="max_length",
        truncation=True,
        return_tensors="pt",
    )
    label_indexes = {
        axis: {label: index for index, label in enumerate(axis_labels[axis])}
        for axis in AXIS_NAMES
    }
    return {
        "input_ids": encoded["input_ids"],
        "attention_mask": encoded["attention_mask"],
        "labels": {
            axis: torch.tensor(
                [label_indexes[axis][example.labels[axis]] for example in examples],
                dtype=torch.long,
            )
            for axis in AXIS_NAMES
        },
    }


def train_model(
    model,
    train_encoded: Mapping[str, Any],
    development_encoded: Mapping[str, Any],
    *,
    loss_functions: Mapping[str, Any],
    torch,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    seed: int,
) -> dict[str, Any]:
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
    sample_count = int(train_encoded["input_ids"].shape[0])
    best_state = None
    best_development_loss = math.inf
    history = []
    for epoch in range(epochs):
        model.train()
        generator = torch.Generator().manual_seed(seed + epoch)
        order = torch.randperm(sample_count, generator=generator)
        train_loss = 0.0
        batch_count = 0
        for start in range(0, sample_count, batch_size):
            indexes = order[start:start + batch_size]
            optimizer.zero_grad(set_to_none=True)
            outputs = model(
                train_encoded["input_ids"][indexes],
                train_encoded["attention_mask"][indexes],
            )
            loss = sum(
                loss_functions[axis](
                    outputs[axis_index],
                    train_encoded["labels"][axis][indexes],
                )
                for axis_index, axis in enumerate(AXIS_NAMES)
            ) / len(AXIS_NAMES)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += float(loss.detach())
            batch_count += 1
        development_loss = context_loss(
            model,
            development_encoded,
            loss_functions=loss_functions,
            torch=torch,
        )
        history.append({
            "epoch": epoch + 1,
            "trainLoss": train_loss / max(1, batch_count),
            "developmentLoss": development_loss,
        })
        print(
            "WX3 epoch "
            f"{epoch + 1}/{epochs}: "
            f"train_loss={history[-1]['trainLoss']:.6f} "
            f"development_loss={development_loss:.6f}",
            file=sys.stderr,
            flush=True,
        )
        if development_loss < best_development_loss:
            best_development_loss = development_loss
            best_state = copy.deepcopy(model.state_dict())
    if best_state is None:
        raise WhiteboxTrainingError("WX3 did not produce a model checkpoint")
    model.load_state_dict(best_state)
    return {
        "history": history,
        "selectedEpoch": min(history, key=lambda item: item["developmentLoss"])["epoch"],
        "selectedDevelopmentLoss": best_development_loss,
    }


def context_loss(
    model,
    encoded: Mapping[str, Any],
    *,
    loss_functions: Mapping[str, Any],
    torch,
) -> float:
    model.eval()
    with torch.no_grad():
        outputs = model(encoded["input_ids"], encoded["attention_mask"])
        loss = sum(
            loss_functions[axis](outputs[index], encoded["labels"][axis])
            for index, axis in enumerate(AXIS_NAMES)
        ) / len(AXIS_NAMES)
    return float(loss)


def calibrate_context_runtime(
    runtime: _OnnxContextRuntime,
    examples: Sequence[ContextExample],
    *,
    axis_labels: Mapping[str, Sequence[str]],
    max_risk: float,
    max_dangerous_false_positive_rate: float,
    minimum_covered_count: int,
    minimum_coverage: float,
    torch,
) -> dict[str, Any]:
    logits_by_axis = runtime.predict_logits_preformatted_texts(
        [example.text for example in examples]
    )
    axis_results = {}
    thresholds = {}
    temperatures = {}
    for axis in AXIS_NAMES:
        labels = list(axis_labels[axis])
        truths = [example.labels[axis] for example in examples]
        label_indexes = {label: index for index, label in enumerate(labels)}
        truth_indexes = torch.tensor(
            [label_indexes[truth] for truth in truths],
            dtype=torch.long,
        )
        logits = torch.tensor(logits_by_axis[axis], dtype=torch.float32)
        if logits.ndim != 2 or tuple(logits.shape) != (len(examples), len(labels)):
            raise WhiteboxTrainingError(
                f"{axis}: WX3 ONNX calibration returned invalid logits"
            )
        temperature = select_temperature(logits, truth_indexes, torch=torch)
        probabilities = torch.softmax(logits / temperature, dim=-1)
        confidence_values, prediction_indexes = probabilities.max(dim=-1)
        raw_predictions = [labels[int(index)] for index in prediction_indexes]
        confidences = [float(value) for value in confidence_values]
        threshold = select_abstain_threshold(
            axis=axis,
            truths=truths,
            predictions=raw_predictions,
            confidences=confidences,
            max_risk=max_risk,
            max_dangerous_false_positive_rate=max_dangerous_false_positive_rate,
            minimum_covered_count=minimum_covered_count,
            minimum_coverage=minimum_coverage,
        )
        predictions = [
            prediction if confidence >= threshold else None
            for prediction, confidence in zip(
                raw_predictions,
                confidences,
                strict=True,
            )
        ]
        metrics = classification_metrics(truths, predictions, labels=labels)
        dangerous_count = sum(
            dangerous_false_positive(axis, truth, prediction)
            for truth, prediction in zip(truths, predictions, strict=True)
        )
        dangerous_denominator = sum(
            dangerous_negative_truth(axis, truth)
            for truth in truths
        )
        ece = expected_calibration_error(
            [
                truth == prediction
                for truth, prediction in zip(truths, raw_predictions, strict=True)
            ],
            confidences,
        )
        thresholds[axis] = threshold
        temperatures[axis] = temperature
        axis_results[axis] = {
            **metrics,
            "dangerousFalsePositiveCount": dangerous_count,
            "dangerousFalsePositiveRate": (
                dangerous_count / dangerous_denominator
                if dangerous_denominator
                else 0.0
            ),
            "expectedCalibrationError": ece,
            "temperature": temperature,
            "abstainThreshold": threshold,
            "coveredCount": sum(confidence >= threshold for confidence in confidences),
            "calibrationExampleCount": len(confidences),
        }
    return {
        "temperatures": dict(temperatures),
        "abstainThresholds": thresholds,
        "axisMetrics": axis_results,
        "calibrationSource": "onnx_runtime",
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


def select_abstain_threshold(
    *,
    axis: str,
    truths: Sequence[str],
    predictions: Sequence[str],
    confidences: Sequence[float],
    max_risk: float,
    max_dangerous_false_positive_rate: float,
    minimum_covered_count: int = 1,
    minimum_coverage: float = 0.0,
) -> float:
    if not (
        len(truths) == len(predictions) == len(confidences)
        and len(truths) > 0
    ):
        raise WhiteboxTrainingError(
            f"{axis}: abstain calibration inputs must be non-empty and aligned"
        )
    required_count = max(
        int(minimum_covered_count),
        math.ceil(len(truths) * float(minimum_coverage)),
    )
    if required_count < 1:
        required_count = 1
    if required_count > len(truths):
        raise WhiteboxTrainingError(
            f"{axis}: required calibration coverage exceeds the development set"
        )
    candidates = {0.0}
    for raw_confidence in confidences:
        confidence = min(1.0, max(0.0, float(raw_confidence)))
        candidates.add(confidence)
        if confidence < 1.0:
            candidates.add(math.nextafter(confidence, math.inf))
    for threshold in sorted(candidates):
        covered = [
            (truth, prediction)
            for truth, prediction, confidence in zip(
                truths,
                predictions,
                confidences,
                strict=True,
            )
            if confidence >= threshold
        ]
        if len(covered) < required_count:
            continue
        errors = sum(truth != prediction for truth, prediction in covered)
        risk = errors / len(covered)
        dangerous = sum(
            dangerous_false_positive(axis, truth, prediction)
            for truth, prediction in covered
        )
        dangerous_denominator = sum(
            dangerous_negative_truth(axis, truth)
            for truth in truths
        )
        dangerous_rate = (
            dangerous / dangerous_denominator
            if dangerous_denominator
            else 0.0
        )
        if risk <= max_risk and dangerous_rate <= max_dangerous_false_positive_rate:
            return threshold
    raise WhiteboxTrainingError(
        f"{axis}: no non-empty abstain threshold satisfies the safety gates "
        f"with at least {required_count}/{len(truths)} covered examples"
    )


def export_onnx(model, encoded: Mapping[str, Any], model_path: Path, *, torch, opset: int) -> None:
    model.eval()
    output_names = [f"{axis}_logits" for axis in AXIS_NAMES]
    dynamic_axes = {
        "input_ids": {0: "batch", 1: "sequence"},
        "attention_mask": {0: "batch", 1: "sequence"},
        **{output_name: {0: "batch"} for output_name in output_names},
    }
    torch.onnx.export(
        model,
        (
            encoded["input_ids"][:1],
            encoded["attention_mask"][:1],
        ),
        str(model_path),
        input_names=["input_ids", "attention_mask"],
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=opset,
        do_constant_folding=True,
    )


def build_artifact(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[1]
    dataset_path = (repo_root / args.dataset).resolve()
    counterexample_path = (repo_root / args.counterexamples).resolve()
    artifact_version = validate_artifact_version(args.artifact_version)
    model_revision = validate_model_revision(args.model_revision)
    license_record = build_license_record(
        model_id=args.base_model,
        license_name=args.license,
        verified_at=args.license_verified_at,
        source_url=args.license_source_url,
    )
    output_dir = ensure_registry_output(
        args.output_dir or repo_root / "python" / "data" / "whitebox" / f"context-{artifact_version}",
        repo_root=repo_root,
    )
    partitions = load_training_partitions(dataset_path)
    leakage_audit = assert_no_counterexample_training_leakage(
        (*partitions.train, *partitions.development),
        counterexample_path,
    )
    axis_labels = {
        axis: list(values)
        for axis, values in clinical_axis_values().items()
    }
    train_examples = build_context_examples(
        partitions.train,
        axis_labels,
        input_contract_version=args.input_contract_version,
    )
    development_examples = build_context_examples(
        partitions.development,
        axis_labels,
        input_contract_version=args.input_contract_version,
    )
    plan = {
        "artifactType": "fee_context_classifier",
        "backend": "onnx_multi_axis",
        "artifactVersion": artifact_version,
        "baseModel": args.base_model,
        "modelRevision": model_revision,
        "outputDir": str(output_dir),
        "trainCaseCount": len(partitions.train),
        "developmentCaseCount": len(partitions.development),
        "withheldHoldoutCaseCount": len(partitions.holdout_case_ids),
        "trainSpanCount": len(train_examples),
        "developmentSpanCount": len(development_examples),
        "axisLabels": axis_labels,
        "pooling": args.pooling,
        "inputContractVersion": args.input_contract_version,
        "classWeighting": args.class_weighting,
        "minimumCalibrationCoveredCount": args.minimum_calibration_covered_count,
        "minimumCalibrationCoverage": args.minimum_calibration_coverage,
        "counterexampleAudit": leakage_audit,
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
        raise WhiteboxTrainingError("WX3 requires a fast tokenizer")
    model = create_model(
        torch,
        transformers,
        model_id=args.base_model,
        revision=model_revision,
        axis_labels=axis_labels,
        pooling=args.pooling,
    )
    train_encoded = encode_examples(
        tokenizer,
        train_examples,
        axis_labels=axis_labels,
        max_length=args.max_length,
        torch=torch,
    )
    development_encoded = encode_examples(
        tokenizer,
        development_examples,
        axis_labels=axis_labels,
        max_length=args.max_length,
        torch=torch,
    )
    loss_functions, class_weights = build_loss_functions(
        train_encoded,
        axis_labels=axis_labels,
        strategy=args.class_weighting,
        torch=torch,
    )
    selection = train_model(
        model,
        train_encoded,
        development_encoded,
        loss_functions=loss_functions,
        torch=torch,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        seed=args.seed,
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
        output_names = {
            axis: f"{axis}_logits"
            for axis in AXIS_NAMES
        }
        provisional_manifest = {
            "maxLength": args.max_length,
            "inputContractVersion": args.input_contract_version,
            "axisLabels": axis_labels,
            "outputNames": output_names,
            "temperatures": {
                axis: 1.0
                for axis in AXIS_NAMES
            },
            "abstainThresholds": {
                axis: 0.0
                for axis in AXIS_NAMES
            },
        }
        runtime = _OnnxContextRuntime(
            model_path,
            tokenizer_path,
            provisional_manifest,
        )
        calibration = calibrate_context_runtime(
            runtime,
            development_examples,
            axis_labels=axis_labels,
            max_risk=args.max_risk,
            max_dangerous_false_positive_rate=args.max_dangerous_false_positive_rate,
            minimum_covered_count=args.minimum_calibration_covered_count,
            minimum_coverage=args.minimum_calibration_coverage,
            torch=torch,
        )
        manifest = {
            "schemaVersion": 1,
            "artifactType": "fee_context_classifier",
            "artifactVersion": artifact_version,
            "modelVersion": args.base_model,
            "modelRevision": model_revision,
            "backend": "onnx_multi_axis",
            "license": license_record,
            "modelFileKey": "model",
            "tokenizerFileKey": "tokenizer",
            "maxLength": args.max_length,
            "inputContractVersion": args.input_contract_version,
            "axisLabels": axis_labels,
            "outputNames": output_names,
            "temperatures": calibration["temperatures"],
            "abstainThresholds": calibration["abstainThresholds"],
            "training": {
                "syntheticOnly": True,
                "trainCaseCount": len(partitions.train),
                "developmentCaseCount": len(partitions.development),
                "withheldHoldoutCaseCount": len(partitions.holdout_case_ids),
                "datasetSha256": partitions.source_sha256,
                "trainingViewSha256": partitions.training_view_sha256,
                "counterexampleDatasetSha256": leakage_audit["sourceSha256"],
                "counterexampleProtectedTextCount": leakage_audit["protectedTextCount"],
                "epochs": args.epochs,
                "selectedEpoch": selection["selectedEpoch"],
                "batchSize": args.batch_size,
                "learningRate": args.learning_rate,
                "seed": args.seed,
                "pooling": args.pooling,
                "classWeighting": args.class_weighting,
                "classWeights": class_weights,
                "calibrationSource": calibration["calibrationSource"],
                "minimumCalibrationCoveredCount": args.minimum_calibration_covered_count,
                "minimumCalibrationCoverage": args.minimum_calibration_coverage,
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
            expected_type="fee_context_classifier",
        )
        _validate_context_manifest(artifact.manifest)
        runtime = _OnnxContextRuntime(model_path, tokenizer_path, manifest)
        semantic_probe, determinism = verify_deterministic_inference(
            lambda: runtime.classify([{
                **CONTEXT_SEMANTIC_PROBE_ITEM,
                "lineId": "artifact-probe",
                "spanId": "artifact-probe",
            }]),
            label="WX3 artifact build probe",
            repeat_count=DETERMINISM_REPEAT_COUNT,
        )
        _validate_context_semantic_probe(semantic_probe)
        build_report = {
            "schemaVersion": "fee-wx3-build-report-v1",
            "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            **plan,
            "status": "complete",
            "modelSelection": selection,
            "development": calibration,
            "semanticProbe": "passed",
            "determinism": determinism,
            "manifestSha256": sha256_file(manifest_path),
        }
        write_json(temporary / "build-report.json", build_report)

    report_dir = (repo_root / args.report_dir / artifact_version).resolve()
    write_json(report_dir / "result.json", build_report)
    (report_dir / "README.md").write_text(
        markdown_report(build_report),
        encoding="utf-8",
    )
    return build_report


def markdown_report(report: Mapping[str, Any]) -> str:
    lines = [
        "# WX3 Context Artifact Build",
        "",
        f"- artifact: `{report['artifactVersion']}`",
        f"- model: `{report['baseModel']}@{report['modelRevision']}`",
        f"- selected epoch: {report['modelSelection']['selectedEpoch']}",
        f"- pooling: `{report['pooling']}`",
        f"- class weighting: `{report['classWeighting']}`",
        f"- calibration: `{report['development']['calibrationSource']}`",
        f"- train/development: {report['trainCaseCount']} / {report['developmentCaseCount']} cases",
        f"- holdout withheld: {report['withheldHoldoutCaseCount']} cases",
        f"- counterexample texts withheld: {report['counterexampleAudit']['protectedTextCount']}",
        f"- deterministic runs: {report['determinism']['repeatCount']}",
        "",
        "| axis | macro F1 | coverage | risk | dangerous FP | ECE | threshold |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for axis in AXIS_NAMES:
        metrics = report["development"]["axisMetrics"][axis]
        lines.append(
            f"| {axis} | {metrics['macroF1']:.4f} | {metrics['coverage']:.4f} "
            f"| {metrics['risk']:.4f} | {metrics['dangerousFalsePositiveRate']:.4f} "
            f"| {metrics['expectedCalibrationError']:.4f} | {metrics['abstainThreshold']:.6f} |"
        )
    lines.extend([
        "",
        "Holdout labels were not read by the builder. Promotion requires separate holdout and counterexample gates.",
        "",
    ])
    return "\n".join(lines)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--counterexamples", type=Path, default=DEFAULT_COUNTEREXAMPLES)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--license-source-url", required=True)
    parser.add_argument("--license-verified-at", required=True)
    parser.add_argument("--artifact-version", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_ROOT / "wx3")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--pooling", choices=("mean", "cls"), default="mean")
    parser.add_argument(
        "--input-contract-version",
        type=int,
        choices=(
            LEGACY_INPUT_CONTRACT_VERSION,
            STRUCTURED_INPUT_CONTRACT_VERSION,
        ),
        default=LEGACY_INPUT_CONTRACT_VERSION,
        help=(
            "WX3 text contract. Version 1 is the safety-calibrated default; "
            "version 2 is experimental structured-metadata input."
        ),
    )
    parser.add_argument(
        "--class-weighting",
        choices=("sqrt_inverse", "none"),
        default="sqrt_inverse",
    )
    parser.add_argument("--max-risk", type=float, default=0.05)
    parser.add_argument("--max-dangerous-false-positive-rate", type=float, default=0.01)
    parser.add_argument("--minimum-calibration-covered-count", type=int, default=20)
    parser.add_argument("--minimum-calibration-coverage", type=float, default=0.05)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 32 <= args.max_length <= 512:
        parser.error("--max-length must be from 32 to 512")
    if args.epochs < 1 or args.batch_size < 1 or args.learning_rate <= 0:
        parser.error("training hyperparameters must be positive")
    if not 0 <= args.max_risk <= 1:
        parser.error("--max-risk must be from 0 to 1")
    if not 0 <= args.max_dangerous_false_positive_rate <= 1:
        parser.error("--max-dangerous-false-positive-rate must be from 0 to 1")
    if args.minimum_calibration_covered_count < 1:
        parser.error("--minimum-calibration-covered-count must be at least 1")
    if not 0 <= args.minimum_calibration_coverage <= 1:
        parser.error("--minimum-calibration-coverage must be from 0 to 1")
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
