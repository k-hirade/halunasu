#!/usr/bin/env python3
"""Measure three-lane white-box runtime memory and local inference latency."""

from __future__ import annotations

import argparse
import json
import math
import platform
import resource
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from medical_fee_calculation.whitebox_artifacts import load_whitebox_artifact
from medical_fee_calculation.whitebox_context import (
    classify_context,
    context_classifier_readiness,
)
from medical_fee_calculation.whitebox_linker import link_spans, linker_readiness
from medical_fee_calculation.whitebox_span import detect_spans, span_detector_readiness


DEFAULT_SPAN_MANIFEST = Path(
    "python/data/whitebox/span-wx1-multilingual-minilm-l12-v1/manifest.json"
)
DEFAULT_LINKER_MANIFEST = Path(
    "python/data/whitebox/linker-ruri-v3-30m-v1/linker_manifest.json"
)
DEFAULT_CONTEXT_MANIFEST = Path(
    "python/data/whitebox/context-wx3-multilingual-minilm-l12-v1/manifest.json"
)


def distribution(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "median": None, "mean": None, "p95": None, "max": None}
    ordered = sorted(float(value) for value in values)
    p95_index = max(0, math.ceil(len(ordered) * 0.95) - 1)
    return {
        "count": len(ordered),
        "median": round(statistics.median(ordered), 3),
        "mean": round(statistics.fmean(ordered), 3),
        "p95": round(ordered[p95_index], 3),
        "max": round(max(ordered), 3),
    }


def max_rss_bytes(
    raw_max_rss: int | float,
    *,
    system: str | None = None,
) -> int:
    normalized_system = system or platform.system()
    value = max(0, int(raw_max_rss))
    return value if normalized_system == "Darwin" else value * 1024


def artifact_size_bytes(manifest_path: Path, expected_type: str) -> int:
    artifact = load_whitebox_artifact(
        manifest_path,
        expected_type=expected_type,
        required_files=("index",) if expected_type == "fee_master_linker" else (),
    )
    return sum(
        artifact.file_path(str(key)).stat().st_size
        for key in artifact.manifest["files"]
    )


def timed_runs(
    operation: Callable[[], Mapping[str, Any]],
    *,
    repeat: int,
    expected_status: str,
) -> tuple[dict[str, Any], Mapping[str, Any]]:
    values = []
    last_result: Mapping[str, Any] = {}
    for _ in range(repeat):
        started = time.perf_counter()
        last_result = operation()
        values.append((time.perf_counter() - started) * 1000)
        if last_result.get("status") != expected_status:
            raise RuntimeError(
                f"runtime operation returned {last_result.get('status')}: "
                f"{last_result.get('reason') or 'unknown reason'}"
            )
    return distribution(values), last_result


