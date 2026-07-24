#!/usr/bin/env python3
"""WX1-WX3 synthetic retraining and STG shadow promotion orchestrator.

The orchestrator intentionally cannot promote to production or to an active
proposal/routing mode. Model training remains synthetic-only until a separate
governance decision changes that policy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


REQUIRED_STAGE_KINDS = frozenset({
    "synthetic_data",
    "train_wx1",
    "build_wx2",
    "train_wx3",
})
REQUIRED_GATE_PURPOSES = {
    "gold_seed_300": frozenset({"passed"}),
    "soap_e2e_exact": frozenset({"passed"}),
    "stability": frozenset({"determinism_100", "zero_variance"}),
    "specialty_matrix": frozenset({"non_regression"}),
    "counterexamples": frozenset({"passed"}),
}
ARTIFACT_TYPES = {
    "wx1": "fee_span_detector",
    "wx2": "fee_master_linker",
    "wx3": "fee_context_classifier",
}
MODE_ENVIRONMENT = {
    "FEE_SPAN_DETECTOR_MODE_STG": "shadow",
    "FEE_LINKER_MODE_STG": "shadow",
    "FEE_CONTEXT_CLASSIFIER_MODE_STG": "shadow",
}
MANIFEST_ENVIRONMENT = {
    "wx1": "FEE_SPAN_DETECTOR_MANIFEST_PATH_STG",
    "wx2": "FEE_LINKER_MANIFEST_PATH_STG",
    "wx3": "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH_STG",
}
SECRET_NAME_PATTERN = re.compile(
    r"(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|CREDENTIAL)",
    re.IGNORECASE,
)
SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class RetrainingPipelineError(RuntimeError):
    """Raised when the pipeline cannot safely proceed."""


class RetrainingGateError(RetrainingPipelineError):
    """Raised when an evaluation gate blocks artifact promotion."""


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0


CommandRunner = Callable[
    [Sequence[str], Path, Mapping[str, str], int],
    CommandResult,
]


def run_pipeline(
    config_path: str | Path,
    *,
    repo_root: str | Path,
    output_dir: str | Path,
    apply: bool = False,
    allow_stg_shadow_deploy: bool = False,
    command_runner: CommandRunner | None = None,
) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    config_file = _resolve_under_root(root, config_path, "config")
    config = _read_json(config_file)
    _validate_config(config, root)

    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    logs_dir = output / "logs"
    logs_dir.mkdir(exist_ok=True)
    runner = command_runner or _run_command
    now = datetime.now(UTC)
    summary: dict[str, Any] = {
        "schemaVersion": 1,
        "runId": f"wx-retrain-{now.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}",
        "startedAt": now.isoformat().replace("+00:00", "Z"),
        "completedAt": None,
        "status": "planned" if not apply else "running",
        "syntheticDataOnly": True,
        "targetEnvironment": "stg",
        "deploymentMode": "shadow",
        "configSha256": _sha256_file(config_file),
        "stages": [],
        "gates": [],
        "artifacts": [],
        "deployment": {
            "status": "not_requested" if not allow_stg_shadow_deploy else "pending"
        },
    }
    if not apply:
        summary["completedAt"] = _timestamp()
        _write_run_outputs(output, summary)
        return summary

    try:
        for index, stage in enumerate(config["stages"], start=1):
            summary["stages"].append(_execute_step(
                stage,
                root=root,
                logs_dir=logs_dir,
                log_prefix=f"{index:02d}-stage",
                runner=runner,
            ))

        summary["trainingData"] = _validate_synthetic_training_manifest(
            root,
            config["trainingDataManifest"],
        )

        for index, gate in enumerate(config["gates"], start=1):
            gate_result = _execute_gate(
                gate,
                root=root,
                logs_dir=logs_dir,
                log_prefix=f"{index:02d}-gate",
                runner=runner,
            )
            summary["gates"].append(gate_result)
            if not gate_result["passed"]:
                raise RetrainingGateError(
                    f"promotion blocked by gate: {gate_result['name']}"
                )

        registered = _register_artifacts(
            config["artifacts"],
            root=root,
            registry_root=config["artifactRegistryRoot"],
        )
        summary["artifacts"] = registered

        if allow_stg_shadow_deploy:
            summary["deployment"] = _deploy_stg_shadow(
                config["deployment"],
                registered,
                root=root,
                logs_dir=logs_dir,
                runner=runner,
            )
        else:
            summary["deployment"] = {
                "status": "skipped",
                "reason": "--allow-stg-shadow-deploy was not supplied",
            }
        summary["status"] = "complete"
    except Exception as exc:
        summary["status"] = "blocked" if isinstance(exc, RetrainingGateError) else "failed"
        summary["error"] = {
            "type": type(exc).__name__,
            "message": str(exc)[:1000],
        }
        raise
    finally:
        summary["completedAt"] = _timestamp()
        _write_run_outputs(output, summary)
    return summary


def _validate_config(config: Any, root: Path) -> None:
    if not isinstance(config, Mapping) or config.get("schemaVersion") != 1:
        raise RetrainingPipelineError("config schemaVersion must be 1")
    if config.get("syntheticDataOnly") is not True:
        raise RetrainingPipelineError("retraining is restricted to synthetic data")
    if config.get("trainingDataPolicy") != "synthetic_only":
        raise RetrainingPipelineError("trainingDataPolicy must be synthetic_only")
    if config.get("targetEnvironment") != "stg":
        raise RetrainingPipelineError("targetEnvironment must be stg")
    if config.get("deploymentMode") != "shadow":
        raise RetrainingPipelineError("deploymentMode must be shadow")

    stages = _required_object_list(config.get("stages"), "stages")
    stage_kinds = {str(stage.get("kind") or "") for stage in stages}
    missing_stages = sorted(REQUIRED_STAGE_KINDS - stage_kinds)
    if missing_stages:
        raise RetrainingPipelineError(
            f"required retraining stages are missing: {', '.join(missing_stages)}"
        )
    for stage in stages:
        _validate_command_step(stage, "stage")

    gates = _required_object_list(config.get("gates"), "gates")
    gates_by_kind = {str(gate.get("kind") or ""): gate for gate in gates}
    missing_gates = sorted(set(REQUIRED_GATE_PURPOSES) - set(gates_by_kind))
    if missing_gates:
        raise RetrainingPipelineError(
            f"required promotion gates are missing: {', '.join(missing_gates)}"
        )
    for kind, gate in gates_by_kind.items():
        if kind not in REQUIRED_GATE_PURPOSES:
            raise RetrainingPipelineError(f"unsupported promotion gate kind: {kind}")
        _validate_command_step(gate, "gate")
        assertions = _required_object_list(gate.get("assertions"), f"gate {kind} assertions")
        purposes = {str(assertion.get("purpose") or "") for assertion in assertions}
        missing_purposes = sorted(REQUIRED_GATE_PURPOSES[kind] - purposes)
        if missing_purposes:
            raise RetrainingPipelineError(
                f"gate {kind} is missing assertions: {', '.join(missing_purposes)}"
            )
        if not gate.get("resultPath"):
            raise RetrainingPipelineError(f"gate {kind} resultPath is required")
        for assertion in assertions:
            _validate_assertion(assertion, kind)

    _resolve_under_root(root, config.get("trainingDataManifest"), "trainingDataManifest")
    registry_root = _resolve_under_root(
        root,
        config.get("artifactRegistryRoot"),
        "artifactRegistryRoot",
    )
    expected_registry = root / "python" / "data" / "whitebox"
    if registry_root != expected_registry and expected_registry not in registry_root.parents:
        raise RetrainingPipelineError(
            "artifactRegistryRoot must stay under python/data/whitebox"
        )

    artifacts = _required_object_list(config.get("artifacts"), "artifacts")
    layers = {str(artifact.get("layer") or "") for artifact in artifacts}
    if layers != set(ARTIFACT_TYPES):
        raise RetrainingPipelineError("artifacts must contain exactly wx1, wx2, and wx3")
    for artifact in artifacts:
        layer = str(artifact.get("layer"))
        _resolve_under_root(root, artifact.get("manifestPath"), f"{layer} manifestPath")

    deployment = config.get("deployment")
    if not isinstance(deployment, Mapping):
        raise RetrainingPipelineError("deployment must be an object")
    _validate_command_step(deployment, "deployment")
    _validate_shadow_deployment_command(deployment["command"])


def _execute_step(
    step: Mapping[str, Any],
    *,
    root: Path,
    logs_dir: Path,
    log_prefix: str,
    runner: CommandRunner,
) -> dict[str, Any]:
    name = str(step.get("name") or step.get("kind"))
    result = _invoke(step, root=root, runner=runner)
    _write_command_logs(logs_dir, log_prefix, name, result)
    record = {
        "name": name,
        "kind": str(step.get("kind") or ""),
        "command": list(step["command"]),
        "returnCode": result.returncode,
        "durationMs": result.duration_ms,
        "passed": result.returncode == 0,
    }
    if result.returncode != 0:
        raise RetrainingPipelineError(f"stage failed: {name}")
    for configured in step.get("requiredOutputs") or []:
        path = _resolve_under_root(root, configured, f"{name} required output")
        if not path.is_file():
            raise RetrainingPipelineError(f"stage output is missing: {path}")
    return record


def _execute_gate(
    gate: Mapping[str, Any],
    *,
    root: Path,
    logs_dir: Path,
    log_prefix: str,
    runner: CommandRunner,
) -> dict[str, Any]:
    name = str(gate.get("name") or gate.get("kind"))
    result = _invoke(gate, root=root, runner=runner)
    _write_command_logs(logs_dir, log_prefix, name, result)
    report_path = _resolve_under_root(root, gate["resultPath"], f"{name} resultPath")
    report = _read_json(report_path) if report_path.is_file() else None
    assertions = []
    passed = result.returncode == 0 and report is not None
    for assertion in gate["assertions"]:
        actual = _dotted_value(report, str(assertion["path"])) if report is not None else None
        assertion_passed = _compare(actual, assertion["op"], assertion.get("value"))
        assertions.append({
            "purpose": assertion["purpose"],
            "path": assertion["path"],
            "op": assertion["op"],
            "expected": assertion.get("value"),
            "actual": actual,
            "passed": assertion_passed,
        })
        passed = passed and assertion_passed
    return {
        "name": name,
        "kind": str(gate["kind"]),
        "command": list(gate["command"]),
        "returnCode": result.returncode,
        "durationMs": result.duration_ms,
        "resultPath": _relative_to_root(report_path, root),
        "resultSha256": _sha256_file(report_path) if report_path.is_file() else None,
        "assertions": assertions,
        "passed": passed,
    }


def _register_artifacts(
    artifacts: Sequence[Mapping[str, Any]],
    *,
    root: Path,
    registry_root: str | Path,
) -> list[dict[str, Any]]:
    sys.path.insert(0, str(root / "python"))
    from medical_fee_calculation.whitebox_artifacts import (  # noqa: PLC0415
        load_whitebox_artifact,
        validate_artifact_files,
    )

    registry = _resolve_under_root(root, registry_root, "artifactRegistryRoot")
    registered = []
    for configured in sorted(artifacts, key=lambda item: str(item["layer"])):
        layer = str(configured["layer"])
        expected_type = ARTIFACT_TYPES[layer]
        manifest_path = _resolve_under_root(
            root,
            configured["manifestPath"],
            f"{layer} manifestPath",
        )
        artifact = load_whitebox_artifact(
            manifest_path,
            expected_type=expected_type,
        )
        file_names = tuple(sorted(artifact.manifest["files"]))
        if not file_names:
            raise RetrainingPipelineError(f"{layer} artifact has no files")
        validate_artifact_files(artifact, file_names)
        version = artifact.artifact_version
        if not SAFE_ID_PATTERN.fullmatch(version):
            raise RetrainingPipelineError(f"{layer} artifactVersion is unsafe")
        destination = registry / expected_type / version
        _register_immutable_artifact(artifact, destination)
        destination_manifest = destination / manifest_path.name
        registered.append({
            "layer": layer,
            "artifactType": expected_type,
            "artifactVersion": version,
            "modelVersion": artifact.model_version,
            "license": dict(artifact.manifest["license"]),
            "manifestPath": _relative_to_root(destination_manifest, root),
            "runtimeManifestPath": f"/app/{_relative_to_root(destination_manifest, root)}",
            "manifestSha256": _sha256_file(destination_manifest),
        })
    return registered


def _deploy_stg_shadow(
    deployment: Mapping[str, Any],
    artifacts: Sequence[Mapping[str, Any]],
    *,
    root: Path,
    logs_dir: Path,
    runner: CommandRunner,
) -> dict[str, Any]:
    environment = {
        **os.environ,
        **MODE_ENVIRONMENT,
        "TARGET_ENV": "stg",
        "TARGET_SERVICE": "fee-api",
    }
    for artifact in artifacts:
        environment[MANIFEST_ENVIRONMENT[str(artifact["layer"])]] = str(
            artifact["runtimeManifestPath"]
        )
    configured_environment = deployment.get("environment") or {}
    if not isinstance(configured_environment, Mapping):
        raise RetrainingPipelineError("deployment environment must be an object")
    for key, value in configured_environment.items():
        normalized_key = str(key)
        if SECRET_NAME_PATTERN.search(normalized_key):
            raise RetrainingPipelineError(
                "secrets must be inherited from Secret Manager, not stored in retraining config"
            )
        environment[normalized_key] = str(value)
    environment.update(MODE_ENVIRONMENT)
    environment["TARGET_ENV"] = "stg"
    environment["TARGET_SERVICE"] = "fee-api"
    step = {**deployment, "environment": environment}
    result = _invoke(step, root=root, runner=runner, environment_is_complete=True)
    _write_command_logs(logs_dir, "deployment", "stg-shadow", result)
    if result.returncode != 0:
        raise RetrainingPipelineError("STG shadow deployment failed")
    return {
        "status": "complete",
        "targetEnvironment": "stg",
        "mode": "shadow",
        "command": list(deployment["command"]),
        "returnCode": result.returncode,
        "durationMs": result.duration_ms,
        "artifactVersions": {
            item["layer"]: item["artifactVersion"] for item in artifacts
        },
    }


def _invoke(
    step: Mapping[str, Any],
    *,
    root: Path,
    runner: CommandRunner,
    environment_is_complete: bool = False,
) -> CommandResult:
    command = tuple(str(value) for value in step["command"])
    working_dir = _resolve_under_root(
        root,
        step.get("workingDirectory") or ".",
        "workingDirectory",
    )
    configured_environment = step.get("environment") or {}
    if environment_is_complete:
        environment = {str(key): str(value) for key, value in configured_environment.items()}
    else:
        environment = {**os.environ}
        if not isinstance(configured_environment, Mapping):
            raise RetrainingPipelineError("step environment must be an object")
        for key, value in configured_environment.items():
            if SECRET_NAME_PATTERN.search(str(key)):
                raise RetrainingPipelineError(
                    "secret values must not be stored in retraining config"
                )
            environment[str(key)] = str(value)
    environment["WX_TRAINING_DATA_POLICY"] = "synthetic_only"
    timeout_seconds = min(24 * 60 * 60, max(1, int(step.get("timeoutSeconds") or 3600)))
    return runner(command, working_dir, environment, timeout_seconds)


def _run_command(
    command: Sequence[str],
    working_dir: Path,
    environment: Mapping[str, str],
    timeout_seconds: int,
) -> CommandResult:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(command),
            cwd=working_dir,
            env=dict(environment),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return CommandResult(
            returncode=124,
            stdout=str(exc.stdout or ""),
            stderr=f"{exc.stderr or ''}\ncommand timed out after {timeout_seconds}s",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
    return CommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        duration_ms=round((time.monotonic() - started) * 1000),
    )


def _validate_synthetic_training_manifest(
    root: Path,
    configured_path: str | Path,
) -> dict[str, Any]:
    path = _resolve_under_root(root, configured_path, "trainingDataManifest")
    manifest = _read_json(path)
    if not isinstance(manifest, Mapping) or manifest.get("syntheticDataOnly") is not True:
        raise RetrainingPipelineError(
            "training data manifest must declare syntheticDataOnly=true"
        )
    if manifest.get("containsClinicalProductionData") is not False:
        raise RetrainingPipelineError(
            "training data manifest must declare containsClinicalProductionData=false"
        )
    return {
        "manifestPath": _relative_to_root(path, root),
        "manifestSha256": _sha256_file(path),
        "caseCount": int(manifest.get("caseCount") or 0),
    }


def _register_immutable_artifact(artifact: Any, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.tmp-{uuid.uuid4().hex}"
    try:
        temporary.mkdir()
        manifest_destination = temporary / artifact.manifest_path.name
        shutil.copy2(artifact.manifest_path, manifest_destination)
        copied_paths = {manifest_destination.relative_to(temporary)}
        for logical_name in sorted(artifact.manifest["files"]):
            source = artifact.file_path(logical_name)
            if source.is_symlink() or not source.is_file():
                raise RetrainingPipelineError(
                    f"artifact file must be a regular file: {source}"
                )
            configured_path = Path(
                str(artifact.manifest["files"][logical_name]["path"])
            )
            target = temporary / configured_path
            relative_target = target.relative_to(temporary)
            if relative_target in copied_paths:
                raise RetrainingPipelineError(
                    f"artifact files resolve to the same path: {relative_target}"
                )
            copied_paths.add(relative_target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        if destination.exists():
            if _tree_digest(temporary) != _tree_digest(destination):
                raise RetrainingPipelineError(
                    f"artifact version already exists with different content: {destination}"
                )
            return
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.is_symlink():
            raise RetrainingPipelineError(f"artifact symlinks are not allowed: {path}")
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(bytes.fromhex(_sha256_file(path)))
    return digest.hexdigest()


def _validate_command_step(step: Mapping[str, Any], label: str) -> None:
    command = step.get("command")
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(value, str) or not value for value in command)
    ):
        raise RetrainingPipelineError(f"{label} command must be a non-empty string array")
    if any(value in {"sh", "bash", "zsh", "-c"} for value in command[:2]):
        raise RetrainingPipelineError(
            f"{label} command must not use a shell interpreter"
        )


def _validate_shadow_deployment_command(command: Sequence[str]) -> None:
    flattened = " ".join(command).lower()
    forbidden = (
        "prod",
        "--env all",
        "--env=all",
        "target_env=all",
        "fee_span_detector_mode_stg=route",
        "fee_linker_mode_stg=propose",
        "fee_context_classifier_mode_stg=assist",
    )
    if any(value in flattened for value in forbidden):
        raise RetrainingPipelineError(
            "deployment command may target STG shadow only"
        )


def _validate_assertion(assertion: Mapping[str, Any], gate_kind: str) -> None:
    if not assertion.get("purpose") or not assertion.get("path"):
        raise RetrainingPipelineError(
            f"gate {gate_kind} assertion requires purpose and path"
        )
    if assertion.get("op") not in {"eq", "gte", "lte"}:
        raise RetrainingPipelineError(
            f"gate {gate_kind} assertion has an unsupported operator"
        )
    if "value" not in assertion:
        raise RetrainingPipelineError(
            f"gate {gate_kind} assertion requires value"
        )


def _compare(actual: Any, operation: str, expected: Any) -> bool:
    if operation == "eq":
        return actual == expected
    if isinstance(actual, bool) or isinstance(expected, bool):
        return False
    if not isinstance(actual, (int, float)) or not isinstance(expected, (int, float)):
        return False
    if operation == "gte":
        return actual >= expected
    if operation == "lte":
        return actual <= expected
    return False


def _dotted_value(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if isinstance(current, Mapping) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return None
    return current


def _required_object_list(value: Any, label: str) -> list[Mapping[str, Any]]:
    if not isinstance(value, list) or not value or any(
        not isinstance(item, Mapping) for item in value
    ):
        raise RetrainingPipelineError(f"{label} must be a non-empty object array")
    return list(value)


def _resolve_under_root(root: Path, value: Any, label: str) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise RetrainingPipelineError(f"{label} is required")
    path = Path(raw).expanduser()
    resolved = path.resolve() if path.is_absolute() else (root / path).resolve()
    if resolved != root and root not in resolved.parents:
        raise RetrainingPipelineError(f"{label} must stay under repository root")
    return resolved


def _relative_to_root(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root).as_posix()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RetrainingPipelineError(f"required JSON file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RetrainingPipelineError(f"invalid JSON file: {path}: {exc}") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_command_logs(
    logs_dir: Path,
    prefix: str,
    name: str,
    result: CommandResult,
) -> None:
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "step"
    (logs_dir / f"{prefix}-{safe_name}.stdout.log").write_text(
        result.stdout,
        encoding="utf-8",
    )
    (logs_dir / f"{prefix}-{safe_name}.stderr.log").write_text(
        result.stderr,
        encoding="utf-8",
    )


def _write_run_outputs(output: Path, summary: Mapping[str, Any]) -> None:
    (output / "run.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# White-box再学習パイプライン",
        "",
        f"- Run ID: `{summary['runId']}`",
        f"- Status: `{summary['status']}`",
        "- 学習データ: 合成データのみ",
        "- 昇格先: STG shadowのみ",
        "",
        "## ゲート",
        "",
        "| ゲート | 結果 |",
        "| --- | --- |",
    ]
    lines.extend(
        f"| {item['name']} | {'PASS' if item['passed'] else 'FAIL'} |"
        for item in summary.get("gates", [])
    )
    if not summary.get("gates"):
        lines.append("| - | 未実行 |")
    lines.extend([
        "",
        "## アーティファクト",
        "",
        "| Layer | Version | Manifest |",
        "| --- | --- | --- |",
    ])
    lines.extend(
        f"| {item['layer']} | `{item['artifactVersion']}` | `{item['manifestPath']}` |"
        for item in summary.get("artifacts", [])
    )
    if not summary.get("artifacts"):
        lines.append("| - | - | 未登録 |")
    lines.extend([
        "",
        "本スクリプトからPROD昇格またはroute/propose/assistへの切替はできません。",
        "",
    ])
    (output / "README.md").write_text("\n".join(lines), encoding="utf-8")


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--allow-stg-shadow-deploy", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    try:
        summary = run_pipeline(
            args.config,
            repo_root=args.repo_root,
            output_dir=args.output_dir,
            apply=args.apply,
            allow_stg_shadow_deploy=args.allow_stg_shadow_deploy,
        )
    except RetrainingPipelineError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    sys.stdout.write(json.dumps({
        "runId": summary["runId"],
        "status": summary["status"],
        "outputDir": str(Path(args.output_dir).resolve()),
    }, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
