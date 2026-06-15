from __future__ import annotations

import hashlib
import html as html_lib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

from medical_fee_calculation.standard_build import (
    StandardBuildManifestPreparation,
    prepare_standard_build_manifest,
)


FetchBytes = Callable[[str], bytes]

SSK_DOWNLOAD_KINDS = frozenset(
    (
        "medical_procedure_master",
        "drug_master",
        "specific_material_master",
        "comment_master",
        "comment_related_table",
        "medical_electronic_fee_table",
    )
)

SSK_MASTER_SOURCE_PAGES = (
    {
        "kind": "medical_procedure_master",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html",
        "section_heading": "医科診療行為の全件マスター",
        "link_text_contains": ("全件ファイル", "全件分ファイル"),
    },
    {
        "kind": "drug_master",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html",
        "section_heading": "医薬品の全件マスター",
        "link_text_contains": ("全件ファイル", "全件分ファイル"),
    },
    {
        "kind": "specific_material_master",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.html",
        "section_heading": "特定器材の全件マスター",
        "link_text_contains": ("全件ファイル", "全件分ファイル"),
    },
    {
        "kind": "comment_master",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html",
        "section_heading": "コメントマスターの全件マスター",
        "link_text_contains": ("全件ファイル", "全件分ファイル"),
    },
    {
        "kind": "comment_related_table",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.html",
        "section_heading": "コメント関連テーブル",
        "link_text_contains": ("全件ファイル", "全件分ファイル"),
    },
    {
        "kind": "medical_electronic_fee_table",
        "page_url": "https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html",
        "section_heading": "医科電子点数表",
        "link_text_contains": "医科電子点数表テーブル（令和8年度版）",
    },
)


@dataclass(frozen=True)
class DownloadedSskMasterFile:
    kind: str
    url: str
    path: Path
    size_bytes: int
    checksum_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "url": self.url,
            "path": str(self.path),
            "size_bytes": self.size_bytes,
            "checksum_sha256": self.checksum_sha256,
        }


@dataclass(frozen=True)
class SskMasterDownloadItem:
    kind: str
    url: str
    status: str
    file: DownloadedSskMasterFile | None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "url": self.url,
            "status": self.status,
            "file": None if self.file is None else self.file.to_dict(),
            "error": self.error,
        }


@dataclass(frozen=True)
class SskMasterCatalogDownloadResult:
    source_version: str
    raw_root: Path
    items: tuple[SskMasterDownloadItem, ...]
    standard_build_manifest: dict[str, Any] | None
    extracted_files: tuple[str, ...]
    missing_kinds: tuple[str, ...]
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_version": self.source_version,
            "raw_root": str(self.raw_root),
            "items": [item.to_dict() for item in self.items],
            "standard_build_manifest": self.standard_build_manifest,
            "extracted_files": list(self.extracted_files),
            "missing_kinds": list(self.missing_kinds),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class SskMasterCatalogDiscoveryResult:
    catalog: dict[str, Any]
    page_count: int
    warnings: tuple[str, ...]
    source_pages: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "catalog": self.catalog,
            "page_count": self.page_count,
            "source_pages": list(self.source_pages),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class SskMasterCatalogDiffResult:
    added: tuple[dict[str, Any], ...]
    removed: tuple[dict[str, Any], ...]
    changed: tuple[dict[str, Any], ...]
    unchanged: tuple[dict[str, Any], ...]

    @property
    def has_changes(self) -> bool:
        return bool(self.added or self.removed or self.changed)

    def to_dict(self) -> dict[str, Any]:
        return {
            "added": list(self.added),
            "removed": list(self.removed),
            "changed": list(self.changed),
            "unchanged": list(self.unchanged),
            "summary": {
                "added": len(self.added),
                "removed": len(self.removed),
                "changed": len(self.changed),
                "unchanged": len(self.unchanged),
                "has_changes": self.has_changes,
            },
        }


