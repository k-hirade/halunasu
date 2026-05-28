from __future__ import annotations

import json
import sqlite3
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from medical_fee_calculation.importers import (
    ImportResult,
    import_comment_links,
    import_comment_master,
    import_drug_master,
    import_electronic_fee_table,
    import_medical_procedure_master,
    import_specific_material_master,
)
from medical_fee_calculation.dpc_hospital_coefficients import import_dpc_hospital_coefficients
from medical_fee_calculation.regional_manifest import import_regional_manifest


STANDARD_BUILD_KINDS = frozenset(
    (
        "medical_procedure_master",
        "drug_master",
        "specific_material_master",
        "comment_master",
        "comment_related_table",
        "medical_electronic_fee_table",
        "regional_manifest",
    )
)

OPTIONAL_STANDARD_BUILD_KINDS = frozenset(("dpc_hospital_coefficient",))


@dataclass(frozen=True)
class StandardBuildImportResult:
    kind: str
    path: str
    source_id: int | None
    row_count: int | None
    checksum_sha256: str | None
    status: str
    error: str | None = None

    def to_dict(self) -> dict[str, int | str | None]:
        return {
            "kind": self.kind,
            "path": self.path,
            "source_id": self.source_id,
            "row_count": self.row_count,
            "checksum_sha256": self.checksum_sha256,
            "status": self.status,
            "error": self.error,
        }


@dataclass(frozen=True)
class StandardBuildManifestPreparation:
    manifest: dict[str, Any]
    extracted_files: tuple[str, ...]
    missing_kinds: tuple[str, ...]
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest": self.manifest,
            "extracted_files": list(self.extracted_files),
            "missing_kinds": list(self.missing_kinds),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class StandardBuildManifestValidationItem:
    entry_index: int
    kind: str
    target: str
    exists: bool | None
    status: str
    detail: str = ""

    def to_dict(self) -> dict[str, int | str | bool | None]:
        return {
            "entry_index": self.entry_index,
            "kind": self.kind,
            "target": self.target,
            "exists": self.exists,
            "status": self.status,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class StandardBuildManifestValidation:
    manifest_path: str
    present_kinds: tuple[str, ...]
    missing_kinds: tuple[str, ...]
    unknown_kinds: tuple[str, ...]
    items: tuple[StandardBuildManifestValidationItem, ...]

    @property
    def ready(self) -> bool:
        return not self.missing_kinds and not any(item.status != "ok" for item in self.items)

    @property
    def error_count(self) -> int:
        return sum(1 for item in self.items if item.status != "ok")

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest_path": self.manifest_path,
            "required_kinds": sorted(STANDARD_BUILD_KINDS),
            "optional_kinds": sorted(OPTIONAL_STANDARD_BUILD_KINDS),
            "present_kinds": list(self.present_kinds),
            "missing_kinds": list(self.missing_kinds),
            "unknown_kinds": list(self.unknown_kinds),
            "ready": self.ready,
            "error_count": self.error_count,
            "items": [item.to_dict() for item in self.items],
        }


def prepare_standard_build_manifest(
    raw_root: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    retrieved_at: str | None = None,
    regional_manifest: str | Path | None = None,
    extract_archives: bool = True,
    overwrite_extracted: bool = False,
    zip_metadata_encoding: str = "cp932",
) -> StandardBuildManifestPreparation:
    root = Path(raw_root)
    extracted_files: list[str] = []
    warnings: list[str] = []
    if extract_archives:
        extracted_files = [
            str(path)
            for path in _extract_zip_archives(
                root,
                overwrite=overwrite_extracted,
                metadata_encoding=zip_metadata_encoding,
                warnings=warnings,
            )
        ]

    entries: list[dict[str, Any]] = []
    missing_kinds: list[str] = []
    for kind, matcher in (
        ("medical_procedure_master", _is_medical_procedure_master),
        ("drug_master", _is_drug_master),
        ("specific_material_master", _is_specific_material_master),
        ("comment_master", _is_comment_master),
        ("comment_related_table", _is_comment_related_table),
    ):
        path = _find_best_csv(root, matcher, source_version)
        if path is None:
            missing_kinds.append(kind)
            continue
        entries.append(
            _source_entry(
                kind,
                path,
                source_version=source_version,
                published_at=published_at,
                retrieved_at=retrieved_at,
            )
        )

    electronic_paths = _find_electronic_fee_table_paths(root, source_version)
    if electronic_paths:
        entries.append(
            {
                "kind": "medical_electronic_fee_table",
                "source_version": source_version,
                "published_at": published_at,
                "retrieved_at": retrieved_at,
                "encoding": "cp932",
                "csv_paths": {
                    name: _display_path(path)
                    for name, path in sorted(electronic_paths.items())
                },
            }
        )
    else:
        missing_kinds.append("medical_electronic_fee_table")

    if regional_manifest is not None:
        entries.append({"kind": "regional_manifest", "path": _display_path(Path(regional_manifest))})

    manifest = {
        "entries": [_compact_entry(entry) for entry in entries],
    }
    return StandardBuildManifestPreparation(
        manifest=manifest,
        extracted_files=tuple(extracted_files),
        missing_kinds=tuple(missing_kinds),
        warnings=tuple(warnings),
    )


