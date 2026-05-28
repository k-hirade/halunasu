from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


OFFICIAL_SOURCE_CATALOG_VERSION = "official_source_catalog.v1"

KNOWN_OFFICIAL_SOURCE_CATEGORIES = frozenset(
    (
        "dpc_electronic_fee_table",
        "dpc_hospital_coefficient_notice",
        "dpc_coding_text",
        "receipt_record_spec_medical",
        "receipt_record_spec_dpc",
        "receipt_return_record_spec_medical",
        "receipt_return_record_spec_dpc",
    )
)

REQUIRED_STEP10_SOURCE_CATEGORIES = frozenset(
    (
        "dpc_electronic_fee_table",
        "receipt_record_spec_medical",
        "receipt_record_spec_dpc",
    )
)

KNOWN_FILE_TYPES = frozenset(("csv", "html", "json", "pdf", "xlsx", "zip"))
KNOWN_IMPORT_STATUSES = frozenset(
    (
        "cataloged_not_imported",
        "manual_reference",
        "importer_planned",
        "imported",
    )
)

ENTRY_REQUIRED_TEXT_FIELDS = (
    "id",
    "category",
    "source_owner",
    "title",
    "url",
    "source_page_url",
    "published_at",
    "file_type",
    "import_status",
)


@dataclass(frozen=True)
class OfficialSourceCatalogValidationItem:
    level: str
    code: str
    message: str
    entry_id: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "level": self.level,
            "code": self.code,
            "message": self.message,
            "entry_id": self.entry_id,
        }


@dataclass(frozen=True)
class OfficialSourceCatalogValidation:
    catalog_path: str
    catalog_version: str | None
    source_version: str | None
    entry_count: int
    categories: tuple[str, ...]
    missing_required_categories: tuple[str, ...]
    items: tuple[OfficialSourceCatalogValidationItem, ...]

    @property
    def ready(self) -> bool:
        return not self.missing_required_categories and not any(
            item.level == "error" for item in self.items
        )

    @property
    def error_count(self) -> int:
        return sum(1 for item in self.items if item.level == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for item in self.items if item.level == "warning")

    def to_dict(self) -> dict[str, Any]:
        return {
            "catalog_path": self.catalog_path,
            "catalog_version": self.catalog_version,
            "source_version": self.source_version,
            "entry_count": self.entry_count,
            "categories": list(self.categories),
            "required_categories": sorted(REQUIRED_STEP10_SOURCE_CATEGORIES),
            "missing_required_categories": list(self.missing_required_categories),
            "ready": self.ready,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "items": [item.to_dict() for item in self.items],
        }


def validate_official_source_catalog(
    catalog_path: str | Path,
    *,
    required_categories: frozenset[str] = REQUIRED_STEP10_SOURCE_CATEGORIES,
) -> OfficialSourceCatalogValidation:
    path = Path(catalog_path)
    if not path.exists():
        return OfficialSourceCatalogValidation(
            catalog_path=str(path),
            catalog_version=None,
            source_version=None,
            entry_count=0,
            categories=(),
            missing_required_categories=tuple(sorted(required_categories)),
            items=(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="catalog_not_found",
                    message="catalog file not found",
                ),
            ),
        )

    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report parse errors as validation.
        return OfficialSourceCatalogValidation(
            catalog_path=str(path),
            catalog_version=None,
            source_version=None,
            entry_count=0,
            categories=(),
            missing_required_categories=tuple(sorted(required_categories)),
            items=(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="catalog_parse_error",
                    message=f"{type(exc).__name__}: {exc}",
                ),
            ),
        )

    items: list[OfficialSourceCatalogValidationItem] = []
    if not isinstance(catalog, dict):
        return OfficialSourceCatalogValidation(
            catalog_path=str(path),
            catalog_version=None,
            source_version=None,
            entry_count=0,
            categories=(),
            missing_required_categories=tuple(sorted(required_categories)),
            items=(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="catalog_shape_error",
                    message="catalog must be an object",
                ),
            ),
        )

    catalog_version = _optional_text(catalog.get("catalog_version"))
    source_version = _optional_text(catalog.get("source_version"))
    if catalog_version != OFFICIAL_SOURCE_CATALOG_VERSION:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="error",
                code="catalog_version_mismatch",
                message=(
                    f"catalog_version must be {OFFICIAL_SOURCE_CATALOG_VERSION}, "
                    f"got {catalog_version or '<missing>'}"
                ),
            )
        )
    if source_version is None:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="error",
                code="source_version_missing",
                message="source_version is required",
            )
        )

    raw_entries = catalog.get("entries")
    if not isinstance(raw_entries, list):
        return OfficialSourceCatalogValidation(
            catalog_path=str(path),
            catalog_version=catalog_version,
            source_version=source_version,
            entry_count=0,
            categories=(),
            missing_required_categories=tuple(sorted(required_categories)),
            items=(
                *items,
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="entries_missing",
                    message="entries must be a list",
                ),
            ),
        )

    seen_ids: set[str] = set()
    categories: set[str] = set()
    for index, raw_entry in enumerate(raw_entries, start=1):
        if not isinstance(raw_entry, dict):
            items.append(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="entry_shape_error",
                    message=f"entry {index} must be an object",
                )
            )
            continue
        entry_id = _optional_text(raw_entry.get("id")) or f"entry_{index}"
        _validate_entry(raw_entry, entry_id, items)
        if entry_id in seen_ids:
            items.append(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="duplicate_entry_id",
                    message=f"duplicate id: {entry_id}",
                    entry_id=entry_id,
                )
            )
        seen_ids.add(entry_id)
        category = _optional_text(raw_entry.get("category"))
        if category is not None:
            categories.add(category)

    missing_required_categories = tuple(sorted(required_categories - categories))
    for category in missing_required_categories:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="error",
                code="required_category_missing",
                message=f"required category is missing: {category}",
            )
        )

    return OfficialSourceCatalogValidation(
        catalog_path=str(path),
        catalog_version=catalog_version,
        source_version=source_version,
        entry_count=len(raw_entries),
        categories=tuple(sorted(categories)),
        missing_required_categories=missing_required_categories,
        items=tuple(items),
    )