def discover_ssk_master_catalog(
    *,
    source_version: str | None = None,
    page_encoding: str = "utf-8",
    timeout: float = 30.0,
    fetch_bytes: FetchBytes | None = None,
) -> SskMasterCatalogDiscoveryResult:
    fetcher = fetch_bytes or (lambda url: _fetch_url(url, timeout=timeout))
    entries: list[dict[str, Any]] = []
    warnings: list[str] = []
    page_cache: dict[str, str] = {}

    for source_page in SSK_MASTER_SOURCE_PAGES:
        page_url = str(source_page["page_url"])
        if page_url not in page_cache:
            page_cache[page_url] = fetcher(page_url).decode(page_encoding)
        html = page_cache[page_url]
        try:
            discovered = _discover_source_page_entry(
                html,
                kind=str(source_page["kind"]),
                page_url=page_url,
                section_heading=str(source_page["section_heading"]),
                link_text_contains=source_page["link_text_contains"],
                source_version_override=source_version,
            )
            entries.append(discovered)
        except Exception as exc:  # noqa: BLE001 - report all missing links.
            warnings.append(f"{source_page['kind']}: {type(exc).__name__}: {exc}")

    return SskMasterCatalogDiscoveryResult(
        catalog={"entries": entries},
        page_count=len(page_cache),
        warnings=tuple(warnings),
        source_pages=tuple(page_cache),
    )


def diff_ssk_master_catalogs(
    old_catalog_path: str | Path,
    new_catalog_path: str | Path,
) -> SskMasterCatalogDiffResult:
    old_entries = _catalog_entries_by_kind(_load_catalog_entries(Path(old_catalog_path)))
    new_entries = _catalog_entries_by_kind(_load_catalog_entries(Path(new_catalog_path)))

    added: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []

    for kind in sorted(set(old_entries) | set(new_entries)):
        old_entry = old_entries.get(kind)
        new_entry = new_entries.get(kind)
        if old_entry is None and new_entry is not None:
            added.append(dict(new_entry))
            continue
        if old_entry is not None and new_entry is None:
            removed.append(dict(old_entry))
            continue
        if old_entry is None or new_entry is None:
            continue

        changed_fields = _changed_catalog_fields(old_entry, new_entry)
        if changed_fields:
            changed.append(
                {
                    "kind": kind,
                    "changed_fields": changed_fields,
                    "old": dict(old_entry),
                    "new": dict(new_entry),
                }
            )
        else:
            unchanged.append(dict(new_entry))

    return SskMasterCatalogDiffResult(
        added=tuple(added),
        removed=tuple(removed),
        changed=tuple(changed),
        unchanged=tuple(unchanged),
    )


