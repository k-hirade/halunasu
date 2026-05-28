from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from medical_fee_calculation.hospital_importers import (
    REGIONAL_BUREAUS,
    import_regional_facility_standards,
    import_regional_hospital_registry,
)


REGIONAL_MANIFEST_KINDS = frozenset(("hospital_registry", "facility_standards"))


@dataclass(frozen=True)
class RegionalManifestEntry:
    index: int
    kind: str
    regional_bureau: str
    path: Path
    source_version: str
    published_at: str | None
    url: str | None
    retrieved_at: str | None


@dataclass(frozen=True)
class RegionalManifestImport:
    kind: str
    regional_bureau: str
    path: Path
    source_id: int
    row_count: int
    checksum_sha256: str


@dataclass(frozen=True)
class RegionalManifestValidationItem:
    entry_index: int
    regional_bureau: str
    kind: str
    target: str
    exists: bool | None
    status: str
    detail: str = ""

    def to_dict(self) -> dict[str, int | str | bool | None]:
        return {
            "entry_index": self.entry_index,
            "regional_bureau": self.regional_bureau,
            "kind": self.kind,
            "target": self.target,
            "exists": self.exists,
            "status": self.status,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class RegionalManifestValidation:
    manifest_path: str
    entry_count: int
    present_pairs: tuple[str, ...]
    missing_pairs: tuple[str, ...]
    items: tuple[RegionalManifestValidationItem, ...]

    @property
    def ready(self) -> bool:
        return not self.missing_pairs and not any(item.status != "ok" for item in self.items)

    @property
    def error_count(self) -> int:
        return sum(1 for item in self.items if item.status != "ok")

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest_path": self.manifest_path,
            "entry_count": self.entry_count,
            "required_pairs": _required_regional_pairs(),
            "present_pairs": list(self.present_pairs),
            "missing_pairs": list(self.missing_pairs),
            "ready": self.ready,
            "error_count": self.error_count,
            "items": [item.to_dict() for item in self.items],
        }


def import_regional_manifest(
    conn: sqlite3.Connection,
    manifest_path: str | Path,
) -> list[RegionalManifestImport]:
    """Import regional hospital source files listed in a local JSON manifest."""

    imported: list[RegionalManifestImport] = []
    for entry in load_regional_manifest_entries(manifest_path):
        imported.append(import_regional_manifest_entry(conn, entry))

    return imported


