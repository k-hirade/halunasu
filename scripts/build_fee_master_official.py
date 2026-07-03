#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from shutil import copyfileobj
from urllib.request import Request, urlopen

from medical_fee_calculation.check_masters_import import import_check_masters
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.standard_build import (
    build_standard_master_db,
    standard_build_results_to_markdown,
    validate_standard_build_manifest,
)
from medical_fee_calculation.ssk_download import download_ssk_master_catalog


DEFAULT_SOURCE_VERSION = "2026-06-15"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download official SSK/Regional Bureau sources and build the Fee SQLite master DB."
    )
    parser.add_argument("--source-version", default=DEFAULT_SOURCE_VERSION)
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("configs/official-master/2026-06-15/ssk-master-catalog.json"),
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("configs/official-master/2026-06-15/standard-master-build.json"),
    )
    parser.add_argument(
        "--regional-manifest",
        type=Path,
        default=Path("configs/regional-master/2026-05-01/regional_manifest.json"),
    )
    parser.add_argument("--ssk-raw-root", type=Path, default=Path("data/raw/ssk"))
    parser.add_argument("--output", type=Path, default=Path("python/data/master/standard-master.sqlite"))
    parser.add_argument("--gzip-output", type=Path)
    parser.add_argument("--no-gzip", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--skip-download", action="store_true")
    # レセ点検マスタ(支払基金チェックマスタ+傷病名/修飾語)を同じDBへ同梱する(任意)。
    # 既定は無効(配布サイズ増を避ける)。指定時のみ、展開済みディレクトリから取り込む。
    parser.add_argument(
        "--check-master-raw",
        type=Path,
        default=None,
        help="点検マスタ(b_*/z_*/IY_Tekio 等)を展開したディレクトリ。指定時のみ同梱する。",
    )
    parser.add_argument("--check-master-label", default="", help="点検マスタ版の表示名(例: 令和8年度版)")
    parser.add_argument("--check-master-effective", default="", help="点検マスタ適用開始年月(YYYYMM)")
    args = parser.parse_args()

    if args.output.exists() and not args.overwrite:
        print(f"{args.output} already exists. Pass --overwrite to rebuild.", file=sys.stderr)
        return 2

    if not args.skip_download:
        download_ssk_sources(args)
        download_regional_sources(args.regional_manifest, overwrite=args.overwrite, timeout=args.timeout)

    validation = validate_standard_build_manifest(args.manifest)
    if not validation.ready:
        print("Fee master manifest is not ready:", file=sys.stderr)
        print(json.dumps(validation.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 3

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()

    conn = connect(args.output)
    try:
        initialize_schema(conn)
        results = build_standard_master_db(conn, args.manifest, continue_on_error=False)
    finally:
        conn.close()

    report = standard_build_results_to_markdown(results)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report + "\n", encoding="utf-8")
    print(report)

    failed = [result for result in results if result.status != "ok"]
    if failed:
        return 4

    # 任意: レセ点検マスタ(適応/禁忌/併用/傷病名/修飾語)を同じDBへ同梱する。
    # gzip 圧縮の前に取り込む(圧縮対象へ含めるため)。
    if args.check_master_raw is not None:
        if not args.check_master_raw.is_dir():
            print(f"エラー: --check-master-raw {args.check_master_raw} がありません", file=sys.stderr)
            return 5
        print(f"点検マスタ取込: {args.check_master_raw} → {args.output}")
        counts = import_check_masters(
            args.check_master_raw,
            args.output,
            version_label=args.check_master_label,
            effective_from=args.check_master_effective,
        )
        print(f"点検マスタ取込完了: 合計 {sum(counts.values()):,}件")

    if not args.no_gzip:
        gzip_output = args.gzip_output or args.output.with_suffix(args.output.suffix + ".gz")
        gzip_sqlite(args.output, gzip_output)
        print(f"Compressed Fee master DB: {gzip_output}")

    print(f"\nBuilt Fee master DB: {args.output}")
    return 0


def download_ssk_sources(args: argparse.Namespace) -> None:
    retrieved_at = datetime.now(UTC).isoformat(timespec="seconds")
    result = download_ssk_master_catalog(
        args.catalog,
        raw_root=args.ssk_raw_root,
        source_version=args.source_version,
        retrieved_at=retrieved_at,
        regional_manifest=args.regional_manifest,
        prepare_manifest=True,
        overwrite=args.overwrite,
        timeout=args.timeout,
    )
    if result.standard_build_manifest is None:
        raise RuntimeError("SSK master download did not prepare a standard build manifest")
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(
        json.dumps(result.standard_build_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    failed = [item for item in result.items if item.status != "ok"]
    if failed or result.missing_kinds:
        details = {
            "failed": [item.to_dict() for item in failed],
            "missingKinds": list(result.missing_kinds),
            "warnings": list(result.warnings),
        }
        raise RuntimeError(f"SSK master download failed: {json.dumps(details, ensure_ascii=False)}")


def download_regional_sources(manifest_path: Path, *, overwrite: bool, timeout: float) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("entries", manifest)
    if not isinstance(entries, list):
        raise ValueError("regional manifest must be a list or an object with an entries list")

    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"regional manifest entry {index} must be an object")
        url = str(entry.get("url") or "").strip()
        path = Path(str(entry.get("path") or "").strip())
        if not url or not str(path):
            raise ValueError(f"regional manifest entry {index} requires url and path")
        if path.exists() and not overwrite:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        request = Request(url, headers={"User-Agent": "halunasu-fee-master-builder/1.0"})
        with urlopen(request, timeout=timeout) as response:
            path.write_bytes(response.read())


def gzip_sqlite(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    try:
        with source.open("rb") as src, gzip.open(temporary, "wb", compresslevel=9) as dst:
            copyfileobj(src, dst, length=1024 * 1024)
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
