#!/usr/bin/env python3
"""Shared, fail-closed helpers for WX1/WX3 artifact builders."""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from medical_fee_calculation.clause_segmentation import (
    split_clinical_evidence_clauses,
    split_legacy_context_clauses,
)
from medical_fee_calculation.whitebox_artifacts import (
    sha256_file,
    validate_artifact_license,
)
from medical_fee_calculation.whitebox_context import (
    CLAUSE_AWARE_INPUT_CONTRACT_VERSION,
    CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
    STRUCTURED_INPUT_CONTRACT_VERSION,
    _classifier_text,
    context_input_semantics,
)


IMMUTABLE_REVISION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$")
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_TRAINING_SPLITS = frozenset({"train", "development", "holdout"})


class WhiteboxTrainingError(RuntimeError):
    """Raised before an artifact can be partially produced."""


@dataclass(frozen=True)
class TrainingPartitions:
    train: tuple[dict[str, Any], ...]
    development: tuple[dict[str, Any], ...]
    holdout_case_ids: tuple[str, ...]
    source_sha256: str
    training_view_sha256: str


@dataclass(frozen=True)
class TextLine:
    index: int
    text: str
    char_start: int
    char_end: int


def load_training_partitions(dataset_path: str | Path) -> TrainingPartitions:
    path = Path(dataset_path).expanduser().resolve()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WhiteboxTrainingError(f"training dataset is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise WhiteboxTrainingError(f"training dataset is invalid JSON: {path}") from exc
    if not isinstance(payload, Mapping) or not isinstance(payload.get("cases"), list):
        raise WhiteboxTrainingError("training dataset must contain a cases array")
    if payload.get("schemaVersion") != "fee-whitebox-training-view-v1":
        raise WhiteboxTrainingError(
            "model builders require a fee-whitebox-training-view-v1 input; "
            "do not pass the source matrix containing holdout labels"
        )

    selected: dict[str, list[dict[str, Any]]] = {
        "train": [],
        "development": [],
    }
    holdout_case_ids = [
        str(value).strip()
        for value in payload.get("withheldHoldoutCaseIds", [])
        if str(value).strip()
    ]
    if not holdout_case_ids:
        raise WhiteboxTrainingError("withheldHoldoutCaseIds must not be empty")
    if len(holdout_case_ids) != len(set(holdout_case_ids)):
        raise WhiteboxTrainingError("withheldHoldoutCaseIds contains duplicates")
    source_sha256 = required_text(
        payload.get("sourceDatasetSha256"),
        "sourceDatasetSha256",
    ).lower()
    if not SHA256_PATTERN.fullmatch(source_sha256):
        raise WhiteboxTrainingError(
            "sourceDatasetSha256 must be a lowercase SHA-256 digest"
        )

    seen_case_ids: set[str] = set()
    for raw in payload["cases"]:
        if not isinstance(raw, Mapping):
            raise WhiteboxTrainingError("training case must be an object")
        case_id = str(raw.get("caseId") or "").strip()
        split = str(raw.get("split") or "").strip()
        if not case_id or case_id in seen_case_ids:
            raise WhiteboxTrainingError(f"caseId is missing or duplicated: {case_id!r}")
        seen_case_ids.add(case_id)
        if split not in ALLOWED_TRAINING_SPLITS:
            raise WhiteboxTrainingError(f"unsupported split for {case_id}: {split!r}")
        if split == "holdout":
            raise WhiteboxTrainingError(
                "training view contains holdout labels; regenerate it before model training"
            )
        selected[split].append(_normalize_training_case(raw, split))

    if not selected["train"]:
        raise WhiteboxTrainingError("train split is empty")
    if not selected["development"]:
        raise WhiteboxTrainingError("development split is empty")
    leaked_holdout_ids = seen_case_ids.intersection(holdout_case_ids)
    if leaked_holdout_ids:
        raise WhiteboxTrainingError(
            "withheld holdout caseId leaked into the training view: "
            + ", ".join(sorted(leaked_holdout_ids))
        )
    return TrainingPartitions(
        train=tuple(selected["train"]),
        development=tuple(selected["development"]),
        holdout_case_ids=tuple(sorted(holdout_case_ids)),
        source_sha256=source_sha256,
        training_view_sha256=sha256_file(path),
    )


def _normalize_training_case(raw: Mapping[str, Any], split: str) -> dict[str, Any]:
    if raw.get("synthetic") is not True:
        raise WhiteboxTrainingError(
            f"{raw.get('caseId')}: whitebox training is restricted to synthetic data"
        )
    if raw.get("annotationStatus") != "reviewed":
        raise WhiteboxTrainingError(
            f"{raw.get('caseId')}: annotationStatus must be reviewed"
        )
    clinical_text = str(raw.get("clinicalText") or "")
    if not clinical_text.strip():
        raise WhiteboxTrainingError(f"{raw.get('caseId')}: clinicalText is empty")
    spans = raw.get("expectedSpans")
    if not isinstance(spans, list):
        raise WhiteboxTrainingError(f"{raw.get('caseId')}: expectedSpans must be an array")
    normalized_spans = []
    for index, span in enumerate(spans):
        if not isinstance(span, Mapping):
            raise WhiteboxTrainingError(
                f"{raw.get('caseId')}: expectedSpans[{index}] must be an object"
            )
        start = _integer(span.get("charStart"), "charStart")
        end = _integer(span.get("charEnd"), "charEnd")
        text = str(span.get("text") or "")
        if start < 0 or end <= start or end > len(clinical_text):
            raise WhiteboxTrainingError(
                f"{raw.get('caseId')}: expectedSpans[{index}] offsets are invalid"
            )
        if clinical_text[start:end] != text:
            raise WhiteboxTrainingError(
                f"{raw.get('caseId')}: expectedSpans[{index}] text does not match offsets"
            )
        normalized_spans.append(dict(span))
    clinical_text, normalized_spans = canonicalize_training_case(
        clinical_text,
        normalized_spans,
    )
    return {
        "caseId": str(raw["caseId"]),
        "specialty": str(raw.get("specialty") or ""),
        "encounterSetting": str(raw.get("encounterSetting") or ""),
        "split": split,
        "clinicalText": clinical_text,
        "expectedSpans": normalized_spans,
    }


def canonicalize_training_case(
    clinical_text: str,
    spans: Sequence[Mapping[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    """Apply the runtime text contract and remap reviewed source offsets."""
    source = str(clinical_text)
    segments: list[dict[str, Any]] = []
    index = 0
    while index < len(source):
        raw_start = index
        character = source[index]
        if character == "\r":
            index += 2 if index + 1 < len(source) and source[index + 1] == "\n" else 1
            character = "\n"
        else:
            index += 1
        codepoint = ord(character)
        if (
            0xFF10 <= codepoint <= 0xFF19
            or 0xFF21 <= codepoint <= 0xFF3A
            or 0xFF41 <= codepoint <= 0xFF5A
        ):
            character = chr(codepoint - 0xFEE0)
        segments.append({
            "character": character,
            "rawStart": raw_start,
            "rawEnd": index,
        })
    first = 0
    last = len(segments)
    while first < last and not segments[first]["character"].strip():
        first += 1
    while last > first and not segments[last - 1]["character"].strip():
        last -= 1
    retained = segments[first:last]
    for canonical_index, segment in enumerate(retained):
        segment["canonicalStart"] = canonical_index
        segment["canonicalEnd"] = canonical_index + len(segment["character"])
    normalized_text = "".join(segment["character"] for segment in retained)
    normalized_spans = []
    for span_index, span in enumerate(spans):
        raw_start = int(span["charStart"])
        raw_end = int(span["charEnd"])
        overlapping = [
            segment
            for segment in retained
            if segment["rawStart"] < raw_end and segment["rawEnd"] > raw_start
        ]
        if not overlapping:
            raise WhiteboxTrainingError(
                f"expectedSpans[{span_index}] was removed by runtime normalization"
            )
        start = int(overlapping[0]["canonicalStart"])
        end = int(overlapping[-1]["canonicalEnd"])
        normalized_spans.append({
            **dict(span),
            "text": normalized_text[start:end],
            "charStart": start,
            "charEnd": end,
        })
    return normalized_text, normalized_spans


def assert_no_counterexample_training_leakage(
    training_cases: Sequence[Mapping[str, Any]],
    counterexample_path: str | Path,
) -> dict[str, Any]:
    path = Path(counterexample_path).expanduser().resolve()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WhiteboxTrainingError(f"counterexample dataset is missing: {path}") from exc
    if not isinstance(payload, Mapping) or not isinstance(payload.get("cases"), list):
        raise WhiteboxTrainingError("counterexample dataset must contain a cases array")
    protected_hashes = {
        normalized_text_sha256(item.get("clinicalText"))
        for item in payload["cases"]
        if isinstance(item, Mapping) and str(item.get("clinicalText") or "").strip()
    }
    leaked = [
        str(case.get("caseId") or "")
        for case in training_cases
        if normalized_text_sha256(case.get("clinicalText")) in protected_hashes
    ]
    if leaked:
        raise WhiteboxTrainingError(
            "counterexample text leaked into the training split: "
            + ", ".join(sorted(leaked))
        )
    return {
        "sourceSha256": sha256_file(path),
        "protectedTextCount": len(protected_hashes),
        "leakedCaseCount": 0,
    }


def split_text_lines(text: str) -> list[TextLine]:
    source = str(text)
    with_endings = source.splitlines(keepends=True)
    if not with_endings:
        return [TextLine(index=0, text=source, char_start=0, char_end=len(source))]
    lines = []
    offset = 0
    for index, line_with_ending in enumerate(with_endings):
        line = line_with_ending.rstrip("\r\n")
        lines.append(
            TextLine(
                index=index,
                text=line,
                char_start=offset,
                char_end=offset + len(line),
            )
        )
        offset += len(line_with_ending)
    return lines


def spans_for_line(
    case: Mapping[str, Any],
    line: TextLine,
) -> list[dict[str, Any]]:
    result = []
    for span in case.get("expectedSpans", []):
        start = int(span["charStart"])
        end = int(span["charEnd"])
        overlaps = start < line.char_end and end > line.char_start
        if not overlaps:
            continue
        if start < line.char_start or end > line.char_end:
            raise WhiteboxTrainingError(
                f"{case.get('caseId')}: span crosses a line boundary"
            )
        result.append({
            **dict(span),
            "charStart": start - line.char_start,
            "charEnd": end - line.char_start,
        })
    return result


def context_text_for_span(
    case: Mapping[str, Any],
    span: Mapping[str, Any],
    *,
    input_contract_version: int = STRUCTURED_INPUT_CONTRACT_VERSION,
) -> str:
    return _classifier_text(
        context_classifier_item_for_span(
            case,
            span,
            input_contract_version=input_contract_version,
        ),
        input_contract_version=input_contract_version,
    )


def context_classifier_item_for_span(
    case: Mapping[str, Any],
    span: Mapping[str, Any],
    *,
    input_contract_version: int = CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
) -> dict[str, Any]:
    lines = split_text_lines(str(case["clinicalText"]))
    start = int(span["charStart"])
    target_index = next(
        (
            line.index
            for line in lines
            if line.char_start <= start < line.char_end
        ),
        len(lines) - 1,
    )
    target = lines[target_index]
    local_start = start - target.char_start
    local_end = int(span["charEnd"]) - target.char_start
    if not 0 <= local_start < local_end <= len(target.text):
        raise WhiteboxTrainingError(
            f"{case.get('caseId')}: context span offsets are invalid"
        )
    line_id = f"L-{target.index + 1:03d}"
    clauses = split_context_clauses(
        target.text,
        line_id=line_id,
        input_contract_version=input_contract_version,
    )
    clause = next(
        (
            item
            for item in clauses
            if local_start < item["charEnd"] and local_end > item["charStart"]
        ),
        clauses[0],
    )
    return {
        "text": target.text,
        "spanText": target.text[local_start:local_end],
        "charStart": local_start,
        "charEnd": local_end,
        "previousLine": lines[target_index - 1].text if target_index > 0 else "",
        "nextLine": (
            lines[target_index + 1].text
            if target_index + 1 < len(lines)
            else ""
        ),
        "section": _section_for_line(target.text),
        "encounterSetting": str(case.get("encounterSetting") or ""),
        "specialty": str(case.get("specialty") or ""),
        "sourceType": "clinical_note",
        "parentLineText": target.text,
        "clauseId": clause["clauseId"],
        "clauseText": clause["text"],
        "clauseCharStart": clause["charStart"],
        "clauseCharEnd": clause["charEnd"],
        "clauseSpanCharStart": local_start - clause["charStart"],
        "clauseSpanCharEnd": local_end - clause["charStart"],
        "inputSemantics": context_input_semantics(input_contract_version),
    }


def split_context_clauses(
    value: str,
    *,
    line_id: str = "L",
    input_contract_version: int = CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
) -> list[dict[str, Any]]:
    if input_contract_version == CLAUSE_AWARE_INPUT_CONTRACT_VERSION:
        return split_legacy_context_clauses(value, line_id=line_id)
    return split_clinical_evidence_clauses(value, line_id=line_id)


def _section_for_line(value: str) -> str:
    matched = re.match(r"^\s*([SOAP])(?:[）):：]|\s)", str(value), flags=re.IGNORECASE)
    return matched.group(1).upper() if matched else ""


def build_license_record(
    *,
    model_id: str,
    license_name: str,
    verified_at: str,
    source_url: str,
) -> dict[str, str]:
    record = {
        "modelId": required_text(model_id, "modelId"),
        "license": required_text(license_name, "license"),
        "verifiedAt": required_text(verified_at, "licenseVerifiedAt"),
        "sourceUrl": required_text(source_url, "licenseSourceUrl"),
    }
    try:
        validate_artifact_license({"license": record})
    except ValueError as exc:
        raise WhiteboxTrainingError(str(exc)) from exc
    return record


def validate_model_revision(value: str) -> str:
    revision = required_text(value, "modelRevision")
    if revision.lower() in {"main", "master", "latest", "head"}:
        raise WhiteboxTrainingError("modelRevision must be immutable")
    if not IMMUTABLE_REVISION_PATTERN.fullmatch(revision):
        raise WhiteboxTrainingError(
            "modelRevision must be an immutable commit or version identifier"
        )
    return revision


def validate_artifact_version(value: str) -> str:
    version = required_text(value, "artifactVersion")
    if not VERSION_PATTERN.fullmatch(version):
        raise WhiteboxTrainingError("artifactVersion contains unsupported characters")
    return version


def ensure_registry_output(
    output_dir: str | Path,
    *,
    repo_root: str | Path,
) -> Path:
    output = Path(output_dir).expanduser().resolve()
    registry = Path(repo_root).resolve() / "python" / "data" / "whitebox"
    if output == registry or registry not in output.parents:
        raise WhiteboxTrainingError(
            "artifact output must be a version directory under python/data/whitebox"
        )
    return output


@contextmanager
def atomic_artifact_directory(output_dir: Path) -> Iterator[Path]:
    output = output_dir.resolve()
    if output.exists():
        raise WhiteboxTrainingError(
            f"immutable artifact output already exists: {output}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        yield temporary
        os.replace(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def artifact_file_entry(path: Path, root: Path) -> dict[str, str]:
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": sha256_file(path),
    }


def write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def stable_json_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalized_text_sha256(value: Any) -> str:
    normalized = "\n".join(
        line.rstrip()
        for line in str(value or "").replace("\r\n", "\n").split("\n")
    ).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def configure_determinism(seed: int = 17) -> None:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    random.seed(seed)
    try:
        import numpy

        numpy.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
    except ImportError:
        pass


def dependency_modules():
    try:
        import numpy
        import onnx
        import onnxruntime
        import torch
        import transformers
    except ImportError as exc:
        raise WhiteboxTrainingError(
            "training dependencies are missing; install "
            "python/experiments/requirements-whitebox-build.txt "
            "in an isolated environment"
        ) from exc
    return numpy, onnx, onnxruntime, torch, transformers


def _integer(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise WhiteboxTrainingError(f"{field} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise WhiteboxTrainingError(f"{field} must be an integer") from exc


def required_text(value: Any, field: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise WhiteboxTrainingError(f"{field} is required")
    return normalized