def download_ssk_master_catalog(
    catalog_path: str | Path,
    *,
    raw_root: str | Path,
    source_version: str | None = None,
    published_at: str | None = None,
    retrieved_at: str | None = None,
    regional_manifest: str | Path | None = None,
    prepare_manifest: bool = True,
    overwrite: bool = False,
    timeout: float = 30.0,
    fetch_bytes: FetchBytes | None = None,
) -> SskMasterCatalogDownloadResult:
    catalog_file = Path(catalog_path)
    catalog_entries = _load_catalog_entries(catalog_file)
    resolved_source_version = source_version or _catalog_source_version(catalog_entries)
    fetcher = fetch_bytes or (lambda url: _fetch_url(url, timeout=timeout))
    root = Path(raw_root)

    items: list[SskMasterDownloadItem] = []
    for index, entry in enumerate(catalog_entries, start=1):
        kind = _required_text(entry, "kind", index)
        url = _required_text(entry, "url", index)
        try:
            if kind not in SSK_DOWNLOAD_KINDS:
                raise ValueError(f"unsupported kind {kind!r}")
            entry_source_version = _optional_text(entry.get("source_version")) or resolved_source_version
            filename = _optional_text(entry.get("filename")) or _filename_from_url(url)
            output_path = _output_path(root, kind, entry_source_version, filename)
            if output_path.exists() and not overwrite:
                data = output_path.read_bytes()
            else:
                data = fetcher(url)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(data)
            downloaded_file = DownloadedSskMasterFile(
                kind=kind,
                url=url,
                path=output_path,
                size_bytes=len(data),
                checksum_sha256=hashlib.sha256(data).hexdigest(),
            )
            items.append(SskMasterDownloadItem(kind=kind, url=url, status="ok", file=downloaded_file))
        except Exception as exc:  # noqa: BLE001 - report every catalog entry.
            items.append(
                SskMasterDownloadItem(
                    kind=kind,
                    url=url,
                    status="failed",
                    file=None,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )

    preparation: StandardBuildManifestPreparation | None = None
    if prepare_manifest:
        preparation = prepare_standard_build_manifest(
            root,
            source_version=resolved_source_version,
            published_at=published_at,
            retrieved_at=retrieved_at,
            regional_manifest=regional_manifest,
            extract_archives=True,
        )
        enriched_manifest = _enrich_standard_build_manifest(
            preparation.manifest,
            catalog_entries=catalog_entries,
            items=items,
            retrieved_at=retrieved_at,
        )
        preparation = StandardBuildManifestPreparation(
            manifest=enriched_manifest,
            extracted_files=preparation.extracted_files,
            missing_kinds=preparation.missing_kinds,
            warnings=preparation.warnings,
        )

    return SskMasterCatalogDownloadResult(
        source_version=resolved_source_version,
        raw_root=root,
        items=tuple(items),
        standard_build_manifest=None if preparation is None else preparation.manifest,
        extracted_files=() if preparation is None else preparation.extracted_files,
        missing_kinds=() if preparation is None else preparation.missing_kinds,
        warnings=() if preparation is None else preparation.warnings,
    )


def ssk_master_catalog_discovery_to_markdown(result: SskMasterCatalogDiscoveryResult) -> str:
    lines = [
        "# SSK Master Catalog Discovery",
        "",
        "| Kind | Source Version | URL | Source Page |",
        "| --- | --- | --- | --- |",
    ]
    for entry in result.catalog["entries"]:
        lines.append(
            "| "
            + " | ".join(
                (
                    entry["kind"],
                    entry.get("source_version", ""),
                    _escape_markdown_table_cell(entry["url"]),
                    _escape_markdown_table_cell(entry.get("source_page_url", "")),
                )
            )
            + " |"
        )
    lines.extend(("", f"Pages fetched: {result.page_count}", f"Warnings: {len(result.warnings)}"))
    if result.warnings:
        lines.extend(("", "| Warning |", "| --- |"))
        for warning in result.warnings:
            lines.append(f"| {_escape_markdown_table_cell(warning)} |")
    if result.source_pages:
        lines.extend(("", "| Source Page |", "| --- |"))
        for source_page in result.source_pages:
            lines.append(f"| {_escape_markdown_table_cell(source_page)} |")
    return "\n".join(lines)


def ssk_master_catalog_diff_to_markdown(result: SskMasterCatalogDiffResult) -> str:
    lines = [
        "# SSK Master Catalog Diff",
        "",
        "| Status | Count |",
        "| --- | ---: |",
        f"| added | {len(result.added)} |",
        f"| removed | {len(result.removed)} |",
        f"| changed | {len(result.changed)} |",
        f"| unchanged | {len(result.unchanged)} |",
    ]
    if result.changed:
        lines.extend(
            (
                "",
                "| Kind | Changed Fields | Old Source Version | New Source Version | Old URL | New URL |",
                "| --- | --- | --- | --- | --- | --- |",
            )
        )
        for change in result.changed:
            old_entry = change["old"]
            new_entry = change["new"]
            lines.append(
                "| "
                + " | ".join(
                    (
                        str(change["kind"]),
                        ", ".join(change["changed_fields"]),
                        str(old_entry.get("source_version", "")),
                        str(new_entry.get("source_version", "")),
                        _escape_markdown_table_cell(str(old_entry.get("url", ""))),
                        _escape_markdown_table_cell(str(new_entry.get("url", ""))),
                    )
                )
                + " |"
            )
    if result.added:
        lines.extend(("", "| Added Kind | Source Version | URL |", "| --- | --- | --- |"))
        for entry in result.added:
            lines.append(
                "| "
                + " | ".join(
                    (
                        str(entry.get("kind", "")),
                        str(entry.get("source_version", "")),
                        _escape_markdown_table_cell(str(entry.get("url", ""))),
                    )
                )
                + " |"
            )
    if result.removed:
        lines.extend(("", "| Removed Kind | Source Version | URL |", "| --- | --- | --- |"))
        for entry in result.removed:
            lines.append(
                "| "
                + " | ".join(
                    (
                        str(entry.get("kind", "")),
                        str(entry.get("source_version", "")),
                        _escape_markdown_table_cell(str(entry.get("url", ""))),
                    )
                )
                + " |"
            )
    return "\n".join(lines)


def ssk_master_catalog_download_to_markdown(result: SskMasterCatalogDownloadResult) -> str:
    lines = [
        "# SSK Master Catalog Download",
        "",
        "| Status | Kind | Size | Path | URL | Error |",
        "| --- | --- | ---: | --- | --- | --- |",
    ]
    for item in result.items:
        downloaded = item.file
        lines.append(
            "| "
            + " | ".join(
                (
                    item.status,
                    item.kind,
                    "" if downloaded is None else str(downloaded.size_bytes),
                    "" if downloaded is None else _escape_markdown_table_cell(str(downloaded.path)),
                    _escape_markdown_table_cell(item.url),
                    _escape_markdown_table_cell(item.error or ""),
                )
            )
            + " |"
        )
    lines.extend(
        (
            "",
            f"Downloaded: {sum(1 for item in result.items if item.status == 'ok')}",
            f"Failed: {sum(1 for item in result.items if item.status != 'ok')}",
            f"Extracted files: {len(result.extracted_files)}",
            f"Manifest entries: {len((result.standard_build_manifest or {}).get('entries', []))}",
            f"Missing kinds: {len(result.missing_kinds)}",
        )
    )
    if result.missing_kinds:
        lines.extend(("", "| Missing Kind |", "| --- |"))
        for kind in result.missing_kinds:
            lines.append(f"| {kind} |")
    if result.warnings:
        lines.extend(("", "| Warning |", "| --- |"))
        for warning in result.warnings:
            lines.append(f"| {_escape_markdown_table_cell(warning)} |")
    return "\n".join(lines)


def _discover_source_page_entry(
    html: str,
    *,
    kind: str,
    page_url: str,
    section_heading: str,
    link_text_contains: str | tuple[str, ...],
    source_version_override: str | None,
) -> dict[str, Any]:
    anchors = _html_anchors(html)
    matching_anchor: tuple[str, str, str] | None = None
    link_text_patterns = (
        (link_text_contains,)
        if isinstance(link_text_contains, str)
        else tuple(link_text_contains)
    )
    for href, text, context in anchors:
        if not any(pattern in text for pattern in link_text_patterns):
            continue
        if section_heading not in _plain_text(context):
            continue
        matching_anchor = (href, text, context)
        break
    if matching_anchor is None:
        raise ValueError(f"link not found: {' or '.join(link_text_patterns)}")

    href, text, context = matching_anchor
    published_at = _latest_date_text(f"{context} {text}")
    source_version = source_version_override or published_at
    entry: dict[str, Any] = {
        "kind": kind,
        "url": urljoin(page_url, href),
        "source_page_url": page_url,
    }
    entry["filename"] = _filename_from_url(entry["url"])
    if source_version is not None:
        entry["source_version"] = source_version
    if published_at is not None:
        entry["published_at"] = published_at
    return entry


def _html_anchors(html: str) -> list[tuple[str, str, str]]:
    anchors: list[tuple[str, str, str]] = []
    pattern = re.compile(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
    for match in pattern.finditer(html):
        href = match.group(1)
        text = _plain_text(match.group(2))
        context = html[max(0, match.start() - 2500) : match.end()]
        anchors.append((href, text, context))
    return anchors


def _plain_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = html_lib.unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _latest_date_text(text: str) -> str | None:
    dates: list[str] = []
    for match in re.finditer(r"(20\d{2})年(\d{1,2})月(\d{1,2})日", text):
        dates.append(f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}")
    for match in re.finditer(r"令和(\d{1,2})年(\d{1,2})月(\d{1,2})日", text):
        year = 2018 + int(match.group(1))
        dates.append(f"{year:04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}")
    return dates[-1] if dates else None


def _load_catalog_entries(catalog_file: Path) -> list[dict[str, Any]]:
    catalog = json.loads(catalog_file.read_text(encoding="utf-8"))
    entries = catalog.get("entries") if isinstance(catalog, dict) else catalog
    if not isinstance(entries, list):
        raise ValueError("SSK catalog must be a list or an object with an entries list")
    parsed: list[dict[str, Any]] = []
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"entry {index}: expected object")
        parsed.append(entry)
    return parsed


def _catalog_entries_by_kind(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_kind: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(entries, start=1):
        kind = _required_text(entry, "kind", index)
        if kind in by_kind:
            raise ValueError(f"duplicate catalog kind: {kind}")
        by_kind[kind] = entry
    return by_kind


def _enrich_standard_build_manifest(
    manifest: dict[str, Any],
    *,
    catalog_entries: list[dict[str, Any]],
    items: list[SskMasterDownloadItem],
    retrieved_at: str | None,
) -> dict[str, Any]:
    catalog_by_kind = _catalog_entries_by_kind(catalog_entries)
    downloaded_by_kind = {
        item.kind: item.file
        for item in items
        if item.file is not None
    }
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        return dict(manifest)

    enriched_entries: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            enriched_entries.append(entry)
            continue

        enriched = dict(entry)
        kind = str(enriched.get("kind") or "")
        catalog_entry = catalog_by_kind.get(kind)
        downloaded = downloaded_by_kind.get(kind)
        if catalog_entry is not None:
            enriched.setdefault("published_at", catalog_entry.get("published_at"))
            enriched.setdefault("url", catalog_entry.get("url"))
            enriched.setdefault("source_page_url", catalog_entry.get("source_page_url"))
        if retrieved_at:
            enriched.setdefault("retrieved_at", retrieved_at)
        if downloaded is not None:
            enriched.setdefault("archive_path", str(downloaded.path))
            enriched.setdefault("archive_checksum_sha256", downloaded.checksum_sha256)
        enriched_entries.append(_compact_entry(enriched))

    return {
        **manifest,
        "entries": enriched_entries,
    }


def _changed_catalog_fields(old_entry: dict[str, Any], new_entry: dict[str, Any]) -> list[str]:
    changed_fields: list[str] = []
    for field in ("url", "filename", "source_version", "published_at", "source_page_url"):
        if _catalog_compare_value(old_entry, field) != _catalog_compare_value(new_entry, field):
            changed_fields.append(field)
    return changed_fields


def _catalog_compare_value(entry: dict[str, Any], field: str) -> str:
    value = entry.get(field)
    if field == "filename" and (not isinstance(value, str) or not value.strip()):
        url = entry.get("url")
        if isinstance(url, str) and url.strip():
            return _filename_from_url(url.strip())
    return value.strip() if isinstance(value, str) else ""


def _compact_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in entry.items() if value is not None}


def _catalog_source_version(entries: list[dict[str, Any]]) -> str:
    versions = {
        value.strip()
        for entry in entries
        for value in (entry.get("source_version"),)
        if isinstance(value, str) and value.strip()
    }
    if len(versions) == 1:
        return next(iter(versions))
    raise ValueError("--source-version is required when catalog entries do not share one source_version")


def _output_path(raw_root: Path, kind: str, source_version: str, filename: str) -> Path:
    return raw_root / kind / source_version / filename


def _filename_from_url(url: str) -> str:
    parsed = urlparse(url)
    filename = Path(unquote(parsed.path)).name
    if not filename:
        raise ValueError(f"URL has no filename: {url}")
    return filename


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


def _fetch_url(url: str, *, timeout: float) -> bytes:
    request = Request(url, headers={"User-Agent": "medical-fee-calculation/0.1"})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
