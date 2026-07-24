"""HTTP load harness for WX0 model deployment alternatives."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import statistics
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from experiments.wx0_metrics import latency_summary


def _json_path(value: Any, path: str) -> Any:
    current = value
    for segment in [item for item in path.split(".") if item]:
        if not isinstance(current, Mapping) or segment not in current:
            return None
        current = current[segment]
    return current


def _post_json(
    url: str,
    payload: bytes,
    headers: Mapping[str, str],
    timeout_seconds: float,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", **dict(headers)},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        body = exc.read()
        status = exc.code
    except Exception as exc:  # Network errors are measurement results.
        return {
            "ok": False,
            "status": None,
            "durationMs": (time.perf_counter() - started) * 1000,
            "error": f"{type(exc).__name__}: {exc}",
            "json": None,
        }
    parsed = None
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    return {
        "ok": 200 <= status < 300,
        "status": status,
        "durationMs": (time.perf_counter() - started) * 1000,
        "error": None if 200 <= status < 300 else f"HTTP {status}",
        "json": parsed,
    }


def run_load_level(
    *,
    url: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
    concurrency: int,
    request_count: int,
    timeout_seconds: float,
    rss_json_path: str,
    post_json: Callable[
        [str, bytes, Mapping[str, str], float],
        dict[str, Any],
    ] = _post_json,
) -> dict[str, Any]:
    if concurrency < 1 or request_count < 1:
        raise ValueError("concurrency and request_count must be positive")
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    start_gate = threading.Event()

    def invoke() -> dict[str, Any]:
        start_gate.wait()
        return post_json(url, payload_bytes, headers, timeout_seconds)

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(invoke) for _ in range(request_count)]
        start_gate.set()
        rows = [future.result() for future in futures]
    wall_seconds = time.perf_counter() - started

    successful = [row for row in rows if row["ok"]]
    rss_values = []
    for row in successful:
        rss = _json_path(row.get("json"), rss_json_path)
        if isinstance(rss, (int, float)) and not isinstance(rss, bool):
            rss_values.append(float(rss))
    status_counts: dict[str, int] = {}
    for row in rows:
        key = str(row["status"] if row["status"] is not None else "network_error")
        status_counts[key] = status_counts.get(key, 0) + 1

    return {
        "concurrency": concurrency,
        "requestCount": request_count,
        "successCount": len(successful),
        "errorCount": len(rows) - len(successful),
        "errorRate": (len(rows) - len(successful)) / len(rows),
        "statusCounts": status_counts,
        "wallSeconds": wall_seconds,
        "throughputPerSecond": len(rows) / wall_seconds if wall_seconds else 0,
        "latencyMs": latency_summary([row["durationMs"] for row in rows]),
        "rssBytes": {
            "count": len(rss_values),
            "max": max(rss_values) if rss_values else None,
            "median": statistics.median(rss_values) if rss_values else None,
        },
        "errors": [
            row["error"] for row in rows if row["error"]
        ][:10],
    }


def run_benchmark(
    *,
    url: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
    concurrency_levels: Sequence[int],
    requests_per_worker: int,
    timeout_seconds: float,
    warmup_requests: int,
    rss_json_path: str,
    post_json: Callable[
        [str, bytes, Mapping[str, str], float],
        dict[str, Any],
    ] = _post_json,
) -> dict[str, Any]:
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    observed_first_request = post_json(
        url,
        payload_bytes,
        headers,
        timeout_seconds,
    )
    warmups = [
        post_json(url, payload_bytes, headers, timeout_seconds)
        for _ in range(warmup_requests)
    ]
    levels = [
        run_load_level(
            url=url,
            payload=payload,
            headers=headers,
            concurrency=concurrency,
            request_count=max(concurrency, concurrency * requests_per_worker),
            timeout_seconds=timeout_seconds,
            rss_json_path=rss_json_path,
            post_json=post_json,
        )
        for concurrency in concurrency_levels
    ]
    return {
        "schemaVersion": "fee-wx0-load-result-v1",
        "endpoint": url,
        "note": (
            "observedFirstRequest is only a true cold start when the operator "
            "has independently confirmed that the model process was not warm"
        ),
        "observedFirstRequest": {
            key: observed_first_request[key]
            for key in ("ok", "status", "durationMs", "error")
        },
        "warmup": {
            "requestCount": len(warmups),
            "successCount": sum(1 for row in warmups if row["ok"]),
            "latencyMs": latency_summary([row["durationMs"] for row in warmups]),
        },
        "levels": levels,
    }


def _write_report(result: Mapping[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# WX0 Load Result",
        "",
        f"- endpoint: `{result['endpoint']}`",
        f"- first observed request: {result['observedFirstRequest']['durationMs']:.1f} ms",
        "",
        "> The first observed request is not labeled a cold start unless the model process was independently confirmed cold.",
        "",
        "| concurrency | requests | errors | throughput/s | p50 ms | p95 ms | RSS max |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for level in result["levels"]:
        rss = level["rssBytes"]["max"]
        lines.append(
            f"| {level['concurrency']} | {level['requestCount']} | {level['errorCount']} | "
            f"{level['throughputPerSecond']:.2f} | {level['latencyMs']['p50']:.1f} | "
            f"{level['latencyMs']['p95']:.1f} | "
            f"{int(rss) if rss is not None else 'not reported'} |"
        )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--request-json", type=Path, required=True)
    parser.add_argument("--concurrency", default="1,10,40,80")
    parser.add_argument("--requests-per-worker", type=int, default=2)
    parser.add_argument("--warmup-requests", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=60)
    parser.add_argument(
        "--authorization-env",
        help="Read a bearer token from this environment variable; the value is never persisted.",
    )
    parser.add_argument(
        "--rss-json-path",
        default="runtimeMetrics.rssBytes",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    concurrency_levels = [int(item) for item in args.concurrency.split(",")]
    if any(value < 1 for value in concurrency_levels):
        parser.error("all concurrency levels must be positive")
    if args.requests_per_worker < 1:
        parser.error("--requests-per-worker must be positive")

    headers = {}
    if args.authorization_env:
        import os

        token = os.environ.get(args.authorization_env, "")
        if not token:
            parser.error(
                f"environment variable {args.authorization_env} is empty"
            )
        headers["Authorization"] = f"Bearer {token}"

    payload = json.loads(args.request_json.read_text(encoding="utf-8"))
    result = run_benchmark(
        url=args.url,
        payload=payload,
        headers=headers,
        concurrency_levels=concurrency_levels,
        requests_per_worker=args.requests_per_worker,
        timeout_seconds=args.timeout_seconds,
        warmup_requests=args.warmup_requests,
        rss_json_path=args.rss_json_path,
    )
    _write_report(result, args.output_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"result={args.output_dir.resolve() / 'result.json'}")
    return 1 if any(level["errorCount"] for level in result["levels"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
