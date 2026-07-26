#!/usr/bin/env python3
"""Summarize three-lane white-box shadow telemetry and apply a fail-closed gate."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


class WhiteboxPromotionReportError(ValueError):
    """Raised when telemetry or adjudication input is malformed."""


def read_json_records(path: Path) -> list[Mapping[str, Any]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        records = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise WhiteboxPromotionReportError(
                    f"{path}:{line_number}: invalid JSON"
                ) from exc
            if not isinstance(item, Mapping):
                raise WhiteboxPromotionReportError(
                    f"{path}:{line_number}: record must be an object"
                )
            records.append(item)
        return records
    if isinstance(payload, list):
        if not all(isinstance(item, Mapping) for item in payload):
            raise WhiteboxPromotionReportError("telemetry array must contain objects")
        return list(payload)
    if isinstance(payload, Mapping):
        return [payload]
    raise WhiteboxPromotionReportError("telemetry must be a JSON object, array, or NDJSON")


def performance_payloads(records: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    payloads = []
    for record in records:
        payload = record.get("jsonPayload") if isinstance(record.get("jsonPayload"), Mapping) else record
        if payload.get("event") != "fee.calculate.performance":
            continue
        whitebox = payload.get("whiteboxExtraction")
        if not isinstance(whitebox, Mapping):
            continue
        payloads.append(payload)
    return payloads


def filter_payloads_by_run_manifest(
    payloads: Sequence[Mapping[str, Any]],
    run_manifest: Mapping[str, Any] | None,
    *,
    policy: Mapping[str, Any],
) -> tuple[list[Mapping[str, Any]], dict[str, Any] | None]:
    if run_manifest is None:
        return list(payloads), None
    if run_manifest.get("schemaVersion") != "fee-whitebox-shadow-stg-run-v1":
        raise WhiteboxPromotionReportError(
            "run manifest schemaVersion must be fee-whitebox-shadow-stg-run-v1"
        )
    runs = run_manifest.get("runs")
    if not isinstance(runs, list) or not runs:
        raise WhiteboxPromotionReportError("run manifest runs must be a non-empty array")

    expected_session_ids = []
    manifest_cells = Counter()
    manifest_revisions = set()
    manifest_extractor_versions = set()
    for index, run in enumerate(runs):
        if not isinstance(run, Mapping):
            raise WhiteboxPromotionReportError(
                f"run manifest runs[{index}] must be an object"
            )
        session_id = str(run.get("feeSessionId") or "").strip()
        if not session_id:
            raise WhiteboxPromotionReportError(
                f"run manifest runs[{index}].feeSessionId is required"
            )
        expected_session_ids.append(session_id)
        cell = str(run.get("measurementCell") or "").strip()
        if cell:
            manifest_cells[cell] += 1
        revision = str(run.get("cloudRunRevision") or "").strip()
        if revision:
            manifest_revisions.add(revision)
        extractor_version = str(run.get("extractorVersion") or "").strip()
        if extractor_version:
            manifest_extractor_versions.add(extractor_version)
    duplicate_manifest_ids = sorted(
        session_id
        for session_id, count in Counter(expected_session_ids).items()
        if count > 1
    )
    if duplicate_manifest_ids:
        raise WhiteboxPromotionReportError(
            "run manifest contains duplicate feeSessionId values: "
            + ", ".join(duplicate_manifest_ids)
        )

    expected = set(expected_session_ids)
    selected = []
    observed_counts = Counter()
    ignored_unrelated = 0
    for payload in payloads:
        session_id = str(payload.get("feeSessionId") or "").strip()
        if session_id not in expected:
            ignored_unrelated += 1
            continue
        selected.append(payload)
        observed_counts[session_id] += 1

    missing = sorted(expected - set(observed_counts))
    duplicate_logs = {
        session_id: count
        for session_id, count in sorted(observed_counts.items())
        if count > 1
    }
    expected_cells = set(required_cells(policy))
    manifest_cell_names = set(manifest_cells)
    environment = (
        run_manifest.get("environment")
        if isinstance(run_manifest.get("environment"), Mapping)
        else {}
    )
    expected_revision = str(environment.get("cloudRunRevision") or "").strip()
    observed_revisions = {
        str(
            (payload.get("runtime") or {}).get("cloudRunRevision")
            if isinstance(payload.get("runtime"), Mapping)
            else ""
        ).strip()
        for payload in selected
    }
    observed_revisions.discard("")
    return selected, {
        "provided": True,
        "runId": str(run_manifest.get("runId") or "").strip(),
        "status": str(run_manifest.get("status") or "").strip(),
        "expectedSessionCount": len(expected),
        "observedSessionCount": len(observed_counts),
        "observedLogCount": len(selected),
        "missingSessionIds": missing,
        "duplicateLogCounts": duplicate_logs,
        "ignoredUnrelatedPerformanceRecordCount": ignored_unrelated,
        "holdoutUsed": bool(
            (run_manifest.get("source") or {}).get("holdoutUsed")
            if isinstance(run_manifest.get("source"), Mapping)
            else False
        ),
        "manifestCellCounts": dict(sorted(manifest_cells.items())),
        "missingRequiredCells": sorted(expected_cells - manifest_cell_names),
        "unexpectedManifestCells": sorted(manifest_cell_names - expected_cells),
        "manifestCloudRunRevisions": sorted(manifest_revisions),
        "manifestExtractorVersions": sorted(manifest_extractor_versions),
        "expectedCloudRunRevision": expected_revision,
        "observedCloudRunRevisions": sorted(observed_revisions),
        "revisionMatches": bool(
            expected_revision
            and observed_revisions == {expected_revision}
            and (not manifest_revisions or manifest_revisions == {expected_revision})
        ),
    }


def required_cells(policy: Mapping[str, Any]) -> list[str]:
    specialties = _nonempty_strings(policy.get("requiredSpecialties"), "requiredSpecialties")
    settings = _nonempty_strings(
        policy.get("requiredEncounterSettings"),
        "requiredEncounterSettings",
    )
    return [
        f"{specialty}|{setting}"
        for specialty in specialties
        for setting in settings
    ]


def summarize_telemetry(
    payloads: Sequence[Mapping[str, Any]],
    *,
    policy: Mapping[str, Any],
) -> dict[str, Any]:
    required = required_cells(policy)
    cells: dict[str, dict[str, Any]] = {
        cell: {
            "runCount": 0,
            "lineCount": 0,
            "shadowEncoderLineCount": 0,
            "spanBearingLineCount": 0,
            "shadowEncoderSpanBearingLineCount": 0,
            "degradedRunCount": 0,
            "routeReasonCounts": Counter(),
        }
        for cell in required
    }
    revisions = set()
    extractor_versions = Counter()
    whitebox_durations = []
    unexpected_cells = Counter()
    mode_counts = Counter()
    for payload in payloads:
        whitebox = payload["whiteboxExtraction"]
        specialty = normalize_specialty(
            whitebox.get("specialty"),
            policy=policy,
        )
        setting = str(whitebox.get("encounterSetting") or "").strip().lower()
        cell_name = f"{specialty}|{setting}"
        if cell_name not in cells:
            unexpected_cells[cell_name] += 1
            continue
        cell = cells[cell_name]
        cell["runCount"] += 1
        cell["lineCount"] += _count(whitebox.get("lineCount"))
        cell["shadowEncoderLineCount"] += _count(
            whitebox.get("shadowEncoderLineCount")
        )
        cell["spanBearingLineCount"] += _count(
            whitebox.get("spanBearingLineCount")
        )
        cell["shadowEncoderSpanBearingLineCount"] += _count(
            whitebox.get("shadowEncoderSpanBearingLineCount")
        )
        cell["degradedRunCount"] += int(whitebox.get("degraded") is True)
        for reason, count in _counter_mapping(
            whitebox.get("routeReasonCounts")
        ).items():
            cell["routeReasonCounts"][reason] += count
        modes = whitebox.get("modes") if isinstance(whitebox.get("modes"), Mapping) else {}
        mode_counts[
            "|".join(str(modes.get(layer) or "off") for layer in ("span", "linker", "context"))
        ] += 1
        duration = sum(
            _number(whitebox.get(field))
            for field in (
                "spanDetectorDurationMs",
                "linkerDurationMs",
                "contextClassifierDurationMs",
            )
        )
        whitebox_durations.append(duration)
        revision = str(
            (payload.get("runtime") or {}).get("cloudRunRevision")
            if isinstance(payload.get("runtime"), Mapping)
            else ""
        ).strip()
        if revision:
            revisions.add(revision)
        extractor_version = str(whitebox.get("extractorVersion") or "").strip()
        if extractor_version:
            extractor_versions[extractor_version] += 1

    normalized_cells = {}
    total_runs = total_lines = total_routable = total_degraded = 0
    total_span_lines = total_routable_span_lines = 0
    for name, cell in cells.items():
        run_count = cell["runCount"]
        line_count = cell["lineCount"]
        total_runs += run_count
        total_lines += line_count
        total_routable += cell["shadowEncoderLineCount"]
        total_span_lines += cell["spanBearingLineCount"]
        total_routable_span_lines += cell["shadowEncoderSpanBearingLineCount"]
        total_degraded += cell["degradedRunCount"]
        normalized_cells[name] = {
            **{key: value for key, value in cell.items() if key != "routeReasonCounts"},
            "routableLineRatio": (
                cell["shadowEncoderLineCount"] / line_count
                if line_count
                else None
            ),
            "spanBearingRoutableLineRatio": (
                cell["shadowEncoderSpanBearingLineCount"]
                / cell["spanBearingLineCount"]
                if cell["spanBearingLineCount"]
                else None
            ),
            "routeReasonCounts": dict(sorted(cell["routeReasonCounts"].items())),
        }
    return {
        "runCount": total_runs,
        "lineCount": total_lines,
        "shadowEncoderLineCount": total_routable,
        "routableLineRatio": total_routable / total_lines if total_lines else None,
        "spanBearingLineCount": total_span_lines,
        "shadowEncoderSpanBearingLineCount": total_routable_span_lines,
        "spanBearingRoutableLineRatio": (
            total_routable_span_lines / total_span_lines
            if total_span_lines
            else None
        ),
        "degradedRunCount": total_degraded,
        "degradedRunRate": total_degraded / total_runs if total_runs else None,
        "whiteboxDurationMs": _distribution(whitebox_durations),
        "cloudRunRevisions": sorted(revisions),
        "extractorVersionCounts": dict(sorted(extractor_versions.items())),
        "modeCounts": dict(sorted(mode_counts.items())),
        "unexpectedCellCounts": dict(sorted(unexpected_cells.items())),
        "cells": normalized_cells,
    }


def summarize_adjudication(
    payload: Mapping[str, Any] | None,
    *,
    policy: Mapping[str, Any],
) -> dict[str, Any] | None:
    if payload is None:
        return None
    if payload.get("schemaVersion") != "fee-whitebox-adjudication-v1":
        raise WhiteboxPromotionReportError(
            "adjudication schemaVersion must be fee-whitebox-adjudication-v1"
        )
    by_name = {}
    for raw in payload.get("cells") or []:
        if not isinstance(raw, Mapping):
            raise WhiteboxPromotionReportError("adjudication cells must contain objects")
        specialty = normalize_specialty(
            raw.get("specialty"),
            policy=policy,
        )
        setting = str(raw.get("encounterSetting") or "").strip().lower()
        name = f"{specialty}|{setting}"
        if name in by_name:
            raise WhiteboxPromotionReportError(f"duplicate adjudication cell: {name}")
        tp = _count(raw.get("truePositiveCodeCount"))
        fp = _count(raw.get("falsePositiveCodeCount"))
        fn = _count(raw.get("falseNegativeCodeCount"))
        llm_tp = _count(raw.get("llmTruePositiveCodeCount"))
        llm_fn = _count(raw.get("llmFalseNegativeCodeCount"))
        dangerous_fp = _count(raw.get("dangerousFalsePositiveCount"))
        by_name[name] = {
            "reviewedLineCount": _count(raw.get("reviewedLineCount")),
            "reviewedSpanCount": _count(raw.get("reviewedSpanCount")),
            "truePositiveCodeCount": tp,
            "falsePositiveCodeCount": fp,
            "falseNegativeCodeCount": fn,
            "dangerousFalsePositiveCount": dangerous_fp,
            "codePrecision": tp / (tp + fp) if tp + fp else None,
            "codeRecall": tp / (tp + fn) if tp + fn else None,
            "llmCodeRecall": (
                llm_tp / (llm_tp + llm_fn)
                if llm_tp + llm_fn
                else None
            ),
        }
        if by_name[name]["codeRecall"] is not None and by_name[name]["llmCodeRecall"] is not None:
            by_name[name]["recallDeltaVsLlm"] = (
                by_name[name]["codeRecall"] - by_name[name]["llmCodeRecall"]
            )
        else:
            by_name[name]["recallDeltaVsLlm"] = None
        negative_opportunities = _count(raw.get("dangerousNegativeOpportunityCount"))
        by_name[name]["dangerousFalsePositiveRate"] = (
            dangerous_fp / negative_opportunities
            if negative_opportunities
            else (0 if dangerous_fp == 0 else None)
        )
    return {
        "controlRepeats": _count(payload.get("controlRepeats")),
        "deterministicExactMatchRate": _optional_ratio(
            payload.get("deterministicExactMatchRate")
        ),
        "cells": {
            name: by_name.get(name)
            for name in required_cells(policy)
        },
    }


def evaluate_gate(
    telemetry: Mapping[str, Any],
    adjudication: Mapping[str, Any] | None,
    *,
    policy: Mapping[str, Any],
    run_manifest_audit: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    checks = []
    telemetry_policy = _mapping(policy.get("telemetry"), "telemetry")
    adjudication_policy = _mapping(policy.get("adjudication"), "adjudication")
    if telemetry_policy.get("requireRunManifest") is True:
        checks.extend(_run_manifest_checks(run_manifest_audit))
    minimum_runs = int(telemetry_policy["minimumRunsPerCell"])
    for cell_name in required_cells(policy):
        cell = telemetry["cells"][cell_name]
        checks.append(_check(
            f"telemetry.{cell_name}.runCount",
            cell["runCount"] >= minimum_runs,
            cell["runCount"],
            f">={minimum_runs}",
        ))
    checks.append(_check(
        "telemetry.degradedRunRate",
        telemetry["degradedRunRate"] is not None
        and telemetry["degradedRunRate"] <= float(
            telemetry_policy["maximumDegradedRunRate"]
        ),
        telemetry["degradedRunRate"],
        f"<={telemetry_policy['maximumDegradedRunRate']}",
    ))
    checks.append(_check(
        "telemetry.whiteboxDurationMs.p95",
        telemetry["whiteboxDurationMs"]["p95"] is not None
        and telemetry["whiteboxDurationMs"]["p95"] <= float(
            telemetry_policy["maximumWhiteboxP95Ms"]
        ),
        telemetry["whiteboxDurationMs"]["p95"],
        f"<={telemetry_policy['maximumWhiteboxP95Ms']}",
    ))
    checks.append(_check(
        "telemetry.mode",
        set(telemetry["modeCounts"]) == {"shadow|shadow|shadow"},
        telemetry["modeCounts"],
        "only shadow|shadow|shadow",
    ))
    if telemetry_policy.get("requireSingleCloudRunRevision") is True:
        checks.append(_check(
            "telemetry.cloudRunRevisions",
            len(telemetry["cloudRunRevisions"]) == 1,
            telemetry["cloudRunRevisions"],
            "exactly one revision",
        ))
    if telemetry_policy.get("requireSingleExtractorVersion") is True:
        version_counts = telemetry["extractorVersionCounts"]
        checks.append(_check(
            "telemetry.extractorVersion",
            len(version_counts) == 1
            and sum(version_counts.values()) == telemetry["runCount"],
            version_counts,
            "exactly one version on every run",
        ))

    if adjudication is None:
        checks.append(_check(
            "adjudication",
            False,
            None,
            "fee-whitebox-adjudication-v1 input",
        ))
    else:
        checks.append(_check(
            "adjudication.controlRepeats",
            adjudication["controlRepeats"] >= int(
                adjudication_policy["minimumControlRepeats"]
            ),
            adjudication["controlRepeats"],
            f">={adjudication_policy['minimumControlRepeats']}",
        ))
        checks.append(_check(
            "adjudication.deterministicExactMatchRate",
            adjudication["deterministicExactMatchRate"] is not None
            and adjudication["deterministicExactMatchRate"] >= float(
                adjudication_policy["minimumDeterministicExactMatchRate"]
            ),
            adjudication["deterministicExactMatchRate"],
            f">={adjudication_policy['minimumDeterministicExactMatchRate']}",
        ))
        for cell_name in required_cells(policy):
            cell = adjudication["cells"].get(cell_name)
            checks.extend(_adjudication_cell_checks(
                cell_name,
                cell,
                adjudication_policy,
            ))
    passed = all(check["passed"] for check in checks)
    return {
        "status": "passed" if passed else "blocked",
        "passed": passed,
        "failedCheckCount": sum(not check["passed"] for check in checks),
        "checks": checks,
    }


def build_report(
    records: Sequence[Mapping[str, Any]],
    *,
    policy: Mapping[str, Any],
    adjudication_payload: Mapping[str, Any] | None = None,
    run_manifest: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if policy.get("schemaVersion") != 1:
        raise WhiteboxPromotionReportError("promotion policy schemaVersion must be 1")
    selected_payloads, run_manifest_audit = filter_payloads_by_run_manifest(
        performance_payloads(records),
        run_manifest,
        policy=policy,
    )
    telemetry = summarize_telemetry(selected_payloads, policy=policy)
    adjudication = summarize_adjudication(
        adjudication_payload,
        policy=policy,
    )
    return {
        "schemaVersion": "fee-whitebox-shadow-report-v1",
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "policyId": policy.get("policyId"),
        "runManifestAudit": run_manifest_audit,
        "telemetry": telemetry,
        "adjudication": adjudication,
        "gate": evaluate_gate(
            telemetry,
            adjudication,
            policy=policy,
            run_manifest_audit=run_manifest_audit,
        ),
    }


def _run_manifest_checks(
    audit: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if audit is None:
        return [_check(
            "telemetry.runManifest",
            False,
            None,
            "complete fee-whitebox-shadow-stg-run-v1 manifest",
        )]
    return [
        _check(
            "telemetry.runManifest.status",
            audit.get("status") == "complete",
            audit.get("status"),
            "complete",
        ),
        _check(
            "telemetry.runManifest.holdoutUsed",
            audit.get("holdoutUsed") is False,
            audit.get("holdoutUsed"),
            "false",
        ),
        _check(
            "telemetry.runManifest.missingSessions",
            not audit.get("missingSessionIds"),
            audit.get("missingSessionIds"),
            "none",
        ),
        _check(
            "telemetry.runManifest.duplicateLogs",
            not audit.get("duplicateLogCounts"),
            audit.get("duplicateLogCounts"),
            "none",
        ),
        _check(
            "telemetry.runManifest.logCoverage",
            audit.get("expectedSessionCount") == audit.get("observedSessionCount")
            == audit.get("observedLogCount"),
            {
                "expected": audit.get("expectedSessionCount"),
                "sessions": audit.get("observedSessionCount"),
                "logs": audit.get("observedLogCount"),
            },
            "exactly one performance log per manifest session",
        ),
        _check(
            "telemetry.runManifest.cells",
            not audit.get("missingRequiredCells")
            and not audit.get("unexpectedManifestCells"),
            {
                "missing": audit.get("missingRequiredCells"),
                "unexpected": audit.get("unexpectedManifestCells"),
            },
            "exact required matrix",
        ),
        _check(
            "telemetry.runManifest.revision",
            audit.get("revisionMatches") is True,
            {
                "expected": audit.get("expectedCloudRunRevision"),
                "manifest": audit.get("manifestCloudRunRevisions"),
                "observed": audit.get("observedCloudRunRevisions"),
            },
            "manifest and logs use the preflight revision",
        ),
    ]


def _adjudication_cell_checks(
    cell_name: str,
    cell: Mapping[str, Any] | None,
    policy: Mapping[str, Any],
) -> list[dict[str, Any]]:
    if cell is None:
        return [_check(
            f"adjudication.{cell_name}",
            False,
            None,
            "reviewed cell",
        )]
    comparisons = (
        ("reviewedLineCount", ">=", "minimumReviewedLinesPerCell"),
        ("reviewedSpanCount", ">=", "minimumReviewedSpansPerCell"),
        ("codePrecision", ">=", "minimumCodePrecision"),
        ("recallDeltaVsLlm", ">=", "minimumRecallDeltaVsLlm"),
        (
            "dangerousFalsePositiveRate",
            "<=",
            "maximumDangerousFalsePositiveRate",
        ),
    )
    checks = []
    for field, operator, policy_field in comparisons:
        actual = cell.get(field)
        expected = float(policy[policy_field])
        passed = actual is not None and (
            actual >= expected if operator == ">=" else actual <= expected
        )
        checks.append(_check(
            f"adjudication.{cell_name}.{field}",
            passed,
            actual,
            f"{operator}{expected}",
        ))
    return checks


def _check(name: str, passed: bool, actual: Any, expected: str) -> dict[str, Any]:
    return {
        "name": name,
        "passed": bool(passed),
        "actual": actual,
        "expected": expected,
    }


def _distribution(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "median": None, "mean": None, "p95": None, "max": None}
    ordered = sorted(values)
    p95_index = max(0, math.ceil(len(ordered) * 0.95) - 1)
    return {
        "count": len(values),
        "median": round(statistics.median(values), 3),
        "mean": round(statistics.fmean(values), 3),
        "p95": round(ordered[p95_index], 3),
        "max": round(max(values), 3),
    }


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WhiteboxPromotionReportError(f"{label} must be an object")
    return value


def normalize_specialty(value: Any, *, policy: Mapping[str, Any]) -> str:
    specialty = str(value or "").strip()
    aliases = policy.get("specialtyAliases")
    if not isinstance(aliases, Mapping):
        return specialty
    return str(aliases.get(specialty) or specialty).strip()


def _nonempty_strings(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise WhiteboxPromotionReportError(f"{label} must be a non-empty array")
    normalized = [str(item or "").strip() for item in value]
    if not all(normalized) or len(normalized) != len(set(normalized)):
        raise WhiteboxPromotionReportError(f"{label} contains invalid values")
    return normalized


def _counter_mapping(value: Any) -> dict[str, int]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): _count(count)
        for key, count in value.items()
        if str(key).strip()
    }


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def _number(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) and parsed >= 0 else 0.0


def _optional_ratio(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and 0 <= parsed <= 1 else None


def markdown_report(report: Mapping[str, Any]) -> str:
    telemetry = report["telemetry"]
    gate = report["gate"]
    lines = [
        "# Fee White-box Shadow Report",
        "",
        f"- policy: `{report['policyId']}`",
        f"- gate: **{gate['status']}**",
        f"- runs: {telemetry['runCount']}",
        f"- routable line ratio: {_format_ratio(telemetry['routableLineRatio'])}",
        "- span-bearing routable line ratio: "
        f"{_format_ratio(telemetry['spanBearingRoutableLineRatio'])}",
        f"- degraded run rate: {_format_ratio(telemetry['degradedRunRate'])}",
        f"- white-box p95: {telemetry['whiteboxDurationMs']['p95']} ms",
        f"- failed checks: {gate['failedCheckCount']}",
        f"- Cloud Run revisions: {', '.join(telemetry['cloudRunRevisions']) or 'none'}",
        "- extractor versions: "
        f"{', '.join(telemetry['extractorVersionCounts']) or 'none'}",
        "",
        "## Cell coverage",
        "",
        "| specialty / setting | runs | routable lines | span-bearing routable | degraded |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    manifest_audit = report.get("runManifestAudit")
    if isinstance(manifest_audit, Mapping):
        lines[4:4] = [
            f"- run manifest: `{manifest_audit.get('runId') or 'unknown'}`",
            "- manifest log coverage: "
            f"{manifest_audit.get('observedSessionCount')}/"
            f"{manifest_audit.get('expectedSessionCount')}",
            "- unrelated performance logs ignored: "
            f"{manifest_audit.get('ignoredUnrelatedPerformanceRecordCount')}",
        ]
    for name, cell in telemetry["cells"].items():
        lines.append(
            f"| `{name}` | {cell['runCount']} "
            f"| {_format_ratio(cell['routableLineRatio'])} "
            f"| {_format_ratio(cell['spanBearingRoutableLineRatio'])} "
            f"| {cell['degradedRunCount']} |"
        )
    failed_checks = [
        check
        for check in gate["checks"]
        if not check["passed"]
    ]
    lines.extend([
        "",
        "## Failed checks",
        "",
    ])
    if failed_checks:
        lines.extend(
            f"- `{check['name']}`: actual `{check['actual']}`, expected `{check['expected']}`"
            for check in failed_checks
        )
    else:
        lines.append("- none")
    lines.extend([
        "",
        "A blocked result is expected until all 32 cells and an independently adjudicated "
        "evaluation file satisfy the policy. LLM shadow agreement alone is not gold truth.",
        "",
    ])
    return "\n".join(lines)


def _format_ratio(value: Any) -> str:
    return "n/a" if value is None else f"{float(value):.4f}"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument(
        "--policy",
        type=Path,
        default=Path("configs/fee-whitebox-promotion-gate.json"),
    )
    parser.add_argument("--adjudication", type=Path)
    parser.add_argument(
        "--run-manifest",
        type=Path,
        help="result.json from evaluate_fee_whitebox_shadow_stg.mjs",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--require-pass", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        records = read_json_records(args.input)
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        adjudication = (
            json.loads(args.adjudication.read_text(encoding="utf-8"))
            if args.adjudication
            else None
        )
        run_manifest = (
            json.loads(args.run_manifest.read_text(encoding="utf-8"))
            if args.run_manifest
            else None
        )
        report = build_report(
            records,
            policy=policy,
            adjudication_payload=adjudication,
            run_manifest=run_manifest,
        )
    except (
        OSError,
        json.JSONDecodeError,
        WhiteboxPromotionReportError,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "result.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "README.md").write_text(
        markdown_report(report),
        encoding="utf-8",
    )
    print(json.dumps(report["gate"], ensure_ascii=False, indent=2))
    if args.require_pass and not report["gate"]["passed"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
