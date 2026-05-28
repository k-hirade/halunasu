from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

from medical_fee_calculation.regional_discovery import (
    RegionalSourceFileCandidate,
    build_manifest_template,
    discover_regional_source_files,
    select_regional_source_file_candidates,
)
from medical_fee_calculation.regional_sources import get_regional_source_page
from medical_fee_calculation.regional_sources import list_regional_source_pages


FetchBytes = Callable[[str], bytes]


@dataclass(frozen=True)
class DownloadedRegionalSourceFile:
    url: str
    path: Path
    size_bytes: int
    checksum_sha256: str

    def to_dict(self) -> dict[str, object]:
        return {
            "url": self.url,
            "path": str(self.path),
            "size_bytes": self.size_bytes,
            "checksum_sha256": self.checksum_sha256,
        }


@dataclass(frozen=True)
class RegionalDownloadResult:
    regional_bureau: str
    kind: str
    page_url: str
    page_path: Path
    source_version: str
    candidate_count: int
    selected_count: int
    downloaded_files: tuple[DownloadedRegionalSourceFile, ...]
    manifest: dict[str, list[dict[str, str]]]

    def to_dict(self) -> dict[str, object]:
        return {
            "regional_bureau": self.regional_bureau,
            "kind": self.kind,
            "page_url": self.page_url,
            "page_path": str(self.page_path),
            "source_version": self.source_version,
            "candidate_count": self.candidate_count,
            "selected_count": self.selected_count,
            "downloaded_files": [file.to_dict() for file in self.downloaded_files],
            "manifest": self.manifest,
        }


@dataclass(frozen=True)
class RegionalDownloadBatchItem:
    regional_bureau: str
    kind: str
    status: str
    result: RegionalDownloadResult | None
    error: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "regional_bureau": self.regional_bureau,
            "kind": self.kind,
            "status": self.status,
            "result": None if self.result is None else self.result.to_dict(),
            "error": self.error,
        }


@dataclass(frozen=True)
class RegionalDownloadBatchResult:
    source_version: str
    raw_root: Path
    items: tuple[RegionalDownloadBatchItem, ...]
    manifest: dict[str, list[dict[str, str]]]

    def to_dict(self) -> dict[str, object]:
        return {
            "source_version": self.source_version,
            "raw_root": str(self.raw_root),
            "items": [item.to_dict() for item in self.items],
            "manifest": self.manifest,
        }