def build_standard_master_db(
    conn: sqlite3.Connection,
    manifest_path: str | Path,
    *,
    continue_on_error: bool = True,
) -> list[StandardBuildImportResult]:
    manifest_file = Path(manifest_path)
    results: list[StandardBuildImportResult] = []
    for index, entry in enumerate(_load_manifest_entries(manifest_file), start=1):
        try:
            results.extend(_import_manifest_entry(conn, manifest_file, entry, index))
        except Exception as exc:  # noqa: BLE001 - build report should identify bad entries.
            result = StandardBuildImportResult(
                kind=str(entry.get("kind") or f"entry_{index}"),
                path=str(entry.get("path") or entry.get("manifest") or ""),
                source_id=None,
                row_count=None,
                checksum_sha256=None,
                status="error",
                error=str(exc),
            )
            results.append(result)
            if not continue_on_error:
                raise
    return results


def validate_standard_build_manifest(manifest_path: str | Path) -> StandardBuildManifestValidation:
    manifest_file = Path(manifest_path)
    if not manifest_file.exists():
        return StandardBuildManifestValidation(
            manifest_path=str(manifest_file),
            present_kinds=(),
            missing_kinds=tuple(sorted(STANDARD_BUILD_KINDS)),
            unknown_kinds=(),
            items=(
                StandardBuildManifestValidationItem(
                    entry_index=0,
                    kind="manifest",
                    target=str(manifest_file),
                    exists=False,
                    status="error",
                    detail="manifest file not found",
                ),
            ),
        )

    try:
        entries = _load_manifest_entries(manifest_file)
    except Exception as exc:  # noqa: BLE001 - validation should return a report.
        return StandardBuildManifestValidation(
            manifest_path=str(manifest_file),
            present_kinds=(),
            missing_kinds=tuple(sorted(STANDARD_BUILD_KINDS)),
            unknown_kinds=(),
            items=(
                StandardBuildManifestValidationItem(
                    entry_index=0,
                    kind="manifest",
                    target=str(manifest_file),
                    exists=True,
                    status="error",
                    detail=str(exc),
                ),
            ),
        )

    items: list[StandardBuildManifestValidationItem] = []
    present_kinds: list[str] = []
    unknown_kinds: list[str] = []
    for index, entry in enumerate(entries, start=1):
        kind = entry.get("kind")
        if not isinstance(kind, str) or not kind.strip():
            items.append(
                StandardBuildManifestValidationItem(
                    entry_index=index,
                    kind=f"entry_{index}",
                    target="kind",
                    exists=None,
                    status="error",
                    detail="kind is required",
                )
            )
            continue
        kind = kind.strip()
        present_kinds.append(kind)
        if kind not in STANDARD_BUILD_KINDS | OPTIONAL_STANDARD_BUILD_KINDS:
            unknown_kinds.append(kind)
            items.append(
                StandardBuildManifestValidationItem(
                    entry_index=index,
                    kind=kind,
                    target="kind",
                    exists=None,
                    status="error",
                    detail=f"unsupported kind {kind!r}",
                )
            )
            continue

        if kind != "regional_manifest":
            _validate_required_text_field(items, entry, index, kind, "source_version")

        if kind == "medical_electronic_fee_table":
            _validate_electronic_csv_path_entries(items, manifest_file, entry, index, kind)
        else:
            _validate_entry_path(items, manifest_file, entry, index, kind, "path")

    missing_kinds = tuple(
        sorted(kind for kind in STANDARD_BUILD_KINDS if kind not in set(present_kinds))
    )
    for kind in missing_kinds:
        items.append(
            StandardBuildManifestValidationItem(
                entry_index=0,
                kind=kind,
                target="entries",
                exists=None,
                status="error",
                detail="missing required kind",
            )
        )

    return StandardBuildManifestValidation(
        manifest_path=str(manifest_file),
        present_kinds=tuple(dict.fromkeys(present_kinds)),
        missing_kinds=missing_kinds,
        unknown_kinds=tuple(dict.fromkeys(unknown_kinds)),
        items=tuple(items),
    )


