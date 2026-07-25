"""Dependency-free metrics shared by WX0 experiments."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable, Mapping, Sequence


def _span_bounds(span: Mapping[str, Any]) -> tuple[int, int]:
    start = span.get("charStart", span.get("start"))
    end = span.get("charEnd", span.get("end"))
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or end <= start
    ):
        raise ValueError(f"invalid span bounds: {start!r}, {end!r}")
    return start, end


def span_overlap_score(
    expected: Mapping[str, Any],
    predicted: Mapping[str, Any],
) -> float:
    """Return character-span intersection over union."""

    expected_start, expected_end = _span_bounds(expected)
    predicted_start, predicted_end = _span_bounds(predicted)
    intersection = max(
        0,
        min(expected_end, predicted_end) - max(expected_start, predicted_start),
    )
    if intersection == 0:
        return 0.0
    union = max(expected_end, predicted_end) - min(expected_start, predicted_start)
    return intersection / union


def _labels_match(
    expected: Mapping[str, Any],
    predicted: Mapping[str, Any],
    match_fields: Sequence[str],
) -> bool:
    for field in match_fields:
        predicted_value = predicted.get(field, predicted.get("label") if field == "category" else None)
        if expected.get(field) != predicted_value:
            return False
    return True


def match_spans(
    expected_spans: Sequence[Mapping[str, Any]],
    predicted_spans: Sequence[Mapping[str, Any]],
    *,
    overlap_threshold: float = 0.5,
    match_fields: Sequence[str] = ("category",),
) -> dict[str, Any]:
    if not 0 < overlap_threshold <= 1:
        raise ValueError("overlap_threshold must be greater than 0 and at most 1")

    adjacency: list[list[tuple[int, float]]] = []
    for expected in expected_spans:
        edges = []
        for predicted_index, predicted in enumerate(predicted_spans):
            if not _labels_match(expected, predicted, match_fields):
                continue
            score = span_overlap_score(expected, predicted)
            if score >= overlap_threshold:
                edges.append((predicted_index, score))
        adjacency.append(sorted(edges, key=lambda item: (-item[1], item[0])))

    predicted_to_expected: dict[int, int] = {}

    def augment(expected_index: int, seen: set[int]) -> bool:
        for predicted_index, _score in adjacency[expected_index]:
            if predicted_index in seen:
                continue
            seen.add(predicted_index)
            prior_expected = predicted_to_expected.get(predicted_index)
            if prior_expected is None or augment(prior_expected, seen):
                predicted_to_expected[predicted_index] = expected_index
                return True
        return False

    for expected_index in range(len(expected_spans)):
        augment(expected_index, set())

    matches = []
    for predicted_index, expected_index in sorted(
        predicted_to_expected.items(),
        key=lambda item: item[1],
    ):
        matches.append(
            {
                "expectedIndex": expected_index,
                "predictedIndex": predicted_index,
                "overlap": span_overlap_score(
                    expected_spans[expected_index],
                    predicted_spans[predicted_index],
                ),
            }
        )

    true_positive = len(matches)
    false_positive = len(predicted_spans) - true_positive
    false_negative = len(expected_spans) - true_positive
    precision = _safe_divide(true_positive, true_positive + false_positive)
    recall = _safe_divide(true_positive, true_positive + false_negative)
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": precision,
        "recall": recall,
        "f1": _f1(precision, recall),
        "matches": matches,
    }


def aggregate_count_metrics(items: Iterable[Mapping[str, Any]]) -> dict[str, float | int]:
    rows = list(items)
    true_positive = sum(int(item.get("truePositive", 0)) for item in rows)
    false_positive = sum(int(item.get("falsePositive", 0)) for item in rows)
    false_negative = sum(int(item.get("falseNegative", 0)) for item in rows)
    precision = _safe_divide(true_positive, true_positive + false_positive)
    recall = _safe_divide(true_positive, true_positive + false_negative)
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": precision,
        "recall": recall,
        "f1": _f1(precision, recall),
    }


def linking_metrics(
    rows: Sequence[Mapping[str, Any]],
    *,
    cutoffs: Sequence[int] = (1, 5),
) -> dict[str, Any]:
    normalized_cutoffs = sorted({int(value) for value in cutoffs if int(value) > 0})
    if not normalized_cutoffs:
        raise ValueError("at least one positive cutoff is required")

    hits = {cutoff: 0 for cutoff in normalized_cutoffs}
    reciprocal_rank_sum = 0.0
    unresolved = 0
    row_results = []

    for index, row in enumerate(rows):
        expected = {
            str(code)
            for code in row.get("expectedCodes", [])
            if str(code).strip()
        }
        if not expected:
            raise ValueError(f"linking row {index} has no expectedCodes")
        candidates = [
            str(item.get("code") if isinstance(item, Mapping) else item)
            for item in row.get("candidates", [])
        ]
        rank = next(
            (position for position, code in enumerate(candidates, start=1) if code in expected),
            None,
        )
        if rank is None:
            unresolved += 1
        else:
            reciprocal_rank_sum += 1 / rank
            for cutoff in normalized_cutoffs:
                if rank <= cutoff:
                    hits[cutoff] += 1
        row_results.append({"index": index, "rank": rank})

    count = len(rows)
    return {
        "count": count,
        "unresolved": unresolved,
        "recallAt": {
            str(cutoff): _safe_divide(hits[cutoff], count)
            for cutoff in normalized_cutoffs
        },
        "mrr": _safe_divide(reciprocal_rank_sum, count),
        "rows": row_results,
    }


def classification_metrics(
    truths: Sequence[str],
    predictions: Sequence[str | None],
    *,
    labels: Sequence[str] | None = None,
) -> dict[str, Any]:
    if len(truths) != len(predictions):
        raise ValueError("truths and predictions must have equal length")
    resolved_labels = list(dict.fromkeys(labels or truths))
    label_set = set(resolved_labels)
    unknown_truths = set(truths) - label_set
    if unknown_truths:
        raise ValueError(f"truth labels are not declared: {sorted(unknown_truths)}")
    unknown_predictions = {
        prediction
        for prediction in predictions
        if prediction is not None and prediction not in label_set
    }
    if unknown_predictions:
        raise ValueError(
            f"prediction labels are not declared: {sorted(unknown_predictions)}"
        )

    confusion = {
        truth: {prediction: 0 for prediction in [*resolved_labels, "__abstain__"]}
        for truth in resolved_labels
    }
    covered = 0
    covered_errors = 0
    correct = 0
    for truth, prediction in zip(truths, predictions):
        key = prediction if prediction is not None else "__abstain__"
        confusion[truth][key] += 1
        if prediction is not None:
            covered += 1
            if prediction == truth:
                correct += 1
            else:
                covered_errors += 1

    per_class = {}
    for label in resolved_labels:
        true_positive = confusion[label][label]
        false_negative = sum(confusion[label].values()) - true_positive
        false_positive = sum(
            confusion[other][label]
            for other in resolved_labels
            if other != label
        )
        precision = _safe_divide(true_positive, true_positive + false_positive)
        recall = _safe_divide(true_positive, true_positive + false_negative)
        per_class[label] = {
            "support": sum(confusion[label].values()),
            "precision": precision,
            "recall": recall,
            "f1": _f1(precision, recall),
        }

    count = len(truths)
    return {
        "count": count,
        "covered": covered,
        "abstained": count - covered,
        "coverage": _safe_divide(covered, count),
        "risk": _safe_divide(covered_errors, covered),
        "accuracyIncludingAbstain": _safe_divide(correct, count),
        "macroF1": _safe_divide(
            sum(item["f1"] for item in per_class.values()),
            len(per_class),
        ),
        "perClass": per_class,
        "confusion": confusion,
    }


def expected_calibration_error(
    correctness: Sequence[bool],
    confidences: Sequence[float],
    *,
    bin_count: int = 10,
) -> float:
    if len(correctness) != len(confidences):
        raise ValueError("correctness and confidences must have equal length")
    if bin_count < 1:
        raise ValueError("bin_count must be positive")
    if not correctness:
        return 0.0

    bins: list[list[tuple[bool, float]]] = [[] for _ in range(bin_count)]
    for correct, confidence in zip(correctness, confidences):
        value = float(confidence)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("confidence must be a finite number from 0 to 1")
        index = min(bin_count - 1, int(value * bin_count))
        bins[index].append((bool(correct), value))

    total = len(correctness)
    error = 0.0
    for entries in bins:
        if not entries:
            continue
        accuracy = sum(1 for correct, _ in entries if correct) / len(entries)
        average_confidence = sum(value for _, value in entries) / len(entries)
        error += len(entries) / total * abs(accuracy - average_confidence)
    return error


def coverage_risk_curve(
    truths: Sequence[str],
    predicted_values: Sequence[str],
    confidences: Sequence[float],
    *,
    thresholds: Sequence[float],
) -> list[dict[str, float]]:
    if not (len(truths) == len(predicted_values) == len(confidences)):
        raise ValueError("truths, predicted_values, and confidences must have equal length")
    points = []
    labels = list(dict.fromkeys([*truths, *predicted_values]))
    for threshold in sorted(set(float(item) for item in thresholds)):
        if not 0 <= threshold <= 1:
            raise ValueError("thresholds must be from 0 to 1")
        predictions = [
            predicted if float(confidence) >= threshold else None
            for predicted, confidence in zip(predicted_values, confidences)
        ]
        metrics = classification_metrics(truths, predictions, labels=labels)
        points.append(
            {
                "threshold": threshold,
                "coverage": metrics["coverage"],
                "risk": metrics["risk"],
            }
        )
    return points


def percentile(values: Sequence[float], probability: float) -> float | None:
    if not values:
        return None
    if not 0 <= probability <= 1:
        raise ValueError("probability must be from 0 to 1")
    ordered = sorted(float(value) for value in values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def latency_summary(values: Sequence[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "min": min(values) if values else None,
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
        "mean": _safe_divide(sum(values), len(values)) if values else None,
    }


def grouped_metrics(
    rows: Sequence[Mapping[str, Any]],
    *,
    group_fields: Sequence[str],
    metric_field: str = "metrics",
) -> dict[str, dict[str, float | int]]:
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        key = "|".join(str(row.get(field, "unknown")) for field in group_fields)
        groups[key].append(row[metric_field])
    return {
        key: aggregate_count_metrics(group_rows)
        for key, group_rows in sorted(groups.items())
    }


def _safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _f1(precision: float, recall: float) -> float:
    return _safe_divide(2 * precision * recall, precision + recall)