def validate_regional_manifest(manifest_path: str | Path) -> RegionalManifestValidation:
    path = Path(manifest_path)
    if not path.exists():
        return RegionalManifestValidation(
            manifest_path=str(path),
            entry_count=0,
            present_pairs=(),
            missing_pairs=tuple(_required_regional_pairs()),
            items=(
                RegionalManifestValidationItem(
                    entry_index=0,
                    regional_bureau="manifest",
                    kind="manifest",
                    target=str(path),
                    exists=False,
                    status="error",
                    detail="manifest file not found",
                ),
            ),
        )

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        entries = manifest.get("entries") if isinstance(manifest, dict) else manifest
        if not isinstance(entries, list):
            raise ValueError("regional manifest must be a list or an object with an entries list")
    except Exception as exc:  # noqa: BLE001 - validation should return a report.
        return RegionalManifestValidation(
            manifest_path=str(path),
            entry_count=0,
            present_pairs=(),
            missing_pairs=tuple(_required_regional_pairs()),
            items=(
                RegionalManifestValidationItem(
                    entry_index=0,
                    regional_bureau="manifest",
                    kind="manifest",
                    target=str(path),
                    exists=True,
                    status="error",
                    detail=str(exc),
                ),
            ),
        )

    items: list[RegionalManifestValidationItem] = []
    present_pairs: set[str] = set()
    for index, raw_entry in enumerate(entries, start=1):
        if not isinstance(raw_entry, dict):
            items.append(
                RegionalManifestValidationItem(
                    entry_index=index,
                    regional_bureau="",
                    kind="",
                    target="entry",
                    exists=None,
                    status="error",
                    detail="expected object",
                )
            )
            continue

        regional_bureau = _entry_text(raw_entry, "regional_bureau")
        kind = _entry_text(raw_entry, "kind")
        if not regional_bureau:
            items.append(
                _validation_error(index, regional_bureau, kind, "regional_bureau", "regional_bureau is required")
            )
        elif regional_bureau not in REGIONAL_BUREAUS:
            items.append(
                _validation_error(
                    index,
                    regional_bureau,
                    kind,
                    "regional_bureau",
                    f"unsupported regional_bureau {regional_bureau!r}",
                )
            )

        if not kind:
            items.append(_validation_error(index, regional_bureau, kind, "kind", "kind is required"))
        elif kind not in REGIONAL_MANIFEST_KINDS:
            items.append(
                _validation_error(index, regional_bureau, kind, "kind", f"unsupported kind {kind!r}")
            )

        source_version = _entry_text(raw_entry, "source_version")
        if not source_version:
            items.append(
                _validation_error(
                    index,
                    regional_bureau,
                    kind,
                    "source_version",
                    "source_version is required",
                )
            )

        path_value = _entry_text(raw_entry, "path")
        if not path_value:
            items.append(_validation_error(index, regional_bureau, kind, "path", "path is required"))
        else:
            resolved = _resolve_entry_path(path, path_value)
            exists = resolved.exists()
            items.append(
                RegionalManifestValidationItem(
                    entry_index=index,
                    regional_bureau=regional_bureau,
                    kind=kind,
                    target=str(resolved),
                    exists=exists,
                    status="ok" if exists else "error",
                    detail="" if exists else "path not found",
                )
            )

        if regional_bureau in REGIONAL_BUREAUS and kind in REGIONAL_MANIFEST_KINDS:
            present_pairs.add(_regional_pair(regional_bureau, kind))

    missing_pairs = tuple(pair for pair in _required_regional_pairs() if pair not in present_pairs)
    for pair in missing_pairs:
        regional_bureau, kind = pair.split(":", 1)
        items.append(
            RegionalManifestValidationItem(
                entry_index=0,
                regional_bureau=regional_bureau,
                kind=kind,
                target="entries",
                exists=None,
                status="error",
                detail="missing required regional_bureau/kind pair",
            )
        )

    return RegionalManifestValidation(
        manifest_path=str(path),
        entry_count=len(entries),
        present_pairs=tuple(pair for pair in _required_regional_pairs() if pair in present_pairs),
        missing_pairs=missing_pairs,
        items=tuple(items),
    )