def standard_build_manifest_preparation_to_markdown(
    result: StandardBuildManifestPreparation,
) -> str:
    lines = [
        "# Standard Master Build Manifest Preparation",
        "",
        f"Manifest entries: {len(result.manifest.get('entries', []))}",
        f"Extracted files: {len(result.extracted_files)}",
        f"Missing kinds: {len(result.missing_kinds)}",
        f"Warnings: {len(result.warnings)}",
    ]
    if result.missing_kinds:
        lines.extend(("", "| Missing Kind |", "| --- |"))
        for kind in result.missing_kinds:
            lines.append(f"| {kind} |")
    if result.extracted_files:
        lines.extend(("", "| Extracted File |", "| --- |"))
        for path in result.extracted_files:
            lines.append(f"| {_escape_markdown_table_cell(path)} |")
    if result.warnings:
        lines.extend(("", "| Warning |", "| --- |"))
        for warning in result.warnings:
            lines.append(f"| {_escape_markdown_table_cell(warning)} |")
    return "\n".join(lines)


def standard_build_manifest_validation_to_markdown(
    result: StandardBuildManifestValidation,
) -> str:
    lines = [
        "# Standard Master Build Manifest Validation",
        "",
        f"Manifest: {_escape_markdown_table_cell(result.manifest_path)}",
        f"Ready: {'yes' if result.ready else 'no'}",
        f"Errors: {result.error_count}",
        f"Required kinds: {len(STANDARD_BUILD_KINDS)}",
        f"Present kinds: {len(result.present_kinds)}",
        f"Missing required kinds: {len(result.missing_kinds)}",
    ]
    if result.missing_kinds:
        lines.extend(("", "| Missing Kind |", "| --- |"))
        for kind in result.missing_kinds:
            lines.append(f"| {kind} |")
    lines.extend(
        (
            "",
            "| Status | Entry | Kind | Target | Exists | Detail |",
            "| --- | ---: | --- | --- | --- | --- |",
        )
    )
    for item in result.items:
        exists = "" if item.exists is None else ("yes" if item.exists else "no")
        lines.append(
            "| "
            + " | ".join(
                (
                    item.status,
                    str(item.entry_index),
                    item.kind,
                    _escape_markdown_table_cell(item.target),
                    exists,
                    _escape_markdown_table_cell(item.detail),
                )
            )
            + " |"
        )
    lines.extend(("", f"Total checks: {len(result.items)}"))
    return "\n".join(lines)


def standard_build_manifest_validation_to_tsv(
    result: StandardBuildManifestValidation,
) -> str:
    lines = ["status\tentry_index\tkind\ttarget\texists\tdetail"]
    for item in result.items:
        exists = "" if item.exists is None else ("yes" if item.exists else "no")
        lines.append(
            "\t".join(
                (
                    item.status,
                    str(item.entry_index),
                    item.kind,
                    item.target,
                    exists,
                    item.detail,
                )
            )
        )
    return "\n".join(lines)