def run_measurement(args: argparse.Namespace) -> dict[str, Any]:
    manifests = {
        "span": args.span_manifest.resolve(),
        "linker": args.linker_manifest.resolve(),
        "context": args.context_manifest.resolve(),
    }
    for name, manifest in manifests.items():
        if not manifest.is_file():
            raise FileNotFoundError(f"{name} manifest not found: {manifest}")

    rss_stages = [{
        "stage": "start",
        "peakRssBytes": current_peak_rss_bytes(),
    }]
    readiness_started = time.perf_counter()
    readiness = {
        "span": span_detector_readiness(manifests["span"]),
        "linker": linker_readiness(manifests["linker"]),
        "context": context_classifier_readiness(manifests["context"]),
    }
    readiness_duration_ms = (time.perf_counter() - readiness_started) * 1000
    unavailable = {
        name: value.get("reason") or "unavailable"
        for name, value in readiness.items()
        if value.get("available") is not True
    }
    if unavailable:
        raise RuntimeError(f"white-box readiness failed: {unavailable}")
    rss_stages.append({
        "stage": "all_readiness_loaded",
        "peakRssBytes": current_peak_rss_bytes(),
    })

    span_latency, span_result = timed_runs(
        lambda: detect_spans({
            "manifest_path": str(manifests["span"]),
            "lines": [{
                "lineId": "L-001",
                "section": "O",
                "text": "本日、胸部CT撮影を実施し肺炎像を確認した。",
            }],
        }),
        repeat=args.repeat,
        expected_status="complete",
    )
    rss_stages.append({
        "stage": "span_inference",
        "peakRssBytes": current_peak_rss_bytes(),
    })
    linker_latency, linker_result = timed_runs(
        lambda: link_spans({
            "manifest_path": str(manifests["linker"]),
            "spans": [{"text": "胸部CT撮影", "category": "imaging"}],
            "kinds": ["procedure"],
            "service_date": args.service_date,
            "top_k": 5,
        }),
        repeat=args.repeat,
        expected_status="complete",
    )
    rss_stages.append({
        "stage": "linker_inference",
        "peakRssBytes": current_peak_rss_bytes(),
    })
    context_latency, context_result = timed_runs(
        lambda: classify_context({
            "manifest_path": str(manifests["context"]),
            "items": [{
                "lineId": "L-001",
                "spanId": "L-001:3:9",
                "text": "本日、胸部CT撮影を実施し肺炎像を確認した。",
                "spanText": "胸部CT撮影",
                "previousLine": "咳嗽と発熱あり。",
                "nextLine": "結果を患者へ説明した。",
            }],
        }),
        repeat=args.repeat,
        expected_status="complete",
    )
    rss_stages.append({
        "stage": "context_inference",
        "peakRssBytes": current_peak_rss_bytes(),
    })

    artifacts = {
        "span": artifact_summary(manifests["span"], "fee_span_detector"),
        "linker": artifact_summary(manifests["linker"], "fee_master_linker"),
        "context": artifact_summary(manifests["context"], "fee_context_classifier"),
    }
    peak_rss = current_peak_rss_bytes()
    return {
        "schemaVersion": "fee-whitebox-runtime-measurement-v1",
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "repeat": args.repeat,
        "serviceDate": args.service_date,
        "artifacts": artifacts,
        "artifactBytesTotal": sum(item["sizeBytes"] for item in artifacts.values()),
        "readinessDurationMs": round(readiness_duration_ms, 3),
        "readiness": readiness,
        "peakRssBytes": peak_rss,
        "peakRssMiB": round(peak_rss / 1024 / 1024, 2),
        "rssStages": [
            {
                **item,
                "peakRssMiB": round(item["peakRssBytes"] / 1024 / 1024, 2),
            }
            for item in rss_stages
        ],
        "latencyMs": {
            "span": span_latency,
            "linker": linker_latency,
            "context": context_latency,
            "totalP95": round(
                sum(
                    item["p95"]
                    for item in (span_latency, linker_latency, context_latency)
                    if item["p95"] is not None
                ),
                3,
            ),
        },
        "sampleResult": {
            "spanCount": sum(
                len(item.get("spans") or [])
                for item in span_result.get("results") or []
            ),
            "linkerCandidateCount": sum(
                len(item.get("candidates") or [])
                for item in linker_result.get("results") or []
            ),
            "contextItemCount": len(context_result.get("results") or []),
        },
        "interpretation": {
            "localOnly": True,
            "cloudRunMemoryDecisionRequiresHeadroom": True,
            "recommendedMinimumHeadroomRatio": 1.35,
            "note": (
                "The measured peak excludes the rest of fee-api and concurrent requests. "
                "Do not set Cloud Run memory equal to this local peak."
            ),
        },
    }


def artifact_summary(manifest_path: Path, expected_type: str) -> dict[str, Any]:
    artifact = load_whitebox_artifact(
        manifest_path,
        expected_type=expected_type,
        required_files=("index",) if expected_type == "fee_master_linker" else (),
    )
    return {
        "manifestPath": display_path(manifest_path),
        "artifactType": expected_type,
        "artifactVersion": artifact.artifact_version,
        "modelRevision": str(artifact.manifest.get("modelRevision") or ""),
        "sizeBytes": artifact_size_bytes(manifest_path, expected_type),
    }


def display_path(value: Path) -> str:
    resolved = value.resolve()
    try:
        return str(resolved.relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(resolved)


def current_peak_rss_bytes() -> int:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return max_rss_bytes(usage.ru_maxrss)


def render_readme(result: Mapping[str, Any]) -> str:
    latency = result["latencyMs"]
    return "\n".join([
        "# Fee White-box Runtime Measurement",
        "",
        f"- measured at: `{result['generatedAt']}`",
        f"- platform: `{result['platform']['system']} {result['platform']['machine']}`",
        f"- peak RSS: **{result['peakRssMiB']} MiB**",
        f"- artifact files: **{result['artifactBytesTotal'] / 1024 / 1024:.2f} MiB**",
        f"- span p95: {latency['span']['p95']} ms",
        f"- linker p95: {latency['linker']['p95']} ms",
        f"- context p95: {latency['context']['p95']} ms",
        f"- three-lane local p95 sum: **{latency['totalP95']} ms**",
        "",
        "This is a single-process local measurement. The peak excludes the rest of fee-api "
        "and request concurrency, so Cloud Run needs operational headroom. The STG "
        "promotion gate still requires the 32-cell shadow run and independent adjudication.",
        "",
    ])


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--span-manifest", type=Path, default=DEFAULT_SPAN_MANIFEST)
    parser.add_argument("--linker-manifest", type=Path, default=DEFAULT_LINKER_MANIFEST)
    parser.add_argument("--context-manifest", type=Path, default=DEFAULT_CONTEXT_MANIFEST)
    parser.add_argument("--repeat", type=int, default=20)
    parser.add_argument("--service-date", default="2026-07-25")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("docs/whitebox-artifact-builds/runtime"),
    )
    args = parser.parse_args(argv)
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if len(args.service_date) != 10:
        parser.error("--service-date must use YYYY-MM-DD")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = run_measurement(args)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "README.md").write_text(
        render_readme(result),
        encoding="utf-8",
    )
    print(json.dumps({
        "peakRssMiB": result["peakRssMiB"],
        "artifactBytesTotal": result["artifactBytesTotal"],
        "latencyMs": result["latencyMs"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