def regional_manifest_validation_to_markdown(result: RegionalManifestValidation) -> str:
    lines = [
        "# Regional Manifest Validation",
        "",
        f"Manifest: {_escape_markdown_table_cell(result.manifest_path)}",
        f"Ready: {'yes' if result.ready else 'no'}",
        f"Entries: {result.entry_count}",
        f"Errors: {result.error_count}",
        f"Required bureau/kind pairs: {len(_required_regional_pairs())}",
        f"Present bureau/kind pairs: {len(result.present_pairs)}",
        f"Missing bureau/kind pairs: {len(result.missing_pairs)}",
    ]
    if result.missing_pairs:
        lines.extend(("", "| Missing Pair |", "| --- |"))
        for pair in result.missing_pairs:
            lines.append(f"| {pair} |")
    lines.extend(
        (
            "",
            "| Status | Entry | Bureau | Kind | Target | Exists | Detail |",
            "| --- | ---: | --- | --- | --- | --- | --- |",
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
                    item.regional_bureau,
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


def regional_manifest_validation_to_tsv(result: RegionalManifestValidation) -> str:
    lines = ["status\tentry_index\tregional_bureau\tkind\ttarget\texists\tdetail"]
    for item in result.items:
        exists = "" if item.exists is None else ("yes" if item.exists else "no")
        lines.append(
            "\t".join(
                (
                    item.status,
                    str(item.entry_index),
                    item.regional_bureau,
                    item.kind,
                    item.target,
                    exists,
                    item.detail,
                )
            )
        )
    return "\n".join(lines)


def import_regional_manifest_entry(
    conn: sqlite3.Connection,
    entry: RegionalManifestEntry,
) -> RegionalManifestImport:
    kwargs = {
        "regional_bureau": entry.regional_bureau,
        "source_version": entry.source_version,
        "published_at": entry.published_at,
        "url": entry.url,
        "retrieved_at": entry.retrieved_at,
    }
    if entry.kind == "hospital_registry":
        result = import_regional_hospital_registry(conn, entry.path, **kwargs)
    else:
        result = import_regional_facility_standards(conn, entry.path, **kwargs)
    return RegionalManifestImport(
        kind=entry.kind,
        regional_bureau=entry.regional_bureau,
        path=entry.path,
        source_id=result.source_id,
        row_count=result.row_count,
        checksum_sha256=result.checksum_sha256,
    )


def load_regional_manifest_entries(manifest_path: str | Path) -> list[RegionalManifestEntry]:
    path = Path(manifest_path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    entries = manifest.get("entries") if isinstance(manifest, dict) else manifest
    if not isinstance(entries, list):
        raise ValueError("regional manifest must be a list or an object with an entries list")

    parsed_entries: list[RegionalManifestEntry] = []
    for index, raw_entry in enumerate(entries, start=1):
        entry = _require_mapping(raw_entry, index)
        kind = _require_value(entry, "kind", index)
        if kind not in REGIONAL_MANIFEST_KINDS:
            raise ValueError(f"entry {index}: unsupported kind {kind!r}")

        regional_bureau = _require_value(entry, "regional_bureau", index)
        if regional_bureau not in REGIONAL_BUREAUS:
            raise ValueError(f"entry {index}: unsupported regional_bureau {regional_bureau!r}")

        source_path = _resolve_entry_path(path, _require_value(entry, "path", index))
        source_version = _require_value(entry, "source_version", index)
        parsed_entries.append(
            RegionalManifestEntry(
                index=index,
                kind=kind,
                regional_bureau=regional_bureau,
                path=source_path,
                source_version=source_version,
                published_at=_optional_value(entry, "published_at"),
                url=_optional_value(entry, "url"),
                retrieved_at=_optional_value(entry, "retrieved_at"),
            )
        )

    return parsed_entries


def _require_mapping(value: object, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"entry {index}: expected object")
    return value


def _require_value(entry: dict[str, Any], key: str, index: int) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"entry {index}: {key} is required")
    return value.strip()


def _optional_value(entry: dict[str, Any], key: str) -> str | None:
    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    value = value.strip()
    return value or None


def _resolve_entry_path(manifest_path: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    manifest_relative_path = manifest_path.parent / path
    if manifest_relative_path.exists():
        return manifest_relative_path
    if path.exists():
        return path
    return manifest_relative_path


def _required_regional_pairs() -> list[str]:
    return [
        _regional_pair(regional_bureau, kind)
        for regional_bureau in sorted(REGIONAL_BUREAUS)
        for kind in sorted(REGIONAL_MANIFEST_KINDS)
    ]


def _regional_pair(regional_bureau: str, kind: str) -> str:
    return f"{regional_bureau}:{kind}"


def _entry_text(entry: dict[str, Any], key: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str):
        return ""
    return value.strip()


def _validation_error(
    index: int,
    regional_bureau: str,
    kind: str,
    target: str,
    detail: str,
) -> RegionalManifestValidationItem:
    return RegionalManifestValidationItem(
        entry_index=index,
        regional_bureau=regional_bureau,
        kind=kind,
        target=target,
        exists=None,
        status="error",
        detail=detail,
    )


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
