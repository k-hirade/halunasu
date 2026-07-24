"""Deterministic multi-axis context baseline for WX0 E5."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Mapping, Sequence

from experiments.wx0_metrics import (
    classification_metrics,
    coverage_risk_curve,
    expected_calibration_error,
)
from medical_fee_calculation.clinical_axes import (
    AXIS_NAMES,
    clinical_axis_values,
    validate_classifier_result,
)


PAST_PATTERN = re.compile(
    r"(前回|先週|先月|以前|過去|既往|前医|他院|他科|健診|検診|持参|紹介状)"
)
FUTURE_PATTERN = re.compile(r"(次回|予定|予定して|今後|改善なければ|検討)")
NEGATED_PATTERN = re.compile(
    r"(施行せず|実施せず|行わず|未実施|実施なし|中止した|中止済み|不要)"
)
CONSIDERED_PATTERN = re.compile(r"(検討|考慮|必要時)")
ORDERED_PATTERN = re.compile(r"(オーダー|指示した|依頼した|提出予定)")
PRESCRIBED_PATTERN = re.compile(r"(処方|処方箋.*(?:発行|交付))")
ADMINISTERED_PATTERN = re.compile(r"(投与|注入|注射した)")
INSTRUCTION_PATTERN = re.compile(r"(指導|説明|助言|文書交付)")
PERFORMED_PATTERN = re.compile(
    r"(実施|施行|行った|行い|交換した|採取|提出|撮影|測定|評価した)"
)
STOPPED_PATTERN = re.compile(r"(中止|終了|休薬)")
CHANGED_PATTERN = re.compile(r"(変更|増量|減量|切替)")
CONTINUED_PATTERN = re.compile(r"(継続|維持|続行)")
OTHER_PROVIDER_PATTERN = re.compile(r"(前医|他院|他施設|紹介元|かかりつけ)")
OTHER_DEPARTMENT_PATTERN = re.compile(r"(当院他科|院内他科|同院他科)")
PATIENT_REPORTED_PATTERN = re.compile(
    r"(本人(?:より|曰く)|患者(?:より|曰く)|家族(?:より|曰く)|とのこと|と訴え|と話す)"
)
EXTERNAL_DOCUMENT_PATTERN = re.compile(r"(紹介状|診療情報提供書|外部資料)")
CARRIED_RESULT_PATTERN = re.compile(r"(持参(?:した)?(?:結果|資料|画像|検査))")


def span_line_context(
    clinical_text: str,
    char_start: int,
    char_end: int,
    *,
    surrounding_lines: int = 1,
) -> str:
    chars = list(clinical_text)
    if not 0 <= char_start < char_end <= len(chars):
        raise ValueError("span offsets are outside clinicalText")
    lines_with_endings = clinical_text.splitlines(keepends=True) or [clinical_text]
    lines = [line.rstrip("\r\n") for line in lines_with_endings]
    offset = 0
    target_index = 0
    for index, line_with_ending in enumerate(lines_with_endings):
        line_end = offset + len(line_with_ending)
        if char_start < line_end or index == len(lines_with_endings) - 1:
            target_index = index
            break
        offset = line_end
    first = max(0, target_index - surrounding_lines)
    last = min(len(lines), target_index + surrounding_lines + 1)
    return "\n".join(lines[first:last])


def classify_context_baseline(context: str) -> dict[str, dict[str, Any]]:
    text = str(context)
    other_provider = bool(OTHER_PROVIDER_PATTERN.search(text))
    other_department = bool(OTHER_DEPARTMENT_PATTERN.search(text))
    past = bool(PAST_PATTERN.search(text))
    future = bool(FUTURE_PATTERN.search(text))
    negated = bool(NEGATED_PATTERN.search(text))

    if other_provider:
        source_origin = ("other_provider_record", 0.98, False)
        provider_ownership = ("other_provider", 0.98, False)
    elif other_department:
        source_origin = ("own_clinic_record", 0.9, False)
        provider_ownership = (
            "same_institution_other_department",
            0.95,
            False,
        )
    elif CARRIED_RESULT_PATTERN.search(text):
        source_origin = ("carried_in_result", 0.95, False)
        provider_ownership = ("unknown", 0.5, True)
    elif EXTERNAL_DOCUMENT_PATTERN.search(text):
        source_origin = ("external_document", 0.95, False)
        provider_ownership = ("other_provider", 0.9, False)
    elif PATIENT_REPORTED_PATTERN.search(text):
        source_origin = ("patient_reported", 0.9, False)
        provider_ownership = ("unknown", 0.5, True)
    else:
        source_origin = ("own_clinic_record", 0.65, False)
        provider_ownership = ("own_clinic", 0.65, False)

    if past:
        temporal_relation = ("past", 0.95, False)
    elif future:
        temporal_relation = ("future", 0.9, False)
    elif any(
        pattern.search(text)
        for pattern in (
            NEGATED_PATTERN,
            PRESCRIBED_PATTERN,
            ADMINISTERED_PATTERN,
            INSTRUCTION_PATTERN,
            PERFORMED_PATTERN,
            CONTINUED_PATTERN,
            CHANGED_PATTERN,
            STOPPED_PATTERN,
        )
    ):
        temporal_relation = ("current_visit", 0.8, False)
    else:
        temporal_relation = ("unknown", 0.4, True)

    if negated:
        action_status = ("not_performed", 0.98, False)
    elif future and CONSIDERED_PATTERN.search(text):
        action_status = ("considered", 0.9, False)
    elif future:
        action_status = ("planned", 0.85, False)
    elif ORDERED_PATTERN.search(text):
        action_status = ("ordered", 0.85, False)
    elif PRESCRIBED_PATTERN.search(text):
        action_status = ("prescribed", 0.9, False)
    elif ADMINISTERED_PATTERN.search(text):
        action_status = ("administered", 0.9, False)
    elif INSTRUCTION_PATTERN.search(text):
        action_status = ("instruction_only", 0.8, False)
    elif PERFORMED_PATTERN.search(text) or CONTINUED_PATTERN.search(text):
        action_status = ("performed", 0.8, False)
    else:
        action_status = ("unknown", 0.4, True)

    standing_allowed = (
        not past
        and not future
        and not negated
        and source_origin[0] == "own_clinic_record"
        and provider_ownership[0] == "own_clinic"
        and temporal_relation[0] == "current_visit"
        and action_status[0] not in {"ordered", "planned", "considered"}
    )
    if standing_allowed and STOPPED_PATTERN.search(text):
        standing_status = ("stopped", 0.9, False)
    elif standing_allowed and CHANGED_PATTERN.search(text):
        standing_status = ("changed", 0.9, False)
    elif standing_allowed and CONTINUED_PATTERN.search(text):
        standing_status = ("continued", 0.9, False)
    else:
        standing_status = ("none", 0.85, False)

    raw = {
        "actionStatus": action_status,
        "temporalRelation": temporal_relation,
        "sourceOrigin": source_origin,
        "providerOwnership": provider_ownership,
        "standingStatus": standing_status,
    }
    return validate_classifier_result(
        {
            axis: {
                "value": value,
                "confidence": confidence,
                "abstained": abstained,
            }
            for axis, (value, confidence, abstained) in raw.items()
        }
    )


def dangerous_false_positive(
    axis: str,
    truth: str,
    prediction: str | None,
) -> bool:
    if prediction is None:
        return False
    if axis == "actionStatus":
        active = {"performed", "prescribed", "administered", "instruction_only"}
        return truth == "not_performed" and prediction in active
    if axis == "temporalRelation":
        return truth in {"past", "future", "same_day_but_unknown"} and prediction == "current_visit"
    if axis == "sourceOrigin":
        excluded = {
            "patient_reported",
            "external_document",
            "carried_in_result",
            "other_provider_record",
        }
        return truth in excluded and prediction == "own_clinic_record"
    if axis == "providerOwnership":
        return truth == "other_provider" and prediction == "own_clinic"
    if axis == "standingStatus":
        return truth == "none" and prediction in {"continued", "changed", "stopped"}
    return False


def dangerous_negative_truth(axis: str, truth: str) -> bool:
    if axis == "actionStatus":
        return truth == "not_performed"
    if axis == "temporalRelation":
        return truth in {"past", "future", "same_day_but_unknown"}
    if axis == "sourceOrigin":
        return truth in {
            "patient_reported",
            "external_document",
            "carried_in_result",
            "other_provider_record",
        }
    if axis == "providerOwnership":
        return truth == "other_provider"
    if axis == "standingStatus":
        return truth == "none"
    return False


def evaluate_cases(
    cases: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    rows = []
    for case_item in cases:
        for index, span in enumerate(case_item.get("expectedSpans", [])):
            context = span_line_context(
                str(case_item["clinicalText"]),
                int(span["charStart"]),
                int(span["charEnd"]),
            )
            prediction = classify_context_baseline(context)
            rows.append(
                {
                    "caseId": case_item["caseId"],
                    "spanIndex": index,
                    "specialty": case_item["specialty"],
                    "encounterSetting": case_item["encounterSetting"],
                    "truth": {axis: span[axis] for axis in AXIS_NAMES},
                    "prediction": prediction,
                }
            )

    axis_values = clinical_axis_values()
    axis_results = {}
    for axis in AXIS_NAMES:
        truths = [row["truth"][axis] for row in rows]
        predictions = [
            None
            if row["prediction"][axis]["abstained"]
            else row["prediction"][axis]["value"]
            for row in rows
        ]
        metrics = classification_metrics(
            truths,
            predictions,
            labels=axis_values[axis],
        )
        dangerous = sum(
            1
            for truth, prediction in zip(truths, predictions)
            if dangerous_false_positive(axis, truth, prediction)
        )
        dangerous_negative_count = sum(
            1 for truth in truths if dangerous_negative_truth(axis, truth)
        )
        confidences = [
            row["prediction"][axis]["confidence"] for row in rows
        ]
        predicted_values = [
            row["prediction"][axis]["value"] for row in rows
        ]
        axis_results[axis] = {
            **metrics,
            "dangerousFalsePositiveCount": dangerous,
            "dangerousNegativeCount": dangerous_negative_count,
            "dangerousFalsePositiveRate": (
                dangerous / dangerous_negative_count
                if dangerous_negative_count
                else 0
            ),
            "expectedCalibrationError": expected_calibration_error(
                [
                    prediction == truth
                    for truth, prediction in zip(truths, predicted_values)
                ],
                confidences,
            ),
            "coverageRisk": coverage_risk_curve(
                truths,
                predicted_values,
                confidences,
                thresholds=[0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
            ),
        }

    return {
        "schemaVersion": "fee-wx0-context-baseline-result-v1",
        "spanCount": len(rows),
        "axes": axis_results,
        "rows": rows,
    }


def _write_report(result: Mapping[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# WX0 Context Rule Baseline",
        "",
        f"- reviewed spans: {result['spanCount']}",
        "",
        "| axis | macro-F1 | coverage | risk | dangerous FP | ECE |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for axis, metrics in result["axes"].items():
        lines.append(
            f"| {axis} | {metrics['macroF1']:.4f} | {metrics['coverage']:.4f} | "
            f"{metrics['risk']:.4f} | {metrics['dangerousFalsePositiveRate']:.4f} | "
            f"{metrics['expectedCalibrationError']:.4f} |"
        )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/tests/fee-specialty-matrix/cases.json"),
    )
    parser.add_argument("--split", choices=["train", "development", "holdout", "all"], default="holdout")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    cases = [
        item
        for item in dataset.get("cases", [])
        if item.get("annotationStatus") == "reviewed"
        and (args.split == "all" or item.get("split") == args.split)
    ]
    if not cases:
        parser.error(
            "no reviewed cases are available; complete E2 before context measurement"
        )
    result = evaluate_cases(cases)
    _write_report(result, args.output_dir)
    print(
        json.dumps(
            {
                axis: {
                    key: metrics[key]
                    for key in (
                        "macroF1",
                        "coverage",
                        "risk",
                        "dangerousFalsePositiveRate",
                        "expectedCalibrationError",
                    )
                }
                for axis, metrics in result["axes"].items()
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"result={args.output_dir.resolve() / 'result.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