def standard_build_results_to_markdown(results: list[StandardBuildImportResult]) -> str:
    ok_count = sum(1 for result in results if result.status == "ok")
    lines = [
        "# Standard Master DB Build",
        "",
        "| Status | Count |",
        "| --- | ---: |",
        f"| ok | {ok_count} |",
        f"| error | {len(results) - ok_count} |",
        "",
        "| Status | Kind | Rows | Source ID | Path | Error |",
        "| --- | --- | ---: | ---: | --- | --- |",
    ]
    for result in results:
        lines.append(
            "| "
            + " | ".join(
                (
                    result.status,
                    result.kind,
                    "" if result.row_count is None else str(result.row_count),
                    "" if result.source_id is None else str(result.source_id),
                    _escape_markdown_table_cell(result.path),
                    _escape_markdown_table_cell(result.error or ""),
                )
            )
            + " |"
        )
    lines.extend(("", f"Total entries: {len(results)}"))
    return "\n".join(lines)


def standard_build_results_to_tsv(results: list[StandardBuildImportResult]) -> str:
    lines = ["status\tkind\tpath\tsource_id\trow_count\tchecksum_sha256\terror"]
    for result in results:
        lines.append(
            "\t".join(
                (
                    result.status,
                    result.kind,
                    result.path,
                    "" if result.source_id is None else str(result.source_id),
                    "" if result.row_count is None else str(result.row_count),
                    result.checksum_sha256 or "",
                    result.error or "",
                )
            )
        )
    return "\n".join(lines)


def _import_manifest_entry(
    conn: sqlite3.Connection,
    manifest_file: Path,
    entry: dict[str, Any],
    index: int,
) -> list[StandardBuildImportResult]:
    kind = _required_text(entry, "kind", index)
    if kind not in STANDARD_BUILD_KINDS:
        if kind not in OPTIONAL_STANDARD_BUILD_KINDS:
            raise ValueError(f"entry {index}: unsupported kind {kind!r}")

    if kind == "dpc_hospital_coefficient":
        source_path = _resolve_path(manifest_file, _required_text(entry, "path", index))
        kwargs = {
            "source_version": _required_text(entry, "source_version", index),
            "published_at": _optional_text(entry.get("published_at")),
            "url": _optional_text(entry.get("url")),
            "encoding": _optional_text(entry.get("encoding")) or "utf-8-sig",
            "retrieved_at": _optional_text(entry.get("retrieved_at")),
        }
        result = import_dpc_hospital_coefficients(conn, source_path, **kwargs)
        return [_ok_result(kind, str(source_path), result)]

    if kind not in STANDARD_BUILD_KINDS:
        raise ValueError(f"entry {index}: unsupported kind {kind!r}")

    if kind == "regional_manifest":
        regional_manifest_path = _resolve_path(
            manifest_file,
            _required_text(entry, "path", index),
        )
        regional_results = import_regional_manifest(conn, regional_manifest_path)
        return [
            StandardBuildImportResult(
                kind=f"regional_{result.regional_bureau}_{result.kind}",
                path=str(result.path),
                source_id=result.source_id,
                row_count=result.row_count,
                checksum_sha256=result.checksum_sha256,
                status="ok",
            )
            for result in regional_results
        ]

    kwargs = {
        "source_version": _required_text(entry, "source_version", index),
        "published_at": _optional_text(entry.get("published_at")),
        "url": _optional_text(entry.get("url")),
        "encoding": _optional_text(entry.get("encoding")) or "cp932",
        "retrieved_at": _optional_text(entry.get("retrieved_at")),
    }
    if kind == "medical_electronic_fee_table":
        csv_paths = _electronic_csv_paths(manifest_file, entry, index)
        result = import_electronic_fee_table(conn, csv_paths, **kwargs)
        return [_ok_result(kind, _paths_label(csv_paths), result)]

    source_path = _resolve_path(manifest_file, _required_text(entry, "path", index))
    if kind == "medical_procedure_master":
        result = import_medical_procedure_master(conn, source_path, **kwargs)
    elif kind == "drug_master":
        result = import_drug_master(conn, source_path, **kwargs)
    elif kind == "specific_material_master":
        result = import_specific_material_master(conn, source_path, **kwargs)
    elif kind == "comment_master":
        result = import_comment_master(conn, source_path, **kwargs)
    else:
        result = import_comment_links(conn, source_path, **kwargs)
    return [_ok_result(kind, str(source_path), result)]


