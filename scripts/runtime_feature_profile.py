#!/usr/bin/env python3
"""Validate and resolve a complete runtime feature profile for deployment."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE_ROOT = REPO_ROOT / "configs" / "runtime-feature-profiles"
PROFILE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
PROFILE_METADATA_KEYS = frozenset({"PROFILE_ENV", "PROFILE_NAME"})
FEATURE_BASE_NAMES = (
    "FEE_EXTRACTION_MEMO",
    "FEE_STANDING_FACTS",
    "FEE_EMPTY_EXTRACTION_RETRY",
    "FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS",
    "FEE_MONTHLY_EXCLUSION_MODE",
    "FEE_CLINICAL_EXTRACTION_STRATEGY",
    "FEE_EXTRACTION_COVERAGE_MODE",
    "FEE_EXTRACTION_COVERAGE_MAX_LINES",
    "FEE_EXTRACTION_COVERAGE_MAX_SPANS",
    "FEE_EXTRACTION_COVERAGE_TIMEOUT_MS",
    "FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST",
    "FEE_LINKER_MODE",
    "FEE_CONTEXT_CLASSIFIER_MODE",
    "FEE_SPAN_DETECTOR_MODE",
    "FEE_EXTRACTION_FEEDBACK_MODE",
    "FEE_LINKER_MANIFEST_PATH",
    "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH",
    "FEE_SPAN_DETECTOR_MANIFEST_PATH",
    "FEE_WHITEBOX_THRESHOLDS_PATH",
    "FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION",
    "FEE_LINKER_ARTIFACT_URI",
    "FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI",
    "FEE_SPAN_DETECTOR_ARTIFACT_URI",
)


class RuntimeFeatureProfileError(ValueError):
    """Raised when a deployment profile is incomplete or unsafe."""


def load_profile(
    profile_name: str,
    *,
    environment: str,
    profile_root: Path = DEFAULT_PROFILE_ROOT,
) -> dict[str, str]:
    normalized_name = str(profile_name or "").strip()
    if not PROFILE_NAME_PATTERN.fullmatch(normalized_name):
        raise RuntimeFeatureProfileError("profile name contains unsupported characters")
    normalized_environment = str(environment or "").strip().lower()
    if normalized_environment not in {"stg", "prod"}:
        raise RuntimeFeatureProfileError("profile environment must be stg or prod")

    root = profile_root.expanduser().resolve()
    path = (root / f"{normalized_name}.env").resolve()
    if path.parent != root:
        raise RuntimeFeatureProfileError("profile path must stay under the profile root")
    try:
        values = parse_profile_text(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeFeatureProfileError(f"runtime feature profile is missing: {path}") from exc

    if values.get("PROFILE_ENV") != normalized_environment:
        raise RuntimeFeatureProfileError(
            f"PROFILE_ENV must be {normalized_environment}"
        )
    if values.get("PROFILE_NAME") != normalized_name:
        raise RuntimeFeatureProfileError(
            f"PROFILE_NAME must be {normalized_name}"
        )

    expected_keys = {
        f"{base}_{normalized_environment.upper()}"
        for base in FEATURE_BASE_NAMES
    }
    allowed_keys = expected_keys | PROFILE_METADATA_KEYS
    unexpected = sorted(set(values) - allowed_keys)
    if unexpected:
        raise RuntimeFeatureProfileError(
            f"profile contains unsupported keys: {', '.join(unexpected)}"
        )
    missing = sorted(expected_keys - set(values))
    if missing:
        raise RuntimeFeatureProfileError(
            f"profile is incomplete; missing keys: {', '.join(missing)}"
        )

    resolved = {key: values[key] for key in sorted(expected_keys)}
    validate_resolved_profile(resolved, environment=normalized_environment)
    return resolved


def parse_profile_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            raise RuntimeFeatureProfileError(
                f"line {line_number}: export statements are not supported"
            )
        if "=" not in line:
            raise RuntimeFeatureProfileError(
                f"line {line_number}: expected KEY=VALUE"
            )
        key, value = line.split("=", 1)
        if key != key.strip() or not KEY_PATTERN.fullmatch(key):
            raise RuntimeFeatureProfileError(
                f"line {line_number}: invalid profile key"
            )
        if value != value.strip():
            raise RuntimeFeatureProfileError(
                f"line {line_number}: surrounding whitespace is not allowed"
            )
        if key in values:
            raise RuntimeFeatureProfileError(
                f"line {line_number}: duplicate key {key}"
            )
        if any(character in value for character in ("\x00", "\r", "\n")):
            raise RuntimeFeatureProfileError(
                f"line {line_number}: invalid control character"
            )
        values[key] = value
    return values


def validate_resolved_profile(values: Mapping[str, str], *, environment: str) -> None:
    suffix = environment.upper()

    def value(base_name: str) -> str:
        return values[f"{base_name}_{suffix}"]

    for base_name in (
        "FEE_EXTRACTION_MEMO",
        "FEE_STANDING_FACTS",
        "FEE_EMPTY_EXTRACTION_RETRY",
    ):
        if value(base_name) not in {"true", "false"}:
            raise RuntimeFeatureProfileError(
                f"{base_name}_{suffix} must be true or false"
            )
    retention = value("FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS")
    if not retention.isdigit() or not 1 <= int(retention) <= 90:
        raise RuntimeFeatureProfileError(
            f"FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS_{suffix} must be 1..90"
        )

    enum_values = {
        "FEE_MONTHLY_EXCLUSION_MODE": {"off", "shadow", "enforce"},
        "FEE_CLINICAL_EXTRACTION_STRATEGY": {
            "openai_primary",
            "whitebox_experiment",
        },
        "FEE_EXTRACTION_COVERAGE_MODE": {"off", "observe", "verify"},
        "FEE_LINKER_MODE": {"off", "shadow", "propose"},
        "FEE_CONTEXT_CLASSIFIER_MODE": {"off", "shadow", "assist"},
        "FEE_SPAN_DETECTOR_MODE": {"off", "shadow", "route"},
        "FEE_EXTRACTION_FEEDBACK_MODE": {"off", "collect"},
    }
    for base_name, choices in enum_values.items():
        if value(base_name) not in choices:
            raise RuntimeFeatureProfileError(
                f"{base_name}_{suffix} must be one of {sorted(choices)}"
            )

    bounded_integer_contracts = (
        ("FEE_EXTRACTION_COVERAGE_MAX_LINES", 1, 16),
        ("FEE_EXTRACTION_COVERAGE_MAX_SPANS", 1, 32),
        ("FEE_EXTRACTION_COVERAGE_TIMEOUT_MS", 100, 30_000),
    )
    for base_name, minimum, maximum in bounded_integer_contracts:
        raw = value(base_name)
        if not raw.isdigit() or not minimum <= int(raw) <= maximum:
            raise RuntimeFeatureProfileError(
                f"{base_name}_{suffix} must be {minimum}..{maximum}"
            )

    strategy = value("FEE_CLINICAL_EXTRACTION_STRATEGY")
    coverage_mode = value("FEE_EXTRACTION_COVERAGE_MODE")
    if environment == "prod" and strategy == "whitebox_experiment":
        raise RuntimeFeatureProfileError(
            "FEE_CLINICAL_EXTRACTION_STRATEGY_PROD cannot enable "
            "whitebox_experiment"
        )
    if coverage_mode != "off":
        if strategy != "openai_primary":
            raise RuntimeFeatureProfileError(
                f"FEE_EXTRACTION_COVERAGE_MODE_{suffix} requires "
                "FEE_CLINICAL_EXTRACTION_STRATEGY=openai_primary"
            )
        if value("FEE_SPAN_DETECTOR_MODE") != "shadow":
            raise RuntimeFeatureProfileError(
                f"FEE_EXTRACTION_COVERAGE_MODE_{suffix} requires "
                "FEE_SPAN_DETECTOR_MODE=shadow"
            )
        if (
            value("FEE_LINKER_MODE") != "off"
            or value("FEE_CONTEXT_CLASSIFIER_MODE") != "off"
        ):
            raise RuntimeFeatureProfileError(
                f"FEE_EXTRACTION_COVERAGE_MODE_{suffix} requires "
                "linker and context classifier modes to be off"
            )
        if not value("FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST"):
            raise RuntimeFeatureProfileError(
                f"FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST_{suffix} "
                "must not be empty when coverage is enabled"
            )

    layer_contracts = (
        (
            "FEE_LINKER_MODE",
            "FEE_LINKER_MANIFEST_PATH",
            "FEE_LINKER_ARTIFACT_URI",
            "fee_master_linker",
            "linker_manifest.json",
        ),
        (
            "FEE_CONTEXT_CLASSIFIER_MODE",
            "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH",
            "FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI",
            "fee_context_classifier",
            "manifest.json",
        ),
        (
            "FEE_SPAN_DETECTOR_MODE",
            "FEE_SPAN_DETECTOR_MANIFEST_PATH",
            "FEE_SPAN_DETECTOR_ARTIFACT_URI",
            "fee_span_detector",
            "manifest.json",
        ),
    )
    for (
        mode_name,
        manifest_name,
        artifact_uri_name,
        artifact_type,
        manifest_filename,
    ) in layer_contracts:
        if value(mode_name) == "off":
            continue
        if not value(manifest_name).startswith("/app/python/data/whitebox/"):
            raise RuntimeFeatureProfileError(
                f"{manifest_name}_{suffix} must be packaged under /app/python/data/whitebox"
            )
        if not immutable_artifact_uri(
            value(artifact_uri_name),
            artifact_type=artifact_type,
            manifest_filename=manifest_filename,
        ):
            raise RuntimeFeatureProfileError(
                f"{artifact_uri_name}_{suffix} must be an immutable gs:// "
                f"{artifact_type}/<version>/{manifest_filename} URI"
            )


def immutable_artifact_uri(
    uri: str,
    *,
    artifact_type: str,
    manifest_filename: str,
) -> bool:
    value = str(uri or "")
    if not value.startswith("gs://") or any(character.isspace() for character in value):
        return False
    relative = value.removeprefix("gs://")
    if not relative or ".." in relative.split("/"):
        return False
    pattern = re.compile(
        rf"^.+/{re.escape(artifact_type)}/"
        rf"(?P<version>[A-Za-z0-9][A-Za-z0-9._-]*)/"
        rf"{re.escape(manifest_filename)}$"
    )
    match = pattern.fullmatch(relative)
    return bool(match and match.group("version").lower() != "latest")


def profile_summary(
    profile_name: str,
    environment: str,
    values: Mapping[str, str],
) -> dict[str, object]:
    suffix = environment.upper()
    return {
        "profile": profile_name,
        "environment": environment,
        "features": {
            base_name: values[f"{base_name}_{suffix}"]
            for base_name in FEATURE_BASE_NAMES
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("resolve", "show", "check"))
    parser.add_argument("--profile", required=True)
    parser.add_argument("--environment", choices=("stg", "prod"), required=True)
    parser.add_argument("--profile-root", type=Path, default=DEFAULT_PROFILE_ROOT)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        values = load_profile(
            args.profile,
            environment=args.environment,
            profile_root=args.profile_root,
        )
    except RuntimeFeatureProfileError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.command == "resolve":
        for key in sorted(values):
            print(f"{key}={values[key]}")
    elif args.command == "show":
        print(json.dumps(
            profile_summary(args.profile, args.environment, values),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ))
    else:
        print(f"runtime feature profile is valid: {args.profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
