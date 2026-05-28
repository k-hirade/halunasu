from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from medical_fee_calculation.regional_manifest import (
    import_regional_manifest_entry,
    load_regional_manifest_entries,
)


@dataclass(frozen=True)
class RegionalSmokeResult:
    entry_index: int
    kind: str
    regional_bureau: str
    path: Path
    source_version: str
    status: str
    source_id: int | None
    row_count: int | None
    checksum_sha256: str | None
    error: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "entry_index": self.entry_index,
            "kind": self.kind,
            "regional_bureau": self.regional_bureau,
            "path": str(self.path),
            "source_version": self.source_version,
            "status": self.status,
            "source_id": self.source_id,
            "row_count": self.row_count,
            "checksum_sha256": self.checksum_sha256,
            "error": self.error,
        }


def run_regional_manifest_smoke(
    conn: sqlite3.Connection,
    manifest_path: str | Path,
) -> list[RegionalSmokeResult]:
    results: list[RegionalSmokeResult] = []
    for entry in load_regional_manifest_entries(manifest_path):
        try:
            imported = import_regional_manifest_entry(conn, entry)
        except Exception as exc:  # noqa: BLE001 - smoke reports must keep scanning after one bad file.
            results.append(
                RegionalSmokeResult(
                    entry_index=entry.index,
                    kind=entry.kind,
                    regional_bureau=entry.regional_bureau,
                    path=entry.path,
                    source_version=entry.source_version,
                    status="failed",
                    source_id=None,
                    row_count=None,
                    checksum_sha256=None,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
            continue

        results.append(
            RegionalSmokeResult(
                entry_index=entry.index,
                kind=imported.kind,
                regional_bureau=imported.regional_bureau,
                path=imported.path,
                source_version=entry.source_version,
                status="empty" if imported.row_count == 0 else "ok",
                source_id=imported.source_id,
                row_count=imported.row_count,
                checksum_sha256=imported.checksum_sha256,
                error="import completed with zero rows" if imported.row_count == 0 else None,
            )
        )

    return results


def regional_smoke_results_to_markdown(results: list[RegionalSmokeResult]) -> str:
    lines = [
        "# Regional Hospital Import Smoke Report",
        "",
        "| Entry | Bureau | Kind | Status | Rows | Source ID | Path | Error |",
        "| ---: | --- | --- | --- | ---: | ---: | --- | --- |",
    ]
    for result in results:
        lines.append(
            "| "
            + " | ".join(
                (
                    str(result.entry_index),
                    _md(result.regional_bureau),
                    _md(result.kind),
                    _md(result.status),
                    "" if result.row_count is None else str(result.row_count),
                    "" if result.source_id is None else str(result.source_id),
                    _md(str(result.path)),
                    _md(result.error or ""),
                )
            )
            + " |"
        )
    lines.extend(
        (
            "",
            f"Total entries: {len(results)}",
            f"OK: {sum(1 for result in results if result.status == 'ok')}",
            f"Non-OK: {sum(1 for result in results if result.status != 'ok')}",
        )
    )
    return "\n".join(lines)


def _md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