def download_regional_source_files_from_page(
    *,
    regional_bureau: str,
    kind: str,
    source_version: str,
    raw_root: str | Path,
    page_url: str | None = None,
    page_encoding: str = "utf-8",
    published_at: str | None = None,
    retrieved_at: str | None = None,
    recommended_only: bool = True,
    overwrite: bool = False,
    timeout: float = 30.0,
    fetch_bytes: FetchBytes | None = None,
) -> RegionalDownloadResult:
    source_page = get_regional_source_page(regional_bureau, kind)
    source_page_url = page_url or source_page.url
    fetcher = fetch_bytes or (lambda url: _fetch_url(url, timeout=timeout))

    page_bytes = fetcher(source_page_url)
    page_path = _page_path(raw_root, regional_bureau, source_version, kind)
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_bytes(page_bytes)

    html = page_bytes.decode(page_encoding)
    candidates = discover_regional_source_files(
        html,
        page_url=source_page_url,
        regional_bureau=regional_bureau,
        kind=kind,
    )
    selected_candidates = (
        select_regional_source_file_candidates(candidates) if recommended_only else _importable(candidates)
    )
    manifest = build_manifest_template(
        selected_candidates,
        source_version=source_version,
        raw_root=raw_root,
        published_at=published_at,
        retrieved_at=retrieved_at,
    )

    downloaded_files: list[DownloadedRegionalSourceFile] = []
    for entry in manifest["entries"]:
        output_path = Path(entry["path"])
        if output_path.exists() and not overwrite:
            data = output_path.read_bytes()
        else:
            data = fetcher(entry["url"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(data)
        downloaded_files.append(
            DownloadedRegionalSourceFile(
                url=entry["url"],
                path=output_path,
                size_bytes=len(data),
                checksum_sha256=hashlib.sha256(data).hexdigest(),
            )
        )

    return RegionalDownloadResult(
        regional_bureau=regional_bureau,
        kind=kind,
        page_url=source_page_url,
        page_path=page_path,
        source_version=source_version,
        candidate_count=len(candidates),
        selected_count=len(selected_candidates),
        downloaded_files=tuple(downloaded_files),
        manifest=manifest,
    )


def download_regional_source_catalog(
    *,
    source_version: str,
    raw_root: str | Path,
    regional_bureaus: tuple[str, ...] | None = None,
    kinds: tuple[str, ...] | None = None,
    page_encoding: str = "utf-8",
    published_at: str | None = None,
    retrieved_at: str | None = None,
    recommended_only: bool = True,
    overwrite: bool = False,
    timeout: float = 30.0,
    fetch_bytes: FetchBytes | None = None,
) -> RegionalDownloadBatchResult:
    bureau_filter = set(regional_bureaus or ())
    kind_filter = set(kinds or ())
    items: list[RegionalDownloadBatchItem] = []
    manifest_entries: list[dict[str, str]] = []

    for page in list_regional_source_pages():
        if bureau_filter and page.regional_bureau not in bureau_filter:
            continue
        if kind_filter and page.kind not in kind_filter:
            continue
        try:
            result = download_regional_source_files_from_page(
                regional_bureau=page.regional_bureau,
                kind=page.kind,
                source_version=source_version,
                raw_root=raw_root,
                page_url=page.url,
                page_encoding=page_encoding,
                published_at=published_at,
                retrieved_at=retrieved_at,
                recommended_only=recommended_only,
                overwrite=overwrite,
                timeout=timeout,
                fetch_bytes=fetch_bytes,
            )
        except Exception as exc:  # noqa: BLE001 - batch downloads must report all page failures.
            items.append(
                RegionalDownloadBatchItem(
                    regional_bureau=page.regional_bureau,
                    kind=page.kind,
                    status="failed",
                    result=None,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
            continue

        manifest_entries.extend(result.manifest["entries"])
        items.append(
            RegionalDownloadBatchItem(
                regional_bureau=page.regional_bureau,
                kind=page.kind,
                status="ok",
                result=result,
                error=None,
            )
        )

    return RegionalDownloadBatchResult(
        source_version=source_version,
        raw_root=Path(raw_root),
        items=tuple(items),
        manifest={"entries": manifest_entries},
    )


def regional_download_batch_to_markdown(batch: RegionalDownloadBatchResult) -> str:
    lines = [
        "# Regional Source Download Report",
        "",
        "| Bureau | Kind | Status | Candidates | Selected | Files | Page | Error |",
        "| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
    ]
    for item in batch.items:
        result = item.result
        lines.append(
            "| "
            + " | ".join(
                (
                    _md(item.regional_bureau),
                    _md(item.kind),
                    _md(item.status),
                    "" if result is None else str(result.candidate_count),
                    "" if result is None else str(result.selected_count),
                    "" if result is None else str(len(result.downloaded_files)),
                    "" if result is None else _md(str(result.page_path)),
                    _md(item.error or ""),
                )
            )
            + " |"
        )
    lines.extend(
        (
            "",
            f"Total pages: {len(batch.items)}",
            f"OK: {sum(1 for item in batch.items if item.status == 'ok')}",
            f"Failed: {sum(1 for item in batch.items if item.status != 'ok')}",
            f"Manifest entries: {len(batch.manifest['entries'])}",
        )
    )
    return "\n".join(lines)


def _fetch_url(url: str, *, timeout: float) -> bytes:
    request = Request(url, headers={"User-Agent": "medical-fee-calculation/0.1"})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def _page_path(raw_root: str | Path, regional_bureau: str, source_version: str, kind: str) -> Path:
    return Path(raw_root) / regional_bureau / source_version / kind / "source_page.html"


def _importable(candidates: list[RegionalSourceFileCandidate]) -> list[RegionalSourceFileCandidate]:
    return [candidate for candidate in candidates if candidate.is_importable]


def _md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
