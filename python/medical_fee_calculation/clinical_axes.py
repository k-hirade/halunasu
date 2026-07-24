"""Shared clinical extraction axis contract.

The JavaScript runtime owns the enum values. Python consumers load the
generated JSON Schema so model code cannot silently drift from that contract.
"""

from __future__ import annotations

import json
import math
import os
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping


AXIS_NAMES = (
    "actionStatus",
    "temporalRelation",
    "sourceOrigin",
    "providerOwnership",
    "standingStatus",
)


class ClinicalAxesContractError(ValueError):
    """Raised when the generated contract or a classifier payload is invalid."""


def default_schema_path() -> Path:
    configured = os.environ.get("FEE_CLINICAL_AXES_SCHEMA_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "medical-core"
        / "generated"
        / "clinical-axes.schema.json"
    )


@lru_cache(maxsize=8)
def _load_schema_cached(resolved_path: str) -> dict[str, Any]:
    path = Path(resolved_path)
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ClinicalAxesContractError(
            f"clinical axes schema is missing: {path}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ClinicalAxesContractError(
            f"clinical axes schema is not valid JSON: {path}: {exc}"
        ) from exc

    properties = parsed.get("properties")
    if not isinstance(properties, dict):
        raise ClinicalAxesContractError("clinical axes schema has no properties")
    for axis in AXIS_NAMES:
        values = properties.get(axis, {}).get("enum")
        if (
            not isinstance(values, list)
            or not values
            or any(not isinstance(value, str) or not value for value in values)
            or len(values) != len(set(values))
        ):
            raise ClinicalAxesContractError(
                f"clinical axes schema has an invalid enum for {axis}"
            )
    return parsed


def load_clinical_axes_schema(
    schema_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    path = Path(schema_path).expanduser().resolve() if schema_path else default_schema_path()
    return deepcopy(_load_schema_cached(str(path)))


def clinical_axis_values(
    schema_path: str | os.PathLike[str] | None = None,
) -> dict[str, tuple[str, ...]]:
    schema = load_clinical_axes_schema(schema_path)
    return {
        axis: tuple(schema["properties"][axis]["enum"])
        for axis in AXIS_NAMES
    }


def validate_axis_values(
    payload: Mapping[str, Any],
    schema_path: str | os.PathLike[str] | None = None,
) -> dict[str, str]:
    if not isinstance(payload, Mapping):
        raise ClinicalAxesContractError("axis payload must be an object")

    allowed = clinical_axis_values(schema_path)
    unknown_fields = set(payload) - set(AXIS_NAMES)
    if unknown_fields:
        raise ClinicalAxesContractError(
            f"axis payload has unknown fields: {sorted(unknown_fields)}"
        )

    normalized: dict[str, str] = {}
    for axis in AXIS_NAMES:
        if axis not in payload:
            raise ClinicalAxesContractError(f"axis payload is missing {axis}")
        value = payload[axis]
        if value not in allowed[axis]:
            raise ClinicalAxesContractError(
                f"{axis} must be one of {list(allowed[axis])}, got {value!r}"
            )
        normalized[axis] = str(value)
    return normalized


def validate_classifier_result(
    payload: Mapping[str, Any],
    schema_path: str | os.PathLike[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Validate WX3's per-axis ``{value, confidence, abstained}`` contract."""

    if not isinstance(payload, Mapping):
        raise ClinicalAxesContractError("classifier result must be an object")

    allowed = clinical_axis_values(schema_path)
    unknown_fields = set(payload) - set(AXIS_NAMES)
    if unknown_fields:
        raise ClinicalAxesContractError(
            f"classifier result has unknown axes: {sorted(unknown_fields)}"
        )

    normalized: dict[str, dict[str, Any]] = {}
    for axis in AXIS_NAMES:
        result = payload.get(axis)
        if not isinstance(result, Mapping):
            raise ClinicalAxesContractError(
                f"classifier result is missing object axis {axis}"
            )
        result_fields = set(result)
        required_fields = {"value", "confidence", "abstained"}
        if result_fields != required_fields:
            raise ClinicalAxesContractError(
                f"{axis} fields must be exactly {sorted(required_fields)}"
            )

        value = result["value"]
        if value not in allowed[axis]:
            raise ClinicalAxesContractError(
                f"{axis}.value must be one of {list(allowed[axis])}, got {value!r}"
            )
        confidence = result["confidence"]
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(float(confidence))
            or not 0 <= float(confidence) <= 1
        ):
            raise ClinicalAxesContractError(
                f"{axis}.confidence must be a finite number from 0 to 1"
            )
        abstained = result["abstained"]
        if not isinstance(abstained, bool):
            raise ClinicalAxesContractError(f"{axis}.abstained must be boolean")

        normalized[axis] = {
            "value": str(value),
            "confidence": float(confidence),
            "abstained": abstained,
        }
    return normalized


def clear_clinical_axes_schema_cache() -> None:
    """Test and tooling hook for changing schema paths in one process."""

    _load_schema_cached.cache_clear()