def _validate_required_text_field(
    items: list[StandardBuildManifestValidationItem],
    entry: dict[str, Any],
    index: int,
    kind: str,
    field: str,
) -> None:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        items.append(
            StandardBuildManifestValidationItem(
                entry_index=index,
                kind=kind,
                target=field,
                exists=None,
                status="error",
                detail=f"{field} is required",
            )
        )


def _validate_entry_path(
    items: list[StandardBuildManifestValidationItem],
    manifest_file: Path,
    entry: dict[str, Any],
    index: int,
    kind: str,
    field: str,
) -> None:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        items.append(
            StandardBuildManifestValidationItem(
                entry_index=index,
                kind=kind,
                target=field,
                exists=None,
                status="error",
                detail=f"{field} is required",
            )
        )
        return
    resolved = _resolve_path(manifest_file, value.strip())
    exists = resolved.exists()
    items.append(
        StandardBuildManifestValidationItem(
            entry_index=index,
            kind=kind,
            target=str(resolved),
            exists=exists,
            status="ok" if exists else "error",
            detail="" if exists else "path not found",
        )
    )


def _validate_electronic_csv_path_entries(
    items: list[StandardBuildManifestValidationItem],
    manifest_file: Path,
    entry: dict[str, Any],
    index: int,
    kind: str,
) -> None:
    raw_paths = entry.get("csv_paths") or entry.get("paths")
    if not isinstance(raw_paths, dict) or not raw_paths:
        items.append(
            StandardBuildManifestValidationItem(
                entry_index=index,
                kind=kind,
                target="csv_paths",
                exists=None,
                status="error",
                detail="medical_electronic_fee_table requires non-empty csv_paths",
            )
        )
        return
    for name, value in sorted(raw_paths.items()):
        if not isinstance(value, str) or not value.strip():
            items.append(
                StandardBuildManifestValidationItem(
                    entry_index=index,
                    kind=kind,
                    target=f"csv_paths.{name}",
                    exists=None,
                    status="error",
                    detail="csv path must be a non-empty string",
                )
            )
            continue
        resolved = _resolve_path(manifest_file, value.strip())
        exists = resolved.exists()
        items.append(
            StandardBuildManifestValidationItem(
                entry_index=index,
                kind=kind,
                target=f"{name}={resolved}",
                exists=exists,
                status="ok" if exists else "error",
                detail="" if exists else "path not found",
            )
        )


def _ok_result(kind: str, path: str, result: ImportResult) -> StandardBuildImportResult:
    return StandardBuildImportResult(
        kind=kind,
        path=path,
        source_id=result.source_id,
        row_count=result.row_count,
        checksum_sha256=result.checksum_sha256,
        status="ok",
    )


def _load_manifest_entries(manifest_file: Path) -> list[dict[str, Any]]:
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    entries = manifest.get("entries") if isinstance(manifest, dict) else manifest
    if not isinstance(entries, list):
        raise ValueError("standard build manifest must be a list or an object with an entries list")
    parsed: list[dict[str, Any]] = []
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"entry {index}: expected object")
        parsed.append(entry)
    return parsed


def _electronic_csv_paths(
    manifest_file: Path,
    entry: dict[str, Any],
    index: int,
) -> dict[str, Path]:
    raw_paths = entry.get("csv_paths") or entry.get("paths")
    if not isinstance(raw_paths, dict):
        raise ValueError(f"entry {index}: medical_electronic_fee_table requires csv_paths")
    result: dict[str, Path] = {}
    for name, value in raw_paths.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"entry {index}: csv_paths.{name} must be a path string")
        result[str(name)] = _resolve_path(manifest_file, value)
    return result


def _paths_label(paths: dict[str, Path]) -> str:
    return ",".join(f"{name}={path}" for name, path in sorted(paths.items()))


def _extract_zip_archives(
    raw_root: Path,
    *,
    overwrite: bool,
    metadata_encoding: str,
    warnings: list[str],
) -> list[Path]:
    if not raw_root.exists():
        warnings.append(f"raw_root not found: {raw_root}")
        return []

    extracted: list[Path] = []
    for zip_path in sorted(raw_root.rglob("*.zip")):
        extract_dir = zip_path.parent / zip_path.stem
        try:
            with _open_zip(zip_path, metadata_encoding=metadata_encoding) as archive:
                for member in archive.infolist():
                    if member.is_dir():
                        continue
                    member_name = Path(member.filename).name
                    if not member_name or member_name.startswith("."):
                        continue
                    destination = extract_dir / member_name
                    if destination.exists() and not overwrite:
                        continue
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, destination.open("wb") as target:
                        target.write(source.read())
                    extracted.append(destination)
        except Exception as exc:  # noqa: BLE001 - report all archive issues.
            warnings.append(f"failed to extract {zip_path}: {exc}")
    return extracted