def official_source_catalog_validation_to_markdown(
    result: OfficialSourceCatalogValidation,
) -> str:
    lines = [
        "# Official Source Catalog Validation",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Catalog | {_escape_markdown_table_cell(result.catalog_path)} |",
        f"| Catalog version | {result.catalog_version or ''} |",
        f"| Source version | {result.source_version or ''} |",
        f"| Ready | {'yes' if result.ready else 'no'} |",
        f"| Entries | {result.entry_count} |",
        f"| Errors | {result.error_count} |",
        f"| Warnings | {result.warning_count} |",
        "",
        "| Category | Present |",
        "| --- | --- |",
    ]
    categories = set(result.categories)
    for category in sorted(REQUIRED_STEP10_SOURCE_CATEGORIES):
        lines.append(f"| {category} | {'yes' if category in categories else 'no'} |")
    if result.items:
        lines.extend(("", "| Level | Code | Entry | Message |", "| --- | --- | --- | --- |"))
        for item in result.items:
            lines.append(
                "| "
                + " | ".join(
                    (
                        item.level,
                        item.code,
                        _escape_markdown_table_cell(item.entry_id or ""),
                        _escape_markdown_table_cell(item.message),
                    )
                )
                + " |"
            )
    return "\n".join(lines)


def official_source_catalog_validation_to_tsv(
    result: OfficialSourceCatalogValidation,
) -> str:
    lines = ["level\tcode\tentry_id\tmessage"]
    for item in result.items:
        lines.append(
            "\t".join(
                (
                    item.level,
                    item.code,
                    item.entry_id or "",
                    item.message.replace("\t", " ").replace("\n", " "),
                )
            )
        )
    return "\n".join(lines)


def _validate_entry(
    entry: dict[str, Any],
    entry_id: str,
    items: list[OfficialSourceCatalogValidationItem],
) -> None:
    for field in ENTRY_REQUIRED_TEXT_FIELDS:
        if _optional_text(entry.get(field)) is None:
            items.append(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="required_field_missing",
                    message=f"{field} is required",
                    entry_id=entry_id,
                )
            )

    category = _optional_text(entry.get("category"))
    if category is not None and category not in KNOWN_OFFICIAL_SOURCE_CATEGORIES:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="warning",
                code="unknown_category",
                message=f"category is not in the known set: {category}",
                entry_id=entry_id,
            )
        )

    file_type = _optional_text(entry.get("file_type"))
    if file_type is not None and file_type not in KNOWN_FILE_TYPES:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="error",
                code="unsupported_file_type",
                message=f"unsupported file_type: {file_type}",
                entry_id=entry_id,
            )
        )

    import_status = _optional_text(entry.get("import_status"))
    if import_status is not None and import_status not in KNOWN_IMPORT_STATUSES:
        items.append(
            OfficialSourceCatalogValidationItem(
                level="error",
                code="unsupported_import_status",
                message=f"unsupported import_status: {import_status}",
                entry_id=entry_id,
            )
        )

    for field in ("url", "source_page_url"):
        value = _optional_text(entry.get(field))
        if value is not None and not _is_http_url(value):
            items.append(
                OfficialSourceCatalogValidationItem(
                    level="error",
                    code="invalid_url",
                    message=f"{field} must be an http(s) URL",
                    entry_id=entry_id,
                )
            )


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def _is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _escape_markdown_table_cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")