def _open_zip(path: Path, *, metadata_encoding: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path, metadata_encoding=metadata_encoding)
    except TypeError:  # pragma: no cover - for older Python compatibility.
        return zipfile.ZipFile(path)


def _find_best_csv(
    raw_root: Path,
    matcher: object,
    source_version: str,
) -> Path | None:
    candidates = [
        path
        for path in raw_root.rglob("*.csv")
        if callable(matcher) and matcher(path)
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda path: _candidate_score(path, source_version), reverse=True)[0]


def _find_electronic_fee_table_paths(raw_root: Path, source_version: str) -> dict[str, Path]:
    matchers = {
        "aux_master": _is_electronic_aux_master,
        "bundles": _is_electronic_bundles,
        "exclusions_day": lambda path: _is_electronic_exclusion(path, "03-1", "背反テーブル1"),
        "exclusions_month": lambda path: _is_electronic_exclusion(path, "03-2", "背反テーブル2"),
        "exclusions_simultaneous": lambda path: _is_electronic_exclusion(path, "03-3", "背反テーブル3"),
        "exclusions_week": lambda path: _is_electronic_exclusion(path, "03-4", "背反テーブル4"),
        "inpatient_basic": _is_electronic_inpatient_basic,
        "frequency_limits": _is_electronic_frequency_limits,
    }
    result: dict[str, Path] = {}
    for name, matcher in matchers.items():
        path = _find_best_csv(raw_root, matcher, source_version)
        if path is not None:
            result[name] = path
    return result


def _source_entry(
    kind: str,
    path: Path,
    *,
    source_version: str,
    published_at: str | None,
    retrieved_at: str | None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "path": _display_path(path),
        "source_version": source_version,
        "published_at": published_at,
        "retrieved_at": retrieved_at,
        "encoding": "cp932",
    }


def _compact_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in entry.items() if value is not None}


def _display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def _candidate_score(path: Path, source_version: str) -> tuple[int, str]:
    compact_version = source_version.replace("-", "")
    text = str(path)
    score = 0
    if source_version in text:
        score += 20
    if compact_version in text:
        score += 20
    if "extracted" in text.lower():
        score += 1
    return score, text


def _is_medical_procedure_master(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith("s_all") and name.endswith(".csv")


def _is_drug_master(path: Path) -> bool:
    name = path.name.lower()
    return name.endswith(".csv") and (
        name.startswith("y_all") or (name.startswith("y_r") and "_all" in name)
    )


def _is_specific_material_master(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith("t_all") and name.endswith(".csv")


def _is_comment_master(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith("c_all") and not name.startswith("ck_all") and name.endswith(".csv")


def _is_comment_related_table(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith("ck_all") and name.endswith(".csv")


def _is_electronic_aux_master(path: Path) -> bool:
    name = path.name
    return "補助" in name or name.startswith("01")


def _is_electronic_bundles(path: Path) -> bool:
    name = path.name
    return "包括" in name or name.startswith("02")


def _is_electronic_exclusion(path: Path, prefix: str, label: str) -> bool:
    name = path.name
    return name.startswith(prefix) or label in name


def _is_electronic_inpatient_basic(path: Path) -> bool:
    name = path.name
    return "入院基本料" in name or name.startswith("04")


def _is_electronic_frequency_limits(path: Path) -> bool:
    name = path.name
    return "算定回数" in name or name.startswith("05")


def _required_text(entry: dict[str, Any], key: str, index: int) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"entry {index}: {key} is required")
    return value.strip()


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("optional text values must be strings")
    text = value.strip()
    return text or None


def _resolve_path(manifest_file: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    manifest_relative_path = manifest_file.parent / path
    if manifest_relative_path.exists():
        return manifest_relative_path
    if path.exists():
        return path
    return manifest_relative_path


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
